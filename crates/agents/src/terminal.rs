use std::{
    collections::HashMap,
    path::PathBuf,
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
const MAX_LINE_BOUNDARY_SEARCH: usize = 8 * 1024;

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
    Released { terminal_id: AgentTerminalId },
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
        let _ = refresh_process_path().await;
        let terminal_id = AgentTerminalId::new();
        let cwd = args.cwd.as_ref().map(PathBuf::from);
        let mut command = new_hidden_tokio_command(PathBuf::from(&args.command), &args.args);
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(false);

        if let Some(cwd) = &cwd {
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

        let mut child = command.spawn()?;
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
        self.spawn_waiter(Arc::clone(&session));

        let _ =
            self.lifecycle_tx
                .send(AgentTerminalLifecycleEvent::Created(AgentTerminalCreateEvent {
                    terminal_id,
                    session_id: args.session_id,
                    cwd,
                    command: args.command.clone(),
                    args: args.args.clone(),
                }));

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
                        let limit = output_byte_limit
                            .map(|value| value as usize)
                            .unwrap_or(DEFAULT_OUTPUT_BYTE_LIMIT);
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

    fn spawn_waiter(&self, session: Arc<AgentTerminalSession>) {
        tokio::spawn(async move {
            let wait_result = {
                let mut child = session.child.lock().await;
                child.wait().await
            };

            let status = match wait_result {
                Ok(exit_status) => exit_status
                    .code()
                    .map(|code| AgentTerminalExit::Code { code })
                    .or(Some(AgentTerminalExit::Unknown)),
                Err(_) => Some(AgentTerminalExit::Unknown),
            };

            *session.exit_status.write().await = status;
            session.exit_notify.notify_waiters();
        });
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

static AGENT_TERMINAL_REGISTRY: LazyLock<AgentTerminalRegistry> =
    LazyLock::new(AgentTerminalRegistry::new);

pub fn agent_terminal_registry() -> &'static AgentTerminalRegistry {
    &AGENT_TERMINAL_REGISTRY
}

#[cfg(test)]
mod tests {
    use super::{DEFAULT_OUTPUT_BYTE_LIMIT, is_utf8_boundary_byte, trim_output_history};

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
