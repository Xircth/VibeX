//! Coalesce CEF `OnScheduleMessagePumpWork` onto the host UI thread.
//!
//! CEF's external message pump is bound to Tauri's Windows event loop. A GPU
//! process crash (or a burst of browser commands) can request delay=0 work
//! thousands of times. Queueing each request as its own UI-thread task starves
//! `WM_PAINT` / input and Windows reports the app as hung.
//!
//! Immediate pumps must be *posted* to the native loop. Tauri runs
//! `run_on_main_thread` inline when already on the UI thread, and CEF calls
//! this callback from inside `CefDoMessageLoopWork`. A nested pump cannot
//! borrow the session and used to drop the follow-up, freezing the page.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CefPumpWork {
    Immediate,
    Delayed { delay_ms: u64, generation: u64 },
}

pub(crate) struct CefPumpController {
    generation: AtomicU64,
    immediate_queued: AtomicBool,
}

impl CefPumpController {
    pub(crate) const fn new() -> Self {
        Self {
            generation: AtomicU64::new(0),
            immediate_queued: AtomicBool::new(false),
        }
    }

    /// Map CEF's `delay_ms` to at most one outstanding UI-thread pump.
    ///
    /// Negative delay cancels pending delayed work. Delay 0 is coalesced: a
    /// second request while one is already queued is a no-op so the native
    /// message loop can still run. A later delayed request replaces any
    /// earlier delayed pump (CEF keeps a single pending timer).
    pub(crate) fn schedule(&self, delay_ms: i64) -> Option<CefPumpWork> {
        if delay_ms < 0 {
            self.generation.fetch_add(1, Ordering::Relaxed);
            return None;
        }
        if delay_ms == 0 {
            if self.immediate_queued.swap(true, Ordering::SeqCst) {
                return None;
            }
            return Some(CefPumpWork::Immediate);
        }
        let generation = self.generation.fetch_add(1, Ordering::Relaxed) + 1;
        Some(CefPumpWork::Delayed {
            delay_ms: delay_ms as u64,
            generation,
        })
    }

    pub(crate) fn delayed_is_current(&self, generation: u64) -> bool {
        self.generation.load(Ordering::Relaxed) == generation
    }

    /// Clear the coalescing slot so CEF can request exactly one follow-up
    /// pump while `CefDoMessageLoopWork` is running.
    pub(crate) fn begin_pump(&self) {
        self.immediate_queued.store(false, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::{CefPumpController, CefPumpWork};

    #[test]
    fn zero_delay_requests_coalesce_into_one_immediate_pump() {
        let pump = CefPumpController::new();

        assert_eq!(pump.schedule(0), Some(CefPumpWork::Immediate));
        for _ in 0..1_000 {
            assert_eq!(
                pump.schedule(0),
                None,
                "a queued immediate pump must absorb further delay=0 work"
            );
        }
    }

    #[test]
    fn beginning_a_pump_allows_exactly_one_follow_up() {
        let pump = CefPumpController::new();
        assert_eq!(pump.schedule(0), Some(CefPumpWork::Immediate));

        pump.begin_pump();
        assert_eq!(pump.schedule(0), Some(CefPumpWork::Immediate));
        assert_eq!(pump.schedule(0), None);
        assert_eq!(pump.schedule(0), None);
    }

    #[test]
    fn negative_delay_cancels_only_pending_delayed_work() {
        let pump = CefPumpController::new();
        let Some(CefPumpWork::Delayed {
            delay_ms,
            generation,
        }) = pump.schedule(16)
        else {
            panic!("positive delay must schedule delayed work");
        };
        assert_eq!(delay_ms, 16);
        assert!(pump.delayed_is_current(generation));

        assert_eq!(pump.schedule(-1), None);
        assert!(!pump.delayed_is_current(generation));

        assert_eq!(pump.schedule(0), Some(CefPumpWork::Immediate));
    }

    #[test]
    fn delayed_work_keeps_its_generation_across_unrelated_immediate_pumps() {
        let pump = CefPumpController::new();
        let Some(CefPumpWork::Delayed { generation, .. }) = pump.schedule(50) else {
            panic!("expected delayed work");
        };
        assert_eq!(pump.schedule(0), Some(CefPumpWork::Immediate));
        pump.begin_pump();
        assert!(pump.delayed_is_current(generation));
    }

    #[test]
    fn a_later_delayed_request_cancels_the_previous_delayed_pump() {
        let pump = CefPumpController::new();
        let Some(CefPumpWork::Delayed {
            generation: first, ..
        }) = pump.schedule(50)
        else {
            panic!("expected delayed work");
        };
        let Some(CefPumpWork::Delayed {
            generation: second,
            delay_ms,
        }) = pump.schedule(16)
        else {
            panic!("expected replacement delayed work");
        };
        assert_eq!(delay_ms, 16);
        assert_ne!(first, second);
        assert!(!pump.delayed_is_current(first));
        assert!(pump.delayed_is_current(second));
    }
}
