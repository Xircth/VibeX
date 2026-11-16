use std::{
    collections::{BTreeMap, HashMap, HashSet},
    future::Future,
    path::{Path, PathBuf},
    process::ExitStatus,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use agent_client_protocol as acp;
use agent_client_protocol::{
    Agent, ConnectionTo, JsonRpcRequest, JsonRpcResponse,
    schema::{
        ProtocolVersion,
        v1::{
            AgentNotification, AgentRequest, AvailableCommand as AcpAvailableCommand,
            CancelNotification, ClientResponse, CloseSessionRequest, ContentBlock,
            CreateElicitationRequest, CreateElicitationResponse, CreateTerminalResponse,
            DeleteSessionRequest, ElicitationAcceptAction, ElicitationAction,
            ElicitationContentValue, ElicitationMode, ElicitationScope, ExtRequest, ExtResponse,
            ImageContent, Implementation, InitializeRequest, KillTerminalRequest,
            KillTerminalResponse, ListSessionsRequest, LoadSessionRequest, LoadSessionResponse,
            NewSessionRequest, NewSessionResponse, PermissionOptionKind, PromptRequest,
            ReleaseTerminalResponse, RequestPermissionOutcome, RequestPermissionRequest,
            RequestPermissionResponse, ResourceLink, ResumeSessionRequest, ResumeSessionResponse,
            SelectedPermissionOutcome, SessionConfigKind,
            SessionConfigOption as AcpSessionConfigOption, SessionConfigOptionCategory,
            SessionConfigOptionValue, SessionConfigSelectOption, SessionConfigSelectOptions,
            SessionConfigValueId, SessionId, SessionModeState, SessionNotification, SessionUpdate,
            SetSessionConfigOptionRequest, SetSessionModeRequest, TerminalId,
            TerminalOutputResponse, TextContent, ToolCallContent, ToolCallLocation,
            WaitForTerminalExitResponse,
        },
    },
};
use chrono::Utc;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::{
    io::AsyncWriteExt,
    sync::{Mutex, RwLock, mpsc, oneshot},
    time::Instant,
};
use tokio_util::{
    compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt},
    io::ReaderStream,
};
use workspace_utils::{
    process::{
        ProcessTreeJob, group_spawn_no_window_with_job, kill_process_group,
        new_hidden_tokio_command,
    },
    proxy::{DetectedProxy, detect_proxy},
};

use crate::{
    AcpAuthStatusAdapter, AcpCapabilityNormalizer, AcpCapabilitySnapshot, AgentAutoApproveMode,
    AgentAvailableCommand, AgentConnectionId, AgentContentBlock, AgentElicitationId,
    AgentElicitationRequest, AgentElicitationResponse, AgentError, AgentErrorEvent, AgentEvent,
    AgentId, AgentKind, AgentListedSession, AgentPermissionId, AgentPermissionOption,
    AgentPermissionOptionKind, AgentPermissionRequest, AgentPermissionResponse, AgentPlan,
    AgentPromptFinished, AgentPromptId, AgentResult, AgentSessionConfigChoice,
    AgentSessionConfigOption, AgentSessionConfigOverride, AgentSessionControlsSnapshot,
    AgentSessionId, AgentSessionListPage, AgentSessionMode, AgentSteerOutcome, AgentSteerReceipt,
    AgentTerminalCreateRequest, AgentTerminalEnvVar, AgentTerminalExit, AgentToolCall,
    AgentToolCallUpdate, AgentUsage, SessionLaunchLock,
    conversation::SessionLoadFailureReason,
    decide_auto_permission_response,
    delegation_inject::{
        CompanionCapabilities, CompanionInjectionContext, CompanionInjectionList,
        DelegationInjector, InjectedRemoteMcpTransport,
    },
    grok_mcp::{self, GrokMcpTracker},
    grok_subagent::GrokSubagentTracker,
    grok_usage,
    pi_commands::{enrich_pi_available_commands, merge_available_command_lists},
    pi_trust::{PI_COMMAND_ENV, PI_CONFIG_DIR_ENV, PI_SESSION_DIR_ENV, PI_TRUST_WORKSPACE_ENV},
    session_config_guard::{
        self, GROK_MODELS_UPDATE_METHOD, GrokModelCatalog, asserted_from_preferred,
        config_option_rejection, fold_grok_catalog_model_choices, parse_grok_model_catalog,
        preferred_controls_map, take_asserted_config_drift,
    },
    session_notice,
    state::{AgentConnectionSnapshot, AgentConnectionStatus},
    terminal::agent_terminal_registry,
    usage_from_session_notification_params,
};

mod protocol;
mod requests;
mod runner;
mod terminal;
mod usage;

use protocol::*;
use requests::*;
pub use runner::LeadingEdgeThrottle;
use runner::*;
use terminal::*;
use usage::*;

#[derive(Debug, Clone)]
pub struct AgentConnectionLaunch {
    pub connection_id: AgentConnectionId,
    pub agent_id: AgentId,
    pub launch_lock: SessionLaunchLock,
    pub workspace_id: uuid::Uuid,
    pub working_dir: PathBuf,
    /// Workspace/project roots explicitly associated with this session. The
    /// runner forwards them only after ACP advertises additionalDirectories.
    pub additional_directories: Vec<PathBuf>,
    pub auto_approve_mode: AgentAutoApproveMode,
    pub env: HashMap<String, String>,
}

#[derive(Debug)]
pub enum AgentConnectionCommand {
    /// Create (or reuse) the concrete ACP session and return its authoritative
    /// controls. This is used by conversation-creation surfaces; it is not a
    /// throwaway capability probe.
    PrepareSession {
        session_id: AgentSessionId,
        preferences: crate::SessionControlPreferences,
        result_tx: oneshot::Sender<AgentResult<(String, AgentSessionControlsSnapshot)>>,
    },
    DiscardSession {
        session_id: AgentSessionId,
        result_tx: oneshot::Sender<AgentResult<()>>,
    },
    ResumeSession {
        session_id: AgentSessionId,
        external_session_id: String,
        preferences: crate::SessionControlPreferences,
        result_tx: oneshot::Sender<
            AgentResult<(
                String,
                AgentSessionControlsSnapshot,
                Option<crate::conversation::SessionRecoveryStrategy>,
            )>,
        >,
    },
    /// Fork the live ACP session (P1-4): the agent branches its context into a
    /// new server-side session; the returned id is the new (forked) session.
    ForkSession {
        session_id: AgentSessionId,
        fork_point: Option<crate::ForkPoint>,
        result_tx: oneshot::Sender<AgentResult<String>>,
    },
    ListSessions {
        cwd: Option<PathBuf>,
        cursor: Option<String>,
        result_tx: oneshot::Sender<AgentResult<AgentSessionListPage>>,
    },
    DeleteSession {
        external_session_id: String,
        result_tx: oneshot::Sender<AgentResult<()>>,
    },
    Prompt {
        session_id: AgentSessionId,
        prompt_id: AgentPromptId,
        blocks: Vec<AgentContentBlock>,
        display_blocks: Option<Vec<AgentContentBlock>>,
        mode_override: Option<String>,
        config_overrides: Vec<AgentSessionConfigOverride>,
    },
    Cancel {
        session_id: AgentSessionId,
        prompt_id: AgentPromptId,
        result_tx: oneshot::Sender<bool>,
    },
    Steer {
        session_id: AgentSessionId,
        expected_prompt_id: AgentPromptId,
        blocks: Vec<AgentContentBlock>,
        display_blocks: Option<Vec<AgentContentBlock>>,
        result_tx: oneshot::Sender<AgentResult<AgentSteerReceipt>>,
    },
    RespondPermission {
        permission_id: String,
        response: AgentPermissionResponse,
    },
    RespondElicitation {
        elicitation_id: String,
        response: AgentElicitationResponse,
    },
    /// Switch the live ACP session's mode immediately (`session/set_mode`),
    /// outside the prompt lifecycle. Mid-turn requests are rejected so the
    /// command loop never blocks on an agent that answers slowly while
    /// streaming; callers fall back to a next-turn override.
    SetSessionMode {
        session_id: AgentSessionId,
        mode_id: String,
        result_tx: oneshot::Sender<AgentResult<AgentSessionControlsSnapshot>>,
    },
    /// Change one agent-advertised config option immediately
    /// (`session/set_config_option`, e.g. model / permission mode).
    SetSessionConfigOption {
        session_id: AgentSessionId,
        key: String,
        value: serde_json::Value,
        result_tx: oneshot::Sender<AgentResult<AgentSessionControlsSnapshot>>,
    },
    /// Send a session goal control action (`pause`, `clear`, `set`, `resume`)
    /// over `_session/goal` or legacy `_codex/session/goal_control`.
    GoalControl {
        session_id: AgentSessionId,
        action: String,
        result_tx: oneshot::Sender<AgentResult<crate::GoalControlReceipt>>,
    },
    /// Stop a background async task over `_session/async_task/stop`.
    StopAsyncTask {
        session_id: AgentSessionId,
        task_id: String,
        result_tx: oneshot::Sender<AgentResult<bool>>,
    },
    /// Atomically rewind turns on a flagship native engine session (`thread/rollback`
    /// on Codex or `session/revert` on Claude).
    RollbackTurns {
        session_id: AgentSessionId,
        num_turns: u32,
        checkpoint_point: Option<String>,
        git_ref: Option<String>,
        commit_oid: Option<String>,
        result_tx: oneshot::Sender<AgentResult<()>>,
    },
    Disconnect,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedAgentConnectionSnapshot {
    pub connection_id: AgentConnectionId,
    pub agent_id: AgentId,
    pub launch_lock: SessionLaunchLock,
    pub workspace_id: uuid::Uuid,
    pub working_dir: PathBuf,
    pub additional_directories: Vec<PathBuf>,
    pub auto_approve_mode: AgentAutoApproveMode,
    pub env: HashMap<String, String>,
}

#[derive(Debug, Clone)]
pub struct AgentConnectionManagerEvent {
    pub connection_id: AgentConnectionId,
    pub session_id: Option<AgentSessionId>,
    pub prompt_id: Option<AgentPromptId>,
    pub event: AgentEvent,
}

/// Historical bound for the ACP → runtime event pump. The live pump is
/// unbounded: a bounded channel plus `block_in_place` on the ACP read loop
/// stalled every concurrent session at "生成中" when persist was slow.
pub const MANAGER_EVENT_BUFFER: usize = 8192;

pub fn manager_event_channel() -> (
    mpsc::UnboundedSender<AgentConnectionManagerEvent>,
    mpsc::UnboundedReceiver<AgentConnectionManagerEvent>,
) {
    mpsc::unbounded_channel()
}

fn send_manager_event(
    tx: &mpsc::UnboundedSender<AgentConnectionManagerEvent>,
    event: AgentConnectionManagerEvent,
) {
    if let AgentEvent::RawAcpDiagnostic { raw } = &event.event
        && let Some(notice) = session_notice::notice_from_diagnostic_payload(raw)
    {
        tracing::warn!(
            connection_id = %event.connection_id,
            session_id = ?event.session_id,
            title = %notice.title,
            message = notice.message.as_deref().unwrap_or(""),
            severity = %notice.severity,
            "ACP session notice"
        );
    }
    if tx.send(event).is_err() {
        tracing::debug!("ACP manager event outlet closed");
    }
}

#[derive(Debug)]
struct ManagedAgentConnection {
    snapshot: ManagedAgentConnectionSnapshot,
    cmd_tx: mpsc::Sender<AgentConnectionCommand>,
    capabilities: Arc<RwLock<AcpCapabilitySnapshot>>,
    session_map: Arc<RwLock<HashMap<AgentSessionId, String>>>,
    last_activity: Arc<Mutex<Instant>>,
    active_prompt: Arc<Mutex<Option<(AgentSessionId, AgentPromptId)>>>,
    pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
    pending_elicitations: Arc<Mutex<HashMap<String, PendingElicitation>>>,
    child_pid: Arc<std::sync::Mutex<Option<u32>>>,
    process_job: Arc<std::sync::Mutex<Option<ProcessTreeJob>>>,
    status: Arc<Mutex<AgentConnectionStatus>>,
    task: tokio::task::JoinHandle<()>,
}

#[derive(Debug)]
pub struct AgentConnectionManager {
    connections: Mutex<HashMap<AgentConnectionId, ManagedAgentConnection>>,
    event_tx: mpsc::UnboundedSender<AgentConnectionManagerEvent>,
    driver_enabled: bool,
    /// Installed once at startup. Lets the app splice a companion MCP server
    /// (the delegation companion) into each connection's `session/new`.
    delegation_injector: OnceLock<Arc<dyn DelegationInjector>>,
    /// Coordinator for official Claude Prompt Cache warm-preservation (`/compact`
    /// 2 minutes prior to cache TTL expiry when context >= 100k tokens).
    idle_compaction: Arc<crate::idle_compaction::IdleCompaction>,
}

impl Default for AgentConnectionManager {
    fn default() -> Self {
        let (event_tx, _event_rx) = manager_event_channel();
        Self::new(event_tx)
    }
}

impl AgentConnectionManager {
    pub fn new(event_tx: mpsc::UnboundedSender<AgentConnectionManagerEvent>) -> Self {
        Self::new_with_driver(event_tx, true)
    }

    pub fn new_with_driver(
        event_tx: mpsc::UnboundedSender<AgentConnectionManagerEvent>,
        driver_enabled: bool,
    ) -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
            event_tx,
            driver_enabled,
            delegation_injector: OnceLock::new(),
            idle_compaction: Arc::new(crate::idle_compaction::IdleCompaction::default()),
        }
    }

    pub fn idle_compaction(&self) -> &Arc<crate::idle_compaction::IdleCompaction> {
        &self.idle_compaction
    }

    /// Install the companion injector (called once at startup, before any
    /// connection is registered).
    pub fn install_delegation_injector(&self, injector: Arc<dyn DelegationInjector>) {
        let _ = self.delegation_injector.set(injector);
    }

    /// Spawn the connection task and return a readiness receiver. The receiver
    /// resolves `Ok(())` once the ACP handshake (InitializeRequest) succeeds, and
    /// resolves with an error (or a dropped-sender `RecvError`) on any spawn /
    /// handshake failure. `connect` awaits it so a connection is only ever marked
    /// Ready after the agent is actually reachable — no more "false Ready" that
    /// silently swallows the first prompt.
    pub async fn register_connection(
        &self,
        launch: AgentConnectionLaunch,
    ) -> (
        ManagedAgentConnectionSnapshot,
        oneshot::Receiver<AgentResult<()>>,
    ) {
        let (cmd_tx, cmd_rx) = mpsc::channel::<AgentConnectionCommand>(32);
        let (ready_tx, ready_rx) = oneshot::channel::<AgentResult<()>>();
        let snapshot = ManagedAgentConnectionSnapshot {
            connection_id: launch.connection_id,
            agent_id: launch.agent_id,
            launch_lock: launch.launch_lock,
            workspace_id: launch.workspace_id,
            working_dir: launch.working_dir,
            additional_directories: launch.additional_directories,
            auto_approve_mode: launch.auto_approve_mode,
            env: launch.env,
        };
        let runner = AgentConnectionRunner::new(
            snapshot.clone(),
            self.event_tx.clone(),
            self.delegation_injector.get().cloned(),
        )
        .with_idle_compaction(Arc::clone(&self.idle_compaction));
        let capabilities = Arc::clone(&runner.capabilities);
        let session_map = Arc::clone(&runner.session_map);
        let last_activity = Arc::clone(&runner.last_activity);
        let active_prompt = Arc::clone(&runner.active_prompt);
        let pending_permissions = Arc::clone(&runner.pending_permissions);
        let pending_elicitations = Arc::clone(&runner.pending_elicitations);
        let child_pid = Arc::clone(&runner.child_pid);
        let process_job = Arc::clone(&runner.process_job);
        let status = Arc::clone(&runner.status);

        let task = if self.driver_enabled {
            tokio::spawn(async move {
                runner.run(cmd_rx, ready_tx).await;
            })
        } else {
            // The in-memory driver has no process to spawn / handshake — it's
            // ready the moment it's registered.
            *status.lock().await = AgentConnectionStatus::Ready;
            let _ = ready_tx.send(Ok(()));
            tokio::spawn(async move {
                runner.run_in_memory(cmd_rx).await;
            })
        };

        self.connections.lock().await.insert(
            snapshot.connection_id,
            ManagedAgentConnection {
                snapshot: snapshot.clone(),
                cmd_tx,
                capabilities,
                session_map,
                last_activity,
                active_prompt,
                pending_permissions,
                pending_elicitations,
                child_pid,
                process_job,
                status,
                task,
            },
        );

        (snapshot, ready_rx)
    }

    pub async fn connection_capabilities(
        &self,
        connection_id: AgentConnectionId,
    ) -> AgentResult<AcpCapabilitySnapshot> {
        let capabilities = self
            .connections
            .lock()
            .await
            .get(&connection_id)
            .map(|connection| Arc::clone(&connection.capabilities))
            .ok_or_else(|| AgentError::ConnectionNotFound(connection_id.to_string()))?;
        Ok(capabilities.read().await.clone())
    }

    pub async fn send_prompt(
        &self,
        connection_id: AgentConnectionId,
        session_id: AgentSessionId,
        prompt_id: AgentPromptId,
        blocks: Vec<AgentContentBlock>,
        mode_override: Option<String>,
        config_overrides: Vec<AgentSessionConfigOverride>,
    ) -> AgentResult<()> {
        self.send_prompt_with_display_blocks(
            connection_id,
            session_id,
            prompt_id,
            blocks,
            None,
            mode_override,
            config_overrides,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn send_prompt_with_display_blocks(
        &self,
        connection_id: AgentConnectionId,
        session_id: AgentSessionId,
        prompt_id: AgentPromptId,
        blocks: Vec<AgentContentBlock>,
        display_blocks: Option<Vec<AgentContentBlock>>,
        mode_override: Option<String>,
        config_overrides: Vec<AgentSessionConfigOverride>,
    ) -> AgentResult<()> {
        if !self.has_connection(connection_id).await {
            return Err(AgentError::ConnectionNotFound(connection_id.to_string()));
        }
        let bound = self
            .bound_acp_session_id(connection_id, session_id)
            .await
            .filter(|id| crate::runtime::is_live_bound_session_id(id));
        if bound.is_none() {
            crate::session_bind_metrics::record_prompt_unbound(session_id.0);
            return Err(AgentError::AcpSessionNotBound);
        }
        self.send_command(
            connection_id,
            AgentConnectionCommand::Prompt {
                session_id,
                prompt_id,
                blocks,
                display_blocks,
                mode_override,
                config_overrides,
            },
        )
        .await
    }

    pub async fn bind_known_acp_session(
        &self,
        connection_id: AgentConnectionId,
        session_id: AgentSessionId,
        acp_session_id: String,
    ) {
        if !crate::is_restorable_acp_session_id(&acp_session_id) {
            return;
        }
        let session_map = {
            let connections = self.connections.lock().await;
            let Some(connection) = connections.get(&connection_id) else {
                return;
            };
            if connection.task.is_finished() {
                return;
            }
            Arc::clone(&connection.session_map)
        };
        session_map.write().await.insert(session_id, acp_session_id);
    }

    pub async fn cancel_prompt(
        &self,
        connection_id: AgentConnectionId,
        session_id: AgentSessionId,
        prompt_id: AgentPromptId,
    ) -> AgentResult<()> {
        let (result_tx, result_rx) = oneshot::channel();
        let acknowledged = match self
            .send_command(
                connection_id,
                AgentConnectionCommand::Cancel {
                    session_id,
                    prompt_id,
                    result_tx,
                },
            )
            .await
        {
            Ok(()) => result_rx.await.unwrap_or(false),
            Err(AgentError::ConnectionNotFound(id)) => {
                return Err(AgentError::ConnectionNotFound(id));
            }
            Err(_) => false,
        };
        if !acknowledged {
            let _ = self.disconnect(connection_id).await;
        }
        Ok(())
    }

    pub async fn steer_prompt(
        &self,
        connection_id: AgentConnectionId,
        session_id: AgentSessionId,
        expected_prompt_id: AgentPromptId,
        blocks: Vec<AgentContentBlock>,
    ) -> AgentResult<AgentSteerReceipt> {
        self.steer_prompt_with_display_blocks(
            connection_id,
            session_id,
            expected_prompt_id,
            blocks,
            None,
        )
        .await
    }

    pub async fn steer_prompt_with_display_blocks(
        &self,
        connection_id: AgentConnectionId,
        session_id: AgentSessionId,
        expected_prompt_id: AgentPromptId,
        blocks: Vec<AgentContentBlock>,
        display_blocks: Option<Vec<AgentContentBlock>>,
    ) -> AgentResult<AgentSteerReceipt> {
        if !self.connection_capabilities(connection_id).await?.steering {
            return Err(AgentError::SteeringUnsupported);
        }
        let (result_tx, result_rx) = oneshot::channel();
        self.send_command(
            connection_id,
            AgentConnectionCommand::Steer {
                session_id,
                expected_prompt_id,
                blocks,
                display_blocks,
                result_tx,
            },
        )
        .await?;
        result_rx.await.map_err(|_| {
            AgentError::Runtime("agent connection closed before steering was acknowledged".into())
        })?
    }

    pub async fn respond_permission(
        &self,
        connection_id: AgentConnectionId,
        permission_id: AgentPermissionId,
        response: AgentPermissionResponse,
    ) -> AgentResult<()> {
        self.send_command(
            connection_id,
            AgentConnectionCommand::RespondPermission {
                permission_id: permission_id.to_string(),
                response,
            },
        )
        .await
    }

    pub async fn respond_elicitation(
        &self,
        connection_id: AgentConnectionId,
        elicitation_id: AgentElicitationId,
        response: AgentElicitationResponse,
    ) -> AgentResult<()> {
        self.send_command(
            connection_id,
            AgentConnectionCommand::RespondElicitation {
                elicitation_id: elicitation_id.to_string(),
                response,
            },
        )
        .await
    }

    pub async fn resume_session(
        &self,
        connection_id: AgentConnectionId,
        session_id: AgentSessionId,
        external_session_id: impl Into<String>,
        preferences: crate::SessionControlPreferences,
    ) -> AgentResult<(
        String,
        AgentSessionControlsSnapshot,
        Option<crate::conversation::SessionRecoveryStrategy>,
    )> {
        let (result_tx, result_rx) = oneshot::channel();
        self.send_command(
            connection_id,
            AgentConnectionCommand::ResumeSession {
                session_id,
                external_session_id: external_session_id.into(),
                preferences,
                result_tx,
            },
        )
        .await?;
        let timeout = session_prep_timeout();
        await_command_result(
            result_rx,
            timeout,
            "agent connection closed before session resume completed",
            format_session_prep_timeout_error(timeout),
        )
        .await
    }

    pub async fn prepare_session(
        &self,
        connection_id: AgentConnectionId,
        session_id: AgentSessionId,
        preferences: crate::SessionControlPreferences,
    ) -> AgentResult<(String, AgentSessionControlsSnapshot)> {
        let (result_tx, result_rx) = oneshot::channel();
        self.send_command(
            connection_id,
            AgentConnectionCommand::PrepareSession {
                session_id,
                preferences,
                result_tx,
            },
        )
        .await?;
        let timeout = session_prep_timeout();
        await_command_result(
            result_rx,
            timeout,
            "agent connection closed before ACP session preparation completed",
            format_session_prep_timeout_error(timeout),
        )
        .await
    }

    pub async fn discard_session(
        &self,
        connection_id: AgentConnectionId,
        session_id: AgentSessionId,
    ) -> AgentResult<()> {
        let (result_tx, result_rx) = oneshot::channel();
        self.send_command(
            connection_id,
            AgentConnectionCommand::DiscardSession {
                session_id,
                result_tx,
            },
        )
        .await?;
        result_rx.await.map_err(|_| {
            AgentError::Runtime(
                "agent connection closed before prepared session cleanup completed".into(),
            )
        })?
    }

    /// Fork the live ACP session, returning the new (forked) external session id.
    /// Errors if the agent did not advertise `session/fork` support at handshake.
    pub async fn fork_session(
        &self,
        connection_id: AgentConnectionId,
        session_id: AgentSessionId,
        fork_point: Option<crate::ForkPoint>,
    ) -> AgentResult<String> {
        let (result_tx, result_rx) = oneshot::channel();
        self.send_command(
            connection_id,
            AgentConnectionCommand::ForkSession {
                session_id,
                fork_point,
                result_tx,
            },
        )
        .await?;
        result_rx.await.map_err(|_| {
            AgentError::Runtime("agent connection closed before session fork completed".into())
        })?
    }

    pub async fn list_sessions(
        &self,
        connection_id: AgentConnectionId,
        cwd: Option<PathBuf>,
        cursor: Option<String>,
    ) -> AgentResult<AgentSessionListPage> {
        let (result_tx, result_rx) = oneshot::channel();
        self.send_command(
            connection_id,
            AgentConnectionCommand::ListSessions {
                cwd,
                cursor,
                result_tx,
            },
        )
        .await?;
        result_rx.await.map_err(|_| {
            AgentError::Runtime("agent connection closed before session list completed".into())
        })?
    }

    pub async fn delete_session(
        &self,
        connection_id: AgentConnectionId,
        external_session_id: impl Into<String>,
    ) -> AgentResult<()> {
        let (result_tx, result_rx) = oneshot::channel();
        self.send_command(
            connection_id,
            AgentConnectionCommand::DeleteSession {
                external_session_id: external_session_id.into(),
                result_tx,
            },
        )
        .await?;
        result_rx.await.map_err(|_| {
            AgentError::Runtime("agent connection closed before session delete completed".into())
        })?
    }

    /// Immediately switch the session's mode via ACP `session/set_mode`
    /// (matched against the modes the agent advertised). Errors while a turn is
    /// in flight — callers keep the choice as a next-turn override instead.
    pub async fn set_session_mode(
        &self,
        connection_id: AgentConnectionId,
        session_id: AgentSessionId,
        mode_id: impl Into<String>,
    ) -> AgentResult<AgentSessionControlsSnapshot> {
        let (result_tx, result_rx) = oneshot::channel();
        self.send_command(
            connection_id,
            AgentConnectionCommand::SetSessionMode {
                session_id,
                mode_id: mode_id.into(),
                result_tx,
            },
        )
        .await?;
        result_rx.await.map_err(|_| {
            AgentError::Runtime(
                "agent connection closed before session mode change completed".into(),
            )
        })?
    }

    /// Immediately change one agent-advertised config option (model, permission
    /// mode, …) via ACP `session/set_config_option`. Same in-flight-turn caveat
    /// as [`Self::set_session_mode`].
    pub async fn set_session_config_option(
        &self,
        connection_id: AgentConnectionId,
        session_id: AgentSessionId,
        key: impl Into<String>,
        value: serde_json::Value,
    ) -> AgentResult<AgentSessionControlsSnapshot> {
        let (result_tx, result_rx) = oneshot::channel();
        self.send_command(
            connection_id,
            AgentConnectionCommand::SetSessionConfigOption {
                session_id,
                key: key.into(),
                value,
                result_tx,
            },
        )
        .await?;
        result_rx.await.map_err(|_| {
            AgentError::Runtime(
                "agent connection closed before session config change completed".into(),
            )
        })?
    }

    pub async fn goal_control(
        &self,
        connection_id: AgentConnectionId,
        session_id: AgentSessionId,
        action: impl Into<String>,
    ) -> AgentResult<crate::GoalControlReceipt> {
        let (result_tx, result_rx) = oneshot::channel();
        self.send_command(
            connection_id,
            AgentConnectionCommand::GoalControl {
                session_id,
                action: action.into(),
                result_tx,
            },
        )
        .await?;
        result_rx.await.map_err(|_| {
            AgentError::Runtime("agent connection closed before goal control completed".into())
        })?
    }

    pub async fn stop_async_task(
        &self,
        connection_id: AgentConnectionId,
        session_id: AgentSessionId,
        task_id: impl Into<String>,
    ) -> AgentResult<bool> {
        let (result_tx, result_rx) = oneshot::channel();
        self.send_command(
            connection_id,
            AgentConnectionCommand::StopAsyncTask {
                session_id,
                task_id: task_id.into(),
                result_tx,
            },
        )
        .await?;
        result_rx.await.map_err(|_| {
            AgentError::Runtime("agent connection closed before async task stop completed".into())
        })?
    }

    pub async fn disconnect(&self, connection_id: AgentConnectionId) -> AgentResult<()> {
        let connection = self.connections.lock().await.remove(&connection_id);
        let Some(connection) = connection else {
            return Err(AgentError::ConnectionNotFound(connection_id.to_string()));
        };

        let is_connecting = *connection.status.lock().await == AgentConnectionStatus::Connecting;
        // A closed command channel means the process task is already exiting;
        // it is still safe and necessary to join it. When still in startup
        // handshake (`Connecting`), `cmd_rx` is not polled yet, so skip the
        // join timeout and abort immediately so `ready_rx` wakes without delay.
        if !is_connecting {
            let _ = connection
                .cmd_tx
                .send(AgentConnectionCommand::Disconnect)
                .await;
        }
        let mut task = connection.task;
        let join_result = if is_connecting {
            None
        } else {
            tokio::time::timeout(DISCONNECT_JOIN_TIMEOUT, &mut task)
                .await
                .ok()
        };
        match join_result {
            Some(result) => result.map_err(|error| {
                AgentError::Runtime(format!("agent connection task failed: {error}"))
            }),
            None => {
                task.abort();
                let _ = task.await;
                let _ = connection.child_pid.lock().unwrap().take();
                if let Some(job) = connection.process_job.lock().unwrap().take() {
                    let _ = job.terminate();
                }
                let mut session_ids: std::collections::HashSet<AgentSessionId> = connection
                    .session_map
                    .read()
                    .await
                    .keys()
                    .copied()
                    .collect();
                let pending_permissions = {
                    let mut guard = connection.pending_permissions.lock().await;
                    guard.drain().map(|(_, p)| p).collect::<Vec<_>>()
                };
                for pending in pending_permissions {
                    session_ids.insert(pending.session_id);
                    let response = AgentPermissionResponse::Cancelled;
                    let _ = pending.tx.send(response.clone());
                    send_manager_event(
                        &self.event_tx,
                        AgentConnectionManagerEvent {
                            connection_id,
                            session_id: Some(pending.session_id),
                            prompt_id: None,
                            event: AgentEvent::PermissionResponded {
                                permission_id: pending.permission_id,
                                response,
                                auto: false,
                            },
                        },
                    );
                }
                let pending_elicitations = {
                    let mut guard = connection.pending_elicitations.lock().await;
                    guard.drain().map(|(_, p)| p).collect::<Vec<_>>()
                };
                for pending in pending_elicitations {
                    session_ids.insert(pending.session_id);
                    let response = AgentElicitationResponse::Cancel;
                    let _ = pending.tx.send(response.clone());
                    send_manager_event(
                        &self.event_tx,
                        AgentConnectionManagerEvent {
                            connection_id,
                            session_id: Some(pending.session_id),
                            prompt_id: None,
                            event: AgentEvent::ElicitationResponded {
                                elicitation_id: pending.elicitation_id,
                                response,
                            },
                        },
                    );
                }
                if let Some((session_id, prompt_id)) = connection.active_prompt.lock().await.take()
                {
                    session_ids.insert(session_id);
                    send_manager_event(
                        &self.event_tx,
                        AgentConnectionManagerEvent {
                            connection_id,
                            session_id: Some(session_id),
                            prompt_id: Some(prompt_id),
                            event: AgentEvent::Error {
                                error: AgentErrorEvent {
                                    message: CONNECTION_CLOSED_TURN_MESSAGE.to_string(),
                                    code: Some("connection_closed".to_string()),
                                    raw: None,
                                },
                            },
                        },
                    );
                }
                for session_id in session_ids {
                    agent_terminal_registry()
                        .release_all_for_session(session_id)
                        .await;
                }
                Ok(())
            }
        }
    }

    /// Synchronously abort all active connection tasks and force-kill their OS
    /// process trees on application exit.
    pub fn kill_all_processes_on_exit(&self) {
        let mut jobs = Vec::new();
        if let Ok(mut connections) = self.connections.try_lock() {
            for (_, connection) in connections.drain() {
                let _ = connection
                    .cmd_tx
                    .try_send(AgentConnectionCommand::Disconnect);
                connection.task.abort();
                if let Ok(mut pid_guard) = connection.child_pid.lock() {
                    let _ = pid_guard.take();
                }
                if let Ok(mut job_guard) = connection.process_job.lock()
                    && let Some(job) = job_guard.take()
                {
                    jobs.push(job);
                }
            }
        }
        for job in jobs {
            let _ = job.terminate();
        }
    }

    pub async fn list_connections(&self) -> Vec<ManagedAgentConnectionSnapshot> {
        self.connections
            .lock()
            .await
            .values()
            .map(|connection| connection.snapshot.clone())
            .collect()
    }

    pub async fn has_connection(&self, connection_id: AgentConnectionId) -> bool {
        self.connections
            .lock()
            .await
            .get(&connection_id)
            .is_some_and(|connection| !connection.task.is_finished())
    }

    /// The ACP session id currently bound to this host conversation, if the
    /// connection is still live and `session/new` / `session/resume` has completed.
    /// An unbound mapping means the next turn must resume the stored external id
    /// on a fresh process — not call `session/new` on a wedged connection.
    pub async fn bound_acp_session_id(
        &self,
        connection_id: AgentConnectionId,
        session_id: AgentSessionId,
    ) -> Option<String> {
        let session_map = {
            let connections = self.connections.lock().await;
            let connection = connections.get(&connection_id)?;
            if connection.task.is_finished() {
                return None;
            }
            Arc::clone(&connection.session_map)
        };
        session_map.read().await.get(&session_id).cloned()
    }

    pub async fn touch(&self, connection_id: AgentConnectionId) -> AgentResult<()> {
        let last_activity = {
            let connections = self.connections.lock().await;
            let connection = connections
                .get(&connection_id)
                .ok_or_else(|| AgentError::ConnectionNotFound(connection_id.to_string()))?;
            if connection.task.is_finished() {
                return Err(AgentError::ConnectionNotFound(connection_id.to_string()));
            }
            Arc::clone(&connection.last_activity)
        };
        *last_activity.lock().await = Instant::now();
        Ok(())
    }

    #[cfg(test)]
    pub(crate) async fn last_activity_elapsed(
        &self,
        connection_id: AgentConnectionId,
    ) -> Option<Duration> {
        let connections = self.connections.lock().await;
        let connection = connections.get(&connection_id)?;
        Some(connection.last_activity.lock().await.elapsed())
    }

    #[cfg(test)]
    pub(crate) async fn set_last_activity_elapsed(
        &self,
        connection_id: AgentConnectionId,
        elapsed: Duration,
    ) {
        let connections = self.connections.lock().await;
        if let Some(connection) = connections.get(&connection_id) {
            *connection.last_activity.lock().await = Instant::now() - elapsed;
        }
    }

    /// Disconnect Ready connections that have been idle past `idle_timeout`.
    /// Skips in-flight turns (including the ADR-0071 cancel window), pending
    /// permission prompts, and connections that are not Ready.
    pub async fn sweep_idle(&self, idle_timeout: Duration) -> usize {
        self.sweep_idle_with_extended(idle_timeout, None).await
    }

    /// Same as [`Self::sweep_idle`], but sessions in `extended` use the longer
    /// timeout until the next sweep sees them drop out of that set.
    pub async fn sweep_idle_with_extended(
        &self,
        idle_timeout: Duration,
        extended: Option<(HashSet<AgentSessionId>, Duration)>,
    ) -> usize {
        let candidates = {
            let mut connections = self.connections.lock().await;
            let finished_ids: Vec<AgentConnectionId> = connections
                .iter()
                .filter_map(|(id, connection)| connection.task.is_finished().then_some(*id))
                .collect();
            for id in finished_ids {
                connections.remove(&id);
            }
            connections
                .iter()
                .map(|(id, connection)| {
                    (
                        *id,
                        connection.snapshot.clone(),
                        connection.cmd_tx.clone(),
                        Arc::clone(&connection.status),
                        Arc::clone(&connection.active_prompt),
                        Arc::clone(&connection.pending_permissions),
                        Arc::clone(&connection.pending_elicitations),
                        Arc::clone(&connection.session_map),
                        Arc::clone(&connection.last_activity),
                    )
                })
                .collect::<Vec<_>>()
        };

        let mut stale = Vec::new();
        let now = Utc::now();
        for (
            id,
            snapshot,
            cmd_tx,
            status,
            active_prompt,
            pending_permissions,
            pending_elicitations,
            session_map,
            last_activity,
        ) in candidates
        {
            if *status.lock().await != AgentConnectionStatus::Ready {
                continue;
            }
            if active_prompt.lock().await.is_some() {
                continue;
            }
            if !pending_permissions.lock().await.is_empty() {
                continue;
            }
            if !pending_elicitations.lock().await.is_empty() {
                continue;
            }

            // Evaluate official Claude Prompt Cache warm-preservation before
            // deciding whether to evict an idle connection.
            let bound_sessions: Vec<AgentSessionId> =
                session_map.read().await.keys().copied().collect();
            let mut compacted_session = None;
            for session_id in &bound_sessions {
                if let Some(snap) = self.idle_compaction.session_snapshot(session_id.0)
                    && let Some(expires_at) = snap.cache_expires_at
                    && matches!(
                        self.idle_compaction.evaluate_at(
                            session_id.0,
                            snap.estimated_tokens,
                            expires_at,
                            now,
                        ),
                        crate::idle_compaction::CompactionDecision::Compact
                    )
                {
                    compacted_session = Some(*session_id);
                    break;
                }
            }
            if let Some(session_id) = compacted_session {
                let prompt_id = AgentPromptId::new();
                if cmd_tx
                    .try_send(AgentConnectionCommand::Prompt {
                        session_id,
                        prompt_id,
                        blocks: vec![AgentContentBlock::Text {
                            text: "/compact".to_string(),
                        }],
                        display_blocks: None,
                        mode_override: None,
                        config_overrides: Vec::new(),
                    })
                    .is_ok()
                {
                    *last_activity.lock().await = Instant::now();
                    continue;
                }
            }

            let timeout = match &extended {
                Some((ids, extended_timeout)) if !ids.is_empty() => {
                    let is_hot = bound_sessions
                        .iter()
                        .any(|session_id| ids.contains(session_id));
                    if is_hot {
                        (*extended_timeout).max(idle_timeout)
                    } else {
                        idle_timeout
                    }
                }
                _ => idle_timeout,
            };
            if last_activity.lock().await.elapsed() < timeout {
                continue;
            }
            stale.push((id, snapshot));
        }
        let mut disconnected = 0;
        for (connection_id, snapshot) in stale {
            if self.disconnect(connection_id).await.is_ok() {
                disconnected += 1;
                let event_now = Utc::now();
                send_manager_event(
                    &self.event_tx,
                    AgentConnectionManagerEvent {
                        connection_id,
                        session_id: None,
                        prompt_id: None,
                        event: AgentEvent::ConnectionStatusChanged {
                            snapshot: crate::state::AgentConnectionSnapshot {
                                id: snapshot.connection_id,
                                agent_id: snapshot.agent_id,
                                workspace_id: snapshot.workspace_id,
                                status: AgentConnectionStatus::Disconnected,
                                working_dir: snapshot.working_dir.display().to_string(),
                                status_message: None,
                                created_at: event_now,
                                updated_at: event_now,
                            },
                        },
                    },
                );
            }
        }
        disconnected
    }

    /// Atomically rewind `num_turns` on a flagship native engine connection
    /// (`thread/rollback` on Codex or `session/revert` on Claude).
    pub async fn rollback_turns(
        &self,
        connection_id: AgentConnectionId,
        session_id: AgentSessionId,
        num_turns: u32,
        checkpoint_point: Option<String>,
        git_ref: Option<String>,
        commit_oid: Option<String>,
    ) -> AgentResult<()> {
        let (result_tx, result_rx) = oneshot::channel();
        self.send_command(
            connection_id,
            AgentConnectionCommand::RollbackTurns {
                session_id,
                num_turns,
                checkpoint_point,
                git_ref,
                commit_oid,
                result_tx,
            },
        )
        .await?;
        result_rx.await.map_err(|_| {
            AgentError::Runtime("agent connection closed before rollback completed".into())
        })?
    }

    #[cfg(test)]
    pub(crate) async fn set_connection_status(
        &self,
        connection_id: AgentConnectionId,
        status: AgentConnectionStatus,
    ) {
        let connections = self.connections.lock().await;
        if let Some(connection) = connections.get(&connection_id) {
            *connection.status.lock().await = status;
        }
    }

    #[cfg(test)]
    pub(crate) async fn replace_command_sender(
        &self,
        connection_id: AgentConnectionId,
        cmd_tx: mpsc::Sender<AgentConnectionCommand>,
    ) -> mpsc::Sender<AgentConnectionCommand> {
        let mut connections = self.connections.lock().await;
        let connection = connections
            .get_mut(&connection_id)
            .expect("test connection must be registered");
        // Keep the previous sender alive so the connection task stays wedged
        // on its original receiver instead of exiting when this is dropped.
        std::mem::replace(&mut connection.cmd_tx, cmd_tx)
    }

    async fn send_command(
        &self,
        connection_id: AgentConnectionId,
        command: AgentConnectionCommand,
    ) -> AgentResult<()> {
        let (cmd_tx, last_activity) = {
            let mut connections = self.connections.lock().await;
            match connections.get(&connection_id) {
                None => {
                    return Err(AgentError::ConnectionNotFound(connection_id.to_string()));
                }
                Some(connection) if connection.task.is_finished() => {
                    connections.remove(&connection_id);
                    return Err(AgentError::Runtime(
                        "agent connection command channel closed".into(),
                    ));
                }
                Some(connection) => (
                    connection.cmd_tx.clone(),
                    Arc::clone(&connection.last_activity),
                ),
            }
        };
        *last_activity.lock().await = Instant::now();

        if cmd_tx.send(command).await.is_ok() {
            return Ok(());
        }

        self.connections.lock().await.remove(&connection_id);
        Err(AgentError::Runtime(
            "agent connection command channel closed".into(),
        ))
    }
}


#[cfg(test)]
mod tests;
