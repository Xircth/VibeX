use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::ids::{
    AgentConnectionId, AgentPermissionId, AgentPromptId, AgentSessionId, AgentTerminalId,
};
use crate::state::{AgentConnectionSnapshot, AgentPromptSnapshot, AgentSessionSnapshot};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum AgentContentBlock {
    Text { text: String },
    Image {
        data: String,
        mime_type: String,
        uri: Option<String>,
    },
    Resource { uri: String, title: Option<String> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentToolCall {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentToolCallUpdate {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentPlan {
    pub entries: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentUsage {
    pub used: u64,
    pub limit: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentTerminalSnapshot {
    pub id: AgentTerminalId,
    pub command: String,
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentTerminalOutput {
    pub terminal_id: AgentTerminalId,
    pub output: String,
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_status: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentPromptFinished {
    pub prompt_id: AgentPromptId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentErrorEvent {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum AgentEvent {
    ConnectionStatusChanged {
        snapshot: AgentConnectionSnapshot,
    },
    SessionCreated {
        snapshot: AgentSessionSnapshot,
    },
    PromptStarted {
        snapshot: AgentPromptSnapshot,
    },
    MessageChunk {
        content: AgentContentBlock,
    },
    ThoughtChunk {
        content: AgentContentBlock,
    },
    ToolCall {
        tool_call: AgentToolCall,
    },
    ToolCallUpdate {
        update: AgentToolCallUpdate,
    },
    Plan {
        plan: AgentPlan,
    },
    Usage {
        usage: AgentUsage,
    },
    PermissionRequested {
        permission_id: AgentPermissionId,
    },
    TerminalCreated {
        terminal: AgentTerminalSnapshot,
    },
    TerminalOutput {
        output: AgentTerminalOutput,
    },
    PromptFinished {
        finished: AgentPromptFinished,
    },
    Error {
        error: AgentErrorEvent,
    },
    RawAcpDiagnostic {
        raw: serde_json::Value,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentEventEnvelope {
    pub sequence: i64,
    pub workspace_id: Uuid,
    pub connection_id: AgentConnectionId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<AgentSessionId>,
    pub event: AgentEvent,
    pub created_at: DateTime<Utc>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_envelope_serializes_tagged_event() {
        let envelope = AgentEventEnvelope {
            sequence: 7,
            workspace_id: Uuid::new_v4(),
            connection_id: AgentConnectionId::new(),
            session_id: None,
            event: AgentEvent::MessageChunk {
                content: AgentContentBlock::Text {
                    text: "hello".to_string(),
                },
            },
            created_at: Utc::now(),
        };

        let value = serde_json::to_value(envelope).unwrap();
        assert_eq!(value["event"]["kind"], "message_chunk");
        assert_eq!(value["event"]["content"]["kind"], "text");
    }
}
