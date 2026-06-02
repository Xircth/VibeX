use executors::executors::BaseCodingAgent;

use super::*;

fn turn_request(provider: ProviderId) -> ProviderTurnRequest {
    ProviderTurnRequest {
        provider,
        workspace_id: Uuid::new_v4().to_string(),
        executor_profile_id: None,
        thread_id: None,
        session_id: None,
        text: "hello".to_string(),
        model: None,
        images: Vec::new(),
        provider_options: serde_json::Map::new(),
    }
}

async fn codex_interrupt_test_pool() -> SqlitePool {
    let pool = SqlitePool::connect(":memory:").await.expect("memory db");
    sqlx::query(
        r#"CREATE TABLE coding_agent_turns (
            id BLOB PRIMARY KEY,
            execution_process_id BLOB NOT NULL,
            agent_session_id TEXT,
            agent_message_id TEXT,
            prompt TEXT,
            summary TEXT,
            seen INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )"#,
    )
    .execute(&pool)
    .await
    .expect("coding agent turns table");
    sqlx::query(
        r#"CREATE TABLE execution_processes (
            id BLOB PRIMARY KEY,
            status TEXT NOT NULL,
            exit_code INTEGER,
            completed_at TEXT
        )"#,
    )
    .execute(&pool)
    .await
    .expect("execution processes table");
    sqlx::query(
        r#"CREATE TABLE sessions (
            id BLOB PRIMARY KEY,
            status TEXT NOT NULL,
            updated_at TEXT
        )"#,
    )
    .execute(&pool)
    .await
    .expect("sessions table");
    pool
}

async fn insert_codex_interrupt_process(pool: &SqlitePool, process_id: Uuid) {
    sqlx::query("INSERT INTO execution_processes (id, status) VALUES (?, 'running')")
        .bind(process_id)
        .execute(pool)
        .await
        .expect("execution process row");
}

async fn insert_codex_interrupt_session(pool: &SqlitePool, session_id: Uuid) {
    sqlx::query("INSERT INTO sessions (id, status) VALUES (?, 'inprogress')")
        .bind(session_id)
        .execute(pool)
        .await
        .expect("session row");
}

async fn insert_codex_interrupt_turn(
    pool: &SqlitePool,
    process_id: Uuid,
    thread_id: &str,
    turn_id: &str,
) {
    let now = chrono::Utc::now();
    sqlx::query(
        r#"INSERT INTO coding_agent_turns (
            id, execution_process_id, agent_session_id, agent_message_id,
            prompt, summary, seen, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, NULL, 0, ?, ?)"#,
    )
    .bind(Uuid::new_v4())
    .bind(process_id)
    .bind(thread_id)
    .bind(turn_id)
    .bind(now)
    .bind(now)
    .execute(pool)
    .await
    .expect("coding agent turn row");
}

fn codex_interrupt_test_sink(
    pool: SqlitePool,
    process_id: Uuid,
    session_id: Uuid,
) -> NativeConversationSink {
    NativeConversationSink {
        pool,
        process_id,
        session_id,
        msg_store: std::sync::Arc::new(MsgStore::new()),
        state: std::sync::Arc::new(Mutex::new(NativeConversationState::default())),
    }
}

async fn codex_interrupt_process_status(pool: &SqlitePool, process_id: Uuid) -> String {
    sqlx::query_scalar("SELECT status FROM execution_processes WHERE id = ?")
        .bind(process_id)
        .fetch_one(pool)
        .await
        .expect("execution process status")
}

#[test]
fn display_prompt_includes_provider_turn_images_as_markdown() {
    let images = vec![
        ".vibe-images/shot.png".to_string(),
        "  ".to_string(),
        ".vibe-images/second.webp".to_string(),
    ];

    assert_eq!(
        prompt_with_display_images("analyze this", &images),
        "analyze this\n\n![](.vibe-images/shot.png)\n![](.vibe-images/second.webp)"
    );
}

#[test]
fn display_prompt_can_be_image_only() {
    assert_eq!(
        prompt_with_display_images("", &[".vibe-images/shot.png".to_string()]),
        "![](.vibe-images/shot.png)"
    );
}

#[test]
fn display_prompt_can_use_composer_display_text_separately_from_backend_text() {
    let mut request = turn_request(ProviderId::Codex);
    request.text = "Review src/App.tsx with $plan".to_string();
    request.provider_options.insert(
        "display_text".to_string(),
        serde_json::Value::String("Review @src/App.tsx with $plan".to_string()),
    );

    assert_eq!(
        provider_turns::provider_visible_prompt(&request),
        "Review @src/App.tsx with $plan"
    );
    assert_eq!(request.text, "Review src/App.tsx with $plan");
}

#[tokio::test]
async fn codex_interrupt_completes_thread_sink_when_turn_sink_was_already_removed() {
    let pool = codex_interrupt_test_pool().await;
    let process_id = Uuid::new_v4();
    let session_id = Uuid::new_v4();
    let thread_id = format!("thread-{}", Uuid::new_v4());
    let turn_id = format!("turn-{}", Uuid::new_v4());

    insert_codex_interrupt_process(&pool, process_id).await;
    insert_codex_interrupt_session(&pool, session_id).await;
    insert_codex_interrupt_turn(&pool, process_id, &thread_id, &turn_id).await;

    let sink = codex_interrupt_test_sink(pool.clone(), process_id, session_id);
    CODEX_NATIVE_THREAD_SINKS
        .lock()
        .await
        .insert(thread_id.clone(), sink);
    CODEX_NATIVE_TURN_SINKS.lock().await.remove(&turn_id);

    let interrupted = interrupt_codex_native_execution_process(&pool, process_id)
        .await
        .expect("interrupt result");

    let thread_sink_still_registered = CODEX_NATIVE_THREAD_SINKS
        .lock()
        .await
        .remove(&thread_id)
        .is_some();
    let turn_sink_still_registered = CODEX_NATIVE_TURN_SINKS
        .lock()
        .await
        .remove(&turn_id)
        .is_some();
    let status = codex_interrupt_process_status(&pool, process_id).await;

    assert!(interrupted);
    assert!(!thread_sink_still_registered);
    assert!(!turn_sink_still_registered);
    assert_eq!(status, "killed");
}

#[tokio::test]
async fn codex_interrupt_does_not_complete_thread_sink_for_another_process() {
    let pool = codex_interrupt_test_pool().await;
    let interrupted_process_id = Uuid::new_v4();
    let active_process_id = Uuid::new_v4();
    let session_id = Uuid::new_v4();
    let thread_id = format!("thread-{}", Uuid::new_v4());
    let turn_id = format!("turn-{}", Uuid::new_v4());

    insert_codex_interrupt_process(&pool, interrupted_process_id).await;
    insert_codex_interrupt_process(&pool, active_process_id).await;
    insert_codex_interrupt_session(&pool, session_id).await;
    insert_codex_interrupt_turn(&pool, interrupted_process_id, &thread_id, &turn_id).await;

    let active_sink = codex_interrupt_test_sink(pool.clone(), active_process_id, session_id);
    CODEX_NATIVE_THREAD_SINKS
        .lock()
        .await
        .insert(thread_id.clone(), active_sink);
    CODEX_NATIVE_TURN_SINKS.lock().await.remove(&turn_id);

    let interrupted = interrupt_codex_native_execution_process(&pool, interrupted_process_id)
        .await
        .expect("interrupt result");

    let preserved_sink = CODEX_NATIVE_THREAD_SINKS
        .lock()
        .await
        .remove(&thread_id)
        .expect("active sink should remain registered");
    let status = codex_interrupt_process_status(&pool, interrupted_process_id).await;

    assert!(!interrupted);
    assert_eq!(preserved_sink.process_id, active_process_id);
    assert_eq!(status, "running");
}

#[path = "tests_events.rs"]
mod events;
#[path = "tests_sdk.rs"]
mod sdk;
