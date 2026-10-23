//! Official product MCP bindings published from enabled plugin packages.
//!
//! Injection reads this snapshot. Package identity is taken from declared
//! `hostFamilyBinary` MCP resources, not from a hardcoded plugin-id match.

use std::{
    collections::BTreeMap,
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicU8, Ordering},
    },
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

/// Sentinel binding id for the host MultiAgent setting. Not an official plugin.
pub const HOST_MULTI_AGENT_ID: &str = "host.multi-agent";

/// Scalars for the host MultiAgent setting. `completed_cache_max_mb` of 0 is unlimited.
#[derive(Clone, Debug)]
pub struct HostDelegationLimits {
    pub depth_limit: u32,
    pub completed_cache_max_mb: u64,
    pub conversation_list_default_days: u32,
    pub delay_max_hours: u32,
    pub agent_defaults: BTreeMap<String, (Option<String>, BTreeMap<String, String>)>,
}

impl Default for HostDelegationLimits {
    fn default() -> Self {
        Self {
            depth_limit: 1,
            completed_cache_max_mb: 512,
            conversation_list_default_days: 7,
            delay_max_hours: 24,
            agent_defaults: BTreeMap::new(),
        }
    }
}

/// Host-injected / native-projected MCP identity for session enhancement.
pub const SESSION_MCP_NAME: &str = "vibex-session-mcp";

/// Host-injected MCP identity for plugin development link requests.
pub const PLUGIN_DEV_MCP_NAME: &str = "vibex-plugin-dev-mcp";

/// Host-injected / native-projected MCP identity for Workflow Creator.
pub const WORKFLOW_MCP_NAME: &str = "vibex-workflow-mcp";

/// Grok `session/new` waits for every native `config.toml` MCP server using
/// `startup_timeout_sec` (default 30). Official product MCPs are also injected
/// per ACP session, so a stale Host URL must not freeze conversation create.
pub const HOST_FAMILY_MCP_STARTUP_TIMEOUT_SEC: u64 = 5;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OfficialMcpBinding {
    pub plugin_id: String,
    pub binary_id: String,
    pub product: String,
    pub features: u8,
    pub token: String,
}

/// ID-free capability snapshot for host UI consumers. Host code must branch on
/// these product capabilities, never on official plugin IDs (ADR-0069).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct OfficialProductMcpState {
    pub delegation: bool,
    pub feedback: bool,
    pub ask: bool,
    pub sessions: bool,
    pub session_control: bool,
}

#[derive(Debug, Default)]
pub struct OfficialMcpRuntime {
    bindings: Mutex<Vec<OfficialMcpBinding>>,
    session_features: AtomicU8,
    http_base: Mutex<Option<String>>,
    host_delegation: AtomicBool,
    host_limits_ready: AtomicBool,
    host_limits: Mutex<HostDelegationLimits>,
    host_delegation_token: Mutex<Option<String>>,
}

impl OfficialMcpRuntime {
    pub fn bindings(&self) -> Vec<OfficialMcpBinding> {
        self.bindings
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
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

    /// Snapshot of product capabilities derived from enabled-plugin bindings
    /// and session feature bits; the only sanctioned way for host UI to learn
    /// whether delegation mention or session features are available.
    pub fn capability_state(&self) -> OfficialProductMcpState {
        let session_bits = self.session_features();
        OfficialProductMcpState {
            delegation: self.allow_delegation_mcp(),
            feedback: session_bits & SESSION_FEAT_FEEDBACK != 0,
            ask: session_bits & SESSION_FEAT_ASK != 0,
            sessions: session_bits & SESSION_FEAT_SESSIONS != 0,
            session_control: session_bits & SESSION_FEAT_SESSION_CONTROL != 0,
        }
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
        *self.http_base.lock().unwrap_or_else(|p| p.into_inner()) = base;
    }

    pub fn http_base(&self) -> Option<String> {
        self.http_base
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    pub fn reset(&self) {
        self.host_delegation.store(false, Ordering::SeqCst);
        self.host_limits_ready.store(false, Ordering::SeqCst);
        *self.host_limits.lock().unwrap_or_else(|p| p.into_inner()) =
            HostDelegationLimits::default();
        *self
            .host_delegation_token
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = None;
        self.bindings
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
        self.session_features.store(0, Ordering::SeqCst);
        *self.http_base.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    /// Publish or withdraw the host delegation binding. A plugin package cannot
    /// open this gate.
    pub fn set_host_delegation(&self, enabled: bool, mut limits: HostDelegationLimits) {
        limits.depth_limit = limits.depth_limit.clamp(1, 8);
        limits.completed_cache_max_mb = limits.completed_cache_max_mb.min(1_000_000);
        limits.conversation_list_default_days = limits.conversation_list_default_days.clamp(1, 90);
        limits.delay_max_hours = limits.delay_max_hours.clamp(1, 168);
        self.host_delegation.store(enabled, Ordering::SeqCst);
        *self.host_limits.lock().unwrap_or_else(|p| p.into_inner()) = limits;
        self.host_limits_ready.store(true, Ordering::SeqCst);
        self.reinsert_host_delegation();
    }

    pub fn host_delegation_limits(&self) -> Option<HostDelegationLimits> {
        if !self.host_limits_ready.load(Ordering::SeqCst) {
            return None;
        }
        Some(
            self.host_limits
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone(),
        )
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
        *self.bindings.lock().unwrap_or_else(|p| p.into_inner()) = bindings;
        self.session_features.store(session_bits, Ordering::SeqCst);
        if let Some(base) = http_base {
            *self.http_base.lock().unwrap_or_else(|p| p.into_inner()) = Some(base);
        }
        self.reinsert_host_delegation();
    }

    fn reinsert_host_delegation(&self) {
        let enabled = self.host_delegation.load(Ordering::SeqCst);
        let mut token_slot = self
            .host_delegation_token
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let mut bindings = self.bindings.lock().unwrap_or_else(|p| p.into_inner());
        bindings.retain(|binding| binding.product != "delegation");
        if !enabled {
            return;
        }
        if token_slot.is_none() {
            *token_slot = Some(uuid::Uuid::new_v4().to_string());
        }
        let token = token_slot.clone().unwrap_or_default();
        bindings.push(OfficialMcpBinding {
            plugin_id: HOST_MULTI_AGENT_ID.to_owned(),
            binary_id: "vibex-mcp".to_owned(),
            product: "delegation".to_owned(),
            features: 0,
            token,
        });
    }

    /// Test helper: publish one binding without a package.
    pub fn publish_binding(&self, binding: OfficialMcpBinding) {
        if binding.product == "session" {
            self.session_features
                .store(binding.features, Ordering::SeqCst);
        }
        self.bindings
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(binding);
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
        // Delegation is a host setting. A leftover package must not open the gate.
        if product == "delegation" {
            continue;
        }
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

/// Product key (`delegation`, `session`, `workflow`) declared on a
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
        _ => None,
    }
}

/// Stable native/ACP MCP server name for an official `hostFamilyBinary` spec.
pub fn official_product_mcp_name(spec: &Value) -> Option<&'static str> {
    match host_family_product(spec)? {
        "session" => Some(SESSION_MCP_NAME),
        "delegation" => Some(DELEGATION_MCP_NAME),
        "workflow" => Some(WORKFLOW_MCP_NAME),
        _ => None,
    }
}

/// Native-config identity written by the MCP manager. Official product MCPs keep
/// their ADR names so Grok `server__tool` titles and uninstall match injection.
///
/// Grok session admission requires each MCP name segment to match
/// `[A-Za-z_][A-Za-z0-9_-]*`. Plugin ids contain `.`, so dotted names
/// handshake but then have every tool skipped.
pub fn projected_mcp_server_id(plugin_id: &str, server_id: &str, spec: &Value) -> String {
    sanitize_mcp_server_id(&raw_projected_mcp_server_id(plugin_id, server_id, spec))
}

/// Pre-sanitize identity previously written into Agent native files.
pub fn legacy_projected_mcp_server_id(plugin_id: &str, server_id: &str, spec: &Value) -> String {
    raw_projected_mcp_server_id(plugin_id, server_id, spec)
}

fn raw_projected_mcp_server_id(plugin_id: &str, server_id: &str, spec: &Value) -> String {
    official_product_mcp_name(spec)
        .map(str::to_string)
        .unwrap_or_else(|| format!("{plugin_id}.{server_id}"))
}

fn sanitize_mcp_server_id(id: &str) -> String {
    let mut out = String::with_capacity(id.len());
    for (index, character) in id.chars().enumerate() {
        let allowed = character.is_ascii_alphanumeric() || character == '_' || character == '-';
        let mapped = if allowed { character } else { '-' };
        if index == 0 && !mapped.is_ascii_alphabetic() && mapped != '_' {
            out.push('_');
            if mapped != '-' {
                out.push(mapped);
            }
        } else {
            out.push(mapped);
        }
    }
    out
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
            "args": [],
            "startup_timeout_sec": HOST_FAMILY_MCP_STARTUP_TIMEOUT_SEC,
        });
    }
    let mut args = vec![
        "--features".to_string(),
        features.to_string(),
        "--product".to_string(),
        product.to_string(),
        "--parent-pid".to_string(),
        std::process::id().to_string(),
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
        "startup_timeout_sec": HOST_FAMILY_MCP_STARTUP_TIMEOUT_SEC,
    })
}

/// Headline for the status-bar MCP popover.
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PluginMcpHeadline {
    Empty,
    Running,
    Partial,
    Stopped,
    Unavailable,
}

/// One advertised tool inside a plugin MCP server.
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMcpToolStatus {
    pub name: String,
    pub group: String,
}

/// One MCP server declared by a plugin.
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMcpServerStatus {
    pub id: String,
    pub product: Option<String>,
    pub tools: Vec<PluginMcpToolStatus>,
}

/// Plugin row in the status-bar MCP popover.
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMcpPluginStatus {
    pub plugin_id: String,
    pub name: String,
    pub description: Option<String>,
    pub enabled: bool,
    pub enable_supported: bool,
    pub mcp_count: u32,
    pub connection: String,
    pub servers: Vec<PluginMcpServerStatus>,
}

/// Snapshot consumed by the Host status-bar MCP indicator.
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMcpStatusReport {
    pub state: PluginMcpHeadline,
    pub listening: bool,
    pub plugins: Vec<PluginMcpPluginStatus>,
}

/// Tools an official product MCP advertises for the given feature bits.
pub fn advertised_mcp_tools(product: &str, features: u8) -> Vec<PluginMcpToolStatus> {
    let tool = |name: &str, group: &str| PluginMcpToolStatus {
        name: name.to_owned(),
        group: group.to_owned(),
    };
    match product {
        "delegation" => vec![
            tool("delegate_to_agent", "delegation"),
            tool("get_delegation_status", "delegation"),
            tool("cancel_delegation", "delegation"),
            tool("get_session_info", "collaboration"),
            tool("list_conversations", "collaboration"),
            tool("send_session_input", "collaboration"),
            tool("create_conversation", "collaboration"),
            tool("create_role", "collaboration"),
            tool("update_role", "collaboration"),
            tool("delete_role", "collaboration"),
            tool("list_roles", "collaboration"),
            tool("create_team", "collaboration"),
            tool("update_team", "collaboration"),
            tool("delete_team", "collaboration"),
            tool("list_teams", "collaboration"),
            tool("list_collaboration_spaces", "collaboration"),
            tool("list_space_members", "collaboration"),
            tool("create_collaboration_space", "collaboration"),
            tool("add_space_member", "collaboration"),
            tool("set_space_identity", "collaboration"),
            tool("post_to_space", "collaboration"),
            tool("handoff", "collaboration"),
            tool("memory_search", "collaboration"),
            tool("memory_write", "collaboration"),
            tool("list_space_messages", "collaboration"),
        ],
        "session" => {
            let mut tools = Vec::new();
            if features & SESSION_FEAT_FEEDBACK != 0 {
                tools.push(tool("check_user_feedback", "feedback"));
            }
            if features & SESSION_FEAT_ASK != 0 {
                tools.push(tool("ask_user_question", "ask"));
            }
            if features & SESSION_FEAT_SESSIONS != 0 {
                tools.push(tool("get_session_info", "sessions"));
            }
            if features & SESSION_FEAT_SESSION_CONTROL != 0 {
                tools.push(tool("send_session_input", "sessionControl"));
                tools.push(tool("cancel_session_turn", "sessionControl"));
            }
            tools
        }
        "workflow" => [
            "workflow_source_read",
            "workflow_source_write",
            "workflow_validate",
            "workflow_publish",
            "workflow_catalog",
            "workflow_start",
            "workflow_run_inspect",
            "workflow_debug_source",
            "workflow_debug_from_step",
            "workflow_pause_run",
            "workflow_resume_run",
            "workflow_cancel_run",
            "workflow_pause_step",
            "workflow_continue_step",
            "workflow_accept_candidate",
            "workflow_review_step",
            "workflow_decide_approval",
        ]
        .into_iter()
        .map(|name| tool(name, "workflow"))
        .collect(),
        _ => Vec::new(),
    }
}

pub(crate) fn advertised_tools_from_spec(spec: &Value) -> Vec<PluginMcpToolStatus> {
    let Some(tools) = spec.get("tools").and_then(Value::as_array) else {
        return Vec::new();
    };
    tools
        .iter()
        .filter_map(|tool| {
            if let Some(name) = tool.as_str() {
                let name = name.trim();
                if name.is_empty() {
                    return None;
                }
                return Some(PluginMcpToolStatus {
                    name: name.to_owned(),
                    group: "mcp".to_owned(),
                });
            }
            let name = tool.get("name").and_then(Value::as_str)?.trim();
            if name.is_empty() {
                return None;
            }
            let group = tool
                .get("group")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("mcp");
            Some(PluginMcpToolStatus {
                name: name.to_owned(),
                group: group.to_owned(),
            })
        })
        .collect()
}

/// Build the status-bar snapshot from installed plugins.
///
/// `binary_runnable` answers whether a Host-family binary id is a real
/// executable (non-empty). Missing binaries mark the plugin unavailable.
pub fn plugin_mcp_status_report(
    plugins: &[InstalledPlugin],
    binary_runnable: impl Fn(&str) -> bool,
) -> PluginMcpStatusReport {
    let mut rows = plugins
        .iter()
        .filter_map(|plugin| plugin_mcp_row(plugin, &binary_runnable))
        .collect::<Vec<_>>();
    rows.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.plugin_id.cmp(&right.plugin_id))
    });

    let state = if rows.is_empty() {
        PluginMcpHeadline::Empty
    } else if rows.iter().any(|row| row.connection == "unavailable") {
        PluginMcpHeadline::Unavailable
    } else if rows.iter().all(|row| row.connection == "disabled") {
        PluginMcpHeadline::Stopped
    } else if rows
        .iter()
        .filter(|row| row.enabled)
        .all(|row| row.connection == "running")
        && rows.iter().any(|row| row.enabled)
    {
        PluginMcpHeadline::Running
    } else {
        PluginMcpHeadline::Partial
    };

    PluginMcpStatusReport {
        state,
        listening: false,
        plugins: rows,
    }
}

fn plugin_mcp_row(
    plugin: &InstalledPlugin,
    binary_runnable: &impl Fn(&str) -> bool,
) -> Option<PluginMcpPluginStatus> {
    let live_mcp = live_plugin_mcp(plugin);
    let servers_value = live_mcp.get("mcpServers").unwrap_or(&live_mcp);
    let object = servers_value.as_object()?;
    if object.is_empty() {
        return None;
    }
    let config = live_plugin_config(plugin);
    let mut servers = Vec::new();
    let mut needs_binary: Option<String> = None;
    for (id, spec) in object {
        let admitted = crate::plugin_mcp::admit_plugin_mcp(plugin.id(), id, spec, &config);
        if admitted.kind == crate::plugin_mcp::PluginMcpKind::HostFamily {
            let binary_id = spec
                .get("managedRuntime")
                .and_then(|value| value.get("binaryId"))
                .and_then(Value::as_str)
                .unwrap_or("vibex-mcp");
            needs_binary = Some(binary_id.to_owned());
        }
        servers.push(PluginMcpServerStatus {
            id: admitted.server_id,
            product: admitted.product,
            tools: admitted.tools,
        });
    }
    servers.sort_by(|left, right| left.id.cmp(&right.id));
    let enabled = plugin.activation == PluginActivation::Enabled;
    let connection = if !enabled {
        "disabled"
    } else if needs_binary
        .as_deref()
        .is_some_and(|binary_id| !binary_runnable(binary_id))
    {
        "unavailable"
    } else {
        "running"
    };
    Some(PluginMcpPluginStatus {
        plugin_id: plugin.id().to_owned(),
        name: plugin.name.clone(),
        description: plugin.description.clone(),
        enabled,
        enable_supported: true,
        mcp_count: servers.len() as u32,
        connection: connection.to_owned(),
        servers,
    })
}

pub(crate) fn live_plugin_mcp(plugin: &InstalledPlugin) -> Value {
    plugin.package.mcp.clone()
}

pub(crate) fn live_plugin_config(plugin: &InstalledPlugin) -> Value {
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
    fn capability_state_reflects_products_not_plugin_ids() {
        let runtime = OfficialMcpRuntime::default();
        assert_eq!(
            runtime.capability_state(),
            OfficialProductMcpState::default()
        );

        runtime.publish_binding(OfficialMcpBinding {
            plugin_id: "any.publisher.delegation".to_owned(),
            binary_id: "vibex-mcp".to_owned(),
            product: "delegation".to_owned(),
            features: 0,
            token: "t".to_owned(),
        });
        let state = runtime.capability_state();
        assert!(state.delegation);
        assert!(
            !state.feedback,
            "session features stay off without a session product"
        );

        runtime.publish_binding(OfficialMcpBinding {
            plugin_id: "any.publisher.session".to_owned(),
            binary_id: "vibex-mcp".to_owned(),
            product: "session".to_owned(),
            features: SESSION_FEAT_ASK,
            token: "t".to_owned(),
        });
        let state = runtime.capability_state();
        assert!(state.ask);
        assert!(
            !state.feedback,
            "config-disabled feedback must not report on"
        );

        runtime.reset();
        assert_eq!(
            runtime.capability_state(),
            OfficialProductMcpState::default()
        );
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
            "acme-tools-search"
        );
        assert_eq!(
            projected_mcp_server_id(
                "vibex.open-connector",
                "mcp",
                &json!({
                    "managedRuntime": { "kind": "workerHttp", "handler": "mcp.endpoint" }
                })
            ),
            "vibex-open-connector-mcp"
        );
        assert_eq!(
            legacy_projected_mcp_server_id("vibex.open-connector", "mcp", &json!({})),
            "vibex.open-connector.mcp"
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
            args[0..4],
            ["--features", "delegation", "--product", "delegation"]
        );
        assert!(args.contains(&"--parent-pid"));
        assert!(args.contains(&"--server-url"));
        assert!(args.contains(&"--server-token"));
        assert!(!args.contains(&"--conversation-id"));
        assert_eq!(
            spec["startup_timeout_sec"],
            json!(HOST_FAMILY_MCP_STARTUP_TIMEOUT_SEC)
        );
        let workflow =
            host_family_stdio_spec("/opt/vibex-workflow-mcp", "workflow", "", None, None);
        assert_eq!(workflow["args"], json!([]));
        assert_eq!(
            workflow["startup_timeout_sec"],
            json!(HOST_FAMILY_MCP_STARTUP_TIMEOUT_SEC)
        );
    }

    #[test]
    fn host_delegation_survives_plugin_sync_and_ignores_packages() {
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
        runtime.sync_from_plugins(std::slice::from_ref(&package));
        assert!(runtime.delegation_token().is_none());
        assert!(!runtime.allow_delegation_mcp());

        runtime.set_host_delegation(true, HostDelegationLimits::default());
        let first = runtime.delegation_token().expect("token");
        assert_eq!(
            runtime
                .bindings()
                .iter()
                .find(|binding| binding.product == "delegation")
                .map(|binding| binding.plugin_id.as_str()),
            Some(HOST_MULTI_AGENT_ID)
        );
        runtime.sync_from_plugins(&[package]);
        assert_eq!(runtime.delegation_token().as_deref(), Some(first.as_str()));
        assert_eq!(
            runtime
                .bindings()
                .iter()
                .filter(|binding| binding.product == "delegation")
                .count(),
            1
        );

        runtime.set_host_delegation(false, HostDelegationLimits::default());
        assert!(!runtime.allow_delegation_mcp());
        assert!(runtime.host_delegation_limits().is_some());
    }

    #[test]
    fn status_report_groups_tools_by_plugin_and_skips_empty_binaries() {
        let enabled = plugin(
            "acme.delegation",
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
        let mut disabled = plugin(
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
            json!({ "question": false }),
        );
        disabled.activation = PluginActivation::Disabled;

        let report = plugin_mcp_status_report(&[enabled, disabled], |binary| binary != "vibex-mcp");
        assert_eq!(report.state, PluginMcpHeadline::Unavailable);
        assert_eq!(report.plugins.len(), 2);
        assert_eq!(report.plugins[0].plugin_id, "acme.delegation");
        assert_eq!(report.plugins[0].connection, "unavailable");
        assert_eq!(report.plugins[0].mcp_count, 1);
        let tools = &report.plugins[0].servers[0].tools;
        assert_eq!(tools, &advertised_mcp_tools("delegation", 0));
        for name in [
            "cancel_session_turn",
            "wait_for_session",
            "ask_user_question",
            "check_inbox",
            "fetch_inbox",
        ] {
            assert!(tools.iter().all(|tool| tool.name != name), "{name}");
        }
        assert_eq!(report.plugins[1].connection, "disabled");
        assert!(
            report.plugins[1]
                .servers
                .iter()
                .flat_map(|server| &server.tools)
                .all(|tool| tool.name != "ask_user_question")
        );

        let running = plugin_mcp_status_report(
            std::slice::from_ref(&plugin(
                "acme.delegation",
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
            )),
            |_| true,
        );
        assert_eq!(running.state, PluginMcpHeadline::Running);
        assert_eq!(running.plugins[0].connection, "running");
    }

    #[test]
    fn worker_http_status_lists_declared_tools() {
        let report = plugin_mcp_status_report(
            std::slice::from_ref(&plugin(
                "acme.connector",
                json!({
                    "mcp": {
                        "managedRuntime": {
                            "kind": "workerHttp",
                            "handler": "mcp.endpoint"
                        },
                        "tools": [
                            { "name": "list_apps", "group": "open-connector" },
                            "search_actions"
                        ]
                    }
                }),
                json!({}),
            )),
            |_| true,
        );
        assert_eq!(report.plugins[0].servers[0].id, "acme-connector-mcp");
        assert_eq!(
            report.plugins[0].servers[0]
                .tools
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>(),
            ["list_apps", "search_actions"]
        );
    }
}
