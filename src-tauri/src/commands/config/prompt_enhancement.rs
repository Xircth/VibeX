use std::{
    borrow::Cow,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use deployment::Deployment;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use services::services::config::Config;
use tokio::{
    fs,
    io::{AsyncBufReadExt, BufReader},
};
use uuid::Uuid;

use crate::{error::AppError, state::AppState};

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
const PROMPT_ENHANCE_TIMEOUT_SECS: u64 = 45;
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

fn selected_prompt_enhancement_model(config: &Config) -> &str {
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

fn normalize_multiline_text(value: &str) -> String {
    value
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

#[allow(dead_code)]
fn strip_list_prefix(value: &str) -> String {
    let trimmed = value.trim();
    let without_dash = trimmed
        .strip_prefix("- ")
        .or_else(|| trimmed.strip_prefix("* "))
        .or_else(|| trimmed.strip_prefix("鈥?"))
        .unwrap_or(trimmed);

    let numbered = without_dash
        .split_once(". ")
        .filter(|(prefix, _)| prefix.chars().all(|ch| ch.is_ascii_digit()))
        .map(|(_, rest)| rest)
        .unwrap_or(without_dash);

    numbered.trim().to_string()
}

#[allow(dead_code)]
fn split_prompt_sentences(value: &str) -> Vec<String> {
    value
        .replace("\r\n", "\n")
        .split(['\n', '。', '，', '；', ';'])
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(ToString::to_string)
        .collect()
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

#[cfg(test)]
fn split_task_clauses(value: &str) -> Vec<String> {
    value
        .replace("\r\n", "\n")
        .replace("锛屽苟", "\n")
        .replace("骞朵笖", "\n")
        .replace("鍚屾椂", "\n")
        .replace("鐒跺悗", "\n")
        .split('\n')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn collect_prompt_context_snippets(
    messages: &[PromptEnhancementContextMessage],
    draft_prompt: &str,
) -> Vec<String> {
    let normalized_draft = normalize_multiline_text(draft_prompt);
    let mut snippets = Vec::new();

    for message in messages.iter().rev() {
        if snippets.len() >= 3 {
            break;
        }

        if !matches!(message.role.as_str(), "user" | "assistant") {
            continue;
        }

        let normalized = normalize_multiline_text(&message.content);
        if normalized.is_empty() || normalized == normalized_draft {
            continue;
        }

        let truncated = if normalized.chars().count() > 220 {
            let shortened = normalized.chars().take(220).collect::<String>();
            format!("{shortened}...")
        } else {
            normalized
        };

        snippets.push(format!("{}: {}", message.role, truncated));
    }

    snippets.reverse();
    snippets
}

#[allow(dead_code)]
fn build_local_enhanced_prompt(payload: &PromptEnhancementRequest) -> String {
    let draft = normalize_multiline_text(&payload.draft_prompt);
    let lines: Vec<String> = draft
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToString::to_string)
        .collect();

    let mut goal = String::new();
    let mut requirement_lines: Vec<String> = Vec::new();
    let mut output_lines: Vec<String> = Vec::new();

    let classify_output = |line: &str| {
        let lowered = line.to_lowercase();
        lowered.contains("json")
            || lowered.contains("markdown")
            || lowered.contains("yaml")
            || lowered.contains("xml")
            || lowered.contains("sql")
            || lowered.contains("diff")
            || lowered.contains("patch")
            || line.contains("琛ㄦ牸")
            || line.contains("鏍煎紡")
            || line.contains("杈撳嚭")
            || line.contains("杩斿洖")
    };

    if lines.iter().any(|line| {
        let trimmed = line.trim_start();
        trimmed.starts_with("- ")
            || trimmed.starts_with("* ")
            || trimmed.starts_with("鈥?")
            || trimmed
                .split_once(". ")
                .map(|(prefix, _)| prefix.chars().all(|ch| ch.is_ascii_digit()))
                .unwrap_or(false)
    }) {
        for line in &lines {
            let stripped = strip_list_prefix(line);
            if stripped.is_empty() {
                continue;
            }

            if goal.is_empty()
                && !line.trim_start().starts_with('-')
                && !line.trim_start().starts_with('*')
            {
                goal = stripped;
                continue;
            }

            if classify_output(&stripped) {
                output_lines.push(stripped);
            } else if stripped != goal {
                requirement_lines.push(stripped);
            }
        }
    } else {
        let sentences = split_prompt_sentences(&draft);
        if let Some(first) = sentences.first() {
            goal = first.clone();
        }

        for sentence in sentences.into_iter().skip(1) {
            if classify_output(&sentence) {
                output_lines.push(sentence);
            } else {
                requirement_lines.push(sentence);
            }
        }
    }

    if goal.is_empty() {
        goal = draft.clone();
    }

    if classify_output(&goal) && !output_lines.iter().any(|line| line == &goal) {
        output_lines.push(goal.clone());
    }

    let context_lines = collect_prompt_context_snippets(&payload.context_messages, &draft);
    let mut sections = vec![format!("浠诲姟鐩爣\n{}", goal)];

    if !context_lines.is_empty() {
        sections.push(format!(
            "鐩稿叧涓婁笅鏂嘰n{}",
            context_lines
                .into_iter()
                .map(|line| format!("- {}", line))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }

    if !requirement_lines.is_empty() {
        sections.push(format!(
            "鍏蜂綋瑕佹眰\n{}",
            requirement_lines
                .into_iter()
                .map(|line| format!("- {}", line))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }

    if !output_lines.is_empty() {
        sections.push(format!(
            "杈撳嚭瑕佹眰\n{}",
            output_lines
                .into_iter()
                .map(|line| format!("- {}", line))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }

    sections.join("\n\n")
}

#[cfg(test)]
fn build_local_enhanced_prompt_v2(payload: &PromptEnhancementRequest) -> String {
    let draft = normalize_multiline_text(&payload.draft_prompt);
    let task_lines = split_task_clauses(&draft);
    let mut sections = Vec::new();

    if task_lines.len() <= 1 {
        sections.push(format!("任务\n- {}", draft));
    } else {
        sections.push(format!(
            "任务\n{}",
            task_lines
                .iter()
                .map(|line| format!("- {}", line))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }

    let mut requirements = vec![
        "保持用户原始意图，不要扩写成无关的大纲或方案。".to_string(),
        "补全缺失的目标、约束、验收标准和必要上下文。".to_string(),
        "输出一段可直接交给编码 Agent 执行的清晰提示词。".to_string(),
    ];

    let lowered = draft.to_lowercase();
    if lowered.contains("readme") {
        requirements.insert(
            1,
            "README 相关任务需要说明目标读者、需要覆盖的功能范围，以及是否要保留现有结构。"
                .to_string(),
        );
    }
    if lowered.contains("启动") || lowered.contains("run") || lowered.contains("dev") {
        requirements.insert(
            2,
            "启动相关任务需要包含运行命令、预期端口、失败日志和验证方式。".to_string(),
        );
    }

    if is_context_dependent_prompt(&draft) {
        let context_lines = collect_prompt_context_snippets(&payload.context_messages, &draft);
        if !context_lines.is_empty() {
            requirements.insert(
                0,
                format!(
                    "必要时结合前文信息理解当前任务，但不要把前文摘要直接写进最终提示词。可参考信息：{}",
                    context_lines.join("；")
                ),
            );
        }
    }

    sections.push(format!(
        "要求\n{}",
        requirements
            .into_iter()
            .map(|line| format!("- {}", line))
            .collect::<Vec<_>>()
            .join("\n")
    ));

    sections.join("\n\n")
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

fn build_prompt_enhancement_payload(
    config: &Config,
    payload: &PromptEnhancementRequest,
) -> Result<String, AppError> {
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
        .map_err(|error| AppError::Internal(format!("Failed to build PE payload: {}", error)))
}

async fn write_prompt_enhancement_attachment(
    current_dir: &Path,
    config: &Config,
    payload: &PromptEnhancementRequest,
) -> Result<PathBuf, AppError> {
    let file_path = current_dir.join(format!(".vibex-pe-{}.json", Uuid::new_v4()));
    let content = build_prompt_enhancement_payload(config, payload)?;

    fs::write(&file_path, content).await.map_err(|error| {
        AppError::Internal(format!(
            "Failed to write prompt enhancement attachment: {}",
            error
        ))
    })?;

    Ok(file_path)
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

fn extract_enhanced_prompt(raw: &str) -> Option<String> {
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

async fn wait_for_enhanced_prompt(
    mut child: tokio::process::Child,
    timeout: Duration,
) -> Result<String, AppError> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Internal("OpenCode process missing stdout".to_string()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Internal("OpenCode process missing stderr".to_string()))?;

    let mut stdout_lines = BufReader::new(stdout).lines();
    let mut stderr_lines = BufReader::new(stderr).lines();
    let deadline = tokio::time::Instant::now() + timeout;
    let mut stdout_buffer = String::new();
    let mut stderr_buffer = String::new();
    let mut stdout_done = false;
    let mut stderr_done = false;

    loop {
        if let Some(prompt) = extract_enhanced_prompt(&stdout_buffer)
            .or_else(|| extract_enhanced_prompt(&stderr_buffer))
        {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Ok(prompt);
        }

        if stdout_done && stderr_done {
            let status = child.wait().await.map_err(|error| {
                AppError::Internal(format!("Failed waiting for OpenCode: {}", error))
            })?;

            let detail = if !stderr_buffer.trim().is_empty() {
                stderr_buffer.trim().to_string()
            } else {
                stdout_buffer.trim().to_string()
            };

            let message = if status.success() {
                if detail.is_empty() {
                    "OpenCode response did not contain a valid EnhancedPrompt field".to_string()
                } else {
                    format!(
                        "OpenCode response did not contain a valid EnhancedPrompt field. Raw output: {}",
                        detail
                    )
                }
            } else if detail.is_empty() {
                format!("OpenCode prompt enhancement failed with status {}", status)
            } else {
                format!("OpenCode prompt enhancement failed: {}", detail)
            };

            return Err(AppError::Internal(message));
        }

        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(AppError::Internal(format!(
                    "OpenCode prompt enhancement timed out after {} seconds",
                    PROMPT_ENHANCE_TIMEOUT_SECS
                )));
            }
            line = stdout_lines.next_line(), if !stdout_done => {
                match line {
                    Ok(Some(line)) => {
                        stdout_buffer.push_str(&line);
                        stdout_buffer.push('\n');
                    }
                    Ok(None) => {
                        stdout_done = true;
                    }
                    Err(error) => {
                        let _ = child.kill().await;
                        let _ = child.wait().await;
                        return Err(AppError::Internal(format!(
                            "Failed reading OpenCode stdout: {}",
                            error
                        )));
                    }
                }
            }
            line = stderr_lines.next_line(), if !stderr_done => {
                match line {
                    Ok(Some(line)) => {
                        stderr_buffer.push_str(&line);
                        stderr_buffer.push('\n');
                    }
                    Ok(None) => {
                        stderr_done = true;
                    }
                    Err(error) => {
                        let _ = child.kill().await;
                        let _ = child.wait().await;
                        return Err(AppError::Internal(format!(
                            "Failed reading OpenCode stderr: {}",
                            error
                        )));
                    }
                }
            }
        }
    }
}

pub(crate) async fn enhance_prompt(
    state: tauri::State<'_, AppState>,
    payload: PromptEnhancementRequest,
) -> Result<PromptEnhancementResponse, AppError> {
    let config = state.deployment.config().read().await.clone();
    if !config.prompt_enhancement_enabled {
        return Err(AppError::BadRequest(
            "Prompt enhancement is disabled in system settings".to_string(),
        ));
    }

    if payload.draft_prompt.trim().is_empty() {
        return Err(AppError::BadRequest(
            "Draft prompt cannot be empty".to_string(),
        ));
    }

    let executable = tokio::task::spawn_blocking(|| which::which("opencode"))
        .await
        .map_err(|error| {
            AppError::Internal(format!("Failed to resolve OpenCode executable: {}", error))
        })?
        .map_err(|_| AppError::NotFound("OpenCode CLI not found".to_string()))?;

    let model = selected_prompt_enhancement_model(&config).to_string();
    let current_dir = std::env::current_dir().map_err(|error| {
        AppError::Internal(format!(
            "Failed to resolve current working directory for prompt enhancement: {}",
            error
        ))
    })?;
    let attachment_path =
        write_prompt_enhancement_attachment(&current_dir, &config, &payload).await?;

    let mut command = utils::process::new_hidden_tokio_command(
        &executable,
        [
            "run",
            "--format",
            "json",
            "--model",
            model.as_str(),
            "Read the attached file and return JSON only with top-level field EnhancedPrompt.",
            "-f",
            attachment_path.to_str().ok_or_else(|| {
                AppError::Internal(
                    "Prompt enhancement attachment path contains invalid Unicode".to_string(),
                )
            })?,
        ],
    );
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.current_dir(&current_dir);

    let child = command
        .spawn()
        .map_err(|error| AppError::Internal(format!("Failed to run OpenCode: {}", error)))?;

    let result =
        wait_for_enhanced_prompt(child, Duration::from_secs(PROMPT_ENHANCE_TIMEOUT_SECS)).await;

    let _ = fs::remove_file(&attachment_path).await;
    let enhanced_prompt = result?;

    Ok(PromptEnhancementResponse {
        enhanced_prompt,
        model,
    })
}

pub(crate) async fn list_opencode_models(
    state: tauri::State<'_, AppState>,
) -> Result<OpencodeModelsResponse, AppError> {
    let _ = state;

    let executable = tokio::task::spawn_blocking(|| which::which("opencode"))
        .await
        .map_err(|error| {
            AppError::Internal(format!("Failed to resolve OpenCode executable: {}", error))
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
            "鈹?opencode/mimo-v2-pro-free 鈹?free tier 鈹俓n",
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

    #[test]
    fn builds_local_enhanced_prompt_with_context() {
        let payload = super::PromptEnhancementRequest {
            draft_prompt: "继续优化这个设置页布局".to_string(),
            session_id: None,
            workspace_id: None,
            context_messages: vec![
                super::PromptEnhancementContextMessage {
                    role: "user".to_string(),
                    content: "设置页使用 React 和 Tailwind CSS".to_string(),
                    timestamp: None,
                },
                super::PromptEnhancementContextMessage {
                    role: "assistant".to_string(),
                    content: "已将设置项分组为 Agent、交互、编辑、外观和系统".to_string(),
                    timestamp: None,
                },
            ],
        };

        let result = super::build_local_enhanced_prompt_v2(&payload);

        assert!(result.contains("任务"));
        assert!(result.contains("要求"));
        assert!(result.contains("React"));
    }

    #[test]
    fn builds_local_enhanced_prompt_with_output_requirements() {
        let payload = super::PromptEnhancementRequest {
            draft_prompt: "生成 JSON 输出格式".to_string(),
            session_id: None,
            workspace_id: None,
            context_messages: vec![],
        };

        let result = super::build_local_enhanced_prompt_v2(&payload);

        assert!(result.contains("任务"));
        assert!(result.contains("JSON"));
    }

    #[test]
    fn local_prompt_enhancer_v2_uses_compact_structure() {
        let payload = super::PromptEnhancementRequest {
            draft_prompt: "更新 readme.md 说明启动方式".to_string(),
            session_id: None,
            workspace_id: None,
            context_messages: vec![super::PromptEnhancementContextMessage {
                role: "assistant".to_string(),
                content: "不应在非上下文任务里泄漏这段历史".to_string(),
                timestamp: None,
            }],
        };

        let result = super::build_local_enhanced_prompt_v2(&payload);

        assert!(result.contains("任务"));
        assert!(result.contains("- 更新 readme.md 说明启动方式"));
        assert!(result.contains("README 相关任务"));
        assert!(!result.contains("不应在非上下文任务里泄漏这段历史"));
    }

    #[test]
    fn local_prompt_enhancer_v2_only_uses_context_for_contextual_prompts() {
        let payload = super::PromptEnhancementRequest {
            draft_prompt: "继续修复这个问题".to_string(),
            session_id: None,
            workspace_id: None,
            context_messages: vec![super::PromptEnhancementContextMessage {
                role: "user".to_string(),
                content: "页面使用 React 和 Tailwind CSS".to_string(),
                timestamp: None,
            }],
        };

        let result = super::build_local_enhanced_prompt_v2(&payload);

        assert!(result.contains("必要时结合前文信息"));
        assert!(result.contains("React 和 Tailwind CSS"));
    }
}
