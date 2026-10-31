use std::path::PathBuf;

use agents::{
    AgentId, AgentKind, AgentSessionConfigOverride, AgentSessionControlsSnapshot, AgentSessionId,
    EnsureAgentSessionInput, ResumeAgentSessionInput, SessionControlPreferences,
};
use db::models::{
    agent_management::SessionDefaultRepository,
    conversation::{BindingStatus, ConversationAgentBindingRecord, CreateConversationAgentBinding},
    session::Session,
    workspace::Workspace,
    workspace_repo::WorkspaceRepo,
};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::{
    ConversationSessionService,
    recover::{known_acp_session_id, restorable_agent_binding, resume_external_session_id},
};
use crate::ConversationServiceError;

impl ConversationSessionService {
    /// Immediately switch the conversation's live session mode. Mode is a
    /// Config Option category; the ACP adapter translates the intent to
    /// `session/set_mode` or `session/set_config_option`. Errors when there is
    /// no live session or a turn is in flight — the frontend then keeps the
    /// choice as a next-turn override.
    pub async fn set_session_mode(
        &self,
        conversation_id: Uuid,
        mode_id: String,
    ) -> Result<(), ConversationServiceError> {
        self.ctx
            .agent_runtime
            .set_session_mode(AgentSessionId(conversation_id), mode_id.clone())
            .await?;
        self.remember_session_controls_selection(conversation_id, Some(&mode_id), &[])
            .await;
        Ok(())
    }

    /// Immediately change one agent-advertised session config option
    /// (`session/set_config_option`, e.g. model or permission mode). Same
    /// caveats as [`Self::set_session_mode`].
    pub async fn set_session_config_option(
        &self,
        conversation_id: Uuid,
        key: String,
        value: serde_json::Value,
    ) -> Result<(), ConversationServiceError> {
        self.ctx
            .agent_runtime
            .set_session_config_option(AgentSessionId(conversation_id), key.clone(), value.clone())
            .await?;
        // Prompt-time overrides are string-valued (`session/set_config_option` accepts
        // either form for boolean options), so remember the selection in that domain.
        let value = value
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| value.to_string());
        self.remember_session_controls_selection(
            conversation_id,
            None,
            &[AgentSessionConfigOverride { key, value }],
        )
        .await;
        Ok(())
    }

    /// Record the conversation's effective session-control selection on its binding so
    /// a later `session/resume` (or the first `session/new` of a new conversation)
    /// can replay it. Best-effort: failing to remember a selection must not fail
    /// the turn or the control change that already succeeded.
    pub(super) async fn remember_session_controls_selection(
        &self,
        conversation_id: Uuid,
        mode: Option<&str>,
        config_overrides: &[AgentSessionConfigOverride],
    ) {
        persist_confirmed_session_controls(
            &self.ctx.deployment.db().pool,
            conversation_id,
            mode,
            config_overrides,
        )
        .await;
    }

    async fn resolved_session_control_preferences(
        &self,
        pool: &SqlitePool,
        agent_id: &AgentId,
        binding: Option<&ConversationAgentBindingRecord>,
    ) -> SessionControlPreferences {
        let agent_defaults = SessionDefaultRepository::new(pool.clone())
            .list_for_agent(agent_id)
            .await
            .unwrap_or_default()
            .into_iter()
            .filter_map(|record| {
                serde_json::from_str(&record.value_json)
                    .ok()
                    .map(|value| (record.option_id, value))
            })
            .collect::<Vec<_>>();
        session_control_preferences(binding, &agent_defaults)
    }

    /// Belt-and-suspenders after establish: preferred controls are already applied
    /// before the first broadcast (ADR-0071 §4). This only sends genuine diffs
    /// (in-memory driver, rejected remembered values).
    ///
    /// Best-effort and skip-if-current. A remembered value the agent no longer
    /// advertises is logged and dropped rather than failing session setup. This
    /// is not a new user choice, so it must not rewrite the binding.
    async fn replay_remembered_session_controls(
        &self,
        conversation_id: Uuid,
        runtime_session_id: AgentSessionId,
        binding: Option<&ConversationAgentBindingRecord>,
    ) {
        let remembered_mode = binding_mode_selection(binding);
        let remembered_config = binding_config_selection(binding);
        if remembered_mode.is_none() && remembered_config.is_empty() {
            return;
        }
        let Ok(current) = self
            .ctx
            .agent_runtime
            .session_controls_snapshot(runtime_session_id)
            .await
        else {
            return;
        };
        let plan = session_control_replay_plan(remembered_mode, remembered_config, &current);

        if let Some(mode) = plan.mode
            && let Err(error) = self
                .ctx
                .agent_runtime
                .set_session_mode(runtime_session_id, mode.clone())
                .await
        {
            tracing::warn!(
                %conversation_id,
                %mode,
                %error,
                "remembered session mode was rejected by the re-established session"
            );
        }

        for selection in plan.config_overrides {
            if let Err(error) = self
                .ctx
                .agent_runtime
                .set_session_config_option(
                    runtime_session_id,
                    selection.key.clone(),
                    serde_json::Value::String(selection.value.clone()),
                )
                .await
            {
                tracing::warn!(
                    %conversation_id,
                    option_id = %selection.key,
                    %error,
                    "remembered session config option was rejected by the re-established session"
                );
            }
        }
    }

    /// Ensure an existing conversation has a concrete ACP session and return
    /// its authoritative controls without sending a prompt. Default is
    /// reuse-first; `reload=true` drops the live connection first.
    pub async fn ensure_session_controls(
        &self,
        conversation_id: Uuid,
    ) -> Result<AgentSessionControlsSnapshot, ConversationServiceError> {
        self.ensure_session_controls_with_reload(conversation_id, false)
            .await
    }

    pub async fn ensure_session_controls_with_reload(
        &self,
        conversation_id: Uuid,
        reload: bool,
    ) -> Result<AgentSessionControlsSnapshot, ConversationServiceError> {
        let controls = {
            let turn_lock = self.turn_lock(conversation_id).await;
            let _turn_guard = turn_lock.lock().await;
            if reload {
                self.drop_live_agent_connection(conversation_id).await;
            }
            self.ensure_session_controls_locked(conversation_id, None)
                .await?
        };
        self.spawn_dispatch_queued_after_bind(conversation_id);
        Ok(controls)
    }

    /// Bind ACP for an existing conversation, optionally using a subdirectory
    /// already validated against the parent working root.
    pub async fn ensure_session_controls_with_working_dir(
        &self,
        conversation_id: Uuid,
        working_dir: Option<PathBuf>,
    ) -> Result<AgentSessionControlsSnapshot, ConversationServiceError> {
        let controls = {
            let turn_lock = self.turn_lock(conversation_id).await;
            let _turn_guard = turn_lock.lock().await;
            self.ensure_session_controls_locked(conversation_id, working_dir)
                .await?
        };
        self.spawn_dispatch_queued_after_bind(conversation_id);
        Ok(controls)
    }

    /// Start or resume the ACP process without sending a prompt or opening a
    /// turn. Returns `true` when the process was already running.
    pub async fn warmup_session_process(
        &self,
        conversation_id: Uuid,
    ) -> Result<bool, ConversationServiceError> {
        let session_id = AgentSessionId(conversation_id);
        if self
            .ctx
            .agent_runtime
            .session_has_ready_connection(session_id)
            .await
        {
            let _ = self.touch_session(conversation_id).await;
            return Ok(true);
        }
        self.ensure_session_controls(conversation_id).await?;
        let _ = self.touch_session(conversation_id).await;
        Ok(false)
    }

    pub async fn touch_session(
        &self,
        conversation_id: Uuid,
    ) -> Result<(), ConversationServiceError> {
        self.ctx
            .agent_runtime
            .touch_session(AgentSessionId(conversation_id))
            .await
            .map_err(Into::into)
    }

    /// `watch` registers the on-screen surface. The runtime repeats the bump.
    /// Forgetting the id does not disconnect the agent.
    pub async fn set_session_keepalive(
        &self,
        conversation_id: Uuid,
        watch: bool,
    ) -> Result<(), ConversationServiceError> {
        self.ctx
            .agent_runtime
            .set_session_keepalive(AgentSessionId(conversation_id), watch)
            .await
            .map_err(Into::into)
    }

    pub(super) async fn ensure_session_controls_locked(
        &self,
        conversation_id: Uuid,
        working_dir_override: Option<PathBuf>,
    ) -> Result<AgentSessionControlsSnapshot, ConversationServiceError> {
        self.interrupt_orphaned_turn(conversation_id).await?;
        let runtime_session_id = AgentSessionId(conversation_id);

        if let Some(bound_acp_session_id) = self
            .ctx
            .agent_runtime
            .bound_acp_session_id(runtime_session_id)
            .await
            && let Ok(controls) = self
                .ctx
                .agent_runtime
                .session_controls_snapshot(runtime_session_id)
                .await
        {
            let pool = &self.ctx.deployment.db().pool;
            if let Ok(Some(persisted_session)) = Session::find_by_id(pool, conversation_id).await {
                let agent_id = persisted_session.agent_id.clone().or_else(|| {
                    persisted_session
                        .executor
                        .as_deref()
                        .and_then(AgentKind::from_lenient)
                        .and_then(|kind| agents::AgentId::parse(kind.as_str()).ok())
                });
                let _ = Session::update_agent_metadata(
                    pool,
                    conversation_id,
                    Some(&bound_acp_session_id),
                    agent_id.as_ref(),
                )
                .await;
            }
            self.ctx
                .agent_runtime
                .commit_prepared_session(runtime_session_id)
                .await;
            return Ok(controls);
        }

        let pool = &self.ctx.deployment.db().pool;
        let mut persisted_session = Session::find_by_id(pool, conversation_id)
            .await?
            .ok_or_else(|| {
                ConversationServiceError::NotFound(format!(
                    "Conversation session {conversation_id} was not found"
                ))
            })?;
        let mut agent_id = persisted_session
            .agent_id
            .clone()
            .or_else(|| {
                persisted_session
                    .executor
                    .as_deref()
                    .and_then(AgentKind::from_lenient)
                    .and_then(|kind| agents::AgentId::parse(kind.as_str()).ok())
            })
            .ok_or_else(|| {
                ConversationServiceError::BadRequest(format!(
                    "Conversation {conversation_id} has no supported coding agent"
                ))
            })?;
        let bindings =
            ConversationAgentBindingRecord::list_for_conversation(pool, conversation_id).await?;
        if restorable_agent_binding(&bindings, &agent_id).is_none()
            && let Some(ext) = persisted_session
                .external_session_id
                .clone()
                .filter(|id| !is_placeholder_acp_session_id(id))
            && let Some(linked_agent) =
                linked_agent_for_external_session(pool, conversation_id, &ext, &bindings).await
            && linked_agent != agent_id
        {
            let member_prefers_linked_agent =
                crate::collaboration::load_conversation_member_session_config(
                    pool,
                    conversation_id,
                )
                .await
                .ok()
                .flatten()
                .and_then(|cfg| cfg.agent_id)
                .and_then(|raw| AgentId::parse(&raw).ok())
                .is_some_and(|member_agent| member_agent == linked_agent);
            if member_prefers_linked_agent {
                agent_id = linked_agent;
                persisted_session.agent_id = Some(agent_id.clone());
                let _ = Session::update_agent_metadata(
                    pool,
                    conversation_id,
                    Some(&ext),
                    Some(&agent_id),
                )
                .await;
            } else {
                let _ =
                    crate::jsonl_history::preserve_transcript_before_detach(pool, conversation_id)
                        .await;
                persisted_session.external_session_id = None;
                let _ = sqlx::query(
                    r#"UPDATE sessions
                       SET external_session_id = NULL,
                           updated_at = datetime('now', 'subsec')
                       WHERE id = ?"#,
                )
                .bind(conversation_id)
                .execute(pool)
                .await;
            }
        }
        let execution_workspace_id = crate::isolated_workspace::execution_workspace_id(
            &self.ctx,
            conversation_id,
            persisted_session.workspace_id,
        )
        .await
        .map_err(|error| ConversationServiceError::Internal(error.message))?;
        let workspace = match Workspace::find_by_id(pool, execution_workspace_id).await? {
            Some(workspace) => workspace,
            None if execution_workspace_id != persisted_session.workspace_id => {
                Workspace::find_by_id(pool, persisted_session.workspace_id)
                    .await?
                    .ok_or_else(|| {
                        ConversationServiceError::NotFound(format!(
                            "Workspace {} for conversation {conversation_id} was not found",
                            persisted_session.workspace_id
                        ))
                    })?
            }
            None => {
                return Err(ConversationServiceError::NotFound(format!(
                    "Workspace {} for conversation {conversation_id} was not found",
                    persisted_session.workspace_id
                )));
            }
        };
        let container_ref = self
            .ctx
            .deployment
            .container()
            .ensure_container_exists(&workspace)
            .await?;
        let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
        let working_dir = working_dir_override
            .map(|path| path.to_string_lossy().into_owned())
            .or_else(|| {
                self.ctx
                    .host
                    .resolve_working_dir(&workspace, &container_ref, &repos)
            })
            .unwrap_or_else(|| container_ref.clone());
        let additional_directories = self.ctx.host.resolve_additional_directories(
            &workspace,
            &container_ref,
            &repos,
            &working_dir,
        );
        let launch_settings = self.ctx.host.launch_settings(pool, &agent_id).await?;
        let latest_binding = bindings.last().cloned();
        let restorable_binding = restorable_agent_binding(&bindings, &agent_id);
        let mut preferences = self
            .resolved_session_control_preferences(
                pool,
                &agent_id,
                restorable_binding.or(latest_binding.as_ref()),
            )
            .await;
        preferences.wants_prompt_suggestions =
            session_wants_prompt_suggestions(pool, &persisted_session).await;
        let external_session_id = resume_external_session_id(
            restorable_binding
                .and_then(|binding| binding.acp_session_id.clone())
                .or_else(|| {
                    known_acp_session_id(
                        latest_binding.as_ref(),
                        Some(&persisted_session),
                        &agent_id,
                    )
                }),
            false,
        );

        let previous_acp_session_id = external_session_id.clone();
        let restored_existing_session = external_session_id.is_some();
        let mut restore_strategy = None;
        let runtime_snapshot = if let Some(external_session_id) = external_session_id {
            let resume_outcome = self
                .ctx
                .agent_runtime
                .resume_session(ResumeAgentSessionInput {
                    agent_id: agent_id.clone(),
                    launch_lock: launch_settings.launch_lock.clone(),
                    workspace_id: workspace.id,
                    working_dir: PathBuf::from(&working_dir),
                    additional_directories: additional_directories.clone(),
                    session_id: runtime_session_id,
                    external_session_id: external_session_id.clone(),
                    auto_approve_mode: launch_settings.auto_approve_mode,
                    env: launch_settings.env.clone(),
                    preferences: preferences.clone(),
                })
                .await;
            let (snapshot, strategy) = match resume_outcome {
                Ok(pair) => pair,
                Err(agents::AgentError::SessionLoadFailed(reason))
                    if matches!(
                        reason,
                        agents::SessionLoadFailureReason::ResourceNotFound
                            | agents::SessionLoadFailureReason::SessionUnavailable
                    ) && !conversation_has_recorded_turns(pool, conversation_id).await? =>
                {
                    tracing::info!(
                        %conversation_id,
                        %agent_id,
                        %external_session_id,
                        "unprompted pre-bound ACP session was not persisted by agent; opening a fresh session"
                    );
                    let prepared = self
                        .ctx
                        .agent_runtime
                        .prepare_session(EnsureAgentSessionInput {
                            agent_id: agent_id.clone(),
                            launch_lock: launch_settings.launch_lock.clone(),
                            workspace_id: workspace.id,
                            working_dir: PathBuf::from(&working_dir),
                            additional_directories,
                            session_id: runtime_session_id,
                            acp_session_id: String::new(),
                            auto_approve_mode: launch_settings.auto_approve_mode,
                            env: launch_settings.env,
                            preferences,
                        })
                        .await?;
                    (
                        prepared.session,
                        Some(agents::SessionRecoveryStrategy::CreatedNewSession),
                    )
                }
                Err(error) => return Err(error.into()),
            };
            if matches!(
                strategy,
                Some(agents::SessionRecoveryStrategy::CreatedNewSession)
            ) {
                let _ =
                    crate::jsonl_history::preserve_transcript_before_detach(pool, conversation_id)
                        .await;
            }
            restore_strategy = strategy;
            Session::update_agent_metadata(
                pool,
                conversation_id,
                Some(&snapshot.acp_session_id),
                Some(&agent_id),
            )
            .await?;
            snapshot
        } else {
            if restorable_binding.is_some() {
                return Err(ConversationServiceError::Conflict(
                    "conversation already has a restorable ACP session; resume instead of session/new"
                        .into(),
                ));
            }
            if persisted_session
                .agent_id
                .as_ref()
                .is_some_and(|prev| prev != &agent_id)
                || latest_binding
                    .as_ref()
                    .is_some_and(|binding| binding.agent_id != agent_id)
            {
                let _ =
                    crate::jsonl_history::preserve_transcript_before_detach(pool, conversation_id)
                        .await;
            }
            let prepared = self
                .ctx
                .agent_runtime
                .prepare_session(EnsureAgentSessionInput {
                    agent_id: agent_id.clone(),
                    launch_lock: launch_settings.launch_lock.clone(),
                    workspace_id: workspace.id,
                    working_dir: PathBuf::from(&working_dir),
                    additional_directories,
                    session_id: runtime_session_id,
                    acp_session_id: String::new(),
                    auto_approve_mode: launch_settings.auto_approve_mode,
                    env: launch_settings.env,
                    preferences,
                })
                .await?;
            Session::update_agent_metadata(
                pool,
                conversation_id,
                Some(&prepared.session.acp_session_id),
                Some(&agent_id),
            )
            .await?;
            prepared.session
        };

        // Preferred controls are applied before the first broadcast. Replay is
        // skip-if-current, so it only fires when that apply was rejected or the
        // in-memory driver never ran it.
        self.replay_remembered_session_controls(
            conversation_id,
            runtime_session_id,
            latest_binding.as_ref(),
        )
        .await;

        let controls = match self
            .ctx
            .agent_runtime
            .session_controls_snapshot(runtime_session_id)
            .await
        {
            Ok(controls) => controls,
            Err(agents::AgentError::ConnectionNotFound(connection_id)) => {
                tracing::warn!(
                    %conversation_id,
                    %connection_id,
                    "session controls snapshot missed a live bind; using retained controls"
                );
                self.ctx
                    .agent_runtime
                    .retained_session_controls(runtime_session_id)
                    .await
                    .unwrap_or_default()
            }
            Err(error) => return Err(error.into()),
        };
        if let Err(error) = crate::record_open_capability_catalog(
            pool,
            &agent_id,
            &launch_settings.launch_lock,
            &controls,
        )
        .await
        {
            tracing::warn!(
                %error,
                agent_id = %agent_id,
                "failed to record live capability catalog"
            );
        }
        self.ctx
            .agent_runtime
            .commit_prepared_session(runtime_session_id)
            .await;
        if let Err(error) =
            crate::collaboration::invalidate_space_delivery_prompt_injections(pool, conversation_id)
                .await
        {
            tracing::warn!(
                error = %error.message,
                %conversation_id,
                "failed to reset collaboration prompt injection after session bind"
            );
        }
        self.update_runtime_state(conversation_id, |state| {
            state.conversation_id = Some(conversation_id);
            state.acp_session_id = Some(runtime_snapshot.acp_session_id.clone());
            state.connection_id = Some(runtime_snapshot.connection_id.to_string());
            state.connection_status = Some("ready".to_string());
        })
        .await;
        let should_record_recovery = restore_strategy.as_ref().is_some_and(|strategy| {
            matches!(strategy, agents::SessionRecoveryStrategy::CreatedNewSession)
        }) || latest_binding
            .as_ref()
            .is_some_and(|binding| binding.status == "failed");
        if should_record_recovery {
            let strategy = restore_strategy.unwrap_or(if restored_existing_session {
                agents::SessionRecoveryStrategy::Resumed
            } else {
                agents::SessionRecoveryStrategy::CreatedNewSession
            });
            let continues_from = match &strategy {
                agents::SessionRecoveryStrategy::CreatedNewSession => {
                    previous_acp_session_id.filter(|old| *old != runtime_snapshot.acp_session_id)
                }
                _ => None,
            };
            self.record_agent_binding_recovered(conversation_id, strategy, continues_from)
                .await?;
        }
        Ok(controls)
    }
}

/// Record the controls chosen while creating a conversation, before that
/// conversation is shown. Session establishment prefers this binding over the
/// agent's last-used defaults, so the create-form mode is the mode the new ACP
/// session opens with and later resumes with.
pub async fn remember_creation_session_controls(
    pool: &SqlitePool,
    conversation_id: Uuid,
    mode: Option<&str>,
    config_overrides: impl IntoIterator<Item = AgentSessionConfigOverride>,
) {
    let mode = mode.map(str::trim).filter(|mode| !mode.is_empty());
    let config_overrides = config_overrides
        .into_iter()
        .filter(|item| !item.key.trim().is_empty() && !item.value.trim().is_empty())
        .map(|item| AgentSessionConfigOverride {
            key: item.key.trim().to_string(),
            value: item.value.trim().to_string(),
        })
        .collect::<Vec<_>>();
    if mode.is_none() && config_overrides.is_empty() {
        return;
    }
    persist_confirmed_session_controls(pool, conversation_id, mode, &config_overrides).await;
}

/// Persist a confirmed mode / config selection so the next `session/resume`
/// can replay it before the agent defaults reach the UI (ADR-0071 §4).
///
/// Best-effort. A missing binding or a rejected last-used upsert must not fail
/// the control change that already succeeded.
pub(super) async fn persist_confirmed_session_controls(
    pool: &SqlitePool,
    conversation_id: Uuid,
    mode: Option<&str>,
    config_overrides: &[AgentSessionConfigOverride],
) {
    let config_selection_json = (!config_overrides.is_empty())
        .then(|| {
            serde_json::to_string(
                &config_overrides
                    .iter()
                    .map(|ovr| {
                        (
                            ovr.key.clone(),
                            serde_json::Value::String(ovr.value.clone()),
                        )
                    })
                    .collect::<serde_json::Map<_, _>>(),
            )
            .ok()
        })
        .flatten();
    if mode.is_none() && config_selection_json.is_none() {
        return;
    }
    // Live sessions are not given a binding until import or fork. Without a row,
    // the update below matches nothing and a cold resume replays only the agent
    // default (Antigravity: Default + Gemini 3.8 Flash).
    if let Err(error) = ensure_conversation_binding_for_controls(pool, conversation_id).await {
        tracing::warn!(
            %conversation_id,
            %error,
            "failed to open a binding for the confirmed session controls"
        );
    }
    if let Err(error) = ConversationAgentBindingRecord::update_session_controls_selection(
        pool,
        conversation_id,
        mode,
        config_selection_json.as_deref(),
    )
    .await
    {
        tracing::warn!(
            %conversation_id,
            %error,
            "failed to remember the conversation's session-control selection"
        );
    }
    // Last-used per Agent, same store new sessions already read (CodeG
    // `selector-prefs` per agentType). A rejected upsert must not fail the pick.
    if let Ok(Some(binding)) =
        ConversationAgentBindingRecord::latest_for_conversation(pool, conversation_id).await
    {
        let repo = SessionDefaultRepository::new(pool.clone());
        if let Some(mode) = mode.filter(|mode| !mode.is_empty())
            && let Err(error) = repo
                .upsert(
                    &binding.agent_id,
                    "mode",
                    &serde_json::Value::String(mode.to_string()).to_string(),
                )
                .await
        {
            tracing::warn!(
                %conversation_id,
                agent_id = %binding.agent_id,
                %error,
                "failed to remember the agent's last-used session mode"
            );
        }
        for override_item in config_overrides {
            let value_json = serde_json::Value::String(override_item.value.clone()).to_string();
            if let Err(error) = repo
                .upsert(&binding.agent_id, &override_item.key, &value_json)
                .await
            {
                tracing::warn!(
                    %conversation_id,
                    agent_id = %binding.agent_id,
                    option_id = %override_item.key,
                    %error,
                    "failed to remember the agent's last-used session config"
                );
            }
        }
    }
}

pub(crate) async fn conversation_has_recorded_turns(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<bool, sqlx::Error> {
    if !db::models::conversation_turn::ConversationTurnRecord::list_for_conversation(
        pool,
        conversation_id,
    )
    .await?
    .is_empty()
    {
        return Ok(true);
    }
    Ok(crate::jsonl_history::load_all_turns(pool, conversation_id)
        .await?
        .is_some_and(|turns| !turns.is_empty()))
}

async fn linked_agent_for_external_session(
    pool: &SqlitePool,
    conversation_id: Uuid,
    external_session_id: &str,
    bindings: &[ConversationAgentBindingRecord],
) -> Option<AgentId> {
    if let Some(agent_id) = bindings
        .iter()
        .rev()
        .find(|binding| binding.acp_session_id.as_deref() == Some(external_session_id))
        .map(|binding| binding.agent_id.clone())
    {
        return Some(agent_id);
    }
    let raw_rows: Vec<String> = sqlx::query_scalar(
        r#"SELECT raw_json
           FROM conversation_events
           WHERE conversation_id = ?
             AND event_kind = 'agent_binding_ready'
             AND raw_json IS NOT NULL
           ORDER BY sequence DESC
           LIMIT 8"#,
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await
    .ok()?;
    for raw in raw_rows {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        if value
            .get("acp_session_id")
            .and_then(serde_json::Value::as_str)
            == Some(external_session_id)
            && let Some(raw_agent) = value.get("agent_id").and_then(serde_json::Value::as_str)
            && let Ok(agent_id) = AgentId::parse(raw_agent)
        {
            return Some(agent_id);
        }
    }
    None
}

/// Open the conversation's binding when a confirmed selection arrives before any
/// other writer. Resume resolves the workspace itself, so this row only has to
/// carry the agent and the ACP id the session already stored.
async fn ensure_conversation_binding_for_controls(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<(), sqlx::Error> {
    let Some(session) = Session::find_by_id(pool, conversation_id).await? else {
        return Ok(());
    };
    let Some(agent_id) = session.agent_id else {
        return Ok(());
    };
    if ConversationAgentBindingRecord::latest_for_conversation(pool, conversation_id)
        .await?
        .is_some_and(|latest| latest.agent_id == agent_id)
    {
        return Ok(());
    }
    let acp_session_id = session
        .external_session_id
        .filter(|id| !is_placeholder_acp_session_id(id));
    let restored = acp_session_id.is_some();
    // A missing binding shows agent mentions. Recording an empty MCP list would
    // look like a session that started before delegation was delivered and hide
    // them (ADR-0065). This row does not decide which servers the process gets.
    let mcp_servers_json = r#"["vibex-delegation-mcp"]"#;
    ConversationAgentBindingRecord::create(
        pool,
        Uuid::new_v4(),
        CreateConversationAgentBinding {
            conversation_id,
            agent_id: &agent_id,
            working_dir: "",
            acp_session_id: acp_session_id.as_deref(),
            acp_protocol_version: None,
            runtime_version: None,
            acp_version: None,
            load_supported: restored,
            resume_supported: restored,
            close_supported: false,
            terminal_supported: false,
            additional_directories_supported: false,
            prompt_capabilities_json: "{}",
            session_capabilities_json: "{}",
            client_capabilities_json: "{}",
            mcp_servers_json,
            modes_json: "[]",
            config_options_json: "[]",
            current_mode: None,
            config_selection_json: "{}",
            status: if restored {
                BindingStatus::Ready
            } else {
                BindingStatus::Connecting
            },
        },
    )
    .await?;
    Ok(())
}

/// What a freshly established session still needs in order to match the
/// conversation's remembered selection.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct SessionControlReplayPlan {
    pub(super) mode: Option<String>,
    pub(super) config_overrides: Vec<AgentSessionConfigOverride>,
}

/// Diff the remembered selection against what the session currently advertises.
///
/// Only genuine differences are replayed. Re-sending a value the session already
/// holds is not free: some agents rebuild dependent config options on every
/// `session/set_config_option`, so a redundant replay on each session establishment
/// would churn the very controls it is meant to preserve.
pub(super) fn session_control_replay_plan(
    remembered_mode: Option<String>,
    remembered_config: Vec<AgentSessionConfigOverride>,
    current: &AgentSessionControlsSnapshot,
) -> SessionControlReplayPlan {
    SessionControlReplayPlan {
        mode: remembered_mode.filter(|mode| current.current_mode.as_deref() != Some(mode.as_str())),
        config_overrides: remembered_config
            .into_iter()
            .filter(|selection| {
                !current.config_options.iter().any(|option| {
                    option.key == selection.key
                        && option.value.as_ref().and_then(|value| value.as_str())
                            == Some(selection.value.as_str())
                })
            })
            .collect(),
    }
}

/// Conversation selection wins per key over the agent's last-used / settings
/// defaults (CodeG `getSavedPrefsForConnect`).
pub(super) fn session_control_preferences(
    binding: Option<&ConversationAgentBindingRecord>,
    agent_defaults: &[(String, serde_json::Value)],
) -> SessionControlPreferences {
    let mut config = Vec::new();
    for (key, value) in agent_defaults {
        if key == "mode" {
            continue;
        }
        let value = value
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| value.to_string());
        if value.is_empty() {
            continue;
        }
        config.push(AgentSessionConfigOverride {
            key: key.clone(),
            value,
        });
    }
    for override_item in binding_config_selection(binding) {
        if let Some(existing) = config
            .iter_mut()
            .find(|existing| existing.key == override_item.key)
        {
            existing.value = override_item.value;
        } else {
            config.push(override_item);
        }
    }
    let mode = binding_mode_selection(binding).or_else(|| {
        agent_defaults.iter().find_map(|(key, value)| {
            (key == "mode")
                .then(|| value.as_str().map(str::to_string))
                .flatten()
        })
    });
    SessionControlPreferences {
        mode,
        config,
        wants_prompt_suggestions: false,
    }
}

async fn session_wants_prompt_suggestions(pool: &SqlitePool, session: &Session) -> bool {
    if session.parent_session_id.is_some() || session.delegation_call_id.is_some() {
        return false;
    }
    let is_non_composer_child: Option<i64> = sqlx::query_scalar(
        r#"SELECT 1
           FROM conversation_relations
           WHERE child_conversation_id = ?
             AND (kind IN ('delegation', 'workflow_step') OR visibility = 'hidden')
           LIMIT 1"#,
    )
    .bind(session.id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    is_non_composer_child.is_none()
}

pub(super) fn binding_mode_selection(
    binding: Option<&ConversationAgentBindingRecord>,
) -> Option<String> {
    binding
        .and_then(|binding| binding.current_mode.clone())
        .map(|mode| mode.trim().to_string())
        .filter(|mode| !mode.is_empty())
}

pub(super) fn binding_config_selection(
    binding: Option<&ConversationAgentBindingRecord>,
) -> Vec<AgentSessionConfigOverride> {
    binding
        .and_then(|binding| {
            serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(
                &binding.config_selection_json,
            )
            .ok()
        })
        .map(|selection| {
            selection
                .into_iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| AgentSessionConfigOverride {
                        key,
                        value: value.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn is_placeholder_acp_session_id(id: &str) -> bool {
    agents::is_placeholder_acp_session_id(id)
}
