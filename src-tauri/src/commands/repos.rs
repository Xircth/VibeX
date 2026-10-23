use uuid::Uuid;

use crate::{
    commands::projects::{OpenEditorRequest, OpenEditorResponse},
    error::AppError,
    state::AppState,
};

#[tauri::command]
pub async fn open_repo_in_editor(
    state: tauri::State<'_, AppState>,
    repo_id: Uuid,
    payload: Option<OpenEditorRequest>,
) -> Result<OpenEditorResponse, AppError> {
    let repo = state
        .deployment
        .repo()
        .get_by_id(&state.deployment.db().pool, repo_id)
        .await?;

    let editor_config = {
        let config = state.deployment.config().read().await;
        let editor_type_str = payload.as_ref().and_then(|req| req.editor_type.as_deref());
        config.editor.with_override(editor_type_str)
    };

    match editor_config.open_file(&repo.path).await {
        Ok(url) => {
            tracing::info!(
                "Opened editor for repo {} at path: {}{}",
                repo_id,
                repo.path.to_string_lossy(),
                if url.is_some() { " (remote mode)" } else { "" }
            );
            Ok(OpenEditorResponse { url })
        }
        Err(e) => {
            tracing::error!("Failed to open editor for repo {}: {:?}", repo_id, e);
            Err(AppError::Internal(format!("Failed to open editor: {}", e)))
        }
    }
}
