use std::sync::Arc;

use axum::{
    Router,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use plugins::{PluginActivation, PluginControlPlane};

pub async fn start_plugin_artifact_http(plugins: Arc<PluginControlPlane>) -> anyhow::Result<()> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    plugins::set_artifact_origin(format!("http://{address}"));
    let router = Router::new()
        .route("/{plugin_id}/{*path}", get(serve_plugin_artifact))
        .with_state(plugins);
    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, router).await {
            tracing::warn!(%error, "Plugin artifact server stopped");
        }
    });
    Ok(())
}

async fn serve_plugin_artifact(
    State(plugins): State<Arc<PluginControlPlane>>,
    Path((plugin_id, path)): Path<(String, String)>,
) -> Response {
    let Ok(Some(plugin)) = plugins.plugin(&plugin_id).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if plugin.activation != PluginActivation::Enabled {
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
