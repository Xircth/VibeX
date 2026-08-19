//! Unified Plugin control-plane IPC. Domain behavior remains in `crates/plugins`;
//! this module only maps stable DTOs and host-local paths.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::{self, Read},
    path::{Path, PathBuf},
    process::Stdio,
};

use plugins::NativePluginAdapter;
use serde::Serialize;
use tauri::{AppHandle, Manager, State, ipc::Channel};
use tokio::io::{AsyncBufReadExt as _, BufReader};
use ts_rs::TS;

use crate::{error::AppError, state::AppState};

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PluginControlCatalogDto {
    pub plugins: Vec<PluginControlItemDto>,
    pub runtimes: Vec<PluginRuntimeDto>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PluginProductDetailDto {
    pub summary: String,
    pub readme: String,
    pub contents: Vec<PluginContentDocumentDto>,
    pub config: serde_json::Value,
    pub config_schema: serde_json::Value,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PluginContentDocumentDto {
    pub path: String,
    pub kind: String,
    pub title: String,
    pub content: String,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PluginContributionCatalogDto {
    pub generation: u64,
    pub items: Vec<PluginContributionDto>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PluginContributionDto {
    pub plugin_id: String,
    pub id: String,
    pub kind: String,
    pub label: String,
    pub generation: u64,
    pub metadata: serde_json::Value,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ResolvedFileOpenerDto {
    pub plugin_id: String,
    pub contribution_id: String,
    pub label: String,
    pub handler: String,
    pub target: String,
    pub priority: i32,
    pub generation: u64,
    pub native_renderer: Option<String>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PluginFilePreviewStartDto {
    pub plugin_id: String,
    pub provider_id: String,
    pub generation: u64,
    pub lease_id: Option<String>,
    pub capability_token: Option<String>,
    pub expires_at_unix_ms: Option<i64>,
    pub port: Option<u16>,
    pub preview_url: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PluginControlItemDto {
    pub id: String,
    pub publisher: Option<String>,
    pub package_digest: Option<String>,
    pub update_package_digest: Option<String>,
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub enabled: bool,
    pub builtin: bool,
    pub source_kind: String,
    pub source_path: String,
    pub formats: Vec<String>,
    pub skills: Vec<PluginSkillDto>,
    pub runtimes: Vec<PluginRuntimeContributionDto>,
    pub warnings: Vec<PluginWarningDto>,
    pub permissions: Vec<PluginPermissionDto>,
    pub permission_delta: Vec<PluginPermissionDto>,
    pub mcp_count: u32,
    pub mcp_servers: Vec<String>,
    pub hooks: Vec<PluginNativeResourceDto>,
    pub workflows: Vec<PluginNativeResourceDto>,
    pub invocation_count: u32,
    pub invocations: Vec<PluginInvocationDto>,
    pub app_contributions: Vec<PluginAppContributionDto>,
    pub native_managed: bool,
    pub enable_supported: bool,
    pub update_supported: bool,
    pub rollback_supported: bool,
    pub uninstall_supported: bool,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PluginAppContributionDto {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub metadata: serde_json::Value,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PluginPermissionDto {
    pub id: String,
    pub capability: String,
    pub scope: serde_json::Value,
    pub reason: String,
    pub optional: bool,
    pub trust_tier: String,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PluginInvocationDto {
    pub id: String,
    pub label: String,
    pub prompt: String,
    pub kind: String,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PluginSkillDto {
    pub id: String,
    pub path: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PluginNativeResourceDto {
    pub id: String,
    pub path: String,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PluginControlContributionsDto {
    pub skills: Vec<PluginSkillContentDto>,
    pub mcp_servers: Vec<PluginMcpServerDto>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PluginSkillContentDto {
    pub id: String,
    pub path: String,
    pub content: String,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PluginMcpServerDto {
    pub id: String,
    pub config: serde_json::Value,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PluginRuntimeContributionDto {
    pub id: String,
    pub command: String,
    pub version: Option<String>,
    pub target: String,
    pub content_digest: String,
    pub installer: String,
    pub install_command: Option<String>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PluginRuntimeDto {
    pub id: String,
    pub version: String,
    pub target: String,
    pub content_digest: String,
    pub executable_path: String,
    pub ownership: String,
    pub installer: String,
    pub probe: Vec<String>,
    pub referenced_plugins: Vec<String>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PluginWarningDto {
    pub code: String,
    pub message: String,
    pub contribution: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "event",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum PluginCliImportEvent {
    Started {
        command: String,
    },
    Log {
        stream: String,
        line: String,
    },
    CommandFinished {
        command: String,
        success: bool,
        exit_code: Option<i32>,
    },
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PluginCliImportResultDto {
    pub success: bool,
    pub commands_run: u32,
    pub imported_plugin_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PluginImportPreviewDto {
    pub plugin: PluginControlItemDto,
    pub conflict: Option<PluginImportConflictDto>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PluginImportConflictDto {
    pub plugin_id: String,
    pub installed_source: String,
    pub incoming_source: String,
    pub installed_enabled: bool,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PluginAgentConfigurationDto {
    pub skill_projections: Vec<PluginSkillProjectionDto>,
    pub mcp_errors: Vec<String>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PluginMcpConfigurationDto {
    pub mcp_errors: Vec<String>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PluginSkillProjectionDto {
    pub skill_id: String,
    pub agent_id: String,
    pub status: String,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UnifiedPluginActionCatalogDto {
    pub actions: Vec<UnifiedPluginActionDto>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UnifiedPluginActionDto {
    pub plugin_id: String,
    pub action_id: String,
    pub label: String,
    pub required_skills: Vec<String>,
    pub required_tools: Vec<String>,
    pub prompt_blocks: Vec<UnifiedPromptBlockDto>,
    pub artifact_intent: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UnifiedPromptBlockDto {
    #[serde(rename = "type")]
    #[ts(rename = "type")]
    pub kind: &'static str,
    pub text: String,
}

#[tauri::command]
pub async fn plugin_action_catalog(
    state: State<'_, AppState>,
) -> Result<UnifiedPluginActionCatalogDto, AppError> {
    let inventory = state
        .plugin_control_plane
        .runtime_inventory()
        .await
        .map_err(plugin_error)?;
    let actions = state
        .plugin_control_plane
        .catalog()
        .await
        .map_err(plugin_error)?
        .into_iter()
        .filter(|plugin| plugin.activation == plugins::PluginActivation::Enabled)
        .filter(|plugin| {
            plugin.runtimes.iter().all(|required| {
                inventory.iter().any(|installed| {
                    installed.id == required.id
                        && required
                            .version
                            .as_deref()
                            .is_none_or(|version| version == installed.version)
                })
            })
        })
        .flat_map(|plugin| {
            let plugin_id = plugin.id().to_owned();
            let required_tools = plugin
                .runtimes
                .iter()
                .map(|runtime| runtime.id.clone())
                .collect::<Vec<_>>();
            plugin
                .package
                .invocations
                .into_iter()
                .filter(|invocation| invocation.kind == plugins::InvocationKind::Action)
                .map(move |invocation| UnifiedPluginActionDto {
                    plugin_id: plugin_id.clone(),
                    action_id: invocation.id,
                    label: invocation.label,
                    required_skills: if invocation.required_skills.is_empty() {
                        invocation.skill.into_iter().collect()
                    } else {
                        invocation.required_skills
                    },
                    required_tools: required_tools.clone(),
                    prompt_blocks: vec![UnifiedPromptBlockDto {
                        kind: "text",
                        text: invocation.prompt,
                    }],
                    artifact_intent: None,
                })
        })
        .collect();
    Ok(UnifiedPluginActionCatalogDto { actions })
}

#[tauri::command]
pub async fn plugin_control_catalog(
    state: State<'_, AppState>,
) -> Result<PluginControlCatalogDto, AppError> {
    let mut plugins = state
        .plugin_control_plane
        .catalog()
        .await
        .map_err(plugin_error)?
        .into_iter()
        .map(plugin_dto)
        .collect::<Vec<_>>();
    for plugin in &mut plugins {
        plugin.rollback_supported = state
            .plugin_control_plane
            .rollback_available(&plugin.id)
            .await
            .map_err(plugin_error)?;
    }
    for (adapter, format) in native_cli_adapters().await {
        let capabilities = adapter.capabilities();
        if let Ok(discovered) = adapter.discover().await {
            for native in discovered {
                if let Some(existing) = plugins.iter_mut().find(|plugin| plugin.id == native.id) {
                    if !existing.formats.iter().any(|item| item == format) {
                        existing.formats.push(format.to_owned());
                    }
                } else {
                    plugins.push(native_plugin_dto(native, format, capabilities));
                }
            }
        }
    }
    let runtimes = state
        .plugin_control_plane
        .runtime_inventory()
        .await
        .map_err(plugin_error)?
        .into_iter()
        .map(|runtime| PluginRuntimeDto {
            referenced_plugins: runtime.referenced_plugins,
            id: runtime.id,
            version: runtime.version,
            target: runtime.target,
            content_digest: runtime.content_digest,
            executable_path: runtime.executable_path.to_string_lossy().into_owned(),
            ownership: runtime.ownership,
            installer: runtime.installer,
            probe: runtime.probe,
        })
        .collect();
    Ok(PluginControlCatalogDto { plugins, runtimes })
}

pub(crate) async fn refresh_official_product_runtime(
    plane: &plugins::PluginControlPlane,
    broker: &delegation::DelegationBroker,
) -> Result<(), AppError> {
    plane
        .sync_official_product_mcp_gate()
        .await
        .map_err(plugin_error)?;
    let gate = plane.official_product_mcp_gate();

    if let Some(plugin) = plane
        .plugin(plugins::SESSION_ENHANCE_PLUGIN_ID)
        .await
        .map_err(plugin_error)?
        && let Ok(detail) = plugin.product_detail()
    {
        gate.set_session_features(session_enhance_feature_bits(&detail.config));
    }

    let mut config = broker.config_snapshot();
    config.enabled = gate.allow_delegation_mcp();
    if let Some(plugin) = plane
        .plugin(plugins::MULTI_AGENT_PLUGIN_ID)
        .await
        .map_err(plugin_error)?
        && let Ok(detail) = plugin.product_detail()
    {
        if let Some(depth) = detail
            .config
            .get("depthLimit")
            .and_then(serde_json::Value::as_u64)
        {
            config.depth_limit = depth as u32;
        }
        if let Some(mb) = detail
            .config
            .get("completedCacheMaxMb")
            .and_then(serde_json::Value::as_u64)
        {
            config.completed_cache_cap_bytes = mb.saturating_mul(1024 * 1024);
        }
        config.agent_defaults = parse_agent_defaults(detail.config.get("agentDefaults"));
    }
    broker.set_config(config);
    project_official_product_mcp(gate.as_ref()).await;
    Ok(())
}

async fn project_official_product_mcp(gate: &plugins::OfficialProductMcpGate) {
    let binary = crate::delegation::inject::locate_vibex_mcp_binary();
    let command = binary.to_string_lossy().into_owned();
    let url = gate.http_base();
    const DELEGATION_SERVER_ID: &str = "vibex.multi-agent.vibex-delegation-mcp";
    const SESSION_SERVER_ID: &str = "vibex.session-enhance.vibex-session-mcp";

    if let Some(url) = url.as_ref()
        && gate.allow_delegation_mcp()
        && let Some(token) = gate.delegation_token()
    {
        let _ = services::services::mcp::upsert_local_server(
            DELEGATION_SERVER_ID.to_string(),
            serde_json::json!({
                "type": "stdio",
                "command": command,
                "args": [
                    "--features",
                    "delegation",
                    "--server-url",
                    url,
                    "--product",
                    "delegation",
                    "--server-token",
                    token,
                ],
            }),
            true,
            Vec::new(),
        )
        .await;
    } else {
        let _ = services::services::mcp::uninstall_server(DELEGATION_SERVER_ID.to_string()).await;
    }

    if let Some(url) = url.as_ref()
        && gate.allow_session_mcp()
        && let Some(token) = gate.session_token()
    {
        let features = session_feature_arg(gate.session_features());
        let _ = services::services::mcp::upsert_local_server(
            SESSION_SERVER_ID.to_string(),
            serde_json::json!({
                "type": "stdio",
                "command": command,
                "args": [
                    "--features",
                    features,
                    "--server-url",
                    url,
                    "--product",
                    "session",
                    "--server-token",
                    token,
                ],
            }),
            true,
            Vec::new(),
        )
        .await;
    } else {
        let _ = services::services::mcp::uninstall_server(SESSION_SERVER_ID.to_string()).await;
    }
}

fn session_feature_arg(bits: u8) -> String {
    [
        (bits & plugins::SESSION_FEAT_FEEDBACK != 0, "feedback"),
        (bits & plugins::SESSION_FEAT_ASK != 0, "ask"),
        (bits & plugins::SESSION_FEAT_SESSIONS != 0, "sessions"),
        (
            bits & plugins::SESSION_FEAT_SESSION_CONTROL != 0,
            "session-control",
        ),
    ]
    .into_iter()
    .filter_map(|(enabled, name)| enabled.then_some(name))
    .collect::<Vec<_>>()
    .join(",")
}

fn parse_agent_defaults(
    value: Option<&serde_json::Value>,
) -> std::collections::BTreeMap<String, delegation::AgentDelegationDefaults> {
    let Some(object) = value.and_then(serde_json::Value::as_object) else {
        return std::collections::BTreeMap::new();
    };
    object
        .iter()
        .filter_map(|(agent_id, defaults)| {
            let record = defaults.as_object()?;
            let mode_id = record
                .get("modeId")
                .or_else(|| record.get("mode_id"))
                .and_then(serde_json::Value::as_str)
                .filter(|mode| !mode.is_empty())
                .map(str::to_string);
            let config_values = record
                .get("configValues")
                .or_else(|| record.get("config_values"))
                .and_then(serde_json::Value::as_object)
                .into_iter()
                .flatten()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| (key.clone(), value.to_string()))
                })
                .collect();
            Some((
                agent_id.clone(),
                delegation::AgentDelegationDefaults {
                    mode_id,
                    config_values,
                },
            ))
        })
        .collect()
}

fn session_enhance_feature_bits(config: &serde_json::Value) -> u8 {
    let mut bits = 0;
    if config.get("feedback").and_then(serde_json::Value::as_bool) != Some(false) {
        bits |= plugins::SESSION_FEAT_FEEDBACK;
    }
    if config.get("question").and_then(serde_json::Value::as_bool) != Some(false) {
        bits |= plugins::SESSION_FEAT_ASK;
    }
    if config
        .get("sessionInfo")
        .and_then(serde_json::Value::as_bool)
        != Some(false)
    {
        bits |= plugins::SESSION_FEAT_SESSIONS;
    }
    if config
        .get("sessionControl")
        .and_then(serde_json::Value::as_bool)
        != Some(false)
    {
        bits |= plugins::SESSION_FEAT_SESSION_CONTROL;
    }
    bits
}

async fn apply_official_product_runtime(state: &AppState) -> Result<(), AppError> {
    refresh_official_product_runtime(&state.plugin_control_plane, &state.delegation.broker).await
}

#[tauri::command]
pub async fn plugin_product_detail(
    state: State<'_, AppState>,
    plugin_id: String,
) -> Result<PluginProductDetailDto, AppError> {
    let plugin = state
        .plugin_control_plane
        .plugin(&plugin_id)
        .await
        .map_err(plugin_error)?
        .ok_or_else(|| AppError::NotFound(format!("plugin {plugin_id}")))?;
    product_detail_dto(plugin.product_detail().map_err(plugin_error)?)
}

#[tauri::command]
pub async fn plugin_save_config(
    state: State<'_, AppState>,
    plugin_id: String,
    config: serde_json::Value,
) -> Result<PluginProductDetailDto, AppError> {
    let plugin = state
        .plugin_control_plane
        .plugin(&plugin_id)
        .await
        .map_err(plugin_error)?
        .ok_or_else(|| AppError::NotFound(format!("plugin {plugin_id}")))?;
    plugin.write_config(config).map_err(plugin_error)?;
    apply_official_product_runtime(&state).await?;
    let refreshed = plugins::PluginPackage::inspect(&plugin.source.path, plugin.source.kind)
        .map_err(plugin_error)?;
    product_detail_dto(refreshed.product_detail().map_err(plugin_error)?)
}

fn product_detail_dto(
    detail: plugins::PluginProductDetail,
) -> Result<PluginProductDetailDto, AppError> {
    Ok(PluginProductDetailDto {
        summary: detail.summary,
        readme: detail.readme,
        contents: detail
            .contents
            .into_iter()
            .map(|item| PluginContentDocumentDto {
                path: item.path,
                kind: item.kind,
                title: item.title,
                content: item.content,
            })
            .collect(),
        config: detail.config,
        config_schema: detail.config_schema,
    })
}

#[tauri::command]
pub async fn plugin_contribution_catalog(
    state: State<'_, AppState>,
) -> Result<PluginContributionCatalogDto, AppError> {
    let catalog = state
        .plugin_control_plane
        .contributions()
        .await
        .map_err(plugin_error)?;
    Ok(PluginContributionCatalogDto {
        generation: catalog.generation,
        items: catalog
            .items
            .into_iter()
            .map(|item| PluginContributionDto {
                plugin_id: item.plugin_id,
                id: item.id,
                kind: contribution_kind_key(item.kind).to_owned(),
                label: item.label,
                generation: item.generation,
                metadata: item.metadata,
            })
            .collect(),
    })
}

#[tauri::command]
pub async fn plugin_resolve_file_opener(
    state: State<'_, AppState>,
    extension: Option<String>,
    media_type: Option<String>,
) -> Result<Option<ResolvedFileOpenerDto>, AppError> {
    state
        .plugin_control_plane
        .resolve_file_opener(extension.as_deref(), media_type.as_deref())
        .await
        .map_err(plugin_error)
        .map(|resolved| {
            resolved.map(|resolved| ResolvedFileOpenerDto {
                plugin_id: resolved.plugin_id,
                contribution_id: resolved.contribution_id,
                label: resolved.label,
                handler: resolved.handler,
                target: match resolved.target {
                    plugins::FileOpenerTarget::PreviewProvider => "preview_provider",
                    plugins::FileOpenerTarget::AppSurface => "app_surface",
                }
                .to_owned(),
                priority: resolved.priority,
                generation: resolved.generation,
                native_renderer: resolved.native_renderer,
            })
        })
}

#[tauri::command]
pub async fn plugin_open_file_preview(
    state: State<'_, AppState>,
    preview_proxy: State<'_, crate::plugin_dev_server::DesktopPreviewProxy>,
    file_path: String,
) -> Result<Option<PluginFilePreviewStartDto>, AppError> {
    let extension = Path::new(&file_path)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    let catalog = state
        .plugin_control_plane
        .contributions()
        .await
        .map_err(plugin_error)?;
    let Some(resolved) = state
        .plugin_control_plane
        .resolve_file_opener(extension.as_deref(), None)
        .await
        .map_err(plugin_error)?
    else {
        return Ok(None);
    };
    let opener = catalog.items.iter().find(|item| {
        item.plugin_id == resolved.plugin_id
            && item.id == resolved.contribution_id
            && item.kind == plugins::ContributionKind::FileOpener
    });
    let preview = catalog.items.iter().find(|item| {
        item.plugin_id == resolved.plugin_id
            && item.id == resolved.handler
            && item.kind == plugins::ContributionKind::PreviewProvider
    });
    let Some(preview) = preview else {
        return Err(AppError::Internal(format!(
            "preview provider `{}` disappeared from generation {}",
            resolved.handler, resolved.generation
        )));
    };
    let media_type = opener
        .and_then(|item| item.metadata.get("mediaTypes"))
        .and_then(serde_json::Value::as_array)
        .and_then(|items| items.first())
        .and_then(serde_json::Value::as_str)
        .unwrap_or("application/octet-stream")
        .to_owned();
    let provider_id = preview.id.clone();
    let plugin = state
        .plugin_control_plane
        .plugin(&resolved.plugin_id)
        .await
        .map_err(plugin_error)?
        .ok_or_else(|| AppError::Internal("resolved preview plugin disappeared".into()))?;
    let result = plugins::PluginArtifactPreviewService::new(
        state.plugin_control_plane.clone(),
        state.plugin_capability_broker.clone(),
    )
    .open(plugins::PluginPreviewRequest {
        file_path,
        media_type,
        plugin_id: resolved.plugin_id.clone(),
        plugin_version: plugin.version.clone(),
        provider_id: provider_id.clone(),
        generation: 0,
        package_digest: String::new(),
    })
    .await
    .map_err(|error| error.to_string());
    Ok(Some(match result {
        Ok(lease) => {
            let preview_url = preview_proxy
                .register(&lease)
                .await
                .map_err(|error| AppError::Internal(error.to_string()))?;
            PluginFilePreviewStartDto {
                plugin_id: resolved.plugin_id,
                provider_id,
                generation: resolved.generation,
                lease_id: Some(lease.lease_id),
                capability_token: Some(lease.capability_token),
                expires_at_unix_ms: Some(
                    i64::try_from(lease.expires_at_unix_ms).map_err(|_| {
                        AppError::Internal("preview lease expiry exceeds i64".into())
                    })?,
                ),
                port: Some(lease.loopback_port),
                preview_url: Some(preview_url),
                error_code: None,
                error_message: None,
            }
        }
        Err(error) => PluginFilePreviewStartDto {
            plugin_id: resolved.plugin_id,
            provider_id,
            generation: resolved.generation,
            lease_id: None,
            capability_token: None,
            expires_at_unix_ms: None,
            port: None,
            preview_url: None,
            error_code: Some("PREVIEW_WORKER_FAILED".to_owned()),
            error_message: Some(error),
        },
    }))
}

#[tauri::command]
pub async fn plugin_close_file_preview(
    state: State<'_, AppState>,
    preview_proxy: State<'_, crate::plugin_dev_server::DesktopPreviewProxy>,
    file_path: String,
    lease_id: Option<String>,
) -> Result<(), AppError> {
    if let Some(lease_id) = lease_id.as_deref() {
        preview_proxy.revoke(lease_id).await;
    }
    state
        .plugin_preview_host
        .close_preview(&file_path, lease_id.as_deref())
        .await
        .map_err(|error| AppError::Internal(error.to_string()))
}

fn contribution_kind_key(kind: plugins::ContributionKind) -> &'static str {
    match kind {
        plugins::ContributionKind::Skill => "skill",
        plugins::ContributionKind::Action => "action",
        plugins::ContributionKind::Command => "command",
        plugins::ContributionKind::Runtime => "runtime",
        plugins::ContributionKind::Mcp => "mcp",
        plugins::ContributionKind::FileOpener => "file_opener",
        plugins::ContributionKind::PreviewProvider => "preview_provider",
        plugins::ContributionKind::AppSurface => "app_surface",
    }
}

#[tauri::command]
pub async fn plugin_control_contributions(
    state: State<'_, AppState>,
    plugin_id: String,
) -> Result<PluginControlContributionsDto, AppError> {
    if let Some(plugin) = state
        .plugin_control_plane
        .plugin(&plugin_id)
        .await
        .map_err(plugin_error)?
    {
        let skills = plugin
            .skills
            .iter()
            .map(|skill| PluginSkillDto {
                id: skill.id.clone(),
                path: skill.path.clone(),
            })
            .collect::<Vec<_>>();
        return read_plugin_contributions(&plugin.source.path, &skills, Some(&plugin.mcp));
    }

    for (adapter, _) in native_cli_adapters().await {
        let Ok(discovered) = adapter.discover().await else {
            continue;
        };
        if let Some(plugin) = discovered.into_iter().find(|plugin| plugin.id == plugin_id) {
            let skills = discover_native_skills(&plugin.path);
            let mcp = read_native_mcp(&plugin.path)?;
            return read_plugin_contributions(&plugin.path, &skills, mcp.as_ref());
        }
    }

    Err(AppError::NotFound(plugin_id))
}

#[tauri::command]
pub async fn plugin_control_import_cli(
    ecosystem: String,
    command: String,
    on_event: Channel<PluginCliImportEvent>,
) -> Result<PluginCliImportResultDto, AppError> {
    let (ecosystem, program_name) = match ecosystem.as_str() {
        "codex" => (plugins::NativeEcosystem::Codex, "codex"),
        "claude_code" => (plugins::NativeEcosystem::ClaudeCode, "claude"),
        _ => {
            return Err(AppError::BadRequest(format!(
                "unsupported native plugin ecosystem `{ecosystem}`"
            )));
        }
    };
    let commands = plugins::parse_official_plugin_import_commands(ecosystem, &command)
        .map_err(plugin_error)?;
    let program = utils::shell::resolve_executable_path(program_name)
        .await
        .ok_or_else(|| {
            AppError::NotFound(format!(
                "official `{program_name}` executable was not found"
            ))
        })?;
    let adapter = match ecosystem {
        plugins::NativeEcosystem::Codex => plugins::OfficialCliNativePluginAdapter::codex(&program),
        plugins::NativeEcosystem::ClaudeCode => {
            plugins::OfficialCliNativePluginAdapter::claude_code(&program)
        }
    };
    let before = adapter
        .discover()
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|plugin| plugin.id)
        .collect::<BTreeSet<_>>();

    for parsed in &commands {
        run_official_import_command(&program, parsed, &on_event).await?;
    }

    let mut imported_plugin_ids = adapter
        .discover()
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|plugin| plugin.id)
        .filter(|plugin_id| !before.contains(plugin_id))
        .collect::<Vec<_>>();
    imported_plugin_ids.sort();
    Ok(PluginCliImportResultDto {
        success: true,
        commands_run: commands.len() as u32,
        imported_plugin_ids,
    })
}

async fn run_official_import_command(
    program: &Path,
    command: &plugins::NativePluginImportCommand,
    on_event: &Channel<PluginCliImportEvent>,
) -> Result<(), AppError> {
    let _ = on_event.send(PluginCliImportEvent::Started {
        command: command.display.clone(),
    });
    let mut child = utils::process::new_hidden_tokio_command(program, &command.args)
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| AppError::Internal(format!("start plugin import command: {error}")))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Internal("plugin import stdout was unavailable".to_owned()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Internal("plugin import stderr was unavailable".to_owned()))?;
    let mut stdout = BufReader::new(stdout).lines();
    let mut stderr = BufReader::new(stderr).lines();
    let mut stdout_done = false;
    let mut stderr_done = false;
    while !stdout_done || !stderr_done {
        tokio::select! {
            line = stdout.next_line(), if !stdout_done => match line {
                Ok(Some(line)) => {
                    let _ = on_event.send(PluginCliImportEvent::Log {
                        stream: "stdout".to_owned(),
                        line,
                    });
                }
                Ok(None) => stdout_done = true,
                Err(error) => return Err(AppError::Internal(format!("read plugin import stdout: {error}"))),
            },
            line = stderr.next_line(), if !stderr_done => match line {
                Ok(Some(line)) => {
                    let _ = on_event.send(PluginCliImportEvent::Log {
                        stream: "stderr".to_owned(),
                        line,
                    });
                }
                Ok(None) => stderr_done = true,
                Err(error) => return Err(AppError::Internal(format!("read plugin import stderr: {error}"))),
            },
        }
    }
    let status = child
        .wait()
        .await
        .map_err(|error| AppError::Internal(format!("wait for plugin import command: {error}")))?;
    let _ = on_event.send(PluginCliImportEvent::CommandFinished {
        command: command.display.clone(),
        success: status.success(),
        exit_code: status.code(),
    });
    if status.success() {
        Ok(())
    } else {
        Err(AppError::BadRequest(format!(
            "plugin import command exited with status {}",
            status
                .code()
                .map_or_else(|| "unknown".to_owned(), |code| code.to_string())
        )))
    }
}

#[tauri::command]
pub async fn plugin_control_preview_import(
    state: State<'_, AppState>,
    path: String,
    developer_link: bool,
    package_kind: Option<String>,
) -> Result<PluginImportPreviewDto, AppError> {
    let source_kind = if developer_link {
        plugins::PluginSourceKind::DeveloperLink
    } else {
        plugins::PluginSourceKind::Snapshot
    };
    let input = Path::new(&path);
    let extracted = if input.is_file() {
        if developer_link {
            return Err(AppError::BadRequest(
                "ZIP imports cannot use linked development mode".to_owned(),
            ));
        }
        Some(extract_plugin_archive(input)?)
    } else {
        None
    };
    let source = extracted
        .as_ref()
        .map(|archive| archive.root.as_path())
        .unwrap_or(input);
    validate_import_package_kind(source, package_kind.as_deref())?;
    if !source.join(".vibex-plugin/plugin.json").is_file() {
        let mut preview = preview_native_import(source, source_kind).await?;
        if extracted.is_some() {
            preview.plugin.source_path = path.clone();
            if let Some(conflict) = preview.conflict.as_mut() {
                conflict.incoming_source = path;
            }
        }
        return Ok(preview);
    }
    let package = plugins::PluginPackage::inspect(source, source_kind).map_err(plugin_error)?;
    let installed = state
        .plugin_control_plane
        .plugin(package.id.as_str())
        .await
        .map_err(plugin_error)?;
    let conflict = state
        .plugin_control_plane
        .preview_import(&package)
        .await
        .map_err(plugin_error)?
        .map(|conflict| PluginImportConflictDto {
            plugin_id: conflict.plugin_id,
            installed_source: conflict.installed_source.to_string_lossy().into_owned(),
            incoming_source: conflict.incoming_source.to_string_lossy().into_owned(),
            installed_enabled: installed
                .as_ref()
                .is_some_and(|plugin| plugin.activation == plugins::PluginActivation::Enabled),
        });
    let package_digest =
        plugins::package_content_digest(&package.source.path).map_err(plugin_error)?;
    let published_grants = if conflict.is_some() {
        state
            .plugin_control_plane
            .capability_grants(package.id.as_str())
            .await
            .map_err(plugin_error)?
    } else {
        Vec::new()
    };
    let permission_delta = package
        .permissions
        .iter()
        .filter(|permission| {
            !published_grants.iter().any(|grant| {
                grant.capability == permission.capability
                    && grant.scope == permission.scope
                    && grant.trust_tier == permission.trust_tier
            })
        })
        .map(permission_dto)
        .collect::<Vec<_>>();
    let update_package_digest = conflict.is_some().then(|| package_digest.clone());
    let mut preview = PluginImportPreviewDto {
        plugin: plugin_dto(plugins::InstalledPlugin {
            package,
            activation: plugins::PluginActivation::Disabled,
            package_digest,
        }),
        conflict,
    };
    preview.plugin.update_package_digest = update_package_digest;
    preview.plugin.permission_delta = permission_delta;
    if extracted.is_some() {
        preview.plugin.source_path = path.clone();
        if let Some(conflict) = preview.conflict.as_mut() {
            conflict.incoming_source = path;
        }
    }
    Ok(preview)
}

#[tauri::command]
pub async fn plugin_control_import(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    developer_link: bool,
    conflict_decision: String,
    package_kind: Option<String>,
    permission_ids: Vec<String>,
) -> Result<PluginControlItemDto, AppError> {
    let source_kind = if developer_link {
        plugins::PluginSourceKind::DeveloperLink
    } else {
        plugins::PluginSourceKind::Snapshot
    };
    let decision = parse_conflict_decision(&conflict_decision)?;
    let input = Path::new(&path);
    let extracted = if input.is_file() {
        if developer_link {
            return Err(AppError::BadRequest(
                "ZIP imports cannot use linked development mode".to_owned(),
            ));
        }
        Some(extract_plugin_archive(input)?)
    } else {
        None
    };
    let source = extracted
        .as_ref()
        .map(|archive| archive.root.as_path())
        .unwrap_or(input);
    validate_import_package_kind(source, package_kind.as_deref())?;
    if !source.join(".vibex-plugin/plugin.json").is_file() {
        return import_native_plugin(source, source_kind, decision).await;
    }
    let incoming = plugins::PluginPackage::inspect(source, source_kind).map_err(plugin_error)?;
    let installed = state
        .plugin_control_plane
        .plugin(incoming.id.as_str())
        .await
        .map_err(plugin_error)?;
    let published_grants = if installed.is_some() {
        state
            .plugin_control_plane
            .capability_grants(incoming.id.as_str())
            .await
            .map_err(plugin_error)?
    } else {
        Vec::new()
    };
    if installed.is_some() {
        match decision {
            plugins::ConflictDecision::Reject => {
                return Err(AppError::Conflict(format!(
                    "plugin `{}` is already installed",
                    incoming.id.as_str()
                )));
            }
            plugins::ConflictDecision::KeepInstalled => {
                return state
                    .plugin_control_plane
                    .plugin(incoming.id.as_str())
                    .await
                    .map_err(plugin_error)?
                    .map(plugin_dto)
                    .ok_or_else(|| AppError::NotFound(incoming.id.as_str().to_owned()));
            }
            plugins::ConflictDecision::Replace => {}
        }
    }
    let package = if developer_link {
        Ok(incoming)
    } else {
        let storage = plugin_snapshot_root(&app)?;
        plugins::PluginPackage::materialize(source, &storage, source_kind)
    }
    .map_err(plugin_error)?;
    let replacing_enabled = decision == plugins::ConflictDecision::Replace
        && installed
            .as_ref()
            .is_some_and(|plugin| plugin.activation == plugins::PluginActivation::Enabled);
    if replacing_enabled {
        let candidate_digest = plugins::package_content_digest(
            package
                .execution_root
                .as_deref()
                .unwrap_or(package.source.path.as_path()),
        )
        .map_err(plugin_error)?;
        ensure_package_runtimes(&app, &state, &package, &candidate_digest).await?;
        let candidate_grants =
            plugins::candidate_capability_grants(&package, &published_grants, &permission_ids)
                .map_err(plugin_error)?;
        let node = state
            .plugin_worker_runtime
            .resolve()
            .await
            .map_err(plugin_error)?;
        return state
            .plugin_control_plane
            .update_and_activate(
                &node,
                package,
                &candidate_grants,
                state.plugin_capability_broker.clone(),
            )
            .await
            .map(plugin_dto)
            .map_err(|error| AppError::Internal(format!("{}: {error}", error.code())));
    }
    let imported = state
        .plugin_control_plane
        .import(package, decision)
        .await
        .map_err(plugin_error)?;
    Ok(plugin_dto(imported.plugin))
}

async fn preview_native_import(
    source: &Path,
    source_kind: plugins::PluginSourceKind,
) -> Result<PluginImportPreviewDto, AppError> {
    let adapters = native_import_adapters(source)?;
    let mut preview: Option<PluginControlItemDto> = None;
    let mut conflict = None;
    for (adapter, format) in adapters {
        let descriptor = adapter.inspect_source(source).map_err(plugin_error)?;
        if let Some(existing) = adapter
            .discover()
            .await
            .map_err(plugin_error)?
            .into_iter()
            .find(|installed| installed.id == descriptor.id)
        {
            conflict.get_or_insert(PluginImportConflictDto {
                plugin_id: descriptor.id.clone(),
                installed_source: existing.path.to_string_lossy().into_owned(),
                incoming_source: descriptor.path.to_string_lossy().into_owned(),
                installed_enabled: existing.enabled.unwrap_or(false),
            });
        }
        merge_native_preview(
            &mut preview,
            native_plugin_dto(descriptor, format, adapter.capabilities()),
        )?;
    }
    let _ = source_kind;
    Ok(PluginImportPreviewDto {
        plugin: preview.ok_or_else(|| {
            AppError::BadRequest(
                "plugin source must contain a VibeX, Codex, or Claude Code manifest".to_owned(),
            )
        })?,
        conflict,
    })
}

async fn import_native_plugin(
    source: &Path,
    source_kind: plugins::PluginSourceKind,
    decision: plugins::ConflictDecision,
) -> Result<PluginControlItemDto, AppError> {
    let adapters = native_import_adapters(source)?;
    let mut imported = None;
    for (adapter, format) in adapters {
        let descriptor = adapter
            .install(source, source_kind, decision)
            .await
            .map_err(plugin_error)?;
        let mut item = native_plugin_dto(descriptor, format, adapter.capabilities());
        item.enable_supported = false;
        item.uninstall_supported = false;
        merge_native_preview(&mut imported, item)?;
    }
    imported.ok_or_else(|| {
        AppError::BadRequest(
            "plugin source must contain a VibeX, Codex, or Claude Code manifest".to_owned(),
        )
    })
}

fn native_import_adapters(
    source: &Path,
) -> Result<Vec<(plugins::FilesystemNativePluginAdapter, &'static str)>, AppError> {
    let home = dirs::home_dir()
        .ok_or_else(|| AppError::Internal("cannot resolve the user home directory".to_owned()))?;
    let mut adapters = Vec::new();
    if source.join(".codex-plugin/plugin.json").is_file() {
        adapters.push((
            plugins::FilesystemNativePluginAdapter::codex(home.join(".codex/plugins/cache")),
            "codex",
        ));
    }
    if source.join(".claude-plugin/plugin.json").is_file() {
        adapters.push((
            plugins::FilesystemNativePluginAdapter::claude_code(home.join(".claude/plugins/cache")),
            "claude_code",
        ));
    }
    Ok(adapters)
}

fn merge_native_preview(
    target: &mut Option<PluginControlItemDto>,
    incoming: PluginControlItemDto,
) -> Result<(), AppError> {
    if let Some(current) = target {
        if current.id != incoming.id {
            return Err(AppError::BadRequest(
                "co-located native manifests must declare the same plugin ID".to_owned(),
            ));
        }
        for format in incoming.formats {
            if !current.formats.contains(&format) {
                current.formats.push(format);
            }
        }
    } else {
        *target = Some(incoming);
    }
    Ok(())
}

#[tauri::command]
pub async fn plugin_control_set_enabled(
    app: AppHandle,
    state: State<'_, AppState>,
    plugin_id: String,
    enabled: bool,
) -> Result<PluginControlItemDto, AppError> {
    if state
        .plugin_control_plane
        .plugin(&plugin_id)
        .await
        .map_err(plugin_error)?
        .is_none()
    {
        let (adapter, descriptor, format) = find_native_cli_plugin(&plugin_id).await?;
        adapter
            .set_enabled(&descriptor.id, enabled)
            .await
            .map_err(plugin_error)?;
        let refreshed = find_native_descriptor(&adapter, &descriptor.id).await?;
        record_plugin_audit(
            &state,
            &plugin_id,
            if enabled { "enable" } else { "disable" },
            serde_json::json!({ "executor": "official_cli" }),
        )
        .await?;
        return Ok(native_plugin_dto(refreshed, format, adapter.capabilities()));
    }
    if !enabled {
        let plugin = state
            .plugin_control_plane
            .plugin(&plugin_id)
            .await
            .map_err(plugin_error)?
            .ok_or_else(|| AppError::NotFound(plugin_id.clone()))?;
        remove_plugin_projections(&plugin).await?;
        sqlx::query(
            "UPDATE plugin_agent_bindings_v4
             SET applied = 0, pending_reason = 'plugin_disabled', updated_at = CURRENT_TIMESTAMP
             WHERE plugin_id = ?",
        )
        .bind(&plugin_id)
        .execute(&state.deployment.db().pool)
        .await?;
        sqlx::query(
            "UPDATE plugin_mcp_bindings_v4
             SET applied = 0, updated_at = CURRENT_TIMESTAMP WHERE plugin_id = ?",
        )
        .bind(&plugin_id)
        .execute(&state.deployment.db().pool)
        .await?;
    }
    let grants = if enabled {
        let installed = state
            .plugin_control_plane
            .plugin(&plugin_id)
            .await
            .map_err(plugin_error)?
            .ok_or_else(|| AppError::NotFound(plugin_id.clone()))?;
        ensure_package_runtimes(&app, &state, &installed.package, &installed.package_digest)
            .await?;
        plugins::candidate_capability_grants(&installed.package, &[], &[]).map_err(plugin_error)?
    } else {
        Vec::new()
    };
    let plugin = if enabled {
        state
            .plugin_control_plane
            .validate_runtime_readiness(&plugin_id)
            .await
            .map_err(|error| AppError::Conflict(format!("{}: {error}", error.code())))?;
        let node = state
            .plugin_worker_runtime
            .resolve()
            .await
            .map_err(plugin_error)?;
        state
            .plugin_control_plane
            .activate_and_enable(
                &node,
                &plugin_id,
                &grants,
                state.plugin_capability_broker.clone(),
            )
            .await
            .map_err(|error| AppError::Internal(format!("{}: {error}", error.code())))?
    } else {
        let plugin = state
            .plugin_control_plane
            .set_enabled(&plugin_id, false)
            .await
            .map_err(plugin_error)?;
        state
            .plugin_control_plane
            .deactivate_worker(&plugin_id)
            .await
            .map_err(|error| AppError::Internal(format!("{}: {error}", error.code())))?;
        plugin
    };
    apply_official_product_runtime(&state).await?;
    if enabled {
        configure_plugin_default_projections(&state, &plugin).await?;
    }
    Ok(plugin_dto(plugin))
}

async fn configure_plugin_default_projections(
    state: &AppState,
    plugin: &plugins::InstalledPlugin,
) -> Result<(), AppError> {
    let known = agents::skills::skill_capable_agent_ids()
        .into_iter()
        .collect::<BTreeSet<_>>();
    let installed = state
        .agent_management_runtime
        .local_runtimes()
        .await
        .keys()
        .map(|agent| agent.as_str().to_owned())
        .collect::<BTreeSet<_>>();
    let saved_agents = sqlx::query_scalar::<_, String>(
        "SELECT agent_id FROM plugin_agent_bindings_v4
         WHERE plugin_id = ? AND desired = 1",
    )
    .bind(plugin.id())
    .fetch_all(&state.deployment.db().pool)
    .await?;
    let has_saved_agent_preferences = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM plugin_agent_bindings_v4 WHERE plugin_id = ?",
    )
    .bind(plugin.id())
    .fetch_one(&state.deployment.db().pool)
    .await?
        > 0;
    let desired_agents = if has_saved_agent_preferences {
        saved_agents.into_iter().collect::<BTreeSet<_>>()
    } else {
        known.clone()
    };
    let targets = desired_agents
        .intersection(&installed)
        .cloned()
        .collect::<Vec<_>>();
    let skill_sources = plugin
        .skills
        .iter()
        .map(|skill| (skill.id.clone(), plugin.source.path.join(&skill.path)))
        .collect::<Vec<_>>();
    let projections =
        agents::skills::project_plugin_skills(plugin.id(), &skill_sources, targets, true)
            .map_err(|error| AppError::Internal(error.to_string()))?
            .into_iter()
            .map(|result| PluginSkillProjectionDto {
                skill_id: result.skill_id,
                agent_id: result.agent_id,
                status: match result.status {
                    agents::skills::PluginSkillProjectionStatus::Projected => "projected",
                    agents::skills::PluginSkillProjectionStatus::Removed => "removed",
                    agents::skills::PluginSkillProjectionStatus::Collision => "collision",
                }
                .to_owned(),
                message: result.message,
            })
            .collect::<Vec<_>>();
    persist_agent_bindings(
        state,
        plugin.id(),
        &known,
        &desired_agents,
        &installed,
        &projections,
    )
    .await?;
    let (_, desired_mcp) = desired_plugin_mcp_agents(state, plugin.id()).await?;
    let all_mcp_agents = desired_mcp == known;
    for error in configure_plugin_mcp(state, plugin, all_mcp_agents, &desired_mcp).await {
        tracing::warn!(plugin_id = plugin.id(), %error, "default MCP projection failed");
    }
    Ok(())
}

/// Re-materialize enabled plugin projections after Host startup.
///
/// Managed MCP specs contain App-lifetime connection details. Replaying the
/// saved projection here replaces stale credentials from the prior process
/// while preserving an explicit per-Agent selection (including select-none).
pub(crate) async fn refresh_enabled_plugin_projections(state: &AppState) {
    let plugins = match state.plugin_control_plane.catalog().await {
        Ok(plugins) => plugins,
        Err(error) => {
            tracing::warn!(%error, "enabled plugin projection refresh failed");
            return;
        }
    };
    for plugin in plugins.iter().filter(|plugin| {
        plugin.activation == plugins::PluginActivation::Enabled
            && plugin
                .mcp
                .get("mcpServers")
                .unwrap_or(&plugin.mcp)
                .as_object()
                .is_some_and(|servers| {
                    servers
                        .values()
                        .any(|spec| spec.get("managedRuntime").is_some())
                })
    }) {
        let refreshed = async {
            let (known, desired) = desired_plugin_mcp_agents(state, plugin.id()).await?;
            let all_agents = desired == known;
            Ok::<_, AppError>(configure_plugin_mcp(state, plugin, all_agents, &desired).await)
        }
        .await;
        match refreshed {
            Ok(errors) => {
                for error in errors {
                    tracing::warn!(
                        plugin_id = plugin.id(),
                        %error,
                        "managed MCP projection refresh failed"
                    );
                }
            }
            Err(error) => tracing::warn!(
                plugin_id = plugin.id(),
                %error,
                "managed MCP projection refresh failed"
            ),
        }
    }
}

async fn desired_plugin_mcp_agents(
    state: &AppState,
    plugin_id: &str,
) -> Result<(BTreeSet<String>, BTreeSet<String>), AppError> {
    let known = agents::skills::skill_capable_agent_ids()
        .into_iter()
        .collect::<BTreeSet<_>>();
    let saved = sqlx::query_scalar::<_, String>(
        "SELECT DISTINCT agent_id FROM plugin_mcp_bindings_v4
         WHERE plugin_id = ? AND desired = 1",
    )
    .bind(plugin_id)
    .fetch_all(&state.deployment.db().pool)
    .await?;
    let has_saved_preferences = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM plugin_mcp_bindings_v4 WHERE plugin_id = ?",
    )
    .bind(plugin_id)
    .fetch_one(&state.deployment.db().pool)
    .await?
        > 0;
    let desired = if has_saved_preferences {
        saved.into_iter().collect()
    } else {
        known.clone()
    };
    Ok((known, desired))
}

#[tauri::command]
pub async fn plugin_control_update(
    state: State<'_, AppState>,
    plugin_id: String,
) -> Result<PluginControlItemDto, AppError> {
    let (adapter, descriptor, format) = find_native_cli_plugin(&plugin_id).await?;
    adapter.update(&descriptor.id).await.map_err(plugin_error)?;
    let refreshed = find_native_descriptor(&adapter, &descriptor.id).await?;
    record_plugin_audit(
        &state,
        &plugin_id,
        "update",
        serde_json::json!({ "executor": "official_cli" }),
    )
    .await?;
    Ok(native_plugin_dto(refreshed, format, adapter.capabilities()))
}

#[tauri::command]
pub async fn plugin_control_rollback(
    state: State<'_, AppState>,
    plugin_id: String,
    permission_ids: Vec<String>,
) -> Result<PluginControlItemDto, AppError> {
    let node = state
        .plugin_worker_runtime
        .resolve()
        .await
        .map_err(plugin_error)?;
    let plugin = state
        .plugin_control_plane
        .rollback_and_activate(
            &node,
            &plugin_id,
            &permission_ids,
            state.plugin_capability_broker.clone(),
        )
        .await
        .map_err(|error| AppError::Internal(format!("{}: {error}", error.code())))?;
    record_plugin_audit(
        &state,
        &plugin_id,
        "rollback",
        serde_json::json!({ "packageDigest": plugin.package_digest }),
    )
    .await?;
    Ok(plugin_dto(plugin))
}

#[tauri::command]
pub async fn plugin_control_install_runtime(
    app: AppHandle,
    state: State<'_, AppState>,
    plugin_id: String,
    runtime_id: String,
) -> Result<PluginRuntimeDto, AppError> {
    install_plugin_runtime(&app, &state, &plugin_id, &runtime_id).await
}

async fn install_plugin_runtime(
    app: &AppHandle,
    state: &AppState,
    plugin_id: &str,
    runtime_id: &str,
) -> Result<PluginRuntimeDto, AppError> {
    let plugin = state
        .plugin_control_plane
        .plugin(plugin_id)
        .await
        .map_err(plugin_error)?
        .ok_or_else(|| AppError::NotFound(plugin_id.to_owned()))?;
    let runtime = plugin
        .runtimes
        .iter()
        .find(|runtime| runtime.id == runtime_id)
        .ok_or_else(|| AppError::NotFound(runtime_id.to_owned()))?;
    install_declared_runtime(app, state, &plugin, runtime, &plugin.package_digest).await
}

async fn ensure_package_runtimes(
    app: &AppHandle,
    state: &AppState,
    package: &plugins::PluginPackage,
    package_digest: &str,
) -> Result<(), AppError> {
    let installed = state
        .plugin_control_plane
        .plugin(package.id.as_str())
        .await
        .map_err(plugin_error)?
        .ok_or_else(|| AppError::NotFound(package.id.as_str().to_owned()))?;
    for runtime in &package.runtimes {
        let ready = state
            .plugin_control_plane
            .runtime_for_package(package.id.as_str(), package_digest, &runtime.id)
            .await
            .map_err(plugin_error)?
            .is_some_and(|locked| runtime_lock_matches(runtime, &locked));
        if !ready {
            install_declared_runtime(app, state, &installed, runtime, package_digest).await?;
        }
    }
    Ok(())
}

fn runtime_lock_matches(
    declared: &plugins::RuntimeContribution,
    locked: &plugins::RuntimeInstallation,
) -> bool {
    declared
        .version
        .as_deref()
        .is_none_or(|version| version == locked.version)
        && (declared.target.is_empty() || declared.target == locked.target)
        && (declared.content_digest.is_empty() || declared.content_digest == locked.content_digest)
        && locked.executable_path.is_absolute()
        && locked.executable_path.is_file()
}

async fn install_declared_runtime(
    app: &AppHandle,
    state: &AppState,
    plugin: &plugins::InstalledPlugin,
    runtime: &plugins::RuntimeContribution,
    package_digest: &str,
) -> Result<PluginRuntimeDto, AppError> {
    if let Some(existing) = state
        .plugin_control_plane
        .runtime_inventory()
        .await
        .map_err(plugin_error)?
        .into_iter()
        .find(|locked| runtime_lock_matches(runtime, locked))
    {
        state
            .plugin_control_plane
            .record_runtime_for_package(plugin.id(), package_digest, existing.clone())
            .await
            .map_err(plugin_error)?;
        return Ok(runtime_dto(existing, plugin.id()));
    }
    let managed_root = crate::managed_artifacts::directory(app)
        .map_err(|error| AppError::Internal(error.to_string()))?
        .join("plugins/runtimes");
    let host =
        plugins::ContentAddressedRuntimeHost::new(managed_root, runtime).map_err(plugin_error)?;
    record_plugin_audit(
        state,
        plugin.id(),
        "runtime_install_started",
        serde_json::json!({
            "runtimeId": runtime.id,
            "installer": runtime_installer(&runtime.install),
            "sourcePath": plugin.source.path,
        }),
    )
    .await?;
    let installation = match plugins::GlobalRuntimeInstaller::new(&host)
        .install(plugin.id(), runtime)
        .await
    {
        Ok(installation) => installation,
        Err(error) => {
            record_plugin_audit(
                state,
                plugin.id(),
                "runtime_install_failed",
                serde_json::json!({
                    "runtimeId": runtime.id,
                    "errorCode": error.code(),
                    "error": error.message(),
                }),
            )
            .await?;
            return Err(plugin_error(error));
        }
    };

    state
        .plugin_control_plane
        .record_runtime_for_package(plugin.id(), package_digest, installation.clone())
        .await
        .map_err(plugin_error)?;
    record_plugin_audit(
        state,
        plugin.id(),
        "runtime_install",
        serde_json::json!({
            "runtimeId": installation.id,
            "version": installation.version,
            "executablePath": installation.executable_path,
            "exitStatus": "success",
            "probe": "passed",
        }),
    )
    .await?;
    Ok(runtime_dto(installation, plugin.id()))
}

fn runtime_dto(installation: plugins::RuntimeInstallation, plugin_id: &str) -> PluginRuntimeDto {
    PluginRuntimeDto {
        id: installation.id,
        version: installation.version,
        target: installation.target,
        content_digest: installation.content_digest,
        executable_path: installation.executable_path.to_string_lossy().into_owned(),
        ownership: installation.ownership,
        installer: installation.installer,
        probe: installation.probe,
        referenced_plugins: vec![plugin_id.to_owned()],
    }
}

#[tauri::command]
pub async fn plugin_control_grant_permissions(
    state: State<'_, AppState>,
    plugin_id: String,
    permission_ids: Vec<String>,
) -> Result<Vec<plugins::CapabilityGrant>, AppError> {
    state
        .plugin_control_plane
        .grant_permissions(&plugin_id, &permission_ids)
        .await
        .map_err(plugin_error)?;
    state
        .plugin_control_plane
        .capability_grants(&plugin_id)
        .await
        .map_err(plugin_error)
}

#[tauri::command]
pub async fn plugin_control_configure_agents(
    state: State<'_, AppState>,
    plugin_id: String,
    all_agents: bool,
    agents: Vec<String>,
) -> Result<PluginAgentConfigurationDto, AppError> {
    let plugin = state
        .plugin_control_plane
        .plugin(&plugin_id)
        .await
        .map_err(plugin_error)?
        .ok_or_else(|| AppError::NotFound(plugin_id.clone()))?;
    if plugin.activation != plugins::PluginActivation::Enabled {
        return Err(AppError::BadRequest(
            "plugin must be enabled before configuring Agent projections".to_owned(),
        ));
    }

    let known = agents::skills::skill_capable_agent_ids()
        .into_iter()
        .collect::<BTreeSet<_>>();
    let desired = if all_agents {
        known.clone()
    } else {
        let requested = agents.into_iter().collect::<BTreeSet<_>>();
        if let Some(unknown) = requested.iter().find(|agent| !known.contains(*agent)) {
            return Err(AppError::BadRequest(format!(
                "Agent `{unknown}` does not support Skill projection"
            )));
        }
        requested
    };
    let installed = state
        .agent_management_runtime
        .local_runtimes()
        .await
        .keys()
        .map(|agent| agent.as_str().to_owned())
        .collect::<BTreeSet<_>>();
    let projection_targets = desired
        .intersection(&installed)
        .cloned()
        .collect::<Vec<_>>();
    let skill_sources = plugin
        .skills
        .iter()
        .map(|skill| (skill.id.clone(), plugin.source.path.join(&skill.path)))
        .collect::<Vec<_>>();
    let projected =
        agents::skills::project_plugin_skills(&plugin_id, &skill_sources, projection_targets, true)
            .map_err(|error| AppError::Internal(error.to_string()))?;
    let projections = projected
        .into_iter()
        .map(|result| PluginSkillProjectionDto {
            skill_id: result.skill_id,
            agent_id: result.agent_id,
            status: match result.status {
                agents::skills::PluginSkillProjectionStatus::Projected => "projected",
                agents::skills::PluginSkillProjectionStatus::Removed => "removed",
                agents::skills::PluginSkillProjectionStatus::Collision => "collision",
            }
            .to_owned(),
            message: result.message,
        })
        .collect::<Vec<_>>();

    persist_agent_bindings(
        &state,
        &plugin_id,
        &known,
        &desired,
        &installed,
        &projections,
    )
    .await?;
    Ok(PluginAgentConfigurationDto {
        skill_projections: projections,
        mcp_errors: Vec::new(),
    })
}

#[tauri::command]
pub async fn plugin_control_configure_mcp(
    state: State<'_, AppState>,
    plugin_id: String,
    all_agents: bool,
    agents: Vec<String>,
) -> Result<PluginMcpConfigurationDto, AppError> {
    let plugin = state
        .plugin_control_plane
        .plugin(&plugin_id)
        .await
        .map_err(plugin_error)?
        .ok_or_else(|| AppError::NotFound(plugin_id.clone()))?;
    if plugin.activation != plugins::PluginActivation::Enabled {
        return Err(AppError::BadRequest(
            "plugin must be enabled before configuring MCP projections".to_owned(),
        ));
    }
    let known = agents::skills::skill_capable_agent_ids()
        .into_iter()
        .collect::<BTreeSet<_>>();
    let desired = if all_agents {
        known
    } else {
        let requested = agents.into_iter().collect::<BTreeSet<_>>();
        if let Some(unknown) = requested.iter().find(|agent| !known.contains(*agent)) {
            return Err(AppError::BadRequest(format!(
                "Agent `{unknown}` does not support managed MCP projection"
            )));
        }
        requested
    };
    Ok(PluginMcpConfigurationDto {
        mcp_errors: configure_plugin_mcp(&state, &plugin, all_agents, &desired).await,
    })
}

#[tauri::command]
pub async fn plugin_control_uninstall(
    app: AppHandle,
    state: State<'_, AppState>,
    plugin_id: String,
) -> Result<(), AppError> {
    if state
        .plugin_control_plane
        .plugin(&plugin_id)
        .await
        .map_err(plugin_error)?
        .is_some()
    {
        return uninstall_portable_plugin(&app, &state, &plugin_id).await;
    }
    let (adapter, descriptor, _) = find_native_cli_plugin(&plugin_id).await?;
    adapter
        .uninstall(&descriptor.id)
        .await
        .map_err(plugin_error)?;
    record_plugin_audit(
        &state,
        &plugin_id,
        "uninstall",
        serde_json::json!({ "executor": "official_cli", "runtimeRetained": true }),
    )
    .await
}

async fn uninstall_portable_plugin(
    app: &AppHandle,
    state: &AppState,
    plugin_id: &str,
) -> Result<(), AppError> {
    let installed = state
        .plugin_control_plane
        .plugin(plugin_id)
        .await
        .map_err(plugin_error)?
        .ok_or_else(|| AppError::NotFound(plugin_id.to_owned()))?;
    if installed.source.kind == plugins::PluginSourceKind::Builtin {
        return Err(AppError::BadRequest(
            "built-in plugins can be disabled but not uninstalled".to_owned(),
        ));
    }
    remove_plugin_projections(&installed).await?;
    state
        .plugin_control_plane
        .uninstall(plugin_id)
        .await
        .map_err(plugin_error)?;
    if installed.source.kind == plugins::PluginSourceKind::Snapshot {
        remove_managed_snapshot(app, &installed.source.path)?;
    }
    record_plugin_audit(
        state,
        plugin_id,
        "uninstall",
        serde_json::json!({ "runtimeRetained": true }),
    )
    .await
}

async fn remove_plugin_projections(plugin: &plugins::InstalledPlugin) -> Result<(), AppError> {
    let skill_ids = plugin
        .skills
        .iter()
        .map(|skill| skill.id.clone())
        .collect::<Vec<_>>();
    agents::skills::remove_plugin_skill_projections(plugin.id(), &skill_ids)
        .map_err(|error| AppError::Internal(error.to_string()))?;
    for server_id in plugin_mcp_server_ids(plugin) {
        services::services::mcp::uninstall_server(server_id)
            .await
            .map_err(|error| AppError::Internal(error.to_string()))?;
    }
    Ok(())
}

fn plugin_mcp_server_ids(plugin: &plugins::InstalledPlugin) -> Vec<String> {
    mcp_server_names(Some(&plugin.mcp))
        .into_iter()
        .map(|server_id| format!("{}.{}", plugin.id(), server_id))
        .collect()
}

async fn record_plugin_audit(
    state: &AppState,
    plugin_id: &str,
    operation: &str,
    summary: serde_json::Value,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO plugin_audit_v4
             (plugin_id, publisher, operation_id, event, evidence_json, created_at)
         SELECT ?, publisher, NULL, ?, ?, datetime('now','subsec')
         FROM plugin_installations_v4 WHERE plugin_id = ?",
    )
    .bind(plugin_id)
    .bind(operation)
    .bind(summary.to_string())
    .bind(plugin_id)
    .execute(&state.deployment.db().pool)
    .await?;
    Ok(())
}

fn plugin_dto(plugin: plugins::InstalledPlugin) -> PluginControlItemDto {
    let publisher = plugin.publisher.clone();
    let package_digest = plugin.package_digest.clone();
    PluginControlItemDto {
        id: plugin.id().to_owned(),
        publisher,
        package_digest: Some(package_digest),
        update_package_digest: None,
        name: plugin.name.clone(),
        version: plugin.version.clone(),
        description: plugin.description.clone(),
        enabled: plugin.activation == plugins::PluginActivation::Enabled,
        builtin: plugin.source.kind == plugins::PluginSourceKind::Builtin,
        source_kind: source_kind(&plugin.source.kind).to_owned(),
        source_path: plugin.source.path.to_string_lossy().into_owned(),
        formats: plugin
            .formats
            .iter()
            .map(format_kind)
            .map(str::to_owned)
            .collect(),
        skills: plugin
            .skills
            .iter()
            .map(|skill| PluginSkillDto {
                id: skill.id.clone(),
                path: skill.path.clone(),
            })
            .collect(),
        runtimes: plugin
            .runtimes
            .iter()
            .map(|runtime| PluginRuntimeContributionDto {
                id: runtime.id.clone(),
                command: runtime.command.clone(),
                version: runtime.version.clone(),
                target: runtime.target.clone(),
                content_digest: runtime.content_digest.clone(),
                installer: runtime_installer(&runtime.install).to_owned(),
                install_command: None,
            })
            .collect(),
        mcp_count: mcp_contribution_count(Some(&plugin.mcp)),
        mcp_servers: mcp_server_names(Some(&plugin.mcp)),
        hooks: Vec::new(),
        workflows: Vec::new(),
        invocation_count: plugin.invocations.len() as u32,
        invocations: plugin
            .invocations
            .iter()
            .map(|invocation| PluginInvocationDto {
                id: invocation.id.clone(),
                label: invocation.label.clone(),
                prompt: invocation.prompt.clone(),
                kind: match invocation.kind {
                    plugins::InvocationKind::Action => "action",
                    plugins::InvocationKind::Command => "command",
                }
                .to_owned(),
            })
            .collect(),
        app_contributions: declared_app_contributions(&plugin),
        warnings: plugin
            .warnings
            .iter()
            .map(|warning| PluginWarningDto {
                code: warning.code.clone(),
                message: warning.message.clone(),
                contribution: warning.contribution.clone(),
            })
            .collect(),
        permissions: plugin.permissions.iter().map(permission_dto).collect(),
        permission_delta: Vec::new(),
        native_managed: false,
        enable_supported: true,
        update_supported: false,
        rollback_supported: false,
        uninstall_supported: plugin.source.kind != plugins::PluginSourceKind::Builtin,
    }
}

fn permission_dto(permission: &plugins::CapabilityRequest) -> PluginPermissionDto {
    PluginPermissionDto {
        id: permission.id.clone(),
        capability: permission.capability.clone(),
        scope: permission.scope.clone(),
        reason: permission.reason.clone(),
        optional: permission.optional,
        trust_tier: permission.trust_tier.clone(),
    }
}

fn native_plugin_dto(
    plugin: plugins::NativePluginDescriptor,
    format: &str,
    capabilities: plugins::NativeAdapterCapabilities,
) -> PluginControlItemDto {
    let skills = discover_native_skills(&plugin.path);
    let (mcp_count, mcp_servers) = native_mcp_summary(&plugin.path);
    let source_kind = match plugin.ecosystem {
        plugins::NativeEcosystem::Codex => "codex_native",
        plugins::NativeEcosystem::ClaudeCode => "claude_code_native",
    };
    PluginControlItemDto {
        id: plugin.id,
        publisher: None,
        package_digest: None,
        update_package_digest: None,
        name: plugin.name,
        version: plugin.version.unwrap_or_else(|| "unknown".to_owned()),
        description: None,
        enabled: plugin.enabled.unwrap_or(false),
        builtin: false,
        source_kind: source_kind.to_owned(),
        source_path: plugin.path.to_string_lossy().into_owned(),
        formats: vec![format.to_owned()],
        skills,
        runtimes: Vec::new(),
        warnings: Vec::new(),
        permissions: Vec::new(),
        permission_delta: Vec::new(),
        mcp_count,
        mcp_servers,
        hooks: discover_native_resources(&plugin.path, "hooks"),
        workflows: discover_native_resources(&plugin.path, "workflows"),
        invocation_count: 0,
        invocations: Vec::new(),
        app_contributions: Vec::new(),
        native_managed: true,
        enable_supported: capabilities.enable,
        update_supported: capabilities.update,
        rollback_supported: false,
        uninstall_supported: capabilities.uninstall,
    }
}

fn declared_app_contributions(plugin: &plugins::InstalledPlugin) -> Vec<PluginAppContributionDto> {
    plugin
        .app
        .file_openers
        .iter()
        .map(|opener| PluginAppContributionDto {
            id: opener.id.clone(),
            kind: "file_opener".to_owned(),
            label: opener.label.clone(),
            metadata: serde_json::json!({
                "extensions": opener.extensions,
                "mediaTypes": opener.media_types,
                "priority": opener.priority,
                "handler": opener.handler,
            }),
        })
        .chain(
            plugin
                .app
                .preview_providers
                .iter()
                .map(|provider| PluginAppContributionDto {
                    id: provider.id.clone(),
                    kind: "preview_provider".to_owned(),
                    label: provider.id.clone(),
                    metadata: serde_json::json!({
                        "mediaTypes": provider.media_types,
                        "runtime": provider.runtime,
                        "maxConcurrentPreviews": provider.max_concurrent_previews,
                        "handler": provider.handler,
                    }),
                }),
        )
        .chain(
            plugin
                .app
                .surfaces
                .iter()
                .map(|surface| PluginAppContributionDto {
                    id: surface.id.clone(),
                    kind: "app_surface".to_owned(),
                    label: surface.label.clone(),
                    metadata: serde_json::json!({
                        "slot": surface.slot,
                        "appEntrypoint": surface.app_entrypoint,
                        "route": surface.route,
                        "handler": surface.handler,
                        "allowedMethods": surface.allowed_methods,
                        "minHeight": surface.min_height,
                    }),
                }),
        )
        .collect()
}

async fn native_cli_adapters() -> Vec<(plugins::OfficialCliNativePluginAdapter, &'static str)> {
    let mut adapters = Vec::new();
    if let Some(program) = utils::shell::resolve_executable_path("codex").await {
        adapters.push((
            plugins::OfficialCliNativePluginAdapter::codex(program),
            "codex",
        ));
    }
    if let Some(program) = utils::shell::resolve_executable_path("claude").await {
        adapters.push((
            plugins::OfficialCliNativePluginAdapter::claude_code(program),
            "claude_code",
        ));
    }
    adapters
}

async fn find_native_cli_plugin(
    plugin_id: &str,
) -> Result<
    (
        plugins::OfficialCliNativePluginAdapter,
        plugins::NativePluginDescriptor,
        &'static str,
    ),
    AppError,
> {
    for (adapter, format) in native_cli_adapters().await {
        let Ok(discovered) = adapter.discover().await else {
            continue;
        };
        if let Some(plugin) = discovered.into_iter().find(|plugin| plugin.id == plugin_id) {
            return Ok((adapter, plugin, format));
        }
    }
    Err(AppError::NotFound(plugin_id.to_owned()))
}

async fn find_native_descriptor(
    adapter: &plugins::OfficialCliNativePluginAdapter,
    plugin_id: &str,
) -> Result<plugins::NativePluginDescriptor, AppError> {
    adapter
        .discover()
        .await
        .map_err(plugin_error)?
        .into_iter()
        .find(|plugin| plugin.id == plugin_id)
        .ok_or_else(|| AppError::NotFound(plugin_id.to_owned()))
}

fn discover_native_skills(root: &Path) -> Vec<PluginSkillDto> {
    let Ok(entries) = std::fs::read_dir(root.join("skills")) else {
        return Vec::new();
    };
    let mut skills = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let skill = entry.path().join("SKILL.md");
            skill.is_file().then(|| PluginSkillDto {
                id: entry.file_name().to_string_lossy().into_owned(),
                path: skill
                    .strip_prefix(root)
                    .unwrap_or(&skill)
                    .to_string_lossy()
                    .into_owned(),
            })
        })
        .collect::<Vec<_>>();
    skills.sort_by(|left, right| left.id.cmp(&right.id));
    skills
}

fn discover_native_resources(root: &Path, directory: &str) -> Vec<PluginNativeResourceDto> {
    fn visit(
        root: &Path,
        directory: &Path,
        depth: usize,
        resources: &mut Vec<PluginNativeResourceDto>,
    ) {
        if depth > 4 || resources.len() >= 256 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(directory) else {
            return;
        };
        let mut entries = entries.filter_map(Result::ok).collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                visit(root, &entry.path(), depth + 1, resources);
                continue;
            }
            if !file_type.is_file() || resources.len() >= 256 {
                continue;
            }
            let path = entry.path();
            let supported = path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| {
                    matches!(
                        extension.to_ascii_lowercase().as_str(),
                        "json" | "yaml" | "yml"
                    )
                });
            if !supported {
                continue;
            }
            let relative = path.strip_prefix(root).unwrap_or(&path);
            let id = relative
                .components()
                .skip(1)
                .map(|component| component.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            let id = Path::new(&id)
                .with_extension("")
                .to_string_lossy()
                .into_owned();
            resources.push(PluginNativeResourceDto {
                id,
                path: relative.to_string_lossy().into_owned(),
            });
        }
    }

    let mut resources = Vec::new();
    visit(root, &root.join(directory), 0, &mut resources);
    resources.sort_by(|left, right| left.id.cmp(&right.id));
    resources
}

fn read_native_mcp(root: &Path) -> Result<Option<serde_json::Value>, AppError> {
    let path = root.join(".mcp.json");
    if !path.is_file() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&path).map_err(|error| {
        AppError::Internal(format!("cannot read native MCP configuration: {error}"))
    })?;
    serde_json::from_str(&content)
        .map(Some)
        .map_err(|error| AppError::BadRequest(format!("invalid native MCP configuration: {error}")))
}

fn native_mcp_summary(root: &Path) -> (u32, Vec<String>) {
    match read_native_mcp(root) {
        Ok(Some(value)) => (
            mcp_contribution_count(Some(&value)),
            mcp_server_names(Some(&value)),
        ),
        Ok(None) => (0, Vec::new()),
        Err(_) => (1, Vec::new()),
    }
}

fn read_plugin_contributions(
    root: &Path,
    skills: &[PluginSkillDto],
    raw_mcp: Option<&serde_json::Value>,
) -> Result<PluginControlContributionsDto, AppError> {
    let skills = skills
        .iter()
        .map(|skill| {
            let path = root.join(&skill.path);
            let content = std::fs::read_to_string(&path).map_err(|error| {
                AppError::Internal(format!(
                    "cannot read Skill `{}` from `{}`: {error}",
                    skill.id,
                    path.display()
                ))
            })?;
            Ok(PluginSkillContentDto {
                id: skill.id.clone(),
                path: skill.path.clone(),
                content,
            })
        })
        .collect::<Result<Vec<_>, AppError>>()?;
    let mcp_servers = mcp_server_dtos(raw_mcp);
    Ok(PluginControlContributionsDto {
        skills,
        mcp_servers,
    })
}

fn mcp_server_dtos(raw_mcp: Option<&serde_json::Value>) -> Vec<PluginMcpServerDto> {
    let mut servers = mcp_server_map(raw_mcp)
        .map(|servers| {
            servers
                .iter()
                .map(|(id, config)| PluginMcpServerDto {
                    id: id.clone(),
                    config: config.clone(),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    servers.sort_by(|left, right| left.id.cmp(&right.id));
    servers
}

fn mcp_server_map(
    raw_mcp: Option<&serde_json::Value>,
) -> Option<&serde_json::Map<String, serde_json::Value>> {
    let raw_mcp = raw_mcp?;
    raw_mcp.get("mcpServers").unwrap_or(raw_mcp).as_object()
}

fn mcp_server_names(raw_mcp: Option<&serde_json::Value>) -> Vec<String> {
    let mut names = mcp_server_map(raw_mcp)
        .map(|servers| servers.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    names.sort();
    names
}

async fn persist_agent_bindings(
    state: &AppState,
    plugin_id: &str,
    known: &BTreeSet<String>,
    desired: &BTreeSet<String>,
    installed: &BTreeSet<String>,
    projections: &[PluginSkillProjectionDto],
) -> Result<(), AppError> {
    let outcomes =
        projections
            .iter()
            .fold(BTreeMap::<&str, bool>::new(), |mut outcomes, projection| {
                let ready = projection.status == "projected";
                outcomes
                    .entry(&projection.agent_id)
                    .and_modify(|current| *current &= ready)
                    .or_insert(ready);
                outcomes
            });
    let pool = &state.deployment.db().pool;
    let mut transaction = pool.begin().await?;
    for agent_id in known {
        let wanted = desired.contains(agent_id);
        let applied = wanted
            && installed.contains(agent_id)
            && outcomes.get(agent_id.as_str()) == Some(&true);
        let pending_reason = if wanted && !installed.contains(agent_id) {
            Some("agent_not_installed")
        } else if wanted && !applied {
            Some("projection_incomplete")
        } else {
            None
        };
        sqlx::query(
            "INSERT INTO plugin_agent_bindings_v4
                 (plugin_id, agent_id, desired, applied, pending_reason, error_code, error_message, updated_at)
             VALUES (?, ?, ?, ?, ?, NULL, NULL, CURRENT_TIMESTAMP)
             ON CONFLICT(plugin_id, agent_id) DO UPDATE SET
                 desired = excluded.desired,
                 applied = excluded.applied,
                 pending_reason = excluded.pending_reason,
                 error_code = NULL,
                 error_message = NULL,
                 updated_at = CURRENT_TIMESTAMP",
        )
        .bind(plugin_id)
        .bind(agent_id)
        .bind(i64::from(wanted))
        .bind(i64::from(applied))
        .bind(pending_reason)
        .execute(&mut *transaction)
        .await?;
    }
    transaction.commit().await?;
    Ok(())
}

async fn configure_plugin_mcp(
    state: &AppState,
    plugin: &plugins::InstalledPlugin,
    all_agents: bool,
    desired: &BTreeSet<String>,
) -> Vec<String> {
    let pool = &state.deployment.db().pool;
    if let Err(error) = sqlx::query("DELETE FROM plugin_mcp_bindings_v4 WHERE plugin_id = ?")
        .bind(plugin.id())
        .execute(pool)
        .await
    {
        return vec![format!("control-plane binding reset: {error}")];
    }
    let raw_mcp = &plugin.mcp;
    if raw_mcp.is_null() {
        return Vec::new();
    }
    let servers = raw_mcp
        .get("mcpServers")
        .unwrap_or(raw_mcp)
        .as_object()
        .cloned()
        .unwrap_or_default();
    let apps = if all_agents {
        Vec::new()
    } else {
        desired
            .iter()
            .filter_map(|agent| {
                serde_json::from_value::<services::services::mcp::McpAppType>(
                    serde_json::Value::String(agent.clone()),
                )
                .ok()
            })
            .collect()
    };
    let mut errors = Vec::new();
    for (server_id, spec) in servers {
        let projected_id = format!("{}.{}", plugin.id(), server_id);
        let spec = match materialize_plugin_mcp_spec(state, plugin, &server_id, spec).await {
            Ok(spec) => spec,
            Err(error) => {
                errors.push(format!("{server_id}: {error}"));
                continue;
            }
        };
        let result = services::services::mcp::upsert_local_server(
            projected_id,
            spec,
            all_agents,
            apps.clone(),
        )
        .await;
        let error_message = result.as_ref().err().map(ToString::to_string);
        if let Some(error) = &error_message {
            errors.push(format!("{server_id}: {error}"));
        }
        let known_agents = agents::skills::skill_capable_agent_ids()
            .into_iter()
            .collect::<BTreeSet<_>>();
        for agent_id in &known_agents {
            let wanted = desired.contains(agent_id);
            let binding_error_code =
                (wanted && error_message.is_some()).then_some("mcp_projection_failed");
            let binding_error_message = if wanted {
                error_message.as_deref()
            } else {
                None
            };
            if let Err(error) = sqlx::query(
                "INSERT INTO plugin_mcp_bindings_v4
                     (plugin_id, mcp_id, agent_id, desired, applied, error_code, error_message, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(plugin_id, mcp_id, agent_id) DO UPDATE SET
                     desired = excluded.desired,
                     applied = excluded.applied,
                     error_code = excluded.error_code,
                     error_message = excluded.error_message,
                     updated_at = CURRENT_TIMESTAMP",
            )
            .bind(plugin.id())
            .bind(&server_id)
            .bind(agent_id)
            .bind(i64::from(wanted))
            .bind(i64::from(wanted && error_message.is_none()))
            .bind(binding_error_code)
            .bind(binding_error_message)
            .execute(pool)
            .await
            {
                errors.push(format!("{server_id}/{agent_id} binding: {error}"));
            }
        }
    }
    errors
}

async fn materialize_plugin_mcp_spec(
    state: &AppState,
    plugin: &plugins::InstalledPlugin,
    server_id: &str,
    spec: serde_json::Value,
) -> Result<serde_json::Value, AppError> {
    let Some(managed) = spec
        .get("managedRuntime")
        .and_then(serde_json::Value::as_object)
    else {
        return Ok(spec);
    };
    let entrypoint = managed
        .get("entrypoint")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            AppError::BadRequest(format!(
                "managed MCP `{server_id}` requires managedRuntime.entrypoint"
            ))
        })?;
    let relative = Path::new(entrypoint);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(AppError::BadRequest(format!(
            "managed MCP `{server_id}` entrypoint must be a package-relative path"
        )));
    }
    let package_root = plugin
        .source
        .path
        .canonicalize()
        .map_err(|error| AppError::Internal(error.to_string()))?;
    let entrypoint = package_root
        .join(relative)
        .canonicalize()
        .map_err(|error| AppError::NotFound(error.to_string()))?;
    if !entrypoint.starts_with(&package_root) || !entrypoint.is_file() {
        return Err(AppError::BadRequest(format!(
            "managed MCP `{server_id}` entrypoint escapes the installed package"
        )));
    }
    let node = state
        .plugin_worker_runtime
        .resolve()
        .await
        .map_err(plugin_error)?;
    let gateway = state
        .app_handle
        .try_state::<crate::workflow_mcp_gateway::WorkflowMcpGatewayConnection>()
        .ok_or_else(|| AppError::Internal("Workflow MCP gateway is unavailable".to_owned()))?;
    Ok(serde_json::json!({
        "type": "stdio",
        "command": node.to_string_lossy(),
        "args": [entrypoint.to_string_lossy()],
        "env": {
            "VIBEX_SERVER_URL": gateway.endpoint.as_str(),
            "VIBEX_SERVER_TOKEN": gateway.token(),
            "VIBEX_MCP_PROTOCOL_REVISION": managed
                .get("protocolRevision")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("2026-07-28")
        }
    }))
}

fn parse_conflict_decision(value: &str) -> Result<plugins::ConflictDecision, AppError> {
    match value {
        "reject" => Ok(plugins::ConflictDecision::Reject),
        "keep" => Ok(plugins::ConflictDecision::KeepInstalled),
        "replace" => Ok(plugins::ConflictDecision::Replace),
        _ => Err(AppError::BadRequest(format!(
            "unsupported conflict decision `{value}`"
        ))),
    }
}

fn plugin_snapshot_root(app: &AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("plugins/snapshots"))
        .map_err(|error| AppError::Internal(error.to_string()))
}

fn remove_managed_snapshot(app: &AppHandle, source: &Path) -> Result<(), AppError> {
    let root = plugin_snapshot_root(app)?;
    let root = root
        .canonicalize()
        .map_err(|error| AppError::Internal(error.to_string()))?;
    let source = source
        .canonicalize()
        .map_err(|error| AppError::Internal(error.to_string()))?;
    if source.parent() != Some(root.as_path()) {
        return Err(AppError::BadRequest(
            "plugin snapshot is outside the managed snapshot directory".to_owned(),
        ));
    }
    std::fs::remove_dir_all(source).map_err(|error| AppError::Internal(error.to_string()))
}

fn plugin_error(error: plugins::PluginError) -> AppError {
    match error.code() {
        "plugin_not_found" => AppError::NotFound(error.message().to_owned()),
        "plugin_id_conflict" => AppError::Conflict(error.message().to_owned()),
        "plugin_manifest_invalid" | "plugin_skill_required" => {
            AppError::BadRequest(error.message().to_owned())
        }
        _ => AppError::Internal(error.message().to_owned()),
    }
}

fn source_kind(kind: &plugins::PluginSourceKind) -> &'static str {
    match kind {
        plugins::PluginSourceKind::Builtin => "builtin",
        plugins::PluginSourceKind::Snapshot => "snapshot",
        plugins::PluginSourceKind::DeveloperLink => "developer_link",
        plugins::PluginSourceKind::CodexNative => "codex_native",
        plugins::PluginSourceKind::ClaudeCodeNative => "claude_code_native",
    }
}

fn format_kind(format: &plugins::PackageFormat) -> &'static str {
    match format {
        plugins::PackageFormat::VibeX => "vibex",
        plugins::PackageFormat::Codex => "codex",
        plugins::PackageFormat::ClaudeCode => "claude_code",
    }
}

fn runtime_installer(installer: &plugins::RuntimeInstall) -> &'static str {
    match installer {
        plugins::RuntimeInstall::Existing => "existing",
        plugins::RuntimeInstall::Binary { .. } => "binary",
        plugins::RuntimeInstall::Archive { .. } => "archive",
        plugins::RuntimeInstall::Npm { .. } => "npm",
        plugins::RuntimeInstall::Pipx { .. } => "pipx",
        plugins::RuntimeInstall::Cargo { .. } => "cargo",
    }
}

fn contribution_count(value: Option<&serde_json::Value>) -> u32 {
    match value {
        Some(serde_json::Value::Array(items)) => u32::try_from(items.len()).unwrap_or(u32::MAX),
        Some(serde_json::Value::Object(items)) => u32::try_from(items.len()).unwrap_or(u32::MAX),
        Some(serde_json::Value::Null) | None => 0,
        Some(_) => 1,
    }
}

fn mcp_contribution_count(value: Option<&serde_json::Value>) -> u32 {
    let value = value.map(|value| value.get("mcpServers").unwrap_or(value));
    contribution_count(value)
}

const MAX_PLUGIN_ARCHIVE_BYTES: u64 = 100 * 1024 * 1024;
const MAX_PLUGIN_ARCHIVE_ENTRY_BYTES: u64 = 100 * 1024 * 1024;
const MAX_PLUGIN_ARCHIVE_EXTRACTED_BYTES: u64 = 512 * 1024 * 1024;
const MAX_PLUGIN_ARCHIVE_ENTRIES: usize = 5_000;
const MAX_PLUGIN_ARCHIVE_PATH_DEPTH: usize = 20;

#[derive(Debug)]
struct ExtractedPluginArchive {
    _staging: tempfile::TempDir,
    root: PathBuf,
}

fn extract_plugin_archive(path: &Path) -> Result<ExtractedPluginArchive, AppError> {
    let metadata = std::fs::metadata(path)
        .map_err(|error| AppError::BadRequest(format!("cannot read plugin ZIP: {error}")))?;
    if metadata.len() > MAX_PLUGIN_ARCHIVE_BYTES {
        return Err(AppError::BadRequest(
            "plugin ZIP must be 100 MB or smaller".to_owned(),
        ));
    }
    let file = File::open(path)
        .map_err(|error| AppError::BadRequest(format!("cannot open plugin ZIP: {error}")))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| AppError::BadRequest(format!("invalid plugin ZIP: {error}")))?;
    if archive.is_empty() {
        return Err(AppError::BadRequest("plugin ZIP is empty".to_owned()));
    }
    if archive.len() > MAX_PLUGIN_ARCHIVE_ENTRIES {
        return Err(AppError::BadRequest(
            "plugin ZIP contains more than 5,000 entries".to_owned(),
        ));
    }

    let staging = tempfile::tempdir()
        .map_err(|error| AppError::Internal(format!("cannot stage plugin ZIP: {error}")))?;
    let mut extracted_bytes = 0_u64;
    let mut normalized_paths = BTreeSet::new();

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| AppError::BadRequest(format!("unreadable ZIP entry: {error}")))?;
        let raw_name = entry.name().to_owned();
        let path_name = raw_name.strip_suffix('/').unwrap_or(&raw_name);
        if raw_name.is_empty()
            || path_name.trim() != path_name
            || raw_name.contains('\\')
            || path_name
                .split('/')
                .any(|segment| segment.is_empty() || segment == "..")
        {
            return Err(AppError::BadRequest(format!(
                "unsafe ZIP entry path `{raw_name}`"
            )));
        }
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| AppError::BadRequest(format!("unsafe ZIP entry path `{raw_name}`")))?;
        if relative.components().count() > MAX_PLUGIN_ARCHIVE_PATH_DEPTH {
            return Err(AppError::BadRequest(format!(
                "ZIP entry path is too deep `{raw_name}`"
            )));
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(AppError::BadRequest(format!(
                "ZIP symlinks are not supported `{raw_name}`"
            )));
        }
        let normalized = raw_name.to_lowercase();
        if !normalized_paths.insert(normalized) {
            return Err(AppError::BadRequest(format!(
                "duplicate ZIP entry path `{raw_name}`"
            )));
        }

        let output = staging.path().join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&output).map_err(|error| {
                AppError::Internal(format!("cannot create ZIP directory: {error}"))
            })?;
            continue;
        }
        if !entry.is_file() {
            return Err(AppError::BadRequest(format!(
                "unsupported ZIP entry type `{raw_name}`"
            )));
        }
        if entry.size() > MAX_PLUGIN_ARCHIVE_ENTRY_BYTES {
            return Err(AppError::BadRequest(format!(
                "ZIP entry exceeds 100 MiB `{raw_name}`"
            )));
        }
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                AppError::Internal(format!("cannot create ZIP parent directory: {error}"))
            })?;
        }
        let mut destination = File::create(&output)
            .map_err(|error| AppError::Internal(format!("cannot extract ZIP entry: {error}")))?;
        let remaining_archive_bytes = MAX_PLUGIN_ARCHIVE_EXTRACTED_BYTES
            .checked_sub(extracted_bytes)
            .ok_or_else(|| AppError::BadRequest("plugin ZIP expands beyond 512 MiB".to_owned()))?;
        let entry_limit = MAX_PLUGIN_ARCHIVE_ENTRY_BYTES.min(remaining_archive_bytes);
        let copied = io::copy(&mut entry.by_ref().take(entry_limit + 1), &mut destination)
            .map_err(|error| AppError::BadRequest(format!("cannot read ZIP entry: {error}")))?;
        if copied > remaining_archive_bytes {
            return Err(AppError::BadRequest(
                "plugin ZIP expands beyond 512 MiB".to_owned(),
            ));
        }
        if copied > entry_limit {
            return Err(AppError::BadRequest(format!(
                "ZIP entry exceeds 100 MiB `{raw_name}`"
            )));
        }
        extracted_bytes = extracted_bytes
            .checked_add(copied)
            .ok_or_else(|| AppError::BadRequest("plugin ZIP extracted size overflow".to_owned()))?;
    }

    let root = resolve_extracted_plugin_root(staging.path())?;
    Ok(ExtractedPluginArchive {
        _staging: staging,
        root,
    })
}

fn resolve_extracted_plugin_root(staging: &Path) -> Result<PathBuf, AppError> {
    if has_supported_plugin_manifest(staging) {
        return Ok(staging.to_path_buf());
    }
    let entries = std::fs::read_dir(staging)
        .map_err(|error| AppError::Internal(format!("cannot inspect plugin ZIP: {error}")))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| AppError::Internal(format!("cannot inspect plugin ZIP: {error}")))?;
    if entries.len() != 1 || !entries[0].path().is_dir() {
        return Err(AppError::BadRequest(
            "plugin ZIP must contain exactly one plugin root".to_owned(),
        ));
    }
    let root = entries[0].path();
    if !has_supported_plugin_manifest(&root) {
        return Err(AppError::BadRequest(
            "plugin ZIP does not contain a supported plugin manifest".to_owned(),
        ));
    }
    Ok(root)
}

fn has_supported_plugin_manifest(root: &Path) -> bool {
    root.join(".vibex-plugin/plugin.json").is_file()
        || root.join(".codex-plugin/plugin.json").is_file()
        || root.join(".claude-plugin/plugin.json").is_file()
}

fn validate_import_package_kind(root: &Path, package_kind: Option<&str>) -> Result<(), AppError> {
    let expected_manifest = match package_kind {
        None => return Ok(()),
        Some("codex") => ".codex-plugin/plugin.json",
        Some("vibex") => ".vibex-plugin/plugin.json",
        Some(value) => {
            return Err(AppError::BadRequest(format!(
                "unsupported plugin package kind `{value}`"
            )));
        }
    };
    if !root.join(expected_manifest).is_file() {
        return Err(AppError::BadRequest(format!(
            "selected import format requires `{expected_manifest}`"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        fs::{self, File},
        io::Write,
    };

    use tempfile::tempdir;
    use zip::{ZipWriter, write::SimpleFileOptions};

    use super::*;

    #[test]
    fn extracts_one_nested_plugin_root_from_zip() {
        let fixture = tempdir().unwrap();
        let archive_path = fixture.path().join("plugin.zip");
        let file = File::create(&archive_path).unwrap();
        let mut archive = ZipWriter::new(file);
        archive
            .start_file(
                "demo/.vibex-plugin/plugin.json",
                SimpleFileOptions::default(),
            )
            .unwrap();
        archive.write_all(br#"{"id":"demo"}"#).unwrap();
        archive
            .start_file("demo/skills/demo/SKILL.md", SimpleFileOptions::default())
            .unwrap();
        archive.write_all(b"---\nname: demo\n---\n").unwrap();
        archive.finish().unwrap();

        let extracted = extract_plugin_archive(&archive_path).unwrap();

        assert!(extracted.root.join(".vibex-plugin/plugin.json").is_file());
        assert!(extracted.root.join("skills/demo/SKILL.md").is_file());
    }

    #[test]
    fn rejects_zip_entries_that_escape_the_staging_root() {
        let fixture = tempdir().unwrap();
        let archive_path = fixture.path().join("plugin.zip");
        let file = File::create(&archive_path).unwrap();
        let mut archive = ZipWriter::new(file);
        archive
            .start_file("../outside", SimpleFileOptions::default())
            .unwrap();
        archive.write_all(b"unsafe").unwrap();
        archive.finish().unwrap();

        let error = extract_plugin_archive(&archive_path).unwrap_err();

        assert!(error.to_string().contains("unsafe ZIP entry path"));
        assert!(!fixture.path().join("outside").exists());
    }

    #[test]
    fn reads_only_declared_skill_files_and_structured_mcp_servers() {
        let fixture = tempdir().unwrap();
        let skill_path = fixture.path().join("skills/research/SKILL.md");
        fs::create_dir_all(skill_path.parent().unwrap()).unwrap();
        fs::write(&skill_path, "# Research\n").unwrap();
        fs::write(
            fixture.path().join("skills/research/notes.md"),
            "not part of the preview",
        )
        .unwrap();
        let skills = vec![PluginSkillDto {
            id: "research".to_owned(),
            path: "skills/research/SKILL.md".to_owned(),
        }];
        let mcp = serde_json::json!({
            "mcpServers": {
                "research-mcp": {
                    "command": "research-mcp",
                    "args": ["serve"]
                }
            }
        });

        let contributions = read_plugin_contributions(fixture.path(), &skills, Some(&mcp)).unwrap();

        assert_eq!(contributions.skills.len(), 1);
        assert_eq!(contributions.skills[0].content, "# Research\n");
        assert_eq!(contributions.mcp_servers.len(), 1);
        assert_eq!(contributions.mcp_servers[0].id, "research-mcp");
        assert_eq!(
            contributions.mcp_servers[0].config["command"],
            "research-mcp"
        );
    }

    #[test]
    fn summarizes_sorted_mcp_names_without_configuration() {
        let mcp = serde_json::json!({
            "mcpServers": {
                "zeta": { "command": "zeta", "env": { "TOKEN": "secret" } },
                "alpha": { "command": "alpha" }
            }
        });

        assert_eq!(mcp_server_names(Some(&mcp)), vec!["alpha", "zeta"]);
    }

    #[test]
    fn discovers_native_hook_and_workflow_resources_without_reading_contents() {
        let fixture = tempdir().unwrap();
        fs::create_dir_all(fixture.path().join("hooks")).unwrap();
        fs::create_dir_all(fixture.path().join("workflows/research")).unwrap();
        fs::write(fixture.path().join("hooks/session-start.json"), "{}").unwrap();
        fs::write(
            fixture.path().join("workflows/research/workflow.json"),
            "{}",
        )
        .unwrap();
        fs::write(fixture.path().join("workflows/README.txt"), "ignore").unwrap();

        assert_eq!(
            discover_native_resources(fixture.path(), "hooks"),
            vec![PluginNativeResourceDto {
                id: "session-start".to_owned(),
                path: "hooks/session-start.json".to_owned(),
            }]
        );
        assert_eq!(
            discover_native_resources(fixture.path(), "workflows"),
            vec![PluginNativeResourceDto {
                id: "research/workflow".to_owned(),
                path: "workflows/research/workflow.json".to_owned(),
            }]
        );
    }
}
