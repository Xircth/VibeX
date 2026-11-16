//! AI-Native Pulse MCP toolset (`pulse_*`) with exhaustive No-Fail-Fast
//! validation, secret redaction, anti-loop hop guards, and `MandateOrigin`
//! provenance enforcement.

use std::sync::{
    Mutex,
    atomic::{AtomicU64, Ordering},
};

use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::pulse_eval::{
    evaluate_pulse_rule_dry_run, is_valid_event_type, is_valid_thread_key, str_field,
    validate_json_schema_node, validate_payload_against_schema, validate_pulse_rule_spec,
    violation,
};

const PULSE_TOOL_SCHEMA: &str = include_str!("../pulse_tool_schema.json");
pub const MAX_HOP_COUNT: u32 = 5;

static PULSE_SEQ: AtomicU64 = AtomicU64::new(1);

pub const PULSE_TOOL_NAMES: &[&str] = &[
    "pulse_catalog_inspect",
    "pulse_event_define",
    "pulse_event_emit",
    "pulse_timer_schedule",
    "pulse_rule_propose_or_save",
    "pulse_rule_dry_run",
    "pulse_thread_subscribe",
];

pub fn is_pulse_tool(name: &str) -> bool {
    PULSE_TOOL_NAMES.contains(&name)
}

pub fn pulse_tool_schemas() -> Vec<Value> {
    serde_json::from_str(PULSE_TOOL_SCHEMA).expect("embedded pulse_tool_schema.json is valid")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MandateOrigin {
    ExplicitHuman,
    TrustedInternal,
    UntrustedExternal,
}

impl MandateOrigin {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "explicit_human" | "explicithuman" | "human" => Some(Self::ExplicitHuman),
            "trusted_internal" | "trustedinternal" | "internal" => Some(Self::TrustedInternal),
            "untrusted_external" | "untrustedexternal" | "external" | "untrusted" => {
                Some(Self::UntrustedExternal)
            }
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::ExplicitHuman => "explicit_human",
            Self::TrustedInternal => "trusted_internal",
            Self::UntrustedExternal => "untrusted_external",
        }
    }

    fn privilege_rank(self) -> u8 {
        match self {
            Self::UntrustedExternal => 0,
            Self::TrustedInternal => 1,
            Self::ExplicitHuman => 2,
        }
    }

    pub fn combine_least_privilege(self, other: Self) -> Self {
        if self.privilege_rank() <= other.privilege_rank() {
            self
        } else {
            other
        }
    }
}

/// Resolves caller `MandateOrigin` across process env (`DIMO_MANDATE_ORIGIN`),
/// MCP request `_meta`, and optional arguments using strict least-privilege
/// intersection so an `untrusted_external` turn can never escalate itself.
pub fn resolve_mandate_origin(
    env_override: Option<&str>,
    meta: Option<&Value>,
    arguments: Option<&Value>,
) -> MandateOrigin {
    let mut resolved: Option<MandateOrigin> = None;
    let mut observe = |candidate: Option<MandateOrigin>| {
        if let Some(origin) = candidate {
            resolved = Some(match resolved {
                Some(existing) => existing.combine_least_privilege(origin),
                None => origin,
            });
        }
    };

    let env_val = env_override
        .map(str::to_owned)
        .or_else(|| std::env::var("DIMO_MANDATE_ORIGIN").ok())
        .or_else(|| std::env::var("VIBEX_MANDATE_ORIGIN").ok());
    if let Some(raw) = env_val.as_deref() {
        if let Some(parsed) = MandateOrigin::parse(raw) {
            observe(Some(parsed));
        } else if !raw.trim().is_empty() {
            observe(Some(MandateOrigin::UntrustedExternal));
        }
    }

    for container in [meta, arguments].into_iter().flatten() {
        for key in ["mandate_origin", "mandateOrigin"] {
            if let Some(raw) = container.get(key).and_then(Value::as_str) {
                observe(Some(
                    MandateOrigin::parse(raw).unwrap_or(MandateOrigin::UntrustedExternal),
                ));
            }
        }
    }

    resolved.unwrap_or(MandateOrigin::ExplicitHuman)
}

const SECRET_KEY_NAMES: &[&str] = &[
    "signing_secret",
    "signingsecret",
    "webhook_secret",
    "webhooksecret",
    "secret",
    "secret_ciphertext",
    "secretciphertext",
    "client_secret",
    "clientsecret",
    "app_secret",
    "appsecret",
    "signing_key",
    "signingkey",
];

/// Recursively scrubs signing secrets (`signing_secret`, `whsec_*`, etc.) from
/// any catalog, source, or rule JSON payload before returning to an Agent.
pub fn redact_secrets(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                let normalized = key.to_ascii_lowercase();
                if SECRET_KEY_NAMES.contains(&normalized.as_str()) {
                    if !child.is_null() {
                        *child = Value::String("[REDACTED]".to_string());
                    }
                } else {
                    redact_secrets(child);
                }
            }
        }
        Value::Array(items) => {
            for item in items.iter_mut() {
                redact_secrets(item);
            }
        }
        Value::String(text) => {
            if text.trim_start().starts_with("whsec_") {
                *text = "whsec_[REDACTED]".to_string();
            }
        }
        _ => {}
    }
}

/// Companion-side Pulse catalog & state store used when running standalone or
/// alongside Host HTTP calls.
pub struct PulseState {
    inner: Mutex<PulseStoreInner>,
}

struct PulseStoreInner {
    sources: Vec<Value>,
    schemas: Vec<Value>,
    bots: Vec<Value>,
    groups: Vec<Value>,
    rules: Vec<Value>,
    subscriptions: Vec<Value>,
    emitted_events: Vec<Value>,
}

impl Default for PulseState {
    fn default() -> Self {
        Self::new()
    }
}

impl PulseState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(PulseStoreInner {
                sources: default_builtin_sources(),
                schemas: default_builtin_schemas(),
                bots: Vec::new(),
                groups: Vec::new(),
                rules: Vec::new(),
                subscriptions: Vec::new(),
                emitted_events: Vec::new(),
            }),
        }
    }

    #[cfg(test)]
    pub fn seed_source(&self, source: Value) {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .sources
            .push(source);
    }

    pub fn execute_tool(
        &self,
        name: &str,
        arguments: &Value,
        meta: Option<&Value>,
        env_mandate_override: Option<&str>,
    ) -> Result<Value, String> {
        match name {
            "pulse_catalog_inspect" => Ok(self.catalog_inspect(arguments)),
            "pulse_event_define" => Ok(self.event_define(arguments)),
            "pulse_event_emit" => Ok(self.event_emit(arguments, meta, env_mandate_override)),
            "pulse_timer_schedule" => {
                Ok(self.timer_schedule(arguments, meta, env_mandate_override))
            }
            "pulse_rule_propose_or_save" => {
                Ok(self.rule_propose_or_save(arguments, meta, env_mandate_override))
            }
            "pulse_rule_dry_run" => Ok(self.rule_dry_run(arguments)),
            "pulse_thread_subscribe" => Ok(self.thread_subscribe(arguments)),
            other => Err(format!("unknown pulse tool: {other}")),
        }
    }

    fn catalog_inspect(&self, arguments: &Value) -> Value {
        let category = str_field(arguments, &["category"]).unwrap_or("all");
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());

        let mut payload = Map::new();
        if matches!(category, "all" | "sources") {
            payload.insert("sources".into(), Value::Array(guard.sources.clone()));
        }
        if matches!(category, "all" | "schemas") {
            payload.insert("eventSchemas".into(), Value::Array(guard.schemas.clone()));
        }
        if matches!(category, "all" | "targets") {
            payload.insert("bots".into(), Value::Array(guard.bots.clone()));
            payload.insert("groups".into(), Value::Array(guard.groups.clone()));
        }
        if matches!(category, "all" | "presets") {
            payload.insert("workflowPresets".into(), workflow_presets_catalog());
        }

        let mut result = Value::Object(payload);
        redact_secrets(&mut result);
        result
    }

    fn event_define(&self, arguments: &Value) -> Value {
        let event_type = str_field(arguments, &["event_type", "eventType"])
            .unwrap_or("")
            .trim()
            .to_string();
        let summary = str_field(arguments, &["summary"])
            .unwrap_or("")
            .trim()
            .to_string();
        let json_schema = arguments
            .get("json_schema")
            .or_else(|| arguments.get("jsonSchema"))
            .cloned()
            .unwrap_or(Value::Null);

        let mut violations = Vec::new();
        if !is_valid_event_type(&event_type) {
            violations.push(violation(
                "event_type",
                "invalid_event_type",
                "event_type must be a dot-namespaced lowercase identifier (e.g. 'ci.coverage.dropped').",
            ));
        }
        if summary.is_empty() {
            violations.push(violation(
                "summary",
                "empty_summary",
                "summary is required.",
            ));
        }
        validate_json_schema_node(&json_schema, "json_schema", 0, &mut violations);

        if !violations.is_empty() {
            return json!({
                "isError": true,
                "valid": false,
                "violations": violations,
                "text": format!("Event schema validation failed with {} violation(s).", violations.len()),
            });
        }

        let view = json!({
            "eventType": event_type,
            "summary": summary,
            "jsonSchema": json_schema,
            "builtIn": false,
            "updatedAt": now_iso_placeholder(),
        });

        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = guard
            .schemas
            .iter_mut()
            .find(|item| item.get("eventType").and_then(Value::as_str) == Some(&event_type))
        {
            *existing = view.clone();
        } else {
            guard.schemas.push(view.clone());
        }

        view
    }

    fn event_emit(
        &self,
        arguments: &Value,
        meta: Option<&Value>,
        env_mandate_override: Option<&str>,
    ) -> Value {
        let event_type = str_field(arguments, &["event_type", "eventType"])
            .unwrap_or("")
            .trim()
            .to_string();
        let payload = arguments
            .get("payload")
            .cloned()
            .unwrap_or_else(|| json!({}));

        let mut violations = Vec::new();
        if !is_valid_event_type(&event_type) {
            violations.push(violation(
                "event_type",
                "invalid_event_type",
                "event_type must be a dot-namespaced lowercase identifier.",
            ));
        }
        if let Some(tk) = str_field(arguments, &["thread_key", "threadKey"])
            && !tk.trim().is_empty()
            && !is_valid_thread_key(tk.trim())
        {
            violations.push(violation(
                "thread_key",
                "invalid_thread_key",
                "thread_key must follow '<platform>:<id>' format (e.g. 'jira:PROJ-123').",
            ));
        }

        let registered_schema = {
            let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            guard
                .schemas
                .iter()
                .find(|s| s.get("eventType").and_then(Value::as_str) == Some(&event_type))
                .and_then(|s| s.get("jsonSchema").cloned())
        };
        if let Some(schema) = registered_schema {
            validate_payload_against_schema(&schema, &payload, "payload", &mut violations);
        }

        let hop_count = compute_effective_hop_count(arguments, meta);

        if hop_count > MAX_HOP_COUNT {
            return hop_limit_exceeded_error(&event_type, hop_count);
        }

        if !violations.is_empty() {
            return json!({
                "isError": true,
                "valid": false,
                "violations": violations,
                "text": format!("Event emit validation failed with {} violation(s).", violations.len()),
            });
        }

        let mandate = resolve_mandate_origin(env_mandate_override, meta, Some(arguments));
        let trust_level = match mandate {
            MandateOrigin::UntrustedExternal => "untrusted_external",
            MandateOrigin::TrustedInternal | MandateOrigin::ExplicitHuman => "trusted_internal",
        };

        let seq = PULSE_SEQ.fetch_add(1, Ordering::Relaxed);
        let event_id = format!("evt_{}_{}", Uuid::new_v4().simple(), seq);
        let delivery_id = str_field(arguments, &["delivery_id", "deliveryId"])
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("dlv_{}", Uuid::new_v4().simple()));
        let source_instance_id =
            str_field(arguments, &["source_instance_id", "sourceInstanceId"])
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("dimo-mcp");
        let root_event_id = meta
            .and_then(|m| m.get("root_event_id").or_else(|| m.get("rootEventId")))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| event_id.clone());
        let correlations = arguments
            .get("correlations")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(|s| Value::String(s.to_string()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let envelope = json!({
            "eventId": event_id,
            "deliveryId": delivery_id,
            "source": {
                "kind": "sdk_custom",
                "instanceId": source_instance_id,
                "trustLevel": trust_level,
            },
            "eventType": event_type,
            "occurredAt": now_iso_placeholder(),
            "actor": {
                "id": "agent-session",
                "displayName": null,
                "roles": [],
                "isBot": true,
                "isSelf": false,
            },
            "threadKey": str_field(arguments, &["thread_key", "threadKey"]).map(str::trim).filter(|s| !s.is_empty()),
            "correlations": correlations,
            "replyChannels": [],
            "trace": {
                "rootEventId": root_event_id,
                "parentRunId": meta.and_then(|m| m.get("parent_run_id")).and_then(Value::as_str),
                "hopCount": hop_count,
            },
            "payload": payload,
        });

        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .emitted_events
            .push(envelope.clone());

        envelope
    }

    fn timer_schedule(
        &self,
        arguments: &Value,
        meta: Option<&Value>,
        env_mandate_override: Option<&str>,
    ) -> Value {
        let synthesized = synthesize_timer_rule_args(arguments);
        self.save_or_propose_rule_internal(&synthesized, arguments, meta, env_mandate_override)
    }

    fn rule_propose_or_save(
        &self,
        arguments: &Value,
        meta: Option<&Value>,
        env_mandate_override: Option<&str>,
    ) -> Value {
        self.save_or_propose_rule_internal(arguments, arguments, meta, env_mandate_override)
    }

    fn save_or_propose_rule_internal(
        &self,
        normalized_args: &Value,
        raw_caller_args: &Value,
        meta: Option<&Value>,
        env_mandate_override: Option<&str>,
    ) -> Value {
        let prepared = match prepare_rule_save(
            normalized_args,
            raw_caller_args,
            meta,
            env_mandate_override,
        ) {
            Ok(prepared) => prepared,
            Err(validation_err) => return validation_err,
        };

        let rule_id = prepared
            .id
            .unwrap_or_else(|| format!("rule_{}", Uuid::new_v4().simple()));

        let mut rule_view = json!({
            "id": rule_id,
            "revision": 1,
            "enabled": prepared.enabled,
            "draftOnly": prepared.draft_only,
            "mandateOrigin": prepared.mandate_origin.as_str(),
            "spec": prepared.spec,
            "webhookRouteId": prepared.webhook_route_id,
            "nextFireAt": null,
            "matchedCount": 0,
            "observedCount": 0,
            "createdAt": now_iso_placeholder(),
            "updatedAt": now_iso_placeholder(),
        });

        redact_secrets(&mut rule_view);

        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = guard
            .rules
            .iter_mut()
            .find(|r| r.get("id").and_then(Value::as_str) == Some(&rule_id))
        {
            let next_rev = existing
                .get("revision")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                + 1;
            if let Some(obj) = rule_view.as_object_mut() {
                obj.insert("revision".into(), json!(next_rev));
            }
            *existing = rule_view.clone();
        } else {
            guard.rules.push(rule_view.clone());
        }

        let mut response = json!({
            "rule": rule_view,
            "valid": true,
            "violations": [],
        });
        if let Some(notice) = prepared.security_notice
            && let Some(obj) = response.as_object_mut()
        {
            obj.insert("notice".into(), notice.clone());
            obj.insert("securityNotice".into(), notice);
        }
        redact_secrets(&mut response);
        response
    }

    fn rule_dry_run(&self, arguments: &Value) -> Value {
        let spec = arguments.get("spec").cloned().unwrap_or(Value::Null);
        let sample_event = arguments
            .get("sample_event")
            .or_else(|| arguments.get("sampleEvent"))
            .cloned()
            .unwrap_or(Value::Null);
        evaluate_pulse_rule_dry_run(&spec, &sample_event)
    }

    fn thread_subscribe(&self, arguments: &Value) -> Value {
        let action = str_field(arguments, &["action"]).unwrap_or("subscribe");
        match action {
            "subscribe" => {
                let thread_key = str_field(arguments, &["thread_key", "threadKey"])
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let subscriber_kind = str_field(arguments, &["subscriber_kind", "subscriberKind"])
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let subscriber_id = str_field(arguments, &["subscriber_id", "subscriberId"])
                    .unwrap_or("")
                    .trim()
                    .to_string();

                let mut violations = Vec::new();
                if !is_valid_thread_key(&thread_key) {
                    violations.push(violation(
                        "thread_key",
                        "invalid_thread_key",
                        "thread_key must follow '<platform>:<id>' format (e.g. 'jira:PROJ-123', 'github:org/repo#42', 'feishu:om_xxx').",
                    ));
                }
                if !matches!(
                    subscriber_kind.as_str(),
                    "session" | "bot" | "group" | "workflow"
                ) {
                    violations.push(violation(
                        "subscriber_kind",
                        "invalid_subscriber_kind",
                        "subscriber_kind must be 'session', 'bot', 'group', or 'workflow'.",
                    ));
                }
                if subscriber_id.is_empty() {
                    violations.push(violation(
                        "subscriber_id",
                        "missing_subscriber_id",
                        "subscriber_id is required.",
                    ));
                }
                if !violations.is_empty() {
                    return json!({
                        "isError": true,
                        "violations": violations,
                        "text": format!("Thread subscription failed with {} violation(s).", violations.len()),
                    });
                }

                let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(existing) = guard.subscriptions.iter_mut().find(|sub| {
                    sub.get("threadKey").and_then(Value::as_str) == Some(&thread_key)
                        && sub.get("subscriberKind").and_then(Value::as_str)
                            == Some(&subscriber_kind)
                        && sub.get("subscriberId").and_then(Value::as_str) == Some(&subscriber_id)
                }) {
                    if let Some(obj) = existing.as_object_mut() {
                        obj.insert("active".into(), json!(true));
                    }
                    return existing.clone();
                }

                let sub_view = json!({
                    "id": format!("sub_{}", Uuid::new_v4().simple()),
                    "threadKey": thread_key,
                    "subscriberKind": subscriber_kind,
                    "subscriberId": subscriber_id,
                    "active": true,
                    "createdAt": now_iso_placeholder(),
                });
                guard.subscriptions.push(sub_view.clone());
                sub_view
            }
            "unsubscribe" => {
                let subscription_id = str_field(arguments, &["subscription_id", "subscriptionId"]);
                let thread_key = str_field(arguments, &["thread_key", "threadKey"]);
                let subscriber_id = str_field(arguments, &["subscriber_id", "subscriberId"]);

                if subscription_id.is_none() && (thread_key.is_none() || subscriber_id.is_none()) {
                    return json!({
                        "isError": true,
                        "violations": [violation(
                            "subscription_id",
                            "missing_unsubscribe_selector",
                            "Provide subscription_id or both thread_key and subscriber_id to unsubscribe.",
                        )],
                        "text": "Missing subscription selector for unsubscribe.",
                    });
                }

                let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
                let mut matched = None;
                for sub in guard.subscriptions.iter_mut() {
                    let id_hit = subscription_id.is_some()
                        && sub.get("id").and_then(Value::as_str) == subscription_id;
                    let key_hit = thread_key.is_some()
                        && subscriber_id.is_some()
                        && sub.get("threadKey").and_then(Value::as_str) == thread_key
                        && sub.get("subscriberId").and_then(Value::as_str) == subscriber_id;
                    if id_hit || key_hit {
                        if let Some(obj) = sub.as_object_mut() {
                            obj.insert("active".into(), json!(false));
                        }
                        matched = Some(sub.clone());
                        break;
                    }
                }

                matched.unwrap_or_else(|| {
                    json!({
                        "unsubscribed": true,
                        "subscriptionId": subscription_id,
                        "threadKey": thread_key,
                        "active": false,
                    })
                })
            }
            other => json!({
                "isError": true,
                "violations": [violation("action", "invalid_action", &format!("Unsupported action '{other}'; expected 'subscribe' or 'unsubscribe'."))],
                "text": format!("Unsupported action '{other}'."),
            }),
        }
    }
}

pub(crate) struct PreparedRuleSave {
    pub id: Option<String>,
    pub enabled: bool,
    pub draft_only: bool,
    pub mandate_origin: MandateOrigin,
    pub webhook_route_id: Option<String>,
    pub spec: Value,
    pub security_notice: Option<Value>,
}

pub(crate) fn bool_field(value: &Value, keys: &[&str]) -> Option<bool> {
    for key in keys {
        if let Some(found) = value.get(*key).and_then(Value::as_bool) {
            return Some(found);
        }
    }
    None
}

pub(crate) fn compute_effective_hop_count(arguments: &Value, meta: Option<&Value>) -> u32 {
    let parent_env_hop = std::env::var("DIMO_PULSE_HOP_COUNT")
        .ok()
        .or_else(|| std::env::var("VIBEX_PULSE_HOP_COUNT").ok())
        .and_then(|v| v.trim().parse::<u32>().ok());
    let meta_parent_hop = meta
        .and_then(|m| m.get("parent_hop_count").or_else(|| m.get("hopCount")))
        .and_then(Value::as_u64)
        .map(|v| v as u32);
    let explicit_hop = arguments
        .get("hop_count")
        .or_else(|| arguments.get("hopCount"))
        .and_then(Value::as_u64)
        .map(|v| v as u32);

    match (parent_env_hop.or(meta_parent_hop), explicit_hop) {
        (Some(parent), Some(explicit)) => (parent.saturating_add(1)).max(explicit),
        (Some(parent), None) => parent.saturating_add(1),
        (None, Some(explicit)) => explicit,
        (None, None) => 0,
    }
}

pub(crate) fn hop_limit_exceeded_error(event_type: &str, hop_count: u32) -> Value {
    json!({
        "isError": true,
        "error_code": "hop_limit_exceeded",
        "hopCount": hop_count,
        "maxHopCount": MAX_HOP_COUNT,
        "text": format!(
            "Pulse anti-loop guard rejected event '{}': hopCount {} exceeds maximum {}.",
            event_type, hop_count, MAX_HOP_COUNT
        ),
    })
}

pub(crate) fn synthesize_timer_rule_args(arguments: &Value) -> Value {
    let id = str_field(arguments, &["id"])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let name = str_field(arguments, &["name"]).unwrap_or("").to_string();
    let description = str_field(arguments, &["description"]).map(str::to_string);
    let eval_mode = str_field(arguments, &["eval_mode", "evalMode"]).unwrap_or("observe");
    let temporal = arguments.get("temporal").cloned().unwrap_or(Value::Null);
    let targets = arguments
        .get("targets")
        .cloned()
        .or_else(|| {
            arguments
                .get("target")
                .cloned()
                .map(|single| json!([single]))
        })
        .unwrap_or_else(|| json!([]));

    let source_kind = match temporal.get("kind").and_then(Value::as_str) {
        Some("cron" | "time_cron") => "time_cron",
        Some("once" | "time_once") => "time_once",
        Some("interval" | "time_interval") => "time_interval",
        Some("inactivity_sla" | "time_sla") => "time_sla",
        _ => "time_cron",
    };

    let mut normalized_temporal = temporal;
    if let Some(obj) = normalized_temporal.as_object_mut()
        && let Some(kind_str) = obj.get("kind").and_then(Value::as_str)
    {
        let canonical = match kind_str {
            "time_cron" => "cron",
            "time_once" => "once",
            "time_interval" => "interval",
            "time_sla" => "inactivity_sla",
            other => other,
        };
        obj.insert("kind".into(), json!(canonical));
    }

    let draft_only = bool_field(
        arguments,
        &["draft_only", "draftOnly", "propose_only", "proposeOnly"],
    )
    .unwrap_or(false);

    let mut synthesized = json!({
        "enabled": bool_field(arguments, &["enabled"]).unwrap_or(true),
        "draft_only": draft_only,
        "spec": {
            "name": name,
            "description": description,
            "evalMode": eval_mode,
            "orchestrator": "direct_reflex",
            "filter": {
                "sourceKinds": [source_kind],
                "sourceInstanceIds": [],
                "eventTypes": [],
                "allowedActors": [],
                "conditions": [],
            },
            "temporal": normalized_temporal,
            "debounceMs": 0,
            "claimExclusive": false,
            "targets": targets,
        }
    });
    if let Some(id) = id
        && let Some(obj) = synthesized.as_object_mut()
    {
        obj.insert("id".into(), json!(id));
    }
    synthesized
}

pub(crate) fn prepare_rule_save(
    normalized_args: &Value,
    raw_caller_args: &Value,
    meta: Option<&Value>,
    env_mandate_override: Option<&str>,
) -> Result<PreparedRuleSave, Value> {
    let raw_spec = normalized_args
        .get("spec")
        .cloned()
        .unwrap_or_else(|| normalized_args.clone());
    let mut spec = crate::pulse_bridge::normalize_rule_spec_camel_case(&raw_spec);

    let violations = validate_pulse_rule_spec(&spec);
    if !violations.is_empty() {
        return Err(json!({
            "isError": true,
            "valid": false,
            "violations": violations,
            "text": format!("PulseRuleSpec validation failed with {} violation(s).", violations.len()),
        }));
    }

    let mandate_origin =
        resolve_mandate_origin(env_mandate_override, meta, Some(raw_caller_args));
    let requested_enabled = bool_field(normalized_args, &["enabled"])
        .or_else(|| bool_field(raw_caller_args, &["enabled"]))
        .unwrap_or(false);
    let requested_draft = bool_field(
        normalized_args,
        &["draft_only", "draftOnly", "propose_only", "proposeOnly"],
    )
    .or_else(|| {
        bool_field(
            raw_caller_args,
            &["draft_only", "draftOnly", "propose_only", "proposeOnly"],
        )
    })
    .unwrap_or(false);
    let requested_mode = str_field(&spec, &["evalMode", "eval_mode"])
        .unwrap_or("observe")
        .to_string();

    // CRITICAL SECURITY INVARIANT (`MandateOrigin` + draft/propose coercion):
    // When provenance is `untrusted_external` OR `propose_only`/`draft_only` is
    // requested, coerce `evalMode = "observe"`, `draftOnly = true`, `enabled = false`.
    let (final_enabled, final_draft_only, final_mode, security_notice) =
        if mandate_origin == MandateOrigin::UntrustedExternal {
            (
                false,
                true,
                "observe".to_string(),
                Some(json!({
                    "coerced": true,
                    "code": "untrusted_mandate_draft_coercion",
                    "mandateOrigin": "untrusted_external",
                    "requestedEnabled": requested_enabled,
                    "requestedEvalMode": requested_mode,
                    "enforcedDraftOnly": true,
                    "enforcedEnabled": false,
                    "enforcedEvalMode": "observe",
                    "message": "Caller MandateOrigin is untrusted_external; rule was coerced to draftOnly=true, enabled=false, evalMode=observe and requires explicit human confirmation.",
                })),
            )
        } else if requested_draft {
            (false, true, "observe".to_string(), None)
        } else {
            (requested_enabled, false, requested_mode, None)
        };

    if let Some(spec_obj) = spec.as_object_mut() {
        spec_obj.remove("eval_mode");
        spec_obj.insert("evalMode".into(), json!(final_mode));
    }

    let id = str_field(normalized_args, &["id"])
        .or_else(|| str_field(raw_caller_args, &["id"]))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let webhook_route_id = str_field(
        normalized_args,
        &["webhook_route_id", "webhookRouteId"],
    )
    .or_else(|| str_field(raw_caller_args, &["webhook_route_id", "webhookRouteId"]))
    .map(str::trim)
    .filter(|s| !s.is_empty())
    .map(str::to_string);

    Ok(PreparedRuleSave {
        id,
        enabled: final_enabled,
        draft_only: final_draft_only,
        mandate_origin,
        webhook_route_id,
        spec,
        security_notice,
    })
}

pub(crate) fn now_iso_placeholder() -> String {
    "2026-11-15T00:00:00Z".to_string()
}

fn default_builtin_sources() -> Vec<Value> {
    vec![
        json!({
            "id": "temporal-builtin",
            "kind": "time_cron",
            "title": "Built-in Temporal Scheduler",
            "enabled": true,
            "healthy": true,
            "receivedCount24h": 0,
            "rejectedCount24h": 0,
            "updatedAt": now_iso_placeholder(),
        }),
        json!({
            "id": "sdk-builtin",
            "kind": "sdk_custom",
            "title": "Pulse Event SDK & Agent Emitter",
            "enabled": true,
            "healthy": true,
            "receivedCount24h": 0,
            "rejectedCount24h": 0,
            "updatedAt": now_iso_placeholder(),
        }),
    ]
}

fn default_builtin_schemas() -> Vec<Value> {
    vec![
        json!({
            "eventType": "github.ci.failed",
            "summary": "GitHub check suite or workflow run failed on a PR or branch",
            "jsonSchema": { "type": "object", "properties": { "branch": { "type": "string" } } },
            "builtIn": true,
            "updatedAt": now_iso_placeholder(),
        }),
        json!({
            "eventType": "jira.issue.transitioned",
            "summary": "Jira issue transitioned between workflow statuses",
            "jsonSchema": { "type": "object", "properties": { "from": { "type": "string" }, "to": { "type": "string" } } },
            "builtIn": true,
            "updatedAt": now_iso_placeholder(),
        }),
        json!({
            "eventType": "feishu.im.mention",
            "summary": "Bot or group seat was @-mentioned in a Feishu chat or topic",
            "jsonSchema": { "type": "object", "properties": { "text": { "type": "string" } } },
            "builtIn": true,
            "updatedAt": now_iso_placeholder(),
        }),
    ]
}

pub(crate) fn workflow_presets_catalog() -> Value {
    json!([
        {
            "kind": "direct_reflex",
            "title": "Direct Reflex",
            "summary": "Zero-token deterministic Gate -> single or fanout target (Session, Bot, Group, or User)."
        },
        {
            "kind": "superagent_router",
            "title": "Superagent Router",
            "summary": "Persistent triage BotNode + isolated coding SessionNode + Thread Subscription fanout + Outbox reply."
        },
        {
            "kind": "hybrid_pipeline",
            "title": "Hybrid Delivery Pipeline",
            "summary": "Persistent PM BotNode -> parallel isolated SessionNodes -> BoundedLoop review -> UserGate approval -> Outbox."
        },
        {
            "kind": "event_saga",
            "title": "Event Saga",
            "summary": "Multi-day stateful pipeline chaining WaitForEvent checkpoints with inactivity SLA escalation."
        },
        {
            "kind": "window_aggregator",
            "title": "Window Aggregator",
            "summary": "Sliding debounce/batch window collapsing noisy external alerts into one summarized Bot/User digest."
        }
    ])
}
