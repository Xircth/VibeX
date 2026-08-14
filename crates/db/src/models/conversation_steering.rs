use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqliteConnection, SqlitePool};
use ts_rs::TS;
use uuid::Uuid;

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationSteeringRecord {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub operation_id: Uuid,
    pub expected_turn_id: Uuid,
    pub payload_digest: String,
    pub status: String,
    pub blocks_json: String,
    pub principal_json: String,
    pub code: Option<String>,
    pub message: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

const COLUMNS: &str = r#"id, conversation_id, operation_id, expected_turn_id, payload_digest,
    status, blocks_json, principal_json, code, message, created_at, updated_at"#;

pub struct CreateConversationSteering<'a> {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub operation_id: Uuid,
    pub expected_turn_id: Uuid,
    pub payload_digest: &'a str,
    pub blocks_json: &'a str,
    pub principal_json: &'a str,
}

impl ConversationSteeringRecord {
    pub async fn create_on_connection(
        conn: &mut SqliteConnection,
        input: CreateConversationSteering<'_>,
    ) -> Result<Self, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"INSERT INTO conversation_steering (
                   id, conversation_id, operation_id, expected_turn_id, payload_digest,
                   status, blocks_json, principal_json
               ) VALUES (?, ?, ?, ?, ?, 'requested', ?, ?)
               RETURNING {COLUMNS}"#
        ))
        .bind(input.id)
        .bind(input.conversation_id)
        .bind(input.operation_id)
        .bind(input.expected_turn_id)
        .bind(input.payload_digest)
        .bind(input.blocks_json)
        .bind(input.principal_json)
        .fetch_one(&mut *conn)
        .await
    }

    pub async fn settle_on_connection(
        conn: &mut SqliteConnection,
        conversation_id: Uuid,
        id: Uuid,
        expected_turn_id: Uuid,
        status: &str,
        code: Option<&str>,
        message: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        let result = sqlx::query(
            r#"UPDATE conversation_steering
               SET status = ?, code = ?, message = ?,
                   updated_at = datetime('now', 'subsec')
               WHERE id = ? AND conversation_id = ? AND expected_turn_id = ?
                 AND status = 'requested'"#,
        )
        .bind(status)
        .bind(code)
        .bind(message)
        .bind(id)
        .bind(conversation_id)
        .bind(expected_turn_id)
        .execute(&mut *conn)
        .await?;
        if result.rows_affected() != 1 {
            return Err(sqlx::Error::Protocol(
                "steering receipt is missing or already terminal".to_string(),
            ));
        }
        Ok(())
    }

    pub async fn find_by_operation(
        pool: &SqlitePool,
        conversation_id: Uuid,
        operation_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            "SELECT {COLUMNS} FROM conversation_steering WHERE conversation_id = ? AND operation_id = ?"
        ))
        .bind(conversation_id)
        .bind(operation_id)
        .fetch_optional(pool)
        .await
    }

    pub async fn find_by_id(
        pool: &SqlitePool,
        conversation_id: Uuid,
        id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            "SELECT {COLUMNS} FROM conversation_steering WHERE conversation_id = ? AND id = ?"
        ))
        .bind(conversation_id)
        .bind(id)
        .fetch_optional(pool)
        .await
    }
}
