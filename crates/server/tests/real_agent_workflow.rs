use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use db::models::{
    project::{CreateProject, Project},
    project_repo::ProjectRepo,
    task::{CreateTask, Task},
    workspace::{CreateWorkspace, Workspace},
    workspace_repo::{CreateWorkspaceRepo, WorkspaceRepo},
};
use remote_protocol::{CommandResponse, OperationId};
use server::{HeadlessServer, ServerBootstrapConfig, ServerToken};
use tempfile::TempDir;
use tower::ServiceExt;
use uuid::Uuid;

const TOKEN: &str = "real-agent-release-gate-token-32-bytes";

async fn call(app: axum::Router, command: &str, args: serde_json::Value) -> serde_json::Value {
    let response = app
        .oneshot(
            Request::post(format!("/api/v1/call/{command}"))
                .header("authorization", format!("Bearer {TOKEN}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&serde_json::json!({
                        "operation_id": OperationId::new(),
                        "args": args,
                    }))
                    .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 8 * 1024 * 1024)
        .await
        .unwrap();
    assert_eq!(
        status,
        StatusCode::OK,
        "{command} failed: {}",
        String::from_utf8_lossy(&bytes)
    );
    serde_json::from_slice::<CommandResponse<serde_json::Value>>(&bytes)
        .unwrap()
        .data
}

#[tokio::test]
#[ignore = "release gate: requires VIBEX_REAL_AGENT_ACP and an authenticated Codex CLI"]
async fn real_agent_completes_a_headless_workflow_through_conversation_control() {
    let acp_path = std::env::var("VIBEX_REAL_AGENT_ACP")
        .expect("set VIBEX_REAL_AGENT_ACP to an absolute codex-acp executable");
    let codex_path = std::env::var("VIBEX_REAL_CODEX")
        .expect("set VIBEX_REAL_CODEX to an absolute authenticated codex executable");
    assert!(std::path::Path::new(&acp_path).is_absolute());
    assert!(std::path::Path::new(&codex_path).is_absolute());

    let data_dir = TempDir::new().unwrap();
    let workspace_dir = TempDir::new().unwrap();
    let server = HeadlessServer::bootstrap(
        ServerBootstrapConfig::new(data_dir.path()).with_token(ServerToken::new(TOKEN)),
    )
    .await
    .unwrap();
    let pool = server.pool();
    let project_id = Uuid::new_v4();
    Project::create(
        pool,
        &CreateProject {
            name: "real-agent-release-gate".to_string(),
            repositories: Vec::new(),
        },
        project_id,
    )
    .await
    .unwrap();
    let task = Task::create(
        pool,
        &CreateTask::from_title_description(project_id, "real Agent workflow".to_string(), None),
        Uuid::new_v4(),
    )
    .await
    .unwrap();
    let workspace = Workspace::create(
        pool,
        &CreateWorkspace {
            project_id,
            parent_workspace_id: None,
            branch: "release-gate".to_string(),
            container_ref: Some(workspace_dir.path().to_string_lossy().into_owned()),
            use_worktree: false,
            agent_working_dir: None,
        },
        Uuid::new_v4(),
        task.id,
    )
    .await
    .unwrap();
    let repo = ProjectRepo::add_repo_to_project(
        pool,
        project_id,
        &workspace_dir.path().to_string_lossy(),
        "release-gate",
    )
    .await
    .unwrap();
    WorkspaceRepo::create_many(
        pool,
        workspace.id,
        &[CreateWorkspaceRepo {
            repo_id: repo.id,
            target_branch: "main".to_string(),
        }],
    )
    .await
    .unwrap();

    let lock_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO agent_membership
         (agent_id, source, built_in, retired, enabled, position)
         VALUES ('codex', 'built_in_profile', 1, 0, 1, 0)
         ON CONFLICT(agent_id) DO UPDATE SET enabled = 1, retired = 0",
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO agent_install_lock
         (id, agent_id, registry_version, platform, distribution_kind, resolved_json, created_at)
         VALUES (?, 'codex', 'release-gate', 'local', 'binary', ?, datetime('now'))",
    )
    .bind(&lock_id)
    .bind(
        serde_json::json!({
            "absolute_acp_program": acp_path,
            "args": [],
            "env": {"CODEX_PATH": codex_path},
            "runtime_version": "release-gate",
            "acp_version": "1.1.9"
        })
        .to_string(),
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO agent_installation
         (agent_id, ownership, lifecycle, current_lock_id, updated_at)
         VALUES ('codex', 'external', 'ready', ?, datetime('now'))
         ON CONFLICT(agent_id) DO UPDATE SET lifecycle = 'ready', current_lock_id = excluded.current_lock_id",
    )
    .bind(&lock_id)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO agent_probe (agent_id, lifecycle, authentication, detail_json, probed_at)
         VALUES ('codex', 'ready', 'account', '{}', datetime('now'))
         ON CONFLICT(agent_id) DO UPDATE SET lifecycle = 'ready', authentication = 'account'",
    )
    .execute(pool)
    .await
    .unwrap();

    let app = server.runtime().router();
    let version = call(
        app.clone(),
        "workflow_publish",
        serde_json::json!({"request": {"definition": {
            "formatVersion": 1,
            "name": "real-agent-release-gate",
            "inputSchema": {"type": "object"},
            "steps": [{
                "id": "answer",
                "dependsOn": [],
                "inputBindings": {},
                "kind": "agent",
                "agentId": "codex",
                "prompt": "Reply with exactly: VIBEX_REAL_AGENT_OK",
                "workspaceAccess": "read_only_shared",
                "sideEffectClass": "read_only",
                "allowOneRepair": false
            }],
            "policy": {
                "maxConcurrentAgentSteps": 1,
                "maxAgentCalls": 1,
                "deadlineSeconds": 120,
                "maxOutputBytes": 65536
            }
        }}}),
    )
    .await;
    let run = call(
        app.clone(),
        "workflow_start",
        serde_json::json!({"request": {
            "definitionVersionId": version["id"],
            "workspaceId": workspace.id,
            "input": {}
        }}),
    )
    .await;
    let run_id = Uuid::parse_str(run["id"].as_str().unwrap()).unwrap();
    let timeout_seconds = std::env::var("VIBEX_REAL_AGENT_TIMEOUT_SECONDS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(120);
    let status = tokio::time::timeout(std::time::Duration::from_secs(timeout_seconds), async {
        loop {
            let status: String =
                sqlx::query_scalar("SELECT status FROM workflow_runs WHERE id = ?")
                    .bind(run_id)
                    .fetch_one(pool)
                    .await
                    .unwrap();
            if matches!(
                status.as_str(),
                "completed" | "failed" | "cancelled" | "interrupted" | "needs_review"
            ) {
                break status;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    })
    .await;
    let status = match status {
        Ok(status) => status,
        Err(_) => {
            let run_status: String =
                sqlx::query_scalar("SELECT status FROM workflow_runs WHERE id = ?")
                    .bind(run_id)
                    .fetch_one(pool)
                    .await
                    .unwrap();
            let dispatch_ready: bool =
                sqlx::query_scalar("SELECT dispatch_ready FROM workflow_runs WHERE id = ?")
                    .bind(run_id)
                    .fetch_one(pool)
                    .await
                    .unwrap();
            let ready_status: Option<String> = sqlx::query_scalar(
                "SELECT status FROM workflow_ready_steps WHERE run_id = ? LIMIT 1",
            )
            .bind(run_id)
            .fetch_optional(pool)
            .await
            .unwrap();
            let global_active: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM workflow_step_runs WHERE status IN ('claimed', 'running')",
            )
            .fetch_one(pool)
            .await
            .unwrap();
            let direct_claim = workflows::WorkflowStore::new(pool.clone())
                .claim_ready(16, chrono::Duration::seconds(30))
                .await;
            let step: (String, Option<Uuid>, Option<Uuid>) = sqlx::query_as(
                "SELECT status, conversation_id, turn_id FROM workflow_step_runs
                 WHERE run_id = ? ORDER BY attempt DESC LIMIT 1",
            )
            .bind(run_id)
            .fetch_one(pool)
            .await
            .unwrap();
            let turn_status = match step.2 {
                Some(turn_id) => sqlx::query_scalar::<_, String>(
                    "SELECT status FROM conversation_turns WHERE id = ?",
                )
                .bind(turn_id)
                .fetch_optional(pool)
                .await
                .unwrap(),
                None => None,
            };
            let events: Vec<String> = sqlx::query_scalar(
                "SELECT event_kind FROM conversation_events
                 WHERE conversation_id = ? ORDER BY sequence",
            )
            .bind(step.1)
            .fetch_all(pool)
            .await
            .unwrap();
            panic!(
                "real Agent workflow timed out: direct_claim={direct_claim:?} run={run_status} dispatch_ready={dispatch_ready} ready={ready_status:?} global_active={global_active} step={} conversation={:?} turn={:?} turn_status={turn_status:?} events={events:?}",
                step.0, step.1, step.2,
            );
        }
    };
    if status != "completed" {
        let workflow_events: Vec<(String, String)> = sqlx::query_as(
            "SELECT event_kind, payload_json FROM workflow_events
             WHERE run_id = ? ORDER BY sequence",
        )
        .bind(run_id)
        .fetch_all(pool)
        .await
        .unwrap();
        let step: (String, Option<Uuid>, Option<Uuid>) = sqlx::query_as(
            "SELECT status, conversation_id, turn_id FROM workflow_step_runs
             WHERE run_id = ? ORDER BY attempt DESC LIMIT 1",
        )
        .bind(run_id)
        .fetch_one(pool)
        .await
        .unwrap();
        let conversation_events: Vec<(String, String)> = sqlx::query_as(
            "SELECT event_kind, normalized_json FROM conversation_events
             WHERE conversation_id = ? ORDER BY sequence",
        )
        .bind(step.1)
        .fetch_all(pool)
        .await
        .unwrap();
        panic!(
            "real Agent workflow failed: status={status} step={step:?} workflow_events={workflow_events:?} conversation_events={conversation_events:?}"
        );
    }
    let output_events: Vec<String> = sqlx::query_scalar(
        "SELECT event.normalized_json
         FROM workflow_step_runs step
         JOIN conversation_events event ON event.conversation_id = step.conversation_id
         WHERE step.run_id = ? AND event.event_kind = 'assistant_text_delta'
         ORDER BY event.sequence",
    )
    .bind(run_id)
    .fetch_all(pool)
    .await
    .unwrap();
    let output = output_events
        .iter()
        .filter_map(|event| serde_json::from_str::<serde_json::Value>(event).ok())
        .filter_map(|event| {
            event
                .get("text")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .collect::<String>();
    assert!(
        output.contains("VIBEX_REAL_AGENT_OK"),
        "unexpected Agent output: {output}"
    );

    let interrupted_version = call(
        app.clone(),
        "workflow_publish",
        serde_json::json!({"request": {"definition": {
            "formatVersion": 1,
            "name": "real-agent-interruption-gate",
            "inputSchema": {"type": "object"},
            "steps": [{
                "id": "mutate",
                "dependsOn": [],
                "inputBindings": {},
                "kind": "agent",
                "agentId": "codex",
                "prompt": "Use the terminal to run sleep 30, then reply done.",
                "workspaceAccess": "write_serialized",
                "sideEffectClass": "mutating_unknown",
                "allowOneRepair": false
            }],
            "policy": {
                "maxConcurrentAgentSteps": 1,
                "maxAgentCalls": 1,
                "deadlineSeconds": 120,
                "maxOutputBytes": 65536
            }
        }}}),
    )
    .await;
    let interrupted = call(
        app.clone(),
        "workflow_start",
        serde_json::json!({"request": {
            "definitionVersionId": interrupted_version["id"],
            "workspaceId": workspace.id,
            "input": {}
        }}),
    )
    .await;
    let interrupted_run_id = Uuid::parse_str(interrupted["id"].as_str().unwrap()).unwrap();
    let (child_id, turn_id) = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            if let Some((child_id, turn_id)) = sqlx::query_as::<_, (Uuid, Uuid)>(
                "SELECT conversation_id, turn_id FROM workflow_step_runs
                 WHERE run_id = ? AND status = 'running'
                   AND conversation_id IS NOT NULL AND turn_id IS NOT NULL",
            )
            .bind(interrupted_run_id)
            .fetch_optional(pool)
            .await
            .unwrap()
            {
                break (child_id, turn_id);
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("mutating Agent Step did not start");
    drop(app);
    drop(server);

    let restarted = HeadlessServer::bootstrap(
        ServerBootstrapConfig::new(data_dir.path()).with_token(ServerToken::new(TOKEN)),
    )
    .await
    .unwrap();
    let recovered_status: String =
        sqlx::query_scalar("SELECT status FROM workflow_runs WHERE id = ?")
            .bind(interrupted_run_id)
            .fetch_one(restarted.pool())
            .await
            .unwrap();
    assert_eq!(recovered_status, "needs_review");
    let recovered_step: (String, Uuid, Uuid) = sqlx::query_as(
        "SELECT status, conversation_id, turn_id FROM workflow_step_runs
         WHERE run_id = ? AND step_id = 'mutate'",
    )
    .bind(interrupted_run_id)
    .fetch_one(restarted.pool())
    .await
    .unwrap();
    assert_eq!(
        recovered_step,
        ("needs_review".to_string(), child_id, turn_id)
    );
    let attempts: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM workflow_step_runs WHERE run_id = ?")
            .bind(interrupted_run_id)
            .fetch_one(restarted.pool())
            .await
            .unwrap();
    assert_eq!(attempts, 1, "restart must not create a replacement attempt");
    let children: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM conversation_relations
         WHERE parent_conversation_id = ? AND kind = 'workflow_step'",
    )
    .bind(interrupted_run_id)
    .fetch_one(restarted.pool())
    .await
    .unwrap();
    assert_eq!(
        children, 1,
        "restart must not duplicate the child Conversation"
    );
}
