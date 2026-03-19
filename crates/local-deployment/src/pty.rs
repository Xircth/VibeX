use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
};

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use thiserror::Error;
use tokio::sync::mpsc;
use utils::shell::get_interactive_shell;
use uuid::Uuid;

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

struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    output_history: Arc<Mutex<Vec<u8>>>,
    subscribers: Arc<Mutex<Vec<mpsc::UnboundedSender<Vec<u8>>>>>,
    _output_handle: thread::JoinHandle<()>,
    closed: bool,
}

#[derive(Clone)]
pub struct PtyService {
    sessions: Arc<Mutex<HashMap<Uuid, PtySession>>>,
}

impl PtyService {
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
    ) -> Result<(Uuid, mpsc::UnboundedReceiver<Vec<u8>>), PtyError> {
        let session_id = preset_session_id.unwrap_or_else(Uuid::new_v4);
        let (output_tx, output_rx) = mpsc::unbounded_channel();
        let shell = if let Some(ref s) = shell_override {
            std::path::PathBuf::from(s)
        } else {
            get_interactive_shell().await
        };
        let output_history = Arc::new(Mutex::new(Vec::new()));
        let subscribers = Arc::new(Mutex::new(vec![output_tx]));
        let history_for_thread = Arc::clone(&output_history);
        let subscribers_for_thread = Arc::clone(&subscribers);

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

            // Configure shell-specific options
            let shell_name = shell.file_name().and_then(|n| n.to_str()).unwrap_or("");

            if shell_name == "powershell.exe" || shell_name == "pwsh.exe" {
                // PowerShell: use -NoLogo for cleaner startup
                cmd.arg("-NoLogo");
            } else if shell_name == "cmd.exe" {
                // cmd.exe: no special args needed
            } else {
                // Unix shells
                cmd.env("VIBE_ULTRA_TERMINAL", "1");

                if shell_name == "bash" {
                    cmd.env("PROMPT_COMMAND", r#"PS1='$ '; unset PROMPT_COMMAND"#);
                } else if shell_name == "zsh" {
                    // PROMPT is set after spawning
                } else {
                    cmd.env("PS1", "$ ");
                }
            }

            cmd.env("TERM", "xterm-256color");
            cmd.env("COLORTERM", "truecolor");

            let child = pty_pair
                .slave
                .spawn_command(cmd)
                .map_err(|e| PtyError::CreateFailed(e.to_string()))?;

            let mut writer = pty_pair
                .master
                .take_writer()
                .map_err(|e| PtyError::CreateFailed(e.to_string()))?;

            if shell_name == "zsh" {
                let _ = writer.write_all(b" PROMPT='$ '; RPROMPT=''\n");
                let _ = writer.flush();
                let _ = writer.write_all(b"\x0c");
                let _ = writer.flush();
            }

            let mut reader = pty_pair
                .master
                .try_clone_reader()
                .map_err(|e| PtyError::CreateFailed(e.to_string()))?;

            let output_handle = thread::spawn(move || {
                let mut buf = [0u8; 4096];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let chunk = buf[..n].to_vec();

                            if let Ok(mut history) = history_for_thread.lock() {
                                history.extend_from_slice(&chunk);
                                const MAX_HISTORY_BYTES: usize = 512 * 1024;
                                if history.len() > MAX_HISTORY_BYTES {
                                    let overflow = history.len() - MAX_HISTORY_BYTES;
                                    history.drain(..overflow);
                                }
                            }

                            if let Ok(mut subscribers) = subscribers_for_thread.lock() {
                                subscribers
                                    .retain(|subscriber| subscriber.send(chunk.clone()).is_ok());
                            }
                        }
                        Err(_) => break,
                    }
                }
                drop(child);
            });

            Ok::<_, PtyError>((pty_pair.master, writer, output_handle))
        })
        .await
        .map_err(|e| PtyError::CreateFailed(e.to_string()))??;

        let (master, writer, output_handle) = result;

        let session = PtySession {
            writer,
            master,
            output_history,
            subscribers,
            _output_handle: output_handle,
            closed: false,
        };

        self.sessions
            .lock()
            .map_err(|e| PtyError::CreateFailed(e.to_string()))?
            .insert(session_id, session);

        Ok((session_id, output_rx))
    }

    pub async fn subscribe_output(
        &self,
        session_id: Uuid,
    ) -> Result<mpsc::UnboundedReceiver<Vec<u8>>, PtyError> {
        let (tx, rx) = mpsc::unbounded_channel();
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

        if let Ok(history) = session.output_history.lock()
            && !history.is_empty()
        {
            let _ = tx.send(history.clone());
        }

        session
            .subscribers
            .lock()
            .map_err(|e| PtyError::CreateFailed(e.to_string()))?
            .push(tx);

        Ok(rx)
    }

    pub async fn write(&self, session_id: Uuid, data: &[u8]) -> Result<(), PtyError> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|e| PtyError::WriteFailed(e.to_string()))?;
        let session = sessions
            .get_mut(&session_id)
            .ok_or(PtyError::SessionNotFound(session_id))?;

        if session.closed {
            return Err(PtyError::SessionClosed);
        }

        session
            .writer
            .write_all(data)
            .map_err(|e| PtyError::WriteFailed(e.to_string()))?;

        session
            .writer
            .flush()
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
            if let Ok(mut subscribers) = session.subscribers.lock() {
                subscribers.clear();
            }
        }
        Ok(())
    }

    pub fn session_exists(&self, session_id: &Uuid) -> bool {
        self.sessions
            .lock()
            .map(|s| s.contains_key(session_id))
            .unwrap_or(false)
    }
}

impl Default for PtyService {
    fn default() -> Self {
        Self::new()
    }
}
