//! Periodic sweeper that disconnects ACP connections idle past a deadline.
//!
//! Connections accumulate when a conversation surface closes without an
//! explicit disconnect. The sweep drops Ready connections with no in-flight
//! turn once `last_activity` is older than the idle timeout (default 180s).
//! The runtime keeps each on-screen, already-bound conversation alive. The UI
//! only registers and forgets those ids. This process then bumps their
//! activity on its own cadence (30s, or half of a shorter idle timeout). That
//! bump does not connect, resume, or emit a status notice. Hiding the window
//! does not unregister: stopping would let this sweep reap every open
//! conversation, and the next focus would resume them together. Off-screen
//! surfaces unregister and become eligible here.
//!
//! Member sessions that currently belong to a hot collaboration group use a
//! longer idle timeout (default 20 minutes). Direct chats and cold groups keep
//! the ordinary 180s rule.

use std::{
    collections::HashSet,
    future::Future,
    pin::Pin,
    sync::Arc,
    time::Duration,
};

use tokio::sync::RwLock;

use crate::{AgentConnectionManager, AgentSessionId};

pub const DEFAULT_IDLE_TIMEOUT_SECS: u64 = 180;
pub const SWEEP_INTERVAL_SECS: u64 = 60;
pub const IDLE_TIMEOUT_ENV: &str = "VIBEX_ACP_IDLE_TIMEOUT_SECS";

/// How long a group stays hot after a user message, in-flight delivery, or warmup.
pub const DEFAULT_HOT_GROUP_WINDOW_SECS: u64 = 15 * 60;
pub const HOT_GROUP_WINDOW_ENV: &str = "VIBEX_ACP_HOT_GROUP_WINDOW_SECS";

/// Idle timeout applied to member sessions of a hot group.
pub const DEFAULT_HOT_GROUP_IDLE_TIMEOUT_SECS: u64 = 20 * 60;
pub const HOT_GROUP_IDLE_TIMEOUT_ENV: &str = "VIBEX_ACP_HOT_GROUP_IDLE_TIMEOUT_SECS";

pub fn idle_timeout_from_env() -> Option<Duration> {
    duration_from_env(IDLE_TIMEOUT_ENV, DEFAULT_IDLE_TIMEOUT_SECS)
}

pub fn hot_group_window_from_env() -> Option<Duration> {
    duration_from_env(HOT_GROUP_WINDOW_ENV, DEFAULT_HOT_GROUP_WINDOW_SECS)
}

pub fn hot_group_idle_timeout_from_env() -> Option<Duration> {
    duration_from_env(
        HOT_GROUP_IDLE_TIMEOUT_ENV,
        DEFAULT_HOT_GROUP_IDLE_TIMEOUT_SECS,
    )
}

fn duration_from_env(key: &str, default_secs: u64) -> Option<Duration> {
    let secs = match std::env::var(key) {
        Ok(raw) => raw.parse::<u64>().unwrap_or(default_secs),
        Err(_) => default_secs,
    };
    if secs == 0 {
        return None;
    }
    Some(Duration::from_secs(secs))
}

pub type ExtendedIdleSessionsLookup = Arc<
    dyn Fn() -> Pin<Box<dyn Future<Output = HashSet<AgentSessionId>> + Send>> + Send + Sync,
>;

/// Lookup installed after construction so collaboration can name hot sessions
/// without the agents crate querying SQLite.
#[derive(Clone, Default)]
pub struct IdleExtension {
    lookup: Arc<RwLock<Option<ExtendedIdleSessionsLookup>>>,
}

impl IdleExtension {
    pub async fn install(&self, lookup: ExtendedIdleSessionsLookup) {
        *self.lookup.write().await = Some(lookup);
    }

    pub async fn session_ids(&self) -> HashSet<AgentSessionId> {
        let lookup = self.lookup.read().await.clone();
        match lookup {
            Some(lookup) => lookup().await,
            None => HashSet::new(),
        }
    }
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
    extension: IdleExtension,
) {
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ticker.tick().await;
    loop {
        ticker.tick().await;
        let extended_ids = extension.session_ids().await;
        let extended = hot_group_idle_timeout_from_env().map(|timeout| (extended_ids, timeout));
        let n = manager
            .sweep_idle_with_extended(idle_timeout, extended)
            .await;
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
    fn hot_group_env_parsing_matches_idle_timeout_style() {
        let _lock = ENV_LOCK.lock().expect("env lock");
        unsafe {
            std::env::set_var(HOT_GROUP_WINDOW_ENV, "0");
            std::env::set_var(HOT_GROUP_IDLE_TIMEOUT_ENV, "0");
        }
        assert!(hot_group_window_from_env().is_none());
        assert!(hot_group_idle_timeout_from_env().is_none());

        unsafe {
            std::env::set_var(HOT_GROUP_WINDOW_ENV, "not-a-number");
            std::env::set_var(HOT_GROUP_IDLE_TIMEOUT_ENV, "nope");
        }
        assert_eq!(
            hot_group_window_from_env().unwrap().as_secs(),
            DEFAULT_HOT_GROUP_WINDOW_SECS
        );
        assert_eq!(
            hot_group_idle_timeout_from_env().unwrap().as_secs(),
            DEFAULT_HOT_GROUP_IDLE_TIMEOUT_SECS
        );

        unsafe {
            std::env::set_var(HOT_GROUP_WINDOW_ENV, "60");
            std::env::set_var(HOT_GROUP_IDLE_TIMEOUT_ENV, "120");
        }
        assert_eq!(hot_group_window_from_env().unwrap().as_secs(), 60);
        assert_eq!(hot_group_idle_timeout_from_env().unwrap().as_secs(), 120);

        unsafe {
            std::env::remove_var(HOT_GROUP_WINDOW_ENV);
            std::env::remove_var(HOT_GROUP_IDLE_TIMEOUT_ENV);
        }
        assert_eq!(
            hot_group_window_from_env().unwrap().as_secs(),
            DEFAULT_HOT_GROUP_WINDOW_SECS
        );
        assert_eq!(
            hot_group_idle_timeout_from_env().unwrap().as_secs(),
            DEFAULT_HOT_GROUP_IDLE_TIMEOUT_SECS
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
