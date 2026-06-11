use std::{collections::HashMap, path::PathBuf, sync::Arc};

use agent_client_protocol as acp;
use agent_client_protocol::{Agent, ConnectionTo};
use agent_client_protocol::schema::{
    AgentNotification, AgentRequest, CancelNotification, ClientCapabilities, ClientResponse,
    ContentBlock, CreateTerminalResponse, ErrorCode, Implementation, InitializeRequest,
    KillTerminalRequest, KillTerminalResponse, NewSessionRequest, PermissionOptionKind,
    PromptRequest, ProtocolVersion, ReleaseTerminalResponse, RequestPermissionOutcome,
    RequestPermissionRequest, RequestPermissionResponse, SelectedPermissionOutcome, SessionId,
    SessionNotification, SessionUpdate, TerminalId, TerminalOutputResponse, TextContent,
    WaitForTerminalExitResponse,
};
use futures::StreamExt;
use tokio::{
    io::AsyncWriteExt,
    sync::{Mutex, RwLock, mpsc},
};
use tokio_util::{
    compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt},
    io::ReaderStream,
};
use workspace_utils::{process::new_hidden_tokio_command, shell::refresh_process_path};

use crate::{
    AgentConnectionId, AgentContentBlock, AgentError, AgentErrorEvent, AgentEvent,
    AgentPromptFinished, AgentPromptId, AgentResult, AgentSessionId, AgentTerminalCreateRequest,
    AgentTerminalEnvVar, AgentTerminalExit, AgentToolCall, AgentToolCallUpdate, AgentType,
    AgentUsage, CommandBuildInput, current_platform, registry_entry,
    terminal::agent_terminal_registry,
};

#[derive(Debug, Clone)]
pub struct AgentConnectionLaunch {
    pub connection_id: AgentConnectionId,
    pub agent_type: AgentType,
    pub workspace_id: uuid::Uuid,
    pub working_dir: PathBuf,
}

#[derive(Debug, Clone, PartialEq)]
pub enum AgentConnectionCommand {
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
        option_id: String,
    },
    Disconnect,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedAgentConnectionSnapshot {
    pub connection_id: AgentConnectionId,
    pub agent_type: AgentType,
    pub workspace_id: uuid::Uuid,
    pub working_dir: PathBuf,
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

        cmd_tx
            .send(command)
            .await
            .map_err(|_| AgentError::Runtime("agent connection command channel closed".into()))
    }
}

#[derive(Debug, Clone)]
struct AgentConnectionRunner {
    snapshot: ManagedAgentConnectionSnapshot,
    event_tx: mpsc::UnboundedSender<AgentConnectionManagerEvent>,
    session_map: Arc<RwLock<HashMap<AgentSessionId, String>>>,
}

impl AgentConnectionRunner {
    fn new(
        snapshot: ManagedAgentConnectionSnapshot,
        event_tx: mpsc::UnboundedSender<AgentConnectionManagerEvent>,
    ) -> Self {
        Self {
            snapshot,
            event_tx,
            session_map: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    async fn run(self, cmd_rx: mpsc::Receiver<AgentConnectionCommand>) {
        if let Err(error) = self.run_acp(cmd_rx).await {
            self.emit(
                None,
                None,
                AgentEvent::Error {
                    error: AgentErrorEvent {
                        message: error.to_string(),
                        raw: None,
                    },
                },
            );
        }
    }

    async fn run_in_memory(self, mut cmd_rx: mpsc::Receiver<AgentConnectionCommand>) {
        while let Some(command) = cmd_rx.recv().await {
            match command {
                AgentConnectionCommand::Prompt {
                    session_id,
                    prompt_id,
                    blocks,
                } => {
                    let text = blocks
                        .into_iter()
                        .map(|block| match block {
                            AgentContentBlock::Text { text } => text,
                            AgentContentBlock::Image { uri }
                            | AgentContentBlock::Resource { uri, .. } => uri,
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
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
                AgentConnectionCommand::RespondPermission { .. } => {}
                AgentConnectionCommand::Disconnect => break,
            }
        }
    }

    async fn run_acp(
        &self,
        mut cmd_rx: mpsc::Receiver<AgentConnectionCommand>,
    ) -> AgentResult<()> {
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
            .current_dir(&self.snapshot.working_dir)
            .env("NPM_CONFIG_LOGLEVEL", "error")
            .env("NODE_NO_WARNINGS", "1");

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
        if let Some(stderr) = stderr {
            let runner_for_stderr = self.clone();
            tokio::spawn(async move {
                let mut stderr_stream = ReaderStream::new(stderr);
                while let Some(result) = stderr_stream.next().await {
                    match result {
                        Ok(bytes) => runner_for_stderr.emit(
                            None,
                            None,
                            AgentEvent::RawAcpDiagnostic {
                                raw: serde_json::json!({
                                    "kind": "stderr",
                                    "text": String::from_utf8_lossy(&bytes).to_string(),
                                }),
                            },
                        ),
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
        );
        let request_bridge = bridge.clone();
        let notification_bridge = bridge;
        let runner = self.clone();
        let working_dir = self.snapshot.working_dir.clone();

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
                conn.send_request(
                    InitializeRequest::new(ProtocolVersion::LATEST)
                        .client_capabilities(ClientCapabilities::new().terminal(true))
                        .client_info(Implementation::new("vibex", env!("CARGO_PKG_VERSION"))),
                )
                .block_task()
                .await?;

                while let Some(command) = cmd_rx.recv().await {
                    match command {
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
                                    cmd_rx,
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
                        AgentConnectionCommand::RespondPermission { .. } => {}
                        AgentConnectionCommand::Disconnect => break,
                    }
                }

                Ok::<(), acp::Error>(())
            })
            .await;

        let _ = child.kill().await;
        result.map_err(|error| AgentError::Runtime(format!("ACP connection failed: {error}")))
    }

    async fn ensure_acp_session(
        &self,
        conn: &ConnectionTo<Agent>,
        working_dir: &PathBuf,
        session_id: AgentSessionId,
    ) -> Result<String, acp::Error>
    {
        if let Some(existing) = self.session_map.read().await.get(&session_id).cloned() {
            return Ok(existing);
        }

        let response = conn
            .send_request(NewSessionRequest::new(working_dir.clone()))
            .block_task()
            .await?;
        let acp_session_id = response.session_id.0.to_string();
        self.session_map
            .write()
            .await
            .insert(session_id, acp_session_id.clone());
        Ok(acp_session_id)
    }

    async fn run_prompt(
        &self,
        conn: &ConnectionTo<Agent>,
        acp_session_id: String,
        session_id: AgentSessionId,
        prompt_id: AgentPromptId,
        blocks: Vec<AgentContentBlock>,
        cmd_rx: &mut mpsc::Receiver<AgentConnectionCommand>,
    ) -> Result<(), acp::Error>
    {
        let request = PromptRequest::new(
            SessionId::new(acp_session_id.clone()),
            blocks.into_iter().map(agent_block_to_acp).collect(),
        );
        let prompt_future = conn.send_request(request).block_task();
        tokio::pin!(prompt_future);

        loop {
            tokio::select! {
                result = &mut prompt_future => {
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
                            if error.code != ErrorCode::InternalError {
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
                    }
                    return Ok(());
                }
                command = cmd_rx.recv() => {
                    match command {
                        Some(AgentConnectionCommand::Cancel { session_id: cancel_session, prompt_id: cancel_prompt })
                            if cancel_session == session_id && cancel_prompt == prompt_id =>
                        {
                            conn.send_notification(CancelNotification::new(SessionId::new(acp_session_id.clone())))?;
                        }
                        Some(AgentConnectionCommand::Disconnect) | None => {
                            conn.send_notification(CancelNotification::new(SessionId::new(acp_session_id.clone())))?;
                            return Ok(());
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
}

#[derive(Clone)]
struct AcpClientBridge {
    connection_id: AgentConnectionId,
    event_tx: mpsc::UnboundedSender<AgentConnectionManagerEvent>,
    session_map: Arc<RwLock<HashMap<AgentSessionId, String>>>,
}

impl AcpClientBridge {
    fn new(
        connection_id: AgentConnectionId,
        event_tx: mpsc::UnboundedSender<AgentConnectionManagerEvent>,
        session_map: Arc<RwLock<HashMap<AgentSessionId, String>>>,
    ) -> Self {
        Self {
            connection_id,
            event_tx,
            session_map,
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
                    let exit_status =
                        agent_client_protocol::schema::TerminalExitStatus::new()
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
            AgentRequest::KillTerminalRequest(args) => {
                Ok(ClientResponse::KillTerminalResponse(self.kill_terminal(args).await?))
            }
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
        let outcome =
            selected_permission_outcome_for_kind(&args.options, PermissionOptionKind::AllowAlways)
                .or_else(|| {
                    selected_permission_outcome_for_kind(
                        &args.options,
                        PermissionOptionKind::AllowOnce,
                    )
                })
                .or_else(|| {
                    args.options.first().map(|option| {
                        RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                            option.option_id.clone(),
                        ))
                    })
                })
                .unwrap_or(RequestPermissionOutcome::Cancelled);
        Ok(RequestPermissionResponse::new(outcome))
    }

    async fn session_notification(&self, args: SessionNotification) -> Result<(), acp::Error> {
        let raw_notification = serde_json::to_value(&args).unwrap_or(serde_json::Value::Null);
        let session_id = self.agent_session_for_acp(args.session_id.0.to_string()).await;
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

fn selected_permission_outcome_for_kind(
    options: &[agent_client_protocol::schema::PermissionOption],
    kind: PermissionOptionKind,
) -> Option<RequestPermissionOutcome> {
    options
        .iter()
        .find(|option| option.kind == kind)
        .map(|option| {
            RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                option.option_id.clone(),
            ))
        })
}

fn parse_terminal_id(id: &TerminalId) -> Result<uuid::Uuid, acp::Error> {
    uuid::Uuid::parse_str(id.0.as_ref()).map_err(|_| acp::Error::invalid_params())
}

fn agent_block_to_acp(block: AgentContentBlock) -> ContentBlock {
    match block {
        AgentContentBlock::Text { text } => ContentBlock::Text(TextContent::new(text)),
        AgentContentBlock::Image { uri } | AgentContentBlock::Resource { uri, .. } => {
            ContentBlock::Text(TextContent::new(uri))
        }
    }
}

fn acp_content_to_agent(block: ContentBlock) -> AgentContentBlock {
    match block {
        ContentBlock::Text(text) => AgentContentBlock::Text { text: text.text },
        #[allow(unreachable_patterns)]
        other => AgentContentBlock::Text {
            text: serde_json::to_string(&other).unwrap_or_default(),
        },
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
}
