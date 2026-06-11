use agents::{codex_home, opencode_auth_path, opencode_config_dir};
use executors::executors::BaseCodingAgent;
use serde::{Deserialize, Serialize};
use tokio::fs;
use ts_rs::TS;
use utils::path::normalize_windows_extended_path_prefix;

use crate::{error::AppError, state::AppState};

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct AgentNativeConfigs {
    pub codex_config_toml: Option<String>,
    pub codex_auth_json: Option<String>,
    pub codex_home_path: Option<String>,
    pub opencode_config_json: Option<String>,
    pub opencode_auth_json: Option<String>,
    pub opencode_config_path: Option<String>,
}

fn empty_configs() -> AgentNativeConfigs {
    AgentNativeConfigs {
        codex_config_toml: None,
        codex_auth_json: None,
        codex_home_path: None,
        opencode_config_json: None,
        opencode_auth_json: None,
        opencode_config_path: None,
    }
}

pub(crate) async fn read_agent_native_configs(
    state: tauri::State<'_, AppState>,
    agent_type: BaseCodingAgent,
) -> Result<AgentNativeConfigs, AppError> {
    let _ = state;

    match agent_type {
        BaseCodingAgent::Codex => {
            let home = codex_home();
            let home_str = home.as_ref().map(|path| {
                normalize_windows_extended_path_prefix(path)
                    .display()
                    .to_string()
            });

            let config_toml = match &home {
                Some(dir) => {
                    let path = dir.join("config.toml");
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
                Some(dir) => {
                    let path = dir.join("auth.json");
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
                ..empty_configs()
            })
        }
        BaseCodingAgent::Opencode => {
            let config_dir = opencode_config_dir();
            let config_path_str = config_dir.as_ref().map(|path| {
                normalize_windows_extended_path_prefix(path)
                    .display()
                    .to_string()
            });

            let config_json = match &config_dir {
                Some(dir) => {
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
                        Some(path) => Some(fs::read_to_string(&path).await.map_err(|e| {
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
                opencode_config_json: config_json,
                opencode_auth_json: auth_json,
                opencode_config_path: config_path_str,
                ..empty_configs()
            })
        }
        BaseCodingAgent::ClaudeCode => Ok(empty_configs()),
        #[allow(unreachable_patterns)]
        _ => Ok(empty_configs()),
    }
}

pub(crate) async fn write_agent_native_config(
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

            fs::create_dir_all(&home).await.map_err(|e| {
                AppError::Internal(format!("Failed to create codex home directory: {}", e))
            })?;

            if let Some(content) = codex_config_toml {
                fs::write(home.join("config.toml"), content)
                    .await
                    .map_err(|e| {
                        AppError::Internal(format!("Failed to write codex config.toml: {}", e))
                    })?;
            }

            if let Some(content) = codex_auth_json {
                fs::write(home.join("auth.json"), content)
                    .await
                    .map_err(|e| {
                        AppError::Internal(format!("Failed to write codex auth.json: {}", e))
                    })?;
            }
        }
        BaseCodingAgent::Opencode => {
            if let Some(content) = opencode_config_json {
                let config_dir = opencode_config_dir().ok_or_else(|| {
                    AppError::Internal("Could not determine OpenCode config directory".to_string())
                })?;

                fs::create_dir_all(&config_dir).await.map_err(|e| {
                    AppError::Internal(format!("Failed to create opencode config directory: {}", e))
                })?;

                fs::write(config_dir.join("opencode.json"), content)
                    .await
                    .map_err(|e| {
                        AppError::Internal(format!("Failed to write opencode config: {}", e))
                    })?;
            }

            if let Some(content) = opencode_auth_json {
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

                fs::write(&auth_path, content).await.map_err(|e| {
                    AppError::Internal(format!("Failed to write opencode auth.json: {}", e))
                })?;
            }
        }
        _ => {}
    }

    Ok(())
}
