//! Dual-Primitive Pulse workflow execution helpers (`Session`, `Bot`, `GroupStage`,
//! `OutboxAction`, and `UserGate` decision bridging) for `WorkflowAgentDispatcher`
//! and `WorkflowStoreExecutionPort`.

use std::collections::BTreeMap;

use agents::{AgentId, AgentSessionConfigOverride, ConversationInputPayload};
use chrono::Utc;
use conversations::{
    CreateWorkflowConversation, SubmitConversationInput, collaboration,
    create_workflow_conversation,
};
use db::models::{
    collaboration_identity::resolve_pulse_bot_session,
    conversation_turn::ConversationTurnRecord,
    pulse::{PulseBotMailboxItem, SqlitePulseStore, ensure_pulse_schema, pulse_outbox_wake},
};
use serde_json::{Value, json};
use uuid::Uuid;
use workflows::{
    BotConversationScope, BotStepSpec, ClaimedWorkflowStep, CompleteWorkflowStep, CompletionPolicy,
    GroupDispatchMode, GroupStageStepSpec, OutboxActionKind, OutboxActionStepSpec, SessionStepSpec,
    WorkflowCore, WorkflowRunView, WorkflowStep, WorkflowStepSpec, WorkflowStore, WorkspaceAccess,
    resolve_json_pointer,
};

use crate::{
    ApplicationError, ConversationExecutionPort, DecideWorkflowRequest, Principal,
    workflow::{
        WorkflowAgentDispatcher, create_isolated_step_workspace, map_error, principal_json,
        render_agent_prompt, wait_for_dispatched_input_turn,
    },
};

impl WorkflowAgentDispatcher {
    pub(crate) async fn dispatch_pulse_claimed_step(
        &self,
        claimed: &ClaimedWorkflowStep,
        step: &WorkflowStep,
    ) -> Result<bool, ApplicationError> {
        match &step.spec {
            WorkflowStepSpec::Session(session) => {
                self.dispatch_session_step(claimed, step, session).await
            }
            WorkflowStepSpec::Bot(bot) => self.dispatch_bot_step(claimed, step, bot).await,
            WorkflowStepSpec::GroupStage(group) => {
                self.dispatch_group_stage_step(claimed, step, group).await
            }
            WorkflowStepSpec::OutboxAction(outbox) => {
                self.dispatch_outbox_action_step(claimed, step, outbox)
                    .await
            }
            _ => Err(ApplicationError::internal(
                "dispatcher claimed a non-executable workflow step",
            )),
        }
    }

    async fn dispatch_session_step(
        &self,
        claimed: &ClaimedWorkflowStep,
        step: &WorkflowStep,
        session: &SessionStepSpec,
    ) -> Result<bool, ApplicationError> {
        let agent_id = crate::workflow::parse_canonical_agent_id(&session.agent_id)?;
        let resolved_input = match self.store.resolve_step_input(claimed.run.id, step).await {
            Ok(input) => input,
            Err(error) => {
                self.store
                    .fail_step(
                        claimed.run.id,
                        &step.id,
                        "input_binding_failed",
                        &error.to_string(),
                    )
                    .await
                    .map_err(map_error)?;
                return Ok(true);
            }
        };

        let (step_workspace_id, workspace_evidence) =
            if session.workspace_access == WorkspaceAccess::WriteIsolated {
                match create_isolated_step_workspace(
                    &self.context,
                    claimed.run.workspace_id,
                    claimed.run.id,
                    &step.id,
                    claimed.step.attempt,
                    claimed.step.id,
                )
                .await
                {
                    Ok(prepared) => prepared,
                    Err(error) => {
                        self.store
                            .fail_step(
                                claimed.run.id,
                                &step.id,
                                "workspace_isolation_failed",
                                &error.to_string(),
                            )
                            .await
                            .map_err(map_error)?;
                        return Ok(true);
                    }
                }
            } else {
                (
                    claimed.run.workspace_id,
                    json!({
                        "isolated": false,
                        "workspaceId": claimed.run.workspace_id,
                        "policy": session.workspace_access,
                        "primitive": "session",
                    }),
                )
            };

        self.store
            .prepare_step(
                claimed.run.id,
                step,
                claimed.claim_token,
                &resolved_input,
                step_workspace_id,
                &workspace_evidence,
            )
            .await
            .map_err(map_error)?;

        let run_input = parse_run_input(&claimed.run.input_json);
        let step_outputs = load_completed_step_outputs(&self.store, claimed.run.id).await;
        let interpolated = interpolate_template(
            &session.prompt_template,
            &resolved_input.values,
            &step_outputs,
            &run_input,
        );
        let prompt = render_agent_prompt(
            &interpolated,
            &resolved_input.values,
            session.output_schema.as_ref(),
            None,
            None,
        )?;

        let child_id = claimed.step.id;
        if let Err(error) = create_workflow_conversation(
            &self.context.deployment.db().pool,
            CreateWorkflowConversation {
                id: child_id,
                parent_conversation_id: claimed.run.id,
                workspace_id: step_workspace_id,
                workflow_run_id: claimed.run.id,
                workflow_step_id: step.id.clone(),
                agent_id: agent_id.clone(),
                prompt: prompt.clone(),
                visible: false,
            },
        )
        .await
        {
            self.store
                .fail_step(
                    claimed.run.id,
                    &step.id,
                    "child_create_failed",
                    &error.to_string(),
                )
                .await
                .map_err(map_error)?;
            return Ok(true);
        }

        if session.subscribe_thread
            && let Some(thread_key) = extract_thread_key(&resolved_input.values, &run_input)
        {
            let pool = &self.context.deployment.db().pool;
            if ensure_pulse_schema(pool).await.is_ok() {
                let _ = SqlitePulseStore::new(pool.clone())
                    .subscribe_thread(
                        &Uuid::new_v4().to_string(),
                        &thread_key,
                        "session",
                        &child_id.to_string(),
                        &Utc::now().to_rfc3339(),
                    )
                    .await;
            }
        }

        self.store
            .mark_started(
                claimed.run.id,
                &step.id,
                claimed.claim_token,
                Some(child_id),
                None,
            )
            .await
            .map_err(map_error)?;

        let mut config_overrides = Vec::new();
        if let Some(model) = session
            .model_override
            .as_deref()
            .filter(|m| !m.trim().is_empty())
        {
            config_overrides.push(AgentSessionConfigOverride {
                key: "model".to_string(),
                value: model.to_string(),
            });
        }

        let submission = self
            .conversations
            .submit_input(SubmitConversationInput {
                conversation_id: child_id,
                operation_id: child_id,
                payload: ConversationInputPayload {
                    continuation_policy: None,
                    expected_binding_revision: None,
                    agent_id,
                    workspace_id: step_workspace_id,
                    executor_profile_id: None,
                    text: prompt,
                    display_text: None,
                    images: Vec::new(),
                    mode_override: None,
                    config_overrides,
                    workflow_refs: Vec::new(),
                    file_refs: Vec::new(),
                    internal_prompt_contributions: Vec::new(),
                    collaboration_origin: None,
                    provider_instance_id: None,
                },
                principal: json!({
                    "id": "workflow-session-dispatcher",
                    "workflowRunId": claimed.run.id,
                    "workflowStepId": step.id,
                    "primitive": "session",
                }),
            })
            .await;

        match submission {
            Ok(submission) => {
                let turn_id = if let Some(turn) = submission.turn {
                    turn.turn_id
                } else {
                    wait_for_dispatched_input_turn(
                        &self.context.deployment.db().pool,
                        submission.input.id,
                    )
                    .await?
                };
                self.store
                    .bind_turn(claimed.run.id, &step.id, child_id, turn_id)
                    .await
                    .map_err(map_error)?;
            }
            Err(error) => {
                self.store
                    .fail_step(
                        claimed.run.id,
                        &step.id,
                        "conversation_start_failed",
                        &error.to_string(),
                    )
                    .await
                    .map_err(map_error)?;
            }
        }
        Ok(true)
    }

    async fn dispatch_bot_step(
        &self,
        claimed: &ClaimedWorkflowStep,
        step: &WorkflowStep,
        bot: &BotStepSpec,
    ) -> Result<bool, ApplicationError> {
        let resolved_input = match self.store.resolve_step_input(claimed.run.id, step).await {
            Ok(input) => input,
            Err(error) => {
                self.store
                    .fail_step(
                        claimed.run.id,
                        &step.id,
                        "input_binding_failed",
                        &error.to_string(),
                    )
                    .await
                    .map_err(map_error)?;
                return Ok(true);
            }
        };

        let run_input = parse_run_input(&claimed.run.input_json);
        let topic_key = match bot.conversation_scope {
            BotConversationScope::FixedPrimary => None,
            BotConversationScope::PerThreadTopic => {
                extract_thread_key(&resolved_input.values, &run_input)
            }
        };

        let pool = &self.context.deployment.db().pool;
        let bot_session = match resolve_pulse_bot_session(
            pool,
            &bot.member_id,
            topic_key.as_deref(),
            claimed.run.workspace_id,
        )
        .await
        {
            Ok(resolved) => resolved,
            Err(error) => {
                self.store
                    .fail_step(
                        claimed.run.id,
                        &step.id,
                        "bot_identity_resolve_failed",
                        &error.to_string(),
                    )
                    .await
                    .map_err(map_error)?;
                return Ok(true);
            }
        };

        let agent_id = crate::workflow::parse_canonical_agent_id(&bot_session.agent)?;
        let step_outputs = load_completed_step_outputs(&self.store, claimed.run.id).await;
        let interpolated = interpolate_template(
            &bot.prompt_template,
            &resolved_input.values,
            &step_outputs,
            &run_input,
        );
        let prompt = render_agent_prompt(
            &interpolated,
            &resolved_input.values,
            bot.output_schema.as_ref(),
            None,
            None,
        )?;

        ensure_pulse_schema(pool)
            .await
            .map_err(|err| ApplicationError::internal(err.to_string()))?;
        let pulse_store = SqlitePulseStore::new(pool.clone());
        let now_iso = Utc::now().to_rfc3339();
        let mailbox_item_id = format!(
            "wf-bot:{}:{}:{}",
            claimed.run.id, step.id, claimed.step.attempt
        );
        let event_id = format!("workflow:{}:{}", claimed.run.id, step.id);
        pulse_store
            .enqueue_bot_turn(&PulseBotMailboxItem {
                id: mailbox_item_id.clone(),
                member_id: bot.member_id.clone(),
                conversation_scope: bot.conversation_scope,
                mailbox_policy: bot.mailbox_policy,
                thread_key: topic_key.clone(),
                event_id,
                prompt_text: prompt,
                status: "queued".to_string(),
                created_at: now_iso.clone(),
                claimed_at: None,
            })
            .await
            .map_err(|err| ApplicationError::internal(err.to_string()))?;

        let has_active_turn =
            ConversationTurnRecord::list_for_conversation(pool, bot_session.conversation_id)
                .await
                .ok()
                .is_some_and(|turns| {
                    turns.iter().any(|turn| {
                        matches!(
                            turn.status.as_str(),
                            "pending" | "queued" | "running" | "blocked"
                        )
                    })
                });
        if has_active_turn {
            let _ = self
                .store
                .release_claim(claimed.run.id, &step.id, claimed.claim_token)
                .await;
            return Ok(false);
        }

        if let Some(front) = pulse_store
            .peek_next_bot_turn(&bot.member_id)
            .await
            .map_err(|err| ApplicationError::internal(err.to_string()))?
            && front.id != mailbox_item_id
        {
            let _ = self
                .store
                .release_claim(claimed.run.id, &step.id, claimed.claim_token)
                .await;
            return Ok(false);
        }

        let Some(claimed_turn) = pulse_store
            .claim_next_bot_turn(&bot.member_id, &now_iso)
            .await
            .map_err(|err| ApplicationError::internal(err.to_string()))?
        else {
            let _ = self
                .store
                .release_claim(claimed.run.id, &step.id, claimed.claim_token)
                .await;
            return Ok(false);
        };

        let workspace_evidence = json!({
            "isolated": false,
            "workspaceId": bot_session.workspace_id,
            "primitive": "bot",
            "memberId": bot.member_id,
            "conversationScope": bot.conversation_scope,
            "mailboxPolicy": bot.mailbox_policy,
            "mailboxItemId": claimed_turn.primary.id,
            "persistentConversationId": bot_session.conversation_id,
        });

        self.store
            .prepare_step(
                claimed.run.id,
                step,
                claimed.claim_token,
                &resolved_input,
                bot_session.workspace_id,
                &workspace_evidence,
            )
            .await
            .map_err(map_error)?;

        self.store
            .mark_started(
                claimed.run.id,
                &step.id,
                claimed.claim_token,
                Some(bot_session.conversation_id),
                None,
            )
            .await
            .map_err(map_error)?;

        let mut config_overrides = Vec::new();
        if let Some(model) = bot_session.model.as_deref() {
            config_overrides.push(AgentSessionConfigOverride {
                key: "model".to_string(),
                value: model.to_string(),
            });
        }

        let submission = self
            .conversations
            .submit_input(SubmitConversationInput {
                conversation_id: bot_session.conversation_id,
                operation_id: claimed.step.id,
                payload: ConversationInputPayload {
                    continuation_policy: None,
                    expected_binding_revision: None,
                    agent_id,
                    workspace_id: bot_session.workspace_id,
                    executor_profile_id: None,
                    text: claimed_turn.combined_prompt,
                    display_text: None,
                    images: Vec::new(),
                    mode_override: None,
                    config_overrides,
                    workflow_refs: Vec::new(),
                    file_refs: Vec::new(),
                    internal_prompt_contributions: Vec::new(),
                    collaboration_origin: None,
                    provider_instance_id: None,
                },
                principal: json!({
                    "id": "workflow-bot-dispatcher",
                    "workflowRunId": claimed.run.id,
                    "workflowStepId": step.id,
                    "memberId": bot.member_id,
                    "mailboxItemId": claimed_turn.primary.id,
                    "primitive": "bot",
                }),
            })
            .await;

        match submission {
            Ok(submission) => {
                let _ = pulse_store
                    .complete_bot_turn(&claimed_turn.primary.id)
                    .await;
                let turn_id = if let Some(turn) = submission.turn {
                    turn.turn_id
                } else {
                    wait_for_dispatched_input_turn(pool, submission.input.id).await?
                };
                self.store
                    .bind_turn(
                        claimed.run.id,
                        &step.id,
                        bot_session.conversation_id,
                        turn_id,
                    )
                    .await
                    .map_err(map_error)?;
            }
            Err(error) => {
                let _ = pulse_store.fail_bot_turn(&claimed_turn.primary.id).await;
                self.store
                    .fail_step(
                        claimed.run.id,
                        &step.id,
                        "bot_turn_start_failed",
                        &error.to_string(),
                    )
                    .await
                    .map_err(map_error)?;
            }
        }
        Ok(true)
    }

    async fn dispatch_group_stage_step(
        &self,
        claimed: &ClaimedWorkflowStep,
        step: &WorkflowStep,
        group: &GroupStageStepSpec,
    ) -> Result<bool, ApplicationError> {
        let resolved_input = match self.store.resolve_step_input(claimed.run.id, step).await {
            Ok(input) => input,
            Err(error) => {
                self.store
                    .fail_step(
                        claimed.run.id,
                        &step.id,
                        "input_binding_failed",
                        &error.to_string(),
                    )
                    .await
                    .map_err(map_error)?;
                return Ok(true);
            }
        };

        let workspace_evidence = json!({
            "isolated": false,
            "workspaceId": claimed.run.workspace_id,
            "primitive": "group_stage",
            "spaceId": group.space_id,
        });
        self.store
            .prepare_step(
                claimed.run.id,
                step,
                claimed.claim_token,
                &resolved_input,
                claimed.run.workspace_id,
                &workspace_evidence,
            )
            .await
            .map_err(map_error)?;
        self.store
            .mark_started(claimed.run.id, &step.id, claimed.claim_token, None, None)
            .await
            .map_err(map_error)?;

        let run_input = parse_run_input(&claimed.run.input_json);
        let step_outputs = load_completed_step_outputs(&self.store, claimed.run.id).await;
        let rendered_message = interpolate_template(
            &group.message_template,
            &resolved_input.values,
            &step_outputs,
            &run_input,
        );
        let audience_to = match &group.dispatch_mode {
            GroupDispatchMode::SpecificSeat { member_id } => vec![member_id.clone()],
            GroupDispatchMode::MentionSeats { member_id_list, .. } => member_id_list.clone(),
            GroupDispatchMode::ModeratorTriage {
                moderator_member_id,
            } => vec![moderator_member_id.clone()],
            GroupDispatchMode::BroadcastLogOnly => Vec::new(),
        };

        let pool = &self.context.deployment.db().pool;
        let posted = collaboration::post_to_space_delayed_with(
            pool,
            collaboration::PostToSpace {
                caller_id: None,
                space_id: group.space_id.clone(),
                content: rendered_message.clone(),
                summary: Some(format!("Workflow step `{}`", step.id)),
                to: audience_to.clone(),
                in_reply_to: None,
                operation_id: claimed.step.id,
            },
            None,
            &collaboration::DeliveryContext::default(),
        )
        .await;

        let output = match posted {
            Ok(post_res) => json!({
                "spaceId": group.space_id,
                "dispatchMode": group.dispatch_mode,
                "to": audience_to,
                "message": rendered_message,
                "delivered": true,
                "messageId": post_res.message_id,
            }),
            Err(_) => json!({
                "spaceId": group.space_id,
                "dispatchMode": group.dispatch_mode,
                "to": audience_to,
                "message": rendered_message,
                "delivered": false,
            }),
        };

        self.core
            .complete_step(CompleteWorkflowStep {
                run_id: claimed.run.id,
                step_id: step.id.clone(),
                output: Some(output),
            })
            .await
            .map_err(map_error)?;
        Ok(true)
    }

    async fn dispatch_outbox_action_step(
        &self,
        claimed: &ClaimedWorkflowStep,
        step: &WorkflowStep,
        outbox: &OutboxActionStepSpec,
    ) -> Result<bool, ApplicationError> {
        let resolved_input = match self.store.resolve_step_input(claimed.run.id, step).await {
            Ok(input) => input,
            Err(error) => {
                self.store
                    .fail_step(
                        claimed.run.id,
                        &step.id,
                        "input_binding_failed",
                        &error.to_string(),
                    )
                    .await
                    .map_err(map_error)?;
                return Ok(true);
            }
        };

        let workspace_evidence = json!({
            "isolated": false,
            "workspaceId": claimed.run.workspace_id,
            "primitive": "outbox_action",
            "actionKind": outbox.action_kind,
        });
        self.store
            .prepare_step(
                claimed.run.id,
                step,
                claimed.claim_token,
                &resolved_input,
                claimed.run.workspace_id,
                &workspace_evidence,
            )
            .await
            .map_err(map_error)?;
        self.store
            .mark_started(claimed.run.id, &step.id, claimed.claim_token, None, None)
            .await
            .map_err(map_error)?;

        let pool = &self.context.deployment.db().pool;
        let run_input = parse_run_input(&claimed.run.input_json);
        let step_outputs = load_completed_step_outputs(&self.store, claimed.run.id).await;
        let rendered_target = interpolate_template(
            &outbox.target_template,
            &resolved_input.values,
            &step_outputs,
            &run_input,
        );
        let rendered_payload = interpolate_json_value(
            &outbox.payload_template,
            &resolved_input.values,
            &step_outputs,
            &run_input,
        );
        let target_kind = match outbox.action_kind {
            OutboxActionKind::ReplyChannel => "reply_channel",
            OutboxActionKind::WebhookPost => "webhook_post",
            OutboxActionKind::EmitEvent => "emit_event",
        };
        let dedupe_key = format!(
            "wf-outbox:{}:{}:{}",
            claimed.run.id, step.id, claimed.step.attempt
        );

        let channel_hint = rendered_payload
            .get("channelHint")
            .or_else(|| rendered_payload.get("channel_hint"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let rendered_text = match &rendered_payload {
            Value::String(s) if !s.trim().is_empty() => Some(s.clone()),
            Value::Object(_) => [
                "renderedText",
                "rendered_text",
                "message",
                "content",
                "text",
                "body",
            ]
            .into_iter()
            .find_map(|key| {
                rendered_payload
                    .get(key)
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                    .map(str::to_string)
            }),
            _ => None,
        };

        let mut envelope_map = serde_json::Map::new();
        envelope_map.insert("target".to_string(), Value::String(rendered_target.clone()));
        envelope_map.insert(
            "eventType".to_string(),
            match outbox.action_kind {
                OutboxActionKind::EmitEvent => Value::String(rendered_target.clone()),
                _ => Value::Null,
            },
        );
        envelope_map.insert(
            "actionKind".to_string(),
            Value::String(target_kind.to_string()),
        );
        envelope_map.insert("payload".to_string(), rendered_payload.clone());
        if let Some(hint) = channel_hint {
            envelope_map.insert("channelHint".to_string(), Value::String(hint));
        }
        if let Some(rt) = rendered_text {
            envelope_map.insert("renderedText".to_string(), Value::String(rt));
        }
        if let Some(headers) = rendered_payload.get("headers").filter(|v| v.is_object()) {
            envelope_map.insert("headers".to_string(), headers.clone());
        }
        if let Some(rc) = run_input
            .get("replyChannel")
            .or_else(|| run_input.get("reply_channel"))
        {
            envelope_map.insert("replyChannel".to_string(), rc.clone());
        }
        if let Some(rcs) = run_input
            .get("replyChannels")
            .or_else(|| run_input.get("reply_channels"))
        {
            envelope_map.insert("replyChannels".to_string(), rcs.clone());
        }
        if let Some(tok) = rendered_payload
            .get("githubToken")
            .or_else(|| run_input.get("githubToken"))
        {
            envelope_map.insert("githubToken".to_string(), tok.clone());
        }
        if let Some(api_base) = rendered_payload
            .get("githubApiBase")
            .or_else(|| run_input.get("githubApiBase"))
        {
            envelope_map.insert("githubApiBase".to_string(), api_base.clone());
        }
        envelope_map.insert(
            "threadKey".to_string(),
            extract_thread_key(&resolved_input.values, &run_input)
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
        envelope_map.insert(
            "rootEventId".to_string(),
            extract_root_event_id(&resolved_input.values, &run_input)
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
        envelope_map.insert(
            "parentHopCount".to_string(),
            extract_hop_count(&resolved_input.values, &run_input)
                .map(|n| Value::Number(n.into()))
                .unwrap_or(Value::Null),
        );
        envelope_map.insert("workflowRunId".to_string(), json!(claimed.run.id));
        envelope_map.insert("workflowStepId".to_string(), json!(step.id));
        let outbox_envelope = Value::Object(envelope_map);

        ensure_pulse_schema(pool)
            .await
            .map_err(|err| ApplicationError::internal(err.to_string()))?;
        let inserted = SqlitePulseStore::new(pool.clone())
            .enqueue_outbox(
                &claimed.step.id.to_string(),
                &dedupe_key,
                target_kind,
                &outbox_envelope,
                &Utc::now().to_rfc3339(),
            )
            .await
            .map_err(|err| ApplicationError::internal(err.to_string()))?;
        if inserted {
            pulse_outbox_wake().notify_one();
        }

        let output = json!({
            "enqueued": inserted,
            "dedupeKey": dedupe_key,
            "actionKind": target_kind,
            "target": rendered_target,
            "payload": rendered_payload,
        });
        self.core
            .complete_step(CompleteWorkflowStep {
                run_id: claimed.run.id,
                step_id: step.id.clone(),
                output: Some(output),
            })
            .await
            .map_err(map_error)?;
        Ok(true)
    }
}

pub(crate) fn step_uses_conversation_turn(spec: &WorkflowStepSpec) -> Option<CompletionPolicy> {
    match spec {
        WorkflowStepSpec::Agent(agent) => Some(agent.completion_policy),
        WorkflowStepSpec::Session(session) => Some(session.completion),
        WorkflowStepSpec::Bot(bot) => Some(bot.completion),
        _ => None,
    }
}

pub(crate) struct StepContinuationContext {
    pub agent_id: AgentId,
    pub executor_profile_id: Option<Value>,
    pub mode_override: Option<String>,
    pub config_overrides: Vec<AgentSessionConfigOverride>,
    pub recovery_context: String,
}

pub(crate) async fn build_step_continuation_context(
    pool: &db::DbPool,
    spec: &WorkflowStepSpec,
    resolved_input: &BTreeMap<String, Value>,
    run_workspace_id: Uuid,
) -> Result<StepContinuationContext, ApplicationError> {
    match spec {
        WorkflowStepSpec::Agent(agent) => {
            let agent_id = crate::workflow::parse_canonical_agent_id(&agent.agent_id)?;
            let recovery_context = render_agent_prompt(
                &agent.prompt,
                resolved_input,
                agent.output_schema.as_ref(),
                agent.output_description.as_deref(),
                agent.output_language.as_deref(),
            )?;
            Ok(StepContinuationContext {
                agent_id,
                executor_profile_id: agent.executor_profile_id.clone(),
                mode_override: agent.mode_override.clone(),
                config_overrides: agent
                    .config_overrides
                    .iter()
                    .map(|(k, v)| AgentSessionConfigOverride {
                        key: k.clone(),
                        value: v.clone(),
                    })
                    .collect(),
                recovery_context,
            })
        }
        WorkflowStepSpec::Session(session) => {
            let agent_id = crate::workflow::parse_canonical_agent_id(&session.agent_id)?;
            let recovery_context = render_agent_prompt(
                &session.prompt_template,
                resolved_input,
                session.output_schema.as_ref(),
                None,
                None,
            )?;
            let mut config_overrides = Vec::new();
            if let Some(model) = session
                .model_override
                .as_deref()
                .filter(|m| !m.trim().is_empty())
            {
                config_overrides.push(AgentSessionConfigOverride {
                    key: "model".to_string(),
                    value: model.to_string(),
                });
            }
            Ok(StepContinuationContext {
                agent_id,
                executor_profile_id: None,
                mode_override: None,
                config_overrides,
                recovery_context,
            })
        }
        WorkflowStepSpec::Bot(bot) => {
            let resolved_bot =
                resolve_pulse_bot_session(pool, &bot.member_id, None, run_workspace_id)
                    .await
                    .map_err(|err| ApplicationError::internal(err.to_string()))?;
            let agent_id = crate::workflow::parse_canonical_agent_id(&resolved_bot.agent)?;
            let recovery_context = render_agent_prompt(
                &bot.prompt_template,
                resolved_input,
                bot.output_schema.as_ref(),
                None,
                None,
            )?;
            let mut config_overrides = Vec::new();
            if let Some(model) = resolved_bot.model {
                config_overrides.push(AgentSessionConfigOverride {
                    key: "model".to_string(),
                    value: model,
                });
            }
            Ok(StepContinuationContext {
                agent_id,
                executor_profile_id: None,
                mode_override: None,
                config_overrides,
                recovery_context,
            })
        }
        _ => Err(ApplicationError::bad_request(
            "non-conversational workflow steps do not support follow-up turns",
        )),
    }
}

pub(crate) async fn decide_workflow_or_user_gate(
    core: &WorkflowCore,
    principal: &Principal,
    operation_id: Uuid,
    request: DecideWorkflowRequest,
) -> Result<WorkflowRunView, ApplicationError> {
    core.decide(workflows::DecideApproval {
        run_id: request.run_id,
        step_id: request.step_id,
        decision: request.decision,
        operation_id,
        principal: principal_json(principal),
    })
    .await
    .map_err(map_error)
}

fn parse_run_input(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap_or_else(|_| json!({}))
}

fn extract_thread_key(step_inputs: &BTreeMap<String, Value>, run_input: &Value) -> Option<String> {
    for key in ["threadKey", "thread_key"] {
        if let Some(val) = step_inputs.get(key).and_then(Value::as_str)
            && !val.trim().is_empty()
        {
            return Some(val.trim().to_string());
        }
        if let Some(val) = run_input.get(key).and_then(Value::as_str)
            && !val.trim().is_empty()
        {
            return Some(val.trim().to_string());
        }
    }
    None
}

fn extract_root_event_id(
    step_inputs: &BTreeMap<String, Value>,
    run_input: &Value,
) -> Option<String> {
    for key in ["rootEventId", "root_event_id", "eventId", "event_id"] {
        if let Some(val) = step_inputs.get(key).and_then(Value::as_str)
            && !val.trim().is_empty()
        {
            return Some(val.trim().to_string());
        }
        if let Some(val) = run_input.get(key).and_then(Value::as_str)
            && !val.trim().is_empty()
        {
            return Some(val.trim().to_string());
        }
    }
    if let Some(val) = resolve_json_pointer(run_input, "/trace/rootEventId").and_then(Value::as_str)
        && !val.trim().is_empty()
    {
        return Some(val.trim().to_string());
    }
    None
}

fn extract_hop_count(step_inputs: &BTreeMap<String, Value>, run_input: &Value) -> Option<u32> {
    for key in ["hopCount", "hop_count", "parentHopCount"] {
        if let Some(val) = step_inputs
            .get(key)
            .and_then(Value::as_u64)
            .or_else(|| {
                step_inputs
                    .get(key)
                    .and_then(Value::as_str)
                    .and_then(|s| s.parse().ok())
            })
            .and_then(|n| u32::try_from(n).ok())
        {
            return Some(val);
        }
        if let Some(val) = run_input
            .get(key)
            .and_then(Value::as_u64)
            .or_else(|| {
                run_input
                    .get(key)
                    .and_then(Value::as_str)
                    .and_then(|s| s.parse().ok())
            })
            .and_then(|n| u32::try_from(n).ok())
        {
            return Some(val);
        }
    }
    resolve_json_pointer(run_input, "/trace/hopCount")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
}

async fn load_completed_step_outputs(
    store: &WorkflowStore,
    run_id: Uuid,
) -> BTreeMap<String, Value> {
    let mut outputs = BTreeMap::new();
    let Ok(steps) = store.steps(run_id).await else {
        return outputs;
    };
    for step in steps {
        if step.status == "completed"
            && let Some(raw) = step.output_json.as_deref()
            && let Ok(parsed) = serde_json::from_str::<Value>(raw)
        {
            outputs.insert(step.step_id, parsed);
        }
    }
    outputs
}

fn interpolate_json_value(
    value: &Value,
    step_inputs: &BTreeMap<String, Value>,
    step_outputs: &BTreeMap<String, Value>,
    run_input: &Value,
) -> Value {
    match value {
        Value::String(s) => Value::String(interpolate_template(
            s,
            step_inputs,
            step_outputs,
            run_input,
        )),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|v| interpolate_json_value(v, step_inputs, step_outputs, run_input))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| {
                    (
                        k.clone(),
                        interpolate_json_value(v, step_inputs, step_outputs, run_input),
                    )
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

fn interpolate_template(
    template: &str,
    step_inputs: &BTreeMap<String, Value>,
    step_outputs: &BTreeMap<String, Value>,
    run_input: &Value,
) -> String {
    let mut output = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find("{{") {
        output.push_str(&rest[..open]);
        let after_open = &rest[open + 2..];
        let Some(close) = after_open.find("}}") else {
            output.push_str(&rest[open..]);
            return output;
        };
        let expr = after_open[..close].trim();
        if let Some(resolved) = lookup_template_expr(expr, step_inputs, step_outputs, run_input) {
            match resolved {
                Value::String(s) => output.push_str(&s),
                Value::Null => {}
                other => output.push_str(&other.to_string()),
            }
        }
        rest = &after_open[close + 2..];
    }
    output.push_str(rest);
    output
}

fn lookup_template_expr(
    expr: &str,
    step_inputs: &BTreeMap<String, Value>,
    step_outputs: &BTreeMap<String, Value>,
    run_input: &Value,
) -> Option<Value> {
    if expr.is_empty() {
        return None;
    }
    if let Some(direct) = step_inputs.get(expr) {
        return Some(direct.clone());
    }
    if let Some(rest) = expr.strip_prefix("steps.") {
        if let Some((step_id, sub_path)) = rest.split_once(".output.") {
            let sub_pointer = format!("/{}", sub_path.trim_start_matches('/').replace('.', "/"));
            if let Some(step_val) = step_outputs
                .get(step_id)
                .or_else(|| step_inputs.get(step_id))
                && let Some(found) = resolve_json_pointer(step_val, &sub_pointer)
            {
                return Some(found.clone());
            }
        } else if let Some(step_id) = rest.strip_suffix(".output")
            && let Some(step_val) = step_outputs
                .get(step_id)
                .or_else(|| step_inputs.get(step_id))
        {
            return Some(step_val.clone());
        }
    }
    if let Some(sub) = expr.strip_prefix("input.") {
        let sub_pointer = format!("/{}", sub.trim_start_matches('/').replace('.', "/"));
        if let Some(found) = resolve_json_pointer(run_input, &sub_pointer) {
            return Some(found.clone());
        }
    }
    if let Some(sub) = expr.strip_prefix("event.") {
        let sub_pointer = format!("/{}", sub.trim_start_matches('/').replace('.', "/"));
        if let Some(found) = resolve_json_pointer(run_input, &sub_pointer) {
            return Some(found.clone());
        }
        let event_pointer = format!("/event{sub_pointer}");
        if let Some(found) = resolve_json_pointer(run_input, &event_pointer) {
            return Some(found.clone());
        }
    }
    if expr.starts_with('/') {
        if let Some(found) = resolve_json_pointer(run_input, expr) {
            return Some(found.clone());
        }
        if let Some((head, tail)) = expr.trim_start_matches('/').split_once('/')
            && let Some(step_val) = step_inputs.get(head).or_else(|| step_outputs.get(head))
            && let Some(found) = resolve_json_pointer(step_val, tail)
        {
            return Some(found.clone());
        }
        return None;
    }
    let pointer = expr.replace('.', "/");
    if let Some((head, tail)) = pointer.split_once('/')
        && let Some(step_val) = step_inputs.get(head).or_else(|| step_outputs.get(head))
        && let Some(found) = resolve_json_pointer(step_val, tail)
    {
        return Some(found.clone());
    }
    resolve_json_pointer(run_input, &pointer).cloned()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::json;

    use super::{interpolate_json_value, interpolate_template};

    #[test]
    fn interpolate_template_resolves_transitive_steps_output_and_event_fields() {
        let step_inputs = BTreeMap::from([("fixResult".to_string(), json!("direct-binding"))]);
        let step_outputs = BTreeMap::from([(
            "diagnose-and-fix".to_string(),
            json!({ "summary": "Fixed race condition in worker" }),
        )]);
        let run_input = json!({
            "threadKey": "github:acme/dimo#42",
            "payload": {
                "workflow_run": {
                    "name": "CI",
                    "html_url": "https://github.com/acme/dimo/actions/runs/9"
                }
            }
        });

        let msg = interpolate_template(
            "已完成 CI 失败排查：{{steps.diagnose-and-fix.output.summary}} ({{payload.workflow_run.name}} · {{threadKey}} · {{event.threadKey}})",
            &step_inputs,
            &step_outputs,
            &run_input,
        );
        assert_eq!(
            msg,
            "已完成 CI 失败排查：Fixed race condition in worker (CI · github:acme/dimo#42 · github:acme/dimo#42)"
        );

        let payload = interpolate_json_value(
            &json!({
                "channelHint": "github_comment",
                "message": "{{steps.diagnose-and-fix.output.summary}}",
                "bound": "{{fixResult}}"
            }),
            &step_inputs,
            &step_outputs,
            &run_input,
        );
        assert_eq!(
            payload,
            json!({
                "channelHint": "github_comment",
                "message": "Fixed race condition in worker",
                "bound": "direct-binding"
            })
        );
    }
}
