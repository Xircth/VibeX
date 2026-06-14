//! Conversation metadata and event-sourced identity layer.
//!
//! During the event-sourced cutover, `sessions.id` remains the physical VibeX
//! conversation id. New `conversation_*` tables own bindings, turns, events,
//! side effects, import/export metadata, and projections. Legacy agent session
//! identifiers may remain on `sessions` for compatibility and import repair, but
//! they are not the product history source.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use ts_rs::TS;
use uuid::Uuid;

use super::session::SessionStatus;

/// Legacy summary shape used by existing Tauri commands while the workbench
/// switches to canonical event projection.
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

    /// Resolve the conversation currently bound to an external ACP/agent
    /// session id.
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

    /// Soft-delete the conversation metadata row.
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

    /// Bind the agent session id + type for legacy runtime compatibility.
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

    /// Update cached external session metadata (message count + last-seen model).
    pub async fn update_cached_agent_metadata(
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

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
pub struct ConversationRecord {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub task_id: Option<Uuid>,
    pub title: Option<String>,
    pub title_locked: bool,
    pub status: SessionStatus,
    pub active_turn_id: Option<Uuid>,
    pub pinned_at: Option<DateTime<Utc>>,
    pub parent_conversation_id: Option<Uuid>,
    pub parent_tool_call_id: Option<String>,
    pub delegation_call_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
pub struct CreateConversationRecord<'a> {
    pub workspace_id: Uuid,
    pub task_id: Option<Uuid>,
    pub title: Option<&'a str>,
    pub initial_prompt: Option<&'a str>,
    pub status: Option<SessionStatus>,
    pub executor: Option<&'a str>,
}

const CONVERSATION_COLUMNS: &str = r#"id,
    workspace_id,
    task_id,
    name AS title,
    title_locked,
    status,
    active_turn_id,
    pinned_at,
    parent_session_id AS parent_conversation_id,
    parent_tool_use_id AS parent_tool_call_id,
    delegation_call_id,
    created_at,
    updated_at,
    deleted_at"#;

impl ConversationRecord {
    pub async fn create(
        pool: &SqlitePool,
        id: Uuid,
        input: CreateConversationRecord<'_>,
    ) -> Result<Self, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"INSERT INTO sessions (
                   id, workspace_id, task_id, name, initial_prompt, status, executor
               )
               VALUES (?, ?, ?, ?, ?, ?, ?)
               RETURNING {CONVERSATION_COLUMNS}"#
        ))
        .bind(id)
        .bind(input.workspace_id)
        .bind(input.task_id)
        .bind(input.title.filter(|value| !value.trim().is_empty()))
        .bind(
            input
                .initial_prompt
                .filter(|value| !value.trim().is_empty()),
        )
        .bind(input.status.unwrap_or_default())
        .bind(input.executor.filter(|value| !value.trim().is_empty()))
        .fetch_one(pool)
        .await
    }

    pub async fn find_by_id(pool: &SqlitePool, id: Uuid) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {CONVERSATION_COLUMNS}
               FROM sessions
               WHERE id = ? AND deleted_at IS NULL"#
        ))
        .bind(id)
        .fetch_optional(pool)
        .await
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

    pub async fn update_active_turn(
        pool: &SqlitePool,
        id: Uuid,
        active_turn_id: Option<Uuid>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"UPDATE sessions
               SET active_turn_id = ?, updated_at = datetime('now', 'subsec')
               WHERE id = ?"#,
        )
        .bind(active_turn_id)
        .bind(id)
        .execute(pool)
        .await?;
        Ok(())
    }
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
pub struct ConversationAgentBindingRecord {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub agent_type: String,
    pub working_dir: String,
    pub acp_session_id: Option<String>,
    pub acp_protocol_version: Option<String>,
    pub load_supported: bool,
    pub resume_supported: bool,
    pub close_supported: bool,
    pub terminal_supported: bool,
    pub additional_directories_supported: bool,
    pub prompt_capabilities_json: String,
    pub session_capabilities_json: String,
    pub client_capabilities_json: String,
    pub mcp_servers_json: String,
    pub modes_json: String,
    pub config_options_json: String,
    pub current_mode: Option<String>,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct CreateConversationAgentBinding<'a> {
    pub conversation_id: Uuid,
    pub agent_type: &'a str,
    pub working_dir: &'a str,
    pub acp_session_id: Option<&'a str>,
    pub acp_protocol_version: Option<&'a str>,
    pub load_supported: bool,
    pub resume_supported: bool,
    pub close_supported: bool,
    pub terminal_supported: bool,
    pub additional_directories_supported: bool,
    pub prompt_capabilities_json: &'a str,
    pub session_capabilities_json: &'a str,
    pub client_capabilities_json: &'a str,
    pub mcp_servers_json: &'a str,
    pub modes_json: &'a str,
    pub config_options_json: &'a str,
    pub current_mode: Option<&'a str>,
    pub status: &'a str,
}

const BINDING_COLUMNS: &str = r#"id,
    conversation_id,
    agent_type,
    working_dir,
    acp_session_id,
    acp_protocol_version,
    load_supported,
    resume_supported,
    close_supported,
    terminal_supported,
    additional_directories_supported,
    prompt_capabilities_json,
    session_capabilities_json,
    client_capabilities_json,
    mcp_servers_json,
    modes_json,
    config_options_json,
    current_mode,
    status,
    created_at,
    updated_at"#;

impl ConversationAgentBindingRecord {
    pub async fn create(
        pool: &SqlitePool,
        id: Uuid,
        input: CreateConversationAgentBinding<'_>,
    ) -> Result<Self, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"INSERT INTO conversation_agent_bindings (
                   id, conversation_id, agent_type, working_dir, acp_session_id,
                   acp_protocol_version, load_supported, resume_supported,
                   close_supported, terminal_supported,
                   additional_directories_supported, prompt_capabilities_json,
                   session_capabilities_json, client_capabilities_json,
                   mcp_servers_json, modes_json, config_options_json,
                   current_mode, status
               )
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               RETURNING {BINDING_COLUMNS}"#
        ))
        .bind(id)
        .bind(input.conversation_id)
        .bind(input.agent_type)
        .bind(input.working_dir)
        .bind(input.acp_session_id)
        .bind(input.acp_protocol_version)
        .bind(input.load_supported)
        .bind(input.resume_supported)
        .bind(input.close_supported)
        .bind(input.terminal_supported)
        .bind(input.additional_directories_supported)
        .bind(input.prompt_capabilities_json)
        .bind(input.session_capabilities_json)
        .bind(input.client_capabilities_json)
        .bind(input.mcp_servers_json)
        .bind(input.modes_json)
        .bind(input.config_options_json)
        .bind(input.current_mode)
        .bind(input.status)
        .fetch_one(pool)
        .await
    }

    pub async fn latest_for_conversation(
        pool: &SqlitePool,
        conversation_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {BINDING_COLUMNS}
               FROM conversation_agent_bindings
               WHERE conversation_id = ?
               ORDER BY created_at DESC
               LIMIT 1"#
        ))
        .bind(conversation_id)
        .fetch_optional(pool)
        .await
    }

    pub async fn list_for_conversation(
        pool: &SqlitePool,
        conversation_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {BINDING_COLUMNS}
               FROM conversation_agent_bindings
               WHERE conversation_id = ?
               ORDER BY created_at ASC"#
        ))
        .bind(conversation_id)
        .fetch_all(pool)
        .await
    }

    pub async fn bind_acp_session(
        pool: &SqlitePool,
        id: Uuid,
        acp_session_id: &str,
        acp_protocol_version: Option<&str>,
        status: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"UPDATE conversation_agent_bindings
               SET acp_session_id = ?,
                   acp_protocol_version = ?,
                   status = ?,
                   updated_at = datetime('now', 'subsec')
               WHERE id = ?"#,
        )
        .bind(acp_session_id)
        .bind(acp_protocol_version)
        .bind(status)
        .bind(id)
        .execute(pool)
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::*;
    use crate::models::session::{CreateSession, Session};

    /// Shared in-memory pool with foreign keys disabled — this exercises the
    /// `bind_external_id` UPDATE in isolation without standing up the full
    /// workspace/project/task FK graph.
    async fn migrated_pool() -> SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("sqlite options")
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("memory db");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        // A migration may re-enable the pragma; force it off on the pooled
        // connection so the focused UPDATE test needs no FK parents.
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("disable foreign keys");
        pool
    }

    /// Binding an external agent session id remains observable for legacy
    /// runtime compatibility and explicit import/repair flows.
    #[tokio::test]
    async fn bind_external_id_round_trips_and_resolves() {
        let pool = migrated_pool().await;
        let id = Uuid::new_v4();
        let workspace_id = Uuid::new_v4();
        Session::create(
            &pool,
            &CreateSession {
                executor: None,
                task_id: None,
                name: None,
                initial_prompt: None,
                status: None,
            },
            id,
            workspace_id,
        )
        .await
        .expect("create session");

        DbConversationSummary::bind_external_id(&pool, id, "rollout-abc", "claude_code")
            .await
            .expect("bind external id");

        let by_id = DbConversationSummary::find_by_id(&pool, id)
            .await
            .expect("query by id")
            .expect("conversation present");
        assert_eq!(by_id.external_session_id.as_deref(), Some("rollout-abc"));
        assert_eq!(by_id.agent_type.as_deref(), Some("claude_code"));

        let by_external =
            DbConversationSummary::find_by_external_id(&pool, "rollout-abc", "claude_code")
                .await
                .expect("query by external id")
                .expect("conversation present");
        assert_eq!(by_external.id, id);
    }

    #[tokio::test]
    async fn conversation_identity_create_status_and_binding_round_trip() {
        let pool = migrated_pool().await;
        let id = Uuid::new_v4();
        let workspace_id = Uuid::new_v4();

        let conversation = ConversationRecord::create(
            &pool,
            id,
            CreateConversationRecord {
                workspace_id,
                task_id: None,
                title: Some("Canonical conversation"),
                initial_prompt: Some("hello"),
                status: None,
                executor: Some("agent"),
            },
        )
        .await
        .expect("create conversation");

        assert_eq!(conversation.id, id);
        assert_eq!(conversation.workspace_id, workspace_id);
        assert_eq!(
            conversation.title.as_deref(),
            Some("Canonical conversation")
        );

        ConversationRecord::update_status(&pool, id, SessionStatus::InProgress)
            .await
            .expect("update status");
        let found = ConversationRecord::find_by_id(&pool, id)
            .await
            .expect("find")
            .expect("conversation exists");
        assert_eq!(found.status, SessionStatus::InProgress);

        let binding_id = Uuid::new_v4();
        let binding = ConversationAgentBindingRecord::create(
            &pool,
            binding_id,
            CreateConversationAgentBinding {
                conversation_id: id,
                agent_type: "codex",
                working_dir: "C:/work",
                acp_session_id: None,
                acp_protocol_version: None,
                load_supported: true,
                resume_supported: false,
                close_supported: true,
                terminal_supported: true,
                additional_directories_supported: false,
                prompt_capabilities_json: r#"{"text":true}"#,
                session_capabilities_json: "{}",
                client_capabilities_json: "{}",
                mcp_servers_json: "[]",
                modes_json: "[]",
                config_options_json: "[]",
                current_mode: None,
                status: "connecting",
            },
        )
        .await
        .expect("create binding");
        assert_eq!(binding.conversation_id, id);
        assert!(binding.load_supported);

        ConversationAgentBindingRecord::bind_acp_session(
            &pool,
            binding_id,
            "acp-session-1",
            Some("1"),
            "ready",
        )
        .await
        .expect("bind acp session");

        let latest = ConversationAgentBindingRecord::latest_for_conversation(&pool, id)
            .await
            .expect("latest binding")
            .expect("binding exists");
        assert_eq!(latest.acp_session_id.as_deref(), Some("acp-session-1"));
        assert_eq!(latest.status, "ready");
    }
}
