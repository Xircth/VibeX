//! Periodic sweeper that disconnects ACP connections idle past a deadline.
//!
//! Connections accumulate when frontends close a tab without an explicit
//! disconnect. The sweep prevents leaked ACP child processes. Keepalive is
//! `conversation_touch` (~30s) on the active conversation.

use std::time::Duration;

use crate::AgentConnectionManager;

pub const DEFAULT_IDLE_TIMEOUT_SECS: u64 = 180;
pub const SWEEP_INTERVAL_SECS: u64 = 60;
pub const IDLE_TIMEOUT_ENV: &str = "VIBEX_ACP_IDLE_TIMEOUT_SECS";

pub fn idle_timeout_from_env() -> Option<Duration> {
    let secs = match std::env::var(IDLE_TIMEOUT_ENV) {
        Ok(raw) => raw.parse::<u64>().unwrap_or(DEFAULT_IDLE_TIMEOUT_SECS),
        Err(_) => DEFAULT_IDLE_TIMEOUT_SECS,
    };
    if secs == 0 {
        return None;
    }
    Some(Duration::from_secs(secs))
}

pub fn touch_interval_from_idle_timeout(idle_timeout: Duration) -> Duration {
    let half = idle_timeout / 2;
    let thirty = Duration::from_secs(30);
    if half < thirty { half } else { thirty }
}

pub async fn idle_sweep_task(
    manager: std::sync::Arc<AgentConnectionManager>,
    idle_timeout: Duration,
    interval: Duration,
) {
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ticker.tick().await;
    loop {
        ticker.tick().await;
        let n = manager.sweep_idle(idle_timeout).await;
        crate::session_bind_metrics::record_idle_sweep_disconnects(n);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_timeout_env_parsing() {
        let _lock = ENV_LOCK.lock().expect("env lock");
        unsafe {
            std::env::set_var(IDLE_TIMEOUT_ENV, "0");
        }
        assert!(idle_timeout_from_env().is_none());

        unsafe {
            std::env::set_var(IDLE_TIMEOUT_ENV, "not-a-number");
        }
        assert_eq!(
            idle_timeout_from_env().unwrap().as_secs(),
            DEFAULT_IDLE_TIMEOUT_SECS
        );

        unsafe {
            std::env::set_var(IDLE_TIMEOUT_ENV, "120");
        }
        assert_eq!(idle_timeout_from_env().unwrap().as_secs(), 120);

        unsafe {
            std::env::remove_var(IDLE_TIMEOUT_ENV);
        }
        assert_eq!(
            idle_timeout_from_env().unwrap().as_secs(),
            DEFAULT_IDLE_TIMEOUT_SECS
        );
    }

    #[test]
    fn touch_cadence_is_strictly_less_than_idle_timeout() {
        let idle = Duration::from_secs(180);
        let cadence = touch_interval_from_idle_timeout(idle);
        assert!(cadence < idle);
        assert_eq!(cadence, Duration::from_secs(30));

        let short = Duration::from_secs(20);
        let cadence = touch_interval_from_idle_timeout(short);
        assert!(cadence < short);
        assert_eq!(cadence, Duration::from_secs(10));
    }

    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
}
