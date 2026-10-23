use std::{
    path::{Path, PathBuf},
    process::Command,
};

use db::models::{workspace::Workspace, workspace_repo::WorkspaceRepo};
use tauri::State;
use uuid::Uuid;

use crate::{
    error::AppError, state::AppState, workspace_paths::resolve_workspace_default_open_path,
};

async fn resolve_terminal_working_dir(
    state: &AppState,
    workspace_id: Uuid,
) -> Result<PathBuf, AppError> {
    let pool = &state.deployment.db().pool;

    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Workspace not found".to_string()))?;

    let container_ref = state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let workspace_repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let working_dir =
        resolve_workspace_default_open_path(&workspace, &container_ref, &workspace_repos);
    if !working_dir.exists() {
        return Err(AppError::NotFound(
            "Workspace directory does not exist".to_string(),
        ));
    }

    Ok(working_dir)
}

#[tauri::command]
pub async fn open_external_terminal(
    state: State<'_, AppState>,
    workspace_id: Uuid,
    terminal_app: String,
) -> Result<(), AppError> {
    let working_dir = resolve_terminal_working_dir(&state, workspace_id).await?;
    let app = terminal_app.trim().to_ascii_lowercase();

    #[cfg(target_os = "macos")]
    {
        match app.as_str() {
            "terminal" => {
                Command::new("open")
                    .arg("-a")
                    .arg("Terminal")
                    .arg(&working_dir)
                    .spawn()
                    .map_err(|err| {
                        AppError::Internal(format!("Failed to launch Terminal: {err}"))
                    })?;
            }
            "iterm2" | "iterm" => {
                Command::new("open")
                    .arg("-a")
                    .arg("iTerm")
                    .arg(&working_dir)
                    .spawn()
                    .map_err(|err| AppError::Internal(format!("Failed to launch iTerm2: {err}")))?;
            }
            "ghostty" => {
                Command::new("open")
                    .arg("-a")
                    .arg("Ghostty")
                    .arg(&working_dir)
                    .spawn()
                    .map_err(|err| {
                        AppError::Internal(format!("Failed to launch Ghostty: {err}"))
                    })?;
            }
            "warp" => {
                open_warp_terminal(&working_dir)?;
            }
            other => {
                return Err(AppError::BadRequest(format!(
                    "Unsupported terminal app: {other}"
                )));
            }
        }
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        match app.as_str() {
            "terminal" | "wt" => {
                Command::new("wt")
                    .arg("-d")
                    .arg(&working_dir)
                    .spawn()
                    .map_err(|err| {
                        AppError::Internal(format!("Failed to launch Windows Terminal: {err}"))
                    })?;
            }
            "ghostty" => {
                Command::new("ghostty")
                    .current_dir(&working_dir)
                    .spawn()
                    .map_err(|err| {
                        AppError::Internal(format!("Failed to launch Ghostty: {err}"))
                    })?;
            }
            "warp" => {
                open_warp_terminal(&working_dir)?;
            }
            other => {
                return Err(AppError::BadRequest(format!(
                    "Unsupported terminal app: {other}"
                )));
            }
        }
        Ok(())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        match app.as_str() {
            "terminal" => {
                Command::new("x-terminal-emulator")
                    .current_dir(&working_dir)
                    .spawn()
                    .map_err(|err| {
                        AppError::Internal(format!("Failed to launch terminal: {err}"))
                    })?;
            }
            "ghostty" => {
                Command::new("ghostty")
                    .current_dir(&working_dir)
                    .spawn()
                    .map_err(|err| {
                        AppError::Internal(format!("Failed to launch Ghostty: {err}"))
                    })?;
            }
            "warp" => {
                open_warp_terminal(&working_dir)?;
            }
            other => {
                return Err(AppError::BadRequest(format!(
                    "Unsupported terminal app: {other}"
                )));
            }
        }
        Ok(())
    }
}

fn open_warp_terminal(working_dir: &Path) -> Result<(), AppError> {
    let encoded_path = percent_encode_query_component(&working_dir.to_string_lossy());
    let warp_uri = format!("warp://action/new_window?path={encoded_path}");

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&warp_uri)
            .spawn()
            .map_err(|err| AppError::Internal(format!("Failed to launch Warp: {err}")))?;
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", &warp_uri])
            .spawn()
            .map_err(|err| AppError::Internal(format!("Failed to launch Warp: {err}")))?;
        Ok(())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&warp_uri)
            .spawn()
            .map_err(|err| AppError::Internal(format!("Failed to launch Warp: {err}")))?;
        Ok(())
    }
}

fn percent_encode_query_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        let is_unreserved =
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'/');
        if is_unreserved {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::percent_encode_query_component;

    #[test]
    fn encodes_warp_query_paths() {
        assert_eq!(
            percent_encode_query_component("/Users/demo/My Project#1"),
            "/Users/demo/My%20Project%231"
        );
    }
}
