use std::{
    io::{Cursor, Write},
    sync::Arc,
};

use axum::{Json, Router, routing::get};
use plugins::{
    ConflictDecision, InMemoryPluginRegistry, PluginActivation, PluginControlPlane, PluginPackage,
    PluginSourceKind, PluginSourceLock, PluginUpdateResolver, PluginUpdateStatus,
    package_content_digest, validate_update_package,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use zip::{ZipWriter, write::SimpleFileOptions};

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

#[tokio::test]
async fn marketplace_and_github_upgrade_verified_archives_without_losing_state() {
    let (origin, expected_digest, task) = fixture().await;
    for kind in ["marketplace", "github"] {
        let old_root = tempfile::tempdir().unwrap();
        let staging = tempfile::tempdir().unwrap();
        write_package(old_root.path(), "1.0.0");
        let mut old = PluginPackage::inspect(old_root.path(), PluginSourceKind::Snapshot).unwrap();
        old.write_config(json!({"preview":false})).unwrap();
        old.source.origin = Some(if kind == "github" {
            "https://github.com/acme/notes".into()
        } else {
            format!("{origin}/marketplace/acme/notes")
        });
        old.source.git_ref = Some("v1.0.0".into());
        old.source.locked = true;
        let control = PluginControlPlane::new(Arc::new(InMemoryPluginRegistry::default()));
        control
            .import(old.clone(), ConflictDecision::Reject)
            .await
            .unwrap();
        control
            .kv_put("acme.notes", "saved", &json!("user data"))
            .await
            .unwrap();
        let installed = control.plugin("acme.notes").await.unwrap().unwrap();
        let lock = installed.source.update_lock.clone().unwrap();
        assert_eq!(lock.source_kind, kind);
        let resolver = PluginUpdateResolver::with_github_api(&origin).unwrap();
        let candidate = resolver.resolve(&lock, None).await.unwrap().unwrap();
        assert_eq!(candidate.source.tag, "v2.0.0");
        let archive = resolver.download(&candidate, staging.path()).await.unwrap();
        let mut next =
            PluginPackage::materialize_candidate(&archive, staging.path(), &installed.package)
                .unwrap();
        validate_update_package(&next, &candidate).unwrap();
        assert_eq!(
            package_content_digest(&next.source.path).unwrap(),
            expected_digest
        );
        assert_eq!(
            next.product_detail().unwrap().config,
            json!({"preview":false})
        );
        assert_eq!(
            control.plugin("acme.notes").await.unwrap().unwrap().version,
            "1.0.0",
            "preparation cannot publish"
        );
        let mut bad_checksum = candidate.clone();
        bad_checksum.sha256 = Some("00".repeat(32));
        assert!(
            resolver
                .download(&bad_checksum, staging.path())
                .await
                .is_err()
        );
        assert_eq!(
            PluginPackage::inspect(&old.source.path, old.source.kind)
                .unwrap()
                .version,
            "1.0.0"
        );
        next.source.origin = Some(candidate.source.origin.clone());
        next.source.git_ref = Some(candidate.source.tag.clone());
        control
            .import(next, ConflictDecision::Replace)
            .await
            .unwrap();
        let current = control.plugin("acme.notes").await.unwrap().unwrap();
        assert_eq!(current.version, "2.0.0");
        assert_eq!(current.activation, PluginActivation::Disabled);
        assert_eq!(
            current.source.update_lock.as_ref().unwrap().source_kind,
            kind
        );
        assert_eq!(
            control.kv_get("acme.notes", "saved").await.unwrap(),
            Some(json!("user data"))
        );
    }
    task.abort();
}

#[tokio::test]
async fn failed_observation_keeps_previous_available_update_and_timestamp() {
    let (origin, _, task) = fixture().await;
    let source = PluginSourceLock {
        source_kind: "github".into(),
        origin: "https://github.com/acme/notes".into(),
        owner: "acme".into(),
        plugin_name: "notes".into(),
        tag: "v1.0.0".into(),
        version: "1.0.0".into(),
        package_digest: "old".into(),
    };
    let resolver = PluginUpdateResolver::with_github_api(&origin).unwrap();
    let candidate = resolver.resolve(&source, None).await.unwrap().unwrap();
    let previous = PluginUpdateStatus {
        plugin_id: "acme.notes".into(),
        update_available: true,
        status: "available".into(),
        checked_at: 10,
        last_successful_at: Some(10),
        available_tag: Some("v2.0.0".into()),
        available_version: Some("2.0.0".into()),
        error: None,
        candidate: Some(candidate),
    };
    task.abort();
    assert!(resolver.resolve(&source, None).await.is_err());
    let failed = PluginUpdateStatus::failed("acme.notes".into(), "offline".into(), Some(&previous));
    assert!(failed.update_available);
    assert_eq!(failed.status, "failed");
    assert_eq!(failed.last_successful_at, Some(10));
}

#[test]
fn invalid_identity_or_config_never_changes_installed_files() {
    let old_root = tempfile::tempdir().unwrap();
    let new_root = tempfile::tempdir().unwrap();
    let candidates = tempfile::tempdir().unwrap();
    write_package(old_root.path(), "1.0.0");
    write_package(new_root.path(), "2.0.0");
    let old = PluginPackage::inspect(old_root.path(), PluginSourceKind::Snapshot).unwrap();
    old.write_config(json!({"preview":false})).unwrap();
    let manifest = new_root.path().join(".vibex-plugin/plugin.json");
    let original: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
    let mut wrong_publisher = original.clone();
    wrong_publisher["publisher"] = json!("someone-else");
    std::fs::write(&manifest, wrong_publisher.to_string()).unwrap();
    assert!(
        PluginPackage::materialize_candidate(new_root.path(), candidates.path(), &old).is_err()
    );
    let mut wrong_schema = original;
    wrong_schema["config"]["schema"]["properties"]["preview"]["type"] = json!("string");
    std::fs::write(&manifest, wrong_schema.to_string()).unwrap();
    std::fs::write(
        new_root.path().join("config.json"),
        "{\"preview\":\"default\"}",
    )
    .unwrap();
    assert!(
        PluginPackage::materialize_candidate(new_root.path(), candidates.path(), &old).is_err()
    );
    assert_eq!(std::fs::read_dir(candidates.path()).unwrap().count(), 0);
    assert_eq!(
        old.product_detail().unwrap().config,
        json!({"preview":false})
    );
    assert_eq!(
        PluginPackage::inspect(old_root.path(), PluginSourceKind::Snapshot)
            .unwrap()
            .version,
        "1.0.0"
    );
}

#[tokio::test]
async fn github_stable_tag_source_does_not_require_a_release_asset() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new()
        .route(
            "/repos/acme/notes/releases",
            get(|| async { Json(json!([])) }),
        )
        .route(
            "/repos/acme/notes/tags",
            get(|| async {
                Json(json!([{"name":"v3.0.0-beta.1"},{"name":"v2.0.0"},{"name":"v1.0.0"}]))
            }),
        )
        .route(
            "/repos/acme/notes/git/ref/tags/v2.0.0",
            get(|| async {
                Json(json!({"ref":"refs/tags/v2.0.0","object":{"sha":"pinned-commit"}}))
            }),
        );
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let source = PluginSourceLock {
        source_kind: "github".into(),
        origin: "https://github.com/acme/notes".into(),
        owner: "acme".into(),
        plugin_name: "notes".into(),
        tag: "v1.0.0".into(),
        version: "1.0.0".into(),
        package_digest: "old".into(),
    };
    let resolver = PluginUpdateResolver::with_github_api(&origin).unwrap();
    for requested in [None, Some("v2.0.0")] {
        let update = resolver.resolve(&source, requested).await.unwrap().unwrap();
        assert_eq!(update.source.tag, "v2.0.0");
        assert_eq!(
            update.download_url,
            format!("{origin}/repos/acme/notes/zipball/v2.0.0")
        );
    }
    assert!(resolver.resolve(&source, Some("main")).await.is_err());
    task.abort();
}

#[tokio::test]
async fn failed_enabled_candidate_keeps_old_files_activation_and_user_data() {
    let node = std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|directory| directory.join(if cfg!(windows) { "node.exe" } else { "node" }))
        .find(|candidate| candidate.is_file())
        .expect("Node is required for the update journey");
    let old_root = tempfile::tempdir().unwrap();
    let next_root = tempfile::tempdir().unwrap();
    let staging = tempfile::tempdir().unwrap();
    write_package(old_root.path(), "1.0.0");
    write_package(next_root.path(), "2.0.0");
    let old = PluginPackage::inspect(old_root.path(), PluginSourceKind::Snapshot).unwrap();
    old.write_config(json!({"preview":false})).unwrap();
    let control = PluginControlPlane::new(Arc::new(InMemoryPluginRegistry::default()));
    control
        .import(old.clone(), ConflictDecision::Reject)
        .await
        .unwrap();
    control.set_enabled("acme.notes", true).await.unwrap();
    control
        .kv_put("acme.notes", "saved", &json!("user data"))
        .await
        .unwrap();
    let generation = control.active_generation("acme.notes").await;
    let mut broken =
        PluginPackage::materialize_candidate(next_root.path(), staging.path(), &old).unwrap();
    broken.entrypoints.worker = Some("dist/missing-worker.mjs".into());
    assert!(
        control
            .update_and_activate(&node, broken, &[], Arc::new(plugins::DenyCapabilityBroker))
            .await
            .is_err()
    );
    let current = control.plugin("acme.notes").await.unwrap().unwrap();
    assert_eq!(current.version, "1.0.0");
    assert_eq!(current.activation, PluginActivation::Enabled);
    assert_eq!(control.active_generation("acme.notes").await, generation);
    assert_eq!(
        current.product_detail().unwrap().config,
        json!({"preview":false})
    );
    assert_eq!(
        PluginPackage::inspect(&current.source.path, current.source.kind)
            .unwrap()
            .version,
        "1.0.0"
    );
    assert_eq!(
        control.kv_get("acme.notes", "saved").await.unwrap(),
        Some(json!("user data"))
    );
}
