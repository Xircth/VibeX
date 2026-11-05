use super::*;
use crate::stderr_tail::{StderrTail, sanitize_diagnostic};

impl EmptyTurnCause {
    pub(in crate::manager) fn as_str(self) -> &'static str {
        match self {
            Self::UnreadableUpdates => "unreadable_updates",
            Self::AgentStderr => "agent_stderr",
            Self::SilentEndTurn => "silent_end_turn",
        }
    }
}

pub(in crate::manager) fn diagnose_empty_turn(dropped_count: u64, stderr: &str) -> EmptyTurnCause {
    if dropped_count > 0 {
        EmptyTurnCause::UnreadableUpdates
    } else if !stderr.trim().is_empty() {
        EmptyTurnCause::AgentStderr
    } else {
        EmptyTurnCause::SilentEndTurn
    }
}

pub(in crate::manager) fn build_empty_turn_details(
    probe: &TurnOutputProbe,
    stderr_tail: &StderrTail,
    stderr_mark: u64,
) -> (EmptyTurnCause, String, serde_json::Value) {
    let (dropped_count, dropped_tag, dropped_error) = probe.dropped_summary();
    let slice = stderr_tail.tail_since(
        stderr_mark,
        EMPTY_TURN_STDERR_MAX_LINES,
        EMPTY_TURN_STDERR_MAX_BYTES,
    );
    let stderr_trimmed = slice.lines.join("\n").trim().to_string();
    let cause = diagnose_empty_turn(dropped_count, &stderr_trimmed);

    let mut obj = serde_json::Map::new();
    obj.insert("cause".into(), serde_json::json!(cause.as_str()));
    if dropped_count > 0 {
        obj.insert("droppedUpdates".into(), serde_json::json!(dropped_count));
        if let Some(tag) = dropped_tag {
            obj.insert("firstDroppedTag".into(), serde_json::json!(tag));
        }
        if let Some(err) = dropped_error {
            obj.insert("firstDroppedError".into(), serde_json::json!(err));
        }
    }
    if !stderr_trimmed.is_empty() {
        let scope_label = match slice.scope {
            crate::stderr_tail::TailScope::ThisTurn => "this_turn",
            crate::stderr_tail::TailScope::Recent => "recent",
        };
        obj.insert("stderr".into(), serde_json::json!(stderr_trimmed.clone()));
        obj.insert("stderrScope".into(), serde_json::json!(scope_label));
    }
    (cause, stderr_trimmed, serde_json::Value::Object(obj))
}

pub(in crate::manager) fn finish_turn_reason(
    stop_reason: &acp::schema::v1::StopReason,
    has_output: bool,
    cancelled: bool,
) -> String {
    if cancelled {
        return "cancelled".to_string();
    }
    match stop_reason {
        acp::schema::v1::StopReason::EndTurn => {
            if has_output {
                "end_turn".to_string()
            } else {
                "turn_failed_empty".to_string()
            }
        }
        acp::schema::v1::StopReason::MaxTokens => "turn_failed_max_tokens".to_string(),
        acp::schema::v1::StopReason::MaxTurnRequests => "turn_failed_max_turn_requests".to_string(),
        acp::schema::v1::StopReason::Refusal => "turn_failed_refusal".to_string(),
        acp::schema::v1::StopReason::Cancelled => "cancelled".to_string(),
        other => acp_enum_label(other),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(in crate::manager) struct AirSessionFailure {
    pub kind: Option<String>,
    pub title: Option<String>,
    pub message: Option<String>,
    pub retry_after_ms: Option<u64>,
}

impl AirSessionFailure {
    pub(in crate::manager) fn error_code(&self) -> String {
        let Some(kind) = self
            .kind
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            return "session_failure".to_string();
        };
        let mut normalized = String::with_capacity(kind.len());
        let mut prev_sep = false;
        for ch in kind.chars() {
            if ch.is_ascii_alphanumeric() {
                if ch.is_ascii_uppercase() && !normalized.is_empty() && !prev_sep {
                    normalized.push('_');
                }
                normalized.push(ch.to_ascii_lowercase());
                prev_sep = false;
            } else if !normalized.is_empty() && !prev_sep {
                normalized.push('_');
                prev_sep = true;
            }
        }
        let trimmed = normalized.trim_matches('_');
        if trimmed.is_empty() {
            "session_failure".to_string()
        } else {
            trimmed.to_string()
        }
    }

    pub(in crate::manager) fn format_message(&self) -> String {
        let title = self
            .title
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let message = self
            .message
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let kind = self
            .kind
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let mut base = match (title, message) {
            (Some(t), Some(m)) if t == m || m.starts_with(t) => m.to_string(),
            (Some(t), Some(m)) => format!("{t}: {m}"),
            (Some(t), None) => t.to_string(),
            (None, Some(m)) => m.to_string(),
            (None, None) => match kind {
                Some(kind) => format!("Agent 会话失败 [{kind}]"),
                _ => "Agent 会话执行失败".to_string(),
            },
        };
        if let Some(kind) = kind
            && !base.contains(kind)
        {
            base = format!("[{kind}] {base}");
        }
        if let Some(ms) = self.retry_after_ms.filter(|ms| *ms > 0) {
            let secs = ms.div_ceil(1000);
            base.push_str(&format!("（建议等待 {secs}s 后重试）"));
        }
        sanitize_diagnostic(&base)
    }
}

pub(in crate::manager) fn extract_session_failure(
    value: &serde_json::Value,
) -> Option<AirSessionFailure> {
    let candidate = value
        .pointer("/_meta/jetbrains.air/sessionFailure")
        .or_else(|| value.pointer("/_meta/jetbrains/air/sessionFailure"))
        .or_else(|| value.pointer("/_meta/jetbrains/sessionFailure"))
        .or_else(|| value.pointer("/_meta/air/sessionFailure"))
        .or_else(|| value.pointer("/_meta/sessionFailure"))
        .or_else(|| value.pointer("/jetbrains.air/sessionFailure"))
        .or_else(|| value.pointer("/jetbrains/air/sessionFailure"))
        .or_else(|| value.pointer("/jetbrains/sessionFailure"))
        .or_else(|| value.pointer("/air/sessionFailure"))
        .or_else(|| value.get("sessionFailure"))?;
    parse_session_failure_value(candidate)
}

pub(in crate::manager) fn extract_session_failure_from_meta(
    meta: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Option<AirSessionFailure> {
    let meta = meta?;
    let wrapped = serde_json::Value::Object(meta.clone());
    extract_session_failure(&wrapped)
}

pub(in crate::manager) fn parse_session_failure_value(
    value: &serde_json::Value,
) -> Option<AirSessionFailure> {
    if let Some(text) = value.as_str().map(str::trim).filter(|s| !s.is_empty()) {
        return Some(AirSessionFailure {
            kind: None,
            title: None,
            message: Some(sanitize_diagnostic(text)),
            retry_after_ms: None,
        });
    }
    let obj = value.as_object()?;
    let pick_str = |keys: &[&str]| -> Option<String> {
        keys.iter().find_map(|key| {
            obj.get(*key)
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(sanitize_diagnostic)
        })
    };
    let kind = pick_str(&["kind", "category", "type", "code"]);
    let title = pick_str(&["title", "summary"]);
    let message = pick_str(&[
        "userMessage",
        "user_message",
        "message",
        "details",
        "description",
        "reason",
        "error",
    ]);
    let retry_after_ms = ["retryAfterMs", "retry_after_ms"]
        .iter()
        .find_map(|key| obj.get(*key).and_then(serde_json::Value::as_u64))
        .or_else(|| {
            ["retryAfterSeconds", "retry_after_seconds", "retryAfter"]
                .iter()
                .find_map(|key| {
                    obj.get(*key)
                        .and_then(serde_json::Value::as_u64)
                        .map(|secs| secs.saturating_mul(1000))
                })
        });
    if kind.is_none() && title.is_none() && message.is_none() && retry_after_ms.is_none() {
        return None;
    }
    Some(AirSessionFailure {
        kind,
        title,
        message,
        retry_after_ms,
    })
}

pub(in crate::manager) fn classify_adapter_turn_error_code(message: &str) -> &'static str {
    let lower = message.to_ascii_lowercase();
    if lower.contains("model unreachable") || lower.contains("502 bad gateway") {
        "model_unreachable"
    } else if lower.contains("agent connection was lost") {
        "agent_connection_lost"
    } else {
        "agent_execution_error"
    }
}

pub(in crate::manager) fn format_adapter_turn_error(message: &str) -> String {
    let sanitized = sanitize_diagnostic(message.trim());
    let lower = sanitized.to_ascii_lowercase();
    if lower.contains("model unreachable")
        && (lower.contains("502") || lower.contains("failed to connect to backend api"))
    {
        format!(
            "{sanitized}（Antigravity 本地 OAuth 代理连接 Google Cloud Code 后端 cloudcode-pa.googleapis.com 失败或超时，请检查针对 googleapis.com 的系统代理/TUN 分流规则与网络连通性后重试）"
        )
    } else {
        sanitized
    }
}

pub(in crate::manager) fn turn_failure_error_event(
    response: &acp::schema::v1::PromptResponse,
    probe: &TurnOutputProbe,
    stderr_tail: &StderrTail,
    stderr_mark: u64,
) -> Option<AgentErrorEvent> {
    if let Some(adapter_error) = probe.adapter_turn_error() {
        return Some(AgentErrorEvent {
            message: format_adapter_turn_error(&adapter_error),
            code: Some(classify_adapter_turn_error_code(&adapter_error).to_string()),
            raw: Some(serde_json::json!({
                "cause": "adapter_turn_error",
                "adapterError": adapter_error,
            })),
        });
    }
    let meta = response.meta.as_ref();
    let finish_reason = finish_turn_reason(&response.stop_reason, probe.has_output(), false);
    let air_failure = extract_session_failure_from_meta(meta);
    match finish_reason.as_str() {
        "turn_failed_empty" => {
            if let Some(failure) = air_failure {
                return Some(AgentErrorEvent {
                    message: failure.format_message(),
                    code: Some("turn_failed_empty".to_string()),
                    raw: meta.map(|m| serde_json::Value::Object(m.clone())),
                });
            }
            let (cause, stderr_text, details) =
                build_empty_turn_details(probe, stderr_tail, stderr_mark);
            let message = match cause {
                EmptyTurnCause::UnreadableUpdates => {
                    if stderr_text.is_empty() {
                        "Agent 发送了无法识别的流式更新，导致本回合未显示任何有效输出。"
                            .to_string()
                    } else {
                        format!(
                            "Agent 发送了无法识别的流式更新，导致本回合未显示任何有效输出。最近 stderr: {stderr_text}"
                        )
                    }
                }
                EmptyTurnCause::AgentStderr => format!(
                    "Agent 未产生任何输出即结束了回合（StopReason::EndTurn）。最近 stderr: {stderr_text}"
                ),
                EmptyTurnCause::SilentEndTurn => {
                    "Agent 未产生任何输出即结束了回合（StopReason::EndTurn）。可能是认证失效、网络中断或上游服务异常。"
                        .to_string()
                }
            };
            Some(AgentErrorEvent {
                message,
                code: Some("turn_failed_empty".to_string()),
                raw: Some(details),
            })
        }
        "turn_failed_refusal" => {
            let message = air_failure
                .as_ref()
                .map(AirSessionFailure::format_message)
                .unwrap_or_else(|| {
                    "模型拒绝了本次请求（StopReason::Refusal）：Agent 结束了回合但未生成回复。"
                        .to_string()
                });
            Some(AgentErrorEvent {
                message,
                code: Some("turn_failed_refusal".to_string()),
                raw: meta.map(|m| serde_json::Value::Object(m.clone())),
            })
        }
        "turn_failed_max_tokens" => {
            let message = air_failure
                .as_ref()
                .map(AirSessionFailure::format_message)
                .unwrap_or_else(|| {
                    "已达到单轮最大输出 Token 限制（StopReason::MaxTokens），回复在完成前被截断。"
                        .to_string()
                });
            Some(AgentErrorEvent {
                message,
                code: Some("turn_failed_max_tokens".to_string()),
                raw: meta.map(|m| serde_json::Value::Object(m.clone())),
            })
        }
        "turn_failed_max_turn_requests" => {
            let message = air_failure
                .as_ref()
                .map(AirSessionFailure::format_message)
                .unwrap_or_else(|| {
                    "已达到单轮最大模型请求次数限制（StopReason::MaxTurnRequests），Agent 已停止继续执行。"
                        .to_string()
                });
            Some(AgentErrorEvent {
                message,
                code: Some("turn_failed_max_turn_requests".to_string()),
                raw: meta.map(|m| serde_json::Value::Object(m.clone())),
            })
        }
        _ => air_failure.map(|failure| AgentErrorEvent {
            message: failure.format_message(),
            code: Some(failure.error_code()),
            raw: meta.map(|m| serde_json::Value::Object(m.clone())),
        }),
    }
}

pub(in crate::manager) fn is_prompt_session_lost_error_message(message: &str) -> bool {
    const MARKERS: &[&str] = &[
        "Session not found",
        "session not found",
        "session has ended",
    ];
    MARKERS.iter().any(|marker| message.contains(marker))
}

pub(in crate::manager) fn format_acp_prompt_error(
    error: &acp::Error,
    stderr_tail: &StderrTail,
    stderr_mark: u64,
) -> AgentErrorEvent {
    if let Some(failure) = error.data.as_ref().and_then(extract_session_failure) {
        return AgentErrorEvent {
            message: failure.format_message(),
            code: Some(failure.error_code()),
            raw: error.data.clone(),
        };
    }
    let mut message = sanitize_diagnostic(&error.to_string());
    if i32::from(error.code) == -32603 {
        let recent_stderr = stderr_tail.since(stderr_mark);
        let trimmed = recent_stderr.trim();
        if !trimmed.is_empty() && !message.contains(trimmed) {
            message = format!("{message}. Recent stderr: {trimmed}");
        }
    }
    let code = if is_prompt_session_lost_error_message(&message) {
        Some("agent_connection_lost".to_string())
    } else {
        acp_error_code_str(error)
    };
    AgentErrorEvent {
        message,
        code,
        raw: error.data.clone(),
    }
}

/// Classify a real `session/load` failure into a semantic reason so the UI can
/// offer the right recovery (e.g. a `ResourceNotFound` means the agent's session
/// file is gone → "session expired, reload"). Driven entirely by the ACP error
/// code the agent actually returned — never guessed.
pub(in crate::manager) fn classify_session_load_error(
    error: &acp::Error,
) -> SessionLoadFailureReason {
    match i32::from(error.code) {
        // -32002 ResourceNotFound: the agent no longer has this session.
        -32002 => SessionLoadFailureReason::ResourceNotFound,
        // -32000 AuthRequired: the agent needs (re)authentication.
        -32000 => SessionLoadFailureReason::AuthenticationRequired {
            message: error.message.clone(),
        },
        _ => SessionLoadFailureReason::Other {
            message: format!("session/load failed: {error}"),
        },
    }
}

/// B-level, load-only fragments. Do not mix with A-level JSON-RPC codes.
/// Auth is never classified from `"Authentication required"` text.
pub(in crate::manager) fn classify_session_load_failure_fragments(
    message: &str,
    failed_sid: &str,
) -> Option<SessionLoadFailureReason> {
    if message.contains("is archived") {
        return Some(SessionLoadFailureReason::SessionArchived {
            recovery_command: archived_recovery_command(message, failed_sid),
        });
    }
    if message.contains("already has an active writer") {
        return Some(SessionLoadFailureReason::SessionBusy);
    }
    if is_session_contention_error(message) {
        return Some(SessionLoadFailureReason::SessionBusy);
    }
    const UNRECOVERABLE: &[&str] = &["process exited", "session has ended", "Session not found"];
    if UNRECOVERABLE
        .iter()
        .any(|fragment| message.contains(fragment))
    {
        return Some(SessionLoadFailureReason::SessionUnavailable);
    }
    None
}

pub(in crate::manager) fn archived_recovery_command(
    message: &str,
    failed_sid: &str,
) -> Option<String> {
    if let Some(start) = message.find('`')
        && let Some(end) = message[start + 1..].find('`')
    {
        let command = message[start + 1..start + 1 + end].trim();
        if !command.is_empty() {
            return Some(command.to_string());
        }
    }
    Some(format!("codex unarchive {failed_sid}"))
}

pub(in crate::manager) fn is_method_not_found_error(error: &acp::Error) -> bool {
    i32::from(error.code) == -32601 || error.message.contains("Method not found")
}

pub(in crate::manager) fn recovers_load_failure_locally(
    agent_id: &AgentId,
    classified: Option<&SessionLoadFailureReason>,
) -> bool {
    let Some(reason) = classified else {
        return false;
    };
    if matches!(reason, SessionLoadFailureReason::SessionBusy) {
        return false;
    }
    crate::AgentKind::from_lenient(agent_id.as_str()).is_none()
}

#[derive(Debug, Clone, PartialEq)]
pub(in crate::manager) enum SessionLoadFailureAction {
    StopForAuth { message: String },
    Banner(SessionLoadFailureReason),
    SilentNew,
    ToastThenNew,
}

pub(in crate::manager) fn classified_load_failure_reason(
    a_level: &SessionLoadFailureReason,
    error_message: &str,
    failed_sid: &str,
) -> Option<SessionLoadFailureReason> {
    match a_level {
        SessionLoadFailureReason::ResourceNotFound => {
            Some(SessionLoadFailureReason::ResourceNotFound)
        }
        SessionLoadFailureReason::AuthenticationRequired { .. } => None,
        SessionLoadFailureReason::Unsupported
        | SessionLoadFailureReason::SessionArchived { .. }
        | SessionLoadFailureReason::SessionBusy
        | SessionLoadFailureReason::SessionUnavailable
        | SessionLoadFailureReason::Other { .. } => {
            classify_session_load_failure_fragments(error_message, failed_sid)
        }
    }
}

pub(in crate::manager) fn decide_session_load_failure(
    agent_id: &AgentId,
    a_level: &SessionLoadFailureReason,
    classified: Option<&SessionLoadFailureReason>,
    attempted_load: bool,
    method_not_found: bool,
) -> SessionLoadFailureAction {
    if let SessionLoadFailureReason::AuthenticationRequired { message } = a_level {
        return SessionLoadFailureAction::StopForAuth {
            message: message.clone(),
        };
    }
    let recovers_locally = recovers_load_failure_locally(agent_id, classified);
    if let Some(reason) = classified.filter(|_| !recovers_locally).filter(|reason| {
        matches!(
            reason,
            SessionLoadFailureReason::ResourceNotFound
                | SessionLoadFailureReason::SessionUnavailable
                | SessionLoadFailureReason::SessionArchived { .. }
                | SessionLoadFailureReason::SessionBusy
        )
    }) {
        return SessionLoadFailureAction::Banner(reason.clone());
    }
    if attempted_load && classified.is_none() && !method_not_found && !recovers_locally {
        return SessionLoadFailureAction::ToastThenNew;
    }
    SessionLoadFailureAction::SilentNew
}

/// Map a real ACP/JSON-RPC error code to a stable, frontend-facing string so the
/// error card can distinguish auth / expired-session / cancelled / model issues
/// from a generic failure. The value mirrors the agent's actual error code.
pub(in crate::manager) fn acp_error_code_str(error: &acp::Error) -> Option<String> {
    let code = match i32::from(error.code) {
        -32700 => "parse_error",
        -32600 => "invalid_request",
        -32601 => "method_not_found",
        -32602 => "invalid_params",
        -32603 => "internal_error",
        -32800 => "request_cancelled",
        -32000 => "auth_required",
        -32002 => "resource_not_found",
        -32042 => "url_elicitation_required",
        other => return Some(format!("rpc_{other}")),
    };
    Some(code.to_string())
}

pub(in crate::manager) fn map_acp_session_error(context: &str, error: acp::Error) -> AgentError {
    match i32::from(error.code) {
        -32000 => AgentError::AuthenticationRequired(error.to_string()),
        -32002 => AgentError::SessionLoadFailed(SessionLoadFailureReason::ResourceNotFound),
        _ if is_session_contention_error(&error.to_string()) => {
            AgentError::SessionLoadFailed(SessionLoadFailureReason::SessionBusy)
        }
        _ => AgentError::Runtime(format!("{context}: {error}")),
    }
}

/// Grok cancels an in-flight `session/resume` or `session/load` with
/// `"session load was superseded"`, then a follow-up `session/new` hits the
/// still-held session files and returns Windows `ERROR_ACCESS_DENIED`
/// (`FS_PERMISSION_DENIED` / os error 5). The original thread still exists;
/// ADR-0081 D3 forbids `session/new` in that case (same as `session_busy`).
pub(in crate::manager) fn is_session_contention_error(message: &str) -> bool {
    const MARKERS: &[&str] = &[
        "session load was superseded",
        "FS_PERMISSION_DENIED",
        "Permission denied",
        "os error 5",
        "拒绝访问",
    ];
    MARKERS.iter().any(|marker| message.contains(marker))
}
