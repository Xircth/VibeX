use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AgentSettingError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error("Agent setting not found")]
    NotFound,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct AgentSetting {
    pub id: i64,
    pub agent_type: String,
    pub enabled: bool,
    pub sort_order: i32,
    pub installed_version: Option<String>,
    pub env_json: Option<String>,
    pub config_json: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl AgentSetting {
    /// List all agent settings ordered by sort_order.
    pub async fn list_all(pool: &SqlitePool) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, AgentSetting>(
            r#"SELECT id, agent_type, enabled, sort_order, installed_version,
                      env_json, config_json, created_at, updated_at
               FROM agent_setting
               ORDER BY sort_order ASC"#,
        )
        .fetch_all(pool)
        .await
    }

    /// Find an agent setting by agent_type.
    pub async fn find_by_type(
        pool: &SqlitePool,
        agent_type: &str,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, AgentSetting>(
            r#"SELECT id, agent_type, enabled, sort_order, installed_version,
                      env_json, config_json, created_at, updated_at
               FROM agent_setting
               WHERE agent_type = $1"#,
        )
        .bind(agent_type)
        .fetch_optional(pool)
        .await
    }

    /// Update preferences (enabled, env_json, config_json) for an agent.
    pub async fn update_preferences(
        pool: &SqlitePool,
        agent_type: &str,
        enabled: Option<bool>,
        env_json: Option<&str>,
        config_json: Option<&str>,
    ) -> Result<Self, AgentSettingError> {
        let existing = Self::find_by_type(pool, agent_type)
            .await?
            .ok_or(AgentSettingError::NotFound)?;

        let new_enabled = enabled.unwrap_or(existing.enabled);
        let new_env_json = env_json.or(existing.env_json.as_deref());
        let new_config_json = config_json.or(existing.config_json.as_deref());

        sqlx::query_as::<_, AgentSetting>(
            r#"UPDATE agent_setting
               SET enabled = $1,
                   env_json = $2,
                   config_json = $3,
                   updated_at = datetime('now')
               WHERE agent_type = $4
               RETURNING id, agent_type, enabled, sort_order, installed_version,
                         env_json, config_json, created_at, updated_at"#,
        )
        .bind(new_enabled)
        .bind(new_env_json)
        .bind(new_config_json)
        .bind(agent_type)
        .fetch_one(pool)
        .await
        .map_err(AgentSettingError::from)
    }

    /// Reorder agents by providing the agent_type list in desired order.
    /// Uses a transaction for atomicity. N is always small (< 10 agents),
    /// so individual parameterized UPDATEs within a transaction are safe and efficient.
    pub async fn reorder(pool: &SqlitePool, order: &[String]) -> Result<(), sqlx::Error> {
        if order.is_empty() {
            return Ok(());
        }

        let mut tx = pool.begin().await?;
        for (idx, agent_type) in order.iter().enumerate() {
            sqlx::query(
                r#"UPDATE agent_setting
                   SET sort_order = $1, updated_at = datetime('now')
                   WHERE agent_type = $2"#,
            )
            .bind(idx as i32)
            .bind(agent_type)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// Update the installed_version for an agent.
    pub async fn update_version(
        pool: &SqlitePool,
        agent_type: &str,
        version: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"UPDATE agent_setting
               SET installed_version = $1, updated_at = datetime('now')
               WHERE agent_type = $2"#,
        )
        .bind(version)
        .bind(agent_type)
        .execute(pool)
        .await?;
        Ok(())
    }
}
