//! Full-text search over conversations, backed by a standalone SQLite FTS5
//! table (`conversation_fts`). The index is kept fresh from the projection: it
//! is re-derived whenever a turn settles or the timeline is truncated, and rows
//! are removed when a conversation is deleted. A startup backfill indexes any
//! conversations missing from the table (e.g. after the migration first runs).

use agents::conversation::{ContentBlock, ConversationTimeline, ConversationTimelineRow, TurnRole};
use serde::Serialize;
use sqlx::{Row, SqliteConnection, SqlitePool};
use ts_rs::TS;
use uuid::Uuid;

use crate::projection::ConversationProjector;

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
}

/// Turn a free-form user query into a safe FTS5 MATCH expression for the
/// `trigram` tokenizer.
///
/// Each whitespace-separated term is double-quoted (so FTS5 operators and
/// punctuation can't break parsing or inject syntax) and combined with implicit
/// AND — with trigram, a quoted string matches as a substring. Returns `None`
/// when the query has no usable terms. Terms shorter than 3 characters cannot
/// match a trigram index, but are still included so an all-short query is a
/// deliberate (empty) result rather than a syntax error.
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

/// Concatenate the user- and assistant-visible text of a projected timeline into
/// a single searchable blob (thinking, tool I/O and images are excluded).
pub fn extract_searchable_text(timeline: &ConversationTimeline) -> String {
    let mut parts: Vec<String> = Vec::new();
    for row in &timeline.rows {
        if let ConversationTimelineRow::MessageTurn { turn, .. } = &row.row {
            if !matches!(turn.role, TurnRole::User | TurnRole::Assistant) {
                continue;
            }
            for block in &turn.blocks {
                if let ContentBlock::Text { text } = block {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        parts.push(trimmed.to_string());
                    }
                }
            }
        }
    }
    parts.join("\n")
}

/// Replace the FTS row for `conversation_id` with the current `body`. Reads the
/// conversation's workspace and title from `sessions` so hits can be filtered
/// and labelled. A no-op body still writes an (empty) row so the conversation is
/// counted as indexed by the backfill.
pub async fn reindex_conversation(
    conn: &mut SqliteConnection,
    conversation_id: Uuid,
    body: &str,
) -> Result<(), sqlx::Error> {
    let meta = sqlx::query("SELECT workspace_id, name FROM sessions WHERE id = ?")
        .bind(conversation_id)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(meta) = meta else {
        // Conversation row is gone; make sure the index has no stale entry.
        return delete_from_index(conn, conversation_id).await;
    };
    let workspace_id: Uuid = meta.try_get("workspace_id")?;
    let title: Option<String> = meta.try_get("name")?;

    sqlx::query("DELETE FROM conversation_fts WHERE conversation_id = ?")
        .bind(conversation_id)
        .execute(&mut *conn)
        .await?;
    sqlx::query(
        "INSERT INTO conversation_fts(body, conversation_id, workspace_id, title) \
         VALUES (?, ?, ?, ?)",
    )
    .bind(body)
    .bind(conversation_id)
    .bind(workspace_id)
    .bind(title)
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
        .bind(conversation_id)
        .execute(conn)
        .await?;
    Ok(())
}

/// Run a full-text search, most-relevant first. `workspace_id`, when set,
/// restricts to one workspace.
pub async fn search_conversations(
    conn: &mut SqliteConnection,
    query: &str,
    workspace_id: Option<Uuid>,
    limit: i64,
) -> Result<Vec<ConversationSearchHit>, sqlx::Error> {
    let Some(match_expr) = to_fts_match_query(query) else {
        return Ok(Vec::new());
    };
    let sql = format!(
        "SELECT conversation_id, workspace_id, title, \
                snippet(conversation_fts, 0, '[', ']', '…', 12) AS snippet \
         FROM conversation_fts \
         WHERE conversation_fts MATCH ?1 {} \
         ORDER BY rank LIMIT ?2",
        if workspace_id.is_some() {
            "AND workspace_id = ?3"
        } else {
            ""
        }
    );
    let mut q = sqlx::query(&sql).bind(match_expr).bind(limit);
    if let Some(workspace_id) = workspace_id {
        q = q.bind(workspace_id);
    }
    let rows = q.fetch_all(conn).await?;
    rows.into_iter()
        .map(|row| {
            Ok(ConversationSearchHit {
                conversation_id: row.try_get("conversation_id")?,
                workspace_id: row.try_get("workspace_id")?,
                title: row.try_get("title")?,
                snippet: row.try_get("snippet")?,
            })
        })
        .collect()
}

/// Project a conversation and (re)index its text. Used by the backfill and any
/// read-path refresh where only a pool is available.
pub async fn reindex_from_projection(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<(), sqlx::Error> {
    let timeline = ConversationProjector::project(pool, conversation_id).await?;
    let body = extract_searchable_text(&timeline);
    let mut conn = pool.acquire().await?;
    reindex_conversation(&mut conn, conversation_id, &body).await
}

/// Index every conversation that has no FTS row yet (e.g. after the migration
/// first creates the table, or for histories imported before this feature).
/// Returns the number of conversations indexed. Best-effort per conversation.
pub async fn backfill_missing(pool: &SqlitePool) -> Result<usize, sqlx::Error> {
    let ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM sessions \
         WHERE id NOT IN (SELECT conversation_id FROM conversation_fts)",
    )
    .fetch_all(pool)
    .await?;
    let mut indexed = 0usize;
    for id in ids {
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

    // FTS5 operators / quotes in user input must not break the MATCH expression.
    #[test]
    fn fts5_syntax_is_neutralized() {
        // `OR`, `*`, parens and embedded quotes are all quoted as literals.
        let q = to_fts_match_query("a\" OR b*").unwrap();
        assert_eq!(q, "\"a\"\"\" \"OR\" \"b*\"");
    }
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    use db::models::conversation::{ConversationRecord, CreateConversationRecord};
    use sqlx::SqlitePool;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;

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
    async fn reindex_then_search_finds_filters_and_misses() {
        let pool = pool().await;
        let ws = Uuid::new_v4();
        let conv = seed(&pool, ws, Some("登录修复")).await;
        let mut conn = pool.acquire().await.unwrap();

        reindex_conversation(&mut conn, conv, "修复登录页面的空指针 bug").await.unwrap();

        // Substring CJK match (trigram, >= 3 chars).
        let hits = search_conversations(&mut conn, "修复登录", None, 10).await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].conversation_id, conv);
        assert_eq!(hits[0].title.as_deref(), Some("登录修复"));
        assert!(!hits[0].snippet.is_empty());

        // Workspace filter.
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

        // No match.
        assert!(
            search_conversations(&mut conn, "不存在词组xyz", None, 10)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn reindex_is_idempotent_and_delete_removes() {
        let pool = pool().await;
        let conv = seed(&pool, Uuid::new_v4(), None).await;
        let mut conn = pool.acquire().await.unwrap();

        reindex_conversation(&mut conn, conv, "hello world").await.unwrap();
        // Re-index the same conversation with new text — no duplicate rows.
        reindex_conversation(&mut conn, conv, "hello brave world").await.unwrap();
        let hits = search_conversations(&mut conn, "hello", None, 10).await.unwrap();
        assert_eq!(hits.len(), 1);

        delete_from_index(&mut conn, conv).await.unwrap();
        assert!(
            search_conversations(&mut conn, "hello", None, 10)
                .await
                .unwrap()
                .is_empty()
        );
    }
}
