use api_types::{AgentLifecycleState, AgentSource};
use db::models::agent_management::{AgentMembershipRepository, NewAgentMembership};
use services::services::agent_management::AgentManagementApplicationService;
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use uuid::Uuid;

async fn migrated_pool() -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(":memory:")
                .create_if_missing(true),
        )
        .await
        .unwrap();
    sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
    pool
}

async fn seed_ready_agent_with_unreadable_component(pool: &SqlitePool) {
    let agent_id = api_types::AgentId::parse("fixture.snapshot").unwrap();
    AgentMembershipRepository::new(pool.clone())
        .add(NewAgentMembership {
            agent_id: agent_id.clone(),
            source: AgentSource::OfficialRegistry,
            built_in: false,
            retired: false,
            enabled: true,
            position: 0,
            retained_metadata_json: Some(
                serde_json::json!({
                    "name": "Snapshot Fixture",
                    "description": "Persisted management projection"
                })
                .to_string(),
            ),
            retained_icon_svg: None,
        })
        .await
        .unwrap();

    let lock_id = Uuid::new_v4().to_string();
    sqlx::query(
        r#"INSERT INTO agent_install_lock
           (id, agent_id, registry_version, platform, distribution_kind,
            resolved_json, created_at)
           VALUES (?, ?, '1.0.0', 'fixture', 'binary', ?, 'now')"#,
    )
    .bind(&lock_id)
    .bind(agent_id.as_str())
    .bind(
        serde_json::json!({
            "runtime_version": "1.0.0",
            "acp_version": "1.0.0"
        })
        .to_string(),
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO agent_installation
           (agent_id, ownership, lifecycle, current_lock_id, rollback_lock_id,
            active_operation, active_operation_id, updated_at)
           VALUES (?, 'managed', 'ready', ?, NULL, NULL, NULL, 'now')"#,
    )
    .bind(agent_id.as_str())
    .bind(&lock_id)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO agent_install_component
           (id, lock_id, component_kind, absolute_path, version, sha256,
            trust_state, ownership, shared_resource_key)
           VALUES (?, ?, 'combined_runtime', ?, '1.0.0', ?, 'verified',
                   'managed', NULL)"#,
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&lock_id)
    .bind("/fixture/component-must-not-be-read-by-snapshot")
    .bind("00".repeat(32))
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO agent_probe
           (agent_id, lifecycle, authentication, detail_json, probed_at,
            runtime_available, acp_handshake, authentication_required,
            observation_generation)
           VALUES (?, 'ready', 'not_required', '{}', 'now', 1, 1, 0, 1)"#,
    )
    .bind(agent_id.as_str())
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn agent_management_list_reads_persisted_projection_without_disk_probe() {
    let pool = migrated_pool().await;
    seed_ready_agent_with_unreadable_component(&pool).await;

    let views = AgentManagementApplicationService::new(pool)
        .list()
        .await
        .unwrap();

    assert_eq!(views.len(), 1);
    assert_eq!(views[0].lifecycle, AgentLifecycleState::Ready);
}

#[tokio::test]
async fn component_integrity_refresh_marks_the_next_snapshot_as_needing_repair() {
    let pool = migrated_pool().await;
    seed_ready_agent_with_unreadable_component(&pool).await;
    let service = AgentManagementApplicationService::new(pool);

    service.refresh_component_integrity().await.unwrap();
    let views = service.list().await.unwrap();

    assert_eq!(views[0].lifecycle, AgentLifecycleState::NeedsRepair);
}
