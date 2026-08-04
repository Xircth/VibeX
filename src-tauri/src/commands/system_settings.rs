use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use services::services::settings_store::{read_section, write_section};

use crate::error::AppError;

const SETTINGS_FILE_NAME: &str = "system-settings.json";
const SETTINGS_SECTION: &str = "system";

/// Env vars that carry the proxy URL. Setting these is what actually routes
/// traffic through the proxy: reqwest reads them when a client is built, and the
/// ACP agent child (e.g. codex-acp) inherits them so it too reaches the network
/// through the proxy. Both upper- and lower-case forms are set because different
/// HTTP stacks read different ones.
const PROXY_URL_ENV_KEYS: [&str; 6] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
];

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
    let unified_path = utils::assets::settings_path();
    if let Some(store) = read_section(&unified_path, SETTINGS_SECTION)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?
    {
        return Ok(store);
    }

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

    let store = serde_json::from_str(&content).map_err(|error| {
        AppError::Internal(format!(
            "Invalid system settings {}: {error}",
            path.display()
        ))
    })?;
    write_section(&unified_path, SETTINGS_SECTION, &store)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;
    Ok(store)
}

async fn save_store(store: &SystemSettingsStore) -> Result<(), AppError> {
    write_section(&utils::assets::settings_path(), SETTINGS_SECTION, store)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))
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

/// Apply the proxy setting to this process's environment so reqwest clients and
/// spawned ACP agent children actually route through it. Without this the setting
/// is inert: VibeX's own HTTP and `merged_agent_env` (which forwards the proxy
/// env to the agent child) both read process env, which would otherwise be unset
/// — so e.g. codex-acp can't reach `auth.openai.com` and stalls the turn.
///
/// `enabled` sets the URL on every proxy env key; disabling removes them so an
/// explicit "off" really turns the proxy off. Mutating process env is `unsafe`
/// on edition 2024 (it is not synchronized with concurrent env reads); we accept
/// that because proxy changes are rare and applied at startup / on explicit user
/// action, the same tradeoff every CLI that honors `HTTP_PROXY` makes.
pub fn apply_system_proxy_settings(settings: &SystemProxySettings) {
    match proxy_url_to_apply(settings) {
        Some(url) => {
            for key in PROXY_URL_ENV_KEYS {
                unsafe { std::env::set_var(key, &url) };
            }
        }
        None => {
            for key in PROXY_URL_ENV_KEYS {
                unsafe { std::env::remove_var(key) };
            }
        }
    }
}

/// The proxy URL to write to env (`Some`), or `None` to clear it. Pure so the
/// enable/disable/blank-url decision is testable without mutating process env.
fn proxy_url_to_apply(settings: &SystemProxySettings) -> Option<String> {
    match (settings.enabled, settings.proxy_url.as_deref()) {
        (true, Some(url)) if !url.trim().is_empty() => Some(url.trim().to_string()),
        _ => None,
    }
}

/// Load the persisted proxy setting and apply it to process env at startup —
/// before any reqwest client is built or any agent is spawned. Only applies when
/// the user enabled a proxy; a disabled/absent setting leaves any externally-set
/// `HTTP_PROXY` (docker `-e`, shell export) untouched. Errors are logged and
/// dropped so a bad setting can't block startup.
pub async fn init_system_proxy() {
    match load_store().await {
        Ok(store) if store.proxy.enabled => apply_system_proxy_settings(&store.proxy),
        Ok(_) => {}
        Err(error) => {
            tracing::warn!(%error, "Failed to load system proxy settings at startup");
        }
    }
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
    // Take effect immediately for new HTTP clients and agent launches; existing
    // long-lived agent connections pick it up on their next (re)spawn.
    apply_system_proxy_settings(&settings);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enabled_proxy_with_url_is_applied() {
        assert_eq!(
            proxy_url_to_apply(&SystemProxySettings {
                enabled: true,
                proxy_url: Some("  http://127.0.0.1:7890  ".to_string()),
            }),
            Some("http://127.0.0.1:7890".to_string())
        );
    }

    #[test]
    fn disabled_proxy_clears_env_even_with_url() {
        assert_eq!(
            proxy_url_to_apply(&SystemProxySettings {
                enabled: false,
                proxy_url: Some("http://127.0.0.1:7890".to_string()),
            }),
            None
        );
    }

    #[test]
    fn enabled_proxy_with_blank_url_clears_env() {
        assert_eq!(
            proxy_url_to_apply(&SystemProxySettings {
                enabled: true,
                proxy_url: Some("   ".to_string()),
            }),
            None
        );
        assert_eq!(
            proxy_url_to_apply(&SystemProxySettings {
                enabled: true,
                proxy_url: None,
            }),
            None
        );
    }
}
