use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use services::services::settings_store::{read_section, write_section};
use utils::proxy::{DetectedProxy, capture_inherited_proxy, detect_proxy};

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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProxyMode {
    #[default]
    Auto,
    Manual,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SystemProxySettings {
    #[serde(default)]
    pub mode: ProxyMode,
    #[serde(default)]
    pub proxy_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detected_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detected_source: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct PersistedProxy {
    mode: ProxyMode,
    proxy_url: Option<String>,
}

impl Default for PersistedProxy {
    fn default() -> Self {
        Self {
            mode: ProxyMode::Auto,
            proxy_url: None,
        }
    }
}

impl<'de> Deserialize<'de> for PersistedProxy {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Wire {
            #[serde(default)]
            mode: Option<ProxyMode>,
            #[serde(default)]
            enabled: Option<bool>,
            #[serde(default)]
            proxy_url: Option<String>,
        }

        let wire = Wire::deserialize(deserializer)?;
        let mode = match wire.mode {
            Some(mode) => mode,
            None if wire.enabled == Some(true) => ProxyMode::Manual,
            None => ProxyMode::Auto,
        };
        Ok(Self {
            mode,
            proxy_url: wire.proxy_url,
        })
    }
}

impl From<&SystemProxySettings> for PersistedProxy {
    fn from(settings: &SystemProxySettings) -> Self {
        Self {
            mode: settings.mode,
            proxy_url: settings.proxy_url.clone(),
        }
    }
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
    proxy: PersistedProxy,
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

fn normalize_proxy_settings(settings: SystemProxySettings) -> Result<PersistedProxy, AppError> {
    let proxy_url = settings
        .proxy_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);

    if settings.mode == ProxyMode::Manual {
        let Some(proxy_url) = proxy_url.as_deref() else {
            return Err(AppError::BadRequest(
                "Proxy URL is required when proxy is set to manual".to_string(),
            ));
        };

        reqwest::Proxy::all(proxy_url)
            .map_err(|error| AppError::BadRequest(format!("Invalid proxy URL: {error}")))?;
    }

    Ok(PersistedProxy {
        mode: settings.mode,
        proxy_url,
    })
}

fn enrich_proxy_settings(persisted: PersistedProxy) -> SystemProxySettings {
    let detected = detect_proxy();
    SystemProxySettings {
        mode: persisted.mode,
        proxy_url: persisted.proxy_url,
        detected_url: detected.as_ref().map(|item| item.url.clone()),
        detected_source: detected
            .as_ref()
            .map(|item| item.source.as_str().to_string()),
    }
}

/// Apply the proxy setting to this process's environment so reqwest clients and
/// spawned ACP agent children actually route through it. Without this the setting
/// is inert: VibeX's own HTTP and `merged_agent_env` (which forwards the proxy
/// env to the agent child) both read process env, which would otherwise be unset
/// — so e.g. codex-acp can't reach `auth.openai.com` and stalls the turn.
///
/// Auto-detect writes the OS/env URL; manual writes the saved URL; a miss
/// clears the keys so an explicit Auto with no proxy really turns it off.
/// Mutating process env is `unsafe`
/// on edition 2024 (it is not synchronized with concurrent env reads); we accept
/// that because proxy changes are rare and applied at startup / on explicit user
/// action, the same tradeoff every CLI that honors `HTTP_PROXY` makes.
fn apply_system_proxy_settings(settings: &PersistedProxy) {
    match proxy_url_to_apply(settings, detect_proxy().as_ref()) {
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
/// auto/manual/blank-url decision is testable without mutating process env.
fn proxy_url_to_apply(
    settings: &PersistedProxy,
    detected: Option<&DetectedProxy>,
) -> Option<String> {
    match settings.mode {
        ProxyMode::Manual => settings
            .proxy_url
            .as_deref()
            .map(str::trim)
            .filter(|url| !url.is_empty())
            .map(ToOwned::to_owned),
        ProxyMode::Auto => detected.and_then(|item| {
            item.source
                .applies_to_process()
                .then(|| item.url.trim().to_string())
                .filter(|url| !url.is_empty())
        }),
    }
}

/// Load the persisted proxy setting and apply it to process env at startup —
/// before any reqwest client is built or any agent is spawned. Auto-detect is
/// the default; a missing setting uses the OS proxy when one is present.
/// Errors are logged and dropped so a bad setting can't block startup.
pub async fn init_system_proxy() {
    capture_inherited_proxy();
    match load_store().await {
        Ok(store) => apply_system_proxy_settings(&store.proxy),
        Err(error) => {
            tracing::warn!(%error, "Failed to load system proxy settings at startup");
        }
    }
}

#[tauri::command]
pub async fn get_system_proxy_settings() -> Result<SystemProxySettings, AppError> {
    Ok(enrich_proxy_settings(load_store().await?.proxy))
}

#[tauri::command]
pub async fn update_system_proxy_settings(
    settings: SystemProxySettings,
) -> Result<SystemProxySettings, AppError> {
    let persisted = normalize_proxy_settings(settings)?;
    let mut store = load_store().await?;
    store.proxy = persisted.clone();
    save_store(&store).await?;
    // Take effect immediately for new HTTP clients and agent launches; existing
    // long-lived agent connections pick it up on their next (re)spawn.
    apply_system_proxy_settings(&persisted);
    Ok(enrich_proxy_settings(persisted))
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
    use utils::proxy::ProxySource;

    use super::*;

    #[test]
    fn manual_proxy_with_url_is_applied() {
        assert_eq!(
            proxy_url_to_apply(
                &PersistedProxy {
                    mode: ProxyMode::Manual,
                    proxy_url: Some("  http://127.0.0.1:7890  ".to_string()),
                },
                None
            ),
            Some("http://127.0.0.1:7890".to_string())
        );
    }

    #[test]
    fn auto_proxy_uses_detected_system_url() {
        assert_eq!(
            proxy_url_to_apply(
                &PersistedProxy {
                    mode: ProxyMode::Auto,
                    proxy_url: Some("http://stale.example:7890".to_string()),
                },
                Some(&DetectedProxy {
                    url: "http://127.0.0.1:7890".to_string(),
                    source: ProxySource::System,
                })
            ),
            Some("http://127.0.0.1:7890".to_string())
        );
    }

    #[test]
    fn auto_proxy_ignores_pac_only_detection() {
        assert_eq!(
            proxy_url_to_apply(
                &PersistedProxy::default(),
                Some(&DetectedProxy {
                    url: "http://wpad.example/proxy.pac".to_string(),
                    source: ProxySource::Pac,
                })
            ),
            None
        );
    }

    #[test]
    fn auto_proxy_without_detection_clears_env() {
        assert_eq!(
            proxy_url_to_apply(
                &PersistedProxy {
                    mode: ProxyMode::Auto,
                    proxy_url: Some("http://127.0.0.1:7890".to_string()),
                },
                None
            ),
            None
        );
    }

    #[test]
    fn legacy_enabled_true_becomes_manual() {
        let persisted: PersistedProxy =
            serde_json::from_str(r#"{"enabled":true,"proxy_url":"http://127.0.0.1:7890"}"#)
                .expect("legacy proxy settings should deserialize");
        assert_eq!(persisted.mode, ProxyMode::Manual);
        assert_eq!(
            persisted.proxy_url.as_deref(),
            Some("http://127.0.0.1:7890")
        );
    }

    #[test]
    fn legacy_enabled_false_becomes_auto() {
        let persisted: PersistedProxy =
            serde_json::from_str(r#"{"enabled":false,"proxy_url":null}"#)
                .expect("legacy disabled proxy should deserialize");
        assert_eq!(persisted.mode, ProxyMode::Auto);
    }

    #[test]
    fn missing_proxy_section_defaults_to_auto() {
        assert_eq!(PersistedProxy::default().mode, ProxyMode::Auto);
    }
}
