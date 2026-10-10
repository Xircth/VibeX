//! Antigravity ACP sign-in.
//!
//! The server starts the browser OAuth flow itself as soon as `settings.json`
//! names an OAuth method, and keeps `session/new` waiting until the credentials
//! arrive. Signing in from settings therefore means running the server long
//! enough to see that request succeed.

use std::{collections::HashMap, path::Path, time::Duration};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    process::Command,
};
use workspace_utils::process::new_hidden_tokio_command;

pub const LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);

pub async fn run_antigravity_login(
    program: &Path,
    args: &[String],
    env: &HashMap<String, String>,
    cwd: &Path,
    timeout: Duration,
) -> Result<(), String> {
    let mut command: Command = new_hidden_tokio_command(program, args);
    command
        .envs(env)
        .current_dir(cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|err| format!("could not start {} ({err})", program.display()))?;
    let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        return Err("the Antigravity server did not expose its stdio".to_string());
    };
    let cwd = cwd.to_string_lossy().into_owned();
    match tokio::time::timeout(timeout, sign_in(BufReader::new(stdout), stdin, &cwd)).await {
        Ok(result) => result,
        Err(_) => Err(format!(
            "sign-in did not finish within {} seconds",
            timeout.as_secs()
        )),
    }
}

async fn sign_in<R, W>(mut reader: R, mut writer: W, cwd: &str) -> Result<(), String>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    request(
        &mut reader,
        &mut writer,
        1,
        "initialize",
        json!({ "protocolVersion": 1, "clientCapabilities": {} }),
    )
    .await?;
    request(
        &mut reader,
        &mut writer,
        2,
        "session/new",
        json!({ "cwd": cwd, "mcpServers": [] }),
    )
    .await?;
    Ok(())
}

async fn request<R, W>(
    reader: &mut R,
    writer: &mut W,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value, String>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let message = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    writer
        .write_all(format!("{message}\n").as_bytes())
        .await
        .map_err(|err| err.to_string())?;
    writer.flush().await.map_err(|err| err.to_string())?;
    let mut line = String::new();
    loop {
        line.clear();
        let read = reader
            .read_line(&mut line)
            .await
            .map_err(|err| err.to_string())?;
        if read == 0 {
            return Err("the Antigravity server stopped before sign-in finished".to_string());
        }
        let Ok(response) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if response.get("id").and_then(Value::as_u64) != Some(id) {
            continue;
        }
        if let Some(error) = response.get("error") {
            return Err(error_message(error));
        }
        return Ok(response.get("result").cloned().unwrap_or(Value::Null));
    }
}

fn error_message(error: &Value) -> String {
    error
        .pointer("/data/message")
        .or_else(|| error.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("sign-in failed")
        .to_string()
}

#[cfg(test)]
mod tests {
    use tokio::io::{DuplexStream, duplex};

    use super::*;

    async fn serve(stream: DuplexStream, session_new: Value) -> Vec<String> {
        let (read, mut write) = tokio::io::split(stream);
        let mut lines = BufReader::new(read).lines();
        let mut methods = Vec::new();
        while let Some(line) = lines.next_line().await.unwrap() {
            let request: Value = serde_json::from_str(&line).unwrap();
            let method = request["method"].as_str().unwrap().to_string();
            let reply = if method == "session/new" {
                let mut reply = session_new.clone();
                reply["id"] = request["id"].clone();
                reply
            } else {
                json!({ "jsonrpc": "2.0", "id": request["id"], "result": {} })
            };
            methods.push(method);
            write
                .write_all(format!("{reply}\n").as_bytes())
                .await
                .unwrap();
            if methods.len() == 2 {
                break;
            }
        }
        methods
    }

    #[tokio::test]
    async fn sign_in_succeeds_once_the_server_opens_a_session() {
        let (client, server) = duplex(4096);
        let server = tokio::spawn(serve(
            server,
            json!({ "jsonrpc": "2.0", "result": { "sessionId": "s1" } }),
        ));
        let (read, write) = tokio::io::split(client);

        let result = sign_in(BufReader::new(read), write, "/work").await;

        assert_eq!(result, Ok(()));
        assert_eq!(server.await.unwrap(), ["initialize", "session/new"]);
    }

    #[tokio::test]
    async fn sign_in_reports_why_the_server_refused() {
        let (client, server) = duplex(4096);
        tokio::spawn(serve(
            server,
            json!({
                "jsonrpc": "2.0",
                "error": {
                    "code": -32000,
                    "message": "Authentication required",
                    "data": { "message": "gcp.project is required" }
                }
            }),
        ));
        let (read, write) = tokio::io::split(client);

        let result = sign_in(BufReader::new(read), write, "/work").await;

        assert_eq!(result, Err("gcp.project is required".to_string()));
    }

    #[tokio::test]
    async fn sign_in_fails_when_the_server_exits_first() {
        let (client, server) = duplex(4096);
        drop(server);
        let (read, write) = tokio::io::split(client);

        let result = sign_in(BufReader::new(read), write, "/work").await;

        assert!(result.is_err());
    }
}
