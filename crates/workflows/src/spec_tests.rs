use std::collections::BTreeMap;

use crate::spec::*;

fn agent(id: &str, dependencies: &[&str]) -> WorkflowStep {
    WorkflowStep {
        id: id.to_string(),
        depends_on: dependencies.iter().map(|value| value.to_string()).collect(),
        phase: None,
        input_bindings: BTreeMap::new(),
        spec: WorkflowStepSpec::Agent(AgentStepSpec {
            agent_id: "codex".to_string(),
            prompt: format!("run {id}"),
            executor_profile_id: None,
            mode_override: None,
            config_overrides: BTreeMap::new(),
            output_language: None,
            output_description: None,
            output_schema: Some(serde_json::json!({"type": "object"})),
            workspace_access: WorkspaceAccess::ReadOnlyShared,
            side_effect_class: SideEffectClass::ReadOnly,
            allow_one_repair: false,
            allow_skip_on_review: false,
            completion_policy: CompletionPolicy::Automatic,
        }),
    }
}

fn definition(steps: Vec<WorkflowStep>) -> WorkflowDefinition {
    WorkflowDefinition {
        format_version: 1,
        name: "test".to_string(),
        description: None,
        input_schema: Some(serde_json::json!({"type": "object"})),
        steps,
        policy: WorkflowPolicy::default(),
    }
}

#[test]
fn agent_workspace_access_defaults_to_the_native_session_policy() {
    let step: WorkflowStep = serde_json::from_value(serde_json::json!({
        "id": "review",
        "kind": "agent",
        "agentId": "codex",
        "prompt": "Review"
    }))
    .unwrap();
    let WorkflowStepSpec::Agent(agent) = step.spec else {
        unreachable!()
    };
    assert_eq!(agent.workspace_access, WorkspaceAccess::Native);
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
fn agent_completion_policy_defaults_to_automatic_and_round_trips_manual() {
    let automatic: AgentStepSpec = serde_json::from_value(serde_json::json!({
        "agentId": "codex",
        "prompt": "inspect"
    }))
    .unwrap();
    assert_eq!(automatic.completion_policy, CompletionPolicy::Automatic);

    let manual: AgentStepSpec = serde_json::from_value(serde_json::json!({
        "agentId": "codex",
        "prompt": "inspect",
        "completionPolicy": "manual"
    }))
    .unwrap();
    assert_eq!(manual.completion_policy, CompletionPolicy::Manual);
    assert_eq!(
        serde_json::to_value(manual).unwrap()["completionPolicy"],
        "manual"
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
