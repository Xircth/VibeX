use std::{net::SocketAddr, path::PathBuf, sync::LazyLock};

use axum::{Json, Router, routing::get};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::{net::TcpListener, sync::Mutex, task::JoinHandle};
use uuid::Uuid;

use crate::error::AppError;

const SETTINGS_FILE_NAME: &str = "web-service-settings.json";
const DEFAULT_PORT: u16 = 17891;

static WEB_SERVICE_RUNTIME: LazyLock<Mutex<Option<WebServiceRuntime>>> =
    LazyLock::new(|| Mutex::new(None));

#[derive(Debug)]
struct WebServiceRuntime {
    port: u16,
    address: String,
    started_at: String,
    handle: JoinHandle<()>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebServiceConfig {
    pub port: u16,
    pub token: Option<String>,
    pub auto_start: bool,
}

impl Default for WebServiceConfig {
    fn default() -> Self {
        Self {
            port: DEFAULT_PORT,
            token: None,
            auto_start: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebServerStatus {
    pub running: bool,
    pub port: u16,
    pub address: Option<String>,
    pub token_configured: bool,
    pub started_at: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortProbeResult {
    pub port: u16,
    pub available: bool,
    pub message: Option<String>,
}

fn settings_path() -> PathBuf {
    utils::assets::asset_dir().join(SETTINGS_FILE_NAME)
}

fn validate_port(port: u16) -> Result<(), AppError> {
    if port == 0 {
        return Err(AppError::BadRequest(
            "Web service port must be between 1 and 65535".to_string(),
        ));
    }
    Ok(())
}

fn normalize_config(mut config: WebServiceConfig) -> Result<WebServiceConfig, AppError> {
    validate_port(config.port)?;
    config.token = config
        .token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    Ok(config)
}

async fn load_config() -> Result<WebServiceConfig, AppError> {
    let path = settings_path();
    if !path.exists() {
        return Ok(WebServiceConfig::default());
    }

    let content = tokio::fs::read_to_string(&path).await.map_err(|error| {
        AppError::Internal(format!(
            "Failed to read web service settings {}: {error}",
            path.display()
        ))
    })?;

    let config = serde_json::from_str(&content).map_err(|error| {
        AppError::Internal(format!(
            "Invalid web service settings {}: {error}",
            path.display()
        ))
    })?;
    normalize_config(config)
}

async fn save_config(config: &WebServiceConfig) -> Result<WebServiceConfig, AppError> {
    let config = normalize_config(config.clone())?;
    let path = settings_path();
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|error| {
            AppError::Internal(format!(
                "Failed to create web service settings directory {}: {error}",
                parent.display()
            ))
        })?;
    }

    let content = serde_json::to_string_pretty(&config)
        .map_err(|error| AppError::Internal(format!("Failed to serialize settings: {error}")))?;
    tokio::fs::write(&path, content).await.map_err(|error| {
        AppError::Internal(format!(
            "Failed to write web service settings {}: {error}",
            path.display()
        ))
    })?;
    Ok(config)
}

fn router() -> Router {
    Router::new()
        .route(
            "/",
            get(|| async {
                Json(json!({
                    "service": "VibeX Web Service",
                    "status": "ok",
                }))
            }),
        )
        .route(
            "/health",
            get(|| async {
                Json(json!({
                    "ok": true,
                    "service": "vibex",
                }))
            }),
        )
}

async fn status_from_runtime(config: WebServiceConfig) -> WebServerStatus {
    let runtime = WEB_SERVICE_RUNTIME.lock().await;
    if let Some(runtime) = runtime.as_ref() {
        return WebServerStatus {
            running: true,
            port: runtime.port,
            address: Some(runtime.address.clone()),
            token_configured: config.token.is_some(),
            started_at: Some(runtime.started_at.clone()),
            message: None,
        };
    }

    WebServerStatus {
        running: false,
        port: config.port,
        address: None,
        token_configured: config.token.is_some(),
        started_at: None,
        message: None,
    }
}

#[tauri::command]
pub async fn get_web_service_config() -> Result<WebServiceConfig, AppError> {
    load_config().await
}

#[tauri::command]
pub async fn update_web_service_config(
    config: WebServiceConfig,
) -> Result<WebServiceConfig, AppError> {
    save_config(&config).await
}

#[tauri::command]
pub async fn get_web_server_status() -> Result<WebServerStatus, AppError> {
    let config = load_config().await?;
    Ok(status_from_runtime(config).await)
}

#[tauri::command]
pub async fn start_web_server() -> Result<WebServerStatus, AppError> {
    let config = load_config().await?;
    validate_port(config.port)?;

    {
        let runtime = WEB_SERVICE_RUNTIME.lock().await;
        if runtime.is_some() {
            drop(runtime);
            return Ok(status_from_runtime(config).await);
        }
    }

    let listener = TcpListener::bind(("127.0.0.1", config.port))
        .await
        .map_err(|error| {
            AppError::Conflict(format!(
                "Failed to bind web service on 127.0.0.1:{}: {error}",
                config.port
            ))
        })?;
    let local_addr = listener.local_addr().map_err(|error| {
        AppError::Internal(format!("Failed to read web service address: {error}"))
    })?;
    let address = format!("http://{}", local_addr);
    let started_at = Utc::now().to_rfc3339();
    let app = router();
    let handle = tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, app).await {
            tracing::warn!("VibeX web service stopped with error: {}", error);
        }
    });

    let mut runtime = WEB_SERVICE_RUNTIME.lock().await;
    *runtime = Some(WebServiceRuntime {
        port: local_addr.port(),
        address,
        started_at,
        handle,
    });

    Ok(status_from_runtime(config).await)
}

#[tauri::command]
pub async fn stop_web_server() -> Result<WebServerStatus, AppError> {
    let config = load_config().await?;
    let mut runtime = WEB_SERVICE_RUNTIME.lock().await;
    if let Some(runtime) = runtime.take() {
        runtime.handle.abort();
    }
    drop(runtime);
    Ok(status_from_runtime(config).await)
}

#[tauri::command]
pub async fn probe_web_service_port(port: u16) -> Result<PortProbeResult, AppError> {
    validate_port(port)?;
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    match TcpListener::bind(addr).await {
        Ok(listener) => {
            drop(listener);
            Ok(PortProbeResult {
                port,
                available: true,
                message: None,
            })
        }
        Err(error) => Ok(PortProbeResult {
            port,
            available: false,
            message: Some(error.to_string()),
        }),
    }
}

#[tauri::command]
pub async fn generate_web_service_token() -> Result<WebServiceConfig, AppError> {
    let mut config = load_config().await?;
    config.token = Some(Uuid::new_v4().simple().to_string());
    save_config(&config).await
}

pub async fn ensure_web_service_autostart() -> Result<(), AppError> {
    let config = load_config().await?;
    if config.auto_start {
        let _ = start_web_server().await?;
    }
    Ok(())
}
