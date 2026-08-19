use std::net::SocketAddr;

use agents::{AgentConnectionId, AgentContentBlock, AgentEvent, AgentId, AgentSessionId};
use automation::{
    AgentSelectionIntent, AutomationDraft, AutomationDraftInput, IsolationSpec, ScheduleSpec,
    TurnLaunchSpecInput, WorkspaceTarget,
};
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use plugins::PromptBlock;
use server::{HeadlessServer, ServerBootstrapConfig, ServerConfig};
use tempfile::TempDir;
use tower::ServiceExt;
use uuid::Uuid;

#[tokio::test]
async fn headless_bootstrap_uses_loopback_and_reuses_the_persisted_hash() {
    let data_dir = TempDir::new().expect("data dir");
    let mut first = HeadlessServer::bootstrap(ServerBootstrapConfig::new(data_dir.path()))
        .await
        .expect("first bootstrap");
    assert!(first.runtime().config().listen_addr.ip().is_loopback());
    let token = first
        .take_issued_token()
        .expect("first start issues a token")
        .expose_once();
    drop(first);

    let mut second = HeadlessServer::bootstrap(ServerBootstrapConfig::new(data_dir.path()))
        .await
        .expect("restart");
    assert!(
        second.take_issued_token().is_none(),
        "a restart must load the persisted hash instead of rotating credentials"
    );
    let response = second
        .runtime()
        .router()
        .oneshot(
            Request::builder()
                .uri("/api/v1/capabilities")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
}

#[test]
fn non_loopback_listen_requires_explicit_opt_in() {
    let lan: SocketAddr = "0.0.0.0:3080".parse().expect("address");
    assert!(
        ServerConfig::default()
            .with_listen_addr(lan, false)
            .is_err()
    );
    assert_eq!(
        ServerConfig::default()
            .with_listen_addr(lan, true)
            .expect("explicit LAN opt-in")
            .listen_addr,
        lan
    );
}

#[tokio::test]
async fn only_one_host_owns_automation_and_a_successor_reconciles_running_rows() {
    let data_dir = TempDir::new().expect("data dir");
    let first = HeadlessServer::bootstrap(ServerBootstrapConfig::new(data_dir.path()))
        .await
        .expect("first host");
    assert!(first.owns_automation_engine());

    let competing = HeadlessServer::bootstrap(ServerBootstrapConfig::new(data_dir.path()))
        .await
        .expect("competing host");
    assert!(!competing.owns_automation_engine());
    assert!(competing.automation_recovery().is_none());
    drop(competing);

    let run_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO automation_runs
         (id, automation_id, trigger, status, started_at)
         VALUES (?, ?, 'manual', 'running', datetime('now', 'subsec'))",
    )
    .bind(run_id)
    .bind(Uuid::new_v4())
    .execute(first.pool())
    .await
    .expect("seed orphaned running row");
    drop(first);

    let successor = HeadlessServer::bootstrap(ServerBootstrapConfig::new(data_dir.path()))
        .await
        .expect("successor host");
    assert!(successor.owns_automation_engine());
    assert_eq!(
        successor
            .automation_recovery()
            .expect("owner reconciles")
            .interrupted_run_ids,
        vec![run_id]
    );
    let status: String = sqlx::query_scalar("SELECT status FROM automation_runs WHERE id = ?")
        .bind(run_id)
        .fetch_one(successor.pool())
        .await
        .expect("read recovered row");
    assert_eq!(status, "interrupted");
}

#[tokio::test]
async fn owner_runs_the_scheduler_instead_of_only_holding_the_lock() {
    let data_dir = TempDir::new().expect("data dir");
    let socket = std::net::TcpListener::bind("127.0.0.1:0").expect("reserve port");
    let address = socket.local_addr().expect("address");
    drop(socket);
    let mut config = ServerBootstrapConfig::new(data_dir.path());
    config.server = ServerConfig::default()
        .with_listen_addr(address, false)
        .expect("loopback");
    let server = HeadlessServer::bootstrap(config)
        .await
        .expect("headless owner");
    let pool = server.pool().clone();
    let store = db::models::automation_v2::SqliteAutomationStore::new(pool.clone());
    let automation = store
        .create(
            AutomationDraft {
                name: "scheduler proof".to_string(),
                enabled: true,
                trigger: ScheduleSpec::Schedule {
                    cron: "* * * * *".to_string(),
                    timezone: "UTC".to_string(),
                },
                launch: AutomationDraftInput(TurnLaunchSpecInput {
                    prompt_blocks: vec![PromptBlock::Text {
                        text: "run".to_string(),
                    }],
                    display_text: "run".to_string(),
                    agent: AgentSelectionIntent {
                        agent_id: AgentId::parse("codex").expect("agent"),
                        executor_profile_id: None,
                    },
                    mode_id: None,
                    config_values: Vec::new(),
                    workflow_refs: Vec::new(),
                    skills: Vec::new(),
                    workspace: WorkspaceTarget {
                        project_id: Uuid::new_v4(),
                        root_folder: data_dir.path().to_string_lossy().into_owned(),
                        branch: Some("main".to_string()),
                        isolation: IsolationSpec::WorktreePerRun,
                    },
                    label_snapshot: None,
                }),
            },
            chrono::Utc::now(),
        )
        .await
        .expect("automation");
    sqlx::query("UPDATE automations SET next_run_at = ? WHERE id = ?")
        .bind(chrono::Utc::now() - chrono::Duration::minutes(1))
        .bind(automation.id)
        .execute(&pool)
        .await
        .expect("make due");

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(server.serve_with_shutdown(async move {
        let _ = shutdown_rx.await;
    }));
    let status = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Some(status) = sqlx::query_scalar::<_, String>(
                "SELECT status FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT 1",
            )
            .bind(automation.id)
            .fetch_optional(&pool)
            .await
            .expect("run status")
                && status != "running"
            {
                break status;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("scheduler should execute");
    assert_eq!(status, "failed");
    let _ = shutdown_tx.send(());
    task.await.expect("server task").expect("server shutdown");
}

#[tokio::test]
async fn headless_agent_events_are_persisted_for_websocket_replay() {
    let data_dir = TempDir::new().expect("data dir");
    let server = HeadlessServer::bootstrap(ServerBootstrapConfig::new(data_dir.path()))
        .await
        .expect("headless server");
    let conversation_id = Uuid::new_v4();
    let turn_id = Uuid::new_v4();
    let mut connection = server.pool().acquire().await.expect("database connection");
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&mut *connection)
        .await
        .expect("focused fixture");
    sqlx::query(
        "INSERT INTO sessions (id, workspace_id, status, active_turn_id)
         VALUES (?, ?, 'inprogress', ?)",
    )
    .bind(conversation_id)
    .bind(Uuid::new_v4())
    .bind(turn_id)
    .execute(&mut *connection)
    .await
    .expect("conversation");
    sqlx::query(
        "INSERT INTO conversation_turns
         (id, conversation_id, ordinal, role, status, input_blocks_json)
         VALUES (?, ?, 1, 'user_prompt', 'running', '[]')",
    )
    .bind(turn_id)
    .bind(conversation_id)
    .execute(&mut *connection)
    .await
    .expect("turn");
    drop(connection);

    server
        .agent_runtime()
        .emit_external(
            AgentConnectionId::new(),
            Some(AgentSessionId::from(conversation_id)),
            AgentEvent::MessageChunk {
                content: AgentContentBlock::Text {
                    text: "durable headless output".to_string(),
                },
            },
        )
        .await;

    let normalized: String = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if let Some(value) = sqlx::query_scalar(
                "SELECT normalized_json FROM conversation_events
                     WHERE conversation_id = ? AND event_kind = 'assistant_text_delta'",
            )
            .bind(conversation_id)
            .fetch_optional(server.pool())
            .await
            .expect("event query")
            {
                break value;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("durable runtime event");
    assert!(normalized.contains("durable headless output"));
}
