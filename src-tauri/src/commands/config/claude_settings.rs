use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::fs;

use crate::{error::AppError, state::AppState};

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct ClaudeSettings {
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default, rename = "enabledPlugins")]
    pub enabled_plugins: HashMap<String, bool>,
}

fn claude_settings_path() -> Option<std::path::PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|home| {
            std::path::PathBuf::from(home)
                .join(".claude")
                .join("settings.json")
        })
}

pub(crate) async fn get_claude_settings(
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

    let raw: Value = serde_json::from_str(&content)
        .map_err(|e| AppError::Internal(format!("Failed to parse claude settings JSON: {}", e)))?;

    let env: HashMap<String, String> = raw
        .get("env")
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or_default();

    let enabled_plugins: HashMap<String, bool> = raw
        .get("enabledPlugins")
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or_default();

    Ok(ClaudeSettings {
        env,
        enabled_plugins,
    })
}

pub(crate) async fn update_claude_settings(
    state: tauri::State<'_, AppState>,
    settings: ClaudeSettings,
) -> Result<ClaudeSettings, AppError> {
    let _ = state;

    let path = claude_settings_path()
        .ok_or_else(|| AppError::Internal("Could not determine home directory".to_string()))?;

    let mut existing: Value = if path.exists() {
        let content = fs::read_to_string(&path)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to read claude settings: {}", e)))?;
        serde_json::from_str(&content).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

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
