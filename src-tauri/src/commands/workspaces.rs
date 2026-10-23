use db::models::{workspace::Workspace, workspace_repo::WorkspaceRepo};
use serde::Serialize;
use uuid::Uuid;

use crate::{
    error::AppError,
    state::AppState,
    workspace_paths::{resolve_workspace_default_open_path, resolve_workspace_repo_root},
};

#[derive(Debug, Serialize)]
pub struct OpenEditorResponse {
    pub url: Option<String>,
}

#[tauri::command]
pub async fn open_workspace_in_editor(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    editor_type: Option<String>,
    file_path: Option<String>,
) -> Result<OpenEditorResponse, AppError> {
    let pool = &state.deployment.db().pool;

    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;

    let container_ref = state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;

    Workspace::touch(pool, workspace.id).await?;

    let workspace_repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let path = if let Some(ref fp) = file_path {
        resolve_workspace_repo_root(&workspace, &container_ref, &workspace_repos).join(fp)
    } else {
        resolve_workspace_default_open_path(&workspace, &container_ref, &workspace_repos)
    };

    let editor_config = {
        let config = state.deployment.config().read().await;
        let editor_type_str = editor_type.as_deref();
        config.editor.with_override(editor_type_str)
    };

    match editor_config.open_file(path.as_path()).await {
        Ok(url) => {
            tracing::info!(
                "Opened editor for workspace {} at path: {}{}",
                workspace.id,
                path.display(),
                if url.is_some() { " (remote mode)" } else { "" }
            );

            Ok(OpenEditorResponse { url })
        }
        Err(e) => {
            tracing::error!(
                "Failed to open editor for workspace {}: {:?}",
                workspace.id,
                e
            );
            Err(AppError::Internal(format!("Failed to open editor: {}", e)))
        }
    }
}
