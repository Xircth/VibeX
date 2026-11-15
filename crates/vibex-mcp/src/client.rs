//! Thin client for the companion → broker socket. Connects per call, frames one
//! [`BrokerMessage`], and reads one [`BrokerResponse`] back.

use std::time::Duration;

use delegation_proto::{BrokerMessage, BrokerResponse, read_frame, write_frame};

/// Workspace reqwest is rustls `no-provider`. Sidecar processes must install a
/// crypto provider before any TLS client is built, same as the Host binary.
pub fn install_rustls_crypto_provider() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
}

fn http_client() -> std::io::Result<reqwest::Client> {
    install_rustls_crypto_provider();
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(2))
        .no_proxy()
        .build()
        .map_err(|error| std::io::Error::other(error.to_string()))
}

/// POST one broker message to the Host HTTP companion endpoint.
pub async fn call_http(
    server_url: &str,
    server_token: Option<&str>,
    conversation_id: Option<&str>,
    product: &str,
    message: &BrokerMessage,
) -> std::io::Result<BrokerResponse> {
    let url = format!("{}/internal/companion", server_url.trim_end_matches('/'));
    let mut request = http_client()?.post(url).json(message);
    if let Some(token) = server_token {
        request = request.bearer_auth(token);
    }
    if let Some(conversation_id) = conversation_id {
        request = request.header("x-vibex-conversation-id", conversation_id);
    }
    request = request.header("x-vibex-product", product);
    let response = request
        .send()
        .await
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    if !response.status().is_success() {
        return Err(std::io::Error::other(format!(
            "companion http {}",
            response.status()
        )));
    }
    response
        .json()
        .await
        .map_err(|error| std::io::Error::other(error.to_string()))
}

/// Optional Host HTTP `/api/v1/call/<command>` bridge for Pulse tools when
/// connected to a live Host server.
pub async fn call_host_v1_command(
    server_url: &str,
    server_token: Option<&str>,
    conversation_id: Option<&str>,
    command: &str,
    operation_id: &str,
    args: &serde_json::Value,
) -> std::io::Result<serde_json::Value> {
    let url = format!(
        "{}/api/v1/call/{}",
        server_url.trim_end_matches('/'),
        command
    );
    let mut request = http_client()?.post(url).json(&serde_json::json!({
        "operation_id": operation_id,
        "args": args,
    }));
    if let Some(token) = server_token {
        request = request.bearer_auth(token);
    }
    if let Some(conversation_id) = conversation_id {
        request = request.header("x-vibex-conversation-id", conversation_id);
    }
    request = request.header("x-vibex-protocol-version", "1.0");
    let response = request
        .send()
        .await
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    if !response.status().is_success() {
        return Err(std::io::Error::other(format!(
            "pulse host http {}",
            response.status()
        )));
    }
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    Ok(body.get("data").cloned().unwrap_or(body))
}

/// Connect to the broker socket, send `message`, and return its response.
pub async fn call_broker(
    socket_path: &str,
    message: &BrokerMessage,
) -> std::io::Result<BrokerResponse> {
    #[cfg(unix)]
    {
        let mut stream = tokio::net::UnixStream::connect(socket_path).await?;
        write_frame(&mut stream, message).await?;
        read_frame(&mut stream).await
    }

    #[cfg(windows)]
    {
        let mut stream = open_pipe(socket_path).await?;
        write_frame(&mut stream, message).await?;
        read_frame(&mut stream).await
    }
}

/// Open a Windows named pipe, retrying briefly while the server is rebinding the
/// next instance (`ERROR_PIPE_BUSY`).
#[cfg(windows)]
async fn open_pipe(
    socket_path: &str,
) -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeClient> {
    use tokio::net::windows::named_pipe::ClientOptions;

    const ERROR_PIPE_BUSY: i32 = 231;
    const RETRY_BUDGET: std::time::Duration = std::time::Duration::from_millis(200);
    const RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(10);

    let deadline = std::time::Instant::now() + RETRY_BUDGET;
    loop {
        match ClientOptions::new().open(socket_path) {
            Ok(client) => return Ok(client),
            Err(err)
                if (err.raw_os_error() == Some(ERROR_PIPE_BUSY)
                    || err.kind() == std::io::ErrorKind::NotFound)
                    && std::time::Instant::now() < deadline =>
            {
                tokio::time::sleep(RETRY_DELAY).await;
            }
            Err(err) => return Err(err),
        }
    }
}
