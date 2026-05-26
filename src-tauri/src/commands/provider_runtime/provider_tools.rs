use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use executors::logs::{
    ActionType, CommandExitStatus, CommandRunResult, FileChange, ToolResult, ToolResultValueType,
    ToolStatus,
};
use serde_json::Value;

use super::{NativeToolUpdate, extract_text_block_content};

fn value_string<'a>(record: &'a serde_json::Map<String, Value>, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|key| record.get(*key)?.as_str())
}

fn normalize_tool_name(name: &str) -> String {
    let trimmed = name.trim();
    let trimmed = trimmed
        .strip_prefix("Collab:")
        .or_else(|| trimmed.strip_prefix("collab:"))
        .or_else(|| trimmed.strip_prefix("Tool:"))
        .or_else(|| trimmed.strip_prefix("tool:"))
        .map(str::trim)
        .unwrap_or(trimmed);
    if trimmed.is_empty() {
        "tool".to_string()
    } else {
        trimmed.to_string()
    }
}

fn provider_tool_id(record: &serde_json::Map<String, Value>, fallback: &str) -> String {
    value_string(
        record,
        &[
            "id",
            "tool_use_id",
            "toolUseId",
            "tool_call_id",
            "toolCallId",
            "call_id",
            "callId",
            "callID",
            "item_id",
            "itemId",
            "messageID",
            "partID",
            "part_id",
            "partId",
            "process_id",
            "processId",
            "process_handle",
            "processHandle",
        ],
    )
    .map(ToString::to_string)
    .unwrap_or_else(|| fallback.to_string())
}

fn provider_tool_status(value: &Value) -> ToolStatus {
    let status = value
        .as_object()
        .and_then(|record| {
            value_string(
                record,
                &["status", "state", "phase", "subtype", "outcome", "result"],
            )
        })
        .unwrap_or_default()
        .to_ascii_lowercase();

    if status.contains("fail") || status.contains("error") {
        ToolStatus::Failed
    } else if status.contains("complete")
        || status.contains("success")
        || status.contains("done")
        || status == "ok"
    {
        ToolStatus::Success
    } else {
        ToolStatus::Created
    }
}

fn tool_result_from_text(text: String) -> Option<ToolResult> {
    if text.trim().is_empty() {
        None
    } else {
        Some(ToolResult {
            r#type: ToolResultValueType::Markdown,
            value: Value::String(text),
        })
    }
}

fn stringify_tool_value(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => (!text.trim().is_empty()).then(|| text.clone()),
        Value::Array(items) => {
            let parts = items
                .iter()
                .filter_map(extract_text_block_content)
                .collect::<Vec<_>>();
            (!parts.is_empty()).then(|| parts.join("\n"))
        }
        Value::Object(record) => record
            .get("text")
            .or_else(|| record.get("content"))
            .or_else(|| record.get("output"))
            .or_else(|| record.get("result"))
            .and_then(stringify_tool_value)
            .or_else(|| Some(value.to_string())),
        _ => Some(value.to_string()),
    }
}

fn tool_input_value<'a>(
    record: &'a serde_json::Map<String, Value>,
    keys: &[&str],
) -> Option<&'a Value> {
    keys.iter().find_map(|key| record.get(*key))
}

fn tool_input_object(
    record: &serde_json::Map<String, Value>,
) -> Option<&serde_json::Map<String, Value>> {
    tool_input_value(record, &["input", "arguments", "args", "params"])
        .and_then(Value::as_object)
        .or(Some(record))
}

fn tool_path_from_input(input: &serde_json::Map<String, Value>) -> Option<String> {
    value_string(
        input,
        &[
            "path",
            "file_path",
            "filePath",
            "filepath",
            "filename",
            "file",
        ],
    )
    .map(ToString::to_string)
}

fn tool_command_from_input(input: &serde_json::Map<String, Value>, fallback: &str) -> String {
    value_string(input, &["command", "cmd", "script", "shell", "input"])
        .filter(|command| !command.trim().is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn tool_output_from_record(record: &serde_json::Map<String, Value>) -> Option<String> {
    [
        "aggregatedOutput",
        "output",
        "result",
        "response",
        "stdout",
        "stderr",
        "text",
        "message",
        "content",
        "error",
    ]
    .iter()
    .find_map(|key| record.get(*key).and_then(stringify_tool_value))
}

fn is_task_create_tool_name(normalized: &str) -> bool {
    matches!(
        normalized,
        "task"
            | "subagent"
            | "subagentcreate"
            | "createsubagent"
            | "createagent"
            | "spawnagent"
            | "delegate"
            | "delegatetask"
            | "taskcreate"
    )
}

fn task_create_action_from_input(
    normalized_tool_name: &str,
    tool_name: &str,
    input: &serde_json::Map<String, Value>,
    raw_input: Option<Value>,
) -> Option<ActionType> {
    let parsed_raw_input = raw_input
        .as_ref()
        .and_then(Value::as_str)
        .and_then(|text| serde_json::from_str::<Value>(text).ok());
    let task_input = parsed_raw_input
        .as_ref()
        .and_then(Value::as_object)
        .unwrap_or(input);
    let has_task_signal = is_task_create_tool_name(normalized_tool_name)
        || value_string(
            task_input,
            &["subagent_type", "agent_type", "agent", "role"],
        )
        .is_some();

    if !has_task_signal {
        return None;
    }

    let description = value_string(
        task_input,
        &[
            "description",
            "prompt",
            "task",
            "output",
            "text",
            "title",
            "summary",
            "message",
            "instruction",
            "instructions",
        ],
    )
    .filter(|text| !text.trim().is_empty())
    .map(|text| text.trim().trim_matches('`').to_string())
    .or_else(|| {
        raw_input
            .as_ref()
            .and_then(stringify_tool_value)
            .filter(|text| !text.trim().is_empty())
    })
    .unwrap_or_else(|| tool_name.to_string());

    let subagent_type = value_string(
        task_input,
        &["subagent_type", "agent_type", "agent", "kind", "role"],
    )
    .filter(|value| !value.trim().is_empty())
    .map(ToString::to_string);

    Some(ActionType::TaskCreate {
        description,
        subagent_type,
        result: None,
    })
}

fn provider_tool_action(tool_name: &str, record: &serde_json::Map<String, Value>) -> ActionType {
    let normalized = tool_name
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    let input = tool_input_object(record).unwrap_or(record);
    let raw_input = tool_input_value(record, &["input", "arguments", "args", "params"]).cloned();

    if let Some(action) =
        task_create_action_from_input(&normalized, tool_name, input, raw_input.clone())
    {
        return action;
    }

    if matches!(
        normalized.as_str(),
        "bash"
            | "shell"
            | "terminal"
            | "command"
            | "runcommand"
            | "execute"
            | "exec"
            | "powershell"
            | "cmd"
    ) {
        let command = tool_command_from_input(input, tool_name);
        return ActionType::CommandRun {
            command: command.clone(),
            result: None,
            category: executors::logs::utils::shell_command_parsing::CommandCategory::from_command(
                &command,
            ),
        };
    }

    if matches!(
        normalized.as_str(),
        "read" | "readfile" | "fileread" | "view" | "openfile"
    ) {
        return ActionType::FileRead {
            path: tool_path_from_input(input).unwrap_or_default(),
        };
    }

    if matches!(
        normalized.as_str(),
        "write"
            | "writefile"
            | "edit"
            | "editfile"
            | "multiedit"
            | "applypatch"
            | "strreplaceeditor"
            | "createfile"
            | "delete"
            | "deletefile"
    ) {
        let path = tool_path_from_input(input).unwrap_or_default();
        let changes = if normalized.contains("delete") {
            vec![FileChange::Delete]
        } else if let Some(diff) =
            value_string(input, &["diff", "patch", "unified_diff", "unifiedDiff"])
        {
            vec![FileChange::Edit {
                unified_diff: diff.to_string(),
                has_line_numbers: true,
            }]
        } else if let Some(content) =
            value_string(input, &["content", "new_content", "newContent", "text"])
        {
            vec![FileChange::Write {
                content: content.to_string(),
            }]
        } else {
            vec![FileChange::Edit {
                unified_diff: raw_input
                    .as_ref()
                    .map(Value::to_string)
                    .unwrap_or_else(|| tool_name.to_string()),
                has_line_numbers: false,
            }]
        };
        return ActionType::FileEdit { path, changes };
    }

    if matches!(
        normalized.as_str(),
        "grep" | "search" | "rg" | "glob" | "find" | "list"
    ) {
        return ActionType::Search {
            query: value_string(input, &["query", "pattern", "regex", "path"])
                .unwrap_or(tool_name)
                .to_string(),
        };
    }

    if matches!(
        normalized.as_str(),
        "webfetch" | "fetch" | "websearch" | "urlfetch"
    ) {
        return ActionType::WebFetch {
            url: value_string(input, &["url", "href", "uri"])
                .unwrap_or_default()
                .to_string(),
        };
    }

    ActionType::Tool {
        tool_name: tool_name.to_string(),
        arguments: raw_input,
        result: None,
    }
}

pub(super) fn provider_tool_content(tool_name: &str, action_type: &ActionType) -> String {
    match action_type {
        ActionType::CommandRun { command, .. } => command.clone(),
        ActionType::FileRead { path } => path.clone(),
        ActionType::FileEdit { path, .. } => path.clone(),
        ActionType::Search { query } => query.clone(),
        ActionType::WebFetch { url } => url.clone(),
        ActionType::TaskCreate { description, .. } => description.clone(),
        ActionType::PlanPresentation { plan } => plan.clone(),
        ActionType::TodoManagement { operation, .. } => operation.clone(),
        ActionType::Tool { .. } | ActionType::Other { .. } => tool_name.to_string(),
    }
}

fn provider_tool_call_update(value: &Value, fallback_id: &str) -> Option<NativeToolUpdate> {
    let record = value.as_object()?;
    let block_type = value_string(record, &["type", "kind"]).unwrap_or_default();
    let block_type_normalized = block_type.to_ascii_lowercase();
    let tool_name = value_string(record, &["name", "tool_name", "toolName", "tool", "title"])
        .or_else(|| {
            record
                .get("function")
                .and_then(Value::as_object)
                .and_then(|function| value_string(function, &["name"]))
        })?;
    let is_tool_call = block_type_normalized.contains("tool")
        || block_type_normalized.contains("function")
        || block_type_normalized.contains("collab")
        || record.contains_key("input")
        || record.contains_key("arguments")
        || record.contains_key("receiverThreadIds")
        || record.contains_key("agentStatus");
    if !is_tool_call {
        return None;
    }

    let tool_name = normalize_tool_name(tool_name);
    let action_type = provider_tool_action(&tool_name, record);
    let output = tool_output_from_record(record);
    let result = output.clone().and_then(tool_result_from_text);
    Some(NativeToolUpdate {
        id: provider_tool_id(record, fallback_id),
        tool_name: Some(tool_name.clone()),
        status: provider_tool_status(value),
        content: output
            .clone()
            .or_else(|| Some(provider_tool_content(&tool_name, &action_type))),
        action_type: Some(action_type),
        command_output: None,
        result,
    })
}

fn provider_tool_result_update(value: &Value, fallback_id: &str) -> Option<NativeToolUpdate> {
    let record = value.as_object()?;
    let block_type = value_string(record, &["type", "kind"]).unwrap_or_default();
    if !(block_type.contains("tool_result")
        || block_type.contains("toolresult")
        || record.contains_key("tool_use_id")
        || record.contains_key("toolUseId")
        || record.contains_key("tool_call_id")
        || record.contains_key("toolCallId"))
    {
        return None;
    }

    let output = record
        .get("content")
        .or_else(|| record.get("output"))
        .or_else(|| record.get("result"))
        .or_else(|| record.get("text"))
        .and_then(stringify_tool_value);
    let failed = record
        .get("is_error")
        .or_else(|| record.get("isError"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    Some(NativeToolUpdate {
        id: provider_tool_id(record, fallback_id),
        tool_name: None,
        action_type: None,
        status: if failed {
            ToolStatus::Failed
        } else {
            ToolStatus::Success
        },
        content: None,
        command_output: output.clone(),
        result: output.and_then(tool_result_from_text),
    })
}

fn provider_opencode_tool_update(value: &Value, fallback_id: &str) -> Option<NativeToolUpdate> {
    let record = value.as_object()?;
    let block_type = value_string(record, &["type", "kind"]).unwrap_or_default();
    if block_type != "tool" && !block_type.contains("tool") {
        return None;
    }

    let state = record.get("state").and_then(Value::as_object);
    let tool_name = value_string(record, &["tool", "name", "tool_name", "toolName"])
        .or_else(|| state.and_then(|state| value_string(state, &["tool", "name"])))?;
    let tool_name = normalize_tool_name(tool_name);

    let mut merged = record.clone();
    if let Some(state) = state {
        for (key, value) in state {
            merged.entry(key.clone()).or_insert_with(|| value.clone());
        }
    }

    let action_type = provider_tool_action(&tool_name, &merged);
    let output = state
        .and_then(|state| {
            state
                .get("output")
                .or_else(|| state.get("result"))
                .or_else(|| state.get("error"))
        })
        .and_then(stringify_tool_value);
    let mut status = provider_tool_status(&Value::Object(merged.clone()));
    if output.is_some() && matches!(status, ToolStatus::Created) {
        status = ToolStatus::Success;
    }

    Some(NativeToolUpdate {
        id: provider_tool_id(record, fallback_id),
        tool_name: Some(tool_name.clone()),
        action_type: Some(action_type.clone()),
        status,
        content: Some(provider_tool_content(&tool_name, &action_type)),
        command_output: output.clone(),
        result: output.and_then(tool_result_from_text),
    })
}

fn provider_opencode_next_tool_update(
    value: &Value,
    fallback_id: &str,
) -> Option<NativeToolUpdate> {
    let record = value.as_object()?;
    let event_type = value_string(record, &["type"])?;
    if !event_type.starts_with("session.next.tool.") {
        return None;
    }

    let properties = record.get("properties").and_then(Value::as_object)?;
    let tool_name = value_string(properties, &["tool", "name"])?;
    let tool_name = normalize_tool_name(tool_name);
    let action_type = provider_tool_action(&tool_name, properties);
    let output = properties
        .get("content")
        .or_else(|| properties.get("structured"))
        .or_else(|| properties.get("error"))
        .and_then(stringify_tool_value);
    let status = if event_type.ends_with(".failed") {
        ToolStatus::Failed
    } else if event_type.ends_with(".success") {
        ToolStatus::Success
    } else {
        ToolStatus::Created
    };

    Some(NativeToolUpdate {
        id: provider_tool_id(properties, fallback_id),
        tool_name: Some(tool_name.clone()),
        action_type: Some(action_type.clone()),
        status,
        content: Some(provider_tool_content(&tool_name, &action_type)),
        command_output: output.clone(),
        result: output.and_then(tool_result_from_text),
    })
}

fn provider_opencode_shell_update(value: &Value, fallback_id: &str) -> Option<NativeToolUpdate> {
    let record = value.as_object()?;
    let event_type = value_string(record, &["type"])?;
    if !matches!(
        event_type,
        "session.next.shell.started" | "session.next.shell.ended"
    ) {
        return None;
    }

    let properties = record.get("properties").and_then(Value::as_object)?;
    let command = value_string(properties, &["command"])
        .unwrap_or("shell command")
        .to_string();
    let output = value_string(properties, &["output"]).map(ToString::to_string);
    let status = if event_type.ends_with(".ended") {
        ToolStatus::Success
    } else {
        ToolStatus::Created
    };

    Some(NativeToolUpdate {
        id: provider_tool_id(properties, fallback_id),
        tool_name: Some("shell_command".to_string()),
        action_type: Some(ActionType::CommandRun {
            command: command.clone(),
            result: output.as_ref().map(|output| CommandRunResult {
                exit_status: Some(CommandExitStatus::Success { success: true }),
                output: Some(output.clone()),
            }),
            category: executors::logs::utils::shell_command_parsing::CommandCategory::from_command(
                &command,
            ),
        }),
        status,
        content: Some(command),
        command_output: output,
        result: None,
    })
}

fn provider_codex_command_execution_update(
    value: &Value,
    fallback_id: &str,
) -> Option<NativeToolUpdate> {
    let record = value.as_object()?;
    let method = value_string(record, &["method"]).unwrap_or_default();
    if !matches!(method, "item/started" | "item/completed") {
        return None;
    }
    let params = record.get("params").and_then(Value::as_object)?;
    let item = params.get("item").and_then(Value::as_object)?;
    if value_string(item, &["type"]) != Some("commandExecution") {
        return None;
    }

    let command = value_string(item, &["command", "cmd", "script"])
        .or_else(|| {
            item.get("commandActions")
                .and_then(Value::as_array)
                .and_then(|actions| actions.first())
                .and_then(Value::as_object)
                .and_then(|action| value_string(action, &["command"]))
        })
        .unwrap_or("terminal command")
        .to_string();
    let output = item
        .get("aggregatedOutput")
        .or_else(|| item.get("output"))
        .and_then(stringify_tool_value);
    let status = provider_tool_status(&Value::Object(item.clone()));

    Some(NativeToolUpdate {
        id: value_string(item, &["id"])
            .or_else(|| value_string(params, &["itemId", "item_id"]))
            .unwrap_or(fallback_id)
            .to_string(),
        tool_name: Some("shell_command".to_string()),
        action_type: Some(ActionType::CommandRun {
            command: command.clone(),
            result: output.as_ref().map(|output| CommandRunResult {
                exit_status: Some(CommandExitStatus::Success {
                    success: !matches!(status, ToolStatus::Failed),
                }),
                output: Some(output.clone()),
            }),
            category: executors::logs::utils::shell_command_parsing::CommandCategory::from_command(
                &command,
            ),
        }),
        status,
        content: Some(command),
        command_output: output.clone(),
        result: output.and_then(tool_result_from_text),
    })
}

fn provider_codex_command_output_update(value: &Value) -> Option<NativeToolUpdate> {
    let record = value.as_object()?;
    let method = value_string(record, &["method"])?;
    if !matches!(
        method,
        "item/command/output"
            | "item/commandExecution/outputDelta"
            | "command/exec/outputDelta"
            | "process/outputDelta"
    ) {
        return None;
    }
    let params = record.get("params").and_then(Value::as_object)?;
    let output = codex_command_output_text(params);
    let command = value_string(params, &["command", "cmd", "script"])
        .unwrap_or("terminal output")
        .to_string();
    let status = provider_tool_status(record.get("params").unwrap_or(value));
    let status = if method.ends_with("outputDelta") {
        status
    } else if matches!(status, ToolStatus::Created) {
        ToolStatus::Success
    } else {
        status
    };
    let fallback_id = codex_command_stream_id(method, params).unwrap_or("codex-command-output");
    Some(NativeToolUpdate {
        id: provider_tool_id(params, fallback_id),
        tool_name: Some("shell_command".to_string()),
        action_type: Some(ActionType::CommandRun {
            command: command.clone(),
            result: Some(CommandRunResult {
                exit_status: None,
                output: Some(output.clone()),
            }),
            category: executors::logs::utils::shell_command_parsing::CommandCategory::from_command(
                &command,
            ),
        }),
        status,
        content: Some(command),
        command_output: Some(output),
        result: None,
    })
}

fn codex_command_stream_id<'a>(
    method: &str,
    params: &'a serde_json::Map<String, Value>,
) -> Option<&'a str> {
    match method {
        "command/exec/outputDelta" => value_string(params, &["processId", "process_id"]),
        "process/outputDelta" => value_string(params, &["processHandle", "process_handle"]),
        _ => None,
    }
}

fn codex_command_output_text(params: &serde_json::Map<String, Value>) -> String {
    params
        .get("output")
        .or_else(|| params.get("delta"))
        .or_else(|| params.get("text"))
        .and_then(stringify_tool_value)
        .or_else(|| {
            value_string(params, &["deltaBase64", "delta_base64"]).and_then(decode_base64_text)
        })
        .unwrap_or_default()
}

fn decode_base64_text(encoded: &str) -> Option<String> {
    let bytes = BASE64_STANDARD.decode(encoded.as_bytes()).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn codex_file_change_status(value: Option<&Value>) -> ToolStatus {
    let status = value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    match status.as_str() {
        "completed" => ToolStatus::Success,
        "failed" | "declined" => ToolStatus::Failed,
        _ => ToolStatus::Created,
    }
}

fn codex_file_change_from_patch(change: &serde_json::Map<String, Value>) -> Option<FileChange> {
    let kind = change.get("kind").and_then(Value::as_object)?;
    let kind_type = value_string(kind, &["type"])?;
    match kind_type {
        "delete" => Some(FileChange::Delete),
        "update" => {
            if let Some(move_path) = value_string(kind, &["move_path", "movePath"])
                && !move_path.trim().is_empty()
            {
                return Some(FileChange::Rename {
                    new_path: move_path.to_string(),
                });
            }
            Some(FileChange::Edit {
                unified_diff: value_string(change, &["diff", "unified_diff", "unifiedDiff"])
                    .unwrap_or_default()
                    .to_string(),
                has_line_numbers: true,
            })
        }
        "add" => Some(FileChange::Edit {
            unified_diff: value_string(change, &["diff", "unified_diff", "unifiedDiff"])
                .unwrap_or_default()
                .to_string(),
            has_line_numbers: true,
        }),
        _ => None,
    }
}

fn provider_codex_file_change_updates(value: &Value, fallback_id: &str) -> Vec<NativeToolUpdate> {
    let Some(record) = value.as_object() else {
        return Vec::new();
    };

    let method = value_string(record, &["method"]).unwrap_or_default();
    let (item_id, status, changes) = if method == "item/fileChange/patchUpdated" {
        let Some(params) = record.get("params").and_then(Value::as_object) else {
            return Vec::new();
        };
        (
            value_string(params, &["itemId", "item_id"]).unwrap_or(fallback_id),
            None,
            params.get("changes").and_then(Value::as_array),
        )
    } else {
        let item = if value_string(record, &["type"]) == Some("fileChange") {
            Some(record)
        } else if matches!(method, "item/started" | "item/completed") {
            record
                .get("params")
                .and_then(Value::as_object)
                .and_then(|params| params.get("item"))
                .and_then(Value::as_object)
                .filter(|item| value_string(item, &["type"]) == Some("fileChange"))
        } else {
            None
        };
        let Some(item) = item else {
            return Vec::new();
        };
        (
            value_string(item, &["id"]).unwrap_or(fallback_id),
            item.get("status"),
            item.get("changes").and_then(Value::as_array),
        )
    };

    let status = codex_file_change_status(status);
    changes
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(index, change)| {
            let change = change.as_object()?;
            let path = value_string(change, &["path"])?.to_string();
            let file_change = codex_file_change_from_patch(change)?;
            Some(NativeToolUpdate {
                id: format!("{item_id}:{path}:{index}"),
                tool_name: Some("file_change".to_string()),
                action_type: Some(ActionType::FileEdit {
                    path: path.clone(),
                    changes: vec![file_change],
                }),
                status: status.clone(),
                content: Some(path),
                command_output: None,
                result: None,
            })
        })
        .collect()
}

fn opencode_file_change_from_diff(change: &serde_json::Map<String, Value>) -> Option<FileChange> {
    if let Some(patch) = value_string(change, &["patch", "diff", "unified_diff", "unifiedDiff"]) {
        return Some(FileChange::Edit {
            unified_diff: patch.to_string(),
            has_line_numbers: true,
        });
    }

    let status = value_string(change, &["status"])
        .unwrap_or_default()
        .to_ascii_lowercase();
    if status == "deleted" {
        return Some(FileChange::Delete);
    }

    let before = value_string(change, &["before"]).unwrap_or_default();
    let after = value_string(change, &["after"]).unwrap_or_default();
    if !before.is_empty() || !after.is_empty() {
        return Some(FileChange::Edit {
            unified_diff: format!("@@\n-{}\n+{}", before, after),
            has_line_numbers: false,
        });
    }

    Some(FileChange::Edit {
        unified_diff: String::new(),
        has_line_numbers: false,
    })
}

fn provider_opencode_file_edited_update(
    value: &Value,
    _fallback_id: &str,
) -> Option<NativeToolUpdate> {
    let record = value.as_object()?;
    if value_string(record, &["type"]) != Some("file.edited") {
        return None;
    }
    let properties = record.get("properties").and_then(Value::as_object)?;
    let path = value_string(properties, &["file", "path"])?.to_string();

    Some(NativeToolUpdate {
        id: format!("opencode-file:{path}"),
        tool_name: Some("file_change".to_string()),
        action_type: Some(ActionType::FileEdit {
            path: path.clone(),
            changes: vec![FileChange::Edit {
                unified_diff: String::new(),
                has_line_numbers: false,
            }],
        }),
        status: ToolStatus::Success,
        content: Some(path),
        command_output: None,
        result: None,
    })
}

fn provider_opencode_diff_updates(value: &Value, fallback_id: &str) -> Vec<NativeToolUpdate> {
    let Some(record) = value.as_object() else {
        return Vec::new();
    };
    let event_type = value_string(record, &["type"]).unwrap_or_default();
    let diffs = if event_type == "session.diff" {
        record
            .get("properties")
            .and_then(|properties| properties.get("diff"))
            .and_then(Value::as_array)
    } else {
        record
            .get("diff")
            .or_else(|| record.get("diffs"))
            .or_else(|| {
                record
                    .get("summary")
                    .and_then(|summary| summary.get("diffs"))
            })
            .and_then(Value::as_array)
    };

    diffs
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(index, change)| {
            let change = change.as_object()?;
            let path = value_string(change, &["file", "path"])?.to_string();
            let file_change = opencode_file_change_from_diff(change)?;
            Some(NativeToolUpdate {
                id: if path.is_empty() {
                    format!("{fallback_id}:opencode-diff:{index}")
                } else {
                    format!("opencode-file:{path}")
                },
                tool_name: Some("file_change".to_string()),
                action_type: Some(ActionType::FileEdit {
                    path: path.clone(),
                    changes: vec![file_change],
                }),
                status: ToolStatus::Success,
                content: Some(path),
                command_output: None,
                result: None,
            })
        })
        .collect()
}

fn collect_provider_tool_updates(
    value: &Value,
    fallback_id: &str,
    updates: &mut Vec<NativeToolUpdate>,
) {
    let file_change_updates = provider_codex_file_change_updates(value, fallback_id);
    if !file_change_updates.is_empty() {
        updates.extend(file_change_updates);
        return;
    }

    let opencode_diff_updates = provider_opencode_diff_updates(value, fallback_id);
    if !opencode_diff_updates.is_empty() {
        updates.extend(opencode_diff_updates);
        return;
    }

    if let Some(update) = provider_opencode_file_edited_update(value, fallback_id) {
        updates.push(update);
        return;
    }

    if let Some(update) = provider_opencode_next_tool_update(value, fallback_id) {
        updates.push(update);
        return;
    }

    if let Some(update) = provider_opencode_shell_update(value, fallback_id) {
        updates.push(update);
        return;
    }

    if let Some(update) = provider_codex_command_execution_update(value, fallback_id) {
        updates.push(update);
        return;
    }

    if let Some(update) = provider_codex_command_output_update(value) {
        updates.push(update);
        return;
    }

    if let Some(update) = provider_tool_result_update(value, fallback_id) {
        updates.push(update);
        return;
    }
    if let Some(update) = provider_opencode_tool_update(value, fallback_id) {
        updates.push(update);
        return;
    }
    if let Some(update) = provider_tool_call_update(value, fallback_id) {
        updates.push(update);
        return;
    }

    let Some(record) = value.as_object() else {
        return;
    };

    for key in [
        "event",
        "response",
        "message",
        "part",
        "item",
        "properties",
        "payload",
        "data",
        "params",
        "info",
        "summary",
        "snapshot",
    ] {
        if let Some(child) = record.get(key) {
            collect_provider_tool_updates(child, fallback_id, updates);
        }
    }

    for key in ["content", "parts", "items"] {
        if let Some(items) = record.get(key).and_then(Value::as_array) {
            for (index, item) in items.iter().enumerate() {
                collect_provider_tool_updates(item, &format!("{fallback_id}:{index}"), updates);
            }
        }
    }
}

pub(super) fn extract_provider_tool_updates(value: &Value) -> Vec<NativeToolUpdate> {
    let fallback_id = value
        .as_object()
        .map(|record| provider_tool_id(record, "provider-tool"))
        .unwrap_or_else(|| "provider-tool".to_string());
    let mut updates = Vec::new();
    collect_provider_tool_updates(value, &fallback_id, &mut updates);
    updates
}

pub(super) fn merge_tool_result(action_type: &mut ActionType, update: &NativeToolUpdate) {
    match action_type {
        ActionType::CommandRun {
            result, command, ..
        } => {
            if update.command_output.is_some()
                || matches!(update.status, ToolStatus::Failed | ToolStatus::Success)
            {
                let output = match (
                    result.as_ref().and_then(|result| result.output.as_ref()),
                    update.command_output.as_ref(),
                ) {
                    (Some(existing), Some(next)) if existing == next => Some(existing.clone()),
                    (Some(existing), Some(next)) if !next.is_empty() => {
                        Some(format!("{existing}{next}"))
                    }
                    (Some(existing), _) => Some(existing.clone()),
                    (None, Some(next)) => Some(next.clone()),
                    (None, None) => None,
                };
                *result = Some(CommandRunResult {
                    exit_status: Some(CommandExitStatus::Success {
                        success: !matches!(update.status, ToolStatus::Failed),
                    }),
                    output,
                });
            }
            if command.trim().is_empty()
                && let Some(content) = update.content.as_ref()
            {
                *command = content.clone();
            }
        }
        ActionType::Tool { result, .. } | ActionType::TaskCreate { result, .. } => {
            if update.result.is_some() {
                *result = update.result.clone();
            }
        }
        _ => {}
    }
}
