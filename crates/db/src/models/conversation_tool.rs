use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use ts_rs::TS;
use uuid::Uuid;

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
pub struct ConversationToolCallRecord {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub turn_id: Uuid,
    pub tool_call_id: String,
    pub title: Option<String>,
    pub kind: Option<String>,
    pub status: String,
    pub raw_input_json: Option<String>,
    pub raw_output_json: Option<String>,
    pub content_json: Option<String>,
    pub locations_json: Option<String>,
    pub metadata_json: Option<String>,
    pub images_json: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct UpsertConversationToolCall<'a> {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub turn_id: Uuid,
    pub tool_call_id: &'a str,
    pub title: Option<&'a str>,
    pub kind: Option<&'a str>,
    pub status: &'a str,
    pub raw_input_json: Option<&'a str>,
    pub raw_output_json: Option<&'a str>,
    pub content_json: Option<&'a str>,
    pub locations_json: Option<&'a str>,
    pub metadata_json: Option<&'a str>,
    pub images_json: Option<&'a str>,
}

const TOOL_COLUMNS: &str = r#"id,
    conversation_id,
    turn_id,
    tool_call_id,
    title,
    kind,
    status,
    raw_input_json,
    raw_output_json,
    content_json,
    locations_json,
    metadata_json,
    images_json,
    created_at,
    updated_at"#;

impl ConversationToolCallRecord {
    pub async fn upsert(
        pool: &SqlitePool,
        input: UpsertConversationToolCall<'_>,
    ) -> Result<Self, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"INSERT INTO conversation_tool_calls (
                   id, conversation_id, turn_id, tool_call_id, title, kind,
                   status, raw_input_json, raw_output_json, content_json,
                   locations_json, metadata_json, images_json
               )
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(conversation_id, tool_call_id) DO UPDATE SET
                   turn_id = excluded.turn_id,
                   title = COALESCE(excluded.title, conversation_tool_calls.title),
                   kind = COALESCE(excluded.kind, conversation_tool_calls.kind),
                   status = excluded.status,
                   raw_input_json = COALESCE(excluded.raw_input_json, conversation_tool_calls.raw_input_json),
                   raw_output_json = COALESCE(excluded.raw_output_json, conversation_tool_calls.raw_output_json),
                   content_json = COALESCE(excluded.content_json, conversation_tool_calls.content_json),
                   locations_json = COALESCE(excluded.locations_json, conversation_tool_calls.locations_json),
                   metadata_json = COALESCE(excluded.metadata_json, conversation_tool_calls.metadata_json),
                   images_json = COALESCE(excluded.images_json, conversation_tool_calls.images_json),
                   updated_at = datetime('now', 'subsec')
               RETURNING {TOOL_COLUMNS}"#
        ))
        .bind(input.id)
        .bind(input.conversation_id)
        .bind(input.turn_id)
        .bind(input.tool_call_id)
        .bind(input.title)
        .bind(input.kind)
        .bind(input.status)
        .bind(input.raw_input_json)
        .bind(input.raw_output_json)
        .bind(input.content_json)
        .bind(input.locations_json)
        .bind(input.metadata_json)
        .bind(input.images_json)
        .fetch_one(pool)
        .await
    }

    pub async fn list_for_turn(pool: &SqlitePool, turn_id: Uuid) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {TOOL_COLUMNS}
               FROM conversation_tool_calls
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
            r#"SELECT {TOOL_COLUMNS}
               FROM conversation_tool_calls
               WHERE conversation_id = ?
               ORDER BY created_at ASC"#
        ))
        .bind(conversation_id)
        .fetch_all(pool)
        .await
    }
}
