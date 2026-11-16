//! Lossless per-turn event routing, per-instance directory isolation, and bounded
//! write-time redacted diagnostics (`<= 64 KiB`) for native engine drivers.

use std::{
    collections::HashMap,
    path::Path,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    task::{Context, Poll},
};

use futures::Stream;
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, BufReader},
    sync::mpsc,
};

use crate::{
    engine::{EngineEvent, EngineHandle, EngineStartSpec, NativeEngineKind},
    stderr_tail::{StderrTail, sanitize_diagnostic},
};

/// Normative upper bound (`64 KiB`) for any single diagnostic or error payload
/// surfaced by a native engine driver (`docs/specs/agent-driver-engine.md` §5.3).
pub const MAX_DIAGNOSTIC_PAYLOAD_BYTES: usize = 64 * 1024;

/// Truncates `s` to at most `max_bytes` UTF-8 bytes without splitting any codepoint.
/// When truncation occurs and `max_bytes` has room for `…` (3 bytes), appends `…`
/// while still guaranteeing `result.len() <= max_bytes`.
pub fn truncate_utf8_bytes(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    if max_bytes == 0 {
        return String::new();
    }
    const ELLIPSIS: &str = "…";
    if max_bytes <= ELLIPSIS.len() {
        let mut end = max_bytes;
        while end > 0 && !s.is_char_boundary(end) {
            end -= 1;
        }
        return s[..end].to_string();
    }

    let budget = max_bytes - ELLIPSIS.len();
    let mut end = budget;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    let mut out = String::with_capacity(end + ELLIPSIS.len());
    out.push_str(&s[..end]);
    out.push_str(ELLIPSIS);
    out
}

/// Redacts credentials/ANSI sequences in `primary`, attaches redacted `StderrTail`
/// evidence when available, and enforces [`MAX_DIAGNOSTIC_PAYLOAD_BYTES`].
pub fn format_bounded_diagnostic(
    primary: &str,
    stderr_tail: Option<&StderrTail>,
    mark: Option<u64>,
) -> String {
    // Bound raw regex scan on pathological multi-megabyte error payloads before redaction,
    // keeping a generous window above 64 KiB so credentials straddling 64 KiB are scrubbed
    // prior to final byte-cap truncation.
    let pre_bounded = truncate_utf8_bytes(primary, MAX_DIAGNOSTIC_PAYLOAD_BYTES * 2);
    let redacted_primary = sanitize_diagnostic(&pre_bounded);

    let stderr_context = stderr_tail
        .and_then(|tail| {
            if let Some(m) = mark {
                let since = tail.since(m);
                if !since.is_empty() {
                    return Some(since);
                }
            }
            tail.summary()
        })
        .unwrap_or_default();

    let combined = if stderr_context.is_empty() {
        redacted_primary
    } else if redacted_primary.trim().is_empty() {
        format!("stderr:\n{stderr_context}")
    } else {
        format!("{redacted_primary}\nstderr:\n{stderr_context}")
    };

    truncate_utf8_bytes(&combined, MAX_DIAGNOSTIC_PAYLOAD_BYTES)
}

/// Spawns a background task draining subprocess `stderr` into a write-time redacted
/// [`StderrTail`] ring buffer.
pub fn spawn_stderr_tail_reader<R>(stderr: R, tail: Arc<StderrTail>, target_label: &'static str)
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut buf = Vec::with_capacity(1024);
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) => break,
                Ok(_) => {
                    let text = String::from_utf8_lossy(&buf);
                    tail.push(&text);
                    tracing::debug!(target: "native_engine_stderr", engine = target_label, "{}", text.trim_end());
                }
                Err(_) => break,
            }
        }
    });
}

fn create_private_dir_all(path: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

pub(crate) fn sanitize_instance_dir_segment(raw: &str) -> String {
    let mut prefix: String = raw
        .chars()
        .take(48)
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if prefix.is_empty() {
        prefix.push_str("instance");
    }
    let digest = Sha256::digest(raw.as_bytes());
    let short_hash = format!(
        "{:02x}{:02x}{:02x}{:02x}",
        digest[0], digest[1], digest[2], digest[3]
    );
    format!("{prefix}-{short_hash}")
}

/// Allocates isolated per-`provider_instance_id` temp directories (`0o700` on Unix)
/// and, when `spec.isolate_profile` is `true` and `profile_dir_keys` is `Some((env_key, dir_name))`,
/// an isolated profile configuration directory unless already overridden in `spec.env`.
pub fn prepare_instance_isolation_env_for_keys(
    spec: &EngineStartSpec,
    profile_dir_keys: Option<(&str, &str)>,
) -> std::io::Result<HashMap<String, String>> {
    let Some(instance_id) = spec
        .provider_instance_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return Ok(HashMap::new());
    };

    let root_base = spec
        .env
        .get("DIMO_PROVIDER_INSTANCES_ROOT")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("dimo-provider-instances"));

    let instance_root = root_base.join(sanitize_instance_dir_segment(instance_id));
    create_private_dir_all(&instance_root)?;

    let tmp_dir = instance_root.join("tmp");
    create_private_dir_all(&tmp_dir)?;

    let mut isolated = HashMap::new();
    if spec.isolate_profile
        && let Some((env_key, dir_name)) = profile_dir_keys
        && !spec.env.contains_key(env_key)
    {
        let profile_dir = instance_root.join(dir_name);
        create_private_dir_all(&profile_dir)?;
        isolated.insert(
            env_key.to_string(),
            profile_dir.to_string_lossy().into_owned(),
        );
    }

    let tmp_str = tmp_dir.to_string_lossy().into_owned();
    for key in ["TMPDIR", "TMP", "TEMP"] {
        if !spec.env.contains_key(key) {
            isolated.insert(key.to_string(), tmp_str.clone());
        }
    }

    Ok(isolated)
}

/// Allocates isolated per-`provider_instance_id` temp directories (`0o700` on Unix)
/// and, when `spec.isolate_profile` is `true`, isolated `CODEX_HOME` / `CLAUDE_CONFIG_DIR`
/// directories if the caller has not explicitly overridden them in `spec.env`.
pub fn prepare_instance_isolation_env(
    spec: &EngineStartSpec,
    kind: NativeEngineKind,
) -> std::io::Result<HashMap<String, String>> {
    let keys = match kind {
        NativeEngineKind::CodexNative => Some(("CODEX_HOME", "codex-home")),
        NativeEngineKind::ClaudeNative => Some(("CLAUDE_CONFIG_DIR", "claude-config")),
    };
    prepare_instance_isolation_env_for_keys(spec, keys)
}

#[derive(Clone)]
pub enum TurnRouteFilter {
    CodexThread {
        thread_id: String,
    },
    ClaudePrompt {
        prompt_id: String,
        handle: EngineHandle,
    },
}

impl TurnRouteFilter {
    /// Pure predicate — no side effects. Returns `true` when `event` should be
    /// delivered to this subscriber.
    fn matches(&self, event: &EngineEvent) -> bool {
        match self {
            TurnRouteFilter::CodexThread { thread_id } => match event {
                EngineEvent::SessionInitialized { session_id, .. }
                | EngineEvent::TurnStarted { session_id, .. }
                | EngineEvent::AssistantTextDelta { session_id, .. }
                | EngineEvent::ThinkingDelta { session_id, .. }
                | EngineEvent::AssistantMessage { session_id, .. }
                | EngineEvent::ToolCall { session_id, .. }
                | EngineEvent::ToolResult { session_id, .. }
                | EngineEvent::TerminalOutputDelta { session_id, .. }
                | EngineEvent::PermissionRequested { session_id, .. }
                | EngineEvent::PermissionResolved { session_id, .. }
                | EngineEvent::QuestionRequested { session_id, .. }
                | EngineEvent::PlanUpdated { session_id, .. }
                | EngineEvent::UsageUpdated { session_id, .. }
                | EngineEvent::SubagentSpawned { session_id, .. }
                | EngineEvent::SubagentUpdated { session_id, .. }
                | EngineEvent::SubagentCompleted { session_id, .. }
                | EngineEvent::HookEvent { session_id, .. }
                | EngineEvent::PromptSteered { session_id, .. }
                | EngineEvent::AutoCompactionChanged { session_id, .. }
                | EngineEvent::TurnCompleted { session_id, .. }
                | EngineEvent::TurnInterrupted { session_id, .. }
                | EngineEvent::TurnError { session_id, .. } => {
                    session_id.as_deref().is_none_or(|sid| sid == thread_id)
                }
                _ => true,
            },
            TurnRouteFilter::ClaudePrompt { prompt_id, .. } => match event {
                EngineEvent::RateLimitsUpdated { .. }
                | EngineEvent::CacheStatusUpdated { .. } => true,
                EngineEvent::TurnStarted { prompt_id: pid, .. }
                | EngineEvent::AssistantTextDelta { prompt_id: pid, .. }
                | EngineEvent::ThinkingDelta { prompt_id: pid, .. }
                | EngineEvent::AssistantMessage { prompt_id: pid, .. }
                | EngineEvent::ToolCall { prompt_id: pid, .. }
                | EngineEvent::ToolResult { prompt_id: pid, .. }
                | EngineEvent::PermissionRequested { prompt_id: pid, .. }
                | EngineEvent::PermissionResolved { prompt_id: pid, .. }
                | EngineEvent::QuestionRequested { prompt_id: pid, .. }
                | EngineEvent::PlanUpdated { prompt_id: pid, .. }
                | EngineEvent::UsageUpdated { prompt_id: pid, .. }
                | EngineEvent::SubagentSpawned { prompt_id: pid, .. }
                | EngineEvent::SubagentUpdated { prompt_id: pid, .. }
                | EngineEvent::SubagentCompleted { prompt_id: pid, .. }
                | EngineEvent::HookEvent { prompt_id: pid, .. }
                | EngineEvent::PromptSteered { prompt_id: pid, .. }
                | EngineEvent::TurnCompleted { prompt_id: pid, .. }
                | EngineEvent::TurnInterrupted { prompt_id: pid, .. }
                | EngineEvent::TurnError { prompt_id: pid, .. } => {
                    pid.as_deref().is_none_or(|p| p == prompt_id)
                }
                _ => true,
            },
        }
    }

    /// Side-effecting observation — called **outside** the subscribers lock to
    /// avoid nested lock acquisition (subscribers Mutex → session_id RwLock).
    fn observe(&self, event: &EngineEvent) {
        if let TurnRouteFilter::ClaudePrompt { handle, .. } = self {
            match event {
                EngineEvent::SessionInitialized {
                    session_id: Some(sid),
                    ..
                }
                | EngineEvent::TurnStarted {
                    session_id: Some(sid),
                    ..
                }
                | EngineEvent::TurnCompleted {
                    session_id: Some(sid),
                    ..
                } if !crate::engine::is_placeholder_engine_session_id(sid) => {
                    handle.set_external_session_id(Some(sid.clone()));
                }
                _ => {}
            }
        }
    }

    fn fallback_ids(&self) -> (Option<String>, Option<String>) {
        match self {
            TurnRouteFilter::CodexThread { thread_id } => (None, Some(thread_id.clone())),
            TurnRouteFilter::ClaudePrompt { prompt_id, handle } => {
                (Some(prompt_id.clone()), handle.external_session_id())
            }
        }
    }
}

struct TurnSubscriber {
    id: u64,
    filter: TurnRouteFilter,
    stderr_mark: u64,
    tx: mpsc::UnboundedSender<EngineEvent>,
}

/// Lossless MPSC event router replacing `tokio::sync::broadcast::Receiver` for
/// active turns (`docs/specs/agent-driver-engine.md` §4.2).
#[derive(Clone, Default)]
pub struct TurnEventRouter {
    next_id: Arc<AtomicU64>,
    subscribers: Arc<Mutex<Vec<TurnSubscriber>>>,
}

impl TurnEventRouter {
    pub fn new() -> Self {
        Self {
            next_id: Arc::new(AtomicU64::new(1)),
            subscribers: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Registers a lossless per-turn stream BEFORE dispatching `turn/start` or
    /// `prompt/send` so high-frequency bursts never race or drop events.
    pub fn register_turn(
        &self,
        filter: TurnRouteFilter,
        stderr_tail: Arc<StderrTail>,
    ) -> TurnEventStream {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let stderr_mark = stderr_tail.mark();
        let (tx, rx) = mpsc::unbounded_channel();
        if let Ok(mut subs) = self.subscribers.lock() {
            subs.push(TurnSubscriber {
                id,
                filter,
                stderr_mark,
                tx,
            });
        }
        TurnEventStream {
            subscriber_id: id,
            router: self.clone(),
            rx,
            stderr_tail,
            stderr_mark,
            saw_output: false,
            terminated: false,
        }
    }

    pub fn publish(&self, event: &EngineEvent) {
        let matched_filters = {
            let Ok(mut subs) = self.subscribers.lock() else {
                return;
            };
            let mut matched = Vec::new();
            subs.retain(|sub| {
                if !sub.filter.matches(event) {
                    return true;
                }
                matched.push(sub.filter.clone());
                sub.tx.send(event.clone()).is_ok()
            });
            matched
        };
        // Side-effecting observation runs **after** the subscribers lock is
        // released, preventing nested lock acquisition (subscribers Mutex →
        // external_session_id RwLock) that could deadlock.
        for filter in matched_filters {
            filter.observe(event);
        }
    }

    pub fn fail_active_turns(&self, reason: &str, stderr_tail: &StderrTail) {
        let drained: Vec<TurnSubscriber> = match self.subscribers.lock() {
            Ok(mut subs) => std::mem::take(&mut *subs),
            Err(_) => return,
        };
        for sub in drained {
            let (prompt_id, session_id) = sub.filter.fallback_ids();
            let message = format_bounded_diagnostic(reason, Some(stderr_tail), Some(sub.stderr_mark));
            let _ = sub.tx.send(EngineEvent::TurnError {
                prompt_id,
                session_id,
                message,
            });
        }
    }

    fn unregister(&self, subscriber_id: u64) {
        if let Ok(mut subs) = self.subscribers.lock() {
            subs.retain(|s| s.id != subscriber_id);
        }
    }
}

pub struct TurnEventStream {
    subscriber_id: u64,
    router: TurnEventRouter,
    rx: mpsc::UnboundedReceiver<EngineEvent>,
    stderr_tail: Arc<StderrTail>,
    stderr_mark: u64,
    saw_output: bool,
    terminated: bool,
}

impl TurnEventStream {
    fn record_output(&mut self, event: &EngineEvent) {
        match event {
            EngineEvent::AssistantTextDelta { text, .. } if !text.is_empty() => {
                self.saw_output = true;
            }
            EngineEvent::AssistantMessage { text, .. } if !text.is_empty() => {
                self.saw_output = true;
            }
            EngineEvent::ThinkingDelta { thinking, .. } if !thinking.is_empty() => {
                self.saw_output = true;
            }
            EngineEvent::ToolCall { .. }
            | EngineEvent::ToolResult { .. }
            | EngineEvent::TerminalOutputDelta { .. }
            | EngineEvent::PermissionRequested { .. }
            | EngineEvent::QuestionRequested { .. }
            | EngineEvent::PlanUpdated { .. }
            | EngineEvent::SubagentSpawned { .. }
            | EngineEvent::SubagentUpdated { .. } => {
                self.saw_output = true;
            }
            _ => {}
        }
    }
}

impl Stream for TurnEventStream {
    type Item = EngineEvent;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.terminated {
            return Poll::Ready(None);
        }

        match self.rx.poll_recv(cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(None) => {
                self.terminated = true;
                self.router.unregister(self.subscriber_id);
                Poll::Ready(None)
            }
            Poll::Ready(Some(event)) => {
                self.record_output(&event);
                let is_terminal = matches!(
                    event,
                    EngineEvent::TurnCompleted { .. }
                        | EngineEvent::TurnInterrupted { .. }
                        | EngineEvent::TurnError { .. }
                );
                if is_terminal {
                    self.terminated = true;
                    self.router.unregister(self.subscriber_id);
                }

                let transformed = match event {
                    EngineEvent::TurnError {
                        prompt_id,
                        session_id,
                        message,
                    } => EngineEvent::TurnError {
                        prompt_id,
                        session_id,
                        message: format_bounded_diagnostic(
                            &message,
                            Some(&self.stderr_tail),
                            Some(self.stderr_mark),
                        ),
                    },
                    EngineEvent::TurnCompleted {
                        prompt_id,
                        turn_id,
                        session_id,
                        stop_reason,
                        served_model,
                    } => {
                        if !self.saw_output && !self.stderr_tail.since(self.stderr_mark).is_empty() {
                            EngineEvent::TurnError {
                                prompt_id,
                                session_id,
                                message: format_bounded_diagnostic(
                                    "Native engine turn finished with empty output",
                                    Some(&self.stderr_tail),
                                    Some(self.stderr_mark),
                                ),
                            }
                        } else {
                            EngineEvent::TurnCompleted {
                                prompt_id,
                                turn_id,
                                session_id,
                                stop_reason,
                                served_model,
                            }
                        }
                    }
                    other => other,
                };

                Poll::Ready(Some(transformed))
            }
        }
    }
}

impl Drop for TurnEventStream {
    fn drop(&mut self) {
        self.router.unregister(self.subscriber_id);
    }
}
