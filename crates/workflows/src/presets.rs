use std::collections::BTreeMap;

use api_types::{PulseTemporalSpec, PulseWorkspaceIsolation};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    ApprovalOptionSpec, BotConversationScope, BotMailboxPolicy, BotStepSpec, CompletionPolicy,
    ConditionBranchStepSpec, GateFilterAst, GateFilterCondition, GroupDispatchMode,
    GroupStageStepSpec, OutboxActionKind, OutboxActionStepSpec, PresetOrchestratorKind,
    PulseRuleSpec, PulseTargetSpec, SessionStepSpec, UserGateStepSpec, UserInteractionKind,
    WORKFLOW_DEFINITION_VERSION, WaitForEventStepSpec, WorkflowBinding, WorkflowDefinition,
    WorkflowError, WorkflowPolicy, WorkflowStep, WorkflowStepSpec, WorkspaceAccess,
    normalize_definition,
};

/// Dual-primitive actor choice (`Session` ephemeral vs `Bot` persistent) for preset builders.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum DualPrimitiveActorSpec {
    #[serde(rename_all = "camelCase")]
    Session {
        agent_id: String,
        prompt_template: String,
        #[serde(default)]
        workspace_access: WorkspaceAccess,
        #[serde(default)]
        model_override: Option<String>,
        #[serde(default)]
        subscribe_thread: bool,
    },
    #[serde(rename_all = "camelCase")]
    Bot {
        member_id: String,
        prompt_template: String,
        #[serde(default)]
        conversation_scope: BotConversationScope,
        #[serde(default)]
        mailbox_policy: BotMailboxPolicy,
    },
}

impl DualPrimitiveActorSpec {
    fn into_step_spec(self, output_schema: Option<serde_json::Value>) -> WorkflowStepSpec {
        match self {
            Self::Session {
                agent_id,
                prompt_template,
                workspace_access,
                model_override,
                subscribe_thread,
            } => WorkflowStepSpec::Session(SessionStepSpec {
                agent_id,
                prompt_template,
                workspace_access,
                model_override,
                subscribe_thread,
                completion: CompletionPolicy::Automatic,
                output_schema,
            }),
            Self::Bot {
                member_id,
                prompt_template,
                conversation_scope,
                mailbox_policy,
            } => WorkflowStepSpec::Bot(BotStepSpec {
                member_id,
                conversation_scope,
                mailbox_policy,
                prompt_template,
                completion: CompletionPolicy::Automatic,
                output_schema,
            }),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct DirectReflexPresetConfig {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub actor: DualPrimitiveActorSpec,
    #[serde(default)]
    pub outbox_action_kind: OutboxActionKind,
    pub outbox_target_template: String,
    #[serde(default)]
    pub policy: WorkflowPolicy,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct SpecialistSessionSpec {
    pub id: String,
    pub agent_id: String,
    pub prompt_template: String,
    pub workspace_access: WorkspaceAccess,
    #[serde(default)]
    pub model_override: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct SuperagentRouterPresetConfig {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub router_bot_member_id: String,
    pub router_prompt_template: String,
    pub branch_filter: GateFilterAst,
    pub then_specialists: Vec<SpecialistSessionSpec>,
    pub else_specialists: Vec<SpecialistSessionSpec>,
    pub synthesizer_bot_member_id: String,
    pub synthesizer_prompt_template: String,
    #[serde(default)]
    pub policy: WorkflowPolicy,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct HybridPipelinePresetConfig {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub fixer_agent_id: String,
    pub fixer_prompt_template: String,
    pub review_space_id: String,
    pub reviewer_member_id: String,
    pub review_message_template: String,
    pub approval_title_template: String,
    pub approval_body_template: String,
    #[serde(default)]
    pub approval_sla_timeout_seconds: Option<u32>,
    #[serde(default)]
    pub outbox_action_kind: OutboxActionKind,
    pub outbox_target_template: String,
    #[serde(default)]
    pub policy: WorkflowPolicy,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct EventSagaPresetConfig {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub initial_actor: DualPrimitiveActorSpec,
    pub expected_event_types: Vec<String>,
    #[serde(default)]
    pub thread_key_pointer: Option<String>,
    #[serde(default)]
    pub wait_filter: Option<GateFilterAst>,
    pub timeout_seconds: u32,
    pub followup_actor: DualPrimitiveActorSpec,
    #[serde(default)]
    pub policy: WorkflowPolicy,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct WindowAggregatorPresetConfig {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub summarizer_bot_member_id: String,
    pub summarizer_prompt_template: String,
    pub digest_title_template: String,
    pub digest_body_template: String,
    #[serde(default)]
    pub policy: WorkflowPolicy,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "preset", rename_all = "snake_case")]
#[ts(export)]
pub enum PresetOrchestratorSpec {
    DirectReflex(DirectReflexPresetConfig),
    SuperagentRouter(SuperagentRouterPresetConfig),
    HybridPipeline(HybridPipelinePresetConfig),
    EventSaga(EventSagaPresetConfig),
    WindowAggregator(WindowAggregatorPresetConfig),
}

impl PresetOrchestratorSpec {
    pub const fn kind(&self) -> PresetOrchestratorKind {
        match self {
            Self::DirectReflex(_) => PresetOrchestratorKind::DirectReflex,
            Self::SuperagentRouter(_) => PresetOrchestratorKind::SuperagentRouter,
            Self::HybridPipeline(_) => PresetOrchestratorKind::HybridPipeline,
            Self::EventSaga(_) => PresetOrchestratorKind::EventSaga,
            Self::WindowAggregator(_) => PresetOrchestratorKind::WindowAggregator,
        }
    }
}

/// 1. `DirectReflex`: Trigger -> single `Session` or `Bot` -> `OutboxAction`.
pub fn build_direct_reflex_workflow(
    config: DirectReflexPresetConfig,
) -> Result<WorkflowDefinition, WorkflowError> {
    let mut handle_bindings = BTreeMap::new();
    handle_bindings.insert(
        "event".to_string(),
        WorkflowBinding::RunInput {
            pointer: String::new(),
        },
    );
    let handle_step = WorkflowStep {
        id: "reflex_actor".to_string(),
        depends_on: Vec::new(),
        phase: Some("execute".to_string()),
        input_bindings: handle_bindings,
        spec: config.actor.into_step_spec(Some(serde_json::json!({
            "type": "object",
            "required": ["reply"],
            "properties": {
                "reply": { "type": "string" }
            }
        }))),
    };

    let mut outbox_bindings = BTreeMap::new();
    outbox_bindings.insert(
        "reply".to_string(),
        WorkflowBinding::StepOutput {
            step_id: "reflex_actor".to_string(),
            pointer: "/reply".to_string(),
        },
    );
    let outbox_step = WorkflowStep {
        id: "emit_outbox".to_string(),
        depends_on: vec!["reflex_actor".to_string()],
        phase: Some("deliver".to_string()),
        input_bindings: outbox_bindings,
        spec: WorkflowStepSpec::OutboxAction(OutboxActionStepSpec {
            action_kind: config.outbox_action_kind,
            target_template: config.outbox_target_template,
            payload_template: serde_json::json!({
                "message": "{{reply}}"
            }),
        }),
    };

    normalize_definition(WorkflowDefinition {
        format_version: WORKFLOW_DEFINITION_VERSION,
        name: config.name,
        description: config.description,
        input_schema: Some(serde_json::json!({ "type": "object" })),
        steps: vec![handle_step, outbox_step],
        policy: config.policy,
    })
}

/// 2. `SuperagentRouter` (inspired by `dsh-superagent-prototype`):
/// persistent `Bot` router (`FixedPrimary`, `FifoSerial`) -> `ConditionBranch`
/// -> parallel fresh `Session` specialists (`WriteIsolated` / `ReadOnlyShared`) -> `Bot` synthesizer.
pub fn build_superagent_router_workflow(
    config: SuperagentRouterPresetConfig,
) -> Result<WorkflowDefinition, WorkflowError> {
    let mut router_bindings = BTreeMap::new();
    router_bindings.insert(
        "event".to_string(),
        WorkflowBinding::RunInput {
            pointer: String::new(),
        },
    );
    let router_step = WorkflowStep {
        id: "router_bot".to_string(),
        depends_on: Vec::new(),
        phase: Some("triage".to_string()),
        input_bindings: router_bindings,
        spec: WorkflowStepSpec::Bot(BotStepSpec {
            member_id: config.router_bot_member_id,
            conversation_scope: BotConversationScope::FixedPrimary,
            mailbox_policy: BotMailboxPolicy::FifoSerial,
            prompt_template: config.router_prompt_template,
            completion: CompletionPolicy::Automatic,
            output_schema: Some(serde_json::json!({
                "type": "object",
                "required": ["route", "brief"],
                "properties": {
                    "route": { "type": "string" },
                    "brief": { "type": "string" }
                }
            })),
        }),
    };

    let then_ids = config
        .then_specialists
        .iter()
        .map(|s| s.id.clone())
        .collect::<Vec<_>>();
    let else_ids = config
        .else_specialists
        .iter()
        .map(|s| s.id.clone())
        .collect::<Vec<_>>();

    let mut branch_bindings = BTreeMap::new();
    branch_bindings.insert(
        "route".to_string(),
        WorkflowBinding::StepOutput {
            step_id: "router_bot".to_string(),
            pointer: "/route".to_string(),
        },
    );
    let branch_step = WorkflowStep {
        id: "route_branch".to_string(),
        depends_on: vec!["router_bot".to_string()],
        phase: Some("route".to_string()),
        input_bindings: branch_bindings,
        spec: WorkflowStepSpec::ConditionBranch(ConditionBranchStepSpec {
            filter: config.branch_filter,
            then_step_ids: then_ids,
            else_step_ids: else_ids,
        }),
    };

    let mut steps = vec![router_step, branch_step];
    let mut all_specialist_ids = Vec::new();
    for spec in config
        .then_specialists
        .into_iter()
        .chain(config.else_specialists)
    {
        all_specialist_ids.push(spec.id.clone());
        let mut specialist_bindings = BTreeMap::new();
        specialist_bindings.insert(
            "brief".to_string(),
            WorkflowBinding::StepOutput {
                step_id: "router_bot".to_string(),
                pointer: "/brief".to_string(),
            },
        );
        steps.push(WorkflowStep {
            id: spec.id,
            depends_on: vec!["route_branch".to_string()],
            phase: Some("specialists".to_string()),
            input_bindings: specialist_bindings,
            spec: WorkflowStepSpec::Session(SessionStepSpec {
                agent_id: spec.agent_id,
                prompt_template: spec.prompt_template,
                workspace_access: spec.workspace_access,
                model_override: spec.model_override,
                subscribe_thread: false,
                completion: CompletionPolicy::Automatic,
                output_schema: Some(serde_json::json!({
                    "type": "object",
                    "required": ["findings"],
                    "properties": {
                        "findings": { "type": "string" }
                    }
                })),
            }),
        });
    }

    steps.push(WorkflowStep {
        id: "synthesizer_bot".to_string(),
        depends_on: all_specialist_ids,
        phase: Some("synthesize".to_string()),
        input_bindings: BTreeMap::new(),
        spec: WorkflowStepSpec::Bot(BotStepSpec {
            member_id: config.synthesizer_bot_member_id,
            conversation_scope: BotConversationScope::FixedPrimary,
            mailbox_policy: BotMailboxPolicy::FifoSerial,
            prompt_template: config.synthesizer_prompt_template,
            completion: CompletionPolicy::Automatic,
            output_schema: Some(serde_json::json!({
                "type": "object",
                "required": ["summary"],
                "properties": {
                    "summary": { "type": "string" }
                }
            })),
        }),
    });

    normalize_definition(WorkflowDefinition {
        format_version: WORKFLOW_DEFINITION_VERSION,
        name: config.name,
        description: config.description,
        input_schema: Some(serde_json::json!({ "type": "object" })),
        steps,
        policy: config.policy,
    })
}

/// 3. `HybridPipeline`:
/// fresh `Session` reproduce/fix (`WriteIsolated`) -> `GroupStage` `@reviewer` seat review
/// -> `UserGate` merge approval (`Approval`) -> `OutboxAction`.
pub fn build_hybrid_pipeline_workflow(
    config: HybridPipelinePresetConfig,
) -> Result<WorkflowDefinition, WorkflowError> {
    let mut fix_bindings = BTreeMap::new();
    fix_bindings.insert(
        "event".to_string(),
        WorkflowBinding::RunInput {
            pointer: String::new(),
        },
    );
    let fix_step = WorkflowStep {
        id: "reproduce_and_fix".to_string(),
        depends_on: Vec::new(),
        phase: Some("implement".to_string()),
        input_bindings: fix_bindings,
        spec: WorkflowStepSpec::Session(SessionStepSpec {
            agent_id: config.fixer_agent_id,
            prompt_template: config.fixer_prompt_template,
            workspace_access: WorkspaceAccess::WriteIsolated,
            model_override: None,
            subscribe_thread: false,
            completion: CompletionPolicy::Automatic,
            output_schema: Some(serde_json::json!({
                "type": "object",
                "required": ["patchSummary"],
                "properties": {
                    "patchSummary": { "type": "string" }
                }
            })),
        }),
    };

    let mut review_bindings = BTreeMap::new();
    review_bindings.insert(
        "patchSummary".to_string(),
        WorkflowBinding::StepOutput {
            step_id: "reproduce_and_fix".to_string(),
            pointer: "/patchSummary".to_string(),
        },
    );
    let review_step = WorkflowStep {
        id: "group_review".to_string(),
        depends_on: vec!["reproduce_and_fix".to_string()],
        phase: Some("review".to_string()),
        input_bindings: review_bindings,
        spec: WorkflowStepSpec::GroupStage(GroupStageStepSpec {
            space_id: config.review_space_id,
            dispatch_mode: GroupDispatchMode::SpecificSeat {
                member_id: config.reviewer_member_id,
            },
            message_template: config.review_message_template,
            quorum_count: Some(1),
        }),
    };

    let gate_step = WorkflowStep {
        id: "merge_approval".to_string(),
        depends_on: vec!["group_review".to_string()],
        phase: Some("approve".to_string()),
        input_bindings: BTreeMap::new(),
        spec: WorkflowStepSpec::UserGate(UserGateStepSpec {
            interaction_kind: UserInteractionKind::Approval,
            title_template: config.approval_title_template,
            body_template: config.approval_body_template,
            approval_options: vec![
                ApprovalOptionSpec {
                    id: "approve_merge".to_string(),
                    label: "Approve & Merge".to_string(),
                    destructive: false,
                    require_note: false,
                },
                ApprovalOptionSpec {
                    id: "reject_changes".to_string(),
                    label: "Reject".to_string(),
                    destructive: true,
                    require_note: true,
                },
            ],
            form_schema: None,
            sla_timeout_seconds: config.approval_sla_timeout_seconds,
        }),
    };

    let outbox_step = WorkflowStep {
        id: "publish_result".to_string(),
        depends_on: vec!["merge_approval".to_string()],
        phase: Some("deliver".to_string()),
        input_bindings: BTreeMap::new(),
        spec: WorkflowStepSpec::OutboxAction(OutboxActionStepSpec {
            action_kind: config.outbox_action_kind,
            target_template: config.outbox_target_template,
            payload_template: serde_json::json!({
                "status": "merged"
            }),
        }),
    };

    normalize_definition(WorkflowDefinition {
        format_version: WORKFLOW_DEFINITION_VERSION,
        name: config.name,
        description: config.description,
        input_schema: Some(serde_json::json!({ "type": "object" })),
        steps: vec![fix_step, review_step, gate_step, outbox_step],
        policy: config.policy,
    })
}

/// 4. `EventSaga`:
/// `Session` or `Bot` initial action -> `WaitForEvent` correlating on `thread_key`
/// with SLA `timeout_seconds` -> follow-up `Session` or `Bot` step.
pub fn build_event_saga_workflow(
    config: EventSagaPresetConfig,
) -> Result<WorkflowDefinition, WorkflowError> {
    let mut initial_bindings = BTreeMap::new();
    initial_bindings.insert(
        "trigger".to_string(),
        WorkflowBinding::RunInput {
            pointer: String::new(),
        },
    );
    let initial_step = WorkflowStep {
        id: "saga_initial".to_string(),
        depends_on: Vec::new(),
        phase: Some("initiate".to_string()),
        input_bindings: initial_bindings,
        spec: config.initial_actor.into_step_spec(Some(serde_json::json!({
            "type": "object",
            "required": ["threadKey"],
            "properties": {
                "threadKey": { "type": "string" }
            }
        }))),
    };

    let mut wait_bindings = BTreeMap::new();
    wait_bindings.insert(
        "threadKey".to_string(),
        WorkflowBinding::StepOutput {
            step_id: "saga_initial".to_string(),
            pointer: "/threadKey".to_string(),
        },
    );
    let wait_step = WorkflowStep {
        id: "wait_for_reply".to_string(),
        depends_on: vec!["saga_initial".to_string()],
        phase: Some("await_event".to_string()),
        input_bindings: wait_bindings,
        spec: WorkflowStepSpec::WaitForEvent(WaitForEventStepSpec {
            event_types: config.expected_event_types,
            thread_key_pointer: Some(
                config
                    .thread_key_pointer
                    .unwrap_or_else(|| "/threadKey".to_string()),
            ),
            filter: config.wait_filter,
            timeout_seconds: Some(config.timeout_seconds),
        }),
    };

    let mut followup_bindings = BTreeMap::new();
    followup_bindings.insert(
        "receivedEvent".to_string(),
        WorkflowBinding::StepOutput {
            step_id: "wait_for_reply".to_string(),
            pointer: String::new(),
        },
    );
    let followup_step = WorkflowStep {
        id: "saga_followup".to_string(),
        depends_on: vec!["wait_for_reply".to_string()],
        phase: Some("resume".to_string()),
        input_bindings: followup_bindings,
        spec: config.followup_actor.into_step_spec(None),
    };

    normalize_definition(WorkflowDefinition {
        format_version: WORKFLOW_DEFINITION_VERSION,
        name: config.name,
        description: config.description,
        input_schema: Some(serde_json::json!({ "type": "object" })),
        steps: vec![initial_step, wait_step, followup_step],
        policy: config.policy,
    })
}

/// 5. `WindowAggregator`:
/// scheduled/windowed event digest -> `Bot` memory-preserving summarizer
/// (`FixedPrimary`, `CoalesceBatch`) -> `UserGate` digest notify.
pub fn build_window_aggregator_workflow(
    config: WindowAggregatorPresetConfig,
) -> Result<WorkflowDefinition, WorkflowError> {
    let mut summarize_bindings = BTreeMap::new();
    summarize_bindings.insert(
        "windowEvents".to_string(),
        WorkflowBinding::RunInput {
            pointer: String::new(),
        },
    );
    let summarize_step = WorkflowStep {
        id: "summarize_window".to_string(),
        depends_on: Vec::new(),
        phase: Some("aggregate".to_string()),
        input_bindings: summarize_bindings,
        spec: WorkflowStepSpec::Bot(BotStepSpec {
            member_id: config.summarizer_bot_member_id,
            conversation_scope: BotConversationScope::FixedPrimary,
            mailbox_policy: BotMailboxPolicy::CoalesceBatch,
            prompt_template: config.summarizer_prompt_template,
            completion: CompletionPolicy::Automatic,
            output_schema: Some(serde_json::json!({
                "type": "object",
                "required": ["digestMarkdown"],
                "properties": {
                    "digestMarkdown": { "type": "string" }
                }
            })),
        }),
    };

    let mut notify_bindings = BTreeMap::new();
    notify_bindings.insert(
        "digestMarkdown".to_string(),
        WorkflowBinding::StepOutput {
            step_id: "summarize_window".to_string(),
            pointer: "/digestMarkdown".to_string(),
        },
    );
    let notify_step = WorkflowStep {
        id: "digest_notify".to_string(),
        depends_on: vec!["summarize_window".to_string()],
        phase: Some("notify".to_string()),
        input_bindings: notify_bindings,
        spec: WorkflowStepSpec::UserGate(UserGateStepSpec {
            interaction_kind: UserInteractionKind::Notify,
            title_template: config.digest_title_template,
            body_template: config.digest_body_template,
            approval_options: Vec::new(),
            form_schema: None,
            sla_timeout_seconds: None,
        }),
    };

    normalize_definition(WorkflowDefinition {
        format_version: WORKFLOW_DEFINITION_VERSION,
        name: config.name,
        description: config.description,
        input_schema: Some(serde_json::json!({ "type": "object" })),
        steps: vec![summarize_step, notify_step],
        policy: config.policy,
    })
}

/// Dispatches to the matching Preset Orchestrator builder.
pub fn build_preset_workflow(
    spec: PresetOrchestratorSpec,
) -> Result<WorkflowDefinition, WorkflowError> {
    match spec {
        PresetOrchestratorSpec::DirectReflex(config) => build_direct_reflex_workflow(config),
        PresetOrchestratorSpec::SuperagentRouter(config) => {
            build_superagent_router_workflow(config)
        }
        PresetOrchestratorSpec::HybridPipeline(config) => build_hybrid_pipeline_workflow(config),
        PresetOrchestratorSpec::EventSaga(config) => build_event_saga_workflow(config),
        PresetOrchestratorSpec::WindowAggregator(config) => {
            build_window_aggregator_workflow(config)
        }
    }
}

/// Constructs a canonical default workflow template for any of the 5 `PresetOrchestratorKind`s.
pub fn default_preset_workflow(
    kind: PresetOrchestratorKind,
    name: &str,
) -> Result<WorkflowDefinition, WorkflowError> {
    match kind {
        PresetOrchestratorKind::DirectReflex => {
            build_direct_reflex_workflow(DirectReflexPresetConfig {
                name: name.to_string(),
                description: Some("Direct reflex automation".to_string()),
                actor: DualPrimitiveActorSpec::Session {
                    agent_id: "codex".to_string(),
                    prompt_template: "Handle incoming event and craft a concise reply.".to_string(),
                    workspace_access: WorkspaceAccess::ReadOnlyShared,
                    model_override: None,
                    subscribe_thread: false,
                },
                outbox_action_kind: OutboxActionKind::ReplyChannel,
                outbox_target_template: "{{event.replyTo}}".to_string(),
                policy: WorkflowPolicy::default(),
            })
        }
        PresetOrchestratorKind::SuperagentRouter => {
            build_superagent_router_workflow(SuperagentRouterPresetConfig {
                name: name.to_string(),
                description: Some(
                    "Persistent Bot router fanning out to isolated Session specialists".to_string(),
                ),
                router_bot_member_id: "bot-router".to_string(),
                router_prompt_template:
                    "Classify incoming event into `code` or `research` and emit specialist brief."
                        .to_string(),
                branch_filter: GateFilterAst {
                    conditions: vec![GateFilterCondition::Eq {
                        pointer: "/route".to_string(),
                        value: serde_json::Value::String("code".to_string()),
                    }],
                    ..GateFilterAst::default()
                },
                then_specialists: vec![
                    SpecialistSessionSpec {
                        id: "code_specialist".to_string(),
                        agent_id: "codex".to_string(),
                        prompt_template: "Implement or verify code changes in isolated worktree."
                            .to_string(),
                        workspace_access: WorkspaceAccess::WriteIsolated,
                        model_override: None,
                    },
                    SpecialistSessionSpec {
                        id: "security_auditor".to_string(),
                        agent_id: "codex".to_string(),
                        prompt_template: "Audit patch diff for security regressions.".to_string(),
                        workspace_access: WorkspaceAccess::ReadOnlyShared,
                        model_override: None,
                    },
                ],
                else_specialists: vec![SpecialistSessionSpec {
                    id: "research_specialist".to_string(),
                    agent_id: "codex".to_string(),
                    prompt_template: "Investigate codebase and documentation in read-only mode."
                        .to_string(),
                    workspace_access: WorkspaceAccess::ReadOnlyShared,
                    model_override: None,
                }],
                synthesizer_bot_member_id: "bot-router".to_string(),
                synthesizer_prompt_template:
                    "Synthesize specialist findings into a persistent thread response.".to_string(),
                policy: WorkflowPolicy::default(),
            })
        }
        PresetOrchestratorKind::HybridPipeline => {
            build_hybrid_pipeline_workflow(HybridPipelinePresetConfig {
                name: name.to_string(),
                description: Some(
                    "Isolated Session fix -> Group @reviewer stage -> UserGate merge approval -> Outbox"
                        .to_string(),
                ),
                fixer_agent_id: "codex".to_string(),
                fixer_prompt_template:
                    "Reproduce reported failure and produce a verified fix in isolated worktree."
                        .to_string(),
                review_space_id: "engineering-review".to_string(),
                reviewer_member_id: "reviewer".to_string(),
                review_message_template: "Please review proposed patch: {{patchSummary}}"
                    .to_string(),
                approval_title_template: "Approve merge for {{name}}".to_string(),
                approval_body_template:
                    "Reviewer stage completed. Confirm merge and external release notification."
                        .to_string(),
                approval_sla_timeout_seconds: Some(3_600),
                outbox_action_kind: OutboxActionKind::ReplyChannel,
                outbox_target_template: "{{event.replyTo}}".to_string(),
                policy: WorkflowPolicy::default(),
            })
        }
        PresetOrchestratorKind::EventSaga => build_event_saga_workflow(EventSagaPresetConfig {
            name: name.to_string(),
            description: Some(
                "Multi-stage Event Saga suspending on correlated thread_key reply".to_string(),
            ),
            initial_actor: DualPrimitiveActorSpec::Bot {
                member_id: "bot-triage".to_string(),
                prompt_template:
                    "Request clarification on thread and record correlation threadKey.".to_string(),
                conversation_scope: BotConversationScope::PerThreadTopic,
                mailbox_policy: BotMailboxPolicy::FifoSerial,
            },
            expected_event_types: vec!["connector.message.received".to_string()],
            thread_key_pointer: Some("/threadKey".to_string()),
            wait_filter: Some(GateFilterAst {
                conditions: vec![GateFilterCondition::NotBotActor],
                ..GateFilterAst::default()
            }),
            timeout_seconds: 86_400,
            followup_actor: DualPrimitiveActorSpec::Session {
                agent_id: "codex".to_string(),
                prompt_template: "Resume saga execution using correlated user reply.".to_string(),
                workspace_access: WorkspaceAccess::WriteIsolated,
                model_override: None,
                subscribe_thread: true,
            },
            policy: WorkflowPolicy::default(),
        }),
        PresetOrchestratorKind::WindowAggregator => {
            build_window_aggregator_workflow(WindowAggregatorPresetConfig {
                name: name.to_string(),
                description: Some(
                    "Windowed event batch summarizer with persistent Bot memory".to_string(),
                ),
                summarizer_bot_member_id: "bot-digest".to_string(),
                summarizer_prompt_template:
                    "Summarize windowed activity while deduplicating previously reported items."
                        .to_string(),
                digest_title_template: "Pulse Activity Digest".to_string(),
                digest_body_template: "{{digestMarkdown}}".to_string(),
                policy: WorkflowPolicy::default(),
            })
        }
    }
}

/// Compiles a declarative `PulseRuleSpec` into an executable `WorkflowDefinition`
/// using its configured `PresetOrchestratorKind` and target bindings.
pub fn build_workflow_from_pulse_rule(
    rule: &PulseRuleSpec,
) -> Result<WorkflowDefinition, WorkflowError> {
    let primary_actor = rule.targets.iter().find_map(|target| match target {
        PulseTargetSpec::Session {
            agent_id,
            model_override,
            workspace_isolation,
            subscribe_thread,
            prompt_template,
            ..
        } => Some(DualPrimitiveActorSpec::Session {
            agent_id: agent_id.clone(),
            prompt_template: prompt_template.clone(),
            workspace_access: match workspace_isolation {
                PulseWorkspaceIsolation::IsolatedWorktree => WorkspaceAccess::WriteIsolated,
                PulseWorkspaceIsolation::ProjectRoot => WorkspaceAccess::WriteSerialized,
                PulseWorkspaceIsolation::Scratch => WorkspaceAccess::ReadOnlyShared,
            },
            model_override: model_override.clone(),
            subscribe_thread: *subscribe_thread,
        }),
        PulseTargetSpec::Bot {
            member_id,
            conversation_scope,
            mailbox_policy,
            prompt_template,
            ..
        } => Some(DualPrimitiveActorSpec::Bot {
            member_id: member_id.clone(),
            prompt_template: prompt_template.clone(),
            conversation_scope: *conversation_scope,
            mailbox_policy: *mailbox_policy,
        }),
        _ => None,
    });

    match rule.orchestrator {
        PresetOrchestratorKind::DirectReflex => {
            if let Some(actor) = primary_actor {
                return build_direct_reflex_workflow(DirectReflexPresetConfig {
                    name: rule.name.clone(),
                    description: rule.description.clone(),
                    actor,
                    outbox_action_kind: OutboxActionKind::ReplyChannel,
                    outbox_target_template: "{{event.replyTo}}".to_string(),
                    policy: WorkflowPolicy::default(),
                });
            }
            default_preset_workflow(PresetOrchestratorKind::DirectReflex, &rule.name)
        }
        PresetOrchestratorKind::EventSaga => {
            let (timeout_seconds, expected_event_types) = match &rule.temporal {
                Some(PulseTemporalSpec::InactivitySla {
                    timeout_seconds,
                    expected_event_types,
                    ..
                }) => (
                    *timeout_seconds,
                    if expected_event_types.is_empty() {
                        vec!["connector.message.received".to_string()]
                    } else {
                        expected_event_types.clone()
                    },
                ),
                _ => (86_400, vec!["connector.message.received".to_string()]),
            };
            let actor = primary_actor.unwrap_or_else(|| DualPrimitiveActorSpec::Session {
                agent_id: "codex".to_string(),
                prompt_template: "Initiate event saga".to_string(),
                workspace_access: WorkspaceAccess::ReadOnlyShared,
                model_override: None,
                subscribe_thread: false,
            });
            build_event_saga_workflow(EventSagaPresetConfig {
                name: rule.name.clone(),
                description: rule.description.clone(),
                initial_actor: actor.clone(),
                expected_event_types,
                thread_key_pointer: Some("/threadKey".to_string()),
                wait_filter: None,
                timeout_seconds,
                followup_actor: actor,
                policy: WorkflowPolicy::default(),
            })
        }
        other => default_preset_workflow(other, &rule.name),
    }
}
