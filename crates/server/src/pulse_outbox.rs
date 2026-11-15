//! Transactional `pulse_outbox` delivery worker (`EmitEvent`, `WebhookPost`, `ReplyChannel`,
//! and user-interaction channel mirrors) with exponential retry backoff and hop-count guards.

use std::{sync::LazyLock, time::Duration};

use api_types::pulse::{
    EventActor, EventEnvelope, EventSourceKind, EventSourceMeta, EventTrace, EventTrustLevel,
};
use chrono::Utc;
use conversations::collaboration;
use db::models::pulse::{PulseOutboxRecord, ensure_pulse_schema};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    COLLABORATION_SPACE_CHANGED_EVENT, domains::ServerApplicationDomains,
    pulse_runtime::ensure_sdk_source_exists,
};

/// Maximum cascade hop count permitted for derived `OutboxActionKind::EmitEvent` deliveries.
const MAX_OUTBOX_DERIVED_HOP_COUNT: u32 = 4;

/// Maximum delivery attempts before an outbox row is permanently marked failed.
const MAX_OUTBOX_DELIVERY_ATTEMPTS: u32 = 8;

static PULSE_OUTBOX_HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
});

impl ServerApplicationDomains {
    /// Claims and delivers all due `pulse_outbox` rows (`status IN ('pending', 'failed')`).
    pub(crate) async fn drain_pulse_outbox(&self) {
        if ensure_pulse_schema(&self.pool).await.is_err() {
            return;
        }
        let store = self.pulse_engine.store();

        for _round in 0..8 {
            let now = Utc::now();
            let now_iso = now.to_rfc3339();
            let claimed = match store.claim_due_outbox(&now_iso, 32).await {
                Ok(rows) if !rows.is_empty() => rows,
                _ => break,
            };

            for record in claimed {
                self.deliver_outbox_record(&record, now).await;
            }
        }
    }

    async fn deliver_outbox_record(
        &self,
        record: &PulseOutboxRecord,
        now: chrono::DateTime<Utc>,
    ) {
        let store = self.pulse_engine.store();
        let now_iso = now.to_rfc3339();

        let result = match record.target_kind.as_str() {
            "emit_event" => self.deliver_outbox_emit_event(record, now).await,
            "webhook_post" => self.deliver_outbox_webhook_post(record).await,
            "reply_channel" | "user_interaction_mirror" | "im_reaction_ack" => {
                self.deliver_outbox_reply_channel(record).await
            }
            _ => Ok(()),
        };

        match result {
            Ok(()) => {
                let _ = store.mark_outbox_delivered(&record.id, &now_iso).await;
            }
            Err(err_msg) => {
                let retry_at = if record.attempts < MAX_OUTBOX_DELIVERY_ATTEMPTS {
                    let backoff_exponent = record.attempts.saturating_sub(1).min(10);
                    let delay_secs = 30_i64.saturating_mul(2_i64.saturating_pow(backoff_exponent));
                    Some((now + chrono::Duration::seconds(delay_secs)).to_rfc3339())
                } else {
                    None
                };
                let _ = store
                    .mark_outbox_failed(&record.id, &err_msg, retry_at.as_deref(), &now_iso)
                    .await;
            }
        }
    }

    async fn deliver_outbox_emit_event(
        &self,
        record: &PulseOutboxRecord,
        now: chrono::DateTime<Utc>,
    ) -> Result<(), String> {
        let now_iso = now.to_rfc3339();
        let event_type = record
            .payload
            .get("eventType")
            .or_else(|| record.payload.get("event_type"))
            .or_else(|| record.payload.get("target"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("pulse.outbox.emitted")
            .to_string();

        let inner_payload = record
            .payload
            .get("payload")
            .cloned()
            .unwrap_or_else(|| record.payload.clone());

        let thread_key = record
            .payload
            .get("threadKey")
            .or_else(|| record.payload.get("thread_key"))
            .and_then(Value::as_str)
            .or_else(|| {
                inner_payload
                    .get("threadKey")
                    .or_else(|| inner_payload.get("thread_key"))
                    .and_then(Value::as_str)
            })
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        let parent_hop_count = record
            .payload
            .get("parentHopCount")
            .or_else(|| record.payload.get("hopCount"))
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok())
            .unwrap_or(0);
        let hop_count = parent_hop_count.saturating_add(1);
        if hop_count > MAX_OUTBOX_DERIVED_HOP_COUNT {
            tracing::warn!(
                outbox_id = %record.id,
                event_type = %event_type,
                hop_count,
                max_hops = MAX_OUTBOX_DERIVED_HOP_COUNT,
                "dropping derived outbox event exceeding anti-storm hop ceiling"
            );
            return Ok(());
        }

        let event_id = Uuid::new_v4().to_string();
        let root_event_id = record
            .payload
            .get("rootEventId")
            .or_else(|| record.payload.get("root_event_id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| event_id.clone());

        let parent_run_id = record
            .payload
            .get("workflowRunId")
            .and_then(Value::as_str)
            .map(str::to_string);

        let derived = EventEnvelope {
            event_id,
            delivery_id: format!("outbox:{}", record.dedupe_key),
            source: EventSourceMeta {
                kind: EventSourceKind::SdkCustom,
                instance_id: "outbox:internal".to_string(),
                trust_level: EventTrustLevel::TrustedInternal,
            },
            event_type,
            occurred_at: now_iso.clone(),
            actor: EventActor {
                id: "pulse:outbox".to_string(),
                display_name: Some("Pulse Outbox".to_string()),
                roles: Vec::new(),
                is_bot: false,
                is_self: false,
            },
            thread_key,
            correlations: Vec::new(),
            reply_channels: Vec::new(),
            trace: EventTrace {
                root_event_id,
                parent_run_id,
                hop_count,
            },
            payload: inner_payload,
        };

        ensure_sdk_source_exists(&self.pulse_engine, "outbox:internal", &now_iso)
            .await
            .map_err(|err| err.to_string())?;

        let outcome = self
            .pulse_engine
            .ingest_event(derived.clone(), now)
            .await
            .map_err(|err| err.to_string())?;

        if !outcome.duplicate_delivery && outcome.rejected_reason.is_none() {
            self.resume_waiting_workflows(&derived).await;
            Box::pin(self.execute_pulse_dispatch_plan(&outcome.dispatch_plan)).await;
            self.emit_pulse_deck_changed();
        }
        Ok(())
    }

    async fn deliver_outbox_webhook_post(
        &self,
        record: &PulseOutboxRecord,
    ) -> Result<(), String> {
        let destination = extract_outbox_destination(&record.payload);
        if destination.starts_with("http://") || destination.starts_with("https://") {
            let body = record.payload.get("payload").unwrap_or(&record.payload);
            post_json_webhook(&destination, body).await
        } else {
            Ok(())
        }
    }

    async fn deliver_outbox_reply_channel(
        &self,
        record: &PulseOutboxRecord,
    ) -> Result<(), String> {
        let destination = extract_outbox_destination(&record.payload);
        if let Some(space_id) = destination.strip_prefix("space:") {
            let trimmed_space = space_id.trim();
            if trimmed_space.is_empty() {
                return Err("reply_channel `space:` destination is empty".to_string());
            }
            let content = extract_outbox_message_content(&record.payload);
            collaboration::post_to_space_delayed_with(
                &self.pool,
                collaboration::PostToSpace {
                    caller_id: None,
                    space_id: trimmed_space.to_string(),
                    content,
                    summary: Some("Pulse Outbox".to_string()),
                    to: Vec::new(),
                    in_reply_to: None,
                    operation_id: Uuid::new_v4(),
                },
                None,
                &collaboration::DeliveryContext::default(),
            )
            .await
            .map_err(|err| err.to_string())?;
            self.events.emit(
                COLLABORATION_SPACE_CHANGED_EVENT,
                json!({ "spaceId": trimmed_space }),
            );
            Ok(())
        } else if destination.starts_with("http://") || destination.starts_with("https://") {
            let body = record.payload.get("payload").unwrap_or(&record.payload);
            post_json_webhook(&destination, body).await
        } else {
            Ok(())
        }
    }
}

fn extract_outbox_destination(payload: &Value) -> String {
    for key in ["destination", "channel", "target", "url"] {
        if let Some(raw) = payload.get(key).and_then(Value::as_str) {
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    String::new()
}

fn extract_outbox_message_content(payload: &Value) -> String {
    if let Some(inner) = payload.get("payload") {
        if let Some(s) = inner.as_str() {
            return s.to_string();
        }
        for key in ["content", "text", "message", "body"] {
            if let Some(s) = inner.get(key).and_then(Value::as_str) {
                return s.to_string();
            }
        }
    }
    if let (Some(title), Some(body)) = (
        payload.get("title").and_then(Value::as_str),
        payload.get("body").and_then(Value::as_str),
    ) {
        return if body.trim().is_empty() {
            title.to_string()
        } else {
            format!("{title}\n\n{body}")
        };
    }
    serde_json::to_string(payload.get("payload").unwrap_or(payload))
        .unwrap_or_else(|_| "{}".to_string())
}

async fn post_json_webhook(url: &str, body: &Value) -> Result<(), String> {
    let response = PULSE_OUTBOX_HTTP_CLIENT
        .post(url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .json(body)
        .send()
        .await
        .map_err(|err| format!("outbox webhook POST `{url}` failed: {err}"))?;

    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!(
            "outbox webhook POST `{url}` returned HTTP {}",
            response.status()
        ))
    }
}
