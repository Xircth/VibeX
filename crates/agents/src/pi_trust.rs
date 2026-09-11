//! Pi project trust: explicit per-workspace decisions, never auto-seeded.
//!
//! Pi loads a repo's `.pi/*` (including `.pi/extensions`, which execute at
//! startup) only after the workspace is trusted in `trust.json`. Because
//! `pi-acp` spawns `pi --mode rpc` with no UI, auto-writing that grant on
//! launch would execute repo-controlled code without asking. Trust is an
//! explicit user decision; an unacknowledged in-force grant blocks launch.

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use serde_json::Value;

pub const PI_COMMAND_ENV: &str = "PI_ACP_PI_COMMAND";
pub const PI_CONFIG_DIR_ENV: &str = "PI_CODING_AGENT_DIR";
pub const PI_SESSION_DIR_ENV: &str = "PI_CODING_AGENT_SESSION_DIR";
/// Legacy per-agent env key that used to gate launch-time auto-trust. Nothing
/// reads it anymore; it stays reserved so a persisted `"0"` does not reappear
/// in the raw env editor.
pub const PI_TRUST_WORKSPACE_ENV: &str = "PI_ACP_TRUST_WORKSPACE";

const PI_TRUST_REQUIRING_CONFIG_RESOURCES: [&str; 7] = [
    "settings.json",
    "extensions",
    "skills",
    "prompts",
    "themes",
    "SYSTEM.md",
    "APPEND_SYSTEM.md",
];
const PI_TRUST_LOCK_STALE: Duration = Duration::from_secs(10);
static PI_TRUST_WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PiProjectResource {
    pub path: String,
    pub kind: String,
    pub executes_code: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PiProjectTrustState {
    pub workspace: String,
    pub resources: Vec<PiProjectResource>,
    pub decision: Option<bool>,
    pub decided_at: Option<String>,
    pub trust_file: String,
    pub acknowledged: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PiTrustEntry {
    pub path: String,
    pub trusted: bool,
}

pub fn default_ack_path() -> PathBuf {
    workspace_utils::assets::host_data_dir().join("pi-project-trust-ack.json")
}

pub fn expand_pi_home(path: &str, home: &Path) -> PathBuf {
    if path == "~" {
        home.to_path_buf()
    } else if let Some(relative) = path.strip_prefix("~/") {
        home.join(relative)
    } else if cfg!(windows)
        && let Some(relative) = path.strip_prefix("~\\")
    {
        home.join(relative)
    } else {
        PathBuf::from(path)
    }
}

pub fn pi_agent_dir(home: &Path, env: &HashMap<String, String>) -> PathBuf {
    env.get(PI_CONFIG_DIR_ENV)
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|path| expand_pi_home(path, home))
        .unwrap_or_else(|| home.join(".pi/agent"))
}

pub fn canonical_path(path: &Path) -> PathBuf {
    simplify_verbatim(fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf()))
}

pub fn project_resources(cwd: &Path, home: &Path) -> Vec<PiProjectResource> {
    let mut found = Vec::new();
    let start = canonical_path(cwd);
    let config_dir = start.join(".pi");
    for entry in PI_TRUST_REQUIRING_CONFIG_RESOURCES {
        let path = config_dir.join(entry);
        if path.exists() {
            found.push(PiProjectResource {
                path: path.to_string_lossy().into_owned(),
                kind: format!(".pi/{entry}"),
                executes_code: matches!(entry, "extensions" | "settings.json"),
            });
        }
    }

    let user_agents_skills = canonical_path(home).join(".agents").join("skills");
    let mut current = start.as_path();
    loop {
        let candidate = current.join(".agents").join("skills");
        if candidate != user_agents_skills && candidate.exists() {
            found.push(PiProjectResource {
                path: candidate.to_string_lossy().into_owned(),
                kind: ".agents/skills".to_string(),
                executes_code: false,
            });
        }
        match current.parent() {
            Some(parent) if parent != current => current = parent,
            _ => break,
        }
    }
    found
}

pub fn nearest_trust_decision(trust_file: &Path, cwd: &Path) -> Option<(String, bool)> {
    let map = read_json_object(trust_file).unwrap_or_default();
    if map.is_empty() {
        return None;
    }
    let mut current = canonical_path(cwd);
    loop {
        let key = current.to_string_lossy().into_owned();
        if let Some(Value::Bool(decision)) = map.get(&key) {
            return Some((key, *decision));
        }
        match current.parent() {
            Some(parent) if parent != current => current = parent.to_path_buf(),
            _ => return None,
        }
    }
}

pub fn project_trust_state(
    trust_file: &Path,
    ack_file: &Path,
    cwd: &Path,
    home: &Path,
) -> PiProjectTrustState {
    let decided = nearest_trust_decision(trust_file, cwd);
    let workspace = canonical_path(cwd).to_string_lossy().into_owned();
    PiProjectTrustState {
        acknowledged: is_acknowledged(ack_file, &workspace),
        resources: project_resources(cwd, home),
        decision: decided.as_ref().map(|(_, verdict)| *verdict),
        decided_at: decided.map(|(path, _)| path),
        trust_file: trust_file.to_string_lossy().into_owned(),
        workspace,
    }
}

/// Refuse to launch Pi when an in-force grant has never been confirmed here.
/// Undecided / declined projects are already safe (Pi skips the resources).
pub fn launch_block(
    cwd: &Path,
    env: &HashMap<String, String>,
    home: &Path,
    ack_file: &Path,
) -> Option<String> {
    let agent_dir = pi_agent_dir(home, env);
    let trust_file = agent_dir.join("trust.json");
    let state = project_trust_state(&trust_file, ack_file, cwd, home);
    if state.resources.is_empty() || state.decision != Some(true) || state.acknowledged {
        return None;
    }
    let inherited = state
        .decided_at
        .as_deref()
        .is_some_and(|at| at != state.workspace);
    let via = if inherited {
        format!(
            " The grant comes from a parent folder ({}), so it covers this repository too.",
            state.decided_at.as_deref().unwrap_or_default()
        )
    } else {
        String::new()
    };
    Some(format!(
        "Pi is allowed to load this project's own files from {}, which lets the repository run its .pi/extensions at startup.{via} \
         Review it in the project-trust notice, or under Settings → Agent → Pi, then connect again.",
        state.workspace
    ))
}

pub fn list_entries(trust_file: &Path) -> Result<Vec<PiTrustEntry>, String> {
    let Some(map) = read_json_object(trust_file) else {
        if trust_file.exists() {
            return Err("existing trust.json is invalid".to_string());
        }
        return Ok(Vec::new());
    };
    let mut entries = map
        .into_iter()
        .filter_map(|(path, value)| {
            value
                .as_bool()
                .map(|trusted| PiTrustEntry { path, trusted })
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(entries)
}

pub fn write_trust_decision(
    trust_file: &Path,
    cwd: &Path,
    trusted: Option<bool>,
) -> Result<(), String> {
    let key = canonical_path(cwd).to_string_lossy().into_owned();
    let _guard = PI_TRUST_WRITE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let _file_lock = acquire_pi_trust_lock(trust_file)?;
    let mut map = match read_json_object(trust_file) {
        Some(map) => map,
        None if trust_file.exists() => {
            return Err("existing trust.json is invalid".to_string());
        }
        None => serde_json::Map::new(),
    };
    match trusted {
        Some(verdict) => {
            map.insert(key, Value::Bool(verdict));
        }
        None => {
            if map.remove(&key).is_none() {
                return Ok(());
            }
            if map.is_empty() && !trust_file.exists() {
                return Ok(());
            }
        }
    }
    if map.is_empty() && trusted.is_none() {
        if trust_file.exists() {
            write_json_object(trust_file, &Value::Object(map))?;
        }
        return Ok(());
    }
    if let Some(parent) = trust_file.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("create Pi config directory: {error}"))?;
    }
    write_json_object(trust_file, &Value::Object(map))
}

pub fn set_acknowledged(ack_file: &Path, cwd: &Path, acknowledged: bool) -> Result<(), String> {
    let key = canonical_path(cwd).to_string_lossy().into_owned();
    let mut map = read_json_object(ack_file).unwrap_or_default();
    if acknowledged {
        map.insert(key, Value::Bool(true));
    } else if map.remove(&key).is_none() {
        return Ok(());
    }
    if let Some(parent) = ack_file.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("create ack directory: {error}"))?;
    }
    write_json_object(ack_file, &Value::Object(map))
}

/// Fail fast when `pi` (or `PI_ACP_PI_COMMAND`) cannot be resolved, instead of
/// letting pi-acp die mid-connection on a raw ENOENT.
pub fn launch_preflight(env: &HashMap<String, String>) -> Option<String> {
    let custom = env
        .get(PI_COMMAND_ENV)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    let command = custom.unwrap_or("pi");
    if resolve_pi_command(command).is_some() {
        return None;
    }
    Some(match custom {
        Some(cmd) => format!(
            "Pi is not installed: the custom pi command \"{cmd}\" was not found. \
             Update it in Settings → Agent → Pi → Runtime."
        ),
        None => "Pi is not installed. Install it from Settings → Agent → Pi, \
                 or set a custom pi command in Runtime."
            .to_string(),
    })
}

pub fn resolve_pi_command(command: &str) -> Option<PathBuf> {
    let command = command.trim();
    if command.is_empty() {
        return None;
    }
    let candidate = Path::new(command);
    let resolved = if candidate.is_absolute() || command.contains(['/', '\\']) {
        candidate.to_path_buf()
    } else {
        which::which(command).ok()?
    };
    if !resolved.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if fs::metadata(&resolved).ok()?.permissions().mode() & 0o111 == 0 {
            return None;
        }
    }
    Some(canonical_path(&resolved))
}

fn is_acknowledged(ack_file: &Path, workspace: &str) -> bool {
    matches!(
        read_json_object(ack_file).and_then(|map| map.get(workspace).cloned()),
        Some(Value::Bool(true))
    )
}

fn read_json_object(path: &Path) -> Option<serde_json::Map<String, Value>> {
    let bytes = fs::read(path).ok()?;
    let value = serde_json::from_slice::<Value>(&bytes).ok()?;
    value.as_object().cloned()
}

fn write_json_object(path: &Path, value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("serialize trust.json: {error}"))?;
    let temporary = path.with_file_name(format!(
        ".{}.vibex-{}",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("trust.json"),
        uuid::Uuid::new_v4()
    ));
    fs::write(&temporary, bytes).map_err(|error| format!("write temporary trust.json: {error}"))?;
    if let Err(error) = replace_file(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("replace trust.json: {error}"));
    }
    Ok(())
}

struct PiTrustLock {
    path: PathBuf,
}

impl Drop for PiTrustLock {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.path);
    }
}

fn acquire_pi_trust_lock(trust_file: &Path) -> Result<PiTrustLock, String> {
    let mut name = trust_file.as_os_str().to_os_string();
    name.push(".lock");
    let path = PathBuf::from(name);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("create Pi agent directory: {error}"))?;
    }
    for attempt in 1..=10 {
        match fs::create_dir(&path) {
            Ok(()) => return Ok(PiTrustLock { path }),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if lock_is_stale(&path) {
                    let _ = fs::remove_dir(&path);
                    continue;
                }
                if attempt < 10 {
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
            Err(error) => {
                return Err(format!("lock {} failed: {error}", path.display()));
            }
        }
    }
    Err(format!(
        "pi's trust store at {} is locked by another process; try again in a moment",
        trust_file.display()
    ))
}

fn lock_is_stale(path: &Path) -> bool {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .map(|modified| modified.elapsed().unwrap_or_default() > PI_TRUST_LOCK_STALE)
        .unwrap_or(true)
}

fn simplify_verbatim(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let raw = path.to_string_lossy();
        if let Some(rest) = raw.strip_prefix(r"\\?\") {
            if let Some(unc) = rest.strip_prefix(r"UNC\") {
                return PathBuf::from(format!(r"\\{unc}"));
            }
            return PathBuf::from(rest);
        }
    }
    path
}

#[cfg(not(windows))]
fn replace_file(temporary: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(temporary, destination)
}

#[cfg(windows)]
fn replace_file(temporary: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let temporary = temporary
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    if unsafe {
        MoveFileExW(
            temporary.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canonical_key(path: &Path) -> String {
        canonical_path(path).to_string_lossy().into_owned()
    }

    fn gated_workspace(tmp: &Path, decision: Option<bool>) -> (PathBuf, PathBuf, PathBuf) {
        let ws = tmp.join("ws");
        fs::create_dir_all(ws.join(".pi").join("extensions")).unwrap();
        let agent_dir = tmp.join("agent");
        fs::create_dir_all(&agent_dir).unwrap();
        if let Some(verdict) = decision {
            let mut map = serde_json::Map::new();
            map.insert(canonical_key(&ws), Value::Bool(verdict));
            fs::write(
                agent_dir.join("trust.json"),
                serde_json::to_vec_pretty(&Value::Object(map)).unwrap(),
            )
            .unwrap();
        }
        (ws, agent_dir, tmp.join("ack.json"))
    }

    fn env_for(agent_dir: &Path) -> HashMap<String, String> {
        HashMap::from([(
            PI_CONFIG_DIR_ENV.to_string(),
            agent_dir.to_string_lossy().into_owned(),
        )])
    }

    #[test]
    fn resources_name_extensions_as_executable() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        fs::create_dir_all(ws.join(".pi").join("extensions")).unwrap();
        fs::write(ws.join(".pi").join("SYSTEM.md"), b"# prompt").unwrap();
        let resources = project_resources(&ws, tmp.path());
        assert!(
            resources
                .iter()
                .any(|resource| resource.kind == ".pi/extensions" && resource.executes_code)
        );
        assert!(
            resources
                .iter()
                .any(|resource| resource.kind == ".pi/SYSTEM.md" && !resource.executes_code)
        );
    }

    #[test]
    fn user_agents_skills_are_not_project_resources() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let ws = tmp.path().join("ws");
        fs::create_dir_all(home.join(".agents").join("skills")).unwrap();
        fs::create_dir_all(&ws).unwrap();
        assert!(project_resources(&ws, &home).is_empty());
    }

    #[test]
    fn nearest_decision_walks_ancestors_and_skips_null() {
        let tmp = tempfile::tempdir().unwrap();
        let parent = tmp.path().join("projects");
        let ws = parent.join("repo");
        fs::create_dir_all(&ws).unwrap();
        let trust = tmp.path().join("trust.json");
        let mut map = serde_json::Map::new();
        map.insert(canonical_key(&ws), Value::Null);
        map.insert(canonical_key(&parent), Value::Bool(true));
        fs::write(
            &trust,
            serde_json::to_vec_pretty(&Value::Object(map)).unwrap(),
        )
        .unwrap();
        assert_eq!(
            nearest_trust_decision(&trust, &ws),
            Some((canonical_key(&parent), true))
        );
    }

    #[test]
    fn launch_is_blocked_by_an_unacknowledged_grant() {
        let tmp = tempfile::tempdir().unwrap();
        let (ws, agent_dir, ack) = gated_workspace(tmp.path(), Some(true));
        let blocked = launch_block(&ws, &env_for(&agent_dir), tmp.path(), &ack).expect("blocked");
        assert!(blocked.contains("Review"));
        assert!(blocked.contains(&canonical_key(&ws)));
    }

    #[test]
    fn launch_is_blocked_by_an_unacknowledged_ancestor_grant() {
        let tmp = tempfile::tempdir().unwrap();
        let parent = tmp.path().join("projects");
        let ws = parent.join("cloned-later");
        fs::create_dir_all(ws.join(".pi").join("extensions")).unwrap();
        let agent_dir = tmp.path().join("agent");
        fs::create_dir_all(&agent_dir).unwrap();
        let mut map = serde_json::Map::new();
        map.insert(canonical_key(&parent), Value::Bool(true));
        fs::write(
            agent_dir.join("trust.json"),
            serde_json::to_vec_pretty(&Value::Object(map)).unwrap(),
        )
        .unwrap();
        let blocked = launch_block(
            &ws,
            &env_for(&agent_dir),
            tmp.path(),
            &tmp.path().join("ack.json"),
        );
        assert!(blocked.is_some());
        assert!(blocked.unwrap().contains("parent folder"));
    }

    #[test]
    fn launch_proceeds_after_acknowledgement_or_without_resources() {
        let tmp = tempfile::tempdir().unwrap();
        let (ws, agent_dir, ack) = gated_workspace(tmp.path(), Some(true));
        set_acknowledged(&ack, &ws, true).unwrap();
        assert!(launch_block(&ws, &env_for(&agent_dir), tmp.path(), &ack).is_none());

        let empty = tmp.path().join("empty");
        fs::create_dir_all(&empty).unwrap();
        assert!(launch_block(&empty, &env_for(&agent_dir), tmp.path(), &ack).is_none());
    }

    #[test]
    fn launch_proceeds_when_undecided_or_declined() {
        let tmp = tempfile::tempdir().unwrap();
        let (ws, agent_dir, ack) = gated_workspace(tmp.path(), None);
        assert!(launch_block(&ws, &env_for(&agent_dir), tmp.path(), &ack).is_none());
        let (ws, agent_dir, ack) = gated_workspace(&tmp.path().join("declined"), Some(false));
        assert!(launch_block(&ws, &env_for(&agent_dir), tmp.path(), &ack).is_none());
    }

    #[test]
    fn write_records_either_verdict_and_revoke_is_scoped() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        fs::create_dir_all(&ws).unwrap();
        let trust = tmp.path().join("trust.json");
        let other = tmp.path().join("other");
        fs::create_dir_all(&other).unwrap();
        write_trust_decision(&trust, &ws, Some(true)).unwrap();
        write_trust_decision(&trust, &other, Some(false)).unwrap();
        write_trust_decision(&trust, &ws, None).unwrap();
        let entries = list_entries(&trust).unwrap();
        assert!(entries.iter().all(|entry| entry.path != canonical_key(&ws)));
        assert!(entries.iter().any(|entry| !entry.trusted));
    }

    #[test]
    fn revoke_is_a_noop_when_nothing_is_ours() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        fs::create_dir_all(&ws).unwrap();
        let trust = tmp.path().join("agent").join("trust.json");
        write_trust_decision(&trust, &ws, None).unwrap();
        assert!(!trust.exists());
    }

    #[test]
    fn write_never_clobbers_an_unparseable_file() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        fs::create_dir_all(&ws).unwrap();
        let trust = tmp.path().join("trust.json");
        fs::write(&trust, b"not-json").unwrap();
        assert!(write_trust_decision(&trust, &ws, Some(true)).is_err());
        assert_eq!(fs::read(&trust).unwrap(), b"not-json");
    }

    #[test]
    fn preflight_flags_a_missing_custom_command() {
        let env = HashMap::from([(
            PI_COMMAND_ENV.to_string(),
            "/definitely/missing/pi-binary".to_string(),
        )]);
        let message = launch_preflight(&env).expect("missing command");
        assert!(message.contains("is not installed"));
        assert!(message.contains("missing/pi-binary"));
    }
}
