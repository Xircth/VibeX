//! Parser for OpenClaw session transcripts
//! (`~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`).
//!
//! JSONL: one record per line. A `type:"session"` header carries `cwd`; every
//! other line is `type:"message"` discriminated by `message.role`
//! (`user` / `assistant` / `toolResult`). Tool results are their own records;
//! emitting them as assistant-role records folds them into the preceding
//! assistant turn (they are part of the assistant's response). Records form a
//! `parentId` tree; a linear file is read in line order. VibeX-authored; the
//! format is OpenClaw's.

use chrono::{DateTime, Utc};
use serde_json::Value;

use super::{
    ConversationParser, ParseContext, ParseError, ParsedRecord, build_detail, group_into_turns,
};
use crate::conversation::{ContentBlock, ConversationDetail, TurnRole, TurnUsage};

const TOOL_INPUT_LIMIT: usize = 50000;

pub struct OpenClawParser;

impl ConversationParser for OpenClawParser {
    fn parse(&self, raw: &str, ctx: &ParseContext) -> Result<ConversationDetail, ParseError> {
        let mut records = Vec::new();
        for line in raw.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };
            if value.get("type").and_then(Value::as_str) != Some("message") {
                continue;
            }
            if value
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .is_empty()
            {
                continue;
            }
            if let Some(record) = record_from_message(&value) {
                records.push(record);
            }
        }

        Ok(build_detail(group_into_turns(records), ctx))
    }
}

fn record_from_message(record: &Value) -> Option<ParsedRecord> {
    let message = record.get("message")?;
    let timestamp = record
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(|raw| raw.parse::<DateTime<Utc>>().ok())
        .unwrap_or_else(Utc::now);

    let role = message.get("role").and_then(Value::as_str)?;
    let (turn_role, blocks, usage, model) = match role {
        "user" => (TurnRole::User, user_blocks(message), None, None),
        "assistant" => (
            TurnRole::Assistant,
            assistant_blocks(message),
            assistant_usage(message),
            message
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_string),
        ),
        // Fold the tool result into the preceding assistant turn.
        "toolResult" => (TurnRole::Assistant, tool_result_blocks(message), None, None),
        _ => return None,
    };
    if blocks.is_empty() {
        return None;
    }

    Some(ParsedRecord {
        role: turn_role,
        blocks,
        timestamp,
        usage,
        model,
    })
}

fn user_blocks(message: &Value) -> Vec<ContentBlock> {
    let mut blocks = Vec::new();
    if let Some(items) = message.get("content").and_then(Value::as_array) {
        for item in items {
            if item.get("type").and_then(Value::as_str) == Some("text")
                && let Some(text) = item.get("text").and_then(Value::as_str)
            {
                let cleaned = strip_user_prefixes(text);
                if !cleaned.is_empty() {
                    blocks.push(ContentBlock::Text { text: cleaned });
                }
            }
        }
    }
    blocks
}

fn assistant_blocks(message: &Value) -> Vec<ContentBlock> {
    let mut blocks = Vec::new();
    if let Some(items) = message.get("content").and_then(Value::as_array) {
        for item in items {
            match item.get("type").and_then(Value::as_str) {
                Some("thinking") => {
                    if let Some(text) = item.get("thinking").and_then(Value::as_str) {
                        let text = text.trim();
                        if !text.is_empty() {
                            blocks.push(ContentBlock::Thinking {
                                text: text.to_string(),
                            });
                        }
                    }
                }
                Some("text") => {
                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                        let text = text
                            .strip_prefix("[[reply_to_current]] ")
                            .unwrap_or(text)
                            .trim();
                        if !text.is_empty() {
                            blocks.push(ContentBlock::Text {
                                text: text.to_string(),
                            });
                        }
                    }
                }
                Some("toolCall") => blocks.push(ContentBlock::ToolUse {
                    kind: None,
                    tool_use_id: item.get("id").and_then(Value::as_str).map(str::to_string),
                    tool_name: item
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_string(),
                    input_preview: item
                        .get("arguments")
                        .map(|args| truncate(&args.to_string(), TOOL_INPUT_LIMIT)),
                    meta: None,
                }),
                _ => {}
            }
        }
    }
    blocks
}

fn tool_result_blocks(message: &Value) -> Vec<ContentBlock> {
    let output = message
        .get("content")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .filter(|text| !text.is_empty());

    vec![ContentBlock::ToolResult {
        tool_use_id: message
            .get("toolCallId")
            .and_then(Value::as_str)
            .map(str::to_string),
        output_preview: output,
        is_error: message
            .get("isError")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        agent_stats: None,
    }]
}

fn assistant_usage(message: &Value) -> Option<TurnUsage> {
    let usage = message.get("usage")?;
    Some(TurnUsage {
        input_tokens: usage.get("input").and_then(Value::as_u64).unwrap_or(0),
        output_tokens: usage.get("output").and_then(Value::as_u64).unwrap_or(0),
        cache_creation_input_tokens: usage.get("cacheWrite").and_then(Value::as_u64).unwrap_or(0),
        cache_read_input_tokens: usage.get("cacheRead").and_then(Value::as_u64).unwrap_or(0),
        context_window_max: None,
        cost_amount: None,
        cost_currency: None,
    })
}

/// Strip OpenClaw's user-message prefixes: a leading `Sender (untrusted
/// metadata): ``` … ``` ` fence, then any leading bracketed tags (`[timestamp]`,
/// `[Working directory: …]`).
fn strip_user_prefixes(text: &str) -> String {
    let mut rest = text.trim_start();
    if let Some(after) = rest.strip_prefix("Sender (untrusted metadata):") {
        let after = after.trim_start();
        if let Some(fence_body) = after.strip_prefix("```")
            && let Some(end) = fence_body.find("```")
        {
            rest = fence_body[end + 3..].trim_start();
        }
    }
    // Remove leading bracketed groups like "[Tue ...] [Working directory: ...]".
    loop {
        let candidate = rest.trim_start();
        if let Some(close) = candidate.strip_prefix('[').and_then(|r| r.find(']')) {
            rest = &candidate[close + 2..];
        } else {
            rest = candidate;
            break;
        }
    }
    rest.trim().to_string()
}

fn truncate(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\u{2026}", &text[..end])
}

#[cfg(test)]
mod tests {
    use api_types::AgentKind;

    use super::*;

    fn ctx() -> ParseContext {
        ParseContext {
            external_session_id: "3f2a9c10".to_string(),
            agent_type: AgentKind::Openclaw,
            workspace_path: None,
        }
    }

    const FIXTURE: &str = concat!(
        r#"{"type":"session","version":3,"id":"3f2a9c10","timestamp":"2026-03-17T04:46:14.113Z","cwd":"/repo"}"#,
        "\n",
        r#"{"type":"message","id":"u1","parentId":null,"timestamp":"2026-03-17T04:56:22.819Z","message":{"role":"user","content":[{"type":"text","text":"[Tue 2026-03-17 12:56 GMT+8] [Working directory: /repo]\n\nList the files"}]}}"#,
        "\n",
        r#"{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-03-17T04:56:30.466Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"list the dir"},{"type":"text","text":"[[reply_to_current]] Let me list."},{"type":"toolCall","id":"call_abc","name":"bash","arguments":{"command":"ls -la"}}],"model":"claude-opus-4","usage":{"input":6572,"output":246,"cacheRead":3584,"cacheWrite":100}}}"#,
        "\n",
        r#"{"type":"message","id":"t1","parentId":"a1","timestamp":"2026-03-17T04:56:31.000Z","message":{"role":"toolResult","toolCallId":"call_abc","toolName":"bash","content":[{"type":"text","text":"README.md\nsrc"}],"isError":false}}"#,
    );

    #[test]
    fn parses_openclaw_jsonl_with_tool_result_folded() {
        let detail = OpenClawParser.parse(FIXTURE, &ctx()).unwrap();
        assert_eq!(detail.summary.id, "3f2a9c10");
        // Session header skipped; user turn + assistant turn (toolResult folded in).
        assert_eq!(detail.turns.len(), 2);

        assert_eq!(detail.turns[0].role, TurnRole::User);
        match &detail.turns[0].blocks[0] {
            ContentBlock::Text { text } => assert_eq!(text, "List the files"),
            other => panic!("expected stripped user text, got {other:?}"),
        }

        let assistant = &detail.turns[1];
        assert_eq!(assistant.role, TurnRole::Assistant);
        // Thinking, Text (prefix stripped), ToolUse, ToolResult (folded).
        assert_eq!(assistant.blocks.len(), 4);
        assert!(matches!(assistant.blocks[0], ContentBlock::Thinking { .. }));
        match &assistant.blocks[1] {
            ContentBlock::Text { text } => assert_eq!(text, "Let me list."),
            other => panic!("expected stripped assistant text, got {other:?}"),
        }
        assert!(matches!(assistant.blocks[2], ContentBlock::ToolUse { .. }));
        assert!(matches!(
            assistant.blocks[3],
            ContentBlock::ToolResult { .. }
        ));
        assert_eq!(assistant.model.as_deref(), Some("claude-opus-4"));
        assert_eq!(
            assistant.usage.as_ref().unwrap().cache_read_input_tokens,
            3584
        );
    }
}
