use std::borrow::Cow;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Executor, FromRow, Sqlite, SqliteConnection, SqlitePool, Transaction};
use ts_rs::TS;
use uuid::Uuid;

/// Largest JSON document stored for a bulky tool, terminal, or diagnostic event.
pub const MAX_STORED_EVENT_JSON_BYTES: usize = 64 * 1024;
/// Longest single string kept inside one of those documents. The tail is kept.
pub const MAX_STORED_STRING_BYTES: usize = 16 * 1024;
const STORED_TRUNCATION_MARKER: &str = "…[truncated]\n";

/// The event-schema version the host writes on every new event. Bump only when a
/// stored event's shape changes in a way older readers can't understand; the
/// read-side wrapper degrades any higher version it encounters to a placeholder
/// row rather than failing the timeline.
pub const CURRENT_EVENT_VERSION: i64 = 1;

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
pub struct ConversationEventRecord {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub turn_id: Option<Uuid>,
    pub binding_id: Option<Uuid>,
    pub connection_id: Option<String>,
    pub prompt_id: Option<String>,
    pub sequence: i64,
    pub source: String,
    pub event_kind: String,
    pub event_version: i64,
    pub normalized_json: String,
    pub raw_json: Option<String>,
    pub idempotency_key: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct AppendConversationEvent<'a> {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub turn_id: Option<Uuid>,
    pub binding_id: Option<Uuid>,
    pub connection_id: Option<&'a str>,
    pub prompt_id: Option<&'a str>,
    pub source: &'a str,
    pub event_kind: &'a str,
    pub normalized_json: &'a str,
    pub raw_json: Option<&'a str>,
    pub idempotency_key: Option<&'a str>,
}

/// Join row for [`ConversationEventRecord::recent_of_kind_with_executor`].
#[derive(FromRow)]
struct EventWithExecutorRow {
    session_executor: String,
    #[sqlx(flatten)]
    event: ConversationEventRecord,
}

const EVENT_COLUMNS: &str = r#"id,
    conversation_id,
    turn_id,
    binding_id,
    connection_id,
    prompt_id,
    sequence,
    source,
    event_kind,
    event_version,
    normalized_json,
    raw_json,
    idempotency_key,
    created_at"#;

impl ConversationEventRecord {
    pub async fn append(
        pool: &SqlitePool,
        input: AppendConversationEvent<'_>,
    ) -> Result<Self, sqlx::Error> {
        // Dedup is handled inside the transaction (see
        // `append_conversation_event_on_connection`) plus the UNIQUE index; the
        // previous pool-level pre-check added a redundant SELECT on the hot
        // append path, whose common case is a brand-new event.
        let mut conn = pool.acquire().await?;
        sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;

        let record = match append_conversation_event_on_connection(&mut conn, input).await {
            Ok(record) => record,
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                return Err(error);
            }
        };

        if let Err(error) = sqlx::query("COMMIT").execute(&mut *conn).await {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            return Err(error);
        }

        Ok(record)
    }

    /// Read events after a sequence cursor.
    ///
    /// Generic over the executor so the projection rebuild / snapshot refresh can read
    /// the tail inside the append transaction (seeing its own uncommitted writes),
    /// while the read path keeps passing a pool.
    /// Latest event of one kind (e.g. `session_mode_updated`) — used to hydrate
    /// agent-advertised session controls when a conversation is (re)opened.
    pub async fn latest_of_kind<'e, E>(
        executor: E,
        conversation_id: Uuid,
        event_kind: &str,
    ) -> Result<Option<Self>, sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {EVENT_COLUMNS}
               FROM conversation_events
               WHERE conversation_id = ? AND event_kind = ?
               ORDER BY sequence DESC
               LIMIT 1"#
        ))
        .bind(conversation_id)
        .bind(event_kind)
        .fetch_optional(executor)
        .await
    }

    /// Recent events of one kind across ALL conversations, newest first, each
    /// paired with its session's raw executor key (historical spellings
    /// included — callers match agents leniently via `AgentKind::from_lenient`).
    /// Used to recover an agent's last-advertised session controls before a new
    /// session exists.
    pub async fn recent_of_kind_with_executor<'e, E>(
        executor: E,
        event_kind: &str,
        limit: i64,
    ) -> Result<Vec<(String, Self)>, sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        let rows = sqlx::query_as::<_, EventWithExecutorRow>(
            r#"SELECT s.executor AS session_executor,
                      e.id,
                      e.conversation_id,
                      e.turn_id,
                      e.binding_id,
                      e.connection_id,
                      e.prompt_id,
                      e.sequence,
                      e.source,
                      e.event_kind,
                      e.event_version,
                      e.normalized_json,
                      e.raw_json,
                      e.idempotency_key,
                      e.created_at
               FROM conversation_events e
               JOIN sessions s ON s.id = e.conversation_id
               WHERE e.event_kind = ?
               ORDER BY e.created_at DESC, e.sequence DESC
               LIMIT ?"#,
        )
        .bind(event_kind)
        .bind(limit)
        .fetch_all(executor)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| (row.session_executor, row.event))
            .collect())
    }

    pub async fn max_sequence(
        pool: &SqlitePool,
        conversation_id: Uuid,
    ) -> Result<i64, sqlx::Error> {
        let value = sqlx::query_scalar::<_, Option<i64>>(
            "SELECT MAX(sequence) FROM conversation_events WHERE conversation_id = ?",
        )
        .bind(conversation_id)
        .fetch_one(pool)
        .await?;
        Ok(value.unwrap_or(0))
    }

    pub async fn latest_agent_handoff_sequence(
        pool: &SqlitePool,
        conversation_id: Uuid,
    ) -> Result<i64, sqlx::Error> {
        let value = sqlx::query_scalar::<_, i64>(
            r#"SELECT sequence
               FROM conversation_events
               WHERE conversation_id = ?
                 AND event_kind = 'raw_diagnostic_recorded'
                 AND normalized_json LIKE '%"agent_handoff"%'
               ORDER BY sequence DESC
               LIMIT 1"#,
        )
        .bind(conversation_id)
        .fetch_optional(pool)
        .await?;
        Ok(value.unwrap_or(0))
    }

    pub async fn events_since<'e, E>(
        executor: E,
        conversation_id: Uuid,
        after_sequence: i64,
        limit: i64,
    ) -> Result<Vec<Self>, sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {EVENT_COLUMNS}
               FROM conversation_events
               WHERE conversation_id = ? AND sequence > ?
               ORDER BY sequence ASC
               LIMIT ?"#
        ))
        .bind(conversation_id)
        .bind(after_sequence)
        .bind(limit)
        .fetch_all(executor)
        .await
    }

    /// Same keyset page as [`Self::events_since`], without `raw_json`.
    ///
    /// Projection and live row-op reads only deserialize `normalized_json`.
    /// Selecting the raw column pulls its overflow pages even when the caller
    /// ignores them, which is what stalls the UI on a multi-gigabyte log.
    pub async fn events_since_for_projection<'e, E>(
        executor: E,
        conversation_id: Uuid,
        after_sequence: i64,
        limit: i64,
    ) -> Result<Vec<Self>, sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        sqlx::query_as::<_, Self>(
            r#"SELECT id,
                      conversation_id,
                      turn_id,
                      binding_id,
                      connection_id,
                      prompt_id,
                      sequence,
                      source,
                      event_kind,
                      event_version,
                      normalized_json,
                      NULL AS raw_json,
                      idempotency_key,
                      created_at
               FROM conversation_events
               WHERE conversation_id = ? AND sequence > ?
               ORDER BY sequence ASC
               LIMIT ?"#,
        )
        .bind(conversation_id)
        .bind(after_sequence)
        .bind(limit)
        .fetch_all(executor)
        .await
    }

    /// Rewrite one batch of oversized tool, terminal, and diagnostic payloads.
    ///
    /// Returns the bytes removed. `0` means nothing in this batch was still over
    /// the cap. The caller owns pacing; this method commits one short write
    /// transaction and does not `VACUUM` the file.
    pub async fn compact_oversized_payloads(
        pool: &SqlitePool,
        limit: i64,
    ) -> Result<u64, sqlx::Error> {
        let limit = limit.max(1);
        let mut conn = pool.acquire().await?;
        sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;
        let result = compact_oversized_payloads_on_connection(&mut conn, limit).await;
        match result {
            Ok(reclaimed) => {
                sqlx::query("COMMIT").execute(&mut *conn).await?;
                Ok(reclaimed)
            }
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                Err(error)
            }
        }
    }

    /// Fetch all raw events for a single turn in causal sequence order using
    /// `idx_conversation_events_turn_seq (conversation_id, turn_id, sequence)`.
    ///
    /// Used by `CachedRowProjector` on LRU eviction / process restart to reconstruct
    /// an active `ProjectedTurn` losslessly without deserializing truncated `row_json`.
    pub async fn events_for_turn<'e, E>(
        executor: E,
        conversation_id: Uuid,
        turn_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {EVENT_COLUMNS}
               FROM conversation_events
               WHERE conversation_id = ? AND turn_id = ?
               ORDER BY sequence ASC"#
        ))
        .bind(conversation_id)
        .bind(turn_id)
        .fetch_all(executor)
        .await
    }

    /// Bounded variant of `events_since` returning only events with `sequence > after_sequence`
    /// and `sequence < before_sequence`.
    pub async fn events_since_before<'e, E>(
        executor: E,
        conversation_id: Uuid,
        after_sequence: i64,
        before_sequence: i64,
    ) -> Result<Vec<Self>, sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {EVENT_COLUMNS}
               FROM conversation_events
               WHERE conversation_id = ?1
                 AND sequence > ?2
                 AND sequence < ?3
               ORDER BY sequence ASC"#
        ))
        .bind(conversation_id)
        .bind(after_sequence)
        .bind(before_sequence)
        .fetch_all(executor)
        .await
    }

    /// Bounded turn hydration query using `idx_conversation_events_turn_seq`: fetches all events
    /// belonging to `turn_id` strictly before `before_sequence`, plus any `turn_id IS NULL` events
    /// in `[min_unassigned_sequence, before_sequence)`.
    pub async fn events_for_turn_with_unassigned_before<'e, E>(
        executor: E,
        conversation_id: Uuid,
        turn_id: Uuid,
        min_unassigned_sequence: i64,
        before_sequence: i64,
    ) -> Result<Vec<Self>, sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {EVENT_COLUMNS}
               FROM conversation_events
               WHERE conversation_id = ?1
                 AND turn_id = ?2
                 AND sequence < ?4
               UNION ALL
               SELECT {EVENT_COLUMNS}
               FROM conversation_events
               WHERE conversation_id = ?1
                 AND turn_id IS NULL
                 AND sequence >= ?3
                 AND sequence < ?4
               ORDER BY sequence ASC"#
        ))
        .bind(conversation_id)
        .bind(turn_id)
        .bind(min_unassigned_sequence)
        .bind(before_sequence)
        .fetch_all(executor)
        .await
    }

    /// Fetch events of a single `event_kind` after `after_sequence` using
    /// `idx_conversation_events_conversation_kind_sequence`.
    pub async fn events_of_kind_since<'e, E>(
        executor: E,
        conversation_id: Uuid,
        event_kind: &str,
        after_sequence: i64,
    ) -> Result<Vec<Self>, sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {EVENT_COLUMNS}
               FROM conversation_events
               WHERE conversation_id = ?1
                 AND event_kind = ?2
                 AND sequence > ?3
               ORDER BY sequence ASC"#
        ))
        .bind(conversation_id)
        .bind(event_kind)
        .bind(after_sequence)
        .fetch_all(executor)
        .await
    }
}

fn bulky_event_kind(kind: &str) -> bool {
    matches!(
        kind,
        "tool_call_upsert" | "terminal_updated" | "raw_diagnostic_recorded"
    )
}

/// Cap bulky tool, terminal, and diagnostic documents before they are stored.
///
/// Other kinds, including user turns that carry images, are left intact. A
/// small document is returned borrowed. When a bulky document is capped, the
/// duplicate `raw_json` copy is dropped.
pub fn cap_stored_event_payloads<'a>(
    event_kind: &str,
    normalized_json: &'a str,
    raw_json: Option<&'a str>,
) -> (Cow<'a, str>, Option<Cow<'a, str>>) {
    let raw_over_cap = raw_json.is_some_and(|raw| raw.len() > MAX_STORED_EVENT_JSON_BYTES);
    if !bulky_event_kind(event_kind) {
        let raw = if raw_over_cap {
            None
        } else {
            raw_json.map(Cow::Borrowed)
        };
        return (Cow::Borrowed(normalized_json), raw);
    }
    if normalized_json.len() <= MAX_STORED_STRING_BYTES && !raw_over_cap {
        return (Cow::Borrowed(normalized_json), raw_json.map(Cow::Borrowed));
    }

    let (capped, truncated) = cap_json_document(event_kind, normalized_json);
    let normalized = if truncated {
        Cow::Owned(capped)
    } else {
        Cow::Borrowed(normalized_json)
    };
    let raw = if truncated || raw_over_cap {
        None
    } else {
        raw_json.map(Cow::Borrowed)
    };
    (normalized, raw)
}

fn cap_json_document(kind: &str, normalized_json: &str) -> (String, bool) {
    let Ok(mut value) = serde_json::from_str::<Value>(normalized_json) else {
        return (fallback_event_json(kind, None, normalized_json), true);
    };
    let mut truncated = cap_strings(&mut value, MAX_STORED_STRING_BYTES);
    if truncated {
        mark_terminal_truncated(kind, &mut value);
    }
    if !truncated && normalized_json.len() <= MAX_STORED_EVENT_JSON_BYTES {
        return (String::new(), false);
    }

    let mut text = serde_json::to_string(&value).unwrap_or_default();
    if text.len() > MAX_STORED_EVENT_JSON_BYTES {
        truncated = true;
        for max_string in [1024usize, 256, 64] {
            cap_strings(&mut value, max_string);
            mark_terminal_truncated(kind, &mut value);
            text = serde_json::to_string(&value).unwrap_or_default();
            if text.len() <= MAX_STORED_EVENT_JSON_BYTES {
                break;
            }
        }
    }
    if truncated {
        mark_terminal_truncated(kind, &mut value);
        text = serde_json::to_string(&value).unwrap_or_default();
    }
    if text.is_empty() || text.len() > MAX_STORED_EVENT_JSON_BYTES {
        return (
            fallback_event_json(kind, Some(&value), normalized_json),
            true,
        );
    }
    (text, truncated)
}

fn mark_terminal_truncated(kind: &str, value: &mut Value) {
    if kind != "terminal_updated" {
        return;
    }
    let Some(terminal) = value.get_mut("terminal").and_then(Value::as_object_mut) else {
        return;
    };
    terminal.insert("output_truncated".to_string(), Value::Bool(true));
}

fn cap_strings(value: &mut Value, max_bytes: usize) -> bool {
    match value {
        Value::String(text) => {
            if text.len() <= max_bytes {
                return false;
            }
            *text = truncate_string_keep_tail(text, max_bytes);
            true
        }
        Value::Array(items) => {
            let mut truncated = false;
            for item in items {
                truncated |= cap_strings(item, max_bytes);
            }
            truncated
        }
        Value::Object(map) => {
            let mut truncated = false;
            for item in map.values_mut() {
                truncated |= cap_strings(item, max_bytes);
            }
            truncated
        }
        _ => false,
    }
}

fn truncate_string_keep_tail(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let marker = STORED_TRUNCATION_MARKER;
    if max_bytes <= marker.len() {
        return marker
            .char_indices()
            .take_while(|(index, _)| *index < max_bytes)
            .map(|(_, ch)| ch)
            .collect();
    }
    let budget = max_bytes - marker.len();
    let mut start = value.len().saturating_sub(budget);
    while start < value.len() && !value.is_char_boundary(start) {
        start += 1;
    }
    let mut tail = &value[start.min(value.len())..];
    let mut out = String::with_capacity(marker.len() + tail.len());
    out.push_str(marker);
    out.push_str(tail);
    while out.len() > max_bytes {
        let mut next = 1;
        while next < tail.len() && !tail.is_char_boundary(next) {
            next += 1;
        }
        if next >= tail.len() {
            out = marker.to_string();
            break;
        }
        tail = &tail[next..];
        out.clear();
        out.push_str(marker);
        out.push_str(tail);
    }
    out
}

fn fallback_event_json(kind: &str, parsed: Option<&Value>, raw: &str) -> String {
    let preview = truncate_string_keep_tail(raw, 512);
    let value = match kind {
        "tool_call_upsert" => {
            let id = parsed
                .and_then(|value| value.pointer("/tool_call/tool_call_id"))
                .and_then(Value::as_str)
                .unwrap_or("truncated");
            serde_json::json!({
                "kind": "tool_call_upsert",
                "tool_call": {
                    "tool_call_id": id,
                    "status": "failed",
                    "title": preview,
                }
            })
        }
        "terminal_updated" => {
            let id = parsed
                .and_then(|value| value.pointer("/terminal/terminal_id"))
                .and_then(Value::as_str)
                .unwrap_or("truncated");
            serde_json::json!({
                "kind": "terminal_updated",
                "terminal": {
                    "terminal_id": id,
                    "status": "failed",
                    "output_summary": preview,
                    "output_truncated": true,
                }
            })
        }
        _ => serde_json::json!({
            "kind": "raw_diagnostic_recorded",
            "label": "truncated",
            "payload": preview,
        }),
    };
    value.to_string()
}

#[derive(FromRow)]
struct OversizedEventPayload {
    id: Uuid,
    event_kind: String,
    normalized_json: String,
    raw_json: Option<String>,
}

async fn compact_oversized_payloads_on_connection(
    conn: &mut SqliteConnection,
    limit: i64,
) -> Result<u64, sqlx::Error> {
    let cap = MAX_STORED_EVENT_JSON_BYTES as i64;
    let rows = sqlx::query_as::<_, OversizedEventPayload>(
        r#"SELECT id, event_kind, normalized_json, raw_json
           FROM conversation_events
           WHERE (
               event_kind IN ('tool_call_upsert', 'terminal_updated', 'raw_diagnostic_recorded')
               AND (
                   length(CAST(normalized_json AS BLOB)) > ?
                   OR IFNULL(length(CAST(raw_json AS BLOB)), 0) > ?
               )
           ) OR (
               event_kind NOT IN ('tool_call_upsert', 'terminal_updated', 'raw_diagnostic_recorded')
               AND IFNULL(length(CAST(raw_json AS BLOB)), 0) > ?
           )
           LIMIT ?"#,
    )
    .bind(cap)
    .bind(cap)
    .bind(cap)
    .bind(limit)
    .fetch_all(&mut *conn)
    .await?;
    if rows.is_empty() {
        return Ok(0);
    }

    let mut rows_updated = 0u64;
    let mut reclaimed = 0u64;
    for row in rows {
        let before = row.normalized_json.len() + row.raw_json.as_ref().map_or(0, String::len);
        let (normalized, raw) = cap_stored_event_payloads(
            &row.event_kind,
            &row.normalized_json,
            row.raw_json.as_deref(),
        );
        let after = normalized.len() + raw.as_ref().map_or(0, |value| value.len());
        sqlx::query(
            "UPDATE conversation_events SET normalized_json = ?, raw_json = ? WHERE id = ?",
        )
        .bind(normalized.as_ref())
        .bind(raw.as_deref())
        .bind(row.id)
        .execute(&mut *conn)
        .await?;
        rows_updated += 1;
        reclaimed += before.saturating_sub(after) as u64;
    }
    if reclaimed == 0 {
        reclaimed = rows_updated;
    }
    tracing::info!(
        rows = rows_updated,
        bytes_reclaimed = reclaimed,
        "compacted oversized conversation event payloads"
    );
    Ok(reclaimed)
}

pub async fn append_conversation_event(
    tx: &mut Transaction<'_, Sqlite>,
    input: AppendConversationEvent<'_>,
) -> Result<ConversationEventRecord, sqlx::Error> {
    append_conversation_event_on_connection(tx, input).await
}

async fn append_conversation_event_on_connection(
    conn: &mut SqliteConnection,
    input: AppendConversationEvent<'_>,
) -> Result<ConversationEventRecord, sqlx::Error> {
    if let Some(existing) =
        find_conversation_event_by_idempotency(conn, input.conversation_id, input.idempotency_key)
            .await?
    {
        return Ok(existing);
    }

    insert_conversation_event(conn, input).await
}

/// Look up an already-persisted event by idempotency key (within a connection/tx).
///
/// Returning the existing record lets the appender skip re-applying its projection
/// side-effects on a duplicate — the side-effects were applied when the event was
/// first inserted.
pub async fn find_conversation_event_by_idempotency(
    conn: &mut SqliteConnection,
    conversation_id: Uuid,
    idempotency_key: Option<&str>,
) -> Result<Option<ConversationEventRecord>, sqlx::Error> {
    let Some(idempotency_key) = idempotency_key else {
        return Ok(None);
    };

    sqlx::query_as::<_, ConversationEventRecord>(&format!(
        r#"SELECT {EVENT_COLUMNS}
           FROM conversation_events
           WHERE conversation_id = ? AND idempotency_key = ?"#
    ))
    .bind(conversation_id)
    .bind(idempotency_key)
    .fetch_optional(&mut *conn)
    .await
}

/// Allocate the next monotonic sequence via `last_allocated_sequence` and insert a fresh
/// event (no idempotency check).
///
/// Callers must run this inside a `BEGIN IMMEDIATE` transaction (and check
/// idempotency first) so sequence allocation is serialized.
pub async fn insert_conversation_event(
    conn: &mut SqliteConnection,
    input: AppendConversationEvent<'_>,
) -> Result<ConversationEventRecord, sqlx::Error> {
    let sequence = crate::models::conversation_snapshot::ConversationProjectionSnapshotRecord::allocate_next_sequence(
        conn,
        input.conversation_id,
        0,
    )
    .await?;

    insert_conversation_event_with_sequence(conn, input, sequence).await
}

pub async fn insert_conversation_event_with_sequence(
    conn: &mut SqliteConnection,
    input: AppendConversationEvent<'_>,
    sequence: i64,
) -> Result<ConversationEventRecord, sqlx::Error> {
    let (normalized_json, raw_json) =
        cap_stored_event_payloads(input.event_kind, input.normalized_json, input.raw_json);
    let mut turn_id = input.turn_id;
    if let Some(candidate) = turn_id {
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM conversation_turns WHERE id = ?)")
                .bind(candidate)
                .fetch_one(&mut *conn)
                .await?;
        if !exists {
            turn_id = None;
        }
    }

    // Every write explicitly stamps the current event-schema version (v1) rather
    // than leaning on the column default, so the write path is self-describing.
    sqlx::query_as::<_, ConversationEventRecord>(&format!(
        r#"INSERT INTO conversation_events (
               id, conversation_id, turn_id, binding_id, connection_id, prompt_id,
               sequence, source, event_kind, event_version, normalized_json, raw_json,
               idempotency_key
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING {EVENT_COLUMNS}"#
    ))
    .bind(input.id)
    .bind(input.conversation_id)
    .bind(turn_id)
    .bind(input.binding_id)
    .bind(input.connection_id)
    .bind(input.prompt_id)
    .bind(sequence)
    .bind(input.source)
    .bind(input.event_kind)
    .bind(CURRENT_EVENT_VERSION)
    .bind(normalized_json.as_ref())
    .bind(raw_json.as_deref())
    .bind(input.idempotency_key)
    .fetch_one(&mut *conn)
    .await
}

#[cfg(test)]
mod tests {
    use std::{str::FromStr, time::Duration};

    use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};

    use super::*;
    use crate::models::{
        conversation::{ConversationRecord, CreateConversationRecord},
        conversation_turn::{ConversationTurnRecord, CreateConversationTurn},
        project::{CreateProject, Project},
        task::{CreateTask, Task},
        workspace::{CreateWorkspace, Workspace},
    };

    async fn setup_pool() -> SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("sqlite options")
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("connect memory db");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("disable foreign keys");
        pool
    }

    async fn setup_concurrent_file_pool() -> (SqlitePool, String) {
        let db_path = std::env::temp_dir().join(format!(
            "dimo-conversation-events-{}.sqlite",
            Uuid::new_v4()
        ));
        let options = SqliteConnectOptions::new()
            .filename(&db_path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_secs(5))
            .foreign_keys(false);
        let db_path = db_path.to_string_lossy().to_string();
        let pool = SqlitePoolOptions::new()
            .max_connections(8)
            .after_connect(|conn, _meta| {
                Box::pin(async move {
                    sqlx::query("PRAGMA foreign_keys = OFF")
                        .execute(conn)
                        .await?;
                    Ok(())
                })
            })
            .connect_with(options)
            .await
            .expect("connect file db");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("disable foreign keys");
        (pool, db_path)
    }

    #[tokio::test]
    async fn conversation_event_append_allocates_sequence_and_dedupes() {
        let pool = setup_pool().await;
        let conversation_id = Uuid::new_v4();
        ConversationRecord::create(
            &pool,
            conversation_id,
            CreateConversationRecord {
                workspace_id: Uuid::new_v4(),
                task_id: None,
                title: None,
                initial_prompt: None,
                status: None,
                executor: Some("agent"),
            },
        )
        .await
        .expect("create conversation");
        let turn = ConversationTurnRecord::create_pending(
            &pool,
            Uuid::new_v4(),
            CreateConversationTurn {
                conversation_id,
                prompt_id: Some("prompt-1"),
                text_preview: Some("hello"),
                input_blocks_json: "[]",
            },
        )
        .await
        .expect("create turn");

        let first = ConversationEventRecord::append(
            &pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id: Some(turn.id),
                binding_id: None,
                connection_id: Some("connection-1"),
                prompt_id: Some("prompt-1"),
                source: "user",
                event_kind: "user_turn_created",
                normalized_json: r#"{"kind":"user_turn_created"}"#,
                raw_json: None,
                idempotency_key: Some("turn-created:1"),
            },
        )
        .await
        .expect("append first");
        assert_eq!(first.sequence, 1);

        let second = ConversationEventRecord::append(
            &pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id: Some(turn.id),
                binding_id: None,
                connection_id: Some("connection-1"),
                prompt_id: Some("prompt-1"),
                source: "acp",
                event_kind: "assistant_text_delta",
                normalized_json: r#"{"kind":"assistant_text_delta","text":"hi"}"#,
                raw_json: Some(r#"{"method":"session/update"}"#),
                idempotency_key: None,
            },
        )
        .await
        .expect("append second");
        assert_eq!(second.sequence, 2);

        let duplicate = ConversationEventRecord::append(
            &pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id: Some(turn.id),
                binding_id: None,
                connection_id: Some("connection-1"),
                prompt_id: Some("prompt-1"),
                source: "user",
                event_kind: "user_turn_created",
                normalized_json: r#"{"kind":"user_turn_created"}"#,
                raw_json: None,
                idempotency_key: Some("turn-created:1"),
            },
        )
        .await
        .expect("append duplicate");
        assert_eq!(duplicate.id, first.id);
        assert_eq!(duplicate.sequence, 1);

        let page = ConversationEventRecord::events_since(&pool, conversation_id, 1, 10)
            .await
            .expect("events since");
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].sequence, 2);
    }

    #[tokio::test]
    async fn insert_nullifies_a_turn_id_that_does_not_exist() {
        let pool = setup_pool().await;

        let conversation_id = Uuid::new_v4();
        ConversationRecord::create(
            &pool,
            conversation_id,
            CreateConversationRecord {
                workspace_id: Uuid::new_v4(),
                task_id: None,
                title: None,
                initial_prompt: None,
                status: None,
                executor: Some("agent"),
            },
        )
        .await
        .expect("create conversation");

        let record = ConversationEventRecord::append(
            &pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id: Some(Uuid::new_v4()),
                binding_id: None,
                connection_id: Some("connection-1"),
                prompt_id: None,
                source: "acp",
                event_kind: "assistant_text_delta",
                normalized_json: r#"{"kind":"assistant_text_delta","text":"hi"}"#,
                raw_json: None,
                idempotency_key: Some("orphan-turn"),
            },
        )
        .await
        .expect("append with missing turn");
        assert_eq!(record.turn_id, None);
    }

    #[tokio::test]
    async fn recent_of_kind_with_executor_covers_historical_spellings_newest_first() {
        // Recovering an agent's last-advertised session controls must see
        // conversations stored under ANY historical executor spelling
        // (`CLAUDE_CODE`, `claude_code`, …) and yield the newest event first.
        let pool = setup_pool().await;

        let append_mode_event = |executor: &'static str, payload: &'static str| {
            let pool = pool.clone();
            async move {
                let conversation_id = Uuid::new_v4();
                ConversationRecord::create(
                    &pool,
                    conversation_id,
                    CreateConversationRecord {
                        workspace_id: Uuid::new_v4(),
                        task_id: None,
                        title: None,
                        initial_prompt: None,
                        status: None,
                        executor: Some(executor),
                    },
                )
                .await
                .expect("create conversation");
                ConversationEventRecord::append(
                    &pool,
                    AppendConversationEvent {
                        id: Uuid::new_v4(),
                        conversation_id,
                        turn_id: None,
                        binding_id: None,
                        connection_id: None,
                        prompt_id: None,
                        source: "acp",
                        event_kind: "session_mode_updated",
                        normalized_json: payload,
                        raw_json: None,
                        idempotency_key: None,
                    },
                )
                .await
                .expect("append event");
            }
        };

        append_mode_event(
            "CLAUDE_CODE",
            r#"{"kind":"session_mode_updated","modes":[{"id":"old"}]}"#,
        )
        .await;
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        append_mode_event(
            "claude_code",
            r#"{"kind":"session_mode_updated","modes":[{"id":"new"}]}"#,
        )
        .await;
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        append_mode_event(
            "codex",
            r#"{"kind":"session_mode_updated","modes":[{"id":"codex"}]}"#,
        )
        .await;

        let rows = ConversationEventRecord::recent_of_kind_with_executor(
            &pool,
            "session_mode_updated",
            50,
        )
        .await
        .expect("query recent events");
        assert_eq!(rows.len(), 3);

        let claude: Vec<_> = rows
            .iter()
            .filter(|(executor, _)| {
                api_types::AgentKind::from_lenient(executor)
                    == Some(api_types::AgentKind::ClaudeCode)
            })
            .collect();
        assert_eq!(claude.len(), 2, "both historical spellings must match");
        assert!(
            claude[0].1.normalized_json.contains("\"new\""),
            "newest claude event must come first"
        );
        assert!(
            rows.iter().any(|(executor, _)| executor == "codex"),
            "other agents' events remain available for their own lookups"
        );
    }

    #[tokio::test]
    async fn conversation_event_append_serializes_concurrent_sequence_allocation() {
        let (pool, db_path) = setup_concurrent_file_pool().await;
        let project_id = Uuid::new_v4();
        Project::create(
            &pool,
            &CreateProject {
                name: "Test Project".to_string(),
                ..Default::default()
            },
            project_id,
        )
        .await
        .expect("create project");
        let task_id = Uuid::new_v4();
        Task::create(
            &pool,
            &CreateTask {
                project_id,
                title: "Test Task".to_string(),
                description: None,
                status: None,
                parent_workspace_id: None,
                image_ids: None,
            },
            task_id,
        )
        .await
        .expect("create task");
        let workspace_id = Uuid::new_v4();
        Workspace::create(
            &pool,
            &CreateWorkspace {
                project_id,
                parent_workspace_id: None,
                branch: "main".to_string(),
                container_ref: None,
                use_worktree: false,
                agent_working_dir: None,
            },
            workspace_id,
            task_id,
        )
        .await
        .expect("create workspace");
        let conversation_id = Uuid::new_v4();
        ConversationRecord::create(
            &pool,
            conversation_id,
            CreateConversationRecord {
                workspace_id,
                task_id: Some(task_id),
                title: None,
                initial_prompt: None,
                status: None,
                executor: Some("agent"),
            },
        )
        .await
        .expect("create conversation");
        let turn = ConversationTurnRecord::create_pending(
            &pool,
            Uuid::new_v4(),
            CreateConversationTurn {
                conversation_id,
                prompt_id: Some("prompt-1"),
                text_preview: Some("hello"),
                input_blocks_json: "[]",
            },
        )
        .await
        .expect("create turn");

        let mut join_set = tokio::task::JoinSet::new();
        for index in 0..24 {
            let pool = pool.clone();
            let turn_id = turn.id;
            join_set.spawn(async move {
                let idempotency_key = format!("event:{index}");
                ConversationEventRecord::append(
                    &pool,
                    AppendConversationEvent {
                        id: Uuid::new_v4(),
                        conversation_id,
                        turn_id: Some(turn_id),
                        binding_id: None,
                        connection_id: Some("connection-1"),
                        prompt_id: Some("prompt-1"),
                        source: "acp",
                        event_kind: "assistant_text_delta",
                        normalized_json: r#"{"kind":"assistant_text_delta","text":"hi"}"#,
                        raw_json: Some(r#"{"method":"session/update"}"#),
                        idempotency_key: Some(idempotency_key.as_str()),
                    },
                )
                .await
            });
        }

        let mut sequences = Vec::new();
        while let Some(result) = join_set.join_next().await {
            let record = result.expect("join task").expect("append event");
            sequences.push(record.sequence);
        }

        sequences.sort_unstable();
        assert_eq!(sequences, (1..=24).collect::<Vec<_>>());

        pool.close().await;
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{db_path}{suffix}"));
        }
    }

    #[test]
    fn small_assistant_text_is_not_copied_or_capped() {
        let (normalized, raw) = cap_stored_event_payloads(
            "assistant_text_delta",
            r#"{"kind":"assistant_text_delta","text":"hi"}"#,
            Some(r#"{"method":"session/update"}"#),
        );
        assert!(matches!(normalized, std::borrow::Cow::Borrowed(_)));
        assert!(matches!(raw, Some(std::borrow::Cow::Borrowed(_))));
    }

    #[tokio::test]
    async fn oversized_tool_call_is_stored_with_a_visible_truncation_marker() {
        let pool = setup_pool().await;
        let conversation_id = Uuid::new_v4();
        let output = "x".repeat(100_000);
        let normalized = format!(
            r#"{{"kind":"tool_call_upsert","tool_call":{{"tool_call_id":"call-1","status":"completed","raw_output":"{output}"}}}}"#
        );
        let stored = ConversationEventRecord::append(
            &pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id: None,
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                source: "acp",
                event_kind: "tool_call_upsert",
                normalized_json: &normalized,
                raw_json: Some(&normalized),
                idempotency_key: None,
            },
        )
        .await
        .expect("append oversized tool call");

        assert!(stored.normalized_json.len() <= MAX_STORED_EVENT_JSON_BYTES);
        assert!(stored.normalized_json.contains("[truncated]"));
        assert!(stored.raw_json.is_none());
        let parsed: serde_json::Value =
            serde_json::from_str(&stored.normalized_json).expect("capped json parses");
        assert_eq!(parsed["kind"], "tool_call_upsert");
        assert_eq!(parsed["tool_call"]["tool_call_id"], "call-1");
    }

    #[test]
    fn truncated_terminal_output_is_marked() {
        let output = "y".repeat(20_000);
        let normalized = format!(
            r#"{{"kind":"terminal_updated","terminal":{{"terminal_id":"term-1","status":"finished","output_summary":"{output}","output_truncated":false}}}}"#
        );
        let (capped, raw) =
            cap_stored_event_payloads("terminal_updated", &normalized, Some(r#"{"raw":true}"#));
        assert!(raw.is_none());
        let parsed: serde_json::Value =
            serde_json::from_str(capped.as_ref()).expect("terminal json parses");
        assert_eq!(parsed["terminal"]["output_truncated"], true);
        assert!(
            parsed["terminal"]["output_summary"]
                .as_str()
                .unwrap_or("")
                .contains("[truncated]")
        );
    }

    #[tokio::test]
    async fn compact_oversized_payloads_rewrites_rows_inserted_before_the_cap() {
        let pool = setup_pool().await;
        let id = Uuid::new_v4();
        let conversation_id = Uuid::new_v4();
        let output = "z".repeat(80_000);
        let normalized = format!(
            r#"{{"kind":"tool_call_upsert","tool_call":{{"tool_call_id":"old","status":"completed","raw_output":"{output}"}}}}"#
        );
        sqlx::query(
            "INSERT INTO conversation_events (
                id, conversation_id, sequence, source, event_kind, normalized_json, raw_json
             ) VALUES (?, ?, 1, 'acp', 'tool_call_upsert', ?, ?)",
        )
        .bind(id)
        .bind(conversation_id)
        .bind(&normalized)
        .bind(&normalized)
        .execute(&pool)
        .await
        .expect("insert historical oversized row");

        let reclaimed = ConversationEventRecord::compact_oversized_payloads(&pool, 25)
            .await
            .expect("compact");
        assert!(reclaimed > 0);

        let stored = sqlx::query_as::<_, ConversationEventRecord>(&format!(
            "SELECT {EVENT_COLUMNS} FROM conversation_events WHERE id = ?"
        ))
        .bind(id)
        .fetch_one(&pool)
        .await
        .expect("read compacted row");
        assert!(stored.normalized_json.len() <= MAX_STORED_EVENT_JSON_BYTES);
        assert!(stored.normalized_json.contains("[truncated]"));
        assert!(stored.raw_json.is_none());
        assert_eq!(
            ConversationEventRecord::compact_oversized_payloads(&pool, 25)
                .await
                .expect("second compact"),
            0
        );
    }
}
