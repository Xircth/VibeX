use std::path::PathBuf;

use db::models::{
    image::TaskImage,
    repo::{Repo, RepoError},
    task::{CreateTask, Task, TaskWithAttemptStatus, UpdateTask},
    workspace::{CreateWorkspace, Workspace},
    workspace_repo::{CreateWorkspaceRepo, WorkspaceRepo},
};
use executors::profile::ExecutorConfig;
use deployment::Deployment;
use executors::profile::ExecutorProfileId;
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
pub async fn get_task(
    state: tauri::State<'_, AppState>,
    task_id: Uuid,
) -> Result<Task, AppError> {
    let task = Task::find_by_id(&state.deployment.db().pool, task_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Task {} not found", task_id)))?;
    Ok(task)
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

    // Create the task
    let task_id = Uuid::new_v4();
    let task = Task::create(pool, &payload.task, task_id).await?;

    if let Some(image_ids) = &payload.task.image_ids {
        TaskImage::associate_many_dedup(pool, task.id, image_ids).await?;
    }

    // Create workspace (attempt)
    let attempt_id = Uuid::new_v4();
    let git_branch_name = state
        .deployment
        .container()
        .git_branch_from_workspace(&attempt_id, &task.title)
        .await;

    // Compute agent_working_dir based on repo count:
    // - Single repo: join repo name with default_working_dir (if set), or just repo name
    // - Multiple repos: use None (agent runs in workspace root)
    let agent_working_dir = if payload.repos.len() == 1 {
        let repo = Repo::find_by_id(pool, payload.repos[0].repo_id)
            .await?
            .ok_or(RepoError::NotFound)?;
        match repo.default_working_dir {
            Some(subdir) => {
                let path = PathBuf::from(&repo.name).join(&subdir);
                Some(path.to_string_lossy().to_string())
            }
            None => Some(repo.name),
        }
    } else {
        None
    };

    let workspace = Workspace::create(
        pool,
        &CreateWorkspace {
            branch: git_branch_name,
            agent_working_dir,
        },
        attempt_id,
        task.id,
    )
    .await?;

    // Create workspace repos
    let workspace_repos: Vec<CreateWorkspaceRepo> = payload
        .repos
        .iter()
        .map(|r| CreateWorkspaceRepo {
            repo_id: r.repo_id,
            target_branch: r.target_branch.clone(),
        })
        .collect();
    WorkspaceRepo::create_many(&state.deployment.db().pool, workspace.id, &workspace_repos)
        .await?;

    // Start the workspace
    let is_attempt_running = state
        .deployment
        .container()
        .start_workspace(&workspace, ExecutorConfig::from(payload.executor_profile_id.clone()))
        .await
        .inspect_err(|err| tracing::error!("Failed to start task attempt: {}", err))
        .is_ok();

    let task = Task::find_by_id(pool, task.id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Task {} not found after creation", task_id)))?;

    tracing::info!("Started attempt for task {}", task.id);

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
pub async fn delete_task(
    state: tauri::State<'_, AppState>,
    task_id: Uuid,
) -> Result<(), AppError> {
    let task = Task::find_by_id(&state.deployment.db().pool, task_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Task {} not found", task_id)))?;

    let pool = &state.deployment.db().pool;

    // Gather task attempts data needed for background cleanup
    let attempts = Workspace::fetch_all(pool, Some(task.id))
        .await
        .map_err(|e| {
            tracing::error!("Failed to fetch task attempts for task {}: {}", task.id, e);
            AppError::Internal(e.to_string())
        })?;

    // Stop any running execution processes before deletion
    for workspace in &attempts {
        state.deployment.container().try_stop(workspace, true).await;
    }

    let repositories = WorkspaceRepo::find_unique_repos_for_task(pool, task.id).await?;

    // Collect workspace directories and branch names that need cleanup
    let workspace_dirs: Vec<PathBuf> = attempts
        .iter()
        .filter_map(|attempt| attempt.container_ref.as_ref().map(PathBuf::from))
        .collect();

    let workspace_branches: Vec<String> = attempts
        .iter()
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
