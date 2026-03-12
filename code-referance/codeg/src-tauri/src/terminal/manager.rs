use std::collections::HashMap;
use std::io::{Read, Write};
#[cfg(target_os = "windows")]
use std::path::Path;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::Emitter;

use super::error::TerminalError;
use super::types::{TerminalEvent, TerminalInfo};

struct TerminalInstance {
    write_tx: mpsc::Sender<Vec<u8>>,
    master: Box<dyn MasterPty + Send>,
    _child: Box<dyn portable_pty::Child + Send>,
    title: String,
    owner_window_label: String,
}

pub struct TerminalManager {
    terminals: Arc<Mutex<HashMap<String, TerminalInstance>>>,
}

fn resolve_shell() -> String {
    #[cfg(target_os = "windows")]
    {
        if let Ok(shell) = std::env::var("SHELL") {
            let trimmed = shell.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
        if let Ok(comspec) = std::env::var("COMSPEC") {
            let trimmed = comspec.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
        "cmd.exe".to_string()
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
    }
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Copy)]
enum WindowsShellFlavor {
    Cmd,
    PowerShell,
    Posix,
}

#[cfg(target_os = "windows")]
fn detect_windows_shell_flavor(shell: &str) -> WindowsShellFlavor {
    let shell_name = Path::new(shell)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(shell)
        .to_ascii_lowercase();

    if shell_name.contains("pwsh") || shell_name.contains("powershell") {
        WindowsShellFlavor::PowerShell
    } else if shell_name.contains("bash")
        || shell_name.contains("zsh")
        || shell_name.contains("fish")
        || shell_name.ends_with("sh.exe")
    {
        WindowsShellFlavor::Posix
    } else {
        WindowsShellFlavor::Cmd
    }
}

fn configure_shell_command(cmd: &mut CommandBuilder, shell: &str, initial_command: Option<&str>) {
    #[cfg(target_os = "windows")]
    {
        match detect_windows_shell_flavor(shell) {
            WindowsShellFlavor::Cmd => {
                if let Some(command) = initial_command {
                    cmd.env("CODEG_CMD", command);
                    cmd.args(["/D", "/S", "/C", "%CODEG_CMD%"]);
                }
            }
            WindowsShellFlavor::PowerShell => {
                if let Some(command) = initial_command {
                    cmd.env("CODEG_CMD", command);
                    cmd.args([
                        "-NoLogo",
                        "-NoProfile",
                        "-Command",
                        "$ErrorActionPreference = 'Stop'; Invoke-Expression $env:CODEG_CMD",
                    ]);
                } else {
                    cmd.args(["-NoLogo", "-NoProfile"]);
                }
            }
            WindowsShellFlavor::Posix => {
                cmd.env("TERM", "xterm-256color");
                cmd.env("COLORTERM", "truecolor");
                cmd.env("TERM_PROGRAM", "codeg");
                if let Some(command) = initial_command {
                    cmd.env("CODEG_CMD", command);
                    cmd.args(["-l", "-i", "-c", "eval \"$CODEG_CMD\""]);
                } else {
                    cmd.args(["-l", "-i"]);
                }
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = shell;
        // GUI app environments often miss TERM; force a sane terminal type so
        // readline/zle can redraw lines correctly (history navigation, etc.).
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "codeg");
        if let Some(command) = initial_command {
            // Run command and let this PTY session exit when it completes.
            cmd.env("CODEG_CMD", command);
            cmd.args(["-l", "-i", "-c", "eval \"$CODEG_CMD\""]);
        } else {
            cmd.args(["-l", "-i"]);
        }
    }
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            terminals: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn spawn(
        &self,
        working_dir: String,
        owner_window_label: String,
        app_handle: tauri::AppHandle,
        initial_command: Option<String>,
    ) -> Result<String, TerminalError> {
        let pty_system = native_pty_system();

        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;

        let shell = resolve_shell();
        let mut cmd = CommandBuilder::new(&shell);
        configure_shell_command(&mut cmd, &shell, initial_command.as_deref());
        cmd.cwd(&working_dir);

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;

        drop(pair.slave);

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;

        let terminal_id = uuid::Uuid::new_v4().to_string();

        let (write_tx, write_rx) = mpsc::channel::<Vec<u8>>();

        let instance = TerminalInstance {
            write_tx,
            master: pair.master,
            _child: child,
            title: "Terminal".to_string(),
            owner_window_label,
        };

        self.terminals
            .lock()
            .unwrap()
            .insert(terminal_id.clone(), instance);

        // Named writer thread
        let id_for_writer = terminal_id.clone();
        std::thread::Builder::new()
            .name(format!("pty-writer-{}", &terminal_id[..8]))
            .spawn(move || {
                write_loop(writer, write_rx);
            })
            .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;

        // Named reader thread — emits per-terminal events
        let id_for_reader = terminal_id.clone();
        let terminals_ref = self.terminals.clone();
        std::thread::Builder::new()
            .name(format!("pty-reader-{}", &id_for_writer[..8]))
            .spawn(move || {
                read_loop(reader, id_for_reader, &app_handle, &terminals_ref);
            })
            .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;

        Ok(terminal_id)
    }

    pub fn write(&self, terminal_id: &str, data: &[u8]) -> Result<(), TerminalError> {
        let terminals = self.terminals.lock().unwrap();
        let instance = terminals
            .get(terminal_id)
            .ok_or_else(|| TerminalError::NotFound(terminal_id.to_string()))?;
        instance
            .write_tx
            .send(data.to_vec())
            .map_err(|e| TerminalError::WriteFailed(e.to_string()))?;
        Ok(())
    }

    pub fn resize(&self, terminal_id: &str, cols: u16, rows: u16) -> Result<(), TerminalError> {
        let terminals = self.terminals.lock().unwrap();
        let instance = terminals
            .get(terminal_id)
            .ok_or_else(|| TerminalError::NotFound(terminal_id.to_string()))?;
        instance
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| TerminalError::ResizeFailed(e.to_string()))?;
        Ok(())
    }

    pub fn kill(&self, terminal_id: &str) -> Result<(), TerminalError> {
        let mut instance = self
            .terminals
            .lock()
            .unwrap()
            .remove(terminal_id)
            .ok_or_else(|| TerminalError::NotFound(terminal_id.to_string()))?;
        terminate_terminal(&mut instance);
        Ok(())
    }

    pub fn list_with_exit_check(&self, app_handle: Option<&tauri::AppHandle>) -> Vec<TerminalInfo> {
        let mut terminals = self.terminals.lock().unwrap();
        let mut exited_terminal_ids: Vec<String> = Vec::new();

        // Windows ConPTY may not always surface EOF promptly; reconcile exited
        // child processes here so frontend running-state can recover reliably.
        for (id, instance) in terminals.iter_mut() {
            match instance._child.try_wait() {
                Ok(Some(_)) => exited_terminal_ids.push(id.clone()),
                Ok(None) => {}
                Err(err) => {
                    eprintln!(
                        "[TERM] failed to query child status for terminal {}: {}",
                        id, err
                    );
                    exited_terminal_ids.push(id.clone());
                }
            }
        }

        for terminal_id in &exited_terminal_ids {
            terminals.remove(terminal_id);
        }

        let infos = terminals
            .iter()
            .map(|(id, inst)| TerminalInfo {
                id: id.clone(),
                title: inst.title.clone(),
            })
            .collect();

        drop(terminals);

        if let Some(handle) = app_handle {
            for terminal_id in exited_terminal_ids {
                emit_terminal_exit_event(handle, &terminal_id);
            }
        }

        infos
    }

    pub fn kill_by_owner_window(&self, owner_window_label: &str) -> usize {
        let mut instances = {
            let mut terminals = self.terminals.lock().unwrap();
            let ids: Vec<String> = terminals
                .iter()
                .filter_map(|(id, instance)| {
                    if instance.owner_window_label == owner_window_label {
                        Some(id.clone())
                    } else {
                        None
                    }
                })
                .collect();

            let mut removed = Vec::with_capacity(ids.len());
            for id in ids {
                if let Some(instance) = terminals.remove(&id) {
                    removed.push(instance);
                }
            }
            removed
        };

        let killed = instances.len();
        for instance in &mut instances {
            terminate_terminal(instance);
        }
        killed
    }

    pub fn kill_all(&self) -> usize {
        let mut instances: Vec<TerminalInstance> = {
            let mut terminals = self.terminals.lock().unwrap();
            terminals.drain().map(|(_, inst)| inst).collect()
        };
        let killed = instances.len();
        for instance in &mut instances {
            terminate_terminal(instance);
        }
        eprintln!("[TERM] kill_all killed_terminals={}", killed);
        killed
    }
}

fn terminate_terminal(instance: &mut TerminalInstance) {
    let _ = instance._child.kill();
    let _ = instance._child.wait();
}

fn write_loop(mut writer: Box<dyn Write + Send>, rx: mpsc::Receiver<Vec<u8>>) {
    while let Ok(data) = rx.recv() {
        if writer.write_all(&data).is_err() {
            break;
        }
        while let Ok(more) = rx.try_recv() {
            if writer.write_all(&more).is_err() {
                return;
            }
        }
        if writer.flush().is_err() {
            break;
        }
    }
}

fn read_loop(
    mut reader: Box<dyn Read + Send>,
    terminal_id: String,
    app_handle: &tauri::AppHandle,
    terminals: &Arc<Mutex<HashMap<String, TerminalInstance>>>,
) {
    let output_event = format!("terminal://output/{}", terminal_id);
    let mut buf = [0u8; 8192];

    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let data = String::from_utf8_lossy(&buf[..n]).to_string();
                let event = TerminalEvent {
                    terminal_id: terminal_id.clone(),
                    data,
                };
                let _ = app_handle.emit(&output_event, &event);
            }
            Err(_) => break,
        }
    }

    // Terminal exited — remove from map
    terminals.lock().unwrap().remove(&terminal_id);

    emit_terminal_exit_event(app_handle, &terminal_id);
}

fn emit_terminal_exit_event(app_handle: &tauri::AppHandle, terminal_id: &str) {
    let exit_event = format!("terminal://exit/{}", terminal_id);
    let event = TerminalEvent {
        terminal_id: terminal_id.to_string(),
        data: String::new(),
    };
    let _ = app_handle.emit(&exit_event, &event);
}
