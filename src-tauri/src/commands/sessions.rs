use std::path::{Path, PathBuf};

use db::models::{
    execution_process::ExecutionProcess,
    project_repo::ProjectRepo,
    repo::{Repo, RepoError},
    scratch::Scratch,
    session::{CreateSession, Session, SessionStatus},
    task::{CreateTask, Task, TaskStatus},
    workspace::{CreateWorkspace, Workspace},
    workspace_repo::{CreateWorkspaceRepo, WorkspaceRepo},
};
use serde::Serialize;
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
    pub continuity_mode: SessionContinuityMode,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum SessionContinuityMode {
    NewSession,
    ResumeInPlace,
}

fn derive_session_continuity_mode(has_resume_context: bool) -> SessionContinuityMode {
    if has_resume_context {
        SessionContinuityMode::ResumeInPlace
    } else {
        SessionContinuityMode::NewSession
    }
}

fn build_session_display_name(
    session: &Session,
    first_prompt: Option<&str>,
    fallback_number: usize,
) -> String {
    session
        .name
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .or_else(|| {
            first_prompt
                .map(|value| value.split_whitespace().collect::<Vec<_>>().join(" "))
                .filter(|value| !value.is_empty())
                .map(|value| value.chars().take(8).collect())
        })
        .unwrap_or_else(|| format!("新会话{fallback_number}"))
}

fn to_task_status(status: SessionStatus) -> TaskStatus {
    match status {
        SessionStatus::Todo => TaskStatus::Todo,
        SessionStatus::InProgress => TaskStatus::InProgress,
        SessionStatus::InReview => TaskStatus::InReview,
        SessionStatus::Done => TaskStatus::Done,
        SessionStatus::Archived => TaskStatus::Done,
    }
}

const PROJECT_ROOT_TASK_TITLE: &str = "Project Root Workspace";
const NEW_SESSION_WORKSPACE_TITLE: &str = "New Session Workspace";

#[derive(Debug, serde::Deserialize, Clone)]
pub struct ProjectSessionRepoInput {
    pub repo_id: Uuid,
    pub target_branch: String,
}

#[derive(Debug, serde::Deserialize, Clone)]
pub struct CreateProjectSessionPayload {
    /// UUID reserved by a Prepared ACP Session. When present, the persisted
    /// conversation adopts that same identity so no second ACP session is
    /// created on the first turn.
    pub session_id: Option<Uuid>,
    pub project_id: Uuid,
    pub workspace_id: Option<Uuid>,
    pub branch: Option<String>,
    pub executor: Option<String>,
    pub name: Option<String>,
    pub initial_prompt: Option<String>,
    pub create_workspace: Option<bool>,
    pub repos: Option<Vec<ProjectSessionRepoInput>>,
}

fn derive_workspace_seed_title(name: Option<&str>, initial_prompt: Option<&str>) -> String {
    if let Some(name) = name.map(str::trim).filter(|name| !name.is_empty()) {
        return name.to_string();
    }

    if let Some(prompt) = initial_prompt
        .map(str::trim)
        .filter(|prompt| !prompt.is_empty())
    {
        return prompt.chars().take(40).collect();
    }

    NEW_SESSION_WORKSPACE_TITLE.to_string()
}

fn normalize_branch_name(branch: &str) -> String {
    branch.trim().to_lowercase()
}

fn canonicalize_for_workspace_safety(path: &Path) -> PathBuf {
    if let Ok(path) = std::fs::canonicalize(path) {
        return path;
    }

    let mut missing_segments = Vec::new();
    let mut cursor = path;
    while !cursor.exists() {
        let Some(name) = cursor.file_name() else {
            break;
        };
        missing_segments.push(name.to_os_string());
        let Some(parent) = cursor.parent() else {
            break;
        };
        cursor = parent;
    }

    let mut resolved = std::fs::canonicalize(cursor).unwrap_or_else(|_| cursor.to_path_buf());
    for segment in missing_segments.iter().rev() {
        resolved.push(segment);
    }
    resolved
}

fn workspace_container_overlaps_repo(workspace: &Workspace, repos: &[Repo]) -> bool {
    if !workspace.use_worktree {
        return false;
    }

    let Some(container_ref) = workspace.container_ref.as_deref() else {
        return false;
    };

    let container_path = canonicalize_for_workspace_safety(Path::new(container_ref));
    repos.iter().any(|repo| {
        let repo_path = canonicalize_for_workspace_safety(&repo.path);
        container_path == repo_path
            || container_path.starts_with(&repo_path)
            || repo_path.starts_with(&container_path)
    })
}

async fn find_matching_project_worktree_workspace(
    state: &AppState,
    project_id: Uuid,
    branch: &str,
) -> Result<Option<Workspace>, AppError> {
    let pool = &state.deployment.db().pool;
    let normalized_branch = normalize_branch_name(branch);
    let repos = ProjectRepo::find_repos_for_project(pool, project_id).await?;
    let mut workspaces = Workspace::fetch_by_project_id(pool, project_id).await?;
    workspaces.retain(|workspace| {
        workspace.use_worktree
            && !workspace.archived
            && normalize_branch_name(&workspace.branch) == normalized_branch
            && !workspace_container_overlaps_repo(workspace, &repos)
    });
    workspaces.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then(right.created_at.cmp(&left.created_at))
    });

    Ok(workspaces.into_iter().next())
}

pub(crate) async fn resolve_project_workspace(
    state: &AppState,
    project_id: Uuid,
    branch: Option<&str>,
) -> Result<Workspace, AppError> {
    let desired_branch = branch
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);

    if let Some(ref desired_branch) = desired_branch
        && let Some(workspace) =
            find_matching_project_worktree_workspace(state, project_id, desired_branch).await?
    {
        return Ok(workspace);
    }

    ensure_project_root_workspace(state, project_id, desired_branch.as_deref()).await
}

async fn create_worktree_workspace_for_project_session(
    state: &AppState,
    project_id: Uuid,
    name: Option<&str>,
    initial_prompt: Option<&str>,
    repos: &[ProjectSessionRepoInput],
) -> Result<Workspace, AppError> {
    if repos.is_empty() {
        return Err(AppError::BadRequest(
            "At least one repository is required".to_string(),
        ));
    }

    let pool = &state.deployment.db().pool;
    let workspace_title = derive_workspace_seed_title(name, initial_prompt);
    let task = Task::create(
        pool,
        &CreateTask {
            project_id,
            title: workspace_title.clone(),
            description: initial_prompt.map(ToOwned::to_owned),
            status: Some(TaskStatus::Todo),
            parent_workspace_id: None,
            image_ids: None,
        },
        Uuid::new_v4(),
    )
    .await?;

    let primary_repo = if repos.len() == 1 {
        Some(
            Repo::find_by_id(pool, repos[0].repo_id)
                .await?
                .ok_or(RepoError::NotFound)?,
        )
    } else {
        None
    };

    let agent_working_dir = if repos.len() == 1 {
        let repo = primary_repo.as_ref().ok_or(RepoError::NotFound)?;
        match &repo.default_working_dir {
            Some(subdir) => {
                let path = PathBuf::from(&repo.name).join(subdir);
                Some(path.to_string_lossy().to_string())
            }
            None => Some(repo.name.clone()),
        }
    } else {
        None
    };

    let workspace_id = Uuid::new_v4();
    let branch = state
        .deployment
        .container()
        .git_branch_from_workspace(&workspace_id, &workspace_title)
        .await;

    let workspace = Workspace::create(
        pool,
        &CreateWorkspace {
            project_id,
            parent_workspace_id: None,
            branch,
            container_ref: None,
            use_worktree: true,
            agent_working_dir,
        },
        workspace_id,
        task.id,
    )
    .await?;

    Workspace::update(
        pool,
        workspace.id,
        None,
        None,
        Some(workspace_title.as_str()),
    )
    .await?;

    let workspace_repos: Vec<CreateWorkspaceRepo> = repos
        .iter()
        .map(|repo| CreateWorkspaceRepo {
            repo_id: repo.repo_id,
            target_branch: repo.target_branch.clone(),
        })
        .collect();
    WorkspaceRepo::create_many(pool, workspace.id, &workspace_repos).await?;

    Workspace::find_by_id(pool, workspace.id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace.id)))
}

async fn ensure_project_root_workspace(
    state: &AppState,
    project_id: Uuid,
    branch: Option<&str>,
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
    let desired_branch = branch
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| current_branch.clone());

    if desired_branch != current_branch {
        state
            .deployment
            .git()
            .checkout_branch(&primary_repo.path, &desired_branch)
            .map_err(|e| {
                if git_checkout_error_is_local_changes(&e.to_string()) {
                    return AppError::BadRequest(format!(
                        "当前分支{current_branch}中存在未提交更改，无法切换到{desired_branch}分支，请先提交或放弃更改。"
                    ));
                }

                AppError::Internal(format!(
                    "Failed to checkout project root branch '{desired_branch}': {e}"
                ))
            })?;
    }

    let workspace_repos = vec![CreateWorkspaceRepo {
        repo_id: primary_repo.id,
        target_branch: desired_branch.clone(),
    }];

    if let Some(workspace_id) =
        WorkspaceRepo::find_reusable_non_worktree_workspace_id(pool, project_id, &workspace_repos)
            .await?
        && let Some(mut workspace) = Workspace::find_by_id(pool, workspace_id).await?
    {
        let expected_container_ref = primary_repo.path.to_string_lossy().to_string();
        if workspace.container_ref.as_deref() != Some(expected_container_ref.as_str()) {
            Workspace::update_container_ref(pool, workspace.id, &expected_container_ref).await?;
            workspace.container_ref = Some(expected_container_ref);
        }

        if workspace.agent_working_dir != primary_repo.default_working_dir {
            sqlx::query(
                "UPDATE workspaces SET agent_working_dir = ?, updated_at = datetime('now', 'subsec') WHERE id = ?",
            )
            .bind(primary_repo.default_working_dir.as_deref())
            .bind(workspace.id)
            .execute(pool)
            .await?;
            workspace.agent_working_dir = primary_repo.default_working_dir.clone();
        }

        return Ok(workspace);
    }

    let owner_task = if let Some(task) =
        Task::find_by_project_id_with_attempt_status(pool, project_id)
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
            project_id,
            parent_workspace_id: None,
            branch: desired_branch.clone(),
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
    let workspace_name = format!("{} · {}", workspace_display_name, desired_branch);
    Workspace::update(
        pool,
        workspace.id,
        Some(false),
        None,
        Some(workspace_name.as_str()),
    )
    .await?;

    Workspace::find_by_id(pool, workspace.id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace.id)))
}

fn git_checkout_error_is_local_changes(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    normalized.contains("local changes") && normalized.contains("would be overwritten by checkout")
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
    let mut fallback_number = 0;
    for session in sessions {
        let first_prompt = session.initial_prompt.clone();
        let needs_fallback_name = session
            .name
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
            && first_prompt
                .as_deref()
                .is_none_or(|value| value.trim().is_empty());
        if needs_fallback_name {
            fallback_number += 1;
        }
        let is_running =
            ExecutionProcess::has_running_non_dev_server_processes_for_session(pool, session.id)
                .await?;
        let continuity_mode = derive_session_continuity_mode(false);

        summaries.push(SessionSummary {
            id: session.id,
            workspace_id: session.workspace_id,
            task_id: session.task_id,
            name: session.name.clone(),
            display_name: build_session_display_name(
                &session,
                first_prompt.as_deref(),
                fallback_number,
            ),
            status: session.status.clone(),
            executor: session.executor.clone(),
            workspace_name: workspace.name.clone(),
            workspace_branch: workspace.branch.clone(),
            created_at: session.created_at,
            updated_at: session.updated_at,
            first_prompt,
            is_running,
            continuity_mode,
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
    initial_prompt: Option<String>,
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
            initial_prompt,
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
    let workspace = ensure_project_root_workspace(state.inner(), project_id, None).await?;

    let session = Session::create(
        pool,
        &CreateSession {
            executor,
            task_id: Some(workspace.task_id),
            name,
            initial_prompt: None,
            status: Some(SessionStatus::Todo),
        },
        Uuid::new_v4(),
        workspace.id,
    )
    .await?;

    Ok(session)
}

#[tauri::command]
pub async fn ensure_project_workspace(
    state: tauri::State<'_, AppState>,
    project_id: Uuid,
    branch: Option<String>,
) -> Result<Workspace, AppError> {
    let workspace = resolve_project_workspace(state.inner(), project_id, branch.as_deref()).await?;

    state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;

    Ok(workspace)
}

/// Create a project-scoped session, optionally targeting an existing workspace.
/// If no workspace is provided, reuse or create the project root workspace.
#[tauri::command]
pub async fn create_project_session(
    state: tauri::State<'_, AppState>,
    payload: CreateProjectSessionPayload,
) -> Result<Session, AppError> {
    let pool = &state.deployment.db().pool;
    let workspace = if payload.create_workspace.unwrap_or(false) {
        create_worktree_workspace_for_project_session(
            state.inner(),
            payload.project_id,
            payload.name.as_deref(),
            payload.initial_prompt.as_deref(),
            payload.repos.as_deref().unwrap_or(&[]),
        )
        .await?
    } else if let Some(workspace_id) = payload.workspace_id {
        let workspace = Workspace::find_by_id(pool, workspace_id)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;
        if workspace.project_id != payload.project_id {
            return Err(AppError::BadRequest(format!(
                "Workspace {} does not belong to project {}",
                workspace_id, payload.project_id
            )));
        }
        let repos = ProjectRepo::find_repos_for_project(pool, payload.project_id).await?;
        // A Prepared ACP Session owns the exact Workspace it was opened for.
        // Do not silently canonicalize it to a different Workspace after the
        // user has selected controls on that live Session.
        if payload.session_id.is_some() {
            workspace
        } else if workspace_container_overlaps_repo(&workspace, &repos) {
            ensure_project_root_workspace(
                state.inner(),
                payload.project_id,
                Some(workspace.branch.as_str()),
            )
            .await?
        } else if workspace.use_worktree {
            workspace
        } else {
            ensure_project_root_workspace(
                state.inner(),
                payload.project_id,
                Some(workspace.branch.as_str()),
            )
            .await?
        }
    } else {
        resolve_project_workspace(state.inner(), payload.project_id, payload.branch.as_deref())
            .await?
    };

    state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;

    let session_id = payload.session_id.unwrap_or_else(Uuid::new_v4);
    let prepared_identity = if payload.session_id.is_some() {
        let agent_type = payload
            .executor
            .as_deref()
            .and_then(agents::AgentKind::from_lenient)
            .ok_or_else(|| {
                AppError::BadRequest(
                    "A prepared session requires a canonical Agent executor".to_string(),
                )
            })?;
        let prepared = state
            .agent_runtime
            .claim_prepared_session(agents::AgentSessionId(session_id), workspace.id, agent_type)
            .await?;
        Some((agent_type, prepared))
    } else {
        None
    };
    let mut session = Session::create(
        pool,
        &CreateSession {
            executor: payload.executor,
            task_id: Some(workspace.task_id),
            name: payload.name,
            initial_prompt: payload.initial_prompt,
            status: Some(SessionStatus::Todo),
        },
        session_id,
        workspace.id,
    )
    .await?;

    if let Some((agent_type, prepared)) = prepared_identity {
        Session::update_agent_metadata(
            pool,
            session.id,
            Some(&prepared.acp_session_id),
            Some(agent_type.as_str()),
        )
        .await?;
        session.external_session_id = Some(prepared.acp_session_id);
        session.agent_type = Some(agent_type.as_str().to_string());
    }

    state
        .agent_runtime
        .commit_prepared_session(agents::AgentSessionId(session_id))
        .await;

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

    if status != SessionStatus::Archived
        && let Some(task_id) = session.task_id
    {
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

    // Drop the conversation's full-text index row so search doesn't return a
    // deleted conversation (P1-2).
    if let Ok(mut conn) = pool.acquire().await
        && let Err(error) = conversations::search::delete_from_index(&mut conn, session_id).await
    {
        tracing::warn!("failed to remove conversation from search index: {error}");
    }

    Ok(())
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
