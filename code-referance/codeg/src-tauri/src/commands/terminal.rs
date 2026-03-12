use tauri::State;

use crate::terminal::error::TerminalError;
use crate::terminal::manager::TerminalManager;
use crate::terminal::types::TerminalInfo;

#[tauri::command]
pub fn terminal_spawn(
    working_dir: String,
    initial_command: Option<String>,
    manager: State<'_, TerminalManager>,
    app_handle: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<String, TerminalError> {
    manager.spawn(
        working_dir,
        window.label().to_string(),
        app_handle,
        initial_command,
    )
}

#[tauri::command]
pub fn terminal_write(
    terminal_id: String,
    data: String,
    manager: State<'_, TerminalManager>,
) -> Result<(), TerminalError> {
    manager.write(&terminal_id, data.as_bytes())
}

#[tauri::command]
pub fn terminal_resize(
    terminal_id: String,
    cols: u16,
    rows: u16,
    manager: State<'_, TerminalManager>,
) -> Result<(), TerminalError> {
    manager.resize(&terminal_id, cols, rows)
}

#[tauri::command]
pub fn terminal_kill(
    terminal_id: String,
    manager: State<'_, TerminalManager>,
) -> Result<(), TerminalError> {
    manager.kill(&terminal_id)
}

#[tauri::command]
pub fn terminal_list(
    manager: State<'_, TerminalManager>,
    app_handle: tauri::AppHandle,
) -> Result<Vec<TerminalInfo>, TerminalError> {
    Ok(manager.list_with_exit_check(Some(&app_handle)))
}
