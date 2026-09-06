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
    assert!(
        !utils::assets::materialize_builtin_plugins(data.path())
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn builtin_memberships_become_uninstallable_marketplace_origins() {
    let data = tempfile::tempdir().unwrap();
    let roots = utils::assets::materialize_builtin_plugins(data.path()).unwrap();
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
async fn installed_official_plugin_picks_up_a_newer_host_package() {
    let data = tempfile::tempdir().unwrap();
    let roots = utils::assets::materialize_builtin_plugins(data.path()).unwrap();
    let remote = roots
        .iter()
        .find(|root| {
            PluginPackage::inspect(root, PluginSourceKind::Builtin)
                .ok()
                .is_some_and(|package| package.id.as_str() == "vibex.remote-ssh")
        })
        .expect("remote-ssh is bundled");
    let plane = PluginControlPlane::new(Arc::new(SqlitePluginRegistry::new(registry_pool().await)));
    let package = PluginPackage::inspect(remote, PluginSourceKind::Marketplace).unwrap();
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
        .refresh_installed_bundled_plugins(std::slice::from_ref(remote), None)
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
    let roots = utils::assets::materialize_builtin_plugins(data.path()).unwrap();
    let remote = roots
        .iter()
        .find(|root| {
            PluginPackage::inspect(root, PluginSourceKind::Builtin)
                .ok()
                .is_some_and(|package| package.id.as_str() == "vibex.remote-ssh")
        })
        .expect("remote-ssh is bundled");
    let linked_root = tempfile::tempdir().unwrap();
    copy_dir(remote, linked_root.path());
    let plane = PluginControlPlane::new(Arc::new(SqlitePluginRegistry::new(registry_pool().await)));
    let package =
        PluginPackage::inspect(linked_root.path(), PluginSourceKind::DeveloperLink).unwrap();
    plane
        .import(package, ConflictDecision::Reject)
        .await
        .unwrap();
    std::fs::write(remote.join("dist/worker.mjs"), "// bundled replacement\n").unwrap();
    plane
        .refresh_installed_bundled_plugins(std::slice::from_ref(remote), None)
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
