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
