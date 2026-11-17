use std::{collections::BTreeMap, str::FromStr};

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use uuid::Uuid;

use crate::{
    AgentStepSpec, ApprovalStepSpec, CompletionPolicy, DebugRunScope, SideEffectClass,
    WorkflowDefinition, WorkflowPolicy, WorkflowRunView, WorkflowStep, WorkflowStepSpec,
    WorkflowStore, WorkflowVersionView, WorkspaceAccess, service::*,
};

async fn setup() -> (WorkflowCore, WorkflowStore) {
    let options = SqliteConnectOptions::from_str("sqlite::memory:")
        .unwrap()
        .foreign_keys(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&pool)
        .await
        .unwrap();
    let store = WorkflowStore::new(pool);
    (WorkflowCore::new(store.clone()), store)
}

fn definition() -> WorkflowDefinition {
    let agent = |id: &str, depends_on: &[&str]| WorkflowStep {
        id: id.to_string(),
        depends_on: depends_on.iter().map(|value| value.to_string()).collect(),
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
            output_schema: None,
            workspace_access: WorkspaceAccess::ReadOnlyShared,
            side_effect_class: SideEffectClass::ReadOnly,
            allow_one_repair: false,
            allow_skip_on_review: false,
            completion_policy: CompletionPolicy::Automatic,
        }),
    };
    WorkflowDefinition {
        format_version: 1,
        name: "release".to_string(),
        description: None,
        input_schema: Some(serde_json::json!({
            "type": "object",
            "required": ["repo"],
            "properties": {"repo": {"type": "string"}},
            "additionalProperties": false
        })),
        steps: vec![
            agent("build", &[]),
            agent("test", &[]),
            WorkflowStep {
                id: "approve".to_string(),
                depends_on: vec!["build".to_string(), "test".to_string()],
                phase: None,
                input_bindings: BTreeMap::new(),
                spec: WorkflowStepSpec::Approval(ApprovalStepSpec {
                    title: "Ship?".to_string(),
                    decision_schema: serde_json::json!({
                        "type": "object",
                        "required": ["approved"],
                        "properties": {"approved": {"type": "boolean"}},
                        "additionalProperties": false
                    }),
                    approver_scope: "workflow.approve".to_string(),
                    skippable: false,
                }),
            },
            agent("ship", &["approve"]),
        ],
        policy: WorkflowPolicy::default(),
    }
}

async fn publish_and_start(core: &WorkflowCore) -> (WorkflowVersionView, WorkflowRunView) {
    let version = core
        .publish(PublishWorkflow {
            definition_id: None,
            definition: definition(),
            source_path: None,
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({"id": "owner"}),
        })
        .await
        .unwrap();
    let run = core
        .start(StartWorkflow {
            definition_version_id: version.id,
            workspace_id: Uuid::new_v4(),
            input: serde_json::json!({"repo": "vibex"}),
            policy_override: None,
            debug_step_id: None,
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({"id": "owner"}),
        })
        .await
        .unwrap();
    core.store.enable_dispatch(run.id).await.unwrap();
    (version, run)
}

#[tokio::test]
async fn source_path_is_the_reusable_definition_identity() {
    let (core, _) = setup().await;
    let source_path = "flows/repository-review.dimo-workflow.json";
    let first = core
        .publish(PublishWorkflow {
            definition_id: None,
            definition: definition(),
            source_path: Some(source_path.to_owned()),
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({"id": "owner"}),
        })
        .await
        .unwrap();
    let mut changed = definition();
    changed.description = Some("second revision".to_owned());
    let second = core
        .publish(PublishWorkflow {
            definition_id: None,
            definition: changed,
            source_path: Some(source_path.to_owned()),
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({"id": "owner"}),
        })
        .await
        .unwrap();

    assert_eq!(second.definition_id, first.definition_id);
    assert_eq!(second.version, first.version + 1);
}

#[tokio::test]
async fn debug_snapshot_stays_out_of_published_history_until_publish() {
    let (core, _) = setup().await;
    let source_path = "flows/debug-only.dimo-workflow.json";
    let debug = core
        .materialize_debug(PublishWorkflow {
            definition_id: None,
            definition: definition(),
            source_path: Some(source_path.to_owned()),
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({"id": "owner"}),
        })
        .await
        .unwrap();

    assert!(debug.version < 0);
    assert!(core.definitions(100).await.unwrap().is_empty());
    assert!(
        core.versions(debug.definition_id, 100)
            .await
            .unwrap()
            .is_empty()
    );

    let published = core
        .publish(PublishWorkflow {
            definition_id: None,
            definition: definition(),
            source_path: Some(source_path.to_owned()),
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({"id": "owner"}),
        })
        .await
        .unwrap();

    assert_eq!(published.id, debug.id);
    assert_eq!(published.version, 1);
    assert_eq!(core.definitions(100).await.unwrap().len(), 1);
    let versions = core.versions(debug.definition_id, 100).await.unwrap();
    assert_eq!(versions.len(), 1);
    assert_eq!(versions[0].id, published.id);
}

#[tokio::test]
async fn manual_agent_output_waits_for_acceptance_before_unlocking_downstream() {
    let (core, store) = setup().await;
    let mut workflow = definition();
    workflow.steps = vec![
        WorkflowStep {
            id: "draft".to_string(),
            depends_on: Vec::new(),
            phase: None,
            input_bindings: BTreeMap::new(),
            spec: WorkflowStepSpec::Agent(AgentStepSpec {
                agent_id: "codex".to_string(),
                prompt: "draft".to_string(),
                executor_profile_id: None,
                mode_override: None,
                config_overrides: BTreeMap::new(),
                output_language: None,
                output_description: None,
                output_schema: Some(serde_json::json!({
                    "type": "object",
                    "required": ["summary"],
                    "properties": {"summary": {"type": "string"}},
                    "additionalProperties": false
                })),
                workspace_access: WorkspaceAccess::ReadOnlyShared,
                side_effect_class: SideEffectClass::ReadOnly,
                allow_one_repair: false,
                allow_skip_on_review: false,
                completion_policy: CompletionPolicy::Manual,
            }),
        },
        WorkflowStep {
            id: "publish".to_string(),
            depends_on: vec!["draft".to_string()],
            phase: None,
            input_bindings: BTreeMap::new(),
            spec: WorkflowStepSpec::Agent(AgentStepSpec {
                agent_id: "codex".to_string(),
                prompt: "publish".to_string(),
                executor_profile_id: None,
                mode_override: None,
                config_overrides: BTreeMap::new(),
                output_language: None,
                output_description: None,
                output_schema: None,
                workspace_access: WorkspaceAccess::ReadOnlyShared,
                side_effect_class: SideEffectClass::ReadOnly,
                allow_one_repair: false,
                allow_skip_on_review: false,
                completion_policy: CompletionPolicy::Automatic,
            }),
        },
    ];
    let version = core
        .publish(PublishWorkflow {
            definition_id: None,
            definition: workflow,
            source_path: None,
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({"id": "owner"}),
        })
        .await
        .unwrap();
    let run = core
        .start(StartWorkflow {
            definition_version_id: version.id,
            workspace_id: Uuid::new_v4(),
            input: serde_json::json!({"repo": "vibex"}),
            policy_override: None,
            debug_step_id: None,
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({"id": "owner"}),
        })
        .await
        .unwrap();
    store.enable_dispatch(run.id).await.unwrap();
    let claim = store
        .claim_ready(1, chrono::Duration::seconds(30))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claim.step.step_id, "draft");
    store
        .mark_started(run.id, "draft", claim.claim_token, None, None)
        .await
        .unwrap();

    let waiting = core
        .stage_step_candidate(StageWorkflowStepCandidate {
            run_id: run.id,
            step_id: "draft".to_string(),
            output: Some(serde_json::json!({
                "summary": "structured candidate ready for review"
            })),
        })
        .await
        .unwrap();
    assert_eq!(waiting.status, "waiting");
    let steps = store.steps(run.id).await.unwrap();
    assert!(
        steps
            .iter()
            .find(|step| step.step_id == "draft")
            .unwrap()
            .awaiting_acceptance
    );
    assert_eq!(
        steps
            .iter()
            .find(|step| step.step_id == "publish")
            .unwrap()
            .status,
        "pending"
    );

    core.accept_step_candidate(AcceptWorkflowStepCandidate {
        run_id: run.id,
        step_id: "draft".to_string(),
        operation_id: Uuid::new_v4(),
        principal: serde_json::json!({"id": "owner"}),
    })
    .await
    .unwrap();
    let steps = store.steps(run.id).await.unwrap();
    let draft = steps.iter().find(|step| step.step_id == "draft").unwrap();
    assert_eq!(draft.status, "completed");
    assert_eq!(
        draft.output_json.as_deref(),
        Some("{\"summary\":\"structured candidate ready for review\"}")
    );
    assert_eq!(
        steps
            .iter()
            .find(|step| step.step_id == "publish")
            .unwrap()
            .status,
        "ready"
    );
}

#[tokio::test]
async fn an_intervened_automatic_step_can_stage_a_candidate_for_confirmation() {
    let (core, store) = setup().await;
    let (_, run) = publish_and_start(&core).await;
    let claim = store
        .claim_ready(1, chrono::Duration::seconds(30))
        .await
        .unwrap()
        .unwrap();
    store
        .mark_started(run.id, &claim.step.step_id, claim.claim_token, None, None)
        .await
        .unwrap();

    let waiting = core
        .stage_step_candidate(StageWorkflowStepCandidate {
            run_id: run.id,
            step_id: claim.step.step_id.clone(),
            output: Some(serde_json::Value::String("reviewed result".to_owned())),
        })
        .await
        .unwrap();

    assert_eq!(waiting.status, "waiting");
    let step = store
        .steps(run.id)
        .await
        .unwrap()
        .into_iter()
        .find(|step| step.step_id == claim.step.step_id)
        .unwrap();
    assert!(step.awaiting_acceptance);
    assert_eq!(
        step.candidate_output_json.as_deref(),
        Some("\"reviewed result\"")
    );
}

#[tokio::test]
async fn paused_run_stops_claims_and_resumes_without_losing_ready_steps() {
    let (core, store) = setup().await;
    let (_, run) = publish_and_start(&core).await;

    let pausing = core
        .request_pause(PauseWorkflowRun {
            run_id: run.id,
            reason: Some("inspect build output".to_string()),
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({"id": "owner"}),
        })
        .await
        .unwrap();
    assert_eq!(pausing.control_state, "pausing");
    assert!(
        store
            .claim_ready(4, chrono::Duration::seconds(30))
            .await
            .unwrap()
            .is_none()
    );

    let paused = core.mark_paused(run.id).await.unwrap();
    assert_eq!(paused.control_state, "paused");
    core.resume_paused(ResumePausedWorkflowRun {
        run_id: run.id,
        operation_id: Uuid::new_v4(),
        principal: serde_json::json!({"id": "owner"}),
    })
    .await
    .unwrap();
    assert!(
        store
            .claim_ready(4, chrono::Duration::seconds(30))
            .await
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn initial_node_debug_executes_ancestors_and_excludes_the_rest() {
    let (core, store) = setup().await;
    let mut scoped = definition();
    scoped.steps = vec![
        {
            let mut step = definition().steps.remove(0);
            step.id = "a".to_string();
            step.depends_on.clear();
            step
        },
        {
            let mut step = definition().steps.remove(0);
            step.id = "b".to_string();
            step.depends_on = vec!["a".to_string()];
            step
        },
        {
            let mut step = definition().steps.remove(0);
            step.id = "c".to_string();
            step.depends_on = vec!["b".to_string()];
            step
        },
        {
            let mut step = definition().steps.remove(0);
            step.id = "unrelated".to_string();
            step.depends_on.clear();
            step
        },
    ];
    let version = core
        .publish(PublishWorkflow {
            definition_id: None,
            definition: scoped,
            source_path: None,
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({"id": "owner"}),
        })
        .await
        .unwrap();
    let run = core
        .start(StartWorkflow {
            definition_version_id: version.id,
            workspace_id: Uuid::new_v4(),
            input: serde_json::json!({}),
            policy_override: None,
            debug_step_id: Some("b".to_string()),
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({"id": "owner"}),
        })
        .await
        .unwrap();
    let steps = store.steps(run.id).await.unwrap();
    let status = |step_id: &str| {
        steps
            .iter()
            .find(|step| step.step_id == step_id)
            .unwrap()
            .status
            .as_str()
    };
    assert_eq!(status("a"), "ready");
    assert_eq!(status("b"), "pending");
    assert_eq!(status("c"), "skipped");
    assert_eq!(status("unrelated"), "skipped");
    assert_eq!(run.run_mode, "debug_node");
    assert_eq!(run.fork_step_id.as_deref(), Some("b"));
    assert!(run.parent_run_id.is_none());
}

#[tokio::test]
async fn fork_from_step_reuses_unchanged_ancestors_and_resets_transitive_downstream() {
    let (core, store) = setup().await;
    let mut original = definition();
    original.steps = vec![
        {
            let mut step = definition().steps.remove(0);
            step.id = "a".to_string();
            step.depends_on.clear();
            step
        },
        {
            let mut step = definition().steps.remove(0);
            step.id = "b".to_string();
            step.depends_on = vec!["a".to_string()];
            step
        },
        {
            let mut step = definition().steps.remove(0);
            step.id = "c".to_string();
            step.depends_on = vec!["b".to_string()];
            step
        },
    ];
    let original_version = core
        .publish(PublishWorkflow {
            definition_id: None,
            definition: original.clone(),
            source_path: None,
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({"id": "owner"}),
        })
        .await
        .unwrap();
    let parent = core
        .start(StartWorkflow {
            definition_version_id: original_version.id,
            workspace_id: Uuid::new_v4(),
            input: serde_json::json!({"repo": "vibex"}),
            policy_override: None,
            debug_step_id: None,
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({"id": "owner"}),
        })
        .await
        .unwrap();
    store.enable_dispatch(parent.id).await.unwrap();
    let claim = store
        .claim_ready(1, chrono::Duration::seconds(30))
        .await
        .unwrap()
        .unwrap();
    let original_definition = original_version.definition().unwrap();
    let original_a = original_definition
        .steps
        .iter()
        .find(|step| step.id == "a")
        .unwrap();
    let resolved = store
        .resolve_step_input(parent.id, original_a)
        .await
        .unwrap();
    store
        .prepare_step(
            parent.id,
            original_a,
            claim.claim_token,
            &resolved,
            parent.workspace_id,
            &serde_json::json!({
                "isolated": false,
                "workspaceId": parent.workspace_id,
                "policy": "write_serialized",
            }),
        )
        .await
        .unwrap();
    store
        .mark_started(parent.id, "a", claim.claim_token, None, None)
        .await
        .unwrap();
    core.complete_step(CompleteWorkflowStep {
        run_id: parent.id,
        step_id: "a".to_string(),
        output: None,
    })
    .await
    .unwrap();

    let mut edited = original;
    let WorkflowStepSpec::Agent(agent) = &mut edited
        .steps
        .iter_mut()
        .find(|step| step.id == "b")
        .unwrap()
        .spec
    else {
        unreachable!()
    };
    agent.prompt = "improved b".to_string();
    let edited_version = core
        .publish(PublishWorkflow {
            definition_id: Some(original_version.definition_id),
            definition: edited,
            source_path: None,
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({"id": "owner"}),
        })
        .await
        .unwrap();
    let derived = core
        .fork_from_step(ForkWorkflowRun {
            parent_run_id: parent.id,
            definition_version_id: edited_version.id,
            step_id: "b".to_string(),
            scope: DebugRunScope::Downstream,
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({"id": "owner"}),
        })
        .await
        .unwrap();
    assert_eq!(derived.parent_run_id, Some(parent.id));
    assert_eq!(derived.fork_step_id.as_deref(), Some("b"));
    let steps = store.steps(derived.id).await.unwrap();
    let a = steps.iter().find(|step| step.step_id == "a").unwrap();
    let b = steps.iter().find(|step| step.step_id == "b").unwrap();
    let c = steps.iter().find(|step| step.step_id == "c").unwrap();
    assert_eq!(
        (a.status.as_str(), a.execution_mode.as_str()),
        ("completed", "reuse")
    );
    let reused_evidence =
        serde_json::from_str::<serde_json::Value>(a.execution_evidence_json.as_deref().unwrap())
            .unwrap();
    assert_eq!(reused_evidence["definitionDigest"], edited_version.digest);
    assert_eq!(
        reused_evidence["reusedFromDefinitionDigest"],
        original_version.digest
    );
    assert_eq!(store.reconcile_completed_evidence().await.unwrap(), 0);
    assert_eq!(
        (b.status.as_str(), b.execution_mode.as_str()),
        ("ready", "execute")
    );
    assert_eq!(
        (c.status.as_str(), c.execution_mode.as_str()),
        ("pending", "execute")
    );

    let reused_before = a.clone();
    store.rebuild_run_projection(derived.id).await.unwrap();
    let rebuilt = store.steps(derived.id).await.unwrap();
    let reused_after = rebuilt.iter().find(|step| step.step_id == "a").unwrap();
    assert_eq!(reused_after.status, reused_before.status);
    assert_eq!(reused_after.execution_mode, "reuse");
    assert_eq!(reused_after.output_json, reused_before.output_json);
    assert_eq!(
        reused_after.output_schema_digest,
        reused_before.output_schema_digest
    );
    assert_eq!(reused_after.conversation_id, reused_before.conversation_id);
    assert_eq!(reused_after.completed_at, reused_before.completed_at);
}

#[tokio::test]
async fn publish_and_start_are_idempotent_and_payload_bound() {
    let (core, _) = setup().await;
    let publish_operation = Uuid::new_v4();
    let request = PublishWorkflow {
        definition_id: None,
        definition: definition(),
        source_path: None,
        operation_id: publish_operation,
        principal: serde_json::json!({"id": "owner"}),
    };
    let first = core.publish(request.clone()).await.unwrap();
    let retry = core.publish(request).await.unwrap();
    assert_eq!(first.id, retry.id);

    let operation = Uuid::new_v4();
    let start = StartWorkflow {
        definition_version_id: first.id,
        workspace_id: Uuid::new_v4(),
        input: serde_json::json!({"repo": "vibex"}),
        policy_override: None,
        debug_step_id: None,
        operation_id: operation,
        principal: serde_json::json!({"id": "owner"}),
    };
    let workspace_id = start.workspace_id;
    let run = core.start(start.clone()).await.unwrap();
    assert_eq!(core.start(start).await.unwrap().id, run.id);
    let conflict = core
        .start(StartWorkflow {
            input: serde_json::json!({"repo": "other"}),
            operation_id: operation,
            definition_version_id: first.id,
            workspace_id,
            policy_override: None,
            debug_step_id: None,
            principal: serde_json::json!({"id": "owner"}),
        })
        .await
        .unwrap_err();
    assert!(matches!(conflict, WorkflowError::Conflict(_)));
}

#[tokio::test]
async fn run_input_and_approval_output_obey_persisted_byte_limits() {
    let (core, _) = setup().await;
    let mut approval_definition = definition();
    approval_definition.steps = vec![WorkflowStep {
        id: "approve".to_string(),
        depends_on: Vec::new(),
        phase: None,
        input_bindings: BTreeMap::new(),
        spec: WorkflowStepSpec::Approval(ApprovalStepSpec {
            title: "Approve".to_string(),
            decision_schema: serde_json::json!({
                "type": "object",
                "required": ["note"],
                "properties": {
                    "note": {"type": "string", "maxLength": 4096}
                },
                "additionalProperties": false
            }),
            approver_scope: "workflow.approve".to_string(),
            skippable: false,
        }),
    }];
    approval_definition.policy.max_output_bytes = 1024;
    let version = core
        .publish(PublishWorkflow {
            definition_id: None,
            definition: approval_definition,
            source_path: None,
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({"id": "owner"}),
        })
        .await
        .unwrap();
    let run = core
        .start(StartWorkflow {
            definition_version_id: version.id,
            workspace_id: Uuid::new_v4(),
            input: serde_json::json!({"repo": "vibex"}),
            policy_override: None,
            debug_step_id: None,
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({"id": "owner"}),
        })
        .await
        .unwrap();

    let oversized_decision = core
        .decide(DecideApproval {
            run_id: run.id,
            step_id: "approve".to_string(),
            decision: serde_json::json!({"note": "x".repeat(1025)}),
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({
                "id": "human",
                "scopes": ["workflow.approve"]
            }),
        })
        .await
        .unwrap_err();
    assert!(
        oversized_decision
            .to_string()
            .contains("exceeds 1024 bytes")
    );

    let oversized_input = core
        .start(StartWorkflow {
            definition_version_id: version.id,
            workspace_id: Uuid::new_v4(),
            input: serde_json::json!({"repo": "x".repeat(4 * 1024 * 1024)}),
            policy_override: None,
            debug_step_id: None,
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({"id": "owner"}),
        })
        .await
        .unwrap_err();
    assert!(oversized_input.to_string().contains("input exceeds"));
}

#[tokio::test]
async fn child_interaction_waiting_is_a_summary_projection_and_does_not_block_other_ready_steps() {
    let (core, store) = setup().await;
    let mut isolated = definition();
    for step in &mut isolated.steps {
        if let WorkflowStepSpec::Agent(agent) = &mut step.spec {
            agent.workspace_access = WorkspaceAccess::WriteIsolated;
            agent.side_effect_class = SideEffectClass::MutatingUnknown;
        }
    }
    let version = core
        .publish(PublishWorkflow {
            definition_id: None,
            definition: isolated,
            source_path: None,
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({"id": "owner"}),
        })
        .await
        .unwrap();
    let run = core
        .start(StartWorkflow {
            definition_version_id: version.id,
            workspace_id: Uuid::new_v4(),
            input: serde_json::json!({"repo": "vibex"}),
            policy_override: None,
            debug_step_id: None,
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({"id": "owner"}),
        })
        .await
        .unwrap();
    store.enable_dispatch(run.id).await.unwrap();
    let first = store
        .claim_ready(4, chrono::Duration::seconds(30))
        .await
        .unwrap()
        .unwrap();
    let conversation_id = Uuid::new_v4();
    let turn_id = Uuid::new_v4();
    store
        .mark_started(
            run.id,
            &first.step.step_id,
            first.claim_token,
            Some(conversation_id),
            Some(turn_id),
        )
        .await
        .unwrap();

    assert!(
        store
            .set_interaction_waiting(run.id, &first.step.step_id, true)
            .await
            .unwrap()
    );
    assert_eq!(store.run(run.id).await.unwrap().status, "waiting");
    let waiting = store
        .steps(run.id)
        .await
        .unwrap()
        .into_iter()
        .find(|step| step.step_id == first.step.step_id)
        .unwrap();
    assert!(waiting.waiting_interaction);

    let parallel = store
        .claim_ready(4, chrono::Duration::seconds(30))
        .await
        .unwrap()
        .expect("a different ready root remains dispatchable");
    assert_ne!(parallel.step.step_id, first.step.step_id);

    assert!(
        store
            .set_interaction_waiting(run.id, &first.step.step_id, false)
            .await
            .unwrap()
    );
    assert_eq!(store.run(run.id).await.unwrap().status, "running");
    store.rebuild_run_projection(run.id).await.unwrap();
    assert_eq!(store.run(run.id).await.unwrap().status, "running");
    let rebuilt = store
        .steps(run.id)
        .await
        .unwrap()
        .into_iter()
        .find(|step| step.step_id == first.step.step_id)
        .unwrap();
    assert!(!rebuilt.waiting_interaction);
}

#[tokio::test]
async fn completed_step_with_matching_identity_survives_unknown_optional_evidence() {
    let (core, store) = setup().await;
    let (_, run) = publish_and_start(&core).await;
    let claim = store
        .claim_ready(1, chrono::Duration::seconds(30))
        .await
        .unwrap()
        .unwrap();
    let definition_step = claim
        .definition
        .steps
        .iter()
        .find(|step| step.id == claim.step.step_id)
        .unwrap();
    let resolved = store
        .resolve_step_input(run.id, definition_step)
        .await
        .unwrap();
    store
        .prepare_step(
            run.id,
            definition_step,
            claim.claim_token,
            &resolved,
            run.workspace_id,
            &serde_json::json!({
                "isolated": false,
                "workspaceId": run.workspace_id,
            }),
        )
        .await
        .unwrap();
    store
        .mark_started(run.id, &claim.step.step_id, claim.claim_token, None, None)
        .await
        .unwrap();
    core.complete_step(CompleteWorkflowStep {
        run_id: run.id,
        step_id: claim.step.step_id.clone(),
        output: None,
    })
    .await
    .unwrap();

    assert_eq!(store.reconcile_completed_evidence().await.unwrap(), 0);
    assert_eq!(store.run(run.id).await.unwrap().status, "running");
}

#[tokio::test]
async fn completed_approval_or_notify_step_and_staged_manual_candidate_survive_startup_reconciliation()
 {
    let (core, store) = setup().await;
    let mut def = definition();
    if let Some(ship) = def.steps.iter_mut().find(|step| step.id == "ship")
        && let WorkflowStepSpec::Agent(agent) = &mut ship.spec
    {
        agent.completion_policy = CompletionPolicy::Manual;
    }
    let version = core
        .publish(PublishWorkflow {
            definition_id: None,
            definition: def,
            source_path: None,
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({"id": "owner"}),
        })
        .await
        .unwrap();
    let run = core
        .start(StartWorkflow {
            definition_version_id: version.id,
            workspace_id: Uuid::new_v4(),
            input: serde_json::json!({"repo": "vibex"}),
            policy_override: None,
            debug_step_id: None,
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({"id": "owner"}),
        })
        .await
        .unwrap();
    store.enable_dispatch(run.id).await.unwrap();

    for expected in ["build", "test"] {
        let claim = store
            .claim_ready(4, chrono::Duration::seconds(30))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(claim.step.step_id, expected);
        let definition_step = claim
            .definition
            .steps
            .iter()
            .find(|step| step.id == expected)
            .unwrap();
        let resolved = store
            .resolve_step_input(run.id, definition_step)
            .await
            .unwrap();
        store
            .prepare_step(
                run.id,
                definition_step,
                claim.claim_token,
                &resolved,
                run.workspace_id,
                &serde_json::json!({
                    "isolated": false,
                    "workspaceId": run.workspace_id,
                }),
            )
            .await
            .unwrap();
        store
            .mark_started(run.id, expected, claim.claim_token, None, None)
            .await
            .unwrap();
        core.complete_step(CompleteWorkflowStep {
            run_id: run.id,
            step_id: expected.to_string(),
            output: None,
        })
        .await
        .unwrap();
    }

    core.decide(DecideApproval {
        run_id: run.id,
        step_id: "approve".to_string(),
        decision: serde_json::json!({"approved": true}),
        operation_id: Uuid::new_v4(),
        principal: serde_json::json!({"id": "human", "scopes": ["workflow.approve"]}),
    })
    .await
    .unwrap();

    let ship_claim = store
        .claim_ready(4, chrono::Duration::seconds(30))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(ship_claim.step.step_id, "ship");
    let ship_def = ship_claim
        .definition
        .steps
        .iter()
        .find(|step| step.id == "ship")
        .unwrap();
    let ship_resolved = store.resolve_step_input(run.id, ship_def).await.unwrap();
    store
        .prepare_step(
            run.id,
            ship_def,
            ship_claim.claim_token,
            &ship_resolved,
            run.workspace_id,
            &serde_json::json!({
                "isolated": false,
                "workspaceId": run.workspace_id,
            }),
        )
        .await
        .unwrap();
    store
        .mark_started(run.id, "ship", ship_claim.claim_token, None, None)
        .await
        .unwrap();
    core.stage_step_candidate(StageWorkflowStepCandidate {
        run_id: run.id,
        step_id: "ship".to_string(),
        output: Some(serde_json::Value::String("ship ready".to_string())),
    })
    .await
    .unwrap();

    assert_eq!(store.reconcile_interrupted().await.unwrap(), 0);
    assert_eq!(store.reconcile_completed_evidence().await.unwrap(), 0);
    assert_eq!(store.run(run.id).await.unwrap().status, "waiting");
    let steps = store.steps(run.id).await.unwrap();
    let approve_step = steps.iter().find(|s| s.step_id == "approve").unwrap();
    assert_eq!(approve_step.status, "completed");
    let ship_step = steps.iter().find(|s| s.step_id == "ship").unwrap();
    assert_eq!(ship_step.status, "running");
    assert!(ship_step.awaiting_acceptance);
}

#[tokio::test]
async fn delete_definition_and_rename_persists_cleanly() {
    let (core, store) = setup().await;
    let (version, run) = publish_and_start(&core).await;

    let initial_defs = store.definitions(10).await.unwrap();
    assert_eq!(initial_defs.len(), 1);
    assert_eq!(initial_defs[0].name, "release");
    assert!(
        initial_defs[0]
            .latest_normalized_json
            .as_deref()
            .unwrap_or("")
            .contains("\"build\"")
    );

    let mut renamed = definition();
    renamed.name = "release-v2".to_string();
    core.publish(PublishWorkflow {
        definition_id: Some(version.definition_id),
        definition: renamed,
        source_path: None,
        operation_id: Uuid::new_v4(),
        principal: serde_json::json!({"id": "owner"}),
    })
    .await
    .unwrap();

    let updated_defs = store.definitions(10).await.unwrap();
    assert_eq!(updated_defs.len(), 1);
    assert_eq!(updated_defs[0].name, "release-v2");

    core.delete_definition(version.definition_id).await.unwrap();
    assert!(store.definitions(10).await.unwrap().is_empty());
    assert!(store.run(run.id).await.is_err());
}

#[tokio::test]
async fn complete_step_strictly_validates_output_schema_unless_output_description_overrides() {
    let (core, store) = setup().await;
    let mut def = definition();
    def.steps = vec![
        WorkflowStep {
            id: "strict".to_string(),
            depends_on: Vec::new(),
            phase: None,
            input_bindings: BTreeMap::new(),
            spec: WorkflowStepSpec::Session(crate::SessionStepSpec {
                agent_id: "codex".to_string(),
                prompt_template: "diagnose".to_string(),
                workspace_access: WorkspaceAccess::ReadOnlyShared,
                model_override: None,
                subscribe_thread: false,
                completion: CompletionPolicy::Automatic,
                output_schema: Some(serde_json::json!({
                    "type": "object",
                    "required": ["summary", "fixed"],
                    "additionalProperties": false,
                    "properties": {
                        "summary": { "type": "string" },
                        "fixed": { "type": "boolean" }
                    }
                })),
            }),
        },
        WorkflowStep {
            id: "prose".to_string(),
            depends_on: Vec::new(),
            phase: None,
            input_bindings: BTreeMap::new(),
            spec: WorkflowStepSpec::Agent(AgentStepSpec {
                agent_id: "codex".to_string(),
                prompt: "summarize".to_string(),
                executor_profile_id: None,
                mode_override: None,
                config_overrides: BTreeMap::new(),
                output_language: None,
                output_description: Some("A short prose summary".to_string()),
                output_schema: Some(serde_json::json!({
                    "type": "object",
                    "required": ["summary"],
                    "properties": {"summary": {"type": "string"}}
                })),
                workspace_access: WorkspaceAccess::ReadOnlyShared,
                side_effect_class: SideEffectClass::ReadOnly,
                allow_one_repair: false,
                allow_skip_on_review: false,
                completion_policy: CompletionPolicy::Automatic,
            }),
        },
    ];
    let version = core
        .publish(PublishWorkflow {
            definition_id: None,
            definition: def,
            source_path: None,
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({"id": "owner"}),
        })
        .await
        .unwrap();
    let run = core
        .start(StartWorkflow {
            definition_version_id: version.id,
            workspace_id: Uuid::new_v4(),
            input: serde_json::json!({"repo": "acme/dimo"}),
            policy_override: None,
            debug_step_id: None,
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({"id": "owner"}),
        })
        .await
        .unwrap();
    store.enable_dispatch(run.id).await.unwrap();

    let claim_prose = store
        .claim_ready(4, chrono::Duration::seconds(30))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claim_prose.step.step_id, "prose");
    store
        .mark_started(
            run.id,
            &claim_prose.step.step_id,
            claim_prose.claim_token,
            None,
            None,
        )
        .await
        .unwrap();

    core.complete_step(CompleteWorkflowStep {
        run_id: run.id,
        step_id: "prose".to_string(),
        output: Some(serde_json::Value::String(
            "Natural language prose".to_string(),
        )),
    })
    .await
    .unwrap();

    let claim_strict = store
        .claim_ready(4, chrono::Duration::seconds(30))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claim_strict.step.step_id, "strict");
    store
        .mark_started(
            run.id,
            &claim_strict.step.step_id,
            claim_strict.claim_token,
            None,
            None,
        )
        .await
        .unwrap();

    let err = core
        .complete_step(CompleteWorkflowStep {
            run_id: run.id,
            step_id: "strict".to_string(),
            output: Some(serde_json::json!({ "unexpected": 123 })),
        })
        .await
        .unwrap_err();
    let msg = err.to_string();
    assert!(msg.contains("`summary`"), "{msg}");
    assert!(msg.contains("`fixed`"), "{msg}");
    assert!(msg.contains("`unexpected`"), "{msg}");

    core.complete_step(CompleteWorkflowStep {
        run_id: run.id,
        step_id: "strict".to_string(),
        output: Some(serde_json::json!({ "summary": "ok", "fixed": true })),
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn notify_dependency_resolves_and_user_gate_renders_steps_output_template() {
    let (core, store) = setup().await;
    let mut def = definition();
    def.steps = vec![
        WorkflowStep {
            id: "intake-trigger".to_string(),
            depends_on: Vec::new(),
            phase: None,
            input_bindings: BTreeMap::new(),
            spec: WorkflowStepSpec::Notify(crate::NotifyStepSpec {
                title: "CI Failed".to_string(),
            }),
        },
        WorkflowStep {
            id: "diagnose".to_string(),
            depends_on: vec!["intake-trigger".to_string()],
            phase: None,
            input_bindings: BTreeMap::new(),
            spec: WorkflowStepSpec::Session(crate::SessionStepSpec {
                agent_id: "codex".to_string(),
                prompt_template: "Fix".to_string(),
                workspace_access: WorkspaceAccess::ReadOnlyShared,
                model_override: None,
                subscribe_thread: false,
                completion: CompletionPolicy::Automatic,
                output_schema: Some(serde_json::json!({
                    "type": "object",
                    "required": ["summary"],
                    "properties": { "summary": { "type": "string" } }
                })),
            }),
        },
        WorkflowStep {
            id: "notify-owner".to_string(),
            depends_on: vec!["diagnose".to_string()],
            phase: None,
            input_bindings: BTreeMap::new(),
            spec: WorkflowStepSpec::UserGate(crate::UserGateStepSpec {
                interaction_kind: crate::UserInteractionKind::Notify,
                title_template: "Result".to_string(),
                body_template: "Summary: {{steps.diagnose.output.summary}}".to_string(),
                approval_options: Vec::new(),
                form_schema: None,
                sla_timeout_seconds: None,
            }),
        },
    ];

    let version = core
        .publish(PublishWorkflow {
            definition_id: None,
            definition: def,
            source_path: None,
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({"id": "owner"}),
        })
        .await
        .unwrap();
    let run = core
        .start(StartWorkflow {
            definition_version_id: version.id,
            workspace_id: Uuid::new_v4(),
            input: serde_json::json!({"repo": "acme/dimo"}),
            policy_override: None,
            debug_step_id: None,
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({"id": "owner"}),
        })
        .await
        .unwrap();
    store.enable_dispatch(run.id).await.unwrap();

    let claim = store
        .claim_ready(1, chrono::Duration::seconds(30))
        .await
        .unwrap()
        .expect("diagnose must become ready after notify dependency");
    assert_eq!(claim.step.step_id, "diagnose");
    let def = version.definition().unwrap();
    let diagnose_step = def.steps.iter().find(|s| s.id == "diagnose").unwrap();
    let resolved = store
        .resolve_step_input(run.id, diagnose_step)
        .await
        .unwrap();
    assert_eq!(
        resolved.values["intake-trigger"],
        serde_json::json!({"notified": true})
    );

    store
        .mark_started(run.id, "diagnose", claim.claim_token, None, None)
        .await
        .unwrap();
    core.complete_step(CompleteWorkflowStep {
        run_id: run.id,
        step_id: "diagnose".to_string(),
        output: Some(serde_json::json!({ "summary": "Patched flaky test" })),
    })
    .await
    .unwrap();

    let body: String = sqlx::query_scalar(
        "SELECT body FROM pulse_user_interactions WHERE workflow_run_id = ? AND step_id = 'notify-owner'",
    )
    .bind(run.id.to_string())
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(body, "Summary: Patched flaky test");
}
