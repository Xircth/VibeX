use std::path::PathBuf;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use db::models::{
    image::{Image, TaskImage},
    repo::{Repo, RepoError},
    session::{CreateSession, Session, SessionStatus},
    task::{CreateTask, Task, TaskWithAttemptStatus, UpdateTask},
    workspace::{CreateWorkspace, Workspace},
    workspace_repo::{CreateWorkspaceRepo, WorkspaceRepo},
};
use deployment::Deployment;
use executors::profile::{ExecutorConfig, ExecutorProfileId};
use git::GitService;
use services::services::{container::ContainerService, workspace_manager::WorkspaceManager};
use uuid::Uuid;

use crate::{error::AppError, state::AppState};

// --- Query / Input types ---

#[derive(Debug, serde::Deserialize)]
pub struct WorkspaceRepoInput {
    pub repo_id: Uuid,
    pub target_branch: String,
}

#[derive(Debug, serde::Deserialize)]
pub struct CreateAndStartTaskRequest {
    pub task: CreateTask,
    pub executor_profile_id: ExecutorProfileId,
    pub repos: Vec<WorkspaceRepoInput>,
    #[serde(default = "default_use_worktree")]
    pub use_worktree: bool,
}

#[derive(Debug, serde::Deserialize)]
pub struct UploadImageRequest {
    pub file_name: String,
    pub data_base64: String,
}

#[derive(Debug, serde::Serialize)]
pub struct ImageMetadataResponse {
    pub exists: bool,
    pub file_name: Option<String>,
    pub path: Option<String>,
    pub size_bytes: Option<i64>,
    pub format: Option<String>,
    pub proxy_url: Option<String>,
}

fn image_metadata_response(
    image_service: &services::services::image::ImageService,
    image: Option<Image>,
) -> ImageMetadataResponse {
    if let Some(image) = image {
        let absolute_path = image_service.get_absolute_path(&image);
        ImageMetadataResponse {
            exists: absolute_path.exists(),
            file_name: Some(image.original_name),
            path: Some(absolute_path.to_string_lossy().to_string()),
            size_bytes: Some(image.size_bytes),
            format: image
                .mime_type
                .as_deref()
                .and_then(|mime| mime.split('/').nth(1))
                .map(|value| value.to_string()),
            proxy_url: Some(absolute_path.to_string_lossy().to_string()),
        }
    } else {
        ImageMetadataResponse {
            exists: false,
            file_name: None,
            path: None,
            size_bytes: None,
            format: None,
            proxy_url: None,
        }
    }
}

const fn default_use_worktree() -> bool {
    true
}

fn task_status_to_session_status(status: &db::models::task::TaskStatus) -> SessionStatus {
    match status {
        db::models::task::TaskStatus::Todo => SessionStatus::Todo,
        db::models::task::TaskStatus::InProgress => SessionStatus::InProgress,
        db::models::task::TaskStatus::InReview => SessionStatus::InReview,
        db::models::task::TaskStatus::Done | db::models::task::TaskStatus::Cancelled => {
            SessionStatus::Done
        }
    }
}

// --- Commands ---

#[tauri::command]
pub async fn get_tasks(
    state: tauri::State<'_, AppState>,
    project_id: Uuid,
) -> Result<Vec<TaskWithAttemptStatus>, AppError> {
    let tasks =
        Task::find_by_project_id_with_attempt_status(&state.deployment.db().pool, project_id)
            .await?;
    Ok(tasks)
}

#[tauri::command]
pub async fn get_task(state: tauri::State<'_, AppState>, task_id: Uuid) -> Result<Task, AppError> {
    let task = Task::find_by_id(&state.deployment.db().pool, task_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Task {} not found", task_id)))?;
    Ok(task)
}

#[tauri::command]
pub async fn get_task_images(
    state: tauri::State<'_, AppState>,
    task_id: Uuid,
) -> Result<Vec<Image>, AppError> {
    let _task = Task::find_by_id(&state.deployment.db().pool, task_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Task {} not found", task_id)))?;

    Ok(Image::find_by_task_id(&state.deployment.db().pool, task_id).await?)
}

#[tauri::command]
pub async fn upload_image(
    state: tauri::State<'_, AppState>,
    payload: UploadImageRequest,
) -> Result<Image, AppError> {
    let bytes = STANDARD
        .decode(payload.data_base64.as_bytes())
        .map_err(|e| AppError::BadRequest(format!("Invalid image payload: {}", e)))?;

    state
        .deployment
        .image()
        .store_image(&bytes, &payload.file_name)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command]
pub async fn upload_image_for_task(
    state: tauri::State<'_, AppState>,
    task_id: Uuid,
    payload: UploadImageRequest,
) -> Result<Image, AppError> {
    let task = Task::find_by_id(&state.deployment.db().pool, task_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Task {} not found", task_id)))?;

    let bytes = STANDARD
        .decode(payload.data_base64.as_bytes())
        .map_err(|e| AppError::BadRequest(format!("Invalid image payload: {}", e)))?;

    let image = state
        .deployment
        .image()
        .store_image(&bytes, &payload.file_name)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    TaskImage::associate_many_dedup(&state.deployment.db().pool, task.id, &[image.id]).await?;

    Ok(image)
}

#[tauri::command]
pub async fn upload_image_for_workspace(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    payload: UploadImageRequest,
) -> Result<Image, AppError> {
    let workspace = Workspace::find_by_id(&state.deployment.db().pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;

    let bytes = STANDARD
        .decode(payload.data_base64.as_bytes())
        .map_err(|e| AppError::BadRequest(format!("Invalid image payload: {}", e)))?;

    let image = state
        .deployment
        .image()
        .store_image(&bytes, &payload.file_name)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    TaskImage::associate_many_dedup(&state.deployment.db().pool, workspace.task_id, &[image.id])
        .await?;

    if let Some(container_ref) = &workspace.container_ref {
        let workspace_path = PathBuf::from(container_ref);
        if workspace_path.exists() {
            state
                .deployment
                .image()
                .copy_images_by_task_to_worktree(
                    &workspace_path,
                    workspace.task_id,
                    workspace.agent_working_dir.as_deref(),
                )
                .await
                .map_err(|e| AppError::Internal(e.to_string()))?;
        }
    }

    Ok(image)
}

#[tauri::command]
pub async fn delete_image(
    state: tauri::State<'_, AppState>,
    image_id: Uuid,
) -> Result<(), AppError> {
    state
        .deployment
        .image()
        .delete_image(image_id)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command]
pub async fn get_task_image_metadata(
    state: tauri::State<'_, AppState>,
    task_id: Uuid,
    path: String,
) -> Result<ImageMetadataResponse, AppError> {
    let _task = Task::find_by_id(&state.deployment.db().pool, task_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Task {} not found", task_id)))?;

    let file_name = path
        .strip_prefix(".vibe-images/")
        .unwrap_or(path.as_str())
        .to_string();
    let image = Image::find_by_file_path(&state.deployment.db().pool, &file_name).await?;
    Ok(image_metadata_response(state.deployment.image(), image))
}

#[tauri::command]
pub async fn get_workspace_image_metadata(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    path: String,
) -> Result<ImageMetadataResponse, AppError> {
    let workspace = Workspace::find_by_id(&state.deployment.db().pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;

    let file_name = path
        .strip_prefix(".vibe-images/")
        .unwrap_or(path.as_str())
        .to_string();
    let image = Image::find_by_file_path(&state.deployment.db().pool, &file_name).await?;

    let metadata = image_metadata_response(state.deployment.image(), image);
    if !metadata.exists {
        return Ok(metadata);
    }

    if let Some(container_ref) = &workspace.container_ref {
        let candidate = PathBuf::from(container_ref)
            .join(utils::path::VIBE_IMAGES_DIR)
            .join(&file_name);
        if candidate.exists() {
            return Ok(ImageMetadataResponse {
                exists: true,
                file_name: metadata.file_name,
                path: Some(candidate.to_string_lossy().to_string()),
                size_bytes: metadata.size_bytes,
                format: metadata.format,
                proxy_url: Some(candidate.to_string_lossy().to_string()),
            });
        }
    }

    Ok(metadata)
}

#[tauri::command]
pub async fn create_task(
    state: tauri::State<'_, AppState>,
    payload: CreateTask,
) -> Result<Task, AppError> {
    let id = Uuid::new_v4();

    tracing::debug!(
        "Creating task '{}' in project {}",
        payload.title,
        payload.project_id
    );

    let task = Task::create(&state.deployment.db().pool, &payload, id).await?;

    if let Some(image_ids) = &payload.image_ids {
        TaskImage::associate_many_dedup(&state.deployment.db().pool, task.id, image_ids).await?;
    }

    Ok(task)
}

#[tauri::command]
pub async fn create_task_and_start(
    state: tauri::State<'_, AppState>,
    payload: CreateAndStartTaskRequest,
) -> Result<TaskWithAttemptStatus, AppError> {
    if payload.repos.is_empty() {
        return Err(AppError::BadRequest(
            "At least one repository is required".to_string(),
        ));
    }

    let pool = &state.deployment.db().pool;
    let workspace_repos: Vec<CreateWorkspaceRepo> = payload
        .repos
        .iter()
        .map(|repo| CreateWorkspaceRepo {
            repo_id: repo.repo_id,
            target_branch: repo.target_branch.clone(),
        })
        .collect();

    let primary_repo = if payload.repos.len() == 1 {
        Some(
            Repo::find_by_id(pool, payload.repos[0].repo_id)
                .await?
                .ok_or(RepoError::NotFound)?,
        )
    } else {
        None
    };

    let reusable_workspace_id = if payload.use_worktree {
        None
    } else {
        WorkspaceRepo::find_reusable_non_worktree_workspace_id(
            pool,
            payload.task.project_id,
            &workspace_repos,
        )
        .await?
    };

    if !payload.use_worktree && reusable_workspace_id.is_none() && payload.repos.len() != 1 {
        return Err(AppError::BadRequest(
            "Creating a non-worktree workspace currently requires a single repository unless an existing matching workspace can be reused"
                .to_string(),
        ));
    }

    // Create the task
    let task_id = Uuid::new_v4();
    let task = Task::create(pool, &payload.task, task_id).await?;

    if let Some(image_ids) = &payload.task.image_ids {
        TaskImage::associate_many_dedup(pool, task.id, image_ids).await?;
    }

    let mut workspace_created = false;
    let workspace = if let Some(workspace_id) = reusable_workspace_id {
        Workspace::find_by_id(pool, workspace_id)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?
    } else {
        let attempt_id = Uuid::new_v4();
        let git_branch_name = if payload.use_worktree {
            state
                .deployment
                .container()
                .git_branch_from_workspace(&attempt_id, &task.title)
                .await
        } else {
            let repo = primary_repo.as_ref().ok_or_else(|| {
                AppError::BadRequest(
                    "Opening the current branch without a worktree requires one repository"
                        .to_string(),
                )
            })?;
            state
                .deployment
                .git()
                .get_current_branch(&repo.path)
                .map_err(|e| AppError::Internal(format!("Failed to resolve current branch: {e}")))?
        };

        let agent_working_dir = if payload.repos.len() == 1 {
            let repo = primary_repo.as_ref().ok_or(RepoError::NotFound)?;
            match &repo.default_working_dir {
                Some(subdir) => {
                    if payload.use_worktree {
                        let path = PathBuf::from(&repo.name).join(subdir);
                        Some(path.to_string_lossy().to_string())
                    } else {
                        Some(subdir.clone())
                    }
                }
                None => payload.use_worktree.then(|| repo.name.clone()),
            }
        } else {
            None
        };

        let container_ref = if payload.use_worktree {
            None
        } else {
            Some(
                primary_repo
                    .as_ref()
                    .ok_or(RepoError::NotFound)?
                    .path
                    .to_string_lossy()
                    .to_string(),
            )
        };

        let workspace = Workspace::create(
            pool,
            &CreateWorkspace {
                project_id: task.project_id,
                parent_workspace_id: task.parent_workspace_id,
                branch: git_branch_name,
                container_ref,
                use_worktree: payload.use_worktree,
                agent_working_dir,
            },
            attempt_id,
            task.id,
        )
        .await?;

        WorkspaceRepo::create_many(pool, workspace.id, &workspace_repos).await?;
        Workspace::update(pool, workspace.id, None, None, Some(task.title.as_str())).await?;
        workspace_created = true;

        Workspace::find_by_id(pool, workspace.id)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace.id)))?
    };

    let session = Session::create(
        pool,
        &CreateSession {
            executor: Some(payload.executor_profile_id.executor.to_string()),
            task_id: Some(task.id),
            name: Some(task.title.clone()),
            initial_prompt: task.description.clone(),
            status: Some(task_status_to_session_status(&task.status)),
        },
        Uuid::new_v4(),
        workspace.id,
    )
    .await?;

    // Start the workspace
    let is_attempt_running = state
        .deployment
        .container()
        .start_workspace_with_session(
            &workspace,
            &session,
            ExecutorConfig::from(payload.executor_profile_id.clone()),
        )
        .await
        .inspect_err(|err| tracing::error!("Failed to start task attempt: {}", err))
        .is_ok();

    let task = Task::find_by_id(pool, task.id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Task {} not found after creation", task_id)))?;

    tracing::info!(
        "Started session {} for task {} in workspace {} (created_workspace={})",
        session.id,
        task.id,
        workspace.id,
        workspace_created
    );

    Ok(TaskWithAttemptStatus {
        task,
        has_in_progress_attempt: is_attempt_running,
        last_attempt_failed: false,
        executor: payload.executor_profile_id.executor.to_string(),
    })
}

#[tauri::command]
pub async fn update_task(
    state: tauri::State<'_, AppState>,
    task_id: Uuid,
    payload: UpdateTask,
) -> Result<Task, AppError> {
    let existing_task = Task::find_by_id(&state.deployment.db().pool, task_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Task {} not found", task_id)))?;

    // Use existing values if not provided in update
    let title = payload.title.unwrap_or(existing_task.title);
    let description = match payload.description {
        Some(s) if s.trim().is_empty() => None, // Empty string = clear description
        Some(s) => Some(s),                     // Non-empty string = update description
        None => existing_task.description,      // Field omitted = keep existing
    };
    let status = payload.status.unwrap_or(existing_task.status);
    let parent_workspace_id = payload
        .parent_workspace_id
        .or(existing_task.parent_workspace_id);

    let task = Task::update(
        &state.deployment.db().pool,
        existing_task.id,
        existing_task.project_id,
        title,
        description,
        status,
        parent_workspace_id,
    )
    .await?;

    if let Some(image_ids) = &payload.image_ids {
        TaskImage::delete_by_task_id(&state.deployment.db().pool, task.id).await?;
        TaskImage::associate_many_dedup(&state.deployment.db().pool, task.id, image_ids).await?;
    }

    Ok(task)
}

#[tauri::command]
pub async fn delete_task(state: tauri::State<'_, AppState>, task_id: Uuid) -> Result<(), AppError> {
    let task = Task::find_by_id(&state.deployment.db().pool, task_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Task {} not found", task_id)))?;

    let pool = &state.deployment.db().pool;

    // Gather seed workspaces owned by this task. Reused workspaces are linked
    // through sessions and must not be deleted here.
    let attempts = Workspace::fetch_seed_by_task_id(pool, task.id)
        .await
        .map_err(|e| {
            tracing::error!("Failed to fetch task attempts for task {}: {}", task.id, e);
            AppError::Internal(e.to_string())
        })?;

    let sessions = Session::find_by_task_id(pool, task.id).await?;

    // Stop any running execution processes before deletion
    for workspace in &attempts {
        state.deployment.container().try_stop(workspace, true).await;
    }

    for session in &sessions {
        let belongs_to_seed_workspace = attempts
            .iter()
            .any(|workspace| workspace.id == session.workspace_id);
        if belongs_to_seed_workspace {
            continue;
        }

        if db::models::execution_process::ExecutionProcess::has_running_non_dev_server_processes_for_session(
            pool,
            session.id,
        )
        .await?
        {
            return Err(AppError::Conflict(
                "Cannot delete a task while its linked session is still running".to_string(),
            ));
        }
    }

    let repositories = WorkspaceRepo::find_unique_repos_for_task(pool, task.id).await?;

    // Collect workspace directories and branch names that need cleanup
    let workspace_dirs: Vec<PathBuf> = attempts
        .iter()
        .filter(|attempt| attempt.use_worktree)
        .filter_map(|attempt| attempt.container_ref.as_ref().map(PathBuf::from))
        .collect();

    let workspace_branches: Vec<String> = attempts
        .iter()
        .filter(|attempt| attempt.use_worktree)
        .map(|attempt| attempt.branch.clone())
        .collect();

    // Use a transaction to ensure atomicity
    let mut tx = pool.begin().await?;

    // Nullify parent_workspace_id for all child tasks before deletion
    let mut total_children_affected = 0u64;
    for attempt in &attempts {
        let children_affected =
            Task::nullify_children_by_workspace_id(&mut *tx, attempt.id).await?;
        total_children_affected += children_affected;
    }

    // Delete task from database (FK CASCADE will handle task_attempts)
    let rows_affected = Task::delete(&mut *tx, task.id).await?;

    if rows_affected == 0 {
        return Err(AppError::NotFound(format!("Task {} not found", task_id)));
    }

    // Commit the transaction
    tx.commit().await?;

    if total_children_affected > 0 {
        tracing::info!(
            "Nullified {} child task references before deleting task {}",
            total_children_affected,
            task.id
        );
    }

    // Spawn background cleanup
    let task_id = task.id;
    let pool = pool.clone();
    tokio::spawn(async move {
        tracing::info!(
            "Starting background cleanup for task {} ({} workspaces, {} repos)",
            task_id,
            workspace_dirs.len(),
            repositories.len()
        );

        for workspace_dir in &workspace_dirs {
            if let Err(e) = WorkspaceManager::cleanup_workspace(workspace_dir, &repositories).await
            {
                tracing::error!(
                    "Background workspace cleanup failed for task {} at {}: {}",
                    task_id,
                    workspace_dir.display(),
                    e
                );
            }
        }

        match Repo::delete_orphaned(&pool).await {
            Ok(count) if count > 0 => {
                tracing::info!("Deleted {} orphaned repo records", count);
            }
            Err(e) => {
                tracing::error!("Failed to delete orphaned repos: {}", e);
            }
            _ => {}
        }

        // Clean up git branches for each workspace
        let git_service = GitService::new();
        let repo_paths: Vec<PathBuf> = repositories.iter().map(|r| r.path.clone()).collect();
        for branch_name in &workspace_branches {
            for repo_path in &repo_paths {
                match git_service.delete_branch(repo_path, branch_name) {
                    Ok(()) => {
                        tracing::info!(
                            "Deleted branch '{}' from repo {:?}",
                            branch_name,
                            repo_path
                        );
                    }
                    Err(e) => {
                        tracing::warn!(
                            "Failed to delete branch '{}' from repo {:?}: {}",
                            branch_name,
                            repo_path,
                            e
                        );
                    }
                }
            }
        }

        tracing::info!("Background cleanup completed for task {}", task_id);
    });

    Ok(())
}
