use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::{
        Arc,
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
        SessionConfigOption as AcpSessionConfigOption, SessionConfigSelectOption,
        SessionConfigSelectOptions, SessionId, SessionModeState, SessionNotification,
        SessionUpdate, TerminalId, TerminalOutputResponse, TextContent,
        WaitForTerminalExitResponse,
    },
};
use chrono::Utc;
use futures::StreamExt;
use tokio::{
    io::AsyncWriteExt,
    sync::{Mutex, RwLock, mpsc, oneshot},
};
use tokio_util::{
    compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt},
    io::ReaderStream,
};
use workspace_utils::{process::new_hidden_tokio_command, shell::refresh_process_path};

use crate::{
    AgentAutoApproveMode, AgentAvailableCommand, AgentConnectionId, AgentContentBlock, AgentError,
    AgentErrorEvent, AgentEvent, AgentPermissionId, AgentPermissionOption,
    AgentPermissionOptionKind, AgentPermissionRequest, AgentPermissionResponse,
    AgentPromptFinished, AgentPromptId, AgentResult, AgentSessionConfigChoice,
    AgentSessionConfigOption, AgentSessionId, AgentSessionMode, AgentTerminalCreateRequest,
    AgentTerminalEnvVar, AgentTerminalExit, AgentToolCall, AgentToolCallUpdate, AgentType,
    AgentUsage, CommandBuildInput, current_platform, decide_auto_permission_response,
    registry_entry,
    state::{AgentConnectionSnapshot, AgentConnectionStatus},
    terminal::agent_terminal_registry,
};

const DEFAULT_HANDSHAKE_TIMEOUT_SECS: u64 = 60;
const STDERR_RING_BUFFER_BYTES: usize = 8 * 1024;
const HANDSHAKE_TIMEOUT_ENV: &str = "VIBEX_ACP_SPAWN_HANDSHAKE_TIMEOUT_SECS";
const FULL_GATE_FIXTURE_PROMPT: &str = "__vibex_agent_full_gate_fixture__";
const PROXY_ENV_KEYS: [&str; 6] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
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

fn format_handshake_timeout_error(timeout: Duration, stderr: Option<String>) -> String {
    let seconds = timeout.as_secs().max(1);
    match stderr {
        Some(stderr) => {
            format!("ACP handshake timed out after {seconds}s. Recent stderr: {stderr}")
        }
        None => format!("ACP handshake timed out after {seconds}s. No stderr captured."),
    }
}

fn unsupported_session_load_reason() -> String {
    "Agent does not support session/load".to_string()
}

fn failed_session_load_reason(error: &acp::Error) -> String {
    format!("session/load failed: {error}")
}

#[derive(Debug, Clone)]
pub struct AgentConnectionLaunch {
    pub connection_id: AgentConnectionId,
    pub agent_type: AgentType,
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
    pub agent_type: AgentType,
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
        }
    }

    pub async fn register_connection(
        &self,
        launch: AgentConnectionLaunch,
    ) -> ManagedAgentConnectionSnapshot {
        let (cmd_tx, cmd_rx) = mpsc::channel::<AgentConnectionCommand>(32);
        let snapshot = ManagedAgentConnectionSnapshot {
            connection_id: launch.connection_id,
            agent_type: launch.agent_type,
            workspace_id: launch.workspace_id,
            working_dir: launch.working_dir,
            auto_approve_mode: launch.auto_approve_mode,
            env: launch.env,
        };
        let runner = AgentConnectionRunner::new(snapshot.clone(), self.event_tx.clone());

        if self.driver_enabled {
            tokio::spawn(async move {
                runner.run(cmd_rx).await;
            });
        } else {
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

        snapshot
    }

    pub async fn send_prompt(
        &self,
        connection_id: AgentConnectionId,
        session_id: AgentSessionId,
        prompt_id: AgentPromptId,
        blocks: Vec<AgentContentBlock>,
    ) -> AgentResult<()> {
        self.send_command(
            connection_id,
            AgentConnectionCommand::Prompt {
                session_id,
                prompt_id,
                blocks,
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
    pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
    auto_approve_mode: AgentAutoApproveMode,
}

#[derive(Debug)]
struct PendingPermission {
    permission_id: AgentPermissionId,
    session_id: AgentSessionId,
    tx: oneshot::Sender<AgentPermissionResponse>,
}

impl AgentConnectionRunner {
    fn new(
        snapshot: ManagedAgentConnectionSnapshot,
        event_tx: mpsc::UnboundedSender<AgentConnectionManagerEvent>,
    ) -> Self {
        let auto_approve_mode = snapshot.auto_approve_mode;
        Self {
            snapshot,
            event_tx,
            session_map: Arc::new(RwLock::new(HashMap::new())),
            pending_permissions: Arc::new(Mutex::new(HashMap::new())),
            auto_approve_mode,
        }
    }

    async fn run(self, cmd_rx: mpsc::Receiver<AgentConnectionCommand>) {
        if let Err(error) = self.run_acp(cmd_rx).await {
            let message = error.to_string();
            self.emit_connection_status(AgentConnectionStatus::Failed, Some(message.clone()));
            self.emit(
                None,
                None,
                AgentEvent::Error {
                    error: AgentErrorEvent { message, raw: None },
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

    async fn run_acp(&self, mut cmd_rx: mpsc::Receiver<AgentConnectionCommand>) -> AgentResult<()> {
        let _ = refresh_process_path().await;
        let entry = registry_entry(self.snapshot.agent_type);
        let command_parts = entry.distribution.command_parts(&CommandBuildInput {
            platform: current_platform(),
            binary_dir: None,
            prefer_system_uvx_command: true,
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
                        } => {
                            let acp_session_id = runner
                                .ensure_acp_session(&conn, &working_dir, session_id)
                                .await?;
                            runner
                                .run_prompt(
                                    &conn,
                                    acp_session_id,
                                    session_id,
                                    prompt_id,
                                    blocks,
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
                    self.emit_session_controls(session_id, response.modes, response.config_options);
                    return Ok(external_session_id);
                }
                Err(error) => {
                    self.emit_session_load_failed(session_id, failed_session_load_reason(&error));
                }
            }
        } else {
            self.emit_session_load_failed(session_id, unsupported_session_load_reason());
        }

        self.new_acp_session(conn, working_dir, session_id).await
    }

    async fn new_acp_session(
        &self,
        conn: &ConnectionTo<Agent>,
        working_dir: &Path,
        session_id: AgentSessionId,
    ) -> Result<String, acp::Error> {
        let response = conn
            .send_request(NewSessionRequest::new(working_dir.to_path_buf()))
            .block_task()
            .await?;
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
        self.emit_session_controls(session_id, response.modes, response.config_options);
        Ok(acp_session_id)
    }

    fn emit_session_controls(
        &self,
        session_id: AgentSessionId,
        modes: Option<SessionModeState>,
        config_options: Option<Vec<AcpSessionConfigOption>>,
    ) {
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

    fn emit_session_load_failed(&self, session_id: AgentSessionId, reason: String) {
        self.emit(
            Some(session_id),
            None,
            AgentEvent::SessionLoadFailed { reason },
        );
    }

    async fn run_prompt(
        &self,
        conn: &ConnectionTo<Agent>,
        acp_session_id: String,
        session_id: AgentSessionId,
        prompt_id: AgentPromptId,
        blocks: Vec<AgentContentBlock>,
        cmd_rx: &mut mpsc::Receiver<AgentConnectionCommand>,
    ) -> Result<(), acp::Error> {
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
                                        raw: error.data.clone(),
                                    },
                                },
                            );
                        }
                    }
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
                            return Ok(());
                        }
                        Some(AgentConnectionCommand::Disconnect) | None => {
                            self.cancel_pending_permissions(session_id).await;
                            conn.send_notification(CancelNotification::new(SessionId::new(acp_session_id.clone())))?;
                            return Ok(());
                        }
                        Some(AgentConnectionCommand::RespondPermission { permission_id, response }) => {
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

#[derive(Clone)]
struct AcpClientBridge {
    connection_id: AgentConnectionId,
    event_tx: mpsc::UnboundedSender<AgentConnectionManagerEvent>,
    session_map: Arc<RwLock<HashMap<AgentSessionId, String>>>,
    pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
    auto_approve_mode: AgentAutoApproveMode,
}

impl AcpClientBridge {
    fn new(
        connection_id: AgentConnectionId,
        event_tx: mpsc::UnboundedSender<AgentConnectionManagerEvent>,
        session_map: Arc<RwLock<HashMap<AgentSessionId, String>>>,
        pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
        auto_approve_mode: AgentAutoApproveMode,
    ) -> Self {
        Self {
            connection_id,
            event_tx,
            session_map,
            pending_permissions,
            auto_approve_mode,
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
        let session_id = self
            .agent_session_for_acp(args.session_id.0.to_string())
            .await
            .unwrap_or_default();
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
        let raw_notification = serde_json::to_value(&args).unwrap_or(serde_json::Value::Null);
        let session_id = self
            .agent_session_for_acp(args.session_id.0.to_string())
            .await;
        let event = match args.update {
            SessionUpdate::AgentMessageChunk(chunk) => Some(AgentEvent::MessageChunk {
                content: acp_content_to_agent(chunk.content),
            }),
            SessionUpdate::AgentThoughtChunk(chunk) => Some(AgentEvent::ThoughtChunk {
                content: acp_content_to_agent(chunk.content),
            }),
            SessionUpdate::ToolCall(tool_call) => Some(AgentEvent::ToolCall {
                tool_call: AgentToolCall {
                    id: tool_call.tool_call_id.0.to_string(),
                    title: tool_call.title,
                    kind: Some(format!("{:?}", tool_call.kind)),
                },
            }),
            SessionUpdate::ToolCallUpdate(update) => Some(AgentEvent::ToolCallUpdate {
                update: AgentToolCallUpdate {
                    id: update.tool_call_id.0.to_string(),
                    status: update.fields.status.map(|status| format!("{status:?}")),
                    content: update
                        .fields
                        .content
                        .and_then(|content| serde_json::to_string(&content).ok()),
                },
            }),
            SessionUpdate::Plan(plan) => Some(AgentEvent::RawAcpDiagnostic {
                raw: serde_json::to_value(plan).unwrap_or(serde_json::Value::Null),
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
        let terminal_id = agent_terminal_registry()
            .create_terminal(&AgentTerminalCreateRequest {
                session_id: self
                    .agent_session_for_acp(args.session_id.0.to_string())
                    .await
                    .unwrap_or_default(),
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

fn merged_agent_env(configured_env: &HashMap<String, String>) -> HashMap<String, String> {
    merge_agent_env(
        configured_env,
        std::env::vars().filter(|(key, _)| PROXY_ENV_KEYS.contains(&key.as_str())),
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

    #[tokio::test]
    async fn manager_registers_and_removes_connection() {
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let manager = AgentConnectionManager::new_with_driver(event_tx, false);
        let connection_id = AgentConnectionId::new();

        manager
            .register_connection(AgentConnectionLaunch {
                connection_id,
                agent_type: AgentType::Codex,
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
            )
            .await
            .unwrap_err();

        assert!(matches!(err, AgentError::ConnectionNotFound(_)));
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
                agent_type: AgentType::Codex,
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
    fn session_load_failure_reasons_cover_unsupported_and_failed_load() {
        assert_eq!(
            unsupported_session_load_reason(),
            "Agent does not support session/load"
        );
        assert!(
            failed_session_load_reason(&acp::Error::invalid_params())
                .contains("session/load failed")
        );
    }
}
