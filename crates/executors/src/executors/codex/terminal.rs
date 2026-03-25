use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock},
};

use tokio::sync::{Mutex, RwLock, broadcast, mpsc};
use uuid::Uuid;

const DEFAULT_OUTPUT_BYTE_LIMIT: usize = 512 * 1024;

#[derive(Debug, Clone)]
pub struct CodexTerminalCreateEvent {
    pub session_id: Uuid,
    pub cwd: PathBuf,
    pub command: String,
}

#[derive(Debug, Clone)]
pub enum CodexTerminalLifecycleEvent {
    Created(CodexTerminalCreateEvent),
    Released { session_id: Uuid },
}

#[derive(Debug, Clone)]
struct PendingCommand {
    cwd: PathBuf,
    command: String,
    process_id: Option<String>,
    buffered_output: Vec<u8>,
}

struct CodexTerminalSession {
    cwd: PathBuf,
    command: String,
    output_history: Arc<Mutex<Vec<u8>>>,
    subscribers: Arc<Mutex<Vec<mpsc::UnboundedSender<Vec<u8>>>>>,
}

#[derive(Clone)]
pub struct CodexTerminalRegistry {
    sessions: Arc<RwLock<HashMap<Uuid, Arc<CodexTerminalSession>>>>,
    call_to_session: Arc<RwLock<HashMap<String, Uuid>>>,
    pending_commands: Arc<RwLock<HashMap<String, PendingCommand>>>,
    lifecycle_tx: broadcast::Sender<CodexTerminalLifecycleEvent>,
}

impl CodexTerminalRegistry {
    pub fn new() -> Self {
        let (lifecycle_tx, _) = broadcast::channel(256);
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            call_to_session: Arc::new(RwLock::new(HashMap::new())),
            pending_commands: Arc::new(RwLock::new(HashMap::new())),
            lifecycle_tx,
        }
    }

    pub async fn register_command(
        &self,
        call_id: String,
        cwd: PathBuf,
        command: String,
        process_id: Option<String>,
    ) {
        {
            let mut pending = self.pending_commands.write().await;
            pending.insert(
                call_id.clone(),
                PendingCommand {
                    cwd,
                    command: command.clone(),
                    process_id,
                    buffered_output: Vec::new(),
                },
            );
        }

        if should_capture_terminal_command(&command) {
            let _ = self.create_session_for_call(&call_id).await;
        }
    }

    pub async fn register_terminal_interaction(&self, call_id: &str, process_id: Option<String>) {
        {
            let mut pending = self.pending_commands.write().await;
            if let Some(command) = pending.get_mut(call_id)
                && process_id.is_some()
            {
                command.process_id = process_id;
            }
        }

        let _ = self.create_session_for_call(call_id).await;
    }

    pub async fn append_output(&self, call_id: &str, chunk: &[u8]) {
        if let Some(session_id) = self.call_to_session.read().await.get(call_id).copied()
            && let Some(session) = self.sessions.read().await.get(&session_id).cloned()
        {
            append_output_to_session(session, chunk).await;
            return;
        }

        let mut pending = self.pending_commands.write().await;
        if let Some(command) = pending.get_mut(call_id) {
            append_output_to_buffer(&mut command.buffered_output, chunk);
        }
    }

    pub async fn complete_command(&self, call_id: &str) {
        self.pending_commands.write().await.remove(call_id);

        let session_id = self.call_to_session.write().await.remove(call_id);
        let Some(session_id) = session_id else {
            return;
        };

        if let Some(session) = self.sessions.write().await.remove(&session_id) {
            session.subscribers.lock().await.clear();
        }

        let _ = self
            .lifecycle_tx
            .send(CodexTerminalLifecycleEvent::Released { session_id });
    }

    pub async fn subscribe_output(
        &self,
        session_id: Uuid,
    ) -> Option<mpsc::UnboundedReceiver<Vec<u8>>> {
        let session = self.sessions.read().await.get(&session_id)?.clone();
        let (tx, rx) = mpsc::unbounded_channel();

        let history = session.output_history.lock().await.clone();
        if !history.is_empty() {
            let _ = tx.send(history);
        }

        session.subscribers.lock().await.push(tx);
        Some(rx)
    }

    pub async fn exists(&self, session_id: Uuid) -> bool {
        self.sessions.read().await.contains_key(&session_id)
    }

    pub fn subscribe_lifecycle(&self) -> broadcast::Receiver<CodexTerminalLifecycleEvent> {
        self.lifecycle_tx.subscribe()
    }

    async fn create_session_for_call(&self, call_id: &str) -> Option<Uuid> {
        if let Some(session_id) = self.call_to_session.read().await.get(call_id).copied() {
            return Some(session_id);
        }

        let pending = self.pending_commands.read().await.get(call_id).cloned()?;

        let session_id = Uuid::new_v4();
        let session = Arc::new(CodexTerminalSession {
            cwd: pending.cwd.clone(),
            command: pending.command.clone(),
            output_history: Arc::new(Mutex::new(pending.buffered_output)),
            subscribers: Arc::new(Mutex::new(Vec::new())),
        });

        self.sessions
            .write()
            .await
            .insert(session_id, Arc::clone(&session));
        self.call_to_session
            .write()
            .await
            .insert(call_id.to_string(), session_id);

        let _ = self.lifecycle_tx.send(CodexTerminalLifecycleEvent::Created(
            CodexTerminalCreateEvent {
                session_id,
                cwd: session.cwd.clone(),
                command: session.command.clone(),
            },
        ));

        Some(session_id)
    }
}

impl Default for CodexTerminalRegistry {
    fn default() -> Self {
        Self::new()
    }
}

fn append_output_to_buffer(history: &mut Vec<u8>, chunk: &[u8]) {
    history.extend_from_slice(chunk);
    if history.len() > DEFAULT_OUTPUT_BYTE_LIMIT {
        let overflow = history.len() - DEFAULT_OUTPUT_BYTE_LIMIT;
        history.drain(..overflow);
    }
}

async fn append_output_to_session(session: Arc<CodexTerminalSession>, chunk: &[u8]) {
    {
        let mut history = session.output_history.lock().await;
        append_output_to_buffer(&mut history, chunk);
    }

    let chunk = chunk.to_vec();
    let mut subscribers = session.subscribers.lock().await;
    subscribers.retain(|subscriber| subscriber.send(chunk.clone()).is_ok());
}

fn first_command_token(command: &str) -> Option<&str> {
    let command = command.trim();
    if command.is_empty() {
        return None;
    }

    let mut chars = command.char_indices();
    let (_, first_char) = chars.next()?;
    if first_char == '"' || first_char == '\'' {
        let closing_quote = chars.find_map(|(index, ch)| (ch == first_char).then_some(index))?;
        return Some(&command[1..closing_quote]);
    }

    let end = command
        .char_indices()
        .find_map(|(index, ch)| ch.is_whitespace().then_some(index))
        .unwrap_or(command.len());
    Some(&command[..end])
}

pub fn terminal_display_name(command: &str) -> Option<&'static str> {
    let token = first_command_token(command)?;
    let base = Path::new(token)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(token)
        .to_ascii_lowercase();

    match base.as_str() {
        "powershell" | "powershell.exe" => Some("PowerShell"),
        "pwsh" | "pwsh.exe" => Some("PowerShell"),
        "cmd" | "cmd.exe" => Some("Command Prompt"),
        "wt" | "wt.exe" | "windowsterminal" => Some("Windows Terminal"),
        "bash" | "bash.exe" => Some("Bash"),
        "sh" | "sh.exe" => Some("Shell"),
        "zsh" | "zsh.exe" => Some("Zsh"),
        "fish" | "fish.exe" => Some("Fish"),
        _ => None,
    }
}

fn should_capture_terminal_command(command: &str) -> bool {
    terminal_display_name(command).is_some()
}

static CODEX_TERMINAL_REGISTRY: LazyLock<CodexTerminalRegistry> =
    LazyLock::new(CodexTerminalRegistry::new);

pub fn codex_terminal_registry() -> &'static CodexTerminalRegistry {
    &CODEX_TERMINAL_REGISTRY
}

#[cfg(test)]
mod tests {
    use super::{should_capture_terminal_command, terminal_display_name};

    #[test]
    fn detects_terminal_commands_by_absolute_windows_path() {
        assert!(should_capture_terminal_command(
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo"
        ));
        assert_eq!(
            terminal_display_name(
                r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo"
            ),
            Some("PowerShell")
        );
    }

    #[test]
    fn ignores_non_terminal_commands() {
        assert!(!should_capture_terminal_command("git status"));
        assert_eq!(terminal_display_name("git status"), None);
    }
}
