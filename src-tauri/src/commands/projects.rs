use std::path::PathBuf;

use db::models::{
    project::{CreateProject, Project, SearchResult, UpdateProject},
    project_repo::{CreateProjectRepo, ProjectRepo},
    repo::Repo,
};
use services::services::{file_search::SearchQuery, project::ProjectServiceError};
use uuid::Uuid;

use crate::{error::AppError, state::AppState};

#[tauri::command]
pub async fn get_projects(state: tauri::State<'_, AppState>) -> Result<Vec<Project>, AppError> {
    let projects = Project::find_all(&state.deployment.db().pool).await?;
    Ok(projects)
}

#[tauri::command]
pub async fn get_project(state: tauri::State<'_, AppState>, id: Uuid) -> Result<Project, AppError> {
    let project = Project::find_by_id(&state.deployment.db().pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Project {} not found", id)))?;
    Ok(project)
}

#[tauri::command]
pub async fn create_project(
    state: tauri::State<'_, AppState>,
    payload: CreateProject,
) -> Result<Project, AppError> {
    tracing::debug!("Creating project '{}'", payload.name);

    match state
        .deployment
        .project()
        .create_project(
            &state.deployment.db().pool,
            state.deployment.repo(),
            payload,
        )
        .await
    {
        Ok(project) => Ok(project),
        Err(ProjectServiceError::DuplicateGitRepoPath) => Err(AppError::Conflict(
            "Duplicate repository path provided".to_string(),
        )),
        Err(ProjectServiceError::DuplicateRepositoryName) => Err(AppError::Conflict(
            "Duplicate repository name provided".to_string(),
        )),
        Err(ProjectServiceError::PathNotFound(p)) => Err(AppError::BadRequest(format!(
            "The specified path does not exist: {}",
            p.display()
        ))),
        Err(ProjectServiceError::PathNotDirectory(p)) => Err(AppError::BadRequest(format!(
            "The specified path is not a directory: {}",
            p.display()
        ))),
        Err(ProjectServiceError::NotGitRepository(p)) => Err(AppError::BadRequest(format!(
            "The specified directory is not a git repository: {}",
            p.display()
        ))),
        Err(e) => Err(AppError::Internal(e.to_string())),
    }
}

#[tauri::command]
pub async fn update_project(
    state: tauri::State<'_, AppState>,
    id: Uuid,
    payload: UpdateProject,
) -> Result<Project, AppError> {
    let existing = Project::find_by_id(&state.deployment.db().pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Project {} not found", id)))?;

    match state
        .deployment
        .project()
        .update_project(&state.deployment.db().pool, &existing, payload)
        .await
    {
        Ok(project) => Ok(project),
        Err(e) => {
            tracing::error!("Failed to update project: {}", e);
            Err(AppError::Internal(e.to_string()))
        }
    }
}

#[tauri::command]
pub async fn delete_project(state: tauri::State<'_, AppState>, id: Uuid) -> Result<(), AppError> {
    match state
        .deployment
        .project()
        .delete_project(&state.deployment.db().pool, id)
        .await
    {
        Ok(rows_affected) => {
            if rows_affected == 0 {
                Err(AppError::NotFound(format!("Project {} not found", id)))
            } else {
                Ok(())
            }
        }
        Err(e) => {
            tracing::error!("Failed to delete project: {}", e);
            Err(AppError::Internal(e.to_string()))
        }
    }
}

#[tauri::command]
pub async fn search_project_files(
    state: tauri::State<'_, AppState>,
    id: Uuid,
    q: String,
    mode: Option<String>,
) -> Result<Vec<SearchResult>, AppError> {
    if q.trim().is_empty() {
        return Err(AppError::BadRequest(
            "Query parameter 'q' is required and cannot be empty".to_string(),
        ));
    }

    let _project = Project::find_by_id(&state.deployment.db().pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Project {} not found", id)))?;

    let repositories = state
        .deployment
        .project()
        .get_repositories(&state.deployment.db().pool, id)
        .await
        .map_err(|e| {
            tracing::error!("Failed to get repositories: {}", e);
            AppError::Internal(e.to_string())
        })?;

    let search_mode = match mode.as_deref() {
        Some("settings") => services::services::file_search::SearchMode::Settings,
        _ => services::services::file_search::SearchMode::TaskForm,
    };

    let search_query = SearchQuery {
        q,
        mode: search_mode,
    };

    match state
        .deployment
        .project()
        .search_files(state.deployment.file_search(), &repositories, &search_query)
        .await
    {
        Ok(results) => Ok(results),
        Err(e) => {
            tracing::error!("Failed to search files: {}", e);
            Err(AppError::Internal(e.to_string()))
        }
    }
}

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

#[tauri::command]
pub async fn get_project_repositories(
    state: tauri::State<'_, AppState>,
    id: Uuid,
) -> Result<Vec<Repo>, AppError> {
    let _project = Project::find_by_id(&state.deployment.db().pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Project {} not found", id)))?;

    let repositories = state
        .deployment
        .project()
        .get_repositories(&state.deployment.db().pool, id)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(repositories)
}

#[tauri::command]
pub async fn add_project_repository(
    state: tauri::State<'_, AppState>,
    id: Uuid,
    payload: CreateProjectRepo,
) -> Result<Repo, AppError> {
    let project = Project::find_by_id(&state.deployment.db().pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Project {} not found", id)))?;

    tracing::debug!(
        "Adding repository '{}' to project {} (path: {})",
        payload.display_name,
        project.id,
        payload.git_repo_path
    );

    match state
        .deployment
        .project()
        .add_repository(
            &state.deployment.db().pool,
            state.deployment.repo(),
            project.id,
            &payload,
        )
        .await
    {
        Ok(repository) => Ok(repository),
        Err(ProjectServiceError::PathNotFound(p)) => {
            tracing::warn!(
                "Failed to add repository to project {}: path does not exist",
                project.id
            );
            Err(AppError::BadRequest(format!(
                "The specified path does not exist: {}",
                p.display()
            )))
        }
        Err(ProjectServiceError::PathNotDirectory(p)) => {
            tracing::warn!(
                "Failed to add repository to project {}: path is not a directory",
                project.id
            );
            Err(AppError::BadRequest(format!(
                "The specified path is not a directory: {}",
                p.display()
            )))
        }
        Err(ProjectServiceError::NotGitRepository(p)) => {
            tracing::warn!(
                "Failed to add repository to project {}: not a git repository",
                project.id
            );
            Err(AppError::BadRequest(format!(
                "The specified directory is not a git repository: {}",
                p.display()
            )))
        }
        Err(ProjectServiceError::DuplicateRepositoryName) => {
            tracing::warn!(
                "Failed to add repository to project {}: duplicate repository name",
                project.id
            );
            Err(AppError::Conflict(
                "A repository with this name already exists in the project".to_string(),
            ))
        }
        Err(ProjectServiceError::DuplicateGitRepoPath) => {
            tracing::warn!(
                "Failed to add repository to project {}: duplicate repository path",
                project.id
            );
            Err(AppError::Conflict(
                "A repository with this path already exists in the project".to_string(),
            ))
        }
        Err(e) => Err(AppError::Internal(e.to_string())),
    }
}

#[tauri::command]
pub async fn delete_project_repository(
    state: tauri::State<'_, AppState>,
    project_id: Uuid,
    repo_id: Uuid,
) -> Result<(), AppError> {
    tracing::debug!(
        "Removing repository {} from project {}",
        repo_id,
        project_id
    );

    match state
        .deployment
        .project()
        .delete_repository(&state.deployment.db().pool, project_id, repo_id)
        .await
    {
        Ok(()) => Ok(()),
        Err(ProjectServiceError::RepositoryNotFound) => {
            tracing::warn!(
                "Failed to remove repository {} from project {}: not found",
                repo_id,
                project_id
            );
            Err(AppError::NotFound("Repository not found".to_string()))
        }
        Err(e) => Err(AppError::Internal(e.to_string())),
    }
}

#[tauri::command]
pub async fn get_project_repository(
    state: tauri::State<'_, AppState>,
    project_id: Uuid,
    repo_id: Uuid,
) -> Result<ProjectRepo, AppError> {
    match ProjectRepo::find_by_project_and_repo(&state.deployment.db().pool, project_id, repo_id)
        .await
    {
        Ok(Some(project_repo)) => Ok(project_repo),
        Ok(None) => Err(AppError::NotFound(
            "Repository not found in project".to_string(),
        )),
        Err(e) => Err(AppError::Internal(e.to_string())),
    }
}
