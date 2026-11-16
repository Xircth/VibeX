//! Real Pulse external event connectors (`PulseSourceTest`, background GitHub Actions
//! `workflow_run` poller, and Feishu WebSocket long-connection inbound bridge).

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::Path,
    sync::{Arc, LazyLock, Mutex as StdMutex, Weak},
    time::Duration,
};

use api_types::pulse::{
    EventEnvelope, EventSourceKind, EventTrustLevel, PulseSourceTestResult,
};
use application::ApplicationError;
use base64::Engine as _;
use chrono::{DateTime, Utc};
use db::models::pulse::{PulseSourceRecord, SqlitePulseStore, ensure_pulse_schema};
use pulse::{
    CustomSdkEventInput, CustomSdkEventNormalizer, FeishuSourceNormalizer, GitHubSourceNormalizer,
    PulseEngine, StandardWebhookHeaders, sign_standard_webhook, verify_standard_webhook,
};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{
    domains::ServerApplicationDomains,
    pulse_http::{normalize_platform_webhook_payload, verify_platform_webhook_secret},
    pulse_runtime::{
        PulseWebhookIngestArgs, is_webhook_source_kind, map_pulse_error, map_sqlx_error,
        require_str_field_aliases, unwrap_input,
    },
};

const CHAT_CHANNELS_SECTION: &str = "chat_channels";
const DEFAULT_GITHUB_API_BASE: &str = "https://api.github.com";
const DEFAULT_POLL_INTERVAL_SECS: i64 = 30;
const MIN_POLL_INTERVAL_SECS: i64 = 15;

static PULSE_CONNECTOR_HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent("VibeX-Pulse/1.0")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
});

static GITHUB_LAST_POLL_EPOCH: LazyLock<StdMutex<HashMap<String, i64>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));

static PULSE_DOMAIN_HOSTS: LazyLock<StdMutex<Vec<Weak<ServerApplicationDomains>>>> =
    LazyLock::new(|| StdMutex::new(Vec::new()));

pub(crate) fn register_pulse_domain_host(domains: &Arc<ServerApplicationDomains>) {
    if let Ok(mut hosts) = PULSE_DOMAIN_HOSTS.lock() {
        hosts.retain(|weak| weak.strong_count() > 0);
        hosts.push(Arc::downgrade(domains));
    }
}

pub(crate) fn reset_github_poll_cooldown(source_id: &str) {
    if let Ok(mut map) = GITHUB_LAST_POLL_EPOCH.lock() {
        map.remove(source_id);
    }
}

/// Non-blocking bridge invoked from `chat_inbound::handle_feishu_event` on user `text`/`post`
/// messages before slash-command or group `@mention` filtering.
pub(crate) fn spawn_feishu_inbound_pulse_bridge(
    pool: SqlitePool,
    channel_id: String,
    channel_config: Value,
    event: Value,
) {
    if event.pointer("/header/event_type").and_then(Value::as_str) != Some("im.message.receive_v1")
    {
        return;
    }
    let msg_type = event
        .pointer("/event/message/message_type")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !matches!(msg_type, "text" | "post") {
        return;
    }
    if event
        .pointer("/event/sender/sender_type")
        .and_then(Value::as_str)
        .is_some_and(|t| t.eq_ignore_ascii_case("app"))
    {
        return;
    }
    let Some(message_id) = event
        .pointer("/event/message/message_id")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
    else {
        return;
    };
    let _ = message_id;

    tokio::spawn(async move {
        let _ = bridge_feishu_inbound_to_pulse(pool, channel_id, channel_config, event).await;
    });
}

/// Bridges a Feishu `im.message.receive_v1` event into any enabled Feishu `long_connection`
/// (or `bridgeChatChannel: true`) Pulse sources and executes matched rule dispatch plans.
pub async fn bridge_feishu_inbound_to_pulse(
    pool: SqlitePool,
    channel_id: String,
    channel_config: Value,
    event: Value,
) -> usize {
    if ensure_pulse_schema(&pool).await.is_err() {
        return 0;
    }
    let Some(message_id) = event
        .pointer("/event/message/message_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return 0;
    };
    if event
        .pointer("/event/sender/sender_type")
        .and_then(Value::as_str)
        .is_some_and(|t| t.eq_ignore_ascii_case("app"))
    {
        return 0;
    }

    let store = SqlitePulseStore::new(pool.clone());
    let Ok(sources) = store.list_source_records().await else {
        return 0;
    };
    let now = Utc::now();
    let now_iso = now.to_rfc3339();
    let mut ingested_count = 0usize;

    for source in sources {
        if !source.view.enabled || source.view.kind != EventSourceKind::Feishu {
            continue;
        }
        let is_long_conn = source
            .config_json
            .get("mode")
            .and_then(Value::as_str)
            == Some("long_connection");
        let bridge_flag = source
            .config_json
            .get("bridgeChatChannel")
            .and_then(Value::as_bool)
            == Some(true);
        if !is_long_conn && !bridge_flag {
            continue;
        }
        if let Some(bound_ch) = source
            .config_json
            .get("channelId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            && bound_ch != channel_id
        {
            continue;
        }

        let bot_open_id = source
            .config_json
            .get("botOpenId")
            .and_then(Value::as_str)
            .or_else(|| channel_config.get("bot_open_id").and_then(Value::as_str))
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        let Ok(mut envelope) = FeishuSourceNormalizer::new(&source.view.id, bot_open_id)
            .normalize(&event, now)
        else {
            continue;
        };
        envelope.delivery_id = format!("feishu-ws:{}:{message_id}", source.view.id);

        if let Some(domains) = find_domain_host_for_source(&source.view.id).await {
            if let Ok(outcome) = domains.pulse_engine.ingest_event(envelope.clone(), now).await
                && !outcome.duplicate_delivery
                && outcome.rejected_reason.is_none()
            {
                let _ = domains
                    .pulse_engine
                    .store()
                    .update_source_health_and_cursor(
                        &source.view.id,
                        true,
                        Some(&format!(
                            "Bridged Feishu message `{message_id}` via channel `{channel_id}`"
                        )),
                        Some(message_id),
                        &now_iso,
                    )
                    .await;
                domains.resume_waiting_workflows(&envelope).await;
                domains
                    .execute_pulse_dispatch_plan(&outcome.dispatch_plan)
                    .await;
                domains.drain_pulse_outbox().await;
                domains.emit_pulse_deck_changed();
                ingested_count += 1;
            }
        } else {
            let standalone = PulseEngine::new(pool.clone());
            if let Ok(outcome) = standalone.ingest_event(envelope, now).await
                && !outcome.duplicate_delivery
                && outcome.rejected_reason.is_none()
            {
                let _ = standalone
                    .store()
                    .update_source_health_and_cursor(
                        &source.view.id,
                        true,
                        Some(&format!(
                            "Bridged Feishu message `{message_id}` via channel `{channel_id}`"
                        )),
                        Some(message_id),
                        &now_iso,
                    )
                    .await;
                ingested_count += 1;
            }
        }
    }

    ingested_count
}

async fn find_domain_host_for_source(source_id: &str) -> Option<Arc<ServerApplicationDomains>> {
    let candidates: Vec<Arc<ServerApplicationDomains>> = PULSE_DOMAIN_HOSTS
        .lock()
        .ok()?
        .iter()
        .filter_map(Weak::upgrade)
        .collect();
    for host in candidates {
        if host
            .pulse_engine
            .store()
            .get_source(source_id)
            .await
            .ok()
            .flatten()
            .is_some()
        {
            return Some(host);
        }
    }
    None
}

/// Triggers an immediate temporal/connector tick on the host owning `source_id`.
pub async fn trigger_pulse_poll_for_source(source_id: &str) -> bool {
    reset_github_poll_cooldown(source_id);
    let Some(host) = find_domain_host_for_source(source_id).await else {
        return false;
    };
    host.run_pulse_temporal_tick().await.is_ok()
}

impl ServerApplicationDomains {
    /// Executes `DomainCommand::PulseSourceTest` (`POST /api/pulse/sources/{id}/test`).
    /// Never fails with HTTP 500 on downstream connectivity/auth failures; instead records
    /// source health (`healthy = false` + diagnostic `status_message`) and returns `ok: false`.
    pub(crate) async fn execute_pulse_source_test(
        &self,
        engine: &PulseEngine,
        args: &Value,
        now: DateTime<Utc>,
    ) -> Result<PulseSourceTestResult, ApplicationError> {
        let id = require_str_field_aliases(args, &["id", "sourceId", "source_id"])?;
        let inner = unwrap_input(args);
        let ingest = inner
            .get("ingest")
            .or_else(|| args.get("ingest"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let now_iso = now.to_rfc3339();

        let source = engine
            .store()
            .get_source(&id)
            .await
            .map_err(map_sqlx_error)?
            .ok_or_else(|| ApplicationError::not_found(format!("pulse source `{id}`")))?;

        let mode = source
            .config_json
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("");

        if source.view.kind == EventSourceKind::Github && mode == "poll" {
            return self
                .test_github_poll_source(engine, &source, ingest, now, &now_iso)
                .await;
        }

        if source.view.kind == EventSourceKind::Feishu && mode == "long_connection" {
            return self
                .test_feishu_long_connection_source(engine, &source, ingest, now, &now_iso)
                .await;
        }

        if is_webhook_source_kind(source.view.kind) {
            return self
                .test_webhook_source(engine, &source, ingest, now, &now_iso)
                .await;
        }

        self.test_internal_or_sdk_source(engine, &source, ingest, now, &now_iso)
            .await
    }

    async fn fail_source_test(
        &self,
        engine: &PulseEngine,
        source_id: &str,
        mode: &str,
        webhook_path: Option<String>,
        sample_envelope: Option<EventEnvelope>,
        message: String,
        now_iso: &str,
    ) -> Result<PulseSourceTestResult, ApplicationError> {
        let _ = engine
            .store()
            .update_source_health_and_cursor(source_id, false, Some(&message), None, now_iso)
            .await;
        self.emit_pulse_deck_changed();
        Ok(PulseSourceTestResult {
            ok: false,
            source_id: source_id.to_string(),
            mode: mode.to_string(),
            message,
            webhook_path,
            sample_envelope,
        })
    }

    async fn test_github_poll_source(
        &self,
        engine: &PulseEngine,
        source: &PulseSourceRecord,
        ingest: bool,
        now: DateTime<Utc>,
        now_iso: &str,
    ) -> Result<PulseSourceTestResult, ApplicationError> {
        let raw_repo = source
            .config_json
            .get("repo")
            .and_then(Value::as_str)
            .unwrap_or("");
        let Some(repo) = normalize_github_repo(raw_repo) else {
            return self
                .fail_source_test(
                    engine,
                    &source.view.id,
                    "poll",
                    None,
                    None,
                    "GitHub poll source requires a valid repository URL (e.g. `https://github.com/owner/repo`)"
                        .to_string(),
                    now_iso,
                )
                .await;
        };

        let runs = match fetch_github_workflow_runs(
            &source.config_json,
            source.signing_secret.as_deref(),
            &repo,
            1,
        )
        .await
        {
            Ok(runs) => runs,
            Err(err_msg) => {
                return self
                    .fail_source_test(engine, &source.view.id, "poll", None, None, err_msg, now_iso)
                    .await;
            }
        };

        let self_login = source
            .config_json
            .get("selfLogin")
            .and_then(Value::as_str)
            .map(str::to_string);
        let raw_event = if let Some(latest_run) = runs.first() {
            wrap_github_workflow_run_payload(&repo, latest_run)
        } else {
            wrap_github_workflow_run_payload(
                &repo,
                &json!({
                    "id": 1,
                    "run_number": 1,
                    "name": "CI",
                    "status": "completed",
                    "conclusion": "success",
                    "head_branch": "main",
                    "head_sha": "0000000000000000000000000000000000000000",
                    "html_url": format!("https://github.com/{repo}/actions"),
                    "updated_at": now_iso,
                }),
            )
        };

        let delivery_id = format!("source-test:{}", Uuid::new_v4());
        let envelope = match GitHubSourceNormalizer::new(&source.view.id, self_login)
            .normalize_webhook("workflow_run", &delivery_id, &raw_event, now)
        {
            Ok(env) => env,
            Err(err) => {
                return self
                    .fail_source_test(
                        engine,
                        &source.view.id,
                        "poll",
                        None,
                        None,
                        format!("Failed to normalize GitHub workflow_run response: {err}"),
                        now_iso,
                    )
                    .await;
            }
        };

        let msg = if runs.is_empty() {
            format!("Connected to GitHub Actions for `{repo}` (0 runs yet; verified sample ready)")
        } else {
            format!(
                "Connected to GitHub Actions for `{repo}` (`{}`)",
                envelope.event_type
            )
        };
        let seed_watermark = source
            .view
            .cursor_watermark
            .as_deref()
            .filter(|w| !w.trim().is_empty())
            .is_none()
            .then(|| (!runs.is_empty()).then(|| compute_github_watermark(&runs)))
            .flatten();
        let _ = engine
            .store()
            .update_source_health_and_cursor(
                &source.view.id,
                true,
                Some(&msg),
                seed_watermark.as_deref(),
                now_iso,
            )
            .await;

        if ingest {
            self.ingest_and_dispatch_envelope(engine, envelope.clone(), now)
                .await?;
        } else {
            self.emit_pulse_deck_changed();
        }

        Ok(PulseSourceTestResult {
            ok: true,
            source_id: source.view.id.clone(),
            mode: "poll".to_string(),
            message: msg,
            webhook_path: None,
            sample_envelope: Some(envelope),
        })
    }

    async fn test_feishu_long_connection_source(
        &self,
        engine: &PulseEngine,
        source: &PulseSourceRecord,
        ingest: bool,
        now: DateTime<Utc>,
        now_iso: &str,
    ) -> Result<PulseSourceTestResult, ApplicationError> {
        let preferred_channel_id = source
            .config_json
            .get("channelId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());

        let runtime_settings = self.runtime_root.join("settings.json");
        let data_dir_settings = self
            .runtime_root
            .parent()
            .and_then(Path::parent)
            .map(|p| p.join("settings.json"));
        let global_settings = utils::assets::settings_path();
        let mut found_channel =
            find_enabled_feishu_channel(&runtime_settings, preferred_channel_id).await;
        if found_channel.is_none()
            && let Some(ref ds) = data_dir_settings
        {
            found_channel = find_enabled_feishu_channel(ds, preferred_channel_id).await;
        }
        if found_channel.is_none() {
            found_channel =
                find_enabled_feishu_channel(&global_settings, preferred_channel_id).await;
        }

        let explicit_app_id = source
            .config_json
            .get("appId")
            .or_else(|| source.config_json.get("app_id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());

        let conn_states = crate::chat_inbound::chat_channel_connection_states();
        let (ok, msg) = if let Some((ch_id, ch_name)) = found_channel {
            let state = conn_states
                .get(&ch_id)
                .map(String::as_str)
                .unwrap_or("configured");
            (
                true,
                format!("Feishu long-connection bridge ready via channel `{ch_name}` ({state})"),
            )
        } else if let Some(app_id) = explicit_app_id {
            (
                true,
                format!("Feishu long-connection configured for app `{app_id}`"),
            )
        } else {
            (
                false,
                "No enabled Feishu channel found in settings (`chat_channels`); enable a Feishu bot channel to receive long-connection messages".to_string(),
            )
        };

        let bot_open_id = source
            .config_json
            .get("botOpenId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let sample_raw = build_sample_feishu_payload(&source.view.id);
        let mut envelope = FeishuSourceNormalizer::new(&source.view.id, bot_open_id)
            .normalize(&sample_raw, now)
            .map_err(|err| ApplicationError::internal(err.to_string()))?;
        envelope.delivery_id = format!("source-test:{}", Uuid::new_v4());

        let _ = engine
            .store()
            .update_source_health_and_cursor(&source.view.id, ok, Some(&msg), None, now_iso)
            .await;

        if ingest {
            self.ingest_and_dispatch_envelope(engine, envelope.clone(), now)
                .await?;
        } else {
            self.emit_pulse_deck_changed();
        }

        Ok(PulseSourceTestResult {
            ok,
            source_id: source.view.id.clone(),
            mode: "long_connection".to_string(),
            message: msg,
            webhook_path: None,
            sample_envelope: Some(envelope),
        })
    }

    async fn test_webhook_source(
        &self,
        engine: &PulseEngine,
        source: &PulseSourceRecord,
        ingest: bool,
        now: DateTime<Utc>,
        now_iso: &str,
    ) -> Result<PulseSourceTestResult, ApplicationError> {
        let webhook_path = source
            .view
            .public_webhook_path
            .clone()
            .or_else(|| Some(format!("/api/pulse/webhooks/{}", source.view.id)));
        let configured_secret = source
            .signing_secret
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let allow_unsigned = source
            .config_json
            .get("allowUnsigned")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        let (mut headers, sample_json) = build_sample_webhook_payload_and_headers(source, now);
        let raw_bytes = serde_json::to_vec(&sample_json)
            .map_err(|err| ApplicationError::internal(err.to_string()))?;

        if source.view.kind == EventSourceKind::WebhookStandard {
            let Some(secret) = configured_secret else {
                return self
                    .fail_source_test(
                        engine,
                        &source.view.id,
                        "webhook",
                        webhook_path,
                        None,
                        "Standard Webhook source requires a signingSecret for HMAC verification"
                            .to_string(),
                        now_iso,
                    )
                    .await;
            };
            let msg_id = format!("msg_test_{}", Uuid::new_v4().simple());
            let ts = now.timestamp();
            let ts_str = ts.to_string();
            let sig = match sign_standard_webhook(secret, &msg_id, ts, &raw_bytes) {
                Ok(s) => s,
                Err(err) => {
                    return self
                        .fail_source_test(
                            engine,
                            &source.view.id,
                            "webhook",
                            webhook_path,
                            None,
                            format!("Invalid Standard Webhook signingSecret: {err}"),
                            now_iso,
                        )
                        .await;
                }
            };
            headers.insert("webhook-id".to_string(), msg_id.clone());
            headers.insert("webhook-timestamp".to_string(), ts_str.clone());
            headers.insert("webhook-signature".to_string(), sig.clone());

            if let Err(err) = verify_standard_webhook(
                secret,
                StandardWebhookHeaders {
                    webhook_id: &msg_id,
                    webhook_timestamp: &ts_str,
                    webhook_signature: &sig,
                },
                &raw_bytes,
                now,
            ) {
                return self
                    .fail_source_test(
                        engine,
                        &source.view.id,
                        "webhook",
                        webhook_path,
                        None,
                        format!("Standard Webhook signature verification failed: {err}"),
                        now_iso,
                    )
                    .await;
            }
        } else if let Some(secret) = configured_secret {
            let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, secret.as_bytes());
            let tag = ring::hmac::sign(&key, &raw_bytes);
            let hex_sig: String = tag.as_ref().iter().map(|b| format!("{b:02x}")).collect();
            headers.insert("x-hub-signature-256".to_string(), format!("sha256={hex_sig}"));

            if let Err(reason) = verify_platform_webhook_secret(secret, &headers, &raw_bytes, now) {
                return self
                    .fail_source_test(
                        engine,
                        &source.view.id,
                        "webhook",
                        webhook_path,
                        None,
                        reason,
                        now_iso,
                    )
                    .await;
            }
        } else if !allow_unsigned {
            return self
                .fail_source_test(
                    engine,
                    &source.view.id,
                    "webhook",
                    webhook_path,
                    None,
                    "Webhook source has no signingSecret configured (set signingSecret or configJson.allowUnsigned=true)".to_string(),
                    now_iso,
                )
                .await;
        }

        let mut sample_envelope = normalize_platform_webhook_payload(
            &source.view.id,
            source.view.kind,
            &source.config_json,
            &headers,
            &sample_json,
            now,
        )?;
        if configured_secret.is_some() {
            sample_envelope.source.trust_level = EventTrustLevel::VerifiedExternal;
        }

        if ingest {
            if !source.view.enabled {
                return self
                    .fail_source_test(
                        engine,
                        &source.view.id,
                        "webhook",
                        webhook_path,
                        Some(sample_envelope),
                        format!(
                            "Source `{}` is currently disabled; enable it before ingesting test webhooks",
                            source.view.id
                        ),
                        now_iso,
                    )
                    .await;
            }
            let ingest_resp = self
                .ingest_webhook_request(
                    engine,
                    PulseWebhookIngestArgs {
                        source_id: source.view.id.clone(),
                        headers,
                        raw_body_base64: base64::engine::general_purpose::STANDARD
                            .encode(&raw_bytes),
                    },
                    now,
                )
                .await?;
            if let Some(event_id) = ingest_resp.get("eventId").and_then(Value::as_str)
                && let Ok(Some(persisted)) = engine.store().get_envelope_by_event_id(event_id).await
            {
                sample_envelope = persisted;
            }
        }

        let auth_mode = if configured_secret.is_some() {
            "HMAC signature verified"
        } else {
            "unsigned mode allowed"
        };
        let msg = format!(
            "Webhook endpoint ready ({auth_mode}; normalized `{}`)",
            sample_envelope.event_type
        );
        let _ = engine
            .store()
            .update_source_health_and_cursor(&source.view.id, true, Some(&msg), None, now_iso)
            .await;
        self.emit_pulse_deck_changed();

        Ok(PulseSourceTestResult {
            ok: true,
            source_id: source.view.id.clone(),
            mode: "webhook".to_string(),
            message: msg,
            webhook_path,
            sample_envelope: Some(sample_envelope),
        })
    }

    async fn test_internal_or_sdk_source(
        &self,
        engine: &PulseEngine,
        source: &PulseSourceRecord,
        ingest: bool,
        now: DateTime<Utc>,
        now_iso: &str,
    ) -> Result<PulseSourceTestResult, ApplicationError> {
        let default_event_type = match source.view.kind {
            EventSourceKind::TimeCron => "time.cron.fired",
            EventSourceKind::TimeOnce => "time.once.fired",
            EventSourceKind::TimeInterval => "time.interval.fired",
            EventSourceKind::TimeSla => "time.sla.expired",
            EventSourceKind::SystemInternal => "system.internal.probe",
            _ => "sdk.custom.probe",
        };
        let event_type = source
            .config_json
            .get("eventType")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(default_event_type)
            .to_string();

        let mut envelope = CustomSdkEventNormalizer::normalize(
            CustomSdkEventInput {
                instance_id: source.view.id.clone(),
                event_type: event_type.clone(),
                delivery_id: Some(format!("source-test:{}", Uuid::new_v4())),
                actor_id: "user:source-test".to_string(),
                actor_display_name: Some("Pulse Source Test".to_string()),
                trust_level: EventTrustLevel::TrustedInternal,
                thread_key: Some(format!("probe:{}", source.view.id)),
                correlations: Vec::new(),
                reply_channels: Vec::new(),
                parent_envelope: None,
                parent_run_id: None,
                payload: json!({
                    "probe": true,
                    "sourceId": source.view.id,
                }),
            },
            now,
        )
        .map_err(|err| ApplicationError::bad_request(err.to_string()))?;
        envelope.source.kind = source.view.kind;

        let msg = format!("Source `{}` ready (`{event_type}`)", source.view.title);
        let _ = engine
            .store()
            .update_source_health_and_cursor(&source.view.id, true, Some(&msg), None, now_iso)
            .await;

        if ingest {
            self.ingest_and_dispatch_envelope(engine, envelope.clone(), now)
                .await?;
        } else {
            self.emit_pulse_deck_changed();
        }

        Ok(PulseSourceTestResult {
            ok: true,
            source_id: source.view.id.clone(),
            mode: "direct".to_string(),
            message: msg,
            webhook_path: None,
            sample_envelope: Some(envelope),
        })
    }

    async fn ingest_and_dispatch_envelope(
        &self,
        engine: &PulseEngine,
        envelope: EventEnvelope,
        now: DateTime<Utc>,
    ) -> Result<(), ApplicationError> {
        let outcome = engine
            .ingest_event(envelope.clone(), now)
            .await
            .map_err(map_pulse_error)?;
        if !outcome.duplicate_delivery && outcome.rejected_reason.is_none() {
            self.resume_waiting_workflows(&envelope).await;
            self.execute_pulse_dispatch_plan(&outcome.dispatch_plan)
                .await;
            self.drain_pulse_outbox().await;
        }
        self.emit_pulse_deck_changed();
        Ok(())
    }

    /// Polls enabled `EventSourceKind::Github` sources configured with `mode == "poll"`
    /// for new or newly-completed GitHub Actions `workflow_runs`.
    pub(crate) async fn poll_github_sources(&self, engine: &PulseEngine, now: DateTime<Utc>) {
        let Ok(sources) = engine.store().list_source_records().await else {
            return;
        };
        let now_epoch = now.timestamp();
        let now_iso = now.to_rfc3339();

        for source in sources {
            if !source.view.enabled || source.view.kind != EventSourceKind::Github {
                continue;
            }
            if source.config_json.get("mode").and_then(Value::as_str) != Some("poll") {
                continue;
            }

            let poll_interval = source
                .config_json
                .get("pollIntervalSecs")
                .and_then(Value::as_i64)
                .unwrap_or(DEFAULT_POLL_INTERVAL_SECS)
                .max(MIN_POLL_INTERVAL_SECS);

            let has_watermark = source
                .view
                .cursor_watermark
                .as_deref()
                .is_some_and(|w| !w.trim().is_empty());

            let cooldown_ready = should_poll_github_source(&source.view.id, now_epoch, poll_interval);
            if has_watermark && !cooldown_ready {
                continue;
            }

            let raw_repo = source
                .config_json
                .get("repo")
                .and_then(Value::as_str)
                .unwrap_or("");
            let Some(repo) = normalize_github_repo(raw_repo) else {
                let msg = "Invalid GitHub repository URL; expected `https://github.com/owner/repo`";
                let _ = engine
                    .store()
                    .update_source_health_and_cursor(
                        &source.view.id,
                        false,
                        Some(msg),
                        None,
                        &now_iso,
                    )
                    .await;
                self.emit_pulse_deck_changed();
                continue;
            };

            let runs = match fetch_github_workflow_runs(
                &source.config_json,
                source.signing_secret.as_deref(),
                &repo,
                10,
            )
            .await
            {
                Ok(runs) => runs,
                Err(err_msg) => {
                    let _ = engine
                        .store()
                        .update_source_health_and_cursor(
                            &source.view.id,
                            false,
                            Some(&err_msg),
                            None,
                            &now_iso,
                        )
                        .await;
                    self.emit_pulse_deck_changed();
                    continue;
                }
            };

            let emit_latest_on_init = source
                .config_json
                .get("emitLatestOnInit")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let (runs_to_emit, next_watermark) = select_github_runs_for_watermark(
                &runs,
                source.view.cursor_watermark.as_deref(),
                emit_latest_on_init,
            );

            let self_login = source
                .config_json
                .get("selfLogin")
                .and_then(Value::as_str)
                .map(str::to_string);
            let normalizer = GitHubSourceNormalizer::new(&source.view.id, self_login);

            let mut emitted_any = false;
            for run in runs_to_emit {
                let run_id = run.get("id").and_then(Value::as_u64).unwrap_or(0);
                let status = run
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("completed");
                let conclusion = run
                    .get("conclusion")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let delivery_id =
                    format!("gh-poll:{}:{run_id}:{status}:{conclusion}", source.view.id);
                let wrapped = wrap_github_workflow_run_payload(&repo, run);
                let Ok(mut envelope) =
                    normalizer.normalize_webhook("workflow_run", &delivery_id, &wrapped, now)
                else {
                    continue;
                };
                envelope.source.trust_level = EventTrustLevel::VerifiedExternal;
                if let Ok(outcome) = engine.ingest_event(envelope.clone(), now).await
                    && !outcome.duplicate_delivery
                    && outcome.rejected_reason.is_none()
                {
                    self.resume_waiting_workflows(&envelope).await;
                    self.execute_pulse_dispatch_plan(&outcome.dispatch_plan)
                        .await;
                    emitted_any = true;
                }
            }

            if emitted_any {
                self.drain_pulse_outbox().await;
            }

            let status_msg = format!("Polling `{repo}` ({} recent runs)", runs.len());
            let watermark_changed =
                source.view.cursor_watermark.as_deref() != Some(next_watermark.as_str());
            let _ = engine
                .store()
                .update_source_health_and_cursor(
                    &source.view.id,
                    true,
                    Some(&status_msg),
                    Some(&next_watermark),
                    &now_iso,
                )
                .await;
            if emitted_any || watermark_changed || !source.view.healthy {
                self.emit_pulse_deck_changed();
            }
        }
    }
}

fn should_poll_github_source(source_id: &str, now_epoch: i64, interval_secs: i64) -> bool {
    let Ok(mut map) = GITHUB_LAST_POLL_EPOCH.lock() else {
        return true;
    };
    if let Some(&prev) = map.get(source_id)
        && now_epoch >= prev
        && now_epoch.saturating_sub(prev) < interval_secs
    {
        return false;
    }
    map.insert(source_id.to_string(), now_epoch);
    true
}

pub(crate) fn normalize_github_repo(raw: &str) -> Option<String> {
    let without_query = raw.trim().split(['?', '#']).next()?.trim();
    if without_query.is_empty() || without_query.chars().any(char::is_whitespace) {
        return None;
    }

    let path = if let Some(rest) = without_query
        .strip_prefix("https://")
        .or_else(|| without_query.strip_prefix("http://"))
    {
        let (_host, after_host) = rest.split_once('/')?;
        after_host
    } else if let Some(rest) = without_query.strip_prefix("ssh://") {
        let (_host, after_host) = rest.split_once('/')?;
        after_host
    } else if let Some(rest) = without_query.strip_prefix("git@") {
        let (_host, after_colon) = rest.split_once(':')?;
        after_colon
    } else {
        without_query
    };

    let mut segments = path.trim_matches('/').split('/');
    let owner = segments.next()?.trim();
    let repo_raw = segments.next()?.trim();
    let repo = repo_raw.strip_suffix(".git").unwrap_or(repo_raw);
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    // For bare `owner/repo`, reject extra path segments; for full URLs, ignore trailing `/tree/...` or `/actions`.
    let is_url_like = without_query.contains("://") || without_query.starts_with("git@");
    if !is_url_like && segments.next().is_some() {
        return None;
    }
    Some(format!("{owner}/{repo}"))
}

fn infer_github_api_base_from_repo_url(raw_repo: &str) -> Option<String> {
    let trimmed = raw_repo.trim();
    let (scheme, rest) = if let Some(r) = trimmed.strip_prefix("https://") {
        ("https", r)
    } else if let Some(r) = trimmed.strip_prefix("http://") {
        ("http", r)
    } else {
        return None;
    };
    let (host, _) = rest.split_once('/')?;
    let host_clean = host.trim();
    if host_clean.is_empty()
        || host_clean.eq_ignore_ascii_case("github.com")
        || host_clean.eq_ignore_ascii_case("www.github.com")
    {
        return None;
    }
    Some(format!("{scheme}://{host_clean}/api/v3"))
}

async fn fetch_github_workflow_runs(
    config_json: &Value,
    signing_secret: Option<&str>,
    repo: &str,
    per_page: u32,
) -> Result<Vec<Value>, String> {
    let raw_repo = config_json
        .get("repo")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let inferred_api_base = infer_github_api_base_from_repo_url(raw_repo);
    let api_base = config_json
        .get("apiBaseUrl")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or(inferred_api_base.as_deref())
        .unwrap_or(DEFAULT_GITHUB_API_BASE)
        .trim_end_matches('/');
    let token = config_json
        .get("githubToken")
        .or_else(|| config_json.get("token"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| signing_secret.map(str::trim).filter(|s| !s.is_empty()));

    let endpoint = format!("repos/{repo}/actions/runs?per_page={per_page}");
    let url = format!("{api_base}/{endpoint}");

    let mut req = PULSE_CONNECTOR_HTTP_CLIENT
        .get(&url)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28");
    if let Some(tok) = token {
        req = req.bearer_auth(tok);
    }

    let http_err = match req.send().await {
        Ok(resp) if resp.status().is_success() => {
            let body: Value = resp
                .json()
                .await
                .map_err(|err| format!("GitHub API invalid JSON for `{repo}`: {err}"))?;
            return Ok(body
                .get("workflow_runs")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default());
        }
        Ok(resp) => {
            let code = resp.status();
            let detail = resp.text().await.unwrap_or_default();
            let should_try_gh = api_base == DEFAULT_GITHUB_API_BASE
                && (token.is_none() || matches!(code.as_u16(), 401 | 403 | 404));
            let err_str = format!(
                "GitHub API `{repo}` returned HTTP {code}{}",
                if detail.trim().is_empty() {
                    String::new()
                } else {
                    format!(": {}", truncate_snippet(&detail, 140))
                }
            );
            if !should_try_gh {
                return Err(err_str);
            }
            err_str
        }
        Err(err) => {
            let err_str = format!("GitHub API request failed for `{repo}`: {err}");
            if api_base != DEFAULT_GITHUB_API_BASE {
                return Err(err_str);
            }
            err_str
        }
    };

    match gh_cli_fetch_workflow_runs(&endpoint).await {
        Ok(runs) => Ok(runs),
        Err(_) => Err(http_err),
    }
}

async fn gh_cli_fetch_workflow_runs(endpoint: &str) -> Result<Vec<Value>, String> {
    let output = tokio::time::timeout(
        Duration::from_secs(8),
        tokio::process::Command::new("gh")
            .args(["api", endpoint])
            .output(),
    )
    .await
    .map_err(|_| "gh api timed out after 8s".to_string())?
    .map_err(|err| format!("gh cli unavailable: {err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gh api failed: {}", stderr.trim()));
    }
    let parsed: Value = serde_json::from_slice(&output.stdout)
        .map_err(|err| format!("gh api invalid JSON: {err}"))?;
    Ok(parsed
        .get("workflow_runs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

fn select_github_runs_for_watermark<'a>(
    runs: &'a [Value],
    prev_watermark: Option<&str>,
    emit_latest_on_init: bool,
) -> (Vec<&'a Value>, String) {
    let next_watermark = compute_github_watermark(runs);
    let trimmed_prev = prev_watermark.map(str::trim).filter(|s| !s.is_empty());

    let Some(prev_raw) = trimmed_prev else {
        if let Ok(mut map) = GITHUB_LAST_POLL_EPOCH.lock() {
            let _ = &mut map;
        }
        let initial = if emit_latest_on_init {
            runs.first().into_iter().collect()
        } else {
            Vec::new()
        };
        return (initial, next_watermark);
    };

    let (prev_max_id, prev_status, prev_conclusion, prev_pending) =
        parse_github_watermark(prev_raw);

    let mut selected: Vec<&'a Value> = runs
        .iter()
        .rev()
        .filter(|run| {
            let id = run.get("id").and_then(Value::as_u64).unwrap_or(0);
            if id == 0 {
                return false;
            }
            let status = run
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("completed");
            let conclusion = run.get("conclusion").and_then(Value::as_str).unwrap_or("");
            if id > prev_max_id {
                true
            } else if id == prev_max_id {
                status != prev_status || conclusion != prev_conclusion
            } else {
                prev_pending.contains(&id) && status == "completed"
            }
        })
        .collect();

    selected.sort_by_key(|run| run.get("id").and_then(Value::as_u64).unwrap_or(0));
    (selected, next_watermark)
}

fn compute_github_watermark(runs: &[Value]) -> String {
    let Some(top) = runs
        .iter()
        .max_by_key(|r| r.get("id").and_then(Value::as_u64).unwrap_or(0))
    else {
        return "0:none:none".to_string();
    };
    let max_id = top.get("id").and_then(Value::as_u64).unwrap_or(0);
    let status = top
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("completed");
    let conclusion = top.get("conclusion").and_then(Value::as_str).unwrap_or("");

    let mut pending: Vec<u64> = runs
        .iter()
        .filter_map(|r| {
            let id = r.get("id").and_then(Value::as_u64)?;
            let st = r.get("status").and_then(Value::as_str).unwrap_or("completed");
            (id < max_id && st != "completed").then_some(id)
        })
        .collect();
    pending.sort_unstable();
    pending.dedup();

    if pending.is_empty() {
        format!("{max_id}:{status}:{conclusion}")
    } else {
        let joined = pending
            .iter()
            .map(u64::to_string)
            .collect::<Vec<_>>()
            .join(",");
        format!("{max_id}:{status}:{conclusion};pending={joined}")
    }
}

fn parse_github_watermark(raw: &str) -> (u64, &str, &str, HashSet<u64>) {
    let (head, tail) = raw.split_once(';').unwrap_or((raw, ""));
    let mut parts = head.splitn(3, ':');
    let max_id = parts
        .next()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    let status = parts.next().unwrap_or("");
    let conclusion = parts.next().unwrap_or("");
    let mut pending = HashSet::new();
    if let Some(list) = tail.strip_prefix("pending=") {
        for item in list.split(',') {
            if let Ok(id) = item.trim().parse::<u64>() {
                pending.insert(id);
            }
        }
    }
    (max_id, status, conclusion, pending)
}

fn wrap_github_workflow_run_payload(repo: &str, run: &Value) -> Value {
    let status = run
        .get("status")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("completed");
    let repository = run
        .get("repository")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| json!({ "full_name": repo }));
    let sender = run
        .get("triggering_actor")
        .or_else(|| run.get("actor"))
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| json!({ "login": "github-actions", "type": "User" }));
    json!({
        "action": status,
        "workflow_run": run,
        "repository": repository,
        "sender": sender,
    })
}

async fn find_enabled_feishu_channel(
    settings_path: &Path,
    preferred_id: Option<&str>,
) -> Option<(String, String)> {
    let section: Value =
        services::services::settings_store::read_section(settings_path, CHAT_CHANNELS_SECTION)
            .await
            .ok()??;
    let channels = section.get("channels")?.as_array()?;
    for ch in channels {
        let enabled = ch.get("enabled").and_then(Value::as_bool).unwrap_or(false);
        let kind = ch.get("kind").and_then(Value::as_str).unwrap_or("");
        if !enabled || kind != "feishu" {
            continue;
        }
        let id = ch.get("id").and_then(Value::as_str).unwrap_or("").trim();
        if id.is_empty() {
            continue;
        }
        if let Some(pref) = preferred_id
            && id != pref
        {
            continue;
        }
        let name = ch
            .get("name")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(id);
        return Some((id.to_string(), name.to_string()));
    }
    None
}

fn build_sample_feishu_payload(source_id: &str) -> Value {
    let msg_id = format!("om_probe_{}", Uuid::new_v4().simple());
    json!({
        "schema": "2.0",
        "header": {
            "event_id": format!("ev_probe_{}", Uuid::new_v4().simple()),
            "event_type": "im.message.receive_v1",
        },
        "event": {
            "sender": {
                "sender_id": { "open_id": "ou_pulse_probe_user" },
                "sender_type": "user",
            },
            "message": {
                "message_id": msg_id,
                "chat_id": format!("oc_probe_{source_id}"),
                "chat_type": "group",
                "message_type": "text",
                "content": "{\"text\":\"Pulse Feishu connectivity probe\"}",
            }
        }
    })
}

fn build_sample_webhook_payload_and_headers(
    source: &PulseSourceRecord,
    now: DateTime<Utc>,
) -> (BTreeMap<String, String>, Value) {
    let mut headers = BTreeMap::new();
    let delivery = format!("source-test-{}", Uuid::new_v4());
    match source.view.kind {
        EventSourceKind::Feishu => (headers, build_sample_feishu_payload(&source.view.id)),
        EventSourceKind::Jira => {
            headers.insert("x-atlassian-webhook-identifier".to_string(), delivery);
            let issue_key = source
                .config_json
                .get("projectKey")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(|k| format!("{k}-1"))
                .unwrap_or_else(|| "PULSE-1".to_string());
            (
                headers,
                json!({
                    "webhookEvent": "jira:issue_created",
                    "user": { "accountId": "acct-probe", "displayName": "Pulse Probe" },
                    "issue": {
                        "key": issue_key,
                        "fields": {
                            "summary": "Pulse Jira connectivity probe",
                            "status": { "name": "To Do" },
                            "priority": { "name": "Medium" },
                        }
                    }
                }),
            )
        }
        EventSourceKind::Github => {
            let repo = source
                .config_json
                .get("repo")
                .and_then(Value::as_str)
                .and_then(normalize_github_repo)
                .unwrap_or_else(|| "octocat/hello-world".to_string());
            headers.insert("x-github-event".to_string(), "workflow_run".to_string());
            headers.insert("x-github-delivery".to_string(), delivery);
            let run = json!({
                "id": 1001,
                "run_number": 42,
                "name": "CI",
                "status": "completed",
                "conclusion": "failure",
                "head_branch": "main",
                "head_sha": "1111111111111111111111111111111111111111",
                "html_url": format!("https://github.com/{repo}/actions/runs/1001"),
                "updated_at": now.to_rfc3339(),
            });
            (headers, wrap_github_workflow_run_payload(&repo, &run))
        }
        _ => {
            let event_type = source
                .config_json
                .get("eventType")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("webhook.custom.probe");
            headers.insert("x-pulse-delivery-id".to_string(), delivery);
            headers.insert("x-pulse-event-type".to_string(), event_type.to_string());
            (
                headers,
                json!({
                    "eventType": event_type,
                    "threadKey": format!("probe:{}", source.view.id),
                    "message": "Pulse webhook connectivity probe",
                    "occurredAt": now.to_rfc3339(),
                }),
            )
        }
    }
}

fn truncate_snippet(raw: &str, max_chars: usize) -> String {
    let trimmed = raw.trim();
    if trimmed.chars().count() <= max_chars {
        trimmed.to_string()
    } else {
        format!("{}…", trimmed.chars().take(max_chars).collect::<String>())
    }
}

#[cfg(test)]
mod tests {
    use super::{infer_github_api_base_from_repo_url, normalize_github_repo};

    #[test]
    fn normalize_github_repo_accepts_full_urls_ssh_and_legacy_slugs() {
        assert_eq!(
            normalize_github_repo("https://github.com/octocat/Hello-World"),
            Some("octocat/Hello-World".to_string())
        );
        assert_eq!(
            normalize_github_repo("https://github.com/octocat/Hello-World.git/"),
            Some("octocat/Hello-World".to_string())
        );
        assert_eq!(
            normalize_github_repo("https://github.com/octocat/Hello-World/actions?query=branch%3Amain#run"),
            Some("octocat/Hello-World".to_string())
        );
        assert_eq!(
            normalize_github_repo("git@github.com:octocat/Hello-World.git"),
            Some("octocat/Hello-World".to_string())
        );
        assert_eq!(
            normalize_github_repo("https://ghe.internal.example/org/service"),
            Some("org/service".to_string())
        );
        assert_eq!(
            normalize_github_repo("octocat/Hello-World"),
            Some("octocat/Hello-World".to_string())
        );
        assert_eq!(normalize_github_repo("https://github.com/only-owner"), None);
        assert_eq!(normalize_github_repo("octocat/Hello-World/extra"), None);
        assert_eq!(normalize_github_repo(""), None);
    }

    #[test]
    fn infer_github_api_base_detects_enterprise_hosts_only() {
        assert_eq!(
            infer_github_api_base_from_repo_url("https://github.com/octocat/Hello-World"),
            None
        );
        assert_eq!(
            infer_github_api_base_from_repo_url("octocat/Hello-World"),
            None
        );
        assert_eq!(
            infer_github_api_base_from_repo_url("https://ghe.internal.example/org/service"),
            Some("https://ghe.internal.example/api/v3".to_string())
        );
    }
}

