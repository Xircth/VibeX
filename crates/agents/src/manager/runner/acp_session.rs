use super::*;

impl AgentConnectionRunner {
    pub(in crate::manager) async fn run_acp_session(
        &self,
        conn: ConnectionTo<Agent>,
        cmd_rx: &mut mpsc::Receiver<AgentConnectionCommand>,
        ready_tx: Arc<Mutex<Option<oneshot::Sender<AgentResult<()>>>>>,
        handshake_timeout_duration: Duration,
        handshake_timed_out: Arc<AtomicBool>,
    ) -> Result<(), acp::Error> {
        let working_dir = self.snapshot.working_dir.clone();
        *self.live_conn.lock().await = Some(conn.clone());
        let client_capabilities = build_client_capabilities(&self.snapshot.agent_id);
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
                    handshake_timed_out.store(true, Ordering::SeqCst);
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
        self.neutral_goal_channel.store(
            crate::codex_goal::init_advertises_goal(initialize_response.meta.as_ref()),
            Ordering::SeqCst,
        );
        *self.goal_advertised_control.write().await =
            crate::codex_goal::goal_advertised_control(initialize_response.meta.as_ref());
        self.handshake_completed.store(true, Ordering::SeqCst);
        capability_snapshot.steering = crate::native_steering::synthesize_native_steering(
            &self.snapshot.agent_id,
            initialize_meta.as_ref(),
            initialize_response.agent_info.as_ref(),
        );
        if capability_snapshot.steering {
            capability_snapshot.delivery_channel = crate::conversation::DeliveryChannel::Native;
        }
        capability_snapshot.authentication = AcpAuthStatusAdapter::observe_if_advertised(
            &conn,
            &raw_capabilities,
            1,
            Duration::from_secs(AUTH_STATUS_TIMEOUT_SECS),
        )
        .await
        .map(Into::into);
        *self.capabilities.write().await = capability_snapshot.clone();
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
        // Ready ≠ bind: Prompt is still refused until session/new|resume.
        *self.status.lock().await = AgentConnectionStatus::Ready;
        if let Some(tx) = ready_tx.lock().await.take() {
            let _ = tx.send(Ok(()));
        }

        while let Some(command) = cmd_rx.recv().await {
            let session_bound = self
                .session_map
                .read()
                .await
                .values()
                .any(|id| crate::is_restorable_acp_session_id(id));
            if !session_bound
                && let AgentConnectionCommand::Prompt {
                    session_id,
                    prompt_id,
                    ..
                } = &command
            {
                crate::session_bind_metrics::record_prompt_unbound(session_id.0);
                self.fail_active_turn(*session_id, *prompt_id, AgentError::AcpSessionNotBound)
                    .await;
                continue;
            }
            match command {
                AgentConnectionCommand::PrepareSession {
                    session_id,
                    preferences,
                    result_tx,
                } => {
                    self.record_wants_prompt_suggestions(
                        session_id,
                        preferences.wants_prompt_suggestions,
                    )
                    .await;
                    self.store_preferred_controls(session_id, preferences).await;
                    let result = match self
                        .ensure_acp_session(&conn, &working_dir, session_id, companion_capabilities)
                        .await
                    {
                        Ok(acp_session_id) => {
                            let controls = self.session_controls_snapshot(session_id).await;
                            // `PrepareSession` is also called when the prepared
                            // session is adopted by the conversation service. Re-emit
                            // the authoritative state here so those events enter the
                            // now-persisted conversation stream instead of existing
                            // only during the create-dialog preview.
                            self.emit_controls_snapshot(session_id, &controls);
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
                    self.cancel_pending_interactions(session_id).await;
                    let acp_session_id = self.session_map.read().await.get(&session_id).cloned();
                    let result = if supports_close_session {
                        if let Some(acp_session_id) = acp_session_id.as_ref() {
                            conn.send_request(CloseSessionRequest::new(SessionId::new(
                                acp_session_id.clone(),
                            )))
                            .block_task()
                            .await
                            .map(|_| ())
                            .map_err(|error| {
                                AgentError::Runtime(format!("session/close failed: {error}"))
                            })
                        } else {
                            Ok(())
                        }
                    } else {
                        Ok(())
                    };
                    if result.is_ok() {
                        self.session_map.write().await.remove(&session_id);
                        self.session_controls.write().await.remove(&session_id);
                    }
                    let _ = result_tx.send(result);
                }
                AgentConnectionCommand::ResumeSession {
                    session_id,
                    external_session_id,
                    preferences,
                    result_tx,
                } => {
                    self.record_wants_prompt_suggestions(
                        session_id,
                        preferences.wants_prompt_suggestions,
                    )
                    .await;
                    self.store_preferred_controls(session_id, preferences).await;
                    let result = self
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
                        Ok((acp_session_id, strategy)) => Ok((
                            acp_session_id,
                            self.session_controls_snapshot(session_id).await,
                            strategy,
                        )),
                        Err(error) => Err(error),
                    };
                    let _ = result_tx.send(result);
                }
                AgentConnectionCommand::Prompt {
                    session_id,
                    prompt_id,
                    blocks,
                    display_blocks,
                    mode_override,
                    config_overrides,
                } => {
                    // Bind the turn before session/new so a crash during
                    // prepare still fails this prompt instead of hanging
                    // the conversation at "生成中".
                    *self.active_prompt.lock().await = Some((session_id, prompt_id));
                    self.store_preferred_controls(
                        session_id,
                        crate::SessionControlPreferences {
                            mode: mode_override.clone(),
                            config: config_overrides.clone(),
                            wants_prompt_suggestions: self
                                .wants_prompt_suggestions(session_id)
                                .await,
                        },
                    )
                    .await;
                    // Prompt must not call session/new. A Conversation
                    // already owns a thread; the host binds it with
                    // PrepareSession (first turn) or ResumeSession
                    // (follow-up). Creating a thread here forks Codex
                    // into a new session B while VibeX keeps writing A.
                    let acp_session_id = match self
                        .session_map
                        .read()
                        .await
                        .get(&session_id)
                        .cloned()
                        .filter(|id| crate::is_restorable_acp_session_id(id))
                    {
                        Some(acp_session_id) => acp_session_id,
                        None => {
                            crate::session_bind_metrics::record_prompt_unbound(session_id.0);
                            self.fail_active_turn(
                                session_id,
                                prompt_id,
                                AgentError::AcpSessionNotBound,
                            )
                            .await;
                            continue;
                        }
                    };
                    match self
                        .run_prompt(
                            &conn,
                            RunPromptRequest {
                                acp_session_id: acp_session_id.clone(),
                                session_id,
                                prompt_id,
                                blocks,
                                display_blocks,
                                mode_override,
                                config_overrides,
                            },
                            cmd_rx,
                        )
                        .await
                    {
                        Ok(RunPromptOutcome::Settled) => {}
                        Ok(RunPromptOutcome::RetireConnection) => {
                            // ADR-0071: an agent that does not ack cancel (or
                            // went silent) must not serve the next turn.
                            self.emit_connection_status(
                                AgentConnectionStatus::Failed,
                                Some(
                                    "agent session retired after cancel was not acknowledged"
                                        .to_string(),
                                ),
                                Some(session_id),
                            );
                            break;
                        }
                        Ok(RunPromptOutcome::Closed) => break,
                        Err(error) => {
                            // `run_prompt` already wrote the user prompt.
                            // Close that transcript turn before the error
                            // event, or a reopen shows an unfinished send.
                            self.record_turn_end(&acp_session_id, session_id, "error", 0, None)
                                .await;
                            self.fail_active_turn(
                                session_id,
                                prompt_id,
                                AgentError::Runtime(format!("ACP prompt drive failed: {error}")),
                            )
                            .await;
                        }
                    }
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
                    fork_point,
                    result_tx,
                } => {
                    let result = if supports_fork {
                        self.fork_acp_session(
                            &conn,
                            &working_dir,
                            session_id,
                            companion_capabilities,
                            fork_point,
                        )
                        .await
                        .map_err(|error| {
                            AgentError::Runtime(format!("ACP session fork failed: {error}"))
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
                            .send_request(ListSessionsRequest::new().cwd(cwd).cursor(cursor))
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
                    result_tx,
                } => {
                    self.emit(
                        Some(session_id),
                        Some(prompt_id),
                        AgentEvent::PromptFinished {
                            finished: AgentPromptFinished {
                                prompt_id,
                                stop_reason: Some("cancelled".to_string()),
                                usage: None,
                            },
                        },
                    );
                    let _ = result_tx.send(true);
                }
                AgentConnectionCommand::RespondPermission {
                    permission_id,
                    response,
                } => {
                    self.respond_pending_permission(&permission_id, response)
                        .await;
                }
                AgentConnectionCommand::RespondElicitation {
                    elicitation_id,
                    response,
                } => {
                    self.respond_pending_elicitation(&elicitation_id, response)
                        .await;
                }
                AgentConnectionCommand::SetSessionMode {
                    session_id,
                    mode_id,
                    result_tx,
                } => {
                    let result = self
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
                    let result = self
                        .set_live_session_config_option(&conn, session_id, &key, &value)
                        .await;
                    let _ = result_tx.send(result);
                }
                AgentConnectionCommand::GoalControl {
                    session_id,
                    action,
                    result_tx,
                } => {
                    let result = self
                        .execute_goal_control(&conn, session_id, &action, true)
                        .await;
                    let _ = result_tx.send(result);
                }
                AgentConnectionCommand::StopAsyncTask {
                    session_id,
                    task_id,
                    result_tx,
                } => {
                    let result = self
                        .execute_stop_async_task(&conn, session_id, &task_id)
                        .await;
                    let _ = result_tx.send(result);
                }
                AgentConnectionCommand::Disconnect => break,
            }
        }

        Ok::<(), acp::Error>(())
    }
}
