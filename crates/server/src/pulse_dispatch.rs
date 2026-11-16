//! Rich Target dispatch execution (`Session`, `Bot`, `Group`, `User`, `Workflow`),
//! `ThreadKeyed` session reuse & isolation, `BotTurnMailbox` serial/coalescing drain loop,
//! and busy-target detection for `skip_if_busy` temporal rules.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use agents::{AgentId, AgentSessionConfigOverride, ConversationInputPayload};
use api_types::pulse::{
    BotConversationScope, EventEnvelope, GroupDispatchMode, PulseTargetSpec, PulseTemporalSpec,
    PulseWorkspaceIsolation, SessionDeliveryStrategy, SessionTargetMode,
};
use application::{
    ConversationExecutionPort, ConversationSessionExecutionPort, Principal, StartWorkflowRequest,
    WorkflowExecutionPort, WorkflowStoreExecutionPort,
};
use chrono::Utc;
use conversations::{
    ConversationSteerInput, SubmitConversationInput, collaboration,
    isolated_workspace::create_isolated_workspace,
};
use db::models::{
    collaboration_identity::resolve_pulse_bot_session,
    conversation_turn::ConversationTurnRecord,
    pulse::{ensure_pulse_schema, pulse_outbox_wake},
    session::{CreateSession, Session},
    task::{CreateTask, Task, TaskStatus},
    workspace::{CreateWorkspace, Workspace},
};
use pulse::{PulseDispatchAction, PulseDispatchPlan, render_callback_payload_text};
use serde_json::{Value, json};
use uuid::Uuid;
use workflows::{WorkflowCore, WorkflowStore, notify_workflow_work};

use crate::{COLLABORATION_SPACE_CHANGED_EVENT, domains::ServerApplicationDomains};

impl ServerApplicationDomains {
    pub(crate) async fn resume_waiting_workflows(&self, envelope: &EventEnvelope) {
        let wf_core = WorkflowCore::new(WorkflowStore::new(self.pool.clone()));
        if let Ok(resumed) = wf_core
            .dispatch_event_to_waiting_runs(envelope, Uuid::new_v4())
            .await
            && !resumed.is_empty()
        {
            notify_workflow_work();
        }
    }

    pub(crate) async fn execute_pulse_dispatch_plan(&self, plan: &PulseDispatchPlan) {
        let trigger_envelope = if plan.event_id.is_empty() {
            None
        } else {
            self.pulse_engine
                .store()
                .get_envelope_by_event_id(&plan.event_id)
                .await
                .ok()
                .flatten()
        };

        let mut matched_rule_ids = BTreeSet::new();
        for action in &plan.actions {
            if let Some(rule_id) = action_rule_id(action) {
                matched_rule_ids.insert(rule_id.to_string());
            }
        }

        // Run rule-matched actions before subscription follow-ups so newly spawned
        // `ThreadKeyed` sessions bind their UUIDs into `pulse_thread_subscriptions`
        // and deduplicate cleanly within the same event dispatch plan.
        let mut ordered_actions: Vec<&PulseDispatchAction> = plan.actions.iter().collect();
        ordered_actions.sort_by_key(|action| match action {
            PulseDispatchAction::SpawnOrSendSession { rule_id, .. } => usize::from(rule_id.is_none()),
            _ => 0,
        });

        let mut dispatched_sessions = HashSet::new();
        let mut saw_outbox = false;
        let mut rule_errors: BTreeMap<String, String> = BTreeMap::new();

        for action in ordered_actions {
            if matches!(action, PulseDispatchAction::EnqueueOutbox { .. }) {
                saw_outbox = true;
            }
            if let Err(error) = Box::pin(self.execute_pulse_dispatch_action(
                action,
                trigger_envelope.as_ref(),
                &mut dispatched_sessions,
            ))
            .await
            {
                if let Some(rule_id) = action_rule_id(action) {
                    rule_errors.entry(rule_id.to_string()).or_insert_with(|| error.clone());
                }
                tracing::debug!(?error, "Pulse dispatch action completed in best-effort mode");
            }
        }

        let now_iso = Utc::now().to_rfc3339();
        let store = self.pulse_engine.store();
        for rule_id in &matched_rule_ids {
            let Ok(Some(rule)) = store.get_rule(rule_id).await else {
                continue;
            };
            let has_enabled_callback = if let Some(cb) = rule.spec.callback.as_ref()
                && cb.enabled
                && !cb.destination.trim().is_empty()
            {
                if let Some(env) = trigger_envelope.as_ref() {
                    let rendered_text = render_callback_payload_text(cb, &rule.spec.name, env);
                    let target_kind = cb.kind.as_str().to_string();
                    let dedupe_key = format!("rule-callback:{}:{}", rule.id, env.event_id);
                    let payload = json!({
                        "ruleId": rule.id,
                        "ruleName": rule.spec.name,
                        "destination": cb.destination.trim(),
                        "headers": cb.headers,
                        "renderedText": rendered_text,
                        "eventId": env.event_id,
                        "eventType": env.event_type,
                        "threadKey": env.thread_key,
                        "replyChannel": env.reply_channels.first(),
                        "payload": env.payload,
                    });
                    let _ = store
                        .enqueue_outbox(
                            &Uuid::new_v4().to_string(),
                            &dedupe_key,
                            &target_kind,
                            &payload,
                            &now_iso,
                        )
                        .await;
                    saw_outbox = true;
                }
                true
            } else {
                false
            };

            if !has_enabled_callback {
                let (status, summary) = if let Some(err) = rule_errors.get(rule_id) {
                    ("failed", err.clone())
                } else if let Some(env) = trigger_envelope.as_ref() {
                    (
                        "succeeded",
                        format!("Dispatched `{}` ({})", env.event_type, env.event_id),
                    )
                } else {
                    ("succeeded", "Dispatched Pulse targets".to_string())
                };
                let _ = store
                    .record_rule_task_run(rule_id, status, &summary, &now_iso)
                    .await;
            }
        }

        if saw_outbox {
            pulse_outbox_wake().notify_one();
            Box::pin(self.drain_pulse_outbox()).await;
        }
    }

    async fn execute_pulse_dispatch_action(
        &self,
        action: &PulseDispatchAction,
        trigger_envelope: Option<&EventEnvelope>,
        dispatched_sessions: &mut HashSet<Uuid>,
    ) -> Result<(), String> {
        match action {
            PulseDispatchAction::SpawnOrSendSession {
                rule_id,
                mode,
                agent_id,
                model_override,
                workspace_isolation,
                project_id,
                existing_session_id,
                delivery_strategy,
                subscribe_thread,
                thread_key,
                prompt,
                ..
            } => {
                let base_workspace = self
                    .resolve_default_workspace(project_id.as_deref())
                    .await?
                    .ok_or_else(|| "no workspace available for Pulse session target".to_string())?;
                let parsed_agent = resolve_fallback_agent_id(agent_id)?;

                let (conversation_id, target_workspace_id, created_new) = match mode {
                    SessionTargetMode::ExistingSession => {
                        if let Some(id) = existing_session_id
                            .as_deref()
                            .and_then(|raw| Uuid::parse_str(raw).ok())
                            && let Ok(Some(existing)) = Session::find_by_id(&self.pool, id).await
                        {
                            (existing.id, existing.workspace_id, false)
                        } else if let Some(tk) = thread_key.as_deref()
                            && let Some(bound) = self.find_bound_thread_session(tk).await
                        {
                            (bound.id, bound.workspace_id, false)
                        } else {
                            let (new_id, ws_id) = self
                                .create_pulse_session(
                                    &base_workspace,
                                    &parsed_agent,
                                    *workspace_isolation,
                                    rule_id.as_deref(),
                                    thread_key.as_deref(),
                                    prompt,
                                )
                                .await?;
                            (new_id, ws_id, true)
                        }
                    }
                    SessionTargetMode::ThreadKeyed => {
                        if let Some(tk) = thread_key.as_deref()
                            && let Some(bound) = self.find_bound_thread_session(tk).await
                        {
                            (bound.id, bound.workspace_id, false)
                        } else {
                            let (new_id, ws_id) = self
                                .create_pulse_session(
                                    &base_workspace,
                                    &parsed_agent,
                                    *workspace_isolation,
                                    rule_id.as_deref(),
                                    thread_key.as_deref(),
                                    prompt,
                                )
                                .await?;
                            (new_id, ws_id, true)
                        }
                    }
                    SessionTargetMode::EphemeralFresh => {
                        let (new_id, ws_id) = self
                            .create_pulse_session(
                                &base_workspace,
                                &parsed_agent,
                                *workspace_isolation,
                                rule_id.as_deref(),
                                thread_key.as_deref(),
                                prompt,
                            )
                            .await?;
                        (new_id, ws_id, true)
                    }
                };

                let had_placeholder = existing_session_id
                    .as_deref()
                    .is_some_and(|raw| raw.starts_with("session:"));
                if let Some(tk) = thread_key.as_deref().filter(|s| !s.trim().is_empty())
                    && (*subscribe_thread
                        || *mode == SessionTargetMode::ThreadKeyed
                        || (created_new && had_placeholder))
                {
                    let _ = self
                        .pulse_engine
                        .store()
                        .bind_session_thread_subscription(
                            tk,
                            &conversation_id.to_string(),
                            &Utc::now().to_rfc3339(),
                        )
                        .await;
                }

                if !dispatched_sessions.insert(conversation_id) {
                    return Ok(());
                }

                let mut config_overrides = Vec::new();
                if let Some(model) = model_override.as_deref().filter(|s| !s.trim().is_empty()) {
                    config_overrides.push(AgentSessionConfigOverride {
                        key: "model".to_string(),
                        value: model.to_string(),
                    });
                }

                let port = ConversationSessionExecutionPort::new(self.conversations.clone());
                if *delivery_strategy == SessionDeliveryStrategy::Steer {
                    let active_turn_id = find_active_turn_id(&self.pool, conversation_id).await;
                    if let Some(expected_turn_id) = active_turn_id
                        && port
                            .steer(ConversationSteerInput {
                                conversation_id,
                                expected_turn_id,
                                operation_id: Uuid::new_v4(),
                                text: prompt.clone(),
                                display_text: None,
                                images: Vec::new(),
                                file_refs: Vec::new(),
                                mode_override: None,
                                config_overrides: config_overrides.clone(),
                                principal: json!({ "source": "pulse_session_steer" }),
                                promoted_input_id: None,
                                promoted_input_expected_revision: None,
                                allow_interrupt_restart: false,
                            })
                            .await
                            .is_ok()
                    {
                        return Ok(());
                    }
                }

                port.submit_input(SubmitConversationInput {
                    conversation_id,
                    operation_id: Uuid::new_v4(),
                    payload: ConversationInputPayload {
                        continuation_policy: None,
                        expected_binding_revision: None,
                        agent_id: parsed_agent,
                        workspace_id: target_workspace_id,
                        executor_profile_id: None,
                        provider_instance_id: None,
                        text: prompt.clone(),
                        display_text: None,
                        images: Vec::new(),
                        mode_override: None,
                        config_overrides,
                        workflow_refs: Vec::new(),
                        file_refs: Vec::new(),
                        internal_prompt_contributions: Vec::new(),
                        collaboration_origin: None,
                    },
                    principal: json!({
                        "source": "pulse_session_dispatch",
                        "ruleId": rule_id,
                    }),
                })
                .await
                .map_err(|err| err.to_string())?;
                Ok(())
            }
            PulseDispatchAction::EnqueueBotMailbox { member_id, .. } => {
                self.drain_bot_mailbox(member_id).await.map(|_| ())
            }
            PulseDispatchAction::DispatchGroupStage {
                space_id,
                dispatch_mode,
                message,
                ..
            } => {
                let to = match dispatch_mode {
                    GroupDispatchMode::SpecificSeat { member_id } => vec![member_id.clone()],
                    GroupDispatchMode::MentionSeats { member_id_list, .. } => {
                        member_id_list.clone()
                    }
                    GroupDispatchMode::ModeratorTriage {
                        moderator_member_id,
                    } => vec![moderator_member_id.clone()],
                    GroupDispatchMode::BroadcastLogOnly => Vec::new(),
                };
                collaboration::post_to_space_delayed_with(
                    &self.pool,
                    collaboration::PostToSpace {
                        caller_id: None,
                        space_id: space_id.clone(),
                        content: message.clone(),
                        summary: Some("Pulse Event".to_string()),
                        to,
                        in_reply_to: None,
                        operation_id: Uuid::new_v4(),
                    },
                    None,
                    &collaboration::DeliveryContext::default(),
                )
                .await
                .map_err(|err| err.to_string())?;
                self.events.emit(
                    COLLABORATION_SPACE_CHANGED_EVENT,
                    json!({ "spaceId": space_id }),
                );
                Ok(())
            }
            PulseDispatchAction::CreateUserInteraction { .. }
            | PulseDispatchAction::EnqueueOutbox { .. } => {
                self.emit_pulse_deck_changed();
                Ok(())
            }
            PulseDispatchAction::StartOrResumeWorkflow {
                workflow_id,
                pinned_version,
                inputs,
                thread_key,
                ..
            } => {
                let wf_uuid = Uuid::parse_str(workflow_id).map_err(|err| err.to_string())?;
                let wf_core = WorkflowCore::new(WorkflowStore::new(self.pool.clone()));
                let versions = wf_core
                    .versions(wf_uuid, 50)
                    .await
                    .map_err(|err| err.to_string())?;
                let target_version = versions
                    .iter()
                    .find(|v| v.version == i64::from(*pinned_version))
                    .or_else(|| versions.first())
                    .ok_or_else(|| format!("workflow `{wf_uuid}` has no published versions"))?;
                let workspace = self
                    .resolve_default_workspace(None)
                    .await?
                    .ok_or_else(|| "no workspace available for workflow target".to_string())?;
                let mut input_obj = serde_json::Map::new();
                for (k, v) in inputs {
                    input_obj.insert(k.clone(), Value::String(v.clone()));
                }
                if let Some(tk) = thread_key
                    && !input_obj.contains_key("threadKey")
                {
                    input_obj.insert("threadKey".to_string(), Value::String(tk.clone()));
                }
                if let Some(env) = trigger_envelope {
                    input_obj
                        .entry("rootEventId".to_string())
                        .or_insert_with(|| Value::String(env.trace.root_event_id.clone()));
                    input_obj
                        .entry("parentHopCount".to_string())
                        .or_insert_with(|| Value::Number(env.trace.hop_count.into()));
                }
                let port = WorkflowStoreExecutionPort::with_conversations(
                    self.pool.clone(),
                    self.conversations.clone(),
                );
                port.start(
                    &Principal::local_desktop(),
                    Uuid::new_v4(),
                    StartWorkflowRequest {
                        definition_version_id: target_version.id,
                        workspace_id: workspace.id,
                        input: Value::Object(input_obj),
                        policy_override: None,
                        debug_step_id: None,
                    },
                )
                .await
                .map_err(|err| err.to_string())?;
                notify_workflow_work();
                Ok(())
            }
        }
    }

    async fn find_bound_thread_session(&self, thread_key: &str) -> Option<Session> {
        let subs = self
            .pulse_engine
            .store()
            .list_active_subscriptions_for_thread(thread_key)
            .await
            .ok()?;
        for sub in subs {
            if sub.subscriber_kind == "session"
                && let Ok(session_uuid) = Uuid::parse_str(&sub.subscriber_id)
                && let Ok(Some(found)) = Session::find_by_id(&self.pool, session_uuid).await
            {
                return Some(found);
            }
        }
        None
    }

    async fn create_pulse_session(
        &self,
        base_workspace: &Workspace,
        parsed_agent: &AgentId,
        isolation: PulseWorkspaceIsolation,
        rule_id: Option<&str>,
        thread_key: Option<&str>,
        prompt: &str,
    ) -> Result<(Uuid, Uuid), String> {
        let new_id = Uuid::new_v4();
        let label = match (thread_key, rule_id) {
            (Some(tk), _) => format!("Pulse · {tk}"),
            (None, Some(rid)) => format!("Pulse · {rid}"),
            (None, None) => "Pulse Session".to_string(),
        };

        let target_workspace_id = self
            .prepare_pulse_session_workspace(base_workspace, new_id, isolation, &label)
            .await;

        Session::create(
            &self.pool,
            &CreateSession {
                executor: Some(parsed_agent.as_str().to_string()),
                agent_id: Some(parsed_agent.clone()),
                task_id: Some(base_workspace.task_id),
                name: Some(label),
                initial_prompt: Some(prompt.to_string()),
                status: None,
            },
            new_id,
            target_workspace_id,
        )
        .await
        .map_err(|err| err.to_string())?;

        Ok((new_id, target_workspace_id))
    }

    async fn prepare_pulse_session_workspace(
        &self,
        base_workspace: &Workspace,
        conversation_id: Uuid,
        isolation: PulseWorkspaceIsolation,
        label: &str,
    ) -> Uuid {
        match isolation {
            PulseWorkspaceIsolation::ProjectRoot => base_workspace.id,
            PulseWorkspaceIsolation::Scratch => {
                let scratch_dir = std::env::temp_dir()
                    .join("vibex-pulse-scratch")
                    .join(conversation_id.to_string());
                let _ = tokio::fs::create_dir_all(&scratch_dir).await;
                let dir_str = scratch_dir.to_string_lossy().into_owned();

                let Ok(task) = Task::create(
                    &self.pool,
                    &CreateTask {
                        project_id: base_workspace.project_id,
                        title: label.to_string(),
                        description: None,
                        status: Some(TaskStatus::Todo),
                        parent_workspace_id: Some(base_workspace.id),
                        image_ids: None,
                    },
                    Uuid::new_v4(),
                )
                .await
                else {
                    return base_workspace.id;
                };

                match Workspace::create(
                    &self.pool,
                    &CreateWorkspace {
                        project_id: base_workspace.project_id,
                        parent_workspace_id: Some(base_workspace.id),
                        branch: base_workspace.branch.clone(),
                        container_ref: Some(dir_str.clone()),
                        use_worktree: false,
                        agent_working_dir: Some(dir_str),
                    },
                    Uuid::new_v4(),
                    task.id,
                )
                .await
                {
                    Ok(ws) => ws.id,
                    Err(_) => base_workspace.id,
                }
            }
            PulseWorkspaceIsolation::IsolatedWorktree => {
                let short_id = &conversation_id.simple().to_string()[..12];
                match create_isolated_workspace(
                    &self.conversations,
                    base_workspace.id,
                    Uuid::new_v4(),
                    format!("pulse/{short_id}"),
                    label.to_string(),
                    "pulse-session",
                )
                .await
                {
                    Ok((isolated_id, _)) => isolated_id,
                    Err(error) => {
                        tracing::warn!(
                            %error,
                            workspace_id = %base_workspace.id,
                            "Pulse isolated worktree creation unavailable; falling back to default workspace"
                        );
                        base_workspace.id
                    }
                }
            }
        }
    }

    /// Drains queued items in `pulse_bot_mailbox` for `member_id` while respecting
    /// active in-flight turns (`fifo_serial`, `coalesce_batch`, and `steer_active`).
    pub(crate) async fn drain_bot_mailbox(&self, member_id: &str) -> Result<usize, String> {
        let mut drained = 0usize;
        let store = self.pulse_engine.store();

        for _ in 0..32 {
            let Some(peeked) = store
                .peek_next_bot_turn(member_id)
                .await
                .map_err(|err| err.to_string())?
            else {
                break;
            };

            // Workflow-owned Bot steps (`wf-bot:*`) must be claimed by `WorkflowAgentDispatcher`
            // so `workflow_step_runs.turn_id` is bound atomically.
            if peeked.id.starts_with("wf-bot:") {
                notify_workflow_work();
                break;
            }

            let Some(workspace) = self.resolve_default_workspace(None).await? else {
                break;
            };
            let topic_key = match peeked.conversation_scope {
                BotConversationScope::FixedPrimary => None,
                BotConversationScope::PerThreadTopic => peeked.thread_key.as_deref(),
            };
            let bot_session = match resolve_pulse_bot_session(
                &self.pool,
                member_id,
                topic_key,
                workspace.id,
            )
            .await
            {
                Ok(session) => session,
                Err(err) => {
                    if let Ok(Some(claimed)) = self
                        .pulse_engine
                        .claim_next_bot_turn(member_id, Utc::now())
                        .await
                    {
                        let _ = store.fail_bot_turn(&claimed.primary.id).await;
                    }
                    return Err(err.to_string());
                }
            };

            if find_active_turn_id(&self.pool, bot_session.conversation_id)
                .await
                .is_some()
            {
                // Keep queued items in `queued` status while the Bot turn is running so
                // concurrent arrivals coalesce cleanly under `coalesce_batch` or wait FIFO.
                break;
            }

            let Some(claimed) = self
                .pulse_engine
                .claim_next_bot_turn(member_id, Utc::now())
                .await
                .map_err(|err| err.to_string())?
            else {
                break;
            };

            let agent_id = resolve_fallback_agent_id(&bot_session.agent)?;
            let mut config_overrides = Vec::new();
            if let Some(model) = bot_session.model.as_deref() {
                config_overrides.push(AgentSessionConfigOverride {
                    key: "model".to_string(),
                    value: model.to_string(),
                });
            }
            let submitted = ConversationSessionExecutionPort::new(self.conversations.clone())
                .submit_input(SubmitConversationInput {
                    conversation_id: bot_session.conversation_id,
                    operation_id: Uuid::new_v4(),
                    payload: ConversationInputPayload {
                        continuation_policy: None,
                        expected_binding_revision: None,
                        agent_id,
                        workspace_id: bot_session.workspace_id,
                        executor_profile_id: None,
                        provider_instance_id: None,
                        text: claimed.combined_prompt,
                        display_text: None,
                        images: Vec::new(),
                        mode_override: None,
                        config_overrides,
                        workflow_refs: Vec::new(),
                        file_refs: Vec::new(),
                        internal_prompt_contributions: Vec::new(),
                        collaboration_origin: None,
                    },
                    principal: json!({
                        "source": "pulse_bot_mailbox",
                        "memberId": member_id,
                        "mailboxItemId": claimed.primary.id,
                    }),
                })
                .await;

            match submitted {
                Ok(_) => {
                    let _ = store.complete_bot_turn(&claimed.primary.id).await;
                    drained += 1;
                }
                Err(err) => {
                    let _ = store.fail_bot_turn(&claimed.primary.id).await;
                    return Err(err.to_string());
                }
            }
        }

        Ok(drained)
    }

    pub(crate) async fn drain_all_queued_bot_mailboxes(&self) {
        if ensure_pulse_schema(&self.pool).await.is_err() {
            return;
        }
        let Ok(member_ids) = self.pulse_engine.store().list_queued_bot_member_ids().await else {
            return;
        };
        for member_id in member_ids {
            let _ = self.drain_bot_mailbox(&member_id).await;
        }
    }

    /// Computes rule IDs whose targets currently have active in-flight turns/runs
    /// so `TemporalScheduleSpec.skip_if_busy` suppresses overlapping timer fires.
    pub(crate) async fn compute_busy_pulse_rule_ids(&self) -> HashSet<String> {
        let mut busy_rules = HashSet::new();
        let store = self.pulse_engine.store();

        let Ok(rules) = store.list_enabled_rules().await else {
            return busy_rules;
        };
        let temporal_rules: Vec<_> = rules
            .into_iter()
            .filter(|r| {
                matches!(
                    r.spec.temporal,
                    Some(PulseTemporalSpec::Interval {
                        skip_if_busy: true,
                        ..
                    })
                )
            })
            .collect();
        if temporal_rules.is_empty() {
            return busy_rules;
        }

        let in_flight_convs: HashSet<Uuid> = ConversationTurnRecord::list_in_flight(&self.pool)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|t| t.conversation_id)
            .collect();
        let claimed_bots: HashSet<String> = store
            .list_claimed_bot_member_ids()
            .await
            .unwrap_or_default()
            .into_iter()
            .collect();
        let default_ws = self.resolve_default_workspace(None).await.ok().flatten();

        for rule in temporal_rules {
            let mut is_busy = false;
            for target in &rule.spec.targets {
                match target {
                    PulseTargetSpec::Session {
                        existing_session_id,
                        ..
                    } => {
                        if let Some(id) = existing_session_id
                            .as_deref()
                            .and_then(|s| Uuid::parse_str(s).ok())
                            && in_flight_convs.contains(&id)
                        {
                            is_busy = true;
                        }
                        if !is_busy && !in_flight_convs.is_empty() {
                            let tag = format!("Pulse · {}", rule.id);
                            for &conv_id in &in_flight_convs {
                                if let Ok(Some(sess)) = Session::find_by_id(&self.pool, conv_id).await
                                    && sess.name.as_deref() == Some(tag.as_str())
                                {
                                    is_busy = true;
                                    break;
                                }
                            }
                        }
                    }
                    PulseTargetSpec::Bot { member_id, .. } => {
                        if claimed_bots.contains(member_id) {
                            is_busy = true;
                        } else if !in_flight_convs.is_empty()
                            && let Some(ws) = &default_ws
                            && let Ok(bot_sess) =
                                resolve_pulse_bot_session(&self.pool, member_id, None, ws.id).await
                            && in_flight_convs.contains(&bot_sess.conversation_id)
                        {
                            is_busy = true;
                        }
                    }
                    PulseTargetSpec::Workflow { workflow_id, .. } => {
                        if let Ok(wf_uuid) = Uuid::parse_str(workflow_id) {
                            let active_count: i64 = sqlx::query_scalar(
                                "SELECT COUNT(*) FROM workflow_runs
                                 WHERE definition_id = ? AND status IN ('running', 'waiting')",
                            )
                            .bind(wf_uuid)
                            .fetch_one(&self.pool)
                            .await
                            .unwrap_or(0);
                            if active_count > 0 {
                                is_busy = true;
                            }
                        }
                    }
                    _ => {}
                }
                if is_busy {
                    break;
                }
            }
            if is_busy {
                busy_rules.insert(rule.id);
            }
        }

        busy_rules
    }

    pub(crate) async fn resolve_default_workspace(
        &self,
        project_id_hint: Option<&str>,
    ) -> Result<Option<Workspace>, String> {
        if let Some(raw_pid) = project_id_hint
            && let Ok(pid) = Uuid::parse_str(raw_pid)
        {
            let row = sqlx::query_as::<_, Workspace>(
                "SELECT * FROM workspaces WHERE project_id = ? AND archived = 0 ORDER BY updated_at DESC LIMIT 1",
            )
            .bind(pid)
            .fetch_optional(&self.pool)
            .await
            .map_err(|err| err.to_string())?;
            if row.is_some() {
                return Ok(row);
            }
        }
        sqlx::query_as::<_, Workspace>(
            "SELECT * FROM workspaces WHERE archived = 0 ORDER BY updated_at DESC LIMIT 1",
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(|err| err.to_string())
    }
}

async fn find_active_turn_id(pool: &sqlx::SqlitePool, conversation_id: Uuid) -> Option<Uuid> {
    ConversationTurnRecord::list_for_conversation(pool, conversation_id)
        .await
        .ok()?
        .into_iter()
        .rev()
        .find(|turn| {
            matches!(
                turn.status.as_str(),
                "pending" | "queued" | "running" | "blocked"
            )
        })
        .map(|turn| turn.id)
}

pub(crate) fn resolve_fallback_agent_id(raw: &str) -> Result<AgentId, String> {
    AgentId::parse(raw)
        .or_else(|_| AgentId::parse("claude-code"))
        .map_err(|err| err.to_string())
}

fn action_rule_id(action: &PulseDispatchAction) -> Option<&str> {
    match action {
        PulseDispatchAction::SpawnOrSendSession { rule_id, .. }
        | PulseDispatchAction::EnqueueBotMailbox { rule_id, .. }
        | PulseDispatchAction::DispatchGroupStage { rule_id, .. }
        | PulseDispatchAction::CreateUserInteraction { rule_id, .. }
        | PulseDispatchAction::StartOrResumeWorkflow { rule_id, .. }
        | PulseDispatchAction::EnqueueOutbox { rule_id, .. } => rule_id.as_deref(),
    }
}
