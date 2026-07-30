//! Read-only lookups the broker needs, backed by the `Session` model + runtime.

use std::sync::Arc;

use agents::{
    conversation::{ConversationDelegationResult, ConversationEvent},
    ids::AgentConnectionId,
    runtime::AgentRuntime,
};
use async_trait::async_trait;
use db::models::session::Session;
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
        let status = match session.parent_session_id {
            Some(parent_conversation_id) => sqlx::query_scalar::<_, String>(
                r#"SELECT normalized_json
                       FROM conversation_events
                       WHERE conversation_id = ?
                         AND event_kind = 'delegation_completed'
                         AND json_extract(normalized_json, '$.delegation_id') = ?
                       ORDER BY sequence DESC
                       LIMIT 1"#,
            )
            .bind(parent_conversation_id)
            .bind(call_id)
            .fetch_optional(&self.pool)
            .await
            .ok()
            .flatten()
            .and_then(|json| serde_json::from_str::<ConversationEvent>(&json).ok())
            .and_then(|event| match event {
                ConversationEvent::DelegationCompleted { result, .. } => Some(match result {
                    ConversationDelegationResult::Ok { .. } => TaskStatus::Completed,
                    ConversationDelegationResult::Err { error }
                        if error.code.as_deref() == Some("canceled") =>
                    {
                        TaskStatus::Canceled
                    }
                    ConversationDelegationResult::Err { .. } => TaskStatus::Failed,
                }),
                _ => None,
            })
            .unwrap_or(TaskStatus::Running),
            None => TaskStatus::Running,
        };
        Some(ChildStatusRecord {
            child_session_id: session.id,
            parent_conversation_id: session.parent_session_id,
            status,
            agent_type: session.agent_id,
        })
    }
}

/// Resolves a parent connection's current session id from the runtime snapshot.
pub(crate) struct RuntimeParentLookup {
    pub runtime: Arc<AgentRuntime>,
}

#[async_trait]
impl ParentSessionLookup for RuntimeParentLookup {
    async fn contains_session(&self, parent_connection_id: &str, conversation_id: Uuid) -> bool {
        let Ok(parent_connection_id) = Uuid::parse_str(parent_connection_id) else {
            return false;
        };
        let conn = AgentConnectionId::from(parent_connection_id);
        let snapshot = self.runtime.snapshot().await;
        snapshot
            .sessions
            .iter()
            .any(|session| session.connection_id == conn && session.id.0 == conversation_id)
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use agents::conversation::{ConversationError, ConversationEvent};
    use db::models::{
        conversation_event::{AppendConversationEvent, ConversationEventRecord},
        session::{CreateSession, SessionStatus},
    };
    use delegation::{ChildStatusLookup, TaskStatus};
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::*;

    async fn setup_pool() -> SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .unwrap()
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::migrate!("../crates/db/migrations")
            .run(&pool)
            .await
            .unwrap();
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    #[tokio::test]
    async fn db_fallback_uses_delegation_terminal_event_not_legacy_session_status() {
        let pool = setup_pool().await;
        let workspace_id = Uuid::new_v4();
        let parent_id = Uuid::new_v4();
        let child_id = Uuid::new_v4();
        let call_id = "delegation-1";
        let session = CreateSession {
            executor: None,
            agent_id: None,
            task_id: None,
            name: None,
            initial_prompt: None,
            status: Some(SessionStatus::InProgress),
        };
        Session::create(&pool, &session, parent_id, workspace_id)
            .await
            .unwrap();
        Session::create_with_delegation(
            &pool,
            &session,
            child_id,
            workspace_id,
            parent_id,
            "tool-1",
            call_id,
        )
        .await
        .unwrap();
        let event = ConversationEvent::DelegationCompleted {
            delegation_id: call_id.to_string(),
            result: ConversationDelegationResult::Err {
                error: ConversationError {
                    message: "canceled".to_string(),
                    code: Some("canceled".to_string()),
                    raw: None,
                },
            },
        };
        let normalized = serde_json::to_string(&event).unwrap();
        ConversationEventRecord::append(
            &pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id: parent_id,
                turn_id: None,
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                source: "runtime",
                event_kind: "delegation_completed",
                normalized_json: &normalized,
                raw_json: None,
                idempotency_key: None,
            },
        )
        .await
        .unwrap();

        let record = DbChildStatusLookup { pool }
            .status_by_call_id(call_id)
            .await
            .unwrap();

        assert_eq!(record.child_session_id, child_id);
        assert_eq!(record.status, TaskStatus::Canceled);
    }
}
