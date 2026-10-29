use super::*;

impl AgentConnectionRunner {
    pub(in crate::manager) async fn run_acp(
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
        let acp_program = crate::prefer_path_launch_program(&launch_lock.absolute_acp_program);
        if !crate::launch_program_available(&acp_program) {
            return Err(AgentError::Runtime(crate::missing_launch_program_error(
                &acp_program,
            )));
        }
        if !self.snapshot.working_dir.is_dir() {
            return Err(AgentError::Runtime(format!(
                "workspace working directory is missing: {}",
                self.snapshot.working_dir.display()
            )));
        }
        if self.snapshot.agent_id.as_str() == "pi" {
            if let Some(message) = crate::pi_trust::launch_preflight(&self.snapshot.env) {
                return Err(AgentError::NotInstalled(message));
            }
            let home = self
                .snapshot
                .env
                .get("HOME")
                .or_else(|| self.snapshot.env.get("USERPROFILE"))
                .map(PathBuf::from)
                .or_else(dirs::home_dir);
            if let Some(home) = home
                && let Some(message) = crate::pi_trust::launch_block(
                    &self.snapshot.working_dir,
                    &self.snapshot.env,
                    &home,
                    &crate::pi_trust::default_ack_path(),
                )
            {
                return Err(AgentError::PiProjectTrustRequired(message));
            }
        }
        let mut launch_program = acp_program.clone();
        let mut launch_args = launch_lock.args.clone();
        let mut zcode_launch_env = HashMap::new();
        if self.snapshot.agent_id.as_str() == "zcode" {
            // The install lock points at the npm shim. Official ZCode and a
            // Node 22 runtime that can load `node:sqlite` are resolved here,
            // then the shim is replaced by that Node and the bridge entry.
            let mut overrides = self.snapshot.env.clone();
            for (key, value) in &launch_lock.env {
                overrides.insert(key.clone(), value.clone());
            }
            match crate::zcode::prepare_launch(
                &acp_program,
                &launch_lock.args,
                &overrides,
                &self.snapshot.working_dir,
            )
            .await
            {
                Ok(prepared) => {
                    launch_program = prepared.program;
                    launch_args = prepared.args;
                    zcode_launch_env = prepared.env;
                }
                Err(error) => return Err(error.into_agent_error()),
            }
        }
        let mut command = new_hidden_tokio_command(&launch_program, &launch_args);
        command
            .kill_on_drop(true)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .current_dir(&self.snapshot.working_dir);

        let mut launch_env = merged_agent_env(&self.snapshot.env);
        for (key, value) in &launch_lock.env {
            launch_env.insert(key.clone(), value.clone());
        }
        crate::sanitize_runtime_executable_env(&self.snapshot.agent_id, &mut launch_env);
        for key in crate::bundled_adapter_runtime_env_keys(&self.snapshot.agent_id) {
            command.env_remove(*key);
            launch_env.remove(*key);
        }
        let runtime_env_key = crate::runtime_executable_env_key(&self.snapshot.agent_id);
        let drop_inherited_runtime_path = runtime_env_key.is_some_and(|key| {
            self.snapshot.env.contains_key(key) || launch_lock.env.contains_key(key)
        });
        if drop_inherited_runtime_path
            && let Some(key) = runtime_env_key
            && !launch_env.contains_key(key)
        {
            command.env_remove(key);
        }
        if self.snapshot.agent_id.as_str() == "pi" {
            for key in [PI_CONFIG_DIR_ENV, PI_SESSION_DIR_ENV] {
                match self
                    .snapshot
                    .env
                    .get(key)
                    .map(String::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    Some(value) => {
                        launch_env.insert(key.to_string(), value.to_string());
                    }
                    None => {
                        launch_env.remove(key);
                    }
                }
            }
            let requested = self
                .snapshot
                .env
                .get(PI_COMMAND_ENV)
                .map(String::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            if requested.is_none() {
                launch_env.remove(PI_COMMAND_ENV);
            }
            crate::bind_pi_acp_pi_command(&mut launch_env, requested);
        }
        // Resolved ZCode paths win over an inherited or lock-captured value.
        // `ZCODE_ACP_REMOTE` is forced off; a non-blank runtime choice is kept.
        for (key, value) in &zcode_launch_env {
            launch_env.insert(key.clone(), value.clone());
        }
        crate::prepare_and_bind_agent_runtime_temp(&self.snapshot.agent_id, &mut launch_env)
            .map_err(|error| {
                AgentError::Runtime(format!(
                    "could not create a writable temporary directory for the ACP agent: {error}"
                ))
            })?;
        for (key, value) in &launch_env {
            command.env(key, value);
        }
        // Pi runtime preferences are mutable user settings. They must win over
        // values captured by an older external-adoption lock; clearing a field
        // must also remove an inherited or legacy lock value.
        if self.snapshot.agent_id.as_str() == "pi" {
            for key in [PI_COMMAND_ENV, PI_CONFIG_DIR_ENV, PI_SESSION_DIR_ENV] {
                if launch_env
                    .get(key)
                    .map(String::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .is_none()
                {
                    command.env_remove(key);
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
        let (stdout_closed_tx, stdout_closed_rx) = oneshot::channel::<()>();
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut reader = BufReader::new(stdout);
            let mut line_buf = Vec::with_capacity(4096);
            loop {
                line_buf.clear();
                match reader.read_until(b'\n', &mut line_buf).await {
                    Ok(0) => break,
                    Ok(_) => {
                        if let Ok(raw_str) = std::str::from_utf8(&line_buf) {
                            let has_newline = raw_str.ends_with('\n');
                            let trimmed = raw_str.trim_end_matches(['\r', '\n']);
                            let cleaned = sanitize_incoming_jsonrpc_line(trimmed.to_string());
                            if cleaned.is_empty() {
                                continue;
                            }
                            if to_acp_writer.write_all(cleaned.as_bytes()).await.is_err() {
                                break;
                            }
                            if has_newline && to_acp_writer.write_all(b"\n").await.is_err() {
                                break;
                            }
                        } else if to_acp_writer.write_all(&line_buf).await.is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = stdout_closed_tx.send(());
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
            let stderr_tail = Arc::clone(&self.stderr_tail);
            tokio::spawn(async move {
                let mut stderr_stream = ReaderStream::new(stderr);
                while let Some(result) = stderr_stream.next().await {
                    match result {
                        Ok(bytes) => {
                            let text = String::from_utf8_lossy(&bytes);
                            stderr_tail.push(&text);
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
            Arc::clone(&self.auto_approve_mode),
            Arc::clone(&self.stream_dedup),
            Arc::clone(&self.last_activity),
            Arc::clone(&self.grok_subagent),
            Arc::clone(&self.grok_mcp),
            Arc::clone(&self.pending_session_id),
            self.snapshot.working_dir.clone(),
            self.snapshot.env.clone(),
            self.clone(),
        );
        let request_bridge = bridge.clone();
        let notification_bridge = bridge;
        let runner = self.clone();
        let handshake_timeout_duration = handshake_timeout();
        let handshake_timed_out = Arc::new(AtomicBool::new(false));
        let handshake_timed_out_for_connection = Arc::clone(&handshake_timed_out);

        let acp_run = acp::Client
            .builder()
            .name("VibeX")
            .on_receive_request(
                async move |request: AgentRequest, responder, cx| {
                    // agent-client-protocol awaits each handler inside the
                    // dispatch loop, so a blocking reverse-request answered
                    // inline freezes session/update and session/cancel.
                    // `terminal/wait_for_exit` can wait forever (dev servers).
                    // Grok `x.ai/ask_user_question` and `elicitation/create`
                    // wait for the user; answering them inline lets the agent
                    // time out and treat the question as cancelled.
                    // Codeg answers wait_for_exit from `cx.spawn`.
                    if acp_request_must_run_off_dispatch_loop(&request) {
                        let request_bridge = request_bridge.clone();
                        cx.spawn(async move {
                            let send = match request_bridge.handle_agent_request(request).await {
                                Ok(response) => serde_json::to_value(response)
                                    .map_err(acp::Error::into_internal_error)
                                    .and_then(|value| responder.respond(value)),
                                Err(error) => responder.respond_with_error(error),
                            };
                            if let Err(error) = send {
                                tracing::warn!(
                                    error = %error,
                                    "failed to answer off-dispatch ACP request"
                                );
                            }
                            Ok(())
                        })?;
                        return Ok(());
                    }
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
                runner
                    .run_acp_session(
                        conn,
                        &mut cmd_rx,
                        ready_tx,
                        handshake_timeout_duration,
                        handshake_timed_out_for_connection,
                    )
                    .await
            });

        let stop = wait_for_acp_or_process_death(acp_run, child.wait(), async {
            let _ = stdout_closed_rx.await;
        })
        .await;
        if !matches!(stop, AcpProcessStop::ChildExited(_)) {
            let _ = kill_process_group(&mut child).await;
        }
        if handshake_timed_out.load(Ordering::SeqCst) {
            let stderr = self.stderr_tail.summary();
            return Err(AgentError::Runtime(format_handshake_timeout_error(
                handshake_timeout_duration,
                stderr,
            )));
        }
        let prompt_in_flight = self.active_prompt.lock().await.is_some();
        let stderr = self.stderr_tail.summary();
        resolve_acp_process_stop(stop, prompt_in_flight, stderr)
    }
}
