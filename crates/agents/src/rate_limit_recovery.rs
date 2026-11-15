//! Automatic rate-limit recovery worker (`UsageLimitRecovery`).
//!
//! Parses `resetAt` timestamps from Codex (`account/rateLimits/updated`) and Claude
//! (`SDKRateLimitInfo`) events, tracks per-session countdown state with user-editable
//! `auto_resume` and `continuation_prompt`, and dispatches `"Continue where you left off."`
//! via `tokio::time::sleep_until` when the quota window resets.

use std::{
    collections::HashMap,
    sync::{Arc, RwLock},
    time::Duration,
};

use api_types::AgentKind;
use chrono::{DateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::{sync::broadcast, task::AbortHandle};
use uuid::Uuid;

pub const DEFAULT_CONTINUATION_PROMPT: &str = "Continue where you left off.";
const EVENT_CHANNEL_CAPACITY: usize = 128;

#[derive(Debug, thiserror::Error)]
pub enum RateLimitRecoveryError {
    #[error("Could not parse rate-limit resetAt timestamp from `{engine_id}` payload")]
    MissingResetTimestamp { engine_id: String },

    #[error("Session `{0}` does not have an active rate-limit wait state")]
    SessionNotRateLimited(Uuid),
}

/// Snapshot of a session's active rate-limit countdown and auto-resume configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitState {
    pub session_id: Uuid,
    pub engine_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_kind: Option<AgentKind>,
    pub limited_at: DateTime<Utc>,
    pub reset_at: DateTime<Utc>,
    pub auto_resume: bool,
    pub continuation_prompt: String,
}

/// Lifecycle notifications emitted by [`UsageLimitRecovery`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RateLimitRecoveryEvent {
    RateLimited {
        state: RateLimitState,
    },
    Updated {
        state: RateLimitState,
    },
    AutoResumed {
        session_id: Uuid,
        engine_id: String,
        continuation_prompt: String,
    },
    Cancelled {
        session_id: Uuid,
    },
}

struct SessionWaitEntry {
    state: RateLimitState,
    abort_handle: Option<AbortHandle>,
}

type ResumeCallback = Arc<dyn Fn(Uuid, String) + Send + Sync>;

/// Per-session rate-limit countdown coordinator.
#[derive(Clone)]
pub struct UsageLimitRecovery {
    sessions: Arc<RwLock<HashMap<Uuid, SessionWaitEntry>>>,
    event_tx: broadcast::Sender<RateLimitRecoveryEvent>,
    resume_callback: Option<ResumeCallback>,
}

impl std::fmt::Debug for UsageLimitRecovery {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let active_count = self.sessions.read().map(|m| m.len()).unwrap_or(0);
        f.debug_struct("UsageLimitRecovery")
            .field("active_sessions", &active_count)
            .finish()
    }
}

impl Default for UsageLimitRecovery {
    fn default() -> Self {
        Self::new()
    }
}

impl UsageLimitRecovery {
    pub fn new() -> Self {
        let (event_tx, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            event_tx,
            resume_callback: None,
        }
    }

    pub fn with_resume_callback<F>(callback: F) -> Self
    where
        F: Fn(Uuid, String) + Send + Sync + 'static,
    {
        let (event_tx, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            event_tx,
            resume_callback: Some(Arc::new(callback)),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<RateLimitRecoveryEvent> {
        self.event_tx.subscribe()
    }

    /// Parses a rate-limit reset timestamp from native Codex or Claude payloads.
    ///
    /// Supports:
    /// - Codex `account/rateLimits/updated` (`rateLimits.primary.resetsAt`,
    ///   `rateLimitsByLimitId.codex.primary.resetsAt`, or `rate_limits[]` entries with
    ///   `remaining == 0` / `usedPercent >= 100`, in epoch seconds or milliseconds)
    /// - Claude `SDKRateLimitInfo` (`resetAt`, `resetsAt`, `reset_at`,
    ///   `rate_limit.error.resets.at` in RFC3339/ISO-8601 or epoch seconds/ms)
    pub fn parse_reset_at(engine_id: &str, event: &Value) -> Option<DateTime<Utc>> {
        let normalized_engine = engine_id.trim().to_ascii_lowercase();
        if normalized_engine.contains("codex") {
            if let Some(dt) = parse_codex_reset_at(event) {
                return Some(dt);
            }
        }
        if normalized_engine.contains("claude") {
            if let Some(dt) = parse_claude_reset_at(event) {
                return Some(dt);
            }
        }
        parse_claude_reset_at(event).or_else(|| parse_codex_reset_at(event))
    }

    /// Records a rate-limited session from a raw engine event and schedules an
    /// abortable `tokio::time::sleep_until` auto-resume timer.
    pub fn on_rate_limited(
        &self,
        session_id: Uuid,
        engine_id: &str,
        event: &Value,
    ) -> Result<RateLimitState, RateLimitRecoveryError> {
        let reset_at = Self::parse_reset_at(engine_id, event).ok_or_else(|| {
            RateLimitRecoveryError::MissingResetTimestamp {
                engine_id: engine_id.to_string(),
            }
        })?;
        Ok(self.schedule_session_wait(session_id, engine_id, reset_at))
    }

    /// Schedules a rate-limit wait directly with an already-parsed `reset_at` timestamp.
    pub fn schedule_session_wait(
        &self,
        session_id: Uuid,
        engine_id: &str,
        reset_at: DateTime<Utc>,
    ) -> RateLimitState {
        let now = Utc::now();
        let agent_kind = engine_id.parse::<AgentKind>().ok();
        let state = RateLimitState {
            session_id,
            engine_id: engine_id.to_string(),
            agent_kind,
            limited_at: now,
            reset_at,
            auto_resume: true,
            continuation_prompt: DEFAULT_CONTINUATION_PROMPT.to_string(),
        };

        let wait_ms = (reset_at - now).num_milliseconds().max(0) as u64;
        let deadline = tokio::time::Instant::now() + Duration::from_millis(wait_ms);

        let sessions_ref = Arc::clone(&self.sessions);
        let event_tx = self.event_tx.clone();
        let callback = self.resume_callback.clone();

        let join_handle = tokio::spawn(async move {
            tokio::time::sleep_until(deadline).await;

            let maybe_entry = sessions_ref
                .write()
                .ok()
                .and_then(|mut map| map.remove(&session_id));

            let Some(entry) = maybe_entry else {
                return;
            };

            if entry.state.auto_resume {
                if let Some(cb) = callback {
                    cb(session_id, entry.state.continuation_prompt.clone());
                }
                let _ = event_tx.send(RateLimitRecoveryEvent::AutoResumed {
                    session_id,
                    engine_id: entry.state.engine_id,
                    continuation_prompt: entry.state.continuation_prompt,
                });
            } else {
                let _ = event_tx.send(RateLimitRecoveryEvent::Cancelled { session_id });
            }
        });

        let abort_handle = join_handle.abort_handle();
        if let Ok(mut map) = self.sessions.write() {
            if let Some(prev) = map.insert(
                session_id,
                SessionWaitEntry {
                    state: state.clone(),
                    abort_handle: Some(abort_handle),
                },
            ) && let Some(prev_abort) = prev.abort_handle
            {
                prev_abort.abort();
            }
        }

        let _ = self.event_tx.send(RateLimitRecoveryEvent::RateLimited {
            state: state.clone(),
        });
        state
    }

    /// Updates `auto_resume` and/or `continuation_prompt` for an active rate-limited session.
    pub fn set_auto_resume(
        &self,
        session_id: Uuid,
        auto_resume: bool,
        continuation_prompt: Option<String>,
    ) -> Result<RateLimitState, RateLimitRecoveryError> {
        let updated = {
            let mut map = self
                .sessions
                .write()
                .map_err(|_| RateLimitRecoveryError::SessionNotRateLimited(session_id))?;
            let entry = map
                .get_mut(&session_id)
                .ok_or(RateLimitRecoveryError::SessionNotRateLimited(session_id))?;
            entry.state.auto_resume = auto_resume;
            if let Some(prompt) = continuation_prompt {
                let trimmed = prompt.trim();
                if !trimmed.is_empty() {
                    entry.state.continuation_prompt = trimmed.to_string();
                }
            }
            entry.state.clone()
        };

        let _ = self.event_tx.send(RateLimitRecoveryEvent::Updated {
            state: updated.clone(),
        });
        Ok(updated)
    }

    /// Cancels an active rate-limit countdown immediately and aborts its background timer.
    pub fn cancel_wait(&self, session_id: Uuid) -> bool {
        let removed = self
            .sessions
            .write()
            .ok()
            .and_then(|mut map| map.remove(&session_id));
        if let Some(entry) = removed {
            if let Some(abort) = entry.abort_handle {
                abort.abort();
            }
            let _ = self
                .event_tx
                .send(RateLimitRecoveryEvent::Cancelled { session_id });
            return true;
        }
        false
    }

    pub fn get_state(&self, session_id: Uuid) -> Option<RateLimitState> {
        self.sessions
            .read()
            .ok()
            .and_then(|map| map.get(&session_id).map(|entry| entry.state.clone()))
    }

    pub fn get_rate_limit_state(&self, session_id: Uuid) -> Option<RateLimitState> {
        self.get_state(session_id)
    }
}

fn parse_flexible_timestamp(value: &Value) -> Option<DateTime<Utc>> {
    if let Some(raw_str) = value.as_str() {
        let trimmed = raw_str.trim();
        if trimmed.is_empty() {
            return None;
        }
        if let Ok(dt) = DateTime::parse_from_rfc3339(trimmed) {
            return Some(dt.with_timezone(&Utc));
        }
        if let Ok(num) = trimmed.parse::<f64>() {
            return epoch_f64_to_utc(num);
        }
        return None;
    }

    if let Some(num) = value.as_f64() {
        return epoch_f64_to_utc(num);
    }
    None
}

fn epoch_f64_to_utc(value: f64) -> Option<DateTime<Utc>> {
    if !value.is_finite() || value <= 0.0 {
        return None;
    }
    let millis = if value > 1_000_000_000_000.0 {
        value as i64
    } else {
        (value * 1000.0) as i64
    };
    Utc.timestamp_millis_opt(millis).single()
}

fn parse_codex_reset_at(event: &Value) -> Option<DateTime<Utc>> {
    let params = event.get("params").unwrap_or(event);

    if let Some(arr) = params.get("rate_limits").and_then(Value::as_array) {
        for item in arr {
            let exhausted = item
                .get("remaining")
                .and_then(Value::as_i64)
                .is_some_and(|rem| rem <= 0);
            if exhausted
                && let Some(reset_val) = item.get("reset").or_else(|| item.get("resetsAt"))
                && let Some(dt) = parse_flexible_timestamp(reset_val)
            {
                return Some(dt);
            }
        }
    }

    let snapshot = params
        .get("rateLimitsByLimitId")
        .and_then(|by_id| by_id.get("codex"))
        .filter(|v| v.is_object())
        .or_else(|| params.get("rateLimits").filter(|v| v.is_object()))
        .unwrap_or(params);

    for window_key in ["primary", "secondary"] {
        if let Some(window) = snapshot.get(window_key)
            && let Some(reset_val) = window
                .get("resetsAt")
                .or_else(|| window.get("resetAt"))
                .or_else(|| window.get("reset_at"))
            && let Some(dt) = parse_flexible_timestamp(reset_val)
        {
            return Some(dt);
        }
    }

    snapshot
        .get("resetsAt")
        .or_else(|| snapshot.get("resetAt"))
        .or_else(|| snapshot.get("reset_at"))
        .and_then(parse_flexible_timestamp)
}

fn parse_claude_reset_at(event: &Value) -> Option<DateTime<Utc>> {
    let root = event.get("params").unwrap_or(event);

    let candidates = [
        root.get("resetAt"),
        root.get("resetsAt"),
        root.get("reset_at"),
        root.get("resets_at"),
        root.get("rateLimits").and_then(|r| r.get("resetAt")),
        root.get("rateLimits").and_then(|r| r.get("resetsAt")),
        root.get("rate_limit_info").and_then(|r| r.get("resetAt")),
        root.get("rate_limit_info").and_then(|r| r.get("resets_at")),
        root.get("rate_limit")
            .and_then(|r| r.get("error"))
            .and_then(|e| e.get("resets"))
            .and_then(|resets| resets.get("at")),
        root.get("rate_limit").and_then(|r| r.get("reset_at")),
    ];

    for candidate in candidates.into_iter().flatten() {
        if let Some(dt) = parse_flexible_timestamp(candidate) {
            return Some(dt);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tokio::sync::mpsc;

    use super::*;

    #[test]
    fn parses_codex_and_claude_reset_timestamps_across_formats() {
        let codex_sec = json!({
            "method": "account/rateLimits/updated",
            "params": {
                "rateLimits": {
                    "primary": { "usedPercent": 100.0, "resetsAt": 1_800_000_000 }
                }
            }
        });
        let parsed_codex =
            UsageLimitRecovery::parse_reset_at("codex", &codex_sec).expect("codex sec");
        assert_eq!(parsed_codex.timestamp(), 1_800_000_000);

        let codex_ms = json!({
            "rateLimitsByLimitId": {
                "codex": {
                    "secondary": { "usedPercent": 100.0, "resetsAt": 1_800_000_000_500.0 }
                }
            }
        });
        let parsed_codex_ms =
            UsageLimitRecovery::parse_reset_at("codex-native", &codex_ms).expect("codex ms");
        assert_eq!(parsed_codex_ms.timestamp_millis(), 1_800_000_000_500);

        let claude_iso = json!({
            "rate_limit": {
                "error": {
                    "resets": { "at": "2026-11-14T20:30:00Z" }
                }
            }
        });
        let parsed_claude =
            UsageLimitRecovery::parse_reset_at("claude_code", &claude_iso).expect("claude iso");
        assert_eq!(parsed_claude.to_rfc3339(), "2026-11-14T20:30:00+00:00");
    }

    #[tokio::test]
    async fn fires_auto_resume_continuation_prompt_when_reset_timer_expires() {
        let (tx, mut rx) = mpsc::unbounded_channel::<(Uuid, String)>();
        let recovery = UsageLimitRecovery::with_resume_callback(move |sid, prompt| {
            let _ = tx.send((sid, prompt));
        });

        let session_id = Uuid::new_v4();
        let reset_at = Utc::now() + chrono::Duration::milliseconds(40);
        let state = recovery.schedule_session_wait(session_id, "codex", reset_at);
        assert!(state.auto_resume);
        assert_eq!(state.continuation_prompt, DEFAULT_CONTINUATION_PROMPT);
        assert!(recovery.get_state(session_id).is_some());

        let (resumed_sid, prompt) = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("timer fired within timeout")
            .expect("channel yielded resume");
        assert_eq!(resumed_sid, session_id);
        assert_eq!(prompt, "Continue where you left off.");
        assert!(recovery.get_state(session_id).is_none());
    }

    #[tokio::test]
    async fn set_auto_resume_false_suppresses_dispatch_and_cancel_wait_aborts_immediately() {
        let (tx, mut rx) = mpsc::unbounded_channel::<(Uuid, String)>();
        let recovery = UsageLimitRecovery::with_resume_callback(move |sid, prompt| {
            let _ = tx.send((sid, prompt));
        });
        let mut events = recovery.subscribe();

        // Case 1: `set_auto_resume(false)` suppresses callback when timer expires.
        let s1 = Uuid::new_v4();
        recovery.schedule_session_wait(
            s1,
            "claude_code",
            Utc::now() + chrono::Duration::milliseconds(40),
        );
        recovery
            .set_auto_resume(s1, false, Some("Custom prompt".to_string()))
            .expect("update auto_resume");

        tokio::time::sleep(Duration::from_millis(90)).await;
        assert!(
            rx.try_recv().is_err(),
            "auto_resume=false must not dispatch prompt"
        );
        assert!(recovery.get_state(s1).is_none());

        // Case 2: `cancel_wait` aborts long timer immediately.
        let s2 = Uuid::new_v4();
        recovery.schedule_session_wait(s2, "codex", Utc::now() + chrono::Duration::hours(1));
        assert!(recovery.cancel_wait(s2));
        assert!(recovery.get_state(s2).is_none());

        let mut saw_cancelled = false;
        while let Ok(ev) = events.try_recv() {
            if matches!(ev, RateLimitRecoveryEvent::Cancelled { session_id } if session_id == s2) {
                saw_cancelled = true;
            }
        }
        assert!(saw_cancelled);
    }
}
