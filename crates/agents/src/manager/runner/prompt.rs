use super::*;

impl AgentConnectionRunner {
    // Cohesive prompt-execution context (connection + session/prompt ids + blocks +
    // overrides + command channel); bundling into a struct adds indirection without
    // value, matching how the rest of the codebase handles this lint.
    #[allow(clippy::too_many_arguments)]
    pub(in crate::manager) async fn run_prompt(
        &self,
        conn: &ConnectionTo<Agent>,
        request: RunPromptRequest,
        cmd_rx: &mut mpsc::Receiver<AgentConnectionCommand>,
    ) -> Result<RunPromptOutcome, acp::Error> {
        let RunPromptRequest {
            acp_session_id,
            session_id,
            prompt_id,
            blocks,
            display_blocks,
            mode_override,
            config_overrides,
        } = request;
        // Mark this prompt in flight and reset the idle clock. The cursor lets the
        // connection-death fallback in `run()` fail this exact turn; it is cleared
        // before every self-terminal `return` below so a terminal event is emitted
        // exactly once (never doubled, never dropped). A `?`-propagated error
        // (for example the cancel notification) deliberately leaves it set so
        // `run()` closes the turn.
        *self.active_prompt.lock().await = Some((session_id, prompt_id));
        *self.last_activity.lock().await = Instant::now();
        let cleared_suggestion =
            if let Some(stored) = self.session_controls.write().await.get_mut(&session_id) {
                stored.asserted_config_values.clear();
                stored.last_turn_usage = None;
                stored.prompt_suggestion.take().is_some()
            } else {
                false
            };
        if cleared_suggestion {
            self.emit(
                Some(session_id),
                Some(prompt_id),
                AgentEvent::PromptSuggestionUpdated { suggestion: None },
            );
        }
        let confirmed_mode = mode_override.clone();
        let confirmed_config = config_overrides.clone();
        let idle_timeout = prompt_idle_timeout();

        // Start each turn with a clean streaming accumulator so snapshot dedup
        // scopes to this turn and never accretes text across turns.
        self.stream_dedup.lock().await.remove(&acp_session_id);
        let wire_blocks: Vec<ContentBlock> = blocks.into_iter().map(agent_block_to_acp).collect();
        let recorded_blocks: Vec<ContentBlock> = display_blocks
            .map(|blocks| blocks.into_iter().map(agent_block_to_acp).collect())
            .unwrap_or_else(|| wire_blocks.clone());
        // The message is already accepted. Reopening a conversation reads the
        // transcript, so write the prompt before session overrides: a rejected
        // model (or any other override error) must not erase it.
        self.record_prompt(&acp_session_id, &recorded_blocks).await;
        if let Err(error) = self
            .apply_session_overrides(
                conn,
                &acp_session_id,
                session_id,
                mode_override,
                config_overrides,
            )
            .await
        {
            self.record_turn_end(&acp_session_id, session_id, "error", 0, None)
                .await;
            self.fail_active_turn(
                session_id,
                prompt_id,
                AgentError::Runtime(format!("ACP session overrides failed: {error}")),
            )
            .await;
            return Ok(RunPromptOutcome::Settled);
        }
        self.record_confirmed_controls(session_id, confirmed_mode.as_deref(), &confirmed_config)
            .await;
        let turn_started = Instant::now();
        let stderr_mark = self.stderr_tail.mark();
        let turn_probe = Arc::new(TurnOutputProbe::default());
        if let Ok(mut guard) = self.active_turn_probe.lock() {
            *guard = Some((session_id, Arc::clone(&turn_probe)));
        }
        let request = PromptRequest::new(SessionId::new(acp_session_id.clone()), wire_blocks);
        let prompt_future = conn.send_request(request).block_task();
        tokio::pin!(prompt_future);

        loop {
            tokio::select! {
                result = &mut prompt_future => {
                    if let Ok(mut guard) = self.active_turn_probe.lock() {
                        *guard = None;
                    }
                    // A turn that ends (normally or with an error) must release any
                    // permission still pending in the in-memory map; otherwise its
                    // oneshot sender leaks and the runtime/DB state diverge. The
                    // cancel/disconnect arms below already do this.
                    self.cancel_pending_interactions(session_id).await;
                    match result {
                        Ok(response) => {
                            let mut usage = response.usage.as_ref().map(agent_usage_from_end_turn);
                            if let Some(ref mut resolved_usage) = usage {
                                let mut controls = self.session_controls.write().await;
                                let state = controls.entry(session_id).or_default();
                                if resolved_usage.model.is_none() {
                                    resolved_usage.model =
                                        current_grok_model_id(&state.config_options)
                                            .or_else(|| state.last_model_id.clone());
                                }
                                state.merge_turn_usage(resolved_usage);
                                drop(controls);
                                self.emit(
                                    Some(session_id),
                                    Some(prompt_id),
                                    AgentEvent::Usage {
                                        usage: resolved_usage.clone(),
                                    },
                                );
                            }
                            let recorded_usage = self
                                .session_controls
                                .read()
                                .await
                                .get(&session_id)
                                .and_then(|state| state.last_turn_usage.clone())
                                .or_else(|| usage.clone());
                            let turn_failure = turn_failure_error_event(
                                &response,
                                &turn_probe,
                                &self.stderr_tail,
                                stderr_mark,
                            );
                            let stop_label = if turn_probe.adapter_turn_error().is_some() {
                                "error".to_string()
                            } else if turn_failure.is_some() {
                                finish_turn_reason(
                                    &response.stop_reason,
                                    turn_probe.has_output(),
                                    false,
                                )
                            } else {
                                acp_enum_label(&response.stop_reason)
                            };
                            self.record_turn_end(
                                &acp_session_id,
                                session_id,
                                &stop_label,
                                turn_started.elapsed().as_millis() as u64,
                                recorded_usage.as_ref(),
                            )
                            .await;
                            if let Some(error) = turn_failure {
                                if error.code.as_deref() == Some("agent_connection_lost") {
                                    self.session_map.write().await.remove(&session_id);
                                    self.session_controls.write().await.remove(&session_id);
                                    self.emit_connection_status(
                                        AgentConnectionStatus::Failed,
                                        Some(error.message.clone()),
                                        None,
                                    );
                                    self.emit(
                                        Some(session_id),
                                        Some(prompt_id),
                                        AgentEvent::Error { error },
                                    );
                                    *self.active_prompt.lock().await = None;
                                    return Ok(RunPromptOutcome::Closed);
                                }
                                self.emit(
                                    Some(session_id),
                                    Some(prompt_id),
                                    AgentEvent::Error { error },
                                );
                            }
                            self.emit(
                                Some(session_id),
                                Some(prompt_id),
                                AgentEvent::PromptFinished {
                                    finished: AgentPromptFinished {
                                        prompt_id,
                                        stop_reason: Some(format!("{:?}", response.stop_reason)),
                                        usage,
                                    },
                                },
                            );
                        }
                        Err(error) => {
                            let err_usage = crate::usage_from_error_data(error.data.as_ref());
                            if let Some(usage) = err_usage.clone() {
                                self.session_controls
                                    .write()
                                    .await
                                    .entry(session_id)
                                    .or_default()
                                    .merge_turn_usage(&usage);
                                self.emit(
                                    Some(session_id),
                                    Some(prompt_id),
                                    AgentEvent::Usage { usage },
                                );
                            }
                            let recorded_err_usage = self
                                .session_controls
                                .read()
                                .await
                                .get(&session_id)
                                .and_then(|state| state.last_turn_usage.clone())
                                .or(err_usage);
                            self.record_turn_end(
                                &acp_session_id,
                                session_id,
                                "error",
                                turn_started.elapsed().as_millis() as u64,
                                recorded_err_usage.as_ref(),
                            )
                            .await;
                            let error_event = format_acp_prompt_error(
                                &error,
                                &self.stderr_tail,
                                stderr_mark,
                            );
                            if error_event.code.as_deref() == Some("agent_connection_lost") {
                                self.session_map.write().await.remove(&session_id);
                                self.session_controls.write().await.remove(&session_id);
                                self.emit_connection_status(
                                    AgentConnectionStatus::Failed,
                                    Some(error_event.message.clone()),
                                    None,
                                );
                                self.emit(
                                    Some(session_id),
                                    Some(prompt_id),
                                    AgentEvent::Error { error: error_event },
                                );
                                *self.active_prompt.lock().await = None;
                                return Ok(RunPromptOutcome::Closed);
                            }
                            self.emit(
                                Some(session_id),
                                Some(prompt_id),
                                AgentEvent::Error { error: error_event },
                            );
                        }
                    }
                    *self.active_prompt.lock().await = None;
                    return Ok(RunPromptOutcome::Settled);
                }
                // Idle watchdog. Silent turns end instead of sitting on
                // "生成中". Permission, elicitation, and live terminals are
                // exempt; inbound ACP traffic refreshes `last_activity`.
                _ = async {
                    if idle_timeout.is_some() {
                        tokio::time::sleep(Duration::from_secs(2)).await;
                    } else {
                        std::future::pending::<()>().await;
                    }
                } => {
                    let Some(idle_timeout) = idle_timeout else {
                        continue;
                    };
                    if prompt_idle_watchdog_blocked(
                        self.has_pending_permission_for(session_id).await,
                        self.has_pending_elicitation_for(session_id).await,
                        self.has_running_terminal_for(session_id).await,
                    ) {
                        continue;
                    }
                    let elapsed = self.last_activity.lock().await.elapsed();
                    if elapsed < idle_timeout {
                        continue;
                    }
                    self.cancel_pending_interactions(session_id).await;
                    let _ = conn.send_notification(CancelNotification::new(SessionId::new(
                        acp_session_id.clone(),
                    )));
                    self.record_turn_end(
                        &acp_session_id,
                        session_id,
                        "idle_timeout",
                        turn_started.elapsed().as_millis() as u64,
                        None,
                    )
                    .await;
                    self.emit(
                        Some(session_id),
                        Some(prompt_id),
                        AgentEvent::Error {
                            error: AgentErrorEvent {
                                message: format!(
                                    "Agent stopped responding (idle timeout after {}s). The model may be unreachable — check your network/proxy or re-authenticate the agent.",
                                    elapsed.as_secs()
                                ),
                                code: Some("idle_timeout".to_string()),
                                raw: Some(serde_json::json!({
                                    "elapsed_secs": elapsed.as_secs(),
                                    "timeout_secs": idle_timeout.as_secs(),
                                })),
                            },
                        },
                    );
                    if let Ok(mut guard) = self.active_turn_probe.lock() {
                        *guard = None;
                    }
                    *self.active_prompt.lock().await = None;
                    return Ok(RunPromptOutcome::RetireConnection);
                }
                command = cmd_rx.recv() => {
                    match command {
                        Some(AgentConnectionCommand::Cancel {
                            session_id: cancel_session,
                            prompt_id: cancel_prompt,
                            result_tx,
                        }) if cancel_session == session_id && cancel_prompt == prompt_id => {
                            self.cancel_pending_interactions(session_id).await;
                            let mut extra_cancel_txs: Vec<oneshot::Sender<bool>> = Vec::new();
                            let acknowledged = if conn
                                .send_notification(CancelNotification::new(SessionId::new(
                                    acp_session_id.clone(),
                                )))
                                .is_ok()
                            {
                                // Hold the turn open until the agent acknowledges by
                                // answering `session/prompt`. Anything it streams in the
                                // meantime still belongs to *this* prompt. Disconnect
                                // must still be able to abort this wait — otherwise
                                // `run_prompt` owns `cmd_rx` for up to 10s and the
                                // outer loop never sees Closed.
                                let cancel_deadline =
                                    tokio::time::sleep(CANCEL_ACKNOWLEDGEMENT_TIMEOUT);
                                tokio::pin!(cancel_deadline);
                                loop {
                                    tokio::select! {
                                        _ = &mut prompt_future => break true,
                                        _ = &mut cancel_deadline => break false,
                                        command = cmd_rx.recv() => {
                                            match command {
                                                Some(AgentConnectionCommand::Disconnect) | None => {
                                                    if let Ok(mut guard) = self.active_turn_probe.lock() {
                                                        *guard = None;
                                                    }
                                                    *self.active_prompt.lock().await = None;
                                                    self.record_turn_end(
                                                        &acp_session_id,
                                                        session_id,
                                                        "cancelled",
                                                        turn_started.elapsed().as_millis() as u64,
                                                        None,
                                                    )
                                                    .await;
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
                                                    let _ = result_tx.send(false);
                                                    for tx in extra_cancel_txs {
                                                        let _ = tx.send(false);
                                                    }
                                                    return Ok(RunPromptOutcome::Closed);
                                                }
                                                Some(AgentConnectionCommand::Cancel {
                                                    result_tx: extra_tx,
                                                    ..
                                                }) => {
                                                    extra_cancel_txs.push(extra_tx);
                                                }
                                                Some(AgentConnectionCommand::Prompt {
                                                    session_id: rejected_session,
                                                    prompt_id: rejected_prompt,
                                                    ..
                                                }) => {
                                                    self.emit(
                                                        Some(rejected_session),
                                                        Some(rejected_prompt),
                                                        AgentEvent::Error {
                                                            error: AgentErrorEvent {
                                                                message: "The agent connection was busy with another conversation's turn. Send again.".to_string(),
                                                                code: Some("prompt_conflict".to_string()),
                                                                raw: Some(serde_json::json!({
                                                                    "activePromptId": prompt_id.to_string(),
                                                                    "activeSessionId": session_id.to_string(),
                                                                })),
                                                            },
                                                        },
                                                    );
                                                }
                                                Some(other) => {
                                                    self.emit(
                                                        Some(session_id),
                                                        Some(prompt_id),
                                                        AgentEvent::RawAcpDiagnostic {
                                                            raw: serde_json::json!({
                                                                "kind": "ignored_command_during_cancel_handshake",
                                                                "command": format!("{other:?}"),
                                                            }),
                                                        },
                                                    );
                                                }
                                            }
                                        }
                                    }
                                }
                            } else {
                                false
                            };
                            if !acknowledged {
                                // The prompt is still outstanding and the agent may
                                // keep emitting for it. Unbind the ACP session so a
                                // later turn re-establishes instead of interleaving
                                // with an abandoned prompt, and so stray updates
                                // resolve to no session and are discarded.
                                self.session_map.write().await.remove(&session_id);
                                self.emit(
                                    Some(session_id),
                                    Some(prompt_id),
                                    AgentEvent::RawAcpDiagnostic {
                                        raw: serde_json::json!({
                                            "kind": "cancel_not_acknowledged",
                                            "timeoutSecs": CANCEL_ACKNOWLEDGEMENT_TIMEOUT.as_secs(),
                                            "acpSessionId": acp_session_id,
                                        }),
                                    },
                                );
                            }
                            self.record_turn_end(
                                &acp_session_id,
                                session_id,
                                "cancelled",
                                turn_started.elapsed().as_millis() as u64,
                                None,
                            )
                            .await;
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
                            if let Ok(mut guard) = self.active_turn_probe.lock() {
                                *guard = None;
                            }
                            *self.active_prompt.lock().await = None;
                            if !acknowledged {
                                // Leaving this process alive holds the agent's
                                // thread-writer lock. The next `session/new` or
                                // `session/resume` then either hangs every
                                // conversation or attaches to another session's
                                // context. Tear the connection down so follow-up
                                // resumes this conversation's stored ACP id on a
                                // fresh process.
                                tracing::warn!(
                                    session_id = %session_id.0,
                                    acp_session_id = %acp_session_id,
                                    timeout_secs = CANCEL_ACKNOWLEDGEMENT_TIMEOUT.as_secs(),
                                    "session/cancel was not acknowledged; relaunching the agent connection"
                                );
                            }
                            let _ = result_tx.send(acknowledged);
                            for tx in extra_cancel_txs {
                                let _ = tx.send(acknowledged);
                            }
                            return Ok(if acknowledged {
                                RunPromptOutcome::Settled
                            } else {
                                RunPromptOutcome::RetireConnection
                            });
                        }
                        Some(AgentConnectionCommand::Prompt {
                            session_id: rejected_session,
                            prompt_id: rejected_prompt,
                            ..
                        }) => {
                            // `run_prompt` owns the command loop until this turn
                            // settles, so a prompt for a *different* session sharing
                            // this connection cannot be served. Dropping it silently
                            // left that conversation's Turn `running` forever (its
                            // stop button never returned to send). Fail the Turn
                            // instead; the prompt queue is per session, so this is
                            // only reachable when a connection is shared.
                            self.emit(
                                Some(rejected_session),
                                Some(rejected_prompt),
                                AgentEvent::Error {
                                    error: AgentErrorEvent {
                                        message: "The agent connection was busy with another conversation's turn. Send again.".to_string(),
                                        code: Some("prompt_conflict".to_string()),
                                        raw: Some(serde_json::json!({
                                            "activePromptId": prompt_id.to_string(),
                                            "activeSessionId": session_id.to_string(),
                                        })),
                                    },
                                },
                            );
                        }
                        Some(AgentConnectionCommand::Steer {
                            session_id: steer_session,
                            expected_prompt_id,
                            blocks,
                            display_blocks,
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
                            let steer_blocks: Vec<ContentBlock> =
                                blocks.into_iter().map(agent_block_to_acp).collect();
                            let recorded_steer_blocks: Vec<ContentBlock> = display_blocks
                                .map(|blocks| blocks.into_iter().map(agent_block_to_acp).collect())
                                .unwrap_or_else(|| steer_blocks.clone());
                            let request = AcpSteerRequest {
                                session_id: acp_session_id.clone(),
                                prompt: steer_blocks,
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
                                self.record_steer(&acp_session_id, &recorded_steer_blocks).await;
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
                            self.record_turn_end(
                                &acp_session_id,
                                session_id,
                                "cancelled",
                                turn_started.elapsed().as_millis() as u64,
                                None,
                            )
                            .await;
                            self.emit(
                                Some(session_id),
                                Some(prompt_id),
                                AgentEvent::Error {
                                    error: AgentErrorEvent {
                                        message: CONNECTION_CLOSED_TURN_MESSAGE.to_string(),
                                        code: Some("connection_closed".to_string()),
                                        raw: None,
                                    },
                                },
                            );
                            if let Ok(mut guard) = self.active_turn_probe.lock() {
                                *guard = None;
                            }
                            *self.active_prompt.lock().await = None;
                            return Ok(RunPromptOutcome::Closed);
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
                        Some(AgentConnectionCommand::PrepareSession { result_tx, .. }) => {
                            let _ = result_tx.send(Err(AgentError::Runtime(
                                "cannot prepare a session while a turn is in progress".into(),
                            )));
                        }
                        Some(AgentConnectionCommand::ResumeSession { result_tx, .. }) => {
                            let _ = result_tx.send(Err(AgentError::Runtime(
                                "cannot resume a session while a turn is in progress".into(),
                            )));
                        }
                        Some(AgentConnectionCommand::DiscardSession { result_tx, .. }) => {
                            let _ = result_tx.send(Err(AgentError::Runtime(
                                "cannot discard a session while a turn is in progress".into(),
                            )));
                        }
                        Some(AgentConnectionCommand::GoalControl {
                            session_id: control_session,
                            action,
                            result_tx,
                        }) => {
                            *self.last_activity.lock().await = Instant::now();
                            let result = self
                                .execute_goal_control(
                                    conn,
                                    control_session,
                                    &action,
                                    control_session != session_id,
                                )
                                .await;
                            let _ = result_tx.send(result);
                        }
                        Some(AgentConnectionCommand::StopAsyncTask {
                            session_id: task_session,
                            task_id,
                            result_tx,
                        }) => {
                            *self.last_activity.lock().await = Instant::now();
                            let result = self
                                .execute_stop_async_task(conn, task_session, &task_id)
                                .await;
                            let _ = result_tx.send(result);
                        }
                        Some(AgentConnectionCommand::Cancel {
                            session_id: cancel_session,
                            prompt_id: cancel_prompt,
                            result_tx,
                        }) => {
                            let _ = result_tx.send(true);
                            self.emit(
                                Some(session_id),
                                Some(prompt_id),
                                AgentEvent::RawAcpDiagnostic {
                                    raw: serde_json::json!({
                                        "kind": "ignored_cancel_for_inactive_prompt",
                                        "cancel_session_id": cancel_session,
                                        "cancel_prompt_id": cancel_prompt,
                                    }),
                                },
                            );
                        }
                    }
                }
            }
        }
    }
}
