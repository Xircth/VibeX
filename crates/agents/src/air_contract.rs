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

/// Whether this agent sends incremental tool-call `_meta` frames that must be
/// folded across `tool_call` and `tool_call_update`.
pub(crate) fn folds_tool_call_meta(agent_kind: AgentKind) -> bool {
    speaks_air_contract(agent_kind) || agent_kind == AgentKind::Codebuddy
}

const MAX_SUBAGENT_STREAM_BYTES: usize = 8192;

/// Extract the parent tool-use ID from a message/thought chunk's `_meta` when
/// an adapter streams subagent prose or thinking on the parent session.
pub(crate) fn chunk_parent_tool_use_id(
    agent_kind: Option<AgentKind>,
    meta: Option<&Map<String, Value>>,
) -> Option<String> {
    let meta = meta?;
    if matches!(agent_kind, None | Some(AgentKind::ClaudeCode))
        && let Some(parent_id) = meta
            .get("claudeCode")
            .and_then(Value::as_object)
            .and_then(|c| c.get("parentToolUseId"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
    {
        return Some(parent_id.to_string());
    }
    if matches!(agent_kind, None | Some(AgentKind::Codebuddy))
        && let Some(parent_id) = meta
            .get("codebuddy.ai/parentToolCallId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
    {
        return Some(parent_id.to_string());
    }
    None
}

/// Whether a CodeBuddy message/thought chunk is marked as subagent output
/// (`_meta["codebuddy.ai/isSubagent"] == true`), so unparented subagent chunks
/// do not leak into the parent turn's prose.
pub(crate) fn codebuddy_chunk_marks_subagent(
    agent_kind: Option<AgentKind>,
    meta: Option<&Map<String, Value>>,
) -> bool {
    matches!(agent_kind, None | Some(AgentKind::Codebuddy))
        && meta
            .and_then(|m| m.get("codebuddy.ai/isSubagent"))
            .and_then(Value::as_bool)
            == Some(true)
}

/// Append a streamed subagent text or thinking chunk onto `meta["subagent"][field]`,
/// bounded to `MAX_SUBAGENT_STREAM_BYTES` so `ToolUse.meta` stays well below
/// timeline preview caps.
pub(crate) fn append_subagent_chunk_to_meta(
    meta: &mut Map<String, Value>,
    field: &str,
    chunk_text: &str,
) {
    if chunk_text.is_empty() {
        return;
    }
    let Some(subagent) = meta
        .entry("subagent")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
    else {
        return;
    };
    let mut combined = subagent
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if combined.len() < MAX_SUBAGENT_STREAM_BYTES {
        let remaining = MAX_SUBAGENT_STREAM_BYTES - combined.len();
        if chunk_text.len() <= remaining {
            combined.push_str(chunk_text);
        } else {
            let mut end = remaining;
            while end > 0 && !chunk_text.is_char_boundary(end) {
                end -= 1;
            }
            combined.push_str(&chunk_text[..end]);
        }
    }
    subagent.insert(field.to_string(), Value::String(combined));
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
    matches!(agent_kind, AgentKind::ClaudeCode | AgentKind::Codebuddy)
}

fn merge_state(agent_kind: AgentKind, state: &mut Map<String, Value>, frame: &Map<String, Value>) {
    for (key, value) in frame {
        if FRAME_DATA_KEYS.contains(&key.as_str()) {
            continue;
        }
        if key == "subagent"
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
        if !folds_tool_call_meta(agent_kind) {
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

    pub(crate) fn update(
        &mut self,
        agent_kind: AgentKind,
        id: &str,
        frame: Option<Map<String, Value>>,
    ) -> Option<Map<String, Value>> {
        if !folds_tool_call_meta(agent_kind) {
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

    pub(crate) fn append_subagent_chunk(
        &mut self,
        agent_kind: AgentKind,
        id: &str,
        field: &str,
        chunk_text: &str,
    ) -> Option<Map<String, Value>> {
        if chunk_text.is_empty() {
            return self.peek(id);
        }
        let mut state = self
            .entries
            .remove(id)
            .map(|entry| entry.state)
            .unwrap_or_default();
        append_subagent_chunk_to_meta(&mut state, field, chunk_text);
        let mut effective = state.clone();
        self.store(id, state);
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
        if !folds_tool_call_meta(agent_kind) {
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

    pub(crate) fn peek(&self, id: &str) -> Option<Map<String, Value>> {
        self.entries.get(id).map(|entry| entry.state.clone())
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

/// Copy the request-level permission record (and any Claude / AIR title metadata)
/// onto the tool-call payload the permission card already reads.
#[cfg(test)]
pub(crate) fn hoist_request_permission_meta(
    tool_call: &mut Value,
    request_meta: Option<&Map<String, Value>>,
) {
    hoist_request_permission_meta_with_ledger(tool_call, request_meta, None);
}

pub(crate) fn hoist_request_permission_meta_with_ledger(
    tool_call: &mut Value,
    request_meta: Option<&Map<String, Value>>,
    ledger_meta: Option<&Map<String, Value>>,
) {
    let Some(obj) = tool_call.as_object_mut() else {
        return;
    };
    let existing_meta = obj
        .get("_meta")
        .and_then(Value::as_object)
        .cloned()
        .or_else(|| {
            obj.get("fields")
                .and_then(|f| f.get("_meta"))
                .and_then(Value::as_object)
                .cloned()
        });
    let mut merged = Map::new();
    if let Some(ledger) = ledger_meta {
        merge_state(AgentKind::ClaudeCode, &mut merged, ledger);
    }
    if let Some(existing) = existing_meta.as_ref() {
        merge_state(AgentKind::ClaudeCode, &mut merged, existing);
    }
    if let Some(req_meta) = request_meta {
        if let Some(claude) = req_meta.get("claudeCode").filter(|v| v.is_object()) {
            let mut frame = Map::new();
            frame.insert("claudeCode".to_string(), claude.clone());
            merge_state(AgentKind::ClaudeCode, &mut merged, &frame);
        }
        if let Some(jetbrains) = req_meta.get("jetbrains").filter(|v| v.is_object()) {
            let mut frame = Map::new();
            frame.insert("jetbrains".to_string(), jetbrains.clone());
            merge_state(AgentKind::ClaudeCode, &mut merged, &frame);
        }
        if let Some(permission) = permission_record(Some(req_meta)) {
            merged
                .entry("permission")
                .or_insert_with(|| permission.clone());
        }
    }
    translate_air_meta(AgentKind::ClaudeCode, &mut merged);
    if !merged.is_empty() {
        obj.insert("_meta".to_string(), Value::Object(merged));
    }
}

fn extract_permission_command(tool_call: Option<&Value>) -> Option<String> {
    let obj = tool_call?.as_object()?;
    let raw_input = obj
        .get("rawInput")
        .or_else(|| obj.get("fields").and_then(|f| f.get("rawInput")))?
        .as_object()?;
    for key in ["command", "cmd", "script"] {
        if let Some(value) = raw_input.get(key) {
            if let Some(text) = value.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                return Some(text.to_string());
            }
            if let Some(arr) = value.as_array() {
                let joined = arr
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" ");
                let trimmed = joined.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
    }
    None
}

fn extract_shell_command_label(tool_call: Option<&Value>, command: &str) -> Option<String> {
    let obj = tool_call?.as_object()?;
    let raw_input = obj
        .get("rawInput")
        .or_else(|| obj.get("fields").and_then(|f| f.get("rawInput")))?
        .as_object()?;
    for key in ["description", "title", "summary"] {
        if let Some(label) = raw_input
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty() && *s != command)
        {
            return Some(label.to_string());
        }
    }
    None
}

/// Resolve the permission request title in Codeg priority order:
/// 1. `_meta.claudeCode.title` (or AIR `commandTitle` translated into `claudeCode.title`)
/// 2. `_meta.permission.title`
/// 3. `toolCall.title` (`fallback_title`)
///
/// If the resolved heading is byte-equal to the shell command in `rawInput`,
/// it is not used as a heading (unless `rawInput.description` provides a distinct
/// one-line label), avoiding duplicate command rendering.
pub(crate) fn resolve_permission_request_title(
    tool_call: Option<&Value>,
    fallback_title: Option<&str>,
) -> String {
    let meta = tool_call.and_then(Value::as_object).and_then(|obj| {
        obj.get("_meta").and_then(Value::as_object).or_else(|| {
            obj.get("fields")
                .and_then(|f| f.get("_meta"))
                .and_then(Value::as_object)
        })
    });
    let claude_title = meta
        .and_then(|m| m.get("claudeCode"))
        .and_then(Value::as_object)
        .and_then(|c| c.get("title"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let permission_title = meta
        .and_then(|m| m.get("permission"))
        .and_then(Value::as_object)
        .and_then(|p| p.get("title"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let tool_title = fallback_title
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            tool_call
                .and_then(Value::as_object)
                .and_then(|obj| {
                    obj.get("title")
                        .or_else(|| obj.get("fields").and_then(|f| f.get("title")))
                })
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
        });

    let command = extract_permission_command(tool_call);
    let meta_heading = claude_title.or(permission_title);
    if let Some(heading) = meta_heading {
        if command.as_deref() == Some(heading) {
            if let Some(label) = command
                .as_deref()
                .and_then(|cmd| extract_shell_command_label(tool_call, cmd))
            {
                return label;
            }
            if let Some(tool) = tool_title.filter(|t| command.as_deref() != Some(*t)) {
                return tool.to_string();
            }
            return String::new();
        }
        return heading.to_string();
    }

    if let Some(tool) = tool_title {
        if command.as_deref() == Some(tool) {
            return command
                .as_deref()
                .and_then(|cmd| extract_shell_command_label(tool_call, cmd))
                .unwrap_or_default();
        }
        return tool.to_string();
    }

    "Permission requested".to_string()
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
    fn permission_title_prefers_claude_code_title_and_suppresses_raw_command_duplicates() {
        let mut build_call = json!({
            "title": "cargo build",
            "kind": "execute",
            "rawInput": {"command": "cargo build"},
            "_meta": {"claudeCode": {"title": "Build"}}
        });
        hoist_request_permission_meta(
            &mut build_call,
            Some(&obj(json!({
                "permission": {"title": "cargo build"}
            }))),
        );
        assert_eq!(
            resolve_permission_request_title(Some(&build_call), Some("cargo build")),
            "Build"
        );

        let mut duplicate_cmd_call = json!({
            "title": "pnpm test --runInBand",
            "kind": "execute",
            "rawInput": {"command": "pnpm test --runInBand"}
        });
        hoist_request_permission_meta(
            &mut duplicate_cmd_call,
            Some(&obj(json!({
                "permission": {"title": "pnpm test --runInBand"}
            }))),
        );
        assert_eq!(
            resolve_permission_request_title(
                Some(&duplicate_cmd_call),
                Some("pnpm test --runInBand")
            ),
            ""
        );

        let fallback_call = json!({
            "title": "Edit README.md",
            "kind": "edit"
        });
        assert_eq!(
            resolve_permission_request_title(Some(&fallback_call), Some("Edit README.md")),
            "Edit README.md"
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

    #[test]
    fn subagent_chunks_fold_into_parent_card_and_survive_completion_update() {
        let mut ledger = ToolCallMetaLedger::default();
        let opened = ledger
            .open(
                AgentKind::ClaudeCode,
                "toolu_task",
                Some(obj(json!({
                    "jetbrains": {"air": {"subagent": true, "commandTitle": "Audit repository"}}
                }))),
            )
            .unwrap();
        assert_eq!(opened["claudeCode"]["subagent"], true);
        assert_eq!(opened["claudeCode"]["title"], "Audit repository");

        let with_thought = ledger
            .append_subagent_chunk(
                AgentKind::ClaudeCode,
                "toolu_task",
                "thinking",
                "Checking crates/agents...",
            )
            .unwrap();
        assert_eq!(
            with_thought["subagent"]["thinking"],
            "Checking crates/agents..."
        );

        let with_text = ledger
            .append_subagent_chunk(AgentKind::ClaudeCode, "toolu_task", "text", "Done.")
            .unwrap();
        assert_eq!(with_text["subagent"]["text"], "Done.");
        assert_eq!(with_text["claudeCode"]["subagent"], true);

        let completed = ledger
            .update(
                AgentKind::ClaudeCode,
                "toolu_task",
                Some(obj(json!({
                    "claudeCode": {"toolResponse": {"status": "completed"}}
                }))),
            )
            .unwrap();
        assert_eq!(
            completed["subagent"]["thinking"],
            "Checking crates/agents..."
        );
        assert_eq!(completed["subagent"]["text"], "Done.");
        assert_eq!(completed["claudeCode"]["subagent"], true);
    }

    #[test]
    fn chunk_parent_tool_use_id_reads_claude_and_codebuddy_meta() {
        let claude_meta = obj(json!({"claudeCode": {"parentToolUseId": "toolu_parent"}}));
        assert_eq!(
            chunk_parent_tool_use_id(Some(AgentKind::ClaudeCode), Some(&claude_meta)).as_deref(),
            Some("toolu_parent")
        );
        let codebuddy_meta = obj(json!({
            "codebuddy.ai/isSubagent": true,
            "codebuddy.ai/parentToolCallId": "cb_parent"
        }));
        assert_eq!(
            chunk_parent_tool_use_id(Some(AgentKind::Codebuddy), Some(&codebuddy_meta)).as_deref(),
            Some("cb_parent")
        );
        assert!(codebuddy_chunk_marks_subagent(
            Some(AgentKind::Codebuddy),
            Some(&codebuddy_meta)
        ));
    }
}
