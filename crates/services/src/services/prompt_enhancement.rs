use std::borrow::Cow;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::services::config::Config;

/// Error type for the prompt-enhancement service. The Tauri shell maps it back to
/// `AppError` (variant-preserving) at the command boundary (架构报告 A-1).
#[derive(Debug, thiserror::Error)]
pub enum PromptEnhancementError {
    #[error("Not found: {0}")]
    NotFound(String),
    #[error("Bad request: {0}")]
    BadRequest(String),
    #[error("Internal error: {0}")]
    Internal(String),
}

pub const PROMPT_ENHANCE_TIMEOUT_SECS: u64 = 45;
const PROMPT_ENHANCE_CONTEXT_CHAR_LIMIT: usize = 32_000;
const DEFAULT_PROMPT_ENHANCE_INSTRUCTION: &str = r#"You are PromptEnhance (PE).

Your job is to rewrite the user's draft prompt into a clearer, tighter, more actionable prompt.

Rules:
1. Be fast: do not explain your reasoning, just produce the optimized prompt.
2. Be accurate: use the recent conversation context only when it materially improves the prompt.
3. Optimize the prompt itself, not the conversation summary.
4. Do not echo or expose session context unless the user's prompt is clearly ambiguous without it.
5. Do not add sections like "related context" unless absolutely necessary.
6. Follow basic prompt design principles: clearly state the task, goal, constraints, and any helpful decomposition.
7. Avoid bloated prompt frameworks, unnecessary ceremony, and redundant wording.
8. Keep the user's original intent unchanged.
9. Output JSON only, with exactly one top-level field named EnhancedPrompt.
10. Do not return Markdown fences, commentary, or any extra fields.

Output shape:
{"EnhancedPrompt":"..."}"#;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptEnhancementContextMessage {
    pub role: String,
    pub content: String,
    pub timestamp: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptEnhancementRequest {
    pub draft_prompt: String,
    pub session_id: Option<String>,
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub context_messages: Vec<PromptEnhancementContextMessage>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptEnhancementResponse {
    pub enhanced_prompt: String,
    pub model: String,
}

fn build_prompt_enhancement_instruction() -> &'static str {
    DEFAULT_PROMPT_ENHANCE_INSTRUCTION
}

/// The selected model is intentionally optional. Model availability belongs to
/// OpenCode's verified capability catalog, not to a static application default.
pub fn selected_prompt_enhancement_model(config: &Config) -> Option<&str> {
    let trimmed = config.prompt_enhancement_model.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn selected_prompt_enhancement_instruction(config: &Config) -> Cow<'_, str> {
    let trimmed = config
        .prompt_enhancement_prompt
        .as_deref()
        .map(str::trim)
        .unwrap_or_default();

    if trimmed.is_empty() {
        Cow::Borrowed(build_prompt_enhancement_instruction())
    } else {
        Cow::Owned(trimmed.to_string())
    }
}

fn is_context_dependent_prompt(draft_prompt: &str) -> bool {
    [
        "继续",
        "上面",
        "前文",
        "刚才",
        "这个",
        "那个",
        "这里",
        "那里",
        "如上",
        "上一条",
        "前面",
        "改一下",
        "再优化",
        "继续修复",
        "接着",
        "它",
        "这个问题",
    ]
    .iter()
    .any(|marker| draft_prompt.contains(marker))
}

fn trim_prompt_enhancement_context(
    messages: &[PromptEnhancementContextMessage],
    max_chars: usize,
) -> Vec<PromptEnhancementContextMessage> {
    let mut total = 0usize;
    let mut selected = Vec::new();

    for message in messages.iter().rev() {
        let estimated_len = message.role.len()
            + message.content.len()
            + message.timestamp.as_deref().map(str::len).unwrap_or(0)
            + 32;

        if !selected.is_empty() && total + estimated_len > max_chars {
            break;
        }

        total += estimated_len;
        selected.push(PromptEnhancementContextMessage {
            role: message.role.clone(),
            content: message.content.clone(),
            timestamp: message.timestamp.clone(),
        });
    }

    selected.reverse();
    selected
}

/// Build the full prompt text (instruction + JSON input) sent to the
/// enhancement agent over ACP.
pub fn build_prompt_enhancement_payload(
    config: &Config,
    payload: &PromptEnhancementRequest,
) -> Result<String, PromptEnhancementError> {
    let trimmed_context = if is_context_dependent_prompt(payload.draft_prompt.trim()) {
        trim_prompt_enhancement_context(
            &payload.context_messages,
            PROMPT_ENHANCE_CONTEXT_CHAR_LIMIT,
        )
    } else {
        Vec::new()
    };

    let request_body = json!({
        "task": "Optimize the user's draft prompt.",
        "requirements": {
            "keepIntent": true,
            "beFast": true,
            "beAccurate": true,
            "returnJsonOnly": true,
            "outputField": "EnhancedPrompt"
        },
        "currentDraftPrompt": payload.draft_prompt.trim(),
        "sessionContext": trimmed_context,
    });

    serde_json::to_string_pretty(&request_body)
        .map(|body| {
            format!(
                "{}\n\nInput:\n{}",
                selected_prompt_enhancement_instruction(config),
                body
            )
        })
        .map_err(|error| {
            PromptEnhancementError::Internal(format!("Failed to build PE payload: {}", error))
        })
}

/// Validate that prompt enhancement can run for this request. The actual
/// execution happens over the ACP runtime in the Tauri shell (which owns
/// `AgentRuntime`); this service keeps the transport-agnostic pieces.
pub fn validate_prompt_enhancement_request(
    config: &Config,
    payload: &PromptEnhancementRequest,
) -> Result<(), PromptEnhancementError> {
    if !config.prompt_enhancement_enabled {
        return Err(PromptEnhancementError::BadRequest(
            "Prompt enhancement is disabled in system settings".to_string(),
        ));
    }

    if payload.draft_prompt.trim().is_empty() {
        return Err(PromptEnhancementError::BadRequest(
            "Draft prompt cannot be empty".to_string(),
        ));
    }

    Ok(())
}

fn extract_enhanced_prompt_from_json_value(value: &Value) -> Option<String> {
    match value {
        Value::Object(map) => {
            if let Some(Value::String(prompt)) = map.get("EnhancedPrompt") {
                let trimmed = prompt.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }

            for child in map.values() {
                if let Some(prompt) = extract_enhanced_prompt_from_json_value(child) {
                    return Some(prompt);
                }
            }

            None
        }
        Value::Array(items) => items
            .iter()
            .find_map(extract_enhanced_prompt_from_json_value),
        Value::String(text) => extract_enhanced_prompt(text),
        _ => None,
    }
}

pub fn extract_enhanced_prompt(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Ok(value) = serde_json::from_str::<Value>(trimmed)
        && let Some(prompt) = extract_enhanced_prompt_from_json_value(&value)
    {
        return Some(prompt);
    }

    for line in trimmed
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if let Ok(value) = serde_json::from_str::<Value>(line)
            && let Some(prompt) = extract_enhanced_prompt_from_json_value(&value)
        {
            return Some(prompt);
        }
    }

    let key = "\"EnhancedPrompt\"";
    let key_index = trimmed.find(key)?;
    let after_key = &trimmed[key_index + key.len()..];
    let colon_index = after_key.find(':')?;
    let after_colon = after_key[colon_index + 1..].trim_start();
    if !after_colon.starts_with('"') {
        return None;
    }

    let mut escaped = false;
    let mut end_index = None;
    for (idx, ch) in after_colon.char_indices().skip(1) {
        if escaped {
            escaped = false;
            continue;
        }
        match ch {
            '\\' => escaped = true,
            '"' => {
                end_index = Some(idx);
                break;
            }
            _ => {}
        }
    }

    let end_index = end_index?;
    let candidate = &after_colon[..=end_index];
    serde_json::from_str::<String>(candidate)
        .ok()
        .and_then(|prompt| {
            let trimmed = prompt.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        })
}

#[cfg(test)]
mod tests {
    use super::{
        PromptEnhancementContextMessage, extract_enhanced_prompt, trim_prompt_enhancement_context,
    };

    #[test]
    fn extracts_enhanced_prompt_from_plain_json() {
        let raw = r#"{"EnhancedPrompt":"Rewrite the API docs with clear steps."}"#;
        assert_eq!(
            extract_enhanced_prompt(raw).as_deref(),
            Some("Rewrite the API docs with clear steps.")
        );
    }

    #[test]
    fn extracts_enhanced_prompt_from_json_lines() {
        let raw = concat!(
            r#"{"type":"meta","value":"ignored"}"#,
            "\n",
            r#"{"type":"message","payload":{"EnhancedPrompt":"Summarize the bug and propose a fix plan."}}"#
        );
        assert_eq!(
            extract_enhanced_prompt(raw).as_deref(),
            Some("Summarize the bug and propose a fix plan.")
        );
    }

    #[test]
    fn extracts_enhanced_prompt_from_nested_stringified_payload() {
        let raw = r#"{"type":"assistant","content":"{\"EnhancedPrompt\":\"Return only the SQL migration steps.\"}"}"#;
        assert_eq!(
            extract_enhanced_prompt(raw).as_deref(),
            Some("Return only the SQL migration steps.")
        );
    }

    #[test]
    fn trims_prompt_context_from_the_tail() {
        let messages = vec![
            PromptEnhancementContextMessage {
                role: "user".to_string(),
                content: "older".repeat(20),
                timestamp: None,
            },
            PromptEnhancementContextMessage {
                role: "assistant".to_string(),
                content: "recent".repeat(10),
                timestamp: None,
            },
        ];

        let trimmed = trim_prompt_enhancement_context(&messages, 120);

        assert_eq!(trimmed.len(), 1);
        assert_eq!(trimmed[0].role, "assistant");
    }
}
