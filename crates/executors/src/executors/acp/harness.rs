use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
};

use agent_client_protocol as proto;
use agent_client_protocol::schema::{
    AgentNotification, AgentRequest, CancelNotification, ClientCapabilities, ContentBlock,
    ErrorCode, ForkSessionRequest, Implementation, InitializeRequest, LoadSessionRequest,
    NewSessionRequest, PromptRequest, ProtocolVersion, SessionId, SetSessionModeRequest,
    SetSessionModelRequest, TextContent,
};
use command_group::AsyncGroupChild;
use futures::StreamExt;
use tokio::{io::AsyncWriteExt, process::Command, sync::mpsc};
use tokio_util::{
    compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt},
    io::ReaderStream,
    sync::CancellationToken,
};
use tracing::error;
use workspace_utils::{approvals::ApprovalStatus, stream_lines::LinesStreamExt};

use super::{AcpClient, SessionManager};
use crate::{
    approvals::ExecutorApprovalService,
    command::{CmdOverrides, CommandParts},
    env::ExecutionEnv,
    executors::{ExecutorError, ExecutorExitResult, SpawnedChild, acp::AcpEvent},
};

/// Reusable harness for ACP-based conns (Gemini, Qwen, etc.)
pub struct AcpAgentHarness {
    session_namespace: String,
    model: Option<String>,
    mode: Option<String>,
}

impl Default for AcpAgentHarness {
    fn default() -> Self {
        // Keep existing behavior for Gemini
        Self::new()
    }
}

fn drain_pre_prompt_events(event_rx: &mut mpsc::UnboundedReceiver<AcpEvent>) {
    let mut skipped = 0usize;

    while let Ok(event) = event_rx.try_recv() {
        match event {
            AcpEvent::SessionStart(_) => {}
            _ => skipped += 1,
        }
    }

    if skipped > 0 {
        tracing::debug!(
            skipped,
            "discarded ACP session replay events before sending prompt"
        );
    }
}

#[cfg(test)]
mod tests {
    use agent_client_protocol::schema::{ContentBlock, TextContent};

    use super::*;

    #[test]
    fn drain_pre_prompt_events_discards_session_replay_messages() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        tx.send(AcpEvent::Message(ContentBlock::Text(TextContent::new(
            "previous answer",
        ))))
        .unwrap();

        drain_pre_prompt_events(&mut rx);

        assert!(rx.try_recv().is_err());
    }
}

impl AcpAgentHarness {
    /// Create a harness with the default Gemini namespace
    pub fn new() -> Self {
        Self {
            session_namespace: "gemini_sessions".to_string(),
            model: None,
            mode: None,
        }
    }

    /// Create a harness with a custom session namespace (e.g. for Qwen)
    pub fn with_session_namespace(namespace: impl Into<String>) -> Self {
        Self {
            session_namespace: namespace.into(),
            model: None,
            mode: None,
        }
    }

    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = Some(model.into());
        self
    }

    pub fn with_mode(mut self, mode: impl Into<String>) -> Self {
        self.mode = Some(mode.into());
        self
    }

    pub async fn spawn_with_command(
        &self,
        current_dir: &Path,
        prompt: String,
        command_parts: CommandParts,
        env: &ExecutionEnv,
        cmd_overrides: &CmdOverrides,
        approvals: Option<std::sync::Arc<dyn ExecutorApprovalService>>,
    ) -> Result<SpawnedChild, ExecutorError> {
        let _ = workspace_utils::shell::refresh_process_path().await;
        let (program_path, args) = command_parts.into_resolved().await?;
        let mut command = Command::new(program_path);
        workspace_utils::process::configure_tokio_command_no_window(&mut command);
        command
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .current_dir(current_dir)
            .env("NPM_CONFIG_LOGLEVEL", "error")
            .env("NODE_NO_WARNINGS", "1")
            .args(&args);

        env.clone()
            .with_profile(cmd_overrides)
            .apply_to_command(&mut command);

        let mut child = workspace_utils::process::group_spawn_no_window(&mut command)?;

        let (exit_tx, exit_rx) = tokio::sync::oneshot::channel::<ExecutorExitResult>();
        let cancel = CancellationToken::new();

        Self::bootstrap_acp_connection(
            &mut child,
            current_dir.to_path_buf(),
            None,
            prompt,
            Some(exit_tx),
            self.session_namespace.clone(),
            self.model.clone(),
            self.mode.clone(),
            approvals,
            cancel.clone(),
            env.clone(),
        )
        .await?;

        Ok(SpawnedChild {
            child,
            exit_signal: Some(exit_rx),
            cancel: Some(cancel),
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn spawn_follow_up_with_command(
        &self,
        current_dir: &Path,
        prompt: String,
        session_id: &str,
        command_parts: CommandParts,
        env: &ExecutionEnv,
        cmd_overrides: &CmdOverrides,
        approvals: Option<std::sync::Arc<dyn ExecutorApprovalService>>,
    ) -> Result<SpawnedChild, ExecutorError> {
        let _ = workspace_utils::shell::refresh_process_path().await;
        let (program_path, args) = command_parts.into_resolved().await?;
        let mut command = Command::new(program_path);
        workspace_utils::process::configure_tokio_command_no_window(&mut command);
        command
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .current_dir(current_dir)
            .env("NPM_CONFIG_LOGLEVEL", "error")
            .env("NODE_NO_WARNINGS", "1")
            .args(&args);

        env.clone()
            .with_profile(cmd_overrides)
            .apply_to_command(&mut command);

        let mut child = workspace_utils::process::group_spawn_no_window(&mut command)?;

        let (exit_tx, exit_rx) = tokio::sync::oneshot::channel::<ExecutorExitResult>();
        let cancel = CancellationToken::new();

        Self::bootstrap_acp_connection(
            &mut child,
            current_dir.to_path_buf(),
            Some(session_id.to_string()),
            prompt,
            Some(exit_tx),
            self.session_namespace.clone(),
            self.model.clone(),
            self.mode.clone(),
            approvals,
            cancel.clone(),
            env.clone(),
        )
        .await?;

        Ok(SpawnedChild {
            child,
            exit_signal: Some(exit_rx),
            cancel: Some(cancel),
        })
    }

    #[allow(clippy::too_many_arguments)]
    async fn bootstrap_acp_connection(
        child: &mut AsyncGroupChild,
        cwd: PathBuf,
        existing_session: Option<String>,
        prompt: String,
        exit_signal: Option<tokio::sync::oneshot::Sender<ExecutorExitResult>>,
        session_namespace: String,
        model: Option<String>,
        mode: Option<String>,
        approvals: Option<std::sync::Arc<dyn ExecutorApprovalService>>,
        cancel: CancellationToken,
        execution_env: ExecutionEnv,
    ) -> Result<(), ExecutorError> {
        // Take child's stdio for ACP wiring
        let orig_stdout = child.inner().stdout.take().ok_or_else(|| {
            ExecutorError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "Child process has no stdout",
            ))
        })?;
        let orig_stdin = child.inner().stdin.take().ok_or_else(|| {
            ExecutorError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "Child process has no stdin",
            ))
        })?;

        // Create a fresh stdout pipe for logs
        let writer = crate::stdout_dup::create_stdout_pipe_writer(child)?;
        let shared_writer = Arc::new(tokio::sync::Mutex::new(writer));
        let (log_tx, mut log_rx) = mpsc::unbounded_channel::<String>();

        // Spawn log -> stdout writer task
        tokio::spawn(async move {
            while let Some(line) = log_rx.recv().await {
                let mut data = line.into_bytes();
                data.push(b'\n');
                let mut w = shared_writer.lock().await;
                let _ = w.write_all(&data).await;
            }
        });

        // ACP client STDIO
        let (mut to_acp_writer, acp_incoming_reader) = tokio::io::duplex(64 * 1024);
        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);

        // Process stdout -> ACP
        let stdout_shutdown_rx = shutdown_rx.clone();
        tokio::spawn(async move {
            let mut stdout_stream = ReaderStream::new(orig_stdout);
            while let Some(res) = stdout_stream.next().await {
                if *stdout_shutdown_rx.borrow() {
                    break;
                }
                match res {
                    Ok(data) => {
                        let _ = to_acp_writer.write_all(&data).await;
                    }
                    Err(_) => break,
                }
            }
        });

        // ACP crate expects futures::AsyncRead + AsyncWrite, use tokio compat to adapt tokio::io::AsyncRead + Write
        let (acp_out_writer, acp_out_reader) = tokio::io::duplex(64 * 1024);
        let outgoing = acp_out_writer.compat_write();
        let incoming = acp_incoming_reader.compat();

        // Process ACP -> stdin
        let stdin_shutdown_rx = shutdown_rx.clone();
        tokio::spawn(async move {
            let mut child_stdin = orig_stdin;
            let mut lines = ReaderStream::new(acp_out_reader)
                .map(|res| res.map(|bytes| String::from_utf8_lossy(&bytes).into_owned()))
                .lines();
            while let Some(result) = lines.next().await {
                if *stdin_shutdown_rx.borrow() {
                    break;
                }
                match result {
                    Ok(line) => {
                        // Use \r\n on Windows for compatibility with buggy ACP implementations
                        const LINE_ENDING: &str = if cfg!(windows) { "\r\n" } else { "\n" };
                        let line = line + LINE_ENDING;
                        if let Err(err) = child_stdin.write_all(line.as_bytes()).await {
                            tracing::debug!("Failed to write to child stdin {err}");
                            break;
                        }
                        let _ = child_stdin.flush().await;
                    }
                    Err(err) => {
                        tracing::debug!("ACP stdin line error {err}");
                        break;
                    }
                }
            }
        });

        let mut exit_signal_tx = exit_signal;

        // Run ACP client in a LocalSet
        tokio::task::spawn_blocking(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("build runtime");

            rt.block_on(async move {
                let local = tokio::task::LocalSet::new();
                local
                    .run_until(async move {
                        // Create event and raw channels
                        // Typed events available for future use; raw lines forwarded and persisted
                        let (event_tx, mut event_rx) =
                            mpsc::unbounded_channel::<crate::executors::acp::AcpEvent>();

                        // Create session manager
                        let session_manager = match SessionManager::new(session_namespace) {
                            Ok(sm) => sm,
                            Err(e) => {
                                error!("Failed to create session manager: {}", e);
                                return;
                            }
                        };
                        let session_manager = std::sync::Arc::new(session_manager);

                        // Create ACP client with approvals support
                        let client =
                            AcpClient::new(event_tx.clone(), approvals.clone(), cancel.clone());
                        let client_feedback_handle = client.clone();
                        let client_commit_reminder_handle = client.clone();

                        client.record_user_prompt_event(&prompt);

                        let transport = proto::ByteStreams::new(outgoing, incoming);
                        let request_client = client.clone();
                        let notification_client = client.clone();
                        let shutdown_on_error = shutdown_tx.clone();

                        let connect_result = proto::Client
                            .builder()
                            .name("VibeX")
                            .on_receive_request(
                                async move |request: AgentRequest, responder, _cx| {
                                    let response =
                                        request_client.handle_agent_request(request).await?;
                                    let response = serde_json::to_value(response)
                                        .map_err(proto::Error::into_internal_error)?;
                                    responder.respond(response)
                                },
                                proto::on_receive_request!(),
                            )
                            .on_receive_notification(
                                async move |notification: AgentNotification, _cx| {
                                    notification_client
                                        .handle_agent_notification(notification)
                                        .await
                                },
                                proto::on_receive_notification!(),
                            )
                            .connect_with(transport, async move |conn| {
                                let initialize_response = conn
                                    .send_request(
                                        InitializeRequest::new(ProtocolVersion::LATEST)
                                            .client_capabilities(
                                                ClientCapabilities::new().terminal(true),
                                            )
                                            .client_info(Implementation::new(
                                                "vibex",
                                                env!("CARGO_PKG_VERSION"),
                                            )),
                                    )
                                    .block_task()
                                    .await?;

                                // Handle session creation/loading/forking
                                let (acp_session_id, display_session_id, prompt_to_send) =
                                    match existing_session {
                                        Some(existing) => {
                                            let agent_capabilities =
                                                &initialize_response.agent_capabilities;
                                            if agent_capabilities.load_session {
                                                let req = LoadSessionRequest::new(
                                                    SessionId::new(existing.clone()),
                                                    cwd.clone(),
                                                );

                                                match conn.send_request(req).block_task().await {
                                                    Ok(_) => (existing.clone(), existing, prompt),
                                                    Err(err) => {
                                                        error!("Failed to load session: {}", err);
                                                        return Err(err);
                                                    }
                                                }
                                            } else if agent_capabilities
                                                .session_capabilities
                                                .fork
                                                .is_some()
                                            {
                                                let req = ForkSessionRequest::new(
                                                    SessionId::new(existing.clone()),
                                                    cwd.clone(),
                                                );

                                                match conn.send_request(req).block_task().await {
                                                    Ok(resp) => {
                                                        let sid = resp.session_id.0.to_string();
                                                        (sid.clone(), sid, prompt)
                                                    }
                                                    Err(err) => {
                                                        error!("Failed to fork session: {}", err);
                                                        return Err(err);
                                                    }
                                                }
                                            } else {
                                                return Err(proto::Error::method_not_found().data(
                                                    "agent does not advertise session/fork or session/load",
                                                ));
                                            }
                                        }
                                        None => {
                                            match conn
                                                .send_request(NewSessionRequest::new(cwd.clone()))
                                                .block_task()
                                                .await
                                            {
                                                Ok(resp) => {
                                                    let sid = resp.session_id.0.to_string();
                                                    (sid.clone(), sid, prompt)
                                                }
                                                Err(err) => {
                                                    error!("Failed to create session: {}", err);
                                                    return Err(err);
                                                }
                                            }
                                        }
                                    };

                                // Emit session ID
                                let _ = log_tx.send(
                                    AcpEvent::SessionStart(display_session_id.clone()).to_string(),
                                );

                                if let Some(model) = model.clone() {
                                    match conn
                                        .send_request(SetSessionModelRequest::new(
                                            SessionId::new(acp_session_id.clone()),
                                            model,
                                        ))
                                        .block_task()
                                        .await
                                    {
                                        Ok(_) => {}
                                        Err(e) => error!("Failed to set session model: {}", e),
                                    }
                                }

                                if let Some(mode) = mode.clone() {
                                    match conn
                                        .send_request(SetSessionModeRequest::new(
                                            SessionId::new(acp_session_id.clone()),
                                            mode,
                                        ))
                                        .block_task()
                                        .await
                                    {
                                        Ok(_) => {}
                                        Err(e) => error!("Failed to set session mode: {}", e),
                                    }
                                }

                                // Save prompt to session
                                let _ = session_manager.append_raw_line(
                                    &display_session_id,
                                    &serde_json::to_string(
                                        &serde_json::json!({ "user": prompt_to_send }),
                                    )
                                    .unwrap_or_default(),
                                );

                                drain_pre_prompt_events(&mut event_rx);

                                // Start raw event forwarder and persistence after discarding
                                // load-session replay. Only events produced by this prompt belong
                                // to the new execution process log.
                                let app_tx_clone = log_tx.clone();
                                let sess_id_for_writer = display_session_id.clone();
                                let sm_for_writer = session_manager.clone();
                                let conn_for_cancel = conn.clone();
                                let acp_session_id_for_cancel = acp_session_id.clone();
                                tokio::task::spawn_local(async move {
                                    while let Some(event) = event_rx.recv().await {
                                        if let AcpEvent::ApprovalResponse(resp) = &event
                                            && let ApprovalStatus::Denied {
                                                reason: Some(reason),
                                            } = &resp.status
                                            && !reason.trim().is_empty()
                                        {
                                            let _ = conn_for_cancel.send_notification(
                                                CancelNotification::new(SessionId::new(
                                                    acp_session_id_for_cancel.clone(),
                                                )),
                                            );
                                        }

                                        let line = event.to_string();
                                        // Forward to stdout
                                        let _ = app_tx_clone.send(line.clone());
                                        // Persist to session file
                                        let _ = sm_for_writer
                                            .append_raw_line(&sess_id_for_writer, &line);
                                    }
                                });

                                // Build prompt request
                                let initial_req = PromptRequest::new(
                                    SessionId::new(acp_session_id.clone()),
                                    vec![ContentBlock::Text(TextContent::new(prompt_to_send))],
                                );

                                let mut current_req = Some(initial_req);

                                while let Some(req) = current_req.take() {
                                    if cancel.is_cancelled() {
                                        tracing::debug!(
                                            "ACP executor cancelled, stopping prompt loop"
                                        );
                                        break;
                                    }

                                    tracing::trace!(?req, "sending ACP prompt request");
                                    // Send the prompt and await completion to obtain stop_reason
                                    let prompt_result = tokio::select! {
                                        _ = cancel.cancelled() => {
                                            tracing::debug!("ACP executor cancelled during prompt");
                                            break;
                                        }
                                        result = conn.send_request(req).block_task() => result,
                                    };

                                    match prompt_result {
                                        Ok(resp) => {
                                            // Emit done with stop_reason
                                            let stop_reason =
                                                serde_json::to_string(&resp.stop_reason)
                                                    .unwrap_or_default();
                                            let _ = log_tx
                                                .send(AcpEvent::Done(stop_reason).to_string());
                                        }
                                        Err(e) => {
                                            tracing::debug!("error {} {e} {:?}", e.code, e.data);
                                            if e.code == ErrorCode::InternalError
                                                && e.data.as_ref().is_some_and(|d| {
                                                    d == "server shut down unexpectedly"
                                                })
                                            {
                                                tracing::debug!("ACP server killed");
                                            } else {
                                                let _ = log_tx.send(
                                                    AcpEvent::Error(format!("{e}")).to_string(),
                                                );
                                            }
                                        }
                                    }

                                    // Flush any pending user feedback after finish
                                    let feedback = client_feedback_handle
                                        .drain_feedback()
                                        .await
                                        .join("\n")
                                        .trim()
                                        .to_string();
                                    if !feedback.is_empty() {
                                        tracing::trace!(
                                            ?feedback,
                                            "sending ACP follow-up feedback"
                                        );
                                        let session_id = SessionId::new(acp_session_id.clone());
                                        let feedback_req = PromptRequest::new(
                                            session_id.clone(),
                                            vec![ContentBlock::Text(TextContent::new(feedback))],
                                        );
                                        current_req = Some(feedback_req);
                                    }
                                }

                                if execution_env.commit_reminder && !cancel.is_cancelled() {
                                    let uncommitted_changes =
                                        execution_env.repo_context.check_uncommitted_changes().await;
                                    if !uncommitted_changes.trim().is_empty() {
                                        let reminder = format!(
                                            "{}\n\nUncommitted changes detected:\n```text\n{}\n```",
                                            execution_env.commit_reminder_prompt.trim(),
                                            uncommitted_changes.trim()
                                        );
                                        client_commit_reminder_handle
                                            .record_user_prompt_event(&reminder);
                                        let session_id = SessionId::new(acp_session_id.clone());
                                        let reminder_req = PromptRequest::new(
                                            session_id,
                                            vec![ContentBlock::Text(TextContent::new(reminder))],
                                        );
                                        let reminder_result = tokio::select! {
                                            _ = cancel.cancelled() => {
                                                tracing::debug!(
                                                    "ACP executor cancelled during commit reminder"
                                                );
                                                None
                                            }
                                            result = conn.send_request(reminder_req).block_task() => Some(result),
                                        };

                                        match reminder_result {
                                            Some(Ok(resp)) => {
                                                let stop_reason =
                                                    serde_json::to_string(&resp.stop_reason)
                                                        .unwrap_or_default();
                                                let _ = log_tx
                                                    .send(AcpEvent::Done(stop_reason).to_string());
                                            }
                                            Some(Err(e)) => {
                                                tracing::debug!(
                                                    "commit reminder prompt failed {} {e} {:?}",
                                                    e.code,
                                                    e.data
                                                );
                                                let _ = log_tx.send(AcpEvent::Error(format!("{e}")).to_string());
                                            }
                                            None => {}
                                        }
                                    }
                                }

                                // Notify container of completion
                                if let Some(tx) = exit_signal_tx.take() {
                                    let _ = tx.send(ExecutorExitResult::Success);
                                }

                                // Cancel session work
                                let _ = conn.send_notification(CancelNotification::new(
                                    SessionId::new(acp_session_id),
                                ));

                                // Cleanup
                                let _ = shutdown_tx.send(true);
                                drop(log_tx);
                                Ok::<(), proto::Error>(())
                            })
                            .await;

                        if let Err(err) = connect_result {
                            error!("ACP connection failed: {err}");
                            let _ = shutdown_on_error.send(true);
                        }
                    })
                    .await;
            });
        });

        Ok(())
    }
}
