use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use thiserror::Error;
use ts_rs::TS;
use uuid::Uuid;

/// Maximum length for auto-generated workspace names (derived from first user prompt)
const WORKSPACE_NAME_MAX_LEN: usize = 60;

use super::{
    project::Project,
    repo::Repo,
    task::Task,
    workspace_repo::{RepoWithTargetBranch, WorkspaceRepo},
};

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error("Task not found")]
    TaskNotFound,
    #[error("Project not found")]
    ProjectNotFound,
    #[error("Validation error: {0}")]
    ValidationError(String),
    #[error("Branch not found: {0}")]
    BranchNotFound(String),
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct ContainerInfo {
    pub workspace_id: Uuid,
    pub task_id: Uuid,
    pub project_id: Uuid,
}

#[derive(Debug, FromRow)]
struct WorkspaceStatusRow {
    id: Uuid,
    project_id: Uuid,
    task_id: Uuid,
    parent_workspace_id: Option<Uuid>,
    container_ref: Option<String>,
    branch: String,
    use_worktree: bool,
    agent_working_dir: Option<String>,
    setup_completed_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    archived: bool,
    pinned: bool,
    name: Option<String>,
    is_running: i64,
    is_errored: i64,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
pub struct Workspace {
    pub id: Uuid,
    pub project_id: Uuid,
    pub task_id: Uuid,
    pub parent_workspace_id: Option<Uuid>,
    pub container_ref: Option<String>,
    pub branch: String,
    pub use_worktree: bool,
    pub agent_working_dir: Option<String>,
    pub setup_completed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub archived: bool,
    pub pinned: bool,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct WorkspaceWithStatus {
    #[serde(flatten)]
    #[ts(flatten)]
    pub workspace: Workspace,
    pub is_running: bool,
    pub is_errored: bool,
}

impl std::ops::Deref for WorkspaceWithStatus {
    type Target = Workspace;
    fn deref(&self) -> &Self::Target {
        &self.workspace
    }
}

/// GitHub PR creation parameters
pub struct CreatePrParams<'a> {
    pub workspace_id: Uuid,
    pub task_id: Uuid,
    pub project_id: Uuid,
    pub github_token: &'a str,
    pub title: &'a str,
    pub body: Option<&'a str>,
    pub base_branch: Option<&'a str>,
}

#[derive(Debug, Deserialize, TS)]
pub struct CreateFollowUpAttempt {
    pub prompt: String,
}

/// Context data for resume operations (simplified)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttemptResumeContext {
    pub execution_history: String,
    pub cumulative_diffs: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceContext {
    pub workspace: Workspace,
    pub task: Task,
    pub project: Project,
    pub workspace_repos: Vec<RepoWithTargetBranch>,
}

#[derive(Debug, Deserialize, TS)]
pub struct CreateWorkspace {
    pub project_id: Uuid,
    pub parent_workspace_id: Option<Uuid>,
    pub branch: String,
    pub container_ref: Option<String>,
    pub use_worktree: bool,
    pub agent_working_dir: Option<String>,
}

impl Workspace {
    fn agent_working_dir_targets_repo_folder(&self, repo: &Repo) -> bool {
        self.agent_working_dir
            .as_deref()
            .map(str::trim)
            .filter(|dir| !dir.is_empty())
            .and_then(|dir| dir.split(['/', '\\']).find(|segment| !segment.is_empty()))
            .is_some_and(|segment| segment == repo.name)
    }

    fn container_points_to_direct_checkout(&self, container_path: &Path, repo: &Repo) -> bool {
        if !self.use_worktree {
            return false;
        }

        if container_path.join(".git").exists() {
            return true;
        }

        if self.agent_working_dir_targets_repo_folder(repo) {
            return false;
        }

        self.agent_working_dir
            .as_deref()
            .map(str::trim)
            .filter(|dir| !dir.is_empty())
            .is_some()
            || container_path
                .file_name()
                .and_then(|segment| segment.to_str())
                .is_some_and(|segment| segment == repo.name)
    }

    pub fn container_path(&self) -> Option<PathBuf> {
        self.container_ref.as_ref().map(PathBuf::from)
    }

    pub fn repo_path(&self, repo: &Repo) -> Option<PathBuf> {
        self.container_path().map(|container_path| {
            if self.use_worktree {
                if self.container_points_to_direct_checkout(&container_path, repo) {
                    container_path
                } else {
                    container_path.join(&repo.name)
                }
            } else {
                repo.path.clone()
            }
        })
    }

    pub async fn parent_task(&self, pool: &SqlitePool) -> Result<Option<Task>, sqlx::Error> {
        Task::find_by_id(pool, self.task_id).await
    }

    /// Fetch all workspaces, optionally filtered by task_id.
    ///
    /// When `task_id` is provided, include both:
    /// - the seed workspace whose `workspaces.task_id` matches
    /// - any reused workspace containing a session linked to that task
    pub async fn fetch_all(
        pool: &SqlitePool,
        task_id: Option<Uuid>,
    ) -> Result<Vec<Self>, WorkspaceError> {
        let mut query = String::from(
            r#"SELECT DISTINCT w.id,
                              w.project_id,
                              w.task_id,
                              w.parent_workspace_id,
                              w.container_ref,
                              w.branch,
                              w.use_worktree,
                              w.agent_working_dir,
                              w.setup_completed_at,
                              w.created_at,
                              w.updated_at,
                              w.archived,
                              w.pinned,
                              w.name
               FROM workspaces w"#,
        );

        if task_id.is_some() {
            query.push_str(" LEFT JOIN sessions s ON s.workspace_id = w.id");
        }

        query.push_str(" WHERE 1 = 1");

        if task_id.is_some() {
            query.push_str(" AND (w.task_id = ? OR s.task_id = ?)");
        }

        query.push_str(" ORDER BY w.created_at DESC");

        let mut sql = sqlx::query_as::<_, Workspace>(&query);
        if let Some(task_id) = task_id {
            sql = sql.bind(task_id).bind(task_id);
        }

        sql.fetch_all(pool).await.map_err(WorkspaceError::Database)
    }

    pub async fn fetch_by_project_id(
        pool: &SqlitePool,
        project_id: Uuid,
    ) -> Result<Vec<Self>, WorkspaceError> {
        sqlx::query_as::<_, Workspace>(
            r#"SELECT w.id,
                      w.project_id,
                      w.task_id,
                      w.parent_workspace_id,
                      w.container_ref,
                      w.branch,
                      w.use_worktree,
                      w.agent_working_dir,
                      w.setup_completed_at,
                      w.created_at,
                      w.updated_at,
                      w.archived,
                      w.pinned,
                      w.name
               FROM workspaces w
               WHERE w.project_id = ?
               ORDER BY w.updated_at DESC, w.created_at DESC"#,
        )
        .bind(project_id)
        .fetch_all(pool)
        .await
        .map_err(WorkspaceError::Database)
    }

    pub async fn fetch_seed_by_task_id(
        pool: &SqlitePool,
        task_id: Uuid,
    ) -> Result<Vec<Self>, WorkspaceError> {
        sqlx::query_as::<_, Workspace>(
            r#"SELECT id,
                      project_id,
                      task_id,
                      parent_workspace_id,
                      container_ref,
                      branch,
                      use_worktree,
                      agent_working_dir,
                      setup_completed_at,
                      created_at,
                      updated_at,
                      archived,
                      pinned,
                      name
               FROM workspaces
               WHERE task_id = ?
               ORDER BY created_at DESC"#,
        )
        .bind(task_id)
        .fetch_all(pool)
        .await
        .map_err(WorkspaceError::Database)
    }

    /// Load workspace with full validation - ensures workspace belongs to task and task belongs to project
    pub async fn load_context(
        pool: &SqlitePool,
        workspace_id: Uuid,
        task_id: Uuid,
        project_id: Uuid,
    ) -> Result<WorkspaceContext, WorkspaceError> {
        let workspace = sqlx::query_as::<_, Workspace>(
            r#"SELECT  w.id,
                       w.project_id,
                       w.task_id,
                       w.parent_workspace_id,
                       w.container_ref,
                       w.branch,
                       w.use_worktree,
                       w.agent_working_dir,
                       w.setup_completed_at,
                       w.created_at,
                       w.updated_at,
                       w.archived,
                       w.pinned,
                       w.name
               FROM    workspaces w
               JOIN    tasks t ON w.task_id = t.id
               JOIN    projects p ON t.project_id = p.id
               WHERE   w.id = ? AND t.id = ? AND p.id = ?"#,
        )
        .bind(workspace_id)
        .bind(task_id)
        .bind(project_id)
        .fetch_optional(pool)
        .await?
        .ok_or(WorkspaceError::TaskNotFound)?;

        // Load task and project (we know they exist due to JOIN validation)
        let task = Task::find_by_id(pool, task_id)
            .await?
            .ok_or(WorkspaceError::TaskNotFound)?;

        let project = Project::find_by_id(pool, project_id)
            .await?
            .ok_or(WorkspaceError::ProjectNotFound)?;

        let workspace_repos =
            WorkspaceRepo::find_repos_with_target_branch_for_workspace(pool, workspace_id).await?;

        Ok(WorkspaceContext {
            workspace,
            task,
            project,
            workspace_repos,
        })
    }

    /// Update container reference
    pub async fn update_container_ref(
        pool: &SqlitePool,
        workspace_id: Uuid,
        container_ref: &str,
    ) -> Result<(), sqlx::Error> {
        let now = Utc::now();
        sqlx::query!(
            "UPDATE workspaces SET container_ref = $1, updated_at = $2 WHERE id = $3",
            container_ref,
            now,
            workspace_id
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn clear_container_ref(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        sqlx::query!(
            "UPDATE workspaces SET container_ref = NULL, updated_at = datetime('now') WHERE id = ?",
            workspace_id
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn update_storage_mode(
        pool: &SqlitePool,
        workspace_id: Uuid,
        use_worktree: bool,
        container_ref: Option<&str>,
        agent_working_dir: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"UPDATE workspaces
               SET use_worktree = ?,
                   container_ref = ?,
                   agent_working_dir = ?,
                   updated_at = datetime('now', 'subsec')
               WHERE id = ?"#,
        )
        .bind(use_worktree)
        .bind(container_ref)
        .bind(agent_working_dir)
        .bind(workspace_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Update the workspace's updated_at timestamp to prevent cleanup.
    /// Call this when the workspace is accessed (e.g., opened in editor).
    pub async fn touch(pool: &SqlitePool, workspace_id: Uuid) -> Result<(), sqlx::Error> {
        sqlx::query!(
            "UPDATE workspaces SET updated_at = datetime('now', 'subsec') WHERE id = ?",
            workspace_id
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn find_by_id(pool: &SqlitePool, id: Uuid) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Workspace>(
            r#"SELECT  id,
                       project_id,
                       task_id,
                       parent_workspace_id,
                       container_ref,
                       branch,
                       use_worktree,
                       agent_working_dir,
                       setup_completed_at,
                       created_at,
                       updated_at,
                       archived,
                       pinned,
                       name
               FROM    workspaces
               WHERE   id = ?"#,
        )
        .bind(id)
        .fetch_optional(pool)
        .await
    }

    pub async fn find_by_rowid(pool: &SqlitePool, rowid: i64) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Workspace>(
            r#"SELECT  id,
                       project_id,
                       task_id,
                       parent_workspace_id,
                       container_ref,
                       branch,
                       use_worktree,
                       agent_working_dir,
                       setup_completed_at,
                       created_at,
                       updated_at,
                       archived,
                       pinned,
                       name
               FROM    workspaces
               WHERE   rowid = ?"#,
        )
        .bind(rowid)
        .fetch_optional(pool)
        .await
    }

    pub async fn container_ref_exists(
        pool: &SqlitePool,
        container_ref: &str,
    ) -> Result<bool, sqlx::Error> {
        let result = sqlx::query!(
            r#"SELECT EXISTS(SELECT 1 FROM workspaces WHERE container_ref = ?) as "exists!: bool""#,
            container_ref
        )
        .fetch_one(pool)
        .await?;

        Ok(result.exists)
    }

    /// Find workspaces that are expired and eligible for cleanup.
    /// Uses accelerated cleanup (1 hour) for archived workspaces OR tasks not in progress/review.
    /// Uses standard cleanup (72 hours) only for non-archived workspaces on active tasks.
    pub async fn find_expired_for_cleanup(
        pool: &SqlitePool,
    ) -> Result<Vec<Workspace>, sqlx::Error> {
        sqlx::query_as::<_, Workspace>(
            r#"
            SELECT
                w.id,
                w.project_id,
                w.task_id,
                w.parent_workspace_id,
                w.container_ref,
                w.branch,
                w.use_worktree,
                w.agent_working_dir,
                w.setup_completed_at,
                w.created_at,
                w.updated_at,
                w.archived,
                w.pinned,
                w.name
            FROM workspaces w
            JOIN tasks t ON w.task_id = t.id
            LEFT JOIN sessions s ON w.id = s.workspace_id
            LEFT JOIN execution_processes ep ON s.id = ep.session_id AND ep.completed_at IS NOT NULL
            WHERE w.container_ref IS NOT NULL
                AND w.id NOT IN (
                    SELECT DISTINCT s2.workspace_id
                    FROM sessions s2
                    JOIN execution_processes ep2 ON s2.id = ep2.session_id
                    WHERE ep2.completed_at IS NULL
                )
            GROUP BY w.id, w.container_ref, w.updated_at
            HAVING datetime('now', 'localtime',
                CASE
                    WHEN w.archived = 1 OR t.status NOT IN ('inprogress', 'inreview')
                    THEN '-1 hours'
                    ELSE '-72 hours'
                END
            ) > datetime(
                MAX(
                    max(
                        datetime(w.updated_at),
                        datetime(ep.completed_at)
                    )
                )
            )
            ORDER BY MAX(
                CASE
                    WHEN ep.completed_at IS NOT NULL THEN ep.completed_at
                    ELSE w.updated_at
                END
            ) ASC
            "#,
        )
        .fetch_all(pool)
        .await
    }

    pub async fn create(
        pool: &SqlitePool,
        data: &CreateWorkspace,
        id: Uuid,
        task_id: Uuid,
    ) -> Result<Self, WorkspaceError> {
        Ok(sqlx::query_as::<_, Workspace>(
            r#"INSERT INTO workspaces (id, project_id, task_id, parent_workspace_id, container_ref, branch, use_worktree, agent_working_dir, setup_completed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               RETURNING id,
                         project_id,
                         task_id,
                         parent_workspace_id,
                         container_ref,
                         branch,
                         use_worktree,
                         agent_working_dir,
                         setup_completed_at,
                         created_at,
                         updated_at,
                         archived,
                         pinned,
                         name"#,
        )
        .bind(id)
        .bind(data.project_id)
        .bind(task_id)
        .bind(data.parent_workspace_id)
        .bind(data.container_ref.as_deref())
        .bind(&data.branch)
        .bind(data.use_worktree)
        .bind(data.agent_working_dir.as_deref())
        .bind(Option::<DateTime<Utc>>::None)
        .fetch_one(pool)
        .await?)
    }

    pub async fn update_branch_name(
        pool: &SqlitePool,
        workspace_id: Uuid,
        new_branch_name: &str,
    ) -> Result<(), WorkspaceError> {
        sqlx::query!(
            "UPDATE workspaces SET branch = $1, updated_at = datetime('now') WHERE id = $2",
            new_branch_name,
            workspace_id,
        )
        .execute(pool)
        .await?;

        Ok(())
    }

    pub async fn resolve_container_ref(
        pool: &SqlitePool,
        container_ref: &str,
    ) -> Result<ContainerInfo, sqlx::Error> {
        let result = sqlx::query_as::<_, ContainerInfo>(
            r#"SELECT w.id as workspace_id,
                      w.task_id as task_id,
                      w.project_id as project_id
               FROM workspaces w
               WHERE w.container_ref = ?"#,
        )
        .bind(container_ref)
        .fetch_optional(pool)
        .await?
        .ok_or(sqlx::Error::RowNotFound)?;

        Ok(ContainerInfo {
            workspace_id: result.workspace_id,
            task_id: result.task_id,
            project_id: result.project_id,
        })
    }

    /// Find workspace by path, also trying the parent directory.
    /// Used by VSCode extension which may open a repo subfolder (single-repo case)
    /// rather than the workspace root directory (multi-repo case).
    pub async fn resolve_container_ref_by_prefix(
        pool: &SqlitePool,
        path: &str,
    ) -> Result<ContainerInfo, sqlx::Error> {
        // First try exact match
        if let Ok(info) = Self::resolve_container_ref(pool, path).await {
            return Ok(info);
        }

        if let Some(parent) = std::path::Path::new(path).parent()
            && let Some(parent_str) = parent.to_str()
            && let Ok(info) = Self::resolve_container_ref(pool, parent_str).await
        {
            return Ok(info);
        }

        Err(sqlx::Error::RowNotFound)
    }

    pub async fn set_archived(
        pool: &SqlitePool,
        workspace_id: Uuid,
        archived: bool,
    ) -> Result<(), sqlx::Error> {
        sqlx::query!(
            "UPDATE workspaces SET archived = $1, updated_at = datetime('now', 'subsec') WHERE id = $2",
            archived,
            workspace_id
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Update workspace fields. Only non-None values will be updated.
    /// For `name`, pass `Some("")` to clear the name, `Some("foo")` to set it, or `None` to leave unchanged.
    pub async fn update(
        pool: &SqlitePool,
        workspace_id: Uuid,
        archived: Option<bool>,
        pinned: Option<bool>,
        name: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        // Convert empty string to None for name field (to store as NULL)
        let name_value = name.filter(|s| !s.is_empty());
        let name_provided = name.is_some();

        sqlx::query!(
            r#"UPDATE workspaces SET
                archived = COALESCE($1, archived),
                pinned = COALESCE($2, pinned),
                name = CASE WHEN $3 THEN $4 ELSE name END,
                updated_at = datetime('now', 'subsec')
            WHERE id = $5"#,
            archived,
            pinned,
            name_provided,
            name_value,
            workspace_id
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn get_first_user_message(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<Option<String>, sqlx::Error> {
        let result = sqlx::query!(
            r#"SELECT cat.prompt
               FROM sessions s
               JOIN execution_processes ep ON ep.session_id = s.id
               JOIN coding_agent_turns cat ON cat.execution_process_id = ep.id
               WHERE s.workspace_id = $1
                 AND s.executor IS NOT NULL
                 AND cat.prompt IS NOT NULL
               ORDER BY s.created_at ASC, ep.created_at ASC
               LIMIT 1"#,
            workspace_id
        )
        .fetch_optional(pool)
        .await?;
        Ok(result.and_then(|r| r.prompt))
    }

    pub fn truncate_to_name(prompt: &str, max_len: usize) -> String {
        let trimmed = prompt.trim();
        if trimmed.chars().count() <= max_len {
            trimmed.to_string()
        } else {
            let truncated: String = trimmed.chars().take(max_len).collect();
            if let Some(last_space) = truncated.rfind(' ') {
                format!("{}...", &truncated[..last_space])
            } else {
                format!("{}...", truncated)
            }
        }
    }

    pub async fn find_all_with_status(
        pool: &SqlitePool,
        archived: Option<bool>,
        limit: Option<i64>,
    ) -> Result<Vec<WorkspaceWithStatus>, sqlx::Error> {
        // Fetch all workspaces with status (uses cached SQLx query)
        let records = sqlx::query_as::<_, WorkspaceStatusRow>(
            r#"SELECT
                w.id,
                w.project_id,
                w.task_id,
                w.parent_workspace_id,
                w.container_ref,
                w.branch,
                w.use_worktree,
                w.agent_working_dir,
                w.setup_completed_at,
                w.created_at,
                w.updated_at,
                w.archived,
                w.pinned,
                w.name,

                CASE WHEN EXISTS (
                    SELECT 1
                    FROM sessions s
                    JOIN execution_processes ep ON ep.session_id = s.id
                    WHERE s.workspace_id = w.id
                      AND ep.status = 'running'
                      AND ep.run_reason IN ('setupscript','cleanupscript','codingagent')
                    LIMIT 1
                ) THEN 1 ELSE 0 END AS is_running,

                CASE WHEN (
                    SELECT ep.status
                    FROM sessions s
                    JOIN execution_processes ep ON ep.session_id = s.id
                    WHERE s.workspace_id = w.id
                      AND ep.run_reason IN ('setupscript','cleanupscript','codingagent')
                    ORDER BY ep.created_at DESC
                    LIMIT 1
                ) IN ('failed','killed') THEN 1 ELSE 0 END AS is_errored

            FROM workspaces w
            ORDER BY w.updated_at DESC"#,
        )
        .fetch_all(pool)
        .await?;

        let mut workspaces: Vec<WorkspaceWithStatus> = records
            .into_iter()
            .map(|rec| WorkspaceWithStatus {
                workspace: Workspace {
                    id: rec.id,
                    project_id: rec.project_id,
                    task_id: rec.task_id,
                    parent_workspace_id: rec.parent_workspace_id,
                    container_ref: rec.container_ref,
                    branch: rec.branch,
                    use_worktree: rec.use_worktree,
                    agent_working_dir: rec.agent_working_dir,
                    setup_completed_at: rec.setup_completed_at,
                    created_at: rec.created_at,
                    updated_at: rec.updated_at,
                    archived: rec.archived,
                    pinned: rec.pinned,
                    name: rec.name,
                },
                is_running: rec.is_running != 0,
                is_errored: rec.is_errored != 0,
            })
            // Apply archived filter if provided
            .filter(|ws| archived.is_none_or(|a| ws.workspace.archived == a))
            .collect();

        // Apply limit if provided (already sorted by updated_at DESC from query)
        if let Some(lim) = limit {
            workspaces.truncate(lim as usize);
        }

        for ws in &mut workspaces {
            if ws.workspace.name.is_none()
                && let Some(prompt) = Self::get_first_user_message(pool, ws.workspace.id).await?
            {
                let name = Self::truncate_to_name(&prompt, WORKSPACE_NAME_MAX_LEN);
                Self::update(pool, ws.workspace.id, None, None, Some(&name)).await?;
                ws.workspace.name = Some(name);
            }
        }

        Ok(workspaces)
    }

    pub async fn find_by_project_id_with_status(
        pool: &SqlitePool,
        project_id: Uuid,
    ) -> Result<Vec<WorkspaceWithStatus>, sqlx::Error> {
        let workspaces =
            Self::fetch_by_project_id(pool, project_id)
                .await
                .map_err(|err| match err {
                    WorkspaceError::Database(db_err) => db_err,
                    other => sqlx::Error::Protocol(other.to_string()),
                })?;

        let mut workspaces_with_status = Vec::with_capacity(workspaces.len());
        for workspace in workspaces {
            if let Some(workspace_with_status) =
                Self::find_by_id_with_status(pool, workspace.id).await?
            {
                workspaces_with_status.push(workspace_with_status);
            }
        }

        Ok(workspaces_with_status)
    }

    /// Delete a workspace by ID
    pub async fn delete(pool: &SqlitePool, id: Uuid) -> Result<u64, sqlx::Error> {
        let result = sqlx::query!("DELETE FROM workspaces WHERE id = $1", id)
            .execute(pool)
            .await?;
        Ok(result.rows_affected())
    }

    /// Count total workspaces across all projects
    pub async fn count_all(pool: &SqlitePool) -> Result<i64, WorkspaceError> {
        sqlx::query_scalar!(r#"SELECT COUNT(*) as "count!: i64" FROM workspaces"#)
            .fetch_one(pool)
            .await
            .map_err(WorkspaceError::Database)
    }

    pub async fn find_by_id_with_status(
        pool: &SqlitePool,
        id: Uuid,
    ) -> Result<Option<WorkspaceWithStatus>, sqlx::Error> {
        let rec = sqlx::query_as::<_, WorkspaceStatusRow>(
            r#"SELECT
                w.id,
                w.project_id,
                w.task_id,
                w.parent_workspace_id,
                w.container_ref,
                w.branch,
                w.use_worktree,
                w.agent_working_dir,
                w.setup_completed_at,
                w.created_at,
                w.updated_at,
                w.archived,
                w.pinned,
                w.name,

                CASE WHEN EXISTS (
                    SELECT 1
                    FROM sessions s
                    JOIN execution_processes ep ON ep.session_id = s.id
                    WHERE s.workspace_id = w.id
                      AND ep.status = 'running'
                      AND ep.run_reason IN ('setupscript','cleanupscript','codingagent')
                    LIMIT 1
                ) THEN 1 ELSE 0 END AS is_running,

                CASE WHEN (
                    SELECT ep.status
                    FROM sessions s
                    JOIN execution_processes ep ON ep.session_id = s.id
                    WHERE s.workspace_id = w.id
                      AND ep.run_reason IN ('setupscript','cleanupscript','codingagent')
                    ORDER BY ep.created_at DESC
                    LIMIT 1
                ) IN ('failed','killed') THEN 1 ELSE 0 END AS is_errored

            FROM workspaces w
            WHERE w.id = ?"#,
        )
        .bind(id)
        .fetch_optional(pool)
        .await?;

        let Some(rec) = rec else {
            return Ok(None);
        };

        let mut ws = WorkspaceWithStatus {
            workspace: Workspace {
                id: rec.id,
                project_id: rec.project_id,
                task_id: rec.task_id,
                parent_workspace_id: rec.parent_workspace_id,
                container_ref: rec.container_ref,
                branch: rec.branch,
                use_worktree: rec.use_worktree,
                agent_working_dir: rec.agent_working_dir,
                setup_completed_at: rec.setup_completed_at,
                created_at: rec.created_at,
                updated_at: rec.updated_at,
                archived: rec.archived,
                pinned: rec.pinned,
                name: rec.name,
            },
            is_running: rec.is_running != 0,
            is_errored: rec.is_errored != 0,
        };

        if ws.workspace.name.is_none()
            && let Some(prompt) = Self::get_first_user_message(pool, ws.workspace.id).await?
        {
            let name = Self::truncate_to_name(&prompt, WORKSPACE_NAME_MAX_LEN);
            Self::update(pool, ws.workspace.id, None, None, Some(&name)).await?;
            ws.workspace.name = Some(name);
        }

        Ok(Some(ws))
    }
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use uuid::Uuid;

    use super::*;

    fn sample_repo(name: &str, path: &str) -> Repo {
        Repo {
            id: Uuid::new_v4(),
            path: PathBuf::from(path),
            name: name.to_string(),
            display_name: name.to_string(),
            setup_script: None,
            cleanup_script: None,
            archive_script: None,
            copy_files: None,
            parallel_setup_script: false,
            dev_server_script: None,
            default_target_branch: None,
            default_working_dir: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    fn sample_workspace(
        container_ref: Option<&str>,
        use_worktree: bool,
        agent_working_dir: Option<&str>,
    ) -> Workspace {
        Workspace {
            id: Uuid::new_v4(),
            project_id: Uuid::new_v4(),
            task_id: Uuid::new_v4(),
            parent_workspace_id: None,
            container_ref: container_ref.map(ToOwned::to_owned),
            branch: "feature/worktree".to_string(),
            use_worktree,
            agent_working_dir: agent_working_dir.map(ToOwned::to_owned),
            setup_completed_at: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            archived: false,
            pinned: false,
            name: None,
        }
    }

    #[test]
    fn repo_path_uses_direct_checkout_for_external_single_repo_worktree() {
        let workspace =
            sample_workspace(Some("C:/worktrees/repo-feature-b"), true, Some("frontend"));
        let repo = sample_repo("repo-feature-a", "C:/worktrees/repo-feature-a");

        assert_eq!(
            workspace.repo_path(&repo),
            Some(PathBuf::from("C:/worktrees/repo-feature-b"))
        );
    }

    #[test]
    fn repo_path_keeps_repo_subdirectory_for_managed_workspace_container() {
        let workspace = sample_workspace(
            Some("C:/Users/test/.vibex-workspaces/ws-123"),
            true,
            Some("repo-feature-a/frontend"),
        );
        let repo = sample_repo("repo-feature-a", "C:/worktrees/repo-feature-a");

        assert_eq!(
            workspace.repo_path(&repo),
            Some(PathBuf::from(
                "C:/Users/test/.vibex-workspaces/ws-123/repo-feature-a"
            ))
        );
    }
}
