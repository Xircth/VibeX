use std::path::{Path, PathBuf};

use api_types::AgentId;
use db::models::{
    project::Project,
    project_repo::ProjectRepo,
    repo::{Repo, RepoError},
    session::SessionStatus,
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
    pub agent_id: Option<AgentId>,
    pub workspace_name: Option<String>,
    pub workspace_branch: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub first_prompt: Option<String>,
    pub is_running: bool,
    pub continuity_mode: SessionContinuityMode,
    #[serde(default)]
    pub pinned_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum SessionContinuityMode {
    NewSession,
    ResumeInPlace,
}

const PROJECT_ROOT_TASK_TITLE: &str = "Project Root Workspace";
const NEW_SESSION_WORKSPACE_TITLE: &str = "New Session Workspace";

#[derive(Debug, serde::Deserialize, Clone)]
pub struct ProjectSessionRepoInput {
    pub repo_id: Uuid,
    pub target_branch: String,
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

pub(crate) async fn resolve_project_workspace(
    state: &AppState,
    project_id: Uuid,
    branch: Option<&str>,
) -> Result<Workspace, AppError> {
    let desired_branch = branch
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);

    ensure_project_root_workspace(state, project_id, desired_branch.as_deref()).await
}

pub(crate) async fn create_worktree_workspace_for_project_session(
    state: &AppState,
    project_id: Uuid,
    name: Option<&str>,
    initial_prompt: Option<&str>,
    repos: &[ProjectSessionRepoInput],
    branch_override: Option<&str>,
    include_uncommitted: bool,
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
    let branch = match branch_override {
        Some(branch) => branch.to_string(),
        None => {
            state
                .deployment
                .container()
                .git_branch_from_workspace(&workspace_id, &workspace_title)
                .await
        }
    };

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

    let workspace_repos: Vec<CreateWorkspaceRepo> = {
        let mut collected = Vec::with_capacity(repos.len());
        for input in repos {
            let repo = Repo::find_by_id(pool, input.repo_id)
                .await?
                .ok_or(RepoError::NotFound)?;
            let target_branch = state
                .deployment
                .git()
                .resolve_workspace_branch(&repo.path, Some(input.target_branch.as_str()))
                .map_err(|error| {
                    AppError::Internal(format!(
                        "Could not resolve the default branch of repo {}: {error}",
                        repo.name
                    ))
                })?;
            collected.push(CreateWorkspaceRepo {
                repo_id: input.repo_id,
                target_branch,
            });
        }
        collected
    };
    WorkspaceRepo::create_many(pool, workspace.id, &workspace_repos).await?;

    let workspace = Workspace::find_by_id(pool, workspace.id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace.id)))?;
    state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await
        .map_err(map_workspace_git_error)?;
    let workspace = Workspace::find_by_id(pool, workspace.id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace.id)))?;
    if include_uncommitted && let Some(container_ref) = workspace.container_ref.as_deref() {
        let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
        services::services::workspace_manager::WorkspaceManager::copy_uncommitted_changes(
            Path::new(container_ref),
            &repos,
        )
        .await
        .map_err(map_workspace_git_error)?;
    }
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
    let Some(primary_repo) = repos.into_iter().next() else {
        let project = Project::find_by_id(pool, project_id)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Project {project_id} not found")))?;
        if project.root_path.is_empty() {
            return Err(AppError::BadRequest(
                "Project has no folder path".to_string(),
            ));
        }
        return ensure_directory_root_workspace_tauri(state, project).await;
    };

    let desired_branch = state
        .deployment
        .git()
        .checkout_project_root_branch(&primary_repo.path, branch)
        .map_err(|e| {
            if git_checkout_error_is_local_changes(&e.to_string()) {
                return AppError::BadRequest(
                    "当前分支存在未提交更改，无法切换分支，请先提交或放弃更改。".to_string(),
                );
            }

            AppError::Internal(format!("Failed to prepare project root branch: {e}"))
        })?;

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

fn map_workspace_git_error(error: impl std::fmt::Display) -> AppError {
    let message = error.to_string();
    if git::GitServiceError::is_user_facing_message(&message)
        || git_checkout_error_is_local_changes(&message)
    {
        AppError::BadRequest(message)
    } else {
        AppError::Internal(message)
    }
}

async fn ensure_directory_root_workspace_tauri(
    state: &AppState,
    project: Project,
) -> Result<Workspace, AppError> {
    let pool = &state.deployment.db().pool;
    if let Some(existing) = Workspace::find_by_project_id_with_status(pool, project.id)
        .await?
        .into_iter()
        .map(|workspace| workspace.workspace)
        .find(|workspace| !workspace.use_worktree)
    {
        if existing.container_ref.as_deref() != Some(project.root_path.as_str()) {
            Workspace::update_container_ref(pool, existing.id, &project.root_path).await?;
        }
        return Workspace::find_by_id(pool, existing.id)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", existing.id)));
    }
    let owner_task = if let Some(task) =
        Task::find_by_project_id_with_attempt_status(pool, project.id)
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
                project_id: project.id,
                title: format!("Project Root Workspace ({})", project.name),
                description: Some("Auto-created to support sessions in this folder.".to_string()),
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
            project_id: project.id,
            parent_workspace_id: None,
            branch: String::new(),
            container_ref: Some(project.root_path.clone()),
            use_worktree: false,
            agent_working_dir: Some(project.root_path.clone()),
        },
        Uuid::new_v4(),
        owner_task.id,
    )
    .await?;
    Workspace::update(
        pool,
        workspace.id,
        Some(false),
        None,
        Some(project.name.as_str()),
    )
    .await?;
    Workspace::find_by_id(pool, workspace.id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace.id)))
}
