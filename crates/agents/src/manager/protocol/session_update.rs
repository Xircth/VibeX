use super::*;

impl AcpClientBridge {
    pub(in crate::manager) async fn session_notification(
        &self,
        args: SessionNotification,
    ) -> Result<(), acp::Error> {
        let acp_session_id = args.session_id.0.to_string();
        let bound_session_id = self.agent_session_for_acp(acp_session_id.clone()).await;
        let session_id =
            resolve_agent_session_id(bound_session_id, *self.pending_session_id.lock().await);
        if bound_session_id.is_none()
            && session_id.is_some()
            && (is_session_transcript_update(&args.update)
                || matches!(
                    args.update,
                    SessionUpdate::UsageUpdate(_) | SessionUpdate::SessionInfoUpdate(_)
                )
                || session_update_is_end_turn_usage(&args.update))
        {
            // Unbound notifications are `session/load` / `session/resume`
            // replaying history. They must not become a live turn. Record the
            // replay only when this load claimed an empty transcript file.
            if let SessionUpdate::SessionInfoUpdate(ref info) = args.update {
                let neutral_goal = self.apply.neutral_goal_channel.load(Ordering::SeqCst);
                if let Some(goal) =
                    crate::codex_goal::session_info_goal_value(info.meta.as_ref(), neutral_goal)
                {
                    self.apply
                        .apply_session_info_goal(session_id, goal, false)
                        .await;
                }
            }
            if is_session_transcript_update(&args.update) {
                self.record_hydrated_update(&acp_session_id, &args.update)
                    .await;
            }
            return Ok(());
        }
        if bound_session_id.is_some() && !matches!(args.update, SessionUpdate::UsageUpdate(_)) {
            self.maybe_emit_grok_usage(session_id, args.meta.as_ref())
                .await;
        }
        if matches!(
            args.update,
            SessionUpdate::ToolCall(_) | SessionUpdate::ToolCallUpdate(_) | SessionUpdate::Plan(_)
        ) {
            self.record_live_update(&acp_session_id, &args.update);
        }
        if bound_session_id.is_some()
            && let Ok(update) = serde_json::to_value(&args.update)
            && let Some(activity) =
                crate::vendor_request_activity::session_update(self.apply.agent_kind(), &update)
            && let Some((active_session, prompt_id)) = *self.apply.active_prompt.lock().await
            && Some(active_session) == bound_session_id
        {
            if self.apply.agent_kind() == Some(AgentKind::Codex)
                && let Some((id, revision)) =
                    crate::vendor_request_activity::codex_retry_incident(&update)
                && !self
                    .retry_incidents
                    .lock()
                    .await
                    .accept(prompt_id, id, revision)
            {
                return Ok(());
            }
            send_manager_event(
                &self.event_tx,
                AgentConnectionManagerEvent {
                    connection_id: self.connection_id,
                    session_id: Some(active_session),
                    prompt_id: Some(prompt_id),
                    event: AgentEvent::RequestActivity {
                        prompt_id,
                        activity,
                    },
                },
            );
            return Ok(());
        }
        let event = match args.update {
            SessionUpdate::AgentMessageChunk(chunk) => {
                if self.take_pi_startup_banner(session_id, &chunk).await
                    || session_notice::is_adapter_cancelled_chunk(self.apply.agent_kind(), &chunk)
                {
                    None
                } else if let Some(adapter_error) =
                    session_notice::adapter_turn_error_from_chunk(self.apply.agent_kind(), &chunk)
                {
                    self.apply
                        .note_adapter_turn_error(session_id, adapter_error);
                    None
                } else if let Some(notice) =
                    session_notice::from_agent_message_chunk_for(self.apply.agent_kind(), &chunk)
                {
                    Some(AgentEvent::RawAcpDiagnostic {
                        raw: session_notice::diagnostic_payload(&notice),
                    })
                } else if let Some(parent_id) = crate::air_contract::chunk_parent_tool_use_id(
                    self.apply.agent_kind(),
                    chunk.meta.as_ref(),
                ) {
                    let text = match acp_content_to_agent(chunk.content.clone()) {
                        AgentContentBlock::Text { text } => text,
                        _ => String::new(),
                    };
                    self.record_live_update(
                        &acp_session_id,
                        &SessionUpdate::AgentMessageChunk(chunk),
                    );
                    if text.is_empty() {
                        None
                    } else {
                        let folded = self
                            .apply
                            .append_subagent_chunk(&parent_id, "text", &text)
                            .await;
                        Some(AgentEvent::ToolCallUpdate {
                            update: AgentToolCallUpdate {
                                id: parent_id,
                                title: None,
                                status: None,
                                content: None,
                                input_preview: None,
                                meta: bounded_optional_meta(folded),
                                images: Vec::new(),
                            },
                        })
                    }
                } else if crate::air_contract::codebuddy_chunk_marks_subagent(
                    self.apply.agent_kind(),
                    chunk.meta.as_ref(),
                ) {
                    self.record_live_update(
                        &acp_session_id,
                        &SessionUpdate::AgentMessageChunk(chunk),
                    );
                    None
                } else {
                    let gated = self
                        .gate_stream_chunk(
                            &acp_session_id,
                            StreamKind::Message,
                            acp_content_to_agent(chunk.content.clone()),
                        )
                        .await;
                    if gated.is_some() {
                        self.record_live_update(
                            &acp_session_id,
                            &SessionUpdate::AgentMessageChunk(chunk),
                        );
                    }
                    gated.map(|content| AgentEvent::MessageChunk { content })
                }
            }
            SessionUpdate::AgentThoughtChunk(chunk) => {
                if let Some(parent_id) = crate::air_contract::chunk_parent_tool_use_id(
                    self.apply.agent_kind(),
                    chunk.meta.as_ref(),
                ) {
                    let text = match acp_content_to_agent(chunk.content.clone()) {
                        AgentContentBlock::Text { text } => text,
                        _ => String::new(),
                    };
                    self.record_live_update(
                        &acp_session_id,
                        &SessionUpdate::AgentThoughtChunk(chunk),
                    );
                    if text.is_empty() {
                        None
                    } else {
                        let folded = self
                            .apply
                            .append_subagent_chunk(&parent_id, "thinking", &text)
                            .await;
                        Some(AgentEvent::ToolCallUpdate {
                            update: AgentToolCallUpdate {
                                id: parent_id,
                                title: None,
                                status: None,
                                content: None,
                                input_preview: None,
                                meta: bounded_optional_meta(folded),
                                images: Vec::new(),
                            },
                        })
                    }
                } else if crate::air_contract::codebuddy_chunk_marks_subagent(
                    self.apply.agent_kind(),
                    chunk.meta.as_ref(),
                ) {
                    self.record_live_update(
                        &acp_session_id,
                        &SessionUpdate::AgentThoughtChunk(chunk),
                    );
                    None
                } else {
                    let gated = self
                        .gate_stream_chunk(
                            &acp_session_id,
                            StreamKind::Thought,
                            acp_content_to_agent(chunk.content.clone()),
                        )
                        .await;
                    if gated.is_some() {
                        self.record_live_update(
                            &acp_session_id,
                            &SessionUpdate::AgentThoughtChunk(chunk),
                        );
                    }
                    gated.map(|content| AgentEvent::ThoughtChunk { content })
                }
            }
            SessionUpdate::ToolCall(tool_call) => {
                let status = Some(acp_enum_label(&tool_call.status));
                let original_input_preview = acp_tool_input_preview(
                    tool_call.raw_input.as_ref(),
                    &tool_call.content,
                    &tool_call.locations,
                );
                let call_id = tool_call.tool_call_id.0.to_string();
                let folded = self
                    .apply
                    .fold_air_tool_meta(&call_id, tool_call.meta.clone(), true)
                    .await;
                let was_hosted = self.apply.hosted_terminal_is_tracked(&call_id).await;
                let hosted = self
                    .apply
                    .hosted_terminal_output(&call_id, folded.as_ref(), status.as_deref())
                    .await;
                let skip_placeholder = was_hosted
                    || hosted.is_some()
                    || self.apply.agent_kind().is_some_and(|kind| {
                        crate::hosted_terminal::hosted_terminal_meta_marks_shell(
                            kind,
                            folded.as_ref(),
                        )
                    });
                let meta = bounded_optional_meta(folded);
                self.grok_subagent.lock().await.note_tool_call(
                    &call_id,
                    Some(tool_call.title.as_str()),
                    original_input_preview.as_deref(),
                    meta.as_ref(),
                    status.as_deref(),
                );
                let peeled = self.grok_mcp.lock().await.apply(
                    &call_id,
                    Some(tool_call.title.as_str()),
                    tool_call.raw_input.as_ref(),
                    tool_call.raw_output.as_ref(),
                );
                if let Some(session_id) = session_id {
                    self.note_in_flight_question_tool_input(
                        session_id,
                        Some(peeled.title.as_str()),
                        peeled.raw_input.as_ref().or(tool_call.raw_input.as_ref()),
                        status.as_deref(),
                    )
                    .await;
                }
                let input_preview = if peeled.peeled_input {
                    json_preview(peeled.raw_input.as_ref())
                } else {
                    original_input_preview
                };
                let content = hosted
                    .map(truncate_preview)
                    .or_else(|| peeled.output_text.map(truncate_preview))
                    .or_else(|| {
                        if skip_placeholder {
                            None
                        } else {
                            json_preview(tool_call.raw_output.as_ref())
                        }
                    })
                    .or_else(|| {
                        if skip_placeholder {
                            None
                        } else {
                            acp_tool_content_preview(&tool_call.content)
                        }
                    });
                Some(AgentEvent::ToolCall {
                    tool_call: AgentToolCall {
                        status,
                        content,
                        id: call_id,
                        title: peeled.title,
                        kind: Some(acp_enum_label(&tool_call.kind)),
                        input_preview,
                        meta,
                        images: acp_tool_images(&tool_call.content),
                    },
                })
            }
            SessionUpdate::ToolCallUpdate(update) => {
                let content_blocks = update.fields.content.as_deref().unwrap_or_default();
                let original_input_preview = acp_tool_input_preview(
                    update.fields.raw_input.as_ref(),
                    content_blocks,
                    update.fields.locations.as_deref().unwrap_or_default(),
                );
                let status = update.fields.status.as_ref().map(acp_enum_label);
                let call_id = update.tool_call_id.0.to_string();
                let folded = self
                    .apply
                    .fold_air_tool_meta(&call_id, update.meta.clone(), false)
                    .await;
                let was_hosted = self.apply.hosted_terminal_is_tracked(&call_id).await;
                let hosted = self
                    .apply
                    .hosted_terminal_output(&call_id, folded.as_ref(), status.as_deref())
                    .await;
                let skip_placeholder = was_hosted
                    || hosted.is_some()
                    || self.apply.agent_kind().is_some_and(|kind| {
                        crate::hosted_terminal::hosted_terminal_meta_marks_shell(
                            kind,
                            folded.as_ref(),
                        )
                    });
                let meta = bounded_optional_meta(folded);
                self.grok_subagent.lock().await.note_tool_call(
                    &call_id,
                    update.fields.title.as_deref(),
                    original_input_preview.as_deref(),
                    meta.as_ref(),
                    status.as_deref(),
                );
                let peeled = self.grok_mcp.lock().await.apply(
                    &call_id,
                    update.fields.title.as_deref(),
                    update.fields.raw_input.as_ref(),
                    update.fields.raw_output.as_ref(),
                );
                if let Some(session_id) = session_id {
                    self.note_in_flight_question_tool_input(
                        session_id,
                        Some(peeled.title.as_str()).or(update.fields.title.as_deref()),
                        peeled
                            .raw_input
                            .as_ref()
                            .or(update.fields.raw_input.as_ref()),
                        status.as_deref(),
                    )
                    .await;
                }
                let input_preview = if peeled.peeled_input {
                    json_preview(peeled.raw_input.as_ref())
                } else {
                    original_input_preview
                };
                let content = hosted
                    .map(truncate_preview)
                    .or_else(|| peeled.output_text.map(truncate_preview))
                    .or_else(|| {
                        if skip_placeholder {
                            None
                        } else {
                            update.fields.raw_output.as_ref().and_then(|output| {
                                serde_json::to_string(output).ok().map(truncate_preview)
                            })
                        }
                    })
                    .or_else(|| {
                        if skip_placeholder {
                            None
                        } else {
                            acp_tool_content_preview(content_blocks)
                        }
                    });
                let title =
                    grok_mcp::should_rewrite_title(update.fields.title.as_deref(), &peeled.title)
                        .then_some(peeled.title);
                Some(AgentEvent::ToolCallUpdate {
                    update: AgentToolCallUpdate {
                        id: call_id,
                        title,
                        status,
                        content,
                        input_preview,
                        meta,
                        images: acp_tool_images(content_blocks),
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
                let commands = self.enrich_available_commands(agent_available_commands_from_acp(
                    update.available_commands,
                ));
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
            SessionUpdate::UserMessageChunk(chunk) => {
                if let Some(session_id) = session_id {
                    let model = chunk.meta.as_ref().and_then(|meta| {
                        serde_json::to_value(meta)
                            .ok()
                            .and_then(|value| crate::model_id_from_meta(Some(&value)))
                    });
                    if let Some(model) = model {
                        self.session_controls
                            .write()
                            .await
                            .entry(session_id)
                            .or_default()
                            .last_model_id = Some(model);
                    }
                }
                Some(AgentEvent::RawAcpDiagnostic {
                    raw: serde_json::json!({
                        "kind": "user_message_acknowledged",
                        "preview": acp_content_preview(&chunk.content),
                    }),
                })
            }
            SessionUpdate::CurrentModeUpdate(update) => {
                let mut mode_id = update.current_mode_id.0.to_string();
                let is_omp = self.apply.agent_kind() == Some(AgentKind::Omp);
                if let Some(session_id) = session_id {
                    let (options, drift, effective_mode_id) = {
                        let mut controls = self.session_controls.write().await;
                        let entry = controls.entry(session_id).or_default();
                        let effective_mode = if is_omp && entry.omp_yolo_mode {
                            if mode_id == "default" {
                                OMP_YOLO_MODE_ID.to_string()
                            } else {
                                entry.omp_yolo_mode = false;
                                mode_id.clone()
                            }
                        } else {
                            mode_id.clone()
                        };
                        apply_current_mode_to_config_options(
                            &mut entry.config_options,
                            &effective_mode,
                        );
                        if let Some(ref mut mode_state) = entry.modes {
                            mode_state.current_mode_id =
                                acp::schema::v1::SessionModeId::new(effective_mode.clone());
                        }
                        let mapped =
                            agent_session_config_options_from_acp(entry.config_options.clone());
                        let drift =
                            take_asserted_config_drift(&mut entry.asserted_config_values, &mapped);
                        (entry.config_options.clone(), drift, effective_mode)
                    };
                    mode_id = effective_mode_id;
                    let (modes, current) = session_modes_from_config_options(&options);
                    if self.pending_session_id.lock().await.is_none() {
                        send_manager_event(
                            &self.event_tx,
                            AgentConnectionManagerEvent {
                                connection_id: self.connection_id,
                                session_id: Some(session_id),
                                prompt_id: None,
                                event: AgentEvent::SessionModes { modes, current },
                            },
                        );
                    }
                    self.apply.spawn_reassert_config_drift(
                        session_id,
                        acp_session_id.clone(),
                        drift,
                    );
                }
                Some(AgentEvent::ModeChanged { mode_id })
            }
            SessionUpdate::ConfigOptionUpdate(update) => {
                // Mirror the pushed options into the stored controls so later
                // `session/set_config_option` matching never works off stale data.
                let mut config_options = update.config_options;
                let is_omp = self.apply.agent_kind() == Some(AgentKind::Omp);
                if is_omp {
                    ensure_omp_yolo_config_option(&mut config_options);
                }
                if let Some(session_id) = session_id {
                    let (mapped, drift) = {
                        let mut controls = self.session_controls.write().await;
                        let stored = controls.entry(session_id).or_default();
                        if is_omp && stored.omp_yolo_mode {
                            let (_, pushed_mode) =
                                session_modes_from_config_options(&config_options);
                            if pushed_mode.as_deref() == Some("default") {
                                apply_current_mode_to_config_options(
                                    &mut config_options,
                                    OMP_YOLO_MODE_ID,
                                );
                            } else if pushed_mode.is_some() {
                                stored.omp_yolo_mode = false;
                            }
                        }
                        let mapped = agent_session_config_options_from_acp(config_options.clone());
                        let drift =
                            take_asserted_config_drift(&mut stored.asserted_config_values, &mapped);
                        stored.config_options = config_options;
                        stored.mode_uses_set_mode = stored.mode_uses_set_mode
                            && config_options_have_mode_category(&stored.config_options);
                        if let Some(model) = current_grok_model_id(&stored.config_options) {
                            stored.last_model_id = Some(model);
                        }
                        (mapped, drift)
                    };
                    self.apply.spawn_reassert_config_drift(
                        session_id,
                        acp_session_id.clone(),
                        drift,
                    );
                    Some(AgentEvent::SessionConfigOptions { options: mapped })
                } else {
                    let mapped = agent_session_config_options_from_acp(config_options);
                    Some(AgentEvent::SessionConfigOptions { options: mapped })
                }
            }
            SessionUpdate::UsageUpdate(update) => {
                let usage = agent_usage_from_acp(update);
                Some(AgentEvent::Usage {
                    usage: self.usage_with_session_model(session_id, usage).await,
                })
            }
            SessionUpdate::SessionInfoUpdate(update) => {
                let agent_kind = self.apply.agent_kind();
                if let Some(suggestion) =
                    crate::session_meta::prompt_suggestion_update(agent_kind, update.meta.as_ref())
                {
                    self.apply
                        .apply_prompt_suggestion(session_id, suggestion)
                        .await;
                }
                let neutral_goal = self.apply.neutral_goal_channel.load(Ordering::SeqCst);
                if let Some(goal) =
                    crate::codex_goal::session_info_goal_value(update.meta.as_ref(), neutral_goal)
                {
                    self.apply
                        .apply_session_info_goal(session_id, goal, true)
                        .await;
                }
                Some(AgentEvent::SessionInfoUpdated {
                    patch: session_info_patch_from_acp(update),
                })
            }
            other => {
                let raw_notification =
                    serde_json::to_value(other).unwrap_or(serde_json::Value::Null);
                let agent_kind = self.apply.agent_kind();
                if let Some(delta) = crate::async_tasks::parse_async_task_session_update(
                    agent_kind,
                    &raw_notification,
                ) {
                    self.apply.apply_async_task_delta(session_id, delta).await;
                    None
                } else if let Some(suggestion) =
                    crate::session_meta::prompt_suggestion_from_session_update(
                        agent_kind,
                        &raw_notification,
                    )
                {
                    self.apply
                        .apply_prompt_suggestion(session_id, suggestion)
                        .await;
                    None
                } else if let Some(usage) = crate::usage_from_session_update(&raw_notification) {
                    Some(AgentEvent::Usage {
                        usage: self.usage_with_session_model(session_id, usage).await,
                    })
                } else if let Some(notice) =
                    session_notice::from_session_update_value(&raw_notification)
                {
                    Some(AgentEvent::RawAcpDiagnostic {
                        raw: session_notice::diagnostic_payload(&notice),
                    })
                } else {
                    let tag = raw_notification
                        .get("sessionUpdate")
                        .and_then(serde_json::Value::as_str);
                    self.apply.note_dropped_update(
                        session_id,
                        tag,
                        "unrecognized sessionUpdate variant",
                    );
                    Some(AgentEvent::RawAcpDiagnostic {
                        raw: bounded_raw_diagnostic(raw_notification),
                    })
                }
            }
        };

        if let Some(event) = event {
            let retry_progress = match &event {
                AgentEvent::MessageChunk { content } | AgentEvent::ThoughtChunk { content } => {
                    super::super::runner::agent_content_has_output(content)
                }
                AgentEvent::ToolCall { .. } => true,
                AgentEvent::ToolCallUpdate { update } => update.status.is_some(),
                _ => false,
            };
            if self.apply.agent_kind() == Some(AgentKind::Codex)
                && retry_progress
                && let Some((active_session, prompt_id)) = *self.apply.active_prompt.lock().await
                && Some(active_session) == session_id
            {
                self.retry_incidents.lock().await.note_progress(prompt_id);
            }
            let establishing = self.pending_session_id.lock().await.is_some();
            if establishing
                && matches!(
                    event,
                    AgentEvent::SessionModes { .. }
                        | AgentEvent::SessionConfigOptions { .. }
                        | AgentEvent::ModeChanged { .. }
                )
            {
                // Hold the first broadcast until preferred controls are applied
                // (CodeG applies before `session_modes` / `session_config_options`).
                return Ok(());
            }
            self.apply.record_turn_probe_event(session_id, &event);
            send_manager_event(
                &self.event_tx,
                AgentConnectionManagerEvent {
                    connection_id: self.connection_id,
                    session_id,
                    prompt_id: self
                        .apply
                        .active_prompt
                        .lock()
                        .await
                        .as_ref()
                        .filter(|(active_session, _)| Some(*active_session) == session_id)
                        .map(|(_, id)| *id),
                    event,
                },
            );
        }
        Ok(())
    }

    async fn note_in_flight_question_tool_input(
        &self,
        session_id: AgentSessionId,
        title: Option<&str>,
        raw_input: Option<&serde_json::Value>,
        status: Option<&str>,
    ) {
        if matches!(status, Some("completed" | "failed" | "cancelled")) {
            return;
        }
        let Some(raw_input) = raw_input else {
            return;
        };
        if extract_question_items_from_tool_input(raw_input).is_some()
            || title.is_some_and(is_question_tool_title)
        {
            self.session_controls
                .write()
                .await
                .entry(session_id)
                .or_default()
                .in_flight_question_input = Some(raw_input.clone());
        }
    }
}

pub(in crate::manager) fn is_question_tool_title(title: &str) -> bool {
    let lower = title.trim().to_ascii_lowercase();
    lower == "ask_user_question"
        || lower == "askuserquestion"
        || lower == "ask_question"
        || lower == "askquestion"
        || lower == "request_user_input"
        || lower.ends_with("_ask_user_question")
        || lower.ends_with("/ask_user_question")
        || lower.ends_with("_ask_question")
        || lower.ends_with("/ask_question")
}

pub(in crate::manager) fn extract_question_items_from_tool_input(
    value: &serde_json::Value,
) -> Option<&Vec<serde_json::Value>> {
    let mut current = value;
    for _ in 0..4 {
        let obj = current.as_object()?;
        if let Some(questions) = obj
            .get("questions")
            .and_then(serde_json::Value::as_array)
            .filter(|items| !items.is_empty())
        {
            return Some(questions);
        }
        current = obj
            .get("arguments")
            .or_else(|| obj.get("Arguments"))
            .or_else(|| obj.get("tool_input"))
            .or_else(|| obj.get("input"))
            .or_else(|| obj.get("params"))?;
    }
    None
}

#[cfg(test)]
mod retry_tests {
    use serde_json::json;

    use super::*;

    #[tokio::test]
    async fn codex_retry_notifications_reject_old_revisions_and_retired_incidents() {
        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let agent_id = AgentId::parse("codex").unwrap();
        let connection_id = AgentConnectionId::new();
        let runner = AgentConnectionRunner::new(
            ManagedAgentConnectionSnapshot {
                connection_id,
                agent_id: agent_id.clone(),
                launch_lock: SessionLaunchLock {
                    agent_id: agent_id.clone(),
                    absolute_acp_program: PathBuf::from("/fixture/codex-acp"),
                    args: Vec::new(),
                    env: BTreeMap::new(),
                    runtime_version: "fixture".into(),
                    acp_version: "2.2.2".into(),
                },
                workspace_id: uuid::Uuid::nil(),
                working_dir: PathBuf::from("/fixture"),
                additional_directories: Vec::new(),
                auto_approve_mode: AgentAutoApproveMode::default(),
                env: HashMap::new(),
            },
            event_tx.clone(),
            None,
        );
        let session = AgentSessionId::new();
        let prompt = AgentPromptId::new();
        runner
            .session_map
            .write()
            .await
            .insert(session, "acp-test".into());
        *runner.active_prompt.lock().await = Some((session, prompt));
        let bridge = AcpClientBridge::new(
            connection_id,
            agent_id,
            event_tx,
            runner.session_map.clone(),
            runner.session_controls.clone(),
            runner.pending_permissions.clone(),
            runner.pending_elicitations.clone(),
            runner.auto_approve_mode.clone(),
            runner.stream_dedup.clone(),
            runner.last_activity.clone(),
            runner.grok_subagent.clone(),
            runner.grok_mcp.clone(),
            runner.pending_session_id.clone(),
            PathBuf::from("/fixture"),
            HashMap::new(),
            runner.clone(),
        );
        let retry = |id, revision| {
            serde_json::from_value::<SessionNotification>(json!({
                "sessionId":"acp-test", "update": {"sessionUpdate":"session_info_update",
                "_meta":{"jetbrains":{"air":{"version":1,"sessionFailure":{
                    "id":id,"revision":revision,"category":"connection","severity":"warning",
                    "title":"stream disconnected","actions":[]
                }}}}}
            }))
            .unwrap()
        };
        bridge
            .session_notification(retry("turn:error", 2))
            .await
            .unwrap();
        let first = event_rx.try_recv().unwrap();
        assert_eq!(first.prompt_id, Some(prompt));
        assert!(matches!(first.event, AgentEvent::RequestActivity { .. }));
        bridge
            .session_notification(retry("turn:error", 1))
            .await
            .unwrap();
        assert!(event_rx.try_recv().is_err());

        let metadata = serde_json::from_value::<SessionNotification>(json!({
            "sessionId":"acp-test", "update":{"sessionUpdate":"tool_call_update",
            "toolCallId":"tool-1", "title":"updated title"}
        }))
        .unwrap();
        bridge.session_notification(metadata).await.unwrap();
        assert!(matches!(
            event_rx.try_recv().unwrap().event,
            AgentEvent::ToolCallUpdate { .. }
        ));
        bridge
            .session_notification(retry("turn:error", 3))
            .await
            .unwrap();
        assert!(matches!(
            event_rx.try_recv().unwrap().event,
            AgentEvent::RequestActivity { .. }
        ));

        let content = serde_json::from_value::<SessionNotification>(json!({
            "sessionId":"acp-test", "update":{"sessionUpdate":"agent_message_chunk",
            "content":{"type":"text","text":"recovered output"}}
        }))
        .unwrap();
        bridge.session_notification(content).await.unwrap();
        assert!(matches!(
            event_rx.try_recv().unwrap().event,
            AgentEvent::MessageChunk { .. }
        ));
        let second_id = "turn:error:01f888b7-a040-4fe0-94ad-40ff454e385b:2";
        bridge
            .session_notification(retry(second_id, 1))
            .await
            .unwrap();
        assert!(matches!(
            event_rx.try_recv().unwrap().event,
            AgentEvent::RequestActivity { .. }
        ));
        bridge
            .session_notification(retry("turn:error", 4))
            .await
            .unwrap();
        assert!(event_rx.try_recv().is_err());
        *runner.active_prompt.lock().await = Some((session, AgentPromptId::new()));
        bridge
            .session_notification(retry(second_id, 2))
            .await
            .unwrap();
        assert!(event_rx.try_recv().is_err());
    }
}
