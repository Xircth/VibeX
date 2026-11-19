use std::{sync::Arc, time::Duration};

use agents::{
    BuiltInProfile, BuiltInProfileCatalog, ProfileComponent, ProfileTopology, UserEnvironmentLayout,
};
use api_types::AgentDiscoveryProgressView;
use futures::StreamExt;
use sqlx::SqlitePool;

use super::{
    agent_management_runtime::{
        AgentManagementRuntimeState, LocalRuntimeEvidence, local_runtime_discovery_progress_view,
    },
    desktop_client_probe::{current_desktop_client_roots, discover_desktop_client},
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
    let desktop_roots = Arc::new(current_desktop_client_roots());
    runtime
        .begin_local_runtime_discovery(u32::try_from(candidates.len()).unwrap_or(u32::MAX))
        .await;
    emit_progress(&runtime, &on_progress).await;
    let jobs = candidates.into_iter().map(|profile| {
        let pool = pool.clone();
        let runtime = Arc::clone(&runtime);
        let on_progress = Arc::clone(&on_progress);
        let desktop_roots = Arc::clone(&desktop_roots);
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
                ProfileTopology::NativeAcp | ProfileTopology::NativeEngine(_) => {
                    local_runtime.clone()
                }
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
            if super::native_engine_adopt::is_native_engine_profile(&profile.agent_id)
                && let Some(ref evidence) = local_runtime
                && evidence
                    .version
                    .as_deref()
                    .is_some_and(|version| !version.trim().is_empty())
                && let Err(error) = super::native_engine_adopt::adopt_native_engine_if_needed(
                    &pool,
                    &profile.agent_id,
                    &evidence.path,
                    evidence.version.as_deref(),
                    None,
                )
                .await
            {
                tracing::debug!(
                    agent_id = %profile.agent_id,
                    %error,
                    "skipping native engine adoption during startup discovery"
                );
            }
            let desktop_client = discover_desktop_client(profile.agent_id.as_str(), &desktop_roots)
                .map(|path| LocalRuntimeEvidence {
                    path,
                    version: None,
                });
            runtime
                .replace_desktop_client(profile.agent_id.clone(), desktop_client.clone())
                .await;
            runtime
                .record_local_runtime_discovery(
                    profile.agent_id.clone(),
                    acp_adapter.is_some() || local_runtime.is_some() || desktop_client.is_some(),
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
    let mut last_error = None;
    for candidate in profile
        .external_candidates
        .iter()
        .filter(|candidate| candidate.component == ProfileComponent::AcpAdapter)
    {
        match probe_candidate(candidate.executable, candidate.version_args).await {
            Ok(evidence) => return Ok(evidence),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error
        .unwrap_or_else(|| anyhow::anyhow!("Profile does not declare an ACP adapter candidate")))
}

async fn discover_profile_local_runtime(
    _pool: &SqlitePool,
    profile: &BuiltInProfile,
) -> anyhow::Result<LocalRuntimeEvidence> {
    let runtime_candidates = profile
        .external_candidates
        .iter()
        .filter(|candidate| {
            matches!(
                candidate.component,
                ProfileComponent::AgentRuntime | ProfileComponent::CombinedRuntime
            )
        })
        .collect::<Vec<_>>();
    if runtime_candidates.is_empty() {
        anyhow::bail!("Profile does not declare a local Runtime candidate");
    }
    let mut last_error = None;
    for candidate in runtime_candidates {
        let mut candidates = agents::resolve_user_runtime_commands(candidate.executable).await;
        if matches!(profile.topology, ProfileTopology::NativeEngine(_))
            && let Some(home) = dirs::home_dir()
            && let Some(extra_cli) =
                agents::resolve_native_engine_cli(profile.agent_id.as_str(), &home)
            && agents::published_cli_shim_agent(&extra_cli).is_none()
            && !candidates.iter().any(|existing| existing == &extra_cli)
        {
            candidates.push(extra_cli);
        }
        if candidates.is_empty() {
            last_error = Some(anyhow::anyhow!(
                "no user-installed Runtime `{}` was found on PATH",
                candidate.executable
            ));
            continue;
        }
        match probe_resolved_candidates(candidates, candidate.version_args).await {
            Ok(evidence) => return Ok(evidence),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error
        .unwrap_or_else(|| anyhow::anyhow!("no user-installed Runtime was found on PATH")))
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
                path: executable.clone(),
                version: executable_file_revision(&executable),
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

/// Identity of an executable that has no safe `--version` probe.
///
/// Antigravity's ACP server blocks on `--version`. The file mtime and length
/// change when the binary changes, so discovery can skip spawning it.
pub fn executable_file_revision(path: &std::path::Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    let secs = modified
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    Some(format!("file:{secs}:{}", meta.len()))
}

fn precise_file_revision(path: &std::path::Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let modified = meta.modified().ok()?;
    let duration = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(format!(
        "{}.{}:{}",
        duration.as_secs(),
        duration.subsec_nanos(),
        meta.len()
    ))
}

fn is_script_wrapper_file(path: &std::path::Path) -> bool {
    if utils::process::is_windows_batch_script(path) {
        return true;
    }
    if path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| matches!(ext.to_ascii_lowercase().as_str(), "ps1" | "sh"))
    {
        return true;
    }
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    use std::io::Read;
    let mut header = [0u8; 2];
    matches!(file.read_exact(&mut header), Ok(()) if &header == b"#!")
}

fn extract_wrapper_target_paths(wrapper: &std::path::Path) -> Vec<std::path::PathBuf> {
    let Some(base_dir) = wrapper.parent() else {
        return Vec::new();
    };
    let Ok(bytes) = std::fs::read(wrapper) else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&bytes);
    const PREFIXES: &[&str] = &[
        "%dp0%",
        "%~dp0",
        "$basedir",
        "${basedir}",
        "$(dirname \"$0\")",
        "$(dirname '$0')",
    ];
    let mut targets = Vec::new();
    for line in text.lines() {
        let lower = line.to_ascii_lowercase();
        for prefix in PREFIXES {
            let mut start = 0;
            while let Some(offset) = lower[start..].find(&prefix.to_ascii_lowercase()) {
                let after = start + offset + prefix.len();
                let rest = &line[after..];
                let end = rest
                    .find(['"', '\'', '\r', '\n', ' ', '\t'])
                    .unwrap_or(rest.len());
                let raw_rel = rest[..end].trim_start_matches(['\\', '/']);
                if !raw_rel.is_empty() {
                    let mut candidate = base_dir.to_path_buf();
                    for component in raw_rel.split(['\\', '/']).filter(|s| !s.is_empty()) {
                        candidate.push(component);
                    }
                    if candidate.is_file() && !targets.iter().any(|existing| existing == &candidate)
                    {
                        targets.push(candidate);
                    }
                }
                start = after;
            }
        }
    }
    targets
}

fn nearest_package_json(target: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut dir = target.parent()?;
    for _ in 0..5 {
        let pkg = dir.join("package.json");
        if pkg.is_file() {
            return Some(pkg);
        }
        if dir
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name == "node_modules")
        {
            break;
        }
        dir = dir.parent()?;
    }
    None
}

fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// Cache identity used by `--version` probing.
///
/// Direct native executables invalidate via high-resolution mtime + length.
/// `.cmd`/`.bat`/shell shims keep their own mtime/length across npm or wrapper
/// upgrades, so we track the referenced target files + `package.json` when
/// statically discoverable, or bypass the cache (`None`) for opaque wrappers.
fn version_probe_cache_revision(executable: &std::path::Path) -> Option<String> {
    let self_rev = precise_file_revision(executable)?;
    if !is_script_wrapper_file(executable) {
        return Some(format!("bin:{self_rev}"));
    }
    let targets = extract_wrapper_target_paths(executable);
    if targets.is_empty() {
        return None;
    }
    let mut parts = vec![self_rev];
    for target in targets {
        if let Some(target_rev) = precise_file_revision(&target) {
            parts.push(format!("{}:{target_rev}", target.to_string_lossy()));
        }
        if let Some(pkg) = nearest_package_json(&target)
            && let Some(pkg_rev) = precise_file_revision(&pkg)
        {
            let digest = std::fs::read(&pkg)
                .ok()
                .filter(|bytes| bytes.len() <= 64 * 1024)
                .map(|bytes| format!(":h{:016x}", fnv1a_64(&bytes)))
                .unwrap_or_default();
            parts.push(format!("{}:{pkg_rev}{digest}", pkg.to_string_lossy()));
        }
    }
    if parts.len() <= 1 {
        return None;
    }
    Some(format!("shim:{}", parts.join("|")))
}

fn probe_cache_path() -> std::path::PathBuf {
    utils::assets::host_data_dir().join("runtime-probe-cache.json")
}

fn probe_cache_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn read_cached_probe_version(path: &std::path::Path, revision: &str) -> Option<String> {
    let _guard = probe_cache_lock();
    let raw = std::fs::read(probe_cache_path()).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&raw).ok()?;
    let entry = value.get(path.to_string_lossy().as_ref())?;
    if entry.get("revision").and_then(|item| item.as_str()) != Some(revision) {
        return None;
    }
    entry
        .get("version")
        .and_then(|item| item.as_str())
        .filter(|version| !version.is_empty())
        .map(str::to_owned)
}

fn write_cached_probe_version(path: &std::path::Path, revision: &str, version: &str) {
    let _guard = probe_cache_lock();
    let cache_path = probe_cache_path();
    let mut value = std::fs::read(&cache_path)
        .ok()
        .and_then(|raw| serde_json::from_slice::<serde_json::Value>(&raw).ok())
        .filter(|value| value.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(object) = value.as_object_mut() {
        object.insert(
            path.to_string_lossy().into_owned(),
            serde_json::json!({ "revision": revision, "version": version }),
        );
    }
    if let Some(parent) = cache_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(body) = serde_json::to_vec_pretty(&value) {
        let _ = std::fs::write(cache_path, body);
    }
}

struct KillGroupOnDrop(Option<command_group::AsyncGroupChild>);

impl Drop for KillGroupOnDrop {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.start_kill();
        }
    }
}

async fn probe_version(
    executable: &std::path::Path,
    version_args: &[&str],
) -> anyhow::Result<Option<String>> {
    use tokio::io::AsyncReadExt;

    let revision = version_probe_cache_revision(executable);
    if let Some(revision) = revision.as_deref()
        && let Some(cached) = read_cached_probe_version(executable, revision)
    {
        return Ok(Some(cached));
    }
    let mut command = utils::process::new_hidden_tokio_command(executable, version_args);
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = utils::process::group_spawn_no_window(&mut command)?;
    let mut stdout_pipe = child
        .inner()
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("version probe missing stdout"))?;
    let mut stderr_pipe = child
        .inner()
        .stderr
        .take()
        .ok_or_else(|| anyhow::anyhow!("version probe missing stderr"))?;
    let mut guard = KillGroupOnDrop(Some(child));

    let (status, stdout_bytes, stderr_bytes) =
        tokio::time::timeout(LOCAL_RUNTIME_VERSION_TIMEOUT, async {
            let child_ref = guard.0.as_mut().expect("active probe child");
            let read_out = async {
                let mut buf = Vec::new();
                stdout_pipe.read_to_end(&mut buf).await?;
                Ok::<Vec<u8>, std::io::Error>(buf)
            };
            let read_err = async {
                let mut buf = Vec::new();
                stderr_pipe.read_to_end(&mut buf).await?;
                Ok::<Vec<u8>, std::io::Error>(buf)
            };
            tokio::try_join!(child_ref.wait(), read_out, read_err)
        })
        .await
        .map_err(|_| anyhow::anyhow!("external Runtime version probe timed out"))??;
    let _ = guard.0.take();

    if !status.success() {
        anyhow::bail!("external Runtime version probe failed");
    }
    let stdout = String::from_utf8_lossy(&stdout_bytes).trim().to_string();
    let stderr = String::from_utf8_lossy(&stderr_bytes).trim().to_string();
    let version = [stdout, stderr].into_iter().find(|value| !value.is_empty());
    if let (Some(revision), Some(version)) = (revision.as_deref(), version.as_deref()) {
        write_cached_probe_version(executable, revision, version);
    }
    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::{
        canonicalize_spawnable, probe_resolved_candidates, probe_version,
        version_probe_cache_revision,
    };

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
    async fn empty_version_args_use_file_revision_without_running_the_binary() {
        let dir = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        let script = {
            let script = dir.path().join("agy_acp_server.cmd");
            std::fs::write(&script, b"@echo off\r\nexit /b 1\r\n").unwrap();
            script
        };
        #[cfg(not(windows))]
        let script = {
            use std::os::unix::fs::PermissionsExt;
            let script = dir.path().join("agy_acp_server");
            std::fs::write(&script, b"#!/bin/sh\nexit 1\n").unwrap();
            let mut permissions = std::fs::metadata(&script).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&script, permissions).unwrap();
            script
        };
        let evidence = probe_resolved_candidates(vec![script], &[])
            .await
            .expect("present binary is evidence");
        let version = evidence.version.expect("file revision");
        assert!(version.starts_with("file:"), "{version}");
        assert_ne!(version, "1.0.0");
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

    #[tokio::test]
    async fn wrapper_shim_invalidates_cached_version_when_target_package_updates() {
        let dir = tempfile::tempdir().unwrap();
        let pkg_dir = dir
            .path()
            .join("node_modules")
            .join("@openai")
            .join("codex");
        let bin_dir = pkg_dir.join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let pkg_json = pkg_dir.join("package.json");
        let entry = bin_dir.join("codex.js");
        let version_file = pkg_dir.join("version.txt");

        std::fs::write(&pkg_json, r#"{"name":"@openai/codex","version":"0.169.0"}"#).unwrap();
        std::fs::write(&entry, "// entrypoint 0.169.0\n").unwrap();
        std::fs::write(&version_file, "0.169.0").unwrap();

        #[cfg(windows)]
        let script = {
            let script = dir.path().join("codex.cmd");
            std::fs::write(
                &script,
                "@echo off\r\nrem \"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js\"\r\ntype \"%~dp0node_modules\\@openai\\codex\\version.txt\"\r\n",
            )
            .unwrap();
            script
        };
        #[cfg(not(windows))]
        let script = {
            use std::os::unix::fs::PermissionsExt;
            let script = dir.path().join("codex");
            std::fs::write(
                &script,
                "#!/bin/sh\n# \"$basedir/node_modules/@openai/codex/bin/codex.js\"\ncat \"$(dirname \"$0\")/node_modules/@openai/codex/version.txt\"\n",
            )
            .unwrap();
            let mut permissions = std::fs::metadata(&script).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&script, permissions).unwrap();
            script
        };

        let rev_before = version_probe_cache_revision(&script).expect("npm shim revision");
        assert!(rev_before.starts_with("shim:"), "{rev_before}");
        let v1 = probe_version(&script, &["--version"]).await.unwrap();
        assert_eq!(v1.as_deref(), Some("0.169.0"));

        // Update package files without touching the shim script itself.
        std::fs::write(&pkg_json, r#"{"name":"@openai/codex","version":"0.169.1"}"#).unwrap();
        std::fs::write(&version_file, "0.169.1").unwrap();

        let rev_after = version_probe_cache_revision(&script).expect("updated npm shim revision");
        assert_ne!(rev_before, rev_after);
        let v2 = probe_version(&script, &["--version"]).await.unwrap();
        assert_eq!(v2.as_deref(), Some("0.169.1"));
    }
}
