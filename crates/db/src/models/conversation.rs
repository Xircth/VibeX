//! Conversation metadata layer.
//!
//! In the codeg-aligned model the `sessions` row *is* the conversation, and the
//! DB stores only metadata -- the transcript turns are re-parsed from the agent
//! CLI session file (keyed by `external_session_id` + `agent_type`). This module
//! exposes the conversation-shaped read/write surface over `sessions`, keeping
//! the core `Session` struct lean.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use ts_rs::TS;
use uuid::Uuid;

use super::session::SessionStatus;

/// Conversation-level metadata derived from a `sessions` row. The transcript
/// itself is not stored; it is re-parsed from the agent session file.
#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
pub struct DbConversationSummary {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub task_id: Option<Uuid>,
    /// Display title (the `sessions.name` column).
    pub title: Option<String>,
    /// When set, parsed titles must not overwrite the user-set title.
    pub title_locked: bool,
    pub status: SessionStatus,
    pub agent_type: Option<String>,
    pub model: Option<String>,
    pub external_session_id: Option<String>,
    pub message_count: i64,
    pub pinned_at: Option<DateTime<Utc>>,
    pub parent_session_id: Option<Uuid>,
    pub parent_tool_use_id: Option<String>,
    pub delegation_call_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

const SUMMARY_COLUMNS: &str = r#"id,
    workspace_id,
    task_id,
    name AS title,
    title_locked,
    status,
    agent_type,
    model,
    external_session_id,
    message_count,
    pinned_at,
    parent_session_id,
    parent_tool_use_id,
    delegation_call_id,
    created_at,
    updated_at"#;

impl DbConversationSummary {
    /// All non-deleted conversations for a workspace, pinned first then most
    /// recently updated.
    pub async fn list_for_workspace(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {SUMMARY_COLUMNS}
               FROM sessions
               WHERE workspace_id = ? AND deleted_at IS NULL
               ORDER BY pinned_at IS NULL, pinned_at DESC, updated_at DESC, created_at DESC"#
        ))
        .bind(workspace_id)
        .fetch_all(pool)
        .await
    }

    /// A single non-deleted conversation by id.
    pub async fn find_by_id(pool: &SqlitePool, id: Uuid) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {SUMMARY_COLUMNS}
               FROM sessions
               WHERE id = ? AND deleted_at IS NULL"#
        ))
        .bind(id)
        .fetch_optional(pool)
        .await
    }

    /// Resolve the conversation bound to an agent session id (the re-parse key).
    pub async fn find_by_external_id(
        pool: &SqlitePool,
        external_session_id: &str,
        agent_type: &str,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {SUMMARY_COLUMNS}
               FROM sessions
               WHERE external_session_id = ? AND agent_type = ? AND deleted_at IS NULL"#
        ))
        .bind(external_session_id)
        .bind(agent_type)
        .fetch_optional(pool)
        .await
    }

    /// Set the display title; locks it so parsed titles won't overwrite it.
    pub async fn set_title(pool: &SqlitePool, id: Uuid, title: &str) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"UPDATE sessions
               SET name = ?, title_locked = 1, updated_at = datetime('now', 'subsec')
               WHERE id = ?"#,
        )
        .bind(title)
        .bind(id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Backfill a parsed title without locking, only if not user-locked.
    pub async fn backfill_title(
        pool: &SqlitePool,
        id: Uuid,
        title: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"UPDATE sessions
               SET name = ?, updated_at = datetime('now', 'subsec')
               WHERE id = ? AND title_locked = 0"#,
        )
        .bind(title)
        .bind(id)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn set_pinned(pool: &SqlitePool, id: Uuid, pinned: bool) -> Result<(), sqlx::Error> {
        if pinned {
            sqlx::query(
                r#"UPDATE sessions
                   SET pinned_at = datetime('now', 'subsec'), updated_at = datetime('now', 'subsec')
                   WHERE id = ?"#,
            )
            .bind(id)
            .execute(pool)
            .await?;
        } else {
            sqlx::query(
                r#"UPDATE sessions
                   SET pinned_at = NULL, updated_at = datetime('now', 'subsec')
                   WHERE id = ?"#,
            )
            .bind(id)
            .execute(pool)
            .await?;
        }
        Ok(())
    }

    /// Soft-delete the conversation (the row and its agent session file remain).
    pub async fn soft_delete(pool: &SqlitePool, id: Uuid) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"UPDATE sessions
               SET deleted_at = datetime('now', 'subsec'), updated_at = datetime('now', 'subsec')
               WHERE id = ? AND deleted_at IS NULL"#,
        )
        .bind(id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Bind the agent session id + type that the transcript is re-parsed from.
    pub async fn bind_external_id(
        pool: &SqlitePool,
        id: Uuid,
        external_session_id: &str,
        agent_type: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"UPDATE sessions
               SET external_session_id = ?, agent_type = ?, updated_at = datetime('now', 'subsec')
               WHERE id = ?"#,
        )
        .bind(external_session_id)
        .bind(agent_type)
        .bind(id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Update cached transcript metadata (message count + last-seen model).
    pub async fn update_transcript_metadata(
        pool: &SqlitePool,
        id: Uuid,
        message_count: i64,
        model: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"UPDATE sessions
               SET message_count = ?, model = COALESCE(?, model),
                   updated_at = datetime('now', 'subsec')
               WHERE id = ?"#,
        )
        .bind(message_count)
        .bind(model)
        .bind(id)
        .execute(pool)
        .await?;
        Ok(())
    }
}
