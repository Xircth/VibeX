//! Parser for Codex CLI session rollouts (`~/.codex/sessions/**/*.jsonl`).
//!
//! Each line is `{ timestamp, type, payload }`. The canonical transcript items
//! are `type == "response_item"`; `event_msg` lines (task_started, agent_message,
//! token_count, ...) are duplicate/event forms and are skipped to avoid double
//! rendering. Within a response item, `payload.type` is:
//! `message` (role developer/user/assistant; content `input_text`/`output_text`),
//! `reasoning` (summary text), `function_call` (tool use), or
//! `function_call_output` (tool result). VibeX-authored; the format is Codex's.

use chrono::{DateTime, Utc};
use serde_json::Value;

use super::{
    build_detail, group_into_turns, is_plan_tool, plan_entries_from_input, ConversationParser,
    ParseContext, ParseError, ParsedRecord,
};
use crate::conversation::{ContentBlock, ConversationDetail, PlanEntry, TurnRole};

/// Cap for tool *output* display text (not JSON-parsed, so truncation is safe).
const PREVIEW_LIMIT: usize = 16384;

pub struct CodexParser;

impl ConversationParser for CodexParser {
    fn parse(&self, raw: &str, ctx: &ParseContext) -> Result<ConversationDetail, ParseError> {
        let mut records = Vec::new();
        for (index, line) in raw.lines().enumerate() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let value: Value = serde_json::from_str(trimmed)
                .map_err(|error| ParseError::Malformed(format!("line {}: {error}", index + 1)))?;
            if value.get("type").and_then(Value::as_str) != Some("response_item") {
                continue;
            }
            if let Some(record) = record_from_item(&value) {
                records.push(record);
            }
        }

        Ok(build_detail(group_into_turns(records), ctx))
    }
}

fn record_from_item(value: &Value) -> Option<ParsedRecord> {
    let payload = value.get("payload")?;
    let timestamp = value
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(|raw| DateTime::parse_from_rfc3339(raw).ok())
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(Utc::now);

    let (role, block) = match payload.get("type").and_then(Value::as_str)? {
        "message" => {
            let role = match payload.get("role").and_then(Value::as_str) {
                Some("user") => TurnRole::User,
                Some("assistant") => TurnRole::Assistant,
                // `developer` carries the instruction preamble -- not user-facing.
                _ => return None,
            };
            let text = message_text(payload.get("content"));
            if text.is_empty() {
                return None;
            }
            (role, ContentBlock::Text { text })
        }
        "reasoning" => {
            let text = reasoning_text(payload);
            if text.is_empty() {
                return None;
            }
            (TurnRole::Assistant, ContentBlock::Thinking { text })
        }
        "function_call" => {
            let name = payload.get("name").and_then(Value::as_str).unwrap_or("tool");
            let block = match plan_entries_from_codex_args(payload.get("arguments")) {
                Some(entries) if is_plan_tool(name) => ContentBlock::Plan { entries },
                _ => ContentBlock::ToolUse {
                    tool_use_id: payload
                        .get("call_id")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    tool_name: name.to_string(),
                    // Codex passes arguments as a JSON string; carry it as-is so
                    // the renderer can parse it into a rich tool card.
                    input_preview: payload.get("arguments").map(codex_tool_input),
                    meta: None,
                },
            };
            (TurnRole::Assistant, block)
        }
        "function_call_output" => (
            TurnRole::Assistant,
            ContentBlock::ToolResult {
                tool_use_id: payload
                    .get("call_id")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                output_preview: payload.get("output").map(function_output_text),
                is_error: false,
                agent_stats: None,
            },
        ),
        _ => return None,
    };

    Some(ParsedRecord {
        role,
        blocks: vec![block],
        timestamp,
        usage: None,
        model: None,
    })
}

/// `content` is an array of `{ type: input_text|output_text|text, text }`.
fn message_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        Some(Value::String(text)) => text.clone(),
        _ => String::new(),
    }
}

/// Reasoning carries `summary: [{ type: summary_text, text }]` and sometimes a
/// `content` array.
fn reasoning_text(payload: &Value) -> String {
    let from = |value: Option<&Value>| -> Option<String> {
        let items = value?.as_array()?;
        let joined = items
            .iter()
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
        (!joined.is_empty()).then_some(joined)
    };
    from(payload.get("summary"))
        .or_else(|| from(payload.get("content")))
        .unwrap_or_default()
}

/// `function_call_output.output` is a string or an object (e.g. `{ output, .. }`).
fn function_output_text(value: &Value) -> String {
    match value {
        Value::String(text) => preview(text),
        Value::Object(map) => match map.get("output").and_then(Value::as_str) {
            Some(text) => preview(text),
            None => preview(&value.to_string()),
        },
        other => preview(&other.to_string()),
    }
}

/// Codex tool arguments arrive as a JSON string; use it directly (it is already
/// valid JSON), falling back to serializing a non-string value.
fn codex_tool_input(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// Parse Codex's stringified `arguments` and extract plan entries, if any.
fn plan_entries_from_codex_args(args: Option<&Value>) -> Option<Vec<PlanEntry>> {
    let parsed = match args? {
        Value::String(text) => serde_json::from_str::<Value>(text).ok()?,
        other => other.clone(),
    };
    plan_entries_from_input(Some(&parsed))
}

fn preview(text: &str) -> String {
    if text.len() <= PREVIEW_LIMIT {
        return text.to_string();
    }
    let mut end = PREVIEW_LIMIT;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\u{2026}", &text[..end])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::AgentType;

    fn ctx() -> ParseContext {
        ParseContext {
            external_session_id: "codex-1".to_string(),
            agent_type: AgentType::Codex,
            workspace_path: Some("C:/repo".to_string()),
        }
    }

    const FIXTURE: &str = r#"
{"timestamp":"2026-06-14T00:00:00Z","type":"session_meta","payload":{"id":"codex-1","cwd":"C:/repo"}}
{"timestamp":"2026-06-14T00:00:00Z","type":"event_msg","payload":{"type":"task_started"}}
{"timestamp":"2026-06-14T00:00:00Z","type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"system instructions"}]}}
{"timestamp":"2026-06-14T00:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Inspect the repo"}]}}
{"timestamp":"2026-06-14T00:00:02Z","type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"planning"}],"content":null}}
{"timestamp":"2026-06-14T00:00:03Z","type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"cmd\":\"ls\"}","call_id":"c1"}}
{"timestamp":"2026-06-14T00:00:04Z","type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"file list"}}
{"timestamp":"2026-06-14T00:00:05Z","type":"event_msg","payload":{"type":"agent_message"}}
{"timestamp":"2026-06-14T00:00:06Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Here is the repo"}]}}
"#;

    #[test]
    fn parses_codex_rollout_into_turns() {
        let detail = CodexParser.parse(FIXTURE, &ctx()).unwrap();

        // developer + event_msg lines skipped -> user turn + assistant turn.
        assert_eq!(detail.turns.len(), 2);
        assert_eq!(detail.summary.id, "codex-1");

        assert_eq!(detail.turns[0].role, TurnRole::User);

        let assistant = &detail.turns[1];
        assert_eq!(assistant.role, TurnRole::Assistant);
        // reasoning + tool_use + tool_result + text.
        assert_eq!(assistant.blocks.len(), 4);
        assert!(matches!(assistant.blocks[0], ContentBlock::Thinking { .. }));
        assert!(matches!(assistant.blocks[1], ContentBlock::ToolUse { .. }));
        assert!(matches!(
            assistant.blocks[2],
            ContentBlock::ToolResult { .. }
        ));
        assert!(matches!(assistant.blocks[3], ContentBlock::Text { .. }));
    }

    const PLAN_FIXTURE: &str = r#"
{"timestamp":"2026-06-14T00:00:00Z","type":"response_item","payload":{"type":"function_call","name":"update_plan","arguments":"{\"plan\":[{\"step\":\"Do X\",\"status\":\"in_progress\"},{\"step\":\"Do Y\",\"status\":\"pending\"}]}","call_id":"p1"}}
"#;

    #[test]
    fn parses_update_plan_into_plan_block() {
        let detail = CodexParser.parse(PLAN_FIXTURE, &ctx()).unwrap();
        match &detail.turns[0].blocks[0] {
            ContentBlock::Plan { entries } => {
                assert_eq!(entries.len(), 2);
                assert_eq!(entries[0].content, "Do X");
                assert_eq!(entries[0].status, "in_progress");
            }
            other => panic!("expected Plan block, got {other:?}"),
        }
    }
}
