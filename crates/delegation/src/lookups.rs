//! Read-only DB lookups the broker needs: parent-chain walking for depth, and
//! terminal-status recovery after the in-memory result cache evicts a task.

use agents::registry::AgentType;
use async_trait::async_trait;
use uuid::Uuid;

use crate::types::{DelegationError, TaskStatus};

/// Resolves a session's parent for delegation-depth computation (walks
/// `sessions.parent_session_id`).
#[async_trait]
pub trait DepthLookup: Send + Sync {
    async fn parent_session_id(&self, session_id: Uuid) -> Result<Option<Uuid>, DelegationError>;
}

/// A child's persisted terminal status, recovered after the broker's in-memory
/// result cache evicted it. Status only — the full text lives in the child
/// session.
#[derive(Debug, Clone)]
pub struct ChildStatusRecord {
    pub child_session_id: Uuid,
    pub status: TaskStatus,
    pub agent_type: Option<AgentType>,
}

/// Looks a delegated child up by the broker task id
/// (`sessions.delegation_call_id`).
#[async_trait]
pub trait ChildStatusLookup: Send + Sync {
    async fn status_by_call_id(&self, call_id: &str) -> Option<ChildStatusRecord>;
}

/// Resolves the session a delegation is being issued from: the parent
/// connection's currently-active `sessions.id`.
#[async_trait]
pub trait ParentSessionLookup: Send + Sync {
    async fn current_session_id(&self, parent_connection_id: &str) -> Option<Uuid>;
}
