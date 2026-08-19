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
                    binding.token = uuid::Uuid::new_v4().to_string();
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
        let managed = spec.get("managedRuntime")?.as_object()?;
        if managed.get("kind").and_then(Value::as_str) != Some("hostFamilyBinary") {
            continue;
        }
        let binary_id = managed.get("binaryId")?.as_str()?.to_owned();
        let declared = managed.get("product").and_then(Value::as_str);
        let product = match (declared, binary_id.as_str()) {
            (Some("session" | "delegation" | "workflow"), _) => declared.unwrap().to_owned(),
            (_, "vibex-workflow-mcp") => "workflow".into(),
            _ => continue,
        };
        return Some(OfficialMcpBinding {
            plugin_id: plugin.id().to_owned(),
            binary_id,
            product: product.clone(),
            features: if product == "session" {
                session_features_from_config(&plugin.config)
            } else {
                0
            },
            token: String::new(),
        });
    }
    None
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
}
