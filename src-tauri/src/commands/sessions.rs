use std::path::PathBuf;

use db::models::{
    coding_agent_turn::CodingAgentTurn,
    execution_process::{ExecutionProcess, ExecutionProcessRunReason},
    project_repo::ProjectRepo,
    scratch::{DraftFollowUpData, Scratch, ScratchType},
    session::{CreateSession, Session, SessionStatus},
    task::{CreateTask, Task, TaskStatus},
    workspace::{CreateWorkspace, Workspace},
    workspace_repo::{CreateWorkspaceRepo, WorkspaceRepo},
};
use deployment::Deployment;
use executors::{
    actions::{
        ExecutorAction, ExecutorActionType,
        coding_agent_follow_up::CodingAgentFollowUpRequest,
        coding_agent_initial::CodingAgentInitialRequest,
        review::{RepoReviewContext as ExecutorRepoReviewContext, ReviewRequest as ReviewAction},
    },
    executors::build_review_prompt,
    profile::{ExecutorConfig, ExecutorProfileId},
};
use serde::Serialize;
use services::services::{container::ContainerService, queued_message::QueueStatus};
use sqlx::types::chrono::{DateTime, Utc};
use ts_rs::TS;
use uuid::Uuid;

use crate::{error::AppError, state::AppState};

#[derive(Debug, Clone, Serialize, TS)]
pub struct SessionSummary {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub task_id: Option<Uuid>,
    pub name: Option<String>,
    pub display_name: String,
    pub status: SessionStatus,
    pub executor: Option<String>,
    pub workspace_name: Option<String>,
    pub workspace_branch: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub first_prompt: Option<String>,
    pub is_running: bool,
}

fn build_session_display_name(session: &Session, first_prompt: Option<&str>) -> String {
    session
        .name
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .or_else(|| {
            first_prompt
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "新会话".to_string())
}

fn to_task_status(status: SessionStatus) -> TaskStatus {
    match status {
        SessionStatus::Todo => TaskStatus::Todo,
        SessionStatus::InProgress => TaskStatus::InProgress,
        SessionStatus::InReview => TaskStatus::InReview,
        SessionStatus::Done => TaskStatus::Done,
    }
}

const PROJECT_ROOT_TASK_TITLE: &str = "Project Root Workspace";

async fn ensure_project_root_workspace(
    state: &AppState,
    project_id: Uuid,
) -> Result<Workspace, AppError> {
    let pool = &state.deployment.db().pool;

    let repos = ProjectRepo::find_repos_for_project(pool, project_id).await?;
    let primary_repo = repos
        .into_iter()
        .next()
        .ok_or_else(|| AppError::BadRequest("Project has no repositories".to_string()))?;

    let current_branch = state
        .deployment
        .git()
        .get_current_branch(&primary_repo.path)
        .map_err(|e| AppError::Internal(format!("Failed to resolve current branch: {e}")))?;

    let workspace_repos = vec![CreateWorkspaceRepo {
        repo_id: primary_repo.id,
        target_branch: current_branch.clone(),
    }];

    if let Some(workspace_id) =
        WorkspaceRepo::find_reusable_non_worktree_workspace_id(pool, project_id, &workspace_repos)
            .await?
        && let Some(workspace) = Workspace::find_by_id(pool, workspace_id).await?
    {
        return Ok(workspace);
    }

    let owner_task = if let Some(task) = Task::find_by_project_id_with_attempt_status(pool, project_id)
        .await?
        .into_iter()
        .map(|task| task.task)
        .next()
    {
        task
    } else {
        Task::create(
            pool,
            &CreateTask {
                project_id,
                title: format!("{} ({})", PROJECT_ROOT_TASK_TITLE, primary_repo.name),
                description: Some(
                    "Auto-created to support sessions on the project root branch.".to_string(),
                ),
                status: Some(TaskStatus::Todo),
                parent_workspace_id: None,
                image_ids: None,
            },
            Uuid::new_v4(),
        )
        .await?
    };

    let workspace = Workspace::create(
        pool,
        &CreateWorkspace {
            branch: current_branch.clone(),
            container_ref: Some(primary_repo.path.to_string_lossy().to_string()),
            use_worktree: false,
            agent_working_dir: primary_repo.default_working_dir.clone(),
        },
        Uuid::new_v4(),
        owner_task.id,
    )
    .await?;

    WorkspaceRepo::create_many(pool, workspace.id, &workspace_repos).await?;

    let workspace_display_name = if primary_repo.display_name.trim().is_empty() {
        primary_repo.name.as_str()
    } else {
        primary_repo.display_name.as_str()
    };
    let workspace_name = format!("{} · {}", workspace_display_name, current_branch);
    Workspace::update(pool, workspace.id, Some(false), None, Some(workspace_name.as_str())).await?;

    Workspace::find_by_id(pool, workspace.id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace.id)))
}

// --- Commands ---

/// List all sessions for a workspace.
#[tauri::command]
pub async fn get_sessions(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<Vec<Session>, AppError> {
    let pool = &state.deployment.db().pool;
    let sessions = Session::find_by_workspace_id(pool, workspace_id).await?;
    Ok(sessions)
}

/// List all session summaries for a workspace.
#[tauri::command]
pub async fn get_session_summaries(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<Vec<SessionSummary>, AppError> {
    let pool = &state.deployment.db().pool;
    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;
    let sessions = Session::find_by_workspace_id(pool, workspace_id).await?;

    let mut summaries = Vec::with_capacity(sessions.len());
    for session in sessions {
        let first_prompt =
            CodingAgentTurn::find_first_prompt_by_session_id(pool, session.id).await?;
        let is_running =
            ExecutionProcess::has_running_non_dev_server_processes_for_session(pool, session.id)
                .await?;

        summaries.push(SessionSummary {
            id: session.id,
            workspace_id: session.workspace_id,
            task_id: session.task_id,
            name: session.name.clone(),
            display_name: build_session_display_name(&session, first_prompt.as_deref()),
            status: session.status.clone(),
            executor: session.executor.clone(),
            workspace_name: workspace.name.clone(),
            workspace_branch: workspace.branch.clone(),
            created_at: session.created_at,
            updated_at: session.updated_at,
            first_prompt,
            is_running,
        });
    }

    Ok(summaries)
}

/// Get a single session by ID.
#[tauri::command]
pub async fn get_session(
    state: tauri::State<'_, AppState>,
    session_id: Uuid,
) -> Result<Session, AppError> {
    let pool = &state.deployment.db().pool;
    let session = Session::find_by_id(pool, session_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Session {} not found", session_id)))?;
    Ok(session)
}

/// Create a new session for a workspace.
#[tauri::command]
pub async fn create_session(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    executor: Option<String>,
    name: Option<String>,
    task_id: Option<Uuid>,
) -> Result<Session, AppError> {
    let pool = &state.deployment.db().pool;

    // Verify workspace exists
    let _workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;

    if let Some(task_id) = task_id {
        let _task = Task::find_by_id(pool, task_id)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Task {} not found", task_id)))?;
    }

    let session = Session::create(
        pool,
        &CreateSession {
            executor,
            task_id,
            name,
            status: Some(SessionStatus::Todo),
        },
        Uuid::new_v4(),
        workspace_id,
    )
    .await?;

    Ok(session)
}

/// Create a session by reusing/creating a non-worktree workspace that points to
/// the project's current repository branch.
#[tauri::command]
pub async fn create_project_root_session(
    state: tauri::State<'_, AppState>,
    project_id: Uuid,
    executor: Option<String>,
    name: Option<String>,
) -> Result<Session, AppError> {
    let pool = &state.deployment.db().pool;
    let workspace = ensure_project_root_workspace(state.inner(), project_id).await?;

    let session = Session::create(
        pool,
        &CreateSession {
            executor,
            task_id: Some(workspace.task_id),
            name,
            status: Some(SessionStatus::Todo),
        },
        Uuid::new_v4(),
        workspace.id,
    )
    .await?;

    Ok(session)
}

#[tauri::command]
pub async fn rename_session(
    state: tauri::State<'_, AppState>,
    session_id: Uuid,
    name: Option<String>,
) -> Result<Session, AppError> {
    let pool = &state.deployment.db().pool;
    let session = Session::find_by_id(pool, session_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Session {} not found", session_id)))?;

    Session::update_name(pool, session.id, name.as_deref()).await?;

    Session::find_by_id(pool, session_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Session {} not found", session_id)))
}

#[tauri::command]
pub async fn update_session_status(
    state: tauri::State<'_, AppState>,
    session_id: Uuid,
    status: SessionStatus,
) -> Result<Session, AppError> {
    let pool = &state.deployment.db().pool;
    let session = Session::find_by_id(pool, session_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Session {} not found", session_id)))?;

    Session::update_status(pool, session.id, status.clone()).await?;

    if let Some(task_id) = session.task_id {
        Task::update_status(pool, task_id, to_task_status(status)).await?;
    }

    Session::find_by_id(pool, session_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Session {} not found", session_id)))
}

/// Delete a session by ID.
#[tauri::command]
pub async fn delete_session(
    state: tauri::State<'_, AppState>,
    session_id: Uuid,
) -> Result<(), AppError> {
    let pool = &state.deployment.db().pool;

    let _session = Session::find_by_id(pool, session_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Session {} not found", session_id)))?;

    if ExecutionProcess::has_running_non_dev_server_processes_for_session(pool, session_id).await? {
        return Err(AppError::Conflict("会话仍在执行，无法删除".to_string()));
    }

    Scratch::delete_all_by_id(pool, session_id).await?;

    let deleted_rows = Session::delete(pool, session_id).await?;
    if deleted_rows == 0 {
        return Err(AppError::NotFound(format!(
            "Session {} not found",
            session_id
        )));
    }

    state
        .deployment
        .queued_message_service()
        .cancel_queued(session_id);

    Ok(())
}

/// Send a follow-up (or initial) prompt to the coding agent within a session.
#[tauri::command]
pub async fn follow_up(
    state: tauri::State<'_, AppState>,
    session_id: Uuid,
    prompt: String,
    executor_profile_id: ExecutorProfileId,
    retry_process_id: Option<Uuid>,
    force_when_dirty: Option<bool>,
    perform_git_reset: Option<bool>,
) -> Result<ExecutionProcess, AppError> {
    let pool = &state.deployment.db().pool;

    // Look up session
    let session = Session::find_by_id(pool, session_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Session {} not found", session_id)))?;

    // Load workspace from session
    let workspace = Workspace::find_by_id(pool, session.workspace_id)
        .await?
        .ok_or_else(|| {
            AppError::NotFound(format!("Workspace {} not found", session.workspace_id))
        })?;

    tracing::info!("{:?}", workspace);

    // Ensure container exists
    state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;

    // Validate executor matches session if session has prior executions
    let expected_executor: Option<String> =
        ExecutionProcess::latest_executor_profile_for_session(pool, session.id)
            .await?
            .map(|profile| profile.executor.to_string())
            .or_else(|| session.executor.clone());

    if let Some(expected) = expected_executor {
        let actual = executor_profile_id.executor.to_string();
        if expected != actual {
            return Err(AppError::BadRequest(format!(
                "Executor mismatch: expected {}, got {}",
                expected, actual
            )));
        }
    }

    // Update session executor if not set
    if session.executor.is_none() {
        Session::update_executor(pool, session.id, &executor_profile_id.executor.to_string())
            .await?;
    }

    // Handle retry (optional git reset)
    if let Some(proc_id) = retry_process_id {
        let force = force_when_dirty.unwrap_or(false);
        let git_reset = perform_git_reset.unwrap_or(true);
        state
            .deployment
            .container()
            .reset_session_to_process(session.id, proc_id, git_reset, force)
            .await?;
    }

    // Get latest session info after any reset has been applied.
    //
    // Important executor-specific behavior:
    // - Claude keeps one underlying session and needs reset_to_message_id to
    //   truncate history inside that session.
    // - Codex and OpenCode fork a new snapshot session on every follow-up.
    //   After reset_session_to_process() drops the target process and later
    //   turns, the "latest" remaining agent_session_id already represents the
    //   exact context from before the retried message. In those executors the
    //   session_id is the rollback mechanism; reset_to_message_id is not used.
    let latest_session_info = CodingAgentTurn::find_latest_session_info(pool, session.id).await?;

    // Get repos for cleanup action
    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let cleanup_action = state
        .deployment
        .container()
        .cleanup_actions_for_repos(&repos);

    // Compute working_dir
    let working_dir = workspace
        .agent_working_dir
        .as_ref()
        .filter(|dir| !dir.is_empty())
        .cloned();

    // Build action type (FollowUp vs Initial)
    let action_type = if let Some(info) = latest_session_info {
        let is_reset = retry_process_id.is_some();
        ExecutorActionType::CodingAgentFollowUpRequest(CodingAgentFollowUpRequest {
            prompt: prompt.clone(),
            session_id: info.session_id,
            reset_to_message_id: if is_reset { info.message_id } else { None },
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

    // Create and start execution
    let action = ExecutorAction::new(action_type, cleanup_action.map(Box::new));

    let execution_process = state
        .deployment
        .container()
        .start_execution(
            &workspace,
            &session,
            &action,
            &ExecutionProcessRunReason::CodingAgent,
        )
        .await?;

    // Clear the draft follow-up scratch on successful spawn (best-effort)
    if let Err(e) = Scratch::delete(pool, session.id, &ScratchType::DraftFollowUp).await {
        tracing::debug!(
            "Failed to delete draft follow-up scratch for session {}: {}",
            session.id,
            e
        );
    }

    Ok(execution_process)
}

/// Reset a session to a specific execution process (undo/retry).
#[tauri::command]
pub async fn reset_session_process(
    state: tauri::State<'_, AppState>,
    session_id: Uuid,
    process_id: Uuid,
    force_when_dirty: Option<bool>,
    perform_git_reset: Option<bool>,
) -> Result<(), AppError> {
    // Look up session (validate it exists)
    let _session = Session::find_by_id(&state.deployment.db().pool, session_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Session {} not found", session_id)))?;

    let force = force_when_dirty.unwrap_or(false);
    let git_reset = perform_git_reset.unwrap_or(true);

    state
        .deployment
        .container()
        .reset_session_to_process(session_id, process_id, git_reset, force)
        .await?;

    Ok(())
}

/// Start a code review within a session.
#[tauri::command]
pub async fn start_review(
    state: tauri::State<'_, AppState>,
    session_id: Uuid,
    executor_profile_id: ExecutorProfileId,
    additional_prompt: Option<String>,
    use_all_workspace_commits: Option<bool>,
) -> Result<ExecutionProcess, AppError> {
    let pool = &state.deployment.db().pool;

    // Look up session
    let session = Session::find_by_id(pool, session_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Session {} not found", session_id)))?;

    // Load workspace from session
    let workspace = Workspace::find_by_id(pool, session.workspace_id)
        .await?
        .ok_or_else(|| {
            AppError::NotFound(format!("Workspace {} not found", session.workspace_id))
        })?;

    // Check no running processes within the same session
    if ExecutionProcess::has_running_non_dev_server_processes_for_session(pool, session.id).await? {
        return Err(AppError::Conflict("Process already running".to_string()));
    }

    // Ensure container
    let container_ref = state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;

    // Get agent session info
    let agent_session_id = CodingAgentTurn::find_latest_session_info(pool, session.id)
        .await?
        .map(|info| info.session_id);

    // Build review context (if use_all_workspace_commits)
    let use_all = use_all_workspace_commits.unwrap_or(false);
    let context: Option<Vec<ExecutorRepoReviewContext>> = if use_all {
        let repos =
            WorkspaceRepo::find_repos_with_target_branch_for_workspace(pool, workspace.id).await?;
        let workspace_path = PathBuf::from(container_ref.as_str());

        let mut contexts = Vec::new();
        for repo in repos {
            let worktree_path = workspace
                .repo_path(&repo.repo)
                .unwrap_or_else(|| workspace_path.clone());
            if let Ok(base_commit) = state.deployment.git().get_fork_point(
                &worktree_path,
                &repo.target_branch,
                &workspace.branch,
            ) {
                contexts.push(ExecutorRepoReviewContext {
                    repo_id: repo.repo.id,
                    repo_name: repo.repo.display_name,
                    base_commit,
                });
            }
        }
        if contexts.is_empty() {
            None
        } else {
            Some(contexts)
        }
    } else {
        None
    };

    // Build prompt
    let prompt = build_review_prompt(context.as_deref(), additional_prompt.as_deref());

    // Create action and start
    let action = ExecutorAction::new(
        ExecutorActionType::ReviewRequest(ReviewAction {
            executor_config: ExecutorConfig::from(executor_profile_id.clone()),
            context,
            prompt,
            session_id: agent_session_id,
            working_dir: workspace.agent_working_dir.clone(),
        }),
        None,
    );

    let execution_process = state
        .deployment
        .container()
        .start_execution(
            &workspace,
            &session,
            &action,
            &ExecutionProcessRunReason::CodingAgent,
        )
        .await?;

    Ok(execution_process)
}

/// Queue a follow-up message to be executed when the current execution finishes.
#[tauri::command]
pub async fn queue_message(
    state: tauri::State<'_, AppState>,
    session_id: Uuid,
    message: String,
    executor_profile_id: ExecutorProfileId,
) -> Result<QueueStatus, AppError> {
    // Look up session (validate it exists)
    let _session = Session::find_by_id(&state.deployment.db().pool, session_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Session {} not found", session_id)))?;

    let data = DraftFollowUpData {
        message,
        executor_config: ExecutorConfig::from(executor_profile_id),
    };

    let queued = state
        .deployment
        .queued_message_service()
        .queue_message(session_id, data);

    Ok(QueueStatus::Queued { message: queued })
}

/// Cancel a queued follow-up message.
#[tauri::command]
pub async fn cancel_queued_message(
    state: tauri::State<'_, AppState>,
    session_id: Uuid,
) -> Result<QueueStatus, AppError> {
    // Look up session (validate it exists)
    let _session = Session::find_by_id(&state.deployment.db().pool, session_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Session {} not found", session_id)))?;

    state
        .deployment
        .queued_message_service()
        .cancel_queued(session_id);

    Ok(QueueStatus::Empty)
}

/// Get the current queue status for a session.
#[tauri::command]
pub async fn get_queue_status(
    state: tauri::State<'_, AppState>,
    session_id: Uuid,
) -> Result<QueueStatus, AppError> {
    // Look up session (validate it exists)
    let _session = Session::find_by_id(&state.deployment.db().pool, session_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Session {} not found", session_id)))?;

    let status = state
        .deployment
        .queued_message_service()
        .get_status(session_id);

    Ok(status)
}
