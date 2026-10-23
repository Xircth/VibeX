use std::path::PathBuf;

use db::models::project::Project;
use uuid::Uuid;

use crate::{error::AppError, state::AppState};

#[derive(serde::Deserialize)]
pub struct OpenEditorRequest {
    pub editor_type: Option<String>,
    pub git_repo_path: Option<PathBuf>,
}

#[derive(Debug, serde::Serialize)]
pub struct OpenEditorResponse {
    pub url: Option<String>,
}

#[tauri::command]
pub async fn open_project_in_editor(
    state: tauri::State<'_, AppState>,
    id: Uuid,
    payload: Option<OpenEditorRequest>,
) -> Result<OpenEditorResponse, AppError> {
    let project = Project::find_by_id(&state.deployment.db().pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Project {} not found", id)))?;

    let path = if let Some(ref req) = payload
        && let Some(ref specified_path) = req.git_repo_path
    {
        specified_path.clone()
    } else {
        let repositories = state
            .deployment
            .project()
            .get_repositories(&state.deployment.db().pool, project.id)
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;

        repositories
            .first()
            .map(|r| r.path.clone())
            .ok_or_else(|| AppError::BadRequest("Project has no repositories".to_string()))?
    };

    let editor_config = {
        let config = state.deployment.config().read().await;
        let editor_type_str = payload.as_ref().and_then(|req| req.editor_type.as_deref());
        config.editor.with_override(editor_type_str)
    };

    match editor_config.open_file(&path).await {
        Ok(url) => {
            tracing::info!(
                "Opened editor for project {} at path: {}{}",
                project.id,
                path.to_string_lossy(),
                if url.is_some() { " (remote mode)" } else { "" }
            );

            Ok(OpenEditorResponse { url })
        }
        Err(e) => {
            tracing::error!("Failed to open editor for project {}: {:?}", project.id, e);
            Err(AppError::Internal(format!("Failed to open editor: {}", e)))
        }
    }
}
