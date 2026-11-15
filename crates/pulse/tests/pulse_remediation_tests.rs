use std::str::FromStr;

use api_types::pulse::{
    EventActor, EventEnvelope, EventSourceKind, EventSourceMeta, EventTrace, EventTrustLevel,
    GateFilterAst, MandateOrigin, PresetOrchestratorKind, PulseEvalMode, PulseRuleSpec,
    PulseTargetSpec, PulseTemporalSpec, PulseWorkspaceIsolation, SessionDeliveryStrategy,
    SessionTargetMode, UserInteractionKind, UserInteractionSeverity,
};
use chrono::{Duration, TimeZone, Utc};
use db::models::pulse::{PulseSourceUpsert, ensure_pulse_schema};
use pulse::{
    ChainRateBreaker, PulseDispatchAction, PulseEngine, PulseError, StandardWebhookHeaders,
    WebhookVerifyError,
};
use serde_json::json;
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use uuid::Uuid;

async fn memory_pool() -> SqlitePool {
    let options = SqliteConnectOptions::from_str("sqlite::memory:")
        .expect("sqlite memory options")
        .create_if_missing(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("connect sqlite memory pool");
    ensure_pulse_schema(&pool)
        .await
        .expect("apply pulse schema");
    pool
}

fn sdk_envelope(
    delivery_id: &str,
    event_type: &str,
    thread_key: Option<&str>,
    occurred_at: &str,
) -> EventEnvelope {
    EventEnvelope {
        event_id: format!("evt-{delivery_id}"),
        delivery_id: delivery_id.to_string(),
        source: EventSourceMeta {
            kind: EventSourceKind::SdkCustom,
            instance_id: "sdk-test".to_string(),
            trust_level: EventTrustLevel::TrustedInternal,
        },
        event_type: event_type.to_string(),
        occurred_at: occurred_at.to_string(),
        actor: EventActor {
            id: "dev-1".to_string(),
            display_name: Some("Dev One".to_string()),
            roles: Vec::new(),
            is_bot: false,
            is_self: false,
        },
        thread_key: thread_key.map(str::to_string),
        correlations: Vec::new(),
        reply_channels: Vec::new(),
        trace: EventTrace {
            root_event_id: format!("evt-{delivery_id}"),
            parent_run_id: None,
            hop_count: 0,
        },
        payload: json!({ "status": "failing" }),
    }
}

#[tokio::test]
async fn debounce_window_suppresses_burst_per_thread_and_allows_after_expiry() {
    let pool = memory_pool().await;
    let engine = PulseEngine::new(pool);
    let t0 = Utc.with_ymd_and_hms(2026, 11, 16, 12, 0, 0).unwrap();

    engine
        .store()
        .upsert_source(PulseSourceUpsert {
            id: "sdk-test".to_string(),
            kind: EventSourceKind::SdkCustom,
            title: "SDK Test".to_string(),
            enabled: true,
            healthy: true,
            status_message: None,
            cursor_watermark: None,
            public_webhook_path: None,
            config_json: json!({}),
            signing_secret: None,
            now: t0.to_rfc3339(),
        })
        .await
        .expect("upsert sdk source");

    let spec = PulseRuleSpec {
        name: "Debounced CI Alert".to_string(),
        description: None,
        project_id: None,
        workspace_id: None,
        eval_mode: PulseEvalMode::Auto,
        orchestrator: PresetOrchestratorKind::DirectReflex,
        filter: GateFilterAst {
            source_kinds: vec![EventSourceKind::SdkCustom],
            source_instance_ids: Vec::new(),
            event_types: vec!["ci.failed".to_string()],
            allowed_actors: Vec::new(),
            conditions: Vec::new(),
        },
        temporal: None,
        debounce_ms: 5_000,
        claim_exclusive: false,
        targets: vec![PulseTargetSpec::User {
            interaction_kind: UserInteractionKind::Notify,
            severity: UserInteractionSeverity::Info,
            title_template: "CI failed on {{event.threadKey}}".to_string(),
            body_template: "Delivery {{event.deliveryId}}".to_string(),
            mirror_to_channels: Vec::new(),
            approval_options: Vec::new(),
            form_schema: None,
            sla_timeout_seconds: None,
        }],
    };

    engine
        .save_rule(None, true, MandateOrigin::ExplicitHuman, spec, None, t0)
        .await
        .expect("save debounced rule");

    // 1. First event on pr:1 fires normally.
    let out1 = engine
        .ingest_event(
            sdk_envelope("d1", "ci.failed", Some("pr:1"), &t0.to_rfc3339()),
            t0,
        )
        .await
        .expect("ingest d1");
    assert_eq!(out1.dispatch_plan.actions.len(), 1);

    // 2. Second event 2s later on SAME thread pr:1 is suppressed by 5000ms debounce.
    let t1 = t0 + Duration::milliseconds(2_000);
    let out2 = engine
        .ingest_event(
            sdk_envelope("d2", "ci.failed", Some("pr:1"), &t1.to_rfc3339()),
            t1,
        )
        .await
        .expect("ingest d2");
    assert!(
        out2.dispatch_plan.actions.is_empty(),
        "burst event within debounce_ms on same thread must be suppressed"
    );

    // 3. Concurrent event on DIFFERENT thread pr:2 is NOT suppressed.
    let out3 = engine
        .ingest_event(
            sdk_envelope("d3", "ci.failed", Some("pr:2"), &t1.to_rfc3339()),
            t1,
        )
        .await
        .expect("ingest d3");
    assert_eq!(out3.dispatch_plan.actions.len(), 1);

    // 4. Event 6s after t0 on pr:1 fires again because debounce window expired.
    let t2 = t0 + Duration::milliseconds(6_000);
    let out4 = engine
        .ingest_event(
            sdk_envelope("d4", "ci.failed", Some("pr:1"), &t2.to_rfc3339()),
            t2,
        )
        .await
        .expect("ingest d4");
    assert_eq!(out4.dispatch_plan.actions.len(), 1);
}

#[tokio::test]
async fn unsigned_webhook_source_rejected_by_default_and_allowed_only_when_explicit() {
    let pool = memory_pool().await;
    let engine = PulseEngine::new(pool);
    let now = Utc.with_ymd_and_hms(2026, 11, 16, 13, 0, 0).unwrap();

    engine
        .store()
        .upsert_source(PulseSourceUpsert {
            id: "wh-no-secret".to_string(),
            kind: EventSourceKind::WebhookStandard,
            title: "Unsigned By Mistake".to_string(),
            enabled: true,
            healthy: true,
            status_message: None,
            cursor_watermark: None,
            public_webhook_path: Some("/api/pulse/webhooks/wh-no-secret".to_string()),
            config_json: json!({}),
            signing_secret: None,
            now: now.to_rfc3339(),
        })
        .await
        .expect("upsert source without secret");

    let raw_body = br#"{"eventType":"ping","threadKey":"t:1"}"#;
    let err = engine
        .ingest_standard_webhook(
            "wh-no-secret",
            StandardWebhookHeaders {
                webhook_id: "msg-unsigned-1",
                webhook_timestamp: "",
                webhook_signature: "",
            },
            raw_body,
            None,
            now,
        )
        .await
        .expect_err("unsigned source without allowUnsigned must fail closed");
    assert!(matches!(
        err,
        PulseError::WebhookRejected(WebhookVerifyError::InvalidSecret)
    ));

    // Opt-in via configJson.allowUnsigned == true succeeds.
    engine
        .store()
        .upsert_source(PulseSourceUpsert {
            id: "wh-explicit-unsigned".to_string(),
            kind: EventSourceKind::WebhookStandard,
            title: "Local Dev Unsigned Webhook".to_string(),
            enabled: true,
            healthy: true,
            status_message: None,
            cursor_watermark: None,
            public_webhook_path: Some("/api/pulse/webhooks/wh-explicit-unsigned".to_string()),
            config_json: json!({ "allowUnsigned": true }),
            signing_secret: None,
            now: now.to_rfc3339(),
        })
        .await
        .expect("upsert explicit allowUnsigned source");

    let ok = engine
        .ingest_standard_webhook(
            "wh-explicit-unsigned",
            StandardWebhookHeaders {
                webhook_id: "msg-unsigned-ok",
                webhook_timestamp: "",
                webhook_signature: "",
            },
            raw_body,
            None,
            now,
        )
        .await
        .expect("explicit allowUnsigned source should accept delivery");
    assert!(!ok.duplicate_delivery);
}

#[tokio::test]
async fn rate_breaker_evicts_expired_buckets_sla_disarms_cleanly_and_bound_session_uuid_preserved() {
    let breaker = ChainRateBreaker::new(Duration::seconds(60), 3);
    let t0 = Utc.with_ymd_and_hms(2026, 11, 16, 14, 0, 0).unwrap();
    let _ = breaker.record_and_check("thread-alpha", t0);
    let _ = breaker.record_and_check("thread-beta", t0);
    assert_eq!(breaker.active_bucket_count(), 2);

    // Triggering a new key after window expiry evicts both expired buckets via retain().
    let t_expired = t0 + Duration::seconds(120);
    let _ = breaker.record_and_check("thread-gamma", t_expired);
    assert_eq!(breaker.active_bucket_count(), 1);

    // Verify disarm_rule_sla clears armed SLA deadlines & save_rule_with_draft forces draft_only.
    let pool = memory_pool().await;
    let engine = PulseEngine::new(pool);

    engine
        .store()
        .upsert_source(PulseSourceUpsert {
            id: "sdk-test".to_string(),
            kind: EventSourceKind::SdkCustom,
            title: "SDK Test".to_string(),
            enabled: true,
            healthy: true,
            status_message: None,
            cursor_watermark: None,
            public_webhook_path: None,
            config_json: json!({}),
            signing_secret: None,
            now: t0.to_rfc3339(),
        })
        .await
        .expect("upsert sdk source");

    let sla_spec = PulseRuleSpec {
        name: "PR Review SLA".to_string(),
        description: None,
        project_id: None,
        workspace_id: None,
        eval_mode: PulseEvalMode::Auto,
        orchestrator: PresetOrchestratorKind::DirectReflex,
        filter: GateFilterAst {
            source_kinds: vec![EventSourceKind::SdkCustom],
            source_instance_ids: Vec::new(),
            event_types: vec!["pr.opened".to_string()],
            allowed_actors: Vec::new(),
            conditions: Vec::new(),
        },
        temporal: Some(PulseTemporalSpec::InactivitySla {
            thread_key_prefix: "pr:".to_string(),
            timeout_seconds: 600,
            expected_event_types: vec!["pr.reviewed".to_string()],
        }),
        debounce_ms: 0,
        claim_exclusive: false,
        targets: vec![PulseTargetSpec::Session {
            mode: SessionTargetMode::ThreadKeyed,
            agent_id: "codex".to_string(),
            model_override: None,
            workspace_isolation: PulseWorkspaceIsolation::ProjectRoot,
            project_id: Some("proj-1".to_string()),
            existing_session_id: None,
            delivery_strategy: SessionDeliveryStrategy::Queue,
            subscribe_thread: true,
            prompt_template: "Follow up on {{event.threadKey}}".to_string(),
        }],
    };

    let draft_rule = engine
        .save_rule_with_draft(
            None,
            true,
            true,
            MandateOrigin::ExplicitHuman,
            sla_spec.clone(),
            None,
            t0,
        )
        .await
        .expect("save draft rule");
    assert!(draft_rule.draft_only);
    assert!(!draft_rule.enabled);

    let active_rule = engine
        .save_rule(None, true, MandateOrigin::ExplicitHuman, sla_spec, None, t0)
        .await
        .expect("save active rule");
    assert!(active_rule.enabled);

    let _ = engine
        .ingest_event(
            sdk_envelope("sla-1", "pr.opened", Some("pr:99"), &t0.to_rfc3339()),
            t0,
        )
        .await
        .expect("ingest pr.opened arms SLA");
    assert_eq!(engine.armed_sla_count(), 1);

    // Disarming rule clears armed SLA entries immediately.
    engine.disarm_rule_sla(&active_rule.id);
    assert_eq!(engine.armed_sla_count(), 0);

    // Non-temporal ThreadKeyed rule dispatches immediately and preserves bound Session UUID.
    let thread_session_spec = PulseRuleSpec {
        name: "Immediate ThreadKeyed Session".to_string(),
        description: None,
        project_id: None,
        workspace_id: None,
        eval_mode: PulseEvalMode::Auto,
        orchestrator: PresetOrchestratorKind::DirectReflex,
        filter: GateFilterAst {
            source_kinds: vec![EventSourceKind::SdkCustom],
            source_instance_ids: Vec::new(),
            event_types: vec!["pr.comment".to_string()],
            allowed_actors: Vec::new(),
            conditions: Vec::new(),
        },
        temporal: None,
        debounce_ms: 0,
        claim_exclusive: false,
        targets: vec![PulseTargetSpec::Session {
            mode: SessionTargetMode::ThreadKeyed,
            agent_id: "codex".to_string(),
            model_override: None,
            workspace_isolation: PulseWorkspaceIsolation::ProjectRoot,
            project_id: Some("proj-1".to_string()),
            existing_session_id: None,
            delivery_strategy: SessionDeliveryStrategy::Queue,
            subscribe_thread: true,
            prompt_template: "Follow up on {{event.threadKey}}".to_string(),
        }],
    };
    engine
        .save_rule(
            None,
            true,
            MandateOrigin::ExplicitHuman,
            thread_session_spec,
            None,
            t0,
        )
        .await
        .expect("save thread session rule");

    let out1 = engine
        .ingest_event(
            sdk_envelope("tk-1", "pr.comment", Some("pr:99"), &t0.to_rfc3339()),
            t0,
        )
        .await
        .expect("ingest pr.comment");
    assert!(out1.dispatch_plan.actions.iter().any(|a| matches!(
        a,
        PulseDispatchAction::SpawnOrSendSession {
            mode: SessionTargetMode::ThreadKeyed,
            ..
        }
    )));

    // Bind real Session UUID to `pr:99` subscription and verify next event preserves it.
    let real_session_uuid = Uuid::new_v4().to_string();
    let bound_sub = engine
        .store()
        .bind_session_thread_subscription("pr:99", &real_session_uuid, &t0.to_rfc3339())
        .await
        .expect("bind session uuid");
    assert_eq!(bound_sub.subscriber_id, real_session_uuid);

    let t1 = t0 + Duration::seconds(10);
    let _ = engine
        .ingest_event(
            sdk_envelope("tk-2", "pr.comment", Some("pr:99"), &t1.to_rfc3339()),
            t1,
        )
        .await
        .expect("ingest second pr.comment");
    let subs = engine
        .store()
        .list_active_subscriptions_for_thread("pr:99")
        .await
        .expect("list subscriptions");
    assert_eq!(subs.len(), 1);
    assert_eq!(
        subs[0].subscriber_id, real_session_uuid,
        "bound Session UUID must never be overwritten back to session:... placeholder"
    );

    // Interval rule with `skip_if_busy: true` skips firing when busy predicate returns true.
    let interval_spec = PulseRuleSpec {
        name: "Busy-Aware Interval".to_string(),
        description: None,
        project_id: None,
        workspace_id: None,
        eval_mode: PulseEvalMode::Auto,
        orchestrator: PresetOrchestratorKind::DirectReflex,
        filter: GateFilterAst::default(),
        temporal: Some(PulseTemporalSpec::Interval {
            every_seconds: 30,
            skip_if_busy: true,
        }),
        debounce_ms: 0,
        claim_exclusive: false,
        targets: vec![PulseTargetSpec::User {
            interaction_kind: UserInteractionKind::Notify,
            severity: UserInteractionSeverity::Info,
            title_template: "Heartbeat".to_string(),
            body_template: "Tick".to_string(),
            mirror_to_channels: Vec::new(),
            approval_options: Vec::new(),
            form_schema: None,
            sla_timeout_seconds: None,
        }],
    };
    let interval_rule = engine
        .save_rule(
            None,
            true,
            MandateOrigin::ExplicitHuman,
            interval_spec,
            None,
            t0,
        )
        .await
        .expect("save interval rule");

    let due_time = t0 + Duration::seconds(35);
    let skipped_tick = engine
        .tick_temporal(due_time, |rid| rid == interval_rule.id)
        .await
        .expect("tick while busy");
    assert!(
        skipped_tick.emitted_events.is_empty(),
        "skip_if_busy interval rule must not emit when target is busy"
    );

    let next_due = due_time + Duration::seconds(35);
    let fired_tick = engine
        .tick_temporal(next_due, |_| false)
        .await
        .expect("tick when idle");
    assert_eq!(fired_tick.emitted_events.len(), 1);
}
