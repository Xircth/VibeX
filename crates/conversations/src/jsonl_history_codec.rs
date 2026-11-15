use agents::{
    acp_transcript::{EntryKind, TranscriptEntry},
    conversation::{ContentBlock, MessageTurn, TurnRole},
};
use chrono::{DateTime, Utc};
use serde_json::Value;

pub fn encode_turns(turns: &[MessageTurn]) -> Vec<TranscriptEntry> {
    let mut entries = Vec::new();
    for turn in turns {
        let t = millis(turn.timestamp);
        match turn.role {
            TurnRole::User => entries.push(TranscriptEntry {
                t,
                k: EntryKind::Prompt,
                steer: turn.id.contains(":steer:"),
                p: Value::Array(prompt_blocks(turn)),
            }),
            TurnRole::Assistant | TurnRole::System => {
                let mut pending_msg_id = turn
                    .agent_message_id
                    .as_deref()
                    .filter(|id| !id.trim().is_empty());
                for block in &turn.blocks {
                    if let Some(mut payload) = update_payload(block) {
                        if let Some(msg_id) = pending_msg_id
                            && payload.get("sessionUpdate").and_then(Value::as_str)
                                == Some("agent_message_chunk")
                        {
                            payload["messageId"] = serde_json::json!(msg_id);
                            pending_msg_id = None;
                        }
                        entries.push(TranscriptEntry {
                            t,
                            k: EntryKind::Update,
                            steer: false,
                            p: payload,
                        });
                    }
                }
                if let Some(msg_id) = pending_msg_id {
                    entries.push(TranscriptEntry {
                        t,
                        k: EntryKind::Update,
                        steer: false,
                        p: serde_json::json!({
                            "sessionUpdate": "agent_message_chunk",
                            "messageId": msg_id,
                            "content": { "type": "text", "text": "" }
                        }),
                    });
                }
                if turn.completed_at.is_some()
                    || turn.usage.is_some()
                    || turn.duration_ms.is_some()
                    || turn.model.is_some()
                {
                    let mut end = serde_json::json!({ "stopReason": "end_turn" });
                    if let Some(ms) = turn.duration_ms {
                        end["durationMs"] = serde_json::json!(ms);
                    }
                    if let Some(model) = &turn.model {
                        end["model"] = serde_json::json!(model);
                    }
                    if let Some(usage) = &turn.usage {
                        let mut usage_json = serde_json::json!({
                            "inputTokens": usage.input_tokens,
                            "outputTokens": usage.output_tokens,
                            "cacheCreationInputTokens": usage.cache_creation_input_tokens,
                            "cacheReadInputTokens": usage.cache_read_input_tokens,
                        });
                        if let Some(used) = usage.context_used.filter(|v| *v > 0) {
                            usage_json["contextUsed"] = serde_json::json!(used);
                        }
                        if let Some(max) = usage.context_window_max.filter(|v| *v > 0) {
                            usage_json["contextWindowMax"] = serde_json::json!(max);
                        }
                        end["usage"] = usage_json;
                    }
                    entries.push(TranscriptEntry {
                        t: turn.completed_at.map(millis).unwrap_or(t),
                        k: EntryKind::TurnEnd,
                        steer: false,
                        p: end,
                    });
                }
            }
        }
    }
    entries
}

fn prompt_blocks(turn: &MessageTurn) -> Vec<Value> {
    let mut blocks = Vec::new();
    for block in &turn.blocks {
        match block {
            ContentBlock::Text { text } => {
                blocks.push(serde_json::json!({ "type": "text", "text": text }));
            }
            ContentBlock::Image {
                data,
                mime_type,
                uri,
                ..
            } => {
                blocks.push(serde_json::json!({
                    "type": "image",
                    "data": data,
                    "mimeType": mime_type,
                    "uri": uri,
                }));
            }
            ContentBlock::Resource { uri, title } => {
                blocks.push(serde_json::json!({
                    "type": "resource_link",
                    "uri": uri,
                    "name": title.clone().unwrap_or_else(|| uri.clone()),
                }));
            }
            _ => {}
        }
    }
    if blocks.is_empty() {
        blocks.push(serde_json::json!({ "type": "text", "text": "" }));
    }
    blocks
}

fn update_payload(block: &ContentBlock) -> Option<Value> {
    match block {
        ContentBlock::Text { text } => Some(serde_json::json!({
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "text", "text": text }
        })),
        ContentBlock::Thinking { text } => Some(serde_json::json!({
            "sessionUpdate": "agent_thought_chunk",
            "content": { "type": "text", "text": text }
        })),
        ContentBlock::Image {
            data,
            mime_type,
            uri,
            ..
        } => Some(serde_json::json!({
            "sessionUpdate": "agent_message_chunk",
            "content": {
                "type": "image",
                "data": data,
                "mimeType": mime_type,
                "uri": uri,
            }
        })),
        ContentBlock::Resource { uri, title } => Some(serde_json::json!({
            "sessionUpdate": "agent_message_chunk",
            "content": {
                "type": "resource_link",
                "uri": uri,
                "name": title.clone().unwrap_or_else(|| uri.clone()),
            }
        })),
        ContentBlock::ToolUse {
            tool_use_id,
            tool_name,
            input_preview,
            kind,
            status,
            images,
            ..
        } => {
            let mut obj = serde_json::json!({
                "sessionUpdate": "tool_call",
                "toolCallId": tool_use_id.clone().unwrap_or_else(|| "tool".to_string()),
                "title": tool_name,
                "kind": normalize_acp_tool_kind(kind.as_deref()),
                "status": normalize_acp_tool_status(status.as_deref().unwrap_or("completed")),
                "rawInput": raw_input(input_preview),
            });
            if !images.is_empty() {
                obj["content"] = Value::Array(
                    images
                        .iter()
                        .map(|img| {
                            serde_json::json!({
                                "type": "content",
                                "content": {
                                    "type": "image",
                                    "data": img.data,
                                    "mimeType": img.mime_type,
                                    "uri": img.uri,
                                }
                            })
                        })
                        .collect(),
                );
            }
            Some(obj)
        }
        ContentBlock::ToolResult {
            tool_use_id,
            output_preview,
            is_error,
            ..
        } => {
            let mut content = Vec::new();
            if let Some(text) = output_preview.as_ref().filter(|text| !text.is_empty()) {
                content.push(serde_json::json!({
                    "type": "content",
                    "content": { "type": "text", "text": text }
                }));
            }
            Some(serde_json::json!({
                "sessionUpdate": "tool_call_update",
                "toolCallId": tool_use_id.clone().unwrap_or_else(|| "tool".to_string()),
                "status": if *is_error { "failed" } else { "completed" },
                "content": content,
            }))
        }
        ContentBlock::Plan { entries } => Some(serde_json::json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "acp-plan",
            "title": "TodoWrite",
            "kind": "think",
            "status": "completed",
            "rawInput": { "todos": entries },
        })),
        _ => None,
    }
}

fn raw_input(preview: &Option<String>) -> Value {
    match preview {
        Some(text) => {
            serde_json::from_str(text).unwrap_or_else(|_| serde_json::json!({ "text": text }))
        }
        None => Value::Null,
    }
}

fn millis(timestamp: DateTime<Utc>) -> u64 {
    timestamp.timestamp_millis().max(0) as u64
}

fn normalize_acp_tool_status(status: &str) -> &'static str {
    match status.trim().to_ascii_lowercase().as_str() {
        "running" | "in_progress" | "inprogress" => "in_progress",
        "completed" | "done" | "success" | "succeeded" => "completed",
        "failed" | "error" | "cancelled" | "canceled" => "failed",
        _ => "pending",
    }
}

fn normalize_acp_tool_kind(kind: Option<&str>) -> &'static str {
    match kind.unwrap_or("other").trim().to_ascii_lowercase().as_str() {
        "read" => "read",
        "edit" | "write" | "patch" => "edit",
        "delete" => "delete",
        "move" => "move",
        "search" | "grep" | "glob" | "find" => "search",
        "execute" | "bash" | "command" | "terminal" => "execute",
        "think" => "think",
        "fetch" | "web" | "http" => "fetch",
        "switch_mode" | "switchmode" => "switch_mode",
        _ => "other",
    }
}
