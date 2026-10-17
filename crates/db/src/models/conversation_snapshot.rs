use sqlx::{Executor, FromRow, Sqlite};
use uuid::Uuid;

/// Materialized projection snapshot row for one conversation.
///
/// Stores the folded projection state (`fold_json`) up to `last_sequence` so
/// IncrementalRowProjector can resume, plus open-window metadata so timeline
/// reads do not deserialize the full fold. See migrations
/// `20260618000000_conversation_projection_snapshot.sql` and
/// `20261017010000_conversation_timeline_rows.sql`.
#[derive(Debug, Clone, FromRow)]
pub struct ConversationProjectionSnapshotRecord {
    pub conversation_id: Uuid,
    pub projection_version: i64,
    pub last_sequence: i64,
    pub fold_json: String,
    pub total_rows: i64,
    pub session_stats_json: Option<String>,
}

impl ConversationProjectionSnapshotRecord {
    /// Load the snapshot for a conversation, if one has been materialized.
    ///
    /// Generic over the executor so it works both against a pool (read path) and a
    /// connection inside the append transaction (snapshot refresh).
    pub async fn find<'e, E>(
        executor: E,
        conversation_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        sqlx::query_as::<_, Self>(
            r#"SELECT conversation_id, projection_version, last_sequence, fold_json,
                      total_rows, session_stats_json
               FROM conversation_projection_snapshots
               WHERE conversation_id = ?"#,
        )
        .bind(conversation_id)
        .fetch_optional(executor)
        .await
    }

    /// Insert or replace the snapshot for a conversation.
    pub async fn upsert<'e, E>(
        executor: E,
        conversation_id: Uuid,
        projection_version: i64,
        last_sequence: i64,
        fold_json: &str,
        total_rows: i64,
        session_stats_json: Option<&str>,
    ) -> Result<(), sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        sqlx::query(
            r#"INSERT INTO conversation_projection_snapshots (
                   conversation_id, projection_version, last_sequence, fold_json,
                   total_rows, session_stats_json
               )
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(conversation_id) DO UPDATE SET
                   projection_version = excluded.projection_version,
                   last_sequence = excluded.last_sequence,
                   fold_json = excluded.fold_json,
                   total_rows = excluded.total_rows,
                   session_stats_json = excluded.session_stats_json,
                   updated_at = datetime('now', 'subsec')"#,
        )
        .bind(conversation_id)
        .bind(projection_version)
        .bind(last_sequence)
        .bind(fold_json)
        .bind(total_rows)
        .bind(session_stats_json)
        .execute(executor)
        .await?;
        Ok(())
    }
}
