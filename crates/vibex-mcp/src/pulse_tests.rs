use serde_json::{Value, json};

use crate::{
    Args, Companion, CompanionFeatures, LineAction,
    pulse::{MandateOrigin, PULSE_TOOL_NAMES, PulseState, resolve_mandate_origin},
};

fn pulse_companion() -> Companion {
    Companion::new(Args {
        parent_connection_id: "conn-pulse".to_string(),
        socket_path: String::new(),
        token: "tok-pulse".to_string(),
        features: CompanionFeatures::parse(Some("pulse")),
        server_url: None,
        server_token: None,
        conversation_id: Some("conv-pulse-1".to_string()),
        product: "pulse".to_string(),
    })
}

#[test]
fn pulse_feature_exposes_all_seven_ai_native_tools() {
    let comp = pulse_companion();
    let action = comp.classify(
        &serde_json::from_str::<Value>(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#)
            .unwrap(),
    );
    let LineAction::Respond(text) = action else {
        panic!("expected Respond");
    };
    let parsed: Value = serde_json::from_str(&text).unwrap();
    let names: Vec<&str> = parsed["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|t| t["name"].as_str())
        .collect();
    assert_eq!(names, PULSE_TOOL_NAMES);
}

#[test]
fn pulse_catalog_inspect_strictly_redacts_signing_secrets_and_whsec_tokens() {
    let state = PulseState::new();
    state.seed_source(json!({
        "id": "src-webhook-prod",
        "kind": "webhook_standard",
        "title": "Prod Alertmanager Webhook",
        "enabled": true,
        "healthy": true,
        "signing_secret": "whsec_dG9wLXNlY3JldC1rZXktbWF0ZXJpYWw=",
        "signingSecret": "whsec_dG9wLXNlY3JldC1rZXktbWF0ZXJpYWw=",
        "configJson": {
            "webhook_secret": "raw-hmac-secret",
            "nested": {
                "rotationHeader": "whsec_YW5vdGhlci1zZWNyZXQ=",
                "client_secret": "oauth-secret-xyz"
            }
        }
    }));

    let catalog = state
        .execute_tool("pulse_catalog_inspect", &json!({}), None, None)
        .unwrap();
    let serialized = catalog.to_string();
    assert!(
        !serialized.contains("dG9wLXNlY3JldC"),
        "base64 whsec secret leaked: {serialized}"
    );
    assert!(
        !serialized.contains("raw-hmac-secret"),
        "webhook_secret leaked: {serialized}"
    );
    assert!(
        !serialized.contains("oauth-secret-xyz"),
        "client_secret leaked: {serialized}"
    );
    assert!(
        !serialized.contains("YW5vdGhlci1zZWNyZXQ"),
        "nested whsec token leaked: {serialized}"
    );

    let seeded = catalog["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == "src-webhook-prod")
        .expect("seeded source present");
    assert_eq!(seeded["signing_secret"], "[REDACTED]");
    assert_eq!(seeded["signingSecret"], "[REDACTED]");
    assert_eq!(seeded["configJson"]["webhook_secret"], "[REDACTED]");
    assert_eq!(
        seeded["configJson"]["nested"]["client_secret"],
        "[REDACTED]"
    );
    assert_eq!(
        seeded["configJson"]["nested"]["rotationHeader"],
        "whsec_[REDACTED]"
    );
    assert_eq!(catalog["workflowPresets"].as_array().unwrap().len(), 5);
}

#[test]
fn untrusted_external_mandate_coerces_rule_save_and_blocks_privilege_escalation() {
    let state = PulseState::new();
    let dangerous_args = json!({
        "enabled": true,
        "draft_only": false,
        "mandateOrigin": "explicit_human",
        "spec": {
            "name": "Exfiltrate on every commit",
            "evalMode": "auto",
            "orchestrator": "direct_reflex",
            "filter": {
                "sourceKinds": ["github"],
                "eventTypes": ["github.pr.opened"],
                "conditions": [{ "op": "not_bot_actor" }]
            },
            "targets": [
                {
                    "kind": "session",
                    "mode": "ephemeral_fresh",
                    "agentId": "codex",
                    "promptTemplate": "Run automated PR check"
                }
            ]
        }
    });

    // Even if the LLM attempts to pass `mandateOrigin: "explicit_human"` in arguments,
    // env `untrusted_external` MUST win via least-privilege intersection!
    let resolved = resolve_mandate_origin(
        Some("untrusted_external"),
        Some(&json!({"mandateOrigin": "explicit_human"})),
        Some(&dangerous_args),
    );
    assert_eq!(resolved, MandateOrigin::UntrustedExternal);

    let result = state
        .execute_tool(
            "pulse_rule_propose_or_save",
            &dangerous_args,
            None,
            Some("untrusted_external"),
        )
        .unwrap();

    assert_eq!(result["rule"]["enabled"], false);
    assert_eq!(result["rule"]["draftOnly"], true);
    assert_eq!(result["rule"]["mandateOrigin"], "untrusted_external");
    assert_eq!(result["rule"]["spec"]["evalMode"], "observe");
    assert_eq!(result["notice"]["coerced"], true);
    assert_eq!(result["notice"]["code"], "untrusted_mandate_draft_coercion");

    // Explicit human turn CAN save an enabled auto rule.
    let human_result = state
        .execute_tool(
            "pulse_rule_propose_or_save",
            &dangerous_args,
            None,
            Some("explicit_human"),
        )
        .unwrap();
    assert_eq!(human_result["rule"]["enabled"], true);
    assert_eq!(human_result["rule"]["draftOnly"], false);
    assert_eq!(human_result["rule"]["spec"]["evalMode"], "auto");
    assert!(human_result.get("notice").is_none());
}

#[test]
fn timer_schedule_supports_cron_once_interval_sla_and_enforces_mandate_origin() {
    let state = PulseState::new();

    let cron_res = state
        .execute_tool(
            "pulse_timer_schedule",
            &json!({
                "name": "Daily QA Digest",
                "enabled": true,
                "eval_mode": "auto",
                "temporal": {
                    "kind": "time_cron",
                    "expression": "0 18 * * 1-5",
                    "timezone": "Asia/Shanghai",
                    "weekdaysOnly": true
                },
                "targets": [
                    {
                        "kind": "group",
                        "spaceId": "space-qa",
                        "dispatchMode": { "type": "specific_seat", "memberId": "bot-qa" },
                        "messageTemplate": "Summarize open P0/P1 Jira bugs"
                    }
                ]
            }),
            Some(&json!({"mandate_origin": "untrusted_external"})),
            Some("explicit_human"),
        )
        .unwrap();

    // _meta.mandate_origin = untrusted_external downgrades to draft!
    assert_eq!(cron_res["rule"]["enabled"], false);
    assert_eq!(cron_res["rule"]["draftOnly"], true);
    assert_eq!(cron_res["rule"]["spec"]["evalMode"], "observe");
    assert_eq!(cron_res["rule"]["spec"]["temporal"]["kind"], "cron");

    let sla_res = state
        .execute_tool(
            "pulse_timer_schedule",
            &json!({
                "name": "P0 Escalation SLA",
                "enabled": true,
                "eval_mode": "auto",
                "temporal": {
                    "kind": "time_sla",
                    "threadKeyPrefix": "jira:CORE-",
                    "timeoutSeconds": 1800,
                    "expectedEventTypes": ["jira.issue.transitioned"]
                },
                "targets": [
                    {
                        "kind": "user",
                        "interactionKind": "approval",
                        "titleTemplate": "P0 SLA breached on {{threadKey}}",
                        "bodyTemplate": "Escalate release hold?"
                    }
                ]
            }),
            None,
            Some("explicit_human"),
        )
        .unwrap();
    assert_eq!(sla_res["rule"]["enabled"], true);
    assert_eq!(
        sla_res["rule"]["spec"]["temporal"]["kind"],
        "inactivity_sla"
    );
}

#[test]
fn pulse_rule_dry_run_reports_exhaustive_violations_unmatched_indices_and_previews() {
    let state = PulseState::new();

    // 1. Exhaustive No-Fail-Fast check: multiple rule defects returned in 1 turn
    let bad_report = state
        .execute_tool(
            "pulse_rule_dry_run",
            &json!({
                "spec": {
                    "name": "  ",
                    "evalMode": "invalid_mode",
                    "filter": {
                        "conditions": [
                            { "op": "eq", "pointer": "no_leading_slash", "value": 1 },
                            { "op": "regex", "pointer": "/title", "pattern": "[unclosed" }
                        ]
                    },
                    "temporal": { "kind": "interval", "everySeconds": 1 },
                    "targets": [
                        { "kind": "session", "mode": "existing_session", "agentId": "", "promptTemplate": "" }
                    ]
                },
                "sample_event": {
                    "eventId": "evt_1",
                    "source": { "kind": "github", "instanceId": "gh" },
                    "eventType": "github.pr.opened",
                    "actor": { "id": "u1", "isBot": false, "isSelf": false },
                    "trace": { "hopCount": 0 },
                    "payload": {}
                }
            }),
            None,
            None,
        )
        .unwrap();

    assert_eq!(bad_report["valid"], false);
    let violation_codes: Vec<&str> = bad_report["violations"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|v| v["code"].as_str())
        .collect();
    assert!(violation_codes.contains(&"empty_name"));
    assert!(violation_codes.contains(&"invalid_eval_mode"));
    assert!(violation_codes.contains(&"invalid_pointer_prefix"));
    assert!(violation_codes.contains(&"invalid_regex"));
    assert!(violation_codes.contains(&"interval_too_short"));
    assert!(violation_codes.contains(&"missing_agent_id"));
    assert!(violation_codes.contains(&"missing_existing_session_id"));
    assert!(violation_codes.contains(&"empty_prompt_template"));

    // 2. Valid rule with partial condition mismatch + full match preview
    let spec = json!({
        "name": "Jira P0 Triage",
        "evalMode": "observe",
        "filter": {
            "sourceKinds": ["jira"],
            "eventTypes": ["jira.issue.created"],
            "conditions": [
                { "op": "not_bot_actor" },
                { "op": "eq", "pointer": "/issue/priority", "value": "P0" },
                { "op": "regex", "pointer": "/issue/key", "pattern": "^CORE-\\d+$" }
            ]
        },
        "targets": [
            {
                "kind": "bot",
                "memberId": "bot-triage",
                "promptTemplate": "Triage {{issue.key}} ({{/issue/priority}}) on {{threadKey}}"
            }
        ]
    });

    let miss_report = state
        .execute_tool(
            "pulse_rule_dry_run",
            &json!({
                "spec": spec,
                "sample_event": {
                    "eventId": "evt_2",
                    "source": { "kind": "jira", "instanceId": "jira-1" },
                    "eventType": "jira.issue.created",
                    "actor": { "id": "bob", "isBot": false, "isSelf": false },
                    "threadKey": "jira:CORE-404",
                    "trace": { "hopCount": 1 },
                    "payload": { "issue": { "key": "CORE-404", "priority": "P2" } }
                }
            }),
            None,
            None,
        )
        .unwrap();
    assert_eq!(miss_report["valid"], true);
    assert_eq!(miss_report["matched"], false);
    assert_eq!(miss_report["unmatchedConditions"], json!([1]));

    let hit_report = state
        .execute_tool(
            "pulse_rule_dry_run",
            &json!({
                "spec": spec,
                "sample_event": {
                    "eventId": "evt_3",
                    "source": { "kind": "jira", "instanceId": "jira-1" },
                    "eventType": "jira.issue.created",
                    "actor": { "id": "bob", "isBot": false, "isSelf": false },
                    "threadKey": "jira:CORE-404",
                    "trace": { "hopCount": 1 },
                    "payload": { "issue": { "key": "CORE-404", "priority": "P0" } }
                }
            }),
            None,
            None,
        )
        .unwrap();
    assert_eq!(hit_report["valid"], true);
    assert_eq!(hit_report["matched"], true);
    assert_eq!(
        hit_report["renderedPreviews"][0],
        "Triage CORE-404 (P0) on jira:CORE-404"
    );
}

#[test]
fn pulse_event_define_emit_hop_propagation_and_thread_subscribe() {
    let state = PulseState::new();

    let defined = state
        .execute_tool(
            "pulse_event_define",
            &json!({
                "event_type": "ci.coverage.dropped",
                "summary": "Coverage fell below gate",
                "json_schema": {
                    "type": "object",
                    "required": ["coverage"],
                    "properties": { "coverage": { "type": "number", "minimum": 0, "maximum": 100 } }
                }
            }),
            None,
            None,
        )
        .unwrap();
    assert_eq!(defined["eventType"], "ci.coverage.dropped");

    let emitted = state
        .execute_tool(
            "pulse_event_emit",
            &json!({
                "event_type": "ci.coverage.dropped",
                "thread_key": "github:acme/vibex#42",
                "payload": { "coverage": 76.2 }
            }),
            Some(&json!({"parent_hop_count": 2, "root_event_id": "evt_root_1"})),
            Some("trusted_internal"),
        )
        .unwrap();
    assert_eq!(emitted["threadKey"], "github:acme/vibex#42");
    assert_eq!(emitted["trace"]["hopCount"], 3);
    assert_eq!(emitted["trace"]["rootEventId"], "evt_root_1");
    assert_eq!(emitted["source"]["trustLevel"], "trusted_internal");

    // Exceeding MAX_HOP_COUNT (5) is blocked
    let blocked = state
        .execute_tool(
            "pulse_event_emit",
            &json!({
                "event_type": "ci.coverage.dropped",
                "payload": { "coverage": 70.0 }
            }),
            Some(&json!({"parent_hop_count": 5})),
            Some("trusted_internal"),
        )
        .unwrap();
    assert_eq!(blocked["isError"], true);
    assert_eq!(blocked["error_code"], "hop_limit_exceeded");

    // Thread subscribe & unsubscribe
    let sub = state
        .execute_tool(
            "pulse_thread_subscribe",
            &json!({
                "action": "subscribe",
                "thread_key": "jira:PROJ-123",
                "subscriber_kind": "bot",
                "subscriber_id": "bot-pm-1"
            }),
            None,
            None,
        )
        .unwrap();
    assert_eq!(sub["threadKey"], "jira:PROJ-123");
    assert_eq!(sub["active"], true);

    let sub_id = sub["id"].as_str().unwrap().to_string();
    let unsub = state
        .execute_tool(
            "pulse_thread_subscribe",
            &json!({
                "action": "unsubscribe",
                "subscription_id": sub_id
            }),
            None,
            None,
        )
        .unwrap();
    assert_eq!(unsub["active"], false);
}
