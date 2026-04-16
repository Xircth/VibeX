use std::{path::PathBuf, process::Command};

use deployment::Deployment;
use services::services::filesystem::{DirectoryEntry, DirectoryListResponse};

use crate::{error::AppError, state::AppState};

fn sanitize_absolute_path(path: &str) -> Result<PathBuf, AppError> {
    let path_buf = PathBuf::from(path);

    if !path_buf.is_absolute() {
        return Err(AppError::BadRequest(
            "Only absolute paths are accepted".to_string(),
        ));
    }

    Ok(path_buf.canonicalize().unwrap_or(path_buf))
}

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

#[tauri::command]
pub async fn reveal_in_file_manager(path: String) -> Result<(), AppError> {
    let sanitized_path = sanitize_absolute_path(&path)?;

    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("explorer");
        if sanitized_path.is_dir() {
            command.arg(&sanitized_path);
        } else {
            command.arg(format!("/select,{}", sanitized_path.display()));
        }
        command.spawn().map_err(|error| {
            AppError::Internal(format!("Failed to reveal path in File Explorer: {}", error))
        })?;
    }

    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        if sanitized_path.is_dir() {
            command.arg(&sanitized_path);
        } else {
            command.arg("-R").arg(&sanitized_path);
        }
        command.spawn().map_err(|error| {
            AppError::Internal(format!("Failed to reveal path in Finder: {}", error))
        })?;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let parent = sanitized_path
            .parent()
            .map(PathBuf::from)
            .unwrap_or_else(|| sanitized_path.clone());

        Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|error| {
                AppError::Internal(format!(
                    "Failed to reveal path in the file manager: {}",
                    error
                ))
            })?;
    }

    Ok(())
}
