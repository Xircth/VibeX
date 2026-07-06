//! Application logging (P2-8). VibeX previously installed no tracing subscriber,
//! so every `tracing::*` event was dropped. This installs a plain-text file layer
//! (daily rotation, kept ~14 files) under `utils::assets::logs_dir()` plus a
//! stderr layer, so logs are inspectable both in a terminal and via the in-app
//! log viewer. Keep it minimal: no ring buffer, no live-reload, no per-target DB.

use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{EnvFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt};

/// Install the global tracing subscriber. The returned [`WorkerGuard`] flushes
/// the non-blocking file writer on drop, so the caller MUST keep it alive for the
/// whole process lifetime.
pub fn init_logging() -> WorkerGuard {
    let logs_dir = utils::assets::logs_dir();

    let file_appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("vibex")
        .filename_suffix("log")
        .max_log_files(14)
        .build(&logs_dir)
        .unwrap_or_else(|_| tracing_appender::rolling::daily(&logs_dir, "vibex.log"));
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

    let env_filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    tracing_subscriber::registry()
        .with(env_filter)
        .with(fmt::layer().with_writer(std::io::stderr))
        .with(fmt::layer().with_ansi(false).with_writer(non_blocking))
        .init();

    tracing::info!("logging initialized; log dir = {}", logs_dir.display());
    guard
}
