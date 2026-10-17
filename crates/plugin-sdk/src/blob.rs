//! Helpers that move a video, or any other large byte string, through `blob.*`.
//! The JSON message stays small. The bytes live in the Host blob store.

use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};

use crate::{error::PluginSdkError, host::HostClient};

pub const BLOB_CHUNK_BYTES: usize = 512 * 1024;

pub async fn write_blob(
    host: &HostClient,
    data: &[u8],
    media_type: &str,
    name: Option<&str>,
) -> Result<Value, PluginSdkError> {
    let created = host
        .call(
            "blob",
            "create",
            json!({ "mediaType": media_type, "name": name }),
        )
        .await?;
    let id = created
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| PluginSdkError::new("blob_invalid", "blob create returned no id"))?
        .to_owned();
    for chunk in data.chunks(BLOB_CHUNK_BYTES) {
        host.call(
            "blob",
            "append",
            json!({ "id": id, "data": STANDARD.encode(chunk) }),
        )
        .await?;
    }
    host.call("blob", "finish", json!({ "id": id })).await
}

pub async fn read_blob(host: &HostClient, id: &str) -> Result<Vec<u8>, PluginSdkError> {
    let mut bytes = Vec::new();
    loop {
        let page = host
            .call(
                "blob",
                "read",
                json!({ "id": id, "offset": bytes.len(), "length": BLOB_CHUNK_BYTES }),
            )
            .await?;
        let byte_length = page.get("byteLength").and_then(Value::as_u64).unwrap_or(0) as usize;
        let chunk = page
            .get("data")
            .and_then(Value::as_str)
            .map(|data| STANDARD.decode(data))
            .transpose()
            .map_err(|_| {
                PluginSdkError::new("blob_invalid", "blob read returned data that is not base64")
            })?
            .unwrap_or_default();
        if chunk.is_empty() {
            break;
        }
        bytes.extend_from_slice(&chunk);
        if bytes.len() >= byte_length {
            break;
        }
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use async_trait::async_trait;

    use super::*;
    use crate::host::HostTransport;

    struct Mem {
        bytes: Mutex<Vec<u8>>,
        appends: Mutex<Vec<usize>>,
    }

    #[async_trait]
    impl HostTransport for Mem {
        async fn call(
            &self,
            capability: &str,
            operation: &str,
            input: Value,
        ) -> Result<Value, PluginSdkError> {
            assert_eq!(capability, "blob");
            match operation {
                "create" => Ok(json!({ "id": "abc" })),
                "append" => {
                    let data = STANDARD.decode(input["data"].as_str().unwrap()).unwrap();
                    assert!(data.len() <= BLOB_CHUNK_BYTES);
                    self.appends.lock().expect("appends").push(data.len());
                    self.bytes.lock().expect("bytes").extend_from_slice(&data);
                    Ok(json!({ "id": "abc" }))
                }
                "finish" => Ok(json!({
                    "id": "abc",
                    "byteLength": self.bytes.lock().expect("bytes").len(),
                    "finished": true
                })),
                "read" => {
                    let offset = input["offset"].as_u64().unwrap() as usize;
                    let length = input["length"].as_u64().unwrap() as usize;
                    let bytes = self.bytes.lock().expect("bytes");
                    let end = (offset + length).min(bytes.len());
                    Ok(json!({
                        "data": STANDARD.encode(&bytes[offset..end]),
                        "byteLength": bytes.len()
                    }))
                }
                other => panic!("unexpected blob operation {other}"),
            }
        }
    }

    #[tokio::test]
    async fn write_blob_splits_a_video_and_reads_it_back() {
        let mem = Arc::new(Mem {
            bytes: Mutex::new(Vec::new()),
            appends: Mutex::new(Vec::new()),
        });
        let host = HostClient::new(Arc::clone(&mem) as Arc<dyn HostTransport>);
        let video = vec![7u8; BLOB_CHUNK_BYTES + 2];
        let saved = write_blob(&host, &video, "video/mp4", Some("clip.mp4"))
            .await
            .expect("write video");
        assert_eq!(saved["byteLength"], json!(video.len()));
        assert_eq!(
            mem.appends.lock().expect("appends").as_slice(),
            &[BLOB_CHUNK_BYTES, 2]
        );
        let loaded = read_blob(&host, "abc").await.expect("read video");
        assert_eq!(loaded, video);
    }
}
