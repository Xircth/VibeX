use sqlx::{Executor, FromRow, Sqlite};
use uuid::Uuid;

/// Materialized projection snapshot row for one conversation.
///
/// Stores the folded projection state (`fold_json`) up to `last_sequence` so timeline
/// reads can resume from the snapshot and replay only the tail instead of the whole
/// event log. See migration `20260618000000_conversation_projection_snapshot.sql`.
#[derive(Debug, Clone, FromRow)]
pub struct ConversationProjectionSnapshotRecord {
    pub conversation_id: Uuid,
    pub projection_version: i64,
    pub last_sequence: i64,
    pub fold_json: String,
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
            r#"SELECT conversation_id, projection_version, last_sequence, fold_json
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
    ) -> Result<(), sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        sqlx::query(
            r#"INSERT INTO conversation_projection_snapshots (
                   conversation_id, projection_version, last_sequence, fold_json
               )
               VALUES (?, ?, ?, ?)
               ON CONFLICT(conversation_id) DO UPDATE SET
                   projection_version = excluded.projection_version,
                   last_sequence = excluded.last_sequence,
                   fold_json = excluded.fold_json,
                   updated_at = datetime('now', 'subsec')"#,
        )
        .bind(conversation_id)
        .bind(projection_version)
        .bind(last_sequence)
        .bind(fold_json)
        .execute(executor)
        .await?;
        Ok(())
    }
}
