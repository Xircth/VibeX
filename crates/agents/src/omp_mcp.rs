//! OMP ACP ignores disk MCP discovery. Settings still persist assignments in
//! `~/.omp/agent/mcp.json`; this module turns that file into the `session/new`
//! servers the running ACP process actually accepts.

use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};

use agent_client_protocol::schema::v1::{
    EnvVariable, HttpHeader, McpServer, McpServerHttp, McpServerSse, McpServerStdio,
};
use serde_json::Value;

use crate::omp_auth::agent_dir;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SessionMcpOffer {
    pub stdio: bool,
    pub http: bool,
    pub sse: bool,
}

pub(crate) fn mcp_json_path(home: &Path, environment: &BTreeMap<String, String>) -> PathBuf {
    agent_dir(home, environment).join("mcp.json")
}

pub(crate) fn session_servers(path: &Path) -> Vec<McpServer> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(root) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    let Some(servers) = root.get("mcpServers").and_then(Value::as_object) else {
        return Vec::new();
    };
    servers
        .iter()
        .filter_map(|(name, spec)| to_session_server(name, spec))
        .collect()
}

pub(crate) fn merge_session_servers(
    mut existing: Vec<McpServer>,
    assigned: Vec<McpServer>,
    offer: SessionMcpOffer,
) -> Vec<McpServer> {
    let mut names = existing
        .iter()
        .map(|server| server_name(server).to_string())
        .collect::<BTreeSet<_>>();
    for server in assigned {
        if !offer.allows(&server) {
            continue;
        }
        let name = server_name(&server);
        if name.is_empty() || !names.insert(name.to_string()) {
            continue;
        }
        existing.push(server);
    }
    existing
}

impl SessionMcpOffer {
    fn allows(self, server: &McpServer) -> bool {
        match server {
            McpServer::Http(_) => self.http,
            McpServer::Sse(_) => self.sse,
            McpServer::Stdio(_) => self.stdio,
            #[allow(unreachable_patterns)]
            _ => false,
        }
    }
}

fn to_session_server(name: &str, spec: &Value) -> Option<McpServer> {
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    let object = spec.as_object()?;
    if object.get("enabled").and_then(Value::as_bool) == Some(false) {
        return None;
    }
    let raw_type = object
        .get("type")
        .or_else(|| object.get("transport"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let kind = match raw_type {
        "" if object.contains_key("command") => "stdio",
        "" if object.contains_key("url") => "http",
        "stdio" | "local" => "stdio",
        "http" | "streamable-http" | "streamable_http" => "http",
        "sse" => "sse",
        _ => return None,
    };
    match kind {
        "stdio" => {
            let command = object.get("command").and_then(Value::as_str)?.trim();
            if command.is_empty() || !stdio_command_is_launchable(command) {
                if !command.is_empty() {
                    tracing::warn!(
                        server = name,
                        command,
                        "skipping OMP MCP server whose command is not on disk"
                    );
                }
                return None;
            }
            let args = object
                .get("args")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .collect();
            Some(McpServer::Stdio(
                McpServerStdio::new(name, command)
                    .args(args)
                    .env(name_values(object.get("env"))),
            ))
        }
        "http" => {
            let url = object.get("url").and_then(Value::as_str)?.trim();
            if url.is_empty() {
                return None;
            }
            Some(McpServer::Http(
                McpServerHttp::new(name, url).headers(headers(object.get("headers"))),
            ))
        }
        "sse" => {
            let url = object.get("url").and_then(Value::as_str)?.trim();
            if url.is_empty() {
                return None;
            }
            Some(McpServer::Sse(
                McpServerSse::new(name, url).headers(headers(object.get("headers"))),
            ))
        }
        _ => None,
    }
}

fn stdio_command_is_launchable(command: &str) -> bool {
    let path = Path::new(command);
    if path.is_absolute() || command.contains(['\\', '/']) {
        path.is_file()
    } else {
        true
    }
}

fn name_values(value: Option<&Value>) -> Vec<EnvVariable> {
    string_map(value)
        .into_iter()
        .map(|(name, value)| EnvVariable::new(name, value))
        .collect()
}

fn headers(value: Option<&Value>) -> Vec<HttpHeader> {
    string_map(value)
        .into_iter()
        .map(|(name, value)| HttpHeader::new(name, value))
        .collect()
}

fn string_map(value: Option<&Value>) -> BTreeMap<String, String> {
    let Some(value) = value else {
        return BTreeMap::new();
    };
    if let Some(object) = value.as_object() {
        return object
            .iter()
            .filter_map(|(key, value)| {
                let key = key.trim();
                let value = value.as_str()?.trim();
                if key.is_empty() {
                    None
                } else {
                    Some((key.to_string(), value.to_string()))
                }
            })
            .collect();
    }
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let object = entry.as_object()?;
            let name = object.get("name").and_then(Value::as_str)?.trim();
            let value = object.get("value").and_then(Value::as_str)?.trim();
            if name.is_empty() {
                None
            } else {
                Some((name.to_string(), value.to_string()))
            }
        })
        .collect()
}

fn server_name(server: &McpServer) -> &str {
    match server {
        McpServer::Http(server) => &server.name,
        McpServer::Sse(server) => &server.name,
        McpServer::Stdio(server) => &server.name,
        #[allow(unreachable_patterns)]
        _ => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_json_path_ignores_pi_agent_dir() {
        let home = Path::new("/tmp/vibex-home");
        let pi = home.join(".pi").join("agent");
        let env = BTreeMap::from([(
            "PI_CODING_AGENT_DIR".to_string(),
            pi.to_string_lossy().into_owned(),
        )]);
        assert_eq!(
            mcp_json_path(home, &env),
            home.join(".omp").join("agent").join("mcp.json")
        );
    }

    #[test]
    fn session_servers_keep_enabled_stdio_http_and_sse() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("mcp.json");
        std::fs::write(
            &path,
            r#"{
              "mcpServers": {
                "local": {
                  "command": "npx",
                  "args": ["-y", "pkg"],
                  "env": {"TOKEN": "secret"}
                },
                "remote": {"type": "http", "url": "https://x/mcp", "headers": {"Authorization": "Bearer t"}},
                "events": {"type": "sse", "url": "https://x/sse"},
                "off": {"command": "skip", "enabled": false},
                "broken": {"type": "stdio"}
              }
            }"#,
        )
        .unwrap();

        let servers = session_servers(&path);
        assert_eq!(servers.len(), 3);
        match &servers[0] {
            McpServer::Stdio(server) => {
                assert_eq!(server.name, "local");
                assert_eq!(server.command, PathBuf::from("npx"));
                assert_eq!(server.args, ["-y", "pkg"]);
                assert_eq!(server.env[0].name, "TOKEN");
                assert_eq!(server.env[0].value, "secret");
            }
            other => panic!("expected stdio, got {other:?}"),
        }
        match &servers[1] {
            McpServer::Http(server) => {
                assert_eq!(server.url, "https://x/mcp");
                assert_eq!(server.headers[0].name, "Authorization");
            }
            other => panic!("expected http, got {other:?}"),
        }
        assert!(matches!(&servers[2], McpServer::Sse(_)));
    }

    #[test]
    fn session_servers_skip_missing_absolute_commands() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("mcp.json");
        let missing = temp.path().join("missing").join("node_repl.exe");
        let spec = serde_json::json!({
            "mcpServers": {
                "node_repl": { "command": missing },
                "local": { "command": "npx" }
            }
        });
        std::fs::write(&path, spec.to_string()).unwrap();

        let servers = session_servers(&path);
        assert_eq!(servers.len(), 1);
        assert!(matches!(&servers[0], McpServer::Stdio(server) if server.name == "local"));
    }

    #[test]
    fn merge_skips_duplicates_and_unoffered_transports() {
        let existing = vec![McpServer::Http(McpServerHttp::new(
            "remote",
            "https://already",
        ))];
        let assigned = vec![
            McpServer::Http(McpServerHttp::new("remote", "https://file")),
            McpServer::Sse(McpServerSse::new("events", "https://x/sse")),
            McpServer::Stdio(McpServerStdio::new("local", "npx")),
        ];
        let merged = merge_session_servers(
            existing,
            assigned,
            SessionMcpOffer {
                stdio: true,
                http: true,
                sse: false,
            },
        );
        assert_eq!(merged.len(), 2);
        assert!(matches!(&merged[1], McpServer::Stdio(server) if server.name == "local"));
    }
}
