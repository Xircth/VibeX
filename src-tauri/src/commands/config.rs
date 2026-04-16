use std::{
    borrow::Cow,
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use deployment::Deployment;
use executors::{
    executors::{
        AvailabilityInfo, BaseAgentCapability, BaseCodingAgent, StandardCodingAgentExecutor,
        codex::codex_home,
    },
    mcp_config::{McpConfig, read_agent_config, write_agent_config},
    profile::{ExecutorConfigs, ExecutorProfileId},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use services::services::config::{
    Config, ConfigError, SoundFile,
    editor::{EditorConfig, EditorType},
    save_config_to_file,
};
use tauri::Emitter;
use tokio::{
    fs,
    io::{AsyncBufReadExt, BufReader},
};
use ts_rs::TS;
use uuid::Uuid;

use crate::{error::AppError, state::AppState};

const DEFAULT_PROMPT_ENHANCE_MODEL: &str = "opencode/minimax-m2.5-free";
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

// --- Types ---

#[derive(Debug, Serialize, Deserialize)]
pub struct Environment {
    pub os_type: String,
    pub os_version: String,
    pub os_architecture: String,
    pub bitness: String,
}

impl Environment {
    pub fn new() -> Self {
        let info = os_info::get();
        Environment {
            os_type: info.os_type().to_string(),
            os_version: info.version().to_string(),
            os_architecture: info.architecture().unwrap_or("unknown").to_string(),
            bitness: info.bitness().to_string(),
        }
    }
}

impl Default for Environment {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UserSystemInfo {
    pub config: Config,
    #[serde(flatten)]
    pub profiles: ExecutorConfigs,
    pub environment: Environment,
    pub capabilities: HashMap<String, Vec<BaseAgentCapability>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GetMcpServerResponse {
    pub mcp_config: McpConfig,
    pub config_path: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProfilesContent {
    pub content: String,
    pub path: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CheckEditorAvailabilityResponse {
    pub available: bool,
}

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

// --- Commands ---

#[tauri::command]
pub async fn get_user_system_info(
    state: tauri::State<'_, AppState>,
) -> Result<UserSystemInfo, AppError> {
    let config = state.deployment.config().read().await.clone();

    let profiles = ExecutorConfigs::get_cached();
    let capabilities = {
        let mut caps: HashMap<String, Vec<BaseAgentCapability>> = HashMap::new();
        let profs = ExecutorConfigs::get_cached();
        for key in profs.executors.keys() {
            if let Some(agent) = profs.get_coding_agent(&ExecutorProfileId::new(*key)) {
                caps.insert(key.to_string(), agent.capabilities());
            }
        }
        caps
    };

    Ok(UserSystemInfo {
        config,
        profiles,
        environment: Environment::new(),
        capabilities,
    })
}

#[tauri::command]
pub async fn update_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    new_config: Config,
) -> Result<Config, AppError> {
    let config_path = utils::assets::config_path();
    let previous_theme = state.deployment.config().read().await.theme.clone();

    // Validate git branch prefix
    if !git::is_valid_branch_prefix(&new_config.git_branch_prefix) {
        return Err(AppError::BadRequest(
            "Invalid git branch prefix. Must be a valid git branch name component without slashes."
                .to_string(),
        ));
    }

    save_config_to_file(&new_config, &config_path).await?;

    let mut config = state.deployment.config().write().await;
    *config = new_config.clone();
    drop(config);

    if std::mem::discriminant(&previous_theme) != std::mem::discriminant(&new_config.theme) {
        app.emit(
            "theme-changed",
            json!({ "theme": new_config.theme.clone() }),
        )
        .map_err(|e| AppError::Internal(format!("Failed to emit theme change: {}", e)))?;
    }

    Ok(new_config)
}

#[tauri::command]
pub async fn get_mcp_servers(
    state: tauri::State<'_, AppState>,
    executor: BaseCodingAgent,
) -> Result<GetMcpServerResponse, AppError> {
    let _ = state; // state not directly used but kept for consistency

    let coding_agent = ExecutorConfigs::get_cached()
        .get_coding_agent(&ExecutorProfileId::new(executor))
        .ok_or(ConfigError::ValidationError(
            "Executor not found".to_string(),
        ))?;

    if !coding_agent.supports_mcp() {
        return Err(AppError::BadRequest(
            "MCP not supported by this executor".to_string(),
        ));
    }

    let config_path = match coding_agent.default_mcp_config_path() {
        Some(path) => path,
        None => {
            return Err(AppError::BadRequest(
                "Could not determine config file path".to_string(),
            ));
        }
    };

    let mut mcpc = coding_agent.get_mcp_config();
    let raw_config = read_agent_config(&config_path, &mcpc).await?;
    let servers = get_mcp_servers_from_config_path(&raw_config, &mcpc.servers_path);
    mcpc.set_servers(servers);

    Ok(GetMcpServerResponse {
        mcp_config: mcpc,
        config_path: config_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn update_mcp_servers(
    state: tauri::State<'_, AppState>,
    executor: BaseCodingAgent,
    servers: HashMap<String, Value>,
) -> Result<String, AppError> {
    let _ = state;

    let profiles = ExecutorConfigs::get_cached();
    let agent = profiles
        .get_coding_agent(&ExecutorProfileId::new(executor))
        .ok_or(ConfigError::ValidationError(
            "Executor not found".to_string(),
        ))?;

    if !agent.supports_mcp() {
        return Err(AppError::BadRequest(
            "This executor does not support MCP servers".to_string(),
        ));
    }

    let config_path = match agent.default_mcp_config_path() {
        Some(path) => path.to_path_buf(),
        None => {
            return Err(AppError::BadRequest(
                "Could not determine config file path".to_string(),
            ));
        }
    };

    let mcpc = agent.get_mcp_config();
    update_mcp_servers_in_config(&config_path, &mcpc, servers)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to update MCP servers: {}", e)))
}

#[tauri::command]
pub async fn get_profiles(state: tauri::State<'_, AppState>) -> Result<ProfilesContent, AppError> {
    let _ = state;
    let profiles_path = utils::assets::profiles_path();

    let profiles = ExecutorConfigs::get_cached();
    let content = serde_json::to_string_pretty(&profiles).unwrap_or_else(|e| {
        tracing::error!("Failed to serialize profiles to JSON: {}", e);
        serde_json::to_string_pretty(&ExecutorConfigs::from_defaults())
            .unwrap_or_else(|_| "{}".to_string())
    });

    Ok(ProfilesContent {
        content,
        path: profiles_path.display().to_string(),
    })
}

#[tauri::command]
pub async fn update_profiles(
    state: tauri::State<'_, AppState>,
    body: String,
) -> Result<String, AppError> {
    let _ = state;

    let executor_profiles: ExecutorConfigs = serde_json::from_str(&body)
        .map_err(|e| AppError::BadRequest(format!("Invalid executor profiles format: {}", e)))?;

    executor_profiles.save_overrides().map_err(|e| {
        tracing::error!("Failed to save executor profiles: {}", e);
        AppError::Internal(format!("Failed to save executor profiles: {}", e))
    })?;

    tracing::info!("Executor profiles saved successfully");
    ExecutorConfigs::reload();

    Ok("Executor profiles updated successfully".to_string())
}

#[tauri::command]
pub async fn check_editor_availability(
    state: tauri::State<'_, AppState>,
    editor_type: EditorType,
) -> Result<CheckEditorAvailabilityResponse, AppError> {
    let _ = state;

    let editor_config = EditorConfig::new(editor_type, None, None, None);

    let available = editor_config.check_availability().await;
    Ok(CheckEditorAvailabilityResponse { available })
}

#[tauri::command]
pub async fn check_agent_availability(
    state: tauri::State<'_, AppState>,
    executor: BaseCodingAgent,
) -> Result<AvailabilityInfo, AppError> {
    let _ = state;

    let profiles = ExecutorConfigs::get_cached();
    let profile_id = ExecutorProfileId::new(executor);

    let info = match profiles.get_coding_agent(&profile_id) {
        Some(agent) => agent.get_availability_info(),
        None => AvailabilityInfo::NotFound,
    };

    Ok(info)
}

#[tauri::command]
pub async fn play_notification_sound(
    state: tauri::State<'_, AppState>,
    sound_file: SoundFile,
) -> Result<(), AppError> {
    let _ = state;

    let file_path = sound_file
        .get_path()
        .await
        .map_err(|e| AppError::Internal(format!("Failed to resolve sound file: {}", e)))?;

    if cfg!(target_os = "macos") {
        let _ = tokio::process::Command::new("afplay")
            .arg(&file_path)
            .spawn();
    } else if cfg!(target_os = "linux") && !utils::is_wsl2() {
        let _ = tokio::process::Command::new("paplay")
            .arg(&file_path)
            .spawn()
            .or_else(|_| {
                tokio::process::Command::new("aplay")
                    .arg(&file_path)
                    .spawn()
            });
    } else {
        let file_path = file_path.to_string_lossy().replace('\'', "''");
        let mut cmd = tokio::process::Command::new("powershell.exe");
        cmd.arg("-NoProfile").arg("-Command").arg(format!(
            "(New-Object Media.SoundPlayer '{file_path}').PlaySync()"
        ));
        utils::process::configure_tokio_command_no_window(&mut cmd);
        let _ = cmd.spawn();
    }

    Ok(())
}

fn build_prompt_enhancement_instruction() -> &'static str {
    DEFAULT_PROMPT_ENHANCE_INSTRUCTION
}

fn parse_opencode_models(stdout: &str) -> Vec<String> {
    let mut models = Vec::new();

    for line in stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if !line.contains('/') || line.starts_with("opencode models") {
            continue;
        }

        if !models.iter().any(|existing| existing == line) {
            models.push(line.to_string());
        }
    }

    models
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
        .or_else(|| trimmed.strip_prefix("• "))
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
        .split(['\n', '。', '；', ';'])
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn is_context_dependent_prompt(draft_prompt: &str) -> bool {
    [
        "继续",
        "接着",
        "基于上文",
        "基于上述",
        "根据上文",
        "根据上述",
        "参考上文",
        "参考上述",
        "结合上文",
        "结合上述",
        "前面的",
        "之前的",
        "刚才的",
        "上面的",
        "上述",
        "上文",
    ]
    .iter()
    .any(|marker| draft_prompt.contains(marker))
}

#[cfg(test)]
fn split_task_clauses(value: &str) -> Vec<String> {
    value
        .replace("\r\n", "\n")
        .replace("，并", "\n")
        .replace("并且", "\n")
        .replace("同时", "\n")
        .replace("然后", "\n")
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
            || line.contains("表格")
            || line.contains("格式")
            || line.contains("输出")
            || line.contains("返回")
    };

    if lines.iter().any(|line| {
        let trimmed = line.trim_start();
        trimmed.starts_with("- ")
            || trimmed.starts_with("* ")
            || trimmed.starts_with("• ")
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

    let mut sections = vec![format!("任务目标\n{}", goal)];

    if !context_lines.is_empty() {
        sections.push(format!(
            "相关上下文\n{}",
            context_lines
                .into_iter()
                .map(|line| format!("- {}", line))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }

    if !requirement_lines.is_empty() {
        sections.push(format!(
            "具体要求\n{}",
            requirement_lines
                .into_iter()
                .map(|line| format!("- {}", line))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }

    if !output_lines.is_empty() {
        sections.push(format!(
            "输出要求\n{}",
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
        sections.push(format!("任务\n{}", draft));
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
        "保持与当前项目实际情况一致，不要编造不存在的信息。".to_string(),
        "如果执行过程中遇到问题，先定位原因，再继续处理或说明阻塞点。".to_string(),
        "完成后简要汇报结果。".to_string(),
    ];

    let lowered = draft.to_lowercase();
    if lowered.contains("readme") {
        requirements.insert(
            1,
            "README 内容应覆盖项目用途、安装方式、启动方式和必要的使用说明。".to_string(),
        );
    }
    if lowered.contains("启动") || lowered.contains("run") || lowered.contains("dev") {
        requirements.insert(
            2,
            "启动后确认前端是否正常运行；如果失败，说明原因和处理方法。".to_string(),
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
    let file_path = current_dir.join(format!(".vibe-ultra-pe-{}.json", Uuid::new_v4()));
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

#[tauri::command]
pub async fn enhance_prompt(
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

#[tauri::command]
pub async fn list_opencode_models(
    state: tauri::State<'_, AppState>,
) -> Result<OpencodeModelsResponse, AppError> {
    let _ = state;

    let executable = tokio::task::spawn_blocking(|| which::which("opencode"))
        .await
        .map_err(|error| {
            AppError::Internal(format!("Failed to resolve OpenCode executable: {}", error))
        })?
        .map_err(|error| AppError::NotFound(format!("OpenCode CLI not found: {}", error)))?;

    let mut command = utils::process::new_hidden_tokio_command(&executable, ["models", "opencode"]);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Ok(current_dir) = std::env::current_dir() {
        command.current_dir(current_dir);
    }

    let output = tokio::time::timeout(Duration::from_secs(30), command.output())
        .await
        .map_err(|_| AppError::Internal("Listing OpenCode models timed out".to_string()))?
        .map_err(|error| AppError::Internal(format!("Failed to run OpenCode: {}", error)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Internal(format!(
            "OpenCode models command failed: {}",
            stderr.trim()
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let models = parse_opencode_models(&stdout);

    if models.is_empty() {
        return Err(AppError::Internal(
            "No OpenCode models were returned by the local CLI".to_string(),
        ));
    }

    Ok(OpencodeModelsResponse { models })
}

// --- Claude Settings (~/.claude/settings.json) ---

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct ClaudeSettings {
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default, rename = "enabledPlugins")]
    pub enabled_plugins: HashMap<String, bool>,
}

fn claude_settings_path() -> Option<std::path::PathBuf> {
    // Use HOME on Unix, USERPROFILE on Windows
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|home| {
            std::path::PathBuf::from(home)
                .join(".claude")
                .join("settings.json")
        })
}

#[tauri::command]
pub async fn get_claude_settings(
    state: tauri::State<'_, AppState>,
) -> Result<ClaudeSettings, AppError> {
    let _ = state;

    let path = claude_settings_path()
        .ok_or_else(|| AppError::Internal("Could not determine home directory".to_string()))?;

    if !path.exists() {
        return Ok(ClaudeSettings::default());
    }

    let content = fs::read_to_string(&path)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to read claude settings: {}", e)))?;

    // Parse as generic JSON Value first, then extract known fields.
    // This avoids failures when the file contains unknown fields (e.g. "permissions").
    let raw: Value = serde_json::from_str(&content)
        .map_err(|e| AppError::Internal(format!("Failed to parse claude settings JSON: {}", e)))?;

    let env: HashMap<String, String> = raw
        .get("env")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    let enabled_plugins: HashMap<String, bool> = raw
        .get("enabledPlugins")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    Ok(ClaudeSettings {
        env,
        enabled_plugins,
    })
}

#[tauri::command]
pub async fn update_claude_settings(
    state: tauri::State<'_, AppState>,
    settings: ClaudeSettings,
) -> Result<ClaudeSettings, AppError> {
    let _ = state;

    let path = claude_settings_path()
        .ok_or_else(|| AppError::Internal("Could not determine home directory".to_string()))?;

    // Read existing file to preserve unknown fields
    let mut existing: Value = if path.exists() {
        let content = fs::read_to_string(&path)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to read claude settings: {}", e)))?;
        serde_json::from_str(&content).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    // Update only the fields we manage
    if let Some(obj) = existing.as_object_mut() {
        obj.insert(
            "env".to_string(),
            serde_json::to_value(&settings.env).unwrap(),
        );
        obj.insert(
            "enabledPlugins".to_string(),
            serde_json::to_value(&settings.enabled_plugins).unwrap(),
        );
    }

    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await.map_err(|e| {
            AppError::Internal(format!("Failed to create claude settings directory: {}", e))
        })?;
    }

    let content = serde_json::to_string_pretty(&existing)
        .map_err(|e| AppError::Internal(format!("Failed to serialize claude settings: {}", e)))?;

    fs::write(&path, content)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to write claude settings: {}", e)))?;

    Ok(settings)
}

// --- Helper functions (ported from server config route) ---

fn get_mcp_servers_from_config_path(raw_config: &Value, path: &[String]) -> HashMap<String, Value> {
    let mut current = raw_config;
    for part in path {
        current = match current.get(part) {
            Some(val) => val,
            None => return HashMap::new(),
        };
    }
    match current.as_object() {
        Some(servers) => servers
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        None => HashMap::new(),
    }
}

fn set_mcp_servers_in_config_path(
    raw_config: &mut Value,
    path: &[String],
    servers: &HashMap<String, Value>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if !raw_config.is_object() {
        *raw_config = serde_json::json!({});
    }

    let mut current = raw_config;
    for part in &path[..path.len() - 1] {
        if current.get(part).is_none() {
            current
                .as_object_mut()
                .unwrap()
                .insert(part.to_string(), serde_json::json!({}));
        }
        current = current.get_mut(part).unwrap();
        if !current.is_object() {
            *current = serde_json::json!({});
        }
    }

    let final_attr = path.last().unwrap();
    current
        .as_object_mut()
        .unwrap()
        .insert(final_attr.to_string(), serde_json::to_value(servers)?);

    Ok(())
}

async fn update_mcp_servers_in_config(
    config_path: &std::path::Path,
    mcpc: &McpConfig,
    new_servers: HashMap<String, Value>,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).await?;
    }

    let mut config = read_agent_config(config_path, mcpc).await?;
    let old_servers = get_mcp_servers_from_config_path(&config, &mcpc.servers_path).len();

    set_mcp_servers_in_config_path(&mut config, &mcpc.servers_path, &new_servers)?;
    write_agent_config(config_path, mcpc, &config).await?;

    let new_count = new_servers.len();
    let message = match (old_servers, new_count) {
        (0, 0) => "No MCP servers configured".to_string(),
        (0, n) => format!("Added {} MCP server(s)", n),
        (old, new) if old == new => {
            format!("Updated MCP server configuration ({} server(s))", new)
        }
        (old, new) => format!(
            "Updated MCP server configuration (was {}, now {})",
            old, new
        ),
    };

    Ok(message)
}

// --- Agent Native Config Files ---

/// Native configuration files for each agent (config.toml, auth.json, etc.)
#[derive(Debug, Serialize, Deserialize, TS)]
pub struct AgentNativeConfigs {
    /// Codex: ~/.codex/config.toml content
    pub codex_config_toml: Option<String>,
    /// Codex: ~/.codex/auth.json content
    pub codex_auth_json: Option<String>,
    /// Codex home directory path
    pub codex_home_path: Option<String>,
    /// OpenCode: config directory json content
    pub opencode_config_json: Option<String>,
    /// OpenCode: auth.json content
    pub opencode_auth_json: Option<String>,
    /// OpenCode config directory path
    pub opencode_config_path: Option<String>,
}

/// Returns the OpenCode config directory path (cross-platform).
fn opencode_config_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .ok()
            .or_else(|| dirs::home_dir().map(|p| p.join(".config")))
            .map(|p| p.join("opencode"))
    }
    #[cfg(not(windows))]
    {
        dirs::home_dir().map(|p| p.join(".config").join("opencode"))
    }
}

/// Returns the OpenCode auth.json path (cross-platform).
fn opencode_auth_path() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .ok()
            .or_else(|| dirs::home_dir().map(|p| p.join(".local").join("share")))
            .map(|p| p.join("opencode").join("auth.json"))
    }
    #[cfg(not(windows))]
    {
        dirs::home_dir().map(|p| {
            p.join(".local")
                .join("share")
                .join("opencode")
                .join("auth.json")
        })
    }
}

/// Read an agent's native configuration files from the filesystem.
#[tauri::command]
pub async fn read_agent_native_configs(
    state: tauri::State<'_, AppState>,
    agent_type: BaseCodingAgent,
) -> Result<AgentNativeConfigs, AppError> {
    let _ = state;

    match agent_type {
        BaseCodingAgent::Codex => {
            let home = codex_home();
            let home_str = home.as_ref().map(|p| p.display().to_string());

            let config_toml = match &home {
                Some(h) => {
                    let path = h.join("config.toml");
                    if path.exists() {
                        Some(fs::read_to_string(&path).await.map_err(|e| {
                            AppError::Internal(format!("Failed to read codex config.toml: {}", e))
                        })?)
                    } else {
                        None
                    }
                }
                None => None,
            };

            let auth_json = match &home {
                Some(h) => {
                    let path = h.join("auth.json");
                    if path.exists() {
                        Some(fs::read_to_string(&path).await.map_err(|e| {
                            AppError::Internal(format!("Failed to read codex auth.json: {}", e))
                        })?)
                    } else {
                        None
                    }
                }
                None => None,
            };

            Ok(AgentNativeConfigs {
                codex_config_toml: config_toml,
                codex_auth_json: auth_json,
                codex_home_path: home_str,
                opencode_config_json: None,
                opencode_auth_json: None,
                opencode_config_path: None,
            })
        }
        BaseCodingAgent::Opencode => {
            let config_dir = opencode_config_dir();
            let config_path_str = config_dir.as_ref().map(|p| p.display().to_string());

            let config_json = match &config_dir {
                Some(dir) => {
                    // Try opencode.json first, then opencode.jsonc
                    let json_path = dir.join("opencode.json");
                    let jsonc_path = dir.join("opencode.jsonc");
                    let path = if json_path.exists() {
                        Some(json_path)
                    } else if jsonc_path.exists() {
                        Some(jsonc_path)
                    } else {
                        None
                    };
                    match path {
                        Some(p) => Some(fs::read_to_string(&p).await.map_err(|e| {
                            AppError::Internal(format!("Failed to read opencode config: {}", e))
                        })?),
                        None => None,
                    }
                }
                None => None,
            };

            let auth_json = match opencode_auth_path() {
                Some(path) if path.exists() => {
                    Some(fs::read_to_string(&path).await.map_err(|e| {
                        AppError::Internal(format!("Failed to read opencode auth.json: {}", e))
                    })?)
                }
                _ => None,
            };

            Ok(AgentNativeConfigs {
                codex_config_toml: None,
                codex_auth_json: None,
                codex_home_path: None,
                opencode_config_json: config_json,
                opencode_auth_json: auth_json,
                opencode_config_path: config_path_str,
            })
        }
        BaseCodingAgent::ClaudeCode => {
            // Claude Code settings are already handled by get_claude_settings
            Ok(AgentNativeConfigs {
                codex_config_toml: None,
                codex_auth_json: None,
                codex_home_path: None,
                opencode_config_json: None,
                opencode_auth_json: None,
                opencode_config_path: None,
            })
        }
        #[allow(unreachable_patterns)]
        _ => Ok(AgentNativeConfigs {
            codex_config_toml: None,
            codex_auth_json: None,
            codex_home_path: None,
            opencode_config_json: None,
            opencode_auth_json: None,
            opencode_config_path: None,
        }),
    }
}

/// Write an agent's native configuration files to the filesystem.
#[tauri::command]
pub async fn write_agent_native_config(
    state: tauri::State<'_, AppState>,
    agent_type: BaseCodingAgent,
    codex_config_toml: Option<String>,
    codex_auth_json: Option<String>,
    opencode_config_json: Option<String>,
    opencode_auth_json: Option<String>,
) -> Result<(), AppError> {
    let _ = state;

    match agent_type {
        BaseCodingAgent::Codex => {
            let home = codex_home().ok_or_else(|| {
                AppError::Internal("Could not determine Codex home directory".to_string())
            })?;

            // Ensure directory exists
            fs::create_dir_all(&home).await.map_err(|e| {
                AppError::Internal(format!("Failed to create codex home directory: {}", e))
            })?;

            if let Some(toml_content) = codex_config_toml {
                fs::write(home.join("config.toml"), toml_content)
                    .await
                    .map_err(|e| {
                        AppError::Internal(format!("Failed to write codex config.toml: {}", e))
                    })?;
            }

            if let Some(auth_content) = codex_auth_json {
                fs::write(home.join("auth.json"), auth_content)
                    .await
                    .map_err(|e| {
                        AppError::Internal(format!("Failed to write codex auth.json: {}", e))
                    })?;
            }
        }
        BaseCodingAgent::Opencode => {
            if let Some(config_content) = opencode_config_json {
                let config_dir = opencode_config_dir().ok_or_else(|| {
                    AppError::Internal("Could not determine OpenCode config directory".to_string())
                })?;

                fs::create_dir_all(&config_dir).await.map_err(|e| {
                    AppError::Internal(format!("Failed to create opencode config directory: {}", e))
                })?;

                fs::write(config_dir.join("opencode.json"), config_content)
                    .await
                    .map_err(|e| {
                        AppError::Internal(format!("Failed to write opencode config: {}", e))
                    })?;
            }

            if let Some(auth_content) = opencode_auth_json {
                let auth_path = opencode_auth_path().ok_or_else(|| {
                    AppError::Internal("Could not determine OpenCode auth path".to_string())
                })?;

                if let Some(parent) = auth_path.parent() {
                    fs::create_dir_all(parent).await.map_err(|e| {
                        AppError::Internal(format!(
                            "Failed to create opencode auth directory: {}",
                            e
                        ))
                    })?;
                }

                fs::write(&auth_path, auth_content).await.map_err(|e| {
                    AppError::Internal(format!("Failed to write opencode auth.json: {}", e))
                })?;
            }
        }
        _ => {}
    }

    Ok(())
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
        let raw = "opencode/minimax-m2.5-free\nopencode/mimo-v2-pro-free\n";
        let models = super::parse_opencode_models(raw);
        assert_eq!(
            models,
            vec![
                "opencode/minimax-m2.5-free".to_string(),
                "opencode/mimo-v2-pro-free".to_string()
            ]
        );
    }

    #[test]
    #[ignore = "legacy assertions from previous fallback format"]
    fn builds_local_enhanced_prompt_with_context() {
        let payload = super::PromptEnhancementRequest {
            draft_prompt: "帮我写一个登录页面，需要有错误提示和表单校验".to_string(),
            session_id: None,
            workspace_id: None,
            context_messages: vec![
                super::PromptEnhancementContextMessage {
                    role: "user".to_string(),
                    content: "项目使用 React 和 Tailwind CSS".to_string(),
                    timestamp: None,
                },
                super::PromptEnhancementContextMessage {
                    role: "assistant".to_string(),
                    content: "当前页面风格偏简洁企业风".to_string(),
                    timestamp: None,
                },
            ],
        };

        let result = super::build_local_enhanced_prompt_v2(&payload);

        assert!(result.contains("任务目标"));
        assert!(result.contains("相关上下文"));
        assert!(result.contains("React 和 Tailwind"));
    }

    #[test]
    #[ignore = "legacy assertions from previous fallback format"]
    fn builds_local_enhanced_prompt_with_output_requirements() {
        let payload = super::PromptEnhancementRequest {
            draft_prompt: "生成接口文档，并以 JSON 格式返回字段定义".to_string(),
            session_id: None,
            workspace_id: None,
            context_messages: vec![],
        };

        let result = super::build_local_enhanced_prompt_v2(&payload);

        assert!(result.contains("输出要求"));
        assert!(result.contains("JSON"));
    }

    #[test]
    fn local_prompt_enhancer_v2_uses_compact_structure() {
        let payload = super::PromptEnhancementRequest {
            draft_prompt: "编写readme.md文档，并启动项目前端".to_string(),
            session_id: None,
            workspace_id: None,
            context_messages: vec![super::PromptEnhancementContextMessage {
                role: "assistant".to_string(),
                content: "这里是一大段历史总结，不应该被直接拼进结果".to_string(),
                timestamp: None,
            }],
        };

        let result = super::build_local_enhanced_prompt_v2(&payload);

        assert!(result.contains("任务"));
        assert!(result.contains("- 编写readme.md文档"));
        assert!(result.contains("README 内容应覆盖项目用途"));
        assert!(result.contains("启动后确认前端是否正常运行"));
        assert!(!result.contains("相关上下文"));
        assert!(!result.contains("这里是一大段历史总结"));
    }

    #[test]
    fn local_prompt_enhancer_v2_only_uses_context_for_contextual_prompts() {
        let payload = super::PromptEnhancementRequest {
            draft_prompt: "继续完善上文提到的登录页面".to_string(),
            session_id: None,
            workspace_id: None,
            context_messages: vec![super::PromptEnhancementContextMessage {
                role: "user".to_string(),
                content: "登录页面使用 React 和 Tailwind CSS".to_string(),
                timestamp: None,
            }],
        };

        let result = super::build_local_enhanced_prompt_v2(&payload);

        assert!(result.contains("必要时结合前文信息理解当前任务"));
        assert!(result.contains("React 和 Tailwind CSS"));
    }
}
