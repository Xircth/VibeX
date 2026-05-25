use agent_client_protocol::schema::{ToolCallContent, ToolCallId};

use crate::logs::{ActionType, ToolResult, ToolResultValueType};

pub(super) struct TaskToolCallView<'a> {
    pub id: &'a ToolCallId,
    pub title: &'a str,
    pub content: &'a [ToolCallContent],
    pub raw_input: Option<&'a serde_json::Value>,
    pub raw_output: Option<&'a serde_json::Value>,
}

pub(super) fn heuristically_extract_task_create(tc: TaskToolCallView<'_>) -> Option<ActionType> {
    let parsed_title_json = tc
        .title
        .trim_start()
        .starts_with('{')
        .then(|| serde_json::from_str::<serde_json::Value>(tc.title).ok())
        .flatten();
    let arguments = tc.raw_input.or(parsed_title_json.as_ref());
    let tool_name =
        extract_task_tool_name(tc.id.0.as_ref()).unwrap_or_else(|| tc.title.trim().to_string());

    let has_task_signal = is_task_like_name(&tool_name)
        || is_task_like_name(tc.title)
        || extract_string_argument(
            arguments,
            &[
                "description",
                "prompt",
                "task",
                "subagent_type",
                "agent_type",
            ],
        )
        .is_some();

    if !has_task_signal {
        return None;
    }

    let description = extract_string_argument(
        arguments,
        &[
            "description",
            "prompt",
            "task",
            "title",
            "summary",
            "message",
            "instruction",
        ],
    )
    .or_else(|| extract_task_description_from_title(tc.title, &tool_name))
    .or_else(|| collect_text_content_blocks(tc.content))
    .filter(|text| !text.trim().is_empty())
    .unwrap_or_else(|| tool_name.clone());

    let subagent_type = extract_string_argument(
        arguments,
        &["subagent_type", "agent_type", "agent", "kind", "role"],
    );

    Some(ActionType::TaskCreate {
        description: description.trim().trim_matches('`').to_string(),
        subagent_type,
        result: collect_tool_result(tc),
    })
}

fn collect_tool_result(tc: TaskToolCallView<'_>) -> Option<ToolResult> {
    if let Some(output) = tc.raw_output {
        Some(ToolResult {
            r#type: ToolResultValueType::Json,
            value: output.clone(),
        })
    } else {
        collect_text_content_blocks(tc.content).map(|text| ToolResult {
            r#type: ToolResultValueType::Markdown,
            value: serde_json::Value::String(text),
        })
    }
}

fn collect_text_content_blocks(content: &[ToolCallContent]) -> Option<String> {
    let mut out = String::new();
    for item in content {
        if let ToolCallContent::Content(inner) = item
            && let agent_client_protocol::schema::ContentBlock::Text(text) = &inner.content
        {
            out.push_str(&text.text);
            if !out.ends_with('\n') {
                out.push('\n');
            }
        }
    }
    if out.trim().is_empty() {
        None
    } else {
        Some(out.trim().to_string())
    }
}

fn extract_task_description_from_title(title: &str, tool_name: &str) -> Option<String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return None;
    }

    let normalized_tool_name = normalize_task_name(tool_name);
    let normalized_title = normalize_task_name(trimmed);
    if normalized_title == normalized_tool_name {
        return None;
    }

    for separator in [":", "-", "=>"] {
        if let Some((prefix, rest)) = trimmed.split_once(separator)
            && normalize_task_name(prefix) == normalized_tool_name
            && !rest.trim().is_empty()
        {
            return Some(rest.trim().to_string());
        }
    }

    Some(trimmed.to_string())
}

fn extract_string_argument(value: Option<&serde_json::Value>, keys: &[&str]) -> Option<String> {
    let value = value?;
    if let Some(text) = value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        return Some(text.to_string());
    }

    let object = value.as_object()?;
    keys.iter().find_map(|key| {
        object.get(*key).and_then(|candidate| {
            candidate
                .as_str()
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(ToOwned::to_owned)
        })
    })
}

fn extract_task_tool_name(id: &str) -> Option<String> {
    if let Some(idx) = id.rfind('-') {
        let (head, tail) = id.split_at(idx);
        if tail
            .trim_start_matches('-')
            .chars()
            .all(|c| c.is_ascii_digit())
        {
            return Some(head.to_string());
        }
    }
    None
}

fn normalize_task_name(name: &str) -> String {
    name.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect()
}

fn is_task_like_name(name: &str) -> bool {
    let normalized = normalize_task_name(name);
    [
        "task",
        "task_create",
        "create_task",
        "subagent",
        "sub_agent",
        "create_subagent",
        "spawn_agent",
        "spawn",
        "delegate",
        "multi_agent",
        "muti_agent",
    ]
    .iter()
    .any(|candidate| {
        normalized == *candidate
            || normalized.starts_with(&format!("{candidate}_"))
            || normalized.ends_with(&format!("_{candidate}"))
            || normalized.contains(&format!("_{candidate}_"))
    })
}
