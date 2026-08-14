//! Parser for Cline task transcripts
//! (`~/.cline/data/tasks/<id>/api_conversation_history.json`).
//!
//! The file is a single JSON array of Anthropic Messages-API objects. Only
//! `user` and `assistant` roles occur. Assistant messages map to one record.
//! Cline overloads `role:"user"` as a dumping ground — genuine user text,
//! automated bridging, and tool RESULTS all arrive as user messages, the
//! results as text shaped `[tool for 'arg'] Result:\n<output>`. A user message
//! therefore fans out into a System record (tool results) emitted first, then a
//! User record (genuine text). VibeX-authored; the format is Cline's.

use chrono::Utc;
use serde_json::Value;

use super::{
    ConversationParser, ParseContext, ParseError, ParsedRecord, build_detail, group_into_turns,
};
use crate::conversation::{ContentBlock, ConversationDetail, TurnRole};

const TOOL_INPUT_LIMIT: usize = 2000;
const TOOL_OUTPUT_LIMIT: usize = 2000;

pub struct ClineParser;

impl ConversationParser for ClineParser {
    fn parse(&self, raw: &str, ctx: &ParseContext) -> Result<ConversationDetail, ParseError> {
        let messages: Vec<Value> = serde_json::from_str(raw)
            .map_err(|error| ParseError::Malformed(format!("api_conversation_history: {error}")))?;

        let mut records = Vec::new();
        for message in &messages {
            match message.get("role").and_then(Value::as_str) {
                Some("assistant") => {
                    if let Some(record) = assistant_record(message) {
                        records.push(record);
                    }
                }
                Some("user") => records.extend(user_records(message)),
                _ => {}
            }
        }

        Ok(build_detail(group_into_turns(records), ctx))
    }
}

fn assistant_record(message: &Value) -> Option<ParsedRecord> {
    let mut blocks = Vec::new();
    match message.get("content") {
        Some(Value::String(text)) => {
            let text = text.trim();
            if !text.is_empty() {
                blocks.push(ContentBlock::Text {
                    text: text.to_string(),
                });
            }
        }
        Some(Value::Array(items)) => {
            for item in items {
                match item.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(text) = item.get("text").and_then(Value::as_str) {
                            let text = text.trim();
                            if !text.is_empty() {
                                blocks.push(ContentBlock::Text {
                                    text: text.to_string(),
                                });
                            }
                        }
                    }
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
                    Some("tool_use") => blocks.push(ContentBlock::ToolUse {
                        kind: None,
                        tool_use_id: item.get("id").and_then(Value::as_str).map(str::to_string),
                        tool_name: item
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown")
                            .to_string(),
                        input_preview: item
                            .get("input")
                            .map(|input| truncate(&input.to_string(), TOOL_INPUT_LIMIT)),
                        meta: None,
                        images: Vec::new(),
                    }),
                    Some("tool_result") => blocks.push(ContentBlock::ToolResult {
                        tool_use_id: item
                            .get("tool_use_id")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        output_preview: item
                            .get("content")
                            .and_then(Value::as_str)
                            .map(|text| truncate(text, 500)),
                        is_error: item
                            .get("is_error")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        agent_stats: None,
                    }),
                    _ => {}
                }
            }
        }
        _ => {}
    }

    if blocks.is_empty() {
        return None;
    }
    Some(ParsedRecord {
        role: TurnRole::Assistant,
        blocks,
        timestamp: Utc::now(),
        usage: None,
        model: None,
    })
}

/// Split one Cline user message into an optional System record (tool results,
/// emitted first) and an optional User record (genuine text).
fn user_records(message: &Value) -> Vec<ParsedRecord> {
    let texts: Vec<String> = match message.get("content") {
        Some(Value::String(text)) => vec![text.clone()],
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| match item.get("type").and_then(Value::as_str) {
                Some("text") | None => item.get("text").and_then(Value::as_str).map(str::to_string),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    };

    let mut result_blocks = Vec::new();
    let mut user_text_parts = Vec::new();

    for text in &texts {
        let trimmed = text.trim_start();
        if trimmed.starts_with('[') && trimmed.contains("] Result:") {
            let (output, is_error) = tool_result_text(trimmed);
            if !output.is_empty() {
                result_blocks.push(ContentBlock::ToolResult {
                    tool_use_id: None,
                    output_preview: Some(truncate(&output, TOOL_OUTPUT_LIMIT)),
                    is_error,
                    agent_stats: None,
                });
            }
        } else if let Some(feedback) = extract_feedback(text) {
            user_text_parts.push(feedback);
        } else {
            let cleaned = clean_user_text(text);
            if !cleaned.is_empty() {
                user_text_parts.push(cleaned);
            }
        }
    }

    let mut records = Vec::new();
    if !result_blocks.is_empty() {
        records.push(ParsedRecord {
            role: TurnRole::System,
            blocks: result_blocks,
            timestamp: Utc::now(),
            usage: None,
            model: None,
        });
    }
    let user_text = user_text_parts.join("\n").trim().to_string();
    if !user_text.is_empty() {
        records.push(ParsedRecord {
            role: TurnRole::User,
            blocks: vec![ContentBlock::Text { text: user_text }],
            timestamp: Utc::now(),
            usage: None,
            model: None,
        });
    }
    records
}

/// Extract the output body after `] Result:` and infer error from markers.
fn tool_result_text(text: &str) -> (String, bool) {
    let output = text
        .split_once("] Result:")
        .map(|(_, rest)| rest.trim())
        .unwrap_or("")
        .to_string();
    let output = strip_bridging(&output);
    let is_error = output.contains("[ERROR]") || output.contains("Error:");
    (output, is_error)
}

/// Cut trailing automated-bridging tails that Cline appends to tool output.
fn strip_bridging(text: &str) -> String {
    const MARKERS: &[&str] = &[
        "The user has provided feedback",
        "(This is an automated message",
        "# Next Steps",
    ];
    let mut end = text.len();
    for marker in MARKERS {
        if let Some(pos) = text.find(marker) {
            end = end.min(pos);
        }
    }
    text[..end].trim().to_string()
}

/// Extract `<feedback>...</feedback>` inner text if present.
fn extract_feedback(text: &str) -> Option<String> {
    let start = text.find("<feedback>")? + "<feedback>".len();
    let end = text[start..].find("</feedback>")? + start;
    let inner = text[start..end].trim();
    if inner.is_empty() {
        None
    } else {
        Some(inner.to_string())
    }
}

/// Remove Cline noise from genuine user text: `<environment_details>` blocks,
/// `<task>` wrappers (kept inner), and the automated no-tool nag.
fn clean_user_text(text: &str) -> String {
    if text.contains("[ERROR] You did not use a tool") {
        return String::new();
    }
    let mut cleaned = remove_tag_block(text, "environment_details");
    cleaned = unwrap_tag(&cleaned, "task");
    cleaned.trim().to_string()
}

fn remove_tag_block(text: &str, tag: &str) -> String {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut out = text.to_string();
    while let (Some(start), Some(end)) = (out.find(&open), out.find(&close)) {
        if end < start {
            break;
        }
        out.replace_range(start..end + close.len(), "");
    }
    out
}

fn unwrap_tag(text: &str, tag: &str) -> String {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    if let (Some(start), Some(end)) = (text.find(&open), text.find(&close))
        && start < end
    {
        let inner = &text[start + open.len()..end];
        let mut out = text.to_string();
        out.replace_range(start..end + close.len(), inner.trim());
        return out;
    }
    text.to_string()
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
            external_session_id: "1735689600000".to_string(),
            agent_type: AgentKind::Cline,
            workspace_path: None,
        }
    }

    const FIXTURE: &str = r#"[
      { "role": "user", "content": "<task>\nFix the missing semicolon in main.rs\n</task>\n\n<environment_details>\n# VSCode Visible Files\nsrc/main.rs\n</environment_details>" },
      { "role": "assistant", "content": [
        { "type": "text", "text": "I'll read the file." },
        { "type": "tool_use", "id": "toolu_01ABC", "name": "read_file", "input": { "path": "src/main.rs" } }
      ] },
      { "role": "user", "content": [
        { "type": "text", "text": "[read_file for 'src/main.rs'] Result:\nfn main() {\n    println!(\"Hi\")\n}" }
      ] },
      { "role": "assistant", "content": [
        { "type": "text", "text": "Added the semicolon." }
      ] }
    ]"#;

    #[test]
    fn parses_cline_task_with_user_fanout() {
        let detail = ClineParser.parse(FIXTURE, &ctx()).unwrap();
        assert_eq!(detail.summary.id, "1735689600000");
        // User, Assistant, System(tool result), Assistant.
        assert_eq!(detail.turns.len(), 4);

        assert_eq!(detail.turns[0].role, TurnRole::User);
        match &detail.turns[0].blocks[0] {
            ContentBlock::Text { text } => {
                assert_eq!(text, "Fix the missing semicolon in main.rs")
            }
            other => panic!("expected task text, got {other:?}"),
        }

        assert_eq!(detail.turns[1].role, TurnRole::Assistant);
        assert!(matches!(
            detail.turns[1].blocks[1],
            ContentBlock::ToolUse { .. }
        ));

        assert_eq!(detail.turns[2].role, TurnRole::System);
        match &detail.turns[2].blocks[0] {
            ContentBlock::ToolResult {
                output_preview,
                is_error,
                ..
            } => {
                assert!(output_preview.as_ref().unwrap().contains("fn main()"));
                assert!(!is_error);
            }
            other => panic!("expected tool result, got {other:?}"),
        }

        assert_eq!(detail.turns[3].role, TurnRole::Assistant);
    }

    #[test]
    fn extracts_feedback_and_drops_no_tool_nag() {
        let raw = r#"[
          { "role": "user", "content": "<feedback>\nPlease also add tests\n</feedback>" },
          { "role": "user", "content": "[ERROR] You did not use a tool in your previous response!" }
        ]"#;
        let detail = ClineParser.parse(raw, &ctx()).unwrap();
        assert_eq!(detail.turns.len(), 1);
        match &detail.turns[0].blocks[0] {
            ContentBlock::Text { text } => assert_eq!(text, "Please also add tests"),
            other => panic!("expected feedback text, got {other:?}"),
        }
    }
}
