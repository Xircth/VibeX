#[cfg(all(unix, not(target_os = "macos")))]
use std::path::Path;
use std::{path::PathBuf, process::Command};

use tauri::{AppHandle, Manager};

use crate::error::AppError;

#[tauri::command]
pub async fn allow_preview_asset_scope(app: AppHandle, path: String) -> Result<String, AppError> {
    let target = sanitize_absolute_path(&path)?;
    if !target.is_file() {
        return Err(AppError::NotFound(format!(
            "Preview asset does not exist or is not a file: {}",
            target.display()
        )));
    }

    let canonical = target
        .canonicalize()
        .map_err(|error| AppError::BadRequest(format!("Invalid preview asset path: {error}")))?;
    app.asset_protocol_scope()
        .allow_file(&canonical)
        .map_err(|error| {
            AppError::Internal(format!(
                "Failed to register preview asset with protocol scope: {error}"
            ))
        })?;
    Ok(canonical.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn reveal_in_file_manager(path: String) -> Result<(), AppError> {
    let target = sanitize_absolute_path(&path)?;
    if !target.exists() {
        return Err(AppError::NotFound(format!(
            "Path does not exist: {}",
            target.display()
        )));
    }

    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        if target.is_file() {
            command.arg("-R").arg(&target);
        } else {
            command.arg(&target);
        }
        command
            .spawn()
            .map_err(|err| AppError::Internal(format!("Failed to reveal path in Finder: {err}")))?;
    }

    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("explorer");
        if target.is_file() {
            command.arg(format!("/select,{}", target.display()));
        } else {
            command.arg(&target);
        }
        command.spawn().map_err(|err| {
            AppError::Internal(format!("Failed to reveal path in Explorer: {err}"))
        })?;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let open_target = if target.is_file() {
            target
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| target.clone())
        } else {
            target
        };
        Command::new("xdg-open")
            .arg(open_target)
            .spawn()
            .map_err(|err| {
                AppError::Internal(format!("Failed to reveal path in file manager: {err}"))
            })?;
    }

    Ok(())
}

fn sanitize_absolute_path(path: &str) -> Result<PathBuf, AppError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AppError::BadRequest("Path is required".to_string()));
    }
    let path_buf = PathBuf::from(trimmed);
    if !path_buf.is_absolute() {
        return Err(AppError::BadRequest("Path must be absolute".to_string()));
    }
    Ok(path_buf)
}
