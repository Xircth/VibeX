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
    pulse::{SqlitePulseStore, ensure_pulse_schema},
};
use serde_json::{Value, json};
use uuid::Uuid;
use workflows::{
    BotConversationScope, BotStepSpec, ClaimedWorkflowStep, CompleteWorkflowStep, CompletionPolicy,
    DecideUserGate, GroupDispatchMode, GroupStageStepSpec, OutboxActionKind, OutboxActionStepSpec,
    SessionStepSpec, WorkflowCore, WorkflowRunView, WorkflowStep, WorkflowStepSpec,
    WorkspaceAccess, resolve_json_pointer,
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
        let agent_id = AgentId::parse(&session.agent_id)
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
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
        let interpolated = interpolate_template(
            &session.prompt_template,
            &resolved_input.values,
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

        let agent_id = AgentId::parse(&bot_session.agent)
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        let workspace_evidence = json!({
            "isolated": false,
            "workspaceId": bot_session.workspace_id,
            "primitive": "bot",
            "memberId": bot.member_id,
            "conversationScope": bot.conversation_scope,
            "mailboxPolicy": bot.mailbox_policy,
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

        let interpolated =
            interpolate_template(&bot.prompt_template, &resolved_input.values, &run_input);
        let prompt = render_agent_prompt(
            &interpolated,
            &resolved_input.values,
            bot.output_schema.as_ref(),
            None,
            None,
        )?;

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
                    text: prompt,
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
                    "id": "workflow-bot-dispatcher",
                    "workflowRunId": claimed.run.id,
                    "workflowStepId": step.id,
                    "memberId": bot.member_id,
                    "primitive": "bot",
                }),
            })
            .await;

        match submission {
            Ok(submission) => {
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
        let rendered_message =
            interpolate_template(&group.message_template, &resolved_input.values, &run_input);
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

        let run_input = parse_run_input(&claimed.run.input_json);
        let rendered_target =
            interpolate_template(&outbox.target_template, &resolved_input.values, &run_input);
        let rendered_payload =
            interpolate_json_value(&outbox.payload_template, &resolved_input.values, &run_input);
        let target_kind = match outbox.action_kind {
            OutboxActionKind::ReplyChannel => "reply_channel",
            OutboxActionKind::WebhookPost => "webhook_post",
            OutboxActionKind::EmitEvent => "emit_event",
        };
        let dedupe_key = format!(
            "wf-outbox:{}:{}:{}",
            claimed.run.id, step.id, claimed.step.attempt
        );
        let outbox_envelope = json!({
            "target": rendered_target,
            "actionKind": target_kind,
            "payload": rendered_payload,
            "workflowRunId": claimed.run.id,
            "workflowStepId": step.id,
        });

        let pool = &self.context.deployment.db().pool;
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
            let agent_id = AgentId::parse(&agent.agent_id)
                .map_err(|err| ApplicationError::bad_request(err.to_string()))?;
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
            let agent_id = AgentId::parse(&session.agent_id)
                .map_err(|err| ApplicationError::bad_request(err.to_string()))?;
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
            let agent_id = AgentId::parse(&resolved_bot.agent)
                .map_err(|err| ApplicationError::bad_request(err.to_string()))?;
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
    let run = core.store().run(request.run_id).await.map_err(map_error)?;
    let definition = core
        .store()
        .version(run.definition_version_id)
        .await
        .map_err(map_error)?
        .definition()
        .map_err(map_error)?;
    let is_user_gate = definition
        .steps
        .iter()
        .find(|s| s.id == request.step_id)
        .is_some_and(|s| matches!(s.spec, WorkflowStepSpec::UserGate(_)));

    if is_user_gate {
        let selected_option_id = request
            .decision
            .get("selectedOptionId")
            .or_else(|| request.decision.get("optionId"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let note = request
            .decision
            .get("note")
            .and_then(Value::as_str)
            .map(str::to_string);
        let form_data = request
            .decision
            .get("formData")
            .or_else(|| request.decision.get("formValues"))
            .cloned();
        return core
            .decide_user_gate(DecideUserGate {
                run_id: request.run_id,
                step_id: request.step_id,
                selected_option_id,
                note,
                form_data,
                operation_id,
                principal: principal_json(principal),
            })
            .await
            .map_err(map_error);
    }

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

fn interpolate_json_value(
    value: &Value,
    step_inputs: &BTreeMap<String, Value>,
    run_input: &Value,
) -> Value {
    match value {
        Value::String(s) => Value::String(interpolate_template(s, step_inputs, run_input)),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|v| interpolate_json_value(v, step_inputs, run_input))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), interpolate_json_value(v, step_inputs, run_input)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn interpolate_template(
    template: &str,
    step_inputs: &BTreeMap<String, Value>,
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
        if let Some(resolved) = lookup_template_expr(expr, step_inputs, run_input) {
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
    run_input: &Value,
) -> Option<Value> {
    if expr.is_empty() {
        return None;
    }
    let pointer = expr.replace('.', "/");
    if let Some(direct) = step_inputs.get(expr) {
        return Some(direct.clone());
    }
    if let Some((head, tail)) = pointer.split_once('/')
        && let Some(step_val) = step_inputs.get(head)
        && let Some(found) = resolve_json_pointer(step_val, tail)
    {
        return Some(found.clone());
    }
    resolve_json_pointer(run_input, &pointer).cloned()
}
