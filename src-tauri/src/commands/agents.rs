use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
};

use agents::{
    AgentAutoApproveMode, AgentAvailableCommand, AgentConfigSurface, AgentConnectionId,
    AgentConnectionSnapshot, AgentContentBlock, AgentHistorySource, AgentInstallPlan,
    AgentMcpConfig, AgentMcpSurface, AgentPermissionId,
    AgentPermissionResponse, AgentPromptId, AgentPromptSnapshot, AgentRegistryEntry, AgentRuntime,
    AgentSessionId, AgentSessionSnapshot, AgentSkillsSurface, AgentTerminalId,
    AgentTerminalOutputSnapshot, AgentType, CancelAgentPromptInput, ConnectAgentInput,
    ImportedAgentSession, RespondAgentPermissionInput, ResumeAgentSessionInput, RuntimeSnapshot,
    SendAgentPromptInput, all_agent_types, claude_config_path, codex_config_path, config_surface,
    default_history_sources, default_mcp_config_path, import_history_source, mcp_file_config,
    mcp_surface, opencode_config_path, read_agent_mcp_config, registry_entry, skills_surface,
    terminal::agent_terminal_registry, write_agent_mcp_config,
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use db::models::{
    agent_setting::AgentSetting,
    conversation_bundle::{ConversationImportRecord, InsertConversationImport},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::{error::AppError, state::AppState};

impl From<agents::AgentError> for AppError {
    fn from(error: agents::AgentError) -> Self {
        match error {
            agents::AgentError::ConnectionNotFound(message)
            | agents::AgentError::SessionNotFound(message)
            | agents::AgentError::PromptNotFound(message)
            | agents::AgentError::UnsupportedAgent(message) => AppError::NotFound(message),
            agents::AgentError::UnsupportedPlatform { agent, platform } => AppError::BadRequest(
                format!("Agent `{agent}` is unsupported on platform `{platform}`"),
            ),
            agents::AgentError::InvalidDistribution(message)
            | agents::AgentError::Runtime(message) => AppError::Internal(message),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConnectRequest {
    pub agent_type: AgentType,
    pub workspace_id: String,
    pub working_dir: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentNewSessionRequest {
    pub connection_id: String,
    pub acp_session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSendPromptRequest {
    pub connection_id: String,
    pub session_id: String,
    pub text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCancelPromptRequest {
    pub connection_id: String,
    pub session_id: String,
    pub prompt_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRespondPermissionRequest {
    pub connection_id: String,
    pub permission_id: String,
    pub response: AgentPermissionResponse,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConnectionRequest {
    pub connection_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionRequest {
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSetAutoApproveRequest {
    pub agent_type: AgentType,
    pub auto_approve_mode: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentResumeSessionRequest {
    pub agent_type: AgentType,
    pub workspace_id: String,
    pub working_dir: String,
    pub session_id: String,
    pub external_session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTerminalSnapshotRequest {
    pub terminal_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTypeRequest {
    pub agent_type: AgentType,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHistoryImportRequest {
    pub agent_type: AgentType,
    pub path: Option<String>,
    pub workspace_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigReadRequest {
    pub agent_type: AgentType,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigWriteRequest {
    pub agent_type: AgentType,
    pub content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMcpWriteRequest {
    pub agent_type: AgentType,
    pub config: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigFileDto {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMcpConfigDto {
    pub path: String,
    pub config: Value,
    pub surface: AgentMcpConfig,
}

#[tauri::command]
pub async fn agent_registry_list() -> Result<Vec<AgentRegistryEntry>, AppError> {
    Ok(AgentRuntime::default().registry())
}

#[tauri::command]
pub async fn agent_config_surfaces() -> Result<Vec<AgentConfigSurface>, AppError> {
    Ok(all_agent_types().into_iter().map(config_surface).collect())
}

#[tauri::command]
pub async fn agent_mcp_surfaces() -> Result<Vec<AgentMcpSurface>, AppError> {
    Ok(all_agent_types().into_iter().map(mcp_surface).collect())
}

#[tauri::command]
pub async fn agent_skills_surfaces() -> Result<Vec<AgentSkillsSurface>, AppError> {
    Ok(all_agent_types().into_iter().map(skills_surface).collect())
}

#[tauri::command]
pub async fn agent_install_plans() -> Result<Vec<AgentInstallPlan>, AppError> {
    Ok(all_agent_types()
        .into_iter()
        .map(registry_entry)
        .map(|entry| AgentInstallPlan::from_registry_entry(&entry))
        .collect())
}

#[tauri::command]
pub async fn agent_runtime_snapshot(
    state: tauri::State<'_, AppState>,
) -> Result<RuntimeSnapshot, AppError> {
    // The live runtime is authoritative for pending permissions now that startup
    // recovery (ADR-0001) voids orphaned ones — the old merge from the retired
    // `agent_permissions` shadow table has no reason to exist (批次D).
    Ok(state.agent_runtime.snapshot().await)
}

#[tauri::command]
pub async fn agent_connection_snapshot(
    state: tauri::State<'_, AppState>,
    request: AgentConnectionRequest,
) -> Result<AgentConnectionSnapshot, AppError> {
    let connection_id = parse_agent_connection_id(&request.connection_id)?;
    state
        .agent_runtime
        .snapshot()
        .await
        .connections
        .into_iter()
        .find(|connection| connection.id == connection_id)
        .ok_or_else(|| AppError::NotFound(format!("Connection {connection_id} not found")))
}

#[tauri::command]
pub async fn agent_load_session(
    state: tauri::State<'_, AppState>,
    request: AgentSessionRequest,
) -> Result<AgentSessionSnapshot, AppError> {
    let session_id = parse_agent_session_id(&request.session_id)?;
    state
        .agent_runtime
        .snapshot()
        .await
        .sessions
        .into_iter()
        .find(|session| session.id == session_id)
        .ok_or_else(|| AppError::NotFound(format!("Agent session {session_id} not found")))
}

#[tauri::command]
pub async fn agent_list_session_commands(
    state: tauri::State<'_, AppState>,
    request: AgentSessionRequest,
) -> Result<Vec<AgentAvailableCommand>, AppError> {
    let session_id = parse_agent_session_id(&request.session_id)?;
    let snapshot = state.agent_runtime.snapshot().await;

    Ok(snapshot
        .events
        .iter()
        .rev()
        .find_map(|envelope| {
            if envelope.session_id != Some(session_id) {
                return None;
            }
            match &envelope.event {
                agents::AgentEvent::AvailableCommands { commands } => Some(commands.clone()),
                _ => None,
            }
        })
        .unwrap_or_default())
}

#[tauri::command]
pub async fn agent_set_auto_approve(
    state: tauri::State<'_, AppState>,
    request: AgentSetAutoApproveRequest,
) -> Result<(), AppError> {
    validate_auto_approve_mode(&request.auto_approve_mode)?;
    AgentSetting::update_preferences(
        &state.deployment.db().pool,
        agent_type_setting_key(request.agent_type),
        None,
        None,
        None,
        Some(&request.auto_approve_mode),
    )
    .await
    .map_err(|error| match error {
        db::models::agent_setting::AgentSettingError::NotFound => AppError::NotFound(format!(
            "Agent setting not found: {}",
            agent_type_setting_key(request.agent_type)
        )),
        db::models::agent_setting::AgentSettingError::Database(error) => {
            AppError::Internal(error.to_string())
        }
    })?;
    Ok(())
}

#[tauri::command]
pub async fn agent_connect(
    state: tauri::State<'_, AppState>,
    request: AgentConnectRequest,
) -> Result<AgentConnectionSnapshot, AppError> {
    let workspace_id = parse_uuid("workspace_id", &request.workspace_id)?;
    let launch_settings = agent_runtime_launch_settings(&state, request.agent_type).await?;
    state
        .agent_runtime
        .connect(ConnectAgentInput {
            agent_type: request.agent_type,
            workspace_id,
            working_dir: PathBuf::from(request.working_dir),
            auto_approve_mode: launch_settings.auto_approve_mode,
            env: launch_settings.env,
        })
        .await
        .map_err(Into::into)
}

pub(crate) struct AgentRuntimeLaunchSettings {
    pub(crate) auto_approve_mode: AgentAutoApproveMode,
    pub(crate) env: HashMap<String, String>,
}

async fn agent_runtime_launch_settings(
    state: &tauri::State<'_, AppState>,
    agent_type: AgentType,
) -> Result<AgentRuntimeLaunchSettings, AppError> {
    agent_runtime_launch_settings_from_pool(&state.deployment.db().pool, agent_type).await
}

/// Pool-based variant of [`agent_runtime_launch_settings`] so non-command code
/// (the delegation spawner) can resolve a child agent's auto-approve mode + env
/// without a `tauri::State`.
pub(crate) async fn agent_runtime_launch_settings_from_pool(
    pool: &sqlx::SqlitePool,
    agent_type: AgentType,
) -> Result<AgentRuntimeLaunchSettings, AppError> {
    let setting = AgentSetting::find_by_type(pool, agent_type_setting_key(agent_type)).await?;
    let auto_approve_mode = setting
        .as_ref()
        .map(|setting| AgentAutoApproveMode::from_setting(&setting.auto_approve_mode))
        .unwrap_or_default();
    let env = parse_agent_env_json(
        setting
            .as_ref()
            .and_then(|setting| setting.env_json.as_deref()),
    )?;
    Ok(AgentRuntimeLaunchSettings {
        auto_approve_mode,
        env,
    })
}

fn parse_agent_env_json(value: Option<&str>) -> Result<HashMap<String, String>, AppError> {
    let Some(value) = value.filter(|value| !value.trim().is_empty()) else {
        return Ok(HashMap::new());
    };
    let parsed: Value = serde_json::from_str(value)
        .map_err(|error| AppError::BadRequest(format!("Invalid env JSON: {error}")))?;
    let Some(object) = parsed.as_object() else {
        return Err(AppError::BadRequest(
            "Agent env JSON must be an object".to_string(),
        ));
    };

    let mut env = HashMap::new();
    for (key, value) in object {
        if value.is_null() {
            continue;
        }
        let Some(value) = value
            .as_str()
            .map(str::to_string)
            .or_else(|| value.as_bool().map(|value| value.to_string()))
            .or_else(|| value.as_number().map(|value| value.to_string()))
        else {
            return Err(AppError::BadRequest(format!(
                "Agent env value for {key} must be a string, number, boolean, or null"
            )));
        };
        env.insert(key.clone(), value);
    }
    Ok(env)
}

fn agent_type_setting_key(agent_type: AgentType) -> &'static str {
    match agent_type {
        AgentType::ClaudeCode => "claude_code",
        AgentType::Codex => "codex",
        AgentType::OpenCode => "open_code",
        AgentType::Gemini => "gemini",
        AgentType::OpenClaw => "open_claw",
        AgentType::Cline => "cline",
        AgentType::Hermes => "hermes",
    }
}

fn validate_auto_approve_mode(mode: &str) -> Result<(), AppError> {
    match mode {
        "off" | "allow_always" | "yolo" => Ok(()),
        mode => Err(AppError::BadRequest(format!(
            "Unsupported auto approve mode: {mode}"
        ))),
    }
}

#[tauri::command]
pub async fn agent_new_session(
    state: tauri::State<'_, AppState>,
    request: AgentNewSessionRequest,
) -> Result<AgentSessionSnapshot, AppError> {
    let connection_id = parse_agent_connection_id(&request.connection_id)?;
    state
        .agent_runtime
        .new_session(
            connection_id,
            request
                .acp_session_id
                .unwrap_or_else(|| format!("pending-{connection_id}")),
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn agent_resume_session(
    state: tauri::State<'_, AppState>,
    request: AgentResumeSessionRequest,
) -> Result<AgentSessionSnapshot, AppError> {
    let launch_settings = agent_runtime_launch_settings(&state, request.agent_type).await?;
    state
        .agent_runtime
        .resume_session(ResumeAgentSessionInput {
            agent_type: request.agent_type,
            workspace_id: parse_uuid("workspace_id", &request.workspace_id)?,
            working_dir: PathBuf::from(request.working_dir),
            session_id: parse_agent_session_id(&request.session_id)?,
            external_session_id: request.external_session_id,
            auto_approve_mode: launch_settings.auto_approve_mode,
            env: launch_settings.env,
        })
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn agent_send_prompt(
    state: tauri::State<'_, AppState>,
    request: AgentSendPromptRequest,
) -> Result<AgentPromptSnapshot, AppError> {
    state
        .agent_runtime
        .send_prompt(SendAgentPromptInput {
            connection_id: parse_agent_connection_id(&request.connection_id)?,
            session_id: parse_agent_session_id(&request.session_id)?,
            blocks: text_prompt_blocks(request.text),
            mode_override: None,
            config_overrides: Vec::new(),
        })
        .await
        .map_err(Into::into)
}

/// Restore the workspace to the checkpoint recorded before the given user
/// message (its `ordinal`). Destructive when `perform_git_reset` is set; the ACP
/// transcript is append-only and is not truncated. Used by retry/rollback.
#[tauri::command]
pub async fn agent_reset_to_checkpoint(
    state: tauri::State<'_, AppState>,
    session_id: String,
    ordinal: i64,
    perform_git_reset: Option<bool>,
    force_when_dirty: Option<bool>,
) -> Result<(), AppError> {
    let session_id = parse_uuid("session_id", &session_id)?;
    state
        .deployment
        .container()
        .reset_agent_session_to_checkpoint(
            session_id,
            ordinal,
            perform_git_reset.unwrap_or(true),
            force_when_dirty.unwrap_or(false),
        )
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn agent_cancel_prompt(
    state: tauri::State<'_, AppState>,
    request: AgentCancelPromptRequest,
) -> Result<(), AppError> {
    state
        .agent_runtime
        .cancel_prompt(CancelAgentPromptInput {
            connection_id: parse_agent_connection_id(&request.connection_id)?,
            session_id: parse_agent_session_id(&request.session_id)?,
            prompt_id: parse_agent_prompt_id(&request.prompt_id)?,
        })
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn agent_disconnect(
    state: tauri::State<'_, AppState>,
    request: AgentConnectionRequest,
) -> Result<AgentConnectionSnapshot, AppError> {
    state
        .agent_runtime
        .disconnect(parse_agent_connection_id(&request.connection_id)?)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn agent_respond_permission(
    state: tauri::State<'_, AppState>,
    request: AgentRespondPermissionRequest,
) -> Result<(), AppError> {
    state
        .agent_runtime
        .respond_permission(RespondAgentPermissionInput {
            connection_id: parse_agent_connection_id(&request.connection_id)?,
            permission_id: parse_agent_permission_id(&request.permission_id)?,
            response: request.response,
        })
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn agent_terminal_snapshot(
    request: AgentTerminalSnapshotRequest,
) -> Result<Option<AgentTerminalOutputSnapshot>, AppError> {
    Ok(agent_terminal_registry()
        .snapshot_output(parse_agent_terminal_id(&request.terminal_id)?)
        .await)
}

#[tauri::command]
pub async fn agent_history_sources(
    request: AgentTypeRequest,
) -> Result<Vec<AgentHistorySource>, AppError> {
    Ok(default_history_sources(request.agent_type))
}

#[tauri::command]
pub async fn agent_history_import(
    state: tauri::State<'_, AppState>,
    request: AgentHistoryImportRequest,
) -> Result<Vec<ImportedAgentSession>, AppError> {
    let workspace_id = request
        .workspace_id
        .as_deref()
        .map(|id| parse_uuid("workspace_id", id))
        .transpose()?;
    let sources = match request.path {
        Some(path) => vec![AgentHistorySource {
            agent_type: request.agent_type,
            path: PathBuf::from(path),
        }],
        None => default_history_sources(request.agent_type)
            .into_iter()
            .filter(|source| source.path.exists())
            .collect(),
    };

    let mut imported = Vec::new();
    for source in sources {
        let sessions = import_history_source(&source).map_err(agent_history_error)?;
        for session in &sessions {
            persist_history_import(&state, session).await?;
            if let Some(workspace_id) = workspace_id {
                crate::commands::conversations::import_agent_session_to_conversation_events(
                    &state.deployment.db().pool,
                    workspace_id,
                    session,
                )
                .await?;
            }
        }
        imported.extend(sessions);
    }
    Ok(imported)
}

#[tauri::command]
pub async fn agent_config_read(
    request: AgentConfigReadRequest,
) -> Result<Option<AgentConfigFileDto>, AppError> {
    let Some(path) = default_config_path(request.agent_type) else {
        return Ok(None);
    };
    let content = tokio::fs::read_to_string(&path).await.unwrap_or_default();
    Ok(Some(AgentConfigFileDto {
        path: path.display().to_string(),
        content,
    }))
}

#[tauri::command]
pub async fn agent_config_write(request: AgentConfigWriteRequest) -> Result<(), AppError> {
    let path = default_config_path(request.agent_type).ok_or_else(|| {
        AppError::NotFound(format!(
            "No default config file is available for {:?}",
            request.agent_type
        ))
    })?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| AppError::Internal(error.to_string()))?;
    }
    tokio::fs::write(path, request.content)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))
}

#[tauri::command]
pub async fn agent_mcp_list(
    request: AgentTypeRequest,
) -> Result<Option<AgentMcpConfigDto>, AppError> {
    let Some(path) = default_mcp_config_path(request.agent_type) else {
        return Ok(None);
    };
    let Some(surface) = mcp_file_config(request.agent_type) else {
        return Ok(None);
    };
    let config = read_agent_mcp_config(&path, &surface)
        .await
        .map_err(AppError::from)?;
    Ok(Some(AgentMcpConfigDto {
        path: path.display().to_string(),
        config,
        surface,
    }))
}

#[tauri::command]
pub async fn agent_mcp_write(request: AgentMcpWriteRequest) -> Result<(), AppError> {
    let path = default_mcp_config_path(request.agent_type).ok_or_else(|| {
        AppError::NotFound(format!(
            "No default MCP config file is available for {:?}",
            request.agent_type
        ))
    })?;
    let surface = mcp_file_config(request.agent_type).ok_or_else(|| {
        AppError::NotFound(format!(
            "No MCP config adapter is available for {:?}",
            request.agent_type
        ))
    })?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| AppError::Internal(error.to_string()))?;
    }
    write_agent_mcp_config(&path, &surface, &request.config)
        .await
        .map_err(AppError::from)
}

fn parse_uuid(label: &str, value: &str) -> Result<Uuid, AppError> {
    Uuid::parse_str(value).map_err(|_| AppError::BadRequest(format!("Invalid {label}: {value}")))
}

fn parse_agent_connection_id(value: &str) -> Result<AgentConnectionId, AppError> {
    parse_uuid("connection_id", value).map(AgentConnectionId)
}

fn parse_agent_session_id(value: &str) -> Result<AgentSessionId, AppError> {
    parse_uuid("session_id", value).map(AgentSessionId)
}

fn parse_agent_prompt_id(value: &str) -> Result<AgentPromptId, AppError> {
    parse_uuid("prompt_id", value).map(AgentPromptId)
}

fn parse_agent_permission_id(value: &str) -> Result<AgentPermissionId, AppError> {
    parse_uuid("permission_id", value).map(AgentPermissionId)
}

fn parse_agent_terminal_id(value: &str) -> Result<AgentTerminalId, AppError> {
    parse_uuid("terminal_id", value).map(AgentTerminalId)
}

async fn persist_history_import(
    state: &tauri::State<'_, AppState>,
    session: &ImportedAgentSession,
) -> Result<(), AppError> {
    // The `agent_history_imports` shadow table is retired (批次D); history-import
    // metadata now lives in the canonical `conversation_imports` table. Title /
    // workspace_path / message_count aren't columns there, but the full session is
    // preserved in `raw_json`.
    let raw_json =
        serde_json::to_string(session).map_err(|error| AppError::Internal(error.to_string()))?;
    let source_agent = serde_json::to_value(session.source_agent)
        .map_err(|error| AppError::Internal(error.to_string()))?
        .as_str()
        .unwrap_or("unknown")
        .to_string();
    let raw_source_path = session
        .raw_source_path
        .as_ref()
        .and_then(|path| path.to_str())
        .map(str::to_string);
    ConversationImportRecord::insert(
        &state.deployment.db().pool,
        InsertConversationImport {
            id: Uuid::new_v4(),
            source: "agent_transcript",
            source_agent: Some(&source_agent),
            external_session_id: Some(&session.external_session_id),
            bundle_version: None,
            raw_source_path: raw_source_path.as_deref(),
            imported_conversation_id: None,
            raw_json: &raw_json,
        },
    )
    .await?;
    Ok(())
}

fn default_config_path(agent_type: AgentType) -> Option<PathBuf> {
    match agent_type {
        AgentType::ClaudeCode => claude_config_path(),
        AgentType::Codex => codex_config_path(),
        AgentType::OpenCode => opencode_config_path(),
        AgentType::Gemini | AgentType::OpenClaw | AgentType::Cline | AgentType::Hermes => None,
    }
}

fn agent_history_error(error: agents::AgentHistoryError) -> AppError {
    match error {
        agents::AgentHistoryError::MissingSource(path) => AppError::NotFound(format!(
            "Agent history source not found: {}",
            path.display()
        )),
        agents::AgentHistoryError::Read { path, error }
        | agents::AgentHistoryError::Parse { path, error } => AppError::Internal(format!(
            "Failed to import agent history from {}: {error}",
            path.display()
        )),
    }
}

fn text_prompt_blocks(text: String) -> Vec<AgentContentBlock> {
    if text.trim().is_empty() {
        Vec::new()
    } else {
        vec![AgentContentBlock::Text { text }]
    }
}

pub(crate) async fn workspace_prompt_blocks(
    working_dir: &str,
    text: String,
    images: &[String],
) -> Result<Vec<AgentContentBlock>, AppError> {
    let mut blocks = text_prompt_blocks(text);
    for image in images {
        blocks.push(read_workspace_image_block(working_dir, image).await?);
    }
    if blocks.is_empty() {
        return Err(AppError::BadRequest(
            "Prompt must include text or an image".to_string(),
        ));
    }
    Ok(blocks)
}

async fn read_workspace_image_block(
    working_dir: &str,
    relative_path: &str,
) -> Result<AgentContentBlock, AppError> {
    let relative = relative_agent_asset_path(relative_path)?;
    let file_path = Path::new(working_dir).join(&relative);
    if !file_path.is_file() {
        return Err(AppError::NotFound(format!(
            "Image not found: {relative_path}"
        )));
    }

    let bytes = tokio::fs::read(&file_path).await.map_err(|err| {
        AppError::Internal(format!("Failed to read image {relative_path}: {err}"))
    })?;

    Ok(AgentContentBlock::Image {
        data: BASE64.encode(bytes),
        mime_type: mime_type_for_agent_asset(&file_path).to_string(),
        uri: Some(relative.to_string_lossy().replace('\\', "/")),
    })
}

fn relative_agent_asset_path(path: &str) -> Result<PathBuf, AppError> {
    let candidate = Path::new(path);
    if candidate.is_absolute() {
        return Err(AppError::BadRequest(format!(
            "Image path must be workspace-relative: {path}"
        )));
    }

    let mut relative = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Normal(segment) => relative.push(segment),
            Component::CurDir => {}
            _ => {
                return Err(AppError::BadRequest(format!(
                    "Image path must stay inside the workspace: {path}"
                )));
            }
        }
    }

    if relative.as_os_str().is_empty() {
        return Err(AppError::BadRequest(
            "Image path cannot be empty".to_string(),
        ));
    }

    Ok(relative)
}

fn mime_type_for_agent_asset(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
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
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_agent_env_json_accepts_scalar_object_values() {
        let env = parse_agent_env_json(Some(
            r#"{
                "STRING_VALUE": "value",
                "NUMBER_VALUE": 42,
                "BOOL_VALUE": true,
                "NULL_VALUE": null
            }"#,
        ))
        .unwrap();

        assert_eq!(env.get("STRING_VALUE").map(String::as_str), Some("value"));
        assert_eq!(env.get("NUMBER_VALUE").map(String::as_str), Some("42"));
        assert_eq!(env.get("BOOL_VALUE").map(String::as_str), Some("true"));
        assert!(!env.contains_key("NULL_VALUE"));
    }

    #[test]
    fn parse_agent_env_json_rejects_non_object_root() {
        let err = parse_agent_env_json(Some(r#"["HTTP_PROXY"]"#)).unwrap_err();

        assert!(
            matches!(err, AppError::BadRequest(message) if message == "Agent env JSON must be an object")
        );
    }

    #[test]
    fn parse_agent_env_json_rejects_nested_values() {
        let err =
            parse_agent_env_json(Some(r#"{"HTTP_PROXY": {"url": "http://proxy"}}"#)).unwrap_err();

        assert!(matches!(err, AppError::BadRequest(message) if message.contains("HTTP_PROXY")));
    }
}
