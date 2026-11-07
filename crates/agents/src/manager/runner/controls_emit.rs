use super::*;

impl AgentConnectionRunner {
    /// Prefer the standard ACP `modes`/`configOptions` fields and only fall
    /// back to a vendor `_meta` extension when the agent advertised neither
    /// (Grok currently). The returned wire marker tells the apply path which
    /// non-standard method (if any) the agent expects for changes.
    #[allow(clippy::too_many_arguments)]
    pub(in crate::manager) async fn emit_session_controls(
        &self,
        conn: &ConnectionTo<Agent>,
        acp_session_id: &str,
        session_id: AgentSessionId,
        modes: Option<SessionModeState>,
        config_options: Option<Vec<AcpSessionConfigOption>>,
        vendor_config: Option<VendorConfigWire>,
        session_meta: Option<&serde_json::Map<String, serde_json::Value>>,
        session_model_ids: Vec<String>,
    ) {
        let raw_modes = modes.clone();
        let (config_options, mode_uses_set_mode) = unify_session_config_options(
            modes,
            config_options.unwrap_or_default(),
            vendor_config.is_some(),
        );
        let pi_extension_seed = (self.snapshot.agent_id.as_str() == "pi").then(|| {
            enrich_pi_available_commands(
                self.snapshot.agent_id.as_str(),
                &self.snapshot.env,
                &self.snapshot.working_dir,
                Vec::new(),
            )
        });
        let is_omp = AgentKind::Omp.matches_id(self.snapshot.agent_id.as_str());
        let initial_auto_approve_yolo =
            *self.auto_approve_mode.lock().await == AgentAutoApproveMode::Yolo;
        {
            let mut controls = self.session_controls.write().await;
            let entry = controls.entry(session_id).or_default();
            entry.modes = raw_modes.clone();
            entry.config_options = config_options.clone();
            if is_omp {
                ensure_omp_yolo_config_option(&mut entry.config_options);
                if let Some(ref mut mode_state) = entry.modes {
                    ensure_omp_yolo_session_mode(mode_state);
                }
                let (_, current_mode) = session_modes_from_config_options(&entry.config_options);
                if initial_auto_approve_yolo && current_mode.as_deref() == Some("default") {
                    entry.omp_yolo_mode = true;
                }
                if entry.omp_yolo_mode && current_mode.as_deref() == Some("default") {
                    apply_current_mode_to_config_options(
                        &mut entry.config_options,
                        OMP_YOLO_MODE_ID,
                    );
                    if let Some(ref mut mode_state) = entry.modes {
                        mode_state.current_mode_id = acp::schema::v1::SessionModeId::new(OMP_YOLO_MODE_ID);
                    }
                }
            }
            if let Some(reasoning) = entry.kiro_reasoning.as_ref() {
                place_kiro_reasoning_selectors(&mut entry.config_options, reasoning);
            }
            entry.mode_uses_set_mode = mode_uses_set_mode;
            if let Some(model) = current_grok_model_id(&entry.config_options) {
                entry.last_model_id = Some(model);
            }
            if let Some(vendor_config) = vendor_config {
                entry.vendor_config = Some(vendor_config);
            }
            if !session_model_ids.is_empty() {
                entry.session_model_ids = session_model_ids.clone();
            }
            if let Some(meta) = session_meta {
                let windows = grok_usage::windows_from_session_meta(Some(meta));
                if !windows.is_empty() {
                    entry.grok_model_windows.extend(windows);
                }
                if self.snapshot.agent_id.as_str() == "pi" {
                    entry.pi_startup_banner =
                        session_notice::pi_startup_banner_from_meta(Some(meta));
                }
            }
            if let Some(seeded) = pi_extension_seed.filter(|commands| !commands.is_empty()) {
                let advertised = entry.available_commands.take().unwrap_or_default();
                entry.available_commands = Some(merge_available_command_lists(advertised, seeded));
            }
        }
        if let Some(title) = acp_meta_session_title(session_meta) {
            self.emit(
                Some(session_id),
                None,
                AgentEvent::SessionInfoUpdated {
                    patch: serde_json::json!({ "title": title }),
                },
            );
        }

        if let Some(preferences) = self.preferred_controls.write().await.remove(&session_id)
            && !preferences.is_empty()
        {
            // Apply before the first broadcast so the UI never sees the agent's
            // defaults (CodeG `acp_connect` + preferred_*). Heal retired Claude
            // model spellings (`opus[1m]` -> `opus`, `claude-fable-5-1` -> `fable`)
            // and drop mode/config picks the session's own advertisement rejects.
            let agent_kind = AgentKind::from_lenient(self.snapshot.agent_id.as_str());
            let (mode_to_apply, config_to_apply, preferred_map) =
                prepare_preferred_controls_for_replay(
                    agent_kind,
                    raw_modes.as_ref(),
                    &config_options,
                    preferences.mode.as_deref(),
                    &preferences.config,
                    &session_model_ids,
                );
            if let Err(error) = self
                .apply_session_overrides(
                    conn,
                    acp_session_id,
                    session_id,
                    mode_to_apply,
                    config_to_apply,
                )
                .await
            {
                tracing::warn!(
                    %session_id,
                    %error,
                    "preferred session controls were rejected by the new session"
                );
            }
            let mut controls = self.session_controls.write().await;
            if let Some(stored) = controls.get_mut(&session_id) {
                let settled = agent_session_config_options_from_acp(stored.config_options.clone());
                stored.asserted_config_values = asserted_from_preferred(&preferred_map, &settled);
            }
        }
        if let Some(catalog) = self.grok_catalog.lock().await.clone() {
            let mut controls = self.session_controls.write().await;
            if let Some(stored) = controls.get_mut(&session_id) {
                apply_grok_catalog_to_stored_options(&mut stored.config_options, &catalog);
            }
        }

        self.emit_derived_session_controls(session_id).await;
    }

    pub(in crate::manager) async fn session_controls_snapshot(
        &self,
        session_id: AgentSessionId,
    ) -> AgentSessionControlsSnapshot {
        let goal_actions = self.resolved_goal_actions().await;
        let stored = {
            let controls = self.session_controls.read().await;
            controls.get(&session_id).map(|controls| {
                let (modes, current_mode) =
                    session_modes_from_config_options(&controls.config_options);
                (
                    modes,
                    current_mode,
                    agent_session_config_options_from_acp(controls.config_options.clone()),
                    controls.available_commands.clone(),
                    controls.goal.clone(),
                    controls.async_tasks.clone(),
                    controls.prompt_suggestion.clone(),
                )
            })
        };
        let capabilities = Some(self.capabilities.read().await.clone());
        let Some((
            modes,
            current_mode,
            config_options,
            available_commands,
            goal,
            async_tasks,
            prompt_suggestion,
        )) = stored
        else {
            return AgentSessionControlsSnapshot {
                modes: Vec::new(),
                current_mode: None,
                config_options: Vec::new(),
                capabilities,
                available_commands: None,
                goal: None,
                goal_actions,
                async_tasks: Vec::new(),
                prompt_suggestion: None,
            };
        };
        AgentSessionControlsSnapshot {
            modes,
            current_mode,
            config_options,
            capabilities,
            available_commands,
            goal,
            goal_actions,
            async_tasks,
            prompt_suggestion,
        }
    }

    pub(in crate::manager) async fn emit_derived_session_controls(
        &self,
        session_id: AgentSessionId,
    ) {
        let snapshot = self.session_controls_snapshot(session_id).await;
        self.emit_controls_snapshot(session_id, &snapshot);
    }

    pub(in crate::manager) fn emit_controls_snapshot(
        &self,
        session_id: AgentSessionId,
        controls: &AgentSessionControlsSnapshot,
    ) {
        self.emit(
            Some(session_id),
            None,
            AgentEvent::SessionModes {
                modes: controls.modes.clone(),
                current: controls.current_mode.clone(),
            },
        );
        self.emit(
            Some(session_id),
            None,
            AgentEvent::SessionConfigOptions {
                options: controls.config_options.clone(),
            },
        );
        if let Some(commands) = controls.available_commands.clone() {
            self.emit(
                Some(session_id),
                None,
                AgentEvent::AvailableCommands { commands },
            );
        }
        if controls.goal.is_some() || controls.goal_actions.is_some() {
            self.emit(
                Some(session_id),
                None,
                AgentEvent::GoalUpdated {
                    goal: controls.goal.clone(),
                    goal_actions: controls.goal_actions.clone(),
                },
            );
        }
        if !controls.async_tasks.is_empty() {
            self.emit(
                Some(session_id),
                None,
                AgentEvent::AsyncTasksUpdated {
                    tasks: controls.async_tasks.clone(),
                },
            );
        }
        if controls.prompt_suggestion.is_some() {
            self.emit(
                Some(session_id),
                None,
                AgentEvent::PromptSuggestionUpdated {
                    suggestion: controls.prompt_suggestion.clone(),
                },
            );
        }
    }
}
