use std::sync::Arc;

use axum::{
    Router,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Serialize;
use sqlx::SqlitePool;

const PROTOCOL: &str = "1.0";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDevConnection {
    pub endpoint: String,
    pub token: String,
    pub protocol_version: &'static str,
}

#[derive(Clone)]
pub struct DesktopPreviewProxy;

impl DesktopPreviewProxy {
    pub async fn start_with_registry(
        registry: server::PreviewProxyRegistry,
    ) -> anyhow::Result<Self> {
        let _endpoint = server::start_loopback_preview_proxy(registry).await?;
        Ok(Self)
    }
}

#[tauri::command]
pub fn plugin_dev_connection(
    connection: tauri::State<'_, PluginDevConnection>,
) -> PluginDevConnection {
    connection.inner().clone()
}

pub async fn start(
    plugins: Arc<plugins::PluginControlPlane>,
    _pool: SqlitePool,
    _broker: Arc<dyn plugins::CapabilityBroker>,
    _worker_runtime: Arc<plugins::PluginWorkerRuntimeProvider>,
    _runtime_root: std::path::PathBuf,
    _candidate_root: std::path::PathBuf,
    _connection_path: Option<std::path::PathBuf>,
) -> anyhow::Result<PluginDevConnection> {
    start_artifact_http(plugins).await?;
    Ok(PluginDevConnection {
        endpoint: plugins::artifact_origin().unwrap_or("").to_owned(),
        token: String::new(),
        protocol_version: PROTOCOL,
    })
}

async fn start_artifact_http(plugins: Arc<plugins::PluginControlPlane>) -> anyhow::Result<()> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    plugins::set_artifact_origin(format!("http://{address}"));
    let router = Router::new()
        .route("/{plugin_id}/{*path}", get(serve_plugin_artifact))
        .with_state(plugins);
    tauri::async_runtime::spawn(async move {
        if let Err(error) = axum::serve(listener, router).await {
            tracing::warn!(%error, "Plugin artifact server stopped");
        }
    });
    Ok(())
}

async fn serve_plugin_artifact(
    State(plugins): State<Arc<plugins::PluginControlPlane>>,
    Path((plugin_id, path)): Path<(String, String)>,
) -> Response {
    let Ok(Some(plugin)) = plugins.plugin(&plugin_id).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if plugin.activation != plugins::PluginActivation::Enabled {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Ok(file) = plugin.package.checked_file(&path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(bytes) = tokio::fs::read(file).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let content_type = if path.ends_with(".js") || path.ends_with(".mjs") {
        "text/javascript; charset=utf-8"
    } else if path.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if path.ends_with(".json") {
        "application/json"
    } else {
        "application/octet-stream"
    };
    (
        [
            (axum::http::header::CONTENT_TYPE, content_type),
            (axum::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"),
            (axum::http::header::CACHE_CONTROL, "no-cache"),
        ],
        bytes,
    )
        .into_response()
}
