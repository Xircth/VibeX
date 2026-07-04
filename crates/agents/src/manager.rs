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
    Agent, ConnectionTo,
    schema::{
        AgentNotification, AgentRequest, AvailableCommand as AcpAvailableCommand,
        CancelNotification, ClientCapabilities, ClientResponse, ContentBlock,
        CreateTerminalResponse, ImageContent, Implementation, InitializeRequest,
        KillTerminalRequest, KillTerminalResponse, LoadSessionRequest, NewSessionRequest,
        PermissionOptionKind, PromptRequest, ProtocolVersion, ReleaseTerminalResponse,
        RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
        SelectedPermissionOutcome, SessionConfigKind,
        SessionConfigOption as AcpSessionConfigOption, SessionConfigOptionCategory,
        SessionConfigSelectOption, SessionConfigSelectOptions, SessionId, SessionModeId,
        SessionModeState, SessionNotification, SessionUpdate, SetSessionConfigOptionRequest,
        SetSessionModeRequest, TerminalId, TerminalOutputResponse, TextContent,
        WaitForTerminalExitResponse,
    },
};
use chrono::Utc;
use futures::StreamExt;
use serde::Serialize;
use tokio::{
    io::AsyncWriteExt,
    sync::{Mutex, RwLock, mpsc, oneshot},
    time::Instant,
};
use tokio_util::{
    compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt},
    io::ReaderStream,
};
use workspace_utils::{process::new_hidden_tokio_command, shell::refresh_process_path};

use crate::{
    AgentAutoApproveMode, AgentAvailableCommand, AgentConnectionId, AgentContentBlock, AgentError,
    AgentErrorEvent, AgentEvent, AgentPermissionId, AgentPermissionOption,
    AgentPermissionOptionKind, AgentPermissionRequest, AgentPermissionResponse, AgentPlan,
    AgentPromptFinished, AgentPromptId, AgentResult, AgentSessionConfigChoice,
    AgentSessionConfigOption, AgentSessionConfigOverride, AgentSessionId, AgentSessionMode,
    AgentTerminalCreateRequest, AgentTerminalEnvVar, AgentTerminalExit, AgentToolCall,
    AgentToolCallUpdate, AgentKind, AgentUsage, CommandBuildInput,
    conversation::SessionLoadFailureReason,
    current_platform, decide_auto_permission_response,
    delegation_inject::DelegationInjector,
    registry_entry,
    state::{AgentConnectionSnapshot, AgentConnectionStatus},
    terminal::agent_terminal_registry,
};

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

#[derive(Debug, Clone)]
pub struct AgentConnectionLaunch {
    pub connection_id: AgentConnectionId,
    pub agent_type: AgentKind,
    pub workspace_id: uuid::Uuid,
    pub working_dir: PathBuf,
    pub auto_approve_mode: AgentAutoApproveMode,
    pub env: HashMap<String, String>,
}

#[derive(Debug)]
pub enum AgentConnectionCommand {
    ResumeSession {
        session_id: AgentSessionId,
        external_session_id: String,
        result_tx: oneshot::Sender<AgentResult<String>>,
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
    RespondPermission {
        permission_id: String,
        response: AgentPermissionResponse,
    },
    Disconnect,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedAgentConnectionSnapshot {
    pub connection_id: AgentConnectionId,
    pub agent_type: AgentKind,
    pub workspace_id: uuid::Uuid,
    pub working_dir: PathBuf,
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
            agent_type: launch.agent_type,
            workspace_id: launch.workspace_id,
            working_dir: launch.working_dir,
            auto_approve_mode: launch.auto_approve_mode,
            env: launch.env,
        };
        let runner = AgentConnectionRunner::new(
            snapshot.clone(),
            self.event_tx.clone(),
            self.delegation_injector.get().cloned(),
        );

        if self.driver_enabled {
            tokio::spawn(async move {
                runner.run(cmd_rx, ready_tx).await;
            });
        } else {
            // The in-memory driver has no process to spawn / handshake — it's
            // ready the moment it's registered.
            let _ = ready_tx.send(Ok(()));
            tokio::spawn(async move {
                runner.run_in_memory(cmd_rx).await;
            });
        }

        self.connections.lock().await.insert(
            snapshot.connection_id,
            ManagedAgentConnection {
                snapshot: snapshot.clone(),
                cmd_tx,
            },
        );

        (snapshot, ready_rx)
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

    pub async fn resume_session(
        &self,
        connection_id: AgentConnectionId,
        session_id: AgentSessionId,
        external_session_id: impl Into<String>,
    ) -> AgentResult<String> {
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

    pub async fn disconnect(&self, connection_id: AgentConnectionId) -> AgentResult<()> {
        let connection = self.connections.lock().await.remove(&connection_id);
        let Some(connection) = connection else {
            return Err(AgentError::ConnectionNotFound(connection_id.to_string()));
        };

        connection
            .cmd_tx
            .send(AgentConnectionCommand::Disconnect)
            .await
            .map_err(|_| AgentError::Runtime("agent connection command channel closed".into()))
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
    pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
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
}

#[derive(Debug, Clone, Default)]
struct SessionControlState {
    modes: Option<SessionModeState>,
    config_options: Vec<AcpSessionConfigOption>,
}

#[derive(Debug)]
struct PendingPermission {
    permission_id: AgentPermissionId,
    session_id: AgentSessionId,
    tx: oneshot::Sender<AgentPermissionResponse>,
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
            pending_permissions: Arc::new(Mutex::new(HashMap::new())),
            auto_approve_mode,
            delegation_injector,
            stream_dedup: Arc::new(Mutex::new(HashMap::new())),
            active_prompt: Arc::new(Mutex::new(None)),
            last_activity: Arc::new(Mutex::new(Instant::now())),
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
                let _ = tx.send(Err(AgentError::Runtime(message.clone())));
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
                AgentConnectionCommand::ResumeSession {
                    external_session_id,
                    result_tx,
                    ..
                } => {
                    let _ = result_tx.send(Ok(external_session_id));
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
                AgentConnectionCommand::RespondPermission {
                    permission_id,
                    response,
                } => {
                    self.respond_pending_permission(&permission_id, response)
                        .await
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
                    value: Some(serde_json::json!("fixture-model")),
                    choices: vec![AgentSessionConfigChoice {
                        value: serde_json::json!("fixture-model"),
                        label: "Fixture Model".to_string(),
                        description: None,
                    }],
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

        if let Some(response) = decide_auto_permission_response(self.auto_approve_mode, &request) {
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
        let _ = refresh_process_path().await;
        let entry = registry_entry(self.snapshot.agent_type);
        let command_parts = entry.distribution.command_parts(&CommandBuildInput {
            platform: current_platform(),
            binary_dir: None,
            prefer_system_uvx_command: false,
        })?;

        let mut command =
            new_hidden_tokio_command(PathBuf::from(&command_parts.program), &command_parts.args);
        command
            .kill_on_drop(true)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .current_dir(&self.snapshot.working_dir);

        for (key, value) in merged_agent_env(&self.snapshot.env) {
            command.env(key, value);
        }
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

        let mut child = command
            .spawn()
            .map_err(|error| AgentError::Runtime(format!("failed to spawn ACP agent: {error}")))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AgentError::Runtime("ACP child missing stdout".to_string()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AgentError::Runtime("ACP child missing stdin".to_string()))?;
        let stderr = child.stderr.take();

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
            self.event_tx.clone(),
            Arc::clone(&self.session_map),
            Arc::clone(&self.pending_permissions),
            self.auto_approve_mode,
            Arc::clone(&self.stream_dedup),
            Arc::clone(&self.last_activity),
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
                let initialize = conn
                    .send_request(
                        InitializeRequest::new(ProtocolVersion::LATEST)
                            .client_capabilities(ClientCapabilities::new().terminal(true))
                            .client_info(Implementation::new("vibex", env!("CARGO_PKG_VERSION"))),
                    )
                    .block_task();
                let initialize_response =
                    match tokio::time::timeout(handshake_timeout_duration, initialize).await {
                        Ok(result) => result?,
                        Err(_) => {
                            handshake_timed_out_for_connection.store(true, Ordering::SeqCst);
                            return Err(acp::Error::internal_error());
                        }
                    };
                let supports_load_session = initialize_response.agent_capabilities.load_session;
                // Handshake succeeded — the connection is now genuinely reachable.
                // Signal readiness so `connect` can mark it Ready. A failure before
                // this point leaves the sender for `run` to forward the real error.
                if let Some(tx) = ready_tx.lock().await.take() {
                    let _ = tx.send(Ok(()));
                }

                while let Some(command) = cmd_rx.recv().await {
                    match command {
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
                                    supports_load_session,
                                )
                                .await
                                .map_err(|error| {
                                    AgentError::Runtime(format!(
                                        "ACP session resume failed: {error}"
                                    ))
                                });
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
                                .ensure_acp_session(&conn, &working_dir, session_id)
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
                        AgentConnectionCommand::Disconnect => break,
                    }
                }

                Ok::<(), acp::Error>(())
            })
            .await;

        let _ = child.kill().await;
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
    ) -> Result<String, acp::Error> {
        if let Some(existing) = self.session_map.read().await.get(&session_id).cloned() {
            return Ok(existing);
        }

        self.new_acp_session(conn, working_dir, session_id).await
    }

    async fn load_or_new_acp_session(
        &self,
        conn: &ConnectionTo<Agent>,
        working_dir: &Path,
        session_id: AgentSessionId,
        external_session_id: String,
        supports_load_session: bool,
    ) -> Result<String, acp::Error> {
        if let Some(existing) = self.session_map.read().await.get(&session_id).cloned() {
            return Ok(existing);
        }

        if supports_load_session {
            let load_result = conn
                .send_request(LoadSessionRequest::new(
                    SessionId::new(external_session_id.clone()),
                    working_dir.to_path_buf(),
                ))
                .block_task()
                .await;
            match load_result {
                Ok(response) => {
                    self.session_map
                        .write()
                        .await
                        .insert(session_id, external_session_id.clone());
                    self.emit_session_controls(session_id, response.modes, response.config_options)
                        .await;
                    return Ok(external_session_id);
                }
                Err(error) => {
                    self.emit_session_load_failed(session_id, classify_session_load_error(&error));
                }
            }
        } else {
            self.emit_session_load_failed(session_id, SessionLoadFailureReason::Unsupported);
        }

        self.new_acp_session(conn, working_dir, session_id).await
    }

    async fn new_acp_session(
        &self,
        conn: &ConnectionTo<Agent>,
        working_dir: &Path,
        session_id: AgentSessionId,
    ) -> Result<String, acp::Error> {
        let mut request = NewSessionRequest::new(working_dir.to_path_buf());
        // Splice in the delegation companion (so the agent's LLM gets the
        // delegate_to_agent tools) when the host installed an injector.
        if let Some(injector) = &self.delegation_injector
            && let Some(server) = injector.companion(
                &self.snapshot.connection_id.0.to_string(),
                self.snapshot.agent_type,
                working_dir,
            )
        {
            request.mcp_servers.push(acp::schema::McpServer::Stdio(
                acp::schema::McpServerStdio::new(server.name, server.command).args(server.args),
            ));
        }
        let response = conn.send_request(request).block_task().await?;
        let acp_session_id = response.session_id.0.to_string();
        self.session_map
            .write()
            .await
            .insert(session_id, acp_session_id.clone());
        self.emit(
            Some(session_id),
            None,
            AgentEvent::SessionLinked {
                acp_session_id: acp_session_id.clone(),
                agent_type: self.snapshot.agent_type,
            },
        );
        self.emit_session_controls(session_id, response.modes, response.config_options)
            .await;
        Ok(acp_session_id)
    }

    async fn emit_session_controls(
        &self,
        session_id: AgentSessionId,
        modes: Option<SessionModeState>,
        config_options: Option<Vec<AcpSessionConfigOption>>,
    ) {
        {
            let mut controls = self.session_controls.write().await;
            let entry = controls.entry(session_id).or_default();
            if let Some(modes) = modes.clone() {
                entry.modes = Some(modes);
            }
            if let Some(options) = config_options.clone() {
                entry.config_options = options;
            }
        }

        if let Some(modes) = modes {
            let (modes, current) = agent_session_modes_from_acp(modes);
            self.emit(
                Some(session_id),
                None,
                AgentEvent::SessionModes { modes, current },
            );
        }

        if let Some(options) = config_options {
            self.emit(
                Some(session_id),
                None,
                AgentEvent::SessionConfigOptions {
                    options: agent_session_config_options_from_acp(options),
                },
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
            self.apply_mode_override(conn, acp_session_id, session_id, mode)
                .await?;
        }

        for override_item in config_overrides {
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

    async fn apply_mode_override(
        &self,
        conn: &ConnectionTo<Agent>,
        acp_session_id: &str,
        session_id: AgentSessionId,
        requested_mode: &str,
    ) -> Result<(), acp::Error> {
        let modes = self
            .session_controls
            .read()
            .await
            .get(&session_id)
            .and_then(|controls| controls.modes.clone());
        let Some(modes) = modes else {
            self.emit_override_diagnostic(session_id, "mode_controls_missing", requested_mode);
            return Ok(());
        };
        let Some(mode_id) = find_matching_mode_id(&modes, requested_mode) else {
            self.emit_override_diagnostic(session_id, "mode_not_found", requested_mode);
            return Ok(());
        };
        let mode_id = mode_id.to_string();
        if modes.current_mode_id.0.as_ref() == mode_id {
            return Ok(());
        }

        conn.send_request(SetSessionModeRequest::new(
            SessionId::new(acp_session_id.to_string()),
            mode_id.clone(),
        ))
        .block_task()
        .await?;
        self.session_controls
            .write()
            .await
            .entry(session_id)
            .or_default()
            .modes
            .get_or_insert(modes)
            .current_mode_id = SessionModeId::new(mode_id.clone());
        self.emit(Some(session_id), None, AgentEvent::ModeChanged { mode_id });
        Ok(())
    }

    async fn apply_config_override(
        &self,
        conn: &ConnectionTo<Agent>,
        acp_session_id: &str,
        session_id: AgentSessionId,
        key: &str,
        value: &str,
    ) -> Result<(), acp::Error> {
        let config_options = self
            .session_controls
            .read()
            .await
            .get(&session_id)
            .map(|controls| controls.config_options.clone())
            .unwrap_or_default();
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

        let response = conn
            .send_request(SetSessionConfigOptionRequest::new(
                SessionId::new(acp_session_id.to_string()),
                selection.config_id.clone(),
                selection.value_id.as_str(),
            ))
            .block_task()
            .await?;
        let mapped_options = agent_session_config_options_from_acp(response.config_options.clone());
        self.session_controls
            .write()
            .await
            .entry(session_id)
            .or_default()
            .config_options = response.config_options;
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
                value: serde_json::json!(selection.value_id),
            },
        );
        Ok(())
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
                    self.cancel_pending_permissions(session_id).await;
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
                // decision is pending (that wait produces no activity).
                _ = tokio::time::sleep(Duration::from_secs(2)) => {
                    if self.has_pending_permission_for(session_id).await {
                        continue;
                    }
                    if self.last_activity.lock().await.elapsed() < idle_timeout {
                        continue;
                    }
                    self.cancel_pending_permissions(session_id).await;
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
                            self.cancel_pending_permissions(session_id).await;
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
                        Some(AgentConnectionCommand::Disconnect) | None => {
                            // The connection is going away mid-turn. Fail the turn
                            // so it doesn't hang at "生成中"; clear the cursor so
                            // run()'s fallback doesn't double-emit.
                            self.cancel_pending_permissions(session_id).await;
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

    async fn cancel_pending_permissions(&self, session_id: AgentSessionId) {
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
                    agent_type: self.snapshot.agent_type,
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
    }
    if !state.text.is_empty() && state.text == text {
        // Trailing full snapshot: the run is complete, so reset — the next chunk
        // of the same kind starts a new message instead of appending to this one.
        state.active = None;
        return false;
    }
    state.text.push_str(text);
    true
}

#[derive(Clone)]
struct AcpClientBridge {
    connection_id: AgentConnectionId,
    event_tx: mpsc::UnboundedSender<AgentConnectionManagerEvent>,
    session_map: Arc<RwLock<HashMap<AgentSessionId, String>>>,
    pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
    auto_approve_mode: AgentAutoApproveMode,
    // Shared with the owning `AgentConnectionRunner` so a turn boundary can reset
    // it; keyed by ACP session id.
    stream_dedup: Arc<Mutex<HashMap<String, StreamDedupState>>>,
    // Shared idle-watchdog clock: every session notification refreshes it so the
    // prompt watchdog only fires on a genuinely silent (hung) agent.
    last_activity: Arc<Mutex<Instant>>,
}

impl AcpClientBridge {
    fn new(
        connection_id: AgentConnectionId,
        event_tx: mpsc::UnboundedSender<AgentConnectionManagerEvent>,
        session_map: Arc<RwLock<HashMap<AgentSessionId, String>>>,
        pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
        auto_approve_mode: AgentAutoApproveMode,
        stream_dedup: Arc<Mutex<HashMap<String, StreamDedupState>>>,
        last_activity: Arc<Mutex<Instant>>,
    ) -> Self {
        Self {
            connection_id,
            event_tx,
            session_map,
            pending_permissions,
            auto_approve_mode,
            stream_dedup,
            last_activity,
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
                    let exit_status = agent_client_protocol::schema::TerminalExitStatus::new()
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
                let mut exit_status = agent_client_protocol::schema::TerminalExitStatus::new();
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
            AgentRequest::ReadTextFileRequest(_)
            | AgentRequest::WriteTextFileRequest(_)
            | AgentRequest::ExtMethodRequest(_) => Err(acp::Error::method_not_found()),
            _ => Err(acp::Error::method_not_found()),
        }
    }

    async fn handle_agent_notification(
        &self,
        notification: AgentNotification,
    ) -> Result<(), acp::Error> {
        match notification {
            AgentNotification::SessionNotification(args) => self.session_notification(args).await,
            AgentNotification::ExtNotification(_) => Ok(()),
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

        if let Some(response) = decide_auto_permission_response(self.auto_approve_mode, &request) {
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

    async fn session_notification(&self, args: SessionNotification) -> Result<(), acp::Error> {
        // Any agent activity (message/thought/tool/plan/usage/mode update) keeps
        // the in-flight prompt alive for the idle watchdog in `run_prompt`.
        *self.last_activity.lock().await = Instant::now();
        let raw_notification = serde_json::to_value(&args).unwrap_or(serde_json::Value::Null);
        let acp_session_id = args.session_id.0.to_string();
        let session_id = self.agent_session_for_acp(acp_session_id.clone()).await;
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
            SessionUpdate::ToolCall(tool_call) => Some(AgentEvent::ToolCall {
                tool_call: AgentToolCall {
                    id: tool_call.tool_call_id.0.to_string(),
                    title: tool_call.title,
                    kind: Some(acp_enum_label(&tool_call.kind)),
                    input_preview: tool_call
                        .raw_input
                        .and_then(|input| serde_json::to_string(&input).ok()),
                },
            }),
            SessionUpdate::ToolCallUpdate(update) => Some(AgentEvent::ToolCallUpdate {
                update: AgentToolCallUpdate {
                    id: update.tool_call_id.0.to_string(),
                    status: update.fields.status.as_ref().map(acp_enum_label),
                    content: update
                        .fields
                        .raw_output
                        .as_ref()
                        .and_then(|output| serde_json::to_string(output).ok())
                        .or_else(|| {
                            update
                                .fields
                                .content
                                .as_ref()
                                .and_then(|content| serde_json::to_string(content).ok())
                        }),
                },
            }),
            SessionUpdate::Plan(plan) => Some(AgentEvent::Plan {
                plan: AgentPlan {
                    entries: plan
                        .entries
                        .into_iter()
                        .map(|entry| entry.content)
                        .collect(),
                },
            }),
            SessionUpdate::AvailableCommandsUpdate(update) => Some(AgentEvent::AvailableCommands {
                commands: agent_available_commands_from_acp(update.available_commands),
            }),
            SessionUpdate::CurrentModeUpdate(update) => Some(AgentEvent::ModeChanged {
                mode_id: update.current_mode_id.0.to_string(),
            }),
            SessionUpdate::ConfigOptionUpdate(update) => Some(AgentEvent::SessionConfigOptions {
                options: agent_session_config_options_from_acp(update.config_options),
            }),
            SessionUpdate::UsageUpdate(update) => Some(AgentEvent::Usage {
                usage: AgentUsage {
                    used: update.used,
                    limit: Some(update.size),
                },
            }),
            _ => Some(AgentEvent::RawAcpDiagnostic {
                raw: raw_notification,
            }),
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
        args: agent_client_protocol::schema::CreateTerminalRequest,
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

fn parse_terminal_id(id: &TerminalId) -> Result<uuid::Uuid, acp::Error> {
    uuid::Uuid::parse_str(id.0.as_ref()).map_err(|_| acp::Error::invalid_params())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ConfigOverrideSelection {
    config_id: String,
    value_id: String,
    already_selected: bool,
}

fn non_empty_trimmed(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty()).then_some(value)
}

fn find_matching_mode_id<'a>(modes: &'a SessionModeState, requested_mode: &str) -> Option<&'a str> {
    let requested = normalize_config_token(requested_mode);
    modes
        .available_modes
        .iter()
        .find(|mode| {
            let id = normalize_config_token(mode.id.0.as_ref());
            let name = normalize_config_token(&mode.name);
            id == requested
                || name == requested
                || (requested.len() > 3 && id.contains(&requested))
                || (requested.len() > 3 && name.contains(&requested))
        })
        .map(|mode| mode.id.0.as_ref())
}

fn find_config_override_selection(
    options: &[AcpSessionConfigOption],
    key: &str,
    value: &str,
) -> Option<ConfigOverrideSelection> {
    for option in options {
        if !config_option_matches(option, key) {
            continue;
        }
        let SessionConfigKind::Select(select) = &option.kind else {
            continue;
        };
        if let Some(choice) = find_select_choice(select, key, value) {
            return Some(ConfigOverrideSelection {
                config_id: option.id.0.to_string(),
                value_id: choice.value.0.to_string(),
                already_selected: select.current_value == choice.value,
            });
        }
    }
    None
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
    select: &'a agent_client_protocol::schema::SessionConfigSelect,
    key: &str,
    value: &str,
) -> Option<&'a SessionConfigSelectOption> {
    let aliases = config_value_aliases(key, value);
    match &select.options {
        SessionConfigSelectOptions::Ungrouped(options) => options
            .iter()
            .find(|option| select_choice_matches(option, &aliases)),
        SessionConfigSelectOptions::Grouped(groups) => groups
            .iter()
            .flat_map(|group| group.options.iter())
            .find(|option| select_choice_matches(option, &aliases)),
        #[allow(unreachable_patterns)]
        _ => None,
    }
}

fn select_choice_matches(option: &SessionConfigSelectOption, aliases: &[String]) -> bool {
    let mut values = vec![
        normalize_config_token(option.value.0.as_ref()),
        normalize_config_token(&option.name),
    ];
    if let Some(description) = &option.description {
        values.push(normalize_config_token(description));
    }

    values.iter().any(|value| {
        aliases.iter().any(|alias| {
            if value == alias {
                return true;
            }
            let meaningful_alias = alias.len() > 3;
            let meaningful_value = value.len() > 3;
            (meaningful_alias && value.contains(alias))
                || (meaningful_value && alias.contains(value))
        })
    })
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
        AgentContentBlock::Resource { uri, .. } => ContentBlock::Text(TextContent::new(uri)),
    }
}

fn acp_content_to_agent(block: ContentBlock) -> AgentContentBlock {
    match block {
        ContentBlock::Text(text) => AgentContentBlock::Text { text: text.text },
        ContentBlock::Image(image) => AgentContentBlock::Image {
            data: image.data,
            mime_type: image.mime_type,
            uri: image.uri,
        },
        #[allow(unreachable_patterns)]
        other => AgentContentBlock::Text {
            text: serde_json::to_string(&other).unwrap_or_default(),
        },
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

fn agent_session_modes_from_acp(
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

fn agent_session_config_options_from_acp(
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
        #[allow(unreachable_patterns)]
        _ => (None, Vec::new()),
    };

    AgentSessionConfigOption {
        key: option.id.0.to_string(),
        label: option.name,
        description: option.description,
        value,
        choices,
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

#[cfg(test)]
mod tests {
    use super::*;

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

    #[tokio::test]
    async fn manager_registers_and_removes_connection() {
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let manager = AgentConnectionManager::new_with_driver(event_tx, false);
        let connection_id = AgentConnectionId::new();

        manager
            .register_connection(AgentConnectionLaunch {
                connection_id,
                agent_type: AgentKind::Codex,
                workspace_id: uuid::Uuid::new_v4(),
                working_dir: PathBuf::from("C:/work"),
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
                agent_type: AgentKind::Codex,
                workspace_id: uuid::Uuid::new_v4(),
                working_dir: PathBuf::from("C:/work"),
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
                agent_type: AgentKind::Codex,
                workspace_id: uuid::Uuid::new_v4(),
                working_dir: PathBuf::from("C:/work"),
                auto_approve_mode: AgentAutoApproveMode::Off,
                env: HashMap::new(),
            })
            .await;

        let acp_session_id = manager
            .resume_session(connection_id, session_id, "external-session")
            .await
            .unwrap();

        assert_eq!(acp_session_id, "external-session");
    }

    #[test]
    fn maps_acp_session_modes_to_agent_payload() {
        let state = SessionModeState::new(
            "ask",
            vec![
                agent_client_protocol::schema::SessionMode::new("ask", "Ask")
                    .description(Some("Confirm before editing".to_string())),
                agent_client_protocol::schema::SessionMode::new("act", "Act"),
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

    #[test]
    fn maps_acp_session_config_options_to_agent_payload() {
        let options = vec![
            AcpSessionConfigOption::select(
                "model",
                "Model",
                "gpt-5",
                vec![
                    agent_client_protocol::schema::SessionConfigSelectOption::new("gpt-5", "GPT-5")
                        .description(Some("Balanced".to_string())),
                    agent_client_protocol::schema::SessionConfigSelectOption::new(
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
                    agent_client_protocol::schema::SessionConfigSelectGroup::new(
                        "effort",
                        "Effort",
                        vec![
                            agent_client_protocol::schema::SessionConfigSelectOption::new(
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
    fn matches_model_override_to_acp_model_category_choices() {
        let options = vec![
            AcpSessionConfigOption::select(
                "preferred-model",
                "Model",
                "claude-opus-4-8",
                vec![
                    agent_client_protocol::schema::SessionConfigSelectOption::new(
                        "claude-opus-4-8",
                        "Claude Opus 4.8",
                    ),
                    agent_client_protocol::schema::SessionConfigSelectOption::new(
                        "claude-sonnet-4-5",
                        "Claude Sonnet 4.5",
                    ),
                ],
            )
            .category(Some(SessionConfigOptionCategory::Model)),
        ];

        let selection = find_config_override_selection(&options, "model", "sonnet")
            .expect("sonnet should match ACP model choices");

        assert_eq!(selection.config_id, "preferred-model");
        assert_eq!(selection.value_id, "claude-sonnet-4-5");
        assert!(!selection.already_selected);
    }

    #[test]
    fn matches_permission_override_aliases_to_acp_choices() {
        let options = vec![AcpSessionConfigOption::select(
            "permission-mode",
            "Permissions",
            "ask",
            vec![
                agent_client_protocol::schema::SessionConfigSelectOption::new("ask", "Ask"),
                agent_client_protocol::schema::SessionConfigSelectOption::new(
                    "auto",
                    "Auto Approve",
                ),
            ],
        )];

        let selection = find_config_override_selection(&options, "permission_mode", "auto")
            .expect("auto should match permission choices");

        assert_eq!(selection.config_id, "permission-mode");
        assert_eq!(selection.value_id, "auto");
        assert!(!selection.already_selected);
    }

    #[test]
    fn maps_acp_available_commands_to_agent_payload() {
        let commands = vec![
            AcpAvailableCommand::new("compact", "Compact context").input(
                agent_client_protocol::schema::AvailableCommandInput::Unstructured(
                    agent_client_protocol::schema::UnstructuredCommandInput::new("focus"),
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
}
