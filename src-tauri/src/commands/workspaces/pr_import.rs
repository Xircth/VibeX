use std::path::PathBuf;

use db::models::{
    execution_process::ExecutionProcessRunReason,
    merge::Merge,
    project_repo::ProjectRepo,
    repo::{Repo, RepoError},
    session::{CreateSession, Session, SessionStatus},
    task::{CreateTask, Task, TaskStatus},
    workspace::{CreateWorkspace, Workspace},
    workspace_repo::{CreateWorkspaceRepo, WorkspaceRepo},
};
use deployment::Deployment;
use git::GitRemote;
use services::services::{container::ContainerService, container_actions, git_host::github::GhCli};
use uuid::Uuid;

use super::{
    CreateFromPrError, CreateFromPrResult, CreateWorkspaceFromPrRequest,
    CreateWorkspaceFromPrResponse,
};
use crate::{error::AppError, state::AppState};

#[tauri::command]
pub async fn create_workspace_from_pr(
    state: tauri::State<'_, AppState>,
    payload: CreateWorkspaceFromPrRequest,
) -> Result<CreateFromPrResult, AppError> {
    let pool = &state.deployment.db().pool;

    let repo = Repo::find_by_id(pool, payload.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    let project_repos = ProjectRepo::find_by_repo_id(pool, payload.repo_id).await?;
    let project_id = match project_repos.first() {
        Some(project_repo) => project_repo.project_id,
        None => {
            tracing::error!(
                "Repo {} is not associated with any project",
                payload.repo_id
            );
            return Ok(CreateFromPrResult {
                response: None,
                error: Some(CreateFromPrError::RepoNotInProject),
            });
        }
    };

    let remote = match payload.remote_name {
        Some(ref name) => GitRemote {
            url: state.deployment.git().get_remote_url(&repo.path, name)?,
            name: name.clone(),
        },
        None => state.deployment.git().get_default_remote(&repo.path)?,
    };

    let target_branch_ref = format!("{}/{}", remote.name, payload.base_branch);

    let task_id = Uuid::new_v4();
    let create_task = CreateTask {
        project_id,
        title: payload.pr_title.clone(),
        description: Some(format!(
            "Created from PR #{}: {}",
            payload.pr_number, payload.pr_url
        )),
        status: Some(TaskStatus::InProgress),
        parent_workspace_id: None,
        image_ids: None,
    };
    let task = Task::create(pool, &create_task, task_id).await?;

    let agent_working_dir = Some(repo.name.clone());

    let workspace_id = Uuid::new_v4();
    let mut workspace = Workspace::create(
        pool,
        &CreateWorkspace {
            project_id: task.project_id,
            parent_workspace_id: task.parent_workspace_id,
            branch: target_branch_ref.clone(),
            container_ref: None,
            use_worktree: true,
            agent_working_dir,
        },
        workspace_id,
        task.id,
    )
    .await?;

    WorkspaceRepo::create_many(
        pool,
        workspace.id,
        &[CreateWorkspaceRepo {
            repo_id: payload.repo_id,
            target_branch: target_branch_ref.clone(),
        }],
    )
    .await?;

    let container_ref = state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;

    workspace.container_ref = Some(container_ref.clone());

    // Use gh pr checkout to fetch and switch to the PR branch
    let worktree_path = workspace
        .repo_path(&repo)
        .unwrap_or_else(|| PathBuf::from(&container_ref));
    match GhCli::new().get_repo_info(&remote.url, &worktree_path) {
        Ok(repo_info) => {
            if let Err(e) = GhCli::new().pr_checkout(
                &worktree_path,
                &repo_info.owner,
                &repo_info.repo_name,
                payload.pr_number,
            ) {
                tracing::error!("Failed to checkout PR branch: {e}");
                return Ok(CreateFromPrResult {
                    response: None,
                    error: Some(CreateFromPrError::BranchFetchFailed {
                        message: e.to_string(),
                    }),
                });
            }
            Workspace::update_branch_name(pool, workspace.id, &payload.head_branch).await?;
            workspace.branch = payload.head_branch.clone();
        }
        Err(e) => {
            tracing::error!(
                "Failed to get repo info for PR checkout (gh CLI may not be installed): {e}"
            );
            return Ok(CreateFromPrResult {
                response: None,
                error: Some(CreateFromPrError::BranchFetchFailed {
                    message: format!("Failed to get repository info: {e}"),
                }),
            });
        }
    }

    Merge::create_pr(
        pool,
        workspace.id,
        payload.repo_id,
        &format!("{}/{}", remote.name, payload.base_branch),
        payload.pr_number,
        &payload.pr_url,
    )
    .await?;

    if payload.run_setup {
        let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
        if let Some(setup_action) = container_actions::setup_actions_for_repos(&repos) {
            let session = Session::create(
                pool,
                &CreateSession {
                    executor: None,
                    task_id: None,
                    name: None,
                    initial_prompt: None,
                    status: Some(SessionStatus::Todo),
                },
                Uuid::new_v4(),
                workspace.id,
            )
            .await?;

            if let Err(e) = state
                .deployment
                .container()
                .start_execution(
                    &workspace,
                    &session,
                    &setup_action,
                    &ExecutionProcessRunReason::SetupScript,
                )
                .await
            {
                tracing::error!("Failed to run setup script: {}", e);
            }
        }
    }

    tracing::info!(
        "Created workspace {} from PR #{} for task {}",
        workspace.id,
        payload.pr_number,
        task.id
    );

    let workspace = Workspace::find_by_id(pool, workspace.id)
        .await?
        .ok_or_else(|| AppError::NotFound("Workspace not found after creation".to_string()))?;

    Ok(CreateFromPrResult {
        response: Some(CreateWorkspaceFromPrResponse { workspace, task }),
        error: None,
    })
}
