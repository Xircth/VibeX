//! Unified conversation transcript model.
//!
//! This is the single data vocabulary that both the live (ACP event) stream and
//! the persisted (agent session-file parse) transcript converge on, so the
//! frontend renderer never has to branch on whether a turn is live. A turn is
//! the atomic, role-homogeneous unit; its ordered `blocks` carry the content.
//!
//! The Rust types in this module are VibeX-authored for the event-sourced
//! conversation architecture.

use api_types::AgentKind;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::{
    AgentId,
    events::{
        AgentAvailableCommand, AgentSessionConfigOption, AgentSessionConfigOverride,
        AgentSessionMode,
    },
    permissions::{AgentPermissionOption, AgentPermissionRequest, AgentPermissionResponse},
};

/// Role of a conversation turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
#[ts(export)]
pub enum TurnRole {
    User,
    Assistant,
    System,
}

/// Auditable identity of a plugin-owned workflow selected for a conversation turn.
#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
#[ts(export)]
pub struct ConversationWorkflowRef {
    pub plugin_id: String,
    #[serde(rename = "workflowId", alias = "actionId")]
    pub workflow_id: String,
}

/// Canonical, protocol-neutral input persisted before any Agent transport call.
/// Runtime-specific prompt blocks are derived only when the input is dispatched.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum ContinuationPolicy {
    Portable,
    Fresh,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
#[ts(export)]
pub struct ConversationInputPayload {
    /// Missing preserves the existing same-Agent/rebind behavior.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub continuation_policy: Option<ContinuationPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub expected_binding_revision: Option<u64>,
    pub agent_id: AgentId,
    pub workspace_id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executor_profile_id: Option<serde_json::Value>,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_text: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode_override: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub config_overrides: Vec<AgentSessionConfigOverride>,
    #[serde(
        default,
        skip_serializing_if = "Vec::is_empty",
        alias = "pluginActions"
    )]
    pub workflow_refs: Vec<ConversationWorkflowRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub file_refs: Vec<ConversationFileRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub internal_prompt_contributions: Vec<InternalPromptBlock>,
    /// Space-originated turn: agent prompt is `text`, the session bubble is
    /// `display_text`, and this origin labels the sender for group member
    /// sessions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collaboration_origin: Option<CollaborationSpaceOrigin>,
    /// Selected provider instance (`provider_instances.instance_id`) for multi-instance routing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub provider_instance_id: Option<String>,
}

/// Who posted a collaboration-space delivery that became this conversation
/// input. Persisted on the payload and mirrored onto the user-turn protocol
/// block so the session timeline can show the sender.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
#[ts(export)]
pub struct CollaborationSpaceOrigin {
    pub space_id: String,
    /// `"group"` or `"dm"`.
    pub thread_kind: String,
    /// `"user"` or `"member"`.
    pub sender_kind: String,
    pub sender_nickname: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sender_conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sender_member_id: Option<String>,
}

/// Implicit context block contributed by a plugin (`beforeTurn` hook or prompt context
/// contributor). Injected into the Agent prompt under `<vibex-plugin-context>` while kept
/// completely invisible in the user-facing `UserTurnCreated` timeline blocks.
#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
#[ts(export)]
pub struct InternalPromptBlock {
    pub plugin_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<i32>,
}

/// Maximum total UTF-8 byte size for all `internal_prompt_contributions` combined in a
/// single turn (16 KiB).
pub const MAX_INTERNAL_PROMPT_CONTRIBUTIONS_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
#[ts(export)]
pub struct ConversationFileRef {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
}

/// Input lifecycle facts stored in the Conversation Event Log. The queue table is
/// a rebuildable claim/read projection of these events, never a second authority.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum ConversationInputEvent {
    Submitted {
        input_id: Uuid,
        operation_id: Uuid,
        revision: u64,
        sort_key: i64,
        payload_digest: String,
        payload: ConversationInputPayload,
        principal: serde_json::Value,
    },
    Updated {
        input_id: Uuid,
        revision: u64,
        payload_digest: String,
        payload: ConversationInputPayload,
    },
    Reordered {
        input_id: Uuid,
        revision: u64,
        sort_key: i64,
    },
    Claimed {
        input_id: Uuid,
        claim_token: Uuid,
        claim_deadline: DateTime<Utc>,
    },
    ClaimReleased {
        input_id: Uuid,
        claim_token: Uuid,
    },
    Dispatched {
        input_id: Uuid,
        claim_token: Uuid,
        turn_id: Uuid,
    },
    Cancelled {
        input_id: Uuid,
        revision: u64,
    },
}

/// Execution strategy used to deliver a steering request to a running session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum ConversationSteeringDeliveryMode {
    Native,
    InterruptRestart,
}

/// Durable lifecycle for one attempt to inject guidance into an active Turn.
/// A requested record is never retried automatically: after an ambiguous
/// disconnect it settles as `Unknown`, preserving at-most-once semantics.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum ConversationSteeringEvent {
    Requested {
        steering_id: Uuid,
        operation_id: Uuid,
        expected_turn_id: Uuid,
        payload_digest: String,
        blocks: Vec<ConversationInputBlock>,
        principal: serde_json::Value,
    },
    Accepted {
        steering_id: Uuid,
        expected_turn_id: Uuid,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        delivery_mode: Option<ConversationSteeringDeliveryMode>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        restarted_turn_id: Option<Uuid>,
    },
    Rejected {
        steering_id: Uuid,
        expected_turn_id: Uuid,
        code: String,
        message: String,
    },
    Unknown {
        steering_id: Uuid,
        expected_turn_id: Uuid,
        message: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum ConversationRelationKind {
    Delegation,
    Fork,
    WorkflowStep,
    /// A durable conversation created from a role or directly. Navigation only:
    /// parent exit does not cancel it, and it has no delegation call id.
    Spawned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum ConversationRelationVisibility {
    Visible,
    Hidden,
}

/// Token accounting for a single turn.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TurnUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
    /// Tokens currently in the Agent context window (ACP `UsageUpdate.used`).
    /// Occupancy, not an input-token count.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_used: Option<u64>,
    /// Context-window size reported by the agent (ACP usage `size`), when
    /// provided. None for agents/transcripts that don't report a window.
    #[serde(default)]
    pub context_window_max: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_amount: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_currency: Option<String>,
}

/// A base64-encoded image payload referenced by image content blocks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ImageData {
    pub data: String,
    pub mime_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub height: Option<u32>,
}

/// One tool invocation recorded inside a delegated sub-agent run. Named to avoid
/// colliding with the live ACP `AgentToolCall` in the flat generated TS scope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SubAgentToolCall {
    pub tool_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_preview: Option<String>,
    pub is_error: bool,
}

/// Aggregated execution stats for a delegated sub-agent, attached to the parent
/// tool's `tool_result` block.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentExecutionStats {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_tool_use_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lines_added: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lines_removed: Option<u32>,
    #[serde(default)]
    pub tool_calls: Vec<SubAgentToolCall>,
}

/// One ordered piece of a turn. Both the live stream and the parsed transcript
/// produce this vocabulary, so rendering is uniform.
///
/// Note: permission requests and ask-user questions are transient connection
/// state (rendered above the composer), not transcript blocks. Per-turn usage
/// lives on [`MessageTurn::usage`], not in a block.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export)]
pub enum ContentBlock {
    Text {
        text: String,
    },
    Thinking {
        text: String,
    },
    Image {
        data: String,
        mime_type: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        uri: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        width: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        height: Option<u32>,
    },
    /// First-class image generation (codex-acp). `image` is `None` while the
    /// generation is still in flight.
    ImageGeneration {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        revised_prompt: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        image: Option<ImageData>,
    },
    ToolUse {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_use_id: Option<String>,
        tool_name: String,
        /// Last status reported by the Agent. Older events may omit it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<String>,
        /// ACP tool-call kind (`execute`/`read`/`edit`/`search`/`fetch`/…),
        /// preserved so the frontend can route to the right card even when the
        /// agent's title is free-form prose.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        kind: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input_preview: Option<String>,
        /// Free-form metadata (e.g. delegation binding).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        meta: Option<serde_json::Value>,
        /// Images returned by the tool call, such as files inspected by an
        /// Agent image-viewing tool.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<ImageData>,
        /// Wall-clock start from the first tool-call event. Missing stays missing.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        started_at: Option<DateTime<Utc>>,
        /// Wall-clock end from the terminal tool-call event.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ended_at: Option<DateTime<Utc>>,
    },
    ToolResult {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_use_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output_preview: Option<String>,
        is_error: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_stats: Option<AgentExecutionStats>,
    },
    /// First-class plan/todo checklist (e.g. Claude `TodoWrite`, Codex
    /// `update_plan`). Parsed from the tool input so the renderer can show a
    /// dedicated checklist instead of a generic tool card.
    Plan {
        entries: Vec<PlanEntry>,
    },
    Resource {
        uri: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
    },
    /// Lossless stand-in for protocol-only content (audio, embedded resource,
    /// resource-link, or a future ACP block). Not executable.
    Protocol {
        content: serde_json::Value,
    },
}

/// One step in a [`ContentBlock::Plan`] checklist.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PlanEntry {
    pub content: String,
    /// Normalized: `pending` | `in_progress` | `completed`.
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
}

/// The atomic rendered unit of a conversation: one role's contiguous output.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MessageTurn {
    pub id: String,
    pub role: TurnRole,
    pub blocks: Vec<ContentBlock>,
    pub timestamp: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<TurnUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Wall-clock end of the turn (NOT `timestamp + duration_ms`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
    /// Agent-stamped message id from ACP chunks, used to name a historical
    /// `session/fork` cut. Absent when the adapter never labelled the bubble.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_message_id: Option<String>,
}

/// Session-level rollups derived from a transcript.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SessionStats {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_usage: Option<TurnUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
    pub total_duration_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window_used_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window_max_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window_usage_percent: Option<f64>,
}

/// File-derived summary of a parsed conversation (the agent CLI session file is
/// the source of truth for history; the DB only stores metadata, added in a
/// later phase as `DbConversationSummary`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationSummary {
    pub id: String,
    pub agent_type: AgentKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub started_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<DateTime<Utc>>,
    pub message_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_tool_use_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delegation_call_id: Option<String>,
}

/// A fully parsed conversation: summary + ordered turns + rollup stats.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationDetail {
    pub summary: ConversationSummary,
    pub turns: Vec<MessageTurn>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_stats: Option<SessionStats>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(default)]
#[ts(export)]
pub struct AgentPromptCapabilities {
    pub text: bool,
    pub image: bool,
    pub audio: bool,
    pub resource: bool,
    pub resource_link: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AcpAuthenticationObservationSnapshot {
    pub state: crate::AuthenticationObservationState,
    pub method: crate::AuthenticationMethod,
    pub source: crate::AuthenticationSource,
    pub observed_at: String,
    pub capability_generation: u64,
    pub draft_revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic_code: Option<String>,
}

impl From<crate::AuthenticationObservation> for AcpAuthenticationObservationSnapshot {
    fn from(observation: crate::AuthenticationObservation) -> Self {
        Self {
            state: observation.state,
            method: observation.method,
            source: observation.source,
            observed_at: observation.observed_at.to_rfc3339(),
            capability_generation: observation.capability_generation,
            draft_revision: observation.draft_revision.to_string(),
            diagnostic_code: observation.diagnostic_code,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum DeliveryChannel {
    #[default]
    None,
    Native,
    Pull,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(default)]
#[ts(export)]
pub struct AcpCapabilitySnapshot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<String>,
    pub prompt: AgentPromptCapabilities,
    pub load_session: bool,
    pub resume_session: bool,
    pub close_session: bool,
    pub fork_session: bool,
    pub list_sessions: bool,
    pub delete_session: bool,
    /// Negotiated support for native `_session/steering`. True only when the
    /// adapter advertised the RPC, the agent has a `promptRequired` policy,
    /// and `initialize.agent_info.version` meets the floor. Codex never
    /// qualifies: it advertises steering with an empty `promptRequired` set.
    pub steering: bool,
    /// Per-session mid-turn delivery channel. Host-synthesized, never guessed
    /// from Agent identity. `none` when this session has neither native steering
    /// nor an injected `check_user_feedback` tool.
    #[serde(default)]
    pub delivery_channel: DeliveryChannel,
    pub terminal: bool,
    pub additional_directories: bool,
    pub filesystem_requests: bool,
    /// V1 `session/new` stdio MCP servers are the protocol baseline, not an
    /// Agent-identity exception. HTTP/SSE remain independently advertised.
    pub mcp_stdio: bool,
    pub mcp_http: bool,
    pub mcp_sse: bool,
    pub auth_logout: bool,
    pub auth_status: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authentication: Option<AcpAuthenticationObservationSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_meta: Option<serde_json::Value>,
    #[serde(default)]
    pub modes: Vec<AgentSessionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_mode: Option<String>,
    #[serde(default)]
    pub config_options: Vec<AgentSessionConfigOption>,
    #[serde(default)]
    pub available_commands: Vec<AgentAvailableCommand>,
}

impl AcpCapabilitySnapshot {
    pub fn accepts_session_mcp_servers(&self) -> bool {
        self.mcp_stdio || self.mcp_http || self.mcp_sse
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum ConversationInputBlock {
    Text {
        text: String,
    },
    Image {
        uri: String,
        mime_type: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
    },
    Resource {
        uri: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mime_type: Option<String>,
    },
    Protocol {
        content: serde_json::Value,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationPlanEntry {
    pub id: String,
    pub content: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationToolCallPatch {
    pub tool_call_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_input: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_output: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_output_append: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locations: Option<Vec<ConversationFileLocation>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    #[serde(default)]
    pub images: Vec<ImageData>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationFileLocation {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationPermissionRequest {
    pub permission_id: String,
    pub request: AgentPermissionRequest,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationPermissionResponse {
    pub response: AgentPermissionResponse,
    #[serde(default)]
    pub auto: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationQuestionRequest {
    pub question_id: String,
    pub prompt: String,
    #[serde(default)]
    pub options: Vec<String>,
    /// Wall-clock time when the agent asked the question. Optional so events
    /// written before this field existed remain readable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asked_at: Option<DateTime<Utc>>,
    /// ACP form-elicitation requested schema (JSON Schema with primitive-typed
    /// properties). When present the frontend renders a structured form; the
    /// plain `options` list is a degraded fallback.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationQuestionResponse {
    /// Human-readable one-line summary shown in the timeline.
    pub answer: String,
    /// Raw accepted form content keyed by property name; `None` for
    /// declined/cancelled answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationFeedbackRequest {
    pub feedback_id: String,
    pub prompt: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationFeedbackResponse {
    pub rating: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationTerminalPatch {
    pub terminal_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_summary: Option<String>,
    #[serde(default)]
    pub output_truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_status: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
    /// Tokens currently in the Agent context window (ACP `UsageUpdate.used`).
    /// This is occupancy, not an input-token count.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_used: Option<u64>,
    /// Context-window size reported by the agent (ACP usage `size`), when
    /// provided. None for agents that don't report a window.
    #[serde(default)]
    pub context_window_max: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_amount: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_currency: Option<String>,
    /// Model id the Agent named for this usage sample. Missing stays missing
    /// (ADR-0075); never inferred from the Agent kind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationFileChange {
    pub path: String,
    pub change_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub additions: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deletions: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationFileChangeSummary {
    pub source: String,
    #[serde(default)]
    pub files: Vec<ConversationFileChange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

/// Backend-owned turn-failure taxonomy (ADR-0074). Classification uses
/// protocol codes and structured `data` only — never free-text messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
#[ts(export)]
pub enum ConversationTurnErrorKind {
    Rejected,
    ServiceError,
    RateLimited,
    Cancelled,
    AuthRequired,
    ResourceNotFound,
    SessionResumeUnsupported,
    SessionLoadFailed,
    IdleTimeout,
    ConnectionClosed,
    PromptConflict,
    #[default]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, Default)]
#[ts(export)]
pub struct ConversationError {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<serde_json::Value>,
    #[serde(default)]
    pub kind: ConversationTurnErrorKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_usage: Option<crate::AgentPlanUsage>,
}

impl ConversationError {
    pub fn new(
        message: impl Into<String>,
        code: Option<String>,
        raw: Option<serde_json::Value>,
    ) -> Self {
        let message = message.into();
        let kind = classify_turn_error(code.as_deref(), raw.as_ref());
        Self {
            message,
            code,
            raw,
            kind,
            plan_usage: None,
        }
    }

    pub fn with_cached_plan_usage(mut self, agent_id: Option<&crate::AgentId>) -> Self {
        if let Some(agent_id) = agent_id {
            self.plan_usage = crate::cached_plan_usage(agent_id);
        }
        self
    }
}

/// Classify a turn failure from protocol/host evidence only.
///
/// `code` is the ACP/JSON-RPC or host-produced code. `raw` is `acp::Error.data`
/// or a host-built object. Message text is never consulted (ADR-0058 / ADR-0074).
pub fn classify_turn_error(
    code: Option<&str>,
    raw: Option<&serde_json::Value>,
) -> ConversationTurnErrorKind {
    if let Some(raw) = raw {
        if structured_http_status(raw) == Some(429) || structured_rate_limited(raw) {
            return ConversationTurnErrorKind::RateLimited;
        }
        if structured_auth_failed(raw) {
            return ConversationTurnErrorKind::AuthRequired;
        }
        if structured_http_status(raw).is_some_and(|status| (500..600).contains(&status)) {
            return ConversationTurnErrorKind::ServiceError;
        }
    }
    match code {
        Some("invalid_request" | "invalid_params") => ConversationTurnErrorKind::Rejected,
        Some("internal_error") => ConversationTurnErrorKind::ServiceError,
        Some("request_cancelled" | "cancelled") => ConversationTurnErrorKind::Cancelled,
        Some("auth_required") => ConversationTurnErrorKind::AuthRequired,
        Some("resource_not_found") => ConversationTurnErrorKind::ResourceNotFound,
        Some("session_resume_unsupported") => ConversationTurnErrorKind::SessionResumeUnsupported,
        Some(
            "session_load_failed" | "session_archived" | "session_busy" | "session_unavailable",
        ) => ConversationTurnErrorKind::SessionLoadFailed,
        Some("acp_session_not_bound") => ConversationTurnErrorKind::Unknown,
        Some("idle_timeout") => ConversationTurnErrorKind::IdleTimeout,
        Some("connection_closed" | "agent_connection_lost") => {
            ConversationTurnErrorKind::ConnectionClosed
        }
        Some("prompt_conflict") => ConversationTurnErrorKind::PromptConflict,
        _ => ConversationTurnErrorKind::Unknown,
    }
}

fn structured_http_status(raw: &serde_json::Value) -> Option<u16> {
    raw.get("http_status")
        .or_else(|| raw.get("status"))
        .and_then(serde_json::Value::as_u64)
        .and_then(|status| u16::try_from(status).ok())
}

fn structured_rate_limited(raw: &serde_json::Value) -> bool {
    raw.get("rate_limited").and_then(serde_json::Value::as_bool) == Some(true)
        || raw
            .get("retry_after_ms")
            .and_then(serde_json::Value::as_u64)
            .is_some()
        || raw
            .get("retry_after")
            .and_then(serde_json::Value::as_u64)
            .is_some()
}

fn structured_auth_failed(raw: &serde_json::Value) -> bool {
    if structured_http_status(raw) == Some(401) {
        return true;
    }
    matches!(
        raw.get("errorKind")
            .or_else(|| raw.get("error_kind"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("authentication_failed" | "auth_required" | "unauthorized")
    )
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum TurnBlockedReason {
    Permission { permission_id: String },
    Question { question_id: String },
    Authentication { message: String },
    Other { message: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum SessionRecoveryStrategy {
    Loaded,
    Resumed,
    CreatedNewSession,
    Rebound,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum SessionLoadFailureReason {
    ResourceNotFound,
    AuthenticationRequired {
        message: String,
    },
    Unsupported,
    SessionArchived {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        recovery_command: Option<String>,
    },
    SessionBusy,
    SessionUnavailable,
    Other {
        message: String,
    },
}

impl SessionLoadFailureReason {
    pub fn code(&self) -> &'static str {
        match self {
            Self::ResourceNotFound => "resource_not_found",
            Self::AuthenticationRequired { .. } => "auth_required",
            Self::Unsupported => "session_resume_unsupported",
            Self::SessionArchived { .. } => "session_archived",
            Self::SessionBusy => "session_busy",
            Self::SessionUnavailable => "session_unavailable",
            Self::Other { .. } => "session_load_failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
#[ts(export)]
pub enum ConversationAgentConnectionStatus {
    Connecting,
    Ready,
    Recovering,
    Error,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationDelegation {
    pub delegation_id: String,
    pub parent_tool_call_id: String,
    pub child_conversation_id: Uuid,
    #[serde(alias = "agent_type")]
    pub agent_id: AgentId,
    pub task_preview: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum ConversationDelegationResult {
    Ok {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text_preview: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
    },
    Err {
        error: ConversationError,
    },
}

/// Durable reference to one Artifact revision. The file remains the content
/// source of truth; this event payload intentionally carries no file bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationArtifactReference {
    pub artifact_id: Uuid,
    pub workspace_id: Option<Uuid>,
    pub relative_path: String,
    pub media_type: String,
    pub content_hash: String,
    pub revision: u64,
    pub plugin_id: String,
    pub plugin_version: String,
    pub provider_id: String,
    pub tool_lock_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationArtifactPreviewReference {
    pub artifact_id: Uuid,
    pub provider_id: String,
    pub lease_id: Uuid,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
#[allow(clippy::large_enum_variant)]
pub enum ConversationEvent {
    ConversationCreated {
        title: Option<String>,
    },
    ConversationInput {
        event: ConversationInputEvent,
    },
    ConversationSteering {
        event: ConversationSteeringEvent,
    },
    DeliveryChannelLatched {
        from: DeliveryChannel,
        to: DeliveryChannel,
    },
    UserSubmittedFeedback {
        note_id: Uuid,
        operation_id: Uuid,
        text: String,
        turn_id: Option<Uuid>,
    },
    UserFeedbackDelivered {
        note_id: Uuid,
        delivered_at: DateTime<Utc>,
    },
    UserFeedbackExpired {
        note_id: Uuid,
    },
    UserFeedbackSalvaged {
        note_id: Uuid,
        input_id: Uuid,
        operation_id: Uuid,
    },
    UserFeedbackDismissed {
        note_id: Uuid,
        operation_id: Uuid,
    },
    ConversationRelationCreated {
        relation_id: Uuid,
        parent_conversation_id: Uuid,
        child_conversation_id: Uuid,
        relation_kind: ConversationRelationKind,
        visibility: ConversationRelationVisibility,
        metadata: serde_json::Value,
    },
    AgentBindingStarted {
        #[serde(alias = "agent_type")]
        agent_id: AgentId,
        working_dir: String,
    },
    AgentBindingReady {
        acp_session_id: String,
        capabilities: AcpCapabilitySnapshot,
    },
    AgentBindingRecovered {
        strategy: SessionRecoveryStrategy,
        /// Previous Agent ACP id when this recovery minted a new thread in the
        /// same Conversation (Codeg `continues_from`). UI history stays one
        /// chain; the live binding is the new id.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        continues_from: Option<String>,
    },
    AgentBindingRecoveryFailed {
        reason: String,
    },
    AgentBindingLoadFailed {
        reason: SessionLoadFailureReason,
    },
    AgentConnectionStatusChanged {
        status: ConversationAgentConnectionStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(default)]
        bound: bool,
    },
    RequestActivityChanged {
        activity: crate::request_status::RequestActivity,
    },
    UserTurnCreated {
        blocks: Vec<ConversationInputBlock>,
        #[serde(
            default,
            skip_serializing_if = "Vec::is_empty",
            alias = "pluginActions"
        )]
        workflow_refs: Vec<ConversationWorkflowRef>,
    },
    UserTurnQueued,
    UserTurnStarted,
    AssistantTextDelta {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message_id: Option<String>,
    },
    AssistantReasoningDelta {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message_id: Option<String>,
    },
    AssistantContentAppended {
        block: ContentBlock,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message_id: Option<String>,
    },
    PlanUpdated {
        entries: Vec<ConversationPlanEntry>,
    },
    ToolCallUpsert {
        tool_call: ConversationToolCallPatch,
    },
    PermissionRequested {
        request: ConversationPermissionRequest,
    },
    PermissionResponded {
        permission_id: String,
        response: ConversationPermissionResponse,
    },
    QuestionRequested {
        request: ConversationQuestionRequest,
    },
    QuestionResponded {
        question_id: String,
        response: ConversationQuestionResponse,
    },
    FeedbackRequested {
        request: ConversationFeedbackRequest,
    },
    FeedbackSubmitted {
        feedback_id: String,
        response: ConversationFeedbackResponse,
    },
    TerminalUpdated {
        terminal: ConversationTerminalPatch,
    },
    UsageUpdated {
        usage: ConversationUsage,
    },
    FileChangeSummaryUpdated {
        summary: ConversationFileChangeSummary,
    },
    ArtifactRevisionRecorded {
        artifact: ConversationArtifactReference,
    },
    ArtifactPreviewOpened {
        preview: ConversationArtifactPreviewReference,
    },
    ArtifactPreviewClosed {
        preview: ConversationArtifactPreviewReference,
    },
    ArtifactPreviewFailed {
        artifact_id: Uuid,
        provider_id: String,
        message: String,
    },
    TurnBlocked {
        reason: TurnBlockedReason,
    },
    TurnCompleted {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stop_reason: Option<String>,
    },
    TurnFailed {
        error: ConversationError,
    },
    TurnCancelled {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    /// The host process died while this turn was in-flight (crash / kill / restart),
    /// so its generation is unrecoverable. The fourth terminal turn state — distinct
    /// from `TurnFailed` (agent error) and `TurnCancelled` (user request). Only the
    /// startup recovery coordinator appends this; it is never auto-retried. See
    /// ADR-0001.
    TurnInterrupted {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    SessionModeUpdated {
        current: Option<String>,
        modes: Vec<AgentSessionMode>,
    },
    SessionConfigOptionsUpdated {
        options: Vec<AgentSessionConfigOption>,
    },
    SessionConfigStale {
        stale: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    PromptCapabilitiesUpdated {
        capabilities: AgentPromptCapabilities,
    },
    AvailableCommandsUpdated {
        commands: Vec<AgentAvailableCommand>,
    },
    /// Agent-owned ACP session metadata. This must not mutate the VibeX
    /// conversation id or imply that the two identity domains are equivalent.
    AgentSessionInfoUpdated {
        patch: serde_json::Value,
    },
    DelegationStarted {
        delegation: ConversationDelegation,
    },
    DelegationCompleted {
        delegation_id: String,
        result: ConversationDelegationResult,
    },
    RawDiagnosticRecorded {
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payload: Option<serde_json::Value>,
    },
    AnnouncementsUpdated {
        #[serde(default)]
        generation: u64,
        notices: Vec<ConversationSessionNotice>,
    },
    SessionGoalUpdated {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        goal: Option<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        actions: Option<Vec<String>>,
    },
    AsyncTasksUpdated {
        tasks: Vec<crate::AsyncTaskRecord>,
    },
    PromptSuggestionUpdated {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        suggestion: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationEventEnvelope {
    pub id: Uuid,
    pub conversation_id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<Uuid>,
    pub sequence: i64,
    pub source: String,
    pub event: ConversationEvent,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationPermissionView {
    pub permission_id: String,
    pub title: Option<String>,
    pub status: String,
    /// Raw ACP permission detail (tool call info — e.g. file_edit diff, command,
    /// locations). Drives the in-card preview. `None` when the agent sent none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
    /// The selectable permission options (Allow / Allow-always / Reject …) the
    /// user picks from to answer the request.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<AgentPermissionOption>,
    /// Authoritative backend approval revision echoed back as `expected_revision`
    /// when the user submits a decision (docs/specs/agent-driver-engine.md §3.2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub revision: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationTerminalView {
    pub terminal_id: String,
    pub command: Option<String>,
    pub status: String,
    pub output_summary: Option<String>,
    pub output_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationErrorView {
    pub turn_id: Option<Uuid>,
    pub error: ConversationError,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationSessionNotice {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub severity: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub announcement_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<ConversationNoticeAction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_status: Option<crate::request_status::ConversationConnectionStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_status: Option<crate::request_status::ConversationRequestStatus>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum ConversationNoticeAction {
    UpdateAgent {
        agent_id: AgentId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fallback_url: Option<String>,
    },
    OpenUrl {
        url: String,
        label: String,
    },
    CopyCommand {
        command: String,
        label: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationDelegationView {
    pub delegation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub child_conversation_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<AgentId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_preview: Option<String>,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<ConversationDelegationResult>,
}

#[path = "conversation_wire.rs"]
mod wire;
pub use wire::*;

#[cfg(test)]
#[path = "conversation_tests.rs"]
mod event_sourced_tests;
