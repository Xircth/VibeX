use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{Executor, FromRow, Sqlite, SqlitePool};
use ts_rs::TS;
use uuid::Uuid;

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
pub struct ConversationTurnRecord {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub ordinal: i64,
    pub prompt_id: Option<String>,
    pub role: String,
    pub status: String,
    pub text_preview: Option<String>,
    pub input_blocks_json: String,
    pub stop_reason: Option<String>,
    pub model: Option<String>,
    pub usage_json: Option<String>,
    pub error_json: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct CreateConversationTurn<'a> {
    pub conversation_id: Uuid,
    pub prompt_id: Option<&'a str>,
    pub text_preview: Option<&'a str>,
    pub input_blocks_json: &'a str,
}

const TURN_COLUMNS: &str = r#"id,
    conversation_id,
    ordinal,
    prompt_id,
    role,
    status,
    text_preview,
    input_blocks_json,
    stop_reason,
    model,
    usage_json,
    error_json,
    started_at,
    completed_at,
    created_at,
    updated_at"#;

impl ConversationTurnRecord {
    pub async fn create_pending(
        pool: &SqlitePool,
        id: Uuid,
        input: CreateConversationTurn<'_>,
    ) -> Result<Self, sqlx::Error> {
        let ordinal: i64 = sqlx::query_scalar(
            r#"SELECT COALESCE(MAX(ordinal), 0) + 1
               FROM conversation_turns
               WHERE conversation_id = ?"#,
        )
        .bind(input.conversation_id)
        .fetch_one(pool)
        .await?;

        sqlx::query_as::<_, Self>(&format!(
            r#"INSERT INTO conversation_turns (
                   id, conversation_id, ordinal, prompt_id, status,
                   text_preview, input_blocks_json
               )
               VALUES (?, ?, ?, ?, 'pending', ?, ?)
               RETURNING {TURN_COLUMNS}"#
        ))
        .bind(id)
        .bind(input.conversation_id)
        .bind(ordinal)
        .bind(input.prompt_id)
        .bind(input.text_preview)
        .bind(input.input_blocks_json)
        .fetch_one(pool)
        .await
    }

    pub async fn find_by_ordinal(
        pool: &SqlitePool,
        conversation_id: Uuid,
        ordinal: i64,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {TURN_COLUMNS}
               FROM conversation_turns
               WHERE conversation_id = ? AND ordinal = ?"#
        ))
        .bind(conversation_id)
        .bind(ordinal)
        .fetch_optional(pool)
        .await
    }

    pub async fn find_by_id(pool: &SqlitePool, id: Uuid) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {TURN_COLUMNS}
               FROM conversation_turns
               WHERE id = ?"#
        ))
        .bind(id)
        .fetch_optional(pool)
        .await
    }

    pub async fn list_for_conversation(
        pool: &SqlitePool,
        conversation_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {TURN_COLUMNS}
               FROM conversation_turns
               WHERE conversation_id = ?
               ORDER BY ordinal ASC"#
        ))
        .bind(conversation_id)
        .fetch_all(pool)
        .await
    }

    /// Every turn still in a non-terminal state, across all conversations. The startup
    /// recovery coordinator uses this to find turns orphaned by a host crash — the
    /// status set mirrors `is_in_flight_turn_status` in `conversation_service`.
    pub async fn list_in_flight(pool: &SqlitePool) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {TURN_COLUMNS}
               FROM conversation_turns
               WHERE status IN ('pending','queued','running','blocked')
               ORDER BY created_at ASC"#
        ))
        .fetch_all(pool)
        .await
    }

    pub async fn mark_queued<'e, E>(executor: E, id: Uuid) -> Result<(), sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        Self::mark_simple_status(executor, id, "queued").await
    }

    pub async fn set_prompt_id(
        pool: &SqlitePool,
        id: Uuid,
        prompt_id: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"UPDATE conversation_turns
               SET prompt_id = ?, updated_at = datetime('now', 'subsec')
               WHERE id = ?"#,
        )
        .bind(prompt_id)
        .bind(id)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn mark_running<'e, E>(executor: E, id: Uuid) -> Result<(), sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        sqlx::query(
            r#"UPDATE conversation_turns
               SET status = 'running',
                   started_at = COALESCE(started_at, datetime('now', 'subsec')),
                   updated_at = datetime('now', 'subsec')
               WHERE id = ?"#,
        )
        .bind(id)
        .execute(executor)
        .await?;
        Ok(())
    }

    pub async fn mark_blocked<'e, E>(executor: E, id: Uuid) -> Result<(), sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        Self::mark_simple_status(executor, id, "blocked").await
    }

    pub async fn mark_completed<'e, E>(
        executor: E,
        id: Uuid,
        stop_reason: Option<&str>,
        model: Option<&str>,
        usage_json: Option<&str>,
    ) -> Result<(), sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        sqlx::query(
            r#"UPDATE conversation_turns
               SET status = 'completed',
                   stop_reason = ?,
                   model = COALESCE(?, model),
                   usage_json = COALESCE(?, usage_json),
                   completed_at = COALESCE(completed_at, datetime('now', 'subsec')),
                   updated_at = datetime('now', 'subsec')
               WHERE id = ?"#,
        )
        .bind(stop_reason)
        .bind(model)
        .bind(usage_json)
        .bind(id)
        .execute(executor)
        .await?;
        Ok(())
    }

    pub async fn mark_failed<'e, E>(
        executor: E,
        id: Uuid,
        error_json: &str,
    ) -> Result<(), sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        sqlx::query(
            r#"UPDATE conversation_turns
               SET status = 'failed',
                   error_json = ?,
                   completed_at = COALESCE(completed_at, datetime('now', 'subsec')),
                   updated_at = datetime('now', 'subsec')
               WHERE id = ?"#,
        )
        .bind(error_json)
        .bind(id)
        .execute(executor)
        .await?;
        Ok(())
    }

    pub async fn mark_cancelled<'e, E>(
        executor: E,
        id: Uuid,
        reason_json: Option<&str>,
    ) -> Result<(), sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        sqlx::query(
            r#"UPDATE conversation_turns
               SET status = 'cancelled',
                   error_json = COALESCE(?, error_json),
                   completed_at = COALESCE(completed_at, datetime('now', 'subsec')),
                   updated_at = datetime('now', 'subsec')
               WHERE id = ?"#,
        )
        .bind(reason_json)
        .bind(id)
        .execute(executor)
        .await?;
        Ok(())
    }

    /// Mark a turn Interrupted — the fourth terminal state, set only by the startup
    /// recovery coordinator when the host died mid-turn (ADR-0001). Mirrors
    /// `mark_cancelled` but is deliberately a separate call so intent is legible at
    /// the call site.
    pub async fn mark_interrupted<'e, E>(
        executor: E,
        id: Uuid,
        reason_json: Option<&str>,
    ) -> Result<(), sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        sqlx::query(
            r#"UPDATE conversation_turns
               SET status = 'interrupted',
                   error_json = COALESCE(?, error_json),
                   completed_at = COALESCE(completed_at, datetime('now', 'subsec')),
                   updated_at = datetime('now', 'subsec')
               WHERE id = ?"#,
        )
        .bind(reason_json)
        .bind(id)
        .execute(executor)
        .await?;
        Ok(())
    }

    async fn mark_simple_status<'e, E>(
        executor: E,
        id: Uuid,
        status: &str,
    ) -> Result<(), sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        sqlx::query(
            r#"UPDATE conversation_turns
               SET status = ?, updated_at = datetime('now', 'subsec')
               WHERE id = ?"#,
        )
        .bind(status)
        .bind(id)
        .execute(executor)
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::*;
    use crate::models::conversation::{ConversationRecord, CreateConversationRecord};

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

    #[tokio::test]
    async fn conversation_turn_create_and_status_transitions() {
        let pool = setup_pool().await;
        let conversation_id = Uuid::new_v4();
        ConversationRecord::create(
            &pool,
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

        let turn_id = Uuid::new_v4();
        let turn = ConversationTurnRecord::create_pending(
            &pool,
            turn_id,
            CreateConversationTurn {
                conversation_id,
                prompt_id: Some("prompt-1"),
                text_preview: Some("hello"),
                input_blocks_json: r#"[{"kind":"text","text":"hello"}]"#,
            },
        )
        .await
        .expect("create turn");
        assert_eq!(turn.ordinal, 1);
        assert_eq!(turn.status, "pending");

        ConversationTurnRecord::mark_queued(&pool, turn_id)
            .await
            .expect("queued");
        ConversationTurnRecord::mark_running(&pool, turn_id)
            .await
            .expect("running");
        ConversationTurnRecord::mark_blocked(&pool, turn_id)
            .await
            .expect("blocked");
        ConversationTurnRecord::mark_completed(
            &pool,
            turn_id,
            Some("end_turn"),
            Some("model-a"),
            Some(r#"{"input":1,"output":2}"#),
        )
        .await
        .expect("completed");

        let found = ConversationTurnRecord::find_by_ordinal(&pool, conversation_id, 1)
            .await
            .expect("find by ordinal")
            .expect("turn exists");
        assert_eq!(found.status, "completed");
        assert_eq!(found.stop_reason.as_deref(), Some("end_turn"));
        assert!(found.started_at.is_some());
        assert!(found.completed_at.is_some());

        let failed_id = Uuid::new_v4();
        ConversationTurnRecord::create_pending(
            &pool,
            failed_id,
            CreateConversationTurn {
                conversation_id,
                prompt_id: Some("prompt-2"),
                text_preview: Some("fail"),
                input_blocks_json: "[]",
            },
        )
        .await
        .expect("create failed turn");
        ConversationTurnRecord::mark_failed(&pool, failed_id, r#"{"message":"boom"}"#)
            .await
            .expect("failed");

        let cancelled_id = Uuid::new_v4();
        ConversationTurnRecord::create_pending(
            &pool,
            cancelled_id,
            CreateConversationTurn {
                conversation_id,
                prompt_id: Some("prompt-3"),
                text_preview: Some("cancel"),
                input_blocks_json: "[]",
            },
        )
        .await
        .expect("create cancelled turn");
        ConversationTurnRecord::mark_cancelled(&pool, cancelled_id, Some(r#"{"message":"stop"}"#))
            .await
            .expect("cancelled");
    }

    #[tokio::test]
    async fn list_in_flight_finds_orphaned_turns_and_mark_interrupted_settles_them() {
        // 批次B / ADR-0001: the startup recovery coordinator lists non-terminal turns
        // and drives each to the Interrupted terminal state.
        let pool = setup_pool().await;
        let conversation_id = Uuid::new_v4();
        ConversationRecord::create(
            &pool,
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

        // One turn per non-terminal status, plus a completed one that must be excluded.
        let mut in_flight_ids = Vec::new();
        for (index, status) in ["pending", "queued", "running", "blocked"]
            .iter()
            .enumerate()
        {
            let id = Uuid::new_v4();
            ConversationTurnRecord::create_pending(
                &pool,
                id,
                CreateConversationTurn {
                    conversation_id,
                    prompt_id: Some("p"),
                    text_preview: Some("t"),
                    input_blocks_json: "[]",
                },
            )
            .await
            .expect("create turn");
            // 'pending' is the create default; advance the rest.
            match *status {
                "queued" => ConversationTurnRecord::mark_queued(&pool, id)
                    .await
                    .unwrap(),
                "running" => ConversationTurnRecord::mark_running(&pool, id)
                    .await
                    .unwrap(),
                "blocked" => ConversationTurnRecord::mark_blocked(&pool, id)
                    .await
                    .unwrap(),
                _ => {}
            }
            let _ = index;
            in_flight_ids.push(id);
        }
        let completed_id = Uuid::new_v4();
        ConversationTurnRecord::create_pending(
            &pool,
            completed_id,
            CreateConversationTurn {
                conversation_id,
                prompt_id: Some("done"),
                text_preview: Some("done"),
                input_blocks_json: "[]",
            },
        )
        .await
        .expect("create completed turn");
        ConversationTurnRecord::mark_completed(&pool, completed_id, None, None, None)
            .await
            .expect("completed");

        let in_flight = ConversationTurnRecord::list_in_flight(&pool)
            .await
            .expect("list in flight");
        assert_eq!(
            in_flight.len(),
            4,
            "the four non-terminal turns, not the completed one"
        );
        assert!(in_flight.iter().all(|turn| turn.id != completed_id));

        for turn in &in_flight {
            ConversationTurnRecord::mark_interrupted(
                &pool,
                turn.id,
                Some(r#"{"message":"restart"}"#),
            )
            .await
            .expect("mark interrupted");
        }

        // All settled now → nothing left in flight, and each is 'interrupted'.
        assert!(
            ConversationTurnRecord::list_in_flight(&pool)
                .await
                .expect("list in flight")
                .is_empty()
        );
        let first = ConversationTurnRecord::find_by_id(&pool, in_flight_ids[0])
            .await
            .expect("find")
            .expect("turn");
        assert_eq!(first.status, "interrupted");
        assert!(first.completed_at.is_some());
    }
}
