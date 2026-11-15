//! `PulseEngine` orchestrating receipt deduplication, anti-loop guards, O(1)
//! `ThreadSubscription` fan-out, `Observe` candidate capture, `Auto` target dispatch
//! planning, Standard Webhook intake, Temporal ticks, and `PulseDeckSnapshot`.

use std::{
    collections::{BTreeMap, HashMap},
    sync::Mutex,
};

use api_types::pulse::{
    BotConversationScope, BotMailboxPolicy, EventActor, EventEnvelope, EventSourceKind,
    EventSourceMeta, EventTrace, EventTrustLevel, GroupDispatchMode, MandateOrigin,
    PulseDeckSnapshot, PulseDryRunViolation, PulseEvalMode, PulseObservedCandidateView,
    PulseRuleSpec, PulseRuleView, PulseSubscriptionView, PulseTargetSpec, PulseTemporalSpec,
    PulseUserInteractionView, PulseWorkspaceIsolation, SessionDeliveryStrategy, SessionTargetMode,
};
use chrono::{DateTime, Duration, Utc};
use db::models::pulse::{
    PulseBotMailboxItem, PulseClaimedBotTurn, PulseCreateUserInteraction, PulseRuleUpsert,
    SqlitePulseStore,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::SqlitePool;
use thiserror::Error;
use uuid::Uuid;

use crate::{
    filter::{evaluate_filter_ast, render_template},
    guard::{
        ChainRateBreaker, DEFAULT_MAX_HOP_COUNT, EnvelopeGuardVerdict, RateBreakerDecision,
        check_envelope_guard, enforce_mandate_origin,
    },
    temporal::{InactivitySlaTracker, TemporalError, TemporalEvaluator},
    validation::validate_rule_spec,
    webhook::{
        MAX_WEBHOOK_PAYLOAD_BYTES, StandardWebhookHeaders, VerifiedWebhookPayload,
        WebhookVerifyError, verify_standard_webhook,
    },
};

#[derive(Debug, Error)]
pub enum PulseError {
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("rule validation failed with {} violation(s)", .0.len())]
    ValidationFailed(Vec<PulseDryRunViolation>),
    #[error("webhook verification failed: {0}")]
    WebhookRejected(#[from] WebhookVerifyError),
    #[error("temporal evaluation error: {0}")]
    Temporal(#[from] TemporalError),
    #[error("pulse entity not found: {0}")]
    NotFound(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PulseDispatchAction {
    SpawnOrSendSession {
        rule_id: Option<String>,
        subscription_id: Option<String>,
        mode: SessionTargetMode,
        agent_id: String,
        model_override: Option<String>,
        workspace_isolation: PulseWorkspaceIsolation,
        project_id: Option<String>,
        existing_session_id: Option<String>,
        delivery_strategy: SessionDeliveryStrategy,
        subscribe_thread: bool,
        thread_key: Option<String>,
        prompt: String,
    },
    EnqueueBotMailbox {
        rule_id: Option<String>,
        subscription_id: Option<String>,
        mailbox_item_id: String,
        member_id: String,
        conversation_scope: BotConversationScope,
        mailbox_policy: BotMailboxPolicy,
        subscribe_thread: bool,
        thread_key: Option<String>,
        prompt: String,
    },
    DispatchGroupStage {
        rule_id: Option<String>,
        subscription_id: Option<String>,
        space_id: String,
        dispatch_mode: GroupDispatchMode,
        thread_key: Option<String>,
        message: String,
    },
    CreateUserInteraction {
        rule_id: Option<String>,
        interaction: PulseUserInteractionView,
        mirror_to_channels: Vec<String>,
    },
    StartOrResumeWorkflow {
        rule_id: Option<String>,
        subscription_id: Option<String>,
        workflow_id: String,
        pinned_version: u32,
        inputs: BTreeMap<String, String>,
        thread_key: Option<String>,
    },
    EnqueueOutbox {
        rule_id: Option<String>,
        dedupe_key: String,
        target_kind: String,
        payload: serde_json::Value,
    },
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PulseDispatchPlan {
    pub event_id: String,
    pub thread_key: Option<String>,
    pub actions: Vec<PulseDispatchAction>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PulseIngestOutcome {
    pub duplicate_delivery: bool,
    pub rejected_reason: Option<String>,
    pub claimed_exclusively: bool,
    pub downgraded_rule_ids: Vec<String>,
    pub observed_candidates: Vec<PulseObservedCandidateView>,
    pub subscription_hits: Vec<PulseSubscriptionView>,
    pub dispatch_plan: PulseDispatchPlan,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct PulseTemporalTickReport {
    pub emitted_events: Vec<EventEnvelope>,
    pub outcomes: Vec<PulseIngestOutcome>,
    pub expired_interactions: Vec<PulseUserInteractionView>,
}

pub struct PulseEngine {
    store: SqlitePulseStore,
    rate_breaker: ChainRateBreaker,
    sla_tracker: Mutex<InactivitySlaTracker>,
    debounce_tracker: Mutex<HashMap<(String, String), DateTime<Utc>>>,
    max_hop_count: u32,
    engine_active: bool,
}

impl PulseEngine {
    pub fn new(pool: SqlitePool) -> Self {
        Self {
            store: SqlitePulseStore::new(pool),
            rate_breaker: ChainRateBreaker::default(),
            sla_tracker: Mutex::new(InactivitySlaTracker::new()),
            debounce_tracker: Mutex::new(HashMap::new()),
            max_hop_count: DEFAULT_MAX_HOP_COUNT,
            engine_active: true,
        }
    }

    pub fn with_guards(
        pool: SqlitePool,
        rate_breaker: ChainRateBreaker,
        max_hop_count: u32,
    ) -> Self {
        Self {
            store: SqlitePulseStore::new(pool),
            rate_breaker,
            sla_tracker: Mutex::new(InactivitySlaTracker::new()),
            debounce_tracker: Mutex::new(HashMap::new()),
            max_hop_count,
            engine_active: true,
        }
    }

    pub fn with_engine_active(mut self, active: bool) -> Self {
        self.engine_active = active;
        self
    }

    pub fn store(&self) -> &SqlitePulseStore {
        &self.store
    }

    pub fn armed_sla_count(&self) -> usize {
        self.sla_tracker
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .armed_count()
    }

    /// Disarms any in-memory SLA deadlines and debounce windows for `rule_id`.
    pub fn disarm_rule_sla(&self, rule_id: &str) {
        self.sla_tracker
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .disarm_rule(rule_id);
        self.debounce_tracker
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .retain(|(r, _), _| r != rule_id);
    }

    fn check_and_record_debounce(
        &self,
        rule_id: &str,
        thread_key: Option<&str>,
        debounce_ms: u32,
        now: DateTime<Utc>,
    ) -> bool {
        if debounce_ms == 0 {
            return true;
        }
        let mut guard = self
            .debounce_tracker
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        guard.retain(|_, &mut expires_at| expires_at > now);

        let key = (rule_id.to_string(), thread_key.unwrap_or("").to_string());
        if guard.contains_key(&key) {
            return false;
        }
        guard.insert(key, now + Duration::milliseconds(i64::from(debounce_ms)));
        true
    }

    /// Validates, enforces `MandateOrigin` provenance, computes initial `next_fire_at` when
    /// temporal scheduling is configured, and persists a `PulseRuleView`.
    pub async fn save_rule(
        &self,
        id: Option<String>,
        requested_enabled: bool,
        mandate_origin: MandateOrigin,
        spec: PulseRuleSpec,
        webhook_route_id: Option<String>,
        now: DateTime<Utc>,
    ) -> Result<PulseRuleView, PulseError> {
        self.save_rule_with_draft(
            id,
            requested_enabled,
            false,
            mandate_origin,
            spec,
            webhook_route_id,
            now,
        )
        .await
    }

    pub async fn save_rule_with_draft(
        &self,
        id: Option<String>,
        requested_enabled: bool,
        force_draft_only: bool,
        mandate_origin: MandateOrigin,
        spec: PulseRuleSpec,
        webhook_route_id: Option<String>,
        now: DateTime<Utc>,
    ) -> Result<PulseRuleView, PulseError> {
        let violations = validate_rule_spec(&spec);
        if !violations.is_empty() {
            return Err(PulseError::ValidationFailed(violations));
        }

        let (mut enabled, mut draft_only, enforced_spec) =
            enforce_mandate_origin(mandate_origin, requested_enabled, spec);
        if force_draft_only {
            enabled = false;
            draft_only = true;
        }

        let next_fire_at = if enabled
            && !draft_only
            && enforced_spec.eval_mode != PulseEvalMode::Off
            && let Some(temporal) = &enforced_spec.temporal
        {
            TemporalEvaluator::compute_next_fire_at(temporal, now)?.map(|dt| dt.to_rfc3339())
        } else {
            None
        };

        let rule_id = id
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string());

        if !enabled {
            self.disarm_rule_sla(&rule_id);
        }

        let saved = self
            .store
            .save_rule(PulseRuleUpsert {
                id: rule_id,
                enabled,
                draft_only,
                mandate_origin,
                spec: enforced_spec,
                webhook_route_id,
                next_fire_at,
                now: now.to_rfc3339(),
            })
            .await?;

        Ok(saved)
    }

    /// Verifies a Standard Webhook request (64 KiB cap, 5-min replay window, constant-time HMAC)
    /// against a registered `pulse_sources` instance BEFORE JSON parsing, then ingests the event.
    /// Unsigned sources are rejected unless `source.config_json.allowUnsigned == true`.
    pub async fn ingest_standard_webhook(
        &self,
        source_id: &str,
        headers: StandardWebhookHeaders<'_>,
        raw_body: &[u8],
        event_type_override: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<PulseIngestOutcome, PulseError> {
        let now_iso = now.to_rfc3339();
        let source = self
            .store
            .get_source(source_id)
            .await?
            .ok_or_else(|| PulseError::NotFound(format!("pulse source `{source_id}`")))?;

        let secret = source
            .signing_secret
            .as_deref()
            .map(str::trim)
            .unwrap_or("");
        let allow_unsigned = source
            .config_json
            .get("allowUnsigned")
            .and_then(|v| v.as_bool())
            == Some(true);

        let verified = if secret.is_empty() {
            if !allow_unsigned {
                let err = WebhookVerifyError::InvalidSecret;
                let reason = "webhook source has no signing secret configured (and allowUnsigned is false)";
                let _ = self
                    .store
                    .increment_source_rejected(source_id, Some(reason), &now_iso)
                    .await;
                return Err(PulseError::WebhookRejected(err));
            }
            if raw_body.len() > MAX_WEBHOOK_PAYLOAD_BYTES {
                let err = WebhookVerifyError::PayloadTooLarge {
                    size: raw_body.len(),
                    max: MAX_WEBHOOK_PAYLOAD_BYTES,
                };
                let reason = err.to_string();
                let _ = self
                    .store
                    .increment_source_rejected(source_id, Some(&reason), &now_iso)
                    .await;
                return Err(PulseError::WebhookRejected(err));
            }
            let payload: serde_json::Value = match serde_json::from_slice(raw_body) {
                Ok(parsed) => parsed,
                Err(parse_err) => {
                    let err = WebhookVerifyError::InvalidJson(parse_err.to_string());
                    let reason = err.to_string();
                    let _ = self
                        .store
                        .increment_source_rejected(source_id, Some(&reason), &now_iso)
                        .await;
                    return Err(PulseError::WebhookRejected(err));
                }
            };
            let delivery_id = if headers.webhook_id.trim().is_empty() {
                Uuid::new_v4().to_string()
            } else {
                headers.webhook_id.trim().to_string()
            };
            VerifiedWebhookPayload {
                delivery_id,
                timestamp: now.timestamp(),
                payload,
            }
        } else {
            match verify_standard_webhook(secret, headers, raw_body, now) {
                Ok(ok) => ok,
                Err(err) => {
                    let reason = err.to_string();
                    let _ = self
                        .store
                        .increment_source_rejected(source_id, Some(&reason), &now_iso)
                        .await;
                    return Err(PulseError::WebhookRejected(err));
                }
            }
        };

        let event_type = event_type_override
            .filter(|s| !s.trim().is_empty())
            .or_else(|| verified.payload.get("type").and_then(|v| v.as_str()))
            .or_else(|| verified.payload.get("eventType").and_then(|v| v.as_str()))
            .unwrap_or("webhook.standard.received")
            .to_string();

        let thread_key = verified
            .payload
            .get("threadKey")
            .or_else(|| verified.payload.pointer("/data/threadKey"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        let payload_body = verified
            .payload
            .get("data")
            .cloned()
            .unwrap_or(verified.payload);

        let event_id = Uuid::new_v4().to_string();
        let envelope = EventEnvelope {
            event_id: event_id.clone(),
            delivery_id: verified.delivery_id,
            source: EventSourceMeta {
                kind: EventSourceKind::WebhookStandard,
                instance_id: source.view.id,
                trust_level: EventTrustLevel::UntrustedExternal,
            },
            event_type,
            occurred_at: now_iso,
            actor: EventActor {
                id: format!("webhook:{source_id}"),
                display_name: Some(source.view.title),
                roles: Vec::new(),
                is_bot: false,
                is_self: false,
            },
            thread_key,
            correlations: Vec::new(),
            reply_channels: Vec::new(),
            trace: EventTrace {
                root_event_id: event_id,
                parent_run_id: None,
                hop_count: 0,
            },
            payload: payload_body,
        };

        self.ingest_event(envelope, now).await
    }

    /// Core event ingestion pipeline:
    /// 1. Self-echo & hop-count guard
    /// 2. Atomic `(source_id, delivery_id)` receipt deduplication
    /// 3. `InactivitySlaTracker` arm / reset / disarm
    /// 4. O(1) `ThreadSubscription` fan-out
    /// 5. Deterministic `GateFilterAst` evaluation + `ChainRateBreaker` + `Observe`/`Auto` planning
    pub async fn ingest_event(
        &self,
        envelope: EventEnvelope,
        now: DateTime<Utc>,
    ) -> Result<PulseIngestOutcome, PulseError> {
        let now_iso = now.to_rfc3339();
        let empty_plan = || PulseDispatchPlan {
            event_id: envelope.event_id.clone(),
            thread_key: envelope.thread_key.clone(),
            actions: Vec::new(),
        };

        match check_envelope_guard(&envelope, self.max_hop_count) {
            EnvelopeGuardVerdict::Allow => {}
            EnvelopeGuardVerdict::RejectedSelfActor => {
                let _ = self
                    .store
                    .increment_source_rejected(
                        &envelope.source.instance_id,
                        Some("dropped self-emitted echo event"),
                        &now_iso,
                    )
                    .await;
                return Ok(PulseIngestOutcome {
                    duplicate_delivery: false,
                    rejected_reason: Some("self_actor".to_string()),
                    claimed_exclusively: false,
                    downgraded_rule_ids: Vec::new(),
                    observed_candidates: Vec::new(),
                    subscription_hits: Vec::new(),
                    dispatch_plan: empty_plan(),
                });
            }
            EnvelopeGuardVerdict::RejectedHopOverflow {
                hop_count,
                max_hops,
            } => {
                let msg = format!("hop_count {hop_count} exceeds max {max_hops}");
                let _ = self
                    .store
                    .increment_source_rejected(&envelope.source.instance_id, Some(&msg), &now_iso)
                    .await;
                return Ok(PulseIngestOutcome {
                    duplicate_delivery: false,
                    rejected_reason: Some("hop_overflow".to_string()),
                    claimed_exclusively: false,
                    downgraded_rule_ids: Vec::new(),
                    observed_candidates: Vec::new(),
                    subscription_hits: Vec::new(),
                    dispatch_plan: empty_plan(),
                });
            }
        }

        let is_new = self
            .store
            .insert_receipt_if_new(&envelope.source.instance_id, &envelope, &now_iso)
            .await?;
        if !is_new {
            return Ok(PulseIngestOutcome {
                duplicate_delivery: true,
                rejected_reason: None,
                claimed_exclusively: false,
                downgraded_rule_ids: Vec::new(),
                observed_candidates: Vec::new(),
                subscription_hits: Vec::new(),
                dispatch_plan: empty_plan(),
            });
        }

        let enabled_rules = self.store.list_enabled_rules().await?;
        {
            let mut tracker = self
                .sla_tracker
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            tracker.observe_event(&enabled_rules, &envelope, now);
        }

        let mut actions = Vec::new();
        let mut subscription_hits = Vec::new();

        // Layer 3a: O(1) ThreadSubscription fan-out (bypassing Gate re-evaluation for subscribed threads).
        if let Some(thread_key) = envelope.thread_key.as_deref() {
            let subs = self
                .store
                .list_active_subscriptions_for_thread(thread_key)
                .await?;
            for sub in subs {
                let follow_up_text = build_thread_followup_prompt(&envelope);
                match sub.subscriber_kind.as_str() {
                    "session" => {
                        actions.push(PulseDispatchAction::SpawnOrSendSession {
                            rule_id: None,
                            subscription_id: Some(sub.id.clone()),
                            mode: SessionTargetMode::ExistingSession,
                            agent_id: "subscribed_session".to_string(),
                            model_override: None,
                            workspace_isolation: PulseWorkspaceIsolation::ProjectRoot,
                            project_id: None,
                            existing_session_id: Some(sub.subscriber_id.clone()),
                            delivery_strategy: SessionDeliveryStrategy::Queue,
                            subscribe_thread: false,
                            thread_key: Some(thread_key.to_string()),
                            prompt: follow_up_text,
                        });
                    }
                    "bot" => {
                        let mailbox_id = Uuid::new_v4().to_string();
                        self.store
                            .enqueue_bot_mailbox(&PulseBotMailboxItem {
                                id: mailbox_id.clone(),
                                member_id: sub.subscriber_id.clone(),
                                conversation_scope: BotConversationScope::FixedPrimary,
                                mailbox_policy: BotMailboxPolicy::FifoSerial,
                                thread_key: Some(thread_key.to_string()),
                                event_id: envelope.event_id.clone(),
                                prompt_text: follow_up_text.clone(),
                                status: "queued".to_string(),
                                created_at: now_iso.clone(),
                                claimed_at: None,
                            })
                            .await?;
                        actions.push(PulseDispatchAction::EnqueueBotMailbox {
                            rule_id: None,
                            subscription_id: Some(sub.id.clone()),
                            mailbox_item_id: mailbox_id,
                            member_id: sub.subscriber_id.clone(),
                            conversation_scope: BotConversationScope::FixedPrimary,
                            mailbox_policy: BotMailboxPolicy::FifoSerial,
                            subscribe_thread: false,
                            thread_key: Some(thread_key.to_string()),
                            prompt: follow_up_text,
                        });
                    }
                    "group" => {
                        actions.push(PulseDispatchAction::DispatchGroupStage {
                            rule_id: None,
                            subscription_id: Some(sub.id.clone()),
                            space_id: sub.subscriber_id.clone(),
                            dispatch_mode: GroupDispatchMode::BroadcastLogOnly,
                            thread_key: Some(thread_key.to_string()),
                            message: follow_up_text,
                        });
                    }
                    "workflow" => {
                        let mut inputs = BTreeMap::new();
                        inputs.insert("eventId".to_string(), envelope.event_id.clone());
                        inputs.insert("threadKey".to_string(), thread_key.to_string());
                        actions.push(PulseDispatchAction::StartOrResumeWorkflow {
                            rule_id: None,
                            subscription_id: Some(sub.id.clone()),
                            workflow_id: sub.subscriber_id.clone(),
                            pinned_version: 1,
                            inputs,
                            thread_key: Some(thread_key.to_string()),
                        });
                    }
                    _ => {}
                }
                subscription_hits.push(sub);
            }
        }

        // Layer 3b: Deterministic GateFilterAst evaluation + Rate Breaker + Observe/Auto dispatch.
        let mut observed_candidates = Vec::new();
        let mut downgraded_rule_ids = Vec::new();
        let mut claimed_exclusively = false;

        let matched_rules: Vec<PulseRuleView> = enabled_rules
            .into_iter()
            .filter(|rule| rule_matches_envelope(rule, &envelope))
            .filter(|rule| {
                self.check_and_record_debounce(
                    &rule.id,
                    envelope.thread_key.as_deref(),
                    rule.spec.debounce_ms,
                    now,
                )
            })
            .collect();

        // Check per-thread_key sliding-window rate breaker once per incoming event if any Auto rule matched.
        let rate_tripped = if matched_rules
            .iter()
            .any(|r| r.spec.eval_mode == PulseEvalMode::Auto)
        {
            let rate_key = envelope
                .thread_key
                .as_deref()
                .unwrap_or(envelope.source.instance_id.as_str());
            matches!(
                self.rate_breaker.record_and_check(rate_key, now),
                RateBreakerDecision::Tripped { .. }
            )
        } else {
            false
        };

        for rule in matched_rules {
            let mut effective_mode = rule.spec.eval_mode;
            if effective_mode == PulseEvalMode::Auto && rate_tripped {
                self.store
                    .set_rule_mode(&rule.id, PulseEvalMode::Observe, &now_iso)
                    .await?;
                downgraded_rule_ids.push(rule.id.clone());
                effective_mode = PulseEvalMode::Observe;
            }

            match effective_mode {
                PulseEvalMode::Off => {}
                PulseEvalMode::Observe => {
                    self.store
                        .increment_rule_observed(&rule.id, &now_iso)
                        .await?;
                    let summary = summarize_observed_match(&rule.spec, &envelope);
                    let candidate = self
                        .store
                        .insert_observed_candidate(
                            &Uuid::new_v4().to_string(),
                            &rule.id,
                            &rule.spec.name,
                            &summary,
                            &envelope,
                        )
                        .await?;
                    observed_candidates.push(candidate);
                }
                PulseEvalMode::Auto => {
                    self.store
                        .increment_rule_matched(&rule.id, &now_iso)
                        .await?;
                    if rule.spec.claim_exclusive {
                        claimed_exclusively = true;
                        if let Some(reply) = envelope.reply_channels.first() {
                            let dedupe_key = format!("claim-ack:{}:{}", rule.id, envelope.event_id);
                            let payload = json!({
                                "action": "add_reaction",
                                "emoji": "EYES",
                                "replyChannel": reply,
                            });
                            if self
                                .store
                                .enqueue_outbox(
                                    &Uuid::new_v4().to_string(),
                                    &dedupe_key,
                                    "im_reaction_ack",
                                    &payload,
                                    &now_iso,
                                )
                                .await?
                            {
                                actions.push(PulseDispatchAction::EnqueueOutbox {
                                    rule_id: Some(rule.id.clone()),
                                    dedupe_key,
                                    target_kind: "im_reaction_ack".to_string(),
                                    payload,
                                });
                            }
                        }
                    }

                    let target_actions = self
                        .plan_and_persist_targets(&rule.id, &rule.spec.targets, &envelope, now)
                        .await?;
                    actions.extend(target_actions);
                }
            }
        }

        Ok(PulseIngestOutcome {
            duplicate_delivery: false,
            rejected_reason: None,
            claimed_exclusively,
            downgraded_rule_ids,
            observed_candidates,
            subscription_hits,
            dispatch_plan: PulseDispatchPlan {
                event_id: envelope.event_id,
                thread_key: envelope.thread_key,
                actions,
            },
        })
    }

    /// Promotes a captured `Observe` candidate: upgrades its rule to `PulseEvalMode::Auto`,
    /// atomically marks the candidate as `promoted`, and executes target dispatch planning
    /// for the captured event!
    pub async fn promote_observed_candidate(
        &self,
        candidate_id: &str,
        promote_rule_to_auto: bool,
        now: DateTime<Utc>,
    ) -> Result<PulseDispatchPlan, PulseError> {
        let (plan, _) = self
            .promote_observed_candidate_with_envelope(candidate_id, promote_rule_to_auto, now)
            .await?;
        Ok(plan)
    }

    pub async fn promote_observed_candidate_with_envelope(
        &self,
        candidate_id: &str,
        promote_rule_to_auto: bool,
        now: DateTime<Utc>,
    ) -> Result<(PulseDispatchPlan, EventEnvelope), PulseError> {
        let now_iso = now.to_rfc3339();
        let candidate = self
            .store
            .mark_candidate_promoted(candidate_id)
            .await?
            .ok_or_else(|| {
                PulseError::NotFound(format!(
                    "unpromoted observed candidate `{candidate_id}` not found"
                ))
            })?;

        let rule = self
            .store
            .get_rule(&candidate.view.rule_id)
            .await?
            .ok_or_else(|| {
                PulseError::NotFound(format!("pulse rule `{}`", candidate.view.rule_id))
            })?;

        if promote_rule_to_auto && rule.spec.eval_mode != PulseEvalMode::Auto {
            self.store
                .set_rule_mode(&rule.id, PulseEvalMode::Auto, &now_iso)
                .await?;
        }

        self.store
            .increment_rule_matched(&rule.id, &now_iso)
            .await?;
        let actions = self
            .plan_and_persist_targets(&rule.id, &rule.spec.targets, &candidate.envelope, now)
            .await?;

        let plan = PulseDispatchPlan {
            event_id: candidate.envelope.event_id.clone(),
            thread_key: candidate.envelope.thread_key.clone(),
            actions,
        };
        Ok((plan, candidate.envelope))
    }

    pub async fn claim_next_bot_turn(
        &self,
        member_id: &str,
        now: DateTime<Utc>,
    ) -> Result<Option<PulseClaimedBotTurn>, PulseError> {
        Ok(self
            .store
            .claim_next_bot_turn(member_id, &now.to_rfc3339())
            .await?)
    }

    /// Advances all due `Cron`, `Once`, `Interval` rules, collects expired `InactivitySla`
    /// timers, expires overdue `UserInteraction`s, and runs emitted temporal events through
    /// the standard `ingest_event` pipeline.
    pub async fn tick_temporal(
        &self,
        now: DateTime<Utc>,
        is_busy_rule: impl Fn(&str) -> bool,
    ) -> Result<PulseTemporalTickReport, PulseError> {
        let now_iso = now.to_rfc3339();
        let due_rules = self.store.list_due_temporal_rules(&now_iso).await?;

        let mut emitted_events = Vec::new();
        let mut rules_to_disable_after_fire = Vec::new();
        for rule in due_rules {
            let Some(temporal_spec) = &rule.spec.temporal else {
                continue;
            };
            let Some(raw_scheduled) = &rule.next_fire_at else {
                continue;
            };
            let scheduled_dt = DateTime::parse_from_rfc3339(raw_scheduled)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or(now);

            let tick = TemporalEvaluator::evaluate_due_rule(
                &rule.id,
                temporal_spec,
                scheduled_dt,
                now,
                is_busy_rule(&rule.id),
            )?;
            let next_str = tick.next_fire_at.map(|dt| dt.to_rfc3339());
            self.store
                .update_rule_schedule(&rule.id, next_str.as_deref(), false, &now_iso)
                .await?;
            if tick.disable_after_fire {
                rules_to_disable_after_fire.push(rule.id.clone());
            }

            if let Some(env) = tick.emitted_envelope {
                emitted_events.push(env);
            }
        }

        let sla_expired = {
            let mut tracker = self
                .sla_tracker
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            tracker.collect_expired(now)
        };
        emitted_events.extend(sla_expired);

        let expired_interactions = self.store.expire_overdue_interactions(&now_iso).await?;

        let mut outcomes = Vec::with_capacity(emitted_events.len());
        for env in &emitted_events {
            outcomes.push(self.ingest_event(env.clone(), now).await?);
        }

        for rule_id in rules_to_disable_after_fire {
            self.store
                .update_rule_schedule(&rule_id, None, true, &now_iso)
                .await?;
        }

        Ok(PulseTemporalTickReport {
            emitted_events,
            outcomes,
            expired_interactions,
        })
    }

    /// Builds the `PulseDeckSnapshot` used by the Kanban `pulse-deck` operational surface.
    pub async fn deck_snapshot(
        &self,
        project_id: Option<&str>,
    ) -> Result<PulseDeckSnapshot, PulseError> {
        let (
            sources,
            rules,
            observed_candidates,
            subscriptions,
            pending_interactions,
            active_ticket_count,
            pending_user_interaction_count,
        ) = tokio::try_join!(
            self.store.list_sources(),
            self.store.list_rules(project_id),
            self.store.list_observed_candidates(false, 100),
            self.store.list_active_subscriptions(),
            self.store.list_pending_user_interactions(),
            self.store.count_active_subscriptions(),
            self.store.count_pending_user_interactions(),
        )?;

        Ok(PulseDeckSnapshot {
            engine_active: self.engine_active,
            active_ticket_count,
            pending_user_interaction_count,
            sources,
            rules,
            observed_candidates,
            subscriptions,
            pending_interactions,
        })
    }

    async fn plan_and_persist_targets(
        &self,
        rule_id: &str,
        targets: &[PulseTargetSpec],
        envelope: &EventEnvelope,
        now: DateTime<Utc>,
    ) -> Result<Vec<PulseDispatchAction>, PulseError> {
        let now_iso = now.to_rfc3339();
        let mut actions = Vec::with_capacity(targets.len());

        for target in targets {
            match target {
                PulseTargetSpec::Session {
                    mode,
                    agent_id,
                    model_override,
                    workspace_isolation,
                    project_id,
                    existing_session_id,
                    delivery_strategy,
                    subscribe_thread,
                    prompt_template,
                } => {
                    let prompt = render_template(prompt_template, envelope);
                    if *subscribe_thread && let Some(thread_key) = envelope.thread_key.as_deref() {
                        let existing_bound_uuid = if existing_session_id.is_none() {
                            self.store
                                .list_active_subscriptions_for_thread(thread_key)
                                .await?
                                .into_iter()
                                .find(|s| {
                                    s.subscriber_kind == "session"
                                        && Uuid::parse_str(&s.subscriber_id).is_ok()
                                })
                                .map(|s| s.subscriber_id)
                        } else {
                            None
                        };
                        let subscriber_id = existing_session_id
                            .clone()
                            .or(existing_bound_uuid)
                            .unwrap_or_else(|| format!("session:{rule_id}:{thread_key}"));
                        self.store
                            .subscribe_thread(
                                &Uuid::new_v4().to_string(),
                                thread_key,
                                "session",
                                &subscriber_id,
                                &now_iso,
                            )
                            .await?;
                    }
                    actions.push(PulseDispatchAction::SpawnOrSendSession {
                        rule_id: Some(rule_id.to_string()),
                        subscription_id: None,
                        mode: *mode,
                        agent_id: agent_id.clone(),
                        model_override: model_override.clone(),
                        workspace_isolation: *workspace_isolation,
                        project_id: project_id.clone(),
                        existing_session_id: existing_session_id.clone(),
                        delivery_strategy: *delivery_strategy,
                        subscribe_thread: *subscribe_thread,
                        thread_key: envelope.thread_key.clone(),
                        prompt,
                    });
                }
                PulseTargetSpec::Bot {
                    member_id,
                    conversation_scope,
                    mailbox_policy,
                    subscribe_thread,
                    prompt_template,
                } => {
                    let prompt = render_template(prompt_template, envelope);
                    let mailbox_item_id = Uuid::new_v4().to_string();
                    self.store
                        .enqueue_bot_mailbox(&PulseBotMailboxItem {
                            id: mailbox_item_id.clone(),
                            member_id: member_id.clone(),
                            conversation_scope: *conversation_scope,
                            mailbox_policy: *mailbox_policy,
                            thread_key: envelope.thread_key.clone(),
                            event_id: envelope.event_id.clone(),
                            prompt_text: prompt.clone(),
                            status: "queued".to_string(),
                            created_at: now_iso.clone(),
                            claimed_at: None,
                        })
                        .await?;

                    if *subscribe_thread && let Some(thread_key) = envelope.thread_key.as_deref() {
                        self.store
                            .subscribe_thread(
                                &Uuid::new_v4().to_string(),
                                thread_key,
                                "bot",
                                member_id,
                                &now_iso,
                            )
                            .await?;
                    }

                    actions.push(PulseDispatchAction::EnqueueBotMailbox {
                        rule_id: Some(rule_id.to_string()),
                        subscription_id: None,
                        mailbox_item_id,
                        member_id: member_id.clone(),
                        conversation_scope: *conversation_scope,
                        mailbox_policy: *mailbox_policy,
                        subscribe_thread: *subscribe_thread,
                        thread_key: envelope.thread_key.clone(),
                        prompt,
                    });
                }
                PulseTargetSpec::Group {
                    space_id,
                    dispatch_mode,
                    message_template,
                } => {
                    let message = render_template(message_template, envelope);
                    actions.push(PulseDispatchAction::DispatchGroupStage {
                        rule_id: Some(rule_id.to_string()),
                        subscription_id: None,
                        space_id: space_id.clone(),
                        dispatch_mode: dispatch_mode.clone(),
                        thread_key: envelope.thread_key.clone(),
                        message,
                    });
                }
                PulseTargetSpec::User {
                    interaction_kind,
                    severity,
                    title_template,
                    body_template,
                    mirror_to_channels,
                    approval_options,
                    form_schema,
                    sla_timeout_seconds,
                } => {
                    let title = render_template(title_template, envelope);
                    let body = render_template(body_template, envelope);
                    let sla_deadline_at = sla_timeout_seconds
                        .map(|secs| (now + Duration::seconds(i64::from(secs))).to_rfc3339());

                    let interaction = self
                        .store
                        .create_user_interaction(PulseCreateUserInteraction {
                            id: Uuid::new_v4().to_string(),
                            rule_id: Some(rule_id.to_string()),
                            workflow_run_id: None,
                            step_id: None,
                            kind: *interaction_kind,
                            severity: *severity,
                            title,
                            body,
                            approval_options: approval_options.clone(),
                            form_schema: form_schema.clone(),
                            sla_deadline_at,
                            created_at: now_iso.clone(),
                        })
                        .await?;

                    for channel in mirror_to_channels {
                        let dedupe_key =
                            format!("interaction-mirror:{}:{}", interaction.id, channel);
                        let payload = json!({
                            "interactionId": interaction.id,
                            "channel": channel,
                            "title": interaction.title,
                            "body": interaction.body,
                            "kind": interaction.kind,
                            "approvalOptions": interaction.approval_options,
                        });
                        if self
                            .store
                            .enqueue_outbox(
                                &Uuid::new_v4().to_string(),
                                &dedupe_key,
                                "user_interaction_mirror",
                                &payload,
                                &now_iso,
                            )
                            .await?
                        {
                            actions.push(PulseDispatchAction::EnqueueOutbox {
                                rule_id: Some(rule_id.to_string()),
                                dedupe_key,
                                target_kind: "user_interaction_mirror".to_string(),
                                payload,
                            });
                        }
                    }

                    actions.push(PulseDispatchAction::CreateUserInteraction {
                        rule_id: Some(rule_id.to_string()),
                        interaction,
                        mirror_to_channels: mirror_to_channels.clone(),
                    });
                }
                PulseTargetSpec::Workflow {
                    workflow_id,
                    pinned_version,
                    input_mapping,
                } => {
                    let inputs = input_mapping
                        .iter()
                        .map(|(k, tmpl)| (k.clone(), render_template(tmpl, envelope)))
                        .collect();
                    actions.push(PulseDispatchAction::StartOrResumeWorkflow {
                        rule_id: Some(rule_id.to_string()),
                        subscription_id: None,
                        workflow_id: workflow_id.clone(),
                        pinned_version: *pinned_version,
                        inputs,
                        thread_key: envelope.thread_key.clone(),
                    });
                }
            }
        }

        Ok(actions)
    }
}

fn rule_matches_envelope(rule: &PulseRuleView, envelope: &EventEnvelope) -> bool {
    if !validate_rule_spec(&rule.spec).is_empty() {
        return false;
    }

    if let Some(temporal) = &rule.spec.temporal {
        let temporal_match = match temporal {
            PulseTemporalSpec::Cron { .. } => {
                envelope.source.kind == EventSourceKind::TimeCron
                    && envelope.source.instance_id == format!("temporal:{}", rule.id)
            }
            PulseTemporalSpec::Once { .. } => {
                envelope.source.kind == EventSourceKind::TimeOnce
                    && envelope.source.instance_id == format!("temporal:{}", rule.id)
            }
            PulseTemporalSpec::Interval { .. } => {
                envelope.source.kind == EventSourceKind::TimeInterval
                    && envelope.source.instance_id == format!("temporal:{}", rule.id)
            }
            PulseTemporalSpec::InactivitySla { .. } => {
                envelope.source.kind == EventSourceKind::TimeSla
                    && envelope.source.instance_id == format!("sla:{}", rule.id)
            }
        };
        if !temporal_match {
            return false;
        }
    }

    evaluate_filter_ast(&rule.spec.filter, envelope).matched
}

fn summarize_observed_match(spec: &PulseRuleSpec, envelope: &EventEnvelope) -> String {
    let first_preview = spec.targets.first().map(|target| match target {
        PulseTargetSpec::Session {
            prompt_template, ..
        }
        | PulseTargetSpec::Bot {
            prompt_template, ..
        } => render_template(prompt_template, envelope),
        PulseTargetSpec::Group {
            message_template, ..
        } => render_template(message_template, envelope),
        PulseTargetSpec::User { title_template, .. } => render_template(title_template, envelope),
        PulseTargetSpec::Workflow {
            workflow_id,
            pinned_version,
            ..
        } => format!("Workflow {workflow_id}@v{pinned_version}"),
    });

    match first_preview {
        Some(preview) if !preview.trim().is_empty() => {
            let trimmed = preview.trim();
            if trimmed.chars().count() > 160 {
                format!("{}…", trimmed.chars().take(160).collect::<String>())
            } else {
                trimmed.to_string()
            }
        }
        _ => format!("Matched `{}` on `{}`", spec.name, envelope.event_type),
    }
}

fn build_thread_followup_prompt(envelope: &EventEnvelope) -> String {
    let actor = envelope
        .actor
        .display_name
        .as_deref()
        .unwrap_or(&envelope.actor.id);
    let body_hint = envelope
        .payload
        .get("text")
        .or_else(|| envelope.payload.get("body"))
        .or_else(|| envelope.payload.pointer("/comment/body"))
        .or_else(|| envelope.payload.pointer("/issue/summary"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if body_hint.is_empty() {
        format!(
            "[Thread Follow-up] Event `{}` from `{actor}` (eventId: `{}`)",
            envelope.event_type, envelope.event_id
        )
    } else {
        format!(
            "[Thread Follow-up] `{}` by `{actor}`: {body_hint}",
            envelope.event_type
        )
    }
}
