use std::path::PathBuf;

use db::models::{
    coding_agent_turn::CodingAgentTurn,
    execution_process::{ExecutionProcess, ExecutionProcessRunReason},
    merge::{Merge, MergeStatus},
    repo::{Repo, RepoError},
    session::{CreateSession, Session, SessionStatus},
    task::{Task, TaskStatus},
    workspace::Workspace,
    workspace_repo::WorkspaceRepo,
};
use deployment::Deployment;
use executors::{
    actions::{
        ExecutorAction, ExecutorActionType, coding_agent_follow_up::CodingAgentFollowUpRequest,
        coding_agent_initial::CodingAgentInitialRequest,
    },
    profile::ExecutorConfig,
};
use git::{GitCliError, GitServiceError};
use services::services::{
    config::DEFAULT_PR_DESCRIPTION_PROMPT,
    container::ContainerService,
    git_host::{self, CreatePrRequest, GitHostError, GitHostProvider},
};
use uuid::Uuid;

use super::{
    AttachPrResponse, AttachPrResult, CreatePrResult, GetPrCommentsError, PrCommentsResponse,
    PrCommentsResult, PrError,
};
use crate::{
    error::AppError, state::AppState, workspace_paths::resolve_workspace_agent_working_dir,
};

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_workspace_pr(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    title: String,
    body: Option<String>,
    target_branch: Option<String>,
    draft: Option<bool>,
    repo_id: Uuid,
    auto_generate_description: Option<bool>,
) -> Result<CreatePrResult, AppError> {
    let pool = &state.deployment.db().pool;

    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;

    let workspace_repo = WorkspaceRepo::find_by_workspace_and_repo_id(pool, workspace.id, repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    let repo = Repo::find_by_id(pool, workspace_repo.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    let repo_path = repo.path.clone();
    let target = target_branch.unwrap_or_else(|| workspace_repo.target_branch.clone());

    let container_ref = state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let workspace_path = PathBuf::from(&container_ref);
    let worktree_path = workspace
        .repo_path(&repo)
        .unwrap_or_else(|| workspace_path.clone());

    let git = state.deployment.git();
    let push_remote = git.resolve_remote_for_branch(&repo_path, &workspace.branch)?;

    // Try to get the remote from the branch name
    let (target_remote, base_branch) = match git.get_remote_from_branch_name(&repo_path, &target) {
        Ok(remote) => {
            let branch = target
                .strip_prefix(&format!("{}/", remote.name))
                .unwrap_or(&target);
            (remote, branch.to_string())
        }
        Err(_) => (push_remote.clone(), target.clone()),
    };

    match git.check_remote_branch_exists(&repo_path, &target_remote.url, &base_branch) {
        Ok(false) => {
            return Ok(CreatePrResult {
                url: None,
                error: Some(PrError::TargetBranchNotFound {
                    branch: target.clone(),
                }),
            });
        }
        Err(GitServiceError::GitCLI(GitCliError::AuthFailed(_))) => {
            return Ok(CreatePrResult {
                url: None,
                error: Some(PrError::GitCliNotLoggedIn),
            });
        }
        Err(GitServiceError::GitCLI(GitCliError::NotAvailable)) => {
            return Ok(CreatePrResult {
                url: None,
                error: Some(PrError::GitCliNotInstalled),
            });
        }
        Err(e) => return Err(AppError::from(e)),
        Ok(true) => {}
    }

    if let Err(e) = git.push_to_remote(&worktree_path, &workspace.branch, false) {
        tracing::error!("Failed to push branch to remote: {}", e);
        match e {
            GitServiceError::GitCLI(GitCliError::AuthFailed(_)) => {
                return Ok(CreatePrResult {
                    url: None,
                    error: Some(PrError::GitCliNotLoggedIn),
                });
            }
            GitServiceError::GitCLI(GitCliError::NotAvailable) => {
                return Ok(CreatePrResult {
                    url: None,
                    error: Some(PrError::GitCliNotInstalled),
                });
            }
            _ => return Err(AppError::from(e)),
        }
    }

    let git_host = match git_host::GitHostService::from_url(&target_remote.url) {
        Ok(host) => host,
        Err(GitHostError::UnsupportedProvider) => {
            return Ok(CreatePrResult {
                url: None,
                error: Some(PrError::UnsupportedProvider),
            });
        }
        Err(GitHostError::CliNotInstalled { provider }) => {
            return Ok(CreatePrResult {
                url: None,
                error: Some(PrError::CliNotInstalled { provider }),
            });
        }
        Err(e) => return Err(AppError::from(e)),
    };

    let provider = git_host.provider_kind();

    let pr_request = CreatePrRequest {
        title: title.clone(),
        body: body.clone(),
        head_branch: workspace.branch.clone(),
        base_branch: base_branch.clone(),
        draft,
        head_repo_url: Some(push_remote.url.clone()),
    };

    match git_host
        .create_pr(&repo_path, &target_remote.url, &pr_request)
        .await
    {
        Ok(pr_info) => {
            if let Err(e) = Merge::create_pr(
                pool,
                workspace.id,
                workspace_repo.repo_id,
                &base_branch,
                pr_info.number,
                &pr_info.url,
            )
            .await
            {
                tracing::error!("Failed to update workspace PR status: {}", e);
            }

            // Auto-open PR in browser
            if let Err(e) = utils::browser::open_browser(&pr_info.url).await {
                tracing::warn!("Failed to open PR in browser: {}", e);
            }

            // Trigger auto-description follow-up if enabled
            if auto_generate_description.unwrap_or(false)
                && let Err(e) = trigger_pr_description_follow_up(
                    &state,
                    &workspace,
                    pr_info.number,
                    &pr_info.url,
                )
                .await
            {
                tracing::warn!(
                    "Failed to trigger PR description follow-up for workspace {}: {}",
                    workspace.id,
                    e
                );
            }

            Ok(CreatePrResult {
                url: Some(pr_info.url),
                error: None,
            })
        }
        Err(e) => {
            tracing::error!(
                "Failed to create PR for workspace {} using {:?}: {}",
                workspace.id,
                provider,
                e
            );
            match &e {
                GitHostError::CliNotInstalled { provider } => Ok(CreatePrResult {
                    url: None,
                    error: Some(PrError::CliNotInstalled {
                        provider: *provider,
                    }),
                }),
                GitHostError::AuthFailed(_) => Ok(CreatePrResult {
                    url: None,
                    error: Some(PrError::CliNotLoggedIn { provider }),
                }),
                _ => Err(AppError::from(e)),
            }
        }
    }
}

async fn trigger_pr_description_follow_up(
    state: &tauri::State<'_, AppState>,
    workspace: &Workspace,
    pr_number: i64,
    pr_url: &str,
) -> Result<(), AppError> {
    let pool = &state.deployment.db().pool;

    let config = state.deployment.config().read().await;
    let prompt_template = config
        .pr_auto_description_prompt
        .as_deref()
        .unwrap_or(DEFAULT_PR_DESCRIPTION_PROMPT);

    let prompt = prompt_template
        .replace("{pr_number}", &pr_number.to_string())
        .replace("{pr_url}", pr_url);

    drop(config);

    let session = match Session::find_latest_by_workspace_id(pool, workspace.id).await? {
        Some(s) => s,
        None => {
            Session::create(
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
            .await?
        }
    };

    let Some(executor_profile_id) =
        ExecutionProcess::latest_executor_profile_for_session(pool, session.id).await?
    else {
        tracing::warn!(
            "No executor profile found for session {}, skipping PR description follow-up",
            session.id
        );
        return Ok(());
    };

    let latest_session_info = CodingAgentTurn::find_latest_session_info(pool, session.id).await?;

    let container_ref = state
        .deployment
        .container()
        .ensure_container_exists(workspace)
        .await?;
    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let working_dir = resolve_workspace_agent_working_dir(workspace, &container_ref, &repos);

    let action_type = if let Some(info) = latest_session_info {
        ExecutorActionType::CodingAgentFollowUpRequest(CodingAgentFollowUpRequest {
            prompt,
            session_id: info.session_id,
            reset_to_message_id: None,
            executor_config: ExecutorConfig::from(executor_profile_id.clone()),
            working_dir: working_dir.clone(),
        })
    } else {
        ExecutorActionType::CodingAgentInitialRequest(CodingAgentInitialRequest {
            prompt,
            executor_config: ExecutorConfig::from(executor_profile_id.clone()),
            working_dir,
        })
    };

    let action = ExecutorAction::new(action_type, None);

    state
        .deployment
        .container()
        .start_execution(
            workspace,
            &session,
            &action,
            &ExecutionProcessRunReason::CodingAgent,
        )
        .await?;

    Ok(())
}

#[tauri::command]
pub async fn attach_workspace_pr(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
) -> Result<AttachPrResult, AppError> {
    let pool = &state.deployment.db().pool;

    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;

    let task = workspace
        .parent_task(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Parent task not found".to_string()))?;

    let workspace_repo = WorkspaceRepo::find_by_workspace_and_repo_id(pool, workspace.id, repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    let repo = Repo::find_by_id(pool, workspace_repo.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    // Check if PR already attached for this repo
    let merges = Merge::find_by_workspace_and_repo_id(pool, workspace.id, repo_id).await?;
    if let Some(Merge::Pr(pr_merge)) = merges.into_iter().next() {
        return Ok(AttachPrResult {
            response: Some(AttachPrResponse {
                pr_attached: true,
                pr_url: Some(pr_merge.pr_info.url.clone()),
                pr_number: Some(pr_merge.pr_info.number),
                pr_status: Some(pr_merge.pr_info.status.clone()),
            }),
            error: None,
        });
    }

    let git = state.deployment.git();
    let remote = git.resolve_remote_for_branch(&repo.path, &workspace_repo.target_branch)?;

    let git_host = match git_host::GitHostService::from_url(&remote.url) {
        Ok(host) => host,
        Err(GitHostError::UnsupportedProvider) => {
            return Ok(AttachPrResult {
                response: None,
                error: Some(PrError::UnsupportedProvider),
            });
        }
        Err(GitHostError::CliNotInstalled { provider }) => {
            return Ok(AttachPrResult {
                response: None,
                error: Some(PrError::CliNotInstalled { provider }),
            });
        }
        Err(e) => return Err(AppError::from(e)),
    };

    let provider = git_host.provider_kind();

    let prs = match git_host
        .list_prs_for_branch(&repo.path, &remote.url, &workspace.branch)
        .await
    {
        Ok(prs) => prs,
        Err(GitHostError::CliNotInstalled { provider }) => {
            return Ok(AttachPrResult {
                response: None,
                error: Some(PrError::CliNotInstalled { provider }),
            });
        }
        Err(GitHostError::AuthFailed(_)) => {
            return Ok(AttachPrResult {
                response: None,
                error: Some(PrError::CliNotLoggedIn { provider }),
            });
        }
        Err(e) => return Err(AppError::from(e)),
    };

    if let Some(pr_info) = prs.into_iter().next() {
        let merge = Merge::create_pr(
            pool,
            workspace.id,
            workspace_repo.repo_id,
            &workspace_repo.target_branch,
            pr_info.number,
            &pr_info.url,
        )
        .await?;

        if !matches!(pr_info.status, MergeStatus::Open) {
            Merge::update_status(
                pool,
                merge.id,
                pr_info.status.clone(),
                pr_info.merge_commit_sha.clone(),
            )
            .await?;
        }

        // If PR is merged, mark task as done and archive workspace
        if matches!(pr_info.status, MergeStatus::Merged) {
            Task::update_status(pool, task.id, TaskStatus::Done).await?;
            if !workspace.pinned
                && let Err(e) = state
                    .deployment
                    .container()
                    .archive_workspace(workspace.id)
                    .await
            {
                tracing::error!("Failed to archive workspace {}: {}", workspace.id, e);
            }
        }

        Ok(AttachPrResult {
            response: Some(AttachPrResponse {
                pr_attached: true,
                pr_url: Some(pr_info.url),
                pr_number: Some(pr_info.number),
                pr_status: Some(pr_info.status),
            }),
            error: None,
        })
    } else {
        Ok(AttachPrResult {
            response: Some(AttachPrResponse {
                pr_attached: false,
                pr_url: None,
                pr_number: None,
                pr_status: None,
            }),
            error: None,
        })
    }
}

#[tauri::command]
pub async fn get_workspace_pr_comments(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
) -> Result<PrCommentsResult, AppError> {
    let pool = &state.deployment.db().pool;

    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;

    let workspace_repo = WorkspaceRepo::find_by_workspace_and_repo_id(pool, workspace.id, repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    let repo = Repo::find_by_id(pool, workspace_repo.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    // Find the merge/PR for this specific repo
    let merges = Merge::find_by_workspace_and_repo_id(pool, workspace.id, repo_id).await?;

    let pr_info = match merges.into_iter().next() {
        Some(Merge::Pr(pr_merge)) => pr_merge.pr_info,
        _ => {
            return Ok(PrCommentsResult {
                response: None,
                error: Some(GetPrCommentsError::NoPrAttached),
            });
        }
    };

    let git = state.deployment.git();
    let remote = git.resolve_remote_for_branch(&repo.path, &workspace_repo.target_branch)?;

    let git_host = match git_host::GitHostService::from_url(&remote.url) {
        Ok(host) => host,
        Err(GitHostError::CliNotInstalled { provider }) => {
            return Ok(PrCommentsResult {
                response: None,
                error: Some(GetPrCommentsError::CliNotInstalled { provider }),
            });
        }
        Err(e) => return Err(AppError::from(e)),
    };

    let provider = git_host.provider_kind();

    match git_host
        .get_pr_comments(&repo.path, &remote.url, pr_info.number)
        .await
    {
        Ok(comments) => Ok(PrCommentsResult {
            response: Some(PrCommentsResponse { comments }),
            error: None,
        }),
        Err(e) => {
            tracing::error!(
                "Failed to fetch PR comments for workspace {}, PR #{}: {}",
                workspace.id,
                pr_info.number,
                e
            );
            match &e {
                GitHostError::CliNotInstalled { provider } => Ok(PrCommentsResult {
                    response: None,
                    error: Some(GetPrCommentsError::CliNotInstalled {
                        provider: *provider,
                    }),
                }),
                GitHostError::AuthFailed(_) => Ok(PrCommentsResult {
                    response: None,
                    error: Some(GetPrCommentsError::CliNotLoggedIn { provider }),
                }),
                _ => Err(AppError::from(e)),
            }
        }
    }
}
