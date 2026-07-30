//! Length-prefixed JSON framing and the request/response envelopes exchanged
//! over the companion ↔ broker socket (UDS on unix, named pipe on windows).

use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Hard cap on a single frame's JSON body. A `delegate_to_agent` task can be
/// large, but anything past this is treated as a corrupt/hostile peer.
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

/// Every message the companion can send the broker. Externally tagged
/// (`{"call": { .. }}`) — both peers share this crate so the representation only
/// has to be self-consistent.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrokerMessage {
    /// `delegate_to_agent` — start a delegation, returns a running ack.
    Call(BrokerRequest),
    /// `get_delegation_status` — poll / wait on one or more task ids.
    Status(BrokerStatusRequest),
    /// `cancel_delegation` — stop a task by its id.
    CancelTask(BrokerCancelTaskRequest),
    /// MCP `notifications/cancelled` for an in-flight `tools/call`.
    Cancel(BrokerCancelRequest),
    /// `check_user_feedback` — pull pending user steering notes.
    Feedback(BrokerFeedbackRequest),
    /// Acknowledge feedback notes as delivered (post-relay commit).
    CommitFeedback(BrokerCommitFeedbackRequest),
    /// `ask_user_question` — block until the user answers.
    Ask(BrokerAskRequest),
}

/// `delegate_to_agent` call. `parent_connection_id` is the runtime-internal ACP
/// connection id of the parent; `parent_tool_use_id` is the parent's
/// `delegate_to_agent` tool-call id (empty when the MCP client didn't supply
/// one — the broker then claims it from its tool-call tracker). `external_handle`
/// is a companion-minted token that lets an MCP cancel target this exact call.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct BrokerRequest {
    pub token: String,
    pub parent_connection_id: String,
    #[serde(default)]
    pub parent_tool_use_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_handle: Option<String>,
    /// Raw `delegate_to_agent` arguments (`agent_type` / `task` / `working_dir`).
    pub input: Value,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct BrokerStatusRequest {
    pub token: String,
    pub task_ids: Vec<String>,
    /// `None` = immediate snapshot; `Some(0)` = block until terminal;
    /// `Some(ms)` = block up to `ms` (listener caps it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct BrokerCancelTaskRequest {
    pub token: String,
    pub task_id: String,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct BrokerCancelRequest {
    pub token: String,
    pub external_handle: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct BrokerFeedbackRequest {
    pub token: String,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct BrokerCommitFeedbackRequest {
    pub token: String,
    pub ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct BrokerAskRequest {
    pub token: String,
    /// Validated question specs. Shape is owned by the companion (parse) and
    /// listener (register) in the steering milestone; carried opaquely here.
    pub questions: Value,
}

/// The broker's single reply to any message. `outcome` carries whatever the
/// handler produced (a serialized task report, `{"tasks":[..]}`, feedback, an
/// answer set, …) so the companion can pass it straight to the MCP client.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct BrokerResponse {
    pub outcome: Value,
}

/// Serialize `message` and write it as a single length-prefixed frame.
pub async fn write_frame<W, T>(writer: &mut W, message: &T) -> std::io::Result<()>
where
    W: AsyncWriteExt + Unpin,
    T: Serialize,
{
    let body = serde_json::to_vec(message)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    if body.len() > MAX_FRAME_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "frame too large to write: {} > {MAX_FRAME_BYTES}",
                body.len()
            ),
        ));
    }
    writer.write_all(&(body.len() as u32).to_le_bytes()).await?;
    writer.write_all(&body).await?;
    writer.flush().await?;
    Ok(())
}

/// Read one length-prefixed frame and deserialize it into `T`.
pub async fn read_frame<R, T>(reader: &mut R) -> std::io::Result<T>
where
    R: AsyncReadExt + Unpin,
    T: DeserializeOwned,
{
    let mut len_buf = [0u8; 4];
    reader.read_exact(&mut len_buf).await?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len > MAX_FRAME_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("frame too large to read: {len} > {MAX_FRAME_BYTES}"),
        ));
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body).await?;
    serde_json::from_slice(&body)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frame_round_trips_a_message() {
        let (mut tx, mut rx) = tokio::io::duplex(4096);
        let sent = BrokerMessage::Status(BrokerStatusRequest {
            token: "tok".to_string(),
            task_ids: vec!["a".to_string(), "b".to_string()],
            wait_ms: Some(500),
        });

        write_frame(&mut tx, &sent).await.expect("write");
        let got: BrokerMessage = read_frame(&mut rx).await.expect("read");

        match got {
            BrokerMessage::Status(req) => {
                assert_eq!(req.token, "tok");
                assert_eq!(req.task_ids, vec!["a".to_string(), "b".to_string()]);
                assert_eq!(req.wait_ms, Some(500));
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[tokio::test]
    async fn call_request_preserves_newlines_in_task() {
        let (mut tx, mut rx) = tokio::io::duplex(4096);
        let sent = BrokerMessage::Call(BrokerRequest {
            token: "tok".to_string(),
            parent_connection_id: "conn".to_string(),
            parent_tool_use_id: String::new(),
            external_handle: Some("ext".to_string()),
            input: serde_json::json!({ "agent_type": "codex", "task": "line1\nline2" }),
        });

        write_frame(&mut tx, &sent).await.expect("write");
        let got: BrokerMessage = read_frame(&mut rx).await.expect("read");

        match got {
            BrokerMessage::Call(req) => {
                assert_eq!(req.external_handle.as_deref(), Some("ext"));
                assert_eq!(req.input["task"], "line1\nline2");
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[tokio::test]
    async fn read_frame_rejects_oversized_length_prefix() {
        let (mut tx, mut rx) = tokio::io::duplex(16);
        let oversized = (MAX_FRAME_BYTES as u32 + 1).to_le_bytes();
        tx.write_all(&oversized).await.expect("write len");
        tx.flush().await.expect("flush");

        let result: std::io::Result<BrokerMessage> = read_frame(&mut rx).await;
        assert!(result.is_err());
    }
}
