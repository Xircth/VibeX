use api_types::{AgentId, AgentSource};
use db::models::agent_management::{
    AgentMembershipRepository, DiagnosticRecord, DiagnosticRepository, InstallLockRecord,
    InstallationOperationRepository, InstallationRepository, NewAgentMembership,
    NewInstallationOperation, RegistryEntryRecord, RegistrySnapshotRecord,
    RegistrySnapshotRepository, SessionDefaultRecord, SessionDefaultRepository,
    conversation_migration::{
        ConversationAgentReferenceRepository, LegacyConversationAgentMigration,
        RetiredAgentHistoryRepository,
    },
    legacy_migration::LegacyAgentMigration,
};
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};

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
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    pool
}

async fn seed_legacy_settings(pool: &SqlitePool) {
    for (position, agent_id) in [
        "claude_code",
        "codex",
        "opencode",
        "gemini",
        "openclaw",
        "cline",
        "hermes",
    ]
    .into_iter()
    .enumerate()
    {
        sqlx::query(
            r#"INSERT INTO agent_setting (agent_type, enabled, sort_order)
               VALUES (?, 1, ?)
               ON CONFLICT(agent_type) DO UPDATE SET
                   enabled = 1,
                   sort_order = excluded.sort_order,
                   installed_version = NULL,
                   env_json = NULL,
                   config_json = NULL,
                   auto_approve_mode = 'off',
                   runtime_cli_path = NULL,
                   runtime_cli_version = NULL,
                   runtime_cli_revision = NULL,
                   runtime_acp_path = NULL,
                   runtime_acp_version = NULL,
                   runtime_acp_revision = NULL"#,
        )
        .bind(agent_id)
        .bind(position as i64)
        .execute(pool)
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn agent_management_migration_fixtures_recover_old_operations_without_replay() {
    let pool = migrated_pool().await;
    let memberships = AgentMembershipRepository::new(pool.clone());
    let agent_id = AgentId::parse("fixture.binary").unwrap();
    memberships
        .add(NewAgentMembership {
            agent_id: agent_id.clone(),
            source: AgentSource::OfficialRegistry,
            built_in: false,
            retired: false,
            enabled: true,
            position: 0,
            retained_metadata_json: None,
            retained_icon_svg: None,
        })
        .await
        .unwrap();

    let operations = InstallationOperationRepository::new(pool.clone());
    let queued = operations
        .enqueue(NewInstallationOperation {
            agent_id: agent_id.clone(),
            kind: "repair".to_string(),
            frozen_plan_json: r#"{"version":"1.0.0","distribution":"binary"}"#.to_string(),
            host_instance_id: "old-host".to_string(),
            resource_claims: vec!["shim:fixture.binary".to_string()],
            staging_path: Some("/fixture/.staging-old".to_string()),
        })
        .await
        .unwrap();
    operations
        .mark_running(queued.id, "old-host")
        .await
        .unwrap();

    let recovered = operations.recover_interrupted("new-host").await.unwrap();
    assert_eq!(recovered, vec![queued.id]);
    let persisted = operations.find(queued.id).await.unwrap().unwrap();
    assert_eq!(persisted.status, "interrupted");
    assert_eq!(
        persisted.frozen_plan_json,
        r#"{"version":"1.0.0","distribution":"binary"}"#
    );
    assert!(
        operations
            .active_for_agent(&agent_id)
            .await
            .unwrap()
            .is_none()
    );

    let retry = operations
        .enqueue(NewInstallationOperation {
            agent_id,
            kind: "repair".to_string(),
            frozen_plan_json: persisted.frozen_plan_json,
            host_instance_id: "new-host".to_string(),
            resource_claims: vec!["shim:fixture.binary".to_string()],
            staging_path: None,
        })
        .await
        .unwrap();
    assert_ne!(retry.id, queued.id);
}

#[tokio::test]
async fn agent_probe_business_facts_have_typed_columns() {
    let pool = migrated_pool().await;
    let agent_id = AgentId::parse("fixture.typed-probe").unwrap();
    AgentMembershipRepository::new(pool.clone())
        .add(NewAgentMembership {
            agent_id: agent_id.clone(),
            source: AgentSource::OfficialRegistry,
            built_in: false,
            retired: false,
            enabled: true,
            position: 0,
            retained_metadata_json: None,
            retained_icon_svg: None,
        })
        .await
        .unwrap();
    sqlx::query(
        r#"INSERT INTO agent_probe
           (agent_id, lifecycle, authentication, detail_json, probed_at,
            runtime_available, acp_handshake, authentication_required)
           VALUES (?, 'needs_auth', 'not_logged_in',
                   '{}', 'now', 1, 0, 1)"#,
    )
    .bind(agent_id.as_str())
    .execute(&pool)
    .await
    .unwrap();

    let facts = sqlx::query_as::<_, (bool, bool, bool, i64)>(
        r#"SELECT runtime_available, acp_handshake, authentication_required,
                  observation_generation
           FROM agent_probe WHERE agent_id = ?"#,
    )
    .bind(agent_id.as_str())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(facts, (true, false, true, 0));
}

#[tokio::test]
async fn legacy_agent_probe_json_is_imported_once_into_typed_facts() {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(":memory:")
                .create_if_missing(true),
        )
        .await
        .unwrap();
    sqlx::query(
        r#"CREATE TABLE agent_probe (
               agent_id TEXT PRIMARY KEY NOT NULL,
               lifecycle TEXT NOT NULL,
               authentication TEXT NOT NULL,
               detail_json TEXT NOT NULL,
               probed_at TEXT NOT NULL
           )"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO agent_probe VALUES (
               'fixture.legacy-probe',
               'needs_auth',
               'not_logged_in',
               '{"runtime_available":true,"acp_handshake":false,"authentication_required":true}',
               'now'
           )"#,
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::raw_sql(include_str!(
        "../migrations/20260730020000_type_agent_probe_facts.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../migrations/20260730030000_agent_probe_observation_generation.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();

    let facts = sqlx::query_as::<_, (bool, bool, bool, i64)>(
        r#"SELECT runtime_available, acp_handshake, authentication_required,
                  observation_generation
           FROM agent_probe WHERE agent_id = 'fixture.legacy-probe'"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(facts, (true, false, true, 1));
}

#[tokio::test]
async fn membership_repository_persists_open_id_and_position() {
    let pool = migrated_pool().await;
    let repository = AgentMembershipRepository::new(pool.clone());
    let generic = AgentId::parse("vendor.agent-v2").unwrap();
    let codex = AgentId::parse("codex").unwrap();

    repository
        .add(NewAgentMembership {
            agent_id: generic.clone(),
            source: AgentSource::OfficialRegistry,
            built_in: false,
            retired: false,
            enabled: true,
            position: 4,
            retained_metadata_json: Some(r#"{"name":"Vendor Agent"}"#.to_string()),
            retained_icon_svg: None,
        })
        .await
        .unwrap();
    repository
        .add(NewAgentMembership {
            agent_id: codex.clone(),
            source: AgentSource::BuiltInProfile,
            built_in: true,
            retired: false,
            enabled: false,
            position: 0,
            retained_metadata_json: None,
            retained_icon_svg: None,
        })
        .await
        .unwrap();

    repository
        .reorder(&[generic.clone(), codex.clone()])
        .await
        .unwrap();

    let memberships = repository.list().await.unwrap();
    assert_eq!(
        memberships
            .iter()
            .map(|membership| (membership.agent_id.as_str(), membership.position))
            .collect::<Vec<_>>(),
        [("vendor.agent-v2", 0), ("codex", 1)]
    );
    assert_eq!(memberships[0].source, AgentSource::OfficialRegistry);
    assert!(!memberships[1].enabled);
}

#[tokio::test]
async fn management_repositories_keep_atomic_snapshot_lock_and_retention_invariants() {
    let pool = migrated_pool().await;
    let membership = AgentMembershipRepository::new(pool.clone());
    let agent_id = AgentId::parse("vendor.agent-v2").unwrap();
    membership
        .add(NewAgentMembership {
            agent_id: agent_id.clone(),
            source: AgentSource::OfficialRegistry,
            built_in: false,
            retired: false,
            enabled: true,
            position: 0,
            retained_metadata_json: None,
            retained_icon_svg: None,
        })
        .await
        .unwrap();

    let snapshots = RegistrySnapshotRepository::new(pool.clone());
    let first_snapshot = RegistrySnapshotRecord {
        id: uuid::Uuid::new_v4(),
        source_url: "https://registry.example.test/registry.json".to_string(),
        fetched_at: "2026-07-29T08:00:00Z".to_string(),
        schema_version: "1".to_string(),
        document_json: "{}".to_string(),
        document_sha256: "first".to_string(),
        etag: None,
    };
    snapshots
        .replace(
            &first_snapshot,
            &[RegistryEntryRecord {
                agent_id: agent_id.clone(),
                registry_id: "vendor-agent".to_string(),
                version: "1.0.0".to_string(),
                sort_name: "Vendor Agent".to_string(),
                metadata_json: "{}".to_string(),
                distributions_json: "[]".to_string(),
                icon_svg: None,
            }],
        )
        .await
        .unwrap();
    let (persisted_first, persisted_entries) = snapshots
        .current()
        .await
        .unwrap()
        .expect("current snapshot");
    assert_eq!(persisted_first.id, first_snapshot.id);
    assert_eq!(persisted_entries.len(), 1);
    assert_eq!(persisted_entries[0].agent_id, agent_id);

    let second_snapshot = RegistrySnapshotRecord {
        id: uuid::Uuid::new_v4(),
        document_sha256: "second".to_string(),
        ..first_snapshot.clone()
    };
    snapshots.replace(&second_snapshot, &[]).await.unwrap();
    let (persisted_second, persisted_entries) = snapshots
        .current()
        .await
        .unwrap()
        .expect("current snapshot");
    assert_eq!(persisted_second.id, second_snapshot.id);
    assert!(persisted_entries.is_empty());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM agent_registry_entry")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );

    let installations = InstallationRepository::new(pool.clone());
    let first_lock = InstallLockRecord {
        id: uuid::Uuid::new_v4(),
        agent_id: agent_id.clone(),
        registry_version: "1.0.0".to_string(),
        platform: "aarch64-apple-darwin".to_string(),
        distribution_kind: "binary".to_string(),
        resolved_json: "{}".to_string(),
        created_at: "2026-07-29T08:00:00Z".to_string(),
    };
    installations
        .set_current_lock(&first_lock, "managed", "ready")
        .await
        .unwrap();
    let second_lock = InstallLockRecord {
        id: uuid::Uuid::new_v4(),
        registry_version: "1.1.0".to_string(),
        created_at: "2026-07-29T09:00:00Z".to_string(),
        ..first_lock.clone()
    };
    installations
        .set_current_lock(&second_lock, "managed", "ready")
        .await
        .unwrap();
    let rollback: Option<String> =
        sqlx::query_scalar("SELECT rollback_lock_id FROM agent_installation WHERE agent_id = ?")
            .bind(agent_id.as_str())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(rollback, Some(first_lock.id.to_string()));

    let diagnostics = DiagnosticRepository::new(pool.clone());
    for index in 0..25 {
        diagnostics
            .append_bounded(&DiagnosticRecord {
                id: uuid::Uuid::new_v4(),
                agent_id: agent_id.clone(),
                operation_kind: "install".to_string(),
                severity: "info".to_string(),
                message: format!("diagnostic-{index}"),
                redacted_output: None,
                created_at: format!("2026-07-29T10:{index:02}:00Z"),
            })
            .await
            .unwrap();
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM agent_diagnostic WHERE agent_id = ?",)
            .bind(agent_id.as_str())
            .fetch_one(&pool)
            .await
            .unwrap(),
        20
    );

    SessionDefaultRepository::new(pool.clone())
        .replace_for_agent(
            &agent_id,
            &[SessionDefaultRecord {
                option_id: "model".to_string(),
                value_json: r#""fixture-model""#.to_string(),
                updated_at: "2026-07-29T11:00:00Z".to_string(),
            }],
        )
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT value_json FROM agent_session_default WHERE agent_id = ? AND option_id = 'model'",
        )
        .bind(agent_id.as_str())
        .fetch_one(&pool)
        .await
        .unwrap(),
        r#""fixture-model""#
    );
}

#[tokio::test]
async fn migrates_only_agents_with_actual_use_evidence() {
    let pool = migrated_pool().await;
    seed_legacy_settings(&pool).await;
    sqlx::query(
        "UPDATE agent_setting SET enabled = 0, config_json = '{\"apiKey\":\"configured\"}' WHERE agent_type = 'gemini'",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"UPDATE agent_setting SET
               runtime_cli_path = '/fixture/cline',
               runtime_cli_version = '3.0.9',
               runtime_cli_revision = 'cli-revision',
               runtime_acp_path = '/fixture/cline-acp',
               runtime_acp_version = '3.0.9',
               runtime_acp_revision = 'acp-revision'
           WHERE agent_type = 'cline'"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE agent_setting SET enabled = 0 WHERE agent_type = 'codex'")
        .execute(&pool)
        .await
        .unwrap();

    LegacyAgentMigration::run(&pool).await.unwrap();

    let memberships = AgentMembershipRepository::new(pool.clone())
        .list()
        .await
        .unwrap();
    assert_eq!(
        memberships
            .iter()
            .map(|row| (row.agent_id.as_str(), row.enabled))
            .collect::<Vec<_>>(),
        [
            ("claude_code", true),
            ("codex", false),
            ("opencode", true),
            ("gemini", false),
            ("cline", true),
            ("pi", true),
        ]
    );
    assert!(
        memberships
            .iter()
            .find(|row| row.agent_id.as_str() == "gemini")
            .is_some_and(|row| row.source == AgentSource::OfficialRegistry)
    );
    assert!(
        !memberships
            .iter()
            .any(|row| { matches!(row.agent_id.as_str(), "openclaw" | "hermes") })
    );

    // The completion marker makes the migration one-shot even if old rows
    // change later.
    sqlx::query("UPDATE agent_setting SET config_json = '{}' WHERE agent_type = 'gemini'")
        .execute(&pool)
        .await
        .unwrap();
    LegacyAgentMigration::run(&pool).await.unwrap();
    assert!(
        AgentMembershipRepository::new(pool.clone())
            .find(&AgentId::parse("gemini").unwrap())
            .await
            .unwrap()
            .is_some()
    );

    let history_pool = migrated_pool().await;
    seed_legacy_settings(&history_pool).await;
    // A fresh database has no Session row, so create the smallest valid legacy
    // history binding through the already-migrated conversation tables.
    let session_id = uuid::Uuid::new_v4();
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&history_pool)
        .await
        .unwrap();
    sqlx::query(
        r#"INSERT INTO sessions (id, workspace_id, executor, status, agent_type)
           VALUES (?, ?, 'CLINE', 'done', 'cline')"#,
    )
    .bind(session_id)
    .bind(uuid::Uuid::new_v4())
    .execute(&history_pool)
    .await
    .unwrap();
    LegacyAgentMigration::run(&history_pool).await.unwrap();
    assert!(
        AgentMembershipRepository::new(history_pool)
            .find(&AgentId::parse("cline").unwrap())
            .await
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn retired_agent_history_is_read_only_but_retrievable() {
    let pool = migrated_pool().await;
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&pool)
        .await
        .unwrap();
    for agent_id in ["openclaw", "hermes", "vendor.agent-v2"] {
        sqlx::query(
            r#"INSERT INTO sessions
               (id, workspace_id, executor, status, agent_type, external_session_id)
               VALUES (?, ?, ?, 'done', ?, ?)"#,
        )
        .bind(uuid::Uuid::new_v4())
        .bind(uuid::Uuid::new_v4())
        .bind(agent_id)
        .bind(agent_id)
        .bind(format!("{agent_id}-history"))
        .execute(&pool)
        .await
        .unwrap();
    }

    LegacyConversationAgentMigration::run(&pool).await.unwrap();

    let retired = RetiredAgentHistoryRepository::new(pool.clone())
        .list()
        .await
        .unwrap();
    assert_eq!(
        retired
            .iter()
            .map(|row| (row.agent_id.as_str(), row.read_only))
            .collect::<Vec<_>>(),
        [("hermes", true), ("openclaw", true)]
    );

    let references = ConversationAgentReferenceRepository::new(pool)
        .list()
        .await
        .unwrap();
    assert!(references.iter().any(|row| {
        row.agent_id.as_str() == "vendor.agent-v2"
            && row.external_session_id.as_deref() == Some("vendor.agent-v2-history")
    }));
    assert!(references.iter().all(|row| row.agent_id.as_str() != ""));
}

#[tokio::test]
async fn concurrent_enqueues_keep_one_agent_operation_id() {
    let pool = migrated_pool().await;
    let agent_id = AgentId::parse("fixture.concurrent").unwrap();
    AgentMembershipRepository::new(pool.clone())
        .add(NewAgentMembership {
            agent_id: agent_id.clone(),
            source: AgentSource::OfficialRegistry,
            built_in: false,
            retired: false,
            enabled: true,
            position: 0,
            retained_metadata_json: None,
            retained_icon_svg: None,
        })
        .await
        .unwrap();
    let first = InstallationOperationRepository::new(pool.clone());
    let second = InstallationOperationRepository::new(pool.clone());
    let operation = || NewInstallationOperation {
        agent_id: agent_id.clone(),
        kind: "install".to_string(),
        frozen_plan_json: r#"{"version":"1.0.0"}"#.to_string(),
        host_instance_id: "host".to_string(),
        resource_claims: vec!["agent:fixture.concurrent".to_string()],
        staging_path: None,
    };

    let (left, right) = tokio::join!(first.enqueue(operation()), second.enqueue(operation()));

    assert_ne!(left.is_ok(), right.is_ok());
    let winner = left.or(right).unwrap();
    assert_eq!(
        InstallationOperationRepository::new(pool)
            .active_for_agent(&agent_id)
            .await
            .unwrap()
            .unwrap()
            .id,
        winner.id
    );
}

#[tokio::test]
async fn shared_resource_lease_serializes_different_agents() {
    let pool = migrated_pool().await;
    let memberships = AgentMembershipRepository::new(pool.clone());
    let first_id = AgentId::parse("fixture.first").unwrap();
    let second_id = AgentId::parse("fixture.second").unwrap();
    for (position, agent_id) in [first_id.clone(), second_id.clone()]
        .into_iter()
        .enumerate()
    {
        memberships
            .add(NewAgentMembership {
                agent_id,
                source: AgentSource::OfficialRegistry,
                built_in: false,
                retired: false,
                enabled: true,
                position: position as i64,
                retained_metadata_json: None,
                retained_icon_svg: None,
            })
            .await
            .unwrap();
    }
    let repository = InstallationOperationRepository::new(pool.clone());
    let new_operation = |agent_id| NewInstallationOperation {
        agent_id,
        kind: "install".to_string(),
        frozen_plan_json: r#"{"version":"1.0.0"}"#.to_string(),
        host_instance_id: "host".to_string(),
        resource_claims: vec!["runtime:node-24".to_string()],
        staging_path: None,
    };

    let (left, right) = tokio::join!(
        repository.enqueue(new_operation(first_id)),
        repository.enqueue(new_operation(second_id))
    );

    assert_ne!(left.is_ok(), right.is_ok());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM agent_install_resource_lease")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
}
