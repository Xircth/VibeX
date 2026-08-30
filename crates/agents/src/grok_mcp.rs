//! Peel Grok's generic MCP envelope so Host companion tools classify as
//! themselves instead of a pending `use_tool` card.
//!
//! Grok never advertises injected MCP tools as first-class ACP names. Every
//! MCP invocation is:
//!
//! ```json
//! { "title": "use_tool", "rawInput": { "tool_name": "<server>__<tool>", "tool_input": {…} } }
//! ```
//!
//! and `_meta["x.ai/tool"].name` stays `"use_tool"`. Without peeling, the
//! conversation timeline cannot match `delegate_to_agent`, and the broker
//! cannot correlate the parent tool call with the child session.
//!
//! Output is a second envelope: `{ "type": "MCP", "output": { "OkayOutput": "…" } }`.
//! Sparse `tool_call_update` frames often omit `rawInput` and revert the title
//! to `use_tool`; remembered inner names are re-asserted for those frames.

use std::collections::HashMap;

use serde_json::Value;

/// Generic MCP dispatcher Grok reports as the ACP tool title / vendor name.
pub const USE_TOOL_NAME: &str = "use_tool";

#[derive(Debug, Clone, PartialEq)]
pub struct PeeledGrokMcpCall {
    pub title: String,
    pub raw_input: Option<Value>,
    pub output_text: Option<String>,
    pub peeled_input: bool,
}

#[derive(Debug, Default)]
pub struct GrokMcpTracker {
    titles: HashMap<String, String>,
}

impl GrokMcpTracker {
    pub fn apply(
        &mut self,
        call_id: &str,
        wire_title: Option<&str>,
        raw_input: Option<&Value>,
        raw_output: Option<&Value>,
    ) -> PeeledGrokMcpCall {
        let output_text = raw_output.and_then(grok_mcp_output_text);
        if let Some((name, inner)) = unwrap_grok_use_tool(raw_input) {
            let title = mcp_bare_tool_name(&name).to_string();
            self.titles.insert(call_id.to_string(), title.clone());
            return PeeledGrokMcpCall {
                title,
                raw_input: Some(inner),
                output_text,
                peeled_input: true,
            };
        }

        let wire = wire_title.unwrap_or("").trim();
        let title = self
            .titles
            .get(call_id)
            .cloned()
            .filter(|remembered| !remembered.is_empty() && !is_use_tool_name(remembered))
            .or_else(|| (!wire.is_empty() && !is_use_tool_name(wire)).then(|| wire.to_string()))
            .or_else(|| (!wire.is_empty()).then(|| wire.to_string()))
            .unwrap_or_else(|| call_id.to_string());

        PeeledGrokMcpCall {
            title,
            raw_input: raw_input.cloned(),
            output_text,
            peeled_input: false,
        }
    }
}

/// Peel `{ "tool_name": "<server>__<tool>", "tool_input": {…} }` into the inner
/// MCP call. Native Grok tools carry their args at the top level and pass
/// through as `None`.
pub fn unwrap_grok_use_tool(raw_input: Option<&Value>) -> Option<(String, Value)> {
    let obj = raw_input?.as_object()?;
    let tool_name = obj
        .get("tool_name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())?;
    let tool_input = obj.get("tool_input")?.clone();
    Some((tool_name.to_string(), tool_input))
}

/// Extract the human-readable MCP result from Grok's `{type:"MCP", output:…}`
/// wrapper. Returns `None` for non-MCP output so callers fall through.
pub fn grok_mcp_output_text(raw_output: &Value) -> Option<String> {
    if raw_output.get("type").and_then(Value::as_str) != Some("MCP") {
        return None;
    }
    let output = raw_output.get("output")?;
    if let Some(text) = output.as_str() {
        return (!text.is_empty()).then(|| text.to_string());
    }
    output.as_object()?.values().find_map(|value| {
        value
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    })
}

pub fn is_use_tool_name(name: &str) -> bool {
    name.trim().eq_ignore_ascii_case(USE_TOOL_NAME)
}

/// Last segment of a host-prefixed MCP name (`mcp__server__tool`, `server/tool`).
pub fn mcp_bare_tool_name(name: &str) -> &str {
    let trimmed = name.trim();
    let stripped = trimmed
        .strip_prefix("mcp__")
        .or_else(|| trimmed.strip_prefix("MCP__"))
        .unwrap_or(trimmed);
    stripped
        .rsplit(['/', ':'])
        .next()
        .and_then(|segment| segment.rsplit("__").next())
        .unwrap_or(stripped)
}

/// Whether an update should re-assert `peeled.title` so a later `use_tool`
/// frame cannot revert the Host delegation card.
pub fn should_rewrite_title(wire_title: Option<&str>, peeled_title: &str) -> bool {
    if peeled_title.is_empty() || is_use_tool_name(peeled_title) {
        return false;
    }
    match wire_title.map(str::trim).filter(|title| !title.is_empty()) {
        None => true,
        Some(wire) => is_use_tool_name(wire) || wire != peeled_title,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn peels_the_use_tool_envelope_to_the_inner_mcp_name() {
        let peeled = unwrap_grok_use_tool(Some(&json!({
            "tool_name": "vibex-delegation-mcp__delegate_to_agent",
            "tool_input": { "agent_type": "codex", "task": "introduce yourself" }
        })));
        assert_eq!(
            peeled,
            Some((
                "vibex-delegation-mcp__delegate_to_agent".into(),
                json!({ "agent_type": "codex", "task": "introduce yourself" })
            ))
        );
    }

    #[test]
    fn native_grok_tools_are_not_treated_as_envelopes() {
        assert_eq!(
            unwrap_grok_use_tool(Some(&json!({ "command": "ls", "path": "/tmp" }))),
            None
        );
        assert_eq!(
            unwrap_grok_use_tool(Some(&json!({ "tool_name": "delegate_to_agent" }))),
            None
        );
        assert_eq!(unwrap_grok_use_tool(None), None);
    }

    #[test]
    fn extracts_mcp_okay_output_and_ignores_native_output() {
        assert_eq!(
            grok_mcp_output_text(&json!({
                "type": "MCP",
                "output": { "OkayOutput": "Delegation successful. task_id=abc" }
            }))
            .as_deref(),
            Some("Delegation successful. task_id=abc")
        );
        assert_eq!(
            grok_mcp_output_text(&json!({
                "type": "MCP",
                "output": { "Empty": "", "OkayOutput": "{\"status\":\"running\"}" }
            }))
            .as_deref(),
            Some("{\"status\":\"running\"}")
        );
        assert_eq!(grok_mcp_output_text(&json!({ "stdout": "hello" })), None);
    }

    #[test]
    fn tracker_rewrites_title_and_remembers_it_for_sparse_updates() {
        let mut tracker = GrokMcpTracker::default();
        let first = tracker.apply(
            "call-1",
            Some("use_tool"),
            Some(&json!({
                "tool_name": "vibex-delegation-mcp__delegate_to_agent",
                "tool_input": { "agent_type": "codex", "task": "hi" }
            })),
            None,
        );
        assert_eq!(first.title, "delegate_to_agent");
        assert_eq!(
            first.raw_input,
            Some(json!({ "agent_type": "codex", "task": "hi" }))
        );
        assert!(first.peeled_input);
        assert!(should_rewrite_title(Some("use_tool"), &first.title));

        let sparse = tracker.apply("call-1", Some("use_tool"), None, None);
        assert_eq!(sparse.title, "delegate_to_agent");
        assert!(!sparse.peeled_input);
        assert!(should_rewrite_title(Some("use_tool"), &sparse.title));
        assert!(!should_rewrite_title(
            Some("delegate_to_agent"),
            &sparse.title
        ));
    }

    #[test]
    fn tracker_does_not_invent_an_envelope_for_unrelated_tools() {
        let mut tracker = GrokMcpTracker::default();
        let peeled = tracker.apply(
            "call-2",
            Some("read_file"),
            Some(&json!({ "target_file": "README.md" })),
            None,
        );
        assert_eq!(peeled.title, "read_file");
        assert_eq!(
            peeled.raw_input,
            Some(json!({ "target_file": "README.md" }))
        );
        assert!(!peeled.peeled_input);
        assert!(!should_rewrite_title(Some("read_file"), &peeled.title));
    }

    #[test]
    fn strips_host_prefixes_from_mcp_tool_names() {
        assert_eq!(
            mcp_bare_tool_name("vibex-delegation-mcp__delegate_to_agent"),
            "delegate_to_agent"
        );
        assert_eq!(
            mcp_bare_tool_name("mcp__vibex-delegation-mcp__get_delegation_status"),
            "get_delegation_status"
        );
        assert_eq!(
            mcp_bare_tool_name("vibex-delegation-mcp/cancel_delegation"),
            "cancel_delegation"
        );
    }
}
