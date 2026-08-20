use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{Executor, FromRow, Sqlite, SqliteConnection, SqlitePool, Transaction};
use ts_rs::TS;
use uuid::Uuid;

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

/// Allocate the next sequence and insert a fresh event (no idempotency check).
///
/// Callers must run this inside a `BEGIN IMMEDIATE` transaction (and check
/// idempotency first) so sequence allocation is serialized.
pub async fn insert_conversation_event(
    conn: &mut SqliteConnection,
    input: AppendConversationEvent<'_>,
) -> Result<ConversationEventRecord, sqlx::Error> {
    let sequence: i64 = sqlx::query_scalar(
        r#"SELECT COALESCE(MAX(sequence), 0) + 1
           FROM conversation_events
           WHERE conversation_id = ?"#,
    )
    .bind(input.conversation_id)
    .fetch_one(&mut *conn)
    .await?;

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
    .bind(input.turn_id)
    .bind(input.binding_id)
    .bind(input.connection_id)
    .bind(input.prompt_id)
    .bind(sequence)
    .bind(input.source)
    .bind(input.event_kind)
    .bind(CURRENT_EVENT_VERSION)
    .bind(input.normalized_json)
    .bind(input.raw_json)
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
            "vibex-conversation-events-{}.sqlite",
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
                repositories: Vec::new(),
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
}
