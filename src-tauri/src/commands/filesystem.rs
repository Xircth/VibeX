use std::path::PathBuf;

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
            .list_git_repos(Some(p.clone()), 2000, 5000, Some(6))
            .await
    } else {
        state
            .deployment
            .filesystem()
            .list_git_repos(None, 6000, 12000, Some(8))
            .await
    };
    res.map_err(|e| AppError::Internal(e.to_string()))
}

/// Grants the webview read access to the given directories so an HTML preview
/// can load its relative assets (stylesheets, scripts, images) through the
/// asset protocol. Scope entries are process-global and additive, so this only
/// ever widens access to directories the user has actually previewed from.
#[tauri::command]
pub async fn allow_preview_asset_scope(
    app: tauri::AppHandle,
    directories: Vec<String>,
) -> Result<(), AppError> {
    use tauri::Manager;

    let scope = app.asset_protocol_scope();

    for directory in directories {
        let path = sanitize_absolute_path(&directory)?;
        if !path.is_dir() {
            // A deleted or unreadable directory must not fail the preview; the
            // page renders without the assets that are out of reach.
            continue;
        }

        scope
            .allow_directory(&path, true)
            .map_err(|error| AppError::Internal(error.to_string()))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn reveal_in_file_manager(path: String) -> Result<(), AppError> {
    let sanitized_path = sanitize_absolute_path(&path)?;

    #[cfg(target_os = "windows")]
    {
        let mut command =
            utils::process::new_hidden_std_command("explorer", std::iter::empty::<&str>());
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
        let mut command =
            utils::process::new_hidden_std_command("open", std::iter::empty::<&str>());
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

        utils::process::new_hidden_std_command("xdg-open", std::iter::empty::<&str>())
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
