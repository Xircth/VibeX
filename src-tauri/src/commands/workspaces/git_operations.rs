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

    let git = state.deployment.git().clone();
    crate::error::spawn_blocking_into(move || {
        let mut results = Vec::with_capacity(repositories.len());
        for repo in repositories {
            let Some(target_branch) = target_branches.get(&repo.id).cloned() else {
                continue;
            };

            let repo_merges = merges_by_repo.get(&repo.id).cloned().unwrap_or_default();
            let worktree_path = workspace
                .repo_path(&repo)
                .unwrap_or_else(|| workspace_dir.clone());

            let head_oid = git.get_head_info(&worktree_path).ok().map(|h| h.oid);

            let in_rebase = git.is_rebase_in_progress(&worktree_path).unwrap_or(false);
            let conflicted_files = git.get_conflicted_files(&worktree_path).unwrap_or_default();
            let conflict_op = if conflicted_files.is_empty() {
                None
            } else {
                git.detect_conflict_op(&worktree_path).unwrap_or(None)
            };

            let (uncommitted_count, untracked_count) =
                match git.get_worktree_change_counts(&worktree_path) {
                    Ok((a, b)) => (Some(a), Some(b)),
                    Err(_) => (None, None),
                };

            let has_uncommitted_changes = uncommitted_count.map(|c| c > 0);

            let target_branch_type = git.find_branch_type(&repo.path, &target_branch)?;

            let (commits_ahead, commits_behind) = match target_branch_type {
                BranchType::Local => {
                    let (a, b) =
                        git.get_branch_status(&repo.path, &workspace.branch, &target_branch)?;
                    (Some(a), Some(b))
                }
                BranchType::Remote => {
                    let (ahead, behind) = git.get_remote_branch_status(
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
                match git.get_remote_branch_status(&repo.path, &workspace.branch, None) {
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
                    is_rebase_in_progress: in_rebase,
                    conflict_op,
                    conflicted_files,
                    is_target_remote: target_branch_type == BranchType::Remote,
                },
            });
        }
        Ok::<_, GitServiceError>(results)
    })
    .await
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
    let git = state.deployment.git().clone();
    let repo_path = repo.path.clone();
    let target_branch = workspace_repo.target_branch.clone();
    let target_branch_type =
        crate::error::spawn_blocking_into(move || git.find_branch_type(&repo_path, &target_branch))
            .await?;
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

    let git = state.deployment.git().clone();
    let repo_path = repo.path.clone();
    let workspace_branch = workspace.branch.clone();
    let target_branch = workspace_repo.target_branch.clone();
    let task_title = task.title.clone();
    let task_description = task.description.clone();
    let first_uuid_section = first_uuid_section.to_string();
    let merge_commit_id = crate::error::spawn_blocking_into(move || {
        let commit_message =
            match git.get_branch_commit_messages(&repo_path, &workspace_branch, &target_branch) {
                Ok(messages) if !messages.is_empty() => messages.join("\n\n"),
                _ => {
                    let mut msg = format!("{} (VibeX {})", task_title, first_uuid_section);
                    if let Some(description) = &task_description
                        && !description.trim().is_empty()
                    {
                        msg.push_str("\n\n");
                        msg.push_str(description);
                    }
                    msg
                }
            };
        git.merge_changes(
            &repo_path,
            &worktree_path,
            &workspace_branch,
            &target_branch,
            &commit_message,
        )
    })
    .await?;

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

    let git = state.deployment.git().clone();
    let branch = workspace.branch.clone();
    let force = force.unwrap_or(false);
    let result =
        tokio::task::spawn_blocking(move || git.push_to_remote(&worktree_path, &branch, force))
            .await
            .map_err(|error| AppError::Internal(error.to_string()))?;
    match result {
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

    let git = state.deployment.git().clone();
    let repo_path = repo.path.clone();
    let branch_to_check = new_base.clone();
    let branch_exists = crate::error::spawn_blocking_into(move || {
        git.check_branch_exists(&repo_path, &branch_to_check)
    })
    .await?;
    if !branch_exists {
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

    let git = state.deployment.git().clone();
    let repo_path = repo.path.clone();
    let workspace_branch = workspace.branch.clone();
    let rebase_new_base = new_base.clone();
    let rebase_old_base = old_base.clone();
    let result = tokio::task::spawn_blocking(move || {
        git.rebase_branch(
            &repo_path,
            &worktree_path,
            &rebase_new_base,
            &rebase_old_base,
            &workspace_branch,
        )
    })
    .await
    .map_err(|error| AppError::Internal(error.to_string()))?;

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

    let git = state.deployment.git().clone();
    crate::error::spawn_blocking_into(move || git.continue_conflicts(&worktree_path)).await?;

    Ok(())
}

#[tauri::command]
pub async fn continue_conflicts_workspace(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
) -> Result<(), AppError> {
    continue_rebase_workspace(state, workspace_id, repo_id).await
}

#[tauri::command]
pub async fn get_workspace_conflict_file(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
    file_path: String,
) -> Result<git::ConflictFileDetail, AppError> {
    let worktree_path = resolve_worktree_path(&state, workspace_id, repo_id).await?;
    Ok(state
        .deployment
        .git()
        .get_conflict_file_detail(&worktree_path, &file_path)?)
}

#[tauri::command]
pub async fn write_workspace_conflict_resolution(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
    file_path: String,
    content: String,
) -> Result<git::WriteConflictResolutionResult, AppError> {
    let worktree_path = resolve_worktree_path(&state, workspace_id, repo_id).await?;
    Ok(state
        .deployment
        .git()
        .write_conflict_resolution(&worktree_path, &file_path, &content)?)
}

async fn resolve_worktree_path(
    state: &tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
) -> Result<PathBuf, AppError> {
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
    Ok(workspace
        .repo_path(&repo)
        .unwrap_or_else(|| workspace_path.to_path_buf()))
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

    let git = state.deployment.git().clone();
    crate::error::spawn_blocking_into(move || git.abort_conflicts(&worktree_path)).await?;

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
    let git = state.deployment.git().clone();
    let repo_path = repo.path.clone();
    let target_branch = workspace_repo.target_branch.clone();
    let target_branch_type =
        crate::error::spawn_blocking_into(move || git.find_branch_type(&repo_path, &target_branch))
            .await?;
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

    let git = state.deployment.git().clone();
    let repo_path = repo.path.clone();
    let workspace_branch = workspace.branch.clone();
    let target_branch = workspace_repo.target_branch.clone();
    let task_title = task.title.clone();
    let first_uuid_section = first_uuid_section.to_string();
    let result = tokio::task::spawn_blocking(move || {
        let commit_message =
            match git.get_branch_commit_messages(&repo_path, &workspace_branch, &target_branch) {
                Ok(messages) if !messages.is_empty() => {
                    format!(
                        "Merge branch '{}' into '{}'\n\n{}",
                        workspace_branch,
                        target_branch,
                        messages.join("\n\n")
                    )
                }
                _ => {
                    format!(
                        "Merge branch '{}' - {} (VibeX {})",
                        workspace_branch, task_title, first_uuid_section
                    )
                }
            };
        git.rebase_back(
            &repo_path,
            &worktree_path,
            &workspace_branch,
            &target_branch,
            &commit_message,
        )
    })
    .await
    .map_err(|error| AppError::Internal(error.to_string()))?;

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

    let git = state.deployment.git().clone();
    let repo_path = repo.path.clone();
    let branch_to_check = new_target_branch.clone();
    let repo_name = repo.name.clone();
    let branch_exists = crate::error::spawn_blocking_into({
        let git = git.clone();
        let repo_path = repo_path.clone();
        move || git.check_branch_exists(&repo_path, &branch_to_check)
    })
    .await?;
    if !branch_exists {
        return Err(AppError::BadRequest(format!(
            "Branch '{}' does not exist in repository '{}'",
            new_target_branch, repo_name
        )));
    }

    WorkspaceRepo::update_target_branch(pool, workspace.id, repo_id, &new_target_branch).await?;

    let workspace_branch = workspace.branch.clone();
    let status_branch = new_target_branch.clone();
    let status = crate::error::spawn_blocking_into(move || {
        git.get_branch_status(&repo_path, &workspace_branch, &status_branch)
    })
    .await?;

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

    let git = state.deployment.git().clone();
    let old_branch = workspace.branch.clone();
    let old_branch_for_db = old_branch.clone();
    let new_branch = new_branch_name.to_string();
    let rename_repos: Vec<(String, PathBuf, PathBuf)> = repos
        .iter()
        .map(|repo| {
            let worktree_path = workspace
                .repo_path(repo)
                .unwrap_or_else(|| workspace_dir.clone());
            (repo.name.clone(), repo.path.clone(), worktree_path)
        })
        .collect();

    crate::error::spawn_blocking_into(move || -> Result<(), AppError> {
        for (name, repo_path, worktree_path) in &rename_repos {
            if git.check_branch_exists(repo_path, &new_branch)? {
                return Err(AppError::Conflict(format!(
                    "Branch '{}' already exists in repository '{}'",
                    new_branch, name
                )));
            }
            if git.is_rebase_in_progress(worktree_path)? {
                return Err(AppError::Conflict(format!(
                    "Cannot rename branch while rebase is in progress in repository '{}'",
                    name
                )));
            }
        }

        let mut renamed: Vec<&(String, PathBuf, PathBuf)> = Vec::new();
        for repo in &rename_repos {
            match git.rename_local_branch(&repo.2, &old_branch, &new_branch) {
                Ok(()) => renamed.push(repo),
                Err(e) => {
                    for renamed_repo in &renamed {
                        if let Err(rollback_err) =
                            git.rename_local_branch(&renamed_repo.2, &new_branch, &old_branch)
                        {
                            tracing::error!(
                                "Failed to rollback branch rename in '{}': {}",
                                renamed_repo.0,
                                rollback_err
                            );
                        }
                    }
                    return Err(AppError::Internal(format!(
                        "Failed to rename branch in '{}': {}",
                        repo.0, e
                    )));
                }
            }
        }
        Ok(())
    })
    .await?;

    Workspace::update_branch_name(pool, workspace.id, new_branch_name).await?;

    let updated_children_count = WorkspaceRepo::update_target_branch_for_children_of_workspace(
        pool,
        workspace.id,
        &old_branch_for_db,
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
