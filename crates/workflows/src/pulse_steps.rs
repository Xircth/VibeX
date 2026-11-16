pub use api_types::{
    ApprovalOptionSpec, BotConversationScope, BotMailboxPolicy, EventActor, EventEnvelope,
    EventSourceKind, EventSourceMeta, EventTrace, EventTrustLevel, GateFilterAst,
    GateFilterCondition, GroupDispatchMode, GroupMentionOrder, PresetOrchestratorKind,
    PulseEvalMode, PulseRuleSpec, PulseTargetSpec, PulseWorkspaceIsolation, ReplyChannelAddress,
    UserInteractionKind, UserInteractionSeverity,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{CompletionPolicy, WorkspaceAccess};

pub type UserGateInteractionKind = UserInteractionKind;

pub const MAX_BOUNDED_LOOP_ITERATIONS: u32 = 50;
pub const MAX_WAIT_FOR_EVENT_TIMEOUT_SECONDS: u32 = 7 * 24 * 60 * 60;
pub const MAX_GATE_FILTER_CONDITIONS: usize = 128;

fn default_payload_object() -> serde_json::Value {
    serde_json::Value::Object(serde_json::Map::new())
}

/// Ephemeral Session orchestration primitive: creates a brand-new session per
/// workflow step invocation with refreshed, isolated context.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct SessionStepSpec {
    pub agent_id: String,
    pub prompt_template: String,
    #[serde(default)]
    pub workspace_access: WorkspaceAccess,
    #[serde(default)]
    pub model_override: Option<String>,
    #[serde(default)]
    pub subscribe_thread: bool,
    #[serde(default)]
    pub completion: CompletionPolicy,
    #[serde(default)]
    pub output_schema: Option<serde_json::Value>,
}

/// Persistent Bot orchestration primitive: bound to a long-lived Bot identity
/// (`member_id`) and fixed primary or thread-scoped conversation, never
/// resetting the Bot's accumulated conversation memory across runs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct BotStepSpec {
    pub member_id: String,
    #[serde(default)]
    pub conversation_scope: BotConversationScope,
    #[serde(default)]
    pub mailbox_policy: BotMailboxPolicy,
    pub prompt_template: String,
    #[serde(default)]
    pub completion: CompletionPolicy,
    #[serde(default)]
    pub output_schema: Option<serde_json::Value>,
}

/// Collaboration Group stage primitive: dispatches work into a Group space
/// targeting a specific seat, mentioned seats, moderator triage, or broadcast log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct GroupStageStepSpec {
    pub space_id: String,
    pub dispatch_mode: GroupDispatchMode,
    pub message_template: String,
    #[serde(default)]
    pub quorum_count: Option<u32>,
}

/// Rich human interaction gate (`notify` | `approval` | `ask_form` | `digest`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct UserGateStepSpec {
    #[serde(default)]
    pub interaction_kind: UserInteractionKind,
    pub title_template: String,
    #[serde(default)]
    pub body_template: String,
    #[serde(default)]
    pub approval_options: Vec<ApprovalOptionSpec>,
    #[serde(default)]
    pub form_schema: Option<serde_json::Value>,
    #[serde(default)]
    pub sla_timeout_seconds: Option<u32>,
}

/// Deterministic zero-eval JSON Pointer condition branch routing to `then_step_ids`
/// when `filter` matches or `else_step_ids` otherwise.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct ConditionBranchStepSpec {
    #[serde(default)]
    pub filter: GateFilterAst,
    #[serde(default)]
    pub then_step_ids: Vec<String>,
    #[serde(default)]
    pub else_step_ids: Vec<String>,
}

/// Explicit bounded iteration over `target_step_ids` capped at `max_iterations` (1..=50).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct BoundedLoopStepSpec {
    pub target_step_ids: Vec<String>,
    pub max_iterations: u32,
    #[serde(default)]
    pub until_condition: Option<GateFilterCondition>,
}

/// Event Saga suspension primitive: pauses execution until a matching `EventEnvelope` arrives.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct WaitForEventStepSpec {
    pub event_types: Vec<String>,
    #[serde(default)]
    pub thread_key_pointer: Option<String>,
    #[serde(default)]
    pub filter: Option<GateFilterAst>,
    #[serde(default)]
    pub timeout_seconds: Option<u32>,
}

/// External side-effect action kind emitted through transactional outbox.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum OutboxActionKind {
    #[default]
    ReplyChannel,
    WebhookPost,
    EmitEvent,
}

/// Idempotent external side-effect step (`reply_channel` | `webhook_post` | `emit_event`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct OutboxActionStepSpec {
    pub action_kind: OutboxActionKind,
    pub target_template: String,
    #[serde(default = "default_payload_object")]
    pub payload_template: serde_json::Value,
}

/// Resolves an RFC 6901 JSON Pointer (or relative slash-separated pointer)
/// against a JSON value without executing arbitrary expressions.
pub fn resolve_json_pointer<'a>(
    root: &'a serde_json::Value,
    pointer: &str,
) -> Option<&'a serde_json::Value> {
    if pointer.is_empty() || pointer == "/" {
        return Some(root);
    }
    if pointer.starts_with('/') {
        return root.pointer(pointer);
    }
    let normalized = format!("/{pointer}");
    root.pointer(&normalized)
}

fn json_values_equal(left: &serde_json::Value, right: &serde_json::Value) -> bool {
    if left == right {
        return true;
    }
    if let (Some(l_num), Some(r_num)) = (left.as_f64(), right.as_f64()) {
        return (l_num - r_num).abs() < f64::EPSILON;
    }
    false
}

fn evaluate_scalar_condition(
    condition: &GateFilterCondition,
    actual: Option<&serde_json::Value>,
) -> bool {
    match condition {
        GateFilterCondition::NotBotActor => true,
        GateFilterCondition::Exists { .. } => actual.is_some_and(|value| !value.is_null()),
        GateFilterCondition::Eq { value, .. } => {
            actual.is_some_and(|candidate| json_values_equal(candidate, value))
        }
        GateFilterCondition::Neq { value, .. } => {
            actual.is_none_or(|candidate| !json_values_equal(candidate, value))
        }
        GateFilterCondition::Lt { value, .. } => actual
            .and_then(serde_json::Value::as_f64)
            .is_some_and(|num| num < *value),
        GateFilterCondition::Lte { value, .. } => actual
            .and_then(serde_json::Value::as_f64)
            .is_some_and(|num| num <= *value),
        GateFilterCondition::Gt { value, .. } => actual
            .and_then(serde_json::Value::as_f64)
            .is_some_and(|num| num > *value),
        GateFilterCondition::Gte { value, .. } => actual
            .and_then(serde_json::Value::as_f64)
            .is_some_and(|num| num >= *value),
        GateFilterCondition::Contains { needle, .. } => match actual {
            Some(serde_json::Value::String(text)) => text.contains(needle),
            Some(serde_json::Value::Array(items)) => items.iter().any(|item| match item {
                serde_json::Value::String(s) => s == needle,
                other => other.to_string() == *needle,
            }),
            _ => false,
        },
        GateFilterCondition::InSet { values, .. } => actual.is_some_and(|candidate| {
            values
                .iter()
                .any(|allowed| json_values_equal(allowed, candidate))
        }),
        GateFilterCondition::Regex { pattern, .. } => actual
            .and_then(serde_json::Value::as_str)
            .is_some_and(|text| Regex::new(pattern).is_ok_and(|re| re.is_match(text))),
    }
}

fn condition_pointer(condition: &GateFilterCondition) -> Option<&str> {
    match condition {
        GateFilterCondition::Eq { pointer, .. }
        | GateFilterCondition::Neq { pointer, .. }
        | GateFilterCondition::Lt { pointer, .. }
        | GateFilterCondition::Lte { pointer, .. }
        | GateFilterCondition::Gt { pointer, .. }
        | GateFilterCondition::Gte { pointer, .. }
        | GateFilterCondition::Contains { pointer, .. }
        | GateFilterCondition::InSet { pointer, .. }
        | GateFilterCondition::Exists { pointer }
        | GateFilterCondition::Regex { pointer, .. } => Some(pointer.as_str()),
        GateFilterCondition::NotBotActor => None,
    }
}

/// Evaluates a single `GateFilterCondition` against an `EventEnvelope`
/// (checking `envelope.payload` first, then falling back to the full serialized envelope).
pub fn evaluate_gate_condition(condition: &GateFilterCondition, envelope: &EventEnvelope) -> bool {
    if matches!(condition, GateFilterCondition::NotBotActor) {
        return !envelope.actor.is_bot && !envelope.actor.is_self;
    }
    let Some(pointer) = condition_pointer(condition) else {
        return true;
    };
    let from_payload = resolve_json_pointer(&envelope.payload, pointer);
    if from_payload.is_some() {
        return evaluate_scalar_condition(condition, from_payload);
    }
    let Ok(envelope_json) = serde_json::to_value(envelope) else {
        return false;
    };
    let from_envelope = resolve_json_pointer(&envelope_json, pointer);
    evaluate_scalar_condition(condition, from_envelope)
}

/// Evaluates a single `GateFilterCondition` against an arbitrary JSON context object.
pub fn evaluate_gate_condition_on_value(
    condition: &GateFilterCondition,
    value: &serde_json::Value,
) -> bool {
    if let Ok(envelope) = serde_json::from_value::<EventEnvelope>(value.clone()) {
        return evaluate_gate_condition(condition, &envelope);
    }
    if matches!(condition, GateFilterCondition::NotBotActor) {
        let is_bot = resolve_json_pointer(value, "/actor/isBot")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let is_self = resolve_json_pointer(value, "/actor/isSelf")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        return !is_bot && !is_self;
    }
    let Some(pointer) = condition_pointer(condition) else {
        return true;
    };
    let candidate = resolve_json_pointer(value, pointer).or_else(|| {
        value
            .get("payload")
            .and_then(|payload| resolve_json_pointer(payload, pointer))
    });
    evaluate_scalar_condition(condition, candidate)
}

/// Evaluates a `GateFilterAst` against an `EventEnvelope`.
pub fn evaluate_gate_filter_envelope(filter: &GateFilterAst, envelope: &EventEnvelope) -> bool {
    if envelope.actor.is_self {
        return false;
    }
    if !filter.source_kinds.is_empty() && !filter.source_kinds.contains(&envelope.source.kind) {
        return false;
    }
    if !filter.source_instance_ids.is_empty()
        && !filter
            .source_instance_ids
            .contains(&envelope.source.instance_id)
    {
        return false;
    }
    if !filter.event_types.is_empty() && !filter.event_types.contains(&envelope.event_type) {
        return false;
    }
    if !filter.allowed_actors.is_empty() && !filter.allowed_actors.contains(&envelope.actor.id) {
        return false;
    }
    filter
        .conditions
        .iter()
        .all(|condition| evaluate_gate_condition(condition, envelope))
}

/// Evaluates a `GateFilterAst` against a workflow step JSON context (which may be
/// a serialized `EventEnvelope`, contain an `"event"` envelope field, or hold step outputs).
pub fn evaluate_gate_filter_on_value(filter: &GateFilterAst, value: &serde_json::Value) -> bool {
    if let Ok(envelope) = serde_json::from_value::<EventEnvelope>(value.clone()) {
        return evaluate_gate_filter_envelope(filter, &envelope);
    }
    if let Some(event_val) = value.get("event")
        && let Ok(envelope) = serde_json::from_value::<EventEnvelope>(event_val.clone())
    {
        return evaluate_gate_filter_envelope(filter, &envelope);
    }
    if !filter.event_types.is_empty() {
        let actual_type =
            resolve_json_pointer(value, "/eventType").and_then(serde_json::Value::as_str);
        if !actual_type.is_some_and(|kind| filter.event_types.iter().any(|e| e == kind)) {
            return false;
        }
    }
    if !filter.allowed_actors.is_empty() {
        let actual_actor =
            resolve_json_pointer(value, "/actor/id").and_then(serde_json::Value::as_str);
        if !actual_actor.is_some_and(|actor| filter.allowed_actors.iter().any(|a| a == actor)) {
            return false;
        }
    }
    filter
        .conditions
        .iter()
        .all(|condition| evaluate_gate_condition_on_value(condition, value))
}

/// Matches a suspended `WaitForEvent` step specification and its workflow correlation
/// context against an incoming `EventEnvelope`.
pub fn match_waiting_step(
    spec: &WaitForEventStepSpec,
    context: &serde_json::Value,
    envelope: &EventEnvelope,
) -> bool {
    if envelope.actor.is_self {
        return false;
    }
    if !spec.event_types.is_empty()
        && !spec
            .event_types
            .iter()
            .any(|expected| expected == &envelope.event_type)
    {
        return false;
    }
    if let Some(pointer) = spec.thread_key_pointer.as_deref() {
        let expected_thread_key = resolve_json_pointer(context, pointer)
            .or_else(|| {
                context
                    .get("payload")
                    .and_then(|payload| resolve_json_pointer(payload, pointer))
            })
            .or_else(|| {
                context
                    .get("event")
                    .and_then(|event| resolve_json_pointer(event, pointer))
            })
            .and_then(serde_json::Value::as_str)
            .filter(|key| !key.trim().is_empty());
        let Some(expected) = expected_thread_key else {
            return false;
        };
        if envelope.thread_key.as_deref() != Some(expected) {
            return false;
        }
    }
    if let Some(filter) = &spec.filter
        && !evaluate_gate_filter_envelope(filter, envelope)
    {
        return false;
    }
    true
}

pub(crate) fn validate_gate_condition(
    condition: &GateFilterCondition,
    path: &str,
    errors: &mut Vec<String>,
) {
    if let Some(pointer) = condition_pointer(condition) {
        if pointer.trim().is_empty() {
            errors.push(format!("{path}.pointer must not be empty"));
        } else if !pointer.starts_with('/') {
            errors.push(format!(
                "{path}.pointer `{pointer}` must start with / (RFC 6901 JSON Pointer)"
            ));
        }
    }
    match condition {
        GateFilterCondition::Lt { value, .. }
        | GateFilterCondition::Lte { value, .. }
        | GateFilterCondition::Gt { value, .. }
        | GateFilterCondition::Gte { value, .. } => {
            if !value.is_finite() {
                errors.push(format!("{path}.value must be a finite number"));
            }
        }
        GateFilterCondition::InSet { values, .. } => {
            if values.is_empty() {
                errors.push(format!("{path}.values must not be empty"));
            }
        }
        GateFilterCondition::Regex { pattern, .. } => {
            if pattern.is_empty() {
                errors.push(format!("{path}.pattern must not be empty"));
            } else if let Err(err) = Regex::new(pattern) {
                errors.push(format!(
                    "{path}.pattern has invalid regex `{pattern}`: {err}"
                ));
            }
        }
        _ => {}
    }
}

pub(crate) fn validate_gate_filter_ast(
    filter: &GateFilterAst,
    path: &str,
    errors: &mut Vec<String>,
) {
    if filter.conditions.len() > MAX_GATE_FILTER_CONDITIONS {
        errors.push(format!(
            "{path}.conditions exceeds maximum of {MAX_GATE_FILTER_CONDITIONS} conditions"
        ));
    }
    for (index, instance_id) in filter.source_instance_ids.iter().enumerate() {
        if instance_id.trim().is_empty() {
            errors.push(format!(
                "{path}.sourceInstanceIds[{index}] must not be empty"
            ));
        }
    }
    for (index, event_type) in filter.event_types.iter().enumerate() {
        if event_type.trim().is_empty() {
            errors.push(format!("{path}.eventTypes[{index}] must not be empty"));
        }
    }
    for (index, actor_id) in filter.allowed_actors.iter().enumerate() {
        if actor_id.trim().is_empty() {
            errors.push(format!("{path}.allowedActors[{index}] must not be empty"));
        }
    }
    for (index, condition) in filter.conditions.iter().enumerate() {
        validate_gate_condition(condition, &format!("{path}.conditions[{index}]"), errors);
    }
}
