//! Thin client for the companion → broker socket. Connects per call, frames one
//! [`BrokerMessage`], and reads one [`BrokerResponse`] back.

use delegation_proto::{BrokerMessage, BrokerResponse, read_frame, write_frame};

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
                if err.raw_os_error() == Some(ERROR_PIPE_BUSY)
                    && std::time::Instant::now() < deadline =>
            {
                tokio::time::sleep(RETRY_DELAY).await;
            }
            Err(err) => return Err(err),
        }
    }
}
