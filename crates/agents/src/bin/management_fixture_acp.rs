//! Deterministic line-delimited JSON-RPC ACP process for integration tests.
//!
//! Environment switches deliberately cover protocol failure modes that typed
//! happy-path mocks tend to erase:
//! - `VIBEX_FIXTURE_AUTH_STATUS=true|false|unsupported|method-not-found|malformed|timeout`
//! - `VIBEX_FIXTURE_SESSION_AUTH_REQUIRED=1`
//! - `VIBEX_FIXTURE_ADDITIONAL_DIRECTORIES=advertised|absent`
//! - `VIBEX_FIXTURE_MCP_HTTP=advertised|absent`

use std::{sync::Arc, time::Duration};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::Mutex,
};

type FixtureStdout = Arc<Mutex<tokio::io::Stdout>>;

async fn respond(stdout: &FixtureStdout, response: Value) -> std::io::Result<()> {
    let mut stdout = stdout.lock().await;
    stdout.write_all(response.to_string().as_bytes()).await?;
    stdout.write_all(b"\n").await?;
    stdout.flush().await
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let stdout = Arc::new(Mutex::new(tokio::io::stdout()));
    let auth_mode =
        std::env::var("VIBEX_FIXTURE_AUTH_STATUS").unwrap_or_else(|_| "unsupported".into());
    let session_discovery = std::env::var_os("VIBEX_FIXTURE_SESSION_DISCOVERY").is_some();
    let additional_directories_mode = std::env::var("VIBEX_FIXTURE_ADDITIONAL_DIRECTORIES").ok();
    let mcp_http_mode = std::env::var("VIBEX_FIXTURE_MCP_HTTP").ok();

    while let Some(line) = lines.next_line().await? {
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(id) = message.get("id").cloned() else {
            continue;
        };
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let response = match method {
            "initialize" => {
                let protocol_version = message
                    .pointer("/params/protocolVersion")
                    .cloned()
                    .unwrap_or_else(|| json!(1));
                let mut agent_capabilities = if auth_mode == "unsupported" {
                    json!({})
                } else {
                    json!({"auth": {"status": true}})
                };
                if session_discovery {
                    agent_capabilities["sessionCapabilities"] = json!({"list": {}, "delete": {}});
                }
                if additional_directories_mode.as_deref() == Some("advertised") {
                    agent_capabilities["sessionCapabilities"]["additionalDirectories"] = json!({});
                }
                if mcp_http_mode.as_deref() == Some("advertised") {
                    agent_capabilities["mcpCapabilities"] = json!({"http": true});
                }
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "protocolVersion": protocol_version,
                        "agentCapabilities": agent_capabilities,
                        "authMethods": [],
                        "agentInfo": {
                            "name": "vibex-management-fixture",
                            "version": "1.0.0-test"
                        }
                    }
                })
            }
            "auth/status" if auth_mode == "timeout" => {
                let delayed_stdout = Arc::clone(&stdout);
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    let _ = respond(
                        &delayed_stdout,
                        json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": {"authenticated": true}
                        }),
                    )
                    .await;
                });
                continue;
            }
            "auth/status" if auth_mode == "method-not-found" => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {"code": -32601, "message": "Method not found"}
            }),
            "auth/status" if auth_mode == "malformed" => json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {"unexpected": true}
            }),
            "auth/status" => json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {"authenticated": auth_mode == "true"}
            }),
            "session/new" if std::env::var_os("VIBEX_FIXTURE_SESSION_AUTH_REQUIRED").is_some() => {
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {"code": -32000, "message": "Authentication required"}
                })
            }
            "session/new"
                if additional_directories_mode.as_deref() == Some("advertised")
                    && message.pointer("/params/additionalDirectories")
                        != Some(&json!(["/fixture/linked-repo"])) =>
            {
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {"code": -32602, "message": "exact additionalDirectories missing"}
                })
            }
            "session/new"
                if additional_directories_mode.as_deref() == Some("absent")
                    && message.pointer("/params/additionalDirectories").is_some() =>
            {
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {"code": -32602, "message": "unadvertised additionalDirectories sent"}
                })
            }
            "session/new"
                if mcp_http_mode.as_deref() == Some("advertised")
                    && !message
                        .pointer("/params/mcpServers")
                        .and_then(Value::as_array)
                        .is_some_and(|servers| {
                            servers.iter().any(|server| {
                                server.get("type") == Some(&json!("http"))
                                    && server.get("name") == Some(&json!("fixture-http"))
                                    && server.get("url") == Some(&json!("https://mcp.example.test"))
                            })
                        }) =>
            {
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {"code": -32602, "message": "advertised HTTP MCP missing"}
                })
            }
            "session/new"
                if mcp_http_mode.as_deref() == Some("absent")
                    && message
                        .pointer("/params/mcpServers")
                        .and_then(Value::as_array)
                        .is_some_and(|servers| {
                            servers
                                .iter()
                                .any(|server| server.get("type") == Some(&json!("http")))
                        }) =>
            {
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {"code": -32602, "message": "unadvertised HTTP MCP sent"}
                })
            }
            "session/new" => json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {"sessionId": "fixture-session"}
            }),
            "session/close" => json!({"jsonrpc": "2.0", "id": id, "result": {}}),
            "session/list" if session_discovery => json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "sessions": [{
                        "sessionId": "fixture-listed-session",
                        "cwd": "/fixture/workspace",
                        "additionalDirectories": ["/fixture/shared"],
                        "title": "Fixture session",
                        "updatedAt": "2026-07-30T00:00:00Z",
                        "_meta": {"source": "fixture"}
                    }],
                    "_meta": {"page": 1}
                }
            }),
            "session/delete" if session_discovery => {
                json!({"jsonrpc": "2.0", "id": id, "result": {}})
            }
            _ => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {"code": -32601, "message": "Method not found"}
            }),
        };
        respond(&stdout, response).await?;
    }

    Ok(())
}
