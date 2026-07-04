//! The delegation broker: validates a `delegate_to_agent` request, spawns a
//! child ACP session, tracks it, and resolves the parent's tool call when the
//! child's turn completes.
//!
//! This module is the synchronous-resolution core (T2.4): start a delegation,
//! register it as running, and complete it. Async status polling / cancel /
//! result-cache eviction (T2.5) and parallel-fan-out correlation + setup-window
//! race handling (T2.6) build on this state.
//!
//! Concurrency: all task state lives behind a single `std::sync::Mutex`
//! ([`PendingInner`]). The guard is only ever held for synchronous map
//! mutations and is dropped before any `.await`, so no lock is held across a
//! suspension point.

use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use agents::registry::AgentKind;
use tokio::sync::Notify;
use uuid::Uuid;

use crate::{
    depth::compute_depth,
    event_emitter::{DelegationCompletedEvent, DelegationEventEmitter, DelegationStartedEvent},
    lookups::{ChildStatusLookup, ChildStatusRecord, DepthLookup},
    meta_writer::DelegationMetaWriter,
    spawner::ConnectionSpawner,
    types::{
        DelegationConfig, DelegationError, DelegationLink, DelegationOutcome, DelegationRequest,
        DelegationTaskReport, TaskStatus,
    },
};

/// Per-result text cap. Full output stays in the child session.
const COMPLETED_TEXT_CAP: usize = 256 * 1024;

/// Hard ceiling on a single bounded status wait. The listener also caps the
/// caller's `wait_ms`; this is a defensive backstop inside the broker.
const STATUS_WAIT_MAX_MS: u64 = 60_000;

/// How long a status poll should block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusWait {
    /// Return a snapshot immediately.
    Immediate,
    /// Block up to `ms` (capped at [`STATUS_WAIT_MAX_MS`]).
    Bounded(u64),
    /// Block until any requested task reaches a terminal state.
    Infinite,
}

/// A delegation currently running in the background.
struct RunningTask {
    parent_connection_id: String,
    parent_tool_use_id: String,
    /// Whether `parent_tool_use_id` is a real ACP tool call (vs a synthetic
    /// `delegation-…` id minted when the MCP client supplied none). Meta writes
    /// are skipped when false — there is no real tool call to attach to.
    has_real_tool_call: bool,
    child_connection_id: String,
    child_session_id: Uuid,
    agent_type: AgentKind,
    started_at: Instant,
}

/// A delegation that has reached a terminal state, cached for status polls.
#[derive(Clone)]
struct CompletedTask {
    parent_connection_id: String,
    status: TaskStatus,
    child_session_id: Option<Uuid>,
    agent_type: Option<AgentKind>,
    text: Option<String>,
    error_code: Option<String>,
    message: Option<String>,
    duration_ms: Option<u64>,
}

#[derive(Default)]
struct PendingInner {
    running: HashMap<String, RunningTask>,
    completed: HashMap<String, CompletedTask>,
    /// Per-parent FIFO of completed call ids, oldest first (for eviction).
    completed_order: HashMap<String, VecDeque<String>>,
    /// Per-parent cached result text byte count, driving eviction.
    completed_bytes: HashMap<String, usize>,
    /// Call ids reserved during the spawn→send setup window (value = reserve
    /// instant). Lets a child that finishes mid-setup buffer its terminal
    /// outcome rather than have it dropped.
    setups: HashMap<String, Instant>,
    /// Terminal outcomes that arrived before the task was registered as running;
    /// drained by `start_delegation` at registration.
    early_completes: HashMap<String, DelegationOutcome>,
}

/// Everything `finalize` needs to resolve a task to a terminal report,
/// regardless of whether it resolved normally or won the setup-window race.
struct FinalizeCtx {
    call_id: String,
    parent_connection_id: String,
    parent_tool_use_id: String,
    has_real_tool_call: bool,
    child_connection_id: String,
    child_session_id: Uuid,
    agent_type: AgentKind,
    duration_ms: u64,
}

/// Outcome of the post-send registration step.
enum Resolution {
    /// A terminal outcome beat registration; resolve immediately.
    Early {
        outcome: DelegationOutcome,
        reserved_at: Instant,
    },
    /// No early terminal; the task is now tracked as running.
    Registered,
}

/// Insert a terminal result and evict the parent's oldest cached results while
/// over the byte cap. The just-inserted (newest) result is never evicted.
/// `cap == 0` disables eviction.
fn insert_completed(inner: &mut PendingInner, call_id: String, task: CompletedTask, cap: usize) {
    let parent = task.parent_connection_id.clone();
    let bytes = task.text.as_ref().map(String::len).unwrap_or(0);
    inner.completed.insert(call_id.clone(), task);
    inner
        .completed_order
        .entry(parent.clone())
        .or_default()
        .push_back(call_id);
    *inner.completed_bytes.entry(parent.clone()).or_default() += bytes;

    if cap == 0 {
        return;
    }
    while inner.completed_bytes.get(&parent).copied().unwrap_or(0) > cap {
        let order = match inner.completed_order.get_mut(&parent) {
            Some(order) if order.len() > 1 => order,
            _ => break, // keep the newest result even if it alone exceeds the cap
        };
        let Some(oldest) = order.pop_front() else {
            break;
        };
        if let Some(removed) = inner.completed.remove(&oldest) {
            let removed_bytes = removed.text.as_ref().map(String::len).unwrap_or(0);
            let entry = inner.completed_bytes.entry(parent.clone()).or_default();
            *entry = entry.saturating_sub(removed_bytes);
        }
    }
}

/// Cheap-to-clone handle over the broker's `Arc`-wrapped dependencies + state.
#[derive(Clone)]
pub struct DelegationBroker {
    spawner: Arc<dyn ConnectionSpawner>,
    depth_lookup: Arc<dyn DepthLookup>,
    status_lookup: Arc<dyn ChildStatusLookup>,
    meta_writer: Arc<dyn DelegationMetaWriter>,
    event_emitter: Arc<dyn DelegationEventEmitter>,
    config: Arc<Mutex<DelegationConfig>>,
    pending: Arc<Mutex<PendingInner>>,
    /// Woken whenever a task reaches a terminal state (used by status waits in T2.5).
    result_notify: Arc<Notify>,
}

impl DelegationBroker {
    pub fn new(
        spawner: Arc<dyn ConnectionSpawner>,
        depth_lookup: Arc<dyn DepthLookup>,
        status_lookup: Arc<dyn ChildStatusLookup>,
        meta_writer: Arc<dyn DelegationMetaWriter>,
        event_emitter: Arc<dyn DelegationEventEmitter>,
        config: DelegationConfig,
    ) -> Self {
        Self {
            spawner,
            depth_lookup,
            status_lookup,
            meta_writer,
            event_emitter,
            config: Arc::new(Mutex::new(config)),
            pending: Arc::new(Mutex::new(PendingInner::default())),
            result_notify: Arc::new(Notify::new()),
        }
    }

    pub fn config_snapshot(&self) -> DelegationConfig {
        self.config.lock().unwrap().clone()
    }

    pub fn set_config(&self, config: DelegationConfig) {
        *self.config.lock().unwrap() = config;
    }

    /// Validate, spawn, and register a delegation. Returns a `Running` ack on
    /// success, or a terminal report when setup fails (disabled / depth / spawn
    /// / send). The child runs in the background; [`Self::complete_call`]
    /// resolves it later.
    pub async fn start_delegation(&self, req: DelegationRequest) -> DelegationTaskReport {
        let config = self.config_snapshot();
        if !config.enabled {
            return failed_setup_report("canceled", "delegation is disabled");
        }

        // Depth pre-check: walk the parent chain. Reject if the child would sit
        // strictly past the configured limit (root delegates at depth 1).
        let depth_lookup = self.depth_lookup.clone();
        let parent_depth = match compute_depth(
            req.parent_session_id,
            move |id| {
                let lookup = depth_lookup.clone();
                async move { lookup.parent_session_id(id).await }
            },
            config.depth_limit + 1,
        )
        .await
        {
            Ok(depth) => depth,
            Err(err) => return failed_setup_report("subagent_error", &err.to_string()),
        };
        if parent_depth + 1 > config.depth_limit {
            let err = DelegationError::DepthLimitExceeded {
                current_depth: parent_depth + 1,
                limit: config.depth_limit,
            };
            return failed_setup_report("depth_limit", &err.to_string());
        }

        let call_id = Uuid::new_v4().to_string();
        // Fall back to a synthetic tool-use id when the MCP client didn't supply
        // one (full ACP tool_call correlation is deferred to M5). `has_real_tool_call`
        // records this explicitly so meta writes can be skipped without inferring
        // it from the id's textual shape.
        let has_real_tool_call = !req.parent_tool_use_id.trim().is_empty();
        let parent_tool_use_id = if has_real_tool_call {
            req.parent_tool_use_id.clone()
        } else {
            format!("delegation-{call_id}")
        };

        // Spawn the child connection.
        let child_connection_id = match self
            .spawner
            .spawn(
                &req.parent_connection_id,
                req.agent_type,
                req.working_dir.clone(),
            )
            .await
        {
            Ok(id) => id,
            Err(err) => return failed_setup_report("spawn_failed", &err.to_string()),
        };

        // Reserve the call id BEFORE sending so a child that finishes during the
        // send window buffers its terminal outcome instead of having it dropped.
        {
            let mut pending = self.pending.lock().unwrap();
            pending.setups.insert(call_id.clone(), Instant::now());
        }

        let link = DelegationLink {
            parent_session_id: req.parent_session_id,
            parent_tool_use_id: parent_tool_use_id.clone(),
            delegation_call_id: call_id.clone(),
            agent_type: req.agent_type,
        };
        let child_session_id = match self
            .spawner
            .send_prompt_linked(&child_connection_id, req.task.clone(), link)
            .await
        {
            Ok(id) => id,
            Err(err) => {
                // Clean up both reservation maps so a terminal that raced into
                // `early_completes` during this failed send isn't orphaned.
                {
                    let mut pending = self.pending.lock().unwrap();
                    pending.setups.remove(&call_id);
                    pending.early_completes.remove(&call_id);
                }
                let _ = self.spawner.disconnect(&child_connection_id).await;
                return failed_setup_report("spawn_failed", &err.to_string());
            }
        };

        // Drain any terminal that beat registration; otherwise register running.
        let resolution = {
            let mut pending = self.pending.lock().unwrap();
            let reserved_at = pending.setups.remove(&call_id).unwrap_or_else(Instant::now);
            if let Some(outcome) = pending.early_completes.remove(&call_id) {
                Resolution::Early {
                    outcome,
                    reserved_at,
                }
            } else {
                pending.running.insert(
                    call_id.clone(),
                    RunningTask {
                        parent_connection_id: req.parent_connection_id.clone(),
                        parent_tool_use_id: parent_tool_use_id.clone(),
                        has_real_tool_call,
                        child_connection_id: child_connection_id.clone(),
                        child_session_id,
                        agent_type: req.agent_type,
                        started_at: reserved_at,
                    },
                );
                Resolution::Registered
            }
        };

        // Announce the start regardless — the child did run.
        self.event_emitter
            .emit_started(DelegationStartedEvent {
                parent_connection_id: req.parent_connection_id.clone(),
                parent_tool_use_id: parent_tool_use_id.clone(),
                child_session_id,
                agent_type: req.agent_type,
                task_preview: preview(&req.task),
            })
            .await;

        match resolution {
            Resolution::Early {
                outcome,
                reserved_at,
            } => {
                let ctx = FinalizeCtx {
                    call_id,
                    parent_connection_id: req.parent_connection_id,
                    parent_tool_use_id,
                    has_real_tool_call,
                    child_connection_id,
                    child_session_id,
                    agent_type: req.agent_type,
                    duration_ms: reserved_at.elapsed().as_millis() as u64,
                };
                self.finalize(ctx, outcome).await
            }
            Resolution::Registered => {
                if has_real_tool_call {
                    self.meta_writer
                        .write_meta(
                            &req.parent_connection_id,
                            &parent_tool_use_id,
                            running_meta(&child_session_id, req.agent_type),
                        )
                        .await;
                }
                running_report(&call_id, child_session_id, req.agent_type)
            }
        }
    }

    /// Resolve a running delegation with its terminal outcome. Moves the task
    /// from `running` to `completed`, tears down the child, persists terminal
    /// meta, emits the completed event, and wakes status waiters.
    pub async fn complete_call(&self, call_id: &str, outcome: DelegationOutcome) {
        let task = {
            let mut pending = self.pending.lock().unwrap();
            match pending.running.remove(call_id) {
                Some(task) => task,
                None => {
                    // Still in the setup window? Buffer the terminal so
                    // start_delegation applies it at registration. Otherwise the
                    // task is unknown / already terminal — drop.
                    if pending.setups.contains_key(call_id) {
                        pending.early_completes.insert(call_id.to_string(), outcome);
                    }
                    return;
                }
            }
        };
        let ctx = FinalizeCtx {
            call_id: call_id.to_string(),
            parent_connection_id: task.parent_connection_id,
            parent_tool_use_id: task.parent_tool_use_id,
            has_real_tool_call: task.has_real_tool_call,
            child_connection_id: task.child_connection_id,
            child_session_id: task.child_session_id,
            agent_type: task.agent_type,
            duration_ms: task.started_at.elapsed().as_millis() as u64,
        };
        self.finalize(ctx, outcome).await;
    }

    /// Move a task to `completed` (with eviction), tear down the child, persist
    /// terminal meta, emit the completed event, and wake status waiters. Shared
    /// by normal completion and the setup-window early-resolution path.
    async fn finalize(&self, ctx: FinalizeCtx, outcome: DelegationOutcome) -> DelegationTaskReport {
        let (status, text, error_code, message) = terminal_fields(&outcome);
        let cap = self.config_snapshot().completed_cache_cap_bytes;
        let completed = CompletedTask {
            parent_connection_id: ctx.parent_connection_id.clone(),
            status,
            child_session_id: Some(ctx.child_session_id),
            agent_type: Some(ctx.agent_type),
            text,
            error_code,
            message,
            duration_ms: Some(ctx.duration_ms),
        };
        {
            let mut pending = self.pending.lock().unwrap();
            insert_completed(&mut pending, ctx.call_id.clone(), completed.clone(), cap);
        }

        let _ = self.spawner.disconnect(&ctx.child_connection_id).await;
        if ctx.has_real_tool_call {
            self.meta_writer
                .write_meta(
                    &ctx.parent_connection_id,
                    &ctx.parent_tool_use_id,
                    terminal_meta(&completed),
                )
                .await;
        }
        self.event_emitter
            .emit_completed(DelegationCompletedEvent {
                parent_connection_id: ctx.parent_connection_id.clone(),
                parent_tool_use_id: ctx.parent_tool_use_id.clone(),
                child_session_id: ctx.child_session_id,
                agent_type: ctx.agent_type,
                outcome,
            })
            .await;
        self.result_notify.notify_waiters();
        completed_report(&ctx.call_id, &completed)
    }

    /// Poll (or wait on) one or more delegation tasks, returning one report per
    /// id in the requested order. Returns as soon as ANY requested task is
    /// settled (terminal/unknown), honoring the wait mode.
    pub async fn get_tasks_status(
        &self,
        task_ids: &[String],
        wait: StatusWait,
    ) -> Vec<DelegationTaskReport> {
        let deadline = match wait {
            StatusWait::Bounded(ms) => {
                Some(Instant::now() + Duration::from_millis(ms.min(STATUS_WAIT_MAX_MS)))
            }
            _ => None,
        };
        loop {
            // Register for wakeups BEFORE snapshotting so a completion landing
            // mid-snapshot can't be missed.
            let notified = self.result_notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            let (reports, any_settled) = self.assemble_reports(task_ids).await;
            if matches!(wait, StatusWait::Immediate) || any_settled {
                return reports;
            }
            match deadline {
                Some(dl) => {
                    let now = Instant::now();
                    if now >= dl {
                        return reports;
                    }
                    tokio::select! {
                        _ = &mut notified => {}
                        _ = tokio::time::sleep(dl - now) => {
                            return self.assemble_reports(task_ids).await.0;
                        }
                    }
                }
                None => notified.await,
            }
        }
    }

    /// Cancel a running task by id and tear down its child. If it already
    /// finished, returns its cached (or DB-recovered) report instead.
    pub async fn cancel_delegation(&self, task_id: &str) -> DelegationTaskReport {
        if let Some(report) = {
            let pending = self.pending.lock().unwrap();
            pending
                .completed
                .get(task_id)
                .map(|task| completed_report(task_id, task))
        } {
            return report;
        }

        let running = self.pending.lock().unwrap().running.remove(task_id);
        let Some(task) = running else {
            // Mid-setup (reserved but not yet running)? Mark it canceled so
            // start_delegation resolves it as canceled when it drains. `or_insert`
            // lets a real terminal that already buffered win over the cancel.
            {
                let mut pending = self.pending.lock().unwrap();
                if pending.setups.contains_key(task_id) {
                    pending
                        .early_completes
                        .entry(task_id.to_string())
                        .or_insert_with(|| {
                            DelegationOutcome::from_err(
                                DelegationError::Canceled {
                                    reason: "canceled by request".to_string(),
                                },
                                None,
                            )
                        });
                    return canceling_report(task_id);
                }
            }
            return match self.status_lookup.status_by_call_id(task_id).await {
                Some(record) => report_from_record(task_id, &record),
                None => unknown_report(task_id),
            };
        };

        let cap = self.config_snapshot().completed_cache_cap_bytes;
        let duration_ms = task.started_at.elapsed().as_millis() as u64;
        let completed = CompletedTask {
            parent_connection_id: task.parent_connection_id.clone(),
            status: TaskStatus::Canceled,
            child_session_id: Some(task.child_session_id),
            agent_type: Some(task.agent_type),
            text: None,
            error_code: Some("canceled".to_string()),
            message: Some("canceled by request".to_string()),
            duration_ms: Some(duration_ms),
        };
        {
            let mut pending = self.pending.lock().unwrap();
            insert_completed(&mut pending, task_id.to_string(), completed.clone(), cap);
        }

        let _ = self.spawner.cancel(&task.child_connection_id).await;
        let _ = self.spawner.disconnect(&task.child_connection_id).await;
        if task.has_real_tool_call {
            self.meta_writer
                .write_meta(
                    &task.parent_connection_id,
                    &task.parent_tool_use_id,
                    terminal_meta(&completed),
                )
                .await;
        }
        self.event_emitter
            .emit_completed(DelegationCompletedEvent {
                parent_connection_id: task.parent_connection_id.clone(),
                parent_tool_use_id: task.parent_tool_use_id.clone(),
                child_session_id: task.child_session_id,
                agent_type: task.agent_type,
                outcome: DelegationOutcome::from_err(
                    DelegationError::Canceled {
                        reason: "canceled by request".to_string(),
                    },
                    Some(task.child_session_id),
                ),
            })
            .await;
        self.result_notify.notify_waiters();
        completed_report(task_id, &completed)
    }

    /// Classify each requested id (completed cache → running set → DB fallback →
    /// unknown) and report whether any is settled. A task counts as settled
    /// unless it is an *in-memory* running task — the only state a `result_notify`
    /// wakeup can ever advance. A task resolvable only from the DB (or unknown)
    /// is settled for wait purposes, since the broker has no way to wake on it
    /// (otherwise an in-progress DB row would block the wait forever).
    async fn assemble_reports(&self, task_ids: &[String]) -> (Vec<DelegationTaskReport>, bool) {
        enum Slot {
            Ready {
                report: DelegationTaskReport,
                settled: bool,
            },
            NeedsDb(String),
        }
        let slots: Vec<Slot> = {
            let pending = self.pending.lock().unwrap();
            task_ids
                .iter()
                .map(|id| {
                    if let Some(task) = pending.completed.get(id) {
                        Slot::Ready {
                            report: completed_report(id, task),
                            settled: true,
                        }
                    } else if let Some(task) = pending.running.get(id) {
                        Slot::Ready {
                            report: running_report(id, task.child_session_id, task.agent_type),
                            settled: false,
                        }
                    } else {
                        Slot::NeedsDb(id.clone())
                    }
                })
                .collect()
        };

        let mut reports = Vec::with_capacity(slots.len());
        let mut any_settled = false;
        for slot in slots {
            match slot {
                Slot::Ready { report, settled } => {
                    any_settled |= settled;
                    reports.push(report);
                }
                Slot::NeedsDb(id) => {
                    let report = match self.status_lookup.status_by_call_id(&id).await {
                        Some(record) => report_from_record(&id, &record),
                        None => unknown_report(&id),
                    };
                    any_settled = true;
                    reports.push(report);
                }
            }
        }
        (reports, any_settled)
    }

    /// Test/inspection helper: number of currently-running tasks.
    #[cfg(test)]
    fn running_count(&self) -> usize {
        self.pending.lock().unwrap().running.len()
    }

    /// Test/inspection helper: clone a completed task's report, if cached.
    #[cfg(test)]
    fn completed_report(&self, call_id: &str) -> Option<DelegationTaskReport> {
        let pending = self.pending.lock().unwrap();
        pending
            .completed
            .get(call_id)
            .map(|task| completed_report(call_id, task))
    }
}

fn cap_text(text: &str) -> String {
    if text.len() <= COMPLETED_TEXT_CAP {
        text.to_string()
    } else {
        let mut end = COMPLETED_TEXT_CAP;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text[..end].to_string()
    }
}

fn terminal_fields(
    outcome: &DelegationOutcome,
) -> (TaskStatus, Option<String>, Option<String>, Option<String>) {
    match outcome {
        DelegationOutcome::Ok(success) => (
            TaskStatus::Completed,
            Some(cap_text(&success.text)),
            None,
            None,
        ),
        DelegationOutcome::Err { code, message, .. } => {
            let status = if code == "canceled" {
                TaskStatus::Canceled
            } else {
                TaskStatus::Failed
            };
            (status, None, Some(code.clone()), Some(message.clone()))
        }
    }
}

fn preview(task: &str) -> String {
    const PREVIEW_CAP: usize = 200;
    if task.len() <= PREVIEW_CAP {
        task.to_string()
    } else {
        let mut end = PREVIEW_CAP;
        while !task.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}…", &task[..end])
    }
}

fn running_report(
    call_id: &str,
    child_session_id: Uuid,
    agent_type: AgentKind,
) -> DelegationTaskReport {
    DelegationTaskReport {
        task_id: Some(call_id.to_string()),
        status: TaskStatus::Running,
        child_session_id: Some(child_session_id),
        agent_type: Some(agent_type),
        text: None,
        error_code: None,
        message: Some(format!("running in background (task_id: {call_id})")),
        duration_ms: None,
    }
}

fn completed_report(call_id: &str, task: &CompletedTask) -> DelegationTaskReport {
    DelegationTaskReport {
        task_id: Some(call_id.to_string()),
        status: task.status,
        child_session_id: task.child_session_id,
        agent_type: task.agent_type,
        text: task.text.clone(),
        error_code: task.error_code.clone(),
        message: task.message.clone(),
        duration_ms: task.duration_ms,
    }
}

fn report_from_record(call_id: &str, record: &ChildStatusRecord) -> DelegationTaskReport {
    DelegationTaskReport {
        task_id: Some(call_id.to_string()),
        status: record.status,
        child_session_id: Some(record.child_session_id),
        agent_type: record.agent_type,
        text: None,
        error_code: None,
        message: Some("result not cached; open the child session for full output".to_string()),
        duration_ms: None,
    }
}

/// A report for an id that isn't recognized. `pub(crate)` so the listener can
/// reuse the same wire-stable shape.
pub(crate) fn unknown_report(call_id: &str) -> DelegationTaskReport {
    DelegationTaskReport {
        task_id: Some(call_id.to_string()),
        status: TaskStatus::Unknown,
        child_session_id: None,
        agent_type: None,
        text: None,
        error_code: None,
        message: Some("task id not recognized".to_string()),
        duration_ms: None,
    }
}

/// A terminal setup-failure report (`task_id: None`). `pub(crate)` so the
/// listener reuses the same `error_code → status` mapping.
pub(crate) fn failed_setup_report(error_code: &str, message: &str) -> DelegationTaskReport {
    let status = if error_code == "canceled" {
        TaskStatus::Canceled
    } else {
        TaskStatus::Failed
    };
    DelegationTaskReport {
        task_id: None,
        status,
        child_session_id: None,
        agent_type: None,
        text: None,
        error_code: Some(error_code.to_string()),
        message: Some(message.to_string()),
        duration_ms: None,
    }
}

/// Ack for a task canceled while still in its setup window: the terminal
/// resolution (child teardown, cached Canceled status) happens when
/// `start_delegation` drains the buffered cancel.
fn canceling_report(task_id: &str) -> DelegationTaskReport {
    DelegationTaskReport {
        task_id: Some(task_id.to_string()),
        status: TaskStatus::Canceled,
        child_session_id: None,
        agent_type: None,
        text: None,
        error_code: Some("canceled".to_string()),
        message: Some("canceled while starting up".to_string()),
        duration_ms: None,
    }
}

fn running_meta(child_session_id: &Uuid, agent_type: AgentKind) -> serde_json::Value {
    serde_json::json!({
        "status": "running",
        "child_session_id": child_session_id,
        "agent_type": agent_type,
    })
}

fn terminal_meta(task: &CompletedTask) -> serde_json::Value {
    serde_json::json!({
        "status": match task.status {
            TaskStatus::Completed => "completed",
            TaskStatus::Canceled => "canceled",
            _ => "failed",
        },
        "child_session_id": task.child_session_id,
        "agent_type": task.agent_type,
        "error_code": task.error_code,
        "duration_ms": task.duration_ms,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use uuid::Uuid;

    use super::*;
    use crate::{
        testing::{
            MockDepthLookup, MockSpawner, MockStatusLookup, RecordingEventEmitter,
            RecordingMetaWriter,
        },
        types::{DelegationOutcome, DelegationSuccess},
    };

    fn request(parent_session_id: Uuid) -> DelegationRequest {
        DelegationRequest {
            parent_connection_id: "parent-conn".to_string(),
            parent_session_id,
            parent_tool_use_id: "toolu_1".to_string(),
            agent_type: AgentKind::Codex,
            task: "do the thing".to_string(),
            working_dir: Some("/work".to_string()),
            requested_working_dir: Some("/work".to_string()),
            external_handle: None,
        }
    }

    struct Harness {
        broker: DelegationBroker,
        spawner: Arc<MockSpawner>,
        events: Arc<RecordingEventEmitter>,
        meta: Arc<RecordingMetaWriter>,
    }

    fn harness(depth: MockDepthLookup, config: DelegationConfig) -> Harness {
        let spawner = Arc::new(MockSpawner::new());
        let events = Arc::new(RecordingEventEmitter::default());
        let meta = Arc::new(RecordingMetaWriter::default());
        let broker = DelegationBroker::new(
            spawner.clone(),
            Arc::new(depth),
            Arc::new(MockStatusLookup::default()),
            meta.clone(),
            events.clone(),
            config,
        );
        Harness {
            broker,
            spawner,
            events,
            meta,
        }
    }

    #[tokio::test]
    async fn happy_path_registers_running_then_completes() {
        let h = harness(MockDepthLookup::default(), DelegationConfig::default());
        let report = h.broker.start_delegation(request(Uuid::nil())).await;

        assert_eq!(report.status, TaskStatus::Running);
        let call_id = report.task_id.clone().expect("task id");
        assert_eq!(h.broker.running_count(), 1);
        assert_eq!(h.events.started.lock().unwrap().len(), 1);
        assert_eq!(h.spawner.calls.lock().unwrap().prompts.len(), 1);

        let outcome = DelegationOutcome::Ok(DelegationSuccess {
            text: "all done".to_string(),
            child_session_id: h.spawner.child_session_id,
            child_agent_type: AgentKind::Codex,
            turn_count: 1,
            duration_ms: 0,
            token_usage: None,
        });
        h.broker.complete_call(&call_id, outcome).await;

        assert_eq!(h.broker.running_count(), 0);
        let completed = h.broker.completed_report(&call_id).expect("completed");
        assert_eq!(completed.status, TaskStatus::Completed);
        assert_eq!(completed.text.as_deref(), Some("all done"));
        assert_eq!(h.events.completed.lock().unwrap().len(), 1);
        // Child is torn down (one-shot v1).
        assert_eq!(h.spawner.calls.lock().unwrap().disconnected.len(), 1);
        // Two meta writes: running, then terminal.
        assert_eq!(h.meta.writes.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn depth_limit_rejects_before_spawning() {
        // Parent at depth 1 (root -> parent); with default limit 1 the child
        // would be depth 2 and must be rejected.
        let root = Uuid::from_u128(1);
        let parent = Uuid::from_u128(2);
        let h = harness(
            MockDepthLookup::chain(&[root, parent]),
            DelegationConfig::default(),
        );

        let report = h.broker.start_delegation(request(parent)).await;
        assert_eq!(report.status, TaskStatus::Failed);
        assert_eq!(report.error_code.as_deref(), Some("depth_limit"));
        assert!(report.task_id.is_none());
        // Never spawned.
        assert!(h.spawner.calls.lock().unwrap().spawned.is_empty());
        assert_eq!(h.broker.running_count(), 0);
    }

    #[tokio::test]
    async fn spawn_failure_returns_failed_report() {
        let mut spawner = MockSpawner::new();
        spawner.spawn_error = Some("no binary".to_string());
        let spawner = Arc::new(spawner);
        let broker = DelegationBroker::new(
            spawner.clone(),
            Arc::new(MockDepthLookup::default()),
            Arc::new(MockStatusLookup::default()),
            Arc::new(RecordingMetaWriter::default()),
            Arc::new(RecordingEventEmitter::default()),
            DelegationConfig::default(),
        );

        let report = broker.start_delegation(request(Uuid::nil())).await;
        assert_eq!(report.status, TaskStatus::Failed);
        assert_eq!(report.error_code.as_deref(), Some("spawn_failed"));
        assert_eq!(broker.running_count(), 0);
    }

    #[tokio::test]
    async fn disabled_config_returns_canceled() {
        let config = DelegationConfig {
            enabled: false,
            ..DelegationConfig::default()
        };
        let h = harness(MockDepthLookup::default(), config);
        let report = h.broker.start_delegation(request(Uuid::nil())).await;
        assert_eq!(report.status, TaskStatus::Canceled);
        assert!(h.spawner.calls.lock().unwrap().spawned.is_empty());
    }

    #[tokio::test]
    async fn complete_call_with_error_marks_failed() {
        let h = harness(MockDepthLookup::default(), DelegationConfig::default());
        let report = h.broker.start_delegation(request(Uuid::nil())).await;
        let call_id = report.task_id.unwrap();

        h.broker
            .complete_call(
                &call_id,
                DelegationOutcome::from_err(DelegationError::ChildRefusal, None),
            )
            .await;

        let completed = h.broker.completed_report(&call_id).unwrap();
        assert_eq!(completed.status, TaskStatus::Failed);
        assert_eq!(completed.error_code.as_deref(), Some("child_refusal"));
    }

    fn ok_outcome(child: Uuid) -> DelegationOutcome {
        ok_text_outcome(child, "all done".to_string())
    }

    fn ok_text_outcome(child: Uuid, text: String) -> DelegationOutcome {
        DelegationOutcome::Ok(DelegationSuccess {
            text,
            child_session_id: child,
            child_agent_type: AgentKind::Codex,
            turn_count: 1,
            duration_ms: 0,
            token_usage: None,
        })
    }

    #[tokio::test]
    async fn status_immediate_reflects_running_then_completed() {
        let h = harness(MockDepthLookup::default(), DelegationConfig::default());
        let call_id = h
            .broker
            .start_delegation(request(Uuid::nil()))
            .await
            .task_id
            .unwrap();

        let running = h
            .broker
            .get_tasks_status(std::slice::from_ref(&call_id), StatusWait::Immediate)
            .await;
        assert_eq!(running.len(), 1);
        assert_eq!(running[0].status, TaskStatus::Running);

        h.broker
            .complete_call(&call_id, ok_outcome(h.spawner.child_session_id))
            .await;

        let done = h
            .broker
            .get_tasks_status(&[call_id], StatusWait::Immediate)
            .await;
        assert_eq!(done[0].status, TaskStatus::Completed);
    }

    #[tokio::test]
    async fn status_wait_blocks_until_completion() {
        let h = harness(MockDepthLookup::default(), DelegationConfig::default());
        let call_id = h
            .broker
            .start_delegation(request(Uuid::nil()))
            .await
            .task_id
            .unwrap();

        let broker = h.broker.clone();
        let child = h.spawner.child_session_id;
        let id = call_id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            broker.complete_call(&id, ok_outcome(child)).await;
        });

        let reports = h
            .broker
            .get_tasks_status(&[call_id], StatusWait::Bounded(5_000))
            .await;
        assert_eq!(reports[0].status, TaskStatus::Completed);
    }

    #[tokio::test]
    async fn status_unknown_for_unrecognized_id() {
        let h = harness(MockDepthLookup::default(), DelegationConfig::default());
        let reports = h
            .broker
            .get_tasks_status(&["nope".to_string()], StatusWait::Immediate)
            .await;
        assert_eq!(reports[0].status, TaskStatus::Unknown);
    }

    #[tokio::test]
    async fn status_falls_back_to_db_for_evicted_task() {
        let status = Arc::new(MockStatusLookup {
            record: Some(ChildStatusRecord {
                child_session_id: Uuid::from_u128(7),
                status: TaskStatus::Completed,
                agent_type: Some(AgentKind::Gemini),
            }),
        });
        let broker = DelegationBroker::new(
            Arc::new(MockSpawner::new()),
            Arc::new(MockDepthLookup::default()),
            status,
            Arc::new(RecordingMetaWriter::default()),
            Arc::new(RecordingEventEmitter::default()),
            DelegationConfig::default(),
        );
        let reports = broker
            .get_tasks_status(&["evicted".to_string()], StatusWait::Immediate)
            .await;
        assert_eq!(reports[0].status, TaskStatus::Completed);
        assert_eq!(reports[0].child_session_id, Some(Uuid::from_u128(7)));
    }

    #[tokio::test]
    async fn cancel_running_task_marks_canceled_and_tears_down() {
        let h = harness(MockDepthLookup::default(), DelegationConfig::default());
        let call_id = h
            .broker
            .start_delegation(request(Uuid::nil()))
            .await
            .task_id
            .unwrap();

        let report = h.broker.cancel_delegation(&call_id).await;
        assert_eq!(report.status, TaskStatus::Canceled);
        assert_eq!(h.broker.running_count(), 0);
        let calls = h.spawner.calls.lock().unwrap();
        assert_eq!(calls.canceled.len(), 1);
        assert_eq!(calls.disconnected.len(), 1);
    }

    #[tokio::test]
    async fn cancel_already_completed_returns_completed() {
        let h = harness(MockDepthLookup::default(), DelegationConfig::default());
        let call_id = h
            .broker
            .start_delegation(request(Uuid::nil()))
            .await
            .task_id
            .unwrap();
        h.broker
            .complete_call(&call_id, ok_outcome(h.spawner.child_session_id))
            .await;

        let report = h.broker.cancel_delegation(&call_id).await;
        assert_eq!(report.status, TaskStatus::Completed);
        assert!(h.spawner.calls.lock().unwrap().canceled.is_empty());
    }

    #[tokio::test]
    async fn cache_evicts_oldest_over_byte_cap() {
        // Cap of 10 bytes with 20-byte results: only the newest survives.
        let config = DelegationConfig {
            completed_cache_cap_bytes: 10,
            ..DelegationConfig::default()
        };
        let h = harness(MockDepthLookup::default(), config);

        let mut ids = Vec::new();
        for _ in 0..3 {
            let id = h
                .broker
                .start_delegation(request(Uuid::nil()))
                .await
                .task_id
                .unwrap();
            h.broker
                .complete_call(
                    &id,
                    ok_text_outcome(h.spawner.child_session_id, "x".repeat(20)),
                )
                .await;
            ids.push(id);
        }

        assert!(
            h.broker.completed_report(&ids[0]).is_none(),
            "oldest evicted"
        );
        assert!(h.broker.completed_report(&ids[2]).is_some(), "newest kept");
    }

    #[tokio::test]
    async fn early_completion_during_setup_is_not_dropped() {
        // A child that finishes while start_delegation is still parked in
        // send_prompt_linked must have its terminal applied at registration,
        // not dropped.
        let mut spawner = MockSpawner::new();
        let release = Arc::new(tokio::sync::Notify::new());
        spawner.release_gate = Some(release.clone());
        let reached = spawner.send_reached_gate.clone();
        let captured = spawner.captured_call_id.clone();
        let child = spawner.child_session_id;
        let spawner = Arc::new(spawner);

        let broker = DelegationBroker::new(
            spawner,
            Arc::new(MockDepthLookup::default()),
            Arc::new(MockStatusLookup::default()),
            Arc::new(RecordingMetaWriter::default()),
            Arc::new(RecordingEventEmitter::default()),
            DelegationConfig::default(),
        );

        let start_broker = broker.clone();
        let start =
            tokio::spawn(async move { start_broker.start_delegation(request(Uuid::nil())).await });

        // Wait until start_delegation is parked inside send_prompt_linked, then
        // complete the call before it registers as running.
        reached.notified().await;
        let call_id = captured.lock().unwrap().clone().expect("captured call id");
        broker.complete_call(&call_id, ok_outcome(child)).await;
        release.notify_one();

        let report = start.await.unwrap();
        assert_eq!(
            report.status,
            TaskStatus::Completed,
            "early terminal applied"
        );
        assert_eq!(broker.running_count(), 0);
        let done = broker
            .get_tasks_status(&[call_id], StatusWait::Immediate)
            .await;
        assert_eq!(done[0].status, TaskStatus::Completed);
    }

    #[tokio::test]
    async fn empty_tool_use_id_gets_synthetic_id_and_skips_meta() {
        let h = harness(MockDepthLookup::default(), DelegationConfig::default());
        let mut req = request(Uuid::nil());
        req.parent_tool_use_id = String::new();

        let report = h.broker.start_delegation(req).await;
        assert_eq!(report.status, TaskStatus::Running);
        // Synthetic ids have no real tool call, so no meta is written.
        assert!(h.meta.writes.lock().unwrap().is_empty());
        // The start event still fires (UI can show the card by connection).
        assert_eq!(h.events.started.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn status_wait_does_not_hang_on_db_recovered_running() {
        // A task resolvable only from the DB (as Running) has no in-memory entry,
        // so no notify will ever fire for it. An Infinite wait must still return.
        let status = Arc::new(MockStatusLookup {
            record: Some(ChildStatusRecord {
                child_session_id: Uuid::nil(),
                status: TaskStatus::Running,
                agent_type: None,
            }),
        });
        let broker = DelegationBroker::new(
            Arc::new(MockSpawner::new()),
            Arc::new(MockDepthLookup::default()),
            status,
            Arc::new(RecordingMetaWriter::default()),
            Arc::new(RecordingEventEmitter::default()),
            DelegationConfig::default(),
        );

        let reports = tokio::time::timeout(
            Duration::from_secs(1),
            broker.get_tasks_status(&["db-only".to_string()], StatusWait::Infinite),
        )
        .await
        .expect("must not block on a DB-only running task");
        assert_eq!(reports[0].status, TaskStatus::Running);
    }

    #[tokio::test]
    async fn cancel_during_setup_window_is_honored() {
        let mut spawner = MockSpawner::new();
        let release = Arc::new(tokio::sync::Notify::new());
        spawner.release_gate = Some(release.clone());
        let reached = spawner.send_reached_gate.clone();
        let captured = spawner.captured_call_id.clone();
        let spawner = Arc::new(spawner);

        let broker = DelegationBroker::new(
            spawner.clone(),
            Arc::new(MockDepthLookup::default()),
            Arc::new(MockStatusLookup::default()),
            Arc::new(RecordingMetaWriter::default()),
            Arc::new(RecordingEventEmitter::default()),
            DelegationConfig::default(),
        );

        let start_broker = broker.clone();
        let start =
            tokio::spawn(async move { start_broker.start_delegation(request(Uuid::nil())).await });

        // Cancel while start_delegation is parked in send (task is in `setups`).
        reached.notified().await;
        let call_id = captured.lock().unwrap().clone().expect("captured call id");
        let cancel_report = broker.cancel_delegation(&call_id).await;
        assert_eq!(cancel_report.status, TaskStatus::Canceled);
        release.notify_one();

        let start_report = start.await.unwrap();
        // start_delegation drained the buffered cancel → resolved as Canceled,
        // never left running, and tore the child down.
        assert_eq!(start_report.status, TaskStatus::Canceled);
        assert_eq!(broker.running_count(), 0);
        assert_eq!(spawner.calls.lock().unwrap().disconnected.len(), 1);
    }
}
