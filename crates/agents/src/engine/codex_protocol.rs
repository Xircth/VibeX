//! Codex `app-server` JSON-RPC 2.0 notification normalization, server-initiated
//! approval/question request parsing, model/policy helpers, rate-limit decoding,
//! and multimodal prompt serialization.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
};

use chrono::{TimeZone, Utc};
use serde_json::{Value, json};

use crate::{
    conversation::ContentBlock,
    engine::{
        CodexAutoCompactionThreadState, EngineAuth, EngineCapabilities, EngineCommandSpec,
        EngineEffortSpec, EngineEvent, EngineModeSpec, EngineModelInfo, EnginePermissionDecision,
        EnginePlanEntry, EngineRateLimits, EngineSelectChoice, PromptMode,
        resolve_home_dir_from_env,
    },
    permissions::{AgentPermissionOption, AgentPermissionOptionKind},
};

pub(crate) fn str_any(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|k| value.get(*k).and_then(Value::as_str))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

pub(crate) fn nested_or_str(
    value: &Value,
    outer: &str,
    inner: &str,
    fallback: &str,
) -> Option<String> {
    value
        .get(outer)
        .and_then(|o| o.get(inner))
        .or_else(|| value.get(fallback))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn rpc_id_display(raw_id: &Value) -> String {
    match raw_id {
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Authoritative backend state for a server-initiated JSON-RPC request from `codex app-server`.
#[derive(Debug, Clone)]
pub struct PendingCodexServerRequest {
    pub raw_rpc_id: Value,
    pub method: String,
    pub thread_id: String,
    pub prompt_id: Option<String>,
    pub params: Value,
}

pub fn codex_approval_options() -> Vec<AgentPermissionOption> {
    vec![
        AgentPermissionOption {
            id: "accept".to_string(),
            label: "Allow once".to_string(),
            kind: AgentPermissionOptionKind::AllowOnce,
            description: None,
        },
        AgentPermissionOption {
            id: "acceptForSession".to_string(),
            label: "Allow for session".to_string(),
            kind: AgentPermissionOptionKind::AllowAlways,
            description: None,
        },
        AgentPermissionOption {
            id: "decline".to_string(),
            label: "Decline".to_string(),
            kind: AgentPermissionOptionKind::RejectOnce,
            description: None,
        },
    ]
}

pub fn default_codex_models() -> Vec<EngineModelInfo> {
    vec![
        EngineModelInfo {
            id: "gpt-5.4".to_string(),
            label: "GPT-5.4".to_string(),
            description: Some("Flagship coding and reasoning model".to_string()),
            is_default: false,
        },
        EngineModelInfo {
            id: "gpt-5.3-codex".to_string(),
            label: "GPT-5.3 Codex".to_string(),
            description: Some("Specialized agentic software engineering".to_string()),
            is_default: false,
        },
        EngineModelInfo {
            id: "gpt-5.4-mini".to_string(),
            label: "GPT-5.4 Mini".to_string(),
            description: Some("Fast low-latency coding model".to_string()),
            is_default: false,
        },
        EngineModelInfo {
            id: "o3".to_string(),
            label: "o3".to_string(),
            description: Some("Deep analytical reasoning".to_string()),
            is_default: false,
        },
    ]
}

pub(crate) fn parse_codex_models_response(result: &Value) -> Vec<EngineModelInfo> {
    let items = result
        .get("data")
        .or_else(|| result.get("models"))
        .and_then(Value::as_array);
    let Some(items) = items else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in items {
        let is_default = item
            .get("isDefault")
            .or_else(|| item.get("is_default"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let hidden = item
            .get("hidden")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if hidden && !is_default {
            continue;
        }
        let Some(id) = str_any(item, &["model", "id", "slug"]) else {
            continue;
        };
        if out.iter().any(|existing: &EngineModelInfo| existing.id == id) {
            continue;
        }
        let label = str_any(item, &["displayName", "title", "name"]).unwrap_or_else(|| id.clone());
        let description = str_any(item, &["description"]);
        out.push(EngineModelInfo {
            id,
            label,
            description,
            is_default,
        });
    }
    out
}

/// Maps Dimo / Codex mode identifiers + workspace directories onto Codex `approvalPolicy`
/// and `turn/start` `sandboxPolicy` (`readOnly`, `workspaceWrite`, `dangerFullAccess`).
pub(crate) fn build_codex_turn_policy(
    permission_mode: Option<&str>,
    working_dir: &Path,
    additional_directories: &[PathBuf],
) -> (Option<&'static str>, Option<Value>) {
    let writable_workspace_policy = || {
        let mut roots = vec![working_dir.to_string_lossy().into_owned()];
        for extra in additional_directories {
            let s = extra.to_string_lossy().into_owned();
            if !s.is_empty() && !roots.contains(&s) {
                roots.push(s);
            }
        }
        json!({
            "type": "workspaceWrite",
            "writableRoots": roots,
        })
    };

    match permission_mode.map(str::trim).filter(|s| !s.is_empty()) {
        Some("plan" | "read-only" | "readOnly") => {
            (Some("on-request"), Some(json!({ "type": "readOnly" })))
        }
        Some("full-access" | "danger-full-access" | "dangerFullAccess" | "bypassPermissions" | "yolo") => (
            Some("never"),
            Some(json!({ "type": "dangerFullAccess" })),
        ),
        Some("auto" | "acceptEdits") => (Some("never"), Some(writable_workspace_policy())),
        Some("default" | "on-request") => (Some("on-request"), Some(writable_workspace_policy())),
        _ if !additional_directories.is_empty() => (None, Some(writable_workspace_policy())),
        _ => (None, None),
    }
}

/// Parses a server-initiated Codex JSON-RPC request (`id` AND `method` both present).
/// Emits `PermissionRequested` for command/file approvals and `QuestionRequested` for
/// `item/tool/requestUserInput`.
pub fn parse_codex_server_request(
    method: &str,
    raw_rpc_id: &Value,
    params: &Value,
) -> Option<(String, PendingCodexServerRequest, EngineEvent)> {
    let thread_id = str_any(params, &["threadId", "conversationId"]).unwrap_or_default();
    let session_id = (!thread_id.is_empty()).then(|| thread_id.clone());
    let prompt_id = str_any(params, &["promptId", "turnId"]);

    match method {
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            let default_tool = if method == "item/commandExecution/requestApproval" {
                "commandExecution"
            } else {
                "fileChange"
            };
            let permission_id =
                str_any(params, &["approvalId", "permissionId", "itemId", "callId"])
                    .unwrap_or_else(|| format!("codex-approval-{}", rpc_id_display(raw_rpc_id)));
            let tool_name =
                str_any(params, &["toolName", "name"]).unwrap_or_else(|| default_tool.to_string());
            let decision_reason = str_any(params, &["reason", "decisionReason"]);

            let record = PendingCodexServerRequest {
                raw_rpc_id: raw_rpc_id.clone(),
                method: method.to_string(),
                thread_id,
                prompt_id: prompt_id.clone(),
                params: params.clone(),
            };
            let event = EngineEvent::PermissionRequested {
                permission_id: permission_id.clone(),
                prompt_id,
                session_id,
                tool_name,
                input: params.clone(),
                decision_reason,
                options: codex_approval_options(),
            };
            Some((permission_id, record, event))
        }
        "item/tool/requestUserInput" => {
            let request_id = str_any(params, &["requestId", "itemId", "callId"])
                .unwrap_or_else(|| format!("codex-input-{}", rpc_id_display(raw_rpc_id)));
            let tool_call_id = str_any(params, &["itemId", "callId"]);
            let questions = params
                .get("questions")
                .cloned()
                .unwrap_or_else(|| json!([]));
            let record = PendingCodexServerRequest {
                raw_rpc_id: raw_rpc_id.clone(),
                method: method.to_string(),
                thread_id,
                prompt_id: prompt_id.clone(),
                params: params.clone(),
            };
            let event = EngineEvent::QuestionRequested {
                request_id: request_id.clone(),
                prompt_id,
                session_id,
                tool_call_id,
                questions,
            };
            Some((request_id, record, event))
        }
        _ => None,
    }
}

/// Formats structured user answers into Codex `ToolRequestUserInputResponse` (`{ "answers": { id: { "answers": [...] } } }`).
pub fn build_codex_question_result(
    pending: &PendingCodexServerRequest,
    answers: &Value,
    cancelled: bool,
) -> Value {
    if cancelled {
        return json!({ "answers": {} });
    }
    let source = answers.get("answers").unwrap_or(answers);
    if let Some(obj) = source.as_object() {
        let mut normalized = serde_json::Map::new();
        for (key, val) in obj {
            let list = match val {
                Value::Object(inner) if inner.contains_key("answers") => {
                    inner.get("answers").cloned().unwrap_or_else(|| json!([]))
                }
                Value::Array(arr) => Value::Array(arr.clone()),
                Value::String(s) if !s.trim().is_empty() => json!([s]),
                _ => json!([]),
            };
            normalized.insert(key.clone(), json!({ "answers": list }));
        }
        return json!({ "answers": Value::Object(normalized) });
    }
    json!({ "answers": synthesize_default_user_input_answers(&pending.params) })
}

/// Builds the JSON-RPC 2.0 `result` payload answering a pending Codex `ServerRequest`
/// together with a normalized behavior label for `EngineEvent::PermissionResolved`.
pub fn build_codex_server_request_result(
    pending: &PendingCodexServerRequest,
    decision: &EnginePermissionDecision,
) -> (Value, String) {
    if pending.method == "item/tool/requestUserInput" {
        if !decision.approved || decision.interrupt {
            return (json!({ "answers": {} }), "decline".to_string());
        }
        let result = match decision.updated_input {
            Some(ref input) => build_codex_question_result(pending, input, false),
            None => json!({ "answers": synthesize_default_user_input_answers(&pending.params) }),
        };
        return (result, "accept".to_string());
    }

    let codex_decision = if decision.interrupt {
        "cancel"
    } else {
        match decision.option_id.as_deref() {
            Some("acceptForSession" | "allow_always") => "acceptForSession",
            Some("accept" | "allow" | "allow_once") => "accept",
            Some("cancel") => "cancel",
            Some("decline" | "deny" | "reject" | "reject_once" | "reject_always") => "decline",
            _ if decision.approved => "accept",
            _ => "decline",
        }
    };

    (
        json!({ "decision": codex_decision }),
        codex_decision.to_string(),
    )
}

fn synthesize_default_user_input_answers(params: &Value) -> Value {
    let mut map = serde_json::Map::new();
    if let Some(questions) = params.get("questions").and_then(Value::as_array) {
        for q in questions {
            let Some(qid) = str_any(q, &["id", "question"]) else {
                continue;
            };
            let first_opt = q
                .get("options")
                .and_then(Value::as_array)
                .and_then(|opts| opts.first())
                .and_then(|o| str_any(o, &["label", "value"]));
            let answer_list = match first_opt {
                Some(label) => json!([label]),
                None => json!([]),
            };
            map.insert(qid, json!({ "answers": answer_list }));
        }
    }
    Value::Object(map)
}

fn extract_agent_message_text(item: &Value) -> Option<String> {
    if let Some(text) = str_any(item, &["text"]) {
        return Some(text);
    }
    let parts = item.get("content").and_then(Value::as_array)?;
    let joined: String = parts
        .iter()
        .filter_map(|p| p.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("");
    (!joined.trim().is_empty()).then_some(joined)
}

fn parse_codex_usage_bucket(
    bucket: &Value,
) -> (Option<u64>, Option<u64>, Option<u64>, Option<u64>) {
    let raw_input = bucket
        .get("inputTokens")
        .or_else(|| bucket.get("input_tokens"))
        .and_then(Value::as_u64);
    let output_tokens = bucket
        .get("outputTokens")
        .or_else(|| bucket.get("output_tokens"))
        .and_then(Value::as_u64);
    let cache_read_tokens = bucket
        .get("cachedInputTokens")
        .or_else(|| bucket.get("cached_input_tokens"))
        .or_else(|| bucket.get("cache_read_input_tokens"))
        .and_then(Value::as_u64);
    let input_includes_cached = bucket.get("cache_read_input_tokens").is_none()
        || bucket.get("cachedInputTokens").is_some()
        || bucket.get("cached_input_tokens").is_some();
    let input_tokens = raw_input.map(|raw| {
        if input_includes_cached {
            raw.saturating_sub(cache_read_tokens.unwrap_or(0))
        } else {
            raw
        }
    });
    let explicit_total = bucket
        .get("totalTokens")
        .or_else(|| bucket.get("total_tokens"))
        .and_then(Value::as_u64);
    let computed_total =
        if input_tokens.is_some() || cache_read_tokens.is_some() || output_tokens.is_some() {
            let sum = input_tokens.unwrap_or(0)
                + cache_read_tokens.unwrap_or(0)
                + output_tokens.unwrap_or(0);
            (sum > 0).then_some(sum)
        } else {
            None
        };
    (
        input_tokens,
        output_tokens,
        cache_read_tokens,
        explicit_total.filter(|&t| t > 0).or(computed_total),
    )
}

fn parse_codex_usage_event(
    params: &Value,
    prompt_id: Option<String>,
    session_id: Option<String>,
    is_turn_completed: bool,
) -> Option<EngineEvent> {
    let token_usage = params
        .get("tokenUsage")
        .or_else(|| params.get("turn").and_then(|t| t.get("usage")))
        .or_else(|| params.get("usage"))?;
    let total_obj = token_usage.get("total").filter(|v| v.is_object());
    let last_obj = token_usage.get("last").filter(|v| v.is_object());
    let spend_bucket = total_obj.or(last_obj).unwrap_or(token_usage);

    let (input_tokens, output_tokens, cache_read_tokens, spend_total) =
        parse_codex_usage_bucket(spend_bucket);
    let context_used = if let Some(last) = last_obj {
        parse_codex_usage_bucket(last).3
    } else if total_obj.is_none() && !is_turn_completed {
        spend_total
    } else {
        None
    };
    let is_turn_summary = is_turn_completed || (total_obj.is_some() && last_obj.is_none());
    let context_window = token_usage
        .get("modelContextWindow")
        .or_else(|| spend_bucket.get("contextWindow"))
        .or_else(|| {
            last_obj
                .and_then(|l| l.get("contextWindow"))
                .or_else(|| token_usage.get("contextWindow"))
        })
        .and_then(Value::as_u64);

    if input_tokens.is_none()
        && output_tokens.is_none()
        && cache_read_tokens.is_none()
        && context_window.is_none()
    {
        return None;
    }

    Some(EngineEvent::UsageUpdated {
        prompt_id,
        session_id,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens: None,
        cost_usd: None,
        context_used,
        context_window,
        is_turn_summary,
        model: nested_or_str(params, "turn", "model", "model"),
    })
}

pub(crate) fn normalize_codex_notification(
    method: &str,
    params: &Value,
    latest_rate_limits: &Arc<RwLock<Option<EngineRateLimits>>>,
    compaction_states: &Arc<RwLock<HashMap<String, CodexAutoCompactionThreadState>>>,
) -> Vec<EngineEvent> {
    let session_id = str_any(params, &["threadId", "conversationId"])
        .or_else(|| nested_or_str(params, "thread", "id", "threadId"));
    let prompt_id = str_any(params, &["promptId", "turnId"])
        .or_else(|| nested_or_str(params, "turn", "id", "turnId"));

    match method {
        "thread/started" => vec![EngineEvent::SessionInitialized {
            session_id,
            model: nested_or_str(params, "thread", "model", "model"),
            slash_commands: vec!["compact".into(), "review".into(), "init".into()],
        }],
        "account/rateLimits/updated" => {
            let Some(limits) = parse_codex_rate_limits_payload(params) else {
                return Vec::new();
            };
            if let Ok(mut guard) = latest_rate_limits.write() {
                *guard = Some(limits.clone());
            }
            vec![EngineEvent::RateLimitsUpdated {
                session_id,
                rate_limits: limits,
            }]
        }
        "item/commandExecution/outputDelta" | "item/fileChange/outputDelta" => {
            vec![EngineEvent::TerminalOutputDelta {
                prompt_id,
                session_id,
                call_id: str_any(params, &["itemId", "callId"]),
                delta: params
                    .get("delta")
                    .or_else(|| params.get("output"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            }]
        }
        "item/agentMessage/delta" | "agent_message_delta" => {
            vec![EngineEvent::AssistantTextDelta {
                prompt_id,
                session_id,
                message_id: str_any(params, &["itemId"]),
                text: params
                    .get("delta")
                    .or_else(|| params.get("text"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            }]
        }
        "item/reasoning/delta"
        | "item/reasoning/summaryTextDelta"
        | "item/reasoning/textDelta" => vec![EngineEvent::ThinkingDelta {
            prompt_id,
            session_id,
            message_id: str_any(params, &["itemId"]),
            thinking: params
                .get("delta")
                .or_else(|| params.get("text"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        }],
        "turn/plan/updated" => {
            let entries: Vec<EnginePlanEntry> = params
                .get("plan")
                .or_else(|| params.get("entries"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|item| {
                    let content = str_any(item, &["step", "content", "text"])?;
                    let status = str_any(item, &["status"]).unwrap_or_else(|| "pending".into());
                    Some(EnginePlanEntry {
                        content,
                        status,
                        priority: str_any(item, &["priority"]),
                    })
                })
                .collect();
            if entries.is_empty() {
                Vec::new()
            } else {
                vec![EngineEvent::PlanUpdated {
                    prompt_id,
                    session_id,
                    entries,
                }]
            }
        }
        "thread/tokenUsage/updated" => {
            parse_codex_usage_event(params, prompt_id, session_id, false)
                .into_iter()
                .collect()
        }
        "item/started" | "item/completed" => {
            let Some(item) = params.get("item").filter(|v| v.is_object()) else {
                return Vec::new();
            };
            let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
            if item_type == "agentMessage" {
                if method == "item/completed"
                    && let Some(text) = extract_agent_message_text(item)
                {
                    return vec![EngineEvent::AssistantMessage {
                        prompt_id,
                        session_id,
                        message_id: str_any(item, &["id"]),
                        text,
                    }];
                }
                return Vec::new();
            }

            if !matches!(
                item_type,
                "commandExecution"
                    | "mcpToolCall"
                    | "fileChange"
                    | "webSearch"
                    | "collabAgentToolCall"
                    | "collabToolCall"
                    | "imageView"
                    | "toolCall"
                    | "dynamicToolCall"
            ) {
                return Vec::new();
            }

            let tool_use_id = str_any(item, &["id"]);
            let tool_name = if item_type == "mcpToolCall" {
                match (str_any(item, &["server"]), str_any(item, &["tool", "name"])) {
                    (Some(srv), Some(tl)) => format!("mcp__{srv}__{tl}"),
                    (_, Some(tl)) => tl,
                    _ => "mcpToolCall".to_string(),
                }
            } else {
                str_any(item, &["name", "tool"]).unwrap_or_else(|| item_type.to_string())
            };

            let mut out = Vec::new();
            let is_collab = matches!(item_type, "collabAgentToolCall" | "collabToolCall");
            if method == "item/started" {
                out.push(EngineEvent::ToolCall {
                    prompt_id: prompt_id.clone(),
                    session_id: session_id.clone(),
                    parent_tool_use_id: None,
                    tool_use_id: tool_use_id.clone(),
                    tool_name,
                    input: item.clone(),
                });
                if is_collab && let Some(sub_id) = tool_use_id {
                    out.push(EngineEvent::SubagentSpawned {
                        prompt_id,
                        session_id,
                        subagent_id: sub_id.clone(),
                        parent_tool_use_id: Some(sub_id),
                        subagent_type: str_any(item, &["tool", "agentRole"]),
                        description: str_any(item, &["prompt", "description"]),
                    });
                }
            } else {
                let status_str = str_any(item, &["status"]).unwrap_or_else(|| "completed".into());
                let is_error = matches!(status_str.as_str(), "failed" | "error" | "declined");
                out.push(EngineEvent::ToolResult {
                    prompt_id: prompt_id.clone(),
                    session_id: session_id.clone(),
                    parent_tool_use_id: None,
                    tool_use_id: tool_use_id.clone(),
                    is_error,
                    content: item.clone(),
                });
                if is_collab && let Some(sub_id) = tool_use_id {
                    out.push(EngineEvent::SubagentCompleted {
                        prompt_id,
                        session_id,
                        subagent_id: sub_id.clone(),
                        parent_tool_use_id: Some(sub_id),
                        status: status_str,
                        summary: str_any(item, &["prompt"]),
                    });
                }
            }
            out
        }
        "thread/compaction/started"
        | "thread/compaction/completed"
        | "thread/autoCompaction/updated" => {
            let in_progress = match method {
                "thread/compaction/started" => true,
                "thread/compaction/completed" => false,
                _ => params
                    .get("inProgress")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            };
            if let Some(ref tid) = session_id
                && let Ok(mut map) = compaction_states.write()
            {
                const MAX_COMPACTION_STATES: usize = 256;
                if map.len() >= MAX_COMPACTION_STATES && !map.contains_key(tid) {
                    map.retain(|_, state| state.in_progress);
                }
                let entry =
                    map.entry(tid.clone())
                        .or_insert_with(|| CodexAutoCompactionThreadState {
                            thread_id: tid.clone(),
                            ..Default::default()
                        });
                if in_progress {
                    entry.in_progress = true;
                    entry.started_at = Some(Utc::now());
                } else {
                    if entry.in_progress {
                        entry.completed_count += 1;
                    }
                    entry.in_progress = false;
                }
            }
            vec![EngineEvent::AutoCompactionChanged {
                session_id,
                in_progress,
            }]
        }
        "turn/started" => vec![EngineEvent::TurnStarted {
            prompt_id,
            turn_id: nested_or_str(params, "turn", "id", "turnId"),
            session_id,
        }],
        "turn/completed" => {
            let mut events = Vec::new();
            if let Some(usage_ev) =
                parse_codex_usage_event(params, prompt_id.clone(), session_id.clone(), true)
            {
                events.push(usage_ev);
            }
            let turn_status = nested_or_str(params, "turn", "status", "status");
            match turn_status
                .as_deref()
                .map(str::trim)
                .map(str::to_ascii_lowercase)
                .as_deref()
            {
                Some("failed" | "error") => {
                    let message = params
                        .pointer("/turn/error/message")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                        .or_else(|| nested_or_str(params, "error", "message", "message"))
                        .unwrap_or_else(|| "Codex turn failed".into());
                    events.push(EngineEvent::TurnError {
                        prompt_id,
                        session_id,
                        message,
                    });
                }
                Some("interrupted" | "cancelled" | "canceled") => {
                    events.push(EngineEvent::TurnInterrupted {
                        prompt_id,
                        session_id,
                        reason: "interrupted".into(),
                    });
                }
                _ => {
                    let stop_reason = match turn_status.as_deref().map(str::trim) {
                        None | Some("") => Some("end_turn".to_string()),
                        Some(s) if s.eq_ignore_ascii_case("completed") => {
                            Some("end_turn".to_string())
                        }
                        Some(other) => Some(other.to_string()),
                    };
                    let served_model = nested_or_str(params, "turn", "model", "model")
                        .or_else(|| str_any(params, &["served_model", "servedModel"]));
                    events.push(EngineEvent::TurnCompleted {
                        prompt_id,
                        turn_id: nested_or_str(params, "turn", "id", "turnId"),
                        session_id,
                        stop_reason,
                        served_model,
                    });
                }
            }
            events
        }
        "turn/interrupted" => vec![EngineEvent::TurnInterrupted {
            prompt_id,
            session_id,
            reason: str_any(params, &["reason"]).unwrap_or_else(|| "interrupted".into()),
        }],
        "error" => {
            let will_retry = params
                .get("willRetry")
                .and_then(Value::as_bool)
                .or_else(|| {
                    params
                        .get("error")
                        .and_then(|e| e.get("willRetry"))
                        .and_then(Value::as_bool)
                })
                .unwrap_or(false);
            if will_retry {
                vec![EngineEvent::HookEvent {
                    prompt_id,
                    session_id,
                    hook_name: "codex/retry".into(),
                    payload: params.clone(),
                }]
            } else {
                vec![EngineEvent::TurnError {
                    prompt_id,
                    session_id,
                    message: nested_or_str(params, "error", "message", "message")
                        .unwrap_or_else(|| "Codex turn failed".into()),
                }]
            }
        }
        "turn/failed" => vec![EngineEvent::TurnError {
            prompt_id,
            session_id,
            message: nested_or_str(params, "error", "message", "message")
                .or_else(|| {
                    params
                        .pointer("/turn/error/message")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                })
                .unwrap_or_else(|| "Codex turn failed".into()),
        }],
        _ => Vec::new(),
    }
}

fn normalize_epoch_ms(value: f64) -> i64 {
    if value > 1_000_000_000_000.0 {
        value as i64
    } else {
        (value * 1000.0) as i64
    }
}

pub fn parse_codex_rate_limits_payload(payload: &Value) -> Option<EngineRateLimits> {
    let snap = payload
        .get("rateLimitsByLimitId")
        .and_then(|by_id| by_id.get("codex"))
        .filter(|v| v.is_object())
        .or_else(|| payload.get("rateLimits").filter(|v| v.is_object()))
        .or_else(|| payload.is_object().then_some(payload))?;

    let (pri, sec) = (
        snap.get("primary").filter(|v| v.is_object()),
        snap.get("secondary").filter(|v| v.is_object()),
    );
    let win = |k: &str| {
        pri.and_then(|w| w.get(k))
            .or_else(|| sec.and_then(|w| w.get(k)))
            .and_then(Value::as_f64)
    };

    let used_percent = win("usedPercent");
    let reset_at =
        win("resetsAt").and_then(|r| Utc.timestamp_millis_opt(normalize_epoch_ms(r)).single());
    let credits_remaining = snap
        .get("credits")
        .and_then(|c| c.get("balance"))
        .and_then(|b| {
            b.as_f64()
                .or_else(|| b.as_str().and_then(|s| s.parse::<f64>().ok()))
        });
    let plan_type = str_any(snap, &["planType"]);
    let requests_remaining = snap.get("requestsRemaining").and_then(Value::as_i64);
    let tokens_remaining = snap.get("tokensRemaining").and_then(Value::as_i64);

    let has_any = used_percent.is_some()
        || reset_at.is_some()
        || credits_remaining.is_some()
        || plan_type.is_some()
        || requests_remaining.is_some()
        || tokens_remaining.is_some();
    has_any.then(|| EngineRateLimits {
        requests_remaining,
        tokens_remaining,
        reset_at,
        credits_remaining,
        plan_type,
        utilization: used_percent.map(|pct| pct / 100.0),
    })
}

fn strip_file_uri_to_local_path(raw_uri: &str) -> String {
    if let Ok(parsed) = url::Url::parse(raw_uri)
        && parsed.scheme() == "file"
        && let Ok(file_path) = parsed.to_file_path()
    {
        return file_path.to_string_lossy().into_owned();
    }
    if let Some(rest) = raw_uri.strip_prefix("file:///") {
        let bytes = rest.as_bytes();
        if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            return rest.to_string();
        }
        return format!("/{rest}");
    }
    raw_uri
        .strip_prefix("file://")
        .unwrap_or(raw_uri)
        .to_string()
}

pub(crate) fn serialize_codex_input_items(blocks: &[ContentBlock], mode: PromptMode) -> Vec<Value> {
    if mode == PromptMode::Compact {
        return vec![json!({ "type": "text", "text": "/compact" })];
    }
    let mut items: Vec<Value> = blocks
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Text { text } => Some(json!({ "type": "text", "text": text })),
            ContentBlock::Image {
                data,
                mime_type,
                uri,
                ..
            } => {
                let trimmed_data = data.trim();
                if !trimmed_data.is_empty() {
                    Some(json!({
                        "type": "image",
                        "url": format!("data:{mime_type};base64,{trimmed_data}"),
                    }))
                } else if let Some(raw_uri) = uri.as_deref().map(str::trim).filter(|s| !s.is_empty())
                {
                    if raw_uri.starts_with("http://")
                        || raw_uri.starts_with("https://")
                        || raw_uri.starts_with("data:")
                    {
                        Some(json!({ "type": "image", "url": raw_uri }))
                    } else {
                        Some(json!({
                            "type": "localImage",
                            "path": strip_file_uri_to_local_path(raw_uri),
                        }))
                    }
                } else {
                    None
                }
            }
            ContentBlock::Resource { uri, .. } => {
                Some(json!({ "type": "text", "text": format!("@{uri}") }))
            }
            _ => None,
        })
        .collect();
    if items.is_empty() {
        items.push(json!({ "type": "text", "text": "" }));
    }
    items
}

pub(super) fn codex_capabilities(engine_id: &str) -> EngineCapabilities {
    EngineCapabilities {
        engine_id: engine_id.to_string(),
        supports_native_steer: true,
        supports_native_revert: true,
        supports_native_fork: true,
        supports_rate_limit_push: true,
        supports_prompt_cache_ttl: false,
        records_idle_compaction_activity: false,
        modes: EngineModeSpec {
            modes: vec![
                EngineSelectChoice {
                    id: "default".to_string(),
                    label: "Default".to_string(),
                    description: Some("Workspace-write sandbox with on-request approvals".to_string()),
                },
                EngineSelectChoice {
                    id: "plan".to_string(),
                    label: "Plan".to_string(),
                    description: Some("Read-only sandbox for planning and code inspection".to_string()),
                },
                EngineSelectChoice {
                    id: "full-access".to_string(),
                    label: "Full Access".to_string(),
                    description: Some("Unrestricted execution without approval prompts".to_string()),
                },
            ],
            default_mode_id: "default".to_string(),
            yolo_mode_id: "full-access".to_string(),
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
            ],
            default_value: "high".to_string(),
        }),
        default_commands: vec![
            EngineCommandSpec {
                name: "compact".to_string(),
                description: "Compact conversation context".to_string(),
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

pub(super) fn codex_normalize_mode(raw: &str) -> Option<String> {
    match raw.trim() {
        "yolo" | "bypassPermissions" | "full-access" | "auto" => Some("full-access".to_string()),
        "default" | "acceptEdits" => Some("default".to_string()),
        "plan" => Some("plan".to_string()),
        _ => None,
    }
}

pub(super) fn resolve_codex_auth(env: &HashMap<String, String>) -> EngineAuth {
    if let Some(api_key) = env
        .get("OPENAI_API_KEY")
        .or_else(|| env.get("CODEX_API_KEY"))
        .filter(|v| !v.trim().is_empty())
    {
        return EngineAuth::ApiKey {
            api_key: api_key.clone(),
            base_url: env
                .get("OPENAI_BASE_URL")
                .filter(|u| !u.trim().is_empty())
                .cloned(),
        };
    }
    EngineAuth::Ambient
}

pub(super) fn prepare_codex_launch_env(
    locked_program: &Path,
    snapshot_env: &HashMap<String, String>,
    launch_env: &mut HashMap<String, String>,
    scrubbed_keys: &mut Vec<String>,
) {
    if locked_program.is_absolute()
        && locked_program.is_file()
        && locked_program
            .file_stem()
            .and_then(|s| s.to_str())
            .is_some_and(|stem| stem.eq_ignore_ascii_case("codex"))
        && !launch_env.contains_key("DIMO_CODEX_PATH")
        && !launch_env.contains_key("CODEX_PATH")
    {
        launch_env.insert(
            "CODEX_PATH".to_string(),
            locked_program.to_string_lossy().into_owned(),
        );
    }

    let codex_subscription = crate::codex_uses_chatgpt_subscription(snapshot_env);
    for key in ["OPENAI_API_KEY", "OPENAI_BASE_URL"] {
        let inherited_blank = std::env::var(key)
            .map(|value| value.trim().is_empty())
            .unwrap_or(false);
        if (codex_subscription || inherited_blank) && !snapshot_env.contains_key(key) {
            launch_env.remove(key);
            scrubbed_keys.push(key.to_string());
        }
    }
}

fn resolve_codex_home_dir(env: &HashMap<String, String>) -> Option<PathBuf> {
    if let Some(explicit) = env
        .get("CODEX_HOME")
        .map(String::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Some(PathBuf::from(explicit));
    }
    if let Some(explicit) = std::env::var_os("CODEX_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
    {
        return Some(explicit);
    }
    resolve_home_dir_from_env(env).map(|home| home.join(".codex"))
}

pub(super) fn resolve_codex_default_model(env: &HashMap<String, String>) -> Option<String> {
    let codex_home = resolve_codex_home_dir(env)?;
    let raw = std::fs::read_to_string(codex_home.join("config.toml")).ok()?;
    let table = raw.parse::<toml::Table>().ok()?;
    table
        .get("model")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

pub(super) fn is_official_openai_base_url(raw_url: &str) -> bool {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
        return true;
    }
    let Ok(parsed) = url::Url::parse(trimmed) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    let lower = host.to_ascii_lowercase();
    lower == "api.openai.com"
        || lower.ends_with(".openai.com")
        || lower == "chatgpt.com"
        || lower.ends_with(".chatgpt.com")
}

pub(super) fn codex_accepts_model_id(model_id: &str, env: &HashMap<String, String>) -> bool {
    let custom_base_url = env
        .get("OPENAI_BASE_URL")
        .is_some_and(|raw| !is_official_openai_base_url(raw));
    if custom_base_url {
        return true;
    }
    let lower = model_id.trim().to_ascii_lowercase();
    !lower.is_empty()
        && !lower.starts_with("claude-")
        && !lower.starts_with("gemini-")
        && !matches!(lower.as_str(), "opus" | "sonnet" | "haiku" | "fable")
}
