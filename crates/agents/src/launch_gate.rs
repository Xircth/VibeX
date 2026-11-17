//! Launch-time authorization derived from current on-disk component evidence.

use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};
use workspace_utils::process::{node_spawnable_runtime_path, prefer_direct_spawn_executable};

use crate::{
    AgentId, AgentLifecycleState, BuiltInProfileCatalog, ProfileComponent, SessionLaunchLock,
};

/// Whether the persisted launch program currently exists on disk. Follows
/// symlinks, so a broken link (the file a shim points at was deleted or
/// relocated by the Agent's own updater) is reported missing instead of
/// reaching `Command::spawn` as a raw ENOENT.
pub fn launch_program_available(program: &Path) -> bool {
    program.is_absolute() && program.is_file()
}

/// CodeG `verify_agent_installed`: Uninstalled or a stale NeedsRepair does not
/// block launch when the ACP command is resolvable. Auth, platform, and busy
/// states stay as-is.
pub fn lifecycle_ready_for_path_acp(lifecycle: AgentLifecycleState) -> AgentLifecycleState {
    match lifecycle {
        AgentLifecycleState::Uninstalled | AgentLifecycleState::NeedsRepair => {
            AgentLifecycleState::Ready
        }
        other => other,
    }
}

/// Resolve the Built-in Profile launch command from PATH (plus user npm prefix,
/// login-shell repair, and native-engine vendor installer directories), never
/// accepting a wrapper agent's raw vendor CLI or a retired ACP wrapper shim.
pub async fn discover_path_acp_launch_lock(agent_id: &AgentId) -> Option<SessionLaunchLock> {
    let catalog = BuiltInProfileCatalog::bundled();
    let profile = catalog.profile(agent_id)?;
    let candidate = profile.external_candidates.iter().find(|candidate| {
        matches!(
            candidate.component,
            ProfileComponent::AcpAdapter | ProfileComponent::CombinedRuntime
        )
    })?;
    let executable =
        match workspace_utils::shell::resolve_executable_path(candidate.executable).await {
            Some(path) => path,
            None if matches!(profile.topology, crate::ProfileTopology::NativeEngine(_)) => {
                let home = dirs::home_dir()?;
                crate::resolve_native_engine_cli(agent_id.as_str(), &home)?
            }
            None => return None,
        };
    let executable = prefer_direct_spawn_executable(executable);
    if !launch_program_available(&executable)
        || launch_program_is_vendor_cli(agent_id, &executable)
        || launch_program_is_legacy_acp_shim(agent_id, &executable)
    {
        return None;
    }
    let args = crate::acp_launch_args(profile, candidate.component);
    Some(SessionLaunchLock {
        agent_id: agent_id.clone(),
        absolute_acp_program: executable,
        args,
        env: BTreeMap::new(),
        runtime_version: String::new(),
        acp_version: String::new(),
    })
}

/// Deterministic directory-scoped helper used to resolve a Profile's launch
/// executable inside `dirs` (including `native_engine_extra_dirs` under `dirs`
/// when `dirs` contains a user home root for a `NativeEngine` profile), while
/// rejecting wrapper vendor CLIs (`zcode`, `pi`) and legacy ACP wrapper shims.
pub fn discover_acp_launch_lock_in_dirs(
    agent_id: &AgentId,
    dirs: &[PathBuf],
) -> Option<SessionLaunchLock> {
    let catalog = BuiltInProfileCatalog::bundled();
    let profile = catalog.profile(agent_id)?;
    let candidate = profile.external_candidates.iter().find(|candidate| {
        matches!(
            candidate.component,
            ProfileComponent::AcpAdapter | ProfileComponent::CombinedRuntime
        )
    })?;
    let direct = dirs.iter().find_map(|dir| {
        #[cfg(windows)]
        let names = [
            format!("{}.exe", candidate.executable),
            format!("{}.cmd", candidate.executable),
            format!("{}.bat", candidate.executable),
            candidate.executable.to_string(),
        ];
        #[cfg(not(windows))]
        let names = [candidate.executable.to_string()];
        names
            .into_iter()
            .map(|name| dir.join(name))
            .find(|path| path.is_file())
    });
    let executable = match direct {
        Some(path) => path,
        None if matches!(profile.topology, crate::ProfileTopology::NativeEngine(_)) => dirs
            .iter()
            .find_map(|dir| crate::resolve_native_engine_cli(agent_id.as_str(), dir))?,
        None => return None,
    };
    let executable = prefer_direct_spawn_executable(executable);
    if !launch_program_available(&executable)
        || launch_program_is_vendor_cli(agent_id, &executable)
        || launch_program_is_legacy_acp_shim(agent_id, &executable)
    {
        return None;
    }
    let args = crate::acp_launch_args(profile, candidate.component);
    Some(SessionLaunchLock {
        agent_id: agent_id.clone(),
        absolute_acp_program: executable,
        args,
        env: BTreeMap::new(),
        runtime_version: String::new(),
        acp_version: String::new(),
    })
}

/// Whether `program` names a wrapper agent's native vendor CLI (`zcode`, `pi`)
/// rather than its ACP adapter. Wrapper agents must never spawn the vendor CLI
/// directly for ACP sessions.
pub fn launch_program_is_vendor_cli(agent_id: &AgentId, program: &Path) -> bool {
    let Some(name) = launch_command_name(program) else {
        return false;
    };
    if let Some(relation) = crate::acp_adapter_relation(agent_id.as_str())
        && name.eq_ignore_ascii_case(relation.native_cmd)
    {
        return true;
    }
    if let Some(profile) = BuiltInProfileCatalog::bundled().profile(agent_id)
        && profile.topology == crate::ProfileTopology::AdapterBacked
    {
        return profile.external_candidates.iter().any(|candidate| {
            candidate.component == ProfileComponent::AgentRuntime
                && name.eq_ignore_ascii_case(candidate.executable)
        });
    }
    false
}

/// Whether `program` points to a retired ACP wrapper shim (`claude-agent-acp`,
/// `claude-code-acp`, `codex-acp`) for a profile that now runs as a
/// `ProfileTopology::NativeEngine`. Stale locks pointing at legacy shims must
/// be rejected so launch/reconcile re-resolves native `claude` / `codex` or
/// requests repair.
pub fn launch_program_is_legacy_acp_shim(agent_id: &AgentId, program: &Path) -> bool {
    let Some(name) = launch_command_name(program) else {
        return false;
    };
    let catalog = BuiltInProfileCatalog::bundled();
    let Some(profile) = catalog.profile(agent_id) else {
        return false;
    };
    let mode_env = std::env::var("DIMO_ENGINE_MODE").ok();
    let effective = profile.effective_topology(
        crate::engine::EngineRuntimePreference::NativeFirst,
        mode_env.as_deref(),
    );
    if !matches!(effective, crate::ProfileTopology::NativeEngine(_)) {
        return false;
    }
    match crate::AgentKind::from_lenient(agent_id.as_str()) {
        Some(crate::AgentKind::ClaudeCode) => matches!(
            name.to_ascii_lowercase().as_str(),
            "claude-agent-acp" | "claude-code-acp" | "claude-acp"
        ),
        Some(crate::AgentKind::Codex) => name.eq_ignore_ascii_case("codex-acp"),
        _ => false,
    }
}

/// Prefer a same-named command on PATH over a stale Installation lock path.
/// Windows npm shims resolve `.exe` before `.cmd` so the launch program is
/// directly spawnable when both exist.
pub fn prefer_path_launch_program(locked: &Path) -> PathBuf {
    let locked = prefer_direct_spawn_executable(locked);
    let Some(name) = launch_command_name(&locked) else {
        return locked;
    };
    which::which(name)
        .ok()
        .filter(|path| path.is_file())
        .map(prefer_direct_spawn_executable)
        .unwrap_or(locked)
}

/// Whether Dimo's own component directories may precede the user's `PATH` in a
/// launch environment.
pub fn component_dirs_precede_user_path(agent_id: &AgentId) -> bool {
    crate::adapter_bundles_runtime(agent_id)
}

/// Environment variable an adapter-backed Agent uses to locate its local Runtime.
pub fn runtime_executable_env_key(agent_id: &AgentId) -> Option<&'static str> {
    BuiltInProfileCatalog::bundled()
        .profile(agent_id)
        .and_then(|profile| profile.runtime_executable_env)
}

/// Bind a Runtime path for ACP adapters. Adapters that ship their own vendor
/// CLI never receive this binding. `.cmd` / `.bat` shims are omitted so Node
/// can fall back to a bundled native binary; a sibling `.exe` is preferred.
pub fn bind_runtime_executable_env(
    agent_id: &AgentId,
    runtime_path: &Path,
    env: &mut BTreeMap<String, String>,
) {
    for key in crate::bundled_adapter_runtime_env_keys(agent_id) {
        env.remove(*key);
    }
    if crate::adapter_bundles_runtime(agent_id) {
        return;
    }
    let Some(variable) = runtime_executable_env_key(agent_id) else {
        return;
    };
    match node_spawnable_runtime_path(runtime_path) {
        Some(path) => {
            env.insert(variable.to_string(), path.display().to_string());
        }
        None => {
            env.remove(variable);
        }
    }
}

/// Drop a bundled-adapter Runtime binding, or rewrite a Node-spawnable path.
pub fn sanitize_runtime_executable_env(agent_id: &AgentId, env: &mut HashMap<String, String>) {
    for key in crate::bundled_adapter_runtime_env_keys(agent_id) {
        env.remove(*key);
    }
    if crate::adapter_bundles_runtime(agent_id) {
        return;
    }
    let Some(variable) = runtime_executable_env_key(agent_id) else {
        return;
    };
    let Some(current) = env.get(variable).cloned() else {
        return;
    };
    match node_spawnable_runtime_path(Path::new(&current)) {
        Some(path) => {
            env.insert(variable.to_string(), path.display().to_string());
        }
        None => {
            env.remove(variable);
        }
    }
}

/// Same as [`sanitize_runtime_executable_env`] for Installation lock env maps.
pub fn sanitize_runtime_executable_lock_env(
    agent_id: &AgentId,
    env: &mut BTreeMap<String, String>,
) {
    for key in crate::bundled_adapter_runtime_env_keys(agent_id) {
        env.remove(*key);
    }
    if crate::adapter_bundles_runtime(agent_id) {
        return;
    }
    let Some(current) = runtime_executable_env_key(agent_id)
        .and_then(|variable| env.get(variable).map(PathBuf::from))
    else {
        return;
    };
    bind_runtime_executable_env(agent_id, &current, env);
}

fn launch_command_name(program: &Path) -> Option<&str> {
    let stem = match program.to_str() {
        Some(raw) => {
            let file_name = raw.rsplit(['/', '\\']).next()?;
            Path::new(file_name).file_stem()?.to_str()?
        }
        None => program.file_stem()?.to_str()?,
    };
    let name = stem
        .strip_suffix(".cmd")
        .or_else(|| stem.strip_suffix(".CMD"))
        .unwrap_or(stem);
    (!name.is_empty()).then_some(name)
}

/// Actionable failure for a session whose launch program is gone. The
/// management lifecycle ("ready") is a probe observation that can go stale, so
/// the session must surface a repair request, not a cryptic spawn error.
pub fn missing_launch_program_error(program: &Path) -> String {
    format!(
        "ACP agent executable is missing at {}; repair or reinstall this Agent in Settings → Agent",
        program.display()
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchComponentEvidence {
    pub component_kind: String,
    pub absolute_path: PathBuf,
    pub expected_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LaunchGateError {
    #[error("locked component `{component_kind}` does not use an absolute path: {path}")]
    NonAbsolutePath {
        component_kind: String,
        path: PathBuf,
    },
    #[error("locked component `{component_kind}` is missing: {path}")]
    Missing {
        component_kind: String,
        path: PathBuf,
    },
    #[error(
        "locked component `{component_kind}` failed SHA-256 verification: expected {expected}, found {actual}"
    )]
    HashMismatch {
        component_kind: String,
        path: PathBuf,
        expected: String,
        actual: String,
    },
    #[error("locked component `{component_kind}` has no integrity evidence")]
    MissingIntegrity { component_kind: String },
    #[error("failed to read locked component `{component_kind}` at {path}: {message}")]
    Read {
        component_kind: String,
        path: PathBuf,
        message: String,
    },
}

pub struct LaunchGate;

impl LaunchGate {
    pub async fn verify(
        lock: SessionLaunchLock,
        components: &[LaunchComponentEvidence],
    ) -> Result<SessionLaunchLock, LaunchGateError> {
        Self::verify_components(components).await?;
        Ok(lock)
    }
    fn is_acp_launch_component(kind: &str) -> bool {
        matches!(kind, "acp" | "acp_adapter" | "combined_runtime")
    }

    pub async fn verify_components(
        components: &[LaunchComponentEvidence],
    ) -> Result<(), LaunchGateError> {
        for component in components {
            // Adapter-backed Agents ship a vendor CLI as optional local evidence.
            // Session launch and integrity repair only bind the ACP program
            // (ADR-0010 / ADR-0060).
            if !Self::is_acp_launch_component(&component.component_kind) {
                continue;
            }
            if !component.absolute_path.is_absolute() {
                return Err(LaunchGateError::NonAbsolutePath {
                    component_kind: component.component_kind.clone(),
                    path: component.absolute_path.clone(),
                });
            }
            if component.expected_sha256.trim().is_empty() {
                return Err(LaunchGateError::MissingIntegrity {
                    component_kind: component.component_kind.clone(),
                });
            }
            let bytes = match tokio::fs::read(&component.absolute_path).await {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Err(LaunchGateError::Missing {
                        component_kind: component.component_kind.clone(),
                        path: component.absolute_path.clone(),
                    });
                }
                Err(error) => {
                    return Err(LaunchGateError::Read {
                        component_kind: component.component_kind.clone(),
                        path: component.absolute_path.clone(),
                        message: error.to_string(),
                    });
                }
            };
            let actual = format!("{:x}", Sha256::digest(bytes));
            let expected = component.expected_sha256.to_ascii_lowercase();
            if actual != expected {
                return Err(LaunchGateError::HashMismatch {
                    component_kind: component.component_kind.clone(),
                    path: component.absolute_path.clone(),
                    expected,
                    actual,
                });
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::{BTreeMap, HashMap},
        fs,
        path::{Path, PathBuf},
    };

    use super::{
        bind_runtime_executable_env, component_dirs_precede_user_path, launch_command_name,
        launch_program_available, lifecycle_ready_for_path_acp, missing_launch_program_error,
        prefer_path_launch_program, sanitize_runtime_executable_env,
        sanitize_runtime_executable_lock_env,
    };
    use crate::{AgentId, AgentLifecycleState, BuiltInProfileCatalog, ProfileComponent};

    #[test]
    fn path_launch_uses_the_command_stem_and_falls_back_to_the_lock() {
        assert_eq!(launch_command_name(Path::new("codex.cmd")), Some("codex"));
        let missing = PathBuf::from("/definitely/not/here/dimo-acp");
        assert_eq!(prefer_path_launch_program(&missing), missing);
    }

    #[test]
    fn launch_program_is_unavailable_when_the_binary_is_gone() {
        let missing = PathBuf::from("/definitely/not/here/dimo-acp");
        assert!(!launch_program_available(&missing));
        assert!(!launch_program_available(&PathBuf::from("relative-acp")));
    }

    #[test]
    fn launch_program_is_available_for_a_real_file_but_not_a_directory() {
        let real = std::env::current_exe().expect("test binary path");
        assert!(launch_program_available(&real));
        assert!(!launch_program_available(
            real.parent().expect("dir of test binary")
        ));
    }

    #[cfg(unix)]
    #[test]
    fn launch_program_follows_a_broken_symlink_as_missing() {
        let dir = tempfile::tempdir().unwrap();
        let link = dir.path().join("acp");
        std::os::unix::fs::symlink(dir.path().join("gone"), &link).unwrap();
        assert!(!launch_program_available(&link));
    }

    #[test]
    fn missing_program_error_names_the_path_and_the_remedy() {
        let message = missing_launch_program_error(&PathBuf::from("/stale/dimo-acp"));
        assert!(message.contains("/stale/dimo-acp"), "{message}");
        assert!(message.contains("reinstall"), "{message}");
    }

    #[test]
    fn native_engine_profiles_do_not_inject_adapter_runtime_env_or_shadow_user_path() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("codex.exe");
        fs::write(&exe, b"").unwrap();

        let mut env = BTreeMap::new();
        bind_runtime_executable_env(&AgentId::parse("codex").unwrap(), &exe, &mut env);
        assert!(env.is_empty());

        let cmd = dir.path().join("claude.cmd");
        fs::write(&cmd, b"").unwrap();
        bind_runtime_executable_env(&AgentId::parse("claude_code").unwrap(), &cmd, &mut env);
        assert!(env.is_empty());

        let mut runtime_env = HashMap::new();
        sanitize_runtime_executable_env(&AgentId::parse("codex").unwrap(), &mut runtime_env);
        sanitize_runtime_executable_lock_env(&AgentId::parse("claude_code").unwrap(), &mut env);

        for agent_id in ["claude_code", "codex", "pi", "opencode", "cursor"] {
            assert!(
                !component_dirs_precede_user_path(&AgentId::parse(agent_id).unwrap()),
                "{agent_id} resolves its runtime from the user environment and must not shadow PATH"
            );
        }
    }

    #[test]
    fn path_acp_promotes_uninstalled_and_needs_repair_to_ready() {
        assert_eq!(
            lifecycle_ready_for_path_acp(AgentLifecycleState::Uninstalled),
            AgentLifecycleState::Ready
        );
        assert_eq!(
            lifecycle_ready_for_path_acp(AgentLifecycleState::NeedsRepair),
            AgentLifecycleState::Ready
        );
        assert_eq!(
            lifecycle_ready_for_path_acp(AgentLifecycleState::NeedsAuth),
            AgentLifecycleState::NeedsAuth
        );
    }

    #[test]
    fn bundled_adapter_profiles_launch_the_acp_command_not_the_vendor_cli() {
        let catalog = BuiltInProfileCatalog::bundled();
        let pi = catalog
            .profile(&AgentId::parse("pi").unwrap())
            .expect("pi profile");
        let acp = pi
            .external_candidates
            .iter()
            .find(|candidate| candidate.component == ProfileComponent::AcpAdapter)
            .unwrap();
        assert_eq!(acp.executable, "pi-acp");
        assert!(
            pi.external_candidates
                .iter()
                .any(|candidate| candidate.executable == "pi")
        );
        assert!(super::launch_program_is_vendor_cli(
            &AgentId::parse("pi").unwrap(),
            Path::new("/usr/local/bin/pi")
        ));
        assert!(super::launch_program_is_vendor_cli(
            &AgentId::parse("zcode").unwrap(),
            Path::new("/usr/local/bin/zcode")
        ));
    }

    #[test]
    fn native_engine_profiles_accept_official_cli_and_reject_legacy_acp_shims() {
        let claude = AgentId::parse("claude_code").unwrap();
        let codex = AgentId::parse("codex").unwrap();

        assert!(!super::launch_program_is_vendor_cli(
            &claude,
            Path::new("/usr/local/bin/claude")
        ));
        assert!(!super::launch_program_is_vendor_cli(
            &codex,
            Path::new("/usr/local/bin/codex")
        ));
        assert!(super::launch_program_is_legacy_acp_shim(
            &claude,
            Path::new("/usr/local/bin/claude-agent-acp")
        ));
        assert!(super::launch_program_is_legacy_acp_shim(
            &claude,
            Path::new("/usr/local/bin/claude-code-acp")
        ));
        assert!(super::launch_program_is_legacy_acp_shim(
            &codex,
            Path::new(r"C:\Users\dev\AppData\Roaming\npm\codex-acp.cmd")
        ));
        assert!(!super::launch_program_is_legacy_acp_shim(
            &claude,
            Path::new("/usr/local/bin/claude")
        ));
        assert!(!super::launch_program_is_legacy_acp_shim(
            &codex,
            Path::new("/usr/local/bin/codex")
        ));
    }
}
