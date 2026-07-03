use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex, mpsc as std_mpsc},
    thread,
};

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use thiserror::Error;
use tokio::sync::mpsc;
use utils::shell::{get_interactive_shell, resolve_executable_path};
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
    input_tx: std_mpsc::Sender<Vec<u8>>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    output_history: Arc<Mutex<Vec<u8>>>,
    subscribers: Arc<Mutex<Vec<mpsc::UnboundedSender<Vec<u8>>>>>,
    _input_handle: thread::JoinHandle<()>,
    _output_handle: thread::JoinHandle<()>,
    closed: bool,
}

#[derive(Clone)]
pub struct PtyService {
    sessions: Arc<Mutex<HashMap<Uuid, PtySession>>>,
}

impl PtyService {
    const MAX_HISTORY_BYTES: usize = 512 * 1024;
    const MAX_LINE_BOUNDARY_SEARCH: usize = 8 * 1024;

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

    fn trim_output_history(history: &mut Vec<u8>) {
        if history.len() <= Self::MAX_HISTORY_BYTES {
            return;
        }

        let overflow = history.len() - Self::MAX_HISTORY_BYTES;
        let boundary_search_end = (overflow + Self::MAX_LINE_BOUNDARY_SEARCH).min(history.len());
        let trim_to = history[overflow..boundary_search_end]
            .iter()
            .position(|byte| matches!(byte, b'\n' | b'\r'))
            .map(|offset| overflow + offset + 1)
            .unwrap_or_else(|| Self::first_utf8_boundary_at_or_after(history, overflow));

        history.drain(..trim_to);
    }

    fn first_utf8_boundary_at_or_after(bytes: &[u8], index: usize) -> usize {
        let mut index = index.min(bytes.len());
        while index < bytes.len() && !Self::is_utf8_boundary_byte(bytes[index]) {
            index += 1;
        }
        index
    }

    fn is_utf8_boundary_byte(byte: u8) -> bool {
        byte & 0b1100_0000 != 0b1000_0000
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
    ) -> Result<(Uuid, mpsc::UnboundedReceiver<Vec<u8>>), PtyError> {
        let session_id = preset_session_id.unwrap_or_else(Uuid::new_v4);
        let (output_tx, output_rx) = mpsc::unbounded_channel();
        let working_dir = Self::normalize_working_dir_for_shell(working_dir);
        let shell = if let Some(shell) = shell_override.as_deref().filter(|value| !value.is_empty())
        {
            resolve_executable_path(shell)
                .await
                .unwrap_or_else(|| PathBuf::from(shell))
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
                cmd.env("VIBEX_TERMINAL", "1");
                if shell_name == "bash" || shell_name == "zsh" {
                    cmd.arg("-l");
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
            let (input_tx, input_rx) = std_mpsc::channel::<Vec<u8>>();
            let input_handle = thread::spawn(move || {
                while let Ok(data) = input_rx.recv() {
                    if writer.write_all(&data).is_err() {
                        break;
                    }
                    if writer.flush().is_err() {
                        break;
                    }
                }
            });

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
                                PtyService::trim_output_history(&mut history);
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

            Ok::<_, PtyError>((pty_pair.master, input_tx, input_handle, output_handle))
        })
        .await
        .map_err(|e| PtyError::CreateFailed(e.to_string()))??;

        let (master, input_tx, input_handle, output_handle) = result;

        let session = PtySession {
            input_tx,
            master,
            output_history,
            subscribers,
            _input_handle: input_handle,
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

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::PtyService;

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
    fn trim_output_history_prefers_line_boundary_after_overflow() {
        let mut history = vec![b'a'; PtyService::MAX_HISTORY_BYTES + 10];
        history[12] = b'\n';

        PtyService::trim_output_history(&mut history);

        assert_eq!(history.len(), PtyService::MAX_HISTORY_BYTES + 10 - 13);
        assert_eq!(history[0], b'a');
    }

    #[test]
    fn trim_output_history_does_not_start_with_utf8_continuation_byte() {
        let mut history = vec![b'a'; PtyService::MAX_HISTORY_BYTES + 4];
        let emoji = [0xe5, 0xa5, 0xbd];
        let start = 2;
        history[start..start + emoji.len()].copy_from_slice(&emoji);

        PtyService::trim_output_history(&mut history);

        assert!(
            history
                .first()
                .is_none_or(|byte| PtyService::is_utf8_boundary_byte(*byte))
        );
    }
}
