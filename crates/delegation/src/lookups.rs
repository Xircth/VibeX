//! Read-only DB lookups the broker needs: parent-chain walking for depth, and
//! terminal-status recovery after the in-memory result cache evicts a task.

use agents::AgentId;
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
    pub parent_conversation_id: Option<Uuid>,
    pub status: TaskStatus,
    pub agent_type: Option<AgentId>,
}

/// Looks a delegated child up by the broker task id
/// (`sessions.delegation_call_id`).
#[async_trait]
pub trait ChildStatusLookup: Send + Sync {
    async fn status_by_call_id(&self, call_id: &str) -> Option<ChildStatusRecord>;
}

/// Confirms that a token's durable Conversation belongs to the live parent
/// connection. Connections may host more than one session, so callers must not
/// infer authority from the most recently updated session.
#[async_trait]
pub trait ParentSessionLookup: Send + Sync {
    async fn contains_session(&self, parent_connection_id: &str, conversation_id: Uuid) -> bool;
}
