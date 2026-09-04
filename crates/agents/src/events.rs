use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::{
    AgentId,
    conversation::{ImageData, SessionLoadFailureReason},
    elicitation::{AgentElicitationRequest, AgentElicitationResponse},
    ids::{
        AgentConnectionId, AgentElicitationId, AgentPermissionId, AgentPromptId, AgentSessionId,
        AgentTerminalId,
    },
    permissions::{AgentPermissionRequest, AgentPermissionResponse},
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
    /// A lossless ACP content block for protocol variants that do not have a
    /// legacy VibeX presentation shape (audio, embedded resource,
    /// resource-link, or future additions). `_meta` is retained only within
    /// the configured size bound.
    Protocol {
        content: serde_json::Value,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum AgentSteerOutcome {
    Injected,
    PromptRequired,
    StartedNewTurn,
}

/// Protocol-neutral acknowledgement for one in-flight steering request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct AgentSteerReceipt {
    pub outcome: AgentSteerOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<ImageData>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentToolCallUpdate {
    pub id: String,
    /// Rewritten title for hosts whose wire title mutates (Grok `use_tool`).
    /// `None` leaves the existing title in place.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// Raw input newly supplied by an ACP patch (including a synthesized
    /// file/diff payload when ACP reports structured content or locations).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<ImageData>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentPlan {
    pub entries: Vec<AgentPlanEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentPlanEntry {
    pub content: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentUsage {
    pub used: u64,
    pub limit: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_amount: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_currency: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentSessionMode {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// The controls advertised by one concrete ACP session.
///
/// This is deliberately session-scoped: models, modes and dependent options
/// may vary with the runtime, account and working directory.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentSessionControlsSnapshot {
    pub modes: Vec<AgentSessionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_mode: Option<String>,
    pub config_options: Vec<AgentSessionConfigOption>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<crate::AcpCapabilitySnapshot>,
    /// Session-scoped slash/skill catalog advertised by the agent. `None`
    /// until the first `available_commands_update`; not an empty guess.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available_commands: Option<Vec<AgentAvailableCommand>>,
}

/// A real ACP session created ahead of conversation persistence so creation
/// surfaces can render and mutate the exact controls that the final
/// conversation will use.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentPreparedSessionSnapshot {
    pub session: AgentSessionSnapshot,
    pub controls: AgentSessionControlsSnapshot,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stale_default_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentListedSession {
    pub acp_session_id: String,
    pub cwd: String,
    pub additional_directories: Vec<String>,
    pub title: Option<String>,
    pub updated_at: Option<String>,
    pub meta: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentSessionListPage {
    pub sessions: Vec<AgentListedSession>,
    pub next_cursor: Option<String>,
    pub meta: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentSessionConfigChoice {
    pub value: serde_json::Value,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// A select option whose available choices depend on another option's value.
/// Most ACP agents advertise the fully-resolved choices in a live session;
/// this lets a cached pre-session catalog faithfully represent the same
/// relationship without inventing a second, agent-specific UI schema.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentSessionConfigDependency {
    pub parent_key: String,
    pub choices_by_parent_value: BTreeMap<String, Vec<AgentSessionConfigChoice>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentSessionConfigOption {
    pub key: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// ACP semantic category (`mode` / `model` / `model_config` / `thought_level` / …),
    /// used by the UI to group selectors and dedupe the `mode` option against the
    /// dedicated session-mode picker.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub choices: Vec<AgentSessionConfigChoice>,
    /// Optional pre-session dependency information. It is omitted for normal
    /// live ACP options, whose `choices` are already current.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dependency: Option<AgentSessionConfigDependency>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentSessionConfigOverride {
    pub key: String,
    pub value: String,
}

/// User-chosen session controls applied at ACP session establishment, before the
/// first `session_modes` / `session_config_options` event is emitted. Mirrors
/// CodeG's `preferred_mode_id` + `preferred_config_values` on `acp_connect`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SessionControlPreferences {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub config: Vec<AgentSessionConfigOverride>,
}

impl SessionControlPreferences {
    pub fn is_empty(&self) -> bool {
        self.mode.as_deref().is_none_or(str::is_empty) && self.config.is_empty()
    }

    /// Last-used / settings values keyed like `agent_session_default.option_id`.
    /// `mode` is the session mode; every other key is a config option.
    pub fn from_option_values(values: &BTreeMap<String, serde_json::Value>) -> Self {
        let mut mode = None;
        let mut config = Vec::new();
        for (key, value) in values {
            let value = option_value_as_string(value);
            if value.is_empty() {
                continue;
            }
            if key == "mode" {
                mode = Some(value);
            } else {
                config.push(AgentSessionConfigOverride {
                    key: key.clone(),
                    value,
                });
            }
        }
        Self { mode, config }
    }
}

fn option_value_as_string(value: &serde_json::Value) -> String {
    value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| match value {
            serde_json::Value::Bool(_) | serde_json::Value::Number(_) => value.to_string(),
            _ => String::new(),
        })
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
    /// can bind `external_session_id` + `agent_id` onto the conversation row for
    /// transcript re-parse. The `session_id` of the originating DB row travels on
    /// the event envelope.
    SessionLinked {
        acp_session_id: String,
        agent_id: AgentId,
        capabilities: crate::AcpCapabilitySnapshot,
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
    /// A partial ACP session metadata patch. Kept as protocol-shaped JSON so
    /// fields added by newer ACP revisions survive without being flattened.
    SessionInfoUpdated {
        patch: serde_json::Value,
    },
    SessionLoadFailed {
        reason: SessionLoadFailureReason,
    },
    TurnCompleted {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stop_reason: Option<String>,
    },
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
    /// The agent asked the user for structured input (ACP `elicitation/create`,
    /// form mode) — e.g. Claude Code's `AskUserQuestion`.
    ElicitationRequested {
        request: AgentElicitationRequest,
    },
    ElicitationResponded {
        elicitation_id: AgentElicitationId,
        response: AgentElicitationResponse,
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
        delegation_id: String,
        parent_tool_use_id: String,
        /// The child's `sessions.id` — the conversation the user can open.
        child_session_id: Uuid,
        agent_id: AgentId,
        task_preview: String,
    },
    /// A delegated child reached a terminal state.
    DelegationCompleted {
        delegation_id: String,
        parent_tool_use_id: String,
        child_session_id: Uuid,
        agent_id: AgentId,
        result: DelegationResultSummary,
    },
    Error {
        error: AgentErrorEvent,
    },
    RawAcpDiagnostic {
        raw: serde_json::Value,
    },
    AnnouncementsUpdated {
        #[serde(default)]
        generation: u64,
        notices: Vec<crate::conversation::ConversationSessionNotice>,
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
    fn last_used_option_values_split_mode_from_config() {
        let mut values = BTreeMap::new();
        values.insert(
            "mode".to_string(),
            serde_json::Value::String("bypassPermissions".into()),
        );
        values.insert(
            "model".to_string(),
            serde_json::Value::String("opus".into()),
        );
        values.insert(
            "thought_level".to_string(),
            serde_json::Value::String("high".into()),
        );
        let prefs = SessionControlPreferences::from_option_values(&values);
        assert_eq!(prefs.mode.as_deref(), Some("bypassPermissions"));
        assert_eq!(
            prefs
                .config
                .iter()
                .map(|item| (item.key.as_str(), item.value.as_str()))
                .collect::<Vec<_>>(),
            vec![("model", "opus"), ("thought_level", "high")]
        );
    }

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
                    category: Some("model".to_string()),
                    value: Some(serde_json::json!("gpt-5.4")),
                    choices: vec![AgentSessionConfigChoice {
                        value: serde_json::json!("gpt-5.4"),
                        label: "GPT-5.4".to_string(),
                        description: None,
                    }],
                    dependency: None,
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
                    meta: None,
                    images: Vec::new(),
                },
            },
            AgentEvent::ToolCallUpdate {
                update: AgentToolCallUpdate {
                    id: "tool-1".to_string(),
                    title: None,
                    status: Some("completed".to_string()),
                    content: Some("ok".to_string()),
                    input_preview: None,
                    meta: None,
                    images: Vec::new(),
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
