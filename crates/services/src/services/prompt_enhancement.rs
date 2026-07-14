use std::{borrow::Cow, process::Stdio, time::Duration};

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

const DEFAULT_PROMPT_ENHANCE_MODEL: &str = "opencode/minimax-m2.5-free";
const DEFAULT_OPENCODE_MODELS: &[&str] = &[
    "opencode/claude-opus-4-7",
    "opencode/claude-opus-4-6",
    "opencode/claude-opus-4-5",
    "opencode/claude-opus-4-1",
    "opencode/claude-sonnet-4-6",
    "opencode/claude-sonnet-4-5",
    "opencode/claude-sonnet-4",
    "opencode/claude-haiku-4-5",
    "opencode/gemini-3.1-pro",
    "opencode/gemini-3-flash",
    "opencode/gpt-5.5",
    "opencode/gpt-5.5-pro",
    "opencode/gpt-5.4",
    "opencode/gpt-5.4-pro",
    "opencode/gpt-5.4-mini",
    "opencode/gpt-5.4-nano",
    "opencode/gpt-5.3-codex-spark",
    "opencode/gpt-5.3-codex",
    "opencode/gpt-5.2",
    "opencode/gpt-5.2-codex",
    "opencode/gpt-5.1",
    "opencode/gpt-5.1-codex-max",
    "opencode/gpt-5.1-codex",
    "opencode/gpt-5.1-codex-mini",
    "opencode/gpt-5",
    "opencode/gpt-5-codex",
    "opencode/gpt-5-nano",
    "opencode/glm-5.1",
    "opencode/glm-5",
    "opencode/minimax-m2.7",
    "opencode/minimax-m2.5",
    "opencode/kimi-k2.6",
    "opencode/kimi-k2.5",
    "opencode/qwen3.6-plus",
    "opencode/qwen3.5-plus",
    "opencode/big-pickle",
    "opencode/minimax-m2.5-free",
    "opencode/hy3-preview-free",
    "opencode/ling-2.6-flash-free",
    "opencode/trinity-large-preview-free",
    "opencode/nemotron-3-super-free",
];
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

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeModelsResponse {
    pub models: Vec<String>,
}

fn build_prompt_enhancement_instruction() -> &'static str {
    DEFAULT_PROMPT_ENHANCE_INSTRUCTION
}

fn parse_opencode_models(stdout: &str) -> Vec<String> {
    let mut models = Vec::new();

    for token in stdout
        .split(|ch: char| !(ch.is_ascii_alphanumeric() || matches!(ch, '/' | '-' | '_' | '.')))
        .map(str::trim)
        .filter(|token| token.starts_with("opencode/"))
    {
        if !models.iter().any(|existing| existing == token) {
            models.push(token.to_string());
        }
    }

    models
}

fn default_opencode_models_response() -> OpencodeModelsResponse {
    OpencodeModelsResponse {
        models: DEFAULT_OPENCODE_MODELS
            .iter()
            .map(|model| (*model).to_string())
            .collect(),
    }
}

pub fn selected_prompt_enhancement_model(config: &Config) -> &str {
    let trimmed = config.prompt_enhancement_model.trim();
    if trimmed.is_empty() {
        DEFAULT_PROMPT_ENHANCE_MODEL
    } else {
        trimmed
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

pub async fn list_opencode_models() -> Result<OpencodeModelsResponse, PromptEnhancementError> {
    let executable = tokio::task::spawn_blocking(|| which::which("opencode"))
        .await
        .map_err(|error| {
            PromptEnhancementError::Internal(format!(
                "Failed to resolve OpenCode executable: {}",
                error
            ))
        })?
        .ok();

    let Some(executable) = executable else {
        return Ok(default_opencode_models_response());
    };

    let mut command = utils::process::new_hidden_tokio_command(&executable, ["models", "opencode"]);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Ok(current_dir) = std::env::current_dir() {
        command.current_dir(current_dir);
    }

    let output = match tokio::time::timeout(Duration::from_secs(30), command.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(_)) | Err(_) => return Ok(default_opencode_models_response()),
    };

    if !output.status.success() {
        return Ok(default_opencode_models_response());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let models = parse_opencode_models(&stdout);

    if models.is_empty() {
        return Ok(default_opencode_models_response());
    }

    Ok(OpencodeModelsResponse { models })
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

    #[test]
    fn parses_opencode_models_from_stdout_lines() {
        let raw = concat!(
            "opencode/minimax-m2.5-free\n",
            "* opencode/mimo-v2-pro-free - free tier\n",
            "- opencode/gpt-5.5 (recommended)\n"
        );
        let models = super::parse_opencode_models(raw);
        assert_eq!(
            models,
            vec![
                "opencode/minimax-m2.5-free".to_string(),
                "opencode/mimo-v2-pro-free".to_string(),
                "opencode/gpt-5.5".to_string()
            ]
        );
    }
}
