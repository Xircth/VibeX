use std::{collections::BTreeMap, str::FromStr};

use chrono::{Duration, Utc};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use uuid::Uuid;

use crate::*;

async fn setup_pulse_core() -> (WorkflowCore, WorkflowStore) {
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

async fn publish_and_enable(
    core: &WorkflowCore,
    store: &WorkflowStore,
    definition: WorkflowDefinition,
    input: serde_json::Value,
) -> (WorkflowVersionView, WorkflowRunView) {
    let version = core
        .publish(PublishWorkflow {
            definition_id: None,
            definition,
            source_path: None,
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({"id": "pulse-engine"}),
        })
        .await
        .unwrap();
    let run = core
        .start(StartWorkflow {
            definition_version_id: version.id,
            workspace_id: Uuid::new_v4(),
            input,
            policy_override: None,
            debug_step_id: None,
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({"id": "pulse-engine"}),
        })
        .await
        .unwrap();
    store.enable_dispatch(run.id).await.unwrap();
    (version, run)
}

async fn drive_claimed_step_to_completion(
    core: &WorkflowCore,
    store: &WorkflowStore,
    claim: &ClaimedWorkflowStep,
    output: serde_json::Value,
) -> WorkflowRunView {
    let definition_step = claim
        .definition
        .steps
        .iter()
        .find(|s| s.id == claim.step.step_id)
        .expect("claimed step exists in definition");
    let resolved = store
        .resolve_step_input(claim.run.id, definition_step)
        .await
        .unwrap();
    let prepared = store
        .prepare_step(
            claim.run.id,
            definition_step,
            claim.claim_token,
            &resolved,
            claim.run.workspace_id,
            &serde_json::json!({}),
        )
        .await
        .unwrap();
    assert!(prepared.execution_evidence_json.is_some());
    store
        .mark_started(
            claim.run.id,
            &claim.step.step_id,
            claim.claim_token,
            Some(Uuid::new_v4()),
            Some(Uuid::new_v4()),
        )
        .await
        .unwrap();
    core.complete_step(CompleteWorkflowStep {
        run_id: claim.run.id,
        step_id: claim.step.step_id.clone(),
        output: Some(output),
    })
    .await
    .unwrap()
}

fn sample_envelope(
    id: &str,
    event_type: &str,
    thread_key: Option<&str>,
    is_self: bool,
    is_bot: bool,
) -> EventEnvelope {
    EventEnvelope {
        event_id: id.to_string(),
        delivery_id: format!("deliv-{id}"),
        source: EventSourceMeta {
            kind: EventSourceKind::Feishu,
            instance_id: "feishu-main".to_string(),
            trust_level: EventTrustLevel::VerifiedExternal,
        },
        event_type: event_type.to_string(),
        occurred_at: Utc::now().to_rfc3339(),
        actor: EventActor {
            id: if is_self {
                "vibex-self".to_string()
            } else {
                "U12345".to_string()
            },
            display_name: Some("Tester".to_string()),
            roles: Vec::new(),
            is_bot,
            is_self,
        },
        thread_key: thread_key.map(str::to_string),
        correlations: Vec::new(),
        reply_channels: vec![ReplyChannelAddress {
            source_kind: EventSourceKind::Feishu,
            instance_id: "feishu-main".to_string(),
            channel_id: "C1".to_string(),
            message_id: None,
            thread_id: thread_key.map(str::to_string),
        }],
        trace: EventTrace {
            root_event_id: id.to_string(),
            parent_run_id: None,
            hop_count: 0,
        },
        payload: serde_json::json!({
            "text": "Here are the reproduction logs",
            "approved": true
        }),
    }
}

#[test]
fn all_eight_pulse_step_specs_round_trip_serde_cleanly() {
    let steps = vec![
        WorkflowStep {
            id: "s_session".to_string(),
            depends_on: Vec::new(),
            phase: Some("triage".to_string()),
            input_bindings: BTreeMap::new(),
            spec: WorkflowStepSpec::Session(SessionStepSpec {
                agent_id: "codex".to_string(),
                prompt_template: "Inspect {{input}}".to_string(),
                workspace_access: WorkspaceAccess::WriteIsolated,
                model_override: Some("gpt-5".to_string()),
                subscribe_thread: true,
                completion: CompletionPolicy::Automatic,
                output_schema: Some(serde_json::json!({"type": "object"})),
            }),
        },
        WorkflowStep {
            id: "s_bot".to_string(),
            depends_on: vec!["s_session".to_string()],
            phase: None,
            input_bindings: BTreeMap::new(),
            spec: WorkflowStepSpec::Bot(BotStepSpec {
                member_id: "bot-sentry".to_string(),
                conversation_scope: BotConversationScope::PerThreadTopic,
                mailbox_policy: BotMailboxPolicy::FifoSerial,
                prompt_template: "Update thread memory".to_string(),
                completion: CompletionPolicy::Automatic,
                output_schema: None,
            }),
        },
        WorkflowStep {
            id: "s_group".to_string(),
            depends_on: vec!["s_bot".to_string()],
            phase: None,
            input_bindings: BTreeMap::new(),
            spec: WorkflowStepSpec::GroupStage(GroupStageStepSpec {
                space_id: "eng-room".to_string(),
                dispatch_mode: GroupDispatchMode::MentionSeats {
                    member_id_list: vec!["alice".to_string(), "bob".to_string()],
                    order: GroupMentionOrder::Parallel,
                },
                message_template: "Review findings".to_string(),
                quorum_count: Some(2),
            }),
        },
        WorkflowStep {
            id: "s_gate".to_string(),
            depends_on: vec!["s_group".to_string()],
            phase: None,
            input_bindings: BTreeMap::new(),
            spec: WorkflowStepSpec::UserGate(UserGateStepSpec {
                interaction_kind: UserInteractionKind::Approval,
                title_template: "Ship patch?".to_string(),
                body_template: "Quorum reached".to_string(),
                approval_options: vec![ApprovalOptionSpec {
                    id: "ship".to_string(),
                    label: "Ship".to_string(),
                    destructive: false,
                    require_note: false,
                }],
                form_schema: None,
                sla_timeout_seconds: Some(600),
            }),
        },
        WorkflowStep {
            id: "s_branch".to_string(),
            depends_on: vec!["s_gate".to_string()],
            phase: None,
            input_bindings: BTreeMap::new(),
            spec: WorkflowStepSpec::ConditionBranch(ConditionBranchStepSpec {
                filter: GateFilterAst {
                    conditions: vec![GateFilterCondition::Eq {
                        pointer: "/selectedOptionId".to_string(),
                        value: serde_json::Value::String("ship".to_string()),
                    }],
                    ..GateFilterAst::default()
                },
                then_step_ids: vec!["s_wait".to_string()],
                else_step_ids: vec!["s_outbox".to_string()],
            }),
        },
        WorkflowStep {
            id: "s_wait".to_string(),
            depends_on: vec!["s_branch".to_string()],
            phase: None,
            input_bindings: BTreeMap::new(),
            spec: WorkflowStepSpec::WaitForEvent(WaitForEventStepSpec {
                event_types: vec!["github.check_suite.completed".to_string()],
                thread_key_pointer: Some("/threadKey".to_string()),
                filter: None,
                timeout_seconds: Some(3600),
            }),
        },
        WorkflowStep {
            id: "s_outbox".to_string(),
            depends_on: vec!["s_branch".to_string()],
            phase: None,
            input_bindings: BTreeMap::new(),
            spec: WorkflowStepSpec::OutboxAction(OutboxActionStepSpec {
                action_kind: OutboxActionKind::ReplyChannel,
                target_template: "slack:C1".to_string(),
                payload_template: serde_json::json!({"status": "done"}),
            }),
        },
        WorkflowStep {
            id: "s_loop".to_string(),
            depends_on: vec!["s_session".to_string()],
            phase: None,
            input_bindings: BTreeMap::new(),
            spec: WorkflowStepSpec::BoundedLoop(BoundedLoopStepSpec {
                target_step_ids: vec!["s_session".to_string()],
                max_iterations: 3,
                until_condition: Some(GateFilterCondition::Exists {
                    pointer: "/done".to_string(),
                }),
            }),
        },
    ];

    let wf = WorkflowDefinition {
        format_version: WORKFLOW_DEFINITION_VERSION,
        name: "all-pulse-primitives".to_string(),
        description: Some("Round-trip test".to_string()),
        input_schema: Some(serde_json::json!({"type": "object"})),
        steps,
        policy: WorkflowPolicy::default(),
    };

    let json = serde_json::to_string_pretty(&wf).unwrap();
    let decoded: WorkflowDefinition = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded, wf);
    let normalized = normalize_definition(decoded).unwrap();
    assert_eq!(normalized.steps.len(), 8);
}

#[test]
fn exhaustive_validation_collects_all_errors_in_single_pass_without_fail_fast() {
    let broken = WorkflowDefinition {
        format_version: WORKFLOW_DEFINITION_VERSION,
        name: "exhaustive-broken-graph".to_string(),
        description: None,
        input_schema: Some(serde_json::json!({"$ref": "https://disallowed.example"})),
        steps: vec![
            WorkflowStep {
                id: "bad_bot".to_string(),
                depends_on: Vec::new(),
                phase: None,
                input_bindings: BTreeMap::new(),
                spec: WorkflowStepSpec::Bot(BotStepSpec {
                    member_id: "   ".to_string(),
                    conversation_scope: BotConversationScope::FixedPrimary,
                    mailbox_policy: BotMailboxPolicy::FifoSerial,
                    prompt_template: "hello".to_string(),
                    completion: CompletionPolicy::Automatic,
                    output_schema: None,
                }),
            },
            WorkflowStep {
                id: "bad_group".to_string(),
                depends_on: Vec::new(),
                phase: None,
                input_bindings: BTreeMap::new(),
                spec: WorkflowStepSpec::GroupStage(GroupStageStepSpec {
                    space_id: String::new(),
                    dispatch_mode: GroupDispatchMode::SpecificSeat {
                        member_id: String::new(),
                    },
                    message_template: "ping".to_string(),
                    quorum_count: Some(0),
                }),
            },
            WorkflowStep {
                id: "bad_wait".to_string(),
                depends_on: Vec::new(),
                phase: None,
                input_bindings: BTreeMap::new(),
                spec: WorkflowStepSpec::WaitForEvent(WaitForEventStepSpec {
                    event_types: Vec::new(),
                    thread_key_pointer: Some("missing_leading_slash".to_string()),
                    filter: None,
                    timeout_seconds: Some(0),
                }),
            },
            WorkflowStep {
                id: "loop_zero".to_string(),
                depends_on: vec!["bad_bot".to_string()],
                phase: None,
                input_bindings: BTreeMap::new(),
                spec: WorkflowStepSpec::BoundedLoop(BoundedLoopStepSpec {
                    target_step_ids: vec!["bad_bot".to_string()],
                    max_iterations: 0,
                    until_condition: None,
                }),
            },
            WorkflowStep {
                id: "loop_over_max".to_string(),
                depends_on: vec!["bad_bot".to_string()],
                phase: None,
                input_bindings: BTreeMap::new(),
                spec: WorkflowStepSpec::BoundedLoop(BoundedLoopStepSpec {
                    target_step_ids: vec!["bad_bot".to_string()],
                    max_iterations: 51,
                    until_condition: None,
                }),
            },
            WorkflowStep {
                id: "bad_gate".to_string(),
                depends_on: Vec::new(),
                phase: None,
                input_bindings: BTreeMap::new(),
                spec: WorkflowStepSpec::UserGate(UserGateStepSpec {
                    interaction_kind: UserInteractionKind::Approval,
                    title_template: "Approve".to_string(),
                    body_template: String::new(),
                    approval_options: Vec::new(),
                    form_schema: Some(serde_json::json!({"$ref": "https://bad.schema"})),
                    sla_timeout_seconds: Some(0),
                }),
            },
            WorkflowStep {
                id: "cycle_a".to_string(),
                depends_on: vec!["cycle_b".to_string()],
                phase: None,
                input_bindings: BTreeMap::new(),
                spec: WorkflowStepSpec::OutboxAction(OutboxActionStepSpec {
                    action_kind: OutboxActionKind::EmitEvent,
                    target_template: "pulse.custom".to_string(),
                    payload_template: serde_json::json!({}),
                }),
            },
            WorkflowStep {
                id: "cycle_b".to_string(),
                depends_on: vec!["cycle_a".to_string()],
                phase: None,
                input_bindings: BTreeMap::new(),
                spec: WorkflowStepSpec::OutboxAction(OutboxActionStepSpec {
                    action_kind: OutboxActionKind::EmitEvent,
                    target_template: "pulse.custom".to_string(),
                    payload_template: serde_json::json!({}),
                }),
            },
        ],
        policy: WorkflowPolicy::default(),
    };

    let errors = validate_definition_errors(&broken);
    let joined = errors.join("\n");
    assert!(
        errors.len() >= 9,
        "expected >= 9 simultaneous errors, got {}: {joined}",
        errors.len()
    );
    assert!(joined.contains("unsupported schema keyword `$ref` at $.inputSchema"));
    assert!(joined.contains("bot step `bad_bot` requires non-empty memberId"));
    assert!(joined.contains("group_stage step `bad_group` requires non-empty spaceId"));
    assert!(joined.contains("wait_for_event step `bad_wait` requires non-empty eventTypes"));
    assert!(joined.contains("wait_for_event step `bad_wait` timeoutSeconds"));
    assert!(joined.contains("bounded_loop step `loop_zero` maxIterations"));
    assert!(joined.contains("bounded_loop step `loop_over_max` maxIterations"));
    assert!(joined.contains("user_gate step `bad_gate` with approval interaction"));
    assert!(joined.contains("cycle outside BoundedLoop"));
}

#[test]
fn graph_patch_applies_mutations_and_collects_exhaustive_patch_and_schema_errors() {
    let base = default_preset_workflow(PresetOrchestratorKind::DirectReflex, "reflex").unwrap();
    let patch = WorkflowGraphPatch::new(vec![
        WorkflowGraphPatchOp::AddStep {
            step: WorkflowStep {
                id: "audit_bot".to_string(),
                depends_on: Vec::new(),
                phase: Some("audit".to_string()),
                input_bindings: BTreeMap::new(),
                spec: WorkflowStepSpec::Bot(BotStepSpec {
                    member_id: "bot-auditor".to_string(),
                    conversation_scope: BotConversationScope::FixedPrimary,
                    mailbox_policy: BotMailboxPolicy::FifoSerial,
                    prompt_template: "Audit outgoing reply".to_string(),
                    completion: CompletionPolicy::Automatic,
                    output_schema: None,
                }),
            },
        },
        WorkflowGraphPatchOp::DisconnectSteps {
            from_step_id: "reflex_actor".to_string(),
            to_step_id: "emit_outbox".to_string(),
        },
        WorkflowGraphPatchOp::ConnectSteps {
            from_step_id: "reflex_actor".to_string(),
            to_step_id: "audit_bot".to_string(),
        },
        WorkflowGraphPatchOp::ConnectSteps {
            from_step_id: "audit_bot".to_string(),
            to_step_id: "emit_outbox".to_string(),
        },
        WorkflowGraphPatchOp::SetPolicy {
            policy: WorkflowPolicy {
                max_concurrent_agent_steps: 8,
                ..WorkflowPolicy::default()
            },
        },
    ]);

    let patched = patch.apply(&base).expect("valid graph patch");
    assert_eq!(patched.steps.len(), 3);
    assert_eq!(patched.policy.max_concurrent_agent_steps, 8);
    let outbox = patched
        .steps
        .iter()
        .find(|s| s.id == "emit_outbox")
        .unwrap();
    assert_eq!(outbox.depends_on, vec!["audit_bot".to_string()]);

    // Verify RemoveStep cleans inbound edges cleanly.
    let removed = apply_workflow_graph_patch(
        &patched,
        &[
            WorkflowGraphPatchOp::ConnectSteps {
                from_step_id: "reflex_actor".to_string(),
                to_step_id: "emit_outbox".to_string(),
            },
            WorkflowGraphPatchOp::RemoveStep {
                step_id: "audit_bot".to_string(),
            },
        ],
    )
    .expect("remove step");
    assert_eq!(removed.steps.len(), 2);

    // Invalid multi-op patch must collect ALL errors without stopping early.
    let bad_errors = apply_workflow_graph_patch(
        &base,
        &[
            WorkflowGraphPatchOp::UpdateStep {
                step: WorkflowStep {
                    id: "nonexistent".to_string(),
                    depends_on: Vec::new(),
                    phase: None,
                    input_bindings: BTreeMap::new(),
                    spec: WorkflowStepSpec::Notify(NotifyStepSpec {
                        title: "hi".to_string(),
                    }),
                },
            },
            WorkflowGraphPatchOp::ConnectSteps {
                from_step_id: "missing_src".to_string(),
                to_step_id: "emit_outbox".to_string(),
            },
            WorkflowGraphPatchOp::AddStep {
                step: WorkflowStep {
                    id: "broken_bot".to_string(),
                    depends_on: Vec::new(),
                    phase: None,
                    input_bindings: BTreeMap::new(),
                    spec: WorkflowStepSpec::Bot(BotStepSpec {
                        member_id: String::new(),
                        conversation_scope: BotConversationScope::FixedPrimary,
                        mailbox_policy: BotMailboxPolicy::FifoSerial,
                        prompt_template: "broken".to_string(),
                        completion: CompletionPolicy::Automatic,
                        output_schema: None,
                    }),
                },
            },
        ],
    )
    .unwrap_err();
    assert!(
        bad_errors.len() >= 3,
        "expected >= 3 errors, got: {bad_errors:?}"
    );
}

#[tokio::test]
async fn superagent_router_preset_branches_deterministically_and_reconverges_on_synthesizer() {
    let (core, store) = setup_pulse_core().await;
    let router_def =
        default_preset_workflow(PresetOrchestratorKind::SuperagentRouter, "superagent-flow")
            .unwrap();

    // Run 1: router selects `code` -> `code_specialist` + `security_auditor` execute, `research_specialist` is skipped.
    let (_, run_code) = publish_and_enable(
        &core,
        &store,
        router_def.clone(),
        serde_json::json!({"query": "Fix race condition in dispatcher"}),
    )
    .await;

    let router_claim = store
        .claim_ready(4, Duration::seconds(30))
        .await
        .unwrap()
        .expect("router_bot ready");
    assert_eq!(router_claim.step.step_id, "router_bot");
    drive_claimed_step_to_completion(
        &core,
        &store,
        &router_claim,
        serde_json::json!({"route": "code", "brief": "Patch dispatcher lock"}),
    )
    .await;

    let steps_after_branch = store.steps(run_code.id).await.unwrap();
    let find_status = |id: &str| {
        steps_after_branch
            .iter()
            .find(|s| s.step_id == id)
            .unwrap()
            .status
            .clone()
    };
    assert_eq!(find_status("route_branch"), "completed");
    assert_eq!(find_status("research_specialist"), "skipped");
    assert_eq!(find_status("code_specialist"), "ready");
    assert_eq!(find_status("security_auditor"), "ready");

    for _ in 0..2 {
        let specialist_claim = store
            .claim_ready(4, Duration::seconds(30))
            .await
            .unwrap()
            .expect("specialist ready");
        assert!(matches!(
            specialist_claim.step.step_id.as_str(),
            "code_specialist" | "security_auditor"
        ));
        drive_claimed_step_to_completion(
            &core,
            &store,
            &specialist_claim,
            serde_json::json!({"findings": format!("done {}", specialist_claim.step.step_id)}),
        )
        .await;
    }

    let synth_claim = store
        .claim_ready(4, Duration::seconds(30))
        .await
        .unwrap()
        .expect("synthesizer_bot ready after reconvergence");
    assert_eq!(synth_claim.step.step_id, "synthesizer_bot");
    let final_run = drive_claimed_step_to_completion(
        &core,
        &store,
        &synth_claim,
        serde_json::json!({"finalAnswer": "Patched and audited"}),
    )
    .await;
    assert_eq!(final_run.status, "completed");

    // Run 2: router selects `research` -> `code_specialist` + `security_auditor` are skipped, `research_specialist` executes.
    let (_, _run_research) = publish_and_enable(
        &core,
        &store,
        router_def,
        serde_json::json!({"query": "Explain event bus architecture"}),
    )
    .await;
    let router_claim_2 = store
        .claim_ready(4, Duration::seconds(30))
        .await
        .unwrap()
        .unwrap();
    drive_claimed_step_to_completion(
        &core,
        &store,
        &router_claim_2,
        serde_json::json!({"route": "research", "brief": "Survey docs"}),
    )
    .await;
    let research_claim = store
        .claim_ready(4, Duration::seconds(30))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(research_claim.step.step_id, "research_specialist");
    drive_claimed_step_to_completion(
        &core,
        &store,
        &research_claim,
        serde_json::json!({"findings": "Architecture documented"}),
    )
    .await;
    let synth_claim_2 = store
        .claim_ready(4, Duration::seconds(30))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(synth_claim_2.step.step_id, "synthesizer_bot");
    let final_run_2 = drive_claimed_step_to_completion(
        &core,
        &store,
        &synth_claim_2,
        serde_json::json!({"finalAnswer": "Summary ready"}),
    )
    .await;
    assert_eq!(final_run_2.status, "completed");
}

#[tokio::test]
async fn hybrid_pipeline_and_other_presets_execute_with_user_gate_and_outbox() {
    let (core, store) = setup_pulse_core().await;

    // 1. DirectReflex (Session & PulseRuleSpec compiler)
    let pulse_rule = PulseRuleSpec {
        name: "pr-reflex".to_string(),
        description: Some("Reflex from PulseRuleSpec".to_string()),
        project_id: None,
        workspace_id: None,
        eval_mode: PulseEvalMode::Auto,
        orchestrator: PresetOrchestratorKind::DirectReflex,
        filter: GateFilterAst::default(),
        temporal: None,
        debounce_ms: 0,
        claim_exclusive: false,
        targets: vec![PulseTargetSpec::Bot {
            member_id: "bot-pr".to_string(),
            conversation_scope: BotConversationScope::PerThreadTopic,
            mailbox_policy: BotMailboxPolicy::FifoSerial,
            subscribe_thread: true,
            prompt_template: "Reply to PR comment".to_string(),
        }],
        callback: None,
        task_meta: None,
    };
    let reflex_def = build_workflow_from_pulse_rule(&pulse_rule).unwrap();
    let (_, reflex_run) =
        publish_and_enable(&core, &store, reflex_def, serde_json::json!({"pr": 42})).await;
    let c1 = store
        .claim_ready(2, Duration::seconds(30))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(c1.step.step_id, "reflex_actor");
    drive_claimed_step_to_completion(&core, &store, &c1, serde_json::json!({"reply": "LGTM!"}))
        .await;
    let c2 = store
        .claim_ready(2, Duration::seconds(30))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(c2.step.step_id, "emit_outbox");
    let done_reflex = drive_claimed_step_to_completion(
        &core,
        &store,
        &c2,
        serde_json::json!({"delivered": true}),
    )
    .await;
    assert_eq!(done_reflex.id, reflex_run.id);
    assert_eq!(done_reflex.status, "completed");

    // 2. HybridPipeline (`Session` -> `GroupStage` -> `UserGate(Approval)` -> `OutboxAction`)
    let hybrid_def =
        default_preset_workflow(PresetOrchestratorKind::HybridPipeline, "ci-fix-pipeline").unwrap();
    let (_, hybrid_run) = publish_and_enable(
        &core,
        &store,
        hybrid_def,
        serde_json::json!({"ciRun": "991"}),
    )
    .await;
    let fix_claim = store
        .claim_ready(2, Duration::seconds(30))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(fix_claim.step.step_id, "reproduce_and_fix");
    drive_claimed_step_to_completion(
        &core,
        &store,
        &fix_claim,
        serde_json::json!({"patchSummary": "Fixed null check", "branch": "fix/ci-991"}),
    )
    .await;

    let group_claim = store
        .claim_ready(2, Duration::seconds(30))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(group_claim.step.step_id, "group_review");
    let waiting_gate_run = drive_claimed_step_to_completion(
        &core,
        &store,
        &group_claim,
        serde_json::json!({"quorumReached": true}),
    )
    .await;
    assert_eq!(waiting_gate_run.status, "waiting");

    // Selecting `reject_changes` requires a note (`require_note: true`).
    let missing_note_err = core
        .decide_user_gate(DecideUserGate {
            run_id: hybrid_run.id,
            step_id: "merge_approval".to_string(),
            selected_option_id: Some("reject_changes".to_string()),
            note: None,
            form_data: None,
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({"id": "reviewer-1"}),
        })
        .await
        .unwrap_err();
    assert!(missing_note_err.to_string().contains("requires a note"));

    // Approve cleanly -> unlocks `publish_result`.
    let resumed_hybrid = core
        .decide_user_gate(DecideUserGate {
            run_id: hybrid_run.id,
            step_id: "merge_approval".to_string(),
            selected_option_id: Some("approve_merge".to_string()),
            note: Some("Verified in staging".to_string()),
            form_data: None,
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({"id": "reviewer-1"}),
        })
        .await
        .unwrap();
    assert_eq!(resumed_hybrid.status, "running");

    let outbox_claim = store
        .claim_ready(2, Duration::seconds(30))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(outbox_claim.step.step_id, "publish_result");
    let completed_hybrid = drive_claimed_step_to_completion(
        &core,
        &store,
        &outbox_claim,
        serde_json::json!({"notified": true}),
    )
    .await;
    assert_eq!(completed_hybrid.status, "completed");

    // 3. WindowAggregator (`Bot(CoalesceBatch)` -> `UserGate(Notify)` non-blocking completion)
    let agg_def =
        default_preset_workflow(PresetOrchestratorKind::WindowAggregator, "hourly-digest").unwrap();
    let (_, agg_run) =
        publish_and_enable(&core, &store, agg_def, serde_json::json!({"window": "1h"})).await;
    let agg_claim = store
        .claim_ready(2, Duration::seconds(30))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(agg_claim.step.step_id, "summarize_window");
    let completed_agg = drive_claimed_step_to_completion(
        &core,
        &store,
        &agg_claim,
        serde_json::json!({"digestMarkdown": "- 3 PRs merged", "itemCount": 3}),
    )
    .await;
    assert_eq!(completed_agg.id, agg_run.id);
    assert_eq!(completed_agg.status, "completed");
}

#[tokio::test]
async fn bot_fifo_serial_mailbox_serializes_across_runs_while_isolated_sessions_run_concurrently() {
    let (core, store) = setup_pulse_core().await;

    let bot_def = build_direct_reflex_workflow(DirectReflexPresetConfig {
        name: "bot-serial-mailbox".to_string(),
        description: None,
        actor: DualPrimitiveActorSpec::Bot {
            member_id: "bot-guardian".to_string(),
            prompt_template: "Guard stateful deployment".to_string(),
            conversation_scope: BotConversationScope::FixedPrimary,
            mailbox_policy: BotMailboxPolicy::FifoSerial,
        },
        outbox_action_kind: OutboxActionKind::EmitEvent,
        outbox_target_template: "pulse.done".to_string(),
        policy: WorkflowPolicy::default(),
    })
    .unwrap();

    let version = core
        .publish(PublishWorkflow {
            definition_id: None,
            definition: bot_def,
            source_path: None,
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({"id": "owner"}),
        })
        .await
        .unwrap();

    let workspace_id = Uuid::new_v4();
    let run_1 = core
        .start(StartWorkflow {
            definition_version_id: version.id,
            workspace_id,
            input: serde_json::json!({"seq": 1}),
            policy_override: None,
            debug_step_id: None,
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({"id": "owner"}),
        })
        .await
        .unwrap();
    let run_2 = core
        .start(StartWorkflow {
            definition_version_id: version.id,
            workspace_id,
            input: serde_json::json!({"seq": 2}),
            policy_override: None,
            debug_step_id: None,
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({"id": "owner"}),
        })
        .await
        .unwrap();
    store.enable_dispatch(run_1.id).await.unwrap();
    store.enable_dispatch(run_2.id).await.unwrap();

    let first_claim = store
        .claim_ready(4, Duration::seconds(30))
        .await
        .unwrap()
        .expect("first bot run claims");
    let active_run_id = first_claim.run.id;
    assert!(active_run_id == run_1.id || active_run_id == run_2.id);

    // Check prepared evidence confirms persistent Bot identity (never resets context).
    let bot_step = first_claim
        .definition
        .steps
        .iter()
        .find(|s| s.id == "reflex_actor")
        .unwrap();
    let resolved = store
        .resolve_step_input(active_run_id, bot_step)
        .await
        .unwrap();
    let prepared_bot = store
        .prepare_step(
            active_run_id,
            bot_step,
            first_claim.claim_token,
            &resolved,
            first_claim.run.workspace_id,
            &serde_json::json!({}),
        )
        .await
        .unwrap();
    let evidence: serde_json::Value =
        serde_json::from_str(prepared_bot.execution_evidence_json.as_deref().unwrap()).unwrap();
    assert_eq!(evidence["preserveLongTermContext"], true);
    assert_eq!(evidence["ephemeralSession"], false);
    assert_eq!(evidence["memberId"], "bot-guardian");

    // Second run targeting the SAME `bot-guardian` with `FifoSerial` MUST wait!
    let blocked_second = store.claim_ready(4, Duration::seconds(30)).await.unwrap();
    assert!(
        blocked_second.is_none(),
        "FifoSerial Bot must serialize concurrent runs for the same member_id"
    );

    // Once the active run's Bot step completes, the queued Bot run becomes claimable immediately!
    store
        .mark_started(
            active_run_id,
            "reflex_actor",
            first_claim.claim_token,
            Some(Uuid::new_v4()),
            Some(Uuid::new_v4()),
        )
        .await
        .unwrap();
    core.complete_step(CompleteWorkflowStep {
        run_id: active_run_id,
        step_id: "reflex_actor".to_string(),
        output: Some(serde_json::json!({"reply": "seq 1 handled"})),
    })
    .await
    .unwrap();

    let unlocked_claim = store
        .claim_ready(4, Duration::seconds(30))
        .await
        .unwrap()
        .expect("active run outbox or queued bot run unlocked");
    assert!(unlocked_claim.run.id == run_1.id || unlocked_claim.run.id == run_2.id);

    // Conversely, two `Session(WriteIsolated)` runs claim concurrently in parallel!
    let session_def = build_direct_reflex_workflow(DirectReflexPresetConfig {
        name: "ephemeral-sessions".to_string(),
        description: None,
        actor: DualPrimitiveActorSpec::Session {
            agent_id: "codex".to_string(),
            prompt_template: "Fresh ephemeral session".to_string(),
            workspace_access: WorkspaceAccess::WriteIsolated,
            model_override: None,
            subscribe_thread: false,
        },
        outbox_action_kind: OutboxActionKind::EmitEvent,
        outbox_target_template: "pulse.done".to_string(),
        policy: WorkflowPolicy::default(),
    })
    .unwrap();
    let (_, s_run_1) =
        publish_and_enable(&core, &store, session_def.clone(), serde_json::json!({})).await;
    let (_, s_run_2) = publish_and_enable(&core, &store, session_def, serde_json::json!({})).await;

    // Drain any remaining claims from earlier runs until we claim both isolated sessions.
    let mut claimed_session_runs = Vec::new();
    while let Some(c) = store.claim_ready(8, Duration::seconds(30)).await.unwrap() {
        if c.run.id == s_run_1.id || c.run.id == s_run_2.id {
            let def_step = c
                .definition
                .steps
                .iter()
                .find(|s| s.id == "reflex_actor")
                .unwrap();
            let res = store.resolve_step_input(c.run.id, def_step).await.unwrap();
            let prepared_session = store
                .prepare_step(
                    c.run.id,
                    def_step,
                    c.claim_token,
                    &res,
                    c.run.workspace_id,
                    &serde_json::json!({}),
                )
                .await
                .unwrap();
            let ev: serde_json::Value =
                serde_json::from_str(prepared_session.execution_evidence_json.as_deref().unwrap())
                    .unwrap();
            assert_eq!(ev["ephemeralSession"], true);
            claimed_session_runs.push(c.run.id);
        }
    }
    assert_eq!(claimed_session_runs.len(), 2);
}

#[tokio::test]
async fn bounded_loop_iterates_until_condition_and_rebuilds_projection_cleanly() {
    let (core, store) = setup_pulse_core().await;

    let mut loop_bindings = BTreeMap::new();
    loop_bindings.insert(
        "worker".to_string(),
        WorkflowBinding::StepOutput {
            step_id: "worker".to_string(),
            pointer: String::new(),
        },
    );

    let wf = normalize_definition(WorkflowDefinition {
        format_version: WORKFLOW_DEFINITION_VERSION,
        name: "bounded-tdd-loop".to_string(),
        description: None,
        input_schema: Some(serde_json::json!({"type": "object"})),
        steps: vec![
            WorkflowStep {
                id: "worker".to_string(),
                depends_on: vec!["check_green".to_string()],
                phase: Some("iterate".to_string()),
                input_bindings: BTreeMap::new(),
                spec: WorkflowStepSpec::Session(SessionStepSpec {
                    agent_id: "codex".to_string(),
                    prompt_template: "Run tests and fix failures".to_string(),
                    workspace_access: WorkspaceAccess::WriteIsolated,
                    model_override: None,
                    subscribe_thread: false,
                    completion: CompletionPolicy::Automatic,
                    output_schema: None,
                }),
            },
            WorkflowStep {
                id: "check_green".to_string(),
                depends_on: vec!["worker".to_string()],
                phase: Some("iterate".to_string()),
                input_bindings: loop_bindings,
                spec: WorkflowStepSpec::BoundedLoop(BoundedLoopStepSpec {
                    target_step_ids: vec!["worker".to_string()],
                    max_iterations: 3,
                    until_condition: Some(GateFilterCondition::Eq {
                        pointer: "/worker/green".to_string(),
                        value: serde_json::Value::Bool(true),
                    }),
                }),
            },
            WorkflowStep {
                id: "report_done".to_string(),
                depends_on: vec!["check_green".to_string()],
                phase: Some("deliver".to_string()),
                input_bindings: BTreeMap::new(),
                spec: WorkflowStepSpec::OutboxAction(OutboxActionStepSpec {
                    action_kind: OutboxActionKind::EmitEvent,
                    target_template: "ci.green".to_string(),
                    payload_template: serde_json::json!({"ok": true}),
                }),
            },
        ],
        policy: WorkflowPolicy::default(),
    })
    .expect("authorized BoundedLoop back-edge passes validation");

    let (_, run) = publish_and_enable(&core, &store, wf, serde_json::json!({})).await;

    // Attempt 1: `green == false` -> loop spawns attempt 2 of `worker`.
    let attempt_1 = store
        .claim_ready(2, Duration::seconds(30))
        .await
        .unwrap()
        .expect("worker attempt 1");
    assert_eq!(attempt_1.step.step_id, "worker");
    assert_eq!(attempt_1.step.attempt, 1);
    drive_claimed_step_to_completion(
        &core,
        &store,
        &attempt_1,
        serde_json::json!({"green": false}),
    )
    .await;

    // Attempt 2: `green == true` -> satisfies `until_condition`, exits loop, enqueues `report_done`!
    let attempt_2 = store
        .claim_ready(2, Duration::seconds(30))
        .await
        .unwrap()
        .expect("worker attempt 2 spawned by BoundedLoop");
    assert_eq!(attempt_2.step.step_id, "worker");
    assert_eq!(attempt_2.step.attempt, 2);
    drive_claimed_step_to_completion(
        &core,
        &store,
        &attempt_2,
        serde_json::json!({"green": true}),
    )
    .await;

    let report_claim = store
        .claim_ready(2, Duration::seconds(30))
        .await
        .unwrap()
        .expect("report_done unlocked after BoundedLoop exit");
    assert_eq!(report_claim.step.step_id, "report_done");
    let finished = drive_claimed_step_to_completion(
        &core,
        &store,
        &report_claim,
        serde_json::json!({"sent": true}),
    )
    .await;
    assert_eq!(finished.status, "completed");

    let before_rebuild = store.steps(run.id).await.unwrap();
    store.rebuild_run_projection(run.id).await.unwrap();
    assert_eq!(store.run(run.id).await.unwrap().status, "completed");
    let after_rebuild = store.steps(run.id).await.unwrap();
    assert_eq!(before_rebuild.len(), after_rebuild.len());
}

#[tokio::test]
async fn event_saga_suspends_survives_restart_matches_correlated_event_and_enforces_sla_timeout() {
    let (core, store) = setup_pulse_core().await;
    let saga_def =
        default_preset_workflow(PresetOrchestratorKind::EventSaga, "support-saga").unwrap();

    let (_, run) = publish_and_enable(
        &core,
        &store,
        saga_def.clone(),
        serde_json::json!({"ticket": "T-100"}),
    )
    .await;

    let init_claim = store
        .claim_ready(2, Duration::seconds(30))
        .await
        .unwrap()
        .expect("saga_initial ready");
    assert_eq!(init_claim.step.step_id, "saga_initial");
    let suspended_run = drive_claimed_step_to_completion(
        &core,
        &store,
        &init_claim,
        serde_json::json!({
            "summary": "Asked user for logs",
            "threadKey": "slack:C1:1700.99"
        }),
    )
    .await;
    assert_eq!(suspended_run.status, "waiting");

    let waiting = core.waiting_event_steps().await.unwrap();
    assert_eq!(waiting.len(), 1);
    assert_eq!(waiting[0].run_id, run.id);
    assert_eq!(waiting[0].step_id, "wait_for_reply");

    // Host restart reconciliation MUST NOT corrupt suspended WaitForEvent steps.
    assert_eq!(store.reconcile_interrupted().await.unwrap(), 0);
    assert_eq!(store.run(run.id).await.unwrap().status, "waiting");

    // 1) Self-authored event or wrong thread_key must NOT resume the Saga.
    let wrong_thread = sample_envelope(
        "evt-wrong-thread",
        "connector.message.received",
        Some("slack:C1:other"),
        false,
        false,
    );
    assert!(
        core.dispatch_event_to_waiting_runs(&wrong_thread, Uuid::new_v4())
            .await
            .unwrap()
            .is_empty()
    );
    let self_event = sample_envelope(
        "evt-self",
        "connector.message.received",
        Some("slack:C1:1700.99"),
        true,
        true,
    );
    assert!(
        core.dispatch_event_to_waiting_runs(&self_event, Uuid::new_v4())
            .await
            .unwrap()
            .is_empty()
    );

    // 2) Matching external human reply on the correlated `thread_key` resumes the Saga!
    let matching_reply = sample_envelope(
        "evt-match-1",
        "connector.message.received",
        Some("slack:C1:1700.99"),
        false,
        false,
    );
    let seed = Uuid::new_v4();
    let resumed_runs = core
        .dispatch_event_to_waiting_runs(&matching_reply, seed)
        .await
        .unwrap();
    assert_eq!(resumed_runs.len(), 1);
    assert_eq!(resumed_runs[0].id, run.id);
    assert_eq!(resumed_runs[0].status, "running");

    // Re-running projection rebuild preserves `StepWaitingEvent` + `StepEventReceived`.
    store.rebuild_run_projection(run.id).await.unwrap();
    assert_eq!(store.run(run.id).await.unwrap().status, "running");

    let followup_claim = store
        .claim_ready(2, Duration::seconds(30))
        .await
        .unwrap()
        .expect("saga_followup unlocked with correlated EventEnvelope");
    assert_eq!(followup_claim.step.step_id, "saga_followup");
    let followup_def_step = followup_claim
        .definition
        .steps
        .iter()
        .find(|s| s.id == "saga_followup")
        .unwrap();
    let resolved_followup = store
        .resolve_step_input(run.id, followup_def_step)
        .await
        .unwrap();
    assert_eq!(
        resolved_followup.values["receivedEvent"]["eventId"],
        "evt-match-1"
    );
    let completed_saga = drive_claimed_step_to_completion(
        &core,
        &store,
        &followup_claim,
        serde_json::json!({"resolution": "Resolved using user logs"}),
    )
    .await;
    assert_eq!(completed_saga.status, "completed");

    // 3) Verify SLA timeout expiration on a second Saga run when deadline passes.
    let (_, timeout_run) = publish_and_enable(
        &core,
        &store,
        saga_def,
        serde_json::json!({"ticket": "T-101"}),
    )
    .await;
    let init_2 = store
        .claim_ready(2, Duration::seconds(30))
        .await
        .unwrap()
        .unwrap();
    drive_claimed_step_to_completion(
        &core,
        &store,
        &init_2,
        serde_json::json!({
            "summary": "Waiting for user",
            "threadKey": "slack:C1:timeout"
        }),
    )
    .await;
    assert_eq!(store.run(timeout_run.id).await.unwrap().status, "waiting");

    let expired = core
        .expire_timed_out_waiting_steps(Utc::now() + Duration::days(2))
        .await
        .unwrap();
    assert_eq!(expired.len(), 1);
    assert_eq!(expired[0].id, timeout_run.id);
    assert_eq!(expired[0].status, "failed");
}

#[tokio::test]
async fn user_gate_ask_form_validates_schema_and_bounded_loop_caps_at_max_iterations() {
    let (core, store) = setup_pulse_core().await;

    let wf = normalize_definition(WorkflowDefinition {
        format_version: WORKFLOW_DEFINITION_VERSION,
        name: "ask-form-and-loop-cap".to_string(),
        description: None,
        input_schema: Some(serde_json::json!({"type": "object"})),
        steps: vec![
            WorkflowStep {
                id: "intake_form".to_string(),
                depends_on: Vec::new(),
                phase: None,
                input_bindings: BTreeMap::new(),
                spec: WorkflowStepSpec::UserGate(UserGateStepSpec {
                    interaction_kind: UserInteractionKind::AskForm,
                    title_template: "Deployment Parameters".to_string(),
                    body_template: "Provide target environment".to_string(),
                    approval_options: Vec::new(),
                    form_schema: Some(serde_json::json!({
                        "type": "object",
                        "required": ["env"],
                        "properties": {
                            "env": { "type": "string", "enum": ["staging", "prod"] }
                        },
                        "additionalProperties": false
                    })),
                    sla_timeout_seconds: Some(600),
                }),
            },
            WorkflowStep {
                id: "attempt_deploy".to_string(),
                depends_on: vec!["intake_form".to_string(), "retry_loop".to_string()],
                phase: None,
                input_bindings: BTreeMap::new(),
                spec: WorkflowStepSpec::Session(SessionStepSpec {
                    agent_id: "codex".to_string(),
                    prompt_template: "Deploy to selected env".to_string(),
                    workspace_access: WorkspaceAccess::ReadOnlyShared,
                    model_override: None,
                    subscribe_thread: false,
                    completion: CompletionPolicy::Automatic,
                    output_schema: None,
                }),
            },
            WorkflowStep {
                id: "retry_loop".to_string(),
                depends_on: vec!["attempt_deploy".to_string()],
                phase: None,
                input_bindings: BTreeMap::new(),
                spec: WorkflowStepSpec::BoundedLoop(BoundedLoopStepSpec {
                    target_step_ids: vec!["attempt_deploy".to_string()],
                    max_iterations: 2,
                    until_condition: Some(GateFilterCondition::Eq {
                        pointer: "/neverMatched".to_string(),
                        value: serde_json::Value::Bool(true),
                    }),
                }),
            },
        ],
        policy: WorkflowPolicy::default(),
    })
    .unwrap();

    let (_, run) = publish_and_enable(&core, &store, wf, serde_json::json!({})).await;
    assert_eq!(run.status, "waiting");

    // Invalid form payload outside enum must be rejected.
    let bad_form = core
        .decide_user_gate(DecideUserGate {
            run_id: run.id,
            step_id: "intake_form".to_string(),
            selected_option_id: None,
            note: None,
            form_data: Some(serde_json::json!({"env": "invalid-env"})),
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({"id": "operator"}),
        })
        .await
        .unwrap_err();
    assert!(bad_form.to_string().contains("outside enum"));

    // Valid form submission unlocks `attempt_deploy`.
    core.decide_user_gate(DecideUserGate {
        run_id: run.id,
        step_id: "intake_form".to_string(),
        selected_option_id: None,
        note: Some("Proceed".to_string()),
        form_data: Some(serde_json::json!({"env": "staging"})),
        operation_id: Uuid::new_v4(),
        principal: serde_json::json!({"id": "operator"}),
    })
    .await
    .unwrap();

    // `max_iterations: 2` runs exactly 2 attempts and then terminates cleanly!
    for expected_attempt in 1..=2 {
        let claim = store
            .claim_ready(2, Duration::seconds(30))
            .await
            .unwrap()
            .expect("attempt_deploy ready");
        assert_eq!(claim.step.attempt, expected_attempt);
        drive_claimed_step_to_completion(
            &core,
            &store,
            &claim,
            serde_json::json!({"tried": expected_attempt}),
        )
        .await;
    }
    assert!(
        store
            .claim_ready(2, Duration::seconds(30))
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(store.run(run.id).await.unwrap().status, "completed");
}
