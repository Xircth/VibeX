//! DeepSeek Harness session logs (`session.jsonl` / `session.jsonl.zstd`).
//!
//! Layout from `dsh-session-persistence-jsonl` as driven by deepseek-acp
//! 0.6.0–0.8.0: `{type, seq, time, data}` envelopes. 0.6.0 added image blocks
//! and `compaction/*`. 0.8.0 put a stable `message.id` on assistant messages
//! for AIR historical fork.

use std::{collections::HashMap, path::Path};

use chrono::{DateTime, Utc};
use serde_json::Value;

use super::{
    AgentHistoryError, AgentKind, ImportedAgentMessage, ImportedAgentMessageMetadata,
    ImportedAgentMessageRole, ImportedAgentSession, image_placeholder, parse_jsonl_history,
    session_id_from_value, title_from_content,
};

pub(super) fn parse_deepseek_history(
    path: &Path,
    raw: &str,
) -> Result<Vec<ImportedAgentSession>, AgentHistoryError> {
    if !is_dsh_event_log(raw) {
        return parse_jsonl_history(AgentKind::DeepseekHarness, path, raw);
    }
    Ok(parse_dsh_event_log(path, raw).into_iter().collect())
}

pub(super) fn read_zstd_prefix(path: &Path) -> Result<String, AgentHistoryError> {
    let bytes = std::fs::read(path).map_err(|error| AgentHistoryError::Read {
        path: path.to_path_buf(),
        error: error.to_string(),
    })?;
    Ok(decode_zstd_frames_prefix(&bytes))
}

/// Decode complete Zstandard frames and keep the prefix when the last frame is
/// truncated. deepseek-acp appends one frame per batch, so a live session can
/// be read mid-flush.
fn decode_zstd_frames_prefix(bytes: &[u8]) -> String {
    use std::io::Read as _;
    let Ok(mut decoder) = zstd::stream::read::Decoder::with_buffer(bytes) else {
        return String::new();
    };
    let mut decoded = Vec::new();
    let _ = decoder.read_to_end(&mut decoded);
    String::from_utf8_lossy(&decoded).into_owned()
}

fn is_dsh_event_log(raw: &str) -> bool {
    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .any(|line| {
            let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
                return false;
            };
            matches!(
                value.get("type").and_then(Value::as_str),
                Some(
                    "session"
                        | "user/message"
                        | "assistant/message"
                        | "tool/result"
                        | "compaction/start"
                        | "compaction/summary"
                        | "compaction/end"
                        | "session/title"
                        | "turn/start"
                        | "turn/end"
                )
            )
        })
}

#[derive(Default)]
struct OpenCompaction {
    started_at: Option<DateTime<Utc>>,
    manual: bool,
    pre_tokens: Option<u64>,
    post_tokens: Option<u64>,
}

fn parse_dsh_event_log(path: &Path, raw: &str) -> Option<ImportedAgentSession> {
    let mut cwd = None;
    let mut title = None;
    let mut first_user_text = None;
    let mut messages = Vec::new();
    let mut open_compactions: HashMap<String, OpenCompaction> = HashMap::new();
    let mut turn_opening_id: Option<String> = None;
    let mut delegation_depth = 0u64;

    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let event_type = value.get("type").and_then(Value::as_str).unwrap_or("");
        if matches!(
            event_type,
            "assistant/chunk" | "tool-call-chunks" | "reasoning-chunks" | "text-chunks"
        ) {
            continue;
        }
        let ts = event_millis(&value);
        let data = value.get("data");

        match event_type {
            "session" => {
                cwd = string_field(&value, "cwd");
                delegation_depth = value
                    .get("delegationDepth")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
            }
            "turn/start" => {
                turn_opening_id = None;
            }
            "session/title" => {
                if let Some(next) = data.and_then(|data| string_field(data, "title")) {
                    title = Some(next);
                }
            }
            "user/message" => {
                let Some(data) = data else { continue };
                if data.pointer("/source/kind").and_then(Value::as_str) != Some("user") {
                    continue;
                }
                let text = collect_text_parts(data.get("content"));
                let images = collect_image_placeholders(data.get("content"));
                if text.trim().is_empty() && images.is_empty() {
                    continue;
                }
                let mut content = text;
                if !images.is_empty() {
                    if !content.trim().is_empty() {
                        content.push('\n');
                    }
                    content.push_str(&images.join("\n"));
                }
                if first_user_text.is_none() && !content.trim().is_empty() {
                    first_user_text = Some(title_from_content(&content));
                }
                messages.push(ImportedAgentMessage {
                    role: ImportedAgentMessageRole::User,
                    content,
                    created_at: ts,
                    metadata: ImportedAgentMessageMetadata::default(),
                });
            }
            "assistant/message" => {
                let Some(data) = data else { continue };
                let message = data.get("message");
                let message_id = message
                    .and_then(|message| string_field(message, "id"))
                    .or_else(|| string_field(data, "id"));
                if turn_opening_id.is_none() {
                    turn_opening_id.clone_from(&message_id);
                }
                let fork_id = turn_opening_id.clone().or(message_id);
                let model = message
                    .and_then(|message| message.pointer("/source/model"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|model| !model.is_empty())
                    .map(str::to_string);
                let Some(blocks) = message.and_then(|message| message.get("content")) else {
                    continue;
                };
                messages.extend(assistant_blocks(
                    blocks,
                    ts,
                    fork_id,
                    model,
                    data.get("usage"),
                ));
            }
            "tool/result" => {
                let Some(data) = data else { continue };
                let result = data
                    .pointer("/message/content")
                    .and_then(Value::as_array)
                    .and_then(|items| {
                        items.iter().find(|item| {
                            item.get("type").and_then(Value::as_str) == Some("tool-result")
                        })
                    });
                let tool_call_id = result
                    .and_then(|result| string_field(result, "toolCallId"))
                    .or_else(|| {
                        data.pointer("/message/source/callId")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|id| !id.is_empty())
                            .map(str::to_string)
                    });
                let output = result
                    .map(|result| collect_text_parts(result.get("content")))
                    .unwrap_or_default();
                let is_error = result
                    .and_then(|result| result.get("isError"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    || data.get("error").is_some_and(|error| !error.is_null());
                messages.push(ImportedAgentMessage {
                    role: ImportedAgentMessageRole::Tool,
                    content: if output.trim().is_empty() {
                        format!(
                            "[tool result: {}]",
                            tool_call_id.as_deref().unwrap_or("unknown")
                        )
                    } else {
                        output
                    },
                    created_at: ts,
                    metadata: ImportedAgentMessageMetadata {
                        kind: Some("tool_result".to_string()),
                        tool_call_id,
                        tool_status: Some(if is_error {
                            "failed".to_string()
                        } else {
                            "completed".to_string()
                        }),
                        raw_output: result.and_then(|result| result.get("content")).cloned(),
                        ..Default::default()
                    },
                });
            }
            "compaction/start" => {
                let Some(data) = data else { continue };
                let Some(id) = compaction_id(data) else {
                    continue;
                };
                let entry = open_compactions.entry(id).or_default();
                entry.started_at = ts;
                entry.manual = data.get("sourceCommandId").is_some();
            }
            "compaction/summary" => {
                let Some(data) = data else { continue };
                let Some(id) = compaction_id(data) else {
                    continue;
                };
                let entry = open_compactions.entry(id).or_default();
                if data.get("sourceCommandId").is_some() {
                    entry.manual = true;
                }
                entry.pre_tokens = data.get("shadowedTokenCount").and_then(Value::as_u64);
                entry.post_tokens = data.pointer("/usage/outputTokens").and_then(Value::as_u64);
            }
            "compaction/end" => {
                let Some(data) = data else { continue };
                let Some(id) = compaction_id(data) else {
                    continue;
                };
                let entry = open_compactions.remove(&id).unwrap_or_default();
                let error = data
                    .get("error")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|error| !error.is_empty());
                let manual = entry.manual || data.get("sourceCommandId").is_some();
                let mut marker = serde_json::Map::new();
                marker.insert("version".into(), Value::from(1));
                marker.insert(
                    "trigger".into(),
                    Value::from(if manual { "manual" } else { "auto" }),
                );
                if error.is_none() {
                    if let Some(pre) = entry.pre_tokens {
                        marker.insert("preTokens".into(), Value::from(pre));
                    }
                    if let Some(post) = entry.post_tokens {
                        marker.insert("postTokens".into(), Value::from(post));
                    }
                }
                if let (Some(started), Some(ended)) = (entry.started_at, ts) {
                    let elapsed = (ended - started).num_milliseconds();
                    if elapsed > 0 {
                        marker.insert("durationMs".into(), Value::from(elapsed));
                    }
                }
                if let Some(error) = error {
                    marker.insert("error".into(), Value::from(error));
                }
                messages.push(ImportedAgentMessage {
                    role: ImportedAgentMessageRole::Tool,
                    content: "[tool: context_compaction]".to_string(),
                    created_at: ts,
                    metadata: ImportedAgentMessageMetadata {
                        kind: Some("context_compaction".to_string()),
                        tool_call_id: Some(id),
                        tool_name: Some("context_compaction".to_string()),
                        tool_status: Some(if error.is_some() {
                            "failed".to_string()
                        } else {
                            "completed".to_string()
                        }),
                        raw_input: Some(Value::Object(
                            [("contextCompaction".to_string(), Value::Object(marker))]
                                .into_iter()
                                .collect(),
                        )),
                        ..Default::default()
                    },
                });
            }
            _ => {}
        }
    }

    if delegation_depth > 0 || messages.is_empty() {
        return None;
    }

    Some(ImportedAgentSession {
        source_agent: AgentKind::DeepseekHarness,
        external_session_id: session_id_from_value(AgentKind::DeepseekHarness, path, &Value::Null),
        title: title.or(first_user_text),
        workspace_path: cwd.map(std::path::PathBuf::from),
        messages,
        raw_source_path: Some(path.to_path_buf()),
    })
}

fn assistant_blocks(
    content: &Value,
    created_at: Option<DateTime<Utc>>,
    agent_message_id: Option<String>,
    model: Option<String>,
    usage: Option<&Value>,
) -> Vec<ImportedAgentMessage> {
    let mut out = Vec::new();
    let Some(items) = content.as_array() else {
        if let Some(text) = content
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
        {
            out.push(assistant_text(
                text.to_string(),
                created_at,
                agent_message_id,
                model,
                usage,
                None,
            ));
        }
        return out;
    };
    for item in items {
        match item.get("type").and_then(Value::as_str).unwrap_or("") {
            "text" => {
                let text = item
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim();
                if text.is_empty() {
                    continue;
                }
                out.push(assistant_text(
                    text.to_string(),
                    created_at,
                    agent_message_id.clone(),
                    model.clone(),
                    usage,
                    None,
                ));
            }
            "reasoning" => {
                let text = item
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim();
                if text.is_empty() {
                    continue;
                }
                out.push(assistant_text(
                    text.to_string(),
                    created_at,
                    agent_message_id.clone(),
                    model.clone(),
                    usage,
                    Some("reasoning"),
                ));
            }
            "tool-call" => {
                let name = item
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let id = string_field(item, "id");
                let input = item.get("arguments").cloned();
                out.push(ImportedAgentMessage {
                    role: ImportedAgentMessageRole::Tool,
                    content: format!("[tool: {name}]"),
                    created_at,
                    metadata: ImportedAgentMessageMetadata {
                        kind: Some("tool_call".to_string()),
                        tool_call_id: id,
                        tool_name: Some(name.to_string()),
                        raw_input: input,
                        agent_message_id: agent_message_id.clone(),
                        model: model.clone(),
                        ..Default::default()
                    },
                });
            }
            "image" => {
                out.push(ImportedAgentMessage {
                    role: ImportedAgentMessageRole::Assistant,
                    content: image_placeholder(item),
                    created_at,
                    metadata: ImportedAgentMessageMetadata {
                        kind: Some("image".to_string()),
                        agent_message_id: agent_message_id.clone(),
                        model: model.clone(),
                        ..Default::default()
                    },
                });
            }
            _ => {}
        }
    }
    out
}

fn assistant_text(
    content: String,
    created_at: Option<DateTime<Utc>>,
    agent_message_id: Option<String>,
    model: Option<String>,
    usage: Option<&Value>,
    kind: Option<&str>,
) -> ImportedAgentMessage {
    ImportedAgentMessage {
        role: ImportedAgentMessageRole::Assistant,
        content,
        created_at,
        metadata: ImportedAgentMessageMetadata {
            kind: kind.map(str::to_string),
            agent_message_id,
            model,
            input_tokens: usage.and_then(|usage| {
                usage
                    .get("inputTokens")
                    .and_then(Value::as_u64)
                    .and_then(|value| u32::try_from(value).ok())
            }),
            output_tokens: usage.and_then(|usage| {
                usage
                    .get("outputTokens")
                    .and_then(Value::as_u64)
                    .and_then(|value| u32::try_from(value).ok())
            }),
            ..Default::default()
        },
    }
}

fn collect_text_parts(content: Option<&Value>) -> String {
    let Some(items) = content.and_then(Value::as_array) else {
        return content
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
    };
    let mut out = String::new();
    for item in items {
        if item.get("type").and_then(Value::as_str) != Some("text") {
            continue;
        }
        let Some(text) = item.get("text").and_then(Value::as_str) else {
            continue;
        };
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(text);
    }
    out
}

fn collect_image_placeholders(content: Option<&Value>) -> Vec<String> {
    let Some(items) = content.and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("image"))
        .map(image_placeholder)
        .collect()
}

fn compaction_id(data: &Value) -> Option<String> {
    data.get("compactionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn event_millis(value: &Value) -> Option<DateTime<Utc>> {
    DateTime::from_timestamp_millis(value.get("time")?.as_i64()?)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn event(event_type: &str, seq: u64, time: i64, data: Value) -> String {
        json!({"type": event_type, "seq": seq, "time": time, "data": data}).to_string()
    }

    fn header_line(cwd: &str) -> String {
        json!({
            "type": "session",
            "version": 0,
            "id": "0126397e-97b1-4420-a564-bffe4453915b",
            "createdAt": 1_786_708_736_990_i64,
            "cwd": cwd,
            "delegationDepth": 0
        })
        .to_string()
    }

    fn parse(raw: &str) -> ImportedAgentSession {
        parse_deepseek_history(Path::new("/tmp/sessions/demo/ds-1/session.jsonl"), raw)
            .unwrap()
            .into_iter()
            .next()
            .expect("session")
    }

    #[test]
    fn event_log_keeps_opening_message_id_and_skips_plugin_prompts() {
        let log = [
            header_line("/Users/demo/project"),
            event("turn/start", 1, 1_000, json!({"turn": 1})),
            event(
                "user/message",
                2,
                1_010,
                json!({
                    "content": [{"type": "text", "text": "Read the file"}],
                    "source": {"kind": "user"},
                    "role": "user",
                    "id": "u-1"
                }),
            ),
            event(
                "user/message",
                3,
                1_011,
                json!({
                    "content": [{"type": "text", "text": "Current runtime context."}],
                    "source": {"kind": "plugin", "plugin": "@deepseek-ai/dsh-system-prompt"},
                    "role": "user",
                    "id": "u-2"
                }),
            ),
            event(
                "assistant/message",
                4,
                1_100,
                json!({
                    "turn": 1, "step": 1,
                    "message": {
                        "role": "assistant",
                        "content": [{"type": "reasoning", "text": "look"}, {"type": "text", "text": "done"}],
                        "source": {"kind": "model", "model": "deepseek-v4-flash"},
                        "id": "a-1"
                    }
                }),
            ),
            event(
                "assistant/message",
                5,
                1_200,
                json!({
                    "turn": 1, "step": 2,
                    "message": {
                        "role": "assistant",
                        "content": [{"type": "text", "text": "more"}],
                        "source": {"kind": "model", "model": "deepseek-v4-flash"},
                        "id": "a-2"
                    }
                }),
            ),
            event("session/title", 6, 1_050, json!({"title": "Read the file"})),
        ]
        .join("\n");

        let session = parse(&log);
        assert_eq!(session.external_session_id, "ds-1");
        assert_eq!(
            session.workspace_path.as_deref(),
            Some(Path::new("/Users/demo/project"))
        );
        assert_eq!(session.title.as_deref(), Some("Read the file"));
        assert_eq!(session.messages[0].role, ImportedAgentMessageRole::User);
        assert_eq!(session.messages[0].content, "Read the file");
        assert!(
            !session
                .messages
                .iter()
                .any(|message| message.content.contains("runtime context"))
        );
        assert_eq!(
            session.messages[1].metadata.agent_message_id.as_deref(),
            Some("a-1")
        );
        assert_eq!(
            session.messages[1].metadata.kind.as_deref(),
            Some("reasoning")
        );
        assert_eq!(
            session.messages[2].metadata.agent_message_id.as_deref(),
            Some("a-1")
        );
        assert_eq!(session.messages[2].content, "done");
        assert_eq!(
            session.messages[3].metadata.agent_message_id.as_deref(),
            Some("a-1")
        );
    }

    #[test]
    fn blank_message_id_is_not_a_fork_name() {
        let log = [
            header_line("/w"),
            event(
                "assistant/message",
                1,
                1_100,
                json!({
                    "message": {
                        "role": "assistant",
                        "content": [{"type": "text", "text": "hi"}],
                        "id": "  "
                    }
                }),
            ),
        ]
        .join("\n");
        let session = parse(&log);
        assert_eq!(session.messages[0].metadata.agent_message_id, None);
    }

    #[test]
    fn compaction_end_emits_a_context_compaction_tool() {
        let log = [
            header_line("/w"),
            event(
                "compaction/start",
                1,
                1_100,
                json!({"compactionId": "c-1", "turn": 1}),
            ),
            event(
                "compaction/summary",
                2,
                1_200,
                json!({
                    "compactionId": "c-1",
                    "shadowedTokenCount": 4000,
                    "usage": {"outputTokens": 120}
                }),
            ),
            event(
                "compaction/end",
                3,
                2_400,
                json!({"compactionId": "c-1", "turn": 1}),
            ),
        ]
        .join("\n");
        let session = parse(&log);
        let tool = session
            .messages
            .iter()
            .find(|message| message.metadata.tool_name.as_deref() == Some("context_compaction"))
            .expect("compaction tool");
        assert_eq!(tool.metadata.tool_call_id.as_deref(), Some("c-1"));
        assert_eq!(tool.metadata.tool_status.as_deref(), Some("completed"));
        let marker = tool
            .metadata
            .raw_input
            .as_ref()
            .and_then(|value| value.get("contextCompaction"))
            .expect("marker");
        assert_eq!(marker.get("trigger").and_then(Value::as_str), Some("auto"));
        assert_eq!(marker.get("preTokens").and_then(Value::as_u64), Some(4000));
        assert_eq!(marker.get("postTokens").and_then(Value::as_u64), Some(120));
        assert_eq!(marker.get("durationMs").and_then(Value::as_i64), Some(1300));
    }

    #[test]
    fn delegated_sessions_are_not_imported() {
        let header = json!({
            "type": "session",
            "cwd": "/w",
            "delegationDepth": 1
        })
        .to_string();
        let log = [
            header,
            event(
                "user/message",
                1,
                1_000,
                json!({
                    "content": [{"type": "text", "text": "hi"}],
                    "source": {"kind": "user"},
                    "role": "user"
                }),
            ),
        ]
        .join("\n");
        assert!(
            parse_deepseek_history(Path::new("/tmp/sessions/demo/ds-1/session.jsonl"), &log)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn simple_role_content_logs_still_parse() {
        let raw = concat!(
            r#"{"role":"user","content":"Read the file"}"#,
            "\n",
            r#"{"role":"assistant","content":"Done"}"#,
            "\n"
        );
        let sessions =
            parse_deepseek_history(Path::new("/tmp/sessions/demo/ds-1/session.jsonl"), raw)
                .unwrap();
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].messages[0].content, "Read the file");
    }
}
