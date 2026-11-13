use std::io::{Cursor, Write};

use axum::{
    Json, Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
    routing::get,
};
use plugins::package_content_digest;
use serde_json::{Value, json};
use server::{HeadlessServer, ServerBootstrapConfig, ServerToken};
use sha2::{Digest, Sha256};
use tower::ServiceExt;
use zip::{ZipWriter, write::SimpleFileOptions};

const TOKEN: &str = "plugin-update-test-only-token-at-least-32-bytes";
fn files(version: &str) -> Vec<(&'static str, String)> {
    vec![
        (".vibex-plugin/plugin.json", json!({"manifestVersion":4,"apiVersion":"2.0","id":"acme.notes","publisher":"acme","name":"Notes","version":version,"readme":"README.md","content":{"root":"contents","index":".vibex-plugin/content.index.json"},"config":{"schema":{"type":"object","properties":{"preview":{"type":"boolean"}},"additionalProperties":false}},"engines":{"vibex":">=0.1.3 <1.0.0","pluginSdk":"^2.0.0"},"integrations":[]}).to_string()),
        ("README.md", "---\nsummary: Work with notes.\n---\n# Notes\n".into()),
        (".vibex-plugin/content.index.json", "{\"schemaVersion\":1,\"items\":[]}".into()),
        ("config.json", "{\"preview\":true}".into()),
    ]
}

fn write_package(root: &std::path::Path, version: &str) {
    for (name, content) in files(version) {
        let file = root.join(name);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, content).unwrap();
    }
}

async fn fixture() -> (String, String, tokio::task::JoinHandle<()>) {
    let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, content) in files("2.0.0") {
        archive
            .start_file(name, SimpleFileOptions::default())
            .unwrap();
        archive.write_all(content.as_bytes()).unwrap();
    }
    let bytes = archive.finish().unwrap().into_inner();
    let sha = format!("{:x}", Sha256::digest(&bytes));
    let root = tempfile::tempdir().unwrap();
    write_package(root.path(), "2.0.0");
    let digest = package_content_digest(root.path()).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let url = format!("{origin}/notes.vxp");
    let release = json!([
        {"tag_name":"v99.0.0","draft":true,"assets":[]},
        {"tag_name":"v3.0.0-beta.1","prerelease":true,"assets":[]},
        {"tag_name":"v2.0.0","draft":false,"prerelease":false,"body":"Notes fixes","assets":[{"name":"notes.vxp","browser_download_url":url,"digest":format!("sha256:{sha}")}]}]);
    let versions = json!([{"tag":"v2.0.0","version":"2.0.0","packageDigest":digest}]);
    let artifact = json!({"tag":"v2.0.0","version":"2.0.0","packageDigest":digest,"downloadUrl":"/notes.vxp","sha256":sha,"releaseNotes":"Notes fixes"});
    let app = Router::new()
        .route(
            "/repos/acme/notes/releases",
            get(move || {
                let data = release.clone();
                async move { Json(data) }
            }),
        )
        .route(
            "/api/marketplace/v1/listing/acme/notes/versions",
            get(move || {
                let data = versions.clone();
                async move { Json(data) }
            }),
        )
        .route(
            "/api/marketplace/v1/artifact/acme/notes",
            get(move || {
                let data = artifact.clone();
                async move { Json(data) }
            }),
        )
        .route(
            "/notes.vxp",
            get(move || {
                let data = bytes.clone();
                async move { data }
            }),
        );
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (origin, digest, task)
}

async fn call(app: Router, command: &str, args: Value) -> (StatusCode, Value) {
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/call/{command}"))
                .header("authorization", format!("Bearer {TOKEN}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"operation_id":uuid::Uuid::new_v4(),"args":args}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    (status, body.get("data").cloned().unwrap_or(body))
}

#[test]
fn host_confirms_exact_updates_preserves_disabled_config_and_deletes_updated_package() {
    // Debug Host bootstrap exceeds the default Windows test-thread stack.
    std::thread::Builder::new()
        .stack_size(16 * 1024 * 1024)
        .spawn(|| {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(host_update_journey());
        })
        .unwrap()
        .join()
        .unwrap();
}

async fn host_update_journey() {
    let (origin, _, task) = fixture().await;
    let data = tempfile::tempdir().unwrap();
    let package = tempfile::tempdir().unwrap();
    write_package(package.path(), "1.0.0");
    let server = HeadlessServer::bootstrap(
        ServerBootstrapConfig::new(data.path()).with_token(ServerToken::new(TOKEN)),
    )
    .await
    .unwrap();
    let app = server.runtime().router();
    let (status, _) = call(app.clone(), "plugin_control_import", json!({"path":package.path(),"origin":format!("{origin}/marketplace/acme/notes"),"gitRef":"v1.0.0","locked":true})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        call(
            app.clone(),
            "plugin_control_set_enabled",
            json!({"pluginId":"acme.notes","enabled":false})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            app.clone(),
            "plugin_save_config",
            json!({"pluginId":"acme.notes","config":{"preview":false}})
        )
        .await
        .0,
        StatusCode::OK
    );
    let (status, checks) = call(app.clone(), "plugin_check_updates", json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        checks
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["pluginId"] == "acme.notes" && item["updateAvailable"] == true)
    );
    let (status, preview) = call(
        app.clone(),
        "plugin_control_update",
        json!({"pluginId":"acme.notes"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["targetVersion"], "2.0.0");
    let (status, catalog) = call(app.clone(), "plugin_control_catalog", json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        catalog["plugins"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == "acme.notes" && item["version"] == "1.0.0")
    );
    // A user edit after preview invalidates the exact confirmation.
    call(
        app.clone(),
        "plugin_save_config",
        json!({"pluginId":"acme.notes","config":{"preview":true}}),
    )
    .await;
    let (status, _) = call(
        app.clone(),
        "plugin_control_update",
        json!({"pluginId":"acme.notes","confirmationId":preview["confirmationId"]}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, preview) = call(
        app.clone(),
        "plugin_control_update",
        json!({"pluginId":"acme.notes"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    let (status, updated) = call(
        app.clone(),
        "plugin_control_update",
        json!({"pluginId":"acme.notes","confirmationId":preview["confirmationId"]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["version"], "2.0.0");
    assert_eq!(updated["enabled"], false);
    assert_eq!(updated["sourceLock"]["sourceKind"], "marketplace");
    let (_, detail) = call(
        app.clone(),
        "plugin_product_detail",
        json!({"pluginId":"acme.notes"}),
    )
    .await;
    assert_eq!(detail["config"], json!({"preview":true}));
    // The confirmation cannot be replayed.
    assert_eq!(
        call(
            app.clone(),
            "plugin_control_update",
            json!({"pluginId":"acme.notes","confirmationId":preview["confirmationId"]})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    fn package_configs(path: &std::path::Path) -> usize {
        std::fs::read_dir(path)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| {
                let path = entry.path();
                if path.is_dir() {
                    package_configs(&path)
                } else {
                    usize::from(path.file_name().is_some_and(|name| name == "config.json"))
                }
            })
            .sum()
    }
    assert!(package_configs(&data.path().join("plugins")) >= 2);
    let (status, result) = call(
        app,
        "plugin_control_uninstall",
        json!({"pluginId":"acme.notes","retainData":false}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(
        package_configs(&data.path().join("plugins")),
        0,
        "delete-data removes retained versions too"
    );
    task.abort();
}
