use std::path::PathBuf;

use agents::{
    AgentConfigSurface, AgentConnectionId, AgentConnectionSnapshot, AgentInstallPlan,
    AgentMcpSurface, AgentPromptId, AgentPromptSnapshot, AgentRegistryEntry, AgentRuntime,
    AgentSessionId, AgentSessionSnapshot, AgentSkillsSurface, AgentType,
    CancelAgentPromptInput, ConnectAgentInput, RuntimeSnapshot, SendAgentPromptInput,
    all_agent_types, config_surface, mcp_surface, registry_entry, skills_surface,
};
use serde::Deserialize;
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
            text: request.text,
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
