//! Instance-scoped Agent management helpers (`Local` vs custom isolated `ProviderInstanceRecord`).
//!
//! Guarantees strict isolation between `"local"` (`agent_setting` / `agent_probe` / global store)
//! and custom isolated instances (`<asset_dir>/provider-instances/<agent>/<instance_id>/...`),
//! supporting `claude_code` and `codex` without ever mutating `"local"` state.

use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
};

use agents::{
    AgentId, AgentKind, BuiltInProfileCatalog, NativeFileSystem, ProfileManagementActionKind,
    TokioNativeFileSystem, apply_built_in_auth_mode_policy, apply_codex_auth_mode,
    authentication_from_account_command, built_in_auth_mode_policy,
    codex_shadow_home::prepare_codex_shadow_home, official_account_present,
    resolve_account_label_with_env,
    secret_resolution::{
        ProviderAuthMode, ProviderInstanceConfig, SecretResolver, ensure_private_instance_dir,
        mask_secret_preview,
    },
};
use api_types::{
    AgentAccountFlowStatus, AgentAccountFlowView, AgentAuthModeView, AgentAuthenticationStatus,
    AgentManagementActionReceipt, AgentManagementActionView, AgentManagementActionsView,
};
use application::ApplicationError;
use db::models::provider_instance::{
    LOCAL_PROVIDER_INSTANCE_ID, ProviderInstanceRecord, UpdateProviderInstanceInput,
    canonical_provider_agent_id,
};
use serde_json::{Value, json};
use sqlx::SqlitePool;

use super::{
    auth_projection::{
        project_auth_mode_view_at, read_json_object_or_empty, release_provider_projection,
        resolve_agent_home, with_account_label_env,
    },
    diagnostics_and_env::{
        execute_non_antigravity_action_for_instance, management_action_kind,
        management_program_names,
    },
    persist_agent_environment, read_agent_environment, resolve_management_action_program,
};
use crate::{
    domains::internal_error,
    host::{
        account_flow,
        native::{model_providers, provider_store_path},
    },
};

#[derive(Debug, Clone)]
pub(crate) enum ManagementInstanceScope {
    Local,
    Custom(ProviderInstanceRecord),
}

impl ManagementInstanceScope {
    pub(crate) fn instance_id(&self) -> Option<&str> {
        match self {
            Self::Local => None,
            Self::Custom(record) => Some(record.instance_id.as_str()),
        }
    }

    pub(crate) fn is_custom(&self) -> bool {
        matches!(self, Self::Custom(_))
    }
}

pub(crate) fn extract_provider_instance_id(args: &Value) -> Option<String> {
    let candidates = [
        args.get("request")
            .and_then(|req| req.get("providerInstanceId").or_else(|| req.get("provider_instance_id"))),
        args.get("providerInstanceId"),
        args.get("provider_instance_id"),
    ];
    candidates
        .into_iter()
        .flatten()
        .find_map(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(crate) async fn resolve_management_instance_scope(
    pool: &SqlitePool,
    agent_id: &AgentId,
    requested_instance_id: Option<&str>,
) -> Result<ManagementInstanceScope, ApplicationError> {
    let Some(raw) = requested_instance_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(ManagementInstanceScope::Local);
    };
    if raw.eq_ignore_ascii_case(LOCAL_PROVIDER_INSTANCE_ID) {
        return Ok(ManagementInstanceScope::Local);
    }
    let canonical = canonical_provider_agent_id(agent_id.as_str())
        .map_err(|err| ApplicationError::bad_request(err.to_string()))?;
    let record = ProviderInstanceRecord::find_by_instance(pool, &canonical, raw)
        .await
        .map_err(|err| ApplicationError::bad_request(err.to_string()))?
        .ok_or_else(|| {
            ApplicationError::not_found(format!(
                "Provider instance `{raw}` for `{agent_id}` was not found"
            ))
        })?;
    Ok(ManagementInstanceScope::Custom(record))
}

fn ensure_file_if_missing(path: &Path, default_bytes: &[u8]) -> Result<(), ApplicationError> {
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        ensure_private_instance_dir(parent).map_err(|err| {
            internal_error(format!(
                "Failed to create instance parent dir `{}`: {err}",
                parent.display()
            ))
        })?;
    }
    std::fs::write(path, default_bytes).map_err(|err| {
        internal_error(format!(
            "Failed to initialize instance file `{}`: {err}",
            path.display()
        ))
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub(crate) fn ensure_custom_instance_dirs_with_root(
    agent_id: &AgentId,
    instance_id: &str,
    instances_root_override: Option<&Path>,
) -> Result<PathBuf, ApplicationError> {
    let instance_dir = conversations::host_isolation::isolated_instance_root(
        agent_id,
        instance_id,
        instances_root_override,
    )
    .ok_or_else(|| {
        ApplicationError::bad_request(format!(
            "Agent `{agent_id}` does not support isolated provider instances"
        ))
    })?;
    ensure_private_instance_dir(&instance_dir).map_err(|err| {
        internal_error(format!(
            "Failed to initialize provider instance directory `{}`: {err}",
            instance_dir.display()
        ))
    })?;
    if let Some((_, native_dir)) =
        conversations::host_isolation::isolated_instance_native_dir(agent_id, &instance_dir)
    {
        ensure_private_instance_dir(&native_dir).map_err(|err| {
            internal_error(format!(
                "Failed to initialize isolated native directory `{}`: {err}",
                native_dir.display()
            ))
        })?;
        if agent_id.as_str() == "codex" {
            let source_codex_home = dirs::home_dir().map(|home| home.join(".codex"));
            if let Err(err) = prepare_codex_shadow_home(source_codex_home.as_deref(), &native_dir) {
                tracing::warn!(
                    instance_id,
                    %err,
                    "failed to prepare Codex shadow home for provider instance"
                );
            }
        }
    }
    ensure_file_if_missing(&instance_dir.join("instance-env.json"), b"{}\n")?;
    ensure_file_if_missing(
        &instance_dir.join("agent-model-providers.json"),
        b"{\"providers\":[],\"bindings\":{}}\n",
    )?;
    Ok(instance_dir)
}

pub(crate) fn ensure_custom_instance_dirs(
    agent_id: &AgentId,
    instance_id: &str,
) -> Result<PathBuf, ApplicationError> {
    ensure_custom_instance_dirs_with_root(agent_id, instance_id, None)
}

pub(crate) fn scoped_store_path(scope: &ManagementInstanceScope) -> Result<PathBuf, ApplicationError> {
    match scope {
        ManagementInstanceScope::Local => Ok(provider_store_path()),
        ManagementInstanceScope::Custom(record) => {
            let agent_id = AgentId::parse(&record.agent_id).map_err(internal_error)?;
            let dir = ensure_custom_instance_dirs(&agent_id, &record.instance_id)?;
            Ok(dir.join("agent-model-providers.json"))
        }
    }
}

pub(crate) async fn scoped_environment(
    pool: &SqlitePool,
    scope: &ManagementInstanceScope,
    agent_id: &AgentId,
) -> Result<HashMap<String, String>, ApplicationError> {
    match scope {
        ManagementInstanceScope::Local => read_agent_environment(pool, agent_id).await,
        ManagementInstanceScope::Custom(record) => {
            scoped_custom_environment_with_root(record, agent_id, None).await
        }
    }
}

async fn scoped_custom_environment_with_root(
    record: &ProviderInstanceRecord,
    agent_id: &AgentId,
    instances_root_override: Option<&Path>,
) -> Result<HashMap<String, String>, ApplicationError> {
    let instance_dir = ensure_custom_instance_dirs_with_root(
        agent_id,
        &record.instance_id,
        instances_root_override,
    )?;
    let mut env = HashMap::new();
    let env_path = instance_dir.join("instance-env.json");
    if let Ok(raw) = tokio::fs::read_to_string(&env_path).await
        && let Ok(parsed) = serde_json::from_str::<HashMap<String, String>>(&raw)
    {
        for (key, value) in parsed {
            if !value.trim().is_empty() {
                env.insert(key, value);
            }
        }
    }

    if let Some((env_var, native_dir)) =
        conversations::host_isolation::isolated_instance_native_dir(agent_id, &instance_dir)
    {
        env.insert(
            env_var.to_string(),
            native_dir.to_string_lossy().into_owned(),
        );
    }

    if let Ok(parsed_mode) = serde_json::from_str::<ProviderAuthMode>(&record.auth_mode)
        && let Ok(kind) = agent_id.as_str().parse::<AgentKind>()
    {
        let cfg = ProviderInstanceConfig {
            id: None,
            instance_id: record.instance_id.clone(),
            agent_id: kind,
            auth_mode: parsed_mode,
            display_name: record.display_name.clone(),
            is_default: record.is_default,
        };
        if let Ok(resolved) = SecretResolver::new().resolve_launch_env(&cfg).await {
            for (key, value) in resolved {
                env.entry(key).or_insert(value);
            }
        }
    }

    Ok(env)
}

pub(crate) async fn persist_scoped_environment(
    pool: &SqlitePool,
    scope: &ManagementInstanceScope,
    agent_id: &AgentId,
    env: &HashMap<String, String>,
) -> Result<(), ApplicationError> {
    match scope {
        ManagementInstanceScope::Local => persist_agent_environment(pool, agent_id, env).await,
        ManagementInstanceScope::Custom(record) => {
            persist_custom_environment_with_root(record, agent_id, env, None).await
        }
    }
}

async fn persist_custom_environment_with_root(
    record: &ProviderInstanceRecord,
    agent_id: &AgentId,
    env: &HashMap<String, String>,
    instances_root_override: Option<&Path>,
) -> Result<(), ApplicationError> {
    let instance_dir = ensure_custom_instance_dirs_with_root(
        agent_id,
        &record.instance_id,
        instances_root_override,
    )?;
    let mut persisted = BTreeMap::new();
    for (key, value) in env {
        if matches!(
            key.as_str(),
            "CLAUDE_CONFIG_DIR"
                | "CODEX_HOME"
                | "DIMO_PROVIDER_INSTANCE_ID"
                | "DIMO_PROVIDER_INSTANCES_ROOT"
                | "DIMO_ISOLATE_PROVIDER_PROFILE"
        ) || value.trim().is_empty()
        {
            continue;
        }
        persisted.insert(key.clone(), value.clone());
    }
    let bytes = serde_json::to_vec_pretty(&persisted).map_err(internal_error)?;
    TokioNativeFileSystem
        .write_atomic(&instance_dir.join("instance-env.json"), &bytes, true)
        .await
        .map_err(internal_error)
}

pub(crate) async fn sync_custom_instance_auth_summary(
    pool: &SqlitePool,
    record: &ProviderInstanceRecord,
    agent_id: &AgentId,
    mode: &str,
    api_key: Option<&str>,
    account_email: Option<String>,
) -> Result<(), ApplicationError> {
    let canonical = canonical_provider_agent_id(agent_id.as_str())
        .map_err(|err| ApplicationError::bad_request(err.to_string()))?;
    let key_id = format!("provider:{}:{}", canonical, record.instance_id);
    let resolver = SecretResolver::new();

    let next_auth_value = match mode {
        "official_api" | "api_key" => {
            let explicit_key = api_key.map(str::trim).filter(|s| !s.is_empty());
            if let Some(secret) = explicit_key {
                let stored_ref = resolver
                    .store_keychain(&key_id, secret)
                    .await
                    .map_err(internal_error)?;
                json!({
                    "mode": "ApiKey",
                    "keyRef": stored_ref,
                    "maskedPreview": mask_secret_preview(secret),
                })
            } else {
                let existing = serde_json::from_str::<Value>(&record.auth_mode).ok();
                if existing
                    .as_ref()
                    .and_then(|v| v.get("mode"))
                    .and_then(Value::as_str)
                    == Some("ApiKey")
                {
                    existing.unwrap_or_else(|| json!({ "mode": "ApiKey" }))
                } else {
                    json!({ "mode": "ApiKey" })
                }
            }
        }
        _ => {
            let mut obj = serde_json::Map::new();
            obj.insert("mode".to_string(), Value::String("OfficialOAuth".to_string()));
            if let Some(email) = account_email.filter(|s| !s.trim().is_empty()) {
                obj.insert("accountEmail".to_string(), Value::String(email));
            }
            Value::Object(obj)
        }
    };

    let auth_mode_json = serde_json::to_string(&next_auth_value).map_err(internal_error)?;
    ProviderInstanceRecord::update(
        pool,
        &canonical,
        &record.instance_id,
        UpdateProviderInstanceInput {
            display_name: None,
            auth_mode: Some(&auth_mode_json),
            is_default: None,
        },
    )
    .await
    .map_err(|err| internal_error(err.to_string()))?;
    Ok(())
}

pub(crate) async fn custom_auth_mode(
    pool: &SqlitePool,
    record: &ProviderInstanceRecord,
    agent_id: AgentId,
) -> Result<AgentAuthModeView, ApplicationError> {
    let home =
        dirs::home_dir().ok_or_else(|| ApplicationError::internal("home directory missing"))?;
    let env = scoped_environment(pool, &ManagementInstanceScope::Custom(record.clone()), &agent_id)
        .await?;
    let store_path = scoped_store_path(&ManagementInstanceScope::Custom(record.clone()))?;
    let view = project_auth_mode_view_at(&home, &store_path, agent_id, &env).await?;
    with_account_label_env(view, &home, &env).await
}

pub(crate) async fn custom_auth_mode_set(
    pool: &SqlitePool,
    record: &ProviderInstanceRecord,
    agent_id: AgentId,
    mode: String,
    api_key: Option<String>,
) -> Result<AgentAuthModeView, ApplicationError> {
    let scope = ManagementInstanceScope::Custom(record.clone());
    let store_path = scoped_store_path(&scope)?;
    let home =
        dirs::home_dir().ok_or_else(|| ApplicationError::internal("home directory missing"))?;

    if agent_id.as_str() == "codex" {
        if !agents::CODEX_AUTH_MODES.contains(&mode.as_str()) {
            return Err(ApplicationError::bad_request(format!(
                "不支持鉴权模式 `{mode}`"
            )));
        }
        let mut env = scoped_environment(pool, &scope, &agent_id).await?;
        let native_home = model_providers::provider_native_home(&home, &env, &agent_id);
        let bound_id = model_providers::list_with_native(
            &store_path,
            agent_id.clone(),
            Some(&native_home),
        )
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?
        .bound_provider_id;
        if mode == "model_provider" && bound_id.is_none() {
            return Err(ApplicationError::bad_request(
                "请先在 Model Provider 区域绑定一个 Codex Provider",
            ));
        }
        if mode != "model_provider" {
            release_provider_projection(&home, &store_path, &agent_id, &env).await?;
            let codex_home = resolve_agent_home(&home, &env, "CODEX_HOME", ".codex");
            let auth_path = codex_home.join("auth.json");
            let mut document = read_json_object_or_empty(&auth_path).await?;
            apply_codex_auth_mode(&mut document, &mode, api_key.as_deref())
                .map_err(ApplicationError::bad_request)?;
            let bytes = serde_json::to_vec_pretty(&document).map_err(internal_error)?;
            TokioNativeFileSystem
                .write_atomic(&auth_path, &bytes, true)
                .await
                .map_err(internal_error)?;
            if mode == "chatgpt_subscription" {
                env.remove("OPENAI_API_KEY");
                persist_scoped_environment(pool, &scope, &agent_id, &env).await?;
            }
        } else {
            env.remove("OPENAI_API_KEY");
            persist_scoped_environment(pool, &scope, &agent_id, &env).await?;
        }
        let account_email = resolve_account_label_with_env(Some(&home), &agent_id, &env).await;
        sync_custom_instance_auth_summary(
            pool,
            record,
            &agent_id,
            &mode,
            api_key.as_deref(),
            account_email,
        )
        .await?;
        let refreshed_env = scoped_environment(pool, &scope, &agent_id).await?;
        let view = project_auth_mode_view_at(&home, &store_path, agent_id, &refreshed_env).await?;
        return with_account_label_env(view, &home, &refreshed_env).await;
    }

    let policy = built_in_auth_mode_policy(&agent_id)
        .ok_or_else(|| ApplicationError::bad_request("此 Agent 没有独立鉴权模式"))?;
    if !policy.modes.contains(&mode.as_str()) {
        return Err(ApplicationError::bad_request(format!(
            "不支持鉴权模式 `{mode}`"
        )));
    }
    let mut env = scoped_environment(pool, &scope, &agent_id).await?;
    env.insert(policy.mode_env.to_string(), mode.clone());
    if policy.credential_modes.contains(&mode.as_str()) {
        if let Some(secret) = api_key
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            env.insert(policy.credential_env.to_string(), secret.to_string());
        }
        let native_snapshot = agents::NativeConfigProvider::with_environment(
            std::sync::Arc::new(TokioNativeFileSystem),
            home.clone(),
            env.clone().into_iter().collect(),
        )
        .read(&agent_id, false)
        .await
        .ok();
        let has_native_key = native_snapshot
            .as_ref()
            .is_some_and(|snapshot| snapshot.field_present("anthropic_api_key"));
        if env
            .get(policy.credential_env)
            .is_none_or(|value| value.trim().is_empty())
            && !has_native_key
        {
            return Err(ApplicationError::bad_request(format!(
                "{} 模式需要 {}",
                mode, policy.credential_env
            )));
        }
    } else {
        env.remove(policy.credential_env);
    }
    if mode != "model_provider" {
        release_provider_projection(&home, &store_path, &agent_id, &env).await?;
    }
    apply_built_in_auth_mode_policy(&agent_id, &mut env);
    persist_scoped_environment(pool, &scope, &agent_id, &env).await?;
    let account_email = resolve_account_label_with_env(Some(&home), &agent_id, &env).await;
    sync_custom_instance_auth_summary(
        pool,
        record,
        &agent_id,
        &mode,
        api_key.as_deref(),
        account_email,
    )
    .await?;
    let refreshed_env = scoped_environment(pool, &scope, &agent_id).await?;
    let view = project_auth_mode_view_at(&home, &store_path, agent_id, &refreshed_env).await?;
    with_account_label_env(view, &home, &refreshed_env).await
}

pub(crate) async fn scoped_actions(
    pool: &SqlitePool,
    agent_id: AgentId,
    scope: &ManagementInstanceScope,
) -> Result<AgentManagementActionsView, ApplicationError> {
    let catalog = BuiltInProfileCatalog::management();
    let profile = catalog.profile(&agent_id).ok_or_else(|| {
        ApplicationError::not_found(format!("Agent `{agent_id}` 没有内置账号管理动作"))
    })?;
    let environment = scoped_environment(pool, scope, &agent_id).await?;
    let mut actions = Vec::with_capacity(profile.management_actions.len());
    for action in profile.management_actions {
        let program =
            resolve_management_action_program(pool, &agent_id, action, &environment).await;
        let available = action.url.is_some() || program.is_some();
        let translation_prefix = format!(
            "agents.managementAction.{}.{}",
            agent_id.as_str(),
            action.id
        );
        actions.push(AgentManagementActionView {
            id: action.id.to_string(),
            label: action.label.to_string(),
            description: action.description.to_string(),
            label_key: format!("{translation_prefix}.label"),
            description_key: format!("{translation_prefix}.description"),
            kind: management_action_kind(action.kind),
            available,
            unavailable_reason: (!available).then(|| {
                format!(
                    "未找到 {}；请重新安装或修复此 Agent。",
                    management_program_names(action)
                )
            }),
            url: action.url.map(str::to_string),
        });
    }
    Ok(AgentManagementActionsView { agent_id, actions })
}

pub(crate) async fn custom_run_action(
    pool: &SqlitePool,
    record: &ProviderInstanceRecord,
    agent_id: AgentId,
    action_id: String,
) -> Result<AgentManagementActionReceipt, ApplicationError> {
    let catalog = BuiltInProfileCatalog::management();
    let profile = catalog.profile(&agent_id).ok_or_else(|| {
        ApplicationError::not_found(format!("Agent `{agent_id}` 没有内置账号管理动作"))
    })?;
    let action = profile
        .management_actions
        .iter()
        .find(|action| action.id == action_id)
        .ok_or_else(|| {
            ApplicationError::bad_request(format!("Agent `{agent_id}` 不支持动作 `{action_id}`"))
        })?;
    let scope = ManagementInstanceScope::Custom(record.clone());
    let (environment, resolved_program) = if action.url.is_some() {
        (HashMap::new(), None)
    } else {
        let environment = scoped_environment(pool, &scope, &agent_id).await?;
        let program =
            resolve_management_action_program(pool, &agent_id, action, &environment).await;
        (environment, program)
    };
    execute_non_antigravity_action_for_instance(
        &agent_id,
        Some(&record.instance_id),
        action,
        &environment,
        resolved_program,
    )
    .await?;
    Ok(AgentManagementActionReceipt {
        agent_id,
        action_id,
        launched: true,
    })
}

pub(crate) async fn custom_account_flow_status(
    pool: &SqlitePool,
    record: &ProviderInstanceRecord,
    agent_id: AgentId,
) -> Result<AgentAccountFlowView, ApplicationError> {
    let Some(pending) =
        account_flow::peek_account_flow_for_instance(&agent_id, Some(&record.instance_id))
    else {
        return Ok(account_flow::idle_account_flow(agent_id));
    };
    let Ok(contents) = tokio::fs::read_to_string(&pending.result_path).await else {
        return Ok(account_flow::pending_account_flow_view(
            agent_id,
            pending.action_id,
        ));
    };
    let Some(exit_code) = account_flow::parse_account_flow_exit(&contents) else {
        return Ok(account_flow::pending_account_flow_view(
            agent_id,
            pending.action_id,
        ));
    };
    account_flow::take_account_flow_for_instance(&agent_id, Some(&record.instance_id));
    let _ = tokio::fs::remove_file(&pending.result_path).await;

    let scope = ManagementInstanceScope::Custom(record.clone());
    let mut env = scoped_environment(pool, &scope, &agent_id).await?;
    let home =
        dirs::home_dir().ok_or_else(|| ApplicationError::internal("home directory missing"))?;
    let authentication = authentication_from_account_command(pending.kind, exit_code)
        .unwrap_or_else(|| AgentAuthenticationStatus::NotLoggedIn);
    if exit_code == 0 {
        let target_mode = if agent_id.as_str() == "codex" {
            "chatgpt_subscription"
        } else {
            "official_subscription"
        };
        if matches!(pending.kind, ProfileManagementActionKind::Login) {
            if let Some(policy) = built_in_auth_mode_policy(&agent_id) {
                env.insert(policy.mode_env.to_string(), target_mode.to_string());
                env.remove(policy.credential_env);
                apply_built_in_auth_mode_policy(&agent_id, &mut env);
                let _ = persist_scoped_environment(pool, &scope, &agent_id, &env).await;
            }
            let account_email = resolve_account_label_with_env(Some(&home), &agent_id, &env).await;
            let _ = sync_custom_instance_auth_summary(
                pool,
                record,
                &agent_id,
                target_mode,
                None,
                account_email,
            )
            .await;
        }
        crate::host::events::current_host_events()
            .emit("agent-management-snapshot-invalidated", ());
    }
    Ok(AgentAccountFlowView {
        agent_id,
        action_id: Some(pending.action_id),
        status: if exit_code == 0 {
            AgentAccountFlowStatus::Succeeded
        } else {
            AgentAccountFlowStatus::Failed
        },
        exit_code: Some(exit_code),
        authentication: Some(authentication),
    })
}

pub(crate) async fn scoped_logged_in(
    pool: &SqlitePool,
    scope: &ManagementInstanceScope,
    agent_id: &AgentId,
    env: &HashMap<String, String>,
) -> bool {
    match scope {
        ManagementInstanceScope::Local => {
            sqlx::query_scalar::<_, String>(
                "SELECT authentication FROM agent_probe WHERE agent_id = ?",
            )
            .bind(agent_id.as_str())
            .fetch_optional(pool)
            .await
            .ok()
            .flatten()
            .as_deref()
                == Some("account")
        }
        ManagementInstanceScope::Custom(_) => {
            let Some(home) = dirs::home_dir() else {
                return false;
            };
            official_account_present(&home, agent_id, env).await
        }
    }
}

pub(crate) async fn sync_native_config_auth_summary(
    pool: &SqlitePool,
    scope: &ManagementInstanceScope,
    agent_id: &AgentId,
    written_fields: &BTreeMap<String, Option<String>>,
) -> Result<(), ApplicationError> {
    let ManagementInstanceScope::Custom(record) = scope else {
        return Ok(());
    };
    if let Some(maybe_key) = written_fields.get("anthropic_api_key") {
        let mut env = scoped_environment(pool, scope, agent_id).await?;
        let trimmed = maybe_key
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        if let Some(key) = trimmed {
            env.insert("CLAUDE_AUTH_MODE".to_string(), "official_api".to_string());
            env.remove("ANTHROPIC_API_KEY");
            apply_built_in_auth_mode_policy(agent_id, &mut env);
            persist_scoped_environment(pool, scope, agent_id, &env).await?;
            sync_custom_instance_auth_summary(
                pool,
                record,
                agent_id,
                "official_api",
                Some(key),
                None,
            )
            .await?;
        } else {
            sync_custom_instance_auth_summary(
                pool,
                record,
                agent_id,
                "official_subscription",
                None,
                None,
            )
            .await?;
        }
    } else if let Some(maybe_key) = written_fields.get("openai_api_key") {
        let trimmed = maybe_key
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        if let Some(key) = trimmed {
            sync_custom_instance_auth_summary(
                pool,
                record,
                agent_id,
                "api_key",
                Some(key),
                None,
            )
            .await?;
        } else {
            sync_custom_instance_auth_summary(
                pool,
                record,
                agent_id,
                "chatgpt_subscription",
                None,
                None,
            )
            .await?;
        }
    }
    Ok(())
}

pub(crate) async fn sync_model_provider_auth_overlay_scoped(
    pool: &SqlitePool,
    scope: &ManagementInstanceScope,
    agent_id: &AgentId,
    bound: bool,
) -> Result<(), ApplicationError> {
    if let Some(policy) = built_in_auth_mode_policy(agent_id)
        && policy.modes.contains(&"model_provider")
    {
        let mut environment = scoped_environment(pool, scope, agent_id).await?;
        if bound {
            environment.insert(policy.mode_env.to_string(), "model_provider".to_string());
            apply_built_in_auth_mode_policy(agent_id, &mut environment);
        } else {
            environment.remove(policy.mode_env);
        }
        persist_scoped_environment(pool, scope, agent_id, &environment).await?;
    }
    if let ManagementInstanceScope::Custom(record) = scope {
        let next_mode = if bound {
            "model_provider"
        } else if agent_id.as_str() == "codex" {
            "chatgpt_subscription"
        } else {
            "official_subscription"
        };
        let home = dirs::home_dir();
        let env = scoped_environment(pool, scope, agent_id).await?;
        let account_email = match home.as_deref() {
            Some(h) => resolve_account_label_with_env(Some(h), agent_id, &env).await,
            None => None,
        };
        sync_custom_instance_auth_summary(pool, record, agent_id, next_mode, None, account_email)
            .await?;
    }
    Ok(())
}

pub(crate) async fn after_codex_device_login(
    pool: &SqlitePool,
    scope: &ManagementInstanceScope,
    agent_id: &AgentId,
    env: &HashMap<String, String>,
) -> Result<(), ApplicationError> {
    match scope {
        ManagementInstanceScope::Local => {
            let service =
                services::services::agent_management::AgentManagementApplicationService::new(
                    pool.clone(),
                );
            service
                .sync_authentication(agent_id, AgentAuthenticationStatus::Account, None)
                .await
                .map_err(internal_error)?;
            service
                .set_account_signed_out(agent_id, false)
                .await
                .map_err(internal_error)?;
        }
        ManagementInstanceScope::Custom(record) => {
            let home = dirs::home_dir();
            let account_email = match home.as_deref() {
                Some(h) => resolve_account_label_with_env(Some(h), agent_id, env).await,
                None => None,
            };
            let mut next_env = env.clone();
            next_env.remove("OPENAI_API_KEY");
            persist_scoped_environment(pool, scope, agent_id, &next_env).await?;
            sync_custom_instance_auth_summary(
                pool,
                record,
                agent_id,
                "chatgpt_subscription",
                None,
                account_email,
            )
            .await?;
        }
    }
    Ok(())
}

pub(crate) async fn resolve_native_scope_context(
    pool: &SqlitePool,
    agent_id: &AgentId,
    requested_instance_id: Option<&str>,
) -> Result<(ManagementInstanceScope, PathBuf, HashMap<String, String>, PathBuf), ApplicationError> {
    let scope = resolve_management_instance_scope(pool, agent_id, requested_instance_id).await?;
    let home =
        dirs::home_dir().ok_or_else(|| ApplicationError::internal("home directory missing"))?;
    let env = scoped_environment(pool, &scope, agent_id).await?;
    let store_path = scoped_store_path(&scope)?;
    Ok((scope, home, env, store_path))
}

#[cfg(test)]
mod tests {
    use db::models::provider_instance::{
        CreateProviderInstanceInput, ensure_provider_instances_schema,
    };

    use super::*;

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        ensure_provider_instances_schema(&pool).await.unwrap();
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS agent_setting (agent_type TEXT PRIMARY KEY, env_json TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    #[test]
    fn extract_provider_instance_id_handles_flat_wrapped_and_snake_case() {
        assert_eq!(
            extract_provider_instance_id(&json!({ "providerInstanceId": "work-1" })).as_deref(),
            Some("work-1")
        );
        assert_eq!(
            extract_provider_instance_id(&json!({ "request": { "provider_instance_id": "inst-2" } }))
                .as_deref(),
            Some("inst-2")
        );
        assert_eq!(extract_provider_instance_id(&json!({ "providerInstanceId": "   " })), None);
    }

    #[tokio::test]
    async fn resolve_scope_treats_none_and_local_as_local_and_rejects_unsupported_agents() {
        let pool = test_pool().await;
        let claude = AgentId::parse("claude_code").unwrap();
        let kiro = AgentId::parse("kiro").unwrap();

        assert!(!resolve_management_instance_scope(&pool, &claude, None).await.unwrap().is_custom());
        assert!(
            !resolve_management_instance_scope(&pool, &claude, Some("local"))
                .await
                .unwrap()
                .is_custom()
        );
        assert!(resolve_management_instance_scope(&pool, &kiro, Some("work-1")).await.is_err());
    }

    #[tokio::test]
    async fn custom_instance_dirs_and_env_remain_clean_and_isolated() {
        let pool = test_pool().await;
        let temp = tempfile::tempdir().unwrap();
        sqlx::query("INSERT INTO agent_setting (agent_type, env_json) VALUES ('claude_code', ?)")
            .bind(r#"{"ANTHROPIC_API_KEY":"sk-local-only","CUSTOM_VAR":"local"}"#)
            .execute(&pool)
            .await
            .unwrap();

        let rec = ProviderInstanceRecord::create(
            &pool,
            CreateProviderInstanceInput {
                id: None,
                agent_id: "claude_code",
                instance_id: "work-claude",
                display_name: "Work Claude",
                auth_mode: r#"{"mode":"OfficialOAuth"}"#,
                is_default: false,
            },
        )
        .await
        .unwrap();
        let agent_id = AgentId::parse("claude_code").unwrap();
        let dir = ensure_custom_instance_dirs_with_root(&agent_id, &rec.instance_id, Some(temp.path()))
            .unwrap();
        assert!(dir.join("claude-config").is_dir());
        assert!(dir.join("instance-env.json").is_file());
        assert!(dir.join("agent-model-providers.json").is_file());

        let env = scoped_custom_environment_with_root(&rec, &agent_id, Some(temp.path()))
            .await
            .unwrap();
        assert!(!env.contains_key("ANTHROPIC_API_KEY"));
        assert!(!env.contains_key("CUSTOM_VAR"));
        assert_eq!(
            env.get("CLAUDE_CONFIG_DIR").map(String::as_str),
            Some(dir.join("claude-config").to_string_lossy().as_ref())
        );

        let mut next = env.clone();
        next.insert("CLAUDE_AUTH_MODE".to_string(), "official_api".to_string());
        persist_custom_environment_with_root(&rec, &agent_id, &next, Some(temp.path()))
            .await
            .unwrap();

        // Implicit directory keys are stripped from instance-env.json and local agent_setting stays untouched.
        let saved_json: HashMap<String, String> = serde_json::from_str(
            &std::fs::read_to_string(dir.join("instance-env.json")).unwrap(),
        )
        .unwrap();
        assert!(!saved_json.contains_key("CLAUDE_CONFIG_DIR"));
        assert_eq!(saved_json.get("CLAUDE_AUTH_MODE").map(String::as_str), Some("official_api"));

        let local_env = read_agent_environment(&pool, &agent_id).await.unwrap();
        assert_eq!(
            local_env.get("ANTHROPIC_API_KEY").map(String::as_str),
            Some("sk-local-only")
        );
    }
}
