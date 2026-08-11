use std::sync::Arc;

use plugins::{
    ConflictDecision, PluginControlPlane, PluginPackage, PluginSourceKind, SqlitePluginRegistry,
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
    pool
}

#[tokio::test]
async fn catalog_and_trust_survive_control_plane_restart() {
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
        .grant_shell_trust("dev.vibex.persisted")
        .await
        .expect("grant trust");
    first
        .set_enabled("dev.vibex.persisted", true)
        .await
        .expect("enable plugin");
    drop(first);

    let restarted = PluginControlPlane::new(Arc::new(SqlitePluginRegistry::new(pool)));
    let catalog = restarted.catalog().await.expect("restored catalog");

    assert_eq!(catalog.len(), 1);
    assert_eq!(catalog[0].id(), "dev.vibex.persisted");
    assert!(catalog[0].shell_trusted);
    assert_eq!(catalog[0].activation, plugins::PluginActivation::Enabled);
}
