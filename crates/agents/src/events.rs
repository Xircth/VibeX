use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::{
    conversation::SessionLoadFailureReason,
    ids::{AgentConnectionId, AgentPermissionId, AgentPromptId, AgentSessionId, AgentTerminalId},
    permissions::{AgentPermissionRequest, AgentPermissionResponse},
    registry::AgentKind,
    state::{AgentConnectionSnapshot, AgentPromptSnapshot, AgentSessionSnapshot},
};

/// Terminal summary of a delegation, carried on [`AgentEvent::DelegationCompleted`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum DelegationResultSummary {
    Ok {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text_preview: Option<String>,
    },
    Err {
        error_code: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum AgentContentBlock {
    Text {
        text: String,
    },
    Image {
        data: String,
        mime_type: String,
        uri: Option<String>,
    },
    Resource {
        uri: String,
        title: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentToolCall {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_preview: Option<String>,
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
pub struct AgentSessionMode {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentSessionConfigChoice {
    pub value: serde_json::Value,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentSessionConfigOption {
    pub key: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub choices: Vec<AgentSessionConfigChoice>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentSessionConfigOverride {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentAvailableCommand {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<serde_json::Value>,
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
    /// Stable semantic code derived from the agent's real ACP/JSON-RPC error
    /// code (e.g. `auth_required`, `resource_not_found`, `request_cancelled`).
    /// `None` for non-ACP failures (e.g. a connection drop).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
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
    /// The agent assigned its own ACP session id (the on-disk session-file key).
    /// Emitted once when the ACP session is established, so the persistence layer
    /// can bind `external_session_id` + `agent_type` onto the conversation row for
    /// transcript re-parse. The `session_id` of the originating DB row travels on
    /// the event envelope.
    SessionLinked {
        acp_session_id: String,
        agent_type: AgentKind,
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
    SessionModes {
        modes: Vec<AgentSessionMode>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        current: Option<String>,
    },
    ModeChanged {
        mode_id: String,
    },
    SessionConfigOptions {
        options: Vec<AgentSessionConfigOption>,
    },
    ConfigChanged {
        key: String,
        value: serde_json::Value,
    },
    AvailableCommands {
        commands: Vec<AgentAvailableCommand>,
    },
    SessionLoadFailed {
        reason: SessionLoadFailureReason,
    },
    TurnCompleted {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stop_reason: Option<String>,
    },
    ForkSupported,
    SessionConfigStale {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    PermissionRequested {
        request: AgentPermissionRequest,
    },
    PermissionResponded {
        permission_id: AgentPermissionId,
        response: AgentPermissionResponse,
        #[serde(default)]
        auto: bool,
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
    /// A child agent was delegated to (spawned + first prompt sent). Emitted on
    /// the PARENT connection's stream so the UI can render an inline delegation
    /// card on the parent's `delegate_to_agent` tool call.
    DelegationStarted {
        parent_tool_use_id: String,
        /// The child's `sessions.id` — the conversation the user can open.
        child_session_id: Uuid,
        agent_type: AgentKind,
        task_preview: String,
    },
    /// A delegated child reached a terminal state.
    DelegationCompleted {
        parent_tool_use_id: String,
        child_session_id: Uuid,
        agent_type: AgentKind,
        result: DelegationResultSummary,
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

    #[test]
    fn phase1_contract_events_roundtrip() {
        let events = vec![
            AgentEvent::SessionModes {
                modes: vec![AgentSessionMode {
                    id: "plan".to_string(),
                    label: "Plan".to_string(),
                    description: Some("Plan before editing".to_string()),
                }],
                current: Some("plan".to_string()),
            },
            AgentEvent::ModeChanged {
                mode_id: "code".to_string(),
            },
            AgentEvent::SessionConfigOptions {
                options: vec![AgentSessionConfigOption {
                    key: "model".to_string(),
                    label: "Model".to_string(),
                    description: None,
                    value: Some(serde_json::json!("gpt-5.4")),
                    choices: vec![AgentSessionConfigChoice {
                        value: serde_json::json!("gpt-5.4"),
                        label: "GPT-5.4".to_string(),
                        description: None,
                    }],
                }],
            },
            AgentEvent::ConfigChanged {
                key: "model".to_string(),
                value: serde_json::json!("gpt-5.4-mini"),
            },
            AgentEvent::AvailableCommands {
                commands: vec![AgentAvailableCommand {
                    name: "/compact".to_string(),
                    description: Some("Compact context".to_string()),
                    input_schema: Some(serde_json::json!({"type":"object"})),
                }],
            },
            AgentEvent::SessionLoadFailed {
                reason: SessionLoadFailureReason::Unsupported,
            },
            AgentEvent::TurnCompleted {
                stop_reason: Some("end_turn".to_string()),
            },
            AgentEvent::ForkSupported,
            AgentEvent::SessionConfigStale {
                reason: Some("adapter changed".to_string()),
            },
        ];

        for event in events {
            let value = serde_json::to_value(&event).unwrap();
            let roundtrip: AgentEvent = serde_json::from_value(value.clone()).unwrap();

            assert_eq!(roundtrip, event);
            assert!(value["kind"].as_str().is_some());
        }
    }

    #[test]
    fn acp_notification_mapping_contract_events_exist() {
        let events = vec![
            AgentEvent::MessageChunk {
                content: AgentContentBlock::Text {
                    text: "hello".to_string(),
                },
            },
            AgentEvent::ThoughtChunk {
                content: AgentContentBlock::Text {
                    text: "thinking".to_string(),
                },
            },
            AgentEvent::ToolCall {
                tool_call: AgentToolCall {
                    id: "tool-1".to_string(),
                    title: "Edit".to_string(),
                    kind: Some("edit".to_string()),
                    input_preview: Some("{}".to_string()),
                },
            },
            AgentEvent::ToolCallUpdate {
                update: AgentToolCallUpdate {
                    id: "tool-1".to_string(),
                    status: Some("completed".to_string()),
                    content: Some("ok".to_string()),
                },
            },
            AgentEvent::SessionLoadFailed {
                reason: SessionLoadFailureReason::ResourceNotFound,
            },
            AgentEvent::SessionConfigStale { reason: None },
        ];

        for event in events {
            let value = serde_json::to_value(&event).unwrap();
            assert!(value["kind"].as_str().is_some());
        }
    }

    #[test]
    fn acp_host_request_mapping_contract_events_exist() {
        let permission_id = AgentPermissionId::new();
        let session_id = AgentSessionId::new();
        let events = vec![
            AgentEvent::PermissionRequested {
                request: AgentPermissionRequest {
                    id: permission_id,
                    session_id,
                    title: "Run".to_string(),
                    details: None,
                    options: Vec::new(),
                },
            },
            AgentEvent::PermissionResponded {
                permission_id,
                response: AgentPermissionResponse::Cancelled,
                auto: false,
            },
            AgentEvent::TerminalCreated {
                terminal: AgentTerminalSnapshot {
                    id: AgentTerminalId::new(),
                    command: "cargo".to_string(),
                    args: vec!["test".to_string()],
                    cwd: None,
                },
            },
            AgentEvent::TerminalOutput {
                output: AgentTerminalOutput {
                    terminal_id: AgentTerminalId::new(),
                    output: "ok".to_string(),
                    truncated: false,
                    exit_status: Some(0),
                },
            },
        ];

        for event in events {
            let value = serde_json::to_value(&event).unwrap();
            assert!(value["kind"].as_str().is_some());
        }
    }
}
