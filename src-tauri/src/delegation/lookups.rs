//! Read-only lookups the broker needs, backed by the `Session` model + runtime.

use std::sync::Arc;

use agents::{AgentKind, ids::AgentConnectionId, runtime::AgentRuntime};
use async_trait::async_trait;
use db::models::session::{Session, SessionStatus};
use delegation::{
    ChildStatusLookup, ChildStatusRecord, DelegationError, DepthLookup, ParentSessionLookup,
    TaskStatus,
};
use sqlx::SqlitePool;
use uuid::Uuid;

/// Walks `sessions.parent_session_id` for delegation-depth computation.
pub(crate) struct DbDepthLookup {
    pub pool: SqlitePool,
}

#[async_trait]
impl DepthLookup for DbDepthLookup {
    async fn parent_session_id(&self, id: Uuid) -> Result<Option<Uuid>, DelegationError> {
        match Session::find_by_id(&self.pool, id).await {
            Ok(Some(session)) => Ok(session.parent_session_id),
            Ok(None) => Ok(None),
            Err(err) => Err(DelegationError::SubagentRuntimeError(err.to_string())),
        }
    }
}

/// Recovers a child's terminal status from the DB after the broker's in-memory
/// result cache evicted it.
pub(crate) struct DbChildStatusLookup {
    pub pool: SqlitePool,
}

#[async_trait]
impl ChildStatusLookup for DbChildStatusLookup {
    async fn status_by_call_id(&self, call_id: &str) -> Option<ChildStatusRecord> {
        let session = Session::find_by_delegation_call_id(&self.pool, call_id)
            .await
            .ok()??;
        Some(ChildStatusRecord {
            child_session_id: session.id,
            status: map_status(&session.status),
            agent_type: session
                .agent_type
                .as_deref()
                .and_then(AgentKind::from_lenient),
        })
    }
}

/// Resolves a parent connection's current session id from the runtime snapshot.
pub(crate) struct RuntimeParentLookup {
    pub runtime: Arc<AgentRuntime>,
}

#[async_trait]
impl ParentSessionLookup for RuntimeParentLookup {
    async fn current_session_id(&self, parent_connection_id: &str) -> Option<Uuid> {
        let conn = AgentConnectionId::from(Uuid::parse_str(parent_connection_id).ok()?);
        let snapshot = self.runtime.snapshot().await;
        snapshot
            .sessions
            .iter()
            .filter(|session| session.connection_id == conn)
            .max_by_key(|session| session.updated_at)
            .map(|session| session.id.0)
    }
}

fn map_status(status: &SessionStatus) -> TaskStatus {
    match status {
        SessionStatus::Done => TaskStatus::Completed,
        SessionStatus::Archived => TaskStatus::Canceled,
        _ => TaskStatus::Running,
    }
}
