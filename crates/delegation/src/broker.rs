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
    collections::{HashMap, HashSet, VecDeque},
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use agents::AgentId;
use tokio::sync::{Mutex as AsyncMutex, Notify, OwnedMutexGuard};
use uuid::Uuid;

use crate::{
    depth::compute_depth,
    event_emitter::{DelegationCompletedEvent, DelegationEventEmitter, DelegationStartedEvent},
    lookups::{ChildStatusLookup, ChildStatusRecord, DepthLookup},
    meta_writer::DelegationMetaWriter,
    spawner::ConnectionSpawner,
    types::{
        DelegationConfig, DelegationError, DelegationLink, DelegationOutcome, DelegationRequest,
        DelegationScope, DelegationSuccess, DelegationTaskReport, DelegationWorkspaceAccess,
        TaskStatus,
    },
};

const COMPLETED_METADATA_CAP: usize = 4_096;
const PARENT_TOOL_CALL_CLAIM_WAIT: Duration = Duration::from_millis(80);

/// Hard ceiling on a single bounded status wait. The listener also caps the
/// caller's `wait_ms`; this is a defensive backstop inside the broker.
const STATUS_WAIT_MAX_MS: u64 = 60_000;
const TOMBSTONE_CAP: usize = 4_096;

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
    parent_conversation_id: Uuid,
    parent_tool_use_id: String,
    /// Whether `parent_tool_use_id` is a real ACP tool call (vs a synthetic
    /// `delegation-…` id minted when the MCP client supplied none). Meta writes
    /// are skipped when false — there is no real tool call to attach to.
    has_real_tool_call: bool,
    child_connection_id: String,
    child_session_id: Uuid,
    agent_type: AgentId,
    started_at: Instant,
    external_handle: Option<String>,
    max_result_bytes: usize,
    _workspace_write_guard: Option<OwnedMutexGuard<()>>,
}

/// A delegation that has reached a terminal state, cached for status polls.
#[derive(Clone)]
struct CompletedTask {
    parent_connection_id: String,
    parent_conversation_id: Uuid,
    status: TaskStatus,
    child_session_id: Option<Uuid>,
    agent_type: Option<AgentId>,
    text: Option<String>,
    error_code: Option<String>,
    message: Option<String>,
    duration_ms: Option<u64>,
}

struct SetupReservation {
    parent_connection_id: String,
    parent_conversation_id: Uuid,
    started_at: Instant,
    external_handle: Option<String>,
    child_connection_id: String,
    child_session_id: Option<Uuid>,
    agent_type: AgentId,
    workspace_write_guard: Option<OwnedMutexGuard<()>>,
}

struct ParentSetupLease {
    pending: Arc<Mutex<PendingInner>>,
    parent_connection_id: String,
    revoked: Arc<AtomicBool>,
}

impl Drop for ParentSetupLease {
    fn drop(&mut self) {
        remove_parent_setup_lease(
            &mut self.pending.lock().unwrap(),
            &self.parent_connection_id,
            &self.revoked,
        );
    }
}

#[derive(Default)]
struct PendingInner {
    running: HashMap<String, RunningTask>,
    completed: HashMap<String, CompletedTask>,
    /// FIFO for a bounded cache of terminal metadata. Full output remains only
    /// in the child conversation and the durable completion event.
    completed_order: VecDeque<String>,
    /// Call ids reserved during the spawn→send setup window (value = reserve
    /// instant). Lets a child that finishes mid-setup buffer its terminal
    /// outcome rather than have it dropped.
    setups: HashMap<String, SetupReservation>,
    /// Terminal outcomes that arrived before the task was registered as running;
    /// drained by `start_delegation` at registration.
    early_completes: HashMap<String, DelegationOutcome>,
    /// Scoped MCP handles canceled before the corresponding `Call` arrived.
    pre_canceled_handles: HashSet<(DelegationScope, String)>,
    pre_canceled_order: VecDeque<(DelegationScope, String)>,
    /// Parent connection ids that reached teardown. Connection ids are unique
    /// per launch, so any later setup for one must fail closed.
    closed_parents: HashSet<String>,
    closed_parent_order: VecDeque<String>,
    /// Revocable leases for starts currently suspended before setup
    /// reservation. Parent teardown marks these even if its bounded historical
    /// tombstone is later evicted.
    parent_setup_leases: HashMap<String, Vec<Weak<AtomicBool>>>,
    /// Accepted starts that have not reached the setup map yet. They count
    /// against active-child limits so parallel callers cannot oversubscribe.
    active_reservations: HashMap<String, String>,
    /// Monotonic for one parent connection lifetime. Failed spawn attempts are
    /// still calls and therefore consume the hard budget.
    calls_started: HashMap<String, u32>,
    /// ACP `tool_call_id`s announced on the parent, waiting to be claimed by
    /// an MCP `delegate_to_agent` that did not send `_meta.tool_use_id`.
    pending_tool_calls: HashMap<String, Vec<(crate::DelegationMatchKey, String)>>,
}

/// Everything `finalize` needs to resolve a task to a terminal report,
/// regardless of whether it resolved normally or won the setup-window race.
struct FinalizeCtx {
    call_id: String,
    parent_connection_id: String,
    parent_conversation_id: Uuid,
    parent_tool_use_id: String,
    has_real_tool_call: bool,
    child_connection_id: String,
    child_session_id: Uuid,
    agent_type: AgentId,
    duration_ms: u64,
    max_result_bytes: usize,
    _workspace_write_guard: Option<OwnedMutexGuard<()>>,
}

/// Outcome of the post-send registration step.
enum Resolution {
    /// A terminal outcome beat registration; resolve immediately.
    Early {
        outcome: DelegationOutcome,
        reserved_at: Instant,
        workspace_write_guard: Option<OwnedMutexGuard<()>>,
    },
    /// No early terminal; the task is now tracked as running.
    Registered,
}

/// Keep the newest result for each parent. Older text is dropped first when the
/// parent exceeds `cap_bytes` (0 = no byte budget). Entry count is still bounded.
fn insert_completed(
    inner: &mut PendingInner,
    call_id: String,
    task: CompletedTask,
    cap_bytes: u64,
) {
    if inner.completed.insert(call_id.clone(), task).is_none() {
        inner.completed_order.push_back(call_id);
    }
    evict_completed(inner, cap_bytes);
}

fn evict_completed(inner: &mut PendingInner, cap_bytes: u64) {
    while inner.completed.len() > COMPLETED_METADATA_CAP {
        let Some(oldest) = inner.completed_order.pop_front() else {
            break;
        };
        inner.completed.remove(&oldest);
    }
    if cap_bytes == 0 {
        return;
    }
    let mut parents = std::collections::BTreeSet::new();
    for task in inner.completed.values() {
        parents.insert(task.parent_connection_id.clone());
    }
    for parent in parents {
        loop {
            let parent_ids: Vec<String> = inner
                .completed_order
                .iter()
                .filter(|id| {
                    inner
                        .completed
                        .get(*id)
                        .is_some_and(|task| task.parent_connection_id == parent)
                })
                .cloned()
                .collect();
            if parent_ids.len() <= 1 {
                break;
            }
            let used: u64 = parent_ids
                .iter()
                .filter_map(|id| inner.completed.get(id))
                .map(completed_task_bytes)
                .sum();
            if used <= cap_bytes {
                break;
            }
            let Some(oldest) = parent_ids.first().cloned() else {
                break;
            };
            inner.completed.remove(&oldest);
            inner.completed_order.retain(|id| id != &oldest);
        }
    }
}

fn completed_task_bytes(task: &CompletedTask) -> u64 {
    task.text
        .as_ref()
        .map(|text| text.len() as u64)
        .unwrap_or(0)
}

fn drop_completed_for_parent(inner: &mut PendingInner, parent_connection_id: &str) {
    inner
        .completed
        .retain(|_, task| task.parent_connection_id != parent_connection_id);
    inner
        .completed_order
        .retain(|id| inner.completed.contains_key(id));
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
    /// Unknown writers are serialized per canonical working directory. Weak
    /// values let idle directories disappear without a cleanup task.
    workspace_write_locks: Arc<Mutex<HashMap<String, Weak<AsyncMutex<()>>>>>,
}

/// Everything `start_delegation` hands to the finishing step, which runs
/// inline under test and on a spawned task in production.
struct StartDelegationHandoff {
    req: DelegationRequest,
    call_id: String,
    parent_tool_use_id: String,
    has_real_tool_call: bool,
    child_session_id: Uuid,
    link: DelegationLink,
    scope: DelegationScope,
    parent_setup_lease: ParentSetupLease,
    config: DelegationConfig,
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
            config: Arc::new(Mutex::new(config.normalized())),
            pending: Arc::new(Mutex::new(PendingInner::default())),
            result_notify: Arc::new(Notify::new()),
            workspace_write_locks: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    async fn acquire_workspace_write(
        &self,
        working_dir: Option<&str>,
    ) -> Option<OwnedMutexGuard<()>> {
        let key = working_dir?.to_string();
        let lock = {
            let mut locks = self.workspace_write_locks.lock().unwrap();
            locks.retain(|_, lock| lock.strong_count() > 0);
            match locks.get(&key).and_then(Weak::upgrade) {
                Some(lock) => lock,
                None => {
                    let lock = Arc::new(AsyncMutex::new(()));
                    locks.insert(key, Arc::downgrade(&lock));
                    lock
                }
            }
        };
        Some(lock.lock_owned().await)
    }

    pub fn config_snapshot(&self) -> DelegationConfig {
        self.config.lock().unwrap().clone()
    }

    pub fn set_config(&self, config: DelegationConfig) {
        *self.config.lock().unwrap() = config.normalized();
    }

    /// Remember an ACP parent tool call so a later MCP round-trip without
    /// `_meta.tool_use_id` can still bind the child session to that card.
    pub fn note_parent_tool_call(
        &self,
        parent_connection_id: &str,
        tool_call_id: &str,
        key: crate::DelegationMatchKey,
    ) {
        if parent_connection_id.is_empty() || tool_call_id.is_empty() {
            return;
        }
        self.pending
            .lock()
            .unwrap()
            .pending_tool_calls
            .entry(parent_connection_id.to_string())
            .or_default()
            .push((key, tool_call_id.to_string()));
    }

    fn take_matching_tool_call(
        &self,
        parent_connection_id: &str,
        key: &crate::DelegationMatchKey,
    ) -> Option<String> {
        let mut pending = self.pending.lock().unwrap();
        let list = pending.pending_tool_calls.get_mut(parent_connection_id)?;
        let index = list.iter().position(|(candidate, _)| candidate == key)?;
        Some(list.remove(index).1)
    }

    /// Validate, spawn, and register a delegation. Returns a `Running` ack on
    /// success, or a terminal report when setup fails (disabled / depth / spawn
    /// / send). The child runs in the background; [`Self::complete_call`]
    /// resolves it later.
    pub async fn start_delegation(&self, mut req: DelegationRequest) -> DelegationTaskReport {
        let config = self.config_snapshot();
        if !config.enabled {
            return failed_setup_report("canceled", "delegation is disabled");
        }

        // Acquire parent authority before the first await. Teardown can revoke
        // this lease even if its bounded historical tombstone is evicted while
        // depth lookup or child spawn is suspended.
        let scope = DelegationScope {
            parent_connection_id: req.parent_connection_id.clone(),
            parent_conversation_id: req.parent_session_id,
        };
        let parent_setup_lease = {
            let mut pending = self.pending.lock().unwrap();
            if pending.closed_parents.contains(&req.parent_connection_id) {
                return failed_setup_report("canceled", "parent connection is closed");
            }
            let lease = Arc::new(AtomicBool::new(false));
            let leases = pending
                .parent_setup_leases
                .entry(req.parent_connection_id.clone())
                .or_default();
            leases.retain(|lease| lease.strong_count() > 0);
            leases.push(Arc::downgrade(&lease));
            ParentSetupLease {
                pending: self.pending.clone(),
                parent_connection_id: req.parent_connection_id.clone(),
                revoked: lease,
            }
        };
        if self.take_pre_canceled_handle(&scope, req.external_handle.as_deref()) {
            return failed_setup_report("canceled", "canceled by MCP client");
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
        if parent_setup_lease.revoked.load(Ordering::Acquire) {
            return failed_setup_report("canceled", "parent connection is closed");
        }

        let call_id = Uuid::new_v4().to_string();
        {
            let mut pending = self.pending.lock().unwrap();
            let started = pending
                .calls_started
                .get(&req.parent_connection_id)
                .copied()
                .unwrap_or(0);
            if started >= config.max_calls_per_parent {
                let error = DelegationError::CallLimitExceeded {
                    started,
                    limit: config.max_calls_per_parent,
                };
                return failed_setup_report("call_limit", &error.to_string());
            }
            let active = pending
                .active_reservations
                .values()
                .filter(|parent| *parent == &req.parent_connection_id)
                .count()
                + pending
                    .setups
                    .values()
                    .filter(|setup| setup.parent_connection_id == req.parent_connection_id)
                    .count()
                + pending
                    .running
                    .values()
                    .filter(|task| task.parent_connection_id == req.parent_connection_id)
                    .count();
            if active >= config.max_active_children as usize {
                let error = DelegationError::ActiveChildLimitExceeded {
                    active: active as u32,
                    limit: config.max_active_children,
                };
                return failed_setup_report("active_child_limit", &error.to_string());
            }
            pending
                .calls_started
                .insert(req.parent_connection_id.clone(), started + 1);
            pending
                .active_reservations
                .insert(call_id.clone(), req.parent_connection_id.clone());
        }
        // Fall back to a synthetic tool-use id when the MCP client didn't supply
        // one. Prefer an ACP tool_call announced on this parent with the same
        // (agent_type, task, working_dir). Do not wait here — Grok is blocked on
        // this MCP round-trip until we return a task_id.
        if req.parent_tool_use_id.trim().is_empty() {
            let key = crate::DelegationMatchKey {
                agent_type: req.agent_type.clone(),
                task: req.task.clone(),
                working_dir: req.requested_working_dir.clone(),
            };
            if let Some(id) = self.take_matching_tool_call(&req.parent_connection_id, &key) {
                req.parent_tool_use_id = id;
            }
        }
        let has_real_tool_call = !req.parent_tool_use_id.trim().is_empty();
        let parent_tool_use_id = if has_real_tool_call {
            req.parent_tool_use_id.clone()
        } else {
            format!("delegation-{call_id}")
        };

        if parent_setup_lease.revoked.load(Ordering::Acquire) {
            self.pending
                .lock()
                .unwrap()
                .active_reservations
                .remove(&call_id);
            return failed_setup_report("canceled", "parent connection is closed");
        }

        let child_session_id = Uuid::new_v4();
        {
            let mut pending = self.pending.lock().unwrap();
            pending.active_reservations.remove(&call_id);
            pending.setups.insert(
                call_id.clone(),
                SetupReservation {
                    parent_connection_id: req.parent_connection_id.clone(),
                    parent_conversation_id: req.parent_session_id,
                    started_at: Instant::now(),
                    external_handle: req.external_handle.clone(),
                    child_connection_id: String::new(),
                    child_session_id: Some(child_session_id),
                    agent_type: req.agent_type.clone(),
                    workspace_write_guard: None,
                },
            );
        }

        let defaults = config
            .agent_defaults
            .get(req.agent_type.as_str())
            .cloned()
            .unwrap_or_default();
        let link = DelegationLink {
            parent_session_id: req.parent_session_id,
            parent_tool_use_id: parent_tool_use_id.clone(),
            delegation_call_id: call_id.clone(),
            agent_type: req.agent_type.clone(),
            policy: config.policy_snapshot(req.workspace_access),
            preferred_mode_id: defaults.mode_id,
            preferred_config_values: defaults.config_values,
        };

        let ack_agent = req.agent_type.clone();
        let ack_call_id = call_id.clone();
        // Tests drive spawn inline so failure/cancel during setup still comes
        // back on this call. Production returns the running ack immediately so
        // the parent can poll instead of hanging on child process start.
        #[cfg(test)]
        {
            self.finish_start_delegation(StartDelegationHandoff {
                req,
                call_id,
                parent_tool_use_id,
                has_real_tool_call,
                child_session_id,
                link,
                scope,
                parent_setup_lease,
                config,
            })
            .await;
            if let Some(done) = self.completed_report(&ack_call_id) {
                return done;
            }
            running_report(&ack_call_id, Some(child_session_id), ack_agent)
        }
        #[cfg(not(test))]
        {
            let broker = self.clone();
            tokio::spawn(async move {
                broker
                    .finish_start_delegation(StartDelegationHandoff {
                        req,
                        call_id,
                        parent_tool_use_id,
                        has_real_tool_call,
                        child_session_id,
                        link,
                        scope,
                        parent_setup_lease,
                        config,
                    })
                    .await;
            });
            running_report(&ack_call_id, Some(child_session_id), ack_agent)
        }
    }

    async fn finish_start_delegation(&self, handoff: StartDelegationHandoff) {
        let StartDelegationHandoff {
            req,
            call_id,
            mut parent_tool_use_id,
            mut has_real_tool_call,
            child_session_id,
            mut link,
            scope,
            parent_setup_lease,
            config,
        } = handoff;
        if parent_tool_use_id.starts_with("delegation-") {
            tokio::time::sleep(PARENT_TOOL_CALL_CLAIM_WAIT).await;
            let key = crate::DelegationMatchKey {
                agent_type: req.agent_type.clone(),
                task: req.task.clone(),
                working_dir: req.requested_working_dir.clone(),
            };
            if let Some(id) = self.take_matching_tool_call(&req.parent_connection_id, &key) {
                parent_tool_use_id = id.clone();
                has_real_tool_call = true;
                link.parent_tool_use_id = id;
            }
        }

        match self
            .spawner
            .create_child_conversation(child_session_id, &req.task, &link)
            .await
        {
            Ok(_) => {}
            Err(err) => {
                self.fail_started(
                    &call_id,
                    &req,
                    parent_tool_use_id,
                    has_real_tool_call,
                    child_session_id,
                    "spawn_failed",
                    &err.to_string(),
                    &parent_setup_lease,
                    config.max_result_bytes,
                )
                .await;
                return;
            }
        }
        self.event_emitter
            .emit_started(DelegationStartedEvent {
                delegation_id: call_id.clone(),
                parent_connection_id: req.parent_connection_id.clone(),
                parent_conversation_id: req.parent_session_id,
                parent_tool_use_id: parent_tool_use_id.clone(),
                child_session_id,
                agent_type: req.agent_type.clone(),
                task_preview: req.task.clone(),
            })
            .await;

        let workspace_write_guard =
            if req.workspace_access == DelegationWorkspaceAccess::WriteSerialized {
                self.acquire_workspace_write(req.working_dir.as_deref())
                    .await
            } else {
                None
            };
        {
            let mut pending = self.pending.lock().unwrap();
            if let Some(setup) = pending.setups.get_mut(&call_id) {
                setup.workspace_write_guard = workspace_write_guard;
            }
        }

        // Spawn the child connection.
        let child_connection_id = match self
            .spawner
            .spawn(
                &req.parent_connection_id,
                req.agent_type.clone(),
                req.working_dir.clone(),
            )
            .await
        {
            Ok(id) => id,
            Err(err) => {
                self.fail_started(
                    &call_id,
                    &req,
                    parent_tool_use_id,
                    has_real_tool_call,
                    child_session_id,
                    "spawn_failed",
                    &err.to_string(),
                    &parent_setup_lease,
                    config.max_result_bytes,
                )
                .await;
                return;
            }
        };
        // Reserve the call id BEFORE sending so a child that finishes during the
        // send window buffers its terminal outcome instead of having it dropped.
        let canceled_before_reservation = {
            let mut pending = self.pending.lock().unwrap();
            let canceled = parent_setup_lease.revoked.load(Ordering::Acquire)
                || pending.closed_parents.contains(&req.parent_connection_id)
                || req.external_handle.as_ref().is_some_and(|handle| {
                    remove_pre_canceled(&mut pending, &(scope.clone(), handle.clone()))
                });
            remove_parent_setup_lease(
                &mut pending,
                &req.parent_connection_id,
                &parent_setup_lease.revoked,
            );
            pending.active_reservations.remove(&call_id);
            if let Some(setup) = pending.setups.get_mut(&call_id) {
                setup.child_connection_id = child_connection_id.clone();
            }
            canceled
        };
        if canceled_before_reservation {
            self.fail_started(
                &call_id,
                &req,
                parent_tool_use_id,
                has_real_tool_call,
                child_session_id,
                "canceled",
                "canceled by MCP client",
                &parent_setup_lease,
                config.max_result_bytes,
            )
            .await;
            return;
        }

        if let Err(err) = self
            .spawner
            .send_prompt_linked(
                &child_connection_id,
                child_session_id,
                req.task.clone(),
                link,
            )
            .await
        {
            // Preserve whichever terminal arrived first. A cancellation
            // buffered during setup must not be overwritten by a later send
            // error.
            let (early_outcome, reserved_at, workspace_write_guard) = {
                let mut pending = self.pending.lock().unwrap();
                let reservation = pending.setups.remove(&call_id);
                let reserved_at = reservation
                    .as_ref()
                    .map(|reservation| reservation.started_at)
                    .unwrap_or_else(Instant::now);
                let workspace_write_guard =
                    reservation.and_then(|reservation| reservation.workspace_write_guard);
                (
                    pending.early_completes.remove(&call_id),
                    reserved_at,
                    workspace_write_guard,
                )
            };
            let outcome = early_outcome.unwrap_or_else(|| DelegationOutcome::Err {
                code: "spawn_failed".to_string(),
                message: err.to_string(),
                child_session_id: Some(child_session_id),
            });
            self.finalize(
                FinalizeCtx {
                    call_id,
                    parent_connection_id: req.parent_connection_id,
                    parent_conversation_id: req.parent_session_id,
                    parent_tool_use_id,
                    has_real_tool_call,
                    child_connection_id,
                    child_session_id,
                    agent_type: req.agent_type,
                    duration_ms: reserved_at.elapsed().as_millis() as u64,
                    max_result_bytes: config.max_result_bytes,
                    _workspace_write_guard: workspace_write_guard,
                },
                outcome,
            )
            .await;
            return;
        }

        // Drain any terminal that beat registration; otherwise register running.
        let resolution = {
            let mut pending = self.pending.lock().unwrap();
            let reservation = pending.setups.remove(&call_id);
            let reserved_at = reservation
                .as_ref()
                .map(|reservation| reservation.started_at)
                .unwrap_or_else(Instant::now);
            let workspace_write_guard =
                reservation.and_then(|reservation| reservation.workspace_write_guard);
            if let Some(outcome) = pending.early_completes.remove(&call_id) {
                Resolution::Early {
                    outcome,
                    reserved_at,
                    workspace_write_guard,
                }
            } else {
                pending.running.insert(
                    call_id.clone(),
                    RunningTask {
                        parent_connection_id: req.parent_connection_id.clone(),
                        parent_conversation_id: req.parent_session_id,
                        parent_tool_use_id: parent_tool_use_id.clone(),
                        has_real_tool_call,
                        child_connection_id: child_connection_id.clone(),
                        child_session_id,
                        agent_type: req.agent_type.clone(),
                        started_at: reserved_at,
                        external_handle: req.external_handle.clone(),
                        max_result_bytes: config.max_result_bytes,
                        _workspace_write_guard: workspace_write_guard,
                    },
                );
                Resolution::Registered
            }
        };

        match resolution {
            Resolution::Early {
                outcome,
                reserved_at,
                workspace_write_guard,
            } => {
                let ctx = FinalizeCtx {
                    call_id,
                    parent_connection_id: req.parent_connection_id,
                    parent_conversation_id: req.parent_session_id,
                    parent_tool_use_id,
                    has_real_tool_call,
                    child_connection_id,
                    child_session_id,
                    agent_type: req.agent_type.clone(),
                    duration_ms: reserved_at.elapsed().as_millis() as u64,
                    max_result_bytes: config.max_result_bytes,
                    _workspace_write_guard: workspace_write_guard,
                };
                self.finalize(ctx, outcome).await;
            }
            Resolution::Registered => {
                if has_real_tool_call {
                    self.meta_writer
                        .write_meta(
                            &req.parent_connection_id,
                            &parent_tool_use_id,
                            running_meta(&child_session_id, &req.agent_type),
                        )
                        .await;
                }
                let broker = self.clone();
                let deadline_call_id = call_id.clone();
                let deadline_ms = config.child_deadline_ms;
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(deadline_ms)).await;
                    broker
                        .complete_call(
                            &deadline_call_id,
                            DelegationOutcome::from_err(
                                DelegationError::DeadlineExceeded {
                                    limit_ms: deadline_ms,
                                },
                                Some(child_session_id),
                            ),
                        )
                        .await;
                });
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn fail_started(
        &self,
        call_id: &str,
        req: &DelegationRequest,
        parent_tool_use_id: String,
        has_real_tool_call: bool,
        child_session_id: Uuid,
        code: &str,
        message: &str,
        parent_setup_lease: &ParentSetupLease,
        max_result_bytes: usize,
    ) {
        let (reserved_at, workspace_write_guard, child_connection_id, early) = {
            let mut pending = self.pending.lock().unwrap();
            let reservation = pending.setups.remove(call_id);
            pending.active_reservations.remove(call_id);
            remove_parent_setup_lease(
                &mut pending,
                &req.parent_connection_id,
                &parent_setup_lease.revoked,
            );
            let reserved_at = reservation
                .as_ref()
                .map(|reservation| reservation.started_at)
                .unwrap_or_else(Instant::now);
            let child_connection_id = reservation
                .as_ref()
                .map(|reservation| reservation.child_connection_id.clone())
                .unwrap_or_default();
            let workspace_write_guard =
                reservation.and_then(|reservation| reservation.workspace_write_guard);
            let early = pending.early_completes.remove(call_id);
            (
                reserved_at,
                workspace_write_guard,
                child_connection_id,
                early,
            )
        };
        let outcome = early.unwrap_or_else(|| DelegationOutcome::Err {
            code: code.to_string(),
            message: message.to_string(),
            child_session_id: Some(child_session_id),
        });
        self.finalize(
            FinalizeCtx {
                call_id: call_id.to_string(),
                parent_connection_id: req.parent_connection_id.clone(),
                parent_conversation_id: req.parent_session_id,
                parent_tool_use_id,
                has_real_tool_call,
                child_connection_id,
                child_session_id,
                agent_type: req.agent_type.clone(),
                duration_ms: reserved_at.elapsed().as_millis() as u64,
                max_result_bytes,
                _workspace_write_guard: workspace_write_guard,
            },
            outcome,
        )
        .await;
    }

    fn take_pre_canceled_handle(
        &self,
        scope: &DelegationScope,
        external_handle: Option<&str>,
    ) -> bool {
        let Some(external_handle) = external_handle else {
            return false;
        };
        remove_pre_canceled(
            &mut self.pending.lock().unwrap(),
            &(scope.clone(), external_handle.to_string()),
        )
    }

    /// Cancel by the companion's request handle. Cancellation may arrive on a
    /// separate socket before the matching call; in that case the scoped handle
    /// is retained and the later call is rejected before it can remain running.
    pub async fn cancel_external(
        &self,
        scope: &DelegationScope,
        external_handle: &str,
    ) -> Option<DelegationTaskReport> {
        let task_id = {
            let mut pending = self.pending.lock().unwrap();
            let task_id = pending
                .running
                .iter()
                .find(|(_, task)| {
                    running_matches(scope, task)
                        && task.external_handle.as_deref() == Some(external_handle)
                })
                .map(|(task_id, _)| task_id.clone())
                .or_else(|| {
                    pending
                        .setups
                        .iter()
                        .find(|(_, setup)| {
                            setup_matches(scope, setup)
                                && setup.external_handle.as_deref() == Some(external_handle)
                        })
                        .map(|(task_id, _)| task_id.clone())
                });
            if task_id.is_none() {
                let tombstone = (scope.clone(), external_handle.to_string());
                if pending.pre_canceled_handles.insert(tombstone.clone()) {
                    pending.pre_canceled_order.push_back(tombstone);
                }
                while pending.pre_canceled_handles.len() > TOMBSTONE_CAP {
                    let Some(oldest) = pending.pre_canceled_order.pop_front() else {
                        break;
                    };
                    pending.pre_canceled_handles.remove(&oldest);
                }
            }
            task_id
        };
        match task_id {
            Some(task_id) => Some(self.cancel_delegation(scope, &task_id).await),
            None => None,
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
                        pending
                            .early_completes
                            .entry(call_id.to_string())
                            .or_insert(outcome);
                    }
                    return;
                }
            }
        };
        let ctx = FinalizeCtx {
            call_id: call_id.to_string(),
            parent_connection_id: task.parent_connection_id,
            parent_conversation_id: task.parent_conversation_id,
            parent_tool_use_id: task.parent_tool_use_id,
            has_real_tool_call: task.has_real_tool_call,
            child_connection_id: task.child_connection_id,
            child_session_id: task.child_session_id,
            agent_type: task.agent_type,
            duration_ms: task.started_at.elapsed().as_millis() as u64,
            max_result_bytes: task.max_result_bytes,
            _workspace_write_guard: task._workspace_write_guard,
        };
        self.finalize(ctx, outcome).await;
    }

    /// Move a task to `completed` (with eviction), tear down the child, persist
    /// terminal meta, emit the completed event, and wake status waiters. Shared
    /// by normal completion and the setup-window early-resolution path.
    async fn finalize(&self, ctx: FinalizeCtx, outcome: DelegationOutcome) -> DelegationTaskReport {
        let outcome = with_elapsed(outcome, ctx.duration_ms);
        let (status, text, error_code, message) = terminal_fields(&outcome, ctx.max_result_bytes);
        let completed = CompletedTask {
            parent_connection_id: ctx.parent_connection_id.clone(),
            parent_conversation_id: ctx.parent_conversation_id,
            status,
            child_session_id: Some(ctx.child_session_id),
            agent_type: Some(ctx.agent_type.clone()),
            text,
            error_code,
            message,
            duration_ms: Some(ctx.duration_ms),
        };
        {
            let mut pending = self.pending.lock().unwrap();
            insert_completed(
                &mut pending,
                ctx.call_id.clone(),
                completed.clone(),
                self.config_snapshot().completed_cache_cap_bytes,
            );
        }

        let _ = self.spawner.release_child(ctx.child_session_id).await;
        if !ctx.child_connection_id.is_empty() {
            let _ = self.spawner.disconnect(&ctx.child_connection_id).await;
        }
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
                delegation_id: ctx.call_id.clone(),
                parent_connection_id: ctx.parent_connection_id.clone(),
                parent_conversation_id: ctx.parent_conversation_id,
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
        scope: &DelegationScope,
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

            let (reports, any_settled) = self.assemble_reports(scope, task_ids).await;
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
                            return self.assemble_reports(scope, task_ids).await.0;
                        }
                    }
                }
                None => notified.await,
            }
        }
    }

    /// Cancel a running task by id and tear down its child. If it already
    /// finished, returns its cached (or DB-recovered) report instead.
    pub async fn cancel_delegation(
        &self,
        scope: &DelegationScope,
        task_id: &str,
    ) -> DelegationTaskReport {
        if let Some(report) = {
            let pending = self.pending.lock().unwrap();
            pending
                .completed
                .get(task_id)
                .filter(|task| task_matches(scope, task))
                .map(|task| completed_report(task_id, task))
        } {
            return report;
        }

        let running = {
            let mut pending = self.pending.lock().unwrap();
            if pending
                .running
                .get(task_id)
                .is_some_and(|task| running_matches(scope, task))
            {
                pending.running.remove(task_id)
            } else {
                None
            }
        };
        let Some(task) = running else {
            // Mid-setup (reserved but not yet running)? Mark it canceled so
            // start_delegation resolves it as canceled when it drains. `or_insert`
            // lets a real terminal that already buffered win over the cancel.
            let setup_child = {
                let mut pending = self.pending.lock().unwrap();
                let child_connection_id = pending
                    .setups
                    .get(task_id)
                    .is_some_and(|setup| setup_matches(scope, setup))
                    .then(|| {
                        pending
                            .setups
                            .get(task_id)
                            .expect("matched above")
                            .child_connection_id
                            .clone()
                    });
                if child_connection_id.is_some() {
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
                }
                child_connection_id
            };
            if let Some(child_connection_id) = setup_child {
                if !child_connection_id.is_empty() {
                    let _ = self.spawner.cancel(&child_connection_id).await;
                    let _ = self.spawner.disconnect(&child_connection_id).await;
                }
                return canceling_report(task_id);
            }
            return match self.status_lookup.status_by_call_id(task_id).await {
                Some(record)
                    if record.parent_conversation_id == Some(scope.parent_conversation_id) =>
                {
                    report_from_record(task_id, &record)
                }
                None => unknown_report(task_id),
                Some(_) => unknown_report(task_id),
            };
        };

        let duration_ms = task.started_at.elapsed().as_millis() as u64;
        let completed = CompletedTask {
            parent_connection_id: task.parent_connection_id.clone(),
            parent_conversation_id: task.parent_conversation_id,
            status: TaskStatus::Canceled,
            child_session_id: Some(task.child_session_id),
            agent_type: Some(task.agent_type.clone()),
            text: None,
            error_code: Some("canceled".to_string()),
            message: Some("canceled by request".to_string()),
            duration_ms: Some(duration_ms),
        };
        {
            let mut pending = self.pending.lock().unwrap();
            insert_completed(
                &mut pending,
                task_id.to_string(),
                completed.clone(),
                self.config_snapshot().completed_cache_cap_bytes,
            );
        }

        let _ = self.spawner.cancel(&task.child_connection_id).await;
        let _ = self.spawner.release_child(task.child_session_id).await;
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
                delegation_id: task_id.to_string(),
                parent_connection_id: task.parent_connection_id.clone(),
                parent_conversation_id: task.parent_conversation_id,
                parent_tool_use_id: task.parent_tool_use_id.clone(),
                child_session_id: task.child_session_id,
                agent_type: task.agent_type.clone(),
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

    /// Cascade parent teardown to every child still running for that
    /// connection. A terminal completion that wins after the snapshot remains
    /// authoritative because explicit cancellation is already first-terminal.
    pub async fn parent_closed(&self, parent_connection_id: &str) -> Vec<DelegationTaskReport> {
        let tasks = {
            let mut pending = self.pending.lock().unwrap();
            let parent_connection_id = parent_connection_id.to_string();
            if pending.closed_parents.insert(parent_connection_id.clone()) {
                pending
                    .closed_parent_order
                    .push_back(parent_connection_id.clone());
            }
            while pending.closed_parents.len() > TOMBSTONE_CAP {
                let Some(oldest) = pending.closed_parent_order.pop_front() else {
                    break;
                };
                pending.closed_parents.remove(&oldest);
            }
            if let Some(leases) = pending.parent_setup_leases.remove(&parent_connection_id) {
                for lease in leases.into_iter().filter_map(|lease| lease.upgrade()) {
                    lease.store(true, Ordering::Release);
                }
            }
            drop_completed_for_parent(&mut pending, &parent_connection_id);
            let mut tasks = pending
                .running
                .iter()
                .filter(|(_, task)| task.parent_connection_id == parent_connection_id)
                .map(|(task_id, task)| {
                    (
                        task_id.clone(),
                        DelegationScope {
                            parent_connection_id: task.parent_connection_id.clone(),
                            parent_conversation_id: task.parent_conversation_id,
                        },
                    )
                })
                .collect::<Vec<_>>();
            tasks.extend(
                pending
                    .setups
                    .iter()
                    .filter(|(_, setup)| setup.parent_connection_id == parent_connection_id)
                    .map(|(task_id, setup)| {
                        (
                            task_id.clone(),
                            DelegationScope {
                                parent_connection_id: setup.parent_connection_id.clone(),
                                parent_conversation_id: setup.parent_conversation_id,
                            },
                        )
                    }),
            );
            tasks
        };
        let mut reports = Vec::with_capacity(tasks.len());
        for (task_id, scope) in tasks {
            reports.push(self.cancel_delegation(&scope, &task_id).await);
        }
        reports
    }

    /// Classify each requested id (completed cache → running set → DB fallback →
    /// unknown) and report whether any is settled. A task counts as settled
    /// unless it is an *in-memory* running task — the only state a `result_notify`
    /// wakeup can ever advance. A task resolvable only from the DB (or unknown)
    /// is settled for wait purposes, since the broker has no way to wake on it
    /// (otherwise an in-progress DB row would block the wait forever).
    async fn assemble_reports(
        &self,
        scope: &DelegationScope,
        task_ids: &[String],
    ) -> (Vec<DelegationTaskReport>, bool) {
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
                    if let Some(task) = pending
                        .completed
                        .get(id)
                        .filter(|task| task_matches(scope, task))
                    {
                        Slot::Ready {
                            report: completed_report(id, task),
                            settled: true,
                        }
                    } else if let Some(task) = pending
                        .running
                        .get(id)
                        .filter(|task| running_matches(scope, task))
                    {
                        Slot::Ready {
                            report: running_report(
                                id,
                                Some(task.child_session_id),
                                task.agent_type.clone(),
                            ),
                            settled: false,
                        }
                    } else if let Some(setup) = pending
                        .setups
                        .get(id)
                        .filter(|setup| setup_matches(scope, setup))
                    {
                        Slot::Ready {
                            report: running_report(
                                id,
                                setup.child_session_id,
                                setup.agent_type.clone(),
                            ),
                            settled: false,
                        }
                    } else if pending.completed.contains_key(id)
                        || pending.running.contains_key(id)
                        || pending.setups.contains_key(id)
                    {
                        Slot::Ready {
                            report: unknown_report(id),
                            settled: true,
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
                        Some(record)
                            if record.parent_conversation_id
                                == Some(scope.parent_conversation_id) =>
                        {
                            report_from_record(&id, &record)
                        }
                        None => unknown_report(&id),
                        Some(_) => unknown_report(&id),
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

fn task_matches(scope: &DelegationScope, task: &CompletedTask) -> bool {
    task.parent_connection_id == scope.parent_connection_id
        && task.parent_conversation_id == scope.parent_conversation_id
}

fn running_matches(scope: &DelegationScope, task: &RunningTask) -> bool {
    task.parent_connection_id == scope.parent_connection_id
        && task.parent_conversation_id == scope.parent_conversation_id
}

fn remove_pre_canceled(pending: &mut PendingInner, tombstone: &(DelegationScope, String)) -> bool {
    let removed = pending.pre_canceled_handles.remove(tombstone);
    if removed {
        pending
            .pre_canceled_order
            .retain(|queued| queued != tombstone);
    }
    removed
}

fn remove_parent_setup_lease(
    pending: &mut PendingInner,
    parent_connection_id: &str,
    lease: &Arc<AtomicBool>,
) {
    let remove_entry =
        if let Some(leases) = pending.parent_setup_leases.get_mut(parent_connection_id) {
            leases.retain(|candidate| {
                candidate
                    .upgrade()
                    .is_some_and(|candidate| !Arc::ptr_eq(&candidate, lease))
            });
            leases.is_empty()
        } else {
            false
        };
    if remove_entry {
        pending.parent_setup_leases.remove(parent_connection_id);
    }
}

fn setup_matches(scope: &DelegationScope, setup: &SetupReservation) -> bool {
    setup.parent_connection_id == scope.parent_connection_id
        && setup.parent_conversation_id == scope.parent_conversation_id
}

fn with_elapsed(outcome: DelegationOutcome, duration_ms: u64) -> DelegationOutcome {
    match outcome {
        DelegationOutcome::Ok(success) => DelegationOutcome::Ok(DelegationSuccess {
            duration_ms,
            ..success
        }),
        other => other,
    }
}

fn cap_text(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        text.to_string()
    } else {
        let mut end = max_bytes;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text[..end].to_string()
    }
}

fn terminal_fields(
    outcome: &DelegationOutcome,
    max_result_bytes: usize,
) -> (TaskStatus, Option<String>, Option<String>, Option<String>) {
    match outcome {
        DelegationOutcome::Ok(success) => (
            TaskStatus::Completed,
            Some(cap_text(&success.text, max_result_bytes)),
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

fn running_report(
    call_id: &str,
    child_session_id: Option<Uuid>,
    agent_type: AgentId,
) -> DelegationTaskReport {
    DelegationTaskReport {
        task_id: Some(call_id.to_string()),
        status: TaskStatus::Running,
        child_session_id,
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
        agent_type: task.agent_type.clone(),
        text: task.text.clone(),
        error_code: task.error_code.clone(),
        message: task.message.clone().or_else(|| {
            (task.status == TaskStatus::Completed && task.text.is_none())
                .then(|| "open the child session for full output".to_string())
        }),
        duration_ms: task.duration_ms,
    }
}

fn report_from_record(call_id: &str, record: &ChildStatusRecord) -> DelegationTaskReport {
    DelegationTaskReport {
        task_id: Some(call_id.to_string()),
        status: record.status,
        child_session_id: Some(record.child_session_id),
        agent_type: record.agent_type.clone(),
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

fn running_meta(child_session_id: &Uuid, agent_type: &AgentId) -> serde_json::Value {
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
        types::{DelegationMatchKey, DelegationOutcome, DelegationSuccess},
    };

    async fn wait_until(cond: impl Fn() -> bool) {
        for _ in 0..400 {
            if cond() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("timed out waiting for broker setup");
    }

    fn request(parent_session_id: Uuid) -> DelegationRequest {
        DelegationRequest {
            parent_connection_id: "parent-conn".to_string(),
            parent_session_id,
            parent_tool_use_id: "toolu_1".to_string(),
            agent_type: AgentId::parse("codex").unwrap(),
            task: "do the thing".to_string(),
            working_dir: Some("/work".to_string()),
            requested_working_dir: Some("/work".to_string()),
            external_handle: None,
            workspace_access: DelegationWorkspaceAccess::ReadOnlyShared,
        }
    }

    fn scope(parent_conversation_id: Uuid) -> DelegationScope {
        scope_for("parent-conn", parent_conversation_id)
    }

    fn scope_for(parent_connection_id: &str, parent_conversation_id: Uuid) -> DelegationScope {
        DelegationScope {
            parent_connection_id: parent_connection_id.to_string(),
            parent_conversation_id,
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
        wait_until(|| h.broker.running_count() == 1).await;
        assert_eq!(h.events.started.lock().unwrap().len(), 1);
        assert_eq!(h.spawner.calls.lock().unwrap().prompts.len(), 1);

        let outcome = DelegationOutcome::Ok(DelegationSuccess {
            text: "all done".to_string(),
            child_session_id: h.spawner.child_session_id,
            child_agent_type: AgentId::parse("codex").unwrap(),
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
        match &h.events.completed.lock().unwrap()[0].outcome {
            DelegationOutcome::Ok(success) => {
                assert_eq!(Some(success.duration_ms), completed.duration_ms);
            }
            DelegationOutcome::Err { .. } => panic!("expected ok outcome"),
        }
        // Child is torn down (one-shot v1).
        assert_eq!(h.spawner.calls.lock().unwrap().disconnected.len(), 1);
        // Two meta writes: running, then terminal.
        assert_eq!(h.meta.writes.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn claims_a_noted_parent_tool_call_when_mcp_omits_the_id() {
        let h = harness(MockDepthLookup::default(), DelegationConfig::default());
        h.broker.note_parent_tool_call(
            "parent-conn",
            "acp-tool-1",
            DelegationMatchKey {
                agent_type: AgentId::parse("codex").unwrap(),
                task: "do the thing".to_string(),
                working_dir: Some("/work".to_string()),
            },
        );
        let mut req = request(Uuid::nil());
        req.parent_tool_use_id.clear();
        let report = h.broker.start_delegation(req).await;
        assert_eq!(report.status, TaskStatus::Running);
        wait_until(|| h.events.started.lock().unwrap().len() == 1).await;
        assert_eq!(
            h.events.started.lock().unwrap()[0].parent_tool_use_id,
            "acp-tool-1"
        );
    }

    #[tokio::test]
    async fn announces_the_child_conversation_before_the_agent_connects() {
        let mut spawner = MockSpawner::new();
        let release = Arc::new(tokio::sync::Notify::new());
        spawner.spawn_release_gate = Some(release.clone());
        let reached = spawner.spawn_reached_gate.clone();
        let spawner = Arc::new(spawner);
        let events = Arc::new(crate::testing::RecordingEventEmitter::default());
        let broker = DelegationBroker::new(
            spawner.clone(),
            Arc::new(MockDepthLookup::default()),
            Arc::new(crate::testing::MockStatusLookup::default()),
            Arc::new(crate::testing::RecordingMetaWriter::default()),
            events.clone(),
            DelegationConfig::default(),
        );
        let start_broker = broker.clone();
        let start =
            tokio::spawn(async move { start_broker.start_delegation(request(Uuid::nil())).await });
        reached.notified().await;

        assert_eq!(events.started.lock().unwrap().len(), 1);
        assert_ne!(
            events.started.lock().unwrap()[0].child_session_id,
            Uuid::nil()
        );

        release.notify_one();
        assert_eq!(start.await.unwrap().status, TaskStatus::Running);
    }

    #[tokio::test]
    async fn lifecycle_events_reference_the_parent_conversation() {
        let parent_conversation_id = Uuid::new_v4();
        let h = harness(MockDepthLookup::default(), DelegationConfig::default());

        let report = h
            .broker
            .start_delegation(request(parent_conversation_id))
            .await;
        let task_id = report.task_id.unwrap();
        h.broker
            .complete_call(&task_id, ok_outcome(h.spawner.child_session_id))
            .await;

        assert_eq!(
            h.events.started.lock().unwrap()[0].parent_conversation_id,
            parent_conversation_id
        );
        assert_eq!(
            h.events.completed.lock().unwrap()[0].parent_conversation_id,
            parent_conversation_id
        );
        assert_eq!(h.events.started.lock().unwrap()[0].delegation_id, task_id);
        assert_eq!(h.events.completed.lock().unwrap()[0].delegation_id, task_id);
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
    async fn depth_limit_is_capped_at_eight() {
        let chain = (1..=9).map(Uuid::from_u128).collect::<Vec<_>>();
        let parent = *chain.last().unwrap();
        let config = DelegationConfig {
            depth_limit: 9,
            ..DelegationConfig::default()
        };
        let h = harness(MockDepthLookup::chain(&chain), config);

        let report = h.broker.start_delegation(request(parent)).await;

        assert_eq!(report.status, TaskStatus::Failed);
        assert_eq!(report.error_code.as_deref(), Some("depth_limit"));
        assert!(h.spawner.calls.lock().unwrap().spawned.is_empty());
    }

    #[tokio::test]
    async fn active_child_budget_rejects_parallel_fan_out_before_spawn() {
        let config = DelegationConfig {
            max_active_children: 1,
            ..DelegationConfig::default()
        };
        let h = harness(MockDepthLookup::default(), config);
        let mut first_request = request(Uuid::nil());
        first_request.workspace_access = DelegationWorkspaceAccess::WriteSerialized;
        let first = h.broker.start_delegation(first_request).await;
        assert_eq!(first.status, TaskStatus::Running);
        wait_until(|| h.spawner.calls.lock().unwrap().spawned.len() == 1).await;

        let rejected = h.broker.start_delegation(request(Uuid::nil())).await;
        assert_eq!(rejected.status, TaskStatus::Failed);
        assert_eq!(rejected.error_code.as_deref(), Some("active_child_limit"));
        assert_eq!(h.spawner.calls.lock().unwrap().spawned.len(), 1);
    }

    #[tokio::test]
    async fn unknown_writers_are_serialized_for_the_same_working_directory() {
        let config = DelegationConfig {
            max_active_children: 2,
            ..DelegationConfig::default()
        };
        let h = harness(MockDepthLookup::default(), config);
        let mut first_request = request(Uuid::nil());
        first_request.workspace_access = DelegationWorkspaceAccess::WriteSerialized;
        let first = h.broker.start_delegation(first_request).await;
        let first_task_id = first.task_id.expect("first task accepted");
        wait_until(|| h.spawner.calls.lock().unwrap().spawned.len() == 1).await;
        wait_until(|| h.broker.running_count() == 1).await;

        let second_broker = h.broker.clone();
        let mut second_request = request(Uuid::nil());
        second_request.workspace_access = DelegationWorkspaceAccess::WriteSerialized;
        let second =
            tokio::spawn(async move { second_broker.start_delegation(second_request).await });
        tokio::task::yield_now().await;
        assert_eq!(
            h.spawner.calls.lock().unwrap().spawned.len(),
            1,
            "second writer must wait before spawning"
        );

        h.broker
            .complete_call(&first_task_id, ok_outcome(h.spawner.child_session_id))
            .await;
        let second = tokio::time::timeout(Duration::from_secs(1), second)
            .await
            .expect("second writer unblocked")
            .expect("join second writer");
        assert_eq!(second.status, TaskStatus::Running);
        assert_eq!(h.spawner.calls.lock().unwrap().spawned.len(), 2);
    }

    #[tokio::test]
    async fn call_budget_counts_completed_and_failed_attempts() {
        let config = DelegationConfig {
            max_active_children: 2,
            max_calls_per_parent: 2,
            ..DelegationConfig::default()
        };
        let h = harness(MockDepthLookup::default(), config);
        for _ in 0..2 {
            let started = h.broker.start_delegation(request(Uuid::nil())).await;
            let task_id = started.task_id.expect("accepted task");
            wait_until(|| h.broker.running_count() == 1).await;
            h.broker
                .complete_call(&task_id, ok_outcome(h.spawner.child_session_id))
                .await;
        }

        let rejected = h.broker.start_delegation(request(Uuid::nil())).await;
        assert_eq!(rejected.status, TaskStatus::Failed);
        assert_eq!(rejected.error_code.as_deref(), Some("call_limit"));
        assert_eq!(h.spawner.calls.lock().unwrap().spawned.len(), 2);
    }

    #[tokio::test]
    async fn result_text_uses_the_snapshotted_byte_limit() {
        let outcome = ok_text_outcome(Uuid::new_v4(), "界".repeat(1_000));
        let (_, text, _, _) = terminal_fields(&outcome, 1_024);
        let text = text.expect("capped result");
        assert!(text.len() <= 1_024);
        assert!(text.is_char_boundary(text.len()));
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
            child_agent_type: AgentId::parse("codex").unwrap(),
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
            .get_tasks_status(
                &scope(Uuid::nil()),
                std::slice::from_ref(&call_id),
                StatusWait::Immediate,
            )
            .await;
        assert_eq!(running.len(), 1);
        assert_eq!(running[0].status, TaskStatus::Running);

        h.broker
            .complete_call(&call_id, ok_outcome(h.spawner.child_session_id))
            .await;

        let done = h
            .broker
            .get_tasks_status(&scope(Uuid::nil()), &[call_id], StatusWait::Immediate)
            .await;
        assert_eq!(done[0].status, TaskStatus::Completed);
    }

    #[tokio::test]
    async fn identical_parallel_tasks_keep_independent_task_ids() {
        let h = harness(MockDepthLookup::default(), DelegationConfig::default());
        let (first, second) = tokio::join!(
            h.broker.start_delegation(request(Uuid::nil())),
            h.broker.start_delegation(request(Uuid::nil())),
        );
        let first_id = first.task_id.unwrap();
        let second_id = second.task_id.unwrap();
        assert_ne!(first_id, second_id);

        h.broker
            .complete_call(
                &first_id,
                ok_text_outcome(h.spawner.child_session_id, "first result".to_string()),
            )
            .await;
        let reports = h
            .broker
            .get_tasks_status(
                &scope(Uuid::nil()),
                &[first_id, second_id],
                StatusWait::Immediate,
            )
            .await;

        assert_eq!(reports[0].status, TaskStatus::Completed);
        assert_eq!(reports[0].text.as_deref(), Some("first result"));
        assert_eq!(reports[1].status, TaskStatus::Running);
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
            .get_tasks_status(&scope(Uuid::nil()), &[call_id], StatusWait::Bounded(5_000))
            .await;
        assert_eq!(reports[0].status, TaskStatus::Completed);
    }

    #[tokio::test]
    async fn status_unknown_for_unrecognized_id() {
        let h = harness(MockDepthLookup::default(), DelegationConfig::default());
        let reports = h
            .broker
            .get_tasks_status(
                &scope(Uuid::nil()),
                &["nope".to_string()],
                StatusWait::Immediate,
            )
            .await;
        assert_eq!(reports[0].status, TaskStatus::Unknown);
    }

    #[tokio::test]
    async fn status_falls_back_to_db_for_evicted_task() {
        let status = Arc::new(MockStatusLookup {
            record: Some(ChildStatusRecord {
                child_session_id: Uuid::from_u128(7),
                parent_conversation_id: Some(Uuid::nil()),
                status: TaskStatus::Completed,
                agent_type: Some(AgentId::parse("gemini").unwrap()),
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
            .get_tasks_status(
                &scope(Uuid::nil()),
                &["evicted".to_string()],
                StatusWait::Immediate,
            )
            .await;
        assert_eq!(reports[0].status, TaskStatus::Completed);
        assert_eq!(reports[0].child_session_id, Some(Uuid::from_u128(7)));
    }

    #[tokio::test]
    async fn cancel_running_task_marks_canceled_and_tears_down() {
        let h = harness(MockDepthLookup::default(), DelegationConfig::default());
        let started = h.broker.start_delegation(request(Uuid::nil())).await;
        let call_id = started.task_id.clone().unwrap();
        let child_session_id = started.child_session_id.expect("child session");

        let report = h
            .broker
            .cancel_delegation(&scope(Uuid::nil()), &call_id)
            .await;
        assert_eq!(report.status, TaskStatus::Canceled);
        assert_eq!(h.broker.running_count(), 0);
        let calls = h.spawner.calls.lock().unwrap();
        assert_eq!(calls.canceled.len(), 1);
        assert_eq!(calls.released, vec![child_session_id]);
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

        let report = h
            .broker
            .cancel_delegation(&scope(Uuid::nil()), &call_id)
            .await;
        assert_eq!(report.status, TaskStatus::Completed);
        assert!(h.spawner.calls.lock().unwrap().canceled.is_empty());
    }

    #[tokio::test]
    async fn completed_status_does_not_duplicate_child_output_in_memory() {
        let h = harness(MockDepthLookup::default(), DelegationConfig::default());
        let started = h.broker.start_delegation(request(Uuid::nil())).await;
        let task_id = started.task_id.clone().unwrap();
        let child_session_id = started.child_session_id.expect("child session");
        h.broker
            .complete_call(
                &task_id,
                ok_text_outcome(child_session_id, "x".repeat(300 * 1024)),
            )
            .await;

        let reports = h
            .broker
            .get_tasks_status(&scope(Uuid::nil()), &[task_id], StatusWait::Immediate)
            .await;

        assert_eq!(reports[0].status, TaskStatus::Completed);
        assert_eq!(reports[0].child_session_id, Some(child_session_id));
        let text = reports[0].text.as_ref().expect("capped result");
        assert!(text.len() <= 256 * 1024);
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
        let events = Arc::new(RecordingEventEmitter::default());

        let broker = DelegationBroker::new(
            spawner,
            Arc::new(MockDepthLookup::default()),
            Arc::new(MockStatusLookup::default()),
            Arc::new(RecordingMetaWriter::default()),
            events.clone(),
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
            .get_tasks_status(&scope(Uuid::nil()), &[call_id], StatusWait::Immediate)
            .await;
        assert_eq!(done[0].status, TaskStatus::Completed);
        assert_eq!(*events.order.lock().unwrap(), vec!["started", "completed"]);
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
                parent_conversation_id: Some(Uuid::nil()),
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
            broker.get_tasks_status(
                &scope(Uuid::nil()),
                &["db-only".to_string()],
                StatusWait::Infinite,
            ),
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
        let cancel_report = broker
            .cancel_delegation(&scope(Uuid::nil()), &call_id)
            .await;
        assert_eq!(cancel_report.status, TaskStatus::Canceled);
        assert_eq!(spawner.calls.lock().unwrap().canceled.len(), 1);
        assert_eq!(spawner.calls.lock().unwrap().disconnected.len(), 1);
        release.notify_one();

        let start_report = start.await.unwrap();
        // start_delegation drained the buffered cancel → resolved as Canceled,
        // never left running, and tore the child down.
        assert_eq!(start_report.status, TaskStatus::Canceled);
        assert_eq!(broker.running_count(), 0);
        assert!(
            !spawner.calls.lock().unwrap().disconnected.is_empty(),
            "setup teardown is idempotent"
        );
    }

    #[tokio::test]
    async fn early_cancel_wins_over_later_setup_completion() {
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
        reached.notified().await;
        let call_id = captured.lock().unwrap().clone().expect("captured call id");

        let canceled = broker
            .cancel_delegation(&scope(Uuid::nil()), &call_id)
            .await;
        assert_eq!(canceled.status, TaskStatus::Canceled);
        broker.complete_call(&call_id, ok_outcome(child)).await;
        release.notify_one();

        let report = start.await.unwrap();
        assert_eq!(report.status, TaskStatus::Canceled);
    }

    #[tokio::test]
    async fn external_handle_cancel_stops_the_correlated_task() {
        let h = harness(MockDepthLookup::default(), DelegationConfig::default());
        let mut req = request(Uuid::nil());
        req.external_handle = Some("mcp-request-1".to_string());
        let started = h.broker.start_delegation(req).await;

        let canceled = h
            .broker
            .cancel_external(&scope(Uuid::nil()), "mcp-request-1")
            .await
            .expect("running handle resolves to a task");

        assert_eq!(canceled.task_id, started.task_id);
        assert_eq!(canceled.status, TaskStatus::Canceled);
        assert_eq!(h.spawner.calls.lock().unwrap().canceled.len(), 1);
    }

    #[tokio::test]
    async fn external_cancel_before_call_prevents_spawn() {
        let h = harness(MockDepthLookup::default(), DelegationConfig::default());
        assert!(
            h.broker
                .cancel_external(&scope(Uuid::nil()), "mcp-request-early")
                .await
                .is_none()
        );
        let mut req = request(Uuid::nil());
        req.external_handle = Some("mcp-request-early".to_string());

        let report = h.broker.start_delegation(req).await;

        assert_eq!(report.status, TaskStatus::Canceled);
        assert!(h.spawner.calls.lock().unwrap().spawned.is_empty());
    }

    #[tokio::test]
    async fn consumed_pre_cancel_does_not_evict_a_reused_handle() {
        let h = harness(MockDepthLookup::default(), DelegationConfig::default());
        let parent = scope(Uuid::nil());

        h.broker.cancel_external(&parent, "reused").await;
        let mut first = request(Uuid::nil());
        first.external_handle = Some("reused".to_string());
        assert_eq!(
            h.broker.start_delegation(first).await.status,
            TaskStatus::Canceled
        );

        for index in 0..(TOMBSTONE_CAP - 1) {
            h.broker
                .cancel_external(&parent, &format!("other-{index}"))
                .await;
        }
        h.broker.cancel_external(&parent, "reused").await;
        h.broker.cancel_external(&parent, "overflow").await;

        let mut reused = request(Uuid::nil());
        reused.external_handle = Some("reused".to_string());
        assert_eq!(
            h.broker.start_delegation(reused).await.status,
            TaskStatus::Canceled
        );
    }

    #[tokio::test]
    async fn setup_cancel_remains_terminal_when_send_later_fails() {
        let mut spawner = MockSpawner::new();
        spawner.send_error = Some("late send failure".to_string());
        let release = Arc::new(tokio::sync::Notify::new());
        spawner.release_gate = Some(release.clone());
        let reached = spawner.send_reached_gate.clone();
        let captured = spawner.captured_call_id.clone();
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
        reached.notified().await;
        let call_id = captured.lock().unwrap().clone().expect("captured call id");
        let canceled = broker
            .cancel_delegation(&scope(Uuid::nil()), &call_id)
            .await;
        assert_eq!(canceled.status, TaskStatus::Canceled);
        release.notify_one();

        let report = start.await.unwrap();
        assert_eq!(report.status, TaskStatus::Canceled);
        assert_eq!(report.error_code.as_deref(), Some("canceled"));
        let status = broker
            .get_tasks_status(&scope(Uuid::nil()), &[call_id], StatusWait::Immediate)
            .await;
        assert_eq!(status[0].status, TaskStatus::Canceled);
    }

    #[tokio::test]
    async fn linked_send_failure_emits_a_durable_terminal_lifecycle() {
        let mut spawner = MockSpawner::new();
        spawner.send_error_after_link = Some("agent rejected first prompt".to_string());
        let events = Arc::new(RecordingEventEmitter::default());
        let broker = DelegationBroker::new(
            Arc::new(spawner),
            Arc::new(MockDepthLookup::default()),
            Arc::new(MockStatusLookup::default()),
            Arc::new(RecordingMetaWriter::default()),
            events.clone(),
            DelegationConfig::default(),
        );

        let report = broker.start_delegation(request(Uuid::nil())).await;

        assert_eq!(report.status, TaskStatus::Failed);
        assert_eq!(
            events.order.lock().unwrap().as_slice(),
            &["started", "completed"]
        );
        assert_eq!(events.started.lock().unwrap().len(), 1);
        assert_eq!(events.completed.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn parent_closed_cascades_only_its_running_children() {
        let h = harness(MockDepthLookup::default(), DelegationConfig::default());
        let first = h
            .broker
            .start_delegation(request(Uuid::nil()))
            .await
            .task_id
            .unwrap();
        let second = h
            .broker
            .start_delegation(request(Uuid::nil()))
            .await
            .task_id
            .unwrap();
        let mut other_parent = request(Uuid::nil());
        other_parent.parent_connection_id = "conn-2".to_string();
        let unaffected = h
            .broker
            .start_delegation(other_parent)
            .await
            .task_id
            .unwrap();

        let canceled = h.broker.parent_closed("parent-conn").await;

        assert_eq!(canceled.len(), 2);
        assert!(
            canceled
                .iter()
                .all(|report| report.status == TaskStatus::Canceled)
        );
        let status = h
            .broker
            .get_tasks_status(&scope(Uuid::nil()), &[first, second], StatusWait::Immediate)
            .await;
        let unaffected_status = h
            .broker
            .get_tasks_status(
                &scope_for("conn-2", Uuid::nil()),
                &[unaffected],
                StatusWait::Immediate,
            )
            .await;
        assert_eq!(status[0].status, TaskStatus::Canceled);
        assert_eq!(status[1].status, TaskStatus::Canceled);
        assert_eq!(unaffected_status[0].status, TaskStatus::Running);
    }

    #[tokio::test]
    async fn parent_closed_before_call_prevents_child_spawn() {
        let h = harness(MockDepthLookup::default(), DelegationConfig::default());

        h.broker.parent_closed("parent-conn").await;
        let report = h.broker.start_delegation(request(Uuid::nil())).await;

        assert_eq!(report.status, TaskStatus::Canceled);
        assert!(h.spawner.calls.lock().unwrap().spawned.is_empty());
    }

    #[tokio::test]
    async fn parent_closed_during_setup_cancels_the_child() {
        let mut spawner = MockSpawner::new();
        let release = Arc::new(tokio::sync::Notify::new());
        spawner.release_gate = Some(release.clone());
        let reached = spawner.send_reached_gate.clone();
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
        reached.notified().await;

        let canceled = broker.parent_closed("parent-conn").await;
        assert_eq!(spawner.calls.lock().unwrap().canceled.len(), 1);
        assert_eq!(spawner.calls.lock().unwrap().disconnected.len(), 1);
        release.notify_one();

        assert_eq!(canceled.len(), 1);
        assert_eq!(canceled[0].status, TaskStatus::Canceled);
        assert_eq!(start.await.unwrap().status, TaskStatus::Canceled);
        assert!(
            !spawner.calls.lock().unwrap().disconnected.is_empty(),
            "setup teardown is idempotent"
        );
    }

    #[tokio::test]
    async fn parent_close_lease_survives_closed_history_eviction() {
        let mut spawner = MockSpawner::new();
        let release = Arc::new(tokio::sync::Notify::new());
        spawner.spawn_release_gate = Some(release.clone());
        let reached = spawner.spawn_reached_gate.clone();
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
        reached.notified().await;

        broker.parent_closed("parent-conn").await;
        for index in 0..TOMBSTONE_CAP {
            broker.parent_closed(&format!("newer-parent-{index}")).await;
        }
        release.notify_one();

        assert_eq!(start.await.unwrap().status, TaskStatus::Canceled);
        assert!(spawner.calls.lock().unwrap().prompts.is_empty());
        assert_eq!(spawner.calls.lock().unwrap().disconnected.len(), 1);
    }

    #[tokio::test]
    async fn parent_close_lease_starts_before_async_depth_lookup() {
        let reached = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let depth = MockDepthLookup {
            parents: HashMap::new(),
            reached_gate: Some(reached.clone()),
            release_gate: Some(release.clone()),
        };
        let h = Arc::new(harness(depth, DelegationConfig::default()));
        let start = tokio::spawn({
            let h = h.clone();
            async move { h.broker.start_delegation(request(Uuid::nil())).await }
        });
        reached.notified().await;

        h.broker.parent_closed("parent-conn").await;
        for index in 0..TOMBSTONE_CAP {
            h.broker
                .parent_closed(&format!("newer-depth-parent-{index}"))
                .await;
        }
        release.notify_one();

        assert_eq!(start.await.unwrap().status, TaskStatus::Canceled);
        assert!(h.spawner.calls.lock().unwrap().spawned.is_empty());
    }

    #[test]
    fn completed_cache_evicts_oldest_text_for_the_same_parent() {
        let mut inner = PendingInner::default();
        for index in 0..3 {
            insert_completed(
                &mut inner,
                format!("task-{index}"),
                CompletedTask {
                    parent_connection_id: "parent".into(),
                    parent_conversation_id: Uuid::nil(),
                    status: TaskStatus::Completed,
                    child_session_id: None,
                    agent_type: None,
                    text: Some("x".repeat(8)),
                    error_code: None,
                    message: None,
                    duration_ms: None,
                },
                16,
            );
        }
        assert!(!inner.completed.contains_key("task-0"));
        assert!(inner.completed.contains_key("task-2"));
        assert_eq!(inner.completed["task-2"].text.as_deref(), Some("xxxxxxxx"));
    }

    #[test]
    fn parent_close_drops_that_parents_cached_results() {
        let mut inner = PendingInner::default();
        insert_completed(
            &mut inner,
            "keep".into(),
            CompletedTask {
                parent_connection_id: "other".into(),
                parent_conversation_id: Uuid::nil(),
                status: TaskStatus::Completed,
                child_session_id: None,
                agent_type: None,
                text: Some("kept".into()),
                error_code: None,
                message: None,
                duration_ms: None,
            },
            0,
        );
        insert_completed(
            &mut inner,
            "drop".into(),
            CompletedTask {
                parent_connection_id: "parent".into(),
                parent_conversation_id: Uuid::nil(),
                status: TaskStatus::Completed,
                child_session_id: None,
                agent_type: None,
                text: Some("gone".into()),
                error_code: None,
                message: None,
                duration_ms: None,
            },
            0,
        );
        drop_completed_for_parent(&mut inner, "parent");
        assert!(inner.completed.contains_key("keep"));
        assert!(!inner.completed.contains_key("drop"));
    }
}
