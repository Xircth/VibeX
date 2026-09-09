use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex, mpsc as std_mpsc},
    thread,
};

use agents::{
    HostTerminalSnapshot, TerminalOutputChunk, TerminalOutputRx, TerminalOutputTx,
    classify_shell_family, is_bash_like_posix_shell, shell_flavor::ShellFamily,
};
use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use thiserror::Error;
use utils::shell::{get_interactive_shell, resolve_executable_path};
use uuid::Uuid;

fn is_usable_pty_shell(name: &str) -> bool {
    !name.is_empty() && !name.eq_ignore_ascii_case("warp")
}

async fn resolve_pty_shell(shell_override: Option<String>) -> PathBuf {
    let mut preferred = Vec::new();
    if let Some(shell) = shell_override.filter(|value| is_usable_pty_shell(value)) {
        preferred.push(shell);
    }
    if let Some(configured) = agents::configured_terminal_shell().await
        && is_usable_pty_shell(&configured)
        && !preferred.iter().any(|item| item == &configured)
    {
        preferred.push(configured);
    }
    pick_existing_pty_shell(preferred, get_interactive_shell().await).await
}

/// Pick a shell that actually exists on this Host. Missing names (for example
/// a macOS `zsh` default sent to a Linux Host) must not be spawned.
pub(crate) async fn pick_existing_pty_shell(
    preferred: Vec<String>,
    interactive: PathBuf,
) -> PathBuf {
    let mut candidates = preferred;
    let interactive_name = interactive.to_string_lossy().into_owned();
    if is_usable_pty_shell(&interactive_name) {
        candidates.push(interactive_name);
    }
    #[cfg(windows)]
    {
        candidates.extend(
            ["powershell.exe", "pwsh.exe", "cmd.exe"]
                .into_iter()
                .map(str::to_string),
        );
    }
    #[cfg(not(windows))]
    {
        candidates.extend(
            ["bash", "sh", "/bin/bash", "/bin/sh"]
                .into_iter()
                .map(str::to_string),
        );
    }

    let mut seen = HashSet::new();
    for candidate in candidates {
        if !is_usable_pty_shell(&candidate) || !seen.insert(candidate.clone()) {
            continue;
        }
        if let Some(path) = resolve_executable_path(&candidate).await {
            return path;
        }
    }
    interactive
}

fn configure_shell_command(cmd: &mut CommandBuilder, shell: &str, initial_command: Option<&str>) {
    let family = classify_shell_family(shell);

    #[cfg(windows)]
    {
        cmd.env("PYTHONUTF8", "1");
        cmd.env("PYTHONIOENCODING", "utf-8");
        match family {
            ShellFamily::Cmd => {
                if let Some(command) = initial_command {
                    cmd.env("VIBEX_CMD", command);
                    cmd.args(["/D", "/S", "/C", "chcp 65001 >nul & %VIBEX_CMD%"]);
                } else {
                    cmd.args(["/D", "/S", "/K", "chcp 65001 >nul"]);
                }
            }
            ShellFamily::PowerShell => {
                if let Some(command) = initial_command {
                    cmd.env("VIBEX_CMD", command);
                    cmd.args([
                        "-NoLogo",
                        "-NoProfile",
                        "-Command",
                        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $ErrorActionPreference = 'Stop'; Invoke-Expression $env:VIBEX_CMD",
                    ]);
                } else {
                    cmd.args([
                        "-NoLogo",
                        "-NoProfile",
                        "-NoExit",
                        "-Command",
                        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
                    ]);
                }
            }
            ShellFamily::Posix => {
                cmd.env("TERM", "xterm-256color");
                cmd.env("COLORTERM", "truecolor");
                cmd.env("TERM_PROGRAM", "vibex");
                cmd.env("LANG", "C.UTF-8");
                if let Some(command) = initial_command {
                    cmd.env("VIBEX_CMD", command);
                    cmd.args(["-l", "-i", "-c", "eval \"$VIBEX_CMD\""]);
                } else {
                    cmd.args(["-l", "-i"]);
                }
            }
        }
    }

    #[cfg(not(windows))]
    {
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "vibex");
        match family {
            ShellFamily::PowerShell => {
                cmd.arg("-NoLogo");
                if let Some(command) = initial_command {
                    cmd.args(["-NoProfile", "-Command", command]);
                }
            }
            ShellFamily::Cmd => {}
            ShellFamily::Posix if is_bash_like_posix_shell(shell) => {
                if let Some(command) = initial_command {
                    cmd.env("VIBEX_CMD", command);
                    cmd.args(["-l", "-i", "-c", "eval \"$VIBEX_CMD\""]);
                } else {
                    cmd.args(["-l", "-i"]);
                }
            }
            ShellFamily::Posix => {
                if let Some(command) = initial_command {
                    cmd.args(["-c", command]);
                }
            }
        }
    }
}

fn thread_name_prefix(terminal_id: Uuid) -> String {
    terminal_id.simple().to_string().chars().take(8).collect()
}

#[derive(Debug, Error)]
pub enum PtyError {
    #[error("Failed to create PTY: {0}")]
    CreateFailed(String),
    #[error("Session not found: {0}")]
    SessionNotFound(Uuid),
    #[error("Failed to write to PTY: {0}")]
    WriteFailed(String),
    #[error("Failed to resize PTY: {0}")]
    ResizeFailed(String),
    #[error("Session already closed")]
    SessionClosed,
}

/// Recent PTY output kept so a viewer that mounts after spawn (or remounts)
/// can redraw. Whole chunks are evicted from the front: slicing mid-escape
/// paints the replay with whatever the truncated tail happens to mean.
#[derive(Default)]
struct Scrollback {
    chunks: VecDeque<Vec<u8>>,
    bytes: usize,
    seq: u64,
}

impl Scrollback {
    fn append(&mut self, data: &[u8], max_bytes: usize) -> u64 {
        self.seq += 1;
        self.bytes = self.bytes.saturating_add(data.len());
        self.chunks.push_back(data.to_vec());
        while self.bytes > max_bytes && self.chunks.len() > 1 {
            if let Some(old) = self.chunks.pop_front() {
                self.bytes = self.bytes.saturating_sub(old.len());
            }
        }
        self.seq
    }

    fn read(&self) -> (Vec<u8>, u64) {
        let mut data = Vec::with_capacity(self.bytes);
        for chunk in &self.chunks {
            data.extend_from_slice(chunk);
        }
        (data, self.seq)
    }
}

struct PtySession {
    input_tx: std_mpsc::Sender<Vec<u8>>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send>,
    scrollback: Arc<Mutex<Scrollback>>,
    subscribers: Arc<Mutex<Vec<TerminalOutputTx>>>,
    _input_handle: thread::JoinHandle<()>,
    closed: bool,
}

#[derive(Clone)]
pub struct PtyService {
    sessions: Arc<Mutex<HashMap<Uuid, PtySession>>>,
}

impl PtyService {
    const MAX_HISTORY_BYTES: usize = 512 * 1024;

    fn normalize_working_dir_for_shell(working_dir: PathBuf) -> PathBuf {
        #[cfg(windows)]
        {
            let raw = working_dir.to_string_lossy();
            if let Some(path) = raw.strip_prefix(r"\\?\UNC\") {
                return PathBuf::from(format!(r"\\{path}"));
            }
            if let Some(path) = raw.strip_prefix(r"\\?\") {
                return PathBuf::from(path);
            }
        }

        working_dir
    }

    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn create_session(
        &self,
        working_dir: PathBuf,
        cols: u16,
        rows: u16,
        shell_override: Option<String>,
        preset_session_id: Option<Uuid>,
        initial_command: Option<String>,
    ) -> Result<(Uuid, TerminalOutputRx), PtyError> {
        let session_id = preset_session_id.unwrap_or_else(Uuid::new_v4);
        {
            let sessions = self
                .sessions
                .lock()
                .map_err(|e| PtyError::CreateFailed(e.to_string()))?;
            if sessions.contains_key(&session_id) {
                return Err(PtyError::CreateFailed(format!(
                    "terminal id '{session_id}' already exists"
                )));
            }
        }

        let (output_tx, output_rx) = TerminalOutputTx::pair();
        let working_dir = Self::normalize_working_dir_for_shell(working_dir);
        let shell = resolve_pty_shell(shell_override).await;
        let scrollback = Arc::new(Mutex::new(Scrollback::default()));
        let subscribers = Arc::new(Mutex::new(vec![output_tx]));
        let history_for_thread = Arc::clone(&scrollback);
        let subscribers_for_thread = Arc::clone(&subscribers);
        let sessions_for_reader = Arc::clone(&self.sessions);
        let short_id = thread_name_prefix(session_id);

        let result = tokio::task::spawn_blocking(move || {
            let pty_system = NativePtySystem::default();

            let pty_pair = pty_system
                .openpty(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| PtyError::CreateFailed(e.to_string()))?;

            let mut cmd = CommandBuilder::new(&shell);
            cmd.cwd(&working_dir);
            configure_shell_command(
                &mut cmd,
                &shell.to_string_lossy(),
                initial_command.as_deref(),
            );

            let child = pty_pair
                .slave
                .spawn_command(cmd)
                .map_err(|e| PtyError::CreateFailed(e.to_string()))?;
            drop(pty_pair.slave);

            let writer = pty_pair
                .master
                .take_writer()
                .map_err(|e| PtyError::CreateFailed(e.to_string()))?;
            let reader = pty_pair
                .master
                .try_clone_reader()
                .map_err(|e| PtyError::CreateFailed(e.to_string()))?;
            let (input_tx, input_rx) = std_mpsc::channel::<Vec<u8>>();

            Ok::<_, PtyError>((pty_pair.master, child, writer, reader, input_tx, input_rx))
        })
        .await
        .map_err(|e| PtyError::CreateFailed(e.to_string()))??;

        let (master, child, mut writer, mut reader, input_tx, input_rx) = result;

        let input_handle = thread::Builder::new()
            .name(format!("pty-writer-{short_id}"))
            .spawn(move || {
                while let Ok(data) = input_rx.recv() {
                    if writer.write_all(&data).is_err() {
                        break;
                    }
                    while let Ok(more) = input_rx.try_recv() {
                        if writer.write_all(&more).is_err() {
                            return;
                        }
                    }
                    if writer.flush().is_err() {
                        break;
                    }
                }
            })
            .map_err(|e| PtyError::CreateFailed(e.to_string()))?;

        let session = PtySession {
            input_tx,
            master,
            child,
            scrollback,
            subscribers,
            _input_handle: input_handle,
            closed: false,
        };

        self.sessions
            .lock()
            .map_err(|e| PtyError::CreateFailed(e.to_string()))?
            .insert(session_id, session);

        thread::Builder::new()
            .name(format!("pty-reader-{short_id}"))
            .spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let data = buf[..n].to_vec();
                            let seq = history_for_thread
                                .lock()
                                .map(|mut history| {
                                    history.append(&data, PtyService::MAX_HISTORY_BYTES)
                                })
                                .unwrap_or_default();
                            if let Ok(mut subscribers) = subscribers_for_thread.lock() {
                                subscribers.retain(|subscriber| {
                                    if subscriber.is_closed() {
                                        return false;
                                    }
                                    subscriber.push(TerminalOutputChunk {
                                        seq,
                                        data: data.clone(),
                                    });
                                    true
                                });
                            }
                        }
                        Err(_) => break,
                    }
                }
                if let Ok(mut sessions) = sessions_for_reader.lock()
                    && let Some(mut session) = sessions.remove(&session_id)
                {
                    session.closed = true;
                    if let Ok(mut subscribers) = session.subscribers.lock() {
                        for subscriber in subscribers.drain(..) {
                            subscriber.close();
                        }
                    }
                    let _ = session.child.kill();
                }
            })
            .map_err(|e| PtyError::CreateFailed(e.to_string()))?;

        Ok((session_id, output_rx))
    }

    pub fn snapshot(&self, session_id: Uuid) -> HostTerminalSnapshot {
        let scrollback = {
            let Ok(sessions) = self.sessions.lock() else {
                return HostTerminalSnapshot::missing();
            };
            match sessions.get(&session_id) {
                Some(session) if !session.closed => Arc::clone(&session.scrollback),
                _ => return HostTerminalSnapshot::missing(),
            }
        };
        let (data, seq) = scrollback
            .lock()
            .map(|buffer| buffer.read())
            .unwrap_or_else(|_| (Vec::new(), 0));
        HostTerminalSnapshot::from_bytes(&data, seq)
    }

    pub async fn subscribe_output(&self, session_id: Uuid) -> Result<TerminalOutputRx, PtyError> {
        let (tx, rx) = TerminalOutputTx::pair();
        let sessions = self
            .sessions
            .lock()
            .map_err(|e| PtyError::CreateFailed(e.to_string()))?;
        let session = sessions
            .get(&session_id)
            .ok_or(PtyError::SessionNotFound(session_id))?;

        if session.closed {
            return Err(PtyError::SessionClosed);
        }

        session
            .subscribers
            .lock()
            .map_err(|e| PtyError::CreateFailed(e.to_string()))?
            .push(tx);

        Ok(rx)
    }

    pub async fn write(&self, session_id: Uuid, data: &[u8]) -> Result<(), PtyError> {
        let input_tx = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|e| PtyError::WriteFailed(e.to_string()))?;
            let session = sessions
                .get(&session_id)
                .ok_or(PtyError::SessionNotFound(session_id))?;

            if session.closed {
                return Err(PtyError::SessionClosed);
            }

            session.input_tx.clone()
        };

        input_tx
            .send(data.to_vec())
            .map_err(|e| PtyError::WriteFailed(e.to_string()))?;

        Ok(())
    }

    pub async fn resize(&self, session_id: Uuid, cols: u16, rows: u16) -> Result<(), PtyError> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|e| PtyError::ResizeFailed(e.to_string()))?;
        let session = sessions
            .get(&session_id)
            .ok_or(PtyError::SessionNotFound(session_id))?;

        if session.closed {
            return Err(PtyError::SessionClosed);
        }

        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PtyError::ResizeFailed(e.to_string()))?;

        Ok(())
    }

    pub async fn close_session(&self, session_id: Uuid) -> Result<(), PtyError> {
        if let Some(mut session) = self
            .sessions
            .lock()
            .map_err(|_| PtyError::SessionClosed)?
            .remove(&session_id)
        {
            session.closed = true;
            let _ = session.child.kill();
            let _ = session.child.wait();
            if let Ok(mut subscribers) = session.subscribers.lock() {
                for subscriber in subscribers.drain(..) {
                    subscriber.close();
                }
            }
        }
        Ok(())
    }

    pub fn session_exists(&self, session_id: &Uuid) -> bool {
        self.sessions
            .lock()
            .map(|s| s.get(session_id).is_some_and(|session| !session.closed))
            .unwrap_or(false)
    }
}

impl Default for PtyService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{PtyService, Scrollback};

    #[test]
    fn normalize_working_dir_preserves_regular_windows_paths() {
        let path = PathBuf::from(r"C:\Users\Administrator\Documents\Projects");
        assert_eq!(
            PtyService::normalize_working_dir_for_shell(path.clone()),
            path
        );
    }

    #[cfg(windows)]
    #[test]
    fn normalize_working_dir_strips_extended_windows_drive_prefix() {
        let normalized =
            PtyService::normalize_working_dir_for_shell(PathBuf::from(r"\\?\C:\Users\Admin"));
        assert_eq!(normalized, PathBuf::from(r"C:\Users\Admin"));
    }

    #[cfg(windows)]
    #[test]
    fn normalize_working_dir_strips_extended_unc_prefix() {
        let normalized = PtyService::normalize_working_dir_for_shell(PathBuf::from(
            r"\\?\UNC\server\share\workspace",
        ));
        assert_eq!(normalized, PathBuf::from(r"\\server\share\workspace"));
    }

    #[test]
    fn scrollback_seq_counts_every_chunk_and_never_rewinds() {
        let mut buffer = Scrollback::default();
        assert_eq!(buffer.append(b"a", PtyService::MAX_HISTORY_BYTES), 1);
        assert_eq!(buffer.append(b"b", PtyService::MAX_HISTORY_BYTES), 2);
        let (data, seq) = buffer.read();
        assert_eq!(seq, 2);
        assert_eq!(data, b"ab");
    }

    #[test]
    fn scrollback_evicts_whole_chunks_and_keeps_counting() {
        let mut buffer = Scrollback::default();
        let chunk = vec![b'x'; PtyService::MAX_HISTORY_BYTES / 2 + 1];
        buffer.append(&chunk, PtyService::MAX_HISTORY_BYTES);
        buffer.append(&chunk, PtyService::MAX_HISTORY_BYTES);
        let seq = buffer.append(b"tail", PtyService::MAX_HISTORY_BYTES);
        let (data, read_seq) = buffer.read();
        assert_eq!(read_seq, seq);
        assert!(data.ends_with(b"tail"));
        assert!(data.len() <= PtyService::MAX_HISTORY_BYTES);
    }

    #[test]
    fn scrollback_keeps_the_last_chunk_even_when_it_alone_is_too_big() {
        let mut buffer = Scrollback::default();
        let huge = vec![b'y'; PtyService::MAX_HISTORY_BYTES * 2];
        buffer.append(&huge, PtyService::MAX_HISTORY_BYTES);
        let (data, seq) = buffer.read();
        assert_eq!(seq, 1);
        assert_eq!(data.len(), huge.len());
    }

    #[test]
    fn a_missing_terminal_reports_not_alive_rather_than_failing() {
        let service = PtyService::new();
        let snapshot = service.snapshot(uuid::Uuid::nil());
        assert!(!snapshot.alive);
        assert!(snapshot.data.is_empty());
        assert_eq!(snapshot.seq, 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn uses_an_existing_preferred_shell() {
        let path =
            super::pick_existing_pty_shell(vec!["/bin/sh".into()], PathBuf::from("/bin/bash"))
                .await;
        assert_eq!(path, PathBuf::from("/bin/sh"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn skips_a_missing_preferred_shell_instead_of_spawning_it() {
        let path = super::pick_existing_pty_shell(
            vec!["zsh-missing-on-this-host-xyz".into()],
            PathBuf::from("/no/such/interactive-shell"),
        )
        .await;
        assert!(
            path.is_file(),
            "expected a real shell after zsh was missing, got {}",
            path.display()
        );
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        assert!(
            name == "bash" || name == "sh",
            "unexpected fallback shell {name}"
        );
    }
}
