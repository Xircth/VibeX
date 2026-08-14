use std::sync::Arc;

use plugins::{
    CapabilityRequest, ConflictDecision, InvocationDefinition, InvocationKind, PluginControlPlane,
    PluginPackage, PluginSourceKind, RuntimeContribution, RuntimeInstall, RuntimeInstallation,
    SqlitePluginRegistry,
};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

async fn pool() -> sqlx::SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(":memory:")
                .foreign_keys(true),
        )
        .await
        .expect("sqlite pool");
    sqlx::raw_sql(include_str!(
        "../../db/migrations/20260811010000_plugin_control_plane.sql"
    ))
    .execute(&pool)
    .await
    .expect("plugin control schema");
    sqlx::raw_sql(include_str!(
        "../../db/migrations/20260811011000_plugin_runtime_evidence.sql"
    ))
    .execute(&pool)
    .await
    .expect("plugin Runtime evidence schema");
    sqlx::raw_sql(include_str!(
        "../../db/migrations/20260813010000_plugin_platform_v4.sql"
    ))
    .execute(&pool)
    .await
    .expect("plugin platform v4 schema");
    pool
}

fn write_package_version(root: &std::path::Path, version: &str) {
    std::fs::write(
        root.join("plugin-version.json"),
        serde_json::json!({ "version": version }).to_string(),
    )
    .expect("write package version fixture");
}

fn worker_package(root: &std::path::Path, version: &str) -> PluginPackage {
    std::fs::write(
        root.join("worker.mjs"),
        r#"import{createInterface}from'node:readline';for await(const l of createInterface({input:process.stdin})){const m=JSON.parse(l);const result=m.method==='activate'?{handlers:['ping']}:m.method==='invoke'?{version:process.cwd()}:null;console.log(JSON.stringify({id:m.id,ok:true,result}));}"#,
    )
    .unwrap();
    write_package_version(root, version);
    let mut package = PluginPackage::for_test(
        "dev.vibex.drain",
        "Drain",
        version,
        PluginSourceKind::DeveloperLink,
        root,
    );
    package.entrypoints.worker = Some("worker.mjs".to_owned());
    package.invocations.push(InvocationDefinition {
        id: "ping".to_owned(),
        label: "Ping".to_owned(),
        prompt: "Ping".to_owned(),
        skill: None,
        required_skills: Vec::new(),
        required_runtimes: Vec::new(),
        handler: Some("ping".to_owned()),
        artifact_intent: None,
        kind: InvocationKind::Action,
    });
    package
}

fn linked_worker_package(root: &std::path::Path) -> PluginPackage {
    std::fs::create_dir_all(root.join(".vibex-plugin")).unwrap();
    std::fs::write(
        root.join(".vibex-plugin/plugin.json"),
        r#"{
          "manifestVersion":4,"apiVersion":"1.0",
          "id":"dev.vibex.drain","publisher":"dev.vibex",
          "name":"Drain","version":"1.0.0",
          "engines":{"vibex":">=0.1.3 <1.0.0","pluginSdk":"^1.0.0"},
          "entrypoints":{"worker":{"path":"worker.mjs","format":"javascript-esm","protocol":"1.0"}},
          "permissions":[],
          "contributes":{"agent.invocations":[
            {"id":"ping","kindVersion":1,"label":"Ping","entrypoints":["action"],"handler":"ping"}
          ]}
        }"#,
    )
    .unwrap();
    std::fs::write(
        root.join("worker.mjs"),
        r#"import{createInterface}from'node:readline';for await(const l of createInterface({input:process.stdin})){const m=JSON.parse(l);const result=m.method==='activate'?{handlers:['ping']}:m.method==='invoke'?{version:process.cwd()}:null;console.log(JSON.stringify({id:m.id,ok:true,result}));}"#,
    )
    .unwrap();
    PluginPackage::inspect(root, PluginSourceKind::DeveloperLink).unwrap()
}

fn locked_runtime() -> RuntimeContribution {
    RuntimeContribution {
        id: "fixture-cli".to_owned(),
        command: "fixture-cli".to_owned(),
        version: Some("1.0.0".to_owned()),
        target: "test-target".to_owned(),
        content_digest: "sha256:fixture-cli-1".to_owned(),
        probe: vec!["--version".to_owned()],
        install: RuntimeInstall::Existing,
    }
}

#[tokio::test]
async fn replaced_generation_retires_only_after_old_leases_drain() {
    let Some(node) = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|directory| directory.join(if cfg!(windows) { "node.exe" } else { "node" }))
            .find(|candidate| candidate.is_file())
    }) else {
        return;
    };
    let pool = pool().await;
    let first_root = tempfile::tempdir().unwrap();
    let second_root = tempfile::tempdir().unwrap();
    let control = PluginControlPlane::new(Arc::new(SqlitePluginRegistry::new(pool.clone())));
    control
        .import(
            worker_package(first_root.path(), "1.0.0"),
            ConflictDecision::Reject,
        )
        .await
        .unwrap();
    control
        .activate_and_enable(
            &node,
            "dev.vibex.drain",
            &[],
            Arc::new(plugins::DenyCapabilityBroker),
        )
        .await
        .unwrap();
    let old_lease = control.activation_lease("dev.vibex.drain").await.unwrap();
    control
        .update_and_activate(
            &node,
            worker_package(second_root.path(), "2.0.0"),
            &[],
            Arc::new(plugins::DenyCapabilityBroker),
        )
        .await
        .unwrap();

    let state: String = sqlx::query_scalar(
        "SELECT state FROM plugin_generations_v4 WHERE plugin_id = ? ORDER BY generation_id LIMIT 1",
    )
    .bind("dev.vibex.drain")
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(state, "draining");
    drop(old_lease);
    for _ in 0..50 {
        let state: String = sqlx::query_scalar(
            "SELECT state FROM plugin_generations_v4 WHERE plugin_id = ? ORDER BY generation_id LIMIT 1",
        )
        .bind("dev.vibex.drain")
        .fetch_one(&pool)
        .await
        .unwrap();
        if state == "retired" {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("drained generation did not retire");
}

#[tokio::test]
async fn update_publishes_the_exact_runtime_lock_for_the_candidate_digest() {
    let Some(node) = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|directory| directory.join(if cfg!(windows) { "node.exe" } else { "node" }))
            .find(|candidate| candidate.is_file())
    }) else {
        return;
    };
    let pool = pool().await;
    let first_root = tempfile::tempdir().unwrap();
    let second_root = tempfile::tempdir().unwrap();
    let control = PluginControlPlane::new(Arc::new(SqlitePluginRegistry::new(pool.clone())));
    let mut first = worker_package(first_root.path(), "1.0.0");
    first.runtimes.push(locked_runtime());
    control
        .import(first, ConflictDecision::Reject)
        .await
        .unwrap();
    control
        .record_runtime(
            "dev.vibex.drain",
            RuntimeInstallation {
                id: "fixture-cli".to_owned(),
                version: "1.0.0".to_owned(),
                target: "test-target".to_owned(),
                content_digest: "sha256:fixture-cli-1".to_owned(),
                executable_path: std::env::current_exe().unwrap(),
                ownership: "managed".to_owned(),
                installer: "test".to_owned(),
                probe: vec!["--version".to_owned()],
                referenced_plugins: Vec::new(),
            },
        )
        .await
        .unwrap();
    control
        .activate_and_enable(
            &node,
            "dev.vibex.drain",
            &[],
            Arc::new(plugins::DenyCapabilityBroker),
        )
        .await
        .unwrap();

    let mut second = worker_package(second_root.path(), "2.0.0");
    second.runtimes.push(locked_runtime());
    let updated = control
        .update_and_activate(&node, second, &[], Arc::new(plugins::DenyCapabilityBroker))
        .await
        .unwrap();

    let lock = control
        .runtime_for_plugin("dev.vibex.drain", "fixture-cli")
        .await
        .unwrap()
        .expect("candidate digest must own an exact Runtime lock");
    assert_eq!(lock.target, "test-target");
    assert_eq!(lock.content_digest, "sha256:fixture-cli-1");
    let lock_digest: String = sqlx::query_scalar(
        "SELECT package_digest FROM plugin_runtime_locks_v4
         WHERE plugin_id = ? AND runtime_id = ? AND package_digest = ?",
    )
    .bind("dev.vibex.drain")
    .bind("fixture-cli")
    .bind(&updated.package_digest)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(lock_digest, updated.package_digest);
}

#[tokio::test]
async fn enabled_worker_is_restored_after_host_restart() {
    let Some(node) = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|directory| directory.join(if cfg!(windows) { "node.exe" } else { "node" }))
            .find(|candidate| candidate.is_file())
    }) else {
        return;
    };
    let pool = pool().await;
    let root = tempfile::tempdir().unwrap();
    let first = PluginControlPlane::new(Arc::new(SqlitePluginRegistry::new(pool.clone())));
    first
        .import(
            worker_package(root.path(), "1.0.0"),
            ConflictDecision::Reject,
        )
        .await
        .unwrap();
    first
        .activate_and_enable(
            &node,
            "dev.vibex.drain",
            &[],
            Arc::new(plugins::DenyCapabilityBroker),
        )
        .await
        .unwrap();
    let published_generation: i64 = sqlx::query_scalar(
        "SELECT generation_id FROM plugin_generations_v4 WHERE plugin_id = ? AND state = 'active'",
    )
    .bind("dev.vibex.drain")
    .fetch_one(&pool)
    .await
    .unwrap();
    drop(first);

    let restored = PluginControlPlane::new(Arc::new(SqlitePluginRegistry::new(pool.clone())));
    let candidates = tempfile::tempdir().unwrap();
    let failures = restored
        .recover_enabled_workers(
            &node,
            candidates.path(),
            Arc::new(plugins::DenyCapabilityBroker),
        )
        .await
        .unwrap();
    assert!(failures.is_empty());
    assert!(restored.activation_lease("dev.vibex.drain").await.is_some());
    let generations: Vec<(i64, String)> = sqlx::query_as(
        "SELECT generation_id, state FROM plugin_generations_v4 WHERE plugin_id = ? ORDER BY generation_id",
    )
    .bind("dev.vibex.drain")
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        generations,
        vec![(published_generation, "active".to_owned())]
    );
    assert_eq!(
        restored
            .activation_lease("dev.vibex.drain")
            .await
            .unwrap()
            .activation()
            .generation as i64,
        published_generation
    );
}

#[tokio::test]
async fn linked_worker_refreezes_source_when_its_candidate_snapshot_is_lost() {
    let Some(node) = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|directory| directory.join(if cfg!(windows) { "node.exe" } else { "node" }))
            .find(|candidate| candidate.is_file())
    }) else {
        return;
    };
    let pool = pool().await;
    let source = tempfile::tempdir().unwrap();
    let candidates = tempfile::tempdir().unwrap();
    let mut package = linked_worker_package(source.path());
    let digest = plugins::package_content_digest(source.path()).unwrap();
    package
        .freeze_execution_root(candidates.path(), &digest)
        .unwrap();
    let lost_snapshot = package.content_root().to_path_buf();
    let first = PluginControlPlane::new(Arc::new(SqlitePluginRegistry::new(pool.clone())));
    first
        .import(package, ConflictDecision::Reject)
        .await
        .unwrap();
    first
        .activate_and_enable(
            &node,
            "dev.vibex.drain",
            &[],
            Arc::new(plugins::DenyCapabilityBroker),
        )
        .await
        .unwrap();
    drop(first);
    std::fs::remove_dir_all(&lost_snapshot).unwrap();

    let restored = PluginControlPlane::new(Arc::new(SqlitePluginRegistry::new(pool)));
    let failures = restored
        .recover_enabled_workers(
            &node,
            candidates.path(),
            Arc::new(plugins::DenyCapabilityBroker),
        )
        .await
        .unwrap();

    assert!(failures.is_empty());
    assert!(restored.activation_lease("dev.vibex.drain").await.is_some());
    let installed = restored.plugin("dev.vibex.drain").await.unwrap().unwrap();
    assert!(installed.package.content_root().is_dir());
    assert_eq!(
        installed.package.source.path,
        source.path().canonicalize().unwrap()
    );
}

#[tokio::test]
async fn runtime_artifacts_are_content_addressed_and_locks_are_package_scoped() {
    let pool = pool().await;
    let root = tempfile::tempdir().unwrap();
    write_package_version(root.path(), "1.0.0");
    let control = PluginControlPlane::new(Arc::new(SqlitePluginRegistry::new(pool.clone())));
    for id in ["dev.vibex.one", "dev.vibex.two"] {
        control
            .import(
                PluginPackage::for_test(id, id, "1.0.0", PluginSourceKind::Snapshot, root.path()),
                ConflictDecision::Reject,
            )
            .await
            .unwrap();
    }
    for (plugin_id, version, digest, path) in [
        ("dev.vibex.one", "1.0.0", "sha256:one", "/runtime/one/tool"),
        ("dev.vibex.two", "2.0.0", "sha256:two", "/runtime/two/tool"),
    ] {
        control
            .record_runtime(
                plugin_id,
                RuntimeInstallation {
                    id: "shared".to_owned(),
                    version: version.to_owned(),
                    target: "darwin-arm64".to_owned(),
                    content_digest: digest.to_owned(),
                    executable_path: path.into(),
                    ownership: "managed".to_owned(),
                    installer: "binary".to_owned(),
                    probe: vec!["--version".to_owned()],
                    referenced_plugins: vec![],
                },
            )
            .await
            .unwrap();
    }

    let inventory = control.runtime_inventory().await.unwrap();
    assert_eq!(inventory.len(), 2);
    assert_eq!(inventory[0].referenced_plugins, vec!["dev.vibex.one"]);
    assert_eq!(inventory[1].referenced_plugins, vec!["dev.vibex.two"]);

    control.uninstall("dev.vibex.one").await.unwrap();
    let inventory = control.runtime_inventory().await.unwrap();
    assert!(
        inventory
            .iter()
            .any(|runtime| { runtime.version == "1.0.0" && runtime.referenced_plugins.is_empty() })
    );
    assert!(inventory.iter().any(|runtime| {
        runtime.version == "2.0.0" && runtime.referenced_plugins == ["dev.vibex.two".to_owned()]
    }));
}

#[tokio::test]
async fn rollback_republishes_the_retained_package_as_a_new_generation() {
    let pool = pool().await;
    let first_root = tempfile::tempdir().unwrap();
    let second_root = tempfile::tempdir().unwrap();
    write_package_version(first_root.path(), "1.0.0");
    write_package_version(second_root.path(), "2.0.0");
    let control = PluginControlPlane::new(Arc::new(SqlitePluginRegistry::new(pool.clone())));
    let first = PluginPackage::for_test(
        "dev.vibex.rollback",
        "Rollback",
        "1.0.0",
        PluginSourceKind::Snapshot,
        first_root.path(),
    );
    control
        .import(first, ConflictDecision::Reject)
        .await
        .unwrap();
    control
        .set_enabled("dev.vibex.rollback", true)
        .await
        .unwrap();
    let second = PluginPackage::for_test(
        "dev.vibex.rollback",
        "Rollback",
        "2.0.0",
        PluginSourceKind::Snapshot,
        second_root.path(),
    );
    control
        .update_and_activate(
            std::path::Path::new("unused-without-worker"),
            second,
            &[],
            Arc::new(plugins::DenyCapabilityBroker),
        )
        .await
        .unwrap();

    assert!(
        control
            .rollback_available("dev.vibex.rollback")
            .await
            .unwrap()
    );
    let restored = control
        .rollback_and_activate(
            std::path::Path::new("unused-without-worker"),
            "dev.vibex.rollback",
            &[],
            Arc::new(plugins::DenyCapabilityBroker),
        )
        .await
        .unwrap();

    assert_eq!(restored.version, "1.0.0");
    let states: Vec<String> = sqlx::query_scalar(
        "SELECT state FROM plugin_generations_v4 WHERE plugin_id = ? ORDER BY generation_id",
    )
    .bind("dev.vibex.rollback")
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(states.last().map(String::as_str), Some("active"));
}

#[tokio::test]
async fn failed_update_candidate_preserves_published_package_and_generation() {
    let Some(node) = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|directory| directory.join(if cfg!(windows) { "node.exe" } else { "node" }))
            .find(|candidate| candidate.is_file())
    }) else {
        return;
    };
    let pool = pool().await;
    let root = tempfile::tempdir().unwrap();
    write_package_version(root.path(), "1.0.0");
    let control = PluginControlPlane::new(Arc::new(SqlitePluginRegistry::new(pool.clone())));
    let original = PluginPackage::for_test(
        "dev.vibex.atomic-update",
        "Atomic update",
        "1.0.0",
        PluginSourceKind::DeveloperLink,
        root.path(),
    );
    control
        .import(original, ConflictDecision::Reject)
        .await
        .unwrap();
    control
        .set_enabled("dev.vibex.atomic-update", true)
        .await
        .unwrap();

    write_package_version(root.path(), "2.0.0");
    let mut broken = PluginPackage::for_test(
        "dev.vibex.atomic-update",
        "Atomic update",
        "2.0.0",
        PluginSourceKind::DeveloperLink,
        root.path(),
    );
    broken.entrypoints.worker = Some("dist/missing-worker.mjs".to_owned());
    let error = control
        .update_and_activate(&node, broken, &[], Arc::new(plugins::DenyCapabilityBroker))
        .await
        .unwrap_err();
    assert_eq!(error.code(), "worker_entrypoint_missing");

    let current = control
        .plugin("dev.vibex.atomic-update")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.version, "1.0.0");
    assert_eq!(current.activation, plugins::PluginActivation::Enabled);
    let generations: Vec<(String, String)> = sqlx::query_as(
        "SELECT state, p.version
         FROM plugin_generations_v4 g
         JOIN plugin_packages_v4 p ON p.plugin_id = g.plugin_id
            AND p.package_digest = g.package_digest
         WHERE g.plugin_id = ? ORDER BY generation_id",
    )
    .bind("dev.vibex.atomic-update")
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        generations,
        vec![
            ("active".to_owned(), "1.0.0".to_owned()),
            ("failed".to_owned(), "2.0.0".to_owned()),
        ]
    );
}

#[tokio::test]
async fn package_update_invalidates_digest_scoped_grants_and_retains_rollback() {
    let pool = pool().await;
    let root = tempfile::tempdir().unwrap();
    write_package_version(root.path(), "1.0.0");
    let control = PluginControlPlane::new(Arc::new(SqlitePluginRegistry::new(pool.clone())));
    let mut first_package = PluginPackage::for_test(
        "dev.vibex.scoped",
        "Scoped",
        "1.0.0",
        PluginSourceKind::Snapshot,
        root.path(),
    );
    first_package.permissions.push(CapabilityRequest {
        id: "run-tool".to_owned(),
        capability: "runtime.execute".to_owned(),
        scope: serde_json::json!({"runtime":"tool","operations":["inspect"]}),
        reason: "Run the locked tool".to_owned(),
        optional: false,
        trust_tier: "trusted_native".to_owned(),
    });
    control
        .import(first_package, ConflictDecision::Reject)
        .await
        .unwrap();
    control
        .grant_declared_permissions("dev.vibex.scoped")
        .await
        .unwrap();
    assert_eq!(
        control
            .capability_grants("dev.vibex.scoped")
            .await
            .unwrap()
            .len(),
        1
    );

    write_package_version(root.path(), "2.0.0");
    control
        .import(
            PluginPackage::for_test(
                "dev.vibex.scoped",
                "Scoped",
                "2.0.0",
                PluginSourceKind::Snapshot,
                root.path(),
            ),
            ConflictDecision::Replace,
        )
        .await
        .unwrap();

    assert!(
        control
            .capability_grants("dev.vibex.scoped")
            .await
            .unwrap()
            .is_empty()
    );
    let rollback: Option<String> = sqlx::query_scalar(
        "SELECT rollback_package_digest FROM plugin_installations_v4 WHERE plugin_id = ?",
    )
    .bind("dev.vibex.scoped")
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(rollback.is_some());
}

#[tokio::test]
async fn v4_migration_backfills_an_existing_control_plane_installation() {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(":memory:")
                .foreign_keys(true),
        )
        .await
        .unwrap();
    sqlx::raw_sql(include_str!(
        "../../db/migrations/20260811010000_plugin_control_plane.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../db/migrations/20260811011000_plugin_runtime_evidence.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    let root = tempfile::tempdir().unwrap();
    let package = PluginPackage::for_test(
        "dev.vibex.legacy",
        "Legacy",
        "1.0.0",
        PluginSourceKind::Snapshot,
        root.path(),
    );
    let package_json = serde_json::to_string(&package).unwrap();
    sqlx::query(
        "INSERT INTO plugin_control_registry VALUES (?, ?, ?, 'snapshot', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
    )
    .bind(package.id.as_str())
    .bind(&package.name)
    .bind(&package.version)
    .bind(package.source.path.to_string_lossy().as_ref())
    .bind(package_json)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO plugin_control_activation VALUES (?, 1, CURRENT_TIMESTAMP)")
        .bind(package.id.as_str())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO plugin_control_shell_trust VALUES (?, CURRENT_TIMESTAMP)")
        .bind(package.id.as_str())
        .execute(&pool)
        .await
        .unwrap();

    sqlx::raw_sql(include_str!(
        "../../db/migrations/20260813010000_plugin_platform_v4.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();

    let restored = PluginControlPlane::new(Arc::new(SqlitePluginRegistry::new(pool.clone())))
        .plugin("dev.vibex.legacy")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(restored.activation, plugins::PluginActivation::Enabled);
    let audit: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM plugin_audit_v4 WHERE plugin_id = ? AND event = 'legacy_shell_trust_observed'",
    )
    .bind("dev.vibex.legacy")
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audit, 1);
}

#[tokio::test]
async fn catalog_and_activation_survive_control_plane_restart() {
    let pool = pool().await;
    let root = tempfile::tempdir().unwrap();
    let first = PluginControlPlane::new(Arc::new(SqlitePluginRegistry::new(pool.clone())));
    first
        .import(
            PluginPackage::for_test(
                "dev.vibex.persisted",
                "Persisted",
                "1.0.0",
                PluginSourceKind::Snapshot,
                root.path(),
            ),
            ConflictDecision::Reject,
        )
        .await
        .expect("import plugin");
    first
        .set_enabled("dev.vibex.persisted", true)
        .await
        .expect("enable plugin");
    drop(first);

    let restarted = PluginControlPlane::new(Arc::new(SqlitePluginRegistry::new(pool.clone())));
    let catalog = restarted.catalog().await.expect("restored catalog");

    assert_eq!(catalog.len(), 1);
    assert_eq!(catalog[0].id(), "dev.vibex.persisted");
    assert_eq!(catalog[0].activation, plugins::PluginActivation::Enabled);
    let generation: (String, i64) = sqlx::query_as(
        "SELECT state, COUNT(*) FROM plugin_generations_v4
         WHERE plugin_id = ? GROUP BY state",
    )
    .bind("dev.vibex.persisted")
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(generation, ("active".to_owned(), 1));
    let contributions: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM plugin_contributions_v4 WHERE plugin_id = ?")
            .bind("dev.vibex.persisted")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(contributions, 1);
}
