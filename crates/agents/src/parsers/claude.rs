//! Parser for Claude Code session files (`~/.claude/projects/**/*.jsonl`).
//!
//! Each line is one record; the conversational payload is under `message`
//! (`role`, `content`, `model`, `usage`). Content is either a plain string or an
//! array of typed blocks (`text` / `thinking` / `tool_use` / `tool_result` /
//! `image`). Tool results arrive on a `user`-role record and are folded into the
//! assistant turn by [`super::group_into_turns`]. VibeX-authored.

use chrono::{DateTime, Utc};
use serde_json::Value;

use super::{
    ConversationParser, ParseContext, ParseError, ParsedRecord, build_detail, group_into_turns,
    is_plan_tool, plan_entries_from_input,
};
use crate::conversation::{ContentBlock, ConversationDetail, TurnRole, TurnUsage};

/// Cap for tool *output* display text (not JSON-parsed, so truncation is safe).
const PREVIEW_LIMIT: usize = 16384;

pub struct ClaudeParser;

impl ConversationParser for ClaudeParser {
    fn parse(&self, raw: &str, ctx: &ParseContext) -> Result<ConversationDetail, ParseError> {
        let mut records = Vec::new();
        for (index, line) in raw.lines().enumerate() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let value: Value = serde_json::from_str(trimmed)
                .map_err(|error| ParseError::Malformed(format!("line {}: {error}", index + 1)))?;
            if let Some(record) = record_from_line(&value) {
                records.push(record);
            }
        }

        Ok(build_detail(group_into_turns(records), ctx))
    }
}

fn record_from_line(value: &Value) -> Option<ParsedRecord> {
    let message = value.get("message").unwrap_or(value);
    let role = match role_str(message).or_else(|| value.get("type").and_then(Value::as_str)) {
        Some("user") | Some("human") => TurnRole::User,
        Some("assistant") => TurnRole::Assistant,
        Some("system") => TurnRole::System,
        // Skip summary / meta / file-history records that carry no role.
        _ => return None,
    };

    let blocks = content_blocks(message.get("content")?);
    if blocks.is_empty() {
        return None;
    }

    let timestamp = value
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(|raw| DateTime::parse_from_rfc3339(raw).ok())
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(Utc::now);

    Some(ParsedRecord {
        role,
        blocks,
        timestamp,
        usage: parse_usage(message.get("usage")),
        model: message
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn role_str(message: &Value) -> Option<&str> {
    message.get("role").and_then(Value::as_str)
}

fn content_blocks(content: &Value) -> Vec<ContentBlock> {
    match content {
        Value::String(text) => vec![ContentBlock::Text { text: text.clone() }],
        Value::Array(items) => items.iter().filter_map(block_from_item).collect(),
        _ => Vec::new(),
    }
}

fn block_from_item(item: &Value) -> Option<ContentBlock> {
    match item.get("type").and_then(Value::as_str)? {
        "text" => Some(ContentBlock::Text {
            text: item.get("text").and_then(Value::as_str)?.to_string(),
        }),
        "thinking" => Some(ContentBlock::Thinking {
            text: item
                .get("thinking")
                .or_else(|| item.get("text"))
                .and_then(Value::as_str)?
                .to_string(),
        }),
        "tool_use" => {
            let name = item.get("name").and_then(Value::as_str).unwrap_or("tool");
            if is_plan_tool(name)
                && let Some(entries) = plan_entries_from_input(item.get("input"))
            {
                return Some(ContentBlock::Plan { entries });
            }
            Some(ContentBlock::ToolUse {
                kind: None,
                tool_use_id: item.get("id").and_then(Value::as_str).map(str::to_string),
                tool_name: name.to_string(),
                // Full input JSON (not truncated) so the renderer can parse it
                // into a rich tool card.
                input_preview: item.get("input").map(|input| input.to_string()),
                meta: None,
            })
        }
        "tool_result" => Some(ContentBlock::ToolResult {
            tool_use_id: item
                .get("tool_use_id")
                .and_then(Value::as_str)
                .map(str::to_string),
            output_preview: item.get("content").map(tool_result_text),
            is_error: item
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            agent_stats: None,
        }),
        "image" => image_block(item),
        _ => None,
    }
}

/// Claude image blocks use `source: { type: "base64", media_type, data }`.
fn image_block(item: &Value) -> Option<ContentBlock> {
    let source = item.get("source")?;
    Some(ContentBlock::Image {
        data: source.get("data").and_then(Value::as_str)?.to_string(),
        mime_type: source
            .get("media_type")
            .and_then(Value::as_str)
            .unwrap_or("image/png")
            .to_string(),
        uri: None,
    })
}

/// `tool_result.content` is a string or an array of `{type:"text", text}` parts.
fn tool_result_text(content: &Value) -> String {
    match content {
        Value::String(text) => truncate(text),
        Value::Array(items) => {
            let joined = items
                .iter()
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n");
            truncate(&joined)
        }
        other => truncate(&other.to_string()),
    }
}

fn truncate(text: &str) -> String {
    if text.len() <= PREVIEW_LIMIT {
        return text.to_string();
    }
    let mut end = PREVIEW_LIMIT;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\u{2026}", &text[..end])
}

fn parse_usage(value: Option<&Value>) -> Option<TurnUsage> {
    let value = value?;
    let field = |key: &str| value.get(key).and_then(Value::as_u64).unwrap_or(0);
    let usage = TurnUsage {
        input_tokens: field("input_tokens"),
        output_tokens: field("output_tokens"),
        cache_creation_input_tokens: field("cache_creation_input_tokens"),
        cache_read_input_tokens: field("cache_read_input_tokens"),
        context_window_max: None,
        cost_amount: None,
        cost_currency: None,
    };
    (usage != TurnUsage::default()).then_some(usage)
}

#[cfg(test)]
mod tests {
    use api_types::AgentKind;

    use super::*;

    fn ctx() -> ParseContext {
        ParseContext {
            external_session_id: "claude-session-1".to_string(),
            agent_type: AgentKind::ClaudeCode,
            workspace_path: Some("C:/repo".to_string()),
        }
    }

    const FIXTURE: &str = r#"
{"type":"user","message":{"role":"user","content":"Inspect the repo"},"sessionId":"claude-session-1","cwd":"C:/repo","timestamp":"2026-06-14T00:00:00Z"}
{"type":"assistant","message":{"role":"assistant","model":"claude-x","content":[{"type":"thinking","thinking":"plan"},{"type":"text","text":"Looking"},{"type":"tool_use","id":"t1","name":"Read","input":{"path":"a.txt"}}],"usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":2}},"timestamp":"2026-06-14T00:00:01Z"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"file body","is_error":false}]},"timestamp":"2026-06-14T00:00:02Z"}
{"type":"summary","summary":"a summary record with no role"}
"#;

    #[test]
    fn parses_claude_session_into_turns() {
        let detail = ClaudeParser.parse(FIXTURE, &ctx()).unwrap();

        // user turn + assistant turn (the summary record is skipped).
        assert_eq!(detail.turns.len(), 2);
        assert_eq!(detail.summary.id, "claude-session-1");
        assert_eq!(detail.summary.message_count, 2);
        assert_eq!(detail.summary.model.as_deref(), Some("claude-x"));

        let user = &detail.turns[0];
        assert_eq!(user.role, TurnRole::User);
        assert!(matches!(user.blocks[0], ContentBlock::Text { .. }));

        let assistant = &detail.turns[1];
        assert_eq!(assistant.role, TurnRole::Assistant);
        // thinking + text + tool_use + folded tool_result == 4 blocks.
        assert_eq!(assistant.blocks.len(), 4);
        assert!(matches!(assistant.blocks[0], ContentBlock::Thinking { .. }));
        assert!(matches!(
            assistant.blocks[3],
            ContentBlock::ToolResult { .. }
        ));
        assert_eq!(assistant.model.as_deref(), Some("claude-x"));
        assert!(assistant.usage.is_some());
    }

    const TODO_FIXTURE: &str = r#"
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"p1","name":"TodoWrite","input":{"todos":[{"content":"Read repo","status":"completed","priority":"high"},{"content":"Fix bug","status":"in_progress"}]}}]},"timestamp":"2026-06-14T00:00:01Z"}
"#;

    #[test]
    fn parses_todowrite_into_plan_block() {
        let detail = ClaudeParser.parse(TODO_FIXTURE, &ctx()).unwrap();
        let assistant = &detail.turns[0];
        match &assistant.blocks[0] {
            ContentBlock::Plan { entries } => {
                assert_eq!(entries.len(), 2);
                assert_eq!(entries[0].content, "Read repo");
                assert_eq!(entries[0].status, "completed");
                assert_eq!(entries[0].priority.as_deref(), Some("high"));
                assert_eq!(entries[1].status, "in_progress");
            }
            other => panic!("expected Plan block, got {other:?}"),
        }
    }

    #[test]
    fn carries_full_tool_input_as_valid_json() {
        let detail = ClaudeParser.parse(FIXTURE, &ctx()).unwrap();
        let assistant = &detail.turns[1];
        let ContentBlock::ToolUse { input_preview, .. } = &assistant.blocks[2] else {
            panic!("expected ToolUse block");
        };
        let parsed: serde_json::Value =
            serde_json::from_str(input_preview.as_deref().unwrap()).expect("input is valid JSON");
        assert_eq!(parsed["path"], "a.txt");
    }
}
