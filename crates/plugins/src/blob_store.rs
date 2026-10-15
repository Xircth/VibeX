//! Plugin blobs live on disk. A video does not fit in one JSON message, so the
//! Worker writes it here in small chunks and hands back an id.

use std::{
    fs::{self, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
};

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Serialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::WorkerHostError;

pub const BLOB_CHUNK_BYTES: usize = 512 * 1024;
pub const BLOB_MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct BlobStore {
    root: PathBuf,
}

#[derive(Serialize)]
struct BlobMeta {
    #[serde(rename = "mediaType")]
    media_type: String,
    name: Option<String>,
    finished: bool,
}

impl BlobStore {
    pub fn open(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn for_plugin(plugin_id: &str) -> Result<Self, WorkerHostError> {
        let name = plugin_dir_name(plugin_id)?;
        Ok(Self::open(
            utils::assets::host_data_dir()
                .join("plugin-blobs")
                .join(name),
        ))
    }

    pub fn dispatch(&self, operation: &str, input: &Value) -> Result<Value, WorkerHostError> {
        match operation {
            "create" => self.create(input),
            "append" => self.append(input),
            "finish" => self.finish(input),
            "stat" => self.stat_value(input),
            "read" => self.read(input),
            "delete" => self.delete(input),
            other => Err(WorkerHostError::broker(
                "capability_unimplemented",
                format!("blob.{other} is not implemented"),
            )),
        }
    }

    fn create(&self, input: &Value) -> Result<Value, WorkerHostError> {
        let media_type = optional_string(input, "mediaType")?
            .unwrap_or_else(|| "application/octet-stream".to_owned());
        let name = optional_string(input, "name")?;
        if let Some(name) = &name
            && (name.is_empty()
                || name.len() > 255
                || name.contains('/')
                || name.contains('\\')
                || name.contains('\0'))
        {
            return Err(WorkerHostError::broker(
                "blob_invalid",
                "blob name must be a single path segment",
            ));
        }
        fs::create_dir_all(&self.root).map_err(io_error)?;
        let id = Uuid::new_v4().as_simple().to_string();
        fs::write(self.bin(&id), []).map_err(io_error)?;
        self.write_meta(
            &id,
            &BlobMeta {
                media_type,
                name,
                finished: false,
            },
        )?;
        Ok(json!({ "id": id }))
    }

    fn append(&self, input: &Value) -> Result<Value, WorkerHostError> {
        let id = self.require_id(input)?;
        if self.meta(&id)?.finished {
            return Err(WorkerHostError::broker(
                "blob_closed",
                "blob is already finished",
            ));
        }
        let data = input.get("data").and_then(Value::as_str).ok_or_else(|| {
            WorkerHostError::broker("blob_invalid", "append requires base64 data")
        })?;
        let bytes = STANDARD
            .decode(data)
            .map_err(|_| WorkerHostError::broker("blob_invalid", "append data is not base64"))?;
        if bytes.len() > BLOB_CHUNK_BYTES {
            return Err(WorkerHostError::broker(
                "blob_chunk_too_large",
                format!("one append is at most {BLOB_CHUNK_BYTES} bytes"),
            ));
        }
        let path = self.bin(&id);
        let current = fs::metadata(&path).map_err(io_error)?.len();
        let next = current.saturating_add(bytes.len() as u64);
        if next > BLOB_MAX_BYTES {
            return Err(WorkerHostError::broker(
                "blob_too_large",
                format!("a blob is at most {BLOB_MAX_BYTES} bytes"),
            ));
        }
        let mut file = OpenOptions::new()
            .append(true)
            .open(&path)
            .map_err(io_error)?;
        file.write_all(&bytes).map_err(io_error)?;
        Ok(json!({ "id": id, "byteLength": next }))
    }

    fn finish(&self, input: &Value) -> Result<Value, WorkerHostError> {
        let id = self.require_id(input)?;
        let mut meta = self.meta(&id)?;
        meta.finished = true;
        self.write_meta(&id, &meta)?;
        self.describe(&id, &meta)
    }

    fn stat_value(&self, input: &Value) -> Result<Value, WorkerHostError> {
        let id = self.require_id(input)?;
        let meta = self.meta(&id)?;
        self.describe(&id, &meta)
    }

    fn read(&self, input: &Value) -> Result<Value, WorkerHostError> {
        let id = self.require_id(input)?;
        let meta = self.meta(&id)?;
        let byte_length = self.byte_length(&id)?;
        let offset = input.get("offset").and_then(Value::as_u64).unwrap_or(0);
        if offset > byte_length {
            return Err(WorkerHostError::broker(
                "blob_invalid",
                "offset is past the end of the blob",
            ));
        }
        let requested = input
            .get("length")
            .and_then(Value::as_u64)
            .unwrap_or(BLOB_CHUNK_BYTES as u64);
        if requested == 0 {
            return Err(WorkerHostError::broker(
                "blob_invalid",
                "read length must be positive",
            ));
        }
        let length = requested
            .min(BLOB_CHUNK_BYTES as u64)
            .min(byte_length - offset) as usize;
        let mut file = fs::File::open(self.bin(&id)).map_err(io_error)?;
        file.seek(SeekFrom::Start(offset)).map_err(io_error)?;
        let mut bytes = vec![0; length];
        file.read_exact(&mut bytes).map_err(io_error)?;
        let described = self.describe(&id, &meta)?;
        Ok(json!({
            "id": id,
            "offset": offset,
            "data": STANDARD.encode(bytes),
            "byteLength": described["byteLength"],
            "mediaType": described["mediaType"],
            "finished": described["finished"],
        }))
    }

    fn delete(&self, input: &Value) -> Result<Value, WorkerHostError> {
        let id = self.require_id(input)?;
        let bin = self.bin(&id);
        let meta = self.meta_path(&id);
        if !bin.is_file() && !meta.is_file() {
            return Err(WorkerHostError::broker(
                "blob_not_found",
                "blob was not found",
            ));
        }
        if bin.is_file() {
            fs::remove_file(bin).map_err(io_error)?;
        }
        if meta.is_file() {
            fs::remove_file(meta).map_err(io_error)?;
        }
        Ok(json!({}))
    }

    fn describe(&self, id: &str, meta: &BlobMeta) -> Result<Value, WorkerHostError> {
        Ok(json!({
            "id": id,
            "byteLength": self.byte_length(id)?,
            "mediaType": meta.media_type,
            "name": meta.name,
            "finished": meta.finished,
        }))
    }

    fn require_id(&self, input: &Value) -> Result<String, WorkerHostError> {
        let id = input
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| WorkerHostError::broker("blob_invalid", "blob id is required"))?;
        if !is_blob_id(id) || !self.meta_path(id).is_file() {
            return Err(WorkerHostError::broker(
                "blob_not_found",
                "blob was not found",
            ));
        }
        Ok(id.to_owned())
    }

    fn meta(&self, id: &str) -> Result<BlobMeta, WorkerHostError> {
        let raw = fs::read(self.meta_path(id)).map_err(io_error)?;
        let value: Value = serde_json::from_slice(&raw)
            .map_err(|_| WorkerHostError::broker("blob_invalid", "blob metadata is unreadable"))?;
        Ok(BlobMeta {
            media_type: value
                .get("mediaType")
                .and_then(Value::as_str)
                .unwrap_or("application/octet-stream")
                .to_owned(),
            name: value.get("name").and_then(Value::as_str).map(str::to_owned),
            finished: value
                .get("finished")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
    }

    fn write_meta(&self, id: &str, meta: &BlobMeta) -> Result<(), WorkerHostError> {
        let raw = serde_json::to_vec(meta).map_err(|_| {
            WorkerHostError::broker("blob_invalid", "blob metadata could not be saved")
        })?;
        fs::write(self.meta_path(id), raw).map_err(io_error)?;
        Ok(())
    }

    fn byte_length(&self, id: &str) -> Result<u64, WorkerHostError> {
        Ok(fs::metadata(self.bin(id)).map_err(io_error)?.len())
    }

    fn bin(&self, id: &str) -> PathBuf {
        self.root.join(format!("{id}.bin"))
    }

    fn meta_path(&self, id: &str) -> PathBuf {
        self.root.join(format!("{id}.json"))
    }
}

fn plugin_dir_name(plugin_id: &str) -> Result<String, WorkerHostError> {
    let name: String = plugin_id
        .chars()
        .map(|ch| match ch {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '.' | '-' | '_' => ch,
            _ => '_',
        })
        .collect();
    if name.is_empty() || name == "." || name == ".." || name.contains("..") {
        return Err(WorkerHostError::broker(
            "blob_invalid",
            "plugin id cannot name a blob directory",
        ));
    }
    Ok(name)
}

fn is_blob_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn optional_string(input: &Value, field: &str) -> Result<Option<String>, WorkerHostError> {
    match input.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(WorkerHostError::broker(
            "blob_invalid",
            format!("{field} must be a string"),
        )),
    }
}

fn io_error(error: std::io::Error) -> WorkerHostError {
    WorkerHostError::broker("blob_io", error)
}

pub fn dispatch_plugin_blob(
    plugin_id: &str,
    operation: &str,
    input: &Value,
) -> Result<Value, WorkerHostError> {
    BlobStore::for_plugin(plugin_id)?.dispatch(operation, input)
}

#[cfg(test)]
fn store_in(root: &std::path::Path) -> BlobStore {
    BlobStore::open(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_video_larger_than_one_json_message_roundtrips_in_chunks() {
        let root = tempfile::tempdir().unwrap();
        let store = store_in(root.path());
        let created = store
            .dispatch(
                "create",
                &json!({ "mediaType": "video/mp4", "name": "clip.mp4" }),
            )
            .unwrap();
        let id = created["id"].as_str().unwrap();
        let chunk = vec![0x11u8; BLOB_CHUNK_BYTES];
        let encoded = STANDARD.encode(&chunk);
        store
            .dispatch("append", &json!({ "id": id, "data": encoded }))
            .unwrap();
        store
            .dispatch(
                "append",
                &json!({ "id": id, "data": STANDARD.encode([0x22u8, 0x33]) }),
            )
            .unwrap();
        let finished = store.dispatch("finish", &json!({ "id": id })).unwrap();
        assert_eq!(finished["byteLength"], json!(BLOB_CHUNK_BYTES as u64 + 2));
        assert_eq!(finished["mediaType"], json!("video/mp4"));
        assert_eq!(finished["finished"], json!(true));

        let head = store
            .dispatch(
                "read",
                &json!({ "id": id, "offset": 0, "length": BLOB_CHUNK_BYTES }),
            )
            .unwrap();
        let head_bytes = STANDARD.decode(head["data"].as_str().unwrap()).unwrap();
        assert_eq!(head_bytes.len(), BLOB_CHUNK_BYTES);
        assert!(head_bytes.iter().all(|byte| *byte == 0x11));
        let tail = store
            .dispatch(
                "read",
                &json!({ "id": id, "offset": BLOB_CHUNK_BYTES, "length": 16 }),
            )
            .unwrap();
        assert_eq!(
            STANDARD.decode(tail["data"].as_str().unwrap()).unwrap(),
            vec![0x22, 0x33]
        );
    }

    #[test]
    fn an_oversized_chunk_is_rejected_and_a_foreign_id_is_hidden() {
        let root = tempfile::tempdir().unwrap();
        let store = store_in(root.path());
        let id = store.dispatch("create", &json!({})).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let too_big = STANDARD.encode(vec![1u8; BLOB_CHUNK_BYTES + 1]);
        let error = store
            .dispatch("append", &json!({ "id": id, "data": too_big }))
            .unwrap_err();
        assert_eq!(error.code(), "blob_chunk_too_large");
        let missing = store
            .dispatch("stat", &json!({ "id": "../secret" }))
            .unwrap_err();
        assert_eq!(missing.code(), "blob_not_found");
        let other = store_in(&root.path().join("other"));
        let hidden = other.dispatch("stat", &json!({ "id": id })).unwrap_err();
        assert_eq!(hidden.code(), "blob_not_found");
    }
}
