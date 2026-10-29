use super::*;

impl AgentConnectionRunner {
    pub(in crate::manager) async fn run_in_memory(self, mut cmd_rx: mpsc::Receiver<AgentConnectionCommand>) {
        while let Some(command) = cmd_rx.recv().await {
            match command {
                AgentConnectionCommand::PrepareSession {
                    session_id,
                    preferences: _,
                    result_tx,
                } => {
                    let existing = self.session_map.read().await.get(&session_id).cloned();
                    let acp_session_id = if let Some(existing) =
                        existing.filter(|id| crate::is_restorable_acp_session_id(id))
                    {
                        self.emit_session_bind_ready(session_id, existing.clone());
                        existing
                    } else {
                        let acp_session_id = format!("inmem-{}", session_id.0);
                        self.record_session_header(session_id, &acp_session_id);
                        self.session_map
                            .write()
                            .await
                            .insert(session_id, acp_session_id.clone());
                        self.emit_session_linked(session_id, acp_session_id.clone())
                            .await;
                        acp_session_id
                    };
                    let _ = result_tx.send(Ok((
                        acp_session_id,
                        AgentSessionControlsSnapshot::default(),
                    )));
                }
                AgentConnectionCommand::DiscardSession {
                    session_id,
                    result_tx,
                } => {
                    self.cancel_pending_interactions(session_id).await;
                    self.session_map.write().await.remove(&session_id);
                    self.session_controls.write().await.remove(&session_id);
                    let _ = result_tx.send(Ok(()));
                }
                AgentConnectionCommand::ResumeSession {
                    session_id,
                    external_session_id,
                    preferences: _,
                    result_tx,
                } => {
                    let acp_session_id =
                        if crate::is_restorable_acp_session_id(&external_session_id) {
                            external_session_id
                        } else {
                            format!("inmem-{}", session_id.0)
                        };
                    self.record_session_header(session_id, &acp_session_id);
                    self.session_map
                        .write()
                        .await
                        .insert(session_id, acp_session_id.clone());
                    self.emit_session_linked(session_id, acp_session_id.clone())
                        .await;
                    let controls = AgentSessionControlsSnapshot::default();
                    let _ = result_tx.send(Ok((acp_session_id, controls, None)));
                }
                AgentConnectionCommand::ForkSession {
                    session_id,
                    result_tx,
                    ..
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
                    display_blocks,
                    ..
                } => {
                    let bound = self
                        .session_map
                        .read()
                        .await
                        .get(&session_id)
                        .cloned()
                        .filter(|id| crate::is_restorable_acp_session_id(id));
                    let Some(acp_session_id) = bound else {
                        self.fail_active_turn(
                            session_id,
                            prompt_id,
                            AgentError::AcpSessionNotBound,
                        )
                        .await;
                        continue;
                    };
                    let wire_blocks: Vec<ContentBlock> =
                        blocks.iter().cloned().map(agent_block_to_acp).collect();
                    let recorded_blocks: Vec<ContentBlock> = display_blocks
                        .map(|blocks| blocks.into_iter().map(agent_block_to_acp).collect())
                        .unwrap_or_else(|| wire_blocks.clone());
                    self.record_prompt(&acp_session_id, &recorded_blocks).await;
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
                        self.run_full_gate_fixture(&acp_session_id, session_id, prompt_id)
                            .await;
                        continue;
                    }
                    self.record_in_memory_update(
                        &acp_session_id,
                        &SessionUpdate::AgentMessageChunk(acp::schema::v1::ContentChunk::new(
                            ContentBlock::from(text.clone()),
                        )),
                    );
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
                } => {
                    if let Some(acp_session_id) =
                        self.session_map.read().await.get(&session_id).cloned()
                    {
                        self.record_turn_end(&acp_session_id, session_id, "cancelled", 0, None)
                            .await;
                    }
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
                }
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
                AgentConnectionCommand::GoalControl {
                    session_id,
                    action,
                    result_tx,
                } => {
                    let kind = self.agent_kind();
                    let goal_was_active = {
                        let mut controls = self.session_controls.write().await;
                        let state = controls.entry(session_id).or_default();
                        let was_active = state
                            .goal
                            .as_ref()
                            .and_then(|goal| goal.get("status"))
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("active")
                            == "active";
                        match action.as_str() {
                            "pause" => {
                                state.open_goal_run = None;
                                state.goal = Some(serde_json::json!({
                                    "objective": "in-memory goal",
                                    "status": "paused",
                                }));
                            }
                            "clear" => {
                                state.open_goal_run = None;
                                state.goal = None;
                            }
                            _ => {}
                        }
                        was_active
                    };
                    let should_interrupt_turn =
                        crate::codex_goal::goal_control_is_out_of_band(kind)
                            && goal_was_active
                            && matches!(action.as_str(), "pause" | "clear");
                    let _ = result_tx.send(Ok(crate::GoalControlReceipt {
                        action,
                        method: crate::codex_goal::NEUTRAL_GOAL_CONTROL_METHOD.to_string(),
                        should_interrupt_turn,
                        goal: None,
                    }));
                }
                AgentConnectionCommand::StopAsyncTask { result_tx, .. } => {
                    let _ = result_tx.send(Ok(false));
                }
                AgentConnectionCommand::Disconnect => break,
            }
        }
        self.cancel_all_pending_interactions().await;
    }
}
