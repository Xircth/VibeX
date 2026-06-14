use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::AppError;

const SETTINGS_FILE_NAME: &str = "system-settings.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SystemProxySettings {
    pub enabled: bool,
    pub proxy_url: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RenderingAccelerationMode {
    #[default]
    Auto,
    ForceGpu,
    DisableGpu,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SystemRenderingSettings {
    #[serde(default)]
    pub acceleration_mode: RenderingAccelerationMode,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct SystemSettingsStore {
    #[serde(default)]
    proxy: SystemProxySettings,
    #[serde(default)]
    rendering: SystemRenderingSettings,
}

fn settings_path() -> PathBuf {
    utils::assets::asset_dir().join(SETTINGS_FILE_NAME)
}

async fn load_store() -> Result<SystemSettingsStore, AppError> {
    let path = settings_path();
    if !path.exists() {
        return Ok(SystemSettingsStore::default());
    }

    let content = tokio::fs::read_to_string(&path).await.map_err(|error| {
        AppError::Internal(format!(
            "Failed to read system settings {}: {error}",
            path.display()
        ))
    })?;

    serde_json::from_str(&content).map_err(|error| {
        AppError::Internal(format!(
            "Invalid system settings {}: {error}",
            path.display()
        ))
    })
}

async fn save_store(store: &SystemSettingsStore) -> Result<(), AppError> {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|error| {
            AppError::Internal(format!(
                "Failed to create system settings directory {}: {error}",
                parent.display()
            ))
        })?;
    }

    let content = serde_json::to_string_pretty(store).map_err(|error| {
        AppError::Internal(format!("Failed to serialize system settings: {error}"))
    })?;

    tokio::fs::write(&path, content).await.map_err(|error| {
        AppError::Internal(format!(
            "Failed to write system settings {}: {error}",
            path.display()
        ))
    })
}

fn normalize_proxy_settings(
    settings: SystemProxySettings,
) -> Result<SystemProxySettings, AppError> {
    let proxy_url = settings
        .proxy_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);

    if settings.enabled {
        let Some(proxy_url) = proxy_url.as_deref() else {
            return Err(AppError::BadRequest(
                "Proxy URL is required when proxy is enabled".to_string(),
            ));
        };

        reqwest::Proxy::all(proxy_url)
            .map_err(|error| AppError::BadRequest(format!("Invalid proxy URL: {error}")))?;
    }

    Ok(SystemProxySettings {
        enabled: settings.enabled,
        proxy_url,
    })
}

#[tauri::command]
pub async fn get_system_proxy_settings() -> Result<SystemProxySettings, AppError> {
    Ok(load_store().await?.proxy)
}

#[tauri::command]
pub async fn update_system_proxy_settings(
    settings: SystemProxySettings,
) -> Result<SystemProxySettings, AppError> {
    let settings = normalize_proxy_settings(settings)?;
    let mut store = load_store().await?;
    store.proxy = settings.clone();
    save_store(&store).await?;
    Ok(settings)
}

#[tauri::command]
pub async fn get_system_rendering_settings() -> Result<SystemRenderingSettings, AppError> {
    Ok(load_store().await?.rendering)
}

#[tauri::command]
pub async fn update_system_rendering_settings(
    settings: SystemRenderingSettings,
) -> Result<SystemRenderingSettings, AppError> {
    let mut store = load_store().await?;
    store.rendering = settings.clone();
    save_store(&store).await?;
    Ok(settings)
}
