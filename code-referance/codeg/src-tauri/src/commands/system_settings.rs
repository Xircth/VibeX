use sea_orm::DatabaseConnection;
use tauri::{Emitter, State};

use crate::app_error::AppCommandError;
use crate::db::service::app_metadata_service;
use crate::db::AppDatabase;
use crate::models::{SystemLanguageSettings, SystemProxySettings};
use crate::network::proxy;

const SYSTEM_PROXY_SETTINGS_KEY: &str = "system_proxy_settings";
const SYSTEM_LANGUAGE_SETTINGS_KEY: &str = "system_language_settings";
const LANGUAGE_SETTINGS_UPDATED_EVENT: &str = "app://language-settings-updated";

fn normalize_proxy_settings(
    settings: SystemProxySettings,
) -> Result<SystemProxySettings, AppCommandError> {
    if !settings.enabled {
        let proxy_url = settings
            .proxy_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);

        return Ok(SystemProxySettings {
            enabled: false,
            proxy_url,
        });
    }

    let proxy_url = settings
        .proxy_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AppCommandError::configuration_missing("Proxy URL is required when proxy is enabled")
        })?;

    reqwest::Proxy::all(proxy_url).map_err(|e| {
        AppCommandError::configuration_invalid("Invalid proxy URL").with_detail(e.to_string())
    })?;

    Ok(SystemProxySettings {
        enabled: true,
        proxy_url: Some(proxy_url.to_string()),
    })
}

pub(crate) async fn load_system_proxy_settings(
    conn: &DatabaseConnection,
) -> Result<SystemProxySettings, AppCommandError> {
    let raw = app_metadata_service::get_value(conn, SYSTEM_PROXY_SETTINGS_KEY)
        .await
        .map_err(AppCommandError::from)?;

    let Some(raw) = raw else {
        return Ok(SystemProxySettings::default());
    };

    let parsed = serde_json::from_str::<SystemProxySettings>(&raw).map_err(|e| {
        AppCommandError::configuration_invalid("Failed to parse stored proxy settings")
            .with_detail(e.to_string())
    })?;
    normalize_proxy_settings(parsed)
}

pub(crate) async fn load_system_language_settings(
    conn: &DatabaseConnection,
) -> Result<SystemLanguageSettings, AppCommandError> {
    let raw = app_metadata_service::get_value(conn, SYSTEM_LANGUAGE_SETTINGS_KEY)
        .await
        .map_err(AppCommandError::from)?;

    let Some(raw) = raw else {
        return Ok(SystemLanguageSettings::default());
    };

    serde_json::from_str::<SystemLanguageSettings>(&raw).map_err(|e| {
        AppCommandError::configuration_invalid("Failed to parse stored language settings")
            .with_detail(e.to_string())
    })
}

#[tauri::command]
pub async fn get_system_proxy_settings(
    db: State<'_, AppDatabase>,
) -> Result<SystemProxySettings, AppCommandError> {
    load_system_proxy_settings(&db.conn).await
}

#[tauri::command]
pub async fn update_system_proxy_settings(
    settings: SystemProxySettings,
    db: State<'_, AppDatabase>,
) -> Result<SystemProxySettings, AppCommandError> {
    let normalized = normalize_proxy_settings(settings)?;
    let serialized = serde_json::to_string(&normalized).map_err(|e| {
        AppCommandError::invalid_input("Failed to serialize proxy settings")
            .with_detail(e.to_string())
    })?;

    app_metadata_service::upsert_value(&db.conn, SYSTEM_PROXY_SETTINGS_KEY, &serialized)
        .await
        .map_err(AppCommandError::from)?;

    proxy::apply_system_proxy_settings(&normalized)?;
    Ok(normalized)
}

#[tauri::command]
pub async fn get_system_language_settings(
    db: State<'_, AppDatabase>,
) -> Result<SystemLanguageSettings, AppCommandError> {
    load_system_language_settings(&db.conn).await
}

#[tauri::command]
pub async fn update_system_language_settings(
    settings: SystemLanguageSettings,
    db: State<'_, AppDatabase>,
    app: tauri::AppHandle,
) -> Result<SystemLanguageSettings, AppCommandError> {
    let serialized = serde_json::to_string(&settings).map_err(|e| {
        AppCommandError::invalid_input("Failed to serialize language settings")
            .with_detail(e.to_string())
    })?;

    app_metadata_service::upsert_value(&db.conn, SYSTEM_LANGUAGE_SETTINGS_KEY, &serialized)
        .await
        .map_err(AppCommandError::from)?;

    let _ = app.emit(LANGUAGE_SETTINGS_UPDATED_EVENT, &settings);

    Ok(settings)
}
