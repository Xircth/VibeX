use super::*;

pub(in crate::manager) struct SessionRestoreSupport {
    pub(in crate::manager) load: bool,
    pub(in crate::manager) resume: bool,
}

pub(in crate::manager) const DEFAULT_THROTTLE_WINDOW: Duration = Duration::from_secs(10);
pub(in crate::manager) const EMPTY_TURN_STDERR_MAX_LINES: usize = 20;
pub(in crate::manager) const EMPTY_TURN_STDERR_MAX_BYTES: usize = 2048;

/// Leading-edge log rate limiter for noisy per-frame ACP deserialization warnings.
///
/// The first event in a window is emitted immediately (`Some(suppressed)` where
/// `suppressed` is the count suppressed in the *preceding* window). Subsequent
/// events within `window` increment the counter and return `None`.
#[derive(Debug)]
pub struct LeadingEdgeThrottle {
    window_ns: u64,
    epoch: std::time::Instant,
    window_start_ns: std::sync::atomic::AtomicU64,
    suppressed_in_window: std::sync::atomic::AtomicU64,
    state_lock: std::sync::Mutex<()>,
}

pub(in crate::manager) const NO_WINDOW: u64 = u64::MAX;

impl LeadingEdgeThrottle {
    pub fn new(window: Duration) -> Self {
        let nanos = window.as_nanos().min(u64::MAX as u128 - 1) as u64;
        Self {
            window_ns: nanos,
            epoch: std::time::Instant::now(),
            window_start_ns: std::sync::atomic::AtomicU64::new(NO_WINDOW),
            suppressed_in_window: std::sync::atomic::AtomicU64::new(0),
            state_lock: std::sync::Mutex::new(()),
        }
    }

    pub fn check(&self) -> Option<u64> {
        let now_ns = self.epoch.elapsed().as_nanos().min(u64::MAX as u128 - 1) as u64;
        self.check_at(now_ns)
    }

    pub fn check_at(&self, elapsed_ns: u64) -> Option<u64> {
        let start = self.window_start_ns.load(Ordering::Acquire);
        if start != NO_WINDOW && elapsed_ns.saturating_sub(start) < self.window_ns {
            self.suppressed_in_window.fetch_add(1, Ordering::Relaxed);
            return None;
        }

        let _guard = self
            .state_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let start = self.window_start_ns.load(Ordering::Relaxed);
        if start != NO_WINDOW && elapsed_ns.saturating_sub(start) < self.window_ns {
            self.suppressed_in_window.fetch_add(1, Ordering::Relaxed);
            return None;
        }

        let suppressed = self.suppressed_in_window.swap(0, Ordering::Relaxed);
        self.window_start_ns.store(elapsed_ns, Ordering::Release);
        Some(suppressed)
    }

    pub fn flush(&self) -> u64 {
        let _guard = self
            .state_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.window_start_ns.store(NO_WINDOW, Ordering::Release);
        self.suppressed_in_window.swap(0, Ordering::Relaxed)
    }
}

impl Default for LeadingEdgeThrottle {
    fn default() -> Self {
        Self::new(DEFAULT_THROTTLE_WINDOW)
    }
}

