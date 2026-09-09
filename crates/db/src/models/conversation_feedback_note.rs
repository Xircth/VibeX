use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqliteConnection, SqlitePool};
use uuid::Uuid;

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct ConversationFeedbackNoteRecord {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub operation_id: Uuid,
    pub turn_id: Option<Uuid>,
    pub text: String,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub delivered_at: Option<DateTime<Utc>>,
    pub salvaged_input_id: Option<Uuid>,
}

const COLUMNS: &str = r#"id, conversation_id, operation_id, turn_id, text, status,
    created_at, updated_at, delivered_at, salvaged_input_id"#;

pub struct CreateConversationFeedbackNote<'a> {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub operation_id: Uuid,
    pub turn_id: Option<Uuid>,
    pub text: &'a str,
}

impl ConversationFeedbackNoteRecord {
    pub async fn create_pending(
        conn: &mut SqliteConnection,
        input: CreateConversationFeedbackNote<'_>,
    ) -> Result<Self, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"INSERT INTO conversation_feedback_note (
                   id, conversation_id, operation_id, turn_id, text, status
               ) VALUES (?, ?, ?, ?, ?, 'pending')
               RETURNING {COLUMNS}"#
        ))
        .bind(input.id)
        .bind(input.conversation_id)
        .bind(input.operation_id)
        .bind(input.turn_id)
        .bind(input.text)
        .fetch_one(&mut *conn)
        .await
    }

    pub async fn list_for_conversation(
        pool: &SqlitePool,
        conversation_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {COLUMNS} FROM conversation_feedback_note
               WHERE conversation_id = ?
               ORDER BY created_at ASC"#
        ))
        .bind(conversation_id)
        .fetch_all(pool)
        .await
    }

    pub async fn list_pending(
        pool: &SqlitePool,
        conversation_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {COLUMNS} FROM conversation_feedback_note
               WHERE conversation_id = ? AND status = 'pending'
               ORDER BY created_at ASC"#
        ))
        .bind(conversation_id)
        .fetch_all(pool)
        .await
    }

    pub async fn settle_pending(
        pool: &SqlitePool,
        conversation_id: Uuid,
        ids: &[Uuid],
        status: &str,
        salvaged_input_id: Option<Uuid>,
    ) -> Result<u64, sqlx::Error> {
        if ids.is_empty() {
            return Ok(0);
        }
        let mut updated = 0;
        for id in ids {
            let result = sqlx::query(
                r#"UPDATE conversation_feedback_note
                   SET status = ?,
                       delivered_at = CASE WHEN ? = 'delivered' THEN datetime('now', 'subsec') ELSE delivered_at END,
                       salvaged_input_id = COALESCE(?, salvaged_input_id),
                       updated_at = datetime('now', 'subsec')
                   WHERE id = ? AND conversation_id = ? AND status IN ('pending', 'expired')"#,
            )
            .bind(status)
            .bind(status)
            .bind(salvaged_input_id)
            .bind(id)
            .bind(conversation_id)
            .execute(pool)
            .await?;
            updated += result.rows_affected();
        }
        Ok(updated)
    }

    pub async fn expire_pending_for_conversation(
        pool: &SqlitePool,
        conversation_id: Uuid,
    ) -> Result<Vec<Uuid>, sqlx::Error> {
        let pending = Self::list_pending(pool, conversation_id).await?;
        let ids: Vec<Uuid> = pending.iter().map(|note| note.id).collect();
        if !ids.is_empty() {
            let _ = Self::settle_pending(pool, conversation_id, &ids, "expired", None).await?;
        }
        Ok(ids)
    }
}
