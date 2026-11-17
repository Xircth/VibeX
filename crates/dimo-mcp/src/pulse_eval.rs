//! Exhaustive No-Fail-Fast validators, RFC 6901 JSON Pointer resolver, Zero-Eval
//! template renderer, non-backtracking safe regex engine, and dry-run evaluator
//! for AI-Native Pulse MCP tools.

use std::collections::BTreeSet;

use serde_json::{Value, json};

use crate::pulse::MAX_HOP_COUNT;

const MAX_GATE_CONDITIONS: usize = 128;

pub fn violation(path: &str, code: &str, message: &str) -> Value {
    json!({
        "path": path,
        "code": code,
        "message": message,
    })
}

pub fn str_field<'a>(obj: &'a Value, keys: &[&str]) -> Option<&'a str> {
    for key in keys {
        if let Some(v) = obj.get(*key).and_then(Value::as_str) {
            return Some(v);
        }
    }
    None
}

pub fn is_valid_event_type(event_type: &str) -> bool {
    let mut parts = event_type.split('.');
    let Some(first) = parts.next() else {
        return false;
    };
    if first.is_empty()
        || !first.bytes().next().unwrap().is_ascii_lowercase()
        || !first
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    {
        return false;
    }
    let mut rest_count = 0usize;
    for seg in parts {
        if seg.is_empty()
            || !seg
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
        {
            return false;
        }
        rest_count += 1;
    }
    rest_count >= 1
}

pub fn is_valid_thread_key(thread_key: &str) -> bool {
    let Some((prefix, rest)) = thread_key.split_once(':') else {
        return false;
    };
    !prefix.trim().is_empty()
        && !rest.trim().is_empty()
        && prefix
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.')
}

pub fn validate_json_schema_node(
    schema: &Value,
    path: &str,
    depth: usize,
    violations: &mut Vec<Value>,
) {
    if depth > 32 {
        violations.push(violation(
            path,
            "schema_depth_exceeded",
            "JSON Schema exceeds max depth of 32.",
        ));
        return;
    }
    let Some(obj) = schema.as_object() else {
        violations.push(violation(
            path,
            "invalid_schema_object",
            "JSON Schema node must be a JSON object.",
        ));
        return;
    };

    if let Some(kind) = obj.get("type") {
        let ok = kind.as_str().is_some_and(|t| {
            matches!(
                t,
                "object" | "array" | "string" | "number" | "integer" | "boolean" | "null"
            )
        });
        if !ok {
            violations.push(violation(
                &format!("{path}.type"),
                "unsupported_schema_type",
                "Schema type must be object, array, string, number, integer, boolean, or null.",
            ));
        }
    }

    if let Some(req) = obj.get("required") {
        match req.as_array() {
            None => violations.push(violation(
                &format!("{path}.required"),
                "invalid_required_array",
                "required must be an array of non-empty strings.",
            )),
            Some(items) => {
                let mut seen = BTreeSet::new();
                for (idx, item) in items.iter().enumerate() {
                    match item.as_str() {
                        Some(s) if !s.trim().is_empty() => {
                            if !seen.insert(s) {
                                violations.push(violation(
                                    &format!("{path}.required[{idx}]"),
                                    "duplicate_required_field",
                                    &format!("Duplicate required field '{s}'."),
                                ));
                            }
                        }
                        _ => violations.push(violation(
                            &format!("{path}.required[{idx}]"),
                            "invalid_required_entry",
                            "Each required entry must be a non-empty string.",
                        )),
                    }
                }
            }
        }
    }

    if let (Some(min), Some(max)) = (
        obj.get("minimum").and_then(Value::as_f64),
        obj.get("maximum").and_then(Value::as_f64),
    ) && min > max
    {
        violations.push(violation(
            &format!("{path}.minimum"),
            "invalid_number_bounds",
            "minimum cannot exceed maximum.",
        ));
    }

    if let (Some(min), Some(max)) = (
        obj.get("minLength").and_then(Value::as_u64),
        obj.get("maxLength").and_then(Value::as_u64),
    ) && min > max
    {
        violations.push(violation(
            &format!("{path}.minLength"),
            "invalid_length_bounds",
            "minLength cannot exceed maxLength.",
        ));
    }

    if let Some(pattern) = obj.get("pattern").and_then(Value::as_str)
        && let Err(err) = compile_safe_regex(pattern)
    {
        violations.push(violation(
            &format!("{path}.pattern"),
            "invalid_pattern_regex",
            &err,
        ));
    }

    if let Some(props) = obj.get("properties") {
        match props.as_object() {
            None => violations.push(violation(
                &format!("{path}.properties"),
                "invalid_properties_map",
                "properties must be a JSON object.",
            )),
            Some(map) => {
                for (field, child) in map {
                    validate_json_schema_node(
                        child,
                        &format!("{path}.properties.{field}"),
                        depth + 1,
                        violations,
                    );
                }
            }
        }
    }

    if let Some(items) = obj.get("items") {
        validate_json_schema_node(items, &format!("{path}.items"), depth + 1, violations);
    }
}

/// Validates a payload instance against a registered JSON Schema exhaustively.
pub fn validate_payload_against_schema(
    schema: &Value,
    payload: &Value,
    path: &str,
    violations: &mut Vec<Value>,
) {
    let Some(obj) = schema.as_object() else {
        return;
    };
    if let Some(expected_type) = obj.get("type").and_then(Value::as_str) {
        let type_ok = match expected_type {
            "object" => payload.is_object(),
            "array" => payload.is_array(),
            "string" => payload.is_string(),
            "number" => payload.is_number(),
            "integer" => payload.as_i64().is_some() || payload.as_u64().is_some(),
            "boolean" => payload.is_boolean(),
            "null" => payload.is_null(),
            _ => true,
        };
        if !type_ok {
            violations.push(violation(
                path,
                "schema_type_mismatch",
                &format!("Expected JSON type '{expected_type}'."),
            ));
            return;
        }
    }

    if let Some(num) = payload.as_f64() {
        if let Some(min) = obj.get("minimum").and_then(Value::as_f64)
            && num < min
        {
            violations.push(violation(
                path,
                "number_below_minimum",
                &format!("Value {num} is below minimum {min}."),
            ));
        }
        if let Some(max) = obj.get("maximum").and_then(Value::as_f64)
            && num > max
        {
            violations.push(violation(
                path,
                "number_above_maximum",
                &format!("Value {num} exceeds maximum {max}."),
            ));
        }
    }

    if let Some(text) = payload.as_str() {
        let char_len = text.chars().count() as u64;
        if let Some(min_len) = obj.get("minLength").and_then(Value::as_u64)
            && char_len < min_len
        {
            violations.push(violation(
                path,
                "string_too_short",
                &format!("String length {char_len} is below minLength {min_len}."),
            ));
        }
        if let Some(max_len) = obj.get("maxLength").and_then(Value::as_u64)
            && char_len > max_len
        {
            violations.push(violation(
                path,
                "string_too_long",
                &format!("String length {char_len} exceeds maxLength {max_len}."),
            ));
        }
        if let Some(pattern) = obj.get("pattern").and_then(Value::as_str)
            && !matches_safe_regex(pattern, text)
        {
            violations.push(violation(
                path,
                "pattern_mismatch",
                &format!("String does not match pattern '{pattern}'."),
            ));
        }
    }

    if let Some(map) = payload.as_object() {
        if let Some(req) = obj.get("required").and_then(Value::as_array) {
            for field in req.iter().filter_map(Value::as_str) {
                if !map.contains_key(field) {
                    violations.push(violation(
                        &format!("{path}.{field}"),
                        "missing_required_property",
                        &format!("Required property '{field}' is missing."),
                    ));
                }
            }
        }
        if let Some(props) = obj.get("properties").and_then(Value::as_object) {
            for (field, prop_schema) in props {
                if let Some(val) = map.get(field) {
                    validate_payload_against_schema(
                        prop_schema,
                        val,
                        &format!("{path}.{field}"),
                        violations,
                    );
                }
            }
        }
    }

    if let (Some(items_schema), Some(arr)) = (obj.get("items"), payload.as_array()) {
        for (idx, item) in arr.iter().enumerate() {
            validate_payload_against_schema(
                items_schema,
                item,
                &format!("{path}[{idx}]"),
                violations,
            );
        }
    }
}

/// Exhaustively validates a `PulseRuleSpec` in a single pass (No Fail-Fast).
pub fn validate_pulse_rule_spec(spec: &Value) -> Vec<Value> {
    let mut violations = Vec::new();
    let Some(obj) = spec.as_object() else {
        violations.push(violation(
            "spec",
            "invalid_spec_object",
            "PulseRuleSpec must be a JSON object.",
        ));
        return violations;
    };

    let name = obj.get("name").and_then(Value::as_str).unwrap_or("").trim();
    if name.is_empty() {
        violations.push(violation("name", "empty_name", "Rule name is required."));
    }

    let eval_mode = str_field(spec, &["evalMode", "eval_mode"]).unwrap_or("observe");
    if !matches!(eval_mode, "off" | "observe" | "auto") {
        violations.push(violation(
            "evalMode",
            "invalid_eval_mode",
            "evalMode must be 'off', 'observe', or 'auto'.",
        ));
    }

    if let Some(orchestrator) = str_field(spec, &["orchestrator"])
        && !matches!(
            orchestrator,
            "direct_reflex"
                | "superagent_router"
                | "hybrid_pipeline"
                | "event_saga"
                | "window_aggregator"
        )
    {
        violations.push(violation(
            "orchestrator",
            "invalid_orchestrator",
            "Unsupported orchestrator preset kind.",
        ));
    }

    if let Some(filter) = obj.get("filter") {
        if let Some(conditions) = filter.get("conditions").and_then(Value::as_array) {
            if conditions.len() > MAX_GATE_CONDITIONS {
                violations.push(violation(
                    "filter.conditions",
                    "too_many_conditions",
                    &format!("Conditions exceed maximum of {MAX_GATE_CONDITIONS}."),
                ));
            }
            for (idx, cond) in conditions.iter().enumerate() {
                let op = cond.get("op").and_then(Value::as_str).unwrap_or("");
                if !matches!(
                    op,
                    "eq" | "neq"
                        | "lt"
                        | "lte"
                        | "gt"
                        | "gte"
                        | "contains"
                        | "in_set"
                        | "exists"
                        | "regex"
                        | "not_bot_actor"
                ) {
                    violations.push(violation(
                        &format!("filter.conditions[{idx}].op"),
                        "invalid_condition_op",
                        &format!("Unsupported filter condition op '{op}'."),
                    ));
                    continue;
                }
                if op != "not_bot_actor" {
                    let ptr = cond
                        .get("pointer")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim();
                    if ptr.is_empty() {
                        violations.push(violation(
                            &format!("filter.conditions[{idx}].pointer"),
                            "empty_pointer",
                            "JSON Pointer cannot be empty.",
                        ));
                    } else if !ptr.starts_with('/') {
                        violations.push(violation(
                            &format!("filter.conditions[{idx}].pointer"),
                            "invalid_pointer_prefix",
                            "RFC 6901 JSON Pointer must start with '/'.",
                        ));
                    }
                }
                if op == "regex" {
                    let pattern = cond.get("pattern").and_then(Value::as_str).unwrap_or("");
                    if pattern.is_empty() {
                        violations.push(violation(
                            &format!("filter.conditions[{idx}].pattern"),
                            "empty_regex_pattern",
                            "Regex pattern cannot be empty.",
                        ));
                    } else if let Err(err) = compile_safe_regex(pattern) {
                        violations.push(violation(
                            &format!("filter.conditions[{idx}].pattern"),
                            "invalid_regex",
                            &err,
                        ));
                    }
                }
            }
        }
    } else {
        violations.push(violation(
            "filter",
            "missing_filter",
            "filter (GateFilterAst) is required.",
        ));
    }

    if let Some(temporal) = obj.get("temporal").filter(|v| !v.is_null()) {
        let kind = temporal.get("kind").and_then(Value::as_str).unwrap_or("");
        match kind {
            "cron" | "time_cron" => {
                let expr = str_field(temporal, &["expression"]).unwrap_or("").trim();
                let parts = expr.split_whitespace().count();
                if expr.is_empty() {
                    violations.push(violation(
                        "temporal.expression",
                        "empty_cron",
                        "Cron expression is required.",
                    ));
                } else if !(5..=6).contains(&parts) {
                    violations.push(violation(
                        "temporal.expression",
                        "invalid_cron_fields",
                        "Cron expression must have 5 or 6 fields.",
                    ));
                }
                if str_field(temporal, &["timezone"])
                    .unwrap_or("")
                    .trim()
                    .is_empty()
                {
                    violations.push(violation(
                        "temporal.timezone",
                        "empty_timezone",
                        "IANA timezone is required for cron schedules.",
                    ));
                }
            }
            "once" | "time_once" => {
                if str_field(temporal, &["fireAt", "fire_at"])
                    .unwrap_or("")
                    .trim()
                    .is_empty()
                {
                    violations.push(violation(
                        "temporal.fireAt",
                        "empty_fire_at",
                        "fireAt ISO-8601 timestamp is required for once schedules.",
                    ));
                }
            }
            "interval" | "time_interval" => {
                let every = temporal
                    .get("everySeconds")
                    .or_else(|| temporal.get("every_seconds"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                if every < 5 {
                    violations.push(violation(
                        "temporal.everySeconds",
                        "interval_too_short",
                        "Interval must be at least 5 seconds.",
                    ));
                }
            }
            "inactivity_sla" | "time_sla" => {
                if str_field(temporal, &["threadKeyPrefix", "thread_key_prefix"])
                    .unwrap_or("")
                    .trim()
                    .is_empty()
                {
                    violations.push(violation(
                        "temporal.threadKeyPrefix",
                        "empty_thread_key_prefix",
                        "threadKeyPrefix is required for inactivity_sla.",
                    ));
                }
                let timeout = temporal
                    .get("timeoutSeconds")
                    .or_else(|| temporal.get("timeout_seconds"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                if timeout < 10 {
                    violations.push(violation(
                        "temporal.timeoutSeconds",
                        "sla_timeout_too_short",
                        "SLA timeout must be at least 10 seconds.",
                    ));
                }
            }
            other => violations.push(violation(
                "temporal.kind",
                "invalid_temporal_kind",
                &format!("Unsupported temporal kind '{other}'."),
            )),
        }
    }

    match obj.get("targets").and_then(Value::as_array) {
        None => violations.push(violation(
            "targets",
            "empty_targets",
            "At least one target is required.",
        )),
        Some(targets) if targets.is_empty() => violations.push(violation(
            "targets",
            "empty_targets",
            "At least one target is required.",
        )),
        Some(targets) => {
            for (idx, target) in targets.iter().enumerate() {
                let base = format!("targets[{idx}]");
                let kind = target.get("kind").and_then(Value::as_str).unwrap_or("");
                match kind {
                    "session" => {
                        if str_field(target, &["agentId", "agent_id"])
                            .unwrap_or("")
                            .trim()
                            .is_empty()
                        {
                            violations.push(violation(
                                &format!("{base}.agentId"),
                                "missing_agent_id",
                                "Session target requires an agentId.",
                            ));
                        }
                        if str_field(target, &["mode"]) == Some("existing_session")
                            && str_field(target, &["existingSessionId", "existing_session_id"])
                                .unwrap_or("")
                                .trim()
                                .is_empty()
                        {
                            violations.push(violation(
                                &format!("{base}.existingSessionId"),
                                "missing_existing_session_id",
                                "existing_session mode requires existingSessionId.",
                            ));
                        }
                        if str_field(target, &["promptTemplate", "prompt_template"])
                            .unwrap_or("")
                            .trim()
                            .is_empty()
                        {
                            violations.push(violation(
                                &format!("{base}.promptTemplate"),
                                "empty_prompt_template",
                                "Prompt template is required.",
                            ));
                        }
                    }
                    "bot" => {
                        if str_field(target, &["memberId", "member_id"])
                            .unwrap_or("")
                            .trim()
                            .is_empty()
                        {
                            violations.push(violation(
                                &format!("{base}.memberId"),
                                "missing_member_id",
                                "Bot target requires a memberId.",
                            ));
                        }
                        if str_field(target, &["promptTemplate", "prompt_template"])
                            .unwrap_or("")
                            .trim()
                            .is_empty()
                        {
                            violations.push(violation(
                                &format!("{base}.promptTemplate"),
                                "empty_prompt_template",
                                "Prompt template is required.",
                            ));
                        }
                    }
                    "group" => {
                        if str_field(target, &["spaceId", "space_id"])
                            .unwrap_or("")
                            .trim()
                            .is_empty()
                        {
                            violations.push(violation(
                                &format!("{base}.spaceId"),
                                "missing_space_id",
                                "Group target requires a spaceId.",
                            ));
                        }
                        if str_field(target, &["messageTemplate", "message_template"])
                            .unwrap_or("")
                            .trim()
                            .is_empty()
                        {
                            violations.push(violation(
                                &format!("{base}.messageTemplate"),
                                "empty_message_template",
                                "Message template is required.",
                            ));
                        }
                    }
                    "user" => {
                        if str_field(target, &["titleTemplate", "title_template"])
                            .unwrap_or("")
                            .trim()
                            .is_empty()
                        {
                            violations.push(violation(
                                &format!("{base}.titleTemplate"),
                                "empty_title_template",
                                "Title template is required.",
                            ));
                        }
                    }
                    "workflow" => {
                        if str_field(target, &["workflowId", "workflow_id"])
                            .unwrap_or("")
                            .trim()
                            .is_empty()
                        {
                            violations.push(violation(
                                &format!("{base}.workflowId"),
                                "missing_workflow_id",
                                "Workflow target requires a workflowId.",
                            ));
                        }
                    }
                    other => violations.push(violation(
                        &format!("{base}.kind"),
                        "invalid_target_kind",
                        &format!("Unsupported target kind '{other}'."),
                    )),
                }
            }
        }
    }

    violations
}

pub fn resolve_json_pointer<'a>(root: &'a Value, pointer: &str) -> Option<&'a Value> {
    if pointer.is_empty() || pointer == "/" {
        return Some(root);
    }
    let normalized = pointer.strip_prefix('/').unwrap_or(pointer);
    let mut current = root;
    for raw_seg in normalized.split('/') {
        let seg = raw_seg.replace("~1", "/").replace("~0", "~");
        match current {
            Value::Object(map) => {
                current = map.get(&seg)?;
            }
            Value::Array(items) => {
                let idx = seg.parse::<usize>().ok()?;
                current = items.get(idx)?;
            }
            _ => return None,
        }
    }
    Some(current)
}

fn evaluate_condition(cond: &Value, envelope: &Value) -> bool {
    let op = cond.get("op").and_then(Value::as_str).unwrap_or("");
    if op == "not_bot_actor" {
        let actor = envelope.get("actor");
        let is_bot = actor
            .and_then(|a| a.get("isBot").or_else(|| a.get("is_bot")))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let is_self = actor
            .and_then(|a| a.get("isSelf").or_else(|| a.get("is_self")))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        return !is_bot && !is_self;
    }

    let ptr = cond.get("pointer").and_then(Value::as_str).unwrap_or("");
    let actual = envelope
        .get("payload")
        .and_then(|p| resolve_json_pointer(p, ptr))
        .or_else(|| resolve_json_pointer(envelope, ptr));

    match op {
        "exists" => actual.is_some_and(|v| !v.is_null()),
        "eq" => actual == cond.get("value"),
        "neq" => actual != cond.get("value"),
        "lt" => actual
            .and_then(Value::as_f64)
            .zip(cond.get("value").and_then(Value::as_f64))
            .is_some_and(|(a, b)| a < b),
        "lte" => actual
            .and_then(Value::as_f64)
            .zip(cond.get("value").and_then(Value::as_f64))
            .is_some_and(|(a, b)| a <= b),
        "gt" => actual
            .and_then(Value::as_f64)
            .zip(cond.get("value").and_then(Value::as_f64))
            .is_some_and(|(a, b)| a > b),
        "gte" => actual
            .and_then(Value::as_f64)
            .zip(cond.get("value").and_then(Value::as_f64))
            .is_some_and(|(a, b)| a >= b),
        "contains" => {
            let needle = cond.get("needle").and_then(Value::as_str).unwrap_or("");
            match actual {
                Some(Value::String(s)) => s.contains(needle),
                Some(Value::Array(items)) => items.iter().any(|item| match item {
                    Value::String(s) => s == needle,
                    other => serde_json::to_string(other).ok().as_deref() == Some(needle),
                }),
                _ => false,
            }
        }
        "in_set" => cond
            .get("values")
            .and_then(Value::as_array)
            .is_some_and(|vals| actual.is_some_and(|act| vals.contains(act))),
        "regex" => {
            let pattern = cond.get("pattern").and_then(Value::as_str).unwrap_or("");
            actual
                .and_then(Value::as_str)
                .is_some_and(|text| matches_safe_regex(pattern, text))
        }
        _ => false,
    }
}

pub fn render_pulse_template(template: &str, envelope: &Value) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after_open = &rest[start + 2..];
        let Some(end) = after_open.find("}}") else {
            out.push_str(&rest[start..]);
            return out;
        };
        let key = after_open[..end].trim();
        let replacement = match key {
            "event.id" | "eventId" => str_field(envelope, &["eventId", "event_id"])
                .unwrap_or("")
                .to_string(),
            "event.type" | "eventType" => str_field(envelope, &["eventType", "event_type"])
                .unwrap_or("")
                .to_string(),
            "actor.id" => envelope
                .get("actor")
                .and_then(|a| a.get("id"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            "actor.displayName" => envelope
                .get("actor")
                .and_then(|a| {
                    str_field(a, &["displayName", "display_name"]).or_else(|| str_field(a, &["id"]))
                })
                .unwrap_or("")
                .to_string(),
            "threadKey" | "thread_key" => str_field(envelope, &["threadKey", "thread_key"])
                .unwrap_or("")
                .to_string(),
            other => {
                let ptr = if other.starts_with('/') {
                    other.to_string()
                } else {
                    format!(
                        "/{}",
                        other
                            .strip_prefix("payload.")
                            .unwrap_or(other)
                            .replace('.', "/")
                    )
                };
                let resolved = envelope
                    .get("payload")
                    .and_then(|p| resolve_json_pointer(p, &ptr))
                    .or_else(|| resolve_json_pointer(envelope, &ptr));
                match resolved {
                    None | Some(Value::Null) => String::new(),
                    Some(Value::String(s)) => s.clone(),
                    Some(v) => v.to_string(),
                }
            }
        };
        out.push_str(&replacement);
        rest = &after_open[end + 2..];
    }
    out.push_str(rest);
    out
}

pub fn evaluate_pulse_rule_dry_run(spec: &Value, envelope: &Value) -> Value {
    let violations = validate_pulse_rule_spec(spec);
    let is_self = envelope
        .get("actor")
        .and_then(|a| a.get("isSelf").or_else(|| a.get("is_self")))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let hop_count = envelope
        .get("trace")
        .and_then(|t| t.get("hopCount").or_else(|| t.get("hop_count")))
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;

    if is_self || hop_count > MAX_HOP_COUNT {
        return json!({
            "valid": violations.is_empty(),
            "matched": false,
            "loopBlocked": true,
            "violations": violations,
            "unmatchedConditions": [-1],
            "renderedPreviews": [],
        });
    }

    let filter = spec.get("filter").cloned().unwrap_or_else(|| json!({}));
    let list_matches = |keys: &[&str], actual: Option<&str>| -> bool {
        let arr = keys
            .iter()
            .find_map(|k| filter.get(*k).and_then(Value::as_array));
        match arr {
            None => true,
            Some(items) if items.is_empty() => true,
            Some(items) => actual.is_some_and(|act| items.iter().any(|v| v.as_str() == Some(act))),
        }
    };

    let src = envelope.get("source");
    let header_matched = list_matches(
        &["sourceKinds", "source_kinds"],
        src.and_then(|s| s.get("kind")).and_then(Value::as_str),
    ) && list_matches(
        &["sourceInstanceIds", "source_instance_ids"],
        src.and_then(|s| str_field(s, &["instanceId", "instance_id"])),
    ) && list_matches(
        &["eventTypes", "event_types"],
        str_field(envelope, &["eventType", "event_type"]),
    ) && list_matches(
        &["allowedActors", "allowed_actors"],
        envelope
            .get("actor")
            .and_then(|a| a.get("id"))
            .and_then(Value::as_str),
    );

    let mut unmatched_conditions = Vec::new();
    if let Some(conditions) = filter.get("conditions").and_then(Value::as_array) {
        for (idx, cond) in conditions.iter().enumerate() {
            if !evaluate_condition(cond, envelope) {
                unmatched_conditions.push(idx);
            }
        }
    }

    let matched = violations.is_empty() && header_matched && unmatched_conditions.is_empty();
    let rendered_previews = spec
        .get("targets")
        .and_then(Value::as_array)
        .map(|targets| {
            targets
                .iter()
                .map(|target| match target.get("kind").and_then(Value::as_str) {
                    Some("session" | "bot") => render_pulse_template(
                        str_field(target, &["promptTemplate", "prompt_template"]).unwrap_or(""),
                        envelope,
                    ),
                    Some("group") => render_pulse_template(
                        str_field(target, &["messageTemplate", "message_template"]).unwrap_or(""),
                        envelope,
                    ),
                    Some("user") => {
                        let title =
                            str_field(target, &["titleTemplate", "title_template"]).unwrap_or("");
                        let body =
                            str_field(target, &["bodyTemplate", "body_template"]).unwrap_or("");
                        render_pulse_template(&format!("{title}\n{body}"), envelope)
                    }
                    Some("workflow") => {
                        let wf = str_field(target, &["workflowId", "workflow_id"]).unwrap_or("");
                        let ver = target
                            .get("pinnedVersion")
                            .or_else(|| target.get("pinned_version"))
                            .and_then(Value::as_u64)
                            .unwrap_or(1);
                        format!("Workflow {wf}@v{ver}")
                    }
                    _ => String::new(),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    json!({
        "valid": violations.is_empty(),
        "matched": matched,
        "headerMatched": header_matched,
        "violations": violations,
        "unmatchedConditions": unmatched_conditions,
        "renderedPreviews": rendered_previews,
    })
}

/* -------------------------------------------------------------------------- */
/* Non-Backtracking Safe Regex Validator & Matcher (Zero External Deps)       */
/* -------------------------------------------------------------------------- */

#[derive(Clone, Debug)]
enum RegexAtom {
    Any,
    Literal(char),
    Digit,
    Word,
    Space,
    Class {
        negated: bool,
        ranges: Vec<(char, char)>,
    },
}

impl RegexAtom {
    fn matches(&self, ch: char) -> bool {
        match self {
            Self::Any => ch != '\n',
            Self::Literal(c) => *c == ch,
            Self::Digit => ch.is_ascii_digit(),
            Self::Word => ch.is_ascii_alphanumeric() || ch == '_',
            Self::Space => ch.is_whitespace(),
            Self::Class { negated, ranges } => {
                let inside = ranges.iter().any(|(lo, hi)| ch >= *lo && ch <= *hi);
                if *negated { !inside } else { inside }
            }
        }
    }
}

#[derive(Clone, Debug)]
enum Quant {
    One,
    ZeroOrOne,
    ZeroOrMore,
    OneOrMore,
}

#[derive(Clone, Debug)]
enum RegexPiece {
    Atom(RegexAtom, Quant),
    Group(Vec<Vec<RegexPiece>>, Quant),
    AnchorStart,
    AnchorEnd,
}

fn compile_safe_regex(pattern: &str) -> Result<Vec<Vec<RegexPiece>>, String> {
    let chars: Vec<char> = pattern.chars().collect();
    let mut pos = 0usize;
    let branches = parse_alternation(&chars, &mut pos, false)?;
    if pos != chars.len() {
        return Err("Unexpected closing parenthesis in regex.".to_string());
    }
    Ok(branches)
}

fn parse_alternation(
    chars: &[char],
    pos: &mut usize,
    in_group: bool,
) -> Result<Vec<Vec<RegexPiece>>, String> {
    let mut branches = vec![Vec::new()];
    while *pos < chars.len() {
        let ch = chars[*pos];
        if ch == ')' {
            if in_group {
                *pos += 1;
                return Ok(branches);
            }
            return Err("Unmatched ')' in regex.".to_string());
        }
        if ch == '|' {
            *pos += 1;
            branches.push(Vec::new());
            continue;
        }
        let piece = match ch {
            '^' => {
                *pos += 1;
                RegexPiece::AnchorStart
            }
            '$' => {
                *pos += 1;
                RegexPiece::AnchorEnd
            }
            '*' | '+' | '?' => {
                return Err(format!("Quantifier '{ch}' has no preceding token."));
            }
            '(' => {
                *pos += 1;
                let sub = parse_alternation(chars, pos, true)?;
                let quant = parse_quantifier(chars, pos);
                RegexPiece::Group(sub, quant)
            }
            '[' => {
                *pos += 1;
                let atom = parse_char_class(chars, pos)?;
                let quant = parse_quantifier(chars, pos);
                RegexPiece::Atom(atom, quant)
            }
            '\\' => {
                *pos += 1;
                if *pos >= chars.len() {
                    return Err("Trailing backslash in regex.".to_string());
                }
                let esc = chars[*pos];
                *pos += 1;
                let atom = match esc {
                    'd' => RegexAtom::Digit,
                    'w' => RegexAtom::Word,
                    's' => RegexAtom::Space,
                    'n' => RegexAtom::Literal('\n'),
                    'r' => RegexAtom::Literal('\r'),
                    't' => RegexAtom::Literal('\t'),
                    other => RegexAtom::Literal(other),
                };
                let quant = parse_quantifier(chars, pos);
                RegexPiece::Atom(atom, quant)
            }
            '.' => {
                *pos += 1;
                let quant = parse_quantifier(chars, pos);
                RegexPiece::Atom(RegexAtom::Any, quant)
            }
            lit => {
                *pos += 1;
                let quant = parse_quantifier(chars, pos);
                RegexPiece::Atom(RegexAtom::Literal(lit), quant)
            }
        };
        branches.last_mut().unwrap().push(piece);
    }
    if in_group {
        return Err("Unclosed '(' in regex.".to_string());
    }
    Ok(branches)
}

fn parse_char_class(chars: &[char], pos: &mut usize) -> Result<RegexAtom, String> {
    let mut negated = false;
    if *pos < chars.len() && chars[*pos] == '^' {
        negated = true;
        *pos += 1;
    }
    let mut ranges = Vec::new();
    let mut closed = false;
    while *pos < chars.len() {
        let ch = chars[*pos];
        if ch == ']' && !ranges.is_empty() {
            *pos += 1;
            closed = true;
            break;
        }
        let start = if ch == '\\' {
            *pos += 1;
            if *pos >= chars.len() {
                return Err("Unclosed character class '[' in regex.".to_string());
            }
            let c = chars[*pos];
            *pos += 1;
            c
        } else {
            *pos += 1;
            ch
        };
        if *pos + 1 < chars.len() && chars[*pos] == '-' && chars[*pos + 1] != ']' {
            *pos += 1;
            let end = chars[*pos];
            *pos += 1;
            if start > end {
                return Err("Invalid character range in regex class.".to_string());
            }
            ranges.push((start, end));
        } else {
            ranges.push((start, start));
        }
    }
    if !closed {
        return Err("Unclosed character class '[' in regex.".to_string());
    }
    Ok(RegexAtom::Class { negated, ranges })
}

fn parse_quantifier(chars: &[char], pos: &mut usize) -> Quant {
    if *pos >= chars.len() {
        return Quant::One;
    }
    match chars[*pos] {
        '?' => {
            *pos += 1;
            Quant::ZeroOrOne
        }
        '*' => {
            *pos += 1;
            Quant::ZeroOrMore
        }
        '+' => {
            *pos += 1;
            Quant::OneOrMore
        }
        _ => Quant::One,
    }
}

fn matches_safe_regex(pattern: &str, text: &str) -> bool {
    let Ok(branches) = compile_safe_regex(pattern) else {
        return false;
    };
    let input: Vec<char> = text.chars().collect();
    for start in 0..=input.len() {
        if eval_branches(&branches, &input, start)
            .into_iter()
            .next()
            .is_some()
        {
            return true;
        }
    }
    false
}

fn eval_branches(branches: &[Vec<RegexPiece>], input: &[char], start: usize) -> BTreeSet<usize> {
    let mut ends = BTreeSet::new();
    for seq in branches {
        ends.extend(eval_seq(seq, input, start));
    }
    ends
}

fn eval_seq(seq: &[RegexPiece], input: &[char], start: usize) -> BTreeSet<usize> {
    let mut positions = BTreeSet::from([start]);
    for piece in seq {
        let mut next_positions = BTreeSet::new();
        for &pos in &positions {
            match piece {
                RegexPiece::AnchorStart => {
                    if pos == 0 {
                        next_positions.insert(pos);
                    }
                }
                RegexPiece::AnchorEnd => {
                    if pos == input.len() {
                        next_positions.insert(pos);
                    }
                }
                RegexPiece::Atom(atom, quant) => {
                    let step = |p: usize| -> BTreeSet<usize> {
                        if p < input.len() && atom.matches(input[p]) {
                            BTreeSet::from([p + 1])
                        } else {
                            BTreeSet::new()
                        }
                    };
                    next_positions.extend(apply_quant(pos, quant, &step));
                }
                RegexPiece::Group(sub, quant) => {
                    let step = |p: usize| eval_branches(sub, input, p);
                    next_positions.extend(apply_quant(pos, quant, &step));
                }
            }
        }
        positions = next_positions;
        if positions.is_empty() {
            break;
        }
    }
    positions
}

fn apply_quant<F>(start: usize, quant: &Quant, step: &F) -> BTreeSet<usize>
where
    F: Fn(usize) -> BTreeSet<usize>,
{
    match quant {
        Quant::One => step(start),
        Quant::ZeroOrOne => {
            let mut out = step(start);
            out.insert(start);
            out
        }
        Quant::ZeroOrMore => {
            let mut visited = BTreeSet::from([start]);
            let mut frontier = vec![start];
            while let Some(p) = frontier.pop() {
                for next in step(p) {
                    if visited.insert(next) {
                        frontier.push(next);
                    }
                }
            }
            visited
        }
        Quant::OneOrMore => {
            let mut visited = BTreeSet::new();
            let mut frontier: Vec<usize> = step(start).into_iter().collect();
            for &n in &frontier {
                visited.insert(n);
            }
            while let Some(p) = frontier.pop() {
                for next in step(p) {
                    if visited.insert(next) {
                        frontier.push(next);
                    }
                }
            }
            visited
        }
    }
}
