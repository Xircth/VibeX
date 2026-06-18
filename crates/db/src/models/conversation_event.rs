use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Sqlite, SqliteConnection, SqlitePool, Transaction};
use ts_rs::TS;
use uuid::Uuid;

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

const EVENT_COLUMNS: &str = r#"id,
    conversation_id,
    turn_id,
    binding_id,
    connection_id,
    prompt_id,
    sequence,
    source,
    event_kind,
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

    pub async fn events_since(
        pool: &SqlitePool,
        conversation_id: Uuid,
        after_sequence: i64,
        limit: i64,
    ) -> Result<Vec<Self>, sqlx::Error> {
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
        .fetch_all(pool)
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
    if let Some(idempotency_key) = input.idempotency_key
        && let Some(existing) = sqlx::query_as::<_, ConversationEventRecord>(&format!(
            r#"SELECT {EVENT_COLUMNS}
               FROM conversation_events
               WHERE conversation_id = ? AND idempotency_key = ?"#
        ))
        .bind(input.conversation_id)
        .bind(idempotency_key)
        .fetch_optional(&mut *conn)
        .await?
    {
        return Ok(existing);
    }

    let sequence: i64 = sqlx::query_scalar(
        r#"SELECT COALESCE(MAX(sequence), 0) + 1
           FROM conversation_events
           WHERE conversation_id = ?"#,
    )
    .bind(input.conversation_id)
    .fetch_one(&mut *conn)
    .await?;

    sqlx::query_as::<_, ConversationEventRecord>(&format!(
        r#"INSERT INTO conversation_events (
               id, conversation_id, turn_id, binding_id, connection_id, prompt_id,
               sequence, source, event_kind, normalized_json, raw_json,
               idempotency_key
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        let db_path = db_path.to_string_lossy().to_string();
        let database_url = format!("sqlite://{db_path}");
        let options = SqliteConnectOptions::from_str(&database_url)
            .expect("sqlite options")
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_secs(5))
            .foreign_keys(false);
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
