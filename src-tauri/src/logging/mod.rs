//! Application diagnostic logging built on `tracing`.
//!
//! One subscriber feeds three sinks: stderr, a daily-rotating text file under
//! [`utils::assets::logs_dir`], and an in-memory ring buffer the Settings →
//! Logs viewer reads and live-tails.

pub mod hub;
pub mod init;
pub mod layer;

pub use hub::attach_emitter;
pub use init::init_logging;
use serde::{Deserialize, Serialize};

pub const LOG_SETTINGS_CHANGED_EVENT: &str = "log-settings://changed";
pub const LOG_APPENDED_EVENT: &str = "logs://appended";

/// Minimum severity captured by the subscriber. `Off` disables capture.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    All,
    Off,
    Error,
    Warn,
    #[default]
    Info,
    Debug,
    Trace,
}

impl LogLevel {
    pub fn directive(self) -> &'static str {
        match self {
            LogLevel::All | LogLevel::Trace => "trace",
            LogLevel::Off => "off",
            LogLevel::Error => "error",
            LogLevel::Warn => "warn",
            LogLevel::Info => "info",
            LogLevel::Debug => "debug",
        }
    }
}

/// Per-target override, e.g. `agents` at `Debug` while the global level stays `Info`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TargetDirective {
    pub target: String,
    pub level: LogLevel,
}

/// Persisted logging configuration (`asset_dir()/logging.json`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LogSettings {
    pub level: LogLevel,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub targets: Vec<TargetDirective>,
}

/// Settings plus whether `VIBEX_LOG` / `RUST_LOG` currently owns the live filter.
#[derive(Debug, Clone, Serialize)]
pub struct LogSettingsView {
    pub level: LogLevel,
    pub targets: Vec<TargetDirective>,
    pub env_locked: bool,
}
