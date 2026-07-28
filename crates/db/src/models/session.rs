use api_types::AgentKind;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool, Type};
use strum_macros::{Display, EnumString};
use thiserror::Error;
use ts_rs::TS;
use uuid::Uuid;

#[derive(
    Debug, Clone, Type, Serialize, Deserialize, PartialEq, TS, EnumString, Display, Default,
)]
#[sqlx(type_name = "session_status", rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase")]
pub enum SessionStatus {
    #[default]
    Todo,
    InProgress,
    InReview,
    Done,
    Archived,
}

#[derive(Debug, Error)]
pub enum SessionError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error("Session not found")]
    NotFound,
    #[error("Workspace not found")]
    WorkspaceNotFound,
    #[error("Executor mismatch: session uses {expected} but request specified {actual}")]
    ExecutorMismatch { expected: String, actual: String },
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
pub struct Session {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub task_id: Option<Uuid>,
    pub name: Option<String>,
    pub initial_prompt: Option<String>,
    pub status: SessionStatus,
    /// Legacy executor key (架构报告 A-6), superseded by `agent_type`. Retained
    /// read-mostly for the executor↔agent_type cutover; new ACP sessions are identified
    /// by `agent_type`. Prefer `agent_type` for agent identity, bridging legacy values
    /// through `AgentKind::from_lenient` when needed.
    pub executor: Option<String>,
    pub external_session_id: Option<String>,
    /// Canonical ACP agent identity (the executor↔agent_type successor to `executor`).
    pub agent_type: Option<String>,
    /// Multi-agent delegation linkage. All NULL for a regular (non-delegated)
    /// session: `parent_session_id` points at the parent that delegated this
    /// child, `parent_tool_use_id` is the parent's `delegate_to_agent` tool-call
    /// id, `delegation_call_id` is the broker's internal task id.
    pub parent_session_id: Option<Uuid>,
    pub parent_tool_use_id: Option<String>,
    pub delegation_call_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize, TS)]
pub struct CreateSession {
    pub executor: Option<String>,
    pub task_id: Option<Uuid>,
    pub name: Option<String>,
    pub initial_prompt: Option<String>,
    pub status: Option<SessionStatus>,
}

impl Session {
    pub async fn find_by_id(pool: &SqlitePool, id: Uuid) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Session>(
            r#"SELECT id,
                      workspace_id,
                      task_id,
                      name,
                      initial_prompt,
                      status,
                      executor,
                      external_session_id,
                      agent_type,
                      parent_session_id,
                      parent_tool_use_id,
                      delegation_call_id,
                      created_at,
                      updated_at
               FROM sessions
               WHERE id = ?"#,
        )
        .bind(id)
        .fetch_optional(pool)
        .await
    }

    pub async fn find_by_task_id(
        pool: &SqlitePool,
        task_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Session>(
            r#"SELECT id,
                      workspace_id,
                      task_id,
                      name,
                      initial_prompt,
                      status,
                      executor,
                      external_session_id,
                      agent_type,
                      parent_session_id,
                      parent_tool_use_id,
                      delegation_call_id,
                      created_at,
                      updated_at
               FROM sessions
               WHERE task_id = ?
               ORDER BY updated_at DESC, created_at DESC"#,
        )
        .bind(task_id)
        .fetch_all(pool)
        .await
    }

    /// Find all sessions for a workspace, ordered by recent session activity.
    pub async fn find_by_workspace_id(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Session>(
            r#"SELECT s.id,
                      s.workspace_id,
                      s.task_id,
                      s.name,
                      s.initial_prompt,
                      s.status,
                      s.executor,
                      s.external_session_id,
                      s.agent_type,
                      s.parent_session_id,
                      s.parent_tool_use_id,
                      s.delegation_call_id,
                      s.created_at,
                      s.updated_at
               FROM sessions s
               WHERE s.workspace_id = ?
               ORDER BY s.updated_at DESC,
                        s.created_at DESC"#,
        )
        .bind(workspace_id)
        .fetch_all(pool)
        .await
    }

    pub async fn find_latest_by_workspace_id(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Session>(
            r#"SELECT s.id,
                      s.workspace_id,
                      s.task_id,
                      s.name,
                      s.initial_prompt,
                      s.status,
                      s.executor,
                      s.external_session_id,
                      s.agent_type,
                      s.parent_session_id,
                      s.parent_tool_use_id,
                      s.delegation_call_id,
                      s.created_at,
                      s.updated_at
               FROM sessions s
               WHERE s.workspace_id = ?
               ORDER BY s.updated_at DESC,
                        s.created_at DESC
               LIMIT 1"#,
        )
        .bind(workspace_id)
        .fetch_optional(pool)
        .await
    }

    pub async fn create(
        pool: &SqlitePool,
        data: &CreateSession,
        id: Uuid,
        workspace_id: Uuid,
    ) -> Result<Self, SessionError> {
        let agent_type = data
            .executor
            .as_deref()
            .and_then(AgentKind::from_lenient)
            .map(|agent| agent.as_str().to_string());
        sqlx::query_as::<_, Session>(
            r#"INSERT INTO sessions (id, workspace_id, task_id, name, initial_prompt, status, executor,
                                     agent_type)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               RETURNING id,
                         workspace_id,
                         task_id,
                         name,
                         initial_prompt,
                         status,
                         executor,
                         external_session_id,
                         agent_type,
                         parent_session_id,
                         parent_tool_use_id,
                         delegation_call_id,
                         created_at,
                         updated_at"#,
        )
        .bind(id)
        .bind(workspace_id)
        .bind(data.task_id)
        .bind(data.name.as_deref().filter(|name| !name.trim().is_empty()))
        .bind(
            data.initial_prompt
                .as_deref()
                .filter(|prompt| !prompt.trim().is_empty()),
        )
        .bind(data.status.clone().unwrap_or_default())
        .bind(data.executor.clone())
        .bind(agent_type)
        .fetch_one(pool)
        .await
        .map_err(SessionError::from)
    }

    /// Create a child session produced by a `delegate_to_agent` call, linked
    /// back to the parent session, the parent's tool-call id, and the broker's
    /// delegation task id. Mirrors [`Session::create`] but also persists the
    /// three delegation columns; `agent_type` is set later via
    /// [`Session::update_agent_metadata`] once the child ACP session attaches.
    #[allow(clippy::too_many_arguments)]
    pub async fn create_with_delegation(
        pool: &SqlitePool,
        data: &CreateSession,
        id: Uuid,
        workspace_id: Uuid,
        parent_session_id: Uuid,
        parent_tool_use_id: &str,
        delegation_call_id: &str,
    ) -> Result<Self, SessionError> {
        sqlx::query_as::<_, Session>(
            r#"INSERT INTO sessions (id, workspace_id, task_id, name, initial_prompt, status, executor,
                                     parent_session_id, parent_tool_use_id, delegation_call_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               RETURNING id,
                         workspace_id,
                         task_id,
                         name,
                         initial_prompt,
                         status,
                         executor,
                         external_session_id,
                         agent_type,
                         parent_session_id,
                         parent_tool_use_id,
                         delegation_call_id,
                         created_at,
                         updated_at"#,
        )
        .bind(id)
        .bind(workspace_id)
        .bind(data.task_id)
        .bind(data.name.as_deref().filter(|name| !name.trim().is_empty()))
        .bind(
            data.initial_prompt
                .as_deref()
                .filter(|prompt| !prompt.trim().is_empty()),
        )
        .bind(data.status.clone().unwrap_or_default())
        .bind(data.executor.clone())
        .bind(parent_session_id)
        .bind(parent_tool_use_id)
        .bind(delegation_call_id)
        .fetch_one(pool)
        .await
        .map_err(SessionError::from)
    }

    /// Look up a session by the broker delegation task id (`delegation_call_id`).
    /// Used to recover a delegated child's terminal status after the broker's
    /// in-memory result cache has evicted it.
    pub async fn find_by_delegation_call_id(
        pool: &SqlitePool,
        delegation_call_id: &str,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Session>(
            r#"SELECT id,
                      workspace_id,
                      task_id,
                      name,
                      initial_prompt,
                      status,
                      executor,
                      external_session_id,
                      agent_type,
                      parent_session_id,
                      parent_tool_use_id,
                      delegation_call_id,
                      created_at,
                      updated_at
               FROM sessions
               WHERE delegation_call_id = ?"#,
        )
        .bind(delegation_call_id)
        .fetch_optional(pool)
        .await
    }

    pub async fn update_executor(
        pool: &SqlitePool,
        id: Uuid,
        executor: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"UPDATE sessions
               SET executor = ?, updated_at = datetime('now', 'subsec')
               WHERE id = ?"#,
        )
        .bind(executor)
        .bind(id)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn update_agent_metadata(
        pool: &SqlitePool,
        id: Uuid,
        external_session_id: Option<&str>,
        agent_type: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"UPDATE sessions
               SET external_session_id = ?,
                   agent_type = ?,
                   updated_at = datetime('now', 'subsec')
               WHERE id = ?"#,
        )
        .bind(external_session_id.filter(|value| !value.trim().is_empty()))
        .bind(agent_type.filter(|value| !value.trim().is_empty()))
        .bind(id)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn update_name(
        pool: &SqlitePool,
        id: Uuid,
        name: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"UPDATE sessions
               SET name = ?, updated_at = datetime('now', 'subsec')
               WHERE id = ?"#,
        )
        .bind(name.filter(|value| !value.trim().is_empty()))
        .bind(id)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn update_status(
        pool: &SqlitePool,
        id: Uuid,
        status: SessionStatus,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"UPDATE sessions
               SET status = ?, updated_at = datetime('now', 'subsec')
               WHERE id = ?"#,
        )
        .bind(status)
        .bind(id)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn delete(pool: &SqlitePool, id: Uuid) -> Result<u64, sqlx::Error> {
        let result = sqlx::query(r#"DELETE FROM sessions WHERE id = ?"#)
            .bind(id)
            .execute(pool)
            .await?;

        Ok(result.rows_affected())
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::*;

    /// In-memory pool running the full migration chain against a single
    /// connection. Foreign keys are disabled so a session row can be inserted
    /// without standing up the whole workspace/project graph — these tests only
    /// exercise the delegation columns, not FK enforcement.
    async fn setup_pool() -> SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("sqlite options")
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("connect memory db");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        // Table-rebuild migrations leave `foreign_keys` ON; turn it back off so
        // a session row can be inserted without the full workspace/project graph.
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("disable foreign keys");
        pool
    }

    fn sample(executor: &str) -> CreateSession {
        CreateSession {
            executor: Some(executor.to_string()),
            task_id: None,
            name: None,
            initial_prompt: None,
            status: None,
        }
    }

    #[tokio::test]
    async fn delegation_columns_default_null_for_regular_session() {
        let pool = setup_pool().await;
        let session = Session::create(
            &pool,
            &sample("CLAUDE_CODE"),
            Uuid::new_v4(),
            Uuid::new_v4(),
        )
        .await
        .expect("create session");

        assert!(session.parent_session_id.is_none());
        assert!(session.parent_tool_use_id.is_none());
        assert!(session.delegation_call_id.is_none());
    }

    #[tokio::test]
    async fn regular_session_persists_canonical_agent_identity_before_first_turn() {
        let pool = setup_pool().await;
        let session = Session::create(&pool, &sample("CODEX"), Uuid::new_v4(), Uuid::new_v4())
            .await
            .expect("create session");

        assert_eq!(session.agent_type.as_deref(), Some("codex"));
    }

    #[tokio::test]
    async fn create_with_delegation_links_parent_and_is_findable_by_call_id() {
        let pool = setup_pool().await;
        let workspace_id = Uuid::new_v4();
        let parent_id = Uuid::new_v4();
        let child_id = Uuid::new_v4();

        Session::create(&pool, &sample("CLAUDE_CODE"), parent_id, workspace_id)
            .await
            .expect("create parent");

        let child = Session::create_with_delegation(
            &pool,
            &sample("CODEX"),
            child_id,
            workspace_id,
            parent_id,
            "toolu_abc",
            "call-123",
        )
        .await
        .expect("create delegated child");

        assert_eq!(child.parent_session_id, Some(parent_id));
        assert_eq!(child.parent_tool_use_id.as_deref(), Some("toolu_abc"));
        assert_eq!(child.delegation_call_id.as_deref(), Some("call-123"));

        let found = Session::find_by_delegation_call_id(&pool, "call-123")
            .await
            .expect("query by call id")
            .expect("child present");
        assert_eq!(found.id, child_id);
        assert_eq!(found.parent_session_id, Some(parent_id));

        assert!(
            Session::find_by_delegation_call_id(&pool, "missing")
                .await
                .expect("query by call id")
                .is_none()
        );
    }
}
