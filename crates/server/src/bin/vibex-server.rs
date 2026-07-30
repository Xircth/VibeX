use std::{net::SocketAddr, path::PathBuf, process::ExitCode};

use server::{HeadlessServer, ServerBootstrapConfig, ServerConfig, ServerToken};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> ExitCode {
    if std::env::args().any(|argument| argument == "--version" || argument == "-V") {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .without_time()
        .init();

    let data_dir = std::env::var_os("VIBEX_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs::data_dir().map(|path| path.join("vibex")))
        .unwrap_or_else(|| PathBuf::from(".vibex-data"));
    let allow_lan = std::env::var("VIBEX_SERVER_ALLOW_LAN").as_deref() == Ok("1");
    let listen_addr = match std::env::var("VIBEX_SERVER_LISTEN") {
        Ok(value) => match value.parse::<SocketAddr>() {
            Ok(address) => address,
            Err(error) => {
                eprintln!("invalid VIBEX_SERVER_LISTEN: {error}");
                return ExitCode::from(2);
            }
        },
        Err(_) => ServerConfig::default().listen_addr,
    };
    let mut server = match ServerConfig::default().with_listen_addr(listen_addr, allow_lan) {
        Ok(server) => server,
        Err(error) => {
            eprintln!("{error}; set VIBEX_SERVER_ALLOW_LAN=1 to acknowledge LAN exposure");
            return ExitCode::from(2);
        }
    };
    if let Some(static_root) = std::env::var_os("VIBEX_STATIC_ROOT") {
        server = server.with_static_root(PathBuf::from(static_root));
    }
    let supplied_token = std::env::var("VIBEX_SERVER_TOKEN")
        .ok()
        .filter(|token| !token.trim().is_empty())
        .map(ServerToken::new);
    let mut bootstrap = ServerBootstrapConfig::new(data_dir);
    bootstrap.server = server;
    bootstrap.token = supplied_token;

    let mut headless = match HeadlessServer::bootstrap(bootstrap).await {
        Ok(headless) => headless,
        Err(error) => {
            tracing::error!(%error, "failed to initialize vibex-server");
            return ExitCode::from(1);
        }
    };
    if let Some(token) = headless.take_issued_token() {
        println!(
            "VibeX server token (shown once; it cannot be recovered): {}",
            token.expose_once()
        );
    }
    match headless.serve().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!(%error, "vibex-server stopped");
            ExitCode::from(1)
        }
    }
}
