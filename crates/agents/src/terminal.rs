use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, LazyLock},
};

use serde::{Deserialize, Serialize};
use tokio::{
    io::AsyncReadExt,
    process::Child,
    sync::{Mutex, Notify, RwLock, broadcast, mpsc},
};
use ts_rs::TS;
use workspace_utils::{process::new_hidden_tokio_command, shell::refresh_process_path};

use crate::ids::{AgentSessionId, AgentTerminalId};

const DEFAULT_OUTPUT_BYTE_LIMIT: usize = 512 * 1024;
const HARD_OUTPUT_BYTE_LIMIT: usize = 16 * 1024 * 1024;
const MAX_LINE_BOUNDARY_SEARCH: usize = 8 * 1024;
/// After the child exits, wait this long for stdout/stderr readers to drain
/// before publishing the exit status. `wait_for_exit` then `terminal/output`
/// (Grok's sequence) otherwise races an empty snapshot.
const READER_DRAIN_GRACE: std::time::Duration = std::time::Duration::from_millis(200);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentTerminalCreateRequest {
    pub session_id: AgentSessionId,
    pub command: String,
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub env: Vec<AgentTerminalEnvVar>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_byte_limit: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentTerminalEnvVar {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentTerminalOutputSnapshot {
    pub terminal_id: AgentTerminalId,
    pub output: String,
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit: Option<AgentTerminalExit>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum AgentTerminalExit {
    Code { code: i32 },
    Signal { signal: String },
    Unknown,
}

#[derive(Debug, Clone)]
pub struct AgentTerminalCreateEvent {
    pub terminal_id: AgentTerminalId,
    pub session_id: AgentSessionId,
    pub cwd: Option<PathBuf>,
    pub command: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone)]
pub enum AgentTerminalLifecycleEvent {
    Created(AgentTerminalCreateEvent),
    Exited {
        terminal_id: AgentTerminalId,
        exit: AgentTerminalExit,
    },
    Released {
        terminal_id: AgentTerminalId,
    },
}

#[derive(Debug, Clone)]
pub struct AgentTerminalLiveItem {
    pub terminal_id: AgentTerminalId,
    pub agent_session_id: AgentSessionId,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
}

struct AgentTerminalSession {
    agent_session_id: AgentSessionId,
    child: Arc<Mutex<Child>>,
    cwd: Option<PathBuf>,
    command: String,
    args: Vec<String>,
    output_history: Arc<Mutex<Vec<u8>>>,
    subscribers: Arc<Mutex<Vec<mpsc::UnboundedSender<Vec<u8>>>>>,
    exit_status: Arc<RwLock<Option<AgentTerminalExit>>>,
    exit_notify: Arc<Notify>,
    truncated: Arc<RwLock<bool>>,
}

#[derive(Clone)]
pub struct AgentTerminalRegistry {
    sessions: Arc<RwLock<HashMap<AgentTerminalId, Arc<AgentTerminalSession>>>>,
    lifecycle_tx: broadcast::Sender<AgentTerminalLifecycleEvent>,
}

impl AgentTerminalRegistry {
    pub fn new() -> Self {
        let (lifecycle_tx, _) = broadcast::channel(256);
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            lifecycle_tx,
        }
    }

    pub async fn create_terminal(
        &self,
        args: &AgentTerminalCreateRequest,
    ) -> Result<AgentTerminalId, std::io::Error> {
        if args.command.trim().is_empty() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "terminal/create requires a non-empty command",
            ));
        }

        let _ = refresh_process_path().await;
        let terminal_id = AgentTerminalId::new();
        let cwd = args.cwd.as_ref().map(PathBuf::from);

        let mut direct = new_hidden_tokio_command(PathBuf::from(&args.command), &args.args);
        configure_terminal_command(&mut direct, args, cwd.as_ref());

        let fallback_shell = default_platform_shell();
        let can_retry_through_shell =
            can_retry_command_through_shell(&args.command, &args.args, &fallback_shell);
        let mut child = match direct.spawn() {
            Ok(child) => child,
            Err(error) if is_unrunnable_program_error(&error) && can_retry_through_shell => {
                let mut wrapped = shell_wrapped_command(&fallback_shell, &args.command);
                configure_terminal_command(&mut wrapped, args, cwd.as_ref());
                wrapped.spawn()?
            }
            Err(error) => return Err(error),
        };
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let session = Arc::new(AgentTerminalSession {
            agent_session_id: args.session_id,
            child: Arc::new(Mutex::new(child)),
            cwd: cwd.clone(),
            command: args.command.clone(),
            args: args.args.clone(),
            output_history: Arc::new(Mutex::new(Vec::new())),
            subscribers: Arc::new(Mutex::new(Vec::new())),
            exit_status: Arc::new(RwLock::new(None)),
            exit_notify: Arc::new(Notify::new()),
            truncated: Arc::new(RwLock::new(false)),
        });

        self.sessions
            .write()
            .await
            .insert(terminal_id, Arc::clone(&session));

        self.spawn_reader(stdout, Arc::clone(&session), args.output_byte_limit);
        self.spawn_reader(stderr, Arc::clone(&session), args.output_byte_limit);
        self.spawn_waiter(terminal_id, Arc::clone(&session));

        let _ = self.lifecycle_tx.send(AgentTerminalLifecycleEvent::Created(
            AgentTerminalCreateEvent {
                terminal_id,
                session_id: args.session_id,
                cwd,
                command: args.command.clone(),
                args: args.args.clone(),
            },
        ));

        Ok(terminal_id)
    }

    fn spawn_reader(
        &self,
        reader: Option<impl tokio::io::AsyncRead + Unpin + Send + 'static>,
        session: Arc<AgentTerminalSession>,
        output_byte_limit: Option<u64>,
    ) {
        let Some(mut reader) = reader else {
            return;
        };

        tokio::spawn(async move {
            let mut buffer = vec![0_u8; 4096];
            loop {
                match reader.read(&mut buffer).await {
                    Ok(0) => break,
                    Ok(count) => {
                        let chunk = buffer[..count].to_vec();
                        let limit = effective_output_byte_limit(output_byte_limit);
                        let mut was_truncated = false;

                        {
                            let mut history = session.output_history.lock().await;
                            history.extend_from_slice(&chunk);
                            if trim_output_history(&mut history, limit) {
                                was_truncated = true;
                            }
                        }
                        if was_truncated {
                            *session.truncated.write().await = true;
                        }

                        let mut subscribers = session.subscribers.lock().await;
                        subscribers.retain(|subscriber| subscriber.send(chunk.clone()).is_ok());
                    }
                    Err(_) => break,
                }
            }
        });
    }

    fn spawn_waiter(&self, terminal_id: AgentTerminalId, session: Arc<AgentTerminalSession>) {
        let lifecycle_tx = self.lifecycle_tx.clone();
        tokio::spawn(async move {
            let wait_result = {
                let mut child = session.child.lock().await;
                child.wait().await
            };
            tokio::time::sleep(READER_DRAIN_GRACE).await;

            let status = match wait_result {
                Ok(exit_status) => exit_status
                    .code()
                    .map(|code| AgentTerminalExit::Code { code })
                    .unwrap_or(AgentTerminalExit::Unknown),
                Err(_) => AgentTerminalExit::Unknown,
            };

            *session.exit_status.write().await = Some(status.clone());
            session.exit_notify.notify_waiters();
            let _ = lifecycle_tx.send(AgentTerminalLifecycleEvent::Exited {
                terminal_id,
                exit: status,
            });
        });
    }

    pub async fn list_live(&self) -> Vec<AgentTerminalLiveItem> {
        self.sessions
            .read()
            .await
            .iter()
            .map(|(terminal_id, session)| AgentTerminalLiveItem {
                terminal_id: *terminal_id,
                agent_session_id: session.agent_session_id,
                command: session.command.clone(),
                args: session.args.clone(),
                cwd: session.cwd.clone(),
            })
            .collect()
    }

    pub async fn has_running_for_session(&self, session_id: AgentSessionId) -> bool {
        let sessions = self.sessions.read().await;
        for session in sessions.values() {
            if session.agent_session_id == session_id && session.exit_status.read().await.is_none()
            {
                return true;
            }
        }
        false
    }

    pub async fn subscribe_output(
        &self,
        terminal_id: AgentTerminalId,
    ) -> Option<mpsc::UnboundedReceiver<Vec<u8>>> {
        let session = self.sessions.read().await.get(&terminal_id)?.clone();
        let (tx, rx) = mpsc::unbounded_channel();

        let history = session.output_history.lock().await.clone();
        if !history.is_empty() {
            let _ = tx.send(history);
        }

        session.subscribers.lock().await.push(tx);
        Some(rx)
    }

    pub async fn snapshot_output(
        &self,
        terminal_id: AgentTerminalId,
    ) -> Option<AgentTerminalOutputSnapshot> {
        let session = self.sessions.read().await.get(&terminal_id)?.clone();
        let output = String::from_utf8_lossy(&session.output_history.lock().await).to_string();
        let truncated = *session.truncated.read().await;
        let exit = session.exit_status.read().await.clone();

        Some(AgentTerminalOutputSnapshot {
            terminal_id,
            output,
            truncated,
            exit,
        })
    }

    pub async fn wait_for_exit(&self, terminal_id: AgentTerminalId) -> Option<AgentTerminalExit> {
        let session = self.sessions.read().await.get(&terminal_id)?.clone();
        loop {
            if let Some(exit_status) = session.exit_status.read().await.clone() {
                return Some(exit_status);
            }
            session.exit_notify.notified().await;
        }
    }

    pub async fn kill_terminal(&self, terminal_id: AgentTerminalId) -> bool {
        let Some(session) = self.sessions.read().await.get(&terminal_id).cloned() else {
            return false;
        };

        let mut child = session.child.lock().await;
        child.kill().await.is_ok()
    }

    pub async fn release_terminal(&self, terminal_id: AgentTerminalId) -> bool {
        let session = self.sessions.write().await.remove(&terminal_id);
        let Some(session) = session else {
            return false;
        };

        {
            let mut child = session.child.lock().await;
            let _ = child.kill().await;
        }

        session.subscribers.lock().await.clear();
        let _ = self
            .lifecycle_tx
            .send(AgentTerminalLifecycleEvent::Released { terminal_id });
        true
    }

    pub async fn exists(&self, terminal_id: AgentTerminalId) -> bool {
        self.sessions.read().await.contains_key(&terminal_id)
    }

    pub async fn session_info(
        &self,
        terminal_id: AgentTerminalId,
    ) -> Option<(AgentSessionId, Option<PathBuf>, String, Vec<String>)> {
        let session = self.sessions.read().await.get(&terminal_id)?.clone();
        Some((
            session.agent_session_id,
            session.cwd.clone(),
            session.command.clone(),
            session.args.clone(),
        ))
    }

    pub fn subscribe_lifecycle(&self) -> broadcast::Receiver<AgentTerminalLifecycleEvent> {
        self.lifecycle_tx.subscribe()
    }
}

fn effective_output_byte_limit(requested: Option<u64>) -> usize {
    match requested {
        None | Some(0) => DEFAULT_OUTPUT_BYTE_LIMIT,
        Some(value) => usize::try_from(value)
            .unwrap_or(HARD_OUTPUT_BYTE_LIMIT)
            .clamp(1, HARD_OUTPUT_BYTE_LIMIT),
    }
}

fn trim_output_history(history: &mut Vec<u8>, limit: usize) -> bool {
    if history.len() <= limit {
        return false;
    }

    let overflow = history.len() - limit;
    let boundary_search_end = (overflow + MAX_LINE_BOUNDARY_SEARCH).min(history.len());
    let trim_to = history[overflow..boundary_search_end]
        .iter()
        .position(|byte| matches!(byte, b'\n' | b'\r'))
        .map(|offset| overflow + offset + 1)
        .unwrap_or_else(|| first_utf8_boundary_at_or_after(history, overflow));

    history.drain(..trim_to);
    true
}

fn first_utf8_boundary_at_or_after(bytes: &[u8], index: usize) -> usize {
    let mut index = index.min(bytes.len());
    while index < bytes.len() && !is_utf8_boundary_byte(bytes[index]) {
        index += 1;
    }
    index
}

fn is_utf8_boundary_byte(byte: u8) -> bool {
    byte & 0b1100_0000 != 0b1000_0000
}

impl Default for AgentTerminalRegistry {
    fn default() -> Self {
        Self::new()
    }
}

fn configure_terminal_command(
    command: &mut tokio::process::Command,
    args: &AgentTerminalCreateRequest,
    cwd: Option<&PathBuf>,
) {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false);

    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }

    if !args
        .env
        .iter()
        .any(|env_var| env_var.name.eq_ignore_ascii_case("PATH"))
        && let Some(path) = std::env::var_os("PATH")
    {
        command.env("PATH", path);
    }

    for env_var in &args.env {
        command.env(&env_var.name, &env_var.value);
    }
}

/// Fill in a session working directory when the agent omits `cwd`. An explicit
/// path is kept as-is so a missing directory still fails at spawn.
pub(crate) fn resolve_terminal_cwd(
    requested: Option<&Path>,
    session_working_dir: &Path,
) -> Result<Option<PathBuf>, std::io::Error> {
    match requested {
        Some(cwd) if !cwd.is_absolute() => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "terminal/create requires an absolute cwd when provided",
        )),
        Some(cwd) => Ok(Some(cwd.to_path_buf())),
        None if session_working_dir.is_dir() => Ok(Some(session_working_dir.to_path_buf())),
        None => Ok(None),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShellFamily {
    PowerShell,
    Cmd,
    Posix,
}

impl ShellFamily {
    fn resolves_bare_builtins(self) -> bool {
        matches!(self, ShellFamily::PowerShell | ShellFamily::Cmd)
    }
}

fn shell_basename(shell: &str) -> String {
    Path::new(shell)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(shell)
        .to_ascii_lowercase()
}

fn classify_shell_family(shell: &str) -> ShellFamily {
    let name = shell_basename(shell);
    if name.contains("pwsh") || name.contains("powershell") {
        return ShellFamily::PowerShell;
    }
    if name == "cmd" || name == "cmd.exe" {
        return ShellFamily::Cmd;
    }

    #[cfg(target_os = "windows")]
    {
        if name.contains("bash")
            || name.contains("zsh")
            || name.contains("fish")
            || name.ends_with("sh.exe")
        {
            ShellFamily::Posix
        } else {
            ShellFamily::Cmd
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        ShellFamily::Posix
    }
}

#[cfg(unix)]
fn default_platform_shell() -> String {
    "/bin/sh".to_string()
}

/// Windows Agent fallback shell: Git Bash, then cmd, then PowerShell.
///
/// `System32\bash.exe` is the WSL stub and is skipped. Interactive Terminal
/// panels keep their own PowerShell default.
#[cfg(any(windows, test))]
fn resolve_windows_agent_shell(
    git_bash: impl IntoIterator<Item = PathBuf>,
    cmd: impl IntoIterator<Item = PathBuf>,
    powershell: impl IntoIterator<Item = PathBuf>,
) -> String {
    git_bash
        .into_iter()
        .chain(cmd)
        .chain(powershell)
        .find(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| "cmd.exe".to_string())
}

#[cfg(any(windows, test))]
fn is_wsl_bash(path: &Path) -> bool {
    let normalized = path
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase();
    normalized.ends_with("\\system32\\bash.exe") || normalized.ends_with("\\sysnative\\bash.exe")
}

#[cfg(windows)]
fn default_platform_shell() -> String {
    resolve_windows_agent_shell(
        windows_git_bash_candidates(),
        windows_cmd_candidates(),
        windows_powershell_candidates(),
    )
}

#[cfg(windows)]
fn windows_git_bash_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut push = |path: PathBuf| {
        if is_wsl_bash(&path) {
            return;
        }
        if seen.insert(path.clone()) {
            candidates.push(path);
        }
    };

    for root in windows_git_install_roots() {
        push(root.join("bin").join("bash.exe"));
        push(root.join("usr").join("bin").join("bash.exe"));
    }
    if let Ok(git) = which::which("git")
        && let Some(git_root) = git.parent().and_then(Path::parent)
    {
        push(git_root.join("bin").join("bash.exe"));
    }
    if let Ok(bash) = which::which("bash.exe").or_else(|_| which::which("bash")) {
        push(bash);
    }
    candidates
}

#[cfg(windows)]
fn windows_git_install_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for key in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(value) = std::env::var(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                roots.push(PathBuf::from(trimmed).join("Git"));
            }
        }
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let trimmed = local.trim();
        if !trimmed.is_empty() {
            roots.push(PathBuf::from(trimmed).join("Programs").join("Git"));
        }
    }
    roots
}

#[cfg(windows)]
fn windows_cmd_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(system_root) = windows_system_root() {
        candidates.push(system_root.join("System32").join("cmd.exe"));
    }
    if let Ok(comspec) = std::env::var("COMSPEC") {
        let trimmed = comspec.trim();
        if !trimmed.is_empty() && classify_shell_family(trimmed) == ShellFamily::Cmd {
            candidates.push(PathBuf::from(trimmed));
        }
    }
    candidates
}

#[cfg(windows)]
fn windows_powershell_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(system_root) = windows_system_root() {
        candidates.push(
            system_root
                .join("System32")
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe"),
        );
    }
    if let Ok(powershell) = which::which("powershell.exe") {
        candidates.push(powershell);
    }
    if let Ok(pwsh) = which::which("pwsh.exe") {
        candidates.push(pwsh);
    }
    candidates
}

#[cfg(windows)]
fn windows_system_root() -> Option<PathBuf> {
    std::env::var("SystemRoot")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn can_retry_command_through_shell(command: &str, args: &[String], fallback_shell: &str) -> bool {
    args.is_empty()
        && (command.contains(char::is_whitespace)
            || classify_shell_family(fallback_shell).resolves_bare_builtins())
}

fn is_unrunnable_program_error(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::NotFound | std::io::ErrorKind::InvalidFilename
    )
}

/// Wrap a whole command line as one argv element of the platform shell.
fn shell_wrapped_command(shell: &str, line: &str) -> tokio::process::Command {
    let mut command = new_hidden_tokio_command(PathBuf::from(shell), std::iter::empty::<&str>());
    match classify_shell_family(shell) {
        ShellFamily::PowerShell => {
            command.args(["-NoLogo", "-NoProfile", "-Command", line]);
        }
        ShellFamily::Cmd => {
            command.args(["/D", "/S", "/C", line]);
        }
        ShellFamily::Posix => {
            command.arg("-c").arg(line);
        }
    }
    command
}

static AGENT_TERMINAL_REGISTRY: LazyLock<AgentTerminalRegistry> =
    LazyLock::new(AgentTerminalRegistry::new);

pub fn agent_terminal_registry() -> &'static AgentTerminalRegistry {
    &AGENT_TERMINAL_REGISTRY
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        AgentTerminalCreateRequest, AgentTerminalRegistry, DEFAULT_OUTPUT_BYTE_LIMIT,
        HARD_OUTPUT_BYTE_LIMIT, ShellFamily, can_retry_command_through_shell,
        classify_shell_family, default_platform_shell, effective_output_byte_limit,
        is_utf8_boundary_byte, resolve_terminal_cwd, shell_wrapped_command, trim_output_history,
    };
    use crate::ids::AgentSessionId;

    #[test]
    fn agent_output_byte_limit_is_hard_capped() {
        assert_eq!(effective_output_byte_limit(None), DEFAULT_OUTPUT_BYTE_LIMIT);
        assert_eq!(
            effective_output_byte_limit(Some(0)),
            DEFAULT_OUTPUT_BYTE_LIMIT
        );
        assert_eq!(
            effective_output_byte_limit(Some(u64::MAX)),
            HARD_OUTPUT_BYTE_LIMIT
        );
        assert_eq!(effective_output_byte_limit(Some(4096)), 4096);
    }

    fn request(command: &str) -> AgentTerminalCreateRequest {
        AgentTerminalCreateRequest {
            session_id: AgentSessionId::new(),
            command: command.to_string(),
            args: Vec::new(),
            cwd: None,
            env: Vec::new(),
            output_byte_limit: Some(4096),
        }
    }

    async fn run_and_capture(command: &str) -> String {
        run_request(request(command)).await
    }

    async fn run_request(request: AgentTerminalCreateRequest) -> String {
        let registry = AgentTerminalRegistry::new();
        let terminal_id = registry
            .create_terminal(&request)
            .await
            .expect("create terminal");
        let _ = registry.wait_for_exit(terminal_id).await;
        let snapshot = registry
            .snapshot_output(terminal_id)
            .await
            .expect("terminal snapshot");
        registry.release_terminal(terminal_id).await;
        snapshot.output
    }

    fn wrapped_argv(shell: &str, line: &str) -> (String, Vec<String>) {
        let command = shell_wrapped_command(shell, line);
        let std_command = command.as_std();
        (
            std_command.get_program().to_string_lossy().to_string(),
            std_command
                .get_args()
                .map(|value| value.to_string_lossy().to_string())
                .collect(),
        )
    }

    #[test]
    fn posix_wrap_passes_the_line_as_one_argument() {
        let (program, args) = wrapped_argv("/bin/sh", "echo hello world");
        assert_eq!(program, "/bin/sh");
        assert_eq!(args, vec!["-c".to_string(), "echo hello world".to_string()]);
    }

    #[test]
    fn powershell_wrap_uses_command_flag() {
        let (program, args) = wrapped_argv("pwsh.exe", "Get-ChildItem");
        assert_eq!(program, "pwsh.exe");
        assert_eq!(
            args,
            vec![
                "-NoLogo".to_string(),
                "-NoProfile".to_string(),
                "-Command".to_string(),
                "Get-ChildItem".to_string(),
            ]
        );
    }

    #[test]
    fn cmd_wrap_uses_slash_c() {
        let (program, args) = wrapped_argv("cmd.exe", "echo hello");
        assert_eq!(program, "cmd.exe");
        assert_eq!(
            args,
            vec![
                "/D".to_string(),
                "/S".to_string(),
                "/C".to_string(),
                "echo hello".to_string(),
            ]
        );
    }

    #[test]
    fn whitespace_command_without_args_retries_through_posix_shell() {
        assert!(can_retry_command_through_shell(
            "echo hello world",
            &[],
            "/bin/sh"
        ));
        assert!(!can_retry_command_through_shell("pwd", &[], "/bin/sh"));
        assert!(!can_retry_command_through_shell(
            "git",
            &["status".to_string()],
            "/bin/sh"
        ));
        assert!(can_retry_command_through_shell("dir", &[], "cmd.exe"));
    }

    #[test]
    fn unknown_unix_shells_are_posix() {
        assert_eq!(classify_shell_family("/bin/sh"), ShellFamily::Posix);
        assert!(!ShellFamily::Posix.resolves_bare_builtins());
        assert!(ShellFamily::Cmd.resolves_bare_builtins());
        assert!(ShellFamily::PowerShell.resolves_bare_builtins());
    }

    fn touch(path: &Path) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent");
        }
        std::fs::write(path, []).expect("touch");
    }

    #[test]
    fn windows_agent_shell_prefers_git_bash_then_cmd_then_powershell() {
        let dir = tempfile::tempdir().expect("temp dir");
        let bash = dir.path().join("Git").join("bin").join("bash.exe");
        let cmd = dir.path().join("System32").join("cmd.exe");
        let powershell = dir.path().join("WindowsPowerShell").join("powershell.exe");
        touch(&bash);
        touch(&cmd);
        touch(&powershell);

        assert_eq!(
            super::resolve_windows_agent_shell([bash.clone()], [cmd.clone()], [powershell.clone()]),
            bash.to_string_lossy()
        );
        assert_eq!(
            super::resolve_windows_agent_shell([], [cmd.clone()], [powershell.clone()]),
            cmd.to_string_lossy()
        );
        assert_eq!(
            super::resolve_windows_agent_shell([], [], [powershell.clone()]),
            powershell.to_string_lossy()
        );
        assert_eq!(super::resolve_windows_agent_shell([], [], []), "cmd.exe");
    }

    #[test]
    fn wsl_stub_bash_is_not_treated_as_git_bash() {
        assert!(super::is_wsl_bash(Path::new(
            r"C:\Windows\System32\bash.exe"
        )));
        assert!(super::is_wsl_bash(Path::new("/Windows/System32/bash.exe")));
        assert!(!super::is_wsl_bash(Path::new(
            r"C:\Program Files\Git\bin\bash.exe"
        )));
    }

    #[test]
    fn omitted_cwd_falls_back_to_a_real_session_directory() {
        let dir = tempfile::tempdir().expect("temp dir");
        let resolved = resolve_terminal_cwd(None, dir.path()).expect("resolve omitted cwd");
        assert_eq!(resolved.as_deref(), Some(dir.path()));
    }

    #[test]
    fn explicit_cwd_is_kept_even_when_missing() {
        let missing = Path::new("/vibex-nonexistent-cwd/does/not/exist");
        let dir = tempfile::tempdir().expect("temp dir");
        let resolved = resolve_terminal_cwd(Some(missing), dir.path()).expect("keep explicit cwd");
        assert_eq!(resolved.as_deref(), Some(missing));
    }

    #[test]
    fn relative_cwd_is_rejected() {
        let dir = tempfile::tempdir().expect("temp dir");
        let error = resolve_terminal_cwd(Some(Path::new("relative/path")), dir.path())
            .expect_err("relative cwd");
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
    }

    #[tokio::test]
    async fn whitespace_command_runs_through_shell() {
        let output = run_and_capture("echo hello world").await;
        assert!(
            output.contains("hello world"),
            "shell did not run the whitespace command; got:\n{output}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn shell_operators_evaluate() {
        let output = run_and_capture("true && echo OK").await;
        assert!(
            output.contains("OK"),
            "shell operators did not evaluate; got:\n{output}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn grok_style_bash_lc_command_line_runs() {
        let output = run_and_capture("/bin/bash -lc pwd").await;
        assert!(
            output.contains('/'),
            "grok-style bash -lc line did not run; got:\n{output:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unset_default_runs_the_platform_shell_not_the_login_shell() {
        assert_eq!(default_platform_shell(), "/bin/sh");
        let output = run_and_capture("echo \"ran-under=$0\"").await;
        assert!(
            output.contains("ran-under=/bin/sh"),
            "unset default did not run through /bin/sh; got:\n{output}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn overlong_command_line_falls_back_to_shell() {
        let marker = "x".repeat(5000);
        let mut request = request(&format!("echo {marker}"));
        request.output_byte_limit = Some(64 * 1024);
        let output = run_request(request).await;
        assert!(
            output.contains(&marker),
            "overlong command line did not run via the shell fallback; got {} bytes",
            output.len()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn explicit_args_bypass_shell_wrap() {
        let mut request = request("/bin/echo");
        request.args = vec!["hello world".into()];
        let output = run_request(request).await;
        assert!(
            output.contains("hello world"),
            "direct exec did not pass the single arg through; got:\n{output}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn shell_wrapped_command_respects_cwd() {
        let dir = tempfile::tempdir().expect("temp dir");
        let canonical = dir.path().canonicalize().expect("canonicalize");
        let mut request = request("pwd && echo done");
        request.cwd = Some(dir.path().display().to_string());
        let output = run_request(request).await;
        assert!(
            output.contains(canonical.to_string_lossy().as_ref()) && output.contains("done"),
            "shell-wrapped command ignored cwd; got:\n{output}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn space_containing_executable_is_direct_execd() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("temp dir");
        let binary = dir.path().join("my tool");
        std::fs::write(&binary, "#!/bin/sh\necho acp-space-ok\n").expect("write tool");
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        let output = run_and_capture(binary.to_str().expect("utf8 path")).await;
        assert!(
            output.contains("acp-space-ok"),
            "space-containing executable was not exec'd directly; got:\n{output}"
        );
    }

    #[tokio::test]
    async fn empty_command_is_rejected() {
        let registry = AgentTerminalRegistry::new();
        let error = registry
            .create_terminal(&request("   "))
            .await
            .expect_err("empty command");
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn has_running_for_session_is_true_only_while_the_child_is_alive() {
        let registry = AgentTerminalRegistry::new();
        let session_id = AgentSessionId::new();
        let other_session = AgentSessionId::new();
        let terminal_id = registry
            .create_terminal(&AgentTerminalCreateRequest {
                session_id,
                command: "sleep".to_string(),
                args: vec!["30".to_string()],
                cwd: None,
                env: Vec::new(),
                output_byte_limit: Some(4096),
            })
            .await
            .expect("create sleep terminal");

        assert!(registry.has_running_for_session(session_id).await);
        assert!(!registry.has_running_for_session(other_session).await);

        assert!(registry.kill_terminal(terminal_id).await);
        let _ = registry.wait_for_exit(terminal_id).await;
        assert!(!registry.has_running_for_session(session_id).await);

        registry.release_terminal(terminal_id).await;
    }

    #[test]
    fn trim_output_history_prefers_line_boundary_after_overflow() {
        let mut history = vec![b'a'; DEFAULT_OUTPUT_BYTE_LIMIT + 10];
        history[12] = b'\n';

        assert!(trim_output_history(&mut history, DEFAULT_OUTPUT_BYTE_LIMIT));

        assert_eq!(history.len(), DEFAULT_OUTPUT_BYTE_LIMIT + 10 - 13);
        assert_eq!(history[0], b'a');
    }

    #[test]
    fn trim_output_history_does_not_start_with_utf8_continuation_byte() {
        let mut history = vec![b'a'; DEFAULT_OUTPUT_BYTE_LIMIT + 4];
        let bytes = [0xe5, 0xa5, 0xbd];
        history[2..2 + bytes.len()].copy_from_slice(&bytes);

        assert!(trim_output_history(&mut history, DEFAULT_OUTPUT_BYTE_LIMIT));

        assert!(
            history
                .first()
                .is_none_or(|byte| is_utf8_boundary_byte(*byte))
        );
    }
}
