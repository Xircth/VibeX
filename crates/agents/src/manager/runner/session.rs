use std::time::Duration;

use super::*;

const SESSION_CONTENTION_RETRIES: u32 = 4;
const SESSION_CONTENTION_BACKOFF: Duration = Duration::from_millis(400);

impl AgentConnectionRunner {
    pub(in crate::manager) async fn ensure_acp_session(
        &self,
        conn: &ConnectionTo<Agent>,
        working_dir: &Path,
        session_id: AgentSessionId,
        companion_capabilities: CompanionCapabilities,
    ) -> Result<String, acp::Error> {
        if let Some(existing) = self.session_map.read().await.get(&session_id).cloned()
            && crate::is_restorable_acp_session_id(&existing)
        {
            self.emit_session_bind_ready(session_id, existing.clone());
            return Ok(existing);
        }

        // session/new is only for PrepareSession (a conversation that does not
        // yet own a thread) and for fork, which creates a new Conversation.
        // Prompt must never reach here: that would stuff a new Codex thread
        // into an existing VibeX Conversation.
        let acp_session_id = self
            .new_acp_session(conn, working_dir, session_id, companion_capabilities, None)
            .await?;
        Ok(acp_session_id)
    }

    pub(in crate::manager) async fn load_or_new_acp_session(
        &self,
        conn: &ConnectionTo<Agent>,
        working_dir: &Path,
        session_id: AgentSessionId,
        external_session_id: String,
        support: SessionRestoreSupport,
        companion_capabilities: CompanionCapabilities,
    ) -> AgentResult<(String, Option<crate::conversation::SessionRecoveryStrategy>)> {
        crate::session_bind_metrics::record_connect_start(
            session_id.0,
            &self.snapshot.agent_id,
            true,
            if support.resume {
                "resume"
            } else if support.load {
                "load"
            } else {
                "new"
            },
        );
        let mapped = self.session_map.read().await.get(&session_id).cloned();
        match mapped_resume_action(mapped.as_deref(), &external_session_id) {
            MappedResume::Reuse(existing) => {
                self.emit_session_bind_ready(session_id, existing.clone());
                return Ok((existing, None));
            }
            MappedResume::LoadRequested { unbind_stale } => {
                if unbind_stale {
                    tracing::warn!(
                        session_id = %session_id.0,
                        bound = %mapped.as_deref().unwrap_or(""),
                        requested = %external_session_id,
                        "ACP session map pointed at a different external id; restoring the conversation's stored session"
                    );
                    self.session_map.write().await.remove(&session_id);
                }
            }
        }

        let session_working_dir =
            self.resolve_session_working_dir(working_dir, &external_session_id);
        let wants_prompt_suggestions = self.wants_prompt_suggestions(session_id).await;
        let mut resume_auth_error: Option<acp::Error> = None;
        {
            // Always attempt resume for a known sid, even when the agent did
            // not advertise it. Mid-conversation session/new is forbidden.
            *self.pending_session_id.lock().await = Some(session_id);
            self.emit_connection_status(AgentConnectionStatus::Recovering, None, Some(session_id));
            let resume_result = self
                .send_resume_session_rpc(
                    conn,
                    &session_working_dir,
                    session_id,
                    &external_session_id,
                    companion_capabilities,
                    wants_prompt_suggestions,
                )
                .await;
            match resume_result {
                Ok((response, raw_models)) => {
                    self.record_session_header(session_id, &external_session_id);
                    self.session_map
                        .write()
                        .await
                        .insert(session_id, external_session_id.clone());
                    self.emit_session_linked(session_id, external_session_id.clone())
                        .await;
                    let (modes, config_options, vendor_config) =
                        session_controls_with_models_and_vendor_fallback(
                            response.modes,
                            response.config_options,
                            response.meta.as_ref(),
                            raw_models.as_ref(),
                            self.snapshot.agent_id.as_str(),
                        );
                    self.emit_session_controls(
                        conn,
                        &external_session_id,
                        session_id,
                        modes,
                        config_options,
                        vendor_config,
                        response.meta.as_ref(),
                        session_model_ids(raw_models.as_ref()),
                    )
                    .await;
                    *self.pending_session_id.lock().await = None;
                    return Ok((
                        external_session_id,
                        Some(crate::conversation::SessionRecoveryStrategy::Resumed),
                    ));
                }
                Err(error) => {
                    *self.pending_session_id.lock().await = None;
                    crate::session_bind_metrics::record_resume_fell_through_to_load(
                        session_id.0,
                        &error.to_string(),
                    );
                    if matches!(
                        classify_session_load_error(&error),
                        SessionLoadFailureReason::AuthenticationRequired { .. }
                    ) {
                        resume_auth_error = Some(error);
                    }
                }
            }
        }

        // Always try load after resume misses. Some agents implement load
        // without advertising it; falling through to session/new would stitch a
        // cold thread into this conversation.
        let attempted_load = true;
        let load_result = if attempted_load {
            *self.pending_session_id.lock().await = Some(session_id);
            self.begin_load_replay(&external_session_id).await;
            self.emit_connection_status(AgentConnectionStatus::Recovering, None, Some(session_id));
            let result = self
                .send_load_session_rpc(
                    conn,
                    &session_working_dir,
                    session_id,
                    &external_session_id,
                    companion_capabilities,
                    wants_prompt_suggestions,
                )
                .await;
            self.end_load_replay(&external_session_id, result.is_ok())
                .await;
            *self.pending_session_id.lock().await = None;
            result
        } else if let Some(error) = resume_auth_error {
            Err(error)
        } else {
            Err(acp::Error::method_not_found())
        };

        match load_result {
            Ok((response, raw_models)) => {
                self.record_session_header(session_id, &external_session_id);
                self.session_map
                    .write()
                    .await
                    .insert(session_id, external_session_id.clone());
                self.emit_session_linked(session_id, external_session_id.clone())
                    .await;
                let (modes, config_options, vendor_config) =
                    session_controls_with_models_and_vendor_fallback(
                        response.modes,
                        response.config_options,
                        response.meta.as_ref(),
                        raw_models.as_ref(),
                        self.snapshot.agent_id.as_str(),
                    );
                self.emit_session_controls(
                    conn,
                    &external_session_id,
                    session_id,
                    modes,
                    config_options,
                    vendor_config,
                    response.meta.as_ref(),
                    session_model_ids(raw_models.as_ref()),
                )
                .await;
                Ok((
                    external_session_id,
                    Some(crate::conversation::SessionRecoveryStrategy::Loaded),
                ))
            }
            Err(error) => {
                self.resolve_session_load_failure(
                    conn,
                    working_dir,
                    session_id,
                    &external_session_id,
                    companion_capabilities,
                    error,
                    attempted_load,
                )
                .await
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(in crate::manager) async fn resolve_session_load_failure(
        &self,
        conn: &ConnectionTo<Agent>,
        working_dir: &Path,
        session_id: AgentSessionId,
        failed_sid: &str,
        companion_capabilities: CompanionCapabilities,
        error: acp::Error,
        attempted_load: bool,
    ) -> AgentResult<(String, Option<crate::conversation::SessionRecoveryStrategy>)> {
        let a_level = classify_session_load_error(&error);
        let classified = classified_load_failure_reason(&a_level, &error.to_string(), failed_sid);
        let action = decide_session_load_failure(
            &self.snapshot.agent_id,
            &a_level,
            classified.as_ref(),
            attempted_load,
            is_method_not_found_error(&error),
        );
        tracing::info!(
            session_id = %session_id.0,
            failed_sid,
            code = classified.as_ref().map(|reason| reason.code()).unwrap_or("none"),
            ?action,
            attempted_load,
            "ACP session/load classified"
        );

        match action {
            SessionLoadFailureAction::StopForAuth { message } => {
                return self.stop_connect_for_auth(session_id, message).await;
            }
            SessionLoadFailureAction::Banner(reason) => {
                self.emit_session_load_failed(session_id, reason.clone());
                self.emit_connection_status(
                    AgentConnectionStatus::Failed,
                    Some(error.to_string()),
                    Some(session_id),
                );
                return Err(AgentError::SessionLoadFailed(reason));
            }
            SessionLoadFailureAction::ToastThenNew => {
                self.emit(
                    Some(session_id),
                    None,
                    AgentEvent::Error {
                        error: AgentErrorEvent {
                            message: format!("Failed to load session, starting new: {error}"),
                            code: None,
                            raw: None,
                        },
                    },
                );
            }
            SessionLoadFailureAction::SilentNew => {}
        }

        // Last-resort session/new on THIS conversation's connection only.
        // The previous sid is not passed to the agent (that would mix threads);
        // the Conversation event log records continues_from for UI continuity.
        let acp_session_id = self
            .new_acp_session(
                conn,
                working_dir,
                session_id,
                companion_capabilities,
                Some(failed_sid),
            )
            .await
            .map_err(|error| map_acp_session_error("ACP session/new after load failed", error))?;
        Ok((
            acp_session_id,
            Some(crate::conversation::SessionRecoveryStrategy::CreatedNewSession),
        ))
    }

    pub(in crate::manager) async fn stop_connect_for_auth(
        &self,
        session_id: AgentSessionId,
        message: String,
    ) -> AgentResult<(String, Option<crate::conversation::SessionRecoveryStrategy>)> {
        self.emit_connection_status(
            AgentConnectionStatus::Failed,
            Some(message.clone()),
            Some(session_id),
        );
        self.emit(
            Some(session_id),
            None,
            AgentEvent::Error {
                error: AgentErrorEvent {
                    message: message.clone(),
                    code: Some("auth_required".into()),
                    raw: None,
                },
            },
        );
        Err(AgentError::AuthenticationRequired(message))
    }

    /// Fork the live ACP session for `session_id`, returning the new (forked)
    /// external session id the agent created (branched from the original's
    /// context). Requires the agent to have advertised `session/fork`.
    pub(in crate::manager) async fn fork_acp_session(
        &self,
        conn: &ConnectionTo<Agent>,
        working_dir: &Path,
        session_id: AgentSessionId,
        companion_capabilities: CompanionCapabilities,
        fork_point: Option<crate::ForkPoint>,
    ) -> Result<String, acp::Error> {
        let acp_session_id = self
            .ensure_acp_session(conn, working_dir, session_id, companion_capabilities)
            .await?;
        let wants_prompt_suggestions = self.wants_prompt_suggestions(session_id).await;
        let request = AcpForkSessionRequest {
            session_id: acp_session_id,
            cwd: working_dir.to_path_buf(),
            meta: crate::session_meta::session_request_meta(
                &self.snapshot.agent_id,
                fork_point.as_ref(),
                wants_prompt_suggestions,
            )
            .map(serde_json::Value::Object),
        };
        let response = conn.send_request(request).block_task().await?;
        Ok(response.session_id.0.to_string())
    }

    pub(in crate::manager) async fn new_acp_session(
        &self,
        conn: &ConnectionTo<Agent>,
        working_dir: &Path,
        session_id: AgentSessionId,
        companion_capabilities: CompanionCapabilities,
        continues_from: Option<&str>,
    ) -> Result<String, acp::Error> {
        let mut request = NewSessionRequest::new(working_dir.to_path_buf());
        if self.capabilities.read().await.additional_directories {
            request = request.additional_directories(self.snapshot.additional_directories.clone());
        }
        request.mcp_servers = self
            .session_mcp_servers_with_companion(working_dir, session_id, companion_capabilities)
            .await;
        let wants_prompt_suggestions = self.wants_prompt_suggestions(session_id).await;
        if let Some(meta) = crate::session_meta::session_request_meta(
            &self.snapshot.agent_id,
            None,
            wants_prompt_suggestions,
        ) {
            request = request.meta(meta);
        }
        *self.pending_session_id.lock().await = Some(session_id);
        self.emit_connection_status(AgentConnectionStatus::Connecting, None, Some(session_id));
        let response = conn
            .send_request(RawNewSessionRequest(request))
            .block_task()
            .await
            .and_then(deserialize_raw_session_response::<NewSessionResponse>);
        let (response, raw_models) = match response {
            Ok(response) => response,
            Err(error) => {
                *self.pending_session_id.lock().await = None;
                return Err(error);
            }
        };
        let acp_session_id = response.session_id.0.to_string();
        if let Some(previous_sid) = continues_from {
            self.record_continuation_header(session_id, &acp_session_id, previous_sid);
        } else {
            self.record_session_header(session_id, &acp_session_id);
        }
        self.session_map
            .write()
            .await
            .insert(session_id, acp_session_id.clone());
        self.emit_session_linked(session_id, acp_session_id.clone())
            .await;
        let (modes, config_options, vendor_config) =
            session_controls_with_models_and_vendor_fallback(
                response.modes,
                response.config_options,
                response.meta.as_ref(),
                raw_models.as_ref(),
                self.snapshot.agent_id.as_str(),
            );
        // `emit_session_controls` consumes the saved preferences. Snapshot them
        // first so ZCode can still confirm the mode that creates its backend.
        let zcode_preferences = if self.snapshot.agent_id.as_str() == "zcode" {
            self.preferred_controls
                .read()
                .await
                .get(&session_id)
                .cloned()
        } else {
            None
        };
        self.emit_session_controls(
            conn,
            &acp_session_id,
            session_id,
            modes,
            config_options,
            vendor_config,
            response.meta.as_ref(),
            session_model_ids(raw_models.as_ref()),
        )
        .await;
        if self.snapshot.agent_id.as_str() == "zcode"
            && let Err(error) = self
                .confirm_zcode_backend_session(
                    conn,
                    &acp_session_id,
                    session_id,
                    zcode_preferences.as_ref(),
                )
                .await
        {
            self.session_map.write().await.remove(&session_id);
            *self.pending_session_id.lock().await = None;
            self.emit_connection_status(
                AgentConnectionStatus::Failed,
                Some(error.to_string()),
                Some(session_id),
            );
            return Err(error);
        }
        *self.pending_session_id.lock().await = None;
        Ok(acp_session_id)
    }

    async fn send_resume_session_rpc(
        &self,
        conn: &ConnectionTo<Agent>,
        working_dir: &Path,
        session_id: AgentSessionId,
        external_session_id: &str,
        companion_capabilities: CompanionCapabilities,
        wants_prompt_suggestions: bool,
    ) -> Result<(ResumeSessionResponse, Option<serde_json::Value>), acp::Error> {
        let mut last_contention = None;
        for attempt in 0..=SESSION_CONTENTION_RETRIES {
            if attempt > 0 {
                tracing::info!(
                    attempt,
                    session_id = %session_id.0,
                    "ACP session/resume retry after contention"
                );
                tokio::time::sleep(SESSION_CONTENTION_BACKOFF).await;
            }
            let mut request = ResumeSessionRequest::new(
                SessionId::new(external_session_id.to_string()),
                working_dir.to_path_buf(),
            );
            if self.capabilities.read().await.additional_directories {
                request =
                    request.additional_directories(self.snapshot.additional_directories.clone());
            }
            request = request.mcp_servers(
                self.session_mcp_servers_with_companion(
                    working_dir,
                    session_id,
                    companion_capabilities,
                )
                .await,
            );
            if let Some(meta) = crate::session_meta::session_request_meta(
                &self.snapshot.agent_id,
                None,
                wants_prompt_suggestions,
            ) {
                request = request.meta(meta);
            }
            match conn
                .send_request(RawResumeSessionRequest(request))
                .block_task()
                .await
                .and_then(deserialize_raw_session_response::<ResumeSessionResponse>)
            {
                Ok(response) => return Ok(response),
                Err(error) if is_session_contention_error(&error.to_string()) => {
                    last_contention = Some(error);
                }
                Err(error) => return Err(error),
            }
        }
        Err(last_contention.expect("resume contention retry records an error"))
    }

    async fn send_load_session_rpc(
        &self,
        conn: &ConnectionTo<Agent>,
        working_dir: &Path,
        session_id: AgentSessionId,
        external_session_id: &str,
        companion_capabilities: CompanionCapabilities,
        wants_prompt_suggestions: bool,
    ) -> Result<(LoadSessionResponse, Option<serde_json::Value>), acp::Error> {
        let mut last_contention = None;
        for attempt in 0..=SESSION_CONTENTION_RETRIES {
            if attempt > 0 {
                tracing::info!(
                    attempt,
                    session_id = %session_id.0,
                    "ACP session/load retry after contention"
                );
                tokio::time::sleep(SESSION_CONTENTION_BACKOFF).await;
            }
            let mut request = LoadSessionRequest::new(
                SessionId::new(external_session_id.to_string()),
                working_dir.to_path_buf(),
            );
            if self.capabilities.read().await.additional_directories {
                request =
                    request.additional_directories(self.snapshot.additional_directories.clone());
            }
            request = request.mcp_servers(
                self.session_mcp_servers_with_companion(
                    working_dir,
                    session_id,
                    companion_capabilities,
                )
                .await,
            );
            if let Some(meta) = crate::session_meta::session_request_meta(
                &self.snapshot.agent_id,
                None,
                wants_prompt_suggestions,
            ) {
                request = request.meta(meta);
            }
            match conn
                .send_request(RawLoadSessionRequest(request))
                .block_task()
                .await
                .and_then(deserialize_raw_session_response::<LoadSessionResponse>)
            {
                Ok(response) => return Ok(response),
                Err(error) if is_session_contention_error(&error.to_string()) => {
                    last_contention = Some(error);
                }
                Err(error) => return Err(error),
            }
        }
        Err(last_contention.expect("load contention retry records an error"))
    }

    fn resolve_session_working_dir(
        &self,
        default_working_dir: &Path,
        external_session_id: &str,
    ) -> PathBuf {
        match self.snapshot.agent_id.as_str() {
            "grok" => {
                let grok_home = self
                    .snapshot
                    .env
                    .get("GROK_HOME")
                    .map(String::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(PathBuf::from)
                    .or_else(crate::grok_usage::grok_home_dir);
                resolve_grok_session_working_dir_in_home(
                    grok_home.as_deref(),
                    default_working_dir,
                    external_session_id,
                )
            }
            "claude_code" => {
                let claude_home = self
                    .snapshot
                    .env
                    .get("CLAUDE_CONFIG_DIR")
                    .map(String::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(PathBuf::from)
                    .or_else(|| {
                        std::env::var_os("CLAUDE_CONFIG_DIR")
                            .filter(|value| !value.is_empty())
                            .map(PathBuf::from)
                    })
                    .or_else(|| dirs::home_dir().map(|home| home.join(".claude")));
                resolve_claude_session_working_dir_in_home(
                    claude_home.as_deref(),
                    default_working_dir,
                    external_session_id,
                )
            }
            _ => default_working_dir.to_path_buf(),
        }
    }
}

pub(in crate::manager) fn resolve_claude_session_working_dir_in_home(
    claude_home: Option<&Path>,
    default_working_dir: &Path,
    external_session_id: &str,
) -> PathBuf {
    let trimmed = external_session_id.trim();
    if trimmed.is_empty() {
        return default_working_dir.to_path_buf();
    }
    let Some(projects_dir) = claude_home.map(|home| home.join("projects")) else {
        return default_working_dir.to_path_buf();
    };
    let Ok(entries) = std::fs::read_dir(projects_dir) else {
        return default_working_dir.to_path_buf();
    };
    let file_name = format!("{trimmed}.jsonl");
    let mut existing_dir_fallback: Option<PathBuf> = None;
    let mut any_recorded_fallback: Option<PathBuf> = None;
    for entry in entries.flatten() {
        let session_path = entry.path().join(&file_name);
        if !session_path.is_file() {
            continue;
        }
        let Ok(file) = std::fs::File::open(&session_path) else {
            continue;
        };
        use std::io::BufRead as _;
        let reader = std::io::BufReader::new(file);
        for line in reader.lines().take(24).flatten() {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            let Some(cwd_str) = value
                .get("cwd")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|cwd| !cwd.is_empty())
            else {
                continue;
            };
            let candidate = PathBuf::from(cwd_str);
            if candidate == default_working_dir {
                return default_working_dir.to_path_buf();
            }
            if existing_dir_fallback.is_none() && candidate.is_dir() {
                existing_dir_fallback = Some(candidate.clone());
            }
            if any_recorded_fallback.is_none() {
                any_recorded_fallback = Some(candidate);
            }
            break;
        }
    }
    existing_dir_fallback
        .or(any_recorded_fallback)
        .unwrap_or_else(|| default_working_dir.to_path_buf())
}

pub(in crate::manager) fn resolve_grok_session_working_dir_in_home(
    grok_home: Option<&Path>,
    default_working_dir: &Path,
    external_session_id: &str,
) -> PathBuf {
    let trimmed = external_session_id.trim();
    if trimmed.is_empty() {
        return default_working_dir.to_path_buf();
    }
    let Some(sessions_dir) = grok_home.map(|home| home.join("sessions")) else {
        return default_working_dir.to_path_buf();
    };
    let Ok(entries) = std::fs::read_dir(sessions_dir) else {
        return default_working_dir.to_path_buf();
    };
    let mut existing_dir_fallback: Option<PathBuf> = None;
    let mut any_recorded_fallback: Option<PathBuf> = None;
    for entry in entries.flatten() {
        let summary_path = entry.path().join(trimmed).join("summary.json");
        if !summary_path.is_file() {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(&summary_path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let Some(cwd_str) = value
            .get("info")
            .and_then(|info| info.get("cwd"))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|cwd| !cwd.is_empty())
        else {
            continue;
        };
        let candidate = PathBuf::from(cwd_str);
        if candidate == default_working_dir {
            return default_working_dir.to_path_buf();
        }
        if existing_dir_fallback.is_none() && candidate.is_dir() {
            existing_dir_fallback = Some(candidate.clone());
        }
        if any_recorded_fallback.is_none() {
            any_recorded_fallback = Some(candidate);
        }
    }
    existing_dir_fallback
        .or(any_recorded_fallback)
        .unwrap_or_else(|| default_working_dir.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_grok_session_working_dir_uses_recorded_cwd_when_session_lives_elsewhere() {
        let tmp = tempfile::tempdir().unwrap();
        let grok_home = tmp.path().join(".grok");
        let worktree_cwd = tmp.path().join("worktree-repo");
        let parent_cwd = tmp.path().join("parent-repo");
        std::fs::create_dir_all(&worktree_cwd).unwrap();
        std::fs::create_dir_all(&parent_cwd).unwrap();

        let sid = "01a18b38-1111-2222-3333-444444444444";
        let encoded_dir = grok_home
            .join("sessions")
            .join("encoded-worktree")
            .join(sid);
        std::fs::create_dir_all(&encoded_dir).unwrap();
        std::fs::write(
            encoded_dir.join("summary.json"),
            serde_json::json!({
                "info": {
                    "id": sid,
                    "cwd": worktree_cwd.to_string_lossy(),
                }
            })
            .to_string(),
        )
        .unwrap();

        let resolved = resolve_grok_session_working_dir_in_home(Some(&grok_home), &parent_cwd, sid);
        assert_eq!(resolved, worktree_cwd);
    }

    #[test]
    fn resolve_claude_session_working_dir_uses_recorded_cwd_when_session_lives_elsewhere() {
        let tmp = tempfile::tempdir().unwrap();
        let claude_home = tmp.path().join(".claude");
        let worktree_cwd = tmp.path().join("worktree-repo");
        let parent_cwd = tmp.path().join("parent-repo");
        std::fs::create_dir_all(&worktree_cwd).unwrap();
        std::fs::create_dir_all(&parent_cwd).unwrap();

        let sid = "37b3b719-a910-4c9e-9954-2db1b05b24de";
        let project_dir = claude_home.join("projects").join("encoded-worktree");
        std::fs::create_dir_all(&project_dir).unwrap();
        std::fs::write(
            project_dir.join(format!("{sid}.jsonl")),
            format!(
                "{}\n",
                serde_json::json!({
                    "type": "user",
                    "sessionId": sid,
                    "cwd": worktree_cwd.to_string_lossy(),
                })
            ),
        )
        .unwrap();

        let resolved =
            resolve_claude_session_working_dir_in_home(Some(&claude_home), &parent_cwd, sid);
        assert_eq!(resolved, worktree_cwd);
    }

    #[test]
    fn read_chain_in_falls_back_across_agents_and_releases_empty_failed_replay_claim() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let s1 = "a1096fb6-7a70-4bb7-85c1-f7217f751b52";
        let s2 = "01a18b38-10cb-77b1-9951-3efe7341ae44";

        let h1 = crate::acp_transcript::TranscriptHeader::new("antigravity", s1, "/repo", 100);
        crate::acp_transcript::claim_replay_transcript_in(root, "antigravity", s1, &h1);
        crate::acp_transcript::append_line_in(
            root,
            "antigravity",
            s1,
            &serde_json::to_string(&crate::acp_transcript::TranscriptEntry {
                t: 101,
                k: crate::acp_transcript::EntryKind::Prompt,
                p: serde_json::json!([{"type": "text", "text": "turn 1"}]),
                steer: false,
            })
            .unwrap(),
        );

        // Simulate a failed session/load replay claim in `grok` for `s1`.
        let h1_grok = crate::acp_transcript::TranscriptHeader::new("grok", s1, "/repo", 200);
        assert!(crate::acp_transcript::claim_replay_transcript_in(
            root, "grok", s1, &h1_grok
        ));
        let h2 =
            crate::acp_transcript::TranscriptHeader::new("grok", s2, "/repo", 201).continuing(s1);
        crate::acp_transcript::claim_replay_transcript_in(root, "grok", s2, &h2);
        crate::acp_transcript::append_line_in(
            root,
            "grok",
            s2,
            &serde_json::to_string(&crate::acp_transcript::TranscriptEntry {
                t: 202,
                k: crate::acp_transcript::EntryKind::Prompt,
                p: serde_json::json!([{"type": "text", "text": "turn 2"}]),
                steer: false,
            })
            .unwrap(),
        );

        // Even while the 0-entry claim exists in `grok`, `read_chain_in` finds `antigravity/s1.jsonl`.
        let chain = crate::acp_transcript::read_chain_in(root, "grok", s2);
        assert_eq!(chain.entries.len(), 2);

        // Releasing the failed replay claim removes `grok/s1.jsonl` but preserves `antigravity/s1.jsonl`.
        crate::acp_transcript::release_unrecorded_replay_claim_in(root, "grok", s1);
        assert!(
            !crate::acp_transcript::transcript_path_in(root, "grok", s1)
                .unwrap()
                .exists()
        );
        assert!(
            crate::acp_transcript::transcript_path_in(root, "antigravity", s1)
                .unwrap()
                .exists()
        );
    }
}
