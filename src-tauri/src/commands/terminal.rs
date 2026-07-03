use std::path::{Path, PathBuf};

use agents::{ids::AgentTerminalId, terminal::agent_terminal_registry};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use db::models::{workspace::Workspace, workspace_repo::WorkspaceRepo};
use tauri::Emitter;
use uuid::Uuid;

use crate::{
    error::AppError, state::AppState, workspace_paths::resolve_workspace_default_open_path,
};

fn spawn_terminal_output_bridge(
    app: tauri::AppHandle,
    session_id: Uuid,
    mut output_rx: tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
) {
    let channel = format!("terminal-output:{}", session_id);
    tokio::spawn(async move {
        while let Some(data) = output_rx.recv().await {
            let encoded = BASE64.encode(&data);
            if app.emit(&channel, &encoded).is_err() {
                break;
            }
        }
    });
}

async fn resolve_terminal_working_dir(
    state: &AppState,
    workspace_id: Uuid,
) -> Result<PathBuf, AppError> {
    let pool = &state.deployment.db().pool;
    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;

    let container_ref = state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;

    let base_dir = PathBuf::from(&container_ref);
    if !base_dir.exists() {
        return Err(AppError::BadRequest(
            "Workspace directory does not exist".to_string(),
        ));
    }

    match WorkspaceRepo::find_repos_for_workspace(pool, workspace_id).await {
        Ok(repos) => {
            let candidate = resolve_workspace_default_open_path(&workspace, &container_ref, &repos);
            if candidate.exists() {
                Ok(candidate)
            } else {
                Ok(base_dir)
            }
        }
        Err(e) => {
            tracing::warn!(
                "Failed to resolve repos for workspace {}: {}",
                workspace_id,
                e
            );
            Ok(base_dir)
        }
    }
}

#[cfg(target_os = "macos")]
fn percent_encode_query_component(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(value.len());

    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'/') {
            encoded.push(byte as char);
        } else {
            encoded.push('%');
            encoded.push(HEX[(byte >> 4) as usize] as char);
            encoded.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }

    encoded
}

#[cfg(target_os = "macos")]
fn open_warp_terminal(working_dir: &Path) -> Result<(), AppError> {
    let path = working_dir.to_string_lossy();
    let url = format!(
        "warp://action/new_window?path={}",
        percent_encode_query_component(&path)
    );

    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map_err(|e| AppError::Internal(format!("Failed to open Warp: {e}")))?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn open_warp_terminal(_working_dir: &Path) -> Result<(), AppError> {
    Err(AppError::BadRequest(
        "Warp terminal launch is currently supported on macOS only".to_string(),
    ))
}

/// Create a new terminal PTY session for a workspace.
///
/// Returns the session ID. Terminal output is streamed via
/// Tauri events on channel `terminal-output:{session_id}` as base64-encoded strings.
#[tauri::command]
pub async fn create_terminal(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    cols: Option<u16>,
    rows: Option<u16>,
    shell: Option<String>,
    session_id: Option<Uuid>,
) -> Result<Uuid, AppError> {
    if shell.as_deref() == Some("warp") {
        return Err(AppError::BadRequest(
            "Warp is an external terminal; use open_external_terminal".to_string(),
        ));
    }

    let cols = cols.unwrap_or(80);
    let rows = rows.unwrap_or(24);
    let working_dir = resolve_terminal_working_dir(&state, workspace_id).await?;

    // Create PTY session
    let (session_id, output_rx) = state
        .pty
        .create_session(working_dir, cols, rows, shell, session_id)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    // Start background task: PTY output -> Tauri event
    spawn_terminal_output_bridge(app, session_id, output_rx);

    Ok(session_id)
}

/// Open an external terminal application for a workspace.
#[tauri::command]
pub async fn open_external_terminal(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    terminal: String,
) -> Result<(), AppError> {
    let working_dir = resolve_terminal_working_dir(&state, workspace_id).await?;

    match terminal.as_str() {
        "warp" => open_warp_terminal(&working_dir),
        _ => Err(AppError::BadRequest(format!(
            "Unsupported external terminal: {terminal}"
        ))),
    }
}

/// Attach to an existing terminal PTY session and replay buffered output.
#[tauri::command]
pub async fn attach_terminal(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    session_id: Uuid,
) -> Result<Uuid, AppError> {
    if state.pty.session_exists(&session_id) {
        let output_rx = state
            .pty
            .subscribe_output(session_id)
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;
        spawn_terminal_output_bridge(app, session_id, output_rx);
        return Ok(session_id);
    }

    let output_rx = agent_terminal_registry()
        .subscribe_output(AgentTerminalId(session_id))
        .await
        .ok_or_else(|| AppError::NotFound(format!("Terminal {} not found", session_id)))?;
    spawn_terminal_output_bridge(app, session_id, output_rx);

    Ok(session_id)
}

/// Write data to a terminal PTY session.
///
/// `data` must be base64-encoded bytes.
#[tauri::command]
pub async fn write_terminal(
    state: tauri::State<'_, AppState>,
    session_id: Uuid,
    data: String,
) -> Result<(), AppError> {
    if agent_terminal_registry()
        .exists(AgentTerminalId(session_id))
        .await
    {
        return Err(AppError::BadRequest(
            "Agent terminal is read-only in the embedded terminal panel".to_string(),
        ));
    }

    let bytes = BASE64
        .decode(&data)
        .map_err(|e| AppError::BadRequest(format!("Invalid base64: {}", e)))?;
    state
        .pty
        .write(session_id, &bytes)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(())
}

/// Resize a terminal PTY session.
#[tauri::command]
pub async fn resize_terminal(
    state: tauri::State<'_, AppState>,
    session_id: Uuid,
    cols: u16,
    rows: u16,
) -> Result<(), AppError> {
    if agent_terminal_registry()
        .exists(AgentTerminalId(session_id))
        .await
    {
        return Ok(());
    }

    state
        .pty
        .resize(session_id, cols, rows)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(())
}

/// Close a terminal PTY session.
#[tauri::command]
pub async fn close_terminal(
    state: tauri::State<'_, AppState>,
    session_id: Uuid,
) -> Result<(), AppError> {
    if agent_terminal_registry()
        .exists(AgentTerminalId(session_id))
        .await
    {
        return Ok(());
    }

    state
        .pty
        .close_session(session_id)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    #[test]
    fn warp_path_query_percent_encoding_preserves_path_separators() {
        assert_eq!(
            super::percent_encode_query_component("/Users/sean/My Project/VibeX"),
            "/Users/sean/My%20Project/VibeX"
        );
    }
}
