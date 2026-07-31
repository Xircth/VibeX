//! MCP marketplace + global hosting + per-agent sync.
//!
//! Adapted from the reference project (codeg) but trimmed to a single
//! marketplace provider (Smithery) and extended with a "global" hosting
//! concept: the global registry lives at `~/.vibex/mcp.json` and, on install,
//! every entry is mirrored into each agent's own native MCP config file
//! (Claude `~/.claude.json`, Codex `~/.codex/config.toml`, Hermes
//! `~/.hermes/config.yaml`, …).
//!
//! All server specs are stored in a single canonical JSON shape
//! (`{type: "stdio"|"http"|"sse", …}`); per-agent writers translate that to
//! each agent's native format (TOML for Codex, YAML for Hermes, the
//! `local`/`remote` variant for OpenCode).

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::LazyLock,
    time::Duration,
};

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Map, Value, json};

mod error;
pub use error::McpError;

const MARKETPLACE_SMITHERY: &str = "smithery";

/// The marketplace suffix Claude Code uses when toggling user-scope MCP
/// servers via `enabledPlugins` ("local" marks user-managed entries).
const CLAUDE_LOCAL_PLUGIN_MARKETPLACE: &str = "local";

static MARKETPLACE_HTTP_CLIENT: LazyLock<Result<reqwest::Client, String>> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20))
        .user_agent("vibex-mcp-market/1.0")
        .build()
        .map_err(|e| format!("failed to initialize marketplace HTTP client: {e}"))
});

fn bad(message: impl Into<String>) -> McpError {
    McpError::BadRequest(message.into())
}

fn not_found(message: impl Into<String>) -> McpError {
    McpError::NotFound(message.into())
}

fn internal(message: impl Into<String>) -> McpError {
    McpError::Internal(message.into())
}

// ---------------------------------------------------------------------------
// Public data model (serialized to the frontend)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpAppType {
    ClaudeCode,
    Codex,
    Gemini,
    OpenClaw,
    OpenCode,
    Cline,
    Hermes,
}

const ALL_APPS: [McpAppType; 7] = [
    McpAppType::ClaudeCode,
    McpAppType::Codex,
    McpAppType::Gemini,
    McpAppType::OpenClaw,
    McpAppType::OpenCode,
    McpAppType::Cline,
    McpAppType::Hermes,
];

#[derive(Debug, Clone, Serialize)]
pub struct LocalMcpServer {
    pub id: String,
    pub spec: Value,
    /// Whether this server is recorded in the global registry
    /// (`~/.vibex/mcp.json`).
    pub global: bool,
    /// Which agent config files currently carry this server.
    pub apps: Vec<McpAppType>,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpMarketplaceProvider {
    pub id: String,
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpMarketplaceItem {
    pub provider_id: String,
    pub server_id: String,
    pub name: String,
    pub description: String,
    pub homepage: Option<String>,
    pub remote: bool,
    pub verified: bool,
    pub icon_url: Option<String>,
    pub latest_version: Option<String>,
    pub protocols: Vec<String>,
    pub owner: Option<String>,
    pub namespace: Option<String>,
    pub downloads: Option<u64>,
    pub score: Option<f64>,
    pub is_deployed: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpMarketplaceInstallParameter {
    pub key: String,
    pub label: String,
    pub description: Option<String>,
    pub required: bool,
    pub secret: bool,
    pub kind: String,
    pub default_value: Option<Value>,
    pub placeholder: Option<String>,
    pub enum_values: Vec<String>,
    pub location: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpMarketplaceInstallOption {
    pub id: String,
    pub protocol: String,
    pub label: String,
    pub description: Option<String>,
    pub spec: Value,
    pub parameters: Vec<McpMarketplaceInstallParameter>,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpMarketplaceServerDetail {
    pub provider_id: String,
    pub server_id: String,
    pub name: String,
    pub description: String,
    pub homepage: Option<String>,
    pub remote: bool,
    pub verified: bool,
    pub icon_url: Option<String>,
    pub latest_version: Option<String>,
    pub protocols: Vec<String>,
    pub owner: Option<String>,
    pub namespace: Option<String>,
    pub downloads: Option<u64>,
    pub score: Option<f64>,
    pub is_deployed: Option<bool>,
    pub default_option_id: Option<String>,
    pub install_options: Vec<McpMarketplaceInstallOption>,
    pub spec: Value,
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

fn marketplace_http_client() -> Result<reqwest::Client, McpError> {
    match &*MARKETPLACE_HTTP_CLIENT {
        Ok(client) => Ok(client.clone()),
        Err(err) => Err(internal(err.clone())),
    }
}

fn should_retry_http_status(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}

async fn send_request_with_retry<F>(
    context: &str,
    mut build: F,
) -> Result<reqwest::Response, McpError>
where
    F: FnMut() -> reqwest::RequestBuilder,
{
    const MAX_ATTEMPTS: usize = 3;
    let mut last_error: Option<String> = None;

    for attempt in 1..=MAX_ATTEMPTS {
        match build().send().await {
            Ok(response) => {
                if should_retry_http_status(response.status()) && attempt < MAX_ATTEMPTS {
                    tokio::time::sleep(Duration::from_millis((attempt as u64) * 350)).await;
                    continue;
                }
                return Ok(response);
            }
            Err(err) => {
                last_error = Some(format!("{context}: {err}"));
                if attempt < MAX_ATTEMPTS {
                    tokio::time::sleep(Duration::from_millis((attempt as u64) * 350)).await;
                }
            }
        }
    }

    Err(internal(
        last_error.unwrap_or_else(|| format!("{context}: request failed")),
    ))
}

async fn parse_json_response<T: DeserializeOwned>(
    response: reqwest::Response,
    context: &str,
) -> Result<T, McpError> {
    let raw = response
        .text()
        .await
        .map_err(|e| internal(format!("{context}: failed to read response body: {e}")))?;
    serde_json::from_str::<T>(&raw)
        .map_err(|e| internal(format!("{context}: invalid JSON response: {e}")))
}

// ---------------------------------------------------------------------------
// Smithery API response shapes
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct SmitheryServerListResponse {
    #[serde(default)]
    servers: Vec<SmitheryServerSummary>,
}

#[derive(Debug, Deserialize)]
struct SmitheryServerSummary {
    #[serde(rename = "qualifiedName")]
    qualified_name: String,
    #[serde(rename = "displayName")]
    display_name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    homepage: Option<String>,
    #[serde(default, rename = "iconUrl")]
    icon_url: Option<String>,
    #[serde(default)]
    namespace: Option<String>,
    #[serde(default)]
    owner: Option<String>,
    #[serde(default)]
    remote: bool,
    #[serde(default)]
    verified: bool,
    #[serde(default, rename = "useCount")]
    use_count: Option<u64>,
    #[serde(default)]
    score: Option<f64>,
    #[serde(default, rename = "isDeployed")]
    is_deployed: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct SmitheryServerDetail {
    #[serde(rename = "qualifiedName")]
    qualified_name: String,
    #[serde(rename = "displayName")]
    display_name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    homepage: Option<String>,
    #[serde(default, rename = "iconUrl")]
    icon_url: Option<String>,
    #[serde(default)]
    namespace: Option<String>,
    #[serde(default)]
    owner: Option<String>,
    #[serde(default, rename = "deploymentUrl")]
    deployment_url: Option<String>,
    #[serde(default)]
    remote: bool,
    #[serde(default)]
    verified: bool,
    #[serde(default, rename = "useCount")]
    use_count: Option<u64>,
    #[serde(default)]
    score: Option<f64>,
    #[serde(default, rename = "isDeployed")]
    is_deployed: Option<bool>,
    #[serde(default)]
    connections: Vec<SmitheryConnection>,
}

#[derive(Debug, Deserialize)]
struct SmitheryConnection {
    #[serde(default)]
    r#type: String,
    #[serde(default, rename = "deploymentUrl")]
    deployment_url: Option<String>,
    #[serde(default, rename = "configSchema")]
    config_schema: Option<Value>,
}

// ---------------------------------------------------------------------------
// Protocol normalization
// ---------------------------------------------------------------------------

fn normalize_mcp_type(raw: &str) -> Option<&'static str> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let lower = trimmed.to_ascii_lowercase();
    match lower.as_str() {
        "stdio" => return Some("stdio"),
        "http" => return Some("http"),
        "sse" => return Some("sse"),
        "local" => return Some("local"),
        "remote" => return Some("remote"),
        _ => {}
    }

    let collapsed: String = lower
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    if collapsed == "streamablehttp" {
        return Some("http");
    }

    None
}

fn normalize_protocol_value(raw: &str) -> String {
    normalize_mcp_type(raw)
        .map(str::to_string)
        .unwrap_or_else(|| raw.trim().to_string())
}

fn protocol_priority(protocol: &str) -> i32 {
    match normalize_protocol_value(protocol).as_str() {
        "stdio" => 0,
        "http" => 1,
        "sse" => 2,
        _ => 10,
    }
}

fn select_default_install_option(
    options: &[McpMarketplaceInstallOption],
) -> Option<&McpMarketplaceInstallOption> {
    options
        .iter()
        .min_by_key(|item| protocol_priority(&item.protocol))
}

fn select_install_option<'a>(
    options: &'a [McpMarketplaceInstallOption],
    option_id: &Option<String>,
) -> Option<&'a McpMarketplaceInstallOption> {
    if let Some(id) = option_id
        && let Some(found) = options.iter().find(|item| &item.id == id)
    {
        return Some(found);
    }
    select_default_install_option(options)
}

fn collect_protocols_from_options(options: &[McpMarketplaceInstallOption]) -> Vec<String> {
    let mut seen = BTreeSet::new();
    for option in options {
        seen.insert(normalize_protocol_value(&option.protocol));
    }
    seen.into_iter().collect()
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

fn home_dir_or_default() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn codex_home_dir() -> PathBuf {
    let configured = std::env::var("CODEX_HOME").ok().and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });

    match configured {
        Some(value) => {
            if value == "~" {
                home_dir_or_default()
            } else if let Some(remain) = value.strip_prefix("~/") {
                home_dir_or_default().join(remain)
            } else {
                PathBuf::from(value)
            }
        }
        None => home_dir_or_default().join(".codex"),
    }
}

fn claude_config_path() -> PathBuf {
    home_dir_or_default().join(".claude.json")
}

fn claude_settings_path() -> PathBuf {
    home_dir_or_default().join(".claude").join("settings.json")
}

fn claude_local_plugin_key(id: &str) -> String {
    format!("{id}@{CLAUDE_LOCAL_PLUGIN_MARKETPLACE}")
}

fn codex_config_toml_path() -> PathBuf {
    codex_home_dir().join("config.toml")
}

fn opencode_config_path() -> PathBuf {
    home_dir_or_default()
        .join(".config")
        .join("opencode")
        .join("opencode.json")
}

fn gemini_config_path() -> PathBuf {
    home_dir_or_default().join(".gemini").join("settings.json")
}

fn openclaw_config_path() -> PathBuf {
    home_dir_or_default()
        .join(".openclaw")
        .join("openclaw.json")
}

fn cline_config_path() -> PathBuf {
    home_dir_or_default()
        .join(".cline")
        .join("data")
        .join("settings")
        .join("cline_mcp_settings.json")
}

fn hermes_home_dir() -> PathBuf {
    std::env::var_os("HERMES_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir_or_default().join(".hermes"))
}

fn hermes_config_yaml_path() -> PathBuf {
    hermes_home_dir().join("config.yaml")
}

/// Global MCP registry hosted by VibeX at `~/.vibex/mcp.json`.
fn global_store_path() -> PathBuf {
    home_dir_or_default().join(".vibex").join("mcp.json")
}

// ---------------------------------------------------------------------------
// File IO helpers
// ---------------------------------------------------------------------------

fn read_json_file(path: &Path) -> Result<Value, McpError> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let raw = fs::read_to_string(path).map_err(|e| internal(e.to_string()))?;
    if raw.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str::<Value>(&raw)
        .map_err(|e| bad(format!("invalid JSON at {}: {e}", path.display())))
}

fn write_json_file(path: &Path, value: &Value) -> Result<(), McpError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| internal(e.to_string()))?;
    }
    let serialized = serde_json::to_string_pretty(value).map_err(|e| {
        bad(format!(
            "failed to serialize JSON for {}: {e}",
            path.display()
        ))
    })?;
    fs::write(path, format!("{serialized}\n")).map_err(|e| internal(e.to_string()))
}

fn read_codex_root_toml() -> Result<toml::Value, McpError> {
    let path = codex_config_toml_path();
    if !path.exists() {
        return Ok(toml::Value::Table(toml::map::Map::new()));
    }
    let raw = fs::read_to_string(&path).map_err(|e| internal(e.to_string()))?;
    let parsed = raw
        .parse::<toml::Value>()
        .map_err(|e| bad(format!("invalid TOML at {}: {e}", path.display())))?;
    if !parsed.is_table() {
        return Err(bad(format!(
            "invalid TOML root at {}: expected table",
            path.display()
        )));
    }
    Ok(parsed)
}

fn write_codex_root_toml(root: &toml::Value) -> Result<(), McpError> {
    let path = codex_config_toml_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| internal(e.to_string()))?;
    }
    let serialized = toml::to_string_pretty(root).map_err(|e| {
        bad(format!(
            "failed to serialize TOML for {}: {e}",
            path.display()
        ))
    })?;
    fs::write(&path, format!("{serialized}\n")).map_err(|e| internal(e.to_string()))
}

fn obj_as_string_map(value: Option<&Value>) -> Option<Map<String, Value>> {
    let obj = value.and_then(Value::as_object)?;
    let mut output = Map::with_capacity(obj.len());
    for (key, item) in obj {
        let Some(s) = item.as_str() else { continue };
        let trimmed = s.trim();
        if trimmed.is_empty() {
            continue;
        }
        output.insert(key.to_string(), Value::String(trimmed.to_string()));
    }
    if output.is_empty() {
        None
    } else {
        Some(output)
    }
}

fn key_looks_secret(name: &str) -> bool {
    let lowered = name.to_ascii_lowercase();
    lowered.contains("token")
        || lowered.contains("secret")
        || lowered.contains("password")
        || lowered.contains("api_key")
        || lowered.ends_with("key")
}

fn value_as_text(value: &Value) -> Option<String> {
    match value {
        Value::String(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Value::Number(raw) => Some(raw.to_string()),
        Value::Bool(raw) => Some(raw.to_string()),
        Value::Array(_) | Value::Object(_) => serde_json::to_string(value).ok(),
        Value::Null => None,
    }
}

/// Minimal percent-encoding for URL query components (RFC 3986 unreserved set
/// passes through, everything else is `%XX`). Avoids pulling in a urlencoding
/// crate for the one place Smithery query params need escaping.
fn encode_query_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for &byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn append_query_param(url: &str, key: &str, value: &str) -> String {
    let separator = if url.contains('?') { '&' } else { '?' };
    format!(
        "{url}{separator}{}={}",
        encode_query_component(key),
        encode_query_component(value)
    )
}

// ---------------------------------------------------------------------------
// Canonical spec + per-format converters
// ---------------------------------------------------------------------------

fn canonicalize_spec(spec: &Value, source: &str) -> Result<Value, McpError> {
    let obj = spec
        .as_object()
        .ok_or_else(|| bad(format!("{source}: MCP spec must be a JSON object")))?;

    let raw_type = obj
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();

    let resolved_type: &'static str = if raw_type.is_empty() {
        if obj.get("command").is_some() {
            "stdio"
        } else if obj.get("url").is_some() {
            "http"
        } else {
            return Err(bad(format!(
                "{source}: MCP spec missing 'type'; provide one of stdio, http, sse"
            )));
        }
    } else {
        match normalize_mcp_type(&raw_type) {
            Some(value) => value,
            None => {
                return Err(bad(format!(
                    "{source}: unsupported MCP server type '{raw_type}'; supported: stdio, http (aliases: streamable-http), sse"
                )));
            }
        }
    };

    let mut normalized = Map::new();

    match resolved_type {
        "stdio" => {
            let command = obj
                .get("command")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    bad(format!(
                        "{source}: stdio MCP spec requires a non-empty command"
                    ))
                })?;

            normalized.insert("type".to_string(), Value::String("stdio".to_string()));
            normalized.insert("command".to_string(), Value::String(command.to_string()));

            if let Some(args) = obj.get("args").and_then(Value::as_array) {
                let values = args
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(|value| Value::String(value.to_string()))
                    .collect::<Vec<_>>();
                if !values.is_empty() {
                    normalized.insert("args".to_string(), Value::Array(values));
                }
            }

            if let Some(env) = obj_as_string_map(obj.get("env")) {
                normalized.insert("env".to_string(), Value::Object(env));
            }

            if let Some(cwd) = obj
                .get("cwd")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                normalized.insert("cwd".to_string(), Value::String(cwd.to_string()));
            }
        }
        "http" | "sse" => {
            let url = obj
                .get("url")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    bad(format!(
                        "{source}: remote MCP spec requires a non-empty url"
                    ))
                })?;

            normalized.insert("type".to_string(), Value::String(resolved_type.to_string()));
            normalized.insert("url".to_string(), Value::String(url.to_string()));

            if let Some(headers) = obj_as_string_map(obj.get("headers")) {
                normalized.insert("headers".to_string(), Value::Object(headers));
            }
        }
        "local" | "remote" => {
            return canonicalize_opencode_spec(spec, source);
        }
        _ => unreachable!("normalize_mcp_type returns one of stdio/http/sse/local/remote"),
    }

    for (key, value) in obj {
        if normalized.contains_key(key) {
            continue;
        }
        if matches!(
            key.as_str(),
            "type" | "command" | "args" | "env" | "cwd" | "url" | "headers"
        ) {
            continue;
        }
        if !value.is_null() {
            normalized.insert(key.clone(), value.clone());
        }
    }

    Ok(Value::Object(normalized))
}

fn canonicalize_opencode_spec(spec: &Value, source: &str) -> Result<Value, McpError> {
    let obj = spec
        .as_object()
        .ok_or_else(|| bad(format!("{source}: OpenCode MCP spec must be a JSON object")))?;

    let typ = obj
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("local");

    match typ {
        "local" => {
            let mut converted = Map::new();
            converted.insert("type".to_string(), Value::String("stdio".to_string()));

            if let Some(command) = obj.get("command") {
                if let Some(arr) = command.as_array() {
                    let first = arr
                        .first()
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|item| !item.is_empty())
                        .ok_or_else(|| {
                            bad(format!(
                                "{source}: local MCP command array must include executable"
                            ))
                        })?;
                    converted.insert("command".to_string(), Value::String(first.to_string()));

                    if arr.len() > 1 {
                        let args = arr[1..]
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::trim)
                            .filter(|item| !item.is_empty())
                            .map(|item| Value::String(item.to_string()))
                            .collect::<Vec<_>>();
                        if !args.is_empty() {
                            converted.insert("args".to_string(), Value::Array(args));
                        }
                    }
                } else if let Some(raw) = command.as_str() {
                    let trimmed = raw.trim();
                    if trimmed.is_empty() {
                        return Err(bad(format!(
                            "{source}: local MCP command must be non-empty"
                        )));
                    }
                    converted.insert("command".to_string(), Value::String(trimmed.to_string()));
                }
            }

            if let Some(env) = obj_as_string_map(obj.get("environment")) {
                converted.insert("env".to_string(), Value::Object(env));
            }

            canonicalize_spec(&Value::Object(converted), source)
        }
        "remote" => {
            let mut converted = Map::new();
            let remote_type = obj
                .get("transport")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| *value == "sse")
                .map(|_| "sse")
                .unwrap_or("http");
            converted.insert("type".to_string(), Value::String(remote_type.to_string()));

            if let Some(url) = obj
                .get("url")
                .or_else(|| obj.get("deploymentUrl"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                converted.insert("url".to_string(), Value::String(url.to_string()));
            }

            if let Some(headers) = obj_as_string_map(obj.get("headers")) {
                converted.insert("headers".to_string(), Value::Object(headers));
            }

            canonicalize_spec(&Value::Object(converted), source)
        }
        _ => canonicalize_spec(spec, source),
    }
}

fn canonical_to_opencode_spec(spec: &Value) -> Result<Value, McpError> {
    let canonical = canonicalize_spec(spec, "OpenCode conversion")?;
    let obj = canonical
        .as_object()
        .ok_or_else(|| bad("OpenCode conversion: canonical spec must be an object"))?;
    let typ = obj.get("type").and_then(Value::as_str).unwrap_or("stdio");

    let mut out = Map::new();
    match typ {
        "stdio" => {
            let cmd = obj
                .get("command")
                .and_then(Value::as_str)
                .ok_or_else(|| bad("OpenCode conversion: stdio MCP spec missing command"))?;
            out.insert("type".to_string(), Value::String("local".to_string()));

            let mut command = vec![Value::String(cmd.to_string())];
            if let Some(args) = obj.get("args").and_then(Value::as_array) {
                for arg in args {
                    if let Some(raw) = arg.as_str() {
                        let trimmed = raw.trim();
                        if !trimmed.is_empty() {
                            command.push(Value::String(trimmed.to_string()));
                        }
                    }
                }
            }
            out.insert("command".to_string(), Value::Array(command));

            if let Some(env) = obj_as_string_map(obj.get("env")) {
                out.insert("environment".to_string(), Value::Object(env));
            }
        }
        "http" | "sse" => {
            let url = obj
                .get("url")
                .and_then(Value::as_str)
                .ok_or_else(|| bad("OpenCode conversion: remote MCP spec missing url"))?;
            out.insert("type".to_string(), Value::String("remote".to_string()));
            out.insert("url".to_string(), Value::String(url.to_string()));
            if typ == "sse" {
                out.insert("transport".to_string(), Value::String("sse".to_string()));
            }
            if let Some(headers) = obj_as_string_map(obj.get("headers")) {
                out.insert("headers".to_string(), Value::Object(headers));
            }
        }
        _ => {
            return Err(bad(format!(
                "OpenCode conversion: unsupported MCP type '{typ}'"
            )));
        }
    }

    out.insert("enabled".to_string(), Value::Bool(true));
    Ok(Value::Object(out))
}

fn json_to_toml_value(value: &Value) -> Option<toml::Value> {
    match value {
        Value::Null => None,
        Value::Bool(v) => Some(toml::Value::Boolean(*v)),
        Value::Number(v) => {
            if let Some(i) = v.as_i64() {
                Some(toml::Value::Integer(i))
            } else {
                v.as_f64().map(toml::Value::Float)
            }
        }
        Value::String(v) => Some(toml::Value::String(v.clone())),
        Value::Array(values) => {
            let mut converted = Vec::with_capacity(values.len());
            for item in values {
                converted.push(json_to_toml_value(item)?);
            }
            Some(toml::Value::Array(converted))
        }
        Value::Object(map) => {
            let mut table = toml::map::Map::new();
            for (key, val) in map {
                let Some(next) = json_to_toml_value(val) else {
                    continue;
                };
                table.insert(key.clone(), next);
            }
            Some(toml::Value::Table(table))
        }
    }
}

fn toml_to_json_value(value: &toml::Value) -> Value {
    match value {
        toml::Value::String(v) => Value::String(v.clone()),
        toml::Value::Integer(v) => Value::Number((*v).into()),
        toml::Value::Float(v) => serde_json::Number::from_f64(*v)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        toml::Value::Boolean(v) => Value::Bool(*v),
        toml::Value::Datetime(v) => Value::String(v.to_string()),
        toml::Value::Array(values) => Value::Array(values.iter().map(toml_to_json_value).collect()),
        toml::Value::Table(table) => {
            let mut out = Map::new();
            for (key, item) in table {
                out.insert(key.to_string(), toml_to_json_value(item));
            }
            Value::Object(out)
        }
    }
}

fn codex_entry_to_canonical(id: &str, value: &toml::Value) -> Result<Value, McpError> {
    let table = value
        .as_table()
        .ok_or_else(|| bad(format!("Codex MCP entry '{id}' must be a table")))?;

    let raw_type = table
        .get("type")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("stdio")
        .to_string();
    let canonical_type = normalize_mcp_type(&raw_type).ok_or_else(|| {
        bad(format!(
            "Codex MCP entry '{id}' has unsupported type '{raw_type}'"
        ))
    })?;

    let mut spec = Map::new();
    spec.insert(
        "type".to_string(),
        Value::String(canonical_type.to_string()),
    );

    match canonical_type {
        "stdio" => {
            if let Some(command) = table
                .get("command")
                .and_then(toml::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                spec.insert("command".to_string(), Value::String(command.to_string()));
            }
            if let Some(args) = table.get("args").and_then(toml::Value::as_array) {
                let values = args
                    .iter()
                    .filter_map(toml::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(|value| Value::String(value.to_string()))
                    .collect::<Vec<_>>();
                if !values.is_empty() {
                    spec.insert("args".to_string(), Value::Array(values));
                }
            }
            if let Some(env) = table.get("env").and_then(toml::Value::as_table) {
                let mut env_map = Map::new();
                for (key, value) in env {
                    let Some(text) = value.as_str() else { continue };
                    let trimmed = text.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    env_map.insert(key.to_string(), Value::String(trimmed.to_string()));
                }
                if !env_map.is_empty() {
                    spec.insert("env".to_string(), Value::Object(env_map));
                }
            }
        }
        "http" | "sse" => {
            if let Some(url) = table
                .get("url")
                .and_then(toml::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                spec.insert("url".to_string(), Value::String(url.to_string()));
            }
            let headers_table = table
                .get("http_headers")
                .and_then(toml::Value::as_table)
                .or_else(|| table.get("headers").and_then(toml::Value::as_table));
            if let Some(headers) = headers_table {
                let mut mapped = Map::new();
                for (key, value) in headers {
                    let Some(text) = value.as_str() else { continue };
                    let trimmed = text.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    mapped.insert(key.to_string(), Value::String(trimmed.to_string()));
                }
                if !mapped.is_empty() {
                    spec.insert("headers".to_string(), Value::Object(mapped));
                }
            }
        }
        _ => {
            return Err(bad(format!(
                "Codex MCP entry '{id}' has unsupported type '{raw_type}'"
            )));
        }
    }

    for (key, value) in table {
        if matches!(
            key.as_str(),
            "type" | "command" | "args" | "env" | "cwd" | "url" | "headers" | "http_headers"
        ) {
            continue;
        }
        spec.insert(key.to_string(), toml_to_json_value(value));
    }

    canonicalize_spec(&Value::Object(spec), "Codex config")
}

fn canonical_to_codex_entry(spec: &Value) -> Result<toml::Value, McpError> {
    let canonical = canonicalize_spec(spec, "Codex conversion")?;
    let obj = canonical
        .as_object()
        .ok_or_else(|| bad("Codex conversion: canonical spec must be an object"))?;
    let typ = obj.get("type").and_then(Value::as_str).unwrap_or("stdio");

    let mut table = toml::map::Map::new();
    table.insert("type".to_string(), toml::Value::String(typ.to_string()));

    match typ {
        "stdio" => {
            let command = obj
                .get("command")
                .and_then(Value::as_str)
                .ok_or_else(|| bad("Codex conversion: stdio MCP spec missing command"))?;
            table.insert(
                "command".to_string(),
                toml::Value::String(command.to_string()),
            );

            if let Some(args) = obj.get("args").and_then(Value::as_array) {
                let values = args
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(|value| toml::Value::String(value.to_string()))
                    .collect::<Vec<_>>();
                if !values.is_empty() {
                    table.insert("args".to_string(), toml::Value::Array(values));
                }
            }
            if let Some(env) = obj.get("env").and_then(Value::as_object) {
                let mut env_table = toml::map::Map::new();
                for (key, value) in env {
                    let Some(text) = value.as_str() else { continue };
                    let trimmed = text.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    env_table.insert(key.to_string(), toml::Value::String(trimmed.to_string()));
                }
                if !env_table.is_empty() {
                    table.insert("env".to_string(), toml::Value::Table(env_table));
                }
            }
        }
        "http" | "sse" => {
            let url = obj
                .get("url")
                .and_then(Value::as_str)
                .ok_or_else(|| bad("Codex conversion: remote MCP spec missing url"))?;
            table.insert("url".to_string(), toml::Value::String(url.to_string()));

            if let Some(headers) = obj.get("headers").and_then(Value::as_object) {
                let mut headers_table = toml::map::Map::new();
                for (key, value) in headers {
                    let Some(text) = value.as_str() else { continue };
                    let trimmed = text.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    headers_table.insert(key.to_string(), toml::Value::String(trimmed.to_string()));
                }
                if !headers_table.is_empty() {
                    table.insert(
                        "http_headers".to_string(),
                        toml::Value::Table(headers_table),
                    );
                }
            }
        }
        _ => {
            return Err(bad(format!(
                "Codex conversion: unsupported MCP type '{typ}'"
            )));
        }
    }

    for (key, value) in obj {
        if matches!(
            key.as_str(),
            "type" | "command" | "args" | "env" | "cwd" | "url" | "headers"
        ) {
            continue;
        }
        if let Some(converted) = json_to_toml_value(value) {
            table.insert(key.to_string(), converted);
        }
    }

    Ok(toml::Value::Table(table))
}

fn hermes_entry_to_canonical(entry: &serde_yaml::Value, id: &str) -> Result<Value, McpError> {
    let source = format!("Hermes mcp_servers '{id}'");
    let mut json = serde_json::to_value(entry)
        .map_err(|e| bad(format!("{source}: cannot read entry: {e}")))?;
    let obj = json
        .as_object_mut()
        .ok_or_else(|| bad(format!("{source}: entry must be a mapping")))?;
    if obj
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .is_empty()
        && obj.get("url").is_some()
    {
        let is_sse = obj
            .get("transport")
            .and_then(Value::as_str)
            .map(|t| t.eq_ignore_ascii_case("sse"))
            .unwrap_or(false);
        obj.insert(
            "type".to_string(),
            Value::String(if is_sse { "sse" } else { "http" }.to_string()),
        );
    }
    obj.remove("transport");
    canonicalize_spec(&json, &source)
}

fn canonical_to_hermes_entry(spec: &Value) -> Result<serde_yaml::Value, McpError> {
    let canonical = canonicalize_spec(spec, "Hermes conversion")?;
    let obj = canonical
        .as_object()
        .ok_or_else(|| bad("Hermes conversion: canonical spec must be an object"))?;
    let typ = obj.get("type").and_then(Value::as_str).unwrap_or("stdio");

    let mut out = Map::new();
    match typ {
        "stdio" => {
            for key in ["command", "args", "env"] {
                if let Some(value) = obj.get(key) {
                    out.insert(key.to_string(), value.clone());
                }
            }
        }
        "http" | "sse" => {
            if let Some(url) = obj.get("url") {
                out.insert("url".to_string(), url.clone());
            }
            if typ == "sse" {
                out.insert("transport".to_string(), Value::String("sse".to_string()));
            }
            if let Some(headers) = obj.get("headers") {
                out.insert("headers".to_string(), headers.clone());
            }
        }
        other => {
            return Err(bad(format!(
                "Hermes conversion: unsupported MCP type '{other}'"
            )));
        }
    }

    for (key, value) in obj {
        if matches!(
            key.as_str(),
            "type" | "command" | "args" | "env" | "cwd" | "url" | "headers" | "transport"
        ) {
            continue;
        }
        if !value.is_null() {
            out.insert(key.clone(), value.clone());
        }
    }

    serde_yaml::to_value(Value::Object(out))
        .map_err(|e| bad(format!("Hermes conversion: serialize entry failed: {e}")))
}

// ---------------------------------------------------------------------------
// Per-agent read / upsert / remove
// ---------------------------------------------------------------------------

fn read_claude_servers() -> Result<BTreeMap<String, Value>, McpError> {
    let root = read_json_file(&claude_config_path())?;
    let mut out = BTreeMap::new();
    let Some(servers) = root.get("mcpServers").and_then(Value::as_object) else {
        return Ok(out);
    };
    for (id, spec) in servers {
        if let Ok(normalized) = canonicalize_spec(spec, "Claude config") {
            out.insert(id.to_string(), normalized);
        }
    }
    Ok(out)
}

fn upsert_claude_server(id: &str, spec: &Value) -> Result<(), McpError> {
    let path = claude_config_path();
    let mut root = read_json_file(&path)?;
    if !root.is_object() {
        root = json!({});
    }
    let canonical = canonicalize_spec(spec, "Claude write")?;
    let obj = root
        .as_object_mut()
        .ok_or_else(|| bad(format!("invalid JSON root in {}", path.display())))?;
    if !obj.get("mcpServers").map(Value::is_object).unwrap_or(false) {
        obj.insert("mcpServers".to_string(), Value::Object(Map::new()));
    }
    let map = obj
        .get_mut("mcpServers")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| bad(format!("invalid mcpServers in {}", path.display())))?;
    map.insert(id.to_string(), canonical);
    write_json_file(&path, &root)?;
    enable_claude_local_plugin(id)
}

fn remove_claude_server(id: &str) -> Result<bool, McpError> {
    let path = claude_config_path();
    if !path.exists() {
        disable_claude_local_plugin(id)?;
        return Ok(false);
    }
    let mut root = read_json_file(&path)?;
    let Some(obj) = root.as_object_mut() else {
        disable_claude_local_plugin(id)?;
        return Ok(false);
    };
    let Some(servers) = obj.get_mut("mcpServers").and_then(Value::as_object_mut) else {
        disable_claude_local_plugin(id)?;
        return Ok(false);
    };
    let removed = servers.remove(id).is_some();
    if removed {
        write_json_file(&path, &root)?;
    }
    disable_claude_local_plugin(id)?;
    Ok(removed)
}

/// Claude Code gates user-scope MCP servers behind `enabledPlugins`: a server
/// defined in `~/.claude.json` will not load until `<id>@local: true` appears
/// in `~/.claude/settings.json`.
fn enable_claude_local_plugin(id: &str) -> Result<(), McpError> {
    let path = claude_settings_path();
    let mut root = read_json_file(&path)?;
    if !root.is_object() {
        root = json!({});
    }
    let obj = root
        .as_object_mut()
        .ok_or_else(|| bad(format!("invalid JSON root in {}", path.display())))?;
    if !obj
        .get("enabledPlugins")
        .map(Value::is_object)
        .unwrap_or(false)
    {
        obj.insert("enabledPlugins".to_string(), Value::Object(Map::new()));
    }
    let plugins = obj
        .get_mut("enabledPlugins")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| bad(format!("invalid enabledPlugins in {}", path.display())))?;
    let key = claude_local_plugin_key(id);
    if matches!(plugins.get(&key), Some(Value::Bool(true))) {
        return Ok(());
    }
    plugins.insert(key, Value::Bool(true));
    write_json_file(&path, &root)
}

fn disable_claude_local_plugin(id: &str) -> Result<(), McpError> {
    let path = claude_settings_path();
    if !path.exists() {
        return Ok(());
    }
    let mut root = read_json_file(&path)?;
    let Some(obj) = root.as_object_mut() else {
        return Ok(());
    };
    let Some(plugins) = obj.get_mut("enabledPlugins").and_then(Value::as_object_mut) else {
        return Ok(());
    };
    if plugins.remove(&claude_local_plugin_key(id)).is_some() {
        write_json_file(&path, &root)?;
    }
    Ok(())
}

fn read_codex_servers() -> Result<BTreeMap<String, Value>, McpError> {
    let root = read_codex_root_toml()?;
    let Some(table) = root.as_table() else {
        return Ok(BTreeMap::new());
    };
    let mut out = BTreeMap::new();
    if let Some(current) = table.get("mcp_servers").and_then(toml::Value::as_table) {
        for (id, spec) in current {
            if let Ok(normalized) = codex_entry_to_canonical(id, spec) {
                out.insert(id.to_string(), normalized);
            }
        }
    }
    Ok(out)
}

fn upsert_codex_server(id: &str, spec: &Value) -> Result<(), McpError> {
    let mut root = read_codex_root_toml()?;
    let table = root
        .as_table_mut()
        .ok_or_else(|| bad("Codex root TOML must be a table"))?;
    let codex_entry = canonical_to_codex_entry(spec)?;
    if !table
        .get("mcp_servers")
        .map(toml::Value::is_table)
        .unwrap_or(false)
    {
        table.insert(
            "mcp_servers".to_string(),
            toml::Value::Table(toml::map::Map::new()),
        );
    }
    let mcp_servers = table
        .get_mut("mcp_servers")
        .and_then(toml::Value::as_table_mut)
        .ok_or_else(|| bad("Codex mcp_servers must be a TOML table"))?;
    mcp_servers.insert(id.to_string(), codex_entry);
    write_codex_root_toml(&root)
}

fn remove_codex_server(id: &str) -> Result<bool, McpError> {
    let path = codex_config_toml_path();
    if !path.exists() {
        return Ok(false);
    }
    let mut root = read_codex_root_toml()?;
    let Some(table) = root.as_table_mut() else {
        return Ok(false);
    };
    let mut removed = false;
    if let Some(mcp_servers) = table
        .get_mut("mcp_servers")
        .and_then(toml::Value::as_table_mut)
    {
        removed |= mcp_servers.remove(id).is_some();
        if mcp_servers.is_empty() {
            table.remove("mcp_servers");
        }
    }
    if removed {
        write_codex_root_toml(&root)?;
    }
    Ok(removed)
}

fn read_opencode_servers() -> Result<BTreeMap<String, Value>, McpError> {
    let root = read_json_file(&opencode_config_path())?;
    let mut out = BTreeMap::new();
    if let Some(servers) = root.get("mcpServers").and_then(Value::as_object) {
        for (id, spec) in servers {
            if let Ok(normalized) = canonicalize_spec(spec, "OpenCode mcpServers") {
                out.insert(id.to_string(), normalized);
            }
        }
    }
    if let Some(servers) = root.get("mcp").and_then(Value::as_object) {
        for (id, spec) in servers {
            if out.contains_key(id) {
                continue;
            }
            if let Ok(normalized) = canonicalize_opencode_spec(spec, "OpenCode mcp") {
                out.insert(id.to_string(), normalized);
            }
        }
    }
    Ok(out)
}

fn upsert_opencode_server(id: &str, spec: &Value) -> Result<(), McpError> {
    let path = opencode_config_path();
    let mut root = read_json_file(&path)?;
    if !root.is_object() {
        root = json!({});
    }
    let obj = root
        .as_object_mut()
        .ok_or_else(|| bad(format!("invalid JSON root in {}", path.display())))?;

    if obj.get("mcpServers").map(Value::is_object).unwrap_or(false) {
        let canonical = canonicalize_spec(spec, "OpenCode write mcpServers")?;
        let map = obj
            .get_mut("mcpServers")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| bad(format!("invalid mcpServers in {}", path.display())))?;
        map.insert(id.to_string(), canonical);
    } else {
        if !obj.get("mcp").map(Value::is_object).unwrap_or(false) {
            obj.insert("mcp".to_string(), Value::Object(Map::new()));
        }
        let converted = canonical_to_opencode_spec(spec)?;
        let map = obj
            .get_mut("mcp")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| bad(format!("invalid mcp in {}", path.display())))?;
        map.insert(id.to_string(), converted);
    }
    write_json_file(&path, &root)
}

fn remove_opencode_server(id: &str) -> Result<bool, McpError> {
    let path = opencode_config_path();
    if !path.exists() {
        return Ok(false);
    }
    let mut root = read_json_file(&path)?;
    let Some(obj) = root.as_object_mut() else {
        return Ok(false);
    };
    let mut removed = false;
    if let Some(servers) = obj.get_mut("mcpServers").and_then(Value::as_object_mut) {
        removed |= servers.remove(id).is_some();
    }
    if let Some(servers) = obj.get_mut("mcp").and_then(Value::as_object_mut) {
        removed |= servers.remove(id).is_some();
    }
    if removed {
        write_json_file(&path, &root)?;
    }
    Ok(removed)
}

fn read_gemini_servers() -> Result<BTreeMap<String, Value>, McpError> {
    let root = read_json_file(&gemini_config_path())?;
    let mut out = BTreeMap::new();
    let Some(servers) = root.get("mcpServers").and_then(Value::as_object) else {
        return Ok(out);
    };
    for (id, spec) in servers {
        if let Ok(normalized) = canonicalize_spec(spec, "Gemini config") {
            out.insert(id.to_string(), normalized);
        }
    }
    Ok(out)
}

fn upsert_gemini_server(id: &str, spec: &Value) -> Result<(), McpError> {
    let path = gemini_config_path();
    let mut root = read_json_file(&path)?;
    if !root.is_object() {
        root = json!({});
    }
    let canonical = canonicalize_spec(spec, "Gemini write")?;
    let obj = root
        .as_object_mut()
        .ok_or_else(|| bad(format!("invalid JSON root in {}", path.display())))?;
    if !obj.get("mcpServers").map(Value::is_object).unwrap_or(false) {
        obj.insert("mcpServers".to_string(), Value::Object(Map::new()));
    }
    let map = obj
        .get_mut("mcpServers")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| bad(format!("invalid mcpServers in {}", path.display())))?;
    map.insert(id.to_string(), canonical);
    write_json_file(&path, &root)
}

fn remove_gemini_server(id: &str) -> Result<bool, McpError> {
    let path = gemini_config_path();
    if !path.exists() {
        return Ok(false);
    }
    let mut root = read_json_file(&path)?;
    let Some(obj) = root.as_object_mut() else {
        return Ok(false);
    };
    let Some(servers) = obj.get_mut("mcpServers").and_then(Value::as_object_mut) else {
        return Ok(false);
    };
    let removed = servers.remove(id).is_some();
    if removed {
        write_json_file(&path, &root)?;
    }
    Ok(removed)
}

fn read_openclaw_servers() -> Result<BTreeMap<String, Value>, McpError> {
    let root = read_json_file(&openclaw_config_path())?;
    let mut out = BTreeMap::new();
    let Some(mcp) = root.get("mcp").and_then(Value::as_object) else {
        return Ok(out);
    };
    let Some(servers) = mcp.get("servers").and_then(Value::as_object) else {
        return Ok(out);
    };
    for (id, spec) in servers {
        if let Ok(normalized) = canonicalize_spec(spec, "OpenClaw config") {
            out.insert(id.to_string(), normalized);
        }
    }
    Ok(out)
}

fn upsert_openclaw_server(id: &str, spec: &Value) -> Result<(), McpError> {
    let path = openclaw_config_path();
    let mut root = read_json_file(&path)?;
    if !root.is_object() {
        root = json!({});
    }
    let canonical = canonicalize_spec(spec, "OpenClaw write")?;
    let obj = root
        .as_object_mut()
        .ok_or_else(|| bad(format!("invalid JSON root in {}", path.display())))?;
    if !obj.get("mcp").map(Value::is_object).unwrap_or(false) {
        obj.insert("mcp".to_string(), json!({}));
    }
    let mcp = obj
        .get_mut("mcp")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| bad(format!("invalid mcp in {}", path.display())))?;
    if !mcp.get("servers").map(Value::is_object).unwrap_or(false) {
        mcp.insert("servers".to_string(), Value::Object(Map::new()));
    }
    let servers = mcp
        .get_mut("servers")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| bad(format!("invalid mcp.servers in {}", path.display())))?;
    servers.insert(id.to_string(), canonical);
    write_json_file(&path, &root)
}

fn remove_openclaw_server(id: &str) -> Result<bool, McpError> {
    let path = openclaw_config_path();
    if !path.exists() {
        return Ok(false);
    }
    let mut root = read_json_file(&path)?;
    let Some(obj) = root.as_object_mut() else {
        return Ok(false);
    };
    let Some(mcp) = obj.get_mut("mcp").and_then(Value::as_object_mut) else {
        return Ok(false);
    };
    let Some(servers) = mcp.get_mut("servers").and_then(Value::as_object_mut) else {
        return Ok(false);
    };
    let removed = servers.remove(id).is_some();
    if removed {
        if servers.is_empty() {
            mcp.remove("servers");
        }
        if mcp.is_empty() {
            obj.remove("mcp");
        }
        write_json_file(&path, &root)?;
    }
    Ok(removed)
}

fn read_cline_servers() -> Result<BTreeMap<String, Value>, McpError> {
    let root = read_json_file(&cline_config_path())?;
    let mut out = BTreeMap::new();
    let Some(servers) = root.get("mcpServers").and_then(Value::as_object) else {
        return Ok(out);
    };
    for (id, spec) in servers {
        if let Ok(normalized) = canonicalize_spec(spec, "Cline config") {
            out.insert(id.to_string(), normalized);
        }
    }
    Ok(out)
}

fn upsert_cline_server(id: &str, spec: &Value) -> Result<(), McpError> {
    let path = cline_config_path();
    let mut root = read_json_file(&path)?;
    if !root.is_object() {
        root = json!({});
    }
    let canonical = canonicalize_spec(spec, "Cline write")?;
    let obj = root
        .as_object_mut()
        .ok_or_else(|| bad(format!("invalid JSON root in {}", path.display())))?;
    if !obj.get("mcpServers").map(Value::is_object).unwrap_or(false) {
        obj.insert("mcpServers".to_string(), Value::Object(Map::new()));
    }
    let map = obj
        .get_mut("mcpServers")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| bad(format!("invalid mcpServers in {}", path.display())))?;
    map.insert(id.to_string(), canonical);
    write_json_file(&path, &root)
}

fn remove_cline_server(id: &str) -> Result<bool, McpError> {
    let path = cline_config_path();
    if !path.exists() {
        return Ok(false);
    }
    let mut root = read_json_file(&path)?;
    let Some(obj) = root.as_object_mut() else {
        return Ok(false);
    };
    let Some(servers) = obj.get_mut("mcpServers").and_then(Value::as_object_mut) else {
        return Ok(false);
    };
    let removed = servers.remove(id).is_some();
    if removed {
        write_json_file(&path, &root)?;
    }
    Ok(removed)
}

fn read_hermes_servers() -> Result<BTreeMap<String, Value>, McpError> {
    let path = hermes_config_yaml_path();
    let Ok(raw) = fs::read_to_string(&path) else {
        return Ok(BTreeMap::new());
    };
    let root: serde_yaml::Value = match serde_yaml::from_str(&raw) {
        Ok(value) => value,
        Err(_) => return Ok(BTreeMap::new()),
    };
    let mut out = BTreeMap::new();
    let Some(servers) = root
        .get("mcp_servers")
        .and_then(serde_yaml::Value::as_mapping)
    else {
        return Ok(out);
    };
    for (key, entry) in servers {
        let Some(id) = key.as_str() else { continue };
        if let Ok(spec) = hermes_entry_to_canonical(entry, id) {
            out.insert(id.to_string(), spec);
        }
    }
    Ok(out)
}

fn upsert_hermes_server(id: &str, spec: &Value) -> Result<(), McpError> {
    use serde_yaml::{Mapping, Value as Yaml};
    let entry = canonical_to_hermes_entry(spec)?;
    let path = hermes_config_yaml_path();

    let mut root: Yaml = match fs::read_to_string(&path) {
        Ok(raw) if !raw.trim().is_empty() => serde_yaml::from_str(&raw)
            .map_err(|e| bad(format!("invalid hermes config.yaml: {e}")))?,
        Ok(_) => Yaml::Mapping(Mapping::new()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Yaml::Mapping(Mapping::new()),
        Err(e) => return Err(internal(format!("read hermes config.yaml failed: {e}"))),
    };
    if !root.is_mapping() {
        root = Yaml::Mapping(Mapping::new());
    }
    let root_map = root.as_mapping_mut().expect("root is a mapping");
    let servers_key = Yaml::String("mcp_servers".to_string());
    if !root_map
        .get(&servers_key)
        .map(Yaml::is_mapping)
        .unwrap_or(false)
    {
        root_map.insert(servers_key.clone(), Yaml::Mapping(Mapping::new()));
    }
    let servers = root_map
        .get_mut(&servers_key)
        .and_then(Yaml::as_mapping_mut)
        .ok_or_else(|| bad("hermes mcp_servers must be a mapping"))?;
    servers.insert(Yaml::String(id.to_string()), entry);

    let yaml = serde_yaml::to_string(&root)
        .map_err(|e| bad(format!("serialize hermes config.yaml failed: {e}")))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| internal(e.to_string()))?;
    }
    fs::write(&path, yaml).map_err(|e| internal(e.to_string()))
}

fn remove_hermes_server(id: &str) -> Result<bool, McpError> {
    use serde_yaml::Value as Yaml;
    let path = hermes_config_yaml_path();
    let raw = match fs::read_to_string(&path) {
        Ok(raw) if !raw.trim().is_empty() => raw,
        _ => return Ok(false),
    };
    let mut root: Yaml = match serde_yaml::from_str(&raw) {
        Ok(value) => value,
        Err(_) => return Ok(false),
    };
    let Some(root_map) = root.as_mapping_mut() else {
        return Ok(false);
    };
    let servers_key = Yaml::String("mcp_servers".to_string());
    let Some(servers) = root_map
        .get_mut(&servers_key)
        .and_then(Yaml::as_mapping_mut)
    else {
        return Ok(false);
    };
    let removed = servers.remove(Yaml::String(id.to_string())).is_some();
    if servers.is_empty() {
        root_map.remove(servers_key);
    }
    if removed {
        let yaml = serde_yaml::to_string(&root)
            .map_err(|e| bad(format!("serialize hermes config.yaml failed: {e}")))?;
        fs::write(&path, yaml).map_err(|e| internal(e.to_string()))?;
    }
    Ok(removed)
}

fn upsert_server_for_app(app: McpAppType, id: &str, spec: &Value) -> Result<(), McpError> {
    match app {
        McpAppType::ClaudeCode => upsert_claude_server(id, spec),
        McpAppType::Codex => upsert_codex_server(id, spec),
        McpAppType::OpenCode => upsert_opencode_server(id, spec),
        McpAppType::Gemini => upsert_gemini_server(id, spec),
        McpAppType::OpenClaw => upsert_openclaw_server(id, spec),
        McpAppType::Cline => upsert_cline_server(id, spec),
        McpAppType::Hermes => upsert_hermes_server(id, spec),
    }
}

fn remove_server_for_app(app: McpAppType, id: &str) -> Result<bool, McpError> {
    match app {
        McpAppType::ClaudeCode => remove_claude_server(id),
        McpAppType::Codex => remove_codex_server(id),
        McpAppType::OpenCode => remove_opencode_server(id),
        McpAppType::Gemini => remove_gemini_server(id),
        McpAppType::OpenClaw => remove_openclaw_server(id),
        McpAppType::Cline => remove_cline_server(id),
        McpAppType::Hermes => remove_hermes_server(id),
    }
}

fn read_servers_for_app(app: McpAppType) -> Result<BTreeMap<String, Value>, McpError> {
    match app {
        McpAppType::ClaudeCode => read_claude_servers(),
        McpAppType::Codex => read_codex_servers(),
        McpAppType::OpenCode => read_opencode_servers(),
        McpAppType::Gemini => read_gemini_servers(),
        McpAppType::OpenClaw => read_openclaw_servers(),
        McpAppType::Cline => read_cline_servers(),
        McpAppType::Hermes => read_hermes_servers(),
    }
}

// ---------------------------------------------------------------------------
// Global registry (~/.vibex/mcp.json)
// ---------------------------------------------------------------------------

fn read_global_servers() -> Result<BTreeMap<String, Value>, McpError> {
    let root = read_json_file(&global_store_path())?;
    let mut out = BTreeMap::new();
    let Some(servers) = root.get("mcpServers").and_then(Value::as_object) else {
        return Ok(out);
    };
    for (id, spec) in servers {
        if let Ok(normalized) = canonicalize_spec(spec, "global registry") {
            out.insert(id.to_string(), normalized);
        }
    }
    Ok(out)
}

fn upsert_global_server(id: &str, spec: &Value) -> Result<(), McpError> {
    let path = global_store_path();
    let mut root = read_json_file(&path)?;
    if !root.is_object() {
        root = json!({});
    }
    let canonical = canonicalize_spec(spec, "global registry write")?;
    let obj = root
        .as_object_mut()
        .ok_or_else(|| bad(format!("invalid JSON root in {}", path.display())))?;
    if !obj.get("mcpServers").map(Value::is_object).unwrap_or(false) {
        obj.insert("mcpServers".to_string(), Value::Object(Map::new()));
    }
    let map = obj
        .get_mut("mcpServers")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| bad(format!("invalid mcpServers in {}", path.display())))?;
    map.insert(id.to_string(), canonical);
    write_json_file(&path, &root)
}

fn remove_global_server(id: &str) -> Result<bool, McpError> {
    let path = global_store_path();
    if !path.exists() {
        return Ok(false);
    }
    let mut root = read_json_file(&path)?;
    let Some(obj) = root.as_object_mut() else {
        return Ok(false);
    };
    let Some(servers) = obj.get_mut("mcpServers").and_then(Value::as_object_mut) else {
        return Ok(false);
    };
    let removed = servers.remove(id).is_some();
    if removed {
        write_json_file(&path, &root)?;
    }
    Ok(removed)
}

// ---------------------------------------------------------------------------
// Scan + target application
// ---------------------------------------------------------------------------

fn scan_local_servers() -> Result<Vec<LocalMcpServer>, McpError> {
    // (spec, apps, global) per id. The first spec seen wins; the global
    // registry is read first so its canonical spec is preferred.
    let mut merged: BTreeMap<String, (Value, BTreeSet<McpAppType>, bool)> = BTreeMap::new();

    for (id, spec) in read_global_servers()? {
        merged
            .entry(id)
            .or_insert_with(|| (spec.clone(), BTreeSet::new(), false))
            .2 = true;
    }

    for app in ALL_APPS {
        for (id, spec) in read_servers_for_app(app)? {
            let entry = merged
                .entry(id)
                .or_insert_with(|| (spec.clone(), BTreeSet::new(), false));
            entry.1.insert(app);
        }
    }

    Ok(merged
        .into_iter()
        .map(|(id, (spec, apps, global))| LocalMcpServer {
            id,
            spec,
            global,
            apps: apps.into_iter().collect(),
        })
        .collect())
}

/// Synchronous read used while constructing ACP `session/new` MCP inputs.
/// This performs local file reads only; no marketplace/network access.
pub fn scan_local_sync() -> Result<Vec<LocalMcpServer>, McpError> {
    scan_local_servers()
}

/// Add a server to the requested targets (never removes from others). When
/// `global` is set, the server is recorded in the global registry AND mirrored
/// into every agent's config file.
fn install_targets(
    id: &str,
    spec: &Value,
    global: bool,
    apps: &[McpAppType],
) -> Result<(), McpError> {
    if global {
        upsert_global_server(id, spec)?;
        for app in ALL_APPS {
            upsert_server_for_app(app, id, spec)?;
        }
        return Ok(());
    }
    if apps.is_empty() {
        return Err(bad("请至少选择一个目标应用"));
    }
    for app in apps {
        upsert_server_for_app(*app, id, spec)?;
    }
    Ok(())
}

/// Set a server's targets to exactly the requested set (removes from
/// deselected targets). Used by the "本地 MCP" editor. `global` implies all
/// agents, mirroring the install semantics.
fn set_targets(id: &str, spec: &Value, global: bool, apps: &[McpAppType]) -> Result<(), McpError> {
    if global {
        upsert_global_server(id, spec)?;
    } else {
        remove_global_server(id)?;
    }
    let want: BTreeSet<McpAppType> = if global {
        ALL_APPS.into_iter().collect()
    } else {
        apps.iter().copied().collect()
    };
    for app in ALL_APPS {
        if want.contains(&app) {
            upsert_server_for_app(app, id, spec)?;
        } else {
            remove_server_for_app(app, id)?;
        }
    }
    Ok(())
}

fn uninstall_everywhere(id: &str) -> Result<(), McpError> {
    remove_global_server(id)?;
    for app in ALL_APPS {
        remove_server_for_app(app, id)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Smithery marketplace resolution
// ---------------------------------------------------------------------------

async fn search_smithery(query: &str, limit: u32) -> Result<Vec<McpMarketplaceItem>, McpError> {
    let client = marketplace_http_client()?;
    let trimmed = query.trim();
    let response = send_request_with_retry("failed to query smithery marketplace", || {
        client
            .get("https://api.smithery.ai/servers")
            .query(&[("limit", limit.to_string()), ("q", trimmed.to_string())])
    })
    .await?;

    if !response.status().is_success() {
        return Err(internal(format!(
            "smithery marketplace request failed: HTTP {}",
            response.status()
        )));
    }

    let payload = parse_json_response::<SmitheryServerListResponse>(
        response,
        "failed to parse smithery response",
    )
    .await?;

    Ok(payload
        .servers
        .into_iter()
        .map(|item| McpMarketplaceItem {
            provider_id: MARKETPLACE_SMITHERY.to_string(),
            server_id: item.qualified_name,
            name: item.display_name,
            description: item
                .description
                .unwrap_or_else(|| "No description".to_string()),
            homepage: clean_opt(item.homepage),
            remote: item.remote,
            verified: item.verified,
            icon_url: clean_opt(item.icon_url),
            latest_version: None,
            protocols: if item.remote {
                vec!["http".to_string()]
            } else {
                Vec::new()
            },
            owner: clean_opt(item.owner),
            namespace: clean_opt(item.namespace),
            downloads: item.use_count,
            score: item.score,
            is_deployed: item.is_deployed,
        })
        .collect())
}

async fn fetch_smithery_server_summary(server_id: &str) -> Option<SmitheryServerSummary> {
    // A missing summary (no match / non-2xx) is a legitimate `None`; network and
    // parse failures are not — log those so a silently-empty marketplace detail
    // is diagnosable instead of indistinguishable from "no summary".
    let client = match marketplace_http_client() {
        Ok(client) => client,
        Err(e) => {
            tracing::warn!(error = ?e, "smithery summary: failed to build HTTP client");
            return None;
        }
    };
    let response = match send_request_with_retry("failed to fetch smithery server summary", || {
        client
            .get("https://api.smithery.ai/servers")
            .query(&[("limit", "30"), ("q", server_id)])
    })
    .await
    {
        Ok(response) => response,
        Err(e) => {
            tracing::warn!(server_id, error = ?e, "smithery summary: request failed");
            return None;
        }
    };
    if !response.status().is_success() {
        return None;
    }
    let payload = match parse_json_response::<SmitheryServerListResponse>(response, "summary").await
    {
        Ok(payload) => payload,
        Err(e) => {
            tracing::warn!(server_id, error = ?e, "smithery summary: failed to parse response");
            return None;
        }
    };
    payload
        .servers
        .into_iter()
        .find(|item| item.qualified_name == server_id)
}

async fn fetch_smithery_server_detail(server_id: &str) -> Result<SmitheryServerDetail, McpError> {
    let url = format!("https://api.smithery.ai/servers/{server_id}");
    let client = marketplace_http_client()?;
    let response = send_request_with_retry("failed to fetch smithery server detail", || {
        client.get(url.clone())
    })
    .await?;
    if !response.status().is_success() {
        return Err(internal(format!(
            "smithery server detail request failed: HTTP {}",
            response.status()
        )));
    }
    parse_json_response::<SmitheryServerDetail>(response, "failed to parse smithery server detail")
        .await
}

fn clean_opt(value: Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn smithery_option_id(index: usize, protocol: &str) -> String {
    format!("smithery:connection:{index}:{protocol}")
}

fn parse_smithery_option_id(option_id: &str) -> Option<usize> {
    let mut parts = option_id.split(':');
    let provider = parts.next()?;
    let source = parts.next()?;
    let idx = parts.next()?.parse::<usize>().ok()?;
    if provider != "smithery" || source != "connection" {
        return None;
    }
    Some(idx)
}

fn smithery_connection_protocol(connection: &SmitheryConnection) -> String {
    match normalize_mcp_type(&connection.r#type) {
        Some("sse") => "sse".to_string(),
        _ => "http".to_string(),
    }
}

fn smithery_connection_url(
    connection: &SmitheryConnection,
    fallback: Option<&str>,
) -> Option<String> {
    clean_opt(connection.deployment_url.clone()).or_else(|| clean_opt(fallback.map(str::to_string)))
}

fn smithery_property_kind(prop: &Map<String, Value>) -> String {
    if let Some(raw) = prop.get("type") {
        if let Some(typ) = raw.as_str() {
            return match typ.trim() {
                "boolean" => "boolean".to_string(),
                "number" => "number".to_string(),
                "integer" => "integer".to_string(),
                "object" | "array" => "json".to_string(),
                _ => "string".to_string(),
            };
        }
        if let Some(types) = raw.as_array() {
            for item in types {
                let Some(typ) = item.as_str() else { continue };
                if typ == "null" {
                    continue;
                }
                return match typ {
                    "boolean" => "boolean".to_string(),
                    "number" => "number".to_string(),
                    "integer" => "integer".to_string(),
                    "object" | "array" => "json".to_string(),
                    _ => "string".to_string(),
                };
            }
        }
    }
    "string".to_string()
}

fn smithery_field_location(prop: &Map<String, Value>, secret: bool) -> String {
    let explicit = prop
        .get("x-from")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if explicit.eq_ignore_ascii_case("header") {
        return "header".to_string();
    }
    if explicit.eq_ignore_ascii_case("query") {
        return "query".to_string();
    }
    if secret {
        return "header".to_string();
    }
    "query".to_string()
}

struct SmitheryConfigField {
    key: String,
    description: Option<String>,
    required: bool,
    secret: bool,
    kind: String,
    default_value: Option<Value>,
    enum_values: Vec<String>,
    location: String,
}

fn parse_smithery_config_fields(schema: Option<&Value>) -> Vec<SmitheryConfigField> {
    let Some(root) = schema.and_then(Value::as_object) else {
        return Vec::new();
    };
    let required = root
        .get("required")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<BTreeSet<_>>()
        })
        .unwrap_or_default();
    let Some(properties) = root.get("properties").and_then(Value::as_object) else {
        return Vec::new();
    };

    let mut fields = Vec::new();
    for (key, raw_prop) in properties {
        let Some(prop) = raw_prop.as_object() else {
            continue;
        };
        let kind = smithery_property_kind(prop);
        let secret = prop
            .get("writeOnly")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || key_looks_secret(key);
        let location = smithery_field_location(prop, secret);
        let enum_values = prop
            .get("enum")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        fields.push(SmitheryConfigField {
            key: key.to_string(),
            description: clean_opt(
                prop.get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            ),
            required: required.contains(key),
            secret,
            kind,
            default_value: prop.get("default").cloned(),
            enum_values,
            location,
        });
    }

    fields
}

fn smithery_parameter_fields(
    connection: &SmitheryConnection,
) -> Vec<McpMarketplaceInstallParameter> {
    parse_smithery_config_fields(connection.config_schema.as_ref())
        .into_iter()
        .map(|field| McpMarketplaceInstallParameter {
            key: field.key.clone(),
            label: field.key,
            description: field.description,
            required: field.required,
            secret: field.secret,
            kind: field.kind,
            default_value: field.default_value,
            placeholder: None,
            enum_values: field.enum_values,
            location: Some(field.location),
        })
        .collect()
}

fn smithery_query_value_to_text(value: &Value) -> Option<String> {
    match value {
        Value::Array(_) | Value::Object(_) => serde_json::to_string(value).ok(),
        _ => value_as_text(value),
    }
}

fn resolve_smithery_connection_spec_with_values(
    connection: &SmitheryConnection,
    fallback_url: Option<&str>,
    values: &Map<String, Value>,
    enforce_required: bool,
) -> Result<Value, McpError> {
    let protocol = smithery_connection_protocol(connection);
    let url = smithery_connection_url(connection, fallback_url)
        .ok_or_else(|| bad("smithery connection missing deployment URL"))?;

    let config_fields = parse_smithery_config_fields(connection.config_schema.as_ref());
    let mut next_url = url;
    let mut headers = Map::new();

    for field in config_fields {
        let value = values
            .get(&field.key)
            .cloned()
            .or_else(|| field.default_value.clone());

        let Some(value) = value else {
            if enforce_required && field.required {
                return Err(bad(format!(
                    "missing required configuration '{}'",
                    field.key
                )));
            }
            continue;
        };

        if field.location == "header" {
            if let Some(text) = value_as_text(&value) {
                headers.insert(field.key, Value::String(text));
            } else if enforce_required && field.required {
                return Err(bad(format!("invalid configuration value '{}'", field.key)));
            }
            continue;
        }

        if let Some(text) = smithery_query_value_to_text(&value) {
            next_url = append_query_param(&next_url, &field.key, &text);
        } else if enforce_required && field.required {
            return Err(bad(format!("invalid configuration value '{}'", field.key)));
        }
    }

    let mut spec = Map::new();
    spec.insert("type".to_string(), Value::String(protocol));
    spec.insert("url".to_string(), Value::String(next_url));
    if !headers.is_empty() {
        spec.insert("headers".to_string(), Value::Object(headers));
    }
    canonicalize_spec(&Value::Object(spec), "smithery install")
}

fn build_smithery_install_options(
    server: &SmitheryServerDetail,
) -> Result<Vec<McpMarketplaceInstallOption>, McpError> {
    let mut options = Vec::new();
    for (index, connection) in server.connections.iter().enumerate() {
        let protocol = smithery_connection_protocol(connection);
        if let Ok(spec) = resolve_smithery_connection_spec_with_values(
            connection,
            server.deployment_url.as_deref(),
            &Map::new(),
            false,
        ) {
            options.push(McpMarketplaceInstallOption {
                id: smithery_option_id(index, &protocol),
                protocol: protocol.clone(),
                label: format!("{protocol} (connection {})", index + 1),
                description: clean_opt(connection.deployment_url.clone()),
                spec,
                parameters: smithery_parameter_fields(connection),
            });
        }
    }

    if options.is_empty()
        && let Some(fallback) = clean_opt(server.deployment_url.clone())
    {
        let spec = canonicalize_spec(
            &json!({ "type": "http", "url": fallback }),
            "smithery fallback",
        )?;
        options.push(McpMarketplaceInstallOption {
            id: "smithery:fallback:http".to_string(),
            protocol: "http".to_string(),
            label: "http".to_string(),
            description: Some(fallback),
            spec,
            parameters: Vec::new(),
        });
    }

    if options.is_empty() {
        return Err(not_found(format!(
            "smithery server '{}' does not provide installable connection info",
            server.qualified_name
        )));
    }

    Ok(options)
}

fn resolve_smithery_install_spec(
    server: &SmitheryServerDetail,
    option_id: &Option<String>,
    values: &Map<String, Value>,
) -> Result<Value, McpError> {
    let options = build_smithery_install_options(server)?;
    let selected = select_install_option(&options, option_id)
        .ok_or_else(|| not_found("no smithery install option available"))?;

    if let Some(index) = parse_smithery_option_id(&selected.id) {
        let connection = server.connections.get(index).ok_or_else(|| {
            not_found(format!(
                "selected smithery connection is out of range: {index}"
            ))
        })?;
        return resolve_smithery_connection_spec_with_values(
            connection,
            server.deployment_url.as_deref(),
            values,
            true,
        );
    }

    canonicalize_spec(&selected.spec, "smithery selected option")
}

// ---------------------------------------------------------------------------
// Command entry points (wrapped by `#[tauri::command]` in config.rs)
// ---------------------------------------------------------------------------

pub async fn scan_local() -> Result<Vec<LocalMcpServer>, McpError> {
    scan_local_servers()
}

pub async fn list_marketplaces() -> Result<Vec<McpMarketplaceProvider>, McpError> {
    Ok(vec![McpMarketplaceProvider {
        id: MARKETPLACE_SMITHERY.to_string(),
        name: "Smithery".to_string(),
        description: "smithery.ai MCP 服务器市场".to_string(),
    }])
}

pub async fn search_marketplace(
    provider_id: String,
    query: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<McpMarketplaceItem>, McpError> {
    let q = query.unwrap_or_default();
    let max = limit.unwrap_or(30).clamp(1, 100);
    match provider_id.as_str() {
        MARKETPLACE_SMITHERY => search_smithery(&q, max).await,
        _ => Err(bad(format!(
            "unsupported marketplace provider: {provider_id}"
        ))),
    }
}

pub async fn get_marketplace_server_detail(
    provider_id: String,
    server_id: String,
) -> Result<McpMarketplaceServerDetail, McpError> {
    match provider_id.as_str() {
        MARKETPLACE_SMITHERY => {
            let detail = fetch_smithery_server_detail(&server_id).await?;
            let summary = fetch_smithery_server_summary(&server_id).await;
            let install_options = build_smithery_install_options(&detail)?;
            let default_option = select_default_install_option(&install_options);
            let spec = default_option
                .map(|item| item.spec.clone())
                .ok_or_else(|| {
                    not_found(format!(
                        "smithery server '{}' does not provide installable connection info",
                        detail.qualified_name
                    ))
                })?;
            Ok(McpMarketplaceServerDetail {
                provider_id: MARKETPLACE_SMITHERY.to_string(),
                server_id: detail.qualified_name.clone(),
                name: detail.display_name.clone(),
                description: clean_opt(detail.description.clone())
                    .or_else(|| {
                        summary
                            .as_ref()
                            .and_then(|s| clean_opt(s.description.clone()))
                    })
                    .unwrap_or_else(|| "No description".to_string()),
                homepage: clean_opt(detail.homepage.clone())
                    .or_else(|| summary.as_ref().and_then(|s| clean_opt(s.homepage.clone()))),
                remote: detail.remote,
                verified: detail.verified || summary.as_ref().map(|s| s.verified).unwrap_or(false),
                icon_url: clean_opt(detail.icon_url.clone())
                    .or_else(|| summary.as_ref().and_then(|s| clean_opt(s.icon_url.clone()))),
                latest_version: None,
                protocols: collect_protocols_from_options(&install_options),
                owner: clean_opt(detail.owner.clone())
                    .or_else(|| summary.as_ref().and_then(|s| clean_opt(s.owner.clone()))),
                namespace: clean_opt(detail.namespace.clone()).or_else(|| {
                    summary
                        .as_ref()
                        .and_then(|s| clean_opt(s.namespace.clone()))
                }),
                downloads: detail
                    .use_count
                    .or_else(|| summary.as_ref().and_then(|s| s.use_count)),
                score: detail
                    .score
                    .or_else(|| summary.as_ref().and_then(|s| s.score)),
                is_deployed: detail
                    .is_deployed
                    .or_else(|| summary.as_ref().and_then(|s| s.is_deployed)),
                default_option_id: default_option.map(|item| item.id.clone()),
                install_options,
                spec,
            })
        }
        _ => Err(bad(format!(
            "unsupported marketplace provider: {provider_id}"
        ))),
    }
}

pub async fn install_marketplace_server(
    provider_id: String,
    server_id: String,
    global: bool,
    apps: Vec<McpAppType>,
    option_id: Option<String>,
    parameter_values: Option<Value>,
    spec_override: Option<Value>,
) -> Result<Vec<LocalMcpServer>, McpError> {
    let values: Map<String, Value> = parameter_values
        .as_ref()
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let spec = if let Some(raw_spec) = spec_override.as_ref() {
        canonicalize_spec(raw_spec, "marketplace install override")?
    } else {
        match provider_id.as_str() {
            MARKETPLACE_SMITHERY => {
                let detail = fetch_smithery_server_detail(&server_id).await?;
                resolve_smithery_install_spec(&detail, &option_id, &values)?
            }
            _ => {
                return Err(bad(format!(
                    "unsupported marketplace provider: {provider_id}"
                )));
            }
        }
    };

    install_targets(&server_id, &spec, global, &apps)?;
    scan_local_servers()
}

pub async fn upsert_local_server(
    server_id: String,
    spec: Value,
    global: bool,
    apps: Vec<McpAppType>,
) -> Result<Vec<LocalMcpServer>, McpError> {
    if server_id.trim().is_empty() {
        return Err(bad("服务器 ID 不能为空"));
    }
    if !global && apps.is_empty() {
        return Err(bad("请至少选择一个目标应用（或勾选全局）"));
    }
    let canonical = canonicalize_spec(&spec, "local MCP save")?;
    set_targets(server_id.trim(), &canonical, global, &apps)?;
    scan_local_servers()
}

pub async fn uninstall_server(server_id: String) -> Result<Vec<LocalMcpServer>, McpError> {
    uninstall_everywhere(&server_id)?;
    scan_local_servers()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalizes_http_spec_and_infers_type() {
        let spec = json!({ "url": "https://example.com/mcp" });
        let canonical = canonicalize_spec(&spec, "test").expect("http spec");
        assert_eq!(canonical.get("type").and_then(Value::as_str), Some("http"));
        assert_eq!(
            canonical.get("url").and_then(Value::as_str),
            Some("https://example.com/mcp")
        );
    }

    #[test]
    fn canonicalizes_streamable_http_alias() {
        let spec = json!({ "type": "streamable-http", "url": "https://x/mcp" });
        let canonical = canonicalize_spec(&spec, "test").expect("alias");
        assert_eq!(canonical.get("type").and_then(Value::as_str), Some("http"));
    }

    #[test]
    fn codex_roundtrip_preserves_http_headers() {
        let spec = json!({
            "type": "http",
            "url": "https://x/mcp",
            "headers": { "Authorization": "Bearer t" }
        });
        let entry = canonical_to_codex_entry(&spec).expect("to codex");
        let back = codex_entry_to_canonical("ex", &entry).expect("from codex");
        assert_eq!(back.get("type").and_then(Value::as_str), Some("http"));
        assert_eq!(
            back.pointer("/headers/Authorization")
                .and_then(Value::as_str),
            Some("Bearer t")
        );
    }

    #[test]
    fn hermes_roundtrip_marks_sse_transport() {
        let spec = json!({ "type": "sse", "url": "https://x/sse" });
        let entry = canonical_to_hermes_entry(&spec).expect("to hermes");
        let yaml = serde_yaml::to_string(&entry).expect("yaml");
        assert!(yaml.contains("transport: sse"), "yaml: {yaml}");
    }

    #[test]
    fn append_query_param_encodes_and_picks_separator() {
        assert_eq!(
            append_query_param("https://x/mcp", "a b", "c&d"),
            "https://x/mcp?a%20b=c%26d"
        );
        assert_eq!(
            append_query_param("https://x/mcp?z=1", "a", "b"),
            "https://x/mcp?z=1&a=b"
        );
    }

    #[test]
    fn opencode_local_command_array_roundtrips() {
        let spec = json!({ "type": "stdio", "command": "npx", "args": ["-y", "pkg"] });
        let oc = canonical_to_opencode_spec(&spec).expect("to opencode");
        assert_eq!(oc.get("type").and_then(Value::as_str), Some("local"));
        let back = canonicalize_opencode_spec(&oc, "test").expect("from opencode");
        assert_eq!(back.get("command").and_then(Value::as_str), Some("npx"));
        assert_eq!(back.pointer("/args/1").and_then(Value::as_str), Some("pkg"));
    }
}
