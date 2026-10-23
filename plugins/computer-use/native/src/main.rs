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

use std::net::SocketAddr;
use std::path::PathBuf;
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

#[derive(Deserialize)]
struct RpcRequest {
    method: String,
    #[serde(default)]
    params: Value,
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
            "usage: vibex-computer-helper {REQUEST_PERMISSION_ARG} accessibility|screen-recording"
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
            .join("vibex-plugin-computer-use")
    });
    let _ = std::fs::create_dir_all(&data_dir);

    let state = DaemonState::new(&data_dir).await;

    let app = Router::new()
        .route("/health", get(handle_health).options(handle_options))
        .route("/rpc", post(handle_rpc).options(handle_options))
        .with_state(state);

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
    });
    let daemon_json_path = data_dir.join("daemon.json");
    if let Ok(text) = serde_json::to_string_pretty(&daemon_info) {
        let _ = std::fs::write(&daemon_json_path, text);
    }

    println!("DAEMON_READY {url}");

    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("[computer-daemon] server error: {e}");
        return 1;
    }

    0
}

fn cors_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*".parse().unwrap());
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        "GET, POST, OPTIONS".parse().unwrap(),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        "content-type".parse().unwrap(),
    );
    headers.insert(
        "access-control-allow-private-network",
        "true".parse().unwrap(),
    );
    headers
}

async fn handle_options() -> impl IntoResponse {
    (StatusCode::NO_CONTENT, cors_headers())
}

async fn handle_health() -> impl IntoResponse {
    (
        cors_headers(),
        Json(json!({
            "ok": true,
            "pid": std::process::id(),
            "version": env!("CARGO_PKG_VERSION"),
        })),
    )
}

async fn handle_rpc(
    State(state): State<Arc<DaemonState>>,
    Json(req): Json<RpcRequest>,
) -> impl IntoResponse {
    let payload = match state.dispatch_rpc(&req.method, req.params).await {
        Ok(result) => json!({
            "ok": true,
            "result": result,
        }),
        Err(error) => json!({
            "ok": false,
            "error": error,
        }),
    };
    (cors_headers(), Json(payload))
}
