//! Subscriber construction and process-lifetime initialization.

use std::path::Path;

use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{EnvFilter, Registry, fmt, prelude::*, reload};

use crate::logging::{LogLevel, LogSettings, hub::LogHub, layer::BufferEmitLayer};

pub type ReloadHandle = reload::Handle<EnvFilter, Registry>;

fn settings_path() -> std::path::PathBuf {
    utils::assets::asset_dir().join("logging.json")
}

pub fn load_persisted_settings() -> LogSettings {
    std::fs::read_to_string(settings_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn persist_settings(settings: &LogSettings) -> Result<(), String> {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(
        path,
        serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

pub fn env_level_is_set() -> bool {
    env_level_override().is_some()
}

fn env_level_override() -> Option<String> {
    ["VIBEX_LOG", "RUST_LOG"].iter().find_map(|key| {
        std::env::var(key)
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    })
}

pub fn is_valid_target(target: &str) -> bool {
    if target.is_empty() || target == "vibex::logging" || target.starts_with("vibex::logging::") {
        return false;
    }
    target
        .split("::")
        .all(|seg| !seg.is_empty() && seg.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'))
}

pub fn sanitize_settings(mut settings: LogSettings) -> LogSettings {
    settings
        .targets
        .retain(|t| is_valid_target(t.target.trim()));
    for t in &mut settings.targets {
        t.target = t.target.trim().to_string();
    }
    settings
}

/// Global level + per-target overrides. When capture is not `Off`, keep a few
/// known firehoses quieter than the global level.
pub fn build_env_filter(settings: &LogSettings) -> EnvFilter {
    let mut directives = settings.level.directive().to_string();
    for t in &settings.targets {
        let target = t.target.trim();
        if is_valid_target(target) {
            directives.push_str(&format!(",{target}={}", t.level.directive()));
        }
    }
    if settings.level != LogLevel::Off {
        directives.push_str(FIREHOSE_BACKSTOPS);
    }
    EnvFilter::builder().parse_lossy(directives)
}

const FIREHOSE_BACKSTOPS: &str = concat!(
    ",sqlx::query=warn,hyper=info,hyper_util=info,reqwest=info,h2=info,",
    "rustls=info,tokio=info,tower=info,want=info,mio=warn,notify=warn,",
    "tonic=info,h2::codec=warn,vibex::logging=off"
);

fn init_file_writer(
    dir: &Path,
) -> Option<(tracing_appender::non_blocking::NonBlocking, WorkerGuard)> {
    if let Err(e) = std::fs::create_dir_all(dir) {
        eprintln!("[logging] could not create log dir {}: {e}", dir.display());
        return None;
    }
    let appender = match tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("vibex")
        .filename_suffix("log")
        .max_log_files(14)
        .build(dir)
    {
        Ok(appender) => appender,
        Err(e) => {
            eprintln!(
                "[logging] could not init log appender in {}: {e}",
                dir.display()
            );
            return None;
        }
    };
    Some(tracing_appender::non_blocking(appender))
}

pub fn init_logging() -> WorkerGuard {
    let settings = load_persisted_settings();
    let initial_filter = match env_level_override() {
        Some(s) => {
            let directives = if s.eq_ignore_ascii_case("off") {
                s
            } else {
                format!("{s}{FIREHOSE_BACKSTOPS}")
            };
            EnvFilter::builder().parse_lossy(directives)
        }
        None => build_env_filter(&settings),
    };
    let (filter_layer, reload) = reload::Layer::new(initial_filter);
    let logs_dir = utils::assets::logs_dir();
    let file = init_file_writer(&logs_dir);

    let guard = match file {
        Some((non_blocking, guard)) => {
            Registry::default()
                .with(filter_layer)
                .with(fmt::layer().with_writer(std::io::stderr))
                .with(BufferEmitLayer)
                .with(fmt::layer().with_ansi(false).with_writer(non_blocking))
                .init();
            guard
        }
        None => {
            Registry::default()
                .with(filter_layer)
                .with(fmt::layer().with_writer(std::io::stderr))
                .with(BufferEmitLayer)
                .init();
            let (_writer, guard) = tracing_appender::non_blocking(std::io::sink());
            guard
        }
    };

    LogHub::install(reload);
    tracing::info!("logging initialized; log dir = {}", logs_dir.display());
    guard
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_targets_are_module_paths() {
        assert!(is_valid_target("agents"));
        assert!(is_valid_target("agents::runtime"));
        assert!(!is_valid_target(""));
        assert!(!is_valid_target("agents::"));
        assert!(!is_valid_target("agents/runtime"));
        assert!(!is_valid_target("vibex::logging"));
        assert!(!is_valid_target("vibex::logging::hub"));
    }

    #[test]
    fn off_does_not_append_backstops() {
        let filter = build_env_filter(&LogSettings {
            level: LogLevel::Off,
            targets: Vec::new(),
        });
        assert_eq!(filter.to_string(), "off");
    }

    #[test]
    fn all_captures_at_trace() {
        let filter = build_env_filter(&LogSettings {
            level: LogLevel::All,
            targets: Vec::new(),
        });
        assert!(filter.to_string().contains("trace"));
    }

    #[test]
    fn info_includes_backstops_and_overrides() {
        let filter = build_env_filter(&LogSettings {
            level: LogLevel::Info,
            targets: vec![crate::logging::TargetDirective {
                target: "agents".into(),
                level: LogLevel::Debug,
            }],
        });
        let s = filter.to_string();
        assert!(s.contains("info"));
        assert!(s.contains("agents=debug"));
        assert!(s.contains("sqlx::query=warn"));
        assert!(s.contains("reqwest=info"));
        assert!(s.contains("hyper=info"));
    }

    #[test]
    fn trace_still_quiets_http_firehoses() {
        let filter = build_env_filter(&LogSettings {
            level: LogLevel::Trace,
            targets: Vec::new(),
        });
        let s = filter.to_string();
        assert!(s.contains("trace"));
        assert!(s.contains("reqwest=info"));
        assert!(s.contains("h2=info"));
    }
}
