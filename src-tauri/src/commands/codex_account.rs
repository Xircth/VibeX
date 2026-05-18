use std::{
    env,
    path::{Path, PathBuf},
};

use serde_json::{Value, json};
use tauri::command;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{ChildStdout, Command},
    time::{Duration, timeout},
};

const CODEX_APP_SERVER_TIMEOUT_SECS: u64 = 20;

fn existing_file(path: impl Into<PathBuf>) -> Option<PathBuf> {
    let path = path.into();
    path.is_file().then_some(path)
}

fn npm_codex_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(app_data) = env::var_os("APPDATA") {
        let npm_dir = PathBuf::from(app_data).join("npm");
        candidates.push(npm_dir.join("codex.cmd"));
        candidates.push(npm_dir.join("codex.exe"));
        candidates.push(npm_dir.join("codex"));
    }

    if let Some(profile) = env::var_os("USERPROFILE") {
        let npm_dir = PathBuf::from(profile)
            .join("AppData")
            .join("Roaming")
            .join("npm");
        candidates.push(npm_dir.join("codex.cmd"));
        candidates.push(npm_dir.join("codex.exe"));
        candidates.push(npm_dir.join("codex"));
    }

    candidates
}

fn resolve_codex_command_path() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("CODEX_BIN").and_then(existing_file) {
        return Ok(path);
    }

    for name in ["codex.exe", "codex.cmd", "codex"] {
        if let Ok(path) = which::which(name) {
            return Ok(path);
        }
    }

    for candidate in npm_codex_candidates() {
        if let Some(path) = existing_file(candidate) {
            return Ok(path);
        }
    }

    Err("Codex CLI was not found. Set CODEX_BIN to the full codex executable path, or ensure the npm global bin directory is available to the desktop app.".to_string())
}

fn command_for_codex_app_server(codex_path: &Path) -> Command {
    utils::process::new_hidden_tokio_command(codex_path, ["app-server"])
}

async fn write_app_server_message(
    stdin: &mut tokio::process::ChildStdin,
    value: Value,
) -> Result<(), String> {
    let mut line = serde_json::to_string(&value).map_err(|error| error.to_string())?;
    line.push('\n');
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|error| error.to_string())
}

fn response_error_message(value: &Value) -> Option<String> {
    let error = value.get("error")?;
    if let Some(message) = error.as_str() {
        return Some(message.to_string());
    }
    if let Some(message) = error.get("message").and_then(Value::as_str) {
        return Some(message.to_string());
    }
    Some(error.to_string())
}

async fn read_app_server_response(
    lines: &mut Lines<BufReader<ChildStdout>>,
    target_id: u64,
) -> Result<Value, String> {
    loop {
        let line = lines
            .next_line()
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "Codex app-server closed before responding.".to_string())?;

        if line.trim().is_empty() {
            continue;
        }

        let value: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };

        if value.get("id").and_then(Value::as_u64) != Some(target_id) {
            continue;
        }

        if let Some(message) = response_error_message(&value) {
            return Err(message);
        }

        return Ok(value.get("result").cloned().unwrap_or(value));
    }
}

#[command]
pub async fn get_codex_account_rate_limits() -> Result<Value, String> {
    let codex_path = resolve_codex_command_path()?;
    let mut child = command_for_codex_app_server(&codex_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| {
            format!(
                "Failed to start Codex app-server from {}: {error}",
                codex_path.display()
            )
        })?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Codex app-server stdin is unavailable.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Codex app-server stdout is unavailable.".to_string())?;
    let stderr = child.stderr.take();

    if let Some(stderr) = stderr {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while matches!(lines.next_line().await, Ok(Some(_))) {}
        });
    }

    let mut stdout_lines = BufReader::new(stdout).lines();
    let init_params = json!({
        "clientInfo": {
            "name": "vibex",
            "title": "VibeX",
            "version": env!("CARGO_PKG_VERSION")
        },
        "capabilities": {
            "experimentalApi": true
        }
    });

    let result = timeout(Duration::from_secs(CODEX_APP_SERVER_TIMEOUT_SECS), async {
        write_app_server_message(
            &mut stdin,
            json!({ "id": 1, "method": "initialize", "params": init_params }),
        )
        .await?;
        read_app_server_response(&mut stdout_lines, 1).await?;

        write_app_server_message(&mut stdin, json!({ "method": "initialized" })).await?;
        write_app_server_message(
            &mut stdin,
            json!({ "id": 2, "method": "account/rateLimits/read", "params": null }),
        )
        .await?;
        read_app_server_response(&mut stdout_lines, 2).await
    })
    .await
    .map_err(|_| "Timed out while reading Codex account rate limits.".to_string());

    let _ = child.kill().await;
    result?
}
