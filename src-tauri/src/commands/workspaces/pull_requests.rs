use std::path::PathBuf;

use db::models::{
    merge::{Merge, MergeStatus},
    repo::{Repo, RepoError},
    task::{Task, TaskStatus},
    workspace::Workspace,
    workspace_repo::WorkspaceRepo,
};
use git::{GitCliError, GitServiceError};
use services::services::git_host::{self, CreatePrRequest, GitHostError, GitHostProvider};
use uuid::Uuid;

use super::{
    AttachPrResponse, AttachPrResult, CreatePrResult, GetPrCommentsError, PrCommentsResponse,
    PrCommentsResult, PrError,
};
use crate::{error::AppError, state::AppState};

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
    let mut title = title;
    let mut body = body;

    if auto_generate_description.unwrap_or(false) {
        let task = workspace.parent_task(pool).await?;
        let remote_base = format!("{}/{}", target_remote.name, base_branch);
        let generated = crate::pr_description::generate_pr_description(
            &state,
            task.as_ref().map(|task| task.title.clone()),
            task.as_ref().and_then(|task| task.description.clone()),
            &worktree_path,
            &base_branch,
            &workspace.branch,
            &[remote_base, base_branch.clone()],
        )
        .await?;
        title = generated.title;
        body = Some(generated.body);
    }

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
