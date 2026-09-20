use std::collections::HashSet;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{Executor, FromRow, Sqlite, SqlitePool};
use thiserror::Error;
use ts_rs::TS;
use uuid::Uuid;

use super::project_repo::CreateProjectRepo;

#[derive(Debug, Error)]
pub enum ProjectError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error("Project not found")]
    ProjectNotFound,
    #[error("Failed to create project: {0}")]
    CreateFailed(String),
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
pub struct Project {
    pub id: Uuid,
    pub name: String,
    pub root_path: String,
    pub parent_project_id: Option<Uuid>,
    pub hidden: bool,
    pub is_git: bool,
    pub default_agent_working_dir: Option<String>,
    pub default_main_branch: Option<String>,
    #[ts(type = "Date")]
    pub created_at: DateTime<Utc>,
    #[ts(type = "Date")]
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, Deserialize, TS)]
pub struct CreateProject {
    pub name: String,
    #[serde(default)]
    pub root_path: String,
    #[serde(default)]
    pub parent_project_id: Option<Uuid>,
    #[serde(default)]
    pub repositories: Vec<CreateProjectRepo>,
}

#[derive(Debug, Deserialize, TS)]
pub struct UpdateProject {
    pub name: Option<String>,
    pub default_main_branch: Option<String>,
}

#[derive(Debug, Serialize, TS)]
pub struct SearchResult {
    pub path: String,
    pub is_file: bool,
    pub match_type: SearchMatchType,
    /// Ranking score based on git history (higher = more recently/frequently edited)
    #[serde(default)]
    pub score: i64,
}

#[derive(Debug, Clone, Serialize, TS)]
pub enum SearchMatchType {
    FileName,
    DirectoryName,
    FullPath,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ProjectImportPreview {
    pub path: String,
    pub is_git: bool,
    pub children: Vec<ProjectImportChild>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ProjectImportChild {
    pub name: String,
    pub path: String,
    pub existing_project_id: Option<Uuid>,
}

const PROJECT_SELECT: &str = r#"
    SELECT
        id,
        name,
        root_path,
        parent_project_id,
        hidden,
        EXISTS(SELECT 1 FROM project_repos pr WHERE pr.project_id = projects.id) AS is_git,
        default_agent_working_dir,
        default_main_branch,
        created_at,
        updated_at
    FROM projects
"#;

impl Project {
    pub async fn count(pool: &SqlitePool) -> Result<i64, sqlx::Error> {
        let total: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM projects WHERE hidden = 0")
                .fetch_one(pool)
                .await?;
        let hidden = plugin_scratch_project_ids(pool).await?.len() as i64;
        Ok((total - hidden).max(0))
    }

    pub async fn find_all_including_hidden(
        pool: &SqlitePool,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Project>(&format!(
            "{PROJECT_SELECT} ORDER BY created_at DESC"
        ))
        .fetch_all(pool)
        .await
    }

    pub async fn find_all(pool: &SqlitePool) -> Result<Vec<Self>, sqlx::Error> {
        let projects = sqlx::query_as::<_, Project>(&format!(
            "{PROJECT_SELECT} WHERE hidden = 0 ORDER BY created_at DESC"
        ))
        .fetch_all(pool)
        .await?;
        exclude_plugin_scratch_projects(pool, projects).await
    }

    pub async fn find_most_active(pool: &SqlitePool, limit: i32) -> Result<Vec<Self>, sqlx::Error> {
        let projects = sqlx::query_as::<_, Project>(
            r#"
            SELECT
                p.id,
                p.name,
                p.root_path,
                p.parent_project_id,
                p.hidden,
                EXISTS(SELECT 1 FROM project_repos pr WHERE pr.project_id = p.id) AS is_git,
                p.default_agent_working_dir,
                p.default_main_branch,
                p.created_at,
                p.updated_at
            FROM projects p
            WHERE p.hidden = 0 AND p.id IN (
                SELECT DISTINCT t.project_id
                FROM tasks t
                INNER JOIN workspaces w ON w.task_id = t.id
                ORDER BY w.updated_at DESC
            )
            LIMIT ?
            "#,
        )
        .bind(limit)
        .fetch_all(pool)
        .await?;
        exclude_plugin_scratch_projects(pool, projects).await
    }

    pub async fn find_by_id(pool: &SqlitePool, id: Uuid) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Project>(&format!("{PROJECT_SELECT} WHERE id = ?"))
            .bind(id)
            .fetch_optional(pool)
            .await
    }

    pub async fn find_by_rowid(pool: &SqlitePool, rowid: i64) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Project>(&format!("{PROJECT_SELECT} WHERE rowid = ?"))
            .bind(rowid)
            .fetch_optional(pool)
            .await
    }

    pub async fn find_visible_by_root_path(
        pool: &SqlitePool,
        root_path: &str,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Project>(&format!(
            "{PROJECT_SELECT} WHERE root_path = ? AND hidden = 0 LIMIT 1"
        ))
        .bind(root_path)
        .fetch_optional(pool)
        .await
    }

    pub async fn find_any_by_root_path(
        pool: &SqlitePool,
        root_path: &str,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Project>(&format!(
            "{PROJECT_SELECT} WHERE root_path = ? ORDER BY hidden ASC, updated_at DESC LIMIT 1"
        ))
        .bind(root_path)
        .fetch_optional(pool)
        .await
    }

    pub async fn create(
        executor: impl Executor<'_, Database = Sqlite>,
        data: &CreateProject,
        project_id: Uuid,
    ) -> Result<Self, sqlx::Error> {
        let hidden = false;
        let parent_project_id = data.parent_project_id;
        sqlx::query_as::<_, Project>(
            r#"INSERT INTO projects (id, name, root_path, parent_project_id, hidden)
               VALUES (?, ?, ?, ?, ?)
               RETURNING
                    id,
                    name,
                    root_path,
                    parent_project_id,
                    hidden,
                    0 AS is_git,
                    default_agent_working_dir,
                    default_main_branch,
                    created_at,
                    updated_at"#,
        )
        .bind(project_id)
        .bind(&data.name)
        .bind(&data.root_path)
        .bind(parent_project_id)
        .bind(hidden)
        .fetch_one(executor)
        .await
    }

    pub async fn update(
        pool: &SqlitePool,
        id: Uuid,
        payload: &UpdateProject,
    ) -> Result<Self, sqlx::Error> {
        let existing = Self::find_by_id(pool, id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)?;

        let name = payload.name.clone().unwrap_or(existing.name);
        let default_main_branch = if payload.default_main_branch.is_some() {
            payload.default_main_branch.clone()
        } else {
            existing.default_main_branch
        };

        sqlx::query("UPDATE projects SET name = ?, default_main_branch = ? WHERE id = ?")
            .bind(&name)
            .bind(&default_main_branch)
            .bind(id)
            .execute(pool)
            .await?;
        Self::find_by_id(pool, id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }

    pub async fn set_hidden(
        pool: &SqlitePool,
        id: Uuid,
        hidden: bool,
    ) -> Result<Self, sqlx::Error> {
        sqlx::query(
            "UPDATE projects SET hidden = ?, updated_at = datetime('now', 'subsec') WHERE id = ?",
        )
        .bind(hidden)
        .bind(id)
        .execute(pool)
        .await?;
        Self::find_by_id(pool, id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }

    pub async fn set_parent(
        pool: &SqlitePool,
        id: Uuid,
        parent_project_id: Option<Uuid>,
    ) -> Result<Self, sqlx::Error> {
        sqlx::query(
            "UPDATE projects SET parent_project_id = ?, updated_at = datetime('now', 'subsec') WHERE id = ?",
        )
        .bind(parent_project_id)
        .bind(id)
        .execute(pool)
        .await?;
        Self::find_by_id(pool, id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }

    pub async fn clear_parent_for_children(
        pool: &SqlitePool,
        parent_id: Uuid,
    ) -> Result<u64, sqlx::Error> {
        let result = sqlx::query(
            r#"UPDATE projects
               SET parent_project_id = NULL, updated_at = datetime('now', 'subsec')
               WHERE parent_project_id = ?"#,
        )
        .bind(parent_id)
        .execute(pool)
        .await?;
        Ok(result.rows_affected())
    }

    pub async fn delete(pool: &SqlitePool, id: Uuid) -> Result<u64, sqlx::Error> {
        let result = sqlx::query!("DELETE FROM projects WHERE id = $1", id)
            .execute(pool)
            .await?;
        Ok(result.rows_affected())
    }
}

async fn plugin_scratch_project_ids(pool: &SqlitePool) -> Result<HashSet<Uuid>, sqlx::Error> {
    match sqlx::query_scalar::<_, Uuid>("SELECT project_id FROM plugin_scratch_workspaces")
        .fetch_all(pool)
        .await
    {
        Ok(ids) => Ok(ids.into_iter().collect()),
        Err(sqlx::Error::Database(error)) if error.message().contains("no such table") => {
            Ok(HashSet::new())
        }
        Err(error) => Err(error),
    }
}

async fn exclude_plugin_scratch_projects(
    pool: &SqlitePool,
    projects: Vec<Project>,
) -> Result<Vec<Project>, sqlx::Error> {
    let hidden = plugin_scratch_project_ids(pool).await?;
    if hidden.is_empty() {
        return Ok(projects);
    }
    Ok(projects
        .into_iter()
        .filter(|project| !hidden.contains(&project.id))
        .collect())
}
