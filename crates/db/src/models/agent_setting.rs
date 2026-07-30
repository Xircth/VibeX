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
    pub auto_approve_mode: String,
    /// The last complete, successfully verified local CLI + ACP pair. These
    /// values are internal catalog-validation state, not user preferences.
    pub runtime_cli_path: Option<String>,
    pub runtime_cli_version: Option<String>,
    pub runtime_cli_revision: Option<String>,
    pub runtime_acp_path: Option<String>,
    pub runtime_acp_version: Option<String>,
    pub runtime_acp_revision: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Persisted identity of the exact local runtime pair that passed a version
/// verification. The revision strings are opaque to the database; the desktop
/// process compares them with a current, filesystem-only revision before it
/// reuses a capability catalog after restart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersistedAgentRuntimeIdentity {
    pub cli_path: String,
    pub cli_version: String,
    pub cli_revision: String,
    pub acp_path: String,
    pub acp_version: String,
    pub acp_revision: String,
}

impl AgentSetting {
    /// List all agent settings ordered by sort_order.
    pub async fn list_all(pool: &SqlitePool) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, AgentSetting>(
            r#"SELECT id, agent_type, enabled, sort_order, installed_version,
                      env_json, config_json, auto_approve_mode,
                      runtime_cli_path, runtime_cli_version, runtime_cli_revision,
                      runtime_acp_path, runtime_acp_version, runtime_acp_revision,
                      created_at, updated_at
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
                      env_json, config_json, auto_approve_mode,
                      runtime_cli_path, runtime_cli_version, runtime_cli_revision,
                      runtime_acp_path, runtime_acp_version, runtime_acp_revision,
                      created_at, updated_at
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
                         env_json, config_json, auto_approve_mode,
                         runtime_cli_path, runtime_cli_version, runtime_cli_revision,
                         runtime_acp_path, runtime_acp_version, runtime_acp_revision,
                         created_at, updated_at"#,
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

    /// Persist (or clear) the locally verified runtime pair. A partial identity
    /// is intentionally never written: readers treat it as unsafe and will
    /// wait for the startup/preflight verification instead of accepting an old
    /// capability catalog.
    pub async fn update_runtime_identity(
        pool: &SqlitePool,
        agent_type: &str,
        identity: Option<&PersistedAgentRuntimeIdentity>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"UPDATE agent_setting
               SET runtime_cli_path = $1,
                   runtime_cli_version = $2,
                   runtime_cli_revision = $3,
                   runtime_acp_path = $4,
                   runtime_acp_version = $5,
                   runtime_acp_revision = $6,
                   updated_at = datetime('now')
               WHERE agent_type = $7"#,
        )
        .bind(identity.map(|identity| identity.cli_path.as_str()))
        .bind(identity.map(|identity| identity.cli_version.as_str()))
        .bind(identity.map(|identity| identity.cli_revision.as_str()))
        .bind(identity.map(|identity| identity.acp_path.as_str()))
        .bind(identity.map(|identity| identity.acp_version.as_str()))
        .bind(identity.map(|identity| identity.acp_revision.as_str()))
        .bind(agent_type)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Returns a complete persisted identity only. Callers that need to
    /// distinguish no prior identity from a malformed/partial row can inspect
    /// the six public runtime fields directly.
    pub fn persisted_runtime_identity(&self) -> Option<PersistedAgentRuntimeIdentity> {
        Some(PersistedAgentRuntimeIdentity {
            cli_path: self.runtime_cli_path.clone()?,
            cli_version: self.runtime_cli_version.clone()?,
            cli_revision: self.runtime_cli_revision.clone()?,
            acp_path: self.runtime_acp_path.clone()?,
            acp_version: self.runtime_acp_version.clone()?,
            acp_revision: self.runtime_acp_revision.clone()?,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use sqlx::{
        SqlitePool,
        sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    };

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
                runtime_cli_path TEXT,
                runtime_cli_version TEXT,
                runtime_cli_revision TEXT,
                runtime_acp_path TEXT,
                runtime_acp_version TEXT,
                runtime_acp_revision TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )"#,
        )
        .execute(&pool)
        .await
        .expect("create table");
        for (position, agent_id) in [
            "claude_code",
            "codex",
            "opencode",
            "gemini",
            "openclaw",
            "cline",
            "hermes",
        ]
        .into_iter()
        .enumerate()
        {
            sqlx::query("INSERT INTO agent_setting (agent_type, sort_order) VALUES (?, ?)")
                .bind(agent_id)
                .bind(position as i64)
                .execute(&pool)
                .await
                .expect("insert explicit legacy fixture row");
        }
        pool
    }

    async fn migrated_pool() -> SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("sqlite options")
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("connect memory db");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        pool
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
                "openclaw".to_string(),
                "gemini".to_string(),
                "opencode".to_string(),
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
                "openclaw",
                "gemini",
                "opencode",
                "codex",
                "claude_code"
            ]
        );
    }

    #[tokio::test]
    async fn persists_only_a_complete_runtime_identity() {
        let pool = setup_pool().await;
        let identity = super::PersistedAgentRuntimeIdentity {
            cli_path: "/usr/local/bin/codex".to_string(),
            cli_version: "0.130.0".to_string(),
            cli_revision: "cli-revision".to_string(),
            acp_path: "/usr/local/bin/codex-acp".to_string(),
            acp_version: "1.1.2".to_string(),
            acp_revision: "acp-revision".to_string(),
        };

        AgentSetting::update_runtime_identity(&pool, "codex", Some(&identity))
            .await
            .expect("persist runtime identity");
        let stored = AgentSetting::find_by_type(&pool, "codex")
            .await
            .expect("lookup")
            .expect("codex row");
        assert_eq!(stored.persisted_runtime_identity(), Some(identity.clone()));

        AgentSetting::update_runtime_identity(&pool, "codex", None)
            .await
            .expect("clear runtime identity");
        let cleared = AgentSetting::find_by_type(&pool, "codex")
            .await
            .expect("lookup")
            .expect("codex row");
        assert_eq!(cleared.persisted_runtime_identity(), None);
        assert!(cleared.runtime_cli_path.is_none());
        assert!(cleared.runtime_acp_revision.is_none());
    }

    #[tokio::test]
    async fn real_migrations_add_runtime_identity_columns() {
        let pool = migrated_pool().await;

        let codex = AgentSetting::find_by_type(&pool, "codex")
            .await
            .expect("lookup")
            .expect("seeded codex row");
        assert_eq!(codex.persisted_runtime_identity(), None);

        let identity = super::PersistedAgentRuntimeIdentity {
            cli_path: "/usr/local/bin/codex".to_string(),
            cli_version: "0.130.0".to_string(),
            cli_revision: "cli-revision".to_string(),
            acp_path: "/usr/local/bin/codex-acp".to_string(),
            acp_version: "1.1.2".to_string(),
            acp_revision: "acp-revision".to_string(),
        };
        AgentSetting::update_runtime_identity(&pool, "codex", Some(&identity))
            .await
            .expect("write migrated runtime identity");
        let stored = AgentSetting::find_by_type(&pool, "codex")
            .await
            .expect("lookup")
            .expect("seeded codex row");
        assert_eq!(stored.persisted_runtime_identity(), Some(identity));
    }
}
