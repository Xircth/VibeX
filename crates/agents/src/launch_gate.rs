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

/// Resolve the Built-in Profile ACP launch command the same way CodeG's
/// connect gate uses `is_cmd_available` / `resolve_npx_command`: PATH (plus
/// user npm prefix / login-shell repair), never a vendor CLI.
pub async fn discover_path_acp_launch_lock(agent_id: &AgentId) -> Option<SessionLaunchLock> {
    let catalog = BuiltInProfileCatalog::bundled();
    let profile = catalog.profile(agent_id)?;
    let candidate = profile.external_candidates.iter().find(|candidate| {
        matches!(
            candidate.component,
            ProfileComponent::AcpAdapter | ProfileComponent::CombinedRuntime
        )
    })?;
    let executable = workspace_utils::shell::resolve_executable_path(candidate.executable).await?;
    let executable = prefer_direct_spawn_executable(executable);
    if !launch_program_available(&executable) {
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
    let stem = program.file_stem()?.to_str()?;
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
    pub async fn verify_components(
        components: &[LaunchComponentEvidence],
    ) -> Result<(), LaunchGateError> {
        for component in components {
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
        bind_runtime_executable_env, launch_command_name, launch_program_available,
        lifecycle_ready_for_path_acp, missing_launch_program_error, prefer_path_launch_program,
        sanitize_runtime_executable_env, sanitize_runtime_executable_lock_env,
    };
    use crate::{AgentId, AgentLifecycleState, BuiltInProfileCatalog, ProfileComponent};

    #[test]
    fn path_launch_uses_the_command_stem_and_falls_back_to_the_lock() {
        assert_eq!(
            launch_command_name(Path::new("codex-acp.cmd")),
            Some("codex-acp")
        );
        let missing = PathBuf::from("/definitely/not/here/vibex-acp");
        assert_eq!(prefer_path_launch_program(&missing), missing);
    }

    #[test]
    fn launch_program_is_unavailable_when_the_binary_is_gone() {
        let missing = PathBuf::from("/definitely/not/here/vibex-acp");
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
        let message = missing_launch_program_error(&PathBuf::from("/stale/vibex-acp"));
        assert!(message.contains("/stale/vibex-acp"), "{message}");
        assert!(message.contains("reinstall"), "{message}");
    }

    #[test]
    fn bundled_adapter_runtime_env_is_never_injected() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("codex.exe");
        fs::write(&exe, b"").unwrap();

        let mut env = BTreeMap::new();
        bind_runtime_executable_env(&AgentId::parse("codex").unwrap(), &exe, &mut env);
        assert!(!env.contains_key("CODEX_PATH"));
    }

    #[test]
    fn adapter_runtime_env_omits_cmd_shims_without_an_exe() {
        let dir = tempfile::tempdir().unwrap();
        let cmd = dir.path().join("claude.cmd");
        fs::write(&cmd, b"").unwrap();

        let mut env = BTreeMap::new();
        bind_runtime_executable_env(&AgentId::parse("claude_code").unwrap(), &cmd, &mut env);
        assert!(!env.contains_key("CLAUDE_CODE_EXECUTABLE"));
    }

    #[test]
    fn sanitizing_launch_env_drops_stale_cmd_bindings() {
        let mut env = HashMap::from([(
            "CODEX_PATH".to_string(),
            r"C:\Users\developer\AppData\Roaming\npm\codex.cmd".to_string(),
        )]);
        sanitize_runtime_executable_env(&AgentId::parse("codex").unwrap(), &mut env);
        assert!(!env.contains_key("CODEX_PATH"));

        let mut lock_env = BTreeMap::from([(
            "CLAUDE_CODE_EXECUTABLE".to_string(),
            r"\\?\C:\Users\developer\AppData\Roaming\npm\claude.cmd".to_string(),
        )]);
        sanitize_runtime_executable_lock_env(
            &AgentId::parse("claude_code").unwrap(),
            &mut lock_env,
        );
        assert!(!lock_env.contains_key("CLAUDE_CODE_EXECUTABLE"));
    }

    #[test]
    fn sanitizing_launch_env_drops_bundled_adapter_exe_bindings() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("claude.exe");
        fs::write(&exe, b"").unwrap();
        let mut env = HashMap::from([(
            "CLAUDE_CODE_EXECUTABLE".to_string(),
            exe.display().to_string(),
        )]);
        sanitize_runtime_executable_env(&AgentId::parse("claude_code").unwrap(), &mut env);
        assert!(!env.contains_key("CLAUDE_CODE_EXECUTABLE"));
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
        for (agent_id, adapter, vendor) in [
            ("claude_code", "claude-agent-acp", "claude"),
            ("codex", "codex-acp", "codex"),
            ("pi", "pi-acp", "pi"),
        ] {
            let profile = catalog.profile(&AgentId::parse(agent_id).unwrap()).unwrap();
            let acp = profile
                .external_candidates
                .iter()
                .find(|candidate| candidate.component == ProfileComponent::AcpAdapter)
                .unwrap();
            assert_eq!(acp.executable, adapter);
            assert!(
                profile
                    .external_candidates
                    .iter()
                    .any(|candidate| candidate.executable == vendor)
            );
        }
    }
}
