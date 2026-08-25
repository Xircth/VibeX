use agents::RegistryCacheFreshness;
use api_types::{
    AgentId, AgentLifecycleState, AgentSettingsFeature, AgentSource, UserAgentDefinitionRequest,
    UserAgentDistributionKind, UserAgentIntegrityKind,
};
use db::models::agent_management::{
    AgentMembershipRepository, NewAgentMembership, RegistryEntryRecord, RegistrySnapshotRecord,
    RegistrySnapshotRepository,
};
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
async fn registry_view_treats_verified_runtime_and_acp_as_installed_even_when_not_logged_in() {
    let pool = migrated_pool().await;
    let ready_id = AgentId::parse("fixture.ready").unwrap();
    let needs_auth_id = AgentId::parse("fixture.needs-auth").unwrap();
    let catalog_only_id = AgentId::parse("fixture.catalog-only").unwrap();
    seed_installed_agent(&pool, &ready_id, "ready", "not_required", false).await;
    seed_installed_agent(&pool, &needs_auth_id, "needs_auth", "not_logged_in", true).await;
    seed_registry_snapshot(
        &pool,
        &[
            (&ready_id, "Ready Fixture"),
            (&needs_auth_id, "Needs Auth Fixture"),
            (&catalog_only_id, "Catalog Only Fixture"),
        ],
    )
    .await;

    let view = AgentManagementApplicationService::new(pool)
        .registry_view(RegistryCacheFreshness::Fresh, None)
        .await
        .unwrap();

    let installed_ids = view
        .installed
        .iter()
        .map(|row| row.agent_id.clone())
        .collect::<Vec<_>>();
    let uninstalled_ids = view
        .uninstalled
        .iter()
        .map(|row| row.agent_id.clone())
        .collect::<Vec<_>>();
    assert!(installed_ids.contains(&ready_id));
    assert!(installed_ids.contains(&needs_auth_id));
    assert!(!uninstalled_ids.contains(&needs_auth_id));
    assert!(uninstalled_ids.contains(&catalog_only_id));
    assert!(
        view.installed
            .iter()
            .find(|row| row.agent_id == needs_auth_id)
            .is_some_and(|row| row.installed)
    );
}

async fn seed_installed_agent(
    pool: &SqlitePool,
    agent_id: &AgentId,
    lifecycle: &str,
    authentication: &str,
    authentication_required: bool,
) {
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
                    "name": agent_id.as_str(),
                    "description": "Registry projection fixture"
                })
                .to_string(),
            ),
            retained_icon_svg: None,
        })
        .await
        .unwrap();

    let lock_id = format!("lock-{}", agent_id.as_str());
    sqlx::query(
        r#"INSERT INTO agent_install_lock
           (id, agent_id, registry_version, platform, distribution_kind,
            resolved_json, created_at)
           VALUES (?, ?, '1.0.0', 'fixture', 'npx', ?, 'now')"#,
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
           VALUES (?, 'external', ?, ?, NULL, NULL, NULL, 'now')"#,
    )
    .bind(agent_id.as_str())
    .bind(lifecycle)
    .bind(&lock_id)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO agent_install_component
           (id, lock_id, component_kind, absolute_path, version, sha256,
            trust_state, ownership, shared_resource_key)
           VALUES (?, ?, 'combined_runtime', ?, '1.0.0', ?, 'verified',
                   'external', NULL)"#,
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&lock_id)
    .bind(format!("/fixture/{}", agent_id.as_str()))
    .bind("00".repeat(32))
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO agent_probe
           (agent_id, lifecycle, authentication, detail_json, probed_at,
            runtime_available, acp_handshake, authentication_required,
            observation_generation)
           VALUES (?, ?, ?, '{}', 'now', 1, 1, ?, 1)"#,
    )
    .bind(agent_id.as_str())
    .bind(lifecycle)
    .bind(authentication)
    .bind(authentication_required)
    .execute(pool)
    .await
    .unwrap();
}

async fn seed_registry_snapshot(pool: &SqlitePool, entries: &[(&AgentId, &str)]) {
    RegistrySnapshotRepository::new(pool.clone())
        .replace(
            &RegistrySnapshotRecord {
                id: Uuid::new_v4(),
                source_url: "https://registry.example.test/registry.json".to_string(),
                fetched_at: "2026-08-24T08:00:00Z".to_string(),
                schema_version: "1".to_string(),
                document_json: "{}".to_string(),
                document_sha256: "fixture".to_string(),
                etag: None,
            },
            &entries
                .iter()
                .map(|(agent_id, name)| RegistryEntryRecord {
                    agent_id: (*agent_id).clone(),
                    registry_id: agent_id.as_str().to_string(),
                    version: "1.0.0".to_string(),
                    sort_name: (*name).to_string(),
                    metadata_json: serde_json::json!({
                        "name": name,
                        "description": "Registry projection fixture",
                        "repository": null,
                        "website": null,
                        "authors": ["Fixture"],
                        "license": null,
                        "icon_url": null
                    })
                    .to_string(),
                    distributions_json: r#"{"npx":{"package":"fixture-agent@1.0.0","args":[]}}"#
                        .to_string(),
                    icon_svg: None,
                })
                .collect::<Vec<_>>(),
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn agent_management_list_merges_an_explicit_registry_binding_into_its_stable_agent() {
    let pool = migrated_pool().await;
    let repository = AgentMembershipRepository::new(pool.clone());
    repository
        .add(NewAgentMembership {
            agent_id: AgentId::parse("grok").unwrap(),
            source: AgentSource::BuiltInProfile,
            built_in: true,
            retired: false,
            enabled: true,
            position: 0,
            retained_metadata_json: None,
            retained_icon_svg: None,
        })
        .await
        .unwrap();
    repository
        .add(NewAgentMembership {
            agent_id: AgentId::parse("grok-build").unwrap(),
            source: AgentSource::OfficialRegistry,
            built_in: false,
            retired: false,
            enabled: true,
            position: 1,
            retained_metadata_json: Some(
                serde_json::json!({
                    "name": "Grok Build",
                    "registry_id": "grok-build"
                })
                .to_string(),
            ),
            retained_icon_svg: None,
        })
        .await
        .unwrap();
    repository
        .add(NewAgentMembership {
            agent_id: AgentId::parse("kimi_code").unwrap(),
            source: AgentSource::BuiltInProfile,
            built_in: true,
            retired: false,
            enabled: true,
            position: 2,
            retained_metadata_json: None,
            retained_icon_svg: None,
        })
        .await
        .unwrap();
    repository
        .add(NewAgentMembership {
            agent_id: AgentId::parse("kimi-code").unwrap(),
            source: AgentSource::OfficialRegistry,
            built_in: false,
            retired: false,
            enabled: true,
            position: 3,
            retained_metadata_json: Some(
                serde_json::json!({
                    "name": "Kimi CLI",
                    "registry_id": "kimi-code"
                })
                .to_string(),
            ),
            retained_icon_svg: None,
        })
        .await
        .unwrap();

    let views = AgentManagementApplicationService::new(pool)
        .list()
        .await
        .unwrap();

    assert_eq!(views.len(), 2);
    assert_eq!(views[0].agent_id, AgentId::parse("grok").unwrap());
    assert_eq!(views[0].display_name, "Grok");
    assert_eq!(views[1].agent_id, AgentId::parse("kimi_code").unwrap());
    assert_eq!(views[1].display_name, "Kimi Code");
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

#[tokio::test]
async fn component_integrity_refresh_does_not_police_user_owned_external_agents() {
    let pool = migrated_pool().await;
    seed_ready_agent_with_unreadable_component(&pool).await;
    sqlx::query(
        "UPDATE agent_installation SET ownership = 'external' WHERE agent_id = 'fixture.snapshot'",
    )
    .execute(&pool)
    .await
    .unwrap();
    let service = AgentManagementApplicationService::new(pool);

    service.refresh_component_integrity().await.unwrap();
    let views = service.list().await.unwrap();

    assert_eq!(views[0].lifecycle, AgentLifecycleState::Ready);
}

#[tokio::test]
async fn user_definition_is_added_without_an_official_registry_snapshot() {
    let pool = migrated_pool().await;
    let service = AgentManagementApplicationService::new(pool);
    let agent_id = AgentId::parse("local-reviewer").unwrap();

    let view = service
        .add_user_definition(UserAgentDefinitionRequest {
            agent_id: agent_id.clone(),
            display_name: "Local Reviewer".to_string(),
            description: "Reviews the workspace".to_string(),
            version: "1.2.3".to_string(),
            distribution_kind: UserAgentDistributionKind::Npx,
            distribution_json: r#"{"npx":{"package":"local-reviewer@1.2.3","args":["--acp"]}}"#
                .to_string(),
            skills_shared_store: true,
            skills_directory: Some("~/.local-reviewer/skills".to_string()),
        })
        .await
        .unwrap();

    assert_eq!(view.agent_id, agent_id);
    assert_eq!(view.source, AgentSource::UserDefinition);
    assert_eq!(view.display_name, "Local Reviewer");
    assert_eq!(view.description, "Reviews the workspace");
    assert_eq!(
        view.settings_features,
        Some(vec![AgentSettingsFeature::NativeSkills])
    );

    let definition = service
        .user_definition_view(&agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        definition.distribution.package.as_deref(),
        Some("local-reviewer@1.2.3")
    );
    assert_eq!(definition.distribution.command, "npx");
    assert_eq!(definition.distribution.args, ["--acp"]);
    assert_eq!(
        definition.distribution.integrity,
        UserAgentIntegrityKind::EcosystemLock
    );
    assert!(!definition.reinstall_required);
    assert!(definition.skills_shared_store);
    assert!(
        definition
            .skills_directory
            .as_deref()
            .is_some_and(|path| path.ends_with("/.local-reviewer/skills"))
    );
}

#[tokio::test]
async fn user_definition_rejects_a_relative_skills_directory() {
    let pool = migrated_pool().await;
    let service = AgentManagementApplicationService::new(pool);

    let error = service
        .add_user_definition(UserAgentDefinitionRequest {
            agent_id: AgentId::parse("relative-skills-agent").unwrap(),
            display_name: "Relative Skills Agent".to_string(),
            description: "Invalid storage fixture".to_string(),
            version: "1.0.0".to_string(),
            distribution_kind: UserAgentDistributionKind::Npx,
            distribution_json:
                r#"{"npx":{"package":"relative-skills-agent@1.0.0","args":["--acp"]}}"#.to_string(),
            skills_shared_store: false,
            skills_directory: Some("relative/skills".to_string()),
        })
        .await
        .unwrap_err();

    assert!(
        error
            .to_string()
            .contains("skills directory must be an absolute path")
    );
}

#[tokio::test]
async fn updating_a_user_definition_preserves_identity_and_marks_an_installed_lock_stale() {
    let pool = migrated_pool().await;
    let service = AgentManagementApplicationService::new(pool.clone());
    let agent_id = AgentId::parse("local-reviewer").unwrap();
    let initial = UserAgentDefinitionRequest {
        agent_id: agent_id.clone(),
        display_name: "Local Reviewer".to_string(),
        description: "Reviews the workspace".to_string(),
        version: "1.2.3".to_string(),
        distribution_kind: UserAgentDistributionKind::Npx,
        distribution_json: r#"{"npx":{"package":"local-reviewer@1.2.3","args":["--acp"]}}"#
            .to_string(),
        skills_shared_store: false,
        skills_directory: None,
    };
    service.add_user_definition(initial).await.unwrap();
    let before = service
        .user_definition_view(&agent_id)
        .await
        .unwrap()
        .unwrap();
    sqlx::query(
        r#"INSERT INTO agent_install_lock
               (id, agent_id, registry_version, platform, distribution_kind,
                resolved_json, created_at)
           VALUES ('lock-local', ?, '1.2.3', 'test', 'npx', ?, CURRENT_TIMESTAMP)"#,
    )
    .bind(agent_id.as_str())
    .bind(
        serde_json::json!({
            "source": {
                "kind": "user_definition",
                "definition_sha256": before.definition_sha256,
            }
        })
        .to_string(),
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO agent_installation
               (agent_id, lifecycle, ownership, current_lock_id, updated_at)
           VALUES (?, 'ready', 'managed', 'lock-local', CURRENT_TIMESTAMP)"#,
    )
    .bind(agent_id.as_str())
    .execute(&pool)
    .await
    .unwrap();

    let updated = service
        .update_user_definition(UserAgentDefinitionRequest {
            agent_id: agent_id.clone(),
            display_name: "Local Reviewer Pro".to_string(),
            description: "Reviews and fixes the workspace".to_string(),
            version: "1.3.0".to_string(),
            distribution_kind: UserAgentDistributionKind::Npx,
            distribution_json:
                r#"{"npx":{"package":"local-reviewer@1.3.0","args":["--acp","--strict"]}}"#
                    .to_string(),
            skills_shared_store: true,
            skills_directory: None,
        })
        .await
        .unwrap();

    assert_eq!(updated.agent_id, agent_id);
    assert_eq!(updated.display_name, "Local Reviewer Pro");
    assert_eq!(updated.distribution.args, ["--acp", "--strict"]);
    assert!(updated.reinstall_required);
    assert!(updated.skills_shared_store);
    assert_eq!(
        updated.installed_definition_sha256,
        Some(before.definition_sha256)
    );
}
