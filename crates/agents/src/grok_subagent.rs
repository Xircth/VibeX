//! Map Grok's native `spawn_subagent` lifecycle onto the launching tool call.
//!
//! Grok does not stream a child's chunks or tool calls over ACP. It emits
//! vendor notifications (`_x.ai/session/update` / `_x.ai/session_notification`)
//! with `subagent_spawned` / `subagent_progress` / `subagent_finished`. This
//! module pairs those notifications with the parent `spawn_subagent` tool call
//! and writes a stable `meta.subagent` payload the conversation UI can render.

use serde_json::{Map, Value};

const EXT_METHODS: [&str; 2] = ["_x.ai/session/update", "_x.ai/session_notification"];

/// Metadata written onto the launching tool call. Replaced wholesale on every
/// tick because tool-call upserts replace `meta` instead of merging it.
pub const SUBAGENT_META_KEY: &str = "subagent";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentToolCallUpdate {
    pub tool_call_id: String,
    pub meta: Value,
}

#[derive(Debug, Clone, Default)]
struct PendingSpawn {
    call_id: String,
    description: Option<String>,
    subagent_type: Option<String>,
    background: bool,
    settled: bool,
}

#[derive(Debug, Clone, Default)]
struct BoundChild {
    call_id: String,
    background: bool,
    settled: bool,
    finished: bool,
    progress: Map<String, Value>,
}

#[derive(Debug, Default)]
pub struct GrokSubagentTracker {
    pending: Vec<PendingSpawn>,
    by_subagent: std::collections::HashMap<String, BoundChild>,
}

impl GrokSubagentTracker {
    pub fn note_tool_call(
        &mut self,
        call_id: &str,
        title: Option<&str>,
        input_preview: Option<&str>,
        meta: Option<&Value>,
        status: Option<&str>,
    ) {
        if !looks_like_spawn_subagent(title, input_preview, meta) {
            if let Some(status) = status {
                self.mark_settled(call_id, status);
            }
            return;
        }
        let fields = spawn_fields(input_preview);
        if let Some(existing) = self
            .pending
            .iter_mut()
            .find(|pending| pending.call_id == call_id)
        {
            if existing.description.is_none() {
                existing.description = fields.description.clone();
            }
            if existing.subagent_type.is_none() {
                existing.subagent_type = fields.subagent_type.clone();
            }
            existing.background |= fields.background;
            if is_terminal_status(status) {
                existing.settled = true;
            }
        } else if self
            .by_subagent
            .values()
            .any(|child| child.call_id == call_id)
        {
            if let Some(status) = status.filter(|value| is_terminal_status(Some(value))) {
                self.mark_settled(call_id, status);
            }
        } else {
            self.pending.push(PendingSpawn {
                call_id: call_id.to_string(),
                description: fields.description,
                subagent_type: fields.subagent_type,
                background: fields.background,
                settled: is_terminal_status(status),
            });
        }
    }

    pub fn handle_ext(&mut self, method: &str, params: &Value) -> Vec<SubagentToolCallUpdate> {
        if !EXT_METHODS.contains(&method) {
            return Vec::new();
        }
        let Some(update) = ext_update(params) else {
            return Vec::new();
        };
        let Some(kind) = update
            .get("sessionUpdate")
            .or_else(|| update.get("session_update"))
            .and_then(Value::as_str)
        else {
            return Vec::new();
        };
        let Some(subagent_id) = string_field(update, "subagent_id") else {
            return Vec::new();
        };
        match kind {
            "subagent_spawned" => self.on_spawned(&subagent_id, update).into_iter().collect(),
            "subagent_progress" => self.on_progress(&subagent_id, update).into_iter().collect(),
            "subagent_finished" => self.on_finished(&subagent_id, update).into_iter().collect(),
            _ => Vec::new(),
        }
    }

    fn on_spawned(&mut self, subagent_id: &str, update: &Value) -> Option<SubagentToolCallUpdate> {
        if self.by_subagent.contains_key(subagent_id) {
            return None;
        }
        let event_description = string_field(update, "description");
        let event_type = string_field(update, "subagent_type");
        let idx = self.pending.iter().position(|pending| {
            fields_match(&pending.description, event_description.as_deref())
                && fields_match(&pending.subagent_type, event_type.as_deref())
        })?;
        let pending = self.pending.remove(idx);
        self.by_subagent.insert(
            subagent_id.to_string(),
            BoundChild {
                call_id: pending.call_id.clone(),
                background: pending.background || pending.settled,
                settled: pending.settled,
                finished: false,
                progress: Map::new(),
            },
        );
        Some(SubagentToolCallUpdate {
            tool_call_id: pending.call_id,
            meta: subagent_meta(
                if pending.settled {
                    "background"
                } else {
                    "running"
                },
                None,
            ),
        })
    }

    fn on_progress(&mut self, subagent_id: &str, update: &Value) -> Option<SubagentToolCallUpdate> {
        let child = self.by_subagent.get_mut(subagent_id)?;
        if child.finished {
            return None;
        }
        child.progress = progress_from_update(update);
        if child.progress.is_empty() {
            return None;
        }
        Some(SubagentToolCallUpdate {
            tool_call_id: child.call_id.clone(),
            meta: subagent_meta(
                if child.settled || child.background {
                    "background"
                } else {
                    "running"
                },
                Some(&child.progress),
            ),
        })
    }

    fn on_finished(&mut self, subagent_id: &str, update: &Value) -> Option<SubagentToolCallUpdate> {
        let mut child = self.by_subagent.remove(subagent_id)?;
        child.finished = true;
        let mut progress = progress_from_update(update);
        if progress.is_empty() {
            progress = child.progress.clone();
        } else {
            for (key, value) in child.progress {
                progress.entry(key).or_insert(value);
            }
        }
        let status = match string_field(update, "status").as_deref() {
            Some("failed" | "error" | "killed" | "cancelled" | "canceled") => "failed",
            _ => "completed",
        };
        Some(SubagentToolCallUpdate {
            tool_call_id: child.call_id,
            meta: subagent_meta(status, (!progress.is_empty()).then_some(&progress)),
        })
    }

    fn mark_settled(&mut self, call_id: &str, status: &str) {
        if !is_terminal_status(Some(status)) {
            return;
        }
        if let Some(pending) = self
            .pending
            .iter_mut()
            .find(|pending| pending.call_id == call_id)
        {
            pending.settled = true;
        }
        if let Some(child) = self
            .by_subagent
            .values_mut()
            .find(|child| child.call_id == call_id)
        {
            child.settled = true;
            child.background = true;
        }
    }
}

fn looks_like_spawn_subagent(
    title: Option<&str>,
    input_preview: Option<&str>,
    meta: Option<&Value>,
) -> bool {
    if vendor_tool_name(meta).is_some_and(|name| name == "spawn_subagent") {
        return true;
    }
    let title = title.unwrap_or("");
    let canonical = canonical_name(title);
    if matches!(
        canonical.as_str(),
        "spawnsubagent" | "spawn_subagent" | "spawnagent" | "task" | "agent"
    ) {
        return true;
    }
    let fields = spawn_fields(input_preview);
    fields.subagent_type.is_some()
}

fn ext_update(params: &Value) -> Option<&Value> {
    if let Some(update) = params.get("update") {
        return Some(update);
    }
    if let Some(update) = params
        .get("notification")
        .and_then(|notification| notification.get("update"))
    {
        return Some(update);
    }
    if params
        .get("sessionUpdate")
        .or_else(|| params.get("session_update"))
        .is_some()
    {
        return Some(params);
    }
    None
}

fn vendor_tool_name(meta: Option<&Value>) -> Option<&str> {
    meta?.get("x.ai/tool")?.get("name")?.as_str()
}

fn spawn_fields(input_preview: Option<&str>) -> SpawnFields {
    let Some(input) = input_preview.and_then(parse_object) else {
        return SpawnFields::default();
    };
    SpawnFields {
        description: string_field(&input, "description"),
        subagent_type: string_field(&input, "subagent_type")
            .or_else(|| string_field(&input, "agent_type"))
            .or_else(|| string_field(&input, "subagentType")),
        background: input
            .get("background")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

#[derive(Default)]
struct SpawnFields {
    description: Option<String>,
    subagent_type: Option<String>,
    background: bool,
}

fn fields_match(pending: &Option<String>, event: Option<&str>) -> bool {
    match (pending.as_deref(), event) {
        (Some(pending), Some(event)) => pending == event,
        (Some(_), None) => false,
        (None, _) => true,
    }
}

fn progress_from_update(update: &Value) -> Map<String, Value> {
    let mut progress = Map::new();
    for (wire, out) in [
        ("duration_ms", "durationMs"),
        ("turn_count", "turnCount"),
        ("tool_call_count", "toolCallCount"),
        ("tool_calls", "toolCallCount"),
        ("context_usage_pct", "contextUsagePct"),
        ("tokens_used", "tokenCount"),
        ("token_count", "tokenCount"),
        ("total_tokens", "tokenCount"),
    ] {
        if progress.contains_key(out) {
            continue;
        }
        if let Some(value) = update.get(wire).filter(|value| value.is_number()) {
            progress.insert(out.to_string(), value.clone());
        }
    }
    progress
}

fn subagent_meta(status: &str, progress: Option<&Map<String, Value>>) -> Value {
    let mut body = Map::new();
    body.insert("status".into(), Value::String(status.to_string()));
    if let Some(progress) = progress.filter(|progress| !progress.is_empty()) {
        body.insert("progress".into(), Value::Object(progress.clone()));
    }
    Value::Object(Map::from_iter([(
        SUBAGENT_META_KEY.to_string(),
        Value::Object(body),
    )]))
}

fn parse_object(text: &str) -> Option<Value> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    parsed.is_object().then_some(parsed)
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn canonical_name(name: &str) -> String {
    name.chars()
        .filter(|ch| !matches!(ch, ' ' | '_' | '-' | '.'))
        .flat_map(char::to_lowercase)
        .collect()
}

fn is_terminal_status(status: Option<&str>) -> bool {
    matches!(
        status.map(str::to_ascii_lowercase).as_deref(),
        Some("completed" | "failed" | "cancelled" | "canceled")
    )
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn pairs_spawn_and_emits_live_progress() {
        let mut tracker = GrokSubagentTracker::default();
        tracker.note_tool_call(
            "call-1",
            Some("spawn_subagent"),
            Some(r#"{"subagent_type":"explore","description":"Audit stream","prompt":"look"}"#),
            None,
            Some("running"),
        );

        let spawned = tracker.handle_ext(
            "_x.ai/session/update",
            &json!({
                "sessionId": "parent",
                "update": {
                    "sessionUpdate": "subagent_spawned",
                    "subagent_id": "sub-1",
                    "subagent_type": "explore",
                    "description": "Audit stream"
                }
            }),
        );
        assert_eq!(spawned.len(), 1);
        assert_eq!(spawned[0].tool_call_id, "call-1");
        assert_eq!(spawned[0].meta["subagent"]["status"], "running");

        let progress = tracker.handle_ext(
            "_x.ai/session_notification",
            &json!({
                "update": {
                    "sessionUpdate": "subagent_progress",
                    "subagent_id": "sub-1",
                    "duration_ms": 5400,
                    "turn_count": 1,
                    "tool_call_count": 125,
                    "context_usage_pct": 32
                }
            }),
        );
        assert_eq!(
            progress[0].meta["subagent"]["progress"]["toolCallCount"],
            125
        );
        assert_eq!(
            progress[0].meta["subagent"]["progress"]["contextUsagePct"],
            32
        );
        assert_eq!(progress[0].meta["subagent"]["status"], "running");
    }

    #[test]
    fn background_launch_then_finished_includes_tokens() {
        let mut tracker = GrokSubagentTracker::default();
        tracker.note_tool_call(
            "call-2",
            Some("Agent"),
            Some(r#"{"subagent_type":"explore","description":"Audit","background":true}"#),
            Some(&json!({"x.ai/tool":{"name":"spawn_subagent"}})),
            Some("completed"),
        );
        let spawned = tracker.handle_ext(
            "_x.ai/session/update",
            &json!({
                "update": {
                    "sessionUpdate": "subagent_spawned",
                    "subagent_id": "sub-2",
                    "subagent_type": "explore",
                    "description": "Audit"
                }
            }),
        );
        assert_eq!(spawned[0].meta["subagent"]["status"], "background");

        let finished = tracker.handle_ext(
            "_x.ai/session/update",
            &json!({
                "update": {
                    "sessionUpdate": "subagent_finished",
                    "subagent_id": "sub-2",
                    "status": "completed",
                    "tokens_used": 18432,
                    "tool_calls": 125,
                    "duration_ms": 5400
                }
            }),
        );
        assert_eq!(finished[0].meta["subagent"]["status"], "completed");
        assert_eq!(
            finished[0].meta["subagent"]["progress"]["tokenCount"],
            18432
        );
        assert_eq!(
            finished[0].meta["subagent"]["progress"]["toolCallCount"],
            125
        );
    }

    #[test]
    fn ignores_unrelated_extension_methods() {
        let mut tracker = GrokSubagentTracker::default();
        tracker.note_tool_call("call-1", Some("spawn_subagent"), None, None, None);
        let updates = tracker.handle_ext(
            "_other/session/update",
            &json!({"update":{"sessionUpdate":"subagent_progress","subagent_id":"x"}}),
        );
        assert!(updates.is_empty());
    }

    #[test]
    fn accepts_unwrapped_session_update() {
        let mut tracker = GrokSubagentTracker::default();
        tracker.note_tool_call(
            "call-1",
            Some("spawn_subagent"),
            Some(r#"{"subagent_type":"explore","description":"Audit stream"}"#),
            None,
            Some("running"),
        );
        let spawned = tracker.handle_ext(
            "_x.ai/session_notification",
            &json!({
                "sessionUpdate": "subagent_spawned",
                "subagent_id": "sub-1",
                "subagent_type": "explore",
                "description": "Audit stream"
            }),
        );
        assert_eq!(spawned.len(), 1);
        assert_eq!(spawned[0].meta["subagent"]["status"], "running");
    }
}
