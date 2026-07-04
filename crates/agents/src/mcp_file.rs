use std::{collections::HashMap, path::Path, sync::LazyLock};

use jsonc_parser::{
    ParseOptions,
    cst::{CstObject, CstRootNode},
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;

use crate::{
    AgentError, AgentResult, AgentKind, claude_config_path, codex_config_path, opencode_config_path,
};

static DEFAULT_MCP_JSON: &str = include_str!("../default_mcp.json");
pub static PRECONFIGURED_MCP_SERVERS: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str::<Value>(DEFAULT_MCP_JSON).expect("Failed to parse default MCP JSON")
});

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentMcpConfig {
    servers: HashMap<String, Value>,
    pub servers_path: Vec<String>,
    pub template: Value,
    pub preconfigured: Value,
    pub is_toml_config: bool,
}

impl AgentMcpConfig {
    pub fn new(
        servers_path: Vec<String>,
        template: Value,
        preconfigured: Value,
        is_toml_config: bool,
    ) -> Self {
        Self {
            servers: HashMap::new(),
            servers_path,
            template,
            preconfigured,
            is_toml_config,
        }
    }

    pub fn set_servers(&mut self, servers: HashMap<String, Value>) {
        self.servers = servers;
    }
}

pub fn default_mcp_config_path(agent_type: AgentKind) -> Option<std::path::PathBuf> {
    match agent_type {
        AgentKind::ClaudeCode => claude_config_path(),
        AgentKind::Codex => codex_config_path(),
        AgentKind::Opencode => opencode_config_path(),
        AgentKind::Gemini
        | AgentKind::Openclaw
        | AgentKind::Cline
        | AgentKind::Hermes
        | AgentKind::QaMock => None,
    }
}

pub fn mcp_file_config(agent_type: AgentKind) -> Option<AgentMcpConfig> {
    let config = match agent_type {
        AgentKind::Codex => AgentMcpConfig::new(
            vec!["mcp_servers".to_string()],
            serde_json::json!({ "mcp_servers": {} }),
            preconfigured_mcp(agent_type),
            true,
        ),
        AgentKind::Opencode => AgentMcpConfig::new(
            vec!["mcp".to_string()],
            serde_json::json!({
                "mcp": {},
                "$schema": "https://opencode.ai/config.json"
            }),
            preconfigured_mcp(agent_type),
            false,
        ),
        AgentKind::ClaudeCode => AgentMcpConfig::new(
            vec!["mcpServers".to_string()],
            serde_json::json!({ "mcpServers": {} }),
            preconfigured_mcp(agent_type),
            false,
        ),
        AgentKind::Gemini
        | AgentKind::Openclaw
        | AgentKind::Cline
        | AgentKind::Hermes
        | AgentKind::QaMock => {
            return None;
        }
    };
    Some(config)
}

pub async fn read_agent_mcp_config(
    config_path: &Path,
    mcp_config: &AgentMcpConfig,
) -> AgentResult<Value> {
    if let Ok(file_content) = tokio::fs::read_to_string(config_path).await {
        if mcp_config.is_toml_config {
            if file_content.trim().is_empty() {
                return Ok(serde_json::json!({}));
            }
            let toml_val: toml::Value = toml::from_str(&file_content)
                .map_err(|error| AgentError::Runtime(error.to_string()))?;
            let json_string = serde_json::to_string(&toml_val)
                .map_err(|error| AgentError::Runtime(error.to_string()))?;
            serde_json::from_str(&json_string)
                .map_err(|error| AgentError::Runtime(error.to_string()))
        } else if is_jsonc_file(config_path) {
            if file_content.trim().is_empty() {
                return Ok(serde_json::json!({}));
            }
            match jsonc_parser::parse_to_serde_value(&file_content, &ParseOptions::default()) {
                Ok(Some(value)) => Ok(value),
                Ok(None) => Ok(serde_json::json!({})),
                Err(_) => serde_json::from_str(&file_content)
                    .map_err(|error| AgentError::Runtime(error.to_string())),
            }
        } else {
            serde_json::from_str(&file_content)
                .map_err(|error| AgentError::Runtime(error.to_string()))
        }
    } else {
        Ok(mcp_config.template.clone())
    }
}

pub async fn write_agent_mcp_config(
    config_path: &Path,
    mcp_config: &AgentMcpConfig,
    config: &Value,
) -> AgentResult<()> {
    if mcp_config.is_toml_config {
        let toml_value: toml::Value = serde_json::from_str(
            &serde_json::to_string(config)
                .map_err(|error| AgentError::Runtime(error.to_string()))?,
        )
        .map_err(|error| AgentError::Runtime(error.to_string()))?;
        let toml_content = toml::to_string_pretty(&toml_value)
            .map_err(|error| AgentError::Runtime(error.to_string()))?;
        tokio::fs::write(config_path, toml_content)
            .await
            .map_err(|error| AgentError::Runtime(error.to_string()))?;
    } else if is_jsonc_file(config_path) {
        write_jsonc_preserving_comments(config_path, config).await?;
    } else {
        let json_content = serde_json::to_string_pretty(config)
            .map_err(|error| AgentError::Runtime(error.to_string()))?;
        tokio::fs::write(config_path, json_content)
            .await
            .map_err(|error| AgentError::Runtime(error.to_string()))?;
    }
    Ok(())
}

fn is_jsonc_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("jsonc"))
}

async fn write_jsonc_preserving_comments(
    config_path: &Path,
    new_config: &Value,
) -> AgentResult<()> {
    let current_content = tokio::fs::read_to_string(config_path)
        .await
        .unwrap_or_else(|_| "{}".to_string());
    let output = update_jsonc_content(&current_content, new_config);
    tokio::fs::write(config_path, output)
        .await
        .map_err(|error| AgentError::Runtime(error.to_string()))
}

fn update_jsonc_content(current_content: &str, new_config: &Value) -> String {
    let root = CstRootNode::parse(current_content, &ParseOptions::default())
        .unwrap_or_else(|_| CstRootNode::parse("{}", &ParseOptions::default()).unwrap());
    let root_obj = root.object_value_or_set();

    if let Some(obj) = new_config.as_object() {
        deep_merge_cst_object(&root_obj, obj);
    }

    root.to_string()
}

fn deep_merge_cst_object(cst_obj: &CstObject, new_obj: &Map<String, Value>) {
    let existing_keys: Vec<String> = cst_obj
        .properties()
        .iter()
        .filter_map(|property| property.name().and_then(|name| name.decoded_value().ok()))
        .collect();

    for key in &existing_keys {
        if !new_obj.contains_key(key)
            && let Some(property) = cst_obj.get(key)
        {
            property.remove();
        }
    }

    for (key, new_value) in new_obj {
        if let Some(property) = cst_obj.get(key) {
            if let (Some(existing_obj), Some(new_obj_map)) =
                (property.object_value(), new_value.as_object())
            {
                deep_merge_cst_object(&existing_obj, new_obj_map);
            } else {
                property.set_value(serde_json_to_cst_input(new_value));
            }
        } else {
            cst_obj.append(key, serde_json_to_cst_input(new_value));
        }
    }
}

fn serde_json_to_cst_input(value: &Value) -> jsonc_parser::cst::CstInputValue {
    use jsonc_parser::cst::CstInputValue;

    match value {
        Value::Null => CstInputValue::Null,
        Value::Bool(value) => CstInputValue::Bool(*value),
        Value::Number(number) => CstInputValue::Number(number.to_string()),
        Value::String(value) => CstInputValue::String(value.clone()),
        Value::Array(values) => {
            CstInputValue::Array(values.iter().map(serde_json_to_cst_input).collect())
        }
        Value::Object(object) => CstInputValue::Object(
            object
                .iter()
                .map(|(key, value)| (key.clone(), serde_json_to_cst_input(value)))
                .collect(),
        ),
    }
}

type ServerMap = Map<String, Value>;

fn preconfigured_mcp(agent_type: AgentKind) -> Value {
    let adapter = match agent_type {
        AgentKind::Codex => Adapter::Codex,
        AgentKind::Opencode => Adapter::Opencode,
        AgentKind::ClaudeCode
        | AgentKind::Gemini
        | AgentKind::Openclaw
        | AgentKind::Cline
        | AgentKind::Hermes
        | AgentKind::QaMock => Adapter::Passthrough,
    };

    apply_adapter(adapter, PRECONFIGURED_MCP_SERVERS.clone())
}

enum Adapter {
    Passthrough,
    Codex,
    Opencode,
}

fn apply_adapter(adapter: Adapter, canonical: Value) -> Value {
    let (servers_only, meta) = match canonical.as_object() {
        Some(map) => extract_meta(map.clone()),
        None => (ServerMap::new(), None),
    };

    match adapter {
        Adapter::Passthrough => attach_meta(servers_only, meta),
        Adapter::Codex => adapt_codex(servers_only, meta),
        Adapter::Opencode => adapt_opencode(servers_only, meta),
    }
}

fn extract_meta(mut obj: ServerMap) -> (ServerMap, Option<Value>) {
    let meta = obj.remove("meta");
    (obj, meta)
}

fn attach_meta(mut obj: ServerMap, meta: Option<Value>) -> Value {
    if let Some(meta) = meta {
        obj.insert("meta".to_string(), meta);
    }
    Value::Object(obj)
}

fn adapt_codex(mut servers: ServerMap, mut meta: Option<Value>) -> Value {
    servers.retain(|_, value| value.as_object().map(is_stdio).unwrap_or(false));

    if let Some(Value::Object(ref mut metadata)) = meta {
        metadata.retain(|key, _| servers.contains_key(key));
        servers.insert("meta".to_string(), Value::Object(std::mem::take(metadata)));
        meta = None;
    }
    attach_meta(servers, meta)
}

fn adapt_opencode(servers: ServerMap, meta: Option<Value>) -> Value {
    let mut servers = transform_http_servers(servers, |mut server| {
        let url = server
            .remove("url")
            .unwrap_or_else(|| Value::String(String::new()));
        let mut headers = server
            .remove("headers")
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        ensure_header(
            &mut headers,
            "Accept",
            "application/json, text/event-stream",
        );

        Map::from_iter([
            ("type".to_string(), Value::String("remote".to_string())),
            ("url".to_string(), url),
            ("headers".to_string(), Value::Object(headers)),
            ("enabled".to_string(), Value::Bool(true)),
        ])
    });

    for value in servers.values_mut() {
        if let Value::Object(server) = value
            && is_stdio(server)
        {
            let command_str = server
                .remove("command")
                .and_then(|value| value.as_str().map(str::to_string))
                .unwrap_or_default();
            let mut command = Vec::new();
            if !command_str.is_empty() {
                command.push(Value::String(command_str));
            }
            if let Some(args) = server
                .remove("args")
                .and_then(|value| value.as_array().cloned())
            {
                command.extend(args);
            }

            server.clear();
            server.insert("type".to_string(), Value::String("local".to_string()));
            server.insert("command".to_string(), Value::Array(command));
            server.insert("enabled".to_string(), Value::Bool(true));
        }
    }

    attach_meta(servers, meta)
}

fn transform_http_servers<F>(mut servers: ServerMap, mut f: F) -> ServerMap
where
    F: FnMut(Map<String, Value>) -> Map<String, Value>,
{
    for value in servers.values_mut() {
        if let Value::Object(server) = value
            && is_http_server(server)
        {
            let taken = std::mem::take(server);
            *server = f(taken);
        }
    }
    servers
}

fn is_http_server(server: &Map<String, Value>) -> bool {
    matches!(server.get("type").and_then(Value::as_str), Some("http"))
}

fn is_stdio(server: &Map<String, Value>) -> bool {
    !is_http_server(server) && server.get("command").is_some()
}

fn ensure_header(headers: &mut Map<String, Value>, key: &str, value: &str) {
    match headers.get_mut(key) {
        Some(Value::String(_)) => {}
        _ => {
            headers.insert(key.to_string(), Value::String(value.to_string()));
        }
    }
}
