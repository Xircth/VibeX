//! Opt-in crash reporting, local-first: a panic hook writes a plain-text
//! report under the app data dir and nothing ever leaves the machine on its
//! own. The frontend surfaces pending reports with their full content and the
//! user decides whether to file a GitHub issue with them.

use std::{fs, path::PathBuf};

const CRASH_FILE_PREFIX: &str = "crash-";
const CRASH_FILE_SUFFIX: &str = ".txt";
/// Keep the newest N reports; older ones are pruned on each write/list.
const MAX_KEPT_REPORTS: usize = 20;

pub fn crashes_dir() -> PathBuf {
    utils::assets::asset_dir().join("crashes")
}

/// Install a panic hook that persists a crash report before delegating to the
/// previous hook. Must run once, early in startup. Writing is best-effort —
/// a failing disk must not mask the original panic.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = write_crash_report(info);
        previous(info);
    }));
}

fn panic_message(info: &std::panic::PanicHookInfo<'_>) -> String {
    if let Some(message) = info.payload().downcast_ref::<&str>() {
        (*message).to_string()
    } else if let Some(message) = info.payload().downcast_ref::<String>() {
        message.clone()
    } else {
        "<non-string panic payload>".to_string()
    }
}

fn write_crash_report(info: &std::panic::PanicHookInfo<'_>) -> std::io::Result<PathBuf> {
    let dir = crashes_dir();
    fs::create_dir_all(&dir)?;

    let now = chrono::Utc::now();
    let path = dir.join(format!(
        "{CRASH_FILE_PREFIX}{}{CRASH_FILE_SUFFIX}",
        now.timestamp_millis()
    ));

    let location = info
        .location()
        .map(|location| location.to_string())
        .unwrap_or_else(|| "<unknown location>".to_string());
    let thread = std::thread::current()
        .name()
        .unwrap_or("<unnamed>")
        .to_string();
    let backtrace = std::backtrace::Backtrace::force_capture();

    let report = format!(
        "VibeX crash report\n\
         ==================\n\
         time (UTC): {time}\n\
         app version: {version}\n\
         os: {os} ({arch})\n\
         thread: {thread}\n\
         location: {location}\n\
         \n\
         panic message:\n\
         {message}\n\
         \n\
         backtrace:\n\
         {backtrace}\n",
        time = now.to_rfc3339(),
        version = utils::version::APP_VERSION,
        os = std::env::consts::OS,
        arch = std::env::consts::ARCH,
        thread = thread,
        location = location,
        message = panic_message(info),
        backtrace = backtrace,
    );

    fs::write(&path, report)?;
    prune_old_reports(&dir);
    Ok(path)
}

/// A crash file id is exactly `crash-<millis>.txt`; anything else (path
/// separators, `..`, unrelated files) is rejected before touching the fs.
pub fn is_valid_report_id(id: &str) -> bool {
    let Some(stem) = id
        .strip_prefix(CRASH_FILE_PREFIX)
        .and_then(|rest| rest.strip_suffix(CRASH_FILE_SUFFIX))
    else {
        return false;
    };
    !stem.is_empty() && stem.chars().all(|c| c.is_ascii_digit())
}

/// Millisecond timestamp encoded in a valid report id.
pub fn report_created_at_ms(id: &str) -> Option<i64> {
    id.strip_prefix(CRASH_FILE_PREFIX)?
        .strip_suffix(CRASH_FILE_SUFFIX)?
        .parse()
        .ok()
}

/// List pending report ids, newest first.
pub fn list_report_ids() -> Vec<String> {
    let Ok(entries) = fs::read_dir(crashes_dir()) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| is_valid_report_id(name))
        .collect();
    ids.sort();
    ids.reverse();
    ids
}

fn prune_old_reports(dir: &std::path::Path) {
    let mut ids = list_report_ids();
    if ids.len() <= MAX_KEPT_REPORTS {
        return;
    }
    for id in ids.split_off(MAX_KEPT_REPORTS) {
        let _ = fs::remove_file(dir.join(id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_ids_validate_strictly() {
        assert!(is_valid_report_id("crash-1751900000000.txt"));
        assert!(!is_valid_report_id("crash-.txt"));
        assert!(!is_valid_report_id("crash-abc.txt"));
        assert!(!is_valid_report_id("crash-175/../../etc.txt"));
        assert!(!is_valid_report_id("..\\crash-1.txt"));
        assert!(!is_valid_report_id("notes.txt"));
        assert!(!is_valid_report_id(""));
    }

    #[test]
    fn report_created_at_parses_millis() {
        assert_eq!(
            report_created_at_ms("crash-1751900000000.txt"),
            Some(1_751_900_000_000)
        );
        assert_eq!(report_created_at_ms("crash-x.txt"), None);
    }
}
