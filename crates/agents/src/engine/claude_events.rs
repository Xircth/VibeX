//! Event normalization, payload serialization, model catalog parsing, and runtime/script
//! resolution helpers for [`super::claude::ClaudeNativeDriver`].

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
    time::Duration,
};

use chrono::{DateTime, Utc};
use serde_json::{Map, Value, json};

use crate::{
    conversation::ContentBlock,
    engine::{
        EngineAuth, EngineCacheStatus, EngineCapabilities, EngineCommandSpec, EngineEffortSpec,
        EngineError, EngineEvent, EngineModeSpec, EngineModelInfo, EnginePlanEntry,
        EngineRateLimits, EngineSelectChoice, EngineStartSpec, EngineToolClassification,
        PromptMode, classify_standard_tool_call, is_placeholder_engine_session_id,
    },
    managed_toolchain::{
        default_managed_artifacts_dir, ensure_managed_node, managed_node_runtime,
    },
    permissions::{AgentPermissionOption, AgentPermissionOptionKind},
};

pub(super) fn str_opt(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

pub(super) fn str_or(value: &Value, key: &str, default: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or(default)
        .to_string()
}

pub(super) fn parse_rfc3339_utc(value: &Value, key: &str) -> Option<DateTime<Utc>> {
    value
        .get(key)
        .and_then(Value::as_str)
        .and_then(|iso| DateTime::parse_from_rfc3339(iso).ok())
        .map(|dt| dt.with_timezone(&Utc))
}

pub(super) fn default_claude_permission_options() -> Vec<AgentPermissionOption> {
    vec![
        AgentPermissionOption {
            id: "allow_once".to_string(),
            label: "Allow Once".to_string(),
            kind: AgentPermissionOptionKind::AllowOnce,
            description: None,
        },
        AgentPermissionOption {
            id: "allow_always".to_string(),
            label: "Always Allow".to_string(),
            kind: AgentPermissionOptionKind::AllowAlways,
            description: None,
        },
        AgentPermissionOption {
            id: "reject_once".to_string(),
            label: "Reject".to_string(),
            kind: AgentPermissionOptionKind::RejectOnce,
            description: None,
        },
    ]
}

pub fn default_claude_models() -> Vec<EngineModelInfo> {
    vec![
        EngineModelInfo {
            id: "claude-sonnet-4-6".to_string(),
            label: "Claude Sonnet 4.6".to_string(),
            description: Some("Balanced coding and reasoning".to_string()),
            is_default: false,
        },
        EngineModelInfo {
            id: "claude-opus-4-7".to_string(),
            label: "Claude Opus 4.7".to_string(),
            description: Some("Deepest architecture and analysis".to_string()),
            is_default: false,
        },
        EngineModelInfo {
            id: "claude-haiku-4-5".to_string(),
            label: "Claude Haiku 4.5".to_string(),
            description: Some("Fast lightweight execution".to_string()),
            is_default: false,
        },
        EngineModelInfo {
            id: "sonnet".to_string(),
            label: "Sonnet (Latest Alias)".to_string(),
            description: None,
            is_default: false,
        },
        EngineModelInfo {
            id: "opus".to_string(),
            label: "Opus (Latest Alias)".to_string(),
            description: None,
            is_default: false,
        },
        EngineModelInfo {
            id: "haiku".to_string(),
            label: "Haiku (Latest Alias)".to_string(),
            description: None,
            is_default: false,
        },
    ]
}

pub(super) fn parse_sidecar_models(raw: Option<&Value>) -> Vec<EngineModelInfo> {
    let Some(items) = raw.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in items {
        let id = item
            .get("value")
            .or_else(|| item.get("id"))
            .or_else(|| item.get("model"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let Some(id) = id else { continue };
        if out.iter().any(|existing: &EngineModelInfo| existing.id == id) {
            continue;
        }
        let label = item
            .get("displayName")
            .or_else(|| item.get("label"))
            .or_else(|| item.get("name"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(id)
            .to_string();
        let description = item
            .get("description")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let is_default = item
            .get("isDefault")
            .or_else(|| item.get("is_default"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        out.push(EngineModelInfo {
            id: id.to_string(),
            label,
            description,
            is_default,
        });
    }
    out
}

fn parse_string_vec(value: Option<&Value>) -> Vec<String> {
    let Some(items) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            item.as_str()
                .or_else(|| item.get("name").and_then(Value::as_str))
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.trim_start_matches('/').to_string())
        })
        .collect()
}

fn parse_plan_entries(value: Option<&Value>) -> Vec<EnginePlanEntry> {
    let Some(items) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|entry| {
            let content = entry
                .get("content")
                .or_else(|| entry.get("step"))
                .or_else(|| entry.get("text"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())?
                .to_string();
            let status = entry
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("pending")
                .to_string();
            let priority = str_opt(entry, "priority");
            Some(EnginePlanEntry {
                content,
                status,
                priority,
            })
        })
        .collect()
}

pub(super) fn normalize_sidecar_event(
    event: &Value,
    latest_rate_limits: &Arc<RwLock<Option<EngineRateLimits>>>,
    latest_cache_status: &Arc<RwLock<Option<EngineCacheStatus>>>,
    is_official_session: bool,
) -> Option<EngineEvent> {
    let kind = event.get("kind").and_then(Value::as_str)?;
    let session_id = str_opt(event, "sessionId").filter(|sid| !is_placeholder_engine_session_id(sid));
    let prompt_id = str_opt(event, "promptId");

    match kind {
        "session_initialized" => Some(EngineEvent::SessionInitialized {
            session_id,
            model: str_opt(event, "model"),
            slash_commands: parse_string_vec(
                event
                    .get("slashCommands")
                    .or_else(|| event.get("slash_commands")),
            ),
        }),
        "turn_started" => Some(EngineEvent::TurnStarted {
            prompt_id: prompt_id.clone(),
            turn_id: prompt_id,
            session_id,
        }),
        "assistant_text_delta" => Some(EngineEvent::AssistantTextDelta {
            prompt_id,
            session_id,
            message_id: str_opt(event, "messageId"),
            text: str_or(event, "text", ""),
        }),
        "thinking_delta" => Some(EngineEvent::ThinkingDelta {
            prompt_id,
            session_id,
            message_id: str_opt(event, "messageId"),
            thinking: str_or(event, "thinking", ""),
        }),
        "assistant_message" => Some(EngineEvent::AssistantMessage {
            prompt_id,
            session_id,
            message_id: str_opt(event, "uuid").or_else(|| str_opt(event, "messageId")),
            text: str_or(event, "text", ""),
        }),
        "tool_call" => Some(EngineEvent::ToolCall {
            prompt_id,
            session_id,
            parent_tool_use_id: str_opt(event, "parentToolUseId"),
            tool_use_id: str_opt(event, "toolUseId"),
            tool_name: str_or(event, "toolName", "unknown"),
            input: event.get("input").cloned().unwrap_or_else(|| json!({})),
        }),
        "tool_result" => Some(EngineEvent::ToolResult {
            prompt_id,
            session_id,
            parent_tool_use_id: str_opt(event, "parentToolUseId"),
            tool_use_id: str_opt(event, "toolUseId"),
            is_error: event
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            content: event.get("content").cloned().unwrap_or(Value::Null),
        }),
        "permission_requested" => Some(EngineEvent::PermissionRequested {
            permission_id: str_or(event, "permissionId", ""),
            prompt_id,
            session_id,
            tool_name: str_or(event, "toolName", "unknown"),
            input: event.get("input").cloned().unwrap_or_else(|| json!({})),
            decision_reason: str_opt(event, "decisionReason"),
            options: default_claude_permission_options(),
        }),
        "permission_resolved" => Some(EngineEvent::PermissionResolved {
            permission_id: str_or(event, "permissionId", ""),
            prompt_id,
            session_id,
            behavior: str_or(event, "behavior", "deny"),
        }),
        "question_requested" => Some(EngineEvent::QuestionRequested {
            request_id: str_or(event, "requestId", ""),
            prompt_id,
            session_id,
            tool_call_id: str_opt(event, "toolCallId"),
            questions: event.get("questions").cloned().unwrap_or_else(|| json!([])),
        }),
        "plan_updated" => {
            let entries = parse_plan_entries(event.get("entries"));
            (!entries.is_empty()).then_some(EngineEvent::PlanUpdated {
                prompt_id,
                session_id,
                entries,
            })
        }
        "usage_updated" => {
            let raw = event.get("usage").unwrap_or(event);
            Some(EngineEvent::UsageUpdated {
                prompt_id,
                session_id,
                input_tokens: raw.get("inputTokens").and_then(Value::as_u64),
                output_tokens: raw.get("outputTokens").and_then(Value::as_u64),
                cache_read_tokens: raw.get("cacheReadInputTokens").and_then(Value::as_u64),
                cache_write_tokens: raw.get("cacheCreationInputTokens").and_then(Value::as_u64),
                cost_usd: raw.get("totalCostUsd").and_then(Value::as_f64),
                context_window: raw.get("contextWindow").and_then(Value::as_u64),
                model: str_opt(raw, "model"),
            })
        }
        "subagent/spawn" => Some(EngineEvent::SubagentSpawned {
            prompt_id,
            session_id,
            subagent_id: str_or(event, "subagentId", "subagent"),
            parent_tool_use_id: str_opt(event, "parentToolUseId"),
            subagent_type: str_opt(event, "subagentType"),
            description: str_opt(event, "description"),
        }),
        "subagent/update" => Some(EngineEvent::SubagentUpdated {
            prompt_id,
            session_id,
            subagent_id: str_or(event, "subagentId", "subagent"),
            text_delta: str_opt(event, "textDelta").unwrap_or_else(|| str_or(event, "text", "")),
        }),
        "subagent/complete" => Some(EngineEvent::SubagentCompleted {
            prompt_id,
            session_id,
            subagent_id: str_or(event, "subagentId", "subagent"),
            status: str_or(event, "status", "completed"),
            summary: str_opt(event, "summary"),
        }),
        "hook_event" => Some(EngineEvent::HookEvent {
            prompt_id,
            session_id,
            hook_name: str_or(event, "hookName", "unknown"),
            payload: event.get("payload").cloned().unwrap_or_else(|| json!({})),
        }),
        "prompt_steered" => Some(EngineEvent::PromptSteered {
            prompt_id,
            session_id,
        }),
        "rate_limits_updated" => {
            let raw = event.get("rateLimits")?;
            let limits = EngineRateLimits {
                requests_remaining: raw.get("requestsRemaining").and_then(Value::as_i64),
                tokens_remaining: raw.get("tokensRemaining").and_then(Value::as_i64),
                reset_at: parse_rfc3339_utc(raw, "resetAt"),
                credits_remaining: raw.get("creditsRemaining").and_then(Value::as_f64),
                plan_type: str_opt(raw, "rateLimitType"),
                utilization: raw.get("utilization").and_then(Value::as_f64),
            };
            if let Ok(mut guard) = latest_rate_limits.write() {
                *guard = Some(limits.clone());
            }
            Some(EngineEvent::RateLimitsUpdated {
                session_id,
                rate_limits: limits,
            })
        }
        "cache_status_updated" => {
            if !is_official_session {
                return None;
            }
            let raw = event.get("cacheStatus")?;
            let cache_status = EngineCacheStatus {
                prompt_cache_ttl_remaining: raw
                    .get("promptCacheTtlRemainingMs")
                    .and_then(Value::as_u64)
                    .map(Duration::from_millis),
                prompt_cache_expires_at: parse_rfc3339_utc(raw, "promptCacheExpiresAt"),
                cache_creation_input_tokens: None,
                cache_read_input_tokens: None,
                cache_ttl_tier: str_opt(raw, "cacheTtlTier"),
            };
            if let Ok(mut guard) = latest_cache_status.write() {
                *guard = Some(cache_status.clone());
            }
            Some(EngineEvent::CacheStatusUpdated {
                session_id,
                cache_status,
            })
        }
        "session_forked" => Some(EngineEvent::SessionForked {
            source_session_id: str_or(event, "sourceSessionId", ""),
            session_id: session_id.unwrap_or_default(),
            checkpoint_point: str_opt(event, "resumeSessionAt"),
        }),
        "session_reverted" => Some(EngineEvent::SessionReverted {
            session_id: session_id.unwrap_or_default(),
            checkpoint_point: str_opt(event, "resumeSessionAt"),
        }),
        "turn_completed" => Some(EngineEvent::TurnCompleted {
            prompt_id,
            turn_id: str_opt(event, "uuid"),
            session_id,
            stop_reason: str_opt(event, "stopReason"),
            served_model: str_opt(event, "served_model")
                .or_else(|| str_opt(event, "servedModel"))
                .or_else(|| str_opt(event, "model")),
        }),
        "turn_interrupted" => Some(EngineEvent::TurnInterrupted {
            prompt_id,
            session_id,
            reason: str_or(event, "reason", "user_interrupted"),
        }),
        "turn_error" => Some(EngineEvent::TurnError {
            prompt_id,
            session_id,
            message: str_or(event, "message", "Claude native turn error"),
        }),
        _ => None,
    }
}

pub(super) fn serialize_sidecar_blocks(
    blocks: &[ContentBlock],
    mode: PromptMode,
) -> (Option<String>, Vec<Value>) {
    if mode == PromptMode::Compact {
        return (
            Some("/compact".to_string()),
            vec![json!({ "type": "text", "text": "/compact" })],
        );
    }

    let mut out = Vec::new();
    let single_text = if blocks.len() == 1
        && let ContentBlock::Text { text } = &blocks[0]
    {
        Some(text.clone())
    } else {
        None
    };

    for block in blocks {
        match block {
            ContentBlock::Text { text } => out.push(json!({ "type": "text", "text": text })),
            ContentBlock::Image {
                data,
                mime_type,
                uri,
                ..
            } => out.push(json!({
                "type": "image",
                "data": data,
                "mimeType": mime_type,
                "uri": uri,
            })),
            ContentBlock::Resource { uri, title } => out.push(json!({
                "type": "resource_link",
                "uri": uri,
                "name": title,
            })),
            _ => {}
        }
    }

    if out.is_empty() {
        out.push(json!({ "type": "text", "text": "" }));
    }
    (single_text, out)
}

/// Resolves `scripts/claude-native-driver.mjs` strictly from trusted host/bundle locations.
/// Never searches `spec.working_dir` so untrusted workspace repositories cannot hijack execution.
pub fn resolve_claude_driver_script(spec: &EngineStartSpec) -> Result<PathBuf, EngineError> {
    let mut candidates = Vec::new();
    if let Some(explicit) = spec
        .env
        .get("DIMO_CLAUDE_DRIVER_SCRIPT")
        .map(String::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        candidates.push(PathBuf::from(explicit));
    }
    if let Some(env_script) = std::env::var_os("DIMO_CLAUDE_DRIVER_SCRIPT")
        .filter(|s| !s.is_empty())
    {
        candidates.push(PathBuf::from(env_script));
    }

    #[cfg(debug_assertions)]
    candidates.push(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/claude-native-driver.mjs"),
    );

    if let Ok(exe) = std::env::current_exe()
        && let Some(exe_dir) = exe.parent()
    {
        candidates.push(exe_dir.join("scripts/claude-native-driver.mjs"));
        candidates.push(exe_dir.join("resources/scripts/claude-native-driver.mjs"));
        candidates.push(exe_dir.join("_up_/scripts/claude-native-driver.mjs"));
        candidates.push(exe_dir.join("../Resources/scripts/claude-native-driver.mjs"));
        candidates.push(exe_dir.join("../Resources/_up_/scripts/claude-native-driver.mjs"));
    }

    #[cfg(not(debug_assertions))]
    candidates.push(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/claude-native-driver.mjs"),
    );

    candidates.into_iter().find(|p| p.is_file()).ok_or_else(|| {
        EngineError::BinaryNotFound("scripts/claude-native-driver.mjs not found".to_string())
    })
}

fn find_node_in_path_list(path_value: &str) -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["node.exe", "node.cmd"]
    } else {
        &["node"]
    };
    for dir in std::env::split_paths(path_value) {
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Resolves a usable Node.js executable for hosting `claude-native-driver.mjs`, checking:
/// 1) Explicit `DIMO_NODE_EXECUTABLE` / `DIMO_NODE_PATH` overrides,
/// 2) Pre-extracted Dimo managed Node (`default_managed_artifacts_dir`, `~/.dimo`, `%LOCALAPPDATA%/dimo`),
/// 3) `spec.env["PATH"]`, system `PATH`, and standard GUI-launch user Node directories,
/// 4) On-demand `ensure_managed_node(None)` download/extraction fallback.
pub async fn resolve_node_executable(spec: &EngineStartSpec) -> Result<PathBuf, EngineError> {
    for key in ["DIMO_NODE_EXECUTABLE", "DIMO_NODE_PATH"] {
        if let Some(val) = spec.env.get(key).map(String::as_str).map(str::trim)
            && !val.is_empty()
        {
            let p = PathBuf::from(val);
            if p.is_file() {
                return Ok(p);
            }
        }
        if let Some(val) = std::env::var_os(key).filter(|s| !s.is_empty()) {
            let p = PathBuf::from(val);
            if p.is_file() {
                return Ok(p);
            }
        }
    }

    let mut managed_roots = Vec::new();
    if let Some(default_dir) = default_managed_artifacts_dir() {
        managed_roots.push(default_dir);
    }
    let home = spec
        .env
        .get("USERPROFILE")
        .or_else(|| spec.env.get("HOME"))
        .cloned()
        .or_else(|| std::env::var("USERPROFILE").ok())
        .or_else(|| std::env::var("HOME").ok());
    if let Some(ref home_dir) = home {
        managed_roots.push(PathBuf::from(home_dir).join(".dimo"));
    }
    if let Some(local_app_data) = spec
        .env
        .get("LOCALAPPDATA")
        .cloned()
        .or_else(|| std::env::var("LOCALAPPDATA").ok())
    {
        managed_roots.push(PathBuf::from(&local_app_data).join("dimo"));
    }
    for root in managed_roots {
        if let Some(rt) = managed_node_runtime(&root)
            && rt.node.is_file()
        {
            return Ok(rt.node);
        }
    }

    if let Some(spec_path) = spec.env.get("PATH").or_else(|| spec.env.get("Path"))
        && let Some(found) = find_node_in_path_list(spec_path)
    {
        return Ok(found);
    }
    if let Some(sys_path) = std::env::var_os("PATH").or_else(|| std::env::var_os("Path"))
        && let Some(found) = find_node_in_path_list(&sys_path.to_string_lossy())
    {
        return Ok(found);
    }

    let node_bin = if cfg!(windows) { "node.exe" } else { "node" };
    let mut user_candidates = Vec::new();
    if cfg!(windows) {
        if let Ok(pf) = std::env::var("ProgramFiles") {
            user_candidates.push(PathBuf::from(pf).join("nodejs").join(node_bin));
        }
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            user_candidates.push(PathBuf::from(&local).join("Programs/nodejs").join(node_bin));
            user_candidates.push(PathBuf::from(&local).join("Volta/bin").join(node_bin));
        }
    } else {
        user_candidates.push(PathBuf::from("/opt/homebrew/bin/node"));
        user_candidates.push(PathBuf::from("/usr/local/bin/node"));
        user_candidates.push(PathBuf::from("/usr/bin/node"));
    }
    if let Some(ref home_dir) = home {
        let h = PathBuf::from(home_dir);
        user_candidates.push(h.join(".volta/bin").join(node_bin));
        user_candidates.push(h.join(".local/bin").join(node_bin));
    }
    if let Some(found) = user_candidates.into_iter().find(|p| p.is_file()) {
        return Ok(found);
    }

    Ok(ensure_managed_node(None).await?)
}

pub(super) fn claude_capabilities(engine_id: &str) -> EngineCapabilities {
    EngineCapabilities {
        engine_id: engine_id.to_string(),
        supports_native_steer: true,
        supports_native_revert: true,
        supports_native_fork: true,
        supports_rate_limit_push: true,
        supports_prompt_cache_ttl: true,
        records_idle_compaction_activity: true,
        modes: EngineModeSpec {
            modes: vec![
                EngineSelectChoice {
                    id: "default".to_string(),
                    label: "Default".to_string(),
                    description: Some("Prompt before sensitive tool actions".to_string()),
                },
                EngineSelectChoice {
                    id: "acceptEdits".to_string(),
                    label: "Accept Edits".to_string(),
                    description: Some("Auto-approve workspace file edits".to_string()),
                },
                EngineSelectChoice {
                    id: "plan".to_string(),
                    label: "Plan".to_string(),
                    description: Some(
                        "Read-only analysis and planning without mutating files".to_string(),
                    ),
                },
                EngineSelectChoice {
                    id: "auto".to_string(),
                    label: "Auto".to_string(),
                    description: Some("Automatically decide safe tool permissions".to_string()),
                },
                EngineSelectChoice {
                    id: "bypassPermissions".to_string(),
                    label: "Bypass Permissions".to_string(),
                    description: Some("Execute tools without permission prompts".to_string()),
                },
            ],
            default_mode_id: "default".to_string(),
            yolo_mode_id: "bypassPermissions".to_string(),
        },
        effort: Some(EngineEffortSpec {
            choices: vec![
                EngineSelectChoice {
                    id: "low".to_string(),
                    label: "Low".to_string(),
                    description: None,
                },
                EngineSelectChoice {
                    id: "medium".to_string(),
                    label: "Medium".to_string(),
                    description: None,
                },
                EngineSelectChoice {
                    id: "high".to_string(),
                    label: "High".to_string(),
                    description: None,
                },
                EngineSelectChoice {
                    id: "xhigh".to_string(),
                    label: "Extra High".to_string(),
                    description: None,
                },
                EngineSelectChoice {
                    id: "max".to_string(),
                    label: "Max".to_string(),
                    description: None,
                },
            ],
            default_value: "high".to_string(),
        }),
        default_commands: vec![
            EngineCommandSpec {
                name: "compact".to_string(),
                description: "Compact conversation context".to_string(),
            },
            EngineCommandSpec {
                name: "clear".to_string(),
                description: "Clear active session context".to_string(),
            },
            EngineCommandSpec {
                name: "review".to_string(),
                description: "Review current workspace changes".to_string(),
            },
            EngineCommandSpec {
                name: "init".to_string(),
                description: "Initialize project instructions".to_string(),
            },
        ],
    }
}

pub(super) fn claude_normalize_mode(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    match trimmed {
        "yolo" | "full-access" | "bypassPermissions" => Some("bypassPermissions".to_string()),
        "default" | "acceptEdits" | "plan" | "auto" => Some(trimmed.to_string()),
        _ => None,
    }
}

pub(super) fn resolve_claude_auth(env: &HashMap<String, String>) -> EngineAuth {
    if let Some(api_key) = env
        .get("ANTHROPIC_API_KEY")
        .or_else(|| env.get("ANTHROPIC_AUTH_TOKEN"))
        .filter(|v| !v.trim().is_empty())
    {
        return EngineAuth::ApiKey {
            api_key: api_key.clone(),
            base_url: env
                .get("ANTHROPIC_BASE_URL")
                .filter(|u| !u.trim().is_empty())
                .cloned(),
        };
    }
    if let Some(oauth_token) = env
        .get("CLAUDE_CODE_OAUTH_TOKEN")
        .filter(|v| !v.trim().is_empty())
    {
        return EngineAuth::OAuth {
            oauth_token: Some(oauth_token.clone()),
            account_email: None,
        };
    }
    EngineAuth::Ambient
}

pub(super) fn prepare_claude_launch_env(
    locked_program: &Path,
    launch_env: &mut HashMap<String, String>,
) {
    if locked_program.is_absolute()
        && locked_program.is_file()
        && locked_program
            .file_stem()
            .and_then(|s| s.to_str())
            .is_some_and(|stem| stem.eq_ignore_ascii_case("claude"))
        && !launch_env.contains_key("CLAUDE_CODE_EXECUTABLE")
        && !launch_env.contains_key("DIMO_CLAUDE_PATH")
        && let Some(spawnable) =
            workspace_utils::process::node_spawnable_runtime_path(locked_program)
    {
        launch_env.insert(
            "CLAUDE_CODE_EXECUTABLE".to_string(),
            spawnable.to_string_lossy().into_owned(),
        );
    }
}

pub(super) fn resolve_claude_default_model(env: &HashMap<String, String>) -> Option<String> {
    let effective = crate::end_turn_usage::read_claude_settings_env(env);
    effective
        .get("ANTHROPIC_MODEL")
        .map(String::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

pub(super) fn claude_accepts_model_id(model_id: &str, env: &HashMap<String, String>) -> bool {
    if !EngineAuth::Ambient.is_official_anthropic_session(env, &serde_json::Value::Null) {
        return true;
    }
    let lower = model_id.trim().to_ascii_lowercase();
    !lower.is_empty()
        && !lower.starts_with("gpt-")
        && !lower.starts_with("codex-")
        && !lower.starts_with("gemini-")
}

pub(super) fn classify_claude_tool_call(
    raw_name: &str,
    input: &Value,
    parent_tool_use_id: Option<&str>,
) -> EngineToolClassification {
    let mut base = classify_standard_tool_call(raw_name, input);
    if raw_name.starts_with("mcp__") {
        return base;
    }
    let mut claude_meta = Map::new();
    claude_meta.insert("toolName".to_string(), Value::String(raw_name.to_string()));
    if let Some(parent_id) = parent_tool_use_id
        .filter(|s| !s.is_empty())
        .or_else(|| {
            input
                .get("_parentToolUseId")
                .or_else(|| input.get("parent_tool_use_id"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
        })
    {
        claude_meta.insert(
            "parentToolUseId".to_string(),
            Value::String(parent_id.to_string()),
        );
    }
    let mut meta = match base.meta {
        Some(Value::Object(existing)) => existing,
        _ => Map::new(),
    };
    meta.insert("claudeCode".to_string(), Value::Object(claude_meta));
    base.meta = Some(Value::Object(meta));
    base
}

pub(super) fn encode_claude_question_answers(
    entries: &[(String, Vec<String>)],
    question_keys: &[(String, String)],
) -> Value {
    let mut out = Map::new();
    for (raw_key, labels) in entries {
        let matched = question_keys
            .iter()
            .find(|(qid, qtext)| qid == raw_key || qtext == raw_key);
        let key = matched
            .map(|(_, qtext)| {
                if qtext.is_empty() {
                    raw_key.clone()
                } else {
                    qtext.clone()
                }
            })
            .unwrap_or_else(|| raw_key.clone());
        out.insert(key, Value::String(labels.join(", ")));
    }
    Value::Object(out)
}
