//! Prompt Cache warm-preservation and idle compaction policy (`IdleCompaction`).
//!
//! Synthesizes `promptCacheExpiresAt` strictly for official Claude sessions (`5m`
//! ephemeral vs `1h` extended tiers) and triggers `/compact` `LEAD_MS` (2 minutes)
//! prior to cache expiration when estimated session context exceeds `100,000` tokens
//! and the user has been idle for at least `IDLE_GRACE_MS` (30 seconds).

use std::{
    collections::HashMap,
    sync::{
        RwLock,
        atomic::{AtomicBool, Ordering},
    },
};

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Lead window before Prompt Cache expiration within which `/compact` should run (2 minutes).
pub const LEAD_MS: i64 = 120_000;

/// Minimum estimated context token count before idle compaction is worthwhile.
pub const TOKEN_THRESHOLD: usize = 100_000;

/// Minimum user inactivity window before auto-compaction may fire (30 seconds).
pub const IDLE_GRACE_MS: i64 = 30_000;

/// Anthropic Prompt Cache TTL tier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CacheTier {
    #[default]
    FiveMinute,
    OneHour,
}

impl CacheTier {
    pub const fn ttl_ms(self) -> i64 {
        match self {
            Self::FiveMinute => 5 * 60 * 1_000,
            Self::OneHour => 60 * 60 * 1_000,
        }
    }
}

/// Outcome of evaluating whether a Claude session should run `/compact` now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "decision", content = "reason", rename_all = "snake_case")]
pub enum CompactionDecision {
    Compact,
    Skip(String),
}

#[derive(Debug, Clone)]
pub struct SessionIdleSnapshot {
    pub session_id: Uuid,
    pub last_activity_at: DateTime<Utc>,
    pub estimated_tokens: usize,
    pub cache_expires_at: Option<DateTime<Utc>>,
    pub cache_tier: CacheTier,
    pub is_official_claude_session: bool,
    pub last_compacted_expiry: Option<DateTime<Utc>>,
}

/// Coordinator tracking per-session idle timestamps, official-session eligibility,
/// and global user enable/disable preference for Claude idle cache compaction.
pub struct IdleCompaction {
    enabled: AtomicBool,
    sessions: RwLock<HashMap<Uuid, SessionIdleSnapshot>>,
}

impl std::fmt::Debug for IdleCompaction {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IdleCompaction")
            .field("enabled", &self.is_enabled())
            .finish()
    }
}

impl Default for IdleCompaction {
    fn default() -> Self {
        Self::new(true)
    }
}

impl IdleCompaction {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled: AtomicBool::new(enabled),
            sessions: RwLock::new(HashMap::new()),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Acquire)
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Release);
    }

    /// Synthesizes `promptCacheExpiresAt` from request dispatch timestamp + `cache_tier`.
    ///
    /// Strictly returns `None` for non-official / third-party proxy sessions.
    pub fn synthesize_cache_expiry(
        request_time: DateTime<Utc>,
        cache_tier: CacheTier,
        is_official_claude_session: bool,
    ) -> Option<DateTime<Utc>> {
        if !is_official_claude_session {
            return None;
        }
        Some(request_time + Duration::milliseconds(cache_tier.ttl_ms()))
    }

    /// Records turn completion or user activity for `session_id` so the 30s idle
    /// grace guard prevents interrupting active back-and-forth conversations.
    pub fn record_session_activity(
        &self,
        session_id: Uuid,
        activity_time: DateTime<Utc>,
        estimated_tokens: usize,
        cache_tier: CacheTier,
        cache_expires_at: Option<DateTime<Utc>>,
        is_official_claude_session: bool,
    ) {
        if let Ok(mut map) = self.sessions.write() {
            let prev_compacted = map
                .get(&session_id)
                .and_then(|existing| existing.last_compacted_expiry);
            map.insert(
                session_id,
                SessionIdleSnapshot {
                    session_id,
                    last_activity_at: activity_time,
                    estimated_tokens,
                    cache_expires_at: if is_official_claude_session {
                        cache_expires_at
                    } else {
                        None
                    },
                    cache_tier,
                    is_official_claude_session,
                    last_compacted_expiry: prev_compacted,
                },
            );
        }
    }

    pub fn remove_session(&self, session_id: Uuid) {
        if let Ok(mut map) = self.sessions.write() {
            map.remove(&session_id);
        }
    }

    pub fn session_snapshot(&self, session_id: Uuid) -> Option<SessionIdleSnapshot> {
        self.sessions
            .read()
            .ok()
            .and_then(|map| map.get(&session_id).cloned())
    }

    /// Evaluates at wall-clock `now` whether `session_id` should trigger `/compact`.
    pub fn evaluate_at(
        &self,
        session_id: Uuid,
        estimated_tokens: usize,
        cache_expires_at: DateTime<Utc>,
        now: DateTime<Utc>,
    ) -> CompactionDecision {
        if !self.is_enabled() {
            return CompactionDecision::Skip("idle compaction disabled".to_string());
        }

        if let Ok(map) = self.sessions.read()
            && let Some(snapshot) = map.get(&session_id)
        {
            if !snapshot.is_official_claude_session {
                return CompactionDecision::Skip("non-official Claude session".to_string());
            }
            let idle_ms = (now - snapshot.last_activity_at).num_milliseconds();
            if idle_ms < IDLE_GRACE_MS {
                return CompactionDecision::Skip(format!(
                    "session idle for {idle_ms}ms (requires {IDLE_GRACE_MS}ms grace)"
                ));
            }
            if snapshot.last_compacted_expiry == Some(cache_expires_at) {
                return CompactionDecision::Skip(
                    "already compacted for current cache expiry window".to_string(),
                );
            }
        }

        if estimated_tokens < TOKEN_THRESHOLD {
            return CompactionDecision::Skip("token count below threshold".to_string());
        }

        let time_to_expiry = (cache_expires_at - now).num_milliseconds();
        if time_to_expiry <= 0 {
            return CompactionDecision::Skip("cache already expired".to_string());
        }

        if time_to_expiry <= LEAD_MS {
            if let Ok(mut map) = self.sessions.write()
                && let Some(snapshot) = map.get_mut(&session_id)
            {
                snapshot.last_compacted_expiry = Some(cache_expires_at);
            }
            return CompactionDecision::Compact;
        }

        CompactionDecision::Skip(format!("cache still valid for {time_to_expiry}ms"))
    }

    /// Async entrypoint checking whether `session_id` should run `/compact` right now.
    pub async fn check_and_compact(
        &self,
        session_id: Uuid,
        estimated_tokens: usize,
        cache_expires_at: DateTime<Utc>,
    ) -> CompactionDecision {
        self.evaluate_at(session_id, estimated_tokens, cache_expires_at, Utc::now())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn synthesize_cache_expiry_enforces_official_session_and_tier_durations() {
        let base = DateTime::parse_from_rfc3339("2026-11-14T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        assert_eq!(
            IdleCompaction::synthesize_cache_expiry(base, CacheTier::FiveMinute, false),
            None
        );
        assert_eq!(
            IdleCompaction::synthesize_cache_expiry(base, CacheTier::OneHour, false),
            None
        );

        let five_min =
            IdleCompaction::synthesize_cache_expiry(base, CacheTier::FiveMinute, true).unwrap();
        assert_eq!((five_min - base).num_minutes(), 5);

        let one_hour =
            IdleCompaction::synthesize_cache_expiry(base, CacheTier::OneHour, true).unwrap();
        assert_eq!((one_hour - base).num_minutes(), 60);
    }

    #[tokio::test]
    async fn triggers_compaction_only_within_lead_window_above_threshold_and_after_idle_grace() {
        let compaction = IdleCompaction::default();
        let session_id = Uuid::new_v4();
        let t0 = DateTime::parse_from_rfc3339("2026-11-14T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let expires_at =
            IdleCompaction::synthesize_cache_expiry(t0, CacheTier::FiveMinute, true).unwrap();

        compaction.record_session_activity(
            session_id,
            t0,
            150_000,
            CacheTier::FiveMinute,
            Some(expires_at),
            true,
        );

        // 10s after turn: inside 30s idle grace -> Skip.
        let decision_active =
            compaction.evaluate_at(session_id, 150_000, expires_at, t0 + Duration::seconds(10));
        assert!(matches!(decision_active, CompactionDecision::Skip(_)));

        // 60s after turn: 4m left (> LEAD_MS 2m) -> Skip.
        let decision_early =
            compaction.evaluate_at(session_id, 150_000, expires_at, t0 + Duration::seconds(60));
        assert!(matches!(decision_early, CompactionDecision::Skip(_)));

        // Below token threshold -> Skip.
        let decision_small =
            compaction.evaluate_at(session_id, 80_000, expires_at, t0 + Duration::seconds(200));
        assert_eq!(
            decision_small,
            CompactionDecision::Skip("token count below threshold".to_string())
        );

        // 200s after turn (100s <= LEAD_MS 120s remaining, 150k >= 100k, idle 200s >= 30s) -> Compact!
        let decision_ready =
            compaction.evaluate_at(session_id, 150_000, expires_at, t0 + Duration::seconds(200));
        assert_eq!(decision_ready, CompactionDecision::Compact);

        // Dedupes repeated evaluation for the exact same expiry window.
        let decision_dup =
            compaction.evaluate_at(session_id, 150_000, expires_at, t0 + Duration::seconds(210));
        assert!(matches!(decision_dup, CompactionDecision::Skip(_)));

        // Global disable flag suppresses compaction.
        compaction.set_enabled(false);
        let s2 = Uuid::new_v4();
        assert_eq!(
            compaction.evaluate_at(s2, 200_000, expires_at, t0 + Duration::seconds(220)),
            CompactionDecision::Skip("idle compaction disabled".to_string())
        );
    }
}
