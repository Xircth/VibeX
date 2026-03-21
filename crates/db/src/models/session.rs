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
    pub status: SessionStatus,
    pub executor: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize, TS)]
pub struct CreateSession {
    pub executor: Option<String>,
    pub task_id: Option<Uuid>,
    pub name: Option<String>,
    pub status: Option<SessionStatus>,
}

impl Session {
    pub async fn find_by_id(pool: &SqlitePool, id: Uuid) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Session>(
            r#"SELECT id,
                      workspace_id,
                      task_id,
                      name,
                      status,
                      executor,
                      created_at,
                      updated_at
               FROM sessions
               WHERE id = ?"#,
        )
        .bind(id)
        .fetch_optional(pool)
        .await
    }

    pub async fn find_by_task_id(pool: &SqlitePool, task_id: Uuid) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Session>(
            r#"SELECT id,
                      workspace_id,
                      task_id,
                      name,
                      status,
                      executor,
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

    /// Find all sessions for a workspace, ordered by most recently used coding session first.
    pub async fn find_by_workspace_id(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Session>(
            r#"SELECT s.id,
                      s.workspace_id,
                      s.task_id,
                      s.name,
                      s.status,
                      s.executor,
                      s.created_at,
                      s.updated_at
               FROM sessions s
               LEFT JOIN (
                   SELECT ep.session_id, MAX(ep.created_at) as last_used
                   FROM execution_processes ep
                   WHERE ep.run_reason = 'codingagent' AND ep.dropped = FALSE
                   GROUP BY ep.session_id
               ) latest_ep ON s.id = latest_ep.session_id
               WHERE s.workspace_id = ?
               ORDER BY latest_ep.last_used IS NULL ASC,
                        COALESCE(latest_ep.last_used, s.updated_at) DESC,
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
                      s.status,
                      s.executor,
                      s.created_at,
                      s.updated_at
               FROM sessions s
               LEFT JOIN (
                   SELECT ep.session_id, MAX(ep.created_at) as last_used
                   FROM execution_processes ep
                   WHERE ep.run_reason = 'codingagent' AND ep.dropped = FALSE
                   GROUP BY ep.session_id
               ) latest_ep ON s.id = latest_ep.session_id
               WHERE s.workspace_id = ?
               ORDER BY latest_ep.last_used IS NULL ASC,
                        COALESCE(latest_ep.last_used, s.updated_at) DESC,
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
        sqlx::query_as::<_, Session>(
            r#"INSERT INTO sessions (id, workspace_id, task_id, name, status, executor)
               VALUES (?, ?, ?, ?, ?, ?)
               RETURNING id,
                         workspace_id,
                         task_id,
                         name,
                         status,
                         executor,
                         created_at,
                         updated_at"#,
        )
        .bind(id)
        .bind(workspace_id)
        .bind(data.task_id)
        .bind(data.name.as_deref().filter(|name| !name.trim().is_empty()))
        .bind(data.status.clone().unwrap_or_default())
        .bind(data.executor.clone())
        .fetch_one(pool)
        .await
        .map_err(SessionError::from)
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
