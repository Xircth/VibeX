//! Official product MCP bindings published from enabled plugin packages.
//!
//! Injection reads this snapshot. Package identity is taken from declared
//! `hostFamilyBinary` MCP resources, not from a hardcoded plugin-id match.

use std::sync::{
    Mutex,
    atomic::{AtomicU8, Ordering},
};

use serde_json::Value;

use crate::{InstalledPlugin, PluginActivation};

pub const SESSION_FEAT_FEEDBACK: u8 = 1;
pub const SESSION_FEAT_ASK: u8 = 1 << 1;
pub const SESSION_FEAT_SESSIONS: u8 = 1 << 2;
pub const SESSION_FEAT_SESSION_CONTROL: u8 = 1 << 3;
pub const SESSION_FEAT_ALL: u8 =
    SESSION_FEAT_FEEDBACK | SESSION_FEAT_ASK | SESSION_FEAT_SESSIONS | SESSION_FEAT_SESSION_CONTROL;

/// Host-injected / native-projected MCP identity for multi-agent delegation.
pub const DELEGATION_MCP_NAME: &str = "vibex-delegation-mcp";

/// Host-injected / native-projected MCP identity for session enhancement.
pub const SESSION_MCP_NAME: &str = "vibex-session-mcp";

/// Host-injected MCP identity for plugin development link requests.
pub const PLUGIN_DEV_MCP_NAME: &str = "vibex-plugin-dev-mcp";

/// Host-injected / native-projected MCP identity for Workflow Creator.
pub const WORKFLOW_MCP_NAME: &str = "vibex-workflow-mcp";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OfficialMcpBinding {
    pub plugin_id: String,
    pub binary_id: String,
    pub product: String,
    pub features: u8,
    pub token: String,
}

#[derive(Debug, Default)]
pub struct OfficialMcpRuntime {
    bindings: Mutex<Vec<OfficialMcpBinding>>,
    session_features: AtomicU8,
    http_base: Mutex<Option<String>>,
}

impl OfficialMcpRuntime {
    pub fn bindings(&self) -> Vec<OfficialMcpBinding> {
        self.bindings.lock().unwrap().clone()
    }

    pub fn allow_delegation_mcp(&self) -> bool {
        self.has_product("delegation")
    }

    pub fn allow_session_mcp(&self) -> bool {
        self.has_product("session")
    }

    pub fn allow_workflow_mcp(&self) -> bool {
        self.bindings().iter().any(|binding| {
            binding.binary_id == "vibex-workflow-mcp" || binding.product == "workflow"
        })
    }

    pub fn product_mcp_names(&self) -> Vec<String> {
        let mut names = Vec::new();
        if self.allow_delegation_mcp() {
            names.push(DELEGATION_MCP_NAME.to_string());
        }
        if self.allow_session_mcp() {
            names.push(SESSION_MCP_NAME.to_string());
        }
        names
    }

    pub fn set_session_features(&self, bits: u8) {
        self.session_features.store(bits, Ordering::SeqCst);
    }

    pub fn session_features(&self) -> u8 {
        if !self.allow_session_mcp() {
            return 0;
        }
        let bits = self.session_features.load(Ordering::SeqCst);
        if bits == 0 { SESSION_FEAT_ALL } else { bits }
    }

    pub fn delegation_token(&self) -> Option<String> {
        self.token_for_product("delegation")
    }

    pub fn session_token(&self) -> Option<String> {
        self.token_for_product("session")
    }

    pub fn token_for_product(&self, product: &str) -> Option<String> {
        self.bindings()
            .into_iter()
            .find(|binding| binding.product == product)
            .map(|binding| binding.token)
    }

    pub fn set_http_base(&self, base: Option<String>) {
        *self.http_base.lock().unwrap() = base;
    }

    pub fn http_base(&self) -> Option<String> {
        self.http_base.lock().unwrap().clone()
    }

    pub fn reset(&self) {
        self.bindings.lock().unwrap().clear();
        self.session_features.store(0, Ordering::SeqCst);
        *self.http_base.lock().unwrap() = None;
    }

    pub fn sync_from_plugins(&self, plugins: &[InstalledPlugin]) {
        let http_base = self.http_base();
        let previous = self.bindings();
        let mut bindings = Vec::new();
        let mut session_bits = 0u8;
        for plugin in plugins {
            if plugin.activation != PluginActivation::Enabled {
                continue;
            }
            if let Some(mut binding) = binding_from_plugin(plugin) {
                if binding.product == "session" {
                    session_bits = binding.features;
                }
                if binding.token.is_empty() {
                    binding.token = previous
                        .iter()
                        .find(|existing| {
                            existing.plugin_id == binding.plugin_id
                                && existing.product == binding.product
                        })
                        .map(|existing| existing.token.clone())
                        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                }
                bindings.push(binding);
            }
        }
        *self.bindings.lock().unwrap() = bindings;
        self.session_features.store(session_bits, Ordering::SeqCst);
        if let Some(base) = http_base {
            *self.http_base.lock().unwrap() = Some(base);
        }
    }

    /// Test helper: publish one binding without a package.
    pub fn publish_binding(&self, binding: OfficialMcpBinding) {
        if binding.product == "session" {
            self.session_features
                .store(binding.features, Ordering::SeqCst);
        }
        self.bindings.lock().unwrap().push(binding);
    }

    fn has_product(&self, product: &str) -> bool {
        self.bindings()
            .iter()
            .any(|binding| binding.product == product)
    }
}

fn binding_from_plugin(plugin: &InstalledPlugin) -> Option<OfficialMcpBinding> {
    let servers = plugin.mcp.get("mcpServers").unwrap_or(&plugin.mcp);
    let object = servers.as_object()?;
    for spec in object.values() {
        let Some(product) = host_family_product(spec) else {
            continue;
        };
        let binary_id = spec
            .get("managedRuntime")?
            .get("binaryId")?
            .as_str()?
            .to_owned();
        let config = live_plugin_config(plugin);
        return Some(OfficialMcpBinding {
            plugin_id: plugin.id().to_owned(),
            binary_id,
            product: product.to_owned(),
            features: if product == "session" {
                session_features_from_config(&config)
            } else {
                0
            },
            token: String::new(),
        });
    }
    None
}

/// Product key (`delegation`, `session`, `workflow`, `plugin-dev`) declared on a
/// `hostFamilyBinary` MCP resource.
pub fn host_family_product(spec: &Value) -> Option<&'static str> {
    let managed = spec.get("managedRuntime")?.as_object()?;
    if managed.get("kind").and_then(Value::as_str) != Some("hostFamilyBinary") {
        return None;
    }
    let binary_id = managed
        .get("binaryId")
        .and_then(Value::as_str)
        .unwrap_or("");
    match (managed.get("product").and_then(Value::as_str), binary_id) {
        (Some("session"), _) => Some("session"),
        (Some("delegation"), _) => Some("delegation"),
        (Some("workflow"), _) | (_, "vibex-workflow-mcp") => Some("workflow"),
        (Some("plugin-dev"), _) => Some("plugin-dev"),
        _ => None,
    }
}

/// Stable native/ACP MCP server name for an official `hostFamilyBinary` spec.
pub fn official_product_mcp_name(spec: &Value) -> Option<&'static str> {
    match host_family_product(spec)? {
        "session" => Some(SESSION_MCP_NAME),
        "delegation" => Some(DELEGATION_MCP_NAME),
        "plugin-dev" => Some(PLUGIN_DEV_MCP_NAME),
        "workflow" => Some(WORKFLOW_MCP_NAME),
        _ => None,
    }
}

/// Native-config identity written by the MCP manager. Official product MCPs keep
/// their ADR names so Grok `server__tool` titles and uninstall match injection.
pub fn projected_mcp_server_id(plugin_id: &str, server_id: &str, spec: &Value) -> String {
    official_product_mcp_name(spec)
        .map(str::to_string)
        .unwrap_or_else(|| format!("{plugin_id}.{server_id}"))
}

/// `--features` value consumed by `vibex-mcp`.
pub fn session_feature_arg(bits: u8) -> String {
    [
        (bits & SESSION_FEAT_FEEDBACK != 0, "feedback"),
        (bits & SESSION_FEAT_ASK != 0, "ask"),
        (bits & SESSION_FEAT_SESSIONS != 0, "sessions"),
        (bits & SESSION_FEAT_SESSION_CONTROL != 0, "session-control"),
    ]
    .into_iter()
    .filter_map(|(enabled, name)| enabled.then_some(name))
    .collect::<Vec<_>>()
    .join(",")
}

/// Static stdio spec projected into Agent native MCP files at plugin enable.
/// Session identity is not baked in; the Agent process inherits
/// `VIBEX_CONVERSATION_ID`, and ACP agents still get per-session `session/new`.
pub fn host_family_stdio_spec(
    command: &str,
    product: &str,
    features: &str,
    http_base: Option<&str>,
    token: Option<&str>,
) -> Value {
    if product == "workflow" {
        return serde_json::json!({
            "type": "stdio",
            "command": command,
            "args": []
        });
    }
    let mut args = vec![
        "--features".to_string(),
        features.to_string(),
        "--product".to_string(),
        product.to_string(),
    ];
    if let Some(url) = http_base.filter(|value| !value.is_empty()) {
        args.push("--server-url".to_string());
        args.push(url.to_string());
    }
    if let Some(token) = token.filter(|value| !value.is_empty()) {
        args.push("--server-token".to_string());
        args.push(token.to_string());
    }
    serde_json::json!({
        "type": "stdio",
        "command": command,
        "args": args,
    })
}

fn live_plugin_config(plugin: &InstalledPlugin) -> Value {
    std::fs::read_to_string(plugin.source.path.join("config.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| plugin.config.clone())
}

pub fn session_features_from_config(config: &Value) -> u8 {
    let flag = |name: &str, bit: u8| {
        if config.get(name).and_then(Value::as_bool) == Some(false) {
            0
        } else {
            bit
        }
    };
    flag("feedback", SESSION_FEAT_FEEDBACK)
        | flag("question", SESSION_FEAT_ASK)
        | flag("sessionInfo", SESSION_FEAT_SESSIONS)
        | flag("sessionControl", SESSION_FEAT_SESSION_CONTROL)
}

pub fn binding_has_delegation_mcp(mcp_servers_json: &str) -> bool {
    serde_json::from_str::<Vec<String>>(mcp_servers_json)
        .ok()
        .is_some_and(|names| names.iter().any(|name| name == DELEGATION_MCP_NAME))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use serde_json::json;

    use super::*;
    use crate::{PluginId, PluginPackage, PluginSourceKind};

    fn plugin(id: &str, mcp: Value, config: Value) -> InstalledPlugin {
        let mut package = PluginPackage::for_test(
            id,
            id,
            "1.0.0",
            PluginSourceKind::Builtin,
            &PathBuf::from("."),
        );
        package.id = PluginId::from_string(id.to_owned());
        package.mcp = mcp;
        package.config = config;
        InstalledPlugin {
            package,
            activation: PluginActivation::Enabled,
            package_digest: "sha256:test".into(),
        }
    }

    #[test]
    fn bindings_come_from_host_family_binary_not_plugin_id_match() {
        let runtime = OfficialMcpRuntime::default();
        runtime.sync_from_plugins(&[plugin(
            "acme.session",
            json!({
                "session": {
                    "managedRuntime": {
                        "kind": "hostFamilyBinary",
                        "binaryId": "vibex-mcp",
                        "product": "session"
                    }
                }
            }),
            json!({ "feedback": true, "question": false, "sessionInfo": true, "sessionControl": true }),
        )]);
        assert!(runtime.allow_session_mcp());
        assert!(!runtime.allow_delegation_mcp());
        assert_eq!(runtime.session_features() & SESSION_FEAT_ASK, 0);
        assert_ne!(runtime.session_features() & SESSION_FEAT_FEEDBACK, 0);
    }

    #[test]
    fn official_host_family_keeps_product_mcp_identity() {
        let spec = json!({
            "managedRuntime": {
                "kind": "hostFamilyBinary",
                "binaryId": "vibex-mcp",
                "product": "delegation"
            }
        });
        assert_eq!(host_family_product(&spec), Some("delegation"));
        assert_eq!(
            projected_mcp_server_id("vibex.multi-agent", "vibex-delegation-mcp", &spec),
            DELEGATION_MCP_NAME
        );
        assert_eq!(
            projected_mcp_server_id(
                "acme.tools",
                "search",
                &json!({ "command": "npx", "args": ["demo-mcp"] })
            ),
            "acme.tools.search"
        );
    }

    #[test]
    fn host_family_stdio_spec_is_plugin_lifetime_not_session_scoped() {
        let spec = host_family_stdio_spec(
            "/opt/vibex-mcp",
            "delegation",
            "delegation",
            Some("http://127.0.0.1:9"),
            Some("plugin-token"),
        );
        assert_eq!(spec["type"], "stdio");
        assert_eq!(spec["command"], "/opt/vibex-mcp");
        let args = spec["args"]
            .as_array()
            .expect("args")
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();
        assert_eq!(
            args,
            [
                "--features",
                "delegation",
                "--product",
                "delegation",
                "--server-url",
                "http://127.0.0.1:9",
                "--server-token",
                "plugin-token"
            ]
        );
        assert!(!args.contains(&"--conversation-id"));
        assert_eq!(
            host_family_stdio_spec("/opt/vibex-workflow-mcp", "workflow", "", None, None)["args"],
            json!([])
        );
    }

    #[test]
    fn sync_preserves_plugin_lifetime_token() {
        let runtime = OfficialMcpRuntime::default();
        let package = plugin(
            "vibex.multi-agent",
            json!({
                "vibex-delegation-mcp": {
                    "managedRuntime": {
                        "kind": "hostFamilyBinary",
                        "binaryId": "vibex-mcp",
                        "product": "delegation"
                    }
                }
            }),
            json!({}),
        );
        runtime.sync_from_plugins(&[package.clone()]);
        let first = runtime.delegation_token().expect("token");
        runtime.sync_from_plugins(&[package]);
        assert_eq!(runtime.delegation_token().as_deref(), Some(first.as_str()));
    }
}
