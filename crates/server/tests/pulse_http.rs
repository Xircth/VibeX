use axum::{
    body::{Body, to_bytes},
    http::{Method, Request, StatusCode},
};
use base64::Engine as _;
use chrono::Utc;
use pulse::{MAX_WEBHOOK_PAYLOAD_BYTES, sign_standard_webhook};
use remote_protocol::{CommandRequest, OperationId};
use serde_json::{Value, json};
use server::{HeadlessServer, ServerBootstrapConfig, ServerToken};
use tempfile::TempDir;
use tower::ServiceExt as _;

const TEST_TOKEN: &str = "pulse-integration-test-secret-token-0123456789abcdef";

async fn send_json(
    router: axum::Router,
    method: Method,
    uri: &str,
    bearer: Option<&str>,
    extra_headers: &[(&str, &str)],
    body_bytes: Vec<u8>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    if !body_bytes.is_empty() {
        builder = builder.header("content-type", "application/json");
    }
    if let Some(token) = bearer {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    for (k, v) in extra_headers {
        builder = builder.header(*k, *v);
    }
    let req = builder
        .body(Body::from(body_bytes))
        .expect("build HTTP request");
    let resp = router.oneshot(req).await.expect("execute oneshot request");
    let status = resp.status();
    let bytes = to_bytes(resp.into_body(), 2 * 1024 * 1024)
        .await
        .expect("read response body");
    let json_body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({ "raw": String::from_utf8_lossy(&bytes) }))
    };
    (status, json_body)
}

async fn call_host_command(
    router: axum::Router,
    command: &str,
    args: Value,
) -> (StatusCode, Value) {
    let payload = serde_json::to_vec(&CommandRequest {
        operation_id: OperationId::new(),
        args,
    })
    .expect("serialize CommandRequest");
    let (status, body) = send_json(
        router,
        Method::POST,
        &format!("/api/v1/call/{command}"),
        Some(TEST_TOKEN),
        &[],
        payload,
    )
    .await;
    let data = body.get("data").cloned().unwrap_or(body);
    (status, data)
}

#[tokio::test]
async fn pulse_http_webhooks_observe_promote_dry_run_and_trust_coercion() {
    let temp = TempDir::new().expect("create tempdir");
    let token = ServerToken::new(TEST_TOKEN);
    let server = HeadlessServer::bootstrap(ServerBootstrapConfig::new(temp.path()).with_token(token))
        .await
        .expect("bootstrap HeadlessServer");
    let router = server.runtime().router();

    // 1. Upsert a Standard Webhooks source with a signing secret; verify secret is never leaked.
    let raw_secret = b"0123456789abcdef0123456789abcdef";
    let whsec = format!(
        "whsec_{}",
        base64::engine::general_purpose::STANDARD.encode(raw_secret)
    );
    let (status, source_view) = call_host_command(
        router.clone(),
        "pulse_source_upsert",
        json!({
            "id": "src-std-ci",
            "kind": "webhook_standard",
            "title": "CI Standard Webhook",
            "enabled": true,
            "signingSecret": whsec,
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "upsert source response: {source_view}");
    assert_eq!(
        source_view["publicWebhookPath"],
        "/api/pulse/webhooks/src-std-ci"
    );
    assert!(
        source_view.get("signingSecret").is_none()
            && !source_view.to_string().contains("whsec_"),
        "PulseSourceView must never leak signingSecret: {source_view}"
    );

    // 2a. Oversized webhook (> 64 KiB) -> 413 Payload Too Large before JSON decode.
    let oversized = vec![b'a'; MAX_WEBHOOK_PAYLOAD_BYTES + 128];
    let (status, _) = send_json(
        router.clone(),
        Method::POST,
        "/api/pulse/webhooks/src-std-ci",
        None,
        &[],
        oversized,
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);

    // 2b. Invalid HMAC signature -> 401 Unauthorized and rejectedCount24h increments.
    let body_bytes = br#"{"eventType":"ci.build.failed","threadKey":"pr:42","branch":"main"}"#.to_vec();
    let ts_str = Utc::now().timestamp().to_string();
    let (status, err_body) = send_json(
        router.clone(),
        Method::POST,
        "/api/pulse/webhooks/src-std-ci",
        None,
        &[
            ("webhook-id", "msg_bad_sig_1"),
            ("webhook-timestamp", &ts_str),
            ("webhook-signature", "v1,aW52YWxpZF9zaWduYXR1cmVfYnl0ZXM="),
        ],
        body_bytes.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "bad sig response: {err_body}");

    let (status, sources_after_reject) = send_json(
        router.clone(),
        Method::GET,
        "/api/pulse/sources",
        Some(TEST_TOKEN),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let std_src = sources_after_reject
        .as_array()
        .expect("sources array")
        .iter()
        .find(|s| s["id"] == "src-std-ci")
        .expect("find src-std-ci");
    assert_eq!(std_src["rejectedCount24h"], 1);

    // 2c. Valid Standard Webhooks HMAC signature -> 200 OK, replay -> duplicateDelivery: true.
    let ts = Utc::now().timestamp();
    let valid_sig = sign_standard_webhook(&whsec, "msg_valid_1", ts, &body_bytes)
        .expect("sign standard webhook");
    let valid_ts_str = ts.to_string();
    let (status, ok_resp) = send_json(
        router.clone(),
        Method::POST,
        "/api/pulse/webhooks/src-std-ci",
        None,
        &[
            ("webhook-id", "msg_valid_1"),
            ("webhook-timestamp", &valid_ts_str),
            ("webhook-signature", &valid_sig),
            ("x-pulse-event-type", "ci.build.failed"),
        ],
        body_bytes.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "valid webhook response: {ok_resp}");
    assert_eq!(ok_resp["accepted"], true);
    assert_eq!(ok_resp["duplicateDelivery"], false);

    let (status, dup_resp) = send_json(
        router.clone(),
        Method::POST,
        "/api/pulse/webhooks/src-std-ci",
        None,
        &[
            ("webhook-id", "msg_valid_1"),
            ("webhook-timestamp", &valid_ts_str),
            ("webhook-signature", &valid_sig),
            ("x-pulse-event-type", "ci.build.failed"),
        ],
        body_bytes,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(dup_resp["duplicateDelivery"], true);

    // 3. UntrustedExternal MandateOrigin coercion: requesting `auto` coerces to `observe`.
    let untrusted_rule_req = json!({
        "mandateOrigin": "untrusted_external",
        "spec": {
            "name": "Untrusted Escalation Attempt",
            "evalMode": "auto",
            "filter": {
                "sourceKinds": ["sdk_custom"],
                "eventTypes": ["deploy.requested"],
                "conditions": [
                    {
                        "op": "eq",
                        "pointer": "/payload/environment",
                        "value": "staging"
                    }
                ]
            },
            "targets": [
                {
                    "kind": "user",
                    "interactionKind": "notify",
                    "severity": "info",
                    "titleTemplate": "Deploy {{event.eventType}}",
                    "bodyTemplate": "Branch {{event.payload.branch}}"
                }
            ]
        }
    });
    let (status, coerced_rule) = send_json(
        router.clone(),
        Method::POST,
        "/api/pulse/rules",
        Some(TEST_TOKEN),
        &[],
        serde_json::to_vec(&untrusted_rule_req).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "save rule resp: {coerced_rule}");
    assert_eq!(
        coerced_rule["spec"]["evalMode"], "observe",
        "UntrustedExternal rule must be coerced from auto to observe"
    );
    assert_eq!(coerced_rule["draftOnly"], true);
    assert_eq!(coerced_rule["enabled"], false);
    let rule_id = coerced_rule["id"].as_str().expect("rule id").to_string();

    // Human explicitly enables the Observe rule from the UI / host command.
    let (status, enabled_rule) = call_host_command(
        router.clone(),
        "pulse_rule_set_enabled",
        json!({ "id": rule_id, "enabled": true }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "enable rule resp: {enabled_rule}");
    assert_eq!(enabled_rule["enabled"], true);

    // 4. Emit custom event matching the Observe rule -> creates ObservedCandidate -> Promote -> Auto!
    let emit_body = json!({
        "eventType": "deploy.requested",
        "threadKey": "release:2026-11",
        "payload": {
            "branch": "feat/pulse-event-engine",
            "environment": "staging"
        }
    });
    let (status, emitted_env) = send_json(
        router.clone(),
        Method::POST,
        "/api/pulse/events/emit",
        Some(TEST_TOKEN),
        &[],
        serde_json::to_vec(&emit_body).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "emit resp: {emitted_env}");
    assert_eq!(emitted_env["eventType"], "deploy.requested");

    let (status, deck) = call_host_command(router.clone(), "pulse_deck_snapshot", json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let candidates = deck["observedCandidates"]
        .as_array()
        .expect("observedCandidates array");
    assert_eq!(candidates.len(), 1, "expected 1 observed candidate: {deck}");
    let candidate_id = candidates[0]["id"].as_str().expect("candidate id");

    // 5. Dry-run endpoint returns deterministic PulseDryRunReport.
    let dry_run_req = json!({
        "spec": coerced_rule["spec"],
        "sampleEvent": emitted_env,
    });
    let (status, dry_report) = send_json(
        router.clone(),
        Method::POST,
        "/api/pulse/rules/dry-run",
        Some(TEST_TOKEN),
        &[],
        serde_json::to_vec(&dry_run_req).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "dry-run resp: {dry_report}");
    assert_eq!(dry_report["valid"], true);
    assert_eq!(dry_report["matched"], true);

    // 6. Promote candidate -> rule upgrades to `auto` and User notify interaction is dispatched!
    let (status, promote_resp) = send_json(
        router.clone(),
        Method::POST,
        &format!("/api/pulse/candidates/{candidate_id}/promote"),
        Some(TEST_TOKEN),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "promote resp: {promote_resp}");
    assert_eq!(promote_resp["promoted"], true);

    let (status, deck_after) = call_host_command(router, "pulse_deck_snapshot", json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let upgraded_rule = deck_after["rules"]
        .as_array()
        .expect("rules array")
        .iter()
        .find(|r| r["id"] == rule_id)
        .expect("upgraded rule");
    assert_eq!(upgraded_rule["spec"]["evalMode"], "auto");
    assert!(
        deck_after["observedCandidates"]
            .as_array()
            .expect("candidates")
            .is_empty(),
        "promoted candidate should no longer be pending"
    );
}
