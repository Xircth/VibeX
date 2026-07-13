//! OfficeCLI integration: detect / install / uninstall the external `officecli`
//! binary (from iOfficeAI/OfficeCLI) and start/stop live Office-file preview
//! watch servers (see [`crate::office_watch`]).
//!
//! Ported from the sibling reference repo `codeg`
//! (`src-tauri/src/commands/office_tools.rs`), trimmed to the desktop-only
//! surface VibeX needs (no web handlers, no skill-sync matrix).

use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use serde::Serialize;
use tauri::Emitter;
use tokio::sync::Mutex;
use utils::process::{group_spawn_no_window, kill_process_group, new_hidden_tokio_command};

use crate::{error::AppError, office_watch};

/// Serializes install/uninstall so two mutations can't interleave.
fn mutation_lock() -> &'static Mutex<()> {
    static LOCK: Mutex<()> = Mutex::const_new(());
    &LOCK
}

// ─── Detection ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficecliInfo {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    /// Present when the binary exists but cannot actually run (e.g. missing
    /// system libraries) — the UI shows "installed but not runnable".
    pub runtime_error: Option<String>,
}

/// The official installers' known install locations, in preference order.
/// `install.sh` uses `~/.local/bin/officecli` on Unix; `install.ps1` uses
/// `%LOCALAPPDATA%\OfficeCLI\officecli.exe` on Windows. Used as a fallback when
/// `officecli` isn't (yet) on `PATH` — covers the window on Windows where the
/// installer's persistent User-PATH change hasn't reached this process, and
/// GUI-launched apps on Unix that don't inherit `~/.local/bin`.
fn officecli_known_install_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    #[cfg(windows)]
    {
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            paths.push(
                PathBuf::from(local_app_data)
                    .join("OfficeCLI")
                    .join("officecli.exe"),
            );
        }
    }
    #[cfg(not(windows))]
    {
        if let Some(home) = dirs::home_dir() {
            paths.push(home.join(".local").join("bin").join("officecli"));
        }
    }
    paths
}

/// The path `officecli_uninstall` removes — the official installer's primary
/// install location for this platform.
fn officecli_primary_install_path() -> Option<PathBuf> {
    officecli_known_install_paths().into_iter().next()
}

pub(crate) fn resolve_officecli() -> Option<PathBuf> {
    if let Ok(p) = which::which("officecli") {
        return Some(p);
    }
    officecli_known_install_paths()
        .into_iter()
        .find(|p| p.is_file())
}

/// Run `officecli --version` to learn the version AND confirm the binary can
/// actually execute. A present-but-unrunnable binary yields `runtime_error` so
/// the UI can show "installed but not runnable" instead of a misleading healthy
/// "installed" badge.
async fn probe_officecli(binary: &Path) -> (Option<String>, Option<String>) {
    let mut cmd = new_hidden_tokio_command(binary, ["--version"]);
    cmd.stdin(Stdio::null());
    match cmd.output().await {
        Ok(output) if output.status.success() => {
            let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
            ((!version.is_empty()).then_some(version), None)
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let detail = if stderr.is_empty() {
                "officecli exited with an error and produced no output".to_string()
            } else {
                format!("officecli error: {}", bounded_tail(&stderr, 600))
            };
            tracing::warn!("[office] `officecli --version` failed: {detail}");
            (None, Some(detail))
        }
        Err(e) => {
            tracing::warn!("[office] `officecli --version` could not be spawned: {e}");
            (None, Some(format!("failed to run officecli: {e}")))
        }
    }
}

#[tauri::command]
pub async fn officecli_detect() -> OfficecliInfo {
    match resolve_officecli() {
        Some(path) => {
            let (version, runtime_error) = probe_officecli(&path).await;
            OfficecliInfo {
                installed: true,
                version,
                path: Some(path.to_string_lossy().to_string()),
                runtime_error,
            }
        }
        None => OfficecliInfo {
            installed: false,
            version: None,
            path: None,
            runtime_error: None,
        },
    }
}

// ─── Install / uninstall ────────────────────────────────────────────────
//
// VibeX installs OfficeCLI by running the vendor's official installer script —
// `install.sh` on Unix, `install.ps1` on Windows — mirror-first (the
// CN-reachable `d.officecli.ai`) with a GitHub-raw fallback. The script owns
// the download, checksum, install location, and (on Windows) the persistent
// User-PATH registration.

/// Where users can install OfficeCLI by hand when the network path fails.
pub const OFFICECLI_MANUAL_URL: &str = "https://github.com/iOfficeAI/OfficeCLI";
const OFFICECLI_INSTALL_SH_MIRROR_URL: &str = "https://d.officecli.ai/install.sh";
const OFFICECLI_INSTALL_SH_GITHUB_URL: &str =
    "https://raw.githubusercontent.com/iOfficeAI/OfficeCLI/main/install.sh";
const OFFICECLI_INSTALL_PS1_MIRROR_URL: &str = "https://d.officecli.ai/install.ps1";
const OFFICECLI_INSTALL_PS1_GITHUB_URL: &str =
    "https://raw.githubusercontent.com/iOfficeAI/OfficeCLI/main/install.ps1";

/// Hard ceiling on the whole installer subprocess — the small script download
/// *and* the multi-MB binary the script then fetches. On timeout the whole
/// process group is killed so a descendant `curl`/`Invoke-WebRequest` can't
/// keep installing in the background and race a later retry/uninstall.
const OFFICECLI_INSTALL_TIMEOUT: Duration = Duration::from_secs(600);

/// Streamed install progress: the official installer downloads a multi-MB
/// binary; on a slow network that looks like a hang, so stream its output
/// line-by-line, tagged with the caller's `task_id` so concurrent installs
/// don't cross-contaminate.
pub const OFFICECLI_INSTALL_EVENT: &str = "officecli-install";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
enum OfficecliInstallEventKind {
    Started,
    Log,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
struct OfficecliInstallEvent {
    task_id: String,
    kind: OfficecliInstallEventKind,
    payload: String,
}

fn emit_install_event(
    app: &tauri::AppHandle,
    task_id: &str,
    kind: OfficecliInstallEventKind,
    payload: impl Into<String>,
) {
    let _ = app.emit(
        OFFICECLI_INSTALL_EVENT,
        OfficecliInstallEvent {
            task_id: task_id.to_string(),
            kind,
            payload: payload.into(),
        },
    );
}

/// Last `max` chars of `s` (char-boundary safe), prefixed with `…` when
/// truncated. Bounds installer diagnostics surfaced to the UI.
fn bounded_tail(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut start = s.len() - max;
    while start < s.len() && !s.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &s[start..])
}

/// Read `reader` line-by-line as UTF-8-*lossy* text, invoking `on_line` per
/// line and returning the accumulated text. Unlike a `Lines` loop — which
/// aborts the whole stream on the first non-UTF-8 byte — this preserves
/// non-UTF-8 lines lossily (PowerShell emits OEM-codepage bytes for non-ASCII
/// installer text on e.g. zh-CN Windows).
async fn collect_lines_lossy<R, F>(mut reader: R, mut on_line: F) -> String
where
    R: tokio::io::AsyncBufRead + Unpin,
    F: FnMut(&str),
{
    use tokio::io::AsyncBufReadExt;

    let mut buf = Vec::new();
    let mut collected = String::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) => break, // EOF
            Ok(_) => {
                if buf.last() == Some(&b'\n') {
                    buf.pop();
                    if buf.last() == Some(&b'\r') {
                        buf.pop();
                    }
                }
                let line = String::from_utf8_lossy(&buf);
                on_line(line.as_ref());
                if !collected.is_empty() {
                    collected.push('\n');
                }
                collected.push_str(line.as_ref());
            }
            Err(e) => {
                let note = format!("<install reader error: {e}>");
                on_line(&note);
                if !collected.is_empty() {
                    collected.push('\n');
                }
                collected.push_str(&note);
                break;
            }
        }
    }
    collected
}

/// Build the installer invocation for the current platform. Both branches try
/// the mirror first, then fall back to GitHub raw.
fn officecli_install_command() -> (String, Vec<String>) {
    if cfg!(windows) {
        (
            "powershell.exe".to_string(),
            vec![
                "-NoProfile".to_string(),
                "-ExecutionPolicy".to_string(),
                "Bypass".to_string(),
                "-Command".to_string(),
                // TLS 1.2 additively (old PS 5.1 hosts), silence the progress
                // renderer (it slows Invoke-WebRequest by orders of magnitude),
                // UTF-8 console output for the lossy line reader. -TimeoutSec
                // bounds each script fetch so a stalled mirror fails over.
                format!(
                    "$ErrorActionPreference='Stop'; try {{ $sp=[Net.ServicePointManager]::SecurityProtocol; if([int]$sp -ne 0){{ [Net.ServicePointManager]::SecurityProtocol=$sp -bor [Net.SecurityProtocolType]::Tls12 }} }} catch {{}}; $ProgressPreference='SilentlyContinue'; try {{ [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false) }} catch {{}}; try {{ $s = irm -TimeoutSec 60 {OFFICECLI_INSTALL_PS1_MIRROR_URL} }} catch {{ $s = irm -TimeoutSec 60 {OFFICECLI_INSTALL_PS1_GITHUB_URL} }}; iex $s"
                ),
            ],
        )
    } else {
        (
            "bash".to_string(),
            vec![
                "-lc".to_string(),
                // Download to a temp file rather than `curl | bash`: a dropped
                // connection would otherwise concatenate the fallback output
                // after a partial script.
                format!(
                    "f=$(mktemp) || exit 1; (curl -fsSL --connect-timeout 20 --max-time 60 {OFFICECLI_INSTALL_SH_MIRROR_URL} -o \"$f\" || curl -fsSL --connect-timeout 20 --max-time 60 {OFFICECLI_INSTALL_SH_GITHUB_URL} -o \"$f\") && bash \"$f\"; s=$?; rm -f \"$f\"; exit $s"
                ),
            ],
        )
    }
}

/// Run the official OfficeCLI installer, streaming progress as
/// `officecli-install` events tagged with `task_id`.
#[tauri::command]
pub async fn officecli_install(
    task_id: String,
    app: tauri::AppHandle,
) -> Result<OfficecliInfo, AppError> {
    emit_install_event(&app, &task_id, OfficecliInstallEventKind::Started, "");

    // Acquire AFTER the first stream event so the panel is responsive
    // immediately, surfacing a waiting hint when another operation holds it.
    let _guard = match mutation_lock().try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            emit_install_event(
                &app,
                &task_id,
                OfficecliInstallEventKind::Log,
                "Waiting for another OfficeCLI operation to finish…",
            );
            mutation_lock().lock().await
        }
    };

    emit_install_event(
        &app,
        &task_id,
        OfficecliInstallEventKind::Log,
        "Running the OfficeCLI installer…",
    );

    let fail = |app: &tauri::AppHandle, task_id: &str, msg: String| -> AppError {
        emit_install_event(app, task_id, OfficecliInstallEventKind::Failed, &msg);
        AppError::Internal(msg)
    };

    let (program, args) = officecli_install_command();
    let mut cmd = new_hidden_tokio_command(&program, args.iter().map(String::as_str));
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Spawn as a process group so a timeout can kill the vendor script's
    // download descendants too, not just the direct shell.
    let mut child = group_spawn_no_window(&mut cmd).map_err(|e| {
        fail(
            &app,
            &task_id,
            format!(
                "failed to run the OfficeCLI installer: {e} — install manually from {OFFICECLI_MANUAL_URL}"
            ),
        )
    })?;

    let stdout = child.inner().stdout.take();
    let stderr = child.inner().stderr.take();
    let stdout_handle = tokio::spawn({
        let app = app.clone();
        let task_id = task_id.clone();
        async move {
            match stdout {
                Some(out) => {
                    collect_lines_lossy(tokio::io::BufReader::new(out), |line| {
                        emit_install_event(&app, &task_id, OfficecliInstallEventKind::Log, line);
                    })
                    .await
                }
                None => String::new(),
            }
        }
    });
    let stderr_handle = tokio::spawn({
        let app = app.clone();
        let task_id = task_id.clone();
        async move {
            match stderr {
                Some(err) => {
                    collect_lines_lossy(tokio::io::BufReader::new(err), |line| {
                        emit_install_event(&app, &task_id, OfficecliInstallEventKind::Log, line);
                    })
                    .await
                }
                None => String::new(),
            }
        }
    });

    let status = match tokio::time::timeout(OFFICECLI_INSTALL_TIMEOUT, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(e)) => {
            let _ = kill_process_group(&mut child).await;
            stdout_handle.abort();
            stderr_handle.abort();
            return Err(fail(
                &app,
                &task_id,
                format!(
                    "failed to run the OfficeCLI installer: {e} — install manually from {OFFICECLI_MANUAL_URL}"
                ),
            ));
        }
        Err(_) => {
            // Timed out: kill the whole group, then return WITHOUT joining the
            // readers — a descendant that survived a best-effort kill keeps its
            // pipe write-end open, so the reader would never hit EOF and would
            // pin `mutation_lock` forever.
            let _ = kill_process_group(&mut child).await;
            stdout_handle.abort();
            stderr_handle.abort();
            return Err(fail(
                &app,
                &task_id,
                format!(
                    "OfficeCLI install timed out after {}s — check your network and install manually from {OFFICECLI_MANUAL_URL}",
                    OFFICECLI_INSTALL_TIMEOUT.as_secs()
                ),
            ));
        }
    };

    // Normal exit: pipes are at EOF, these joins return promptly.
    let stdout_tail = stdout_handle.await.unwrap_or_default();
    let stderr_tail = stderr_handle.await.unwrap_or_default();

    if !status.success() {
        // The official scripts report failures on stdout as much as stderr.
        let detail = if stderr_tail.trim().is_empty() {
            stdout_tail.trim()
        } else {
            stderr_tail.trim()
        };
        return Err(fail(
            &app,
            &task_id,
            format!(
                "OfficeCLI install failed: {} — install manually from {OFFICECLI_MANUAL_URL}",
                bounded_tail(detail, 800)
            ),
        ));
    }

    let info = officecli_detect().await;
    if !info.installed {
        return Err(fail(
            &app,
            &task_id,
            format!(
                "installation completed but the officecli binary was not found — install manually from {OFFICECLI_MANUAL_URL}"
            ),
        ));
    }
    // Present-but-unrunnable (e.g. missing system libs) is not a usable install.
    if let Some(runtime_error) = &info.runtime_error {
        return Err(fail(&app, &task_id, runtime_error.clone()));
    }

    let done = match &info.version {
        Some(version) => format!("OfficeCLI {version} installed successfully"),
        None => "OfficeCLI installed successfully".to_string(),
    };
    emit_install_event(&app, &task_id, OfficecliInstallEventKind::Completed, done);
    Ok(info)
}

#[tauri::command]
pub async fn officecli_uninstall() -> Result<OfficecliInfo, AppError> {
    let _guard = mutation_lock().lock().await;

    if let Some(path) = officecli_primary_install_path()
        && path.is_file()
    {
        std::fs::remove_file(&path).map_err(|e| {
            AppError::Internal(format!("failed to remove {}: {e}", path.to_string_lossy()))
        })?;
    }
    Ok(officecli_detect().await)
}

// ─── Watch commands ─────────────────────────────────────────────────────

/// Structured start result. Expected failures (officecli missing, spawn
/// trouble) come back as `error_code`/`error_message` rather than a rejected
/// promise, because `AppError` serializes to a bare string the frontend can't
/// reliably branch on.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeWatchStartResult {
    pub port: Option<u16>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

/// Start (or share) a live `officecli watch` preview server for the absolute
/// `file_path` and return its loopback port.
#[tauri::command]
pub async fn start_office_watch(file_path: String) -> OfficeWatchStartResult {
    match office_watch::start_office_watch_core(&file_path).await {
        Ok(port) => OfficeWatchStartResult {
            port: Some(port),
            error_code: None,
            error_message: None,
        },
        Err(err) => OfficeWatchStartResult {
            port: None,
            error_code: Some(err.code().to_string()),
            error_message: Some(err.to_string()),
        },
    }
}

/// Release one reference to the watch for `file_path`; the process is killed
/// when the last preview panel lets go. Idempotent.
#[tauri::command]
pub async fn stop_office_watch(file_path: String) {
    office_watch::stop_office_watch_core(&file_path);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_tail_truncates_on_char_boundary() {
        assert_eq!(bounded_tail("abc", 10), "abc");
        assert_eq!(bounded_tail("abcdef", 3), "…def");
        // Multi-byte: never split inside a UTF-8 sequence.
        let s = "预览失败预览失败";
        let tail = bounded_tail(s, 5);
        assert!(tail.starts_with('…'));
        assert!(tail.len() <= "…".len() + 5 + 3);
    }

    #[test]
    fn install_command_shape_is_sane() {
        let (program, args) = officecli_install_command();
        if cfg!(windows) {
            assert_eq!(program, "powershell.exe");
            assert!(args.iter().any(|a| a.contains("install.ps1")));
        } else {
            assert_eq!(program, "bash");
            assert!(args.iter().any(|a| a.contains("install.sh")));
            // Mirror first, GitHub fallback, temp-file (not curl|bash).
            let script = args.last().unwrap();
            assert!(script.contains(OFFICECLI_INSTALL_SH_MIRROR_URL));
            assert!(script.contains(OFFICECLI_INSTALL_SH_GITHUB_URL));
            assert!(script.contains("mktemp"));
        }
    }
}
