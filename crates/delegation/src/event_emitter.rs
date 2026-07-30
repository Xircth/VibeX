//! Emits delegation lifecycle events onto the parent connection's event stream.
//! The `src-tauri` implementation maps these onto
//! `AgentEvent::DelegationStarted` / `DelegationCompleted`, which reach the
//! frontend via the `agent-events` Tauri channel.

use agents::AgentId;
use async_trait::async_trait;
use uuid::Uuid;

use crate::types::DelegationOutcome;

/// Fired once after the child is spawned and its first prompt sent.
#[derive(Debug, Clone)]
pub struct DelegationStartedEvent {
    pub parent_connection_id: String,
    pub parent_tool_use_id: String,
    pub child_session_id: Uuid,
    pub agent_type: AgentId,
    pub task_preview: String,
}

/// Fired for every terminal resolution (success, error, cancel).
#[derive(Debug, Clone)]
pub struct DelegationCompletedEvent {
    pub parent_connection_id: String,
    pub parent_tool_use_id: String,
    pub child_session_id: Uuid,
    pub agent_type: AgentId,
    pub outcome: DelegationOutcome,
}

#[async_trait]
pub trait DelegationEventEmitter: Send + Sync {
    async fn emit_started(&self, event: DelegationStartedEvent);
    async fn emit_completed(&self, event: DelegationCompletedEvent);
}
