use std::path::PathBuf;

use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use db::models::{workspace::Workspace, workspace_repo::WorkspaceRepo};
use deployment::Deployment;
use executors::executors::{acp::acp_terminal_registry, codex::codex_terminal_registry};
use tauri::Emitter;
use uuid::Uuid;

use crate::{error::AppError, state::AppState};

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
    let pool = &state.deployment.db().pool;
    let cols = cols.unwrap_or(80);
    let rows = rows.unwrap_or(24);

    // Find workspace
    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;

    // Get working directory from container_ref
    let container_ref = workspace
        .container_ref
        .ok_or_else(|| AppError::BadRequest("Workspace has no workspace directory".to_string()))?;

    let base_dir = PathBuf::from(&container_ref);
    if !base_dir.exists() {
        return Err(AppError::BadRequest(
            "Workspace directory does not exist".to_string(),
        ));
    }

    // Determine actual working dir: if only one repo, enter repo subdirectory
    let mut working_dir = base_dir.clone();
    match WorkspaceRepo::find_repos_for_workspace(pool, workspace_id).await {
        Ok(repos) if repos.len() == 1 => {
            let repo_dir = if workspace.use_worktree {
                base_dir.join(&repos[0].name)
            } else {
                base_dir.clone()
            };
            if repo_dir.exists() {
                working_dir = repo_dir;
            }
        }
        Ok(_) => {}
        Err(e) => {
            tracing::warn!(
                "Failed to resolve repos for workspace {}: {}",
                workspace_id,
                e
            );
        }
    }

    // Create PTY session
    let (session_id, output_rx) = state
        .deployment
        .pty()
        .create_session(working_dir, cols, rows, shell, session_id)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    // Start background task: PTY output -> Tauri event
    spawn_terminal_output_bridge(app, session_id, output_rx);

    Ok(session_id)
}

/// Attach to an existing terminal PTY session and replay buffered output.
#[tauri::command]
pub async fn attach_terminal(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    session_id: Uuid,
) -> Result<Uuid, AppError> {
    if state.deployment.pty().session_exists(&session_id) {
        let output_rx = state
            .deployment
            .pty()
            .subscribe_output(session_id)
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;
        spawn_terminal_output_bridge(app, session_id, output_rx);
        return Ok(session_id);
    }

    if let Some(output_rx) = codex_terminal_registry().subscribe_output(session_id).await {
        spawn_terminal_output_bridge(app, session_id, output_rx);
        return Ok(session_id);
    }

    let output_rx = acp_terminal_registry()
        .subscribe_output(session_id)
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
    if acp_terminal_registry().exists(session_id).await
        || codex_terminal_registry().exists(session_id).await
    {
        return Err(AppError::BadRequest(
            "Agent terminal is read-only in the embedded terminal panel".to_string(),
        ));
    }

    let bytes = BASE64
        .decode(&data)
        .map_err(|e| AppError::BadRequest(format!("Invalid base64: {}", e)))?;
    state
        .deployment
        .pty()
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
    if acp_terminal_registry().exists(session_id).await
        || codex_terminal_registry().exists(session_id).await
    {
        return Ok(());
    }

    state
        .deployment
        .pty()
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
    if acp_terminal_registry().exists(session_id).await
        || codex_terminal_registry().exists(session_id).await
    {
        return Ok(());
    }

    state
        .deployment
        .pty()
        .close_session(session_id)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(())
}
