use std::sync::Arc;

use plugins::{
    ConflictDecision, PluginActivation, PluginControlPlane, PluginPackage, PluginSourceKind,
    SqlitePluginRegistry,
};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

async fn registry_pool() -> sqlx::SqlitePool {
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
        "../../db/migrations/20260814010000_plugin_platform_v4.sql"
    ))
    .execute(&pool)
    .await
    .expect("plugin platform v4 schema");
    pool
}

#[tokio::test]
async fn installing_the_host_does_not_auto_register_official_plugins() {
    let data = tempfile::tempdir().unwrap();
    let plane = PluginControlPlane::new(Arc::new(SqlitePluginRegistry::new(registry_pool().await)));

    plane
        .install_bundled_official_plugins(data.path(), None)
        .await
        .unwrap();

    let catalog = plane.catalog().await.unwrap();
    assert!(catalog.is_empty());
    assert!(utils::assets::existing_official_plugin_roots(data.path()).is_empty());
}

fn write_official_package(root: &std::path::Path) {
    let skill = root.join("contents/skills/remote/SKILL.md");
    std::fs::create_dir_all(skill.parent().unwrap()).unwrap();
    std::fs::create_dir_all(root.join(".vibex-plugin")).unwrap();
    std::fs::create_dir_all(root.join("dist")).unwrap();
    std::fs::write(
        root.join(".vibex-plugin/plugin.json"),
        r#"{
          "manifestVersion":4,"apiVersion":"2.0",
          "id":"vibex.remote-ssh","publisher":"vibex","name":"Remote SSH","version":"2.0.0",
          "readme":"README.md",
          "content":{"root":"contents","index":".vibex-plugin/content.index.json"},
          "config":{"schema":{"type":"object","properties":{},"additionalProperties":false}},
          "engines":{"vibex":">=0.1.3","pluginSdk":"^2.0.0"},
          "integrations":[{"id":"remote","kind":"content.skill","resource":"contents/skills/remote"}]
        }"#,
    )
    .unwrap();
    std::fs::write(
        root.join(".vibex-plugin/content.index.json"),
        r#"{"schemaVersion":1,"items":[{"path":"contents/skills/remote/SKILL.md","kind":"skill","title":"Remote"}]}"#,
    )
    .unwrap();
    std::fs::write(
        root.join("README.md"),
        "---\nsummary: Connect this machine to a remote Host.\n---\n# Remote SSH\n",
    )
    .unwrap();
    std::fs::write(root.join("config.json"), "{}\n").unwrap();
    std::fs::write(
        &skill,
        "---\nname: remote\ndescription: Connect over SSH.\n---\n# Remote\n",
    )
    .unwrap();
    std::fs::write(root.join("dist/worker.mjs"), "// worker\n").unwrap();
}

#[tokio::test]
async fn builtin_memberships_become_uninstallable_marketplace_origins() {
    let sample_dir = tempfile::tempdir().unwrap();
    write_official_package(sample_dir.path());
    let roots = vec![sample_dir.path().to_path_buf()];
    let plane = PluginControlPlane::new(Arc::new(SqlitePluginRegistry::new(registry_pool().await)));
    let package = PluginPackage::inspect(&roots[0], PluginSourceKind::Builtin).unwrap();
    plane
        .import(package.clone(), ConflictDecision::Reject)
        .await
        .unwrap();
    plane.migrate_builtin_memberships(&roots).await.unwrap();
    let installed = plane.plugin(package.id.as_str()).await.unwrap().unwrap();
    assert_eq!(installed.source.kind, PluginSourceKind::Marketplace);
    assert_eq!(installed.activation, PluginActivation::Disabled);
    assert!(
        installed
            .source
            .origin
            .as_deref()
            .unwrap()
            .contains("marketplace")
    );
    plane.uninstall(installed.id()).await.unwrap();
    assert!(plane.plugin(package.id.as_str()).await.unwrap().is_none());
}

#[tokio::test]
async fn installed_official_plugin_picks_up_a_newer_package_on_disk() {
    let data = tempfile::tempdir().unwrap();
    let remote = data.path().join("remote-ssh");
    write_official_package(&remote);
    let plane = PluginControlPlane::new(Arc::new(SqlitePluginRegistry::new(registry_pool().await)));
    let package = PluginPackage::inspect(&remote, PluginSourceKind::Marketplace).unwrap();
    plane
        .import(package, ConflictDecision::Reject)
        .await
        .unwrap();
    let before = plane.plugin("vibex.remote-ssh").await.unwrap().unwrap();
    let worker = remote.join("dist/worker.mjs");
    let mut source = std::fs::read_to_string(&worker).unwrap();
    source.push_str("\n// host-package-refresh\n");
    std::fs::write(&worker, source).unwrap();

    plane
        .refresh_installed_bundled_plugins(std::slice::from_ref(&remote), None)
        .await
        .unwrap();
    let after = plane.plugin("vibex.remote-ssh").await.unwrap().unwrap();
    assert_ne!(before.package_digest, after.package_digest);
    assert!(
        std::fs::read_to_string(after.source.path.join("dist/worker.mjs"))
            .unwrap()
            .contains("host-package-refresh")
    );
}

#[tokio::test]
async fn bundled_refresh_does_not_replace_a_developer_link() {
    let data = tempfile::tempdir().unwrap();
    let remote = data.path().join("remote-ssh");
    write_official_package(&remote);
    let linked_root = tempfile::tempdir().unwrap();
    copy_dir(&remote, linked_root.path());
    let plane = PluginControlPlane::new(Arc::new(SqlitePluginRegistry::new(registry_pool().await)));
    let package =
        PluginPackage::inspect(linked_root.path(), PluginSourceKind::DeveloperLink).unwrap();
    plane
        .import(package, ConflictDecision::Reject)
        .await
        .unwrap();
    std::fs::write(remote.join("dist/worker.mjs"), "// bundled replacement\n").unwrap();
    plane
        .refresh_installed_bundled_plugins(std::slice::from_ref(&remote), None)
        .await
        .unwrap();
    let kept = plane.plugin("vibex.remote-ssh").await.unwrap().unwrap();
    assert_eq!(kept.source.kind, PluginSourceKind::DeveloperLink);
    assert_eq!(kept.source.path, linked_root.path().canonicalize().unwrap());
}

fn copy_dir(from: &std::path::Path, to: &std::path::Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}
