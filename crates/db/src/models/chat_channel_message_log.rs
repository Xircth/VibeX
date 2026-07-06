//! IM chat-channel delivery/audit log (P2-7). Runtime sqlx queries.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use ts_rs::TS;
use uuid::Uuid;

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ChatChannelMessageLog {
    pub id: Uuid,
    pub channel_id: String,
    /// `outbound` | `inbound`.
    pub direction: String,
    pub event: Option<String>,
    /// `sent` | `failed` | `ok` | `rejected`.
    pub status: String,
    pub detail: Option<String>,
    pub created_at: DateTime<Utc>,
}

const COLS: &str = "id, channel_id, direction, event, status, detail, created_at";

impl ChatChannelMessageLog {
    #[allow(clippy::too_many_arguments)]
    pub async fn record(
        pool: &SqlitePool,
        channel_id: &str,
        direction: &str,
        event: Option<&str>,
        status: &str,
        detail: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO chat_channel_message_log \
             (id, channel_id, direction, event, status, detail, created_at) \
             VALUES (?,?,?,?,?,?,?)",
        )
        .bind(Uuid::new_v4())
        .bind(channel_id)
        .bind(direction)
        .bind(event)
        .bind(status)
        .bind(detail)
        .bind(Utc::now())
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn list_recent(
        pool: &SqlitePool,
        channel_id: &str,
        limit: i64,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            "SELECT {COLS} FROM chat_channel_message_log \
             WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?"
        ))
        .bind(channel_id)
        .bind(limit)
        .fetch_all(pool)
        .await
    }
}
