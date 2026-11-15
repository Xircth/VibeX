use std::{
    collections::{BTreeMap, HashMap},
    path::{Component, Path, PathBuf},
};

use agents::{
    AgentAuthenticationStatus, AgentContentBlock, AgentId, AgentKind, AgentLifecycleState,
    AgentManagementSnapshot, BuiltInProfileCatalog, ProfileTopology, SessionGate, SessionGateError,
    SessionGateInput, SessionLaunchLock, bind_pi_acp_pi_command, discover_path_acp_launch_lock,
    engine::{EngineRegistry, EngineRuntimePreference},
    launch_program_is_legacy_acp_shim, lifecycle_ready_for_path_acp,
    secret_resolution::{
        ProviderAuthMode, ProviderInstanceConfig, SecretRef, SecretResolver,
        ensure_private_instance_dir,
    },
    session_launch_rejection_message,
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use db::models::{provider_instance::ProviderInstanceRecord, repo::Repo, workspace::Workspace};
use serde::Deserialize;
use sqlx::{Row, SqlitePool};

use crate::{AgentRuntimeLaunchSettings, ConversationHost, ConversationServiceError};

/// Product-owned host behavior shared by the desktop and headless composition
/// roots. Launch prefers a PATH-resolved ACP command, then the Installation lock.
#[derive(Default)]
pub struct DefaultConversationHost {
    product_mcp_server_names: Option<std::sync::Arc<dyn Fn() -> Vec<String> + Send + Sync>>,
}

impl std::fmt::Debug for DefaultConversationHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DefaultConversationHost").finish()
    }
}

impl DefaultConversationHost {
    pub fn with_product_mcp_server_names(
        names: std::sync::Arc<dyn Fn() -> Vec<String> + Send + Sync>,
    ) -> Self {
        Self {
            product_mcp_server_names: Some(names),
        }
    }
}

#[async_trait::async_trait]
impl ConversationHost for DefaultConversationHost {
    fn resolve_working_dir(
        &self,
        workspace: &Workspace,
        container_ref: &str,
        repos: &[Repo],
    ) -> Option<String> {
        Some(resolve_absolute_workspace_agent_working_dir(
            workspace,
            container_ref,
            repos,
        ))
    }

    fn resolve_additional_directories(
        &self,
        workspace: &Workspace,
        container_ref: &str,
        repos: &[Repo],
        working_dir: &str,
    ) -> Vec<PathBuf> {
        resolve_workspace_additional_directories(workspace, container_ref, repos, working_dir)
    }

    async fn build_prompt_blocks(
        &self,
        working_dir: &str,
        text: String,
        images: &[String],
        file_refs: &[agents::ConversationFileRef],
    ) -> Result<Vec<AgentContentBlock>, ConversationServiceError> {
        workspace_prompt_blocks(working_dir, text, images, file_refs).await
    }

    async fn launch_settings(
        &self,
        pool: &SqlitePool,
        agent_id: &AgentId,
    ) -> Result<AgentRuntimeLaunchSettings, ConversationServiceError> {
        resolve_agent_runtime_launch_settings(pool, agent_id).await
    }

    async fn launch_settings_with_provider_instance(
        &self,
        pool: &SqlitePool,
        agent_id: &AgentId,
        provider_instance_id: Option<&str>,
    ) -> Result<AgentRuntimeLaunchSettings, ConversationServiceError> {
        resolve_agent_runtime_launch_settings_for_provider_instance(
            pool,
            agent_id,
            provider_instance_id,
        )
        .await
    }

    fn product_mcp_server_names(&self) -> Vec<String> {
        self.product_mcp_server_names
            .as_ref()
            .map(|resolve| resolve())
            .unwrap_or_default()
    }
}

#[derive(Deserialize, Default)]
struct LockedLaunchPayload {
    absolute_acp_program: Option<PathBuf>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    runtime_version: Option<String>,
    acp_version: Option<String>,
}

pub async fn session_launch_rejection_from_pool(
    pool: &SqlitePool,
    agent_id: &AgentId,
    error: SessionGateError,
) -> String {
    let output = db::models::agent_management::DiagnosticRepository::new(pool.clone())
        .latest_error_output(agent_id)
        .await
        .ok()
        .flatten();
    session_launch_rejection_message(&error, output.as_deref())
}

fn is_native_engine_launch(agent_id: &AgentId, setting_env: &HashMap<String, String>) -> bool {
    let env_mode_owned = setting_env
        .get("VIBEX_ENGINE_MODE")
        .cloned()
        .or_else(|| std::env::var("VIBEX_ENGINE_MODE").ok());
    if EngineRegistry::bundled()
        .resolve_driver_for_agent(
            agent_id.as_str(),
            EngineRuntimePreference::NativeFirst,
            env_mode_owned.as_deref(),
        )
        .is_some()
    {
        return true;
    }
    env_mode_owned
        .as_deref()
        .map(str::trim)
        .is_none_or(|mode| !mode.eq_ignore_ascii_case("acp"))
        && BuiltInProfileCatalog::bundled()
            .profile(agent_id)
            .is_some_and(|profile| matches!(profile.topology, ProfileTopology::NativeEngine(_)))
}

async fn session_launch_lock_from_payload(
    pool: &SqlitePool,
    agent_id: &AgentId,
    lock_id: &str,
    payload: LockedLaunchPayload,
    allow_runtime_program: bool,
) -> Result<SessionLaunchLock, ConversationServiceError> {
    let acp_component = sqlx::query(
        r#"SELECT absolute_path, version
           FROM agent_install_component
           WHERE lock_id = ?
             AND component_kind IN ('acp', 'acp_adapter', 'combined_runtime')
           ORDER BY CASE component_kind
             WHEN 'acp' THEN 0 WHEN 'acp_adapter' THEN 1 ELSE 2 END
           LIMIT 1"#,
    )
    .bind(lock_id)
    .fetch_optional(pool)
    .await?;
    let runtime_component = sqlx::query(
        r#"SELECT absolute_path, version
           FROM agent_install_component
           WHERE lock_id = ?
             AND component_kind IN ('runtime', 'agent_runtime', 'combined_runtime')
           ORDER BY CASE component_kind
             WHEN 'runtime' THEN 0 WHEN 'agent_runtime' THEN 1 ELSE 2 END
           LIMIT 1"#,
    )
    .bind(lock_id)
    .fetch_optional(pool)
    .await?;
    let runtime_version = match runtime_component.as_ref() {
        Some(component) => component.try_get::<String, _>("version")?,
        None => payload.runtime_version.unwrap_or_default(),
    };
    let runtime_program = match runtime_component.as_ref() {
        Some(component) => Some(PathBuf::from(
            component.try_get::<String, _>("absolute_path")?,
        )),
        None => None,
    };
    let acp_program = match acp_component.as_ref() {
        Some(component) => Some(PathBuf::from(
            component.try_get::<String, _>("absolute_path")?,
        )),
        None => payload.absolute_acp_program,
    };
    let (absolute_acp_program, used_runtime_fallback) = if allow_runtime_program {
        match (runtime_program, acp_program) {
            (Some(rt), Some(acp))
                if launch_program_is_legacy_acp_shim(agent_id, &acp)
                    || !agents::launch_program_available(&acp) =>
            {
                (rt, true)
            }
            (Some(rt), None) => (rt, true),
            (_, Some(acp)) => (acp, false),
            (None, None) => {
                return Err(ConversationServiceError::Internal(
                    "Installation lock has no runtime or ACP component path".to_string(),
                ));
            }
        }
    } else {
        let program = acp_program.ok_or_else(|| {
            ConversationServiceError::Internal(
                "Installation lock has no ACP component path".to_string(),
            )
        })?;
        (program, false)
    };
    if !absolute_acp_program.is_absolute() {
        return Err(ConversationServiceError::Internal(
            "Installation lock ACP component path is not absolute".to_string(),
        ));
    }
    let acp_version = if used_runtime_fallback {
        payload
            .acp_version
            .unwrap_or_else(|| runtime_version.clone())
    } else {
        match acp_component.as_ref() {
            Some(component) => component.try_get::<String, _>("version")?,
            None if allow_runtime_program => payload
                .acp_version
                .unwrap_or_else(|| runtime_version.clone()),
            None => payload.acp_version.ok_or_else(|| {
                ConversationServiceError::Internal(
                    "Installation lock has no ACP version".to_string(),
                )
            })?,
        }
    };
    Ok(SessionLaunchLock {
        agent_id: agent_id.clone(),
        absolute_acp_program,
        args: payload.args,
        env: payload.env,
        runtime_version,
        acp_version,
    })
}

pub async fn resolve_agent_runtime_launch_settings(
    pool: &SqlitePool,
    agent_id: &AgentId,
) -> Result<AgentRuntimeLaunchSettings, ConversationServiceError> {
    resolve_agent_runtime_launch_settings_with_resolver(
        pool,
        agent_id,
        None,
        &SecretResolver::new(),
    )
    .await
}

pub async fn resolve_agent_runtime_launch_settings_for_provider_instance(
    pool: &SqlitePool,
    agent_id: &AgentId,
    provider_instance_id: Option<&str>,
) -> Result<AgentRuntimeLaunchSettings, ConversationServiceError> {
    resolve_agent_runtime_launch_settings_with_resolver(
        pool,
        agent_id,
        provider_instance_id,
        &SecretResolver::new(),
    )
    .await
}

pub(crate) async fn resolve_agent_runtime_launch_settings_with_resolver(
    pool: &SqlitePool,
    agent_id: &AgentId,
    provider_instance_id: Option<&str>,
    secret_resolver: &SecretResolver,
) -> Result<AgentRuntimeLaunchSettings, ConversationServiceError> {
    let row = sqlx::query(
        r#"SELECT membership.enabled,
                  COALESCE(probe.lifecycle, installation.lifecycle, 'uninstalled') AS lifecycle,
                  COALESCE(probe.authentication, 'not_logged_in') AS authentication,
                  lock.resolved_json,
                  lock.id,
                  setting.env_json
           FROM agent_membership membership
           LEFT JOIN agent_installation installation
             ON installation.agent_id = membership.agent_id
           LEFT JOIN agent_install_lock lock
             ON lock.id = installation.current_lock_id
           LEFT JOIN agent_probe probe
             ON probe.agent_id = membership.agent_id
           LEFT JOIN agent_setting setting
             ON setting.agent_type = membership.agent_id
           WHERE membership.agent_id = ?"#,
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| {
        ConversationServiceError::NotFound(format!("Agent `{agent_id}` has not been added"))
    })?;

    let mut env = row
        .try_get::<Option<String>, _>("env_json")?
        .filter(|value| !value.trim().is_empty())
        .map(|value| serde_json::from_str::<HashMap<String, String>>(&value))
        .transpose()?
        .unwrap_or_default();
    if let Some(instance_id) = provider_instance_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        env.insert(
            "VIBEX_PROVIDER_INSTANCE_ID".to_string(),
            instance_id.to_string(),
        );
    }
    let explicit_env_keys = env
        .keys()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    let native_engine = is_native_engine_launch(agent_id, &env);

    let mut lifecycle = parse_management_lifecycle(row.try_get::<String, _>("lifecycle")?.as_str());
    // Persisted NeedsAuth cannot block a real session/new. ACP AuthRequired is
    // the authority (ADR-0021).
    if lifecycle == AgentLifecycleState::NeedsAuth {
        lifecycle = AgentLifecycleState::Ready;
    }
    let resolved_json = row.try_get::<Option<String>, _>("resolved_json")?;
    let lock_id = row.try_get::<Option<String>, _>("id")?;
    let mut current_lock = match (resolved_json.as_deref(), lock_id.as_deref()) {
        (Some(resolved_json), Some(lock_id)) => {
            let payload: LockedLaunchPayload = serde_json::from_str(resolved_json)?;
            match session_launch_lock_from_payload(pool, agent_id, lock_id, payload, native_engine)
                .await
            {
                Ok(lock) => Some(lock),
                Err(_) if native_engine => None,
                Err(error) => return Err(error),
            }
        }
        _ => None,
    };
    if native_engine
        && let Some(ref lock) = current_lock
        && (launch_program_is_legacy_acp_shim(agent_id, &lock.absolute_acp_program)
            || !agents::launch_program_available(&agents::prefer_path_launch_program(
                &lock.absolute_acp_program,
            )))
    {
        current_lock = None;
    }
    if current_lock.is_none() {
        current_lock = discover_path_acp_launch_lock(agent_id).await;
    }
    if current_lock.is_some() {
        lifecycle = lifecycle_ready_for_path_acp(lifecycle);
    }
    let snapshot = AgentManagementSnapshot {
        agent_id: agent_id.clone(),
        enabled: row.try_get("enabled")?,
        lifecycle,
        authentication: parse_management_authentication(
            row.try_get::<String, _>("authentication")?.as_str(),
        ),
        required_components: Vec::new(),
    };
    let authorization = match SessionGate.authorize(SessionGateInput {
        snapshot,
        current_lock,
        requested_defaults: BTreeMap::new(),
        advertised_option_ids: Vec::new(),
        existing_binding: None,
        explicit_rebind: false,
    }) {
        Ok(authorization) => authorization,
        Err(error) => {
            return Err(ConversationServiceError::BadRequest(
                session_launch_rejection_from_pool(pool, agent_id, error).await,
            ));
        }
    };

    let mut args = authorization.args;
    let requested_pi_command = env
        .get("PI_ACP_PI_COMMAND")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    agents::apply_built_in_launch_policy(agent_id, &mut env, &mut args);
    let _ = utils::shell::refresh_process_path().await;
    let mut lock_env = authorization.env;
    agents::sanitize_runtime_executable_lock_env(agent_id, &mut lock_env);
    if let Ok(process_path) = std::env::var("PATH") {
        let merged = utils::shell::merge_paths(
            process_path,
            lock_env.get("PATH").cloned().unwrap_or_default(),
        );
        lock_env.insert("PATH".to_string(), merged.to_string_lossy().into_owned());
        env.insert(
            "PATH".to_string(),
            lock_env
                .get("PATH")
                .cloned()
                .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default()),
        );
    }
    if agent_id.as_str() == "pi" {
        bind_pi_acp_pi_command(&mut env, requested_pi_command.as_deref());
    }
    apply_provider_instance_launch_env(
        pool,
        agent_id,
        &mut env,
        &explicit_env_keys,
        secret_resolver,
    )
    .await?;
    // Prefer PATH over a stale lock path (ADR-0060 / CodeG connect).
    let absolute_acp_program =
        agents::prefer_path_launch_program(&authorization.absolute_acp_program);
    if !agents::launch_program_available(&absolute_acp_program) {
        return Err(ConversationServiceError::BadRequest(
            agents::missing_launch_program_error(&absolute_acp_program),
        ));
    }
    Ok(AgentRuntimeLaunchSettings {
        auto_approve_mode: agents::auto_approve_mode_for_launch(agent_id, &env),
        env,
        launch_lock: SessionLaunchLock {
            agent_id: authorization.agent_id,
            absolute_acp_program,
            args,
            env: lock_env,
            runtime_version: authorization.runtime_version,
            acp_version: authorization.acp_version,
        },
    })
}

fn candidate_provider_agent_ids(agent_id: &AgentId) -> Vec<String> {
    let raw = agent_id.as_str();
    let mut ids = vec![raw.to_string()];
    let hyphenated = raw.replace('_', "-");
    if hyphenated != raw {
        ids.push(hyphenated);
    }
    if matches!(raw, "claude_code" | "claude-code") {
        ids.push("claude".to_string());
    }
    ids
}

fn map_provider_store_err(
    err: db::models::provider_instance::ProviderInstanceStoreError,
) -> ConversationServiceError {
    match err {
        db::models::provider_instance::ProviderInstanceStoreError::Database(db_err) => db_err.into(),
        other => ConversationServiceError::BadRequest(other.to_string()),
    }
}

async fn find_selected_provider_instance(
    pool: &SqlitePool,
    agent_id: &AgentId,
    requested_instance_id: Option<&str>,
) -> Result<Option<ProviderInstanceRecord>, ConversationServiceError> {
    let exists: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'provider_instances' LIMIT 1",
    )
    .fetch_optional(pool)
    .await?;
    if exists.is_none() {
        return Ok(None);
    }
    let candidates = candidate_provider_agent_ids(agent_id);
    if let Some(id) = requested_instance_id.map(str::trim).filter(|v| !v.is_empty()) {
        for candidate in &candidates {
            if let Some(rec) = ProviderInstanceRecord::find_by_instance(pool, candidate, id)
                .await
                .map_err(map_provider_store_err)?
            {
                return Ok(Some(rec));
            }
        }
        return Ok(None);
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

fn sanitize_instance_segment(raw: &str) -> String {
    let sanitized: String = raw
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') { ch } else { '_' })
        .collect();
    let trimmed = sanitized.trim_matches(['.', '_']);
    if trimmed.is_empty() { "instance".to_string() } else { trimmed.to_string() }
}

fn auth_mode_is_oauth(raw_auth_mode: &str, auth_json: &serde_json::Value) -> bool {
    let mode = auth_json.get("mode").and_then(serde_json::Value::as_str).unwrap_or_default();
    let kind = auth_json.get("type").and_then(serde_json::Value::as_str).unwrap_or_default();
    raw_auth_mode.trim().eq_ignore_ascii_case("oauth")
        || matches!(mode.to_ascii_lowercase().as_str(), "officialoauth" | "official_oauth" | "oauth")
        || matches!(kind.to_ascii_lowercase().as_str(), "subscription" | "oauth")
}

fn auth_mode_explicit_profile_dir(auth_json: &serde_json::Value) -> Option<PathBuf> {
    ["profileDir", "profile_dir", "configDir", "config_dir"]
        .into_iter()
        .find_map(|k| auth_json.get(k).and_then(serde_json::Value::as_str))
        .map(str::trim)
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
}

fn auth_mode_requests_profile_isolation(auth_json: &serde_json::Value) -> bool {
    auth_mode_explicit_profile_dir(auth_json).is_some()
        || [
            "isolateProfile",
            "isolate_profile",
            "isolatedProfile",
            "isolated_profile",
            "isolatedProfileDir",
            "isolated_profile_dir",
        ]
        .iter()
        .any(|k| auth_json.get(*k).and_then(serde_json::Value::as_bool) == Some(true))
}

async fn apply_provider_instance_launch_env(
    pool: &SqlitePool,
    agent_id: &AgentId,
    env: &mut HashMap<String, String>,
    explicit_env_keys: &std::collections::HashSet<String>,
    resolver: &SecretResolver,
) -> Result<(), ConversationServiceError> {
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
        resolve_secret_bindings_value(&serde_json::Value::String(col_bindings), env, resolver).await?;
    }
    if let Some(raw_bindings) = env.remove("VIBEX_SECRET_BINDINGS_JSON") {
        resolve_secret_bindings_value(&serde_json::Value::String(raw_bindings), env, resolver).await?;
    }

    let requested_instance_id = env.get("VIBEX_PROVIDER_INSTANCE_ID").cloned();
    let Some(record) =
        find_selected_provider_instance(pool, agent_id, requested_instance_id.as_deref()).await?
    else {
        return Ok(());
    };

    env.insert("VIBEX_PROVIDER_INSTANCE_ID".to_string(), record.instance_id.clone());
    let instances_root = env
        .get("VIBEX_PROVIDER_INSTANCES_ROOT")
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| utils::assets::asset_dir().join("provider-instances"));
    env.entry("VIBEX_PROVIDER_INSTANCES_ROOT".to_string())
        .or_insert_with(|| instances_root.to_string_lossy().into_owned());

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
            Some(AgentKind::ClaudeCode) => Some(("ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN")),
            Some(AgentKind::Codex) => Some(("OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_ACCESS_TOKEN")),
            _ => None,
        }
    {
        if !explicit_env_keys.contains(base_url_var)
            && let Some(url) = ["baseUrl", "base_url", "proxyUrl", "proxy_url", "anthropicBaseUrl", "openaiBaseUrl"]
                .into_iter()
                .find_map(|k| obj.get(k).and_then(serde_json::Value::as_str))
                .map(str::trim)
                .filter(|u| !u.is_empty())
        {
            env.insert(base_url_var.to_string(), url.to_string());
        }
        for (fields, target_var) in [
            (&["keyRef", "key_ref", "apiKeyRef", "api_key_ref", "opReference", "op_reference"][..], api_key_var),
            (&["oauthTokenRef", "oauth_token_ref", "tokenRef", "token_ref"][..], oauth_var),
        ] {
            if explicit_env_keys.contains(target_var) {
                continue;
            }
            if let Some(val) = fields.iter().find_map(|k| obj.get(*k))
                && let Some(secret_ref) = parse_secret_ref_value(val).map_err(ConversationServiceError::BadRequest)?
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
        resolve_secret_bindings_value(&serde_json::Value::String(inst_bindings), env, resolver).await?;
    }
    for bindings_key in ["secretBindings", "secret_bindings", "secret_bindings_json"] {
        if let Some(bindings_val) = auth_json.get(bindings_key) {
            resolve_secret_bindings_value(bindings_val, env, resolver).await?;
        }
    }

    let isolate_oauth_dir = auth_mode_is_oauth(&record.auth_mode, &auth_json)
        && (!record.is_default || auth_mode_requests_profile_isolation(&auth_json));
    if isolate_oauth_dir
        && let Some((config_env_var, agent_slug, leaf_dir)) = match agent_kind {
            Some(AgentKind::ClaudeCode) => Some(("CLAUDE_CONFIG_DIR", "claude_code", "claude-config")),
            Some(AgentKind::Codex) => Some(("CODEX_HOME", "codex", "codex-home")),
            _ => None,
        }
        && !explicit_env_keys.contains(config_env_var)
    {
        let base = instances_root.join(agent_slug).join(sanitize_instance_segment(&record.instance_id));
        let isolated_dir = match auth_mode_explicit_profile_dir(&auth_json) {
            Some(explicit) if explicit.is_absolute() => explicit,
            Some(relative) => base.join(relative),
            None => base.join(leaf_dir),
        };
        ensure_private_instance_dir(&isolated_dir).map_err(|err| {
            ConversationServiceError::Internal(format!(
                "Failed to initialize isolated provider directory `{}`: {err}",
                isolated_dir.display()
            ))
        })?;
        env.insert(config_env_var.to_string(), isolated_dir.to_string_lossy().into_owned());
        env.insert("VIBEX_ISOLATE_PROVIDER_PROFILE".to_string(), "1".to_string());
    }
    Ok(())
}

pub async fn workspace_prompt_blocks(
    working_dir: &str,
    text: String,
    images: &[String],
    file_refs: &[agents::ConversationFileRef],
) -> Result<Vec<AgentContentBlock>, ConversationServiceError> {
    let mut blocks = if text.trim().is_empty() {
        Vec::new()
    } else {
        vec![AgentContentBlock::Text { text }]
    };
    for file_ref in file_refs {
        blocks.push(read_workspace_file_link(working_dir, file_ref).await?);
    }
    for image in images {
        blocks.push(read_workspace_image_block(working_dir, image).await?);
    }
    if blocks.is_empty() {
        return Err(ConversationServiceError::BadRequest(
            "Prompt must include text or an image".to_string(),
        ));
    }
    Ok(blocks)
}

async fn read_workspace_file_link(
    working_dir: &str,
    file_ref: &agents::ConversationFileRef,
) -> Result<AgentContentBlock, ConversationServiceError> {
    let relative = relative_agent_asset_path(&file_ref.path)?;
    let canonical_root = tokio::fs::canonicalize(working_dir)
        .await
        .map_err(|error| {
            ConversationServiceError::NotFound(format!(
                "Workspace directory is unavailable: {error}"
            ))
        })?;
    let requested_path = canonical_root.join(&relative);
    let file_path = tokio::fs::canonicalize(&requested_path)
        .await
        .map_err(|_| {
            ConversationServiceError::NotFound(format!("File not found: {}", file_ref.path))
        })?;
    if !file_path.starts_with(&canonical_root) {
        return Err(ConversationServiceError::BadRequest(format!(
            "File path must stay inside the workspace: {}",
            file_ref.path
        )));
    }
    // File-tree drops can be files or directories. Rejecting directories
    // left the durable input queued after Turn end because dispatch failed.
    if !file_path.is_file() && !file_path.is_dir() {
        return Err(ConversationServiceError::NotFound(format!(
            "Path not found: {}",
            file_ref.path
        )));
    }
    let uri = file_uri_for_path(&file_path);
    let name = relative
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(file_ref.path.as_str())
        .to_string();
    let title = match (file_ref.start_line, file_ref.end_line) {
        (Some(start), Some(end)) => Some(format!("{}:{}-{}", name, start, end)),
        (Some(start), None) => Some(format!("{}:{}", name, start)),
        _ => Some(name.clone()),
    };
    Ok(AgentContentBlock::Resource { uri, title })
}

async fn read_workspace_image_block(
    working_dir: &str,
    relative_path: &str,
) -> Result<AgentContentBlock, ConversationServiceError> {
    let relative = relative_agent_asset_path(relative_path)?;
    let canonical_root = tokio::fs::canonicalize(working_dir)
        .await
        .map_err(|error| {
            ConversationServiceError::NotFound(format!(
                "Workspace directory is unavailable: {error}"
            ))
        })?;
    let requested_path = canonical_root.join(&relative);
    let file_path = tokio::fs::canonicalize(&requested_path)
        .await
        .map_err(|_| {
            ConversationServiceError::NotFound(format!("Image not found: {relative_path}"))
        })?;
    if !file_path.starts_with(&canonical_root) {
        return Err(ConversationServiceError::BadRequest(format!(
            "Image path must stay inside the workspace: {relative_path}"
        )));
    }
    if !file_path.is_file() {
        return Err(ConversationServiceError::NotFound(format!(
            "Image not found: {relative_path}"
        )));
    }
    if !is_image_agent_asset(&file_path) {
        let name = relative
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(relative_path)
            .to_string();
        return Ok(AgentContentBlock::Resource {
            uri: file_uri_for_path(&file_path),
            title: Some(name),
        });
    }
    let bytes = tokio::fs::read(&file_path).await.map_err(|error| {
        ConversationServiceError::Internal(format!("Failed to read image {relative_path}: {error}"))
    })?;
    Ok(AgentContentBlock::Image {
        data: BASE64.encode(bytes),
        mime_type: mime_type_for_agent_asset(&file_path).to_string(),
        uri: Some(relative.to_string_lossy().replace('\\', "/")),
    })
}

fn file_uri_for_path(file_path: &Path) -> String {
    url::Url::from_file_path(file_path)
        .map(|url| url.to_string())
        .unwrap_or_else(|_| format!("file://{}", file_path.display()))
}

fn is_image_agent_asset(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "avif" | "heic" | "heif")
    )
}

fn relative_agent_asset_path(path: &str) -> Result<PathBuf, ConversationServiceError> {
    let candidate = Path::new(path);
    if candidate.is_absolute() {
        return Err(ConversationServiceError::BadRequest(format!(
            "Image path must be workspace-relative: {path}"
        )));
    }
    let mut relative = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Normal(segment) => relative.push(segment),
            Component::CurDir => {}
            _ => {
                return Err(ConversationServiceError::BadRequest(format!(
                    "Image path must stay inside the workspace: {path}"
                )));
            }
        }
    }
    if relative.as_os_str().is_empty() {
        return Err(ConversationServiceError::BadRequest(
            "Image path cannot be empty".to_string(),
        ));
    }
    Ok(relative)
}

pub(crate) fn mime_type_for_agent_asset(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("svg") => "image/svg+xml",
        Some("avif") => "image/avif",
        Some("heic") => "image/heic",
        Some("heif") => "image/heif",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mov") => "video/quicktime",
        Some("m4v") => "video/x-m4v",
        Some("avi") => "video/x-msvideo",
        Some("mkv") => "video/x-matroska",
        Some("mpeg") | Some("mpg") => "video/mpeg",
        Some("pdf") => "application/pdf",
        Some("txt") => "text/plain",
        Some("md") | Some("markdown") => "text/markdown",
        Some("json") => "application/json",
        Some("csv") => "text/csv",
        Some("html") | Some("htm") => "text/html",
        Some("doc") => "application/msword",
        Some("docx") => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        Some("xls") => "application/vnd.ms-excel",
        Some("xlsx") => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        Some("ppt") => "application/vnd.ms-powerpoint",
        Some("pptx") => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        Some("zip") => "application/zip",
        _ => "application/octet-stream",
    }
}

pub fn resolve_workspace_agent_working_dir(
    workspace: &Workspace,
    container_ref: &str,
    repos: &[Repo],
) -> Option<String> {
    normalized_agent_working_dir(workspace, container_ref, repos)
        .or_else(|| infer_single_repo_working_dir(workspace, container_ref, repos))
}

fn workspace_base_path(workspace: &Workspace, container_ref: &str, repos: &[Repo]) -> PathBuf {
    match repos {
        [repo] if !workspace.use_worktree => repo.path.clone(),
        _ => PathBuf::from(container_ref),
    }
}

fn workspace_repo_root(workspace: &Workspace, container_ref: &str, repos: &[Repo]) -> PathBuf {
    let [repo] = repos else {
        return PathBuf::from(container_ref);
    };
    if !workspace.use_worktree {
        return repo.path.clone();
    }
    let mut workspace = workspace.clone();
    workspace.container_ref = Some(container_ref.to_string());
    workspace
        .repo_path(repo)
        .unwrap_or_else(|| PathBuf::from(container_ref))
}

/// Absolute directory passed to `Command::current_dir` and ACP `session/new`.
/// Relative workspace folders such as a managed worktree's repo name must be
/// joined to the container; spawning with a bare relative path is ENOENT.
pub fn resolve_absolute_workspace_agent_working_dir(
    workspace: &Workspace,
    container_ref: &str,
    repos: &[Repo],
) -> String {
    let base = workspace_base_path(workspace, container_ref, repos);
    if let Some(working_dir) = resolve_workspace_agent_working_dir(workspace, container_ref, repos)
    {
        let path = PathBuf::from(&working_dir);
        if path.is_absolute() {
            return working_dir;
        }
        return base.join(path).to_string_lossy().into_owned();
    }
    workspace_repo_root(workspace, container_ref, repos)
        .to_string_lossy()
        .into_owned()
}

pub fn resolve_workspace_additional_directories(
    workspace: &Workspace,
    container_ref: &str,
    repos: &[Repo],
    working_dir: &str,
) -> Vec<PathBuf> {
    let mut workspace = workspace.clone();
    workspace.container_ref = Some(container_ref.to_string());
    let base = match repos {
        [repo] if !workspace.use_worktree => repo.path.clone(),
        _ => PathBuf::from(container_ref),
    };
    let cwd = PathBuf::from(working_dir);
    let cwd = if cwd.is_absolute() {
        cwd
    } else {
        base.join(cwd)
    };
    let mut roots = repos
        .iter()
        .filter_map(|repo| {
            if workspace.use_worktree {
                workspace.repo_path(repo)
            } else {
                Some(repo.path.clone())
            }
        })
        .filter(|root| root != &cwd)
        .collect::<Vec<_>>();
    if workspace.use_worktree {
        for repo in repos {
            if repo.path != cwd && !roots.iter().any(|root| root == &repo.path) {
                roots.push(repo.path.clone());
            }
        }
    }
    roots.sort();
    roots.dedup();
    roots
}

fn normalized_agent_working_dir(
    workspace: &Workspace,
    container_ref: &str,
    repos: &[Repo],
) -> Option<String> {
    let raw = workspace
        .agent_working_dir
        .as_deref()
        .map(str::trim)
        .filter(|directory| !directory.is_empty())?;
    let [repo] = repos else {
        return Some(raw.to_string());
    };
    let container_is_repo_root = single_repo_base_path_is_repo_root(workspace, container_ref, repo);
    let mut segments = raw
        .split(['/', '\\'])
        .filter(|segment| !segment.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    if container_is_repo_root
        && segments
            .first()
            .is_some_and(|segment| segment == &repo.name)
    {
        segments.remove(0);
        return rebuild_relative_path(&segments);
    }
    if workspace.use_worktree
        && !container_is_repo_root
        && segments.first().is_none_or(|segment| segment != &repo.name)
    {
        segments.insert(0, repo.name.clone());
        return rebuild_relative_path(&segments);
    }
    Some(raw.to_string())
}

fn infer_single_repo_working_dir(
    workspace: &Workspace,
    container_ref: &str,
    repos: &[Repo],
) -> Option<String> {
    let [repo] = repos else {
        return None;
    };
    let default_working_dir = repo
        .default_working_dir
        .as_deref()
        .map(str::trim)
        .filter(|directory| !directory.is_empty());
    if !workspace.use_worktree {
        return default_working_dir.map(ToOwned::to_owned);
    }
    let container_is_repo_root = single_repo_base_path_is_repo_root(workspace, container_ref, repo);
    match default_working_dir {
        Some(subdirectory) if container_is_repo_root => Some(subdirectory.to_string()),
        Some(subdirectory) => Some(
            PathBuf::from(&repo.name)
                .join(subdirectory)
                .to_string_lossy()
                .to_string(),
        ),
        None if container_is_repo_root => None,
        None => Some(repo.name.clone()),
    }
}

fn single_repo_base_path_is_repo_root(
    workspace: &Workspace,
    container_ref: &str,
    repo: &Repo,
) -> bool {
    if !workspace.use_worktree {
        return true;
    }
    let mut next = workspace.clone();
    next.container_ref = Some(container_ref.to_string());
    next.repo_path(repo)
        .is_some_and(|path| path == Path::new(container_ref))
}

fn rebuild_relative_path(segments: &[String]) -> Option<String> {
    if segments.is_empty() {
        return None;
    }
    let mut path = PathBuf::new();
    for segment in segments {
        path.push(segment);
    }
    Some(path.to_string_lossy().to_string())
}

fn parse_management_lifecycle(value: &str) -> AgentLifecycleState {
    match value {
        "retired" => AgentLifecycleState::Retired,
        "platform_unsupported" => AgentLifecycleState::PlatformUnsupported,
        "queued" => AgentLifecycleState::Queued,
        "installing" => AgentLifecycleState::Installing,
        "updating" => AgentLifecycleState::Updating,
        "repairing" => AgentLifecycleState::Repairing,
        "needs_auth" => AgentLifecycleState::NeedsAuth,
        "needs_config" => AgentLifecycleState::NeedsConfig,
        "ready" => AgentLifecycleState::Ready,
        "uninstalled" => AgentLifecycleState::Uninstalled,
        _ => AgentLifecycleState::NeedsRepair,
    }
}

pub(crate) fn parse_management_authentication(value: &str) -> AgentAuthenticationStatus {
    match value {
        "account" => AgentAuthenticationStatus::Account,
        "api_key" => AgentAuthenticationStatus::ApiKey,
        "multiple_unknown" => AgentAuthenticationStatus::MultipleUnknown,
        "not_required" => AgentAuthenticationStatus::NotRequired,
        _ => AgentAuthenticationStatus::NotLoggedIn,
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::symlink;

    use super::*;

    #[tokio::test]
    async fn prompt_blocks_reject_a_symlink_that_escapes_the_workspace() {
        let workspace = tempfile::tempdir().expect("workspace");
        let outside = tempfile::tempdir().expect("outside");
        let secret = outside.path().join("secret.png");
        std::fs::write(&secret, b"not for the workspace").expect("secret");
        symlink(&secret, workspace.path().join("linked.png")).expect("symlink");

        let error = DefaultConversationHost::default()
            .build_prompt_blocks(
                workspace.path().to_str().expect("utf8 path"),
                String::new(),
                &["linked.png".to_string()],
                &[],
            )
            .await
            .expect_err("symlink escape must fail");

        assert!(matches!(error, ConversationServiceError::BadRequest(_)));
    }

    #[tokio::test]
    async fn prompt_blocks_emit_resource_links_for_existing_files() {
        let workspace = tempfile::tempdir().expect("workspace");
        std::fs::write(workspace.path().join("notes.md"), b"hello").expect("write");

        let blocks = DefaultConversationHost::default()
            .build_prompt_blocks(
                workspace.path().to_str().expect("utf8 path"),
                "see this".to_string(),
                &[],
                &[agents::ConversationFileRef {
                    path: "notes.md".to_string(),
                    start_line: Some(1),
                    end_line: Some(2),
                }],
            )
            .await
            .expect("blocks");

        assert!(matches!(
            &blocks[0],
            AgentContentBlock::Text { text } if text == "see this"
        ));
        assert!(matches!(
            &blocks[1],
            AgentContentBlock::Resource { title, uri }
                if title.as_deref() == Some("notes.md:1-2") && uri.starts_with("file:")
        ));
    }

    #[tokio::test]
    async fn prompt_blocks_emit_resource_links_for_directories() {
        let workspace = tempfile::tempdir().expect("workspace");
        std::fs::create_dir(workspace.path().join("src")).expect("dir");

        let blocks = DefaultConversationHost::default()
            .build_prompt_blocks(
                workspace.path().to_str().expect("utf8 path"),
                "see this".to_string(),
                &[],
                &[agents::ConversationFileRef {
                    path: "src".to_string(),
                    start_line: None,
                    end_line: None,
                }],
            )
            .await
            .expect("blocks");

        assert!(matches!(
            &blocks[1],
            AgentContentBlock::Resource { title, uri }
                if title.as_deref() == Some("src") && uri.starts_with("file:")
        ));
    }

    #[tokio::test]
    async fn prompt_blocks_reject_missing_file_refs() {
        let workspace = tempfile::tempdir().expect("workspace");
        let error = DefaultConversationHost::default()
            .build_prompt_blocks(
                workspace.path().to_str().expect("utf8 path"),
                "see this".to_string(),
                &[],
                &[agents::ConversationFileRef {
                    path: "missing.md".to_string(),
                    start_line: None,
                    end_line: None,
                }],
            )
            .await
            .expect_err("missing file must fail");
        assert!(matches!(error, ConversationServiceError::NotFound(_)));
    }

    #[tokio::test]
    async fn prompt_blocks_emit_resource_links_for_videos() {
        let workspace = tempfile::tempdir().expect("workspace");
        std::fs::write(workspace.path().join("clip.mp4"), b"fake-mp4").expect("write");

        let blocks = DefaultConversationHost::default()
            .build_prompt_blocks(
                workspace.path().to_str().expect("utf8 path"),
                "watch this".to_string(),
                &["clip.mp4".to_string()],
                &[],
            )
            .await
            .expect("blocks");

        assert!(matches!(
            &blocks[0],
            AgentContentBlock::Text { text } if text == "watch this"
        ));
        assert!(matches!(
            &blocks[1],
            AgentContentBlock::Resource { title, uri }
                if title.as_deref() == Some("clip.mp4") && uri.starts_with("file:")
        ));
    }

    #[tokio::test]
    async fn prompt_blocks_emit_resource_links_for_documents() {
        let workspace = tempfile::tempdir().expect("workspace");
        std::fs::write(workspace.path().join("notes.md"), b"# hi").expect("write");
        std::fs::write(workspace.path().join("report.pdf"), b"%PDF").expect("write");

        let blocks = DefaultConversationHost::default()
            .build_prompt_blocks(
                workspace.path().to_str().expect("utf8 path"),
                "read these".to_string(),
                &["notes.md".to_string(), "report.pdf".to_string()],
                &[],
            )
            .await
            .expect("blocks");

        assert!(matches!(
            &blocks[0],
            AgentContentBlock::Text { text } if text == "read these"
        ));
        assert!(matches!(
            &blocks[1],
            AgentContentBlock::Resource { title, uri }
                if title.as_deref() == Some("notes.md") && uri.starts_with("file:")
        ));
        assert!(matches!(
            &blocks[2],
            AgentContentBlock::Resource { title, uri }
                if title.as_deref() == Some("report.pdf") && uri.starts_with("file:")
        ));
    }
}

#[cfg(test)]
mod working_dir_tests {
    use chrono::Utc;
    use db::models::{repo::Repo, workspace::Workspace};
    use uuid::Uuid;

    use super::{
        DefaultConversationHost, resolve_absolute_workspace_agent_working_dir,
        resolve_workspace_additional_directories, resolve_workspace_agent_working_dir,
    };
    use crate::ConversationHost;

    fn sample_repo(name: &str, path: &str) -> Repo {
        Repo {
            id: Uuid::new_v4(),
            path: std::path::PathBuf::from(path),
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

    fn sample_workspace(use_worktree: bool, agent_working_dir: Option<&str>) -> Workspace {
        Workspace {
            id: Uuid::new_v4(),
            project_id: Uuid::new_v4(),
            task_id: Uuid::new_v4(),
            parent_workspace_id: None,
            container_ref: None,
            branch: "main".to_string(),
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
    fn managed_worktree_cwd_joins_the_repo_folder_to_the_container() {
        let workspace = sample_workspace(true, Some("VibeX"));
        let repo = sample_repo("VibeX", "/Users/mac/Projects/VibeX");
        let container = "/Users/mac/.vibex-workspaces/workflow-debug";

        assert_eq!(
            resolve_workspace_agent_working_dir(&workspace, container, std::slice::from_ref(&repo))
                .as_deref(),
            Some("VibeX")
        );
        let expected = std::path::Path::new(container)
            .join("VibeX")
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            resolve_absolute_workspace_agent_working_dir(
                &workspace,
                container,
                std::slice::from_ref(&repo)
            ),
            expected
        );
        assert_eq!(
            DefaultConversationHost::default()
                .resolve_working_dir(&workspace, container, std::slice::from_ref(&repo))
                .as_deref(),
            Some(expected.as_str())
        );
    }

    #[test]
    fn project_root_cwd_stays_the_repository_path() {
        let workspace = sample_workspace(false, None);
        let repo = sample_repo("VibeX", "/Users/mac/Projects/VibeX");

        assert_eq!(
            resolve_absolute_workspace_agent_working_dir(
                &workspace,
                "/Users/mac/Projects/VibeX",
                std::slice::from_ref(&repo)
            ),
            "/Users/mac/Projects/VibeX"
        );
    }

    #[test]
    fn worktree_additional_directories_include_the_primary_checkout() {
        let workspace = sample_workspace(true, Some("VibeX"));
        let repo = sample_repo("VibeX", "/Users/mac/Projects/VibeX");
        let container = "/Users/mac/.vibex-workspaces/workflow-debug";
        let cwd = format!("{container}/VibeX");

        let directories = resolve_workspace_additional_directories(
            &workspace,
            container,
            std::slice::from_ref(&repo),
            &cwd,
        );
        assert_eq!(
            directories,
            vec![std::path::PathBuf::from("/Users/mac/Projects/VibeX")]
        );
    }

    #[tokio::test]
    async fn provider_instance_wiring_resolves_secrets_and_isolates_oauth_profiles() {
        use db::models::provider_instance::{
            CreateProviderInstanceInput, ProviderInstanceRecord, ensure_provider_instances_schema,
        };
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        ensure_provider_instances_schema(&pool).await.unwrap();
        sqlx::query("ALTER TABLE provider_instances ADD COLUMN secret_bindings_json TEXT")
            .execute(&pool)
            .await
            .unwrap();
        let temp = tempfile::tempdir().unwrap();
        for (inst, name, auth, is_default) in [
            ("default", "Personal Claude", r#"{"mode":"OfficialOAuth"}"#, true),
            ("work-oauth", "Work Claude", r#"{"mode":"OfficialOAuth","accountEmail":"work@co"}"#, false),
        ] {
            ProviderInstanceRecord::create(&pool, CreateProviderInstanceInput {
                id: None, agent_id: "claude-code", instance_id: inst, display_name: name, auth_mode: auth, is_default,
            }).await.unwrap();
        }
        let bindings = serde_json::json!({"CUSTOM_EXTRA_TOKEN": {"kind": "inline", "value": "bound-token-value"}}).to_string();
        sqlx::query("UPDATE provider_instances SET secret_bindings_json = ? WHERE instance_id = 'work-oauth'")
            .bind(bindings)
            .execute(&pool)
            .await
            .unwrap();

        let mut env = std::collections::HashMap::from([
            ("VIBEX_PROVIDER_INSTANCE_ID".to_string(), "work-oauth".to_string()),
            ("VIBEX_PROVIDER_INSTANCES_ROOT".to_string(), temp.path().to_string_lossy().into_owned()),
        ]);
        let agent_id = agents::AgentId::parse("claude_code").unwrap();
        super::apply_provider_instance_launch_env(
            &pool, &agent_id, &mut env, &std::collections::HashSet::new(), &agents::secret_resolution::SecretResolver::new(),
        ).await.unwrap();
        assert_eq!(env.get("VIBEX_PROVIDER_INSTANCE_ID").map(String::as_str), Some("work-oauth"));
        assert_eq!(env.get("CUSTOM_EXTRA_TOKEN").map(String::as_str), Some("bound-token-value"));
        let config_dir = env.get("CLAUDE_CONFIG_DIR").expect("isolated CLAUDE_CONFIG_DIR");
        assert!(std::path::Path::new(config_dir).is_dir() && config_dir.contains("work-oauth"));
    }
}
