//! Parser for Gemini CLI session files
//! (`~/.gemini/{tmp,history}/<alias>/chats/session-*.{json,jsonl}`).
//!
//! Two on-disk variants share one message model: a `.json` file is a single
//! `{ sessionId, messages: [...] }` document; a `.jsonl` file streams the same
//! shape line-by-line (metadata lines without a `type`, `{"$set":{...}}`
//! updates, and message lines merged by `id`). Each `messages[]` item is one
//! turn; a Gemini tool call is self-contained (invocation + result live in the
//! same `toolCalls[]` entry), so ToolUse/ToolResult are synthesized as a pair.
//! VibeX-authored; the format is Gemini's.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde_json::{Map, Value};

use super::{
    ConversationParser, ParseContext, ParseError, ParsedRecord, build_detail, group_into_turns,
};
use crate::conversation::{ContentBlock, ConversationDetail, TurnRole, TurnUsage};

const PREVIEW_LIMIT: usize = 16384;

pub struct GeminiParser;

impl ConversationParser for GeminiParser {
    fn parse(&self, raw: &str, ctx: &ParseContext) -> Result<ConversationDetail, ParseError> {
        // Variant A: the whole file is one JSON object with `messages`.
        let root = match serde_json::from_str::<Value>(raw) {
            Ok(value) if value.get("messages").is_some() => value,
            // Variant B (or a single message line): fold JSONL into the same shape.
            _ => fold_jsonl(raw),
        };

        let records = root
            .get("messages")
            .and_then(Value::as_array)
            .map(|messages| messages.iter().filter_map(record_from_message).collect())
            .unwrap_or_default();

        Ok(build_detail(group_into_turns(records), ctx))
    }
}

/// Fold `.jsonl` lines into the `{ messages: [...] }` shape. Metadata lines
/// (no `type`) and `$set` updates adjust root fields; message lines sharing an
/// `id` are merged (later keys win) so streaming partials collapse into one.
fn fold_jsonl(raw: &str) -> Value {
    let mut root = Map::new();
    let mut messages: Vec<Value> = Vec::new();
    let mut index_by_id: HashMap<String, usize> = HashMap::new();

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if let Some(set) = value.get("$set").and_then(Value::as_object) {
            for (key, val) in set {
                root.insert(key.clone(), val.clone());
            }
            continue;
        }
        if value.get("type").and_then(Value::as_str).is_some() {
            let id = value.get("id").and_then(Value::as_str).map(str::to_string);
            if let Some(id) = id {
                if let Some(&idx) = index_by_id.get(&id) {
                    if let (Some(existing), Value::Object(new_map)) =
                        (messages[idx].as_object_mut(), &value)
                    {
                        for (key, val) in new_map {
                            existing.insert(key.clone(), val.clone());
                        }
                    }
                    continue;
                }
                index_by_id.insert(id, messages.len());
            }
            messages.push(value);
        } else if let Value::Object(map) = &value {
            for (key, val) in map {
                root.entry(key.clone()).or_insert_with(|| val.clone());
            }
        }
    }

    root.insert("messages".to_string(), Value::Array(messages));
    Value::Object(root)
}

fn record_from_message(message: &Value) -> Option<ParsedRecord> {
    let kind = message.get("type").and_then(Value::as_str)?.to_lowercase();
    let timestamp = message
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(|raw| raw.parse::<DateTime<Utc>>().ok())
        .unwrap_or_else(Utc::now);

    let (role, blocks) = match kind.as_str() {
        "user" => (TurnRole::User, text_blocks(message)),
        "system" => (TurnRole::System, text_blocks(message)),
        "gemini" | "assistant" | "model" => (TurnRole::Assistant, assistant_blocks(message)),
        _ => return None,
    };
    if blocks.is_empty() {
        return None;
    }

    let usage = message.get("tokens").map(|tokens| TurnUsage {
        input_tokens: token_field(tokens, "input"),
        output_tokens: token_field(tokens, "output"),
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: token_field(tokens, "cached"),
        context_window_max: None,
        cost_amount: None,
        cost_currency: None,
    });
    let model = message
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string);

    Some(ParsedRecord {
        role,
        blocks,
        timestamp,
        usage,
        model,
    })
}

fn token_field(tokens: &Value, key: &str) -> u64 {
    tokens.get(key).and_then(Value::as_u64).unwrap_or(0)
}

/// Text-only blocks (user / system messages).
fn text_blocks(message: &Value) -> Vec<ContentBlock> {
    let text = extract_message_text(message);
    if text.is_empty() {
        Vec::new()
    } else {
        vec![ContentBlock::Text { text }]
    }
}

/// Assistant blocks in Gemini's order: thoughts, then each tool call as a
/// ToolUse+ToolResult pair, then the text.
fn assistant_blocks(message: &Value) -> Vec<ContentBlock> {
    let mut blocks = Vec::new();

    if let Some(thoughts) = message.get("thoughts").and_then(Value::as_array) {
        for thought in thoughts {
            let text = thought_text(thought);
            if !text.is_empty() {
                blocks.push(ContentBlock::Thinking { text });
            }
        }
    }

    if let Some(tool_calls) = message.get("toolCalls").and_then(Value::as_array) {
        for call in tool_calls {
            let id = call.get("id").and_then(Value::as_str).map(str::to_string);
            let name = call
                .get("displayName")
                .and_then(Value::as_str)
                .or_else(|| call.get("name").and_then(Value::as_str))
                .unwrap_or("unknown")
                .to_string();
            let input_preview = call
                .get("args")
                .map(|args| args.to_string())
                .or_else(|| call.get("input").map(|input| input.to_string()));
            blocks.push(ContentBlock::ToolUse {
                kind: None,
                tool_use_id: id.clone(),
                tool_name: name,
                input_preview,
                meta: None,
                images: Vec::new(),
            });
            blocks.push(ContentBlock::ToolResult {
                tool_use_id: id,
                output_preview: tool_output(call),
                is_error: tool_is_error(call),
                agent_stats: None,
            });
        }
    }

    let text = extract_message_text(message);
    if !text.is_empty() {
        blocks.push(ContentBlock::Text { text });
    }

    blocks
}

fn thought_text(thought: &Value) -> String {
    let subject = thought.get("subject").and_then(Value::as_str);
    let description = thought.get("description").and_then(Value::as_str);
    match (subject, description) {
        (Some(s), Some(d)) => format!("{s}: {d}"),
        (Some(s), None) => s.to_string(),
        (None, Some(d)) => d.to_string(),
        (None, None) => String::new(),
    }
}

fn tool_output(call: &Value) -> Option<String> {
    let raw = match call.get("resultDisplay") {
        Some(Value::Object(map)) => map
            .get("summary")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| Value::Object(map.clone()).to_string()),
        Some(Value::String(text)) => text.clone(),
        _ => match call.get("result") {
            Some(result) => result.to_string(),
            None => return None,
        },
    };
    Some(preview(&raw))
}

fn tool_is_error(call: &Value) -> bool {
    if let Some(status) = call.get("status").and_then(Value::as_str) {
        let status = status.to_ascii_lowercase();
        if matches!(
            status.as_str(),
            "error" | "failed" | "failure" | "cancelled" | "canceled"
        ) {
            return true;
        }
    }
    if let Some(results) = call.get("result").and_then(Value::as_array) {
        for result in results {
            if result.pointer("/functionResponse/response/error").is_some() {
                return true;
            }
        }
    }
    false
}

/// Extract text from `content` (string, array of parts, or object), falling
/// back to a `message` text key. Image parts are dropped (no VibeX block).
fn extract_message_text(message: &Value) -> String {
    let from_value = |value: &Value| -> String {
        match value {
            Value::String(text) => text.clone(),
            Value::Array(parts) => parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(""),
            Value::Object(map) => map
                .get("text")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_default(),
            _ => String::new(),
        }
    };
    let mut text = message.get("content").map(from_value).unwrap_or_default();
    if text.trim().is_empty() {
        text = message.get("message").map(from_value).unwrap_or_default();
    }
    text.trim().to_string()
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
    use api_types::AgentKind;

    use super::*;

    fn ctx() -> ParseContext {
        ParseContext {
            external_session_id: "32c7d221".to_string(),
            agent_type: AgentKind::Gemini,
            workspace_path: Some("/repo".to_string()),
        }
    }

    const JSON_FIXTURE: &str = r#"{
      "sessionId": "32c7d221",
      "startTime": "2026-03-02T04:30:20.796Z",
      "messages": [
        { "id": "u1", "timestamp": "2026-03-02T04:30:20.796Z", "type": "user",
          "content": [{ "text": "List the files in the repo root." }] },
        { "id": "a1", "timestamp": "2026-03-02T04:33:13.631Z", "type": "gemini",
          "content": "Here are the files.",
          "thoughts": [{ "subject": "Planning", "description": "run list_directory" }],
          "toolCalls": [{
            "id": "list_directory-1", "name": "list_directory", "displayName": "ReadFolder",
            "args": { "path": "." },
            "resultDisplay": { "summary": "Listed 3 entries" }, "status": "success"
          }],
          "tokens": { "input": 128, "output": 64, "cached": 32 },
          "model": "gemini-2.5-pro" }
      ]
    }"#;

    #[test]
    fn parses_single_json_session() {
        let detail = GeminiParser.parse(JSON_FIXTURE, &ctx()).unwrap();
        assert_eq!(detail.summary.id, "32c7d221");
        assert_eq!(detail.turns.len(), 2);
        assert_eq!(detail.turns[0].role, TurnRole::User);

        let assistant = &detail.turns[1];
        assert_eq!(assistant.role, TurnRole::Assistant);
        // Thinking, ToolUse, ToolResult, Text.
        assert_eq!(assistant.blocks.len(), 4);
        assert!(matches!(assistant.blocks[0], ContentBlock::Thinking { .. }));
        assert!(matches!(
            &assistant.blocks[1],
            ContentBlock::ToolUse { tool_name, .. } if tool_name == "ReadFolder"
        ));
        assert!(matches!(
            assistant.blocks[2],
            ContentBlock::ToolResult { .. }
        ));
        assert!(matches!(assistant.blocks[3], ContentBlock::Text { .. }));
        assert_eq!(assistant.model.as_deref(), Some("gemini-2.5-pro"));
        assert_eq!(
            assistant.usage.as_ref().unwrap().cache_read_input_tokens,
            32
        );
    }

    // The .jsonl variant with a header (no `type`), a $set line, and streaming
    // partials merged by id must fold to the same result.
    const JSONL_FIXTURE: &str = concat!(
        r#"{"kind":"main","sessionId":"32c7d221","startTime":"2026-03-02T04:30:20.796Z"}"#,
        "\n",
        r#"{"id":"u1","timestamp":"2026-03-02T04:30:20.796Z","type":"user","content":"hi there"}"#,
        "\n",
        r#"{"id":"a1","timestamp":"2026-03-02T04:33:13.631Z","type":"gemini","content":"partial"}"#,
        "\n",
        r#"{"$set":{"lastUpdated":"2026-03-02T04:33:14.000Z"}}"#,
        "\n",
        r#"{"id":"a1","type":"gemini","content":"final answer","model":"gemini-2.5-pro"}"#,
    );

    #[test]
    fn folds_jsonl_and_merges_partials_by_id() {
        let detail = GeminiParser.parse(JSONL_FIXTURE, &ctx()).unwrap();
        // Two turns (header + $set are not messages); a1's partials merged to one.
        assert_eq!(detail.turns.len(), 2);
        let assistant = &detail.turns[1];
        match &assistant.blocks[0] {
            ContentBlock::Text { text } => assert_eq!(text, "final answer"),
            other => panic!("expected merged Text, got {other:?}"),
        }
    }
}
