use agent_client_protocol::schema::{ContentBlock, EmbeddedResourceResource, Plan};

pub(super) fn format_plan_markdown(plan: &Plan) -> String {
    plan.entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let status = serde_json::to_value(&entry.status)
                .ok()
                .and_then(|value| value.as_str().map(ToOwned::to_owned))
                .unwrap_or_else(|| "unknown".to_string());
            let priority = serde_json::to_value(&entry.priority)
                .ok()
                .and_then(|value| value.as_str().map(ToOwned::to_owned))
                .unwrap_or_else(|| "normal".to_string());

            format!(
                "{}. [{} | {}] {}",
                index + 1,
                status,
                priority,
                entry.content.trim()
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) fn content_block_to_markdown(content: &ContentBlock) -> Option<String> {
    match content {
        ContentBlock::Text(text) => Some(text.text.clone()),
        ContentBlock::Image(image) => {
            let src = image
                .uri
                .as_deref()
                .filter(|uri| !uri.trim().is_empty())
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| format!("data:{};base64,{}", image.mime_type, image.data));
            Some(format!("![Image]({})", markdown_url(&src)))
        }
        ContentBlock::ResourceLink(link) => {
            let label = markdown_label(
                link.title
                    .as_deref()
                    .or(Some(link.name.as_str()))
                    .unwrap_or("Resource"),
            );
            if link
                .mime_type
                .as_deref()
                .is_some_and(|mime| mime.starts_with("image/"))
                || looks_like_image_uri(&link.uri)
            {
                Some(format!("![{}]({})", label, markdown_url(&link.uri)))
            } else {
                Some(format!("[{}]({})", label, markdown_url(&link.uri)))
            }
        }
        ContentBlock::Resource(resource) => match &resource.resource {
            EmbeddedResourceResource::TextResourceContents(text) => Some(text.text.clone()),
            EmbeddedResourceResource::BlobResourceContents(blob) => {
                let mime_type = blob
                    .mime_type
                    .as_deref()
                    .unwrap_or("application/octet-stream");
                if mime_type.starts_with("image/") {
                    Some(format!(
                        "![{}](data:{};base64,{})",
                        markdown_label(&blob.uri),
                        mime_type,
                        blob.blob
                    ))
                } else {
                    Some(format!(
                        "[{}]({})",
                        markdown_label(&blob.uri),
                        markdown_url(&blob.uri)
                    ))
                }
            }
            _ => None,
        },
        ContentBlock::Audio(audio) => Some(format!(
            "[Audio: {}](data:{};base64,{})",
            markdown_label(&audio.mime_type),
            audio.mime_type,
            audio.data
        )),
        _ => None,
    }
}

fn markdown_label(label: &str) -> String {
    label.replace('[', "\\[").replace(']', "\\]")
}

fn markdown_url(url: &str) -> String {
    if url.starts_with("data:") || (!url.contains(char::is_whitespace) && !url.contains(')')) {
        url.to_string()
    } else {
        format!("<{}>", url.replace('>', "%3E"))
    }
}

fn looks_like_image_uri(uri: &str) -> bool {
    let lower = uri
        .split(['?', '#'])
        .next()
        .unwrap_or(uri)
        .to_ascii_lowercase();
    matches!(
        lower.rsplit('.').next(),
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "avif")
    )
}
