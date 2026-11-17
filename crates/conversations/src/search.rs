//! Row-level trigram FTS5 (`conversation_fts`) maintenance and full-text + title search.
//!
//! Schema: `conversation_fts(conversation_id UNINDEXED, row_id UNINDEXED, role UNINDEXED, text, tokenize = 'trigram')`.

use std::collections::HashSet;

use agents::conversation::{
    ContentBlock, ConversationTimeline, ConversationTimelineRow, TimelineRow, TurnRole,
};
use serde::Serialize;
use sqlx::{Row, SqliteConnection, SqlitePool};
use ts_rs::TS;
use uuid::Uuid;

use crate::projection::ConversationProjector;

const INDEXED_SENTINEL_ROW_ID: &str = "__indexed__";
const LEGACY_BODY_ROW_ID: &str = "__body__";

/// A single full-text search hit.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct ConversationSearchHit {
    #[ts(type = "string")]
    pub conversation_id: Uuid,
    #[ts(type = "string")]
    pub workspace_id: Uuid,
    pub title: Option<String>,
    /// A short highlighted excerpt around the match (`[` … `]` mark the terms).
    pub snippet: String,
    #[serde(
        default,
        rename = "matchSource",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional, rename = "matchSource")]
    pub match_source: Option<String>,
    #[serde(
        default,
        rename = "matchedRowId",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional, rename = "matchedRowId")]
    pub matched_row_id: Option<String>,
    #[serde(
        default,
        rename = "matchedTurnOrdinal",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional, rename = "matchedTurnOrdinal")]
    pub matched_turn_ordinal: Option<i64>,
}

/// Turn a free-form user query into a safe FTS5 MATCH expression for the
/// `trigram` tokenizer.
pub fn to_fts_match_query(user_query: &str) -> Option<String> {
    let terms: Vec<String> = user_query
        .split_whitespace()
        .map(|term| term.replace('"', "\"\""))
        .filter(|term| !term.is_empty())
        .map(|term| format!("\"{term}\""))
        .collect();
    if terms.is_empty() {
        return None;
    }
    Some(terms.join(" "))
}

fn can_use_trigram_match(user_query: &str) -> bool {
    let mut has_terms = false;
    for term in user_query.split_whitespace().filter(|t| !t.is_empty()) {
        has_terms = true;
        if term.chars().count() < 3 {
            return false;
        }
    }
    has_terms
}

/// Extract searchable `(role, visible_text)` for a single `TimelineRow`.
/// Thinking blocks, tool I/O, images, and non-message rows are excluded.
pub fn extract_row_searchable_text(row: &TimelineRow) -> Option<(&'static str, String)> {
    let ConversationTimelineRow::MessageTurn { turn, .. } = &row.row else {
        return None;
    };
    let role = match turn.role {
        TurnRole::User => "user",
        TurnRole::Assistant => "assistant",
        _ => return None,
    };
    let mut parts: Vec<&str> = Vec::new();
    for block in &turn.blocks {
        if let ContentBlock::Text { text } = block {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                parts.push(trimmed);
            }
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some((role, parts.join("\n")))
}

/// Concatenate the user- and assistant-visible text of a projected timeline into
/// a single searchable blob (thinking, tool I/O and images are excluded).
pub fn extract_searchable_text(timeline: &ConversationTimeline) -> String {
    let mut parts: Vec<String> = Vec::new();
    for row in &timeline.rows {
        if let Some((_, text)) = extract_row_searchable_text(row) {
            parts.push(text);
        }
    }
    parts.join("\n")
}

/// O(1) row-level FTS upsert keyed by `(conversation_id, row_id)`.
pub async fn upsert_fts_row_on_conn(
    conn: &mut SqliteConnection,
    conversation_id: Uuid,
    row_id: &str,
    role: &str,
    text: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM conversation_fts WHERE conversation_id = ? AND row_id = ?")
        .bind(conversation_id.to_string())
        .bind(row_id)
        .execute(&mut *conn)
        .await?;
    let trimmed = text.trim();
    if !trimmed.is_empty() {
        sqlx::query(
            "INSERT INTO conversation_fts(conversation_id, row_id, role, text) VALUES (?, ?, ?, ?)",
        )
        .bind(conversation_id.to_string())
        .bind(row_id)
        .bind(role)
        .bind(trimmed)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

/// O(1) row-level FTS upsert directly from a `TimelineRow` if it carries searchable text.
pub async fn upsert_fts_from_timeline_row_on_conn(
    conn: &mut SqliteConnection,
    conversation_id: Uuid,
    row: &TimelineRow,
) -> Result<(), sqlx::Error> {
    if let Some((role, text)) = extract_row_searchable_text(row) {
        upsert_fts_row_on_conn(conn, conversation_id, &row.row_id, role, &text).await?;
    }
    Ok(())
}

/// O(1) row-level FTS delete when a timeline row is soft-deleted.
pub async fn delete_fts_row_on_conn(
    conn: &mut SqliteConnection,
    conversation_id: Uuid,
    row_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM conversation_fts WHERE conversation_id = ? AND row_id = ?")
        .bind(conversation_id.to_string())
        .bind(row_id)
        .execute(conn)
        .await?;
    Ok(())
}

/// Batch delete FTS rows for truncated/soft-deleted timeline row IDs.
pub async fn delete_fts_rows_on_conn(
    conn: &mut SqliteConnection,
    conversation_id: Uuid,
    row_ids: &[String],
) -> Result<(), sqlx::Error> {
    for row_id in row_ids {
        delete_fts_row_on_conn(&mut *conn, conversation_id, row_id).await?;
    }
    Ok(())
}

/// Replace all row-level FTS entries for `conversation_id` from projected `TimelineRow`s.
pub async fn reindex_timeline_rows_on_conn(
    conn: &mut SqliteConnection,
    conversation_id: Uuid,
    rows: &[TimelineRow],
) -> Result<(), sqlx::Error> {
    let exists: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?)")
        .bind(conversation_id)
        .fetch_one(&mut *conn)
        .await?;
    if exists == 0 {
        return delete_from_index(conn, conversation_id).await;
    }

    delete_from_index(&mut *conn, conversation_id).await?;
    let conv_id_str = conversation_id.to_string();
    let mut inserted = 0usize;
    for row in rows {
        if let Some((role, text)) = extract_row_searchable_text(row) {
            sqlx::query(
                "INSERT INTO conversation_fts(conversation_id, row_id, role, text) VALUES (?, ?, ?, ?)",
            )
            .bind(&conv_id_str)
            .bind(&row.row_id)
            .bind(role)
            .bind(text)
            .execute(&mut *conn)
            .await?;
            inserted += 1;
        }
    }
    if inserted == 0 {
        sqlx::query(
            "INSERT INTO conversation_fts(conversation_id, row_id, role, text) VALUES (?, ?, 'system', '')",
        )
        .bind(&conv_id_str)
        .bind(INDEXED_SENTINEL_ROW_ID)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

/// Replace the FTS index for `conversation_id` with a single body blob (compatibility helper).
pub async fn reindex_conversation(
    conn: &mut SqliteConnection,
    conversation_id: Uuid,
    body: &str,
) -> Result<(), sqlx::Error> {
    let exists: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?)")
        .bind(conversation_id)
        .fetch_one(&mut *conn)
        .await?;
    if exists == 0 {
        return delete_from_index(conn, conversation_id).await;
    }

    delete_from_index(&mut *conn, conversation_id).await?;
    let trimmed = body.trim();
    let (row_id, role) = if trimmed.is_empty() {
        (INDEXED_SENTINEL_ROW_ID, "system")
    } else {
        (LEGACY_BODY_ROW_ID, "assistant")
    };
    sqlx::query(
        "INSERT INTO conversation_fts(conversation_id, row_id, role, text) VALUES (?, ?, ?, ?)",
    )
    .bind(conversation_id.to_string())
    .bind(row_id)
    .bind(role)
    .bind(trimmed)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Remove a conversation from the index (on delete).
pub async fn delete_from_index(
    conn: &mut SqliteConnection,
    conversation_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM conversation_fts WHERE conversation_id = ?")
        .bind(conversation_id.to_string())
        .execute(conn)
        .await?;
    Ok(())
}

fn like_contains(query: &str) -> Option<String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return None;
    }
    let escaped = trimmed
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    Some(format!("%{escaped}%"))
}

fn highlight_short_excerpt(text: &str, query: &str) -> String {
    let trimmed_query = query.trim();
    if trimmed_query.is_empty() {
        return text.chars().take(80).collect();
    }
    let lower_text = text.to_lowercase();
    let lower_query = trimmed_query.to_lowercase();
    if let Some(byte_idx) = lower_text.find(&lower_query) {
        let prefix_chars = text[..byte_idx].chars().count();
        let match_chars = trimmed_query.chars().count();
        let chars: Vec<char> = text.chars().collect();
        let start = prefix_chars.saturating_sub(20);
        let end = (prefix_chars + match_chars + 32).min(chars.len());
        let mut out = String::new();
        if start > 0 {
            out.push('…');
        }
        out.extend(&chars[start..prefix_chars]);
        out.push('[');
        out.extend(&chars[prefix_chars..(prefix_chars + match_chars).min(chars.len())]);
        out.push(']');
        if prefix_chars + match_chars < end {
            out.extend(&chars[(prefix_chars + match_chars)..end]);
        }
        if end < chars.len() {
            out.push('…');
        }
        out
    } else {
        text.chars().take(80).collect()
    }
}

/// Combined session title + row-level `conversation_fts` search, most recently updated first.
/// `workspace_id`, when set, restricts to one workspace. Soft-deleted conversations are hidden.
pub async fn search_conversations(
    conn: &mut SqliteConnection,
    query: &str,
    workspace_id: Option<Uuid>,
    limit: i64,
) -> Result<Vec<ConversationSearchHit>, sqlx::Error> {
    search_conversations_with_offset(conn, query, workspace_id, limit, 0).await
}

/// Combined session title + row-level `conversation_fts` search with offset pagination and
/// match metadata (`matchSource`, `matchedRowId`, `matchedTurnOrdinal`).
pub async fn search_conversations_with_offset(
    conn: &mut SqliteConnection,
    query: &str,
    workspace_id: Option<Uuid>,
    limit: i64,
    offset: i64,
) -> Result<Vec<ConversationSearchHit>, sqlx::Error> {
    if limit <= 0 {
        return Ok(Vec::new());
    }
    let Some(pattern) = like_contains(query) else {
        return Ok(Vec::new());
    };
    let bounded_limit = limit.max(1);
    let bounded_offset = offset.max(0) as usize;
    let total_needed = bounded_offset.saturating_add(bounded_limit as usize);

    let title_sql = format!(
        "SELECT id AS conversation_id, workspace_id, name AS title, \
                COALESCE(name, '') AS snippet \
         FROM sessions \
         WHERE deleted_at IS NULL AND name LIKE ?1 ESCAPE '\\' {} \
         ORDER BY pinned_at IS NULL, pinned_at DESC, updated_at DESC \
         LIMIT ?2",
        if workspace_id.is_some() {
            "AND workspace_id = ?3"
        } else {
            ""
        }
    );
    let mut title_q = sqlx::query(&title_sql)
        .bind(&pattern)
        .bind(total_needed as i64);
    if let Some(ws_id) = workspace_id {
        title_q = title_q.bind(ws_id);
    }
    let title_rows = title_q.fetch_all(&mut *conn).await?;

    let mut hits: Vec<ConversationSearchHit> = Vec::with_capacity(total_needed);
    let mut index_by_conv: std::collections::HashMap<Uuid, usize> =
        std::collections::HashMap::new();
    for row in title_rows {
        let conversation_id: Uuid = row.try_get("conversation_id")?;
        if let std::collections::hash_map::Entry::Vacant(entry) =
            index_by_conv.entry(conversation_id)
        {
            entry.insert(hits.len());
            hits.push(ConversationSearchHit {
                conversation_id,
                workspace_id: row.try_get("workspace_id")?,
                title: row.try_get("title")?,
                snippet: row.try_get("snippet")?,
                match_source: Some("title".to_string()),
                matched_row_id: None,
                matched_turn_ordinal: None,
            });
        }
    }

    let normalize_row_id = |raw: Option<String>| -> Option<String> {
        raw.filter(|r| !r.is_empty() && r != INDEXED_SENTINEL_ROW_ID && r != LEGACY_BODY_ROW_ID)
    };

    if can_use_trigram_match(query)
        && let Some(match_expr) = to_fts_match_query(query)
    {
        let fts_sql = format!(
            "SELECT s.id AS conversation_id, s.workspace_id AS workspace_id, s.name AS title, \
                    conversation_fts.row_id AS row_id, \
                    CASE WHEN ctr.sort_index >= 1000000 THEN ctr.sort_index / 1000000 ELSE NULL END AS turn_ordinal, \
                    snippet(conversation_fts, 3, '[', ']', '…', 24) AS snippet \
             FROM conversation_fts \
             JOIN sessions s ON CAST(s.id AS TEXT) = conversation_fts.conversation_id \
                OR lower(hex(s.id)) = replace(lower(conversation_fts.conversation_id), '-', '') \
             LEFT JOIN conversation_timeline_rows ctr \
                ON ctr.conversation_id = s.id \
               AND ctr.row_id = conversation_fts.row_id \
               AND ctr.deleted_sequence IS NULL \
             WHERE conversation_fts MATCH ?1 \
               AND s.deleted_at IS NULL {} \
             ORDER BY s.pinned_at IS NULL, s.pinned_at DESC, s.updated_at DESC \
             LIMIT ?2",
            if workspace_id.is_some() {
                "AND s.workspace_id = ?3"
            } else {
                ""
            }
        );
        let fetch_cap = ((total_needed as i64).saturating_mul(4)).max(16);
        let mut fts_q = sqlx::query(&fts_sql).bind(match_expr).bind(fetch_cap);
        if let Some(ws_id) = workspace_id {
            fts_q = fts_q.bind(ws_id);
        }
        let fts_rows = fts_q.fetch_all(&mut *conn).await?;
        for row in fts_rows {
            let conversation_id: Uuid = row.try_get("conversation_id")?;
            let matched_row_id = normalize_row_id(row.try_get("row_id").ok());
            let matched_turn_ordinal: Option<i64> = row.try_get("turn_ordinal").ok().flatten();
            if let Some(&existing_idx) = index_by_conv.get(&conversation_id) {
                let hit = &mut hits[existing_idx];
                if hit.match_source.as_deref() == Some("title") {
                    hit.match_source = Some("both".to_string());
                    hit.snippet = row.try_get("snippet")?;
                    hit.matched_row_id = matched_row_id;
                    hit.matched_turn_ordinal = matched_turn_ordinal;
                }
                continue;
            }
            if hits.len() >= total_needed {
                continue;
            }
            index_by_conv.insert(conversation_id, hits.len());
            hits.push(ConversationSearchHit {
                conversation_id,
                workspace_id: row.try_get("workspace_id")?,
                title: row.try_get("title")?,
                snippet: row.try_get("snippet")?,
                match_source: Some("body".to_string()),
                matched_row_id,
                matched_turn_ordinal,
            });
        }
    } else {
        // Short query (< 3 chars per term) fallback where trigram MATCH has no 3-grams.
        let like_sql = format!(
            "SELECT s.id AS conversation_id, s.workspace_id AS workspace_id, s.name AS title, \
                    conversation_fts.row_id AS row_id, \
                    CASE WHEN ctr.sort_index >= 1000000 THEN ctr.sort_index / 1000000 ELSE NULL END AS turn_ordinal, \
                    conversation_fts.text AS raw_text \
             FROM conversation_fts \
             JOIN sessions s ON CAST(s.id AS TEXT) = conversation_fts.conversation_id \
                OR lower(hex(s.id)) = replace(lower(conversation_fts.conversation_id), '-', '') \
             LEFT JOIN conversation_timeline_rows ctr \
                ON ctr.conversation_id = s.id \
               AND ctr.row_id = conversation_fts.row_id \
               AND ctr.deleted_sequence IS NULL \
             WHERE conversation_fts.text LIKE ?1 ESCAPE '\\' \
               AND s.deleted_at IS NULL {} \
             ORDER BY s.pinned_at IS NULL, s.pinned_at DESC, s.updated_at DESC \
             LIMIT ?2",
            if workspace_id.is_some() {
                "AND s.workspace_id = ?3"
            } else {
                ""
            }
        );
        let fetch_cap = ((total_needed as i64).saturating_mul(4)).max(16);
        let mut like_q = sqlx::query(&like_sql).bind(&pattern).bind(fetch_cap);
        if let Some(ws_id) = workspace_id {
            like_q = like_q.bind(ws_id);
        }
        let like_rows = like_q.fetch_all(&mut *conn).await?;
        for row in like_rows {
            let conversation_id: Uuid = row.try_get("conversation_id")?;
            let matched_row_id = normalize_row_id(row.try_get("row_id").ok());
            let matched_turn_ordinal: Option<i64> = row.try_get("turn_ordinal").ok().flatten();
            if let Some(&existing_idx) = index_by_conv.get(&conversation_id) {
                let hit = &mut hits[existing_idx];
                if hit.match_source.as_deref() == Some("title") {
                    let raw_text: String = row.try_get("raw_text")?;
                    hit.match_source = Some("both".to_string());
                    hit.snippet = highlight_short_excerpt(&raw_text, query);
                    hit.matched_row_id = matched_row_id;
                    hit.matched_turn_ordinal = matched_turn_ordinal;
                }
                continue;
            }
            if hits.len() >= total_needed {
                continue;
            }
            let raw_text: String = row.try_get("raw_text")?;
            index_by_conv.insert(conversation_id, hits.len());
            hits.push(ConversationSearchHit {
                conversation_id,
                workspace_id: row.try_get("workspace_id")?,
                title: row.try_get("title")?,
                snippet: highlight_short_excerpt(&raw_text, query),
                match_source: Some("body".to_string()),
                matched_row_id,
                matched_turn_ordinal,
            });
        }
    }

    Ok(hits
        .into_iter()
        .skip(bounded_offset)
        .take(bounded_limit as usize)
        .collect())
}

/// Project a conversation and (re)index its row-level text. Used by backfill and
/// explicit rebuild paths.
pub async fn reindex_from_projection(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<(), sqlx::Error> {
    let _ = crate::ensure_legacy_jsonl_migrated_on_pool(pool, conversation_id).await?;
    let timeline = ConversationProjector::project(pool, conversation_id).await?;
    let mut conn = pool.acquire().await?;
    reindex_timeline_rows_on_conn(&mut conn, conversation_id, &timeline.rows).await
}

/// Index every conversation that has no FTS row yet.
/// Returns the number of conversations indexed. Best-effort per conversation.
pub async fn backfill_missing(pool: &SqlitePool) -> Result<usize, sqlx::Error> {
    let missing: i64 = sqlx::query_scalar(
        "SELECT EXISTS(\
            SELECT 1 FROM sessions \
            WHERE NOT EXISTS (\
                SELECT 1 FROM conversation_fts \
                WHERE conversation_fts.conversation_id = CAST(sessions.id AS TEXT) \
                   OR replace(lower(conversation_fts.conversation_id), '-', '') = lower(hex(sessions.id))\
            )\
         )",
    )
    .fetch_one(pool)
    .await?;
    if missing == 0 {
        return Ok(0);
    }
    let rows = sqlx::query("SELECT id FROM sessions")
        .fetch_all(pool)
        .await?;
    let indexed_ids: HashSet<String> =
        sqlx::query_scalar::<_, String>("SELECT DISTINCT conversation_id FROM conversation_fts")
            .fetch_all(pool)
            .await?
            .into_iter()
            .collect();
    let mut indexed = 0usize;
    for row in rows {
        let id: Uuid = row.try_get("id")?;
        if indexed_ids.contains(&id.to_string()) {
            continue;
        }
        match reindex_from_projection(pool, id).await {
            Ok(()) => indexed += 1,
            Err(error) => tracing::warn!("search backfill failed for {id}: {error}"),
        }
    }
    Ok(indexed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_and_ands_terms() {
        assert_eq!(
            to_fts_match_query("fix login").as_deref(),
            Some("\"fix\" \"login\"")
        );
    }

    #[test]
    fn single_term_is_quoted() {
        assert_eq!(to_fts_match_query("auth").as_deref(), Some("\"auth\""));
    }

    #[test]
    fn empty_or_whitespace_query_is_none() {
        assert_eq!(to_fts_match_query(""), None);
        assert_eq!(to_fts_match_query("   "), None);
    }

    #[test]
    fn fts5_syntax_is_neutralized() {
        let q = to_fts_match_query("a\" OR b*").unwrap();
        assert_eq!(q, "\"a\"\"\" \"OR\" \"b*\"");
    }
}

#[cfg(test)]
mod integration_tests {
    use std::str::FromStr;

    use db::models::conversation::{
        ConversationRecord, CreateConversationRecord, DbConversationSummary,
    };
    use sqlx::{
        SqlitePool,
        sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    };

    use super::*;

    async fn pool() -> SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .unwrap()
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    async fn seed(pool: &SqlitePool, workspace_id: Uuid, title: Option<&str>) -> Uuid {
        let id = Uuid::new_v4();
        ConversationRecord::create(
            pool,
            id,
            CreateConversationRecord {
                workspace_id,
                task_id: None,
                title,
                initial_prompt: None,
                status: None,
                executor: Some("agent"),
            },
        )
        .await
        .unwrap();
        id
    }

    #[tokio::test]
    async fn title_and_row_level_fts_search_with_soft_delete_cleanup() {
        let pool = pool().await;
        let ws = Uuid::new_v4();
        let conv = seed(&pool, ws, Some("修复登录页面")).await;
        let other = seed(&pool, ws, Some("其他事项")).await;
        let mut conn = pool.acquire().await.unwrap();

        upsert_fts_row_on_conn(
            &mut conn,
            other,
            "turn-1:assistant",
            "assistant",
            "定位到空指针异常原因",
        )
        .await
        .unwrap();

        let hits = search_conversations(&mut conn, "修复登录", None, 10)
            .await
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].conversation_id, conv);
        assert_eq!(hits[0].title.as_deref(), Some("修复登录页面"));
        assert!(!hits[0].snippet.is_empty());

        assert!(
            search_conversations(&mut conn, "修复登录", Some(Uuid::new_v4()), 10)
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            search_conversations(&mut conn, "修复登录", Some(ws), 10)
                .await
                .unwrap()
                .len(),
            1
        );

        // Row-level trigram FTS hit (>= 3 chars)
        let body_hits = search_conversations(&mut conn, "空指针", None, 10)
            .await
            .unwrap();
        assert_eq!(body_hits.len(), 1);
        assert_eq!(body_hits[0].conversation_id, other);
        assert!(body_hits[0].snippet.contains("[空指针]"));

        // Short CJK query (< 3 chars) fallback hit
        let short_hits = search_conversations(&mut conn, "定位", None, 10)
            .await
            .unwrap();
        assert_eq!(short_hits.len(), 1);
        assert_eq!(short_hits[0].conversation_id, other);

        // Soft-deleting the timeline row deletes its FTS entry in O(1)
        delete_fts_row_on_conn(&mut conn, other, "turn-1:assistant")
            .await
            .unwrap();
        assert!(
            search_conversations(&mut conn, "空指针", None, 10)
                .await
                .unwrap()
                .is_empty()
        );

        assert!(
            search_conversations(&mut conn, "不存在词组xyz", None, 10)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn title_search_is_one_row_and_hides_deleted() {
        let pool = pool().await;
        let conv = seed(&pool, Uuid::new_v4(), Some("hello world")).await;
        let mut conn = pool.acquire().await.unwrap();
        let hits = search_conversations(&mut conn, "hello", None, 10)
            .await
            .unwrap();
        assert_eq!(hits.len(), 1);
        drop(conn);

        DbConversationSummary::set_title(&pool, conv, "hello brave world")
            .await
            .unwrap();
        let mut conn = pool.acquire().await.unwrap();
        let hits = search_conversations(&mut conn, "hello", None, 10)
            .await
            .unwrap();
        assert_eq!(hits.len(), 1);
        drop(conn);

        DbConversationSummary::soft_delete(&pool, conv)
            .await
            .unwrap();
        let mut conn = pool.acquire().await.unwrap();
        assert!(
            search_conversations(&mut conn, "hello", None, 10)
                .await
                .unwrap()
                .is_empty()
        );
    }
}
