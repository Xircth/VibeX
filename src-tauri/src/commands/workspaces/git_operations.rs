use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use db::models::{
    merge::{Merge, MergeStatus, PrMerge, PullRequestInfo},
    repo::{Repo, RepoError},
    task::{Task, TaskStatus},
    workspace::Workspace,
    workspace_repo::WorkspaceRepo,
};
use git::{self, ConflictOp, GitCliError, GitServiceError};
use git2::BranchType;
use uuid::Uuid;

use super::{
    BranchStatus, ChangeTargetBranchResponse, GitOperationError, PushError, PushResult,
    RebaseResult, RenameBranchResponse, RepoBranchStatus,
};
use crate::{error::AppError, state::AppState};

#[tauri::command]
pub async fn get_workspace_branch_status(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<Vec<RepoBranchStatus>, AppError> {
    let pool = &state.deployment.db().pool;

    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;

    let repositories = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let workspace_repos = WorkspaceRepo::find_by_workspace_id(pool, workspace.id).await?;
    let target_branches: HashMap<_, _> = workspace_repos
        .iter()
        .map(|wr| (wr.repo_id, wr.target_branch.clone()))
        .collect();

    let container_ref = state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let workspace_dir = PathBuf::from(&container_ref);

    // Batch fetch all merges for the workspace to avoid N+1 queries
    let all_merges = Merge::find_by_workspace_id(pool, workspace.id).await?;
    let merges_by_repo: HashMap<Uuid, Vec<Merge>> =
        all_merges
            .into_iter()
            .fold(HashMap::new(), |mut acc, merge| {
                let repo_id = match &merge {
                    Merge::Direct(dm) => dm.repo_id,
                    Merge::Pr(pm) => pm.repo_id,
                };
                acc.entry(repo_id).or_insert_with(Vec::new).push(merge);
                acc
            });

    let mut results = Vec::with_capacity(repositories.len());

    for repo in repositories {
        let Some(target_branch) = target_branches.get(&repo.id).cloned() else {
            continue;
        };

        let repo_merges = merges_by_repo.get(&repo.id).cloned().unwrap_or_default();
        let worktree_path = workspace
            .repo_path(&repo)
            .unwrap_or_else(|| workspace_dir.clone());

        let git = state.deployment.git().clone();
        let worktree_for_git = worktree_path.clone();
        let head_oid = tokio::task::block_in_place(|| {
            git.get_head_info(&worktree_for_git).ok().map(|h| h.oid)
        });

        let (is_rebase_in_progress, conflicted_files, conflict_op) = {
            let in_rebase = state
                .deployment
                .git()
                .is_rebase_in_progress(&worktree_path)
                .unwrap_or(false);
            let conflicts = state
                .deployment
                .git()
                .get_conflicted_files(&worktree_path)
                .unwrap_or_default();
            let op = if conflicts.is_empty() {
                None
            } else {
                state
                    .deployment
                    .git()
                    .detect_conflict_op(&worktree_path)
                    .unwrap_or(None)
            };
            (in_rebase, conflicts, op)
        };

        let (uncommitted_count, untracked_count) = match state
            .deployment
            .git()
            .get_worktree_change_counts(&worktree_path)
        {
            Ok((a, b)) => (Some(a), Some(b)),
            Err(_) => (None, None),
        };

        let has_uncommitted_changes = uncommitted_count.map(|c| c > 0);

        let target_branch_type = state
            .deployment
            .git()
            .find_branch_type(&repo.path, &target_branch)?;

        let (commits_ahead, commits_behind) = match target_branch_type {
            BranchType::Local => {
                let (a, b) = state.deployment.git().get_branch_status(
                    &repo.path,
                    &workspace.branch,
                    &target_branch,
                )?;
                (Some(a), Some(b))
            }
            BranchType::Remote => {
                let (ahead, behind) = state.deployment.git().get_remote_branch_status(
                    &repo.path,
                    &workspace.branch,
                    Some(&target_branch),
                )?;
                (Some(ahead), Some(behind))
            }
        };

        let (remote_ahead, remote_behind) = if let Some(Merge::Pr(PrMerge {
            pr_info:
                PullRequestInfo {
                    status: MergeStatus::Open,
                    ..
                },
            ..
        })) = repo_merges.first()
        {
            match state.deployment.git().get_remote_branch_status(
                &repo.path,
                &workspace.branch,
                None,
            ) {
                Ok((ahead, behind)) => (Some(ahead), Some(behind)),
                Err(_) => (None, None),
            }
        } else {
            (None, None)
        };

        results.push(RepoBranchStatus {
            repo_id: repo.id,
            repo_name: repo.name,
            status: BranchStatus {
                commits_ahead,
                commits_behind,
                has_uncommitted_changes,
                head_oid,
                uncommitted_count,
                untracked_count,
                remote_commits_ahead: remote_ahead,
                remote_commits_behind: remote_behind,
                merges: repo_merges,
                target_branch_name: target_branch,
                is_rebase_in_progress,
                conflict_op,
                conflicted_files,
                is_target_remote: target_branch_type == BranchType::Remote,
            },
        });
    }

    Ok(results)
}

#[tauri::command]
pub async fn merge_workspace(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
) -> Result<(), AppError> {
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

    // Prevent direct merge when there's an open PR for this repo
    let merges = Merge::find_by_workspace_and_repo_id(pool, workspace.id, repo_id).await?;
    let has_open_pr = merges
        .iter()
        .any(|m| matches!(m, Merge::Pr(pr) if matches!(pr.pr_info.status, MergeStatus::Open)));
    if has_open_pr {
        return Err(AppError::BadRequest(
            "Cannot merge directly when a pull request is open for this repository.".to_string(),
        ));
    }

    // Prevent direct merge into remote branches
    let target_branch_type = state
        .deployment
        .git()
        .find_branch_type(&repo.path, &workspace_repo.target_branch)?;
    if target_branch_type == BranchType::Remote {
        return Err(AppError::BadRequest(
            "Cannot merge directly into a remote branch. Please create a pull request instead."
                .to_string(),
        ));
    }

    let container_ref = state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let workspace_path = Path::new(&container_ref);
    let worktree_path = workspace
        .repo_path(&repo)
        .unwrap_or_else(|| workspace_path.to_path_buf());

    let task = workspace
        .parent_task(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Parent task not found".to_string()))?;
    let task_uuid_str = task.id.to_string();
    let first_uuid_section = task_uuid_str.split('-').next().unwrap_or(&task_uuid_str);

    // Try to use the agent-generated commit messages from the task branch
    let commit_message = match state.deployment.git().get_branch_commit_messages(
        &repo.path,
        &workspace.branch,
        &workspace_repo.target_branch,
    ) {
        Ok(messages) if !messages.is_empty() => messages.join("\n\n"),
        _ => {
            let mut msg = format!("{} (VibeX {})", task.title, first_uuid_section);
            if let Some(description) = &task.description
                && !description.trim().is_empty()
            {
                msg.push_str("\n\n");
                msg.push_str(description);
            }
            msg
        }
    };

    let merge_commit_id = state.deployment.git().merge_changes(
        &repo.path,
        &worktree_path,
        &workspace.branch,
        &workspace_repo.target_branch,
        &commit_message,
    )?;

    Merge::create_direct(
        pool,
        workspace.id,
        workspace_repo.repo_id,
        &workspace_repo.target_branch,
        &merge_commit_id,
    )
    .await?;

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

    Ok(())
}

#[tauri::command]
pub async fn push_workspace_branch(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
    force: Option<bool>,
) -> Result<PushResult, AppError> {
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

    let container_ref = state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let workspace_path = Path::new(&container_ref);
    let worktree_path = workspace
        .repo_path(&repo)
        .unwrap_or_else(|| workspace_path.to_path_buf());

    match state.deployment.git().push_to_remote(
        &worktree_path,
        &workspace.branch,
        force.unwrap_or(false),
    ) {
        Ok(_) => Ok(PushResult { error: None }),
        Err(GitServiceError::GitCLI(GitCliError::PushRejected(_))) => Ok(PushResult {
            error: Some(PushError::ForcePushRequired),
        }),
        Err(e) => Err(AppError::from(e)),
    }
}

#[tauri::command]
pub async fn rebase_workspace(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
    old_base_branch: Option<String>,
    new_base_branch: Option<String>,
) -> Result<RebaseResult, AppError> {
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

    let old_base = old_base_branch.unwrap_or_else(|| workspace_repo.target_branch.clone());
    let new_base = new_base_branch.unwrap_or_else(|| workspace_repo.target_branch.clone());

    // Check if the new base branch exists
    if !state
        .deployment
        .git()
        .check_branch_exists(&repo.path, &new_base)?
    {
        return Err(AppError::BadRequest(format!(
            "Branch '{}' does not exist in the repository",
            new_base
        )));
    }

    // Update target branch in DB
    WorkspaceRepo::update_target_branch(pool, workspace.id, repo_id, &new_base).await?;

    let container_ref = state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let workspace_path = Path::new(&container_ref);
    let worktree_path = workspace
        .repo_path(&repo)
        .unwrap_or_else(|| workspace_path.to_path_buf());

    let result = state.deployment.git().rebase_branch(
        &repo.path,
        &worktree_path,
        &new_base,
        &old_base,
        &workspace.branch,
    );

    if let Err(e) = result {
        return match e {
            GitServiceError::MergeConflicts {
                message,
                conflicted_files,
            } => Ok(RebaseResult {
                error: Some(GitOperationError::MergeConflicts {
                    message,
                    op: ConflictOp::Rebase,
                    conflicted_files,
                    target_branch: new_base,
                }),
            }),
            GitServiceError::RebaseInProgress => Ok(RebaseResult {
                error: Some(GitOperationError::RebaseInProgress),
            }),
            other => Err(AppError::from(other)),
        };
    }

    Ok(RebaseResult { error: None })
}

#[tauri::command]
pub async fn continue_rebase_workspace(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
) -> Result<(), AppError> {
    let pool = &state.deployment.db().pool;

    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;

    let repo = Repo::find_by_id(pool, repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    let container_ref = state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let workspace_path = Path::new(&container_ref);
    let worktree_path = workspace
        .repo_path(&repo)
        .unwrap_or_else(|| workspace_path.to_path_buf());

    state.deployment.git().continue_rebase(&worktree_path)?;

    Ok(())
}

#[tauri::command]
pub async fn abort_conflicts_workspace(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
) -> Result<(), AppError> {
    let pool = &state.deployment.db().pool;

    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;

    let repo = Repo::find_by_id(pool, repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    let container_ref = state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let workspace_path = Path::new(&container_ref);
    let worktree_path = workspace
        .repo_path(&repo)
        .unwrap_or_else(|| workspace_path.to_path_buf());

    state.deployment.git().abort_conflicts(&worktree_path)?;

    Ok(())
}

/// Rebase-back: merge AI branch changes back onto the target branch.
/// This is the reverse of `rebase_workspace` - it pushes the workspace branch
/// changes into the target branch (via fast-forward or merge).
#[tauri::command]
pub async fn rebase_back_workspace(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
) -> Result<RebaseResult, AppError> {
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

    // Prevent rebase-back into remote branches
    let target_branch_type = state
        .deployment
        .git()
        .find_branch_type(&repo.path, &workspace_repo.target_branch)?;
    if target_branch_type == BranchType::Remote {
        return Err(AppError::BadRequest(
            "Cannot rebase-back into a remote branch. Please create a pull request instead."
                .to_string(),
        ));
    }

    let container_ref = state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let workspace_path = Path::new(&container_ref);
    let worktree_path = workspace
        .repo_path(&repo)
        .unwrap_or_else(|| workspace_path.to_path_buf());

    // Build commit message from branch commit messages
    let task = workspace
        .parent_task(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Parent task not found".to_string()))?;
    let task_uuid_str = task.id.to_string();
    let first_uuid_section = task_uuid_str.split('-').next().unwrap_or(&task_uuid_str);

    let commit_message = match state.deployment.git().get_branch_commit_messages(
        &repo.path,
        &workspace.branch,
        &workspace_repo.target_branch,
    ) {
        Ok(messages) if !messages.is_empty() => {
            format!(
                "Merge branch '{}' into '{}'\n\n{}",
                workspace.branch,
                workspace_repo.target_branch,
                messages.join("\n\n")
            )
        }
        _ => {
            format!(
                "Merge branch '{}' - {} (VibeX {})",
                workspace.branch, task.title, first_uuid_section
            )
        }
    };

    let result = state.deployment.git().rebase_back(
        &repo.path,
        &worktree_path,
        &workspace.branch,
        &workspace_repo.target_branch,
        &commit_message,
    );

    match result {
        Ok(_sha) => Ok(RebaseResult { error: None }),
        Err(git::GitServiceError::MergeConflicts {
            message,
            conflicted_files,
        }) => Ok(RebaseResult {
            error: Some(GitOperationError::MergeConflicts {
                message,
                op: ConflictOp::Merge,
                conflicted_files,
                target_branch: workspace_repo.target_branch,
            }),
        }),
        Err(git::GitServiceError::RebaseInProgress) => Ok(RebaseResult {
            error: Some(GitOperationError::RebaseInProgress),
        }),
        Err(other) => Err(AppError::from(other)),
    }
}

#[tauri::command]
pub async fn change_workspace_target_branch(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
    new_target_branch: String,
) -> Result<ChangeTargetBranchResponse, AppError> {
    let pool = &state.deployment.db().pool;

    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;

    let repo = Repo::find_by_id(pool, repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    if !state
        .deployment
        .git()
        .check_branch_exists(&repo.path, &new_target_branch)?
    {
        return Err(AppError::BadRequest(format!(
            "Branch '{}' does not exist in repository '{}'",
            new_target_branch, repo.name
        )));
    }

    WorkspaceRepo::update_target_branch(pool, workspace.id, repo_id, &new_target_branch).await?;

    let status = state.deployment.git().get_branch_status(
        &repo.path,
        &workspace.branch,
        &new_target_branch,
    )?;

    Ok(ChangeTargetBranchResponse {
        repo_id,
        new_target_branch,
        status,
    })
}

#[tauri::command]
pub async fn rename_workspace_branch(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    new_branch_name: String,
) -> Result<RenameBranchResponse, AppError> {
    let new_branch_name = new_branch_name.trim();

    if new_branch_name.is_empty() {
        return Err(AppError::BadRequest(
            "Branch name cannot be empty".to_string(),
        ));
    }
    if !state.deployment.git().is_branch_name_valid(new_branch_name) {
        return Err(AppError::BadRequest(
            "Invalid branch name format".to_string(),
        ));
    }

    let pool = &state.deployment.db().pool;

    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;

    if new_branch_name == workspace.branch {
        return Ok(RenameBranchResponse {
            branch: workspace.branch,
        });
    }

    // Fail if workspace has an open PR in any repo
    let merges = Merge::find_by_workspace_id(pool, workspace.id).await?;
    let has_open_pr = merges.into_iter().any(|merge| {
        matches!(merge, Merge::Pr(pr_merge) if matches!(pr_merge.pr_info.status, MergeStatus::Open))
    });
    if has_open_pr {
        return Err(AppError::Conflict(
            "Cannot rename branch while a pull request is open".to_string(),
        ));
    }

    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let container_ref = state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let workspace_dir = PathBuf::from(&container_ref);

    // Pre-check: verify branch name is available and no rebase in progress
    for repo in &repos {
        let worktree_path = workspace
            .repo_path(repo)
            .unwrap_or_else(|| workspace_dir.clone());

        if state
            .deployment
            .git()
            .check_branch_exists(&repo.path, new_branch_name)?
        {
            return Err(AppError::Conflict(format!(
                "Branch '{}' already exists in repository '{}'",
                new_branch_name, repo.name
            )));
        }

        if state
            .deployment
            .git()
            .is_rebase_in_progress(&worktree_path)?
        {
            return Err(AppError::Conflict(format!(
                "Cannot rename branch while rebase is in progress in repository '{}'",
                repo.name
            )));
        }
    }

    // Rename all repos with rollback
    let old_branch = workspace.branch.clone();
    let mut renamed_repos: Vec<&Repo> = Vec::new();

    for repo in &repos {
        let worktree_path = workspace
            .repo_path(repo)
            .unwrap_or_else(|| workspace_dir.clone());

        match state.deployment.git().rename_local_branch(
            &worktree_path,
            &workspace.branch,
            new_branch_name,
        ) {
            Ok(()) => {
                renamed_repos.push(repo);
            }
            Err(e) => {
                // Rollback already renamed repos
                for renamed_repo in &renamed_repos {
                    let rollback_path = workspace
                        .repo_path(renamed_repo)
                        .unwrap_or_else(|| workspace_dir.clone());
                    if let Err(rollback_err) = state.deployment.git().rename_local_branch(
                        &rollback_path,
                        new_branch_name,
                        &old_branch,
                    ) {
                        tracing::error!(
                            "Failed to rollback branch rename in '{}': {}",
                            renamed_repo.name,
                            rollback_err
                        );
                    }
                }
                return Err(AppError::Internal(format!(
                    "Failed to rename branch in '{}': {}",
                    repo.name, e
                )));
            }
        }
    }

    Workspace::update_branch_name(pool, workspace.id, new_branch_name).await?;

    let updated_children_count = WorkspaceRepo::update_target_branch_for_children_of_workspace(
        pool,
        workspace.id,
        &old_branch,
        new_branch_name,
    )
    .await?;

    if updated_children_count > 0 {
        tracing::info!(
            "Updated {} child task attempts to target new branch '{}'",
            updated_children_count,
            new_branch_name
        );
    }

    Ok(RenameBranchResponse {
        branch: new_branch_name.to_string(),
    })
}
