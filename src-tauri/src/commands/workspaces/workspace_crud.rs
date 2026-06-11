use std::path::PathBuf;

use db::models::{
    execution_process::{ExecutionProcess, ExecutionProcessStatus},
    repo::{Repo, RepoError},
    task::Task,
    workspace::{CreateWorkspace, Workspace},
    workspace_repo::{CreateWorkspaceRepo, WorkspaceRepo},
};
use deployment::Deployment;
use executors::profile::ExecutorConfig;
use git::GitService;
use services::services::{container::ContainerService, workspace_manager::WorkspaceManager};
use uuid::Uuid;

use super::{
    CreateWorkspaceRequest, UpdateWorkspaceRequest,
    workspace_sync::{
        recover_workspace_container_ref, sync_project_workspaces_from_local_worktrees,
    },
};
use crate::{error::AppError, state::AppState};

#[tauri::command]
pub async fn get_workspaces(
    state: tauri::State<'_, AppState>,
    task_id: Option<Uuid>,
) -> Result<Vec<Workspace>, AppError> {
    let pool = &state.deployment.db().pool;
    let mut workspaces = Workspace::fetch_all(pool, task_id).await?;
    for workspace in &mut workspaces {
        recover_workspace_container_ref(&state, workspace).await?;
    }
    Ok(workspaces)
}

#[tauri::command]
pub async fn get_project_workspaces(
    state: tauri::State<'_, AppState>,
    project_id: Uuid,
) -> Result<Vec<Workspace>, AppError> {
    sync_project_workspaces_from_local_worktrees(&state, project_id).await?;
    let pool = &state.deployment.db().pool;
    let mut workspaces = Workspace::fetch_by_project_id(pool, project_id).await?;
    for workspace in &mut workspaces {
        recover_workspace_container_ref(&state, workspace).await?;
    }
    Ok(workspaces)
}

#[tauri::command]
pub async fn get_workspace(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<Workspace, AppError> {
    let pool = &state.deployment.db().pool;
    let mut workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;
    recover_workspace_container_ref(&state, &mut workspace).await?;
    Ok(workspace)
}

#[tauri::command]
pub async fn get_workspace_count(state: tauri::State<'_, AppState>) -> Result<i64, AppError> {
    let pool = &state.deployment.db().pool;
    let count = Workspace::count_all(pool).await?;
    Ok(count)
}

#[tauri::command]
pub async fn create_workspace(
    state: tauri::State<'_, AppState>,
    payload: CreateWorkspaceRequest,
) -> Result<Workspace, AppError> {
    if payload.repos.is_empty() {
        return Err(AppError::BadRequest(
            "At least one repository is required".to_string(),
        ));
    }

    let pool = &state.deployment.db().pool;

    let task = Task::find_by_id(pool, payload.task_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Task {} not found", payload.task_id)))?;

    // Compute agent_working_dir based on repo count
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

    let attempt_id = Uuid::new_v4();
    let git_branch_name = state
        .deployment
        .container()
        .git_branch_from_workspace(&attempt_id, &task.title)
        .await;

    let workspace = Workspace::create(
        pool,
        &CreateWorkspace {
            project_id: task.project_id,
            parent_workspace_id: task.parent_workspace_id,
            branch: git_branch_name,
            container_ref: None,
            use_worktree: true,
            agent_working_dir,
        },
        attempt_id,
        payload.task_id,
    )
    .await?;

    Workspace::update(pool, workspace.id, None, None, Some(task.title.as_str())).await?;

    let workspace_repos: Vec<CreateWorkspaceRepo> = payload
        .repos
        .iter()
        .map(|r| CreateWorkspaceRepo {
            repo_id: r.repo_id,
            target_branch: r.target_branch.clone(),
        })
        .collect();

    WorkspaceRepo::create_many(pool, workspace.id, &workspace_repos).await?;

    if let Err(err) = state
        .deployment
        .container()
        .start_workspace(
            &workspace,
            ExecutorConfig::from(payload.executor_profile_id.clone()),
        )
        .await
    {
        tracing::error!("Failed to start workspace: {}", err);
    }

    tracing::info!("Created workspace for task {}", task.id);

    Ok(workspace)
}

#[tauri::command]
pub async fn update_workspace(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    payload: UpdateWorkspaceRequest,
) -> Result<Workspace, AppError> {
    let pool = &state.deployment.db().pool;

    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;

    let is_archiving = payload.archived == Some(true) && !workspace.archived;

    Workspace::update(
        pool,
        workspace.id,
        payload.archived,
        payload.pinned,
        payload.name.as_deref(),
    )
    .await?;

    let updated = Workspace::find_by_id(pool, workspace.id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;

    if is_archiving
        && let Err(e) = state
            .deployment
            .container()
            .archive_workspace(workspace.id)
            .await
    {
        tracing::error!("Failed to archive workspace {}: {}", workspace.id, e);
    }

    Ok(updated)
}

#[tauri::command]
pub async fn delete_workspace(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    delete_branches: Option<bool>,
) -> Result<(), AppError> {
    let pool = &state.deployment.db().pool;

    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;

    // Check for running execution processes
    if ExecutionProcess::has_running_non_dev_server_processes_for_workspace(pool, workspace.id)
        .await?
    {
        return Err(AppError::Conflict(
            "Cannot delete workspace while processes are running. Stop all processes first."
                .to_string(),
        ));
    }

    // Stop any running dev servers for this workspace
    let dev_servers =
        ExecutionProcess::find_running_dev_servers_by_workspace(pool, workspace.id).await?;

    for dev_server in dev_servers {
        tracing::info!(
            "Stopping dev server {} before deleting workspace {}",
            dev_server.id,
            workspace.id
        );

        if let Err(e) = state
            .deployment
            .container()
            .stop_execution(&dev_server, ExecutionProcessStatus::Killed)
            .await
        {
            tracing::error!(
                "Failed to stop dev server {} for workspace {}: {}",
                dev_server.id,
                workspace.id,
                e
            );
        }
    }

    // Gather data needed for background cleanup
    let workspace_dir = workspace.container_ref.clone().map(PathBuf::from);
    let repositories = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;

    // Nullify parent_workspace_id for any child tasks before deletion
    let children_affected = Task::nullify_children_by_workspace_id(pool, workspace.id).await?;
    if children_affected > 0 {
        tracing::info!(
            "Nullified {} child task references before deleting workspace {}",
            children_affected,
            workspace.id
        );
    }

    // Delete workspace from database
    let rows_affected = Workspace::delete(pool, workspace.id).await?;
    if rows_affected == 0 {
        return Err(AppError::NotFound(format!(
            "Workspace {} not found",
            workspace_id
        )));
    }

    // Spawn background cleanup task for filesystem resources
    if let Some(workspace_dir) = workspace_dir {
        let workspace_id = workspace.id;
        let should_delete_branches = delete_branches.unwrap_or(false);
        let branch_name = workspace.branch.clone();
        let repo_paths: Vec<PathBuf> = repositories.iter().map(|r| r.path.clone()).collect();

        tokio::spawn(async move {
            tracing::info!(
                "Starting background cleanup for workspace {} at {}",
                workspace_id,
                workspace_dir.display()
            );

            if let Err(e) = WorkspaceManager::cleanup_workspace(&workspace_dir, &repositories).await
            {
                tracing::error!(
                    "Background workspace cleanup failed for {} at {}: {}",
                    workspace_id,
                    workspace_dir.display(),
                    e
                );
            } else {
                tracing::info!(
                    "Background cleanup completed for workspace {}",
                    workspace_id
                );
            }

            if should_delete_branches {
                let git_service = GitService::new();
                for repo_path in repo_paths {
                    match git_service.delete_branch(&repo_path, &branch_name) {
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
        });
    }

    Ok(())
}

#[tauri::command]
pub async fn stop_workspace_execution(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<(), AppError> {
    let pool = &state.deployment.db().pool;

    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;

    state
        .deployment
        .container()
        .try_stop(&workspace, false)
        .await;

    Ok(())
}
