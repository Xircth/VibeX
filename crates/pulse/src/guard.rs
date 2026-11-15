//! Anti-loop, hop-count, sliding-window rate breaker, and Mandate provenance guards.

use std::{
    collections::{HashMap, VecDeque},
    sync::Mutex,
};

use api_types::pulse::{EventEnvelope, EventTrace, MandateOrigin, PulseEvalMode, PulseRuleSpec};
use chrono::{DateTime, Duration, Utc};
use thiserror::Error;

pub const DEFAULT_MAX_HOP_COUNT: u32 = 5;
pub const DEFAULT_CHAIN_WINDOW_SECS: i64 = 60;
pub const DEFAULT_MAX_TRIGGERS_PER_WINDOW: usize = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnvelopeGuardVerdict {
    Allow,
    RejectedSelfActor,
    RejectedHopOverflow { hop_count: u32, max_hops: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum GuardError {
    #[error("self-emitted event rejected to prevent echo loops")]
    SelfActorRejected,
    #[error("event trace hop count {hop_count} exceeds maximum {max_hops}")]
    HopOverflow { hop_count: u32, max_hops: u32 },
}

/// Evaluates kernel-level anti-echo and cascade hop bounds before rule evaluation.
pub fn check_envelope_guard(envelope: &EventEnvelope, max_hops: u32) -> EnvelopeGuardVerdict {
    if envelope.actor.is_self {
        return EnvelopeGuardVerdict::RejectedSelfActor;
    }
    if envelope.trace.hop_count > max_hops {
        return EnvelopeGuardVerdict::RejectedHopOverflow {
            hop_count: envelope.trace.hop_count,
            max_hops,
        };
    }
    EnvelopeGuardVerdict::Allow
}

/// Computes the child `EventTrace` (`hop_count + 1`) when an automation run emits a derived event.
pub fn derive_child_trace(
    parent: &EventEnvelope,
    parent_run_id: Option<String>,
    max_hops: u32,
) -> Result<EventTrace, GuardError> {
    let next_hops = parent.trace.hop_count.saturating_add(1);
    if next_hops > max_hops {
        return Err(GuardError::HopOverflow {
            hop_count: next_hops,
            max_hops,
        });
    }
    Ok(EventTrace {
        root_event_id: if parent.trace.root_event_id.is_empty() {
            parent.event_id.clone()
        } else {
            parent.trace.root_event_id.clone()
        },
        parent_run_id,
        hop_count: next_hops,
    })
}

/// Enforces Mandate provenance law: rules proposed/saved during an untrusted external event turn
/// are forced into disabled draft-only `Observe` mode awaiting human confirmation.
pub fn enforce_mandate_origin(
    origin: MandateOrigin,
    requested_enabled: bool,
    mut spec: PulseRuleSpec,
) -> (bool, bool, PulseRuleSpec) {
    match origin {
        MandateOrigin::UntrustedExternal => {
            spec.eval_mode = PulseEvalMode::Observe;
            (false, true, spec)
        }
        MandateOrigin::ExplicitHuman | MandateOrigin::TrustedInternal => {
            (requested_enabled, false, spec)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RateBreakerDecision {
    Allowed {
        count_in_window: usize,
    },
    Tripped {
        count_in_window: usize,
        limit: usize,
    },
}

/// Thread-safe sliding-window per-`thread_key` chain rate circuit breaker.
#[derive(Debug)]
pub struct ChainRateBreaker {
    window: Duration,
    max_triggers: usize,
    buckets: Mutex<HashMap<String, VecDeque<DateTime<Utc>>>>,
}

impl Default for ChainRateBreaker {
    fn default() -> Self {
        Self::new(
            Duration::seconds(DEFAULT_CHAIN_WINDOW_SECS),
            DEFAULT_MAX_TRIGGERS_PER_WINDOW,
        )
    }
}

impl ChainRateBreaker {
    pub fn new(window: Duration, max_triggers: usize) -> Self {
        Self {
            window: if window <= Duration::zero() {
                Duration::seconds(1)
            } else {
                window
            },
            max_triggers: max_triggers.max(1),
            buckets: Mutex::new(HashMap::new()),
        }
    }

    pub fn max_triggers(&self) -> usize {
        self.max_triggers
    }

    pub fn window(&self) -> Duration {
        self.window
    }

    /// Records a trigger attempt for `thread_key` at `now` and checks whether the sliding-window
    /// budget has been exceeded.
    pub fn record_and_check(&self, thread_key: &str, now: DateTime<Utc>) -> RateBreakerDecision {
        let mut guard = self
            .buckets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let cutoff = now - self.window;

        guard.retain(|_, queue| {
            while let Some(&oldest) = queue.front() {
                if oldest <= cutoff {
                    queue.pop_front();
                } else {
                    break;
                }
            }
            !queue.is_empty()
        });

        let queue = guard.entry(thread_key.to_string()).or_default();
        if queue.len() >= self.max_triggers {
            return RateBreakerDecision::Tripped {
                count_in_window: queue.len() + 1,
                limit: self.max_triggers,
            };
        }

        queue.push_back(now);
        RateBreakerDecision::Allowed {
            count_in_window: queue.len(),
        }
    }

    pub fn active_bucket_count(&self) -> usize {
        self.buckets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .len()
    }

    pub fn reset_thread(&self, thread_key: &str) {
        let mut guard = self
            .buckets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.remove(thread_key);
    }
}
