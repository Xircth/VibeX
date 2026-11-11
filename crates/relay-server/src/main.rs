use std::{net::SocketAddr, path::PathBuf, sync::Arc};

use relay_server::{DEFAULT_RELAY_PORT, RelayServerState, run_relay_server};
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let listen_raw = std::env::var("VIBEX_RELAY_LISTEN")
        .ok()
        .or_else(|| {
            let mut args = std::env::args().skip(1);
            while let Some(arg) = args.next() {
                if arg == "--listen" {
                    return args.next();
                }
            }
            None
        })
        .unwrap_or_else(|| format!("0.0.0.0:{DEFAULT_RELAY_PORT}"));

    let listen_addr: SocketAddr = listen_raw.parse()?;
    let token_store_path = std::env::var("VIBEX_RELAY_TOKEN_STORE")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("vibex-relay-tokens.json"));

    let listener = TcpListener::bind(listen_addr).await?;
    tracing::info!(
        "VibeX Multi-Tenant Relay Server listening on {} (token store: {})",
        listener.local_addr()?,
        token_store_path.display()
    );

    let state = Arc::new(RelayServerState::new(Some(token_store_path)));
    run_relay_server(listener, state).await
}
