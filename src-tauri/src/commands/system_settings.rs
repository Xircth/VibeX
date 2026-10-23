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

pub async fn init_system_proxy() {
    capture_inherited_proxy();
    match load_store().await {
        Ok(store) => apply_system_proxy_settings(&store.proxy),
        Err(error) => {
            tracing::warn!(%error, "Failed to load system proxy settings at startup");
        }
    }
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
