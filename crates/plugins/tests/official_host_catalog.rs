use std::sync::Arc;

use plugins::{PluginActivation, PluginControlPlane, PluginSourceKind, SqlitePluginRegistry};
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
async fn installing_the_host_registers_official_plugins_in_the_catalog() {
    let data = tempfile::tempdir().unwrap();
    let plane = PluginControlPlane::new(Arc::new(SqlitePluginRegistry::new(registry_pool().await)));

    plane
        .install_bundled_official_plugins(data.path(), None)
        .await
        .unwrap();

    let catalog = plane.catalog().await.unwrap();
    let mut ids = catalog
        .iter()
        .map(|plugin| plugin.id().to_owned())
        .collect::<Vec<_>>();
    ids.sort();
    assert_eq!(
        ids,
        [
            "vibex.multi-agent",
            "vibex.office",
            "vibex.plugin-development",
            "vibex.session-enhance",
            "vibex.workflow-creator",
        ]
    );
    for plugin in catalog {
        assert_eq!(plugin.activation, PluginActivation::Disabled);
        assert_eq!(plugin.source.kind, PluginSourceKind::Builtin);
    }
}

#[tokio::test]
async fn already_materialized_official_plugins_are_registered_when_the_catalog_is_empty() {
    let data = tempfile::tempdir().unwrap();
    let roots = utils::assets::materialize_builtin_plugins(data.path()).unwrap();
    assert_eq!(roots.len(), 5);

    let plane = PluginControlPlane::new(Arc::new(SqlitePluginRegistry::new(registry_pool().await)));
    plane.reconcile_bundled_plugins(&roots, None).await.unwrap();

    let mut ids = plane
        .catalog()
        .await
        .unwrap()
        .iter()
        .map(|plugin| plugin.id().to_owned())
        .collect::<Vec<_>>();
    ids.sort();
    assert_eq!(ids.len(), 5);
    assert!(ids.contains(&"vibex.session-enhance".to_owned()));
}
