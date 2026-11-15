//! Deterministic zero-eval `GateFilterAst` evaluator, RFC 6901 JSON Pointer
//! resolver, safe template interpolator, and offline dry-run evaluator.

use api_types::pulse::{
    EventEnvelope, GateFilterAst, GateFilterCondition, PulseDryRunReport, PulseRuleSpec,
    PulseTargetSpec,
};
use serde_json::Value;

use crate::{
    guard::{DEFAULT_MAX_HOP_COUNT, EnvelopeGuardVerdict, check_envelope_guard},
    validation::{compile_bounded_regex, validate_rule_spec},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilterEvalOutcome {
    pub header_matched: bool,
    pub unmatched_conditions: Vec<usize>,
    pub matched: bool,
}

/// Resolves an RFC 6901 JSON Pointer (or slash-normalized relative path) against `root`.
pub fn resolve_json_pointer<'a>(root: &'a Value, pointer: &str) -> Option<&'a Value> {
    if pointer.is_empty() || pointer == "/" {
        return Some(root);
    }
    if pointer.starts_with('/') {
        root.pointer(pointer)
    } else {
        let normalized = format!("/{pointer}");
        root.pointer(&normalized)
    }
}

fn lookup_envelope_pointer<'a>(
    envelope: &'a EventEnvelope,
    envelope_value: &'a Value,
    pointer: &str,
) -> Option<&'a Value> {
    resolve_json_pointer(&envelope.payload, pointer)
        .or_else(|| resolve_json_pointer(envelope_value, pointer))
}

pub fn evaluate_condition(
    condition: &GateFilterCondition,
    envelope: &EventEnvelope,
    envelope_value: &Value,
) -> bool {
    match condition {
        GateFilterCondition::NotBotActor => !envelope.actor.is_bot && !envelope.actor.is_self,
        GateFilterCondition::Exists { pointer } => {
            lookup_envelope_pointer(envelope, envelope_value, pointer).is_some_and(|v| !v.is_null())
        }
        GateFilterCondition::Eq { pointer, value } => {
            lookup_envelope_pointer(envelope, envelope_value, pointer)
                .is_some_and(|actual| json_values_equal(actual, value))
        }
        GateFilterCondition::Neq { pointer, value } => {
            match lookup_envelope_pointer(envelope, envelope_value, pointer) {
                Some(actual) => !json_values_equal(actual, value),
                None => !value.is_null(),
            }
        }
        GateFilterCondition::Lt { pointer, value } => {
            lookup_envelope_pointer(envelope, envelope_value, pointer)
                .and_then(Value::as_f64)
                .is_some_and(|actual| actual < *value)
        }
        GateFilterCondition::Lte { pointer, value } => {
            lookup_envelope_pointer(envelope, envelope_value, pointer)
                .and_then(Value::as_f64)
                .is_some_and(|actual| actual <= *value)
        }
        GateFilterCondition::Gt { pointer, value } => {
            lookup_envelope_pointer(envelope, envelope_value, pointer)
                .and_then(Value::as_f64)
                .is_some_and(|actual| actual > *value)
        }
        GateFilterCondition::Gte { pointer, value } => {
            lookup_envelope_pointer(envelope, envelope_value, pointer)
                .and_then(Value::as_f64)
                .is_some_and(|actual| actual >= *value)
        }
        GateFilterCondition::Contains { pointer, needle } => {
            match lookup_envelope_pointer(envelope, envelope_value, pointer) {
                Some(Value::String(text)) => text.contains(needle.as_str()),
                Some(Value::Array(items)) => items
                    .iter()
                    .any(|item| scalar_to_cow_str(item).as_deref() == Some(needle.as_str())),
                _ => false,
            }
        }
        GateFilterCondition::InSet { pointer, values } => {
            lookup_envelope_pointer(envelope, envelope_value, pointer).is_some_and(|actual| {
                values
                    .iter()
                    .any(|candidate| json_values_equal(actual, candidate))
            })
        }
        GateFilterCondition::Regex { pointer, pattern } => {
            let Some(Value::String(text)) =
                lookup_envelope_pointer(envelope, envelope_value, pointer)
            else {
                return false;
            };
            compile_bounded_regex(pattern).is_ok_and(|re| re.is_match(text))
        }
    }
}

pub fn evaluate_filter_ast(filter: &GateFilterAst, envelope: &EventEnvelope) -> FilterEvalOutcome {
    let header_matched = (filter.source_kinds.is_empty()
        || filter.source_kinds.contains(&envelope.source.kind))
        && (filter.source_instance_ids.is_empty()
            || filter
                .source_instance_ids
                .contains(&envelope.source.instance_id))
        && (filter.event_types.is_empty() || filter.event_types.contains(&envelope.event_type))
        && (filter.allowed_actors.is_empty() || filter.allowed_actors.contains(&envelope.actor.id));

    let envelope_value = serde_json::to_value(envelope).unwrap_or(Value::Null);
    let mut unmatched_conditions = Vec::new();
    for (idx, condition) in filter.conditions.iter().enumerate() {
        if !evaluate_condition(condition, envelope, &envelope_value) {
            unmatched_conditions.push(idx);
        }
    }

    let matched = header_matched && unmatched_conditions.is_empty();
    FilterEvalOutcome {
        header_matched,
        unmatched_conditions,
        matched,
    }
}

/// Zero-eval template renderer supporting `{{event.id}}`, `{{actor.displayName}}`,
/// RFC 6901 JSON Pointers (`{{/issue/key}}`), and dotted paths (`{{payload.issue.key}}`).
pub fn render_template(template: &str, envelope: &EventEnvelope) -> String {
    if !template.contains("{{") {
        return template.to_string();
    }

    let envelope_value = serde_json::to_value(envelope).unwrap_or(Value::Null);
    let mut output = String::with_capacity(template.len());
    let mut rest = template;

    while let Some(open_idx) = rest.find("{{") {
        output.push_str(&rest[..open_idx]);
        let after_open = &rest[open_idx + 2..];
        if let Some(close_idx) = after_open.find("}}") {
            let raw_key = after_open[..close_idx].trim();
            let replacement = resolve_template_token(raw_key, envelope, &envelope_value);
            output.push_str(&replacement);
            rest = &after_open[close_idx + 2..];
        } else {
            // Unclosed `{{` is preserved verbatim rather than panicking or executing code.
            output.push_str(&rest[open_idx..]);
            return output;
        }
    }

    output.push_str(rest);
    output
}

fn resolve_template_token(key: &str, envelope: &EventEnvelope, envelope_value: &Value) -> String {
    match key {
        "event.id" | "eventId" => return envelope.event_id.clone(),
        "delivery.id" | "deliveryId" => return envelope.delivery_id.clone(),
        "event.type" | "eventType" => return envelope.event_type.clone(),
        "occurredAt" | "event.occurredAt" => return envelope.occurred_at.clone(),
        "actor.id" => return envelope.actor.id.clone(),
        "actor.displayName" => {
            return envelope
                .actor
                .display_name
                .clone()
                .unwrap_or_else(|| envelope.actor.id.clone());
        }
        "threadKey" | "thread.key" => return envelope.thread_key.clone().unwrap_or_default(),
        "source.instanceId" => return envelope.source.instance_id.clone(),
        "source.kind" => {
            return serde_json::to_value(envelope.source.kind)
                .ok()
                .and_then(|v| v.as_str().map(str::to_string))
                .unwrap_or_default();
        }
        _ => {}
    }

    let pointer = if key.starts_with('/') {
        key.to_string()
    } else {
        let stripped = key.strip_prefix("payload.").unwrap_or(key);
        format!("/{}", stripped.replace('.', "/"))
    };

    let resolved = resolve_json_pointer(&envelope.payload, &pointer)
        .or_else(|| resolve_json_pointer(envelope_value, &pointer));

    match resolved {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(complex) => serde_json::to_string(complex).unwrap_or_default(),
    }
}

pub fn dry_run_rule(spec: &PulseRuleSpec, envelope: &EventEnvelope) -> PulseDryRunReport {
    let violations = validate_rule_spec(spec);
    let valid = violations.is_empty();

    if check_envelope_guard(envelope, DEFAULT_MAX_HOP_COUNT) != EnvelopeGuardVerdict::Allow {
        return PulseDryRunReport {
            valid,
            matched: false,
            violations,
            unmatched_conditions: Vec::new(),
            rendered_previews: Vec::new(),
        };
    }

    let eval = evaluate_filter_ast(&spec.filter, envelope);
    let matched = valid && eval.matched;

    let rendered_previews = spec
        .targets
        .iter()
        .map(|target| match target {
            PulseTargetSpec::Session {
                prompt_template, ..
            }
            | PulseTargetSpec::Bot {
                prompt_template, ..
            } => render_template(prompt_template, envelope),
            PulseTargetSpec::Group {
                message_template, ..
            } => render_template(message_template, envelope),
            PulseTargetSpec::User {
                title_template,
                body_template,
                ..
            } => render_template(&format!("{title_template}\n{body_template}"), envelope),
            PulseTargetSpec::Workflow {
                workflow_id,
                pinned_version,
                ..
            } => format!("Workflow {workflow_id}@v{pinned_version}"),
        })
        .collect();

    PulseDryRunReport {
        valid,
        matched,
        violations,
        unmatched_conditions: eval.unmatched_conditions,
        rendered_previews,
    }
}

fn json_values_equal(left: &Value, right: &Value) -> bool {
    if left == right {
        return true;
    }
    if let (Some(l), Some(r)) = (left.as_f64(), right.as_f64()) {
        return (l - r).abs() <= f64::EPSILON;
    }
    false
}

fn scalar_to_cow_str(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(n) => Some(n.to_string()),
        Value::Null => None,
        other => serde_json::to_string(other).ok(),
    }
}
