use std::{collections::HashMap, path::PathBuf, sync::Arc};

use agents::{AgentId, BuiltInProfileCatalog, NativeConfigProvider, TokioNativeFileSystem};
use api_types::{
    AgentAuthenticationStatus, AgentModelProviderImportRequest, AgentModelProviderImportSource,
    AgentModelProviderSaveRequest, AgentNativeConfigFieldKind, AgentNativeConfigFieldView,
    AgentNativeConfigFileView, AgentNativeConfigFormat, AgentNativeConfigOptionView,
    AgentNativeConfigSurface, AgentNativeConfigView, CodexModelCatalogConfigRequest,
    DshProviderSaveRequest, OpenCodeProviderConnectRequest, PiCredentialsSaveRequest,
    PiRuntimeSaveRequest,
};
use application::ApplicationError;
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::Value;
use sqlx::SqlitePool;

use super::{
    management,
    native::{
        self, apply_native_file_mutations, catalog_cache_dir, codex_device_auth, dsh_configuration,
        grok_plugins, json_document_mutation, model_catalogs, model_provider_import,
        model_providers, opencode_catalog, opencode_plugins, opencode_providers, pi_configuration,
        pi_plugins, provider_store_path, read_json_object_or_empty, read_json_object_state,
        resolve_agent_home,
    },
};
use crate::domains::{internal_error, parse, serialize};

fn bad(message: impl Into<String>) -> ApplicationError {
    ApplicationError::bad_request(message.into())
}

fn parse_request<T: DeserializeOwned>(args: Value) -> Result<T, ApplicationError> {
    if let Some(request) = args.get("request").cloned()
        && !request.is_null()
    {
        return parse(request);
    }
    parse(args)
}

fn require_home() -> Result<PathBuf, ApplicationError> {
    dirs::home_dir().ok_or_else(|| ApplicationError::internal("home directory missing"))
}

async fn env_for(
    pool: &SqlitePool,
    agent_id: &AgentId,
) -> Result<HashMap<String, String>, ApplicationError> {
    management::read_agent_environment(pool, agent_id).await
}

fn invalidate(channel: &str) {
    crate::host::events::global_host_events().emit(channel, ());
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentIdArgs {
    agent_id: AgentId,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogArgs {
    agent_id: AgentId,
    provider_id: Option<String>,
    api_url: Option<String>,
    api_key: Option<String>,
    force_refresh: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KimiCatalogArgs {
    base_url: String,
    api_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DevicePollArgs {
    device_auth_id: String,
    user_code: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginSpecArgs {
    spec: Option<String>,
    name: Option<String>,
    names: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderIdArgs {
    provider_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenCodeEnabledArgs {
    provider_id: String,
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DshDiscoverArgs {
    base_url: String,
    api_key: Option<String>,
    provider_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandArgs {
    command: String,
}

pub async fn dispatch_codex_request_device_code() -> Result<Value, ApplicationError> {
    serialize(
        codex_device_auth::request_device_code()
            .await
            .map_err(bad)?,
    )
}

pub async fn dispatch_codex_poll_device_code(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: DevicePollArgs = parse(args)?;
    let agent_id = AgentId::parse("codex").map_err(internal_error)?;
    let env = env_for(pool, &agent_id).await?;
    let home = require_home()?;
    let codex_home = resolve_agent_home(&home, &env, "CODEX_HOME", ".codex");
    let result =
        codex_device_auth::poll_device_code(&codex_home, args.device_auth_id, args.user_code)
            .await
            .map_err(bad)?;
    if result.status == "success" {
        services::services::agent_management::AgentManagementApplicationService::new(pool.clone())
            .sync_authentication(&agent_id, AgentAuthenticationStatus::Account, None)
            .await
            .map_err(internal_error)?;
        invalidate("agent-management-snapshot-invalidated");
    }
    serialize(result)
}

pub async fn dispatch_model_catalog(
    pool: &SqlitePool,
    command: &str,
    args: Value,
) -> Result<Value, ApplicationError> {
    match command {
        "cursor_model_catalog" => {
            let agent_id = AgentId::parse("cursor").map_err(internal_error)?;
            let env = env_for(pool, &agent_id).await?;
            let program =
                management::resolve_management_program(pool, &agent_id, "cursor-agent", &env)
                    .await
                    .ok_or_else(|| bad("未找到 cursor-agent；请先安装或修复 Cursor。"))?;
            serialize(
                model_catalogs::cursor(&program, env.get("CURSOR_API_KEY").map(String::as_str))
                    .await
                    .map_err(bad)?,
            )
        }
        "kimi_model_catalog" => {
            let args: KimiCatalogArgs = parse(args)?;
            serialize(
                model_catalogs::kimi(&args.base_url, &args.api_key)
                    .await
                    .map_err(bad)?,
            )
        }
        "codex_model_catalog" => {
            let args: CatalogArgs = parse(args).unwrap_or(CatalogArgs {
                agent_id: AgentId::parse("codex").map_err(internal_error)?,
                provider_id: None,
                api_url: None,
                api_key: None,
                force_refresh: Some(false),
            });
            let agent_id = AgentId::parse("codex").map_err(internal_error)?;
            let env = env_for(pool, &agent_id).await?;
            let program =
                management::resolve_management_program(pool, &agent_id, "codex", &env).await;
            let cache_path = catalog_cache_dir().join("codex-bundled.json");
            serialize(
                model_catalogs::codex(
                    program.as_deref(),
                    &cache_path,
                    args.force_refresh.unwrap_or(false),
                )
                .await,
            )
        }
        _ => {
            let args: CatalogArgs = parse(args)?;
            let store = provider_store_path();
            let home = require_home()?;
            let env = env_for(pool, &args.agent_id).await?;
            let api_url = args.api_url.unwrap_or_default();
            let api_key = model_providers::resolve_probe_api_key_from(
                &store,
                &args.agent_id,
                args.provider_id.as_deref(),
                args.api_key.as_deref(),
                Some(&home),
                Some(&env),
            )
            .await
            .map_err(bad)?;
            serialize(
                model_catalogs::provider(args.agent_id, &api_url, &api_key)
                    .await
                    .map_err(bad)?,
            )
        }
    }
}

pub async fn dispatch_codex_catalog_config(pool: &SqlitePool) -> Result<Value, ApplicationError> {
    let agent_id = AgentId::parse("codex").map_err(internal_error)?;
    let env = env_for(pool, &agent_id).await?;
    let home = require_home()?;
    let codex_home = resolve_agent_home(&home, &env, "CODEX_HOME", ".codex");
    serialize(
        model_catalogs::load_codex_config(&codex_home)
            .await
            .map_err(bad)?,
    )
}

pub async fn dispatch_codex_catalog_apply(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    let request: CodexModelCatalogConfigRequest = parse(args)?;
    let agent_id = AgentId::parse("codex").map_err(internal_error)?;
    let env = env_for(pool, &agent_id).await?;
    let program = management::resolve_management_program(pool, &agent_id, "codex", &env).await;
    let cache_path = catalog_cache_dir().join("codex-bundled.json");
    let official = model_catalogs::codex_official_document(program.as_deref(), &cache_path)
        .await
        .map_err(bad)?;
    let home = require_home()?;
    let codex_home = resolve_agent_home(&home, &env, "CODEX_HOME", ".codex");
    let result = model_catalogs::apply_codex_config(&codex_home, &official, request)
        .await
        .map_err(bad)?;
    invalidate("agent-management-snapshot-invalidated");
    serialize(result)
}

pub async fn dispatch_model_providers(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: AgentIdArgs = parse(args)?;
    let home = require_home()?;
    let env = env_for(pool, &args.agent_id).await?;
    let native_home = native_home_for(&home, &env, &args.agent_id);
    serialize(
        model_providers::list_with_native(
            &provider_store_path(),
            args.agent_id,
            Some(&native_home),
        )
        .await
        .map_err(bad)?,
    )
}

pub async fn dispatch_model_provider_save(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    let request: AgentModelProviderSaveRequest = parse(args)?;
    let home = require_home()?;
    let env = env_for(pool, &request.agent_id).await?;
    let _native_home = native_home_for(&home, &env, &request.agent_id);
    let view = model_providers::save(&provider_store_path(), &home, &env, request)
        .await
        .map_err(bad)?;
    invalidate("agent-management-snapshot-invalidated");
    serialize(view)
}

pub async fn dispatch_model_provider_delete(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct DeleteArgs {
        agent_id: AgentId,
        provider_id: String,
    }
    let args: DeleteArgs = parse(args)?;
    let home = require_home()?;
    let env = env_for(pool, &args.agent_id).await?;
    let _native_home = native_home_for(&home, &env, &args.agent_id);
    let view = model_providers::delete(
        &provider_store_path(),
        &home,
        &env,
        args.agent_id,
        &args.provider_id,
    )
    .await
    .map_err(bad)?;
    invalidate("agent-management-snapshot-invalidated");
    serialize(view)
}

pub async fn dispatch_model_provider_bind(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct BindArgs {
        agent_id: AgentId,
        provider_id: String,
    }
    let args: BindArgs = parse(args)?;
    let home = require_home()?;
    let env = env_for(pool, &args.agent_id).await?;
    let _native_home = native_home_for(&home, &env, &args.agent_id);
    let view = model_providers::bind(
        &provider_store_path(),
        &home,
        &env,
        args.agent_id,
        Some(args.provider_id),
    )
    .await
    .map_err(bad)?;
    invalidate("agent-management-snapshot-invalidated");
    serialize(view)
}

pub async fn dispatch_model_provider_probe(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    dispatch_model_catalog(pool, "agent_model_provider_catalog", args).await
}

pub async fn dispatch_model_provider_import_preview(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    let request: AgentModelProviderImportRequest = parse(args)?;
    let home = require_home()?;
    let env = env_for(pool, &request.agent_id).await?;
    serialize(
        model_providers::preview_import(
            &provider_store_path(),
            &home,
            &env,
            request.agent_id,
            request.source,
        )
        .await
        .map_err(bad)?,
    )
}

pub async fn dispatch_model_provider_import(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    let request: AgentModelProviderImportRequest = parse(args)?;
    let home = require_home()?;
    let env = env_for(pool, &request.agent_id).await?;
    let view = model_providers::apply_import(
        &provider_store_path(),
        &home,
        &env,
        request.agent_id,
        request.source,
        &request.source_ids,
    )
    .await
    .map_err(bad)?;
    invalidate("agent-management-snapshot-invalidated");
    serialize(view)
}

pub async fn dispatch_pi_configuration(pool: &SqlitePool) -> Result<Value, ApplicationError> {
    let home = require_home()?;
    serialize(pi_configuration::load(pool, &home).await.map_err(bad)?)
}

pub async fn dispatch_pi_credentials_save(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    let request: PiCredentialsSaveRequest = parse(args)?;
    let home = require_home()?;
    let view = pi_configuration::save_credentials(pool, &home, request)
        .await
        .map_err(bad)?;
    invalidate("agent-management-snapshot-invalidated");
    serialize(view)
}

pub async fn dispatch_pi_runtime_save(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    let request: PiRuntimeSaveRequest = parse(args)?;
    pi_configuration::save_runtime(pool, request)
        .await
        .map_err(bad)?;
    invalidate("agent-management-snapshot-invalidated");
    Ok(Value::Null)
}

pub async fn dispatch_pi_command_validate(args: Value) -> Result<Value, ApplicationError> {
    let args: CommandArgs = parse(args)?;
    serialize(pi_configuration::validate_command(&args.command).await)
}

pub async fn dispatch_pi_plugins(pool: &SqlitePool) -> Result<Value, ApplicationError> {
    let home = require_home()?;
    serialize(pi_plugins::list_plugins(pool, &home).await.map_err(bad)?)
}

pub async fn dispatch_pi_plugin_add(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: PluginSpecArgs = parse(args)?;
    let spec = args
        .spec
        .or(args.name)
        .ok_or_else(|| bad("缺少插件 spec"))?;
    let home = require_home()?;
    let view = pi_plugins::add_plugin(pool, &home, &spec)
        .await
        .map_err(bad)?;
    invalidate("agent-management-snapshot-invalidated");
    serialize(view)
}

pub async fn dispatch_pi_plugin_remove(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: PluginSpecArgs = parse(args)?;
    let spec = args
        .spec
        .or(args.name)
        .ok_or_else(|| bad("缺少插件 spec"))?;
    let home = require_home()?;
    let view = pi_plugins::remove_plugin(pool, &home, &spec)
        .await
        .map_err(bad)?;
    invalidate("agent-management-snapshot-invalidated");
    serialize(view)
}

pub async fn dispatch_dsh_providers(pool: &SqlitePool) -> Result<Value, ApplicationError> {
    let agent_id = AgentId::parse("deepseek_harness").map_err(internal_error)?;
    let env = env_for(pool, &agent_id).await?;
    let home = require_home()?;
    let paths = dsh_configuration::resolve_paths(&home, &env);
    serialize(
        dsh_configuration::load_providers(
            &paths,
            env.get(dsh_configuration::ACP_PROVIDER_ENV)
                .map(String::as_str),
            env.get(dsh_configuration::ACP_MODEL_ENV)
                .map(String::as_str),
        )
        .map_err(bad)?,
    )
}

pub async fn dispatch_dsh_provider_save(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    let request: DshProviderSaveRequest = parse(args)?;
    let agent_id = AgentId::parse("deepseek_harness").map_err(internal_error)?;
    let env = env_for(pool, &agent_id).await?;
    let home = require_home()?;
    let paths = dsh_configuration::resolve_paths(&home, &env);
    let (view, mutations) = dsh_configuration::save_provider(&paths, request).map_err(bad)?;
    apply_native_file_mutations(&mutations).await.map_err(bad)?;
    invalidate("agent-management-snapshot-invalidated");
    serialize(view)
}

pub async fn dispatch_dsh_provider_delete(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: ProviderIdArgs = parse(args)?;
    let agent_id = AgentId::parse("deepseek_harness").map_err(internal_error)?;
    let env = env_for(pool, &agent_id).await?;
    let home = require_home()?;
    let paths = dsh_configuration::resolve_paths(&home, &env);
    let (view, mutations) =
        dsh_configuration::delete_provider(&paths, &args.provider_id).map_err(bad)?;
    apply_native_file_mutations(&mutations).await.map_err(bad)?;
    invalidate("agent-management-snapshot-invalidated");
    serialize(view)
}

pub async fn dispatch_dsh_provider_discover(args: Value) -> Result<Value, ApplicationError> {
    let args: DshDiscoverArgs = parse(args)?;
    let home = require_home()?;
    let paths = dsh_configuration::resolve_paths(&home, &HashMap::new());
    serialize(
        dsh_configuration::discover_models(
            &paths,
            &args.base_url,
            args.api_key.as_deref(),
            args.provider_id.as_deref(),
        )
        .await
        .map_err(bad)?,
    )
}

pub async fn dispatch_dsh_plugins(pool: &SqlitePool) -> Result<Value, ApplicationError> {
    let agent_id = AgentId::parse("deepseek_harness").map_err(internal_error)?;
    let env = env_for(pool, &agent_id).await?;
    let home = require_home()?;
    let paths = dsh_configuration::resolve_paths(&home, &env);
    serialize(dsh_configuration::load_plugins(&paths).map_err(bad)?)
}

pub async fn dispatch_dsh_plugin_add(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: PluginSpecArgs = parse(args)?;
    let spec = args.spec.or(args.name).ok_or_else(|| bad("缺少插件"))?;
    let agent_id = AgentId::parse("deepseek_harness").map_err(internal_error)?;
    let env = env_for(pool, &agent_id).await?;
    let home = require_home()?;
    let paths = dsh_configuration::resolve_paths(&home, &env);
    let view = dsh_configuration::add_plugin(&paths, &spec)
        .await
        .map_err(bad)?;
    invalidate("agent-management-snapshot-invalidated");
    serialize(view)
}

pub async fn dispatch_dsh_plugin_remove(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: PluginSpecArgs = parse(args)?;
    let spec = args.spec.or(args.name).ok_or_else(|| bad("缺少插件"))?;
    let agent_id = AgentId::parse("deepseek_harness").map_err(internal_error)?;
    let env = env_for(pool, &agent_id).await?;
    let home = require_home()?;
    let paths = dsh_configuration::resolve_paths(&home, &env);
    let view = dsh_configuration::remove_plugin(&paths, &spec)
        .await
        .map_err(bad)?;
    invalidate("agent-management-snapshot-invalidated");
    serialize(view)
}

pub async fn dispatch_grok_plugins(pool: &SqlitePool) -> Result<Value, ApplicationError> {
    let agent_id = AgentId::parse("grok").map_err(internal_error)?;
    let env = env_for(pool, &agent_id).await?;
    let home = require_home()?;
    serialize(grok_plugins::list_plugins(&home, &env).await.map_err(bad)?)
}

pub async fn dispatch_grok_plugin_add(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: PluginSpecArgs = parse(args)?;
    let spec = args.spec.or(args.name).ok_or_else(|| bad("缺少插件"))?;
    let agent_id = AgentId::parse("grok").map_err(internal_error)?;
    let env = env_for(pool, &agent_id).await?;
    let home = require_home()?;
    let view = grok_plugins::add_plugin(&home, &env, &spec)
        .await
        .map_err(bad)?;
    invalidate("agent-management-snapshot-invalidated");
    serialize(view)
}

pub async fn dispatch_grok_plugin_remove(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: PluginSpecArgs = parse(args)?;
    let spec = args.spec.or(args.name).ok_or_else(|| bad("缺少插件"))?;
    let agent_id = AgentId::parse("grok").map_err(internal_error)?;
    let env = env_for(pool, &agent_id).await?;
    let home = require_home()?;
    let view = grok_plugins::remove_plugin(&home, &env, &spec)
        .await
        .map_err(bad)?;
    invalidate("agent-management-snapshot-invalidated");
    serialize(view)
}

pub async fn dispatch_opencode_plugin_list(pool: &SqlitePool) -> Result<Value, ApplicationError> {
    let paths = opencode_paths(pool).await?;
    serialize(opencode_plugins::check_plugins(&paths.config_path, &paths.cache_dir).map_err(bad)?)
}

pub async fn dispatch_opencode_plugin_install(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: PluginSpecArgs = parse(args).unwrap_or(PluginSpecArgs {
        spec: None,
        name: None,
        names: None,
    });
    let paths = opencode_paths(pool).await?;
    let view = opencode_plugins::install_missing(paths.config_path, paths.cache_dir, args.names)
        .await
        .map_err(bad)?;
    invalidate("agent-management-snapshot-invalidated");
    serialize(view)
}

pub async fn dispatch_opencode_plugin_add(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: PluginSpecArgs = parse(args)?;
    let spec = args
        .spec
        .or(args.name)
        .ok_or_else(|| bad("缺少插件 spec"))?;
    let paths = opencode_paths(pool).await?;
    let view = opencode_plugins::add_plugin(paths.config_path, paths.cache_dir, spec)
        .await
        .map_err(bad)?;
    invalidate("agent-management-snapshot-invalidated");
    serialize(view)
}

pub async fn dispatch_opencode_plugin_uninstall(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: PluginSpecArgs = parse(args)?;
    let name = args.name.or(args.spec).ok_or_else(|| bad("缺少插件名"))?;
    let paths = opencode_paths(pool).await?;
    let view = opencode_plugins::uninstall(paths.config_path, paths.cache_dir, name)
        .await
        .map_err(bad)?;
    invalidate("agent-management-snapshot-invalidated");
    serialize(view)
}

pub async fn dispatch_opencode_provider_catalog(args: Value) -> Result<Value, ApplicationError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Refresh {
        force_refresh: Option<bool>,
    }
    let args: Refresh = parse(args).unwrap_or(Refresh {
        force_refresh: Some(false),
    });
    serialize(
        opencode_catalog::provider_catalog(
            &utils::assets::host_data_dir(),
            args.force_refresh.unwrap_or(false),
        )
        .await,
    )
}

pub async fn dispatch_opencode_provider_connections(
    pool: &SqlitePool,
) -> Result<Value, ApplicationError> {
    let (auth, config) = load_opencode_documents(pool).await?;
    serialize(opencode_providers::project_opencode_provider_connections(
        &auth, &config,
    ))
}

pub async fn dispatch_opencode_provider_connect(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    let request: OpenCodeProviderConnectRequest = parse_request(args)?;
    mutate_opencode_documents(pool, |auth, config| {
        opencode_providers::apply_opencode_provider_connection(auth, config, &request)
    })
    .await
}

pub async fn dispatch_opencode_provider_disconnect(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ProviderIdArgs {
        provider_id: String,
    }
    let args: ProviderIdArgs = parse(args)?;
    mutate_opencode_documents(pool, |auth, config| {
        opencode_providers::disconnect_opencode_provider(auth, config, &args.provider_id)
    })
    .await
}

pub async fn dispatch_opencode_provider_set_enabled(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SetEnabledArgs {
        provider_id: String,
        enabled: bool,
    }
    let args: SetEnabledArgs = parse(args)?;
    opencode_providers::validate_opencode_provider_id(&args.provider_id).map_err(bad)?;
    mutate_opencode_documents(pool, |auth, config| {
        if !opencode_providers::provider_exists(auth, config, &args.provider_id) {
            return Err("OpenCode Provider 不存在".to_string());
        }
        opencode_providers::set_opencode_provider_enabled(config, &args.provider_id, args.enabled)
    })
    .await
}

pub async fn dispatch_opencode_provider_import(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    let request: AgentModelProviderImportRequest = parse_request(args)?;
    let home = require_home()?;
    let agent_id = AgentId::parse("opencode").map_err(internal_error)?;
    let selected: std::collections::HashSet<&str> =
        request.source_ids.iter().map(String::as_str).collect();
    let drafts = match request.source {
        AgentModelProviderImportSource::CcSwitch => {
            model_provider_import::preview_cc_switch(&home, &agent_id, &[])
                .await
                .1
        }
        AgentModelProviderImportSource::Native => Vec::new(),
    };
    mutate_opencode_documents(pool, |auth, config| {
        for draft in &drafts {
            if !selected.contains(draft.source_id.as_str()) || draft.skip_reason.is_some() {
                continue;
            }
            let model = serde_json::from_str::<Value>(&draft.model).ok();
            let provider_id = model
                .as_ref()
                .and_then(|value| value.get("id"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| opencode_providers::slug_provider_id(&draft.name));
            let npm = model
                .as_ref()
                .and_then(|value| value.get("npm"))
                .and_then(Value::as_str)
                .map(str::to_string);
            opencode_providers::apply_opencode_provider_connection(
                auth,
                config,
                &OpenCodeProviderConnectRequest {
                    provider_id,
                    name: draft.name.clone(),
                    npm,
                    api: None,
                    base_url: Some(draft.api_url.clone()).filter(|value| !value.is_empty()),
                    api_key: Some(draft.api_key.clone()).filter(|value| !value.is_empty()),
                    models: Vec::new(),
                    enabled: true,
                },
            )?;
        }
        Ok(())
    })
    .await
}

async fn load_opencode_documents(pool: &SqlitePool) -> Result<(Value, Value), ApplicationError> {
    let paths = opencode_paths(pool).await?;
    let auth = read_json_object_or_empty(&paths.auth_path)
        .await
        .map_err(bad)?;
    let config = read_json_object_or_empty(&paths.config_path)
        .await
        .map_err(bad)?;
    Ok((auth, config))
}

async fn mutate_opencode_documents(
    pool: &SqlitePool,
    mutate: impl FnOnce(&mut Value, &mut Value) -> Result<(), String>,
) -> Result<Value, ApplicationError> {
    let paths = opencode_paths(pool).await?;
    let (mut auth, auth_original) = read_json_object_state(&paths.auth_path)
        .await
        .map_err(bad)?;
    let (mut config, config_original) = read_json_object_state(&paths.config_path)
        .await
        .map_err(bad)?;
    mutate(&mut auth, &mut config).map_err(bad)?;
    apply_native_file_mutations(&[
        json_document_mutation(&paths.auth_path, auth_original, &auth, true).map_err(bad)?,
        json_document_mutation(&paths.config_path, config_original, &config, false).map_err(bad)?,
    ])
    .await
    .map_err(bad)?;
    invalidate("agent-management-snapshot-invalidated");
    serialize(opencode_providers::project_opencode_provider_connections(
        &auth, &config,
    ))
}

pub async fn dispatch_native_config_read(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: AgentIdArgs = parse(args)?;
    serialize(native_config_view(pool, args.agent_id).await?)
}

pub async fn dispatch_native_config_write(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    let request: api_types::AgentNativeConfigPatchRequest = parse(args)?;
    let home = require_home()?;
    let env = env_for(pool, &request.agent_id).await?;
    let recorded = sqlx::query_scalar::<_, String>(
        "SELECT authentication FROM agent_probe WHERE agent_id = ?",
    )
    .bind(request.agent_id.as_str())
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    let logged_in = recorded.as_deref() == Some("account");
    let provider = NativeConfigProvider::with_environment(
        Arc::new(TokioNativeFileSystem),
        home,
        env.into_iter().collect(),
    );
    let patch = agents::NativeConfigPatch {
        base_field_revisions: request.base_field_revisions,
        values: request.fields,
    };
    let result = provider
        .save(&request.agent_id, patch, logged_in)
        .await
        .map_err(|error| bad(error.to_string()))?;
    invalidate("agent-management-snapshot-invalidated");
    serialize(map_native_config_view(request.agent_id, result.snapshot))
}

pub async fn dispatch_native_config_file_write(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    let request: api_types::AgentNativeConfigFileWriteRequest = parse(args)?;
    let home = require_home()?;
    let env = env_for(pool, &request.agent_id).await?;
    let recorded = sqlx::query_scalar::<_, String>(
        "SELECT authentication FROM agent_probe WHERE agent_id = ?",
    )
    .bind(request.agent_id.as_str())
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    let logged_in = recorded.as_deref() == Some("account");
    let provider = NativeConfigProvider::with_environment(
        Arc::new(TokioNativeFileSystem),
        home,
        env.into_iter().collect(),
    );
    let result = provider
        .save_file(
            &request.agent_id,
            agents::NativeConfigFilePatch {
                path: PathBuf::from(&request.path),
                base_revision: request.base_revision,
                content: request.content,
            },
            logged_in,
        )
        .await
        .map_err(|error| bad(error.to_string()))?;
    invalidate("agent-management-snapshot-invalidated");
    serialize(map_native_config_view(request.agent_id, result.snapshot))
}

async fn native_config_view(
    pool: &SqlitePool,
    agent_id: AgentId,
) -> Result<AgentNativeConfigView, ApplicationError> {
    let home = require_home()?;
    let env = env_for(pool, &agent_id).await?;
    let recorded = sqlx::query_scalar::<_, String>(
        "SELECT authentication FROM agent_probe WHERE agent_id = ?",
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    let logged_in = recorded.as_deref() == Some("account");
    let provider = NativeConfigProvider::with_environment(
        Arc::new(TokioNativeFileSystem),
        home,
        env.into_iter().collect(),
    );
    match provider.read(&agent_id, logged_in).await {
        Ok(snapshot) => Ok(map_native_config_view(agent_id, snapshot)),
        Err(agents::NativeConfigError::Unsupported(_)) => Ok(AgentNativeConfigView {
            agent_id,
            available: false,
            settings_features: Vec::new(),
            path: None,
            paths: Vec::new(),
            fields: Vec::new(),
            files: Vec::new(),
            applies_to_next_session: true,
        }),
        Err(error) => Err(internal_error(error)),
    }
}

fn map_native_config_view(
    agent_id: AgentId,
    snapshot: agents::NativeConfigSnapshot,
) -> AgentNativeConfigView {
    let settings_features = BuiltInProfileCatalog::bundled()
        .profile(&agent_id)
        .map(|profile| profile.settings_features.to_vec())
        .unwrap_or_default();
    AgentNativeConfigView {
        agent_id,
        available: true,
        settings_features,
        path: Some(snapshot.path.display().to_string()),
        paths: snapshot
            .paths
            .iter()
            .map(|path| path.display().to_string())
            .collect(),
        fields: snapshot
            .fields
            .into_iter()
            .map(|field| AgentNativeConfigFieldView {
                id: field.field_id,
                label: field.label,
                description: field.description,
                kind: match field.kind {
                    agents::NativeConfigFieldKind::Text => AgentNativeConfigFieldKind::Text,
                    agents::NativeConfigFieldKind::Secret => AgentNativeConfigFieldKind::Secret,
                    agents::NativeConfigFieldKind::Select => AgentNativeConfigFieldKind::Select,
                    agents::NativeConfigFieldKind::Boolean => AgentNativeConfigFieldKind::Boolean,
                    agents::NativeConfigFieldKind::Number => AgentNativeConfigFieldKind::Number,
                    agents::NativeConfigFieldKind::Json => AgentNativeConfigFieldKind::Json,
                },
                options: field
                    .options
                    .into_iter()
                    .map(|(value, label)| AgentNativeConfigOptionView { value, label })
                    .collect(),
                secret: field.secret,
                path: field.path.display().to_string(),
                present: field.present,
                value: field.value,
                masked_value: field.masked_value,
                revision: field.revision,
                surface: match field.surface {
                    agents::NativeConfigSurface::Configuration => {
                        AgentNativeConfigSurface::Configuration
                    }
                    agents::NativeConfigSurface::Authentication => {
                        AgentNativeConfigSurface::Authentication
                    }
                },
            })
            .collect(),
        files: snapshot
            .files
            .into_iter()
            .map(|file| AgentNativeConfigFileView {
                path: file.path.display().to_string(),
                format: match file.format {
                    agents::NativeConfigFormat::Json => AgentNativeConfigFormat::Json,
                    agents::NativeConfigFormat::Toml => AgentNativeConfigFormat::Toml,
                    agents::NativeConfigFormat::Yaml => AgentNativeConfigFormat::Yaml,
                    agents::NativeConfigFormat::Dotenv => AgentNativeConfigFormat::Dotenv,
                },
                content: file.content,
                sensitive: file.sensitive,
                exists: file.exists,
                revision: file.revision,
            })
            .collect(),
        applies_to_next_session: true,
    }
}

fn native_home_for(
    home: &std::path::Path,
    env: &HashMap<String, String>,
    agent_id: &AgentId,
) -> PathBuf {
    match agent_id.as_str() {
        "codex" => resolve_agent_home(home, env, "CODEX_HOME", ".codex"),
        "claude_code" => resolve_agent_home(home, env, "CLAUDE_CONFIG_DIR", ".claude"),
        "pi" => resolve_agent_home(home, env, "PI_CODING_AGENT_DIR", ".pi"),
        "opencode" => resolve_agent_home(home, env, "OPENCODE_CONFIG_DIR", ".opencode"),
        "deepseek_harness" => resolve_agent_home(home, env, "DEEPSEEK_HOME", ".deepseek"),
        _ => home.to_path_buf(),
    }
}

struct OpenCodePaths {
    auth_path: PathBuf,
    config_path: PathBuf,
    cache_dir: PathBuf,
}

async fn opencode_paths(pool: &SqlitePool) -> Result<OpenCodePaths, ApplicationError> {
    let agent_id = AgentId::parse("opencode").map_err(internal_error)?;
    let env = env_for(pool, &agent_id).await?;
    let home = require_home()?;
    let cache_root = env
        .get("XDG_CACHE_HOME")
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".cache"));
    let config_dir =
        agents::metadata::opencode_config_dir().ok_or_else(|| bad("用户目录不可用"))?;
    let primary = config_dir.join("opencode.json");
    let legacy = config_dir.join("config.json");
    Ok(OpenCodePaths {
        auth_path: agents::metadata::opencode_auth_path().ok_or_else(|| bad("用户目录不可用"))?,
        config_path: if !primary.is_file() && legacy.is_file() {
            legacy
        } else {
            primary
        },
        cache_dir: cache_root.join("opencode"),
    })
}
