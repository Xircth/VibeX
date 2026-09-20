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
    let candidates = agents::resolve_user_runtime_commands(executable).await;
    if candidates.is_empty() {
        anyhow::bail!("no user-installed Runtime `{executable}` was found on PATH");
    }
    probe_resolved_candidates(candidates, version_args).await
}

async fn probe_candidate(
    executable: &str,
    version_args: &[&str],
) -> anyhow::Result<LocalRuntimeEvidence> {
    let candidates = utils::shell::resolve_executable_paths(executable).await;
    if candidates.is_empty() {
        anyhow::bail!("external candidate `{executable}` was not found");
    }
    probe_resolved_candidates(candidates, version_args).await
}

async fn probe_resolved_candidates(
    candidates: Vec<std::path::PathBuf>,
    version_args: &[&str],
) -> anyhow::Result<LocalRuntimeEvidence> {
    let mut first_path = None;
    for executable in candidates {
        let Ok(executable) = canonicalize_spawnable(executable).await else {
            continue;
        };
        if first_path.is_none() {
            first_path = Some(executable.clone());
        }
        if version_args.is_empty() {
            return Ok(LocalRuntimeEvidence {
                path: executable,
                version: Some("1.0.0".to_string()),
            });
        }
        match probe_version(&executable, version_args).await {
            Ok(version) => {
                return Ok(LocalRuntimeEvidence {
                    path: executable,
                    version,
                });
            }
            Err(error) => {
                tracing::debug!(
                    path = %executable.display(),
                    %error,
                    "external Runtime version probe failed; trying the next PATH hit"
                );
            }
        }
    }
    let path = first_path
        .ok_or_else(|| anyhow::anyhow!("external candidate is not an absolute executable file"))?;
    Ok(LocalRuntimeEvidence {
        path,
        version: None,
    })
}

async fn canonicalize_spawnable(
    executable: std::path::PathBuf,
) -> anyhow::Result<std::path::PathBuf> {
    let executable = utils::process::prefer_windows_spawnable_executable(&executable)
        .ok_or_else(|| anyhow::anyhow!("external candidate is not spawnable"))?;
    let executable =
        utils::process::prefer_direct_spawn_executable(tokio::fs::canonicalize(executable).await?);
    if !executable.is_absolute() || !tokio::fs::metadata(&executable).await?.is_file() {
        anyhow::bail!("external candidate is not an absolute executable file");
    }
    Ok(executable)
}

async fn probe_version(
    executable: &std::path::Path,
    version_args: &[&str],
) -> anyhow::Result<Option<String>> {
    let mut command = utils::process::new_hidden_tokio_command(executable, version_args);
    command.kill_on_drop(true);
    let output = tokio::time::timeout(LOCAL_RUNTIME_VERSION_TIMEOUT, command.output())
        .await
        .map_err(|_| anyhow::anyhow!("external Runtime version probe timed out"))??;
    if !output.status.success() {
        anyhow::bail!("external Runtime version probe failed");
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Ok([stdout, stderr].into_iter().find(|value| !value.is_empty()))
}

#[cfg(test)]
mod tests {
    use super::{canonicalize_spawnable, probe_resolved_candidates};

    #[tokio::test]
    async fn keeps_a_spawnable_path_when_version_probe_fails() {
        let dir = tempfile::tempdir().unwrap();

        #[cfg(windows)]
        let script = {
            let script = dir.path().join("codex.cmd");
            std::fs::write(&script, "@echo off\r\nexit /b 1\r\n").unwrap();
            script
        };
        #[cfg(not(windows))]
        let script = {
            use std::os::unix::fs::PermissionsExt;
            let script = dir.path().join("codex");
            std::fs::write(&script, "#!/bin/sh\nexit 1\n").unwrap();
            let mut permissions = std::fs::metadata(&script).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&script, permissions).unwrap();
            script
        };

        let evidence = probe_resolved_candidates(vec![script.clone()], &["--version"])
            .await
            .expect("a present CLI is still evidence when --version fails");
        let expected = canonicalize_spawnable(script).await.unwrap();
        assert_eq!(evidence.path, expected);
        assert!(evidence.version.is_none());
    }

    #[tokio::test]
    async fn skips_an_unrunnable_hit_for_a_later_working_cli() {
        let dir = tempfile::tempdir().unwrap();
        let broken = dir.path().join("Microsoft").join("WindowsApps");
        std::fs::create_dir_all(&broken).unwrap();
        let alias = broken.join("claude.exe");
        std::fs::write(&alias, b"").unwrap();

        #[cfg(windows)]
        let working = {
            let script = dir.path().join("claude.cmd");
            std::fs::write(&script, "@echo off\r\necho 2.1.220\r\n").unwrap();
            script
        };
        #[cfg(not(windows))]
        let working = {
            use std::os::unix::fs::PermissionsExt;
            let script = dir.path().join("claude");
            std::fs::write(&script, "#!/bin/sh\nprintf '2.1.220'\n").unwrap();
            let mut permissions = std::fs::metadata(&script).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&script, permissions).unwrap();
            script
        };

        let evidence = probe_resolved_candidates(vec![alias, working.clone()], &["--version"])
            .await
            .expect("later PATH hit should be used");
        let expected = canonicalize_spawnable(working).await.unwrap();
        assert_eq!(evidence.path, expected);
        assert_eq!(evidence.version.as_deref(), Some("2.1.220"));
    }
}
