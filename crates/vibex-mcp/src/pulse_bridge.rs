//! Real Host Bridge for `vibex-mcp` Pulse tools over BOTH HTTP (`/api/v1/call/<command>`)
//! and Desktop Socket IPC (`BrokerMessage::Collaborate`).
//!
//! Enforces `MandateOrigin` + `propose_only`/`draft_only` safety coercion and
//! anti-loop hop guards locally, maps every MCP `pulse_*` call to the exact Host
//! `DomainCommand` name and camelCase payload schema, scrubs all secret-bearing
//! keys on Host responses, and propagates Host `4xx`/`5xx`/IPC validation errors
//! verbatim without ever falling back to fake local success.

use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::{
    client::HostCallError,
    pulse::{
        MAX_HOP_COUNT, MandateOrigin, bool_field, compute_effective_hop_count,
        hop_limit_exceeded_error, now_iso_placeholder, redact_secrets, resolve_mandate_origin,
        synthesize_timer_rule_args, workflow_presets_catalog,
    },
    pulse_eval::{str_field, violation},
};

/// Transport abstraction implemented by `Companion` (routing over HTTP `call_v1`
/// or Desktop Socket IPC) and mockable in unit tests.
pub trait HostCommandCaller: Send + Sync {
    fn call_host_command<'a>(
        &'a self,
        command: &'a str,
        operation_id: &'a str,
        args: &'a Value,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Value, HostCallError>> + Send + 'a>,
    >;
}

/// Execute one of the 7 `pulse_*` MCP tools against a configured Host (HTTP or
/// Socket IPC). Returns `Err(String)` only for unknown tool names (`-32602`);
/// domain/validation/transport errors return `Ok(Value)` with `"isError": true`
/// so MCP `CallToolResult` carries `isError: true` plus structured `violations`.
pub async fn execute_host_pulse_tool<C: HostCommandCaller>(
    caller: &C,
    name: &str,
    arguments: &Value,
    meta: Option<&Value>,
    env_mandate_override: Option<&str>,
) -> Result<Value, String> {
    let op_id = str_field(arguments, &["operation_id", "operationId"]).unwrap_or("");
    let mut outcome = match name {
        "pulse_catalog_inspect" => host_catalog_inspect(caller, op_id, arguments).await,
        "pulse_event_define" => host_event_define(caller, op_id, arguments).await,
        "pulse_event_emit" => host_event_emit(caller, op_id, arguments, meta).await,
        "pulse_timer_schedule" => {
            let synthesized = synthesize_timer_rule_args(arguments);
            host_rule_save(
                caller,
                op_id,
                &synthesized,
                arguments,
                meta,
                env_mandate_override,
                false,
            )
            .await
        }
        "pulse_rule_propose_or_save" => {
            host_rule_save(
                caller,
                op_id,
                arguments,
                arguments,
                meta,
                env_mandate_override,
                true,
            )
            .await
        }
        "pulse_rule_dry_run" => host_rule_dry_run(caller, op_id, arguments).await,
        "pulse_thread_subscribe" => host_thread_subscribe(caller, op_id, arguments).await,
        other => return Err(format!("unknown pulse tool: {other}")),
    };

    redact_secrets(&mut outcome);
    Ok(outcome)
}

async fn host_catalog_inspect<C: HostCommandCaller>(
    caller: &C,
    op_id: &str,
    arguments: &Value,
) -> Value {
    let category = str_field(arguments, &["category"]).unwrap_or("all");
    let project_id = str_field(arguments, &["project_id", "projectId"])
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let deck = match caller
        .call_host_command(
            "pulse_deck_snapshot",
            op_id,
            &json!({ "projectId": project_id }),
        )
        .await
    {
        Ok(data) => data,
        Err(err) => return err.into_mcp_error_outcome(),
    };

    let schemas = match caller
        .call_host_command("pulse_event_schema_list", op_id, &json!({}))
        .await
    {
        Ok(data) => data,
        Err(err) => return err.into_mcp_error_outcome(),
    };

    let sources = deck
        .get("sources")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let rules = deck
        .get("rules")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let subscriptions = deck
        .get("subscriptions")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));

    let mut payload = Map::new();
    payload.insert("deck".into(), deck);
    if matches!(category, "all" | "schemas") {
        payload.insert("schemas".into(), schemas.clone());
        payload.insert("eventSchemas".into(), schemas);
    }
    if matches!(category, "all" | "sources") {
        payload.insert("sources".into(), sources);
    }
    if category == "all" {
        payload.insert("rules".into(), rules);
        payload.insert("subscriptions".into(), subscriptions);
    }
    if matches!(category, "all" | "presets") {
        payload.insert("workflowPresets".into(), workflow_presets_catalog());
    }

    let mut catalog = Value::Object(payload);
    redact_secrets(&mut catalog);
    catalog
}

async fn host_event_define<C: HostCommandCaller>(
    caller: &C,
    op_id: &str,
    arguments: &Value,
) -> Value {
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
        .unwrap_or_else(|| json!({}));

    let host_args = json!({
        "eventType": event_type,
        "summary": summary,
        "jsonSchema": json_schema,
    });

    match caller
        .call_host_command("pulse_event_schema_define", op_id, &host_args)
        .await
    {
        Ok(data) => data,
        Err(err) => err.into_mcp_error_outcome(),
    }
}

async fn host_event_emit<C: HostCommandCaller>(
    caller: &C,
    op_id: &str,
    arguments: &Value,
    meta: Option<&Value>,
) -> Value {
    let event_type = str_field(arguments, &["event_type", "eventType"])
        .unwrap_or("")
        .trim()
        .to_string();
    let hop_count = compute_effective_hop_count(arguments, meta);
    if hop_count > MAX_HOP_COUNT {
        return hop_limit_exceeded_error(&event_type, hop_count);
    }

    let thread_key = str_field(arguments, &["thread_key", "threadKey"])
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let source_instance_id = str_field(arguments, &["source_instance_id", "sourceInstanceId"])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("vibex-mcp");
    let delivery_id = str_field(arguments, &["delivery_id", "deliveryId"])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("dlv_{}", Uuid::new_v4().simple()));
    let payload = arguments
        .get("payload")
        .cloned()
        .unwrap_or_else(|| json!({}));

    let host_args = json!({
        "input": {
            "eventType": event_type,
            "threadKey": thread_key,
            "sourceInstanceId": source_instance_id,
            "deliveryId": delivery_id,
            "payload": payload,
        }
    });

    match caller
        .call_host_command("pulse_event_emit", op_id, &host_args)
        .await
    {
        Ok(data) => data,
        Err(err) => err.into_mcp_error_outcome(),
    }
}

async fn host_rule_save<C: HostCommandCaller>(
    caller: &C,
    op_id: &str,
    normalized_args: &Value,
    raw_caller_args: &Value,
    meta: Option<&Value>,
    env_mandate_override: Option<&str>,
    include_webhook_route_id: bool,
) -> Value {
    let raw_spec = normalized_args
        .get("spec")
        .cloned()
        .unwrap_or_else(|| normalized_args.clone());
    let mut spec = normalize_rule_spec_camel_case(&raw_spec);

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
        .filter(|s| !s.is_empty());
    let webhook_route_id = str_field(
        normalized_args,
        &["webhook_route_id", "webhookRouteId"],
    )
    .or_else(|| str_field(raw_caller_args, &["webhook_route_id", "webhookRouteId"]))
    .map(str::trim)
    .filter(|s| !s.is_empty());

    let mut input_map = Map::new();
    input_map.insert("id".into(), json!(id));
    input_map.insert("enabled".into(), json!(final_enabled));
    input_map.insert("draftOnly".into(), json!(final_draft_only));
    input_map.insert("mandateOrigin".into(), json!(mandate_origin.as_str()));
    if include_webhook_route_id {
        input_map.insert("webhookRouteId".into(), json!(webhook_route_id));
    }
    input_map.insert("spec".into(), spec);

    let host_args = json!({ "input": Value::Object(input_map) });

    match caller
        .call_host_command("pulse_rule_save", op_id, &host_args)
        .await
    {
        Ok(mut host_data) => {
            redact_secrets(&mut host_data);
            if host_data.is_object() && host_data.get("rule").is_none() && host_data.get("id").is_some()
            {
                let rule_snapshot = host_data.clone();
                if let Some(obj) = host_data.as_object_mut() {
                    obj.insert("rule".into(), rule_snapshot);
                }
            }
            if let Some(notice) = security_notice
                && let Some(obj) = host_data.as_object_mut()
            {
                obj.entry("notice").or_insert_with(|| notice.clone());
                obj.entry("securityNotice").or_insert(notice);
            }
            host_data
        }
        Err(err) => err.into_mcp_error_outcome(),
    }
}

async fn host_rule_dry_run<C: HostCommandCaller>(
    caller: &C,
    op_id: &str,
    arguments: &Value,
) -> Value {
    let raw_spec = arguments
        .get("spec")
        .or_else(|| arguments.get("rule"))
        .cloned()
        .unwrap_or(Value::Null);
    let raw_event = arguments
        .get("sample_event")
        .or_else(|| arguments.get("sampleEvent"))
        .or_else(|| arguments.get("event"))
        .cloned()
        .unwrap_or(Value::Null);

    let spec = normalize_rule_spec_camel_case(&raw_spec);
    let sample_event = normalize_sample_event_envelope(&raw_event);

    let host_args = json!({
        "spec": spec,
        "sampleEvent": sample_event,
    });

    match caller
        .call_host_command("pulse_rule_dry_run", op_id, &host_args)
        .await
    {
        Ok(data) => data,
        Err(err) => err.into_mcp_error_outcome(),
    }
}

async fn host_thread_subscribe<C: HostCommandCaller>(
    caller: &C,
    op_id: &str,
    arguments: &Value,
) -> Value {
    let action = str_field(arguments, &["action"]).unwrap_or("subscribe");
    match action {
        "unsubscribe" => {
            let mut sub_id = str_field(arguments, &["subscription_id", "subscriptionId"])
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);

            if sub_id.is_none() {
                let thread_key = str_field(arguments, &["thread_key", "threadKey"])
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                let subscriber_id = str_field(arguments, &["subscriber_id", "subscriberId"])
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                if let (Some(tk), Some(sid)) = (thread_key, subscriber_id) {
                    let deck = match caller
                        .call_host_command(
                            "pulse_deck_snapshot",
                            op_id,
                            &json!({ "projectId": null }),
                        )
                        .await
                    {
                        Ok(d) => d,
                        Err(err) => return err.into_mcp_error_outcome(),
                    };
                    sub_id = deck
                        .get("subscriptions")
                        .and_then(Value::as_array)
                        .and_then(|subs| {
                            subs.iter().find_map(|s| {
                                let matches_pair =
                                    s.get("threadKey").and_then(Value::as_str) == Some(tk)
                                        && s.get("subscriberId").and_then(Value::as_str)
                                            == Some(sid);
                                if matches_pair {
                                    s.get("id").and_then(Value::as_str).map(str::to_string)
                                } else {
                                    None
                                }
                            })
                        });
                }
            }

            let Some(subscription_id) = sub_id else {
                return json!({
                    "isError": true,
                    "valid": false,
                    "violations": [violation(
                        "subscription_id",
                        "missing_unsubscribe_selector",
                        "subscription_id is required to unsubscribe (or an active thread_key + subscriber_id pair).",
                    )],
                    "text": "Missing subscription_id for unsubscribe.",
                });
            };

            let host_args = json!({ "subscriptionId": subscription_id });
            match caller
                .call_host_command("pulse_thread_unsubscribe", op_id, &host_args)
                .await
            {
                Ok(Value::Null) => json!({
                    "unsubscribed": true,
                    "subscriptionId": subscription_id,
                    "active": false,
                }),
                Ok(data) => data,
                Err(err) => err.into_mcp_error_outcome(),
            }
        }
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
            let active = bool_field(arguments, &["active"]).unwrap_or(true);

            let host_args = json!({
                "threadKey": thread_key,
                "subscriberKind": subscriber_kind,
                "subscriberId": subscriber_id,
                "active": active,
            });

            match caller
                .call_host_command("pulse_thread_subscribe", op_id, &host_args)
                .await
            {
                Ok(data) => data,
                Err(err) => err.into_mcp_error_outcome(),
            }
        }
        other => json!({
            "isError": true,
            "valid": false,
            "violations": [violation(
                "action",
                "invalid_action",
                &format!("Unsupported action '{other}'; expected 'subscribe' or 'unsubscribe'."),
            )],
            "text": format!("Unsupported action '{other}'."),
        }),
    }
}

/// Normalizes a `PulseRuleSpec` JSON object so snake_case aliases become exact
/// camelCase keys matching `api_types::pulse::PulseRuleSpec`.
pub(crate) fn normalize_rule_spec_camel_case(raw: &Value) -> Value {
    let Some(src) = raw.as_object() else {
        return raw.clone();
    };
    let mut out = src.clone();

    rename_alias(&mut out, "eval_mode", "evalMode");
    rename_alias(&mut out, "project_id", "projectId");
    rename_alias(&mut out, "workspace_id", "workspaceId");
    rename_alias(&mut out, "debounce_ms", "debounceMs");
    rename_alias(&mut out, "claim_exclusive", "claimExclusive");

    if let Some(Value::Object(filter_map)) = out.get_mut("filter") {
        rename_alias(filter_map, "source_kinds", "sourceKinds");
        rename_alias(filter_map, "source_instance_ids", "sourceInstanceIds");
        rename_alias(filter_map, "event_types", "eventTypes");
        rename_alias(filter_map, "allowed_actors", "allowedActors");
    }

    if let Some(Value::Object(temp_map)) = out.get_mut("temporal") {
        if let Some(kind_str) = temp_map.get("kind").and_then(Value::as_str) {
            let canonical = match kind_str {
                "time_cron" => "cron",
                "time_once" => "once",
                "time_interval" => "interval",
                "time_sla" => "inactivity_sla",
                other => other,
            };
            temp_map.insert("kind".into(), json!(canonical));
        }
        rename_alias(temp_map, "weekdays_only", "weekdaysOnly");
        rename_alias(temp_map, "catch_up_once", "catchUpOnce");
        rename_alias(temp_map, "fire_at", "fireAt");
        rename_alias(temp_map, "every_seconds", "everySeconds");
        rename_alias(temp_map, "skip_if_busy", "skipIfBusy");
        rename_alias(temp_map, "thread_key_prefix", "threadKeyPrefix");
        rename_alias(temp_map, "timeout_seconds", "timeoutSeconds");
        rename_alias(temp_map, "expected_event_types", "expectedEventTypes");
    }

    if let Some(Value::Array(targets)) = out.get_mut("targets") {
        for target in targets.iter_mut() {
            if let Some(tmap) = target.as_object_mut() {
                rename_alias(tmap, "agent_id", "agentId");
                rename_alias(tmap, "model_override", "modelOverride");
                rename_alias(tmap, "workspace_isolation", "workspaceIsolation");
                rename_alias(tmap, "project_id", "projectId");
                rename_alias(tmap, "existing_session_id", "existingSessionId");
                rename_alias(tmap, "delivery_strategy", "deliveryStrategy");
                rename_alias(tmap, "subscribe_thread", "subscribeThread");
                rename_alias(tmap, "prompt_template", "promptTemplate");
                rename_alias(tmap, "member_id", "memberId");
                rename_alias(tmap, "conversation_scope", "conversationScope");
                rename_alias(tmap, "mailbox_policy", "mailboxPolicy");
                rename_alias(tmap, "space_id", "spaceId");
                rename_alias(tmap, "dispatch_mode", "dispatchMode");
                rename_alias(tmap, "message_template", "messageTemplate");
                rename_alias(tmap, "interaction_kind", "interactionKind");
                rename_alias(tmap, "title_template", "titleTemplate");
                rename_alias(tmap, "body_template", "bodyTemplate");
                rename_alias(tmap, "mirror_to_channels", "mirrorToChannels");
                rename_alias(tmap, "approval_options", "approvalOptions");
                rename_alias(tmap, "form_schema", "formSchema");
                rename_alias(tmap, "sla_timeout_seconds", "slaTimeoutSeconds");
                rename_alias(tmap, "workflow_id", "workflowId");
                rename_alias(tmap, "pinned_version", "pinnedVersion");
                rename_alias(tmap, "input_mapping", "inputMapping");

                match tmap.get("kind").and_then(Value::as_str) {
                    Some("session") => {
                        tmap.entry("mode")
                            .or_insert_with(|| json!("ephemeral_fresh"));
                    }
                    Some("user") => {
                        tmap.entry("interactionKind")
                            .or_insert_with(|| json!("notify"));
                        tmap.entry("bodyTemplate").or_insert_with(|| json!(""));
                    }
                    Some("workflow") => {
                        tmap.entry("pinnedVersion").or_insert_with(|| json!(1));
                    }
                    _ => {}
                }
            }
        }
    }

    Value::Object(out)
}

/// Ensures `sampleEvent` has complete camelCase `EventEnvelope` fields expected
/// by `api_types::pulse::EventEnvelope` while preserving all caller-supplied data.
pub(crate) fn normalize_sample_event_envelope(raw: &Value) -> Value {
    let Some(src) = raw.as_object() else {
        return raw.clone();
    };
    let mut out = src.clone();
    rename_alias(&mut out, "event_id", "eventId");
    rename_alias(&mut out, "delivery_id", "deliveryId");
    rename_alias(&mut out, "event_type", "eventType");
    rename_alias(&mut out, "occurred_at", "occurredAt");
    rename_alias(&mut out, "thread_key", "threadKey");
    rename_alias(&mut out, "reply_channels", "replyChannels");

    let event_id = out
        .get("eventId")
        .and_then(Value::as_str)
        .unwrap_or("evt_dry_run")
        .to_string();
    out.entry("eventId")
        .or_insert_with(|| json!(event_id.clone()));
    out.entry("deliveryId")
        .or_insert_with(|| json!(format!("dlv_{event_id}")));
    out.entry("eventType")
        .or_insert_with(|| json!("sdk.sample.event"));
    out.entry("occurredAt")
        .or_insert_with(|| json!(now_iso_placeholder()));
    out.entry("correlations").or_insert_with(|| json!([]));
    out.entry("replyChannels").or_insert_with(|| json!([]));
    out.entry("payload").or_insert_with(|| json!({}));

    let mut source_map = out
        .get("source")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    rename_alias(&mut source_map, "instance_id", "instanceId");
    rename_alias(&mut source_map, "trust_level", "trustLevel");
    source_map
        .entry("kind")
        .or_insert_with(|| json!("sdk_custom"));
    source_map
        .entry("instanceId")
        .or_insert_with(|| json!("dry-run"));
    source_map
        .entry("trustLevel")
        .or_insert_with(|| json!("trusted_internal"));
    out.insert("source".into(), Value::Object(source_map));

    let mut actor_map = out
        .get("actor")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    rename_alias(&mut actor_map, "display_name", "displayName");
    rename_alias(&mut actor_map, "is_bot", "isBot");
    rename_alias(&mut actor_map, "is_self", "isSelf");
    actor_map.entry("id").or_insert_with(|| json!("actor-1"));
    actor_map.entry("roles").or_insert_with(|| json!([]));
    actor_map.entry("isBot").or_insert_with(|| json!(false));
    actor_map.entry("isSelf").or_insert_with(|| json!(false));
    out.insert("actor".into(), Value::Object(actor_map));

    let mut trace_map = out
        .get("trace")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    rename_alias(&mut trace_map, "root_event_id", "rootEventId");
    rename_alias(&mut trace_map, "parent_run_id", "parentRunId");
    rename_alias(&mut trace_map, "hop_count", "hopCount");
    trace_map
        .entry("rootEventId")
        .or_insert_with(|| json!(event_id));
    trace_map.entry("hopCount").or_insert_with(|| json!(0));
    out.insert("trace".into(), Value::Object(trace_map));

    Value::Object(out)
}

fn rename_alias(map: &mut Map<String, Value>, snake: &str, camel: &str) {
    if let Some(val) = map.remove(snake) {
        map.entry(camel.to_string()).or_insert(val);
    }
}
