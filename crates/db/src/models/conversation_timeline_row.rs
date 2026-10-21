use sqlx::{Executor, FromRow, Sqlite, SqliteConnection};
use uuid::Uuid;

/// One materialized timeline row for a conversation.
///
/// `row_json` is a serialized `TimelineRow`. The conversations crate owns that
/// type; this table is a dumb derived cache keyed by `sort_index`.
#[derive(Debug, Clone, FromRow)]
pub struct ConversationTimelineRowRecord {
    pub conversation_id: Uuid,
    pub sort_index: i64,
    pub row_id: String,
    pub revision: i64,
    pub row_json: String,
}

pub struct NewConversationTimelineRow<'a> {
    pub sort_index: i64,
    pub row_id: &'a str,
    pub revision: i64,
    pub row_json: &'a str,
}

impl ConversationTimelineRowRecord {
    pub async fn replace_all(
        conn: &mut SqliteConnection,
        conversation_id: Uuid,
        rows: &[NewConversationTimelineRow<'_>],
    ) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM conversation_timeline_rows WHERE conversation_id = ?")
            .bind(conversation_id)
            .execute(&mut *conn)
            .await?;
        for row in rows {
            sqlx::query(
                r#"INSERT INTO conversation_timeline_rows (
                       conversation_id, sort_index, row_id, revision, row_json
                   )
                   VALUES (?, ?, ?, ?, ?)"#,
            )
            .bind(conversation_id)
            .bind(row.sort_index)
            .bind(row.row_id)
            .bind(row.revision)
            .bind(row.row_json)
            .execute(&mut *conn)
            .await?;
        }
        Ok(())
    }

    pub async fn list_range<'e, E>(
        executor: E,
        conversation_id: Uuid,
        start: i64,
        limit: i64,
    ) -> Result<Vec<Self>, sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        sqlx::query_as::<_, Self>(
            r#"SELECT conversation_id, sort_index, row_id, revision, row_json
               FROM conversation_timeline_rows
               WHERE conversation_id = ?
               ORDER BY sort_index ASC
               LIMIT ? OFFSET ?"#,
        )
        .bind(conversation_id)
        .bind(limit.max(0))
        .bind(start.max(0))
        .fetch_all(executor)
        .await
    }

    pub async fn list_tail<'e, E>(
        executor: E,
        conversation_id: Uuid,
        limit: i64,
    ) -> Result<Vec<Self>, sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        let mut rows = sqlx::query_as::<_, Self>(
            r#"SELECT conversation_id, sort_index, row_id, revision, row_json
               FROM conversation_timeline_rows
               WHERE conversation_id = ?
               ORDER BY sort_index DESC
               LIMIT ?"#,
        )
        .bind(conversation_id)
        .bind(limit.max(0))
        .fetch_all(executor)
        .await?;
        rows.reverse();
        Ok(rows)
    }

    pub async fn list_changed_since<'e, E>(
        executor: E,
        conversation_id: Uuid,
        after_revision: i64,
    ) -> Result<Vec<Self>, sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        sqlx::query_as::<_, Self>(
            r#"SELECT conversation_id, sort_index, row_id, revision, row_json
               FROM conversation_timeline_rows
               WHERE conversation_id = ?
                 AND revision > ?
               ORDER BY sort_index ASC"#,
        )
        .bind(conversation_id)
        .bind(after_revision)
        .fetch_all(executor)
        .await
    }

    pub async fn list_non_message_rows<'e, E>(
        executor: E,
        conversation_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        sqlx::query_as::<_, Self>(
            r#"SELECT conversation_id, sort_index, row_id, revision, row_json
               FROM conversation_timeline_rows
               WHERE conversation_id = ?
                 AND row_id NOT LIKE '%:user'
                 AND row_id NOT LIKE '%:assistant%'
                 AND row_id NOT LIKE '%:steer:%'
               ORDER BY sort_index ASC"#,
        )
        .bind(conversation_id)
        .fetch_all(executor)
        .await
    }

    pub async fn count<'e, E>(executor: E, conversation_id: Uuid) -> Result<i64, sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM conversation_timeline_rows WHERE conversation_id = ?",
        )
        .bind(conversation_id)
        .fetch_one(executor)
        .await
    }
}
