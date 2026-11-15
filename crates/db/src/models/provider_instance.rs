//! Persistent multi-instance provider configuration store (`provider_instances`).
//!
//! Stores non-secret provider instance routing metadata (`agent_id`, `instance_id`,
//! `display_name`, serialized `auth_mode`, and `is_default`). Secret API keys never live in
//! this table; `auth_mode` stores only secret reference names / env var names / proxy URLs.

use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use thiserror::Error;
use ts_rs::TS;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum ProviderInstanceStoreError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),

    #[error("provider instance '{instance_id}' not found for agent '{agent_id}'")]
    NotFound {
        agent_id: String,
        instance_id: String,
    },

    #[error("provider instance '{instance_id}' already exists for agent '{agent_id}'")]
    DuplicateInstance {
        agent_id: String,
        instance_id: String,
    },

    #[error(
        "cannot delete default provider instance '{instance_id}' for agent '{agent_id}' while other instances exist; promote another instance to default first"
    )]
    CannotDeleteDefaultWithSiblings {
        agent_id: String,
        instance_id: String,
    },

    #[error("invalid provider instance input: {0}")]
    InvalidInput(String),
}

/// Persisted row in `provider_instances`.
#[derive(Debug, Clone, PartialEq, Eq, FromRow, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct ProviderInstanceRecord {
    pub id: String,
    #[serde(alias = "agent_id")]
    pub agent_id: String,
    #[serde(alias = "instance_id")]
    pub instance_id: String,
    #[serde(alias = "display_name")]
    pub display_name: String,
    /// JSON-serialized `AuthMode` (`subscription` | `api_key` | `proxy`).
    #[serde(alias = "auth_mode")]
    pub auth_mode: String,
    #[serde(alias = "is_default")]
    pub is_default: bool,
    #[serde(alias = "created_at")]
    pub created_at: String,
    #[serde(alias = "updated_at")]
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct CreateProviderInstanceInput<'a> {
    pub id: Option<&'a str>,
    pub agent_id: &'a str,
    pub instance_id: &'a str,
    pub display_name: &'a str,
    pub auth_mode: &'a str,
    pub is_default: bool,
}

#[derive(Debug, Clone, Default)]
pub struct UpdateProviderInstanceInput<'a> {
    pub display_name: Option<&'a str>,
    pub auth_mode: Option<&'a str>,
    pub is_default: Option<bool>,
}

const PROVIDER_INSTANCE_COLUMNS: &str = r#"id,
    agent_id,
    instance_id,
    display_name,
    auth_mode,
    is_default,
    created_at,
    updated_at"#;

/// Idempotently ensure the `provider_instances` table and index exist.
pub async fn ensure_provider_instances_schema(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"CREATE TABLE IF NOT EXISTS provider_instances (
               id TEXT PRIMARY KEY,
               agent_id TEXT NOT NULL,
               instance_id TEXT NOT NULL,
               display_name TEXT NOT NULL,
               auth_mode TEXT NOT NULL,
               is_default INTEGER NOT NULL DEFAULT 0,
               created_at TEXT NOT NULL DEFAULT (datetime('now')),
               updated_at TEXT NOT NULL DEFAULT (datetime('now')),
               UNIQUE(agent_id, instance_id)
           )"#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_provider_instances_agent ON provider_instances(agent_id)",
    )
    .execute(pool)
    .await?;

    Ok(())
}

fn validate_non_empty(field: &str, value: &str) -> Result<String, ProviderInstanceStoreError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(ProviderInstanceStoreError::InvalidInput(format!(
            "{field} must not be empty"
        )));
    }
    Ok(trimmed.to_string())
}

fn validate_auth_mode_json(raw: &str) -> Result<String, ProviderInstanceStoreError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(ProviderInstanceStoreError::InvalidInput(
            "auth_mode must not be empty".into(),
        ));
    }
    let parsed: serde_json::Value = serde_json::from_str(trimmed).map_err(|err| {
        ProviderInstanceStoreError::InvalidInput(format!("auth_mode must be valid JSON: {err}"))
    })?;
    let Some(obj) = parsed.as_object() else {
        return Err(ProviderInstanceStoreError::InvalidInput(
            "auth_mode must be a JSON object".into(),
        ));
    };
    if let Some(kind) = obj.get("type").and_then(serde_json::Value::as_str) {
        if matches!(kind, "subscription" | "api_key" | "proxy") {
            return Ok(trimmed.to_string());
        }
        return Err(ProviderInstanceStoreError::InvalidInput(format!(
            "unsupported auth_mode.type '{kind}'; expected subscription, api_key, or proxy"
        )));
    }
    if let Some(mode) = obj.get("mode").and_then(serde_json::Value::as_str) {
        if matches!(
            mode,
            "OfficialOAuth"
                | "ApiKey"
                | "SecretManager"
                | "official_oauth"
                | "api_key"
                | "secret_manager"
        ) {
            return Ok(trimmed.to_string());
        }
        return Err(ProviderInstanceStoreError::InvalidInput(format!(
            "unsupported auth_mode.mode '{mode}'; expected OfficialOAuth, ApiKey, or SecretManager"
        )));
    }
    if obj.len() == 1
        && let Some((variant_key, inner)) = obj.iter().next()
        && inner.is_object()
        && matches!(
            variant_key.as_str(),
            "OfficialOAuth"
                | "ApiKey"
                | "SecretManager"
                | "official_oauth"
                | "api_key"
                | "secret_manager"
        )
    {
        return Ok(trimmed.to_string());
    }
    Err(ProviderInstanceStoreError::InvalidInput(
        "unsupported auth_mode JSON; expected type (subscription|api_key|proxy) or mode (OfficialOAuth|ApiKey|SecretManager)"
            .into(),
    ))
}

impl ProviderInstanceRecord {
    pub async fn ensure_schema(pool: &SqlitePool) -> Result<(), sqlx::Error> {
        ensure_provider_instances_schema(pool).await
    }

    pub async fn list_all(pool: &SqlitePool) -> Result<Vec<Self>, ProviderInstanceStoreError> {
        ensure_provider_instances_schema(pool).await?;
        let rows = sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {PROVIDER_INSTANCE_COLUMNS}
               FROM provider_instances
               ORDER BY agent_id ASC, is_default DESC, created_at ASC, instance_id ASC"#
        ))
        .fetch_all(pool)
        .await?;
        Ok(rows)
    }

    pub async fn list_by_agent(
        pool: &SqlitePool,
        agent_id: &str,
    ) -> Result<Vec<Self>, ProviderInstanceStoreError> {
        ensure_provider_instances_schema(pool).await?;
        let rows = sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {PROVIDER_INSTANCE_COLUMNS}
               FROM provider_instances
               WHERE agent_id = ?
               ORDER BY is_default DESC, created_at ASC, instance_id ASC"#
        ))
        .bind(agent_id.trim())
        .fetch_all(pool)
        .await?;
        Ok(rows)
    }

    pub async fn find_by_instance(
        pool: &SqlitePool,
        agent_id: &str,
        instance_id: &str,
    ) -> Result<Option<Self>, ProviderInstanceStoreError> {
        ensure_provider_instances_schema(pool).await?;
        let row = sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {PROVIDER_INSTANCE_COLUMNS}
               FROM provider_instances
               WHERE agent_id = ? AND instance_id = ?"#
        ))
        .bind(agent_id.trim())
        .bind(instance_id.trim())
        .fetch_optional(pool)
        .await?;
        Ok(row)
    }

    pub async fn find_default_for_agent(
        pool: &SqlitePool,
        agent_id: &str,
    ) -> Result<Option<Self>, ProviderInstanceStoreError> {
        ensure_provider_instances_schema(pool).await?;
        let row = sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {PROVIDER_INSTANCE_COLUMNS}
               FROM provider_instances
               WHERE agent_id = ?
               ORDER BY is_default DESC, created_at ASC
               LIMIT 1"#
        ))
        .bind(agent_id.trim())
        .fetch_optional(pool)
        .await?;
        Ok(row)
    }

    pub async fn create(
        pool: &SqlitePool,
        input: CreateProviderInstanceInput<'_>,
    ) -> Result<Self, ProviderInstanceStoreError> {
        ensure_provider_instances_schema(pool).await?;
        let agent_id = validate_non_empty("agent_id", input.agent_id)?;
        let instance_id = validate_non_empty("instance_id", input.instance_id)?;
        let display_name = validate_non_empty("display_name", input.display_name)?;
        let auth_mode = validate_auth_mode_json(input.auth_mode)?;
        let id = input
            .id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string());

        let mut tx = pool.begin().await?;

        let existing: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM provider_instances WHERE agent_id = ? AND instance_id = ?",
        )
        .bind(&agent_id)
        .bind(&instance_id)
        .fetch_one(&mut *tx)
        .await?;
        if existing > 0 {
            return Err(ProviderInstanceStoreError::DuplicateInstance {
                agent_id,
                instance_id,
            });
        }

        let sibling_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM provider_instances WHERE agent_id = ?")
                .bind(&agent_id)
                .fetch_one(&mut *tx)
                .await?;

        // First instance for an agent automatically becomes default if none exists yet.
        let make_default = input.is_default || sibling_count == 0;
        if make_default {
            sqlx::query(
                "UPDATE provider_instances \
                 SET is_default = 0, updated_at = datetime('now') \
                 WHERE agent_id = ? AND is_default != 0",
            )
            .bind(&agent_id)
            .execute(&mut *tx)
            .await?;
        }

        let created = sqlx::query_as::<_, Self>(&format!(
            r#"INSERT INTO provider_instances (
                   id, agent_id, instance_id, display_name, auth_mode, is_default
               )
               VALUES (?, ?, ?, ?, ?, ?)
               RETURNING {PROVIDER_INSTANCE_COLUMNS}"#
        ))
        .bind(&id)
        .bind(&agent_id)
        .bind(&instance_id)
        .bind(&display_name)
        .bind(&auth_mode)
        .bind(make_default)
        .fetch_one(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(created)
    }

    pub async fn update(
        pool: &SqlitePool,
        agent_id: &str,
        instance_id: &str,
        input: UpdateProviderInstanceInput<'_>,
    ) -> Result<Self, ProviderInstanceStoreError> {
        ensure_provider_instances_schema(pool).await?;
        let agent_id = validate_non_empty("agent_id", agent_id)?;
        let instance_id = validate_non_empty("instance_id", instance_id)?;
        let next_display_name = match input.display_name {
            Some(name) => Some(validate_non_empty("display_name", name)?),
            None => None,
        };
        let next_auth_mode = match input.auth_mode {
            Some(mode) => Some(validate_auth_mode_json(mode)?),
            None => None,
        };

        let mut tx = pool.begin().await?;

        let current = sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {PROVIDER_INSTANCE_COLUMNS}
               FROM provider_instances
               WHERE agent_id = ? AND instance_id = ?"#
        ))
        .bind(&agent_id)
        .bind(&instance_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| ProviderInstanceStoreError::NotFound {
            agent_id: agent_id.clone(),
            instance_id: instance_id.clone(),
        })?;

        let target_default = input.is_default.unwrap_or(current.is_default);
        if target_default && !current.is_default {
            sqlx::query(
                "UPDATE provider_instances \
                 SET is_default = 0, updated_at = datetime('now') \
                 WHERE agent_id = ? AND is_default != 0",
            )
            .bind(&agent_id)
            .execute(&mut *tx)
            .await?;
        }

        let updated = sqlx::query_as::<_, Self>(&format!(
            r#"UPDATE provider_instances
               SET display_name = COALESCE(?, display_name),
                   auth_mode = COALESCE(?, auth_mode),
                   is_default = ?,
                   updated_at = datetime('now')
               WHERE agent_id = ? AND instance_id = ?
               RETURNING {PROVIDER_INSTANCE_COLUMNS}"#
        ))
        .bind(next_display_name.as_deref())
        .bind(next_auth_mode.as_deref())
        .bind(target_default)
        .bind(&agent_id)
        .bind(&instance_id)
        .fetch_one(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(updated)
    }

    /// Atomically clear `is_default` across all instances of `agent_id` and promote `instance_id`.
    pub async fn set_default(
        pool: &SqlitePool,
        agent_id: &str,
        instance_id: &str,
    ) -> Result<Self, ProviderInstanceStoreError> {
        ensure_provider_instances_schema(pool).await?;
        let agent_id = validate_non_empty("agent_id", agent_id)?;
        let instance_id = validate_non_empty("instance_id", instance_id)?;

        let mut tx = pool.begin().await?;
        let exists: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM provider_instances WHERE agent_id = ? AND instance_id = ?",
        )
        .bind(&agent_id)
        .bind(&instance_id)
        .fetch_one(&mut *tx)
        .await?;
        if exists == 0 {
            return Err(ProviderInstanceStoreError::NotFound {
                agent_id,
                instance_id,
            });
        }

        sqlx::query(
            "UPDATE provider_instances \
             SET is_default = 0, updated_at = datetime('now') \
             WHERE agent_id = ?",
        )
        .bind(&agent_id)
        .execute(&mut *tx)
        .await?;

        let promoted = sqlx::query_as::<_, Self>(&format!(
            r#"UPDATE provider_instances
               SET is_default = 1, updated_at = datetime('now')
               WHERE agent_id = ? AND instance_id = ?
               RETURNING {PROVIDER_INSTANCE_COLUMNS}"#
        ))
        .bind(&agent_id)
        .bind(&instance_id)
        .fetch_one(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(promoted)
    }

    /// Delete `(agent_id, instance_id)`, rejecting deletion of a default instance while
    /// sibling instances still exist for the same `agent_id`.
    pub async fn delete(
        pool: &SqlitePool,
        agent_id: &str,
        instance_id: &str,
    ) -> Result<(), ProviderInstanceStoreError> {
        ensure_provider_instances_schema(pool).await?;
        let agent_id = validate_non_empty("agent_id", agent_id)?;
        let instance_id = validate_non_empty("instance_id", instance_id)?;

        let mut tx = pool.begin().await?;

        let target = sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {PROVIDER_INSTANCE_COLUMNS}
               FROM provider_instances
               WHERE agent_id = ? AND instance_id = ?"#
        ))
        .bind(&agent_id)
        .bind(&instance_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| ProviderInstanceStoreError::NotFound {
            agent_id: agent_id.clone(),
            instance_id: instance_id.clone(),
        })?;

        if target.is_default {
            let sibling_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM provider_instances WHERE agent_id = ? AND instance_id != ?",
            )
            .bind(&agent_id)
            .bind(&instance_id)
            .fetch_one(&mut *tx)
            .await?;
            if sibling_count > 0 {
                return Err(
                    ProviderInstanceStoreError::CannotDeleteDefaultWithSiblings {
                        agent_id,
                        instance_id,
                    },
                );
            }
        }

        sqlx::query("DELETE FROM provider_instances WHERE agent_id = ? AND instance_id = ?")
            .bind(&agent_id)
            .bind(&instance_id)
            .execute(&mut *tx)
            .await?;

        tx.commit().await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::*;

    async fn test_pool() -> SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:").expect("sqlite options");
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("memory pool");
        ensure_provider_instances_schema(&pool)
            .await
            .expect("ensure schema");
        pool
    }

    #[tokio::test]
    async fn crud_atomic_default_switch_and_default_deletion_guard() {
        let pool = test_pool().await;

        let sub = ProviderInstanceRecord::create(
            &pool,
            CreateProviderInstanceInput {
                id: None,
                agent_id: "claude",
                instance_id: "claude-sub",
                display_name: "Claude Max",
                auth_mode: r#"{"type":"subscription"}"#,
                is_default: false,
            },
        )
        .await
        .expect("create first instance");
        // First instance for an agent is promoted to default automatically.
        assert!(sub.is_default);

        let api = ProviderInstanceRecord::create(
            &pool,
            CreateProviderInstanceInput {
                id: None,
                agent_id: "claude",
                instance_id: "claude-api",
                display_name: "Claude API Key",
                auth_mode: r#"{"type":"api_key","env_var_name":"ANTHROPIC_API_KEY"}"#,
                is_default: false,
            },
        )
        .await
        .expect("create second instance");
        assert!(!api.is_default);

        // Deleting default while sibling exists must fail.
        let err = ProviderInstanceRecord::delete(&pool, "claude", "claude-sub")
            .await
            .expect_err("must reject deleting default with siblings");
        assert!(matches!(
            err,
            ProviderInstanceStoreError::CannotDeleteDefaultWithSiblings { .. }
        ));

        // Promote `claude-api` atomically; `claude-sub` loses `is_default`.
        let promoted = ProviderInstanceRecord::set_default(&pool, "claude", "claude-api")
            .await
            .expect("set_default");
        assert!(promoted.is_default);

        let all = ProviderInstanceRecord::list_by_agent(&pool, "claude")
            .await
            .expect("list_by_agent");
        assert_eq!(all.len(), 2);
        assert_eq!(all.iter().filter(|r| r.is_default).count(), 1);
        assert_eq!(all[0].instance_id, "claude-api");

        // Now `claude-sub` is non-default and can be deleted; then sole remaining default can be deleted.
        ProviderInstanceRecord::delete(&pool, "claude", "claude-sub")
            .await
            .expect("delete non-default");
        ProviderInstanceRecord::delete(&pool, "claude", "claude-api")
            .await
            .expect("delete sole remaining default");

        let empty = ProviderInstanceRecord::list_by_agent(&pool, "claude")
            .await
            .expect("list empty");
        assert!(empty.is_empty());
    }
}
