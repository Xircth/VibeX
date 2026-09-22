//! Connect-time session bind observability (ADR-0081).
//!
//! This crate has no metrics backend; counts are atomics surfaced through
//! structured `tracing` so operators can scrape logs.

use std::sync::atomic::{AtomicU64, Ordering};

static PROMPT_UNBOUND_TOTAL: AtomicU64 = AtomicU64::new(0);
static IDLE_SWEEP_DISCONNECTS: AtomicU64 = AtomicU64::new(0);

pub fn record_connect_start(
    conversation_id: uuid::Uuid,
    agent_id: &crate::AgentId,
    has_external_id: bool,
    attempt: &'static str,
) {
    tracing::info!(
        conversation_id = %conversation_id,
        agent_id = %agent_id,
        has_external_id,
        attempt,
        "ACP connect-time session bind started"
    );
}

pub fn record_resume_fell_through_to_load(session_id: uuid::Uuid, error: &str) {
    tracing::warn!(
        session_id = %session_id,
        error,
        "ACP session/resume failed; falling through to session/load"
    );
}

pub fn record_bind_ready(session_id: uuid::Uuid, result: &'static str, elapsed_ms: u128) {
    tracing::info!(
        session_id = %session_id,
        acp_session_bind_result = result,
        elapsed_ms,
        "ACP session bind ready"
    );
}

pub fn record_prompt_unbound(session_id: uuid::Uuid) {
    let total = PROMPT_UNBOUND_TOTAL.fetch_add(1, Ordering::Relaxed) + 1;
    tracing::error!(
        session_id = %session_id,
        acp_prompt_unbound_total = total,
        "ACP prompt reached an unbound connection; session/new is forbidden"
    );
}

pub fn record_idle_sweep_disconnects(count: usize) {
    if count == 0 {
        return;
    }
    let total = IDLE_SWEEP_DISCONNECTS.fetch_add(count as u64, Ordering::Relaxed) + count as u64;
    tracing::info!(
        count,
        acp_idle_sweep_disconnects = total,
        "ACP idle sweep disconnected connection(s)"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_unbound_increments() {
        let before = PROMPT_UNBOUND_TOTAL.load(Ordering::Relaxed);
        record_prompt_unbound(uuid::Uuid::nil());
        assert!(PROMPT_UNBOUND_TOTAL.load(Ordering::Relaxed) > before);
    }
}
