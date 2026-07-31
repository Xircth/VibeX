#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, path::Path};

    use api_types::{
        AgentId, AgentManagementErrorCode, AgentManagementErrorView, AgentOperationEvent,
        AgentOperationKind, AgentOperationStatus,
    };

    use super::{
        OperationCancellationRegistry, bind_profile_runtime_executable, build_launch_environment,
        install_locked_plan, managed_install_root, management_error, operation_event,
        resolve_npm_package_executable, resolve_uv_tool_executable, verify_acp_handshake,
    };

    #[test]
    fn agent_management_commands_serialize_snapshots_and_errors() {
        let agent_id = AgentId::parse("vendor.agent-v2").unwrap();
        let error = management_error(
            AgentManagementErrorCode::Busy,
            "此Agent还有正在执行的进程，暂时无法卸载/移除",
            Some(agent_id.clone()),
        );
        assert_eq!(
            error,
            AgentManagementErrorView {
                code: AgentManagementErrorCode::Busy,
                message: "此Agent还有正在执行的进程，暂时无法卸载/移除".to_string(),
                agent_id: Some(agent_id.clone()),
                preflight_item_id: None,
            }
        );
        assert_eq!(serde_json::to_value(&error).unwrap()["code"], "busy");

        let event = operation_event(
            42,
            agent_id,
            "operation-1",
            AgentOperationKind::Repair,
            AgentOperationStatus::Running,
            Some(25),
            Some("checking ACP handshake".to_string()),
        );
        assert_eq!(event.sequence, 42);
        assert_eq!(event.progress_percent, Some(25));
        assert_eq!(
            serde_json::from_value::<AgentOperationEvent>(serde_json::to_value(event).unwrap())
                .unwrap()
                .status,
            AgentOperationStatus::Running
        );
    }

    #[test]
    fn cancel_targets_the_exact_registered_operation() {
        let registry = OperationCancellationRegistry::default();
        let first = registry.register("operation-1");
        let second = registry.register("operation-2");

        assert!(registry.cancel("operation-1"));
        assert!(first.is_cancelled());
        assert!(!second.is_cancelled());
        assert!(!registry.cancel("missing"));

        registry.remove("operation-1");
        assert!(!registry.cancel("operation-1"));
    }

    #[test]
    fn managed_install_root_is_scoped_below_the_agents_directory() {
        let root = managed_install_root(
            Path::new("/app-data"),
            &AgentId::parse("vendor.agent-v2").unwrap(),
        )
        .unwrap();
        assert_eq!(root, Path::new("/app-data/agents/vendor.agent-v2"));
    }

    #[test]
    fn adapter_launch_env_binds_the_separate_local_runtime() {
        for (agent, expected_key) in [
            ("claude_code", "CLAUDE_CODE_EXECUTABLE"),
            ("codex", "CODEX_PATH"),
        ] {
            let mut env = BTreeMap::new();
            bind_profile_runtime_executable(
                &AgentId::parse(agent).unwrap(),
                Path::new("/managed/runtime"),
                &mut env,
            );
            assert_eq!(
                env.get(expected_key).map(String::as_str),
                Some("/managed/runtime")
            );
        }

        let mut generic_env = BTreeMap::new();
        bind_profile_runtime_executable(
            &AgentId::parse("registry.generic").unwrap(),
            Path::new("/managed/runtime"),
            &mut generic_env,
        );
        assert!(generic_env.is_empty());
    }

    #[test]
    fn provider_api_keys_are_not_misreported_as_account_logins() {
        let catalog = agents::BuiltInProfileCatalog::bundled();
        let opencode = catalog
            .profile(&AgentId::parse("opencode").unwrap())
            .unwrap()
            .account_evidence
            .as_ref()
            .unwrap();
        let pi = catalog
            .profile(&AgentId::parse("pi").unwrap())
            .unwrap()
            .account_evidence
            .as_ref()
            .unwrap();

        assert!(!opencode.matches(&serde_json::json!({
            "anthropic": {"type": "api", "key": "local"}
        })));
        assert!(!pi.matches(&serde_json::json!({
            "anthropic": {"type": "api_key", "key": "local"}
        })));
        assert!(pi.matches(&serde_json::json!({
            "anthropic": {"type": "oauth", "access": "token"}
        })));
    }

    #[tokio::test]
    async fn registry_npx_resolves_grok_builds_package_binary() {
        let temp = tempfile::tempdir().unwrap();
        let component_root = temp.path();
        let package_root = component_root
            .join("node_modules")
            .join("@xai-official")
            .join("grok");
        let bin_dir = component_root.join("node_modules").join(".bin");
        tokio::fs::create_dir_all(&package_root).await.unwrap();
        tokio::fs::create_dir_all(&bin_dir).await.unwrap();
        tokio::fs::write(
            package_root.join("package.json"),
            r#"{"name":"@xai-official/grok","bin":{"grok":"bin/grok"}}"#,
        )
        .await
        .unwrap();
        tokio::fs::write(bin_dir.join("grok"), b"#!/bin/sh\n")
            .await
            .unwrap();

        let executable =
            resolve_npm_package_executable(component_root, &bin_dir, "@xai-official/grok@0.2.115")
                .await
                .unwrap();

        assert_eq!(executable, bin_dir.join("grok"));
    }

    #[tokio::test]
    async fn registry_npx_resolves_same_target_aliases_deterministically() {
        let temp = tempfile::tempdir().unwrap();
        let component_root = temp.path();
        let package_root = component_root
            .join("node_modules")
            .join("@tencent-ai")
            .join("codebuddy-code");
        let bin_dir = component_root.join("node_modules").join(".bin");
        tokio::fs::create_dir_all(&package_root).await.unwrap();
        tokio::fs::create_dir_all(&bin_dir).await.unwrap();
        tokio::fs::write(
            package_root.join("package.json"),
            r#"{"name":"@tencent-ai/codebuddy-code","bin":{"cbc":"bin/codebuddy","codebuddy":"bin/codebuddy"}}"#,
        )
        .await
        .unwrap();
        tokio::fs::write(bin_dir.join("cbc"), b"#!/bin/sh\n")
            .await
            .unwrap();
        tokio::fs::write(bin_dir.join("codebuddy"), b"#!/bin/sh\n")
            .await
            .unwrap();

        let executable = resolve_npm_package_executable(
            component_root,
            &bin_dir,
            "@tencent-ai/codebuddy-code@2.106.7",
        )
        .await
        .unwrap();

        assert_eq!(executable, bin_dir.join("cbc"));
    }

    #[tokio::test]
    async fn registry_uv_tool_prefers_package_named_executable() {
        let temp = tempfile::tempdir().unwrap();
        let bin_dir = temp.path();
        tokio::fs::write(bin_dir.join("minion-helper"), b"#!/bin/sh\n")
            .await
            .unwrap();
        tokio::fs::write(bin_dir.join("minion-code"), b"#!/bin/sh\n")
            .await
            .unwrap();

        let executable = resolve_uv_tool_executable(bin_dir, "minion-code@0.1.44")
            .await
            .unwrap();

        assert_eq!(executable, bin_dir.join("minion-code"));
    }

    #[test]
    fn registry_environment_reaches_the_locked_launch_environment() {
        let component = agents::PlannedInstallComponent {
            component_id: "combined_runtime".to_string(),
            distribution_kind: agents::PlannedDistributionKind::Npx,
            version: "0.33.0".to_string(),
            resolved_source: "@augmentcode/auggie@0.33.0".to_string(),
            command: "auggie".to_string(),
            args: vec!["--acp".to_string()],
            env: BTreeMap::from([("AUGMENT_DISABLE_AUTO_UPDATE".to_string(), "1".to_string())]),
            trust: agents::ArtifactTrust::EcosystemIntegrityRequired,
        };

        let env = build_launch_environment(
            &[component],
            &[std::path::PathBuf::from("/managed/npm/bin")],
            std::ffi::OsString::from("/usr/bin"),
        )
        .unwrap();

        assert_eq!(
            env.get("AUGMENT_DISABLE_AUTO_UPDATE").map(String::as_str),
            Some("1")
        );
        assert!(
            env.get("PATH")
                .is_some_and(|path| path.starts_with("/managed/npm/bin"))
        );
    }

    #[tokio::test]
    #[ignore = "live probe requires the public npm registry"]
    async fn live_grok_build_package_installs_and_completes_acp_handshake() {
        let temp = tempfile::tempdir().unwrap();
        let agent_id = AgentId::parse("grok-build").unwrap();
        let plan = agents::ResolvedInstallPlan {
            agent_id: agent_id.clone(),
            source: agents::LockedInstallSource::OfficialRegistry {
                snapshot_id: uuid::Uuid::nil(),
                registry_id: "grok-build".to_string(),
            },
            version: "0.2.115".to_string(),
            platform: agents::current_platform(),
            components: vec![agents::PlannedInstallComponent {
                component_id: "combined_runtime".to_string(),
                distribution_kind: agents::PlannedDistributionKind::Npx,
                version: "0.2.115".to_string(),
                resolved_source: "@xai-official/grok@0.2.115".to_string(),
                command: "grok".to_string(),
                args: vec!["agent".to_string(), "stdio".to_string()],
                env: Default::default(),
                trust: agents::ArtifactTrust::EcosystemIntegrityRequired,
            }],
        };
        let cancellation = tokio_util::sync::CancellationToken::new();
        let installation = install_locked_plan(
            &plan,
            temp.path(),
            &cancellation,
            &std::collections::HashMap::new(),
        )
        .await
        .unwrap();

        assert!(
            installation
                .launch_lock
                .absolute_acp_program
                .ends_with("grok")
        );
        verify_acp_handshake(
            &agent_id,
            &installation.launch_lock,
            temp.path(),
            &cancellation,
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    #[ignore = "live probe requires the public Python package registry"]
    async fn live_official_uv_packages_install_with_resolvable_entry() {
        for (agent, version, package, args) in [
            (
                "fast-agent",
                "0.9.27",
                "fast-agent-acp==0.9.27",
                vec!["-x".to_string()],
            ),
            (
                "minion-code",
                "0.1.44",
                "minion-code@0.1.44",
                vec!["acp".to_string()],
            ),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let agent_id = AgentId::parse(agent).unwrap();
            let plan = agents::ResolvedInstallPlan {
                agent_id: agent_id.clone(),
                source: agents::LockedInstallSource::OfficialRegistry {
                    snapshot_id: uuid::Uuid::nil(),
                    registry_id: agent.to_string(),
                },
                version: version.to_string(),
                platform: agents::current_platform(),
                components: vec![agents::PlannedInstallComponent {
                    component_id: "combined_runtime".to_string(),
                    distribution_kind: agents::PlannedDistributionKind::Uvx,
                    version: version.to_string(),
                    resolved_source: package.to_string(),
                    command: "uv".to_string(),
                    args,
                    env: Default::default(),
                    trust: agents::ArtifactTrust::EcosystemIntegrityRequired,
                }],
            };
            let cancellation = tokio_util::sync::CancellationToken::new();
            let installation = install_locked_plan(
                &plan,
                temp.path(),
                &cancellation,
                &std::collections::HashMap::new(),
            )
            .await
            .unwrap();

            assert!(
                tokio::fs::metadata(&installation.launch_lock.absolute_acp_program)
                    .await
                    .is_ok()
            );
        }
    }

    #[tokio::test]
    #[ignore = "live probe requires the public Python package registry"]
    async fn live_fast_agent_package_completes_acp_handshake() {
        let temp = tempfile::tempdir().unwrap();
        let agent_id = AgentId::parse("fast-agent").unwrap();
        let plan = agents::ResolvedInstallPlan {
            agent_id: agent_id.clone(),
            source: agents::LockedInstallSource::OfficialRegistry {
                snapshot_id: uuid::Uuid::nil(),
                registry_id: "fast-agent".to_string(),
            },
            version: "0.9.27".to_string(),
            platform: agents::current_platform(),
            components: vec![agents::PlannedInstallComponent {
                component_id: "combined_runtime".to_string(),
                distribution_kind: agents::PlannedDistributionKind::Uvx,
                version: "0.9.27".to_string(),
                resolved_source: "fast-agent-acp==0.9.27".to_string(),
                command: "uv".to_string(),
                args: vec!["-x".to_string()],
                env: Default::default(),
                trust: agents::ArtifactTrust::EcosystemIntegrityRequired,
            }],
        };
        let cancellation = tokio_util::sync::CancellationToken::new();
        let installation = install_locked_plan(
            &plan,
            temp.path(),
            &cancellation,
            &std::collections::HashMap::new(),
        )
        .await
        .unwrap();

        verify_acp_handshake(
            &agent_id,
            &installation.launch_lock,
            temp.path(),
            &cancellation,
        )
        .await
        .unwrap();
    }
}
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    ffi::OsString,
    io::{Cursor, Read},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
};

use agents::{
    AcpAuthenticationObservationSnapshot, AcpCapabilitySnapshot, AgentAutoApproveMode,
    AgentConnectionId, AgentConnectionLaunch, AgentConnectionManager, ArtifactTrust,
    AuthenticationObservationState, BuiltInProfileCatalog, InstallCandidateSource,
    InstallEnvironment, InstallPlanner, InstallPlanningInput, LockedInstallSource,
    NativeConfigPatch, NativeConfigProvider, OfficialRegistryHttpFetcher, PlannedDistributionKind,
    PlannedInstallComponent, ProfileComponent, ProfileInstallSource, ProfileTopology,
    RegistryCache, RegistryCacheFreshness, RegistrySnapshotClient, ResolvedInstallPlan,
    SessionLaunchLock, ShellFamily, SystemClock, TofuFingerprint, TokioNativeFileSystem,
    publish_managed_runtime_cli, remove_managed_runtime_cli, switch_managed_runtime_cli,
    verify_artifact_bytes,
};
use api_types::{
    AgentAuthenticationStatus, AgentDiagnosticView, AgentId, AgentLifecycleState,
    AgentManagementErrorCode, AgentManagementErrorView, AgentManagementView,
    AgentNativeConfigFieldKind, AgentNativeConfigFieldView, AgentNativeConfigFileView,
    AgentNativeConfigFormat, AgentNativeConfigOptionView, AgentNativeConfigPatchRequest,
    AgentNativeConfigView, AgentOperationEvent, AgentOperationKind, AgentOperationReceipt,
    AgentOperationStatus, AgentPreflightItemView, AgentPreflightView, AgentRegistryView,
    AgentUpdateCheckView,
};
use chrono::{Duration, Utc};
use db::models::agent_management::{
    AgentMembershipRepository, InstallationOperationRepository, NewInstallationOperation,
    RegistrySnapshotRepository,
};
use services::services::{
    agent_management::AgentManagementApplicationService, agent_registry::AgentRegistrySnapshotStore,
};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{Mutex as AsyncMutex, Semaphore, mpsc};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::state::AppState;

const MANAGEMENT_EVENT: &str = "agent-management-event";
const MANAGEMENT_INVALIDATED_EVENT: &str = "agent-management-snapshot-invalidated";
static EVENT_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static OPERATION_SCHEDULER: OnceLock<OperationScheduler> = OnceLock::new();
static BUILT_IN_PROBES: OnceLock<AsyncMutex<HashSet<AgentId>>> = OnceLock::new();
static CLI_EXPOSURES: OnceLock<AsyncMutex<HashSet<AgentId>>> = OnceLock::new();
static HOST_INSTANCE_ID: OnceLock<String> = OnceLock::new();

fn host_instance_id() -> &'static str {
    HOST_INSTANCE_ID
        .get_or_init(|| Uuid::new_v4().to_string())
        .as_str()
}

pub(crate) async fn recover_interrupted_agent_operations(app: &AppHandle, pool: &sqlx::SqlitePool) {
    let repository = InstallationOperationRepository::new(pool.clone());
    let recovered = match repository.recover_interrupted(host_instance_id()).await {
        Ok(recovered) => recovered,
        Err(error) => {
            tracing::error!(%error, "failed to recover interrupted Agent operations");
            return;
        }
    };
    let Ok(app_data_dir) = app.path().app_data_dir() else {
        return;
    };
    for operation_id in recovered {
        let Ok(Some(operation)) = repository.find(operation_id).await else {
            continue;
        };
        let Some(staging_path) = operation.staging_path.map(PathBuf::from) else {
            continue;
        };
        let Ok(root) = managed_install_root(&app_data_dir, &operation.agent_id) else {
            continue;
        };
        let is_staging = staging_path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(".staging-"));
        if staging_path.is_absolute() && staging_path.starts_with(&root) && is_staging {
            let _ = tokio::fs::remove_dir_all(staging_path).await;
        }
    }
}

struct OperationScheduler {
    global: Arc<Semaphore>,
    per_agent: Mutex<HashMap<AgentId, Arc<AsyncMutex<()>>>>,
    cancellations: OperationCancellationRegistry,
}

impl OperationScheduler {
    fn shared() -> &'static Self {
        OPERATION_SCHEDULER.get_or_init(|| Self {
            global: Arc::new(Semaphore::new(2)),
            per_agent: Mutex::new(HashMap::new()),
            cancellations: OperationCancellationRegistry::default(),
        })
    }

    fn agent_lock(&self, agent_id: &AgentId) -> Arc<AsyncMutex<()>> {
        self.per_agent
            .lock()
            .expect("Agent operation lock map is not poisoned")
            .entry(agent_id.clone())
            .or_default()
            .clone()
    }
}

#[derive(Default)]
struct OperationCancellationRegistry {
    tokens: Mutex<HashMap<String, CancellationToken>>,
}

impl OperationCancellationRegistry {
    fn register(&self, operation_id: &str) -> CancellationToken {
        let token = CancellationToken::new();
        self.tokens
            .lock()
            .expect("Agent cancellation registry is not poisoned")
            .insert(operation_id.to_string(), token.clone());
        token
    }

    fn cancel(&self, operation_id: &str) -> bool {
        let token = self
            .tokens
            .lock()
            .expect("Agent cancellation registry is not poisoned")
            .get(operation_id)
            .cloned();
        if let Some(token) = token {
            token.cancel();
            true
        } else {
            false
        }
    }

    fn remove(&self, operation_id: &str) {
        self.tokens
            .lock()
            .expect("Agent cancellation registry is not poisoned")
            .remove(operation_id);
    }
}

fn managed_install_root(app_data_dir: &Path, agent_id: &AgentId) -> anyhow::Result<PathBuf> {
    let agents_root = app_data_dir.join("agents");
    let root = agents_root.join(agent_id.as_str());
    if root.parent() != Some(agents_root.as_path()) {
        anyhow::bail!("invalid managed Agent installation path");
    }
    Ok(root)
}

fn configured_shell_family() -> ShellFamily {
    #[cfg(windows)]
    {
        return ShellFamily::Windows;
    }
    #[cfg(not(windows))]
    ShellFamily::from_shell_path(std::env::var_os("SHELL").as_deref().map(Path::new))
}

async fn managed_runtime_for_lock(
    pool: &sqlx::SqlitePool,
    lock_id: &str,
) -> anyhow::Result<Option<PathBuf>> {
    Ok(sqlx::query_scalar::<_, String>(
        r#"SELECT absolute_path
           FROM agent_install_component
           WHERE lock_id = ?
             AND component_kind IN ('agent_runtime', 'combined_runtime')
           ORDER BY CASE component_kind
             WHEN 'agent_runtime' THEN 0
             ELSE 1
           END
           LIMIT 1"#,
    )
    .bind(lock_id)
    .fetch_optional(pool)
    .await?
    .map(PathBuf::from))
}

async fn current_managed_runtime(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
) -> anyhow::Result<Option<PathBuf>> {
    Ok(sqlx::query_scalar::<_, String>(
        r#"SELECT component.absolute_path
           FROM agent_installation installation
           JOIN agent_install_component component
             ON component.lock_id = installation.current_lock_id
           WHERE installation.agent_id = ?
             AND installation.ownership = 'managed'
             AND component.component_kind IN ('agent_runtime', 'combined_runtime')
           ORDER BY CASE component.component_kind
             WHEN 'agent_runtime' THEN 0
             ELSE 1
           END
           LIMIT 1"#,
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await?
    .map(PathBuf::from))
}

fn restore_managed_cli_switch(
    home_dir: &Path,
    agent_id: &AgentId,
    managed_install_root: &Path,
    previous_runtime: Option<&Path>,
    attempted_runtime: &Path,
    shell: ShellFamily,
) -> Result<(), agents::CliExposureError> {
    match previous_runtime {
        Some(previous_runtime) => switch_managed_runtime_cli(
            home_dir,
            agent_id,
            managed_install_root,
            Some(attempted_runtime),
            previous_runtime,
            shell,
        )
        .map(|_| ()),
        None => remove_managed_runtime_cli(home_dir, agent_id, attempted_runtime),
    }
}

pub(crate) async fn reconcile_managed_cli_exposures(app: &AppHandle, pool: &sqlx::SqlitePool) {
    let _ = utils::shell::refresh_process_path_after_install().await;
    let installations = match sqlx::query_scalar::<_, String>(
        r#"SELECT installation.agent_id
           FROM agent_installation installation
           WHERE installation.ownership = 'managed'
             AND installation.current_lock_id IS NOT NULL
           ORDER BY installation.agent_id"#,
    )
    .fetch_all(pool)
    .await
    {
        Ok(installations) => installations,
        Err(error) => {
            tracing::warn!(%error, "failed to load managed Agent CLI exposures");
            return;
        }
    };
    let Ok(home_dir) = app.path().home_dir() else {
        return;
    };
    let Ok(app_data_dir) = app.path().app_data_dir() else {
        return;
    };
    for agent_id in installations {
        let Ok(agent_id) = AgentId::parse(agent_id) else {
            continue;
        };
        let already_reconciled = CLI_EXPOSURES
            .get_or_init(|| AsyncMutex::new(HashSet::new()))
            .lock()
            .await
            .contains(&agent_id);
        if already_reconciled {
            continue;
        }
        let agent_lock = OperationScheduler::shared().agent_lock(&agent_id);
        let _agent_guard = agent_lock.lock().await;
        let runtime = current_managed_runtime(pool, &agent_id)
            .await
            .and_then(|runtime| {
                runtime.ok_or_else(|| anyhow::anyhow!("安装记录没有本地 Runtime 组件"))
            });
        let result = runtime.and_then(|runtime| {
            let root = managed_install_root(&app_data_dir, &agent_id)?;
            publish_managed_runtime_cli(
                &home_dir,
                &agent_id,
                &root,
                &runtime,
                configured_shell_family(),
            )
            .map_err(Into::into)
        });
        match result {
            Ok(_) => {
                CLI_EXPOSURES
                    .get_or_init(|| AsyncMutex::new(HashSet::new()))
                    .lock()
                    .await
                    .insert(agent_id);
            }
            Err(error) => {
                tracing::warn!(
                    agent_id = %agent_id,
                    %error,
                    "failed to reconcile managed Agent terminal command"
                );
                let redacted = redact_operation_output(&error.to_string());
                let _ = sqlx::query(
                    r#"UPDATE agent_installation
                       SET lifecycle = 'needs_repair', updated_at = CURRENT_TIMESTAMP
                       WHERE agent_id = ? AND ownership = 'managed'
                         AND current_lock_id IS NOT NULL"#,
                )
                .bind(agent_id.as_str())
                .execute(pool)
                .await;
                let _ = db::models::agent_management::DiagnosticRepository::new(pool.clone())
                    .append_bounded(&db::models::agent_management::DiagnosticRecord {
                        id: Uuid::new_v4(),
                        agent_id,
                        operation_kind: "terminal_cli".to_string(),
                        severity: "error".to_string(),
                        message: "本地终端命令发布失败".to_string(),
                        redacted_output: Some(redacted),
                        created_at: Utc::now().to_rfc3339(),
                    })
                    .await;
            }
        }
    }
    let _ = utils::shell::refresh_process_path_after_install().await;
}

async fn probe_built_in_external_installations(app: &AppHandle, pool: &sqlx::SqlitePool) {
    let profiles = BuiltInProfileCatalog::bundled();
    for profile in profiles.profiles() {
        let already_attempted = {
            let mut attempted = BUILT_IN_PROBES
                .get_or_init(|| AsyncMutex::new(HashSet::new()))
                .lock()
                .await;
            !attempted.insert(profile.agent_id.clone())
        };
        if already_attempted {
            continue;
        }
        let installed = sqlx::query_scalar::<_, bool>(
            r#"SELECT EXISTS(
                 SELECT 1 FROM agent_installation
                 WHERE agent_id = ? AND current_lock_id IS NOT NULL
               )"#,
        )
        .bind(profile.agent_id.as_str())
        .fetch_one(pool)
        .await
        .unwrap_or(false);
        if installed {
            continue;
        }
        if let Err(error) = probe_one_built_in_external_installation(app, pool, profile).await {
            tracing::debug!(
                agent_id = %profile.agent_id,
                %error,
                "built-in external Agent candidate was not adopted"
            );
        }
    }
}

async fn refresh_agent_management_evidence(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
) -> Result<(), AgentManagementErrorView> {
    probe_built_in_external_installations(app, pool).await;
    normalize_optional_profile_authentication(pool).await;
    AgentManagementApplicationService::new(pool.clone())
        .refresh_component_integrity()
        .await
        .map_err(internal_error)?;
    Ok(())
}

pub(crate) async fn warm_agent_management(app: &AppHandle, pool: &sqlx::SqlitePool) {
    if let Err(error) = refresh_agent_management_evidence(app, pool).await {
        tracing::warn!(
            message = %error.message,
            "Agent management startup warmup failed"
        );
    }
    if let Err(error) = app.emit(MANAGEMENT_INVALIDATED_EVENT, ()) {
        tracing::warn!(%error, "failed to emit Agent management snapshot invalidation");
    }
}

async fn normalize_optional_profile_authentication(pool: &sqlx::SqlitePool) {
    for profile in BuiltInProfileCatalog::bundled()
        .profiles()
        .iter()
        .filter(|profile| !profile.authentication_required_by_default)
    {
        if let Err(error) = sync_authentication_probe_with_requirement(
            pool,
            &profile.agent_id,
            AgentAuthenticationStatus::NotRequired,
            false,
        )
        .await
        {
            tracing::warn!(
                agent_id = %profile.agent_id,
                message = %error.message,
                "failed to normalize optional profile authentication"
            );
        }
    }
}

async fn probe_one_built_in_external_installation(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    profile: &agents::BuiltInProfile,
) -> anyhow::Result<()> {
    let mut components = Vec::new();
    for candidate in profile.external_candidates {
        let executable = which::which(candidate.executable)?;
        let executable = tokio::fs::canonicalize(executable).await?;
        if !executable.is_absolute() || !tokio::fs::metadata(&executable).await?.is_file() {
            anyhow::bail!("external candidate is not an absolute executable file");
        }
        let mut command = tokio::process::Command::new(&executable);
        command.args(candidate.version_args);
        let output = command.output().await?;
        ensure_success("external Agent version probe", &output)?;
        let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if version.is_empty() {
            anyhow::bail!("external Agent version probe returned no version");
        }
        let sha256 = format!("{:x}", Sha256::digest(tokio::fs::read(&executable).await?));
        components.push(InstalledComponent {
            kind: profile_component_key(candidate.component).to_string(),
            absolute_path: executable,
            version,
            sha256: Some(sha256),
            trust_state: "tofu".to_string(),
            ownership: "external".to_string(),
        });
    }
    let required_components_present = match profile.topology {
        ProfileTopology::NativeAcp => components
            .iter()
            .any(|component| component.kind == "combined_runtime"),
        ProfileTopology::AdapterBacked => {
            components
                .iter()
                .any(|component| component.kind == "agent_runtime")
                && components
                    .iter()
                    .any(|component| component.kind == "acp_adapter")
        }
    };
    if !required_components_present {
        anyhow::bail!("not every Profile-declared external component is available");
    }
    let runtime = components
        .iter()
        .find(|component| {
            matches!(
                component.kind.as_str(),
                "agent_runtime" | "combined_runtime"
            )
        })
        .ok_or_else(|| anyhow::anyhow!("external local Runtime is missing"))?;
    let acp = components
        .iter()
        .find(|component| matches!(component.kind.as_str(), "acp_adapter" | "combined_runtime"))
        .ok_or_else(|| anyhow::anyhow!("external ACP executable is missing"))?;
    let args = profile
        .install_sources
        .iter()
        .find_map(|source| match source {
            ProfileInstallSource::Npx {
                component, args, ..
            }
            | ProfileInstallSource::Binary {
                component, args, ..
            } if profile_component_key(*component) == acp.kind => Some(
                args.iter()
                    .map(|argument| (*argument).to_string())
                    .collect::<Vec<_>>(),
            ),
            _ => None,
        })
        .unwrap_or_default();
    let mut env = BTreeMap::new();
    let mut path_entries = components
        .iter()
        .filter_map(|component| component.absolute_path.parent().map(Path::to_path_buf))
        .collect::<Vec<_>>();
    path_entries.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    env.insert(
        "PATH".to_string(),
        std::env::join_paths(path_entries)?
            .to_string_lossy()
            .to_string(),
    );
    bind_profile_runtime_executable(&profile.agent_id, &runtime.absolute_path, &mut env);
    let launch_lock = SessionLaunchLock {
        agent_id: profile.agent_id.clone(),
        absolute_acp_program: acp.absolute_path.clone(),
        args,
        env,
        runtime_version: runtime.version.clone(),
        acp_version: acp.version.clone(),
    };
    let working_dir = app
        .path()
        .app_data_dir()?
        .join("agents")
        .join(profile.agent_id.as_str());
    tokio::fs::create_dir_all(&working_dir).await?;
    verify_acp_handshake(
        &profile.agent_id,
        &launch_lock,
        &working_dir,
        &CancellationToken::new(),
    )
    .await?;

    let plan = ResolvedInstallPlan {
        agent_id: profile.agent_id.clone(),
        source: LockedInstallSource::BuiltInProfile,
        version: acp.version.clone(),
        platform: agents::current_platform(),
        components: components
            .iter()
            .map(|component| PlannedInstallComponent {
                component_id: component.kind.clone(),
                distribution_kind: PlannedDistributionKind::Binary,
                version: component.version.clone(),
                resolved_source: component.absolute_path.display().to_string(),
                command: component
                    .absolute_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default()
                    .to_string(),
                args: Vec::new(),
                env: Default::default(),
                trust: ArtifactTrust::Tofu,
            })
            .collect(),
    };
    persist_installed_lock(
        pool,
        Uuid::new_v4(),
        &plan,
        &InstalledPlan {
            launch_lock,
            components,
        },
        "external",
    )
    .await?;
    record_post_install_probe(app, pool, &profile.agent_id).await
}

fn profile_component_key(component: ProfileComponent) -> &'static str {
    match component {
        ProfileComponent::AgentRuntime => "agent_runtime",
        ProfileComponent::AcpAdapter => "acp_adapter",
        ProfileComponent::CombinedRuntime => "combined_runtime",
    }
}

fn bind_profile_runtime_executable(
    agent_id: &AgentId,
    runtime_path: &Path,
    env: &mut BTreeMap<String, String>,
) {
    if let Some(variable) = BuiltInProfileCatalog::bundled()
        .profile(agent_id)
        .and_then(|profile| profile.runtime_executable_env)
    {
        env.insert(variable.to_string(), runtime_path.display().to_string());
    }
}

pub(crate) fn management_error(
    code: AgentManagementErrorCode,
    message: impl Into<String>,
    agent_id: Option<AgentId>,
) -> AgentManagementErrorView {
    AgentManagementErrorView {
        code,
        message: message.into(),
        agent_id,
        preflight_item_id: None,
    }
}

pub(crate) fn operation_event(
    sequence: u32,
    agent_id: AgentId,
    operation_id: impl Into<String>,
    kind: AgentOperationKind,
    status: AgentOperationStatus,
    progress_percent: Option<u8>,
    message: Option<String>,
) -> AgentOperationEvent {
    AgentOperationEvent {
        sequence,
        agent_id,
        operation_id: operation_id.into(),
        kind,
        status,
        progress_percent,
        message,
    }
}

fn internal_error(error: impl std::fmt::Display) -> AgentManagementErrorView {
    management_error(AgentManagementErrorCode::Internal, error.to_string(), None)
}

fn emit_operation(
    app: &AppHandle,
    agent_id: AgentId,
    operation_id: &str,
    kind: AgentOperationKind,
    status: AgentOperationStatus,
    progress_percent: Option<u8>,
    message: Option<String>,
) {
    let event = operation_event(
        u32::try_from(EVENT_SEQUENCE.fetch_add(1, Ordering::SeqCst) + 1).unwrap_or(u32::MAX),
        agent_id,
        operation_id,
        kind,
        status,
        progress_percent,
        message,
    );
    if let Err(error) = app.emit(MANAGEMENT_EVENT, event) {
        tracing::warn!(%error, "failed to emit Agent management operation event");
    }
}

#[tauri::command]
pub async fn agent_management_bar(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AgentManagementView>, AgentManagementErrorView> {
    AgentManagementApplicationService::new(state.deployment.db().pool.clone())
        .list()
        .await
        .map_err(internal_error)
}

#[tauri::command]
pub async fn agent_management_refresh(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AgentManagementView>, AgentManagementErrorView> {
    refresh_agent_management_evidence(&app, &state.deployment.db().pool).await?;
    AgentManagementApplicationService::new(state.deployment.db().pool.clone())
        .list()
        .await
        .map_err(internal_error)
}

#[tauri::command]
pub async fn agent_management_detail(
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<AgentManagementView, AgentManagementErrorView> {
    AgentManagementApplicationService::new(state.deployment.db().pool.clone())
        .list()
        .await
        .map_err(internal_error)?
        .into_iter()
        .find(|view| view.agent_id == agent_id)
        .ok_or_else(|| {
            management_error(
                AgentManagementErrorCode::NotFound,
                format!("Agent `{agent_id}` has not been added"),
                Some(agent_id),
            )
        })
}

#[tauri::command]
pub async fn agent_registry_view(
    state: tauri::State<'_, AppState>,
) -> Result<AgentRegistryView, AgentManagementErrorView> {
    let store = AgentRegistrySnapshotStore::new(RegistrySnapshotRepository::new(
        state.deployment.db().pool.clone(),
    ));
    let snapshot = store.load().await.map_err(internal_error)?;
    let freshness = snapshot
        .as_ref()
        .map(|snapshot| {
            if Utc::now().signed_duration_since(snapshot.fetched_at) <= Duration::hours(24) {
                RegistryCacheFreshness::Fresh
            } else {
                RegistryCacheFreshness::Stale
            }
        })
        .unwrap_or(RegistryCacheFreshness::Empty);
    AgentManagementApplicationService::new(state.deployment.db().pool.clone())
        .registry_view(freshness, None)
        .await
        .map_err(internal_error)
}

#[tauri::command]
pub async fn agent_registry_refresh(
    state: tauri::State<'_, AppState>,
) -> Result<AgentRegistryView, AgentManagementErrorView> {
    let store = AgentRegistrySnapshotStore::new(RegistrySnapshotRepository::new(
        state.deployment.db().pool.clone(),
    ));
    let mut cache = store
        .load()
        .await
        .map_err(internal_error)?
        .map(RegistryCache::from_snapshot)
        .unwrap_or_default();
    let client = RegistrySnapshotClient::new(
        Arc::new(OfficialRegistryHttpFetcher::default()),
        Arc::new(SystemClock),
    );
    let view = client.refresh(&mut cache).await;
    if view.refresh_error.is_none()
        && let Some(snapshot) = cache.snapshot()
    {
        store.save(snapshot).await.map_err(internal_error)?;
    }
    AgentManagementApplicationService::new(state.deployment.db().pool.clone())
        .registry_view(view.freshness, view.refresh_error)
        .await
        .map_err(internal_error)
}

#[tauri::command]
pub async fn agent_registry_add_and_install(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<AgentOperationReceipt, AgentManagementErrorView> {
    AgentManagementApplicationService::new(state.deployment.db().pool.clone())
        .add(agent_id.clone())
        .await
        .map_err(|error| {
            management_error(
                AgentManagementErrorCode::RegistryUnavailable,
                error.to_string(),
                Some(agent_id.clone()),
            )
        })?;
    queue_operation(
        &app,
        &state.deployment.db().pool,
        agent_id,
        AgentOperationKind::Install,
    )
    .await
}

#[tauri::command]
pub async fn agent_management_set_enabled(
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
    enabled: bool,
) -> Result<AgentManagementView, AgentManagementErrorView> {
    let changed = sqlx::query(
        "UPDATE agent_membership SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE agent_id = ?",
    )
    .bind(enabled)
    .bind(agent_id.as_str())
    .execute(&state.deployment.db().pool)
    .await
    .map_err(internal_error)?
    .rows_affected();
    if changed == 0 {
        return Err(management_error(
            AgentManagementErrorCode::NotFound,
            format!("Agent `{agent_id}` has not been added"),
            Some(agent_id),
        ));
    }
    agent_management_detail(state, agent_id).await
}

#[tauri::command]
pub async fn agent_management_reorder(
    state: tauri::State<'_, AppState>,
    agent_ids: Vec<AgentId>,
) -> Result<Vec<AgentManagementView>, AgentManagementErrorView> {
    AgentMembershipRepository::new(state.deployment.db().pool.clone())
        .reorder(&agent_ids)
        .await
        .map_err(internal_error)?;
    AgentManagementApplicationService::new(state.deployment.db().pool.clone())
        .list()
        .await
        .map_err(internal_error)
}

#[tauri::command]
pub async fn agent_management_preflight(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<AgentPreflightView, AgentManagementErrorView> {
    let view = agent_management_detail(state.clone(), agent_id.clone()).await?;
    let status = |pass: bool| if pass { "pass" } else { "fail" }.to_string();
    let pool = &state.deployment.db().pool;
    let lock = sqlx::query_as::<_, (String, String)>(
        r#"SELECT lock.id, lock.resolved_json
           FROM agent_installation installation
           JOIN agent_install_lock lock ON lock.id = installation.current_lock_id
           WHERE installation.agent_id = ?"#,
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await
    .map_err(internal_error)?;
    let components = if let Some((lock_id, _)) = &lock {
        sqlx::query_as::<_, (String, String, String, Option<String>, String)>(
            r#"SELECT component_kind, absolute_path, version, sha256, ownership
               FROM agent_install_component WHERE lock_id = ?"#,
        )
        .bind(lock_id)
        .fetch_all(pool)
        .await
        .map_err(internal_error)?
    } else {
        Vec::new()
    };
    let mut checked_components = Vec::with_capacity(components.len());
    for (kind, path, version, expected_sha256, ownership) in components {
        let path = PathBuf::from(path);
        let mut healthy = path.is_absolute() && path.is_file();
        if healthy
            && ownership == "external"
            && let Some(expected) = expected_sha256
        {
            healthy = tokio::fs::read(&path)
                .await
                .map(|bytes| format!("{:x}", Sha256::digest(bytes)) == expected)
                .unwrap_or(false);
        }
        checked_components.push((kind, path, version, healthy));
    }
    let component_available = |kinds: &[&str]| {
        checked_components
            .iter()
            .find(|(kind, _, _, healthy)| kinds.contains(&kind.as_str()) && *healthy)
    };
    let runtime = component_available(&["agent_runtime", "combined_runtime"]);
    let acp = component_available(&["acp_adapter", "combined_runtime"]);
    let runtime_ok = runtime.is_some();
    let mut acp_ok = false;
    let mut authentication_observation = None;
    if let (Some((_, resolved_json)), Some(_)) = (&lock, acp) {
        #[derive(serde::Deserialize)]
        struct LockedPayload {
            absolute_acp_program: PathBuf,
            #[serde(default)]
            args: Vec<String>,
            #[serde(default)]
            env: BTreeMap<String, String>,
            runtime_version: String,
            acp_version: String,
        }
        if let Ok(payload) = serde_json::from_str::<LockedPayload>(resolved_json) {
            let working_dir = app
                .path()
                .app_data_dir()
                .map_err(internal_error)?
                .join("agents")
                .join(agent_id.as_str());
            let launch_lock = SessionLaunchLock {
                agent_id: agent_id.clone(),
                absolute_acp_program: payload.absolute_acp_program,
                args: payload.args,
                env: payload.env,
                runtime_version: payload.runtime_version,
                acp_version: payload.acp_version,
            };
            match probe_acp_capabilities(
                &agent_id,
                &launch_lock,
                &working_dir,
                &CancellationToken::new(),
            )
            .await
            {
                Ok(capabilities) => {
                    acp_ok = true;
                    authentication_observation = capabilities.authentication;
                }
                Err(_) => acp_ok = false,
            }
        }
    }
    let native_authentication = if let Ok(home) = app.path().home_dir() {
        let account_logged_in = detect_account_login(&home, &agent_id).await;
        let provider = NativeConfigProvider::bundled(Arc::new(TokioNativeFileSystem), home);
        match provider.read(&agent_id, account_logged_in).await {
            Ok(snapshot) => snapshot.authentication,
            Err(agents::NativeConfigError::Unsupported(_)) => {
                AgentAuthenticationStatus::NotRequired
            }
            Err(_) => AgentAuthenticationStatus::NotLoggedIn,
        }
    } else {
        AgentAuthenticationStatus::NotLoggedIn
    };
    let authentication_required_by_default = BuiltInProfileCatalog::bundled()
        .profile(&agent_id)
        .is_some_and(|profile| profile.authentication_required_by_default);
    let (authentication, authentication_required) = resolve_authentication_observation(
        native_authentication,
        authentication_observation.as_ref(),
        authentication_required_by_default,
    );
    let lifecycle = if !runtime_ok || !acp_ok {
        AgentLifecycleState::NeedsRepair
    } else if authentication_required
        && matches!(
            authentication,
            AgentAuthenticationStatus::NotLoggedIn | AgentAuthenticationStatus::MultipleUnknown
        )
    {
        AgentLifecycleState::NeedsAuth
    } else {
        AgentLifecycleState::Ready
    };
    AgentManagementApplicationService::new(pool.clone())
        .record_probe(
            &agent_id,
            lifecycle,
            authentication,
            runtime_ok,
            acp_ok,
            authentication_required,
        )
        .await
        .map_err(internal_error)?;
    Ok(AgentPreflightView {
        agent_id,
        checked_at: Utc::now().to_rfc3339(),
        items: vec![
            AgentPreflightItemView {
                id: "membership".to_string(),
                label: "运行入口".to_string(),
                status: status(!view.retired),
                detail: if view.retired {
                    "此 Agent 仅保留历史记录。".to_string()
                } else {
                    "Agent 已加入本地列表。".to_string()
                },
                repairable: false,
            },
            AgentPreflightItemView {
                id: "runtime".to_string(),
                label: "本地 Runtime".to_string(),
                status: status(runtime_ok),
                detail: runtime
                    .map(|(_, _, version, _)| format!("版本 {version}"))
                    .unwrap_or_else(|| "未发现有效的当前安装锁。".to_string()),
                repairable: true,
            },
            AgentPreflightItemView {
                id: "acp".to_string(),
                label: "ACP 适配器".to_string(),
                status: status(acp_ok),
                detail: acp
                    .filter(|_| acp_ok)
                    .map(|(_, _, version, _)| format!("版本 {version}，握手成功"))
                    .unwrap_or_else(|| "未通过 ACP 探测。".to_string()),
                repairable: true,
            },
        ],
    })
}

#[tauri::command]
pub async fn agent_management_repair(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<AgentOperationReceipt, AgentManagementErrorView> {
    queue_operation(
        &app,
        &state.deployment.db().pool,
        agent_id,
        AgentOperationKind::Repair,
    )
    .await
}

#[tauri::command]
pub async fn agent_management_check_update(
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<AgentUpdateCheckView, AgentManagementErrorView> {
    let current_version = sqlx::query_scalar::<_, String>(
        r#"SELECT lock.registry_version
           FROM agent_installation installation
           JOIN agent_install_lock lock ON lock.id = installation.current_lock_id
           WHERE installation.agent_id = ?"#,
    )
    .bind(agent_id.as_str())
    .fetch_optional(&state.deployment.db().pool)
    .await
    .map_err(internal_error)?;
    let snapshot = AgentRegistrySnapshotStore::new(RegistrySnapshotRepository::new(
        state.deployment.db().pool.clone(),
    ))
    .load()
    .await
    .map_err(internal_error)?;
    let available_version = snapshot.as_ref().and_then(|snapshot| {
        snapshot
            .entries
            .iter()
            .find(|entry| entry.agent_id == agent_id)
            .map(|entry| entry.version.clone())
    });
    let fresh = snapshot.as_ref().is_some_and(|snapshot| {
        Utc::now().signed_duration_since(snapshot.fetched_at) <= Duration::hours(24)
    });
    Ok(AgentUpdateCheckView {
        agent_id,
        update_available: current_version
            .as_ref()
            .zip(available_version.as_ref())
            .is_some_and(|(current, available)| current != available),
        current_version,
        available_version,
        snapshot_id: snapshot.as_ref().map(|snapshot| snapshot.id.to_string()),
        fetched_at: snapshot
            .as_ref()
            .map(|snapshot| snapshot.fetched_at.to_rfc3339()),
        fresh,
    })
}

#[tauri::command]
pub async fn agent_management_apply_update(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<AgentOperationReceipt, AgentManagementErrorView> {
    queue_operation(
        &app,
        &state.deployment.db().pool,
        agent_id,
        AgentOperationKind::Update,
    )
    .await
}

#[tauri::command]
pub async fn agent_management_rollback(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<AgentManagementView, AgentManagementErrorView> {
    let installation =
        sqlx::query_as::<_, (Option<String>, Option<String>, Option<String>, String)>(
            r#"SELECT active_operation, current_lock_id, rollback_lock_id, ownership
           FROM agent_installation
           WHERE agent_id = ?"#,
        )
        .bind(agent_id.as_str())
        .fetch_optional(&state.deployment.db().pool)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| {
            management_error(
                AgentManagementErrorCode::NotFound,
                format!("Agent `{agent_id}` has not been added"),
                Some(agent_id.clone()),
            )
        })?;
    if installation.0.is_some() {
        return Err(management_error(
            AgentManagementErrorCode::Busy,
            "Agent 已有正在执行的管理操作",
            Some(agent_id),
        ));
    }
    let rollback_lock_id = installation.2.as_deref().ok_or_else(|| {
        management_error(
            AgentManagementErrorCode::InvalidState,
            "Agent 没有可回滚的上一版本",
            Some(agent_id.clone()),
        )
    })?;
    let mut cli_switch = None;
    if installation.3 == "managed" {
        let current_runtime = match installation.1.as_deref() {
            Some(lock_id) => managed_runtime_for_lock(&state.deployment.db().pool, lock_id)
                .await
                .map_err(internal_error)?,
            None => None,
        };
        let rollback_runtime =
            managed_runtime_for_lock(&state.deployment.db().pool, rollback_lock_id)
                .await
                .map_err(internal_error)?
                .ok_or_else(|| {
                    management_error(
                        AgentManagementErrorCode::InvalidState,
                        "上一版本没有有效的本地 Runtime",
                        Some(agent_id.clone()),
                    )
                })?;
        let app_data_dir = app.path().app_data_dir().map_err(internal_error)?;
        let home_dir = app.path().home_dir().map_err(internal_error)?;
        let root = managed_install_root(&app_data_dir, &agent_id).map_err(internal_error)?;
        let shell = configured_shell_family();
        let _ = utils::shell::refresh_process_path_after_install().await;
        switch_managed_runtime_cli(
            &home_dir,
            &agent_id,
            &root,
            current_runtime.as_deref(),
            &rollback_runtime,
            shell,
        )
        .map_err(internal_error)?;
        cli_switch = Some((home_dir, root, current_runtime, rollback_runtime, shell));
    }
    let update = sqlx::query(
        r#"UPDATE agent_installation
           SET current_lock_id = rollback_lock_id,
               rollback_lock_id = current_lock_id,
               lifecycle = 'ready',
               updated_at = CURRENT_TIMESTAMP
           WHERE agent_id = ? AND rollback_lock_id IS NOT NULL"#,
    )
    .bind(agent_id.as_str())
    .execute(&state.deployment.db().pool)
    .await;
    let changed = match update {
        Ok(result) => result.rows_affected(),
        Err(error) => {
            if let Some((home, root, current, rollback, shell)) = &cli_switch
                && let Err(restore_error) = restore_managed_cli_switch(
                    home,
                    &agent_id,
                    root,
                    current.as_deref(),
                    rollback,
                    *shell,
                )
            {
                tracing::error!(
                    agent_id = %agent_id,
                    %restore_error,
                    "failed to restore terminal command after rollback database failure"
                );
            }
            return Err(internal_error(error));
        }
    };
    if changed == 0 {
        if let Some((home, root, current, rollback, shell)) = &cli_switch
            && let Err(error) = restore_managed_cli_switch(
                home,
                &agent_id,
                root,
                current.as_deref(),
                rollback,
                *shell,
            )
        {
            tracing::error!(
                agent_id = %agent_id,
                %error,
                "failed to restore terminal command after rejected rollback"
            );
        }
        return Err(management_error(
            AgentManagementErrorCode::InvalidState,
            "Agent 没有可回滚的上一版本",
            Some(agent_id),
        ));
    }
    sqlx::query("DELETE FROM agent_probe WHERE agent_id = ?")
        .bind(agent_id.as_str())
        .execute(&state.deployment.db().pool)
        .await
        .map_err(internal_error)?;
    let _ = utils::shell::refresh_process_path_after_install().await;
    agent_management_detail(state, agent_id).await
}

async fn queue_operation(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    agent_id: AgentId,
    kind: AgentOperationKind,
) -> Result<AgentOperationReceipt, AgentManagementErrorView> {
    let kind_key = operation_kind_key(kind);
    let plan = match kind {
        AgentOperationKind::Repair => resolve_repair_plan(pool, &agent_id).await,
        _ => resolve_install_plan(pool, &agent_id).await,
    }
    .map_err(|error| {
        management_error(
            AgentManagementErrorCode::InvalidState,
            error.to_string(),
            Some(agent_id.clone()),
        )
    })?;
    let frozen_plan_json = serde_json::to_string(&plan).map_err(internal_error)?;
    let resource_claims = install_resource_claims(&plan);
    let operation = InstallationOperationRepository::new(pool.clone())
        .enqueue(NewInstallationOperation {
            agent_id: agent_id.clone(),
            kind: kind_key.to_string(),
            frozen_plan_json,
            host_instance_id: host_instance_id().to_string(),
            resource_claims,
            staging_path: None,
        })
        .await
        .map_err(|error| {
            let message = error.to_string();
            if message.contains("UNIQUE constraint failed") {
                management_error(
                    AgentManagementErrorCode::Busy,
                    "Agent 已有正在执行的管理操作，或所需共享资源正被占用",
                    Some(agent_id.clone()),
                )
            } else {
                internal_error(error)
            }
        })?;
    let operation_id = operation.id.to_string();
    let cancellation = OperationScheduler::shared()
        .cancellations
        .register(&operation_id);
    emit_operation(
        app,
        agent_id.clone(),
        &operation_id,
        kind,
        AgentOperationStatus::Queued,
        Some(0),
        None,
    );
    let app = app.clone();
    let pool = pool.clone();
    let operation_agent_id = agent_id.clone();
    let operation_id_for_task = operation_id.clone();
    tauri::async_runtime::spawn(async move {
        run_install_operation(
            app,
            pool,
            operation_agent_id,
            operation_id_for_task,
            kind,
            plan,
            cancellation,
        )
        .await;
    });
    Ok(AgentOperationReceipt {
        operation_id,
        agent_id,
        kind,
        status: AgentOperationStatus::Queued,
    })
}

async fn run_install_operation(
    app: AppHandle,
    pool: sqlx::SqlitePool,
    agent_id: AgentId,
    operation_id: String,
    kind: AgentOperationKind,
    plan: ResolvedInstallPlan,
    cancellation: CancellationToken,
) {
    let scheduler = OperationScheduler::shared();
    let _global = tokio::select! {
        permit = scheduler.global.acquire() => {
            permit.expect("Agent operation semaphore remains open")
        }
        () = cancellation.cancelled() => {
            finish_canceled_operation(&app, &pool, &agent_id, &operation_id, kind).await;
            scheduler.cancellations.remove(&operation_id);
            return;
        }
    };
    let agent_lock = scheduler.agent_lock(&agent_id);
    let _agent = tokio::select! {
        guard = agent_lock.lock() => guard,
        () = cancellation.cancelled() => {
            finish_canceled_operation(&app, &pool, &agent_id, &operation_id, kind).await;
            scheduler.cancellations.remove(&operation_id);
            return;
        }
    };
    let lifecycle = match kind {
        AgentOperationKind::Update => "updating",
        AgentOperationKind::Repair => "repairing",
        _ => "installing",
    };
    if let Ok(operation_uuid) = Uuid::parse_str(&operation_id)
        && let Err(error) = InstallationOperationRepository::new(pool.clone())
            .mark_running(operation_uuid, host_instance_id())
            .await
    {
        finish_failed_operation(
            &app,
            &pool,
            &agent_id,
            &operation_id,
            kind,
            error.to_string(),
        )
        .await;
        return;
    }
    if let Err(error) = sqlx::query(
        "UPDATE agent_installation SET lifecycle = ?, updated_at = CURRENT_TIMESTAMP WHERE agent_id = ?",
    )
    .bind(lifecycle)
    .bind(agent_id.as_str())
    .execute(&pool)
    .await
    {
        finish_failed_operation(&app, &pool, &agent_id, &operation_id, kind, error.to_string()).await;
        return;
    }
    emit_operation(
        &app,
        agent_id.clone(),
        &operation_id,
        kind,
        AgentOperationStatus::Running,
        Some(5),
        Some("正在解析已锁定的安装方案".to_string()),
    );

    let result = async {
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        let root = managed_install_root(&app_data_dir, &agent_id)?;
        tokio::fs::create_dir_all(&root).await?;
        let lock_id = Uuid::new_v4();
        let staging = root.join(format!(".staging-{lock_id}"));
        if let Ok(operation_uuid) = Uuid::parse_str(&operation_id) {
            InstallationOperationRepository::new(pool.clone())
                .set_staging_path(operation_uuid, &staging.display().to_string())
                .await?;
        }
        tokio::fs::create_dir_all(&staging).await?;
        emit_operation(
            &app,
            agent_id.clone(),
            &operation_id,
            kind,
            AgentOperationStatus::Running,
            Some(20),
            Some("正在安装本地 Runtime 与 ACP".to_string()),
        );
        let tofu_fingerprints = previous_tofu_fingerprints(&pool, &agent_id).await?;
        let installation =
            install_locked_plan(&plan, &staging, &cancellation, &tofu_fingerprints).await;
        let installation = match installation {
            Ok(installation) => installation,
            Err(error) => {
                let _ = tokio::fs::remove_dir_all(&staging).await;
                return Err(error);
            }
        };
        emit_operation(
            &app,
            agent_id.clone(),
            &operation_id,
            kind,
            AgentOperationStatus::Running,
            Some(75),
            Some("正在验证 ACP 握手".to_string()),
        );
        if let Err(error) = verify_acp_handshake(
            &agent_id,
            &installation.launch_lock,
            &staging,
            &cancellation,
        )
        .await
        {
            let _ = tokio::fs::remove_dir_all(&staging).await;
            return Err(error);
        }
        if cancellation.is_cancelled() {
            let _ = tokio::fs::remove_dir_all(&staging).await;
            anyhow::bail!("operation canceled");
        }
        emit_operation(
            &app,
            agent_id.clone(),
            &operation_id,
            kind,
            AgentOperationStatus::Running,
            Some(85),
            Some("正在发布本地终端命令".to_string()),
        );
        let previous_runtime = current_managed_runtime(&pool, &agent_id).await?;
        let runtime_executable = installation.runtime_executable()?.to_path_buf();
        let home_dir = app
            .path()
            .home_dir()
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        let shell = configured_shell_family();
        let _ = utils::shell::refresh_process_path_after_install().await;
        switch_managed_runtime_cli(
            &home_dir,
            &agent_id,
            &root,
            previous_runtime.as_deref(),
            &runtime_executable,
            shell,
        )?;
        if let Err(error) =
            persist_installed_lock(&pool, lock_id, &plan, &installation, "managed").await
        {
            if let Err(restore_error) = restore_managed_cli_switch(
                &home_dir,
                &agent_id,
                &root,
                previous_runtime.as_deref(),
                &runtime_executable,
                shell,
            ) {
                tracing::error!(
                    agent_id = %agent_id,
                    %restore_error,
                    "failed to restore Agent terminal command after lock persistence failure"
                );
            }
            let _ = tokio::fs::remove_dir_all(&staging).await;
            return Err(error);
        }
        CLI_EXPOSURES
            .get_or_init(|| AsyncMutex::new(HashSet::new()))
            .lock()
            .await
            .insert(agent_id.clone());
        let _ = utils::shell::refresh_process_path_after_install().await;
        record_post_install_probe(&app, &pool, &agent_id).await?;
        Ok::<_, anyhow::Error>(())
    }
    .await;

    match result {
        Ok(()) => {
            let _ = sqlx::query(
                "UPDATE agent_installation SET lifecycle = 'ready', active_operation = NULL, active_operation_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE agent_id = ?",
            )
            .bind(agent_id.as_str())
            .execute(&pool)
            .await;
            if let Ok(operation_uuid) = Uuid::parse_str(&operation_id) {
                let _ = InstallationOperationRepository::new(pool.clone())
                    .finish(operation_uuid, "succeeded")
                    .await;
            }
            emit_operation(
                &app,
                agent_id,
                &operation_id,
                kind,
                AgentOperationStatus::Succeeded,
                Some(100),
                Some("安装与 ACP 验证完成".to_string()),
            );
        }
        Err(_error) if cancellation.is_cancelled() => {
            finish_canceled_operation(&app, &pool, &agent_id, &operation_id, kind).await;
        }
        Err(error) => {
            finish_failed_operation(
                &app,
                &pool,
                &agent_id,
                &operation_id,
                kind,
                redact_operation_output(&error.to_string()),
            )
            .await;
        }
    }
    scheduler.cancellations.remove(&operation_id);
}

async fn record_post_install_probe(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
) -> anyhow::Result<()> {
    #[derive(serde::Deserialize)]
    struct LockedPayload {
        absolute_acp_program: PathBuf,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
        runtime_version: String,
        acp_version: String,
    }

    let resolved_json = sqlx::query_scalar::<_, String>(
        r#"SELECT lock.resolved_json
           FROM agent_installation installation
           JOIN agent_install_lock lock ON lock.id = installation.current_lock_id
           WHERE installation.agent_id = ?"#,
    )
    .bind(agent_id.as_str())
    .fetch_one(pool)
    .await?;
    let payload: LockedPayload = serde_json::from_str(&resolved_json)?;
    let launch_lock = SessionLaunchLock {
        agent_id: agent_id.clone(),
        absolute_acp_program: payload.absolute_acp_program,
        args: payload.args,
        env: payload.env,
        runtime_version: payload.runtime_version,
        acp_version: payload.acp_version,
    };
    let working_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| anyhow::anyhow!(error.to_string()))?
        .join("agents")
        .join(agent_id.as_str());
    tokio::fs::create_dir_all(&working_dir).await?;
    let capabilities = probe_acp_capabilities(
        agent_id,
        &launch_lock,
        &working_dir,
        &CancellationToken::new(),
    )
    .await?;
    let native_authentication = if let Ok(home) = app.path().home_dir() {
        let account_logged_in = detect_account_login(&home, agent_id).await;
        let provider = NativeConfigProvider::bundled(Arc::new(TokioNativeFileSystem), home);
        match provider.read(agent_id, account_logged_in).await {
            Ok(snapshot) => snapshot.authentication,
            Err(agents::NativeConfigError::Unsupported(_)) => {
                AgentAuthenticationStatus::NotRequired
            }
            Err(error) => return Err(error.into()),
        }
    } else {
        AgentAuthenticationStatus::NotRequired
    };
    let authentication_required_by_default = BuiltInProfileCatalog::bundled()
        .profile(agent_id)
        .is_some_and(|profile| profile.authentication_required_by_default);
    let (authentication, authentication_required) = resolve_authentication_observation(
        native_authentication,
        capabilities.authentication.as_ref(),
        authentication_required_by_default,
    );
    sync_authentication_probe_with_requirement(
        pool,
        agent_id,
        authentication,
        authentication_required,
    )
    .await
    .map_err(|error| anyhow::anyhow!(error.message))
}

async fn detect_account_login(home: &Path, agent_id: &AgentId) -> bool {
    let catalog = BuiltInProfileCatalog::bundled();
    let Some(evidence) = catalog
        .profile(agent_id)
        .and_then(|profile| profile.account_evidence.as_ref())
    else {
        return false;
    };
    let directory = evidence
        .directory_override_env
        .and_then(std::env::var_os)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(evidence.home_relative_directory));
    let Ok(bytes) = tokio::fs::read(directory.join(evidence.relative_file)).await else {
        return false;
    };
    serde_json::from_slice::<serde_json::Value>(&bytes).is_ok_and(|value| evidence.matches(&value))
}

async fn resolve_install_plan(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
) -> anyhow::Result<ResolvedInstallPlan> {
    let environment = InstallEnvironment {
        node_verified: which::which("node").is_ok() && which::which("npm").is_ok(),
        uv_verified: which::which("uv").is_ok(),
        python_verified: which::which("python3")
            .or_else(|_| which::which("python"))
            .is_ok(),
    };
    let source = if BuiltInProfileCatalog::bundled().profile(agent_id).is_some() {
        InstallCandidateSource::BuiltInProfile
    } else {
        let store = AgentRegistrySnapshotStore::new(RegistrySnapshotRepository::new(pool.clone()));
        let snapshot = store
            .load()
            .await?
            .ok_or_else(|| anyhow::anyhow!("ACP Registry 缓存为空，请先刷新注册表"))?;
        if Utc::now().signed_duration_since(snapshot.fetched_at) > Duration::hours(24) {
            anyhow::bail!("ACP Registry 快照已过期，请先刷新注册表");
        }
        let entry = snapshot
            .entries
            .iter()
            .find(|entry| &entry.agent_id == agent_id)
            .ok_or_else(|| anyhow::anyhow!("Agent 已从当前 ACP Registry 下架，无法重新安装"))?;
        InstallCandidateSource::Registry(Box::new(entry.lock_add_target(snapshot.id)))
    };
    InstallPlanner::bundled()
        .plan(InstallPlanningInput {
            agent_id: agent_id.clone(),
            source,
            platform: agents::current_platform(),
            environment,
        })
        .map_err(Into::into)
}

async fn resolve_repair_plan(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
) -> anyhow::Result<ResolvedInstallPlan> {
    let resolved_json = sqlx::query_scalar::<_, String>(
        r#"SELECT lock.resolved_json
           FROM agent_installation installation
           JOIN agent_install_lock lock ON lock.id = installation.current_lock_id
           WHERE installation.agent_id = ?"#,
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| anyhow::anyhow!("Agent 没有可用于修复的 current Installation lock"))?;
    let value: serde_json::Value = serde_json::from_str(&resolved_json)?;
    let plan = value.get("frozen_plan").cloned().ok_or_else(|| {
        anyhow::anyhow!("现有 Installation lock 缺少可复现修复计划，需要重新安装")
    })?;
    serde_json::from_value(plan).map_err(Into::into)
}

fn install_resource_claims(plan: &ResolvedInstallPlan) -> Vec<String> {
    let mut claims = vec![
        format!("agent:{}", plan.agent_id),
        format!("shim:{}", plan.agent_id),
        format!("target:{}", plan.agent_id),
    ];
    for component in &plan.components {
        match component.distribution_kind {
            PlannedDistributionKind::Npx => {
                claims.push("runtime:node".to_string());
                claims.push("cache:npm".to_string());
            }
            PlannedDistributionKind::Uvx => {
                claims.push("runtime:python".to_string());
                claims.push("runtime:uv".to_string());
                claims.push("cache:uv".to_string());
            }
            PlannedDistributionKind::Binary => {}
        }
    }
    claims.sort();
    claims.dedup();
    claims
}

struct InstalledComponent {
    kind: String,
    absolute_path: PathBuf,
    version: String,
    sha256: Option<String>,
    trust_state: String,
    ownership: String,
}

struct InstalledPlan {
    launch_lock: SessionLaunchLock,
    components: Vec<InstalledComponent>,
}

impl InstalledPlan {
    fn runtime_executable(&self) -> anyhow::Result<&Path> {
        self.components
            .iter()
            .find(|component| {
                matches!(
                    component.kind.as_str(),
                    "agent_runtime" | "combined_runtime"
                )
            })
            .map(|component| component.absolute_path.as_path())
            .ok_or_else(|| anyhow::anyhow!("安装方案没有本地 Runtime 组件"))
    }
}

async fn install_locked_plan(
    plan: &ResolvedInstallPlan,
    staging: &Path,
    cancellation: &CancellationToken,
    previous_tofu_fingerprints: &HashMap<String, String>,
) -> anyhow::Result<InstalledPlan> {
    let mut components = Vec::new();
    let mut path_entries = Vec::new();
    for (index, component) in plan.components.iter().enumerate() {
        let component_root = staging.join(format!("{index}-{}", component.component_id));
        tokio::fs::create_dir_all(&component_root).await?;
        let (absolute_path, mut sha256, trust_state) = match component.distribution_kind {
            PlannedDistributionKind::Npx => {
                verify_npm_integrity(&component.resolved_source, &component.trust, cancellation)
                    .await?;
                let mut command = tokio::process::Command::new("npm");
                command
                    .arg("install")
                    .arg("--prefix")
                    .arg(&component_root)
                    .arg("--no-audit")
                    .arg("--no-fund")
                    .arg("--save=false")
                    .arg(&component.resolved_source);
                let output = cancellable_command_output(command, cancellation).await?;
                ensure_success("npm install", &output)?;
                let bin_dir = component_root.join("node_modules").join(".bin");
                path_entries.push(bin_dir.clone());
                let executable = resolve_npm_package_executable(
                    &component_root,
                    &bin_dir,
                    &component.resolved_source,
                )
                .await?;
                (
                    executable,
                    None,
                    match component.trust {
                        ArtifactTrust::EcosystemIntegrity { .. } => "verified_integrity",
                        _ => "ecosystem_verified",
                    }
                    .to_string(),
                )
            }
            PlannedDistributionKind::Uvx => {
                let tool_dir = component_root.join("tools");
                let bin_dir = component_root.join("bin");
                let mut command = tokio::process::Command::new("uv");
                command
                    .arg("tool")
                    .arg("install")
                    .arg("--force")
                    .arg(&component.resolved_source)
                    .env("UV_TOOL_DIR", &tool_dir)
                    .env("UV_TOOL_BIN_DIR", &bin_dir);
                let output = cancellable_command_output(command, cancellation).await?;
                ensure_success("uv tool install", &output)?;
                path_entries.push(bin_dir.clone());
                let executable =
                    resolve_uv_tool_executable(&bin_dir, &component.resolved_source).await?;
                (executable, None, "ecosystem_verified".to_string())
            }
            PlannedDistributionKind::Binary => {
                let response = tokio::select! {
                    response = reqwest::get(&component.resolved_source) => response?,
                    () = cancellation.cancelled() => anyhow::bail!("operation canceled"),
                };
                if !response.status().is_success() {
                    anyhow::bail!("binary download returned HTTP {}", response.status());
                }
                let bytes = response.bytes().await?.to_vec();
                let verified = verify_artifact_bytes(
                    &component.trust,
                    &bytes,
                    previous_tofu_fingerprints
                        .get(&component.component_id)
                        .map(|sha256| TofuFingerprint {
                            sha256: sha256.clone(),
                        })
                        .as_ref(),
                )?;
                extract_binary_archive(
                    &bytes,
                    &component.resolved_source,
                    &component_root,
                    cancellation,
                )
                .await?;
                let executable = safe_archive_executable(&component_root, &component.command)?;
                (
                    executable,
                    Some(verified.sha256),
                    match component.trust {
                        ArtifactTrust::ExpectedSha256 { .. } => "verified_sha256",
                        ArtifactTrust::Tofu => "tofu",
                        _ => "verified_integrity",
                    }
                    .to_string(),
                )
            }
        };
        if !absolute_path.is_absolute() || tokio::fs::metadata(&absolute_path).await.is_err() {
            anyhow::bail!(
                "installed component `{}` has no executable at {}",
                component.component_id,
                absolute_path.display()
            );
        }
        if sha256.is_none() {
            let bytes = tokio::fs::read(&absolute_path).await?;
            sha256 = Some(format!("{:x}", Sha256::digest(bytes)));
        }
        components.push(InstalledComponent {
            kind: component.component_id.clone(),
            absolute_path,
            version: component.version.clone(),
            sha256,
            trust_state,
            ownership: "managed".to_string(),
        });
    }
    let acp = components
        .iter()
        .find(|component| component.kind == "acp_adapter" || component.kind == "combined_runtime")
        .ok_or_else(|| anyhow::anyhow!("安装方案没有 ACP 可执行组件"))?;
    let runtime = components
        .iter()
        .find(|component| component.kind == "agent_runtime" || component.kind == "combined_runtime")
        .ok_or_else(|| anyhow::anyhow!("安装方案没有本地 Runtime 组件"))?;
    let mut env = build_launch_environment(
        &plan.components,
        &path_entries,
        std::env::var_os("PATH").unwrap_or_default(),
    )?;
    bind_profile_runtime_executable(&plan.agent_id, &runtime.absolute_path, &mut env);
    Ok(InstalledPlan {
        launch_lock: SessionLaunchLock {
            agent_id: plan.agent_id.clone(),
            absolute_acp_program: acp.absolute_path.clone(),
            args: plan
                .components
                .iter()
                .find(|component| component.component_id == acp.kind)
                .map(|component| component.args.clone())
                .unwrap_or_default(),
            env,
            runtime_version: runtime.version.clone(),
            acp_version: acp.version.clone(),
        },
        components,
    })
}

fn build_launch_environment(
    components: &[PlannedInstallComponent],
    path_entries: &[PathBuf],
    inherited_path: OsString,
) -> anyhow::Result<BTreeMap<String, String>> {
    let mut env = BTreeMap::new();
    for component in components {
        for (key, value) in &component.env {
            if let Some(existing) = env.insert(key.clone(), value.clone())
                && existing != *value
            {
                anyhow::bail!("installation components declare conflicting `{key}` values");
            }
        }
    }
    if !path_entries.is_empty() {
        let inherited = env
            .remove("PATH")
            .map(OsString::from)
            .unwrap_or(inherited_path);
        let mut joined = path_entries.to_vec();
        joined.extend(std::env::split_paths(&inherited));
        env.insert(
            "PATH".to_string(),
            std::env::join_paths(joined)?.to_string_lossy().to_string(),
        );
    }
    Ok(env)
}

async fn verify_npm_integrity(
    source: &str,
    trust: &ArtifactTrust,
    cancellation: &CancellationToken,
) -> anyhow::Result<()> {
    if !matches!(
        trust,
        ArtifactTrust::EcosystemIntegrity { .. } | ArtifactTrust::EcosystemIntegrityRequired
    ) {
        return Ok(());
    }
    let mut command = tokio::process::Command::new("npm");
    command.args(["view", source, "dist.integrity", "--json"]);
    let output = cancellable_command_output(command, cancellation).await?;
    ensure_success("npm view dist.integrity", &output)?;
    let actual = String::from_utf8_lossy(&output.stdout)
        .trim()
        .trim_matches('"')
        .to_string();
    if !actual.starts_with("sha512-") && !actual.starts_with("sha256-") {
        anyhow::bail!("npm package did not publish a valid dist.integrity value");
    }
    if let ArtifactTrust::EcosystemIntegrity { integrity } = trust
        && &actual != integrity
    {
        anyhow::bail!("npm package integrity mismatch");
    }
    Ok(())
}

async fn previous_tofu_fingerprints(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
) -> anyhow::Result<HashMap<String, String>> {
    Ok(sqlx::query_as::<_, (String, String)>(
        r#"SELECT component.component_kind, component.sha256
           FROM agent_installation installation
           JOIN agent_install_component component
             ON component.lock_id = installation.current_lock_id
           WHERE installation.agent_id = ?
             AND component.trust_state = 'tofu'
             AND component.sha256 IS NOT NULL"#,
    )
    .bind(agent_id.as_str())
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect())
}

async fn cancellable_command_output(
    mut command: tokio::process::Command,
    cancellation: &CancellationToken,
) -> anyhow::Result<std::process::Output> {
    command.kill_on_drop(true);
    tokio::select! {
        output = command.output() => Ok(output?),
        () = cancellation.cancelled() => anyhow::bail!("operation canceled"),
    }
}

fn ensure_success(label: &str, output: &std::process::Output) -> anyhow::Result<()> {
    if output.status.success() {
        return Ok(());
    }
    anyhow::bail!(
        "{label} failed: {}",
        redact_operation_output(&String::from_utf8_lossy(&output.stderr))
    )
}

fn npm_executable(bin_dir: &Path, command: &str) -> PathBuf {
    #[cfg(windows)]
    {
        bin_dir.join(format!("{command}.cmd"))
    }
    #[cfg(not(windows))]
    {
        bin_dir.join(command)
    }
}

#[derive(serde::Deserialize)]
struct NpmPackageManifest {
    name: String,
    bin: NpmPackageBins,
}

#[derive(serde::Deserialize)]
#[serde(untagged)]
enum NpmPackageBins {
    Single(String),
    Named(BTreeMap<String, String>),
}

async fn resolve_npm_package_executable(
    component_root: &Path,
    bin_dir: &Path,
    package_spec: &str,
) -> anyhow::Result<PathBuf> {
    let package_name = npm_package_name(package_spec)?;
    let package_root = package_name.split('/').try_fold(
        component_root.join("node_modules"),
        |path, segment| {
            if segment.is_empty()
                || segment == "."
                || segment == ".."
                || !segment.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'@' | b'-' | b'_' | b'.')
                })
            {
                anyhow::bail!("npm package name contains an unsafe path segment");
            }
            Ok(path.join(segment))
        },
    )?;
    let manifest_bytes = tokio::fs::read(package_root.join("package.json")).await?;
    let manifest: NpmPackageManifest = serde_json::from_slice(&manifest_bytes)?;
    if manifest.name != package_name {
        anyhow::bail!(
            "installed npm package name `{}` does not match locked package `{package_name}`",
            manifest.name
        );
    }
    let preferred = package_name
        .rsplit('/')
        .next()
        .expect("validated npm package name has a final segment");
    let command = match manifest.bin {
        NpmPackageBins::Single(path) => {
            if path.trim().is_empty() {
                anyhow::bail!("npm package `{package_name}` publishes an empty binary path");
            }
            preferred.to_string()
        }
        NpmPackageBins::Named(bins) => {
            if bins.is_empty() {
                anyhow::bail!("npm package `{package_name}` publishes no executable");
            }
            if let Some(path) = bins.get(preferred) {
                if path.trim().is_empty() {
                    anyhow::bail!(
                        "npm package `{package_name}` publishes an empty binary path for `{preferred}`"
                    );
                }
                preferred.to_string()
            } else if bins.len() == 1 {
                let (command, path) = bins.into_iter().next().expect("one-entry npm bin map");
                if path.trim().is_empty() {
                    anyhow::bail!(
                        "npm package `{package_name}` publishes an empty binary path for `{command}`"
                    );
                }
                command
            } else if bins
                .values()
                .next()
                .is_some_and(|first| bins.values().all(|path| path == first))
            {
                let (command, path) = bins.into_iter().next().expect("non-empty npm alias map");
                if path.trim().is_empty() {
                    anyhow::bail!(
                        "npm package `{package_name}` publishes an empty binary path for `{command}`"
                    );
                }
                command
            } else {
                anyhow::bail!(
                    "npm package `{package_name}` publishes multiple executables without a canonical `{preferred}` entry"
                );
            }
        }
    };
    let executable = npm_executable(bin_dir, &command);
    if tokio::fs::metadata(&executable).await.is_err() {
        anyhow::bail!(
            "npm package `{package_name}` did not create executable `{}`",
            executable.display()
        );
    }
    Ok(executable)
}

fn npm_package_name(package_spec: &str) -> anyhow::Result<&str> {
    let separator = if package_spec.starts_with('@') {
        let slash = package_spec
            .find('/')
            .ok_or_else(|| anyhow::anyhow!("invalid scoped npm package spec `{package_spec}`"))?;
        package_spec[slash + 1..]
            .rfind('@')
            .map(|offset| slash + 1 + offset)
    } else {
        package_spec.rfind('@').filter(|separator| *separator > 0)
    }
    .ok_or_else(|| anyhow::anyhow!("npm package spec is not version-locked: `{package_spec}`"))?;
    let package_name = &package_spec[..separator];
    if package_name.is_empty() {
        anyhow::bail!("npm package spec has no package name");
    }
    Ok(package_name)
}

async fn resolve_uv_tool_executable(bin_dir: &Path, package_spec: &str) -> anyhow::Result<PathBuf> {
    let package_name = uv_distribution_name(package_spec)?;
    let normalized_package_name = normalize_python_command(package_name);
    let mut entries = tokio::fs::read_dir(bin_dir).await?;
    let mut executables = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if tokio::fs::metadata(&path)
            .await
            .is_ok_and(|metadata| metadata.is_file())
        {
            executables.push(path);
        }
    }
    executables.sort();
    if executables.is_empty() {
        anyhow::bail!("uv tool install for `{package_name}` produced no local executable");
    }
    if let Some(executable) = executables.iter().find(|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| normalize_python_command(name) == normalized_package_name)
    }) {
        return Ok(executable.clone());
    }
    if executables.len() == 1 {
        return Ok(executables.remove(0));
    }
    let names = executables
        .iter()
        .filter_map(|path| path.file_name().and_then(|name| name.to_str()))
        .collect::<Vec<_>>()
        .join(", ");
    anyhow::bail!(
        "uv package `{package_name}` publishes multiple executables without a canonical entry: {names}"
    )
}

fn uv_distribution_name(package_spec: &str) -> anyhow::Result<&str> {
    let without_version = if let Some((name, _version)) = package_spec.split_once("==") {
        name
    } else if let Some((name, _version)) = package_spec.rsplit_once('@') {
        name
    } else {
        anyhow::bail!("uv package spec is not version-locked: `{package_spec}`");
    };
    let name = without_version
        .split_once('[')
        .map_or(without_version, |(name, _extras)| name);
    if name.is_empty()
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        anyhow::bail!("uv package spec has an invalid distribution name");
    }
    Ok(name)
}

fn normalize_python_command(value: &str) -> String {
    let lowercase = value.to_ascii_lowercase();
    let without_windows_suffix = [".exe", ".cmd", ".bat"]
        .into_iter()
        .find_map(|suffix| lowercase.strip_suffix(suffix))
        .unwrap_or(&lowercase);
    without_windows_suffix
        .chars()
        .map(|character| match character {
            '_' | '.' => '-',
            other => other,
        })
        .collect()
}

async fn extract_binary_archive(
    bytes: &[u8],
    source: &str,
    destination: &Path,
    cancellation: &CancellationToken,
) -> anyhow::Result<()> {
    if source.to_ascii_lowercase().ends_with(".zip") {
        let bytes = bytes.to_vec();
        let destination = destination.to_path_buf();
        tokio::select! {
            result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
            let mut archive = zip::ZipArchive::new(Cursor::new(bytes))?;
            for index in 0..archive.len() {
                let mut file = archive.by_index(index)?;
                let Some(relative) = file.enclosed_name() else {
                    anyhow::bail!("binary archive contains an unsafe path");
                };
                let output = destination.join(relative);
                if file.is_dir() {
                    std::fs::create_dir_all(&output)?;
                    continue;
                }
                if let Some(parent) = output.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                let mut bytes = Vec::new();
                file.read_to_end(&mut bytes)?;
                std::fs::write(&output, bytes)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&output, std::fs::Permissions::from_mode(0o755))?;
                }
            }
            Ok(())
            }) => result??,
            () = cancellation.cancelled() => anyhow::bail!("operation canceled"),
        }
        return Ok(());
    }
    let archive = destination.join("download.archive");
    tokio::fs::write(&archive, bytes).await?;
    let mut command = tokio::process::Command::new("tar");
    command.arg("-xf").arg(&archive).arg("-C").arg(destination);
    let output = cancellable_command_output(command, cancellation).await?;
    ensure_success("binary archive extraction", &output)
}

fn safe_archive_executable(root: &Path, command: &str) -> anyhow::Result<PathBuf> {
    let candidate = root.join(command);
    if !candidate.starts_with(root) {
        anyhow::bail!("binary command escapes the installation root");
    }
    Ok(candidate)
}

async fn verify_acp_handshake(
    agent_id: &AgentId,
    lock: &SessionLaunchLock,
    working_dir: &Path,
    cancellation: &CancellationToken,
) -> anyhow::Result<()> {
    let (event_tx, _event_rx) = mpsc::unbounded_channel();
    let manager = AgentConnectionManager::new(event_tx);
    let connection_id = AgentConnectionId::new();
    let (_snapshot, ready) = manager
        .register_connection(AgentConnectionLaunch {
            connection_id,
            agent_id: agent_id.clone(),
            launch_lock: lock.clone(),
            workspace_id: Uuid::nil(),
            working_dir: working_dir.to_path_buf(),
            additional_directories: Vec::new(),
            auto_approve_mode: AgentAutoApproveMode::Off,
            env: HashMap::new(),
        })
        .await;
    tokio::select! {
        result = ready => {
            result
                .map_err(|_| anyhow::anyhow!("ACP process exited before initialize"))??
        }
        () = cancellation.cancelled() => {
            let _ = manager.disconnect(connection_id).await;
            anyhow::bail!("operation canceled");
        }
    };
    manager.disconnect(connection_id).await?;
    Ok(())
}

async fn probe_acp_capabilities(
    agent_id: &AgentId,
    lock: &SessionLaunchLock,
    working_dir: &Path,
    cancellation: &CancellationToken,
) -> anyhow::Result<AcpCapabilitySnapshot> {
    let (event_tx, _event_rx) = mpsc::unbounded_channel();
    let manager = AgentConnectionManager::new(event_tx);
    let connection_id = AgentConnectionId::new();
    let (_snapshot, ready) = manager
        .register_connection(AgentConnectionLaunch {
            connection_id,
            agent_id: agent_id.clone(),
            launch_lock: lock.clone(),
            workspace_id: Uuid::nil(),
            working_dir: working_dir.to_path_buf(),
            additional_directories: Vec::new(),
            auto_approve_mode: AgentAutoApproveMode::Off,
            env: HashMap::new(),
        })
        .await;
    let initialized: anyhow::Result<()> = tokio::select! {
        result = ready => match result {
            Ok(result) => result.map_err(Into::into),
            Err(_) => Err(anyhow::anyhow!("ACP process exited before initialize")),
        },
        () = cancellation.cancelled() => Err(anyhow::anyhow!("operation canceled")),
    };
    if let Err(error) = initialized {
        let _ = manager.disconnect(connection_id).await;
        return Err(error);
    }

    let capabilities = manager.connection_capabilities(connection_id).await;
    let disconnected = manager.disconnect(connection_id).await;
    match (capabilities, disconnected) {
        (Ok(capabilities), Ok(())) => Ok(capabilities),
        (Err(error), _) => Err(error.into()),
        (Ok(_), Err(error)) => Err(error.into()),
    }
}

fn resolve_authentication_observation(
    native_authentication: AgentAuthenticationStatus,
    observation: Option<&AcpAuthenticationObservationSnapshot>,
    authentication_required_by_default: bool,
) -> (AgentAuthenticationStatus, bool) {
    if matches!(
        native_authentication,
        AgentAuthenticationStatus::Account | AgentAuthenticationStatus::ApiKey
    ) {
        return (native_authentication, false);
    }

    match observation.map(|observation| observation.state) {
        Some(AuthenticationObservationState::Authenticated) => {
            (AgentAuthenticationStatus::MultipleUnknown, false)
        }
        Some(AuthenticationObservationState::Unauthenticated)
            if authentication_required_by_default =>
        {
            (AgentAuthenticationStatus::NotLoggedIn, true)
        }
        Some(AuthenticationObservationState::Unauthenticated) => {
            (AgentAuthenticationStatus::NotRequired, false)
        }
        Some(
            AuthenticationObservationState::Unknown | AuthenticationObservationState::Degraded,
        )
        | None => (
            native_authentication,
            authentication_required_by_default
                && matches!(
                    native_authentication,
                    AgentAuthenticationStatus::NotLoggedIn
                        | AgentAuthenticationStatus::MultipleUnknown
                ),
        ),
    }
}

async fn persist_installed_lock(
    pool: &sqlx::SqlitePool,
    lock_id: Uuid,
    plan: &ResolvedInstallPlan,
    installation: &InstalledPlan,
    installation_ownership: &str,
) -> anyhow::Result<()> {
    let source = match &plan.source {
        LockedInstallSource::BuiltInProfile => serde_json::json!({
            "kind": "built_in_profile"
        }),
        LockedInstallSource::OfficialRegistry {
            snapshot_id,
            registry_id,
        } => serde_json::json!({
            "kind": "official_registry",
            "snapshot_id": snapshot_id,
            "registry_id": registry_id,
        }),
    };
    let resolved_json = serde_json::json!({
        "source": source,
        "frozen_plan": plan,
        "absolute_acp_program": installation.launch_lock.absolute_acp_program,
        "args": installation.launch_lock.args,
        "env": installation.launch_lock.env,
        "runtime_version": installation.launch_lock.runtime_version,
        "acp_version": installation.launch_lock.acp_version,
    })
    .to_string();
    let mut transaction = pool.begin().await?;
    sqlx::query(
        r#"INSERT INTO agent_install_lock
           (id, agent_id, registry_version, platform, distribution_kind, resolved_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)"#,
    )
    .bind(lock_id.to_string())
    .bind(plan.agent_id.as_str())
    .bind(&plan.version)
    .bind(&plan.platform)
    .bind(
        plan.components
            .first()
            .map(|component| format!("{:?}", component.distribution_kind).to_lowercase())
            .unwrap_or_else(|| "unknown".to_string()),
    )
    .bind(resolved_json)
    .bind(Utc::now().to_rfc3339())
    .execute(&mut *transaction)
    .await?;
    for component in &installation.components {
        sqlx::query(
            r#"INSERT INTO agent_install_component
               (id, lock_id, component_kind, absolute_path, version, sha256,
                trust_state, ownership, shared_resource_key)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)"#,
        )
        .bind(Uuid::new_v4().to_string())
        .bind(lock_id.to_string())
        .bind(&component.kind)
        .bind(component.absolute_path.display().to_string())
        .bind(&component.version)
        .bind(&component.sha256)
        .bind(&component.trust_state)
        .bind(&component.ownership)
        .execute(&mut *transaction)
        .await?;
    }
    sqlx::query(
        r#"INSERT INTO agent_installation
           (agent_id, ownership, lifecycle, current_lock_id, rollback_lock_id,
            active_operation, active_operation_id, updated_at)
           VALUES (?, ?, 'ready', ?, NULL, NULL, NULL, CURRENT_TIMESTAMP)
           ON CONFLICT(agent_id) DO UPDATE SET
             ownership = excluded.ownership,
             rollback_lock_id = agent_installation.current_lock_id,
             current_lock_id = excluded.current_lock_id,
             lifecycle = 'ready',
             active_operation = NULL,
             active_operation_id = NULL,
             updated_at = CURRENT_TIMESTAMP"#,
    )
    .bind(plan.agent_id.as_str())
    .bind(installation_ownership)
    .bind(lock_id.to_string())
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(())
}

async fn finish_failed_operation(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
    operation_id: &str,
    kind: AgentOperationKind,
    message: String,
) {
    let failure_lifecycle = if kind == AgentOperationKind::Update {
        "ready"
    } else {
        "needs_repair"
    };
    let _ = sqlx::query(
        "UPDATE agent_installation SET lifecycle = ?, active_operation = NULL, active_operation_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE agent_id = ?",
    )
    .bind(failure_lifecycle)
    .bind(agent_id.as_str())
    .execute(pool)
    .await;
    if let Ok(operation_uuid) = Uuid::parse_str(operation_id) {
        let _ = InstallationOperationRepository::new(pool.clone())
            .finish(operation_uuid, "failed")
            .await;
    }
    let redacted = redact_operation_output(&message);
    let _ = db::models::agent_management::DiagnosticRepository::new(pool.clone())
        .append_bounded(&db::models::agent_management::DiagnosticRecord {
            id: Uuid::new_v4(),
            agent_id: agent_id.clone(),
            operation_kind: operation_kind_key(kind).to_string(),
            severity: "error".to_string(),
            message: "Agent 安装或验证失败".to_string(),
            redacted_output: Some(redacted.clone()),
            created_at: Utc::now().to_rfc3339(),
        })
        .await;
    emit_operation(
        app,
        agent_id.clone(),
        operation_id,
        kind,
        AgentOperationStatus::Failed,
        None,
        Some(redacted),
    );
}

async fn finish_canceled_operation(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
    operation_id: &str,
    kind: AgentOperationKind,
) {
    let _ = sqlx::query(
        r#"UPDATE agent_installation
           SET lifecycle = CASE
                 WHEN current_lock_id IS NULL THEN 'uninstalled'
                 ELSE 'ready'
               END,
               active_operation = NULL,
               active_operation_id = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE agent_id = ? AND active_operation_id = ?"#,
    )
    .bind(agent_id.as_str())
    .bind(operation_id)
    .execute(pool)
    .await;
    if let Ok(operation_uuid) = Uuid::parse_str(operation_id) {
        let _ = InstallationOperationRepository::new(pool.clone())
            .finish(operation_uuid, "cancelled")
            .await;
    }
    emit_operation(
        app,
        agent_id.clone(),
        operation_id,
        kind,
        AgentOperationStatus::Canceled,
        None,
        Some("操作已取消".to_string()),
    );
}

#[tauri::command]
pub async fn agent_management_cancel_operation(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
    operation_id: String,
) -> Result<AgentOperationReceipt, AgentManagementErrorView> {
    let operation_repository =
        InstallationOperationRepository::new(state.deployment.db().pool.clone());
    if let Ok(id) = Uuid::parse_str(&operation_id) {
        let operation = operation_repository
            .find(id)
            .await
            .map_err(internal_error)?;
        if let Some(operation) = operation
            && operation.agent_id == agent_id
            && !matches!(operation.status.as_str(), "queued" | "running")
        {
            let kind = parse_operation_kind(&operation.kind).ok_or_else(|| {
                management_error(
                    AgentManagementErrorCode::InvalidState,
                    "持久化管理操作类型无效",
                    Some(agent_id.clone()),
                )
            })?;
            let status = match operation.status.as_str() {
                "succeeded" => AgentOperationStatus::Succeeded,
                "failed" => AgentOperationStatus::Failed,
                "cancelled" => AgentOperationStatus::Canceled,
                "interrupted" => AgentOperationStatus::Interrupted,
                _ => AgentOperationStatus::Failed,
            };
            return Ok(AgentOperationReceipt {
                operation_id,
                agent_id,
                kind,
                status,
            });
        }
    }
    let active = sqlx::query_as::<_, (Option<String>, Option<String>)>(
        "SELECT active_operation, active_operation_id FROM agent_installation WHERE agent_id = ?",
    )
    .bind(agent_id.as_str())
    .fetch_optional(&state.deployment.db().pool)
    .await
    .map_err(internal_error)?
    .ok_or_else(|| {
        management_error(
            AgentManagementErrorCode::NotFound,
            format!("Agent `{agent_id}` 没有可取消的管理操作"),
            Some(agent_id.clone()),
        )
    })?;
    let kind = active
        .0
        .as_deref()
        .and_then(parse_operation_kind)
        .ok_or_else(|| {
            management_error(
                AgentManagementErrorCode::InvalidState,
                "Agent 没有可取消的管理操作",
                Some(agent_id.clone()),
            )
        })?;
    if active.1.as_deref() != Some(operation_id.as_str())
        || !OperationScheduler::shared()
            .cancellations
            .cancel(&operation_id)
    {
        return Err(management_error(
            AgentManagementErrorCode::InvalidState,
            "管理操作已经结束或不是当前操作",
            Some(agent_id),
        ));
    }
    emit_operation(
        &app,
        agent_id.clone(),
        &operation_id,
        kind,
        AgentOperationStatus::Running,
        None,
        Some("正在取消操作".to_string()),
    );
    Ok(AgentOperationReceipt {
        operation_id,
        agent_id,
        kind,
        status: AgentOperationStatus::Running,
    })
}

fn redact_operation_output(value: &str) -> String {
    let mut redacted = value.to_string();
    for marker in [
        "ANTHROPIC_API_KEY=",
        "OPENAI_API_KEY=",
        "API_KEY=",
        "Authorization: Bearer ",
    ] {
        while let Some(start) = redacted.find(marker) {
            let value_start = start + marker.len();
            let value_end = redacted[value_start..]
                .find(char::is_whitespace)
                .map(|offset| value_start + offset)
                .unwrap_or(redacted.len());
            redacted.replace_range(value_start..value_end, "[REDACTED]");
        }
    }
    if redacted.len() > 8 * 1024 {
        redacted.truncate(8 * 1024);
    }
    redacted
}

#[tauri::command]
pub async fn agent_management_uninstall(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<AgentManagementView, AgentManagementErrorView> {
    ensure_not_busy(&state, &agent_id).await?;
    uninstall_managed_installation(&app, &state.deployment.db().pool, &agent_id).await?;
    agent_management_detail(state, agent_id).await
}

async fn uninstall_managed_installation(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
) -> Result<(), AgentManagementErrorView> {
    let ownership = sqlx::query_scalar::<_, String>(
        "SELECT ownership FROM agent_installation WHERE agent_id = ?",
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await
    .map_err(internal_error)?;
    if ownership.as_deref() == Some("managed") {
        let app_data_dir = app.path().app_data_dir().map_err(internal_error)?;
        let home_dir = app.path().home_dir().map_err(internal_error)?;
        let root = managed_install_root(&app_data_dir, agent_id).map_err(internal_error)?;
        let runtime = current_managed_runtime(pool, agent_id)
            .await
            .map_err(internal_error)?;
        if let Some(runtime) = runtime.as_deref() {
            remove_managed_runtime_cli(&home_dir, agent_id, runtime).map_err(internal_error)?;
        }
        match tokio::fs::remove_dir_all(&root).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                if let Some(runtime) = runtime.as_deref()
                    && runtime.is_file()
                    && let Err(restore_error) = publish_managed_runtime_cli(
                        &home_dir,
                        agent_id,
                        &root,
                        runtime,
                        configured_shell_family(),
                    )
                {
                    tracing::error!(
                        agent_id = %agent_id,
                        %restore_error,
                        "failed to restore terminal command after uninstall failure"
                    );
                }
                return Err(management_error(
                    AgentManagementErrorCode::Internal,
                    format!("无法删除平台托管的 Agent 安装：{error}"),
                    Some(agent_id.clone()),
                ));
            }
        }
    }
    let mut transaction = pool.begin().await.map_err(internal_error)?;
    sqlx::query(
        r#"UPDATE agent_installation
           SET lifecycle = 'uninstalled', current_lock_id = NULL,
               rollback_lock_id = NULL, active_operation = NULL,
               active_operation_id = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE agent_id = ?"#,
    )
    .bind(agent_id.as_str())
    .execute(&mut *transaction)
    .await
    .map_err(internal_error)?;
    sqlx::query("DELETE FROM agent_install_lock WHERE agent_id = ?")
        .bind(agent_id.as_str())
        .execute(&mut *transaction)
        .await
        .map_err(internal_error)?;
    transaction.commit().await.map_err(internal_error)?;
    CLI_EXPOSURES
        .get_or_init(|| AsyncMutex::new(HashSet::new()))
        .lock()
        .await
        .remove(agent_id);
    Ok(())
}

#[tauri::command]
pub async fn agent_management_remove(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<(), AgentManagementErrorView> {
    ensure_not_busy(&state, &agent_id).await?;
    let built_in =
        sqlx::query_scalar::<_, bool>("SELECT built_in FROM agent_membership WHERE agent_id = ?")
            .bind(agent_id.as_str())
            .fetch_optional(&state.deployment.db().pool)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| {
                management_error(
                    AgentManagementErrorCode::NotFound,
                    format!("Agent `{agent_id}` has not been added"),
                    Some(agent_id.clone()),
                )
            })?;
    if built_in {
        return Err(management_error(
            AgentManagementErrorCode::InvalidState,
            "内置 Agent 不能从列表移除",
            Some(agent_id),
        ));
    }
    uninstall_managed_installation(&app, &state.deployment.db().pool, &agent_id).await?;
    sqlx::query("DELETE FROM agent_membership WHERE agent_id = ?")
        .bind(agent_id.as_str())
        .execute(&state.deployment.db().pool)
        .await
        .map_err(internal_error)?;
    Ok(())
}

async fn ensure_not_busy(
    state: &tauri::State<'_, AppState>,
    agent_id: &AgentId,
) -> Result<(), AgentManagementErrorView> {
    let active_process =
        state
            .agent_runtime
            .snapshot()
            .await
            .connections
            .iter()
            .any(|connection| {
                &connection.agent_id == agent_id
                    && matches!(
                        connection.status,
                        agents::AgentConnectionStatus::Connecting
                            | agents::AgentConnectionStatus::Ready
                    )
            });
    let active_operation = sqlx::query_scalar::<_, Option<String>>(
        "SELECT active_operation FROM agent_installation WHERE agent_id = ?",
    )
    .bind(agent_id.as_str())
    .fetch_optional(&state.deployment.db().pool)
    .await
    .map_err(internal_error)?
    .flatten()
    .is_some();
    let in_flight_turn = sqlx::query_scalar::<_, bool>(
        r#"SELECT EXISTS(
             SELECT 1
             FROM conversation_turns turn
             JOIN sessions session ON session.id = turn.conversation_id
             WHERE session.agent_id = ?
               AND turn.status IN ('pending', 'queued', 'running', 'blocked')
           )"#,
    )
    .bind(agent_id.as_str())
    .fetch_one(&state.deployment.db().pool)
    .await
    .map_err(internal_error)?;
    if active_process || active_operation || in_flight_turn {
        return Err(management_error(
            AgentManagementErrorCode::Busy,
            agents::BUSY_LIFECYCLE_MESSAGE,
            Some(agent_id.clone()),
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn agent_management_config_read(
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<AgentNativeConfigView, AgentManagementErrorView> {
    let Some(home) = dirs::home_dir() else {
        return Err(internal_error("用户目录不可用"));
    };
    let account_logged_in = detect_account_login(&home, &agent_id).await;
    let provider = NativeConfigProvider::bundled(Arc::new(TokioNativeFileSystem), home);
    let snapshot = match provider.read(&agent_id, account_logged_in).await {
        Ok(snapshot) => snapshot,
        Err(agents::NativeConfigError::Unsupported(_)) => {
            return Ok(AgentNativeConfigView {
                agent_id,
                available: false,
                path: None,
                paths: Vec::new(),
                fields: Vec::new(),
                files: Vec::new(),
                applies_to_next_session: true,
            });
        }
        Err(error) => return Err(internal_error(error)),
    };
    sync_authentication_probe(
        &state.deployment.db().pool,
        &agent_id,
        snapshot.authentication,
    )
    .await?;
    Ok(native_config_view(agent_id, snapshot))
}

fn native_config_view(
    agent_id: AgentId,
    snapshot: agents::NativeConfigSnapshot,
) -> AgentNativeConfigView {
    let fields = snapshot
        .fields
        .into_iter()
        .map(|field| AgentNativeConfigFieldView {
            id: field.field_id,
            label: field.label,
            description: field.description,
            kind: match field.kind {
                agents::NativeConfigFieldKind::Text => AgentNativeConfigFieldKind::Text,
                agents::NativeConfigFieldKind::Secret => AgentNativeConfigFieldKind::Secret,
                agents::NativeConfigFieldKind::Select => AgentNativeConfigFieldKind::Select,
                agents::NativeConfigFieldKind::Boolean => AgentNativeConfigFieldKind::Boolean,
                agents::NativeConfigFieldKind::Number => AgentNativeConfigFieldKind::Number,
            },
            options: field
                .options
                .into_iter()
                .map(|(value, label)| AgentNativeConfigOptionView { value, label })
                .collect(),
            secret: field.secret,
            path: field.path.display().to_string(),
            present: field.present,
            value: field.value,
            masked_value: field.masked_value,
            revision: field.revision,
        })
        .collect();
    let files = snapshot
        .files
        .into_iter()
        .map(|file| AgentNativeConfigFileView {
            path: file.path.display().to_string(),
            format: match file.format {
                agents::NativeConfigFormat::Json => AgentNativeConfigFormat::Json,
                agents::NativeConfigFormat::Toml => AgentNativeConfigFormat::Toml,
            },
            content: file.content,
            sensitive: file.sensitive,
            exists: file.exists,
        })
        .collect();
    AgentNativeConfigView {
        agent_id,
        available: true,
        path: Some(snapshot.path.display().to_string()),
        paths: snapshot
            .paths
            .into_iter()
            .map(|path| path.display().to_string())
            .collect(),
        fields,
        files,
        applies_to_next_session: true,
    }
}

#[tauri::command]
pub async fn agent_management_config_write(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    request: AgentNativeConfigPatchRequest,
) -> Result<AgentNativeConfigView, AgentManagementErrorView> {
    let Some(home) = dirs::home_dir() else {
        return Err(internal_error("用户目录不可用"));
    };
    let account_logged_in = detect_account_login(&home, &request.agent_id).await;
    let provider = NativeConfigProvider::bundled(Arc::new(TokioNativeFileSystem), home);
    let result = provider
        .save(
            &request.agent_id,
            NativeConfigPatch {
                base_field_revisions: request.base_field_revisions,
                values: request.fields,
            },
            account_logged_in,
        )
        .await
        .map_err(|error| match error {
            agents::NativeConfigSaveError::FieldConflicts { fields } => {
                let mut view = management_error(
                    AgentManagementErrorCode::ConfigConflict,
                    format!("配置字段已被外部修改：{}", fields.join(", ")),
                    Some(request.agent_id.clone()),
                );
                view.preflight_item_id = fields.first().cloned();
                view
            }
            other => internal_error(other),
        })?;
    sync_authentication_probe(
        &state.deployment.db().pool,
        &request.agent_id,
        result.snapshot.authentication,
    )
    .await?;
    let probe_app = app.clone();
    let probe_pool = state.deployment.db().pool.clone();
    let probe_agent_id = request.agent_id.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) =
            record_post_install_probe(&probe_app, &probe_pool, &probe_agent_id).await
        {
            tracing::warn!(
                agent_id = %probe_agent_id,
                %error,
                "failed to refresh ACP authentication after saving Agent configuration"
            );
        }
    });
    Ok(native_config_view(request.agent_id, result.snapshot))
}

async fn sync_authentication_probe(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
    authentication: AgentAuthenticationStatus,
) -> Result<(), AgentManagementErrorView> {
    AgentManagementApplicationService::new(pool.clone())
        .sync_authentication(agent_id, authentication, None)
        .await
        .map_err(internal_error)
}

pub(crate) async fn sync_authentication_probe_with_requirement(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
    authentication: AgentAuthenticationStatus,
    authentication_required: bool,
) -> Result<(), AgentManagementErrorView> {
    AgentManagementApplicationService::new(pool.clone())
        .sync_authentication(agent_id, authentication, Some(authentication_required))
        .await
        .map_err(internal_error)
}

#[tauri::command]
pub async fn agent_management_diagnostics(
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<Vec<AgentDiagnosticView>, AgentManagementErrorView> {
    let rows = sqlx::query_as::<_, (String, String, String, String, Option<String>, String)>(
        r#"SELECT id, operation_kind, severity, message, redacted_output, created_at
           FROM agent_diagnostic WHERE agent_id = ?
           ORDER BY created_at DESC, id DESC LIMIT 20"#,
    )
    .bind(agent_id.as_str())
    .fetch_all(&state.deployment.db().pool)
    .await
    .map_err(internal_error)?;
    Ok(rows
        .into_iter()
        .map(
            |(id, operation_kind, severity, message, redacted_output, created_at)| {
                AgentDiagnosticView {
                    id,
                    agent_id: agent_id.clone(),
                    operation_kind,
                    severity,
                    message,
                    redacted_output,
                    created_at,
                }
            },
        )
        .collect())
}

#[tauri::command]
pub async fn agent_management_clear_diagnostics(
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<(), AgentManagementErrorView> {
    sqlx::query("DELETE FROM agent_diagnostic WHERE agent_id = ?")
        .bind(agent_id.as_str())
        .execute(&state.deployment.db().pool)
        .await
        .map_err(internal_error)?;
    Ok(())
}

fn operation_kind_key(kind: AgentOperationKind) -> &'static str {
    match kind {
        AgentOperationKind::Install => "install",
        AgentOperationKind::Update => "update",
        AgentOperationKind::Repair => "repair",
        AgentOperationKind::Rollback => "rollback",
        AgentOperationKind::Uninstall => "uninstall",
        AgentOperationKind::Remove => "remove",
        AgentOperationKind::Check => "check",
    }
}

fn parse_operation_kind(value: &str) -> Option<AgentOperationKind> {
    match value {
        "install" => Some(AgentOperationKind::Install),
        "update" => Some(AgentOperationKind::Update),
        "repair" => Some(AgentOperationKind::Repair),
        "rollback" => Some(AgentOperationKind::Rollback),
        "uninstall" => Some(AgentOperationKind::Uninstall),
        "remove" => Some(AgentOperationKind::Remove),
        "check" => Some(AgentOperationKind::Check),
        _ => None,
    }
}
