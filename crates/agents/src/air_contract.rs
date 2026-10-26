//! Read the AIR tool-call contract that claude-agent-acp 0.82+ and
//! codex-acp 2.0+ put on the wire, back into the shapes the rest of VibeX
//! already reads.
//!
//! Advertising `_meta.jetbrains.air` makes the host an AIR client. From those
//! releases on, adapters merge `_meta` (an update omits unchanged keys) and
//! move several records under `jetbrains.air`. This module folds frames and
//! re-derives the legacy keys.

use std::collections::{HashMap, VecDeque};

use api_types::AgentKind;
use serde_json::{Map, Value};

/// Whether this agent speaks the AIR tool-call contract — the two adapters
/// `build_client_capabilities` declares `_meta.jetbrains.air` to.
pub(crate) fn speaks_air_contract(agent_kind: AgentKind) -> bool {
    matches!(agent_kind, AgentKind::ClaudeCode | AgentKind::Codex)
}

/// `_meta.jetbrains.air.<key>`, wherever the adapter put its AIR payload.
pub(crate) fn air_meta_value<'a>(
    meta: Option<&'a Map<String, Value>>,
    key: &str,
) -> Option<&'a Value> {
    meta?.get("jetbrains")?.get("air")?.get(key)
}

/// A moved session-level key: the legacy top-level spelling first, then AIR.
pub(crate) fn legacy_or_air<'a>(
    meta: Option<&'a Map<String, Value>>,
    key: &str,
) -> Option<&'a Value> {
    meta.and_then(|m| m.get(key))
        .or_else(|| air_meta_value(meta, key))
}

const FRAME_DATA_KEYS: [&str; 5] = [
    "terminal_output",
    "terminal_output_delta",
    "terminal_exit",
    "terminal_input",
    "mcp_output_delta",
];

fn merges_per_key(agent_kind: AgentKind) -> bool {
    agent_kind == AgentKind::ClaudeCode
}

fn merge_state(agent_kind: AgentKind, state: &mut Map<String, Value>, frame: &Map<String, Value>) {
    for (key, value) in frame {
        if FRAME_DATA_KEYS.contains(&key.as_str()) {
            continue;
        }
        if merges_per_key(agent_kind) {
            if key == "claudeCode"
                && let (Some(incoming), Some(held)) = (
                    value.as_object(),
                    state
                        .entry(key.clone())
                        .or_insert_with(|| Value::Object(Map::new()))
                        .as_object_mut(),
                )
            {
                for (k, v) in incoming {
                    held.insert(k.clone(), v.clone());
                }
                continue;
            }
            if key == "jetbrains"
                && let (Some(incoming_air), Some(held)) = (
                    value.get("air").and_then(Value::as_object),
                    state
                        .entry(key.clone())
                        .or_insert_with(|| Value::Object(Map::new()))
                        .as_object_mut(),
                )
            {
                if let Some(incoming) = value.as_object() {
                    for (k, v) in incoming {
                        if k != "air" {
                            held.insert(k.clone(), v.clone());
                        }
                    }
                }
                if let Some(held_air) = held
                    .entry("air")
                    .or_insert_with(|| Value::Object(Map::new()))
                    .as_object_mut()
                {
                    for (k, v) in incoming_air {
                        held_air.insert(k.clone(), v.clone());
                    }
                }
                continue;
            }
        }
        state.insert(key.clone(), value.clone());
    }
}

/// Re-derive the legacy `_meta` keys VibeX reads from the AIR spellings.
/// Never overwrites a key that is already there.
pub(crate) fn translate_air_meta(agent_kind: AgentKind, meta: &mut Map<String, Value>) {
    let Some(air) = meta
        .get("jetbrains")
        .and_then(|jetbrains| jetbrains.get("air"))
        .and_then(Value::as_object)
        .cloned()
    else {
        return;
    };
    if let Some(compaction) = air.get("contextCompaction").filter(|v| v.is_object()) {
        meta.entry("contextCompaction")
            .or_insert_with(|| compaction.clone());
    }
    if agent_kind != AgentKind::ClaudeCode {
        return;
    }
    let mut derived = Map::new();
    if let Some(title) = air.get("commandTitle").filter(|v| v.is_string()) {
        derived.insert("title".to_string(), title.clone());
    }
    if air.get("subagent") == Some(&Value::Bool(true)) {
        derived.insert("subagent".to_string(), Value::Bool(true));
    }
    if let Some(skill) = air.get("skill") {
        if let Some(name) = skill.get("name").filter(|v| v.is_string()) {
            derived.insert("skill".to_string(), name.clone());
        }
        if let Some(path) = skill.get("path").filter(|v| v.is_string()) {
            derived.insert("skillPath".to_string(), path.clone());
        }
    }
    if derived.is_empty() {
        return;
    }
    let Some(claude) = meta
        .entry("claudeCode")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
    else {
        return;
    };
    for (key, value) in derived {
        claude.entry(key).or_insert(value);
    }
}

/// Merged `_meta` of every in-flight tool call. AIR updates omit unchanged
/// keys; replacing the stored map would drop `claudeCode.toolName` /
/// `parentToolUseId` mid-flight.
#[derive(Debug, Default)]
pub(crate) struct ToolCallMetaLedger {
    entries: HashMap<String, LedgerEntry>,
    order: VecDeque<(u64, String)>,
    next_stamp: u64,
}

#[derive(Debug)]
struct LedgerEntry {
    stamp: u64,
    state: Map<String, Value>,
}

impl ToolCallMetaLedger {
    const CAPACITY: usize = 4096;

    pub(crate) fn open(
        &mut self,
        agent_kind: AgentKind,
        id: &str,
        frame: Option<Map<String, Value>>,
    ) -> Option<Map<String, Value>> {
        if !speaks_air_contract(agent_kind) {
            return frame;
        }
        let mut state = Map::new();
        if let Some(frame) = frame.as_ref() {
            merge_state(agent_kind, &mut state, frame);
        }
        self.store(id, state);
        frame.map(|mut meta| {
            translate_air_meta(agent_kind, &mut meta);
            meta
        })
    }

    pub(crate) fn update(
        &mut self,
        agent_kind: AgentKind,
        id: &str,
        frame: Option<Map<String, Value>>,
    ) -> Option<Map<String, Value>> {
        if !speaks_air_contract(agent_kind) {
            return frame;
        }
        let mut state = self
            .entries
            .remove(id)
            .map(|entry| entry.state)
            .unwrap_or_default();
        if let Some(frame) = frame.as_ref() {
            merge_state(agent_kind, &mut state, frame);
        }
        if state.is_empty() && frame.is_none() {
            return None;
        }
        let mut effective = state.clone();
        self.store(id, state);
        if let Some(frame) = frame.as_ref() {
            for key in FRAME_DATA_KEYS {
                if let Some(value) = frame.get(key) {
                    effective.insert(key.to_string(), value.clone());
                }
            }
        }
        translate_air_meta(agent_kind, &mut effective);
        Some(effective)
    }

    /// Fold `incoming` into a card that already holds previous `_meta`.
    /// Used by JSONL replay, which has the prior map on the projected card.
    pub(crate) fn fold_stored(
        agent_kind: AgentKind,
        previous: Option<Map<String, Value>>,
        frame: Option<Map<String, Value>>,
    ) -> Option<Map<String, Value>> {
        if !speaks_air_contract(agent_kind) {
            return frame.or(previous);
        }
        let mut state = previous.unwrap_or_default();
        if let Some(frame) = frame.as_ref() {
            merge_state(agent_kind, &mut state, frame);
        }
        if state.is_empty() && frame.is_none() {
            return None;
        }
        let mut effective = state;
        if let Some(frame) = frame.as_ref() {
            for key in FRAME_DATA_KEYS {
                if let Some(value) = frame.get(key) {
                    effective.insert(key.to_string(), value.clone());
                }
            }
        }
        translate_air_meta(agent_kind, &mut effective);
        Some(effective)
    }

    fn store(&mut self, id: &str, state: Map<String, Value>) {
        self.next_stamp += 1;
        let stamp = self.next_stamp;
        self.entries
            .insert(id.to_string(), LedgerEntry { stamp, state });
        self.order.push_back((stamp, id.to_string()));
        while self.entries.len() > Self::CAPACITY {
            let Some((stamp, id)) = self.order.pop_front() else {
                break;
            };
            if self
                .entries
                .get(&id)
                .is_some_and(|entry| entry.stamp == stamp)
            {
                self.entries.remove(&id);
            }
        }
        if self.order.len() > Self::CAPACITY * 4 {
            let entries = &self.entries;
            self.order
                .retain(|(stamp, id)| entries.get(id).is_some_and(|entry| entry.stamp == *stamp));
        }
    }
}

/// Permission presentation record of `session/request_permission`.
pub(crate) fn permission_record(meta: Option<&Map<String, Value>>) -> Option<&Value> {
    legacy_or_air(meta, "permission")
}

/// Copy the request-level permission record onto the tool-call payload the
/// permission card already reads.
pub(crate) fn hoist_request_permission_meta(
    tool_call: &mut Value,
    request_meta: Option<&Map<String, Value>>,
) {
    let Some(permission) = permission_record(request_meta) else {
        return;
    };
    let Some(obj) = tool_call.as_object_mut() else {
        return;
    };
    let meta = obj
        .entry("_meta")
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(meta) = meta.as_object_mut() else {
        return;
    };
    meta.entry("permission")
        .or_insert_with(|| permission.clone());
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn obj(value: Value) -> Map<String, Value> {
        value.as_object().cloned().expect("object")
    }

    #[test]
    fn claude_merges_claude_code_and_air_keys_one_by_one() {
        let mut ledger = ToolCallMetaLedger::default();
        let opened = ledger.open(
            AgentKind::ClaudeCode,
            "toolu_1",
            Some(obj(json!({
                "claudeCode": {"toolName": "Bash", "parentToolUseId": "toolu_task"}
            }))),
        );
        assert_eq!(opened.unwrap()["claudeCode"]["toolName"], "Bash");
        let merged = ledger
            .update(
                AgentKind::ClaudeCode,
                "toolu_1",
                Some(obj(json!({
                    "jetbrains": {"air": {"commandTitle": "Build", "version": 1}}
                }))),
            )
            .unwrap();
        assert_eq!(merged["claudeCode"]["toolName"], "Bash");
        assert_eq!(merged["claudeCode"]["parentToolUseId"], "toolu_task");
        assert_eq!(merged["claudeCode"]["title"], "Build");
        let merged = ledger
            .update(
                AgentKind::ClaudeCode,
                "toolu_1",
                Some(obj(
                    json!({"claudeCode": {"toolResponse": {"status": "completed"}}}),
                )),
            )
            .unwrap();
        assert_eq!(merged["claudeCode"]["parentToolUseId"], "toolu_task");
        assert_eq!(merged["claudeCode"]["toolResponse"]["status"], "completed");
        assert_eq!(merged["jetbrains"]["air"]["commandTitle"], "Build");
    }

    #[test]
    fn frame_data_keys_ride_one_frame_and_are_never_stored() {
        let mut ledger = ToolCallMetaLedger::default();
        ledger.open(
            AgentKind::Codex,
            "cmd-1",
            Some(obj(
                json!({"terminal_info": {"terminal_id": "cmd-1", "cwd": "/w"}}),
            )),
        );
        let exit = ledger
            .update(
                AgentKind::Codex,
                "cmd-1",
                Some(obj(json!({
                    "terminal_exit": {"exit_code": 0, "signal": null, "terminal_id": "cmd-1"},
                    "terminal_output_delta": {"data": "ok\n", "terminal_id": "cmd-1"}
                }))),
            )
            .unwrap();
        assert!(exit.contains_key("terminal_exit"));
        assert!(exit.contains_key("terminal_output_delta"));
        assert!(exit.contains_key("terminal_info"));
        let later = ledger.update(AgentKind::Codex, "cmd-1", None).unwrap();
        assert!(!later.contains_key("terminal_exit"));
        assert!(!later.contains_key("terminal_output_delta"));
        assert!(later.contains_key("terminal_info"));
    }

    #[test]
    fn hoist_copies_air_permission_onto_the_tool_call() {
        let mut tool_call = json!({"title": "Edit files", "kind": "edit"});
        hoist_request_permission_meta(
            &mut tool_call,
            Some(&obj(json!({
                "jetbrains": {"air": {"permission": {
                    "version": 1,
                    "title": "Edit files",
                    "description": "Reason: write src/lib.rs"
                }}}
            }))),
        );
        assert_eq!(
            tool_call["_meta"]["permission"]["description"],
            "Reason: write src/lib.rs"
        );
    }

    #[test]
    fn non_air_agents_pass_meta_through() {
        let mut ledger = ToolCallMetaLedger::default();
        let frame = obj(json!({"pi": {"x": 1}}));
        assert_eq!(
            ledger.open(AgentKind::Pi, "t1", Some(frame.clone())),
            Some(frame.clone())
        );
        assert_eq!(
            ledger.update(AgentKind::Pi, "t1", Some(obj(json!({"pi": {"x": 2}})))),
            Some(obj(json!({"pi": {"x": 2}})))
        );
    }
}
