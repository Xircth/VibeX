use axum::{
    body::{Body, to_bytes},
    http::{Method, Request, StatusCode},
};
use base64::Engine as _;
use chrono::Utc;
use pulse::{MAX_WEBHOOK_PAYLOAD_BYTES, sign_standard_webhook};
use remote_protocol::{CommandRequest, OperationId};
use serde_json::{Value, json};
use server::{HeadlessServer, ServerBootstrapConfig, ServerToken};
use tempfile::TempDir;
use tower::ServiceExt as _;

const TEST_TOKEN: &str = "pulse-integration-test-secret-token-0123456789abcdef";

async fn send_json(
    router: axum::Router,
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
    let resp = router.oneshot(req).await.expect("execute oneshot request");
    let status = resp.status();
    let bytes = to_bytes(resp.into_body(), 2 * 1024 * 1024)
        .await
        .expect("read response body");
    let json_body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| json!({ "raw": String::from_utf8_lossy(&bytes) }))
    };
    (status, json_body)
}

async fn call_host_command(
    router: axum::Router,
    command: &str,
    args: Value,
) -> (StatusCode, Value) {
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
    let data = body.get("data").cloned().unwrap_or(body);
    (status, data)
}

fn run_pulse_test<F>(future: F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_stack_size(8 * 1024 * 1024)
        .enable_all()
        .build()
        .expect("build test tokio runtime");
    let result = runtime.block_on(async move { tokio::spawn(future).await });
    runtime.shutdown_background();
    if let Err(join_err) = result {
        std::panic::resume_unwind(join_err.into_panic());
    }
}

#[test]
fn pulse_http_webhooks_observe_promote_dry_run_and_trust_coercion() {
    run_pulse_test(pulse_http_webhooks_observe_promote_dry_run_and_trust_coercion_impl());
}

async fn pulse_http_webhooks_observe_promote_dry_run_and_trust_coercion_impl() {
    let temp = TempDir::new().expect("create tempdir");
    let token = ServerToken::new(TEST_TOKEN);
    let server =
        HeadlessServer::bootstrap(ServerBootstrapConfig::new(temp.path()).with_token(token))
            .await
            .expect("bootstrap HeadlessServer");
    let router = server.runtime().router();

    // 1. Upsert a Standard Webhooks source with a signing secret; verify secret is never leaked.
    let raw_secret = b"0123456789abcdef0123456789abcdef";
    let whsec = format!(
        "whsec_{}",
        base64::engine::general_purpose::STANDARD.encode(raw_secret)
    );
    let (status, source_view) = call_host_command(
        router.clone(),
        "pulse_source_upsert",
        json!({
            "id": "src-std-ci",
            "kind": "webhook_standard",
            "title": "CI Standard Webhook",
            "enabled": true,
            "signingSecret": whsec,
        }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "upsert source response: {source_view}"
    );
    assert_eq!(
        source_view["publicWebhookPath"],
        "/api/pulse/webhooks/src-std-ci"
    );
    assert!(
        source_view.get("signingSecret").is_none() && !source_view.to_string().contains("whsec_"),
        "PulseSourceView must never leak signingSecret: {source_view}"
    );

    // 2a. Oversized webhook (> 64 KiB) -> 413 Payload Too Large before JSON decode.
    let oversized = vec![b'a'; MAX_WEBHOOK_PAYLOAD_BYTES + 128];
    let (status, _) = send_json(
        router.clone(),
        Method::POST,
        "/api/pulse/webhooks/src-std-ci",
        None,
        &[],
        oversized,
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);

    // 2b. Invalid HMAC signature -> 401 Unauthorized and rejectedCount24h increments.
    let body_bytes =
        br#"{"eventType":"ci.build.failed","threadKey":"pr:42","branch":"main"}"#.to_vec();
    let ts_str = Utc::now().timestamp().to_string();
    let (status, err_body) = send_json(
        router.clone(),
        Method::POST,
        "/api/pulse/webhooks/src-std-ci",
        None,
        &[
            ("webhook-id", "msg_bad_sig_1"),
            ("webhook-timestamp", &ts_str),
            ("webhook-signature", "v1,aW52YWxpZF9zaWduYXR1cmVfYnl0ZXM="),
        ],
        body_bytes.clone(),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "bad sig response: {err_body}"
    );

    let (status, sources_after_reject) = send_json(
        router.clone(),
        Method::GET,
        "/api/pulse/sources",
        Some(TEST_TOKEN),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let std_src = sources_after_reject
        .as_array()
        .expect("sources array")
        .iter()
        .find(|s| s["id"] == "src-std-ci")
        .expect("find src-std-ci");
    assert_eq!(std_src["rejectedCount24h"], 1);

    // 2c. Valid Standard Webhooks HMAC signature -> 200 OK, replay -> duplicateDelivery: true.
    let ts = Utc::now().timestamp();
    let valid_sig = sign_standard_webhook(&whsec, "msg_valid_1", ts, &body_bytes)
        .expect("sign standard webhook");
    let valid_ts_str = ts.to_string();
    let (status, ok_resp) = send_json(
        router.clone(),
        Method::POST,
        "/api/pulse/webhooks/src-std-ci",
        None,
        &[
            ("webhook-id", "msg_valid_1"),
            ("webhook-timestamp", &valid_ts_str),
            ("webhook-signature", &valid_sig),
            ("x-pulse-event-type", "ci.build.failed"),
        ],
        body_bytes.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "valid webhook response: {ok_resp}");
    assert_eq!(ok_resp["accepted"], true);
    assert_eq!(ok_resp["duplicateDelivery"], false);

    let (status, dup_resp) = send_json(
        router.clone(),
        Method::POST,
        "/api/pulse/webhooks/src-std-ci",
        None,
        &[
            ("webhook-id", "msg_valid_1"),
            ("webhook-timestamp", &valid_ts_str),
            ("webhook-signature", &valid_sig),
            ("x-pulse-event-type", "ci.build.failed"),
        ],
        body_bytes,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(dup_resp["duplicateDelivery"], true);

    // 3. UntrustedExternal MandateOrigin coercion: requesting `auto` coerces to `observe`.
    let untrusted_rule_req = json!({
        "mandateOrigin": "untrusted_external",
        "spec": {
            "name": "Untrusted Escalation Attempt",
            "evalMode": "auto",
            "filter": {
                "sourceKinds": ["sdk_custom"],
                "eventTypes": ["deploy.requested"],
                "conditions": [
                    {
                        "op": "eq",
                        "pointer": "/payload/environment",
                        "value": "staging"
                    }
                ]
            },
            "targets": [
                {
                    "kind": "user",
                    "interactionKind": "notify",
                    "severity": "info",
                    "titleTemplate": "Deploy {{event.eventType}}",
                    "bodyTemplate": "Branch {{event.payload.branch}}"
                }
            ]
        }
    });
    let (status, coerced_rule) = send_json(
        router.clone(),
        Method::POST,
        "/api/pulse/rules",
        Some(TEST_TOKEN),
        &[],
        serde_json::to_vec(&untrusted_rule_req).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "save rule resp: {coerced_rule}");
    assert_eq!(
        coerced_rule["spec"]["evalMode"], "observe",
        "UntrustedExternal rule must be coerced from auto to observe"
    );
    assert_eq!(coerced_rule["draftOnly"], true);
    assert_eq!(coerced_rule["enabled"], false);
    let rule_id = coerced_rule["id"].as_str().expect("rule id").to_string();

    // Human explicitly enables the Observe rule from the UI / host command.
    let (status, enabled_rule) = call_host_command(
        router.clone(),
        "pulse_rule_set_enabled",
        json!({ "id": rule_id, "enabled": true }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "enable rule resp: {enabled_rule}");
    assert_eq!(enabled_rule["enabled"], true);

    // 4. Emit custom event matching the Observe rule -> creates ObservedCandidate -> Promote -> Auto!
    let emit_body = json!({
        "eventType": "deploy.requested",
        "threadKey": "release:2026-11",
        "payload": {
            "branch": "feat/pulse-event-engine",
            "environment": "staging"
        }
    });
    let (status, emitted_env) = send_json(
        router.clone(),
        Method::POST,
        "/api/pulse/events/emit",
        Some(TEST_TOKEN),
        &[],
        serde_json::to_vec(&emit_body).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "emit resp: {emitted_env}");
    assert_eq!(emitted_env["eventType"], "deploy.requested");

    let (status, deck) = call_host_command(router.clone(), "pulse_deck_snapshot", json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let candidates = deck["observedCandidates"]
        .as_array()
        .expect("observedCandidates array");
    assert_eq!(candidates.len(), 1, "expected 1 observed candidate: {deck}");
    let candidate_id = candidates[0]["id"].as_str().expect("candidate id");

    // 5. Dry-run endpoint returns deterministic PulseDryRunReport.
    let dry_run_req = json!({
        "spec": coerced_rule["spec"],
        "sampleEvent": emitted_env,
    });
    let (status, dry_report) = send_json(
        router.clone(),
        Method::POST,
        "/api/pulse/rules/dry-run",
        Some(TEST_TOKEN),
        &[],
        serde_json::to_vec(&dry_run_req).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "dry-run resp: {dry_report}");
    assert_eq!(dry_report["valid"], true);
    assert_eq!(dry_report["matched"], true);

    // 6. Promote candidate -> rule upgrades to `auto` and User notify interaction is dispatched!
    let (status, promote_resp) = send_json(
        router.clone(),
        Method::POST,
        &format!("/api/pulse/candidates/{candidate_id}/promote"),
        Some(TEST_TOKEN),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "promote resp: {promote_resp}");
    assert_eq!(promote_resp["promoted"], true);

    let (status, deck_after) = call_host_command(router, "pulse_deck_snapshot", json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let upgraded_rule = deck_after["rules"]
        .as_array()
        .expect("rules array")
        .iter()
        .find(|r| r["id"] == rule_id)
        .expect("upgraded rule");
    assert_eq!(upgraded_rule["spec"]["evalMode"], "auto");
    assert!(
        deck_after["observedCandidates"]
            .as_array()
            .expect("candidates")
            .is_empty(),
        "promoted candidate should no longer be pending"
    );
}

async fn setup_server_with_git_workspace() -> (TempDir, HeadlessServer, String, String) {
    use db::models::{
        project::{CreateProject, Project},
        task::{CreateTask, Task},
        workspace::{CreateWorkspace, Workspace},
    };
    use uuid::Uuid;

    let temp = TempDir::new().expect("create tempdir");
    let data_dir = temp.path().join("data");
    let workspace_dir = temp.path().join("workspace");
    std::fs::create_dir_all(&data_dir).expect("create data dir");
    std::fs::create_dir_all(&workspace_dir).expect("create workspace dir");

    let server = HeadlessServer::bootstrap(
        ServerBootstrapConfig::new(&data_dir).with_token(ServerToken::new(TEST_TOKEN)),
    )
    .await
    .expect("bootstrap HeadlessServer");

    let pool = server.pool();
    let project_id = Uuid::new_v4();
    Project::create(
        pool,
        &CreateProject {
            name: "Pulse Remediation Project".to_string(),
            ..Default::default()
        },
        project_id,
    )
    .await
    .expect("create project");

    let task = Task::create(
        pool,
        &CreateTask::from_title_description(project_id, "Pulse Test Workspace".to_string(), None),
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
            container_ref: Some(workspace_dir.to_string_lossy().into_owned()),
            use_worktree: false,
            agent_working_dir: None,
        },
        Uuid::new_v4(),
        task.id,
    )
    .await
    .expect("create workspace");

    (
        temp,
        server,
        project_id.to_string(),
        workspace.id.to_string(),
    )
}

#[test]
fn workflow_user_gate_surfaces_in_pulse_deck_and_resolves_via_rest_and_workflow_decide() {
    run_pulse_test(
        workflow_user_gate_surfaces_in_pulse_deck_and_resolves_via_rest_and_workflow_decide_impl(),
    );
}

async fn workflow_user_gate_surfaces_in_pulse_deck_and_resolves_via_rest_and_workflow_decide_impl()
{
    let (_temp, server, _project_id, workspace_id) = setup_server_with_git_workspace().await;
    let router = server.runtime().router();

    let wf_def = json!({
        "formatVersion": 1,
        "name": "Release Approval Gate",
        "inputSchema": { "type": "object" },
        "steps": [
            {
                "id": "approve_deploy",
                "dependsOn": [],
                "inputBindings": {},
                "kind": "user_gate",
                "interactionKind": "approval",
                "titleTemplate": "Approve {{input.service}} rollout",
                "bodyTemplate": "Target version: {{input.version}}",
                "approvalOptions": [
                    { "id": "ship", "label": "Ship It", "destructive": false, "requireNote": false },
                    { "id": "abort", "label": "Abort", "destructive": true, "requireNote": false }
                ],
                "slaTimeoutSeconds": 600
            },
            {
                "id": "post_notify",
                "dependsOn": ["approve_deploy"],
                "inputBindings": {},
                "kind": "user_gate",
                "interactionKind": "notify",
                "titleTemplate": "Rollout approved",
                "bodyTemplate": "Completed gate for {{input.service}}"
            }
        ],
        "policy": {
            "maxConcurrentAgentSteps": 1,
            "maxAgentCalls": 2,
            "deadlineSeconds": 3600,
            "maxOutputBytes": 16384
        }
    });

    let (status, published) = call_host_command(
        router.clone(),
        "workflow_publish",
        json!({ "request": { "definition": wf_def } }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "workflow_publish failed: {published}"
    );
    let version_id = published["id"].as_str().expect("version id");

    // --- Run 1: Resolve suspended UserGate via REST `POST /api/pulse/interactions/{id}/resolve` ---
    let (status, run1) = call_host_command(
        router.clone(),
        "workflow_start",
        json!({
            "request": {
                "definitionVersionId": version_id,
                "workspaceId": workspace_id,
                "input": { "service": "billing-api", "version": "2026.11.1" }
            }
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "workflow_start run1 failed: {run1}");
    let run1_id = run1["id"].as_str().expect("run1 id");
    assert_eq!(run1["status"], "waiting");

    let (status, deck) = send_json(
        router.clone(),
        Method::GET,
        "/api/pulse/deck",
        Some(TEST_TOKEN),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "GET /api/pulse/deck failed: {deck}");
    let pending = deck["pendingInteractions"]
        .as_array()
        .expect("pendingInteractions array");
    let gate_item = pending
        .iter()
        .find(|item| item["workflowRunId"] == run1_id && item["stepId"] == "approve_deploy")
        .unwrap_or_else(|| panic!("expected pending UserGate interaction in deck: {deck}"));
    assert_eq!(gate_item["title"], "Approve billing-api rollout");
    assert_eq!(gate_item["body"], "Target version: 2026.11.1");
    let interaction_id = gate_item["id"].as_str().expect("interaction id");

    let (status, resolved) = send_json(
        router.clone(),
        Method::POST,
        &format!("/api/pulse/interactions/{interaction_id}/resolve"),
        Some(TEST_TOKEN),
        &[],
        serde_json::to_vec(&json!({
            "selectedOptionId": "ship",
            "note": "Approved via Pulse Inbox"
        }))
        .unwrap(),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "resolve interaction failed: {resolved}"
    );
    assert_eq!(resolved["status"], "resolved");

    let (status, run1_after) =
        call_host_command(router.clone(), "workflow_show", json!({ "runId": run1_id })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        run1_after["status"], "completed",
        "resolving UserGate via Pulse Inbox must resume and complete workflow: {run1_after}"
    );

    // --- Run 2: Resolve suspended UserGate via `workflow_decide` host command ---
    let (status, run2) = call_host_command(
        router.clone(),
        "workflow_start",
        json!({
            "request": {
                "definitionVersionId": version_id,
                "workspaceId": workspace_id,
                "input": { "service": "auth-api", "version": "2026.11.2" }
            }
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let run2_id = run2["id"].as_str().expect("run2 id");
    assert_eq!(run2["status"], "waiting");

    let (status, decided) = call_host_command(
        router.clone(),
        "workflow_decide",
        json!({
            "request": {
                "runId": run2_id,
                "stepId": "approve_deploy",
                "decision": {
                    "approved": true,
                    "optionId": "ship",
                    "note": "Approved via workflow_decide"
                }
            }
        }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "workflow_decide on UserGate step must succeed: {decided}"
    );
    assert_eq!(decided["status"], "completed");

    let (status, deck_after_run2) = send_json(
        router,
        Method::GET,
        "/api/pulse/deck",
        Some(TEST_TOKEN),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        deck_after_run2["pendingInteractions"]
            .as_array()
            .expect("pendingInteractions")
            .iter()
            .all(|i| i["workflowRunId"] != run2_id),
        "workflow_decide must also mark pulse_user_interactions resolved: {deck_after_run2}"
    );
}

#[test]
fn workflow_outbox_action_emits_derived_event_with_incremented_hop_and_delivers_webhook() {
    run_pulse_test(
        workflow_outbox_action_emits_derived_event_with_incremented_hop_and_delivers_webhook_impl(),
    );
}

async fn workflow_outbox_action_emits_derived_event_with_incremented_hop_and_delivers_webhook_impl()
{
    use std::sync::{Arc, Mutex};

    let (_temp, server, _project_id, workspace_id) = setup_server_with_git_workspace().await;
    let router = server.runtime().router();

    // Stand up a local HTTP endpoint to verify real `OutboxActionKind::WebhookPost` delivery.
    let received_webhooks: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let captured = received_webhooks.clone();
    let hook_app = axum::Router::new().route(
        "/hook",
        axum::routing::post(move |axum::Json(payload): axum::Json<Value>| {
            let captured = captured.clone();
            async move {
                captured.lock().unwrap().push(payload);
                StatusCode::OK
            }
        }),
    );
    struct AbortOnDrop(tokio::task::JoinHandle<()>);
    impl Drop for AbortOnDrop {
        fn drop(&mut self) {
            self.0.abort();
        }
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind local webhook receiver");
    let hook_addr = listener.local_addr().expect("local addr");
    let _hook_guard = AbortOnDrop(tokio::spawn(async move {
        let _ = axum::serve(listener, hook_app).await;
    }));

    // Save a downstream rule matching `release.emitted` to verify `EmitEvent` triggers downstream rules.
    let downstream_rule_req = json!({
        "enabled": true,
        "spec": {
            "name": "Downstream Release Listener",
            "evalMode": "auto",
            "filter": {
                "sourceKinds": ["sdk_custom"],
                "eventTypes": ["release.emitted"]
            },
            "targets": [
                {
                    "kind": "user",
                    "interactionKind": "approval",
                    "severity": "warning",
                    "titleTemplate": "Derived event received ({{event.eventType}})",
                    "bodyTemplate": "Thread {{event.threadKey}}",
                    "approvalOptions": [
                        { "id": "ack", "label": "Acknowledge" }
                    ]
                }
            ]
        }
    });
    let (status, saved_rule) = send_json(
        router.clone(),
        Method::POST,
        "/api/pulse/rules",
        Some(TEST_TOKEN),
        &[],
        serde_json::to_vec(&downstream_rule_req).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "save downstream rule: {saved_rule}");

    // Publish & start a workflow with `emit_event` + `webhook_post` outbox actions.
    let wf_def = json!({
        "formatVersion": 1,
        "name": "Outbox Delivery Pipeline",
        "inputSchema": { "type": "object" },
        "steps": [
            {
                "id": "emit_derived",
                "dependsOn": [],
                "inputBindings": {},
                "kind": "outbox_action",
                "actionKind": "emit_event",
                "targetTemplate": "release.emitted",
                "payloadTemplate": {
                    "threadKey": "rel:v4.2",
                    "tag": "v4.2.0"
                }
            },
            {
                "id": "post_webhook",
                "dependsOn": ["emit_derived"],
                "inputBindings": {},
                "kind": "outbox_action",
                "actionKind": "webhook_post",
                "targetTemplate": format!("http://{hook_addr}/hook"),
                "payloadTemplate": {
                    "delivered": true,
                    "tag": "v4.2.0"
                }
            }
        ],
        "policy": {
            "maxConcurrentAgentSteps": 1,
            "maxAgentCalls": 2,
            "deadlineSeconds": 3600,
            "maxOutputBytes": 16384
        }
    });

    let (status, published) = call_host_command(
        router.clone(),
        "workflow_publish",
        json!({ "request": { "definition": wf_def } }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "publish outbox wf: {published}");

    let (status, started) = call_host_command(
        router.clone(),
        "workflow_start",
        json!({
            "request": {
                "definitionVersionId": published["id"],
                "workspaceId": workspace_id,
                "input": { "threadKey": "rel:v4.2" }
            }
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "start outbox wf: {started}");
    let run_id = started["id"].as_str().expect("run id");

    // Wait up to 4s for `workflow_dispatch_task` + `pulse_outbox` worker to complete both steps.
    let mut derived_event: Option<Value> = None;
    for _ in 0..80 {
        let (_, events_resp) = send_json(
            router.clone(),
            Method::GET,
            "/api/pulse/events?limit=20",
            Some(TEST_TOKEN),
            &[],
            Vec::new(),
        )
        .await;
        if let Some(found) = events_resp
            .as_array()
            .and_then(|arr| arr.iter().find(|e| e["eventType"] == "release.emitted"))
            .cloned()
            && !received_webhooks.lock().unwrap().is_empty()
        {
            derived_event = Some(found);
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    let derived = derived_event.expect("OutboxAction emit_event should emit `release.emitted`");
    assert_eq!(
        derived["trace"]["hopCount"], 1,
        "derived outbox event must increment trace.hopCount to 1: {derived}"
    );
    assert_eq!(derived["threadKey"], "rel:v4.2");

    let hooks = received_webhooks.lock().unwrap().clone();
    assert_eq!(hooks.len(), 1, "WebhookPost outbox action must POST once");
    assert_eq!(hooks[0]["tag"], "v4.2.0");

    let (_, shown) =
        call_host_command(router.clone(), "workflow_show", json!({ "runId": run_id })).await;
    assert_eq!(shown["status"], "completed");

    let (_, deck) = send_json(
        router,
        Method::GET,
        "/api/pulse/deck",
        Some(TEST_TOKEN),
        &[],
        Vec::new(),
    )
    .await;
    assert!(
        deck["pendingInteractions"]
            .as_array()
            .expect("pendingInteractions")
            .iter()
            .any(|i| i["title"] == "Derived event received (release.emitted)"),
        "derived outbox event must trigger downstream Pulse rule: {deck}"
    );
}

#[test]
fn session_thread_keyed_reuses_bound_uuid_session_across_events() {
    run_pulse_test(session_thread_keyed_reuses_bound_uuid_session_across_events_impl());
}

async fn session_thread_keyed_reuses_bound_uuid_session_across_events_impl() {
    let (_temp, server, project_id, base_workspace_id) = setup_server_with_git_workspace().await;
    let router = server.runtime().router();

    let rule_req = json!({
        "enabled": true,
        "spec": {
            "name": "PR ThreadKeyed Reviewer",
            "evalMode": "auto",
            "filter": {
                "sourceKinds": ["sdk_custom"],
                "eventTypes": ["pr.comment"]
            },
            "targets": [
                {
                    "kind": "session",
                    "mode": "thread_keyed",
                    "agentId": "pulse-test-agent",
                    "workspaceIsolation": "scratch",
                    "projectId": project_id,
                    "deliveryStrategy": "queue",
                    "subscribeThread": true,
                    "promptTemplate": "Review comment on {{event.threadKey}}: {{event.payload.body}}"
                }
            ]
        }
    });
    let (status, saved_rule) = send_json(
        router.clone(),
        Method::POST,
        "/api/pulse/rules",
        Some(TEST_TOKEN),
        &[],
        serde_json::to_vec(&rule_req).unwrap(),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "save thread_keyed rule: {saved_rule}"
    );

    // Emit Event 1 on thread `pr:777`.
    let (status, _) = send_json(
        router.clone(),
        Method::POST,
        "/api/pulse/events/emit",
        Some(TEST_TOKEN),
        &[],
        serde_json::to_vec(&json!({
            "eventType": "pr.comment",
            "threadKey": "pr:777",
            "payload": { "body": "First review comment" }
        }))
        .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, deck1) = send_json(
        router.clone(),
        Method::GET,
        "/api/pulse/deck",
        Some(TEST_TOKEN),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let subs1: Vec<&Value> = deck1["subscriptions"]
        .as_array()
        .expect("subscriptions")
        .iter()
        .filter(|s| s["threadKey"] == "pr:777" && s["subscriberKind"] == "session")
        .collect();
    assert_eq!(
        subs1.len(),
        1,
        "expected exactly 1 bound session subscription for pr:777, got: {subs1:?}"
    );
    let first_session_id = subs1[0]["subscriberId"]
        .as_str()
        .expect("subscriberId")
        .to_string();
    let first_uuid = uuid::Uuid::parse_str(&first_session_id)
        .expect("subscriberId must be a bound Session UUID, not a `session:...` placeholder");
    let first_session = db::models::session::Session::find_by_id(server.pool(), first_uuid)
        .await
        .expect("query first session")
        .expect("first session exists");
    assert_ne!(
        first_session.workspace_id.to_string(),
        base_workspace_id,
        "PulseWorkspaceIsolation::Scratch must provision a distinct scratch workspace"
    );

    // Emit Event 2 on the SAME thread `pr:777` -> must reuse `first_session_id`!
    let (status, _) = send_json(
        router.clone(),
        Method::POST,
        "/api/pulse/events/emit",
        Some(TEST_TOKEN),
        &[],
        serde_json::to_vec(&json!({
            "eventType": "pr.comment",
            "threadKey": "pr:777",
            "payload": { "body": "Follow-up review comment" }
        }))
        .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, deck2) = send_json(
        router.clone(),
        Method::GET,
        "/api/pulse/deck",
        Some(TEST_TOKEN),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let subs2: Vec<&Value> = deck2["subscriptions"]
        .as_array()
        .expect("subscriptions")
        .iter()
        .filter(|s| s["threadKey"] == "pr:777" && s["subscriberKind"] == "session")
        .collect();
    assert_eq!(subs2.len(), 1);
    assert_eq!(
        subs2[0]["subscriberId"], first_session_id,
        "second event on pr:777 must reuse the exact same bound Session UUID"
    );

    // Emit Event 3 on a DIFFERENT thread `pr:888` -> spawns a distinct Session UUID.
    let (status, _) = send_json(
        router.clone(),
        Method::POST,
        "/api/pulse/events/emit",
        Some(TEST_TOKEN),
        &[],
        serde_json::to_vec(&json!({
            "eventType": "pr.comment",
            "threadKey": "pr:888",
            "payload": { "body": "Separate PR thread" }
        }))
        .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (_, deck3) = send_json(
        router,
        Method::GET,
        "/api/pulse/deck",
        Some(TEST_TOKEN),
        &[],
        Vec::new(),
    )
    .await;
    let sub_888 = deck3["subscriptions"]
        .as_array()
        .expect("subscriptions")
        .iter()
        .find(|s| s["threadKey"] == "pr:888" && s["subscriberKind"] == "session")
        .expect("subscription for pr:888");
    let second_session_id = sub_888["subscriberId"].as_str().expect("subscriberId");
    let second_uuid = uuid::Uuid::parse_str(second_session_id).expect("second session uuid");
    assert_ne!(second_session_id, first_session_id);
    let second_session = db::models::session::Session::find_by_id(server.pool(), second_uuid)
        .await
        .expect("query second session")
        .expect("second session exists");
    assert_ne!(second_session.workspace_id, first_session.workspace_id);
}

#[test]
fn pulse_security_hardening_hmac_sdk_emit_and_full_rest_parity() {
    run_pulse_test(pulse_security_hardening_hmac_sdk_emit_and_full_rest_parity_impl());
}

async fn pulse_security_hardening_hmac_sdk_emit_and_full_rest_parity_impl() {
    let temp = TempDir::new().expect("create tempdir");
    let server = HeadlessServer::bootstrap(
        ServerBootstrapConfig::new(temp.path()).with_token(ServerToken::new(TEST_TOKEN)),
    )
    .await
    .expect("bootstrap HeadlessServer");
    let router = server.runtime().router();

    // 1. Unsigned public webhook source MUST reject with 401 by default unless `allowUnsigned: true`.
    let (status, created_src) = send_json(
        router.clone(),
        Method::POST,
        "/api/pulse/sources",
        Some(TEST_TOKEN),
        &[],
        serde_json::to_vec(&json!({
            "id": "src-unsigned-default",
            "kind": "webhook_standard",
            "title": "Unsigned Webhook",
            "enabled": true
        }))
        .unwrap(),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "POST /api/pulse/sources: {created_src}"
    );

    let (status, _) = send_json(
        router.clone(),
        Method::POST,
        "/api/pulse/webhooks/src-unsigned-default",
        None,
        &[("webhook-id", "msg_u1")],
        br#"{"eventType":"test.unsigned"}"#.to_vec(),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "webhook without signingSecret and without allowUnsigned must return 401"
    );

    // Explicit opt-in `configJson.allowUnsigned = true` allows local dev unsigned delivery.
    let (status, _) = send_json(
        router.clone(),
        Method::POST,
        "/api/pulse/sources",
        Some(TEST_TOKEN),
        &[],
        serde_json::to_vec(&json!({
            "id": "src-unsigned-default",
            "kind": "webhook_standard",
            "title": "Unsigned Dev Webhook",
            "enabled": true,
            "configJson": { "allowUnsigned": true }
        }))
        .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, ok_unsigned) = send_json(
        router.clone(),
        Method::POST,
        "/api/pulse/webhooks/src-unsigned-default",
        None,
        &[("webhook-id", "msg_u2")],
        br#"{"eventType":"test.unsigned.allowed"}"#.to_vec(),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "allowUnsigned webhook: {ok_unsigned}"
    );

    // 2. Dual-auth `POST /api/pulse/events/emit`:
    //    - No auth -> 401
    //    - Standard Webhooks HMAC headers without Bearer -> 200 OK
    //    - Remote caller attempting `trustLevel: trusted_human` -> clamped to `trusted_internal`!
    let (status, _) = send_json(
        router.clone(),
        Method::POST,
        "/api/pulse/events/emit",
        None,
        &[],
        br#"{"eventType":"unauth.attempt"}"#.to_vec(),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let sdk_secret = format!(
        "whsec_{}",
        base64::engine::general_purpose::STANDARD.encode(b"abcdef0123456789abcdef0123456789")
    );
    let (status, _) = send_json(
        router.clone(),
        Method::POST,
        "/api/pulse/sources",
        Some(TEST_TOKEN),
        &[],
        serde_json::to_vec(&json!({
            "id": "sdk-hmac-client",
            "kind": "sdk_custom",
            "title": "HMAC SDK Client",
            "enabled": true,
            "signingSecret": sdk_secret
        }))
        .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let sdk_body = serde_json::to_vec(&json!({
        "eventId": "evt-forged-trust-1",
        "deliveryId": "deliv-forged-trust-1",
        "source": {
            "kind": "sdk_custom",
            "instanceId": "sdk-hmac-client",
            "trustLevel": "trusted_human"
        },
        "eventType": "sdk.hmac.verified",
        "occurredAt": Utc::now().to_rfc3339(),
        "actor": { "id": "ext-agent", "isBot": false, "isSelf": false },
        "trace": { "rootEventId": "evt-forged-trust-1", "hopCount": 0 },
        "payload": { "ok": true }
    }))
    .unwrap();
    let ts = Utc::now().timestamp();
    let ts_str = ts.to_string();
    let sig = sign_standard_webhook(&sdk_secret, "msg_sdk_hmac_1", ts, &sdk_body)
        .expect("sign sdk payload");

    let (status, hmac_emitted) = send_json(
        router.clone(),
        Method::POST,
        "/api/pulse/events/emit",
        None,
        &[
            ("x-pulse-source-id", "sdk-hmac-client"),
            ("webhook-id", "msg_sdk_hmac_1"),
            ("webhook-timestamp", &ts_str),
            ("webhook-signature", &sig),
        ],
        sdk_body,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "HMAC-authenticated SDK emit without Bearer must succeed: {hmac_emitted}"
    );
    assert_ne!(
        hmac_emitted["source"]["trustLevel"], "trusted_human",
        "non-LocalDesktop callers must never forge TrustedHuman trustLevel: {hmac_emitted}"
    );
    assert_eq!(hmac_emitted["source"]["instanceId"], "sdk-hmac-client");
    assert_eq!(hmac_emitted["actor"]["id"], "pulse-sdk:sdk-hmac-client");
    assert_ne!(hmac_emitted["eventId"], "evt-forged-trust-1");

    // Cross-source spoofing & delivery replay protection when body omits deliveryId
    let spoofed_replay_body = serde_json::to_vec(&json!({
        "source": {
            "kind": "sdk_custom",
            "instanceId": "spoofed-other-source",
            "trustLevel": "trusted_human"
        },
        "eventType": "sdk.hmac.replay_check",
        "payload": { "n": 1 }
    }))
    .unwrap();
    let sig_replay = sign_standard_webhook(
        &sdk_secret,
        "msg_sdk_hmac_replay_1",
        ts,
        &spoofed_replay_body,
    )
    .expect("sign replay body");
    let (status, replay_1) = send_json(
        router.clone(),
        Method::POST,
        "/api/pulse/events/emit",
        None,
        &[
            ("x-pulse-source-id", "sdk-hmac-client"),
            ("webhook-id", "msg_sdk_hmac_replay_1"),
            ("webhook-timestamp", &ts_str),
            ("webhook-signature", &sig_replay),
        ],
        spoofed_replay_body.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(replay_1["source"]["instanceId"], "sdk-hmac-client");
    assert_eq!(replay_1["deliveryId"], "msg_sdk_hmac_replay_1");

    let (status, _) = send_json(
        router.clone(),
        Method::POST,
        "/api/pulse/events/emit",
        None,
        &[
            ("x-pulse-source-id", "sdk-hmac-client"),
            ("webhook-id", "msg_sdk_hmac_replay_1"),
            ("webhook-timestamp", &ts_str),
            ("webhook-signature", &sig_replay),
        ],
        spoofed_replay_body,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (deck_st, deck_after_replay) = send_json(
        router.clone(),
        Method::GET,
        "/api/pulse/deck",
        Some(TEST_TOKEN),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(deck_st, StatusCode::OK);
    let replay_matches = deck_after_replay["recentEvents"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter(|e| e["deliveryId"] == "msg_sdk_hmac_replay_1")
                .count()
        })
        .unwrap_or(0);
    assert_eq!(
        replay_matches, 1,
        "replayed HMAC delivery without body deliveryId must be deduplicated by webhook-id"
    );

    // 3. `draftOnly: true` & full `/api/pulse/*` REST parity.
    let (status, draft_rule) = send_json(
        router.clone(),
        Method::POST,
        "/api/pulse/rules",
        Some(TEST_TOKEN),
        &[],
        serde_json::to_vec(&json!({
            "enabled": true,
            "draftOnly": true,
            "spec": {
                "name": "Draft Rule Via REST",
                "evalMode": "auto",
                "filter": { "eventTypes": ["draft.event"] },
                "targets": [{
                    "kind": "user",
                    "interactionKind": "notify",
                    "severity": "info",
                    "titleTemplate": "Draft",
                    "bodyTemplate": "Body"
                }]
            }
        }))
        .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "save draft rule: {draft_rule}");
    assert_eq!(draft_rule["draftOnly"], true);
    assert_eq!(draft_rule["enabled"], false);
    let rule_id = draft_rule["id"].as_str().expect("rule id");

    // GET /api/pulse/rules, POST mode, POST enabled, DELETE rule
    let (status, rules_list) = send_json(
        router.clone(),
        Method::GET,
        "/api/pulse/rules",
        Some(TEST_TOKEN),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        rules_list
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == rule_id)
    );

    let (status, mode_updated) = send_json(
        router.clone(),
        Method::POST,
        &format!("/api/pulse/rules/{rule_id}/mode"),
        Some(TEST_TOKEN),
        &[],
        serde_json::to_vec(&json!({ "evalMode": "observe" })).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(mode_updated["spec"]["evalMode"], "observe");

    let (status, enabled_updated) = send_json(
        router.clone(),
        Method::POST,
        &format!("/api/pulse/rules/{rule_id}/enabled"),
        Some(TEST_TOKEN),
        &[],
        serde_json::to_vec(&json!({ "enabled": true })).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(enabled_updated["enabled"], true);

    let (status, _) = send_json(
        router.clone(),
        Method::DELETE,
        &format!("/api/pulse/rules/{rule_id}"),
        Some(TEST_TOKEN),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Schemas: POST + GET
    let (status, _) = send_json(
        router.clone(),
        Method::POST,
        "/api/pulse/schemas",
        Some(TEST_TOKEN),
        &[],
        serde_json::to_vec(&json!({
            "eventType": "sdk.hmac.verified",
            "version": 1,
            "sourceKind": "sdk_custom",
            "title": "SDK Verified Event",
            "jsonSchema": { "type": "object" }
        }))
        .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, schemas) = send_json(
        router.clone(),
        Method::GET,
        "/api/pulse/schemas",
        Some(TEST_TOKEN),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        schemas
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["eventType"] == "sdk.hmac.verified")
    );

    // Subscriptions: POST + DELETE
    let (status, sub) = send_json(
        router.clone(),
        Method::POST,
        "/api/pulse/subscriptions",
        Some(TEST_TOKEN),
        &[],
        serde_json::to_vec(&json!({
            "threadKey": "issue:101",
            "subscriberKind": "session",
            "subscriberId": uuid::Uuid::new_v4().to_string()
        }))
        .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "POST /subscriptions: {sub}");
    let sub_id = sub["id"].as_str().expect("sub id");

    let (status, _) = send_json(
        router.clone(),
        Method::DELETE,
        &format!("/api/pulse/subscriptions/{sub_id}"),
        Some(TEST_TOKEN),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // DELETE /api/pulse/sources/{id}
    let (status, _) = send_json(
        router,
        Method::DELETE,
        "/api/pulse/sources/src-unsigned-default",
        Some(TEST_TOKEN),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[test]
fn pulse_http_source_test_secret_preservation_poller_and_callbacks() {
    run_pulse_test(pulse_http_source_test_secret_preservation_poller_and_callbacks_impl());
}

async fn authed_post(router: &axum::Router, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    let bytes = body
        .map(|v| serde_json::to_vec(&v).unwrap())
        .unwrap_or_default();
    send_json(
        router.clone(),
        Method::POST,
        uri,
        Some(TEST_TOKEN),
        &[],
        bytes,
    )
    .await
}

async fn pulse_http_source_test_secret_preservation_poller_and_callbacks_impl() {
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    };

    use axum::{
        Json,
        routing::{get, post},
    };

    let gh_phase = Arc::new(AtomicUsize::new(0));
    let feishu_received: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let gh_comments_received: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let (gh_phase_r, fs_ok_r, gh_cmt_r) = (
        gh_phase.clone(),
        feishu_received.clone(),
        gh_comments_received.clone(),
    );

    let mock_app = axum::Router::new()
        .route(
            "/repos/acme/vibex/actions/runs",
            get(move || {
                let phase = gh_phase_r.load(Ordering::SeqCst);
                async move {
                    let (id, conclusion, sha) = if phase == 0 {
                        (9001, "success", "111aaa")
                    } else {
                        (9002, "failure", "222bbb")
                    };
                    Json(json!({ "workflow_runs": [{
                    "id": id, "name": "CI", "head_branch": "main", "head_sha": sha,
                    "status": "completed", "conclusion": conclusion,
                    "html_url": format!("https://github.com/acme/vibex/actions/runs/{id}"),
                    "updated_at": "2026-04-15T10:05:00Z",
                    "repository": { "full_name": "acme/vibex" },
                    "actor": { "login": "octocat", "type": "User" }
                }] }))
                }
            }),
        )
        .route(
            "/feishu-hook-ok",
            post(move |Json(body): Json<Value>| {
                fs_ok_r.lock().unwrap().push(body);
                async { Json(json!({ "code": 0, "msg": "success" })) }
            }),
        )
        .route(
            "/feishu-hook-err",
            post(|| async { Json(json!({ "code": 9499, "msg": "bad sign" })) }),
        )
        .route(
            "/gh-comments",
            post(move |Json(body): Json<Value>| {
                gh_cmt_r.lock().unwrap().push(body);
                async { (StatusCode::CREATED, Json(json!({ "id": 1 }))) }
            }),
        );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock");
    let mock_base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        let _ = axum::serve(listener, mock_app).await;
    });

    let temp = TempDir::new().expect("tempdir");
    std::fs::write(
        temp.path().join("settings.json"),
        serde_json::to_vec(&json!({
            "chat_channels": { "channels": [{
                "id": "fs-bot-1", "kind": "feishu", "enabled": true, "config": { "app_id": "cli_demo" }
            }] }
        })).unwrap(),
    ).expect("write settings.json");

    let server = HeadlessServer::bootstrap(
        ServerBootstrapConfig::new(temp.path())
            .with_token(ServerToken::new(TEST_TOKEN))
            .with_allow_loopback_outbox_for_tests(true),
    )
    .await
    .expect("bootstrap HeadlessServer");
    let router = server.runtime().router();

    // 1. Secret preservation + `hasSigningSecret` + `configJson` + `PulseSourceTest`
    let whsec = format!(
        "whsec_{}",
        base64::engine::general_purpose::STANDARD.encode(b"0123456789abcdef0123456789abcdef")
    );
    let (st, s1) = authed_post(
        &router,
        "/api/pulse/sources",
        Some(json!({
            "id": "src-std-keep", "kind": "webhook_standard", "title": "Std v1",
            "signingSecret": whsec, "configJson": { "env": "prod" }
        })),
    )
    .await;
    assert_eq!(
        (
            st,
            s1["hasSigningSecret"].as_bool(),
            s1["configJson"]["env"].as_str()
        ),
        (StatusCode::OK, Some(true), Some("prod"))
    );

    let (st, s2) = authed_post(&router, "/api/pulse/sources", Some(json!({
        "id": "src-std-keep", "kind": "webhook_standard", "title": "Std v2", "signingSecret": "   "
    }))).await;
    assert_eq!(
        (
            st,
            s2["hasSigningSecret"].as_bool(),
            s2["configJson"]["env"].as_str()
        ),
        (StatusCode::OK, Some(true), Some("prod"))
    );

    let (st, test_ok) = authed_post(&router, "/api/pulse/sources/src-std-keep/test", None).await;
    assert_eq!((st, test_ok["ok"].as_bool()), (StatusCode::OK, Some(true)));
    assert!(test_ok["sampleEnvelope"]["eventId"].is_string());

    let (_, s3) = authed_post(&router, "/api/pulse/sources", Some(json!({
        "id": "src-std-keep", "kind": "webhook_standard", "title": "Std v3", "clearSigningSecret": true
    }))).await;
    assert_eq!(s3["hasSigningSecret"], false);
    let (st, test_fail) = authed_post(&router, "/api/pulse/sources/src-std-keep/test", None).await;
    assert_eq!(
        (st, test_fail["ok"].as_bool()),
        (StatusCode::OK, Some(false))
    );

    // 2. Feishu long_connection test + real inbound bridge into PulseEngine
    authed_post(
        &router,
        "/api/pulse/sources",
        Some(json!({
            "id": "src-fs-ws", "kind": "feishu", "title": "Feishu Bot WS",
            "configJson": { "mode": "long_connection", "channelId": "fs-bot-1" }
        })),
    )
    .await;
    let (st, fs_test) = call_host_command(
        router.clone(),
        "pulse_source_test",
        json!({ "id": "src-fs-ws" }),
    )
    .await;
    assert_eq!(
        (st, fs_test["ok"].as_bool(), fs_test["mode"].as_str()),
        (StatusCode::OK, Some(true), Some("long_connection"))
    );

    authed_post(&router, "/api/pulse/rules", Some(json!({
        "id": "rule-fs-bridge", "enabled": true,
        "spec": {
            "name": "Feishu Bridge", "evalMode": "auto", "orchestrator": "direct_reflex",
            "filter": { "sourceKinds": ["feishu"], "sourceInstanceIds": ["src-fs-ws"], "eventTypes": ["feishu.im.message"] },
            "targets": [],
            "callback": { "kind": "feishu_webhook", "destination": format!("{mock_base}/feishu-hook-ok"), "payloadTemplate": "Echo: {{payload.text}}" },
            "taskMeta": { "taskKind": "fast_task", "lifecycleState": "published" }
        }
    }))).await;
    let bridged = server::bridge_feishu_inbound_to_pulse(server.pool().clone(), "fs-bot-1".to_string(), json!({}), json!({
        "header": { "event_id": "ev_live_1", "event_type": "im.message.receive_v1" },
        "event": {
            "sender": { "sender_type": "user", "sender_id": { "open_id": "ou_bob" } },
            "message": { "message_id": "om_live_1", "chat_id": "oc_1", "message_type": "text", "content": "{\"text\":\"deploy prod\"}" }
        }
    })).await;
    assert_eq!(bridged, 1);

    // 3. GitHub poll test + background poller + FastTask callbacks (Feishu ok/err + GitHub comment)
    authed_post(&router, "/api/pulse/sources", Some(json!({
        "id": "src-gh-poll", "kind": "github", "title": "GitHub Poller",
        "configJson": { "mode": "poll", "repo": "acme/vibex", "apiBaseUrl": mock_base, "githubToken": "ghp_mock", "pollIntervalSecs": 15 }
    }))).await;
    let (st, gh_test) = authed_post(&router, "/api/pulse/sources/src-gh-poll/test", None).await;
    assert_eq!(
        (
            st,
            gh_test["ok"].as_bool(),
            gh_test["sampleEnvelope"]["eventType"].as_str()
        ),
        (
            StatusCode::OK,
            Some(true),
            Some("github.workflow_run.completed")
        )
    );

    for (rid, rname, kind, dest) in [
        (
            "rule-fs-ok",
            "CI Alert",
            "feishu_webhook",
            format!("{mock_base}/feishu-hook-ok"),
        ),
        (
            "rule-fs-err",
            "Broken Hook",
            "feishu_webhook",
            format!("{mock_base}/feishu-hook-err"),
        ),
        (
            "rule-gh-cmt",
            "PR Commenter",
            "github_comment",
            format!("{mock_base}/gh-comments"),
        ),
    ] {
        let (st, r) = authed_post(&router, "/api/pulse/rules", Some(json!({
            "id": rid, "enabled": true,
            "spec": {
                "name": rname, "evalMode": "auto", "orchestrator": "direct_reflex",
                "filter": { "sourceKinds": ["github"], "sourceInstanceIds": ["src-gh-poll"], "eventTypes": ["github.workflow_run.completed"] },
                "targets": [],
                "callback": { "kind": kind, "destination": dest, "payloadTemplate": "[{{rule.name}}] {{payload.name}}={{payload.conclusion}} on {{payload.head_branch}}" },
                "taskMeta": { "taskKind": "fast_task", "lifecycleState": "published" }
            }
        }))).await;
        assert_eq!(st, StatusCode::OK, "save callback rule {rid}: {r}");
    }

    gh_phase.store(1, Ordering::SeqCst);
    assert!(server::trigger_pulse_poll_for_source("src-gh-poll").await);

    let fs_payloads = feishu_received.lock().unwrap().clone();
    assert_eq!(fs_payloads.len(), 2);
    assert_eq!(fs_payloads[0]["content"]["text"], "Echo: deploy prod");
    assert_eq!(
        (
            fs_payloads[1]["msg_type"].as_str(),
            fs_payloads[1]["content"]["text"].as_str()
        ),
        (Some("text"), Some("[CI Alert] CI=failure on main"))
    );
    let gh_payloads = gh_comments_received.lock().unwrap().clone();
    assert_eq!(gh_payloads[0]["body"], "[PR Commenter] CI=failure on main");

    let (st, deck) = send_json(
        router,
        Method::GET,
        "/api/pulse/deck",
        Some(TEST_TOKEN),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let outbox = deck["recentOutbox"].as_array().expect("recentOutbox");
    assert!(
        outbox
            .iter()
            .any(|o| o["ruleId"] == "rule-fs-ok" && o["status"] == "delivered")
    );
    assert!(outbox.iter().any(|o| o["ruleId"] == "rule-fs-err"
        && o["status"] == "pending"
        && o["attempts"] == 1
        && o["lastError"].as_str().unwrap_or("").contains("bad sign")));
    let rules = deck["rules"].as_array().expect("rules");
    assert_eq!(
        rules.iter().find(|r| r["id"] == "rule-fs-ok").unwrap()["spec"]["taskMeta"]["lastRunStatus"],
        "succeeded"
    );
    assert_eq!(
        rules.iter().find(|r| r["id"] == "rule-fs-err").unwrap()["spec"]["taskMeta"]["lastRunStatus"],
        "failed"
    );
}
