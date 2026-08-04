use db::models::{project::Project, workspace::Workspace};
use serde::Serialize;
use services::services::worktree_settings::{
    ProjectWorktreeSettings, load_project_settings, save_project_settings, should_prompt_cleanup,
};
use uuid::Uuid;

use crate::{error::AppError, state::AppState};

async fn require_project(state: &AppState, project_id: Uuid) -> Result<(), AppError> {
    Project::find_by_id(&state.deployment.db().pool, project_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Project {project_id} not found")))?;
    Ok(())
}

#[tauri::command]
pub async fn get_project_worktree_settings(
    state: tauri::State<'_, AppState>,
    project_id: Uuid,
) -> Result<ProjectWorktreeSettings, AppError> {
    require_project(state.inner(), project_id).await?;
    load_project_settings(&utils::assets::settings_path(), project_id)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))
}

#[tauri::command]
pub async fn update_project_worktree_settings(
    state: tauri::State<'_, AppState>,
    project_id: Uuid,
    settings: ProjectWorktreeSettings,
) -> Result<ProjectWorktreeSettings, AppError> {
    require_project(state.inner(), project_id).await?;
    if settings.cleanup_prompt_enabled && settings.cleanup_prompt_threshold == 0 {
        return Err(AppError::BadRequest(
            "Worktree cleanup threshold must be at least 1".to_string(),
        ));
    }

    save_project_settings(&utils::assets::settings_path(), project_id, settings)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct WorktreeCleanupStatus {
    pub current_count: usize,
    pub threshold: u32,
    pub should_prompt: bool,
}

#[tauri::command]
pub async fn get_worktree_cleanup_status(
    state: tauri::State<'_, AppState>,
    project_id: Uuid,
) -> Result<WorktreeCleanupStatus, AppError> {
    require_project(state.inner(), project_id).await?;
    let settings = load_project_settings(&utils::assets::settings_path(), project_id)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;
    let workspaces =
        Workspace::fetch_by_project_id(&state.deployment.db().pool, project_id).await?;
    let current_count = workspaces
        .iter()
        .filter(|workspace| {
            workspace.use_worktree
                && workspace
                    .container_ref
                    .as_deref()
                    .is_some_and(|path| std::path::Path::new(path).exists())
        })
        .count();
    Ok(WorktreeCleanupStatus {
        current_count,
        threshold: settings.cleanup_prompt_threshold,
        should_prompt: should_prompt_cleanup(&settings, current_count),
    })
}

#[tauri::command]
pub fn get_settings_file_path() -> String {
    utils::assets::settings_path().to_string_lossy().to_string()
}
