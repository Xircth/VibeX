//! Long-lived `officecli watch` preview servers for Office files.
//!
//! One `officecli watch <file> --port N` child process per office file
//! (.docx/.xlsx/.pptx), shared across preview panels by ref-count, reaped on
//! panel-close / idle sweep / app-exit. The webview embeds the watch server's
//! loopback URL in an iframe; officecli drives live refresh over its own SSE
//! channel, so the preview and an agent's edits never contend for the file on
//! disk (re-rendering by re-reading the OpenXML zip on every change hits file
//! locks on Windows).
//!
//! Ported from the sibling reference repo `codeg` (`src-tauri/src/office_watch`),
//! desktop-only: VibeX has no server/web mode, so the reverse proxy, per-watch
//! capability tokens, and SSE lease accounting were dropped — the iframe always
//! loads `http://127.0.0.1:{port}` directly.

use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::{Arc, LazyLock, Mutex, MutexGuard},
    time::{Duration, Instant},
};

use tokio::{net::TcpStream, process::Child};
use utils::process::new_hidden_tokio_command;

use crate::commands::office_tools::resolve_officecli;

// ─── Tunables ───────────────────────────────────────────────────────────

/// Upper bound on how long we wait for a freshly-spawned watch server to
/// announce readiness (its `Watch: http://…:<port>` stdout line) before giving up.
const READY_TIMEOUT: Duration = Duration::from_secs(8);
/// Per-attempt TCP connect timeout for the post-announce reachability confirm.
const READY_CONNECT_TIMEOUT: Duration = Duration::from_millis(500);
/// Hard cap on concurrent watch processes — a backstop against a pathological
/// burst of panel-opens spawning unbounded officecli processes.
const MAX_CONCURRENT_WATCHES: usize = 32;

/// Default idle threshold for the sweep (5 minutes). Override via
/// `VIBEX_OFFICE_WATCH_IDLE_TIMEOUT_SECS`; `0` disables the sweep.
pub const DEFAULT_IDLE_TIMEOUT_SECS: u64 = 300;
/// Sweep cadence — once per minute.
pub const SWEEP_INTERVAL_SECS: u64 = 60;

// ─── Error type ─────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum WatchError {
    #[error("officecli is not installed")]
    NotInstalled,
    #[error("not a supported office file (.docx/.xlsx/.pptx)")]
    NotOffice,
    #[error("failed to start officecli watch: {0}")]
    StartFailed(String),
    #[error("officecli watch did not become ready in time: {0}")]
    PortTimeout(String),
    #[error("no free port available for the preview server")]
    NoPort,
    #[error("too many office preview servers are already running")]
    TooMany,
    #[error("io error: {0}")]
    Io(String),
}

impl WatchError {
    /// Stable machine code the frontend switches on to render the right
    /// degraded UI (install guide vs. retry).
    pub fn code(&self) -> &'static str {
        match self {
            WatchError::NotInstalled => "NOT_INSTALLED",
            WatchError::NotOffice => "NOT_OFFICE",
            WatchError::StartFailed(_) => "START_FAILED",
            WatchError::PortTimeout(_) => "PORT_TIMEOUT",
            WatchError::NoPort => "NO_PORT",
            WatchError::TooMany => "TOO_MANY",
            WatchError::Io(_) => "IO",
        }
    }
}

impl From<std::io::Error> for WatchError {
    fn from(err: std::io::Error) -> Self {
        WatchError::Io(err.to_string())
    }
}

/// Extension gate shared by the watch pool and the commands layer.
pub fn is_office_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("docx") | Some("xlsx") | Some("pptx")
    )
}

// ─── Process-pool state ─────────────────────────────────────────────────

struct WatchInstance {
    child: Child,
    port: u16,
    file_canonical: PathBuf,
    ref_count: usize,
    last_activity: Instant,
}

/// File-canonical-path → live watch process. Short critical sections only.
static OFFICE_WATCHES: LazyLock<Mutex<HashMap<String, WatchInstance>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Per-key async lock serializing concurrent starts for the same file, so two
/// panels opening the same file in one tick can't each spawn a process. Held
/// across the async ready wait, hence a `tokio::sync::Mutex`. Entries are pruned
/// by the sweep once no task holds them.
static SPAWN_LOCKS: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn lock_watches() -> MutexGuard<'static, HashMap<String, WatchInstance>> {
    OFFICE_WATCHES.lock().unwrap_or_else(|p| p.into_inner())
}

/// Reap a child without blocking the caller: kill + `wait()` on a detached task
/// so no zombie lingers. Falls back to `start_kill` (relying on `kill_on_drop`
/// + tokio's orphan reaper) when called outside a runtime, e.g. at shutdown.
fn reap(mut child: Child) {
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => {
            handle.spawn(async move {
                let _ = child.kill().await;
            });
        }
        Err(_) => {
            let _ = child.start_kill();
        }
    }
}

fn spawn_lock_for(key: &str) -> Arc<tokio::sync::Mutex<()>> {
    SPAWN_LOCKS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .entry(key.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

// ─── Path handling ──────────────────────────────────────────────────────

/// Canonical registry key for a file. Case-folded on Windows so the same file
/// referenced with different casing collapses to one watch.
fn watch_key(canonical: &Path) -> String {
    let s = canonical.to_string_lossy().replace('\\', "/");
    if cfg!(windows) { s.to_lowercase() } else { s }
}

/// Validate and canonicalize an absolute office-file path — the same
/// defense-in-depth as `commands::file_tree::sanitize_file_path` (reject `..`,
/// require absolute, canonicalize), plus the office extension gate.
fn resolve_office_target(file_path: &str) -> Result<PathBuf, WatchError> {
    let p = PathBuf::from(file_path);
    if p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(WatchError::Io(
            "path traversal not allowed: '..' components rejected".to_string(),
        ));
    }
    if !p.is_absolute() {
        return Err(WatchError::Io(
            "only absolute paths are accepted".to_string(),
        ));
    }
    let canonical = std::fs::canonicalize(&p)?;
    if !canonical.is_file() {
        return Err(WatchError::Io("path is not a file".to_string()));
    }
    if !is_office_path(&canonical) {
        return Err(WatchError::NotOffice);
    }
    Ok(canonical)
}

/// Best-effort key for `stop` — falls back to the raw path so a since-deleted
/// file can still be released by key.
fn loose_key(file_path: &str) -> String {
    let p = PathBuf::from(file_path);
    let canonical = std::fs::canonicalize(&p).unwrap_or(p);
    watch_key(&canonical)
}

// ─── Spawn / readiness ──────────────────────────────────────────────────

/// Ask the OS for a free loopback port by binding to `:0` then releasing it.
/// There's an inherent (microsecond) TOCTOU window before officecli binds it;
/// the readiness probe catches the rare loss as `PortTimeout`/`StartFailed`.
fn allocate_free_port() -> Result<u16, WatchError> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|_| WatchError::NoPort)?;
    let port = listener
        .local_addr()
        .map_err(|_| WatchError::NoPort)?
        .port();
    drop(listener);
    Ok(port)
}

/// Parse officecli's readiness line, e.g. `Watch: http://localhost:26411`, into
/// the port it actually bound. Returns `None` for any other stdout line.
fn parse_watch_port(line: &str) -> Option<u16> {
    let line = line.trim_start();
    if !line.starts_with("Watch:") {
        return None;
    }
    // Take the run of digits immediately after the last ':' (tolerates an
    // optional trailing path like `…:26411/`).
    let after = line.rsplit(':').next()?;
    let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<u16>().ok()
}

/// Wait for the freshly-spawned watch to announce readiness on stdout, then
/// confirm it's reachable. Reading *our child's own stdout* for the
/// `Watch: http://…:<port>` line positively identifies the listener as this
/// officecli — closing the gap where the bind-to-`:0`-then-release port could
/// be snatched by another process between release and officecli binding it.
/// On success the stdout reader is handed to a background drain so a chatty
/// watch can't dead-lock on a full pipe.
async fn await_ready(port: u16, child: &mut Child) -> Result<(), WatchError> {
    use tokio::io::{AsyncBufReadExt, BufReader};

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| WatchError::StartFailed("no stdout pipe".to_string()))?;
    let mut lines = BufReader::new(stdout).lines();
    let deadline = Instant::now() + READY_TIMEOUT;

    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(WatchError::PortTimeout(
                "officecli did not announce readiness in time".to_string(),
            ));
        }
        match tokio::time::timeout(remaining, lines.next_line()).await {
            Ok(Ok(Some(line))) => {
                let Some(bound) = parse_watch_port(&line) else {
                    continue; // a non-readiness line (Watching:, Press Ctrl+C, …)
                };
                if bound != port {
                    return Err(WatchError::PortTimeout(format!(
                        "officecli bound port {bound}, expected {port}"
                    )));
                }
                // Confirm the announced server actually accepts a connection.
                if tokio::time::timeout(
                    READY_CONNECT_TIMEOUT,
                    TcpStream::connect(("127.0.0.1", port)),
                )
                .await
                .map(|r| r.is_ok())
                .unwrap_or(false)
                {
                    // Keep the pipe drained for the child's lifetime.
                    tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
                    return Ok(());
                }
                return Err(WatchError::PortTimeout(
                    "officecli announced ready but the port did not accept".to_string(),
                ));
            }
            Ok(Ok(None)) => {
                return Err(WatchError::StartFailed(
                    "officecli exited before announcing readiness".to_string(),
                ));
            }
            Ok(Err(e)) => return Err(WatchError::StartFailed(e.to_string())),
            Err(_) => {
                return Err(WatchError::PortTimeout(
                    "officecli did not announce readiness in time".to_string(),
                ));
            }
        }
    }
}

/// Drain a killed child's stderr (best-effort, time-boxed) for diagnostics.
async fn drain_stderr(child: &mut Child) -> String {
    use tokio::io::AsyncReadExt;
    let Some(mut err) = child.stderr.take() else {
        return String::new();
    };
    let mut buf = Vec::new();
    let _ = tokio::time::timeout(Duration::from_millis(500), err.read_to_end(&mut buf)).await;
    String::from_utf8_lossy(&buf).trim().to_string()
}

// ─── Public API: start / stop ───────────────────────────────────────────

/// Ensure a watch server is running for the absolute `file_path` and return its
/// loopback port. Shares an existing process by ref-count; only spawns when
/// none is live.
pub async fn start_office_watch_core(file_path: &str) -> Result<u16, WatchError> {
    let canonical_target = resolve_office_target(file_path)?;
    let key = watch_key(&canonical_target);

    // Fast path: a live process already exists → just share it. This path
    // intentionally does not need the officecli binary on disk.
    if let Some(port) = reuse_live(&key) {
        return Ok(port);
    }

    // Slow path: serialize same-file spawns, then double-check.
    let spawn_lock = spawn_lock_for(&key);
    let _guard = spawn_lock.lock().await;
    if let Some(port) = reuse_live(&key) {
        return Ok(port);
    }
    if lock_watches().len() >= MAX_CONCURRENT_WATCHES {
        return Err(WatchError::TooMany);
    }

    let officecli = resolve_officecli().ok_or(WatchError::NotInstalled)?;
    let port = allocate_free_port()?;
    let mut cmd = new_hidden_tokio_command(&officecli, ["watch"]);
    cmd.arg(&canonical_target)
        .arg("--port")
        .arg(port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| WatchError::StartFailed(e.to_string()))?;

    if let Err(ready_err) = await_ready(port, &mut child).await {
        let _ = child.start_kill();
        let stderr = drain_stderr(&mut child).await;
        let detail = match (ready_err.to_string(), stderr.as_str()) {
            (msg, "") => msg,
            (msg, err) => format!("{msg} — {err}"),
        };
        reap(child);
        return Err(match ready_err {
            WatchError::PortTimeout(_) => WatchError::PortTimeout(detail),
            _ => WatchError::StartFailed(detail),
        });
    }

    // Register. Re-check after the async gap: another task may have won the
    // race for this same file while we were waiting — if so, adopt theirs and
    // reap ours.
    let mut watches = lock_watches();
    if let Some(entry) = watches.get_mut(&key) {
        if matches!(entry.child.try_wait(), Ok(None)) {
            entry.ref_count += 1;
            entry.last_activity = Instant::now();
            let winner = entry.port;
            drop(watches);
            reap(child);
            return Ok(winner);
        }
        // A dead entry squats the key — replace it below.
        watches.remove(&key);
    } else if watches.len() >= MAX_CONCURRENT_WATCHES {
        // Enforce the cap atomically under the pool lock — per-file spawn locks
        // don't serialize *across different files*.
        drop(watches);
        reap(child);
        return Err(WatchError::TooMany);
    }
    watches.insert(
        key,
        WatchInstance {
            child,
            port,
            file_canonical: canonical_target,
            ref_count: 1,
            last_activity: Instant::now(),
        },
    );
    Ok(port)
}

/// Fast-path helper: if a live watch exists for `key`, bump its ref-count and
/// return its port; if the entry is dead, reap + prune it so the slow path
/// respawns.
fn reuse_live(key: &str) -> Option<u16> {
    let mut watches = lock_watches();
    let entry = watches.get_mut(key)?;
    match entry.child.try_wait() {
        Ok(None) => {
            entry.ref_count += 1;
            entry.last_activity = Instant::now();
            Some(entry.port)
        }
        _ => {
            // Dead or errored — prune so the slow path respawns.
            if let Some(dead) = watches.remove(key) {
                reap(dead.child);
            }
            None
        }
    }
}

/// Release one reference to the watch for `file_path`. Kills the process when
/// the last reference goes away. Idempotent (closing an already-stopped panel
/// is OK).
pub fn stop_office_watch_core(file_path: &str) {
    let key = loose_key(file_path);

    let mut watches = lock_watches();
    let target_key = if watches.contains_key(&key) {
        Some(key)
    } else {
        // Fallback: a since-moved file may key differently; match by canonical.
        watches
            .iter()
            .find_map(|(k, entry)| (watch_key(&entry.file_canonical) == key).then(|| k.clone()))
    };
    let Some(target_key) = target_key else {
        return;
    };

    if let Some(entry) = watches.get_mut(&target_key)
        && entry.ref_count > 1
    {
        entry.ref_count -= 1;
        return;
    }
    if let Some(entry) = watches.remove(&target_key) {
        drop(watches);
        reap(entry.child);
    }
}

/// Kill every watch process. Used on app shutdown.
pub fn stop_all_office_watches() -> usize {
    let drained: Vec<(String, WatchInstance)> = lock_watches().drain().collect();
    let n = drained.len();
    for (_, entry) in drained {
        reap(entry.child);
    }
    n
}

// ─── Idle / dead-child sweep ─────────────────────────────────────────────

/// Read the idle timeout from `VIBEX_OFFICE_WATCH_IDLE_TIMEOUT_SECS`. `0`
/// disables the sweep; unparseable falls back to the default.
pub fn idle_timeout_from_env() -> Option<Duration> {
    let secs = match std::env::var("VIBEX_OFFICE_WATCH_IDLE_TIMEOUT_SECS") {
        Ok(raw) => raw.parse::<u64>().unwrap_or(DEFAULT_IDLE_TIMEOUT_SECS),
        Err(_) => DEFAULT_IDLE_TIMEOUT_SECS,
    };
    (secs != 0).then(|| Duration::from_secs(secs))
}

/// Reap watches that are no longer needed: dead children (a crashed watch must
/// not linger) and stragglers whose last reference went away but the entry
/// survived (belt-and-suspenders; `stop` normally removes it). A live preview
/// (`ref_count >= 1`) is never swept — it connects loopback directly, so
/// nothing bumps `last_activity` while the user reads it.
pub fn sweep_office_watches(idle_timeout: Duration) -> usize {
    let now = Instant::now();
    let mut watches = lock_watches();
    let keys: Vec<String> = watches
        .iter_mut()
        .filter_map(|(k, entry)| {
            let idle = now.duration_since(entry.last_activity);
            let dead = matches!(entry.child.try_wait(), Ok(Some(_)));
            let straggler = entry.ref_count == 0 && idle > idle_timeout;
            (dead || straggler).then(|| k.clone())
        })
        .collect();
    let mut children: Vec<Child> = Vec::with_capacity(keys.len());
    for k in &keys {
        if let Some(entry) = watches.remove(k) {
            children.push(entry.child);
        }
    }
    drop(watches);
    let n = children.len();
    for child in children {
        reap(child);
    }

    // Prune spawn-lock entries no in-flight start references (`strong_count == 1`
    // means only the map holds the `Arc`), bounding the map's growth.
    SPAWN_LOCKS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .retain(|_, arc| Arc::strong_count(arc) > 1);

    n
}

/// Long-running sweep task, spawned once at app startup. Never exits on its
/// own; the process dying cleans everything up (plus kill_on_drop).
pub async fn office_watch_idle_sweep_task(idle_timeout: Duration, interval: Duration) {
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // First tick is immediate — skip it so we don't sweep before any watch settles.
    ticker.tick().await;
    loop {
        ticker.tick().await;
        let n = sweep_office_watches(idle_timeout);
        if n > 0 {
            tracing::info!("[office-watch] idle sweep reaped {n} watch process(es)");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_code_mapping_is_stable() {
        assert_eq!(WatchError::NotInstalled.code(), "NOT_INSTALLED");
        assert_eq!(WatchError::NotOffice.code(), "NOT_OFFICE");
        assert_eq!(WatchError::StartFailed("x".into()).code(), "START_FAILED");
        assert_eq!(WatchError::PortTimeout("x".into()).code(), "PORT_TIMEOUT");
        assert_eq!(WatchError::NoPort.code(), "NO_PORT");
        assert_eq!(WatchError::TooMany.code(), "TOO_MANY");
        assert_eq!(WatchError::Io("x".into()).code(), "IO");
    }

    #[test]
    fn office_extension_gate() {
        assert!(is_office_path(Path::new("/a/b.docx")));
        assert!(is_office_path(Path::new("/a/B.XLSX")));
        assert!(is_office_path(Path::new("/a/deck.pptx")));
        assert!(!is_office_path(Path::new("/a/b.doc")));
        assert!(!is_office_path(Path::new("/a/b.txt")));
        assert!(!is_office_path(Path::new("/a/b")));
    }

    #[test]
    fn parse_watch_port_reads_officecli_announce() {
        assert_eq!(
            parse_watch_port("Watch: http://localhost:26411"),
            Some(26411)
        );
        assert_eq!(
            parse_watch_port("Watch: http://127.0.0.1:8080/"),
            Some(8080)
        );
        assert_eq!(parse_watch_port("  Watch: http://localhost:1"), Some(1));
        // Other lines are ignored — crucially `Watching:` is not a false match.
        assert_eq!(parse_watch_port("Watching: /tmp/p.docx"), None);
        assert_eq!(parse_watch_port("Press Ctrl+C to stop."), None);
    }

    #[test]
    fn allocate_free_port_is_actually_free() {
        let port = allocate_free_port().expect("should allocate");
        assert!(port > 0);
        // We released it, so we can immediately bind it again.
        assert!(std::net::TcpListener::bind(("127.0.0.1", port)).is_ok());
    }

    #[test]
    fn resolve_office_target_validates_and_filters() {
        let dir = std::env::temp_dir().join(format!(
            "vibex-ow-confine-{}-{}",
            std::process::id(),
            line!()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let docx = dir.join("a.docx");
        std::fs::write(&docx, b"x").unwrap();
        let txt = dir.join("a.txt");
        std::fs::write(&txt, b"x").unwrap();

        assert!(resolve_office_target(&docx.to_string_lossy()).is_ok());
        assert!(matches!(
            resolve_office_target(&txt.to_string_lossy()),
            Err(WatchError::NotOffice)
        ));
        // Relative and traversal paths rejected.
        assert!(resolve_office_target("a.docx").is_err());
        assert!(resolve_office_target(&format!("{}/../a.docx", dir.to_string_lossy())).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Ref-count sharing + teardown, using a long-lived stand-in child instead
    /// of a real officecli (unix-only: a portable never-exiting child).
    #[cfg(unix)]
    #[tokio::test]
    async fn ref_count_sharing_and_teardown() {
        let dir = std::env::temp_dir().join(format!("vibex-ow-ref-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let pptx = dir.join("deck.pptx");
        std::fs::write(&pptx, b"x").unwrap();
        let canonical = std::fs::canonicalize(&pptx).unwrap();
        let key = watch_key(&canonical);
        let abs = canonical.to_string_lossy().to_string();

        // Seed a live "watch" with a sleep child + a real allocated port.
        let port = allocate_free_port().unwrap();
        let child = new_hidden_tokio_command("sleep", ["600"]).spawn().unwrap();
        lock_watches().insert(
            key.clone(),
            WatchInstance {
                child,
                port,
                file_canonical: canonical.clone(),
                ref_count: 1,
                last_activity: Instant::now(),
            },
        );

        // start → fast-path reuse, ref_count 2, same port, no new process.
        let started = start_office_watch_core(&abs).await.unwrap();
        assert_eq!(started, port);
        assert_eq!(lock_watches().get(&key).unwrap().ref_count, 2);

        // stop once → still present at ref_count 1.
        stop_office_watch_core(&abs);
        assert_eq!(lock_watches().get(&key).unwrap().ref_count, 1);

        // stop again → removed.
        stop_office_watch_core(&abs);
        assert!(lock_watches().get(&key).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The sweep reaps a dead child and leaves a live referenced preview alone.
    #[cfg(unix)]
    #[tokio::test]
    async fn sweep_reaping_rules() {
        let stale = Instant::now() - Duration::from_secs(3600);

        let mut dead = new_hidden_tokio_command("true", [] as [&str; 0])
            .spawn()
            .unwrap();
        let _ = dead.wait().await;
        let p_dead = allocate_free_port().unwrap();
        lock_watches().insert(
            "sweep-dead".into(),
            WatchInstance {
                child: dead,
                port: p_dead,
                file_canonical: PathBuf::from("/seed/dead"),
                ref_count: 1,
                last_activity: Instant::now(),
            },
        );

        let p_live = allocate_free_port().unwrap();
        lock_watches().insert(
            "sweep-live".into(),
            WatchInstance {
                child: new_hidden_tokio_command("sleep", ["600"]).spawn().unwrap(),
                port: p_live,
                file_canonical: PathBuf::from("/seed/live"),
                ref_count: 1,
                last_activity: stale,
            },
        );

        sweep_office_watches(Duration::from_secs(300));
        assert!(
            lock_watches().get("sweep-dead").is_none(),
            "a dead child must be reaped"
        );
        assert!(
            lock_watches().get("sweep-live").is_some(),
            "a live referenced preview must not be swept"
        );
        if let Some(e) = lock_watches().remove("sweep-live") {
            reap(e.child);
        }
    }

    #[test]
    fn idle_timeout_env_parsing() {
        // SAFETY-adjacent: env mutation is process-global; keep assertions in one
        // test so parallel tests can't interleave between set/read.
        unsafe {
            std::env::set_var("VIBEX_OFFICE_WATCH_IDLE_TIMEOUT_SECS", "0");
        }
        assert!(idle_timeout_from_env().is_none());
        unsafe {
            std::env::set_var("VIBEX_OFFICE_WATCH_IDLE_TIMEOUT_SECS", "120");
        }
        assert_eq!(idle_timeout_from_env().unwrap().as_secs(), 120);
        unsafe {
            std::env::remove_var("VIBEX_OFFICE_WATCH_IDLE_TIMEOUT_SECS");
        }
        assert_eq!(
            idle_timeout_from_env().unwrap().as_secs(),
            DEFAULT_IDLE_TIMEOUT_SECS
        );
    }
}
