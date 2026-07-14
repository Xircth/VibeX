//! Unified conversation transcript model.
//!
//! This is the single data vocabulary that both the live (ACP event) stream and
//! the persisted (agent session-file parse) transcript converge on, so the
//! frontend renderer never has to branch on whether a turn is live. A turn is
//! the atomic, role-homogeneous unit; its ordered `blocks` carry the content.
//!
//! Aligned to the codeg reference architecture (Apache-2.0); the Rust types
//! here are VibeX-authored.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::{
    events::{AgentAvailableCommand, AgentSessionConfigOption, AgentSessionMode},
    permissions::{AgentPermissionOption, AgentPermissionRequest, AgentPermissionResponse},
    registry::AgentKind,
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

/// Token accounting for a single turn.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TurnUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
    /// Context-window size reported by the agent (ACP usage `size`), when
    /// provided. None for agents/transcripts that don't report a window.
    #[serde(default)]
    pub context_window_max: Option<u64>,
}

/// A base64-encoded image payload referenced by image content blocks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ImageData {
    pub data: String,
    pub mime_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input_preview: Option<String>,
        /// Free-form metadata (e.g. delegation binding).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        meta: Option<serde_json::Value>,
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
#[ts(export)]
pub struct AgentPromptCapabilities {
    pub text: bool,
    pub image: bool,
    pub resource: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AcpCapabilitySnapshot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<String>,
    pub prompt: AgentPromptCapabilities,
    pub load_session: bool,
    pub resume_session: bool,
    pub close_session: bool,
    pub terminal: bool,
    pub additional_directories: bool,
    pub filesystem_requests: bool,
    pub mcp_servers: bool,
    pub permission_requests: bool,
    #[serde(default)]
    pub modes: Vec<AgentSessionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_mode: Option<String>,
    #[serde(default)]
    pub config_options: Vec<AgentSessionConfigOption>,
    #[serde(default)]
    pub available_commands: Vec<AgentAvailableCommand>,
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

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
    /// Context-window size reported by the agent (ACP usage `size`), when
    /// provided. None for agents that don't report a window.
    #[serde(default)]
    pub context_window_max: Option<u64>,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationError {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<serde_json::Value>,
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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum SessionLoadFailureReason {
    ResourceNotFound,
    AuthenticationRequired { message: String },
    Unsupported,
    Other { message: String },
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
    pub agent_type: AgentKind,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
#[allow(clippy::large_enum_variant)]
pub enum ConversationEvent {
    ConversationCreated {
        title: Option<String>,
    },
    AgentBindingStarted {
        agent_type: AgentKind,
        working_dir: String,
    },
    AgentBindingReady {
        acp_session_id: String,
        capabilities: AcpCapabilitySnapshot,
    },
    AgentBindingRecovered {
        strategy: SessionRecoveryStrategy,
    },
    AgentBindingRecoveryFailed {
        reason: String,
    },
    AgentBindingLoadFailed {
        reason: SessionLoadFailureReason,
    },
    AgentConnectionStatusChanged {
        status: ConversationAgentConnectionStatus,
    },
    UserTurnCreated {
        blocks: Vec<ConversationInputBlock>,
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
    DelegationStarted {
        delegation: ConversationDelegation,
    },
    DelegationCompleted {
        delegation_id: String,
        result: ConversationDelegationResult,
    },
    RawDiagnosticRecorded {
        label: String,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationSessionNotice {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub severity: String,
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
    pub agent_type: Option<AgentKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_preview: Option<String>,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<ConversationDelegationResult>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum ConversationTimelineRow {
    MessageTurn {
        turn: MessageTurn,
        phase: String,
    },
    PermissionRequest {
        request: ConversationPermissionView,
    },
    QuestionRequest {
        request: ConversationQuestionRequest,
        /// Folded from a later `QuestionResponded` event. `None` while still pending;
        /// `Some` once answered — so a rebuilt projection no longer shows answered
        /// questions as perpetually pending.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        response: Option<ConversationQuestionResponse>,
    },
    FeedbackRequest {
        request: ConversationFeedbackRequest,
        /// Folded from a later `FeedbackSubmitted` event. `None` while still pending.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        response: Option<ConversationFeedbackResponse>,
    },
    TerminalSummary {
        terminal: ConversationTerminalView,
    },
    Delegation {
        delegation: ConversationDelegationView,
    },
    FileChangeSummary {
        summary: ConversationFileChangeSummary,
        /// Turn that produced this diff summary (checkpoint diff), so the
        /// timeline can anchor the card at the end of its own turn.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<Uuid>,
    },
    TurnError {
        error: ConversationErrorView,
    },
    SessionNotice {
        notice: ConversationSessionNotice,
    },
}

/// A timeline row plus the incremental-projection metadata that lets the frontend
/// consume it as a dumb container (消灭双投影). `row_id` is stable per row; `revision`
/// is the sequence of the latest event that produced this row's current state
/// (monotonic per row), used for idempotent upsert/append dedup.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TimelineRow {
    pub row_id: String,
    pub revision: i64,
    pub row: ConversationTimelineRow,
}

/// Which streaming text field an [`ConversationRowOp::AppendText`] targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum TimelineTextStream {
    Text,
    Reasoning,
}

/// One operation the frontend applies to its dumb row container. The backend is the
/// single projector; the frontend never folds events.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "op", rename_all = "snake_case")]
#[ts(export)]
// `Upsert` carries a full `TimelineRow` (a large enum); `AppendText` is small. These
// ops are streamed one at a time, so the size gap costs nothing — boxing would just
// churn the wire format.
#[allow(clippy::large_enum_variant)]
pub enum ConversationRowOp {
    /// Insert or replace a whole row (new row, status change, tool-call update…).
    /// Applying it clears any accumulated live text for the row.
    Upsert { row: TimelineRow },
    /// Append a streaming text chunk to a row's live-text overlay — sent per delta so
    /// long replies don't re-broadcast the full text each frame (O(n²)).
    AppendText {
        row_id: String,
        revision: i64,
        stream: TimelineTextStream,
        delta: String,
    },
}

/// A batch of row ops for one conversation, emitted on the realtime channel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationRowOpBatch {
    pub conversation_id: Uuid,
    pub last_sequence: i64,
    pub ops: Vec<ConversationRowOp>,
    /// Latest agent-advertised session modes carried in this batch, if any. Session
    /// control state isn't a timeline row, so it rides alongside the row ops rather
    /// than on a separate channel.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_modes: Option<ConversationSessionModes>,
    /// Latest agent-advertised config options carried in this batch, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_config_options: Option<Vec<AgentSessionConfigOption>>,
}

/// Agent-advertised session modes (current + available), delivered with a row-op batch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationSessionModes {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
    pub modes: Vec<AgentSessionMode>,
}

/// Gap-backfill result: the timeline rows whose state changed after `after_sequence`
/// (revision > after_sequence). The gap path now pulls rows, not raw events.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationRowPage {
    pub conversation_id: Uuid,
    pub after_sequence: i64,
    pub last_sequence: i64,
    pub rows: Vec<TimelineRow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationTimeline {
    pub conversation_id: Uuid,
    pub projection_version: u32,
    pub last_sequence: i64,
    pub rows: Vec<TimelineRow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationEventsPage {
    pub conversation_id: Uuid,
    pub after_sequence: i64,
    pub last_sequence: i64,
    pub has_more: bool,
    pub events: Vec<ConversationEventEnvelope>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationTimelinePage {
    pub conversation_id: Uuid,
    pub projection_version: u32,
    pub cursor: Option<String>,
    pub next_cursor: Option<String>,
    pub rows: Vec<TimelineRow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationBundleManifest {
    pub bundle_version: String,
    pub export_app_version: String,
    pub exported_at: DateTime<Utc>,
    pub source_platform: String,
    pub conversation_ids: Vec<Uuid>,
    pub projection_version: u32,
    pub checksums: Vec<ConversationBundleChecksum>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationBundleChecksum {
    pub path: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationBundlePayload {
    pub manifest: ConversationBundleManifest,
    pub conversations_json: serde_json::Value,
    pub bindings_json: serde_json::Value,
    pub turns_json: serde_json::Value,
    pub events_jsonl: String,
    pub tool_calls_json: serde_json::Value,
    pub file_changes_json: serde_json::Value,
    pub permissions_json: serde_json::Value,
    pub terminals_json: serde_json::Value,
    pub checkpoints_json: serde_json::Value,
}

#[cfg(test)]
mod event_sourced_tests {
    use super::*;

    #[test]
    fn capability_snapshot_defaults_are_degraded() {
        let snapshot = AcpCapabilitySnapshot::default();

        assert!(!snapshot.load_session);
        assert!(!snapshot.resume_session);
        assert!(!snapshot.close_session);
        assert!(!snapshot.terminal);
        assert!(!snapshot.prompt.text);
    }

    #[test]
    fn conversation_event_round_trips_codeg_coverage_cases() {
        let events = vec![
            ConversationEvent::QuestionRequested {
                request: ConversationQuestionRequest {
                    question_id: "q1".to_string(),
                    prompt: "Continue?".to_string(),
                    options: vec!["yes".to_string(), "no".to_string()],
                    schema: None,
                },
            },
            ConversationEvent::FeedbackRequested {
                request: ConversationFeedbackRequest {
                    feedback_id: "f1".to_string(),
                    prompt: "Rate this".to_string(),
                },
            },
            ConversationEvent::DelegationStarted {
                delegation: ConversationDelegation {
                    delegation_id: "d1".to_string(),
                    parent_tool_call_id: "tool1".to_string(),
                    child_conversation_id: Uuid::new_v4(),
                    agent_type: AgentKind::Codex,
                    task_preview: "child work".to_string(),
                },
            },
            ConversationEvent::SessionConfigStale {
                stale: true,
                reason: Some("config changed".to_string()),
            },
            ConversationEvent::PromptCapabilitiesUpdated {
                capabilities: AgentPromptCapabilities {
                    text: true,
                    image: true,
                    resource: false,
                },
            },
            ConversationEvent::AgentBindingLoadFailed {
                reason: SessionLoadFailureReason::ResourceNotFound,
            },
        ];

        for event in events {
            let value = serde_json::to_value(&event).expect("serialize event");
            assert!(value["kind"].as_str().is_some());
            let roundtrip: ConversationEvent =
                serde_json::from_value(value).expect("deserialize event");
            assert_eq!(roundtrip, event);
        }
    }
}
