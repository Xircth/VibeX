//! Host-side Pulse Event Engine runtime, `DomainCommand::Pulse*` execution,
//! principal/mandate enforcement, webhook verification, and Temporal/Outbox background worker.

use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicI64, Ordering},
    },
    time::Duration,
};

use api_types::pulse::{
    EventEnvelope, EventSourceKind, EventTrustLevel, MandateOrigin, PulseEvalMode, PulseRuleSpec,
    PulseSourceView,
};
use application::{ApplicationError, DomainCommand, Principal};
use base64::Engine as _;
use chrono::Utc;
use db::models::pulse::{PulseSourceUpsert, ensure_pulse_schema, pulse_outbox_wake};
use pulse::{
    CustomSdkEventInput, CustomSdkEventNormalizer, MAX_WEBHOOK_PAYLOAD_BYTES, PulseEngine,
    PulseError, StandardWebhookHeaders, TemporalEvaluator, dry_run_rule, verify_standard_webhook,
};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;
use workflows::{DecideUserGate, WorkflowCore, WorkflowStore, notify_workflow_work};

use crate::{
    domains::ServerApplicationDomains,
    pulse_http::{
        lowercase_headers, normalize_platform_webhook_payload, verify_platform_webhook_secret,
    },
};

pub const PULSE_DECK_CHANGED_EVENT: &str = "vibex://pulse-deck-changed";

static LAST_RECEIPT_PRUNE_EPOCH_SECS: AtomicI64 = AtomicI64::new(0);

pub(crate) const fn is_pulse_domain_command(command: DomainCommand) -> bool {
    matches!(
        command,
        DomainCommand::PulseDeckSnapshot
            | DomainCommand::PulseSourceList
            | DomainCommand::PulseSourceUpsert
            | DomainCommand::PulseSourceDelete
            | DomainCommand::PulseSourceTest
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
    pub(crate) async fn ensure_pulse_ready(&self) -> Result<&PulseEngine, ApplicationError> {
        ensure_pulse_schema(&self.pool)
            .await
            .map_err(|err| ApplicationError::internal(err.to_string()))?;
        Ok(self.pulse_engine.as_ref())
    }

    pub(crate) fn emit_pulse_deck_changed(&self) {
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
            interval.tick().await;
            let mut drain_pending = true;
            loop {
                let woken = pulse_outbox_wake().notified();
                tokio::pin!(woken);
                woken.as_mut().enable();

                if drain_pending {
                    drain_pending = false;
                    let Some(host) = weak.upgrade() else {
                        break;
                    };
                    if host.automation_ownership.current() {
                        host.drain_pulse_outbox().await;
                    }
                    drop(host);
                }

                let outbox_woke = tokio::select! {
                    _ = interval.tick() => false,
                    _ = &mut woken => true,
                };
                let Some(host) = weak.upgrade() else {
                    break;
                };
                if host.automation_ownership.current() {
                    if outbox_woke {
                        drain_pending = true;
                    } else if let Err(error) = host.run_pulse_temporal_tick().await {
                        tracing::warn!(?error, "background Pulse temporal tick failed");
                    }
                }
                drop(host);
            }
        });
    }

    pub(crate) async fn run_pulse_temporal_tick(&self) -> Result<(), ApplicationError> {
        let engine = self.ensure_pulse_ready().await?;
        let now = Utc::now();
        let busy_rule_ids = self.compute_busy_pulse_rule_ids().await;
        let report = engine
            .tick_temporal(now, |rule_id| busy_rule_ids.contains(rule_id))
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

        self.poll_github_sources(engine, now).await;
        self.drain_pulse_outbox().await;
        self.drain_all_queued_bot_mailboxes().await;

        let now_epoch = now.timestamp();
        let prev_prune = LAST_RECEIPT_PRUNE_EPOCH_SECS.load(Ordering::Relaxed);
        if now_epoch.saturating_sub(prev_prune) >= 3600
            && LAST_RECEIPT_PRUNE_EPOCH_SECS
                .compare_exchange(
                    prev_prune,
                    now_epoch,
                    Ordering::Relaxed,
                    Ordering::Relaxed,
                )
                .is_ok()
        {
            let cutoff = (now - chrono::Duration::days(7)).to_rfc3339();
            let _ = engine.store().prune_receipts_before(&cutoff).await;
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
                    .or_else(|| args.get("project_id"))
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty());
                let mut snapshot = engine
                    .deck_snapshot(project_id)
                    .await
                    .map_err(map_pulse_error)?;
                let mut busy_ids: Vec<String> =
                    self.compute_busy_pulse_rule_ids().await.into_iter().collect();
                busy_ids.sort();
                snapshot.busy_rule_ids = busy_ids;
                snapshot.recent_outbox = engine
                    .store()
                    .list_recent_outbox(30)
                    .await
                    .map_err(map_sqlx_error)?
                    .into_iter()
                    .map(|r| r.to_entry_view())
                    .collect();
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
                let existing = engine
                    .store()
                    .get_source(&id)
                    .await
                    .map_err(map_sqlx_error)?;
                let config_json = input
                    .config_json
                    .or_else(|| existing.as_ref().map(|e| e.config_json.clone()))
                    .unwrap_or_else(|| json!({}));
                let new_secret = input
                    .signing_secret
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
                let should_clear_secret =
                    new_secret.is_none() && input.clear_signing_secret == Some(true);
                let effective_secret = if should_clear_secret {
                    None
                } else {
                    new_secret.or_else(|| existing.as_ref().and_then(|e| e.signing_secret.clone()))
                };
                let public_webhook_path = is_webhook_source_kind(input.kind)
                    .then(|| format!("/api/pulse/webhooks/{id}"));
                let mut record = engine
                    .store()
                    .upsert_source(PulseSourceUpsert {
                        id: id.clone(),
                        kind: input.kind,
                        title,
                        enabled: input.enabled,
                        healthy: existing.as_ref().map(|e| e.view.healthy).unwrap_or(true),
                        status_message: existing
                            .as_ref()
                            .and_then(|e| e.view.status_message.clone()),
                        cursor_watermark: existing
                            .as_ref()
                            .and_then(|e| e.view.cursor_watermark.clone()),
                        public_webhook_path,
                        config_json,
                        signing_secret: effective_secret,
                        now: now_iso.clone(),
                    })
                    .await
                    .map_err(map_sqlx_error)?;
                if should_clear_secret
                    && let Some(cleared) = engine
                        .store()
                        .clear_source_signing_secret(&id, &now_iso)
                        .await
                        .map_err(map_sqlx_error)?
                {
                    record = cleared;
                }
                crate::pulse_connectors::reset_github_poll_cooldown(&id);
                self.emit_pulse_deck_changed();
                let view: PulseSourceView = record.view;
                to_json_value(view)
            }
            DomainCommand::PulseSourceDelete => {
                let id = require_str_field_aliases(&args, &["id", "sourceId", "source_id"])?;
                engine
                    .store()
                    .delete_source(&id)
                    .await
                    .map_err(map_sqlx_error)?;
                crate::pulse_connectors::reset_github_poll_cooldown(&id);
                self.emit_pulse_deck_changed();
                Ok(Value::Null)
            }
            DomainCommand::PulseSourceTest => {
                let result = self.execute_pulse_source_test(engine, &args, now).await?;
                to_json_value(result)
            }
            DomainCommand::PulseRuleList => {
                let project_id = args
                    .get("projectId")
                    .or_else(|| args.get("project_id"))
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
                let mandate = resolve_effective_mandate(principal, input.mandate_origin);
                let saved = engine
                    .save_rule_with_draft(
                        input.id,
                        input.enabled.unwrap_or(true),
                        input.draft_only.unwrap_or(false),
                        mandate,
                        input.spec,
                        input.webhook_route_id,
                        now,
                    )
                    .await
                    .map_err(map_pulse_error)?;
                if !saved.enabled {
                    engine.disarm_rule_sla(&saved.id);
                }
                self.emit_pulse_deck_changed();
                to_json_value(saved)
            }
            DomainCommand::PulseRuleSetMode => {
                let payload = unwrap_input(&args);
                let input: PulseRuleSetModeArgs = decode_args(payload)?;
                let updated = engine
                    .store()
                    .set_rule_mode(&input.id, input.eval_mode, &now_iso)
                    .await
                    .map_err(map_sqlx_error)?
                    .ok_or_else(|| {
                        ApplicationError::not_found(format!("pulse rule `{}`", input.id))
                    })?;
                if input.eval_mode == PulseEvalMode::Off {
                    engine.disarm_rule_sla(&input.id);
                }
                self.emit_pulse_deck_changed();
                to_json_value(updated)
            }
            DomainCommand::PulseRuleSetEnabled => {
                let payload = unwrap_input(&args);
                let input: PulseRuleSetEnabledArgs = decode_args(payload)?;
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
                    engine.disarm_rule_sla(&input.id);
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
                let id = require_str_field_aliases(&args, &["id", "ruleId", "rule_id"])?;
                engine
                    .store()
                    .delete_rule(&id)
                    .await
                    .map_err(map_sqlx_error)?;
                engine.disarm_rule_sla(&id);
                self.emit_pulse_deck_changed();
                Ok(Value::Null)
            }
            DomainCommand::PulseRuleDryRun => {
                let payload = unwrap_input(&args);
                let input: PulseRuleDryRunArgs = decode_args(payload)?;
                let report = dry_run_rule(&input.spec, &input.sample_event);
                to_json_value(report)
            }
            DomainCommand::PulseEventEmit => {
                let (effective_principal, payload_owned);
                let (emit_principal, payload) = if matches!(
                    principal,
                    Principal::Remote { subject, .. } if subject == "pulse-sdk-hmac"
                ) {
                    let (verified_source_id, event_body) =
                        self.verify_sdk_hmac_emit(engine, &args, now).await?;
                    effective_principal = Principal::remote(
                        format!("pulse-sdk:{verified_source_id}"),
                        [String::from("automation.write")],
                    );
                    payload_owned = event_body;
                    (&effective_principal, &payload_owned)
                } else {
                    (principal, unwrap_input(&args))
                };
                let envelope = build_emitted_envelope(emit_principal, payload, now)?;
                ensure_sdk_source_exists(engine, &envelope.source.instance_id, &now_iso).await?;
                let outcome = engine
                    .ingest_event(envelope.clone(), now)
                    .await
                    .map_err(map_pulse_error)?;
                if !outcome.duplicate_delivery && outcome.rejected_reason.is_none() {
                    self.resume_waiting_workflows(&envelope).await;
                    self.execute_pulse_dispatch_plan(&outcome.dispatch_plan)
                        .await;
                    self.drain_pulse_outbox().await;
                    self.emit_pulse_deck_changed();
                }
                to_json_value(envelope)
            }
            DomainCommand::PulseCapturedEvents => {
                let limit = args
                    .get("limit")
                    .and_then(Value::as_u64)
                    .or_else(|| {
                        args.get("limit")
                            .and_then(Value::as_str)
                            .and_then(|s| s.parse().ok())
                    })
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
                let candidate_id =
                    require_str_field_aliases(&args, &["candidateId", "candidate_id", "id"])?;
                let (plan, envelope) = engine
                    .promote_observed_candidate_with_envelope(&candidate_id, true, now)
                    .await
                    .map_err(map_pulse_error)?;
                self.resume_waiting_workflows(&envelope).await;
                self.execute_pulse_dispatch_plan(&plan).await;
                self.drain_pulse_outbox().await;
                self.emit_pulse_deck_changed();
                Ok(json!({
                    "promoted": true,
                    "candidateId": candidate_id,
                }))
            }
            DomainCommand::PulseInteractionResolve => {
                let payload = unwrap_input(&args);
                let input: PulseResolveInteractionArgs = decode_args(payload)?;
                let existing = engine
                    .store()
                    .get_user_interaction(&input.interaction_id)
                    .await
                    .map_err(map_sqlx_error)?
                    .ok_or_else(|| {
                        ApplicationError::not_found(format!(
                            "pulse interaction `{}`",
                            input.interaction_id
                        ))
                    })?;

                let resolved = if let (Some(raw_run_id), Some(step_id)) = (
                    existing.view.workflow_run_id.as_deref(),
                    existing.view.step_id.as_deref(),
                ) && let Ok(wf_run_id) = Uuid::parse_str(raw_run_id)
                {
                    let wf_core = WorkflowCore::new(WorkflowStore::new(self.pool.clone()));
                    wf_core
                        .decide_user_gate(DecideUserGate {
                            run_id: wf_run_id,
                            step_id: step_id.to_string(),
                            selected_option_id: input.option_id.clone(),
                            note: input.note.clone(),
                            form_data: input.form_values.clone(),
                            operation_id: Uuid::new_v4(),
                            principal: json!({ "source": "pulse_interaction_resolve" }),
                        })
                        .await
                        .map_err(|err| ApplicationError::bad_request(err.to_string()))?;
                    notify_workflow_work();
                    engine
                        .store()
                        .get_user_interaction(&input.interaction_id)
                        .await
                        .map_err(map_sqlx_error)?
                        .unwrap_or(existing)
                } else {
                    let resolution = json!({
                        "optionId": input.option_id,
                        "note": input.note,
                        "formValues": input.form_values,
                    });
                    engine
                        .store()
                        .resolve_user_interaction(&input.interaction_id, &resolution, &now_iso)
                        .await
                        .map_err(map_sqlx_error)?
                        .unwrap_or(existing)
                };

                self.emit_pulse_deck_changed();
                to_json_value(resolved.view)
            }
            DomainCommand::PulseThreadSubscribe => {
                let payload = unwrap_input(&args);
                let input: PulseThreadSubscribeArgs = decode_args(payload)?;
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
                let sub_id = require_str_field_aliases(
                    &args,
                    &["subscriptionId", "subscription_id", "id"],
                )?;
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
                let payload = unwrap_input(&args);
                let input: PulseEventSchemaDefineArgs = decode_args(payload)?;
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

    pub(crate) async fn ingest_webhook_request(
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
                self.drain_pulse_outbox().await;
                self.emit_pulse_deck_changed();
            }

            return Ok(json!({
                "accepted": outcome.rejected_reason.is_none(),
                "eventId": outcome.dispatch_plan.event_id,
                "duplicateDelivery": outcome.duplicate_delivery,
                "rejectedReason": outcome.rejected_reason,
            }));
        }

        let allow_unsigned = source
            .config_json
            .get("allowUnsigned")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let configured_secret = source
            .signing_secret
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());

        if let Some(secret) = configured_secret {
            if let Err(reason) = verify_platform_webhook_secret(secret, &headers, &raw_bytes, now) {
                let _ = engine
                    .store()
                    .increment_source_rejected(&source.view.id, Some(&reason), &now_iso)
                    .await;
                self.emit_pulse_deck_changed();
                return Err(ApplicationError::unauthorized(reason));
            }
        } else if !allow_unsigned {
            let reason = "webhook source has no signingSecret configured (set configJson.allowUnsigned=true to accept unsigned webhooks)";
            let _ = engine
                .store()
                .increment_source_rejected(&source.view.id, Some(reason), &now_iso)
                .await;
            self.emit_pulse_deck_changed();
            return Err(ApplicationError::unauthorized(reason));
        }

        let parsed_json: Value = serde_json::from_slice(&raw_bytes).map_err(|err| {
            ApplicationError::bad_request(format!("webhook body is not valid JSON: {err}"))
        })?;

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
            self.drain_pulse_outbox().await;
            self.emit_pulse_deck_changed();
        }

        Ok(json!({
            "accepted": outcome.rejected_reason.is_none(),
            "eventId": envelope.event_id,
            "duplicateDelivery": outcome.duplicate_delivery,
            "rejectedReason": outcome.rejected_reason,
        }))
    }

    async fn verify_sdk_hmac_emit(
        &self,
        engine: &PulseEngine,
        args: &Value,
        now: chrono::DateTime<Utc>,
    ) -> Result<(String, Value), ApplicationError> {
        let now_iso = now.to_rfc3339();
        let hmac_meta = args.get("__hmacVerification").ok_or_else(|| {
            ApplicationError::unauthorized("missing HMAC verification metadata")
        })?;
        let raw_b64 = hmac_meta
            .get("rawBodyBase64")
            .and_then(Value::as_str)
            .ok_or_else(|| ApplicationError::unauthorized("missing rawBodyBase64"))?;
        let raw_bytes = base64::engine::general_purpose::STANDARD
            .decode(raw_b64.as_bytes())
            .map_err(|_| ApplicationError::unauthorized("invalid raw body encoding"))?;
        let raw_headers: BTreeMap<String, String> = hmac_meta
            .get("headers")
            .cloned()
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();
        let headers = lowercase_headers(&raw_headers);
        let event_body = args
            .get("body")
            .cloned()
            .ok_or_else(|| ApplicationError::bad_request("missing event body"))?;

        let source_id = headers
            .get("x-pulse-source-id")
            .cloned()
            .or_else(|| {
                event_body
                    .get("source")
                    .and_then(|s| s.get("instanceId").or_else(|| s.get("instance_id")))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .or_else(|| {
                event_body
                    .get("sourceInstanceId")
                    .or_else(|| event_body.get("source_instance_id"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                ApplicationError::unauthorized(
                    "missing source id (`x-pulse-source-id` or `sourceInstanceId`) for HMAC emit",
                )
            })?;

        let source = engine
            .store()
            .get_source(&source_id)
            .await
            .map_err(map_sqlx_error)?
            .ok_or_else(|| {
                ApplicationError::unauthorized(format!("unknown pulse source `{source_id}`"))
            })?;
        if !source.view.enabled {
            return Err(ApplicationError::unauthorized(format!(
                "pulse source `{source_id}` is disabled"
            )));
        }
        let secret = source
            .signing_secret
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                ApplicationError::unauthorized(format!(
                    "pulse source `{source_id}` has no signingSecret configured"
                ))
            })?;

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
        if let Err(err) = verify_standard_webhook(secret, std_headers, &raw_bytes, now) {
            let reason = err.to_string();
            let _ = engine
                .store()
                .increment_source_rejected(&source.view.id, Some(&reason), &now_iso)
                .await;
            self.emit_pulse_deck_changed();
            return Err(ApplicationError::unauthorized(reason));
        }

        let mut normalized_body = event_body;
        if let Some(obj) = normalized_body.as_object_mut()
            && !obj.contains_key("sourceInstanceId")
            && !obj.contains_key("source_instance_id")
            && !obj.contains_key("source")
        {
            obj.insert(
                "sourceInstanceId".to_string(),
                Value::String(source_id.clone()),
            );
        }
        Ok((source_id, normalized_body))
    }
}

// =============================================================================
// Request DTOs & Security Helpers
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
    #[serde(default, alias = "config_json", alias = "config")]
    config_json: Option<Value>,
    #[serde(default, alias = "signing_secret")]
    signing_secret: Option<String>,
    #[serde(default, alias = "clear_signing_secret")]
    clear_signing_secret: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PulseRuleSaveArgs {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default, alias = "draft_only")]
    draft_only: Option<bool>,
    #[serde(default, alias = "mandate_origin")]
    mandate_origin: Option<MandateOrigin>,
    #[serde(default, alias = "webhook_route_id")]
    webhook_route_id: Option<String>,
    spec: PulseRuleSpec,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PulseRuleSetModeArgs {
    #[serde(alias = "ruleId", alias = "rule_id")]
    id: String,
    #[serde(alias = "eval_mode", alias = "mode")]
    eval_mode: PulseEvalMode,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PulseRuleSetEnabledArgs {
    #[serde(alias = "ruleId", alias = "rule_id")]
    id: String,
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PulseRuleDryRunArgs {
    spec: PulseRuleSpec,
    #[serde(alias = "sample_event")]
    sample_event: EventEnvelope,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PulseResolveInteractionArgs {
    #[serde(alias = "interaction_id", alias = "id")]
    interaction_id: String,
    #[serde(default, alias = "option_id", alias = "selectedOptionId", alias = "selected_option_id")]
    option_id: Option<String>,
    #[serde(default)]
    note: Option<String>,
    #[serde(default, alias = "form_values", alias = "formData", alias = "form_data")]
    form_values: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PulseThreadSubscribeArgs {
    #[serde(alias = "thread_key")]
    thread_key: String,
    #[serde(alias = "subscriber_kind")]
    subscriber_kind: String,
    #[serde(alias = "subscriber_id")]
    subscriber_id: String,
    #[serde(default)]
    active: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PulseEventSchemaDefineArgs {
    #[serde(alias = "event_type")]
    event_type: String,
    #[serde(alias = "title", alias = "description")]
    summary: String,
    #[serde(alias = "json_schema", alias = "schemaJson", alias = "schema_json")]
    json_schema: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PulseWebhookIngestArgs {
    #[serde(alias = "source_id")]
    pub(crate) source_id: String,
    #[serde(default)]
    pub(crate) headers: BTreeMap<String, String>,
    #[serde(alias = "raw_body_base64")]
    pub(crate) raw_body_base64: String,
}

const fn default_true() -> bool {
    true
}

pub(crate) const fn is_webhook_source_kind(kind: EventSourceKind) -> bool {
    matches!(
        kind,
        EventSourceKind::Feishu
            | EventSourceKind::Jira
            | EventSourceKind::Github
            | EventSourceKind::WebhookStandard
            | EventSourceKind::WebhookCustom
    )
}

pub(crate) fn unwrap_input(args: &Value) -> &Value {
    args.get("input").unwrap_or(args)
}

fn decode_args<T: serde::de::DeserializeOwned>(value: &Value) -> Result<T, ApplicationError> {
    serde_json::from_value(value.clone()).map_err(|err| ApplicationError::bad_request(err.to_string()))
}

fn to_json_value<T: serde::Serialize>(value: T) -> Result<Value, ApplicationError> {
    serde_json::to_value(value).map_err(|err| ApplicationError::internal(err.to_string()))
}

pub(crate) fn require_str_field_aliases(
    value: &Value,
    keys: &[&str],
) -> Result<String, ApplicationError> {
    let inner = unwrap_input(value);
    for target in [inner, value] {
        for key in keys {
            if let Some(found) = target
                .get(*key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                return Ok(found.to_string());
            }
        }
    }
    Err(ApplicationError::bad_request(format!(
        "missing required string field `{}`",
        keys.first().copied().unwrap_or("id")
    )))
}

fn is_untrusted_webhook_principal(principal: &Principal) -> bool {
    matches!(
        principal,
        Principal::Remote { subject, .. } if subject == "pulse-webhook-intake"
    )
}

fn resolve_effective_mandate(
    principal: &Principal,
    requested: Option<MandateOrigin>,
) -> MandateOrigin {
    if is_untrusted_webhook_principal(principal) {
        return MandateOrigin::UntrustedExternal;
    }
    match requested {
        Some(explicit) => explicit,
        None => match principal {
            Principal::LocalDesktop | Principal::Remote { .. } => MandateOrigin::ExplicitHuman,
        },
    }
}

fn build_emitted_envelope(
    principal: &Principal,
    payload: &Value,
    now: chrono::DateTime<Utc>,
) -> Result<EventEnvelope, ApplicationError> {
    if (payload.get("eventId").is_some() || payload.get("event_id").is_some())
        && payload.get("source").is_some()
    {
        let mut envelope = decode_args::<EventEnvelope>(payload)?;
        if is_untrusted_webhook_principal(principal) {
            envelope.source.trust_level = EventTrustLevel::UntrustedExternal;
        } else if !matches!(principal, Principal::LocalDesktop)
            && envelope.source.trust_level == EventTrustLevel::TrustedHuman
        {
            envelope.source.trust_level = EventTrustLevel::TrustedInternal;
        }
        return Ok(envelope);
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
        .or_else(|| payload.get("source_instance_id"))
        .and_then(Value::as_str)
        .unwrap_or("sdk:default")
        .to_string();
    let actor_id = match principal {
        Principal::LocalDesktop => "user:local-desktop".to_string(),
        Principal::Remote { subject, .. } => subject.clone(),
    };
    let trust_level = if is_untrusted_webhook_principal(principal) {
        EventTrustLevel::UntrustedExternal
    } else {
        match principal {
            Principal::LocalDesktop => EventTrustLevel::TrustedHuman,
            Principal::Remote { .. } => EventTrustLevel::TrustedInternal,
        }
    };

    CustomSdkEventNormalizer::normalize(
        CustomSdkEventInput {
            instance_id,
            event_type,
            delivery_id: payload
                .get("deliveryId")
                .or_else(|| payload.get("delivery_id"))
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

pub(crate) async fn ensure_sdk_source_exists(
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

pub(crate) fn map_sqlx_error(err: sqlx::Error) -> ApplicationError {
    ApplicationError::internal(err.to_string())
}

pub(crate) fn map_pulse_error(err: PulseError) -> ApplicationError {
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
