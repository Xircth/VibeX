use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    CommandResponse, ConversationId, ErrorEnvelope, OperationId, RemoteEvent,
    SubscriptionClientMessage, SubscriptionServerMessage,
};

pub const CONTROL_CHANNEL_LABEL: &str = "vibex.control.v1";
pub const BULK_CHANNEL_LABEL: &str = "vibex.bulk.v1";

pub const CONTROL_MAX_FRAME_BYTES: usize = 64 * 1024;
pub const BULK_CHUNK_MIN_BYTES: usize = 16 * 1024;
pub const BULK_CHUNK_MAX_BYTES: usize = 32 * 1024;
pub const BULK_BUFFERED_LOW_THRESHOLD_BYTES: usize = 64 * 1024;
pub const BULK_BUFFERED_HIGH_WATER_BYTES: usize = 128 * 1024;
pub const SIGNALING_PIGGYBACK_MAX_BYTES: usize = 32 * 1024;

pub const CHANNEL_BINDING_PREFIX: &str = "vibex-webrtc-v1";
pub const CHANNEL_BINDING_MAX_SKEW_SECONDS: i64 = 60;

/// Canonical claims bound to a WebRTC SDP offer/answer DTLS fingerprint and
/// signed with the sender's Ed25519 private key.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
pub struct ChannelBindingClaims {
    pub session_nonce: String,
    pub sender_device_id: String,
    pub recipient_device_id: String,
    pub unix_timestamp: i64,
    pub dtls_fingerprint: String,
}

impl ChannelBindingClaims {
    /// Canonical signing string:
    /// `vibex-webrtc-v1|<session_nonce>|<sender_device_id>|<recipient_device_id>|<unix_timestamp>|<dtls_fingerprint>`
    pub fn signing_input(&self) -> String {
        format!(
            "{}|{}|{}|{}|{}|{}",
            CHANNEL_BINDING_PREFIX,
            self.session_nonce,
            self.sender_device_id,
            self.recipient_device_id,
            self.unix_timestamp,
            self.dtls_fingerprint
        )
    }
}

/// Extracts and normalizes (uppercase colon-separated hex) the first
/// `a=fingerprint:sha-256 <FINGERPRINT>` attribute from an SDP blob.
pub fn extract_sdp_sha256_fingerprint(sdp: &str) -> Option<String> {
    for raw_line in sdp.lines() {
        let line = raw_line.trim();
        let Some(rest) = line.strip_prefix("a=fingerprint:") else {
            continue;
        };
        let mut parts = rest.split_whitespace();
        let Some(algo) = parts.next() else {
            continue;
        };
        if !algo.eq_ignore_ascii_case("sha-256") {
            continue;
        }
        let Some(fingerprint) = parts.next() else {
            continue;
        };
        let normalized = fingerprint.trim().to_ascii_uppercase();
        if !normalized.is_empty() {
            return Some(normalized);
        }
    }
    None
}

/// Optional resume cursor piggybacked onto a foreground-reconnect Signaling Offer.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
pub struct SignalingResumeCursor {
    pub conversation_id: ConversationId,
    pub after_sequence: i64,
}

/// Incremental events piggybacked onto a Signaling Answer when total serialized
/// size is `<= 32KB` (`SIGNALING_PIGGYBACK_MAX_BYTES`).
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
pub struct SignalingPiggybackEvents {
    pub conversation_id: ConversationId,
    pub events: Vec<RemoteEvent>,
    pub high_water_mark: i64,
}

/// JSON envelope carried over the `vibex.control.v1` DataChannel.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "frame", rename_all = "snake_case")]
pub enum ControlChannelFrame {
    RpcRequest {
        operation_id: OperationId,
        command: String,
        #[serde(default)]
        args: serde_json::Value,
    },
    RpcResponse {
        operation_id: OperationId,
        status: u16,
        data: serde_json::Value,
    },
    RpcError {
        operation_id: OperationId,
        status: u16,
        error: ErrorEnvelope,
    },
    SubClient {
        payload: SubscriptionClientMessage,
    },
    SubServer {
        payload: SubscriptionServerMessage,
    },
    Ping {
        timestamp_ms: i64,
    },
    Pong {
        timestamp_ms: i64,
    },
    Suspend,
}

impl ControlChannelFrame {
    pub fn from_command_response(
        status: u16,
        response: CommandResponse<serde_json::Value>,
    ) -> Self {
        Self::RpcResponse {
            operation_id: response.operation_id,
            status,
            data: response.data,
        }
    }
}

/// Chunked envelope carried over the `vibex.bulk.v1` DataChannel (`16KB ~ 32KB` per chunk).
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "frame", rename_all = "snake_case")]
pub enum BulkChannelFrame {
    BulkStart {
        operation_id: OperationId,
        content_type: String,
        total_bytes: usize,
        total_chunks: usize,
    },
    BulkChunk {
        operation_id: OperationId,
        chunk_index: usize,
        data_base64: String,
    },
    BulkEnd {
        operation_id: OperationId,
    },
    BulkCancel {
        operation_id: OperationId,
    },
}

impl BulkChannelFrame {
    pub fn chunk_payload(
        operation_id: OperationId,
        content_type: impl Into<String>,
        payload: &[u8],
        max_chunk_bytes: usize,
    ) -> Vec<Self> {
        let chunk_size = max_chunk_bytes.clamp(1, BULK_CHUNK_MAX_BYTES);
        let chunks: Vec<&[u8]> = if payload.is_empty() {
            Vec::new()
        } else {
            payload.chunks(chunk_size).collect()
        };
        let mut frames = Vec::with_capacity(chunks.len() + 2);
        frames.push(Self::BulkStart {
            operation_id,
            content_type: content_type.into(),
            total_bytes: payload.len(),
            total_chunks: chunks.len(),
        });
        for (chunk_index, chunk) in chunks.into_iter().enumerate() {
            frames.push(Self::BulkChunk {
                operation_id,
                chunk_index,
                data_base64: encode_base64(chunk),
            });
        }
        frames.push(Self::BulkEnd { operation_id });
        frames
    }
}

fn encode_base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((triple >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((triple >> 12) & 0x3f) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[((triple >> 6) & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(triple & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}
