// Prevent extra console window on Windows when spawned in helper/daemon mode
#![cfg_attr(not(debug_assertions), windows_subsystem = "console")]

pub mod compat;
pub mod computer;
pub mod mcp_dispatch;
pub mod service;

pub mod commands {
    pub mod computer;
}

pub mod acp {
    pub mod computer_tools;
    pub mod error {
        pub use crate::compat::acp_error::AcpError;
    }
    pub use crate::compat::acp_error::AcpError;
    pub use crate::compat::binary_cache;
    pub mod delegation {
        pub use crate::compat::transport;
    }
    pub use crate::compat::registry;
}

pub mod app_error {
    pub use crate::compat::app_error::AppCommandError;
}

pub mod browser {
    pub use crate::compat::browser_agent as agent;
}

pub mod web {
    pub use crate::compat::event_bridge;
}

pub use crate::compat::models;

use std::io::Write;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::computer::helper::{run, EXIT_FAILED};
use crate::computer::protocol::{OsPermission, PermissionAsked, REQUEST_PERMISSION_ARG};
use crate::service::DaemonState;

#[derive(Clone)]
struct DaemonHttpState {
    daemon: Arc<DaemonState>,
    token: Arc<str>,
}

#[derive(Deserialize)]
struct RpcRequest {
    method: String,
    #[serde(default)]
    params: Value,
}

fn generate_daemon_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn write_daemon_json(path: &Path, contents: &str) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut opts = std::fs::OpenOptions::new();
        opts.create(true).write(true).truncate(true).mode(0o600);
        let mut file = opts.open(path)?;
        file.write_all(contents.as_bytes())?;
        return file.flush();
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, contents)
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn is_authorized_bearer(headers: &HeaderMap, expected_token: &str) -> bool {
    let Some(raw) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let trimmed = raw.trim();
    let Some((scheme, provided)) = trimmed.split_once(' ') else {
        return false;
    };
    if !scheme.eq_ignore_ascii_case("bearer") {
        return false;
    }
    constant_time_eq(provided.trim().as_bytes(), expected_token.as_bytes())
}

fn build_daemon_router(state: DaemonHttpState) -> Router {
    Router::new()
        .route("/health", get(handle_health))
        .route("/rpc", post(handle_rpc))
        .with_state(state)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some(REQUEST_PERMISSION_ARG) {
        std::process::exit(request_permission(args.get(2).map(String::as_str)));
    }
    if args.iter().any(|a| a == "--daemon") {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("failed to build tokio runtime");
        let code = rt.block_on(run_daemon(&args));
        std::process::exit(code);
    }
    // Helper mode MUST run before any Tokio runtime threads exist
    std::process::exit(run());
}

fn request_permission(name: Option<&str>) -> i32 {
    let Some(permission) = name.and_then(OsPermission::from_arg) else {
        eprintln!(
            "usage: dimo-computer-helper {REQUEST_PERMISSION_ARG} accessibility|screen-recording"
        );
        return EXIT_FAILED;
    };
    let _ = permission;
    let prompted = false;
    match serde_json::to_string(&PermissionAsked { prompted }) {
        Ok(line) => {
            println!("{line}");
            0
        }
        Err(e) => {
            eprintln!("{e}");
            EXIT_FAILED
        }
    }
}

async fn run_daemon(args: &[String]) -> i32 {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .try_init();

    let mut data_dir: Option<PathBuf> = None;
    let mut port: u16 = 0;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--data-dir" if i + 1 < args.len() => {
                data_dir = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            "--port" if i + 1 < args.len() => {
                port = args[i + 1].parse().unwrap_or(0);
                i += 2;
            }
            _ => {
                i += 1;
            }
        }
    }

    let data_dir = data_dir.unwrap_or_else(|| {
        dirs::data_local_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("dimo-plugin-computer-use")
    });
    let _ = std::fs::create_dir_all(&data_dir);

    let daemon = DaemonState::new(&data_dir).await;
    let token = generate_daemon_token();
    let app = build_daemon_router(DaemonHttpState {
        daemon,
        token: Arc::from(token.as_str()),
    });

    let bind_addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = match tokio::net::TcpListener::bind(bind_addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[computer-daemon] failed to bind {bind_addr}: {e}");
            return 1;
        }
    };
    let local_addr = match listener.local_addr() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("[computer-daemon] failed to read local_addr: {e}");
            return 1;
        }
    };

    let url = format!("http://127.0.0.1:{}", local_addr.port());
    let daemon_info = json!({
        "url": url,
        "port": local_addr.port(),
        "pid": std::process::id(),
        "dataDir": data_dir.to_string_lossy(),
        "token": token,
    });
    let daemon_json_path = data_dir.join("daemon.json");
    if let Ok(text) = serde_json::to_string_pretty(&daemon_info) {
        if let Err(err) = write_daemon_json(&daemon_json_path, &text) {
            eprintln!("[computer-daemon] failed to write daemon.json: {err}");
            return 1;
        }
    }

    println!("DAEMON_READY {url}");
    let _ = std::io::stdout().flush();

    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("[computer-daemon] server error: {e}");
        return 1;
    }

    0
}

async fn handle_health(
    State(state): State<DaemonHttpState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if !is_authorized_bearer(&headers, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "ok": false, "error": "unauthorized" })),
        );
    }
    (
        StatusCode::OK,
        Json(json!({
            "ok": true,
            "auth": true,
            "pid": std::process::id(),
            "version": env!("CARGO_PKG_VERSION"),
        })),
    )
}

async fn handle_rpc(
    State(state): State<DaemonHttpState>,
    headers: HeaderMap,
    Json(req): Json<RpcRequest>,
) -> impl IntoResponse {
    if !is_authorized_bearer(&headers, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "ok": false,
                "error": "unauthorized",
            })),
        );
    }
    let payload = match state.daemon.dispatch_rpc(&req.method, req.params).await {
        Ok(result) => json!({
            "ok": true,
            "result": result,
        }),
        Err(error) => json!({
            "ok": false,
            "error": error,
        }),
    };
    (StatusCode::OK, Json(payload))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn daemon_endpoints_require_bearer_token_and_omit_wildcard_cors() {
        let dir = tempfile::tempdir().expect("tempdir");
        let daemon = DaemonState::new(dir.path()).await;
        let app = build_daemon_router(DaemonHttpState {
            daemon,
            token: Arc::from("secret-test-token"),
        });

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let addr = listener.local_addr().expect("local addr");
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let client = reqwest::Client::new();
        let base = format!("http://{addr}");

        let unauth_rpc = client
            .post(format!("{base}/rpc"))
            .json(&json!({ "method": "computer.status", "params": {} }))
            .send()
            .await
            .expect("unauth rpc");
        assert_eq!(unauth_rpc.status(), reqwest::StatusCode::UNAUTHORIZED);
        assert!(unauth_rpc
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .is_none());
        assert!(unauth_rpc
            .headers()
            .get("access-control-allow-private-network")
            .is_none());

        let wrong_token = client
            .get(format!("{base}/health"))
            .bearer_auth("wrong-token")
            .send()
            .await
            .expect("wrong token health");
        assert_eq!(wrong_token.status(), reqwest::StatusCode::UNAUTHORIZED);

        let authed_health = client
            .get(format!("{base}/health"))
            .bearer_auth("secret-test-token")
            .send()
            .await
            .expect("authed health");
        assert_eq!(authed_health.status(), reqwest::StatusCode::OK);
        assert!(authed_health
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .is_none());

        let authed_rpc = client
            .post(format!("{base}/rpc"))
            .bearer_auth("secret-test-token")
            .json(&json!({ "method": "computer.status", "params": {} }))
            .send()
            .await
            .expect("authed rpc");
        assert_eq!(authed_rpc.status(), reqwest::StatusCode::OK);

        handle.abort();
    }
}
