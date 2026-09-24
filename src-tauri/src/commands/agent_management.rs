#[cfg(test)]
mod tests {
    use std::{
        collections::{BTreeMap, HashMap},
        path::Path,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
    };

    use api_types::AgentId;

    use super::{
        AgentManagementRuntimeState, BuiltInProbeAction, PlannedDistributionKind,
        bind_profile_runtime_executable, built_in_probe_action, managed_artifacts_directory,
        managed_install_root, pi_runtime_lock_env, profile_component_distribution_kind,
        redact_operation_output, run_agent_management_warmup_once, run_bounded_agent_probes,
        run_local_runtime_discovery_once, staging_dir_is_referenced_by,
    };

    #[tokio::test]
    async fn startup_management_warmup_is_shared_by_concurrent_readers() {
        let warmup = AgentManagementRuntimeState::default();
        let runs = Arc::new(AtomicUsize::new(0));

        let first_runs = runs.clone();
        let first = run_agent_management_warmup_once(&warmup, async move {
            first_runs.fetch_add(1, Ordering::SeqCst);
        });
        let second_runs = runs.clone();
        let second = run_agent_management_warmup_once(&warmup, async move {
            second_runs.fetch_add(1, Ordering::SeqCst);
        });

        tokio::join!(first, second);

        assert_eq!(runs.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn local_runtime_discovery_does_not_wait_for_management_warmup() {
        let runtime = Arc::new(AgentManagementRuntimeState::default());
        let warmup_started = Arc::new(tokio::sync::Notify::new());
        let release_warmup = Arc::new(tokio::sync::Semaphore::new(0));

        let warmup_runtime = runtime.clone();
        let warmup_started_task = warmup_started.clone();
        let release_warmup_task = release_warmup.clone();
        let warmup_local_runtime = runtime.clone();
        let warmup = tokio::spawn(async move {
            run_agent_management_warmup_once(&warmup_runtime, async move {
                run_local_runtime_discovery_once(&warmup_local_runtime, async {}).await;
                warmup_started_task.notify_one();
                let _permit = release_warmup_task.acquire().await.unwrap();
            })
            .await;
        });
        warmup_started.notified().await;

        tokio::time::timeout(
            std::time::Duration::from_millis(100),
            run_local_runtime_discovery_once(&runtime, async {}),
        )
        .await
        .expect("local Runtime discovery must not share the heavyweight warmup lock");

        release_warmup.add_permits(1);
        warmup.await.unwrap();
    }

    #[tokio::test]
    async fn startup_agent_probes_use_bounded_parallelism() {
        let (started_tx, mut started_rx) = tokio::sync::mpsc::unbounded_channel();
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let probe_release = release.clone();

        let jobs = (0..6)
            .map(move |probe_id| {
                let started_tx = started_tx.clone();
                let release = probe_release.clone();
                async move {
                    started_tx.send(probe_id).unwrap();
                    let _permit = release.acquire().await.unwrap();
                }
            })
            .collect();
        let runner = tokio::spawn(run_bounded_agent_probes(jobs, 4));

        for _ in 0..4 {
            tokio::time::timeout(std::time::Duration::from_secs(1), started_rx.recv())
                .await
                .expect("four probes should start concurrently")
                .expect("probe start channel should remain open");
        }
        assert!(started_rx.try_recv().is_err());

        release.add_permits(4);
        for _ in 0..2 {
            tokio::time::timeout(std::time::Duration::from_secs(1), started_rx.recv())
                .await
                .expect("queued probes should start after capacity is released")
                .expect("probe start channel should remain open");
        }
        release.add_permits(2);
        runner.await.unwrap();
    }

    #[test]
    fn startup_refreshes_existing_installation_evidence() {
        assert_eq!(
            built_in_probe_action(true, false),
            BuiltInProbeAction::RefreshExisting
        );
        assert_eq!(
            built_in_probe_action(true, true),
            BuiltInProbeAction::KeepExisting
        );
        assert_eq!(
            built_in_probe_action(false, false),
            BuiltInProbeAction::Discover
        );
    }

    #[test]
    fn diagnostic_redaction_truncates_unicode_on_a_character_boundary() {
        let input = format!("OPENAI_API_KEY=secret {}", "界".repeat(4_000));
        let redacted = redact_operation_output(&input);
        assert!(redacted.contains("OPENAI_API_KEY=[REDACTED]"));
        assert!(redacted.is_char_boundary(redacted.len()));
        assert!(redacted.len() <= 8 * 1024);
    }

    #[test]
    fn external_adoption_records_the_profile_declared_distribution_kind() {
        // ADR-0038 修复:external 采纳按 Profile 的真实分发记录
        // distribution_kind,不再硬编码 binary——否则 npx 组件(codex-acp)
        // 会在 reconcile 时走错验证路径。
        let catalog = agents::BuiltInProfileCatalog::bundled();
        let codex = catalog.profile(&AgentId::parse("codex").unwrap()).unwrap();
        assert_eq!(
            profile_component_distribution_kind(codex, "agent_runtime"),
            PlannedDistributionKind::Npx
        );
        assert_eq!(
            profile_component_distribution_kind(codex, "acp_adapter"),
            PlannedDistributionKind::Npx
        );
        let opencode = catalog
            .profile(&AgentId::parse("opencode").unwrap())
            .unwrap();
        assert_eq!(
            profile_component_distribution_kind(opencode, "combined_runtime"),
            PlannedDistributionKind::Binary
        );
        // 未知组件回退 binary(现状兜底)。
        assert_eq!(
            profile_component_distribution_kind(codex, "unknown_kind"),
            PlannedDistributionKind::Binary
        );
    }

    #[test]
    fn recovery_cleanup_skips_a_staging_dir_referenced_by_a_live_lock() {
        let root = Path::new("/managed/agents/grok");
        let live = root.join(".staging-abc/0-combined_runtime/dist-package/grok");
        let orphaned = root.join(".staging-def/0-combined_runtime/dist-package/grok");
        assert!(staging_dir_is_referenced_by(
            &root.join(".staging-abc"),
            live.clone()
        ));
        assert!(!staging_dir_is_referenced_by(
            &root.join(".staging-abc"),
            orphaned
        ));
        assert!(!staging_dir_is_referenced_by(
            &root.join(".staging-def"),
            live
        ));
    }

    #[test]
    fn pi_install_lock_keeps_runtime_paths_but_never_unrelated_secrets() {
        let projected = pi_runtime_lock_env(&HashMap::from([
            (
                "PI_ACP_PI_COMMAND".to_string(),
                "/opt/pi-preview".to_string(),
            ),
            (
                "PI_CODING_AGENT_DIR".to_string(),
                "/tmp/pi-config".to_string(),
            ),
            ("OPENAI_API_KEY".to_string(), "must-not-persist".to_string()),
            ("PI_ACP_TRUST_WORKSPACE".to_string(), "0".to_string()),
        ]));

        assert_eq!(
            projected.get("PI_ACP_PI_COMMAND").map(String::as_str),
            Some("/opt/pi-preview")
        );
        assert_eq!(
            projected.get("PI_CODING_AGENT_DIR").map(String::as_str),
            Some("/tmp/pi-config")
        );
        assert!(!projected.contains_key("OPENAI_API_KEY"));
        assert!(!projected.contains_key("PI_ACP_TRUST_WORKSPACE"));
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
        for agent in ["claude_code", "codex"] {
            let mut env = BTreeMap::new();
            bind_profile_runtime_executable(
                &AgentId::parse(agent).unwrap(),
                Path::new("/managed/runtime"),
                &mut env,
            );
            assert!(env.is_empty(), "{agent}");
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
    fn adapter_launch_env_omits_windows_cmd_shims_without_an_exe() {
        let dir = tempfile::tempdir().unwrap();
        let cmd = dir.path().join("claude.cmd");
        std::fs::write(&cmd, b"").unwrap();

        let mut env = BTreeMap::new();
        bind_profile_runtime_executable(&AgentId::parse("claude_code").unwrap(), &cmd, &mut env);
        assert!(!env.contains_key("CLAUDE_CODE_EXECUTABLE"));

        let exe = dir.path().join("codex.exe");
        std::fs::write(&exe, b"").unwrap();
        let mut env = BTreeMap::new();
        bind_profile_runtime_executable(&AgentId::parse("codex").unwrap(), &exe, &mut env);
        assert!(!env.contains_key("CODEX_PATH"));
    }

    #[test]
    fn managed_artifacts_use_an_executable_user_directory_on_macos() {
        let home = Path::new("/Users/developer");
        let app_data = home.join("Library/Application Support/com.vibex.app");
        let root = managed_artifacts_directory(home, &app_data);

        assert_eq!(root, home.join(".local/share/vibex"));
        assert_ne!(root, app_data);
    }
}

use server::native::{
    dsh_configuration, model_providers, opencode_document_paths, opencode_providers,
    read_json_object_or_empty,
};
#[path = "agent_management/external_reconcile.rs"]
mod external_reconcile;

use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
};

use agents::{
    AcpAuthenticationObservationSnapshot, AcpCapabilitySnapshot, AgentAutoApproveMode,
    AgentConnectionId, AgentConnectionLaunch, AgentConnectionManager, ArtifactTrust,
    AuthenticationObservationState, BuiltInProfileCatalog, LaunchComponentEvidence, LaunchGate,
    LockedInstallSource, NativeConfigProvider, ObservedUserComponent, PlannedDistributionKind,
    PlannedInstallComponent, ProfileComponent, ProfileTopology, ResolvedInstallPlan,
    SessionLaunchLock, TokioNativeFileSystem, UserEnvironmentLayout,
    authentication_with_bound_provider, bind_runtime_executable_env, observed_satisfies_profile,
};
use api_types::{
    AgentAuthenticationStatus, AgentId, AgentManagementErrorCode, AgentManagementErrorView,
};
use chrono::Utc;
use db::models::agent_management::InstallationOperationRepository;
use futures::StreamExt;
use services::services::agent_management::AgentManagementApplicationService;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::state::{AgentManagementRuntimeState, AppState, LocalRuntimeEvidence};

const MANAGEMENT_INVALIDATED_EVENT: &str = "agent-management-snapshot-invalidated";
const MANAGEMENT_DISCOVERY_PROGRESS_EVENT: &str = "agent-management-discovery-progress";
const MAX_CONCURRENT_EXTERNAL_AGENT_PROBES: usize = 4;
const LOCAL_RUNTIME_VERSION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);
const EXTERNAL_COMPONENT_VERSION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BuiltInProbeAction {
    Discover,
    RefreshExisting,
    KeepExisting,
}

fn built_in_probe_action(installed: bool, force: bool) -> BuiltInProbeAction {
    match (installed, force) {
        (false, _) => BuiltInProbeAction::Discover,
        (true, false) => BuiltInProbeAction::RefreshExisting,
        (true, true) => BuiltInProbeAction::KeepExisting,
    }
}

async fn run_agent_management_warmup_once<Fut>(runtime: &AgentManagementRuntimeState, work: Fut)
where
    Fut: std::future::Future<Output = ()>,
{
    runtime.run_warmup_once(work).await;
}

async fn run_local_runtime_discovery_once<Fut>(runtime: &AgentManagementRuntimeState, work: Fut)
where
    Fut: std::future::Future<Output = ()>,
{
    runtime.run_local_runtime_discovery_once(work).await;
}

async fn refresh_local_runtime_discovery_once<Fut>(runtime: &AgentManagementRuntimeState, work: Fut)
where
    Fut: std::future::Future<Output = ()>,
{
    runtime.refresh_local_runtime_discovery(work).await;
}

async fn run_bounded_agent_probes<Fut>(jobs: Vec<Fut>, limit: usize)
where
    Fut: std::future::Future<Output = ()>,
{
    futures::stream::iter(jobs)
        .buffer_unordered(limit)
        .collect::<Vec<_>>()
        .await;
}

static HOST_INSTANCE_ID: OnceLock<String> = OnceLock::new();

fn agent_process_command(program: impl AsRef<Path>) -> tokio::process::Command {
    utils::process::new_hidden_tokio_command(program, std::iter::empty::<&str>())
}

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
    let Ok(managed_artifacts_dir) = app_managed_artifacts_directory(app) else {
        return;
    };
    for operation_id in recovered {
        let Ok(Some(operation)) = repository.find(operation_id).await else {
            continue;
        };
        let Some(staging_path) = operation.staging_path.map(PathBuf::from) else {
            continue;
        };
        let Ok(root) = managed_install_root(&managed_artifacts_dir, &operation.agent_id) else {
            continue;
        };
        let is_staging = staging_path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(".staging-"));
        if !(staging_path.is_absolute() && staging_path.starts_with(&root) && is_staging) {
            continue;
        }
        // The crash could have happened after the install lock was persisted
        // but before the operation was marked finished. Deleting that staging
        // directory would orphan the current install (the lock keeps pointing
        // at it), so every later session fails to spawn. Skip any staging dir
        // still referenced by a persisted component path.
        let lock_references = sqlx::query_scalar::<_, String>(
            r#"SELECT absolute_path FROM agent_install_component
               WHERE lock_id IN (
                 SELECT id FROM agent_install_lock WHERE agent_id = ?
               )"#,
        )
        .bind(operation.agent_id.as_str())
        .fetch_all(pool)
        .await
        .unwrap_or_default()
        .into_iter()
        .any(|path| staging_dir_is_referenced_by(&staging_path, PathBuf::from(path)));
        if lock_references {
            continue;
        }
        let _ = tokio::fs::remove_dir_all(&staging_path).await;
    }
}

/// Whether any persisted component path lives inside `staging` — the recovery
/// cleanup must never delete a staging directory that the current install lock
/// still points at.
fn staging_dir_is_referenced_by(staging: &Path, component_path: PathBuf) -> bool {
    component_path.starts_with(staging)
}

fn managed_install_root(
    managed_artifacts_dir: &Path,
    agent_id: &AgentId,
) -> anyhow::Result<PathBuf> {
    let agents_root = managed_artifacts_dir.join("agents");
    let root = agents_root.join(agent_id.as_str());
    if root.parent() != Some(agents_root.as_path()) {
        anyhow::bail!("invalid managed Agent installation path");
    }
    Ok(root)
}

fn managed_artifacts_directory(home_dir: &Path, app_data_dir: &Path) -> PathBuf {
    utils::path::managed_artifacts_directory(home_dir, app_data_dir)
}

fn app_managed_artifacts_directory(app: &AppHandle) -> anyhow::Result<PathBuf> {
    let home_dir = app
        .path()
        .home_dir()
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    Ok(managed_artifacts_directory(&home_dir, &app_data_dir))
}

pub(crate) async fn reconcile_managed_cli_exposures(app: &AppHandle, pool: &sqlx::SqlitePool) {
    // A published shim outlives the Runtime it points at, and it carries the
    // vendor command name, so a dead one shadows the user's own command on PATH.
    // Sweep before anything reads PATH, including the Runtime probe below.
    match app.path().home_dir() {
        Ok(home_dir) => match agents::remove_orphaned_cli_shims(&home_dir) {
            Ok(removed) if !removed.is_empty() => {
                tracing::info!(
                    count = removed.len(),
                    commands = %removed
                        .iter()
                        .map(|shim| shim.command_name.as_str())
                        .collect::<Vec<_>>()
                        .join(", "),
                    "removed Agent CLI shims whose Runtime no longer exists"
                );
            }
            Ok(_) => {}
            Err(error) => {
                tracing::warn!(%error, "failed to sweep orphaned Agent CLI shims");
            }
        },
        Err(error) => {
            tracing::warn!(%error, "failed to locate the home directory for the CLI shim sweep");
        }
    }
    // Historical managed trees were a second install. ADR-0060: the lock is an
    // observation of the user environment. Reclassify leftover rows so launch
    // never SHA-checks a vendor CLI or republishes shims.
    match sqlx::query(
        r#"UPDATE agent_installation
           SET ownership = 'external', updated_at = CURRENT_TIMESTAMP
           WHERE ownership = 'managed'"#,
    )
    .execute(pool)
    .await
    {
        Ok(result) if result.rows_affected() > 0 => {
            tracing::info!(
                count = result.rows_affected(),
                "reclassified managed Agent installations as user-environment observations"
            );
        }
        Ok(_) => {}
        Err(error) => {
            tracing::warn!(%error, "failed to reclassify managed Agent installations");
        }
    }
}

async fn discover_built_in_local_runtimes(
    _app: &AppHandle,
    pool: &sqlx::SqlitePool,
    runtime: Arc<AgentManagementRuntimeState>,
) {
    let _ = utils::shell::refresh_process_path().await;
    if let Some(home) = dirs::home_dir() {
        let mut user_env = UserEnvironmentLayout::for_current_user(home);
        if let Some(prefix) = live_npm_global_prefix().await {
            user_env = user_env.with_npm_prefix(prefix);
        }
        for directory in user_env.path_entries() {
            utils::shell::expose_user_bin_to_process_path(&directory);
        }
    }
    services::services::local_runtime_discovery::discover_built_in_local_runtimes(
        pool.clone(),
        runtime,
        Arc::new(|progress| {
            crate::host_bus::bus().emit(MANAGEMENT_DISCOVERY_PROGRESS_EVENT, progress);
        }),
    )
    .await;
}

async fn ensure_local_runtime_discovery(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    runtime: &Arc<AgentManagementRuntimeState>,
) {
    run_local_runtime_discovery_once(
        runtime,
        discover_built_in_local_runtimes(app, pool, Arc::clone(runtime)),
    )
    .await;
}

async fn probe_built_in_external_installations(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    force: bool,
) {
    let runtime = app.state::<AppState>().agent_management_runtime.clone();
    if force {
        let _ = utils::shell::refresh_process_path_after_install().await;
        refresh_local_runtime_discovery_once(
            &runtime,
            discover_built_in_local_runtimes(app, pool, Arc::clone(&runtime)),
        )
        .await;
    } else {
        ensure_local_runtime_discovery(app, pool, &runtime).await;
    }

    let profiles = BuiltInProfileCatalog::bundled();
    let mut candidates = Vec::new();
    for profile in profiles.profiles() {
        let should_probe = runtime
            .should_probe_built_in(&profile.agent_id, force)
            .await;
        if should_probe {
            candidates.push(profile.clone());
        }
    }
    let jobs = candidates
        .into_iter()
        .map(|profile| {
            let runtime = runtime.clone();
            async move {
                let local_runtime = runtime.local_runtime(&profile.agent_id).await;
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
                match built_in_probe_action(installed, force) {
                    BuiltInProbeAction::Discover => {
                        let result = probe_one_built_in_external_installation(
                            app,
                            pool,
                            &profile,
                            local_runtime.as_ref(),
                        )
                        .await;
                        if let Err(error) = result {
                            tracing::debug!(
                                agent_id = %profile.agent_id,
                                %error,
                                "built-in external Agent candidate was not adopted"
                            );
                        }
                    }
                    BuiltInProbeAction::RefreshExisting => {
                        if let Err(error) =
                            record_post_install_probe(app, pool, &profile.agent_id).await
                        {
                            tracing::debug!(
                                agent_id = %profile.agent_id,
                                %error,
                                "built-in external Agent startup evidence refresh failed"
                            );
                        }
                    }
                    BuiltInProbeAction::KeepExisting => {}
                }
            }
        })
        .collect();
    run_bounded_agent_probes(jobs, MAX_CONCURRENT_EXTERNAL_AGENT_PROBES).await;
}

async fn refresh_agent_management_evidence(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    force_external_probe: bool,
) -> Result<(), AgentManagementErrorView> {
    probe_built_in_external_installations(app, pool, force_external_probe).await;
    normalize_optional_profile_authentication(pool).await;
    // ADR-0038 方向 B:先尝试以官方指纹自动采纳外部组件变更,再对剩余不匹配
    // 组件执行 fail-closed 完整性刷新(needs_repair)。
    external_reconcile::reconcile_external_component_changes(app, pool)
        .await
        .map_err(internal_error)?;
    AgentManagementApplicationService::new(pool.clone())
        .refresh_component_integrity()
        .await
        .map_err(internal_error)?;
    revalidate_recoverable_external_installations(app, pool).await;
    refresh_authentication_probes(app, pool).await;
    Ok(())
}

async fn refresh_authentication_probes(app: &AppHandle, pool: &sqlx::SqlitePool) {
    let agent_ids = match sqlx::query_scalar::<_, String>("SELECT agent_id FROM agent_membership")
        .fetch_all(pool)
        .await
    {
        Ok(agent_ids) => agent_ids,
        Err(error) => {
            tracing::warn!(%error, "failed to load Agents for authentication refresh");
            return;
        }
    };
    for raw_agent_id in agent_ids {
        let Ok(agent_id) = AgentId::parse(raw_agent_id) else {
            continue;
        };
        if let Err(error) = refresh_one_agent_authentication(app, pool, &agent_id, true).await {
            tracing::debug!(
                agent_id = %agent_id,
                message = %error.message,
                "failed to refresh Agent authentication"
            );
        }
    }
}

async fn refresh_one_agent_authentication(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
    prefer_recorded: bool,
) -> Result<(AgentAuthenticationStatus, HashMap<String, String>), AgentManagementErrorView> {
    let agent_env = read_agent_environment(pool, agent_id).await?;
    let native_authentication = observe_native_authentication(app, agent_id, &agent_env).await;
    let authentication_required_by_default = BuiltInProfileCatalog::management()
        .profile(agent_id)
        .is_some_and(|profile| profile.authentication_required_by_default);
    let (observed, authentication_required) = resolve_authentication_observation(
        native_authentication,
        None,
        authentication_required_by_default,
    );
    let authentication = if prefer_recorded {
        recorded_account_over_residue(pool, agent_id, observed).await
    } else {
        observed
    };
    sync_authentication_probe_with_requirement(
        pool,
        agent_id,
        authentication,
        authentication_required
            && !matches!(
                authentication,
                AgentAuthenticationStatus::Account | AgentAuthenticationStatus::ApiKey
            ),
    )
    .await?;
    Ok((authentication, agent_env))
}

async fn observe_native_authentication(
    app: &AppHandle,
    agent_id: &AgentId,
    agent_env: &HashMap<String, String>,
) -> AgentAuthenticationStatus {
    let native_authentication = if let Ok(home) = app.path().home_dir() {
        let account_logged_in = resolve_native_account_login(&home, agent_id, agent_env).await;
        let provider = NativeConfigProvider::with_environment(
            Arc::new(TokioNativeFileSystem),
            home.clone(),
            agent_env.clone().into_iter().collect(),
        );
        match provider.read(agent_id, account_logged_in).await {
            Ok(snapshot) => snapshot.authentication,
            Err(agents::NativeConfigError::Unsupported(_)) => {
                AgentAuthenticationStatus::NotRequired
            }
            Err(_) => AgentAuthenticationStatus::NotLoggedIn,
        }
    } else {
        AgentAuthenticationStatus::NotLoggedIn
    };
    if agent_id.as_str() == "deepseek_harness"
        && let Ok(home) = app.path().home_dir()
    {
        let paths = dsh_paths(&home, agent_env);
        if dsh_configuration::any_credential_present(&paths) {
            return AgentAuthenticationStatus::ApiKey;
        }
    }
    if agent_id.as_str() == "opencode"
        && let Ok(home) = app.path().home_dir()
    {
        let (auth_path, config_path) = opencode_document_paths(&home, agent_env);
        if let (Ok(auth), Ok(config)) = (
            read_json_object_or_empty(&auth_path).await,
            read_json_object_or_empty(&config_path).await,
        ) && opencode_providers::opencode_enabled_api_provider_ready(&auth, &config)
        {
            return AgentAuthenticationStatus::ApiKey;
        }
    }
    let bound_with_credential =
        bound_model_provider_has_credentials(app, agent_id, agent_env).await;
    authentication_with_bound_provider(native_authentication, bound_with_credential)
}

async fn bound_model_provider_has_credentials(
    app: &AppHandle,
    agent_id: &AgentId,
    agent_env: &HashMap<String, String>,
) -> bool {
    let Ok(home) = app.path().home_dir() else {
        return false;
    };
    let Ok(store_path) = app
        .path()
        .app_data_dir()
        .map(|dir| dir.join("agent-model-providers.json"))
    else {
        return false;
    };
    let native_home = resolve_model_provider_native_home(&home, agent_env, agent_id);
    let Ok(view) =
        model_providers::list_with_native(&store_path, agent_id.clone(), Some(&native_home)).await
    else {
        return false;
    };
    view.providers
        .iter()
        .find(|provider| Some(&provider.id) == view.bound_provider_id.as_ref())
        .is_some_and(|provider| provider.credential_present)
}

async fn revalidate_recoverable_external_installations(app: &AppHandle, pool: &sqlx::SqlitePool) {
    let agent_ids = match sqlx::query_scalar::<_, String>(
        r#"SELECT agent_id
           FROM agent_installation
           WHERE ownership = 'external'
             AND current_lock_id IS NOT NULL
             AND active_operation IS NULL
             AND (
               lifecycle = 'needs_repair'
               OR EXISTS (
                 SELECT 1 FROM agent_diagnostic diagnostic
                 WHERE diagnostic.agent_id = agent_installation.agent_id
                   AND diagnostic.read_at IS NULL
                   AND diagnostic.redacted_output LIKE
                     'terminal command `%` already resolves to `%` and is not managed by Agent `%`'
               )
             )
           ORDER BY agent_id"#,
    )
    .fetch_all(pool)
    .await
    {
        Ok(agent_ids) => agent_ids,
        Err(error) => {
            tracing::warn!(%error, "failed to load external Agent revalidation candidates");
            return;
        }
    };
    for raw_agent_id in agent_ids {
        let Ok(agent_id) = AgentId::parse(raw_agent_id) else {
            continue;
        };
        let evidence = match sqlx::query_as::<_, (String, String, Option<String>)>(
            r#"SELECT component.component_kind, component.absolute_path, component.sha256
               FROM agent_installation installation
               JOIN agent_install_component component
                 ON component.lock_id = installation.current_lock_id
               WHERE installation.agent_id = ?
               ORDER BY component.component_kind, component.absolute_path"#,
        )
        .bind(agent_id.as_str())
        .fetch_all(pool)
        .await
        {
            Ok(rows) => rows
                .into_iter()
                .map(
                    |(component_kind, absolute_path, expected_sha256)| LaunchComponentEvidence {
                        component_kind,
                        absolute_path: PathBuf::from(absolute_path),
                        expected_sha256: expected_sha256.unwrap_or_default(),
                    },
                )
                .collect::<Vec<_>>(),
            Err(error) => {
                tracing::warn!(agent_id = %agent_id, %error, "failed to load external Agent components");
                continue;
            }
        };
        if evidence.is_empty() || LaunchGate::verify_components(&evidence).await.is_err() {
            continue;
        }
        if let Err(error) = record_post_install_probe(app, pool, &agent_id).await {
            tracing::debug!(
                agent_id = %agent_id,
                %error,
                "external Agent revalidation did not recover the installation"
            );
            continue;
        }
        let _ = sqlx::query(
            r#"UPDATE agent_installation
               SET lifecycle = 'ready', updated_at = CURRENT_TIMESTAMP
               WHERE agent_id = ?
                 AND ownership = 'external'
                 AND lifecycle = 'needs_repair'
                 AND current_lock_id IS NOT NULL
                 AND active_operation IS NULL"#,
        )
        .bind(agent_id.as_str())
        .execute(pool)
        .await;
        let _ = sqlx::query(
            r#"UPDATE agent_diagnostic
               SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
               WHERE agent_id = ?
                 AND read_at IS NULL
                 AND redacted_output LIKE
                   'terminal command `%` already resolves to `%` and is not managed by Agent `%`'"#,
        )
        .bind(agent_id.as_str())
        .execute(pool)
        .await;
    }
}

async fn ensure_agent_management_warmup(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    runtime: &AgentManagementRuntimeState,
) {
    run_agent_management_warmup_once(runtime, async {
        if let Err(error) = refresh_agent_management_evidence(app, pool, false).await {
            tracing::warn!(
                message = %error.message,
                "Agent management startup warmup failed"
            );
        }
    })
    .await;
}

pub(crate) async fn warm_agent_management(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    runtime: &AgentManagementRuntimeState,
) {
    ensure_agent_management_warmup(app, pool, runtime).await;
    crate::host_bus::bus().emit(MANAGEMENT_INVALIDATED_EVENT, ());
}

pub(crate) async fn warm_local_runtime_discovery(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    runtime: &Arc<AgentManagementRuntimeState>,
) {
    ensure_local_runtime_discovery(app, pool, runtime).await;
    crate::host_bus::bus().emit(MANAGEMENT_INVALIDATED_EVENT, ());
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

fn profile_component_distribution_kind(
    profile: &agents::BuiltInProfile,
    component_kind: &str,
) -> PlannedDistributionKind {
    profile
        .install_sources
        .iter()
        .find_map(|source| match source {
            agents::ProfileInstallSource::Npx { component, .. }
                if profile_component_key(*component) == component_kind =>
            {
                Some(PlannedDistributionKind::Npx)
            }
            agents::ProfileInstallSource::Uvx { component, .. }
                if profile_component_key(*component) == component_kind =>
            {
                Some(PlannedDistributionKind::Uvx)
            }
            agents::ProfileInstallSource::Binary { component, .. }
                if profile_component_key(*component) == component_kind =>
            {
                Some(PlannedDistributionKind::Binary)
            }
            _ => None,
        })
        .unwrap_or(PlannedDistributionKind::Binary)
}

async fn probe_one_built_in_external_installation(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    profile: &agents::BuiltInProfile,
    local_runtime: Option<&LocalRuntimeEvidence>,
) -> anyhow::Result<()> {
    let configured_env_json = sqlx::query_scalar::<_, Option<String>>(
        "SELECT env_json FROM agent_setting WHERE agent_type = ?",
    )
    .bind(profile.agent_id.as_str())
    .fetch_optional(pool)
    .await?
    .flatten();
    let configured_env = parse_agent_env(configured_env_json.as_deref())?;
    let mut components = Vec::new();
    for candidate in profile.external_candidates {
        let is_runtime_candidate = matches!(
            candidate.component,
            ProfileComponent::AgentRuntime | ProfileComponent::CombinedRuntime
        );
        let (executable, runtime_version) = if is_runtime_candidate {
            let Some(local_runtime) = local_runtime else {
                if candidate.component == ProfileComponent::AgentRuntime {
                    continue;
                }
                anyhow::bail!("external local Runtime is missing");
            };
            (
                local_runtime.path.clone(),
                local_runtime.version.clone().unwrap_or_default(),
            )
        } else {
            let Some(path) = utils::shell::resolve_executable_path(candidate.executable).await
            else {
                anyhow::bail!(
                    "external Agent candidate `{}` was not found",
                    candidate.executable
                );
            };
            (path, String::new())
        };
        let executable = utils::process::prefer_direct_spawn_executable(
            tokio::fs::canonicalize(executable).await?,
        );
        if !executable.is_absolute() || !tokio::fs::metadata(&executable).await?.is_file() {
            anyhow::bail!("external candidate is not an absolute executable file");
        }
        let mut version = if is_runtime_candidate {
            runtime_version
        } else {
            let mut command = agent_process_command(&executable);
            command.kill_on_drop(true);
            command.args(candidate.version_args);
            let output = tokio::time::timeout(EXTERNAL_COMPONENT_VERSION_TIMEOUT, command.output())
                .await
                .map_err(|_| anyhow::anyhow!("external Agent version probe timed out"))??;
            ensure_success("external Agent version probe", &output)?;
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            [stdout, stderr]
                .into_iter()
                .find(|value| !value.is_empty())
                .unwrap_or_default()
        };
        if version.is_empty() {
            if candidate.version_args.is_empty() {
                version = "1.0.0".to_string();
            } else {
                anyhow::bail!("external Agent version probe returned no version");
            }
        }
        let sha256 = format!("{:x}", Sha256::digest(tokio::fs::read(&executable).await?));
        components.push(InstalledComponent {
            kind: profile_component_key(candidate.component).to_string(),
            absolute_path: executable,
            version,
            sha256: Some(sha256),
            trust_state: "tofu".to_string(),
            ownership: "external".to_string(),
            shared_resource_key: None,
        });
    }
    let required_components_present = match profile.topology {
        ProfileTopology::NativeAcp => components
            .iter()
            .any(|component| component.kind == "combined_runtime"),
        ProfileTopology::AdapterBacked => components
            .iter()
            .any(|component| component.kind == "acp_adapter"),
    };
    if !required_components_present {
        anyhow::bail!("not every Profile-declared external component is available");
    }
    let observed = components
        .iter()
        .map(|component| ObservedUserComponent {
            component_id: component.kind.clone(),
            version: Some(component.version.clone()),
        })
        .collect::<Vec<_>>();
    if !observed_satisfies_profile(profile, &observed) {
        anyhow::bail!(
            "user-environment Agent is older than the Built-in Profile pin and must be reinstalled"
        );
    }
    let runtime = components.iter().find(|component| {
        matches!(
            component.kind.as_str(),
            "agent_runtime" | "combined_runtime"
        )
    });
    let acp = components
        .iter()
        .find(|component| matches!(component.kind.as_str(), "acp_adapter" | "combined_runtime"))
        .ok_or_else(|| anyhow::anyhow!("external ACP executable is missing"))?;
    let args = profile_component_from_key(&acp.kind)
        .map(|component| agents::acp_launch_args(profile, component))
        .unwrap_or_default();
    let mut env = BTreeMap::new();
    if profile.agent_id.as_str() == "pi" {
        env.extend(pi_runtime_lock_env(&configured_env));
    }
    let component_dirs = components
        .iter()
        .filter_map(|component| component.absolute_path.parent().map(Path::to_path_buf))
        .collect::<Vec<_>>();
    let user_path =
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect::<Vec<_>>();
    let (mut path_entries, fallback_entries) =
        if agents::component_dirs_precede_user_path(&profile.agent_id) {
            (component_dirs, user_path)
        } else {
            (user_path, component_dirs)
        };
    path_entries.extend(fallback_entries);
    env.insert(
        "PATH".to_string(),
        std::env::join_paths(path_entries)?
            .to_string_lossy()
            .to_string(),
    );
    if let Some(runtime) = runtime {
        bind_profile_runtime_executable(&profile.agent_id, &runtime.absolute_path, &mut env);
    }
    let mut launch_lock = SessionLaunchLock {
        agent_id: profile.agent_id.clone(),
        absolute_acp_program: acp.absolute_path.clone(),
        args,
        env,
        runtime_version: runtime
            .map(|component| component.version.clone())
            .unwrap_or_default(),
        acp_version: acp.version.clone(),
    };
    let working_dir = app
        .path()
        .app_data_dir()?
        .join("agents")
        .join(profile.agent_id.as_str());
    tokio::fs::create_dir_all(&working_dir).await?;
    if profile.agent_id.as_str() == "pi" {
        // Runtime preferences are only needed by the adoption handshake. They
        // remain live settings and must not be frozen into the persisted lock.
        for key in [
            "PI_ACP_PI_COMMAND",
            "PI_CODING_AGENT_DIR",
            "PI_CODING_AGENT_SESSION_DIR",
        ] {
            launch_lock.env.remove(key);
        }
    }

    let plan = ResolvedInstallPlan {
        agent_id: profile.agent_id.clone(),
        source: LockedInstallSource::BuiltInProfile,
        version: acp.version.clone(),
        platform: agents::current_platform(),
        components: components
            .iter()
            .map(|component| PlannedInstallComponent {
                component_id: component.kind.clone(),
                distribution_kind: profile_component_distribution_kind(profile, &component.kind),
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
    if let Err(error) = record_post_install_probe(app, pool, &profile.agent_id).await {
        tracing::debug!(
            agent_id = %profile.agent_id,
            %error,
            "adopted Agent CLI; ACP handshake will be retried when a session starts"
        );
    }
    Ok(())
}

fn profile_component_key(component: ProfileComponent) -> &'static str {
    match component {
        ProfileComponent::AgentRuntime => "agent_runtime",
        ProfileComponent::AcpAdapter => "acp_adapter",
        ProfileComponent::CombinedRuntime => "combined_runtime",
    }
}

fn profile_component_from_key(key: &str) -> Option<ProfileComponent> {
    match key {
        "agent_runtime" => Some(ProfileComponent::AgentRuntime),
        "acp_adapter" => Some(ProfileComponent::AcpAdapter),
        "combined_runtime" => Some(ProfileComponent::CombinedRuntime),
        _ => None,
    }
}

fn bind_profile_runtime_executable(
    agent_id: &AgentId,
    runtime_path: &Path,
    env: &mut BTreeMap<String, String>,
) {
    bind_runtime_executable_env(agent_id, runtime_path, env);
}

fn pi_runtime_lock_env(configured_env: &HashMap<String, String>) -> BTreeMap<String, String> {
    [
        "PI_ACP_PI_COMMAND",
        "PI_CODING_AGENT_DIR",
        "PI_CODING_AGENT_SESSION_DIR",
    ]
    .into_iter()
    .filter_map(|key| {
        configured_env
            .get(key)
            .cloned()
            .map(|value| (key.to_string(), value))
    })
    .collect()
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

fn internal_error(error: impl std::fmt::Display) -> AgentManagementErrorView {
    management_error(AgentManagementErrorCode::Internal, error.to_string(), None)
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
    let mut launch_env = payload.env.into_iter().collect::<HashMap<_, _>>();
    let configured_env = read_agent_environment(pool, agent_id)
        .await
        .map_err(|error| anyhow::anyhow!(error.message))?;
    launch_env.extend(configured_env);
    launch_env.remove("PI_ACP_TRUST_WORKSPACE");
    let mut launch_args = payload.args;
    agents::apply_built_in_launch_policy(agent_id, &mut launch_env, &mut launch_args);
    let launch_lock = SessionLaunchLock {
        agent_id: agent_id.clone(),
        absolute_acp_program: payload.absolute_acp_program,
        args: launch_args,
        env: launch_env.into_iter().collect(),
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
    let native_authentication = if app.path().home_dir().is_ok() {
        let agent_env = read_agent_environment(pool, agent_id)
            .await
            .map_err(|error| anyhow::anyhow!(error.message))?;
        observe_native_authentication(app, agent_id, &agent_env).await
    } else {
        AgentAuthenticationStatus::NotRequired
    };
    let authentication_required_by_default = BuiltInProfileCatalog::management()
        .profile(agent_id)
        .is_some_and(|profile| profile.authentication_required_by_default);
    let (observed, authentication_required) = resolve_authentication_observation(
        native_authentication,
        capabilities.authentication.as_ref(),
        authentication_required_by_default,
    );
    let authentication = recorded_account_over_residue(pool, agent_id, observed).await;
    sync_authentication_probe_with_requirement(
        pool,
        agent_id,
        authentication,
        authentication_required
            && !matches!(
                authentication,
                AgentAuthenticationStatus::Account | AgentAuthenticationStatus::ApiKey
            ),
    )
    .await
    .map_err(|error| anyhow::anyhow!(error.message))
}

async fn resolve_native_account_login(
    home: &Path,
    agent_id: &AgentId,
    environment: &HashMap<String, String>,
) -> bool {
    let local = detect_account_login(home, agent_id, environment).await;
    let document = match agent_id.as_str() {
        "codex" => read_account_evidence_document(home, agent_id, environment).await,
        _ => None,
    };
    agents::account_still_present(
        local,
        agents::confirm_account_session(agent_id, local, document.as_ref()).await,
    )
}

async fn read_account_evidence_document(
    home: &Path,
    agent_id: &AgentId,
    environment: &HashMap<String, String>,
) -> Option<serde_json::Value> {
    let bytes = read_account_evidence_bytes(home, agent_id, environment).await?;
    serde_json::from_slice(&bytes).ok()
}

async fn detect_account_login(
    home: &Path,
    agent_id: &AgentId,
    environment: &HashMap<String, String>,
) -> bool {
    if agent_id.as_str() == "cursor" {
        return agents::cursor_account_token().await.is_some();
    }
    let Some(bytes) = read_account_evidence_bytes(home, agent_id, environment).await else {
        return false;
    };
    serde_json::from_slice::<serde_json::Value>(&bytes).is_ok_and(|value| {
        if agent_id.as_str() == "kimi_code" && kimi_credential_is_synthetic(&value) {
            return false;
        }
        BuiltInProfileCatalog::bundled()
            .profile(agent_id)
            .and_then(|profile| profile.account_evidence.as_ref())
            .is_some_and(|evidence| evidence.matches(&value))
    })
}

async fn read_account_evidence_bytes(
    home: &Path,
    agent_id: &AgentId,
    environment: &HashMap<String, String>,
) -> Option<Vec<u8>> {
    let catalog = BuiltInProfileCatalog::bundled();
    let evidence = catalog
        .profile(agent_id)
        .and_then(|profile| profile.account_evidence.as_ref())?;
    let override_directory = evidence.directory_override_env.and_then(|name| {
        environment
            .get(name)
            .filter(|value| !value.trim().is_empty())
            .map(|value| expand_agent_home_path(home, value))
            .or_else(|| {
                std::env::var_os(name)
                    .filter(|value| !value.is_empty())
                    .map(|value| expand_agent_home_path(home, &value.to_string_lossy()))
            })
    });
    let directory = override_directory
        .map(|directory| directory.join(evidence.override_relative_directory))
        .unwrap_or_else(|| home.join(evidence.home_relative_directory));
    tokio::fs::read(directory.join(evidence.relative_file))
        .await
        .ok()
}

fn expand_agent_home_path(home: &Path, value: &str) -> PathBuf {
    let path = PathBuf::from(value.trim());
    if path == Path::new("~") {
        return home.to_path_buf();
    }
    if let Ok(relative) = path.strip_prefix("~/") {
        return home.join(relative);
    }
    if path.is_relative() {
        return home.join(path);
    }
    path
}

fn resolve_agent_home_directory(
    home: &Path,
    environment: &HashMap<String, String>,
    variable: &str,
    fallback: &str,
) -> PathBuf {
    environment
        .get(variable)
        .filter(|value| !value.trim().is_empty())
        .map(|value| expand_agent_home_path(home, value))
        .or_else(|| {
            std::env::var_os(variable)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| home.join(fallback))
}

fn resolve_model_provider_native_home(
    home: &Path,
    environment: &HashMap<String, String>,
    agent_id: &AgentId,
) -> PathBuf {
    match agent_id.as_str() {
        "pi" => resolve_agent_home_directory(home, environment, "PI_CODING_AGENT_DIR", ".pi/agent"),
        "claude_code" => {
            resolve_agent_home_directory(home, environment, "CLAUDE_CONFIG_DIR", ".claude")
        }
        "grok" => resolve_agent_home_directory(home, environment, "GROK_HOME", ".grok"),
        "kimi_code" => {
            resolve_agent_home_directory(home, environment, "KIMI_CODE_HOME", ".kimi-code")
        }
        "hermes" => resolve_agent_home_directory(home, environment, "HERMES_HOME", ".hermes"),
        "openclaw" => resolve_agent_home_directory(home, environment, "OPENCLAW_HOME", ".openclaw"),
        "cline" => resolve_agent_home_directory(home, environment, "CLINE_DIR", ".cline/data"),
        "gemini" | "antigravity" => {
            if let Some(value) = environment
                .get("GEMINI_HOME")
                .filter(|value| !value.trim().is_empty())
            {
                expand_agent_home_path(home, value)
            } else {
                home.join(".gemini")
            }
        }
        _ => resolve_agent_home_directory(home, environment, "CODEX_HOME", ".codex"),
    }
}

struct InstalledComponent {
    kind: String,
    absolute_path: PathBuf,
    version: String,
    sha256: Option<String>,
    trust_state: String,
    ownership: String,
    shared_resource_key: Option<String>,
}

struct InstalledPlan {
    launch_lock: SessionLaunchLock,
    components: Vec<InstalledComponent>,
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

/// The global prefix npm would install into, asked of the npm on the current
/// PATH. Discovery has no locked Node runtime yet, so there is nothing else to
/// ask.
async fn live_npm_global_prefix() -> Option<PathBuf> {
    let npm = utils::shell::resolve_executable_path(if cfg!(windows) { "npm.cmd" } else { "npm" })
        .await?;
    let mut command = agent_process_command(&npm);
    command.arg("prefix").arg("-g").kill_on_drop(true);
    let output = tokio::time::timeout(LOCAL_RUNTIME_VERSION_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let prefix = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()?
        .trim()
        .to_string();
    if prefix.is_empty() {
        None
    } else {
        Some(PathBuf::from(prefix))
    }
}

async fn probe_acp_capabilities(
    agent_id: &AgentId,
    lock: &SessionLaunchLock,
    working_dir: &Path,
    cancellation: &CancellationToken,
) -> anyhow::Result<AcpCapabilitySnapshot> {
    let (event_tx, _event_rx) = agents::manager::manager_event_channel();
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
        LockedInstallSource::BuiltInProfileWithRegistry {
            snapshot_id,
            registry_id,
        } => serde_json::json!({
            "kind": "built_in_profile_with_registry",
            "snapshot_id": snapshot_id,
            "registry_id": registry_id,
        }),
        LockedInstallSource::OfficialRegistry {
            snapshot_id,
            registry_id,
        } => serde_json::json!({
            "kind": "official_registry",
            "snapshot_id": snapshot_id,
            "registry_id": registry_id,
        }),
        LockedInstallSource::UserDefinition { definition_sha256 } => serde_json::json!({
            "kind": "user_definition",
            "definition_sha256": definition_sha256,
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
    .bind(plan.registry_bound_version())
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
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(Uuid::new_v4().to_string())
        .bind(lock_id.to_string())
        .bind(&component.kind)
        .bind(component.absolute_path.display().to_string())
        .bind(&component.version)
        .bind(&component.sha256)
        .bind(&component.trust_state)
        .bind(&component.ownership)
        .bind(&component.shared_resource_key)
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
    sqlx::query(
        r#"UPDATE agent_diagnostic
           SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
           WHERE agent_id = ?
             AND severity = 'error'
             AND read_at IS NULL"#,
    )
    .bind(plan.agent_id.as_str())
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(())
}

fn redact_operation_output(value: &str) -> String {
    const MAX_DIAGNOSTIC_BYTES: usize = 8 * 1024;
    const REDACTED: &str = "[REDACTED]";
    let mut boundary = value.len().min(MAX_DIAGNOSTIC_BYTES);
    while boundary > 0 && !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    let mut redacted = value[..boundary].to_string();
    for marker in [
        "ANTHROPIC_API_KEY=",
        "ANTHROPIC_AUTH_TOKEN=",
        "OPENAI_API_KEY=",
        "GEMINI_API_KEY=",
        "GOOGLE_API_KEY=",
        "XAI_API_KEY=",
        "KIMI_API_KEY=",
        "OPENROUTER_API_KEY=",
        "API_KEY=",
        "api_key=",
        "apiKey=",
        "--api-key ",
        "Authorization: Bearer ",
        "authorization: bearer ",
    ] {
        let mut search_from = 0;
        while let Some(relative_start) = redacted[search_from..].find(marker) {
            let start = search_from + relative_start;
            let value_start = start + marker.len();
            let value_end = redacted[value_start..]
                .find(char::is_whitespace)
                .map(|offset| value_start + offset)
                .unwrap_or(redacted.len());
            if redacted[value_start..].starts_with(REDACTED) {
                search_from = value_start + REDACTED.len();
                continue;
            }
            redacted.replace_range(value_start..value_end, REDACTED);
            search_from = value_start + REDACTED.len();
        }
    }
    if redacted.len() > MAX_DIAGNOSTIC_BYTES {
        let mut boundary = MAX_DIAGNOSTIC_BYTES;
        while boundary > 0 && !redacted.is_char_boundary(boundary) {
            boundary -= 1;
        }
        redacted.truncate(boundary);
    }
    redacted
}

fn dsh_paths(home: &Path, environment: &HashMap<String, String>) -> dsh_configuration::DshPaths {
    dsh_configuration::resolve_paths(home, environment)
}

fn parse_agent_env(value: Option<&str>) -> Result<HashMap<String, String>, serde_json::Error> {
    value
        .filter(|value| !value.trim().is_empty())
        .map(serde_json::from_str)
        .transpose()
        .map(Option::unwrap_or_default)
}

async fn read_agent_environment(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
) -> Result<HashMap<String, String>, AgentManagementErrorView> {
    let env_json = sqlx::query_scalar::<_, Option<String>>(
        "SELECT env_json FROM agent_setting WHERE agent_type = ?",
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await
    .map_err(internal_error)?
    .flatten();
    parse_agent_env(env_json.as_deref()).map_err(internal_error)
}

fn kimi_credential_is_synthetic(value: &serde_json::Value) -> bool {
    value
        .get("_vibex_synthetic")
        .and_then(serde_json::Value::as_bool)
        == Some(true)
        || value
            .get("access_token")
            .and_then(serde_json::Value::as_str)
            == Some("vibex-local-gate")
}

async fn recorded_authentication(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
) -> AgentAuthenticationStatus {
    let value = sqlx::query_scalar::<_, String>(
        "SELECT authentication FROM agent_probe WHERE agent_id = ?",
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    match value.as_deref() {
        Some("account") => AgentAuthenticationStatus::Account,
        Some("api_key") => AgentAuthenticationStatus::ApiKey,
        Some("multiple_unknown") => AgentAuthenticationStatus::MultipleUnknown,
        Some("not_required") => AgentAuthenticationStatus::NotRequired,
        _ => AgentAuthenticationStatus::NotLoggedIn,
    }
}

async fn recorded_account_over_residue(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
    observed: AgentAuthenticationStatus,
) -> AgentAuthenticationStatus {
    agents::prefer_recorded_account_over_residue(
        recorded_authentication(pool, agent_id).await,
        observed,
    )
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
