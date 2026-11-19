use std::{
    path::Path,
    process::Command,
    sync::{Arc, Mutex},
};

use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::Path as AxumPath,
    http::{HeaderMap, Method, Request, StatusCode},
    routing::post,
};
use db::models::{
    project::{CreateProject, Project},
    project_repo::ProjectRepo,
    task::{CreateTask, Task},
    workspace::{CreateWorkspace, Workspace},
    workspace_repo::{CreateWorkspaceRepo, WorkspaceRepo},
};
use remote_protocol::{CommandRequest, OperationId};
use ring::hmac;
use serde_json::{Value, json};
use server::{HeadlessServer, ServerBootstrapConfig, ServerToken};
use tempfile::TempDir;
use tower::ServiceExt as _;
use uuid::Uuid;

const TEST_TOKEN: &str = "workflow-pulse-e2e-test-token-0123456789abcdef";
const WEBHOOK_SECRET: &str = "gh_e2e_webhook_signing_secret";
const GITHUB_TOKEN: &str = "ghp_e2e_secret_token";

#[derive(Debug, Clone)]
struct RecordedGithubComment {
    endpoint: String,
    authorization: Option<String>,
    body: String,
}

fn compile_acp_fixture(dir: &Path) -> std::path::PathBuf {
    let src_path = dir.join("acp_fixture.rs");
    let exe_name = if cfg!(windows) {
        "acp_fixture.exe"
    } else {
        "acp_fixture"
    };
    let bin_path = dir.join(exe_name);
    let source = r#"
use std::io::{self, BufRead, Write};

fn escape_json(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out
}

fn find_top_level_field(line: &str, field: &str) -> Option<(bool, String)> {
    let bytes = line.as_bytes();
    let mut i = 0usize;
    let mut depth = 0i32;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => {
                let start = i + 1;
                i += 1;
                let mut key = String::new();
                while i < bytes.len() {
                    if bytes[i] == b'\\' && i + 1 < bytes.len() {
                        key.push(bytes[i + 1] as char);
                        i += 2;
                        continue;
                    }
                    if bytes[i] == b'"' {
                        break;
                    }
                    key.push(bytes[i] as char);
                    i += 1;
                }
                let _ = start;
                i += 1;
                if depth == 1 && key == field {
                    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                        i += 1;
                    }
                    if i < bytes.len() && bytes[i] == b':' {
                        i += 1;
                        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                            i += 1;
                        }
                        if i >= bytes.len() {
                            return None;
                        }
                        if bytes[i] == b'"' {
                            i += 1;
                            let mut val = String::new();
                            while i < bytes.len() {
                                if bytes[i] == b'\\' && i + 1 < bytes.len() {
                                    val.push(bytes[i + 1] as char);
                                    i += 2;
                                    continue;
                                }
                                if bytes[i] == b'"' {
                                    return Some((true, val));
                                }
                                val.push(bytes[i] as char);
                                i += 1;
                            }
                            return None;
                        } else {
                            let val_start = i;
                            while i < bytes.len()
                                && !matches!(bytes[i], b',' | b'}' | b' ' | b'\r' | b'\n')
                            {
                                i += 1;
                            }
                            return Some((false, line[val_start..i].to_string()));
                        }
                    }
                }
            }
            b'{' | b'[' => {
                depth += 1;
                i += 1;
            }
            b'}' | b']' => {
                depth -= 1;
                i += 1;
            }
            _ => {
                i += 1;
            }
        }
    }
    None
}

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    for raw_line in stdin.lock().lines() {
        let Ok(line) = raw_line else {
            break;
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(wire_log) = std::env::var("DIMO_E2E_WIRE_LOG") {
            let _ = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(wire_log)
                .and_then(|mut f| writeln!(f, "IN: {trimmed}"));
        }
        let method = find_top_level_field(trimmed, "method").map(|(_, v)| v);
        let id_raw = find_top_level_field(trimmed, "id").map(|(is_str, v)| {
            if is_str {
                format!("\"{}\"", escape_json(&v))
            } else {
                v
            }
        });
        let (Some(method), Some(id_json)) = (method, id_raw) else {
            continue;
        };

        let response = match method.as_str() {
            "initialize" => format!(
                "{{\"jsonrpc\":\"2.0\",\"id\":{id_json},\"result\":{{\"protocolVersion\":1,\"agentCapabilities\":{{}},\"authMethods\":[],\"agentInfo\":{{\"name\":\"dimo-e2e-fixture\",\"version\":\"1.0.0-test\"}}}}}}\n"
            ),
            "session/new" => format!(
                "{{\"jsonrpc\":\"2.0\",\"id\":{id_json},\"result\":{{\"sessionId\":\"fixture-session\"}}}}\n"
            ),
            "session/prompt" => {
                if let Ok(log_path) = std::env::var("DIMO_E2E_CWD_LOG") {
                    if let Ok(cwd) = std::env::current_dir() {
                        let _ = std::fs::OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(log_path)
                            .and_then(|mut f| writeln!(f, "{}", cwd.display()));
                    }
                }
                let reply_text = std::env::var("DIMO_E2E_REPLY_FILE")
                    .ok()
                    .and_then(|p| std::fs::read_to_string(p).ok())
                    .unwrap_or_else(|| "{\"summary\":\"default fixture reply\"}".to_string());
                let notif = format!(
                    "{{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{{\"sessionId\":\"fixture-session\",\"update\":{{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{{\"type\":\"text\",\"text\":\"{}\"}}}}}}}}\n",
                    escape_json(&reply_text)
                );
                let _ = stdout.write_all(notif.as_bytes());
                let _ = stdout.flush();
                format!(
                    "{{\"jsonrpc\":\"2.0\",\"id\":{id_json},\"result\":{{\"stopReason\":\"end_turn\"}}}}\n"
                )
            }
            _ => format!(
                "{{\"jsonrpc\":\"2.0\",\"id\":{id_json},\"error\":{{\"code\":-32601,\"message\":\"Method not found\"}}}}\n"
            ),
        };
        let _ = stdout.write_all(response.as_bytes());
        let _ = stdout.flush();
    }
}
"#;
    std::fs::write(&src_path, source).expect("write acp_fixture.rs");
    let rustc = option_env!("RUSTC").unwrap_or("rustc");
    let output = Command::new(rustc)
        .arg("--edition=2021")
        .arg(&src_path)
        .arg("-o")
        .arg(&bin_path)
        .output()
        .expect("invoke rustc for ACP fixture");
    assert!(
        output.status.success(),
        "rustc failed to build acp_fixture:\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    bin_path
}

fn run_git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .expect("run git command");
    assert!(
        out.status.success(),
        "git {args:?} failed in {}: {}",
        dir.display(),
        String::from_utf8_lossy(&out.stderr)
    );
}

fn sign_github_sha256(secret: &str, body: &[u8]) -> String {
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes());
    let tag = hmac::sign(&key, body);
    let mut hex = String::with_capacity(tag.as_ref().len() * 2);
    for b in tag.as_ref() {
        hex.push_str(&format!("{b:02x}"));
    }
    format!("sha256={hex}")
}

async fn send_json(
    router: Router,
    method: Method,
    uri: &str,
    bearer: Option<&str>,
    extra_headers: &[(&str, &str)],
    body_bytes: Vec<u8>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    if !body_bytes.is_empty() {
        builder = builder.header("content-type", "application/json");
    }
    if let Some(token) = bearer {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    for (k, v) in extra_headers {
        builder = builder.header(*k, *v);
    }
    let req = builder
        .body(Body::from(body_bytes))
        .expect("build HTTP request");
    let resp = router.oneshot(req).await.expect("execute HTTP request");
    let status = resp.status();
    let bytes = to_bytes(resp.into_body(), 4 * 1024 * 1024)
        .await
        .expect("read HTTP response body");
    let parsed = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| json!({ "raw": String::from_utf8_lossy(&bytes) }))
    };
    (status, parsed)
}

async fn call_host(router: Router, command: &str, args: Value) -> Value {
    let payload = serde_json::to_vec(&CommandRequest {
        operation_id: OperationId::new(),
        args,
    })
    .expect("serialize CommandRequest");
    let (status, body) = send_json(
        router,
        Method::POST,
        &format!("/api/v1/call/{command}"),
        Some(TEST_TOKEN),
        &[],
        payload,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "command `{command}` failed: {body}");
    body.get("data").cloned().unwrap_or(body)
}

async fn post_github_workflow_run_webhook(
    router: Router,
    source_id: &str,
    delivery_id: &str,
    conclusion: &str,
    pr_number: Option<u64>,
    head_sha: &str,
) -> (StatusCode, Value) {
    let pull_requests = match pr_number {
        Some(num) => json!([{ "number": num }]),
        None => json!([]),
    };
    let payload = json!({
        "action": "completed",
        "repository": { "full_name": "acme/dimo" },
        "sender": { "login": "octocat", "type": "User" },
        "workflow_run": {
            "id": 9001,
            "run_number": 77,
            "name": "CI",
            "status": "completed",
            "conclusion": conclusion,
            "head_branch": "feature/autofix",
            "head_sha": head_sha,
            "html_url": "https://github.com/acme/dimo/actions/runs/9001",
            "event": "pull_request",
            "pull_requests": pull_requests
        }
    });
    let raw_bytes = serde_json::to_vec(&payload).expect("serialize webhook payload");
    let sig = sign_github_sha256(WEBHOOK_SECRET, &raw_bytes);
    send_json(
        router,
        Method::POST,
        &format!("/api/pulse/webhooks/{source_id}"),
        None,
        &[
            ("x-github-event", "workflow_run"),
            ("x-github-delivery", delivery_id),
            ("x-hub-signature-256", &sig),
        ],
        raw_bytes,
    )
    .await
}

async fn wait_for_run_count(pool: &sqlx::SqlitePool, expected_count: usize) -> Vec<(Uuid, String)> {
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            let rows: Vec<(Uuid, String)> = sqlx::query_as(
                "SELECT id, status FROM workflow_runs ORDER BY created_at ASC, id ASC",
            )
            .fetch_all(pool)
            .await
            .expect("query workflow_runs");
            if rows.len() >= expected_count {
                break rows;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("timed out waiting for workflow_runs count")
}

async fn dump_e2e_diagnostics(
    pool: &sqlx::SqlitePool,
    run_id: Uuid,
    wire_log_file: &Path,
    cwd_log_file: &Path,
) -> String {
    let run_row: Option<(Uuid, String)> =
        sqlx::query_as("SELECT id, status FROM workflow_runs WHERE id = ?")
            .bind(run_id)
            .fetch_optional(pool)
            .await
            .unwrap_or_else(|e| Some((Uuid::nil(), e.to_string())));
    type StepDiagRow = (String, String, Option<Uuid>, Option<Uuid>, Option<String>);
    let steps: Vec<StepDiagRow> = sqlx::query_as(
        "SELECT step_id, status, conversation_id, turn_id, execution_evidence_json
             FROM workflow_step_runs WHERE run_id = ? ORDER BY attempt ASC",
    )
    .bind(run_id)
    .fetch_all(pool)
    .await
    .unwrap_or_else(|e| vec![("err".into(), e.to_string(), None, None, None)]);
    let events: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT sequence, event_kind, payload_json FROM workflow_events WHERE run_id = ? ORDER BY sequence ASC",
    )
    .bind(run_id)
    .fetch_all(pool)
    .await
    .unwrap_or_else(|e| vec![(-1, "err".into(), e.to_string())]);
    let turns: Vec<(Uuid, String, Option<String>)> = sqlx::query_as(
        "SELECT id, status, error_json FROM conversation_turns ORDER BY created_at ASC",
    )
    .fetch_all(pool)
    .await
    .unwrap_or_else(|e| vec![(Uuid::nil(), e.to_string(), None)]);
    let conv_inputs: Vec<(Uuid, String)> =
        sqlx::query_as("SELECT id, status FROM conversation_inputs ORDER BY created_at ASC")
            .fetch_all(pool)
            .await
            .unwrap_or_else(|e| vec![(Uuid::nil(), e.to_string())]);
    let conv_events: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT sequence, event_kind, normalized_json FROM conversation_events ORDER BY sequence ASC",
    )
    .fetch_all(pool)
    .await
    .unwrap_or_else(|e| vec![(-1, "err".into(), e.to_string())]);
    let agent_install: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT i.agent_id, i.lifecycle, l.resolved_json
         FROM agent_installation i
         LEFT JOIN agent_install_lock l ON l.id = i.current_lock_id
         WHERE i.agent_id = 'claude_code'",
    )
    .fetch_all(pool)
    .await
    .unwrap_or_else(|e| vec![("err".into(), e.to_string(), None)]);
    let wire = std::fs::read_to_string(wire_log_file).unwrap_or_default();
    let cwds = std::fs::read_to_string(cwd_log_file).unwrap_or_default();
    format!(
        "run={run_row:?}\nsteps={steps:?}\nevents={events:?}\nturns={turns:?}\nconv_inputs={conv_inputs:?}\nconv_events={conv_events:?}\nagent_install={agent_install:?}\nwire_log:\n{wire}\ncwd_log:\n{cwds}"
    )
}

async fn wait_for_terminal_run(
    pool: &sqlx::SqlitePool,
    run_id: Uuid,
    wire_log_file: &Path,
    cwd_log_file: &Path,
) -> String {
    match tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            let status: String =
                sqlx::query_scalar("SELECT status FROM workflow_runs WHERE id = ?")
                    .bind(run_id)
                    .fetch_one(pool)
                    .await
                    .expect("query workflow run status");
            if matches!(
                status.as_str(),
                "completed" | "failed" | "cancelled" | "interrupted" | "needs_review"
            ) {
                break status;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    })
    .await
    {
        Ok(status) => status,
        Err(_) => {
            let diag = dump_e2e_diagnostics(pool, run_id, wire_log_file, cwd_log_file).await;
            panic!("timed out waiting for workflow run {run_id} to reach terminal status:\n{diag}");
        }
    }
}

async fn wait_for_comment_count(
    comments: &Arc<Mutex<Vec<RecordedGithubComment>>>,
    expected_count: usize,
) -> Vec<RecordedGithubComment> {
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            let snapshot = comments.lock().expect("lock comments").clone();
            if snapshot.len() >= expected_count {
                break snapshot;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("timed out waiting for GitHub outbox comment delivery")
}

#[tokio::test]
async fn github_ci_webhook_triggers_isolated_session_workflow_and_posts_pr_and_commit_comments() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("info,conversations=debug,agents=debug,application=debug,server=debug")
        .with_test_writer()
        .try_init();
    let fixture_dir = TempDir::new().expect("create fixture tempdir");
    let acp_bin = compile_acp_fixture(fixture_dir.path());
    let reply_file = fixture_dir.path().join("reply.txt");
    let cwd_log_file = fixture_dir.path().join("cwds.log");
    let wire_log_file = fixture_dir.path().join("wire.log");

    // 1. Mock GitHub REST API for issue comments & commit comments
    let recorded_comments: Arc<Mutex<Vec<RecordedGithubComment>>> =
        Arc::new(Mutex::new(Vec::new()));
    let pr_comments_ref = Arc::clone(&recorded_comments);
    let commit_comments_ref = Arc::clone(&recorded_comments);
    let mock_github = Router::new()
        .route(
            "/repos/{owner}/{repo}/issues/{number}/comments",
            post(
                move |AxumPath((owner, repo, number)): AxumPath<(String, String, String)>,
                      headers: HeaderMap,
                      Json(payload): Json<Value>| {
                    let comments = Arc::clone(&pr_comments_ref);
                    async move {
                        let auth = headers
                            .get("authorization")
                            .and_then(|v| v.to_str().ok())
                            .map(str::to_string);
                        comments
                            .lock()
                            .expect("lock pr comments")
                            .push(RecordedGithubComment {
                                endpoint: format!("/repos/{owner}/{repo}/issues/{number}/comments"),
                                authorization: auth,
                                body: payload["body"].as_str().unwrap_or("").to_string(),
                            });
                        (StatusCode::CREATED, Json(json!({ "id": 1001 })))
                    }
                },
            ),
        )
        .route(
            "/repos/{owner}/{repo}/commits/{sha}/comments",
            post(
                move |AxumPath((owner, repo, sha)): AxumPath<(String, String, String)>,
                      headers: HeaderMap,
                      Json(payload): Json<Value>| {
                    let comments = Arc::clone(&commit_comments_ref);
                    async move {
                        let auth = headers
                            .get("authorization")
                            .and_then(|v| v.to_str().ok())
                            .map(str::to_string);
                        comments.lock().expect("lock commit comments").push(
                            RecordedGithubComment {
                                endpoint: format!("/repos/{owner}/{repo}/commits/{sha}/comments"),
                                authorization: auth,
                                body: payload["body"].as_str().unwrap_or("").to_string(),
                            },
                        );
                        (StatusCode::CREATED, Json(json!({ "id": 1002 })))
                    }
                },
            ),
        );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock github listener");
    let mock_github_base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        let _ = axum::serve(listener, mock_github).await;
    });

    // 2. Real git repository + HeadlessServer bootstrap
    let data_dir = TempDir::new().expect("create data tempdir");
    let repo_parent = TempDir::new().expect("create repo tempdir");
    let repo_dir = repo_parent.path().join("dimo");
    std::fs::create_dir_all(&repo_dir).expect("create repo_dir");
    run_git(&repo_dir, &["init", "-b", "main"]);
    run_git(&repo_dir, &["config", "user.name", "Dimo E2E"]);
    run_git(&repo_dir, &["config", "user.email", "e2e@dimo.local"]);
    std::fs::write(repo_dir.join("README.md"), "# Dimo E2E Repo\n").expect("write README.md");
    run_git(&repo_dir, &["add", "README.md"]);
    run_git(&repo_dir, &["commit", "-m", "initial commit"]);

    let server = HeadlessServer::bootstrap(
        ServerBootstrapConfig::new(data_dir.path())
            .with_token(ServerToken::new(TEST_TOKEN))
            .with_allow_loopback_outbox_for_tests(true),
    )
    .await
    .expect("bootstrap HeadlessServer");
    let pool = server.pool();

    let project_id = Uuid::new_v4();
    Project::create(
        pool,
        &CreateProject {
            name: "acme/dimo".to_string(),
            ..Default::default()
        },
        project_id,
    )
    .await
    .expect("create project");
    let task = Task::create(
        pool,
        &CreateTask::from_title_description(project_id, "GitHub CI Autofix".to_string(), None),
        Uuid::new_v4(),
    )
    .await
    .expect("create task");
    let workspace = Workspace::create(
        pool,
        &CreateWorkspace {
            project_id,
            parent_workspace_id: None,
            branch: "main".to_string(),
            container_ref: Some(repo_dir.to_string_lossy().into_owned()),
            use_worktree: false,
            agent_working_dir: None,
        },
        Uuid::new_v4(),
        task.id,
    )
    .await
    .expect("create workspace");
    let repo =
        ProjectRepo::add_repo_to_project(pool, project_id, &repo_dir.to_string_lossy(), "dimo")
            .await
            .expect("add repo to project");
    WorkspaceRepo::create_many(
        pool,
        workspace.id,
        &[CreateWorkspaceRepo {
            repo_id: repo.id,
            target_branch: "main".to_string(),
        }],
    )
    .await
    .expect("link workspace repo");

    // 3. Seed canonical `claude_code` agent in ACP mode pointing to our self-contained binary.
    // Meanwhile the workflow JSON uses `"agentId": "claude-code"` to verify canonical alias handling.
    let agent_env = json!({
        "DIMO_ENGINE_MODE": "acp",
        "DIMO_E2E_REPLY_FILE": reply_file.to_string_lossy(),
        "DIMO_E2E_CWD_LOG": cwd_log_file.to_string_lossy(),
        "DIMO_E2E_WIRE_LOG": wire_log_file.to_string_lossy(),
    });
    let lock_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO agent_membership
         (agent_id, source, built_in, retired, enabled, position)
         VALUES ('claude_code', 'built_in_profile', 1, 0, 1, 0)
         ON CONFLICT(agent_id) DO UPDATE SET enabled = 1, retired = 0",
    )
    .execute(pool)
    .await
    .expect("seed agent_membership");
    sqlx::query(
        "INSERT INTO agent_setting (agent_type, enabled, env_json)
         VALUES ('claude_code', 1, ?)
         ON CONFLICT(agent_type) DO UPDATE SET enabled = 1, env_json = excluded.env_json",
    )
    .bind(agent_env.to_string())
    .execute(pool)
    .await
    .expect("seed agent_setting");
    sqlx::query(
        "INSERT INTO agent_install_lock
         (id, agent_id, registry_version, platform, distribution_kind, resolved_json, created_at)
         VALUES (?, 'claude_code', 'e2e', 'local', 'binary', ?, datetime('now'))",
    )
    .bind(&lock_id)
    .bind(
        json!({
            "absolute_acp_program": acp_bin.to_string_lossy(),
            "args": [],
            "env": agent_env,
            "runtime_version": "e2e-1.0",
            "acp_version": "e2e-1.0"
        })
        .to_string(),
    )
    .execute(pool)
    .await
    .expect("seed agent_install_lock");
    sqlx::query(
        "INSERT INTO agent_install_component
         (id, lock_id, component_kind, absolute_path, version, sha256,
          trust_state, ownership, shared_resource_key)
         VALUES (?, ?, 'acp', ?, 'e2e-1.0', NULL, 'user_environment', 'external', NULL)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&lock_id)
    .bind(acp_bin.to_string_lossy().as_ref())
    .execute(pool)
    .await
    .expect("seed agent_install_component");
    sqlx::query(
        "INSERT INTO agent_installation
         (agent_id, ownership, lifecycle, current_lock_id, updated_at)
         VALUES ('claude_code', 'external', 'ready', ?, datetime('now'))
         ON CONFLICT(agent_id) DO UPDATE SET lifecycle = 'ready', current_lock_id = excluded.current_lock_id",
    )
    .bind(&lock_id)
    .execute(pool)
    .await
    .expect("seed agent_installation");
    sqlx::query(
        "INSERT INTO agent_probe (agent_id, lifecycle, authentication, detail_json, probed_at)
         VALUES ('claude_code', 'ready', 'account', '{}', datetime('now'))
         ON CONFLICT(agent_id) DO UPDATE SET lifecycle = 'ready', authentication = 'account'",
    )
    .execute(pool)
    .await
    .expect("seed agent_probe");

    let router = server.runtime().router();

    // 4. Configure GitHub webhook source (using `apiBaseUrl` + `githubToken`) and publish real example workflow
    let source = call_host(
        router.clone(),
        "pulse_source_upsert",
        json!({
            "id": "src-gh-ci-e2e",
            "kind": "github",
            "title": "GitHub CI E2E",
            "enabled": true,
            "signingSecret": WEBHOOK_SECRET,
            "configJson": {
                "repo": "acme/dimo",
                "apiBaseUrl": mock_github_base,
                "githubToken": GITHUB_TOKEN
            }
        }),
    )
    .await;
    assert_eq!(
        source["publicWebhookPath"],
        "/api/pulse/webhooks/src-gh-ci-e2e"
    );

    let example_def: Value = serde_json::from_str(include_str!(
        "../../../examples/workflows/github-ci-autofix.dimo-workflow.json"
    ))
    .expect("parse github-ci-autofix example");
    let published_version = call_host(
        router.clone(),
        "workflow_publish",
        json!({
            "request": {
                "definition": example_def
            }
        }),
    )
    .await;
    let workflow_id = published_version["definitionId"]
        .as_str()
        .expect("definitionId on published workflow");

    let saved_rule = call_host(
        router.clone(),
        "pulse_rule_save",
        json!({
            "id": "rule-gh-ci-e2e",
            "enabled": true,
            "spec": {
                "name": "CI Failure Autofix",
                "projectId": project_id.to_string(),
                "evalMode": "auto",
                "orchestrator": "direct_reflex",
                "filter": {
                    "sourceKinds": ["github"],
                    "sourceInstanceIds": ["src-gh-ci-e2e"],
                    "eventTypes": ["github.workflow_run.completed"],
                    "conditions": [
                        { "op": "not_bot_actor" },
                        { "op": "eq", "pointer": "/workflow_run/conclusion", "value": "failure" }
                    ]
                },
                "targets": [{
                    "kind": "workflow",
                    "workflowId": workflow_id,
                    "pinnedVersion": published_version["version"]
                }]
            }
        }),
    )
    .await;
    assert_eq!(saved_rule["id"], "rule-gh-ci-e2e");
    assert_eq!(saved_rule["enabled"], true);

    // 5a. Non-matching webhook (`conclusion == "success"`) must NOT trigger a workflow run
    let (status, ok_resp) = post_github_workflow_run_webhook(
        router.clone(),
        "src-gh-ci-e2e",
        "deliv-success-0",
        "success",
        Some(42),
        "0000000000000000",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "success webhook failed: {ok_resp}");
    assert_eq!(ok_resp["accepted"], true);
    let runs_after_success: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM workflow_runs")
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(
        runs_after_success, 0,
        "success conclusion should not match rule"
    );

    // 5b. Case 1 — Failure webhook with invalid non-JSON assistant output -> isolated worktree + `invalid_structured_output` + 0 comments
    std::fs::write(&reply_file, "Not valid JSON prose output").expect("write invalid reply");
    let (status, resp1) = post_github_workflow_run_webhook(
        router.clone(),
        "src-gh-ci-e2e",
        "deliv-fail-invalid-1",
        "failure",
        Some(42),
        "1111111111111111",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "webhook 1 failed: {resp1}");
    let runs1 = wait_for_run_count(pool, 1).await;
    let run1_id = runs1[0].0;
    let run1_status = wait_for_terminal_run(pool, run1_id, &wire_log_file, &cwd_log_file).await;
    assert_eq!(
        run1_status, "failed",
        "run 1 should fail strict outputSchema validation when assistant returns plain prose"
    );
    let step1_err: (String, Option<String>) = sqlx::query_as(
        "SELECT status, execution_evidence_json
         FROM workflow_step_runs
         WHERE run_id = ? AND step_id = 'diagnose-and-fix'
         ORDER BY attempt DESC LIMIT 1",
    )
    .bind(run1_id)
    .fetch_one(pool)
    .await
    .expect("query run 1 diagnose-and-fix step");
    assert_eq!(step1_err.0, "failed");
    let evidence1: Value = serde_json::from_str(step1_err.1.as_deref().unwrap_or("{}"))
        .expect("parse run 1 evidence json");
    let step_failed_events: Vec<String> = sqlx::query_scalar(
        "SELECT payload_json FROM workflow_events WHERE run_id = ? AND event_kind = 'step_failed'",
    )
    .bind(run1_id)
    .fetch_all(pool)
    .await
    .expect("query step_failed events");
    assert_eq!(
        evidence1["workspace"]["isolated"], true,
        "run 1 evidence missing isolation: {evidence1}; step_failed: {step_failed_events:?}"
    );
    assert!(
        step_failed_events
            .iter()
            .any(|p| p.contains("invalid_structured_output")),
        "expected StepFailed with invalid_structured_output, got: {step_failed_events:?}"
    );
    assert!(
        recorded_comments.lock().unwrap().is_empty(),
        "failed run 1 must not dispatch any GitHub outbox comments"
    );

    // 5c. Case 2 — PR #42 failure webhook with valid structured JSON -> PR issue comment delivered
    std::fs::write(&reply_file, r#"{"summary":"修复缺失导出并补齐单测"}"#)
        .expect("write PR summary reply");
    let (status, resp2) = post_github_workflow_run_webhook(
        router.clone(),
        "src-gh-ci-e2e",
        "deliv-fail-pr-42",
        "failure",
        Some(42),
        "2222222222222222",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "webhook 2 failed: {resp2}");
    let runs2 = wait_for_run_count(pool, 2).await;
    let run2_id = runs2[1].0;
    let run2_status = wait_for_terminal_run(pool, run2_id, &wire_log_file, &cwd_log_file).await;
    assert_eq!(run2_status, "completed", "run 2 should complete cleanly");

    let comments_after_2 = wait_for_comment_count(&recorded_comments, 1).await;
    assert_eq!(comments_after_2.len(), 1);
    assert_eq!(
        comments_after_2[0].endpoint,
        "/repos/acme/dimo/issues/42/comments"
    );
    assert_eq!(
        comments_after_2[0].authorization.as_deref(),
        Some("Bearer ghp_e2e_secret_token")
    );
    assert_eq!(
        comments_after_2[0].body,
        "已完成 CI 失败排查：修复缺失导出并补齐单测"
    );

    // Verify `subscribeThread` persisted subscription for `github:acme/dimo#42`
    let step2_conv_id: Uuid = sqlx::query_scalar(
        "SELECT conversation_id FROM workflow_step_runs
         WHERE run_id = ? AND step_id = 'diagnose-and-fix'
         ORDER BY attempt DESC LIMIT 1",
    )
    .bind(run2_id)
    .fetch_one(pool)
    .await
    .expect("query run 2 diagnose-and-fix conversation_id");
    let sub_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pulse_thread_subscriptions
         WHERE thread_key = 'github:acme/dimo#42'
           AND subscriber_kind = 'session'
           AND subscriber_id = ?
           AND active = 1",
    )
    .bind(step2_conv_id.to_string())
    .fetch_one(pool)
    .await
    .expect("query pulse_thread_subscriptions");
    assert_eq!(sub_count, 1, "diagnose-and-fix should subscribe PR thread");

    // 5d. Case 3 — Commit-only failure webhook (`pull_requests: []`, `head_sha`) -> commit comment delivered
    std::fs::write(&reply_file, r#"{"summary":"修复 main 提交 lint 问题"}"#)
        .expect("write commit summary reply");
    let commit_sha = "deadbeef1234567890abcdef";
    let (status, resp3) = post_github_workflow_run_webhook(
        router.clone(),
        "src-gh-ci-e2e",
        "deliv-fail-commit-3",
        "failure",
        None,
        commit_sha,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "webhook 3 failed: {resp3}");
    let runs3 = wait_for_run_count(pool, 3).await;
    let run3_id = runs3[2].0;
    let run3_status = wait_for_terminal_run(pool, run3_id, &wire_log_file, &cwd_log_file).await;
    assert_eq!(run3_status, "completed", "run 3 should complete cleanly");

    let comments_after_3 = wait_for_comment_count(&recorded_comments, 2).await;
    assert_eq!(comments_after_3.len(), 2);
    assert_eq!(
        comments_after_3[1].endpoint,
        format!("/repos/acme/dimo/commits/{commit_sha}/comments")
    );
    assert_eq!(
        comments_after_3[1].authorization.as_deref(),
        Some("Bearer ghp_e2e_secret_token")
    );
    assert_eq!(
        comments_after_3[1].body,
        "已完成 CI 失败排查：修复 main 提交 lint 问题"
    );

    // Verify ACP fixture executed inside an isolated worktree directory (never in main `repo_dir`)
    let cwds = std::fs::read_to_string(&cwd_log_file).expect("read cwd log");
    let recorded_cwds: Vec<&str> = cwds.lines().filter(|l| !l.trim().is_empty()).collect();
    assert_eq!(
        recorded_cwds.len(),
        3,
        "all three runs should invoke ACP fixture: {recorded_cwds:?}"
    );
    let canonical_repo = std::fs::canonicalize(&repo_dir).expect("canonical repo_dir");
    for cwd in recorded_cwds {
        let canonical_cwd = std::fs::canonicalize(cwd).expect("canonical cwd");
        assert_ne!(
            canonical_cwd, canonical_repo,
            "isolated session must not execute inside main repo directory"
        );
    }
}
