use uuid::Uuid;

use super::workspace_queries::resolve_worktree_path;
use crate::{error::AppError, state::AppState};

#[tauri::command]
pub async fn get_workspace_commit_detail(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
    sha: String,
) -> Result<git::CommitDetail, AppError> {
    let (worktree_path, _workspace) = resolve_worktree_path(&state, workspace_id, repo_id).await?;
    let git = state.deployment.git();
    git.get_commit_detail(&worktree_path, &sha)
        .map_err(|e| AppError::Internal(format!("git show commit failed: {e}")))
}

#[tauri::command]
pub async fn get_workspace_commit_diffs(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
    sha: String,
) -> Result<Vec<utils::diff::Diff>, AppError> {
    let (worktree_path, _workspace) = resolve_worktree_path(&state, workspace_id, repo_id).await?;
    let git = state.deployment.git();
    git.get_diffs(
        git::DiffTarget::Commit {
            repo_path: &worktree_path,
            commit_sha: &sha,
        },
        None,
    )
    .map_err(|e| AppError::Internal(format!("get commit diffs failed: {e}")))
}

#[tauri::command]
pub async fn git_cherry_pick(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
    sha: String,
) -> Result<(), AppError> {
    let (worktree_path, _workspace) = resolve_worktree_path(&state, workspace_id, repo_id).await?;
    let git = state.deployment.git();
    git.cherry_pick_commit(&worktree_path, &sha)
        .map_err(|e| AppError::Internal(format!("git cherry-pick failed: {e}")))
}

#[tauri::command]
pub async fn git_revert_commit(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
    sha: String,
) -> Result<(), AppError> {
    let (worktree_path, _workspace) = resolve_worktree_path(&state, workspace_id, repo_id).await?;
    let git = state.deployment.git();
    git.revert_commit(&worktree_path, &sha)
        .map_err(|e| AppError::Internal(format!("git revert failed: {e}")))
}

#[tauri::command]
pub async fn git_reset_to_commit(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
    sha: String,
    mode: git::ResetMode,
) -> Result<(), AppError> {
    let (worktree_path, _workspace) = resolve_worktree_path(&state, workspace_id, repo_id).await?;
    let git = state.deployment.git();
    git.reset_to_commit(&worktree_path, &sha, &mode)
        .map_err(|e| AppError::Internal(format!("git reset failed: {e}")))
}

#[tauri::command]
pub async fn git_create_branch_at_commit(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
    branch_name: String,
    sha: String,
) -> Result<(), AppError> {
    let (worktree_path, _workspace) = resolve_worktree_path(&state, workspace_id, repo_id).await?;
    let git = state.deployment.git();
    git.create_branch_at_commit(&worktree_path, &branch_name, &sha)
        .map_err(|e| AppError::Internal(format!("git create branch failed: {e}")))
}

#[tauri::command]
pub async fn stash_workspace(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
    message: Option<String>,
    include_untracked: bool,
) -> Result<bool, AppError> {
    let (worktree_path, _workspace) = resolve_worktree_path(&state, workspace_id, repo_id).await?;
    state
        .deployment
        .git()
        .stash_push(&worktree_path, message.as_deref(), include_untracked)
        .map_err(|e| AppError::Internal(format!("git stash push failed: {e}")))
}

#[tauri::command]
pub async fn list_workspace_stashes(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
) -> Result<Vec<git::StashEntry>, AppError> {
    let (worktree_path, _workspace) = resolve_worktree_path(&state, workspace_id, repo_id).await?;
    state
        .deployment
        .git()
        .stash_list(&worktree_path)
        .map_err(|e| AppError::Internal(format!("git stash list failed: {e}")))
}

#[tauri::command]
pub async fn apply_workspace_stash(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
    index: usize,
) -> Result<(), AppError> {
    let (worktree_path, _workspace) = resolve_worktree_path(&state, workspace_id, repo_id).await?;
    state
        .deployment
        .git()
        .stash_apply(&worktree_path, index)
        .map_err(|e| AppError::Internal(format!("git stash apply failed: {e}")))
}

#[tauri::command]
pub async fn pop_workspace_stash(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
    index: usize,
) -> Result<(), AppError> {
    let (worktree_path, _workspace) = resolve_worktree_path(&state, workspace_id, repo_id).await?;
    state
        .deployment
        .git()
        .stash_pop(&worktree_path, index)
        .map_err(|e| AppError::Internal(format!("git stash pop failed: {e}")))
}

#[tauri::command]
pub async fn drop_workspace_stash(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
    index: usize,
) -> Result<(), AppError> {
    let (worktree_path, _workspace) = resolve_worktree_path(&state, workspace_id, repo_id).await?;
    state
        .deployment
        .git()
        .stash_drop(&worktree_path, index)
        .map_err(|e| AppError::Internal(format!("git stash drop failed: {e}")))
}

#[tauri::command]
pub async fn show_workspace_stash(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
    index: usize,
) -> Result<String, AppError> {
    let (worktree_path, _workspace) = resolve_worktree_path(&state, workspace_id, repo_id).await?;
    state
        .deployment
        .git()
        .stash_show(&worktree_path, index)
        .map_err(|e| AppError::Internal(format!("git stash show failed: {e}")))
}
