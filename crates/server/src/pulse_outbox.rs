//! Transactional `pulse_outbox` delivery worker (`EmitEvent`, `WebhookPost`, `ReplyChannel`,
//! and user-interaction channel mirrors) with exponential retry backoff and hop-count guards.

use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    time::Duration,
};

use api_types::pulse::{
    EventActor, EventEnvelope, EventSourceKind, EventSourceMeta, EventTrace, EventTrustLevel,
};
use chrono::Utc;
use conversations::collaboration;
use db::models::pulse::{PulseOutboxRecord, ensure_pulse_schema};
use serde_json::{Value, json};
use url::Url;
use uuid::Uuid;

use crate::{
    COLLABORATION_SPACE_CHANGED_EVENT, domains::ServerApplicationDomains,
    pulse_runtime::ensure_sdk_source_exists,
};

/// Maximum cascade hop count permitted for derived `OutboxActionKind::EmitEvent` deliveries.
const MAX_OUTBOX_DERIVED_HOP_COUNT: u32 = 4;

/// Maximum delivery attempts before an outbox row is permanently marked failed.
const MAX_OUTBOX_DELIVERY_ATTEMPTS: u32 = 8;

fn is_forbidden_ipv4(ip: Ipv4Addr, allow_loopback: bool) -> bool {
    let octets = ip.octets();
    if ip.is_loopback() || octets[0] == 127 {
        return !allow_loopback;
    }
    octets[0] == 0
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.is_broadcast()
        || ip.is_documentation()
        // CGNAT 100.64.0.0/10
        || (octets[0] == 100 && (octets[1] & 0xc0) == 64)
        // IETF protocol assignments 192.0.0.0/24
        || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
        // Benchmarking 198.18.0.0/15
        || (octets[0] == 198 && (octets[1] == 18 || octets[1] == 19))
        // Reserved 240.0.0.0/4
        || octets[0] >= 240
}

pub(crate) fn is_forbidden_ip(ip: IpAddr, allow_loopback: bool) -> bool {
    match ip {
        IpAddr::V4(v4) => is_forbidden_ipv4(v4, allow_loopback),
        IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_forbidden_ipv4(mapped, allow_loopback);
            }
            if v6.is_loopback() {
                return !allow_loopback;
            }
            let seg = v6.segments();
            // Deprecated IPv4-compatible `::/96` embeds raw IPv4 in low 32 bits
            if seg[0] == 0
                && seg[1] == 0
                && seg[2] == 0
                && seg[3] == 0
                && seg[4] == 0
                && seg[5] == 0
            {
                if let Some(compat) = v6.to_ipv4() {
                    return is_forbidden_ipv4(compat, allow_loopback);
                }
                return true;
            }
            v6.is_unspecified()
                || v6.is_multicast()
                // ULA fc00::/7
                || (seg[0] & 0xfe00) == 0xfc00
                // Link-local fe80::/10
                || (seg[0] & 0xffc0) == 0xfe80
                // Deprecated site-local fec0::/10
                || (seg[0] & 0xffc0) == 0xfec0
                // Documentation 2001:db8::/32
                || (seg[0] == 0x2001 && seg[1] == 0x0db8)
        }
    }
}

fn validate_outbound_url_syntax(
    raw_url: &str,
    allow_loopback: bool,
) -> Result<(Url, String, u16), String> {
    let parsed = Url::parse(raw_url.trim())
        .map_err(|err| format!("invalid outbound URL `{raw_url}`: {err}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => {
            return Err(format!(
                "outbound URL `{raw_url}` uses unsupported scheme `{other}`"
            ));
        }
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(format!(
            "outbound URL `{raw_url}` must not embed credentials"
        ));
    }
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| format!("outbound URL `{raw_url}` has no valid port"))?;
    let host_str = parsed
        .host_str()
        .map(str::trim)
        .filter(|h| !h.is_empty())
        .ok_or_else(|| format!("outbound URL `{raw_url}` has no valid host"))?;
    let clean_host = host_str.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = clean_host.parse::<IpAddr>()
        && is_forbidden_ip(ip, allow_loopback)
    {
        return Err(format!(
            "outbound URL `{raw_url}` targets forbidden internal IP `{ip}`"
        ));
    }
    if !allow_loopback {
        let lower = clean_host.to_ascii_lowercase();
        if lower == "localhost" || lower.ends_with(".localhost") || lower.ends_with(".local") {
            return Err(format!(
                "outbound URL `{raw_url}` targets forbidden local host `{clean_host}`"
            ));
        }
    }
    let host = clean_host.to_string();
    Ok((parsed, host, port))
}

pub(crate) async fn build_safe_outbound_client(
    raw_url: &str,
    allow_loopback: bool,
    timeout: Duration,
    user_agent: Option<&str>,
) -> Result<reqwest::Client, String> {
    let (_url, host, port) = validate_outbound_url_syntax(raw_url, allow_loopback)?;
    let addrs: Vec<SocketAddr> = if let Ok(ip) = host.parse::<IpAddr>() {
        vec![SocketAddr::new(ip, port)]
    } else {
        tokio::net::lookup_host((host.as_str(), port))
            .await
            .map_err(|err| format!("DNS resolution failed for outbound host `{host}`: {err}"))?
            .collect()
    };
    if addrs.is_empty() {
        return Err(format!(
            "DNS resolution returned no addresses for outbound host `{host}`"
        ));
    }
    for addr in &addrs {
        if is_forbidden_ip(addr.ip(), allow_loopback) {
            return Err(format!(
                "outbound host `{host}` resolved to forbidden internal IP `{}`",
                addr.ip()
            ));
        }
    }
    let mut builder = reqwest::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(&host, &addrs);
    if let Some(ua) = user_agent {
        builder = builder.user_agent(ua);
    }
    builder
        .build()
        .map_err(|err| format!("failed to build safe outbound HTTP client: {err}"))
}

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

    async fn deliver_outbox_record(&self, record: &PulseOutboxRecord, now: chrono::DateTime<Utc>) {
        let store = self.pulse_engine.store();
        let now_iso = now.to_rfc3339();

        let result = match record.target_kind.as_str() {
            "emit_event" => self.deliver_outbox_emit_event(record, now).await,
            "feishu_webhook" => self.deliver_outbox_feishu_webhook(record).await,
            "github_comment" => self.deliver_outbox_github_comment(record).await,
            "webhook_post" => self.deliver_outbox_webhook_post(record).await,
            "reply_channel" | "user_interaction_mirror" | "im_reaction_ack" => {
                self.deliver_outbox_reply_channel(record).await
            }
            other => Err(format!("unsupported pulse_outbox target_kind `{other}`")),
        };

        let rule_id = record
            .payload
            .get("ruleId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());

        match result {
            Ok(()) => {
                let _ = store.mark_outbox_delivered(&record.id, &now_iso).await;
                if let Some(rid) = rule_id {
                    let dest = extract_outbox_destination(&record.payload);
                    let summary = format!("Delivered {} to {}", record.target_kind, dest);
                    let _ = store
                        .record_rule_task_run(rid, "succeeded", &summary, &now_iso)
                        .await;
                }
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
                if let Some(rid) = rule_id {
                    let _ = store
                        .record_rule_task_run(rid, "failed", &err_msg, &now_iso)
                        .await;
                }
            }
        }
        self.emit_pulse_deck_changed();
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

    async fn deliver_outbox_feishu_webhook(
        &self,
        record: &PulseOutboxRecord,
    ) -> Result<(), String> {
        let destination = extract_outbox_destination(&record.payload);
        if !destination.starts_with("http://") && !destination.starts_with("https://") {
            return Err(format!(
                "feishu_webhook destination `{destination}` must be an http(s) URL"
            ));
        }
        let client = build_safe_outbound_client(
            &destination,
            self.allow_loopback_outbox,
            Duration::from_secs(5),
            None,
        )
        .await?;
        let headers = extract_outbox_headers(&record.payload);
        let rendered_text = record
            .payload
            .get("renderedText")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| extract_outbox_message_content(&record.payload));

        let body = match serde_json::from_str::<Value>(&rendered_text) {
            Ok(Value::Object(map)) if map.contains_key("msg_type") => Value::Object(map),
            _ => json!({
                "msg_type": "text",
                "content": { "text": rendered_text },
            }),
        };

        let mut req = client
            .post(&destination)
            .header(reqwest::header::CONTENT_TYPE, "application/json");
        for (k, v) in &headers {
            req = req.header(k.as_str(), v.as_str());
        }

        let response = req
            .json(&body)
            .send()
            .await
            .map_err(|err| format!("feishu_webhook POST `{destination}` failed: {err}"))?;
        let status = response.status();
        let resp_text = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(format!(
                "feishu_webhook POST `{destination}` returned HTTP {status}: {resp_text}"
            ));
        }
        if let Ok(resp_json) = serde_json::from_str::<Value>(&resp_text)
            && let Some(code) = resp_json
                .get("code")
                .or_else(|| resp_json.get("StatusCode"))
                .and_then(Value::as_i64)
            && code != 0
        {
            let msg = resp_json
                .get("msg")
                .or_else(|| resp_json.get("StatusMessage"))
                .and_then(Value::as_str)
                .unwrap_or(resp_text.as_str());
            return Err(format!(
                "feishu_webhook `{destination}` returned code {code}: {msg}"
            ));
        }
        Ok(())
    }

    async fn deliver_outbox_github_comment(
        &self,
        record: &PulseOutboxRecord,
    ) -> Result<(), String> {
        let destination = extract_outbox_destination(&record.payload);
        self.deliver_outbox_github_comment_to(record, &destination)
            .await
    }

    async fn deliver_outbox_github_comment_to(
        &self,
        record: &PulseOutboxRecord,
        destination: &str,
    ) -> Result<(), String> {
        let headers = extract_outbox_headers(&record.payload);
        let rendered_text = record
            .payload
            .get("renderedText")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| extract_outbox_message_content(&record.payload));

        let repo_hint_prelim = extract_github_repo_hint(destination);
        let api_base = self
            .resolve_outbox_github_api_base(repo_hint_prelim.as_deref())
            .await;
        let (api_url, gh_endpoint, repo_hint) =
            parse_github_comment_destination_with_base(destination, &api_base)?;
        let token = self
            .resolve_outbox_github_token(&headers, repo_hint.as_deref(), &api_url)
            .await;

        let targets_github_cloud = api_url.starts_with("https://api.github.com/");
        if token.is_none()
            && targets_github_cloud
            && let Some(endpoint) = gh_endpoint.as_deref()
            && post_github_comment_via_gh_cli(endpoint, &rendered_text)
                .await
                .is_ok()
        {
            return Ok(());
        }

        let client = build_safe_outbound_client(
            &api_url,
            self.allow_loopback_outbox,
            Duration::from_secs(5),
            None,
        )
        .await?;
        let mut req = client
            .post(&api_url)
            .header(reqwest::header::USER_AGENT, "VibeX-Pulse")
            .header(reqwest::header::ACCEPT, "application/vnd.github+json")
            .header(reqwest::header::CONTENT_TYPE, "application/json");
        if let Some(tok) = token.as_deref() {
            req = req.bearer_auth(tok);
        }
        for (k, v) in &headers {
            req = req.header(k.as_str(), v.as_str());
        }

        let body = json!({ "body": rendered_text });
        match req.json(&body).send().await {
            Ok(resp) if resp.status().is_success() => Ok(()),
            Ok(resp) => {
                let status = resp.status();
                let resp_text = resp.text().await.unwrap_or_default();
                if matches!(status.as_u16(), 401 | 403 | 404)
                    && targets_github_cloud
                    && let Some(endpoint) = gh_endpoint.as_deref()
                    && post_github_comment_via_gh_cli(endpoint, &rendered_text)
                        .await
                        .is_ok()
                {
                    return Ok(());
                }
                Err(format!(
                    "github_comment POST `{api_url}` returned HTTP {status}: {resp_text}"
                ))
            }
            Err(err) => {
                if targets_github_cloud
                    && let Some(endpoint) = gh_endpoint.as_deref()
                    && post_github_comment_via_gh_cli(endpoint, &rendered_text)
                        .await
                        .is_ok()
                {
                    return Ok(());
                }
                Err(format!("github_comment POST `{api_url}` failed: {err}"))
            }
        }
    }

    async fn resolve_outbox_github_api_base(&self, repo_hint: Option<&str>) -> String {
        if let Ok(sources) = self.pulse_engine.store().list_sources().await {
            for src in sources {
                if src.kind != EventSourceKind::Github {
                    continue;
                }
                if let Some(hint) = repo_hint
                    && let Some(src_repo) = src.config_json.get("repo").and_then(Value::as_str)
                    && !src_repo.trim().eq_ignore_ascii_case(hint)
                {
                    continue;
                }
                if let Some(base) = src
                    .config_json
                    .get("githubApiBase")
                    .or_else(|| src.config_json.get("apiBaseUrl"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    return base.trim_end_matches('/').to_string();
                }
            }
        }
        std::env::var("DIMO_GITHUB_API_BASE")
            .ok()
            .map(|s| s.trim().trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "https://api.github.com".to_string())
    }

    async fn resolve_outbox_github_token(
        &self,
        headers: &[(String, String)],
        repo_hint: Option<&str>,
        target_url: &str,
    ) -> Option<String> {
        if headers
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case("authorization"))
        {
            return None;
        }
        let target_parsed = Url::parse(target_url).ok()?;
        let target_origin = target_parsed.origin();
        if let Ok(sources) = self.pulse_engine.store().list_sources().await {
            for src in sources {
                if src.kind != EventSourceKind::Github {
                    continue;
                }
                if let Some(hint) = repo_hint
                    && let Some(src_repo) = src.config_json.get("repo").and_then(Value::as_str)
                    && !src_repo.trim().eq_ignore_ascii_case(hint)
                {
                    continue;
                }
                let source_base = src
                    .config_json
                    .get("githubApiBase")
                    .or_else(|| src.config_json.get("apiBaseUrl"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or("https://api.github.com");
                let Ok(source_url) = Url::parse(source_base) else {
                    continue;
                };
                if source_url.origin() != target_origin {
                    continue;
                }
                if let Some(tok) = src
                    .config_json
                    .get("githubToken")
                    .or_else(|| src.config_json.get("token"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    return Some(tok.to_string());
                }
            }
        }
        let is_official_github_api = target_parsed.scheme() == "https"
            && target_parsed.host_str() == Some("api.github.com")
            && target_parsed.port_or_known_default() == Some(443);
        if !is_official_github_api {
            return None;
        }
        std::env::var("GITHUB_TOKEN")
            .ok()
            .or_else(|| std::env::var("GH_TOKEN").ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }

    async fn deliver_outbox_webhook_post(&self, record: &PulseOutboxRecord) -> Result<(), String> {
        let destination = extract_outbox_destination(&record.payload);
        if destination.starts_with("http://") || destination.starts_with("https://") {
            let headers = extract_outbox_headers(&record.payload);
            let body = if let Some(rt) = record.payload.get("renderedText").and_then(Value::as_str)
            {
                match serde_json::from_str::<Value>(rt) {
                    Ok(parsed) if parsed.is_object() || parsed.is_array() => parsed,
                    _ => json!({
                        "text": rt,
                        "ruleId": record.payload.get("ruleId"),
                        "ruleName": record.payload.get("ruleName"),
                        "eventId": record.payload.get("eventId"),
                        "eventType": record.payload.get("eventType"),
                        "threadKey": record.payload.get("threadKey"),
                        "payload": record.payload.get("payload"),
                    }),
                }
            } else {
                record
                    .payload
                    .get("payload")
                    .unwrap_or(&record.payload)
                    .clone()
            };
            post_json_webhook(&destination, &body, &headers, self.allow_loopback_outbox).await
        } else {
            Err(format!(
                "webhook_post destination `{destination}` must be an http(s) URL"
            ))
        }
    }

    async fn deliver_outbox_reply_channel(&self, record: &PulseOutboxRecord) -> Result<(), String> {
        let raw_dest = extract_outbox_destination(&record.payload);
        let destination = if raw_dest.is_empty()
            || raw_dest.eq_ignore_ascii_case("auto")
            || raw_dest.eq_ignore_ascii_case("reply")
        {
            extract_reply_channel_destination(&record.payload).unwrap_or(raw_dest)
        } else {
            raw_dest
        };
        let channel_hint = record
            .payload
            .get("channelHint")
            .or_else(|| record.payload.get("channel_hint"))
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");

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
        } else if channel_hint.eq_ignore_ascii_case("github_comment")
            || destination.starts_with("github:")
            || looks_like_github_comment_target(&destination)
        {
            let target = if destination.is_empty() {
                extract_reply_channel_destination(&record.payload).unwrap_or(destination)
            } else {
                destination
            };
            self.deliver_outbox_github_comment_to(record, &target).await
        } else if destination.starts_with("http://") || destination.starts_with("https://") {
            let headers = extract_outbox_headers(&record.payload);
            let body = if let Some(rt) = record.payload.get("renderedText").and_then(Value::as_str)
            {
                json!({
                    "text": rt,
                    "ruleId": record.payload.get("ruleId"),
                    "eventId": record.payload.get("eventId"),
                    "threadKey": record.payload.get("threadKey"),
                })
            } else {
                record
                    .payload
                    .get("payload")
                    .unwrap_or(&record.payload)
                    .clone()
            };
            post_json_webhook(&destination, &body, &headers, self.allow_loopback_outbox).await
        } else if matches!(
            record.target_kind.as_str(),
            "user_interaction_mirror" | "im_reaction_ack"
        ) {
            tracing::debug!(
                target_kind = %record.target_kind,
                destination = %destination,
                "outbox best-effort auxiliary target has no external endpoint; skipping"
            );
            Ok(())
        } else {
            Err(format!(
                "unsupported reply_channel destination `{destination}` (channelHint `{channel_hint}`)"
            ))
        }
    }
}

fn extract_reply_channel_destination(payload: &Value) -> Option<String> {
    let from_rc = |rc: &Value| -> Option<String> {
        if let Some(s) = rc.as_str().map(str::trim).filter(|s| !s.is_empty()) {
            return Some(s.to_string());
        }
        let obj = rc.as_object()?;
        let source_kind = obj
            .get("sourceKind")
            .or_else(|| obj.get("source_kind"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let thread_id = obj
            .get("threadId")
            .or_else(|| obj.get("thread_id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let channel_id = obj
            .get("channelId")
            .or_else(|| obj.get("channel_id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        if source_kind.eq_ignore_ascii_case("github") {
            return thread_id
                .map(str::to_string)
                .or_else(|| channel_id.map(|c| c.to_string()));
        }
        thread_id.or(channel_id).map(str::to_string)
    };

    if let Some(rc) = payload
        .get("replyChannel")
        .or_else(|| payload.get("reply_channel"))
        && let Some(found) = from_rc(rc)
    {
        return Some(found);
    }
    if let Some(rc) = payload
        .get("replyChannels")
        .or_else(|| payload.get("reply_channels"))
        .and_then(|v| v.get(0))
        && let Some(found) = from_rc(rc)
    {
        return Some(found);
    }
    payload
        .get("threadKey")
        .or_else(|| payload.get("thread_key"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn looks_like_github_comment_target(destination: &str) -> bool {
    let trimmed = destination
        .trim()
        .strip_prefix("github:")
        .unwrap_or(destination.trim())
        .trim();
    if trimmed.contains("api.github.com/repos/") {
        return true;
    }
    if let Some((repo, num)) = trimmed.split_once('#') {
        let segs: Vec<&str> = repo.trim().split('/').filter(|s| !s.is_empty()).collect();
        return segs.len() == 2
            && !num.trim().is_empty()
            && num.trim().chars().all(|c| c.is_ascii_digit());
    }
    if let Some((repo, sha)) = trimmed.split_once('@') {
        let segs: Vec<&str> = repo.trim().split('/').filter(|s| !s.is_empty()).collect();
        return segs.len() == 2 && !sha.trim().is_empty() && !sha.contains('/');
    }
    false
}

fn extract_github_repo_hint(destination: &str) -> Option<String> {
    let trimmed = destination
        .trim()
        .strip_prefix("github:")
        .unwrap_or(destination.trim())
        .trim();
    if let Some((_, after_repos)) = trimmed.split_once("/repos/") {
        let segs: Vec<&str> = after_repos.split('/').filter(|s| !s.is_empty()).collect();
        if segs.len() >= 2 {
            return Some(format!("{}/{}", segs[0], segs[1]));
        }
    }
    if let Some((repo_part, _)) = trimmed.split_once('#').or_else(|| trimmed.split_once('@')) {
        let segs: Vec<&str> = repo_part
            .trim()
            .trim_matches('/')
            .split('/')
            .filter(|s| !s.is_empty())
            .collect();
        if segs.len() == 2 {
            return Some(format!("{}/{}", segs[0], segs[1]));
        }
    }
    None
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

fn extract_outbox_headers(payload: &Value) -> Vec<(String, String)> {
    let Some(obj) = payload.get("headers").and_then(Value::as_object) else {
        return Vec::new();
    };
    obj.iter()
        .filter_map(|(k, v)| {
            let key = k.trim();
            let val = v.as_str()?.trim();
            if key.is_empty() {
                None
            } else {
                Some((key.to_string(), val.to_string()))
            }
        })
        .collect()
}

fn extract_outbox_message_content(payload: &Value) -> String {
    if let Some(rt) = payload.get("renderedText").and_then(Value::as_str) {
        return rt.to_string();
    }
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

fn parse_github_comment_destination_with_base(
    destination: &str,
    api_base: &str,
) -> Result<(String, Option<String>, Option<String>), String> {
    let trimmed = destination
        .trim()
        .strip_prefix("github:")
        .unwrap_or(destination.trim())
        .trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        let dest_url = Url::parse(trimmed)
            .map_err(|err| format!("invalid github_comment URL `{trimmed}`: {err}"))?;
        let base_url = Url::parse(api_base.trim())
            .map_err(|err| format!("invalid GitHub apiBaseUrl `{api_base}`: {err}"))?;
        if dest_url.origin() != base_url.origin() {
            return Err(format!(
                "github_comment URL `{trimmed}` origin does not match configured GitHub API origin `{api_base}`"
            ));
        }
        let gh_endpoint = trimmed
            .split("/repos/")
            .nth(1)
            .map(|p| format!("repos/{}", p.trim_start_matches('/')))
            .filter(|p| p.len() > "repos/".len());
        let repo_hint = gh_endpoint.as_deref().and_then(|ep| {
            let segs: Vec<&str> = ep.split('/').collect();
            if segs.len() >= 3 && segs[0] == "repos" {
                Some(format!("{}/{}", segs[1], segs[2]))
            } else {
                None
            }
        });
        return Ok((trimmed.to_string(), gh_endpoint, repo_hint));
    }

    let base = api_base.trim().trim_end_matches('/');
    if let Some((repo_part, num_part)) = trimmed.split_once('#') {
        let repo = repo_part.trim().trim_matches('/');
        let number = num_part.trim();
        let segs: Vec<&str> = repo.split('/').filter(|s| !s.is_empty()).collect();
        if segs.len() == 2 && !number.is_empty() && number.chars().all(|c| c.is_ascii_digit()) {
            let norm_repo = format!("{}/{}", segs[0], segs[1]);
            let endpoint = format!("repos/{norm_repo}/issues/{number}/comments");
            let url = format!("{base}/{endpoint}");
            return Ok((url, Some(endpoint), Some(norm_repo)));
        }
    }

    if let Some((repo_part, sha_part)) = trimmed.split_once('@') {
        let repo = repo_part.trim().trim_matches('/');
        let sha = sha_part.trim();
        let segs: Vec<&str> = repo.split('/').filter(|s| !s.is_empty()).collect();
        if segs.len() == 2
            && !sha.is_empty()
            && !sha.contains('/')
            && !sha.contains(char::is_whitespace)
        {
            let norm_repo = format!("{}/{}", segs[0], segs[1]);
            let endpoint = format!("repos/{norm_repo}/commits/{sha}/comments");
            let url = format!("{base}/{endpoint}");
            return Ok((url, Some(endpoint), Some(norm_repo)));
        }
    }

    Err(format!(
        "invalid github_comment destination `{trimmed}` (expected `owner/repo#number`, `owner/repo@sha`, or `http(s)://.../comments`)"
    ))
}

async fn post_github_comment_via_gh_cli(endpoint: &str, body: &str) -> Result<(), String> {
    let body_arg = format!("body={body}");
    let child = tokio::process::Command::new("gh")
        .args(["api", endpoint, "-f", &body_arg])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|err| format!("failed to spawn `gh api`: {err}"))?;
    let output = tokio::time::timeout(Duration::from_secs(8), child.wait_with_output())
        .await
        .map_err(|_| "`gh api` timed out after 8s".to_string())?
        .map_err(|err| format!("`gh api` failed: {err}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("`gh api {endpoint}` failed: {}", stderr.trim()))
    }
}

async fn post_json_webhook(
    url: &str,
    body: &Value,
    headers: &[(String, String)],
    allow_loopback: bool,
) -> Result<(), String> {
    let client =
        build_safe_outbound_client(url, allow_loopback, Duration::from_secs(5), None).await?;
    let mut req = client
        .post(url)
        .header(reqwest::header::CONTENT_TYPE, "application/json");
    for (k, v) in headers {
        req = req.header(k.as_str(), v.as_str());
    }
    let response = req
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

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    use serde_json::json;

    use super::{
        extract_reply_channel_destination, is_forbidden_ip, looks_like_github_comment_target,
        parse_github_comment_destination_with_base, validate_outbound_url_syntax,
    };

    #[test]
    fn extract_reply_channel_destination_handles_strings_and_reply_channel_objects() {
        assert_eq!(
            extract_reply_channel_destination(&json!({
                "replyChannel": {
                    "sourceKind": "github",
                    "instanceId": "gh-1",
                    "channelId": "acme/dimo#42",
                    "threadId": "github:acme/dimo#42"
                }
            }))
            .as_deref(),
            Some("github:acme/dimo#42")
        );
        assert_eq!(
            extract_reply_channel_destination(&json!({
                "replyChannels": [{
                    "sourceKind": "github",
                    "channelId": "acme/dimo@abc1234"
                }]
            }))
            .as_deref(),
            Some("acme/dimo@abc1234")
        );
        assert_eq!(
            extract_reply_channel_destination(&json!({
                "threadKey": "github:acme/dimo#7"
            }))
            .as_deref(),
            Some("github:acme/dimo#7")
        );
    }

    #[test]
    fn parse_github_comment_destination_supports_pr_and_commit_with_custom_base() {
        assert!(looks_like_github_comment_target("github:acme/dimo#42"));
        assert!(looks_like_github_comment_target("acme/dimo@deadbeef"));
        assert!(!looks_like_github_comment_target("space:ops"));

        let (url, ep, repo) = parse_github_comment_destination_with_base(
            "github:acme/dimo#42",
            "http://127.0.0.1:8888",
        )
        .expect("pr destination");
        assert_eq!(
            url,
            "http://127.0.0.1:8888/repos/acme/dimo/issues/42/comments"
        );
        assert_eq!(ep.as_deref(), Some("repos/acme/dimo/issues/42/comments"));
        assert_eq!(repo.as_deref(), Some("acme/dimo"));

        let (commit_url, commit_ep, commit_repo) = parse_github_comment_destination_with_base(
            "github:acme/dimo@abc1234",
            "https://api.github.com",
        )
        .expect("commit destination");
        assert_eq!(
            commit_url,
            "https://api.github.com/repos/acme/dimo/commits/abc1234/comments"
        );
        assert_eq!(
            commit_ep.as_deref(),
            Some("repos/acme/dimo/commits/abc1234/comments")
        );
        assert_eq!(commit_repo.as_deref(), Some("acme/dimo"));
    }

    #[test]
    fn ssrf_validator_blocks_private_metadata_and_cross_origin_targets() {
        assert!(is_forbidden_ip(
            IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)),
            false
        ));
        assert!(!is_forbidden_ip(
            IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)),
            true
        ));
        assert!(is_forbidden_ip(
            IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254)),
            true
        ));
        assert!(is_forbidden_ip(
            IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1)),
            true
        ));
        assert!(is_forbidden_ip(
            IpAddr::V4(Ipv4Addr::new(10, 0, 0, 5)),
            true
        ));
        assert!(is_forbidden_ip(
            IpAddr::V6("::ffff:169.254.169.254".parse::<Ipv6Addr>().unwrap()),
            true
        ));
        assert!(is_forbidden_ip(
            IpAddr::V6("fe80::1".parse::<Ipv6Addr>().unwrap()),
            false
        ));
        assert!(is_forbidden_ip(
            IpAddr::V6("fc00::1".parse::<Ipv6Addr>().unwrap()),
            false
        ));
        assert!(!is_forbidden_ip(
            IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8)),
            false
        ));

        assert!(validate_outbound_url_syntax("http://169.254.169.254/latest", false).is_err());
        assert!(validate_outbound_url_syntax("http://[::ffff:127.0.0.1]/admin", false).is_err());
        assert!(validate_outbound_url_syntax("http://user:pass@example.com/hook", false).is_err());
        assert!(validate_outbound_url_syntax("file:///etc/passwd", false).is_err());
        assert!(
            validate_outbound_url_syntax("https://hooks.feishu.cn/open-apis/bot/v2/hook/1", false)
                .is_ok()
        );

        assert!(
            parse_github_comment_destination_with_base(
                "https://attacker.example/repos/acme/dimo/issues/1/comments",
                "https://api.github.com",
            )
            .is_err()
        );
    }
}
