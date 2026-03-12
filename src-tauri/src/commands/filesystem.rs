use deployment::Deployment;
use services::services::filesystem::{DirectoryEntry, DirectoryListResponse};

use crate::{error::AppError, state::AppState};

#[tauri::command]
pub async fn list_directory(
    state: tauri::State<'_, AppState>,
    path: Option<String>,
) -> Result<DirectoryListResponse, AppError> {
    state
        .deployment
        .filesystem()
        .list_directory(path)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command]
pub async fn list_git_repos(
    state: tauri::State<'_, AppState>,
    path: Option<String>,
) -> Result<Vec<DirectoryEntry>, AppError> {
    let res = if let Some(ref p) = path {
        state
            .deployment
            .filesystem()
            .list_git_repos(Some(p.clone()), 800, 1200, Some(3))
            .await
    } else {
        state
            .deployment
            .filesystem()
            .list_common_git_repos(800, 1200, Some(4))
            .await
    };
    res.map_err(|e| AppError::Internal(e.to_string()))
}
