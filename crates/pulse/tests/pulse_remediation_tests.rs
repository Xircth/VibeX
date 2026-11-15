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
        callback: None,
        task_meta: None,
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
        callback: None,
        task_meta: None,
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
        callback: None,
        task_meta: None,
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
        callback: None,
        task_meta: None,
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

#[tokio::test]
async fn callback_meta_roundtrip_workflow_run_normalizer_and_fast_task_outbox() {
    use std::collections::BTreeMap;

    use api_types::pulse::{
        PulseCallbackKind, PulseCallbackSpec, PulseTaskKind, PulseTaskLifecycleState, PulseTaskMeta,
    };
    use pulse::{FeishuSourceNormalizer, GitHubSourceNormalizer, validate_rule_spec};

    let t0 = Utc.with_ymd_and_hms(2026, 4, 15, 9, 30, 0).unwrap();

    // 1. Wire-schema round-trip (`camelCase` fields + `snake_case` enums).
    let mut headers = BTreeMap::new();
    headers.insert("X-Custom".to_string(), "v1".to_string());
    let callback = PulseCallbackSpec {
        kind: PulseCallbackKind::FeishuWebhook,
        destination: "https://open.feishu.cn/open-apis/bot/v2/hook/demo".to_string(),
        payload_template: "[{{rule.name}}] {{event.eventType}} {{payload.name}}={{payload.conclusion}} on {{payload.head_branch}}".to_string(),
        headers,
        enabled: true,
    };
    let cb_json = serde_json::to_value(&callback).expect("serialize callback");
    assert_eq!(cb_json["kind"], "feishu_webhook");
    assert_eq!(cb_json["payloadTemplate"], callback.payload_template);

    let meta = PulseTaskMeta {
        task_kind: Some(PulseTaskKind::FastTask),
        lifecycle_state: Some(PulseTaskLifecycleState::Published),
        bound_rule_template_id: Some("tpl-ci-alert".to_string()),
        last_tested_at: Some(t0.to_rfc3339()),
        last_test_passed: Some(true),
        last_run_at: None,
        last_run_status: None,
        last_run_summary: None,
    };
    let meta_json = serde_json::to_value(&meta).expect("serialize task meta");
    assert_eq!(meta_json["taskKind"], "fast_task");
    assert_eq!(meta_json["lifecycleState"], "published");
    assert_eq!(meta_json["lastTestPassed"], true);
    let roundtrip_meta: PulseTaskMeta =
        serde_json::from_value(meta_json).expect("deserialize task meta");
    assert_eq!(roundtrip_meta, meta);

    // 2. GitHubSourceNormalizer `workflow_run` (queued -> requested, completed -> completed) & `check_run`.
    let queued_run_payload = json!({
        "action": "queued",
        "workflow_run": {
            "id": 7001,
            "name": "Build & Test",
            "head_branch": "feat/pulse",
            "head_sha": "abc1234",
            "status": "queued",
            "conclusion": null,
            "html_url": "https://github.com/acme/vibex/actions/runs/7001",
            "updated_at": "2026-04-15T09:29:00Z"
        },
        "repository": { "full_name": "acme/vibex" },
        "sender": { "login": "octocat", "type": "User" }
    });
    let gh_norm = GitHubSourceNormalizer::new("src-gh", None);
    let queued_env = gh_norm
        .normalize_webhook("workflow_run", "deliv-wf-7001-q", &queued_run_payload, t0)
        .expect("normalize queued workflow_run");
    assert_eq!(queued_env.event_type, "github.workflow_run.requested");
    assert_eq!(
        queued_env.thread_key.as_deref(),
        Some("github:acme/vibex@abc1234")
    );

    let completed_run_payload = json!({
        "action": "completed",
        "workflow_run": {
            "id": 7001,
            "name": "Build & Test",
            "head_branch": "feat/pulse",
            "head_sha": "abc1234",
            "status": "completed",
            "conclusion": "failure",
            "html_url": "https://github.com/acme/vibex/actions/runs/7001",
            "updated_at": "2026-04-15T09:30:00Z"
        },
        "repository": { "full_name": "acme/vibex" },
        "sender": { "login": "octocat", "type": "User" }
    });
    let completed_env = gh_norm
        .normalize_webhook(
            "workflow_run",
            "deliv-wf-7001-c",
            &completed_run_payload,
            t0,
        )
        .expect("normalize completed workflow_run");
    assert_eq!(completed_env.event_type, "github.workflow_run.completed");
    assert_eq!(completed_env.payload["conclusion"], "failure");
    assert_eq!(completed_env.payload["head_branch"], "feat/pulse");
    assert_eq!(completed_env.payload["name"], "Build & Test");
    assert_eq!(
        completed_env.payload["html_url"],
        "https://github.com/acme/vibex/actions/runs/7001"
    );

    let check_run_env = gh_norm
        .normalize_webhook(
            "check_run",
            "deliv-cr-1",
            &json!({
                "action": "completed",
                "check_run": {
                    "id": 88,
                    "name": "clippy",
                    "head_sha": "abc1234",
                    "status": "completed",
                    "conclusion": "success",
                    "html_url": "https://github.com/acme/vibex/runs/88"
                },
                "repository": { "full_name": "acme/vibex" },
                "sender": { "login": "octocat", "type": "User" }
            }),
            t0,
        )
        .expect("normalize check_run");
    assert_eq!(check_run_env.event_type, "github.check_run.completed");
    assert_eq!(check_run_env.payload["conclusion"], "success");

    // 3. FeishuSourceNormalizer rich-text `post` message extraction.
    let feishu_post_env = FeishuSourceNormalizer::new("src-feishu", None)
        .normalize(
            &json!({
                "header": { "event_id": "ev_99", "event_type": "im.message.receive_v1" },
                "event": {
                    "sender": { "sender_type": "user", "sender_id": { "open_id": "ou_alice" } },
                    "message": {
                        "message_id": "om_99",
                        "chat_id": "oc_dev",
                        "message_type": "post",
                        "content": "{\"title\":\"Deploy Notice\",\"content\":[[{\"tag\":\"text\",\"text\":\"v1.2 shipped\"}]]}"
                    }
                }
            }),
            t0,
        )
        .expect("normalize feishu post");
    assert_eq!(feishu_post_env.event_type, "feishu.im.message");
    assert!(
        feishu_post_env.payload["text"]
            .as_str()
            .unwrap_or("")
            .contains("v1.2 shipped")
    );

    // 4. Callback-only FastTask rule (`targets: []`) validates, ingests, renders template, and populates `recent_outbox`.
    let pool = memory_pool().await;
    let engine = PulseEngine::new(pool);
    engine
        .store()
        .upsert_source(PulseSourceUpsert {
            id: "src-gh".to_string(),
            kind: EventSourceKind::Github,
            title: "GitHub Poller".to_string(),
            enabled: true,
            healthy: true,
            status_message: None,
            cursor_watermark: None,
            public_webhook_path: None,
            config_json: json!({ "mode": "poll", "repo": "acme/vibex" }),
            signing_secret: Some("sec".to_string()),
            now: t0.to_rfc3339(),
        })
        .await
        .expect("upsert gh source");

    let fast_spec = PulseRuleSpec {
        name: "CI Failure Alert".to_string(),
        description: None,
        project_id: None,
        workspace_id: None,
        eval_mode: PulseEvalMode::Auto,
        orchestrator: PresetOrchestratorKind::DirectReflex,
        filter: GateFilterAst {
            source_kinds: vec![EventSourceKind::Github],
            source_instance_ids: vec!["src-gh".to_string()],
            event_types: vec!["github.workflow_run.completed".to_string()],
            allowed_actors: Vec::new(),
            conditions: Vec::new(),
        },
        temporal: None,
        debounce_ms: 0,
        claim_exclusive: false,
        targets: Vec::new(),
        callback: Some(callback),
        task_meta: Some(meta),
    };
    assert!(
        validate_rule_spec(&fast_spec).is_empty(),
        "callback-only FastTask rule should pass rule validation"
    );
    let saved_rule = engine
        .save_rule(None, true, MandateOrigin::ExplicitHuman, fast_spec, None, t0)
        .await
        .expect("save callback-only fast_task rule");

    let outcome = engine
        .ingest_event(completed_env, t0)
        .await
        .expect("ingest completed workflow_run");
    assert_eq!(outcome.dispatch_plan.actions.len(), 1);
    match &outcome.dispatch_plan.actions[0] {
        PulseDispatchAction::EnqueueOutbox {
            rule_id,
            target_kind,
            payload,
            ..
        } => {
            assert_eq!(rule_id.as_deref(), Some(saved_rule.id.as_str()));
            assert_eq!(target_kind, "feishu_webhook");
            assert_eq!(
                payload["renderedText"],
                "[CI Failure Alert] github.workflow_run.completed Build & Test=failure on feat/pulse"
            );
        }
        other => panic!("expected EnqueueOutbox, got {other:?}"),
    }

    let deck = engine.deck_snapshot(None).await.expect("deck snapshot");
    assert_eq!(deck.sources[0].has_signing_secret, true);
    assert_eq!(deck.sources[0].config_json["repo"], "acme/vibex");
    assert_eq!(deck.recent_outbox.len(), 1);
    assert_eq!(
        deck.recent_outbox[0].rule_id.as_deref(),
        Some(saved_rule.id.as_str())
    );
    assert_eq!(deck.recent_outbox[0].target_kind, "feishu_webhook");
    assert_eq!(
        deck.recent_outbox[0].destination.as_deref(),
        Some("https://open.feishu.cn/open-apis/bot/v2/hook/demo")
    );
}
