use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PLUGIN_API_VERSION: &str = "1.0";
pub const PLUGIN_PROTOCOL_VERSION: &str = "1.1";
pub const PLUGIN_SDK_VERSION: &str = "1.0.0";
/// Smallest frame a Worker may declare. Below this, one chunk envelope does not fit.
pub const MIN_FRAME_BYTES: usize = 1024 * 1024;
/// Default wire frame. A plugin overrides it with `entrypoints.worker.maxFrameMiB`.
pub const MAX_FRAME_BYTES: usize = 32 * 1024 * 1024;
/// Assembled JSON message cap. One image as base64 is larger than a wire frame.
pub const MAX_LOGICAL_MESSAGE_BYTES: usize = 128 * 1024 * 1024;
pub const FRAME_CHUNK_METHOD: &str = "frame.chunk";

const ENVELOPE_RESERVE: usize = 192;
const COUNT_PROBE: usize = 99_999_999;

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PackageClass {
    #[default]
    FullTrust,
    Isolated,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginIdentity {
    pub publisher: String,
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolLimits {
    pub max_frame_bytes: u64,
    #[serde(default)]
    pub max_logical_message_bytes: Option<u64>,
    pub request_timeout_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub id: String,
    pub version: String,
    pub target: String,
    pub digest: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub protocol_range: Vec<String>,
    pub host_version: String,
    pub plugin_identity: PluginIdentity,
    pub package_version: String,
    pub package_digest: String,
    pub generation_id: u64,
    pub declared_contributions: Vec<String>,
    pub package_class: PackageClass,
    #[serde(default)]
    pub features: Vec<String>,
    pub limits: ProtocolLimits,
    pub runtime: RuntimeInfo,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializedResult {
    pub protocol_version: String,
    pub sdk_version: String,
    pub registrations: Vec<String>,
    pub requested_features: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginContext {
    pub plugin_id: String,
    pub plugin_version: String,
    pub generation: u64,
    #[serde(default)]
    pub package_class: PackageClass,
    #[serde(default = "default_granted_capabilities")]
    pub granted_capabilities: Vec<String>,
}

fn default_granted_capabilities() -> Vec<String> {
    vec!["*".to_owned()]
}

impl PluginContext {
    pub fn from_initialize(params: &InitializeParams) -> Self {
        Self {
            plugin_id: params.plugin_identity.id.clone(),
            plugin_version: params.package_version.clone(),
            generation: params.generation_id,
            package_class: params.package_class.clone(),
            granted_capabilities: vec!["*".to_owned()],
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WireInbound {
    pub id: String,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub params: Value,
    #[serde(default)]
    pub ok: Option<bool>,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<ProtocolError>,
}

pub fn error_response(id: impl Into<String>, code: &str, message: impl Into<String>) -> Value {
    serde_json::json!({
        "id": id.into(),
        "ok": false,
        "error": { "code": code, "message": message.into() }
    })
}

pub fn ok_response(id: impl Into<String>, result: Value) -> Value {
    serde_json::json!({
        "id": id.into(),
        "ok": true,
        "result": result
    })
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FrameCodecError {
    pub code: &'static str,
    pub message: String,
}

#[derive(Clone, Copy, Debug)]
pub struct FrameCodec {
    max_frame_bytes: usize,
    max_logical_bytes: usize,
}

impl FrameCodec {
    pub const fn protocol() -> Self {
        Self {
            max_frame_bytes: MAX_FRAME_BYTES,
            max_logical_bytes: MAX_LOGICAL_MESSAGE_BYTES,
        }
    }

    pub const fn new(max_frame_bytes: usize, max_logical_bytes: usize) -> Self {
        Self {
            max_frame_bytes,
            max_logical_bytes,
        }
    }

    /// Limits the Host advertised in `initialize`. The frame stays inside
    /// 1 MiB..=128 MiB, and the assembled message stays at least that large.
    pub fn from_advertised(
        max_frame_bytes: u64,
        max_logical_message_bytes: Option<u64>,
    ) -> Result<Self, FrameCodecError> {
        let max_frame = usize::try_from(max_frame_bytes).unwrap_or(usize::MAX);
        if !(MIN_FRAME_BYTES..=MAX_LOGICAL_MESSAGE_BYTES).contains(&max_frame) {
            return Err(FrameCodecError {
                code: "protocol_invalid",
                message: "Host maxFrameBytes must be from 1 MiB through 128 MiB".to_owned(),
            });
        }
        let max_logical = match max_logical_message_bytes {
            Some(value) => usize::try_from(value).unwrap_or(usize::MAX),
            None => MAX_LOGICAL_MESSAGE_BYTES,
        };
        if max_logical < max_frame || max_logical > MAX_LOGICAL_MESSAGE_BYTES {
            return Err(FrameCodecError {
                code: "protocol_invalid",
                message: "Host maxLogicalMessageBytes must cover the frame and stay within 128 MiB"
                    .to_owned(),
            });
        }
        Ok(Self::new(max_frame, max_logical))
    }

    pub fn max_frame_bytes(self) -> usize {
        self.max_frame_bytes
    }

    pub fn max_logical_bytes(self) -> usize {
        self.max_logical_bytes
    }

    /// Wire frames, without the trailing newline. A message that fits in one
    /// frame stays a single JSON line. A larger message, such as an image,
    /// becomes `frame.chunk` frames the peer reassembles.
    pub fn encode(&self, message: &Value) -> Result<Vec<Vec<u8>>, FrameCodecError> {
        let logical = serde_json::to_vec(message).map_err(|error| FrameCodecError {
            code: "protocol_invalid",
            message: error.to_string(),
        })?;
        if logical.len() > self.max_logical_bytes {
            return Err(FrameCodecError {
                code: "message_too_large",
                message: format!(
                    "message is {} bytes; the limit is {}",
                    logical.len(),
                    self.max_logical_bytes
                ),
            });
        }
        if logical.len() <= self.max_frame_bytes {
            return Ok(vec![logical]);
        }
        let logical = String::from_utf8(logical).map_err(|error| FrameCodecError {
            code: "protocol_invalid",
            message: error.to_string(),
        })?;
        let stream_id = message
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let slices = self.split(&logical, stream_id)?;
        let count = slices.len();
        slices
            .iter()
            .enumerate()
            .map(|(index, data)| {
                let frame = encode_chunk(stream_id, index, count, data)?;
                if frame.len() > self.max_frame_bytes {
                    return Err(FrameCodecError {
                        code: "frame_too_large",
                        message: "chunk frame exceeded the limit".to_owned(),
                    });
                }
                Ok(frame)
            })
            .collect()
    }

    fn split(&self, logical: &str, stream_id: &str) -> Result<Vec<String>, FrameCodecError> {
        let mut max_data = self.max_frame_bytes.saturating_sub(ENVELOPE_RESERVE) / 6;
        if max_data == 0 {
            max_data = 1;
        }
        let mut slices = Vec::new();
        let mut offset = 0;
        while offset < logical.len() {
            let mut take = (logical.len() - offset).min(max_data);
            let data = loop {
                let end = floor_char_boundary(logical, offset + take);
                if end <= offset {
                    return Err(FrameCodecError {
                        code: "frame_too_large",
                        message: "frame limit is too small to encode a chunk".to_owned(),
                    });
                }
                let candidate = &logical[offset..end];
                let encoded = encode_chunk(stream_id, slices.len(), COUNT_PROBE, candidate)?;
                if encoded.len() <= self.max_frame_bytes {
                    break candidate.to_owned();
                }
                if candidate.chars().nth(1).is_none() {
                    return Err(FrameCodecError {
                        code: "frame_too_large",
                        message: "frame limit is too small to encode a chunk".to_owned(),
                    });
                }
                take = candidate.len() / 2;
                if take == 0 {
                    return Err(FrameCodecError {
                        code: "frame_too_large",
                        message: "frame limit is too small to encode a chunk".to_owned(),
                    });
                }
            };
            offset += data.len();
            slices.push(data);
        }
        Ok(slices)
    }
}

fn floor_char_boundary(text: &str, index: usize) -> usize {
    let mut end = index.min(text.len());
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    end
}

fn encode_chunk(
    stream_id: &str,
    index: usize,
    count: usize,
    data: &str,
) -> Result<Vec<u8>, FrameCodecError> {
    serde_json::to_vec(&serde_json::json!({
        "id": format!("chunk:{stream_id}:{index}"),
        "method": FRAME_CHUNK_METHOD,
        "params": {
            "streamId": stream_id,
            "index": index,
            "count": count,
            "data": data,
        }
    }))
    .map_err(|error| FrameCodecError {
        code: "protocol_invalid",
        message: error.to_string(),
    })
}

#[derive(Clone, Debug)]
pub enum FrameDecode {
    NeedMore,
    Message(Value),
}

#[derive(Clone, Debug)]
pub struct FrameReassembler {
    codec: FrameCodec,
    stream_id: Option<String>,
    count: u64,
    next_index: u64,
    parts: Vec<String>,
    total_bytes: usize,
}

impl FrameReassembler {
    pub fn protocol() -> Self {
        Self::new(FrameCodec::protocol())
    }

    pub fn new(codec: FrameCodec) -> Self {
        Self {
            codec,
            stream_id: None,
            count: 0,
            next_index: 0,
            parts: Vec::new(),
            total_bytes: 0,
        }
    }

    pub fn set_codec(&mut self, codec: FrameCodec) {
        if self.stream_id.is_none() {
            self.codec = codec;
        }
    }

    pub fn push_line(&mut self, line: &str) -> Result<FrameDecode, FrameCodecError> {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return Ok(FrameDecode::NeedMore);
        }
        if trimmed.len() > self.codec.max_frame_bytes {
            self.reset();
            return Err(FrameCodecError {
                code: "frame_too_large",
                message: "Worker protocol frame exceeded the limit".to_owned(),
            });
        }
        let value: Value = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(_) => {
                self.reset();
                return Err(FrameCodecError {
                    code: "protocol_invalid",
                    message: "Invalid JSON message".to_owned(),
                });
            }
        };
        if value.get("method").and_then(Value::as_str) != Some(FRAME_CHUNK_METHOD) {
            if self.stream_id.is_some() {
                self.reset();
                return Err(FrameCodecError {
                    code: "frame_chunk_invalid",
                    message: "Chunk sequence was interrupted".to_owned(),
                });
            }
            return Ok(FrameDecode::Message(value));
        }
        self.push_chunk(&value)
    }

    fn push_chunk(&mut self, value: &Value) -> Result<FrameDecode, FrameCodecError> {
        let stream_id = value
            .pointer("/params/streamId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let index = value.pointer("/params/index").and_then(Value::as_u64);
        let count = value.pointer("/params/count").and_then(Value::as_u64);
        let data = value
            .pointer("/params/data")
            .and_then(Value::as_str)
            .unwrap_or("");
        let (Some(index), Some(count)) = (index, count) else {
            self.reset();
            return Err(invalid_chunk("Chunk is missing index or count"));
        };
        if stream_id.is_empty() || data.is_empty() || count == 0 || index >= count {
            self.reset();
            return Err(invalid_chunk(
                "Chunk is missing streamId, index, count, or data",
            ));
        }
        if count > self.codec.max_logical_bytes as u64 {
            self.reset();
            return Err(invalid_chunk("Chunk count exceeds the message limit"));
        }
        if index == 0 {
            if self.stream_id.is_some() {
                self.reset();
                return Err(invalid_chunk("Chunk sequence was interrupted"));
            }
            self.stream_id = Some(stream_id.to_owned());
            self.count = count;
            self.next_index = 0;
            self.parts.clear();
            self.total_bytes = 0;
        }
        if self.stream_id.as_deref() != Some(stream_id)
            || index != self.next_index
            || count != self.count
        {
            self.reset();
            return Err(invalid_chunk(
                "Chunk index or count does not match the sequence",
            ));
        }
        self.total_bytes = self.total_bytes.saturating_add(data.len());
        if self.total_bytes > self.codec.max_logical_bytes {
            self.reset();
            return Err(FrameCodecError {
                code: "message_too_large",
                message: format!("message exceeds {} bytes", self.codec.max_logical_bytes),
            });
        }
        self.parts.push(data.to_owned());
        self.next_index += 1;
        if self.next_index < self.count {
            return Ok(FrameDecode::NeedMore);
        }
        let logical = self.parts.concat();
        let stream_id = stream_id.to_owned();
        self.reset();
        let message: Value = serde_json::from_str(&logical).map_err(|_| FrameCodecError {
            code: "protocol_invalid",
            message: "Reassembled message is not JSON".to_owned(),
        })?;
        if message.get("id").and_then(Value::as_str) != Some(stream_id.as_str()) {
            return Err(invalid_chunk(
                "Reassembled message id does not match the chunk stream",
            ));
        }
        Ok(FrameDecode::Message(message))
    }

    fn reset(&mut self) {
        self.stream_id = None;
        self.count = 0;
        self.next_index = 0;
        self.parts.clear();
        self.total_bytes = 0;
    }
}

fn invalid_chunk(message: &str) -> FrameCodecError {
    FrameCodecError {
        code: "frame_chunk_invalid",
        message: message.to_owned(),
    }
}

#[cfg(test)]
mod frame_tests {
    use super::*;

    #[test]
    fn an_image_larger_than_one_frame_roundtrips_through_chunks() {
        let image = "A".repeat(4_000);
        let original = serde_json::json!({
            "id": "host:4",
            "ok": true,
            "result": { "mime": "image/png", "data": image }
        });
        let codec = FrameCodec::new(180, 64 * 1024);
        let frames = codec.encode(&original).expect("encode");
        assert!(frames.len() > 1, "expected the image to be split");
        for frame in &frames {
            assert!(frame.len() <= 180, "frame {} exceeds 180", frame.len());
            let value: Value = serde_json::from_slice(frame).expect("chunk json");
            assert_eq!(value["method"], FRAME_CHUNK_METHOD);
        }
        let mut assembler = FrameReassembler::new(codec);
        let mut decoded = None;
        for frame in &frames {
            let line = std::str::from_utf8(frame).expect("utf8");
            match assembler.push_line(line).expect("chunk") {
                FrameDecode::NeedMore => {}
                FrameDecode::Message(message) => decoded = Some(message),
            }
        }
        assert_eq!(decoded.expect("reassembled image"), original);
    }

    #[test]
    fn a_message_that_fits_stays_one_frame() {
        let original = serde_json::json!({"id": "host:1", "method": "ping", "params": {}});
        let frames = FrameCodec::new(8 * 1024, 64 * 1024)
            .encode(&original)
            .expect("encode");
        assert_eq!(frames.len(), 1);
        let parsed: Value = serde_json::from_slice(&frames[0]).expect("json");
        assert_eq!(parsed, original);
    }

    #[test]
    fn an_illegal_chunk_fails_and_the_next_message_still_decodes() {
        let mut assembler = FrameReassembler::new(FrameCodec::new(8 * 1024, 64 * 1024));
        let error = assembler
            .push_line(
                r#"{"id":"chunk:host:1:1","method":"frame.chunk","params":{"streamId":"host:1","index":1,"count":2,"data":"{"}}"#,
            )
            .expect_err("out-of-order chunk");
        assert_eq!(error.code, "frame_chunk_invalid");
        let message = assembler
            .push_line(r#"{"id":"host:2","ok":true,"result":{"ready":true}}"#)
            .expect("next message");
        match message {
            FrameDecode::Message(value) => assert_eq!(value["result"]["ready"], true),
            FrameDecode::NeedMore => panic!("complete message"),
        }
    }
}
