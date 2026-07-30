use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::Arc,
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, RwLock, broadcast, mpsc};
use ts_rs::TS;
use uuid::Uuid;

use crate::{
    AgentAutoApproveMode, AgentConnectionId, AgentConnectionLaunch, AgentConnectionManager,
    AgentConnectionManagerEvent, AgentContentBlock, AgentElicitationId, AgentElicitationResponse,
    AgentError, AgentEvent, AgentEventEnvelope, AgentId, AgentPermissionId, AgentPermissionRequest,
    AgentPermissionResponse, AgentPreparedSessionSnapshot, AgentPromptId, AgentPromptQueue,
    AgentPromptSnapshot, AgentPromptStatus, AgentResult, AgentSessionConfigOverride,
    AgentSessionControlsSnapshot, AgentSessionId, AgentSessionSnapshot, AgentSessionStatus,
    QueueTransition, SessionLaunchLock,
    state::{AgentConnectionSnapshot, AgentConnectionStatus},
};

pub trait RuntimeEventSink: Send + Sync + 'static {
    fn emit(&self, envelope: AgentEventEnvelope);
}

#[derive(Default)]
pub struct NoopEventSink;

impl RuntimeEventSink for NoopEventSink {
    fn emit(&self, _envelope: AgentEventEnvelope) {}
}

#[derive(Debug, Clone)]
pub struct ConnectAgentInput {
    pub agent_id: AgentId,
    pub launch_lock: SessionLaunchLock,
    pub workspace_id: Uuid,
    pub working_dir: PathBuf,
    pub auto_approve_mode: AgentAutoApproveMode,
    pub env: HashMap<String, String>,
}

#[derive(Debug, Clone)]
pub struct SendAgentPromptInput {
    pub connection_id: AgentConnectionId,
    pub session_id: AgentSessionId,
    pub blocks: Vec<AgentContentBlock>,
    pub mode_override: Option<String>,
    pub config_overrides: Vec<AgentSessionConfigOverride>,
}

#[derive(Debug, Clone)]
pub struct CancelAgentPromptInput {
    pub connection_id: AgentConnectionId,
    pub session_id: AgentSessionId,
    pub prompt_id: AgentPromptId,
}

#[derive(Debug, Clone)]
pub struct RespondAgentPermissionInput {
    pub connection_id: AgentConnectionId,
    pub permission_id: AgentPermissionId,
    pub response: AgentPermissionResponse,
}

#[derive(Debug, Clone)]
pub struct RespondAgentElicitationInput {
    pub connection_id: AgentConnectionId,
    pub elicitation_id: AgentElicitationId,
    pub response: AgentElicitationResponse,
}

#[derive(Debug, Clone)]
pub struct EnsureAgentSessionInput {
    pub agent_id: AgentId,
    pub launch_lock: SessionLaunchLock,
    pub workspace_id: Uuid,
    pub working_dir: PathBuf,
    pub session_id: AgentSessionId,
    pub acp_session_id: String,
    pub auto_approve_mode: AgentAutoApproveMode,
    pub env: HashMap<String, String>,
}

#[derive(Debug, Clone)]
pub struct ResumeAgentSessionInput {
    pub agent_id: AgentId,
    pub launch_lock: SessionLaunchLock,
    pub workspace_id: Uuid,
    pub working_dir: PathBuf,
    pub session_id: AgentSessionId,
    pub external_session_id: String,
    pub auto_approve_mode: AgentAutoApproveMode,
    pub env: HashMap<String, String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RuntimeSnapshot {
    pub sequence: i64,
    pub connections: Vec<AgentConnectionSnapshot>,
    pub sessions: Vec<AgentSessionSnapshot>,
    pub prompts: Vec<AgentPromptSnapshot>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub permissions: Vec<AgentPermissionRequest>,
    pub events: Vec<AgentEventEnvelope>,
}

#[derive(Debug)]
struct RuntimeConnection {
    snapshot: AgentConnectionSnapshot,
}

#[derive(Debug)]
struct RuntimeSession {
    snapshot: AgentSessionSnapshot,
    queue: AgentPromptQueue,
    ownership: RuntimeSessionOwnership,
    controls: AgentSessionControlsSnapshot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuntimeSessionOwnership {
    Owned,
    Prepared,
    Claimed,
}

#[derive(Debug, Default)]
struct RuntimeState {
    sequence: i64,
    connections: HashMap<AgentConnectionId, RuntimeConnection>,
    sessions: HashMap<AgentSessionId, RuntimeSession>,
    prompts: HashMap<AgentPromptId, AgentPromptSnapshot>,
    prompt_blocks: HashMap<AgentPromptId, Vec<AgentContentBlock>>,
    prompt_options: HashMap<AgentPromptId, PromptDispatchOptions>,
    recent_events: VecDeque<AgentEventEnvelope>,
}

#[derive(Debug, Clone, Default)]
struct PromptDispatchOptions {
    mode_override: Option<String>,
    config_overrides: Vec<AgentSessionConfigOverride>,
}

const MAX_RECENT_EVENTS: usize = 2_000;

pub struct AgentRuntime {
    state: Arc<RwLock<RuntimeState>>,
    connection_manager: Arc<AgentConnectionManager>,
    event_sink: Arc<dyn RuntimeEventSink>,
    event_tx: broadcast::Sender<AgentEventEnvelope>,
    session_locks: Arc<Mutex<HashMap<EnsureSessionKey, Arc<Mutex<()>>>>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct EnsureSessionKey {
    agent_id: AgentId,
    working_dir: PathBuf,
    session_id: AgentSessionId,
}

impl Default for AgentRuntime {
    fn default() -> Self {
        Self::new(Arc::new(NoopEventSink))
    }
}

impl AgentRuntime {
    pub fn new(event_sink: Arc<dyn RuntimeEventSink>) -> Self {
        Self::new_with_driver(event_sink, true)
    }

    #[doc(hidden)]
    pub fn new_with_driver(event_sink: Arc<dyn RuntimeEventSink>, driver_enabled: bool) -> Self {
        let (event_tx, _) = broadcast::channel(512);
        let (manager_event_tx, manager_event_rx) = mpsc::unbounded_channel();
        let state = Arc::new(RwLock::new(RuntimeState::default()));
        let session_locks = Arc::new(Mutex::new(HashMap::new()));
        let connection_manager = Arc::new(AgentConnectionManager::new_with_driver(
            manager_event_tx,
            driver_enabled,
        ));
        let runtime = Self {
            state: Arc::clone(&state),
            connection_manager: Arc::clone(&connection_manager),
            event_sink: Arc::clone(&event_sink),
            event_tx: event_tx.clone(),
            session_locks,
        };
        Self::spawn_manager_event_pump(
            state,
            connection_manager,
            event_sink,
            event_tx,
            manager_event_rx,
        );
        runtime
    }

    fn spawn_manager_event_pump(
        state: Arc<RwLock<RuntimeState>>,
        connection_manager: Arc<AgentConnectionManager>,
        event_sink: Arc<dyn RuntimeEventSink>,
        event_tx: broadcast::Sender<AgentEventEnvelope>,
        mut manager_event_rx: mpsc::UnboundedReceiver<AgentConnectionManagerEvent>,
    ) {
        tokio::spawn(async move {
            while let Some(manager_event) = manager_event_rx.recv().await {
                let next_prompt = {
                    let mut state = state.write().await;
                    let active_before =
                        Self::active_prompt_for_manager_event_locked(&state, &manager_event);
                    Self::apply_manager_event_locked(&mut state, &manager_event);
                    let next_prompt = Self::prompt_to_dispatch_after_manager_event_locked(
                        &state,
                        &manager_event,
                        active_before,
                    );
                    Self::emit_with_parts_locked(
                        &mut state,
                        &*event_sink,
                        &event_tx,
                        manager_event.connection_id,
                        manager_event.session_id,
                        manager_event.event,
                    );
                    next_prompt
                };

                if let Some((session_id, prompt_id, blocks, options)) = next_prompt {
                    let _ = connection_manager
                        .send_prompt(
                            manager_event.connection_id,
                            session_id,
                            prompt_id,
                            blocks,
                            options.mode_override,
                            options.config_overrides,
                        )
                        .await;
                }
            }
        });
    }

    fn active_prompt_for_manager_event_locked(
        state: &RuntimeState,
        manager_event: &AgentConnectionManagerEvent,
    ) -> Option<AgentPromptId> {
        let session_id = manager_event.session_id?;
        state
            .sessions
            .get(&session_id)
            .and_then(|session| session.queue.active())
    }

    fn prompt_to_dispatch_after_manager_event_locked(
        state: &RuntimeState,
        manager_event: &AgentConnectionManagerEvent,
        active_before: Option<AgentPromptId>,
    ) -> Option<(
        AgentSessionId,
        AgentPromptId,
        Vec<AgentContentBlock>,
        PromptDispatchOptions,
    )> {
        let session_id = manager_event.session_id?;
        let completed_active = match &manager_event.event {
            AgentEvent::PromptFinished { finished } => active_before == Some(finished.prompt_id),
            AgentEvent::Error { .. } => {
                active_before.is_some() && manager_event.prompt_id == active_before
            }
            _ => false,
        };
        if !completed_active {
            return None;
        }

        let prompt_id = state
            .sessions
            .get(&session_id)
            .and_then(|session| session.queue.active())?;
        if Some(prompt_id) == active_before {
            return None;
        }

        let blocks = state.prompt_blocks.get(&prompt_id).cloned()?;
        let options = state
            .prompt_options
            .get(&prompt_id)
            .cloned()
            .unwrap_or_default();
        Some((session_id, prompt_id, blocks, options))
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<AgentEventEnvelope> {
        self.event_tx.subscribe()
    }

    /// Emit a synthetic event onto `connection_id`'s stream as if the runtime
    /// produced it. The delegation layer uses this to surface
    /// `AgentEvent::DelegationStarted` / `DelegationCompleted` on the parent
    /// connection, so they flow through the normal sink (DB) + broadcast
    /// (frontend) path with a proper sequence number.
    pub async fn emit_external(
        &self,
        connection_id: AgentConnectionId,
        session_id: Option<AgentSessionId>,
        event: AgentEvent,
    ) {
        let mut state = self.state.write().await;
        Self::emit_with_parts_locked(
            &mut state,
            self.event_sink.as_ref(),
            &self.event_tx,
            connection_id,
            session_id,
            event,
        );
    }

    /// Install the delegation companion injector so each new ACP session can
    /// have the companion MCP server spliced into its `session/new`.
    pub fn install_delegation_injector(
        &self,
        injector: Arc<dyn crate::delegation_inject::DelegationInjector>,
    ) {
        self.connection_manager
            .install_delegation_injector(injector);
    }

    pub async fn snapshot(&self) -> RuntimeSnapshot {
        let state = self.state.read().await;
        RuntimeSnapshot {
            sequence: state.sequence,
            connections: state
                .connections
                .values()
                .map(|connection| connection.snapshot.clone())
                .collect(),
            sessions: state
                .sessions
                .values()
                .map(|session| session.snapshot.clone())
                .collect(),
            prompts: state.prompts.values().cloned().collect(),
            permissions: active_permissions_from_events(&state.recent_events),
            events: state.recent_events.iter().cloned().collect(),
        }
    }

    pub async fn connect(&self, input: ConnectAgentInput) -> AgentResult<AgentConnectionSnapshot> {
        let now = Utc::now();
        let snapshot = AgentConnectionSnapshot {
            id: AgentConnectionId::new(),
            agent_id: input.agent_id,
            workspace_id: input.workspace_id,
            status: AgentConnectionStatus::Connecting,
            working_dir: input.working_dir.display().to_string(),
            status_message: None,
            created_at: now,
            updated_at: now,
        };

        let mut state = self.state.write().await;
        state.connections.insert(
            snapshot.id,
            RuntimeConnection {
                snapshot: snapshot.clone(),
            },
        );
        self.emit_locked(
            &mut state,
            snapshot.workspace_id,
            snapshot.id,
            None,
            AgentEvent::ConnectionStatusChanged {
                snapshot: snapshot.clone(),
            },
        );
        drop(state);

        let (_registered, ready_rx) = self
            .connection_manager
            .register_connection(AgentConnectionLaunch {
                connection_id: snapshot.id,
                agent_id: snapshot.agent_id.clone(),
                launch_lock: input.launch_lock,
                workspace_id: snapshot.workspace_id,
                working_dir: input.working_dir,
                auto_approve_mode: input.auto_approve_mode,
                env: input.env,
            })
            .await;

        // Block until the ACP handshake completes. `run_acp` signals readiness
        // after InitializeRequest succeeds; any spawn/handshake failure drops the
        // sender. Marking the connection Ready only after this guarantees the
        // first prompt reaches a live agent instead of being buffered into a
        // command channel that is about to close (the silent "no response" bug).
        match ready_rx.await {
            Ok(Ok(())) => {}
            other => {
                let message = match other {
                    Ok(Err(error)) => error.to_string(),
                    _ => "agent connection failed before it became ready".to_string(),
                };
                let mut state = self.state.write().await;
                if let Some(connection) = state.connections.get_mut(&snapshot.id) {
                    connection.snapshot.status = AgentConnectionStatus::Failed;
                    connection.snapshot.status_message = Some(message.clone());
                    connection.snapshot.updated_at = Utc::now();
                    let failed = connection.snapshot.clone();
                    self.emit_locked(
                        &mut state,
                        failed.workspace_id,
                        failed.id,
                        None,
                        AgentEvent::ConnectionStatusChanged { snapshot: failed },
                    );
                }
                drop(state);
                let _ = self.connection_manager.disconnect(snapshot.id).await;
                return Err(AgentError::Runtime(message));
            }
        }

        let mut state = self.state.write().await;
        let ready_snapshot = if let Some(connection) = state.connections.get_mut(&snapshot.id) {
            connection.snapshot.status = AgentConnectionStatus::Ready;
            connection.snapshot.updated_at = Utc::now();
            Some(connection.snapshot.clone())
        } else {
            None
        };
        let returned_snapshot = ready_snapshot.clone().unwrap_or(snapshot);
        if let Some(ready_snapshot) = ready_snapshot {
            self.emit_locked(
                &mut state,
                ready_snapshot.workspace_id,
                ready_snapshot.id,
                None,
                AgentEvent::ConnectionStatusChanged {
                    snapshot: ready_snapshot,
                },
            );
        }

        Ok(returned_snapshot)
    }

    pub async fn new_session(
        &self,
        connection_id: AgentConnectionId,
        acp_session_id: impl Into<String>,
    ) -> AgentResult<AgentSessionSnapshot> {
        self.new_session_with_id(connection_id, AgentSessionId::new(), acp_session_id)
            .await
    }

    pub async fn new_session_with_id(
        &self,
        connection_id: AgentConnectionId,
        session_id: AgentSessionId,
        acp_session_id: impl Into<String>,
    ) -> AgentResult<AgentSessionSnapshot> {
        let now = Utc::now();
        let mut state = self.state.write().await;
        let workspace_id = state
            .connections
            .get(&connection_id)
            .map(|connection| connection.snapshot.workspace_id)
            .ok_or_else(|| AgentError::ConnectionNotFound(connection_id.to_string()))?;
        let snapshot = AgentSessionSnapshot {
            id: session_id,
            connection_id,
            acp_session_id: acp_session_id.into(),
            status: AgentSessionStatus::Ready,
            active_prompt_id: None,
            queued_prompt_ids: Vec::new(),
            created_at: now,
            updated_at: now,
        };

        state.sessions.insert(
            snapshot.id,
            RuntimeSession {
                snapshot: snapshot.clone(),
                queue: AgentPromptQueue::default(),
                ownership: RuntimeSessionOwnership::Owned,
                controls: AgentSessionControlsSnapshot {
                    modes: Vec::new(),
                    current_mode: None,
                    config_options: Vec::new(),
                },
            },
        );
        self.emit_locked(
            &mut state,
            workspace_id,
            connection_id,
            Some(snapshot.id),
            AgentEvent::SessionCreated {
                snapshot: snapshot.clone(),
            },
        );
        Ok(snapshot)
    }

    pub async fn ensure_session(
        &self,
        input: EnsureAgentSessionInput,
    ) -> AgentResult<AgentSessionSnapshot> {
        let session_lock = {
            let key = EnsureSessionKey {
                agent_id: input.agent_id.clone(),
                working_dir: input.working_dir.clone(),
                session_id: input.session_id,
            };
            let mut locks = self.session_locks.lock().await;
            Arc::clone(locks.entry(key).or_insert_with(|| Arc::new(Mutex::new(()))))
        };
        let _session_guard = session_lock.lock().await;

        let existing_session = self
            .state
            .read()
            .await
            .sessions
            .get(&input.session_id)
            .map(|session| session.snapshot.clone());

        if let Some(existing_session) = existing_session {
            let connection = {
                let state = self.state.read().await;
                state
                    .connections
                    .get(&existing_session.connection_id)
                    .map(|connection| connection.snapshot.clone())
            };
            if let Some(connection) = connection
                && connection.agent_id == input.agent_id
                && connection.workspace_id == input.workspace_id
                && connection.working_dir == input.working_dir.display().to_string()
                && connection.status == AgentConnectionStatus::Ready
                && self
                    .connection_manager
                    .has_connection(existing_session.connection_id)
                    .await
            {
                return Ok(existing_session);
            }
        }

        let existing_connection = {
            let state = self.state.read().await;
            let candidates = state
                .connections
                .values()
                .filter(|connection| {
                    connection.snapshot.status == AgentConnectionStatus::Ready
                        && connection.snapshot.agent_id == input.agent_id
                        && connection.snapshot.workspace_id == input.workspace_id
                        && connection.snapshot.working_dir
                            == input.working_dir.display().to_string()
                })
                .map(|connection| connection.snapshot.id)
                .collect::<Vec<_>>();
            drop(state);

            let mut active_connection = None;
            for connection_id in candidates {
                if self.connection_manager.has_connection(connection_id).await {
                    active_connection = Some(connection_id);
                    break;
                }
            }
            active_connection
        };

        let connection_id = match existing_connection {
            Some(connection_id) => connection_id,
            None => {
                self.connect(ConnectAgentInput {
                    agent_id: input.agent_id,
                    launch_lock: input.launch_lock,
                    workspace_id: input.workspace_id,
                    working_dir: input.working_dir,
                    auto_approve_mode: input.auto_approve_mode,
                    env: input.env,
                })
                .await?
                .id
            }
        };

        if let Some(existing) = self.state.write().await.sessions.get_mut(&input.session_id) {
            existing.snapshot.connection_id = connection_id;
            existing.snapshot.acp_session_id = input.acp_session_id;
            existing.snapshot.status = AgentSessionStatus::Ready;
            existing.snapshot.updated_at = Utc::now();
            return Ok(existing.snapshot.clone());
        }

        self.new_session_with_id(connection_id, input.session_id, input.acp_session_id)
            .await
    }

    /// Establish the concrete ACP session now and retain it for the future
    /// conversation whose UUID equals `input.session_id`.
    pub async fn prepare_session(
        &self,
        input: EnsureAgentSessionInput,
    ) -> AgentResult<AgentPreparedSessionSnapshot> {
        let already_registered = self
            .state
            .read()
            .await
            .sessions
            .contains_key(&input.session_id);
        let session = self.ensure_session(input.clone()).await?;
        if !already_registered
            && let Some(stored) = self.state.write().await.sessions.get_mut(&session.id)
        {
            // Mark ownership before the ACP request so a failed/aborted
            // preparation can still be cleaned up as a draft session.
            stored.ownership = RuntimeSessionOwnership::Prepared;
        }
        let mut prepared = self
            .connection_manager
            .prepare_session(session.connection_id, session.id)
            .await;
        if prepared
            .as_ref()
            .is_err_and(is_connection_loss_during_session_preparation)
        {
            let first_error = prepared
                .as_ref()
                .expect_err("connection-loss predicate only matches errors");
            self.retire_failed_connection(session.connection_id, first_error)
                .await;
            let rebound = self.ensure_session(input).await?;
            prepared = self
                .connection_manager
                .prepare_session(rebound.connection_id, rebound.id)
                .await;
        }
        let (acp_session_id, controls) = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                if !already_registered {
                    let _ = self.discard_prepared_session(session.id).await;
                }
                return Err(error);
            }
        };

        let mut state = self.state.write().await;
        let stored = state
            .sessions
            .get_mut(&session.id)
            .ok_or_else(|| AgentError::SessionNotFound(session.id.to_string()))?;
        stored.snapshot.acp_session_id = acp_session_id;
        stored.snapshot.updated_at = Utc::now();
        stored.controls = controls.clone();
        Ok(AgentPreparedSessionSnapshot {
            session: stored.snapshot.clone(),
            controls,
        })
    }

    async fn retire_failed_connection(&self, connection_id: AgentConnectionId, error: &AgentError) {
        // `disconnect` removes the manager entry before sending the command, so
        // this also evicts a stale sender whose receiver has already vanished.
        let _ = self.connection_manager.disconnect(connection_id).await;

        let mut state = self.state.write().await;
        let Some(connection) = state.connections.get_mut(&connection_id) else {
            return;
        };
        connection.snapshot.status = AgentConnectionStatus::Failed;
        connection.snapshot.status_message = Some(error.to_string());
        connection.snapshot.updated_at = Utc::now();
        let snapshot = connection.snapshot.clone();
        self.emit_locked(
            &mut state,
            snapshot.workspace_id,
            snapshot.id,
            None,
            AgentEvent::ConnectionStatusChanged { snapshot },
        );
    }

    /// Mark a prepared session as owned by a persisted conversation. Cleanup
    /// requests from the creation form become no-ops after this point. The ACP
    /// controls were first emitted before the Conversation row existed, so
    /// publish the retained snapshot again now that it can be projected.
    pub async fn commit_prepared_session(&self, session_id: AgentSessionId) {
        let mut state = self.state.write().await;
        let Some((connection_id, controls)) = state.sessions.get_mut(&session_id).map(|session| {
            session.ownership = RuntimeSessionOwnership::Owned;
            (session.snapshot.connection_id, session.controls.clone())
        }) else {
            return;
        };
        Self::emit_with_parts_locked(
            &mut state,
            self.event_sink.as_ref(),
            &self.event_tx,
            connection_id,
            Some(session_id),
            AgentEvent::SessionModes {
                modes: controls.modes,
                current: controls.current_mode,
            },
        );
        Self::emit_with_parts_locked(
            &mut state,
            self.event_sink.as_ref(),
            &self.event_tx,
            connection_id,
            Some(session_id),
            AgentEvent::SessionConfigOptions {
                options: controls.config_options,
            },
        );
    }

    /// Atomically reserve the exact draft Session a caller is about to persist.
    /// Form cleanup becomes a no-op after this boundary, including while the
    /// database work is awaiting. Reclaiming is idempotent so a failed database
    /// write can be retried with the same prepared Session.
    pub async fn claim_prepared_session(
        &self,
        session_id: AgentSessionId,
        workspace_id: Uuid,
        agent_id: AgentId,
    ) -> AgentResult<AgentSessionSnapshot> {
        let mut state = self.state.write().await;
        let session = state
            .sessions
            .get(&session_id)
            .ok_or_else(|| AgentError::SessionNotFound(session_id.to_string()))?;
        if !matches!(
            session.ownership,
            RuntimeSessionOwnership::Prepared | RuntimeSessionOwnership::Claimed
        ) {
            return Err(AgentError::Runtime(format!(
                "session {session_id} is not an uncommitted prepared session"
            )));
        }
        let connection = state
            .connections
            .get(&session.snapshot.connection_id)
            .ok_or_else(|| {
                AgentError::ConnectionNotFound(session.snapshot.connection_id.to_string())
            })?;
        if connection.snapshot.workspace_id != workspace_id
            || connection.snapshot.agent_id != agent_id
        {
            return Err(AgentError::Runtime(format!(
                "prepared session {session_id} does not match the selected Workspace and Agent"
            )));
        }
        let snapshot = session.snapshot.clone();
        state
            .sessions
            .get_mut(&session_id)
            .expect("prepared session was validated while holding the runtime lock")
            .ownership = RuntimeSessionOwnership::Claimed;
        Ok(snapshot)
    }

    pub async fn discard_prepared_session(&self, session_id: AgentSessionId) -> AgentResult<()> {
        let mut state = self.state.write().await;
        let Some(session) = state.sessions.get(&session_id) else {
            return Ok(());
        };
        if session.ownership != RuntimeSessionOwnership::Prepared {
            return Ok(());
        }
        let connection_id = session.snapshot.connection_id;
        self.connection_manager
            .discard_session(connection_id, session_id)
            .await?;
        state.sessions.remove(&session_id);
        Ok(())
    }

    pub async fn resume_session(
        &self,
        input: ResumeAgentSessionInput,
    ) -> AgentResult<AgentSessionSnapshot> {
        let session = self
            .ensure_session(EnsureAgentSessionInput {
                agent_id: input.agent_id,
                launch_lock: input.launch_lock,
                workspace_id: input.workspace_id,
                working_dir: input.working_dir,
                session_id: input.session_id,
                acp_session_id: input.external_session_id.clone(),
                auto_approve_mode: input.auto_approve_mode,
                env: input.env,
            })
            .await?;
        let (acp_session_id, controls) = self
            .connection_manager
            .resume_session(
                session.connection_id,
                input.session_id,
                input.external_session_id,
            )
            .await?;

        let mut state = self.state.write().await;
        let Some(session_state) = state.sessions.get_mut(&input.session_id) else {
            return Err(AgentError::SessionNotFound(input.session_id.to_string()));
        };
        session_state.snapshot.acp_session_id = acp_session_id;
        session_state.snapshot.status = AgentSessionStatus::Ready;
        session_state.snapshot.updated_at = Utc::now();
        session_state.controls = controls;
        Ok(session_state.snapshot.clone())
    }

    /// Return the controls retained for a live session. Resume/prepare paths
    /// populate this snapshot from the concrete ACP session, allowing a caller
    /// to hydrate UI state without sending a prompt.
    pub async fn session_controls_snapshot(
        &self,
        session_id: AgentSessionId,
    ) -> AgentResult<AgentSessionControlsSnapshot> {
        self.state
            .read()
            .await
            .sessions
            .get(&session_id)
            .map(|session| session.controls.clone())
            .ok_or_else(|| AgentError::SessionNotFound(session_id.to_string()))
    }

    /// Fork the live ACP session behind `session_id` (P1-4). Returns the new
    /// forked external session id (the agent branched its context). Errors when
    /// the session has no live connection or the agent doesn't support fork —
    /// the caller then falls back to a context-free (import-semantics) branch.
    pub async fn fork_session(&self, session_id: AgentSessionId) -> AgentResult<String> {
        let connection_id = {
            let state = self.state.read().await;
            state
                .sessions
                .get(&session_id)
                .map(|session| session.snapshot.connection_id)
        };
        let Some(connection_id) = connection_id else {
            return Err(AgentError::SessionNotFound(session_id.to_string()));
        };
        self.connection_manager
            .fork_session(connection_id, session_id)
            .await
    }

    /// Immediately switch the live session's ACP mode (`session/set_mode`).
    /// Resolves the connection from the session like [`Self::fork_session`];
    /// errors when the session has no live connection or a turn is in flight —
    /// callers then keep the choice as a next-turn override.
    pub async fn set_session_mode(
        &self,
        session_id: AgentSessionId,
        mode_id: impl Into<String>,
    ) -> AgentResult<AgentSessionControlsSnapshot> {
        let connection_id = {
            let state = self.state.read().await;
            state
                .sessions
                .get(&session_id)
                .map(|session| session.snapshot.connection_id)
        };
        let Some(connection_id) = connection_id else {
            return Err(AgentError::SessionNotFound(session_id.to_string()));
        };
        let controls = self
            .connection_manager
            .set_session_mode(connection_id, session_id, mode_id)
            .await?;
        if let Some(session) = self.state.write().await.sessions.get_mut(&session_id) {
            session.controls = controls.clone();
        }
        Ok(controls)
    }

    /// Immediately change one agent-advertised session config option
    /// (`session/set_config_option`, e.g. model or permission mode). Same
    /// resolution and in-flight-turn caveats as [`Self::set_session_mode`].
    pub async fn set_session_config_option(
        &self,
        session_id: AgentSessionId,
        key: impl Into<String>,
        value: serde_json::Value,
    ) -> AgentResult<AgentSessionControlsSnapshot> {
        let connection_id = {
            let state = self.state.read().await;
            state
                .sessions
                .get(&session_id)
                .map(|session| session.snapshot.connection_id)
        };
        let Some(connection_id) = connection_id else {
            return Err(AgentError::SessionNotFound(session_id.to_string()));
        };
        let controls = self
            .connection_manager
            .set_session_config_option(connection_id, session_id, key, value)
            .await?;
        if let Some(session) = self.state.write().await.sessions.get_mut(&session_id) {
            session.controls = controls.clone();
        }
        Ok(controls)
    }

    pub async fn send_prompt(
        &self,
        input: SendAgentPromptInput,
    ) -> AgentResult<AgentPromptSnapshot> {
        if input.blocks.is_empty() {
            return Err(AgentError::Runtime(
                "prompt must include at least one content block".to_string(),
            ));
        }

        let now = Utc::now();
        let mut state = self.state.write().await;
        let workspace_id = state
            .connections
            .get(&input.connection_id)
            .map(|connection| connection.snapshot.workspace_id)
            .ok_or_else(|| AgentError::ConnectionNotFound(input.connection_id.to_string()))?;
        let prompt_id = AgentPromptId::new();
        let transition = {
            let session = state
                .sessions
                .get_mut(&input.session_id)
                .ok_or_else(|| AgentError::SessionNotFound(input.session_id.to_string()))?;
            if session.snapshot.connection_id != input.connection_id {
                return Err(AgentError::SessionNotFound(input.session_id.to_string()));
            }
            let transition = session.queue.submit(prompt_id);
            session.snapshot.active_prompt_id = session.queue.active();
            session.snapshot.queued_prompt_ids = session.queue.queued();
            session.snapshot.status = if session.snapshot.active_prompt_id.is_some() {
                AgentSessionStatus::Running
            } else {
                AgentSessionStatus::Ready
            };
            session.snapshot.updated_at = now;
            transition
        };
        let status = match transition {
            QueueTransition::Started { .. } => AgentPromptStatus::Running,
            QueueTransition::Queued { .. } => AgentPromptStatus::Queued,
            _ => AgentPromptStatus::Failed {
                message: "invalid prompt queue transition".to_string(),
            },
        };

        let SendAgentPromptInput {
            connection_id,
            session_id,
            blocks,
            mode_override,
            config_overrides,
        } = input;
        let prompt = AgentPromptSnapshot {
            id: prompt_id,
            session_id,
            status,
            text_preview: preview_text_from_blocks(&blocks),
            created_at: now,
            updated_at: now,
        };
        state.prompts.insert(prompt.id, prompt.clone());
        state.prompt_blocks.insert(prompt.id, blocks.clone());
        state.prompt_options.insert(
            prompt.id,
            PromptDispatchOptions {
                mode_override: mode_override.clone(),
                config_overrides: config_overrides.clone(),
            },
        );
        self.emit_locked(
            &mut state,
            workspace_id,
            connection_id,
            Some(session_id),
            AgentEvent::PromptStarted {
                snapshot: prompt.clone(),
            },
        );
        drop(state);

        if matches!(prompt.status, AgentPromptStatus::Running)
            && let Err(error) = self
                .connection_manager
                .send_prompt(
                    connection_id,
                    session_id,
                    prompt.id,
                    blocks,
                    mode_override,
                    config_overrides,
                )
                .await
        {
            let mut state = self.state.write().await;
            if let Some(prompt) = state.prompts.get_mut(&prompt.id) {
                prompt.status = AgentPromptStatus::Failed {
                    message: error.to_string(),
                };
                prompt.updated_at = Utc::now();
            }
            if let Some(connection) = state.connections.get_mut(&connection_id) {
                connection.snapshot.status = AgentConnectionStatus::Failed;
                connection.snapshot.status_message = Some(error.to_string());
                connection.snapshot.updated_at = Utc::now();
                let snapshot = connection.snapshot.clone();
                self.emit_locked(
                    &mut state,
                    snapshot.workspace_id,
                    snapshot.id,
                    None,
                    AgentEvent::ConnectionStatusChanged { snapshot },
                );
            }
            return Err(error);
        }

        Ok(prompt)
    }

    pub async fn cancel_prompt(&self, input: CancelAgentPromptInput) -> AgentResult<()> {
        let now = Utc::now();
        let mut state = self.state.write().await;
        let _workspace_id = state
            .connections
            .get(&input.connection_id)
            .map(|connection| connection.snapshot.workspace_id)
            .ok_or_else(|| AgentError::ConnectionNotFound(input.connection_id.to_string()))?;
        let transition = {
            let session = state
                .sessions
                .get_mut(&input.session_id)
                .ok_or_else(|| AgentError::SessionNotFound(input.session_id.to_string()))?;
            if session.snapshot.connection_id != input.connection_id {
                return Err(AgentError::SessionNotFound(input.session_id.to_string()));
            }
            let was_active = session.queue.active() == Some(input.prompt_id);
            let transition = session.queue.cancel(input.prompt_id);
            session.snapshot.active_prompt_id = session.queue.active();
            session.snapshot.queued_prompt_ids = session.queue.queued();
            session.snapshot.status = if session.snapshot.active_prompt_id.is_some() {
                AgentSessionStatus::Running
            } else {
                AgentSessionStatus::Ready
            };
            session.snapshot.updated_at = now;
            (transition, was_active)
        };

        let (transition, was_active) = transition;

        match transition {
            QueueTransition::Cancelled { .. } => {
                if let Some(prompt) = state.prompts.get_mut(&input.prompt_id) {
                    prompt.status = if was_active {
                        AgentPromptStatus::Cancelling
                    } else {
                        AgentPromptStatus::Completed {
                            stop_reason: Some("cancelled".to_string()),
                        }
                    };
                    prompt.updated_at = now;
                }
                if !was_active {
                    state.prompt_blocks.remove(&input.prompt_id);
                    state.prompt_options.remove(&input.prompt_id);
                }
                Self::emit_with_parts_locked(
                    &mut state,
                    &*self.event_sink,
                    &self.event_tx,
                    input.connection_id,
                    Some(input.session_id),
                    if was_active {
                        AgentEvent::RawAcpDiagnostic {
                            raw: serde_json::json!({
                                "kind": "prompt_cancel_requested",
                                "prompt_id": input.prompt_id,
                            }),
                        }
                    } else {
                        AgentEvent::PromptFinished {
                            finished: crate::AgentPromptFinished {
                                prompt_id: input.prompt_id,
                                stop_reason: Some("cancelled".to_string()),
                            },
                        }
                    },
                );
                drop(state);

                if was_active {
                    self.connection_manager
                        .cancel_prompt(input.connection_id, input.session_id, input.prompt_id)
                        .await?;
                }

                Ok(())
            }
            QueueTransition::Missing { .. } => {
                Err(AgentError::PromptNotFound(input.prompt_id.to_string()))
            }
            _ => Err(AgentError::Runtime(
                "invalid prompt cancel transition".to_string(),
            )),
        }
    }

    pub async fn respond_permission(&self, input: RespondAgentPermissionInput) -> AgentResult<()> {
        self.connection_manager
            .respond_permission(input.connection_id, input.permission_id, input.response)
            .await
    }

    pub async fn respond_elicitation(
        &self,
        input: RespondAgentElicitationInput,
    ) -> AgentResult<()> {
        self.connection_manager
            .respond_elicitation(input.connection_id, input.elicitation_id, input.response)
            .await
    }

    pub async fn disconnect(
        &self,
        connection_id: AgentConnectionId,
    ) -> AgentResult<AgentConnectionSnapshot> {
        self.connection_manager.disconnect(connection_id).await?;

        let mut state = self.state.write().await;
        let snapshot = state
            .connections
            .get_mut(&connection_id)
            .map(|connection| {
                connection.snapshot.status = AgentConnectionStatus::Disconnected;
                connection.snapshot.updated_at = Utc::now();
                connection.snapshot.clone()
            })
            .ok_or_else(|| AgentError::ConnectionNotFound(connection_id.to_string()))?;

        self.emit_locked(
            &mut state,
            snapshot.workspace_id,
            snapshot.id,
            None,
            AgentEvent::ConnectionStatusChanged {
                snapshot: snapshot.clone(),
            },
        );

        Ok(snapshot)
    }

    fn emit_locked(
        &self,
        state: &mut RuntimeState,
        _workspace_id: Uuid,
        connection_id: AgentConnectionId,
        session_id: Option<AgentSessionId>,
        event: AgentEvent,
    ) {
        Self::emit_with_parts_locked(
            state,
            &*self.event_sink,
            &self.event_tx,
            connection_id,
            session_id,
            event,
        );
    }

    fn emit_with_parts_locked(
        state: &mut RuntimeState,
        event_sink: &dyn RuntimeEventSink,
        event_tx: &broadcast::Sender<AgentEventEnvelope>,
        connection_id: AgentConnectionId,
        session_id: Option<AgentSessionId>,
        event: AgentEvent,
    ) {
        let workspace_id = state
            .connections
            .get(&connection_id)
            .map(|connection| connection.snapshot.workspace_id)
            .unwrap_or_else(Uuid::nil);
        state.sequence += 1;
        let envelope = AgentEventEnvelope {
            sequence: state.sequence,
            workspace_id,
            connection_id,
            session_id,
            event,
            created_at: Utc::now(),
        };
        state.recent_events.push_back(envelope.clone());
        while state.recent_events.len() > MAX_RECENT_EVENTS {
            state.recent_events.pop_front();
        }
        event_sink.emit(envelope.clone());
        let _ = event_tx.send(envelope);
    }

    fn apply_manager_event_locked(
        state: &mut RuntimeState,
        manager_event: &AgentConnectionManagerEvent,
    ) {
        match &manager_event.event {
            AgentEvent::ConnectionStatusChanged { snapshot } => {
                if let Some(connection) = state.connections.get_mut(&snapshot.id) {
                    connection.snapshot = snapshot.clone();
                }
            }
            AgentEvent::PromptFinished { finished } => {
                if let Some(prompt) = state.prompts.get_mut(&finished.prompt_id) {
                    prompt.status = AgentPromptStatus::Completed {
                        stop_reason: finished.stop_reason.clone(),
                    };
                    prompt.updated_at = Utc::now();
                }
                if let Some(session_id) = manager_event.session_id
                    && let Some(session) = state.sessions.get_mut(&session_id)
                {
                    let _ = session.queue.complete(finished.prompt_id);
                    session.snapshot.active_prompt_id = session.queue.active();
                    session.snapshot.queued_prompt_ids = session.queue.queued();
                    session.snapshot.status = if session.snapshot.active_prompt_id.is_some() {
                        AgentSessionStatus::Running
                    } else {
                        AgentSessionStatus::Ready
                    };
                    session.snapshot.updated_at = Utc::now();
                    if let Some(next_prompt_id) = session.snapshot.active_prompt_id
                        && let Some(next_prompt) = state.prompts.get_mut(&next_prompt_id)
                    {
                        next_prompt.status = AgentPromptStatus::Running;
                        next_prompt.updated_at = Utc::now();
                    }
                }
                state.prompt_blocks.remove(&finished.prompt_id);
                state.prompt_options.remove(&finished.prompt_id);
            }
            AgentEvent::Error { error } => {
                if let (Some(session_id), Some(prompt_id)) =
                    (manager_event.session_id, manager_event.prompt_id)
                {
                    fail_prompt_locked(state, session_id, prompt_id, error.message.clone());
                } else {
                    fail_connection_sessions_locked(
                        state,
                        manager_event.connection_id,
                        error.message.clone(),
                    );
                }
            }
            _ => {}
        }
    }
}

fn active_permissions_from_events(
    events: &VecDeque<AgentEventEnvelope>,
) -> Vec<AgentPermissionRequest> {
    let mut pending = HashMap::<AgentPermissionId, AgentPermissionRequest>::new();

    for envelope in events {
        match &envelope.event {
            AgentEvent::PermissionRequested { request } => {
                pending.insert(request.id, request.clone());
            }
            AgentEvent::PermissionResponded { permission_id, .. } => {
                pending.remove(permission_id);
            }
            _ => {}
        }
    }

    pending.into_values().collect()
}

fn fail_prompt_locked(
    state: &mut RuntimeState,
    session_id: AgentSessionId,
    prompt_id: AgentPromptId,
    message: String,
) {
    let now = Utc::now();
    if let Some(prompt) = state.prompts.get_mut(&prompt_id) {
        prompt.status = AgentPromptStatus::Failed {
            message: message.clone(),
        };
        prompt.updated_at = now;
    }

    if let Some(session) = state.sessions.get_mut(&session_id) {
        let _ = session.queue.complete(prompt_id);
        session.snapshot.active_prompt_id = session.queue.active();
        session.snapshot.queued_prompt_ids = session.queue.queued();
        session.snapshot.status = if session.snapshot.active_prompt_id.is_some() {
            AgentSessionStatus::Running
        } else {
            AgentSessionStatus::Ready
        };
        session.snapshot.updated_at = now;

        if let Some(next_prompt_id) = session.snapshot.active_prompt_id
            && let Some(next_prompt) = state.prompts.get_mut(&next_prompt_id)
        {
            next_prompt.status = AgentPromptStatus::Running;
            next_prompt.updated_at = now;
        }
    }

    state.prompt_blocks.remove(&prompt_id);
    state.prompt_options.remove(&prompt_id);
}

fn fail_connection_sessions_locked(
    state: &mut RuntimeState,
    connection_id: AgentConnectionId,
    message: String,
) {
    let now = Utc::now();
    let session_ids = state
        .sessions
        .iter()
        .filter_map(|(session_id, session)| {
            (session.snapshot.connection_id == connection_id).then_some(*session_id)
        })
        .collect::<Vec<_>>();

    for session_id in session_ids {
        if let Some(session) = state.sessions.get_mut(&session_id) {
            let mut affected_prompt_ids = Vec::new();
            if let Some(active) = session.queue.active() {
                affected_prompt_ids.push(active);
            }
            affected_prompt_ids.extend(session.queue.queued());

            while let Some(active) = session.queue.active() {
                let _ = session.queue.complete(active);
            }

            session.snapshot.active_prompt_id = None;
            session.snapshot.queued_prompt_ids.clear();
            session.snapshot.status = AgentSessionStatus::Failed;
            session.snapshot.updated_at = now;

            for prompt_id in affected_prompt_ids {
                if let Some(prompt) = state.prompts.get_mut(&prompt_id) {
                    prompt.status = AgentPromptStatus::Failed {
                        message: message.clone(),
                    };
                    prompt.updated_at = now;
                }
                state.prompt_blocks.remove(&prompt_id);
                state.prompt_options.remove(&prompt_id);
            }
        }
    }
}

fn preview_text(text: &str) -> String {
    const MAX_PREVIEW_CHARS: usize = 240;
    let trimmed = text.trim();
    let mut preview = trimmed.chars().take(MAX_PREVIEW_CHARS).collect::<String>();
    if trimmed.chars().count() > MAX_PREVIEW_CHARS {
        preview.push_str("...");
    }
    preview
}

fn preview_text_from_blocks(blocks: &[AgentContentBlock]) -> String {
    let text = blocks
        .iter()
        .find_map(|block| match block {
            AgentContentBlock::Text { text } if !text.trim().is_empty() => Some(text.as_str()),
            _ => None,
        })
        .unwrap_or_else(|| {
            if blocks
                .iter()
                .any(|block| matches!(block, AgentContentBlock::Image { .. }))
            {
                "[image]"
            } else {
                ""
            }
        });

    preview_text(text)
}

fn is_connection_loss_during_session_preparation(error: &AgentError) -> bool {
    match error {
        AgentError::ConnectionNotFound(_) => true,
        AgentError::Runtime(message) => matches!(
            message.as_str(),
            "agent connection closed before ACP session preparation completed"
                | "agent connection command channel closed"
        ),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, sync::Mutex, time::Duration};

    use super::*;
    use crate::{
        AgentConnectionCommand, AgentErrorEvent, AgentPermissionOption, AgentPermissionOptionKind,
        AgentPromptFinished,
    };

    struct RecordingSink {
        events: Mutex<Vec<AgentEventEnvelope>>,
    }

    impl RuntimeEventSink for RecordingSink {
        fn emit(&self, envelope: AgentEventEnvelope) {
            self.events.lock().unwrap().push(envelope);
        }
    }

    fn test_launch_lock() -> SessionLaunchLock {
        SessionLaunchLock {
            agent_id: AgentId::parse("codex").unwrap(),
            absolute_acp_program: PathBuf::from("/tmp/vibex-test-acp"),
            args: Vec::new(),
            env: BTreeMap::new(),
            runtime_version: "test-runtime".to_string(),
            acp_version: "test-acp".to_string(),
        }
    }

    #[tokio::test]
    async fn runtime_creates_connection_session_prompt() {
        let sink = Arc::new(RecordingSink {
            events: Mutex::new(Vec::new()),
        });
        let runtime = AgentRuntime::new_with_driver(sink.clone(), false);

        let connection = runtime
            .connect(ConnectAgentInput {
                agent_id: AgentId::parse("codex").unwrap(),
                launch_lock: test_launch_lock(),
                workspace_id: Uuid::new_v4(),
                working_dir: PathBuf::from("C:/work"),
                auto_approve_mode: AgentAutoApproveMode::Off,
                env: HashMap::new(),
            })
            .await
            .unwrap();
        let session = runtime
            .new_session(connection.id, "acp-session")
            .await
            .unwrap();
        let prompt = runtime
            .send_prompt(SendAgentPromptInput {
                connection_id: connection.id,
                session_id: session.id,
                blocks: vec![AgentContentBlock::Text {
                    text: "hello".to_string(),
                }],
                mode_override: None,
                config_overrides: Vec::new(),
            })
            .await
            .unwrap();

        assert!(matches!(prompt.status, AgentPromptStatus::Running));
        let snapshot = runtime.snapshot().await;
        assert_eq!(snapshot.connections.len(), 1);
        assert_eq!(snapshot.sessions.len(), 1);
        assert_eq!(snapshot.prompts.len(), 1);
        assert!(sink.events.lock().unwrap().len() >= 4);
    }

    #[tokio::test]
    async fn runtime_cancels_active_prompt_and_advances_queue() {
        let runtime = AgentRuntime::new_with_driver(Arc::new(NoopEventSink), false);
        let connection = runtime
            .connect(ConnectAgentInput {
                agent_id: AgentId::parse("codex").unwrap(),
                launch_lock: test_launch_lock(),
                workspace_id: Uuid::new_v4(),
                working_dir: PathBuf::from("C:/work"),
                auto_approve_mode: AgentAutoApproveMode::Off,
                env: HashMap::new(),
            })
            .await
            .unwrap();
        let session = runtime
            .new_session(connection.id, "acp-session")
            .await
            .unwrap();
        let first = runtime
            .send_prompt(SendAgentPromptInput {
                connection_id: connection.id,
                session_id: session.id,
                blocks: vec![AgentContentBlock::Text {
                    text: "first".to_string(),
                }],
                mode_override: None,
                config_overrides: Vec::new(),
            })
            .await
            .unwrap();
        let second = runtime
            .send_prompt(SendAgentPromptInput {
                connection_id: connection.id,
                session_id: session.id,
                blocks: vec![AgentContentBlock::Text {
                    text: "second".to_string(),
                }],
                mode_override: None,
                config_overrides: Vec::new(),
            })
            .await
            .unwrap();

        assert!(matches!(second.status, AgentPromptStatus::Queued));
        runtime
            .cancel_prompt(CancelAgentPromptInput {
                connection_id: connection.id,
                session_id: session.id,
                prompt_id: first.id,
            })
            .await
            .unwrap();
        tokio::task::yield_now().await;

        let snapshot = runtime.snapshot().await;
        let session = snapshot
            .sessions
            .iter()
            .find(|candidate| candidate.id == session.id)
            .unwrap();
        assert_eq!(session.active_prompt_id, Some(second.id));
        assert!(session.queued_prompt_ids.is_empty());
    }

    #[tokio::test]
    async fn runtime_disconnects_connection_and_emits_snapshot() {
        let sink = Arc::new(RecordingSink {
            events: Mutex::new(Vec::new()),
        });
        let runtime = AgentRuntime::new_with_driver(sink.clone(), false);
        let connection = runtime
            .connect(ConnectAgentInput {
                agent_id: AgentId::parse("codex").unwrap(),
                launch_lock: test_launch_lock(),
                workspace_id: Uuid::new_v4(),
                working_dir: PathBuf::from("C:/work"),
                auto_approve_mode: AgentAutoApproveMode::Off,
                env: HashMap::new(),
            })
            .await
            .unwrap();

        let disconnected = runtime.disconnect(connection.id).await.unwrap();

        assert_eq!(disconnected.status, AgentConnectionStatus::Disconnected);
        let snapshot = runtime.snapshot().await;
        assert_eq!(
            snapshot
                .connections
                .iter()
                .find(|candidate| candidate.id == connection.id)
                .unwrap()
                .status,
            AgentConnectionStatus::Disconnected
        );
        assert!(sink.events.lock().unwrap().iter().any(|event| {
            matches!(
                event.event,
                AgentEvent::ConnectionStatusChanged { ref snapshot }
                    if snapshot.status == AgentConnectionStatus::Disconnected
            )
        }));
    }

    #[tokio::test]
    async fn snapshot_includes_active_permissions_from_recent_events() {
        let runtime = AgentRuntime::new_with_driver(Arc::new(NoopEventSink), false);
        let connection = runtime
            .connect(ConnectAgentInput {
                agent_id: AgentId::parse("codex").unwrap(),
                launch_lock: test_launch_lock(),
                workspace_id: Uuid::new_v4(),
                working_dir: PathBuf::from("C:/work"),
                auto_approve_mode: AgentAutoApproveMode::Off,
                env: HashMap::new(),
            })
            .await
            .unwrap();
        let session = runtime
            .new_session(connection.id, "acp-session")
            .await
            .unwrap();
        let request = AgentPermissionRequest {
            id: AgentPermissionId::new(),
            session_id: session.id,
            title: "Run command".to_string(),
            details: None,
            options: vec![AgentPermissionOption {
                id: "allow".to_string(),
                label: "Allow".to_string(),
                kind: AgentPermissionOptionKind::AllowOnce,
                description: None,
            }],
        };

        let mut state = runtime.state.write().await;
        runtime.emit_locked(
            &mut state,
            connection.workspace_id,
            connection.id,
            Some(session.id),
            AgentEvent::PermissionRequested {
                request: request.clone(),
            },
        );
        drop(state);

        let snapshot = runtime.snapshot().await;
        assert_eq!(snapshot.permissions, vec![request]);
    }

    #[tokio::test]
    async fn no_response_regressions_message_output_remains_visible() {
        let sink = Arc::new(RecordingSink {
            events: Mutex::new(Vec::new()),
        });
        let runtime = AgentRuntime::new_with_driver(sink.clone(), false);
        let (_connection, _session, prompt) =
            create_running_prompt(&runtime, "visible fake ACP output").await;

        let event = wait_for_recorded_event(&sink, |envelope| {
            matches!(
                &envelope.event,
                AgentEvent::MessageChunk {
                    content: AgentContentBlock::Text { text }
                } if text == "visible fake ACP output"
            )
        })
        .await;

        assert_eq!(event.session_id, Some(prompt.session_id));
        tokio::time::sleep(Duration::from_millis(20)).await;
        let visible_chunks = sink
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|envelope| {
                matches!(
                    &envelope.event,
                    AgentEvent::MessageChunk {
                        content: AgentContentBlock::Text { text }
                    } if text == "visible fake ACP output"
                )
            })
            .count();
        assert_eq!(visible_chunks, 1);
    }

    #[tokio::test]
    async fn no_response_regressions_no_output_prompt_failure_is_terminal() {
        let runtime = AgentRuntime::new_with_driver(Arc::new(NoopEventSink), false);
        let (connection, session, active_prompt, queued_prompt) =
            create_running_prompt_pair(&runtime).await;
        let message = "session/prompt failed before producing output";

        emit_manager_error(
            &runtime,
            connection.id,
            Some(session.id),
            Some(active_prompt.id),
            message,
        )
        .await;

        let snapshot = runtime.snapshot().await;
        assert_prompt_failed(&snapshot, active_prompt.id, message);
        let queued = snapshot
            .prompts
            .iter()
            .find(|candidate| candidate.id == queued_prompt.id)
            .unwrap();
        assert!(matches!(queued.status, AgentPromptStatus::Running));
        let session = snapshot
            .sessions
            .iter()
            .find(|candidate| candidate.id == session.id)
            .unwrap();
        assert_eq!(session.status, AgentSessionStatus::Running);
        assert_eq!(session.active_prompt_id, Some(queued_prompt.id));
        assert!(session.queued_prompt_ids.is_empty());
    }

    #[tokio::test]
    async fn no_response_regressions_connection_failures_are_terminal() {
        for message in [
            "agent connection command channel closed",
            "ACP handshake timed out after 5s. No stderr captured.",
            "ACP child exited before producing output",
        ] {
            let runtime = AgentRuntime::new_with_driver(Arc::new(NoopEventSink), false);
            let (connection, session, active_prompt, queued_prompt) =
                create_running_prompt_pair(&runtime).await;
            let failed = AgentConnectionSnapshot {
                status: AgentConnectionStatus::Failed,
                status_message: Some(message.to_string()),
                updated_at: Utc::now(),
                ..connection.clone()
            };

            let mut state = runtime.state.write().await;
            AgentRuntime::apply_manager_event_locked(
                &mut state,
                &AgentConnectionManagerEvent {
                    connection_id: connection.id,
                    session_id: None,
                    prompt_id: None,
                    event: AgentEvent::ConnectionStatusChanged {
                        snapshot: failed.clone(),
                    },
                },
            );
            AgentRuntime::apply_manager_event_locked(
                &mut state,
                &AgentConnectionManagerEvent {
                    connection_id: connection.id,
                    session_id: None,
                    prompt_id: None,
                    event: AgentEvent::Error {
                        error: AgentErrorEvent {
                            message: message.to_string(),
                            code: None,
                            raw: None,
                        },
                    },
                },
            );
            drop(state);

            let snapshot = runtime.snapshot().await;
            let connection = snapshot
                .connections
                .iter()
                .find(|candidate| candidate.id == connection.id)
                .unwrap();
            assert_eq!(connection.status, AgentConnectionStatus::Failed);
            assert_eq!(connection.status_message.as_deref(), Some(message));
            let session = snapshot
                .sessions
                .iter()
                .find(|candidate| candidate.id == session.id)
                .unwrap();
            assert_eq!(session.status, AgentSessionStatus::Failed);
            assert_eq!(session.active_prompt_id, None);
            assert!(session.queued_prompt_ids.is_empty());
            assert_prompt_failed(&snapshot, active_prompt.id, message);
            assert_prompt_failed(&snapshot, queued_prompt.id, message);
        }
    }

    #[tokio::test]
    async fn manager_connection_failure_marks_sessions_and_prompts_failed() {
        let runtime = AgentRuntime::new_with_driver(Arc::new(NoopEventSink), false);
        let connection = runtime
            .connect(ConnectAgentInput {
                agent_id: AgentId::parse("codex").unwrap(),
                launch_lock: test_launch_lock(),
                workspace_id: Uuid::new_v4(),
                working_dir: PathBuf::from("C:/work"),
                auto_approve_mode: AgentAutoApproveMode::Off,
                env: HashMap::new(),
            })
            .await
            .unwrap();
        let session = runtime
            .new_session(connection.id, "acp-session")
            .await
            .unwrap();
        let active_prompt = runtime
            .send_prompt(SendAgentPromptInput {
                connection_id: connection.id,
                session_id: session.id,
                blocks: vec![AgentContentBlock::Text {
                    text: "active".to_string(),
                }],
                mode_override: None,
                config_overrides: Vec::new(),
            })
            .await
            .unwrap();
        let queued_prompt = runtime
            .send_prompt(SendAgentPromptInput {
                connection_id: connection.id,
                session_id: session.id,
                blocks: vec![AgentContentBlock::Text {
                    text: "queued".to_string(),
                }],
                mode_override: None,
                config_overrides: Vec::new(),
            })
            .await
            .unwrap();
        let message = "ACP child exited before handshake".to_string();
        let failed_snapshot = AgentConnectionSnapshot {
            status: AgentConnectionStatus::Failed,
            status_message: Some(message.clone()),
            updated_at: Utc::now(),
            ..connection
        };

        let mut state = runtime.state.write().await;
        AgentRuntime::apply_manager_event_locked(
            &mut state,
            &AgentConnectionManagerEvent {
                connection_id: failed_snapshot.id,
                session_id: None,
                prompt_id: None,
                event: AgentEvent::ConnectionStatusChanged {
                    snapshot: failed_snapshot.clone(),
                },
            },
        );
        AgentRuntime::apply_manager_event_locked(
            &mut state,
            &AgentConnectionManagerEvent {
                connection_id: failed_snapshot.id,
                session_id: None,
                prompt_id: None,
                event: AgentEvent::Error {
                    error: AgentErrorEvent {
                        message: message.clone(),
                        code: None,
                        raw: None,
                    },
                },
            },
        );
        drop(state);

        let snapshot = runtime.snapshot().await;
        let connection_snapshot = snapshot
            .connections
            .iter()
            .find(|candidate| candidate.id == failed_snapshot.id)
            .unwrap();
        assert_eq!(connection_snapshot.status, AgentConnectionStatus::Failed);
        assert_eq!(
            connection_snapshot.status_message.as_deref(),
            Some(message.as_str())
        );

        let session_snapshot = snapshot
            .sessions
            .iter()
            .find(|candidate| candidate.id == session.id)
            .unwrap();
        assert_eq!(session_snapshot.status, AgentSessionStatus::Failed);
        assert_eq!(session_snapshot.active_prompt_id, None);
        assert!(session_snapshot.queued_prompt_ids.is_empty());

        for prompt_id in [active_prompt.id, queued_prompt.id] {
            let prompt = snapshot
                .prompts
                .iter()
                .find(|candidate| candidate.id == prompt_id)
                .unwrap();
            assert!(matches!(
                prompt.status,
                AgentPromptStatus::Failed { ref message } if message == "ACP child exited before handshake"
            ));
        }
    }

    #[tokio::test]
    async fn manager_prompt_error_fails_prompt_and_advances_queue() {
        let runtime = AgentRuntime::new_with_driver(Arc::new(NoopEventSink), false);
        let connection = runtime
            .connect(ConnectAgentInput {
                agent_id: AgentId::parse("codex").unwrap(),
                launch_lock: test_launch_lock(),
                workspace_id: Uuid::new_v4(),
                working_dir: PathBuf::from("C:/work"),
                auto_approve_mode: AgentAutoApproveMode::Off,
                env: HashMap::new(),
            })
            .await
            .unwrap();
        let session = runtime
            .new_session(connection.id, "acp-session")
            .await
            .unwrap();
        let active_prompt = runtime
            .send_prompt(SendAgentPromptInput {
                connection_id: connection.id,
                session_id: session.id,
                blocks: vec![AgentContentBlock::Text {
                    text: "active".to_string(),
                }],
                mode_override: None,
                config_overrides: Vec::new(),
            })
            .await
            .unwrap();
        let queued_prompt = runtime
            .send_prompt(SendAgentPromptInput {
                connection_id: connection.id,
                session_id: session.id,
                blocks: vec![AgentContentBlock::Text {
                    text: "queued".to_string(),
                }],
                mode_override: None,
                config_overrides: Vec::new(),
            })
            .await
            .unwrap();

        let mut state = runtime.state.write().await;
        AgentRuntime::apply_manager_event_locked(
            &mut state,
            &AgentConnectionManagerEvent {
                connection_id: connection.id,
                session_id: Some(session.id),
                prompt_id: Some(active_prompt.id),
                event: AgentEvent::Error {
                    error: AgentErrorEvent {
                        message: "internal error".to_string(),
                        code: None,
                        raw: None,
                    },
                },
            },
        );
        drop(state);

        let snapshot = runtime.snapshot().await;
        let failed_prompt = snapshot
            .prompts
            .iter()
            .find(|candidate| candidate.id == active_prompt.id)
            .unwrap();
        assert!(matches!(
            failed_prompt.status,
            AgentPromptStatus::Failed { ref message } if message == "internal error"
        ));

        let session_snapshot = snapshot
            .sessions
            .iter()
            .find(|candidate| candidate.id == session.id)
            .unwrap();
        assert_eq!(session_snapshot.active_prompt_id, Some(queued_prompt.id));
        assert_eq!(session_snapshot.status, AgentSessionStatus::Running);
        assert!(session_snapshot.queued_prompt_ids.is_empty());
    }

    #[tokio::test]
    async fn manager_pump_dispatches_next_prompt_only_after_active_terminal_event() {
        let runtime = AgentRuntime::new_with_driver(Arc::new(NoopEventSink), false);
        let (connection, session, active_prompt, queued_prompt) =
            create_running_prompt_pair(&runtime).await;

        let mut state = runtime.state.write().await;
        let chunk_event = AgentConnectionManagerEvent {
            connection_id: connection.id,
            session_id: Some(session.id),
            prompt_id: None,
            event: AgentEvent::MessageChunk {
                content: AgentContentBlock::Text {
                    text: "streaming".to_string(),
                },
            },
        };
        let active_before =
            AgentRuntime::active_prompt_for_manager_event_locked(&state, &chunk_event);
        AgentRuntime::apply_manager_event_locked(&mut state, &chunk_event);
        assert!(
            AgentRuntime::prompt_to_dispatch_after_manager_event_locked(
                &state,
                &chunk_event,
                active_before
            )
            .is_none()
        );

        let finished_event = AgentConnectionManagerEvent {
            connection_id: connection.id,
            session_id: Some(session.id),
            prompt_id: Some(active_prompt.id),
            event: AgentEvent::PromptFinished {
                finished: AgentPromptFinished {
                    prompt_id: active_prompt.id,
                    stop_reason: Some("end_turn".to_string()),
                },
            },
        };
        let active_before =
            AgentRuntime::active_prompt_for_manager_event_locked(&state, &finished_event);
        AgentRuntime::apply_manager_event_locked(&mut state, &finished_event);
        let next_prompt = AgentRuntime::prompt_to_dispatch_after_manager_event_locked(
            &state,
            &finished_event,
            active_before,
        )
        .expect("active terminal event should dispatch the queued prompt");

        assert_eq!(next_prompt.0, session.id);
        assert_eq!(next_prompt.1, queued_prompt.id);
        assert_eq!(
            next_prompt.2,
            vec![AgentContentBlock::Text {
                text: "queued prompt".to_string(),
            }]
        );
    }

    #[tokio::test]
    async fn ensure_session_rebinds_existing_session_after_connection_disconnect() {
        let runtime = AgentRuntime::new_with_driver(Arc::new(NoopEventSink), false);
        let workspace_id = Uuid::new_v4();
        let working_dir = PathBuf::from("C:/work");
        let connection = runtime
            .connect(ConnectAgentInput {
                agent_id: AgentId::parse("codex").unwrap(),
                launch_lock: test_launch_lock(),
                workspace_id,
                working_dir: working_dir.clone(),
                auto_approve_mode: AgentAutoApproveMode::Off,
                env: HashMap::new(),
            })
            .await
            .unwrap();
        let session = runtime
            .new_session(connection.id, "acp-session")
            .await
            .unwrap();

        runtime.disconnect(connection.id).await.unwrap();
        let rebound = runtime
            .ensure_session(EnsureAgentSessionInput {
                agent_id: AgentId::parse("codex").unwrap(),
                launch_lock: test_launch_lock(),
                workspace_id,
                working_dir,
                session_id: session.id,
                acp_session_id: session.acp_session_id.clone(),
                auto_approve_mode: AgentAutoApproveMode::Off,
                env: HashMap::new(),
            })
            .await
            .unwrap();

        assert_ne!(rebound.connection_id, connection.id);
        let prompt = runtime
            .send_prompt(SendAgentPromptInput {
                connection_id: rebound.connection_id,
                session_id: rebound.id,
                blocks: vec![AgentContentBlock::Text {
                    text: "after reconnect".to_string(),
                }],
                mode_override: None,
                config_overrides: Vec::new(),
            })
            .await
            .unwrap();
        assert!(matches!(prompt.status, AgentPromptStatus::Running));
    }

    #[tokio::test]
    async fn prepared_session_is_reused_on_commit_and_discarded_before_commit() {
        let runtime = AgentRuntime::new_with_driver(Arc::new(NoopEventSink), false);
        let workspace_id = Uuid::new_v4();
        let working_dir = PathBuf::from("C:/prepared-work");

        let prepare = |session_id| EnsureAgentSessionInput {
            agent_id: AgentId::parse("codex").unwrap(),
            launch_lock: test_launch_lock(),
            workspace_id,
            working_dir: working_dir.clone(),
            session_id,
            acp_session_id: format!("pending-{session_id}"),
            auto_approve_mode: AgentAutoApproveMode::Off,
            env: HashMap::new(),
        };

        let discarded_id = AgentSessionId::new();
        let discarded = runtime
            .prepare_session(prepare(discarded_id))
            .await
            .unwrap();
        assert!(discarded.session.acp_session_id.starts_with("prepared-"));
        runtime
            .discard_prepared_session(discarded_id)
            .await
            .unwrap();
        assert!(
            runtime
                .snapshot()
                .await
                .sessions
                .iter()
                .all(|session| session.id != discarded_id)
        );

        let committed_id = AgentSessionId::new();
        let committed = runtime
            .prepare_session(prepare(committed_id))
            .await
            .unwrap();
        runtime
            .claim_prepared_session(committed_id, workspace_id, AgentId::parse("codex").unwrap())
            .await
            .unwrap();
        runtime
            .discard_prepared_session(committed_id)
            .await
            .unwrap();
        runtime.commit_prepared_session(committed_id).await;
        runtime
            .discard_prepared_session(committed_id)
            .await
            .unwrap();
        let stored = runtime
            .snapshot()
            .await
            .sessions
            .into_iter()
            .find(|session| session.id == committed_id)
            .expect("committed prepared session must survive form cleanup");
        assert_eq!(stored.acp_session_id, committed.session.acp_session_id);

        // Reclaiming is idempotent so a failed database write can retry.
        let raced_id = AgentSessionId::new();
        runtime.prepare_session(prepare(raced_id)).await.unwrap();
        runtime
            .claim_prepared_session(raced_id, workspace_id, AgentId::parse("codex").unwrap())
            .await
            .unwrap();
        runtime
            .claim_prepared_session(raced_id, workspace_id, AgentId::parse("codex").unwrap())
            .await
            .unwrap();
        runtime.discard_prepared_session(raced_id).await.unwrap();
        assert!(
            runtime
                .snapshot()
                .await
                .sessions
                .iter()
                .any(|session| session.id == raced_id),
            "a validated prepared session must survive concurrent form cleanup"
        );
    }

    #[tokio::test]
    async fn prepare_session_reconnects_when_connection_closes_before_reply() {
        let runtime = AgentRuntime::new_with_driver(Arc::new(NoopEventSink), false);
        let workspace_id = Uuid::new_v4();
        let session_id = AgentSessionId::new();
        let input = EnsureAgentSessionInput {
            agent_id: AgentId::parse("codex").unwrap(),
            launch_lock: test_launch_lock(),
            workspace_id,
            working_dir: PathBuf::from("C:/prepared-reconnect"),
            session_id,
            acp_session_id: format!("pending-{session_id}"),
            auto_approve_mode: AgentAutoApproveMode::Off,
            env: HashMap::new(),
        };
        let initial = runtime.ensure_session(input.clone()).await.unwrap();
        let failed_connection_id = initial.connection_id;
        runtime.state.write().await.sessions.remove(&session_id);

        // Model an ACP process that accepts PrepareSession and then exits while
        // session/new is in flight. The command send succeeds, but its reply
        // channel closes exactly like the production failure reported by the UI.
        let (closing_tx, mut closing_rx) = mpsc::channel(1);
        runtime
            .connection_manager
            .replace_command_sender(failed_connection_id, closing_tx)
            .await;
        tokio::spawn(async move {
            if let Some(AgentConnectionCommand::PrepareSession { result_tx, .. }) =
                closing_rx.recv().await
            {
                drop(result_tx);
            }
        });

        let recovered = runtime
            .prepare_session(input)
            .await
            .expect("preparation should retry on a fresh ACP connection");

        assert_ne!(recovered.session.connection_id, failed_connection_id);
        assert!(recovered.session.acp_session_id.starts_with("prepared-"));
        assert_eq!(runtime.connection_manager.list_connections().await.len(), 1);
        assert_eq!(
            runtime
                .state
                .read()
                .await
                .sessions
                .get(&session_id)
                .expect("recovered draft session")
                .ownership,
            RuntimeSessionOwnership::Prepared
        );
    }

    #[tokio::test]
    async fn committing_prepared_session_republishes_controls_for_the_conversation() {
        let runtime = AgentRuntime::new_with_driver(Arc::new(NoopEventSink), false);
        let workspace_id = Uuid::new_v4();
        let session_id = AgentSessionId::new();
        runtime
            .prepare_session(EnsureAgentSessionInput {
                agent_id: AgentId::parse("codex").unwrap(),
                launch_lock: test_launch_lock(),
                workspace_id,
                working_dir: PathBuf::from("C:/prepared-controls"),
                session_id,
                acp_session_id: format!("pending-{session_id}"),
                auto_approve_mode: AgentAutoApproveMode::Off,
                env: HashMap::new(),
            })
            .await
            .unwrap();
        let expected_options = vec![crate::AgentSessionConfigOption {
            key: "mode".to_string(),
            label: "Mode".to_string(),
            description: Some("Approval and sandboxing preset".to_string()),
            category: Some("mode".to_string()),
            value: Some(serde_json::json!("agent-full-access")),
            choices: vec![
                crate::AgentSessionConfigChoice {
                    value: serde_json::json!("agent"),
                    label: "Agent".to_string(),
                    description: None,
                },
                crate::AgentSessionConfigChoice {
                    value: serde_json::json!("agent-full-access"),
                    label: "Agent (full access)".to_string(),
                    description: None,
                },
            ],
            dependency: None,
        }];
        runtime
            .state
            .write()
            .await
            .sessions
            .get_mut(&session_id)
            .expect("prepared session")
            .controls
            .config_options = expected_options.clone();
        runtime
            .claim_prepared_session(session_id, workspace_id, AgentId::parse("codex").unwrap())
            .await
            .unwrap();

        // Conversation persistence happens between claim and commit. Only
        // events emitted after this subscription can be projected into the
        // newly-created conversation.
        let mut events = runtime.subscribe_events();
        runtime.commit_prepared_session(session_id).await;

        let modes = tokio::time::timeout(Duration::from_millis(100), events.recv())
            .await
            .expect("commit must republish controls after conversation persistence")
            .expect("runtime event channel must stay open");
        assert_eq!(modes.session_id, Some(session_id));
        assert!(matches!(modes.event, AgentEvent::SessionModes { .. }));

        let options = tokio::time::timeout(Duration::from_millis(100), events.recv())
            .await
            .expect("commit must republish config options")
            .expect("runtime event channel must stay open");
        assert_eq!(options.session_id, Some(session_id));
        assert_eq!(
            options.event,
            AgentEvent::SessionConfigOptions {
                options: expected_options
            }
        );
    }

    #[tokio::test]
    async fn concurrent_ensure_session_reuses_single_connection_and_session() {
        let runtime = Arc::new(AgentRuntime::new_with_driver(
            Arc::new(NoopEventSink),
            false,
        ));
        let workspace_id = Uuid::new_v4();
        let session_id = AgentSessionId::new();
        let barrier = Arc::new(tokio::sync::Barrier::new(8));
        let mut tasks = Vec::new();

        for _ in 0..8 {
            let runtime = Arc::clone(&runtime);
            let barrier = Arc::clone(&barrier);
            tasks.push(tokio::spawn(async move {
                barrier.wait().await;
                runtime
                    .ensure_session(EnsureAgentSessionInput {
                        agent_id: AgentId::parse("codex").unwrap(),
                        launch_lock: test_launch_lock(),
                        workspace_id,
                        working_dir: PathBuf::from("C:/work"),
                        session_id,
                        acp_session_id: "shared-acp-session".to_string(),
                        auto_approve_mode: AgentAutoApproveMode::Off,
                        env: HashMap::new(),
                    })
                    .await
                    .unwrap()
            }));
        }

        let mut connection_ids = Vec::new();
        for task in tasks {
            connection_ids.push(task.await.unwrap().connection_id);
        }
        connection_ids.sort_by_key(|id| id.to_string());
        connection_ids.dedup();

        let snapshot = runtime.snapshot().await;
        assert_eq!(connection_ids.len(), 1);
        assert_eq!(snapshot.connections.len(), 1);
        assert_eq!(snapshot.sessions.len(), 1);
        assert_eq!(snapshot.sessions[0].id, session_id);
    }

    #[tokio::test]
    async fn resume_session_updates_snapshot_with_external_session_id() {
        let runtime = AgentRuntime::new_with_driver(Arc::new(NoopEventSink), false);
        let workspace_id = Uuid::new_v4();
        let session_id = AgentSessionId::new();

        let resumed = runtime
            .resume_session(ResumeAgentSessionInput {
                agent_id: AgentId::parse("codex").unwrap(),
                launch_lock: test_launch_lock(),
                workspace_id,
                working_dir: PathBuf::from("C:/work"),
                session_id,
                external_session_id: "codex-session-123".to_string(),
                auto_approve_mode: AgentAutoApproveMode::Off,
                env: HashMap::new(),
            })
            .await
            .unwrap();

        assert_eq!(resumed.id, session_id);
        assert_eq!(resumed.acp_session_id, "codex-session-123");
        assert_eq!(resumed.status, AgentSessionStatus::Ready);
        assert_eq!(
            runtime
                .session_controls_snapshot(session_id)
                .await
                .expect("resumed session retains its controls"),
            AgentSessionControlsSnapshot {
                modes: Vec::new(),
                current_mode: None,
                config_options: Vec::new(),
            }
        );
    }

    #[tokio::test]
    async fn acp_session_identity_keeps_local_and_external_ids_distinct() {
        let runtime = AgentRuntime::new_with_driver(Arc::new(NoopEventSink), false);
        let workspace_id = Uuid::new_v4();
        let local_session_id = AgentSessionId::new();

        let session = runtime
            .ensure_session(EnsureAgentSessionInput {
                agent_id: AgentId::parse("codex").unwrap(),
                launch_lock: test_launch_lock(),
                workspace_id,
                working_dir: PathBuf::from("C:/work"),
                session_id: local_session_id,
                acp_session_id: "external-acp-session".to_string(),
                auto_approve_mode: AgentAutoApproveMode::Off,
                env: HashMap::new(),
            })
            .await
            .unwrap();

        assert_eq!(session.id, local_session_id);
        assert_eq!(session.acp_session_id, "external-acp-session");
        assert_ne!(session.id.to_string(), session.acp_session_id);
    }

    #[tokio::test]
    async fn failed_prompt_emits_terminal_event_contract() {
        let runtime = AgentRuntime::new_with_driver(Arc::new(NoopEventSink), false);
        let connection = runtime
            .connect(ConnectAgentInput {
                agent_id: AgentId::parse("codex").unwrap(),
                launch_lock: test_launch_lock(),
                workspace_id: Uuid::new_v4(),
                working_dir: PathBuf::from("C:/work"),
                auto_approve_mode: AgentAutoApproveMode::Off,
                env: HashMap::new(),
            })
            .await
            .unwrap();
        let session = runtime
            .new_session(connection.id, "acp-session")
            .await
            .unwrap();
        let prompt = runtime
            .send_prompt(SendAgentPromptInput {
                connection_id: connection.id,
                session_id: session.id,
                blocks: vec![AgentContentBlock::Text {
                    text: "hello".to_string(),
                }],
                mode_override: None,
                config_overrides: Vec::new(),
            })
            .await
            .unwrap();

        let mut state = runtime.state.write().await;
        AgentRuntime::apply_manager_event_locked(
            &mut state,
            &AgentConnectionManagerEvent {
                connection_id: connection.id,
                session_id: Some(session.id),
                prompt_id: Some(prompt.id),
                event: AgentEvent::Error {
                    error: AgentErrorEvent {
                        message: "prompt failed".to_string(),
                        code: None,
                        raw: None,
                    },
                },
            },
        );
        drop(state);

        let snapshot = runtime.snapshot().await;
        let prompt = snapshot
            .prompts
            .iter()
            .find(|candidate| candidate.id == prompt.id)
            .unwrap();
        assert!(matches!(
            prompt.status,
            AgentPromptStatus::Failed { ref message } if message == "prompt failed"
        ));
    }

    #[test]
    fn preview_text_is_bounded() {
        let long = "x".repeat(400);
        let preview = super::preview_text(&long);
        assert_eq!(preview.chars().count(), 243);
        assert!(preview.ends_with("..."));
    }

    async fn create_running_prompt(
        runtime: &AgentRuntime,
        text: &str,
    ) -> (
        AgentConnectionSnapshot,
        AgentSessionSnapshot,
        AgentPromptSnapshot,
    ) {
        let connection = runtime
            .connect(ConnectAgentInput {
                agent_id: AgentId::parse("codex").unwrap(),
                launch_lock: test_launch_lock(),
                workspace_id: Uuid::new_v4(),
                working_dir: PathBuf::from("C:/work"),
                auto_approve_mode: AgentAutoApproveMode::Off,
                env: HashMap::new(),
            })
            .await
            .unwrap();
        let session = runtime
            .new_session(connection.id, "acp-session")
            .await
            .unwrap();
        let prompt = runtime
            .send_prompt(SendAgentPromptInput {
                connection_id: connection.id,
                session_id: session.id,
                blocks: vec![AgentContentBlock::Text {
                    text: text.to_string(),
                }],
                mode_override: None,
                config_overrides: Vec::new(),
            })
            .await
            .unwrap();

        (connection, session, prompt)
    }

    async fn create_running_prompt_pair(
        runtime: &AgentRuntime,
    ) -> (
        AgentConnectionSnapshot,
        AgentSessionSnapshot,
        AgentPromptSnapshot,
        AgentPromptSnapshot,
    ) {
        let (connection, session, active_prompt) =
            create_running_prompt(runtime, "active prompt").await;
        let queued_prompt = runtime
            .send_prompt(SendAgentPromptInput {
                connection_id: connection.id,
                session_id: session.id,
                blocks: vec![AgentContentBlock::Text {
                    text: "queued prompt".to_string(),
                }],
                mode_override: None,
                config_overrides: Vec::new(),
            })
            .await
            .unwrap();

        assert!(matches!(active_prompt.status, AgentPromptStatus::Running));
        assert!(matches!(queued_prompt.status, AgentPromptStatus::Queued));

        (connection, session, active_prompt, queued_prompt)
    }

    async fn emit_manager_error(
        runtime: &AgentRuntime,
        connection_id: AgentConnectionId,
        session_id: Option<AgentSessionId>,
        prompt_id: Option<AgentPromptId>,
        message: &str,
    ) {
        let mut state = runtime.state.write().await;
        AgentRuntime::apply_manager_event_locked(
            &mut state,
            &AgentConnectionManagerEvent {
                connection_id,
                session_id,
                prompt_id,
                event: AgentEvent::Error {
                    error: AgentErrorEvent {
                        message: message.to_string(),
                        code: None,
                        raw: None,
                    },
                },
            },
        );
    }

    fn assert_prompt_failed(
        snapshot: &RuntimeSnapshot,
        prompt_id: AgentPromptId,
        expected_message: &str,
    ) {
        let prompt = snapshot
            .prompts
            .iter()
            .find(|candidate| candidate.id == prompt_id)
            .unwrap();
        assert!(matches!(
            prompt.status,
            AgentPromptStatus::Failed { ref message } if message == expected_message
        ));
    }

    async fn wait_for_recorded_event(
        sink: &RecordingSink,
        predicate: impl Fn(&AgentEventEnvelope) -> bool,
    ) -> AgentEventEnvelope {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
        loop {
            if let Some(event) = sink
                .events
                .lock()
                .unwrap()
                .iter()
                .find(|event| predicate(event))
                .cloned()
            {
                return event;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "timed out waiting for recorded runtime event"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}
