use super::*;
use crate::stderr_tail::{sanitize_diagnostic, summarize_parser_error};

impl AcpClientBridge {
    pub(in crate::manager) async fn handle_ext_method(
        &self,
        ext: ExtRequest,
    ) -> Result<ClientResponse, acp::Error> {
        let Some(parsed) = crate::ext_question::parse(ext.method.as_ref(), ext.params.get()) else {
            return Err(acp::Error::method_not_found());
        };
        let question = parsed.map_err(|error| {
            let sanitized = sanitize_diagnostic(&error);
            self.apply
                .note_dropped_update(None, Some(ext.method.as_ref()), &sanitized);
            acp::Error::invalid_params()
        })?;
        let sessions = self.session_map.read().await;
        let Some(session_id) =
            crate::ext_question::resolve_session_id(question.session_id.as_deref(), &sessions)
        else {
            tracing::warn!(
                method = %ext.method,
                acp_session = ?question.session_id,
                "vendor question ext-method for unknown ACP session"
            );
            return Err(acp::Error::invalid_params());
        };
        drop(sessions);
        let response = self
            .wait_for_question(session_id, question.prompt.clone(), question.schema.clone())
            .await;
        let payload = question.into_response(response);
        let raw =
            serde_json::value::to_raw_value(&payload).map_err(acp::Error::into_internal_error)?;
        Ok(ClientResponse::ExtMethodResponse(ExtResponse::new(
            raw.into(),
        )))
    }

    pub(in crate::manager) async fn handle_ext_notification(
        &self,
        ext: agent_client_protocol::schema::v1::ExtNotification,
    ) -> Result<(), acp::Error> {
        let params: serde_json::Value = match serde_json::from_str(ext.params.get()) {
            Ok(value) => value,
            Err(error) => {
                let summary = summarize_parser_error(&error);
                self.apply
                    .note_dropped_update(None, Some(ext.method.as_ref()), &summary);
                serde_json::Value::Null
            }
        };
        if ext.method.as_ref() == GROK_MODELS_UPDATE_METHOD {
            self.handle_grok_models_update(&params).await;
            return Ok(());
        }
        let bound_session_id = match params
            .get("sessionId")
            .or_else(|| params.get("session_id"))
            .and_then(|value| value.as_str())
        {
            Some(acp_session_id) => self.agent_session_for_acp(acp_session_id.to_string()).await,
            None => {
                let sessions = self.session_map.read().await;
                if sessions.len() == 1 {
                    sessions.keys().next().copied()
                } else {
                    None
                }
            }
        };
        let pending_session_id = *self.pending_session_id.lock().await;
        let session_id = resolve_agent_session_id(bound_session_id, pending_session_id);
        let establishing = pending_session_id.is_some();
        if !establishing
            && let Some(activity) = crate::vendor_request_activity::extension(
                self.apply.agent_kind(),
                ext.method.as_ref(),
                &params,
            )
            .or_else(|| {
                crate::vendor_request_activity::registry_extension(
                    &self.agent_id,
                    ext.method.as_ref(),
                    &params,
                )
            })
            && let Some((active_session, prompt_id)) = *self.apply.active_prompt.lock().await
            && Some(active_session) == bound_session_id
        {
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

        match ext.method.as_ref() {
            KIRO_METADATA_METHOD => {
                if let Some(session_id) = session_id
                    && let Some(reasoning_value) = params.get("reasoning")
                {
                    let reasoning = parse_kiro_reasoning(reasoning_value);
                    let updated_options = {
                        let mut controls = self.session_controls.write().await;
                        let entry = controls.entry(session_id).or_default();
                        if entry.kiro_reasoning.as_ref() == Some(&reasoning) {
                            None
                        } else {
                            entry.kiro_reasoning = Some(reasoning.clone());
                            if entry
                                .config_options
                                .iter()
                                .any(|option| option.id.0.as_ref() == KIRO_MODEL_OPTION_ID)
                            {
                                place_kiro_reasoning_selectors(
                                    &mut entry.config_options,
                                    &reasoning,
                                );
                                Some(entry.config_options.clone())
                            } else {
                                None
                            }
                        }
                    };
                    if !establishing && let Some(options) = updated_options {
                        send_manager_event(
                            &self.event_tx,
                            AgentConnectionManagerEvent {
                                connection_id: self.connection_id,
                                session_id: Some(session_id),
                                prompt_id: None,
                                event: AgentEvent::SessionConfigOptions {
                                    options: agent_session_config_options_from_acp(options),
                                },
                            },
                        );
                    }
                }
                return Ok(());
            }
            KIRO_COMMANDS_AVAILABLE_METHOD => {
                if let Some(session_id) = session_id {
                    let commands = kiro_available_commands(&params);
                    {
                        let mut controls = self.session_controls.write().await;
                        let entry = controls.entry(session_id).or_default();
                        entry.available_commands = Some(commands.clone());
                    }
                    if !establishing {
                        send_manager_event(
                            &self.event_tx,
                            AgentConnectionManagerEvent {
                                connection_id: self.connection_id,
                                session_id: Some(session_id),
                                prompt_id: None,
                                event: AgentEvent::AvailableCommands { commands },
                            },
                        );
                    }
                }
                return Ok(());
            }
            KIRO_AGENT_SWITCHED_METHOD => {
                if let Some(session_id) = session_id
                    && let Some(agent_name) = params
                        .get("agentName")
                        .and_then(serde_json::Value::as_str)
                        .map(str::trim)
                        .filter(|name| !name.is_empty())
                {
                    let updated_options = {
                        let mut controls = self.session_controls.write().await;
                        let entry = controls.entry(session_id).or_default();
                        apply_current_mode_to_config_options(&mut entry.config_options, agent_name);
                        entry.config_options.clone()
                    };
                    if !establishing {
                        send_manager_event(
                            &self.event_tx,
                            AgentConnectionManagerEvent {
                                connection_id: self.connection_id,
                                session_id: Some(session_id),
                                prompt_id: None,
                                event: AgentEvent::ModeChanged {
                                    mode_id: agent_name.to_string(),
                                },
                            },
                        );
                        send_manager_event(
                            &self.event_tx,
                            AgentConnectionManagerEvent {
                                connection_id: self.connection_id,
                                session_id: Some(session_id),
                                prompt_id: None,
                                event: AgentEvent::SessionConfigOptions {
                                    options: agent_session_config_options_from_acp(updated_options),
                                },
                            },
                        );
                    }
                }
                return Ok(());
            }
            _ => {}
        }
        if ext.method.as_ref() == AIR_SESSION_UPDATE_METHOD {
            let update_payload = params.get("update").unwrap_or(&params);
            let agent_kind = self.apply.agent_kind();
            if let Some(delta) =
                crate::async_tasks::parse_async_task_session_update(agent_kind, update_payload)
            {
                self.apply.apply_async_task_delta(session_id, delta).await;
            } else if let Some(suggestion) =
                crate::session_meta::prompt_suggestion_from_session_update(
                    agent_kind,
                    update_payload,
                )
            {
                self.apply
                    .apply_prompt_suggestion(session_id, suggestion)
                    .await;
            }
            return Ok(());
        }
        if self.apply.agent_kind() == Some(AgentKind::Grok)
            && matches!(
                ext.method.as_ref(),
                GROK_WORKFLOW_UPDATED_METHOD | "session/workflow_updated"
            )
            && let Some((_workflow_session_id, delta)) =
                crate::async_tasks::parse_grok_workflow_updated(&params)
        {
            self.apply.apply_async_task_delta(session_id, delta).await;
            return Ok(());
        }
        if crate::grok_announcements::is_announcements_method(ext.method.as_ref()) {
            if let Some(update) = crate::grok_announcements::parse_update(&params) {
                let notices =
                    crate::grok_announcements::notices_from_update(&update, &self.agent_id);
                send_manager_event(
                    &self.event_tx,
                    AgentConnectionManagerEvent {
                        connection_id: self.connection_id,
                        session_id,
                        prompt_id: None,
                        event: AgentEvent::AnnouncementsUpdated {
                            generation: update.generation,
                            notices,
                        },
                    },
                );
            }
            return Ok(());
        }
        if bound_session_id.is_none() {
            if crate::grok_subagent::is_vendor_session_update(ext.method.as_ref())
                && let Ok(notification) = serde_json::from_value::<SessionNotification>(params)
            {
                return self.session_notification(notification).await;
            }
            return Ok(());
        }
        let updates = self
            .grok_subagent
            .lock()
            .await
            .handle_ext(ext.method.as_ref(), &params);
        if updates.is_empty() {
            if crate::grok_subagent::is_vendor_session_update(ext.method.as_ref()) {
                match serde_json::from_value::<SessionNotification>(params.clone()) {
                    Ok(notification) => {
                        // `session_notification` already folds `turn_completed.usage`.
                        // Emitting here as well would double-count the same prompt.
                        return self.session_notification(notification).await;
                    }
                    Err(error) => {
                        if session_id.is_some()
                            && let Some(usage) = usage_from_session_notification_params(&params)
                        {
                            self.emit_end_turn_usage(session_id, usage).await;
                        } else if session_notice::from_session_notification_params(&params)
                            .is_none()
                        {
                            let tag = params
                                .get("update")
                                .and_then(|u| u.get("sessionUpdate"))
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or(ext.method.as_ref());
                            let summary = summarize_parser_error(&error);
                            self.apply
                                .note_dropped_update(session_id, Some(tag), &summary);
                        }
                    }
                }
            }
            let diagnostic = session_notice::from_session_notification_params(&params)
                .map(|notice| session_notice::diagnostic_payload(&notice))
                .unwrap_or_else(|| bounded_ext_notification(ext.method.as_ref(), &params));
            send_manager_event(
                &self.event_tx,
                AgentConnectionManagerEvent {
                    connection_id: self.connection_id,
                    session_id,
                    prompt_id: None,
                    event: AgentEvent::RawAcpDiagnostic { raw: diagnostic },
                },
            );
            return Ok(());
        }
        for update in updates {
            let event = AgentEvent::ToolCallUpdate {
                update: AgentToolCallUpdate {
                    id: update.tool_call_id,
                    title: None,
                    status: None,
                    content: None,
                    input_preview: None,
                    meta: Some(update.meta),
                    images: Vec::new(),
                },
            };
            self.apply.record_turn_probe_event(session_id, &event);
            send_manager_event(
                &self.event_tx,
                AgentConnectionManagerEvent {
                    connection_id: self.connection_id,
                    session_id,
                    prompt_id: None,
                    event,
                },
            );
        }
        Ok(())
    }

    /// Grok's process-wide catalog. Refresh every session's model list and
    /// never move this session's current model — `currentModelId` is not a
    /// session switch (Codeg `fold_grok_catalog_into_picker`).
    pub(in crate::manager) async fn handle_grok_models_update(&self, params: &serde_json::Value) {
        let Some(catalog) = parse_grok_model_catalog(params) else {
            return;
        };
        *self.apply.grok_catalog.lock().await = Some(catalog.clone());
        let establishing = self.pending_session_id.lock().await.is_some();
        let mut changed = Vec::new();
        {
            let mut controls = self.session_controls.write().await;
            for (session_id, stored) in controls.iter_mut() {
                if apply_grok_catalog_to_stored_options(&mut stored.config_options, &catalog) {
                    changed.push((*session_id, stored.config_options.clone()));
                }
            }
        }
        if establishing {
            return;
        }
        for (session_id, options) in changed {
            send_manager_event(
                &self.event_tx,
                AgentConnectionManagerEvent {
                    connection_id: self.connection_id,
                    session_id: Some(session_id),
                    prompt_id: None,
                    event: AgentEvent::SessionConfigOptions {
                        options: agent_session_config_options_from_acp(options),
                    },
                },
            );
        }
    }

    pub(in crate::manager) async fn take_pi_startup_banner(
        &self,
        session_id: Option<AgentSessionId>,
        chunk: &acp::schema::v1::ContentChunk,
    ) -> bool {
        if self.agent_id.as_str() != "pi" {
            return false;
        }
        let Some(session_id) = session_id else {
            return false;
        };
        let ContentBlock::Text(text) = &chunk.content else {
            return false;
        };
        let mut controls = self.session_controls.write().await;
        let Some(entry) = controls.get_mut(&session_id) else {
            return false;
        };
        if !session_notice::matches_pi_startup_banner(
            entry.pi_startup_banner.as_deref(),
            &text.text,
        ) {
            return false;
        }
        entry.pi_startup_banner = None;
        true
    }

    pub(in crate::manager) fn enrich_available_commands(
        &self,
        advertised: Vec<AgentAvailableCommand>,
    ) -> Vec<AgentAvailableCommand> {
        enrich_pi_available_commands(
            self.agent_id.as_str(),
            &self.env,
            &self.working_dir,
            advertised,
        )
    }
}
