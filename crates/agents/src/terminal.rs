use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, LazyLock, Mutex as StdMutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use command_group::AsyncGroupChild;
use serde::{Deserialize, Serialize};
use tokio::{
    io::AsyncReadExt,
    sync::{Mutex, Notify, RwLock, broadcast},
    task::JoinHandle,
};
use ts_rs::TS;
use workspace_utils::{
    process::{
        ProcessTreeJob, configure_tokio_command_no_window, group_spawn_no_window_with_job,
        new_hidden_tokio_command,
    },
    shell::refresh_process_path,
};

use crate::{
    ids::{AgentSessionId, AgentTerminalId},
    shell_flavor::{ShellFamily, classify_shell_family, shell_basename},
};

const DEFAULT_OUTPUT_BYTE_LIMIT: usize = 512 * 1024;
const HARD_OUTPUT_BYTE_LIMIT: usize = 16 * 1024 * 1024;
const MAX_LINE_BOUNDARY_SEARCH: usize = 8 * 1024;
const TERMINAL_OUTPUT_BUFFER: usize = 256;

/// One output chunk plus the monotonic cursor a re-attaching viewer uses to
/// tell snapshot overlap from live data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalOutputChunk {
    pub seq: u64,
    pub data: Vec<u8>,
}

struct OutputTap {
    chunks: StdMutex<VecDeque<TerminalOutputChunk>>,
    notify: Notify,
    closed: AtomicBool,
}

impl OutputTap {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            chunks: StdMutex::new(VecDeque::new()),
            notify: Notify::new(),
            closed: AtomicBool::new(false),
        })
    }

    fn push(&self, chunk: TerminalOutputChunk) {
        if self.closed.load(Ordering::Acquire) {
            return;
        }
        let mut chunks = self
            .chunks
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        while chunks.len() >= TERMINAL_OUTPUT_BUFFER {
            chunks.pop_front();
        }
        chunks.push_back(chunk);
        self.notify.notify_waiters();
    }

    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    async fn recv(&self) -> Option<TerminalOutputChunk> {
        loop {
            {
                let mut chunks = self
                    .chunks
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                if let Some(chunk) = chunks.pop_front() {
                    return Some(chunk);
                }
                if self.closed.load(Ordering::Acquire) {
                    return None;
                }
            }
            self.notify.notified().await;
        }
    }
}

/// Live terminal/PTY byte stream. Overflow drops the oldest unread chunk.
pub struct TerminalOutputRx {
    tap: Arc<OutputTap>,
}

impl TerminalOutputRx {
    pub async fn recv(&mut self) -> Option<TerminalOutputChunk> {
        self.tap.recv().await
    }
}

#[derive(Clone)]
pub struct TerminalOutputTx {
    tap: Arc<OutputTap>,
}

impl TerminalOutputTx {
    pub fn pair() -> (Self, TerminalOutputRx) {
        let tap = OutputTap::new();
        (
            Self {
                tap: Arc::clone(&tap),
            },
            TerminalOutputRx { tap },
        )
    }

    pub fn push(&self, chunk: TerminalOutputChunk) {
        self.tap.push(chunk);
    }

    pub fn close(&self) {
        self.tap.close();
    }

    pub fn is_closed(&self) -> bool {
        self.tap.closed.load(Ordering::Acquire)
    }
}

impl Drop for TerminalOutputRx {
    fn drop(&mut self) {
        self.tap.close();
    }
}

fn push_output(subscribers: &mut Vec<TerminalOutputTx>, chunk: TerminalOutputChunk) {
    subscribers.retain(|tx| {
        if tx.is_closed() {
            return false;
        }
        tx.push(chunk.clone());
        true
    });
}

/// Recent output of a live Host terminal plus the cursor it was read at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct HostTerminalSnapshot {
    pub alive: bool,
    pub data: String,
    #[ts(type = "number")]
    pub seq: u64,
}

impl HostTerminalSnapshot {
    pub fn missing() -> Self {
        Self {
            alive: false,
            data: String::new(),
            seq: 0,
        }
    }

    pub fn from_bytes(data: &[u8], seq: u64) -> Self {
        Self {
            alive: true,
            data: BASE64.encode(data),
            seq,
        }
    }
}

/// After the child exits, wait this long for stdout/stderr readers to drain
/// before publishing the exit status. `wait_for_exit` then `terminal/output`
/// otherwise races an empty snapshot.
const READER_DRAIN_GRACE: Duration = Duration::from_millis(200);
/// How long a killed command gets to honor SIGTERM before escalating to SIGKILL.
const KILL_ESCALATE_GRACE: Duration = Duration::from_secs(2);
/// Bound how long `kill_terminal` waits to *report*. The owner keeps reaping.
const KILL_REPORT_BUDGET: Duration = Duration::from_secs(5);
const WAIT_RETRY_MAX_BACKOFF: Duration = Duration::from_secs(1);
const WAIT_ERROR_BUDGET: Duration = Duration::from_secs(30);
const WAIT_ERROR_IDLE_RETRY: Duration = Duration::from_secs(5);

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
    cwd: Option<PathBuf>,
    command: String,
    args: Vec<String>,
    output_history: Arc<Mutex<VecDeque<u8>>>,
    seq: AtomicU64,
    subscribers: Arc<Mutex<Vec<TerminalOutputTx>>>,
    exit_status: Arc<RwLock<Option<AgentTerminalExit>>>,
    exit_notify: Arc<Notify>,
    kill_notify: Arc<Notify>,
    process_job: ProcessTreeJob,
    truncated: Arc<RwLock<bool>>,
    reader_handles: Mutex<Vec<JoinHandle<()>>>,
}

/// Shared Default Terminal selection. User PTY tabs and ACP command-line
/// fallbacks both read this so a settings change is picked up on the next
/// spawn without restarting Agent connections.
#[derive(Clone, Default)]
pub struct TerminalShellRuntimeConfig {
    inner: Arc<RwLock<Option<String>>>,
}

impl TerminalShellRuntimeConfig {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn snapshot(&self) -> Option<String> {
        self.inner.read().await.clone()
    }

    pub async fn set(&self, default_shell: Option<String>) {
        *self.inner.write().await = normalize_configured_shell(default_shell);
    }
}

#[derive(Clone)]
pub struct AgentTerminalRegistry {
    sessions: Arc<RwLock<HashMap<AgentTerminalId, Arc<AgentTerminalSession>>>>,
    lifecycle_tx: broadcast::Sender<AgentTerminalLifecycleEvent>,
    default_shell: TerminalShellRuntimeConfig,
}

impl AgentTerminalRegistry {
    pub fn new() -> Self {
        let (lifecycle_tx, _) = broadcast::channel(256);
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            lifecycle_tx,
            default_shell: TerminalShellRuntimeConfig::new(),
        }
    }

    pub async fn set_default_shell(&self, default_shell: Option<String>) {
        self.default_shell.set(default_shell).await;
    }

    pub async fn default_shell(&self) -> Option<String> {
        self.default_shell.snapshot().await
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

        let fallback_shell = resolve_fallback_shell(self.default_shell.snapshot().await.as_deref());
        let can_retry_through_shell =
            can_retry_command_through_shell(&args.command, &args.args, &fallback_shell);
        let (mut child, process_job) = match group_spawn_no_window_with_job(&mut direct) {
            Ok(spawned) => spawned,
            Err(error) if is_unrunnable_program_error(&error) && can_retry_through_shell => {
                let mut wrapped = shell_wrapped_command(&fallback_shell, &args.command);
                configure_terminal_command(&mut wrapped, args, cwd.as_ref());
                group_spawn_no_window_with_job(&mut wrapped)?
            }
            Err(error) => return Err(error),
        };
        let stdout = child.inner().stdout.take();
        let stderr = child.inner().stderr.take();

        let session = Arc::new(AgentTerminalSession {
            agent_session_id: args.session_id,
            cwd: cwd.clone(),
            command: args.command.clone(),
            args: args.args.clone(),
            output_history: Arc::new(Mutex::new(VecDeque::new())),
            seq: AtomicU64::new(0),
            subscribers: Arc::new(Mutex::new(Vec::new())),
            exit_status: Arc::new(RwLock::new(None)),
            exit_notify: Arc::new(Notify::new()),
            kill_notify: Arc::new(Notify::new()),
            process_job: process_job.clone(),
            truncated: Arc::new(RwLock::new(false)),
            reader_handles: Mutex::new(Vec::new()),
        });

        self.sessions
            .write()
            .await
            .insert(terminal_id, Arc::clone(&session));

        let mut handles: Vec<JoinHandle<()>> = Vec::new();
        if let Some(handle) =
            Self::spawn_reader(stdout, Arc::clone(&session), args.output_byte_limit)
        {
            handles.push(handle);
        }
        if let Some(handle) =
            Self::spawn_reader(stderr, Arc::clone(&session), args.output_byte_limit)
        {
            handles.push(handle);
        }
        if !handles.is_empty() {
            session.reader_handles.lock().await.extend(handles);
        }
        tokio::spawn(own_terminal_process(
            terminal_id,
            Arc::clone(&session),
            child,
            process_job,
            self.lifecycle_tx.clone(),
        ));

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
        reader: Option<impl tokio::io::AsyncRead + Unpin + Send + 'static>,
        session: Arc<AgentTerminalSession>,
        output_byte_limit: Option<u64>,
    ) -> Option<JoinHandle<()>> {
        let mut reader = reader?;
        Some(tokio::spawn(async move {
            let mut buffer = vec![0_u8; 4096];
            loop {
                match reader.read(&mut buffer).await {
                    Ok(0) => break,
                    Ok(count) => {
                        let data = buffer[..count].to_vec();
                        let limit = effective_output_byte_limit(output_byte_limit);
                        let mut was_truncated = false;
                        let seq = session.seq.fetch_add(1, Ordering::AcqRel) + 1;

                        {
                            let mut history = session.output_history.lock().await;
                            history.extend(&data);
                            if trim_output_history(&mut history, limit) {
                                was_truncated = true;
                            }
                        }
                        if was_truncated {
                            *session.truncated.write().await = true;
                        }

                        let mut subscribers = session.subscribers.lock().await;
                        push_output(&mut subscribers, TerminalOutputChunk { seq, data });
                    }
                    Err(_) => break,
                }
            }
        }))
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

    pub async fn subscribe_output(&self, terminal_id: AgentTerminalId) -> Option<TerminalOutputRx> {
        let session = self.sessions.read().await.get(&terminal_id)?.clone();
        let (tx, rx) = TerminalOutputTx::pair();
        session.subscribers.lock().await.push(tx);
        Some(rx)
    }

    pub async fn host_snapshot(
        &self,
        terminal_id: AgentTerminalId,
    ) -> Option<HostTerminalSnapshot> {
        let session = self.sessions.read().await.get(&terminal_id)?.clone();
        let mut history = session.output_history.lock().await;
        let bytes = history.make_contiguous();
        let seq = session.seq.load(Ordering::Acquire);
        Some(HostTerminalSnapshot::from_bytes(bytes, seq))
    }

    pub async fn snapshot_output(
        &self,
        terminal_id: AgentTerminalId,
    ) -> Option<AgentTerminalOutputSnapshot> {
        let session = self.sessions.read().await.get(&terminal_id)?.clone();
        let output = {
            let mut history = session.output_history.lock().await;
            String::from_utf8_lossy(history.make_contiguous()).into_owned()
        };
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
        if session.exit_status.read().await.is_some() {
            return true;
        }
        session.kill_notify.notify_one();
        let _ = tokio::time::timeout(KILL_REPORT_BUDGET, async {
            loop {
                if session.exit_status.read().await.is_some() {
                    break;
                }
                session.exit_notify.notified().await;
            }
        })
        .await;
        true
    }

    pub async fn release_terminal(&self, terminal_id: AgentTerminalId) -> bool {
        let session = self.sessions.write().await.remove(&terminal_id);
        let Some(session) = session else {
            return false;
        };

        self.teardown_released_session(terminal_id, session).await;
        true
    }

    pub async fn release_all_for_session(
        &self,
        session_id: AgentSessionId,
    ) -> Vec<AgentTerminalId> {
        let removed: Vec<(AgentTerminalId, Arc<AgentTerminalSession>)> = {
            let mut sessions = self.sessions.write().await;
            let ids: Vec<AgentTerminalId> = sessions
                .iter()
                .filter(|(_, session)| session.agent_session_id == session_id)
                .map(|(id, _)| *id)
                .collect();
            ids.into_iter()
                .filter_map(|id| sessions.remove(&id).map(|session| (id, session)))
                .collect()
        };
        let ids: Vec<AgentTerminalId> = removed.iter().map(|(id, _)| *id).collect();
        futures::future::join_all(
            removed
                .into_iter()
                .map(|(id, session)| self.teardown_released_session(id, session)),
        )
        .await;
        ids
    }

    pub async fn release_all(&self) {
        let removed: Vec<(AgentTerminalId, Arc<AgentTerminalSession>)> =
            self.sessions.write().await.drain().collect();
        futures::future::join_all(
            removed
                .into_iter()
                .map(|(id, session)| self.teardown_released_session(id, session)),
        )
        .await;
    }

    async fn teardown_released_session(
        &self,
        terminal_id: AgentTerminalId,
        session: Arc<AgentTerminalSession>,
    ) {
        let was_running = session.exit_status.read().await.is_none();
        session.kill_notify.notify_one();
        if was_running {
            let _ = tokio::time::timeout(KILL_REPORT_BUDGET, async {
                loop {
                    if session.exit_status.read().await.is_some() {
                        break;
                    }
                    session.exit_notify.notified().await;
                }
            })
            .await;
            let mut exit_guard = session.exit_status.write().await;
            if exit_guard.is_none() {
                *exit_guard = Some(AgentTerminalExit::Signal {
                    signal: "SIGKILL".to_string(),
                });
                drop(exit_guard);
                session.exit_notify.notify_waiters();
            }
        }
        session.process_job.terminate();
        {
            let mut subscribers = session.subscribers.lock().await;
            for tap in subscribers.drain(..) {
                tap.close();
            }
        }
        let _ = self
            .lifecycle_tx
            .send(AgentTerminalLifecycleEvent::Released { terminal_id });
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

fn trim_output_history(history: &mut VecDeque<u8>, limit: usize) -> bool {
    if history.len() <= limit {
        return false;
    }

    let overflow = history.len() - limit;
    let boundary_search_end = (overflow + MAX_LINE_BOUNDARY_SEARCH).min(history.len());
    let trim_to = history
        .range(overflow..boundary_search_end)
        .position(|byte| matches!(byte, b'\n' | b'\r'))
        .map(|offset| overflow + offset + 1)
        .unwrap_or_else(|| first_utf8_boundary_at_or_after(history, overflow));

    history.drain(..trim_to);
    true
}

fn first_utf8_boundary_at_or_after(bytes: &VecDeque<u8>, index: usize) -> usize {
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

async fn drain_readers(session: &AgentTerminalSession) {
    let handles: Vec<JoinHandle<()>> = std::mem::take(&mut *session.reader_handles.lock().await);
    for handle in handles {
        let abort = handle.abort_handle();
        if tokio::time::timeout(READER_DRAIN_GRACE, handle)
            .await
            .is_err()
        {
            abort.abort();
        }
    }
}

async fn publish_exit(
    terminal_id: AgentTerminalId,
    session: &AgentTerminalSession,
    status: AgentTerminalExit,
    lifecycle_tx: &broadcast::Sender<AgentTerminalLifecycleEvent>,
) {
    drain_readers(session).await;
    *session.exit_status.write().await = Some(status.clone());
    session.exit_notify.notify_waiters();
    let _ = lifecycle_tx.send(AgentTerminalLifecycleEvent::Exited {
        terminal_id,
        exit: status,
    });
}

fn map_exit_status(status: std::process::ExitStatus) -> AgentTerminalExit {
    status
        .code()
        .map(|code| AgentTerminalExit::Code { code })
        .unwrap_or(AgentTerminalExit::Unknown)
}

#[cfg(unix)]
fn is_already_reaped(err: &std::io::Error) -> bool {
    err.raw_os_error() == Some(libc::ECHILD)
}

#[cfg(not(unix))]
fn is_already_reaped(_err: &std::io::Error) -> bool {
    false
}

/// Sole owner of a spawned terminal's `AsyncGroupChild` for the process's whole life.
/// Callers signal kill rather than holding a pid, so every kill runs while this
/// task still holds the un-reaped child and OS `ProcessTreeJob`.
async fn own_terminal_process(
    terminal_id: AgentTerminalId,
    session: Arc<AgentTerminalSession>,
    mut child: AsyncGroupChild,
    process_job: ProcessTreeJob,
    lifecycle_tx: broadcast::Sender<AgentTerminalLifecycleEvent>,
) {
    let pid = child.id();
    let mut escalate_at: Option<tokio::time::Instant> = None;
    let mut kill_requested = false;
    let mut escalated = false;
    let mut backoff = Duration::from_millis(10);
    let mut wait_error_deadline: Option<tokio::time::Instant> = None;
    let mut published_without_reaping = false;

    let exit_status = loop {
        let escalate = async {
            match escalate_at {
                Some(at) => tokio::time::sleep_until(at).await,
                None => std::future::pending::<()>().await,
            }
        };

        tokio::select! {
            reaped = child.wait() => match reaped {
                Ok(status) => break map_exit_status(status),
                Err(err) if is_already_reaped(&err) => {
                    tracing::error!(
                        ?pid,
                        "ACP terminal child was reaped elsewhere; exit status unavailable: {err}"
                    );
                    break AgentTerminalExit::Unknown;
                }
                Err(err) => {
                    tracing::error!(?pid, "failed waiting for ACP terminal process to exit: {err}");
                    process_job.terminate();
                    let _ = child.inner().start_kill();

                    let deadline = *wait_error_deadline
                        .get_or_insert_with(|| tokio::time::Instant::now() + WAIT_ERROR_BUDGET);
                    if !published_without_reaping && tokio::time::Instant::now() >= deadline {
                        published_without_reaping = true;
                        publish_exit(
                            terminal_id,
                            &session,
                            AgentTerminalExit::Unknown,
                            &lifecycle_tx,
                        )
                        .await;
                    }

                    let pause = if published_without_reaping {
                        WAIT_ERROR_IDLE_RETRY
                    } else {
                        backoff = (backoff * 2).min(WAIT_RETRY_MAX_BACKOFF);
                        backoff
                    };
                    tokio::time::sleep(pause).await;
                }
            },
            () = escalate => {
                escalate_at = None;
                escalated = true;
                process_job.terminate();
                let _ = child.inner().start_kill();
            }
            () = session.kill_notify.notified() => {
                if escalated {
                    process_job.terminate();
                    let _ = child.inner().start_kill();
                } else {
                    process_job.signal_graceful();
                    #[cfg(windows)]
                    {
                        let _ = child.start_kill();
                        let _ = child.inner().start_kill();
                    }
                }
                if !kill_requested {
                    kill_requested = true;
                    escalate_at = Some(tokio::time::Instant::now() + KILL_ESCALATE_GRACE);
                }
            }
        }
    };

    if kill_requested {
        process_job.terminate();
    }

    if published_without_reaping {
        return;
    }

    publish_exit(terminal_id, &session, exit_status, &lifecycle_tx).await;
}

fn configure_terminal_command(
    command: &mut tokio::process::Command,
    args: &AgentTerminalCreateRequest,
    cwd: Option<&PathBuf>,
) {
    configure_tokio_command_no_window(command)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false);

    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }

    command.env("PYTHONUTF8", "1");
    command.env("PYTHONIOENCODING", "utf-8");
    command.env("LANG", "C.UTF-8");
    command.env("LC_ALL", "C.UTF-8");

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

fn normalize_configured_shell(default_shell: Option<String>) -> Option<String> {
    default_shell
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Resolve the shell used when an Agent command has to be wrapped.
///
/// An explicit Default Terminal setting wins. Warp is an external app, not a
/// spawnable shell, so it falls back to the platform default. Git Bash is only
/// selected when the setting names bash — it is never auto-detected.
fn resolve_fallback_shell(configured: Option<&str>) -> String {
    let Some(shell) = configured.map(str::trim).filter(|value| !value.is_empty()) else {
        return default_platform_shell();
    };
    if shell_basename(shell) == "warp" {
        return default_platform_shell();
    }
    resolve_named_shell(shell)
}

fn resolve_named_shell(shell: &str) -> String {
    #[cfg(windows)]
    {
        if classify_shell_family(shell) == ShellFamily::Posix
            && shell_basename(shell).contains("bash")
        {
            return prefer_git_bash(windows_git_bash_candidates(), shell);
        }
    }
    shell.to_string()
}

/// Preserve the platform shell used before Default Terminal applied to Agents.
/// General Settings only changes this after an explicit shell selection.
#[cfg(unix)]
fn default_platform_shell() -> String {
    "/bin/sh".to_string()
}

#[cfg(any(windows, test))]
fn prefer_git_bash(git_bash: impl IntoIterator<Item = PathBuf>, requested: &str) -> String {
    git_bash
        .into_iter()
        .find(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| requested.to_string())
}

#[cfg(any(windows, test))]
fn is_wsl_bash(path: &Path) -> bool {
    let normalized = path
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase();
    normalized.ends_with("\\system32\\bash.exe") || normalized.ends_with("\\sysnative\\bash.exe")
}

/// Unset Windows fallback: PowerShell, then cmd / COMSPEC. Never Git Bash.
#[cfg(any(windows, test))]
fn default_windows_platform_shell(
    powershell: impl IntoIterator<Item = PathBuf>,
    cmd: impl IntoIterator<Item = PathBuf>,
    comspec: Option<String>,
) -> String {
    powershell
        .into_iter()
        .chain(cmd)
        .find(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
        .or_else(|| {
            comspec
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| "cmd.exe".to_string())
}

#[cfg(windows)]
fn default_platform_shell() -> String {
    default_windows_platform_shell(
        windows_powershell_candidates(),
        windows_cmd_candidates(),
        std::env::var("COMSPEC").ok(),
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
    configure_tokio_command_no_window(&mut command);
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

/// Publish the Default Terminal setting to the Agent ACP fallback shell.
/// Existing connections pick this up on the next `terminal/create`.
pub async fn apply_configured_terminal_shell(default_shell: Option<String>) {
    agent_terminal_registry()
        .set_default_shell(default_shell)
        .await;
}

pub async fn configured_terminal_shell() -> Option<String> {
    agent_terminal_registry().default_shell().await
}

#[cfg(test)]
mod tests;
