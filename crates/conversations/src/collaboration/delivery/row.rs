use serde_json::Value;
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

use super::MessageReceipt;

#[derive(Debug, Clone)]
pub(crate) struct QueuedSpaceDelivery {
    pub(crate) conversation_id: Uuid,
    pub(crate) operation_id: Uuid,
    pub(crate) round_id: Option<String>,
    pub(crate) round_ordinal: Option<i64>,
}

#[derive(Debug, Clone, FromRow)]
pub(crate) struct HopHead {
    pub(crate) id: String,
    pub(crate) root_id: Option<String>,
    pub(crate) hop: i64,
}

impl HopHead {
    pub(crate) async fn find_by_id_in_space(
        pool: &SqlitePool,
        parent_id: &str,
        space_id: &str,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(
            r#"SELECT id, root_id, hop FROM collaboration_space_messages
               WHERE id = ? AND space_id = ?"#,
        )
        .bind(parent_id)
        .bind(space_id)
        .fetch_optional(pool)
        .await
    }

    pub(crate) async fn find_latest_non_system_in_space(
        pool: &SqlitePool,
        space_id: &str,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(
            r#"SELECT id, root_id, hop FROM collaboration_space_messages
               WHERE space_id = ? AND origin != 'system'
               ORDER BY seq DESC LIMIT 1"#,
        )
        .bind(space_id)
        .fetch_optional(pool)
        .await
    }
}

#[derive(Debug, FromRow)]
pub(crate) struct RawMessageReceiptRow {
    pub(crate) space_message_id: String,
    pub(crate) conversation_id: String,
    pub(crate) receipt_state: String,
    pub(crate) status: String,
    pub(crate) wake_deferred_turn_key: Option<String>,
    pub(crate) updated_at: Option<String>,
    pub(crate) outcome: Option<String>,
    pub(crate) deadline_at: Option<String>,
    pub(crate) turn_id: Option<String>,
    pub(crate) round_id: Option<String>,
    pub(crate) round_ordinal: Option<i64>,
    pub(crate) round_state: Option<String>,
}

impl RawMessageReceiptRow {
    pub(crate) fn into_receipt(self, state: String) -> MessageReceipt {
        MessageReceipt {
            conversation_id: self.conversation_id,
            state,
            delivered: self.status,
            updated_at: self.updated_at,
            outcome: self.outcome,
            deadline_at: self.deadline_at,
            turn_id: self.turn_id,
            round_id: self.round_id,
            round_ordinal: self.round_ordinal,
            round_state: self.round_state,
        }
    }

    pub(crate) async fn query_by_message_id(
        pool: &SqlitePool,
        message_id: &str,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(
            r#"SELECT d.space_message_id,
                      d.conversation_id,
                      d.receipt_state,
                      d.status,
                      d.wake_deferred_turn_key,
                      COALESCE(d.receipt_updated_at, d.wake_deferred_at) AS updated_at,
                      t.outcome,
                      t.deadline_at,
                      d.turn_id,
                      d.round_id,
                      d.round_ordinal,
                      r.state AS round_state
               FROM collaboration_space_deliveries d
               LEFT JOIN collaboration_turns t ON t.id = d.turn_id
               LEFT JOIN collaboration_rounds r ON r.id = d.round_id
               WHERE d.space_message_id = ?
               ORDER BY COALESCE(d.round_ordinal, 2147483647), d.conversation_id"#,
        )
        .bind(message_id)
        .fetch_all(pool)
        .await
    }

    pub(crate) async fn query_by_message_ids(
        pool: &SqlitePool,
        chunk: &[String],
    ) -> Result<Vec<Self>, sqlx::Error> {
        let mut builder = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
            r#"SELECT d.space_message_id,
                      d.conversation_id,
                      d.receipt_state,
                      d.status,
                      d.wake_deferred_turn_key,
                      COALESCE(d.receipt_updated_at, d.wake_deferred_at) AS updated_at,
                      t.outcome,
                      t.deadline_at,
                      d.turn_id,
                      d.round_id,
                      d.round_ordinal,
                      r.state AS round_state
               FROM collaboration_space_deliveries d
               LEFT JOIN collaboration_turns t ON t.id = d.turn_id
               LEFT JOIN collaboration_rounds r ON r.id = d.round_id
               WHERE d.space_message_id IN ("#,
        );
        let mut separated = builder.separated(", ");
        for mid in chunk {
            separated.push_bind(mid);
        }
        separated.push_unseparated(
            ") ORDER BY d.space_message_id, COALESCE(d.round_ordinal, 2147483647), d.conversation_id",
        );
        builder.build_query_as::<Self>().fetch_all(pool).await
    }
}

#[derive(Debug, FromRow)]
pub(crate) struct MessageHead {
    pub(crate) space_id: String,
    pub(crate) envelope_json: String,
}

impl MessageHead {
    pub(crate) async fn find_by_id(
        pool: &SqlitePool,
        message_id: &str,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(
            "SELECT space_id, envelope_json FROM collaboration_space_messages WHERE id = ?",
        )
        .bind(message_id)
        .fetch_optional(pool)
        .await
    }
}

#[derive(Debug, FromRow)]
pub(crate) struct PendingDelivery {
    pub(crate) conversation_id: String,
    pub(crate) operation_id: String,
    pub(crate) input_id: Option<String>,
    pub(crate) status: String,
    pub(crate) receipt_state: String,
    pub(crate) context_from_seq: Option<i64>,
    pub(crate) wake_deferred_turn_key: Option<String>,
    pub(crate) round_id: Option<String>,
    pub(crate) round_ordinal: Option<i64>,
    pub(crate) round_ready: i64,
}

impl PendingDelivery {
    pub(crate) async fn mark_failed(
        pool: &SqlitePool,
        message_id: &str,
        conversation_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"UPDATE collaboration_space_deliveries
               SET status = 'failed'
               WHERE space_message_id = ? AND conversation_id = ?"#,
        )
        .bind(message_id)
        .bind(conversation_id.to_string())
        .execute(pool)
        .await?;
        Ok(())
    }
}

pub(crate) struct StoredSpaceOperation {
    pub(crate) space_id: Option<String>,
    pub(crate) request_json: String,
    pub(crate) result: Value,
}

impl StoredSpaceOperation {
    pub(crate) async fn find_raw_by_id(
        pool: &SqlitePool,
        operation_id: &str,
    ) -> Result<Option<(Option<String>, String, String)>, sqlx::Error> {
        sqlx::query_as::<_, (Option<String>, String, String)>(
            r#"SELECT space_id, request_json, result_json
               FROM collaboration_space_operations WHERE operation_id = ?"#,
        )
        .bind(operation_id)
        .fetch_optional(pool)
        .await
    }

    pub(crate) async fn insert(
        pool: &SqlitePool,
        operation_id: &str,
        space_id: Option<&str>,
        request_json: &str,
        result_json: &str,
        created_at: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"INSERT INTO collaboration_space_operations
               (operation_id, space_id, request_json, result_json, created_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(operation_id) DO UPDATE SET
                   space_id = excluded.space_id,
                   request_json = excluded.request_json,
                   result_json = excluded.result_json,
                   created_at = excluded.created_at"#,
        )
        .bind(operation_id)
        .bind(space_id)
        .bind(request_json)
        .bind(result_json)
        .bind(created_at)
        .execute(pool)
        .await?;
        Ok(())
    }
}
