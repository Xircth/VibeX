use std::path::PathBuf;

use db::models::{
    repo::{Repo, RepoError},
    task::{Task, TaskRelationships},
    workspace::Workspace,
    workspace_repo::{RepoWithTargetBranch, WorkspaceRepo},
};
use deployment::Deployment;
use serde::Serialize;
use services::services::container::ContainerService;
use uuid::Uuid;

use crate::{error::AppError, state::AppState};

#[tauri::command]
pub async fn get_workspace_children(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<TaskRelationships, AppError> {
    let pool = &state.deployment.db().pool;

    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;

    let relationships = Task::find_relationships_for_workspace(pool, &workspace)
        .await
        .map_err(|e| {
            tracing::error!(
                "Failed to fetch relationships for workspace {}: {}",
                workspace.id,
                e
            );
            AppError::Internal(e.to_string())
        })?;

    Ok(relationships)
}

#[tauri::command]
pub async fn get_workspace_repos(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<Vec<RepoWithTargetBranch>, AppError> {
    let pool = &state.deployment.db().pool;
    let mut workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;
    let container_ref = state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    workspace.container_ref = Some(container_ref.clone());
    let workspace_root = PathBuf::from(container_ref);

    let repos =
        WorkspaceRepo::find_repos_with_target_branch_for_workspace(pool, workspace_id).await?;

    Ok(repos
        .into_iter()
        .map(|mut repo| {
            repo.repo.path = workspace
                .repo_path(&repo.repo)
                .unwrap_or_else(|| workspace_root.clone());
            repo
        })
        .collect())
}

#[tauri::command]
pub async fn get_first_user_message(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<Option<String>, AppError> {
    let pool = &state.deployment.db().pool;
    let message = Workspace::get_first_user_message(pool, workspace_id).await?;
    Ok(message)
}

#[tauri::command]
pub async fn mark_workspace_seen(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<(), AppError> {
    let _ = state;
    let _ = workspace_id;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct CommitInfo {
    pub message: String,
}

#[tauri::command]
pub async fn get_workspace_commit_history(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
) -> Result<Vec<CommitInfo>, AppError> {
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

    let git = state.deployment.git();
    let messages = git
        .get_branch_commit_messages(&repo.path, &workspace.branch, &workspace_repo.target_branch)
        .unwrap_or_default();

    Ok(messages
        .into_iter()
        .map(|m| CommitInfo { message: m })
        .collect())
}

#[derive(Debug, Clone, Serialize)]
pub struct CommitGraphNodeResponse {
    pub hash: String,
    pub full_hash: String,
    pub message: String,
    pub author: String,
    pub timestamp: i64,
    pub parents: Vec<String>,
    pub refs: Vec<String>,
    pub is_current_branch: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CommitGraphResponse {
    pub nodes: Vec<CommitGraphNodeResponse>,
    pub merge_base: Option<String>,
    pub current_branch: String,
    pub target_branch: String,
}

#[tauri::command]
pub async fn get_workspace_commit_graph(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
    max_commits: Option<usize>,
) -> Result<CommitGraphResponse, AppError> {
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

    let git = state.deployment.git();
    let graph = git
        .get_commit_graph(
            &repo.path,
            &workspace.branch,
            &workspace_repo.target_branch,
            max_commits.unwrap_or(100),
        )
        .unwrap_or_else(|_| git::CommitGraph {
            nodes: vec![],
            merge_base: None,
            current_branch: workspace.branch.clone(),
            target_branch: workspace_repo.target_branch.clone(),
        });

    Ok(CommitGraphResponse {
        nodes: graph
            .nodes
            .into_iter()
            .map(|n| CommitGraphNodeResponse {
                hash: n.hash,
                full_hash: n.full_hash,
                message: n.message,
                author: n.author,
                timestamp: n.timestamp,
                parents: n.parents,
                refs: n.refs,
                is_current_branch: n.is_current_branch,
            })
            .collect(),
        merge_base: graph.merge_base,
        current_branch: graph.current_branch,
        target_branch: graph.target_branch,
    })
}

// --- Git Panel operations ---

/// Helper: resolve workspace + repo to worktree path.
pub(super) async fn resolve_worktree_path(
    state: &AppState,
    workspace_id: Uuid,
    repo_id: Uuid,
) -> Result<(PathBuf, Workspace), AppError> {
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
    let worktree_path = workspace
        .repo_path(&repo)
        .unwrap_or_else(|| PathBuf::from(&container_ref));
    Ok((worktree_path, workspace))
}

#[tauri::command]
pub async fn get_workspace_git_status(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
) -> Result<git::DetailedGitStatus, AppError> {
    let (worktree_path, _workspace) = resolve_worktree_path(&state, workspace_id, repo_id).await?;
    let git = state.deployment.git();
    git.get_detailed_status(&worktree_path)
        .map_err(|e| AppError::Internal(format!("git status failed: {e}")))
}

#[tauri::command]
pub async fn stage_workspace_file(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
    file_path: String,
) -> Result<(), AppError> {
    let (worktree_path, _workspace) = resolve_worktree_path(&state, workspace_id, repo_id).await?;
    let git = state.deployment.git();
    git.stage_file(&worktree_path, &file_path)
        .map_err(|e| AppError::Internal(format!("stage file failed: {e}")))
}

#[tauri::command]
pub async fn stage_workspace_all(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
) -> Result<(), AppError> {
    let (worktree_path, _workspace) = resolve_worktree_path(&state, workspace_id, repo_id).await?;
    let git = state.deployment.git();
    git.stage_all(&worktree_path)
        .map_err(|e| AppError::Internal(format!("stage all failed: {e}")))
}

#[tauri::command]
pub async fn unstage_workspace_file(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
    file_path: String,
) -> Result<(), AppError> {
    let (worktree_path, _workspace) = resolve_worktree_path(&state, workspace_id, repo_id).await?;
    let git = state.deployment.git();
    git.unstage_file(&worktree_path, &file_path)
        .map_err(|e| AppError::Internal(format!("unstage file failed: {e}")))
}

#[tauri::command]
pub async fn revert_workspace_file(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
    file_path: String,
) -> Result<(), AppError> {
    let (worktree_path, _workspace) = resolve_worktree_path(&state, workspace_id, repo_id).await?;
    let git = state.deployment.git();
    git.revert_file(&worktree_path, &file_path)
        .map_err(|e| AppError::Internal(format!("revert file failed: {e}")))
}

#[tauri::command]
pub async fn revert_workspace_all(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
) -> Result<(), AppError> {
    let (worktree_path, _workspace) = resolve_worktree_path(&state, workspace_id, repo_id).await?;
    let git = state.deployment.git();
    git.revert_all(&worktree_path)
        .map_err(|e| AppError::Internal(format!("revert all failed: {e}")))
}

#[tauri::command]
pub async fn get_workspace_file_diffs(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
) -> Result<Vec<git::GitFileDiffEntry>, AppError> {
    let (worktree_path, _workspace) = resolve_worktree_path(&state, workspace_id, repo_id).await?;
    let git = state.deployment.git();
    git.get_file_diffs(&worktree_path)
        .map_err(|e| AppError::Internal(format!("get file diffs failed: {e}")))
}

#[tauri::command]
pub async fn commit_workspace_changes(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
    message: String,
) -> Result<(), AppError> {
    let (worktree_path, _workspace) = resolve_worktree_path(&state, workspace_id, repo_id).await?;
    let git = state.deployment.git();
    git.commit_changes(&worktree_path, &message)
        .map_err(|e| AppError::Internal(format!("commit failed: {e}")))
}

#[tauri::command]
pub async fn get_workspace_git_log(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
) -> Result<git::GitLogStatus, AppError> {
    let (worktree_path, _workspace) = resolve_worktree_path(&state, workspace_id, repo_id).await?;
    let git = state.deployment.git();
    git.get_log_status(&worktree_path)
        .map_err(|e| AppError::Internal(format!("git log failed: {e}")))
}

// --- Pull/Fetch operations ---

#[tauri::command]
pub async fn pull_workspace_branch(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
) -> Result<git::PullResult, AppError> {
    let (worktree_path, _workspace) = resolve_worktree_path(&state, workspace_id, repo_id).await?;
    let git = state.deployment.git();
    git.pull(&worktree_path)
        .map_err(|e| AppError::Internal(format!("git pull failed: {e}")))
}

#[tauri::command]
pub async fn fetch_workspace(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
) -> Result<(), AppError> {
    let (worktree_path, _workspace) = resolve_worktree_path(&state, workspace_id, repo_id).await?;
    let git = state.deployment.git();
    git.fetch_all(&worktree_path)
        .map_err(|e| AppError::Internal(format!("git fetch failed: {e}")))
}

// --- Branch operations ---

#[tauri::command]
pub async fn checkout_workspace_branch(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
    branch_name: String,
) -> Result<(), AppError> {
    let (worktree_path, _workspace) = resolve_worktree_path(&state, workspace_id, repo_id).await?;
    let git = state.deployment.git();
    git.checkout_branch(&worktree_path, &branch_name)
        .map_err(|e| AppError::Internal(format!("git checkout failed: {e}")))
}

#[tauri::command]
pub async fn create_workspace_branch(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
    branch_name: String,
    from_ref: Option<String>,
) -> Result<(), AppError> {
    let (worktree_path, _workspace) = resolve_worktree_path(&state, workspace_id, repo_id).await?;
    let git = state.deployment.git();
    git.create_branch(&worktree_path, &branch_name, from_ref.as_deref())
        .map_err(|e| AppError::Internal(format!("git create branch failed: {e}")))
}

#[tauri::command]
pub async fn delete_workspace_branch(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
    branch_name: String,
) -> Result<(), AppError> {
    let (worktree_path, _workspace) = resolve_worktree_path(&state, workspace_id, repo_id).await?;
    let git = git::GitCli::new();
    git.delete_branch(&worktree_path, &branch_name)
        .map_err(|e| AppError::Internal(format!("git delete branch failed: {e}")))
}

// --- PR operations ---
