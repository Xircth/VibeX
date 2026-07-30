use std::path::PathBuf;

use agents::{
    AgentAvailableCommand, AgentConnectionId, AgentConnectionSnapshot, AgentContentBlock,
    AgentPermissionId, AgentPermissionResponse, AgentPreparedSessionSnapshot, AgentPromptId,
    AgentPromptSnapshot, AgentSessionControlsSnapshot, AgentSessionId, AgentSessionSnapshot,
    AgentTerminalId, AgentTerminalOutputSnapshot, CancelAgentPromptInput, ConnectAgentInput,
    RespondAgentPermissionInput, ResumeAgentSessionInput, RuntimeSnapshot, SendAgentPromptInput,
    SessionLaunchLock, terminal::agent_terminal_registry,
};
use api_types::AgentId;
use db::models::{
    agent_capability_catalog::AgentCapabilityCatalogRecord, workspace::Workspace,
    workspace_repo::WorkspaceRepo,
};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{error::AppError, state::AppState};

impl From<agents::AgentError> for AppError {
    fn from(error: agents::AgentError) -> Self {
        match error {
            agents::AgentError::ConnectionNotFound(message) => AppError::NotFound(format!(
                "Agent Runtime connection `{message}` was not found"
            )),
            agents::AgentError::SessionNotFound(message) => {
                AppError::NotFound(format!("Agent Runtime session `{message}` was not found"))
            }
            agents::AgentError::PromptNotFound(message) => {
                AppError::NotFound(format!("Agent Runtime prompt `{message}` was not found"))
            }
            agents::AgentError::UnsupportedAgent(message) => AppError::NotFound(format!(
                "Agent `{message}` is not registered in the local Runtime"
            )),
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
    pub agent_id: AgentId,
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
pub struct AgentPrepareSessionRequest {
    pub agent_id: AgentId,
    pub workspace_id: String,
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPreparedSessionModeRequest {
    pub session_id: String,
    pub mode_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPreparedSessionConfigRequest {
    pub session_id: String,
    pub key: String,
    pub value: Value,
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
pub struct AgentResumeSessionRequest {
    pub agent_id: AgentId,
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

/// Read the matching persisted capability catalog. This command is deliberately
/// side-effect free: opening a selector must never start an ACP process.
#[tauri::command]
pub async fn agent_capability_catalog(
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<Option<AgentSessionControlsSnapshot>, AppError> {
    let pool = &state.deployment.db().pool;
    read_matching_open_capability_catalog_for_pool(pool, &agent_id).await
}

async fn read_matching_open_capability_catalog_for_pool(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
) -> Result<Option<AgentSessionControlsSnapshot>, AppError> {
    let launch = match agent_runtime_launch_settings_from_pool(pool, agent_id).await {
        Ok(launch) => launch,
        Err(_) => return Ok(None),
    };
    let fingerprint = open_capability_catalog_fingerprint(&launch.launch_lock)?;
    let Some(record) =
        AgentCapabilityCatalogRecord::find_matching(pool, agent_id.as_str(), &fingerprint).await?
    else {
        return Ok(None);
    };
    Ok(serde_json::from_str(&record.controls_json).ok())
}

fn open_capability_catalog_fingerprint(
    launch_lock: &SessionLaunchLock,
) -> Result<String, AppError> {
    let mut digest = Sha256::new();
    digest.update(b"open-agent-capability-catalog-v1:");
    digest.update(launch_lock.agent_id.as_str().as_bytes());
    digest.update(b"\0");
    digest.update(
        launch_lock
            .absolute_acp_program
            .to_string_lossy()
            .as_bytes(),
    );
    for argument in &launch_lock.args {
        digest.update(b"\0arg:");
        digest.update(argument.as_bytes());
    }
    for (key, value) in &launch_lock.env {
        digest.update(b"\0env:");
        digest.update(key.as_bytes());
        digest.update(b"=");
        digest.update(value.as_bytes());
    }
    digest.update(b"\0runtime:");
    digest.update(launch_lock.runtime_version.as_bytes());
    digest.update(b"\0acp:");
    digest.update(launch_lock.acp_version.as_bytes());
    Ok(format!("{:x}", digest.finalize()))
}

/// The prompt-enhancement settings use the exact same persisted OpenCode
/// catalog as session creation. It deliberately returns an empty list while a
/// catalog is absent or stale: inventing static/free-tier choices here would
/// let the UI save a model that the verified runtime cannot use.
pub(crate) async fn opencode_capability_catalog_models(
    pool: &sqlx::SqlitePool,
) -> Result<Vec<String>, AppError> {
    let agent_id = AgentId::parse("opencode").expect("the built-in OpenCode id is a valid AgentId");
    let Some(snapshot) = read_matching_open_capability_catalog_for_pool(pool, &agent_id).await?
    else {
        return Ok(Vec::new());
    };
    Ok(opencode_models_from_catalog(&snapshot))
}

fn opencode_models_from_catalog(snapshot: &AgentSessionControlsSnapshot) -> Vec<String> {
    let mut models = Vec::new();
    for option in snapshot
        .config_options
        .iter()
        // `probe_opencode_session_controls` canonically emits this option.
        // Match its key rather than labels, which are presentation-only and
        // may be localized by a future OpenCode release.
        .filter(|option| option.key == "model")
    {
        for choice in &option.choices {
            let Some(model) = choice.value.as_str().map(str::trim) else {
                continue;
            };
            if !model.is_empty() && !models.iter().any(|existing| existing == model) {
                models.push(model.to_string());
            }
        }
    }
    models
}

/// Discover and persist a verified catalog explicitly. Normal selector reads
/// stay side-effect free; the create form escalates here once when no matching
/// catalog or live-workspace snapshot exists.
#[tauri::command]
pub async fn agent_refresh_capability_catalog(
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<bool, AppError> {
    let pool = &state.deployment.db().pool;
    let launch = agent_runtime_launch_settings_from_pool(pool, &agent_id).await?;
    let fingerprint = open_capability_catalog_fingerprint(&launch.launch_lock)?;
    let session_id = AgentSessionId(Uuid::new_v4());
    let working_dir = std::env::temp_dir()
        .join("vibex-agent-capability-probe")
        .join(agent_id.as_str())
        .join(session_id.to_string());
    std::fs::create_dir_all(&working_dir).map_err(|error| {
        AppError::Internal(format!(
            "failed to create capability probe directory: {error}"
        ))
    })?;

    let prepared = state
        .agent_runtime
        .prepare_session(agents::EnsureAgentSessionInput {
            agent_id: agent_id.clone(),
            launch_lock: launch.launch_lock,
            workspace_id: Uuid::new_v4(),
            working_dir,
            session_id,
            acp_session_id: format!("vibex-capability-probe-{}", session_id),
            auto_approve_mode: launch.auto_approve_mode,
            env: launch.env,
        })
        .await?;
    let controls_json = serde_json::to_string(&prepared.controls)?;
    AgentCapabilityCatalogRecord::replace(pool, agent_id.as_str(), &fingerprint, &controls_json)
        .await?;
    state
        .agent_runtime
        .discard_prepared_session(session_id)
        .await?;
    Ok(true)
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
pub async fn agent_connect(
    state: tauri::State<'_, AppState>,
    request: AgentConnectRequest,
) -> Result<AgentConnectionSnapshot, AppError> {
    let workspace_id = parse_uuid("workspace_id", &request.workspace_id)?;
    let launch_settings = agent_runtime_launch_settings(&state, &request.agent_id).await?;
    state
        .agent_runtime
        .connect(ConnectAgentInput {
            agent_id: request.agent_id,
            launch_lock: launch_settings.launch_lock,
            workspace_id,
            working_dir: PathBuf::from(request.working_dir),
            auto_approve_mode: launch_settings.auto_approve_mode,
            env: launch_settings.env,
        })
        .await
        .map_err(Into::into)
}

async fn agent_runtime_launch_settings(
    state: &tauri::State<'_, AppState>,
    agent_id: &AgentId,
) -> Result<conversations::AgentRuntimeLaunchSettings, AppError> {
    agent_runtime_launch_settings_from_pool(&state.deployment.db().pool, agent_id).await
}

/// Pool-based variant of [`agent_runtime_launch_settings`] so non-command code
/// (the delegation spawner) can resolve a child agent's auto-approve mode + env
/// without a `tauri::State`.
pub(crate) async fn agent_runtime_launch_settings_from_pool(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
) -> Result<conversations::AgentRuntimeLaunchSettings, AppError> {
    conversations::resolve_agent_runtime_launch_settings(pool, agent_id)
        .await
        .map_err(|error| match error {
            conversations::ConversationServiceError::NotFound(message) => {
                AppError::NotFound(message)
            }
            conversations::ConversationServiceError::BadRequest(message) => {
                AppError::BadRequest(message)
            }
            conversations::ConversationServiceError::Conflict(message) => {
                AppError::Conflict(message)
            }
            conversations::ConversationServiceError::Internal(message) => {
                AppError::Internal(message)
            }
        })
}

#[tauri::command]
pub async fn agent_prepare_session(
    state: tauri::State<'_, AppState>,
    request: AgentPrepareSessionRequest,
) -> Result<AgentPreparedSessionSnapshot, AppError> {
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
    let working_dir = crate::workspace_paths::resolve_workspace_agent_working_dir(
        &workspace,
        &container_ref,
        &repos,
    )
    .unwrap_or_else(|| container_ref.clone());
    let launch_settings = agent_runtime_launch_settings(&state, &request.agent_id).await?;

    state
        .agent_runtime
        .prepare_session(agents::EnsureAgentSessionInput {
            agent_id: request.agent_id,
            launch_lock: launch_settings.launch_lock,
            workspace_id,
            working_dir: PathBuf::from(working_dir),
            session_id,
            acp_session_id: format!("pending-{session_id}"),
            auto_approve_mode: launch_settings.auto_approve_mode,
            env: launch_settings.env,
        })
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn agent_set_prepared_session_mode(
    state: tauri::State<'_, AppState>,
    request: AgentPreparedSessionModeRequest,
) -> Result<AgentSessionControlsSnapshot, AppError> {
    state
        .agent_runtime
        .set_session_mode(
            parse_agent_session_id(&request.session_id)?,
            request.mode_id,
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn agent_set_prepared_session_config(
    state: tauri::State<'_, AppState>,
    request: AgentPreparedSessionConfigRequest,
) -> Result<AgentSessionControlsSnapshot, AppError> {
    state
        .agent_runtime
        .set_session_config_option(
            parse_agent_session_id(&request.session_id)?,
            request.key,
            request.value,
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn agent_discard_prepared_session(
    state: tauri::State<'_, AppState>,
    request: AgentSessionRequest,
) -> Result<(), AppError> {
    state
        .agent_runtime
        .discard_prepared_session(parse_agent_session_id(&request.session_id)?)
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
pub async fn agent_resume_session(
    state: tauri::State<'_, AppState>,
    request: AgentResumeSessionRequest,
) -> Result<AgentSessionSnapshot, AppError> {
    let launch_settings = agent_runtime_launch_settings(&state, &request.agent_id).await?;
    state
        .agent_runtime
        .resume_session(ResumeAgentSessionInput {
            agent_id: request.agent_id,
            launch_lock: launch_settings.launch_lock,
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
    let connection_id = parse_agent_connection_id(&request.connection_id)?;
    let connection = state
        .agent_runtime
        .snapshot()
        .await
        .connections
        .into_iter()
        .find(|connection| connection.id == connection_id)
        .ok_or_else(|| AppError::NotFound(format!("Agent connection {connection_id} not found")))?;
    agent_runtime_launch_settings_from_pool(&state.deployment.db().pool, &connection.agent_id)
        .await?;
    state
        .agent_runtime
        .send_prompt(SendAgentPromptInput {
            connection_id,
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

fn text_prompt_blocks(text: String) -> Vec<AgentContentBlock> {
    if text.trim().is_empty() {
        Vec::new()
    } else {
        vec![AgentContentBlock::Text { text }]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opencode_model_choices_come_only_from_the_persisted_catalog() {
        let snapshot = AgentSessionControlsSnapshot {
            modes: Vec::new(),
            current_mode: None,
            config_options: vec![
                agents::AgentSessionConfigOption {
                    key: "provider".to_string(),
                    label: "Provider".to_string(),
                    description: None,
                    category: None,
                    value: None,
                    choices: vec![agents::AgentSessionConfigChoice {
                        value: serde_json::Value::String("openai".to_string()),
                        label: "OpenAI".to_string(),
                        description: None,
                    }],
                    dependency: None,
                },
                agents::AgentSessionConfigOption {
                    key: "model".to_string(),
                    label: "Model".to_string(),
                    description: None,
                    category: Some("model".to_string()),
                    value: None,
                    choices: vec![
                        agents::AgentSessionConfigChoice {
                            value: serde_json::Value::String("openai/gpt-5.6-sol".to_string()),
                            label: "GPT 5.6 Sol".to_string(),
                            description: None,
                        },
                        // Values, not presentation labels, are sent back to
                        // OpenCode. Duplicates and unusable values are not
                        // transformed into invented fallback choices.
                        agents::AgentSessionConfigChoice {
                            value: serde_json::Value::String("openai/gpt-5.6-sol".to_string()),
                            label: "A different label".to_string(),
                            description: None,
                        },
                        agents::AgentSessionConfigChoice {
                            value: serde_json::Value::String("  ".to_string()),
                            label: "Empty".to_string(),
                            description: None,
                        },
                        agents::AgentSessionConfigChoice {
                            value: serde_json::Value::Bool(true),
                            label: "Not a model".to_string(),
                            description: None,
                        },
                    ],
                    dependency: None,
                },
            ],
        };

        assert_eq!(
            opencode_models_from_catalog(&snapshot),
            vec!["openai/gpt-5.6-sol".to_string()]
        );
    }

    #[test]
    fn opencode_model_extractor_returns_no_static_fallback_when_catalog_is_empty() {
        let snapshot = AgentSessionControlsSnapshot {
            modes: Vec::new(),
            current_mode: None,
            config_options: Vec::new(),
        };

        assert!(opencode_models_from_catalog(&snapshot).is_empty());
    }
}
