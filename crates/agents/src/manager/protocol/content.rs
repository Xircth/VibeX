use super::*;

pub(in crate::manager) const MAX_TOOL_PREVIEW_IMAGES: usize = 4;

pub(in crate::manager) fn truncate_preview(value: String) -> String {
    crate::conversation::cap_preview_bytes(value)
}

pub(in crate::manager) fn json_preview(value: Option<&serde_json::Value>) -> Option<String> {
    value.and_then(|value| serde_json::to_string(value).ok().map(truncate_preview))
}

pub(in crate::manager) fn acp_tool_input_preview(
    raw_input: Option<&serde_json::Value>,
    content: &[ToolCallContent],
    locations: &[ToolCallLocation],
) -> Option<String> {
    if let Some(raw_input) = raw_input {
        return serde_json::to_string(raw_input).ok().map(truncate_preview);
    }

    for item in content {
        if let ToolCallContent::Diff(diff) = item {
            return serde_json::to_string(&serde_json::json!({
                "file_path": diff.path,
                "oldText": diff.old_text,
                "newText": diff.new_text,
            }))
            .ok()
            .map(truncate_preview);
        }
    }

    locations.first().and_then(|location| {
        serde_json::to_string(&serde_json::json!({
            "path": location.path,
            "line": location.line,
        }))
        .ok()
        .map(truncate_preview)
    })
}

pub(in crate::manager) fn acp_tool_images(content: &[ToolCallContent]) -> Vec<crate::conversation::ImageData> {
    content
        .iter()
        .filter_map(|item| match item {
            ToolCallContent::Content(content) => match &content.content {
                ContentBlock::Image(image) => Some(crate::conversation::ImageData {
                    data: image.data.clone(),
                    mime_type: image.mime_type.clone(),
                    uri: image.uri.clone(),
                    width: None,
                    height: None,
                }),
                _ => None,
            },
            _ => None,
        })
        .take(MAX_TOOL_PREVIEW_IMAGES)
        .collect()
}

pub(in crate::manager) fn acp_tool_content_preview(content: &[ToolCallContent]) -> Option<String> {
    let visible = content
        .iter()
        .filter(|item| {
            !matches!(
                item,
                ToolCallContent::Content(content)
                    if matches!(&content.content, ContentBlock::Image(_))
            )
        })
        .collect::<Vec<_>>();
    (!visible.is_empty())
        .then(|| serde_json::to_string(&visible).ok().map(truncate_preview))
        .flatten()
}


pub(in crate::manager) fn agent_block_to_acp(block: AgentContentBlock) -> ContentBlock {
    match block {
        AgentContentBlock::Text { text } => ContentBlock::Text(TextContent::new(text)),
        AgentContentBlock::Image {
            data,
            mime_type,
            uri,
        } => ContentBlock::Image(ImageContent::new(data, mime_type).uri(uri)),
        AgentContentBlock::Resource { uri, title } => {
            let name = title
                .clone()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| {
                    uri.rsplit(['/', '\\'])
                        .find(|segment| !segment.is_empty())
                        .unwrap_or(uri.as_str())
                        .to_string()
                });
            ContentBlock::ResourceLink(ResourceLink::new(name, uri).title(title))
        }
        AgentContentBlock::Protocol { content } => {
            serde_json::from_value(content).unwrap_or_else(|error| {
                ContentBlock::Text(TextContent::new(format!(
                    "Unsupported ACP content block: {error}"
                )))
            })
        }
    }
}

pub(in crate::manager) fn acp_content_preview(block: &ContentBlock) -> String {
    match acp_content_to_agent(block.clone()) {
        AgentContentBlock::Text { text } => text.chars().take(200).collect(),
        AgentContentBlock::Image { mime_type, .. } => format!("image/{mime_type}"),
        AgentContentBlock::Resource { uri, .. } => uri,
        AgentContentBlock::Protocol { content } => content
            .get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("content")
            .to_string(),
    }
}

pub(in crate::manager) fn bounded_ext_notification(method: &str, params: &serde_json::Value) -> serde_json::Value {
    let mut payload = serde_json::json!({
        "kind": "ext_notification",
        "method": method,
        "params": params,
    });
    bound_meta_fields(&mut payload);
    payload
}

pub(in crate::manager) fn acp_content_to_agent(block: ContentBlock) -> AgentContentBlock {
    match block {
        ContentBlock::Text(text) if text.meta.is_none() => {
            AgentContentBlock::Text { text: text.text }
        }
        ContentBlock::Image(image) if image.meta.is_none() => AgentContentBlock::Image {
            data: image.data,
            mime_type: image.mime_type,
            uri: image.uri,
        },
        #[allow(unreachable_patterns)]
        other => AgentContentBlock::Protocol {
            content: bounded_acp_content_value(other),
        },
    }
}

pub(in crate::manager) fn bounded_acp_content_value(block: impl Serialize) -> serde_json::Value {
    let mut value = serde_json::to_value(block).unwrap_or(serde_json::Value::Null);
    bound_meta_fields(&mut value);
    value
}

pub(in crate::manager) fn session_info_patch_from_acp(
    update: agent_client_protocol::schema::v1::SessionInfoUpdate,
) -> serde_json::Value {
    let mut value = serde_json::to_value(update).unwrap_or(serde_json::Value::Null);
    bound_meta_fields(&mut value);
    value
}

pub(in crate::manager) fn acp_meta_session_title(
    meta: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Option<String> {
    let meta = meta?;
    [
        "title",
        "generated_title",
        "sessionTitle",
        "customTitle",
        "session_summary",
    ]
    .into_iter()
    .find_map(|key| {
        meta.get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    })
}

pub(in crate::manager) fn bounded_optional_meta(meta: Option<impl Serialize>) -> Option<serde_json::Value> {
    meta.and_then(|meta| serde_json::to_value(meta).ok())
        .filter(|meta| {
            serde_json::to_vec(meta).is_ok_and(|encoded| encoded.len() <= MAX_CONTENT_META_BYTES)
        })
}

pub(in crate::manager) fn bound_meta_fields(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(object) => {
            if object.get("_meta").is_some_and(|meta| {
                serde_json::to_vec(meta)
                    .map(|encoded| encoded.len() > MAX_CONTENT_META_BYTES)
                    .unwrap_or(true)
            }) {
                object.remove("_meta");
            }
            for child in object.values_mut() {
                bound_meta_fields(child);
            }
        }
        serde_json::Value::Array(values) => {
            for child in values {
                bound_meta_fields(child);
            }
        }
        _ => {}
    }
}

pub(in crate::manager) fn acp_enum_label<T>(value: &T) -> String
where
    T: Serialize + std::fmt::Debug,
{
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| format!("{value:?}"))
}

pub(in crate::manager) fn meta_u64(
    meta: Option<&serde_json::Map<String, serde_json::Value>>,
    keys: &[&str],
) -> Option<u64> {
    let meta = meta?;
    keys.iter().find_map(|key| {
        meta.get(*key).and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_i64().and_then(|n| u64::try_from(n).ok()))
                .or_else(|| value.as_f64().and_then(|n| (n >= 0.0).then_some(n as u64)))
        })
    })
}

pub(in crate::manager) fn plan_entry_status_name(status: agent_client_protocol::schema::v1::PlanEntryStatus) -> String {
    match status {
        agent_client_protocol::schema::v1::PlanEntryStatus::Pending => "pending".into(),
        agent_client_protocol::schema::v1::PlanEntryStatus::InProgress => "in_progress".into(),
        agent_client_protocol::schema::v1::PlanEntryStatus::Completed => "completed".into(),
        _ => "pending".into(),
    }
}

pub(in crate::manager) fn plan_entry_priority_name(
    priority: agent_client_protocol::schema::v1::PlanEntryPriority,
) -> String {
    match priority {
        agent_client_protocol::schema::v1::PlanEntryPriority::High => "high".into(),
        agent_client_protocol::schema::v1::PlanEntryPriority::Medium => "medium".into(),
        agent_client_protocol::schema::v1::PlanEntryPriority::Low => "low".into(),
        _ => "medium".into(),
    }
}

