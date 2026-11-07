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
    process::{group_spawn_no_window, kill_process_group, new_hidden_tokio_command},
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
        }
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
        );
        let capabilities = Arc::clone(&runner.capabilities);
        let session_map = Arc::clone(&runner.session_map);
        let last_activity = Arc::clone(&runner.last_activity);
        let active_prompt = Arc::clone(&runner.active_prompt);
        let pending_permissions = Arc::clone(&runner.pending_permissions);
        let pending_elicitations = Arc::clone(&runner.pending_elicitations);
        let child_pid = Arc::clone(&runner.child_pid);
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
            .filter(|id| crate::is_restorable_acp_session_id(id));
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

        // A closed command channel means the process task is already exiting;
        // it is still safe and necessary to join it.
        let _ = connection
            .cmd_tx
            .send(AgentConnectionCommand::Disconnect)
            .await;
        let mut task = connection.task;
        match tokio::time::timeout(DISCONNECT_JOIN_TIMEOUT, &mut task).await {
            Ok(result) => result.map_err(|error| {
                AgentError::Runtime(format!("agent connection task failed: {error}"))
            }),
            Err(_) => {
                task.abort();
                let _ = task.await;
                if let Some(pid) = connection.child_pid.lock().unwrap().take() {
                    #[cfg(unix)]
                    {
                        // SAFETY: `getpgid`, `getpgrp`, and `killpg` are standard POSIX syscalls; negative return indicates error.
                        unsafe {
                            let pgid = libc::getpgid(pid as libc::pid_t);
                            let self_pgid = libc::getpgrp();
                            if pgid > 1 && pgid != self_pgid {
                                let _ = libc::killpg(pgid, libc::SIGKILL);
                            }
                        }
                    }
                    #[cfg(windows)]
                    {
                        use std::os::windows::process::CommandExt;
                        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                        let _ = std::process::Command::new("taskkill")
                            .args(["/F", "/T", "/PID", &pid.to_string()])
                            .creation_flags(CREATE_NO_WINDOW)
                            .status();
                    }
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
        let mut pids = Vec::new();
        if let Ok(mut connections) = self.connections.try_lock() {
            for (_, connection) in connections.drain() {
                let _ = connection
                    .cmd_tx
                    .try_send(AgentConnectionCommand::Disconnect);
                connection.task.abort();
                if let Ok(mut guard) = connection.child_pid.lock()
                    && let Some(pid) = guard.take()
                {
                    pids.push(pid);
                }
            }
        }
        for pid in pids {
            #[cfg(unix)]
            {
                // SAFETY: `getpgid`, `getpgrp`, and `killpg` are standard POSIX syscalls; negative return indicates error.
                unsafe {
                    let pgid = libc::getpgid(pid as libc::pid_t);
                    let self_pgid = libc::getpgrp();
                    if pgid > 1 && pgid != self_pgid {
                        let _ = libc::killpg(pgid, libc::SIGKILL);
                    }
                }
            }
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                let _ = std::process::Command::new("taskkill")
                    .args(["/F", "/T", "/PID", &pid.to_string()])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .creation_flags(CREATE_NO_WINDOW)
                    .status();
            }
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
        let mut stale = Vec::new();
        {
            let connections = self.connections.lock().await;
            for (id, connection) in connections.iter() {
                if connection.task.is_finished() {
                    continue;
                }
                if *connection.status.lock().await != AgentConnectionStatus::Ready {
                    continue;
                }
                if connection.active_prompt.lock().await.is_some() {
                    continue;
                }
                if !connection.pending_permissions.lock().await.is_empty() {
                    continue;
                }
                let timeout = match &extended {
                    Some((ids, extended_timeout)) if !ids.is_empty() => {
                        let is_hot = connection
                            .session_map
                            .read()
                            .await
                            .keys()
                            .any(|session_id| ids.contains(session_id));
                        if is_hot {
                            (*extended_timeout).max(idle_timeout)
                        } else {
                            idle_timeout
                        }
                    }
                    _ => idle_timeout,
                };
                if connection.last_activity.lock().await.elapsed() < timeout {
                    continue;
                }
                stale.push(*id);
            }
        }
        let mut disconnected = 0;
        for connection_id in stale {
            if self.disconnect(connection_id).await.is_ok() {
                disconnected += 1;
            }
        }
        disconnected
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
mod tests {
    use workspace_utils::proxy::ProxySource;

    use super::*;
    use crate::stderr_tail::StderrTail;

    fn dummy_runner(
        event_tx: mpsc::UnboundedSender<AgentConnectionManagerEvent>,
    ) -> AgentConnectionRunner {
        AgentConnectionRunner::new(
            ManagedAgentConnectionSnapshot {
                connection_id: AgentConnectionId::new(),
                agent_id: AgentId::parse("antigravity").unwrap(),
                launch_lock: crate::SessionLaunchLock {
                    agent_id: AgentId::parse("antigravity").unwrap(),
                    absolute_acp_program: PathBuf::from("/managed/acp"),
                    args: vec!["serve".into()],
                    env: BTreeMap::new(),
                    runtime_version: "2.0.0".into(),
                    acp_version: "1.1.0".into(),
                },
                workspace_id: uuid::Uuid::nil(),
                working_dir: PathBuf::from("C:/workspace"),
                additional_directories: Vec::new(),
                auto_approve_mode: AgentAutoApproveMode::default(),
                env: HashMap::new(),
            },
            event_tx,
            None,
        )
    }

    #[test]
    fn grok_catalog_refresh_keeps_this_session_current_model() {
        let mut options = vec![
            AcpSessionConfigOption::select(
                "model",
                "Model",
                "grok-4.7",
                vec![
                    SessionConfigSelectOption::new("grok-4.6", "Grok 4.6"),
                    SessionConfigSelectOption::new("grok-4.7", "Grok 4.7"),
                ],
            )
            .category(Some(SessionConfigOptionCategory::Model)),
        ];
        let catalog = parse_grok_model_catalog(&serde_json::json!({
            "currentModelId": "grok-4.6",
            "availableModels": [
                {"modelId": "grok-4.6", "name": "Grok 4.6"},
                {"modelId": "grok-4.7", "name": "Grok 4.7"},
                {"modelId": "grok-4.5", "name": "Grok 4.5"}
            ]
        }))
        .expect("catalog");
        assert!(apply_grok_catalog_to_stored_options(&mut options, &catalog));
        let SessionConfigKind::Select(select) = &options[0].kind else {
            panic!("model stays a select");
        };
        assert_eq!(select.current_value.0.as_ref(), "grok-4.7");
        assert_eq!(
            select_option_rows(&select.options),
            vec![
                ("grok-4.6".into(), "Grok 4.6".into()),
                ("grok-4.7".into(), "Grok 4.7".into()),
                ("grok-4.5".into(), "Grok 4.5".into()),
            ]
        );
        assert!(!apply_grok_catalog_to_stored_options(
            &mut options,
            &catalog
        ));
    }

    #[tokio::test]
    async fn acp_tool_call_notifications_preserve_reported_status_and_output() {
        let session_id = AgentSessionId::new();
        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let bridge = AcpClientBridge::new(
            AgentConnectionId::new(),
            AgentId::parse("antigravity").unwrap(),
            event_tx,
            Arc::new(RwLock::new(HashMap::from([(
                session_id,
                "acp-test".into(),
            )]))),
            Arc::new(RwLock::new(HashMap::new())),
            Arc::new(Mutex::new(HashMap::new())),
            Arc::new(Mutex::new(HashMap::new())),
            Arc::new(Mutex::new(AgentAutoApproveMode::default())),
            Arc::new(Mutex::new(HashMap::new())),
            Arc::new(Mutex::new(Instant::now())),
            Arc::new(Mutex::new(GrokSubagentTracker::default())),
            Arc::new(Mutex::new(GrokMcpTracker::default())),
            Arc::new(Mutex::new(None)),
            PathBuf::from("C:/workspace"),
            HashMap::new(),
            dummy_runner(mpsc::unbounded_channel().0),
        );
        for status in ["in_progress", "completed", "failed"] {
            let notification: SessionNotification = serde_json::from_value(serde_json::json!({
                "sessionId": "acp-test",
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "view-1",
                    "title": "Running view_file",
                    "kind": "read",
                    "status": status,
                    "rawInput": {"AbsolutePath": "C:/workspace/src/read.ts"},
                    "rawOutput": "inspected content"
                }
            }))
            .unwrap();
            bridge.session_notification(notification).await.unwrap();
            let event = event_rx.try_recv().unwrap();
            let AgentEvent::ToolCall { tool_call } = event.event else {
                panic!("Expected a tool call");
            };
            let call = serde_json::to_value(tool_call).unwrap();
            assert_eq!(call["status"], status);
            assert_eq!(call["content"], "\"inspected content\"");
        }
    }

    #[test]
    fn structured_acp_diff_becomes_a_file_edit_input_preview() {
        let diff = acp::schema::v1::Diff::new("src/App.tsx", "new line")
            .old_text(Some("old line".to_string()));
        let preview = acp_tool_input_preview(None, &[ToolCallContent::Diff(diff)], &[])
            .expect("diff preview");
        let value: serde_json::Value = serde_json::from_str(&preview).unwrap();

        assert_eq!(value["file_path"], "src/App.tsx");
        assert_eq!(value["oldText"], "old line");
        assert_eq!(value["newText"], "new line");
    }

    #[test]
    fn structured_acp_location_becomes_a_file_read_input_preview() {
        let location = ToolCallLocation::new("src/lib.rs").line(Some(42));
        let preview = acp_tool_input_preview(None, &[], &[location]).expect("location preview");
        let value: serde_json::Value = serde_json::from_str(&preview).unwrap();

        assert_eq!(value["path"], "src/lib.rs");
        assert_eq!(value["line"], 42);
    }

    #[test]
    fn acp_tool_image_content_becomes_a_semantic_agent_image() {
        let content = vec![ToolCallContent::Content(acp::schema::v1::Content::new(
            ContentBlock::Image(
                ImageContent::new("AAAA", "image/png").uri(Some("asset.png".to_string())),
            ),
        ))];

        let images = acp_tool_images(&content);

        assert_eq!(images.len(), 1);
        assert_eq!(images[0].data, "AAAA");
        assert_eq!(images[0].mime_type, "image/png");
        assert_eq!(images[0].uri.as_deref(), Some("asset.png"));
        assert_eq!(acp_tool_content_preview(&content), None);
    }

    fn test_launch_lock(agent_id: AgentId) -> SessionLaunchLock {
        SessionLaunchLock {
            agent_id,
            absolute_acp_program: PathBuf::from("/tmp/vibex-test-acp"),
            args: Vec::new(),
            env: std::collections::BTreeMap::new(),
            runtime_version: "test-runtime".to_string(),
            acp_version: "test-acp".to_string(),
        }
    }

    #[test]
    fn wire_mcp_offer_follows_negotiated_capabilities_not_agent_id() {
        let mut snapshot = AcpCapabilitySnapshot::default();
        assert_eq!(
            wire_mcp_offer(&snapshot),
            WireMcpOffer {
                stdio: false,
                http: false,
                sse: false,
            }
        );

        snapshot.mcp_stdio = true;
        snapshot.mcp_http = true;
        assert_eq!(
            wire_mcp_offer(&snapshot),
            WireMcpOffer {
                stdio: true,
                http: true,
                sse: false,
            }
        );
        assert!(snapshot.accepts_session_mcp_servers());
    }

    #[test]
    fn v1_session_modes_become_mode_category_config_options() {
        let modes = SessionModeState::new(
            "ask",
            vec![
                agent_client_protocol::schema::v1::SessionMode::new("ask", "Ask"),
                agent_client_protocol::schema::v1::SessionMode::new("act", "Act"),
            ],
        );

        let (options, mode_uses_set_mode) =
            unify_session_config_options(Some(modes), Vec::new(), false);

        assert!(mode_uses_set_mode);
        assert_eq!(options.len(), 1);
        assert_eq!(options[0].id.0.as_ref(), "mode");
        assert_eq!(
            options[0].category.as_ref(),
            Some(&SessionConfigOptionCategory::Mode)
        );
        let (derived, current) = session_modes_from_config_options(&options);
        assert_eq!(current.as_deref(), Some("ask"));
        assert_eq!(
            derived
                .iter()
                .map(|mode| mode.id.as_str())
                .collect::<Vec<_>>(),
            vec!["ask", "act"]
        );
    }

    #[test]
    fn native_mode_config_option_is_not_replaced_by_legacy_modes() {
        let modes = SessionModeState::new(
            "ask",
            vec![agent_client_protocol::schema::v1::SessionMode::new(
                "ask", "Ask",
            )],
        );
        let existing = vec![
            AcpSessionConfigOption::select(
                "mode",
                "Mode",
                "agent",
                vec![
                    agent_client_protocol::schema::v1::SessionConfigSelectOption::new(
                        "agent", "Agent",
                    ),
                ],
            )
            .category(SessionConfigOptionCategory::Mode),
        ];

        let (options, mode_uses_set_mode) =
            unify_session_config_options(Some(modes), existing, false);
        assert!(!mode_uses_set_mode);
        assert_eq!(options[0].id.0.as_ref(), "mode");
        if let SessionConfigKind::Select(select) = &options[0].kind {
            assert_eq!(select.current_value.0.as_ref(), "agent");
        } else {
            panic!("expected select option");
        }
    }

    #[test]
    fn audio_resource_and_resource_link_content_round_trip_without_flattening() {
        let fixtures = [
            serde_json::json!({
                "type": "audio",
                "data": "AAEC",
                "mimeType": "audio/wav",
                "_meta": {"trace": "audio"}
            }),
            serde_json::json!({
                "type": "resource",
                "resource": {
                    "uri": "file:///notes.txt",
                    "mimeType": "text/plain",
                    "text": "hello"
                },
                "_meta": {"trace": "resource"}
            }),
            serde_json::json!({
                "type": "resource_link",
                "name": "notes",
                "uri": "file:///notes.txt",
                "title": "Notes",
                "description": "Project notes",
                "mimeType": "text/plain",
                "size": 5,
                "_meta": {"trace": "link"}
            }),
        ];

        for fixture in fixtures {
            let acp: ContentBlock = serde_json::from_value(fixture.clone()).unwrap();
            let normalized = acp_content_to_agent(acp);
            let round_tripped = agent_block_to_acp(normalized);
            assert_eq!(serde_json::to_value(round_tripped).unwrap(), fixture);
        }
    }

    #[test]
    fn first_class_resource_blocks_are_sent_as_resource_links() {
        let encoded = serde_json::to_value(agent_block_to_acp(AgentContentBlock::Resource {
            uri: "file:///notes.md".to_string(),
            title: Some("notes.md".to_string()),
        }))
        .unwrap();
        assert_eq!(encoded["type"], "resource_link");
        assert_eq!(encoded["uri"], "file:///notes.md");
        assert_eq!(encoded["name"], "notes.md");
        assert_eq!(encoded["title"], "notes.md");
    }

    #[test]
    fn oversized_content_meta_is_dropped_but_payload_is_preserved() {
        let acp: ContentBlock = serde_json::from_value(serde_json::json!({
            "type": "audio",
            "data": "AAEC",
            "mimeType": "audio/wav",
            "_meta": {"large": "x".repeat(17 * 1024)}
        }))
        .unwrap();

        let normalized = acp_content_to_agent(acp);
        let encoded = serde_json::to_value(agent_block_to_acp(normalized)).unwrap();

        assert_eq!(encoded["data"], "AAEC");
        assert!(encoded.get("_meta").is_none());
    }

    #[test]
    fn usage_keeps_cumulative_cost_and_currency() {
        let usage = agent_usage_from_acp(
            agent_client_protocol::schema::v1::UsageUpdate::new(53_000, 200_000)
                .cost(agent_client_protocol::schema::v1::Cost::new(0.045, "USD")),
        );

        assert_eq!(usage.used, 53_000);
        assert_eq!(usage.limit, Some(200_000));
        assert_eq!(usage.cost_amount, Some(0.045));
        assert_eq!(usage.cost_currency.as_deref(), Some("USD"));
    }

    #[test]
    fn session_info_update_preserves_partial_fields_and_bounded_meta() {
        let update: agent_client_protocol::schema::v1::SessionInfoUpdate =
            serde_json::from_value(serde_json::json!({
                "title": "Renamed",
                "_meta": {"source": "fixture"}
            }))
            .unwrap();
        assert_eq!(
            session_info_patch_from_acp(update),
            serde_json::json!({
                "title": "Renamed",
                "_meta": {"source": "fixture"}
            })
        );
    }

    #[test]
    fn session_establishment_meta_exposes_generated_titles() {
        let grok = serde_json::json!({
            "generated_title": "Fix usage",
            "availableModels": []
        });
        assert_eq!(
            acp_meta_session_title(grok.as_object()).as_deref(),
            Some("Fix usage")
        );
        let claude = serde_json::json!({ "sessionTitle": "Review the diff" });
        assert_eq!(
            acp_meta_session_title(claude.as_object()).as_deref(),
            Some("Review the diff")
        );
        let windows_only = serde_json::json!({ "availableModels": [] });
        assert_eq!(acp_meta_session_title(windows_only.as_object()), None);
        let codex = serde_json::json!({ "title": "Tighten session naming" });
        assert_eq!(
            acp_meta_session_title(codex.as_object()).as_deref(),
            Some("Tighten session naming")
        );
        let claude_custom = serde_json::json!({ "customTitle": "Notes probe" });
        assert_eq!(
            acp_meta_session_title(claude_custom.as_object()).as_deref(),
            Some("Notes probe")
        );
    }

    #[test]
    fn model_selection_precedes_dependent_session_options_for_every_agent() {
        let options = vec![
            AcpSessionConfigOption::select(
                "runtime-model",
                "Runtime model",
                "registry/example",
                vec![SessionConfigSelectOption::new(
                    "registry/example",
                    "Registry Example",
                )],
            )
            .category(Some(SessionConfigOptionCategory::Model)),
        ];
        let overrides = vec![
            AgentSessionConfigOverride {
                key: "effort".to_string(),
                value: "high".to_string(),
            },
            AgentSessionConfigOverride {
                key: "permission".to_string(),
                value: "ask".to_string(),
            },
            AgentSessionConfigOverride {
                key: "model".to_string(),
                value: "opencode/example".to_string(),
            },
        ];

        let ordered = ordered_session_config_overrides(&options, overrides);
        assert_eq!(
            ordered
                .iter()
                .map(|override_item| override_item.key.as_str())
                .collect::<Vec<_>>(),
            ["model", "effort", "permission"]
        );
    }

    #[test]
    fn overrides_without_a_model_keep_their_caller_order() {
        let overrides = vec![
            AgentSessionConfigOverride {
                key: "effort".to_string(),
                value: "high".to_string(),
            },
            AgentSessionConfigOverride {
                key: "permission".to_string(),
                value: "ask".to_string(),
            },
        ];

        let ordered = ordered_session_config_overrides(&[], overrides);
        assert_eq!(
            ordered
                .iter()
                .map(|override_item| override_item.key.as_str())
                .collect::<Vec<_>>(),
            ["effort", "permission"]
        );
    }

    #[test]
    fn dedup_stream_text_drops_trailing_full_snapshot() {
        let mut state = StreamDedupState::default();
        // Streaming deltas are emitted verbatim.
        assert!(dedup_stream_text(&mut state, StreamKind::Message, "Here "));
        assert!(dedup_stream_text(
            &mut state,
            StreamKind::Message,
            "is the repo"
        ));
        // codex-acp replays the full message as one final chunk → dropped.
        assert!(!dedup_stream_text(
            &mut state,
            StreamKind::Message,
            "Here is the repo"
        ));
        // A genuinely new message after the snapshot streams normally again.
        assert!(dedup_stream_text(
            &mut state,
            StreamKind::Message,
            "Next answer"
        ));
    }

    #[test]
    fn dedup_stream_text_keeps_distinct_runs_separate() {
        let mut state = StreamDedupState::default();
        assert!(dedup_stream_text(&mut state, StreamKind::Thought, "think "));
        assert!(dedup_stream_text(&mut state, StreamKind::Thought, "hard"));
        // Thought snapshot dropped.
        assert!(!dedup_stream_text(
            &mut state,
            StreamKind::Thought,
            "think hard"
        ));
        // Switching streams starts a fresh accumulator, so identical text on the
        // message channel is NOT mistaken for the thought's duplicate.
        assert!(dedup_stream_text(
            &mut state,
            StreamKind::Message,
            "think hard"
        ));
        // Genuine repetition within a streaming run (each delta != full run so
        // far) is preserved — only an exact full-run snapshot is dropped.
        assert!(dedup_stream_text(&mut state, StreamKind::Message, " think"));
    }

    #[test]
    fn dedup_stream_text_preserves_repeated_single_chunk_content() {
        let mut state = StreamDedupState::default();

        assert!(dedup_stream_text(&mut state, StreamKind::Message, "字"));
        assert!(dedup_stream_text(&mut state, StreamKind::Message, "字"));

        let mut newlines = StreamDedupState::default();
        assert!(dedup_stream_text(&mut newlines, StreamKind::Message, "\n"));
        assert!(dedup_stream_text(&mut newlines, StreamKind::Message, "\n"));
    }

    #[tokio::test]
    async fn live_manager_refuses_non_absolute_installation_locks() {
        for agent_id in ["codex", "claude_code", "opencode"] {
            let agent_id = AgentId::parse(agent_id).unwrap();
            let mut launch_lock = test_launch_lock(agent_id.clone());
            launch_lock.absolute_acp_program = PathBuf::from("relative-acp");
            let (event_tx, _event_rx) = manager_event_channel();
            let manager = AgentConnectionManager::new_with_driver(event_tx, true);
            let (_snapshot, ready_rx) = manager
                .register_connection(AgentConnectionLaunch {
                    connection_id: AgentConnectionId::new(),
                    agent_id: agent_id.clone(),
                    launch_lock,
                    workspace_id: uuid::Uuid::new_v4(),
                    working_dir: std::env::temp_dir(),
                    additional_directories: Vec::new(),
                    auto_approve_mode: AgentAutoApproveMode::Off,
                    env: HashMap::new(),
                })
                .await;
            let result = tokio::time::timeout(Duration::from_secs(1), ready_rx)
                .await
                .expect("runtime guard should fail before a process can start")
                .expect("driver should report its startup error");
            let error = result.expect_err("local runtime override must be required");
            assert!(
                error.to_string().contains("absolute ACP program"),
                "{agent_id} unexpectedly accepted a relative ACP path: {error}"
            );
        }
    }

    #[tokio::test]
    async fn live_manager_refuses_a_missing_working_directory() {
        let program = std::env::current_exe().expect("test binary path");
        let mut launch_lock = test_launch_lock(AgentId::parse("grok").unwrap());
        launch_lock.absolute_acp_program = program;
        let (event_tx, _event_rx) = manager_event_channel();
        let manager = AgentConnectionManager::new_with_driver(event_tx, true);
        let (_snapshot, ready_rx) = manager
            .register_connection(AgentConnectionLaunch {
                connection_id: AgentConnectionId::new(),
                agent_id: AgentId::parse("grok").unwrap(),
                launch_lock,
                workspace_id: uuid::Uuid::new_v4(),
                working_dir: PathBuf::from("VibeX"),
                additional_directories: Vec::new(),
                auto_approve_mode: AgentAutoApproveMode::Off,
                env: HashMap::new(),
            })
            .await;
        let result = tokio::time::timeout(Duration::from_secs(1), ready_rx)
            .await
            .expect("runtime guard should fail before a process can start")
            .expect("driver should report its startup error");
        let error = result.expect_err("a relative missing cwd must not spawn");
        let message = error.to_string();
        assert!(
            message.contains("workspace working directory is missing"),
            "{message}"
        );
        assert!(message.contains("VibeX"), "{message}");
        assert!(!message.contains("No such file or directory"), "{message}");
    }

    #[tokio::test]
    async fn manager_registers_and_removes_connection() {
        let (event_tx, _event_rx) = manager_event_channel();
        let manager = AgentConnectionManager::new_with_driver(event_tx, false);
        let connection_id = AgentConnectionId::new();

        manager
            .register_connection(AgentConnectionLaunch {
                connection_id,
                agent_id: AgentId::parse("codex").unwrap(),
                launch_lock: test_launch_lock(AgentId::parse("codex").unwrap()),
                workspace_id: uuid::Uuid::new_v4(),
                working_dir: PathBuf::from("C:/work"),
                additional_directories: Vec::new(),
                auto_approve_mode: AgentAutoApproveMode::Off,
                env: HashMap::new(),
            })
            .await;

        assert_eq!(manager.list_connections().await.len(), 1);
        manager.disconnect(connection_id).await.unwrap();
        assert!(manager.list_connections().await.is_empty());
    }

    #[tokio::test]
    async fn manager_rejects_unknown_prompt_connection() {
        let (event_tx, _event_rx) = manager_event_channel();
        let err = AgentConnectionManager::new_with_driver(event_tx, false)
            .send_prompt(
                AgentConnectionId::new(),
                AgentSessionId::new(),
                AgentPromptId::new(),
                vec![AgentContentBlock::Text {
                    text: "hello".to_string(),
                }],
                None,
                Vec::new(),
            )
            .await
            .unwrap_err();

        assert!(matches!(err, AgentError::ConnectionNotFound(_)));
    }

    #[tokio::test]
    async fn no_response_regressions_command_channel_close_returns_runtime_error() {
        let (event_tx, _event_rx) = manager_event_channel();
        let manager = AgentConnectionManager::new_with_driver(event_tx, false);
        let connection_id = AgentConnectionId::new();
        let (_snapshot, ready_rx) = manager
            .register_connection(AgentConnectionLaunch {
                connection_id,
                agent_id: AgentId::parse("codex").unwrap(),
                launch_lock: test_launch_lock(AgentId::parse("codex").unwrap()),
                workspace_id: uuid::Uuid::new_v4(),
                working_dir: PathBuf::from("C:/work"),
                additional_directories: Vec::new(),
                auto_approve_mode: AgentAutoApproveMode::Off,
                env: HashMap::new(),
            })
            .await;
        ready_rx.await.unwrap().unwrap();
        let session_id = AgentSessionId::new();
        manager
            .bind_known_acp_session(connection_id, session_id, "acp-session".into())
            .await;
        let (closed_tx, closed_rx) = mpsc::channel(1);
        drop(closed_rx);
        manager
            .connections
            .lock()
            .await
            .get_mut(&connection_id)
            .unwrap()
            .cmd_tx = closed_tx;

        let err = manager
            .send_prompt(
                connection_id,
                session_id,
                AgentPromptId::new(),
                vec![AgentContentBlock::Text {
                    text: "hello".to_string(),
                }],
                None,
                Vec::new(),
            )
            .await
            .unwrap_err();

        assert!(
            err.to_string()
                .contains("agent connection command channel closed")
        );
    }

    #[tokio::test]
    async fn manager_in_memory_resumes_session_with_external_id() {
        let (event_tx, _event_rx) = manager_event_channel();
        let manager = AgentConnectionManager::new_with_driver(event_tx, false);
        let connection_id = AgentConnectionId::new();
        let session_id = AgentSessionId::new();

        manager
            .register_connection(AgentConnectionLaunch {
                connection_id,
                agent_id: AgentId::parse("codex").unwrap(),
                launch_lock: test_launch_lock(AgentId::parse("codex").unwrap()),
                workspace_id: uuid::Uuid::new_v4(),
                working_dir: PathBuf::from("C:/work"),
                additional_directories: Vec::new(),
                auto_approve_mode: AgentAutoApproveMode::Off,
                env: HashMap::new(),
            })
            .await;

        let (acp_session_id, controls, _strategy) = manager
            .resume_session(
                connection_id,
                session_id,
                "external-session",
                Default::default(),
            )
            .await
            .unwrap();

        assert_eq!(acp_session_id, "external-session");
        assert_eq!(controls, AgentSessionControlsSnapshot::default());
    }

    #[test]
    fn maps_acp_session_modes_to_agent_payload() {
        let state = SessionModeState::new(
            "ask",
            vec![
                agent_client_protocol::schema::v1::SessionMode::new("ask", "Ask")
                    .description(Some("Confirm before editing".to_string())),
                agent_client_protocol::schema::v1::SessionMode::new("act", "Act"),
            ],
        );

        let (modes, current) = agent_session_modes_from_acp(state);

        assert_eq!(current.as_deref(), Some("ask"));
        assert_eq!(modes.len(), 2);
        assert_eq!(modes[0].id, "ask");
        assert_eq!(modes[0].label, "Ask");
        assert_eq!(
            modes[0].description.as_deref(),
            Some("Confirm before editing")
        );
    }

    #[tokio::test]
    async fn session_auto_mode_does_not_upgrade_permission_interception() {
        let session_id = AgentSessionId::new();
        let controls = RwLock::new(HashMap::from([(
            session_id,
            SessionControlState {
                config_options: Vec::new(),
                vendor_config: None,
                mode_uses_set_mode: false,
                available_commands: None,
                ..Default::default()
            },
        )]));

        // Claude Code's Auto mode delegates each request to its own model
        // classifier. It must not become VibeX's blanket auto-approval mode.
        assert_eq!(
            effective_auto_approve_mode(AgentAutoApproveMode::Off, &controls, session_id).await,
            AgentAutoApproveMode::Off
        );
        // An explicit agent-level setting always wins over the session mode.
        assert_eq!(
            effective_auto_approve_mode(AgentAutoApproveMode::Yolo, &controls, session_id).await,
            AgentAutoApproveMode::Yolo
        );
        // Sessions without a tracked auto mode keep interception on.
        assert_eq!(
            effective_auto_approve_mode(
                AgentAutoApproveMode::Off,
                &controls,
                AgentSessionId::new()
            )
            .await,
            AgentAutoApproveMode::Off
        );
    }

    #[tokio::test]
    async fn manager_event_channel_does_not_drop_a_burst_of_terminal_events() {
        let (event_tx, mut event_rx) = manager_event_channel();
        let manager = AgentConnectionManager::new_with_driver(event_tx.clone(), false);
        let _ = manager;
        let connection_id = AgentConnectionId::new();
        let prompt_id = AgentPromptId::new();
        for index in 0..64 {
            send_manager_event(
                &event_tx,
                AgentConnectionManagerEvent {
                    connection_id,
                    session_id: None,
                    prompt_id: None,
                    event: AgentEvent::Error {
                        error: AgentErrorEvent {
                            message: format!("fill-{index}"),
                            code: None,
                            raw: None,
                        },
                    },
                },
            );
        }
        send_manager_event(
            &event_tx,
            AgentConnectionManagerEvent {
                connection_id,
                session_id: None,
                prompt_id: Some(prompt_id),
                event: AgentEvent::PromptFinished {
                    finished: AgentPromptFinished {
                        prompt_id,
                        stop_reason: Some("end_turn".into()),
                        usage: None,
                    },
                },
            },
        );
        for _ in 0..64 {
            event_rx.recv().await.expect("burst event");
        }
        let terminal = event_rx
            .recv()
            .await
            .expect("PromptFinished must not be dropped");
        assert!(matches!(
            terminal.event,
            AgentEvent::PromptFinished { finished } if finished.prompt_id == prompt_id
        ));
    }

    #[test]
    fn maps_acp_session_config_options_to_agent_payload() {
        let options = vec![
            AcpSessionConfigOption::select(
                "model",
                "Model",
                "gpt-5",
                vec![
                    agent_client_protocol::schema::v1::SessionConfigSelectOption::new(
                        "gpt-5", "GPT-5",
                    )
                    .description(Some("Balanced".to_string())),
                    agent_client_protocol::schema::v1::SessionConfigSelectOption::new(
                        "gpt-5-codex",
                        "GPT-5 Codex",
                    ),
                ],
            )
            .description(Some("Choose a model".to_string())),
            AcpSessionConfigOption::select(
                "reasoning",
                "Reasoning",
                "high",
                vec![
                    agent_client_protocol::schema::v1::SessionConfigSelectGroup::new(
                        "effort",
                        "Effort",
                        vec![
                            agent_client_protocol::schema::v1::SessionConfigSelectOption::new(
                                "high", "High",
                            ),
                        ],
                    ),
                ],
            ),
        ];

        let mapped = agent_session_config_options_from_acp(options);

        assert_eq!(mapped[0].key, "model");
        assert_eq!(mapped[0].label, "Model");
        assert_eq!(mapped[0].description.as_deref(), Some("Choose a model"));
        assert_eq!(
            mapped[0].value.as_ref(),
            Some(&serde_json::Value::String("gpt-5".to_string()))
        );
        assert_eq!(mapped[0].choices.len(), 2);
        assert_eq!(mapped[0].choices[0].label, "GPT-5");
        assert_eq!(
            mapped[0].choices[0].description.as_deref(),
            Some("Balanced")
        );
        assert_eq!(mapped[1].choices[0].value, serde_json::json!("high"));
    }

    #[test]
    fn grok_set_model_wire_uses_camel_case_session_id() {
        // Grok's ACP 0.10 decoder deserializes `session/set_model` as
        // `{sessionId, modelId}`. Snake_case params fail with
        // `Invalid params: missing field sessionId` and take the prompt
        // path down with "ACP connection failed".
        let request = SetSessionModelRequest::new(
            SessionId::new("0193c0de-5e55-7e55-9e55-000000000001"),
            "grok-4.20".to_string(),
        );
        let value = serde_json::to_value(&request).expect("serialize set_model");
        assert_eq!(
            value,
            serde_json::json!({
                "sessionId": "0193c0de-5e55-7e55-9e55-000000000001",
                "modelId": "grok-4.20",
            })
        );
        assert!(value.get("session_id").is_none());
        assert!(value.get("model_id").is_none());
    }

    #[test]
    fn acp_fork_wire_uses_camel_case_session_id() {
        let request = AcpForkSessionRequest {
            session_id: "sess-1".to_string(),
            cwd: PathBuf::from("/workspace"),
            meta: None,
        };
        let value = serde_json::to_value(&request).expect("serialize fork");
        assert_eq!(value["sessionId"], "sess-1");
        assert_eq!(value["cwd"], "/workspace");
        assert!(value.get("session_id").is_none());
    }

    #[test]
    fn acp_steer_wire_uses_camel_case_session_id() {
        let request = AcpSteerRequest {
            session_id: "sess-1".to_string(),
            prompt: Vec::new(),
            meta: serde_json::json!({ "steering": { "idleBehavior": "promptRequired" } }),
        };
        let value = serde_json::to_value(&request).expect("serialize steer");
        assert_eq!(value["sessionId"], "sess-1");
        assert_eq!(value["_meta"]["steering"]["idleBehavior"], "promptRequired");
        assert!(value.get("session_id").is_none());
        assert!(value.get("meta").is_none());
    }

    #[test]
    fn grok_vendor_meta_session_config_becomes_standard_controls() {
        // Grok 1.0.5 advertises session config via `_meta["x.ai/sessionConfig"]`
        // instead of the standard `modes`/`configOptions` fields (verified
        // against `grok agent stdio` 2026-08). Without this adapter the
        // create-session summary stays empty.
        let meta = serde_json::json!({
            "x.ai/sessionConfig": {
                "options": [
                    { "id": "grok-4.6", "category": "model", "label": "Grok 4.6", "selected": true },
                    { "id": "grok-4.5", "category": "model", "label": "Grok 4.5", "selected": false },
                    { "id": "xhigh", "category": "mode", "label": "Extra High Effort", "description": "Highest effort", "selected": false },
                    { "id": "high", "category": "mode", "label": "High Effort", "description": "Higher implementation quality", "selected": true },
                    { "id": "medium", "category": "mode", "label": "Medium Effort", "selected": false },
                    { "id": "low", "category": "mode", "label": "Low Effort", "description": "Quick, fast implementations", "selected": false }
                ]
            }
        });

        let vendor = vendor_session_controls_from_meta(meta.as_object().unwrap())
            .expect("vendor session config parses");

        assert!(vendor.modes.is_none(), "effort is not a permission mode");
        assert_eq!(vendor.config_options.len(), 2);
        let model = &vendor.config_options[0];
        assert_eq!(model.id.0.as_ref(), "model");
        assert_eq!(model.name, "Model");
        assert_eq!(
            model.category.as_ref(),
            Some(&SessionConfigOptionCategory::Model)
        );
        let SessionConfigKind::Select(select) = &model.kind else {
            panic!("model option must be a select");
        };
        assert_eq!(select.current_value.0.as_ref(), "grok-4.6");
        assert_eq!(
            current_grok_model_id(&vendor.config_options).as_deref(),
            Some("grok-4.6")
        );
        let SessionConfigSelectOptions::Ungrouped(model_choices) = &select.options else {
            panic!("model options must be ungrouped");
        };
        assert_eq!(model_choices.len(), 2);
        assert_eq!(model_choices[0].value.0.as_ref(), "grok-4.6");
        assert_eq!(model_choices[0].name, "Grok 4.6");
        assert_eq!(model_choices[1].value.0.as_ref(), "grok-4.5");
        assert!(
            model_choices
                .iter()
                .all(|choice| choice.value.0.as_ref() != "low"),
            "Low Effort must not leak into the Model selector"
        );

        let effort = &vendor.config_options[1];
        assert_eq!(effort.id.0.as_ref(), "effort");
        assert_eq!(
            effort.category.as_ref(),
            Some(&SessionConfigOptionCategory::ThoughtLevel)
        );
        let SessionConfigKind::Select(select) = &effort.kind else {
            panic!("effort option must be a select");
        };
        assert_eq!(select.current_value.0.as_ref(), "high");
        let SessionConfigSelectOptions::Ungrouped(effort_choices) = &select.options else {
            panic!("effort options must be ungrouped");
        };
        assert_eq!(effort_choices.len(), 4);
        assert_eq!(effort_choices[0].value.0.as_ref(), "xhigh");
        assert_eq!(
            effort_choices[0].description.as_deref(),
            Some("Highest effort")
        );
        assert_eq!(effort_choices[3].value.0.as_ref(), "low");
        assert_eq!(effort_choices[3].name, "Low Effort");
    }

    #[test]
    fn vendor_option_fields_are_classified_independently() {
        assert_eq!(
            classify_vendor_session_option(Some("model"), "grok-4.6", "Grok 4.6"),
            VendorSessionOptionKind::Model
        );
        assert_eq!(
            classify_vendor_session_option(Some("mode"), "high", "High Effort"),
            VendorSessionOptionKind::Effort
        );
        assert_eq!(
            classify_vendor_session_option(Some("mode"), "low", "Low Effort"),
            VendorSessionOptionKind::Effort
        );
        assert_eq!(
            classify_vendor_session_option(Some("mode"), "ls", "List"),
            VendorSessionOptionKind::Effort
        );
        assert_eq!(
            classify_vendor_session_option(None, "max", "Max"),
            VendorSessionOptionKind::Effort
        );
        assert_eq!(
            classify_vendor_session_option(None, "ultra", "Ultra"),
            VendorSessionOptionKind::Effort
        );
        assert_eq!(
            classify_vendor_session_option(Some("permission"), "default", "Ask"),
            VendorSessionOptionKind::Permission
        );
    }

    #[test]
    fn vendor_fallback_keeps_standard_model_and_adds_effort() {
        let meta = serde_json::json!({
            "x.ai/sessionConfig": {
                "options": [
                    { "id": "grok-4.6", "category": "model", "label": "Grok 4.6", "selected": true },
                    { "id": "high", "category": "mode", "label": "High Effort", "selected": true }
                ]
            }
        });
        let standard_options = Some(vec![AcpSessionConfigOption::select(
            "model",
            "Model",
            "sonnet",
            vec![
                agent_client_protocol::schema::v1::SessionConfigSelectOption::new(
                    "sonnet", "Sonnet",
                ),
            ],
        )]);

        let (_, config_options, vendor) =
            session_controls_with_vendor_fallback(None, standard_options, meta.as_object());

        assert_eq!(vendor, Some(VendorConfigWire::XaiSessionConfig));
        let options = config_options.expect("merged config");
        assert_eq!(options[0].id.0.as_ref(), "model");
        assert_eq!(options.len(), 2);
        assert_eq!(options[1].id.0.as_ref(), "effort");
        assert_eq!(
            options[1].category.as_ref(),
            Some(&SessionConfigOptionCategory::ThoughtLevel)
        );
    }

    #[test]
    fn vendor_fallback_does_not_duplicate_standard_thought_level() {
        let meta = serde_json::json!({
            "x.ai/sessionConfig": {
                "options": [
                    { "id": "grok-4.6", "category": "model", "label": "Grok 4.6", "selected": true },
                    { "id": "high", "category": "mode", "label": "High Effort", "selected": true }
                ]
            }
        });
        let standard_options = Some(vec![
            AcpSessionConfigOption::select(
                "model",
                "Model",
                "grok-4.6",
                vec![SessionConfigSelectOption::new("grok-4.6", "Grok 4.6")],
            )
            .category(Some(SessionConfigOptionCategory::Model)),
            AcpSessionConfigOption::select(
                "reasoning_effort",
                "Reasoning Effort",
                "high",
                vec![
                    SessionConfigSelectOption::new("high", "High"),
                    SessionConfigSelectOption::new("medium", "Medium"),
                ],
            )
            .category(Some(SessionConfigOptionCategory::ThoughtLevel)),
        ]);

        let (_, config_options, _) =
            session_controls_with_vendor_fallback(None, standard_options, meta.as_object());

        let options = config_options.expect("merged config");
        let thought_levels: Vec<_> = options
            .iter()
            .filter(|option| {
                option.category.as_ref() == Some(&SessionConfigOptionCategory::ThoughtLevel)
                    || option.id.0.as_ref() == "effort"
                    || option.id.0.as_ref() == "reasoning_effort"
            })
            .map(|option| option.id.0.to_string())
            .collect();
        assert_eq!(
            thought_levels,
            vec!["reasoning_effort"],
            "vendor 推理强度 must not sit beside the standard Reasoning Effort option"
        );
        assert_eq!(options.len(), 2);
    }

    #[test]
    fn vendor_low_effort_is_merged_into_standard_reasoning_effort() {
        let meta = serde_json::json!({
            "x.ai/sessionConfig": {
                "options": [
                    { "id": "grok-4.6", "category": "model", "label": "Grok 4.6", "selected": true },
                    { "id": "xhigh", "category": "mode", "label": "Extra High Effort", "selected": false },
                    { "id": "high", "category": "mode", "label": "High Effort", "selected": true },
                    { "id": "medium", "category": "mode", "label": "Medium Effort", "selected": false },
                    { "id": "low", "category": "mode", "label": "Low Effort", "selected": false }
                ]
            }
        });
        let standard_options = Some(vec![
            AcpSessionConfigOption::select(
                "model",
                "Model",
                "grok-4.6",
                vec![SessionConfigSelectOption::new("grok-4.6", "Grok 4.6")],
            )
            .category(Some(SessionConfigOptionCategory::Model)),
            AcpSessionConfigOption::select(
                "reasoning_effort",
                "Reasoning Effort",
                "high",
                vec![
                    SessionConfigSelectOption::new("high", "High"),
                    SessionConfigSelectOption::new("medium", "Medium"),
                ],
            )
            .category(Some(SessionConfigOptionCategory::ThoughtLevel)),
        ]);

        let (_, config_options, _) =
            session_controls_with_vendor_fallback(None, standard_options, meta.as_object());
        let options = config_options.expect("merged config");
        let effort = options
            .iter()
            .find(|option| option.id.0.as_ref() == "reasoning_effort")
            .expect("one thought_level option");
        let SessionConfigKind::Select(select) = &effort.kind else {
            panic!("effort option must be a select");
        };
        let SessionConfigSelectOptions::Ungrouped(choices) = &select.options else {
            panic!("effort options must be ungrouped");
        };
        let values: Vec<_> = choices
            .iter()
            .map(|choice| choice.value.0.to_string())
            .collect();
        assert!(
            values.contains(&"low".to_string()),
            "Grok Low Effort must remain selectable, got {values:?}"
        );
        assert!(values.contains(&"xhigh".to_string()));
        assert_eq!(
            find_config_override_selection(&options, "reasoning_effort", &serde_json::json!("low"))
                .map(|selection| selection.event_value),
            Some(serde_json::json!("low"))
        );
    }

    #[test]
    fn vendor_fallback_keeps_standard_permission_modes_and_adds_effort() {
        let meta = serde_json::json!({
            "x.ai/sessionConfig": {
                "options": [
                    { "id": "grok-4.6", "category": "model", "label": "Grok 4.6", "selected": true },
                    { "id": "high", "category": "mode", "label": "High Effort", "selected": true }
                ]
            }
        });
        let standard_modes = Some(SessionModeState::new(
            "auto",
            vec![agent_client_protocol::schema::v1::SessionMode::new(
                "auto", "Auto",
            )],
        ));

        let (modes, config_options, vendor) =
            session_controls_with_vendor_fallback(standard_modes, None, meta.as_object());

        assert_eq!(vendor, Some(VendorConfigWire::XaiSessionConfig));
        assert!(modes.is_some_and(|state| state.current_mode_id.0.as_ref() == "auto"));
        let options = config_options.expect("vendor config");
        assert!(
            options
                .iter()
                .any(|option| option.id.0.as_ref() == "effort")
        );
    }

    #[test]
    fn vendor_permission_options_become_session_modes() {
        let meta = serde_json::json!({
            "x.ai/sessionConfig": {
                "options": [
                    { "id": "default", "category": "permission", "label": "Ask", "selected": true },
                    { "id": "bypassPermissions", "category": "permission", "label": "Bypass" }
                ]
            }
        });
        let vendor = vendor_session_controls_from_meta(meta.as_object().unwrap())
            .expect("permission options parse");
        let modes = vendor.modes.expect("permission options become modes");
        assert_eq!(modes.current_mode_id.0.as_ref(), "default");
        assert_eq!(modes.available_modes.len(), 2);
        assert_eq!(modes.available_modes[1].id.0.as_ref(), "bypassPermissions");
    }

    #[test]
    fn vendor_fallback_maps_only_when_no_standard_config_is_advertised() {
        let meta = serde_json::json!({
            "x.ai/sessionConfig": {
                "options": [
                    { "id": "grok-4.6", "category": "model", "label": "Grok 4.6", "selected": true },
                    { "id": "high", "category": "mode", "label": "High Effort", "selected": true }
                ]
            }
        });

        let (modes, config_options, vendor) =
            session_controls_with_vendor_fallback(None, None, meta.as_object());

        assert_eq!(vendor, Some(VendorConfigWire::XaiSessionConfig));
        assert!(modes.is_none());
        let options = config_options.expect("vendor config");
        assert!(options.iter().any(|option| option.id.0.as_ref() == "model"));
        assert!(
            options
                .iter()
                .any(|option| option.id.0.as_ref() == "effort")
        );
    }

    #[test]
    fn grok_vendor_meta_without_config_returns_none() {
        assert!(vendor_session_controls_from_meta(&serde_json::Map::new()).is_none());
        let unrelated = serde_json::json!({ "other": "meta" });
        assert!(vendor_session_controls_from_meta(unrelated.as_object().unwrap()).is_none());
    }

    #[test]
    fn matches_model_override_to_acp_model_category_choices() {
        let options = vec![
            AcpSessionConfigOption::select(
                "preferred-model",
                "Model",
                "claude-opus-4-8",
                vec![
                    agent_client_protocol::schema::v1::SessionConfigSelectOption::new(
                        "claude-opus-4-8",
                        "Claude Opus 4.8",
                    ),
                    agent_client_protocol::schema::v1::SessionConfigSelectOption::new(
                        "claude-sonnet-4-5",
                        "Claude Sonnet 4.5",
                    ),
                ],
            )
            .category(Some(SessionConfigOptionCategory::Model)),
        ];

        let selection =
            find_config_override_selection(&options, "model", &serde_json::json!("sonnet"))
                .expect("sonnet should match ACP model choices");

        assert_eq!(selection.config_id, "preferred-model");
        assert_eq!(
            selection.event_value,
            serde_json::json!("claude-sonnet-4-5")
        );
        assert!(!selection.already_selected);
    }

    #[test]
    fn matches_permission_override_aliases_to_acp_choices() {
        let options = vec![AcpSessionConfigOption::select(
            "permission-mode",
            "Permissions",
            "ask",
            vec![
                agent_client_protocol::schema::v1::SessionConfigSelectOption::new("ask", "Ask"),
                agent_client_protocol::schema::v1::SessionConfigSelectOption::new(
                    "auto",
                    "Auto Approve",
                ),
            ],
        )];

        let selection =
            find_config_override_selection(&options, "permission_mode", &serde_json::json!("auto"))
                .expect("auto should match permission choices");

        assert_eq!(selection.config_id, "permission-mode");
        assert_eq!(selection.event_value, serde_json::json!("auto"));
        assert!(!selection.already_selected);
    }

    #[test]
    fn exact_codex_full_access_mode_wins_over_agent_prefix() {
        let options = vec![
            AcpSessionConfigOption::select(
                "mode",
                "Mode",
                "agent",
                vec![
                    agent_client_protocol::schema::v1::SessionConfigSelectOption::new(
                        "read-only",
                        "Read-only",
                    ),
                    agent_client_protocol::schema::v1::SessionConfigSelectOption::new(
                        "agent", "Agent",
                    ),
                    agent_client_protocol::schema::v1::SessionConfigSelectOption::new(
                        "agent-full-access",
                        "Agent (full access)",
                    ),
                ],
            )
            .category(Some(SessionConfigOptionCategory::Mode)),
        ];

        let selection = find_config_override_selection(
            &options,
            "mode",
            &serde_json::json!("agent-full-access"),
        )
        .expect("Codex full access should match an advertised choice");

        assert_eq!(
            selection.event_value,
            serde_json::json!("agent-full-access")
        );
        assert!(!selection.already_selected);
    }

    #[test]
    fn derived_session_modes_follow_a_mode_config_option_current_value() {
        let mut options = vec![
            AcpSessionConfigOption::select(
                "mode",
                "Mode",
                "agent",
                vec![
                    agent_client_protocol::schema::v1::SessionConfigSelectOption::new(
                        "agent", "Agent",
                    ),
                    agent_client_protocol::schema::v1::SessionConfigSelectOption::new(
                        "agent-full-access",
                        "Agent (full access)",
                    ),
                ],
            )
            .category(Some(SessionConfigOptionCategory::Mode)),
        ];
        let (modes, current) = session_modes_from_config_options(&options);
        assert_eq!(current.as_deref(), Some("agent"));
        assert!(modes.iter().any(|mode| mode.id == "agent-full-access"));

        apply_current_mode_to_config_options(&mut options, "agent-full-access");
        let (_, current) = session_modes_from_config_options(&options);
        assert_eq!(current.as_deref(), Some("agent-full-access"));
    }

    #[test]
    fn codex_mode_override_uses_config_option_when_legacy_modes_are_suppressed() {
        let controls = SessionControlState {
            config_options: vec![
                AcpSessionConfigOption::select(
                    "mode",
                    "Mode",
                    "agent",
                    vec![
                        agent_client_protocol::schema::v1::SessionConfigSelectOption::new(
                            "agent", "Agent",
                        ),
                        agent_client_protocol::schema::v1::SessionConfigSelectOption::new(
                            "agent-full-access",
                            "Agent (full access)",
                        ),
                    ],
                )
                .category(Some(SessionConfigOptionCategory::Mode)),
            ],
            vendor_config: None,
            mode_uses_set_mode: false,
            available_commands: None,
            ..Default::default()
        };

        let selection = find_config_override_selection(
            &controls.config_options,
            "mode",
            &serde_json::json!("agent-full-access"),
        )
        .expect("the unified mode intent must use the advertised config option");
        assert_eq!(selection.config_id, "mode");
        assert_eq!(
            selection.event_value,
            serde_json::json!("agent-full-access")
        );
    }

    #[test]
    fn maps_and_matches_boolean_session_config_options() {
        let option = AcpSessionConfigOption::boolean("fast", "Fast mode", false);
        let mapped = agent_session_config_options_from_acp(vec![option.clone()]);

        assert_eq!(mapped[0].value, Some(serde_json::json!(false)));
        assert_eq!(
            mapped[0]
                .choices
                .iter()
                .map(|choice| choice.value.clone())
                .collect::<Vec<_>>(),
            vec![serde_json::json!(false), serde_json::json!(true)]
        );

        let selection = find_config_override_selection(&[option], "fast", &serde_json::json!(true))
            .expect("boolean config should accept a JSON boolean");
        assert_eq!(selection.event_value, serde_json::json!(true));
        assert!(!selection.already_selected);
        assert_eq!(selection.wire_value.as_bool(), Some(true));
    }

    #[test]
    fn pending_session_id_is_used_before_session_map_binds() {
        let conversation = AgentSessionId::new();
        assert_eq!(
            resolve_agent_session_id(None, Some(conversation)),
            Some(conversation)
        );
        let mapped = AgentSessionId::new();
        assert_eq!(
            resolve_agent_session_id(Some(mapped), Some(conversation)),
            Some(mapped)
        );
        assert_eq!(resolve_agent_session_id(None, None), None);
    }

    #[test]
    fn resume_does_not_reuse_a_mapped_acp_session_with_a_different_id() {
        assert_eq!(
            mapped_resume_action(Some("acp-a"), "acp-a"),
            MappedResume::Reuse("acp-a".into())
        );
        assert_eq!(
            mapped_resume_action(Some("acp-b"), "acp-a"),
            MappedResume::LoadRequested { unbind_stale: true }
        );
        assert_eq!(
            mapped_resume_action(None, "acp-a"),
            MappedResume::LoadRequested {
                unbind_stale: false
            }
        );
    }

    /// Regression: `session/load` replays the agent's stored transcript as ordinary
    /// `session/update` notifications. Recording them duplicated every earlier AI
    /// message into the next turn ("用户 A - AI A - 用户 B - AI AB").
    #[test]
    fn transcript_updates_are_gated_during_session_restore_but_controls_are_not() {
        use agent_client_protocol::schema::v1::{
            AvailableCommandsUpdate, ContentChunk, CurrentModeUpdate, SessionModeId,
        };

        let transcript = [
            SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::from("hello"))),
            SessionUpdate::AgentThoughtChunk(ContentChunk::new(ContentBlock::from("thinking"))),
            SessionUpdate::UserMessageChunk(ContentChunk::new(ContentBlock::from("prompt"))),
        ];
        for update in transcript {
            assert!(
                is_session_transcript_update(&update),
                "{update:?} replays on session/load and must not be re-recorded"
            );
        }

        let controls = [
            SessionUpdate::CurrentModeUpdate(CurrentModeUpdate::new(SessionModeId::new("plan"))),
            SessionUpdate::AvailableCommandsUpdate(AvailableCommandsUpdate::new(Vec::new())),
        ];
        for update in controls {
            assert!(
                !is_session_transcript_update(&update),
                "{update:?} is session control state and must survive a restore"
            );
        }
    }

    #[test]
    fn maps_acp_available_commands_to_agent_payload() {
        let commands = vec![
            AcpAvailableCommand::new("compact", "Compact context").input(
                agent_client_protocol::schema::v1::AvailableCommandInput::Unstructured(
                    agent_client_protocol::schema::v1::UnstructuredCommandInput::new("focus"),
                ),
            ),
        ];

        let mapped = agent_available_commands_from_acp(commands);

        assert_eq!(mapped[0].name, "compact");
        assert_eq!(mapped[0].description.as_deref(), Some("Compact context"));
        assert!(mapped[0].input_schema.is_some());
    }

    #[test]
    fn agent_env_merge_prioritizes_config_then_proxy_over_defaults() {
        let configured = HashMap::from([
            ("NPM_CONFIG_LOGLEVEL".to_string(), "silent".to_string()),
            ("CUSTOM_ENV".to_string(), "from-config".to_string()),
            ("HTTP_PROXY".to_string(), "http://config-proxy".to_string()),
        ]);
        let merged = merge_agent_env(
            &configured,
            [
                ("HTTP_PROXY".to_string(), "http://proxy-setting".to_string()),
                (
                    "ALL_PROXY".to_string(),
                    "socks5://proxy-setting".to_string(),
                ),
            ],
        );

        assert_eq!(
            merged.get("NODE_NO_WARNINGS").map(String::as_str),
            Some("1")
        );
        assert_eq!(
            merged.get("NPM_CONFIG_LOGLEVEL").map(String::as_str),
            Some("silent")
        );
        assert_eq!(
            merged.get("CUSTOM_ENV").map(String::as_str),
            Some("from-config")
        );
        assert_eq!(
            merged.get("HTTP_PROXY").map(String::as_str),
            Some("http://proxy-setting")
        );
        assert_eq!(
            merged.get("ALL_PROXY").map(String::as_str),
            Some("socks5://proxy-setting")
        );
    }

    #[test]
    fn detected_system_proxy_fills_agent_proxy_env() {
        let env = proxy_env_from_detected(Some(&DetectedProxy {
            url: "http://127.0.0.1:7897".to_string(),
            source: ProxySource::System,
        }));
        assert_eq!(
            env.iter()
                .find(|(key, _)| key == "HTTPS_PROXY")
                .map(|(_, value)| value.as_str()),
            Some("http://127.0.0.1:7897")
        );
        assert_eq!(
            env.iter()
                .find(|(key, _)| key == "NO_PROXY")
                .map(|(_, value)| value.as_str()),
            Some("localhost,127.0.0.1,::1")
        );
        assert_eq!(
            env.iter()
                .find(|(key, _)| key == "no_proxy")
                .map(|(_, value)| value.as_str()),
            Some("localhost,127.0.0.1,::1")
        );
        assert!(proxy_url_env_present(&env));
    }

    #[test]
    fn ensure_no_proxy_loopback_preserves_custom_hosts_and_adds_loopback() {
        let mut env = vec![
            (
                "HTTPS_PROXY".to_string(),
                "http://127.0.0.1:7897".to_string(),
            ),
            ("NO_PROXY".to_string(), "corp.internal,10.0.0.1".to_string()),
        ];
        ensure_no_proxy_loopback(&mut env);
        assert_eq!(
            env.iter()
                .find(|(key, _)| key == "NO_PROXY")
                .map(|(_, value)| value.as_str()),
            Some("corp.internal,10.0.0.1,localhost,127.0.0.1,::1")
        );
        assert_eq!(
            env.iter()
                .find(|(key, _)| key == "no_proxy")
                .map(|(_, value)| value.as_str()),
            Some("corp.internal,10.0.0.1,localhost,127.0.0.1,::1")
        );
    }

    #[test]
    fn pac_detection_does_not_fill_agent_proxy_env() {
        let env = proxy_env_from_detected(Some(&DetectedProxy {
            url: "http://wpad.example/proxy.pac".to_string(),
            source: ProxySource::Pac,
        }));
        assert!(env.is_empty());
    }

    #[tokio::test]
    async fn sweep_idle_skips_connecting_connections() {
        let (event_tx, _event_rx) = manager_event_channel();
        let manager = AgentConnectionManager::new_with_driver(event_tx, false);
        let (snapshot, ready_rx) = manager
            .register_connection(AgentConnectionLaunch {
                connection_id: AgentConnectionId::new(),
                agent_id: AgentId::parse("codex").unwrap(),
                launch_lock: test_launch_lock(AgentId::parse("codex").unwrap()),
                workspace_id: uuid::Uuid::new_v4(),
                working_dir: std::env::temp_dir(),
                additional_directories: Vec::new(),
                auto_approve_mode: AgentAutoApproveMode::Off,
                env: HashMap::new(),
            })
            .await;
        ready_rx.await.unwrap().unwrap();

        manager
            .set_connection_status(snapshot.connection_id, AgentConnectionStatus::Connecting)
            .await;
        assert_eq!(manager.sweep_idle(Duration::from_secs(0)).await, 0);

        manager
            .set_connection_status(snapshot.connection_id, AgentConnectionStatus::Ready)
            .await;
        assert_eq!(manager.sweep_idle(Duration::from_secs(0)).await, 1);
    }

    async fn ready_connection(manager: &AgentConnectionManager) -> AgentConnectionId {
        let (snapshot, ready_rx) = manager
            .register_connection(AgentConnectionLaunch {
                connection_id: AgentConnectionId::new(),
                agent_id: AgentId::parse("codex").unwrap(),
                launch_lock: test_launch_lock(AgentId::parse("codex").unwrap()),
                workspace_id: uuid::Uuid::new_v4(),
                working_dir: std::env::temp_dir(),
                additional_directories: Vec::new(),
                auto_approve_mode: AgentAutoApproveMode::Off,
                env: HashMap::new(),
            })
            .await;
        ready_rx.await.unwrap().unwrap();
        manager
            .set_connection_status(snapshot.connection_id, AgentConnectionStatus::Ready)
            .await;
        snapshot.connection_id
    }

    #[tokio::test]
    async fn sweep_idle_keeps_hot_group_sessions_past_default_timeout() {
        let (event_tx, _event_rx) = manager_event_channel();
        let manager = AgentConnectionManager::new_with_driver(event_tx, false);
        let hot_connection = ready_connection(&manager).await;
        let cold_connection = ready_connection(&manager).await;
        let dm_connection = ready_connection(&manager).await;
        let hot_session = AgentSessionId::new();
        let cold_session = AgentSessionId::new();
        let dm_session = AgentSessionId::new();
        manager
            .bind_known_acp_session(hot_connection, hot_session, "acp-hot".into())
            .await;
        manager
            .bind_known_acp_session(cold_connection, cold_session, "acp-cold".into())
            .await;
        manager
            .bind_known_acp_session(dm_connection, dm_session, "acp-dm".into())
            .await;
        let idle = Duration::from_secs(180);
        manager
            .set_last_activity_elapsed(hot_connection, Duration::from_secs(200))
            .await;
        manager
            .set_last_activity_elapsed(cold_connection, Duration::from_secs(200))
            .await;
        manager
            .set_last_activity_elapsed(dm_connection, Duration::from_secs(200))
            .await;

        let mut hot = HashSet::new();
        hot.insert(hot_session);
        assert_eq!(
            manager
                .sweep_idle_with_extended(idle, Some((hot.clone(), Duration::from_secs(20 * 60))),)
                .await,
            2,
            "cold group and DM use the ordinary 180s timeout"
        );
        assert_eq!(
            manager
                .sweep_idle_with_extended(idle, Some((hot, Duration::from_secs(20 * 60))))
                .await,
            0,
            "hot group member stays until the extended timeout"
        );
        assert_eq!(
            manager.sweep_idle(idle).await,
            1,
            "once the group is cold the next sweep uses the ordinary rule"
        );
    }

    #[test]
    fn handshake_timeout_uses_default_for_missing_or_invalid_env() {
        assert_eq!(
            handshake_timeout_from_env_value(None),
            Duration::from_secs(DEFAULT_HANDSHAKE_TIMEOUT_SECS)
        );
        assert_eq!(
            handshake_timeout_from_env_value(Some("0")),
            Duration::from_secs(DEFAULT_HANDSHAKE_TIMEOUT_SECS)
        );
        assert_eq!(
            handshake_timeout_from_env_value(Some("not-a-number")),
            Duration::from_secs(DEFAULT_HANDSHAKE_TIMEOUT_SECS)
        );
    }

    #[test]
    fn handshake_timeout_accepts_positive_env_value() {
        assert_eq!(
            handshake_timeout_from_env_value(Some("7")),
            Duration::from_secs(7)
        );
    }

    #[test]
    fn prompt_idle_timeout_is_disabled_when_unset_zero_or_invalid() {
        assert_eq!(prompt_idle_timeout_from_env_value(None), None);
        assert_eq!(prompt_idle_timeout_from_env_value(Some("0")), None);
        assert_eq!(prompt_idle_timeout_from_env_value(Some("nope")), None);
        assert_eq!(prompt_idle_timeout_from_env_value(Some("  ")), None);
    }

    #[test]
    fn prompt_idle_timeout_defaults_when_env_is_unset_and_can_be_disabled() {
        assert_eq!(
            prompt_idle_timeout_from_env(None),
            Some(Duration::from_secs(DEFAULT_PROMPT_IDLE_TIMEOUT_SECS))
        );
        assert_eq!(
            prompt_idle_timeout_from_env(Some("")),
            Some(Duration::from_secs(DEFAULT_PROMPT_IDLE_TIMEOUT_SECS))
        );
        assert_eq!(prompt_idle_timeout_from_env(Some("0")), None);
        assert_eq!(
            prompt_idle_timeout_from_env(Some("30")),
            Some(Duration::from_secs(30))
        );
    }

    #[test]
    fn prompt_idle_timeout_accepts_positive_env_value() {
        assert_eq!(
            prompt_idle_timeout_from_env_value(Some("120")),
            Some(Duration::from_secs(120))
        );
    }

    #[test]
    fn prompt_idle_watchdog_skips_permission_elicitation_and_live_terminals() {
        assert!(!prompt_idle_watchdog_blocked(false, false, false));
        assert!(prompt_idle_watchdog_blocked(true, false, false));
        assert!(prompt_idle_watchdog_blocked(false, true, false));
        assert!(prompt_idle_watchdog_blocked(false, false, true));
    }

    #[test]
    fn wait_for_terminal_exit_must_run_off_the_dispatch_loop() {
        let wait = AgentRequest::WaitForTerminalExitRequest(
            agent_client_protocol::schema::v1::WaitForTerminalExitRequest::new(
                SessionId::new("session-1"),
                TerminalId::new("term-1"),
            ),
        );
        assert!(acp_request_must_run_off_dispatch_loop(&wait));
        assert!(!acp_request_must_run_off_dispatch_loop(
            &AgentRequest::KillTerminalRequest(KillTerminalRequest::new(
                SessionId::new("session-1"),
                TerminalId::new("term-1"),
            ))
        ));
    }

    #[test]
    fn question_requests_must_run_off_the_dispatch_loop() {
        let grok_ask = AgentRequest::ExtMethodRequest(ExtRequest::new(
            "_x.ai/ask_user_question",
            serde_json::value::to_raw_value(&serde_json::json!({
                "sessionId": "session-1",
                "questions": [{ "question": "Pick one", "options": [] }]
            }))
            .expect("raw params")
            .into(),
        ));
        assert!(
            acp_request_must_run_off_dispatch_loop(&grok_ask),
            "Grok ask_user_question waits for the user; answering it inline freezes session/update so the agent times out and treats the question as cancelled"
        );

        let elicitation: CreateElicitationRequest = serde_json::from_value(serde_json::json!({
            "mode": "form",
            "message": "Pick one",
            "sessionId": "session-1",
            "requestedSchema": { "type": "object", "properties": {} }
        }))
        .expect("elicitation/create");
        assert!(
            acp_request_must_run_off_dispatch_loop(&AgentRequest::CreateElicitationRequest(
                elicitation
            )),
            "elicitation/create waits for the user the same way as vendor question ext-methods"
        );

        assert!(!acp_request_must_run_off_dispatch_loop(
            &AgentRequest::KillTerminalRequest(KillTerminalRequest::new(
                SessionId::new("session-1"),
                TerminalId::new("term-1"),
            ))
        ));
    }

    #[test]
    fn proxy_env_keys_include_no_proxy_both_cases() {
        // NO_PROXY/no_proxy must be forwarded to the agent child so proxy bypass
        // rules (e.g. for internal hosts) reach Codex on a proxied/China network.
        assert!(PROXY_ENV_KEYS.contains(&"NO_PROXY"));
        assert!(PROXY_ENV_KEYS.contains(&"no_proxy"));
        assert!(PROXY_ENV_KEYS.contains(&"HTTPS_PROXY"));
        assert!(PROXY_ENV_KEYS.contains(&"https_proxy"));
    }

    #[test]
    fn stderr_tail_redacts_and_summarizes_recent_lines() {
        let tail = StderrTail::new();

        tail.push("first line");
        tail.push("api_key=sk-live-abcdefghijklmnop");

        assert_eq!(
            tail.summary().as_deref(),
            Some("first line\napi_key=<redacted>")
        );
    }

    #[test]
    fn handshake_timeout_error_includes_recent_stderr_when_present() {
        let message =
            format_handshake_timeout_error(Duration::from_secs(3), Some("last line".to_string()));

        assert!(message.contains("3s"));
        assert!(message.contains("last line"));
    }

    #[test]
    fn session_prep_timeout_uses_default_for_missing_or_invalid_env() {
        assert_eq!(
            session_prep_timeout_from_env_value(None),
            Duration::from_secs(DEFAULT_SESSION_PREP_TIMEOUT_SECS)
        );
        assert_eq!(
            session_prep_timeout_from_env_value(Some("0")),
            Duration::from_secs(DEFAULT_SESSION_PREP_TIMEOUT_SECS)
        );
        assert_eq!(
            session_prep_timeout_from_env_value(Some("not-a-number")),
            Duration::from_secs(DEFAULT_SESSION_PREP_TIMEOUT_SECS)
        );
    }

    #[test]
    fn session_prep_timeout_accepts_positive_env_value() {
        assert_eq!(
            session_prep_timeout_from_env_value(Some("12")),
            Duration::from_secs(12)
        );
    }

    #[tokio::test]
    async fn session_prep_times_out_when_the_agent_never_replies() {
        let (_tx, rx) = tokio::sync::oneshot::channel::<AgentResult<()>>();
        let error = await_command_result(
            rx,
            Duration::from_millis(20),
            "agent connection closed before ACP session preparation completed",
            format_session_prep_timeout_error(Duration::from_secs(20)),
        )
        .await
        .expect_err("hanging session/new must surface a timeout");
        let message = error.to_string();
        assert!(message.contains("session preparation timed out"));
        assert!(message.contains("20s"));
    }

    #[tokio::test]
    async fn process_death_wins_over_simultaneous_acp_success() {
        let stop = wait_for_acp_or_process_death(
            async { Ok::<(), ()>(()) },
            std::future::pending(),
            async {},
        )
        .await;
        // Stdout EOF no longer outranks a live protocol loop: a pipe stall
        // must not kill a Prompting connection. The quiet-Ok-while-in-flight
        // case is still a connection_closed via resolve_acp_process_stop.
        assert!(matches!(stop, AcpProcessStop::Connection(Ok(()))));
    }

    #[tokio::test]
    async fn acp_completion_wins_when_the_process_is_still_alive() {
        let stop = wait_for_acp_or_process_death(
            async { Ok::<(), ()>(()) },
            std::future::pending(),
            std::future::pending(),
        )
        .await;
        assert!(matches!(stop, AcpProcessStop::Connection(Ok(()))));
    }

    #[tokio::test]
    async fn stdout_eof_fails_a_pending_acp_connection() {
        let stop = tokio::time::timeout(
            Duration::from_secs(2),
            wait_for_acp_or_process_death(
                std::future::pending::<Result<(), ()>>(),
                std::future::pending(),
                async {},
            ),
        )
        .await
        .expect("stdout-EOF grace should settle");
        assert!(matches!(stop, AcpProcessStop::StdoutClosed));
    }

    #[tokio::test]
    async fn stdout_eof_does_not_kill_a_live_protocol_loop() {
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let acp = async {
            release_rx.await.ok();
            Ok::<(), ()>(())
        };
        let wait = wait_for_acp_or_process_death(acp, std::future::pending(), async {});
        tokio::pin!(wait);
        tokio::select! {
            stop = &mut wait => {
                panic!("stdout EOF must wait for the protocol loop, got {stop:?}");
            }
            _ = tokio::time::sleep(Duration::from_millis(50)) => {}
        }
        let _ = release_tx.send(());
        let stop = wait.await;
        assert!(matches!(stop, AcpProcessStop::Connection(Ok(()))));
    }

    #[test]
    fn acp_success_while_a_turn_is_in_flight_is_connection_closed() {
        let error =
            resolve_acp_process_stop(AcpProcessStop::Connection(Ok::<(), &str>(())), true, None)
                .expect_err("an in-flight turn must not survive a quiet ACP shutdown");
        assert!(error.is_connection_death());
        let event = turn_error_event_from_connection_failure(&error);
        assert_eq!(event.message, CONNECTION_CLOSED_TURN_MESSAGE);
        assert_eq!(event.code.as_deref(), Some("connection_closed"));
    }

    #[test]
    fn acp_success_without_a_turn_is_ok() {
        resolve_acp_process_stop(AcpProcessStop::Connection(Ok::<(), &str>(())), false, None)
            .expect("a clean shutdown with no turn must stay success");
    }

    #[test]
    fn connection_closed_without_a_prompt_is_not_an_in_flight_turn_failure() {
        assert!(
            !agent_error_is_in_flight_turn_failure("connection_closed", None, None),
            "warmup or idle ACP death must not log as a failed turn"
        );
        assert!(agent_error_is_in_flight_turn_failure(
            "connection_closed",
            Some(AgentSessionId::new()),
            Some(AgentPromptId::new()),
        ));
        assert!(!agent_error_is_in_flight_turn_failure(
            "agent_not_installed",
            Some(AgentSessionId::new()),
            Some(AgentPromptId::new()),
        ));
    }

    #[test]
    fn process_death_turn_error_uses_connection_closed_code() {
        let error = connection_closed_error(
            "ACP agent process exited (exit status: 1)",
            Some("fatal".into()),
        );
        let event = turn_error_event_from_connection_failure(&error);
        assert_eq!(event.message, CONNECTION_CLOSED_TURN_MESSAGE);
        assert_eq!(event.code.as_deref(), Some("connection_closed"));
        assert_eq!(
            event.raw.as_ref().and_then(|raw| raw.get("detail")),
            Some(&serde_json::json!(
                "agent connection closed: ACP agent process exited (exit status: 1). Recent stderr: fatal"
            ))
        );
    }

    #[test]
    fn acp_transport_failure_during_a_turn_is_connection_closed() {
        let error = AgentError::Runtime("ACP connection failed: broken pipe".into());
        let event = turn_error_event_from_connection_failure(&error);
        assert_eq!(event.message, CONNECTION_CLOSED_TURN_MESSAGE);
        assert_eq!(event.code.as_deref(), Some("connection_closed"));
    }

    #[test]
    fn handshake_timeout_stays_an_internal_turn_error() {
        let error =
            AgentError::Runtime(format_handshake_timeout_error(Duration::from_secs(5), None));
        let event = turn_error_event_from_connection_failure(&error);
        assert!(event.message.contains("ACP handshake timed out"));
        assert_eq!(event.code.as_deref(), Some("internal_error"));
    }

    #[test]
    fn session_load_errors_classify_by_real_acp_code() {
        // ResourceNotFound (-32002) → expired session.
        assert!(matches!(
            classify_session_load_error(&acp::Error::resource_not_found(None)),
            SessionLoadFailureReason::ResourceNotFound
        ));
        // AuthRequired (-32000) → re-auth.
        assert!(matches!(
            classify_session_load_error(&acp::Error::auth_required()),
            SessionLoadFailureReason::AuthenticationRequired { .. }
        ));
        // Anything else → Other, with the message preserved.
        assert!(matches!(
            classify_session_load_error(&acp::Error::invalid_params()),
            SessionLoadFailureReason::Other { .. }
        ));
        // Auth is code-only: message text must not classify as auth.
        assert!(
            classify_session_load_failure_fragments("Authentication required", "sid").is_none()
        );
    }

    #[test]
    fn session_load_failure_fragments_lock_codeg_arms() {
        assert!(matches!(
            classify_session_load_failure_fragments(
                "session abc is archived. Run `codex unarchive abc`",
                "abc"
            ),
            Some(SessionLoadFailureReason::SessionArchived { recovery_command })
                if recovery_command.as_deref() == Some("codex unarchive abc")
        ));
        assert!(matches!(
            classify_session_load_failure_fragments(
                "thread xyz already has an active writer",
                "xyz"
            ),
            Some(SessionLoadFailureReason::SessionBusy)
        ));
        assert!(matches!(
            classify_session_load_failure_fragments(
                "Claude Code process exited with code 1",
                "sid"
            ),
            Some(SessionLoadFailureReason::SessionUnavailable)
        ));
        assert!(matches!(
            classify_session_load_failure_fragments("session has ended", "sid"),
            Some(SessionLoadFailureReason::SessionUnavailable)
        ));
        assert!(matches!(
            classify_session_load_failure_fragments("Session not found", "sid"),
            Some(SessionLoadFailureReason::SessionUnavailable)
        ));
        assert!(
            classify_session_load_failure_fragments("Authentication required", "sid").is_none()
        );
        assert!(classify_session_load_failure_fragments("Method not found", "sid").is_none());
        assert!(matches!(
            classify_session_load_failure_fragments(
                r#"Invalid params: "session load was superseded""#,
                "sid"
            ),
            Some(SessionLoadFailureReason::SessionBusy)
        ));
        assert!(matches!(
            classify_session_load_failure_fragments(
                r#"Permission denied.: { "detail": "拒绝访问。 (os error 5)", "code": "FS_PERMISSION_DENIED" }"#,
                "sid"
            ),
            Some(SessionLoadFailureReason::SessionBusy)
        ));
    }

    #[test]
    fn recovers_load_failure_locally_is_custom_and_never_busy() {
        let custom = AgentId::parse("my-custom-agent").unwrap();
        let codex = AgentId::parse("codex").unwrap();
        assert!(recovers_load_failure_locally(
            &custom,
            Some(&SessionLoadFailureReason::ResourceNotFound)
        ));
        assert!(!recovers_load_failure_locally(
            &codex,
            Some(&SessionLoadFailureReason::ResourceNotFound)
        ));
        assert!(!recovers_load_failure_locally(
            &custom,
            Some(&SessionLoadFailureReason::SessionBusy)
        ));
        assert!(!recovers_load_failure_locally(&custom, None));
    }

    #[test]
    fn session_load_failure_decision_table_matches_d3() {
        let custom = AgentId::parse("my-custom-agent").unwrap();
        let codex = AgentId::parse("codex").unwrap();
        let auth = SessionLoadFailureReason::AuthenticationRequired {
            message: "login".into(),
        };
        assert_eq!(
            decide_session_load_failure(&codex, &auth, None, true, false),
            SessionLoadFailureAction::StopForAuth {
                message: "login".into()
            }
        );
        assert_eq!(
            decide_session_load_failure(
                &codex,
                &SessionLoadFailureReason::ResourceNotFound,
                Some(&SessionLoadFailureReason::ResourceNotFound),
                true,
                false
            ),
            SessionLoadFailureAction::Banner(SessionLoadFailureReason::ResourceNotFound)
        );
        assert_eq!(
            decide_session_load_failure(
                &custom,
                &SessionLoadFailureReason::Other {
                    message: "gone".into()
                },
                Some(&SessionLoadFailureReason::ResourceNotFound),
                true,
                false
            ),
            SessionLoadFailureAction::SilentNew
        );
        assert_eq!(
            decide_session_load_failure(
                &custom,
                &SessionLoadFailureReason::Other {
                    message: "busy".into()
                },
                Some(&SessionLoadFailureReason::SessionBusy),
                true,
                false
            ),
            SessionLoadFailureAction::Banner(SessionLoadFailureReason::SessionBusy)
        );
        assert_eq!(
            decide_session_load_failure(
                &codex,
                &SessionLoadFailureReason::Other {
                    message: "nope".into()
                },
                None,
                true,
                false
            ),
            SessionLoadFailureAction::ToastThenNew
        );
        assert_eq!(
            decide_session_load_failure(
                &codex,
                &SessionLoadFailureReason::Other {
                    message: "Method not found".into()
                },
                None,
                true,
                true
            ),
            SessionLoadFailureAction::SilentNew
        );
        assert_eq!(
            decide_session_load_failure(
                &codex,
                &SessionLoadFailureReason::Other {
                    message: "no load".into()
                },
                None,
                false,
                false
            ),
            SessionLoadFailureAction::SilentNew
        );
        let grok = AgentId::parse("grok").unwrap();
        let superseded = r#"Invalid params: "session load was superseded""#;
        let classified_busy = classify_session_load_failure_fragments(superseded, "sid");
        assert_eq!(
            decide_session_load_failure(
                &grok,
                &SessionLoadFailureReason::Other {
                    message: superseded.into()
                },
                classified_busy.as_ref(),
                true,
                false
            ),
            SessionLoadFailureAction::Banner(SessionLoadFailureReason::SessionBusy)
        );
        let permission_denied = r#"Permission denied.: { "detail": "拒绝访问。 (os error 5)", "code": "FS_PERMISSION_DENIED" }"#;
        let classified_permission =
            classify_session_load_failure_fragments(permission_denied, "sid");
        assert_eq!(
            decide_session_load_failure(
                &grok,
                &SessionLoadFailureReason::Other {
                    message: permission_denied.into()
                },
                classified_permission.as_ref(),
                true,
                false
            ),
            SessionLoadFailureAction::Banner(SessionLoadFailureReason::SessionBusy)
        );
        // Restoring a known sid maps SilentNew/ToastThenNew to a load-failed
        // banner. session/new is only for conversations that never had a thread.
    }

    #[test]
    fn session_new_after_load_maps_fs_permission_denied_to_busy() {
        let error = acp::Error::new(-32603, "Permission denied.").data(serde_json::json!({
            "detail": "拒绝访问。 (os error 5)",
            "code": "FS_PERMISSION_DENIED"
        }));
        assert!(matches!(
            map_acp_session_error("ACP session/new after load failed", error),
            AgentError::SessionLoadFailed(SessionLoadFailureReason::SessionBusy)
        ));
        let superseded = acp::Error::new(-32602, r#"session load was superseded"#);
        assert!(matches!(
            map_acp_session_error("ACP session/new after load failed", superseded),
            AgentError::SessionLoadFailed(SessionLoadFailureReason::SessionBusy)
        ));
    }

    #[test]
    fn acp_error_codes_map_to_stable_strings() {
        assert_eq!(
            acp_error_code_str(&acp::Error::auth_required()).as_deref(),
            Some("auth_required")
        );
        assert_eq!(
            acp_error_code_str(&acp::Error::resource_not_found(None)).as_deref(),
            Some("resource_not_found")
        );
        assert_eq!(
            acp_error_code_str(&acp::Error::method_not_found()).as_deref(),
            Some("method_not_found")
        );
    }

    #[test]
    fn steering_wire_outcomes_map_without_silent_fallback() {
        assert_eq!(
            map_steer_response(AcpSteerResponse {
                outcome: "injected".to_string(),
                reason: None,
            })
            .expect("injected receipt")
            .outcome,
            AgentSteerOutcome::Injected
        );
        assert_eq!(
            map_steer_response(AcpSteerResponse {
                outcome: "promptRequired".to_string(),
                reason: Some("noRunningTurn".to_string()),
            })
            .expect("idle receipt")
            .outcome,
            AgentSteerOutcome::PromptRequired
        );
        assert!(
            map_steer_response(AcpSteerResponse {
                outcome: "futureOutcome".to_string(),
                reason: None,
            })
            .is_err()
        );
    }

    #[test]
    fn kiro_models_and_reasoning_synthesize_session_controls() {
        let raw_reply = serde_json::json!({
            "sessionId": "kiro-sess-1",
            "modes": {
                "currentModeId": "kiro_default",
                "availableModes": [
                    { "id": "kiro_default", "name": "Default", "description": "Standard Kiro agent" },
                    { "id": "kiro_planner", "name": "Planner", "description": "Plan before coding" }
                ]
            },
            "models": {
                "currentModelId": "claude-sonnet-4.5",
                "availableModels": [
                    { "modelId": "auto", "name": "Auto", "description": "Automatic model selection" },
                    { "modelId": "claude-sonnet-4.5", "name": "Claude Sonnet 4.5", "description": "Balanced" }
                ]
            }
        });
        let (response, raw_models) =
            deserialize_raw_session_response::<NewSessionResponse>(raw_reply)
                .expect("deserialize raw session/new reply");
        let (modes, config_options, vendor_config) =
            session_controls_with_models_and_vendor_fallback(
                response.modes,
                response.config_options,
                response.meta.as_ref(),
                raw_models.as_ref(),
                "kiro",
            );
        assert_eq!(vendor_config, Some(VendorConfigWire::KiroSessionConfig));
        let (mut unified, mode_uses_set_mode) = unify_session_config_options(
            modes,
            config_options.unwrap_or_default(),
            vendor_config.is_some(),
        );
        assert!(mode_uses_set_mode);
        assert_eq!(unified.len(), 2);
        assert_eq!(unified[0].id.0.as_ref(), "mode");
        assert_eq!(unified[1].id.0.as_ref(), "model");

        let reasoning = parse_kiro_reasoning(&serde_json::json!({
            "support": "toggleable",
            "thinkingEnabled": true,
            "effortLevels": ["low", "medium", "high", "max"],
            "effort": "high"
        }));
        place_kiro_reasoning_selectors(&mut unified, &reasoning);
        let mapped = agent_session_config_options_from_acp(unified);
        let keys: Vec<&str> = mapped.iter().map(|opt| opt.key.as_str()).collect();
        assert_eq!(keys, ["mode", "model", "thinking", "effort"]);
        assert_eq!(
            mapped[1].value,
            Some(serde_json::json!("claude-sonnet-4.5"))
        );
        assert_eq!(mapped[2].value, Some(serde_json::json!("on")));
        assert_eq!(mapped[3].value, Some(serde_json::json!("high")));

        let effort_req = KiroExecuteCommandRequest::effort(SessionId::new("kiro-sess-1"), "max");
        assert_eq!(
            serde_json::to_value(&effort_req).unwrap(),
            serde_json::json!({
                "sessionId": "kiro-sess-1",
                "command": {
                    "command": "effort",
                    "args": { "level": "max" }
                }
            })
        );
        let thinking_req =
            KiroExecuteCommandRequest::thinking(SessionId::new("kiro-sess-1"), false);
        assert_eq!(
            serde_json::to_value(&thinking_req).unwrap(),
            serde_json::json!({
                "sessionId": "kiro-sess-1",
                "command": {
                    "command": "reasoning",
                    "args": { "thinkingEnabled": false }
                }
            })
        );
    }

    /// Antigravity 1.4+ advertises family ids on the standard `model` selector
    /// (`gemini-4-argon`) plus a `thinking_level` option, while the same reply
    /// still lists concrete variants in top-level `models.availableModels`.
    /// That list is Kiro's catalog only for Kiro; treating it as
    /// `KiroSessionConfig` sends `session/set_model` with the family id, which
    /// oauth-personal rejects as "not available for the current authentication
    /// method".
    fn antigravity_family_options() -> Vec<AcpSessionConfigOption> {
        vec![
            AcpSessionConfigOption::select(
                "model",
                "Model",
                "gemini-3.8-flash",
                vec![
                    SessionConfigSelectOption::new("gemini-3.8-flash", "Gemini 3.8 Flash"),
                    SessionConfigSelectOption::new("gemini-4-argon", "Gemini 4 Argon"),
                ],
            )
            .category(Some(SessionConfigOptionCategory::Model)),
            AcpSessionConfigOption::select(
                "thinking_level",
                "Thinking",
                "high",
                vec![
                    SessionConfigSelectOption::new("low", "Low"),
                    SessionConfigSelectOption::new("medium", "Medium"),
                    SessionConfigSelectOption::new("high", "High"),
                ],
            )
            .category(Some(SessionConfigOptionCategory::ThoughtLevel)),
        ]
    }

    fn antigravity_variant_models() -> serde_json::Value {
        serde_json::json!({
            "currentModelId": "gemini-3.8-flash-high",
            "availableModels": [
                {"modelId": "gemini-3.8-flash-high", "name": "Gemini 3.8 Flash"},
                {"modelId": "gemini-3.8-flash-low"},
                {"modelId": "gemini-3.8-flash-medium"},
                {"modelId": "gemini-4-argon-high"},
                {"modelId": "gemini-4-argon-low"},
                {"modelId": "gemini-4-argon-medium"}
            ]
        })
    }

    #[test]
    fn antigravity_available_models_do_not_switch_vendor_wire_to_kiro() {
        let (_, options, vendor_config) = session_controls_with_models_and_vendor_fallback(
            None,
            Some(antigravity_family_options()),
            None,
            Some(&antigravity_variant_models()),
            "antigravity",
        );
        assert_eq!(
            vendor_config, None,
            "Antigravity keeps session/set_config_option; availableModels is not a Kiro catalog"
        );
        let options = options.expect("standard config options");
        let selection = find_config_override_selection_for_agent(
            &options,
            Some(AgentKind::Antigravity),
            "model",
            &serde_json::json!("gemini-4-argon"),
            &[],
        )
        .expect("family id is a selector row");
        assert_eq!(selection.config_id, "model");
        assert_eq!(selection.event_value, serde_json::json!("gemini-4-argon"));
    }

    #[test]
    fn only_antigravity_replays_a_model_its_flat_list_still_offers() {
        let options = antigravity_family_options();
        let (model, level) = (&options[0], &options[1]);
        let models = session_model_ids(Some(&antigravity_variant_models()));
        let saved = "gemini-4-argon-high";

        assert!(config_option_rejects_value(model, saved));
        assert!(session_model_list_offers(
            Some(AgentKind::Antigravity),
            model,
            saved,
            &models
        ));
        assert!(!session_model_list_offers(
            Some(AgentKind::Antigravity),
            model,
            "gemini-2.5-pro",
            &models
        ));
        assert!(!session_model_list_offers(
            Some(AgentKind::Antigravity),
            model,
            saved,
            &[]
        ));
        assert!(!session_model_list_offers(
            Some(AgentKind::Antigravity),
            level,
            saved,
            &models
        ));
        for agent in [
            Some(AgentKind::ClaudeCode),
            Some(AgentKind::Codex),
            Some(AgentKind::Opencode),
            Some(AgentKind::Grok),
            Some(AgentKind::Kiro),
            None,
        ] {
            assert!(
                !session_model_list_offers(agent, model, saved, &models),
                "{agent:?}"
            );
        }

        let selection = find_config_override_selection_for_agent(
            &options,
            Some(AgentKind::Antigravity),
            "model",
            &serde_json::json!(saved),
            &models,
        )
        .expect("variant id still offered in the flat list is sent as saved");
        assert_eq!(selection.event_value, serde_json::json!(saved));
    }

    #[test]
    fn antigravity_saved_variant_id_is_replayed_from_the_flat_model_list() {
        let options = antigravity_family_options();
        let models = session_model_ids(Some(&antigravity_variant_models()));
        let overrides = vec![
            AgentSessionConfigOverride {
                key: "thinking_level".to_string(),
                value: "medium".to_string(),
            },
            AgentSessionConfigOverride {
                key: "model".to_string(),
                value: "gemini-4-argon-high".to_string(),
            },
        ];
        let (_, config_to_apply, _) = prepare_preferred_controls_for_replay(
            Some(AgentKind::Antigravity),
            None,
            &options,
            None,
            &overrides,
            &models,
        );
        assert_eq!(
            config_to_apply
                .iter()
                .map(|item| (item.key.as_str(), item.value.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("model", "gemini-4-argon-high"),
                ("thinking_level", "medium"),
            ]
        );
    }

    #[test]
    fn kiro_available_commands_filters_tui_only_and_includes_prompts() {
        let params = serde_json::json!({
            "sessionId": "kiro-sess-1",
            "commands": [
                { "name": "/compact", "description": "Compact context", "meta": { "local": false } },
                { "name": "/quit", "description": "Exit TUI", "meta": { "local": true } },
                { "name": "/rewind", "description": "Rewind", "meta": { "local": false } },
                { "name": "/knowledge", "description": "Knowledge base", "meta": { "subcommands": ["add", "search"] } }
            ],
            "prompts": [
                { "name": "review-pr", "serverName": "skill:review", "arguments": [{ "name": "args", "required": false }] },
                { "name": "deploy", "serverName": "ops-mcp", "description": "Deploy service", "arguments": [{ "name": "env", "required": true }] },
                { "name": "$ignored", "serverName": "local" }
            ]
        });
        let commands = kiro_available_commands(&params);
        let names: Vec<&str> = commands.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["compact", "knowledge", "review-pr", "deploy"]);
        assert_eq!(
            commands[1].input_schema,
            Some(serde_json::json!({ "hint": "add | search" }))
        );
        assert_eq!(commands[2].description.as_deref(), Some("Skill"));
        assert_eq!(commands[2].input_schema, None);
        assert_eq!(commands[3].description.as_deref(), Some("Deploy service"));
        assert_eq!(
            commands[3].input_schema,
            Some(serde_json::json!({ "hint": "<env>" }))
        );
    }

    /// A rejected session override happens before `session/prompt`. The user
    /// message is already accepted, and reopening the conversation reads the
    /// transcript, so the prompt must be on disk even though the turn failed.
    #[tokio::test]
    async fn failed_session_override_keeps_the_user_prompt_in_the_transcript() {
        let prompt_text = "remember this prompt after the model override fails";
        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let runner = dummy_runner(event_tx);
        let session_id = AgentSessionId::new();
        let acp_session_id = format!("override-fail-{}", uuid::Uuid::new_v4().simple());
        runner.session_controls.write().await.insert(
            session_id,
            SessionControlState {
                config_options: vec![
                    AcpSessionConfigOption::select(
                        "model",
                        "Model",
                        "gemini-3.8-flash-high",
                        vec![
                            SessionConfigSelectOption::new(
                                "gemini-3.8-flash-high",
                                "Gemini 3.8 Flash",
                            ),
                            SessionConfigSelectOption::new("gemini-4-argon", "Gemini 4 Argon"),
                        ],
                    )
                    .category(Some(SessionConfigOptionCategory::Model)),
                ],
                ..Default::default()
            },
        );

        let (client_write, agent_read) = tokio::io::duplex(64 * 1024);
        let (agent_write, client_read) = tokio::io::duplex(64 * 1024);
        let agent_transport =
            acp::ByteStreams::new(agent_write.compat_write(), agent_read.compat());
        tokio::spawn(async move {
            let _ = acp::Agent.builder().connect_to(agent_transport).await;
        });
        let client_transport =
            acp::ByteStreams::new(client_write.compat_write(), client_read.compat());
        let (_cmd_tx, mut cmd_rx) = mpsc::channel(1);
        let request = RunPromptRequest {
            acp_session_id: acp_session_id.clone(),
            session_id,
            prompt_id: AgentPromptId::new(),
            blocks: vec![AgentContentBlock::Text {
                text: prompt_text.to_string(),
            }],
            display_blocks: Some(vec![AgentContentBlock::Text {
                text: prompt_text.to_string(),
            }]),
            mode_override: None,
            config_overrides: vec![AgentSessionConfigOverride {
                key: "model".to_string(),
                value: "gemini-4-argon".to_string(),
            }],
        };
        let outcome = tokio::time::timeout(
            Duration::from_secs(5),
            acp::Client
                .builder()
                .name("VibeX")
                .connect_with(client_transport, async move |conn| {
                    runner.run_prompt(&conn, request, &mut cmd_rx).await
                }),
        )
        .await
        .expect("session override failure hung")
        .expect("override rejection must settle the turn");
        assert_eq!(outcome, RunPromptOutcome::Settled);

        let mut saw_override_failure = false;
        while let Ok(event) = event_rx.try_recv() {
            if let AgentEvent::Error { error } = event.event
                && error.message.contains("ACP session overrides failed")
            {
                saw_override_failure = true;
            }
        }
        assert!(
            saw_override_failure,
            "the turn must fail at session overrides, before session/prompt"
        );

        let root = crate::acp_transcript::vibex_acp_transcripts_root();
        let agent_dir = jsonl_agent_dir("antigravity");
        let _ = crate::acp_transcript::flush_in(&root, &agent_dir, &acp_session_id).await;
        let transcript = crate::acp_transcript::read_chain_in(&root, &agent_dir, &acp_session_id);
        let turns = crate::parsers::acp_native::project_turns(&transcript.entries);
        let user_texts: Vec<String> = turns
            .iter()
            .filter(|turn| matches!(turn.role, crate::conversation::TurnRole::User))
            .flat_map(|turn| turn.blocks.iter())
            .filter_map(|block| match block {
                crate::conversation::ContentBlock::Text { text } => Some(text.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(
            user_texts,
            vec![prompt_text.to_string()],
            "reopening the conversation reads this transcript; the sent message must still be there"
        );
        assert!(
            transcript.entries.iter().any(|entry| {
                entry.k == crate::acp_transcript::EntryKind::TurnEnd
                    && entry.p.get("stopReason").and_then(|value| value.as_str()) == Some("error")
            }),
            "a failed override must close the transcript turn"
        );
    }

    #[test]
    fn silent_end_turn_without_output_emits_turn_failed_empty_with_redacted_stderr() {
        let tail = StderrTail::new();
        tail.push("startup banner");
        let mark = tail.mark();
        tail.push("FATAL: upstream 401 with Authorization: Bearer sk-secret-token-1234567890");

        let probe = TurnOutputProbe::default();
        let response = acp::schema::v1::PromptResponse::new(acp::schema::v1::StopReason::EndTurn);

        let error = turn_failure_error_event(&response, &probe, &tail, mark)
            .expect("empty EndTurn must produce turn_failed_empty error");
        assert_eq!(error.code.as_deref(), Some("turn_failed_empty"));
        assert!(
            error.message.contains("<redacted>"),
            "stderr diagnostic must be redacted: {}",
            error.message
        );
        assert!(
            !error.message.contains("sk-secret-token"),
            "raw secret must never leak: {}",
            error.message
        );
        assert!(
            !error.message.contains("startup banner"),
            "stderr before turn mark must be excluded: {}",
            error.message
        );
        assert_eq!(
            finish_turn_reason(&response.stop_reason, probe.has_output(), false),
            "turn_failed_empty"
        );
    }

    #[test]
    fn end_turn_with_visible_output_does_not_emit_turn_failure() {
        let tail = StderrTail::new();
        let mark = tail.mark();
        tail.push("harmless warning on stderr");

        let probe = TurnOutputProbe::default();
        probe.note_rendered();
        let response = acp::schema::v1::PromptResponse::new(acp::schema::v1::StopReason::EndTurn);

        assert!(turn_failure_error_event(&response, &probe, &tail, mark).is_none());
        assert_eq!(
            finish_turn_reason(&response.stop_reason, probe.has_output(), false),
            "end_turn"
        );
    }

    #[test]
    fn refusal_max_tokens_and_max_turn_requests_emit_structured_turn_failure_errors() {
        let tail = StderrTail::new();
        let mark = tail.mark();
        let probe = TurnOutputProbe::default();
        probe.note_rendered();

        let refusal = acp::schema::v1::PromptResponse::new(acp::schema::v1::StopReason::Refusal);
        let refusal_err = turn_failure_error_event(&refusal, &probe, &tail, mark)
            .expect("StopReason::Refusal must emit error");
        assert_eq!(refusal_err.code.as_deref(), Some("turn_failed_refusal"));
        assert!(refusal_err.message.contains("StopReason::Refusal"));

        let max_tokens =
            acp::schema::v1::PromptResponse::new(acp::schema::v1::StopReason::MaxTokens);
        let max_tokens_err = turn_failure_error_event(&max_tokens, &probe, &tail, mark)
            .expect("StopReason::MaxTokens must emit error");
        assert_eq!(
            max_tokens_err.code.as_deref(),
            Some("turn_failed_max_tokens")
        );
        assert!(max_tokens_err.message.contains("StopReason::MaxTokens"));

        let max_requests =
            acp::schema::v1::PromptResponse::new(acp::schema::v1::StopReason::MaxTurnRequests);
        let max_requests_err = turn_failure_error_event(&max_requests, &probe, &tail, mark)
            .expect("StopReason::MaxTurnRequests must emit error");
        assert_eq!(
            max_requests_err.code.as_deref(),
            Some("turn_failed_max_turn_requests")
        );
        assert!(
            max_requests_err
                .message
                .contains("StopReason::MaxTurnRequests")
        );
    }

    #[test]
    fn jetbrains_air_capabilities_and_session_failure_extraction_work() {
        let caps = build_client_capabilities(&AgentId::parse("claude_code").unwrap());
        let meta = caps.meta.expect("client capabilities must include _meta");
        assert_eq!(
            meta.get("jetbrains.air")
                .and_then(|v| v.get("sessionFailure")),
            Some(&serde_json::json!(true))
        );

        let rpc_err = acp::Error::internal_error().data(serde_json::json!({
            "_meta": {
                "jetbrains.air": {
                    "sessionFailure": {
                        "type": "RateLimitExceeded",
                        "reason": "Quota exhausted for claude-sonnet",
                        "userMessage": "Rate limit reached; please wait 60 seconds."
                    }
                }
            }
        }));
        let tail = StderrTail::new();
        let mark = tail.mark();
        let formatted = format_acp_prompt_error(&rpc_err, &tail, mark);
        assert!(
            formatted
                .message
                .contains("Rate limit reached; please wait 60 seconds."),
            "expected userMessage in formatted error: {}",
            formatted.message
        );
        assert!(
            formatted.message.contains("[RateLimitExceeded]"),
            "expected failure type in formatted error: {}",
            formatted.message
        );

        let mut response_meta = serde_json::Map::new();
        response_meta.insert(
            "jetbrains.air".to_string(),
            serde_json::json!({
                "sessionFailure": {
                    "type": "AuthenticationFailed",
                    "userMessage": "Session token expired, please re-authenticate."
                }
            }),
        );
        let response = acp::schema::v1::PromptResponse::new(acp::schema::v1::StopReason::EndTurn)
            .meta(response_meta);
        let probe = TurnOutputProbe::default();
        let empty_err = turn_failure_error_event(&response, &probe, &tail, mark)
            .expect("empty EndTurn with sessionFailure must surface error");
        assert_eq!(empty_err.code.as_deref(), Some("turn_failed_empty"));
        assert!(
            empty_err
                .message
                .contains("Session token expired, please re-authenticate."),
            "expected sessionFailure userMessage in empty turn error: {}",
            empty_err.message
        );
    }

    #[test]
    fn omit_null_error_data_and_fix_usage_update_nulls_clean_non_conformant_frames() {
        let error_frame = r#"{"jsonrpc":"2.0","id":0,"error":{"code":-32601,"message":"\"session/list\": Method not found","data":null}}"#;
        let cleaned_error = sanitize_incoming_jsonrpc_line(error_frame.to_string());
        let parsed_error: serde_json::Value = serde_json::from_str(&cleaned_error).unwrap();
        assert!(parsed_error["error"].get("data").is_none());
        assert_eq!(
            parsed_error["error"]["message"],
            "\"session/list\": Method not found"
        );

        let usage_frame = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"usage_update","size":null,"used":null,"cost":{"amount":0.01,"currency":null}}}}"#;
        let cleaned_usage = sanitize_incoming_jsonrpc_line(usage_frame.to_string());
        let parsed_usage: serde_json::Value = serde_json::from_str(&cleaned_usage).unwrap();
        assert_eq!(parsed_usage["params"]["update"]["size"], 0);
        assert_eq!(parsed_usage["params"]["update"]["used"], 0);
        assert!(parsed_usage["params"]["update"].get("cost").is_none());
    }

    #[test]
    fn sanitize_drops_notifications_with_a_null_session_id() {
        let setup = r#"{"jsonrpc":"2.0","method":"_x.ai/session/setup","params":{"sessionId":null,"phase":"auth"}}"#;
        assert!(sanitize_incoming_jsonrpc_line(setup.to_string()).is_empty());

        let missing = r#"{"jsonrpc":"2.0","method":"_x.ai/models/update","params":{"models":[]}}"#;
        assert_eq!(sanitize_incoming_jsonrpc_line(missing.to_string()), missing);

        let named = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk"}}}"#;
        assert_eq!(sanitize_incoming_jsonrpc_line(named.to_string()), named);

        let request = r#"{"jsonrpc":"2.0","id":1,"method":"session/request_permission","params":{"sessionId":null}}"#;
        assert_eq!(sanitize_incoming_jsonrpc_line(request.to_string()), request);
    }

    #[test]
    fn leading_edge_throttle_suppresses_bursts_and_reports_count_after_window() {
        let window = Duration::from_secs(10);
        let throttle = LeadingEdgeThrottle::new(window);
        let window_ns = window.as_nanos() as u64;

        assert_eq!(throttle.check_at(0), Some(0));
        for ms in 1..=25 {
            assert_eq!(throttle.check_at(ms * 100_000_000), None);
        }
        assert_eq!(throttle.check_at(window_ns + 1_000_000), Some(25));
        assert_eq!(throttle.flush(), 0);
    }

    #[test]
    fn disconnect_join_timeout_allows_transcript_flush_before_abort() {
        assert!(DISCONNECT_JOIN_TIMEOUT >= Duration::from_secs(8));
    }

    #[tokio::test]
    async fn session_load_replay_suppresses_ext_notifications_and_historical_usage() {
        let session_id = AgentSessionId::new();
        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let bridge = AcpClientBridge::new(
            AgentConnectionId::new(),
            AgentId::parse("grok").unwrap(),
            event_tx,
            Arc::new(RwLock::new(HashMap::new())),
            Arc::new(RwLock::new(HashMap::new())),
            Arc::new(Mutex::new(HashMap::new())),
            Arc::new(Mutex::new(HashMap::new())),
            Arc::new(Mutex::new(AgentAutoApproveMode::default())),
            Arc::new(Mutex::new(HashMap::new())),
            Arc::new(Mutex::new(Instant::now())),
            Arc::new(Mutex::new(GrokSubagentTracker::default())),
            Arc::new(Mutex::new(GrokMcpTracker::default())),
            Arc::new(Mutex::new(Some(session_id))),
            PathBuf::from("C:/workspace"),
            HashMap::new(),
            dummy_runner(mpsc::unbounded_channel().0),
        );

        let ext = agent_client_protocol::schema::v1::ExtNotification::new(
            "x.ai/subagent_spawned",
            serde_json::value::to_raw_value(&serde_json::json!({
                "sessionId": "acp-replay-1",
                "subagentId": "sub-1",
                "toolCallId": "call-1",
                "agentType": "research",
                "task": "scan repo"
            }))
            .unwrap()
            .into(),
        );
        bridge.handle_ext_notification(ext).await.unwrap();

        let usage_notification: SessionNotification = serde_json::from_value(serde_json::json!({
            "sessionId": "acp-replay-1",
            "update": {
                "sessionUpdate": "usage_update",
                "used": 1200,
                "size": 128000
            }
        }))
        .unwrap();
        bridge
            .session_notification(usage_notification)
            .await
            .unwrap();

        let info_notification: SessionNotification = serde_json::from_value(serde_json::json!({
            "sessionId": "acp-replay-1",
            "update": {
                "sessionUpdate": "session_info_update",
                "title": "Historical title"
            }
        }))
        .unwrap();
        bridge
            .session_notification(info_notification)
            .await
            .unwrap();

        let thought_with_meta: SessionNotification = serde_json::from_value(serde_json::json!({
            "sessionId": "acp-replay-1",
            "_meta": {
                "totalTokens": 4096
            },
            "update": {
                "sessionUpdate": "agent_thought_chunk",
                "content": {
                    "type": "text",
                    "text": "replayed thought"
                }
            }
        }))
        .unwrap();
        bridge
            .session_notification(thought_with_meta)
            .await
            .unwrap();

        assert!(
            event_rx.try_recv().is_err(),
            "session/load replay notifications while unbound must not emit live events"
        );
    }

    #[tokio::test]
    async fn wait_for_question_registers_pending_elicitation_before_emitting_event() {
        let session_id = AgentSessionId::new();
        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let runner = dummy_runner(event_tx.clone());
        let bridge = AcpClientBridge::new(
            runner.snapshot.connection_id,
            runner.snapshot.agent_id.clone(),
            event_tx,
            Arc::clone(&runner.session_map),
            Arc::clone(&runner.session_controls),
            Arc::clone(&runner.pending_permissions),
            Arc::clone(&runner.pending_elicitations),
            Arc::clone(&runner.auto_approve_mode),
            Arc::clone(&runner.stream_dedup),
            Arc::clone(&runner.last_activity),
            Arc::clone(&runner.grok_subagent),
            Arc::clone(&runner.grok_mcp),
            Arc::clone(&runner.pending_session_id),
            runner.snapshot.working_dir.clone(),
            runner.snapshot.env.clone(),
            runner.clone(),
        );

        let wait_task = tokio::spawn(async move {
            bridge
                .wait_for_question(
                    session_id,
                    "Pick one".to_string(),
                    serde_json::json!({"type": "object"}),
                )
                .await
        });

        let requested = event_rx
            .recv()
            .await
            .expect("ElicitationRequested event must arrive");
        let elicitation_id = match requested.event {
            AgentEvent::ElicitationRequested { request } => request.id.to_string(),
            other => panic!("expected ElicitationRequested, got {other:?}"),
        };

        assert!(
            runner
                .pending_elicitations
                .lock()
                .await
                .contains_key(&elicitation_id),
            "pending_elicitations must already contain the entry when ElicitationRequested is received"
        );

        runner
            .respond_pending_elicitation(
                &elicitation_id,
                AgentElicitationResponse::Accept {
                    content: serde_json::json!({"choice": "A"}),
                },
            )
            .await;

        let response = wait_task.await.unwrap();
        assert_eq!(
            response,
            AgentElicitationResponse::Accept {
                content: serde_json::json!({"choice": "A"}),
            }
        );
    }

    fn claude_model_selector(opus_row: &str) -> AcpSessionConfigOption {
        let rows: Vec<serde_json::Value> = [
            opus_row,
            "claude-fable-5-1[1m]",
            "sonnet",
            "sonnet[1m]",
            "haiku",
        ]
        .iter()
        .map(|value| serde_json::json!({"value": value, "name": value}))
        .collect();
        serde_json::from_value(serde_json::json!({
            "type": "select",
            "id": "model",
            "name": "Model",
            "category": "model",
            "currentValue": opus_row,
            "options": rows,
        }))
        .expect("parses")
    }

    fn gateway_model_selector_2_1_287() -> AcpSessionConfigOption {
        serde_json::from_value(serde_json::json!({
            "id": "model",
            "name": "Model",
            "description": "AI model to use",
            "category": "model",
            "type": "select",
            "currentValue": "opus",
            "_meta": {"jetbrains": {"air": {"version": 1, "recommendedValue": "opus"}}},
            "options": [
                {"value": "opus", "name": "Opus 5.5", "description": "Opus 5.5 · Best for everyday, complex tasks · $4/$20 per Mtok"},
                {"value": "fable", "name": "Fable 5.1", "description": "Fable 5.1 · Most capable for your hardest and longest-running tasks · $10/$50 per Mtok"},
                {"value": "sonnet", "name": "Sonnet 5.5", "description": "Sonnet 5.5 · Efficient for routine tasks · $2/$10 per Mtok"},
                {"value": "haiku", "name": "Haiku 4.5", "description": "Haiku 4.5 · Fastest for quick answers · $1/$5 per Mtok"},
            ],
        }))
        .expect("parses")
    }

    fn claude_modes(bypass: bool) -> SessionModeState {
        let mut modes = vec![
            serde_json::json!({"id": "default", "name": "Manual"}),
            serde_json::json!({"id": "acceptEdits", "name": "Accept edits"}),
            serde_json::json!({"id": "plan", "name": "Plan"}),
            serde_json::json!({"id": "auto", "name": "Auto"}),
        ];
        if bypass {
            modes
                .push(serde_json::json!({"id": "bypassPermissions", "name": "Bypass permissions"}));
        }
        serde_json::from_value(serde_json::json!({
            "currentModeId": "default",
            "availableModes": modes,
        }))
        .expect("parses")
    }

    #[test]
    fn config_option_rejects_value_only_for_non_empty_selects() {
        let model = claude_model_selector("opus[1m]");
        assert!(config_option_rejects_value(&model, "default"));
        assert!(!config_option_rejects_value(&model, "opus[1m]"));

        let empty: AcpSessionConfigOption = serde_json::from_value(serde_json::json!({
            "id": "model",
            "name": "Model",
            "type": "select",
            "currentValue": "",
            "options": [],
        }))
        .expect("parses");
        assert!(!config_option_rejects_value(&empty, "opus[1m]"));

        let toggle: AcpSessionConfigOption = serde_json::from_value(serde_json::json!({
            "id": "auto_approve",
            "name": "Auto-approve tools",
            "type": "boolean",
            "currentValue": false,
        }))
        .expect("parses");
        assert!(!config_option_rejects_value(&toggle, "true"));
    }

    #[test]
    fn retired_context_lane_and_respelled_fable_picks_heal_only_when_exact_is_gone() {
        let renamed = claude_model_selector("opus");
        assert_eq!(
            heal_retired_context_lane_pick(&renamed, "opus[1m]").as_deref(),
            Some("opus")
        );
        assert_eq!(
            heal_retired_context_lane_pick(&renamed, "opus[1M]").as_deref(),
            Some("opus")
        );
        // When both `sonnet` and `sonnet[1m]` are offered, `sonnet[1m]` is NOT healed away.
        assert_eq!(heal_retired_context_lane_pick(&renamed, "sonnet[1m]"), None);
        // Plain pick is never promoted to `[1m]`.
        assert_eq!(
            heal_retired_context_lane_pick(&claude_model_selector("opus[1m]"), "opus"),
            None
        );

        let gateway = gateway_model_selector_2_1_287();
        assert_eq!(
            heal_retired_model_pick(&gateway, "claude-fable-5-1").as_deref(),
            Some("fable")
        );
        assert_eq!(
            heal_retired_model_pick(&gateway, "claude-fable-5-1[1m]").as_deref(),
            Some("fable")
        );
        assert_eq!(
            heal_retired_model_pick(&gateway, "opus[1m]").as_deref(),
            Some("opus")
        );
        // Once the catalog version moves on (e.g. saved 5.0 against 5.1 row), it must NOT heal.
        assert_eq!(heal_retired_model_pick(&gateway, "claude-fable-5-0"), None);
        assert!(
            find_config_override_selection_for_agent(
                std::slice::from_ref(&gateway),
                Some(AgentKind::ClaudeCode),
                "model",
                &serde_json::json!("claude-fable-5-0"),
                &[],
            )
            .is_none(),
            "retired Fable version must be dropped rather than fuzzy-matched onto Fable 5.1"
        );
    }

    #[test]
    fn withdrawn_bypass_mode_and_retired_picks_are_skipped_during_replay() {
        assert!(session_modes_reject_id(
            &claude_modes(false),
            "bypassPermissions"
        ));
        assert!(!session_modes_reject_id(
            &claude_modes(true),
            "bypassPermissions"
        ));
        let empty_modes: SessionModeState = serde_json::from_value(serde_json::json!({
            "currentModeId": "",
            "availableModes": [],
        }))
        .expect("parses");
        assert!(!session_modes_reject_id(&empty_modes, "bypassPermissions"));

        let gateway = gateway_model_selector_2_1_287();
        let effort: AcpSessionConfigOption = serde_json::from_value(serde_json::json!({
            "id": "effort",
            "name": "Effort",
            "category": "thought_level",
            "type": "select",
            "currentValue": "medium",
            "options": [
                {"value": "low", "name": "Low"},
                {"value": "medium", "name": "Medium"},
                {"value": "high", "name": "High"},
            ],
        }))
        .expect("parses");
        let options = vec![gateway, effort];
        let overrides = vec![
            AgentSessionConfigOverride {
                key: "effort".to_string(),
                value: "high".to_string(),
            },
            AgentSessionConfigOverride {
                key: "model".to_string(),
                value: "claude-fable-5-1[1m]".to_string(),
            },
        ];

        let (mode_to_apply, config_to_apply, preferred_map) = prepare_preferred_controls_for_replay(
            Some(AgentKind::ClaudeCode),
            Some(&claude_modes(false)),
            &options,
            Some("bypassPermissions"),
            &overrides,
            &[],
        );
        assert_eq!(
            mode_to_apply, None,
            "withdrawn bypassPermissions must be dropped"
        );
        assert_eq!(
            config_to_apply,
            vec![
                AgentSessionConfigOverride {
                    key: "model".to_string(),
                    value: "fable".to_string(),
                },
                AgentSessionConfigOverride {
                    key: "effort".to_string(),
                    value: "high".to_string(),
                },
            ],
            "model must be healed and ordered before dependent options"
        );
        assert_eq!(
            preferred_map.get("model").map(String::as_str),
            Some("fable")
        );
        assert!(!preferred_map.contains_key("mode"));
    }

    fn dummy_runner_for_agent(
        agent_id: &str,
        event_tx: mpsc::UnboundedSender<AgentConnectionManagerEvent>,
    ) -> AgentConnectionRunner {
        AgentConnectionRunner::new(
            ManagedAgentConnectionSnapshot {
                connection_id: AgentConnectionId::new(),
                agent_id: AgentId::parse(agent_id).unwrap(),
                launch_lock: crate::SessionLaunchLock {
                    agent_id: AgentId::parse(agent_id).unwrap(),
                    absolute_acp_program: PathBuf::from("/managed/acp"),
                    args: vec!["serve".into()],
                    env: BTreeMap::new(),
                    runtime_version: "2.0.0".into(),
                    acp_version: "1.1.0".into(),
                },
                workspace_id: uuid::Uuid::nil(),
                working_dir: PathBuf::from("C:/workspace"),
                additional_directories: Vec::new(),
                auto_approve_mode: AgentAutoApproveMode::default(),
                env: HashMap::new(),
            },
            event_tx,
            None,
        )
    }

    #[test]
    fn sanitize_incoming_jsonrpc_line_rewrites_air_async_task_and_prompt_suggestion_updates() {
        let spawned = sanitize_incoming_jsonrpc_line(
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"async_task_spawned","taskId":"bg-1","name":"npm test","taskType":"shell","state":"running","canStop":true}}}"#.to_string(),
        );
        let parsed: serde_json::Value = serde_json::from_str(&spawned).unwrap();
        assert_eq!(parsed["method"], AIR_SESSION_UPDATE_METHOD);
        assert_eq!(
            parsed["params"]["update"]["sessionUpdate"],
            "async_task_spawned"
        );

        let suggestion = sanitize_incoming_jsonrpc_line(
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"prompt_suggestion_update","_meta":{"promptSuggestions":{"version":1,"suggestions":[{"text":"Run tests"}]}}}}}"#.to_string(),
        );
        let parsed: serde_json::Value = serde_json::from_str(&suggestion).unwrap();
        assert_eq!(parsed["method"], AIR_SESSION_UPDATE_METHOD);

        let workflow = sanitize_incoming_jsonrpc_line(
            r#"{"jsonrpc":"2.0","method":"session/workflow_updated","params":{"sessionId":"s1","workflowId":"wf-1","name":"Deploy","status":"running"}}"#.to_string(),
        );
        let parsed: serde_json::Value = serde_json::from_str(&workflow).unwrap();
        assert_eq!(parsed["method"], GROK_WORKFLOW_UPDATED_METHOD);
    }

    #[tokio::test]
    async fn session_info_goal_synthesizes_timeline_markers_and_normalizes_status() {
        let session_id = AgentSessionId::new();
        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let runner = dummy_runner_for_agent("codex", event_tx);
        *runner.goal_advertised_control.write().await = Some((
            Some(crate::codex_goal::NEUTRAL_GOAL_CONTROL_METHOD.to_string()),
            vec![
                "pause".to_string(),
                "resume".to_string(),
                "clear".to_string(),
                "set".to_string(),
            ],
        ));
        runner.handshake_completed.store(true, Ordering::SeqCst);
        runner.neutral_goal_channel.store(true, Ordering::SeqCst);

        // Legacy _meta.codex.goal is ignored when neutral_goal_channel is true.
        let legacy_meta = serde_json::json!({
            "codex": {
                "goal": {
                    "objective": "Ignored legacy goal",
                    "status": "active"
                }
            }
        });
        assert!(
            crate::codex_goal::session_info_goal_value(legacy_meta.as_object(), true).is_none()
        );

        // Neutral active goal synthesizes create_goal (codex-goal-1) + GoalUpdated.
        runner
            .apply_session_info_goal(
                Some(session_id),
                &serde_json::json!({
                    "objective": "Ship Goal Bar",
                    "status": "active",
                    "tokensUsed": 1200
                }),
                true,
            )
            .await;

        let first = event_rx.try_recv().expect("GoalUpdated");
        match first.event {
            AgentEvent::GoalUpdated { goal, goal_actions } => {
                assert_eq!(
                    goal.as_ref().and_then(|g| g["objective"].as_str()),
                    Some("Ship Goal Bar")
                );
                assert_eq!(
                    goal_actions,
                    Some(vec![
                        "pause".to_string(),
                        "resume".to_string(),
                        "clear".to_string(),
                        "set".to_string(),
                    ])
                );
            }
            other => panic!("expected GoalUpdated, got {other:?}"),
        }

        let second = event_rx.try_recv().expect("ToolCall create_goal");
        match second.event {
            AgentEvent::ToolCall { tool_call } => {
                assert_eq!(tool_call.id, "codex-goal-1");
                assert_eq!(tool_call.title, "create_goal");
                assert_eq!(tool_call.status.as_deref(), Some("completed"));
            }
            other => panic!("expected ToolCall, got {other:?}"),
        }

        // Transition to budgetLimited normalizes to budget_limited and synthesizes update_goal.
        runner
            .apply_session_info_goal(
                Some(session_id),
                &serde_json::json!({
                    "objective": "Ship Goal Bar",
                    "status": "budgetLimited",
                    "tokensUsed": 5000
                }),
                true,
            )
            .await;

        let updated = event_rx.try_recv().expect("GoalUpdated");
        match updated.event {
            AgentEvent::GoalUpdated { goal, .. } => {
                assert_eq!(
                    goal.as_ref().and_then(|g| g["status"].as_str()),
                    Some("budget_limited")
                );
            }
            other => panic!("expected GoalUpdated, got {other:?}"),
        }

        let marker = event_rx.try_recv().expect("ToolCall update_goal");
        match marker.event {
            AgentEvent::ToolCall { tool_call } => {
                assert_eq!(tool_call.id, "codex-goal-2");
                assert_eq!(tool_call.title, "update_goal");
                assert_eq!(tool_call.status.as_deref(), Some("completed"));
            }
            other => panic!("expected ToolCall, got {other:?}"),
        }

        // Starting the same objective again gets a new occurrence id (codex-goal-3).
        runner
            .apply_session_info_goal(
                Some(session_id),
                &serde_json::json!({
                    "objective": "Ship Goal Bar",
                    "status": "active"
                }),
                true,
            )
            .await;
        let _ = event_rx.try_recv().expect("GoalUpdated");
        let second_run = event_rx.try_recv().expect("ToolCall create_goal #2");
        match second_run.event {
            AgentEvent::ToolCall { tool_call } => {
                assert_eq!(tool_call.id, "codex-goal-3");
                assert_eq!(tool_call.title, "create_goal");
            }
            other => panic!("expected ToolCall, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn async_task_and_prompt_suggestion_ext_notifications_route_to_session_controls() {
        let session_id = AgentSessionId::new();
        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let runner = dummy_runner_for_agent("claude_code", event_tx.clone());
        let bridge = AcpClientBridge::new(
            AgentConnectionId::new(),
            AgentId::parse("claude_code").unwrap(),
            event_tx,
            Arc::new(RwLock::new(HashMap::from([(
                session_id,
                "acp-claude".into(),
            )]))),
            Arc::new(RwLock::new(HashMap::new())),
            Arc::new(Mutex::new(HashMap::new())),
            Arc::new(Mutex::new(HashMap::new())),
            Arc::new(Mutex::new(AgentAutoApproveMode::default())),
            Arc::new(Mutex::new(HashMap::new())),
            Arc::new(Mutex::new(Instant::now())),
            Arc::new(Mutex::new(GrokSubagentTracker::default())),
            Arc::new(Mutex::new(GrokMcpTracker::default())),
            Arc::new(Mutex::new(None)),
            PathBuf::from("C:/workspace"),
            HashMap::new(),
            runner.clone(),
        );

        let spawned_raw = serde_json::value::to_raw_value(&serde_json::json!({
            "sessionId": "acp-claude",
            "update": {
                "sessionUpdate": "async_task_spawned",
                "taskId": "task-1",
                "name": "cargo test",
                "taskType": "shell",
                "state": "running",
                "canStop": true
            }
        }))
        .unwrap();
        bridge
            .handle_ext_notification(acp::schema::v1::ExtNotification::new(
                AIR_SESSION_UPDATE_METHOD,
                spawned_raw.into(),
            ))
            .await
            .unwrap();

        let task_event = event_rx.try_recv().expect("AsyncTasksUpdated");
        match task_event.event {
            AgentEvent::AsyncTasksUpdated { tasks } => {
                assert_eq!(tasks.len(), 1);
                assert_eq!(tasks[0].id, "task-1");
                assert_eq!(tasks[0].name.as_deref(), Some("cargo test"));
                assert!(tasks[0].can_stop);
            }
            other => panic!("expected AsyncTasksUpdated, got {other:?}"),
        }

        let suggestion_raw = serde_json::value::to_raw_value(&serde_json::json!({
            "sessionId": "acp-claude",
            "update": {
                "sessionUpdate": "prompt_suggestion_update",
                "_meta": {
                    "promptSuggestions": {
                        "version": 1,
                        "suggestions": [{ "text": "Commit the changes" }]
                    }
                }
            }
        }))
        .unwrap();
        bridge
            .handle_ext_notification(acp::schema::v1::ExtNotification::new(
                AIR_SESSION_UPDATE_METHOD,
                suggestion_raw.clone().into(),
            ))
            .await
            .unwrap();
        assert!(
            event_rx.try_recv().is_err(),
            "headless sessions without wants_prompt_suggestions must ignore suggestions"
        );

        runner
            .record_wants_prompt_suggestions(session_id, true)
            .await;
        bridge
            .handle_ext_notification(acp::schema::v1::ExtNotification::new(
                AIR_SESSION_UPDATE_METHOD,
                suggestion_raw.into(),
            ))
            .await
            .unwrap();

        let suggestion_event = event_rx.try_recv().expect("PromptSuggestionUpdated");
        match suggestion_event.event {
            AgentEvent::PromptSuggestionUpdated { suggestion } => {
                assert_eq!(suggestion.as_deref(), Some("Commit the changes"));
            }
            other => panic!("expected PromptSuggestionUpdated, got {other:?}"),
        }

        let controls = runner.session_controls_snapshot(session_id).await;
        assert_eq!(controls.async_tasks.len(), 1);
        assert_eq!(
            controls.prompt_suggestion.as_deref(),
            Some("Commit the changes")
        );
    }

    #[tokio::test]
    async fn in_memory_goal_control_orchestration_respects_claude_and_codex_rules() {
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let manager = AgentConnectionManager::new_with_driver(event_tx, false);

        // 1. Claude clear never interrupts the in-flight turn.
        let (claude_snap, claude_ready) = manager
            .register_connection(AgentConnectionLaunch {
                connection_id: AgentConnectionId::new(),
                agent_id: AgentId::parse("claude_code").unwrap(),
                launch_lock: test_launch_lock(AgentId::parse("claude_code").unwrap()),
                workspace_id: uuid::Uuid::nil(),
                working_dir: PathBuf::from("C:/workspace"),
                additional_directories: Vec::new(),
                auto_approve_mode: AgentAutoApproveMode::Off,
                env: HashMap::new(),
            })
            .await;
        claude_ready.await.unwrap().unwrap();
        let claude_session = AgentSessionId::new();
        manager
            .prepare_session(
                claude_snap.connection_id,
                claude_session,
                Default::default(),
            )
            .await
            .unwrap();
        let claude_receipt = manager
            .goal_control(claude_snap.connection_id, claude_session, "clear")
            .await
            .unwrap();
        assert!(!claude_receipt.should_interrupt_turn);

        // 2. Codex pause interrupts turn; clear when paused does NOT interrupt turn.
        let (codex_snap, codex_ready) = manager
            .register_connection(AgentConnectionLaunch {
                connection_id: AgentConnectionId::new(),
                agent_id: AgentId::parse("codex").unwrap(),
                launch_lock: test_launch_lock(AgentId::parse("codex").unwrap()),
                workspace_id: uuid::Uuid::nil(),
                working_dir: PathBuf::from("C:/workspace"),
                additional_directories: Vec::new(),
                auto_approve_mode: AgentAutoApproveMode::Off,
                env: HashMap::new(),
            })
            .await;
        codex_ready.await.unwrap().unwrap();
        let codex_session = AgentSessionId::new();
        manager
            .prepare_session(codex_snap.connection_id, codex_session, Default::default())
            .await
            .unwrap();

        let pause_receipt = manager
            .goal_control(codex_snap.connection_id, codex_session, "pause")
            .await
            .unwrap();
        assert!(pause_receipt.should_interrupt_turn);

        let clear_when_paused = manager
            .goal_control(codex_snap.connection_id, codex_session, "clear")
            .await
            .unwrap();
        assert!(
            !clear_when_paused.should_interrupt_turn,
            "clearing a non-active goal must not cancel a user-initiated turn"
        );
    }

    #[tokio::test]
    async fn antigravity_synthetic_turn_error_and_cancel_chunks_are_not_emitted_as_assistant_prose()
    {
        let session_id = AgentSessionId::new();
        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let runner = dummy_runner_for_agent("antigravity", event_tx.clone());
        let probe = Arc::new(TurnOutputProbe::default());
        // Even if the agent already emitted thoughts or tool calls earlier in the turn,
        // a terminal AntigravityExecutionError chunk must still fail the turn.
        probe.note_rendered();
        *runner.active_turn_probe.lock().unwrap() = Some((session_id, Arc::clone(&probe)));

        let bridge = AcpClientBridge::new(
            AgentConnectionId::new(),
            AgentId::parse("antigravity").unwrap(),
            event_tx,
            Arc::new(RwLock::new(HashMap::from([(session_id, "acp-agy".into())]))),
            Arc::new(RwLock::new(HashMap::new())),
            Arc::new(Mutex::new(HashMap::new())),
            Arc::new(Mutex::new(HashMap::new())),
            Arc::new(Mutex::new(AgentAutoApproveMode::default())),
            Arc::new(Mutex::new(HashMap::new())),
            Arc::new(Mutex::new(Instant::now())),
            Arc::new(Mutex::new(GrokSubagentTracker::default())),
            Arc::new(Mutex::new(GrokMcpTracker::default())),
            Arc::new(Mutex::new(None)),
            PathBuf::from("C:/workspace"),
            HashMap::new(),
            runner,
        );

        bridge
            .session_notification(SessionNotification::new(
                SessionId::new("acp-agy"),
                SessionUpdate::AgentMessageChunk(acp::schema::v1::ContentChunk::new(
                    ContentBlock::from("The request was cancelled by the client."),
                )),
            ))
            .await
            .unwrap();
        assert!(
            event_rx.try_recv().is_err(),
            "synthetic cancellation chunk must not emit AgentEvent::MessageChunk"
        );

        let raw_502 = "Agent execution error: model unreachable: Error 502, Message: Bad Gateway: Failed to connect to backend API, Status: 502 Bad Gateway";
        bridge
            .session_notification(SessionNotification::new(
                SessionId::new("acp-agy"),
                SessionUpdate::AgentMessageChunk(acp::schema::v1::ContentChunk::new(
                    ContentBlock::from(raw_502),
                )),
            ))
            .await
            .unwrap();
        assert!(
            event_rx.try_recv().is_err(),
            "synthetic execution error chunk must not emit AgentEvent::MessageChunk"
        );

        let tail = StderrTail::new();
        let mark = tail.mark();
        let response = acp::schema::v1::PromptResponse::new(acp::schema::v1::StopReason::EndTurn);
        let failure = turn_failure_error_event(&response, &probe, &tail, mark)
            .expect("EndTurn after Antigravity execution error chunk must produce AgentErrorEvent");
        assert_eq!(failure.code.as_deref(), Some("model_unreachable"));
        assert!(failure.message.contains("502 Bad Gateway"));
        assert!(failure.message.contains("cloudcode-pa.googleapis.com"));
    }

    #[test]
    fn format_acp_prompt_error_classifies_session_not_found_as_agent_connection_lost() {
        let tail = StderrTail::new();
        let mark = tail.mark();
        for raw_msg in [
            "Session not found: 5b6593fa-0136-4a76-bfaa-92cb4412aa06",
            "Internal error: session not found",
            "The session has ended on the server",
        ] {
            let err = acp::Error::new(-32603, raw_msg);
            let event = format_acp_prompt_error(&err, &tail, mark);
            assert_eq!(
                event.code.as_deref(),
                Some("agent_connection_lost"),
                "expected agent_connection_lost for `{raw_msg}`"
            );
            assert!(event.message.contains(raw_msg));
        }

        let unrelated = acp::Error::new(-32603, "Internal error: tool execution failed");
        let unrelated_event = format_acp_prompt_error(&unrelated, &tail, mark);
        assert_eq!(unrelated_event.code.as_deref(), Some("internal_error"));
    }

    #[tokio::test]
    async fn run_prompt_unbinds_session_and_closes_connection_on_agent_connection_lost_after_partial_output()
     {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let session_id = AgentSessionId::new();
        let prompt_id = AgentPromptId::new();
        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let runner = dummy_runner_for_agent("antigravity", event_tx.clone());
        runner
            .session_map
            .write()
            .await
            .insert(session_id, "acp-agy-live".to_string());
        runner
            .session_controls
            .write()
            .await
            .insert(session_id, SessionControlState::default());
        *runner.active_prompt.lock().await = Some((session_id, prompt_id));

        let (client_to_agent, agent_from_client) = tokio::io::duplex(64 * 1024);
        let (agent_to_client, client_from_agent) = tokio::io::duplex(64 * 1024);

        let agent_task = tokio::spawn(async move {
            let mut reader = BufReader::new(agent_from_client);
            let mut writer = agent_to_client;
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let req: serde_json::Value = serde_json::from_str(&line).unwrap();
            let req_id = req["id"].clone();

            // 1. Stream partial output first.
            let partial_chunk = serde_json::json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "acp-agy-live",
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": { "type": "text", "text": "Partial response before crash" }
                    }
                }
            });
            writer
                .write_all(format!("{partial_chunk}\n").as_bytes())
                .await
                .unwrap();

            // 2. Stream Antigravity's synthetic connection-lost chunk.
            let err_chunk = serde_json::json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "acp-agy-live",
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {
                            "type": "text",
                            "text": "Agent connection was lost and could not be re-established: 13 INTERNAL: Agent execution terminated due to error."
                        }
                    }
                }
            });
            writer
                .write_all(format!("{err_chunk}\n").as_bytes())
                .await
                .unwrap();
            writer.flush().await.unwrap();
            tokio::time::sleep(Duration::from_millis(20)).await;

            // 3. Complete prompt with StopReason::EndTurn.
            let resp = serde_json::json!({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "stopReason": "end_turn"
                }
            });
            writer
                .write_all(format!("{resp}\n").as_bytes())
                .await
                .unwrap();
            writer.flush().await.unwrap();
        });

        let transport =
            acp::ByteStreams::new(client_to_agent.compat_write(), client_from_agent.compat());
        let bridge = AcpClientBridge::new(
            runner.snapshot.connection_id,
            runner.snapshot.agent_id.clone(),
            event_tx,
            Arc::clone(&runner.session_map),
            Arc::clone(&runner.session_controls),
            Arc::clone(&runner.pending_permissions),
            Arc::clone(&runner.pending_elicitations),
            Arc::clone(&runner.auto_approve_mode),
            Arc::clone(&runner.stream_dedup),
            Arc::clone(&runner.last_activity),
            Arc::clone(&runner.grok_subagent),
            Arc::clone(&runner.grok_mcp),
            Arc::clone(&runner.pending_session_id),
            runner.snapshot.working_dir.clone(),
            runner.snapshot.env.clone(),
            runner.clone(),
        );
        let runner_for_conn = runner.clone();
        let outcome = acp::Client
            .builder()
            .name("VibeX")
            .on_receive_notification(
                async move |notification: AgentNotification, _cx| {
                    bridge.handle_agent_notification(notification).await
                },
                acp::on_receive_notification!(),
            )
            .connect_with(transport, |conn: ConnectionTo<Agent>| async move {
                let (_cmd_tx, mut cmd_rx) = mpsc::channel(4);
                let outcome = runner_for_conn
                    .run_prompt(
                        &conn,
                        RunPromptRequest {
                            acp_session_id: "acp-agy-live".to_string(),
                            session_id,
                            prompt_id,
                            blocks: vec![AgentContentBlock::Text {
                                text: "hello".to_string(),
                            }],
                            display_blocks: None,
                            mode_override: None,
                            config_overrides: Vec::new(),
                        },
                        &mut cmd_rx,
                    )
                    .await
                    .expect("run_prompt should succeed with Closed outcome");
                assert_eq!(outcome, RunPromptOutcome::Closed);
                Ok(())
            })
            .await;
        assert!(outcome.is_ok());
        agent_task.await.unwrap();

        assert!(
            !runner.session_map.read().await.contains_key(&session_id),
            "session_map must unbind session_id after agent_connection_lost"
        );
        assert!(
            !runner
                .session_controls
                .read()
                .await
                .contains_key(&session_id),
            "session_controls must remove session_id after agent_connection_lost"
        );
        assert!(
            runner.active_prompt.lock().await.is_none(),
            "active_prompt must be cleared"
        );

        let mut collected = Vec::new();
        while let Ok(ev) = event_rx.try_recv() {
            collected.push(ev.event);
        }
        let failed_status_pos = collected
            .iter()
            .position(|ev| {
                matches!(
                    ev,
                    AgentEvent::ConnectionStatusChanged { snapshot }
                        if snapshot.status == AgentConnectionStatus::Failed
                )
            })
            .expect("must emit ConnectionStatusChanged(Failed)");
        let error_pos = collected
            .iter()
            .position(|ev| {
                matches!(
                    ev,
                    AgentEvent::Error { error }
                        if error.code.as_deref() == Some("agent_connection_lost")
                )
            })
            .expect("must emit AgentEvent::Error(agent_connection_lost)");
        assert!(
            failed_status_pos < error_pos,
            "ConnectionStatusChanged(Failed) must be emitted before AgentEvent::Error"
        );
        assert!(
            !collected
                .iter()
                .any(|ev| matches!(ev, AgentEvent::PromptFinished { .. })),
            "PromptFinished must NOT be emitted when closing a lost connection"
        );
    }

    #[tokio::test]
    async fn omp_session_controls_advertise_yolo_mode_and_toggle_effective_auto_approve() {
        let session_id = AgentSessionId::new();
        let raw_modes = SessionModeState::new(
            "default",
            vec![
                acp::schema::v1::SessionMode::new("default", "Default"),
                acp::schema::v1::SessionMode::new("plan", "Plan"),
            ],
        );
        let raw_options = vec![
            AcpSessionConfigOption::select(
                "mode",
                "Mode",
                "default",
                SessionConfigSelectOptions::Ungrouped(vec![
                    SessionConfigSelectOption::new("default", "Default"),
                    SessionConfigSelectOption::new("plan", "Plan"),
                ]),
            )
            .category(SessionConfigOptionCategory::Mode),
        ];

        let (modes, config_options, _) = session_controls_with_models_and_vendor_fallback(
            Some(raw_modes),
            Some(raw_options),
            None,
            None,
            "omp",
        );
        let modes = modes.expect("modes");
        let mode_ids: Vec<_> = modes
            .available_modes
            .iter()
            .map(|m| m.id.0.as_ref())
            .collect();
        assert_eq!(mode_ids, ["default", "plan", "yolo"]);

        let options = config_options.expect("config_options");
        let (derived_modes, current_mode) = session_modes_from_config_options(&options);
        let derived_ids: Vec<_> = derived_modes.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(derived_ids, ["default", "plan", "yolo"]);
        assert_eq!(current_mode.as_deref(), Some("default"));

        let session_controls = RwLock::new(HashMap::from([(
            session_id,
            SessionControlState {
                modes: Some(modes),
                config_options: options,
                omp_yolo_mode: false,
                ..Default::default()
            },
        )]));

        assert_eq!(
            effective_auto_approve_mode(AgentAutoApproveMode::Off, &session_controls, session_id)
                .await,
            AgentAutoApproveMode::Off
        );

        session_controls
            .write()
            .await
            .get_mut(&session_id)
            .unwrap()
            .omp_yolo_mode = true;
        assert_eq!(
            effective_auto_approve_mode(AgentAutoApproveMode::Off, &session_controls, session_id)
                .await,
            AgentAutoApproveMode::Yolo
        );

        session_controls
            .write()
            .await
            .get_mut(&session_id)
            .unwrap()
            .omp_yolo_mode = false;
        assert_eq!(
            effective_auto_approve_mode(AgentAutoApproveMode::Off, &session_controls, session_id)
                .await,
            AgentAutoApproveMode::Off
        );
    }
}

