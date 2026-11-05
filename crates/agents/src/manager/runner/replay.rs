use super::*;

impl AgentConnectionRunner {
    /// ZCode's `session/new` is a placeholder. The backend session exists only
    /// after `mode` is set, including when the placeholder already reports that
    /// mode. Resume and load keep the existing backend session and skip this.
    pub(in crate::manager) async fn confirm_zcode_backend_session(
        &self,
        conn: &ConnectionTo<Agent>,
        acp_session_id: &str,
        session_id: AgentSessionId,
        preferences: Option<&crate::SessionControlPreferences>,
    ) -> Result<(), acp::Error> {
        let options = self
            .session_controls
            .read()
            .await
            .get(&session_id)
            .map(|state| state.config_options.clone())
            .unwrap_or_default();
        let (modes, _) = session_modes_from_config_options(&options);
        let available = modes.iter().map(|mode| mode.id.clone()).collect::<Vec<_>>();
        let preferred_mode = preferences.and_then(|preferences| preferences.mode.as_deref());
        let mut preferred_config = BTreeMap::new();
        if let Some(preferences) = preferences {
            for item in &preferences.config {
                preferred_config.insert(item.key.clone(), item.value.clone());
            }
        }
        let mode = crate::zcode::initial_mode(preferred_mode, &preferred_config, &available);
        let Some(selection) = find_config_override_selection(
            &options,
            "mode",
            &serde_json::Value::String(mode.clone()),
        ) else {
            return Err(acp::Error::new(
                -32603,
                crate::zcode::MODE_NOT_ADVERTISED.to_string(),
            ));
        };
        let response = match tokio::time::timeout(
            Duration::from_secs(60),
            conn.send_request(SetSessionConfigOptionRequest::new(
                SessionId::new(acp_session_id.to_string()),
                selection.config_id.clone(),
                selection.wire_value.clone(),
            ))
            .block_task(),
        )
        .await
        {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => return Err(error),
            Err(_elapsed) => {
                return Err(acp::Error::new(
                    -32603,
                    crate::zcode::MODE_CONFIRM_TIMEOUT.to_string(),
                ));
            }
        };
        {
            let mut controls = self.session_controls.write().await;
            let stored = controls.entry(session_id).or_default();
            stored.config_options = response.config_options;
        }
        let updated = agent_session_config_options_from_acp(
            self.session_controls
                .read()
                .await
                .get(&session_id)
                .map(|stored| stored.config_options.clone())
                .unwrap_or_default(),
        );
        let settled = updated
            .iter()
            .find(|option| option.key == selection.config_id)
            .and_then(|option| option.value.as_ref())
            .and_then(serde_json::Value::as_str);
        if let Err(message) = crate::zcode::require_confirmed_mode(settled, &mode) {
            return Err(acp::Error::new(-32603, message.to_string()));
        }
        self.record_confirmed_controls(session_id, Some(&mode), &[])
            .await;
        self.emit_derived_session_controls(session_id).await;
        Ok(())
    }

    pub(in crate::manager) async fn begin_load_replay(&self, external_session_id: &str) {
        if !records_acp_jsonl(self.snapshot.agent_id.as_str()) {
            return;
        }
        let agent_dir = jsonl_agent_dir(self.snapshot.agent_id.as_str());
        if !crate::acp_transcript::safe_component(external_session_id) {
            return;
        }
        let header = crate::acp_transcript::TranscriptHeader::new(
            self.snapshot.agent_id.as_str(),
            external_session_id,
            &self.snapshot.working_dir.to_string_lossy(),
            crate::acp_transcript::now_epoch_ms(),
        );
        if !crate::acp_transcript::claim_replay_transcript(&agent_dir, external_session_id, &header)
        {
            return;
        }
        *self.replay_hydrate.lock().await = Some(external_session_id.to_string());
    }

    pub(in crate::manager) async fn end_load_replay(
        &self,
        external_session_id: &str,
        load_succeeded: bool,
    ) {
        *self.replay_hydrate.lock().await = None;
        if !load_succeeded && records_acp_jsonl(self.snapshot.agent_id.as_str()) {
            let agent_dir = jsonl_agent_dir(self.snapshot.agent_id.as_str());
            crate::acp_transcript::release_unrecorded_replay_claim(&agent_dir, external_session_id);
        }
    }

    pub(in crate::manager) fn record_continuation_header(
        &self,
        session_id: AgentSessionId,
        new_session_id: &str,
        previous_session_id: &str,
    ) {
        if !records_acp_jsonl(self.snapshot.agent_id.as_str()) {
            return;
        }
        let agent_dir = jsonl_agent_dir(self.snapshot.agent_id.as_str());
        if !crate::acp_transcript::safe_component(new_session_id) {
            return;
        }
        let root = crate::acp_transcript::vibex_acp_transcripts_root();
        let local_sid = session_id.0.simple().to_string();
        let continues_from =
            if !crate::acp_transcript::read_chain_in(&root, &agent_dir, previous_session_id)
                .entries
                .is_empty()
            {
                previous_session_id
            } else if local_sid != new_session_id
                && !crate::acp_transcript::read_chain_in(&root, &agent_dir, &local_sid)
                    .entries
                    .is_empty()
            {
                local_sid.as_str()
            } else {
                previous_session_id
            };
        let header = crate::acp_transcript::TranscriptHeader::new(
            self.snapshot.agent_id.as_str(),
            new_session_id,
            &self.snapshot.working_dir.to_string_lossy(),
            crate::acp_transcript::now_epoch_ms(),
        )
        .continuing(continues_from);
        if !crate::acp_transcript::claim_replay_transcript(&agent_dir, new_session_id, &header) {
            drop(crate::acp_transcript::record_header(&agent_dir, &header));
        }
    }

    pub(in crate::manager) fn record_session_header(
        &self,
        session_id: AgentSessionId,
        acp_session_id: &str,
    ) {
        if !records_acp_jsonl(self.snapshot.agent_id.as_str()) {
            return;
        }
        let agent_dir = jsonl_agent_dir(self.snapshot.agent_id.as_str());
        if !crate::acp_transcript::safe_component(acp_session_id) {
            return;
        }
        let mut header = crate::acp_transcript::TranscriptHeader::new(
            self.snapshot.agent_id.as_str(),
            acp_session_id,
            &self.snapshot.working_dir.to_string_lossy(),
            crate::acp_transcript::now_epoch_ms(),
        );
        let root = crate::acp_transcript::vibex_acp_transcripts_root();
        let local_sid = session_id.0.simple().to_string();
        if acp_session_id != local_sid
            && !crate::acp_transcript::has_recorded_history(&agent_dir, acp_session_id)
            && !crate::acp_transcript::read_chain_in(&root, &agent_dir, &local_sid)
                .entries
                .is_empty()
        {
            header = header.continuing(&local_sid);
        }
        if !crate::acp_transcript::claim_replay_transcript(&agent_dir, acp_session_id, &header) {
            drop(crate::acp_transcript::record_header(&agent_dir, &header));
        }
    }

    pub(in crate::manager) async fn record_prompt(
        &self,
        acp_session_id: &str,
        blocks: &[ContentBlock],
    ) {
        if !records_acp_jsonl(self.snapshot.agent_id.as_str()) {
            return;
        }
        let agent_dir = jsonl_agent_dir(self.snapshot.agent_id.as_str());
        if !crate::acp_transcript::safe_component(acp_session_id) {
            return;
        }
        let Ok(payload) = serde_json::to_value(blocks) else {
            return;
        };
        let ack = crate::acp_transcript::record_entry(
            &agent_dir,
            acp_session_id,
            crate::acp_transcript::EntryKind::Prompt,
            payload,
        );
        let _ = tokio::time::timeout(Duration::from_millis(2000), ack).await;
    }

    pub(in crate::manager) async fn record_steer(
        &self,
        acp_session_id: &str,
        blocks: &[ContentBlock],
    ) {
        if !records_acp_jsonl(self.snapshot.agent_id.as_str()) {
            return;
        }
        let agent_dir = jsonl_agent_dir(self.snapshot.agent_id.as_str());
        if !crate::acp_transcript::safe_component(acp_session_id) {
            return;
        }
        let Ok(payload) = serde_json::to_value(blocks) else {
            return;
        };
        let ack = crate::acp_transcript::record_steer(&agent_dir, acp_session_id, payload);
        let _ = tokio::time::timeout(Duration::from_millis(2000), ack).await;
    }

    pub(in crate::manager) fn record_in_memory_update(
        &self,
        acp_session_id: &str,
        update: &SessionUpdate,
    ) {
        if !records_acp_jsonl(self.snapshot.agent_id.as_str()) {
            return;
        }
        let agent_dir = jsonl_agent_dir(self.snapshot.agent_id.as_str());
        if !crate::acp_transcript::safe_component(acp_session_id) {
            return;
        }
        let Ok(payload) = serde_json::to_value(update) else {
            return;
        };
        drop(crate::acp_transcript::record_entry(
            &agent_dir,
            acp_session_id,
            crate::acp_transcript::EntryKind::Update,
            payload,
        ));
    }

    pub(in crate::manager) async fn record_turn_end(
        &self,
        acp_session_id: &str,
        session_id: AgentSessionId,
        stop_reason: &str,
        duration_ms: u64,
        usage: Option<&crate::AgentUsage>,
    ) {
        if !records_acp_jsonl(self.snapshot.agent_id.as_str()) {
            return;
        }
        let agent_dir = jsonl_agent_dir(self.snapshot.agent_id.as_str());
        if !crate::acp_transcript::safe_component(acp_session_id) {
            return;
        }
        let mut payload = serde_json::json!({
            "stopReason": stop_reason,
            "durationMs": duration_ms,
        });
        let model = usage.and_then(|u| u.model.clone()).or_else(|| {
            self.session_controls.try_read().ok().and_then(|controls| {
                controls.get(&session_id).and_then(|state| {
                    current_grok_model_id(&state.config_options)
                        .or_else(|| state.last_model_id.clone())
                })
            })
        });
        if let Some(obj) = payload.as_object_mut() {
            if let Some(model) = model {
                obj.insert("model".to_string(), serde_json::Value::String(model));
            }
            if let Some(u) = usage {
                let mut usage_obj = serde_json::Map::new();
                let spend = u.input_tokens.unwrap_or(0)
                    + u.output_tokens.unwrap_or(0)
                    + u.cache_read_tokens.unwrap_or(0)
                    + u.cache_write_tokens.unwrap_or(0);
                if spend > 0 {
                    if let Some(v) = u.input_tokens {
                        usage_obj.insert("inputTokens".to_string(), serde_json::json!(v));
                    }
                    if let Some(v) = u.output_tokens {
                        usage_obj.insert("outputTokens".to_string(), serde_json::json!(v));
                    }
                    if let Some(v) = u.cache_write_tokens {
                        usage_obj
                            .insert("cacheCreationInputTokens".to_string(), serde_json::json!(v));
                    }
                    if let Some(v) = u.cache_read_tokens {
                        usage_obj.insert("cacheReadInputTokens".to_string(), serde_json::json!(v));
                    }
                }
                if u.used > 0 {
                    usage_obj.insert("contextUsed".to_string(), serde_json::json!(u.used));
                }
                if let Some(limit) = u.limit.filter(|v| *v > 0) {
                    usage_obj.insert("contextWindowMax".to_string(), serde_json::json!(limit));
                }
                if !usage_obj.is_empty() {
                    obj.insert("usage".to_string(), serde_json::Value::Object(usage_obj));
                }
            }
        }
        let ack = crate::acp_transcript::record_entry(
            &agent_dir,
            acp_session_id,
            crate::acp_transcript::EntryKind::TurnEnd,
            payload,
        );
        let _ = tokio::time::timeout(Duration::from_millis(2000), ack).await;
    }

    pub(in crate::manager) async fn emit_session_linked(
        &self,
        session_id: AgentSessionId,
        acp_session_id: String,
    ) {
        if !crate::is_restorable_acp_session_id(&acp_session_id) {
            tracing::error!(
                session_id = %session_id.0,
                acp_session_id,
                "refusing to persist a placeholder ACP session id"
            );
            return;
        }
        self.emit(
            Some(session_id),
            None,
            AgentEvent::SessionLinked {
                acp_session_id: acp_session_id.clone(),
                agent_id: self.snapshot.agent_id.clone(),
                capabilities: self.capabilities.read().await.clone(),
            },
        );
        self.emit_session_bind_ready(session_id, acp_session_id);
    }

    pub(in crate::manager) fn emit_session_bind_ready(
        &self,
        session_id: AgentSessionId,
        acp_session_id: String,
    ) {
        if !crate::is_restorable_acp_session_id(&acp_session_id) {
            return;
        }
        crate::session_bind_metrics::record_bind_ready(
            session_id.0,
            "bound",
            self.handshake_started.elapsed().as_millis(),
        );
        // Resume/load emit Recovering for the UI notice. Bind success must
        // restore Ready, otherwise session_controls_snapshot treats the live
        // connection as missing and the composer shows a stale NotFound.
        self.emit_connection_status(AgentConnectionStatus::Ready, None, Some(session_id));
        self.emit(
            Some(session_id),
            None,
            AgentEvent::SessionBindReady { acp_session_id },
        );
    }

    pub(in crate::manager) async fn session_mcp_servers_with_companion(
        &self,
        working_dir: &Path,
        session_id: AgentSessionId,
        companion_capabilities: CompanionCapabilities,
    ) -> Vec<acp::schema::v1::McpServer> {
        if !crate::profile_delivers_session_mcp(&self.snapshot.agent_id) {
            return Vec::new();
        }
        let mut servers = self.session_mcp_servers().await;
        // Restored sessions need the same companion as newly created sessions.
        if companion_capabilities.accepts_session_mcp_servers
            && let Some(injector) = &self.delegation_injector
        {
            match injector.injected_stdio_servers(CompanionInjectionContext {
                parent_connection_id: &self.snapshot.connection_id.0.to_string(),
                parent_conversation_id: session_id.0,
                agent_id: &self.snapshot.agent_id,
                working_root: working_dir,
                capabilities: companion_capabilities,
            }) {
                CompanionInjectionList::Injected(injected) => {
                    for server in injected {
                        servers.push(acp::schema::v1::McpServer::Stdio(
                            acp::schema::v1::McpServerStdio::new(server.name, server.command)
                                .args(server.args),
                        ));
                    }
                }
                CompanionInjectionList::Unsupported { code } => {
                    tracing::debug!(
                        code,
                        session_id = %session_id.0,
                        "companion MCP not injected; session continues without it"
                    );
                }
            }
            for (server, env) in injector.forwarded_stdio_servers(&self.snapshot.agent_id) {
                let mut stdio = acp::schema::v1::McpServerStdio::new(server.name, server.command)
                    .args(server.args);
                if !env.is_empty() {
                    let env_vars = env
                        .into_iter()
                        .map(|(k, v)| acp::schema::v1::EnvVariable::new(k, v))
                        .collect();
                    stdio = stdio.env(env_vars);
                }
                servers.push(acp::schema::v1::McpServer::Stdio(stdio));
            }
        }
        if self.snapshot.agent_id.as_str() == "omp" {
            let offer = wire_mcp_offer(&*self.capabilities.read().await);
            servers = crate::omp_mcp::merge_session_servers(
                servers,
                Self::omp_assigned_session_servers(&self.snapshot),
                crate::omp_mcp::SessionMcpOffer {
                    stdio: offer.stdio,
                    http: offer.http,
                    sse: offer.sse,
                },
            );
        }
        servers
    }

    pub(in crate::manager) async fn session_mcp_servers(&self) -> Vec<acp::schema::v1::McpServer> {
        let offer = wire_mcp_offer(&*self.capabilities.read().await);
        let mut servers = Vec::new();
        if let Some(injector) = &self.delegation_injector {
            for server in injector.remote_servers_for_agent(&self.snapshot.agent_id) {
                let headers = server
                    .headers
                    .into_iter()
                    .map(|(name, value)| acp::schema::v1::HttpHeader::new(name, value))
                    .collect();
                match server.transport {
                    InjectedRemoteMcpTransport::Http if offer.http => {
                        servers.push(acp::schema::v1::McpServer::Http(
                            acp::schema::v1::McpServerHttp::new(server.name, server.url)
                                .headers(headers),
                        ));
                    }
                    InjectedRemoteMcpTransport::Sse if offer.sse => {
                        servers.push(acp::schema::v1::McpServer::Sse(
                            acp::schema::v1::McpServerSse::new(server.name, server.url)
                                .headers(headers),
                        ));
                    }
                    _ => {}
                }
            }
        }
        servers
    }

    fn omp_assigned_session_servers(
        snapshot: &ManagedAgentConnectionSnapshot,
    ) -> Vec<acp::schema::v1::McpServer> {
        let mut environment = BTreeMap::new();
        for (key, value) in &snapshot.env {
            environment.insert(key.clone(), value.clone());
        }
        for (key, value) in &snapshot.launch_lock.env {
            environment.insert(key.clone(), value.clone());
        }
        let home = environment
            .get("HOME")
            .or_else(|| environment.get("USERPROFILE"))
            .map(PathBuf::from)
            .or_else(dirs::home_dir);
        let Some(home) = home else {
            return Vec::new();
        };
        crate::omp_mcp::session_servers(&crate::omp_mcp::mcp_json_path(&home, &environment))
    }
}
