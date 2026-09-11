use std::{sync::Arc, time::Duration};

use agents::{
    BuiltInProfile, BuiltInProfileCatalog, ProfileComponent, ProfileTopology, UserEnvironmentLayout,
};
use api_types::AgentDiscoveryProgressView;
use futures::StreamExt;
use sqlx::SqlitePool;

use super::agent_management_runtime::{
    AgentManagementRuntimeState, LocalRuntimeEvidence, local_runtime_discovery_progress_view,
};

const MAX_CONCURRENT_LOCAL_RUNTIME_PROBES: usize = 12;
const LOCAL_RUNTIME_VERSION_TIMEOUT: Duration = Duration::from_secs(3);
const LOCAL_RUNTIME_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(20);

pub async fn warm_local_runtime_discovery(
    pool: &SqlitePool,
    runtime: &Arc<AgentManagementRuntimeState>,
    on_progress: impl Fn(AgentDiscoveryProgressView) + Send + Sync + 'static,
) {
    let on_progress: Arc<dyn Fn(AgentDiscoveryProgressView) + Send + Sync> = Arc::new(on_progress);
    runtime
        .run_local_runtime_discovery_once(discover_built_in_local_runtimes(
            pool.clone(),
            Arc::clone(runtime),
            on_progress,
        ))
        .await;
}

pub async fn discover_built_in_local_runtimes(
    pool: SqlitePool,
    runtime: Arc<AgentManagementRuntimeState>,
    on_progress: Arc<dyn Fn(AgentDiscoveryProgressView) + Send + Sync>,
) {
    let _ = utils::shell::refresh_process_path().await;
    if let Some(home) = dirs::home_dir() {
        let user_env = UserEnvironmentLayout::for_current_user(home);
        for directory in user_env.path_entries() {
            utils::shell::expose_user_bin_to_process_path(&directory);
        }
    }
    let candidates = BuiltInProfileCatalog::bundled().profiles().to_vec();
    runtime
        .begin_local_runtime_discovery(u32::try_from(candidates.len()).unwrap_or(u32::MAX))
        .await;
    emit_progress(&runtime, &on_progress).await;
    let jobs = candidates.into_iter().map(|profile| {
        let pool = pool.clone();
        let runtime = Arc::clone(&runtime);
        let on_progress = Arc::clone(&on_progress);
        async move {
            let local_runtime = match discover_profile_local_runtime(&pool, &profile).await {
                Ok(evidence) => Some(evidence),
                Err(error) => {
                    tracing::debug!(
                        agent_id = %profile.agent_id,
                        %error,
                        "built-in local Runtime candidate was not discovered"
                    );
                    None
                }
            };
            let acp_adapter = match profile.topology {
                ProfileTopology::NativeAcp => local_runtime.clone(),
                ProfileTopology::AdapterBacked => {
                    match discover_profile_acp_adapter(&profile).await {
                        Ok(evidence) => Some(evidence),
                        Err(error) => {
                            tracing::debug!(
                                agent_id = %profile.agent_id,
                                %error,
                                "built-in ACP adapter candidate was not discovered"
                            );
                            None
                        }
                    }
                }
            };
            runtime
                .replace_local_runtime(profile.agent_id.clone(), local_runtime.clone())
                .await;
            runtime
                .replace_acp_adapter(profile.agent_id.clone(), acp_adapter.clone())
                .await;
            runtime
                .record_local_runtime_discovery(
                    profile.agent_id.clone(),
                    acp_adapter.is_some() || local_runtime.is_some(),
                )
                .await;
            emit_progress(&runtime, &on_progress).await;
        }
    });
    let timed_out = tokio::time::timeout(
        LOCAL_RUNTIME_DISCOVERY_TIMEOUT,
        futures::stream::iter(jobs)
            .buffer_unordered(MAX_CONCURRENT_LOCAL_RUNTIME_PROBES)
            .collect::<Vec<_>>(),
    )
    .await
    .is_err();
    if timed_out {
        tracing::warn!(
            timeout_secs = LOCAL_RUNTIME_DISCOVERY_TIMEOUT.as_secs(),
            "local Agent Runtime discovery reached its startup time budget"
        );
    }
    runtime.finish_local_runtime_discovery(timed_out).await;
    emit_progress(&runtime, &on_progress).await;
}

async fn emit_progress(
    runtime: &AgentManagementRuntimeState,
    on_progress: &Arc<dyn Fn(AgentDiscoveryProgressView) + Send + Sync>,
) {
    on_progress(local_runtime_discovery_progress_view(
        runtime.local_runtime_discovery_progress().await,
    ));
}

async fn discover_profile_acp_adapter(
    profile: &BuiltInProfile,
) -> anyhow::Result<LocalRuntimeEvidence> {
    let candidate = profile
        .external_candidates
        .iter()
        .find(|candidate| candidate.component == ProfileComponent::AcpAdapter)
        .ok_or_else(|| anyhow::anyhow!("Profile does not declare an ACP adapter candidate"))?;
    probe_candidate(candidate.executable, candidate.version_args).await
}

async fn discover_profile_local_runtime(
    _pool: &SqlitePool,
    profile: &BuiltInProfile,
) -> anyhow::Result<LocalRuntimeEvidence> {
    let candidate = profile
        .external_candidates
        .iter()
        .find(|candidate| {
            matches!(
                candidate.component,
                ProfileComponent::AgentRuntime | ProfileComponent::CombinedRuntime
            )
        })
        .ok_or_else(|| anyhow::anyhow!("Profile does not declare a local Runtime candidate"))?;
    probe_user_runtime_candidate(candidate.executable, candidate.version_args).await
}

/// Probe a Runtime the *user* installed.
///
/// VibeX publishes its managed Runtime into the user's `~/.local/bin` under the
/// vendor command name, so the first PATH hit is VibeX's own artifact on a
/// machine where the user has nothing. Adoption asks whether the user already
/// had a Runtime, and a shim VibeX wrote is not an answer to that question.
async fn probe_user_runtime_candidate(
    executable: &str,
    version_args: &[&str],
) -> anyhow::Result<LocalRuntimeEvidence> {
    let executable = agents::resolve_user_runtime_command(executable)
        .await
        .ok_or_else(|| {
            anyhow::anyhow!("no user-installed Runtime `{executable}` was found on PATH")
        })?;
    probe_resolved_candidate(executable, version_args).await
}

async fn probe_candidate(
    executable: &str,
    version_args: &[&str],
) -> anyhow::Result<LocalRuntimeEvidence> {
    let executable = utils::shell::resolve_executable_path(executable)
        .await
        .ok_or_else(|| anyhow::anyhow!("external candidate `{executable}` was not found"))?;
    probe_resolved_candidate(executable, version_args).await
}

async fn probe_resolved_candidate(
    executable: std::path::PathBuf,
    version_args: &[&str],
) -> anyhow::Result<LocalRuntimeEvidence> {
    let executable =
        utils::process::prefer_direct_spawn_executable(tokio::fs::canonicalize(executable).await?);
    if !executable.is_absolute() || !tokio::fs::metadata(&executable).await?.is_file() {
        anyhow::bail!("external candidate is not an absolute executable file");
    }
    if version_args.is_empty() {
        return Ok(LocalRuntimeEvidence {
            path: executable,
            version: Some("1.0.0".to_string()),
        });
    }
    let mut command = utils::process::new_hidden_tokio_command(&executable, version_args);
    command.kill_on_drop(true);
    let output = tokio::time::timeout(LOCAL_RUNTIME_VERSION_TIMEOUT, command.output())
        .await
        .map_err(|_| anyhow::anyhow!("external Runtime version probe timed out"))??;
    if !output.status.success() {
        anyhow::bail!("external Runtime version probe failed");
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let version = [stdout, stderr].into_iter().find(|value| !value.is_empty());
    Ok(LocalRuntimeEvidence {
        path: executable,
        version,
    })
}
