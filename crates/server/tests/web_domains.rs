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
        "freshly imported plugins stay disabled until the user enables them"
    );

    let product_plugins = call(app.clone(), "plugin_control_catalog", serde_json::json!({})).await;
    assert_eq!(product_plugins["plugins"][0]["id"], "vibex.office");
    assert_eq!(
        product_plugins["plugins"][0]["description"],
        "在 VibeX 中创建、编辑、分析和预览 DOCX、XLSX 与 PPTX 文件。"
    );
    assert_eq!(
        product_plugins["plugins"][0]["formats"],
        serde_json::json!(["vibex"])
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
        serde_json::json!({ "pluginId": "vibex.office" }),
    )
    .await;
    assert_eq!(detail["contents"].as_array().expect("contents").len(), 9);
    assert!(
        detail["readme"]
            .as_str()
            .expect("README")
            .starts_with("# VibeX Office")
    );
    assert_eq!(detail["config"]["idleTimeoutMinutes"], 10);

    let saved = call(
        app.clone(),
        "plugin_save_config",
        serde_json::json!({
            "pluginId": "vibex.office",
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
            "pluginId": "vibex.office",
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
        serde_json::json!({ "pluginId": "vibex.office", "runtimeId": "missing" }),
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
    assert_eq!(projects, serde_json::json!([]));

    let agents = call(app.clone(), "agent_management_bar", serde_json::json!({})).await;
    assert!(agents.is_array() || agents.is_object());

    let missing_file = call_status(
        app,
        "read_file_content",
        serde_json::json!({ "path": "/definitely/missing/file.rs" }),
    )
    .await;
    assert_eq!(missing_file, StatusCode::NOT_FOUND);
}
