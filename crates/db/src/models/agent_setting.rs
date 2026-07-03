use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use thiserror::Error;

const DEFAULT_AGENT_SETTINGS: [(&str, i32); 7] = [
    ("claude_code", 0),
    ("codex", 1),
    ("open_code", 2),
    ("gemini", 3),
    ("open_claw", 4),
    ("cline", 5),
    ("hermes", 6),
];

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
    pub auto_approve_mode: String,
    pub created_at: String,
    pub updated_at: String,
}

impl AgentSetting {
    pub async fn ensure_defaults(pool: &SqlitePool) -> Result<(), sqlx::Error> {
        for (agent_type, sort_order) in DEFAULT_AGENT_SETTINGS {
            sqlx::query(
                r#"INSERT OR IGNORE INTO agent_setting (agent_type, sort_order)
                   VALUES ($1, $2)"#,
            )
            .bind(agent_type)
            .bind(sort_order)
            .execute(pool)
            .await?;
        }

        Ok(())
    }

    /// List all agent settings ordered by sort_order.
    pub async fn list_all(pool: &SqlitePool) -> Result<Vec<Self>, sqlx::Error> {
        Self::ensure_defaults(pool).await?;
        sqlx::query_as::<_, AgentSetting>(
            r#"SELECT id, agent_type, enabled, sort_order, installed_version,
                      env_json, config_json, auto_approve_mode, created_at, updated_at
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
        Self::ensure_defaults(pool).await?;
        sqlx::query_as::<_, AgentSetting>(
            r#"SELECT id, agent_type, enabled, sort_order, installed_version,
                      env_json, config_json, auto_approve_mode, created_at, updated_at
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
        auto_approve_mode: Option<&str>,
    ) -> Result<Self, AgentSettingError> {
        let existing = Self::find_by_type(pool, agent_type)
            .await?
            .ok_or(AgentSettingError::NotFound)?;

        let new_enabled = enabled.unwrap_or(existing.enabled);
        let new_env_json = env_json.or(existing.env_json.as_deref());
        let new_config_json = config_json.or(existing.config_json.as_deref());
        let new_auto_approve_mode = auto_approve_mode.unwrap_or(&existing.auto_approve_mode);

        sqlx::query_as::<_, AgentSetting>(
            r#"UPDATE agent_setting
               SET enabled = $1,
                   env_json = $2,
                   config_json = $3,
                   auto_approve_mode = $4,
                   updated_at = datetime('now')
               WHERE agent_type = $5
               RETURNING id, agent_type, enabled, sort_order, installed_version,
                         env_json, config_json, auto_approve_mode, created_at, updated_at"#,
        )
        .bind(new_enabled)
        .bind(new_env_json)
        .bind(new_config_json)
        .bind(new_auto_approve_mode)
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
        Self::ensure_defaults(pool).await?;
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

#[cfg(test)]
mod tests {
    use sqlx::SqlitePool;

    use super::AgentSetting;

    async fn setup_pool() -> SqlitePool {
        let pool = SqlitePool::connect(":memory:").await.expect("memory db");
        sqlx::query(
            r#"CREATE TABLE agent_setting (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_type TEXT NOT NULL UNIQUE,
                enabled INTEGER NOT NULL DEFAULT 1,
                sort_order INTEGER NOT NULL DEFAULT 0,
                installed_version TEXT,
                env_json TEXT,
                config_json TEXT,
                auto_approve_mode TEXT NOT NULL DEFAULT 'off'
                    CHECK (auto_approve_mode IN ('off', 'allow_always', 'yolo')),
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )"#,
        )
        .execute(&pool)
        .await
        .expect("create table");
        pool
    }

    #[tokio::test]
    async fn list_all_backfills_missing_default_agent_rows() {
        let pool = setup_pool().await;

        let rows = AgentSetting::list_all(&pool).await.expect("list rows");
        let agent_types = rows
            .iter()
            .map(|row| row.agent_type.as_str())
            .collect::<Vec<_>>();
        let sort_orders = rows.iter().map(|row| row.sort_order).collect::<Vec<_>>();

        assert_eq!(
            agent_types,
            vec![
                "claude_code",
                "codex",
                "open_code",
                "gemini",
                "open_claw",
                "cline",
                "hermes"
            ]
        );
        assert_eq!(sort_orders, vec![0, 1, 2, 3, 4, 5, 6]);
    }

    #[tokio::test]
    async fn find_by_type_backfills_defaults_before_lookup() {
        let pool = setup_pool().await;

        let row = AgentSetting::find_by_type(&pool, "codex")
            .await
            .expect("lookup")
            .expect("codex row");

        assert_eq!(row.agent_type, "codex");
    }

    #[tokio::test]
    async fn find_by_type_backfills_new_acp_agent_rows() {
        let pool = setup_pool().await;

        for agent_type in ["gemini", "open_claw", "cline", "hermes"] {
            let row = AgentSetting::find_by_type(&pool, agent_type)
                .await
                .expect("lookup")
                .expect("default row");

            assert_eq!(row.agent_type, agent_type);
        }
    }

    #[tokio::test]
    async fn default_rows_support_preferences_reorder_and_version_updates() {
        let pool = setup_pool().await;

        let gemini = AgentSetting::update_preferences(
            &pool,
            "gemini",
            Some(false),
            Some(r#"{"GEMINI_API_KEY":"test"}"#),
            None,
            Some("allow_always"),
        )
        .await
        .expect("update gemini preferences");

        assert_eq!(gemini.agent_type, "gemini");
        assert!(!gemini.enabled);
        assert_eq!(
            gemini.env_json.as_deref(),
            Some(r#"{"GEMINI_API_KEY":"test"}"#)
        );
        assert_eq!(gemini.auto_approve_mode, "allow_always");

        AgentSetting::update_version(&pool, "hermes", Some("0.16.0"))
            .await
            .expect("update hermes version");
        let hermes = AgentSetting::find_by_type(&pool, "hermes")
            .await
            .expect("lookup hermes")
            .expect("hermes row");
        assert_eq!(hermes.installed_version.as_deref(), Some("0.16.0"));

        AgentSetting::reorder(
            &pool,
            &[
                "hermes".to_string(),
                "cline".to_string(),
                "open_claw".to_string(),
                "gemini".to_string(),
                "open_code".to_string(),
                "codex".to_string(),
                "claude_code".to_string(),
            ],
        )
        .await
        .expect("reorder defaults");

        let rows = AgentSetting::list_all(&pool).await.expect("list rows");
        let agent_types = rows
            .iter()
            .map(|row| row.agent_type.as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            agent_types,
            vec![
                "hermes",
                "cline",
                "open_claw",
                "gemini",
                "open_code",
                "codex",
                "claude_code"
            ]
        );
    }
}
