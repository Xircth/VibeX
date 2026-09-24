//! Host admission for plugin `content.mcp`.
//!
//! Status snapshots, Agent projection, CLI, and tests go through this seam so
//! a plugin MCP is declared once and then discoverable and callable.

use serde_json::Value;

use crate::official_mcp::{
    advertised_mcp_tools, advertised_tools_from_spec, host_family_product, live_plugin_config,
    live_plugin_mcp, official_product_mcp_name, projected_mcp_server_id,
    session_features_from_config, SESSION_FEAT_ALL,
};
use crate::{InstalledPlugin, PluginMcpToolStatus};

/// How the Host starts a plugin MCP after admission.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PluginMcpKind {
    HostFamily,
    WorkerHttp,
    PackagedStdio,
    StaticStdio,
}

/// One `content.mcp` resource after Host admission.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginMcpAdmission {
    pub plugin_id: String,
    pub contribution_id: String,
    pub server_id: String,
    pub kind: PluginMcpKind,
    pub product: Option<String>,
    pub tools: Vec<PluginMcpToolStatus>,
}

/// Admit a single MCP resource into the Host MCP manager.
pub fn admit_plugin_mcp(
    plugin_id: &str,
    contribution_id: &str,
    spec: &Value,
    config: &Value,
) -> PluginMcpAdmission {
    let product = host_family_product(spec).map(str::to_owned);
    let kind = mcp_kind(spec, product.as_deref());
    let tools = if let Some(product) = product.as_deref() {
        let features = if product == "session" {
            session_features_from_config(config)
        } else {
            SESSION_FEAT_ALL
        };
        advertised_mcp_tools(product, features)
    } else {
        advertised_tools_from_spec(spec)
    };
    let server_id = official_product_mcp_name(spec)
        .map(str::to_owned)
        .unwrap_or_else(|| projected_mcp_server_id(plugin_id, contribution_id, spec));
    PluginMcpAdmission {
        plugin_id: plugin_id.to_owned(),
        contribution_id: contribution_id.to_owned(),
        server_id,
        kind,
        product,
        tools,
    }
}

/// Admit every MCP resource declared by an installed plugin.
pub fn admit_plugin_mcp_servers(plugin: &InstalledPlugin) -> Vec<PluginMcpAdmission> {
    let live = live_plugin_mcp(plugin);
    let servers = live.get("mcpServers").unwrap_or(&live);
    let Some(object) = servers.as_object() else {
        return Vec::new();
    };
    let config = live_plugin_config(plugin);
    let mut rows = object
        .iter()
        .map(|(id, spec)| admit_plugin_mcp(plugin.id(), id, spec, &config))
        .collect::<Vec<_>>();
    rows.sort_by(|left, right| {
        left.server_id
            .cmp(&right.server_id)
            .then_with(|| left.contribution_id.cmp(&right.contribution_id))
    });
    rows
}

fn mcp_kind(spec: &Value, product: Option<&str>) -> PluginMcpKind {
    if product.is_some() {
        return PluginMcpKind::HostFamily;
    }
    let managed = spec.get("managedRuntime");
    match managed
        .and_then(|value| value.get("kind"))
        .and_then(Value::as_str)
    {
        Some("workerHttp") => PluginMcpKind::WorkerHttp,
        Some("hostFamilyBinary") => PluginMcpKind::HostFamily,
        _ if managed
            .and_then(|value| value.get("entrypoint"))
            .and_then(Value::as_str)
            .is_some() =>
        {
            PluginMcpKind::PackagedStdio
        }
        _ => PluginMcpKind::StaticStdio,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn host_family_admission_uses_the_product_catalog() {
        let admitted = admit_plugin_mcp(
            "acme.delegation",
            "vibex-delegation-mcp",
            &json!({
                "managedRuntime": {
                    "kind": "hostFamilyBinary",
                    "binaryId": "vibex-mcp",
                    "product": "delegation"
                }
            }),
            &json!({}),
        );
        assert_eq!(admitted.kind, PluginMcpKind::HostFamily);
        assert_eq!(admitted.server_id, "vibex-delegation-mcp");
        assert_eq!(
            admitted
                .tools
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>(),
            ["delegate_to_agent", "get_delegation_status", "cancel_delegation"]
        );
    }

    #[test]
    fn packaged_stdio_admission_reads_declared_tools() {
        let admitted = admit_plugin_mcp(
            "acme.browser",
            "browser-tools",
            &json!({
                "managedRuntime": {
                    "entrypoint": "runtime/mcp-server.mjs",
                    "protocolRevision": "2026-07-28"
                },
                "tools": [
                    { "name": "browser_list_tabs", "group": "browser" },
                    "browser_snapshot"
                ]
            }),
            &json!({}),
        );
        assert_eq!(admitted.kind, PluginMcpKind::PackagedStdio);
        assert_eq!(admitted.server_id, "acme-browser-browser-tools");
        assert_eq!(
            admitted
                .tools
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>(),
            ["browser_list_tabs", "browser_snapshot"]
        );
    }

    #[test]
    fn static_stdio_without_tools_stays_admitted() {
        let admitted = admit_plugin_mcp(
            "acme.legacy",
            "mcp",
            &json!({
                "command": "node",
                "args": ["runtime/mcp-server.mjs"]
            }),
            &json!({}),
        );
        assert_eq!(admitted.kind, PluginMcpKind::StaticStdio);
        assert!(admitted.tools.is_empty());
    }
}
