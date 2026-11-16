use std::{collections::BTreeMap, str::FromStr};

use api_types::pulse::{
    ApprovalOptionSpec, BotConversationScope, BotMailboxPolicy, EventActor, EventEnvelope,
    EventSourceKind, EventSourceMeta, EventTrace, EventTrustLevel, GateFilterAst,
    GateFilterCondition, GroupDispatchMode, GroupMentionOrder, MandateOrigin,
    PresetOrchestratorKind, PulseEvalMode, PulseRuleSpec, PulseTargetSpec, PulseTemporalSpec,
    PulseWorkspaceIsolation, SessionDeliveryStrategy, SessionTargetMode, UserInteractionKind,
    UserInteractionSeverity,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use chrono::{Duration, TimeZone, Utc};
use db::models::pulse::{PulseBotMailboxItem, PulseSourceUpsert, ensure_pulse_schema};
use pulse::{
    ChainRateBreaker, CustomSdkEventInput, CustomSdkEventNormalizer, FeishuSourceNormalizer,
    GitHubSourceNormalizer, InactivitySlaTracker, JiraPollWatermark, JiraSourceNormalizer,
    MAX_WEBHOOK_PAYLOAD_BYTES, PulseDispatchAction, PulseEngine, PulseError,
    StandardWebhookHeaders, TemporalEvaluator, WebhookVerifyError, dry_run_rule,
    enforce_mandate_origin, render_template, sign_standard_webhook, validate_rule_spec,
    verify_standard_webhook,
};
use serde_json::json;
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};

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

fn sample_envelope(
    delivery_id: &str,
    event_type: &str,
    thread_key: Option<&str>,
    payload: serde_json::Value,
) -> EventEnvelope {
    EventEnvelope {
        event_id: format!("evt-{delivery_id}"),
        delivery_id: delivery_id.to_string(),
        source: EventSourceMeta {
            kind: EventSourceKind::Jira,
            instance_id: "jira-main".to_string(),
            trust_level: EventTrustLevel::VerifiedExternal,
        },
        event_type: event_type.to_string(),
        occurred_at: "2026-11-16T09:00:00Z".to_string(),
        actor: EventActor {
            id: "user-alice".to_string(),
            display_name: Some("Alice Chen".to_string()),
            roles: vec!["developer".to_string()],
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
        payload,
    }
}

fn minimal_session_target(prompt: &str) -> PulseTargetSpec {
    PulseTargetSpec::Session {
        mode: SessionTargetMode::EphemeralFresh,
        agent_id: "codex".to_string(),
        model_override: None,
        workspace_isolation: PulseWorkspaceIsolation::IsolatedWorktree,
        project_id: Some("proj-1".to_string()),
        existing_session_id: None,
        delivery_strategy: SessionDeliveryStrategy::Queue,
        subscribe_thread: false,
        prompt_template: prompt.to_string(),
    }
}

// =============================================================================
// 1. Standard Webhooks Security Verification Tests
// =============================================================================

#[test]
fn standard_webhook_verifies_hmac_rotation_replay_window_and_size_before_json_parse() {
    let raw_key = b"0123456789abcdef0123456789abcdef";
    let secret = format!("whsec_{}", STANDARD.encode(raw_key));
    let now = Utc.with_ymd_and_hms(2026, 11, 16, 10, 0, 0).unwrap();
    let ts = now.timestamp();
    let body = br#"{"type":"deploy.failed","data":{"service":"api","threadKey":"ops:deploy-7"}}"#;

    let valid_sig = sign_standard_webhook(&secret, "msg_01J", ts, body).expect("sign");
    let rotated_header = format!("v1,{} {valid_sig}", STANDARD.encode([0u8; 32]));

    let verified = verify_standard_webhook(
        &secret,
        StandardWebhookHeaders {
            webhook_id: "msg_01J",
            webhook_timestamp: &ts.to_string(),
            webhook_signature: &rotated_header,
        },
        body,
        now,
    )
    .expect("valid rotated signature should verify");
    assert_eq!(verified.delivery_id, "msg_01J");
    assert_eq!(verified.payload["type"], "deploy.failed");

    // 1a. Oversized (> 64 KiB) malformed non-JSON body MUST fail with PayloadTooLarge BEFORE JSON parsing.
    let oversized_garbage = vec![b'{'; MAX_WEBHOOK_PAYLOAD_BYTES + 1];
    let err = verify_standard_webhook(
        &secret,
        StandardWebhookHeaders {
            webhook_id: "msg_big",
            webhook_timestamp: &ts.to_string(),
            webhook_signature: &valid_sig,
        },
        &oversized_garbage,
        now,
    )
    .expect_err("oversized payload must be rejected");
    assert_eq!(
        err,
        WebhookVerifyError::PayloadTooLarge {
            size: MAX_WEBHOOK_PAYLOAD_BYTES + 1,
            max: MAX_WEBHOOK_PAYLOAD_BYTES,
        }
    );

    // 1b. Invalid signature on malformed JSON MUST fail with SignatureMismatch BEFORE serde_json runs.
    let malformed_json = b"{not-valid-json-at-all";
    let bad_sig = format!("v1,{}", STANDARD.encode([7u8; 32]));
    let sig_err = verify_standard_webhook(
        &secret,
        StandardWebhookHeaders {
            webhook_id: "msg_bad_sig",
            webhook_timestamp: &ts.to_string(),
            webhook_signature: &bad_sig,
        },
        malformed_json,
        now,
    )
    .expect_err("bad signature must fail prior to JSON parse");
    assert_eq!(sig_err, WebhookVerifyError::SignatureMismatch);

    // 1c. Replay window > 300s (both stale and future timestamps) MUST be rejected.
    let stale_ts = ts - 301;
    let stale_sig = sign_standard_webhook(&secret, "msg_stale", stale_ts, body).unwrap();
    let replay_err = verify_standard_webhook(
        &secret,
        StandardWebhookHeaders {
            webhook_id: "msg_stale",
            webhook_timestamp: &stale_ts.to_string(),
            webhook_signature: &stale_sig,
        },
        body,
        now,
    )
    .expect_err("stale timestamp must fail replay window");
    assert!(matches!(
        replay_err,
        WebhookVerifyError::ReplayWindowExpired { skew_seconds: 301 }
    ));

    let future_ts = ts + 305;
    let future_sig = sign_standard_webhook(&secret, "msg_future", future_ts, body).unwrap();
    assert!(matches!(
        verify_standard_webhook(
            &secret,
            StandardWebhookHeaders {
                webhook_id: "msg_future",
                webhook_timestamp: &future_ts.to_string(),
                webhook_signature: &future_sig,
            },
            body,
            now,
        ),
        Err(WebhookVerifyError::ReplayWindowExpired { skew_seconds: 305 })
    ));
}

// =============================================================================
// 2. Exhaustive No-Fail-Fast Rule Validation Tests
// =============================================================================

#[test]
fn validate_rule_spec_collects_every_violation_in_one_pass_without_fail_fast() {
    let invalid_spec = PulseRuleSpec {
        name: "   ".to_string(),
        description: None,
        project_id: None,
        workspace_id: None,
        eval_mode: PulseEvalMode::Auto,
        orchestrator: PresetOrchestratorKind::DirectReflex,
        filter: GateFilterAst {
            source_kinds: Vec::new(),
            source_instance_ids: Vec::new(),
            event_types: Vec::new(),
            allowed_actors: Vec::new(),
            conditions: vec![
                GateFilterCondition::Eq {
                    pointer: "".to_string(),
                    value: json!("P0"),
                },
                GateFilterCondition::Regex {
                    pointer: "missing_leading_slash".to_string(),
                    pattern: "[unclosed-group".to_string(),
                },
                GateFilterCondition::InSet {
                    pointer: "/bad~escape".to_string(),
                    values: Vec::new(),
                },
            ],
        },
        temporal: Some(PulseTemporalSpec::Cron {
            expression: "bad cron".to_string(),
            timezone: "Mars/Olympus_Mons".to_string(),
            weekdays_only: false,
            catch_up_once: false,
        }),
        debounce_ms: 0,
        claim_exclusive: false,
        targets: vec![
            PulseTargetSpec::Session {
                mode: SessionTargetMode::ExistingSession,
                agent_id: "".to_string(),
                model_override: None,
                workspace_isolation: PulseWorkspaceIsolation::IsolatedWorktree,
                project_id: None,
                existing_session_id: None,
                delivery_strategy: SessionDeliveryStrategy::Queue,
                subscribe_thread: false,
                prompt_template: " ".to_string(),
            },
            PulseTargetSpec::Bot {
                member_id: "".to_string(),
                conversation_scope: BotConversationScope::FixedPrimary,
                mailbox_policy: BotMailboxPolicy::FifoSerial,
                subscribe_thread: false,
                prompt_template: "".to_string(),
            },
            PulseTargetSpec::Group {
                space_id: "".to_string(),
                dispatch_mode: GroupDispatchMode::MentionSeats {
                    member_id_list: Vec::new(),
                    order: GroupMentionOrder::Parallel,
                },
                message_template: "".to_string(),
            },
            PulseTargetSpec::User {
                interaction_kind: UserInteractionKind::Approval,
                severity: UserInteractionSeverity::Urgent,
                title_template: "".to_string(),
                body_template: "".to_string(),
                mirror_to_channels: Vec::new(),
                approval_options: Vec::new(),
                form_schema: None,
                sla_timeout_seconds: Some(0),
            },
            PulseTargetSpec::Workflow {
                workflow_id: "".to_string(),
                pinned_version: 0,
                input_mapping: BTreeMap::new(),
            },
        ],
        callback: None,
        task_meta: None,
    };

    let violations = validate_rule_spec(&invalid_spec);
    let paths: Vec<&str> = violations.iter().map(|v| v.path.as_str()).collect();

    for expected_path in [
        "name",
        "filter.conditions[0].pointer",
        "filter.conditions[1].pointer",
        "filter.conditions[1].pattern",
        "filter.conditions[2].pointer",
        "filter.conditions[2].values",
        "temporal.expression",
        "temporal.timezone",
        "targets[0].agentId",
        "targets[0].existingSessionId",
        "targets[0].promptTemplate",
        "targets[1].memberId",
        "targets[1].promptTemplate",
        "targets[2].spaceId",
        "targets[2].dispatchMode.memberIds",
        "targets[2].messageTemplate",
        "targets[3].titleTemplate",
        "targets[3].approvalOptions",
        "targets[3].slaTimeoutSeconds",
        "targets[4].workflowId",
        "targets[4].pinnedVersion",
    ] {
        assert!(
            paths.contains(&expected_path),
            "expected violation at `{expected_path}`, got paths: {paths:?}"
        );
    }
}

// =============================================================================
// 3. RFC 6901 Filter AST, Template Renderer & Dry-Run Tests
// =============================================================================

#[test]
fn rfc6901_filter_conditions_template_interpolation_and_dry_run_work() {
    let envelope = sample_envelope(
        "deliv-42",
        "jira.issue.transitioned",
        Some("jira:CORE-42"),
        json!({
            "issue": {
                "key": "CORE-42",
                "priority": "P0",
                "storyPoints": 8,
                "labels": ["regression", "security"],
                "summary": "Fix auth race in token refresh"
            },
            "meta/slash~tilde": "escaped-ok"
        }),
    );

    let spec = PulseRuleSpec {
        name: "P0 Escalation".to_string(),
        description: None,
        project_id: None,
        workspace_id: None,
        eval_mode: PulseEvalMode::Auto,
        orchestrator: PresetOrchestratorKind::DirectReflex,
        filter: GateFilterAst {
            source_kinds: vec![EventSourceKind::Jira],
            source_instance_ids: vec!["jira-main".to_string()],
            event_types: vec!["jira.issue.transitioned".to_string()],
            allowed_actors: vec!["user-alice".to_string()],
            conditions: vec![
                GateFilterCondition::NotBotActor,
                GateFilterCondition::Eq {
                    pointer: "/issue/priority".to_string(),
                    value: json!("P0"),
                },
                GateFilterCondition::Neq {
                    pointer: "/issue/key".to_string(),
                    value: json!("CORE-1"),
                },
                GateFilterCondition::Gt {
                    pointer: "/issue/storyPoints".to_string(),
                    value: 5.0,
                },
                GateFilterCondition::Lte {
                    pointer: "/issue/storyPoints".to_string(),
                    value: 8.0,
                },
                GateFilterCondition::Lt {
                    pointer: "/issue/storyPoints".to_string(),
                    value: 10.0,
                },
                GateFilterCondition::Gte {
                    pointer: "/issue/storyPoints".to_string(),
                    value: 8.0,
                },
                GateFilterCondition::Contains {
                    pointer: "/issue/labels".to_string(),
                    needle: "security".to_string(),
                },
                GateFilterCondition::InSet {
                    pointer: "/issue/priority".to_string(),
                    values: vec![json!("P0"), json!("P1")],
                },
                GateFilterCondition::Exists {
                    pointer: "/meta~1slash~0tilde".to_string(),
                },
                GateFilterCondition::Regex {
                    pointer: "/issue/summary".to_string(),
                    pattern: "^Fix\\s+auth".to_string(),
                },
                // Envelope-level fallback pointer
                GateFilterCondition::Eq {
                    pointer: "/actor/displayName".to_string(),
                    value: json!("Alice Chen"),
                },
            ],
        },
        temporal: None,
        debounce_ms: 0,
        claim_exclusive: false,
        targets: vec![minimal_session_target(
            "Handle {{/issue/key}} ({{event.id}}) by {{actor.displayName}}: {{payload.issue.summary}}",
        )],
        callback: None,
        task_meta: None,
    };

    let report = dry_run_rule(&spec, &envelope);
    assert!(report.valid, "violations: {:?}", report.violations);
    assert!(
        report.matched,
        "unmatched: {:?}",
        report.unmatched_conditions
    );
    assert_eq!(
        report.rendered_previews,
        vec!["Handle CORE-42 (evt-deliv-42) by Alice Chen: Fix auth race in token refresh"]
    );

    let rendered = render_template(
        "Thread={{threadKey}} Esc={{/meta~1slash~0tilde}}",
        &envelope,
    );
    assert_eq!(rendered, "Thread=jira:CORE-42 Esc=escaped-ok");
}

// =============================================================================
// 4. Platform & Custom Source Normalizer Tests
// =============================================================================

#[test]
fn feishu_jira_github_and_custom_sdk_normalizers_produce_canonical_envelopes() {
    let now = Utc.with_ymd_and_hms(2026, 11, 16, 11, 0, 0).unwrap();

    // 4a. Feishu IM mention + self-echo detection + card action
    let feishu = FeishuSourceNormalizer::new("feishu-prod", Some("ou_vibex_bot".to_string()));
    let feishu_mention_raw = json!({
        "header": {
            "event_id": "feishu-ev-1",
            "event_type": "im.message.receive_v1"
        },
        "event": {
            "sender": {
                "sender_type": "user",
                "sender_id": { "open_id": "ou_human_1" }
            },
            "message": {
                "message_id": "om_msg_100",
                "root_id": "om_root_99",
                "chat_id": "oc_group_1",
                "chat_type": "group",
                "message_type": "text",
                "content": "{\"text\":\"@_user_1 please fix the flaky test\"}",
                "mentions": [
                    { "key": "@_user_1", "id": { "open_id": "ou_vibex_bot" }, "name": "VibeX Bot" }
                ]
            }
        }
    });
    let feishu_env = feishu.normalize(&feishu_mention_raw, now).unwrap();
    assert_eq!(feishu_env.event_type, "feishu.im.mention");
    assert_eq!(
        feishu_env.thread_key.as_deref(),
        Some("feishu:topic:om_root_99")
    );
    assert!(!feishu_env.actor.is_bot);
    assert!(!feishu_env.actor.is_self);
    assert_eq!(feishu_env.reply_channels[0].channel_id, "oc_group_1");
    assert_eq!(
        feishu_env.payload["text"],
        "@_user_1 please fix the flaky test"
    );

    // Self message from bot_open_id
    let feishu_self_raw = json!({
        "header": { "event_id": "feishu-ev-2", "event_type": "im.message.receive_v1" },
        "event": {
            "sender": { "sender_type": "app", "sender_id": { "open_id": "ou_vibex_bot" } },
            "message": { "message_id": "om_msg_101", "chat_id": "oc_group_1", "content": "{\"text\":\"done\"}" }
        }
    });
    let feishu_self_env = feishu.normalize(&feishu_self_raw, now).unwrap();
    assert!(feishu_self_env.actor.is_bot);
    assert!(feishu_self_env.actor.is_self);

    // Card callback
    let feishu_card_raw = json!({
        "header": { "event_id": "card-ev-1", "event_type": "card.action.trigger" },
        "event": {
            "operator": { "open_id": "ou_human_1" },
            "context": { "open_message_id": "om_card_77", "open_chat_id": "oc_group_1" },
            "action": { "tag": "button", "value": { "decision": "approve" } }
        }
    });
    let card_env = feishu.normalize(&feishu_card_raw, now).unwrap();
    assert_eq!(card_env.event_type, "feishu.card.action");
    assert_eq!(
        card_env.thread_key.as_deref(),
        Some("feishu:topic:om_card_77")
    );

    // 4b. Jira webhook + JQL watermark delta normalizer
    let jira = JiraSourceNormalizer::new("jira-corp", Some("acct-vibex-bot".to_string()));
    let jira_hook = json!({
        "webhookEvent": "jira:issue_updated",
        "timestamp": 1794826800000i64,
        "user": { "accountId": "acct-pm", "displayName": "PM Lead" },
        "issue": {
            "key": "CORE-128",
            "fields": {
                "summary": "Implement Pulse outbox",
                "status": { "name": "In Progress" },
                "priority": { "name": "High" }
            }
        },
        "changelog": {
            "items": [{ "field": "status", "fromString": "To Do", "toString": "In Progress" }]
        }
    });
    let jira_env = jira.normalize_webhook(&jira_hook, None, now).unwrap();
    assert_eq!(jira_env.event_type, "jira.issue.transitioned");
    assert_eq!(jira_env.thread_key.as_deref(), Some("jira:CORE-128"));

    let poll_batch_1 = vec![json!({
        "key": "CORE-200",
        "fields": {
            "summary": "Memory leak in worker",
            "updated": "2026-11-16T10:00:00.000+0000",
            "status": { "name": "Open" },
            "priority": { "name": "P1" },
            "assignee": { "accountId": "acct-dev" }
        }
    })];
    let (deltas_1, wm_1) = jira
        .normalize_jql_poll_batch(&poll_batch_1, &JiraPollWatermark::default(), now)
        .unwrap();
    assert_eq!(deltas_1.len(), 1);
    assert_eq!(deltas_1[0].event_type, "jira.issue.created");
    assert_eq!(deltas_1[0].thread_key.as_deref(), Some("jira:CORE-200"));

    // Polling exact same snapshot yields 0 duplicate events
    let (deltas_dup, wm_dup) = jira
        .normalize_jql_poll_batch(&poll_batch_1, &wm_1, now)
        .unwrap();
    assert!(deltas_dup.is_empty());
    assert_eq!(wm_dup, wm_1);

    // Priority escalation produces jira.issue.priority_escalated
    let poll_batch_2 = vec![json!({
        "key": "CORE-200",
        "fields": {
            "summary": "Memory leak in worker",
            "updated": "2026-11-16T10:05:00.000+0000",
            "status": { "name": "Open" },
            "priority": { "name": "P0" },
            "assignee": { "accountId": "acct-dev" }
        }
    })];
    let (deltas_2, _wm_2) = jira
        .normalize_jql_poll_batch(&poll_batch_2, &wm_1, now)
        .unwrap();
    assert_eq!(deltas_2.len(), 1);
    assert_eq!(deltas_2[0].event_type, "jira.issue.priority_escalated");
    assert_eq!(deltas_2[0].payload["delta"]["from"], "P1");
    assert_eq!(deltas_2[0].payload["delta"]["to"], "P0");

    // 4c. GitHub normalizer (issues, PR merged, issue_comment, check_suite + self artifact)
    let mut github = GitHubSourceNormalizer::new("gh-main", Some("vibex-bot".to_string()));
    github.register_self_artifact("sha-self-commit");

    let gh_ci_raw = json!({
        "action": "completed",
        "repository": { "full_name": "acme/vibex" },
        "sender": { "login": "github-actions[bot]", "type": "Bot" },
        "check_suite": {
            "conclusion": "failure",
            "head_sha": "sha-user-commit",
            "head_branch": "feat/pulse",
            "pull_requests": [{ "number": 88 }]
        }
    });
    let gh_ci_env = github
        .normalize_webhook("check_suite", "gh-deliv-1", &gh_ci_raw, now)
        .unwrap();
    assert_eq!(gh_ci_env.event_type, "github.ci.failed");
    assert_eq!(
        gh_ci_env.thread_key.as_deref(),
        Some("github:acme/vibex#88")
    );
    assert!(gh_ci_env.actor.is_bot);
    assert!(!gh_ci_env.actor.is_self);

    let gh_self_pr = json!({
        "action": "synchronize",
        "repository": { "full_name": "acme/vibex" },
        "sender": { "login": "human-pusher", "type": "User" },
        "pull_request": {
            "number": 88,
            "title": "Pulse Track B1",
            "head": { "sha": "sha-self-commit" }
        }
    });
    let gh_self_env = github
        .normalize_webhook("pull_request", "gh-deliv-2", &gh_self_pr, now)
        .unwrap();
    assert!(gh_self_env.actor.is_self);

    // 4d. Custom SDK normalizer trace hop inheritance
    let child_env = CustomSdkEventNormalizer::normalize(
        CustomSdkEventInput {
            instance_id: "sdk-ci".to_string(),
            event_type: "ci.coverage.dropped".to_string(),
            delivery_id: Some("cov-1".to_string()),
            actor_id: "agent:coder".to_string(),
            actor_display_name: None,
            trust_level: EventTrustLevel::TrustedInternal,
            thread_key: Some("github:acme/vibex#88".to_string()),
            correlations: Vec::new(),
            reply_channels: Vec::new(),
            parent_envelope: Some(gh_ci_env.clone()),
            parent_run_id: Some("run-99".to_string()),
            payload: json!({ "deltaPct": -3.2 }),
        },
        now,
    )
    .unwrap();
    assert_eq!(child_env.trace.hop_count, 1);
    assert_eq!(child_env.trace.root_event_id, gh_ci_env.event_id);
}

// =============================================================================
// 5. Temporal Cron (5/6-field, weekdays_only, catch_up_once), Interval & SLA Tests
// =============================================================================

#[test]
fn temporal_evaluator_handles_cron_weekdays_catchup_interval_and_inactivity_sla() {
    // 2026-11-13 is Friday; 09:30 Asia/Shanghai == 01:30 UTC
    let fri_after_slot = Utc.with_ymd_and_hms(2026, 11, 13, 2, 0, 0).unwrap();
    let cron_spec = PulseTemporalSpec::Cron {
        expression: "30 9 * * *".to_string(),
        timezone: "Asia/Shanghai".to_string(),
        weekdays_only: true,
        catch_up_once: true,
    };

    // Next weekday occurrence after Friday 10:00 Shanghai must skip Sat (14) & Sun (15) -> Mon Nov 16 09:30 Shanghai (01:30 UTC)
    let next_mon = TemporalEvaluator::compute_next_fire_at(&cron_spec, fri_after_slot)
        .unwrap()
        .unwrap();
    assert_eq!(
        next_mon,
        Utc.with_ymd_and_hms(2026, 11, 16, 1, 30, 0).unwrap()
    );

    // 6-field seconds-first cron (`15 */10 * * * *`)
    let six_field = PulseTemporalSpec::Cron {
        expression: "15 */10 * * * *".to_string(),
        timezone: "UTC".to_string(),
        weekdays_only: false,
        catch_up_once: false,
    };
    let next_six = TemporalEvaluator::compute_next_fire_at(
        &six_field,
        Utc.with_ymd_and_hms(2026, 11, 16, 10, 0, 20).unwrap(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        next_six,
        Utc.with_ymd_and_hms(2026, 11, 16, 10, 10, 15).unwrap()
    );

    // Missed downtime window: `catch_up_once: true` fires ONCE and advances past `now`;
    // `catch_up_once: false` skips the stale slot and advances past `now`.
    let scheduled = Utc.with_ymd_and_hms(2026, 11, 16, 1, 30, 0).unwrap();
    let resumed_late = scheduled + Duration::hours(3);
    let caught_up = TemporalEvaluator::evaluate_due_rule(
        "r-catchup",
        &cron_spec,
        scheduled,
        resumed_late,
        false,
    )
    .unwrap();
    assert!(caught_up.emitted_envelope.is_some());
    assert!(caught_up.next_fire_at.unwrap() > resumed_late);

    let no_catchup_spec = PulseTemporalSpec::Cron {
        expression: "30 9 * * *".to_string(),
        timezone: "Asia/Shanghai".to_string(),
        weekdays_only: true,
        catch_up_once: false,
    };
    let skipped = TemporalEvaluator::evaluate_due_rule(
        "r-skip",
        &no_catchup_spec,
        scheduled,
        resumed_late,
        false,
    )
    .unwrap();
    assert!(skipped.emitted_envelope.is_none());
    assert!(skipped.next_fire_at.unwrap() > resumed_late);

    // Interval `skip_if_busy: true` skips when busy
    let interval_spec = PulseTemporalSpec::Interval {
        every_seconds: 60,
        skip_if_busy: true,
    };
    let busy_tick = TemporalEvaluator::evaluate_due_rule(
        "r-int",
        &interval_spec,
        scheduled,
        scheduled + Duration::seconds(5),
        true,
    )
    .unwrap();
    assert!(busy_tick.emitted_envelope.is_none());
    assert_eq!(
        busy_tick.next_fire_at,
        Some(scheduled + Duration::seconds(65))
    );

    // InactivitySlaTracker: arm, disarm on expected event, and expire when overdue
    let sla_rule = api_types::pulse::PulseRuleView {
        id: "sla-rule-1".to_string(),
        revision: 1,
        enabled: true,
        draft_only: false,
        mandate_origin: MandateOrigin::ExplicitHuman,
        spec: PulseRuleSpec {
            name: "P0 30m SLA".to_string(),
            description: None,
            project_id: None,
            workspace_id: None,
            eval_mode: PulseEvalMode::Auto,
            orchestrator: PresetOrchestratorKind::DirectReflex,
            filter: GateFilterAst::default(),
            temporal: Some(PulseTemporalSpec::InactivitySla {
                thread_key_prefix: "jira:CORE-".to_string(),
                timeout_seconds: 1800,
                expected_event_types: vec!["jira.issue.transitioned".to_string()],
            }),
            debounce_ms: 0,
            claim_exclusive: false,
            targets: vec![minimal_session_target("SLA expired on {{threadKey}}")],
            callback: None, task_meta: None,
        },
        webhook_route_id: None,
        next_fire_at: None,
        matched_count: 0,
        observed_count: 0,
        created_at: scheduled.to_rfc3339(),
        updated_at: scheduled.to_rfc3339(),
    };

    let mut tracker = InactivitySlaTracker::new();
    let t0 = Utc.with_ymd_and_hms(2026, 11, 16, 12, 0, 0).unwrap();

    //CORE-1 opened -> armed; CORE-1 transitioned before timeout -> disarmed!
    tracker.observe_event(
        std::slice::from_ref(&sla_rule),
        &sample_envelope("d1", "jira.issue.created", Some("jira:CORE-1"), json!({})),
        t0,
    );
    assert_eq!(tracker.armed_count(), 1);
    tracker.observe_event(
        std::slice::from_ref(&sla_rule),
        &sample_envelope(
            "d2",
            "jira.issue.transitioned",
            Some("jira:CORE-1"),
            json!({}),
        ),
        t0 + Duration::minutes(10),
    );
    assert_eq!(tracker.armed_count(), 0);

    // CORE-2 opened -> no transition within 30m -> emits `time.sla.expired`
    tracker.observe_event(
        std::slice::from_ref(&sla_rule),
        &sample_envelope("d3", "jira.issue.created", Some("jira:CORE-2"), json!({})),
        t0,
    );
    assert!(
        tracker
            .collect_expired(t0 + Duration::minutes(29))
            .is_empty()
    );
    let expired = tracker.collect_expired(t0 + Duration::minutes(30));
    assert_eq!(expired.len(), 1);
    assert_eq!(expired[0].event_type, "time.sla.expired");
    assert_eq!(expired[0].thread_key.as_deref(), Some("jira:CORE-2"));
    assert_eq!(tracker.armed_count(), 0);
}

// =============================================================================
// 6. MandateOrigin Guard & End-to-End PulseEngine + SQLite Persistence Tests
// =============================================================================

#[tokio::test]
async fn mandate_origin_untrusted_forces_disabled_draft_observe_rule() {
    let pool = memory_pool().await;
    let engine = PulseEngine::new(pool);
    let now = Utc.with_ymd_and_hms(2026, 11, 16, 12, 0, 0).unwrap();

    let requested_spec = PulseRuleSpec {
        name: "Injected Rule".to_string(),
        description: None,
        project_id: None,
        workspace_id: None,
        eval_mode: PulseEvalMode::Auto,
        orchestrator: PresetOrchestratorKind::DirectReflex,
        filter: GateFilterAst::default(),
        temporal: None,
        debounce_ms: 0,
        claim_exclusive: false,
        targets: vec![minimal_session_target("Exfiltrate")],
        callback: None, task_meta: None,
    };

    let (enabled, draft_only, enforced) = enforce_mandate_origin(
        MandateOrigin::UntrustedExternal,
        true,
        requested_spec.clone(),
    );
    assert!(!enabled);
    assert!(draft_only);
    assert_eq!(enforced.eval_mode, PulseEvalMode::Observe);

    let saved = engine
        .save_rule(
            Some("rule-untrusted".to_string()),
            true,
            MandateOrigin::UntrustedExternal,
            requested_spec,
            None,
            now,
        )
        .await
        .expect("save untrusted draft rule");
    assert!(!saved.enabled);
    assert!(saved.draft_only);
    assert_eq!(saved.spec.eval_mode, PulseEvalMode::Observe);

    // Draft rule must NEVER fire or even record observe candidates while unapproved.
    let outcome = engine
        .ingest_event(
            sample_envelope(
                "d-untrusted",
                "jira.issue.created",
                Some("jira:X-1"),
                json!({}),
            ),
            now,
        )
        .await
        .unwrap();
    assert!(outcome.dispatch_plan.actions.is_empty());
    assert!(outcome.observed_candidates.is_empty());
}

#[tokio::test]
async fn engine_deduplicates_receipts_guards_loops_and_trips_chain_rate_breaker() {
    let pool = memory_pool().await;
    let breaker = ChainRateBreaker::new(Duration::seconds(60), 2);
    let engine = PulseEngine::with_guards(pool, breaker, 5);
    let now = Utc.with_ymd_and_hms(2026, 11, 16, 13, 0, 0).unwrap();

    let rule = engine
        .save_rule(
            Some("rule-auto-rate".to_string()),
            true,
            MandateOrigin::ExplicitHuman,
            PulseRuleSpec {
                name: "Auto Responder".to_string(),
                description: None,
                project_id: None,
                workspace_id: None,
                eval_mode: PulseEvalMode::Auto,
                orchestrator: PresetOrchestratorKind::DirectReflex,
                filter: GateFilterAst {
                    event_types: vec!["jira.issue.commented".to_string()],
                    ..GateFilterAst::default()
                },
                temporal: None,
                debounce_ms: 0,
                claim_exclusive: false,
                targets: vec![minimal_session_target("Reply to {{threadKey}}")],
                callback: None, task_meta: None,
            },
            None,
            now,
        )
        .await
        .unwrap();

    // 1) Self-echo rejected
    let mut self_env = sample_envelope(
        "d-self",
        "jira.issue.commented",
        Some("jira:LOOP-1"),
        json!({}),
    );
    self_env.actor.is_self = true;
    let self_out = engine.ingest_event(self_env, now).await.unwrap();
    assert_eq!(self_out.rejected_reason.as_deref(), Some("self_actor"));

    // 2) Hop count > 5 rejected
    let mut hop_env = sample_envelope(
        "d-hop",
        "jira.issue.commented",
        Some("jira:LOOP-1"),
        json!({}),
    );
    hop_env.trace.hop_count = 6;
    let hop_out = engine.ingest_event(hop_env, now).await.unwrap();
    assert_eq!(hop_out.rejected_reason.as_deref(), Some("hop_overflow"));

    // 3) Atomic receipt deduplication on identical delivery_id
    let env1 = sample_envelope(
        "d-1",
        "jira.issue.commented",
        Some("jira:LOOP-1"),
        json!({}),
    );
    let out1 = engine.ingest_event(env1.clone(), now).await.unwrap();
    assert!(!out1.duplicate_delivery);
    assert_eq!(out1.dispatch_plan.actions.len(), 1);

    let dup_out = engine
        .ingest_event(env1, now + Duration::seconds(1))
        .await
        .unwrap();
    assert!(dup_out.duplicate_delivery);
    assert!(dup_out.dispatch_plan.actions.is_empty());

    // 4) Rate breaker allows 2nd trigger within 60s, then trips on 3rd trigger and downgrades rule to Observe!
    let env2 = sample_envelope(
        "d-2",
        "jira.issue.commented",
        Some("jira:LOOP-1"),
        json!({}),
    );
    let out2 = engine
        .ingest_event(env2, now + Duration::seconds(10))
        .await
        .unwrap();
    assert_eq!(out2.dispatch_plan.actions.len(), 1);
    assert!(out2.downgraded_rule_ids.is_empty());

    let env3 = sample_envelope(
        "d-3",
        "jira.issue.commented",
        Some("jira:LOOP-1"),
        json!({}),
    );
    let out3 = engine
        .ingest_event(env3, now + Duration::seconds(20))
        .await
        .unwrap();
    assert_eq!(out3.downgraded_rule_ids, vec![rule.id.clone()]);
    assert!(out3.dispatch_plan.actions.is_empty());
    assert_eq!(out3.observed_candidates.len(), 1);

    let persisted_rule = engine.store().get_rule(&rule.id).await.unwrap().unwrap();
    assert_eq!(persisted_rule.spec.eval_mode, PulseEvalMode::Observe);
}

#[tokio::test]
async fn thread_subscription_o1_routing_bot_mailbox_fifo_coalesce_and_observe_promote_flow() {
    let pool = memory_pool().await;

    // Verify SQLite uses `idx_pulse_thread_subscriptions_lookup` for `(thread_key, active)` O(1) lookup.
    let plan_rows: Vec<(i64, i64, i64, String)> = sqlx::query_as(
        "EXPLAIN QUERY PLAN
         SELECT id, thread_key, subscriber_kind, subscriber_id, active, created_at
         FROM pulse_thread_subscriptions
         WHERE thread_key = 'jira:CORE-99' AND active = 1",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    let joined_plan = plan_rows
        .into_iter()
        .map(|(_, _, _, detail)| detail)
        .collect::<Vec<_>>()
        .join(" ");
    assert!(
        joined_plan.contains("idx_pulse_thread_subscriptions_lookup"),
        "expected O(1) index scan via idx_pulse_thread_subscriptions_lookup, got: {joined_plan}"
    );

    let engine = PulseEngine::new(pool);
    let now = Utc.with_ymd_and_hms(2026, 11, 16, 14, 0, 0).unwrap();

    // Register a Standard Webhook source and test end-to-end signed webhook ingestion
    let secret = format!(
        "whsec_{}",
        STANDARD.encode(b"super-secret-32-byte-signing-key")
    );
    engine
        .store()
        .upsert_source(PulseSourceUpsert {
            id: "src-hook-1".to_string(),
            kind: EventSourceKind::WebhookStandard,
            title: "CI Webhook".to_string(),
            enabled: true,
            healthy: true,
            status_message: None,
            cursor_watermark: None,
            public_webhook_path: Some("/webhooks/pulse/src-hook-1".to_string()),
            config_json: json!({}),
            signing_secret: Some(secret.clone()),
            now: now.to_rfc3339(),
        })
        .await
        .unwrap();

    // Create an Observe-mode multi-target rule covering Session, Bot, Group, User Approval, and Workflow
    let mut workflow_inputs = BTreeMap::new();
    workflow_inputs.insert("issueKey".to_string(), "{{/issue/key}}".to_string());

    let observe_rule = engine
        .save_rule(
            Some("rule-observe-rich".to_string()),
            true,
            MandateOrigin::ExplicitHuman,
            PulseRuleSpec {
                name: "Multi-Target Incident Reflex".to_string(),
                description: Some("Shadow rehearsal before full auto".to_string()),
                project_id: Some("proj-alpha".to_string()),
                workspace_id: None,
                eval_mode: PulseEvalMode::Observe,
                orchestrator: PresetOrchestratorKind::HybridPipeline,
                filter: GateFilterAst {
                    event_types: vec!["jira.issue.created".to_string()],
                    conditions: vec![GateFilterCondition::Eq {
                        pointer: "/issue/priority".to_string(),
                        value: json!("P0"),
                    }],
                    ..GateFilterAst::default()
                },
                temporal: None,
                debounce_ms: 0,
                claim_exclusive: true,
                targets: vec![
                    PulseTargetSpec::Session {
                        mode: SessionTargetMode::ThreadKeyed,
                        agent_id: "claude-code".to_string(),
                        model_override: None,
                        workspace_isolation: PulseWorkspaceIsolation::IsolatedWorktree,
                        project_id: Some("proj-alpha".to_string()),
                        existing_session_id: Some("sess-42".to_string()),
                        delivery_strategy: SessionDeliveryStrategy::Queue,
                        subscribe_thread: true,
                        prompt_template: "Investigate {{/issue/key}}".to_string(),
                    },
                    PulseTargetSpec::Bot {
                        member_id: "bot-sre".to_string(),
                        conversation_scope: BotConversationScope::FixedPrimary,
                        mailbox_policy: BotMailboxPolicy::FifoSerial,
                        subscribe_thread: true,
                        prompt_template: "Triage {{/issue/key}}".to_string(),
                    },
                    PulseTargetSpec::Group {
                        space_id: "space-war-room".to_string(),
                        dispatch_mode: GroupDispatchMode::SpecificSeat {
                            member_id: "bot-lead".to_string(),
                        },
                        message_template: "War-room alert for {{/issue/key}}".to_string(),
                    },
                    PulseTargetSpec::User {
                        interaction_kind: UserInteractionKind::Approval,
                        severity: UserInteractionSeverity::Urgent,
                        title_template: "Approve rollback for {{/issue/key}}?".to_string(),
                        body_template: "Triggered by {{actor.displayName}}".to_string(),
                        mirror_to_channels: vec!["feishu:oc_oncall".to_string()],
                        approval_options: vec![ApprovalOptionSpec {
                            id: "approve".to_string(),
                            label: "Approve Rollback".to_string(),
                            destructive: true,
                            require_note: false,
                        }],
                        form_schema: None,
                        sla_timeout_seconds: Some(600),
                    },
                    PulseTargetSpec::Workflow {
                        workflow_id: "wf-hotfix".to_string(),
                        pinned_version: 2,
                        input_mapping: workflow_inputs,
                    },
                ],
                callback: None, task_meta: None,
            },
            None,
            now,
        )
        .await
        .unwrap();

    // 1. Ingest event while rule is in Observe mode -> records ObservedCandidate without firing targets
    let p0_env = sample_envelope(
        "d-obs-1",
        "jira.issue.created",
        Some("jira:CORE-99"),
        json!({ "issue": { "key": "CORE-99", "priority": "P0" } }),
    );
    let obs_out = engine.ingest_event(p0_env, now).await.unwrap();
    assert!(obs_out.dispatch_plan.actions.is_empty());
    assert_eq!(obs_out.observed_candidates.len(), 1);
    let candidate_id = obs_out.observed_candidates[0].id.clone();

    // 2. Promote ObservedCandidate -> upgrades rule to Auto, dispatches all 5 targets + mirror outbox,
    //    and auto-subscribes `sess-42` and `bot-sre` to `jira:CORE-99`!
    let promoted_plan = engine
        .promote_observed_candidate(&candidate_id, true, now + Duration::seconds(5))
        .await
        .expect("promote observed candidate");
    assert_eq!(promoted_plan.actions.len(), 6); // 5 targets + 1 mirror outbox action
    assert!(
        promoted_plan
            .actions
            .iter()
            .any(|a| matches!(a, PulseDispatchAction::SpawnOrSendSession { prompt, .. } if prompt == "Investigate CORE-99"))
    );
    assert!(
        promoted_plan
            .actions
            .iter()
            .any(|a| matches!(a, PulseDispatchAction::EnqueueBotMailbox { member_id, .. } if member_id == "bot-sre"))
    );
    assert!(
        promoted_plan
            .actions
            .iter()
            .any(|a| matches!(a, PulseDispatchAction::DispatchGroupStage { space_id, .. } if space_id == "space-war-room"))
    );
    assert!(
        promoted_plan
            .actions
            .iter()
            .any(|a| matches!(a, PulseDispatchAction::CreateUserInteraction { .. }))
    );
    assert!(
        promoted_plan
            .actions
            .iter()
            .any(|a| matches!(a, PulseDispatchAction::StartOrResumeWorkflow { workflow_id, .. } if workflow_id == "wf-hotfix"))
    );
    assert!(
        promoted_plan
            .actions
            .iter()
            .any(|a| matches!(a, PulseDispatchAction::EnqueueOutbox { .. }))
    );

    // Double-promoting the same candidate is atomically rejected
    assert!(matches!(
        engine
            .promote_observed_candidate(&candidate_id, true, now + Duration::seconds(6))
            .await,
        Err(PulseError::NotFound(_))
    ));

    let updated_rule = engine
        .store()
        .get_rule(&observe_rule.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(updated_rule.spec.eval_mode, PulseEvalMode::Auto);

    // 3. Follow-up comment on `jira:CORE-99` (which does NOT match `jira.issue.created` Gate filter!)
    //    automatically fans out in O(1) via `pulse_thread_subscriptions` to `sess-42` and `bot-sre`!
    let comment_env = sample_envelope(
        "d-followup-1",
        "jira.issue.commented",
        Some("jira:CORE-99"),
        json!({ "body": "Stacktrace attached on ticket" }),
    );
    let followup_out = engine
        .ingest_event(comment_env, now + Duration::seconds(15))
        .await
        .unwrap();
    assert_eq!(followup_out.subscription_hits.len(), 2);
    assert_eq!(followup_out.dispatch_plan.actions.len(), 2);

    // 4. BotTurnMailbox single-flight FIFO serial behavior on `bot-sre` (currently has 2 queued items):
    let first_claim = engine
        .claim_next_bot_turn("bot-sre", now + Duration::seconds(20))
        .await
        .unwrap()
        .expect("claim 1st FIFO bot turn");
    assert_eq!(first_claim.primary.prompt_text, "Triage CORE-99");
    assert!(first_claim.coalesced_items.is_empty());

    // While first turn is in-flight ('claimed'), a concurrent claim MUST return None (single-flight)!
    let blocked_claim = engine
        .claim_next_bot_turn("bot-sre", now + Duration::seconds(21))
        .await
        .unwrap();
    assert!(blocked_claim.is_none());

    // Completing the first turn unlocks the second FIFO item!
    engine
        .store()
        .complete_bot_turn(&first_claim.primary.id)
        .await
        .unwrap();
    let second_claim = engine
        .claim_next_bot_turn("bot-sre", now + Duration::seconds(22))
        .await
        .unwrap()
        .expect("claim 2nd FIFO bot turn");
    assert!(
        second_claim
            .primary
            .prompt_text
            .contains("Stacktrace attached")
    );

    // 5. BotTurnMailbox `CoalesceBatch` merges concurrent queued items per `member_id` into one turn:
    for idx in 1..=3 {
        engine
            .store()
            .enqueue_bot_mailbox(&PulseBotMailboxItem {
                id: format!("batch-item-{idx}"),
                member_id: "bot-digest".to_string(),
                conversation_scope: BotConversationScope::FixedPrimary,
                mailbox_policy: BotMailboxPolicy::CoalesceBatch,
                thread_key: Some("feishu:chat:ops".to_string()),
                event_id: format!("ev-b-{idx}"),
                prompt_text: format!("Alert #{idx}"),
                status: "queued".to_string(),
                created_at: (now + Duration::seconds(30 + idx)).to_rfc3339(),
                claimed_at: None,
            })
            .await
            .unwrap();
    }

    let coalesced = engine
        .claim_next_bot_turn("bot-digest", now + Duration::seconds(40))
        .await
        .unwrap()
        .expect("claim coalesced batch");
    assert_eq!(coalesced.primary.id, "batch-item-1");
    assert_eq!(coalesced.coalesced_items.len(), 2);
    assert_eq!(
        coalesced.combined_prompt,
        "Alert #1\n\n---\n\nAlert #2\n\n---\n\nAlert #3"
    );

    // 6. Signed Standard Webhook ingestion + Captured Event history + Deck Snapshot
    let hook_body = br#"{"type":"deploy.completed","data":{"threadKey":"ops:rel-1"}}"#;
    let hook_ts = (now + Duration::seconds(50)).timestamp();
    let hook_sig = sign_standard_webhook(&secret, "wh-deliv-99", hook_ts, hook_body).unwrap();
    let hook_out = engine
        .ingest_standard_webhook(
            "src-hook-1",
            StandardWebhookHeaders {
                webhook_id: "wh-deliv-99",
                webhook_timestamp: &hook_ts.to_string(),
                webhook_signature: &hook_sig,
            },
            hook_body,
            None,
            now + Duration::seconds(50),
        )
        .await
        .unwrap();
    assert!(!hook_out.duplicate_delivery);

    let captured = engine.store().list_recent_envelopes(10).await.unwrap();
    assert_eq!(captured.len(), 3); // p0_env, comment_env, webhook env

    let snapshot = engine.deck_snapshot(Some("proj-alpha")).await.unwrap();
    assert!(snapshot.engine_active);
    assert_eq!(snapshot.sources.len(), 1);
    assert_eq!(snapshot.sources[0].received_count_24h, 1);
    assert_eq!(snapshot.rules.len(), 1);
    assert_eq!(snapshot.active_ticket_count, 2);
    assert_eq!(snapshot.pending_user_interaction_count, 1);
    assert!(snapshot.observed_candidates.is_empty()); // candidate was promoted!
}

#[tokio::test]
async fn engine_tick_temporal_outbox_retry_and_event_schema_catalog_work_end_to_end() {
    let pool = memory_pool().await;
    let engine = PulseEngine::new(pool);
    let t0 = Utc.with_ymd_and_hms(2026, 11, 16, 15, 0, 0).unwrap();

    // 1. Save a `Once` temporal rule due at t0 + 30s
    let fire_at = (t0 + Duration::seconds(30)).to_rfc3339();
    let once_rule = engine
        .save_rule(
            Some("rule-once-1".to_string()),
            true,
            MandateOrigin::ExplicitHuman,
            PulseRuleSpec {
                name: "Delayed Reminder".to_string(),
                description: None,
                project_id: None,
                workspace_id: None,
                eval_mode: PulseEvalMode::Auto,
                orchestrator: PresetOrchestratorKind::DirectReflex,
                filter: GateFilterAst {
                    event_types: vec!["time.once.fired".to_string()],
                    ..GateFilterAst::default()
                },
                temporal: Some(PulseTemporalSpec::Once { fire_at }),
                debounce_ms: 0,
                claim_exclusive: false,
                targets: vec![minimal_session_target("Wake up for {{event.type}}")],
                callback: None, task_meta: None,
            },
            None,
            t0,
        )
        .await
        .unwrap();
    assert!(once_rule.enabled);
    assert!(once_rule.next_fire_at.is_some());

    // 2. Save an `InactivitySla` rule watching `github:acme/vibex#` with 60s SLA
    engine
        .save_rule(
            Some("rule-pr-sla".to_string()),
            true,
            MandateOrigin::ExplicitHuman,
            PulseRuleSpec {
                name: "PR Review 60s SLA".to_string(),
                description: None,
                project_id: None,
                workspace_id: None,
                eval_mode: PulseEvalMode::Auto,
                orchestrator: PresetOrchestratorKind::EventSaga,
                filter: GateFilterAst {
                    event_types: vec!["time.sla.expired".to_string()],
                    ..GateFilterAst::default()
                },
                temporal: Some(PulseTemporalSpec::InactivitySla {
                    thread_key_prefix: "github:acme/vibex#".to_string(),
                    timeout_seconds: 60,
                    expected_event_types: vec!["github.pr.review_submitted".to_string()],
                }),
                debounce_ms: 0,
                claim_exclusive: false,
                targets: vec![minimal_session_target("Escalate stalled PR {{threadKey}}")],
                callback: None, task_meta: None,
            },
            None,
            t0,
        )
        .await
        .unwrap();

    // Arm the PR SLA by ingesting `github.pr.opened`
    engine
        .ingest_event(
            sample_envelope(
                "d-pr-open",
                "github.pr.opened",
                Some("github:acme/vibex#12"),
                json!({}),
            ),
            t0,
        )
        .await
        .unwrap();
    assert_eq!(engine.armed_sla_count(), 1);

    // Tick at t0 + 30s -> `Once` fires & auto-disables; PR SLA still has 30s remaining
    let tick_1 = engine
        .tick_temporal(t0 + Duration::seconds(30), |_| false)
        .await
        .unwrap();
    assert_eq!(tick_1.emitted_events.len(), 1);
    assert_eq!(tick_1.emitted_events[0].event_type, "time.once.fired");
    assert_eq!(tick_1.outcomes[0].dispatch_plan.actions.len(), 1);

    let reloaded_once = engine
        .store()
        .get_rule(&once_rule.id)
        .await
        .unwrap()
        .unwrap();
    assert!(!reloaded_once.enabled);
    assert!(reloaded_once.next_fire_at.is_none());

    // Tick at t0 + 61s -> `InactivitySla` expires and triggers escalation target!
    let tick_2 = engine
        .tick_temporal(t0 + Duration::seconds(61), |_| false)
        .await
        .unwrap();
    assert_eq!(tick_2.emitted_events.len(), 1);
    assert_eq!(tick_2.emitted_events[0].event_type, "time.sla.expired");
    assert_eq!(tick_2.outcomes[0].dispatch_plan.actions.len(), 1);
    assert_eq!(engine.armed_sla_count(), 0);

    // 3. Outbox deduplication, claim, failure backoff requeue, and delivery
    let inserted = engine
        .store()
        .enqueue_outbox(
            "ob-1",
            "dedupe:feishu:msg-1",
            "feishu_reply",
            &json!({ "text": "Working on it" }),
            &t0.to_rfc3339(),
        )
        .await
        .unwrap();
    assert!(inserted);
    let duplicate = engine
        .store()
        .enqueue_outbox(
            "ob-2",
            "dedupe:feishu:msg-1",
            "feishu_reply",
            &json!({ "text": "Working on it" }),
            &t0.to_rfc3339(),
        )
        .await
        .unwrap();
    assert!(!duplicate);

    let claimed = engine
        .store()
        .claim_due_outbox(&t0.to_rfc3339(), 10)
        .await
        .unwrap();
    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0].attempts, 1);

    let retry_at = (t0 + Duration::seconds(15)).to_rfc3339();
    engine
        .store()
        .mark_outbox_failed(
            "ob-1",
            "429 rate limited",
            Some(&retry_at),
            &t0.to_rfc3339(),
        )
        .await
        .unwrap();
    assert!(
        engine
            .store()
            .claim_due_outbox(&(t0 + Duration::seconds(10)).to_rfc3339(), 10)
            .await
            .unwrap()
            .is_empty()
    );
    let reclaimed = engine
        .store()
        .claim_due_outbox(&retry_at, 10)
        .await
        .unwrap();
    assert_eq!(reclaimed.len(), 1);
    assert_eq!(reclaimed[0].attempts, 2);
    engine
        .store()
        .mark_outbox_delivered("ob-1", &retry_at)
        .await
        .unwrap();

    // 4. Event Schema catalog CRUD
    let schema_view = engine
        .store()
        .upsert_event_schema(
            "ci.coverage.dropped",
            "Emitted when test coverage drops below threshold",
            &json!({
                "type": "object",
                "required": ["deltaPct"],
                "properties": { "deltaPct": { "type": "number" } }
            }),
            false,
            &t0.to_rfc3339(),
        )
        .await
        .unwrap();
    assert_eq!(schema_view.event_type, "ci.coverage.dropped");
    assert_eq!(engine.store().list_event_schemas().await.unwrap().len(), 1);
}
