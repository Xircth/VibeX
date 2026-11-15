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
        // distribution_kind,不再硬编码 binary——否则 npx 组件
        // 会在 reconcile 时走错验证路径。
        let catalog = agents::BuiltInProfileCatalog::bundled();
        let codex = catalog.profile(&AgentId::parse("codex").unwrap()).unwrap();
        let pi = catalog.profile(&AgentId::parse("pi").unwrap()).unwrap();
        assert_eq!(
            profile_component_distribution_kind(pi, "agent_runtime"),
            PlannedDistributionKind::Npx
        );
        assert_eq!(
            profile_component_distribution_kind(pi, "acp_adapter"),
            PlannedDistributionKind::Npx
        );
        assert_eq!(
            profile_component_distribution_kind(codex, "combined_runtime"),
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
                let enabled = sqlx::query_scalar::<_, bool>(
                    "SELECT enabled FROM agent_membership WHERE agent_id = ?",
                )
                .bind(profile.agent_id.as_str())
                .fetch_optional(pool)
                .await
                .ok()
                .flatten()
                .unwrap_or(true);
                match built_in_probe_action(installed, force) {
                    BuiltInProbeAction::Discover if enabled => {
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
                    BuiltInProbeAction::Discover => {}
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
                   AND (
                     diagnostic.operation_kind = 'launch_gate'
                     OR diagnostic.redacted_output LIKE
                       'terminal command `%` already resolves to `%` and is not managed by Agent `%`'
                   )
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
        let _ = sqlx::query(
            r#"UPDATE agent_diagnostic
               SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
               WHERE agent_id = ?
                 AND read_at IS NULL
                 AND operation_kind = 'launch_gate'"#,
        )
        .bind(agent_id.as_str())
        .execute(pool)
        .await;
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
                 AND (
                   operation_kind = 'launch_gate'
                   OR redacted_output LIKE
                     'terminal command `%` already resolves to `%` and is not managed by Agent `%`'
                 )"#,
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

#[path = "agent_management_adopt.rs"]
mod agent_management_adopt;
pub(crate) use agent_management_adopt::*;
