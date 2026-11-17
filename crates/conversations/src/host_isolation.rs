use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};

use agents::{
    AgentId, AgentKind, built_in_auth_mode_policy,
    codex_shadow_home::{
        AMBIENT_PROVIDER_CREDENTIAL_ENV_KEYS, LOCAL_INSTANCE_OVERRIDE_ENV_KEYS,
        prepare_codex_shadow_home,
    },
    secret_resolution::{
        ProviderAuthMode, ProviderInstanceConfig, SecretRef, SecretResolver,
        ensure_private_instance_dir,
    },
};
use db::models::provider_instance::{
    LOCAL_PROVIDER_INSTANCE_ID, ProviderInstanceRecord, ProviderInstanceStoreError,
    candidate_provider_agent_ids, canonical_provider_agent_id,
};
use sqlx::SqlitePool;

use crate::ConversationServiceError;

pub fn sanitize_instance_segment(raw: &str) -> String {
    let sanitized: String = raw
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = sanitized.trim_matches(['.', '_']);
    if trimmed.is_empty() {
        "instance".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn isolated_instance_root(
    agent_id: &AgentId,
    instance_id: &str,
    instances_root_override: Option<&Path>,
) -> Option<PathBuf> {
    let agent_slug = canonical_provider_agent_id(agent_id.as_str()).ok()?;
    let root = instances_root_override
        .map(Path::to_path_buf)
        .unwrap_or_else(|| utils::assets::asset_dir().join("provider-instances"));
    Some(
        root.join(agent_slug)
            .join(sanitize_instance_segment(instance_id)),
    )
}

pub fn isolated_instance_native_dir(
    agent_id: &AgentId,
    instance_dir: &Path,
) -> Option<(&'static str, PathBuf)> {
    match canonical_provider_agent_id(agent_id.as_str())
        .ok()
        .as_deref()
    {
        Some("claude_code") => Some(("CLAUDE_CONFIG_DIR", instance_dir.join("claude-config"))),
        Some("codex") => Some(("CODEX_HOME", instance_dir.join("codex-home"))),
        _ => None,
    }
}

/// Remove local-instance auth, provider-routing, and directory-override env vars
/// before assembling a custom isolated instance's launch environment.
pub(crate) fn scrub_local_auth_and_dir_env(agent_id: &AgentId, env: &mut HashMap<String, String>) {
    for key in AMBIENT_PROVIDER_CREDENTIAL_ENV_KEYS {
        env.remove(*key);
    }
    for key in LOCAL_INSTANCE_OVERRIDE_ENV_KEYS {
        env.remove(*key);
    }
    for key in [
        "CLAUDE_AUTH_MODE",
        "CODEX_AUTH_MODE",
        "DIMO_AGENT_MODEL_PROVIDER_ID",
        "DIMO_AGENT_MODEL_PROVIDER_NAME",
        "DISABLE_MCP_CONFIG_FILTERING",
        "INITIAL_AGENT_MODE",
        "DIMO_ISOLATE_PROVIDER_PROFILE",
    ] {
        env.remove(key);
    }
    if let Some(policy) = built_in_auth_mode_policy(agent_id) {
        env.remove(policy.mode_env);
        env.remove(policy.credential_env);
        for key in policy.subscription_scrub_env {
            env.remove(*key);
        }
    }
}

fn load_instance_env_file(instance_dir: &Path, env: &mut HashMap<String, String>) {
    let path = instance_dir.join("instance-env.json");
    let Ok(raw) = std::fs::read_to_string(path) else {
        return;
    };
    let Ok(parsed) = serde_json::from_str::<HashMap<String, String>>(&raw) else {
        return;
    };
    for (key, value) in parsed {
        if !value.trim().is_empty() {
            env.insert(key, value);
        }
    }
}

fn map_provider_store_err(err: ProviderInstanceStoreError) -> ConversationServiceError {
    match err {
        ProviderInstanceStoreError::Database(db_err) => db_err.into(),
        other => ConversationServiceError::BadRequest(other.to_string()),
    }
}

pub(crate) async fn find_selected_provider_instance(
    pool: &SqlitePool,
    agent_id: &AgentId,
    requested_instance_id: Option<&str>,
) -> Result<Option<ProviderInstanceRecord>, ConversationServiceError> {
    let trimmed = requested_instance_id
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if canonical_provider_agent_id(agent_id.as_str()).is_err() {
        if let Some(id) = trimmed
            && !id.eq_ignore_ascii_case(LOCAL_PROVIDER_INSTANCE_ID)
        {
            return Err(ConversationServiceError::BadRequest(format!(
                "Agent `{agent_id}` does not support provider instances"
            )));
        }
        return Ok(None);
    }

    if let Some(id) = trimmed
        && id.eq_ignore_ascii_case(LOCAL_PROVIDER_INSTANCE_ID)
    {
        return Ok(None);
    }

    let exists: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'provider_instances' LIMIT 1",
    )
    .fetch_optional(pool)
    .await?;
    if exists.is_none() {
        if let Some(id) = trimmed {
            return Err(ConversationServiceError::BadRequest(format!(
                "Provider instance `{id}` for `{agent_id}` was not found"
            )));
        }
        return Ok(None);
    }

    let candidates = candidate_provider_agent_ids(agent_id.as_str());
    if let Some(id) = trimmed {
        for candidate in &candidates {
            if let Some(rec) = ProviderInstanceRecord::find_by_instance(pool, candidate, id)
                .await
                .map_err(map_provider_store_err)?
            {
                return Ok(Some(rec));
            }
        }
        return Err(ConversationServiceError::BadRequest(format!(
            "Provider instance `{id}` for `{agent_id}` was not found"
        )));
    }

    for candidate in &candidates {
        if let Some(rec) = ProviderInstanceRecord::find_default_for_agent(pool, candidate)
            .await
            .map_err(map_provider_store_err)?
        {
            return Ok(Some(rec));
        }
    }
    Ok(None)
}

/// Resolves the effective custom provider instance ID (`None` means `"local"`).
pub async fn resolve_effective_provider_instance_id(
    pool: &SqlitePool,
    agent_id: &AgentId,
    requested_instance_id: Option<&str>,
) -> Result<Option<String>, ConversationServiceError> {
    Ok(
        find_selected_provider_instance(pool, agent_id, requested_instance_id)
            .await?
            .map(|rec| rec.instance_id),
    )
}

fn parse_secret_ref_value(value: &serde_json::Value) -> Result<Option<SecretRef>, String> {
    if value.is_null() {
        return Ok(None);
    }
    if let Some(raw) = value.as_str() {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }
        if trimmed.starts_with("op://") {
            return Ok(Some(SecretRef::OnePassword {
                op_ref: trimmed.to_string(),
            }));
        }
        if let Some(var_name) = trimmed.strip_prefix("env:") {
            return Ok(Some(SecretRef::EnvVar {
                name: var_name.trim().to_string(),
            }));
        }
        if trimmed.starts_with('{') {
            let parsed: serde_json::Value = serde_json::from_str(trimmed)
                .map_err(|err| format!("invalid secret binding JSON: {err}"))?;
            return parse_secret_ref_value(&parsed);
        }
        return Err("plain-text string is not a valid SecretRef".to_string());
    }
    serde_json::from_value::<SecretRef>(value.clone())
        .map(Some)
        .map_err(|err| format!("invalid SecretRef payload: {err}"))
}

async fn resolve_secret_bindings_value(
    bindings_value: &serde_json::Value,
    env: &mut HashMap<String, String>,
    resolver: &SecretResolver,
) -> Result<(), ConversationServiceError> {
    let parsed_owned;
    let map = match bindings_value {
        serde_json::Value::Null => return Ok(()),
        serde_json::Value::String(raw) if raw.trim().is_empty() => return Ok(()),
        serde_json::Value::String(raw) => {
            parsed_owned = serde_json::from_str::<serde_json::Value>(raw.trim()).map_err(|e| {
                ConversationServiceError::BadRequest(format!(
                    "Invalid secret_bindings_json payload: {e}"
                ))
            })?;
            parsed_owned.as_object().ok_or_else(|| {
                ConversationServiceError::BadRequest(
                    "secret_bindings_json must be a JSON object".to_string(),
                )
            })?
        }
        serde_json::Value::Object(map) => map,
        _ => {
            return Err(ConversationServiceError::BadRequest(
                "secret_bindings_json must be a JSON object".to_string(),
            ));
        }
    };
    for (env_key, binding_val) in map {
        let key = env_key.trim();
        if key.is_empty() {
            continue;
        }
        if let Some(secret_ref) =
            parse_secret_ref_value(binding_val).map_err(ConversationServiceError::BadRequest)?
        {
            let resolved = resolver.resolve(&secret_ref).await.map_err(|err| {
                ConversationServiceError::BadRequest(format!(
                    "Failed to resolve secret binding `{key}`: {err}"
                ))
            })?;
            env.insert(key.to_string(), resolved);
        }
    }
    Ok(())
}

fn auth_mode_explicit_profile_dir(auth_json: &serde_json::Value) -> Option<PathBuf> {
    ["profileDir", "profile_dir", "configDir", "config_dir"]
        .into_iter()
        .find_map(|k| auth_json.get(k).and_then(serde_json::Value::as_str))
        .map(str::trim)
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
}

pub(crate) async fn apply_provider_instance_launch_env(
    pool: &SqlitePool,
    agent_id: &AgentId,
    env: &mut HashMap<String, String>,
    requested_instance_id: Option<&str>,
    resolver: &SecretResolver,
) -> Result<Option<ProviderInstanceRecord>, ConversationServiceError> {
    let effective_requested = requested_instance_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            env.get("DIMO_PROVIDER_INSTANCE_ID")
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        });

    let Some(record) =
        find_selected_provider_instance(pool, agent_id, effective_requested.as_deref()).await?
    else {
        // Implicit `"local"` instance: preserve local secret bindings if any and drop sentinel.
        if let Some(col_bindings) = sqlx::query_scalar::<_, Option<String>>(
            "SELECT secret_bindings_json FROM agent_setting WHERE agent_type = ?",
        )
        .bind(agent_id.as_str())
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .flatten()
        {
            resolve_secret_bindings_value(&serde_json::Value::String(col_bindings), env, resolver)
                .await?;
        }
        if let Some(raw_bindings) = env.remove("DIMO_SECRET_BINDINGS_JSON") {
            resolve_secret_bindings_value(&serde_json::Value::String(raw_bindings), env, resolver)
                .await?;
        }
        env.remove("DIMO_PROVIDER_INSTANCE_ID");
        env.remove("DIMO_ISOLATE_PROVIDER_PROFILE");
        return Ok(None);
    };

    let instances_root = env
        .get("DIMO_PROVIDER_INSTANCES_ROOT")
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| utils::assets::asset_dir().join("provider-instances"));

    // Custom isolated instance must start clean without inheriting local auth/dir env vars.
    scrub_local_auth_and_dir_env(agent_id, env);
    env.remove("DIMO_SECRET_BINDINGS_JSON");
    env.insert(
        "DIMO_PROVIDER_INSTANCE_ID".to_string(),
        record.instance_id.clone(),
    );
    env.insert(
        "DIMO_PROVIDER_INSTANCES_ROOT".to_string(),
        instances_root.to_string_lossy().into_owned(),
    );

    let agent_slug = canonical_provider_agent_id(agent_id.as_str())
        .unwrap_or_else(|_| agent_id.as_str().to_string());
    let base_instance_dir = instances_root
        .join(agent_slug)
        .join(sanitize_instance_segment(&record.instance_id));
    ensure_private_instance_dir(&base_instance_dir).map_err(|err| {
        ConversationServiceError::Internal(format!(
            "Failed to initialize provider instance directory `{}`: {err}",
            base_instance_dir.display()
        ))
    })?;

    load_instance_env_file(&base_instance_dir, env);

    let explicit_env_keys: HashSet<String> = env.keys().cloned().collect();

    let auth_json = serde_json::from_str::<serde_json::Value>(&record.auth_mode)
        .unwrap_or_else(|_| serde_json::Value::String(record.auth_mode.clone()));
    let agent_kind = agent_id
        .as_str()
        .parse::<AgentKind>()
        .ok()
        .or_else(|| record.agent_id.parse::<AgentKind>().ok());

    if let Some(kind) = agent_kind
        && let Ok(parsed_mode) = serde_json::from_value::<ProviderAuthMode>(auth_json.clone())
    {
        let cfg = ProviderInstanceConfig {
            id: None,
            instance_id: record.instance_id.clone(),
            agent_id: kind,
            auth_mode: parsed_mode,
            display_name: record.display_name.clone(),
            is_default: record.is_default,
        };
        let resolved_env = resolver.resolve_launch_env(&cfg).await.map_err(|err| {
            ConversationServiceError::BadRequest(format!(
                "Failed to resolve credentials for provider instance `{}`: {err}",
                record.instance_id
            ))
        })?;
        for (key, value) in resolved_env {
            if !explicit_env_keys.contains(&key) {
                env.insert(key, value);
            }
        }
    } else if let Some(obj) = auth_json.as_object()
        && let Some((api_key_var, base_url_var, oauth_var)) = match agent_kind {
            Some(AgentKind::ClaudeCode) => Some((
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_BASE_URL",
                "CLAUDE_CODE_OAUTH_TOKEN",
            )),
            Some(AgentKind::Codex) => {
                Some(("OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_ACCESS_TOKEN"))
            }
            _ => None,
        }
    {
        if !explicit_env_keys.contains(base_url_var)
            && let Some(url) = [
                "baseUrl",
                "base_url",
                "proxyUrl",
                "proxy_url",
                "anthropicBaseUrl",
                "openaiBaseUrl",
            ]
            .into_iter()
            .find_map(|k| obj.get(k).and_then(serde_json::Value::as_str))
            .map(str::trim)
            .filter(|u| !u.is_empty())
        {
            env.insert(base_url_var.to_string(), url.to_string());
        }
        for (fields, target_var) in [
            (
                &[
                    "keyRef",
                    "key_ref",
                    "apiKeyRef",
                    "api_key_ref",
                    "opReference",
                    "op_reference",
                ][..],
                api_key_var,
            ),
            (
                &["oauthTokenRef", "oauth_token_ref", "tokenRef", "token_ref"][..],
                oauth_var,
            ),
        ] {
            if explicit_env_keys.contains(target_var) {
                continue;
            }
            if let Some(val) = fields.iter().find_map(|k| obj.get(*k))
                && let Some(secret_ref) =
                    parse_secret_ref_value(val).map_err(ConversationServiceError::BadRequest)?
            {
                let secret = resolver.resolve(&secret_ref).await.map_err(|err| {
                    ConversationServiceError::BadRequest(format!(
                        "Failed to resolve credential `{target_var}` for `{}`: {err}",
                        record.instance_id
                    ))
                })?;
                env.insert(target_var.to_string(), secret);
            }
        }
    }

    if let Some(inst_bindings) = sqlx::query_scalar::<_, Option<String>>(
        "SELECT secret_bindings_json FROM provider_instances WHERE agent_id = ? AND instance_id = ?",
    )
    .bind(&record.agent_id)
    .bind(&record.instance_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
    .flatten()
    {
        resolve_secret_bindings_value(&serde_json::Value::String(inst_bindings), env, resolver)
            .await?;
    }
    for bindings_key in ["secretBindings", "secret_bindings", "secret_bindings_json"] {
        if let Some(bindings_val) = auth_json.get(bindings_key) {
            resolve_secret_bindings_value(bindings_val, env, resolver).await?;
        }
    }

    // Every custom instance ALWAYS receives its own isolated native directory, regardless of
    // auth mode or `is_default`, so credentials/configs never bleed into `~/.claude` or `~/.codex`.
    if let Some((config_env_var, default_isolated_dir)) =
        isolated_instance_native_dir(agent_id, &base_instance_dir)
    {
        let isolated_dir = match auth_mode_explicit_profile_dir(&auth_json) {
            Some(explicit) if explicit.is_absolute() => explicit,
            Some(relative) => base_instance_dir.join(relative),
            None => default_isolated_dir,
        };
        ensure_private_instance_dir(&isolated_dir).map_err(|err| {
            ConversationServiceError::Internal(format!(
                "Failed to initialize isolated provider directory `{}`: {err}",
                isolated_dir.display()
            ))
        })?;
        if agent_id.as_str() == "codex" {
            let source_codex_home = env
                .get("HOME")
                .or_else(|| env.get("USERPROFILE"))
                .map(PathBuf::from)
                .map(|home| home.join(".codex"));
            if let Err(err) = prepare_codex_shadow_home(source_codex_home.as_deref(), &isolated_dir)
            {
                tracing::warn!(
                    instance_id = %record.instance_id,
                    %err,
                    "failed to prepare Codex shadow home for provider instance"
                );
            }
        }
        env.entry(config_env_var.to_string())
            .or_insert_with(|| isolated_dir.to_string_lossy().into_owned());
        env.insert("DIMO_ISOLATE_PROVIDER_PROFILE".to_string(), "1".to_string());
    }

    Ok(Some(record))
}

#[cfg(test)]
mod tests {
    use db::models::provider_instance::{
        CreateProviderInstanceInput, ProviderInstanceRecord, ensure_provider_instances_schema,
    };

    use super::*;

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        ensure_provider_instances_schema(&pool).await.unwrap();
        sqlx::query("ALTER TABLE provider_instances ADD COLUMN secret_bindings_json TEXT")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    #[tokio::test]
    async fn custom_instance_scrubs_local_auth_and_assigns_isolated_dir() {
        let pool = test_pool().await;
        let temp = tempfile::tempdir().unwrap();
        ProviderInstanceRecord::create(
            &pool,
            CreateProviderInstanceInput {
                id: None,
                agent_id: "claude-code",
                instance_id: "work-oauth",
                display_name: "Work Claude",
                auth_mode: r#"{"mode":"OfficialOAuth","accountEmail":"work@co"}"#,
                is_default: false,
            },
        )
        .await
        .unwrap();

        let bindings = serde_json::json!({
            "CUSTOM_EXTRA_TOKEN": { "kind": "inline", "value": "bound-token-value" }
        })
        .to_string();
        sqlx::query(
            "UPDATE provider_instances SET secret_bindings_json = ? WHERE instance_id = 'work-oauth'",
        )
        .bind(bindings)
        .execute(&pool)
        .await
        .unwrap();

        let mut env = HashMap::from([
            (
                "DIMO_PROVIDER_INSTANCES_ROOT".to_string(),
                temp.path().to_string_lossy().into_owned(),
            ),
            ("ANTHROPIC_API_KEY".to_string(), "sk-local-leak".to_string()),
            ("CLAUDE_AUTH_MODE".to_string(), "official_api".to_string()),
            (
                "HTTP_PROXY".to_string(),
                "http://127.0.0.1:7890".to_string(),
            ),
        ]);
        let agent_id = AgentId::parse("claude_code").unwrap();
        let selected = apply_provider_instance_launch_env(
            &pool,
            &agent_id,
            &mut env,
            Some("work-oauth"),
            &SecretResolver::new(),
        )
        .await
        .unwrap()
        .expect("custom instance selected");

        assert_eq!(selected.instance_id, "work-oauth");
        assert!(!env.contains_key("ANTHROPIC_API_KEY"));
        assert!(!env.contains_key("CLAUDE_AUTH_MODE"));
        assert_eq!(
            env.get("HTTP_PROXY").map(String::as_str),
            Some("http://127.0.0.1:7890")
        );
        assert_eq!(
            env.get("CUSTOM_EXTRA_TOKEN").map(String::as_str),
            Some("bound-token-value")
        );
        let config_dir = env.get("CLAUDE_CONFIG_DIR").expect("CLAUDE_CONFIG_DIR");
        assert!(Path::new(config_dir).is_dir() && config_dir.contains("work-oauth"));
    }

    #[tokio::test]
    async fn local_sentinel_bypasses_default_custom_instance() {
        let pool = test_pool().await;
        ProviderInstanceRecord::create(
            &pool,
            CreateProviderInstanceInput {
                id: None,
                agent_id: "codex",
                instance_id: "work-codex",
                display_name: "Work Codex",
                auth_mode: r#"{"mode":"OfficialOAuth"}"#,
                is_default: true,
            },
        )
        .await
        .unwrap();

        let agent_id = AgentId::parse("codex").unwrap();
        assert_eq!(
            resolve_effective_provider_instance_id(&pool, &agent_id, None)
                .await
                .unwrap()
                .as_deref(),
            Some("work-codex")
        );
        assert_eq!(
            resolve_effective_provider_instance_id(&pool, &agent_id, Some("local"))
                .await
                .unwrap(),
            None
        );

        let err = resolve_effective_provider_instance_id(&pool, &agent_id, Some("nonexistent"))
            .await
            .expect_err("missing custom instance must fail explicitly");
        assert!(matches!(err, ConversationServiceError::BadRequest(_)));
    }
}
