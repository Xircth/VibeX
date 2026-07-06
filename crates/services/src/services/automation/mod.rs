//! Automation: saved "start a turn" configurations that run headlessly, on a
//! cron schedule or on demand. This module currently provides the schedule
//! evaluation core; persistence and the scheduler loop build on top of it.

pub mod schedule;

pub use schedule::{CronParseError, CronSchedule};
