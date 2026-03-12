use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::sync::OnceLock;

use chrono::{DateTime, Utc};
use regex::Regex;

use crate::models::*;
use crate::parsers::{folder_name_from_path, truncate_str, AgentParser, ParseError};

/// Regex that matches Claude Code system-injected XML tags and their content.
/// These tags are internal metadata and should not be displayed to users.
/// Note: Rust regex doesn't support backreferences, so each tag is listed explicitly.
fn system_tag_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(concat!(
            r"(?s)",
            r"<system-reminder>.*?</system-reminder>",
            r"|<local-command-caveat>.*?</local-command-caveat>",
            r"|<command-name>.*?</command-name>",
            r"|<command-message>.*?</command-message>",
            r"|<command-args>.*?</command-args>",
            r"|<local-command-stdout>.*?</local-command-stdout>",
            r"|<user-prompt-submit-hook>.*?</user-prompt-submit-hook>",
        ))
        .unwrap()
    })
}

/// Regex that matches an optional model capacity suffix like `[1M]` / `[500k]`.
fn model_capacity_suffix_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\[\s*([0-9]+(?:\.[0-9]+)?)\s*([km])\s*\]\s*$")
            .expect("valid model capacity regex")
    })
}

/// Strip system-injected XML tags from text content.
/// Returns None if the text becomes empty after stripping.
fn strip_system_tags(text: &str) -> Option<String> {
    let cleaned = system_tag_regex().replace_all(text, "");
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Check if a JSONL entry is a system meta message (isMeta: true).
fn is_meta_message(value: &serde_json::Value) -> bool {
    value
        .get("isMeta")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

fn parse_model_capacity_suffix(model: &str) -> Option<u64> {
    let captures = model_capacity_suffix_regex().captures(model.trim())?;
    let value = captures.get(1)?.as_str().parse::<f64>().ok()?;
    if !value.is_finite() || value <= 0.0 {
        return None;
    }

    let unit = captures
        .get(2)
        .map(|m| m.as_str().to_ascii_lowercase())
        .unwrap_or_default();
    let multiplier = match unit.as_str() {
        "m" => 1_000_000.0,
        "k" => 1_000.0,
        _ => return None,
    };

    Some((value * multiplier) as u64)
}

fn claude_context_window_max_tokens_for_model(model: Option<&str>) -> Option<u64> {
    let model = model?.trim();
    if model.is_empty() {
        return None;
    }

    // If user/model config contains an explicit capacity suffix, prefer it.
    if let Some(suffixed_limit) = parse_model_capacity_suffix(model) {
        return Some(suffixed_limit);
    }

    // Claude models default to 200k when no explicit capacity is provided.
    if model.to_ascii_lowercase().starts_with("claude") {
        return Some(200_000);
    }

    None
}

fn claude_context_window_used_tokens_from_usage(usage: &TurnUsage) -> Option<u64> {
    let used_tokens = usage
        .input_tokens
        .saturating_add(usage.cache_creation_input_tokens)
        .saturating_add(usage.cache_read_input_tokens);
    if used_tokens > 0 {
        Some(used_tokens)
    } else {
        None
    }
}

fn latest_claude_context_window_used_tokens(turns: &[MessageTurn]) -> Option<u64> {
    turns.iter().rev().find_map(|turn| {
        turn.usage
            .as_ref()
            .and_then(claude_context_window_used_tokens_from_usage)
    })
}

fn merge_claude_context_window_stats(
    stats: Option<SessionStats>,
    used_tokens: Option<u64>,
    max_tokens: Option<u64>,
) -> Option<SessionStats> {
    if used_tokens.is_none() && max_tokens.is_none() {
        return stats;
    }

    let usage_percent = match (used_tokens, max_tokens) {
        (Some(used), Some(max)) if max > 0 => Some((used as f64 / max as f64) * 100.0),
        _ => None,
    };

    match stats {
        Some(mut s) => {
            s.context_window_used_tokens = used_tokens;
            s.context_window_max_tokens = max_tokens;
            s.context_window_usage_percent = usage_percent;
            Some(s)
        }
        None => Some(SessionStats {
            total_usage: None,
            total_tokens: None,
            total_duration_ms: 0,
            context_window_used_tokens: used_tokens,
            context_window_max_tokens: max_tokens,
            context_window_usage_percent: usage_percent,
        }),
    }
}

pub struct ClaudeParser {
    base_dir: PathBuf,
}

impl ClaudeParser {
    pub fn new() -> Self {
        let base_dir = resolve_claude_config_dir().join("projects");
        Self { base_dir }
    }

    fn decode_folder_path(encoded: &str) -> String {
        encoded.replace('-', "/")
    }

    fn parse_jsonl_summary(
        &self,
        path: &PathBuf,
    ) -> Result<Option<ConversationSummary>, ParseError> {
        let file = fs::File::open(path)?;
        let reader = BufReader::new(file);

        let mut conversation_id: Option<String> = None;
        let mut cwd: Option<String> = None;
        let mut git_branch: Option<String> = None;
        let mut model: Option<String> = None;
        let mut title: Option<String> = None;
        let mut first_timestamp: Option<DateTime<Utc>> = None;
        let mut last_timestamp: Option<DateTime<Utc>> = None;
        let mut message_count: u32 = 0;

        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => continue,
            };
            if line.trim().is_empty() {
                continue;
            }

            let value: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let msg_type = value.get("type").and_then(|t| t.as_str()).unwrap_or("");

            // Skip non-conversation entries
            if msg_type == "file-history-snapshot" || msg_type == "progress" {
                continue;
            }

            // Skip system meta messages (e.g. local-command-caveat injections)
            if is_meta_message(&value) {
                continue;
            }

            if conversation_id.is_none() {
                conversation_id = value
                    .get("sessionId")
                    .and_then(|s| s.as_str())
                    .map(|s| s.to_string());
            }

            if cwd.is_none() {
                cwd = value
                    .get("cwd")
                    .and_then(|s| s.as_str())
                    .map(|s| s.to_string());
            }

            if git_branch.is_none() {
                git_branch = value
                    .get("gitBranch")
                    .and_then(|s| s.as_str())
                    .map(|s| s.to_string());
            }

            if let Some(ts_str) = value.get("timestamp").and_then(|t| t.as_str()) {
                if let Ok(ts) = ts_str.parse::<DateTime<Utc>>() {
                    if first_timestamp.is_none() {
                        first_timestamp = Some(ts);
                    }
                    last_timestamp = Some(ts);
                }
            }

            if msg_type == "user" || msg_type == "assistant" {
                message_count += 1;

                // Extract model from assistant messages
                if msg_type == "assistant" && model.is_none() {
                    model = value
                        .get("message")
                        .and_then(|m| m.get("model"))
                        .and_then(|m| m.as_str())
                        .map(|s| s.to_string());
                }

                // Extract title from first user message
                if msg_type == "user" && title.is_none() {
                    title = extract_user_text(&value).map(|t| truncate_str(&t, 100));
                }
            }
        }

        let started_at = match first_timestamp {
            Some(ts) => ts,
            None => return Ok(None),
        };

        // Use filename (without .jsonl) as ID fallback
        let id = conversation_id.unwrap_or_else(|| {
            path.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string()
        });

        let folder_path = cwd.clone();
        let folder_name = folder_path.as_ref().map(|p| folder_name_from_path(p));

        Ok(Some(ConversationSummary {
            id,
            agent_type: AgentType::ClaudeCode,
            folder_path,
            folder_name,
            title,
            started_at,
            ended_at: last_timestamp,
            message_count,
            model,
            git_branch,
        }))
    }
}

fn resolve_claude_config_dir() -> PathBuf {
    resolve_claude_config_dir_from(std::env::var_os("CLAUDE_CONFIG_DIR"), dirs::home_dir())
}

fn resolve_claude_config_dir_from(
    claude_config_dir_env: Option<std::ffi::OsString>,
    home_dir: Option<PathBuf>,
) -> PathBuf {
    claude_config_dir_env
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir.unwrap_or_default().join(".claude"))
}

impl AgentParser for ClaudeParser {
    fn list_conversations(&self) -> Result<Vec<ConversationSummary>, ParseError> {
        let mut conversations = Vec::new();

        if !self.base_dir.exists() {
            return Ok(conversations);
        }

        let entries = fs::read_dir(&self.base_dir)?;
        for entry in entries {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let project_dir = entry.path();
            if !project_dir.is_dir() {
                continue;
            }

            let jsonl_files = fs::read_dir(&project_dir)?;
            for file_entry in jsonl_files {
                let file_entry = match file_entry {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                let file_path = file_entry.path();
                if file_path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }

                match self.parse_jsonl_summary(&file_path) {
                    Ok(Some(mut summary)) => {
                        // If folder_path is still None, derive from directory name
                        if summary.folder_path.is_none() {
                            let dir_name = project_dir
                                .file_name()
                                .unwrap_or_default()
                                .to_string_lossy()
                                .to_string();
                            let decoded = Self::decode_folder_path(&dir_name);
                            summary.folder_path = Some(decoded.clone());
                            summary.folder_name = Some(folder_name_from_path(&decoded));
                        }
                        conversations.push(summary);
                    }
                    Ok(None) => continue,
                    Err(_) => continue,
                }
            }
        }

        conversations.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        Ok(conversations)
    }

    fn get_conversation(&self, conversation_id: &str) -> Result<ConversationDetail, ParseError> {
        // Find the conversation file by searching all directories
        if !self.base_dir.exists() {
            return Err(ParseError::ConversationNotFound(
                conversation_id.to_string(),
            ));
        }

        for entry in fs::read_dir(&self.base_dir)? {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let project_dir = entry.path();
            if !project_dir.is_dir() {
                continue;
            }

            let file_path = project_dir.join(format!("{}.jsonl", conversation_id));
            if file_path.exists() {
                return self.parse_conversation_detail(&file_path, conversation_id);
            }
        }

        Err(ParseError::ConversationNotFound(
            conversation_id.to_string(),
        ))
    }
}

impl ClaudeParser {
    fn parse_conversation_detail(
        &self,
        path: &PathBuf,
        conversation_id: &str,
    ) -> Result<ConversationDetail, ParseError> {
        let file = fs::File::open(path)?;
        let reader = BufReader::new(file);

        let mut messages = Vec::new();
        let mut cwd: Option<String> = None;
        let mut git_branch: Option<String> = None;
        let mut model: Option<String> = None;
        let mut title: Option<String> = None;
        let mut first_timestamp: Option<DateTime<Utc>> = None;
        let mut last_timestamp: Option<DateTime<Utc>> = None;

        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => continue,
            };
            if line.trim().is_empty() {
                continue;
            }

            let value: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let msg_type = value.get("type").and_then(|t| t.as_str()).unwrap_or("");

            if msg_type == "file-history-snapshot" || msg_type == "progress" {
                continue;
            }

            // Skip system meta messages
            if is_meta_message(&value) {
                continue;
            }

            if cwd.is_none() {
                cwd = value
                    .get("cwd")
                    .and_then(|s| s.as_str())
                    .map(|s| s.to_string());
            }
            if git_branch.is_none() {
                git_branch = value
                    .get("gitBranch")
                    .and_then(|s| s.as_str())
                    .map(|s| s.to_string());
            }

            if let Some(ts_str) = value.get("timestamp").and_then(|t| t.as_str()) {
                if let Ok(ts) = ts_str.parse::<DateTime<Utc>>() {
                    if first_timestamp.is_none() {
                        first_timestamp = Some(ts);
                    }
                    last_timestamp = Some(ts);
                }
            }

            match msg_type {
                "user" => {
                    let content = extract_user_content(&value);

                    // Skip user messages that are empty after system tag stripping
                    if content.is_empty() {
                        continue;
                    }

                    let timestamp = parse_timestamp(&value).unwrap_or_else(Utc::now);
                    let uuid = value
                        .get("uuid")
                        .and_then(|u| u.as_str())
                        .unwrap_or("")
                        .to_string();

                    if title.is_none() {
                        if let Some(first_text) = content.iter().find_map(|c| match c {
                            ContentBlock::Text { text } => Some(text.clone()),
                            _ => None,
                        }) {
                            title = Some(truncate_str(&first_text, 100));
                        }
                    }

                    messages.push(UnifiedMessage {
                        id: uuid,
                        role: MessageRole::User,
                        content,
                        timestamp,
                        usage: None,
                        duration_ms: None,
                        model: None,
                    });
                }
                "assistant" => {
                    let timestamp = parse_timestamp(&value).unwrap_or_else(Utc::now);
                    let uuid = value
                        .get("uuid")
                        .and_then(|u| u.as_str())
                        .unwrap_or("")
                        .to_string();

                    let msg_model = value
                        .get("message")
                        .and_then(|m| m.get("model"))
                        .and_then(|m| m.as_str())
                        .map(|s| s.to_string());

                    if model.is_none() {
                        model = msg_model.clone();
                    }

                    let content = extract_assistant_content(&value);
                    let usage = extract_usage(&value);

                    messages.push(UnifiedMessage {
                        id: uuid,
                        role: MessageRole::Assistant,
                        content,
                        timestamp,
                        usage,
                        duration_ms: None,
                        model: msg_model,
                    });
                }
                "system" => {
                    let subtype = value.get("subtype").and_then(|s| s.as_str()).unwrap_or("");
                    if subtype == "turn_duration" {
                        if let Some(duration) = value.get("durationMs").and_then(|d| d.as_u64()) {
                            // Attach to the last assistant message
                            if let Some(last) = messages
                                .iter_mut()
                                .rev()
                                .find(|m| matches!(m.role, MessageRole::Assistant))
                            {
                                last.duration_ms = Some(duration);
                            }
                        }
                    }
                }
                _ => {}
            }
        }

        let folder_path = cwd.clone();
        let folder_name = folder_path.as_ref().map(|p| folder_name_from_path(p));

        let turns = group_into_turns(messages);
        let context_window_used_tokens = latest_claude_context_window_used_tokens(&turns);
        let context_window_max_tokens =
            claude_context_window_max_tokens_for_model(model.as_deref());
        let session_stats = merge_claude_context_window_stats(
            super::compute_session_stats(&turns),
            context_window_used_tokens,
            context_window_max_tokens,
        );

        let summary = ConversationSummary {
            id: conversation_id.to_string(),
            agent_type: AgentType::ClaudeCode,
            folder_path,
            folder_name,
            title,
            started_at: first_timestamp.unwrap_or_else(Utc::now),
            ended_at: last_timestamp,
            message_count: turns.len() as u32,
            model,
            git_branch,
        };

        Ok(ConversationDetail {
            summary,
            turns,
            session_stats,
        })
    }
}

fn parse_timestamp(value: &serde_json::Value) -> Option<DateTime<Utc>> {
    value
        .get("timestamp")
        .and_then(|t| t.as_str())
        .and_then(|s| s.parse::<DateTime<Utc>>().ok())
}

fn extract_user_text(value: &serde_json::Value) -> Option<String> {
    let message = value.get("message")?;
    let content = message.get("content")?;

    if let Some(text) = content.as_str() {
        return strip_system_tags(text);
    }

    if let Some(arr) = content.as_array() {
        for item in arr {
            if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                    if let Some(cleaned) = strip_system_tags(text) {
                        return Some(cleaned);
                    }
                }
            }
        }
    }

    None
}

fn extract_user_content(value: &serde_json::Value) -> Vec<ContentBlock> {
    let mut blocks = Vec::new();
    let message = match value.get("message") {
        Some(m) => m,
        None => return blocks,
    };
    let content = match message.get("content") {
        Some(c) => c,
        None => return blocks,
    };

    if let Some(text) = content.as_str() {
        if let Some(cleaned) = strip_system_tags(text) {
            blocks.push(ContentBlock::Text { text: cleaned });
        }
        return blocks;
    }

    if let Some(arr) = content.as_array() {
        for item in arr {
            let block_type = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match block_type {
                "text" => {
                    if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                        if let Some(cleaned) = strip_system_tags(text) {
                            blocks.push(ContentBlock::Text { text: cleaned });
                        }
                    }
                }
                "image" => {
                    if let Some(image_block) = extract_claude_user_image(item) {
                        blocks.push(image_block);
                    }
                }
                "tool_result" | "server_tool_result" => {
                    let tool_use_id = item
                        .get("tool_use_id")
                        .and_then(|n| n.as_str())
                        .map(|s| s.to_string());
                    let output = extract_tool_result_text(item);
                    let is_error = item
                        .get("is_error")
                        .and_then(|e| e.as_bool())
                        .unwrap_or(false);
                    blocks.push(ContentBlock::ToolResult {
                        tool_use_id,
                        output_preview: output,
                        is_error,
                    });
                }
                _ => {}
            }
        }
    }

    blocks
}

fn extract_claude_user_image(item: &serde_json::Value) -> Option<ContentBlock> {
    let source = item.get("source");
    let source_data = source
        .and_then(|s| s.get("data"))
        .and_then(|d| d.as_str())
        .or_else(|| item.get("data").and_then(|d| d.as_str()))
        .map(str::trim)
        .filter(|v| !v.is_empty())?;

    if let Some((mime_type, data)) = parse_data_uri_image(source_data) {
        return Some(ContentBlock::Image {
            data,
            mime_type,
            uri: None,
        });
    }

    let mime_type = source
        .and_then(|s| s.get("media_type"))
        .and_then(|m| m.as_str())
        .or_else(|| source.and_then(|s| s.get("mime_type")).and_then(|m| m.as_str()))
        .or_else(|| item.get("media_type").and_then(|m| m.as_str()))
        .or_else(|| item.get("mime_type").and_then(|m| m.as_str()))
        .map(str::trim)
        .filter(|m| !m.is_empty() && m.starts_with("image/"))?;

    let uri = source
        .and_then(|s| s.get("url"))
        .and_then(|u| u.as_str())
        .or_else(|| item.get("url").and_then(|u| u.as_str()))
        .map(|u| u.to_string());

    Some(ContentBlock::Image {
        data: source_data.to_string(),
        mime_type: mime_type.to_string(),
        uri,
    })
}

fn parse_data_uri_image(raw: &str) -> Option<(String, String)> {
    let trimmed = raw.trim();
    let without_prefix = trimmed.strip_prefix("data:")?;
    let marker = ";base64,";
    let marker_idx = without_prefix.find(marker)?;
    let mime_type = without_prefix.get(..marker_idx)?.trim();
    if !mime_type.starts_with("image/") {
        return None;
    }
    let data = without_prefix.get(marker_idx + marker.len()..)?.trim();
    if data.is_empty() {
        return None;
    }
    Some((mime_type.to_string(), data.to_string()))
}

fn extract_assistant_content(value: &serde_json::Value) -> Vec<ContentBlock> {
    let mut blocks = Vec::new();
    let message = match value.get("message") {
        Some(m) => m,
        None => return blocks,
    };
    let content = match message.get("content") {
        Some(c) => c,
        None => return blocks,
    };

    if let Some(arr) = content.as_array() {
        for item in arr {
            let block_type = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match block_type {
                "text" => {
                    if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                        blocks.push(ContentBlock::Text {
                            text: text.to_string(),
                        });
                    }
                }
                "thinking" => {
                    if let Some(text) = item.get("thinking").and_then(|t| t.as_str()) {
                        blocks.push(ContentBlock::Thinking {
                            text: text.to_string(),
                        });
                    }
                }
                "tool_use" | "server_tool_use" => {
                    let tool_use_id = item
                        .get("id")
                        .and_then(|n| n.as_str())
                        .map(|s| s.to_string());
                    let tool_name = item
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("unknown")
                        .to_string();
                    let input_preview = item.get("input").map(|i| i.to_string());
                    blocks.push(ContentBlock::ToolUse {
                        tool_use_id,
                        tool_name,
                        input_preview,
                    });
                }
                _ => {}
            }
        }
    }

    blocks
}

fn extract_usage(value: &serde_json::Value) -> Option<TurnUsage> {
    let usage = value.get("message")?.get("usage")?;
    Some(TurnUsage {
        input_tokens: usage
            .get("input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        output_tokens: usage
            .get("output_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        cache_creation_input_tokens: usage
            .get("cache_creation_input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        cache_read_input_tokens: usage
            .get("cache_read_input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
    })
}

fn extract_tool_result_text(item: &serde_json::Value) -> Option<String> {
    let content = item.get("content")?;
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    if let Some(arr) = content.as_array() {
        let texts: Vec<String> = arr
            .iter()
            .filter_map(|c| {
                if c.get("type").and_then(|t| t.as_str()) == Some("text") {
                    c.get("text")
                        .and_then(|t| t.as_str())
                        .map(|s| s.to_string())
                } else {
                    None
                }
            })
            .collect();
        if !texts.is_empty() {
            return Some(texts.join("\n"));
        }
    }
    None
}

/// Check if a user message contains ONLY tool_result blocks (no text).
/// In Claude Code, tool results come back as "user" messages.
fn is_tool_result_only(msg: &UnifiedMessage) -> bool {
    matches!(msg.role, MessageRole::User)
        && !msg.content.is_empty()
        && msg
            .content
            .iter()
            .all(|b| matches!(b, ContentBlock::ToolResult { .. }))
}

/// Group flat messages into conversation turns.
/// Claude Code rule: assistant msg + following tool-result-only user msgs
/// merge into one Assistant turn.
fn group_into_turns(messages: Vec<UnifiedMessage>) -> Vec<MessageTurn> {
    let mut turns = Vec::new();
    let mut i = 0;

    while i < messages.len() {
        let msg = &messages[i];

        if matches!(msg.role, MessageRole::Assistant) {
            let mut blocks: Vec<ContentBlock> = msg.content.clone();
            let timestamp = msg.timestamp;
            let id = format!("turn-{}", turns.len());
            let usage = msg.usage.clone();
            let duration_ms = msg.duration_ms;
            let turn_model = msg.model.clone();
            i += 1;

            // Absorb consecutive assistant msgs AND tool-result-only user msgs
            while i < messages.len()
                && (matches!(messages[i].role, MessageRole::Assistant)
                    || is_tool_result_only(&messages[i]))
            {
                blocks.extend(messages[i].content.clone());
                i += 1;
            }

            turns.push(MessageTurn {
                id,
                role: TurnRole::Assistant,
                blocks,
                timestamp,
                usage,
                duration_ms,
                model: turn_model,
            });
        } else if matches!(msg.role, MessageRole::System) {
            turns.push(MessageTurn {
                id: format!("turn-{}", turns.len()),
                role: TurnRole::System,
                blocks: msg.content.clone(),
                timestamp: msg.timestamp,
                usage: None,
                duration_ms: None,
                model: None,
            });
            i += 1;
        } else {
            turns.push(MessageTurn {
                id: format!("turn-{}", turns.len()),
                role: TurnRole::User,
                blocks: msg.content.clone(),
                timestamp: msg.timestamp,
                usage: None,
                duration_ms: None,
                model: None,
            });
            i += 1;
        }
    }

    turns
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;
    use serde_json::json;

    #[test]
    fn parses_model_capacity_suffix() {
        assert_eq!(
            parse_model_capacity_suffix("claude-sonnet-4-6[1.5M]"),
            Some(1_500_000)
        );
        assert_eq!(
            parse_model_capacity_suffix("claude-opus-4-6 [500k]"),
            Some(500_000)
        );
        assert_eq!(parse_model_capacity_suffix("claude-sonnet-4-6"), None);
    }

    #[test]
    fn defaults_context_limit_for_claude_models() {
        assert_eq!(
            claude_context_window_max_tokens_for_model(Some("claude-sonnet-4-6")),
            Some(200_000)
        );
        assert_eq!(
            claude_context_window_max_tokens_for_model(Some("custom-model-x")),
            None
        );
    }

    #[test]
    fn uses_latest_assistant_usage_for_context_tokens() {
        let timestamp = Utc::now();
        let turns = vec![
            MessageTurn {
                id: "turn-0".to_string(),
                role: TurnRole::Assistant,
                blocks: vec![],
                timestamp,
                usage: Some(TurnUsage {
                    input_tokens: 100,
                    output_tokens: 20,
                    cache_creation_input_tokens: 30,
                    cache_read_input_tokens: 40,
                }),
                duration_ms: None,
                model: None,
            },
            MessageTurn {
                id: "turn-1".to_string(),
                role: TurnRole::Assistant,
                blocks: vec![],
                timestamp,
                usage: Some(TurnUsage {
                    input_tokens: 250,
                    output_tokens: 60,
                    cache_creation_input_tokens: 70,
                    cache_read_input_tokens: 80,
                }),
                duration_ms: None,
                model: None,
            },
        ];

        assert_eq!(
            latest_claude_context_window_used_tokens(&turns),
            Some(250 + 70 + 80)
        );
    }

    #[test]
    fn parse_detail_sets_claude_context_window_stats() {
        let path = std::env::temp_dir().join(format!(
            "codeg-claude-parser-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        let mut file = fs::File::create(&path).expect("create temp jsonl");
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "user",
                "sessionId": "session-test",
                "timestamp": "2026-03-01T10:00:00Z",
                "uuid": "u1",
                "cwd": "/tmp/demo",
                "gitBranch": "main",
                "message": {
                    "content": [{"type": "text", "text": "hello"}]
                }
            })
        )
        .expect("write user line");
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "assistant",
                "sessionId": "session-test",
                "timestamp": "2026-03-01T10:00:02Z",
                "uuid": "a1",
                "message": {
                    "model": "claude-sonnet-4-6",
                    "content": [{"type": "text", "text": "world"}],
                    "usage": {
                        "input_tokens": 1000,
                        "output_tokens": 200,
                        "cache_creation_input_tokens": 300,
                        "cache_read_input_tokens": 400
                    }
                }
            })
        )
        .expect("write assistant line");

        let parser = ClaudeParser {
            base_dir: PathBuf::new(),
        };
        let detail = parser
            .parse_conversation_detail(&path, "session-test")
            .expect("parse conversation detail");
        fs::remove_file(&path).expect("cleanup temp jsonl");

        let stats = detail.session_stats.expect("session stats");
        assert_eq!(stats.context_window_used_tokens, Some(1700));
        assert_eq!(stats.context_window_max_tokens, Some(200_000));
        let percent = stats
            .context_window_usage_percent
            .expect("context window usage percent");
        assert!((percent - 0.85).abs() < f64::EPSILON);
    }

    #[test]
    fn claude_config_dir_env_overrides_home() {
        let resolved = resolve_claude_config_dir_from(
            Some(std::ffi::OsString::from("/tmp/claude-config")),
            Some(PathBuf::from("/Users/default")),
        );
        assert_eq!(resolved, PathBuf::from("/tmp/claude-config"));
    }

    #[test]
    fn claude_config_dir_defaults_to_home_dot_claude() {
        let resolved = resolve_claude_config_dir_from(None, Some(PathBuf::from("/Users/default")));
        assert_eq!(resolved, PathBuf::from("/Users/default/.claude"));
    }

    #[test]
    fn extract_user_content_parses_claude_base64_image_block() {
        let value = json!({
            "message": {
                "content": [
                    {"type": "text", "text": "这个图片里面是什么"},
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/jpeg",
                            "data": "QUJDREVGRw=="
                        }
                    }
                ]
            }
        });

        let blocks = extract_user_content(&value);
        assert_eq!(blocks.len(), 2);
        assert!(matches!(&blocks[0], ContentBlock::Text { text } if text == "这个图片里面是什么"));
        assert!(matches!(
            &blocks[1],
            ContentBlock::Image { data, mime_type, uri }
            if data == "QUJDREVGRw==" && mime_type == "image/jpeg" && uri.is_none()
        ));
    }

    #[test]
    fn extract_user_content_parses_claude_data_uri_image_block() {
        let value = json!({
            "message": {
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "data": "data:image/png;base64,QUJD"
                        }
                    }
                ]
            }
        });

        let blocks = extract_user_content(&value);
        assert_eq!(blocks.len(), 1);
        assert!(matches!(
            &blocks[0],
            ContentBlock::Image { data, mime_type, uri }
            if data == "QUJD" && mime_type == "image/png" && uri.is_none()
        ));
    }
}
