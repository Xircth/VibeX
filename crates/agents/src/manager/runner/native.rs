//! Native engine session runner (`ClaudeNativeDriver` / `CodexNativeDriver`) for
//! `AgentConnectionRunner`, enabling direct rate-limit telemetry, prompt cache TTL
//! synthesis, native mid-turn steering, session forking, atomic session rewind,
//! full session controls, MCP server injection, and interactive question elicitation.

use futures::StreamExt;
use serde_json::json;

use super::{native_events::NativeTurnState, *};
use crate::{
    conversation::ContentBlock as TranscriptContentBlock,
    engine::{
        ClaudeNativeDriver, CodexNativeDriver, EngineAuth, EngineCheckpoint, EngineForkRequest,
        EngineHandle, EnginePromptRequest, EngineRuntimePreference, EngineStartSpec,
        EngineSteerReceipt, EngineSteerRequest, NativeEngineDriver, NativeEngineKind, PromptMode,
        is_placeholder_engine_session_id, resolve_native_engine_kind_with_env,
    },
};

fn resolve_engine_auth(env: &HashMap<String, String>, kind: NativeEngineKind) -> EngineAuth {
    match kind {
        NativeEngineKind::ClaudeNative => {
            if let Some(api_key) = env
                .get("ANTHROPIC_API_KEY")
                .or_else(|| env.get("ANTHROPIC_AUTH_TOKEN"))
                .filter(|v| !v.trim().is_empty())
            {
                return EngineAuth::ApiKey {
                    api_key: api_key.clone(),
                    base_url: env
                        .get("ANTHROPIC_BASE_URL")
                        .filter(|u| !u.trim().is_empty())
                        .cloned(),
                };
            }
            if let Some(oauth_token) = env
                .get("CLAUDE_CODE_OAUTH_TOKEN")
                .filter(|v| !v.trim().is_empty())
            {
                return EngineAuth::OAuth {
                    oauth_token: Some(oauth_token.clone()),
                    account_email: None,
                };
            }
            EngineAuth::Ambient
        }
        NativeEngineKind::CodexNative => {
            if let Some(api_key) = env
                .get("OPENAI_API_KEY")
                .or_else(|| env.get("CODEX_API_KEY"))
                .filter(|v| !v.trim().is_empty())
            {
                return EngineAuth::ApiKey {
                    api_key: api_key.clone(),
                    base_url: env
                        .get("OPENAI_BASE_URL")
                        .filter(|u| !u.trim().is_empty())
                        .cloned(),
                };
            }
            EngineAuth::Ambient
        }
    }
}

fn agent_block_to_transcript_block(block: AgentContentBlock) -> TranscriptContentBlock {
    match block {
        AgentContentBlock::Text { text } => TranscriptContentBlock::Text { text },
        AgentContentBlock::Image {
            data,
            mime_type,
            uri,
        } => TranscriptContentBlock::Image {
            data,
            mime_type,
            uri,
            width: None,
            height: None,
        },
        AgentContentBlock::Resource { uri, title } => {
            TranscriptContentBlock::Resource { uri, title }
        }
        AgentContentBlock::Protocol { content } => TranscriptContentBlock::Protocol { content },
    }
}

fn agent_block_to_acp_content_block(block: &AgentContentBlock) -> Option<ContentBlock> {
    match block {
        AgentContentBlock::Text { text } => Some(ContentBlock::Text(TextContent::new(text.clone()))),
        AgentContentBlock::Image {
            data,
            mime_type,
            uri,
        } => {
            let mut img = ImageContent::new(data.clone(), mime_type.clone());
            if let Some(u) = uri.clone() {
                img = img.uri(u);
            }
            Some(ContentBlock::Image(img))
        }
        AgentContentBlock::Resource { uri, title } => Some(ContentBlock::ResourceLink(
            ResourceLink::new(title.clone().unwrap_or_else(|| uri.clone()), uri.clone()),
        )),
        AgentContentBlock::Protocol { .. } => None,
    }
}

impl AgentConnectionRunner {
    /// Determines whether this connection should launch through a flagship native engine
    /// driver (`ClaudeNative` / `CodexNative`) rather than an ACP adapter subprocess (`[F1]`).
    pub(in crate::manager) fn should_attempt_native_engine(
        &self,
        mode_env: Option<&str>,
    ) -> Option<NativeEngineKind> {
        resolve_native_engine_kind_with_env(
            self.snapshot.agent_id.as_str(),
            EngineRuntimePreference::NativeFirst,
            mode_env,
        )
    }

    pub(in crate::manager) async fn run_native(
        &self,
        cmd_rx: &mut mpsc::Receiver<AgentConnectionCommand>,
        ready_tx: Arc<Mutex<Option<oneshot::Sender<AgentResult<()>>>>>,
        kind: NativeEngineKind,
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
        if !self.snapshot.working_dir.is_dir() {
            return Err(AgentError::Runtime(format!(
                "workspace working directory is missing: {}",
                self.snapshot.working_dir.display()
            )));
        }

        let driver: Arc<dyn NativeEngineDriver> = match kind {
            NativeEngineKind::ClaudeNative => Arc::new(ClaudeNativeDriver::new()),
            NativeEngineKind::CodexNative => Arc::new(CodexNativeDriver::new()),
        };

        self.populate_native_capabilities(kind).await;
        let (launch_env, scrubbed_env_keys) = self.build_native_engine_launch_env(kind)?;
        let auth = resolve_engine_auth(&launch_env, kind);
        let provider_instance_id = launch_env
            .get("VIBEX_PROVIDER_INSTANCE_ID")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let isolate_profile = launch_env
            .get("VIBEX_ISOLATE_PROVIDER_PROFILE")
            .is_some_and(|value| value.trim() == "1");
        let initial_mcp = self.build_native_session_mcp_json(None).await;

        let spec = EngineStartSpec {
            workspace_id: self.snapshot.workspace_id,
            working_dir: self.snapshot.working_dir.clone(),
            provider_instance_id,
            isolate_profile,
            auth,
            model: launch_env.get("VIBEX_DEFAULT_MODEL").cloned(),
            config_overrides: json!({}),
            env: launch_env,
            scrubbed_env_keys,
            additional_directories: self.snapshot.additional_directories.clone(),
            mcp_servers: initial_mcp,
        };
        let custom_base_url = spec.uses_custom_base_url(kind);

        let handle = driver
            .start(spec)
            .await
            .map_err(|err| AgentError::Runtime(err.to_string()))?;

        self.handshake_completed.store(true, Ordering::SeqCst);
        *self.status.lock().await = AgentConnectionStatus::Ready;
        if let Some(tx) = ready_tx.lock().await.take() {
            let _ = tx.send(Ok(()));
        }

        // Persist estimated character counts across turns per session (`[F20]`).
        let mut session_char_accumulators: HashMap<AgentSessionId, usize> = HashMap::new();

        while let Some(command) = cmd_rx.recv().await {
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
                    let existing_real = self
                        .session_map
                        .read()
                        .await
                        .get(&session_id)
                        .cloned()
                        .filter(|id| !is_placeholder_engine_session_id(id))
                        .or_else(|| {
                            handle
                                .external_session_id()
                                .filter(|id| !is_placeholder_engine_session_id(id))
                        });

                    let controls = self
                        .seed_native_session_controls(&driver, &handle, kind, session_id)
                        .await;

                    let ext_id = match existing_real {
                        Some(real_id) => {
                            handle.set_external_session_id(Some(real_id.clone()));
                            self.session_map
                                .write()
                                .await
                                .insert(session_id, real_id.clone());
                            self.emit_session_linked(session_id, real_id.clone()).await;
                            real_id
                        }
                        None => {
                            let prepared_id = format!("prepared-{}", session_id.0);
                            self.session_map
                                .write()
                                .await
                                .insert(session_id, prepared_id.clone());
                            crate::session_bind_metrics::record_bind_ready(
                                session_id.0,
                                "prepared",
                                self.handshake_started.elapsed().as_millis(),
                            );
                            self.emit_connection_status(
                                AgentConnectionStatus::Ready,
                                None,
                                Some(session_id),
                            );
                            self.emit(
                                Some(session_id),
                                None,
                                AgentEvent::SessionBindReady {
                                    acp_session_id: prepared_id.clone(),
                                },
                            );
                            prepared_id
                        }
                    };
                    self.emit_controls_snapshot(session_id, &controls);
                    let _ = result_tx.send(Ok((ext_id, controls)));
                }
                AgentConnectionCommand::DiscardSession {
                    session_id,
                    result_tx,
                } => {
                    self.cancel_pending_interactions(session_id).await;
                    self.session_map.write().await.remove(&session_id);
                    self.session_controls.write().await.remove(&session_id);
                    session_char_accumulators.remove(&session_id);
                    self.idle_compaction.remove_session(session_id.0);
                    let _ = result_tx.send(Ok(()));
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
                    let controls = self
                        .seed_native_session_controls(&driver, &handle, kind, session_id)
                        .await;

                    let ext_id = if is_placeholder_engine_session_id(&external_session_id) {
                        let prepared_id = format!("prepared-{}", session_id.0);
                        self.session_map
                            .write()
                            .await
                            .insert(session_id, prepared_id.clone());
                        self.emit_connection_status(
                            AgentConnectionStatus::Ready,
                            None,
                            Some(session_id),
                        );
                        self.emit(
                            Some(session_id),
                            None,
                            AgentEvent::SessionBindReady {
                                acp_session_id: prepared_id.clone(),
                            },
                        );
                        prepared_id
                    } else {
                        handle.set_external_session_id(Some(external_session_id.clone()));
                        self.session_map
                            .write()
                            .await
                            .insert(session_id, external_session_id.clone());
                        self.emit_session_linked(session_id, external_session_id.clone())
                            .await;
                        external_session_id
                    };
                    self.emit_controls_snapshot(session_id, &controls);
                    let _ = result_tx.send(Ok((ext_id, controls, None)));
                }
                AgentConnectionCommand::ForkSession {
                    session_id,
                    fork_point,
                    result_tx,
                } => {
                    let res = self
                        .execute_native_fork(&driver, &handle, session_id, fork_point)
                        .await;
                    let _ = result_tx.send(res);
                }
                AgentConnectionCommand::RollbackTurns {
                    session_id,
                    num_turns,
                    checkpoint_point,
                    git_ref,
                    commit_oid,
                    result_tx,
                } => {
                    let res = self
                        .execute_native_rollback(
                            &driver,
                            &handle,
                            session_id,
                            num_turns,
                            checkpoint_point,
                            git_ref,
                            commit_oid,
                        )
                        .await;
                    let _ = result_tx.send(res);
                }
                AgentConnectionCommand::Prompt {
                    session_id,
                    prompt_id,
                    blocks,
                    mode_override,
                    config_overrides,
                    ..
                } => {
                    let char_acc = session_char_accumulators.entry(session_id).or_insert(0);
                    let closed = self
                        .drive_native_prompt(
                            Arc::clone(&driver),
                            &handle,
                            kind,
                            custom_base_url,
                            session_id,
                            prompt_id,
                            blocks,
                            mode_override.as_deref(),
                            &config_overrides,
                            char_acc,
                            cmd_rx,
                        )
                        .await;
                    if closed {
                        break;
                    }
                }
                AgentConnectionCommand::Cancel { result_tx, .. } => {
                    let ok = driver.interrupt(&handle).await.is_ok();
                    let _ = result_tx.send(ok);
                }
                AgentConnectionCommand::Steer { result_tx, .. } => {
                    let _ = result_tx.send(Ok(AgentSteerReceipt {
                        outcome: AgentSteerOutcome::PromptRequired,
                        reason: Some("no active turn".to_string()),
                    }));
                }
                AgentConnectionCommand::RespondPermission {
                    permission_id,
                    response,
                } => {
                    self.forward_native_permission(&driver, &handle, &permission_id, response)
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
                    let snapshot = self
                        .apply_native_mode_change(kind, session_id, mode_id)
                        .await;
                    let _ = result_tx.send(Ok(snapshot));
                }
                AgentConnectionCommand::SetSessionConfigOption {
                    session_id,
                    key,
                    value,
                    result_tx,
                } => {
                    let snapshot = self
                        .apply_native_config_change(kind, session_id, key, value)
                        .await;
                    let _ = result_tx.send(Ok(snapshot));
                }
                AgentConnectionCommand::ListSessions { result_tx, .. } => {
                    let _ = result_tx.send(Ok(AgentSessionListPage {
                        sessions: Vec::new(),
                        next_cursor: None,
                        meta: None,
                    }));
                }
                AgentConnectionCommand::DeleteSession { result_tx, .. } => {
                    let _ = result_tx.send(Ok(()));
                }
                AgentConnectionCommand::GoalControl { result_tx, .. } => {
                    let _ = result_tx.send(Err(AgentError::Runtime(
                        "native engine does not expose session goal control".into(),
                    )));
                }
                AgentConnectionCommand::StopAsyncTask { result_tx, .. } => {
                    let _ = result_tx.send(Ok(false));
                }
                AgentConnectionCommand::Disconnect => break,
            }
        }

        let _ = driver.shutdown(handle).await;
        Ok(())
    }

    async fn execute_native_fork(
        &self,
        driver: &Arc<dyn NativeEngineDriver>,
        handle: &EngineHandle,
        session_id: AgentSessionId,
        fork_point: Option<crate::ForkPoint>,
    ) -> AgentResult<String> {
        let source_session_id = self
            .session_map
            .read()
            .await
            .get(&session_id)
            .cloned()
            .filter(|id| !is_placeholder_engine_session_id(id))
            .or_else(|| {
                handle
                    .external_session_id()
                    .filter(|id| !is_placeholder_engine_session_id(id))
            });
        let checkpoint_point = fork_point.map(|fp| fp.message_id);
        driver
            .fork_session(
                handle,
                EngineForkRequest {
                    source_session_id,
                    new_session_id: None,
                    checkpoint_point,
                },
            )
            .await
            .map(|receipt| receipt.forked_session_id)
            .map_err(|err| AgentError::Runtime(err.to_string()))
    }

    #[allow(clippy::too_many_arguments)]
    async fn execute_native_rollback(
        &self,
        driver: &Arc<dyn NativeEngineDriver>,
        handle: &EngineHandle,
        session_id: AgentSessionId,
        num_turns: u32,
        checkpoint_point: Option<String>,
        git_ref: Option<String>,
        commit_oid: Option<String>,
    ) -> AgentResult<()> {
        let ext_sid = self
            .session_map
            .read()
            .await
            .get(&session_id)
            .cloned()
            .filter(|id| !is_placeholder_engine_session_id(id))
            .or_else(|| {
                handle
                    .external_session_id()
                    .filter(|id| !is_placeholder_engine_session_id(id))
            });
        driver
            .revert_to(
                handle,
                EngineCheckpoint {
                    turn_ordinal: num_turns as i32,
                    git_ref,
                    commit_oid,
                    external_session_point: checkpoint_point,
                    session_id: ext_sid,
                },
            )
            .await
            .map_err(|err| AgentError::Runtime(err.to_string()))
    }

    #[allow(clippy::too_many_arguments)]
    async fn drive_native_prompt(
        &self,
        driver: Arc<dyn NativeEngineDriver>,
        handle: &EngineHandle,
        kind: NativeEngineKind,
        custom_base_url: bool,
        session_id: AgentSessionId,
        prompt_id: AgentPromptId,
        blocks: Vec<AgentContentBlock>,
        mode_override: Option<&str>,
        config_overrides: &[AgentSessionConfigOverride],
        char_accumulator: &mut usize,
        cmd_rx: &mut mpsc::Receiver<AgentConnectionCommand>,
    ) -> bool {
        let (requested_model, requested_effort, requested_permission_mode) = self
            .resolve_native_turn_controls(kind, session_id, mode_override, config_overrides)
            .await;

        let is_compact = blocks.len() == 1
            && matches!(
                &blocks[0],
                AgentContentBlock::Text { text } if text.trim() == "/compact"
            );
        let mode = if is_compact {
            PromptMode::Compact
        } else {
            PromptMode::Normal
        };
        let ext_sid = self
            .session_map
            .read()
            .await
            .get(&session_id)
            .cloned()
            .filter(|id| !is_placeholder_engine_session_id(id));
        let mcp_servers = self.build_native_session_mcp_json(Some(session_id)).await;

        let transcript_blocks = blocks
            .into_iter()
            .map(agent_block_to_transcript_block)
            .collect::<Vec<_>>();
        let estimated_chars: usize = transcript_blocks
            .iter()
            .map(|b| match b {
                TranscriptContentBlock::Text { text } => text.len(),
                _ => 64,
            })
            .sum();
        *char_accumulator = char_accumulator.saturating_add(estimated_chars);

        *self.active_prompt.lock().await = Some((session_id, prompt_id));
        *self.last_activity.lock().await = Instant::now();

        let mut stream = match driver
            .send_prompt(
                handle,
                EnginePromptRequest {
                    prompt_id: prompt_id.0,
                    blocks: transcript_blocks,
                    session_id: ext_sid,
                    mode,
                    model: requested_model.clone(),
                    effort: requested_effort,
                    permission_mode: requested_permission_mode,
                    mcp_servers: Some(mcp_servers),
                    additional_directories: self.snapshot.additional_directories.clone(),
                },
            )
            .await
        {
            Ok(stream) => stream,
            Err(err) => {
                self.fail_active_turn(
                    session_id,
                    prompt_id,
                    AgentError::Runtime(err.to_string()),
                )
                .await;
                return false;
            }
        };

        self.emit(
            Some(session_id),
            Some(prompt_id),
            AgentEvent::PromptAccepted { prompt_id },
        );

        let mut turn_state = NativeTurnState::default();
        let mut disconnect_requested = false;

        loop {
            tokio::select! {
                maybe_event = stream.next() => {
                    let Some(engine_event) = maybe_event else {
                        if self.active_prompt.lock().await.take().is_some() {
                            self.emit(
                                Some(session_id),
                                Some(prompt_id),
                                AgentEvent::PromptFinished {
                                    finished: AgentPromptFinished {
                                        prompt_id,
                                        stop_reason: Some("end_turn".to_string()),
                                        usage: turn_state.accumulated_usage.take(),
                                    },
                                },
                            );
                        }
                        break;
                    };
                    *self.last_activity.lock().await = Instant::now();
                    if self
                        .handle_native_stream_event(
                            &driver,
                            handle,
                            kind,
                            custom_base_url,
                            requested_model.as_deref(),
                            session_id,
                            prompt_id,
                            engine_event,
                            char_accumulator,
                            &mut turn_state,
                        )
                        .await
                    {
                        break;
                    }
                }
                maybe_cmd = cmd_rx.recv() => {
                    let Some(cmd) = maybe_cmd else {
                        disconnect_requested = true;
                        break;
                    };
                    match cmd {
                        AgentConnectionCommand::Steer {
                            expected_prompt_id,
                            blocks,
                            display_blocks,
                            result_tx,
                            ..
                        } => {
                            let record_source = display_blocks.as_deref().unwrap_or(&blocks);
                            let acp_blocks: Vec<ContentBlock> = record_source
                                .iter()
                                .filter_map(agent_block_to_acp_content_block)
                                .collect();
                            let steer_blocks = blocks
                                .into_iter()
                                .map(agent_block_to_transcript_block)
                                .collect();
                            let ext_sid = self
                                .session_map
                                .read()
                                .await
                                .get(&session_id)
                                .cloned()
                                .filter(|id| !is_placeholder_engine_session_id(id));
                            let res = match driver
                                .steer(
                                    handle,
                                    EngineSteerRequest {
                                        steering_id: uuid::Uuid::new_v4(),
                                        expected_prompt_id: Some(expected_prompt_id.0),
                                        session_id: ext_sid.clone(),
                                        blocks: steer_blocks,
                                    },
                                )
                                .await
                            {
                                Ok(EngineSteerReceipt::Accepted { .. }) => {
                                    if let Some(ref sid_str) = ext_sid.or_else(|| handle.external_session_id()) {
                                        self.record_steer(sid_str, &acp_blocks).await;
                                    }
                                    Ok(AgentSteerReceipt {
                                        outcome: AgentSteerOutcome::Injected,
                                        reason: None,
                                    })
                                }
                                Ok(EngineSteerReceipt::Rejected { message, .. }) => {
                                    Ok(AgentSteerReceipt {
                                        outcome: AgentSteerOutcome::PromptRequired,
                                        reason: Some(message),
                                    })
                                }
                                Err(err) => Err(AgentError::Runtime(err.to_string())),
                            };
                            let _ = result_tx.send(res);
                        }
                        AgentConnectionCommand::Cancel { result_tx, .. } => {
                            let ok = driver.interrupt(handle).await.is_ok();
                            let _ = result_tx.send(ok);
                        }
                        AgentConnectionCommand::RespondPermission {
                            permission_id,
                            response,
                        } => {
                            self.forward_native_permission(&driver, handle, &permission_id, response)
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
                            session_id: target_sid,
                            mode_id,
                            result_tx,
                        } => {
                            let snapshot = self
                                .apply_native_mode_change(kind, target_sid, mode_id)
                                .await;
                            let _ = result_tx.send(Ok(snapshot));
                        }
                        AgentConnectionCommand::SetSessionConfigOption {
                            session_id: target_sid,
                            key,
                            value,
                            result_tx,
                        } => {
                            let snapshot = self
                                .apply_native_config_change(kind, target_sid, key, value)
                                .await;
                            let _ = result_tx.send(Ok(snapshot));
                        }
                        AgentConnectionCommand::ListSessions { result_tx, .. } => {
                            let _ = result_tx.send(Ok(AgentSessionListPage {
                                sessions: Vec::new(),
                                next_cursor: None,
                                meta: None,
                            }));
                        }
                        AgentConnectionCommand::DeleteSession { result_tx, .. } => {
                            let _ = result_tx.send(Ok(()));
                        }
                        AgentConnectionCommand::Disconnect => {
                            let _ = driver.interrupt(handle).await;
                            disconnect_requested = true;
                            break;
                        }
                        other => {
                            self.reject_in_flight_command(other).await;
                        }
                    }
                }
            }
        }

        disconnect_requested
    }

    async fn reject_in_flight_command(&self, command: AgentConnectionCommand) {
        let busy = || AgentError::Runtime("native engine turn already in flight".into());
        match command {
            AgentConnectionCommand::PrepareSession { result_tx, .. } => {
                let _ = result_tx.send(Err(busy()));
            }
            AgentConnectionCommand::ResumeSession { result_tx, .. } => {
                let _ = result_tx.send(Err(busy()));
            }
            AgentConnectionCommand::ForkSession { result_tx, .. } => {
                let _ = result_tx.send(Err(busy()));
            }
            AgentConnectionCommand::RollbackTurns { result_tx, .. } => {
                let _ = result_tx.send(Err(busy()));
            }
            AgentConnectionCommand::DiscardSession { result_tx, .. } => {
                let _ = result_tx.send(Err(busy()));
            }
            AgentConnectionCommand::GoalControl { result_tx, .. } => {
                let _ = result_tx.send(Err(AgentError::Runtime(
                    "native engine does not expose session goal control".into(),
                )));
            }
            AgentConnectionCommand::StopAsyncTask { result_tx, .. } => {
                let _ = result_tx.send(Ok(false));
            }
            AgentConnectionCommand::Prompt {
                session_id,
                prompt_id,
                ..
            } => {
                self.fail_active_turn(session_id, prompt_id, busy()).await;
            }
            _ => {}
        }
    }
}
