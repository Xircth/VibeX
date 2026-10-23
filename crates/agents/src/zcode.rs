//! Official ZCode runtime, resolved separately from the pinned ACP bridge.
//!
//! The bridge is an npm program. Official ZCode and a Node.js 22 runtime that
//! can load `node:sqlite` are not part of that package. Launch replaces the
//! bridge shim with that Node and the bridge's JavaScript entry, then points
//! `ZCODE_BIN` at the official CLI. Credentials stay in official ZCode.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::{Component, Path, PathBuf},
    sync::OnceLock,
    time::Duration,
};

use regex::Regex;
use workspace_utils::process::new_hidden_tokio_command;

use crate::AgentError;

pub const MODE_CONFIRM_TIMEOUT: &str =
    "ZCode did not confirm the initial mode within 60 seconds. The session will not send a prompt.";
pub const MODE_CONFIRM_REJECTED: &str =
    "ZCode did not confirm the initial mode. The session will not send a prompt.";
pub const MODE_NOT_ADVERTISED: &str =
    "ZCode did not advertise a session mode. The session will not send a prompt.";

const NODE_SQLITE_PROBE: &str = "if(Number(process.versions.node.split('.')[0])<22)process.exit(2);new (require('node:sqlite').DatabaseSync)(':memory:')";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZCodeRuntime {
    pub cli: PathBuf,
    pub node: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedLaunch {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
}

#[derive(Debug, thiserror::Error)]
pub enum RuntimeError {
    #[error(
        "Official ZCode could not be found. Install ZCode and sign in, or set ZCODE_BIN to its zcode.cjs entry in Settings → Agent → ZCode → Environment."
    )]
    CliMissing,
    #[error(
        "ZCODE_BIN does not resolve to a ZCode entry: {0}. Use zcode.cjs, zcode.mjs, zcode.js, or a native executable."
    )]
    CliInvalid(String),
    #[error(
        "Node.js could not be found. Install Node.js 22 or newer, or set ZCODE_NODE in Settings → Agent → ZCode → Environment."
    )]
    NodeMissing,
    #[error("ZCODE_NODE does not resolve to a Node executable: {0}")]
    NodeInvalid(String),
    #[error(
        "ZCode needs Node.js 22 or newer with node:sqlite. Install it, or set ZCODE_NODE in Settings → Agent → ZCode → Environment."
    )]
    NodeUnsupported,
    #[error("{0} must be an absolute path or a command name on PATH: {1}")]
    RelativeOverride(&'static str, String),
    #[error(
        "The ZCode ACP bridge at {0} does not lead to its JavaScript entry. Reinstall it from Settings → Agent → ZCode."
    )]
    BridgeEntryMissing(String),
}

impl RuntimeError {
    pub fn into_agent_error(self) -> AgentError {
        match &self {
            Self::CliMissing
            | Self::NodeMissing
            | Self::NodeUnsupported
            | Self::BridgeEntryMissing(_) => AgentError::NotInstalled(self.to_string()),
            _ => AgentError::Runtime(self.to_string()),
        }
    }
}

impl ZCodeRuntime {
    /// The bridge re-executes under Bun unless `ZCODE_ACP_RUNTIME` is set.
    /// A non-empty value already in `env` is the user's choice.
    pub fn apply(&self, env: &mut HashMap<String, String>) {
        for (key, value) in [
            ("ZCODE_BIN", self.cli.to_string_lossy().into_owned()),
            ("ZCODE_NODE", self.node.to_string_lossy().into_owned()),
            ("ZCODE_ACP_REMOTE", "0".to_string()),
        ] {
            remove_env_key(env, key);
            env.insert(key.to_string(), value);
        }
        if !contains_env_key(env, "ZCODE_ACP_RUNTIME") {
            env.insert("ZCODE_ACP_RUNTIME".to_string(), "node".to_string());
        }
    }
}

pub fn initial_mode(
    preferred_mode: Option<&str>,
    preferred_config: &BTreeMap<String, String>,
    available: &[String],
) -> String {
    preferred_config
        .get("mode")
        .map(String::as_str)
        .into_iter()
        .chain(preferred_mode)
        .find(|mode| !mode.is_empty() && available.iter().any(|id| id == mode))
        .unwrap_or("build")
        .to_string()
}

/// A missing current value is a rejection. The placeholder can report a mode
/// before the backend session exists, so absence is not confirmation.
pub fn require_confirmed_mode(settled: Option<&str>, requested: &str) -> Result<(), &'static str> {
    match settled {
        Some(actual) if actual == requested => Ok(()),
        _ => Err(MODE_CONFIRM_REJECTED),
    }
}

pub async fn prepare_launch(
    bridge_program: &Path,
    launch_args: &[String],
    overrides: &HashMap<String, String>,
    cwd: &Path,
) -> Result<PreparedLaunch, RuntimeError> {
    let runtime = resolve_runtime(&btree_from_hash(overrides), cwd).await?;
    launch_from_runtime(&runtime, bridge_program, launch_args, overrides)
}

pub fn launch_from_runtime(
    runtime: &ZCodeRuntime,
    bridge_program: &Path,
    launch_args: &[String],
    overrides: &HashMap<String, String>,
) -> Result<PreparedLaunch, RuntimeError> {
    let entry = bridge_entry(bridge_program)
        .ok_or_else(|| RuntimeError::BridgeEntryMissing(bridge_program.display().to_string()))?;
    let mut args = vec![entry.to_string_lossy().into_owned()];
    args.extend(launch_args.iter().cloned());
    if !args.iter().any(|argument| argument == "server") {
        args.push("server".to_string());
    }
    let mut env = HashMap::new();
    if let Some(chosen) = hash_get(overrides, "ZCODE_ACP_RUNTIME")
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        env.insert("ZCODE_ACP_RUNTIME".to_string(), chosen.to_string());
    }
    runtime.apply(&mut env);
    Ok(PreparedLaunch {
        program: runtime.node.clone(),
        args,
        env,
    })
}

pub async fn resolve_runtime(
    overrides: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<ZCodeRuntime, RuntimeError> {
    let env = effective_env(overrides);
    let home = dirs::home_dir();
    let platform = std::env::consts::OS;
    let cli = resolve_cli(&env, cwd, home.as_deref(), platform)?;
    let candidates = node_candidates(&env, cwd, home.as_deref(), platform)?;
    let node = first_supported_node(candidates, env.get("PATH"))
        .await
        .ok_or(RuntimeError::NodeUnsupported)?;
    Ok(ZCodeRuntime { cli, node })
}

fn effective_env(overrides: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    effective_env_from(overrides, |key| std::env::var(key).ok())
}

fn effective_env_from(
    overrides: &BTreeMap<String, String>,
    inherited: impl Fn(&str) -> Option<String>,
) -> BTreeMap<String, String> {
    const KEYS: &[&str] = &[
        "ZCODE_BIN",
        "ZCODE_NODE",
        "PATH",
        "LOCALAPPDATA",
        "ProgramFiles",
        "APPDATA",
        "NVM_DIR",
        "NVM_HOME",
        "NVM_SYMLINK",
        "FNM_DIR",
        "FNM_MULTISHELL_PATH",
        "VOLTA_HOME",
    ];
    let mut env = BTreeMap::new();
    for key in KEYS {
        let explicit = map_get(overrides, key);
        let value = explicit.cloned().or_else(|| inherited(key));
        if let Some(value) = value
            && (*key == "PATH" || !value.trim().is_empty())
        {
            env.insert((*key).to_string(), value);
        }
    }
    env
}

fn is_relative_path(value: &str) -> bool {
    let value = value.trim();
    let path = Path::new(value);
    !path.is_absolute()
        && (value.contains('/')
            || value.contains('\\')
            || matches!(path.components().next(), Some(Component::Prefix(_))))
}

fn resolve_program(value: &str, env: &BTreeMap<String, String>, cwd: &Path) -> Option<PathBuf> {
    let value = value.trim();
    let path = Path::new(value);
    let resolved = if path.is_absolute() {
        path.to_path_buf()
    } else if is_relative_path(value) {
        return None;
    } else {
        which::which_in(
            value,
            Some(std::ffi::OsString::from(
                map_get(env, "PATH").map(String::as_str).unwrap_or(""),
            )),
            cwd,
        )
        .ok()?
    };
    resolved.is_file().then_some(resolved)
}

fn extension_of(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn is_js(path: &Path) -> bool {
    matches!(extension_of(path).as_str(), "cjs" | "mjs" | "js")
}

fn launcher_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r#"(?i)(?:%dp0%|%~dp0|\$basedir)[\\/]([^"\r\n]+?\.(?:cjs|mjs|js))"#)
            .expect("bridge launcher pattern")
    })
}

fn js_entry(path: &Path) -> Option<PathBuf> {
    if is_js(path) {
        return path.is_file().then(|| path.to_path_buf());
    }
    let extension = extension_of(path);
    if !matches!(extension.as_str(), "" | "cmd") {
        return None;
    }
    if cfg!(unix)
        && extension.is_empty()
        && let Ok(target) = std::fs::canonicalize(path)
        && is_js(&target)
        && target.is_file()
    {
        return Some(target);
    }
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > 32 * 1024 {
        return None;
    }
    let launcher = std::fs::read_to_string(path).ok()?;
    let dir = path.parent()?;
    for captures in launcher_pattern().captures_iter(&launcher) {
        let Some(relative) = captures.get(1) else {
            continue;
        };
        let entry = dir.join(relative.as_str().replace('\\', "/"));
        if entry.is_file() {
            return Some(entry);
        }
    }
    None
}

pub fn bridge_entry(command: &Path) -> Option<PathBuf> {
    js_entry(command)
}

fn cli_entry(path: &Path) -> Option<PathBuf> {
    js_entry(path).or_else(|| {
        (matches!(extension_of(path).as_str(), "" | "exe") && path.is_file())
            .then(|| path.to_path_buf())
    })
}

fn bundled_candidates(platform: &str, home: Option<&Path>, local: Option<&str>) -> Vec<PathBuf> {
    match platform {
        "windows" => local
            .map(PathBuf::from)
            .or_else(|| home.map(|home| home.join("AppData/Local")))
            .map(|base| vec![base.join("Programs/ZCode/resources/glm/zcode.cjs")])
            .unwrap_or_default(),
        "macos" => {
            let mut paths = vec![PathBuf::from(
                "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
            )];
            if let Some(home) = home {
                paths.push(home.join("Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"));
            }
            paths
        }
        _ => vec![
            PathBuf::from("/opt/ZCode/resources/glm/zcode.cjs"),
            PathBuf::from("/usr/share/zcode/resources/glm/zcode.cjs"),
        ],
    }
}

fn resolve_cli(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    home: Option<&Path>,
    platform: &str,
) -> Result<PathBuf, RuntimeError> {
    if let Some(explicit) = map_get(env, "ZCODE_BIN") {
        if is_relative_path(explicit) {
            return Err(RuntimeError::RelativeOverride(
                "ZCODE_BIN",
                explicit.clone(),
            ));
        }
        return resolve_program(explicit, env, cwd)
            .and_then(|path| cli_entry(&path))
            .ok_or_else(|| RuntimeError::CliInvalid(explicit.clone()));
    }
    bundled_candidates(
        platform,
        home,
        map_get(env, "LOCALAPPDATA").map(String::as_str),
    )
    .iter()
    .find_map(|path| cli_entry(path))
    .or_else(|| resolve_program("zcode", env, cwd).and_then(|path| cli_entry(&path)))
    .ok_or(RuntimeError::CliMissing)
}

fn node_candidates(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    home: Option<&Path>,
    platform: &str,
) -> Result<Vec<PathBuf>, RuntimeError> {
    if let Some(explicit) = map_get(env, "ZCODE_NODE") {
        if is_relative_path(explicit) {
            return Err(RuntimeError::RelativeOverride(
                "ZCODE_NODE",
                explicit.clone(),
            ));
        }
        return resolve_program(explicit, env, cwd)
            .map(|node| vec![node])
            .ok_or_else(|| RuntimeError::NodeInvalid(explicit.clone()));
    }
    discovered_nodes(
        env,
        cwd,
        platform,
        version_manager_node_dirs(env, home, platform),
    )
}

fn discovered_nodes(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    platform: &str,
    manager_dirs: Vec<PathBuf>,
) -> Result<Vec<PathBuf>, RuntimeError> {
    let mut candidates: Vec<PathBuf> = resolve_program("node", env, cwd).into_iter().collect();
    let binary = node_binary_name();
    candidates.extend(
        manager_dirs
            .into_iter()
            .map(|dir| dir.join(binary))
            .filter(|path| path.is_file()),
    );
    if platform == "windows"
        && let Some(base) = map_get(env, "ProgramFiles")
    {
        let node = PathBuf::from(base).join("nodejs").join(binary);
        if node.is_file() {
            candidates.push(node);
        }
    }
    let mut seen = HashSet::new();
    candidates.retain(|node| seen.insert(node.clone()));
    if candidates.is_empty() {
        Err(RuntimeError::NodeMissing)
    } else {
        Ok(candidates)
    }
}

fn version_manager_node_dirs(
    env: &BTreeMap<String, String>,
    home: Option<&Path>,
    platform: &str,
) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(path) = map_get(env, "FNM_MULTISHELL_PATH") {
        dirs.push(PathBuf::from(path));
    }
    let volta = map_get(env, "VOLTA_HOME")
        .map(PathBuf::from)
        .or_else(|| home.map(|home| home.join(".volta")));
    if let Some(volta) = volta {
        dirs.push(volta.join("bin"));
    }
    if platform == "windows" {
        if let Some(link) = map_get(env, "NVM_SYMLINK") {
            dirs.push(PathBuf::from(link));
        }
        let nvm_home = map_get(env, "NVM_HOME").map(PathBuf::from).or_else(|| {
            map_get(env, "APPDATA")
                .map(|app_data| PathBuf::from(app_data).join("nvm"))
                .or_else(|| home.map(|home| home.join("AppData/Roaming/nvm")))
        });
        if let Some(nvm_home) = nvm_home {
            push_version_dirs(&nvm_home, &mut dirs, false);
        }
    } else if let Some(nvm) = map_get(env, "NVM_DIR")
        .map(PathBuf::from)
        .or_else(|| home.map(|home| home.join(".nvm")))
    {
        push_version_dirs(&nvm.join("versions").join("node"), &mut dirs, true);
    }
    let mut fnm_roots = Vec::new();
    if let Some(fnm) = map_get(env, "FNM_DIR") {
        fnm_roots.push(PathBuf::from(fnm));
    }
    if let Some(home) = home {
        fnm_roots.push(home.join(".fnm"));
    }
    for root in fnm_roots {
        push_fnm_dirs(&root, &mut dirs);
    }
    dirs
}

fn push_version_dirs(root: &Path, dirs: &mut Vec<PathBuf>, join_bin: bool) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let mut versions: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    versions.sort_by_key(|right| std::cmp::Reverse(semver_key(right)));
    for path in versions {
        if join_bin {
            let bin = path.join("bin");
            dirs.push(if bin.is_dir() { bin } else { path });
        } else {
            dirs.push(path);
        }
    }
}

fn push_fnm_dirs(fnm_dir: &Path, dirs: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(fnm_dir.join("node-versions")) else {
        return;
    };
    let mut versions: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    versions.sort_by_key(|right| std::cmp::Reverse(semver_key(right)));
    for version in versions {
        let installation = version.join("installation");
        let bin = installation.join("bin");
        if bin.is_dir() {
            dirs.push(bin);
        } else if installation.is_dir() {
            dirs.push(installation);
        }
    }
}

fn semver_key(path: &Path) -> (u32, u32, u32) {
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .trim_start_matches('v')
        .to_string();
    let mut parts = name.split('.').filter_map(|part| part.parse::<u32>().ok());
    (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    )
}

fn node_binary_name() -> &'static str {
    if cfg!(windows) { "node.exe" } else { "node" }
}

async fn node_supports_zcode(node: &Path, path: Option<&String>) -> bool {
    let mut command = new_hidden_tokio_command(node, ["-e", NODE_SQLITE_PROBE]);
    command.kill_on_drop(true);
    if let Some(path) = path {
        command.env("PATH", path);
    }
    let output = tokio::time::timeout(Duration::from_secs(5), command.output()).await;
    matches!(output, Ok(Ok(ref output)) if output.status.success())
}

async fn first_supported_node(candidates: Vec<PathBuf>, path: Option<&String>) -> Option<PathBuf> {
    for node in candidates {
        if node_supports_zcode(&node, path).await {
            return Some(node);
        }
    }
    None
}

fn btree_from_hash(env: &HashMap<String, String>) -> BTreeMap<String, String> {
    env.iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

fn map_get<'a>(env: &'a BTreeMap<String, String>, key: &str) -> Option<&'a String> {
    if cfg!(windows) {
        env.iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(key))
            .map(|(_, value)| value)
    } else {
        env.get(key)
    }
}

fn hash_get<'a>(env: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    if cfg!(windows) {
        env.iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(key))
            .map(|(_, value)| value.as_str())
    } else {
        env.get(key).map(String::as_str)
    }
}

fn remove_env_key(env: &mut HashMap<String, String>, key: &str) {
    if cfg!(windows) {
        let names: Vec<String> = env
            .keys()
            .filter(|name| name.eq_ignore_ascii_case(key))
            .cloned()
            .collect();
        for name in names {
            env.remove(&name);
        }
    } else {
        env.remove(key);
    }
}

fn contains_env_key(env: &HashMap<String, String>, key: &str) -> bool {
    if cfg!(windows) {
        env.keys().any(|name| name.eq_ignore_ascii_case(key))
    } else {
        env.contains_key(key)
    }
}

#[cfg(test)]
fn resolve_paths(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    home: Option<&Path>,
    platform: &str,
) -> Result<ZCodeRuntime, RuntimeError> {
    let cli = resolve_cli(env, cwd, home, platform)?;
    let node = node_candidates(env, cwd, home, platform)?.swap_remove(0);
    Ok(ZCodeRuntime { cli, node })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "").unwrap();
    }

    fn executable(path: &Path) {
        file(path);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[test]
    fn explicit_paths_with_spaces_win_over_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("My ZCode/zcode.cjs");
        let node = dir.path().join("My Node/node.exe");
        file(&cli);
        file(&node);
        let env = BTreeMap::from([
            ("ZCODE_BIN".into(), cli.display().to_string()),
            ("ZCODE_NODE".into(), node.display().to_string()),
            ("LOCALAPPDATA".into(), dir.path().display().to_string()),
        ]);
        let runtime = resolve_paths(&env, dir.path(), Some(dir.path()), "windows").unwrap();
        assert_eq!(runtime.cli, cli);
        assert_eq!(runtime.node, node);
    }

    #[test]
    fn invalid_explicit_cli_does_not_fall_back_to_bundle() {
        let dir = tempfile::tempdir().unwrap();
        file(&dir.path().join("Programs/ZCode/resources/glm/zcode.cjs"));
        let missing = dir.path().join("missing.cjs");
        let env = BTreeMap::from([
            ("ZCODE_BIN".into(), missing.display().to_string()),
            ("LOCALAPPDATA".into(), dir.path().display().to_string()),
        ]);
        assert!(matches!(
            resolve_paths(&env, dir.path(), None, "windows"),
            Err(RuntimeError::CliInvalid(_))
        ));
    }

    #[test]
    fn bundle_discovery_does_not_require_shell_path() {
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("Programs/ZCode/resources/glm/zcode.cjs");
        let node = dir.path().join("Node/node.exe");
        file(&cli);
        file(&node);
        let env = BTreeMap::from([
            ("LOCALAPPDATA".into(), dir.path().display().to_string()),
            ("ZCODE_NODE".into(), node.display().to_string()),
            ("PATH".into(), String::new()),
        ]);
        let runtime = resolve_paths(&env, dir.path(), None, "windows").unwrap();
        assert_eq!(runtime.cli, cli);
    }

    #[test]
    fn windows_shim_resolves_js_target_without_spawning_cmd() {
        let dir = tempfile::tempdir().unwrap();
        let shim = dir.path().join("zcode.cmd");
        let entry = dir.path().join("node_modules/zcode/bin/zcode.mjs");
        file(&entry);
        std::fs::write(
            &shim,
            r#""%_prog%" "%dp0%\node_modules\zcode\bin\zcode.mjs" %*"#,
        )
        .unwrap();
        assert_eq!(cli_entry(&shim), Some(entry));
        std::fs::write(&shim, "unknown wrapper").unwrap();
        assert_eq!(cli_entry(&shim), None);
    }

    #[test]
    fn runtime_injection_replaces_keys_without_enabling_remote_hub() {
        let runtime = ZCodeRuntime {
            cli: "cli.cjs".into(),
            node: "node.exe".into(),
        };
        let mut env = HashMap::from([
            ("ZCODE_NODE".to_string(), "old".to_string()),
            ("ZCODE_ACP_REMOTE".to_string(), "1".to_string()),
        ]);
        runtime.apply(&mut env);
        assert_eq!(env.get("ZCODE_NODE").map(String::as_str), Some("node.exe"));
        assert_eq!(env.get("ZCODE_ACP_REMOTE").map(String::as_str), Some("0"));
        assert_eq!(
            env.get("ZCODE_ACP_RUNTIME").map(String::as_str),
            Some("node")
        );
        let mut chosen = HashMap::from([("ZCODE_ACP_RUNTIME".to_string(), "bun".to_string())]);
        runtime.apply(&mut chosen);
        assert_eq!(
            chosen.get("ZCODE_ACP_RUNTIME").map(String::as_str),
            Some("bun")
        );
    }

    #[test]
    fn bridge_launch_uses_the_validated_node_and_server_argument() {
        let dir = tempfile::tempdir().unwrap();
        let entry = dir.path().join("node_modules/zcode-acp-server/dist/cli.js");
        file(&entry);
        let shim = dir.path().join("zcode-acp-server.cmd");
        std::fs::write(
            &shim,
            "@IF EXIST \"%~dp0\\node.exe\" (\r\n  \"%~dp0\\node.exe\"  \"%~dp0\\node_modules\\zcode-acp-server\\dist\\cli.js\" %*\r\n)\r\n",
        )
        .unwrap();
        let runtime = ZCodeRuntime {
            cli: dir.path().join("zcode.cjs"),
            node: dir.path().join("node.exe"),
        };
        let launch =
            launch_from_runtime(&runtime, &shim, &["server".to_string()], &HashMap::new()).unwrap();
        assert_eq!(launch.program, runtime.node);
        assert_eq!(
            launch.args,
            vec![entry.display().to_string(), "server".to_string()]
        );
        assert!(!launch.env.contains_key("ANTHROPIC_API_KEY"));
        assert_eq!(
            launch.env.get("ZCODE_ACP_REMOTE").map(String::as_str),
            Some("0")
        );
    }

    #[test]
    fn a_native_bridge_shim_is_not_launched() {
        let dir = tempfile::tempdir().unwrap();
        let native = dir.path().join("zcode-acp-server");
        std::fs::write(&native, [0x7f, b'E', b'L', b'F', 0xff, 0xfe]).unwrap();
        let runtime = ZCodeRuntime {
            cli: dir.path().join("zcode.cjs"),
            node: dir.path().join("node"),
        };
        let error =
            launch_from_runtime(&runtime, &native, &["server".to_string()], &HashMap::new())
                .unwrap_err();
        assert!(matches!(error, RuntimeError::BridgeEntryMissing(_)));
        assert!(matches!(
            error.into_agent_error(),
            AgentError::NotInstalled(_)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn a_path_link_to_the_cli_resolves_to_its_js_entry() {
        let dir = tempfile::tempdir().unwrap();
        let entry = dir.path().join("lib/node_modules/zcode/bin/zcode.mjs");
        file(&entry);
        let bin = dir.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let link = bin.join("zcode");
        std::os::unix::fs::symlink(&entry, &link).unwrap();
        assert_eq!(
            cli_entry(&link),
            Some(std::fs::canonicalize(&entry).unwrap())
        );
        let native = bin.join("zcode-native");
        file(&native);
        assert_eq!(cli_entry(&native), Some(native));
    }

    #[test]
    fn node_candidates_put_path_first_and_leave_an_explicit_node_alone() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("Path Bin");
        let path_node = bin.join(node_binary_name());
        executable(&path_node);
        let env = BTreeMap::from([("PATH".into(), bin.display().to_string())]);
        let found = node_candidates(&env, dir.path(), None, "test").unwrap();
        assert_eq!(found.first(), Some(&path_node));
        let chosen = dir.path().join("Chosen Node/node.exe");
        file(&chosen);
        let mut explicit = env.clone();
        explicit.insert("ZCODE_NODE".into(), chosen.display().to_string());
        assert_eq!(
            node_candidates(&explicit, dir.path(), None, "test").unwrap(),
            vec![chosen]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_old_path_node_does_not_hide_a_version_manager_node() {
        let dir = tempfile::tempdir().unwrap();
        let fake = |name: &str, supported: bool| {
            let bin = dir.path().join(name);
            std::fs::create_dir_all(&bin).unwrap();
            let node = bin.join("node");
            let verdict = if supported { 0 } else { 2 };
            std::fs::write(
                &node,
                format!("#!/bin/sh\ncase \"$2\" in *node:sqlite*) exit {verdict};; esac\nexit 9\n"),
            )
            .unwrap();
            executable(&node);
            bin
        };
        let path_bin = fake("Path Node", false);
        let manager_bin = fake("Version Manager/v24.0.0/bin", true);
        let env = BTreeMap::from([("PATH".into(), path_bin.display().to_string())]);
        let candidates =
            discovered_nodes(&env, dir.path(), "test", vec![manager_bin.clone()]).unwrap();
        assert_eq!(
            candidates,
            vec![path_bin.join("node"), manager_bin.join("node")]
        );
        assert_eq!(
            first_supported_node(candidates, env.get("PATH")).await,
            Some(manager_bin.join("node"))
        );
        assert_eq!(
            first_supported_node(vec![path_bin.join("node")], env.get("PATH")).await,
            None
        );
    }

    #[test]
    fn initial_mode_preserves_explicit_choices_and_replaces_stale_preferences() {
        let available = vec!["build".into(), "plan".into(), "yolo".into()];
        assert_eq!(initial_mode(None, &BTreeMap::new(), &available), "build");
        assert_eq!(
            initial_mode(Some("yolo"), &BTreeMap::new(), &available),
            "yolo"
        );
        assert_eq!(
            initial_mode(Some("retired"), &BTreeMap::new(), &available),
            "build"
        );
        let preferred = BTreeMap::from([("mode".into(), "plan".into())]);
        assert_eq!(initial_mode(Some("yolo"), &preferred, &available), "plan");
    }

    #[test]
    fn confirmed_mode_rejects_a_missing_or_different_current_value() {
        assert!(require_confirmed_mode(Some("build"), "build").is_ok());
        assert_eq!(
            require_confirmed_mode(None, "build"),
            Err(MODE_CONFIRM_REJECTED)
        );
        assert_eq!(
            require_confirmed_mode(Some("yolo"), "build"),
            Err(MODE_CONFIRM_REJECTED)
        );
    }

    #[test]
    fn invalid_node_override_is_reported_instead_of_using_another_node() {
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("zcode.cjs");
        file(&cli);
        let missing = dir.path().join("missing-node.exe");
        let env = BTreeMap::from([
            ("ZCODE_BIN".into(), cli.display().to_string()),
            ("ZCODE_NODE".into(), missing.display().to_string()),
        ]);
        assert!(matches!(
            resolve_paths(&env, dir.path(), None, "windows"),
            Err(RuntimeError::NodeInvalid(_))
        ));
    }

    #[test]
    fn a_relative_override_is_refused_rather_than_read_from_one_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("tools/zcode.cjs");
        let node = dir.path().join("tools/node.exe");
        file(&cli);
        file(&node);
        let refusal = |bin: String, node: String| {
            let env = BTreeMap::from([("ZCODE_BIN".into(), bin), ("ZCODE_NODE".into(), node)]);
            match resolve_paths(&env, dir.path(), None, "test") {
                Err(error) => error.to_string(),
                Ok(runtime) => panic!("a relative override resolved to {runtime:?}"),
            }
        };
        assert_eq!(
            refusal("tools/zcode.cjs".into(), node.display().to_string()),
            "ZCODE_BIN must be an absolute path or a command name on PATH: tools/zcode.cjs"
        );
        assert_eq!(
            refusal(cli.display().to_string(), "./tools/node.exe".into()),
            "ZCODE_NODE must be an absolute path or a command name on PATH: ./tools/node.exe"
        );
        assert!(is_relative_path("~/zcode.cjs"));
        assert!(!is_relative_path("node"));
        assert_eq!(is_relative_path("C:node.exe"), cfg!(windows));
        if cfg!(windows) {
            assert_eq!(
                refusal(cli.display().to_string(), "C:node.exe".into()),
                "ZCODE_NODE must be an absolute path or a command name on PATH: C:node.exe"
            );
        }
        let bin = dir.path().join("bin");
        let path_node = bin.join(node_binary_name());
        executable(&path_node);
        let env = BTreeMap::from([
            ("ZCODE_BIN".into(), cli.display().to_string()),
            ("ZCODE_NODE".into(), "node".into()),
            ("PATH".into(), bin.display().to_string()),
        ]);
        assert_eq!(
            resolve_paths(&env, dir.path(), None, "test").unwrap().node,
            path_node
        );
    }

    #[test]
    fn missing_official_runtime_is_distinct_from_a_missing_bridge() {
        let dir = tempfile::tempdir().unwrap();
        let env = BTreeMap::from([
            ("LOCALAPPDATA".into(), dir.path().display().to_string()),
            ("PATH".into(), String::new()),
        ]);
        let error = resolve_paths(&env, dir.path(), None, "windows").unwrap_err();
        assert!(matches!(error, RuntimeError::CliMissing));
        let message = error.to_string();
        assert!(message.contains("Official ZCode"));
        assert!(matches!(
            RuntimeError::CliMissing.into_agent_error(),
            AgentError::NotInstalled(_)
        ));
    }

    #[test]
    fn ordinary_path_installation_is_discovered_with_spaces() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("Command Line Tools");
        let cli = bin.join(if cfg!(windows) { "zcode.exe" } else { "zcode" });
        let node = bin.join(node_binary_name());
        executable(&cli);
        executable(&node);
        let env = BTreeMap::from([("PATH".into(), bin.display().to_string())]);
        let runtime = resolve_paths(&env, dir.path(), None, "test").unwrap();
        assert_eq!(runtime.cli, cli);
        assert_eq!(runtime.node, node);
    }

    #[test]
    fn explicit_environment_wins_and_blank_values_remove_inheritance() {
        let inherited = |key: &str| (key == "ZCODE_BIN").then(|| "inherited.cjs".to_string());
        let overrides = BTreeMap::from([("ZCODE_BIN".into(), "chosen.cjs".into())]);
        assert_eq!(
            effective_env_from(&overrides, inherited)
                .get("ZCODE_BIN")
                .unwrap(),
            "chosen.cjs"
        );
        let overrides = BTreeMap::from([
            ("ZCODE_BIN".into(), String::new()),
            ("PATH".into(), String::new()),
        ]);
        let env = effective_env_from(&overrides, inherited);
        assert!(!env.contains_key("ZCODE_BIN"));
        assert_eq!(env.get("PATH"), Some(&String::new()));
    }

    #[test]
    fn version_manager_directories_prefer_the_newer_install() {
        let dir = tempfile::tempdir().unwrap();
        let versions = dir.path().join("nvm/versions/node");
        executable(&versions.join("v18.20.0/bin").join(node_binary_name()));
        executable(&versions.join("v22.14.0/bin").join(node_binary_name()));
        let env = BTreeMap::from([(
            "NVM_DIR".into(),
            dir.path().join("nvm").display().to_string(),
        )]);
        let dirs = version_manager_node_dirs(&env, None, "linux");
        assert_eq!(
            dirs.first().map(PathBuf::as_path),
            Some(versions.join("v22.14.0/bin").as_path())
        );
    }
}
