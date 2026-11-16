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

    // Workflow subscriber_kind is also supported offline
    let wf_sub = state
        .execute_tool(
            "pulse_thread_subscribe",
            &json!({
                "action": "subscribe",
                "thread_key": "github:acme/vibex#77",
                "subscriber_kind": "workflow",
                "subscriber_id": "wf-ci-repair"
            }),
            None,
            None,
        )
        .unwrap();
    assert_eq!(wf_sub["subscriberKind"], "workflow");
    assert_eq!(wf_sub["active"], true);
}

#[derive(Debug, Clone)]
struct RecordedHostCommand {
    command: String,
    auth_header: Option<String>,
    args: Value,
}

async fn spawn_mock_http_host<F>(handler: F) -> (String, std::sync::Arc<std::sync::Mutex<Vec<RecordedHostCommand>>>)
where
    F: Fn(&str, &Value) -> (u16, Value) + Send + Sync + 'static,
{
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let recorded = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let recorded_clone = recorded.clone();
    let handler = std::sync::Arc::new(handler);

    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let recorded_inner = recorded_clone.clone();
            let handler_inner = handler.clone();
            tokio::spawn(async move {
                let mut buf = Vec::with_capacity(8192);
                let mut tmp = [0u8; 4096];
                let header_end = loop {
                    let n = match stream.read(&mut tmp).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => n,
                    };
                    buf.extend_from_slice(&tmp[..n]);
                    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break pos + 4;
                    }
                };

                let header_str = String::from_utf8_lossy(&buf[..header_end]).to_string();
                let mut lines = header_str.lines();
                let req_line = lines.next().unwrap_or("");
                let path = req_line.split_whitespace().nth(1).unwrap_or("");
                let mut content_len = 0usize;
                let mut auth_header = None;
                for line in lines {
                    let lower = line.to_ascii_lowercase();
                    if let Some(rest) = lower.strip_prefix("content-length:") {
                        content_len = rest.trim().parse::<usize>().unwrap_or(0);
                    } else if lower.starts_with("authorization:") {
                        auth_header = line.split_once(':').map(|(_, v)| v.trim().to_string());
                    }
                }

                while buf.len() < header_end + content_len {
                    let n = match stream.read(&mut tmp).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    };
                    buf.extend_from_slice(&tmp[..n]);
                }

                let body_slice = &buf[header_end..(header_end + content_len).min(buf.len())];
                let parsed_body: Value = serde_json::from_slice(body_slice).unwrap_or(Value::Null);
                let command = path.strip_prefix("/api/v1/call/").unwrap_or(path).to_string();
                let args = parsed_body.get("args").cloned().unwrap_or(Value::Null);

                recorded_inner
                    .lock()
                    .unwrap()
                    .push(RecordedHostCommand {
                        command: command.clone(),
                        auth_header,
                        args: args.clone(),
                    });

                let (status, payload) = handler_inner(&command, &args);
                let status_text = match status {
                    200 => "OK",
                    400 => "Bad Request",
                    404 => "Not Found",
                    422 => "Unprocessable Entity",
                    _ => "Internal Server Error",
                };
                let body_bytes = serde_json::to_vec(&payload).unwrap();
                let resp_head = format!(
                    "HTTP/1.1 {status} {status_text}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body_bytes.len()
                );
                let _ = stream.write_all(resp_head.as_bytes()).await;
                let _ = stream.write_all(&body_bytes).await;
                let _ = stream.flush().await;
            });
        }
    });

    (format!("http://{addr}"), recorded)
}

#[tokio::test]
async fn http_host_bridge_maps_all_seven_pulse_tools_to_exact_domain_commands_and_camelcase_keys() {
    let (base_url, recorded) = spawn_mock_http_host(|command, args| match command {
        "pulse_deck_snapshot" => (
            200,
            json!({
                "data": {
                    "engineActive": true,
                    "activeTicketCount": 1,
                    "pendingUserInteractionCount": 0,
                    "sources": [{
                        "id": "src-gh",
                        "kind": "github",
                        "title": "GitHub Webhook",
                        "signing_secret": "whsec_c2VjcmV0LWtleS1tYXRlcmlhbA=="
                    }],
                    "rules": [{ "id": "rule-existing" }],
                    "observedCandidates": [],
                    "subscriptions": [{
                        "id": "sub-existing",
                        "threadKey": "jira:CORE-1",
                        "subscriberKind": "bot",
                        "subscriberId": "bot-1",
                        "active": true
                    }],
                    "pendingInteractions": []
                }
            }),
        ),
        "pulse_event_schema_list" => (
            200,
            json!({
                "data": [{
                    "eventType": "ci.coverage.dropped",
                    "summary": "Coverage dropped",
                    "jsonSchema": { "type": "object" },
                    "builtIn": false,
                    "updatedAt": "2026-11-15T00:00:00Z"
                }]
            }),
        ),
        "pulse_event_schema_define" => (
            200,
            json!({
                "data": {
                    "eventType": args["eventType"],
                    "summary": args["summary"],
                    "jsonSchema": args["jsonSchema"],
                    "builtIn": false,
                    "updatedAt": "2026-11-15T00:00:00Z"
                }
            }),
        ),
        "pulse_event_emit" => (
            200,
            json!({
                "data": {
                    "eventId": "evt_host_1",
                    "deliveryId": args["input"]["deliveryId"],
                    "eventType": args["input"]["eventType"],
                    "threadKey": args["input"]["threadKey"],
                    "source": {
                        "kind": "sdk_custom",
                        "instanceId": args["input"]["sourceInstanceId"],
                        "trustLevel": "trusted_internal"
                    },
                    "payload": args["input"]["payload"]
                }
            }),
        ),
        "pulse_rule_save" => (
            200,
            json!({
                "data": {
                    "id": args["input"]["id"].as_str().unwrap_or("rule_host_saved"),
                    "revision": 1,
                    "enabled": args["input"]["enabled"],
                    "draftOnly": args["input"]["draftOnly"],
                    "mandateOrigin": args["input"]["mandateOrigin"],
                    "webhookRouteId": args["input"].get("webhookRouteId").cloned().unwrap_or(Value::Null),
                    "spec": args["input"]["spec"]
                }
            }),
        ),
        "pulse_rule_dry_run" => (
            200,
            json!({
                "data": {
                    "valid": true,
                    "matched": true,
                    "violations": [],
                    "unmatchedConditions": [],
                    "renderedPreviews": ["Host preview ok"]
                }
            }),
        ),
        "pulse_thread_subscribe" => (
            200,
            json!({
                "data": {
                    "id": "sub_host_wf_1",
                    "threadKey": args["threadKey"],
                    "subscriberKind": args["subscriberKind"],
                    "subscriberId": args["subscriberId"],
                    "active": args["active"],
                    "createdAt": "2026-11-15T00:00:00Z"
                }
            }),
        ),
        "pulse_thread_unsubscribe" => (200, json!({ "data": null })),
        other => (404, json!({ "code": "not_found", "message": format!("unexpected command {other}") })),
    })
    .await;

    let comp = Companion::new(Args {
        parent_connection_id: "conn-http".to_string(),
        socket_path: String::new(),
        token: "tok-fallback".to_string(),
        features: CompanionFeatures::parse(Some("pulse")),
        server_url: Some(base_url),
        server_token: Some("tok-host-bearer".to_string()),
        conversation_id: Some("conv-http-1".to_string()),
        product: "pulse".to_string(),
    });
    assert!(comp.uses_http());
    assert!(comp.uses_host());

    // 1. pulse_catalog_inspect -> pulse_deck_snapshot + pulse_event_schema_list (with secret redaction)
    let catalog = comp
        .execute_pulse_call(
            "pulse_catalog_inspect",
            json!({ "project_id": "proj-alpha" }),
            None,
            Some(&json!(1)),
            None,
        )
        .await
        .unwrap();
    assert_eq!(catalog["deck"]["engineActive"], true);
    assert_eq!(catalog["schemas"][0]["eventType"], "ci.coverage.dropped");
    assert_eq!(catalog["sources"][0]["signing_secret"], "[REDACTED]");
    assert_eq!(catalog["rules"][0]["id"], "rule-existing");
    assert_eq!(catalog["subscriptions"][0]["id"], "sub-existing");
    assert!(!catalog.to_string().contains("c2VjcmV0LWtleS1tYXRlcmlhbA"));

    // 2. pulse_event_define -> pulse_event_schema_define { eventType, summary, jsonSchema }
    let defined = comp
        .execute_pulse_call(
            "pulse_event_define",
            json!({
                "event_type": "release.canary.failed",
                "summary": "Canary rollout failed",
                "json_schema": { "type": "object", "required": ["service"] }
            }),
            None,
            Some(&json!(2)),
            None,
        )
        .await
        .unwrap();
    assert_eq!(defined["eventType"], "release.canary.failed");

    // 3. pulse_event_emit -> pulse_event_emit { input: { eventType, threadKey, sourceInstanceId, deliveryId, payload } }
    let emitted = comp
        .execute_pulse_call(
            "pulse_event_emit",
            json!({
                "event_type": "release.canary.failed",
                "thread_key": "jira:OPS-99",
                "source_instance_id": "ci-runner",
                "delivery_id": "dlv_explicit_1",
                "payload": { "service": "api" }
            }),
            None,
            Some(&json!(3)),
            None,
        )
        .await
        .unwrap();
    assert_eq!(emitted["eventId"], "evt_host_1");
    assert_eq!(emitted["source"]["instanceId"], "ci-runner");

    // 4. pulse_timer_schedule -> pulse_rule_save { input: { id, enabled, draftOnly, mandateOrigin, spec } }
    let timer = comp
        .execute_pulse_call(
            "pulse_timer_schedule",
            json!({
                "id": "rule-timer-1",
                "name": "Morning Triage",
                "eval_mode": "auto",
                "enabled": true,
                "temporal": {
                    "kind": "cron",
                    "expression": "0 9 * * 1-5",
                    "timezone": "UTC",
                    "weekdays_only": true
                },
                "targets": [{
                    "kind": "bot",
                    "member_id": "bot-pm",
                    "prompt_template": "Run morning triage"
                }]
            }),
            None,
            Some(&json!(4)),
            Some("explicit_human"),
        )
        .await
        .unwrap();
    assert_eq!(timer["id"], "rule-timer-1");
    assert_eq!(timer["spec"]["temporal"]["kind"], "cron");
    assert_eq!(timer["spec"]["temporal"]["weekdaysOnly"], true);

    // 5a. pulse_rule_propose_or_save with untrusted_external MandateOrigin coercion
    let coerced_rule = comp
        .execute_pulse_call(
            "pulse_rule_propose_or_save",
            json!({
                "id": "rule-untrusted-1",
                "enabled": true,
                "draft_only": false,
                "webhook_route_id": "wh-route-7",
                "spec": {
                    "name": "Untrusted Webhook Rule",
                    "evalMode": "auto",
                    "filter": { "sourceKinds": ["github"], "eventTypes": ["github.pr.opened"] },
                    "targets": [{
                        "kind": "session",
                        "agentId": "codex",
                        "promptTemplate": "Inspect PR"
                    }]
                }
            }),
            Some(&json!({ "mandate_origin": "untrusted_external" })),
            Some(&json!(5)),
            Some("explicit_human"),
        )
        .await
        .unwrap();
    assert_eq!(coerced_rule["enabled"], false);
    assert_eq!(coerced_rule["draftOnly"], true);
    assert_eq!(coerced_rule["spec"]["evalMode"], "observe");
    assert_eq!(coerced_rule["webhookRouteId"], "wh-route-7");
    assert_eq!(coerced_rule["notice"]["coerced"], true);

    // 5b. pulse_rule_propose_or_save with propose_only=true also coerces evalMode -> observe, draftOnly=true, enabled=false
    let proposed_rule = comp
        .execute_pulse_call(
            "pulse_rule_propose_or_save",
            json!({
                "id": "rule-propose-only",
                "enabled": true,
                "propose_only": true,
                "spec": {
                    "name": "Proposed Auto Rule",
                    "evalMode": "auto",
                    "filter": { "sourceKinds": ["jira"] },
                    "targets": [{
                        "kind": "bot",
                        "memberId": "bot-sre",
                        "promptTemplate": "Check Jira"
                    }]
                }
            }),
            None,
            Some(&json!(6)),
            Some("explicit_human"),
        )
        .await
        .unwrap();
    assert_eq!(proposed_rule["enabled"], false);
    assert_eq!(proposed_rule["draftOnly"], true);
    assert_eq!(proposed_rule["spec"]["evalMode"], "observe");

    // 6. pulse_rule_dry_run -> pulse_rule_dry_run { spec, sampleEvent }
    let dry_run = comp
        .execute_pulse_call(
            "pulse_rule_dry_run",
            json!({
                "spec": {
                    "name": "Dry Run Check",
                    "evalMode": "observe",
                    "filter": { "sourceKinds": ["jira"] },
                    "targets": [{ "kind": "bot", "memberId": "bot-1", "promptTemplate": "Hi" }]
                },
                "sample_event": {
                    "eventId": "evt_sample_1",
                    "source": { "kind": "jira", "instanceId": "jira-main" },
                    "eventType": "jira.issue.created",
                    "actor": { "id": "alice" },
                    "payload": { "key": "CORE-9" }
                }
            }),
            None,
            Some(&json!(7)),
            None,
        )
        .await
        .unwrap();
    assert_eq!(dry_run["matched"], true);

    // 7a. pulse_thread_subscribe (subscribe workflow) -> pulse_thread_subscribe { threadKey, subscriberKind, subscriberId, active }
    let sub_wf = comp
        .execute_pulse_call(
            "pulse_thread_subscribe",
            json!({
                "action": "subscribe",
                "thread_key": "github:acme/vibex#101",
                "subscriber_kind": "workflow",
                "subscriber_id": "wf-release-guard"
            }),
            None,
            Some(&json!(8)),
            None,
        )
        .await
        .unwrap();
    assert_eq!(sub_wf["id"], "sub_host_wf_1");
    assert_eq!(sub_wf["subscriberKind"], "workflow");

    // 7b. pulse_thread_subscribe (unsubscribe) -> pulse_thread_unsubscribe { subscriptionId }
    let unsub = comp
        .execute_pulse_call(
            "pulse_thread_subscribe",
            json!({
                "action": "unsubscribe",
                "subscription_id": "sub_host_wf_1"
            }),
            None,
            Some(&json!(9)),
            None,
        )
        .await
        .unwrap();
    assert_eq!(unsub["unsubscribed"], true);
    assert_eq!(unsub["subscriptionId"], "sub_host_wf_1");

    // Verify exact command sequence and exact camelCase keys sent over HTTP
    let calls = recorded.lock().unwrap().clone();
    let command_names: Vec<&str> = calls.iter().map(|c| c.command.as_str()).collect();
    assert_eq!(
        command_names,
        vec![
            "pulse_deck_snapshot",
            "pulse_event_schema_list",
            "pulse_event_schema_define",
            "pulse_event_emit",
            "pulse_rule_save",
            "pulse_rule_save",
            "pulse_rule_save",
            "pulse_rule_dry_run",
            "pulse_thread_subscribe",
            "pulse_thread_unsubscribe",
        ]
    );
    assert!(
        calls
            .iter()
            .all(|c| c.auth_header.as_deref() == Some("Bearer tok-host-bearer"))
    );

    assert_eq!(calls[0].args, json!({ "projectId": "proj-alpha" }));
    assert_eq!(calls[1].args, json!({}));
    assert_eq!(
        calls[2].args,
        json!({
            "eventType": "release.canary.failed",
            "summary": "Canary rollout failed",
            "jsonSchema": { "type": "object", "required": ["service"] }
        })
    );
    assert_eq!(
        calls[3].args,
        json!({
            "input": {
                "eventType": "release.canary.failed",
                "threadKey": "jira:OPS-99",
                "sourceInstanceId": "ci-runner",
                "deliveryId": "dlv_explicit_1",
                "payload": { "service": "api" }
            }
        })
    );
    assert!(calls[4].args["input"].get("draftOnly").is_some());
    assert!(calls[4].args["input"].get("mandateOrigin").is_some());
    assert!(calls[4].args["input"]["spec"].get("temporal").is_some());
    assert_eq!(calls[5].args["input"]["enabled"], false);
    assert_eq!(calls[5].args["input"]["draftOnly"], true);
    assert_eq!(calls[5].args["input"]["webhookRouteId"], "wh-route-7");
    assert_eq!(calls[5].args["input"]["spec"]["evalMode"], "observe");
    assert_eq!(calls[6].args["input"]["enabled"], false);
    assert_eq!(calls[6].args["input"]["draftOnly"], true);
    assert_eq!(calls[6].args["input"]["spec"]["evalMode"], "observe");
    assert!(calls[7].args.get("spec").is_some());
    assert!(calls[7].args.get("sampleEvent").is_some());
    assert!(calls[7].args.get("rule").is_none());
    assert!(calls[7].args.get("event").is_none());
    assert_eq!(
        calls[8].args,
        json!({
            "threadKey": "github:acme/vibex#101",
            "subscriberKind": "workflow",
            "subscriberId": "wf-release-guard",
            "active": true
        })
    );
    assert_eq!(calls[9].args, json!({ "subscriptionId": "sub_host_wf_1" }));
}

#[tokio::test]
async fn http_host_400_validation_errors_propagate_as_real_mcp_errors_never_swallowed() {
    let (base_url, recorded) = spawn_mock_http_host(|command, _args| {
        (
            400,
            json!({
                "code": "bad_request",
                "message": format!("Host validation rejected `{command}`: unknown target memberId"),
                "detail": {
                    "violations": [
                        {
                            "path": "targets[0].memberId",
                            "code": "unknown_bot_member",
                            "message": "Bot member `bot-missing` does not exist in workspace"
                        }
                    ]
                }
            }),
        )
    })
    .await;

    let comp = Companion::new(Args {
        parent_connection_id: "conn-err".to_string(),
        socket_path: String::new(),
        token: "tok-err".to_string(),
        features: CompanionFeatures::parse(Some("pulse")),
        server_url: Some(base_url),
        server_token: Some("tok-err".to_string()),
        conversation_id: Some("conv-err".to_string()),
        product: "pulse".to_string(),
    });

    let outcome = comp
        .execute_pulse_call(
            "pulse_rule_propose_or_save",
            json!({
                "enabled": true,
                "spec": {
                    "name": "Invalid Bot Rule",
                    "evalMode": "observe",
                    "filter": { "sourceKinds": ["github"] },
                    "targets": [{
                        "kind": "bot",
                        "memberId": "bot-missing",
                        "promptTemplate": "Triage issue"
                    }]
                }
            }),
            None,
            Some(&json!(1)),
            Some("explicit_human"),
        )
        .await
        .unwrap();

    let rendered = crate::render_result(&outcome);
    assert_eq!(rendered["isError"], true);
    assert_eq!(outcome["isError"], true);
    assert_eq!(outcome["status"], 400);
    assert_eq!(outcome["error_code"], "bad_request");
    assert!(
        rendered["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Host validation rejected `pulse_rule_save`: unknown target memberId")
    );
    assert_eq!(
        outcome["violations"][0]["code"],
        "unknown_bot_member",
        "Exact Host violations must be preserved for Agent self-repair"
    );
    assert_eq!(recorded.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn desktop_socket_ipc_routes_all_seven_pulse_tools_to_host_and_propagates_errors() {
    use delegation_proto::{BrokerMessage, BrokerResponse, read_frame, write_frame};

    let recorded: std::sync::Arc<std::sync::Mutex<Vec<(String, Value)>>> =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let recorded_srv = recorded.clone();

    let handle_broker_msg = move |msg: BrokerMessage| -> BrokerResponse {
        let BrokerMessage::Collaborate(req) = msg else {
            return BrokerResponse::Error {
                code: "unexpected_variant".to_string(),
                message: "Expected BrokerMessage::Collaborate".to_string(),
            };
        };
        recorded_srv
            .lock()
            .unwrap()
            .push((req.name.clone(), req.arguments.clone()));

        if req.name == "pulse_event_schema_define"
            && req.arguments.get("summary").and_then(Value::as_str) == Some("TRIGGER_HOST_ERROR")
        {
            return BrokerResponse::Payload(json!({
                "isError": true,
                "error_code": "schema_conflict",
                "message": "Built-in schema cannot be overwritten on Host",
                "violations": [{ "path": "eventType", "code": "builtin_immutable", "message": "Built-in event schema is immutable" }]
            }));
        }

        let payload = match req.name.as_str() {
            "pulse_deck_snapshot" => json!({
                "engineActive": true,
                "sources": [{ "id": "src-sock", "webhook_secret": "sock-secret-123" }],
                "rules": [],
                "subscriptions": []
            }),
            "pulse_event_schema_list" => json!([]),
            "pulse_event_schema_define" => json!({
                "eventType": req.arguments["eventType"],
                "summary": req.arguments["summary"],
                "jsonSchema": req.arguments["jsonSchema"],
                "builtIn": false
            }),
            "pulse_event_emit" => json!({
                "eventId": "evt_sock_1",
                "eventType": req.arguments["input"]["eventType"],
                "threadKey": req.arguments["input"]["threadKey"]
            }),
            "pulse_rule_save" => json!({
                "id": "rule_sock_1",
                "enabled": req.arguments["input"]["enabled"],
                "draftOnly": req.arguments["input"]["draftOnly"],
                "spec": req.arguments["input"]["spec"]
            }),
            "pulse_rule_dry_run" => json!({
                "valid": true,
                "matched": true,
                "violations": [],
                "unmatchedConditions": [],
                "renderedPreviews": ["Socket preview"]
            }),
            "pulse_thread_subscribe" => json!({
                "id": "sub_sock_1",
                "threadKey": req.arguments["threadKey"],
                "subscriberKind": req.arguments["subscriberKind"],
                "subscriberId": req.arguments["subscriberId"],
                "active": true
            }),
            "pulse_thread_unsubscribe" => Value::Null,
            other => {
                return BrokerResponse::Error {
                    code: "unknown_command".to_string(),
                    message: format!("Unknown socket command {other}"),
                };
            }
        };
        BrokerResponse::Payload(payload)
    };

    #[cfg(windows)]
    let socket_path = {
        use tokio::net::windows::named_pipe::ServerOptions;
        let path = format!(
            r"\\.\pipe\vibex-pulse-sock-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        );
        let path_srv = path.clone();
        let mut server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&path_srv)
            .unwrap();
        tokio::spawn(async move {
            loop {
                if server.connect().await.is_err() {
                    break;
                }
                let mut connected = server;
                let Ok(next_server) = ServerOptions::new().create(&path_srv) else {
                    break;
                };
                server = next_server;
                let handler = handle_broker_msg.clone();
                tokio::spawn(async move {
                    if let Ok(msg) = read_frame::<_, BrokerMessage>(&mut connected).await {
                        let resp = handler(msg);
                        let _ = write_frame(&mut connected, &resp).await;
                        let _ = tokio::io::AsyncWriteExt::flush(&mut connected).await;
                    }
                });
            }
        });
        path
    };

    #[cfg(unix)]
    let socket_path = {
        let path = std::env::temp_dir().join(format!(
            "vibex-pulse-sock-test-{}-{}.sock",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let _ = std::fs::remove_file(&path);
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let path_str = path.to_string_lossy().to_string();
        tokio::spawn(async move {
            loop {
                let Ok((mut conn, _)) = listener.accept().await else {
                    break;
                };
                let handler = handle_broker_msg.clone();
                tokio::spawn(async move {
                    if let Ok(msg) = read_frame::<_, BrokerMessage>(&mut conn).await {
                        let resp = handler(msg);
                        let _ = write_frame(&mut conn, &resp).await;
                        let _ = tokio::io::AsyncWriteExt::flush(&mut conn).await;
                    }
                });
            }
        });
        path_str
    };

    tokio::time::sleep(std::time::Duration::from_millis(20)).await;

    let comp = Companion::new(Args {
        parent_connection_id: "conn-sock".to_string(),
        socket_path,
        token: "tok-sock".to_string(),
        features: CompanionFeatures::parse(Some("pulse")),
        server_url: None,
        server_token: None,
        conversation_id: Some("conv-sock-1".to_string()),
        product: "pulse".to_string(),
    });
    assert!(!comp.uses_http());
    assert!(comp.uses_socket());
    assert!(comp.uses_host());

    let cat = comp
        .execute_pulse_call("pulse_catalog_inspect", json!({}), None, Some(&json!(1)), None)
        .await
        .unwrap();
    assert_eq!(cat["sources"][0]["webhook_secret"], "[REDACTED]");

    let def = comp
        .execute_pulse_call(
            "pulse_event_define",
            json!({ "event_type": "build.green", "summary": "Build green", "json_schema": { "type": "object" } }),
            None,
            Some(&json!(2)),
            None,
        )
        .await
        .unwrap();
    assert_eq!(def["eventType"], "build.green");

    let emit = comp
        .execute_pulse_call(
            "pulse_event_emit",
            json!({ "event_type": "build.green", "thread_key": "github:o/r#1", "payload": {} }),
            None,
            Some(&json!(3)),
            None,
        )
        .await
        .unwrap();
    assert_eq!(emit["eventId"], "evt_sock_1");

    let timer = comp
        .execute_pulse_call(
            "pulse_timer_schedule",
            json!({
                "name": "Interval Check",
                "temporal": { "kind": "interval", "everySeconds": 60 },
                "targets": [{ "kind": "workflow", "workflowId": "wf-1", "pinnedVersion": 1 }]
            }),
            None,
            Some(&json!(4)),
            Some("explicit_human"),
        )
        .await
        .unwrap();
    assert_eq!(timer["id"], "rule_sock_1");

    let rule = comp
        .execute_pulse_call(
            "pulse_rule_propose_or_save",
            json!({
                "enabled": true,
                "spec": {
                    "name": "Socket Rule",
                    "evalMode": "observe",
                    "filter": { "sourceKinds": ["github"] },
                    "targets": [{ "kind": "workflow", "workflowId": "wf-1", "pinnedVersion": 1 }]
                }
            }),
            None,
            Some(&json!(5)),
            Some("explicit_human"),
        )
        .await
        .unwrap();
    assert_eq!(rule["id"], "rule_sock_1");

    let dry = comp
        .execute_pulse_call(
            "pulse_rule_dry_run",
            json!({
                "spec": {
                    "name": "Socket Dry",
                    "evalMode": "observe",
                    "filter": {},
                    "targets": [{ "kind": "workflow", "workflowId": "wf-1", "pinnedVersion": 1 }]
                },
                "sample_event": { "eventId": "evt_1", "payload": {} }
            }),
            None,
            Some(&json!(6)),
            None,
        )
        .await
        .unwrap();
    assert_eq!(dry["matched"], true);

    let sub = comp
        .execute_pulse_call(
            "pulse_thread_subscribe",
            json!({
                "action": "subscribe",
                "thread_key": "jira:CORE-55",
                "subscriber_kind": "workflow",
                "subscriber_id": "wf-1"
            }),
            None,
            Some(&json!(7)),
            None,
        )
        .await
        .unwrap();
    assert_eq!(sub["id"], "sub_sock_1");

    let unsub = comp
        .execute_pulse_call(
            "pulse_thread_subscribe",
            json!({ "action": "unsubscribe", "subscription_id": "sub_sock_1" }),
            None,
            Some(&json!(8)),
            None,
        )
        .await
        .unwrap();
    assert_eq!(unsub["unsubscribed"], true);

    // Socket Host validation error is surfaced as a real MCP error (`isError: true`)
    let sock_err = comp
        .execute_pulse_call(
            "pulse_event_define",
            json!({
                "event_type": "github.ci.failed",
                "summary": "TRIGGER_HOST_ERROR",
                "json_schema": { "type": "object" }
            }),
            None,
            Some(&json!(9)),
            None,
        )
        .await
        .unwrap();
    let rendered_err = crate::render_result(&sock_err);
    assert_eq!(rendered_err["isError"], true);
    assert_eq!(sock_err["error_code"], "schema_conflict");
    assert_eq!(sock_err["violations"][0]["code"], "builtin_immutable");

    let sock_names: Vec<String> = recorded
        .lock()
        .unwrap()
        .iter()
        .map(|(n, _)| n.clone())
        .collect();
    assert_eq!(
        sock_names,
        vec![
            "pulse_deck_snapshot",
            "pulse_event_schema_list",
            "pulse_event_schema_define",
            "pulse_event_emit",
            "pulse_rule_save",
            "pulse_rule_save",
            "pulse_rule_dry_run",
            "pulse_thread_subscribe",
            "pulse_thread_unsubscribe",
            "pulse_event_schema_define",
        ]
    );
}
