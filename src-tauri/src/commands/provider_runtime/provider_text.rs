use std::{path::Path, sync::Arc};

use db::models::execution_process_logs::ExecutionProcessLogs;
use deployment::Deployment;
use executors::logs::{NormalizedEntry, NormalizedEntryType};
use serde_json::{Value, json};
use services::services::container::ContainerService;
use sqlx::SqlitePool;
use tokio::sync::Mutex;
use utils::{log_msg::LogMsg, msg_store::MsgStore};
use uuid::Uuid;

use super::{
    NativeConversationSink, NativeConversationState, PROVIDER_EVENT_HISTORY, ProviderRuntimeEvent,
    ProviderTurnRequest, normalize_provider_runtime_event,
};
use crate::state::AppState;

pub(super) fn codex_input_items(request: &ProviderTurnRequest) -> Vec<Value> {
    let mut input = vec![json!({
        "type": "text",
        "text": request.text,
        "text_elements": [],
    })];
    for image in &request.images {
        if image.starts_with("http://") || image.starts_with("https://") {
            input.push(json!({ "type": "image", "url": image }));
        } else {
            input.push(json!({ "type": "localImage", "path": image }));
        }
    }
    input.extend(codex_provider_option_input_items(
        request.provider_options.get("skills"),
        "skill",
    ));
    input.extend(codex_provider_option_input_items(
        request.provider_options.get("skill_items"),
        "skill",
    ));
    input.extend(codex_provider_option_input_items(
        request.provider_options.get("mentions"),
        "mention",
    ));
    input.extend(codex_provider_option_input_items(
        request.provider_options.get("mention_items"),
        "mention",
    ));
    input.extend(codex_provider_option_input_items(
        request.provider_options.get("apps"),
        "mention",
    ));
    input.extend(codex_provider_option_input_items(
        request.provider_options.get("app_mentions"),
        "mention",
    ));
    input
}

fn codex_provider_option_input_items(value: Option<&Value>, item_type: &str) -> Vec<Value> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| codex_provider_option_input_item(item, item_type))
            .collect(),
        Some(item) => codex_provider_option_input_item(item, item_type)
            .into_iter()
            .collect(),
        None => Vec::new(),
    }
}

fn codex_provider_option_input_item(value: &Value, item_type: &str) -> Option<Value> {
    let item = value.as_object()?;
    let name = item
        .get("name")
        .or_else(|| item.get("displayName"))
        .or_else(|| item.get("display_name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let path = item
        .get("path")
        .or_else(|| item.get("uri"))
        .or_else(|| item.get("url"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            if item_type == "mention" {
                item.get("id")
                    .or_else(|| item.get("appId"))
                    .or_else(|| item.get("app_id"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            } else {
                None
            }
        })?;
    let path = if item_type == "mention" && !path.contains("://") {
        format!("app://{path}")
    } else {
        path.to_string()
    };

    Some(json!({
        "type": item_type,
        "name": name,
        "path": path,
    }))
}

pub(super) fn is_context_compact_prompt(prompt: &str) -> bool {
    let trimmed = prompt.trim();
    let compact_len = "/compact".len();
    let Some(command) = trimmed.get(..compact_len) else {
        return false;
    };
    if !command.eq_ignore_ascii_case("/compact") {
        return false;
    }
    let rest = trimmed.get(compact_len..).unwrap_or_default();
    rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace)
}

pub(super) fn extract_thread_id(value: &Value) -> Option<String> {
    value
        .get("result")
        .and_then(|result| result.get("threadId"))
        .or_else(|| value.get("threadId"))
        .or_else(|| value.get("session_id"))
        .or_else(|| {
            value
                .get("params")
                .and_then(|params| params.get("threadId"))
        })
        .or_else(|| {
            value
                .get("params")
                .and_then(|params| params.get("thread"))
                .and_then(|thread| thread.get("id"))
        })
        .or_else(|| {
            value
                .get("params")
                .and_then(|params| params.get("turn"))
                .and_then(|turn| turn.get("threadId").or_else(|| turn.get("thread_id")))
        })
        .or_else(|| {
            value
                .get("params")
                .and_then(|params| params.get("turn"))
                .and_then(|turn| turn.get("thread"))
                .and_then(|thread| thread.get("id"))
        })
        .or_else(|| {
            value
                .get("turn")
                .and_then(|turn| turn.get("threadId").or_else(|| turn.get("thread_id")))
        })
        .or_else(|| value.get("sessionID"))
        .or_else(|| {
            value
                .get("properties")
                .and_then(|properties| properties.get("sessionID"))
        })
        .or_else(|| value.get("event").and_then(|event| event.get("sessionID")))
        .or_else(|| {
            value
                .get("event")
                .and_then(|event| event.get("properties"))
                .and_then(|properties| properties.get("sessionID"))
        })
        .or_else(|| {
            value
                .get("response")
                .and_then(|response| response.get("info"))
                .and_then(|info| info.get("sessionID"))
        })
        .or_else(|| value.get("event").and_then(|event| event.get("session_id")))
        .or_else(|| {
            value
                .get("result")
                .and_then(|result| result.get("thread"))
                .and_then(|thread| thread.get("id"))
        })
        .or_else(|| {
            value
                .get("result")
                .and_then(|result| result.get("turn"))
                .and_then(|turn| turn.get("threadId").or_else(|| turn.get("thread_id")))
        })
        .or_else(|| {
            value
                .get("response")
                .and_then(|response| response.get("result"))
                .and_then(|result| result.get("thread"))
                .and_then(|thread| thread.get("id"))
        })
        .or_else(|| {
            value
                .get("response")
                .and_then(|response| response.get("result"))
                .and_then(|result| result.get("turn"))
                .and_then(|turn| turn.get("threadId").or_else(|| turn.get("thread_id")))
        })
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

pub(super) fn extract_turn_id(value: &Value) -> Option<String> {
    value
        .get("result")
        .and_then(|result| result.get("turnId"))
        .or_else(|| {
            value
                .get("result")
                .and_then(|result| result.get("turn"))
                .and_then(|turn| turn.get("id"))
        })
        .or_else(|| value.get("turnId"))
        .or_else(|| value.get("uuid"))
        .or_else(|| value.get("params").and_then(|params| params.get("turnId")))
        .or_else(|| {
            value
                .get("params")
                .and_then(|params| params.get("turn"))
                .and_then(|turn| turn.get("id"))
        })
        .or_else(|| value.get("turn").and_then(|turn| turn.get("id")))
        .or_else(|| value.get("event").and_then(|event| event.get("uuid")))
        .or_else(|| {
            value
                .get("event")
                .and_then(|event| event.get("turn"))
                .and_then(|turn| turn.get("id"))
        })
        .or_else(|| {
            value
                .get("response")
                .and_then(|response| response.get("result"))
                .and_then(|result| result.get("turn"))
                .and_then(|turn| turn.get("id"))
        })
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

pub(super) fn codex_runtime_key(workspace_id: &str, workspace_dir: &Path) -> String {
    format!("codex:{workspace_id}:{}", workspace_dir.display())
}

pub(super) async fn push_provider_event(session_id: &str, mut event: ProviderRuntimeEvent) {
    event = normalize_provider_runtime_event(event);
    let key = event.provider.history_key(session_id);
    PROVIDER_EVENT_HISTORY
        .lock()
        .await
        .entry(key)
        .or_default()
        .push(event);
}

pub(super) async fn register_native_conversation_sink(
    state: &tauri::State<'_, AppState>,
    process_id: Uuid,
    session_id: Uuid,
) -> NativeConversationSink {
    let msg_store = Arc::new(MsgStore::new());
    state
        .deployment
        .container()
        .msg_stores()
        .write()
        .await
        .insert(process_id, msg_store.clone());

    NativeConversationSink {
        pool: state.deployment.db().pool.clone(),
        process_id,
        session_id,
        msg_store,
        state: Arc::new(Mutex::new(NativeConversationState::default())),
    }
}

async fn persist_native_log_msg(pool: &SqlitePool, process_id: Uuid, msg: &LogMsg) {
    match serde_json::to_string(msg) {
        Ok(json_line) => {
            if let Err(error) =
                ExecutionProcessLogs::append_log_line(pool, process_id, &format!("{json_line}\n"))
                    .await
            {
                tracing::error!(
                    "Failed to persist native provider log for process {}: {}",
                    process_id,
                    error
                );
            }
        }
        Err(error) => {
            tracing::error!(
                "Failed to serialize native provider log for process {}: {}",
                process_id,
                error
            );
        }
    }
}

pub(super) async fn push_native_log_msg(sink: &NativeConversationSink, msg: LogMsg) {
    sink.msg_store.push(msg.clone());
    persist_native_log_msg(&sink.pool, sink.process_id, &msg).await;
}

pub(super) fn native_normalized_entry(
    entry_type: NormalizedEntryType,
    content: impl Into<String>,
    metadata: Option<Value>,
) -> NormalizedEntry {
    NormalizedEntry {
        timestamp: None,
        entry_type,
        content: content.into(),
        metadata,
    }
}

pub(super) fn provider_event_is_user_echo(value: &Value) -> bool {
    value
        .get("event")
        .and_then(|event| event.get("message"))
        .and_then(|message| message.get("role"))
        .or_else(|| {
            value
                .get("event")
                .and_then(|event| event.get("properties"))
                .and_then(|properties| properties.get("partRole"))
        })
        .or_else(|| {
            value
                .get("event")
                .and_then(|event| event.get("properties"))
                .and_then(|properties| properties.get("info"))
                .and_then(|info| info.get("role"))
        })
        .or_else(|| {
            value
                .get("properties")
                .and_then(|properties| properties.get("partRole"))
        })
        .or_else(|| {
            value
                .get("properties")
                .and_then(|properties| properties.get("info"))
                .and_then(|info| info.get("role"))
        })
        .or_else(|| value.get("message").and_then(|message| message.get("role")))
        .or_else(|| value.get("info").and_then(|info| info.get("role")))
        .or_else(|| value.get("role"))
        .and_then(Value::as_str)
        .is_some_and(|role| role.eq_ignore_ascii_case("user"))
}

pub(super) fn extract_provider_diagnostic_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Value::Array(items) => {
            let text = items
                .iter()
                .filter_map(extract_provider_text)
                .collect::<Vec<_>>()
                .join("\n");
            if text.trim().is_empty() {
                None
            } else {
                Some(text)
            }
        }
        Value::Object(record) => {
            for key in ["text", "delta", "content"] {
                if let Some(text) = record.get(key).and_then(extract_provider_text)
                    && !text.trim().is_empty()
                {
                    return Some(text);
                }
            }
            for key in [
                "message", "parts", "params", "event", "response", "data", "result",
            ] {
                if let Some(text) = record.get(key).and_then(extract_provider_text)
                    && !text.trim().is_empty()
                {
                    return Some(text);
                }
            }
            None
        }
        _ => None,
    }
}

pub(super) fn extract_text_block_content(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => {
            if text.trim().is_empty() {
                None
            } else {
                Some(text.to_string())
            }
        }
        Value::Array(items) => {
            let text = items
                .iter()
                .filter_map(extract_text_block_content)
                .collect::<Vec<_>>()
                .join("");
            if text.trim().is_empty() {
                None
            } else {
                Some(text)
            }
        }
        Value::Object(record) => {
            let block_type = record.get("type").and_then(Value::as_str);
            if let Some(markdown) = image_block_markdown(record, block_type) {
                return Some(markdown);
            }
            match block_type {
                Some("text") | None => record
                    .get("text")
                    .and_then(Value::as_str)
                    .filter(|text| !text.trim().is_empty())
                    .map(ToString::to_string)
                    .or_else(|| record.get("content").and_then(extract_text_block_content))
                    .or_else(|| record.get("parts").and_then(extract_text_block_content)),
                _ => None,
            }
        }
        _ => None,
    }
}

fn image_block_markdown(
    record: &serde_json::Map<String, Value>,
    block_type: Option<&str>,
) -> Option<String> {
    let image_url = record
        .get("url")
        .and_then(Value::as_str)
        .filter(|url| !url.trim().is_empty())
        .or_else(|| {
            record
                .get("image_url")
                .and_then(Value::as_str)
                .filter(|url| !url.trim().is_empty())
        });
    if matches!(block_type, Some("image" | "output_image" | "input_image"))
        && let Some(url) = image_url
    {
        return Some(format!("![Generated image]({url})"));
    }

    if block_type == Some("image_generation_call") {
        let result = record
            .get("result")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|result| !result.is_empty())?;
        let mime_type = record
            .get("mime_type")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|mime| !mime.is_empty())
            .unwrap_or("image/png");
        return Some(format!(
            "![Generated image](<data:{mime_type};base64,{result}>)"
        ));
    }

    None
}

fn extract_assistant_payload_text(value: &Value) -> Option<String> {
    let record = value.as_object()?;
    let role = record.get("role").and_then(Value::as_str).or_else(|| {
        record
            .get("info")
            .and_then(|info| info.get("role"))
            .and_then(Value::as_str)
    });
    if role.is_some_and(|role| role.eq_ignore_ascii_case("user")) {
        return None;
    }

    let event_type = record.get("type").and_then(Value::as_str);
    let is_assistant_payload = role.is_some_and(|role| role.eq_ignore_ascii_case("assistant"))
        || event_type.is_some_and(|event_type| {
            event_type.eq_ignore_ascii_case("assistant")
                || event_type.eq_ignore_ascii_case("agentMessage")
                || event_type.eq_ignore_ascii_case("agent_message")
                || event_type.eq_ignore_ascii_case("assistantMessage")
                || event_type.eq_ignore_ascii_case("assistant_message")
        });
    if is_assistant_payload {
        return record
            .get("text")
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
            .map(ToString::to_string)
            .or_else(|| record.get("content").and_then(extract_text_block_content))
            .or_else(|| record.get("parts").and_then(extract_text_block_content));
    }

    if let Some(items) = record.get("items").and_then(Value::as_array) {
        let text = items
            .iter()
            .filter_map(extract_assistant_payload_text)
            .collect::<Vec<_>>()
            .join("\n");
        if !text.trim().is_empty() {
            return Some(text);
        }
    }

    for key in [
        "message",
        "event",
        "payload",
        "response",
        "params",
        "properties",
        "result",
        "item",
        "part",
        "turn",
    ] {
        if let Some(text) = record.get(key).and_then(extract_assistant_payload_text)
            && !text.trim().is_empty()
        {
            return Some(text);
        }
    }

    None
}

fn opencode_event_payload(value: &Value) -> &Value {
    value
        .get("event")
        .or_else(|| value.get("payload"))
        .unwrap_or(value)
}

fn extract_opencode_event_text(value: &Value) -> Option<String> {
    let value = opencode_event_payload(value);
    if provider_event_is_user_echo(value) {
        return None;
    }
    let record = value.as_object()?;
    let event_type = record.get("type").and_then(Value::as_str);

    if event_type.is_some_and(|event_type| {
        event_type.starts_with("message.part.") || event_type.starts_with("session.next.text.")
    }) {
        return None;
    }

    extract_assistant_payload_text(value)
}

pub(super) fn extract_provider_text(value: &Value) -> Option<String> {
    if let Some(text) = extract_provider_stream_text(value) {
        return Some(text);
    }

    let record = value.as_object()?;
    match record.get("type").and_then(Value::as_str) {
        Some("sdk_event") => {
            if provider_event_is_user_echo(value) {
                return None;
            }
            record
                .get("event")
                .and_then(extract_assistant_payload_text)
                .or_else(|| {
                    let event = record.get("event")?.as_object()?;
                    if event.get("type").and_then(Value::as_str) != Some("result") {
                        return None;
                    }
                    record
                        .get("text")
                        .and_then(Value::as_str)
                        .filter(|text| !text.trim().is_empty())
                        .map(ToString::to_string)
                })
        }
        Some("opencode_sdk_event") => extract_opencode_event_text(value),
        Some("opencode_sdk_response") => record
            .get("response")
            .and_then(extract_assistant_payload_text),
        Some("text_delta") => record
            .get("text")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(ToString::to_string),
        _ => extract_assistant_payload_text(value),
    }
}

fn extract_opencode_stream_text(_value: &Value) -> Option<String> {
    // OpenCode also emits a final opencode_sdk_response with the complete
    // assistant message. Rendering message.part.delta creates one entry per
    // chunk, so streaming text is intentionally ignored for this provider.
    None
}

pub(super) fn extract_provider_stream_text(value: &Value) -> Option<String> {
    let record = value.as_object()?;
    let method = record.get("method").and_then(Value::as_str);
    if method == Some("item/agentMessage/delta") {
        return record
            .get("params")
            .and_then(|params| params.get("delta"))
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(ToString::to_string);
    }

    let event_type = record.get("type").and_then(Value::as_str);
    if event_type == Some("sdk_event")
        && let Some(text) = record.get("event").and_then(extract_provider_stream_text)
    {
        return Some(text);
    }

    if event_type == Some("stream_event")
        && let Some(text) = record
            .get("event")
            .and_then(|event| event.get("delta"))
            .and_then(|delta| {
                if delta.get("type").and_then(Value::as_str) != Some("text_delta") {
                    return None;
                }
                delta.get("text")
            })
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
    {
        return Some(text.to_string());
    }

    if event_type == Some("text_delta") {
        return record
            .get("text")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(ToString::to_string);
    }

    if event_type == Some("opencode_sdk_event")
        && let Some(text) = extract_opencode_stream_text(value)
    {
        return Some(text);
    }

    None
}

pub(super) fn codex_turn_from_response(value: &Value) -> Option<&Value> {
    value
        .get("result")
        .and_then(|result| result.get("turn"))
        .or_else(|| value.get("turn"))
        .or_else(|| value.get("params").and_then(|params| params.get("turn")))
        .or_else(|| {
            value
                .get("response")
                .and_then(|response| response.get("result"))
                .and_then(|result| result.get("turn"))
        })
}

pub(super) fn codex_turn_status(value: &Value) -> Option<&str> {
    codex_turn_from_response(value)?
        .get("status")
        .and_then(Value::as_str)
}

pub(super) fn codex_turn_status_is_complete(status: &str) -> bool {
    matches!(
        status.to_ascii_lowercase().as_str(),
        "completed" | "complete" | "succeeded" | "success"
    )
}

pub(super) fn codex_turn_status_is_terminal(status: &str) -> bool {
    codex_turn_status_is_complete(status)
        || matches!(
            status.to_ascii_lowercase().as_str(),
            "failed" | "error" | "cancelled" | "canceled"
        )
}

pub(super) fn append_provider_assistant_text(
    content: &mut String,
    text: &str,
    is_stream_delta: bool,
) {
    if content.is_empty() {
        content.push_str(text);
        return;
    }

    if !is_stream_delta {
        if text == content {
            return;
        }
        if text.starts_with(content.as_str()) {
            content.clear();
            content.push_str(text);
            return;
        }
        if content.ends_with(text) {
            return;
        }
    }

    if !is_stream_delta {
        content.push('\n');
    }
    content.push_str(text);
}

pub(super) fn extract_provider_assistant_entry_id(value: &Value) -> Option<String> {
    let record = value.as_object()?;

    if record.get("method").and_then(Value::as_str) == Some("item/agentMessage/delta") {
        return record
            .get("params")
            .and_then(|params| {
                params
                    .get("itemId")
                    .or_else(|| params.get("item_id"))
                    .or_else(|| params.get("id"))
            })
            .and_then(Value::as_str)
            .map(ToString::to_string);
    }

    for key in [
        "id",
        "itemId",
        "item_id",
        "messageId",
        "message_id",
        "messageID",
        "partId",
        "part_id",
        "partID",
    ] {
        if let Some(id) = record.get(key).and_then(Value::as_str) {
            return Some(id.to_string());
        }
    }

    for key in [
        "params",
        "event",
        "payload",
        "message",
        "response",
        "properties",
        "result",
        "item",
        "part",
    ] {
        if let Some(id) = record
            .get(key)
            .and_then(extract_provider_assistant_entry_id)
        {
            return Some(id);
        }
    }

    None
}

pub(super) fn provider_event_is_codex_turn_snapshot(value: &Value) -> bool {
    value
        .get("method")
        .and_then(Value::as_str)
        .is_some_and(|method| method == "turn/completed" || method == "thread/compacted")
        || codex_turn_from_response(value).is_some()
}
