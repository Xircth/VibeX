use crate::app_error::AppCommandError;
use crate::models::SystemProxySettings;

const PROXY_ENV_KEYS: [&str; 6] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
];

pub fn apply_system_proxy_settings(settings: &SystemProxySettings) -> Result<(), AppCommandError> {
    if settings.enabled {
        let proxy_url = settings
            .proxy_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                AppCommandError::configuration_missing(
                    "Proxy URL is required when proxy is enabled",
                )
            })?;

        for key in PROXY_ENV_KEYS {
            unsafe {
                std::env::set_var(key, proxy_url);
            }
        }
    } else {
        clear_proxy_env();
    }

    Ok(())
}

pub fn clear_proxy_env() {
    for key in PROXY_ENV_KEYS {
        unsafe {
            std::env::remove_var(key);
        }
    }
}

pub fn current_proxy_env_vars() -> Vec<(String, String)> {
    PROXY_ENV_KEYS
        .iter()
        .filter_map(|key| {
            std::env::var(key).ok().and_then(|value| {
                let trimmed = value.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(((*key).to_string(), trimmed.to_string()))
                }
            })
        })
        .collect()
}
