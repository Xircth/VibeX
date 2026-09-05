use chrono::{DateTime, Utc};
use sqlx::{Executor, FromRow, Sqlite, SqliteConnection};
use uuid::Uuid;

/// Incremental protocol-usage read model for one conversation (ADR-0075).
///
/// Token columns stay `NULL` when the Agent did not provide a breakdown.
/// `context_used` / `context_window_max` are occupancy and are never treated as
/// token totals.
#[derive(Debug, Clone, FromRow)]
pub struct ConversationUsageSnapshotRecord {
    pub conversation_id: Uuid,
    pub last_sequence: i64,
    pub protocol_input_tokens: Option<i64>,
    pub protocol_output_tokens: Option<i64>,
    pub protocol_cache_write_tokens: Option<i64>,
    pub protocol_cache_read_tokens: Option<i64>,
    pub protocol_total_tokens: Option<i64>,
    pub context_used: Option<i64>,
    pub context_window_max: Option<i64>,
    pub protocol_cost_amount: Option<f64>,
    pub protocol_cost_currency: Option<String>,
    pub model: Option<String>,
    pub last_usage_at: Option<String>,
}

#[derive(Debug, Clone, FromRow)]
pub struct ConversationUsageAttributionRow {
    pub session_id: Uuid,
    pub workspace_id: Uuid,
    pub project_id: Uuid,
    pub container_ref: Option<String>,
    pub agent_id: Option<String>,
    pub model: Option<String>,
    pub external_session_id: Option<String>,
    pub session_name: Option<String>,
    pub session_created_at: DateTime<Utc>,
    pub session_updated_at: DateTime<Utc>,
    pub protocol_input_tokens: Option<i64>,
    pub protocol_output_tokens: Option<i64>,
    pub protocol_cache_write_tokens: Option<i64>,
    pub protocol_cache_read_tokens: Option<i64>,
    pub protocol_total_tokens: Option<i64>,
    pub context_used: Option<i64>,
    pub context_window_max: Option<i64>,
    pub protocol_cost_amount: Option<f64>,
    pub protocol_cost_currency: Option<String>,
    pub snapshot_model: Option<String>,
    pub last_usage_at: Option<String>,
}

const SNAPSHOT_COLUMNS: &str = r#"conversation_id,
    last_sequence,
    protocol_input_tokens,
    protocol_output_tokens,
    protocol_cache_write_tokens,
    protocol_cache_read_tokens,
    protocol_total_tokens,
    context_used,
    context_window_max,
    protocol_cost_amount,
    protocol_cost_currency,
    model,
    last_usage_at"#;

const ATTRIBUTION_COLUMNS: &str = r#"s.id AS session_id,
    s.workspace_id,
    w.project_id,
    w.container_ref,
    s.agent_id,
    s.model,
    s.external_session_id,
    s.name AS session_name,
    s.created_at AS session_created_at,
    s.updated_at AS session_updated_at,
    u.protocol_input_tokens,
    u.protocol_output_tokens,
    u.protocol_cache_write_tokens,
    u.protocol_cache_read_tokens,
    u.protocol_total_tokens,
    u.context_used,
    u.context_window_max,
    u.protocol_cost_amount,
    u.protocol_cost_currency,
    u.model AS snapshot_model,
    u.last_usage_at"#;

impl ConversationUsageSnapshotRecord {
    pub async fn find<'e, E>(
        executor: E,
        conversation_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {SNAPSHOT_COLUMNS}
               FROM conversation_usage_snapshots
               WHERE conversation_id = ?"#
        ))
        .bind(conversation_id)
        .fetch_optional(executor)
        .await
    }

    /// Insert or replace the snapshot for one conversation.
    pub async fn upsert(conn: &mut SqliteConnection, row: &Self) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"INSERT INTO conversation_usage_snapshots (
                   conversation_id,
                   last_sequence,
                   protocol_input_tokens,
                   protocol_output_tokens,
                   protocol_cache_write_tokens,
                   protocol_cache_read_tokens,
                   protocol_total_tokens,
                   context_used,
                   context_window_max,
                   protocol_cost_amount,
                   protocol_cost_currency,
                   model,
                   last_usage_at
               )
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(conversation_id) DO UPDATE SET
                   last_sequence = excluded.last_sequence,
                   protocol_input_tokens = excluded.protocol_input_tokens,
                   protocol_output_tokens = excluded.protocol_output_tokens,
                   protocol_cache_write_tokens = excluded.protocol_cache_write_tokens,
                   protocol_cache_read_tokens = excluded.protocol_cache_read_tokens,
                   protocol_total_tokens = excluded.protocol_total_tokens,
                   context_used = excluded.context_used,
                   context_window_max = excluded.context_window_max,
                   protocol_cost_amount = excluded.protocol_cost_amount,
                   protocol_cost_currency = excluded.protocol_cost_currency,
                   model = excluded.model,
                   last_usage_at = excluded.last_usage_at,
                   updated_at = datetime('now', 'subsec')"#,
        )
        .bind(row.conversation_id)
        .bind(row.last_sequence)
        .bind(row.protocol_input_tokens)
        .bind(row.protocol_output_tokens)
        .bind(row.protocol_cache_write_tokens)
        .bind(row.protocol_cache_read_tokens)
        .bind(row.protocol_total_tokens)
        .bind(row.context_used)
        .bind(row.context_window_max)
        .bind(row.protocol_cost_amount)
        .bind(row.protocol_cost_currency.as_deref())
        .bind(row.model.as_deref())
        .bind(row.last_usage_at.as_deref())
        .execute(&mut *conn)
        .await?;
        Ok(())
    }

    pub async fn delete_for_conversation(
        conn: &mut SqliteConnection,
        conversation_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM conversation_usage_snapshots WHERE conversation_id = ?")
            .bind(conversation_id)
            .execute(&mut *conn)
            .await?;
        Ok(())
    }

    /// Sessions that belong to a project (or every project when `project_id` is
    /// `None`), joined to workspaces and the usage snapshot. Attribution is the
    /// workspace relation, never a path match.
    pub async fn list_attributed<'e, E>(
        executor: E,
        project_id: Option<Uuid>,
    ) -> Result<Vec<ConversationUsageAttributionRow>, sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        sqlx::query_as::<_, ConversationUsageAttributionRow>(&format!(
            r#"SELECT {ATTRIBUTION_COLUMNS}
               FROM sessions s
               INNER JOIN workspaces w ON w.id = s.workspace_id
               LEFT JOIN conversation_usage_snapshots u ON u.conversation_id = s.id
               WHERE s.deleted_at IS NULL
                 AND (? IS NULL OR w.project_id = ?)
               ORDER BY s.updated_at DESC, s.created_at DESC"#
        ))
        .bind(project_id)
        .bind(project_id)
        .fetch_all(executor)
        .await
    }
}

#[derive(Debug, Clone, FromRow)]
pub struct StaleUsageEventRow {
    pub conversation_id: Uuid,
    pub sequence: i64,
    pub normalized_json: String,
    pub created_at: DateTime<Utc>,
}

impl StaleUsageEventRow {
    /// `usage_updated` events that the snapshot has not yet folded.
    pub async fn list_pending<'e, E>(executor: E) -> Result<Vec<Self>, sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        sqlx::query_as::<_, Self>(
            r#"SELECT e.conversation_id, e.sequence, e.normalized_json, e.created_at
               FROM conversation_events e
               LEFT JOIN conversation_usage_snapshots s
                   ON s.conversation_id = e.conversation_id
               WHERE e.event_kind = 'usage_updated'
                 AND (s.conversation_id IS NULL OR e.sequence > s.last_sequence)
               ORDER BY e.conversation_id, e.sequence"#,
        )
        .fetch_all(executor)
        .await
    }
}
