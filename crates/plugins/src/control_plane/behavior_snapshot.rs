//! Behavioral snapshots of the plugin control plane.
//!
//! These tests lock current KV, secret, generation, runtime, and audit
//! semantics. They describe today's behavior, including adapter differences.

use std::sync::Arc;

use serde_json::json;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

use super::{
    kv_secret::{decrypt_plugin_secret, encrypt_plugin_secret},
    *,
};
use crate::{
    DenyCapabilityBroker, PluginActivation, PluginPackage, PluginSourceKind,
    contribution::descriptors_for_package,
};

async fn sqlite_pool() -> sqlx::SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(":memory:")
                .foreign_keys(true),
        )
        .await
        .expect("sqlite pool");
    for sql in [
        include_str!("../../../db/migrations/20260811010000_plugin_control_plane.sql"),
        include_str!("../../../db/migrations/20260811011000_plugin_runtime_evidence.sql"),
        include_str!("../../../db/migrations/20260814010000_plugin_platform_v4.sql"),
    ] {
        sqlx::raw_sql(sql)
            .execute(&pool)
            .await
            .expect("plugin control schema");
    }
    pool
}

async fn registries() -> Vec<(&'static str, Arc<dyn PluginRegistry>)> {
    vec![
        (
            "memory",
            Arc::new(InMemoryPluginRegistry::default()) as Arc<dyn PluginRegistry>,
        ),
        (
            "sqlite",
            Arc::new(SqlitePluginRegistry::new(sqlite_pool().await)) as Arc<dyn PluginRegistry>,
        ),
    ]
}

fn package(id: &str, version: &str, root: &std::path::Path, marker: &str) -> PluginPackage {
    std::fs::write(root.join("marker.txt"), marker).unwrap();
    PluginPackage::for_test(id, "Snapshot", version, PluginSourceKind::Snapshot, root)
}

async fn import_plugin(
    plane: &PluginControlPlane,
    id: &str,
    version: &str,
    marker: &str,
) -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    plane
        .import(
            package(id, version, root.path(), marker),
            ConflictDecision::Reject,
        )
        .await
        .expect("import plugin");
    root
}

#[tokio::test]
async fn kv_put_get_overwrite_and_delete_roundtrip() {
    for (adapter, registry) in registries().await {
        let plane = PluginControlPlane::new(registry);
        let _root = import_plugin(&plane, "dev.vibex.kv", "1.0.0", adapter).await;

        assert_eq!(
            plane.kv_get("dev.vibex.kv", "theme").await.unwrap(),
            None,
            "{adapter}: missing key is None"
        );

        plane
            .kv_put("dev.vibex.kv", "theme", &json!("dark"))
            .await
            .unwrap();
        assert_eq!(
            plane.kv_get("dev.vibex.kv", "theme").await.unwrap(),
            Some(json!("dark")),
            "{adapter}: put then get"
        );

        plane
            .kv_put("dev.vibex.kv", "theme", &json!({"mode": "light"}))
            .await
            .unwrap();
        assert_eq!(
            plane.kv_get("dev.vibex.kv", "theme").await.unwrap(),
            Some(json!({"mode": "light"})),
            "{adapter}: overwrite"
        );

        plane.kv_delete("dev.vibex.kv", "theme").await.unwrap();
        assert_eq!(
            plane.kv_get("dev.vibex.kv", "theme").await.unwrap(),
            None,
            "{adapter}: delete"
        );

        plane
            .kv_delete("dev.vibex.kv", "missing")
            .await
            .expect("deleting an absent key succeeds");
    }
}

#[tokio::test]
async fn kv_is_isolated_by_plugin_id_and_list_clear_are_scoped() {
    for (adapter, registry) in registries().await {
        let plane = PluginControlPlane::new(registry);
        let _a = import_plugin(&plane, "dev.vibex.a", "1.0.0", "a").await;
        let _b = import_plugin(&plane, "dev.vibex.b", "1.0.0", "b").await;

        plane
            .kv_put("dev.vibex.a", "alpha", &json!(1))
            .await
            .unwrap();
        plane
            .kv_put("dev.vibex.a", "alpine", &json!(2))
            .await
            .unwrap();
        plane
            .kv_put("dev.vibex.a", "beta", &json!(3))
            .await
            .unwrap();
        plane
            .kv_put("dev.vibex.b", "alpha", &json!("other"))
            .await
            .unwrap();

        let mut listed = plane.kv_list_keys("dev.vibex.a", Some("al")).await.unwrap();
        listed.sort();
        assert_eq!(
            listed,
            vec!["alpha".to_owned(), "alpine".to_owned()],
            "{adapter}: prefix filter"
        );

        let cleared = plane.kv_clear("dev.vibex.a").await.unwrap();
        assert_eq!(cleared, 3, "{adapter}: clear returns removed count");
        assert!(
            plane
                .kv_list_keys("dev.vibex.a", None)
                .await
                .unwrap()
                .is_empty(),
            "{adapter}: owner keys gone"
        );
        assert_eq!(
            plane.kv_get("dev.vibex.b", "alpha").await.unwrap(),
            Some(json!("other")),
            "{adapter}: other plugin KV is untouched"
        );
    }
}

#[tokio::test]
async fn uninstall_drops_kv_and_secrets_for_that_plugin_only() {
    for (adapter, registry) in registries().await {
        let plane = PluginControlPlane::new(registry);
        let _keep = import_plugin(&plane, "dev.vibex.keep", "1.0.0", "keep").await;
        let _drop = import_plugin(&plane, "dev.vibex.drop", "1.0.0", "drop").await;

        plane
            .kv_put("dev.vibex.drop", "gone", &json!(true))
            .await
            .unwrap();
        plane
            .kv_put("dev.vibex.keep", "stay", &json!(true))
            .await
            .unwrap();
        plane
            .secret_put("dev.vibex.drop", "token", "secret-drop")
            .await
            .unwrap();
        plane
            .secret_put("dev.vibex.keep", "token", "secret-keep")
            .await
            .unwrap();

        plane.uninstall("dev.vibex.drop").await.unwrap();

        assert_eq!(
            plane.kv_get("dev.vibex.drop", "gone").await.unwrap(),
            None,
            "{adapter}: uninstalled plugin KV is gone"
        );
        assert_eq!(
            plane.secret_get("dev.vibex.drop", "token").await.unwrap(),
            None,
            "{adapter}: uninstalled plugin secret is gone"
        );
        assert_eq!(
            plane.kv_get("dev.vibex.keep", "stay").await.unwrap(),
            Some(json!(true)),
            "{adapter}: remaining plugin KV stays"
        );
        assert_eq!(
            plane.secret_get("dev.vibex.keep", "token").await.unwrap(),
            Some("secret-keep".to_owned()),
            "{adapter}: remaining plugin secret stays"
        );
    }
}

#[tokio::test]
async fn secret_put_get_overwrite_and_delete_roundtrip() {
    for (adapter, registry) in registries().await {
        let plane = PluginControlPlane::new(registry);
        let _root = import_plugin(&plane, "dev.vibex.secret", "1.0.0", adapter).await;

        assert_eq!(
            plane
                .secret_get("dev.vibex.secret", "api-key")
                .await
                .unwrap(),
            None,
            "{adapter}: missing secret is None"
        );

        plane
            .secret_put("dev.vibex.secret", "api-key", "first-value")
            .await
            .unwrap();
        assert_eq!(
            plane
                .secret_get("dev.vibex.secret", "api-key")
                .await
                .unwrap(),
            Some("first-value".to_owned()),
            "{adapter}: put then get returns plaintext"
        );

        plane
            .secret_put("dev.vibex.secret", "api-key", "rotated")
            .await
            .unwrap();
        assert_eq!(
            plane
                .secret_get("dev.vibex.secret", "api-key")
                .await
                .unwrap(),
            Some("rotated".to_owned()),
            "{adapter}: overwrite"
        );

        assert!(
            plane
                .secret_delete("dev.vibex.secret", "api-key")
                .await
                .unwrap(),
            "{adapter}: delete existing returns true"
        );
        assert_eq!(
            plane
                .secret_get("dev.vibex.secret", "api-key")
                .await
                .unwrap(),
            None,
            "{adapter}: deleted secret is gone"
        );
        assert!(
            !plane
                .secret_delete("dev.vibex.secret", "api-key")
                .await
                .unwrap(),
            "{adapter}: delete missing returns false"
        );
    }
}

#[tokio::test]
async fn secret_is_isolated_by_plugin_id_and_secret_key() {
    for (adapter, registry) in registries().await {
        let plane = PluginControlPlane::new(registry);
        let _a = import_plugin(&plane, "dev.vibex.one", "1.0.0", "one").await;
        let _b = import_plugin(&plane, "dev.vibex.two", "1.0.0", "two").await;

        plane
            .secret_put("dev.vibex.one", "token", "alpha")
            .await
            .unwrap();
        plane
            .secret_put("dev.vibex.one", "other", "beta")
            .await
            .unwrap();
        plane
            .secret_put("dev.vibex.two", "token", "gamma")
            .await
            .unwrap();

        assert_eq!(
            plane.secret_get("dev.vibex.one", "token").await.unwrap(),
            Some("alpha".to_owned()),
            "{adapter}"
        );
        assert_eq!(
            plane.secret_get("dev.vibex.one", "other").await.unwrap(),
            Some("beta".to_owned()),
            "{adapter}"
        );
        assert_eq!(
            plane.secret_get("dev.vibex.two", "token").await.unwrap(),
            Some("gamma".to_owned()),
            "{adapter}"
        );
        assert_eq!(
            plane.secret_get("dev.vibex.two", "other").await.unwrap(),
            None,
            "{adapter}: missing key in other plugin"
        );
    }
}

#[tokio::test]
async fn secret_helpers_authenticate_the_envelope_and_reject_tampering() {
    let ciphertext = encrypt_plugin_secret("dev.vibex.secret", "token", "plain").unwrap();
    assert_ne!(ciphertext, "plain");
    assert!(!ciphertext.contains("plain"));
    assert_eq!(
        decrypt_plugin_secret("dev.vibex.secret", "token", &ciphertext).unwrap(),
        "plain"
    );

    let mismatch = decrypt_plugin_secret("dev.vibex.other", "token", &ciphertext).unwrap_err();
    assert_eq!(
        mismatch.message(),
        "plugin secret authentication tag mismatch"
    );

    let wrong_key = decrypt_plugin_secret("dev.vibex.secret", "other", &ciphertext).unwrap_err();
    assert_eq!(
        wrong_key.message(),
        "plugin secret authentication tag mismatch"
    );

    let invalid = decrypt_plugin_secret("dev.vibex.secret", "token", "not-base64!").unwrap_err();
    assert_eq!(invalid.code(), "plugin_registry_failed");

    let mut envelope =
        base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &ciphertext).unwrap();
    let last = envelope.len() - 1;
    envelope[last] ^= 0xff;
    let tampered = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, envelope);
    let tamper_error = decrypt_plugin_secret("dev.vibex.secret", "token", &tampered).unwrap_err();
    assert_eq!(
        tamper_error.message(),
        "plugin secret authentication tag mismatch"
    );
}

#[tokio::test]
async fn sqlite_stores_secrets_as_ciphertext_not_plaintext() {
    let pool = sqlite_pool().await;
    let registry = Arc::new(SqlitePluginRegistry::new(pool.clone()));
    let plane = PluginControlPlane::new(registry);
    let _root = import_plugin(&plane, "dev.vibex.secret", "1.0.0", "cipher").await;
    plane
        .secret_put("dev.vibex.secret", "token", "super-secret-value")
        .await
        .unwrap();

    let stored: String = sqlx::query_scalar(
        "SELECT ciphertext_b64 FROM plugin_secrets_storage
         WHERE plugin_id = ? AND secret_key = ?",
    )
    .bind("dev.vibex.secret")
    .bind("token")
    .fetch_one(&pool)
    .await
    .expect("ciphertext row");
    assert!(!stored.contains("super-secret-value"));
    assert_eq!(
        decrypt_plugin_secret("dev.vibex.secret", "token", &stored).unwrap(),
        "super-secret-value"
    );
}

#[tokio::test]
async fn set_enabled_publishes_and_withdraw_clears_the_live_generation() {
    for (adapter, registry) in registries().await {
        let plane = PluginControlPlane::new(registry.clone());
        let _root = import_plugin(&plane, "dev.vibex.gen", "1.0.0", adapter).await;

        assert_eq!(
            plane.active_generation("dev.vibex.gen").await,
            None,
            "{adapter}: disabled has no generation"
        );

        let enabled = plane.set_enabled("dev.vibex.gen", true).await.unwrap();
        assert_eq!(enabled.activation, PluginActivation::Enabled);
        let generation = plane
            .active_generation("dev.vibex.gen")
            .await
            .expect("published generation");
        assert!(generation >= 1, "{adapter}: generation ids start at 1");
        assert!(
            !registry.active_contributions().await.unwrap().is_empty(),
            "{adapter}: live contributions are published"
        );

        let disabled = plane.set_enabled("dev.vibex.gen", false).await.unwrap();
        assert_eq!(disabled.activation, PluginActivation::Disabled);
        assert_eq!(
            plane.active_generation("dev.vibex.gen").await,
            None,
            "{adapter}: withdraw clears the live generation"
        );
    }
}

#[tokio::test]
async fn create_candidate_requires_an_installed_plugin() {
    for (adapter, registry) in registries().await {
        let error = registry
            .create_candidate("dev.vibex.missing")
            .await
            .expect_err("missing plugin");
        assert_eq!(error.code(), "plugin_not_found", "{adapter}");
        assert_eq!(
            error.message(),
            "plugin `dev.vibex.missing` is not imported",
            "{adapter}"
        );
    }
}

#[tokio::test]
async fn publish_candidate_enables_the_plugin_and_fail_blocks_that_generation() {
    for (adapter, registry) in registries().await {
        let plane = PluginControlPlane::new(registry.clone());
        let root = import_plugin(&plane, "dev.vibex.gen", "1.0.0", adapter).await;
        let installed = plane.plugin("dev.vibex.gen").await.unwrap().unwrap();

        let live = registry.create_candidate("dev.vibex.gen").await.unwrap();
        let contributions = descriptors_for_package(&installed.package, live);
        registry
            .publish_candidate(
                "dev.vibex.gen",
                live,
                &installed.package,
                &contributions,
                &[],
            )
            .await
            .unwrap();
        assert_eq!(
            registry.active_generation("dev.vibex.gen").await.unwrap(),
            Some(live)
        );
        assert_eq!(
            plane
                .plugin("dev.vibex.gen")
                .await
                .unwrap()
                .unwrap()
                .activation,
            PluginActivation::Enabled,
            "{adapter}: publish sets enabled"
        );

        let failed = registry.create_candidate("dev.vibex.gen").await.unwrap();
        registry
            .fail_candidate(failed, "probe exploded")
            .await
            .unwrap();
        let error = registry
            .publish_candidate(
                "dev.vibex.gen",
                failed,
                &installed.package,
                &descriptors_for_package(&installed.package, failed),
                &[],
            )
            .await
            .expect_err("failed candidate cannot publish");
        assert_eq!(error.code(), "plugin_registry_failed", "{adapter}");
        assert_eq!(
            registry.active_generation("dev.vibex.gen").await.unwrap(),
            Some(live),
            "{adapter}: previous generation remains"
        );
        drop(root);
    }
}

#[tokio::test]
async fn fail_candidate_error_text_differs_by_adapter() {
    let memory = Arc::new(InMemoryPluginRegistry::default());
    let plane = PluginControlPlane::new(memory.clone());
    let _root = import_plugin(&plane, "dev.vibex.gen", "1.0.0", "memory").await;
    let installed = plane.plugin("dev.vibex.gen").await.unwrap().unwrap();
    let generation = memory.create_candidate("dev.vibex.gen").await.unwrap();
    memory.fail_candidate(generation, "boom").await.unwrap();
    let memory_error = memory
        .publish_candidate("dev.vibex.gen", generation, &installed.package, &[], &[])
        .await
        .unwrap_err();
    assert_eq!(memory_error.message(), "candidate package is missing");

    let sqlite = Arc::new(SqlitePluginRegistry::new(sqlite_pool().await));
    let plane = PluginControlPlane::new(sqlite.clone());
    let _root = import_plugin(&plane, "dev.vibex.gen", "1.0.0", "sqlite").await;
    let installed = plane.plugin("dev.vibex.gen").await.unwrap().unwrap();
    let generation = sqlite.create_candidate("dev.vibex.gen").await.unwrap();
    sqlite.fail_candidate(generation, "boom").await.unwrap();
    let sqlite_error = sqlite
        .publish_candidate("dev.vibex.gen", generation, &installed.package, &[], &[])
        .await
        .unwrap_err();
    assert_eq!(
        sqlite_error.message(),
        "candidate generation is missing or no longer publishable"
    );
}

#[tokio::test]
async fn retire_published_generation_drops_the_live_generation_without_changing_enable_intent() {
    for (adapter, registry) in registries().await {
        let plane = PluginControlPlane::new(registry.clone());
        let _root = import_plugin(&plane, "dev.vibex.gen", "1.0.0", adapter).await;
        plane.set_enabled("dev.vibex.gen", true).await.unwrap();
        assert!(plane.active_generation("dev.vibex.gen").await.is_some());

        registry
            .retire_published_generation("dev.vibex.gen")
            .await
            .unwrap();
        assert_eq!(
            plane.active_generation("dev.vibex.gen").await,
            None,
            "{adapter}: live generation is gone"
        );
        assert_eq!(
            plane
                .plugin("dev.vibex.gen")
                .await
                .unwrap()
                .unwrap()
                .activation,
            PluginActivation::Enabled,
            "{adapter}: enable intent is unchanged"
        );
    }
}

#[tokio::test]
async fn in_memory_retire_generation_is_a_noop() {
    let registry = Arc::new(InMemoryPluginRegistry::default());
    let plane = PluginControlPlane::new(registry.clone());
    let _root = import_plugin(&plane, "dev.vibex.gen", "1.0.0", "memory").await;
    plane.set_enabled("dev.vibex.gen", true).await.unwrap();
    let generation = plane.active_generation("dev.vibex.gen").await.unwrap();
    registry.retire_generation(generation).await.unwrap();
    assert_eq!(
        plane.active_generation("dev.vibex.gen").await,
        Some(generation),
        "in-memory retire_generation does not drop a live generation"
    );
}

#[tokio::test]
async fn sqlite_retire_generation_only_retires_draining_rows() {
    let registry = Arc::new(SqlitePluginRegistry::new(sqlite_pool().await));
    let plane = PluginControlPlane::new(registry.clone());
    let _root = import_plugin(&plane, "dev.vibex.gen", "1.0.0", "sqlite").await;
    plane.set_enabled("dev.vibex.gen", true).await.unwrap();
    let generation = plane.active_generation("dev.vibex.gen").await.unwrap();
    registry.retire_generation(generation).await.unwrap();
    assert_eq!(
        plane.active_generation("dev.vibex.gen").await,
        Some(generation),
        "active rows are not draining, so retire_generation leaves them"
    );
}

#[tokio::test]
async fn replacing_a_package_retains_rollback_and_rollback_and_activate_republishes_it() {
    for (adapter, registry) in registries().await {
        let plane = PluginControlPlane::new(registry.clone());
        let first_root = tempfile::tempdir().unwrap();
        let second_root = tempfile::tempdir().unwrap();
        let first = package("dev.vibex.rollback", "1.0.0", first_root.path(), "one");
        let second = package("dev.vibex.rollback", "2.0.0", second_root.path(), "two");
        assert_ne!(
            crate::package_content_digest(first.content_root()).unwrap(),
            crate::package_content_digest(second.content_root()).unwrap()
        );

        plane.import(first, ConflictDecision::Reject).await.unwrap();
        assert!(
            !plane
                .rollback_available("dev.vibex.rollback")
                .await
                .unwrap()
        );

        plane
            .import(second, ConflictDecision::Replace)
            .await
            .unwrap();
        assert!(
            plane
                .rollback_available("dev.vibex.rollback")
                .await
                .unwrap(),
            "{adapter}: digest change retains rollback"
        );
        let rollback = registry
            .rollback_package("dev.vibex.rollback")
            .await
            .unwrap()
            .expect("rollback package");
        assert_eq!(rollback.package.version, "1.0.0", "{adapter}");

        let restored = plane
            .rollback_and_activate(
                std::path::Path::new("node"),
                "dev.vibex.rollback",
                &[],
                Arc::new(DenyCapabilityBroker),
            )
            .await
            .unwrap();
        assert_eq!(restored.package.version, "1.0.0", "{adapter}");
        assert_eq!(restored.activation, PluginActivation::Enabled, "{adapter}");
        assert!(
            plane
                .active_generation("dev.vibex.rollback")
                .await
                .is_some(),
            "{adapter}: rollback publishes a new generation"
        );
    }
}

#[tokio::test]
async fn record_runtime_locks_the_artifact_to_the_current_package() {
    for (adapter, registry) in registries().await {
        let plane = PluginControlPlane::new(registry);
        let _root = import_plugin(&plane, "dev.vibex.rt", "1.0.0", adapter).await;
        let missing = plane
            .record_runtime(
                "dev.vibex.missing",
                RuntimeInstallation {
                    id: "cli".into(),
                    version: "1.0.0".into(),
                    target: "test-target".into(),
                    content_digest: "sha256:cli".into(),
                    executable_path: "/tmp/cli".into(),
                    ownership: "managed".into(),
                    installer: "test".into(),
                    probe: vec!["--version".into()],
                    referenced_plugins: vec!["ignored".into()],
                },
            )
            .await
            .unwrap_err();
        assert_eq!(missing.code(), "plugin_not_found", "{adapter}");

        plane
            .record_runtime(
                "dev.vibex.rt",
                RuntimeInstallation {
                    id: "cli".into(),
                    version: "1.0.0".into(),
                    target: "test-target".into(),
                    content_digest: "sha256:cli".into(),
                    executable_path: "/tmp/cli".into(),
                    ownership: "managed".into(),
                    installer: "test".into(),
                    probe: vec!["--version".into()],
                    referenced_plugins: vec!["ignored".into()],
                },
            )
            .await
            .unwrap();

        let locked = plane
            .runtime_for_plugin("dev.vibex.rt", "cli")
            .await
            .unwrap()
            .expect("lock");
        assert_eq!(locked.id, "cli");
        assert_eq!(locked.version, "1.0.0");
        assert_eq!(locked.content_digest, "sha256:cli");
        assert_eq!(
            locked.referenced_plugins,
            vec!["dev.vibex.rt".to_owned()],
            "{adapter}: put_runtime overwrites referenced_plugins with the locking plugin"
        );

        let inventory = plane.runtime_inventory().await.unwrap();
        assert_eq!(inventory.len(), 1, "{adapter}");
        assert_eq!(
            inventory[0].referenced_plugins,
            vec!["dev.vibex.rt".to_owned()],
            "{adapter}"
        );
    }
}

#[tokio::test]
async fn uninstall_keeps_runtime_artifacts_until_reclaim_removes_unreferenced_managed_files() {
    for (adapter, registry) in registries().await {
        let plane = PluginControlPlane::new(registry);
        let plugin_root = import_plugin(&plane, "dev.vibex.rt", "1.0.0", adapter).await;
        let runtime_root = tempfile::tempdir().unwrap();
        let artifact = runtime_root.path().join("orphan/bin");
        std::fs::create_dir_all(artifact.parent().unwrap()).unwrap();
        std::fs::write(&artifact, b"runtime-bytes").unwrap();

        plane
            .record_runtime(
                "dev.vibex.rt",
                RuntimeInstallation {
                    id: "orphan".into(),
                    version: "1.0.0".into(),
                    target: "test-target".into(),
                    content_digest: "sha256:orphan".into(),
                    executable_path: artifact.clone(),
                    ownership: "managed".into(),
                    installer: "test".into(),
                    probe: Vec::new(),
                    referenced_plugins: vec!["dev.vibex.rt".into()],
                },
            )
            .await
            .unwrap();

        plane.uninstall("dev.vibex.rt").await.unwrap();
        let inventory = plane.runtime_inventory().await.unwrap();
        assert_eq!(inventory.len(), 1, "{adapter}: artifact survives uninstall");
        assert!(
            inventory[0].referenced_plugins.is_empty(),
            "{adapter}: no remaining plugin refs"
        );
        assert!(artifact.is_file(), "{adapter}: file still on disk");

        let reclaimed = plane
            .reclaim_unreferenced_runtimes(runtime_root.path())
            .await
            .unwrap();
        assert_eq!(
            reclaimed,
            vec!["orphan@1.0.0 (sha256:orphan)".to_owned()],
            "{adapter}"
        );
        assert!(
            plane.runtime_inventory().await.unwrap().is_empty(),
            "{adapter}: artifact row is gone"
        );
        assert!(
            !artifact.is_file(),
            "{adapter}: managed file under the runtime root is deleted"
        );
        drop(plugin_root);
    }
}

#[tokio::test]
async fn import_and_uninstall_append_audit_events_that_survive_membership_removal() {
    for (adapter, registry) in registries().await {
        let plane = PluginControlPlane::new(registry);
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        plane
            .import(
                package("dev.vibex.audit", "1.0.0", first.path(), "one"),
                ConflictDecision::Reject,
            )
            .await
            .unwrap();
        let installed = plane.audit_events("dev.vibex.audit").await.unwrap();
        assert_eq!(installed.len(), 1, "{adapter}");
        assert_eq!(installed[0].event, "install", "{adapter}");
        assert!(
            installed[0].evidence.get("packageDigest").is_some(),
            "{adapter}"
        );

        plane
            .import(
                package("dev.vibex.audit", "2.0.0", second.path(), "two"),
                ConflictDecision::Replace,
            )
            .await
            .unwrap();
        let updated = plane.audit_events("dev.vibex.audit").await.unwrap();
        assert_eq!(updated.len(), 2, "{adapter}");
        assert_eq!(updated[1].event, "update", "{adapter}");

        plane.uninstall("dev.vibex.audit").await.unwrap();
        let remaining = plane.audit_events("dev.vibex.audit").await.unwrap();
        assert_eq!(remaining.len(), 3, "{adapter}: uninstall keeps the log");
        assert_eq!(remaining[2].event, "uninstall", "{adapter}");
        assert!(
            plane.plugin("dev.vibex.audit").await.unwrap().is_none(),
            "{adapter}: membership is gone"
        );
    }
}

#[tokio::test]
async fn audit_is_isolated_by_plugin_id_and_does_not_require_an_install_row() {
    for (adapter, registry) in registries().await {
        let plane = PluginControlPlane::new(registry);
        let _root = import_plugin(&plane, "dev.vibex.audit", "1.0.0", adapter).await;

        plane
            .record_audit(
                "dev.vibex.audit",
                "custom",
                &json!({ "ok": true, "secret": "must-be-preserved" }),
            )
            .await
            .unwrap();
        plane
            .record_audit("dev.vibex.other", "custom", &json!({ "ok": false }))
            .await
            .unwrap();

        let owned = plane.audit_events("dev.vibex.audit").await.unwrap();
        assert!(
            owned.iter().any(|event| event.event == "custom"
                && event.evidence == json!({ "ok": true, "secret": "must-be-preserved" })),
            "{adapter}: custom event is stored as given"
        );
        let other = plane.audit_events("dev.vibex.other").await.unwrap();
        assert_eq!(other.len(), 1, "{adapter}");
        assert_eq!(other[0].event, "custom", "{adapter}");
        assert_eq!(other[0].evidence, json!({ "ok": false }), "{adapter}");
    }
}

#[tokio::test]
async fn sqlite_capability_grants_stay_empty_after_publish() {
    let registry = Arc::new(SqlitePluginRegistry::new(sqlite_pool().await));
    let plane = PluginControlPlane::new(registry.clone());
    let _root = import_plugin(&plane, "dev.vibex.grants", "1.0.0", "sqlite").await;
    let installed = plane.plugin("dev.vibex.grants").await.unwrap().unwrap();
    let generation = registry.create_candidate("dev.vibex.grants").await.unwrap();
    registry
        .publish_candidate(
            "dev.vibex.grants",
            generation,
            &installed.package,
            &descriptors_for_package(&installed.package, generation),
            &[crate::CapabilityGrant {
                capability: "runtime.execute".into(),
                scope: json!({"runtime": "tool"}),
                trust_tier: "trusted_native".into(),
            }],
        )
        .await
        .unwrap();
    assert!(
        registry
            .capability_grants("dev.vibex.grants")
            .await
            .unwrap()
            .is_empty(),
        "sqlite capability_grants ignores published grants"
    );
}

#[tokio::test]
async fn in_memory_capability_grants_persist_the_published_projection() {
    let registry = Arc::new(InMemoryPluginRegistry::default());
    let plane = PluginControlPlane::new(registry.clone());
    let _root = import_plugin(&plane, "dev.vibex.grants", "1.0.0", "memory").await;
    let installed = plane.plugin("dev.vibex.grants").await.unwrap().unwrap();
    let generation = registry.create_candidate("dev.vibex.grants").await.unwrap();
    let grants = vec![crate::CapabilityGrant {
        capability: "runtime.execute".into(),
        scope: json!({"runtime": "tool"}),
        trust_tier: "trusted_native".into(),
    }];
    registry
        .publish_candidate(
            "dev.vibex.grants",
            generation,
            &installed.package,
            &descriptors_for_package(&installed.package, generation),
            &grants,
        )
        .await
        .unwrap();
    assert_eq!(
        registry
            .capability_grants("dev.vibex.grants")
            .await
            .unwrap(),
        grants
    );
}
