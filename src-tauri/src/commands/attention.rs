//! Cross-workspace attention inbox DTOs exported to TypeScript.

use serde::Serialize;
use ts_rs::TS;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[ts(use_ts_enum)]
pub enum AttentionItemKind {
    /// Agent is blocked on a permission decision — highest priority.
    PendingPermission,
    /// Agent is blocked on a question to the user.
    PendingQuestion,
    /// Session surfaced a notice, warning, or error.
    SessionNotice,
    /// Latest turn completed and may still need a look.
    TurnCompleted,
    /// Latest turn failed; needs a retry or a follow-up.
    TurnFailed,
    /// Latest turn was interrupted by a host crash/restart; never auto-resent.
    TurnInterrupted,
    /// Agent finished; the change is waiting for human review.
    InReview,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AttentionItem {
    pub kind: AttentionItemKind,
    pub session_id: Uuid,
    pub workspace_id: Uuid,
    pub task_id: Uuid,
    pub project_id: Uuid,
    pub project_name: String,
    pub session_name: Option<String>,
    pub agent_type: Option<String>,
    pub detail: Option<String>,
    #[ts(type = "number | null")]
    pub happened_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AttentionInbox {
    /// Sorted: blocking items first (permission, question), then failures,
    /// then review; newest first within each kind.
    pub items: Vec<AttentionItem>,
    /// Number of items actively blocking an agent right now.
    #[ts(type = "number")]
    pub blocking_count: u32,
}
