use std::collections::HashMap;

use serde::{Deserialize, Serialize, de::DeserializeOwned};
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

fn parse_settings_document(content: &str) -> Result<Value, AppError> {
    let value: Value = serde_json::from_str(content).map_err(|error| {
        AppError::Internal(format!("Failed to parse claude settings JSON: {error}"))
    })?;
    if !value.is_object() {
        return Err(AppError::Internal(
            "Claude settings JSON must contain an object at the root".to_string(),
        ));
    }
    Ok(value)
}

fn decode_field<T: DeserializeOwned>(raw: &Value, name: &str) -> Result<Option<T>, AppError> {
    raw.get(name)
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| {
            AppError::Internal(format!("Invalid `{name}` in claude settings JSON: {error}"))
        })
}

fn decode_settings(raw: &Value) -> Result<ClaudeSettings, AppError> {
    Ok(ClaudeSettings {
        env: decode_field(raw, "env")?.unwrap_or_default(),
        enabled_plugins: decode_field(raw, "enabledPlugins")?.unwrap_or_default(),
    })
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

    decode_settings(&parse_settings_document(&content)?)
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
        parse_settings_document(&content)?
    } else {
        serde_json::json!({})
    };

    let obj = existing
        .as_object_mut()
        .expect("parse_settings_document guarantees an object");
    obj.insert(
        "env".to_string(),
        serde_json::to_value(&settings.env).map_err(|error| {
            AppError::Internal(format!("Failed to serialize claude environment: {error}"))
        })?,
    );
    obj.insert(
        "enabledPlugins".to_string(),
        serde_json::to_value(&settings.enabled_plugins).map_err(|error| {
            AppError::Internal(format!("Failed to serialize claude plugins: {error}"))
        })?,
    );

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

#[cfg(test)]
mod tests {
    use super::{decode_settings, parse_settings_document};

    #[test]
    fn rejects_malformed_or_non_object_settings_documents() {
        assert!(parse_settings_document("{ broken").is_err());
        assert!(parse_settings_document("[]").is_err());
    }

    #[test]
    fn rejects_invalid_known_fields_instead_of_defaulting_them() {
        let raw = parse_settings_document(r#"{"env": ["not", "a", "map"]}"#).unwrap();
        assert!(decode_settings(&raw).is_err());

        let raw = parse_settings_document(r#"{"enabledPlugins": {"plugin": "yes"}}"#).unwrap();
        assert!(decode_settings(&raw).is_err());
    }

    #[test]
    fn defaults_only_fields_that_are_absent() {
        let raw = parse_settings_document(r#"{"unrelated": true}"#).unwrap();
        let settings = decode_settings(&raw).unwrap();
        assert!(settings.env.is_empty());
        assert!(settings.enabled_plugins.is_empty());
    }
}
