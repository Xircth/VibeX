use super::*;

impl SessionControlState {
    pub(in crate::manager) fn merge_turn_usage(&mut self, incoming: &AgentUsage) {
        self.last_turn_usage = Some(crate::merge_agent_usage(
            self.last_turn_usage.clone(),
            incoming,
        ));
    }
}

impl AcpClientBridge {
    /// Grok has no ACP `usage_update`. Occupancy (`_meta.totalTokens`) plus the
    /// model's window become a synthetic `AgentEvent::Usage` so the composer
    /// ring and per-turn token display have facts to show.
    pub(in crate::manager) async fn maybe_emit_grok_usage(
        &self,
        session_id: Option<AgentSessionId>,
        meta: Option<&serde_json::Map<String, serde_json::Value>>,
    ) {
        if self.agent_id.as_str() != "grok" {
            return;
        }
        let Some(used) = grok_usage::occupancy_from_meta(meta) else {
            return;
        };
        let Some(session_id) = session_id else {
            return;
        };
        let (window, last) = {
            let controls = self.session_controls.read().await;
            let state = controls.get(&session_id);
            let model = state.and_then(|state| current_grok_model_id(&state.config_options));
            let wire = model.as_deref().and_then(|model| {
                state.and_then(|state| state.grok_model_windows.get(model).copied())
            });
            let window = grok_usage::context_window_for_model(
                model.as_deref(),
                grok_usage::grok_home_dir().as_deref(),
                wire,
            );
            (window, state.and_then(|state| state.last_grok_usage))
        };
        let Some((used, size)) = grok_usage::live_usage_step(used, window, last) else {
            return;
        };
        let usage = {
            let mut controls = self.session_controls.write().await;
            let entry = controls.entry(session_id).or_default();
            entry.last_grok_usage = Some((used, size));
            let model = current_grok_model_id(&entry.config_options)
                .or_else(|| entry.last_model_id.clone());
            let usage = AgentUsage {
                used,
                limit: (size > 0).then_some(size),
                model,
                ..AgentUsage::default()
            };
            entry.merge_turn_usage(&usage);
            usage
        };
        send_manager_event(
            &self.event_tx,
            AgentConnectionManagerEvent {
                connection_id: self.connection_id,
                session_id: Some(session_id),
                prompt_id: None,
                event: AgentEvent::Usage { usage },
            },
        );
    }

    pub(in crate::manager) async fn emit_end_turn_usage(&self, session_id: Option<AgentSessionId>, mut usage: AgentUsage) {
        if let Some(session_id) = session_id {
            let mut controls = self.session_controls.write().await;
            let entry = controls.entry(session_id).or_default();
            if let Some(model) = usage.model.clone() {
                entry.last_model_id = Some(model);
            } else {
                usage.model = current_grok_model_id(&entry.config_options)
                    .or_else(|| entry.last_model_id.clone());
            }
            entry.merge_turn_usage(&usage);
        }
        send_manager_event(
            &self.event_tx,
            AgentConnectionManagerEvent {
                connection_id: self.connection_id,
                session_id,
                prompt_id: None,
                event: AgentEvent::Usage { usage },
            },
        );
    }

    pub(in crate::manager) async fn usage_with_session_model(
        &self,
        session_id: Option<AgentSessionId>,
        mut usage: AgentUsage,
    ) -> AgentUsage {
        let Some(session_id) = session_id else {
            return usage;
        };
        let mut controls = self.session_controls.write().await;
        let entry = controls.entry(session_id).or_default();
        if let Some(model) = usage.model.clone() {
            entry.last_model_id = Some(model);
        } else {
            usage.model = current_grok_model_id(&entry.config_options)
                .or_else(|| entry.last_model_id.clone());
        }
        entry.merge_turn_usage(&usage);
        usage
    }
}

pub(in crate::manager) fn session_update_is_end_turn_usage(update: &SessionUpdate) -> bool {
    serde_json::to_value(update)
        .ok()
        .is_some_and(|raw| crate::usage_from_session_update(&raw).is_some())
}

pub(in crate::manager) fn agent_usage_from_end_turn(usage: &agent_client_protocol::schema::v1::Usage) -> AgentUsage {
    let value = serde_json::to_value(usage).unwrap_or(serde_json::Value::Null);
    crate::prompt_usage_from_value(&value).unwrap_or_else(|| AgentUsage {
        model: crate::model_id_from_meta(value.get("_meta")),
        ..AgentUsage::default()
    })
}

pub(in crate::manager) fn agent_usage_from_acp(update: agent_client_protocol::schema::v1::UsageUpdate) -> AgentUsage {
    let (cost_amount, cost_currency) = update
        .cost
        .map(|cost| (Some(cost.amount), Some(cost.currency)))
        .unwrap_or((None, None));
    let meta = update.meta.as_ref().and_then(|meta| {
        serde_json::to_value(meta)
            .ok()
            .and_then(|value| value.as_object().cloned())
    });
    AgentUsage {
        used: update.used,
        limit: Some(update.size),
        input_tokens: meta_u64(meta.as_ref(), &["input_tokens", "prompt_tokens"]),
        output_tokens: meta_u64(meta.as_ref(), &["output_tokens", "completion_tokens"]),
        cache_read_tokens: meta_u64(meta.as_ref(), &["cached_read_tokens", "cache_read_tokens"]),
        cache_write_tokens: meta_u64(
            meta.as_ref(),
            &[
                "cached_write_tokens",
                "cache_write_tokens",
                "cache_creation_input_tokens",
            ],
        ),
        cost_amount,
        cost_currency,
        model: meta.as_ref().and_then(|meta| {
            crate::model_id_from_meta(Some(&serde_json::Value::Object(meta.clone())))
        }),
    }
}

