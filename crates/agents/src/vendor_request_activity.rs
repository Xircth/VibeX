//! Versioned adapter contracts; ordinary prose and stderr are never inputs.
use serde_json::Value;

use crate::{
    AgentKind,
    request_status::{RequestActivity, RequestPhase, RequestRetry},
};

/// Lives on one ACP connection. Revisions belong to incidents, not attempts.
#[derive(Debug, Default)]
pub(crate) struct RetryIncidentLedger {
    prompt: Option<crate::AgentPromptId>,
    active: Option<String>,
    incidents: std::collections::HashMap<String, (crate::AgentPromptId, u64)>,
    order: std::collections::VecDeque<String>,
}

impl RetryIncidentLedger {
    pub(crate) fn accept(&mut self, prompt: crate::AgentPromptId, id: &str, revision: u64) -> bool {
        if self.prompt != Some(prompt) {
            self.prompt = Some(prompt);
            self.active = None;
        }
        if let Some((owner, previous)) = self.incidents.get(id) {
            if *owner != prompt || self.active.as_deref() != Some(id) || revision <= *previous {
                return false;
            }
        } else {
            if self.order.len() == 128
                && let Some(oldest) = self.order.pop_front()
            {
                self.incidents.remove(&oldest);
            }
            self.order.push_back(id.to_owned());
        }
        self.incidents.insert(id.to_owned(), (prompt, revision));
        self.active = Some(id.to_owned());
        true
    }

    pub(crate) fn note_progress(&mut self, prompt: crate::AgentPromptId) {
        if self.prompt == Some(prompt) {
            self.active = None;
        }
    }
}

/// codex-acp 2.2.2 allocates `turn:error` first, then
/// `turn:error:<worker epoch>:<incident number>` after recovered content.
pub(crate) fn codex_retry_incident(update: &Value) -> Option<(&str, u64)> {
    let air = update.pointer("/_meta/jetbrains/air")?;
    if air.get("version")?.as_u64()? != 1 {
        return None;
    }
    let failure = air.get("sessionFailure")?;
    if failure.get("severity")?.as_str()? != "warning"
        || !matches!(
            failure.get("category")?.as_str()?,
            "connection" | "access" | "limit" | "service" | "request"
        )
    {
        return None;
    }
    let id = failure.get("id")?.as_str()?;
    if id.len() > 256 {
        return None;
    }
    let (scope, suffix) = id.rsplit_once(":error")?;
    if scope.is_empty() {
        return None;
    }
    if !suffix.is_empty() {
        let (epoch, number) = suffix.strip_prefix(':')?.rsplit_once(':')?;
        uuid::Uuid::parse_str(epoch).ok()?;
        if number.parse::<u64>().ok()? == 0 {
            return None;
        }
    }
    Some((id, failure.get("revision")?.as_u64()?))
}

/// Mistral Vibe 2.25.5's vendor ACP extension (also consumed by t3code's
/// registry adapter). ACP does not standardize this notification.
pub(crate) fn registry_extension(
    agent_id: &crate::AgentId,
    method: &str,
    params: &Value,
) -> Option<RequestActivity> {
    if agent_id.as_str() != "mistral-vibe" || method != "_session/retrying" {
        return None;
    }
    let category = params.get("category")?.as_str()?;
    if !matches!(
        category,
        "rate_limited" | "server_error" | "timed_out" | "connection" | "unknown"
    ) {
        return None;
    }
    Some(retrying(
        None,
        None,
        None,
        params.get("detail").and_then(Value::as_str),
        None,
    ))
}

/// claude-code-acp 0.94.0 forwards SDK 0.3.22 system.api_retry when
/// session metadata enables raw SDK messages.
pub(crate) fn extension(
    kind: Option<AgentKind>,
    method: &str,
    params: &Value,
) -> Option<RequestActivity> {
    if kind != Some(AgentKind::ClaudeCode) || method != "_claude/sdkMessage" {
        return None;
    }
    let message = params.get("message")?;
    if message.get("type")?.as_str()? != "system"
        || message.get("subtype")?.as_str()? != "api_retry"
    {
        return None;
    }
    Some(retrying(
        message.get("attempt"),
        message.get("max_retries"),
        message.get("retry_delay_ms"),
        message.get("error").and_then(Value::as_str),
        message.get("error_status"),
    ))
}

pub(crate) fn session_update(kind: Option<AgentKind>, update: &Value) -> Option<RequestActivity> {
    match kind? {
        AgentKind::Codex => {
            if update.get("sessionUpdate")?.as_str()? != "session_info_update" {
                return None;
            }
            let meta = update.get("_meta")?;
            if let Some(error) = meta.pointer("/codex/error")
                && error.get("willRetry")?.as_bool()?
            {
                return Some(retrying(
                    None,
                    None,
                    None,
                    error.get("message").and_then(Value::as_str),
                    None,
                ));
            }
            codex_retry_incident(update)?;
            let failure = meta.pointer("/jetbrains/air/sessionFailure")?;
            Some(retrying(
                None,
                None,
                None,
                failure.get("title").and_then(Value::as_str),
                None,
            ))
        }
        _ => None,
    }
}

fn retrying(
    attempt: Option<&Value>,
    max: Option<&Value>,
    delay: Option<&Value>,
    reason: Option<&str>,
    code: Option<&Value>,
) -> RequestActivity {
    RequestActivity {
        phase: RequestPhase::Retrying,
        retry: Some(RequestRetry {
            attempt: attempt
                .and_then(Value::as_u64)
                .and_then(|v| u32::try_from(v).ok()),
            max_attempts: max
                .and_then(Value::as_u64)
                .and_then(|v| u32::try_from(v).ok()),
            delay_ms: delay.and_then(Value::as_u64),
            reason: reason.map(|text| {
                crate::conversation::cap_preview_bytes(crate::stderr_tail::sanitize_diagnostic(
                    text,
                ))
            }),
            code: code.filter(|v| v.is_number() || v.is_string()).map(|v| {
                let text = v
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| v.to_string());
                crate::conversation::cap_preview_bytes(crate::stderr_tail::sanitize_diagnostic(
                    &text,
                ))
            }),
        }),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    #[test]
    fn mistral_vendor_notification_is_scoped_to_its_registry_identity() {
        let params = json!({"sessionId":"vibe-session","category":"rate_limited","detail":"retrying after HTTP 429"});
        let id = crate::AgentId::parse("mistral-vibe").unwrap();
        let retry = registry_extension(&id, "_session/retrying", &params)
            .unwrap()
            .retry
            .unwrap();
        assert_eq!(
            (retry.attempt, retry.max_attempts, retry.delay_ms),
            (None, None, None)
        );
        assert!(
            registry_extension(
                &crate::AgentId::parse("user-agent").unwrap(),
                "_session/retrying",
                &params
            )
            .is_none()
        );
    }
    #[test]
    fn claude_sdk_0322_retry_fixture() {
        let params = json!({"sessionId":"acp-id","message":{"type":"system","subtype":"api_retry","attempt":2,"max_retries":5,"retry_delay_ms":3000,"error_status":429,"error":"rate_limit","uuid":"id","session_id":"vendor-id"}});
        let activity =
            extension(Some(AgentKind::ClaudeCode), "_claude/sdkMessage", &params).unwrap();
        let retry = activity.retry.unwrap();
        assert_eq!(
            (retry.attempt, retry.max_attempts, retry.delay_ms),
            (Some(2), Some(5), Some(3000))
        );
        assert_eq!(retry.code.as_deref(), Some("429"));
        assert!(extension(Some(AgentKind::Codex), "_claude/sdkMessage", &params).is_none());
        assert!(extension(None, "_claude/sdkMessage", &params).is_none());
    }
    #[test]
    fn codex_acp_222_air_retry_fixture_keeps_unknown_fields() {
        let mut update = json!({"sessionUpdate":"session_info_update","_meta":{"jetbrains":{"air":{"version":1,"sessionFailure":{"id":"turn-1:error","revision":2,"category":"connection","severity":"warning","title":"stream disconnected","actions":[]}}}}});
        let retry = session_update(Some(AgentKind::Codex), &update)
            .unwrap()
            .retry
            .unwrap();
        assert_eq!(
            (retry.attempt, retry.max_attempts, retry.delay_ms),
            (None, None, None)
        );
        assert!(retry.code.is_none());
        assert!(session_update(Some(AgentKind::ClaudeCode), &update).is_none());
        update["_meta"]["jetbrains"]["air"]["sessionFailure"]["id"] = json!("turn-1:notice:2");
        assert!(session_update(Some(AgentKind::Codex), &update).is_none());
    }
    #[test]
    fn codex_acp_222_accepts_retry_incident_after_recovered_output() {
        let update = json!({"sessionUpdate":"session_info_update","_meta":{"jetbrains":{"air":{"version":1,"sessionFailure":{"id":"turn-1:error:01f888b7-a040-4fe0-94ad-40ff454e385b:2","revision":1,"category":"connection","severity":"warning","title":"stream disconnected again","actions":[]}}}}});
        assert_eq!(
            session_update(Some(AgentKind::Codex), &update)
                .unwrap()
                .phase,
            RequestPhase::Retrying
        );
    }
    #[test]
    fn codex_retry_revisions_do_not_reopen_retired_incidents_or_prompts() {
        let prompt = crate::AgentPromptId::new();
        let next = crate::AgentPromptId::new();
        let mut ledger = RetryIncidentLedger::default();
        assert!(ledger.accept(prompt, "turn:error", 2));
        assert!(!ledger.accept(prompt, "turn:error", 1));
        assert!(!ledger.accept(prompt, "turn:error", 2));
        assert!(ledger.accept(prompt, "turn:error", 3));
        ledger.note_progress(prompt);
        assert!(!ledger.accept(prompt, "turn:error", 4));
        assert!(ledger.accept(
            prompt,
            "turn:error:01f888b7-a040-4fe0-94ad-40ff454e385b:2",
            1
        ));
        assert!(!ledger.accept(prompt, "turn:error", 5));
        assert!(ledger.accept(next, "next-turn:error", 1));
        assert!(!ledger.accept(next, "turn:error:01f888b7-a040-4fe0-94ad-40ff454e385b:2", 2));
    }
    #[test]
    fn ordinary_pi_text_never_becomes_runtime_activity() {
        for text in [
            "Retrying...",
            "Retrying (attempt 2/5, waiting 3s)...",
            "Retry finished, resuming.",
        ] {
            let update = json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}});
            assert!(session_update(Some(AgentKind::Pi), &update).is_none());
        }
    }
}
