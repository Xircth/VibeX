use std::sync::{LazyLock, Mutex};

use crate::types::AppSettings;

const PROXY_ENV_KEYS: [&str; 8] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
];
const DEFAULT_NO_PROXY: &str = "localhost,127.0.0.1,::1";
type ProxyEnvSnapshot = Vec<(&'static str, Option<String>)>;

static INITIAL_PROXY_ENV: LazyLock<Mutex<Option<ProxyEnvSnapshot>>> =
    LazyLock::new(|| Mutex::new(None));

#[cfg(test)]
static PROXY_ENV_TEST_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

fn lock_proxy_env_state() -> std::sync::MutexGuard<'static, Option<ProxyEnvSnapshot>> {
    INITIAL_PROXY_ENV
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn snapshot_current_proxy_env() -> ProxyEnvSnapshot {
    PROXY_ENV_KEYS
        .iter()
        .map(|&key| (key, std::env::var(key).ok()))
        .collect()
}

fn initial_proxy_env_snapshot() -> ProxyEnvSnapshot {
    let mut snapshot = lock_proxy_env_state();
    if snapshot.is_none() {
        *snapshot = Some(snapshot_current_proxy_env());
    }
    snapshot.clone().unwrap_or_default()
}

fn restore_proxy_env_snapshot(snapshot: &[(&'static str, Option<String>)]) {
    clear_proxy_env();
    for (key, value) in snapshot {
        if let Some(value) = value {
            unsafe {
                std::env::set_var(key, value);
            }
        }
    }
}

fn append_no_proxy_values(values: &mut Vec<String>, raw: &str) {
    for item in raw.split(',') {
        let candidate = item.trim();
        if candidate.is_empty() {
            continue;
        }
        if values
            .iter()
            .any(|existing| existing.eq_ignore_ascii_case(candidate))
        {
            continue;
        }
        values.push(candidate.to_string());
    }
}

fn merged_no_proxy_value(snapshot: &[(&'static str, Option<String>)]) -> String {
    let mut values = Vec::new();
    for key in ["NO_PROXY", "no_proxy"] {
        if let Some(existing) = snapshot
            .iter()
            .find_map(|(snapshot_key, value)| (*snapshot_key == key).then_some(value.as_deref()))
            .flatten()
        {
            append_no_proxy_values(&mut values, existing);
        }
    }
    append_no_proxy_values(&mut values, DEFAULT_NO_PROXY);
    values.join(",")
}

fn normalized_proxy_url(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

pub(crate) fn validate_proxy_settings(settings: &AppSettings) -> Result<(), String> {
    if !settings.system_proxy_enabled {
        return Ok(());
    }
    let proxy_url = normalized_proxy_url(settings.system_proxy_url.as_deref())
        .ok_or_else(|| "Proxy URL is required when network proxy is enabled.".to_string())?;
    reqwest::Proxy::all(&proxy_url)
        .map(|_| ())
        .map_err(|error| format!("Invalid proxy URL: {error}"))
}

pub(crate) fn apply_app_proxy_settings(settings: &AppSettings) -> Result<(), String> {
    validate_proxy_settings(settings)?;
    let inherited_env = initial_proxy_env_snapshot();
    restore_proxy_env_snapshot(&inherited_env);
    if !settings.system_proxy_enabled {
        return Ok(());
    }

    let proxy_url = normalized_proxy_url(settings.system_proxy_url.as_deref())
        .ok_or_else(|| "Proxy URL is required when network proxy is enabled.".to_string())?;

    for key in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ] {
        unsafe {
            std::env::set_var(key, &proxy_url);
        }
    }

    let no_proxy = merged_no_proxy_value(&inherited_env);
    for key in ["NO_PROXY", "no_proxy"] {
        unsafe {
            std::env::set_var(key, &no_proxy);
        }
    }

    Ok(())
}

pub(crate) fn clear_proxy_env() {
    for key in PROXY_ENV_KEYS {
        unsafe {
            std::env::remove_var(key);
        }
    }
}

#[cfg(test)]
pub(crate) fn reset_initial_proxy_env_for_tests() {
    let mut snapshot = lock_proxy_env_state();
    *snapshot = Some(snapshot_current_proxy_env());
}

#[cfg(test)]
mod tests {
    use super::{
        apply_app_proxy_settings, clear_proxy_env, reset_initial_proxy_env_for_tests,
        validate_proxy_settings, PROXY_ENV_KEYS, PROXY_ENV_TEST_LOCK,
    };
    use crate::types::AppSettings;

    fn snapshot_env() -> Vec<(&'static str, Option<String>)> {
        PROXY_ENV_KEYS
            .iter()
            .map(|&key| (key, std::env::var(key).ok()))
            .collect()
    }

    fn restore_env(snapshot: &[(&'static str, Option<String>)]) {
        clear_proxy_env();
        for (key, value) in snapshot {
            if let Some(value) = value {
                unsafe {
                    std::env::set_var(key, value);
                }
            }
        }
        reset_initial_proxy_env_for_tests();
    }

    #[test]
    fn disabled_proxy_settings_are_valid() {
        let settings = AppSettings::default();
        assert!(validate_proxy_settings(&settings).is_ok());
    }

    #[test]
    fn enabled_proxy_requires_url() {
        let mut settings = AppSettings::default();
        settings.system_proxy_enabled = true;
        assert!(validate_proxy_settings(&settings).is_err());
    }

    #[test]
    fn enabled_proxy_populates_env_vars() {
        let _guard = PROXY_ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let original_env = snapshot_env();
        clear_proxy_env();
        reset_initial_proxy_env_for_tests();

        let mut settings = AppSettings::default();
        settings.system_proxy_enabled = true;
        settings.system_proxy_url = Some("http://127.0.0.1:7890".to_string());
        apply_app_proxy_settings(&settings).expect("apply proxy");
        assert_eq!(
            std::env::var("HTTP_PROXY").ok().as_deref(),
            Some("http://127.0.0.1:7890")
        );
        assert_eq!(
            std::env::var("NO_PROXY").ok().as_deref(),
            Some("localhost,127.0.0.1,::1")
        );

        restore_env(&original_env);
    }

    #[test]
    fn disabling_proxy_restores_inherited_env() {
        let _guard = PROXY_ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let original_env = snapshot_env();
        clear_proxy_env();
        unsafe {
            std::env::set_var("HTTP_PROXY", "http://corp-gateway:8080");
            std::env::set_var("NO_PROXY", "corp.local,internal.example");
        }
        reset_initial_proxy_env_for_tests();

        let mut enabled = AppSettings::default();
        enabled.system_proxy_enabled = true;
        enabled.system_proxy_url = Some("http://127.0.0.1:7890".to_string());
        apply_app_proxy_settings(&enabled).expect("enable proxy");
        assert_eq!(
            std::env::var("HTTP_PROXY").ok().as_deref(),
            Some("http://127.0.0.1:7890")
        );
        assert_eq!(
            std::env::var("NO_PROXY").ok().as_deref(),
            Some("corp.local,internal.example,localhost,127.0.0.1,::1")
        );

        apply_app_proxy_settings(&AppSettings::default()).expect("disable proxy");
        assert_eq!(
            std::env::var("HTTP_PROXY").ok().as_deref(),
            Some("http://corp-gateway:8080")
        );
        assert_eq!(
            std::env::var("NO_PROXY").ok().as_deref(),
            Some("corp.local,internal.example")
        );

        restore_env(&original_env);
    }
}
