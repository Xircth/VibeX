//! MCP marketplace + per-agent native configuration.
//!
//! "Global" means writing an entry to every compatible agent's native MCP
//! config file (Claude `~/.claude.json`, Codex `~/.codex/config.toml`, Hermes
//! `~/.hermes/config.yaml`, …). VibeX does not keep a separate registry.
//!
//! All server specs are stored in a single canonical JSON shape
//! (`{type: "stdio"|"http"|"sse", …}`); per-agent writers translate that to
//! each agent's native format (TOML for Codex, YAML for Hermes, the
//! `local`/`remote` variant for OpenCode).

use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs,
    future::Future,
    path::{Path, PathBuf},
    sync::LazyLock,
    time::Duration,
};

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Map, Value, json};

mod error;
pub use error::McpError;

const MARKETPLACE_SMITHERY: &str = "smithery";
const MARKETPLACE_OFFICIAL: &str = "official_registry";

tokio::task_local! {
    static SAVED_AGENT_ENVIRONMENT: HashMap<String, String>;
}

pub async fn with_saved_agent_environment<F>(
    environment: HashMap<String, String>,
    future: F,
) -> F::Output
where
    F: Future,
{
    SAVED_AGENT_ENVIRONMENT.scope(environment, future).await
}

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
    #[serde(rename = "antigravity", alias = "gemini")]
    Antigravity,
    #[serde(rename = "openclaw", alias = "open_claw")]
    OpenClaw,
    #[serde(rename = "opencode", alias = "open_code")]
    OpenCode,
    Cline,
    Hermes,
    #[serde(rename = "codebuddy", alias = "code_buddy")]
    CodeBuddy,
    KimiCode,
    Grok,
    Cursor,
}

const ALL_APPS: [McpAppType; 11] = [
    McpAppType::ClaudeCode,
    McpAppType::Codex,
    McpAppType::Antigravity,
    McpAppType::OpenClaw,
    McpAppType::OpenCode,
    McpAppType::Cline,
    McpAppType::Hermes,
    McpAppType::CodeBuddy,
    McpAppType::KimiCode,
    McpAppType::Grok,
    McpAppType::Cursor,
];

/// Targets that Codeg exposes for new MCP assignments. OpenClaw remains in
/// `ALL_APPS` so legacy entries can be scanned and removed, but is not offered
/// for new assignments because its ACP implementation rejects MCP entries.
const ASSIGNABLE_APPS: [McpAppType; 10] = [
    McpAppType::ClaudeCode,
    McpAppType::Codex,
    McpAppType::Antigravity,
    McpAppType::OpenCode,
    McpAppType::Cline,
    McpAppType::Hermes,
    McpAppType::CodeBuddy,
    McpAppType::KimiCode,
    McpAppType::Grok,
    McpAppType::Cursor,
];

#[derive(Debug, Clone, Serialize)]
pub struct LocalMcpServer {
    pub id: String,
    pub spec: Value,
    /// Whether this server is present in every compatible agent config.
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

async fn send_request(
    context: &str,
    request: reqwest::RequestBuilder,
) -> Result<reqwest::Response, McpError> {
    request
        .send()
        .await
        .map_err(|err| internal(format!("{context}: {err}")))
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
// Marketplace API response shapes
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct OfficialServerResponse {
    server: OfficialServer,
    #[serde(default, rename = "_meta")]
    meta: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct OfficialServer {
    name: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default, rename = "websiteUrl")]
    website_url: Option<String>,
    #[serde(default)]
    repository: Option<OfficialRepository>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    icons: Option<Vec<OfficialIcon>>,
    #[serde(default)]
    remotes: Option<Vec<OfficialTransport>>,
    #[serde(default)]
    packages: Option<Vec<OfficialPackage>>,
}

#[derive(Debug, Deserialize)]
struct OfficialRepository {
    #[serde(default)]
    url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OfficialIcon {
    #[serde(default)]
    src: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OfficialTransport {
    #[serde(default)]
    r#type: String,
    #[serde(default)]
    url: Option<String>,
    #[serde(default, deserialize_with = "deserialize_official_inputs")]
    headers: Option<Vec<OfficialInput>>,
    #[serde(default, deserialize_with = "deserialize_official_inputs")]
    variables: Option<Vec<OfficialInput>>,
}

#[derive(Debug, Deserialize)]
struct OfficialPackage {
    #[serde(default, rename = "registryType")]
    registry_type: String,
    identifier: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default, rename = "runtimeHint")]
    runtime_hint: Option<String>,
    #[serde(default, rename = "runtimeArguments")]
    runtime_arguments: Vec<OfficialArgument>,
    #[serde(default, rename = "packageArguments")]
    package_arguments: Vec<OfficialArgument>,
    #[serde(default, rename = "environmentVariables")]
    environment_variables: Vec<OfficialInput>,
    transport: OfficialTransport,
}

#[derive(Debug, Deserialize)]
struct OfficialArgument {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    r#type: Option<String>,
    #[serde(default)]
    value: Option<String>,
    #[serde(default)]
    default: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    format: Option<String>,
    #[serde(default, rename = "isRequired")]
    is_required: Option<bool>,
    #[serde(default, rename = "valueHint")]
    value_hint: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OfficialInput {
    name: String,
    #[serde(default)]
    value: Option<String>,
    #[serde(default)]
    default: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    format: Option<String>,
    #[serde(default, rename = "isRequired")]
    is_required: Option<bool>,
    #[serde(default, rename = "isSecret")]
    is_secret: Option<bool>,
    #[serde(default, rename = "valueHint")]
    value_hint: Option<String>,
}

fn deserialize_official_inputs<'de, D>(
    deserializer: D,
) -> Result<Option<Vec<OfficialInput>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let Some(value) = Option::<Value>::deserialize(deserializer)? else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    if let Some(items) = value.as_array() {
        let parsed = items
            .iter()
            .filter_map(|item| serde_json::from_value(item.clone()).ok())
            .collect::<Vec<_>>();
        return Ok((!parsed.is_empty()).then_some(parsed));
    }
    let Some(map) = value.as_object() else {
        return Ok(None);
    };
    let mut parsed = Vec::new();
    for (name, raw) in map {
        if name.trim().is_empty() {
            continue;
        }
        let mut input = OfficialInput {
            name: name.trim().to_string(),
            value: raw.as_str().map(str::to_string),
            default: None,
            description: None,
            format: None,
            is_required: None,
            is_secret: None,
            value_hint: None,
        };
        if let Some(obj) = raw.as_object() {
            input.value = obj.get("value").and_then(Value::as_str).map(str::to_string);
            input.default = obj
                .get("default")
                .and_then(Value::as_str)
                .map(str::to_string);
            input.description = obj
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_string);
            input.format = obj
                .get("format")
                .and_then(Value::as_str)
                .map(str::to_string);
            input.is_required = obj.get("isRequired").and_then(Value::as_bool);
            input.is_secret = obj.get("isSecret").and_then(Value::as_bool);
            input.value_hint = obj
                .get("valueHint")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        parsed.push(input);
    }
    Ok((!parsed.is_empty()).then_some(parsed))
}

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

fn configured_value(variable: &str) -> Option<String> {
    SAVED_AGENT_ENVIRONMENT
        .try_with(|environment| environment.get(variable).cloned())
        .ok()
        .flatten()
        .or_else(|| std::env::var(variable).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn configured_dir(variable: &str, fallback: PathBuf) -> PathBuf {
    let Some(raw) = configured_value(variable) else {
        return fallback;
    };
    let value = raw.trim();
    if value.is_empty() {
        return fallback;
    }
    if value == "~" {
        return home_dir_or_default();
    }
    if let Some(rest) = value.strip_prefix("~/") {
        return home_dir_or_default().join(rest);
    }
    PathBuf::from(value)
}

fn codex_home_dir() -> PathBuf {
    let configured = configured_value("CODEX_HOME");

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
    agents::metadata::opencode_config_dir()
        .unwrap_or_else(|| home_dir_or_default().join(".config").join("opencode"))
        .join("opencode.json")
}

fn antigravity_config_path() -> PathBuf {
    configured_dir("GEMINI_HOME", home_dir_or_default().join(".gemini"))
        .join("config")
        .join("mcp_config.json")
}

fn openclaw_config_path() -> PathBuf {
    configured_dir("OPENCLAW_HOME", home_dir_or_default().join(".openclaw")).join("openclaw.json")
}

fn cline_config_path() -> PathBuf {
    configured_dir(
        "CLINE_DIR",
        home_dir_or_default().join(".cline").join("data"),
    )
    .join("settings")
    .join("cline_mcp_settings.json")
}

fn hermes_home_dir() -> PathBuf {
    configured_dir("HERMES_HOME", home_dir_or_default().join(".hermes"))
}

fn hermes_config_yaml_path() -> PathBuf {
    hermes_home_dir().join("config.yaml")
}

fn codebuddy_config_path() -> PathBuf {
    home_dir_or_default().join(".codebuddy.json")
}

fn codebuddy_settings_path() -> PathBuf {
    configured_dir(
        "CODEBUDDY_CONFIG_DIR",
        home_dir_or_default().join(".codebuddy"),
    )
    .join("settings.json")
}

fn kimi_code_mcp_json_path() -> PathBuf {
    configured_dir("KIMI_CODE_HOME", home_dir_or_default().join(".kimi-code")).join("mcp.json")
}

fn grok_config_toml_path() -> PathBuf {
    configured_dir("GROK_HOME", home_dir_or_default().join(".grok")).join("config.toml")
}

fn cursor_mcp_json_path() -> PathBuf {
    // Cursor's CLI hard-codes the user MCP file even when its chat/config roots
    // are relocated with CURSOR_CONFIG_DIR or XDG_CONFIG_HOME.
    home_dir_or_default().join(".cursor").join("mcp.json")
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

fn contains_unresolved_placeholder(value: &str) -> bool {
    (value.contains('{') && value.contains('}')) || value.contains("${") || value.contains("<YOUR_")
}

fn official_input_default(item: &OfficialInput) -> Option<String> {
    item.value
        .as_deref()
        .or(item.default.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty() && !contains_unresolved_placeholder(value))
        .map(str::to_string)
}

fn official_input_required(item: &OfficialInput) -> bool {
    item.is_required.unwrap_or(false)
        || item
            .value
            .as_deref()
            .is_some_and(contains_unresolved_placeholder)
        || item
            .default
            .as_deref()
            .is_some_and(contains_unresolved_placeholder)
        || official_input_default(item).is_none()
}

fn infer_parameter_kind(format: Option<&str>) -> String {
    match format.map(str::trim).unwrap_or("string") {
        "boolean" => "boolean",
        "number" => "number",
        "integer" => "integer",
        "object" | "array" => "json",
        _ => "string",
    }
    .to_string()
}

fn official_text_to_value(kind: &str, value: &str) -> Value {
    match kind {
        "boolean" => Value::Bool(value.trim().eq_ignore_ascii_case("true")),
        "integer" => value
            .trim()
            .parse::<i64>()
            .map(|number| Value::Number(number.into()))
            .unwrap_or_else(|_| Value::String(value.trim().to_string())),
        "number" => value
            .trim()
            .parse::<f64>()
            .ok()
            .and_then(serde_json::Number::from_f64)
            .map(Value::Number)
            .unwrap_or_else(|| Value::String(value.trim().to_string())),
        _ => Value::String(value.trim().to_string()),
    }
}

struct OfficialParameter<'a> {
    key: String,
    label: String,
    description: Option<&'a str>,
    required: bool,
    secret: bool,
    kind: String,
    default: Option<String>,
    placeholder: Option<&'a str>,
    location: &'a str,
}

fn official_parameter(parameter: OfficialParameter<'_>) -> McpMarketplaceInstallParameter {
    let OfficialParameter {
        key,
        label,
        description,
        required,
        secret,
        kind,
        default,
        placeholder,
        location,
    } = parameter;
    McpMarketplaceInstallParameter {
        key,
        label,
        description: description
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        required,
        secret,
        default_value: default
            .as_deref()
            .map(|value| official_text_to_value(&kind, value)),
        placeholder: placeholder
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        kind,
        enum_values: Vec::new(),
        location: Some(location.to_string()),
    }
}

fn official_remote_parameter_fields(
    transport: &OfficialTransport,
) -> Vec<McpMarketplaceInstallParameter> {
    let mut fields = Vec::new();
    for (location, prefix, items) in [
        ("header", "headers", transport.headers.as_deref()),
        ("query", "variables", transport.variables.as_deref()),
    ] {
        for item in items.unwrap_or_default() {
            let name = item.name.trim();
            if name.is_empty() {
                continue;
            }
            fields.push(official_parameter(OfficialParameter {
                key: format!("{prefix}.{name}"),
                label: name.to_string(),
                description: item.description.as_deref(),
                required: official_input_required(item),
                secret: item.is_secret.unwrap_or(false) || key_looks_secret(name),
                kind: infer_parameter_kind(item.format.as_deref()),
                default: official_input_default(item),
                placeholder: item.value_hint.as_deref(),
                location,
            }));
        }
    }
    fields
}

fn read_parameter(values: &Map<String, Value>, key: &str) -> Option<String> {
    values.get(key).and_then(value_as_text)
}

fn resolve_official_remote(
    transport: &OfficialTransport,
    values: &Map<String, Value>,
    enforce_required: bool,
) -> Result<Value, McpError> {
    let typ = match normalize_mcp_type(&transport.r#type) {
        Some(typ @ ("http" | "sse")) => typ,
        _ => return Err(bad(format!("unsupported transport '{}'", transport.r#type))),
    };
    let mut url = transport
        .url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| bad("official remote transport is missing a URL"))?
        .to_string();
    for item in transport.variables.as_deref().unwrap_or_default() {
        let name = item.name.trim();
        if name.is_empty() {
            continue;
        }
        let value = read_parameter(values, &format!("variables.{name}"))
            .or_else(|| official_input_default(item));
        if let Some(value) = value {
            let encoded = encode_query_component(&value);
            let brace = format!("{{{name}}}");
            let moustache = format!("{{{{{name}}}}}");
            if url.contains(&moustache) {
                url = url.replace(&moustache, &encoded);
            } else if url.contains(&brace) {
                url = url.replace(&brace, &encoded);
            } else {
                url = append_query_param(&url, name, &value);
            }
        } else if enforce_required && official_input_required(item) {
            return Err(bad(format!("missing required variable '{name}'")));
        }
    }
    let mut headers = Map::new();
    for item in transport.headers.as_deref().unwrap_or_default() {
        let name = item.name.trim();
        if name.is_empty() {
            continue;
        }
        let value = read_parameter(values, &format!("headers.{name}"))
            .or_else(|| official_input_default(item));
        if let Some(value) = value {
            headers.insert(name.to_string(), Value::String(value));
        } else if enforce_required && official_input_required(item) {
            return Err(bad(format!("missing required header '{name}'")));
        }
    }
    canonicalize_spec(
        &json!({
            "type": typ,
            "url": url,
            "headers": headers,
        }),
        "official remote transport",
    )
}

fn argument_default(argument: &OfficialArgument) -> Option<String> {
    argument
        .value
        .as_deref()
        .or(argument.default.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty() && !contains_unresolved_placeholder(value))
        .map(str::to_string)
}

fn append_official_argument(
    target: &mut Vec<String>,
    argument: &OfficialArgument,
    scope: &str,
    index: usize,
    values: &Map<String, Value>,
    enforce_required: bool,
) -> Result<(), McpError> {
    let value =
        read_parameter(values, &format!("{scope}.{index}")).or_else(|| argument_default(argument));
    let named = argument.r#type.as_deref().map(str::trim) == Some("named");
    if named {
        let Some(name) = argument
            .name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return Ok(());
        };
        if let Some(value) = value {
            target.extend([name.to_string(), value]);
        } else if enforce_required && argument.is_required.unwrap_or(false) {
            return Err(bad(format!("missing required argument '{name}'")));
        }
    } else if let Some(value) = value {
        target.push(value);
    } else if enforce_required && argument.is_required.unwrap_or(false) {
        return Err(bad(format!(
            "missing required argument '{}'",
            argument.name.as_deref().unwrap_or("positional")
        )));
    }
    Ok(())
}

fn official_stdio_parameter_fields(
    package: &OfficialPackage,
) -> Vec<McpMarketplaceInstallParameter> {
    let mut fields = Vec::new();
    for (scope, arguments) in [
        ("runtime_arguments", package.runtime_arguments.as_slice()),
        ("package_arguments", package.package_arguments.as_slice()),
    ] {
        for (index, argument) in arguments.iter().enumerate() {
            let label = argument
                .name
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("argument {}", index + 1));
            fields.push(official_parameter(OfficialParameter {
                key: format!("{scope}.{index}"),
                label,
                description: argument.description.as_deref(),
                required: argument.is_required.unwrap_or(false),
                secret: false,
                kind: infer_parameter_kind(argument.format.as_deref()),
                default: argument_default(argument),
                placeholder: argument.value_hint.as_deref(),
                location: "arg",
            }));
        }
    }
    for item in &package.environment_variables {
        let name = item.name.trim();
        if name.is_empty() {
            continue;
        }
        fields.push(official_parameter(OfficialParameter {
            key: format!("env.{name}"),
            label: name.to_string(),
            description: item.description.as_deref(),
            required: official_input_required(item),
            secret: item.is_secret.unwrap_or(false) || key_looks_secret(name),
            kind: infer_parameter_kind(item.format.as_deref()),
            default: official_input_default(item),
            placeholder: item.value_hint.as_deref(),
            location: "env",
        }));
    }
    fields
}

fn resolve_official_package(
    package: &OfficialPackage,
    values: &Map<String, Value>,
    enforce_required: bool,
) -> Result<Value, McpError> {
    let runtime = package
        .runtime_hint
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| match package.registry_type.trim() {
            "npm" => Some("npx".to_string()),
            "pypi" => Some("uvx".to_string()),
            _ => None,
        })
        .ok_or_else(|| bad(format!("package '{}' has no runtime", package.identifier)))?;
    let mut args = Vec::new();
    if runtime == "npx" {
        args.push("-y".to_string());
    }
    for (index, argument) in package.runtime_arguments.iter().enumerate() {
        append_official_argument(
            &mut args,
            argument,
            "runtime_arguments",
            index,
            values,
            enforce_required,
        )?;
    }
    let identifier = package.identifier.trim();
    if identifier.is_empty() {
        return Err(bad("official package identifier is empty"));
    }
    let version = package
        .version
        .as_deref()
        .map(str::trim)
        .filter(|version| !version.is_empty() && *version != "latest");
    let package_spec = match (runtime.as_str(), package.registry_type.trim(), version) {
        ("uvx", "pypi", Some(version)) => format!("{identifier}=={version}"),
        ("npx", _, Some(version))
            if !identifier.contains('@') && !identifier.starts_with("http") =>
        {
            format!("{identifier}@{version}")
        }
        _ => identifier.to_string(),
    };
    args.push(package_spec);
    for (index, argument) in package.package_arguments.iter().enumerate() {
        append_official_argument(
            &mut args,
            argument,
            "package_arguments",
            index,
            values,
            enforce_required,
        )?;
    }
    let mut env = Map::new();
    for item in &package.environment_variables {
        let name = item.name.trim();
        if name.is_empty() {
            continue;
        }
        let value =
            read_parameter(values, &format!("env.{name}")).or_else(|| official_input_default(item));
        if let Some(value) = value {
            env.insert(name.to_string(), Value::String(value));
        } else if enforce_required && official_input_required(item) {
            return Err(bad(format!(
                "missing required environment variable '{name}'"
            )));
        }
    }
    canonicalize_spec(
        &json!({
            "type": "stdio",
            "command": runtime,
            "args": args,
            "env": env,
        }),
        "official package",
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

    let has_command = table.get("command").is_some();
    let has_url = table.get("url").is_some();
    if has_command == has_url {
        return Err(bad(format!(
            "Codex MCP entry '{id}' must contain exactly one of command or url"
        )));
    }
    let raw_type = table
        .get("type")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(if has_url { "http" } else { "stdio" })
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
            if let Some(cwd) = table
                .get("cwd")
                .and_then(toml::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                spec.insert("cwd".to_string(), Value::String(cwd.to_string()));
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
    if typ == "sse" {
        return Err(bad(
            "Codex conversion: SSE is unsupported; use streamable HTTP instead",
        ));
    }

    let mut table = toml::map::Map::new();
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
            if let Some(cwd) = obj.get("cwd").and_then(Value::as_str) {
                table.insert("cwd".to_string(), toml::Value::String(cwd.to_string()));
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

    // Codex strict config rejects foreign or incorrectly typed fields. Only
    // pass through the two transport-independent RawMcpServerConfig booleans.
    for (key, value) in obj {
        if matches!(key.as_str(), "enabled" | "required")
            && value.is_boolean()
            && let Some(converted) = json_to_toml_value(value)
        {
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

fn kimi_code_entry_to_canonical(spec: &Value, id: &str) -> Result<Value, McpError> {
    let Some(obj) = spec.as_object() else {
        return canonicalize_spec(spec, "Kimi Code config");
    };
    let mut obj = obj.clone();
    obj.remove("type");
    if obj.contains_key("transport") {
        let canonical_type = match obj.get("transport").and_then(Value::as_str) {
            Some("stdio") => "stdio",
            Some("http") => "http",
            Some("sse") => "sse",
            other => {
                return Err(bad(format!(
                    "Kimi Code config '{id}': unsupported transport '{}'",
                    other.unwrap_or("<non-string>")
                )));
            }
        };
        obj.insert(
            "type".to_string(),
            Value::String(canonical_type.to_string()),
        );
    }
    obj.remove("transport");
    canonicalize_spec(&Value::Object(obj), &format!("Kimi Code config '{id}'"))
}

fn canonical_to_kimi_code_entry(spec: &Value) -> Result<Value, McpError> {
    let canonical = canonicalize_spec(spec, "Kimi Code write")?;
    let obj = canonical
        .as_object()
        .ok_or_else(|| bad("Kimi Code write: canonical spec must be an object"))?;
    let transport = match obj.get("type").and_then(Value::as_str) {
        Some("http") => Some("http"),
        Some("sse") => Some("sse"),
        _ => None,
    };
    let mut out = Map::new();
    for (key, value) in obj {
        let keep = match key.as_str() {
            "type" | "command" | "args" | "env" | "cwd" | "url" | "headers" => true,
            "enabled" => value.is_boolean(),
            _ => false,
        };
        if keep {
            out.insert(key.clone(), value.clone());
        }
    }
    if let Some(transport) = transport {
        out.insert(
            "transport".to_string(),
            Value::String(transport.to_string()),
        );
    }
    Ok(Value::Object(out))
}

fn canonical_to_grok_entry(spec: &Value) -> Result<toml::Value, McpError> {
    let canonical = canonicalize_spec(spec, "Grok conversion")?;
    let obj = canonical
        .as_object()
        .ok_or_else(|| bad("Grok conversion: canonical spec must be an object"))?;
    let typ = obj.get("type").and_then(Value::as_str).unwrap_or("stdio");
    let mut table = toml::map::Map::new();

    match typ {
        "stdio" => {
            let command = obj
                .get("command")
                .and_then(Value::as_str)
                .ok_or_else(|| bad("Grok conversion: stdio MCP spec missing command"))?;
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
            if let Some(env) = obj_as_string_map(obj.get("env")) {
                let values = env
                    .into_iter()
                    .map(|(key, value)| {
                        let value = value.as_str().unwrap_or_default().to_string();
                        (key, toml::Value::String(value))
                    })
                    .collect();
                table.insert("env".to_string(), toml::Value::Table(values));
            }
            if let Some(cwd) = obj.get("cwd").and_then(Value::as_str) {
                table.insert("cwd".to_string(), toml::Value::String(cwd.to_string()));
            }
        }
        "http" | "sse" => {
            if typ == "sse" {
                table.insert("type".to_string(), toml::Value::String("sse".to_string()));
            }
            let url = obj
                .get("url")
                .and_then(Value::as_str)
                .ok_or_else(|| bad("Grok conversion: remote MCP spec missing url"))?;
            table.insert("url".to_string(), toml::Value::String(url.to_string()));
            if let Some(headers) = obj_as_string_map(obj.get("headers")) {
                let values = headers
                    .into_iter()
                    .map(|(key, value)| {
                        let value = value.as_str().unwrap_or_default().to_string();
                        (key, toml::Value::String(value))
                    })
                    .collect();
                table.insert("headers".to_string(), toml::Value::Table(values));
            }
        }
        other => {
            return Err(bad(format!(
                "Grok conversion: unsupported MCP type '{other}'"
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
        if let Some(value) = json_to_toml_value(value) {
            table.insert(key.clone(), value);
        }
    }
    Ok(toml::Value::Table(table))
}

fn grok_entry_to_canonical(id: &str, value: &toml::Value) -> Result<Value, McpError> {
    let table = value
        .as_table()
        .ok_or_else(|| bad(format!("Grok MCP entry '{id}' must be a table")))?;
    let explicit_type = table
        .get("type")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let has_url = table
        .get("url")
        .and_then(toml::Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    let is_remote = matches!(explicit_type, Some("http") | Some("sse"))
        || (has_url && explicit_type != Some("stdio"));
    let mut spec = Map::new();

    if is_remote {
        let typ = if explicit_type == Some("sse") {
            "sse"
        } else {
            "http"
        };
        spec.insert("type".to_string(), Value::String(typ.to_string()));
        if let Some(url) = table.get("url").and_then(toml::Value::as_str) {
            spec.insert("url".to_string(), Value::String(url.trim().to_string()));
        }
        if let Some(headers) = table.get("headers").and_then(toml::Value::as_table) {
            let headers = headers
                .iter()
                .filter_map(|(key, value)| {
                    value
                        .as_str()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(|value| (key.clone(), Value::String(value.to_string())))
                })
                .collect();
            spec.insert("headers".to_string(), Value::Object(headers));
        }
    } else {
        spec.insert("type".to_string(), Value::String("stdio".to_string()));
        if let Some(command) = table.get("command").and_then(toml::Value::as_str) {
            spec.insert(
                "command".to_string(),
                Value::String(command.trim().to_string()),
            );
        }
        if let Some(args) = table.get("args").and_then(toml::Value::as_array) {
            let args = args
                .iter()
                .filter_map(toml::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| Value::String(value.to_string()))
                .collect();
            spec.insert("args".to_string(), Value::Array(args));
        }
        if let Some(env) = table.get("env").and_then(toml::Value::as_table) {
            let env = env
                .iter()
                .filter_map(|(key, value)| {
                    value
                        .as_str()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(|value| (key.clone(), Value::String(value.to_string())))
                })
                .collect();
            spec.insert("env".to_string(), Value::Object(env));
        }
        if let Some(cwd) = table.get("cwd").and_then(toml::Value::as_str) {
            spec.insert("cwd".to_string(), Value::String(cwd.trim().to_string()));
        }
    }
    for (key, value) in table {
        if !matches!(
            key.as_str(),
            "type" | "command" | "args" | "env" | "cwd" | "url" | "headers"
        ) {
            spec.insert(key.clone(), toml_to_json_value(value));
        }
    }
    canonicalize_spec(&Value::Object(spec), "Grok config")
}

fn canonical_to_cursor_entry(spec: &Value) -> Result<Value, McpError> {
    let canonical = canonicalize_spec(spec, "Cursor write")?;
    let obj = canonical
        .as_object()
        .ok_or_else(|| bad("Cursor write: canonical spec must be an object"))?;
    let out = obj
        .iter()
        .filter(|(key, _)| {
            matches!(
                key.as_str(),
                "command" | "args" | "env" | "cwd" | "url" | "headers"
            )
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    Ok(Value::Object(out))
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
    if let Some(legacy) = table
        .get("mcp")
        .and_then(toml::Value::as_table)
        .and_then(|mcp| mcp.get("servers"))
        .and_then(toml::Value::as_table)
    {
        for (id, spec) in legacy {
            if out.contains_key(id) {
                continue;
            }
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
    if let Some(legacy_mcp) = table.get_mut("mcp").and_then(toml::Value::as_table_mut) {
        if let Some(legacy_servers) = legacy_mcp
            .get_mut("servers")
            .and_then(toml::Value::as_table_mut)
        {
            legacy_servers.remove(id);
            if legacy_servers.is_empty() {
                legacy_mcp.remove("servers");
            }
        }
        if legacy_mcp.is_empty() {
            table.remove("mcp");
        }
    }
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
    if let Some(legacy_mcp) = table.get_mut("mcp").and_then(toml::Value::as_table_mut) {
        if let Some(legacy_servers) = legacy_mcp
            .get_mut("servers")
            .and_then(toml::Value::as_table_mut)
        {
            removed |= legacy_servers.remove(id).is_some();
            if legacy_servers.is_empty() {
                legacy_mcp.remove("servers");
            }
        }
        if legacy_mcp.is_empty() {
            table.remove("mcp");
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

fn read_antigravity_servers() -> Result<BTreeMap<String, Value>, McpError> {
    let root = read_json_file(&antigravity_config_path())?;
    let mut out = BTreeMap::new();
    let Some(servers) = root.get("mcpServers").and_then(Value::as_object) else {
        return Ok(out);
    };
    for (id, spec) in servers {
        if let Ok(normalized) = canonicalize_spec(spec, "Antigravity config") {
            out.insert(id.to_string(), normalized);
        }
    }
    Ok(out)
}

fn upsert_antigravity_server(id: &str, spec: &Value) -> Result<(), McpError> {
    let path = antigravity_config_path();
    let mut root = read_json_file(&path)?;
    if !root.is_object() {
        root = json!({});
    }
    let canonical = canonicalize_spec(spec, "Antigravity write")?;
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

fn remove_antigravity_server(id: &str) -> Result<bool, McpError> {
    let path = antigravity_config_path();
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
    let canonical = canonical_to_cline_entry(spec)?;
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

fn canonical_to_cline_entry(spec: &Value) -> Result<Value, McpError> {
    let mut canonical = canonicalize_spec(spec, "Cline write")?;
    if canonical.get("type").and_then(Value::as_str) == Some("http") {
        canonical["type"] = Value::String("streamableHttp".to_string());
    }
    Ok(canonical)
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

fn read_codebuddy_servers() -> Result<BTreeMap<String, Value>, McpError> {
    let root = read_json_file(&codebuddy_config_path())?;
    let mut out = BTreeMap::new();
    let Some(servers) = root.get("mcpServers").and_then(Value::as_object) else {
        return Ok(out);
    };
    for (id, spec) in servers {
        if let Ok(spec) = canonicalize_spec(spec, "CodeBuddy config") {
            out.insert(id.clone(), spec);
        }
    }
    Ok(out)
}

fn set_codebuddy_local_plugin(id: &str, enabled: bool) -> Result<(), McpError> {
    let path = codebuddy_settings_path();
    if !enabled && !path.exists() {
        return Ok(());
    }
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
        if !enabled {
            return Ok(());
        }
        obj.insert("enabledPlugins".to_string(), Value::Object(Map::new()));
    }
    let plugins = obj
        .get_mut("enabledPlugins")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| bad(format!("invalid enabledPlugins in {}", path.display())))?;
    let key = claude_local_plugin_key(id);
    let changed = if enabled {
        plugins.insert(key, Value::Bool(true)) != Some(Value::Bool(true))
    } else {
        plugins.remove(&key).is_some()
    };
    if changed {
        write_json_file(&path, &root)?;
    }
    Ok(())
}

fn upsert_codebuddy_server(id: &str, spec: &Value) -> Result<(), McpError> {
    let path = codebuddy_config_path();
    let mut root = read_json_file(&path)?;
    if !root.is_object() {
        root = json!({});
    }
    let canonical = canonicalize_spec(spec, "CodeBuddy write")?;
    let obj = root
        .as_object_mut()
        .ok_or_else(|| bad(format!("invalid JSON root in {}", path.display())))?;
    if !obj.get("mcpServers").map(Value::is_object).unwrap_or(false) {
        obj.insert("mcpServers".to_string(), Value::Object(Map::new()));
    }
    obj.get_mut("mcpServers")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| bad(format!("invalid mcpServers in {}", path.display())))?
        .insert(id.to_string(), canonical);
    write_json_file(&path, &root)?;
    set_codebuddy_local_plugin(id, true)
}

fn remove_codebuddy_server(id: &str) -> Result<bool, McpError> {
    let path = codebuddy_config_path();
    let removed = if path.exists() {
        let mut root = read_json_file(&path)?;
        let removed = root
            .get_mut("mcpServers")
            .and_then(Value::as_object_mut)
            .is_some_and(|servers| servers.remove(id).is_some());
        if removed {
            write_json_file(&path, &root)?;
        }
        removed
    } else {
        false
    };
    set_codebuddy_local_plugin(id, false)?;
    Ok(removed)
}

fn read_kimi_code_servers_at(path: &Path) -> Result<BTreeMap<String, Value>, McpError> {
    let root = read_json_file(path)?;
    let mut out = BTreeMap::new();
    let Some(servers) = root.get("mcpServers").and_then(Value::as_object) else {
        return Ok(out);
    };
    for (id, spec) in servers {
        if let Ok(spec) = kimi_code_entry_to_canonical(spec, id) {
            out.insert(id.clone(), spec);
        }
    }
    Ok(out)
}

fn read_kimi_code_servers() -> Result<BTreeMap<String, Value>, McpError> {
    read_kimi_code_servers_at(&kimi_code_mcp_json_path())
}

fn upsert_kimi_code_server_at(path: &Path, id: &str, spec: &Value) -> Result<(), McpError> {
    let mut root = read_json_file(path)?;
    if !root.is_object() {
        root = json!({});
    }
    let entry = canonical_to_kimi_code_entry(spec)?;
    let obj = root
        .as_object_mut()
        .ok_or_else(|| bad(format!("invalid JSON root in {}", path.display())))?;
    if !obj.get("mcpServers").map(Value::is_object).unwrap_or(false) {
        obj.insert("mcpServers".to_string(), Value::Object(Map::new()));
    }
    obj.get_mut("mcpServers")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| bad(format!("invalid mcpServers in {}", path.display())))?
        .insert(id.to_string(), entry);
    write_json_file(path, &root)
}

fn upsert_kimi_code_server(id: &str, spec: &Value) -> Result<(), McpError> {
    upsert_kimi_code_server_at(&kimi_code_mcp_json_path(), id, spec)
}

fn remove_json_mcp_server_at(path: &Path, id: &str) -> Result<bool, McpError> {
    if !path.exists() {
        return Ok(false);
    }
    let mut root = read_json_file(path)?;
    let removed = root
        .get_mut("mcpServers")
        .and_then(Value::as_object_mut)
        .is_some_and(|servers| servers.remove(id).is_some());
    if removed {
        write_json_file(path, &root)?;
    }
    Ok(removed)
}

fn remove_kimi_code_server(id: &str) -> Result<bool, McpError> {
    remove_json_mcp_server_at(&kimi_code_mcp_json_path(), id)
}

fn read_grok_root_toml_at(path: &Path) -> Result<toml::Value, McpError> {
    if !path.exists() {
        return Ok(toml::Value::Table(toml::map::Map::new()));
    }
    let raw = fs::read_to_string(path).map_err(|error| internal(error.to_string()))?;
    let root = raw
        .parse::<toml::Value>()
        .map_err(|error| bad(format!("invalid TOML at {}: {error}", path.display())))?;
    if !root.is_table() {
        return Err(bad(format!(
            "invalid TOML root at {}: expected table",
            path.display()
        )));
    }
    Ok(root)
}

fn write_grok_root_toml_at(path: &Path, root: &toml::Value) -> Result<(), McpError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| internal(error.to_string()))?;
    }
    let serialized = toml::to_string_pretty(root)
        .map_err(|error| bad(format!("failed to serialize {}: {error}", path.display())))?;
    fs::write(path, format!("{serialized}\n")).map_err(|error| internal(error.to_string()))
}

fn read_grok_servers_at(path: &Path) -> Result<BTreeMap<String, Value>, McpError> {
    let root = read_grok_root_toml_at(path)?;
    let mut out = BTreeMap::new();
    if let Some(servers) = root.get("mcp_servers").and_then(toml::Value::as_table) {
        for (id, entry) in servers {
            if let Ok(spec) = grok_entry_to_canonical(id, entry) {
                out.insert(id.clone(), spec);
            }
        }
    }
    Ok(out)
}

fn read_grok_servers() -> Result<BTreeMap<String, Value>, McpError> {
    read_grok_servers_at(&grok_config_toml_path())
}

fn upsert_grok_server_at(path: &Path, id: &str, spec: &Value) -> Result<(), McpError> {
    let mut root = read_grok_root_toml_at(path)?;
    let table = root
        .as_table_mut()
        .ok_or_else(|| bad("Grok root TOML must be a table"))?;
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
    table
        .get_mut("mcp_servers")
        .and_then(toml::Value::as_table_mut)
        .ok_or_else(|| bad("Grok mcp_servers must be a table"))?
        .insert(id.to_string(), canonical_to_grok_entry(spec)?);
    write_grok_root_toml_at(path, &root)
}

fn upsert_grok_server(id: &str, spec: &Value) -> Result<(), McpError> {
    upsert_grok_server_at(&grok_config_toml_path(), id, spec)
}

fn remove_grok_server_at(path: &Path, id: &str) -> Result<bool, McpError> {
    if !path.exists() {
        return Ok(false);
    }
    let mut root = read_grok_root_toml_at(path)?;
    let Some(table) = root.as_table_mut() else {
        return Ok(false);
    };
    let removed = table
        .get_mut("mcp_servers")
        .and_then(toml::Value::as_table_mut)
        .is_some_and(|servers| servers.remove(id).is_some());
    if table
        .get("mcp_servers")
        .and_then(toml::Value::as_table)
        .is_some_and(toml::map::Map::is_empty)
    {
        table.remove("mcp_servers");
    }
    if removed {
        write_grok_root_toml_at(path, &root)?;
    }
    Ok(removed)
}

fn remove_grok_server(id: &str) -> Result<bool, McpError> {
    remove_grok_server_at(&grok_config_toml_path(), id)
}

fn read_cursor_servers_at(path: &Path) -> Result<BTreeMap<String, Value>, McpError> {
    let root = read_json_file(path)?;
    let mut out = BTreeMap::new();
    let Some(servers) = root.get("mcpServers").and_then(Value::as_object) else {
        return Ok(out);
    };
    for (id, spec) in servers {
        let mut spec = spec.clone();
        if let Some(obj) = spec.as_object_mut() {
            obj.remove("type");
            obj.remove("transport");
        }
        if let Ok(spec) = canonicalize_spec(&spec, &format!("Cursor config '{id}'")) {
            out.insert(id.clone(), spec);
        }
    }
    Ok(out)
}

fn read_cursor_servers() -> Result<BTreeMap<String, Value>, McpError> {
    read_cursor_servers_at(&cursor_mcp_json_path())
}

fn upsert_cursor_server_at(path: &Path, id: &str, spec: &Value) -> Result<(), McpError> {
    let mut root = read_json_file(path)?;
    if !root.is_object() {
        root = json!({});
    }
    let entry = canonical_to_cursor_entry(spec)?;
    let obj = root
        .as_object_mut()
        .ok_or_else(|| bad(format!("invalid JSON root in {}", path.display())))?;
    if !obj.get("mcpServers").map(Value::is_object).unwrap_or(false) {
        obj.insert("mcpServers".to_string(), Value::Object(Map::new()));
    }
    obj.get_mut("mcpServers")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| bad(format!("invalid mcpServers in {}", path.display())))?
        .insert(id.to_string(), entry);
    write_json_file(path, &root)
}

fn upsert_cursor_server(id: &str, spec: &Value) -> Result<(), McpError> {
    upsert_cursor_server_at(&cursor_mcp_json_path(), id, spec)
}

fn remove_cursor_server(id: &str) -> Result<bool, McpError> {
    remove_json_mcp_server_at(&cursor_mcp_json_path(), id)
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
        McpAppType::Antigravity => upsert_antigravity_server(id, spec),
        McpAppType::OpenClaw => upsert_openclaw_server(id, spec),
        McpAppType::Cline => upsert_cline_server(id, spec),
        McpAppType::Hermes => upsert_hermes_server(id, spec),
        McpAppType::CodeBuddy => upsert_codebuddy_server(id, spec),
        McpAppType::KimiCode => upsert_kimi_code_server(id, spec),
        McpAppType::Grok => upsert_grok_server(id, spec),
        McpAppType::Cursor => upsert_cursor_server(id, spec),
    }
}

fn remove_server_for_app(app: McpAppType, id: &str) -> Result<bool, McpError> {
    match app {
        McpAppType::ClaudeCode => remove_claude_server(id),
        McpAppType::Codex => remove_codex_server(id),
        McpAppType::OpenCode => remove_opencode_server(id),
        McpAppType::Antigravity => remove_antigravity_server(id),
        McpAppType::OpenClaw => remove_openclaw_server(id),
        McpAppType::Cline => remove_cline_server(id),
        McpAppType::Hermes => remove_hermes_server(id),
        McpAppType::CodeBuddy => remove_codebuddy_server(id),
        McpAppType::KimiCode => remove_kimi_code_server(id),
        McpAppType::Grok => remove_grok_server(id),
        McpAppType::Cursor => remove_cursor_server(id),
    }
}

fn read_servers_for_app(app: McpAppType) -> Result<BTreeMap<String, Value>, McpError> {
    match app {
        McpAppType::ClaudeCode => read_claude_servers(),
        McpAppType::Codex => read_codex_servers(),
        McpAppType::OpenCode => read_opencode_servers(),
        McpAppType::Antigravity => read_antigravity_servers(),
        McpAppType::OpenClaw => read_openclaw_servers(),
        McpAppType::Cline => read_cline_servers(),
        McpAppType::Hermes => read_hermes_servers(),
        McpAppType::CodeBuddy => read_codebuddy_servers(),
        McpAppType::KimiCode => read_kimi_code_servers(),
        McpAppType::Grok => read_grok_servers(),
        McpAppType::Cursor => read_cursor_servers(),
    }
}

// ---------------------------------------------------------------------------
// Scan + target application
// ---------------------------------------------------------------------------

fn scan_local_servers() -> Result<Vec<LocalMcpServer>, McpError> {
    let mut merged: BTreeMap<String, (Value, BTreeSet<McpAppType>)> = BTreeMap::new();

    for app in ALL_APPS {
        for (id, spec) in read_servers_for_app(app)? {
            let entry = merged
                .entry(id)
                .or_insert_with(|| (spec.clone(), BTreeSet::new()));
            entry.1.insert(app);
        }
    }

    Ok(merged
        .into_iter()
        .map(|(id, (spec, apps))| {
            let global = targets_are_global(&spec, &apps);
            LocalMcpServer {
                id,
                spec,
                global,
                apps: apps.into_iter().collect(),
            }
        })
        .collect())
}

/// Synchronous read used while constructing ACP `session/new` MCP inputs.
/// This performs local file reads only; no marketplace/network access.
pub fn scan_local_sync() -> Result<Vec<LocalMcpServer>, McpError> {
    scan_local_servers()
}

/// Add a server to the requested targets (never removes from others).
fn install_targets(
    id: &str,
    spec: &Value,
    global: bool,
    apps: &[McpAppType],
) -> Result<(), McpError> {
    if global {
        for app in ASSIGNABLE_APPS {
            if app_can_host_spec(app, spec) {
                upsert_server_for_app(app, id, spec)?;
            } else {
                remove_server_for_app(app, id)?;
            }
        }
        return Ok(());
    }
    if apps.is_empty() {
        return Err(bad("请至少选择一个目标应用"));
    }
    let hostable = apps
        .iter()
        .copied()
        .filter(|app| ASSIGNABLE_APPS.contains(app) && app_can_host_spec(*app, spec))
        .collect::<Vec<_>>();
    if hostable.is_empty() {
        return Err(bad("所选智能体均不支持此 MCP 传输类型（Codex 不支持 SSE）"));
    }
    for app in apps {
        if hostable.contains(app) {
            upsert_server_for_app(*app, id, spec)?;
        } else {
            remove_server_for_app(*app, id)?;
        }
    }
    Ok(())
}

/// Set a server's targets to exactly the requested set (removes from
/// deselected targets). Used by the "本地 MCP" editor. `global` implies all
/// agents, mirroring the install semantics.
fn set_targets(id: &str, spec: &Value, global: bool, apps: &[McpAppType]) -> Result<(), McpError> {
    let want: BTreeSet<McpAppType> = if global {
        ASSIGNABLE_APPS
            .into_iter()
            .filter(|app| app_can_host_spec(*app, spec))
            .collect()
    } else {
        let hostable = apps
            .iter()
            .copied()
            .filter(|app| ASSIGNABLE_APPS.contains(app) && app_can_host_spec(*app, spec))
            .collect::<BTreeSet<_>>();
        if hostable.is_empty() {
            return Err(bad("所选智能体均不支持此 MCP 传输类型（Codex 不支持 SSE）"));
        }
        hostable
    };
    for app in ALL_APPS {
        if !ASSIGNABLE_APPS.contains(&app) {
            continue;
        }
        if want.contains(&app) {
            upsert_server_for_app(app, id, spec)?;
        } else {
            remove_server_for_app(app, id)?;
        }
    }
    Ok(())
}

fn uninstall_everywhere(id: &str) -> Result<(), McpError> {
    for app in ALL_APPS {
        remove_server_for_app(app, id)?;
    }
    Ok(())
}

fn app_can_host_spec(app: McpAppType, spec: &Value) -> bool {
    !(app == McpAppType::Codex && spec.get("type").and_then(Value::as_str) == Some("sse"))
}

fn targets_are_global(spec: &Value, apps: &BTreeSet<McpAppType>) -> bool {
    ASSIGNABLE_APPS
        .into_iter()
        .filter(|app| app_can_host_spec(*app, spec))
        .all(|app| apps.contains(&app))
}

// ---------------------------------------------------------------------------
// Smithery marketplace resolution
// ---------------------------------------------------------------------------

fn official_protocols(server: &OfficialServer) -> Vec<String> {
    let mut protocols = BTreeSet::new();
    for transport in server.remotes.as_deref().unwrap_or_default() {
        if let Some(typ @ ("http" | "sse")) = normalize_mcp_type(&transport.r#type) {
            protocols.insert(typ.to_string());
        }
    }
    for package in server.packages.as_deref().unwrap_or_default() {
        if let Some(typ @ ("stdio" | "http" | "sse")) =
            normalize_mcp_type(&package.transport.r#type)
        {
            protocols.insert(typ.to_string());
        }
    }
    protocols.into_iter().collect()
}

fn official_entry_to_item(entry: &OfficialServerResponse) -> McpMarketplaceItem {
    let server = &entry.server;
    let name = server
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&server.name)
        .to_string();
    let homepage = server
        .website_url
        .as_deref()
        .or_else(|| {
            server
                .repository
                .as_ref()
                .and_then(|repository| repository.url.as_deref())
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let verified = entry
        .meta
        .as_ref()
        .and_then(|meta| meta.get("io.modelcontextprotocol.registry/official"))
        .and_then(Value::as_object)
        .and_then(|official| official.get("status"))
        .and_then(Value::as_str)
        == Some("active");
    McpMarketplaceItem {
        provider_id: MARKETPLACE_OFFICIAL.to_string(),
        server_id: server.name.clone(),
        name,
        description: server
            .description
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("No description")
            .to_string(),
        homepage,
        remote: server
            .remotes
            .as_ref()
            .is_some_and(|remotes| !remotes.is_empty()),
        verified,
        icon_url: server
            .icons
            .as_deref()
            .unwrap_or_default()
            .iter()
            .filter_map(|icon| icon.src.as_deref())
            .map(str::trim)
            .find(|value| !value.is_empty())
            .map(str::to_string),
        latest_version: server
            .version
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        protocols: official_protocols(server),
        owner: None,
        namespace: None,
        downloads: None,
        score: None,
        is_deployed: None,
    }
}

async fn search_official_registry(
    query: &str,
    limit: u32,
) -> Result<Vec<McpMarketplaceItem>, McpError> {
    let client = marketplace_http_client()?;
    let response = send_request(
        "failed to query official MCP registry",
        client
            .get("https://registry.modelcontextprotocol.io/v0.1/servers")
            .query(&[
                ("limit", limit.to_string()),
                ("version", "latest".to_string()),
                ("search", query.trim().to_string()),
            ]),
    )
    .await?;
    if !response.status().is_success() {
        return Err(internal(format!(
            "official MCP registry request failed: HTTP {}",
            response.status()
        )));
    }
    let payload = parse_json_response::<Value>(response, "official registry").await?;
    let entries = payload
        .get("servers")
        .and_then(Value::as_array)
        .ok_or_else(|| bad("official MCP registry response is missing the servers array"))?;
    Ok(entries
        .iter()
        .filter_map(|entry| {
            serde_json::from_value::<OfficialServerResponse>(entry.clone())
                .ok()
                .map(|entry| official_entry_to_item(&entry))
        })
        .collect())
}

async fn fetch_official_server_detail(server_id: &str) -> Result<OfficialServerResponse, McpError> {
    let encoded = encode_query_component(server_id);
    let url =
        format!("https://registry.modelcontextprotocol.io/v0.1/servers/{encoded}/versions/latest");
    let client = marketplace_http_client()?;
    let response = send_request("failed to fetch official MCP server", client.get(url)).await?;
    if !response.status().is_success() {
        return Err(internal(format!(
            "official MCP server detail request failed: HTTP {}",
            response.status()
        )));
    }
    parse_json_response(response, "official MCP server detail").await
}

fn build_official_install_options(
    server: &OfficialServer,
) -> Result<Vec<McpMarketplaceInstallOption>, McpError> {
    let mut options = Vec::new();
    for (index, package) in server
        .packages
        .as_deref()
        .unwrap_or_default()
        .iter()
        .enumerate()
    {
        let Some(protocol @ ("stdio" | "http" | "sse")) =
            normalize_mcp_type(&package.transport.r#type)
        else {
            continue;
        };
        let resolved = if protocol == "stdio" {
            resolve_official_package(package, &Map::new(), false)
        } else {
            resolve_official_remote(&package.transport, &Map::new(), false)
        };
        let Ok(spec) = resolved else { continue };
        options.push(McpMarketplaceInstallOption {
            id: format!("official:package:{index}:{protocol}"),
            protocol: protocol.to_string(),
            label: if protocol == "stdio" {
                format!(
                    "stdio ({})",
                    package.runtime_hint.as_deref().unwrap_or("runtime")
                )
            } else {
                format!("{protocol} (package)")
            },
            description: Some(format!("Package {}", package.identifier)),
            spec,
            parameters: if protocol == "stdio" {
                official_stdio_parameter_fields(package)
            } else {
                official_remote_parameter_fields(&package.transport)
            },
        });
    }
    for (index, transport) in server
        .remotes
        .as_deref()
        .unwrap_or_default()
        .iter()
        .enumerate()
    {
        let Some(protocol @ ("http" | "sse")) = normalize_mcp_type(&transport.r#type) else {
            continue;
        };
        let Ok(spec) = resolve_official_remote(transport, &Map::new(), false) else {
            continue;
        };
        options.push(McpMarketplaceInstallOption {
            id: format!("official:remote:{index}:{protocol}"),
            protocol: protocol.to_string(),
            label: format!("{protocol} (remote)"),
            description: transport.url.clone(),
            spec,
            parameters: official_remote_parameter_fields(transport),
        });
    }
    if options.is_empty() {
        return Err(not_found(format!(
            "official MCP server '{}' has no installable transport",
            server.name
        )));
    }
    Ok(options)
}

fn resolve_official_install_spec(
    server: &OfficialServer,
    option_id: &Option<String>,
    values: &Map<String, Value>,
) -> Result<Value, McpError> {
    let options = build_official_install_options(server)?;
    let selected = select_install_option(&options, option_id)
        .ok_or_else(|| not_found("no official registry install option available"))?;
    let parts = selected.id.split(':').collect::<Vec<_>>();
    if parts.len() < 4 || parts[0] != "official" {
        return Err(bad(format!("invalid official option '{}'", selected.id)));
    }
    let index = parts[2]
        .parse::<usize>()
        .map_err(|_| bad(format!("invalid official option '{}'", selected.id)))?;
    match parts[1] {
        "package" => {
            let package = server
                .packages
                .as_deref()
                .and_then(|packages| packages.get(index))
                .ok_or_else(|| not_found("official package option is out of range"))?;
            if normalize_protocol_value(&selected.protocol) == "stdio" {
                resolve_official_package(package, values, true)
            } else {
                resolve_official_remote(&package.transport, values, true)
            }
        }
        "remote" => {
            let remote = server
                .remotes
                .as_deref()
                .and_then(|remotes| remotes.get(index))
                .ok_or_else(|| not_found("official remote option is out of range"))?;
            resolve_official_remote(remote, values, true)
        }
        _ => Err(bad(format!(
            "unsupported official option '{}'",
            selected.id
        ))),
    }
}

async fn search_smithery(query: &str, limit: u32) -> Result<Vec<McpMarketplaceItem>, McpError> {
    let client = marketplace_http_client()?;
    let trimmed = query.trim();
    let response = send_request(
        "failed to query smithery marketplace",
        client
            .get("https://api.smithery.ai/servers")
            .query(&[("limit", limit.to_string()), ("q", trimmed.to_string())]),
    )
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
    let response = match send_request(
        "failed to fetch smithery server summary",
        client
            .get("https://api.smithery.ai/servers")
            .query(&[("limit", "30"), ("q", server_id)]),
    )
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
    let response = send_request("failed to fetch smithery server detail", client.get(url)).await?;
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
    Ok(vec![
        McpMarketplaceProvider {
            id: MARKETPLACE_OFFICIAL.to_string(),
            name: "Official MCP Registry".to_string(),
            description: "registry.modelcontextprotocol.io official MCP server registry"
                .to_string(),
        },
        McpMarketplaceProvider {
            id: MARKETPLACE_SMITHERY.to_string(),
            name: "Smithery".to_string(),
            description: "smithery.ai MCP server marketplace".to_string(),
        },
    ])
}

pub async fn search_marketplace(
    provider_id: String,
    query: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<McpMarketplaceItem>, McpError> {
    let q = query.unwrap_or_default();
    let max = limit.unwrap_or(30).clamp(1, 100);
    match provider_id.as_str() {
        MARKETPLACE_OFFICIAL => search_official_registry(&q, max).await,
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
        MARKETPLACE_OFFICIAL => {
            let detail = fetch_official_server_detail(&server_id).await?;
            let item = official_entry_to_item(&detail);
            let install_options = build_official_install_options(&detail.server)?;
            let default_option = select_default_install_option(&install_options);
            let spec = default_option
                .map(|option| option.spec.clone())
                .ok_or_else(|| not_found("official server has no installable option"))?;
            Ok(McpMarketplaceServerDetail {
                provider_id: MARKETPLACE_OFFICIAL.to_string(),
                server_id: item.server_id,
                name: item.name,
                description: item.description,
                homepage: item.homepage,
                remote: item.remote,
                verified: item.verified,
                icon_url: item.icon_url,
                latest_version: item.latest_version,
                protocols: item.protocols,
                owner: item.owner,
                namespace: item.namespace,
                downloads: item.downloads,
                score: item.score,
                is_deployed: item.is_deployed,
                default_option_id: default_option.map(|option| option.id.clone()),
                install_options,
                spec,
            })
        }
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
            MARKETPLACE_OFFICIAL => {
                let detail = fetch_official_server_detail(&server_id).await?;
                resolve_official_install_spec(&detail.server, &option_id, &values)?
            }
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

    #[tokio::test]
    async fn saved_cline_data_root_controls_the_native_mcp_path() {
        let root = tempfile::tempdir().unwrap();
        let data_root = root.path().join(".cline").join("data");
        let environment =
            HashMap::from([("CLINE_DIR".to_string(), data_root.display().to_string())]);

        let path = with_saved_agent_environment(environment, async { cline_config_path() }).await;

        assert_eq!(
            path,
            data_root.join("settings").join("cline_mcp_settings.json")
        );
    }

    #[tokio::test]
    async fn saved_hermes_home_expands_tilde_for_mcp() {
        let environment = HashMap::from([(
            "HERMES_HOME".to_string(),
            "~/.hermes-vibex-test".to_string(),
        )]);

        let path =
            with_saved_agent_environment(environment, async { hermes_config_yaml_path() }).await;

        assert_eq!(
            path,
            home_dir_or_default()
                .join(".hermes-vibex-test")
                .join("config.yaml")
        );
    }

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
    fn codex_native_schema_infers_remote_and_omits_type_while_preserving_cwd() {
        let remote = toml::Value::Table(toml::Table::from_iter([(
            "url".to_string(),
            toml::Value::String("https://x/mcp".to_string()),
        )]));
        let canonical = codex_entry_to_canonical("remote", &remote).expect("native remote");
        assert_eq!(canonical["type"], "http");

        let entry = canonical_to_codex_entry(&json!({
            "type": "stdio",
            "command": "node",
            "cwd": "/workspace"
        }))
        .expect("native stdio");
        let table = entry.as_table().unwrap();
        assert!(!table.contains_key("type"));
        assert_eq!(
            table.get("cwd").and_then(toml::Value::as_str),
            Some("/workspace")
        );
    }

    #[test]
    fn codex_strict_schema_keeps_only_type_valid_passthrough_fields() {
        let entry = canonical_to_codex_entry(&json!({
            "type": "stdio",
            "command": "node",
            "enabled": true,
            "required": false,
            "autoApprove": ["read"],
            "transport": "stdio",
            "name": "foreign",
            "startup_timeout_sec": 5,
            "unknown": { "nested": true }
        }))
        .unwrap();
        let table = entry.as_table().unwrap();

        assert_eq!(
            table.get("enabled").and_then(toml::Value::as_bool),
            Some(true)
        );
        assert_eq!(
            table.get("required").and_then(toml::Value::as_bool),
            Some(false)
        );
        assert_eq!(table.len(), 3);

        let wrong_types = canonical_to_codex_entry(&json!({
            "type": "stdio",
            "command": "node",
            "enabled": "false",
            "required": 1
        }))
        .unwrap();
        assert_eq!(wrong_types.as_table().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn codex_legacy_mcp_servers_are_visible_migrated_and_removed() {
        let root = tempfile::tempdir().unwrap();
        let codex_home = root.path().join("codex");
        std::fs::create_dir_all(&codex_home).unwrap();
        std::fs::write(
            codex_home.join("config.toml"),
            "[mcp.servers.legacy]\ncommand = \"old\"\n[mcp.servers.remove_me]\ncommand = \"gone\"\n",
        )
        .unwrap();
        let environment =
            HashMap::from([("CODEX_HOME".to_string(), codex_home.display().to_string())]);

        with_saved_agent_environment(environment, async {
            let scanned = read_codex_servers().unwrap();
            assert_eq!(scanned["legacy"]["command"], "old");

            upsert_codex_server("legacy", &json!({ "type": "stdio", "command": "new" })).unwrap();
            let root = read_codex_root_toml().unwrap();
            assert_eq!(
                root.get("mcp_servers")
                    .and_then(|value| value.get("legacy"))
                    .and_then(|value| value.get("command"))
                    .and_then(toml::Value::as_str),
                Some("new")
            );
            assert!(
                root.get("mcp")
                    .and_then(|value| value.get("servers"))
                    .and_then(|value| value.get("legacy"))
                    .is_none()
            );

            assert!(remove_codex_server("remove_me").unwrap());
            assert!(!read_codex_servers().unwrap().contains_key("remove_me"));
        })
        .await;
    }

    #[test]
    fn cline_http_writer_uses_streamable_http_native_type() {
        let entry = canonical_to_cline_entry(&json!({
            "type": "http",
            "url": "https://x/mcp"
        }))
        .expect("Cline native entry");
        assert_eq!(entry["type"], "streamableHttp");
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

    #[test]
    fn global_targets_match_codeg_native_mcp_matrix() {
        let targets = ALL_APPS
            .into_iter()
            .map(|app| serde_json::to_value(app).expect("serialize app"))
            .collect::<Vec<_>>();
        assert_eq!(targets.len(), 11);
        for expected in [
            "claude_code",
            "codex",
            "antigravity",
            "openclaw",
            "opencode",
            "cline",
            "hermes",
            "codebuddy",
            "kimi_code",
            "grok",
            "cursor",
        ] {
            assert!(targets.contains(&Value::String(expected.to_string())));
        }
        assert!(!targets.contains(&Value::String("pi".to_string())));
        assert_eq!(ASSIGNABLE_APPS.len(), 10);
        assert!(!ASSIGNABLE_APPS.contains(&McpAppType::OpenClaw));
    }

    #[test]
    fn global_state_is_derived_from_native_targets() {
        let stdio = json!({ "type": "stdio", "command": "server" });
        let all = ASSIGNABLE_APPS.into_iter().collect();
        assert!(targets_are_global(&stdio, &all));

        let mut missing = all;
        missing.remove(&McpAppType::ClaudeCode);
        assert!(!targets_are_global(&stdio, &missing));

        let sse = json!({ "type": "sse", "url": "https://example.com/sse" });
        let without_codex = ASSIGNABLE_APPS
            .into_iter()
            .filter(|app| *app != McpAppType::Codex)
            .collect();
        assert!(targets_are_global(&sse, &without_codex));
    }

    #[test]
    fn kimi_code_roundtrip_keeps_remote_transport() {
        for typ in ["http", "sse"] {
            let spec = json!({ "type": typ, "url": "https://x/mcp" });
            let entry = canonical_to_kimi_code_entry(&spec).expect("to Kimi");
            assert_eq!(entry.get("transport").and_then(Value::as_str), Some(typ));
            let back = kimi_code_entry_to_canonical(&entry, "example").expect("from Kimi");
            assert_eq!(back.get("type").and_then(Value::as_str), Some(typ));
        }
    }

    #[test]
    fn cursor_writer_emits_only_cursor_supported_fields() {
        let spec = json!({
            "type": "sse",
            "url": "https://x/sse",
            "headers": { "Authorization": "Bearer t" },
            "enabled": true,
            "transport": "sse"
        });
        let entry = canonical_to_cursor_entry(&spec).expect("to Cursor");
        assert_eq!(
            entry.get("url").and_then(Value::as_str),
            Some("https://x/sse")
        );
        assert!(entry.get("type").is_none());
        assert!(entry.get("transport").is_none());
        assert!(entry.get("enabled").is_none());
    }

    #[test]
    fn kimi_and_cursor_file_writers_preserve_unrelated_json() {
        let temp = tempfile::tempdir().expect("tempdir");
        let kimi = temp.path().join("kimi.json");
        let cursor = temp.path().join("cursor.json");
        fs::write(&kimi, r#"{"other":{"keep":true}}"#).expect("seed Kimi");
        fs::write(&cursor, r#"{"version":1}"#).expect("seed Cursor");

        upsert_kimi_code_server_at(
            &kimi,
            "remote",
            &json!({ "type": "sse", "url": "https://x/sse" }),
        )
        .expect("write Kimi");
        upsert_cursor_server_at(
            &cursor,
            "local",
            &json!({ "type": "stdio", "command": "npx", "args": ["-y", "pkg"] }),
        )
        .expect("write Cursor");

        let kimi_root = read_json_file(&kimi).expect("read Kimi");
        let cursor_root = read_json_file(&cursor).expect("read Cursor");
        assert_eq!(kimi_root.pointer("/other/keep"), Some(&Value::Bool(true)));
        assert_eq!(cursor_root.get("version"), Some(&json!(1)));
        assert_eq!(
            read_kimi_code_servers_at(&kimi)
                .expect("scan Kimi")
                .get("remote")
                .and_then(|spec| spec.get("type"))
                .and_then(Value::as_str),
            Some("sse")
        );
        assert_eq!(
            read_cursor_servers_at(&cursor)
                .expect("scan Cursor")
                .get("local")
                .and_then(|spec| spec.get("command"))
                .and_then(Value::as_str),
            Some("npx")
        );
    }

    #[test]
    fn grok_file_writer_roundtrips_and_preserves_other_sections() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("config.toml");
        fs::write(&path, "[ui]\ntheme = \"dark\"\n").expect("seed Grok");
        upsert_grok_server_at(
            &path,
            "remote",
            &json!({
                "type": "sse",
                "url": "https://x/sse",
                "headers": { "Authorization": "Bearer t" }
            }),
        )
        .expect("write Grok");

        let servers = read_grok_servers_at(&path).expect("scan Grok");
        let remote = servers.get("remote").expect("remote");
        assert_eq!(remote.get("type").and_then(Value::as_str), Some("sse"));
        assert_eq!(
            remote
                .pointer("/headers/Authorization")
                .and_then(Value::as_str),
            Some("Bearer t")
        );
        assert!(
            fs::read_to_string(&path)
                .expect("read Grok")
                .contains("theme = \"dark\"")
        );
        assert!(remove_grok_server_at(&path, "remote").expect("remove Grok"));
        assert!(read_grok_servers_at(&path).expect("rescan Grok").is_empty());
        assert!(
            fs::read_to_string(&path)
                .expect("read preserved Grok")
                .contains("theme = \"dark\"")
        );
    }

    #[test]
    fn grok_stdio_companion_forward_writes_command_and_args() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("config.toml");
        fs::write(&path, "[ui]\ntheme = \"dark\"\n").expect("seed Grok");
        upsert_grok_server_at(
            &path,
            "vibex-delegation-mcp",
            &json!({
                "type": "stdio",
                "command": "/opt/vibex-mcp",
                "args": ["--token", "abc", "--features", "delegation"]
            }),
        )
        .expect("write companion");
        let text = fs::read_to_string(&path).expect("read Grok");
        assert!(text.contains("vibex-delegation-mcp"));
        assert!(text.contains("/opt/vibex-mcp"));
        assert!(text.contains("delegation"));
        assert!(text.contains("theme = \"dark\""));
        assert!(remove_grok_server_at(&path, "vibex-delegation-mcp").expect("remove companion"));
        assert!(read_grok_servers_at(&path).expect("rescan Grok").is_empty());
    }

    #[test]
    fn codex_rejects_sse_without_blocking_other_targets() {
        let sse = json!({ "type": "sse", "url": "https://x/sse" });
        assert!(canonical_to_codex_entry(&sse).is_err());
        assert!(!app_can_host_spec(McpAppType::Codex, &sse));
        assert!(app_can_host_spec(McpAppType::KimiCode, &sse));
    }

    #[tokio::test]
    async fn marketplace_catalog_includes_official_and_smithery() {
        let providers = list_marketplaces().await.expect("providers");
        assert_eq!(
            providers
                .iter()
                .map(|provider| provider.id.as_str())
                .collect::<Vec<_>>(),
            vec![MARKETPLACE_OFFICIAL, MARKETPLACE_SMITHERY]
        );
    }

    #[test]
    fn official_registry_package_resolves_parameters_and_version() {
        let response: OfficialServerResponse = serde_json::from_value(json!({
            "server": {
                "name": "io.example/server",
                "title": "Example",
                "version": "1.2.3",
                "packages": [{
                    "registryType": "npm",
                    "identifier": "example-mcp",
                    "version": "1.2.3",
                    "runtimeArguments": [{
                        "type": "named",
                        "name": "--mode",
                        "default": "safe"
                    }],
                    "packageArguments": [{
                        "name": "workspace",
                        "isRequired": true,
                        "valueHint": "/project"
                    }],
                    "environmentVariables": [{
                        "name": "API_KEY",
                            "description": "API key",
                            "isRequired": true,
                            "isSecret": true
                    }],
                    "transport": { "type": "stdio" }
                }]
            },
            "_meta": {
                "io.modelcontextprotocol.registry/official": { "status": "active" }
            }
        }))
        .expect("official response");
        let item = official_entry_to_item(&response);
        assert!(item.verified);
        assert_eq!(item.protocols, vec!["stdio"]);
        let options = build_official_install_options(&response.server).expect("options");
        let option = &options[0];
        assert!(
            option
                .parameters
                .iter()
                .any(|field| field.key == "env.API_KEY" && field.secret && field.required)
        );
        let values = Map::from_iter([
            (
                "package_arguments.0".to_string(),
                Value::String("/repo".to_string()),
            ),
            (
                "env.API_KEY".to_string(),
                Value::String("secret".to_string()),
            ),
        ]);
        let spec =
            resolve_official_install_spec(&response.server, &Some(option.id.clone()), &values)
                .expect("resolved package");
        assert_eq!(spec.get("command").and_then(Value::as_str), Some("npx"));
        assert_eq!(
            spec.get("args")
                .and_then(Value::as_array)
                .expect("args")
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>(),
            vec!["-y", "--mode", "safe", "example-mcp@1.2.3", "/repo"]
        );
        assert_eq!(
            spec.pointer("/env/API_KEY").and_then(Value::as_str),
            Some("secret")
        );
    }

    #[test]
    fn official_remote_substitutes_variables_and_requires_headers() {
        let transport: OfficialTransport = serde_json::from_value(json!({
            "type": "streamable-http",
            "url": "https://example.com/{tenant}/mcp",
            "variables": [{ "name": "tenant", "isRequired": true }],
            "headers": {
                "Authorization": {
                    "isRequired": true,
                    "isSecret": true,
                    "valueHint": "Bearer ..."
                }
            }
        }))
        .expect("transport");
        assert!(resolve_official_remote(&transport, &Map::new(), true).is_err());
        let values = Map::from_iter([
            (
                "variables.tenant".to_string(),
                Value::String("acme team".to_string()),
            ),
            (
                "headers.Authorization".to_string(),
                Value::String("Bearer token".to_string()),
            ),
        ]);
        let spec = resolve_official_remote(&transport, &values, true).expect("remote");
        assert_eq!(
            spec.get("url").and_then(Value::as_str),
            Some("https://example.com/acme%20team/mcp")
        );
        assert_eq!(
            spec.pointer("/headers/Authorization")
                .and_then(Value::as_str),
            Some("Bearer token")
        );
    }
}
