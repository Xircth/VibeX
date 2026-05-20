fn json_u32(value: Option<&Value>) -> Option<u32> {
    value
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
}

fn token_usage_info(
    total_tokens: Option<u32>,
    context_window: Option<u32>,
) -> Option<TokenUsageInfo> {
    let total_tokens = total_tokens?;
    let model_context_window = context_window?;
    if model_context_window == 0 {
        return None;
    }
    Some(TokenUsageInfo {
        total_tokens,
        model_context_window,
    })
}

fn context_compacted_token_usage_info(
    value: &Value,
    context_window: Option<u32>,
) -> Option<TokenUsageInfo> {
    if value.get("method").and_then(Value::as_str) != Some("thread/compacted") {
        return None;
    }

    token_usage_info(Some(0), context_window)
}

fn sum_u32(values: impl IntoIterator<Item = Option<u32>>) -> Option<u32> {
    let mut total = 0u32;
    let mut has_value = false;
    for value in values.into_iter().flatten() {
        total = total.saturating_add(value);
        has_value = true;
    }
    has_value.then_some(total)
}

fn extract_codex_token_usage_info(
    value: &Value,
    context_window_override: Option<u32>,
) -> Option<TokenUsageInfo> {
    if value.get("method").and_then(Value::as_str) != Some("thread/tokenUsage/updated") {
        return None;
    }
    let usage = value.get("params")?.get("tokenUsage")?;
    token_usage_info(
        json_u32(
            usage
                .get("total")
                .and_then(|total| total.get("totalTokens")),
        ),
        context_window_override.or_else(|| json_u32(usage.get("modelContextWindow"))),
    )
}

fn extract_claude_token_usage_info(value: &Value) -> Option<TokenUsageInfo> {
    if value.get("type").and_then(Value::as_str) == Some("sdk_context_usage") {
        let usage = value.get("contextUsage")?;
        return token_usage_info(
            json_u32(usage.get("totalTokens")),
            json_u32(usage.get("maxTokens")).or_else(|| json_u32(usage.get("rawMaxTokens"))),
        );
    }

    if value.get("type").and_then(Value::as_str) != Some("result") {
        return None;
    }
    let usage = value.get("usage")?;
    let total_tokens = json_u32(usage.get("total_tokens")).or_else(|| {
        sum_u32([
            json_u32(usage.get("input_tokens")),
            json_u32(usage.get("output_tokens")),
            json_u32(usage.get("cache_creation_input_tokens")),
            json_u32(usage.get("cache_read_input_tokens")),
        ])
    });
    let context_window = value
        .get("modelUsage")
        .and_then(Value::as_object)
        .and_then(|models| {
            models
                .values()
                .filter_map(|model| json_u32(model.get("contextWindow")))
                .max()
        });

    token_usage_info(total_tokens, context_window)
}

fn extract_opencode_token_usage_info(value: &Value) -> Option<TokenUsageInfo> {
    let tokens = value.get("tokens")?;
    let total_tokens = sum_u32([
        json_u32(tokens.get("input")),
        json_u32(tokens.get("output")),
        json_u32(tokens.get("reasoning")),
        json_u32(tokens.get("cache").and_then(|cache| cache.get("read"))),
        json_u32(tokens.get("cache").and_then(|cache| cache.get("write"))),
    ]);
    let context_window = json_u32(
        value
            .get("model")
            .and_then(|model| model.get("limit"))
            .and_then(|limit| limit.get("context")),
    )
    .or_else(|| json_u32(value.get("limit").and_then(|limit| limit.get("context"))))
    .or_else(|| json_u32(value.get("modelContextWindow")));

    token_usage_info(total_tokens, context_window)
}

#[cfg(test)]
fn extract_provider_token_usage_info(value: &Value) -> Option<TokenUsageInfo> {
    extract_provider_token_usage_info_with_codex_context_window(value, None)
}

fn extract_provider_token_usage_info_with_codex_context_window(
    value: &Value,
    codex_context_window: Option<u32>,
) -> Option<TokenUsageInfo> {
    extract_codex_token_usage_info(value, codex_context_window)
        .or_else(|| context_compacted_token_usage_info(value, codex_context_window))
        .or_else(|| extract_claude_token_usage_info(value))
        .or_else(|| extract_opencode_token_usage_info(value))
        .or_else(|| {
            value.get("event").and_then(|event| {
                extract_provider_token_usage_info_with_codex_context_window(
                    event,
                    codex_context_window,
                )
            })
        })
        .or_else(|| {
            value.get("response").and_then(|response| {
                extract_provider_token_usage_info_with_codex_context_window(
                    response,
                    codex_context_window,
                )
            })
        })
}

fn extract_provider_error(value: &Value) -> Option<String> {
    let record = value.as_object()?;
    let event_type = record
        .get("type")
        .or_else(|| record.get("method"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let looks_like_error = event_type.contains("error") || event_type.contains("stderr");
    if !looks_like_error {
        return None;
    }

    record
        .get("message")
        .or_else(|| record.get("error"))
        .or_else(|| {
            record
                .get("params")
                .and_then(|params| params.get("message"))
        })
        .or_else(|| record.get("params").and_then(|params| params.get("error")))
        .and_then(extract_provider_diagnostic_text)
        .or_else(|| Some(value.to_string()))
}

