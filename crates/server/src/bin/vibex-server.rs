use std::{net::SocketAddr, path::PathBuf, process::ExitCode};

use server::{
    HeadlessServer, LaunchCommand, ParsedArgs, ServerBootstrapConfig, ServerConfig, ServerLaunch,
    ServerToken, parse_args, read_host_token, resolve_console_token, run_agents_command, usage,
    write_host_token,
};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> ExitCode {
    match parse_args(std::env::args().skip(1)) {
        Ok(ParsedArgs::Command(LaunchCommand::Version)) => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Ok(ParsedArgs::Command(LaunchCommand::Help)) => {
            print!("{}", usage());
            ExitCode::SUCCESS
        }
        Ok(ParsedArgs::Agents(command)) => run_agents_command(command).await,
        Ok(ParsedArgs::Start(launch)) => run(launch).await,
        Err(error) => {
            eprintln!("{error}");
            eprint!("{}", usage());
            ExitCode::from(2)
        }
    }
}

async fn run(launch: ServerLaunch) -> ExitCode {
    utils::shell::bootstrap_desktop_path();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .without_time()
        .init();

    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

    let data_dir = utils::assets::host_data_dir();
    let listen_addr = match env_listen_override() {
        Some(address) if !launch.reveal_console => address,
        _ => launch.listen_addr(),
    };
    let mut server = match ServerConfig::default().with_listen_addr(listen_addr, launch.allow_lan) {
        Ok(server) => server,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(2);
        }
    };
    if let Some(static_root) = std::env::var_os("VIBEX_STATIC_ROOT") {
        server = server.with_static_root(PathBuf::from(static_root));
    } else if let Some(sibling) = sibling_web_root() {
        server = server.with_static_root(sibling);
    }
    if let Ok(origins) = std::env::var("VIBEX_SERVER_ALLOWED_ORIGINS") {
        server = server.with_allowed_origins(
            origins
                .split(',')
                .map(str::trim)
                .filter(|origin| !origin.is_empty()),
        );
    }

    let supplied_token = match resolve_startup_token(&data_dir, &launch) {
        Ok(token) => token,
        Err(error) => {
            eprintln!("invalid host token: {error}");
            return ExitCode::from(2);
        }
    };
    if let Some(token) = &supplied_token
        && let Err(error) = write_host_token(&data_dir, token)
    {
        eprintln!("could not save host token: {error}");
        return ExitCode::from(2);
    }

    let mut bootstrap = ServerBootstrapConfig::new(data_dir.clone());
    bootstrap.server = server;
    bootstrap.token = supplied_token.clone();

    let mut headless = match HeadlessServer::bootstrap(bootstrap).await {
        Ok(headless) => headless,
        Err(error) => {
            tracing::error!(%error, "failed to initialize vibex-server");
            return ExitCode::from(1);
        }
    };
    if let Some(token) = headless.take_issued_token() {
        if let Err(error) = write_host_token(&data_dir, &token) {
            eprintln!("could not save host token: {error}");
            return ExitCode::from(2);
        }
        if !launch.reveal_console {
            println!(
                "VibeX server token (saved for `serve`; keep it secret): {}",
                token.expose_once()
            );
        }
    }
    if launch.reveal_console {
        let saved = read_host_token(&data_dir);
        let token = supplied_token
            .as_ref()
            .or(saved.as_ref())
            .map(ServerToken::as_str)
            .unwrap_or("");
        print_console(&launch, token);
    }
    match headless.serve().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!(%error, "vibex-server stopped");
            ExitCode::from(1)
        }
    }
}

fn resolve_startup_token(
    data_dir: &std::path::Path,
    launch: &ServerLaunch,
) -> Result<Option<ServerToken>, server::ServerTokenError> {
    if let Some(value) = std::env::var("VIBEX_SERVER_TOKEN")
        .ok()
        .filter(|token| !token.trim().is_empty())
    {
        return ServerToken::try_new(value).map(Some);
    }
    if launch.reveal_console || launch.rotate_token {
        let token = resolve_console_token(data_dir, launch.rotate_token);
        return Ok(Some(token));
    }
    Ok(read_host_token(data_dir))
}

fn env_listen_override() -> Option<SocketAddr> {
    std::env::var("VIBEX_SERVER_LISTEN").ok()?.parse().ok()
}

fn print_console(launch: &ServerLaunch, token: &str) {
    let origins = utils::net::advertised_http_origins(launch.port, launch.allow_lan);
    println!("VibeX Host {}", env!("CARGO_PKG_VERSION"));
    for origin in origins {
        println!("  {origin}");
    }
    if !token.is_empty() {
        println!("Token");
        println!("  {token}");
    }
}

fn sibling_web_root() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let directory = executable.parent()?;
    let web = directory.join("web");
    web.join("index.html").is_file().then_some(web)
}
