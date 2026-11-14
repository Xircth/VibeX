use sqlx::{FromRow, SqliteConnection, SqlitePool};
use uuid::Uuid;

#[derive(Debug, Clone, FromRow)]
pub struct ConversationTranscriptSegment {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub ordinal: i64,
    pub binding_id: Option<Uuid>,
    pub state: String,
    pub sealed_length: Option<i64>,
    pub digest: Option<String>,
}

impl ConversationTranscriptSegment {
    pub async fn list(pool: &SqlitePool, conversation_id: Uuid) -> Result<Vec<Self>, sqlx::Error> {
        Self::list_on_connection(&mut *pool.acquire().await?, conversation_id).await
    }

    pub async fn list_on_connection(
        conn: &mut SqliteConnection,
        conversation_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as("SELECT * FROM conversation_transcript_segments WHERE conversation_id = ? ORDER BY ordinal")
            .bind(conversation_id).fetch_all(conn).await
    }

    /// Files must exist before publication. The caller serializes lifecycle work
    /// with the Conversation turn lock; the unique index also rejects double writers.
    pub async fn publish(
        pool: &SqlitePool,
        conversation_id: Uuid,
        id: Uuid,
        binding_id: Option<Uuid>,
        sealed: Option<(i64, &str)>,
    ) -> Result<Self, sqlx::Error> {
        let mut tx = pool.begin().await?;
        let ordinal: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(ordinal), 0) + 1 FROM conversation_transcript_segments WHERE conversation_id = ?")
            .bind(conversation_id).fetch_one(&mut *tx).await?;
        let segment = sqlx::query_as("INSERT INTO conversation_transcript_segments (id, conversation_id, ordinal, binding_id, state, sealed_length, digest) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *")
            .bind(id).bind(conversation_id).bind(ordinal).bind(binding_id)
            .bind(if sealed.is_some() { "sealed" } else { "active" })
            .bind(sealed.map(|(len, _)| len)).bind(sealed.map(|(_, digest)| digest))
            .fetch_one(&mut *tx).await?;
        sqlx::query("UPDATE sessions SET history_revision = history_revision + 1 WHERE id = ?")
            .bind(conversation_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(segment)
    }

    pub async fn seal(
        pool: &SqlitePool,
        id: Uuid,
        length: i64,
        digest: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE conversation_transcript_segments SET state = 'sealed', sealed_length = ?, digest = ? WHERE id = ? AND state = 'active'")
            .bind(length).bind(digest).bind(id).execute(pool).await?;
        Ok(())
    }
}
