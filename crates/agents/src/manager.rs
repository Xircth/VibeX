use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
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
            BooleanConfigOptionCapabilities, CancelNotification, ClientCapabilities,
            ClientResponse, ClientSessionCapabilities, CloseSessionRequest, ContentBlock,
            CreateElicitationRequest, CreateElicitationResponse, CreateTerminalResponse,
            DeleteSessionRequest, ElicitationAcceptAction, ElicitationAction,
            ElicitationCapabilities, ElicitationContentValue, ElicitationFormCapabilities,
            ElicitationMode, ElicitationScope, ExtRequest, ExtResponse, ForkSessionRequest,
            ImageContent, Implementation, InitializeRequest, KillTerminalRequest,
            KillTerminalResponse, ListSessionsRequest, LoadSessionRequest, NewSessionRequest,
            PermissionOptionKind, PromptRequest, ReleaseTerminalResponse, RequestPermissionOutcome,
            RequestPermissionRequest, RequestPermissionResponse, ResourceLink,
            ResumeSessionRequest, SelectedPermissionOutcome, SessionConfigKind,
            SessionConfigOption as AcpSessionConfigOption, SessionConfigOptionCategory,
            SessionConfigOptionValue, SessionConfigOptionsCapabilities, SessionConfigSelectOption,
            SessionConfigSelectOptions, SessionConfigValueId, SessionId, SessionModeState,
            SessionNotification, SessionUpdate, SetSessionConfigOptionRequest,
            SetSessionModeRequest, TerminalId, TerminalOutputResponse, TextContent,
            ToolCallContent, ToolCallLocation, WaitForTerminalExitResponse,
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
use workspace_utils::process::{
    group_spawn_no_window, kill_process_group, new_hidden_tokio_command,
};

use crate::{
    AcpAuthStatusAdapter, AcpCapabilityNormalizer, AcpCapabilitySnapshot, AgentAutoApproveMode,
    AgentAvailableCommand, AgentConnectionId, AgentContentBlock, AgentElicitationId,
    AgentElicitationRequest, AgentElicitationResponse, AgentError, AgentErrorEvent, AgentEvent,
    AgentId, AgentListedSession, AgentPermissionId, AgentPermissionOption,
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
    grok_subagent::GrokSubagentTracker,
    state::{AgentConnectionSnapshot, AgentConnectionStatus},
    terminal::agent_terminal_registry,
};

/// Grok applies model changes through the non-standard `session/set_model`
/// method (`{sessionId, modelId}`) — its `session/set_config_option` handler
/// rejects the standard param shape. Typed as a custom ACP request so the
/// apply path stays on the typed JSON-RPC transport.
#[derive(Debug, Clone, Serialize, Deserialize, acp::JsonRpcRequest)]
#[request(
    method = "session/set_model",
    response = SetSessionModelResponse,
    crate = acp
)]
struct SetSessionModelRequest {
    session_id: SessionId,
    model_id: String,
}

impl SetSessionModelRequest {
    fn new(session_id: SessionId, model_id: String) -> Self {
        Self {
            session_id,
            model_id,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, acp::JsonRpcResponse)]
#[response(crate = acp)]
struct SetSessionModelResponse {
    #[serde(default)]
    _meta: Option<serde_json::Value>,
}

const MAX_TOOL_PREVIEW_BYTES: usize = 16 * 1024;
const MAX_TOOL_PREVIEW_IMAGES: usize = 4;

fn truncate_preview(value: String) -> String {
    if value.len() <= MAX_TOOL_PREVIEW_BYTES {
        return value;
    }
    let mut end = MAX_TOOL_PREVIEW_BYTES;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

fn acp_tool_input_preview(
    raw_input: Option<&serde_json::Value>,
    content: &[ToolCallContent],
    locations: &[ToolCallLocation],
) -> Option<String> {
    if let Some(raw_input) = raw_input {
        return serde_json::to_string(raw_input).ok().map(truncate_preview);
    }

    for item in content {
        if let ToolCallContent::Diff(diff) = item {
            return serde_json::to_string(&serde_json::json!({
                "file_path": diff.path,
                "oldText": diff.old_text,
                "newText": diff.new_text,
            }))
            .ok()
            .map(truncate_preview);
        }
    }

    locations.first().and_then(|location| {
        serde_json::to_string(&serde_json::json!({
            "path": location.path,
            "line": location.line,
        }))
        .ok()
        .map(truncate_preview)
    })
}

fn acp_tool_images(content: &[ToolCallContent]) -> Vec<crate::conversation::ImageData> {
    content
        .iter()
        .filter_map(|item| match item {
            ToolCallContent::Content(content) => match &content.content {
                ContentBlock::Image(image) => Some(crate::conversation::ImageData {
                    data: image.data.clone(),
                    mime_type: image.mime_type.clone(),
                    uri: image.uri.clone(),
                }),
                _ => None,
            },
            _ => None,
        })
        .take(MAX_TOOL_PREVIEW_IMAGES)
        .collect()
}

fn acp_tool_content_preview(content: &[ToolCallContent]) -> Option<String> {
    let visible = content
        .iter()
        .filter(|item| {
            !matches!(
                item,
                ToolCallContent::Content(content)
                    if matches!(&content.content, ContentBlock::Image(_))
            )
        })
        .collect::<Vec<_>>();
    (!visible.is_empty())
        .then(|| serde_json::to_string(&visible).ok().map(truncate_preview))
        .flatten()
}

const DEFAULT_HANDSHAKE_TIMEOUT_SECS: u64 = 60;
const STDERR_RING_BUFFER_BYTES: usize = 8 * 1024;
const HANDSHAKE_TIMEOUT_ENV: &str = "VIBEX_ACP_SPAWN_HANDSHAKE_TIMEOUT_SECS";
const FULL_GATE_FIXTURE_PROMPT: &str = "__vibex_agent_full_gate_fixture__";
// A prompt that produces no ACP activity (no message/thought/tool/plan/usage
// notification) for this long is treated as a hung agent and the turn is failed,
// so a Codex/agent stuck retrying an unreachable model can't spin "生成中"
// forever. Generous (10 min) and reset on ANY activity so it never kills a
// legitimately-streaming long turn; permission waits are exempt (see run_prompt).
const DEFAULT_PROMPT_IDLE_TIMEOUT_SECS: u64 = 600;
const PROMPT_IDLE_TIMEOUT_ENV: &str = "VIBEX_PROMPT_IDLE_TIMEOUT_SECS";
const PI_COMMAND_ENV: &str = "PI_ACP_PI_COMMAND";
const PI_CONFIG_DIR_ENV: &str = "PI_CODING_AGENT_DIR";
const PI_SESSION_DIR_ENV: &str = "PI_CODING_AGENT_SESSION_DIR";
const PI_TRUST_WORKSPACE_ENV: &str = "PI_ACP_TRUST_WORKSPACE";
const AUTH_STATUS_TIMEOUT_SECS: u64 = 5;
const MAX_CONTENT_META_BYTES: usize = 16 * 1024;

fn wire_mcp_offer(capabilities: &AcpCapabilitySnapshot) -> WireMcpOffer {
    WireMcpOffer {
        stdio: capabilities.mcp_stdio,
        http: capabilities.mcp_http,
        sse: capabilities.mcp_sse,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WireMcpOffer {
    stdio: bool,
    http: bool,
    sse: bool,
}

const PROXY_ENV_KEYS: [&str; 8] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
];

#[derive(Debug, Clone, Copy)]
struct SessionRestoreSupport {
    load: bool,
    resume: bool,
}

#[derive(Debug)]
struct StderrRingBuffer {
    capacity: usize,
    bytes: VecDeque<u8>,
}

impl StderrRingBuffer {
    fn new(capacity: usize) -> Self {
        Self {
            capacity,
            bytes: VecDeque::with_capacity(capacity),
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        if self.capacity == 0 {
            return;
        }
        for byte in bytes {
            if self.bytes.len() == self.capacity {
                self.bytes.pop_front();
            }
            self.bytes.push_back(*byte);
        }
    }

    fn summary(&self) -> Option<String> {
        if self.bytes.is_empty() {
            return None;
        }
        Some(
            String::from_utf8_lossy(&self.bytes.iter().copied().collect::<Vec<_>>())
                .trim()
                .to_string(),
        )
        .filter(|summary| !summary.is_empty())
    }
}

fn handshake_timeout() -> Duration {
    handshake_timeout_from_env_value(std::env::var(HANDSHAKE_TIMEOUT_ENV).ok().as_deref())
}

fn handshake_timeout_from_env_value(value: Option<&str>) -> Duration {
    let seconds = value
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|seconds| *seconds > 0)
        .unwrap_or(DEFAULT_HANDSHAKE_TIMEOUT_SECS);
    Duration::from_secs(seconds)
}

fn prompt_idle_timeout() -> Duration {
    prompt_idle_timeout_from_env_value(std::env::var(PROMPT_IDLE_TIMEOUT_ENV).ok().as_deref())
}

fn prompt_idle_timeout_from_env_value(value: Option<&str>) -> Duration {
    let seconds = value
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|seconds| *seconds > 0)
        .unwrap_or(DEFAULT_PROMPT_IDLE_TIMEOUT_SECS);
    Duration::from_secs(seconds)
}

fn format_handshake_timeout_error(timeout: Duration, stderr: Option<String>) -> String {
    let seconds = timeout.as_secs().max(1);
    match stderr {
        Some(stderr) => {
            format!("ACP handshake timed out after {seconds}s. Recent stderr: {stderr}")
        }
        None => format!("ACP handshake timed out after {seconds}s. No stderr captured."),
    }
}

/// Classify a real `session/load` failure into a semantic reason so the UI can
/// offer the right recovery (e.g. a `ResourceNotFound` means the agent's session
/// file is gone → "session expired, reload"). Driven entirely by the ACP error
/// code the agent actually returned — never guessed.
fn classify_session_load_error(error: &acp::Error) -> SessionLoadFailureReason {
    match i32::from(error.code) {
        // -32002 ResourceNotFound: the agent no longer has this session.
        -32002 => SessionLoadFailureReason::ResourceNotFound,
        // -32000 AuthRequired: the agent needs (re)authentication.
        -32000 => SessionLoadFailureReason::AuthenticationRequired {
            message: error.message.clone(),
        },
        _ => SessionLoadFailureReason::Other {
            message: format!("session/load failed: {error}"),
        },
    }
}

/// Map a real ACP/JSON-RPC error code to a stable, frontend-facing string so the
/// error card can distinguish auth / expired-session / cancelled / model issues
/// from a generic failure. The value mirrors the agent's actual error code.
fn acp_error_code_str(error: &acp::Error) -> Option<String> {
    let code = match i32::from(error.code) {
        -32700 => "parse_error",
        -32600 => "invalid_request",
        -32601 => "method_not_found",
        -32602 => "invalid_params",
        -32603 => "internal_error",
        -32800 => "request_cancelled",
        -32000 => "auth_required",
        -32002 => "resource_not_found",
        -32042 => "url_elicitation_required",
        other => return Some(format!("rpc_{other}")),
    };
    Some(code.to_string())
}

fn map_acp_session_error(context: &str, error: acp::Error) -> AgentError {
    match i32::from(error.code) {
        -32000 => AgentError::AuthenticationRequired(error.to_string()),
        -32002 => AgentError::SessionLoadFailed(SessionLoadFailureReason::ResourceNotFound),
        _ => AgentError::Runtime(format!("{context}: {error}")),
    }
}

fn map_session_restore_error(error: acp::Error) -> AgentError {
    match classify_session_load_error(&error) {
        SessionLoadFailureReason::AuthenticationRequired { message } => {
            AgentError::AuthenticationRequired(message)
        }
        reason => AgentError::SessionLoadFailed(reason),
    }
}

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
        result_tx: oneshot::Sender<AgentResult<(String, AgentSessionControlsSnapshot)>>,
    },
    DiscardSession {
        session_id: AgentSessionId,
        result_tx: oneshot::Sender<AgentResult<()>>,
    },
    ResumeSession {
        session_id: AgentSessionId,
        external_session_id: String,
        result_tx: oneshot::Sender<AgentResult<(String, AgentSessionControlsSnapshot)>>,
    },
    /// Fork the live ACP session (P1-4): the agent branches its context into a
    /// new server-side session; the returned id is the new (forked) session.
    ForkSession {
        session_id: AgentSessionId,
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
        mode_override: Option<String>,
        config_overrides: Vec<AgentSessionConfigOverride>,
    },
    Cancel {
        session_id: AgentSessionId,
        prompt_id: AgentPromptId,
    },
    Steer {
        session_id: AgentSessionId,
        expected_prompt_id: AgentPromptId,
        blocks: Vec<AgentContentBlock>,
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

#[derive(Debug)]
struct ManagedAgentConnection {
    snapshot: ManagedAgentConnectionSnapshot,
    cmd_tx: mpsc::Sender<AgentConnectionCommand>,
    capabilities: Arc<RwLock<AcpCapabilitySnapshot>>,
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
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
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

        let task = if self.driver_enabled {
            tokio::spawn(async move {
                runner.run(cmd_rx, ready_tx).await;
            })
        } else {
            // The in-memory driver has no process to spawn / handshake — it's
            // ready the moment it's registered.
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
        self.send_command(
            connection_id,
            AgentConnectionCommand::Prompt {
                session_id,
                prompt_id,
                blocks,
                mode_override,
                config_overrides,
            },
        )
        .await
    }

    pub async fn cancel_prompt(
        &self,
        connection_id: AgentConnectionId,
        session_id: AgentSessionId,
        prompt_id: AgentPromptId,
    ) -> AgentResult<()> {
        self.send_command(
            connection_id,
            AgentConnectionCommand::Cancel {
                session_id,
                prompt_id,
            },
        )
        .await
    }

    pub async fn steer_prompt(
        &self,
        connection_id: AgentConnectionId,
        session_id: AgentSessionId,
        expected_prompt_id: AgentPromptId,
        blocks: Vec<AgentContentBlock>,
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
    ) -> AgentResult<(String, AgentSessionControlsSnapshot)> {
        let (result_tx, result_rx) = oneshot::channel();
        self.send_command(
            connection_id,
            AgentConnectionCommand::ResumeSession {
                session_id,
                external_session_id: external_session_id.into(),
                result_tx,
            },
        )
        .await?;
        result_rx.await.map_err(|_| {
            AgentError::Runtime("agent connection closed before session resume completed".into())
        })?
    }

    pub async fn prepare_session(
        &self,
        connection_id: AgentConnectionId,
        session_id: AgentSessionId,
    ) -> AgentResult<(String, AgentSessionControlsSnapshot)> {
        let (result_tx, result_rx) = oneshot::channel();
        self.send_command(
            connection_id,
            AgentConnectionCommand::PrepareSession {
                session_id,
                result_tx,
            },
        )
        .await?;
        result_rx.await.map_err(|_| {
            AgentError::Runtime(
                "agent connection closed before ACP session preparation completed".into(),
            )
        })?
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
    ) -> AgentResult<String> {
        let (result_tx, result_rx) = oneshot::channel();
        self.send_command(
            connection_id,
            AgentConnectionCommand::ForkSession {
                session_id,
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
        connection
            .task
            .await
            .map_err(|error| AgentError::Runtime(format!("agent connection task failed: {error}")))
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
        self.connections.lock().await.contains_key(&connection_id)
    }

    #[cfg(test)]
    pub(crate) async fn replace_command_sender(
        &self,
        connection_id: AgentConnectionId,
        cmd_tx: mpsc::Sender<AgentConnectionCommand>,
    ) {
        self.connections
            .lock()
            .await
            .get_mut(&connection_id)
            .expect("test connection must be registered")
            .cmd_tx = cmd_tx;
    }

    async fn send_command(
        &self,
        connection_id: AgentConnectionId,
        command: AgentConnectionCommand,
    ) -> AgentResult<()> {
        let cmd_tx = {
            let connections = self.connections.lock().await;
            connections
                .get(&connection_id)
                .map(|connection| connection.cmd_tx.clone())
        }
        .ok_or_else(|| AgentError::ConnectionNotFound(connection_id.to_string()))?;

        if cmd_tx.send(command).await.is_ok() {
            return Ok(());
        }

        self.connections.lock().await.remove(&connection_id);
        Err(AgentError::Runtime(
            "agent connection command channel closed".into(),
        ))
    }
}

#[derive(Debug, Clone)]
struct AgentConnectionRunner {
    snapshot: ManagedAgentConnectionSnapshot,
    event_tx: mpsc::UnboundedSender<AgentConnectionManagerEvent>,
    session_map: Arc<RwLock<HashMap<AgentSessionId, String>>>,
    session_controls: Arc<RwLock<HashMap<AgentSessionId, SessionControlState>>>,
    capabilities: Arc<RwLock<AcpCapabilitySnapshot>>,
    pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
    pending_elicitations: Arc<Mutex<HashMap<String, PendingElicitation>>>,
    auto_approve_mode: AgentAutoApproveMode,
    delegation_injector: Option<Arc<dyn DelegationInjector>>,
    // Per-session streaming-text accumulator shared with the ACP client bridge so
    // redundant full-message snapshots can be dropped (see `dedup_stream_text`).
    stream_dedup: Arc<Mutex<HashMap<String, StreamDedupState>>>,
    // The (session, prompt) currently in flight on this connection, if any. Lets
    // the connection-death fallback in `run()` emit a turn-terminal event carrying
    // the real prompt_id so the conversation fails cleanly instead of hanging.
    active_prompt: Arc<Mutex<Option<(AgentSessionId, AgentPromptId)>>>,
    // Last time the agent produced ACP activity for the in-flight prompt; shared
    // with the bridge (refreshed on every session notification) so the prompt
    // idle watchdog can fail a silently-hung agent without killing live turns.
    last_activity: Arc<Mutex<Instant>>,
    grok_subagent: Arc<Mutex<GrokSubagentTracker>>,
    pending_session_id: Arc<Mutex<Option<AgentSessionId>>>,
}

/// Non-standard wire surface an ACP agent requires for its vendor-advertised
/// session controls. Standard ACP agents keep `None` and use
/// `session/set_config_option` unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VendorConfigWire {
    /// Grok (`grok agent stdio`) advertises config through
    /// `_meta["x.ai/sessionConfig"]` and applies model changes via the
    /// non-standard `session/set_model` method (`{sessionId, modelId}`).
    XaiSessionConfig,
}

#[derive(Debug, Clone, Default)]
struct SessionControlState {
    config_options: Vec<AcpSessionConfigOption>,
    /// Set when `config_options` were synthesized from a vendor `_meta`
    /// extension instead of the standard ACP response fields.
    vendor_config: Option<VendorConfigWire>,
    /// True when the category=`mode` option was adapted from V1 Session Modes
    /// and must be written back with `session/set_mode`.
    mode_uses_set_mode: bool,
    available_commands: Option<Vec<AgentAvailableCommand>>,
}

#[derive(Debug)]
struct PendingPermission {
    permission_id: AgentPermissionId,
    session_id: AgentSessionId,
    tx: oneshot::Sender<AgentPermissionResponse>,
}

#[derive(Debug)]
struct PendingElicitation {
    elicitation_id: AgentElicitationId,
    session_id: AgentSessionId,
    tx: oneshot::Sender<AgentElicitationResponse>,
}

/// Owned inputs for [`AgentConnectionRunner::run_prompt`], bundled into one
/// struct so the method stays under clippy's argument-count threshold.
struct RunPromptRequest {
    acp_session_id: String,
    session_id: AgentSessionId,
    prompt_id: AgentPromptId,
    blocks: Vec<AgentContentBlock>,
    mode_override: Option<String>,
    config_overrides: Vec<AgentSessionConfigOverride>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "_session/steering", response = AcpSteerResponse)]
#[serde(rename_all = "camelCase")]
struct AcpSteerRequest {
    session_id: String,
    prompt: Vec<ContentBlock>,
    #[serde(rename = "_meta")]
    meta: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonRpcResponse)]
#[serde(rename_all = "camelCase")]
struct AcpSteerResponse {
    outcome: String,
    #[serde(default)]
    reason: Option<String>,
}

fn map_steer_response(response: AcpSteerResponse) -> AgentResult<AgentSteerReceipt> {
    let outcome = match response.outcome.as_str() {
        "injected" => AgentSteerOutcome::Injected,
        "promptRequired" => AgentSteerOutcome::PromptRequired,
        "startedNewTurn" => AgentSteerOutcome::StartedNewTurn,
        other => {
            return Err(AgentError::Runtime(format!(
                "agent returned unknown steering outcome `{other}`"
            )));
        }
    };
    Ok(AgentSteerReceipt {
        outcome,
        reason: response.reason,
    })
}

impl AgentConnectionRunner {
    fn new(
        snapshot: ManagedAgentConnectionSnapshot,
        event_tx: mpsc::UnboundedSender<AgentConnectionManagerEvent>,
        delegation_injector: Option<Arc<dyn DelegationInjector>>,
    ) -> Self {
        let auto_approve_mode = snapshot.auto_approve_mode;
        Self {
            snapshot,
            event_tx,
            session_map: Arc::new(RwLock::new(HashMap::new())),
            session_controls: Arc::new(RwLock::new(HashMap::new())),
            capabilities: Arc::new(RwLock::new(AcpCapabilitySnapshot::default())),
            pending_permissions: Arc::new(Mutex::new(HashMap::new())),
            pending_elicitations: Arc::new(Mutex::new(HashMap::new())),
            auto_approve_mode,
            delegation_injector,
            stream_dedup: Arc::new(Mutex::new(HashMap::new())),
            active_prompt: Arc::new(Mutex::new(None)),
            last_activity: Arc::new(Mutex::new(Instant::now())),
            grok_subagent: Arc::new(Mutex::new(GrokSubagentTracker::default())),
            pending_session_id: Arc::new(Mutex::new(None)),
        }
    }

    async fn run(
        self,
        cmd_rx: mpsc::Receiver<AgentConnectionCommand>,
        ready_tx: oneshot::Sender<AgentResult<()>>,
    ) {
        // Shared so run_acp signals Ok at handshake AND a pre-handshake failure
        // forwards the REAL error to `connect` (instead of a dropped-sender
        // generic). `take()` makes exactly one of the two fire.
        let ready = Arc::new(Mutex::new(Some(ready_tx)));
        if let Err(error) = self.run_acp(cmd_rx, Arc::clone(&ready)).await {
            let message = error.to_string();
            if let Some(tx) = ready.lock().await.take() {
                let _ = tx.send(Err(error));
            }
            self.emit_connection_status(AgentConnectionStatus::Failed, Some(message.clone()));
            // If a prompt was still in flight when the connection died (the agent
            // crashed, the transport dropped, or prompt setup like session/new
            // failed and propagated out of run_prompt), emit a turn-terminal Error
            // carrying its (session_id, prompt_id) so the conversation fails
            // cleanly. Without these ids the event is dropped before reaching the
            // turn (events.rs requires a session_id) and the turn spins forever.
            // `run_prompt` clears `active_prompt` whenever it emits its own
            // terminal event, so this fires only when nothing else closed the turn.
            let (failed_session_id, failed_prompt_id) = match self.active_prompt.lock().await.take()
            {
                Some((session_id, prompt_id)) => (Some(session_id), Some(prompt_id)),
                None => (None, None),
            };
            self.emit(
                failed_session_id,
                failed_prompt_id,
                AgentEvent::Error {
                    error: AgentErrorEvent {
                        message,
                        code: None,
                        raw: None,
                    },
                },
            );
        }
    }

    async fn run_in_memory(self, mut cmd_rx: mpsc::Receiver<AgentConnectionCommand>) {
        while let Some(command) = cmd_rx.recv().await {
            match command {
                AgentConnectionCommand::PrepareSession {
                    session_id,
                    result_tx,
                } => {
                    let acp_session_id = format!("prepared-{}", session_id.0);
                    self.session_map
                        .write()
                        .await
                        .insert(session_id, acp_session_id.clone());
                    let _ = result_tx.send(Ok((
                        acp_session_id,
                        AgentSessionControlsSnapshot::default(),
                    )));
                }
                AgentConnectionCommand::DiscardSession {
                    session_id,
                    result_tx,
                } => {
                    self.session_map.write().await.remove(&session_id);
                    self.session_controls.write().await.remove(&session_id);
                    let _ = result_tx.send(Ok(()));
                }
                AgentConnectionCommand::ResumeSession {
                    session_id,
                    external_session_id,
                    result_tx,
                } => {
                    self.session_map
                        .write()
                        .await
                        .insert(session_id, external_session_id.clone());
                    let controls = AgentSessionControlsSnapshot::default();
                    let _ = result_tx.send(Ok((external_session_id, controls)));
                }
                AgentConnectionCommand::ForkSession {
                    session_id,
                    result_tx,
                } => {
                    // The in-memory agent has no server-side session; hand back a
                    // synthetic forked id so the fork flow is exercisable in tests.
                    let _ = result_tx.send(Ok(format!("fork-{}", session_id.0)));
                }
                AgentConnectionCommand::ListSessions { result_tx, .. } => {
                    let _ = result_tx.send(Err(AgentError::Runtime(
                        "agent does not support session/list".into(),
                    )));
                }
                AgentConnectionCommand::DeleteSession { result_tx, .. } => {
                    let _ = result_tx.send(Err(AgentError::Runtime(
                        "agent does not support session/delete".into(),
                    )));
                }
                AgentConnectionCommand::Prompt {
                    session_id,
                    prompt_id,
                    blocks,
                    ..
                } => {
                    let text = blocks
                        .into_iter()
                        .map(|block| match block {
                            AgentContentBlock::Text { text } => text,
                            AgentContentBlock::Image { uri, .. } => {
                                uri.as_deref().unwrap_or("[image]").to_string()
                            }
                            AgentContentBlock::Resource { uri, .. } => uri,
                            AgentContentBlock::Protocol { content } => {
                                serde_json::to_string(&content).unwrap_or_default()
                            }
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    if text.contains(FULL_GATE_FIXTURE_PROMPT) {
                        self.run_full_gate_fixture(session_id, prompt_id).await;
                        continue;
                    }
                    self.emit(
                        Some(session_id),
                        Some(prompt_id),
                        AgentEvent::MessageChunk {
                            content: AgentContentBlock::Text { text },
                        },
                    );
                }
                AgentConnectionCommand::Cancel {
                    session_id,
                    prompt_id,
                } => self.emit(
                    Some(session_id),
                    Some(prompt_id),
                    AgentEvent::PromptFinished {
                        finished: AgentPromptFinished {
                            prompt_id,
                            stop_reason: Some("cancelled".to_string()),
                        },
                    },
                ),
                AgentConnectionCommand::Steer { result_tx, .. } => {
                    let _ = result_tx.send(Err(AgentError::SteeringUnsupported));
                }
                AgentConnectionCommand::RespondPermission {
                    permission_id,
                    response,
                } => {
                    self.respond_pending_permission(&permission_id, response)
                        .await
                }
                AgentConnectionCommand::RespondElicitation {
                    elicitation_id,
                    response,
                } => {
                    self.respond_pending_elicitation(&elicitation_id, response)
                        .await
                }
                AgentConnectionCommand::SetSessionMode {
                    session_id,
                    mode_id,
                    result_tx,
                } => {
                    // No ACP server behind the in-memory driver — acknowledge and
                    // emit the change so mode-switch flows are exercisable in tests.
                    self.emit(Some(session_id), None, AgentEvent::ModeChanged { mode_id });
                    let _ = result_tx.send(Ok(self.session_controls_snapshot(session_id).await));
                }
                AgentConnectionCommand::SetSessionConfigOption {
                    session_id,
                    key,
                    value,
                    result_tx,
                } => {
                    self.emit(
                        Some(session_id),
                        None,
                        AgentEvent::ConfigChanged {
                            key,
                            value: serde_json::json!(value),
                        },
                    );
                    let _ = result_tx.send(Ok(self.session_controls_snapshot(session_id).await));
                }
                AgentConnectionCommand::Disconnect => break,
            }
        }
    }

    async fn run_full_gate_fixture(&self, session_id: AgentSessionId, prompt_id: AgentPromptId) {
        self.emit(
            Some(session_id),
            Some(prompt_id),
            AgentEvent::MessageChunk {
                content: AgentContentBlock::Text {
                    text: "fixture stream chunk".to_string(),
                },
            },
        );
        self.emit(
            Some(session_id),
            Some(prompt_id),
            AgentEvent::ToolCall {
                tool_call: AgentToolCall {
                    id: "fixture-tool".to_string(),
                    title: "Inspect fixture workspace".to_string(),
                    kind: Some("read".to_string()),
                    input_preview: None,
                    meta: None,
                    images: Vec::new(),
                },
            },
        );
        self.emit(
            Some(session_id),
            Some(prompt_id),
            AgentEvent::ToolCallUpdate {
                update: AgentToolCallUpdate {
                    id: "fixture-tool".to_string(),
                    status: Some("running".to_string()),
                    content: Some("reading fixture input".to_string()),
                    input_preview: None,
                    meta: None,
                    images: Vec::new(),
                },
            },
        );
        self.emit(
            Some(session_id),
            None,
            AgentEvent::AvailableCommands {
                commands: vec![AgentAvailableCommand {
                    name: "/fixture".to_string(),
                    description: Some("Run fixture command".to_string()),
                    input_schema: Some(serde_json::json!({"type": "object"})),
                }],
            },
        );
        self.emit(
            Some(session_id),
            None,
            AgentEvent::SessionModes {
                modes: vec![
                    AgentSessionMode {
                        id: "plan".to_string(),
                        label: "Plan".to_string(),
                        description: Some("Plan fixture changes".to_string()),
                    },
                    AgentSessionMode {
                        id: "code".to_string(),
                        label: "Code".to_string(),
                        description: Some("Apply fixture changes".to_string()),
                    },
                ],
                current: Some("code".to_string()),
            },
        );
        self.emit(
            Some(session_id),
            None,
            AgentEvent::SessionConfigOptions {
                options: vec![AgentSessionConfigOption {
                    key: "model".to_string(),
                    label: "Model".to_string(),
                    description: Some("Fixture model selector".to_string()),
                    category: Some("model".to_string()),
                    value: Some(serde_json::json!("fixture-model")),
                    choices: vec![AgentSessionConfigChoice {
                        value: serde_json::json!("fixture-model"),
                        label: "Fixture Model".to_string(),
                        description: None,
                    }],
                    dependency: None,
                }],
            },
        );

        let permission_id = AgentPermissionId::new();
        let request = AgentPermissionRequest {
            id: permission_id,
            session_id,
            title: "Allow fixture tool".to_string(),
            details: Some(serde_json::json!({
                "tool": "fixture-tool",
                "prompt_id": prompt_id.to_string(),
            })),
            options: vec![
                AgentPermissionOption {
                    id: "allow-once".to_string(),
                    label: "Allow once".to_string(),
                    kind: AgentPermissionOptionKind::AllowOnce,
                    description: None,
                },
                AgentPermissionOption {
                    id: "reject-once".to_string(),
                    label: "Reject once".to_string(),
                    kind: AgentPermissionOptionKind::RejectOnce,
                    description: None,
                },
            ],
        };
        self.emit(
            Some(session_id),
            None,
            AgentEvent::PermissionRequested {
                request: request.clone(),
            },
        );

        let auto_approve_mode =
            effective_auto_approve_mode(self.auto_approve_mode, &self.session_controls, session_id)
                .await;
        if let Some(response) = decide_auto_permission_response(auto_approve_mode, &request) {
            self.emit(
                Some(session_id),
                None,
                AgentEvent::PermissionResponded {
                    permission_id,
                    response,
                    auto: true,
                },
            );
            self.emit_full_gate_completion(session_id, prompt_id);
            return;
        }

        let (tx, rx) = oneshot::channel();
        self.pending_permissions.lock().await.insert(
            permission_id.to_string(),
            PendingPermission {
                permission_id,
                session_id,
                tx,
            },
        );
        let runner = self.clone();
        tokio::spawn(async move {
            let _ = rx.await;
            runner.emit_full_gate_completion(session_id, prompt_id);
        });
    }

    fn emit_full_gate_completion(&self, session_id: AgentSessionId, prompt_id: AgentPromptId) {
        self.emit(
            Some(session_id),
            Some(prompt_id),
            AgentEvent::ToolCallUpdate {
                update: AgentToolCallUpdate {
                    id: "fixture-tool".to_string(),
                    status: Some("completed".to_string()),
                    content: Some("fixture tool completed".to_string()),
                    input_preview: None,
                    meta: None,
                    images: Vec::new(),
                },
            },
        );
        self.emit(
            Some(session_id),
            Some(prompt_id),
            AgentEvent::TurnCompleted {
                stop_reason: Some("end_turn".to_string()),
            },
        );
        self.emit(
            Some(session_id),
            Some(prompt_id),
            AgentEvent::PromptFinished {
                finished: AgentPromptFinished {
                    prompt_id,
                    stop_reason: Some("end_turn".to_string()),
                },
            },
        );
    }

    async fn run_acp(
        &self,
        mut cmd_rx: mpsc::Receiver<AgentConnectionCommand>,
        ready_tx: Arc<Mutex<Option<oneshot::Sender<AgentResult<()>>>>>,
    ) -> AgentResult<()> {
        let launch_lock = &self.snapshot.launch_lock;
        if launch_lock.agent_id != self.snapshot.agent_id {
            return Err(AgentError::Runtime(
                "Installation lock belongs to another Agent".to_string(),
            ));
        }
        if !launch_lock.absolute_acp_program.is_absolute() {
            return Err(AgentError::Runtime(
                "Installation lock does not contain an absolute ACP program".to_string(),
            ));
        }
        // The persisted program can go stale (Agent self-update, interrupted
        // install cleanup, moved external install). Fail with an actionable
        // repair message instead of a raw ENOENT from `Command::spawn`.
        if !crate::launch_program_available(&launch_lock.absolute_acp_program) {
            return Err(AgentError::Runtime(crate::missing_launch_program_error(
                &launch_lock.absolute_acp_program,
            )));
        }
        if !self.snapshot.working_dir.is_dir() {
            return Err(AgentError::Runtime(format!(
                "workspace working directory is missing: {}",
                self.snapshot.working_dir.display()
            )));
        }
        let mut command =
            new_hidden_tokio_command(&launch_lock.absolute_acp_program, &launch_lock.args);

        if self.snapshot.agent_id.as_str() == "pi"
            && let Err(error) =
                seed_pi_workspace_trust(&self.snapshot.working_dir, &self.snapshot.env)
        {
            tracing::warn!(%error, "could not seed Pi workspace trust");
        }
        command
            .kill_on_drop(true)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .current_dir(&self.snapshot.working_dir);

        for (key, value) in merged_agent_env(&self.snapshot.env) {
            command.env(key, value);
        }
        for (key, value) in &launch_lock.env {
            command.env(key, value);
        }
        // Pi runtime preferences are mutable user settings. They must win over
        // values captured by an older external-adoption lock; clearing a field
        // must also remove an inherited or legacy lock value.
        if self.snapshot.agent_id.as_str() == "pi" {
            for key in [PI_COMMAND_ENV, PI_CONFIG_DIR_ENV, PI_SESSION_DIR_ENV] {
                match self
                    .snapshot
                    .env
                    .get(key)
                    .map(String::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    Some(value) => {
                        command.env(key, value);
                    }
                    None => {
                        command.env_remove(key);
                    }
                }
            }
        }
        for key in
            crate::built_in_auth_mode_scrubbed_env_keys(&self.snapshot.agent_id, &self.snapshot.env)
        {
            command.env_remove(key);
        }
        // This is a VibeX-side policy toggle, not an environment variable Pi
        // or pi-acp should observe.
        command.env_remove(PI_TRUST_WORKSPACE_ENV);
        // The child inherits the full parent env. A blank `OPENAI_API_KEY=""`
        // (or `OPENAI_BASE_URL=""`) leaked from the shell that launched VibeX
        // makes codex think an API key is present but empty, derailing its
        // ChatGPT-oauth auth. Drop such empty, non-user-configured creds so the
        // agent authenticates the same way it does when launched from a clean
        // shell. Non-empty values are left untouched (a real key is honored).
        for key in ["OPENAI_API_KEY", "OPENAI_BASE_URL"] {
            let inherited_blank = std::env::var(key)
                .map(|value| value.trim().is_empty())
                .unwrap_or(false);
            if inherited_blank && !self.snapshot.env.contains_key(key) {
                command.env_remove(key);
            }
        }

        let mut child = group_spawn_no_window(&mut command)
            .map_err(|error| AgentError::Runtime(format!("failed to spawn ACP agent: {error}")))?;
        let stdout = child
            .inner()
            .stdout
            .take()
            .ok_or_else(|| AgentError::Runtime("ACP child missing stdout".to_string()))?;
        let stdin = child
            .inner()
            .stdin
            .take()
            .ok_or_else(|| AgentError::Runtime("ACP child missing stdin".to_string()))?;
        let stderr = child.inner().stderr.take();

        let (mut to_acp_writer, acp_incoming_reader) = tokio::io::duplex(64 * 1024);
        tokio::spawn(async move {
            let mut stdout_stream = ReaderStream::new(stdout);
            while let Some(result) = stdout_stream.next().await {
                match result {
                    Ok(bytes) => {
                        if to_acp_writer.write_all(&bytes).await.is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        let (acp_out_writer, acp_out_reader) = tokio::io::duplex(64 * 1024);
        tokio::spawn(async move {
            let mut child_stdin = stdin;
            let mut outbound = ReaderStream::new(acp_out_reader);
            while let Some(result) = outbound.next().await {
                match result {
                    Ok(bytes) => {
                        if child_stdin.write_all(&bytes).await.is_err() {
                            break;
                        }
                        let _ = child_stdin.flush().await;
                    }
                    Err(_) => break,
                }
            }
        });
        let stderr_buffer = Arc::new(Mutex::new(StderrRingBuffer::new(STDERR_RING_BUFFER_BYTES)));
        if let Some(stderr) = stderr {
            let runner_for_stderr = self.clone();
            let stderr_buffer_for_task = Arc::clone(&stderr_buffer);
            tokio::spawn(async move {
                let mut stderr_stream = ReaderStream::new(stderr);
                while let Some(result) = stderr_stream.next().await {
                    match result {
                        Ok(bytes) => {
                            stderr_buffer_for_task.lock().await.push(&bytes);
                            runner_for_stderr.emit(
                                None,
                                None,
                                AgentEvent::RawAcpDiagnostic {
                                    raw: serde_json::json!({
                                        "kind": "stderr",
                                        "text": String::from_utf8_lossy(&bytes).to_string(),
                                    }),
                                },
                            );
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        let transport =
            acp::ByteStreams::new(acp_out_writer.compat_write(), acp_incoming_reader.compat());
        let bridge = AcpClientBridge::new(
            self.snapshot.connection_id,
            self.snapshot.agent_id.clone(),
            self.event_tx.clone(),
            Arc::clone(&self.session_map),
            Arc::clone(&self.session_controls),
            Arc::clone(&self.pending_permissions),
            Arc::clone(&self.pending_elicitations),
            self.auto_approve_mode,
            Arc::clone(&self.stream_dedup),
            Arc::clone(&self.last_activity),
            Arc::clone(&self.grok_subagent),
            Arc::clone(&self.pending_session_id),
        );
        let request_bridge = bridge.clone();
        let notification_bridge = bridge;
        let runner = self.clone();
        let working_dir = self.snapshot.working_dir.clone();
        let handshake_timeout_duration = handshake_timeout();
        let handshake_timed_out = Arc::new(AtomicBool::new(false));
        let handshake_timed_out_for_connection = Arc::clone(&handshake_timed_out);

        let result = acp::Client
            .builder()
            .name("VibeX")
            .on_receive_request(
                async move |request: AgentRequest, responder, _cx| {
                    let response = request_bridge.handle_agent_request(request).await?;
                    let response =
                        serde_json::to_value(response).map_err(acp::Error::into_internal_error)?;
                    responder.respond(response)
                },
                acp::on_receive_request!(),
            )
            .on_receive_notification(
                async move |notification: AgentNotification, _cx| {
                    notification_bridge
                        .handle_agent_notification(notification)
                        .await
                },
                acp::on_receive_notification!(),
            )
            .connect_with(transport, |conn: ConnectionTo<Agent>| async move {
                let client_capabilities = ClientCapabilities::new()
                    .terminal(true)
                    .session(
                        ClientSessionCapabilities::new().config_options(
                            SessionConfigOptionsCapabilities::new()
                                .boolean(BooleanConfigOptionCapabilities::new()),
                        ),
                    )
                    .elicitation(
                        // Form mode only: it covers AskUserQuestion and MCP
                        // form elicitations. URL mode needs a browser hand-off
                        // flow the app doesn't have yet.
                        ElicitationCapabilities::new().form(ElicitationFormCapabilities::new()),
                    );
                let initialize = AcpAuthStatusAdapter::initialize(
                    &conn,
                    InitializeRequest::new(ProtocolVersion::LATEST)
                        .client_capabilities(client_capabilities.clone())
                        .client_info(Implementation::new("vibex", env!("CARGO_PKG_VERSION"))),
                );
                let (initialize_response, raw_capabilities) =
                    match tokio::time::timeout(handshake_timeout_duration, initialize).await {
                        Ok(result) => result?,
                        Err(_) => {
                            handshake_timed_out_for_connection.store(true, Ordering::SeqCst);
                            return Err(acp::Error::internal_error());
                        }
                    };
                let mut capability_snapshot = AcpCapabilityNormalizer::normalize(
                    initialize_response.protocol_version,
                    &initialize_response.agent_capabilities,
                    &raw_capabilities,
                    &client_capabilities,
                );
                let initialize_meta = initialize_response
                    .meta
                    .as_ref()
                    .map(|meta| serde_json::Value::Object(meta.clone()));
                capability_snapshot.steering =
                    AcpCapabilityNormalizer::steering_is_advertised(initialize_meta.as_ref());
                capability_snapshot.authentication = AcpAuthStatusAdapter::observe_if_advertised(
                    &conn,
                    &raw_capabilities,
                    1,
                    Duration::from_secs(AUTH_STATUS_TIMEOUT_SECS),
                )
                .await
                .map(Into::into);
                *runner.capabilities.write().await = capability_snapshot.clone();
                let supports_load_session = initialize_response.agent_capabilities.load_session;
                let supports_resume_session = initialize_response
                    .agent_capabilities
                    .session_capabilities
                    .resume
                    .is_some();
                let supports_close_session = initialize_response
                    .agent_capabilities
                    .session_capabilities
                    .close
                    .is_some();
                let supports_fork = initialize_response
                    .agent_capabilities
                    .session_capabilities
                    .fork
                    .is_some();
                let companion_capabilities = CompanionCapabilities {
                    accepts_session_mcp_servers: capability_snapshot.accepts_session_mcp_servers(),
                };
                let supports_list = initialize_response
                    .agent_capabilities
                    .session_capabilities
                    .list
                    .is_some();
                let supports_delete = initialize_response
                    .agent_capabilities
                    .session_capabilities
                    .delete
                    .is_some();
                // Handshake succeeded — the connection is now genuinely reachable.
                // Signal readiness so `connect` can mark it Ready. A failure before
                // this point leaves the sender for `run` to forward the real error.
                if let Some(tx) = ready_tx.lock().await.take() {
                    let _ = tx.send(Ok(()));
                }

                while let Some(command) = cmd_rx.recv().await {
                    match command {
                        AgentConnectionCommand::PrepareSession {
                            session_id,
                            result_tx,
                        } => {
                            let result = match runner
                                .ensure_acp_session(
                                    &conn,
                                    &working_dir,
                                    session_id,
                                    companion_capabilities,
                                )
                                .await
                            {
                                Ok(acp_session_id) => {
                                    let controls =
                                        runner.session_controls_snapshot(session_id).await;
                                    // `PrepareSession` is also called when the prepared
                                    // session is adopted by the conversation service. Re-emit
                                    // the authoritative state here so those events enter the
                                    // now-persisted conversation stream instead of existing
                                    // only during the create-dialog preview.
                                    runner.emit_controls_snapshot(session_id, &controls);
                                    Ok((acp_session_id, controls))
                                }
                                Err(error) => Err(map_acp_session_error(
                                    "ACP session preparation failed",
                                    error,
                                )),
                            };
                            let _ = result_tx.send(result);
                        }
                        AgentConnectionCommand::DiscardSession {
                            session_id,
                            result_tx,
                        } => {
                            let acp_session_id =
                                runner.session_map.read().await.get(&session_id).cloned();
                            let result = if supports_close_session {
                                if let Some(acp_session_id) = acp_session_id.as_ref() {
                                    conn.send_request(CloseSessionRequest::new(SessionId::new(
                                        acp_session_id.clone(),
                                    )))
                                    .block_task()
                                    .await
                                    .map(|_| ())
                                    .map_err(|error| {
                                        AgentError::Runtime(format!(
                                            "session/close failed: {error}"
                                        ))
                                    })
                                } else {
                                    Ok(())
                                }
                            } else {
                                Ok(())
                            };
                            if result.is_ok() {
                                runner.session_map.write().await.remove(&session_id);
                                runner.session_controls.write().await.remove(&session_id);
                            }
                            let _ = result_tx.send(result);
                        }
                        AgentConnectionCommand::ResumeSession {
                            session_id,
                            external_session_id,
                            result_tx,
                        } => {
                            let result = runner
                                .load_or_new_acp_session(
                                    &conn,
                                    &working_dir,
                                    session_id,
                                    external_session_id,
                                    SessionRestoreSupport {
                                        load: supports_load_session,
                                        resume: supports_resume_session,
                                    },
                                    companion_capabilities,
                                )
                                .await;
                            let result = match result {
                                Ok(acp_session_id) => Ok((
                                    acp_session_id,
                                    runner.session_controls_snapshot(session_id).await,
                                )),
                                Err(error) => Err(error),
                            };
                            let _ = result_tx.send(result);
                        }
                        AgentConnectionCommand::Prompt {
                            session_id,
                            prompt_id,
                            blocks,
                            mode_override,
                            config_overrides,
                        } => {
                            let acp_session_id = runner
                                .ensure_acp_session(
                                    &conn,
                                    &working_dir,
                                    session_id,
                                    companion_capabilities,
                                )
                                .await?;
                            runner
                                .run_prompt(
                                    &conn,
                                    RunPromptRequest {
                                        acp_session_id,
                                        session_id,
                                        prompt_id,
                                        blocks,
                                        mode_override,
                                        config_overrides,
                                    },
                                    &mut cmd_rx,
                                )
                                .await?;
                        }
                        AgentConnectionCommand::Steer {
                            expected_prompt_id,
                            result_tx,
                            ..
                        } => {
                            let _ = result_tx.send(Err(AgentError::PromptNotFound(
                                expected_prompt_id.to_string(),
                            )));
                        }
                        AgentConnectionCommand::ForkSession {
                            session_id,
                            result_tx,
                        } => {
                            let result = if supports_fork {
                                runner
                                    .fork_acp_session(
                                        &conn,
                                        &working_dir,
                                        session_id,
                                        companion_capabilities,
                                    )
                                    .await
                                    .map_err(|error| {
                                        AgentError::Runtime(format!(
                                            "ACP session fork failed: {error}"
                                        ))
                                    })
                            } else {
                                Err(AgentError::Runtime(
                                    "agent does not support session/fork".into(),
                                ))
                            };
                            let _ = result_tx.send(result);
                        }
                        AgentConnectionCommand::ListSessions {
                            cwd,
                            cursor,
                            result_tx,
                        } => {
                            let result = if supports_list {
                                let response = conn
                                    .send_request(
                                        ListSessionsRequest::new().cwd(cwd).cursor(cursor),
                                    )
                                    .block_task()
                                    .await
                                    .map_err(|error| {
                                        AgentError::Runtime(format!("session/list failed: {error}"))
                                    });
                                response.map(|response| AgentSessionListPage {
                                    sessions: response
                                        .sessions
                                        .into_iter()
                                        .map(|session| AgentListedSession {
                                            acp_session_id: session.session_id.0.to_string(),
                                            cwd: session.cwd.to_string_lossy().into_owned(),
                                            additional_directories: session
                                                .additional_directories
                                                .into_iter()
                                                .map(|path| path.to_string_lossy().into_owned())
                                                .collect(),
                                            title: session.title,
                                            updated_at: session.updated_at,
                                            meta: bounded_optional_meta(session.meta),
                                        })
                                        .collect(),
                                    next_cursor: response.next_cursor,
                                    meta: bounded_optional_meta(response.meta),
                                })
                            } else {
                                Err(AgentError::Runtime(
                                    "agent does not support session/list".into(),
                                ))
                            };
                            let _ = result_tx.send(result);
                        }
                        AgentConnectionCommand::DeleteSession {
                            external_session_id,
                            result_tx,
                        } => {
                            let result = if supports_delete {
                                conn.send_request(DeleteSessionRequest::new(SessionId::new(
                                    external_session_id,
                                )))
                                .block_task()
                                .await
                                .map(|_| ())
                                .map_err(|error| {
                                    AgentError::Runtime(format!("session/delete failed: {error}"))
                                })
                            } else {
                                Err(AgentError::Runtime(
                                    "agent does not support session/delete".into(),
                                ))
                            };
                            let _ = result_tx.send(result);
                        }
                        AgentConnectionCommand::Cancel {
                            session_id,
                            prompt_id,
                        } => {
                            runner.emit(
                                Some(session_id),
                                Some(prompt_id),
                                AgentEvent::PromptFinished {
                                    finished: AgentPromptFinished {
                                        prompt_id,
                                        stop_reason: Some("cancelled".to_string()),
                                    },
                                },
                            );
                        }
                        AgentConnectionCommand::RespondPermission {
                            permission_id,
                            response,
                        } => {
                            runner
                                .respond_pending_permission(&permission_id, response)
                                .await;
                        }
                        AgentConnectionCommand::RespondElicitation {
                            elicitation_id,
                            response,
                        } => {
                            runner
                                .respond_pending_elicitation(&elicitation_id, response)
                                .await;
                        }
                        AgentConnectionCommand::SetSessionMode {
                            session_id,
                            mode_id,
                            result_tx,
                        } => {
                            let result = runner
                                .set_live_session_mode(&conn, session_id, &mode_id)
                                .await;
                            let _ = result_tx.send(result);
                        }
                        AgentConnectionCommand::SetSessionConfigOption {
                            session_id,
                            key,
                            value,
                            result_tx,
                        } => {
                            let result = runner
                                .set_live_session_config_option(&conn, session_id, &key, &value)
                                .await;
                            let _ = result_tx.send(result);
                        }
                        AgentConnectionCommand::Disconnect => break,
                    }
                }

                Ok::<(), acp::Error>(())
            })
            .await;

        let _ = kill_process_group(&mut child).await;
        if handshake_timed_out.load(Ordering::SeqCst) {
            let stderr = stderr_buffer.lock().await.summary();
            return Err(AgentError::Runtime(format_handshake_timeout_error(
                handshake_timeout_duration,
                stderr,
            )));
        }
        result.map_err(|error| AgentError::Runtime(format!("ACP connection failed: {error}")))
    }

    async fn ensure_acp_session(
        &self,
        conn: &ConnectionTo<Agent>,
        working_dir: &Path,
        session_id: AgentSessionId,
        companion_capabilities: CompanionCapabilities,
    ) -> Result<String, acp::Error> {
        if let Some(existing) = self.session_map.read().await.get(&session_id).cloned() {
            return Ok(existing);
        }

        self.new_acp_session(conn, working_dir, session_id, companion_capabilities)
            .await
    }

    async fn load_or_new_acp_session(
        &self,
        conn: &ConnectionTo<Agent>,
        working_dir: &Path,
        session_id: AgentSessionId,
        external_session_id: String,
        support: SessionRestoreSupport,
        companion_capabilities: CompanionCapabilities,
    ) -> AgentResult<String> {
        if let Some(existing) = self.session_map.read().await.get(&session_id).cloned() {
            return Ok(existing);
        }

        if support.load {
            let mut request = LoadSessionRequest::new(
                SessionId::new(external_session_id.clone()),
                working_dir.to_path_buf(),
            );
            if self.capabilities.read().await.additional_directories {
                request =
                    request.additional_directories(self.snapshot.additional_directories.clone());
            }
            request = request.mcp_servers(
                self.session_mcp_servers_with_companion(
                    working_dir,
                    session_id,
                    companion_capabilities,
                )
                .await,
            );
            *self.pending_session_id.lock().await = Some(session_id);
            let load_result = conn.send_request(request).block_task().await;
            *self.pending_session_id.lock().await = None;
            match load_result {
                Ok(response) => {
                    self.session_map
                        .write()
                        .await
                        .insert(session_id, external_session_id.clone());
                    self.emit_session_linked(session_id, external_session_id.clone())
                        .await;
                    let (modes, config_options, vendor_config) =
                        session_controls_with_vendor_fallback(
                            response.modes,
                            response.config_options,
                            response.meta.as_ref(),
                        );
                    self.emit_session_controls(session_id, modes, config_options, vendor_config)
                        .await;
                    return Ok(external_session_id);
                }
                Err(error) => {
                    let reason = classify_session_load_error(&error);
                    self.emit_session_load_failed(session_id, reason.clone());
                    return Err(map_session_restore_error(error));
                }
            }
        }

        if support.resume {
            let mut request = ResumeSessionRequest::new(
                SessionId::new(external_session_id.clone()),
                working_dir.to_path_buf(),
            );
            if self.capabilities.read().await.additional_directories {
                request =
                    request.additional_directories(self.snapshot.additional_directories.clone());
            }
            request = request.mcp_servers(
                self.session_mcp_servers_with_companion(
                    working_dir,
                    session_id,
                    companion_capabilities,
                )
                .await,
            );
            *self.pending_session_id.lock().await = Some(session_id);
            let resume_result = conn.send_request(request).block_task().await;
            *self.pending_session_id.lock().await = None;
            match resume_result {
                Ok(response) => {
                    self.session_map
                        .write()
                        .await
                        .insert(session_id, external_session_id.clone());
                    self.emit_session_linked(session_id, external_session_id.clone())
                        .await;
                    let (modes, config_options, vendor_config) =
                        session_controls_with_vendor_fallback(
                            response.modes,
                            response.config_options,
                            response.meta.as_ref(),
                        );
                    self.emit_session_controls(session_id, modes, config_options, vendor_config)
                        .await;
                    return Ok(external_session_id);
                }
                Err(error) => {
                    let reason = classify_session_load_error(&error);
                    self.emit_session_load_failed(session_id, reason.clone());
                    return Err(map_session_restore_error(error));
                }
            }
        }

        self.emit_session_load_failed(session_id, SessionLoadFailureReason::Unsupported);
        Err(AgentError::SessionLoadFailed(
            SessionLoadFailureReason::Unsupported,
        ))
    }

    /// Fork the live ACP session for `session_id`, returning the new (forked)
    /// external session id the agent created (branched from the original's
    /// context). Requires the agent to have advertised `session/fork`.
    async fn fork_acp_session(
        &self,
        conn: &ConnectionTo<Agent>,
        working_dir: &Path,
        session_id: AgentSessionId,
        companion_capabilities: CompanionCapabilities,
    ) -> Result<String, acp::Error> {
        let acp_session_id = self
            .ensure_acp_session(conn, working_dir, session_id, companion_capabilities)
            .await?;
        let response = conn
            .send_request(ForkSessionRequest::new(
                SessionId::new(acp_session_id),
                working_dir.to_path_buf(),
            ))
            .block_task()
            .await?;
        Ok(response.session_id.0.to_string())
    }

    async fn new_acp_session(
        &self,
        conn: &ConnectionTo<Agent>,
        working_dir: &Path,
        session_id: AgentSessionId,
        companion_capabilities: CompanionCapabilities,
    ) -> Result<String, acp::Error> {
        let mut request = NewSessionRequest::new(working_dir.to_path_buf());
        if self.capabilities.read().await.additional_directories {
            request = request.additional_directories(self.snapshot.additional_directories.clone());
        }
        request.mcp_servers = self
            .session_mcp_servers_with_companion(working_dir, session_id, companion_capabilities)
            .await;
        *self.pending_session_id.lock().await = Some(session_id);
        let response = conn.send_request(request).block_task().await;
        *self.pending_session_id.lock().await = None;
        let response = response?;
        let acp_session_id = response.session_id.0.to_string();
        self.session_map
            .write()
            .await
            .insert(session_id, acp_session_id.clone());
        self.emit_session_linked(session_id, acp_session_id.clone())
            .await;
        let (modes, config_options, vendor_config) = session_controls_with_vendor_fallback(
            response.modes,
            response.config_options,
            response.meta.as_ref(),
        );
        self.emit_session_controls(session_id, modes, config_options, vendor_config)
            .await;
        Ok(acp_session_id)
    }

    async fn emit_session_linked(&self, session_id: AgentSessionId, acp_session_id: String) {
        self.emit(
            Some(session_id),
            None,
            AgentEvent::SessionLinked {
                acp_session_id,
                agent_id: self.snapshot.agent_id.clone(),
                capabilities: self.capabilities.read().await.clone(),
            },
        );
    }

    async fn session_mcp_servers_with_companion(
        &self,
        working_dir: &Path,
        session_id: AgentSessionId,
        companion_capabilities: CompanionCapabilities,
    ) -> Vec<acp::schema::v1::McpServer> {
        let mut servers = self.session_mcp_servers().await;
        // Restored sessions need the same companion as newly created sessions.
        if companion_capabilities.accepts_session_mcp_servers
            && let Some(injector) = &self.delegation_injector
        {
            match injector.injected_stdio_servers(CompanionInjectionContext {
                parent_connection_id: &self.snapshot.connection_id.0.to_string(),
                parent_conversation_id: session_id.0,
                agent_id: &self.snapshot.agent_id,
                working_root: working_dir,
                capabilities: companion_capabilities,
            }) {
                CompanionInjectionList::Injected(injected) => {
                    for server in injected {
                        servers.push(acp::schema::v1::McpServer::Stdio(
                            acp::schema::v1::McpServerStdio::new(server.name, server.command)
                                .args(server.args),
                        ));
                    }
                }
                CompanionInjectionList::Unsupported { code } => {
                    tracing::debug!(
                        code,
                        session_id = %session_id.0,
                        "companion MCP not injected; session continues without it"
                    );
                }
            }
        }
        servers
    }

    async fn session_mcp_servers(&self) -> Vec<acp::schema::v1::McpServer> {
        let offer = wire_mcp_offer(&*self.capabilities.read().await);
        let mut servers = Vec::new();
        if let Some(injector) = &self.delegation_injector {
            for server in injector.remote_servers() {
                let headers = server
                    .headers
                    .into_iter()
                    .map(|(name, value)| acp::schema::v1::HttpHeader::new(name, value))
                    .collect();
                match server.transport {
                    InjectedRemoteMcpTransport::Http if offer.http => {
                        servers.push(acp::schema::v1::McpServer::Http(
                            acp::schema::v1::McpServerHttp::new(server.name, server.url)
                                .headers(headers),
                        ));
                    }
                    InjectedRemoteMcpTransport::Sse if offer.sse => {
                        servers.push(acp::schema::v1::McpServer::Sse(
                            acp::schema::v1::McpServerSse::new(server.name, server.url)
                                .headers(headers),
                        ));
                    }
                    _ => {}
                }
            }
        }
        servers
    }

    /// Prefer the standard ACP `modes`/`configOptions` fields and only fall
    /// back to a vendor `_meta` extension when the agent advertised neither
    /// (Grok currently). The returned wire marker tells the apply path which
    /// non-standard method (if any) the agent expects for changes.
    async fn emit_session_controls(
        &self,
        session_id: AgentSessionId,
        modes: Option<SessionModeState>,
        config_options: Option<Vec<AcpSessionConfigOption>>,
        vendor_config: Option<VendorConfigWire>,
    ) {
        let (config_options, mode_uses_set_mode) = unify_session_config_options(
            modes,
            config_options.unwrap_or_default(),
            vendor_config.is_some(),
        );
        {
            let mut controls = self.session_controls.write().await;
            let entry = controls.entry(session_id).or_default();
            entry.config_options = config_options.clone();
            entry.mode_uses_set_mode = mode_uses_set_mode;
            if let Some(vendor_config) = vendor_config {
                entry.vendor_config = Some(vendor_config);
            }
        }

        let (derived_modes, current) = session_modes_from_config_options(&config_options);
        self.emit(
            Some(session_id),
            None,
            AgentEvent::SessionModes {
                modes: derived_modes,
                current,
            },
        );
        if !config_options.is_empty() {
            self.emit(
                Some(session_id),
                None,
                AgentEvent::SessionConfigOptions {
                    options: agent_session_config_options_from_acp(config_options),
                },
            );
        }
    }

    async fn session_controls_snapshot(
        &self,
        session_id: AgentSessionId,
    ) -> AgentSessionControlsSnapshot {
        let controls = self.session_controls.read().await;
        let Some(controls) = controls.get(&session_id) else {
            return AgentSessionControlsSnapshot {
                modes: Vec::new(),
                current_mode: None,
                config_options: Vec::new(),
                capabilities: Some(self.capabilities.read().await.clone()),
                available_commands: None,
            };
        };
        let (modes, current_mode) = session_modes_from_config_options(&controls.config_options);
        AgentSessionControlsSnapshot {
            modes,
            current_mode,
            config_options: agent_session_config_options_from_acp(controls.config_options.clone()),
            capabilities: Some(self.capabilities.read().await.clone()),
            available_commands: controls.available_commands.clone(),
        }
    }

    async fn emit_derived_session_controls(&self, session_id: AgentSessionId) {
        let snapshot = self.session_controls_snapshot(session_id).await;
        self.emit_controls_snapshot(session_id, &snapshot);
    }

    fn emit_controls_snapshot(
        &self,
        session_id: AgentSessionId,
        controls: &AgentSessionControlsSnapshot,
    ) {
        self.emit(
            Some(session_id),
            None,
            AgentEvent::SessionModes {
                modes: controls.modes.clone(),
                current: controls.current_mode.clone(),
            },
        );
        self.emit(
            Some(session_id),
            None,
            AgentEvent::SessionConfigOptions {
                options: controls.config_options.clone(),
            },
        );
        if let Some(commands) = controls.available_commands.clone() {
            self.emit(
                Some(session_id),
                None,
                AgentEvent::AvailableCommands { commands },
            );
        }
    }

    fn emit_session_load_failed(
        &self,
        session_id: AgentSessionId,
        reason: SessionLoadFailureReason,
    ) {
        self.emit(
            Some(session_id),
            None,
            AgentEvent::SessionLoadFailed { reason },
        );
    }

    async fn apply_session_overrides(
        &self,
        conn: &ConnectionTo<Agent>,
        acp_session_id: &str,
        session_id: AgentSessionId,
        mode_override: Option<String>,
        config_overrides: Vec<AgentSessionConfigOverride>,
    ) -> Result<(), acp::Error> {
        if let Some(mode) = mode_override.as_deref().and_then(non_empty_trimmed) {
            self.apply_mode_value(conn, acp_session_id, session_id, mode)
                .await?;
        }

        // ACP Agents may rebuild dependent config options after a model
        // selection. Use the advertised semantic category to apply model
        // selections first without consulting an Agent identity.
        let advertised_options = self
            .session_controls
            .read()
            .await
            .get(&session_id)
            .map(|state| state.config_options.clone())
            .unwrap_or_default();
        for override_item in ordered_session_config_overrides(&advertised_options, config_overrides)
        {
            let Some(key) = non_empty_trimmed(&override_item.key) else {
                continue;
            };
            let Some(value) = non_empty_trimmed(&override_item.value) else {
                continue;
            };
            self.apply_config_override(conn, acp_session_id, session_id, key, value)
                .await?;
        }

        Ok(())
    }

    async fn apply_mode_value(
        &self,
        conn: &ConnectionTo<Agent>,
        acp_session_id: &str,
        session_id: AgentSessionId,
        requested_mode: &str,
    ) -> Result<(), acp::Error> {
        self.apply_config_override(conn, acp_session_id, session_id, "mode", requested_mode)
            .await
    }

    async fn apply_config_override(
        &self,
        conn: &ConnectionTo<Agent>,
        acp_session_id: &str,
        session_id: AgentSessionId,
        key: &str,
        value: &str,
    ) -> Result<(), acp::Error> {
        self.apply_config_value(
            conn,
            acp_session_id,
            session_id,
            key,
            &serde_json::Value::String(value.to_string()),
        )
        .await
    }

    async fn apply_config_value(
        &self,
        conn: &ConnectionTo<Agent>,
        acp_session_id: &str,
        session_id: AgentSessionId,
        key: &str,
        value: &serde_json::Value,
    ) -> Result<(), acp::Error> {
        let (config_options, vendor_config) = {
            let controls = self.session_controls.read().await;
            let state = controls.get(&session_id);
            (
                state
                    .map(|controls| controls.config_options.clone())
                    .unwrap_or_default(),
                state.and_then(|controls| controls.vendor_config),
            )
        };
        if config_options.is_empty() {
            self.emit_override_diagnostic(session_id, "config_controls_missing", key);
            return Ok(());
        }

        let Some(selection) = find_config_override_selection(&config_options, key, value) else {
            self.emit_override_diagnostic(
                session_id,
                "config_choice_not_found",
                &format!("{key}={value}"),
            );
            return Ok(());
        };
        if selection.already_selected {
            return Ok(());
        }

        // Grok applies its vendor-advertised model option via the non-standard
        // `session/set_model` method; the standard `session/set_config_option`
        // rejects it. The model value rides `selection.event_value` so the
        // exact advertised choice id is sent.
        if vendor_config == Some(VendorConfigWire::XaiSessionConfig)
            && selection.config_id == "model"
        {
            let Some(model_id) = selection.event_value.as_str() else {
                return Ok(());
            };
            let _response = conn
                .send_request(SetSessionModelRequest::new(
                    SessionId::new(acp_session_id.to_string()),
                    model_id.to_string(),
                ))
                .block_task()
                .await?;
            self.store_vendor_config_selection(session_id, &selection)
                .await;
            self.emit(
                Some(session_id),
                None,
                AgentEvent::ConfigChanged {
                    key: selection.config_id,
                    value: selection.event_value,
                },
            );
            return Ok(());
        }
        if vendor_config == Some(VendorConfigWire::XaiSessionConfig)
            && advertised_option_is_thought_level(&config_options, &selection.config_id)
        {
            let Some(mode_id) = selection.event_value.as_str() else {
                return Ok(());
            };
            conn.send_request(SetSessionModeRequest::new(
                SessionId::new(acp_session_id.to_string()),
                mode_id.to_string(),
            ))
            .block_task()
            .await?;
            self.store_vendor_config_selection(session_id, &selection)
                .await;
            self.emit(
                Some(session_id),
                None,
                AgentEvent::ConfigChanged {
                    key: selection.config_id,
                    value: selection.event_value,
                },
            );
            return Ok(());
        }
        if self
            .session_controls
            .read()
            .await
            .get(&session_id)
            .is_some_and(|controls| {
                controls.mode_uses_set_mode
                    && advertised_option_is_mode(&config_options, &selection.config_id)
            })
        {
            let Some(mode_id) = selection.event_value.as_str() else {
                return Ok(());
            };
            conn.send_request(SetSessionModeRequest::new(
                SessionId::new(acp_session_id.to_string()),
                mode_id.to_string(),
            ))
            .block_task()
            .await?;
            self.store_vendor_config_selection(session_id, &selection)
                .await;
            self.emit_derived_session_controls(session_id).await;
            self.emit(
                Some(session_id),
                None,
                AgentEvent::ModeChanged {
                    mode_id: mode_id.to_string(),
                },
            );
            return Ok(());
        }

        let response = conn
            .send_request(SetSessionConfigOptionRequest::new(
                SessionId::new(acp_session_id.to_string()),
                selection.config_id.clone(),
                selection.wire_value.clone(),
            ))
            .block_task()
            .await?;
        let mapped_options = agent_session_config_options_from_acp(response.config_options.clone());
        {
            let mut controls = self.session_controls.write().await;
            let stored = controls.entry(session_id).or_default();
            stored.config_options = response.config_options;
        }
        self.emit(
            Some(session_id),
            None,
            AgentEvent::SessionConfigOptions {
                options: mapped_options,
            },
        );
        self.emit(
            Some(session_id),
            None,
            AgentEvent::ConfigChanged {
                key: selection.config_id,
                value: selection.event_value,
            },
        );
        Ok(())
    }

    async fn store_vendor_config_selection(
        &self,
        session_id: AgentSessionId,
        selection: &ConfigOverrideSelection,
    ) {
        let mut controls = self.session_controls.write().await;
        let Some(stored) = controls.get_mut(&session_id) else {
            return;
        };
        for option in &mut stored.config_options {
            if option.id.0.as_ref() != selection.config_id {
                continue;
            }
            if let SessionConfigKind::Select(select) = &mut option.kind {
                if let Some(value_id) = selection.event_value.as_str() {
                    select.current_value = SessionConfigValueId::new(value_id);
                }
            }
        }
    }

    /// Resolve the live ACP session and apply a mode change right now (idle
    /// path of the immediate `SetSessionMode` command).
    async fn set_live_session_mode(
        &self,
        conn: &ConnectionTo<Agent>,
        session_id: AgentSessionId,
        mode_id: &str,
    ) -> AgentResult<AgentSessionControlsSnapshot> {
        let acp_session_id = self.session_map.read().await.get(&session_id).cloned();
        let Some(acp_session_id) = acp_session_id else {
            return Err(AgentError::Runtime(
                "no live ACP session yet; the mode will apply when the next turn starts".into(),
            ));
        };
        self.apply_mode_value(conn, &acp_session_id, session_id, mode_id)
            .await
            .map_err(|error| AgentError::Runtime(format!("session/set_mode failed: {error}")))?;
        Ok(self.session_controls_snapshot(session_id).await)
    }

    /// Resolve the live ACP session and apply a config-option change right now
    /// (idle path of the immediate `SetSessionConfigOption` command).
    async fn set_live_session_config_option(
        &self,
        conn: &ConnectionTo<Agent>,
        session_id: AgentSessionId,
        key: &str,
        value: &serde_json::Value,
    ) -> AgentResult<AgentSessionControlsSnapshot> {
        let acp_session_id = self.session_map.read().await.get(&session_id).cloned();
        let Some(acp_session_id) = acp_session_id else {
            return Err(AgentError::Runtime(
                "no live ACP session yet; the setting will apply when the next turn starts".into(),
            ));
        };
        self.apply_config_value(conn, &acp_session_id, session_id, key, value)
            .await
            .map_err(|error| {
                AgentError::Runtime(format!("session/set_config_option failed: {error}"))
            })?;
        Ok(self.session_controls_snapshot(session_id).await)
    }

    fn emit_override_diagnostic(
        &self,
        session_id: AgentSessionId,
        reason: &'static str,
        requested: &str,
    ) {
        self.emit(
            Some(session_id),
            None,
            AgentEvent::RawAcpDiagnostic {
                raw: serde_json::json!({
                    "kind": "session_config_override_skipped",
                    "reason": reason,
                    "requested": requested,
                }),
            },
        );
    }

    // Cohesive prompt-execution context (connection + session/prompt ids + blocks +
    // overrides + command channel); bundling into a struct adds indirection without
    // value, matching how the rest of the codebase handles this lint.
    #[allow(clippy::too_many_arguments)]
    async fn run_prompt(
        &self,
        conn: &ConnectionTo<Agent>,
        request: RunPromptRequest,
        cmd_rx: &mut mpsc::Receiver<AgentConnectionCommand>,
    ) -> Result<(), acp::Error> {
        let RunPromptRequest {
            acp_session_id,
            session_id,
            prompt_id,
            blocks,
            mode_override,
            config_overrides,
        } = request;
        // Mark this prompt in flight and reset the idle clock. The cursor lets the
        // connection-death fallback in `run()` fail this exact turn; it is cleared
        // before every self-terminal `return` below so a terminal event is emitted
        // exactly once (never doubled, never dropped). A `?`-propagated error
        // (e.g. apply_session_overrides) deliberately leaves it set so `run()`
        // closes the turn.
        *self.active_prompt.lock().await = Some((session_id, prompt_id));
        *self.last_activity.lock().await = Instant::now();
        let idle_timeout = prompt_idle_timeout();

        // Start each turn with a clean streaming accumulator so snapshot dedup
        // scopes to this turn and never accretes text across turns.
        self.stream_dedup.lock().await.remove(&acp_session_id);
        self.apply_session_overrides(
            conn,
            &acp_session_id,
            session_id,
            mode_override,
            config_overrides,
        )
        .await?;
        let request = PromptRequest::new(
            SessionId::new(acp_session_id.clone()),
            blocks.into_iter().map(agent_block_to_acp).collect(),
        );
        let prompt_future = conn.send_request(request).block_task();
        tokio::pin!(prompt_future);

        loop {
            tokio::select! {
                result = &mut prompt_future => {
                    // A turn that ends (normally or with an error) must release any
                    // permission still pending in the in-memory map; otherwise its
                    // oneshot sender leaks and the runtime/DB state diverge. The
                    // cancel/disconnect arms below already do this.
                    self.cancel_pending_interactions(session_id).await;
                    match result {
                        Ok(response) => {
                            self.emit(
                                Some(session_id),
                                Some(prompt_id),
                                AgentEvent::PromptFinished {
                                    finished: AgentPromptFinished {
                                        prompt_id,
                                        stop_reason: Some(format!("{:?}", response.stop_reason)),
                                    },
                                },
                            );
                        }
                        Err(error) => {
                            self.emit(
                                Some(session_id),
                                Some(prompt_id),
                                AgentEvent::Error {
                                    error: AgentErrorEvent {
                                        message: error.to_string(),
                                        code: acp_error_code_str(&error),
                                        raw: error.data.clone(),
                                    },
                                },
                            );
                        }
                    }
                    *self.active_prompt.lock().await = None;
                    return Ok(());
                }
                // Idle watchdog: fail a silently-hung agent (e.g. Codex stuck
                // retrying an unreachable model) instead of spinning "生成中"
                // forever. Polls cheaply; the real measure is `last_activity`,
                // refreshed by every session notification, so a legitimately
                // streaming long turn is never killed. Skipped while a permission
                // decision or an elicitation answer is pending (those waits
                // produce no activity).
                _ = tokio::time::sleep(Duration::from_secs(2)) => {
                    if self.has_pending_permission_for(session_id).await
                        || self.has_pending_elicitation_for(session_id).await
                    {
                        continue;
                    }
                    if self.last_activity.lock().await.elapsed() < idle_timeout {
                        continue;
                    }
                    self.cancel_pending_interactions(session_id).await;
                    let _ = conn.send_notification(CancelNotification::new(SessionId::new(
                        acp_session_id.clone(),
                    )));
                    self.emit(
                        Some(session_id),
                        Some(prompt_id),
                        AgentEvent::Error {
                            error: AgentErrorEvent {
                                message: "Agent stopped responding (idle timeout). The model may be unreachable — check your network/proxy or re-authenticate the agent.".to_string(),
                                code: Some("idle_timeout".to_string()),
                                raw: None,
                            },
                        },
                    );
                    *self.active_prompt.lock().await = None;
                    return Ok(());
                }
                command = cmd_rx.recv() => {
                    match command {
                        Some(AgentConnectionCommand::Cancel { session_id: cancel_session, prompt_id: cancel_prompt })
                            if cancel_session == session_id && cancel_prompt == prompt_id =>
                        {
                            self.cancel_pending_interactions(session_id).await;
                            conn.send_notification(CancelNotification::new(SessionId::new(acp_session_id.clone())))?;
                            self.emit(
                                Some(session_id),
                                Some(prompt_id),
                                AgentEvent::PromptFinished {
                                    finished: AgentPromptFinished {
                                        prompt_id,
                                        stop_reason: Some("cancelled".to_string()),
                                    },
                                },
                            );
                            *self.active_prompt.lock().await = None;
                            return Ok(());
                        }
                        Some(AgentConnectionCommand::Steer {
                            session_id: steer_session,
                            expected_prompt_id,
                            blocks,
                            result_tx,
                        }) => {
                            if steer_session != session_id || expected_prompt_id != prompt_id {
                                let _ = result_tx.send(Err(AgentError::PromptConflict {
                                    expected: expected_prompt_id.to_string(),
                                    active: prompt_id.to_string(),
                                }));
                                continue;
                            }
                            if !self.capabilities.read().await.steering {
                                let _ = result_tx.send(Err(AgentError::SteeringUnsupported));
                                continue;
                            }
                            let request = AcpSteerRequest {
                                session_id: acp_session_id.clone(),
                                prompt: blocks.into_iter().map(agent_block_to_acp).collect(),
                                meta: serde_json::json!({
                                    "steering": { "idleBehavior": "promptRequired" }
                                }),
                            };
                            let result = conn
                                .send_request(request)
                                .block_task()
                                .await
                                .map_err(|error| AgentError::Runtime(format!(
                                    "ACP steering failed: {error}"
                                )))
                                .and_then(map_steer_response);
                            if result.as_ref().is_ok_and(|receipt| {
                                receipt.outcome == AgentSteerOutcome::Injected
                            }) {
                                *self.last_activity.lock().await = Instant::now();
                            }
                            let _ = result_tx.send(result);
                        }
                        Some(AgentConnectionCommand::Disconnect) | None => {
                            // The connection is going away mid-turn. Fail the turn
                            // so it doesn't hang at "生成中"; clear the cursor so
                            // run()'s fallback doesn't double-emit.
                            self.cancel_pending_interactions(session_id).await;
                            let _ = conn.send_notification(CancelNotification::new(SessionId::new(
                                acp_session_id.clone(),
                            )));
                            self.emit(
                                Some(session_id),
                                Some(prompt_id),
                                AgentEvent::Error {
                                    error: AgentErrorEvent {
                                        message: "Agent connection closed before the turn completed.".to_string(),
                                        code: Some("connection_closed".to_string()),
                                        raw: None,
                                    },
                                },
                            );
                            *self.active_prompt.lock().await = None;
                            return Ok(());
                        }
                        Some(AgentConnectionCommand::RespondPermission { permission_id, response }) => {
                            // The user acted — treat as activity so the watchdog
                            // doesn't fire on the freshly-resumed turn.
                            *self.last_activity.lock().await = Instant::now();
                            self.respond_pending_permission(&permission_id, response).await;
                        }
                        Some(AgentConnectionCommand::RespondElicitation { elicitation_id, response }) => {
                            *self.last_activity.lock().await = Instant::now();
                            self.respond_pending_elicitation(&elicitation_id, response).await;
                        }
                        Some(AgentConnectionCommand::ForkSession { result_tx, .. }) => {
                            // A fork can't be taken mid-turn: the session state is
                            // actively mutating, so we'd branch a partial context.
                            // Answer the waiting caller with an accurate error instead
                            // of dropping result_tx (a dropped sender surfaces as the
                            // misleading "connection closed before session fork").
                            let _ = result_tx.send(Err(AgentError::Runtime(
                                "cannot fork the session while a turn is in progress; wait for it to finish"
                                    .into(),
                            )));
                        }
                        Some(AgentConnectionCommand::ListSessions { result_tx, .. }) => {
                            let _ = result_tx.send(Err(AgentError::Runtime(
                                "cannot list sessions while a turn is in progress".into(),
                            )));
                        }
                        Some(AgentConnectionCommand::DeleteSession { result_tx, .. }) => {
                            let _ = result_tx.send(Err(AgentError::Runtime(
                                "cannot delete a session while a turn is in progress".into(),
                            )));
                        }
                        Some(AgentConnectionCommand::SetSessionMode { result_tx, .. })
                        | Some(AgentConnectionCommand::SetSessionConfigOption { result_tx, .. }) => {
                            // Applying these mid-turn would block this loop on a
                            // request the agent may not answer until the turn ends.
                            // Reject; the caller keeps the choice as a next-turn
                            // override instead.
                            let _ = result_tx.send(Err(AgentError::Runtime(
                                "cannot change session settings while a turn is in progress; the choice will apply on the next turn"
                                    .into(),
                            )));
                        }
                        Some(other) => {
                            self.emit(
                                Some(session_id),
                                Some(prompt_id),
                                AgentEvent::RawAcpDiagnostic {
                                    raw: serde_json::json!({
                                        "kind": "ignored_command_during_active_prompt",
                                        "command": format!("{other:?}"),
                                    }),
                                },
                            );
                        }
                    }
                }
            }
        }
    }

    async fn respond_pending_permission(
        &self,
        permission_id: &str,
        response: AgentPermissionResponse,
    ) {
        let pending = self.pending_permissions.lock().await.remove(permission_id);
        if let Some(pending) = pending {
            let _ = pending.tx.send(response.clone());
            self.emit(
                Some(pending.session_id),
                None,
                AgentEvent::PermissionResponded {
                    permission_id: pending.permission_id,
                    response,
                    auto: false,
                },
            );
        } else {
            self.emit(
                None,
                None,
                AgentEvent::RawAcpDiagnostic {
                    raw: serde_json::json!({
                        "kind": "unknown_permission_response",
                        "permission_id": permission_id,
                    }),
                },
            );
        }
    }

    /// Is the agent currently blocked waiting on a permission decision for this
    /// session? Such a wait produces no ACP activity, so the idle watchdog must
    /// not mistake it for a hang.
    async fn has_pending_permission_for(&self, session_id: AgentSessionId) -> bool {
        self.pending_permissions
            .lock()
            .await
            .values()
            .any(|pending| pending.session_id == session_id)
    }

    async fn cancel_pending_interactions(&self, session_id: AgentSessionId) {
        let pending = {
            let mut pending_permissions = self.pending_permissions.lock().await;
            let permission_ids = pending_permissions
                .iter()
                .filter(|(_, pending)| pending.session_id == session_id)
                .map(|(permission_id, _)| permission_id.clone())
                .collect::<Vec<_>>();

            permission_ids
                .into_iter()
                .filter_map(|permission_id| pending_permissions.remove(&permission_id))
                .collect::<Vec<_>>()
        };

        for pending in pending {
            let response = AgentPermissionResponse::Cancelled;
            let _ = pending.tx.send(response.clone());
            self.emit(
                Some(pending.session_id),
                None,
                AgentEvent::PermissionResponded {
                    permission_id: pending.permission_id,
                    response,
                    auto: false,
                },
            );
        }
        self.cancel_pending_elicitations(session_id).await;
    }

    async fn respond_pending_elicitation(
        &self,
        elicitation_id: &str,
        response: AgentElicitationResponse,
    ) {
        let pending = self
            .pending_elicitations
            .lock()
            .await
            .remove(elicitation_id);
        if let Some(pending) = pending {
            let _ = pending.tx.send(response.clone());
            self.emit(
                Some(pending.session_id),
                None,
                AgentEvent::ElicitationResponded {
                    elicitation_id: pending.elicitation_id,
                    response,
                },
            );
        } else {
            self.emit(
                None,
                None,
                AgentEvent::RawAcpDiagnostic {
                    raw: serde_json::json!({
                        "kind": "unknown_elicitation_response",
                        "elicitation_id": elicitation_id,
                    }),
                },
            );
        }
    }

    /// Is the agent blocked waiting on a user answer to an elicitation for this
    /// session? Like a permission wait, this produces no ACP activity, so the
    /// idle watchdog must not mistake it for a hang.
    async fn has_pending_elicitation_for(&self, session_id: AgentSessionId) -> bool {
        self.pending_elicitations
            .lock()
            .await
            .values()
            .any(|pending| pending.session_id == session_id)
    }

    async fn cancel_pending_elicitations(&self, session_id: AgentSessionId) {
        let pending = {
            let mut pending_elicitations = self.pending_elicitations.lock().await;
            let elicitation_ids = pending_elicitations
                .iter()
                .filter(|(_, pending)| pending.session_id == session_id)
                .map(|(elicitation_id, _)| elicitation_id.clone())
                .collect::<Vec<_>>();

            elicitation_ids
                .into_iter()
                .filter_map(|elicitation_id| pending_elicitations.remove(&elicitation_id))
                .collect::<Vec<_>>()
        };

        for pending in pending {
            let response = AgentElicitationResponse::Cancel;
            let _ = pending.tx.send(response.clone());
            self.emit(
                Some(pending.session_id),
                None,
                AgentEvent::ElicitationResponded {
                    elicitation_id: pending.elicitation_id,
                    response,
                },
            );
        }
    }

    fn emit(
        &self,
        session_id: Option<AgentSessionId>,
        prompt_id: Option<AgentPromptId>,
        event: AgentEvent,
    ) {
        let _ = self.event_tx.send(AgentConnectionManagerEvent {
            connection_id: self.snapshot.connection_id,
            session_id,
            prompt_id,
            event,
        });
    }

    fn emit_connection_status(
        &self,
        status: AgentConnectionStatus,
        status_message: Option<String>,
    ) {
        let now = Utc::now();
        self.emit(
            None,
            None,
            AgentEvent::ConnectionStatusChanged {
                snapshot: AgentConnectionSnapshot {
                    id: self.snapshot.connection_id,
                    agent_id: self.snapshot.agent_id.clone(),
                    workspace_id: self.snapshot.workspace_id,
                    status,
                    working_dir: self.snapshot.working_dir.display().to_string(),
                    status_message,
                    created_at: now,
                    updated_at: now,
                },
            },
        );
    }
}

fn seed_pi_workspace_trust(
    working_dir: &Path,
    env: &HashMap<String, String>,
) -> Result<(), String> {
    if env
        .get(PI_TRUST_WORKSPACE_ENV)
        .is_some_and(|value| value.trim() == "0")
    {
        return Ok(());
    }

    let canonical_workspace = std::fs::canonicalize(working_dir)
        .map_err(|error| format!("could not resolve workspace path: {error}"))?;
    let home = dirs::home_dir().ok_or_else(|| "home directory is unavailable".to_string())?;
    let agent_dir = env
        .get(PI_CONFIG_DIR_ENV)
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| expand_pi_home(value, &home))
        .unwrap_or_else(|| home.join(".pi/agent"));
    let trust_path = agent_dir.join("trust.json");
    let mut trust = match std::fs::read(&trust_path) {
        Ok(bytes) => serde_json::from_slice::<serde_json::Value>(&bytes)
            .map_err(|error| format!("existing trust.json is invalid: {error}"))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            serde_json::Value::Object(serde_json::Map::new())
        }
        Err(error) => return Err(format!("could not read trust.json: {error}")),
    };
    let trust = trust
        .as_object_mut()
        .ok_or_else(|| "existing trust.json is not an object".to_string())?;
    let workspace_key = canonical_workspace.to_string_lossy().into_owned();
    if trust.contains_key(&workspace_key) {
        return Ok(());
    }
    trust.insert(workspace_key, serde_json::Value::Bool(true));

    std::fs::create_dir_all(&agent_dir)
        .map_err(|error| format!("could not create Pi config directory: {error}"))?;
    let bytes = serde_json::to_vec_pretty(&serde_json::Value::Object(trust.clone()))
        .map_err(|error| format!("could not serialize trust.json: {error}"))?;
    let temporary_path = agent_dir.join(format!(".trust.json.vibex-{}", uuid::Uuid::new_v4()));
    std::fs::write(&temporary_path, bytes)
        .map_err(|error| format!("could not write temporary trust.json: {error}"))?;
    if let Err(error) = replace_pi_trust_file(&temporary_path, &trust_path) {
        let _ = std::fs::remove_file(&temporary_path);
        return Err(format!("could not replace trust.json: {error}"));
    }
    Ok(())
}

fn expand_pi_home(path: &str, home: &Path) -> PathBuf {
    if path == "~" {
        home.to_path_buf()
    } else if let Some(relative) = path.strip_prefix("~/") {
        home.join(relative)
    } else {
        PathBuf::from(path)
    }
}

#[cfg(not(windows))]
fn replace_pi_trust_file(temporary: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::rename(temporary, destination)
}

#[cfg(windows)]
fn replace_pi_trust_file(temporary: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let temporary = temporary
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    if unsafe {
        MoveFileExW(
            temporary.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// Which streaming text channel a chunk belongs to. Tracked so a thought→message
/// transition (or vice versa) restarts the snapshot accumulator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StreamKind {
    Message,
    Thought,
}

/// Per-session accumulator for the current contiguous streaming text run, used to
/// drop redundant full-message snapshots (see [`dedup_stream_text`]).
#[derive(Debug, Default)]
struct StreamDedupState {
    active: Option<StreamKind>,
    text: String,
    chunks: usize,
}

/// Normalize a streaming text chunk: returns `true` to emit it, `false` to drop it
/// as a redundant full-snapshot replay.
///
/// `codex-acp` streams a message/thought as
/// `agentMessageChunk` / `agentThoughtChunk` deltas AND then replays the *complete*
/// text as one final chunk — the live-stream analogue of the `event_msg` +
/// `response_item` duplication documented in [`crate::parsers::codex`]. ACP does
/// not tag these chunks with a `message_id`, so the only available signal is
/// content: a chunk whose text equals everything accumulated for the current run
/// is that trailing snapshot. Dropping it stops the answer from rendering (and
/// persisting) twice in one bubble. Agents that never replay (Claude, Gemini, …)
/// only ever append, so this is a no-op for them.
fn dedup_stream_text(state: &mut StreamDedupState, kind: StreamKind, text: &str) -> bool {
    if state.active != Some(kind) {
        state.active = Some(kind);
        state.text.clear();
        state.chunks = 0;
    }
    if state.chunks >= 2 && state.text == text {
        // Trailing full snapshot: the run is complete, so reset — the next chunk
        // of the same kind starts a new message instead of appending to this one.
        state.active = None;
        return false;
    }
    state.text.push_str(text);
    state.chunks += 1;
    true
}

#[derive(Clone)]
struct AcpClientBridge {
    connection_id: AgentConnectionId,
    agent_id: crate::AgentId,
    event_tx: mpsc::UnboundedSender<AgentConnectionManagerEvent>,
    session_map: Arc<RwLock<HashMap<AgentSessionId, String>>>,
    // Shared with the owning runner: session-notification pushes (mode / config
    // updates) must keep the stored controls authoritative for later
    // set_mode/set_config_option matching.
    session_controls: Arc<RwLock<HashMap<AgentSessionId, SessionControlState>>>,
    pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
    pending_elicitations: Arc<Mutex<HashMap<String, PendingElicitation>>>,
    auto_approve_mode: AgentAutoApproveMode,
    // Shared with the owning `AgentConnectionRunner` so a turn boundary can reset
    // it; keyed by ACP session id.
    stream_dedup: Arc<Mutex<HashMap<String, StreamDedupState>>>,
    // Shared idle-watchdog clock: every session notification refreshes it so the
    // prompt watchdog only fires on a genuinely silent (hung) agent.
    last_activity: Arc<Mutex<Instant>>,
    grok_subagent: Arc<Mutex<GrokSubagentTracker>>,
    pending_session_id: Arc<Mutex<Option<AgentSessionId>>>,
}

impl AcpClientBridge {
    #[allow(clippy::too_many_arguments)]
    fn new(
        connection_id: AgentConnectionId,
        agent_id: crate::AgentId,
        event_tx: mpsc::UnboundedSender<AgentConnectionManagerEvent>,
        session_map: Arc<RwLock<HashMap<AgentSessionId, String>>>,
        session_controls: Arc<RwLock<HashMap<AgentSessionId, SessionControlState>>>,
        pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
        pending_elicitations: Arc<Mutex<HashMap<String, PendingElicitation>>>,
        auto_approve_mode: AgentAutoApproveMode,
        stream_dedup: Arc<Mutex<HashMap<String, StreamDedupState>>>,
        last_activity: Arc<Mutex<Instant>>,
        grok_subagent: Arc<Mutex<GrokSubagentTracker>>,
        pending_session_id: Arc<Mutex<Option<AgentSessionId>>>,
    ) -> Self {
        Self {
            connection_id,
            agent_id,
            event_tx,
            session_map,
            session_controls,
            pending_permissions,
            pending_elicitations,
            auto_approve_mode,
            stream_dedup,
            last_activity,
            grok_subagent,
            pending_session_id,
        }
    }

    /// Pass a streaming text chunk through snapshot de-duplication, returning the
    /// content to emit (or `None` to drop a redundant full-message replay).
    async fn gate_stream_chunk(
        &self,
        acp_session_id: &str,
        kind: StreamKind,
        content: AgentContentBlock,
    ) -> Option<AgentContentBlock> {
        // Only text chunks carry a comparable snapshot; pass images/resources
        // through untouched.
        let AgentContentBlock::Text { text } = &content else {
            return Some(content);
        };
        if text.is_empty() {
            return Some(content);
        }
        let mut map = self.stream_dedup.lock().await;
        let state = map.entry(acp_session_id.to_string()).or_default();
        if dedup_stream_text(state, kind, text) {
            Some(content)
        } else {
            None
        }
    }

    async fn handle_agent_request(
        &self,
        request: AgentRequest,
    ) -> Result<ClientResponse, acp::Error> {
        match request {
            AgentRequest::RequestPermissionRequest(args) => Ok(
                ClientResponse::RequestPermissionResponse(self.request_permission(args).await?),
            ),
            AgentRequest::CreateElicitationRequest(args) => Ok(
                ClientResponse::CreateElicitationResponse(self.create_elicitation(args).await?),
            ),
            AgentRequest::CreateTerminalRequest(args) => Ok(
                ClientResponse::CreateTerminalResponse(self.create_terminal(args).await?),
            ),
            AgentRequest::TerminalOutputRequest(args) => {
                let terminal_id = parse_terminal_id(&args.terminal_id)?;
                let snapshot = agent_terminal_registry()
                    .snapshot_output(terminal_id.into())
                    .await
                    .ok_or_else(acp::Error::invalid_params)?;
                let mut response = TerminalOutputResponse::new(snapshot.output, snapshot.truncated);
                if let Some(AgentTerminalExit::Code { code }) = snapshot.exit {
                    let exit_status = agent_client_protocol::schema::v1::TerminalExitStatus::new()
                        .exit_code(code as u32);
                    response = response.exit_status(exit_status);
                }
                Ok(ClientResponse::TerminalOutputResponse(response))
            }
            AgentRequest::ReleaseTerminalRequest(args) => {
                let terminal_id = parse_terminal_id(&args.terminal_id)?;
                if !agent_terminal_registry()
                    .release_terminal(terminal_id.into())
                    .await
                {
                    return Err(acp::Error::invalid_params());
                }
                Ok(ClientResponse::ReleaseTerminalResponse(
                    ReleaseTerminalResponse::new(),
                ))
            }
            AgentRequest::WaitForTerminalExitRequest(args) => {
                let terminal_id = parse_terminal_id(&args.terminal_id)?;
                let exit = agent_terminal_registry()
                    .wait_for_exit(terminal_id.into())
                    .await
                    .ok_or_else(acp::Error::invalid_params)?;
                let mut exit_status = agent_client_protocol::schema::v1::TerminalExitStatus::new();
                if let AgentTerminalExit::Code { code } = exit {
                    exit_status = exit_status.exit_code(code as u32);
                }
                Ok(ClientResponse::WaitForTerminalExitResponse(
                    WaitForTerminalExitResponse::new(exit_status),
                ))
            }
            AgentRequest::KillTerminalRequest(args) => Ok(ClientResponse::KillTerminalResponse(
                self.kill_terminal(args).await?,
            )),
            AgentRequest::ExtMethodRequest(ext) => self.handle_ext_method(ext).await,
            AgentRequest::ReadTextFileRequest(_) | AgentRequest::WriteTextFileRequest(_) => {
                Err(acp::Error::method_not_found())
            }
            _ => Err(acp::Error::method_not_found()),
        }
    }

    async fn handle_agent_notification(
        &self,
        notification: AgentNotification,
    ) -> Result<(), acp::Error> {
        match notification {
            AgentNotification::SessionNotification(args) => self.session_notification(args).await,
            AgentNotification::ExtNotification(ext) => self.handle_ext_notification(ext).await,
            _ => Ok(()),
        }
    }

    async fn request_permission(
        &self,
        args: RequestPermissionRequest,
    ) -> Result<RequestPermissionResponse, acp::Error> {
        let permission_id = AgentPermissionId::new();
        let acp_session = args.session_id.0.to_string();
        let Some(session_id) = self.agent_session_for_acp(acp_session.clone()).await else {
            tracing::warn!(
                acp_session = %acp_session,
                "request_permission for unknown ACP session — rejecting instead of \
                 routing to a phantom session the UI can never answer"
            );
            return Err(acp::Error::invalid_params());
        };
        let request = AgentPermissionRequest {
            id: permission_id,
            session_id,
            title: args
                .tool_call
                .fields
                .title
                .clone()
                .unwrap_or_else(|| "Permission requested".to_string()),
            details: serde_json::to_value(&args.tool_call).ok(),
            options: args
                .options
                .iter()
                .map(|option| AgentPermissionOption {
                    id: option.option_id.to_string(),
                    label: option.name.clone(),
                    kind: agent_permission_option_kind(option.kind),
                    description: None,
                })
                .collect(),
        };

        let _ = self.event_tx.send(AgentConnectionManagerEvent {
            connection_id: self.connection_id,
            session_id: Some(session_id),
            prompt_id: None,
            event: AgentEvent::PermissionRequested {
                request: request.clone(),
            },
        });

        let auto_approve_mode =
            effective_auto_approve_mode(self.auto_approve_mode, &self.session_controls, session_id)
                .await;
        if let Some(response) = decide_auto_permission_response(auto_approve_mode, &request) {
            let _ = self.event_tx.send(AgentConnectionManagerEvent {
                connection_id: self.connection_id,
                session_id: Some(session_id),
                prompt_id: None,
                event: AgentEvent::PermissionResponded {
                    permission_id,
                    response: response.clone(),
                    auto: true,
                },
            });
            return Ok(RequestPermissionResponse::new(permission_response_outcome(
                response,
            )));
        }

        let (tx, rx) = oneshot::channel();
        self.pending_permissions.lock().await.insert(
            permission_id.to_string(),
            PendingPermission {
                permission_id,
                session_id,
                tx,
            },
        );

        let response = rx.await.unwrap_or(AgentPermissionResponse::Cancelled);
        Ok(RequestPermissionResponse::new(permission_response_outcome(
            response,
        )))
    }

    /// Handle ACP `elicitation/create` (unstable): the agent asks the user for
    /// structured input — Claude Code's `AskUserQuestion` and MCP elicitations
    /// arrive here. Blocks the ACP request until the user answers; the pending
    /// entry is cancelled by the same paths that cancel pending permissions.
    async fn create_elicitation(
        &self,
        args: CreateElicitationRequest,
    ) -> Result<CreateElicitationResponse, acp::Error> {
        let ElicitationMode::Form(form) = args.mode else {
            // Only form mode is advertised; decline anything else instead of
            // erroring so a nonconforming agent degrades gracefully.
            return Ok(CreateElicitationResponse::new(ElicitationAction::Decline));
        };
        let ElicitationScope::Session(session_scope) = &form.scope else {
            // Request-scoped elicitations (pre-session auth/config) have no
            // conversation to surface in yet.
            tracing::warn!("declining request-scoped elicitation — no session to route it to");
            return Ok(CreateElicitationResponse::new(ElicitationAction::Decline));
        };
        let acp_session = session_scope.session_id.0.to_string();
        let Some(session_id) = self.agent_session_for_acp(acp_session.clone()).await else {
            tracing::warn!(
                acp_session = %acp_session,
                "elicitation/create for unknown ACP session — rejecting instead of \
                 routing to a phantom session the UI can never answer"
            );
            return Err(acp::Error::invalid_params());
        };

        let requested_schema = serde_json::to_value(&form.requested_schema)
            .map_err(acp::Error::into_internal_error)?;
        let response = self
            .wait_for_question(session_id, args.message, requested_schema)
            .await;
        Ok(CreateElicitationResponse::new(elicitation_response_action(
            response,
        )))
    }

    async fn handle_ext_method(&self, ext: ExtRequest) -> Result<ClientResponse, acp::Error> {
        let Some(parsed) = crate::ext_question::parse(ext.method.as_ref(), ext.params.get()) else {
            return Err(acp::Error::method_not_found());
        };
        let question = parsed.map_err(|error| {
            tracing::warn!(
                method = %ext.method,
                error = %error,
                "invalid vendor question ext-method params"
            );
            acp::Error::invalid_params()
        })?;
        let sessions = self.session_map.read().await;
        let Some(session_id) =
            crate::ext_question::resolve_session_id(question.session_id.as_deref(), &sessions)
        else {
            tracing::warn!(
                method = %ext.method,
                acp_session = ?question.session_id,
                "vendor question ext-method for unknown ACP session"
            );
            return Err(acp::Error::invalid_params());
        };
        drop(sessions);
        let response = self
            .wait_for_question(session_id, question.prompt.clone(), question.schema.clone())
            .await;
        let payload = question.into_response(response);
        let raw =
            serde_json::value::to_raw_value(&payload).map_err(acp::Error::into_internal_error)?;
        Ok(ClientResponse::ExtMethodResponse(ExtResponse::new(
            raw.into(),
        )))
    }

    async fn wait_for_question(
        &self,
        session_id: AgentSessionId,
        message: String,
        requested_schema: serde_json::Value,
    ) -> AgentElicitationResponse {
        let elicitation_id = AgentElicitationId::new();
        let request = AgentElicitationRequest {
            id: elicitation_id,
            session_id,
            message,
            requested_schema,
        };
        let _ = self.event_tx.send(AgentConnectionManagerEvent {
            connection_id: self.connection_id,
            session_id: Some(session_id),
            prompt_id: None,
            event: AgentEvent::ElicitationRequested { request },
        });

        let (tx, rx) = oneshot::channel();
        self.pending_elicitations.lock().await.insert(
            elicitation_id.to_string(),
            PendingElicitation {
                elicitation_id,
                session_id,
                tx,
            },
        );

        rx.await.unwrap_or(AgentElicitationResponse::Cancel)
    }

    async fn handle_ext_notification(
        &self,
        ext: agent_client_protocol::schema::v1::ExtNotification,
    ) -> Result<(), acp::Error> {
        let params: serde_json::Value =
            serde_json::from_str(ext.params.get()).unwrap_or(serde_json::Value::Null);
        let updates = self
            .grok_subagent
            .lock()
            .await
            .handle_ext(ext.method.as_ref(), &params);
        let session_id = match params
            .get("sessionId")
            .or_else(|| params.get("session_id"))
            .and_then(|value| value.as_str())
        {
            Some(acp_session_id) => self.agent_session_for_acp(acp_session_id.to_string()).await,
            None => {
                let sessions = self.session_map.read().await;
                if sessions.len() == 1 {
                    sessions.keys().next().copied()
                } else {
                    None
                }
            }
        };
        if crate::grok_announcements::is_announcements_method(ext.method.as_ref()) {
            if let Some(update) = crate::grok_announcements::parse_update(&params) {
                let notices =
                    crate::grok_announcements::notices_from_update(&update, &self.agent_id);
                let _ = self.event_tx.send(AgentConnectionManagerEvent {
                    connection_id: self.connection_id,
                    session_id,
                    prompt_id: None,
                    event: AgentEvent::AnnouncementsUpdated {
                        generation: update.generation,
                        notices,
                    },
                });
            }
            return Ok(());
        }
        if updates.is_empty() {
            let _ = self.event_tx.send(AgentConnectionManagerEvent {
                connection_id: self.connection_id,
                session_id,
                prompt_id: None,
                event: AgentEvent::RawAcpDiagnostic {
                    raw: bounded_ext_notification(ext.method.as_ref(), &params),
                },
            });
            return Ok(());
        }
        for update in updates {
            let _ = self.event_tx.send(AgentConnectionManagerEvent {
                connection_id: self.connection_id,
                session_id,
                prompt_id: None,
                event: AgentEvent::ToolCallUpdate {
                    update: AgentToolCallUpdate {
                        id: update.tool_call_id,
                        status: None,
                        content: None,
                        input_preview: None,
                        meta: Some(update.meta),
                        images: Vec::new(),
                    },
                },
            });
        }
        Ok(())
    }

    async fn session_notification(&self, args: SessionNotification) -> Result<(), acp::Error> {
        // Any agent activity (message/thought/tool/plan/usage/mode update) keeps
        // the in-flight prompt alive for the idle watchdog in `run_prompt`.
        *self.last_activity.lock().await = Instant::now();
        let acp_session_id = args.session_id.0.to_string();
        let session_id = resolve_agent_session_id(
            self.agent_session_for_acp(acp_session_id.clone()).await,
            *self.pending_session_id.lock().await,
        );
        let event = match args.update {
            SessionUpdate::AgentMessageChunk(chunk) => self
                .gate_stream_chunk(
                    &acp_session_id,
                    StreamKind::Message,
                    acp_content_to_agent(chunk.content),
                )
                .await
                .map(|content| AgentEvent::MessageChunk { content }),
            SessionUpdate::AgentThoughtChunk(chunk) => self
                .gate_stream_chunk(
                    &acp_session_id,
                    StreamKind::Thought,
                    acp_content_to_agent(chunk.content),
                )
                .await
                .map(|content| AgentEvent::ThoughtChunk { content }),
            SessionUpdate::ToolCall(tool_call) => {
                let input_preview = acp_tool_input_preview(
                    tool_call.raw_input.as_ref(),
                    &tool_call.content,
                    &tool_call.locations,
                );
                let meta = bounded_optional_meta(tool_call.meta);
                self.grok_subagent.lock().await.note_tool_call(
                    tool_call.tool_call_id.0.as_ref(),
                    Some(tool_call.title.as_str()),
                    input_preview.as_deref(),
                    meta.as_ref(),
                    Some("running"),
                );
                Some(AgentEvent::ToolCall {
                    tool_call: AgentToolCall {
                        id: tool_call.tool_call_id.0.to_string(),
                        title: tool_call.title,
                        kind: Some(acp_enum_label(&tool_call.kind)),
                        input_preview,
                        meta,
                        images: acp_tool_images(&tool_call.content),
                    },
                })
            }
            SessionUpdate::ToolCallUpdate(update) => {
                let input_preview = acp_tool_input_preview(
                    update.fields.raw_input.as_ref(),
                    update.fields.content.as_deref().unwrap_or_default(),
                    update.fields.locations.as_deref().unwrap_or_default(),
                );
                let status = update.fields.status.as_ref().map(acp_enum_label);
                let meta = bounded_optional_meta(update.meta);
                self.grok_subagent.lock().await.note_tool_call(
                    update.tool_call_id.0.as_ref(),
                    None,
                    input_preview.as_deref(),
                    meta.as_ref(),
                    status.as_deref(),
                );
                Some(AgentEvent::ToolCallUpdate {
                    update: AgentToolCallUpdate {
                        id: update.tool_call_id.0.to_string(),
                        status,
                        content: update
                            .fields
                            .raw_output
                            .as_ref()
                            .and_then(|output| {
                                serde_json::to_string(output).ok().map(truncate_preview)
                            })
                            .or_else(|| {
                                update
                                    .fields
                                    .content
                                    .as_deref()
                                    .and_then(acp_tool_content_preview)
                            }),
                        input_preview,
                        meta,
                        images: acp_tool_images(
                            update.fields.content.as_deref().unwrap_or_default(),
                        ),
                    },
                })
            }
            SessionUpdate::Plan(plan) => Some(AgentEvent::Plan {
                plan: AgentPlan {
                    entries: plan
                        .entries
                        .into_iter()
                        .map(|entry| crate::AgentPlanEntry {
                            content: entry.content,
                            status: plan_entry_status_name(entry.status),
                            priority: Some(plan_entry_priority_name(entry.priority)),
                        })
                        .collect(),
                },
            }),
            SessionUpdate::AvailableCommandsUpdate(update) => {
                let commands = agent_available_commands_from_acp(update.available_commands);
                if let Some(session_id) = session_id {
                    self.session_controls
                        .write()
                        .await
                        .entry(session_id)
                        .or_default()
                        .available_commands = Some(commands.clone());
                }
                Some(AgentEvent::AvailableCommands { commands })
            }
            SessionUpdate::UserMessageChunk(chunk) => Some(AgentEvent::RawAcpDiagnostic {
                raw: serde_json::json!({
                    "kind": "user_message_acknowledged",
                    "preview": acp_content_preview(&chunk.content),
                }),
            }),
            SessionUpdate::CurrentModeUpdate(update) => {
                let mode_id = update.current_mode_id.0.to_string();
                if let Some(session_id) = session_id {
                    let options = {
                        let mut controls = self.session_controls.write().await;
                        let entry = controls.entry(session_id).or_default();
                        apply_current_mode_to_config_options(&mut entry.config_options, &mode_id);
                        entry.config_options.clone()
                    };
                    let (modes, current) = session_modes_from_config_options(&options);
                    let _ = self.event_tx.send(AgentConnectionManagerEvent {
                        connection_id: self.connection_id,
                        session_id: Some(session_id),
                        prompt_id: None,
                        event: AgentEvent::SessionModes { modes, current },
                    });
                }
                Some(AgentEvent::ModeChanged { mode_id })
            }
            SessionUpdate::ConfigOptionUpdate(update) => {
                // Mirror the pushed options into the stored controls so later
                // `session/set_config_option` matching never works off stale data.
                if let Some(session_id) = session_id {
                    let mut controls = self.session_controls.write().await;
                    let stored = controls.entry(session_id).or_default();
                    stored.config_options = update.config_options.clone();
                    stored.mode_uses_set_mode = stored.mode_uses_set_mode
                        && config_options_have_mode_category(&stored.config_options);
                }
                Some(AgentEvent::SessionConfigOptions {
                    options: agent_session_config_options_from_acp(update.config_options),
                })
            }
            SessionUpdate::UsageUpdate(update) => Some(AgentEvent::Usage {
                usage: agent_usage_from_acp(update),
            }),
            SessionUpdate::SessionInfoUpdate(update) => Some(AgentEvent::SessionInfoUpdated {
                patch: session_info_patch_from_acp(update),
            }),
            other => {
                let mut raw_notification =
                    serde_json::to_value(other).unwrap_or(serde_json::Value::Null);
                bound_meta_fields(&mut raw_notification);
                Some(AgentEvent::RawAcpDiagnostic {
                    raw: raw_notification,
                })
            }
        };

        if let Some(event) = event {
            let _ = self.event_tx.send(AgentConnectionManagerEvent {
                connection_id: self.connection_id,
                session_id,
                prompt_id: None,
                event,
            });
        }
        Ok(())
    }

    async fn agent_session_for_acp(&self, acp_session_id: String) -> Option<AgentSessionId> {
        self.session_map
            .read()
            .await
            .iter()
            .find_map(|(agent_session_id, candidate)| {
                if candidate == &acp_session_id {
                    Some(*agent_session_id)
                } else {
                    None
                }
            })
    }

    async fn create_terminal(
        &self,
        args: agent_client_protocol::schema::v1::CreateTerminalRequest,
    ) -> Result<CreateTerminalResponse, acp::Error> {
        let acp_session = args.session_id.0.to_string();
        let Some(session_id) = self.agent_session_for_acp(acp_session.clone()).await else {
            tracing::warn!(
                acp_session = %acp_session,
                "create_terminal for unknown ACP session — rejecting instead of \
                 routing to a phantom session"
            );
            return Err(acp::Error::invalid_params());
        };
        let terminal_id = agent_terminal_registry()
            .create_terminal(&AgentTerminalCreateRequest {
                session_id,
                command: args.command,
                args: args.args,
                cwd: args.cwd.map(|cwd| cwd.display().to_string()),
                env: args
                    .env
                    .into_iter()
                    .map(|var| AgentTerminalEnvVar {
                        name: var.name,
                        value: var.value,
                    })
                    .collect(),
                output_byte_limit: args.output_byte_limit,
            })
            .await
            .map_err(|_| acp::Error::internal_error())?;
        Ok(CreateTerminalResponse::new(TerminalId::new(
            terminal_id.to_string(),
        )))
    }

    async fn kill_terminal(
        &self,
        args: KillTerminalRequest,
    ) -> Result<KillTerminalResponse, acp::Error> {
        let terminal_id = parse_terminal_id(&args.terminal_id)?;
        if !agent_terminal_registry()
            .kill_terminal(terminal_id.into())
            .await
        {
            return Err(acp::Error::invalid_params());
        }
        Ok(KillTerminalResponse::new())
    }
}

fn resolve_agent_session_id(
    mapped: Option<AgentSessionId>,
    pending: Option<AgentSessionId>,
) -> Option<AgentSessionId> {
    mapped.or(pending)
}

fn parse_terminal_id(id: &TerminalId) -> Result<uuid::Uuid, acp::Error> {
    uuid::Uuid::parse_str(id.0.as_ref()).map_err(|_| acp::Error::invalid_params())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ConfigOverrideSelection {
    config_id: String,
    wire_value: SessionConfigOptionValue,
    event_value: serde_json::Value,
    already_selected: bool,
}

fn non_empty_trimmed(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty()).then_some(value)
}

/// Apply a model selection before options that may depend on it. The category
/// comes from the Agent's ACP session-config advertisement; `sort_by_key` is
/// stable, so unrelated selections retain their caller-provided order.
fn ordered_session_config_overrides(
    options: &[AcpSessionConfigOption],
    mut overrides: Vec<AgentSessionConfigOverride>,
) -> Vec<AgentSessionConfigOverride> {
    overrides.sort_by_key(|override_item| {
        let is_model = options.iter().any(|option| {
            matches!(
                option.category.as_ref(),
                Some(SessionConfigOptionCategory::Model)
            ) && config_option_matches(option, &override_item.key)
        });
        u8::from(!is_model)
    });
    overrides
}

/// Effective auto-approve mode for a permission decision. ACP session modes
/// are Agent-owned semantics: for example Claude Code's `auto` asks its model
/// classifier to decide. They must never silently upgrade VibeX's independent
/// auto-approval policy.
async fn effective_auto_approve_mode(
    configured: AgentAutoApproveMode,
    _session_controls: &RwLock<HashMap<AgentSessionId, SessionControlState>>,
    _session_id: AgentSessionId,
) -> AgentAutoApproveMode {
    configured
}

fn find_config_override_selection(
    options: &[AcpSessionConfigOption],
    key: &str,
    value: &serde_json::Value,
) -> Option<ConfigOverrideSelection> {
    for option in options {
        if !config_option_matches(option, key) {
            continue;
        }
        match &option.kind {
            SessionConfigKind::Select(select) => {
                let requested = value.as_str()?;
                if let Some(choice) = find_select_choice(select, key, requested) {
                    let value_id = choice.value.0.to_string();
                    return Some(ConfigOverrideSelection {
                        config_id: option.id.0.to_string(),
                        wire_value: SessionConfigOptionValue::value_id(value_id.clone()),
                        event_value: serde_json::Value::String(value_id),
                        already_selected: select.current_value == choice.value,
                    });
                }
            }
            SessionConfigKind::Boolean(boolean) => {
                let requested = value
                    .as_bool()
                    .or_else(|| value.as_str().and_then(|value| value.parse::<bool>().ok()))?;
                return Some(ConfigOverrideSelection {
                    config_id: option.id.0.to_string(),
                    wire_value: SessionConfigOptionValue::boolean(requested),
                    event_value: serde_json::Value::Bool(requested),
                    already_selected: boolean.current_value == requested,
                });
            }
            #[allow(unreachable_patterns)]
            _ => continue,
        }
    }
    None
}

fn advertised_option_is_mode(options: &[AcpSessionConfigOption], config_id: &str) -> bool {
    options.iter().any(|option| {
        option.id.0.as_ref() == config_id
            && matches!(option.category, Some(SessionConfigOptionCategory::Mode))
    })
}

fn config_options_have_mode_category(options: &[AcpSessionConfigOption]) -> bool {
    options
        .iter()
        .any(|option| matches!(option.category, Some(SessionConfigOptionCategory::Mode)))
}

fn unify_session_config_options(
    modes: Option<SessionModeState>,
    mut config_options: Vec<AcpSessionConfigOption>,
    keep_legacy_modes: bool,
) -> (Vec<AcpSessionConfigOption>, bool) {
    if config_options_have_mode_category(&config_options) {
        return (config_options, false);
    }
    // Standard ACP treats advertised config options as exclusive of legacy
    // Session Modes. Vendor adapters may keep both dimensions.
    if !config_options.is_empty() && !keep_legacy_modes {
        return (config_options, false);
    }
    let Some(modes) = modes.filter(|modes| !modes.available_modes.is_empty()) else {
        return (config_options, false);
    };
    config_options.insert(0, config_option_from_session_modes(&modes));
    (config_options, true)
}

fn config_option_from_session_modes(modes: &SessionModeState) -> AcpSessionConfigOption {
    let choices = modes
        .available_modes
        .iter()
        .map(|mode| {
            vendor_select_choice(
                mode.id.0.to_string(),
                mode.name.clone(),
                mode.description.clone(),
            )
        })
        .collect();
    AcpSessionConfigOption::select(
        "mode",
        "Mode",
        modes.current_mode_id.0.to_string(),
        SessionConfigSelectOptions::Ungrouped(choices),
    )
    .category(SessionConfigOptionCategory::Mode)
}

fn session_modes_from_config_options(
    options: &[AcpSessionConfigOption],
) -> (Vec<AgentSessionMode>, Option<String>) {
    let Some(option) = options
        .iter()
        .find(|option| matches!(option.category, Some(SessionConfigOptionCategory::Mode)))
    else {
        return (Vec::new(), None);
    };
    let mapped = agent_session_config_option_from_acp(option.clone());
    let current = mapped
        .value
        .as_ref()
        .and_then(serde_json::Value::as_str)
        .map(ToOwned::to_owned);
    let modes = mapped
        .choices
        .into_iter()
        .filter_map(|choice| {
            let id = choice.value.as_str()?.to_string();
            if id.is_empty() {
                return None;
            }
            Some(AgentSessionMode {
                id,
                label: choice.label,
                description: choice.description,
            })
        })
        .collect();
    (modes, current)
}

fn apply_current_mode_to_config_options(options: &mut [AcpSessionConfigOption], mode_id: &str) {
    for option in options {
        if !matches!(option.category, Some(SessionConfigOptionCategory::Mode)) {
            continue;
        }
        if let SessionConfigKind::Select(select) = &mut option.kind {
            select.current_value = SessionConfigValueId::new(mode_id);
        }
    }
}

fn advertised_option_is_thought_level(options: &[AcpSessionConfigOption], config_id: &str) -> bool {
    options.iter().any(|option| {
        option.id.0.as_ref() == config_id && config_option_matches(option, "thought_level")
    })
}

fn config_option_matches(option: &AcpSessionConfigOption, key: &str) -> bool {
    let key = normalize_config_token(key);
    let id = normalize_config_token(option.id.0.as_ref());
    let name = normalize_config_token(&option.name);
    let category = option.category.as_ref();

    match key.as_str() {
        "model" => {
            matches!(category, Some(SessionConfigOptionCategory::Model))
                || id.contains("model")
                || name.contains("model")
        }
        "reasoning" | "reasoningeffort" | "thoughteffort" | "thoughtlevel" => {
            matches!(category, Some(SessionConfigOptionCategory::ThoughtLevel))
                || id.contains("reason")
                || name.contains("reason")
                || id.contains("thought")
                || name.contains("thought")
                || id.contains("effort")
                || name.contains("effort")
        }
        "sandbox" => id.contains("sandbox") || name.contains("sandbox"),
        "fast" | "fastmode" => id.contains("fast") || name.contains("fast"),
        "approval" | "approvalpolicy" | "permission" | "permissionmode" => {
            id.contains("approval")
                || name.contains("approval")
                || id.contains("permission")
                || name.contains("permission")
        }
        "mode" => {
            matches!(category, Some(SessionConfigOptionCategory::Mode))
                || id.contains("mode")
                || name.contains("mode")
        }
        _ => id == key || name == key,
    }
}

fn find_select_choice<'a>(
    select: &'a agent_client_protocol::schema::v1::SessionConfigSelect,
    key: &str,
    value: &str,
) -> Option<&'a SessionConfigSelectOption> {
    let aliases = config_value_aliases(key, value);
    let options = match &select.options {
        SessionConfigSelectOptions::Ungrouped(options) => options.iter().collect::<Vec<_>>(),
        SessionConfigSelectOptions::Grouped(groups) => groups
            .iter()
            .flat_map(|group| group.options.iter())
            .collect::<Vec<_>>(),
        #[allow(unreachable_patterns)]
        _ => return None,
    };

    // Resolve exact IDs/names across the complete choice set before applying
    // compatibility aliases. Otherwise an earlier short value such as
    // `agent` steals the exact Codex value `agent-full-access` by substring.
    options
        .iter()
        .copied()
        .find(|option| select_choice_matches_exact(option, &aliases))
        .or_else(|| {
            options
                .into_iter()
                .find(|option| select_choice_matches(option, &aliases))
        })
}

fn select_choice_matches_exact(option: &SessionConfigSelectOption, aliases: &[String]) -> bool {
    select_choice_values(option)
        .iter()
        .any(|value| aliases.iter().any(|alias| value == alias))
}

fn select_choice_matches(option: &SessionConfigSelectOption, aliases: &[String]) -> bool {
    select_choice_values(option).iter().any(|value| {
        aliases.iter().any(|alias| {
            let meaningful_alias = alias.len() > 3;
            let meaningful_value = value.len() > 3;
            (meaningful_alias && value.contains(alias))
                || (meaningful_value && alias.contains(value))
        })
    })
}

fn select_choice_values(option: &SessionConfigSelectOption) -> Vec<String> {
    let mut values = vec![
        normalize_config_token(option.value.0.as_ref()),
        normalize_config_token(&option.name),
    ];
    if let Some(description) = &option.description {
        values.push(normalize_config_token(description));
    }
    values
}

fn config_value_aliases(key: &str, value: &str) -> Vec<String> {
    let key = normalize_config_token(key);
    let value = normalize_config_token(value);
    let mut aliases = vec![value.clone()];

    match (key.as_str(), value.as_str()) {
        ("approval" | "approvalpolicy" | "permission" | "permissionmode", "ask") => {
            aliases.extend(
                [
                    "manual",
                    "confirm",
                    "approval",
                    "approvals",
                    "onrequest",
                    "unlesstrusted",
                ]
                .into_iter()
                .map(str::to_string),
            );
        }
        ("approval" | "approvalpolicy" | "permission" | "permissionmode", "auto") => {
            aliases.extend(
                [
                    "allow",
                    "always",
                    "never",
                    "skip",
                    "autoapprove",
                    "dangerfullaccess",
                    "dangerouslyskippermissions",
                ]
                .into_iter()
                .map(str::to_string),
            );
        }
        ("reasoning" | "reasoningeffort" | "thoughteffort" | "thoughtlevel", "xhigh") => {
            aliases.push("extrahigh".to_string());
        }
        ("fast" | "fastmode", "true") => {
            aliases.extend(["enabled", "on", "fast"].into_iter().map(str::to_string));
        }
        ("fast" | "fastmode", "false") => {
            aliases.extend(
                ["disabled", "off", "normal"]
                    .into_iter()
                    .map(str::to_string),
            );
        }
        _ => {}
    }

    aliases.sort();
    aliases.dedup();
    aliases
}

fn normalize_config_token(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(|ch| ch.to_lowercase())
        .collect()
}

fn agent_block_to_acp(block: AgentContentBlock) -> ContentBlock {
    match block {
        AgentContentBlock::Text { text } => ContentBlock::Text(TextContent::new(text)),
        AgentContentBlock::Image {
            data,
            mime_type,
            uri,
        } => ContentBlock::Image(ImageContent::new(data, mime_type).uri(uri)),
        AgentContentBlock::Resource { uri, title } => {
            let name = title
                .clone()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| {
                    uri.rsplit(['/', '\\'])
                        .find(|segment| !segment.is_empty())
                        .unwrap_or(uri.as_str())
                        .to_string()
                });
            ContentBlock::ResourceLink(ResourceLink::new(name, uri).title(title))
        }
        AgentContentBlock::Protocol { content } => {
            serde_json::from_value(content).unwrap_or_else(|error| {
                ContentBlock::Text(TextContent::new(format!(
                    "Unsupported ACP content block: {error}"
                )))
            })
        }
    }
}

fn acp_content_preview(block: &ContentBlock) -> String {
    match acp_content_to_agent(block.clone()) {
        AgentContentBlock::Text { text } => text.chars().take(200).collect(),
        AgentContentBlock::Image { mime_type, .. } => format!("image/{mime_type}"),
        AgentContentBlock::Resource { uri, .. } => uri,
        AgentContentBlock::Protocol { content } => content
            .get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("content")
            .to_string(),
    }
}

fn bounded_ext_notification(method: &str, params: &serde_json::Value) -> serde_json::Value {
    let mut payload = serde_json::json!({
        "kind": "ext_notification",
        "method": method,
        "params": params,
    });
    bound_meta_fields(&mut payload);
    payload
}

fn acp_content_to_agent(block: ContentBlock) -> AgentContentBlock {
    match block {
        ContentBlock::Text(text) if text.meta.is_none() => {
            AgentContentBlock::Text { text: text.text }
        }
        ContentBlock::Image(image) if image.meta.is_none() => AgentContentBlock::Image {
            data: image.data,
            mime_type: image.mime_type,
            uri: image.uri,
        },
        #[allow(unreachable_patterns)]
        other => AgentContentBlock::Protocol {
            content: bounded_acp_content_value(other),
        },
    }
}

fn bounded_acp_content_value(block: impl Serialize) -> serde_json::Value {
    let mut value = serde_json::to_value(block).unwrap_or(serde_json::Value::Null);
    bound_meta_fields(&mut value);
    value
}

fn session_info_patch_from_acp(
    update: agent_client_protocol::schema::v1::SessionInfoUpdate,
) -> serde_json::Value {
    let mut value = serde_json::to_value(update).unwrap_or(serde_json::Value::Null);
    bound_meta_fields(&mut value);
    value
}

fn bounded_optional_meta(meta: Option<impl Serialize>) -> Option<serde_json::Value> {
    meta.and_then(|meta| serde_json::to_value(meta).ok())
        .filter(|meta| {
            serde_json::to_vec(meta).is_ok_and(|encoded| encoded.len() <= MAX_CONTENT_META_BYTES)
        })
}

fn bound_meta_fields(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(object) => {
            if object.get("_meta").is_some_and(|meta| {
                serde_json::to_vec(meta)
                    .map(|encoded| encoded.len() > MAX_CONTENT_META_BYTES)
                    .unwrap_or(true)
            }) {
                object.remove("_meta");
            }
            for child in object.values_mut() {
                bound_meta_fields(child);
            }
        }
        serde_json::Value::Array(values) => {
            for child in values {
                bound_meta_fields(child);
            }
        }
        _ => {}
    }
}

fn acp_enum_label<T>(value: &T) -> String
where
    T: Serialize + std::fmt::Debug,
{
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| format!("{value:?}"))
}

fn agent_usage_from_acp(update: agent_client_protocol::schema::v1::UsageUpdate) -> AgentUsage {
    let (cost_amount, cost_currency) = update
        .cost
        .map(|cost| (Some(cost.amount), Some(cost.currency)))
        .unwrap_or((None, None));
    let meta = update.meta.as_ref().and_then(|meta| {
        serde_json::to_value(meta)
            .ok()
            .and_then(|value| value.as_object().cloned())
    });
    AgentUsage {
        used: update.used,
        limit: Some(update.size),
        input_tokens: meta_u64(meta.as_ref(), &["input_tokens", "prompt_tokens"]),
        output_tokens: meta_u64(meta.as_ref(), &["output_tokens", "completion_tokens"]),
        cache_read_tokens: meta_u64(meta.as_ref(), &["cached_read_tokens", "cache_read_tokens"]),
        cache_write_tokens: meta_u64(
            meta.as_ref(),
            &[
                "cached_write_tokens",
                "cache_write_tokens",
                "cache_creation_input_tokens",
            ],
        ),
        cost_amount,
        cost_currency,
    }
}

fn meta_u64(
    meta: Option<&serde_json::Map<String, serde_json::Value>>,
    keys: &[&str],
) -> Option<u64> {
    let meta = meta?;
    keys.iter().find_map(|key| {
        meta.get(*key).and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_i64().and_then(|n| u64::try_from(n).ok()))
                .or_else(|| value.as_f64().and_then(|n| (n >= 0.0).then_some(n as u64)))
        })
    })
}

fn plan_entry_status_name(status: agent_client_protocol::schema::v1::PlanEntryStatus) -> String {
    match status {
        agent_client_protocol::schema::v1::PlanEntryStatus::Pending => "pending".into(),
        agent_client_protocol::schema::v1::PlanEntryStatus::InProgress => "in_progress".into(),
        agent_client_protocol::schema::v1::PlanEntryStatus::Completed => "completed".into(),
        _ => "pending".into(),
    }
}

fn plan_entry_priority_name(
    priority: agent_client_protocol::schema::v1::PlanEntryPriority,
) -> String {
    match priority {
        agent_client_protocol::schema::v1::PlanEntryPriority::High => "high".into(),
        agent_client_protocol::schema::v1::PlanEntryPriority::Medium => "medium".into(),
        agent_client_protocol::schema::v1::PlanEntryPriority::Low => "low".into(),
        _ => "medium".into(),
    }
}

fn merged_agent_env(configured_env: &HashMap<String, String>) -> HashMap<String, String> {
    merge_agent_env(
        configured_env,
        // Only forward proxy vars that actually have a value. An empty
        // `HTTPS_PROXY=""` inherited from the parent shell makes the agent's
        // HTTP client (reqwest) treat the proxy as misconfigured and fail the
        // request outright — so a blank proxy must not be propagated.
        std::env::vars()
            .filter(|(key, _)| PROXY_ENV_KEYS.contains(&key.as_str()))
            .filter(|(_, value)| !value.trim().is_empty()),
    )
}

fn merge_agent_env(
    configured_env: &HashMap<String, String>,
    proxy_env: impl IntoIterator<Item = (String, String)>,
) -> HashMap<String, String> {
    let mut env = HashMap::from([
        ("NPM_CONFIG_LOGLEVEL".to_string(), "error".to_string()),
        ("NODE_NO_WARNINGS".to_string(), "1".to_string()),
    ]);
    env.extend(configured_env.clone());
    env.extend(proxy_env);
    env
}

/// Session controls synthesized from a vendor `_meta` extension. The standard
/// ACP response fields remain authoritative when present; this only covers
/// agents that advertise their config through `_meta` instead.
struct VendorSessionControls {
    modes: Option<SessionModeState>,
    config_options: Vec<AcpSessionConfigOption>,
}

/// Prefer the standard ACP `modes`/`configOptions` fields and only fall back
/// to a vendor `_meta` extension when the agent advertised neither (Grok
/// currently). The returned wire marker tells the apply path which
/// non-standard method (if any) the agent expects for changes.
fn session_controls_with_vendor_fallback(
    modes: Option<SessionModeState>,
    config_options: Option<Vec<AcpSessionConfigOption>>,
    meta: Option<&serde_json::Map<String, serde_json::Value>>,
) -> (
    Option<SessionModeState>,
    Option<Vec<AcpSessionConfigOption>>,
    Option<VendorConfigWire>,
) {
    // Grok often advertises a standard model `configOption` *and* puts effort
    // / permission in `_meta`. Skipping the vendor map whenever any standard
    // field is present drops those extra dimensions from the create-session
    // and workflow summaries.
    match meta.and_then(vendor_session_controls_from_meta) {
        Some(vendor) => (
            merge_session_mode_states(modes, vendor.modes),
            Some(merge_session_config_options(
                config_options.unwrap_or_default(),
                vendor.config_options,
            )),
            Some(VendorConfigWire::XaiSessionConfig),
        ),
        None => (modes, config_options, None),
    }
}

fn merge_session_mode_states(
    standard: Option<SessionModeState>,
    vendor: Option<SessionModeState>,
) -> Option<SessionModeState> {
    match (standard, vendor) {
        (None, vendor) => vendor,
        (standard, None) => standard,
        (Some(standard), Some(vendor)) => {
            let mut modes = standard.available_modes;
            for mode in vendor.available_modes {
                if !modes.iter().any(|existing| existing.id == mode.id) {
                    modes.push(mode);
                }
            }
            Some(SessionModeState::new(standard.current_mode_id, modes))
        }
    }
}

fn merge_session_config_options(
    standard: Vec<AcpSessionConfigOption>,
    vendor: Vec<AcpSessionConfigOption>,
) -> Vec<AcpSessionConfigOption> {
    let mut options = standard;
    for option in vendor {
        if !options.iter().any(|existing| existing.id == option.id) {
            options.push(option);
        }
    }
    options
}

/// Parse grok's `_meta["x.ai/sessionConfig"]` extension
/// (`{options: [{id, category, label, description?, selected}]}`).
///
/// Grok's `mode` category is reasoning effort (`xhigh` / `high` / `medium`),
/// not ACP session permission modes. Emit it as a `thought_level` config
/// option so the shared summary shows Model · 高 instead of hiding it behind
/// a Mode row. Permission options stay ACP session modes so the existing
/// bypass-permissions safety gate still applies. Effort changes are applied
/// with `session/set_mode`; model changes use `session/set_model`.
fn vendor_session_controls_from_meta(
    meta: &serde_json::Map<String, serde_json::Value>,
) -> Option<VendorSessionControls> {
    let session_config = meta.get("x.ai/sessionConfig")?.as_object()?;
    let options = session_config.get("options")?.as_array()?;
    if options.is_empty() {
        return None;
    }

    let mut model_options: Vec<SessionConfigSelectOption> = Vec::new();
    let mut selected_model: Option<String> = None;
    let mut effort_options: Vec<SessionConfigSelectOption> = Vec::new();
    let mut selected_effort: Option<String> = None;
    let mut permission_modes: Vec<acp::schema::v1::SessionMode> = Vec::new();
    let mut selected_permission: Option<String> = None;

    for raw in options {
        let Some(option) = raw.as_object() else {
            continue;
        };
        let Some(id) = option
            .get("id")
            .and_then(serde_json::Value::as_str)
            .map(ToString::to_string)
        else {
            continue;
        };
        let label = option
            .get("label")
            .and_then(serde_json::Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| id.clone());
        let description = option
            .get("description")
            .and_then(serde_json::Value::as_str)
            .map(ToString::to_string);
        let selected = option
            .get("selected")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let category = option.get("category").and_then(serde_json::Value::as_str);
        match classify_vendor_session_option(category, &id, &label) {
            VendorSessionOptionKind::Model => {
                model_options.push(vendor_select_choice(id.clone(), label, description));
                if selected {
                    selected_model = Some(id);
                }
            }
            VendorSessionOptionKind::Effort => {
                effort_options.push(vendor_select_choice(id.clone(), label, description));
                if selected {
                    selected_effort = Some(id);
                }
            }
            VendorSessionOptionKind::Permission => {
                let mut mode = acp::schema::v1::SessionMode::new(id.clone(), label);
                if let Some(description) = description {
                    mode = mode.description(description);
                }
                permission_modes.push(mode);
                if selected {
                    selected_permission = Some(id);
                }
            }
            VendorSessionOptionKind::Unknown => {}
        }
    }

    let mut config_options = Vec::new();
    if !model_options.is_empty() {
        let current = selected_model.unwrap_or_else(|| model_options[0].value.0.to_string());
        config_options.push(
            AcpSessionConfigOption::select(
                "model",
                "Model",
                current,
                SessionConfigSelectOptions::Ungrouped(model_options),
            )
            .category(SessionConfigOptionCategory::Model),
        );
    }
    if !effort_options.is_empty() {
        let current = selected_effort.unwrap_or_else(|| effort_options[0].value.0.to_string());
        config_options.push(
            AcpSessionConfigOption::select(
                "effort",
                "推理强度",
                current,
                SessionConfigSelectOptions::Ungrouped(effort_options),
            )
            .category(SessionConfigOptionCategory::ThoughtLevel),
        );
    }
    let modes = if permission_modes.is_empty() {
        None
    } else {
        let current = selected_permission.unwrap_or_else(|| permission_modes[0].id.0.to_string());
        Some(SessionModeState::new(current, permission_modes))
    };
    if config_options.is_empty() && modes.is_none() {
        return None;
    }
    Some(VendorSessionControls {
        modes,
        config_options,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VendorSessionOptionKind {
    Model,
    Effort,
    Permission,
    Unknown,
}

fn classify_vendor_session_option(
    category: Option<&str>,
    id: &str,
    label: &str,
) -> VendorSessionOptionKind {
    // Inspect each field on its own. Concatenating `mode` + `low` produces
    // `modelow`, which contains `model` and would steal Grok's Low Effort
    // choice into the Model selector.
    let category = normalize_config_token(category.unwrap_or_default());
    let id = normalize_config_token(id);
    let label = normalize_config_token(label);
    if vendor_token_contains_any(&[&category, &id, &label], "model") {
        return VendorSessionOptionKind::Model;
    }
    if vendor_token_contains_any(&[&category, &id, &label], "permission")
        || vendor_token_contains_any(&[&category, &id, &label], "approval")
        || matches!(
            id.as_str(),
            "default" | "acceptedits" | "auto" | "dontask" | "bypasspermissions" | "plan"
        )
    {
        return VendorSessionOptionKind::Permission;
    }
    if matches!(
        category.as_str(),
        "mode" | "effort" | "thought" | "thoughtlevel" | "reasoning"
    ) || vendor_token_contains_any(&[&category, &id, &label], "effort")
        || vendor_token_contains_any(&[&category, &id, &label], "thought")
        || vendor_token_contains_any(&[&category, &id, &label], "reason")
        || matches!(id.as_str(), "xhigh" | "high" | "medium" | "low" | "minimal")
    {
        return VendorSessionOptionKind::Effort;
    }
    VendorSessionOptionKind::Unknown
}

fn vendor_token_contains_any(tokens: &[&str], needle: &str) -> bool {
    tokens.iter().any(|token| token.contains(needle))
}

fn vendor_select_choice(
    id: String,
    label: String,
    description: Option<String>,
) -> SessionConfigSelectOption {
    let mut choice = SessionConfigSelectOption::new(id, label);
    if let Some(description) = description {
        choice = choice.description(description);
    }
    choice
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn agent_session_modes_from_acp(
    state: SessionModeState,
) -> (Vec<AgentSessionMode>, Option<String>) {
    let current = Some(state.current_mode_id.0.to_string());
    let modes = state
        .available_modes
        .into_iter()
        .map(|mode| AgentSessionMode {
            id: mode.id.0.to_string(),
            label: mode.name,
            description: mode.description,
        })
        .collect();
    (modes, current)
}

pub(crate) fn agent_session_config_options_from_acp(
    options: Vec<AcpSessionConfigOption>,
) -> Vec<AgentSessionConfigOption> {
    options
        .into_iter()
        .map(agent_session_config_option_from_acp)
        .collect()
}

fn agent_session_config_option_from_acp(
    option: AcpSessionConfigOption,
) -> AgentSessionConfigOption {
    let (value, choices) = match option.kind {
        SessionConfigKind::Select(select) => (
            Some(serde_json::Value::String(
                select.current_value.0.to_string(),
            )),
            agent_session_config_choices_from_acp(select.options),
        ),
        SessionConfigKind::Boolean(boolean) => (
            Some(serde_json::Value::Bool(boolean.current_value)),
            vec![
                AgentSessionConfigChoice {
                    value: serde_json::Value::Bool(false),
                    label: "Off".to_string(),
                    description: None,
                },
                AgentSessionConfigChoice {
                    value: serde_json::Value::Bool(true),
                    label: "On".to_string(),
                    description: None,
                },
            ],
        ),
        #[allow(unreachable_patterns)]
        _ => (None, Vec::new()),
    };

    AgentSessionConfigOption {
        key: option.id.0.to_string(),
        label: option.name,
        description: option.description,
        // Serialized form of the ACP category enum ("mode" / "model" / …).
        category: option.category.as_ref().and_then(|category| {
            serde_json::to_value(category)
                .ok()
                .and_then(|value| value.as_str().map(str::to_string))
        }),
        value,
        choices,
        dependency: None,
    }
}

fn agent_session_config_choices_from_acp(
    options: SessionConfigSelectOptions,
) -> Vec<AgentSessionConfigChoice> {
    match options {
        SessionConfigSelectOptions::Ungrouped(options) => options
            .into_iter()
            .map(agent_session_config_choice_from_acp)
            .collect(),
        SessionConfigSelectOptions::Grouped(groups) => groups
            .into_iter()
            .flat_map(|group| group.options.into_iter())
            .map(agent_session_config_choice_from_acp)
            .collect(),
        #[allow(unreachable_patterns)]
        _ => Vec::new(),
    }
}

fn agent_session_config_choice_from_acp(
    option: SessionConfigSelectOption,
) -> AgentSessionConfigChoice {
    AgentSessionConfigChoice {
        value: serde_json::Value::String(option.value.0.to_string()),
        label: option.name,
        description: option.description,
    }
}

fn agent_available_commands_from_acp(
    commands: Vec<AcpAvailableCommand>,
) -> Vec<AgentAvailableCommand> {
    commands
        .into_iter()
        .map(|command| AgentAvailableCommand {
            name: command.name,
            description: Some(command.description),
            input_schema: command
                .input
                .and_then(|input| serde_json::to_value(input).ok()),
        })
        .collect()
}

fn agent_permission_option_kind(kind: PermissionOptionKind) -> AgentPermissionOptionKind {
    match kind {
        PermissionOptionKind::AllowOnce => AgentPermissionOptionKind::AllowOnce,
        PermissionOptionKind::AllowAlways => AgentPermissionOptionKind::AllowAlways,
        PermissionOptionKind::RejectOnce => AgentPermissionOptionKind::RejectOnce,
        PermissionOptionKind::RejectAlways => AgentPermissionOptionKind::RejectAlways,
        #[allow(unreachable_patterns)]
        _ => AgentPermissionOptionKind::Unknown,
    }
}

fn permission_response_outcome(response: AgentPermissionResponse) -> RequestPermissionOutcome {
    match response {
        AgentPermissionResponse::Selected { option_id } => {
            RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option_id))
        }
        AgentPermissionResponse::Cancelled => RequestPermissionOutcome::Cancelled,
    }
}

fn elicitation_response_action(response: AgentElicitationResponse) -> ElicitationAction {
    match response {
        AgentElicitationResponse::Accept { content } => {
            // The wire type only admits primitive values; anything else the UI
            // slipped in is dropped rather than failing the whole answer.
            let validated = content
                .as_object()
                .map(|map| {
                    map.iter()
                        .filter_map(|(key, value)| {
                            serde_json::from_value::<ElicitationContentValue>(value.clone())
                                .ok()
                                .map(|value| (key.clone(), value))
                        })
                        .collect::<std::collections::BTreeMap<_, _>>()
                })
                .unwrap_or_default();
            ElicitationAction::Accept(ElicitationAcceptAction::new().content(validated))
        }
        AgentElicitationResponse::Decline => ElicitationAction::Decline,
        AgentElicitationResponse::Cancel => ElicitationAction::Cancel,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
            let (event_tx, _event_rx) = mpsc::unbounded_channel();
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
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
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
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
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
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
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
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
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

        assert!(
            err.to_string()
                .contains("agent connection command channel closed")
        );
    }

    #[tokio::test]
    async fn manager_in_memory_resumes_session_with_external_id() {
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
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

        let (acp_session_id, controls) = manager
            .resume_session(connection_id, session_id, "external-session")
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
    fn prompt_idle_timeout_uses_default_for_missing_or_invalid_env() {
        assert_eq!(
            prompt_idle_timeout_from_env_value(None),
            Duration::from_secs(DEFAULT_PROMPT_IDLE_TIMEOUT_SECS)
        );
        assert_eq!(
            prompt_idle_timeout_from_env_value(Some("0")),
            Duration::from_secs(DEFAULT_PROMPT_IDLE_TIMEOUT_SECS)
        );
        assert_eq!(
            prompt_idle_timeout_from_env_value(Some("nope")),
            Duration::from_secs(DEFAULT_PROMPT_IDLE_TIMEOUT_SECS)
        );
    }

    #[test]
    fn prompt_idle_timeout_accepts_positive_env_value() {
        assert_eq!(
            prompt_idle_timeout_from_env_value(Some("120")),
            Duration::from_secs(120)
        );
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
    fn pi_workspace_trust_is_seeded_additively_and_idempotently() {
        let root = tempfile::tempdir().expect("temp dir");
        let workspace = root.path().join("workspace");
        let agent_dir = root.path().join("pi-agent");
        std::fs::create_dir_all(&workspace).expect("workspace");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        std::fs::write(
            agent_dir.join("trust.json"),
            serde_json::to_vec(&serde_json::json!({ "/already/trusted": true }))
                .expect("serialize"),
        )
        .expect("seed trust");
        let env = HashMap::from([(
            PI_CONFIG_DIR_ENV.to_string(),
            agent_dir.display().to_string(),
        )]);

        seed_pi_workspace_trust(&workspace, &env).expect("first seed");
        seed_pi_workspace_trust(&workspace, &env).expect("second seed");

        let document: serde_json::Value = serde_json::from_slice(
            &std::fs::read(agent_dir.join("trust.json")).expect("read trust"),
        )
        .expect("valid trust");
        let object = document.as_object().expect("object");
        let canonical = std::fs::canonicalize(workspace).expect("canonical workspace");
        assert_eq!(
            object.get("/already/trusted"),
            Some(&serde_json::json!(true))
        );
        assert_eq!(
            object.get(&canonical.to_string_lossy().into_owned()),
            Some(&serde_json::json!(true))
        );
        assert_eq!(object.len(), 2);
    }

    #[test]
    fn pi_workspace_trust_preserves_explicit_false() {
        let root = tempfile::tempdir().expect("temp dir");
        let workspace = root.path().join("workspace");
        let agent_dir = root.path().join("pi-agent");
        std::fs::create_dir_all(&workspace).expect("workspace");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        let canonical = std::fs::canonicalize(&workspace).expect("canonical workspace");
        std::fs::write(
            agent_dir.join("trust.json"),
            serde_json::to_vec(&serde_json::json!({
                canonical.to_string_lossy().into_owned(): false
            }))
            .expect("serialize"),
        )
        .expect("seed trust");
        let env = HashMap::from([(
            PI_CONFIG_DIR_ENV.to_string(),
            agent_dir.display().to_string(),
        )]);

        seed_pi_workspace_trust(&workspace, &env).expect("seed should be a no-op");

        let document: serde_json::Value = serde_json::from_slice(
            &std::fs::read(agent_dir.join("trust.json")).expect("read trust"),
        )
        .expect("valid trust");
        assert_eq!(
            document.get(canonical.to_string_lossy().as_ref()),
            Some(&serde_json::json!(false))
        );
    }

    #[test]
    fn pi_workspace_trust_can_be_disabled() {
        let root = tempfile::tempdir().expect("temp dir");
        let workspace = root.path().join("workspace");
        let agent_dir = root.path().join("pi-agent");
        std::fs::create_dir_all(&workspace).expect("workspace");
        let env = HashMap::from([
            (
                PI_CONFIG_DIR_ENV.to_string(),
                agent_dir.display().to_string(),
            ),
            (PI_TRUST_WORKSPACE_ENV.to_string(), "0".to_string()),
        ]);

        seed_pi_workspace_trust(&workspace, &env).expect("disabled seed");

        assert!(!agent_dir.join("trust.json").exists());
    }

    #[test]
    fn pi_workspace_trust_does_not_clobber_invalid_documents() {
        let root = tempfile::tempdir().expect("temp dir");
        let workspace = root.path().join("workspace");
        let agent_dir = root.path().join("pi-agent");
        std::fs::create_dir_all(&workspace).expect("workspace");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        let trust_path = agent_dir.join("trust.json");
        std::fs::write(&trust_path, b"not-json").expect("invalid trust");
        let env = HashMap::from([(
            PI_CONFIG_DIR_ENV.to_string(),
            agent_dir.display().to_string(),
        )]);

        assert!(seed_pi_workspace_trust(&workspace, &env).is_err());

        assert_eq!(std::fs::read(trust_path).expect("read trust"), b"not-json");
    }

    #[test]
    fn stderr_ring_buffer_keeps_recent_bytes() {
        let mut buffer = StderrRingBuffer::new(6);

        buffer.push(b"abc");
        buffer.push(b"defgh");

        assert_eq!(buffer.summary().as_deref(), Some("cdefgh"));
    }

    #[test]
    fn handshake_timeout_error_includes_recent_stderr_when_present() {
        let message =
            format_handshake_timeout_error(Duration::from_secs(3), Some("last line".to_string()));

        assert!(message.contains("3s"));
        assert!(message.contains("last line"));
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
}
