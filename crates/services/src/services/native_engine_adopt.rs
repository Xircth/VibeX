use std::{collections::BTreeMap, path::Path};

use agents::{
    AgentId, ArtifactTrust, BuiltInProfileCatalog, LockedInstallSource, PlannedDistributionKind,
    PlannedInstallComponent, ProfileInstallSource, ProfileTopology, ResolvedInstallPlan,
    engine::EngineRuntimePreference, launch_program_is_legacy_acp_shim,
};
use chrono::Utc;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use uuid::Uuid;

pub fn is_native_engine_profile(agent_id: &AgentId) -> bool {
    let engine_mode = std::env::var("DIMO_ENGINE_MODE").ok();
    BuiltInProfileCatalog::bundled()
        .profile(agent_id)
        .is_some_and(|profile| {
            matches!(
                profile.effective_topology(
                    EngineRuntimePreference::NativeFirst,
                    engine_mode.as_deref(),
                ),
                ProfileTopology::NativeEngine(_)
            )
        })
}

/// Persists an `external` / `ready` installation lock for an enabled built-in
/// `NativeEngine` profile (`claude_code`, `codex`, ...) when a valid non-legacy
/// CLI executable exists on disk, so `AgentManagementApplicationService::list()`,
/// preflight, and session launch all agree without requiring an artificial
/// Dimo-managed reinstall.
///
/// Never resurrects an installation when `agent_membership.enabled == false` or
/// `retired == true` (preserving explicit "Disable & Uninstall"), and acts as a
/// no-op when a valid non-legacy component lock is already in place.
pub async fn adopt_native_engine_if_needed(
    pool: &SqlitePool,
    agent_id: &AgentId,
    executable_path: &Path,
    probed_version: Option<&str>,
    sha256: Option<&str>,
) -> anyhow::Result<bool> {
    let engine_mode = std::env::var("DIMO_ENGINE_MODE").ok();
    let catalog = BuiltInProfileCatalog::bundled();
    let Some(profile) = catalog.profile(agent_id) else {
        return Ok(false);
    };
    if !matches!(
        profile.effective_topology(EngineRuntimePreference::NativeFirst, engine_mode.as_deref()),
        ProfileTopology::NativeEngine(_)
    ) {
        return Ok(false);
    }

    let Some(version) = probed_version.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(false);
    };

    let spawnable = utils::process::prefer_windows_spawnable_executable(executable_path)
        .unwrap_or_else(|| executable_path.to_path_buf());
    let executable = match tokio::fs::canonicalize(&spawnable).await {
        Ok(canon) => utils::process::prefer_direct_spawn_executable(canon),
        Err(_) => utils::process::prefer_direct_spawn_executable(spawnable),
    };
    if !executable.is_absolute()
        || !tokio::fs::metadata(&executable)
            .await
            .is_ok_and(|metadata| metadata.is_file())
        || launch_program_is_legacy_acp_shim(agent_id, &executable)
    {
        return Ok(false);
    }

    let Some((enabled, retired)) = sqlx::query_as::<_, (bool, bool)>(
        "SELECT enabled, retired FROM agent_membership WHERE agent_id = ?",
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await?
    else {
        return Ok(false);
    };
    if !enabled || retired {
        return Ok(false);
    }

    let installation = sqlx::query_as::<_, (Option<String>, Option<String>, Option<String>)>(
        "SELECT current_lock_id, lifecycle, active_operation FROM agent_installation WHERE agent_id = ?",
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await?;
    if let Some((current_lock_id, lifecycle, active_operation)) = installation {
        if active_operation.is_some() {
            return Ok(false);
        }
        if let Some(lock_id) = current_lock_id
            && !matches!(lifecycle.as_deref(), Some("needs_repair" | "uninstalled"))
        {
            let components = sqlx::query_as::<_, (String, String)>(
                "SELECT component_kind, absolute_path FROM agent_install_component WHERE lock_id = ?",
            )
            .bind(&lock_id)
            .fetch_all(pool)
            .await?;
            let valid_existing = !components.is_empty()
                && !components.iter().any(|(kind, path)| {
                    kind == "acp_adapter" || launch_program_is_legacy_acp_shim(agent_id, Path::new(path))
                })
                && components.iter().all(|(_, path)| Path::new(path).is_file());
            if valid_existing {
                return Ok(false);
            }
        }
    }

    let sha256 = match sha256.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => value.to_string(),
        None => format!("{:x}", Sha256::digest(tokio::fs::read(&executable).await?)),
    };

    let (distribution_kind, distribution_kind_str, resolved_source, command_name) =
        match profile.install_sources.first() {
            Some(ProfileInstallSource::Npx {
                package, command, ..
            }) => (
                PlannedDistributionKind::Npx,
                "npx",
                (*package).to_string(),
                (*command).to_string(),
            ),
            Some(ProfileInstallSource::Uvx {
                package, command, ..
            }) => (
                PlannedDistributionKind::Uvx,
                "uvx",
                (*package).to_string(),
                (*command).to_string(),
            ),
            Some(ProfileInstallSource::Binary { command, .. }) => (
                PlannedDistributionKind::Binary,
                "binary",
                "external".to_string(),
                (*command).to_string(),
            ),
            None => (
                PlannedDistributionKind::Binary,
                "binary",
                "external".to_string(),
                executable
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or(agent_id.as_str())
                    .to_string(),
            ),
        };

    let mut env = BTreeMap::new();
    let mut path_entries = Vec::new();
    if let Some(parent) = executable.parent() {
        path_entries.push(parent.to_path_buf());
    }
    if let Some(existing) = std::env::var_os("PATH") {
        path_entries.extend(std::env::split_paths(&existing));
    }
    if let Ok(joined) = std::env::join_paths(path_entries) {
        env.insert("PATH".to_string(), joined.to_string_lossy().to_string());
    }

    let plan = ResolvedInstallPlan {
        agent_id: agent_id.clone(),
        source: LockedInstallSource::BuiltInProfile,
        version: version.to_string(),
        platform: agents::current_platform(),
        components: vec![PlannedInstallComponent {
            component_id: "combined_runtime".to_string(),
            distribution_kind,
            version: version.to_string(),
            resolved_source,
            command: command_name,
            args: Vec::new(),
            env: BTreeMap::new(),
            trust: ArtifactTrust::Tofu,
        }],
    };
    let resolved_json = serde_json::json!({
        "source": { "kind": "built_in_profile" },
        "frozen_plan": plan,
        "absolute_acp_program": executable,
        "args": Vec::<String>::new(),
        "env": env,
        "runtime_version": version,
        "acp_version": version,
    })
    .to_string();

    let lock_id = Uuid::new_v4().to_string();
    let mut transaction = pool.begin().await?;
    sqlx::query(
        r#"INSERT INTO agent_install_lock
           (id, agent_id, registry_version, platform, distribution_kind, resolved_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)"#,
    )
    .bind(&lock_id)
    .bind(agent_id.as_str())
    .bind(version)
    .bind(agents::current_platform())
    .bind(distribution_kind_str)
    .bind(&resolved_json)
    .bind(Utc::now().to_rfc3339())
    .execute(&mut *transaction)
    .await?;
    sqlx::query(
        r#"INSERT INTO agent_install_component
           (id, lock_id, component_kind, absolute_path, version, sha256,
            trust_state, ownership, shared_resource_key)
           VALUES (?, ?, 'combined_runtime', ?, ?, ?, 'user_environment', 'external', NULL)"#,
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&lock_id)
    .bind(executable.display().to_string())
    .bind(version)
    .bind(&sha256)
    .execute(&mut *transaction)
    .await?;
    sqlx::query(
        r#"INSERT INTO agent_installation
           (agent_id, ownership, lifecycle, current_lock_id, rollback_lock_id,
            active_operation, active_operation_id, updated_at)
           VALUES (?, 'external', 'ready', ?, NULL, NULL, NULL, CURRENT_TIMESTAMP)
           ON CONFLICT(agent_id) DO UPDATE SET
             ownership = excluded.ownership,
             rollback_lock_id = agent_installation.current_lock_id,
             current_lock_id = excluded.current_lock_id,
             lifecycle = 'ready',
             active_operation = NULL,
             active_operation_id = NULL,
             updated_at = CURRENT_TIMESTAMP"#,
    )
    .bind(agent_id.as_str())
    .bind(&lock_id)
    .execute(&mut *transaction)
    .await?;
    sqlx::query(
        r#"UPDATE agent_diagnostic
           SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
           WHERE agent_id = ?
             AND severity = 'error'
             AND read_at IS NULL"#,
    )
    .bind(agent_id.as_str())
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;

    Ok(true)
}

#[cfg(test)]
mod tests {
    use api_types::{AgentAuthenticationStatus, AgentLifecycleState, AgentSource};
    use db::models::agent_management::{AgentMembershipRepository, NewAgentMembership};
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::*;
    use crate::services::agent_management::AgentManagementApplicationService;

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
        let repo = AgentMembershipRepository::new(pool.clone());
        for (idx, id) in ["claude_code", "codex", "antigravity"].iter().enumerate() {
            repo.add(NewAgentMembership {
                agent_id: AgentId::parse(id).unwrap(),
                source: AgentSource::BuiltInProfile,
                built_in: true,
                retired: false,
                enabled: true,
                position: idx as i64,
                retained_metadata_json: None,
                retained_icon_svg: None,
            })
            .await
            .unwrap();
        }
        pool
    }

    fn write_dummy_cli(dir: &Path, base_name: &str) -> std::path::PathBuf {
        #[cfg(windows)]
        let file = dir.join(format!("{base_name}.cmd"));
        #[cfg(not(windows))]
        let file = dir.join(base_name);
        std::fs::write(&file, b"@echo off\necho 1.0.0\n").unwrap();
        file
    }

    #[tokio::test]
    async fn adopts_enabled_claude_code_and_codex_with_external_ready_lock() {
        let pool = migrated_pool().await;
        let temp = tempfile::tempdir().unwrap();
        let claude_cli = write_dummy_cli(temp.path(), "claude");
        let codex_cli = write_dummy_cli(temp.path(), "codex");

        let claude_id = AgentId::parse("claude_code").unwrap();
        let codex_id = AgentId::parse("codex").unwrap();

        assert!(
            adopt_native_engine_if_needed(
                &pool,
                &claude_id,
                &claude_cli,
                Some("2.1.325 (Claude Code)"),
                None,
            )
            .await
            .unwrap()
        );
        assert!(
            adopt_native_engine_if_needed(
                &pool,
                &codex_id,
                &codex_cli,
                Some("codex-cli 0.169.0"),
                None,
            )
            .await
            .unwrap()
        );

        let service = AgentManagementApplicationService::new(pool.clone());
        service
            .sync_authentication(&claude_id, AgentAuthenticationStatus::ApiKey, None)
            .await
            .unwrap();
        service
            .sync_authentication(&codex_id, AgentAuthenticationStatus::Account, None)
            .await
            .unwrap();

        let views = service.list().await.unwrap();
        let claude_view = views.iter().find(|v| v.agent_id == claude_id).unwrap();
        assert_eq!(claude_view.lifecycle, AgentLifecycleState::Ready);
        assert_eq!(
            claude_view.runtime_version.as_deref(),
            Some("2.1.325 (Claude Code)")
        );
        assert_eq!(
            claude_view.acp_version.as_deref(),
            Some("2.1.325 (Claude Code)")
        );

        let codex_view = views.iter().find(|v| v.agent_id == codex_id).unwrap();
        assert_eq!(codex_view.lifecycle, AgentLifecycleState::Ready);
        assert_eq!(
            codex_view.runtime_version.as_deref(),
            Some("codex-cli 0.169.0")
        );
        assert_eq!(codex_view.acp_version.as_deref(), Some("codex-cli 0.169.0"));

        // Re-running with valid lock is a no-op.
        assert!(
            !adopt_native_engine_if_needed(
                &pool,
                &claude_id,
                &claude_cli,
                Some("2.1.325 (Claude Code)"),
                None,
            )
            .await
            .unwrap()
        );
        assert!(
            !adopt_native_engine_if_needed(
                &pool,
                &codex_id,
                &codex_cli,
                Some("codex-cli 0.169.0"),
                None,
            )
            .await
            .unwrap()
        );
    }

    #[tokio::test]
    async fn does_not_adopt_disabled_or_non_native_agents() {
        let pool = migrated_pool().await;
        let temp = tempfile::tempdir().unwrap();
        let claude_cli = write_dummy_cli(temp.path(), "claude");
        let codex_cli = write_dummy_cli(temp.path(), "codex");
        let agy_cli = write_dummy_cli(temp.path(), "agy_acp_server");

        sqlx::query("UPDATE agent_membership SET enabled = 0 WHERE agent_id IN ('claude_code', 'codex')")
            .execute(&pool)
            .await
            .unwrap();

        let claude_id = AgentId::parse("claude_code").unwrap();
        let codex_id = AgentId::parse("codex").unwrap();
        let agy_id = AgentId::parse("antigravity").unwrap();

        assert!(
            !adopt_native_engine_if_needed(&pool, &claude_id, &claude_cli, Some("2.1.325"), None)
                .await
                .unwrap()
        );
        assert!(
            !adopt_native_engine_if_needed(&pool, &codex_id, &codex_cli, Some("0.169.0"), None)
                .await
                .unwrap()
        );
        assert!(
            !adopt_native_engine_if_needed(&pool, &agy_id, &agy_cli, Some("1.4.1"), None)
                .await
                .unwrap()
        );

        let views = AgentManagementApplicationService::new(pool)
            .list()
            .await
            .unwrap();
        for id in [&claude_id, &codex_id, &agy_id] {
            let view = views.iter().find(|v| &v.agent_id == id).unwrap();
            assert_eq!(view.lifecycle, AgentLifecycleState::Uninstalled);
        }
    }

    #[tokio::test]
    async fn repairs_legacy_shim_or_missing_component_lock() {
        let pool = migrated_pool().await;
        let temp = tempfile::tempdir().unwrap();
        let legacy_shim = write_dummy_cli(temp.path(), "codex-acp");
        let codex_cli = write_dummy_cli(temp.path(), "codex");
        let codex_id = AgentId::parse("codex").unwrap();

        sqlx::query(
            r#"INSERT INTO agent_install_lock
               (id, agent_id, registry_version, platform, distribution_kind, resolved_json, created_at)
               VALUES ('old-lock', 'codex', '0.1.0', 'windows-x86_64', 'npx', '{}', '2026-01-01T00:00:00Z')"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"INSERT INTO agent_install_component
               (id, lock_id, component_kind, absolute_path, version, sha256, trust_state, ownership)
               VALUES ('comp-1', 'old-lock', 'acp_adapter', ?, '0.1.0', 'deadbeef', 'tofu', 'managed')"#,
        )
        .bind(legacy_shim.display().to_string())
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"INSERT INTO agent_installation
               (agent_id, ownership, lifecycle, current_lock_id, updated_at)
               VALUES ('codex', 'managed', 'ready', 'old-lock', CURRENT_TIMESTAMP)"#,
        )
        .execute(&pool)
        .await
        .unwrap();

        assert!(
            adopt_native_engine_if_needed(
                &pool,
                &codex_id,
                &codex_cli,
                Some("codex-cli 0.169.0"),
                None,
            )
            .await
            .unwrap()
        );

        let views = AgentManagementApplicationService::new(pool.clone())
            .list()
            .await
            .unwrap();
        let codex_view = views.iter().find(|v| v.agent_id == codex_id).unwrap();
        assert_eq!(
            codex_view.runtime_version.as_deref(),
            Some("codex-cli 0.169.0")
        );
    }
}
