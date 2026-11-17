use sqlx::{Executor, FromRow, Row, Sqlite, SqliteConnection};
use uuid::Uuid;

use crate::{ReadPool, WritePool};

pub const SORT_INDEX_SLOT_SPAN: i64 = 1_000_000;

/// Compute the inclusive `[lower_bound, upper_bound]` `sort_index` range for a row.
///
/// - `turn_ordinal = Some(ordinal)` (1-based) -> `[ordinal * 1_000_000, ordinal * 1_000_000 + 999_999]`
/// - `turn_ordinal = None` (global `side_rows`) -> `[0, 999_999]`
pub const fn sort_index_bounds(turn_ordinal: Option<i64>) -> (i64, i64) {
    match turn_ordinal {
        Some(ordinal) => {
            let ord = if ordinal < 1 { 1 } else { ordinal };
            let lower = ord * SORT_INDEX_SLOT_SPAN;
            (lower, lower + SORT_INDEX_SLOT_SPAN - 1)
        }
        None => (0, SORT_INDEX_SLOT_SPAN - 1),
    }
}

/// One materialized timeline row for a conversation.
///
/// `row_json` is a serialized `TimelineRow` (capped at 32 KiB for open/window read views).
#[derive(Debug, Clone, PartialEq, Eq, FromRow)]
pub struct ConversationTimelineRowRecord {
    pub conversation_id: Uuid,
    pub sort_index: i64,
    pub row_id: String,
    pub revision: i64,
    pub row_json: String,
    #[sqlx(default)]
    pub deleted_sequence: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, FromRow)]
pub struct TombstoneTimelineRowRecord {
    pub conversation_id: Uuid,
    pub sort_index: i64,
    pub row_id: String,
    pub revision: i64,
    pub deleted_sequence: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RowsSinceResult {
    pub upserts: Vec<ConversationTimelineRowRecord>,
    pub tombstones: Vec<TombstoneTimelineRowRecord>,
}

pub struct NewConversationTimelineRow<'a> {
    pub sort_index: i64,
    pub row_id: &'a str,
    pub revision: i64,
    pub row_json: &'a str,
}

impl ConversationTimelineRowRecord {
    /// Cold-rebuild full replacement only (never called on hot event append or turn settle).
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
                       conversation_id, sort_index, row_id, revision, row_json, deleted_sequence
                   )
                   VALUES (?, ?, ?, ?, ?, NULL)"#,
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

    /// Insert a new row at the next free slot in `[lower_bound, upper_bound]`, or update
    /// `(revision, row_json, deleted_sequence = NULL)` on conflict while preserving `sort_index`
    /// whenever it already resides in `[lower_bound, upper_bound]`.
    pub async fn upsert_row_on_conn(
        conn: &mut SqliteConnection,
        conversation_id: Uuid,
        turn_ordinal: Option<i64>,
        row_id: &str,
        revision: i64,
        row_json: &str,
    ) -> Result<i64, sqlx::Error> {
        let (lower_bound, upper_bound) = sort_index_bounds(turn_ordinal);
        sqlx::query_scalar::<_, i64>(
            r#"INSERT INTO conversation_timeline_rows (
                   conversation_id, sort_index, row_id, revision, row_json, deleted_sequence
               )
               VALUES (
                   ?1,
                   COALESCE(
                       (SELECT sort_index
                          FROM conversation_timeline_rows
                         WHERE conversation_id = ?1
                           AND row_id = ?2
                           AND sort_index >= ?3
                           AND sort_index <= ?4),
                       COALESCE(
                           (SELECT MAX(sort_index)
                              FROM conversation_timeline_rows
                             WHERE conversation_id = ?1
                               AND sort_index >= ?3
                               AND sort_index <= ?4),
                           ?3
                       ) + 1
                   ),
                   ?2,
                   ?5,
                   ?6,
                   NULL
               )
               ON CONFLICT(conversation_id, row_id) DO UPDATE SET
                   sort_index = excluded.sort_index,
                   revision = excluded.revision,
                   row_json = excluded.row_json,
                   deleted_sequence = NULL
               RETURNING sort_index"#,
        )
        .bind(conversation_id)
        .bind(row_id)
        .bind(lower_bound)
        .bind(upper_bound)
        .bind(revision)
        .bind(row_json)
        .fetch_one(&mut *conn)
        .await
    }

    /// Pool-level convenience wrapper around [`Self::upsert_row_on_conn`] restricted at
    /// compile time to [`WritePool`].
    pub async fn upsert_row(
        writer: &WritePool,
        conversation_id: Uuid,
        turn_ordinal: Option<i64>,
        row_id: &str,
        revision: i64,
        row_json: &str,
    ) -> Result<i64, sqlx::Error> {
        let mut conn = writer.acquire().await?;
        Self::upsert_row_on_conn(
            &mut conn,
            conversation_id,
            turn_ordinal,
            row_id,
            revision,
            row_json,
        )
        .await
    }

    /// Mark an existing row as a soft-deleted tombstone at `deleted_sequence`.
    pub async fn soft_delete_row_on_conn(
        conn: &mut SqliteConnection,
        conversation_id: Uuid,
        row_id: &str,
        deleted_sequence: i64,
    ) -> Result<u64, sqlx::Error> {
        let res = sqlx::query(
            r#"UPDATE conversation_timeline_rows
                  SET revision = ?1,
                      deleted_sequence = ?1
                WHERE conversation_id = ?2
                  AND row_id = ?3"#,
        )
        .bind(deleted_sequence)
        .bind(conversation_id)
        .bind(row_id)
        .execute(&mut *conn)
        .await?;
        Ok(res.rows_affected())
    }

    /// Pool-level convenience wrapper around [`Self::soft_delete_row_on_conn`] restricted at
    /// compile time to [`WritePool`].
    pub async fn soft_delete_row(
        writer: &WritePool,
        conversation_id: Uuid,
        row_id: &str,
        deleted_sequence: i64,
    ) -> Result<u64, sqlx::Error> {
        let mut conn = writer.acquire().await?;
        Self::soft_delete_row_on_conn(&mut conn, conversation_id, row_id, deleted_sequence).await
    }

    /// Soft-delete all active rows at or after `min_sort_index` (used by `truncate_to_turn_ordinal`
    /// where `min_sort_index = turn_ordinal * 1_000_000`) and return their `row_id`s so FTS entries
    /// can be cleaned up in the same transaction.
    pub async fn soft_delete_from_sort_index_on_conn(
        conn: &mut SqliteConnection,
        conversation_id: Uuid,
        min_sort_index: i64,
        deleted_sequence: i64,
    ) -> Result<Vec<String>, sqlx::Error> {
        sqlx::query_scalar::<_, String>(
            r#"UPDATE conversation_timeline_rows
                  SET revision = ?1,
                      deleted_sequence = ?1
                WHERE conversation_id = ?2
                  AND sort_index >= ?3
                  AND deleted_sequence IS NULL
            RETURNING row_id"#,
        )
        .bind(deleted_sequence)
        .bind(conversation_id)
        .bind(min_sort_index)
        .fetch_all(&mut *conn)
        .await
    }

    /// Incremental catch-up query on [`ReadPool`]: returns both active upserts (`revision > after_sequence`)
    /// and soft-delete tombstones (`deleted_sequence > after_sequence`) in deterministic `sort_index` order.
    pub async fn rows_since(
        reader: &ReadPool,
        conversation_id: Uuid,
        after_sequence: i64,
    ) -> Result<RowsSinceResult, sqlx::Error> {
        Self::rows_since_executor(reader.as_pool(), conversation_id, after_sequence).await
    }

    pub async fn rows_since_executor<'e, E>(
        executor: E,
        conversation_id: Uuid,
        after_sequence: i64,
    ) -> Result<RowsSinceResult, sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        let raw_rows = sqlx::query(
            r#"SELECT conversation_id, sort_index, row_id, revision, row_json, deleted_sequence
                 FROM conversation_timeline_rows
                WHERE conversation_id = ?1
                  AND revision > ?2
                  AND deleted_sequence IS NULL
               UNION ALL
               SELECT conversation_id, sort_index, row_id, revision, '' AS row_json, deleted_sequence
                 FROM conversation_timeline_rows
                WHERE conversation_id = ?1
                  AND deleted_sequence > ?2
                ORDER BY sort_index ASC"#,
        )
        .bind(conversation_id)
        .bind(after_sequence)
        .fetch_all(executor)
        .await?;

        Self::decode_rows_since_rows(raw_rows)
    }

    /// Bounded incremental catch-up query: returns at most `limit` combined upserts and tombstones,
    /// plus `truncated = true` when more rows exist beyond `limit`.
    pub async fn rows_since_limited_executor<'e, E>(
        executor: E,
        conversation_id: Uuid,
        after_sequence: i64,
        limit: usize,
    ) -> Result<(RowsSinceResult, bool), sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        let fetch_limit = i64::try_from(limit.saturating_add(1)).unwrap_or(i64::MAX);
        let mut raw_rows = sqlx::query(
            r#"SELECT conversation_id, sort_index, row_id, revision, row_json, deleted_sequence
                 FROM conversation_timeline_rows
                WHERE conversation_id = ?1
                  AND revision > ?2
                  AND deleted_sequence IS NULL
               UNION ALL
               SELECT conversation_id, sort_index, row_id, revision, '' AS row_json, deleted_sequence
                 FROM conversation_timeline_rows
                WHERE conversation_id = ?1
                  AND deleted_sequence > ?2
                ORDER BY sort_index ASC
                LIMIT ?3"#,
        )
        .bind(conversation_id)
        .bind(after_sequence)
        .bind(fetch_limit)
        .fetch_all(executor)
        .await?;

        let truncated = raw_rows.len() > limit;
        if truncated {
            raw_rows.truncate(limit);
        }
        Ok((Self::decode_rows_since_rows(raw_rows)?, truncated))
    }

    fn decode_rows_since_rows(
        raw_rows: Vec<sqlx::sqlite::SqliteRow>,
    ) -> Result<RowsSinceResult, sqlx::Error> {
        let mut out = RowsSinceResult::default();
        for row in raw_rows {
            let deleted_sequence: Option<i64> = row.try_get("deleted_sequence")?;
            let cid: Uuid = row.try_get("conversation_id")?;
            let sort_index: i64 = row.try_get("sort_index")?;
            let row_id: String = row.try_get("row_id")?;
            let revision: i64 = row.try_get("revision")?;
            if let Some(deleted_sequence) = deleted_sequence {
                out.tombstones.push(TombstoneTimelineRowRecord {
                    conversation_id: cid,
                    sort_index,
                    row_id,
                    revision,
                    deleted_sequence,
                });
            } else {
                let row_json: String = row.try_get("row_json")?;
                out.upserts.push(ConversationTimelineRowRecord {
                    conversation_id: cid,
                    sort_index,
                    row_id,
                    revision,
                    row_json,
                    deleted_sequence: None,
                });
            }
        }
        Ok(out)
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
            r#"SELECT conversation_id, sort_index, row_id, revision, row_json, deleted_sequence
               FROM conversation_timeline_rows
               WHERE conversation_id = ?
                 AND deleted_sequence IS NULL
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
            r#"SELECT conversation_id, sort_index, row_id, revision, row_json, deleted_sequence
               FROM conversation_timeline_rows
               WHERE conversation_id = ?
                 AND deleted_sequence IS NULL
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

    /// Active session-level side rows (`sort_index < SORT_INDEX_SLOT_SPAN`) such as runtime
    /// status banners and binding load-failure notices.
    pub async fn list_slot_zero<'e, E>(
        executor: E,
        conversation_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        sqlx::query_as::<_, Self>(
            r#"SELECT conversation_id, sort_index, row_id, revision, row_json, deleted_sequence
               FROM conversation_timeline_rows
               WHERE conversation_id = ?1
                 AND sort_index < ?2
                 AND deleted_sequence IS NULL
               ORDER BY sort_index ASC"#,
        )
        .bind(conversation_id)
        .bind(SORT_INDEX_SLOT_SPAN)
        .fetch_all(executor)
        .await
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
            r#"SELECT conversation_id, sort_index, row_id, revision, row_json, deleted_sequence
               FROM conversation_timeline_rows
               WHERE conversation_id = ?
                 AND revision > ?
                 AND deleted_sequence IS NULL
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
            r#"SELECT conversation_id, sort_index, row_id, revision, row_json, deleted_sequence
               FROM conversation_timeline_rows
               WHERE conversation_id = ?
                 AND deleted_sequence IS NULL
                 AND row_id NOT LIKE '%:user'
                 AND row_id NOT LIKE '%:assistant%'
                 AND row_id NOT LIKE '%:steer:%'
               ORDER BY sort_index ASC"#,
        )
        .bind(conversation_id)
        .fetch_all(executor)
        .await
    }

    pub async fn list_before_keyset<'e, E>(
        executor: E,
        conversation_id: Uuid,
        before_sort_index: i64,
        before_row_id: &str,
        limit: i64,
    ) -> Result<Vec<Self>, sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        let mut rows = sqlx::query_as::<_, Self>(
            r#"SELECT conversation_id, sort_index, row_id, revision, row_json, deleted_sequence
               FROM conversation_timeline_rows
               WHERE conversation_id = ?1
                 AND deleted_sequence IS NULL
                 AND (sort_index < ?2 OR (sort_index = ?2 AND row_id < ?3))
               ORDER BY sort_index DESC, row_id DESC
               LIMIT ?4"#,
        )
        .bind(conversation_id)
        .bind(before_sort_index)
        .bind(before_row_id)
        .bind(limit.max(0))
        .fetch_all(executor)
        .await?;
        rows.reverse();
        Ok(rows)
    }

    pub async fn has_older_before_keyset<'e, E>(
        executor: E,
        conversation_id: Uuid,
        before_sort_index: i64,
        before_row_id: &str,
    ) -> Result<bool, sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        let exists = sqlx::query_scalar::<_, i64>(
            r#"SELECT EXISTS(
                   SELECT 1
                     FROM conversation_timeline_rows
                    WHERE conversation_id = ?1
                      AND deleted_sequence IS NULL
                      AND (sort_index < ?2 OR (sort_index = ?2 AND row_id < ?3))
               )"#,
        )
        .bind(conversation_id)
        .bind(before_sort_index)
        .bind(before_row_id)
        .fetch_one(executor)
        .await?;
        Ok(exists != 0)
    }

    pub async fn list_all_active<'e, E>(
        executor: E,
        conversation_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        sqlx::query_as::<_, Self>(
            r#"SELECT conversation_id, sort_index, row_id, revision, row_json, deleted_sequence
               FROM conversation_timeline_rows
               WHERE conversation_id = ?
                 AND deleted_sequence IS NULL
               ORDER BY sort_index ASC, row_id ASC"#,
        )
        .bind(conversation_id)
        .fetch_all(executor)
        .await
    }

    pub async fn fetch_all_active<'e, E>(
        executor: E,
        conversation_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        Self::list_all_active(executor, conversation_id).await
    }

    pub async fn count<'e, E>(executor: E, conversation_id: Uuid) -> Result<i64, sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM conversation_timeline_rows
              WHERE conversation_id = ? AND deleted_sequence IS NULL",
        )
        .bind(conversation_id)
        .fetch_one(executor)
        .await
    }

    pub async fn count_visible_message_rows<'e, E>(
        executor: E,
        conversation_id: Uuid,
    ) -> Result<i64, sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        sqlx::query_scalar::<_, i64>(
            r#"SELECT COUNT(*)
                 FROM conversation_timeline_rows
                WHERE conversation_id = ?
                  AND deleted_sequence IS NULL
                  AND (
                      row_id LIKE '%:user'
                      OR row_id LIKE '%:assistant%'
                      OR row_id LIKE '%:steer:%'
                  )"#,
        )
        .bind(conversation_id)
        .fetch_one(executor)
        .await
    }

    pub async fn fetch_turn_assistant_rows<'e, E>(
        executor: E,
        conversation_id: Uuid,
        turn_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        let exact = format!("{turn_id}:assistant");
        let prefix = format!("{turn_id}:assistant:%");
        sqlx::query_as::<_, Self>(
            r#"SELECT conversation_id, sort_index, row_id, revision, row_json, deleted_sequence
                 FROM conversation_timeline_rows
                WHERE conversation_id = ?1
                  AND deleted_sequence IS NULL
                  AND (row_id = ?2 OR row_id LIKE ?3)
                ORDER BY sort_index ASC, row_id ASC"#,
        )
        .bind(conversation_id)
        .bind(exact)
        .bind(prefix)
        .fetch_all(executor)
        .await
    }

    pub async fn fetch_by_row_ids(
        pool: &sqlx::SqlitePool,
        conversation_id: Uuid,
        row_ids: &[String],
    ) -> Result<Vec<Self>, sqlx::Error> {
        if row_ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut results = Vec::new();
        for chunk in row_ids.chunks(200) {
            let placeholders = std::iter::repeat_n("?", chunk.len())
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!(
                "SELECT conversation_id, sort_index, row_id, revision, row_json, deleted_sequence
                   FROM conversation_timeline_rows
                  WHERE conversation_id = ?
                    AND deleted_sequence IS NULL
                    AND row_id IN ({placeholders})"
            );
            let mut query = sqlx::query_as::<_, Self>(&sql).bind(conversation_id);
            for row_id in chunk {
                query = query.bind(row_id);
            }
            results.extend(query.fetch_all(pool).await?);
        }
        results.sort_by(|a, b| {
            a.sort_index
                .cmp(&b.sort_index)
                .then(a.row_id.cmp(&b.row_id))
        });
        Ok(results)
    }

    pub async fn fetch_by_turn_id_prefixes(
        pool: &sqlx::SqlitePool,
        conversation_id: Uuid,
        turn_ids: &[Uuid],
    ) -> Result<Vec<Self>, sqlx::Error> {
        if turn_ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut results = Vec::new();
        for chunk in turn_ids.chunks(50) {
            let predicates = std::iter::repeat_n("(row_id = ? OR row_id LIKE ?)", chunk.len())
                .collect::<Vec<_>>()
                .join(" OR ");
            let sql = format!(
                "SELECT conversation_id, sort_index, row_id, revision, row_json, deleted_sequence
                   FROM conversation_timeline_rows
                  WHERE conversation_id = ?
                    AND deleted_sequence IS NULL
                    AND ({predicates})"
            );
            let mut query = sqlx::query_as::<_, Self>(&sql).bind(conversation_id);
            for turn_id in chunk {
                let exact = turn_id.to_string();
                let prefix = format!("{turn_id}:%");
                query = query.bind(exact).bind(prefix);
            }
            results.extend(query.fetch_all(pool).await?);
        }
        results.sort_by(|a, b| {
            a.sort_index
                .cmp(&b.sort_index)
                .then(a.row_id.cmp(&b.row_id))
        });
        Ok(results)
    }

    pub async fn list_older_message_row_ids_before_keyset<'e, E>(
        executor: E,
        conversation_id: Uuid,
        before_sort_index: i64,
        before_row_id: &str,
    ) -> Result<Vec<String>, sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        sqlx::query_scalar::<_, String>(
            r#"SELECT row_id
                 FROM conversation_timeline_rows
                WHERE conversation_id = ?1
                  AND deleted_sequence IS NULL
                  AND (sort_index < ?2 OR (sort_index = ?2 AND row_id < ?3))
                  AND (
                      row_id LIKE '%:user'
                      OR row_id LIKE '%:assistant%'
                      OR row_id LIKE '%:steer:%'
                  )
                ORDER BY sort_index ASC, row_id ASC"#,
        )
        .bind(conversation_id)
        .bind(before_sort_index)
        .bind(before_row_id)
        .fetch_all(executor)
        .await
    }
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::{ConversationTimelineRowRecord, sort_index_bounds};
    use crate::DBService;

    #[tokio::test]
    async fn upsert_preserves_sort_index_and_rows_since_returns_upserts_and_tombstones() {
        let db = DBService::new_in_memory_for_tests().await.expect("db");
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(db.writer().as_pool())
            .await
            .expect("disable fk");

        let cid = Uuid::new_v4();

        // Global side row lands in [0, 999_999].
        let global_sort = ConversationTimelineRowRecord::upsert_row(
            db.writer(),
            cid,
            None,
            "status:agent-connection",
            1,
            r#"{"kind":"status","v":1}"#,
        )
        .await
        .expect("insert global side row");
        let (g_lo, g_hi) = sort_index_bounds(None);
        assert!((g_lo..=g_hi).contains(&global_sort));

        // Turn 1 rows land in [1_000_000, 1_999_999].
        let t1_user_sort = ConversationTimelineRowRecord::upsert_row(
            db.writer(),
            cid,
            Some(1),
            "turn-1:user",
            2,
            r#"{"kind":"user","text":"hi"}"#,
        )
        .await
        .expect("insert turn 1 user");
        let t1_asst_sort = ConversationTimelineRowRecord::upsert_row(
            db.writer(),
            cid,
            Some(1),
            "turn-1:assistant",
            3,
            r#"{"kind":"assistant","text":"hel"}"#,
        )
        .await
        .expect("insert turn 1 assistant");
        assert_eq!(t1_user_sort, 1_000_001);
        assert_eq!(t1_asst_sort, 1_000_002);

        // Updating turn-1:assistant MUST NOT drift sort_index even after more rows exist.
        let t1_perm_sort = ConversationTimelineRowRecord::upsert_row(
            db.writer(),
            cid,
            Some(1),
            "perm:req-1",
            4,
            r#"{"kind":"perm"}"#,
        )
        .await
        .expect("insert perm row");
        assert_eq!(t1_perm_sort, 1_000_003);

        let updated_asst_sort = ConversationTimelineRowRecord::upsert_row(
            db.writer(),
            cid,
            Some(1),
            "turn-1:assistant",
            5,
            r#"{"kind":"assistant","text":"hello world"}"#,
        )
        .await
        .expect("update turn 1 assistant");
        assert_eq!(
            updated_asst_sort, t1_asst_sort,
            "ON CONFLICT update must never mutate sort_index"
        );

        // Soft-delete perm:req-1 at sequence 6.
        let affected =
            ConversationTimelineRowRecord::soft_delete_row(db.writer(), cid, "perm:req-1", 6)
                .await
                .expect("soft delete perm");
        assert_eq!(affected, 1);

        // Active count excludes tombstones.
        let active_count = ConversationTimelineRowRecord::count(db.reader().as_pool(), cid)
            .await
            .expect("count");
        assert_eq!(active_count, 3);

        // rows_since(3) returns updated assistant (rev=5) + deleted perm tombstone (del=6).
        let catch_up = ConversationTimelineRowRecord::rows_since(db.reader(), cid, 3)
            .await
            .expect("rows_since");
        assert_eq!(catch_up.upserts.len(), 1);
        assert_eq!(catch_up.upserts[0].row_id, "turn-1:assistant");
        assert_eq!(catch_up.upserts[0].revision, 5);
        assert_eq!(catch_up.tombstones.len(), 1);
        assert_eq!(catch_up.tombstones[0].row_id, "perm:req-1");
        assert_eq!(catch_up.tombstones[0].deleted_sequence, 6);

        // Keyset pagination before turn-1:assistant returns [status:agent-connection, turn-1:user]
        // and excludes soft-deleted perm:req-1.
        let before_asst = ConversationTimelineRowRecord::list_before_keyset(
            db.reader().as_pool(),
            cid,
            t1_asst_sort,
            "turn-1:assistant",
            10,
        )
        .await
        .expect("list_before_keyset");
        assert_eq!(before_asst.len(), 2);
        assert_eq!(before_asst[0].row_id, "status:agent-connection");
        assert_eq!(before_asst[1].row_id, "turn-1:user");

        assert!(
            ConversationTimelineRowRecord::has_older_before_keyset(
                db.reader().as_pool(),
                cid,
                t1_user_sort,
                "turn-1:user",
            )
            .await
            .expect("has_older_before_keyset")
        );
        assert!(
            !ConversationTimelineRowRecord::has_older_before_keyset(
                db.reader().as_pool(),
                cid,
                global_sort,
                "status:agent-connection",
            )
            .await
            .expect("has_older_before_keyset oldest")
        );

        let all_active = ConversationTimelineRowRecord::list_all_active(db.reader().as_pool(), cid)
            .await
            .expect("list_all_active");
        assert_eq!(all_active.len(), 3);
    }
}
