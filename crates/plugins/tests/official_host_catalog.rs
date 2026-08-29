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
