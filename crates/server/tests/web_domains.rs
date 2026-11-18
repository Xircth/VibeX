use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use remote_protocol::{CommandResponse, OperationId};
use server::{HeadlessServer, ServerBootstrapConfig, ServerToken};
use tempfile::TempDir;
use tower::ServiceExt;

const TOKEN: &str = "web-domain-test-token-with-at-least-32-bytes";

async fn call(app: Router, command: &str, args: serde_json::Value) -> serde_json::Value {
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/call/{command}"))
                .header("authorization", format!("Bearer {TOKEN}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "operation_id": OperationId::new(),
                        "args": args,
                    })
                    .to_string(),
                ))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    serde_json::from_slice::<CommandResponse<serde_json::Value>>(
        &to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body"),
    )
    .expect("command envelope")
    .data
}

async fn call_status(app: Router, command: &str, args: serde_json::Value) -> StatusCode {
    app.oneshot(
        Request::builder()
            .method("POST")
            .uri(format!("/api/v1/call/{command}"))
            .header("authorization", format!("Bearer {TOKEN}"))
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::json!({
                    "operation_id": OperationId::new(),
                    "args": args,
                })
                .to_string(),
            ))
            .expect("request"),
    )
    .await
    .expect("response")
    .status()
}

#[tokio::test]
async fn one_authenticated_application_surface_opens_product_domains_for_the_web_ui() {
    let data_dir = TempDir::new().expect("data dir");
    let server = HeadlessServer::bootstrap(
        ServerBootstrapConfig::new(data_dir.path()).with_token(ServerToken::new(TOKEN)),
    )
    .await
    .expect("headless server");
    let app = server.runtime().router();

    let plugin = call(app.clone(), "plugin_action_catalog", serde_json::json!({})).await;
    assert_eq!(
        plugin["actions"],
        serde_json::json!([]),
        "official plugins stay out of the catalog until the user installs them"
    );

    let installed = call(
        app.clone(),
        "plugin_marketplace_install",
        serde_json::json!({
            "owner": "dimo",
            "pluginName": "office",
        }),
    )
    .await;
    assert_eq!(installed["id"], "dimo.office");

    let product_plugins = call(app.clone(), "plugin_control_catalog", serde_json::json!({})).await;
    assert_eq!(product_plugins["plugins"][0]["id"], "dimo.office");
    assert_eq!(
        product_plugins["plugins"][0]["description"],
        "在 Dimo 中创建、编辑、分析和预览 DOCX、XLSX 与 PPTX 文件。"
    );
    assert_eq!(
        product_plugins["plugins"][0]["formats"],
        serde_json::json!(["dimo"])
    );
    assert_eq!(
        product_plugins["plugins"][0]["appContributions"][0]["kind"], "file_opener",
        "declared application extensions remain visible while disabled"
    );
    assert_eq!(
        product_plugins["plugins"][0]["appContributions"][1]["kind"],
        "preview_provider"
    );

    let detail = call(
        app.clone(),
        "plugin_product_detail",
        serde_json::json!({ "pluginId": "dimo.office" }),
    )
    .await;
    let contents = detail["contents"].as_array().expect("contents");
    assert_eq!(
        contents
            .iter()
            .filter(|item| item["kind"] == "skill")
            .count(),
        10,
        "Office skills come from the locked officecli load_skill set"
    );
    assert!(
        contents
            .iter()
            .any(|item| item["kind"] == "file_opener" && item["title"] == "Office Preview")
    );
    assert!(
        detail["readme"]
            .as_str()
            .expect("README")
            .trim_start()
            .starts_with("# Dimo Office")
    );
    assert_eq!(detail["config"]["idleTimeoutMinutes"], 10);

    let saved = call(
        app.clone(),
        "plugin_save_config",
        serde_json::json!({
            "pluginId": "dimo.office",
            "config": { "idleTimeoutMinutes": 12 }
        }),
    )
    .await;
    assert_eq!(saved["config"]["idleTimeoutMinutes"], 12);

    let contributions = call(
        app.clone(),
        "plugin_contribution_catalog",
        serde_json::json!({}),
    )
    .await;
    assert_eq!(contributions["generation"], 0);
    assert_eq!(contributions["items"], serde_json::json!([]));

    let grants = call(
        app.clone(),
        "plugin_control_grant_permissions",
        serde_json::json!({
            "pluginId": "dimo.office",
            "permissionIds": ["preview-opened-office-file"]
        }),
    )
    .await;
    assert_eq!(
        grants,
        serde_json::json!([]),
        "Full Trust plugins do not require capability grants"
    );

    let missing_runtime = call_status(
        app.clone(),
        "plugin_control_install_runtime",
        serde_json::json!({ "pluginId": "dimo.office", "runtimeId": "missing" }),
    )
    .await;
    assert_eq!(missing_runtime, StatusCode::NOT_FOUND);

    let failed_preview = call_status(
        app.clone(),
        "plugin_open_file_preview",
        serde_json::json!({ "filePath": "/definitely/missing/spec.docx" }),
    )
    .await;
    assert_eq!(failed_preview, StatusCode::NOT_FOUND);

    let artifacts = call(
        app.clone(),
        "artifact_list",
        serde_json::json!({ "limit": 20 }),
    )
    .await;
    assert_eq!(artifacts, serde_json::json!([]));

    let engine_status = call(
        app.clone(),
        "automation_engine_status",
        serde_json::json!({}),
    )
    .await;
    assert_eq!(engine_status, serde_json::json!({ "active": true }));

    let templates = call(app, "automation_templates", serde_json::json!({})).await;
    assert_eq!(templates.as_array().expect("templates").len(), 7);
}

#[tokio::test]
async fn host_coding_loop_commands_are_registered_on_the_authenticated_surface() {
    let data_dir = TempDir::new().expect("data dir");
    let server = HeadlessServer::bootstrap(
        ServerBootstrapConfig::new(data_dir.path()).with_token(ServerToken::new(TOKEN)),
    )
    .await
    .expect("headless server");
    let app = server.runtime().router();

    let projects = call(app.clone(), "get_projects", serde_json::json!({})).await;
    let list = projects.as_array().expect("projects");
    assert!(
        list.iter()
            .any(|project| project["name"] == "Global" && project["is_git"] == false),
        "headless host seeds the Global home folder, got {projects}"
    );

    let agents = call(app.clone(), "agent_management_bar", serde_json::json!({})).await;
    assert!(agents.is_array() || agents.is_object());

    let missing_path = data_dir.path().join("definitely-missing-file.rs");
    let missing_file = call_status(
        app,
        "read_file_content",
        serde_json::json!({ "path": missing_path }),
    )
    .await;
    assert_eq!(missing_file, StatusCode::NOT_FOUND);
}

async fn pair_device_token(
    app: Router,
    preset: remote_protocol::DevicePermissionPreset,
    device_name: &str,
    client_kind: &str,
) -> String {
    let create = app
        .clone()
        .oneshot(
            Request::post("/api/v1/auth/pairings")
                .header("authorization", format!("Bearer {TOKEN}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&remote_protocol::CreatePairingRequest {
                        preset: Some(preset),
                        requested_scopes: Vec::new(),
                        ttl_seconds: None,
                    })
                    .expect("serialize"),
                ))
                .expect("request"),
        )
        .await
        .expect("pairing response");
    assert_eq!(create.status(), StatusCode::CREATED);
    let challenge: remote_protocol::PairingChallenge = serde_json::from_slice(
        &to_bytes(create.into_body(), usize::MAX)
            .await
            .expect("body"),
    )
    .expect("challenge");
    let redeem = app
        .oneshot(
            Request::post("/api/v1/auth/pairings/redeem")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&remote_protocol::RedeemPairingRequest {
                        pairing_token: challenge.pairing_token,
                        device_name: device_name.to_owned(),
                        public_key_ed25519: None,
                        client_kind: Some(client_kind.to_owned()),
                        replace_existing_mobile: false,
                    })
                    .expect("serialize"),
                ))
                .expect("request"),
        )
        .await
        .expect("redeem response");
    assert_eq!(redeem.status(), StatusCode::CREATED);
    let credential: remote_protocol::DeviceCredential = serde_json::from_slice(
        &to_bytes(redeem.into_body(), usize::MAX)
            .await
            .expect("body"),
    )
    .expect("credential");
    credential.access_token
}

async fn call_status_with_token(
    app: Router,
    token: &str,
    command: &str,
    args: serde_json::Value,
) -> StatusCode {
    app.oneshot(
        Request::post(format!("/api/v1/call/{command}"))
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::json!({
                    "operation_id": OperationId::new(),
                    "args": args,
                })
                .to_string(),
            ))
            .expect("request"),
    )
    .await
    .expect("response")
    .status()
}

#[tokio::test]
async fn remote_principals_cannot_escalate_via_plugin_host_call_or_conversation_export_path() {
    let data_dir = TempDir::new().expect("data dir");
    let server = HeadlessServer::bootstrap(
        ServerBootstrapConfig::new(data_dir.path()).with_token(ServerToken::new(TOKEN)),
    )
    .await
    .expect("headless server");
    let app = server.runtime().router();

    let workstation_token = pair_device_token(
        app.clone(),
        remote_protocol::DevicePermissionPreset::Workstation,
        "Remote Laptop",
        "desktop",
    )
    .await;
    let companion_token = pair_device_token(
        app.clone(),
        remote_protocol::DevicePermissionPreset::Companion,
        "Mobile Phone",
        "mobile",
    )
    .await;

    // 1. Remote Workstation must be forbidden from invoking privileged capabilities via plugin_host_call.
    for (cap, op) in [
        ("exec", "run"),
        ("files", "write"),
        ("secrets", "get"),
        ("network", "fetch"),
        ("env", "read"),
        ("runtime.execute", "run"),
        ("plugin.self", "quarantine"),
    ] {
        let status = call_status_with_token(
            app.clone(),
            &workstation_token,
            "plugin_host_call",
            serde_json::json!({
                "pluginId": "nonexistent.plugin",
                "capability": cap,
                "operation": op,
                "input": {},
            }),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::FORBIDDEN,
            "remote workstation must be forbidden from {cap}.{op}"
        );
    }

    // 2. Even local host cannot invoke plugin_host_call for an uninstalled pluginId.
    let uninstalled = call_status(
        app.clone(),
        "plugin_host_call",
        serde_json::json!({
            "pluginId": "does.not.exist",
            "capability": "storage",
            "operation": "settings.get",
            "input": {},
        }),
    )
    .await;
    assert_eq!(uninstalled, StatusCode::NOT_FOUND);

    // 3. Companion remote cannot pass destinationPath to conversation_export.
    let export_target = data_dir.path().join("escaped-export.json");
    let export_status = call_status_with_token(
        app,
        &companion_token,
        "conversation_export",
        serde_json::json!({
            "conversationId": uuid::Uuid::new_v4().to_string(),
            "destinationPath": export_target,
        }),
    )
    .await;
    assert_eq!(export_status, StatusCode::FORBIDDEN);
    assert!(!export_target.exists());
}

#[tokio::test]
async fn file_mutations_and_workflow_sources_are_confined_to_sandbox_roots() {
    let data_dir = TempDir::new().expect("data dir");
    let outside_dir = TempDir::new().expect("outside dir");
    let repo_dir = TempDir::new().expect("repo dir");
    let server = HeadlessServer::bootstrap(
        ServerBootstrapConfig::new(data_dir.path()).with_token(ServerToken::new(TOKEN)),
    )
    .await
    .expect("headless server");
    let app = server.runtime().router();

    let outside_file = outside_dir.path().join("pwn.txt");
    let outside_subdir = outside_dir.path().join("mkdir-pwn");
    let outside_wf = outside_dir.path().join("evil.dimo-workflow.json");
    std::fs::write(&outside_wf, "{\"id\":\"x\",\"name\":\"x\",\"steps\":[]}").expect("seed");

    assert_eq!(
        call_status(
            app.clone(),
            "save_file_content",
            serde_json::json!({ "path": outside_file, "content": "pwn" }),
        )
        .await,
        StatusCode::FORBIDDEN
    );
    assert!(!outside_file.exists());

    assert_eq!(
        call_status(
            app.clone(),
            "create_directory",
            serde_json::json!({ "path": outside_subdir }),
        )
        .await,
        StatusCode::FORBIDDEN
    );
    assert!(!outside_subdir.exists());

    assert_eq!(
        call_status(
            app.clone(),
            "write_pasted_image_asset",
            serde_json::json!({
                "directory": outside_dir.path(),
                "base64Content": "AAAA",
                "extension": "png",
            }),
        )
        .await,
        StatusCode::FORBIDDEN
    );

    assert_eq!(
        call_status(
            app.clone(),
            "workflow_source_read",
            serde_json::json!({ "path": outside_wf }),
        )
        .await,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call_status(
            app.clone(),
            "workflow_source_write",
            serde_json::json!({
                "path": "~/.ssh/pwn.dimo-workflow.json",
                "content": "{\"id\":\"x\",\"name\":\"x\",\"steps\":[]}",
            }),
        )
        .await,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call_status(
            app.clone(),
            "workflow_source_write",
            serde_json::json!({
                "path": "~/.dimo/workflows/../../pwn.dimo-workflow.json",
                "content": "{\"id\":\"x\",\"name\":\"x\",\"steps\":[]}",
            }),
        )
        .await,
        StatusCode::BAD_REQUEST
    );

    // Register a workspace repository, then verify authorized mutations inside it succeed
    // while moving out of it is still rejected.
    let git_init = std::process::Command::new("git")
        .args(["init"])
        .current_dir(repo_dir.path())
        .output()
        .expect("git init");
    assert!(git_init.status.success(), "git init failed");
    let reg_status = call_status(
        app.clone(),
        "register_repo",
        serde_json::json!({ "path": repo_dir.path() }),
    )
    .await;
    assert_eq!(reg_status, StatusCode::OK);

    let inside_dir = repo_dir.path().join("docs");
    assert_eq!(
        call_status(
            app.clone(),
            "create_directory",
            serde_json::json!({ "path": inside_dir }),
        )
        .await,
        StatusCode::OK
    );

    let inside_file = inside_dir.join("note.md");
    assert_eq!(
        call_status(
            app.clone(),
            "save_file_content",
            serde_json::json!({ "path": inside_file, "content": "# ok\n" }),
        )
        .await,
        StatusCode::OK
    );

    assert_eq!(
        call_status(
            app.clone(),
            "write_pasted_image_asset",
            serde_json::json!({
                "directory": inside_dir,
                "base64Content": "AAAA",
                "extension": "png",
            }),
        )
        .await,
        StatusCode::OK
    );

    assert_eq!(
        call_status(
            app.clone(),
            "move_item",
            serde_json::json!({
                "path": inside_file,
                "newPath": outside_file,
            }),
        )
        .await,
        StatusCode::FORBIDDEN
    );
    assert!(!outside_file.exists());
}
