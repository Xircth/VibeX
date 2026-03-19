use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use db::models::{
    coding_agent_turn::CodingAgentTurn,
    execution_process::{ExecutionProcess, ExecutionProcessRunReason, ExecutionProcessStatus},
    merge::{Merge, MergeStatus, PrMerge, PullRequestInfo},
    project_repo::ProjectRepo,
    repo::{Repo, RepoError},
    session::{CreateSession, Session},
    task::{CreateTask, Task, TaskRelationships, TaskStatus},
    workspace::{CreateWorkspace, Workspace},
    workspace_repo::{CreateWorkspaceRepo, RepoWithTargetBranch, WorkspaceRepo},
};
use deployment::Deployment;
use executors::{
    actions::{
        ExecutorAction, ExecutorActionType,
        coding_agent_follow_up::CodingAgentFollowUpRequest,
        coding_agent_initial::CodingAgentInitialRequest,
        script::{ScriptContext, ScriptRequest, ScriptRequestLanguage},
    },
    executors::{CodingAgent, ExecutorError},
    profile::{ExecutorConfig, ExecutorConfigs, ExecutorProfileId},
};
use git::{ConflictOp, GitCliError, GitRemote, GitService, GitServiceError};
use git2::BranchType;
use serde::{Deserialize, Serialize};
use services::services::{
    config::DEFAULT_PR_DESCRIPTION_PROMPT,
    container::ContainerService,
    git_host::{self, CreatePrRequest, GitHostError, GitHostProvider, ProviderKind, github::GhCli},
    workspace_manager::WorkspaceManager,
};
use utils::shell::resolve_executable_path;
use uuid::Uuid;

use crate::{error::AppError, state::AppState};

fn detect_package_manager(repo_root: &Path) -> (&'static str, Vec<&'static str>) {
    if repo_root.join("pnpm-lock.yaml").exists() {
        return ("pnpm", vec!["add", "vibe-ultra-web-companion"]);
    }

    if repo_root.join("yarn.lock").exists() {
        return ("yarn", vec!["add", "vibe-ultra-web-companion"]);
    }

    if repo_root.join("bun.lockb").exists() || repo_root.join("bun.lock").exists() {
        return ("bun", vec!["add", "vibe-ultra-web-companion"]);
    }

    ("npm", vec!["i", "vibe-ultra-web-companion"])
}

// --- Local request/response types ---

#[derive(Debug, Deserialize)]
pub struct WorkspaceRepoInput {
    pub repo_id: Uuid,
    pub target_branch: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateWorkspaceRequest {
    pub task_id: Uuid,
    pub executor_profile_id: ExecutorProfileId,
    pub repos: Vec<WorkspaceRepoInput>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateWorkspaceRequest {
    pub archived: Option<bool>,
    pub pinned: Option<bool>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchStatus {
    pub commits_behind: Option<usize>,
    pub commits_ahead: Option<usize>,
    pub has_uncommitted_changes: Option<bool>,
    pub head_oid: Option<String>,
    pub uncommitted_count: Option<usize>,
    pub untracked_count: Option<usize>,
    pub target_branch_name: String,
    pub remote_commits_behind: Option<usize>,
    pub remote_commits_ahead: Option<usize>,
    pub merges: Vec<Merge>,
    pub is_rebase_in_progress: bool,
    pub conflict_op: Option<ConflictOp>,
    pub conflicted_files: Vec<String>,
    pub is_target_remote: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RepoBranchStatus {
    pub repo_id: Uuid,
    pub repo_name: String,
    #[serde(flatten)]
    pub status: BranchStatus,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GitOperationError {
    MergeConflicts {
        message: String,
        op: ConflictOp,
        conflicted_files: Vec<String>,
        target_branch: String,
    },
    RebaseInProgress,
}

#[derive(Debug, Serialize)]
pub struct ChangeTargetBranchResponse {
    pub repo_id: Uuid,
    pub new_target_branch: String,
    pub status: (usize, usize),
}

#[derive(Debug, Serialize)]
pub struct RenameBranchResponse {
    pub branch: String,
}

#[derive(Debug, Serialize)]
pub struct OpenEditorResponse {
    pub url: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PushError {
    ForcePushRequired,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RunScriptError {
    NoScriptConfigured,
    ProcessAlreadyRunning,
}

#[derive(Debug, Serialize)]
pub struct RunScriptResult {
    pub process: Option<ExecutionProcess>,
    pub error: Option<RunScriptError>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PrError {
    CliNotInstalled { provider: ProviderKind },
    CliNotLoggedIn { provider: ProviderKind },
    GitCliNotLoggedIn,
    GitCliNotInstalled,
    TargetBranchNotFound { branch: String },
    UnsupportedProvider,
}

#[derive(Debug, Serialize)]
pub struct CreatePrResult {
    pub url: Option<String>,
    pub error: Option<PrError>,
}

#[derive(Debug, Serialize)]
pub struct AttachPrResponse {
    pub pr_attached: bool,
    pub pr_url: Option<String>,
    pub pr_number: Option<i64>,
    pub pr_status: Option<MergeStatus>,
}

#[derive(Debug, Serialize)]
pub struct AttachPrResult {
    pub response: Option<AttachPrResponse>,
    pub error: Option<PrError>,
}

#[derive(Debug, Serialize)]
pub struct PrCommentsResponse {
    pub comments: Vec<services::services::git_host::UnifiedPrComment>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GetPrCommentsError {
    NoPrAttached,
    CliNotInstalled { provider: ProviderKind },
    CliNotLoggedIn { provider: ProviderKind },
}

#[derive(Debug, Serialize)]
pub struct PrCommentsResult {
    pub response: Option<PrCommentsResponse>,
    pub error: Option<GetPrCommentsError>,
}

#[derive(Debug, Deserialize)]
pub struct CreateWorkspaceFromPrRequest {
    pub repo_id: Uuid,
    pub pr_number: i64,
    pub pr_title: String,
    pub pr_url: String,
    pub head_branch: String,
    pub base_branch: String,
    pub run_setup: bool,
    pub remote_name: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CreateWorkspaceFromPrResponse {
    pub workspace: Workspace,
    pub task: Task,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CreateFromPrError {
    PrNotFound,
    BranchFetchFailed { message: String },
    CliNotInstalled { provider: ProviderKind },
    AuthFailed { message: String },
    UnsupportedProvider,
    RepoNotInProject,
}

#[derive(Debug, Serialize)]
pub struct CreateFromPrResult {
    pub response: Option<CreateWorkspaceFromPrResponse>,
    pub error: Option<CreateFromPrError>,
}

#[derive(Debug, Serialize, Deserialize)]
pub enum GhCliSetupError {
    BrewMissing,
    SetupHelperNotSupported,
    Other { message: String },
}

#[derive(Debug, Serialize)]
pub struct GhCliSetupResult {
    pub process: Option<ExecutionProcess>,
    pub error: Option<GhCliSetupError>,
}

#[derive(Debug, Serialize)]
pub struct RebaseResult {
    pub error: Option<GitOperationError>,
}

#[derive(Debug, Serialize)]
pub struct PushResult {
    pub error: Option<PushError>,
}

// --- Commands ---

#[tauri::command]
pub async fn get_workspaces(
    state: tauri::State<'_, AppState>,
    task_id: Option<Uuid>,
) -> Result<Vec<Workspace>, AppError> {
    let pool = &state.deployment.db().pool;
    let workspaces = Workspace::fetch_all(pool, task_id).await?;
    Ok(workspaces)
}

#[tauri::command]
pub async fn get_workspace(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<Workspace, AppError> {
    let pool = &state.deployment.db().pool;
    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;
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
            branch: git_branch_name,
            container_ref: None,
            use_worktree: true,
            agent_working_dir,
        },
        attempt_id,
        payload.task_id,
    )
    .await?;

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

    if is_archiving {
        if let Err(e) = state
            .deployment
            .container()
            .archive_workspace(workspace.id)
            .await
        {
            tracing::error!("Failed to archive workspace {}: {}", workspace.id, e);
        }
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

        let head_oid = state
            .deployment
            .git()
            .get_head_info(&worktree_path)
            .ok()
            .map(|h| h.oid);

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
            let mut msg = format!("{} (Vibe Ultra {})", task.title, first_uuid_section);
            if let Some(description) = &task.description {
                if !description.trim().is_empty() {
                    msg.push_str("\n\n");
                    msg.push_str(description);
                }
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

    if !workspace.pinned {
        if let Err(e) = state
            .deployment
            .container()
            .archive_workspace(workspace.id)
            .await
        {
            tracing::error!("Failed to archive workspace {}: {}", workspace.id, e);
        }
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
                "Merge branch '{}' - {} (Vibe Ultra {})",
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

#[tauri::command]
pub async fn start_workspace_dev_server(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<Vec<ExecutionProcess>, AppError> {
    let pool = &state.deployment.db().pool;

    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;

    // Get parent task
    let task = workspace
        .parent_task(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Parent task not found".to_string()))?;

    // Get parent project
    let project = task
        .parent_project(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Parent project not found".to_string()))?;

    // Stop any existing dev servers for this project
    let existing_dev_servers =
        ExecutionProcess::find_running_dev_servers_by_project(pool, project.id)
            .await
            .map_err(|e| {
                tracing::error!(
                    "Failed to find running dev servers for project {}: {}",
                    project.id,
                    e
                );
                AppError::Internal(e.to_string())
            })?;

    for dev_server in existing_dev_servers {
        tracing::info!(
            "Stopping existing dev server {} for project {}",
            dev_server.id,
            project.id
        );

        if let Err(e) = state
            .deployment
            .container()
            .stop_execution(&dev_server, ExecutionProcessStatus::Killed)
            .await
        {
            tracing::error!("Failed to stop dev server {}: {}", dev_server.id, e);
        }
    }

    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let repos_with_dev_script: Vec<_> = repos
        .iter()
        .filter(|r| r.dev_server_script.as_ref().is_some_and(|s| !s.is_empty()))
        .collect();

    if repos_with_dev_script.is_empty() {
        return Err(AppError::BadRequest(
            "No dev server script configured for any repository in this workspace".to_string(),
        ));
    }

    let session = match Session::find_latest_by_workspace_id(pool, workspace.id).await? {
        Some(s) => s,
        None => {
            Session::create(
                pool,
                &CreateSession {
                    executor: Some("dev-server".to_string()),
                },
                Uuid::new_v4(),
                workspace.id,
            )
            .await?
        }
    };

    let mut execution_processes = Vec::new();
    for repo in repos_with_dev_script {
        let executor_action = ExecutorAction::new(
            ExecutorActionType::ScriptRequest(ScriptRequest {
                script: repo.dev_server_script.clone().unwrap(),
                language: ScriptRequestLanguage::Bash,
                context: ScriptContext::DevServer,
                working_dir: Some(repo.name.clone()),
            }),
            None,
        );

        let execution_process = state
            .deployment
            .container()
            .start_execution(
                &workspace,
                &session,
                &executor_action,
                &ExecutionProcessRunReason::DevServer,
            )
            .await?;
        execution_processes.push(execution_process);
    }

    Ok(execution_processes)
}

#[tauri::command]
pub async fn install_web_companion(
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

    let container_ref = workspace
        .container_ref
        .clone()
        .ok_or_else(|| AppError::BadRequest("Workspace has no workspace directory".to_string()))?;

    let repo_root = workspace
        .repo_path(&repo)
        .unwrap_or_else(|| PathBuf::from(container_ref));
    if !repo_root.exists() {
        return Err(AppError::BadRequest(format!(
            "Repo directory does not exist: {}",
            repo_root.display()
        )));
    }

    let package_json_path = repo_root.join("package.json");
    if !package_json_path.exists() {
        return Err(AppError::BadRequest(format!(
            "package.json not found in repo root: {}",
            repo_root.display()
        )));
    }

    if let Ok(package_json) = std::fs::read_to_string(&package_json_path)
        && package_json.contains("vibe-ultra-web-companion")
    {
        return Ok(());
    }

    let (package_manager, args) = detect_package_manager(&repo_root);
    let executable = resolve_executable_path(package_manager)
        .await
        .ok_or_else(|| {
            AppError::BadRequest(format!("{} is not available on PATH", package_manager))
        })?;

    let mut install_cmd = utils::process::new_hidden_tokio_command(&executable, &args);
    install_cmd.current_dir(&repo_root);
    let output = install_cmd
        .output()
        .await
        .map_err(|e| AppError::Internal(format!("Failed to run install command: {}", e)))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let message = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("{} exited with status {}", package_manager, output.status)
    };

    Err(AppError::Internal(format!(
        "Failed to install vibe-ultra-web-companion: {}",
        message
    )))
}

#[tauri::command]
pub async fn run_agent_setup(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    executor_profile_id: ExecutorProfileId,
) -> Result<(), AppError> {
    let pool = &state.deployment.db().pool;

    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;

    let config = ExecutorConfigs::get_cached();
    let coding_agent = config.get_coding_agent_or_default(&executor_profile_id);

    match coding_agent {
        CodingAgent::Codex(ref codex) => {
            run_codex_setup_helper(&state, &workspace, codex).await?;
        }
        _ => {
            return Err(AppError::BadRequest(
                "Setup helper not supported for this executor".to_string(),
            ));
        }
    }

    Ok(())
}

async fn run_codex_setup_helper(
    state: &tauri::State<'_, AppState>,
    workspace: &Workspace,
    codex: &executors::executors::codex::Codex,
) -> Result<ExecutionProcess, AppError> {
    use executors::{
        command::{CommandBuilder, apply_overrides},
        executors::codex::Codex,
    };

    let pool = &state.deployment.db().pool;

    let latest_process = ExecutionProcess::find_latest_by_workspace_and_run_reason(
        pool,
        workspace.id,
        &ExecutionProcessRunReason::CodingAgent,
    )
    .await?;

    let mut login_command = CommandBuilder::new(Codex::base_command());
    login_command = login_command.extend_params(["login"]);
    login_command = apply_overrides(login_command, &codex.cmd)
        .map_err(|e| AppError::Internal(e.to_string()))?;

    let (program_path, args) = login_command
        .build_initial()
        .map_err(|err| AppError::Internal(format!("{}", ExecutorError::from(err))))?
        .into_resolved()
        .await
        .map_err(|err| AppError::Internal(err.to_string()))?;
    let login_script = format!("{} {}", program_path.to_string_lossy(), args.join(" "));
    let login_request = ScriptRequest {
        script: login_script,
        language: ScriptRequestLanguage::Bash,
        context: ScriptContext::ToolInstallScript,
        working_dir: None,
    };

    let setup_action = ExecutorAction::new(ExecutorActionType::ScriptRequest(login_request), None);

    let executor_action = if let Some(latest_process) = latest_process {
        let latest_action = latest_process
            .executor_action()
            .map_err(|e| AppError::Internal(e.to_string()))?;
        setup_action.append_action(latest_action.to_owned())
    } else {
        setup_action
    };

    state
        .deployment
        .container()
        .ensure_container_exists(workspace)
        .await?;

    let session = match Session::find_latest_by_workspace_id(pool, workspace.id).await? {
        Some(s) => s,
        None => {
            Session::create(
                pool,
                &CreateSession {
                    executor: Some("codex".to_string()),
                },
                Uuid::new_v4(),
                workspace.id,
            )
            .await?
        }
    };

    let execution_process = state
        .deployment
        .container()
        .start_execution(
            workspace,
            &session,
            &executor_action,
            &ExecutionProcessRunReason::SetupScript,
        )
        .await?;

    Ok(execution_process)
}

#[tauri::command]
pub async fn gh_cli_setup(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<GhCliSetupResult, AppError> {
    let pool = &state.deployment.db().pool;

    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;

    let executor_action = get_gh_cli_setup_action().await;
    let executor_action = match executor_action {
        Ok(action) => action,
        Err(AppError::BadRequest(msg)) if msg.contains("brew") => {
            return Ok(GhCliSetupResult {
                process: None,
                error: Some(GhCliSetupError::BrewMissing),
            });
        }
        Err(AppError::BadRequest(msg)) if msg.contains("not supported") => {
            return Ok(GhCliSetupResult {
                process: None,
                error: Some(GhCliSetupError::SetupHelperNotSupported),
            });
        }
        Err(e) => {
            return Ok(GhCliSetupResult {
                process: None,
                error: Some(GhCliSetupError::Other {
                    message: e.to_string(),
                }),
            });
        }
    };

    state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;

    let session = match Session::find_latest_by_workspace_id(pool, workspace.id).await? {
        Some(s) => s,
        None => {
            Session::create(
                pool,
                &CreateSession {
                    executor: Some("gh-cli".to_string()),
                },
                Uuid::new_v4(),
                workspace.id,
            )
            .await?
        }
    };

    let execution_process = state
        .deployment
        .container()
        .start_execution(
            &workspace,
            &session,
            &executor_action,
            &ExecutionProcessRunReason::SetupScript,
        )
        .await?;

    Ok(GhCliSetupResult {
        process: Some(execution_process),
        error: None,
    })
}

async fn get_gh_cli_setup_action() -> Result<ExecutorAction, AppError> {
    #[cfg(unix)]
    {
        use utils::shell::resolve_executable_path;

        if resolve_executable_path("brew").await.is_none() {
            return Err(AppError::BadRequest("brew is not available".to_string()));
        }

        let install_script = r#"#!/bin/bash
set -e
if ! command -v gh &> /dev/null; then
    echo "Installing GitHub CLI..."
    brew install gh
    echo "Installation complete!"
else
    echo "GitHub CLI already installed"
fi"#
        .to_string();

        let install_request = ScriptRequest {
            script: install_script,
            language: ScriptRequestLanguage::Bash,
            context: ScriptContext::ToolInstallScript,
            working_dir: None,
        };

        let auth_script = r#"#!/bin/bash
set -e
export GH_PROMPT_DISABLED=1
gh auth login --web --git-protocol https --skip-ssh-key
"#
        .to_string();

        let auth_request = ScriptRequest {
            script: auth_script,
            language: ScriptRequestLanguage::Bash,
            context: ScriptContext::ToolInstallScript,
            working_dir: None,
        };

        Ok(ExecutorAction::new(
            ExecutorActionType::ScriptRequest(install_request),
            Some(Box::new(ExecutorAction::new(
                ExecutorActionType::ScriptRequest(auth_request),
                None,
            ))),
        ))
    }

    #[cfg(not(unix))]
    {
        Err(AppError::BadRequest(
            "Setup helper not supported on this platform".to_string(),
        ))
    }
}

#[tauri::command]
pub async fn run_setup_script(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<RunScriptResult, AppError> {
    let pool = &state.deployment.db().pool;

    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;

    if ExecutionProcess::has_running_non_dev_server_processes_for_workspace(pool, workspace.id)
        .await?
    {
        return Ok(RunScriptResult {
            process: None,
            error: Some(RunScriptError::ProcessAlreadyRunning),
        });
    }

    state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;

    let task = workspace
        .parent_task(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Parent task not found".to_string()))?;

    let _project = task
        .parent_project(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Parent project not found".to_string()))?;

    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let executor_action = match state.deployment.container().setup_actions_for_repos(&repos) {
        Some(action) => action,
        None => {
            return Ok(RunScriptResult {
                process: None,
                error: Some(RunScriptError::NoScriptConfigured),
            });
        }
    };

    let session = match Session::find_latest_by_workspace_id(pool, workspace.id).await? {
        Some(s) => s,
        None => {
            Session::create(
                pool,
                &CreateSession { executor: None },
                Uuid::new_v4(),
                workspace.id,
            )
            .await?
        }
    };

    let execution_process = state
        .deployment
        .container()
        .start_execution(
            &workspace,
            &session,
            &executor_action,
            &ExecutionProcessRunReason::SetupScript,
        )
        .await?;

    Ok(RunScriptResult {
        process: Some(execution_process),
        error: None,
    })
}

#[tauri::command]
pub async fn run_cleanup_script(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<RunScriptResult, AppError> {
    let pool = &state.deployment.db().pool;

    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;

    if ExecutionProcess::has_running_non_dev_server_processes_for_workspace(pool, workspace.id)
        .await?
    {
        return Ok(RunScriptResult {
            process: None,
            error: Some(RunScriptError::ProcessAlreadyRunning),
        });
    }

    state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;

    let task = workspace
        .parent_task(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Parent task not found".to_string()))?;

    let _project = task
        .parent_project(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Parent project not found".to_string()))?;

    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let executor_action = match state
        .deployment
        .container()
        .cleanup_actions_for_repos(&repos)
    {
        Some(action) => action,
        None => {
            return Ok(RunScriptResult {
                process: None,
                error: Some(RunScriptError::NoScriptConfigured),
            });
        }
    };

    let session = match Session::find_latest_by_workspace_id(pool, workspace.id).await? {
        Some(s) => s,
        None => {
            Session::create(
                pool,
                &CreateSession { executor: None },
                Uuid::new_v4(),
                workspace.id,
            )
            .await?
        }
    };

    let execution_process = state
        .deployment
        .container()
        .start_execution(
            &workspace,
            &session,
            &executor_action,
            &ExecutionProcessRunReason::CleanupScript,
        )
        .await?;

    Ok(RunScriptResult {
        process: Some(execution_process),
        error: None,
    })
}

#[tauri::command]
pub async fn run_archive_script(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<RunScriptResult, AppError> {
    let pool = &state.deployment.db().pool;

    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;

    if ExecutionProcess::has_running_non_dev_server_processes_for_workspace(pool, workspace.id)
        .await?
    {
        return Ok(RunScriptResult {
            process: None,
            error: Some(RunScriptError::ProcessAlreadyRunning),
        });
    }

    state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;

    let task = workspace
        .parent_task(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Parent task not found".to_string()))?;

    let _project = task
        .parent_project(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Parent project not found".to_string()))?;

    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let executor_action = match state
        .deployment
        .container()
        .archive_actions_for_repos(&repos)
    {
        Some(action) => action,
        None => {
            return Ok(RunScriptResult {
                process: None,
                error: Some(RunScriptError::NoScriptConfigured),
            });
        }
    };

    let session = match Session::find_latest_by_workspace_id(pool, workspace.id).await? {
        Some(s) => s,
        None => {
            Session::create(
                pool,
                &CreateSession { executor: None },
                Uuid::new_v4(),
                workspace.id,
            )
            .await?
        }
    };

    let execution_process = state
        .deployment
        .container()
        .start_execution(
            &workspace,
            &session,
            &executor_action,
            &ExecutionProcessRunReason::ArchiveScript,
        )
        .await?;

    Ok(RunScriptResult {
        process: Some(execution_process),
        error: None,
    })
}

#[tauri::command]
pub async fn open_workspace_in_editor(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    editor_type: Option<String>,
    file_path: Option<String>,
) -> Result<OpenEditorResponse, AppError> {
    let pool = &state.deployment.db().pool;

    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;

    let container_ref = state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;

    Workspace::touch(pool, workspace.id).await?;

    let workspace_path = Path::new(&container_ref);

    // For single-repo projects, open from the repo directory
    let workspace_repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let workspace_path = if workspace_repos.len() == 1 && file_path.is_none() {
        if workspace.use_worktree {
            workspace_path.join(&workspace_repos[0].name)
        } else {
            workspace_path.to_path_buf()
        }
    } else {
        workspace_path.to_path_buf()
    };

    // If a specific file path is provided, use it; otherwise use the base path
    let path = if let Some(ref fp) = file_path {
        workspace_path.join(fp)
    } else {
        workspace_path
    };

    let editor_config = {
        let config = state.deployment.config().read().await;
        let editor_type_str = editor_type.as_deref();
        config.editor.with_override(editor_type_str)
    };

    match editor_config.open_file(path.as_path()).await {
        Ok(url) => {
            tracing::info!(
                "Opened editor for workspace {} at path: {}{}",
                workspace.id,
                path.display(),
                if url.is_some() { " (remote mode)" } else { "" }
            );

            Ok(OpenEditorResponse { url })
        }
        Err(e) => {
            tracing::error!(
                "Failed to open editor for workspace {}: {:?}",
                workspace.id,
                e
            );
            Err(AppError::Internal(format!("Failed to open editor: {}", e)))
        }
    }
}

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

    let repos =
        WorkspaceRepo::find_repos_with_target_branch_for_workspace(pool, workspace_id).await?;

    Ok(repos)
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
    let pool = &state.deployment.db().pool;
    CodingAgentTurn::mark_seen_by_workspace_id(pool, workspace_id).await?;
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
async fn resolve_worktree_path(
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

#[tauri::command]
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
            if auto_generate_description.unwrap_or(false) {
                if let Err(e) = trigger_pr_description_follow_up(
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
                &CreateSession { executor: None },
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

    let working_dir = workspace
        .agent_working_dir
        .as_ref()
        .filter(|dir| !dir.is_empty())
        .cloned();

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
            if !workspace.pinned {
                if let Err(e) = state
                    .deployment
                    .container()
                    .archive_workspace(workspace.id)
                    .await
                {
                    tracing::error!("Failed to archive workspace {}: {}", workspace.id, e);
                }
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
        if let Some(setup_action) = state.deployment.container().setup_actions_for_repos(&repos) {
            let session = Session::create(
                pool,
                &CreateSession { executor: None },
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

// --- Commit operations ---

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
