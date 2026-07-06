//! In-app log viewer commands (P2-8): a static tail of the newest rotating log
//! file plus the log directory path (for "open folder"). Not a streaming console.

use std::io::{Read, Seek, SeekFrom};

use crate::error::AppError;

/// How many trailing bytes of the newest log file to read (bounds memory for a
/// large daily log). ~1 MiB comfortably covers thousands of recent lines.
const TAIL_BYTES: u64 = 1024 * 1024;
const DEFAULT_MAX_LINES: usize = 500;

fn newest_log_file() -> Option<std::path::PathBuf> {
    let dir = utils::assets::logs_dir();
    std::fs::read_dir(&dir)
        .ok()?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("log"))
        })
        .max_by_key(|path| {
            std::fs::metadata(path)
                .and_then(|meta| meta.modified())
                .ok()
        })
}

/// Return the last `max_lines` lines of the newest application log file.
#[tauri::command]
pub async fn get_app_logs(max_lines: Option<usize>) -> Result<Vec<String>, AppError> {
    let max_lines = max_lines.unwrap_or(DEFAULT_MAX_LINES).clamp(1, 5000);
    let Some(path) = newest_log_file() else {
        return Ok(Vec::new());
    };

    let mut file = std::fs::File::open(&path)
        .map_err(|error| AppError::Internal(format!("Failed to open log file: {error}")))?;
    let len = file
        .metadata()
        .map_err(|error| AppError::Internal(format!("Failed to stat log file: {error}")))?
        .len();
    let start = len.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start))
        .map_err(|error| AppError::Internal(format!("Failed to seek log file: {error}")))?;
    // Read raw bytes and convert lossily: a tail seek can land mid-UTF-8, so a
    // strict decode would spuriously fail.
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| AppError::Internal(format!("Failed to read log file: {error}")))?;
    let buf = String::from_utf8_lossy(&bytes);

    let mut lines: Vec<String> = buf.lines().map(str::to_string).collect();
    let tail = lines.split_off(lines.len().saturating_sub(max_lines));
    Ok(tail)
}

/// The application log directory path (for an "open folder" action).
#[tauri::command]
pub async fn get_logs_dir() -> Result<String, AppError> {
    Ok(utils::assets::logs_dir().to_string_lossy().to_string())
}
