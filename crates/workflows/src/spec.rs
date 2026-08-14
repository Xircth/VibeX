use std::collections::{BTreeMap, BTreeSet, VecDeque};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::WorkflowError;

pub const WORKFLOW_DEFINITION_VERSION: u32 = 1;
pub const MAX_WORKFLOW_STEPS: usize = 1_000;
pub(crate) const MAX_WORKFLOW_INPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_WORKFLOW_DEFINITION_BYTES: usize = 4 * 1024 * 1024;
const MAX_STEP_PROMPT_BYTES: usize = 64 * 1024;
const MAX_SCHEMA_DEPTH: usize = 32;
const MAX_SCHEMA_NODES: usize = 10_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct WorkflowDefinition {
    pub format_version: u32,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub input_schema: Option<serde_json::Value>,
    pub steps: Vec<WorkflowStep>,
    #[serde(default)]
    pub policy: WorkflowPolicy,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct WorkflowStep {
    pub id: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub phase: Option<String>,
    #[serde(default)]
    pub input_bindings: BTreeMap<String, WorkflowBinding>,
    #[serde(flatten)]
    pub spec: WorkflowStepSpec,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum WorkflowStepSpec {
    Agent(AgentStepSpec),
    Approval(ApprovalStepSpec),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct AgentStepSpec {
    pub agent_id: String,
    pub prompt: String,
    #[serde(default)]
    pub output_schema: Option<serde_json::Value>,
    #[serde(default)]
    pub workspace_access: WorkspaceAccess,
    #[serde(default)]
    pub side_effect_class: SideEffectClass,
    #[serde(default)]
    pub allow_one_repair: bool,
    #[serde(default)]
    pub allow_skip_on_review: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct ApprovalStepSpec {
    pub title: String,
    pub decision_schema: serde_json::Value,
    pub approver_scope: String,
    #[serde(default)]
    pub skippable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "source", rename_all = "snake_case")]
#[ts(export)]
pub enum WorkflowBinding {
    RunInput { pointer: String },
    StepOutput { step_id: String, pointer: String },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum WorkspaceAccess {
    ReadOnlyShared,
    #[default]
    WriteSerialized,
    WriteIsolated,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SideEffectClass {
    ReadOnly,
    Idempotent,
    #[default]
    MutatingUnknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct WorkflowPolicy {
    pub max_concurrent_agent_steps: u32,
    pub max_agent_calls: u32,
    pub deadline_seconds: u64,
    pub max_output_bytes: usize,
}

impl Default for WorkflowPolicy {
    fn default() -> Self {
        Self {
            max_concurrent_agent_steps: 4,
            max_agent_calls: 64,
            deadline_seconds: 60 * 60,
            max_output_bytes: 1024 * 1024,
        }
    }
}

pub fn normalize_definition(
    mut definition: WorkflowDefinition,
) -> Result<WorkflowDefinition, WorkflowError> {
    definition.name = definition.name.trim().to_string();
    definition.description = definition
        .description
        .map(|description| description.trim().to_string())
        .filter(|description| !description.is_empty());
    for step in &mut definition.steps {
        step.id = step.id.trim().to_string();
        step.depends_on.sort();
        step.depends_on.dedup();
    }
    definition
        .steps
        .sort_by(|left, right| left.id.cmp(&right.id));
    validate_definition(&definition)?;
    Ok(definition)
}

pub fn validate_definition(definition: &WorkflowDefinition) -> Result<(), WorkflowError> {
    if serde_json::to_vec(definition)?.len() > MAX_WORKFLOW_DEFINITION_BYTES {
        return Err(WorkflowError::Validation(format!(
            "workflow definition exceeds {MAX_WORKFLOW_DEFINITION_BYTES} bytes"
        )));
    }
    if definition.format_version != WORKFLOW_DEFINITION_VERSION {
        return Err(WorkflowError::Validation(format!(
            "unsupported workflow format version {}",
            definition.format_version
        )));
    }
    if definition.name.is_empty() || definition.name.len() > 200 {
        return Err(WorkflowError::Validation(
            "workflow name must contain 1..=200 bytes".to_string(),
        ));
    }
    if definition.steps.is_empty() || definition.steps.len() > MAX_WORKFLOW_STEPS {
        return Err(WorkflowError::Validation(format!(
            "workflow must contain 1..={MAX_WORKFLOW_STEPS} steps"
        )));
    }
    validate_policy(&definition.policy)?;
    if let Some(schema) = &definition.input_schema {
        validate_json_schema(schema)?;
    }

    let mut ids = BTreeSet::new();
    for step in &definition.steps {
        if !valid_step_id(&step.id) || !ids.insert(step.id.as_str()) {
            return Err(WorkflowError::Validation(format!(
                "invalid or duplicate step id `{}`",
                step.id
            )));
        }
        match &step.spec {
            WorkflowStepSpec::Agent(agent) => {
                if agent.agent_id.trim().is_empty() || agent.prompt.trim().is_empty() {
                    return Err(WorkflowError::Validation(format!(
                        "agent step `{}` requires agentId and prompt",
                        step.id
                    )));
                }
                if agent.agent_id.len() > 200 || agent.prompt.len() > MAX_STEP_PROMPT_BYTES {
                    return Err(WorkflowError::Validation(format!(
                        "agent step `{}` agentId or prompt exceeds supported size",
                        step.id
                    )));
                }
                if agent.side_effect_class == SideEffectClass::ReadOnly
                    && agent.workspace_access != WorkspaceAccess::ReadOnlyShared
                {
                    return Err(WorkflowError::Validation(format!(
                        "step `{}` claims read_only without read_only_shared enforcement",
                        step.id
                    )));
                }
                if let Some(schema) = &agent.output_schema {
                    validate_json_schema(schema)?;
                }
            }
            WorkflowStepSpec::Approval(approval) => {
                if approval.title.trim().is_empty() || approval.approver_scope.trim().is_empty() {
                    return Err(WorkflowError::Validation(format!(
                        "approval step `{}` requires title and approverScope",
                        step.id
                    )));
                }
                validate_json_schema(&approval.decision_schema)?;
            }
        }
    }

    let by_id = definition
        .steps
        .iter()
        .map(|step| (step.id.as_str(), step))
        .collect::<BTreeMap<_, _>>();
    for step in &definition.steps {
        for dependency in &step.depends_on {
            if dependency == &step.id || !by_id.contains_key(dependency.as_str()) {
                return Err(WorkflowError::Validation(format!(
                    "step `{}` has invalid dependency `{dependency}`",
                    step.id
                )));
            }
        }
        for binding in step.input_bindings.values() {
            if let WorkflowBinding::StepOutput { step_id, pointer } = binding {
                let source = by_id.get(step_id.as_str()).ok_or_else(|| {
                    WorkflowError::Validation(format!(
                        "step `{}` binding references unknown step `{step_id}`",
                        step.id
                    ))
                })?;
                if !is_transitive_dependency(&by_id, &step.id, step_id) {
                    return Err(WorkflowError::Validation(format!(
                        "step `{}` reads `{step_id}` without depending on it",
                        step.id
                    )));
                }
                if !matches!(
                    source.spec,
                    WorkflowStepSpec::Agent(AgentStepSpec {
                        output_schema: Some(_),
                        ..
                    }) | WorkflowStepSpec::Approval(_)
                ) {
                    return Err(WorkflowError::Validation(format!(
                        "step `{step_id}` has no accepted structured output"
                    )));
                }
                validate_pointer(pointer)?;
            }
        }
    }
    deterministic_order(definition)?;
    Ok(())
}

pub(crate) fn deterministic_order(
    definition: &WorkflowDefinition,
) -> Result<Vec<String>, WorkflowError> {
    let mut incoming = definition
        .steps
        .iter()
        .map(|step| (step.id.clone(), step.depends_on.len()))
        .collect::<BTreeMap<_, _>>();
    let mut outgoing = BTreeMap::<String, Vec<String>>::new();
    for step in &definition.steps {
        for dependency in &step.depends_on {
            outgoing
                .entry(dependency.clone())
                .or_default()
                .push(step.id.clone());
        }
    }
    for children in outgoing.values_mut() {
        children.sort();
    }
    let mut ready = incoming
        .iter()
        .filter_map(|(id, count)| (*count == 0).then_some(id.clone()))
        .collect::<VecDeque<_>>();
    let mut order = Vec::with_capacity(definition.steps.len());
    while let Some(id) = ready.pop_front() {
        order.push(id.clone());
        for child in outgoing.get(&id).into_iter().flatten() {
            let count = incoming.get_mut(child).expect("validated child");
            *count -= 1;
            if *count == 0 {
                let index = ready.partition_point(|queued| queued < child);
                ready.insert(index, child.clone());
            }
        }
    }
    if order.len() != definition.steps.len() {
        return Err(WorkflowError::Validation(
            "workflow dependency graph contains a cycle".to_string(),
        ));
    }
    Ok(order)
}

pub fn validate_json_schema(schema: &serde_json::Value) -> Result<(), WorkflowError> {
    let mut nodes = 0;
    validate_schema_node(schema, 0, "$", &mut nodes)
}

pub fn validate_json_value(
    schema: &serde_json::Value,
    value: &serde_json::Value,
) -> Result<(), WorkflowError> {
    validate_json_schema(schema)?;
    validate_value_node(schema, value, "$")
}

fn validate_value_node(
    schema: &serde_json::Value,
    value: &serde_json::Value,
    path: &str,
) -> Result<(), WorkflowError> {
    let object = schema.as_object().expect("schema validated above");
    if let Some(allowed) = object.get("enum").and_then(serde_json::Value::as_array)
        && !allowed.contains(value)
    {
        return Err(WorkflowError::Validation(format!(
            "value at {path} is outside enum"
        )));
    }
    let valid_type = match object.get("type").and_then(serde_json::Value::as_str) {
        None => true,
        Some("object") => value.is_object(),
        Some("array") => value.is_array(),
        Some("string") => value.is_string(),
        Some("number") => value.is_number(),
        Some("integer") => value.as_i64().is_some() || value.as_u64().is_some(),
        Some("boolean") => value.is_boolean(),
        Some("null") => value.is_null(),
        Some(_) => false,
    };
    if !valid_type {
        return Err(WorkflowError::Validation(format!(
            "value at {path} does not match schema type"
        )));
    }
    if let Some(text) = value.as_str() {
        let length = text.chars().count() as u64;
        if object
            .get("minLength")
            .and_then(serde_json::Value::as_u64)
            .is_some_and(|minimum| length < minimum)
            || object
                .get("maxLength")
                .and_then(serde_json::Value::as_u64)
                .is_some_and(|maximum| length > maximum)
        {
            return Err(WorkflowError::Validation(format!(
                "string length at {path} is outside schema bounds"
            )));
        }
    }
    if let Some(number) = value.as_f64()
        && (object
            .get("minimum")
            .and_then(serde_json::Value::as_f64)
            .is_some_and(|minimum| number < minimum)
            || object
                .get("maximum")
                .and_then(serde_json::Value::as_f64)
                .is_some_and(|maximum| number > maximum))
    {
        return Err(WorkflowError::Validation(format!(
            "number at {path} is outside schema bounds"
        )));
    }
    if let Some(values) = value.as_array() {
        let length = values.len() as u64;
        if object
            .get("minItems")
            .and_then(serde_json::Value::as_u64)
            .is_some_and(|minimum| length < minimum)
            || object
                .get("maxItems")
                .and_then(serde_json::Value::as_u64)
                .is_some_and(|maximum| length > maximum)
        {
            return Err(WorkflowError::Validation(format!(
                "array length at {path} is outside schema bounds"
            )));
        }
        if let Some(items) = object.get("items") {
            for (index, item) in values.iter().enumerate() {
                validate_value_node(items, item, &format!("{path}/{index}"))?;
            }
        }
    }
    if let Some(value_object) = value.as_object() {
        if let Some(required) = object.get("required").and_then(serde_json::Value::as_array) {
            for field in required.iter().filter_map(serde_json::Value::as_str) {
                if !value_object.contains_key(field) {
                    return Err(WorkflowError::Validation(format!(
                        "required property `{field}` is missing at {path}"
                    )));
                }
            }
        }
        if let Some(properties) = object
            .get("properties")
            .and_then(serde_json::Value::as_object)
        {
            for (field, child_schema) in properties {
                if let Some(child_value) = value_object.get(field) {
                    validate_value_node(child_schema, child_value, &format!("{path}/{field}"))?;
                }
            }
            if object.get("additionalProperties") == Some(&serde_json::Value::Bool(false)) {
                for field in value_object.keys() {
                    if !properties.contains_key(field) {
                        return Err(WorkflowError::Validation(format!(
                            "additional property `{field}` is not allowed at {path}"
                        )));
                    }
                }
            }
        }
    }
    Ok(())
}

fn validate_schema_node(
    schema: &serde_json::Value,
    depth: usize,
    path: &str,
    nodes: &mut usize,
) -> Result<(), WorkflowError> {
    *nodes += 1;
    if *nodes > MAX_SCHEMA_NODES {
        return Err(WorkflowError::Validation(format!(
            "schema exceeds {MAX_SCHEMA_NODES} nodes at {path}"
        )));
    }
    if depth > MAX_SCHEMA_DEPTH {
        return Err(WorkflowError::Validation(format!(
            "schema exceeds {MAX_SCHEMA_DEPTH} levels at {path}"
        )));
    }
    let object = schema.as_object().ok_or_else(|| {
        WorkflowError::Validation(format!("schema node at {path} must be an object"))
    })?;
    const ALLOWED: &[&str] = &[
        "type",
        "enum",
        "required",
        "properties",
        "items",
        "minLength",
        "maxLength",
        "minimum",
        "maximum",
        "minItems",
        "maxItems",
        "additionalProperties",
        "description",
    ];
    for key in object.keys() {
        if !ALLOWED.contains(&key.as_str()) {
            return Err(WorkflowError::Validation(format!(
                "unsupported schema keyword `{key}` at {path}"
            )));
        }
    }
    if let Some(kind) = object.get("type") {
        let valid = kind.as_str().is_some_and(|kind| {
            matches!(
                kind,
                "object" | "array" | "string" | "number" | "integer" | "boolean" | "null"
            )
        });
        if !valid {
            return Err(WorkflowError::Validation(format!(
                "unsupported schema type at {path}"
            )));
        }
    }
    if let Some(values) = object.get("enum") {
        let values = values
            .as_array()
            .filter(|values| !values.is_empty())
            .ok_or_else(|| {
                WorkflowError::Validation(format!("enum at {path} must be a non-empty array"))
            })?;
        let mut unique = BTreeSet::new();
        for value in values {
            let normalized = serde_json::to_string(value)?;
            if !unique.insert(normalized) {
                return Err(WorkflowError::Validation(format!(
                    "enum at {path} contains duplicate values"
                )));
            }
        }
    }
    if let Some(required) = object.get("required") {
        let required = required.as_array().ok_or_else(|| {
            WorkflowError::Validation(format!("required at {path} must be an array"))
        })?;
        let mut unique = BTreeSet::new();
        for field in required {
            let field = field
                .as_str()
                .filter(|field| !field.is_empty())
                .ok_or_else(|| {
                    WorkflowError::Validation(format!(
                        "required entries at {path} must be non-empty strings"
                    ))
                })?;
            if !unique.insert(field) {
                return Err(WorkflowError::Validation(format!(
                    "required at {path} contains duplicate fields"
                )));
            }
        }
    }
    if object
        .get("additionalProperties")
        .is_some_and(|value| !value.is_boolean())
    {
        return Err(WorkflowError::Validation(format!(
            "additionalProperties at {path} must be boolean"
        )));
    }
    validate_unsigned_bounds(object, "minLength", "maxLength", path)?;
    validate_unsigned_bounds(object, "minItems", "maxItems", path)?;
    validate_number_bounds(object, "minimum", "maximum", path)?;
    if let Some(properties) = object.get("properties") {
        let properties = properties.as_object().ok_or_else(|| {
            WorkflowError::Validation(format!("properties at {path} must be an object"))
        })?;
        for (name, child) in properties {
            validate_schema_node(
                child,
                depth + 1,
                &format!("{path}.properties.{name}"),
                nodes,
            )?;
        }
    }
    if let Some(items) = object.get("items") {
        validate_schema_node(items, depth + 1, &format!("{path}.items"), nodes)?;
    }
    Ok(())
}

fn validate_unsigned_bounds(
    object: &serde_json::Map<String, serde_json::Value>,
    minimum_key: &str,
    maximum_key: &str,
    path: &str,
) -> Result<(), WorkflowError> {
    let minimum = object
        .get(minimum_key)
        .map(|value| {
            value.as_u64().ok_or_else(|| {
                WorkflowError::Validation(format!("{minimum_key} at {path} must be unsigned"))
            })
        })
        .transpose()?;
    let maximum = object
        .get(maximum_key)
        .map(|value| {
            value.as_u64().ok_or_else(|| {
                WorkflowError::Validation(format!("{maximum_key} at {path} must be unsigned"))
            })
        })
        .transpose()?;
    if matches!((minimum, maximum), (Some(minimum), Some(maximum)) if minimum > maximum) {
        return Err(WorkflowError::Validation(format!(
            "{minimum_key} exceeds {maximum_key} at {path}"
        )));
    }
    Ok(())
}

fn validate_number_bounds(
    object: &serde_json::Map<String, serde_json::Value>,
    minimum_key: &str,
    maximum_key: &str,
    path: &str,
) -> Result<(), WorkflowError> {
    let minimum = object
        .get(minimum_key)
        .map(|value| {
            value.as_f64().ok_or_else(|| {
                WorkflowError::Validation(format!("{minimum_key} at {path} must be a number"))
            })
        })
        .transpose()?;
    let maximum = object
        .get(maximum_key)
        .map(|value| {
            value.as_f64().ok_or_else(|| {
                WorkflowError::Validation(format!("{maximum_key} at {path} must be a number"))
            })
        })
        .transpose()?;
    if matches!((minimum, maximum), (Some(minimum), Some(maximum)) if minimum > maximum) {
        return Err(WorkflowError::Validation(format!(
            "{minimum_key} exceeds {maximum_key} at {path}"
        )));
    }
    Ok(())
}

fn validate_policy(policy: &WorkflowPolicy) -> Result<(), WorkflowError> {
    if !(1..=64).contains(&policy.max_concurrent_agent_steps)
        || !(1..=10_000).contains(&policy.max_agent_calls)
        || !(1..=7 * 24 * 60 * 60).contains(&policy.deadline_seconds)
        || !(1_024..=64 * 1024 * 1024).contains(&policy.max_output_bytes)
    {
        return Err(WorkflowError::Validation(
            "workflow policy exceeds supported hard limits".to_string(),
        ));
    }
    Ok(())
}

fn valid_step_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn validate_pointer(pointer: &str) -> Result<(), WorkflowError> {
    if pointer.is_empty() || pointer.starts_with('/') {
        Ok(())
    } else {
        Err(WorkflowError::Validation(format!(
            "JSON pointer `{pointer}` must be empty or start with /"
        )))
    }
}

fn is_transitive_dependency(
    by_id: &BTreeMap<&str, &WorkflowStep>,
    target: &str,
    possible_dependency: &str,
) -> bool {
    let mut pending = by_id[target]
        .depends_on
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    let mut visited = BTreeSet::new();
    while let Some(id) = pending.pop() {
        if id == possible_dependency {
            return true;
        }
        if visited.insert(id) {
            pending.extend(by_id[id].depends_on.iter().map(String::as_str));
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(id: &str, dependencies: &[&str]) -> WorkflowStep {
        WorkflowStep {
            id: id.to_string(),
            depends_on: dependencies.iter().map(|value| value.to_string()).collect(),
            phase: None,
            input_bindings: BTreeMap::new(),
            spec: WorkflowStepSpec::Agent(AgentStepSpec {
                agent_id: "codex".to_string(),
                prompt: format!("run {id}"),
                output_schema: Some(serde_json::json!({"type": "object"})),
                workspace_access: WorkspaceAccess::ReadOnlyShared,
                side_effect_class: SideEffectClass::ReadOnly,
                allow_one_repair: false,
                allow_skip_on_review: false,
            }),
        }
    }

    fn definition(steps: Vec<WorkflowStep>) -> WorkflowDefinition {
        WorkflowDefinition {
            format_version: WORKFLOW_DEFINITION_VERSION,
            name: "test".to_string(),
            description: None,
            input_schema: Some(serde_json::json!({"type": "object"})),
            steps,
            policy: WorkflowPolicy::default(),
        }
    }

    #[test]
    fn rejects_cycles_unknown_dependencies_and_unsafe_schema_keywords() {
        let cycle = definition(vec![agent("a", &["b"]), agent("b", &["a"])]);
        assert!(
            validate_definition(&cycle)
                .unwrap_err()
                .to_string()
                .contains("cycle")
        );

        let unknown = definition(vec![agent("a", &["missing"])]);
        assert!(
            validate_definition(&unknown)
                .unwrap_err()
                .to_string()
                .contains("invalid dependency")
        );

        assert!(
            validate_json_schema(&serde_json::json!({"$ref": "https://example.test/schema"}))
                .unwrap_err()
                .to_string()
                .contains("unsupported schema keyword")
        );
    }

    #[test]
    fn deterministic_order_is_stable_for_parallel_roots() {
        let workflow = definition(vec![
            agent("finish", &["beta", "alpha"]),
            agent("beta", &[]),
            agent("alpha", &[]),
        ]);
        assert_eq!(
            deterministic_order(&workflow).unwrap(),
            vec!["alpha", "beta", "finish"]
        );
    }

    #[test]
    fn output_binding_requires_a_transitive_dependency() {
        let mut consumer = agent("consumer", &[]);
        consumer.input_bindings.insert(
            "value".to_string(),
            WorkflowBinding::StepOutput {
                step_id: "producer".to_string(),
                pointer: "/value".to_string(),
            },
        );
        let workflow = definition(vec![agent("producer", &[]), consumer]);
        assert!(
            validate_definition(&workflow)
                .unwrap_err()
                .to_string()
                .contains("without depending")
        );
    }

    #[test]
    fn rejects_oversized_definition_fields_and_wide_schema_bombs() {
        let mut oversized_prompt = definition(vec![agent("step", &[])]);
        let WorkflowStepSpec::Agent(agent) = &mut oversized_prompt.steps[0].spec else {
            unreachable!();
        };
        agent.prompt = "x".repeat(64 * 1024 + 1);
        assert!(
            validate_definition(&oversized_prompt)
                .unwrap_err()
                .to_string()
                .contains("prompt")
        );

        let properties = (0..10_001)
            .map(|index| {
                (
                    format!("field_{index}"),
                    serde_json::json!({"type": "string"}),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        assert!(
            validate_json_schema(&serde_json::json!({
                "type": "object",
                "properties": properties,
            }))
            .unwrap_err()
            .to_string()
            .contains("nodes")
        );
    }

    #[test]
    fn rejects_malformed_schema_constraint_types_and_ranges() {
        for schema in [
            serde_json::json!({"type": "string", "maxLength": "large"}),
            serde_json::json!({"type": "array", "minItems": 2, "maxItems": 1}),
            serde_json::json!({"type": "object", "required": [1]}),
            serde_json::json!({"type": "object", "additionalProperties": "no"}),
            serde_json::json!({"enum": []}),
        ] {
            assert!(validate_json_schema(&schema).is_err(), "accepted {schema}");
        }
    }
}
