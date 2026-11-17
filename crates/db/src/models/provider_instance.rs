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

pub const LOCAL_PROVIDER_INSTANCE_ID: &str = "local";

const RESERVED_INSTANCE_IDS: &[&str] = &[
    "local",
    "__proto__",
    "constructor",
    "toString",
    "valueOf",
    "hasOwnProperty",
];

/// Canonicalizes supported multi-instance agent IDs (`claude_code` and `codex`).
pub fn canonical_provider_agent_id(raw: &str) -> Result<String, ProviderInstanceStoreError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(ProviderInstanceStoreError::InvalidInput(
            "agent_id must not be empty".into(),
        ));
    }
    let normalized = trimmed.to_ascii_lowercase().replace('-', "_");
    match normalized.as_str() {
        "claude" | "claude_code" | "claudecode" | "claude_native" => Ok("claude_code".to_string()),
        "codex" | "codex_cli" | "openai_codex" | "codex_native" => Ok("codex".to_string()),
        _ => Err(ProviderInstanceStoreError::InvalidInput(format!(
            "multi-instance providers are currently only supported for claude_code and codex (got '{trimmed}')"
        ))),
    }
}

/// Candidate `agent_id` strings for backwards-compatible lookups of legacy rows.
pub fn candidate_provider_agent_ids(raw: &str) -> Vec<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    match canonical_provider_agent_id(trimmed) {
        Ok(canonical) if canonical == "claude_code" => vec![
            "claude_code".to_string(),
            "claude-code".to_string(),
            "claude".to_string(),
        ],
        Ok(canonical) if canonical == "codex" => vec![
            "codex".to_string(),
            "codex_cli".to_string(),
            "openai_codex".to_string(),
        ],
        _ => vec![trimmed.to_string()],
    }
}

/// Strict T3Code-compatible `instanceId` validation:
/// `^[a-zA-Z][a-zA-Z0-9_-]{0,63}$`, rejecting `"local"` and JS prototype keys.
pub fn validate_instance_id(raw: &str) -> Result<String, ProviderInstanceStoreError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(ProviderInstanceStoreError::InvalidInput(
            "instance_id must not be empty".into(),
        ));
    }
    if trimmed.len() > 64 {
        return Err(ProviderInstanceStoreError::InvalidInput(
            "instance_id must be at most 64 characters".into(),
        ));
    }
    let mut chars = trimmed.chars();
    let Some(first) = chars.next() else {
        return Err(ProviderInstanceStoreError::InvalidInput(
            "instance_id must not be empty".into(),
        ));
    };
    if !first.is_ascii_alphabetic()
        || !chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return Err(ProviderInstanceStoreError::InvalidInput(format!(
            "instance_id '{trimmed}' must match ^[a-zA-Z][a-zA-Z0-9_-]{{0,63}}$"
        )));
    }
    if trimmed.eq_ignore_ascii_case(LOCAL_PROVIDER_INSTANCE_ID)
        || RESERVED_INSTANCE_IDS
            .iter()
            .any(|reserved| *reserved == trimmed || reserved.eq_ignore_ascii_case(trimmed))
    {
        return Err(ProviderInstanceStoreError::InvalidInput(format!(
            "instance_id '{trimmed}' is reserved"
        )));
    }
    Ok(trimmed.to_string())
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
        let mut rows = sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {PROVIDER_INSTANCE_COLUMNS}
               FROM provider_instances
               ORDER BY agent_id ASC, is_default DESC, created_at ASC, instance_id ASC"#
        ))
        .fetch_all(pool)
        .await?;
        for row in &mut rows {
            if let Ok(canonical) = canonical_provider_agent_id(&row.agent_id) {
                row.agent_id = canonical;
            }
        }
        Ok(rows)
    }

    pub async fn list_by_agent(
        pool: &SqlitePool,
        agent_id: &str,
    ) -> Result<Vec<Self>, ProviderInstanceStoreError> {
        ensure_provider_instances_schema(pool).await?;
        let candidates = candidate_provider_agent_ids(agent_id);
        if candidates.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders = vec!["?"; candidates.len()].join(", ");
        let sql = format!(
            r#"SELECT {PROVIDER_INSTANCE_COLUMNS}
               FROM provider_instances
               WHERE agent_id IN ({placeholders})
               ORDER BY is_default DESC, created_at ASC, instance_id ASC"#
        );
        let mut query = sqlx::query_as::<_, Self>(&sql);
        for candidate in &candidates {
            query = query.bind(candidate);
        }
        let mut rows = query.fetch_all(pool).await?;
        if let Ok(canonical) = canonical_provider_agent_id(agent_id) {
            for row in &mut rows {
                row.agent_id = canonical.clone();
            }
        }
        Ok(rows)
    }

    pub async fn find_by_instance(
        pool: &SqlitePool,
        agent_id: &str,
        instance_id: &str,
    ) -> Result<Option<Self>, ProviderInstanceStoreError> {
        ensure_provider_instances_schema(pool).await?;
        let trimmed_id = instance_id.trim();
        if trimmed_id.is_empty() || trimmed_id.eq_ignore_ascii_case(LOCAL_PROVIDER_INSTANCE_ID) {
            return Ok(None);
        }
        let candidates = candidate_provider_agent_ids(agent_id);
        if candidates.is_empty() {
            return Ok(None);
        }
        let placeholders = vec!["?"; candidates.len()].join(", ");
        let sql = format!(
            r#"SELECT {PROVIDER_INSTANCE_COLUMNS}
               FROM provider_instances
               WHERE agent_id IN ({placeholders}) AND instance_id = ?
               LIMIT 1"#
        );
        let mut query = sqlx::query_as::<_, Self>(&sql);
        for candidate in &candidates {
            query = query.bind(candidate);
        }
        let mut row = query.bind(trimmed_id).fetch_optional(pool).await?;
        if let Some(ref mut rec) = row
            && let Ok(canonical) = canonical_provider_agent_id(agent_id)
        {
            rec.agent_id = canonical;
        }
        Ok(row)
    }

    pub async fn find_default_for_agent(
        pool: &SqlitePool,
        agent_id: &str,
    ) -> Result<Option<Self>, ProviderInstanceStoreError> {
        ensure_provider_instances_schema(pool).await?;
        let candidates = candidate_provider_agent_ids(agent_id);
        if candidates.is_empty() {
            return Ok(None);
        }
        let placeholders = vec!["?"; candidates.len()].join(", ");
        let sql = format!(
            r#"SELECT {PROVIDER_INSTANCE_COLUMNS}
               FROM provider_instances
               WHERE agent_id IN ({placeholders}) AND is_default != 0
               ORDER BY updated_at DESC, created_at ASC
               LIMIT 1"#
        );
        let mut query = sqlx::query_as::<_, Self>(&sql);
        for candidate in &candidates {
            query = query.bind(candidate);
        }
        let mut row = query.fetch_optional(pool).await?;
        if let Some(ref mut rec) = row
            && let Ok(canonical) = canonical_provider_agent_id(agent_id)
        {
            rec.agent_id = canonical;
        }
        Ok(row)
    }

    pub async fn create(
        pool: &SqlitePool,
        input: CreateProviderInstanceInput<'_>,
    ) -> Result<Self, ProviderInstanceStoreError> {
        ensure_provider_instances_schema(pool).await?;
        let agent_id = canonical_provider_agent_id(input.agent_id)?;
        let instance_id = validate_instance_id(input.instance_id)?;
        let display_name = validate_non_empty("display_name", input.display_name)?;
        let auth_mode = validate_auth_mode_json(input.auth_mode)?;
        let id = input
            .id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string());

        let candidates = candidate_provider_agent_ids(&agent_id);
        let placeholders = vec!["?"; candidates.len()].join(", ");

        let mut tx = pool.begin().await?;

        let existing_sql = format!(
            "SELECT COUNT(*) FROM provider_instances WHERE agent_id IN ({placeholders}) AND instance_id = ?"
        );
        let mut existing_q = sqlx::query_scalar::<_, i64>(&existing_sql);
        for candidate in &candidates {
            existing_q = existing_q.bind(candidate);
        }
        let existing = existing_q.bind(&instance_id).fetch_one(&mut *tx).await?;
        if existing > 0 {
            return Err(ProviderInstanceStoreError::DuplicateInstance {
                agent_id,
                instance_id,
            });
        }

        // `"local"` is the built-in default instance; only mark a custom instance default when requested.
        let make_default = input.is_default;
        if make_default {
            let clear_sql = format!(
                "UPDATE provider_instances \
                 SET is_default = 0, updated_at = datetime('now') \
                 WHERE agent_id IN ({placeholders}) AND is_default != 0"
            );
            let mut clear_q = sqlx::query(&clear_sql);
            for candidate in &candidates {
                clear_q = clear_q.bind(candidate);
            }
            clear_q.execute(&mut *tx).await?;
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
        let canonical_agent = canonical_provider_agent_id(agent_id)?;
        let instance_id = validate_instance_id(instance_id)?;
        let next_display_name = match input.display_name {
            Some(name) => Some(validate_non_empty("display_name", name)?),
            None => None,
        };
        let next_auth_mode = match input.auth_mode {
            Some(mode) => Some(validate_auth_mode_json(mode)?),
            None => None,
        };

        let candidates = candidate_provider_agent_ids(&canonical_agent);
        let placeholders = vec!["?"; candidates.len()].join(", ");

        let mut tx = pool.begin().await?;

        let find_sql = format!(
            r#"SELECT {PROVIDER_INSTANCE_COLUMNS}
               FROM provider_instances
               WHERE agent_id IN ({placeholders}) AND instance_id = ?
               LIMIT 1"#
        );
        let mut find_q = sqlx::query_as::<_, Self>(&find_sql);
        for candidate in &candidates {
            find_q = find_q.bind(candidate);
        }
        let current = find_q
            .bind(&instance_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| ProviderInstanceStoreError::NotFound {
                agent_id: canonical_agent.clone(),
                instance_id: instance_id.clone(),
            })?;

        let target_default = input.is_default.unwrap_or(current.is_default);
        if target_default && !current.is_default {
            let clear_sql = format!(
                "UPDATE provider_instances \
                 SET is_default = 0, updated_at = datetime('now') \
                 WHERE agent_id IN ({placeholders}) AND is_default != 0"
            );
            let mut clear_q = sqlx::query(&clear_sql);
            for candidate in &candidates {
                clear_q = clear_q.bind(candidate);
            }
            clear_q.execute(&mut *tx).await?;
        }

        let mut updated = sqlx::query_as::<_, Self>(&format!(
            r#"UPDATE provider_instances
               SET agent_id = ?,
                   display_name = COALESCE(?, display_name),
                   auth_mode = COALESCE(?, auth_mode),
                   is_default = ?,
                   updated_at = datetime('now')
               WHERE id = ?
               RETURNING {PROVIDER_INSTANCE_COLUMNS}"#
        ))
        .bind(&canonical_agent)
        .bind(next_display_name.as_deref())
        .bind(next_auth_mode.as_deref())
        .bind(target_default)
        .bind(&current.id)
        .fetch_one(&mut *tx)
        .await?;
        updated.agent_id = canonical_agent;

        tx.commit().await?;
        Ok(updated)
    }

    /// Clear `is_default` across all custom instances of `agent_id` so `"local"` becomes default.
    pub async fn clear_default(
        pool: &SqlitePool,
        agent_id: &str,
    ) -> Result<(), ProviderInstanceStoreError> {
        ensure_provider_instances_schema(pool).await?;
        let canonical_agent = canonical_provider_agent_id(agent_id)?;
        let candidates = candidate_provider_agent_ids(&canonical_agent);
        let placeholders = vec!["?"; candidates.len()].join(", ");
        let clear_sql = format!(
            "UPDATE provider_instances \
             SET is_default = 0, updated_at = datetime('now') \
             WHERE agent_id IN ({placeholders}) AND is_default != 0"
        );
        let mut clear_q = sqlx::query(&clear_sql);
        for candidate in &candidates {
            clear_q = clear_q.bind(candidate);
        }
        clear_q.execute(pool).await?;
        Ok(())
    }

    /// Atomically clear `is_default` across all instances of `agent_id` and promote `instance_id`
    /// (or revert default to `"local"` when `instance_id` is `"local"`).
    pub async fn set_default(
        pool: &SqlitePool,
        agent_id: &str,
        instance_id: &str,
    ) -> Result<Option<Self>, ProviderInstanceStoreError> {
        ensure_provider_instances_schema(pool).await?;
        let canonical_agent = canonical_provider_agent_id(agent_id)?;
        let trimmed_id = instance_id.trim();
        if trimmed_id.eq_ignore_ascii_case(LOCAL_PROVIDER_INSTANCE_ID) {
            Self::clear_default(pool, &canonical_agent).await?;
            return Ok(None);
        }
        let instance_id = validate_instance_id(trimmed_id)?;
        let candidates = candidate_provider_agent_ids(&canonical_agent);
        let placeholders = vec!["?"; candidates.len()].join(", ");

        let mut tx = pool.begin().await?;
        let find_sql = format!(
            "SELECT id FROM provider_instances WHERE agent_id IN ({placeholders}) AND instance_id = ? LIMIT 1"
        );
        let mut find_q = sqlx::query_scalar::<_, String>(&find_sql);
        for candidate in &candidates {
            find_q = find_q.bind(candidate);
        }
        let Some(row_id) = find_q.bind(&instance_id).fetch_optional(&mut *tx).await? else {
            return Err(ProviderInstanceStoreError::NotFound {
                agent_id: canonical_agent,
                instance_id,
            });
        };

        let clear_sql = format!(
            "UPDATE provider_instances \
             SET is_default = 0, updated_at = datetime('now') \
             WHERE agent_id IN ({placeholders})"
        );
        let mut clear_q = sqlx::query(&clear_sql);
        for candidate in &candidates {
            clear_q = clear_q.bind(candidate);
        }
        clear_q.execute(&mut *tx).await?;

        let mut promoted = sqlx::query_as::<_, Self>(&format!(
            r#"UPDATE provider_instances
               SET is_default = 1, updated_at = datetime('now')
               WHERE id = ?
               RETURNING {PROVIDER_INSTANCE_COLUMNS}"#
        ))
        .bind(&row_id)
        .fetch_one(&mut *tx)
        .await?;
        promoted.agent_id = canonical_agent;

        tx.commit().await?;
        Ok(Some(promoted))
    }

    /// Delete `(agent_id, instance_id)`. If it was default, default naturally falls back to `"local"`.
    pub async fn delete(
        pool: &SqlitePool,
        agent_id: &str,
        instance_id: &str,
    ) -> Result<(), ProviderInstanceStoreError> {
        ensure_provider_instances_schema(pool).await?;
        let canonical_agent = canonical_provider_agent_id(agent_id)?;
        let instance_id = validate_instance_id(instance_id)?;
        let candidates = candidate_provider_agent_ids(&canonical_agent);
        let placeholders = vec!["?"; candidates.len()].join(", ");

        let mut tx = pool.begin().await?;

        let find_sql = format!(
            "SELECT id FROM provider_instances WHERE agent_id IN ({placeholders}) AND instance_id = ? LIMIT 1"
        );
        let mut find_q = sqlx::query_scalar::<_, String>(&find_sql);
        for candidate in &candidates {
            find_q = find_q.bind(candidate);
        }
        let Some(row_id) = find_q.bind(&instance_id).fetch_optional(&mut *tx).await? else {
            return Err(ProviderInstanceStoreError::NotFound {
                agent_id: canonical_agent,
                instance_id,
            });
        };

        sqlx::query("DELETE FROM provider_instances WHERE id = ?")
            .bind(&row_id)
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

    #[test]
    fn validates_instance_ids_and_agent_canonicalization() {
        assert_eq!(canonical_provider_agent_id("claude").unwrap(), "claude_code");
        assert_eq!(canonical_provider_agent_id("claude-code").unwrap(), "claude_code");
        assert_eq!(canonical_provider_agent_id("codex").unwrap(), "codex");
        assert!(canonical_provider_agent_id("cursor").is_err());

        assert!(validate_instance_id("work-1").is_ok());
        assert!(validate_instance_id("Inst_Alpha").is_ok());
        for bad in [
            "",
            "local",
            "LOCAL",
            "1abc",
            "-abc",
            "../etc",
            "__proto__",
            "constructor",
            "toString",
            "valueOf",
            "hasOwnProperty",
        ] {
            assert!(validate_instance_id(bad).is_err(), "expected {bad} to fail");
        }
    }

    #[tokio::test]
    async fn crud_atomic_default_switch_and_local_fallback() {
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
        // Implicit `"local"` stays default unless explicitly promoted.
        assert!(!sub.is_default);
        assert_eq!(sub.agent_id, "claude_code");
        assert!(
            ProviderInstanceRecord::find_default_for_agent(&pool, "claude_code")
                .await
                .unwrap()
                .is_none()
        );

        let api = ProviderInstanceRecord::create(
            &pool,
            CreateProviderInstanceInput {
                id: None,
                agent_id: "claude_code",
                instance_id: "claude-api",
                display_name: "Claude API Key",
                auth_mode: r#"{"type":"api_key","env_var_name":"ANTHROPIC_API_KEY"}"#,
                is_default: true,
            },
        )
        .await
        .expect("create second instance");
        assert!(api.is_default);

        // Promote `claude-sub` atomically; `claude-api` loses `is_default`.
        let promoted = ProviderInstanceRecord::set_default(&pool, "claude_code", "claude-sub")
            .await
            .expect("set_default")
            .expect("custom promoted");
        assert!(promoted.is_default);

        let all = ProviderInstanceRecord::list_by_agent(&pool, "claude-code")
            .await
            .expect("list_by_agent");
        assert_eq!(all.len(), 2);
        assert_eq!(all.iter().filter(|r| r.is_default).count(), 1);
        assert_eq!(all[0].instance_id, "claude-sub");

        // Switch default back to implicit `"local"`.
        assert!(
            ProviderInstanceRecord::set_default(&pool, "claude_code", "local")
                .await
                .expect("set_default local")
                .is_none()
        );
        assert!(
            ProviderInstanceRecord::find_default_for_agent(&pool, "claude_code")
                .await
                .unwrap()
                .is_none()
        );

        // Deleting a default or non-default instance succeeds cleanly and leaves siblings intact.
        ProviderInstanceRecord::set_default(&pool, "claude_code", "claude-sub")
            .await
            .unwrap();
        ProviderInstanceRecord::delete(&pool, "claude_code", "claude-sub")
            .await
            .expect("delete default");
        ProviderInstanceRecord::delete(&pool, "claude_code", "claude-api")
            .await
            .expect("delete remaining");

        let empty = ProviderInstanceRecord::list_by_agent(&pool, "claude_code")
            .await
            .expect("list empty");
        assert!(empty.is_empty());
    }
}
