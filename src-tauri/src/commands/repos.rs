use db::models::{
    project::SearchResult,
    repo::{Repo, UpdateRepo},
};
use deployment::Deployment;
use git::{GitBranch, GitRemote};
use services::services::{
    file_search::SearchMode,
    git_host::{GitHostProvider, GitHostService, OpenPrInfo},
};
use uuid::Uuid;

use crate::{
    error::AppError,
    state::AppState,
    commands::projects::{OpenEditorRequest, OpenEditorResponse},
};

#[tauri::command]
pub async fn get_repos(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Repo>, AppError> {
    let repos = Repo::list_all(&state.deployment.db().pool).await?;
    Ok(repos)
}

#[tauri::command]
pub async fn register_repo(
    state: tauri::State<'_, AppState>,
    path: String,
    display_name: Option<String>,
) -> Result<Repo, AppError> {
    let repo = state
        .deployment
        .repo()
        .register(
            &state.deployment.db().pool,
            &path,
            display_name.as_deref(),
        )
        .await?;
    Ok(repo)
}

#[tauri::command]
pub async fn get_recent_repos(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Repo>, AppError> {
    let repos = Repo::list_by_recent_workspace_usage(&state.deployment.db().pool).await?;
    Ok(repos)
}

#[tauri::command]
pub async fn init_repo(
    state: tauri::State<'_, AppState>,
    parent_path: String,
    folder_name: String,
) -> Result<Repo, AppError> {
    let repo = state
        .deployment
        .repo()
        .init_repo(
            &state.deployment.db().pool,
            state.deployment.git(),
            &parent_path,
            &folder_name,
        )
        .await?;
    Ok(repo)
}

#[tauri::command]
pub async fn get_repos_batch(
    state: tauri::State<'_, AppState>,
    ids: Vec<Uuid>,
) -> Result<Vec<Repo>, AppError> {
    let repos = Repo::find_by_ids(&state.deployment.db().pool, &ids).await?;
    Ok(repos)
}

#[tauri::command]
pub async fn get_repo(
    state: tauri::State<'_, AppState>,
    repo_id: Uuid,
) -> Result<Repo, AppError> {
    let repo = state
        .deployment
        .repo()
        .get_by_id(&state.deployment.db().pool, repo_id)
        .await?;
    Ok(repo)
}

#[tauri::command]
pub async fn update_repo(
    state: tauri::State<'_, AppState>,
    repo_id: Uuid,
    payload: UpdateRepo,
) -> Result<Repo, AppError> {
    let repo = Repo::update(&state.deployment.db().pool, repo_id, &payload).await?;
    Ok(repo)
}

#[tauri::command]
pub async fn get_repo_branches(
    state: tauri::State<'_, AppState>,
    repo_id: Uuid,
) -> Result<Vec<GitBranch>, AppError> {
    let repo = state
        .deployment
        .repo()
        .get_by_id(&state.deployment.db().pool, repo_id)
        .await?;
    let branches = state.deployment.git().get_all_branches(&repo.path)?;
    Ok(branches)
}

#[tauri::command]
pub async fn get_repo_remotes(
    state: tauri::State<'_, AppState>,
    repo_id: Uuid,
) -> Result<Vec<GitRemote>, AppError> {
    let repo = state
        .deployment
        .repo()
        .get_by_id(&state.deployment.db().pool, repo_id)
        .await?;
    let remotes = state.deployment.git().list_remotes(&repo.path)?;
    Ok(remotes)
}

#[tauri::command]
pub async fn list_open_prs(
    state: tauri::State<'_, AppState>,
    repo_id: Uuid,
    remote: Option<String>,
) -> Result<Vec<OpenPrInfo>, AppError> {
    let repo = state
        .deployment
        .repo()
        .get_by_id(&state.deployment.db().pool, repo_id)
        .await?;

    let remote = match remote {
        Some(name) => GitRemote {
            url: state.deployment.git().get_remote_url(&repo.path, &name)?,
            name,
        },
        None => state.deployment.git().get_default_remote(&repo.path)?,
    };

    let git_host = GitHostService::from_url(&remote.url)?;
    let prs = git_host.list_open_prs(&repo.path, &remote.url).await?;
    Ok(prs)
}

#[tauri::command]
pub async fn search_repo(
    state: tauri::State<'_, AppState>,
    repo_id: Uuid,
    q: String,
    mode: Option<SearchMode>,
) -> Result<Vec<SearchResult>, AppError> {
    if q.trim().is_empty() {
        return Err(AppError::BadRequest(
            "Query parameter 'q' is required and cannot be empty".to_string(),
        ));
    }

    let repo = state
        .deployment
        .repo()
        .get_by_id(&state.deployment.db().pool, repo_id)
        .await?;

    let search_mode = mode.unwrap_or_default();

    state
        .deployment
        .file_search_cache()
        .search_repo(&repo.path, &q, search_mode)
        .await
        .map_err(|e| {
            tracing::error!("Failed to search files in repo {}: {}", repo_id, e);
            AppError::Internal(format!("Failed to search files: {}", e))
        })
}

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
