use std::{
    path::{Component, Path, PathBuf},
};

use agents::{
    AgentContentBlock,
    AgentConfigSurface, AgentConnectionId, AgentConnectionSnapshot, AgentInstallPlan,
    AgentMcpSurface, AgentPromptId, AgentPromptSnapshot, AgentRegistryEntry, AgentRuntime,
    AgentPermissionId, AgentPermissionResponse, AgentSessionId, AgentSessionSnapshot,
    AgentSkillsSurface, AgentType, CancelAgentPromptInput, ConnectAgentInput,
    RespondAgentPermissionInput, RuntimeSnapshot, SendAgentPromptInput,
    all_agent_types, config_surface, mcp_surface, registry_entry, skills_surface,
    EnsureAgentSessionInput,
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use db::models::{workspace::Workspace, workspace_repo::WorkspaceRepo};
use serde::Deserialize;
use uuid::Uuid;

use crate::{
    error::AppError, state::AppState, workspace_paths::resolve_workspace_agent_working_dir,
};

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
pub struct AgentSendWorkspacePromptRequest {
    pub agent_type: AgentType,
    pub workspace_id: String,
    pub session_id: String,
    pub text: String,
    #[serde(default)]
    pub images: Vec<String>,
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
    Ok(state.agent_runtime.snapshot().await)
}

#[tauri::command]
pub async fn agent_connect(
    state: tauri::State<'_, AppState>,
    request: AgentConnectRequest,
) -> Result<AgentConnectionSnapshot, AppError> {
    let workspace_id = parse_uuid("workspace_id", &request.workspace_id)?;
    state
        .agent_runtime
        .connect(ConnectAgentInput {
            agent_type: request.agent_type,
            workspace_id,
            working_dir: PathBuf::from(request.working_dir),
        })
        .await
        .map_err(Into::into)
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
        })
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn agent_send_workspace_prompt(
    state: tauri::State<'_, AppState>,
    request: AgentSendWorkspacePromptRequest,
) -> Result<AgentPromptSnapshot, AppError> {
    let workspace_id = parse_uuid("workspace_id", &request.workspace_id)?;
    let session_id = parse_agent_session_id(&request.session_id)?;
    let pool = &state.deployment.db().pool;
    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {workspace_id} not found")))?;
    let container_ref = state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let working_dir = resolve_workspace_agent_working_dir(&workspace, &container_ref, &repos)
        .unwrap_or_else(|| container_ref.clone());
    let blocks = workspace_prompt_blocks(&working_dir, request.text, &request.images)?;

    let session = state
        .agent_runtime
        .ensure_session(EnsureAgentSessionInput {
            agent_type: request.agent_type,
            workspace_id,
            working_dir: PathBuf::from(working_dir),
            session_id,
            acp_session_id: request.session_id.clone(),
        })
        .await?;

    state
        .agent_runtime
        .send_prompt(SendAgentPromptInput {
            connection_id: session.connection_id,
            session_id: session.id,
            blocks,
        })
        .await
        .map_err(Into::into)
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

fn text_prompt_blocks(text: String) -> Vec<AgentContentBlock> {
    if text.trim().is_empty() {
        Vec::new()
    } else {
        vec![AgentContentBlock::Text { text }]
    }
}

fn workspace_prompt_blocks(
    working_dir: &str,
    text: String,
    images: &[String],
) -> Result<Vec<AgentContentBlock>, AppError> {
    let mut blocks = text_prompt_blocks(text);
    for image in images {
        blocks.push(read_workspace_image_block(working_dir, image)?);
    }
    if blocks.is_empty() {
        return Err(AppError::BadRequest("Prompt must include text or an image".to_string()));
    }
    Ok(blocks)
}

fn read_workspace_image_block(
    working_dir: &str,
    relative_path: &str,
) -> Result<AgentContentBlock, AppError> {
    let relative = relative_agent_asset_path(relative_path)?;
    let file_path = Path::new(working_dir).join(&relative);
    if !file_path.is_file() {
        return Err(AppError::NotFound(format!("Image not found: {relative_path}")));
    }

    let bytes = std::fs::read(&file_path).map_err(|err| {
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
        return Err(AppError::BadRequest("Image path cannot be empty".to_string()));
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
