use super::*;

impl AgentConnectionRunner {
    pub(in crate::manager) async fn apply_session_overrides(
        &self,
        conn: &ConnectionTo<Agent>,
        acp_session_id: &str,
        session_id: AgentSessionId,
        mode_override: Option<String>,
        config_overrides: Vec<AgentSessionConfigOverride>,
    ) -> Result<(), acp::Error> {
        if let Some(mode) = mode_override.as_deref().and_then(non_empty_trimmed) {
            self.apply_mode_value(conn, acp_session_id, session_id, mode)
                .await?;
        }

        // ACP Agents may rebuild dependent config options after a model
        // selection. Use the advertised semantic category to apply model
        // selections first without consulting an Agent identity.
        let advertised_options = self
            .session_controls
            .read()
            .await
            .get(&session_id)
            .map(|state| state.config_options.clone())
            .unwrap_or_default();
        for override_item in ordered_session_config_overrides(&advertised_options, config_overrides)
        {
            let Some(key) = non_empty_trimmed(&override_item.key) else {
                continue;
            };
            let Some(value) = non_empty_trimmed(&override_item.value) else {
                continue;
            };
            self.apply_config_override(conn, acp_session_id, session_id, key, value)
                .await?;
        }

        Ok(())
    }

    pub(in crate::manager) async fn apply_mode_value(
        &self,
        conn: &ConnectionTo<Agent>,
        acp_session_id: &str,
        session_id: AgentSessionId,
        requested_mode: &str,
    ) -> Result<(), acp::Error> {
        let withdrawn = self
            .session_controls
            .read()
            .await
            .get(&session_id)
            .and_then(|controls| controls.modes.as_ref())
            .is_some_and(|modes| session_modes_reject_id(modes, requested_mode));
        if withdrawn {
            tracing::info!(
                %session_id,
                requested_mode,
                "[ACP] skipping mode override: the agent no longer offers that mode"
            );
            return Ok(());
        }
        self.apply_config_override(conn, acp_session_id, session_id, "mode", requested_mode)
            .await
    }

    pub(in crate::manager) async fn apply_config_override(
        &self,
        conn: &ConnectionTo<Agent>,
        acp_session_id: &str,
        session_id: AgentSessionId,
        key: &str,
        value: &str,
    ) -> Result<(), acp::Error> {
        self.apply_config_value(
            conn,
            acp_session_id,
            session_id,
            key,
            &serde_json::Value::String(value.to_string()),
        )
        .await
    }

    pub(in crate::manager) async fn apply_config_value(
        &self,
        conn: &ConnectionTo<Agent>,
        acp_session_id: &str,
        session_id: AgentSessionId,
        key: &str,
        value: &serde_json::Value,
    ) -> Result<(), acp::Error> {
        let (config_options, vendor_config, session_model_ids) = {
            let controls = self.session_controls.read().await;
            let state = controls.get(&session_id);
            (
                state
                    .map(|controls| controls.config_options.clone())
                    .unwrap_or_default(),
                state.and_then(|controls| controls.vendor_config),
                state
                    .map(|controls| controls.session_model_ids.clone())
                    .unwrap_or_default(),
            )
        };
        if config_options.is_empty() {
            self.emit_override_diagnostic(session_id, "config_controls_missing", key);
            return Ok(());
        }

        let agent_kind = AgentKind::from_lenient(self.snapshot.agent_id.as_str());
        let Some(selection) = find_config_override_selection_for_agent(
            &config_options,
            agent_kind,
            key,
            value,
            &session_model_ids,
        ) else {
            if vendor_config == Some(VendorConfigWire::KiroSessionConfig) {
                if key == KIRO_THINKING_OPTION_ID
                    && let Some(enabled) = value.as_str().and_then(kiro_thinking_value)
                {
                    self.execute_kiro_command(
                        conn,
                        KiroExecuteCommandRequest::thinking(
                            SessionId::new(acp_session_id.to_string()),
                            enabled,
                        ),
                    )
                    .await?;
                    if let Some(stored) = self.session_controls.write().await.get_mut(&session_id)
                        && let Some(reasoning) = stored.kiro_reasoning.as_mut()
                    {
                        reasoning.thinking = Some(enabled);
                    }
                    return Ok(());
                }
                if key == KIRO_EFFORT_OPTION_ID
                    && let Some(level) = value
                        .as_str()
                        .map(str::trim)
                        .filter(|level| !level.is_empty() && *level != KIRO_DEFAULT_VALUE)
                {
                    self.execute_kiro_command(
                        conn,
                        KiroExecuteCommandRequest::effort(
                            SessionId::new(acp_session_id.to_string()),
                            level,
                        ),
                    )
                    .await?;
                    if let Some(stored) = self.session_controls.write().await.get_mut(&session_id)
                        && let Some(reasoning) = stored.kiro_reasoning.as_mut()
                    {
                        reasoning.current = Some(level.to_string());
                    }
                    return Ok(());
                }
            }
            // Preferred / last-used values the Agent no longer advertises fall
            // back to the Agent default (ADR-0023). Emitting a conversation
            // Warning for `reasoning_effort=low` on Grok is not actionable:
            // the UI never offered that choice after a partial merge.
            tracing::debug!(
                %session_id,
                key,
                value = %value,
                "session config override skipped; choice is not advertised"
            );
            return Ok(());
        };
        if selection.already_selected {
            return Ok(());
        }

        // Grok and Kiro apply their vendor-advertised model option via the
        // non-standard `session/set_model` method; the standard
        // `session/set_config_option` rejects it. Antigravity 1.4+ still lists
        // variant ids in `models.availableModels` but applies family ids through
        // `session/set_config_option`, so it must not share this branch.
        // The model value rides `selection.event_value` so the exact advertised
        // choice id is sent.
        if matches!(
            vendor_config,
            Some(VendorConfigWire::XaiSessionConfig | VendorConfigWire::KiroSessionConfig)
        ) && selection.config_id == "model"
        {
            let Some(model_id) = selection.event_value.as_str() else {
                return Ok(());
            };
            let _response = conn
                .send_request(SetSessionModelRequest::new(
                    SessionId::new(acp_session_id.to_string()),
                    model_id.to_string(),
                ))
                .block_task()
                .await?;
            self.store_vendor_config_selection(session_id, &selection)
                .await;
            self.publish_applied_config(session_id, &selection).await;
            return Ok(());
        }
        if vendor_config == Some(VendorConfigWire::KiroSessionConfig)
            && selection.config_id == KIRO_EFFORT_OPTION_ID
        {
            let Some(level) = selection.event_value.as_str() else {
                return Ok(());
            };
            if level == KIRO_DEFAULT_VALUE {
                return Ok(());
            }
            self.execute_kiro_command(
                conn,
                KiroExecuteCommandRequest::effort(
                    SessionId::new(acp_session_id.to_string()),
                    level,
                ),
            )
            .await?;
            if let Some(stored) = self.session_controls.write().await.get_mut(&session_id)
                && let Some(reasoning) = stored.kiro_reasoning.as_mut()
            {
                reasoning.current = Some(level.to_string());
            }
            self.store_vendor_config_selection(session_id, &selection)
                .await;
            self.publish_applied_config(session_id, &selection).await;
            return Ok(());
        }
        if vendor_config == Some(VendorConfigWire::KiroSessionConfig)
            && selection.config_id == KIRO_THINKING_OPTION_ID
        {
            let Some(enabled) = selection.event_value.as_str().and_then(kiro_thinking_value) else {
                return Ok(());
            };
            self.execute_kiro_command(
                conn,
                KiroExecuteCommandRequest::thinking(
                    SessionId::new(acp_session_id.to_string()),
                    enabled,
                ),
            )
            .await?;
            if let Some(stored) = self.session_controls.write().await.get_mut(&session_id)
                && let Some(reasoning) = stored.kiro_reasoning.as_mut()
            {
                reasoning.thinking = Some(enabled);
            }
            self.store_vendor_config_selection(session_id, &selection)
                .await;
            self.publish_applied_config(session_id, &selection).await;
            return Ok(());
        }
        if vendor_config == Some(VendorConfigWire::XaiSessionConfig)
            && advertised_option_is_thought_level(&config_options, &selection.config_id)
        {
            let Some(mode_id) = selection.event_value.as_str() else {
                return Ok(());
            };
            conn.send_request(SetSessionModeRequest::new(
                SessionId::new(acp_session_id.to_string()),
                mode_id.to_string(),
            ))
            .block_task()
            .await?;
            self.store_vendor_config_selection(session_id, &selection)
                .await;
            self.publish_applied_config(session_id, &selection).await;
            return Ok(());
        }
        if agent_kind == Some(AgentKind::Omp)
            && advertised_option_is_mode(&config_options, &selection.config_id)
        {
            let Some(requested_mode) = selection.event_value.as_str() else {
                return Ok(());
            };
            if requested_mode == OMP_YOLO_MODE_ID {
                let (was_plan, mode_uses_set_mode) = {
                    let mut controls = self.session_controls.write().await;
                    let stored = controls.entry(session_id).or_default();
                    let (_, current_mode) = session_modes_from_config_options(&stored.config_options);
                    let was_plan = current_mode.as_deref() == Some("plan")
                        || stored
                            .modes
                            .as_ref()
                            .is_some_and(|m| m.current_mode_id.0.as_ref() == "plan");
                    stored.omp_yolo_mode = true;
                    (was_plan, stored.mode_uses_set_mode)
                };
                if was_plan {
                    if mode_uses_set_mode {
                        conn.send_request(SetSessionModeRequest::new(
                            SessionId::new(acp_session_id.to_string()),
                            "default".to_string(),
                        ))
                        .block_task()
                        .await?;
                    } else {
                        let response = conn
                            .send_request(SetSessionConfigOptionRequest::new(
                                SessionId::new(acp_session_id.to_string()),
                                selection.config_id.clone(),
                                SessionConfigOptionValue::value_id("default".to_string()),
                            ))
                            .block_task()
                            .await?;
                        let mut controls = self.session_controls.write().await;
                        let stored = controls.entry(session_id).or_default();
                        stored.config_options = response.config_options;
                        ensure_omp_yolo_config_option(&mut stored.config_options);
                    }
                }
                {
                    let mut controls = self.session_controls.write().await;
                    let stored = controls.entry(session_id).or_default();
                    stored.omp_yolo_mode = true;
                    ensure_omp_yolo_config_option(&mut stored.config_options);
                    apply_current_mode_to_config_options(
                        &mut stored.config_options,
                        OMP_YOLO_MODE_ID,
                    );
                    if let Some(ref mut mode_state) = stored.modes {
                        ensure_omp_yolo_session_mode(mode_state);
                        mode_state.current_mode_id =
                            acp::schema::v1::SessionModeId::new(OMP_YOLO_MODE_ID);
                    }
                }
                self.publish_applied_config(session_id, &selection).await;
                self.emit(
                    Some(session_id),
                    None,
                    AgentEvent::ModeChanged {
                        mode_id: OMP_YOLO_MODE_ID.to_string(),
                    },
                );
                return Ok(());
            } else {
                {
                    let mut controls = self.session_controls.write().await;
                    if let Some(stored) = controls.get_mut(&session_id) {
                        stored.omp_yolo_mode = false;
                    }
                }
            }
        }

        if self
            .session_controls
            .read()
            .await
            .get(&session_id)
            .is_some_and(|controls| {
                controls.mode_uses_set_mode
                    && advertised_option_is_mode(&config_options, &selection.config_id)
            })
        {
            let Some(mode_id) = selection.event_value.as_str() else {
                return Ok(());
            };
            conn.send_request(SetSessionModeRequest::new(
                SessionId::new(acp_session_id.to_string()),
                mode_id.to_string(),
            ))
            .block_task()
            .await?;
            self.store_vendor_config_selection(session_id, &selection)
                .await;
            if agent_kind == Some(AgentKind::Omp) {
                let mut controls = self.session_controls.write().await;
                if let Some(stored) = controls.get_mut(&session_id)
                    && let Some(ref mut mode_state) = stored.modes
                {
                    mode_state.current_mode_id = acp::schema::v1::SessionModeId::new(mode_id);
                }
            }
            self.emit_derived_session_controls(session_id).await;
            self.emit(
                Some(session_id),
                None,
                AgentEvent::ModeChanged {
                    mode_id: mode_id.to_string(),
                },
            );
            return Ok(());
        }

        let response = conn
            .send_request(SetSessionConfigOptionRequest::new(
                SessionId::new(acp_session_id.to_string()),
                selection.config_id.clone(),
                selection.wire_value.clone(),
            ))
            .block_task()
            .await?;
        {
            let mut controls = self.session_controls.write().await;
            let stored = controls.entry(session_id).or_default();
            stored.config_options = response.config_options;
            if agent_kind == Some(AgentKind::Omp) {
                ensure_omp_yolo_config_option(&mut stored.config_options);
                if stored.omp_yolo_mode {
                    let (_, current_mode) =
                        session_modes_from_config_options(&stored.config_options);
                    if current_mode.as_deref() == Some("default") {
                        apply_current_mode_to_config_options(
                            &mut stored.config_options,
                            OMP_YOLO_MODE_ID,
                        );
                    }
                }
            }
        }
        if let Some(requested) = selection.event_value.as_str() {
            let updated = agent_session_config_options_from_acp(
                self.session_controls
                    .read()
                    .await
                    .get(&session_id)
                    .map(|stored| stored.config_options.clone())
                    .unwrap_or_default(),
            );
            if let Some(rejection) =
                config_option_rejection(&updated, &selection.config_id, requested)
            {
                self.emit_config_option_rejection(session_id, rejection);
            }
        }
        // Codex advertises mode as a config option. The composer still reads
        // Mode from `sessionModes`, so a config-option response that only
        // republishes `SessionConfigOptions` leaves the summary on the old
        // mode. Republish both control surfaces from the stored snapshot.
        self.publish_applied_config(session_id, &selection).await;
        if agent_kind == Some(AgentKind::Omp)
            && advertised_option_is_mode(&config_options, &selection.config_id)
            && let Some(mode_id) = selection.event_value.as_str()
        {
            self.emit(
                Some(session_id),
                None,
                AgentEvent::ModeChanged {
                    mode_id: mode_id.to_string(),
                },
            );
        }
        Ok(())
    }

    pub(in crate::manager) async fn execute_kiro_command(
        &self,
        conn: &ConnectionTo<Agent>,
        request: KiroExecuteCommandRequest,
    ) -> Result<(), acp::Error> {
        let reply = conn.send_request(request).block_task().await?;
        if reply.get("success").and_then(serde_json::Value::as_bool) == Some(false) {
            let message = reply
                .get("message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("Kiro rejected the command");
            return Err(acp::Error::into_internal_error(std::io::Error::other(
                message.to_string(),
            )));
        }
        Ok(())
    }

    pub(in crate::manager) fn emit_config_option_rejection(
        &self,
        session_id: AgentSessionId,
        rejection: session_config_guard::ConfigOptionRejection,
    ) {
        self.emit(
            Some(session_id),
            None,
            AgentEvent::ConfigOptionRejected {
                config_id: rejection.config_id,
                option_name: rejection.option_name,
                requested: rejection.requested,
                actual: rejection.actual,
                requested_value: rejection.requested_value,
                actual_value: rejection.actual_value,
            },
        );
    }

    pub(in crate::manager) async fn publish_applied_config(
        &self,
        session_id: AgentSessionId,
        selection: &ConfigOverrideSelection,
    ) {
        self.emit_derived_session_controls(session_id).await;
        self.emit(
            Some(session_id),
            None,
            AgentEvent::ConfigChanged {
                key: selection.config_id.clone(),
                value: selection.event_value.clone(),
            },
        );
    }

    pub(in crate::manager) async fn store_vendor_config_selection(
        &self,
        session_id: AgentSessionId,
        selection: &ConfigOverrideSelection,
    ) {
        let mut controls = self.session_controls.write().await;
        let Some(stored) = controls.get_mut(&session_id) else {
            return;
        };
        for option in &mut stored.config_options {
            if option.id.0.as_ref() != selection.config_id {
                continue;
            }
            if let SessionConfigKind::Select(select) = &mut option.kind
                && let Some(value_id) = selection.event_value.as_str()
            {
                select.current_value = SessionConfigValueId::new(value_id);
            }
        }
    }

    /// Resolve the live ACP session and apply a mode change right now (idle
    /// path of the immediate `SetSessionMode` command).
    pub(in crate::manager) async fn set_live_session_mode(
        &self,
        conn: &ConnectionTo<Agent>,
        session_id: AgentSessionId,
        mode_id: &str,
    ) -> AgentResult<AgentSessionControlsSnapshot> {
        let acp_session_id = self.session_map.read().await.get(&session_id).cloned();
        let Some(acp_session_id) = acp_session_id else {
            return Err(AgentError::Runtime(
                "no live ACP session yet; the mode will apply when the next turn starts".into(),
            ));
        };
        self.drop_asserted_config(session_id, "mode").await;
        self.apply_mode_value(conn, &acp_session_id, session_id, mode_id)
            .await
            .map_err(|error| AgentError::Runtime(format!("session/set_mode failed: {error}")))?;
        // The drop above stops a stale mode from being restored. The value just
        // applied has to be guarded again, or the agent's next CurrentModeUpdate
        // paints its default over the choice.
        self.record_confirmed_controls(session_id, Some(mode_id), &[])
            .await;
        Ok(self.session_controls_snapshot(session_id).await)
    }

    /// Resolve the live ACP session and apply a config-option change right now
    /// (idle path of the immediate `SetSessionConfigOption` command).
    pub(in crate::manager) async fn set_live_session_config_option(
        &self,
        conn: &ConnectionTo<Agent>,
        session_id: AgentSessionId,
        key: &str,
        value: &serde_json::Value,
    ) -> AgentResult<AgentSessionControlsSnapshot> {
        let acp_session_id = self.session_map.read().await.get(&session_id).cloned();
        let Some(acp_session_id) = acp_session_id else {
            return Err(AgentError::Runtime(
                "no live ACP session yet; the setting will apply when the next turn starts".into(),
            ));
        };
        self.drop_asserted_config(session_id, key).await;
        self.apply_config_value(conn, &acp_session_id, session_id, key, value)
            .await
            .map_err(|error| {
                AgentError::Runtime(format!("session/set_config_option failed: {error}"))
            })?;
        let recorded = value
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| value.to_string());
        self.record_confirmed_controls(
            session_id,
            None,
            &[AgentSessionConfigOverride {
                key: key.to_string(),
                value: recorded,
            }],
        )
        .await;
        Ok(self.session_controls_snapshot(session_id).await)
    }

    pub(in crate::manager) async fn drop_asserted_config(
        &self,
        session_id: AgentSessionId,
        config_id: &str,
    ) {
        let mut controls = self.session_controls.write().await;
        if let Some(stored) = controls.get_mut(&session_id) {
            stored.asserted_config_values.remove(config_id);
        }
    }

    /// Keep values that actually settled, so one later agent push back to its
    /// default is sent again. Values the agent rejected are not guarded.
    pub(in crate::manager) async fn record_confirmed_controls(
        &self,
        session_id: AgentSessionId,
        mode: Option<&str>,
        config: &[AgentSessionConfigOverride],
    ) {
        let preferred = preferred_controls_map(
            mode,
            config
                .iter()
                .map(|item| (item.key.as_str(), item.value.as_str())),
        );
        if preferred.is_empty() {
            return;
        }
        let mut controls = self.session_controls.write().await;
        let Some(stored) = controls.get_mut(&session_id) else {
            return;
        };
        let settled = agent_session_config_options_from_acp(stored.config_options.clone());
        stored
            .asserted_config_values
            .extend(asserted_from_preferred(&preferred, &settled));
    }

    pub(in crate::manager) fn spawn_reassert_config_drift(
        &self,
        session_id: AgentSessionId,
        acp_session_id: String,
        drift: Vec<(String, String)>,
    ) {
        if drift.is_empty() {
            return;
        }
        let apply = self.clone();
        tokio::spawn(async move {
            let Some(conn) = apply.live_conn.lock().await.clone() else {
                return;
            };
            for (key, value) in drift {
                tracing::info!(
                    %session_id,
                    config_id = %key,
                    value = %value,
                    "re-asserting session config the agent reverted after establishment"
                );
                if let Err(error) = apply
                    .apply_config_value(
                        &conn,
                        &acp_session_id,
                        session_id,
                        &key,
                        &serde_json::Value::String(value.clone()),
                    )
                    .await
                {
                    tracing::warn!(
                        %session_id,
                        config_id = %key,
                        %error,
                        "failed to re-assert session config after the agent reverted it"
                    );
                }
            }
        });
    }

    pub(in crate::manager) fn emit_override_diagnostic(
        &self,
        session_id: AgentSessionId,
        reason: &'static str,
        requested: &str,
    ) {
        self.emit(
            Some(session_id),
            None,
            AgentEvent::RawAcpDiagnostic {
                raw: serde_json::json!({
                    "kind": "session_config_override_skipped",
                    "reason": reason,
                    "requested": requested,
                }),
            },
        );
    }
}
