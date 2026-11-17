//! ACP-native transcript codec, offline reader, and SQLite-authoritative replay gate.
//!
//! Online JSONL writing is disabled by default (Step 3E) because `ConversationProjector`
//! and SQLite (`conversation_events` / `conversation_turns` / `conversation_timeline_rows`)
//! are the single source of truth. Setting `DIMO_LEGACY_JSONL_SHADOW_WRITE=1` enables
//! opt-in write-only shadow logging for rollout diagnostics. Offline helpers (`*_in`)
//! remain active for legacy backfill, external parsers (`crate::parsers::*`), and tests.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    future::Future,
    io::{Seek as _, Write as _},
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, LazyLock, Mutex, OnceLock, RwLock},
};

use serde::{Deserialize, Serialize};

#[path = "acp_transcript_reader.rs"]
mod reader;
pub use self::reader::*;

/// Schema version of the transcript file.
pub const TRANSCRIPT_SCHEMA_VERSION: u32 = 1;

const MAX_IN_MEMORY_SESSION_KEYS: usize = 4_096;

#[derive(Default)]
struct BoundedKeySet {
    keys: HashSet<(String, String)>,
    order: VecDeque<(String, String)>,
}

impl BoundedKeySet {
    fn insert(&mut self, key: (String, String)) -> bool {
        if !self.keys.insert(key.clone()) {
            return false;
        }
        self.order.push_back(key);
        while self.keys.len() > MAX_IN_MEMORY_SESSION_KEYS {
            if let Some(oldest) = self.order.pop_front() {
                self.keys.remove(&oldest);
            } else {
                break;
            }
        }
        true
    }

    fn remove(&mut self, key: &(String, String)) {
        self.keys.remove(key);
        if self.order.len() > self.keys.len().saturating_mul(2).max(16) {
            self.order.retain(|k| self.keys.contains(k));
        }
    }

    fn contains(&self, key: &(String, String)) -> bool {
        self.keys.contains(key)
    }
}

/// Async callback registered by the persistence layer to check whether SQLite
/// already holds recorded turns/events for `(conversation_id, agent_dir, acp_session_id)`.
pub type AsyncRecordedHistoryProbe = Arc<
    dyn Fn(Option<uuid::Uuid>, String, String) -> Pin<Box<dyn Future<Output = bool> + Send>>
        + Send
        + Sync,
>;

static REGISTERED_HISTORY_PROBE: LazyLock<RwLock<Option<AsyncRecordedHistoryProbe>>> =
    LazyLock::new(|| RwLock::new(None));

/// Sessions that observed at least one live prompt/update/steer/turn-end in this process.
static RECORDED_SESSIONS: LazyLock<Mutex<BoundedKeySet>> =
    LazyLock::new(|| Mutex::new(BoundedKeySet::default()));

/// In-flight or completed `session/load` replay claims in this process.
static CLAIMED_REPLAYS: LazyLock<Mutex<BoundedKeySet>> =
    LazyLock::new(|| Mutex::new(BoundedKeySet::default()));

/// Register the authoritative SQLite history probe used by `session/load` replay gating.
pub fn register_recorded_history_probe(probe: AsyncRecordedHistoryProbe) {
    if let Ok(mut slot) = REGISTERED_HISTORY_PROBE.write() {
        *slot = Some(probe);
    }
}

/// Whether opt-in legacy JSONL shadow writing (`DIMO_LEGACY_JSONL_SHADOW_WRITE=1`) is enabled.
pub fn legacy_jsonl_shadow_write_enabled() -> bool {
    std::env::var("DIMO_LEGACY_JSONL_SHADOW_WRITE").as_deref() == Ok("1")
}

/// Mark `(agent_dir, session_id)` as having live recorded history in memory.
pub fn mark_session_recorded(agent_dir: &str, session_id: &str) {
    if !safe_component(agent_dir) || !safe_component(session_id) {
        return;
    }
    if let Ok(mut set) = RECORDED_SESSIONS.lock() {
        set.insert((agent_dir.to_string(), session_id.to_string()));
    }
}

pub fn is_session_recorded_in_memory(agent_dir: &str, session_id: &str) -> bool {
    RECORDED_SESSIONS
        .lock()
        .map(|set| set.contains(&(agent_dir.to_string(), session_id.to_string())))
        .unwrap_or(false)
}

fn resolved_ack() -> tokio::sync::oneshot::Receiver<()> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let _ = tx.send(());
    rx
}

/// First line of a transcript file: everything about the session that is not
/// derivable from the ACP stream itself.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TranscriptHeader {
    pub v: u32,
    pub kind: String,
    pub agent: String,
    pub session_id: String,
    pub cwd: String,
    pub started_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continues_from: Option<String>,
}

impl TranscriptHeader {
    pub fn new(agent: &str, session_id: &str, cwd: &str, started_at_ms: u64) -> Self {
        Self {
            v: TRANSCRIPT_SCHEMA_VERSION,
            kind: "header".to_string(),
            agent: agent.to_string(),
            session_id: session_id.to_string(),
            cwd: cwd.to_string(),
            started_at_ms,
            continues_from: None,
        }
    }

    /// Mark this transcript as the continuation of `previous_session_id`.
    pub fn continuing(mut self, previous_session_id: &str) -> Self {
        self.continues_from = Some(previous_session_id.to_string());
        self
    }
}

/// What a transcript line records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    Prompt,
    Update,
    TurnEnd,
}

/// One recorded line.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptEntry {
    pub t: u64,
    pub k: EntryKind,
    pub p: serde_json::Value,
    #[serde(rename = "s", default, skip_serializing_if = "std::ops::Not::not")]
    pub steer: bool,
}

/// A parsed transcript: its header plus every well-formed entry, in file order.
#[derive(Debug, Clone, Default)]
pub struct Transcript {
    pub header: Option<TranscriptHeader>,
    pub entries: Vec<TranscriptEntry>,
}

impl Transcript {
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// Milliseconds since the Unix epoch; saturates rather than panicking on a pre-1970 clock.
pub fn now_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Whether `s` is safe as a single path component.
pub fn safe_component(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        && !s.starts_with('.')
}

/// `<root>/<agent_dir>/<session_id>.jsonl`, or `None` when either component is unsafe.
pub fn transcript_path_in(root: &Path, agent_dir: &str, session_id: &str) -> Option<PathBuf> {
    if !safe_component(agent_dir) || !safe_component(session_id) {
        return None;
    }
    Some(root.join(agent_dir).join(format!("{session_id}.jsonl")))
}

type AckSender = tokio::sync::oneshot::Sender<()>;

enum PendingRecord {
    Header(TranscriptHeader),
    Entry(TranscriptEntry),
    Flush,
    Replace(String),
}

impl PendingRecord {
    fn to_line(&self) -> String {
        match self {
            PendingRecord::Header(h) => serde_json::to_string(h).unwrap_or_default(),
            PendingRecord::Entry(e) => serde_json::to_string(e).unwrap_or_default(),
            PendingRecord::Flush | PendingRecord::Replace(_) => String::new(),
        }
    }

    fn is_boundary(&self) -> bool {
        match self {
            PendingRecord::Header(_) | PendingRecord::Flush | PendingRecord::Replace(_) => true,
            PendingRecord::Entry(e) => matches!(e.k, EntryKind::Prompt | EntryKind::TurnEnd),
        }
    }
}

static PENDING_PROMPTS: LazyLock<Mutex<HashMap<PathBuf, usize>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

struct PendingPromptGuard(PathBuf);

impl PendingPromptGuard {
    fn new(path: &Path) -> Self {
        if let Ok(mut counts) = PENDING_PROMPTS.lock() {
            *counts.entry(path.to_path_buf()).or_insert(0) += 1;
        }
        Self(path.to_path_buf())
    }
}

impl Drop for PendingPromptGuard {
    fn drop(&mut self) {
        if let Ok(mut counts) = PENDING_PROMPTS.lock()
            && let std::collections::hash_map::Entry::Occupied(mut e) = counts.entry(self.0.clone())
        {
            *e.get_mut() -= 1;
            if *e.get() == 0 {
                e.remove();
            }
        }
    }
}

fn has_pending_prompt(path: &Path) -> bool {
    PENDING_PROMPTS
        .lock()
        .map(|counts| counts.contains_key(path))
        .unwrap_or(false)
}

struct Queued {
    record: PendingRecord,
    ack: AckSender,
    _prompt_guard: Option<PendingPromptGuard>,
}

struct TranscriptJob {
    path: PathBuf,
    queued: Queued,
}

const TRANSCRIPT_QUEUE_CAP: usize = 8192;
const FLUSH_WINDOW: std::time::Duration = std::time::Duration::from_secs(1);

static TRANSCRIPT_TX: OnceLock<std::sync::mpsc::SyncSender<TranscriptJob>> = OnceLock::new();

struct SessionWriter {
    path: PathBuf,
    pending: Vec<Queued>,
    compactable: bool,
    header_written: bool,
    poisoned: bool,
    oldest_pending_at: Option<std::time::Instant>,
    consecutive_failures: u32,
    last_touched: std::time::Instant,
}

const IDLE_EVICT: std::time::Duration = std::time::Duration::from_secs(30 * 60);

impl SessionWriter {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            pending: Vec::new(),
            compactable: false,
            header_written: false,
            poisoned: false,
            oldest_pending_at: None,
            consecutive_failures: 0,
            last_touched: std::time::Instant::now(),
        }
    }

    fn is_idle(&self, now: std::time::Instant) -> bool {
        self.pending.is_empty() && now.saturating_duration_since(self.last_touched) >= IDLE_EVICT
    }

    fn file_is_non_empty(&self) -> bool {
        std::fs::metadata(&self.path)
            .map(|m| m.len() > 0)
            .unwrap_or(false)
    }

    fn accept(&mut self, queued: Queued) {
        self.last_touched = std::time::Instant::now();
        match queued.record {
            PendingRecord::Flush => {
                self.flush();
                let _ = queued.ack.send(());
                return;
            }
            PendingRecord::Replace(content) => {
                self.resolve_all(false);
                self.compactable = false;
                self.poisoned = false;
                self.consecutive_failures = 0;
                self.header_written = !content.trim().is_empty();
                let write_res = (|| -> std::io::Result<()> {
                    if let Some(dir) = self.path.parent() {
                        std::fs::create_dir_all(dir)?;
                    }
                    std::fs::write(&self.path, content.as_bytes())
                })();
                if write_res.is_ok() {
                    let _ = queued.ack.send(());
                }
                return;
            }
            _ => {}
        }
        if self.poisoned {
            return;
        }
        if matches!(queued.record, PendingRecord::Header(_)) && self.header_already_stands() {
            let _ = queued.ack.send(());
            return;
        }
        let boundary = queued.record.is_boundary();
        if self.pending.is_empty() {
            self.oldest_pending_at = Some(std::time::Instant::now());
        }
        self.pending.push(queued);
        if boundary || !self.compactable {
            self.flush();
        }
    }

    fn header_already_stands(&mut self) -> bool {
        if self.header_written {
            return true;
        }
        let stands = self
            .pending
            .iter()
            .any(|q| matches!(q.record, PendingRecord::Header(_)))
            || self.file_is_non_empty();
        if stands {
            self.header_written = true;
        }
        stands
    }

    fn deadline(&self) -> Option<std::time::Instant> {
        self.oldest_pending_at.map(|at| at + FLUSH_WINDOW)
    }

    fn resolve_all(&mut self, landed: bool) {
        for queued in self.pending.drain(..) {
            if landed {
                let _ = queued.ack.send(());
            }
        }
        self.oldest_pending_at = None;
    }

    fn flush(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        if self.poisoned {
            self.resolve_all(false);
            return;
        }

        let (lines, next_compactable) = compact_batch(&self.pending, self.compactable);
        if lines.is_empty() {
            self.compactable = next_compactable;
            self.resolve_all(true);
            return;
        }

        let mut file = match open_for_append(&self.path) {
            Ok(f) => f,
            Err(e) => return self.defer(e),
        };
        let pre_len = match file.stream_position() {
            Ok(p) => p,
            Err(e) => return self.defer(e),
        };

        match file.write_all(lines.as_bytes()) {
            Ok(()) => {
                self.compactable = next_compactable;
                self.header_written |= lines_contain_header(&self.pending);
                self.consecutive_failures = 0;
                self.resolve_all(true);
            }
            Err(e) => match file.set_len(pre_len) {
                Ok(()) => self.defer(e),
                Err(rollback) => {
                    if file.write_all(b"\n").is_err() {
                        self.poisoned = true;
                    }
                    tracing::error!(
                        "[acp-transcript] partial write to {} could not be rolled back \
                         ({e}; rollback: {rollback}); dropping {} buffered record(s){}",
                        self.path.display(),
                        self.pending.len(),
                        if self.poisoned {
                            " — this session will record nothing further"
                        } else {
                            ""
                        }
                    );
                    self.resolve_all(false);
                }
            },
        }
    }

    fn defer(&mut self, e: std::io::Error) {
        self.oldest_pending_at = Some(std::time::Instant::now());
        self.consecutive_failures += 1;
        if self.consecutive_failures == FAILURES_BEFORE_REPORTING {
            tracing::error!(
                "[acp-transcript] cannot write {} ({e}); {} record(s) buffered and retrying",
                self.path.display(),
                self.pending.len()
            );
        } else {
            tracing::debug!(
                "[acp-transcript] deferring write to {}: {e}",
                self.path.display()
            );
        }
    }
}

const FAILURES_BEFORE_REPORTING: u32 = 3;

fn lines_contain_header(pending: &[Queued]) -> bool {
    pending
        .iter()
        .any(|q| matches!(q.record, PendingRecord::Header(_)))
}

fn open_for_append(path: &Path) -> std::io::Result<std::fs::File> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(path)?;
    file.seek(std::io::SeekFrom::End(0))?;
    Ok(file)
}

fn mergeable_chunk_kind(payload: &serde_json::Value) -> Option<&'static str> {
    let kind = match payload.get("sessionUpdate").and_then(|v| v.as_str())? {
        "agent_message_chunk" => "agent_message_chunk",
        "agent_thought_chunk" => "agent_thought_chunk",
        _ => return None,
    };
    let content = payload.get("content")?;
    (content.get("type").and_then(|v| v.as_str()) == Some("text")
        && content
            .get("text")
            .is_some_and(serde_json::Value::is_string))
    .then_some(kind)
}

fn compact_batch(pending: &[Queued], compactable: bool) -> (String, bool) {
    let mut compactable = compactable;
    let mut out = String::new();
    let mut open: Option<(&'static str, TranscriptEntry)> = None;

    let close_run = |open: &mut Option<(&'static str, TranscriptEntry)>, out: &mut String| {
        if let Some((_, entry)) = open.take() {
            push_line(out, &serde_json::to_string(&entry).unwrap_or_default());
        }
    };

    for Queued { record, .. } in pending {
        let entry = match record {
            PendingRecord::Entry(e) if compactable && e.k == EntryKind::Update => e,
            other => {
                close_run(&mut open, &mut out);
                if let PendingRecord::Entry(e) = other {
                    match e.k {
                        EntryKind::Prompt => compactable = true,
                        EntryKind::TurnEnd => compactable = false,
                        EntryKind::Update => {}
                    }
                }
                push_line(&mut out, &other.to_line());
                continue;
            }
        };
        match mergeable_chunk_kind(&entry.p) {
            Some(kind)
                if open.as_ref().is_some_and(|(open_kind, open_entry)| {
                    *open_kind == kind && open_entry.p.get("_meta") == entry.p.get("_meta")
                }) =>
            {
                let (_, open_entry) = open.as_mut().expect("guard matched Some");
                append_chunk_text(open_entry, entry);
            }
            Some(kind) => {
                close_run(&mut open, &mut out);
                open = Some((kind, entry.clone()));
            }
            None => {
                close_run(&mut open, &mut out);
                push_line(&mut out, &record.to_line());
            }
        }
    }
    close_run(&mut open, &mut out);
    (out, compactable)
}

fn push_line(out: &mut String, line: &str) {
    if line.is_empty() {
        return;
    }
    out.push_str(line);
    out.push('\n');
}

fn append_chunk_text(open: &mut TranscriptEntry, next: &TranscriptEntry) {
    let text = next
        .p
        .get("content")
        .and_then(|c| c.get("text"))
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .to_string();
    if let Some(serde_json::Value::String(existing)) =
        open.p.get_mut("content").and_then(|c| c.get_mut("text"))
    {
        existing.push_str(&text);
    }
    open.t = next.t;
}

fn enqueue(path: PathBuf, record: PendingRecord) -> tokio::sync::oneshot::Receiver<()> {
    let (ack_tx, ack_rx) = tokio::sync::oneshot::channel();
    if matches!(record, PendingRecord::Flush) && TRANSCRIPT_TX.get().is_none() {
        let _ = ack_tx.send(());
        return ack_rx;
    }
    let prompt_guard = matches!(
        record,
        PendingRecord::Entry(TranscriptEntry {
            k: EntryKind::Prompt,
            ..
        })
    )
    .then(|| PendingPromptGuard::new(&path));
    let tx = TRANSCRIPT_TX.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::sync_channel::<TranscriptJob>(TRANSCRIPT_QUEUE_CAP);
        let spawned = std::thread::Builder::new()
            .name("acp-transcript-writer".into())
            .spawn(move || run_writer(rx));
        if let Err(e) = spawned {
            tracing::debug!("[acp-transcript] failed to spawn writer thread: {e}");
        }
        tx
    });
    if tx
        .try_send(TranscriptJob {
            path,
            queued: Queued {
                record,
                ack: ack_tx,
                _prompt_guard: prompt_guard,
            },
        })
        .is_err()
    {
        tracing::debug!("[acp-transcript] queue full or closed; record dropped");
    }
    ack_rx
}

fn run_writer(rx: std::sync::mpsc::Receiver<TranscriptJob>) {
    use std::sync::mpsc::RecvTimeoutError;
    let mut writers: HashMap<PathBuf, SessionWriter> = HashMap::new();
    loop {
        let next = writers.values().filter_map(SessionWriter::deadline).min();
        let job = match next {
            Some(at) => {
                let wait = at.saturating_duration_since(std::time::Instant::now());
                match rx.recv_timeout(wait) {
                    Ok(job) => Some(job),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
            None => match rx.recv() {
                Ok(job) => Some(job),
                Err(_) => break,
            },
        };
        if let Some(job) = job {
            writers
                .entry(job.path.clone())
                .or_insert_with(|| SessionWriter::new(job.path))
                .accept(job.queued);
        }
        let now = std::time::Instant::now();
        for writer in writers.values_mut() {
            if writer.deadline().is_some_and(|at| at <= now) {
                writer.flush();
            }
        }
        writers.retain(|_, w| !w.is_idle(now));
    }
    for writer in writers.values_mut() {
        writer.flush();
    }
}

fn isolate_test_transcripts() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        if std::env::var_os("DIMO_TRANSCRIPTS_ROOT").is_some()
            || std::env::var_os("DIMO_HOME").is_some()
            || std::env::var_os("DIMO_DATA_DIR").is_some()
        {
            return;
        }
        let Ok(exe) = std::env::current_exe() else {
            return;
        };
        let in_deps = exe
            .components()
            .any(|component| component.as_os_str() == "deps");
        if !in_deps {
            return;
        }
        let dir = workspace_utils::path::get_dimo_temp_dir()
            .join(format!("acp-transcripts-{}", std::process::id()));
        unsafe {
            std::env::set_var("DIMO_TRANSCRIPTS_ROOT", dir);
        }
    });
}

/// ACP JSONL root. `$DIMO_HOME` then `$DIMO_DATA_DIR` then the platform data dir.
pub fn dimo_acp_transcripts_root() -> PathBuf {
    isolate_test_transcripts();
    if let Some(explicit) = std::env::var_os("DIMO_TRANSCRIPTS_ROOT") {
        return PathBuf::from(explicit);
    }
    if let Some(home) = std::env::var_os("DIMO_HOME") {
        return PathBuf::from(home).join("acp-transcripts");
    }
    if let Some(dir) = std::env::var_os("DIMO_DATA_DIR") {
        return PathBuf::from(dir).join("acp-transcripts");
    }
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from(".dimo-data"))
        .join("dimo")
        .join("acp-transcripts")
}

/// Online session header recorder (no-op unless `DIMO_LEGACY_JSONL_SHADOW_WRITE=1`).
pub fn record_header(
    agent_dir: &str,
    header: &TranscriptHeader,
) -> tokio::sync::oneshot::Receiver<()> {
    if !legacy_jsonl_shadow_write_enabled() {
        return resolved_ack();
    }
    record_header_in(&dimo_acp_transcripts_root(), agent_dir, header)
}

/// Root-injectable core of [`record_header`].
pub fn record_header_in(
    root: &Path,
    agent_dir: &str,
    header: &TranscriptHeader,
) -> tokio::sync::oneshot::Receiver<()> {
    queue_for(
        root,
        agent_dir,
        &header.session_id,
        PendingRecord::Header(header.clone()),
    )
}

/// Online entry recorder: marks in-memory replay history and skips JSONL disk I/O
/// unless `DIMO_LEGACY_JSONL_SHADOW_WRITE=1`.
pub fn record_entry(
    agent_dir: &str,
    session_id: &str,
    kind: EntryKind,
    payload: serde_json::Value,
) -> tokio::sync::oneshot::Receiver<()> {
    mark_session_recorded(agent_dir, session_id);
    if !legacy_jsonl_shadow_write_enabled() {
        return resolved_ack();
    }
    record_entry_in(
        &dimo_acp_transcripts_root(),
        agent_dir,
        session_id,
        kind,
        payload,
    )
}

/// Root-injectable core of [`record_entry`].
pub fn record_entry_in(
    root: &Path,
    agent_dir: &str,
    session_id: &str,
    kind: EntryKind,
    payload: serde_json::Value,
) -> tokio::sync::oneshot::Receiver<()> {
    let entry = TranscriptEntry {
        t: now_epoch_ms(),
        k: kind,
        p: payload,
        steer: false,
    };
    queue_for(root, agent_dir, session_id, PendingRecord::Entry(entry))
}

/// Online native-steer recorder: marks in-memory replay history and skips JSONL disk I/O
/// unless `DIMO_LEGACY_JSONL_SHADOW_WRITE=1`.
pub fn record_steer(
    agent_dir: &str,
    session_id: &str,
    payload: serde_json::Value,
) -> tokio::sync::oneshot::Receiver<()> {
    mark_session_recorded(agent_dir, session_id);
    if !legacy_jsonl_shadow_write_enabled() {
        return resolved_ack();
    }
    record_steer_in(&dimo_acp_transcripts_root(), agent_dir, session_id, payload)
}

/// Root-injectable core of [`record_steer`].
pub fn record_steer_in(
    root: &Path,
    agent_dir: &str,
    session_id: &str,
    payload: serde_json::Value,
) -> tokio::sync::oneshot::Receiver<()> {
    let entry = TranscriptEntry {
        t: now_epoch_ms(),
        k: EntryKind::Prompt,
        p: payload,
        steer: true,
    };
    queue_for(root, agent_dir, session_id, PendingRecord::Entry(entry))
}

/// Flush any buffered write-behind chunks for `session_id` to disk on the writer thread.
pub fn flush_in(
    root: &Path,
    agent_dir: &str,
    session_id: &str,
) -> tokio::sync::oneshot::Receiver<()> {
    queue_for(root, agent_dir, session_id, PendingRecord::Flush)
}

/// Replace the entire transcript file on the writer thread.
pub fn replace_in(
    root: &Path,
    agent_dir: &str,
    session_id: &str,
    content: String,
) -> tokio::sync::oneshot::Receiver<()> {
    queue_for(root, agent_dir, session_id, PendingRecord::Replace(content))
}

fn queue_for(
    root: &Path,
    agent_dir: &str,
    session_id: &str,
    record: PendingRecord,
) -> tokio::sync::oneshot::Receiver<()> {
    let Some(path) = transcript_path_in(root, agent_dir, session_id) else {
        tracing::debug!(
            "[acp-transcript] skipping record: unsafe id agent={agent_dir} session={session_id}"
        );
        let (_tx, rx) = tokio::sync::oneshot::channel();
        return rx;
    };
    enqueue(path, record)
}

/// Append one already-serialized line, synchronously (used by test fixtures).
pub fn append_line_in(root: &Path, agent_dir: &str, session_id: &str, line: &str) {
    let Some(path) = transcript_path_in(root, agent_dir, session_id) else {
        tracing::debug!(
            "[acp-transcript] skipping append: unsafe id agent={agent_dir} session={session_id}"
        );
        return;
    };
    if line.is_empty() {
        return;
    }
    let write = || -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?;
        f.write_all(format!("{line}\n").as_bytes())
    };
    if let Err(e) = write() {
        tracing::debug!("[acp-transcript] append failed for {}: {e}", path.display());
    }
}

/// Synchronous replay gate (in-memory live history + any existing on-disk archive).
pub fn has_recorded_history(agent_dir: &str, session_id: &str) -> bool {
    is_session_recorded_in_memory(agent_dir, session_id)
        || has_recorded_history_in(&dimo_acp_transcripts_root(), agent_dir, session_id)
}

/// Authoritative async replay gate: checks in-memory state, existing archives, AND SQLite
/// (`conversation_turns` / `conversation_events`) via the registered probe.
pub async fn has_recorded_history_for_session(
    conversation_id: Option<uuid::Uuid>,
    agent_dir: &str,
    session_id: &str,
) -> bool {
    if has_recorded_history(agent_dir, session_id) {
        return true;
    }
    let probe = REGISTERED_HISTORY_PROBE
        .read()
        .ok()
        .and_then(|guard| guard.clone());
    if let Some(probe) = probe {
        return probe(
            conversation_id,
            agent_dir.to_string(),
            session_id.to_string(),
        )
        .await;
    }
    false
}

/// Root-injectable core of [`has_recorded_history`].
pub fn has_recorded_history_in(root: &Path, agent_dir: &str, session_id: &str) -> bool {
    let Some(path) = transcript_path_in(root, agent_dir, session_id) else {
        return false;
    };
    if has_pending_prompt(&path) {
        return true;
    }
    has_entries_in(root, agent_dir, session_id)
}

/// Authoritative async `session/load` replay claim backed by SQLite + in-memory flight lock.
pub async fn claim_replay_for_session(
    conversation_id: Option<uuid::Uuid>,
    agent_dir: &str,
    session_id: &str,
    header: &TranscriptHeader,
) -> bool {
    if !safe_component(agent_dir) || !safe_component(session_id) {
        return false;
    }
    if has_recorded_history_for_session(conversation_id, agent_dir, session_id).await {
        return false;
    }
    let key = (agent_dir.to_string(), session_id.to_string());
    let inserted = CLAIMED_REPLAYS
        .lock()
        .map(|mut set| set.insert(key.clone()))
        .unwrap_or(false);
    if !inserted {
        return false;
    }
    if legacy_jsonl_shadow_write_enabled()
        && !claim_replay_transcript_in(&dimo_acp_transcripts_root(), agent_dir, session_id, header)
    {
        if let Ok(mut set) = CLAIMED_REPLAYS.lock() {
            set.remove(&key);
        }
        return false;
    }
    true
}

/// Release an unrecorded `session/load` replay claim when the RPC fails.
pub async fn release_unrecorded_replay_for_session(
    conversation_id: Option<uuid::Uuid>,
    agent_dir: &str,
    session_id: &str,
) {
    if has_recorded_history_for_session(conversation_id, agent_dir, session_id).await {
        return;
    }
    if let Ok(mut set) = CLAIMED_REPLAYS.lock() {
        set.remove(&(agent_dir.to_string(), session_id.to_string()));
    }
    if legacy_jsonl_shadow_write_enabled() {
        release_unrecorded_replay_claim_in(&dimo_acp_transcripts_root(), agent_dir, session_id);
    }
}

/// Sync replay claim (in-memory when shadow write is off; file-backed when shadow write is on).
pub fn claim_replay_transcript(
    agent_dir: &str,
    session_id: &str,
    header: &TranscriptHeader,
) -> bool {
    if !safe_component(agent_dir) || !safe_component(session_id) {
        return false;
    }
    if has_recorded_history(agent_dir, session_id) {
        return false;
    }
    let key = (agent_dir.to_string(), session_id.to_string());
    let inserted = CLAIMED_REPLAYS
        .lock()
        .map(|mut set| set.insert(key.clone()))
        .unwrap_or(false);
    if !inserted {
        return false;
    }
    if legacy_jsonl_shadow_write_enabled()
        && !claim_replay_transcript_in(&dimo_acp_transcripts_root(), agent_dir, session_id, header)
    {
        if let Ok(mut set) = CLAIMED_REPLAYS.lock() {
            set.remove(&key);
        }
        return false;
    }
    true
}

pub fn claim_replay_transcript_in(
    root: &Path,
    agent_dir: &str,
    session_id: &str,
    header: &TranscriptHeader,
) -> bool {
    if has_recorded_history_in(root, agent_dir, session_id) {
        return false;
    }
    let Some(path) = transcript_path_in(root, agent_dir, session_id) else {
        return false;
    };
    if let Some(parent) = path.parent()
        && std::fs::create_dir_all(parent).is_err()
    {
        return false;
    }
    let mut file = match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(file) => file,
        Err(_) => return false,
    };
    let Ok(line) = serde_json::to_string(header) else {
        return false;
    };
    writeln!(file, "{line}").is_ok()
}

pub fn release_unrecorded_replay_claim(agent_dir: &str, session_id: &str) {
    if has_recorded_history(agent_dir, session_id) {
        return;
    }
    if let Ok(mut set) = CLAIMED_REPLAYS.lock() {
        set.remove(&(agent_dir.to_string(), session_id.to_string()));
    }
    if legacy_jsonl_shadow_write_enabled() {
        release_unrecorded_replay_claim_in(&dimo_acp_transcripts_root(), agent_dir, session_id);
    }
}

pub fn release_unrecorded_replay_claim_in(root: &Path, agent_dir: &str, session_id: &str) {
    if has_recorded_history_in(root, agent_dir, session_id) {
        return;
    }
    let Some(path) = transcript_path_in(root, agent_dir, session_id) else {
        return;
    };
    if path.is_file() {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
#[path = "acp_transcript_tests.rs"]
mod tests;
