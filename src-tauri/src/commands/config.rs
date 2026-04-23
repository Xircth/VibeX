use std::collections::HashMap;

use deployment::Deployment;
use executors::{
    executors::{
        AvailabilityInfo, BaseAgentCapability, BaseCodingAgent, StandardCodingAgentExecutor,
    },
    profile::{ExecutorConfigs, ExecutorProfileId},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use services::services::{
    config::{
        Config, SoundFile,
        editor::{EditorConfig, EditorType},
        save_config_to_file,
    },
    worktree_manager::WorktreeManager,
};
use tauri::Emitter;

use crate::{error::AppError, state::AppState};

mod agent_native;
mod claude_settings;
mod mcp_servers;
mod prompt_enhancement;

pub use agent_native::AgentNativeConfigs;
pub use claude_settings::ClaudeSettings;
pub use mcp_servers::GetMcpServerResponse;
pub use prompt_enhancement::{
    OpencodeModelsResponse, PromptEnhancementContextMessage, PromptEnhancementRequest,
    PromptEnhancementResponse,
};

#[derive(Debug, Serialize, Deserialize)]
pub struct Environment {
    pub os_type: String,
    pub os_version: String,
    pub os_architecture: String,
    pub bitness: String,
}

impl Environment {
    pub fn new() -> Self {
        let info = os_info::get();
        Environment {
            os_type: info.os_type().to_string(),
            os_version: info.version().to_string(),
            os_architecture: info.architecture().unwrap_or("unknown").to_string(),
            bitness: info.bitness().to_string(),
        }
    }
}

impl Default for Environment {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UserSystemInfo {
    pub config: Config,
    #[serde(flatten)]
    pub profiles: ExecutorConfigs,
    pub environment: Environment,
    pub capabilities: HashMap<String, Vec<BaseAgentCapability>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProfilesContent {
    pub content: String,
    pub path: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CheckEditorAvailabilityResponse {
    pub available: bool,
}

#[tauri::command]
pub async fn get_user_system_info(
    state: tauri::State<'_, AppState>,
) -> Result<UserSystemInfo, AppError> {
    let config = state.deployment.config().read().await.clone();

    let profiles = ExecutorConfigs::get_cached();
    let capabilities = {
        let mut caps: HashMap<String, Vec<BaseAgentCapability>> = HashMap::new();
        let profs = ExecutorConfigs::get_cached();
        for key in profs.executors.keys() {
            if let Some(agent) = profs.get_coding_agent(&ExecutorProfileId::new(*key)) {
                caps.insert(key.to_string(), agent.capabilities());
            }
        }
        caps
    };

    Ok(UserSystemInfo {
        config,
        profiles,
        environment: Environment::new(),
        capabilities,
    })
}

#[tauri::command]
pub async fn update_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    new_config: Config,
) -> Result<Config, AppError> {
    let config_path = utils::assets::config_path();
    let previous_theme = state.deployment.config().read().await.theme.clone();

    if !git::is_valid_branch_prefix(&new_config.git_branch_prefix) {
        return Err(AppError::BadRequest(
            "Invalid git branch prefix. Must be a valid git branch name component without slashes."
                .to_string(),
        ));
    }

    save_config_to_file(&new_config, &config_path).await?;

    let mut config = state.deployment.config().write().await;
    *config = new_config.clone();
    drop(config);

    let workspace_dir_override = new_config
        .workspace_dir
        .as_ref()
        .map(|workspace_dir| utils::path::expand_tilde(workspace_dir));
    WorktreeManager::set_workspace_dir_override(workspace_dir_override);

    if std::mem::discriminant(&previous_theme) != std::mem::discriminant(&new_config.theme) {
        app.emit(
            "theme-changed",
            json!({ "theme": new_config.theme.clone() }),
        )
        .map_err(|e| AppError::Internal(format!("Failed to emit theme change: {}", e)))?;
    }

    Ok(new_config)
}

#[tauri::command]
pub async fn get_mcp_servers(
    state: tauri::State<'_, AppState>,
    executor: BaseCodingAgent,
) -> Result<GetMcpServerResponse, AppError> {
    mcp_servers::get_mcp_servers(state, executor).await
}

#[tauri::command]
pub async fn update_mcp_servers(
    state: tauri::State<'_, AppState>,
    executor: BaseCodingAgent,
    servers: HashMap<String, serde_json::Value>,
) -> Result<String, AppError> {
    mcp_servers::update_mcp_servers(state, executor, servers).await
}

#[tauri::command]
pub async fn get_profiles(state: tauri::State<'_, AppState>) -> Result<ProfilesContent, AppError> {
    let _ = state;
    let profiles_path = utils::assets::profiles_path();

    let profiles = ExecutorConfigs::get_cached();
    let content = serde_json::to_string_pretty(&profiles).unwrap_or_else(|e| {
        tracing::error!("Failed to serialize profiles to JSON: {}", e);
        serde_json::to_string_pretty(&ExecutorConfigs::from_defaults())
            .unwrap_or_else(|_| "{}".to_string())
    });

    Ok(ProfilesContent {
        content,
        path: profiles_path.display().to_string(),
    })
}

#[tauri::command]
pub async fn update_profiles(
    state: tauri::State<'_, AppState>,
    body: String,
) -> Result<String, AppError> {
    let _ = state;

    let executor_profiles: ExecutorConfigs = serde_json::from_str(&body)
        .map_err(|e| AppError::BadRequest(format!("Invalid executor profiles format: {}", e)))?;

    executor_profiles.save_overrides().map_err(|e| {
        tracing::error!("Failed to save executor profiles: {}", e);
        AppError::Internal(format!("Failed to save executor profiles: {}", e))
    })?;

    tracing::info!("Executor profiles saved successfully");
    ExecutorConfigs::reload();

    Ok("Executor profiles updated successfully".to_string())
}

#[tauri::command]
pub async fn check_editor_availability(
    state: tauri::State<'_, AppState>,
    editor_type: EditorType,
) -> Result<CheckEditorAvailabilityResponse, AppError> {
    let _ = state;

    let editor_config = EditorConfig::new(editor_type, None, None, None);
    let available = editor_config.check_availability().await;

    Ok(CheckEditorAvailabilityResponse { available })
}

#[tauri::command]
pub async fn check_agent_availability(
    state: tauri::State<'_, AppState>,
    executor: BaseCodingAgent,
) -> Result<AvailabilityInfo, AppError> {
    let _ = state;

    let profiles = ExecutorConfigs::get_cached();
    let profile_id = ExecutorProfileId::new(executor);

    let info = match profiles.get_coding_agent(&profile_id) {
        Some(agent) => agent.get_availability_info(),
        None => AvailabilityInfo::NotFound,
    };

    Ok(info)
}

#[tauri::command]
pub async fn play_notification_sound(
    state: tauri::State<'_, AppState>,
    sound_file: SoundFile,
) -> Result<(), AppError> {
    let _ = state;

    let file_path = sound_file
        .get_path()
        .await
        .map_err(|e| AppError::Internal(format!("Failed to resolve sound file: {}", e)))?;

    if cfg!(target_os = "macos") {
        let _ = tokio::process::Command::new("afplay")
            .arg(&file_path)
            .spawn();
    } else if cfg!(target_os = "linux") && !utils::is_wsl2() {
        let _ = tokio::process::Command::new("paplay")
            .arg(&file_path)
            .spawn()
            .or_else(|_| {
                tokio::process::Command::new("aplay")
                    .arg(&file_path)
                    .spawn()
            });
    } else {
        let file_path = file_path.to_string_lossy().replace('\'', "''");
        let mut cmd = tokio::process::Command::new("powershell.exe");
        cmd.arg("-NoProfile").arg("-Command").arg(format!(
            "(New-Object Media.SoundPlayer '{file_path}').PlaySync()"
        ));
        utils::process::configure_tokio_command_no_window(&mut cmd);
        let _ = cmd.spawn();
    }

    Ok(())
}

#[tauri::command]
pub async fn enhance_prompt(
    state: tauri::State<'_, AppState>,
    payload: PromptEnhancementRequest,
) -> Result<PromptEnhancementResponse, AppError> {
    prompt_enhancement::enhance_prompt(state, payload).await
}

#[tauri::command]
pub async fn list_opencode_models(
    state: tauri::State<'_, AppState>,
) -> Result<OpencodeModelsResponse, AppError> {
    prompt_enhancement::list_opencode_models(state).await
}

#[tauri::command]
pub async fn get_claude_settings(
    state: tauri::State<'_, AppState>,
) -> Result<ClaudeSettings, AppError> {
    claude_settings::get_claude_settings(state).await
}

#[tauri::command]
pub async fn update_claude_settings(
    state: tauri::State<'_, AppState>,
    settings: ClaudeSettings,
) -> Result<ClaudeSettings, AppError> {
    claude_settings::update_claude_settings(state, settings).await
}

#[tauri::command]
pub async fn read_agent_native_configs(
    state: tauri::State<'_, AppState>,
    agent_type: BaseCodingAgent,
) -> Result<AgentNativeConfigs, AppError> {
    agent_native::read_agent_native_configs(state, agent_type).await
}

#[tauri::command]
pub async fn write_agent_native_config(
    state: tauri::State<'_, AppState>,
    agent_type: BaseCodingAgent,
    codex_config_toml: Option<String>,
    codex_auth_json: Option<String>,
    opencode_config_json: Option<String>,
    opencode_auth_json: Option<String>,
) -> Result<(), AppError> {
    agent_native::write_agent_native_config(
        state,
        agent_type,
        codex_config_toml,
        codex_auth_json,
        opencode_config_json,
        opencode_auth_json,
    )
    .await
}
