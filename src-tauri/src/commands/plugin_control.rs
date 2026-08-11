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
use sha2::{Digest, Sha256};
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
pub struct PluginControlItemDto {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub enabled: bool,
    pub builtin: bool,
    pub shell_trusted: bool,
    pub source_kind: String,
    pub source_path: String,
    pub formats: Vec<String>,
    pub skills: Vec<PluginSkillDto>,
    pub runtimes: Vec<PluginRuntimeContributionDto>,
    pub warnings: Vec<PluginWarningDto>,
    pub mcp_count: u32,
    pub mcp_servers: Vec<String>,
    pub invocation_count: u32,
    pub invocations: Vec<PluginInvocationDto>,
    pub native_managed: bool,
    pub enable_supported: bool,
    pub update_supported: bool,
    pub uninstall_supported: bool,
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
    pub installer: String,
    pub install_command: Option<String>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PluginRuntimeDto {
    pub id: String,
    pub version: String,
    pub executable_path: String,
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
pub struct PluginRuntimeConflictDto {
    pub runtime_id: String,
    pub current_version: String,
    pub target_version: String,
    pub affected_plugins: Vec<String>,
    pub affected_automations: Vec<String>,
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
                    required_skills: invocation.skill.into_iter().collect(),
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
            referenced_plugins: plugins
                .iter()
                .filter(|plugin| {
                    plugin
                        .runtimes
                        .iter()
                        .any(|required| required.id == runtime.id)
                })
                .map(|plugin| plugin.id.clone())
                .collect(),
            id: runtime.id,
            version: runtime.version,
            executable_path: runtime.executable_path.to_string_lossy().into_owned(),
            installer: runtime.installer,
            probe: runtime.probe,
        })
        .collect();
    Ok(PluginControlCatalogDto { plugins, runtimes })
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
        return read_plugin_contributions(&plugin.source.path, &skills, plugin.manifest.get("mcp"));
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
    let conflict = state
        .plugin_control_plane
        .preview_import(&package)
        .await
        .map_err(plugin_error)?
        .map(|conflict| PluginImportConflictDto {
            plugin_id: conflict.plugin_id,
            installed_source: conflict.installed_source.to_string_lossy().into_owned(),
            incoming_source: conflict.incoming_source.to_string_lossy().into_owned(),
        });
    let mut preview = PluginImportPreviewDto {
        plugin: plugin_dto(plugins::InstalledPlugin {
            package,
            activation: plugins::PluginActivation::Disabled,
            shell_trusted: false,
        }),
        conflict,
    };
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
    if state
        .plugin_control_plane
        .preview_import(&incoming)
        .await
        .map_err(plugin_error)?
        .is_some()
    {
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
    if decision == plugins::ConflictDecision::Replace
        && let Some(installed) = state
            .plugin_control_plane
            .plugin(package.id.as_str())
            .await
            .map_err(plugin_error)?
    {
        remove_plugin_projections(&installed).await?;
    }
    let result = state
        .plugin_control_plane
        .import(package, decision)
        .await
        .map_err(plugin_error)?;
    Ok(plugin_dto(result.plugin))
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
            "UPDATE plugin_control_agent_bindings
             SET applied = 0, pending_reason = 'plugin_disabled', updated_at = CURRENT_TIMESTAMP
             WHERE plugin_id = ?",
        )
        .bind(&plugin_id)
        .execute(&state.deployment.db().pool)
        .await?;
        sqlx::query(
            "UPDATE plugin_control_mcp_bindings
             SET applied = 0, updated_at = CURRENT_TIMESTAMP WHERE plugin_id = ?",
        )
        .bind(&plugin_id)
        .execute(&state.deployment.db().pool)
        .await?;
    }
    if plugin_id == "vibex.office" {
        state
            .office_runtime
            .set_bundled_enabled(enabled, &format!("plugin-control-{}", uuid::Uuid::new_v4()))
            .await
            .map_err(|error| AppError::Internal(error.to_string()))?;
        if enabled
            && let Some(lock) = state
                .office_runtime
                .detect()
                .await
                .map_err(|error| AppError::Internal(error.to_string()))?
        {
            state
                .plugin_control_plane
                .record_runtime(plugins::RuntimeInstallation {
                    id: lock.tool_id,
                    version: lock.version,
                    executable_path: state
                        .office_runtime
                        .global_executable_path()
                        .map_err(|error| AppError::Internal(error.to_string()))?,
                    installer: "vibex_bundled_binary".to_owned(),
                    probe: vec!["--version".to_owned()],
                })
                .await
                .map_err(plugin_error)?;
        }
    }
    state
        .plugin_control_plane
        .set_enabled(&plugin_id, enabled)
        .await
        .map(plugin_dto)
        .map_err(plugin_error)
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
pub async fn plugin_control_preview_runtime_install(
    state: State<'_, AppState>,
    plugin_id: String,
    runtime_id: String,
) -> Result<Option<PluginRuntimeConflictDto>, AppError> {
    let conflict = state
        .plugin_control_plane
        .preview_runtime_install(&plugin_id, &runtime_id)
        .await
        .map_err(plugin_error)?;
    match conflict {
        Some(conflict) => Ok(Some(runtime_conflict_dto(&state, conflict).await?)),
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn plugin_control_install_runtime(
    app: AppHandle,
    state: State<'_, AppState>,
    plugin_id: String,
    runtime_id: String,
    confirm_conflict: bool,
) -> Result<PluginRuntimeDto, AppError> {
    let plugin = state
        .plugin_control_plane
        .plugin(&plugin_id)
        .await
        .map_err(plugin_error)?
        .ok_or_else(|| AppError::NotFound(plugin_id.clone()))?;
    let runtime = plugin
        .runtimes
        .iter()
        .find(|runtime| runtime.id == runtime_id)
        .ok_or_else(|| AppError::NotFound(runtime_id.clone()))?;
    let conflict = state
        .plugin_control_plane
        .preview_runtime_install(&plugin_id, &runtime_id)
        .await
        .map_err(plugin_error)?;
    if conflict.is_some() && !confirm_conflict {
        return Err(AppError::Conflict(
            "Runtime version replacement requires explicit confirmation".to_owned(),
        ));
    }

    let host = plugins::SystemGlobalRuntimeHost;
    let command_sha256 = match &runtime.install {
        plugins::RuntimeInstall::Shell { command } => {
            Some(format!("{:x}", Sha256::digest(command.as_bytes())))
        }
        _ => None,
    };
    record_plugin_audit(
        &state,
        &plugin_id,
        "runtime_install_started",
        serde_json::json!({
            "runtimeId": runtime.id,
            "installer": runtime_installer(&runtime.install),
            "sourcePath": plugin.source.path,
            "commandSha256": command_sha256,
        }),
    )
    .await?;
    let installation = match plugins::GlobalRuntimeInstaller::new(&host)
        .install(&plugin_id, plugin.shell_trusted, runtime)
        .await
    {
        Ok(installation) => installation,
        Err(error) => {
            record_plugin_audit(
                &state,
                &plugin_id,
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
        .record_runtime(installation.clone())
        .await
        .map_err(plugin_error)?;
    if let Some(conflict) = conflict {
        for affected in conflict.affected_plugins {
            uninstall_portable_plugin(&app, &state, &affected).await?;
        }
    }
    record_plugin_audit(
        &state,
        &plugin_id,
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
    Ok(PluginRuntimeDto {
        id: installation.id,
        version: installation.version,
        executable_path: installation.executable_path.to_string_lossy().into_owned(),
        installer: installation.installer,
        probe: installation.probe,
        referenced_plugins: vec![plugin_id],
    })
}

#[tauri::command]
pub async fn plugin_control_set_shell_trust(
    state: State<'_, AppState>,
    plugin_id: String,
    trusted: bool,
) -> Result<(), AppError> {
    if trusted {
        state
            .plugin_control_plane
            .grant_shell_trust(&plugin_id)
            .await
            .map_err(plugin_error)
    } else {
        state
            .plugin_control_plane
            .revoke_shell_trust(&plugin_id)
            .await
            .map_err(plugin_error)
    }
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
    mcp_server_names(plugin.manifest.get("mcp"))
        .into_iter()
        .map(|server_id| format!("{}.{}", plugin.id(), server_id))
        .collect()
}

async fn runtime_conflict_dto(
    state: &AppState,
    conflict: plugins::RuntimeConflict,
) -> Result<PluginRuntimeConflictDto, AppError> {
    let affected_automations = affected_automation_ids(state, &conflict.affected_plugins).await?;
    Ok(PluginRuntimeConflictDto {
        runtime_id: conflict.runtime_id,
        current_version: conflict.current_version,
        target_version: conflict.target_version,
        affected_plugins: conflict.affected_plugins,
        affected_automations,
    })
}

async fn affected_automation_ids(
    state: &AppState,
    plugin_ids: &[String],
) -> Result<Vec<String>, AppError> {
    if plugin_ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT id, plugin_action_json FROM automations WHERE plugin_action_json IS NOT NULL",
    )
    .fetch_all(&state.deployment.db().pool)
    .await?;
    Ok(rows
        .into_iter()
        .filter(|(_, raw)| {
            raw.as_deref().is_some_and(|raw| {
                plugin_ids
                    .iter()
                    .any(|plugin_id| raw.contains(plugin_id.as_str()))
            })
        })
        .map(|(id, _)| id)
        .collect())
}

async fn record_plugin_audit(
    state: &AppState,
    plugin_id: &str,
    operation: &str,
    summary: serde_json::Value,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO plugin_control_audit (plugin_id, operation, summary_json, created_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
    )
    .bind(plugin_id)
    .bind(operation)
    .bind(summary.to_string())
    .execute(&state.deployment.db().pool)
    .await?;
    Ok(())
}

fn plugin_dto(plugin: plugins::InstalledPlugin) -> PluginControlItemDto {
    PluginControlItemDto {
        id: plugin.id().to_owned(),
        name: plugin.name.clone(),
        version: plugin.version.clone(),
        description: plugin.description.clone(),
        enabled: plugin.activation == plugins::PluginActivation::Enabled,
        builtin: plugin.source.kind == plugins::PluginSourceKind::Builtin,
        shell_trusted: plugin.shell_trusted,
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
                installer: runtime_installer(&runtime.install).to_owned(),
                install_command: match &runtime.install {
                    plugins::RuntimeInstall::Shell { command } => Some(command.clone()),
                    _ => None,
                },
            })
            .collect(),
        mcp_count: mcp_contribution_count(plugin.manifest.get("mcp")),
        mcp_servers: mcp_server_names(plugin.manifest.get("mcp")),
        invocation_count: contribution_count(plugin.manifest.get("actions"))
            .saturating_add(contribution_count(plugin.manifest.get("commands"))),
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
        warnings: plugin
            .warnings
            .iter()
            .map(|warning| PluginWarningDto {
                code: warning.code.clone(),
                message: warning.message.clone(),
                contribution: warning.contribution.clone(),
            })
            .collect(),
        native_managed: false,
        enable_supported: true,
        update_supported: false,
        uninstall_supported: plugin.source.kind != plugins::PluginSourceKind::Builtin,
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
        name: plugin.name,
        version: plugin.version.unwrap_or_else(|| "unknown".to_owned()),
        description: None,
        enabled: plugin.enabled.unwrap_or(false),
        builtin: false,
        shell_trusted: false,
        source_kind: source_kind.to_owned(),
        source_path: plugin.path.to_string_lossy().into_owned(),
        formats: vec![format.to_owned()],
        skills,
        runtimes: Vec::new(),
        warnings: Vec::new(),
        mcp_count,
        mcp_servers,
        invocation_count: 0,
        invocations: Vec::new(),
        native_managed: true,
        enable_supported: capabilities.enable,
        update_supported: capabilities.update,
        uninstall_supported: capabilities.uninstall,
    }
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
            "INSERT INTO plugin_control_agent_bindings
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
    if let Err(error) = sqlx::query("DELETE FROM plugin_control_mcp_bindings WHERE plugin_id = ?")
        .bind(plugin.id())
        .execute(pool)
        .await
    {
        return vec![format!("control-plane binding reset: {error}")];
    }
    let Some(raw_mcp) = plugin.manifest.get("mcp") else {
        return Vec::new();
    };
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
        for agent_id in desired {
            if let Err(error) = sqlx::query(
                "INSERT INTO plugin_control_mcp_bindings
                     (plugin_id, mcp_id, agent_id, desired, applied, error_code, error_message, updated_at)
                 VALUES (?, ?, ?, 1, ?, ?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(plugin_id, mcp_id, agent_id) DO UPDATE SET
                     desired = 1,
                     applied = excluded.applied,
                     error_code = excluded.error_code,
                     error_message = excluded.error_message,
                     updated_at = CURRENT_TIMESTAMP",
            )
            .bind(plugin.id())
            .bind(&server_id)
            .bind(agent_id)
            .bind(i64::from(error_message.is_none()))
            .bind(error_message.as_ref().map(|_| "mcp_projection_failed"))
            .bind(error_message.as_deref())
            .execute(pool)
            .await
            {
                errors.push(format!("{server_id}/{agent_id} binding: {error}"));
            }
        }
    }
    errors
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
        plugins::RuntimeInstall::Shell { .. } => "shell",
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
}
