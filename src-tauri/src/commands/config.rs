use std::{collections::HashMap, path::PathBuf};

use deployment::Deployment;
use executors::{
    executors::{
        AvailabilityInfo, BaseAgentCapability, BaseCodingAgent, StandardCodingAgentExecutor,
        codex::codex_home,
    },
    mcp_config::{McpConfig, read_agent_config, write_agent_config},
    profile::{ExecutorConfigs, ExecutorProfileId},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use services::services::config::{
    Config, ConfigError,
    editor::{EditorConfig, EditorType},
    save_config_to_file,
};
use tokio::fs;
use ts_rs::TS;

use crate::{error::AppError, state::AppState};

// --- Types ---

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
pub struct GetMcpServerResponse {
    pub mcp_config: McpConfig,
    pub config_path: String,
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

// --- Commands ---

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
    state: tauri::State<'_, AppState>,
    new_config: Config,
) -> Result<Config, AppError> {
    let config_path = utils::assets::config_path();

    // Validate git branch prefix
    if !git::is_valid_branch_prefix(&new_config.git_branch_prefix) {
        return Err(AppError::BadRequest(
            "Invalid git branch prefix. Must be a valid git branch name component without slashes."
                .to_string(),
        ));
    }

    // Get old config state before updating
    let old_config = state.deployment.config().read().await.clone();

    save_config_to_file(&new_config, &config_path).await?;

    let mut config = state.deployment.config().write().await;
    *config = new_config.clone();
    drop(config);

    // Handle config events (e.g., auto project setup on disclaimer acknowledgement)
    if !old_config.disclaimer_acknowledged && new_config.disclaimer_acknowledged {
        let deployment_clone = state.deployment.clone();
        tokio::spawn(async move {
            deployment_clone.trigger_auto_project_setup().await;
        });
    }

    Ok(new_config)
}

#[tauri::command]
pub async fn get_mcp_servers(
    state: tauri::State<'_, AppState>,
    executor: BaseCodingAgent,
) -> Result<GetMcpServerResponse, AppError> {
    let _ = state; // state not directly used but kept for consistency

    let coding_agent = ExecutorConfigs::get_cached()
        .get_coding_agent(&ExecutorProfileId::new(executor))
        .ok_or(ConfigError::ValidationError(
            "Executor not found".to_string(),
        ))?;

    if !coding_agent.supports_mcp() {
        return Err(AppError::BadRequest(
            "MCP not supported by this executor".to_string(),
        ));
    }

    let config_path = match coding_agent.default_mcp_config_path() {
        Some(path) => path,
        None => {
            return Err(AppError::BadRequest(
                "Could not determine config file path".to_string(),
            ));
        }
    };

    let mut mcpc = coding_agent.get_mcp_config();
    let raw_config = read_agent_config(&config_path, &mcpc).await?;
    let servers = get_mcp_servers_from_config_path(&raw_config, &mcpc.servers_path);
    mcpc.set_servers(servers);

    Ok(GetMcpServerResponse {
        mcp_config: mcpc,
        config_path: config_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn update_mcp_servers(
    state: tauri::State<'_, AppState>,
    executor: BaseCodingAgent,
    servers: HashMap<String, Value>,
) -> Result<String, AppError> {
    let _ = state;

    let profiles = ExecutorConfigs::get_cached();
    let agent = profiles
        .get_coding_agent(&ExecutorProfileId::new(executor))
        .ok_or(ConfigError::ValidationError(
            "Executor not found".to_string(),
        ))?;

    if !agent.supports_mcp() {
        return Err(AppError::BadRequest(
            "This executor does not support MCP servers".to_string(),
        ));
    }

    let config_path = match agent.default_mcp_config_path() {
        Some(path) => path.to_path_buf(),
        None => {
            return Err(AppError::BadRequest(
                "Could not determine config file path".to_string(),
            ));
        }
    };

    let mcpc = agent.get_mcp_config();
    update_mcp_servers_in_config(&config_path, &mcpc, servers)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to update MCP servers: {}", e)))
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

// --- Claude Settings (~/.claude/settings.json) ---

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct ClaudeSettings {
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default, rename = "enabledPlugins")]
    pub enabled_plugins: HashMap<String, bool>,
}

fn claude_settings_path() -> Option<std::path::PathBuf> {
    // Use HOME on Unix, USERPROFILE on Windows
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|home| {
            std::path::PathBuf::from(home)
                .join(".claude")
                .join("settings.json")
        })
}

#[tauri::command]
pub async fn get_claude_settings(
    state: tauri::State<'_, AppState>,
) -> Result<ClaudeSettings, AppError> {
    let _ = state;

    let path = claude_settings_path()
        .ok_or_else(|| AppError::Internal("Could not determine home directory".to_string()))?;

    if !path.exists() {
        return Ok(ClaudeSettings::default());
    }

    let content = fs::read_to_string(&path)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to read claude settings: {}", e)))?;

    // Parse as generic JSON Value first, then extract known fields.
    // This avoids failures when the file contains unknown fields (e.g. "permissions").
    let raw: Value = serde_json::from_str(&content)
        .map_err(|e| AppError::Internal(format!("Failed to parse claude settings JSON: {}", e)))?;

    let env: HashMap<String, String> = raw
        .get("env")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    let enabled_plugins: HashMap<String, bool> = raw
        .get("enabledPlugins")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    Ok(ClaudeSettings {
        env,
        enabled_plugins,
    })
}

#[tauri::command]
pub async fn update_claude_settings(
    state: tauri::State<'_, AppState>,
    settings: ClaudeSettings,
) -> Result<ClaudeSettings, AppError> {
    let _ = state;

    let path = claude_settings_path()
        .ok_or_else(|| AppError::Internal("Could not determine home directory".to_string()))?;

    // Read existing file to preserve unknown fields
    let mut existing: Value = if path.exists() {
        let content = fs::read_to_string(&path)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to read claude settings: {}", e)))?;
        serde_json::from_str(&content).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    // Update only the fields we manage
    if let Some(obj) = existing.as_object_mut() {
        obj.insert(
            "env".to_string(),
            serde_json::to_value(&settings.env).unwrap(),
        );
        obj.insert(
            "enabledPlugins".to_string(),
            serde_json::to_value(&settings.enabled_plugins).unwrap(),
        );
    }

    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await.map_err(|e| {
            AppError::Internal(format!("Failed to create claude settings directory: {}", e))
        })?;
    }

    let content = serde_json::to_string_pretty(&existing)
        .map_err(|e| AppError::Internal(format!("Failed to serialize claude settings: {}", e)))?;

    fs::write(&path, content)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to write claude settings: {}", e)))?;

    Ok(settings)
}

// --- Helper functions (ported from server config route) ---

fn get_mcp_servers_from_config_path(raw_config: &Value, path: &[String]) -> HashMap<String, Value> {
    let mut current = raw_config;
    for part in path {
        current = match current.get(part) {
            Some(val) => val,
            None => return HashMap::new(),
        };
    }
    match current.as_object() {
        Some(servers) => servers
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        None => HashMap::new(),
    }
}

fn set_mcp_servers_in_config_path(
    raw_config: &mut Value,
    path: &[String],
    servers: &HashMap<String, Value>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if !raw_config.is_object() {
        *raw_config = serde_json::json!({});
    }

    let mut current = raw_config;
    for part in &path[..path.len() - 1] {
        if current.get(part).is_none() {
            current
                .as_object_mut()
                .unwrap()
                .insert(part.to_string(), serde_json::json!({}));
        }
        current = current.get_mut(part).unwrap();
        if !current.is_object() {
            *current = serde_json::json!({});
        }
    }

    let final_attr = path.last().unwrap();
    current
        .as_object_mut()
        .unwrap()
        .insert(final_attr.to_string(), serde_json::to_value(servers)?);

    Ok(())
}

async fn update_mcp_servers_in_config(
    config_path: &std::path::Path,
    mcpc: &McpConfig,
    new_servers: HashMap<String, Value>,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).await?;
    }

    let mut config = read_agent_config(config_path, mcpc).await?;
    let old_servers = get_mcp_servers_from_config_path(&config, &mcpc.servers_path).len();

    set_mcp_servers_in_config_path(&mut config, &mcpc.servers_path, &new_servers)?;
    write_agent_config(config_path, mcpc, &config).await?;

    let new_count = new_servers.len();
    let message = match (old_servers, new_count) {
        (0, 0) => "No MCP servers configured".to_string(),
        (0, n) => format!("Added {} MCP server(s)", n),
        (old, new) if old == new => {
            format!("Updated MCP server configuration ({} server(s))", new)
        }
        (old, new) => format!(
            "Updated MCP server configuration (was {}, now {})",
            old, new
        ),
    };

    Ok(message)
}

// --- Agent Native Config Files ---

/// Native configuration files for each agent (config.toml, auth.json, etc.)
#[derive(Debug, Serialize, Deserialize, TS)]
pub struct AgentNativeConfigs {
    /// Codex: ~/.codex/config.toml content
    pub codex_config_toml: Option<String>,
    /// Codex: ~/.codex/auth.json content
    pub codex_auth_json: Option<String>,
    /// Codex home directory path
    pub codex_home_path: Option<String>,
    /// OpenCode: config directory json content
    pub opencode_config_json: Option<String>,
    /// OpenCode: auth.json content
    pub opencode_auth_json: Option<String>,
    /// OpenCode config directory path
    pub opencode_config_path: Option<String>,
}

/// Returns the OpenCode config directory path (cross-platform).
fn opencode_config_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .ok()
            .or_else(|| dirs::home_dir().map(|p| p.join(".config")))
            .map(|p| p.join("opencode"))
    }
    #[cfg(not(windows))]
    {
        dirs::home_dir().map(|p| p.join(".config").join("opencode"))
    }
}

/// Returns the OpenCode auth.json path (cross-platform).
fn opencode_auth_path() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .ok()
            .or_else(|| dirs::home_dir().map(|p| p.join(".local").join("share")))
            .map(|p| p.join("opencode").join("auth.json"))
    }
    #[cfg(not(windows))]
    {
        dirs::home_dir().map(|p| {
            p.join(".local")
                .join("share")
                .join("opencode")
                .join("auth.json")
        })
    }
}

/// Read an agent's native configuration files from the filesystem.
#[tauri::command]
pub async fn read_agent_native_configs(
    state: tauri::State<'_, AppState>,
    agent_type: BaseCodingAgent,
) -> Result<AgentNativeConfigs, AppError> {
    let _ = state;

    match agent_type {
        BaseCodingAgent::Codex => {
            let home = codex_home();
            let home_str = home.as_ref().map(|p| p.display().to_string());

            let config_toml = match &home {
                Some(h) => {
                    let path = h.join("config.toml");
                    if path.exists() {
                        Some(fs::read_to_string(&path).await.map_err(|e| {
                            AppError::Internal(format!("Failed to read codex config.toml: {}", e))
                        })?)
                    } else {
                        None
                    }
                }
                None => None,
            };

            let auth_json = match &home {
                Some(h) => {
                    let path = h.join("auth.json");
                    if path.exists() {
                        Some(fs::read_to_string(&path).await.map_err(|e| {
                            AppError::Internal(format!("Failed to read codex auth.json: {}", e))
                        })?)
                    } else {
                        None
                    }
                }
                None => None,
            };

            Ok(AgentNativeConfigs {
                codex_config_toml: config_toml,
                codex_auth_json: auth_json,
                codex_home_path: home_str,
                opencode_config_json: None,
                opencode_auth_json: None,
                opencode_config_path: None,
            })
        }
        BaseCodingAgent::Opencode => {
            let config_dir = opencode_config_dir();
            let config_path_str = config_dir.as_ref().map(|p| p.display().to_string());

            let config_json = match &config_dir {
                Some(dir) => {
                    // Try opencode.json first, then opencode.jsonc
                    let json_path = dir.join("opencode.json");
                    let jsonc_path = dir.join("opencode.jsonc");
                    let path = if json_path.exists() {
                        Some(json_path)
                    } else if jsonc_path.exists() {
                        Some(jsonc_path)
                    } else {
                        None
                    };
                    match path {
                        Some(p) => Some(fs::read_to_string(&p).await.map_err(|e| {
                            AppError::Internal(format!("Failed to read opencode config: {}", e))
                        })?),
                        None => None,
                    }
                }
                None => None,
            };

            let auth_json = match opencode_auth_path() {
                Some(path) if path.exists() => {
                    Some(fs::read_to_string(&path).await.map_err(|e| {
                        AppError::Internal(format!("Failed to read opencode auth.json: {}", e))
                    })?)
                }
                _ => None,
            };

            Ok(AgentNativeConfigs {
                codex_config_toml: None,
                codex_auth_json: None,
                codex_home_path: None,
                opencode_config_json: config_json,
                opencode_auth_json: auth_json,
                opencode_config_path: config_path_str,
            })
        }
        BaseCodingAgent::ClaudeCode => {
            // Claude Code settings are already handled by get_claude_settings
            Ok(AgentNativeConfigs {
                codex_config_toml: None,
                codex_auth_json: None,
                codex_home_path: None,
                opencode_config_json: None,
                opencode_auth_json: None,
                opencode_config_path: None,
            })
        }
        #[allow(unreachable_patterns)]
        _ => Ok(AgentNativeConfigs {
            codex_config_toml: None,
            codex_auth_json: None,
            codex_home_path: None,
            opencode_config_json: None,
            opencode_auth_json: None,
            opencode_config_path: None,
        }),
    }
}

/// Write an agent's native configuration files to the filesystem.
#[tauri::command]
pub async fn write_agent_native_config(
    state: tauri::State<'_, AppState>,
    agent_type: BaseCodingAgent,
    codex_config_toml: Option<String>,
    codex_auth_json: Option<String>,
    opencode_config_json: Option<String>,
    opencode_auth_json: Option<String>,
) -> Result<(), AppError> {
    let _ = state;

    match agent_type {
        BaseCodingAgent::Codex => {
            let home = codex_home().ok_or_else(|| {
                AppError::Internal("Could not determine Codex home directory".to_string())
            })?;

            // Ensure directory exists
            fs::create_dir_all(&home).await.map_err(|e| {
                AppError::Internal(format!("Failed to create codex home directory: {}", e))
            })?;

            if let Some(toml_content) = codex_config_toml {
                fs::write(home.join("config.toml"), toml_content)
                    .await
                    .map_err(|e| {
                        AppError::Internal(format!("Failed to write codex config.toml: {}", e))
                    })?;
            }

            if let Some(auth_content) = codex_auth_json {
                fs::write(home.join("auth.json"), auth_content)
                    .await
                    .map_err(|e| {
                        AppError::Internal(format!("Failed to write codex auth.json: {}", e))
                    })?;
            }
        }
        BaseCodingAgent::Opencode => {
            if let Some(config_content) = opencode_config_json {
                let config_dir = opencode_config_dir().ok_or_else(|| {
                    AppError::Internal("Could not determine OpenCode config directory".to_string())
                })?;

                fs::create_dir_all(&config_dir).await.map_err(|e| {
                    AppError::Internal(format!("Failed to create opencode config directory: {}", e))
                })?;

                fs::write(config_dir.join("opencode.json"), config_content)
                    .await
                    .map_err(|e| {
                        AppError::Internal(format!("Failed to write opencode config: {}", e))
                    })?;
            }

            if let Some(auth_content) = opencode_auth_json {
                let auth_path = opencode_auth_path().ok_or_else(|| {
                    AppError::Internal("Could not determine OpenCode auth path".to_string())
                })?;

                if let Some(parent) = auth_path.parent() {
                    fs::create_dir_all(parent).await.map_err(|e| {
                        AppError::Internal(format!(
                            "Failed to create opencode auth directory: {}",
                            e
                        ))
                    })?;
                }

                fs::write(&auth_path, auth_content).await.map_err(|e| {
                    AppError::Internal(format!("Failed to write opencode auth.json: {}", e))
                })?;
            }
        }
        _ => {}
    }

    Ok(())
}
