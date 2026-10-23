//! Conversation DTOs and application_call bridge.

use agents::{
    AgentAvailableCommand, AgentSessionConfigOption,
    conversation::{
        AcpCapabilitySnapshot, ConversationSessionModes, ConversationTimeline, MessageTurn,
        SessionStats,
    },
};
use db::models::conversation::DbConversationSummary;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::state::AppState;

/// A conversation's metadata plus its event-sourced projection.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DbConversationDetail {
    pub summary: DbConversationSummary,
    /// Open path no longer ships a duplicate of `timeline` (ADR-0061). Kept empty
    /// so existing TypeScript bindings remain valid.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub turns: Vec<MessageTurn>,
    pub timeline: ConversationTimeline,
    /// Index of `timeline.rows[0]` in the full transcript.
    #[serde(default)]
    pub turns_offset: u32,
    /// Turn count of the full transcript, including turns above the window.
    #[serde(default)]
    pub turns_total: u32,
    /// Fingerprint of the turns above the window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix_hash: Option<String>,
    #[serde(default)]
    pub user_turns_before_offset: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_binding: Option<ConversationActiveBinding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_turn: Option<ConversationCurrentTurn>,
    pub projection_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_stats: Option<SessionStats>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_flight_user_turn_id: Option<String>,
    /// Latest agent-advertised session modes, hydrated from the event log so a
    /// reopened conversation renders the real ACP pickers immediately.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_modes: Option<ConversationSessionModes>,
    /// Latest agent-advertised config options (model / permission / …), same
    /// hydration contract as `session_modes`.
    #[serde(default)]
    pub session_config_options: Vec<AgentSessionConfigOption>,
    /// Latest agent-advertised slash/skill catalog. `None` until the agent
    /// publishes `available_commands_update`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available_commands: Option<Vec<AgentAvailableCommand>>,
    /// Snapshot of the role used to create this conversation. Absent when the
    /// conversation was not created from a role.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persona: Option<conversations::collaboration::ConversationPersonaView>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationActiveBinding {
    pub id: Uuid,
    pub agent_type: String,
    pub working_dir: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acp_session_id: Option<String>,
    pub status: String,
    pub capabilities: AcpCapabilitySnapshot,
    /// True when this binding was created while MultiAgent collaboration was on,
    /// so Host delivered `vibex-delegation-mcp` on that session new/resume/rebind.
    #[serde(default)]
    pub delegation_mcp_delivered: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationCurrentTurn {
    pub id: Uuid,
    pub ordinal: i64,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_preview: Option<String>,
}

/// Closed application command adapter. Only names present in
/// `application::CommandRegistry` can cross this boundary.
#[tauri::command]
pub async fn application_call(
    state: tauri::State<'_, AppState>,
    command: String,
    operation_id: remote_protocol::OperationId,
    args: serde_json::Value,
) -> Result<remote_protocol::CommandResponse<serde_json::Value>, remote_protocol::ErrorEnvelope> {
    use application::Principal;

    state
        .host
        .commands
        .execute_name(&Principal::local_desktop(), &command, operation_id, args)
        .await
}
