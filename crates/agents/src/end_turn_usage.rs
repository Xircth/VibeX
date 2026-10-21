//! End-turn token spend from ACP `PromptUsage` / `turn_completed.usage`.
//!
//! Grok (and some other agents) do not emit ACP `usage_update` with a token
//! breakdown. They attach per-prompt spend to `sessionUpdate: "turn_completed"`
//! as camelCase `PromptUsage`. Occupancy (`_meta.totalTokens`) is a different
//! quantity and is never treated as input tokens (ADR-0058).
//!
//! Bucket convention matches CodeG's Grok parser: ACP `inputTokens` includes
//! cached slices, `TurnUsage` / `AgentUsage` is Anthropic-disjoint (uncached
//! input + cache buckets re-sum to the vendor total).

use serde_json::Value;

use crate::events::{AgentSessionConfigOption, AgentUsage};

/// Per-prompt spend from a `usage` object, or `None` when every counter is
/// missing or zero.
pub fn prompt_usage_from_value(usage: &Value) -> Option<AgentUsage> {
    if usage.get("inputTokens").is_some() || usage.get("outputTokens").is_some() {
        return acp_prompt_usage(usage);
    }
    disjoint_usage(usage)
}

/// `sessionUpdate: "turn_completed"` (or the wrapping notification params).
pub fn usage_from_session_update(update: &Value) -> Option<AgentUsage> {
    let session_update = update
        .get("sessionUpdate")
        .or_else(|| update.get("session_update"))
        .and_then(Value::as_str)?;
    if session_update != "turn_completed" {
        return None;
    }
    let mut usage = update.get("usage").and_then(prompt_usage_from_value)?;
    if usage.model.is_none() {
        usage.model = model_id_from_meta(update.get("_meta"));
    }
    Some(usage)
}

/// Grok sometimes fails the prompt RPC with `promptUsage` in the error data
/// instead of a normal `turn_completed` usage payload.
pub fn usage_from_error_data(data: Option<&Value>) -> Option<AgentUsage> {
    let data = data?;
    data.get("promptUsage")
        .and_then(prompt_usage_from_value)
        .or_else(|| prompt_usage_from_value(data))
        .map(|mut usage| {
            if usage.model.is_none() {
                usage.model = data
                    .pointer("/promptUsage/modelUsage")
                    .and_then(Value::as_object)
                    .and_then(|models| models.keys().next())
                    .cloned();
            }
            usage
        })
}

pub fn usage_from_session_notification_params(params: &Value) -> Option<AgentUsage> {
    params
        .get("update")
        .and_then(usage_from_session_update)
        .or_else(|| usage_from_session_update(params))
        .map(|mut usage| {
            if usage.model.is_none() {
                usage.model = model_id_from_meta(params.get("_meta")).or_else(|| {
                    params
                        .get("update")
                        .and_then(|update| model_id_from_meta(update.get("_meta")))
                });
            }
            usage
        })
}

pub fn model_id_from_meta(meta: Option<&Value>) -> Option<String> {
    let meta = meta?;
    ["modelId", "model_id", "model"]
        .into_iter()
        .find_map(|key| {
            meta.get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        })
}

/// Claude config selects (`opus`, `fable`, `sonnet`, `haiku`) are aliases, not
/// model ids. Ranking and cost must use the concrete id from a transcript.
pub fn is_unresolved_model_alias(model: &str) -> bool {
    matches!(
        model.trim().to_ascii_lowercase().as_str(),
        "opus" | "fable" | "sonnet" | "haiku"
    )
}

pub fn model_id_from_config_options(options: &[AgentSessionConfigOption]) -> Option<String> {
    options.iter().find_map(|option| {
        if !option
            .category
            .as_deref()
            .is_some_and(|category| category.eq_ignore_ascii_case("model"))
        {
            return None;
        }
        option
            .value
            .as_ref()
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty() && !is_unresolved_model_alias(value))
            .map(ToOwned::to_owned)
    })
}

fn acp_prompt_usage(usage: &Value) -> Option<AgentUsage> {
    let input = u64_field(usage, &["inputTokens"]);
    let output = u64_field(usage, &["outputTokens"]);
    let cache_read = u64_field(usage, &["cachedReadTokens", "cacheReadTokens"]);
    let cache_write = u64_field(usage, &["cacheCreationTokens", "cachedWriteTokens"]);
    if input == 0 && output == 0 && cache_read == 0 && cache_write == 0 {
        return None;
    }
    Some(AgentUsage {
        input_tokens: Some(input.saturating_sub(cache_read).saturating_sub(cache_write)),
        output_tokens: Some(output),
        cache_read_tokens: (cache_read > 0).then_some(cache_read),
        cache_write_tokens: (cache_write > 0).then_some(cache_write),
        model: model_id_from_meta(usage.get("_meta")).or_else(|| {
            usage
                .get("model")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        }),
        ..AgentUsage::default()
    })
}

fn disjoint_usage(usage: &Value) -> Option<AgentUsage> {
    let input = u64_field(usage, &["input_tokens", "prompt_tokens"]);
    let output = u64_field(usage, &["output_tokens", "completion_tokens"]);
    let cache_read = u64_field(
        usage,
        &[
            "cache_read_input_tokens",
            "cached_read_tokens",
            "cache_read_tokens",
        ],
    );
    let cache_write = u64_field(
        usage,
        &[
            "cache_creation_input_tokens",
            "cached_write_tokens",
            "cache_write_tokens",
        ],
    );
    if input == 0 && output == 0 && cache_read == 0 && cache_write == 0 {
        return None;
    }
    Some(AgentUsage {
        input_tokens: Some(input),
        output_tokens: Some(output),
        cache_read_tokens: (cache_read > 0).then_some(cache_read),
        cache_write_tokens: (cache_write > 0).then_some(cache_write),
        model: usage
            .get("model")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned),
        ..AgentUsage::default()
    })
}

/// Merge one usage sample into the turn accumulator.
///
/// Occupancy (`used` / `limit`) and model/cost always merge. Token buckets
/// are copied only when the incoming sample has protocol spend. An all-zero
/// or `Some(0)` report is occupancy, and must not erase a prior breakdown.
pub fn merge_agent_usage(existing: Option<AgentUsage>, incoming: &AgentUsage) -> AgentUsage {
    let mut target = existing.unwrap_or_default();
    if incoming.used > 0 {
        target.used = incoming.used;
    }
    if incoming.limit.is_some() {
        target.limit = incoming.limit;
    }
    let spend = incoming.input_tokens.unwrap_or(0)
        + incoming.output_tokens.unwrap_or(0)
        + incoming.cache_read_tokens.unwrap_or(0)
        + incoming.cache_write_tokens.unwrap_or(0);
    if spend > 0 {
        if incoming.input_tokens.is_some() {
            target.input_tokens = incoming.input_tokens;
        }
        if incoming.output_tokens.is_some() {
            target.output_tokens = incoming.output_tokens;
        }
        if incoming.cache_read_tokens.is_some() {
            target.cache_read_tokens = incoming.cache_read_tokens;
        }
        if incoming.cache_write_tokens.is_some() {
            target.cache_write_tokens = incoming.cache_write_tokens;
        }
    }
    if incoming.model.is_some() {
        target.model = incoming.model.clone();
    }
    if incoming.cost_amount.is_some() {
        target.cost_amount = incoming.cost_amount;
    }
    if incoming.cost_currency.is_some() {
        target.cost_currency = incoming.cost_currency.clone();
    }
    target
}

fn u64_field(value: &Value, keys: &[&str]) -> u64 {
    keys.iter()
        .find_map(|key| {
            value.get(*key).and_then(|candidate| {
                candidate
                    .as_u64()
                    .or_else(|| candidate.as_i64().and_then(|n| u64::try_from(n).ok()))
                    .or_else(|| {
                        candidate
                            .as_f64()
                            .and_then(|n| (n >= 0.0).then_some(n as u64))
                    })
            })
        })
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn claude_short_aliases_are_not_model_ids() {
        assert!(is_unresolved_model_alias("opus"));
        assert!(is_unresolved_model_alias("Fable"));
        assert!(is_unresolved_model_alias(" sonnet "));
        assert!(!is_unresolved_model_alias("claude-opus-4-6"));
        assert!(!is_unresolved_model_alias("claude-fable-5"));
    }

    #[test]
    fn grok_turn_completed_is_per_prompt_and_disjoint() {
        // Numbers lifted from CodeG's captured Grok `turn_completed` fixture.
        let params = json!({
            "sessionId": "s",
            "update": {
                "sessionUpdate": "turn_completed",
                "prompt_id": "e526ba42",
                "stop_reason": "end_turn",
                "usage": {
                    "inputTokens": 86174,
                    "outputTokens": 1652,
                    "totalTokens": 87826,
                    "cachedReadTokens": 56960,
                    "reasoningTokens": 574,
                    "modelCalls": 5
                },
                "_meta": { "modelId": "grok-4.6" }
            }
        });

        let usage = usage_from_session_notification_params(&params).expect("usage");
        assert_eq!(usage.input_tokens, Some(29_214));
        assert_eq!(usage.output_tokens, Some(1_652));
        assert_eq!(usage.cache_read_tokens, Some(56_960));
        assert_eq!(usage.cache_write_tokens, None);
        assert_eq!(usage.model.as_deref(), Some("grok-4.6"));
        assert_eq!(
            usage.input_tokens.unwrap()
                + usage.output_tokens.unwrap()
                + usage.cache_read_tokens.unwrap(),
            87_826
        );
    }

    #[test]
    fn zero_token_report_does_not_erase_prior_spend() {
        let existing = AgentUsage {
            input_tokens: Some(29_214),
            output_tokens: Some(1_652),
            cache_read_tokens: Some(56_960),
            ..AgentUsage::default()
        };
        let occupancy = AgentUsage {
            used: 80_000,
            limit: Some(200_000),
            input_tokens: Some(0),
            output_tokens: Some(0),
            cache_read_tokens: Some(0),
            cache_write_tokens: Some(0),
            ..AgentUsage::default()
        };
        let merged = merge_agent_usage(Some(existing), &occupancy);
        assert_eq!(merged.input_tokens, Some(29_214));
        assert_eq!(merged.output_tokens, Some(1_652));
        assert_eq!(merged.cache_read_tokens, Some(56_960));
        assert_eq!(merged.used, 80_000);
        assert_eq!(merged.limit, Some(200_000));
    }

    #[test]
    fn occupancy_is_not_read_as_token_spend() {
        let params = json!({
            "sessionId": "s",
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "hi" }
            },
            "_meta": { "totalTokens": 18658 }
        });
        assert!(usage_from_session_notification_params(&params).is_none());
    }

    #[test]
    fn empty_or_zero_usage_stays_missing() {
        assert!(prompt_usage_from_value(&json!({})).is_none());
        assert!(
            prompt_usage_from_value(&json!({
                "inputTokens": 0,
                "outputTokens": 0
            }))
            .is_none()
        );
    }

    #[test]
    fn snake_case_usage_is_already_disjoint() {
        let usage = prompt_usage_from_value(&json!({
            "input_tokens": 10,
            "output_tokens": 4,
            "cache_read_input_tokens": 20
        }))
        .expect("usage");
        assert_eq!(usage.input_tokens, Some(10));
        assert_eq!(usage.output_tokens, Some(4));
        assert_eq!(usage.cache_read_tokens, Some(20));
    }

    #[test]
    fn grok_internal_error_prompt_usage_is_recovered() {
        let data = json!({
            "message": "serialization error: missing field `created_at`",
            "promptUsage": {
                "inputTokens": 100,
                "outputTokens": 20,
                "cachedReadTokens": 40,
                "modelUsage": { "grok-4.6-build": { "inputTokens": 100 } }
            }
        });
        let usage = usage_from_error_data(Some(&data)).expect("usage");
        assert_eq!(usage.input_tokens, Some(60));
        assert_eq!(usage.output_tokens, Some(20));
        assert_eq!(usage.cache_read_tokens, Some(40));
        assert_eq!(usage.model.as_deref(), Some("grok-4.6-build"));
    }

    #[test]
    fn acp_prompt_usage_json_is_disjoint_and_reads_model() {
        let usage = prompt_usage_from_value(&json!({
            "inputTokens": 86174,
            "outputTokens": 1652,
            "totalTokens": 87826,
            "cachedReadTokens": 56960,
            "_meta": { "modelId": "grok-4.6" }
        }))
        .expect("usage");
        assert_eq!(usage.input_tokens, Some(29_214));
        assert_eq!(usage.output_tokens, Some(1_652));
        assert_eq!(usage.cache_read_tokens, Some(56_960));
        assert_eq!(usage.model.as_deref(), Some("grok-4.6"));
    }

    #[test]
    fn model_id_from_model_config_option() {
        let options = vec![AgentSessionConfigOption {
            key: "model".into(),
            label: "Model".into(),
            description: None,
            category: Some("model".into()),
            value: Some(json!("grok-4.6")),
            choices: Vec::new(),
            dependency: None,
        }];
        assert_eq!(
            model_id_from_config_options(&options).as_deref(),
            Some("grok-4.6")
        );
    }
}
