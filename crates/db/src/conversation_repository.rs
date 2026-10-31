//! SQLite storage for the conversation application port.
//!
//! The queries live here so the application core owns the port and its
//! projections, while every SQL statement and row shape stays in the database
//! crate.

use chrono::{DateTime, Utc};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

use crate::models::conversation_event::ConversationEventRecord;

#[derive(FromRow)]
pub struct ProjectCatalogRow {
    pub id: Uuid,
    pub name: String,
    pub path: String,
}

#[derive(FromRow)]
pub struct WorkspaceCatalogRow {
    pub id: Uuid,
    pub project_id: Uuid,
    pub name: Option<String>,
    pub branch: String,
}

#[derive(FromRow)]
pub struct AgentCatalogRow {
    pub agent_id: String,
    pub enabled: bool,
    pub retained_icon_svg: Option<String>,
    pub display_name: Option<String>,
    pub lifecycle: Option<String>,
    pub authentication: Option<String>,
}

#[derive(FromRow)]
pub struct AgentBindingConfigRow {
    pub config_options_json: Option<String>,
    pub modes_json: Option<String>,
    pub current_mode: Option<String>,
}

pub struct TerminalEventRow {
    pub id: Uuid,
    pub event_kind: String,
    pub normalized_json: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone)]
pub struct SqliteConversationRepository {
    pool: SqlitePool,
}

impl SqliteConversationRepository {
    pub const fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub const fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    pub async fn workspace_root(&self, workspace_id: Uuid) -> Result<Option<String>, sqlx::Error> {
        let row = sqlx::query_as::<_, (Option<String>, Option<String>, String)>(
            r#"SELECT w.agent_working_dir,
                      w.container_ref,
                      COALESCE(
                        NULLIF(TRIM(p.default_agent_working_dir), ''),
                        (
                          SELECT r.path
                          FROM project_repos pr
                          JOIN repos r ON r.id = pr.repo_id
                          WHERE pr.project_id = p.id
                          LIMIT 1
                        ),
                        ''
                      ) AS project_path
               FROM workspaces w
               JOIN projects p ON p.id = w.project_id
               WHERE w.id = ?"#,
        )
        .bind(workspace_id)
        .fetch_optional(&self.pool)
        .await?;
        let Some((working_dir, container_ref, project_path)) = row else {
            return Ok(None);
        };
        let root = [
            working_dir.as_deref(),
            container_ref.as_deref(),
            Some(project_path.as_str()),
        ]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|value| !value.is_empty() && std::path::Path::new(value).is_dir())
        .unwrap_or(project_path.as_str())
        .to_string();
        Ok(Some(root))
    }

    pub async fn catalog_projects(&self) -> Result<Vec<ProjectCatalogRow>, sqlx::Error> {
        sqlx::query_as::<_, ProjectCatalogRow>(
            r#"SELECT p.id AS id,
                      p.name AS name,
                      COALESCE(
                        NULLIF(TRIM(p.default_agent_working_dir), ''),
                        (
                          SELECT r.path
                          FROM project_repos pr
                          JOIN repos r ON r.id = pr.repo_id
                          WHERE pr.project_id = p.id
                          LIMIT 1
                        ),
                        ''
                      ) AS path
               FROM projects p
               ORDER BY p.updated_at DESC, p.created_at DESC"#,
        )
        .fetch_all(&self.pool)
        .await
    }

    pub async fn catalog_workspaces(&self) -> Result<Vec<WorkspaceCatalogRow>, sqlx::Error> {
        sqlx::query_as::<_, WorkspaceCatalogRow>(
            r#"SELECT id, project_id, name, branch
               FROM workspaces
               WHERE archived = 0
               ORDER BY updated_at DESC"#,
        )
        .fetch_all(&self.pool)
        .await
    }

    pub async fn catalog_agents(&self) -> Result<Vec<AgentCatalogRow>, sqlx::Error> {
        let mut agents = sqlx::query_as::<_, AgentCatalogRow>(
            r#"SELECT m.agent_id AS agent_id,
                      m.enabled AS enabled,
                      m.retained_icon_svg AS retained_icon_svg,
                      json_extract(m.retained_metadata_json, '$.name') AS display_name,
                      i.lifecycle AS lifecycle,
                      p.authentication AS authentication
               FROM agent_membership m
               LEFT JOIN agent_installation i ON i.agent_id = m.agent_id
               LEFT JOIN agent_probe p ON p.agent_id = m.agent_id
               WHERE m.retired = 0
               ORDER BY m.position ASC, m.agent_id ASC"#,
        )
        .fetch_all(&self.pool)
        .await?;
        if agents.is_empty() {
            agents = sqlx::query_as::<_, AgentCatalogRow>(
                r#"SELECT s.agent_id AS agent_id,
                          1 AS enabled,
                          NULL AS retained_icon_svg,
                          NULL AS display_name,
                          i.lifecycle AS lifecycle,
                          p.authentication AS authentication
                   FROM (
                     SELECT DISTINCT agent_id
                     FROM sessions
                     WHERE agent_id IS NOT NULL AND TRIM(agent_id) != '' AND deleted_at IS NULL
                   ) s
                   LEFT JOIN agent_installation i ON i.agent_id = s.agent_id
                   LEFT JOIN agent_probe p ON p.agent_id = s.agent_id
                   ORDER BY s.agent_id"#,
            )
            .fetch_all(&self.pool)
            .await?;
        }
        Ok(agents)
    }

    pub async fn catalog_agent_binding(
        &self,
        agent_id: &str,
    ) -> Result<Option<AgentBindingConfigRow>, sqlx::Error> {
        sqlx::query_as::<_, AgentBindingConfigRow>(
            r#"SELECT config_options_json, modes_json, current_mode
               FROM conversation_agent_bindings
               WHERE agent_id = ?
               ORDER BY updated_at DESC
               LIMIT 1"#,
        )
        .bind(agent_id)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn catalog_agent_capability(
        &self,
        agent_id: &str,
    ) -> Result<Option<String>, sqlx::Error> {
        sqlx::query_scalar::<_, String>(
            r#"SELECT controls_json
               FROM agent_capability_catalog
               WHERE agent_type = ?
               ORDER BY retrieved_at DESC
               LIMIT 1"#,
        )
        .bind(agent_id)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn workspace_source_for_project(
        &self,
        project_id: Uuid,
    ) -> Result<Option<WorkspaceCatalogRow>, sqlx::Error> {
        sqlx::query_as::<_, WorkspaceCatalogRow>(
            r#"SELECT id, project_id, name, branch
               FROM workspaces
               WHERE archived = 0 AND project_id = ?
               ORDER BY is_system ASC,
                        EXISTS(SELECT 1 FROM workspace_repos wr WHERE wr.workspace_id = workspaces.id) DESC,
                        updated_at DESC
               LIMIT 1"#,
        )
        .bind(project_id)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn insert_workspace_from_source(
        &self,
        id: Uuid,
        source_id: Uuid,
        branch: &str,
        name: &str,
    ) -> Result<(), sqlx::Error> {
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            r#"INSERT INTO workspaces (
                   id, project_id, task_id, parent_workspace_id, container_ref, branch,
                   use_worktree, agent_working_dir, setup_completed_at, name
               )
               SELECT ?, project_id, task_id, id,
                      CASE WHEN use_worktree = 1 THEN NULL ELSE container_ref END,
                      ?, use_worktree, agent_working_dir,
                      CASE WHEN use_worktree = 1 THEN NULL ELSE setup_completed_at END,
                      ?
               FROM workspaces
               WHERE id = ?"#,
        )
        .bind(id)
        .bind(branch)
        .bind(name)
        .bind(source_id)
        .execute(&mut *tx)
        .await?;

        let source_repos: Vec<(Uuid, String)> = sqlx::query_as(
            "SELECT repo_id, target_branch FROM workspace_repos WHERE workspace_id = ?",
        )
        .bind(source_id)
        .fetch_all(&mut *tx)
        .await?;

        for (repo_id, target_branch) in source_repos {
            sqlx::query(
                "INSERT INTO workspace_repos (id, workspace_id, repo_id, target_branch)
                 VALUES (?, ?, ?, ?)",
            )
            .bind(Uuid::new_v4())
            .bind(id)
            .bind(repo_id)
            .bind(target_branch)
            .execute(&mut *tx)
            .await?;
        }

        tx.commit().await
    }

    pub async fn set_session_agent(
        &self,
        conversation_id: Uuid,
        agent_id: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE sessions
             SET external_session_id = CASE
                     WHEN agent_id IS NOT NULL AND agent_id != ?1 THEN NULL
                     ELSE external_session_id
                 END,
                 agent_id = ?1,
                 agent_type = ?1,
                 executor = ?1,
                 updated_at = datetime('now', 'subsec')
             WHERE id = ?2",
        )
        .bind(agent_id)
        .bind(conversation_id)
        .execute(&self.pool)
        .await
        .map(|_| ())
    }

    pub async fn max_event_sequence(&self, conversation_id: Uuid) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar(
            "SELECT COALESCE(MAX(sequence), 0)
             FROM conversation_events WHERE conversation_id = ?",
        )
        .bind(conversation_id)
        .fetch_one(&self.pool)
        .await
    }

    /// Read the offline cache page in a single read transaction so the high
    /// water mark and the page it confirms cannot drift apart.
    pub async fn offline_events(
        &self,
        conversation_id: Uuid,
        after_sequence: i64,
        limit: i64,
    ) -> Result<(i64, Vec<ConversationEventRecord>), sqlx::Error> {
        let mut transaction = self.pool.begin().await?;
        let high_water_mark = sqlx::query_scalar::<_, i64>(
            "SELECT COALESCE(MAX(sequence), 0)
             FROM conversation_events
             WHERE conversation_id = ?",
        )
        .bind(conversation_id)
        .fetch_one(&mut *transaction)
        .await?;
        let records = ConversationEventRecord::events_since(
            &mut *transaction,
            conversation_id,
            after_sequence,
            limit,
        )
        .await?;
        transaction.commit().await?;
        Ok((high_water_mark, records))
    }

    pub async fn latest_terminal_event(
        &self,
        conversation_id: Uuid,
    ) -> Result<Option<TerminalEventRow>, sqlx::Error> {
        sqlx::query_as::<_, (Uuid, String, String, DateTime<Utc>)>(
            "SELECT id, event_kind, normalized_json, created_at
             FROM conversation_events
             WHERE conversation_id = ?
               AND event_kind IN (
                   'turn_completed', 'turn_failed', 'turn_cancelled', 'turn_interrupted'
               )
             ORDER BY sequence DESC
             LIMIT 1",
        )
        .bind(conversation_id)
        .fetch_optional(&self.pool)
        .await
        .map(|row| {
            row.map(
                |(id, event_kind, normalized_json, created_at)| TerminalEventRow {
                    id,
                    event_kind,
                    normalized_json,
                    created_at,
                },
            )
        })
    }

    pub async fn automation_source(
        &self,
        conversation_id: Uuid,
    ) -> Result<Option<(Uuid, Uuid)>, sqlx::Error> {
        sqlx::query_as::<_, (Uuid, Uuid)>(
            "SELECT id, automation_id
             FROM automation_runs
             WHERE conversation_id = ?
             ORDER BY started_at DESC
             LIMIT 1",
        )
        .bind(conversation_id)
        .fetch_optional(&self.pool)
        .await
    }
}
