use std::path::PathBuf;

use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use db::models::{workspace::Workspace, workspace_repo::WorkspaceRepo};
use deployment::Deployment;
use tauri::Emitter;
use uuid::Uuid;

use crate::{error::AppError, state::AppState};

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
        .ok_or_else(|| {
            AppError::BadRequest("Workspace has no workspace directory".to_string())
        })?;

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
            let repo_dir = base_dir.join(&repos[0].name);
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
    let (session_id, mut output_rx) = state
        .deployment
        .pty()
        .create_session(working_dir, cols, rows, shell)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    // Start background task: PTY output -> Tauri event
    let channel = format!("terminal-output:{}", session_id);
    tokio::spawn(async move {
        while let Some(data) = output_rx.recv().await {
            let encoded = BASE64.encode(&data);
            if app.emit(&channel, &encoded).is_err() {
                break;
            }
        }
    });

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
    state
        .deployment
        .pty()
        .close_session(session_id)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(())
}
