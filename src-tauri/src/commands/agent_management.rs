#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, path::Path};

    use api_types::{
        AgentId, AgentManagementErrorCode, AgentManagementErrorView, AgentOperationEvent,
        AgentOperationKind, AgentOperationStatus,
    };

    use super::{
        OperationCancellationRegistry, auth_document_has_account, bind_profile_runtime_executable,
        build_launch_environment, install_locked_plan, managed_install_root, management_error,
        operation_event, resolve_npm_package_executable, resolve_uv_tool_executable,
        verify_acp_handshake,
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
        let opencode = AgentId::parse("opencode").unwrap();
        let pi = AgentId::parse("pi").unwrap();

        assert!(!auth_document_has_account(
            &opencode,
            &serde_json::json!({
                "anthropic": {"type": "api", "key": "local"}
            }),
        ));
        assert!(!auth_document_has_account(
            &pi,
            &serde_json::json!({
                "anthropic": {"type": "api_key", "key": "local"}
            }),
        ));
        assert!(auth_document_has_account(
            &pi,
            &serde_json::json!({
                "anthropic": {"type": "oauth", "access": "token"}
            }),
        ));
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
    AgentAutoApproveMode, AgentConnectionId, AgentConnectionLaunch, AgentConnectionManager,
    ArtifactTrust, BuiltInProfileCatalog, InstallCandidateSource, InstallEnvironment,
    InstallPlanner, InstallPlanningInput, LockedInstallSource, NativeConfigPatch,
    NativeConfigProvider, OfficialRegistryHttpFetcher, PlannedDistributionKind,
    PlannedInstallComponent, ProfileComponent, ProfileInstallSource, ProfileTopology,
    RegistryCache, RegistryCacheFreshness, RegistrySnapshotClient, ResolvedInstallPlan,
    SessionLaunchLock, SystemClock, TofuFingerprint, TokioNativeFileSystem, verify_artifact_bytes,
};
use api_types::{
    AgentAuthenticationStatus, AgentDiagnosticView, AgentId, AgentManagementErrorCode,
    AgentManagementErrorView, AgentManagementView, AgentNativeConfigFieldKind,
    AgentNativeConfigFieldView, AgentNativeConfigFileView, AgentNativeConfigFormat,
    AgentNativeConfigOptionView, AgentNativeConfigPatchRequest, AgentNativeConfigView,
    AgentOperationEvent, AgentOperationKind, AgentOperationReceipt, AgentOperationStatus,
    AgentPreflightItemView, AgentPreflightView, AgentRegistryView,
};
use chrono::{Duration, Utc};
use db::models::agent_management::{AgentMembershipRepository, RegistrySnapshotRepository};
use services::services::{
    agent_management::AgentManagementQueryService, agent_registry::AgentRegistrySnapshotStore,
};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{Mutex as AsyncMutex, Semaphore, mpsc};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::state::AppState;

const MANAGEMENT_EVENT: &str = "agent-management-event";
static EVENT_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static OPERATION_SCHEDULER: OnceLock<OperationScheduler> = OnceLock::new();
static BUILT_IN_PROBES: OnceLock<AsyncMutex<HashSet<AgentId>>> = OnceLock::new();

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
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AgentManagementView>, AgentManagementErrorView> {
    probe_built_in_external_installations(&app, &state.deployment.db().pool).await;
    AgentManagementQueryService::new(state.deployment.db().pool.clone())
        .list()
        .await
        .map_err(internal_error)
}

#[tauri::command]
pub async fn agent_management_detail(
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<AgentManagementView, AgentManagementErrorView> {
    AgentManagementQueryService::new(state.deployment.db().pool.clone())
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
    AgentManagementQueryService::new(state.deployment.db().pool.clone())
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
    AgentManagementQueryService::new(state.deployment.db().pool.clone())
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
    AgentManagementQueryService::new(state.deployment.db().pool.clone())
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
    AgentManagementQueryService::new(state.deployment.db().pool.clone())
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
            acp_ok = verify_acp_handshake(
                &agent_id,
                &SessionLaunchLock {
                    agent_id: agent_id.clone(),
                    absolute_acp_program: payload.absolute_acp_program,
                    args: payload.args,
                    env: payload.env,
                    runtime_version: payload.runtime_version,
                    acp_version: payload.acp_version,
                },
                &working_dir,
                &CancellationToken::new(),
            )
            .await
            .is_ok();
        }
    }
    let authentication = if let Ok(home) = app.path().home_dir() {
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
    let lifecycle = if !runtime_ok || !acp_ok {
        "needs_repair"
    } else if authentication == AgentAuthenticationStatus::NotLoggedIn {
        "needs_auth"
    } else {
        "ready"
    };
    sqlx::query(
        r#"INSERT INTO agent_probe
           (agent_id, lifecycle, authentication, detail_json, probed_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(agent_id) DO UPDATE SET
             lifecycle = excluded.lifecycle,
             authentication = excluded.authentication,
             detail_json = excluded.detail_json,
             probed_at = excluded.probed_at"#,
    )
    .bind(agent_id.as_str())
    .bind(lifecycle)
    .bind(authentication_key(authentication))
    .bind(
        serde_json::json!({
            "runtime_available": runtime_ok,
            "acp_handshake": acp_ok,
        })
        .to_string(),
    )
    .bind(Utc::now().to_rfc3339())
    .execute(pool)
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
pub async fn agent_management_update(
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
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<AgentManagementView, AgentManagementErrorView> {
    let active_operation = sqlx::query_scalar::<_, Option<String>>(
        "SELECT active_operation FROM agent_installation WHERE agent_id = ?",
    )
    .bind(agent_id.as_str())
    .fetch_optional(&state.deployment.db().pool)
    .await
    .map_err(internal_error)?
    .flatten();
    if active_operation.is_some() {
        return Err(management_error(
            AgentManagementErrorCode::Busy,
            "Agent 已有正在执行的管理操作",
            Some(agent_id),
        ));
    }
    let changed = sqlx::query(
        r#"UPDATE agent_installation
           SET current_lock_id = rollback_lock_id,
               rollback_lock_id = current_lock_id,
               lifecycle = 'ready',
               updated_at = CURRENT_TIMESTAMP
           WHERE agent_id = ? AND rollback_lock_id IS NOT NULL"#,
    )
    .bind(agent_id.as_str())
    .execute(&state.deployment.db().pool)
    .await
    .map_err(internal_error)?
    .rows_affected();
    if changed == 0 {
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
    agent_management_detail(state, agent_id).await
}

async fn queue_operation(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    agent_id: AgentId,
    kind: AgentOperationKind,
) -> Result<AgentOperationReceipt, AgentManagementErrorView> {
    let kind_key = operation_kind_key(kind);
    let operation_id = Uuid::new_v4().to_string();
    let existing = sqlx::query_scalar::<_, Option<String>>(
        "SELECT active_operation FROM agent_installation WHERE agent_id = ?",
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await
    .map_err(internal_error)?
    .flatten();
    if existing.is_some() {
        return Err(management_error(
            AgentManagementErrorCode::Busy,
            "Agent 已有正在执行的管理操作",
            Some(agent_id),
        ));
    }
    sqlx::query(
        r#"INSERT INTO agent_installation
           (agent_id, ownership, lifecycle, current_lock_id, rollback_lock_id,
            active_operation, active_operation_id, updated_at)
           VALUES (?, 'managed', 'queued', NULL, NULL, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(agent_id) DO UPDATE SET
             lifecycle = 'queued',
             active_operation = excluded.active_operation,
             active_operation_id = excluded.active_operation_id,
             updated_at = CURRENT_TIMESTAMP"#,
    )
    .bind(agent_id.as_str())
    .bind(kind_key)
    .bind(&operation_id)
    .execute(pool)
    .await
    .map_err(internal_error)?;
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
        let plan = resolve_install_plan(&pool, &agent_id).await?;
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        let root = managed_install_root(&app_data_dir, &agent_id)?;
        tokio::fs::create_dir_all(&root).await?;
        let lock_id = Uuid::new_v4();
        let staging = root.join(format!(".staging-{lock_id}"));
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
        if let Err(error) =
            persist_installed_lock(&pool, lock_id, &plan, &installation, "managed").await
        {
            let _ = tokio::fs::remove_dir_all(&staging).await;
            return Err(error);
        }
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
    let authentication = if let Ok(home) = app.path().home_dir() {
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
    sync_authentication_probe(pool, agent_id, authentication)
        .await
        .map_err(|error| anyhow::anyhow!(error.message))
}

async fn detect_account_login(home: &Path, agent_id: &AgentId) -> bool {
    let candidates = match agent_id.as_str() {
        "claude_code" => {
            vec![config_directory(home, "CLAUDE_CONFIG_DIR", ".claude").join(".credentials.json")]
        }
        "codex" => vec![config_directory(home, "CODEX_HOME", ".codex").join("auth.json")],
        "opencode" => vec![
            config_directory(home, "XDG_DATA_HOME", ".local/share")
                .join("opencode")
                .join("auth.json"),
        ],
        "pi" => vec![config_directory(home, "PI_CODING_AGENT_DIR", ".pi/agent").join("auth.json")],
        _ => Vec::new(),
    };
    for path in candidates {
        let Ok(bytes) = tokio::fs::read(path).await else {
            continue;
        };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            continue;
        };
        if auth_document_has_account(agent_id, &value) {
            return true;
        }
    }
    false
}

fn config_directory(home: &Path, environment_key: &str, fallback: &str) -> PathBuf {
    std::env::var_os(environment_key)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(fallback))
}

fn auth_document_has_account(agent_id: &AgentId, value: &serde_json::Value) -> bool {
    match agent_id.as_str() {
        "codex" => value
            .get("tokens")
            .and_then(serde_json::Value::as_object)
            .is_some_and(|tokens| !tokens.is_empty()),
        "claude_code" => value.as_object().is_some_and(|object| !object.is_empty()),
        "opencode" | "pi" => value.as_object().is_some_and(|object| {
            object.values().any(|entry| {
                entry
                    .get("type")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|kind| !matches!(kind, "api" | "api_key"))
            })
        }),
        _ => false,
    }
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
        let (absolute_path, sha256, trust_state) = match component.distribution_kind {
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
        let root = managed_install_root(&app_data_dir, agent_id).map_err(internal_error)?;
        match tokio::fs::remove_dir_all(&root).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
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
    let active_process = state
        .agent_runtime
        .snapshot()
        .await
        .connections
        .iter()
        .any(|connection| &connection.agent_id == agent_id);
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
    Ok(native_config_view(request.agent_id, result.snapshot))
}

async fn sync_authentication_probe(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
    authentication: AgentAuthenticationStatus,
) -> Result<(), AgentManagementErrorView> {
    let installation = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT lifecycle, current_lock_id FROM agent_installation WHERE agent_id = ?",
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await
    .map_err(internal_error)?;
    let Some((current_lifecycle, current_lock_id)) = installation else {
        return Ok(());
    };
    let lifecycle = if current_lock_id.is_none() {
        "uninstalled"
    } else if matches!(authentication, AgentAuthenticationStatus::NotLoggedIn) {
        "needs_auth"
    } else if matches!(
        current_lifecycle.as_str(),
        "ready" | "needs_auth" | "needs_config"
    ) {
        "ready"
    } else {
        current_lifecycle.as_str()
    };
    sqlx::query(
        r#"INSERT INTO agent_probe
           (agent_id, lifecycle, authentication, detail_json, probed_at)
           VALUES (?, ?, ?, '{}', ?)
           ON CONFLICT(agent_id) DO UPDATE SET
             lifecycle = excluded.lifecycle,
             authentication = excluded.authentication,
             detail_json = excluded.detail_json,
             probed_at = excluded.probed_at"#,
    )
    .bind(agent_id.as_str())
    .bind(lifecycle)
    .bind(authentication_key(authentication))
    .bind(Utc::now().to_rfc3339())
    .execute(pool)
    .await
    .map_err(internal_error)?;
    Ok(())
}

fn authentication_key(authentication: AgentAuthenticationStatus) -> &'static str {
    match authentication {
        AgentAuthenticationStatus::Account => "account",
        AgentAuthenticationStatus::ApiKey => "api_key",
        AgentAuthenticationStatus::NotLoggedIn => "not_logged_in",
        AgentAuthenticationStatus::MultipleUnknown => "multiple_unknown",
        AgentAuthenticationStatus::NotRequired => "not_required",
    }
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
