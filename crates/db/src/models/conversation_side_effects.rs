use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use ts_rs::TS;
use uuid::Uuid;

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
pub struct ConversationFileChangeRecord {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub turn_id: Uuid,
    pub source: String,
    pub path: String,
    pub change_kind: String,
    pub additions: Option<i64>,
    pub deletions: Option<i64>,
    pub old_path: Option<String>,
    pub diff_summary_json: Option<String>,
    pub created_at: DateTime<Utc>,
}

pub struct InsertConversationFileChange<'a> {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub turn_id: Uuid,
    pub source: &'a str,
    pub path: &'a str,
    pub change_kind: &'a str,
    pub additions: Option<i64>,
    pub deletions: Option<i64>,
    pub old_path: Option<&'a str>,
    pub diff_summary_json: Option<&'a str>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
pub struct ConversationPermissionRecord {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub turn_id: Uuid,
    pub permission_id: String,
    pub title: Option<String>,
    pub details_json: String,
    pub options_json: String,
    pub status: String,
    pub response_json: Option<String>,
    pub auto: bool,
    pub created_at: DateTime<Utc>,
    pub responded_at: Option<DateTime<Utc>>,
}

pub struct UpsertConversationPermission<'a> {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub turn_id: Uuid,
    pub permission_id: &'a str,
    pub title: Option<&'a str>,
    pub details_json: &'a str,
    pub options_json: &'a str,
    pub auto: bool,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
pub struct ConversationTerminalRecord {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub turn_id: Uuid,
    pub terminal_id: String,
    pub command: Option<String>,
    pub args_json: String,
    pub cwd: Option<String>,
    pub status: String,
    pub output_summary: Option<String>,
    pub output_truncated: bool,
    pub exit_status_json: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

pub struct UpsertConversationTerminal<'a> {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub turn_id: Uuid,
    pub terminal_id: &'a str,
    pub command: Option<&'a str>,
    pub args_json: &'a str,
    pub cwd: Option<&'a str>,
    pub status: &'a str,
    pub output_summary: Option<&'a str>,
    pub output_truncated: bool,
    pub exit_status_json: Option<&'a str>,
}

const FILE_COLUMNS: &str = r#"id,
    conversation_id,
    turn_id,
    source,
    path,
    change_kind,
    additions,
    deletions,
    old_path,
    diff_summary_json,
    created_at"#;

const PERMISSION_COLUMNS: &str = r#"id,
    conversation_id,
    turn_id,
    permission_id,
    title,
    details_json,
    options_json,
    status,
    response_json,
    auto,
    created_at,
    responded_at"#;

const TERMINAL_COLUMNS: &str = r#"id,
    conversation_id,
    turn_id,
    terminal_id,
    command,
    args_json,
    cwd,
    status,
    output_summary,
    output_truncated,
    exit_status_json,
    created_at,
    updated_at"#;

impl ConversationFileChangeRecord {
    pub async fn insert(
        pool: &SqlitePool,
        input: InsertConversationFileChange<'_>,
    ) -> Result<Self, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"INSERT INTO conversation_file_changes (
                   id, conversation_id, turn_id, source, path, change_kind,
                   additions, deletions, old_path, diff_summary_json
               )
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               RETURNING {FILE_COLUMNS}"#
        ))
        .bind(input.id)
        .bind(input.conversation_id)
        .bind(input.turn_id)
        .bind(input.source)
        .bind(input.path)
        .bind(input.change_kind)
        .bind(input.additions)
        .bind(input.deletions)
        .bind(input.old_path)
        .bind(input.diff_summary_json)
        .fetch_one(pool)
        .await
    }

    pub async fn list_for_turn(pool: &SqlitePool, turn_id: Uuid) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {FILE_COLUMNS}
               FROM conversation_file_changes
               WHERE turn_id = ?
               ORDER BY path ASC"#
        ))
        .bind(turn_id)
        .fetch_all(pool)
        .await
    }

    pub async fn list_for_conversation(
        pool: &SqlitePool,
        conversation_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {FILE_COLUMNS}
               FROM conversation_file_changes
               WHERE conversation_id = ?
               ORDER BY path ASC"#
        ))
        .bind(conversation_id)
        .fetch_all(pool)
        .await
    }
}

impl ConversationPermissionRecord {
    pub async fn upsert_pending(
        pool: &SqlitePool,
        input: UpsertConversationPermission<'_>,
    ) -> Result<Self, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"INSERT INTO conversation_permissions (
                   id, conversation_id, turn_id, permission_id, title,
                   details_json, options_json, auto
               )
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(conversation_id, permission_id) DO UPDATE SET
                   turn_id = excluded.turn_id,
                   title = COALESCE(excluded.title, conversation_permissions.title),
                   details_json = excluded.details_json,
                   options_json = excluded.options_json,
                   status = 'pending',
                   response_json = NULL,
                   auto = excluded.auto
               RETURNING {PERMISSION_COLUMNS}"#
        ))
        .bind(input.id)
        .bind(input.conversation_id)
        .bind(input.turn_id)
        .bind(input.permission_id)
        .bind(input.title)
        .bind(input.details_json)
        .bind(input.options_json)
        .bind(input.auto)
        .fetch_one(pool)
        .await
    }

    pub async fn respond(
        pool: &SqlitePool,
        conversation_id: Uuid,
        permission_id: &str,
        response_json: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"UPDATE conversation_permissions
               SET status = 'responded',
                   response_json = ?,
                   responded_at = datetime('now', 'subsec')
               WHERE conversation_id = ? AND permission_id = ?"#,
        )
        .bind(response_json)
        .bind(conversation_id)
        .bind(permission_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn list_for_turn(pool: &SqlitePool, turn_id: Uuid) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {PERMISSION_COLUMNS}
               FROM conversation_permissions
               WHERE turn_id = ?
               ORDER BY created_at ASC"#
        ))
        .bind(turn_id)
        .fetch_all(pool)
        .await
    }

    pub async fn list_for_conversation(
        pool: &SqlitePool,
        conversation_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {PERMISSION_COLUMNS}
               FROM conversation_permissions
               WHERE conversation_id = ?
               ORDER BY created_at ASC"#
        ))
        .bind(conversation_id)
        .fetch_all(pool)
        .await
    }
}

impl ConversationTerminalRecord {
    pub async fn upsert(
        pool: &SqlitePool,
        input: UpsertConversationTerminal<'_>,
    ) -> Result<Self, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"INSERT INTO conversation_terminals (
                   id, conversation_id, turn_id, terminal_id, command,
                   args_json, cwd, status, output_summary, output_truncated,
                   exit_status_json
               )
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(conversation_id, terminal_id) DO UPDATE SET
                   turn_id = excluded.turn_id,
                   command = COALESCE(excluded.command, conversation_terminals.command),
                   args_json = excluded.args_json,
                   cwd = COALESCE(excluded.cwd, conversation_terminals.cwd),
                   status = excluded.status,
                   output_summary = COALESCE(excluded.output_summary, conversation_terminals.output_summary),
                   output_truncated = excluded.output_truncated,
                   exit_status_json = COALESCE(excluded.exit_status_json, conversation_terminals.exit_status_json),
                   updated_at = datetime('now', 'subsec')
               RETURNING {TERMINAL_COLUMNS}"#
        ))
        .bind(input.id)
        .bind(input.conversation_id)
        .bind(input.turn_id)
        .bind(input.terminal_id)
        .bind(input.command)
        .bind(input.args_json)
        .bind(input.cwd)
        .bind(input.status)
        .bind(input.output_summary)
        .bind(input.output_truncated)
        .bind(input.exit_status_json)
        .fetch_one(pool)
        .await
    }

    pub async fn list_for_turn(pool: &SqlitePool, turn_id: Uuid) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {TERMINAL_COLUMNS}
               FROM conversation_terminals
               WHERE turn_id = ?
               ORDER BY created_at ASC"#
        ))
        .bind(turn_id)
        .fetch_all(pool)
        .await
    }

    pub async fn list_for_conversation(
        pool: &SqlitePool,
        conversation_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {TERMINAL_COLUMNS}
               FROM conversation_terminals
               WHERE conversation_id = ?
               ORDER BY created_at ASC"#
        ))
        .bind(conversation_id)
        .fetch_all(pool)
        .await
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::*;
    use crate::models::{
        conversation::{ConversationRecord, CreateConversationRecord},
        conversation_tool::{ConversationToolCallRecord, UpsertConversationToolCall},
        conversation_turn::{ConversationTurnRecord, CreateConversationTurn},
    };

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
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("disable foreign keys");
        pool
    }

    async fn seed_turn(pool: &SqlitePool) -> (Uuid, Uuid) {
        let conversation_id = Uuid::new_v4();
        ConversationRecord::create(
            pool,
            conversation_id,
            CreateConversationRecord {
                workspace_id: Uuid::new_v4(),
                task_id: None,
                title: None,
                initial_prompt: None,
                status: None,
                executor: Some("agent"),
            },
        )
        .await
        .expect("create conversation");
        let turn = ConversationTurnRecord::create_pending(
            pool,
            Uuid::new_v4(),
            CreateConversationTurn {
                conversation_id,
                prompt_id: Some("prompt-1"),
                text_preview: Some("hello"),
                input_blocks_json: "[]",
            },
        )
        .await
        .expect("create turn");
        (conversation_id, turn.id)
    }

    #[tokio::test]
    async fn conversation_state_tables_upsert_and_list() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        let tool = ConversationToolCallRecord::upsert(
            &pool,
            UpsertConversationToolCall {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id,
                tool_call_id: "tool-1",
                title: Some("Edit file"),
                kind: Some("edit"),
                status: "running",
                raw_input_json: Some(r#"{"path":"src/main.rs"}"#),
                raw_output_json: None,
                content_json: None,
                locations_json: None,
                metadata_json: None,
                images_json: None,
            },
        )
        .await
        .expect("upsert tool");
        assert_eq!(tool.status, "running");

        let tool = ConversationToolCallRecord::upsert(
            &pool,
            UpsertConversationToolCall {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id,
                tool_call_id: "tool-1",
                title: None,
                kind: None,
                status: "completed",
                raw_input_json: None,
                raw_output_json: Some(r#"{"ok":true}"#),
                content_json: None,
                locations_json: Some(r#"[{"path":"src/main.rs"}]"#),
                metadata_json: None,
                images_json: None,
            },
        )
        .await
        .expect("complete tool");
        assert_eq!(tool.status, "completed");
        assert!(tool.raw_input_json.is_some());
        assert!(tool.raw_output_json.is_some());

        ConversationFileChangeRecord::insert(
            &pool,
            InsertConversationFileChange {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id,
                source: "checkpoint_diff",
                path: "src/main.rs",
                change_kind: "modified",
                additions: Some(3),
                deletions: Some(1),
                old_path: None,
                diff_summary_json: Some(r#"{"summary":"changed"}"#),
            },
        )
        .await
        .expect("insert file change");

        ConversationPermissionRecord::upsert_pending(
            &pool,
            UpsertConversationPermission {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id,
                permission_id: "permission-1",
                title: Some("Run command"),
                details_json: "{}",
                options_json: "[]",
                auto: false,
            },
        )
        .await
        .expect("upsert permission");
        ConversationPermissionRecord::respond(
            &pool,
            conversation_id,
            "permission-1",
            r#"{"kind":"allow"}"#,
        )
        .await
        .expect("respond permission");

        ConversationTerminalRecord::upsert(
            &pool,
            UpsertConversationTerminal {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id,
                terminal_id: "terminal-1",
                command: Some("cargo"),
                args_json: r#"["test"]"#,
                cwd: Some("C:/work"),
                status: "running",
                output_summary: Some("running tests"),
                output_truncated: false,
                exit_status_json: None,
            },
        )
        .await
        .expect("upsert terminal");

        assert_eq!(
            ConversationToolCallRecord::list_for_turn(&pool, turn_id)
                .await
                .expect("tools")
                .len(),
            1
        );
        assert_eq!(
            ConversationFileChangeRecord::list_for_turn(&pool, turn_id)
                .await
                .expect("files")
                .len(),
            1
        );
        assert_eq!(
            ConversationPermissionRecord::list_for_turn(&pool, turn_id)
                .await
                .expect("permissions")[0]
                .status,
            "responded"
        );
        assert_eq!(
            ConversationTerminalRecord::list_for_turn(&pool, turn_id)
                .await
                .expect("terminals")
                .len(),
            1
        );
    }
}
