//! Host-side Pulse Event Engine runtime, `DomainCommand::Pulse*` execution,
//! Rich Target dispatch, and background Temporal & Saga tick worker.

use std::{collections::BTreeMap, sync::Arc, time::Duration};

use agents::{AgentId, AgentSessionConfigOverride, ConversationInputPayload};
use api_types::pulse::{
    BotConversationScope, EventEnvelope, EventSourceKind, EventTrustLevel, GroupDispatchMode,
    MandateOrigin, PulseEvalMode, PulseRuleSpec, PulseSourceView, SessionDeliveryStrategy,
    SessionTargetMode,
};
use application::{
    ApplicationError, ConversationExecutionPort, ConversationSessionExecutionPort, DomainCommand,
    Principal, StartWorkflowRequest, WorkflowExecutionPort, WorkflowStoreExecutionPort,
};
use base64::Engine as _;
use chrono::Utc;
use conversations::{ConversationSteerInput, SubmitConversationInput, collaboration};
use db::models::{
    collaboration_identity::resolve_pulse_bot_session,
    conversation_turn::ConversationTurnRecord,
    pulse::{PulseSourceUpsert, ensure_pulse_schema},
    session::{CreateSession, Session},
    workspace::Workspace,
};
use pulse::{
    CustomSdkEventInput, CustomSdkEventNormalizer, MAX_WEBHOOK_PAYLOAD_BYTES, PulseDispatchAction,
    PulseDispatchPlan, PulseEngine, PulseError, StandardWebhookHeaders, TemporalEvaluator,
    dry_run_rule,
};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;
use workflows::{DecideUserGate, WorkflowCore, WorkflowStore, notify_workflow_work};

use crate::{
    COLLABORATION_SPACE_CHANGED_EVENT,
    domains::ServerApplicationDomains,
    pulse_http::{
        lowercase_headers, normalize_platform_webhook_payload, verify_platform_webhook_secret,
    },
};

pub const PULSE_DECK_CHANGED_EVENT: &str = "vibex://pulse-deck-changed";

pub(crate) const fn is_pulse_domain_command(command: DomainCommand) -> bool {
    matches!(
        command,
        DomainCommand::PulseDeckSnapshot
            | DomainCommand::PulseSourceList
            | DomainCommand::PulseSourceUpsert
            | DomainCommand::PulseSourceDelete
            | DomainCommand::PulseRuleList
            | DomainCommand::PulseRuleSave
            | DomainCommand::PulseRuleSetMode
            | DomainCommand::PulseRuleSetEnabled
            | DomainCommand::PulseRuleDelete
            | DomainCommand::PulseRuleDryRun
            | DomainCommand::PulseEventEmit
            | DomainCommand::PulseCapturedEvents
            | DomainCommand::PulseCandidatePromote
            | DomainCommand::PulseInteractionResolve
            | DomainCommand::PulseThreadSubscribe
            | DomainCommand::PulseThreadUnsubscribe
            | DomainCommand::PulseEventSchemaList
            | DomainCommand::PulseEventSchemaDefine
            | DomainCommand::PulseWebhookIngest
    )
}

impl ServerApplicationDomains {
    async fn ensure_pulse_ready(&self) -> Result<&PulseEngine, ApplicationError> {
        ensure_pulse_schema(&self.pool)
            .await
            .map_err(|err| ApplicationError::internal(err.to_string()))?;
        Ok(self.pulse_engine.as_ref())
    }

    fn emit_pulse_deck_changed(&self) {
        self.events.emit(
            PULSE_DECK_CHANGED_EVENT,
            json!({ "updatedAt": Utc::now().to_rfc3339() }),
        );
    }

    pub(crate) fn spawn_pulse_temporal_worker(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(15));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                interval.tick().await;
                let Some(host) = weak.upgrade() else {
                    break;
                };
                if host.automation_ownership.current()
                    && let Err(error) = host.run_pulse_temporal_tick().await
                {
                    tracing::warn!(?error, "background Pulse temporal tick failed");
                }
                drop(host);
            }
        });
    }

    pub(crate) async fn run_pulse_temporal_tick(&self) -> Result<(), ApplicationError> {
        let engine = self.ensure_pulse_ready().await?;
        let now = Utc::now();
        let report = engine
            .tick_temporal(now, |_| false)
            .await
            .map_err(map_pulse_error)?;

        let wf_core = WorkflowCore::new(WorkflowStore::new(self.pool.clone()));
        for envelope in &report.emitted_events {
            if let Ok(resumed) = wf_core
                .dispatch_event_to_waiting_runs(envelope, Uuid::new_v4())
                .await
                && !resumed.is_empty()
            {
                notify_workflow_work();
            }
        }
        for outcome in &report.outcomes {
            self.execute_pulse_dispatch_plan(&outcome.dispatch_plan)
                .await;
        }
        if let Ok(expired_runs) = wf_core.expire_timed_out_waiting_steps(now).await
            && !expired_runs.is_empty()
        {
            notify_workflow_work();
        }
        if !report.emitted_events.is_empty() || !report.expired_interactions.is_empty() {
            self.emit_pulse_deck_changed();
        }
        Ok(())
    }

    pub(crate) async fn execute_pulse_command(
        &self,
        principal: &Principal,
        command: DomainCommand,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let engine = self.ensure_pulse_ready().await?;
        let now = Utc::now();
        let now_iso = now.to_rfc3339();

        match command {
            DomainCommand::PulseDeckSnapshot => {
                let project_id = args
                    .get("projectId")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty());
                let mut snapshot = engine
                    .deck_snapshot(project_id)
                    .await
                    .map_err(map_pulse_error)?;
                snapshot.engine_active = self.automation_ownership.current();
                to_json_value(snapshot)
            }
            DomainCommand::PulseSourceList => {
                let sources = engine
                    .store()
                    .list_sources()
                    .await
                    .map_err(map_sqlx_error)?;
                to_json_value(sources)
            }
            DomainCommand::PulseSourceUpsert => {
                let payload = unwrap_input(&args);
                let input: PulseSourceUpsertArgs = decode_args(payload)?;
                let title = input.title.trim().to_string();
                if title.is_empty() {
                    return Err(ApplicationError::bad_request("source title is required"));
                }
                let id = input
                    .id
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| Uuid::new_v4().to_string());
                let public_webhook_path = is_webhook_source_kind(input.kind)
                    .then(|| format!("/api/pulse/webhooks/{id}"));
                let record = engine
                    .store()
                    .upsert_source(PulseSourceUpsert {
                        id,
                        kind: input.kind,
                        title,
                        enabled: input.enabled,
                        healthy: true,
                        status_message: None,
                        cursor_watermark: None,
                        public_webhook_path,
                        config_json: input.config_json.unwrap_or_else(|| json!({})),
                        signing_secret: input.signing_secret.filter(|s| !s.trim().is_empty()),
                        now: now_iso,
                    })
                    .await
                    .map_err(map_sqlx_error)?;
                self.emit_pulse_deck_changed();
                let view: PulseSourceView = record.view;
                to_json_value(view)
            }
            DomainCommand::PulseSourceDelete => {
                let id = require_str_field(&args, "id")?;
                engine
                    .store()
                    .delete_source(&id)
                    .await
                    .map_err(map_sqlx_error)?;
                self.emit_pulse_deck_changed();
                Ok(Value::Null)
            }
            DomainCommand::PulseRuleList => {
                let project_id = args
                    .get("projectId")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty());
                let rules = engine
                    .store()
                    .list_rules(project_id)
                    .await
                    .map_err(map_sqlx_error)?;
                to_json_value(rules)
            }
            DomainCommand::PulseRuleSave => {
                let payload = unwrap_input(&args);
                let input: PulseRuleSaveArgs = decode_args(payload)?;
                let mandate = input
                    .mandate_origin
                    .unwrap_or_else(|| mandate_from_principal(principal));
                let saved = engine
                    .save_rule(
                        input.id,
                        input.enabled.unwrap_or(true),
                        mandate,
                        input.spec,
                        input.webhook_route_id,
                        now,
                    )
                    .await
                    .map_err(map_pulse_error)?;
                self.emit_pulse_deck_changed();
                to_json_value(saved)
            }
            DomainCommand::PulseRuleSetMode => {
                let input: PulseRuleSetModeArgs = decode_args(&args)?;
                let updated = engine
                    .store()
                    .set_rule_mode(&input.id, input.eval_mode, &now_iso)
                    .await
                    .map_err(map_sqlx_error)?
                    .ok_or_else(|| {
                        ApplicationError::not_found(format!("pulse rule `{}`", input.id))
                    })?;
                self.emit_pulse_deck_changed();
                to_json_value(updated)
            }
            DomainCommand::PulseRuleSetEnabled => {
                let input: PulseRuleSetEnabledArgs = decode_args(&args)?;
                let existing = engine
                    .store()
                    .get_rule(&input.id)
                    .await
                    .map_err(map_sqlx_error)?
                    .ok_or_else(|| {
                        ApplicationError::not_found(format!("pulse rule `{}`", input.id))
                    })?;
                let next_fire_owned = if input.enabled
                    && existing.spec.eval_mode != PulseEvalMode::Off
                    && let Some(temporal) = &existing.spec.temporal
                {
                    TemporalEvaluator::compute_next_fire_at(temporal, now)
                        .map_err(|err| ApplicationError::bad_request(err.to_string()))?
                        .map(|dt| dt.to_rfc3339())
                } else {
                    None
                };
                let next_fire_ref = if input.enabled {
                    Some(next_fire_owned.as_deref())
                } else {
                    Some(None)
                };
                let updated = engine
                    .store()
                    .set_rule_enabled(&input.id, input.enabled, next_fire_ref, &now_iso)
                    .await
                    .map_err(map_sqlx_error)?
                    .ok_or_else(|| {
                        ApplicationError::not_found(format!("pulse rule `{}`", input.id))
                    })?;
                self.emit_pulse_deck_changed();
                to_json_value(updated)
            }
            DomainCommand::PulseRuleDelete => {
                let id = require_str_field(&args, "id")?;
                engine
                    .store()
                    .delete_rule(&id)
                    .await
                    .map_err(map_sqlx_error)?;
                self.emit_pulse_deck_changed();
                Ok(Value::Null)
            }
            DomainCommand::PulseRuleDryRun => {
                let input: PulseRuleDryRunArgs = decode_args(&args)?;
                let report = dry_run_rule(&input.spec, &input.sample_event);
                to_json_value(report)
            }
            DomainCommand::PulseEventEmit => {
                let payload = unwrap_input(&args);
                let envelope = build_emitted_envelope(principal, payload, now)?;
                ensure_sdk_source_exists(engine, &envelope.source.instance_id, &now_iso).await?;
                let outcome = engine
                    .ingest_event(envelope.clone(), now)
                    .await
                    .map_err(map_pulse_error)?;
                if !outcome.duplicate_delivery && outcome.rejected_reason.is_none() {
                    self.resume_waiting_workflows(&envelope).await;
                    self.execute_pulse_dispatch_plan(&outcome.dispatch_plan)
                        .await;
                    self.emit_pulse_deck_changed();
                }
                to_json_value(envelope)
            }
            DomainCommand::PulseCapturedEvents => {
                let limit = args
                    .get("limit")
                    .and_then(Value::as_u64)
                    .and_then(|n| u32::try_from(n).ok())
                    .unwrap_or(25);
                let events = engine
                    .store()
                    .list_recent_envelopes(limit)
                    .await
                    .map_err(map_sqlx_error)?;
                to_json_value(events)
            }
            DomainCommand::PulseCandidatePromote => {
                let candidate_id = require_str_field_aliases(&args, &["candidateId", "id"])?;
                let plan = engine
                    .promote_observed_candidate(&candidate_id, true, now)
                    .await
                    .map_err(map_pulse_error)?;
                self.execute_pulse_dispatch_plan(&plan).await;
                self.emit_pulse_deck_changed();
                Ok(json!({
                    "promoted": true,
                    "candidateId": candidate_id,
                }))
            }
            DomainCommand::PulseInteractionResolve => {
                let payload = unwrap_input(&args);
                let input: PulseResolveInteractionArgs = decode_args(payload)?;
                let resolution = json!({
                    "optionId": input.option_id,
                    "note": input.note,
                    "formValues": input.form_values,
                });
                let resolved = engine
                    .store()
                    .resolve_user_interaction(&input.interaction_id, &resolution, &now_iso)
                    .await
                    .map_err(map_sqlx_error)?
                    .ok_or_else(|| {
                        ApplicationError::not_found(format!(
                            "pulse interaction `{}`",
                            input.interaction_id
                        ))
                    })?;

                if let (Some(raw_run_id), Some(step_id)) = (
                    resolved.view.workflow_run_id.as_deref(),
                    resolved.view.step_id.as_deref(),
                ) && let Ok(wf_run_id) = Uuid::parse_str(raw_run_id)
                {
                    let wf_core = WorkflowCore::new(WorkflowStore::new(self.pool.clone()));
                    let _ = wf_core
                        .decide_user_gate(DecideUserGate {
                            run_id: wf_run_id,
                            step_id: step_id.to_string(),
                            selected_option_id: input.option_id,
                            note: input.note,
                            form_data: input.form_values,
                            operation_id: Uuid::new_v4(),
                            principal: json!({ "source": "pulse_interaction_resolve" }),
                        })
                        .await;
                    notify_workflow_work();
                }

                self.emit_pulse_deck_changed();
                to_json_value(resolved.view)
            }
            DomainCommand::PulseThreadSubscribe => {
                let input: PulseThreadSubscribeArgs = decode_args(&args)?;
                let thread_key = input.thread_key.trim();
                let subscriber_id = input.subscriber_id.trim();
                if thread_key.is_empty() || subscriber_id.is_empty() {
                    return Err(ApplicationError::bad_request(
                        "threadKey and subscriberId are required",
                    ));
                }
                if !matches!(
                    input.subscriber_kind.as_str(),
                    "session" | "bot" | "group" | "workflow"
                ) {
                    return Err(ApplicationError::bad_request(format!(
                        "unsupported subscriberKind `{}`",
                        input.subscriber_kind
                    )));
                }
                let sub = engine
                    .store()
                    .subscribe_thread(
                        &Uuid::new_v4().to_string(),
                        thread_key,
                        &input.subscriber_kind,
                        subscriber_id,
                        &now_iso,
                    )
                    .await
                    .map_err(map_sqlx_error)?;
                if input.active == Some(false) {
                    let _ = engine
                        .store()
                        .unsubscribe_thread(&sub.id)
                        .await
                        .map_err(map_sqlx_error)?;
                }
                self.emit_pulse_deck_changed();
                to_json_value(sub)
            }
            DomainCommand::PulseThreadUnsubscribe => {
                let sub_id = require_str_field_aliases(&args, &["subscriptionId", "id"])?;
                engine
                    .store()
                    .unsubscribe_thread(&sub_id)
                    .await
                    .map_err(map_sqlx_error)?;
                self.emit_pulse_deck_changed();
                Ok(Value::Null)
            }
            DomainCommand::PulseEventSchemaList => {
                let schemas = engine
                    .store()
                    .list_event_schemas()
                    .await
                    .map_err(map_sqlx_error)?;
                to_json_value(schemas)
            }
            DomainCommand::PulseEventSchemaDefine => {
                let input: PulseEventSchemaDefineArgs = decode_args(&args)?;
                let event_type = input.event_type.trim();
                let summary = input.summary.trim();
                if event_type.is_empty() || summary.is_empty() {
                    return Err(ApplicationError::bad_request(
                        "eventType and summary are required",
                    ));
                }
                let schema = engine
                    .store()
                    .upsert_event_schema(event_type, summary, &input.json_schema, false, &now_iso)
                    .await
                    .map_err(map_sqlx_error)?;
                to_json_value(schema)
            }
            DomainCommand::PulseWebhookIngest => {
                let input: PulseWebhookIngestArgs = decode_args(&args)?;
                self.ingest_webhook_request(engine, input, now).await
            }
            other => Err(ApplicationError::internal(format!(
                "unexpected non-pulse command `{}` routed to pulse runtime",
                other.as_str()
            ))),
        }
    }

    async fn ingest_webhook_request(
        &self,
        engine: &PulseEngine,
        input: PulseWebhookIngestArgs,
        now: chrono::DateTime<Utc>,
    ) -> Result<Value, ApplicationError> {
        let now_iso = now.to_rfc3339();
        let raw_bytes = base64::engine::general_purpose::STANDARD
            .decode(input.raw_body_base64.as_bytes())
            .map_err(|err| {
                ApplicationError::bad_request(format!("invalid webhook body encoding: {err}"))
            })?;

        if raw_bytes.len() > MAX_WEBHOOK_PAYLOAD_BYTES {
            return Err(ApplicationError::bad_request(format!(
                "webhook payload exceeds {MAX_WEBHOOK_PAYLOAD_BYTES} bytes"
            )));
        }

        let webhook_path = format!("/api/pulse/webhooks/{}", input.source_id);
        let source = match engine
            .store()
            .get_source(&input.source_id)
            .await
            .map_err(map_sqlx_error)?
        {
            Some(found) => found,
            None => engine
                .store()
                .get_source_by_webhook_path(&webhook_path)
                .await
                .map_err(map_sqlx_error)?
                .ok_or_else(|| {
                    ApplicationError::not_found(format!("pulse source `{}`", input.source_id))
                })?,
        };

        if !source.view.enabled {
            return Err(ApplicationError::conflict(format!(
                "pulse source `{}` is disabled",
                source.view.id
            )));
        }

        let headers = lowercase_headers(&input.headers);
        let event_type_override = headers.get("x-pulse-event-type").map(String::as_str);

        if source.view.kind == EventSourceKind::WebhookStandard {
            let std_headers = StandardWebhookHeaders {
                webhook_id: headers.get("webhook-id").map(String::as_str).unwrap_or(""),
                webhook_timestamp: headers
                    .get("webhook-timestamp")
                    .map(String::as_str)
                    .unwrap_or(""),
                webhook_signature: headers
                    .get("webhook-signature")
                    .map(String::as_str)
                    .unwrap_or(""),
            };
            let outcome = engine
                .ingest_standard_webhook(
                    &source.view.id,
                    std_headers,
                    &raw_bytes,
                    event_type_override,
                    now,
                )
                .await
                .map_err(map_pulse_error)?;

            if !outcome.duplicate_delivery && outcome.rejected_reason.is_none() {
                if let Ok(Some(envelope)) = engine
                    .store()
                    .get_envelope_by_event_id(&outcome.dispatch_plan.event_id)
                    .await
                {
                    self.resume_waiting_workflows(&envelope).await;
                }
                self.execute_pulse_dispatch_plan(&outcome.dispatch_plan)
                    .await;
                self.emit_pulse_deck_changed();
            }

            return Ok(json!({
                "accepted": outcome.rejected_reason.is_none(),
                "eventId": outcome.dispatch_plan.event_id,
                "duplicateDelivery": outcome.duplicate_delivery,
                "rejectedReason": outcome.rejected_reason,
            }));
        }

        // Non-Standard-Webhook platform/custom sources: verify configured secret BEFORE JSON parse!
        if let Some(secret) = source
            .signing_secret
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            && let Err(reason) = verify_platform_webhook_secret(secret, &headers, &raw_bytes, now)
        {
            let _ = engine
                .store()
                .increment_source_rejected(&source.view.id, Some(&reason), &now_iso)
                .await;
            self.emit_pulse_deck_changed();
            return Err(ApplicationError::unauthorized(reason));
        }

        let parsed_json: Value = serde_json::from_slice(&raw_bytes).map_err(|err| {
            ApplicationError::bad_request(format!("webhook body is not valid JSON: {err}"))
        })?;

        // Feishu URL challenge handshake before normalization.
        if source.view.kind == EventSourceKind::Feishu
            && let Some(challenge) = parsed_json.get("challenge").and_then(Value::as_str)
        {
            return Ok(json!({ "challenge": challenge }));
        }

        let envelope = normalize_platform_webhook_payload(
            &source.view.id,
            source.view.kind,
            &source.config_json,
            &headers,
            &parsed_json,
            now,
        )?;

        let outcome = engine
            .ingest_event(envelope.clone(), now)
            .await
            .map_err(map_pulse_error)?;
        if !outcome.duplicate_delivery && outcome.rejected_reason.is_none() {
            self.resume_waiting_workflows(&envelope).await;
            self.execute_pulse_dispatch_plan(&outcome.dispatch_plan)
                .await;
            self.emit_pulse_deck_changed();
        }

        Ok(json!({
            "accepted": outcome.rejected_reason.is_none(),
            "eventId": envelope.event_id,
            "duplicateDelivery": outcome.duplicate_delivery,
            "rejectedReason": outcome.rejected_reason,
        }))
    }

    async fn resume_waiting_workflows(&self, envelope: &EventEnvelope) {
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
        for action in &plan.actions {
            if let Err(error) = self.execute_pulse_dispatch_action(action).await {
                tracing::debug!(?error, "Pulse dispatch action completed in best-effort mode");
            }
        }
    }

    async fn execute_pulse_dispatch_action(
        &self,
        action: &PulseDispatchAction,
    ) -> Result<(), String> {
        match action {
            PulseDispatchAction::SpawnOrSendSession {
                mode,
                agent_id,
                model_override,
                project_id,
                existing_session_id,
                delivery_strategy,
                thread_key,
                prompt,
                ..
            } => {
                let workspace = self
                    .resolve_default_workspace(project_id.as_deref())
                    .await?
                    .ok_or_else(|| "no workspace available for Pulse session target".to_string())?;
                let parsed_agent = resolve_fallback_agent_id(agent_id)?;

                let conversation_id = match mode {
                    SessionTargetMode::ExistingSession => existing_session_id
                        .as_deref()
                        .and_then(|raw| Uuid::parse_str(raw).ok())
                        .ok_or_else(|| "existingSessionId is not a valid UUID".to_string())?,
                    SessionTargetMode::EphemeralFresh | SessionTargetMode::ThreadKeyed => {
                        let new_id = Uuid::new_v4();
                        let label = match thread_key.as_deref() {
                            Some(tk) => format!("Pulse · {tk}"),
                            None => "Pulse Session".to_string(),
                        };
                        Session::create(
                            &self.pool,
                            &CreateSession {
                                executor: Some(parsed_agent.as_str().to_string()),
                                agent_id: Some(parsed_agent.clone()),
                                task_id: Some(workspace.task_id),
                                name: Some(label),
                                initial_prompt: Some(prompt.clone()),
                                status: None,
                            },
                            new_id,
                            workspace.id,
                        )
                        .await
                        .map_err(|err| err.to_string())?;
                        new_id
                    }
                };

                let port = ConversationSessionExecutionPort::new(self.conversations.clone());
                if *delivery_strategy == SessionDeliveryStrategy::Steer {
                    let active_turn_id = ConversationTurnRecord::list_for_conversation(
                        &self.pool,
                        conversation_id,
                    )
                    .await
                    .ok()
                    .and_then(|turns| {
                        turns.into_iter().rev().find(|turn| {
                            matches!(
                                turn.status.as_str(),
                                "pending" | "queued" | "running" | "blocked"
                            )
                        })
                    })
                    .map(|turn| turn.id);

                    if let Some(expected_turn_id) = active_turn_id
                        && port
                            .steer(ConversationSteerInput {
                                conversation_id,
                                expected_turn_id,
                                operation_id: Uuid::new_v4(),
                                text: prompt.clone(),
                                images: Vec::new(),
                                principal: json!({ "source": "pulse_session_steer" }),
                            })
                            .await
                            .is_ok()
                    {
                        return Ok(());
                    }
                }

                let mut config_overrides = Vec::new();
                if let Some(model) = model_override.as_deref().filter(|s| !s.trim().is_empty()) {
                    config_overrides.push(AgentSessionConfigOverride {
                        key: "model".to_string(),
                        value: model.to_string(),
                    });
                }
                port.submit_input(SubmitConversationInput {
                    conversation_id,
                    operation_id: Uuid::new_v4(),
                    payload: ConversationInputPayload {
                        continuation_policy: None,
                        expected_binding_revision: None,
                        agent_id: parsed_agent,
                        workspace_id: workspace.id,
                        executor_profile_id: None,
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
                    principal: json!({ "source": "pulse_session_dispatch" }),
                })
                .await
                .map_err(|err| err.to_string())?;
                Ok(())
            }
            PulseDispatchAction::EnqueueBotMailbox {
                member_id,
                conversation_scope,
                thread_key,
                ..
            } => {
                let Some(workspace) = self.resolve_default_workspace(None).await? else {
                    return Ok(());
                };
                let Some(claimed) = self
                    .pulse_engine
                    .claim_next_bot_turn(member_id, Utc::now())
                    .await
                    .map_err(|err| err.to_string())?
                else {
                    return Ok(());
                };
                let topic_key = match conversation_scope {
                    BotConversationScope::FixedPrimary => None,
                    BotConversationScope::PerThreadTopic => thread_key.as_deref(),
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
                        let _ = self
                            .pulse_engine
                            .store()
                            .fail_bot_turn(&claimed.primary.id)
                            .await;
                        return Err(err.to_string());
                    }
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
                        let _ = self
                            .pulse_engine
                            .store()
                            .complete_bot_turn(&claimed.primary.id)
                            .await;
                        Ok(())
                    }
                    Err(err) => {
                        let _ = self
                            .pulse_engine
                            .store()
                            .fail_bot_turn(&claimed.primary.id)
                            .await;
                        Err(err.to_string())
                    }
                }
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

    async fn resolve_default_workspace(
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

// =============================================================================
// Request DTOs & Helpers
// =============================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PulseSourceUpsertArgs {
    #[serde(default)]
    id: Option<String>,
    kind: EventSourceKind,
    title: String,
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default)]
    config_json: Option<Value>,
    #[serde(default)]
    signing_secret: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PulseRuleSaveArgs {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    mandate_origin: Option<MandateOrigin>,
    #[serde(default)]
    webhook_route_id: Option<String>,
    spec: PulseRuleSpec,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PulseRuleSetModeArgs {
    id: String,
    eval_mode: PulseEvalMode,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PulseRuleSetEnabledArgs {
    id: String,
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PulseRuleDryRunArgs {
    spec: PulseRuleSpec,
    sample_event: EventEnvelope,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PulseResolveInteractionArgs {
    interaction_id: String,
    #[serde(default)]
    option_id: Option<String>,
    #[serde(default)]
    note: Option<String>,
    #[serde(default)]
    form_values: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PulseThreadSubscribeArgs {
    thread_key: String,
    subscriber_kind: String,
    subscriber_id: String,
    #[serde(default)]
    active: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PulseEventSchemaDefineArgs {
    event_type: String,
    summary: String,
    json_schema: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PulseWebhookIngestArgs {
    source_id: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    raw_body_base64: String,
}

const fn default_true() -> bool {
    true
}

const fn is_webhook_source_kind(kind: EventSourceKind) -> bool {
    matches!(
        kind,
        EventSourceKind::Feishu
            | EventSourceKind::Jira
            | EventSourceKind::Github
            | EventSourceKind::WebhookStandard
            | EventSourceKind::WebhookCustom
    )
}

fn unwrap_input(args: &Value) -> &Value {
    args.get("input").unwrap_or(args)
}

fn decode_args<T: serde::de::DeserializeOwned>(value: &Value) -> Result<T, ApplicationError> {
    serde_json::from_value(value.clone()).map_err(|err| ApplicationError::bad_request(err.to_string()))
}

fn to_json_value<T: serde::Serialize>(value: T) -> Result<Value, ApplicationError> {
    serde_json::to_value(value).map_err(|err| ApplicationError::internal(err.to_string()))
}

fn require_str_field(value: &Value, key: &str) -> Result<String, ApplicationError> {
    require_str_field_aliases(value, &[key])
}

fn require_str_field_aliases(value: &Value, keys: &[&str]) -> Result<String, ApplicationError> {
    for key in keys {
        if let Some(found) = value
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return Ok(found.to_string());
        }
    }
    Err(ApplicationError::bad_request(format!(
        "missing required string field `{}`",
        keys.first().copied().unwrap_or("id")
    )))
}

fn mandate_from_principal(principal: &Principal) -> MandateOrigin {
    match principal {
        Principal::LocalDesktop => MandateOrigin::ExplicitHuman,
        Principal::Remote { subject, .. } if subject == "pulse-webhook-intake" => {
            MandateOrigin::UntrustedExternal
        }
        Principal::Remote { .. } => MandateOrigin::ExplicitHuman,
    }
}

fn build_emitted_envelope(
    principal: &Principal,
    payload: &Value,
    now: chrono::DateTime<Utc>,
) -> Result<EventEnvelope, ApplicationError> {
    if payload.get("eventId").is_some() && payload.get("source").is_some() {
        return decode_args::<EventEnvelope>(payload);
    }

    let event_type = payload
        .get("eventType")
        .or_else(|| payload.get("event_type"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let thread_key = payload
        .get("threadKey")
        .or_else(|| payload.get("thread_key"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let instance_id = payload
        .get("sourceInstanceId")
        .and_then(Value::as_str)
        .unwrap_or("sdk:default")
        .to_string();
    let actor_id = match principal {
        Principal::LocalDesktop => "user:local-desktop".to_string(),
        Principal::Remote { subject, .. } => subject.clone(),
    };
    let trust_level = match principal {
        Principal::LocalDesktop => EventTrustLevel::TrustedHuman,
        Principal::Remote { .. } => EventTrustLevel::TrustedInternal,
    };

    CustomSdkEventNormalizer::normalize(
        CustomSdkEventInput {
            instance_id,
            event_type,
            delivery_id: payload
                .get("deliveryId")
                .and_then(Value::as_str)
                .map(str::to_string),
            actor_id,
            actor_display_name: None,
            trust_level,
            thread_key,
            correlations: Vec::new(),
            reply_channels: Vec::new(),
            parent_envelope: None,
            parent_run_id: None,
            payload: payload.get("payload").cloned().unwrap_or_else(|| json!({})),
        },
        now,
    )
    .map_err(|err| ApplicationError::bad_request(err.to_string()))
}

async fn ensure_sdk_source_exists(
    engine: &PulseEngine,
    instance_id: &str,
    now_iso: &str,
) -> Result<(), ApplicationError> {
    if engine
        .store()
        .get_source(instance_id)
        .await
        .map_err(map_sqlx_error)?
        .is_some()
    {
        return Ok(());
    }
    engine
        .store()
        .upsert_source(PulseSourceUpsert {
            id: instance_id.to_string(),
            kind: EventSourceKind::SdkCustom,
            title: format!("SDK Custom ({instance_id})"),
            enabled: true,
            healthy: true,
            status_message: None,
            cursor_watermark: None,
            public_webhook_path: None,
            config_json: json!({}),
            signing_secret: None,
            now: now_iso.to_string(),
        })
        .await
        .map_err(map_sqlx_error)?;
    Ok(())
}

fn resolve_fallback_agent_id(raw: &str) -> Result<AgentId, String> {
    AgentId::parse(raw)
        .or_else(|_| AgentId::parse("claude-code"))
        .map_err(|err| err.to_string())
}

fn map_sqlx_error(err: sqlx::Error) -> ApplicationError {
    ApplicationError::internal(err.to_string())
}

fn map_pulse_error(err: PulseError) -> ApplicationError {
    match err {
        PulseError::Database(db_err) => ApplicationError::internal(db_err.to_string()),
        PulseError::ValidationFailed(violations) => ApplicationError::bad_request(format!(
            "Pulse rule validation failed with {} violation(s)",
            violations.len()
        ))
        .with_detail(json!({ "violations": violations })),
        PulseError::WebhookRejected(verify_err) => {
            ApplicationError::unauthorized(verify_err.to_string())
        }
        PulseError::Temporal(temp_err) => ApplicationError::bad_request(temp_err.to_string()),
        PulseError::NotFound(entity) => ApplicationError::not_found(entity),
    }
}
