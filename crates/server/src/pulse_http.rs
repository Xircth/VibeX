//! `/api/pulse/*` Axum HTTP router (public webhook intake + `@vibex/pulse-sdk` REST endpoints)
//! and platform webhook signature/normalization helpers.

use std::{collections::BTreeMap, sync::Arc};

use api_types::pulse::{
    EventActor, EventEnvelope, EventSourceKind, EventSourceMeta, EventTrace, EventTrustLevel,
};
use application::{ApplicationError, ConversationRepository, Principal};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Extension, Path, State},
    http::{HeaderMap, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::Engine as _;
use chrono::Utc;
use pulse::{
    FeishuSourceNormalizer, GitHubSourceNormalizer, JiraSourceNormalizer,
    MAX_WEBHOOK_PAYLOAD_BYTES, StandardWebhookHeaders, verify_standard_webhook,
};
use remote_protocol::{ErrorCode, ErrorEnvelope, OperationId};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{AuthenticatedCredential, runtime::ServerState};

pub(crate) fn pulse_router<R>(state: Arc<ServerState<R>>) -> Router<Arc<ServerState<R>>>
where
    R: ConversationRepository + Send + Sync + 'static,
{
    let protected = Router::new()
        .route("/events/emit", post(handle_emit_event::<R>))
        .route("/schemas", post(handle_define_schema::<R>))
        .route("/sources", get(handle_list_sources::<R>))
        .route("/rules", post(handle_save_rule::<R>))
        .route("/rules/dry-run", post(handle_dry_run_rule::<R>))
        .route("/subscriptions", post(handle_subscribe_thread::<R>))
        .route(
            "/candidates/{candidate_id}/promote",
            post(handle_promote_candidate::<R>),
        )
        .route_layer(middleware::from_fn_with_state(
            state,
            crate::runtime::require_token::<R>,
        ));

    Router::new()
        .route(
            "/webhooks/{source_id}",
            post(handle_public_webhook::<R>)
                .layer(DefaultBodyLimit::max(MAX_WEBHOOK_PAYLOAD_BYTES * 2)),
        )
        .merge(protected)
}

async fn handle_public_webhook<R>(
    State(state): State<Arc<ServerState<R>>>,
    Path(source_id): Path<String>,
    headers: HeaderMap,
    raw_body: Bytes,
) -> Response
where
    R: ConversationRepository + Send + Sync + 'static,
{
    if raw_body.len() > MAX_WEBHOOK_PAYLOAD_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(ErrorEnvelope::new(
                ErrorCode::BadRequest,
                format!("webhook payload exceeds {MAX_WEBHOOK_PAYLOAD_BYTES} bytes"),
                false,
                OperationId::new(),
            )),
        )
            .into_response();
    }

    let mut header_map = BTreeMap::new();
    for (name, val) in &headers {
        if let Ok(text) = val.to_str() {
            header_map.insert(name.as_str().to_ascii_lowercase(), text.to_string());
        }
    }
    let raw_body_base64 = base64::engine::general_purpose::STANDARD.encode(&raw_body);
    let webhook_principal =
        Principal::remote("pulse-webhook-intake", [String::from("automation.write")]);
    match state
        .commands
        .execute_name(
            &webhook_principal,
            "pulse_webhook_ingest",
            OperationId::new(),
            json!({
                "sourceId": source_id,
                "headers": header_map,
                "rawBodyBase64": raw_body_base64,
            }),
        )
        .await
    {
        Ok(resp) => Json(resp.data).into_response(),
        Err(error) => crate::runtime::application_error_response(error),
    }
}

async fn run_protected_pulse_command<R>(
    state: &ServerState<R>,
    credential: &AuthenticatedCredential,
    command: &str,
    args: Value,
) -> Response
where
    R: ConversationRepository + Send + Sync + 'static,
{
    match state
        .commands
        .execute_name(&credential.principal(), command, OperationId::new(), args)
        .await
    {
        Ok(resp) => Json(resp.data).into_response(),
        Err(error) => crate::runtime::application_error_response(error),
    }
}

async fn handle_emit_event<R>(
    State(state): State<Arc<ServerState<R>>>,
    Extension(credential): Extension<AuthenticatedCredential>,
    Json(body): Json<Value>,
) -> Response
where
    R: ConversationRepository + Send + Sync + 'static,
{
    run_protected_pulse_command(&state, &credential, "pulse_event_emit", body).await
}

async fn handle_define_schema<R>(
    State(state): State<Arc<ServerState<R>>>,
    Extension(credential): Extension<AuthenticatedCredential>,
    Json(body): Json<Value>,
) -> Response
where
    R: ConversationRepository + Send + Sync + 'static,
{
    run_protected_pulse_command(&state, &credential, "pulse_event_schema_define", body).await
}

async fn handle_list_sources<R>(
    State(state): State<Arc<ServerState<R>>>,
    Extension(credential): Extension<AuthenticatedCredential>,
) -> Response
where
    R: ConversationRepository + Send + Sync + 'static,
{
    run_protected_pulse_command(&state, &credential, "pulse_source_list", json!({})).await
}

async fn handle_save_rule<R>(
    State(state): State<Arc<ServerState<R>>>,
    Extension(credential): Extension<AuthenticatedCredential>,
    Json(body): Json<Value>,
) -> Response
where
    R: ConversationRepository + Send + Sync + 'static,
{
    run_protected_pulse_command(&state, &credential, "pulse_rule_save", body).await
}

async fn handle_dry_run_rule<R>(
    State(state): State<Arc<ServerState<R>>>,
    Extension(credential): Extension<AuthenticatedCredential>,
    Json(body): Json<Value>,
) -> Response
where
    R: ConversationRepository + Send + Sync + 'static,
{
    run_protected_pulse_command(&state, &credential, "pulse_rule_dry_run", body).await
}

async fn handle_subscribe_thread<R>(
    State(state): State<Arc<ServerState<R>>>,
    Extension(credential): Extension<AuthenticatedCredential>,
    Json(body): Json<Value>,
) -> Response
where
    R: ConversationRepository + Send + Sync + 'static,
{
    run_protected_pulse_command(&state, &credential, "pulse_thread_subscribe", body).await
}

async fn handle_promote_candidate<R>(
    State(state): State<Arc<ServerState<R>>>,
    Extension(credential): Extension<AuthenticatedCredential>,
    Path(candidate_id): Path<String>,
) -> Response
where
    R: ConversationRepository + Send + Sync + 'static,
{
    run_protected_pulse_command(
        &state,
        &credential,
        "pulse_candidate_promote",
        json!({ "candidateId": candidate_id }),
    )
    .await
}

pub(crate) fn lowercase_headers(headers: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    headers
        .iter()
        .map(|(k, v)| (k.to_ascii_lowercase(), v.clone()))
        .collect()
}

pub(crate) fn verify_platform_webhook_secret(
    secret: &str,
    headers: &BTreeMap<String, String>,
    raw_body: &[u8],
    now: chrono::DateTime<Utc>,
) -> Result<(), String> {
    if headers.contains_key("webhook-signature") {
        verify_standard_webhook(
            secret,
            StandardWebhookHeaders {
                webhook_id: headers.get("webhook-id").map(String::as_str).unwrap_or(""),
                webhook_timestamp: headers
                    .get("webhook-timestamp")
                    .map(String::as_str)
                    .unwrap_or(""),
                webhook_signature: headers
                    .get("webhook-signature")
                    .map(String::as_str)
                    .unwrap_or(""),
            },
            raw_body,
            now,
        )
        .map(|_| ())
        .map_err(|err| err.to_string())
    } else if let Some(sig_header) = headers.get("x-hub-signature-256") {
        let hex_sig = sig_header
            .trim()
            .strip_prefix("sha256=")
            .ok_or_else(|| "x-hub-signature-256 must start with `sha256=`".to_string())?;
        let sig_bytes = decode_hex(hex_sig)
            .ok_or_else(|| "x-hub-signature-256 is not valid hex".to_string())?;
        let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, secret.as_bytes());
        ring::hmac::verify(&key, raw_body, &sig_bytes)
            .map_err(|_| "invalid GitHub HMAC-SHA256 signature".to_string())
    } else if let Some(token) = headers.get("x-pulse-secret") {
        let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, b"pulse-token-compare");
        let expected_tag = ring::hmac::sign(&key, secret.as_bytes());
        ring::hmac::verify(&key, token.as_bytes(), expected_tag.as_ref())
            .map_err(|_| "invalid x-pulse-secret header".to_string())
    } else {
        Err("missing webhook signature header for secret-protected source".to_string())
    }
}

fn decode_hex(hex: &str) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) {
        return None;
    }
    let mut out = Vec::with_capacity(hex.len() / 2);
    let bytes = hex.as_bytes();
    let mut idx = 0;
    while idx < bytes.len() {
        let hi = (bytes[idx] as char).to_digit(16)?;
        let lo = (bytes[idx + 1] as char).to_digit(16)?;
        out.push(((hi << 4) | lo) as u8);
        idx += 2;
    }
    Some(out)
}

pub(crate) fn normalize_platform_webhook_payload(
    source_id: &str,
    kind: EventSourceKind,
    config_json: &Value,
    headers: &BTreeMap<String, String>,
    raw: &Value,
    now: chrono::DateTime<Utc>,
) -> Result<EventEnvelope, ApplicationError> {
    match kind {
        EventSourceKind::Feishu => {
            let bot_open_id = config_json
                .get("botOpenId")
                .and_then(Value::as_str)
                .map(str::to_string);
            FeishuSourceNormalizer::new(source_id, bot_open_id)
                .normalize(raw, now)
                .map_err(|err| ApplicationError::bad_request(err.to_string()))
        }
        EventSourceKind::Jira => {
            let self_account_id = config_json
                .get("selfAccountId")
                .and_then(Value::as_str)
                .map(str::to_string);
            let delivery_override = headers
                .get("x-pulse-delivery-id")
                .or_else(|| headers.get("x-atlassian-webhook-identifier"))
                .map(String::as_str);
            JiraSourceNormalizer::new(source_id, self_account_id)
                .normalize_webhook(raw, delivery_override, now)
                .map_err(|err| ApplicationError::bad_request(err.to_string()))
        }
        EventSourceKind::Github => {
            let self_login = config_json
                .get("selfLogin")
                .and_then(Value::as_str)
                .map(str::to_string);
            let gh_event = headers
                .get("x-github-event")
                .map(String::as_str)
                .unwrap_or("issues");
            let gh_delivery = headers
                .get("x-github-delivery")
                .map(String::as_str)
                .unwrap_or("");
            GitHubSourceNormalizer::new(source_id, self_login)
                .normalize_webhook(gh_event, gh_delivery, raw, now)
                .map_err(|err| ApplicationError::bad_request(err.to_string()))
        }
        _ => {
            let event_id = Uuid::new_v4().to_string();
            let delivery_id = headers
                .get("x-pulse-delivery-id")
                .or_else(|| headers.get("webhook-id"))
                .cloned()
                .or_else(|| {
                    raw.get("deliveryId")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_else(|| event_id.clone());
            let event_type = headers
                .get("x-pulse-event-type")
                .cloned()
                .or_else(|| {
                    raw.get("eventType")
                        .or_else(|| raw.get("type"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_else(|| "webhook.custom.received".to_string());
            let thread_key = raw
                .get("threadKey")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            Ok(EventEnvelope {
                event_id: event_id.clone(),
                delivery_id,
                source: EventSourceMeta {
                    kind,
                    instance_id: source_id.to_string(),
                    trust_level: EventTrustLevel::UntrustedExternal,
                },
                event_type,
                occurred_at: now.to_rfc3339(),
                actor: EventActor {
                    id: format!("webhook:{source_id}"),
                    display_name: None,
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
                payload: raw.clone(),
            })
        }
    }
}
