use std::collections::{BTreeMap, BTreeSet, VecDeque};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    BotStepSpec, BoundedLoopStepSpec, ConditionBranchStepSpec, GroupDispatchMode,
    GroupStageStepSpec, MAX_BOUNDED_LOOP_ITERATIONS, MAX_WAIT_FOR_EVENT_TIMEOUT_SECONDS,
    OutboxActionStepSpec, SessionStepSpec, UserGateStepSpec, UserInteractionKind,
    WaitForEventStepSpec, WorkflowError,
    pulse_steps::{validate_gate_condition, validate_gate_filter_ast},
};

pub const WORKFLOW_DEFINITION_VERSION: u32 = 1;
pub const MAX_WORKFLOW_STEPS: usize = 1_000;
pub(crate) const MAX_WORKFLOW_INPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_WORKFLOW_DEFINITION_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const MAX_STEP_PROMPT_BYTES: usize = 64 * 1024;
const MAX_STEP_OUTPUT_DESCRIPTION_BYTES: usize = 16 * 1024;
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
    Notify(NotifyStepSpec),
    Session(SessionStepSpec),
    Bot(BotStepSpec),
    GroupStage(GroupStageStepSpec),
    UserGate(UserGateStepSpec),
    ConditionBranch(ConditionBranchStepSpec),
    BoundedLoop(BoundedLoopStepSpec),
    WaitForEvent(WaitForEventStepSpec),
    OutboxAction(OutboxActionStepSpec),
}

impl WorkflowStepSpec {
    pub const fn kind_name(&self) -> &'static str {
        match self {
            Self::Agent(_) => "agent",
            Self::Approval(_) => "approval",
            Self::Notify(_) => "notify",
            Self::Session(_) => "session",
            Self::Bot(_) => "bot",
            Self::GroupStage(_) => "group_stage",
            Self::UserGate(_) => "user_gate",
            Self::ConditionBranch(_) => "condition_branch",
            Self::BoundedLoop(_) => "bounded_loop",
            Self::WaitForEvent(_) => "wait_for_event",
            Self::OutboxAction(_) => "outbox_action",
        }
    }

    pub const fn output_schema(&self) -> Option<&serde_json::Value> {
        match self {
            Self::Agent(agent) => agent.output_schema.as_ref(),
            Self::Session(session) => session.output_schema.as_ref(),
            Self::Bot(bot) => bot.output_schema.as_ref(),
            Self::Approval(_)
            | Self::Notify(_)
            | Self::GroupStage(_)
            | Self::UserGate(_)
            | Self::ConditionBranch(_)
            | Self::BoundedLoop(_)
            | Self::WaitForEvent(_)
            | Self::OutboxAction(_) => None,
        }
    }

    pub const fn is_executable_step(&self) -> bool {
        matches!(
            self,
            Self::Agent(_)
                | Self::Session(_)
                | Self::Bot(_)
                | Self::GroupStage(_)
                | Self::OutboxAction(_)
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct AgentStepSpec {
    pub agent_id: String,
    pub prompt: String,
    #[serde(default)]
    pub executor_profile_id: Option<serde_json::Value>,
    #[serde(default)]
    pub mode_override: Option<String>,
    #[serde(default)]
    pub config_overrides: BTreeMap<String, String>,
    #[serde(default)]
    pub output_language: Option<String>,
    #[serde(default)]
    pub output_description: Option<String>,
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
    #[serde(default)]
    pub completion_policy: CompletionPolicy,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CompletionPolicy {
    #[default]
    Automatic,
    Manual,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct NotifyStepSpec {
    #[serde(default)]
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "source", rename_all = "snake_case")]
#[ts(export)]
pub enum WorkflowBinding {
    RunInput {
        pointer: String,
    },
    StepOutput {
        #[serde(alias = "stepId")]
        step_id: String,
        pointer: String,
    },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum WorkspaceAccess {
    #[default]
    Native,
    ReadOnlyShared,
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
    // u32 on purpose: the hard limit (7 days) fits, and JSON IPC (Tauri
    // serializes invoke payloads with JSON.stringify) cannot carry bigint.
    pub deadline_seconds: u32,
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

pub(crate) fn normalize_definition_in_place(definition: &mut WorkflowDefinition) {
    definition.name = definition.name.trim().to_string();
    definition.description = definition
        .description
        .take()
        .map(|description| description.trim().to_string())
        .filter(|description| !description.is_empty());
    for step in &mut definition.steps {
        step.id = step.id.trim().to_string();
        for dep in &mut step.depends_on {
            *dep = dep.trim().to_string();
        }
        step.depends_on.sort();
        step.depends_on.dedup();
        match &mut step.spec {
            WorkflowStepSpec::ConditionBranch(branch) => {
                for id in &mut branch.then_step_ids {
                    *id = id.trim().to_string();
                }
                branch.then_step_ids.dedup();
                for id in &mut branch.else_step_ids {
                    *id = id.trim().to_string();
                }
                branch.else_step_ids.dedup();
            }
            WorkflowStepSpec::BoundedLoop(bounded) => {
                for id in &mut bounded.target_step_ids {
                    *id = id.trim().to_string();
                }
                bounded.target_step_ids.dedup();
            }
            WorkflowStepSpec::WaitForEvent(wait) => {
                for event_type in &mut wait.event_types {
                    *event_type = event_type.trim().to_string();
                }
                wait.event_types.dedup();
            }
            _ => {}
        }
    }
    definition
        .steps
        .sort_by(|left, right| left.id.cmp(&right.id));
}

pub fn normalize_definition(
    mut definition: WorkflowDefinition,
) -> Result<WorkflowDefinition, WorkflowError> {
    normalize_definition_in_place(&mut definition);
    validate_definition(&definition)?;
    Ok(definition)
}

/// Exhaustively validates a `WorkflowDefinition` in a single pass without failing
/// fast on the first violation. Returns all collected validation error messages.
pub fn validate_definition_errors(definition: &WorkflowDefinition) -> Vec<String> {
    let mut errors = Vec::new();

    match serde_json::to_vec(definition) {
        Ok(bytes) => {
            if bytes.len() > MAX_WORKFLOW_DEFINITION_BYTES {
                errors.push(format!(
                    "workflow definition exceeds {MAX_WORKFLOW_DEFINITION_BYTES} bytes"
                ));
            }
        }
        Err(err) => {
            errors.push(format!("workflow definition failed serialization: {err}"));
        }
    }

    if definition.format_version != WORKFLOW_DEFINITION_VERSION {
        errors.push(format!(
            "unsupported workflow format version {}",
            definition.format_version
        ));
    }
    if definition.name.trim().is_empty() || definition.name.len() > 200 {
        errors.push("workflow name must contain 1..=200 bytes".to_string());
    }
    if definition.steps.is_empty() || definition.steps.len() > MAX_WORKFLOW_STEPS {
        errors.push(format!(
            "workflow must contain 1..={MAX_WORKFLOW_STEPS} steps"
        ));
    }
    validate_policy_errors(&definition.policy, &mut errors);
    if let Some(schema) = &definition.input_schema {
        let mut nodes = 0;
        validate_schema_node_errors(schema, 0, "$.inputSchema", &mut nodes, &mut errors);
    }

    let mut seen_ids = BTreeSet::new();
    let mut by_id = BTreeMap::<&str, &WorkflowStep>::new();
    for step in &definition.steps {
        if !valid_step_id(&step.id) || !seen_ids.insert(step.id.as_str()) {
            errors.push(format!("invalid or duplicate step id `{}`", step.id));
        } else {
            by_id.insert(step.id.as_str(), step);
        }
        validate_step_spec(step, &mut errors);
    }

    for step in &definition.steps {
        validate_step_cross_references(step, &by_id, definition, &mut errors);
    }

    if !by_id.is_empty()
        && let Err(cycle_error) = deterministic_order_for_known_steps(definition, &by_id)
    {
        errors.push(cycle_error);
    }

    errors
}

pub fn validate_definition(definition: &WorkflowDefinition) -> Result<(), WorkflowError> {
    let errors = validate_definition_errors(definition);
    if errors.is_empty() {
        Ok(())
    } else {
        Err(WorkflowError::Validation(errors.join("; ")))
    }
}

fn validate_step_spec(step: &WorkflowStep, errors: &mut Vec<String>) {
    match &step.spec {
        WorkflowStepSpec::Agent(agent) => {
            if agent.agent_id.trim().is_empty() || agent.prompt.trim().is_empty() {
                errors.push(format!(
                    "agent step `{}` requires agentId and prompt",
                    step.id
                ));
            }
            if agent.agent_id.len() > 200 || agent.prompt.len() > MAX_STEP_PROMPT_BYTES {
                errors.push(format!(
                    "agent step `{}` agentId or prompt exceeds supported size",
                    step.id
                ));
            }
            if agent.side_effect_class == SideEffectClass::ReadOnly
                && agent.workspace_access != WorkspaceAccess::ReadOnlyShared
            {
                errors.push(format!(
                    "step `{}` claims read_only without read_only_shared enforcement",
                    step.id
                ));
            }
            if agent
                .output_language
                .as_ref()
                .is_some_and(|language| language.trim().is_empty() || language.len() > 64)
            {
                errors.push(format!(
                    "agent step `{}` has an invalid outputLanguage",
                    step.id
                ));
            }
            if agent
                .output_description
                .as_ref()
                .is_some_and(|description| description.len() > MAX_STEP_OUTPUT_DESCRIPTION_BYTES)
            {
                errors.push(format!(
                    "agent step `{}` outputDescription exceeds the size limit",
                    step.id
                ));
            }
            if let Some(schema) = &agent.output_schema {
                let mut nodes = 0;
                validate_schema_node_errors(
                    schema,
                    0,
                    &format!("$.steps.{}", step.id),
                    &mut nodes,
                    errors,
                );
            }
        }
        WorkflowStepSpec::Approval(approval) => {
            if approval.title.trim().is_empty() || approval.approver_scope.trim().is_empty() {
                errors.push(format!(
                    "approval step `{}` requires title and approverScope",
                    step.id
                ));
            }
            let mut nodes = 0;
            validate_schema_node_errors(
                &approval.decision_schema,
                0,
                &format!("$.steps.{}.decisionSchema", step.id),
                &mut nodes,
                errors,
            );
        }
        WorkflowStepSpec::Notify(notify) => {
            if notify.title.len() > 200 {
                errors.push(format!(
                    "notify step `{}` title exceeds supported size",
                    step.id
                ));
            }
        }
        WorkflowStepSpec::Session(session) => {
            if session.agent_id.trim().is_empty() {
                errors.push(format!(
                    "session step `{}` requires non-empty agentId",
                    step.id
                ));
            } else if session.agent_id.len() > 200 {
                errors.push(format!(
                    "session step `{}` agentId exceeds 200 bytes",
                    step.id
                ));
            }
            if session.prompt_template.trim().is_empty() {
                errors.push(format!(
                    "session step `{}` requires non-empty promptTemplate",
                    step.id
                ));
            } else if session.prompt_template.len() > MAX_STEP_PROMPT_BYTES {
                errors.push(format!(
                    "session step `{}` promptTemplate exceeds supported size",
                    step.id
                ));
            }
            if session
                .model_override
                .as_ref()
                .is_some_and(|model| model.trim().is_empty() || model.len() > 200)
            {
                errors.push(format!(
                    "session step `{}` modelOverride must contain 1..=200 non-whitespace bytes",
                    step.id
                ));
            }
            if let Some(schema) = &session.output_schema {
                let mut nodes = 0;
                validate_schema_node_errors(
                    schema,
                    0,
                    &format!("$.steps.{}.outputSchema", step.id),
                    &mut nodes,
                    errors,
                );
            }
        }
        WorkflowStepSpec::Bot(bot) => {
            if bot.member_id.trim().is_empty() {
                errors.push(format!(
                    "bot step `{}` requires non-empty memberId",
                    step.id
                ));
            } else if bot.member_id.len() > 200 {
                errors.push(format!("bot step `{}` memberId exceeds 200 bytes", step.id));
            }
            if bot.prompt_template.trim().is_empty() {
                errors.push(format!(
                    "bot step `{}` requires non-empty promptTemplate",
                    step.id
                ));
            } else if bot.prompt_template.len() > MAX_STEP_PROMPT_BYTES {
                errors.push(format!(
                    "bot step `{}` promptTemplate exceeds supported size",
                    step.id
                ));
            }
            if let Some(schema) = &bot.output_schema {
                let mut nodes = 0;
                validate_schema_node_errors(
                    schema,
                    0,
                    &format!("$.steps.{}.outputSchema", step.id),
                    &mut nodes,
                    errors,
                );
            }
        }
        WorkflowStepSpec::GroupStage(group) => {
            if group.space_id.trim().is_empty() {
                errors.push(format!(
                    "group_stage step `{}` requires non-empty spaceId",
                    step.id
                ));
            } else if group.space_id.len() > 200 {
                errors.push(format!(
                    "group_stage step `{}` spaceId exceeds 200 bytes",
                    step.id
                ));
            }
            if group.message_template.trim().is_empty() {
                errors.push(format!(
                    "group_stage step `{}` requires non-empty messageTemplate",
                    step.id
                ));
            } else if group.message_template.len() > MAX_STEP_PROMPT_BYTES {
                errors.push(format!(
                    "group_stage step `{}` messageTemplate exceeds supported size",
                    step.id
                ));
            }
            match &group.dispatch_mode {
                GroupDispatchMode::SpecificSeat { member_id } => {
                    if member_id.trim().is_empty() || member_id.len() > 200 {
                        errors.push(format!(
                            "group_stage step `{}` specific_seat requires a valid memberId",
                            step.id
                        ));
                    }
                }
                GroupDispatchMode::MentionSeats { member_id_list, .. } => {
                    if member_id_list.is_empty() {
                        errors.push(format!(
                            "group_stage step `{}` mention_seats requires non-empty memberIdList",
                            step.id
                        ));
                    }
                    for (idx, member_id) in member_id_list.iter().enumerate() {
                        if member_id.trim().is_empty() || member_id.len() > 200 {
                            errors.push(format!(
                                "group_stage step `{}` memberIdList[{idx}] must be 1..=200 non-empty bytes",
                                step.id
                            ));
                        }
                    }
                    if let Some(quorum) = group.quorum_count
                        && (quorum as usize) > member_id_list.len()
                    {
                        errors.push(format!(
                            "group_stage step `{}` quorumCount `{quorum}` exceeds mentioned seat count {}",
                            step.id,
                            member_id_list.len()
                        ));
                    }
                }
                GroupDispatchMode::ModeratorTriage {
                    moderator_member_id,
                } => {
                    if moderator_member_id.trim().is_empty() || moderator_member_id.len() > 200 {
                        errors.push(format!(
                            "group_stage step `{}` moderator_triage requires a valid moderatorMemberId",
                            step.id
                        ));
                    }
                }
                GroupDispatchMode::BroadcastLogOnly => {
                    if group.quorum_count.is_some() {
                        errors.push(format!(
                            "group_stage step `{}` broadcast_log_only cannot specify quorumCount",
                            step.id
                        ));
                    }
                }
            }
            if let Some(quorum) = group.quorum_count
                && !(1..=100).contains(&quorum)
            {
                errors.push(format!(
                    "group_stage step `{}` quorumCount `{quorum}` must be within 1..=100",
                    step.id
                ));
            }
        }
        WorkflowStepSpec::UserGate(gate) => {
            if gate.title_template.trim().is_empty() {
                errors.push(format!(
                    "user_gate step `{}` requires non-empty titleTemplate",
                    step.id
                ));
            } else if gate.title_template.len() > 200 {
                errors.push(format!(
                    "user_gate step `{}` titleTemplate exceeds 200 bytes",
                    step.id
                ));
            }
            if gate.body_template.len() > MAX_STEP_PROMPT_BYTES {
                errors.push(format!(
                    "user_gate step `{}` bodyTemplate exceeds supported size",
                    step.id
                ));
            }
            match gate.interaction_kind {
                UserInteractionKind::Approval => {
                    if gate.approval_options.is_empty() {
                        errors.push(format!(
                            "user_gate step `{}` with approval interaction requires non-empty approvalOptions",
                            step.id
                        ));
                    }
                    let mut option_ids = BTreeSet::new();
                    for (idx, option) in gate.approval_options.iter().enumerate() {
                        if option.id.trim().is_empty() || !option_ids.insert(option.id.as_str()) {
                            errors.push(format!(
                                "user_gate step `{}` approvalOptions[{idx}] has invalid or duplicate id `{}`",
                                step.id, option.id
                            ));
                        }
                        if option.label.trim().is_empty() {
                            errors.push(format!(
                                "user_gate step `{}` approvalOptions[{idx}] requires non-empty label",
                                step.id
                            ));
                        }
                    }
                }
                UserInteractionKind::AskForm => {
                    if gate.form_schema.is_none() {
                        errors.push(format!(
                            "user_gate step `{}` with ask_form interaction requires formSchema",
                            step.id
                        ));
                    }
                }
                UserInteractionKind::Notify | UserInteractionKind::Digest => {}
            }
            if let Some(schema) = &gate.form_schema {
                let mut nodes = 0;
                validate_schema_node_errors(
                    schema,
                    0,
                    &format!("$.steps.{}.formSchema", step.id),
                    &mut nodes,
                    errors,
                );
            }
            if let Some(timeout) = gate.sla_timeout_seconds
                && !(1..=MAX_WAIT_FOR_EVENT_TIMEOUT_SECONDS).contains(&timeout)
            {
                errors.push(format!(
                    "user_gate step `{}` slaTimeoutSeconds `{timeout}` must be within 1..={MAX_WAIT_FOR_EVENT_TIMEOUT_SECONDS}",
                    step.id
                ));
            }
        }
        WorkflowStepSpec::ConditionBranch(branch) => {
            validate_gate_filter_ast(
                &branch.filter,
                &format!("$.steps.{}.filter", step.id),
                errors,
            );
            if branch.then_step_ids.is_empty() && branch.else_step_ids.is_empty() {
                errors.push(format!(
                    "condition_branch step `{}` requires at least one target in thenStepIds or elseStepIds",
                    step.id
                ));
            }
            let then_set = branch
                .then_step_ids
                .iter()
                .map(String::as_str)
                .collect::<BTreeSet<_>>();
            for else_id in &branch.else_step_ids {
                if then_set.contains(else_id.as_str()) {
                    errors.push(format!(
                        "condition_branch step `{}` target `{else_id}` cannot appear in both thenStepIds and elseStepIds",
                        step.id
                    ));
                }
            }
        }
        WorkflowStepSpec::BoundedLoop(bounded) => {
            if bounded.max_iterations == 0 || bounded.max_iterations > MAX_BOUNDED_LOOP_ITERATIONS {
                errors.push(format!(
                    "bounded_loop step `{}` maxIterations `{}` must be within 1..={MAX_BOUNDED_LOOP_ITERATIONS}",
                    step.id, bounded.max_iterations
                ));
            }
            if bounded.target_step_ids.is_empty() {
                errors.push(format!(
                    "bounded_loop step `{}` requires non-empty targetStepIds",
                    step.id
                ));
            }
            if let Some(condition) = &bounded.until_condition {
                validate_gate_condition(
                    condition,
                    &format!("$.steps.{}.untilCondition", step.id),
                    errors,
                );
            }
        }
        WorkflowStepSpec::WaitForEvent(wait) => {
            if wait.event_types.is_empty() {
                errors.push(format!(
                    "wait_for_event step `{}` requires non-empty eventTypes",
                    step.id
                ));
            }
            for (idx, event_type) in wait.event_types.iter().enumerate() {
                if event_type.trim().is_empty() || event_type.len() > 200 {
                    errors.push(format!(
                        "wait_for_event step `{}` eventTypes[{idx}] must contain 1..=200 non-empty bytes",
                        step.id
                    ));
                }
            }
            if let Some(pointer) = &wait.thread_key_pointer
                && (pointer.trim().is_empty() || !pointer.starts_with('/') || pointer == "/")
            {
                errors.push(format!(
                    "wait_for_event step `{}` threadKeyPointer `{pointer}` must start with / and name a non-root field",
                    step.id
                ));
            }
            if let Some(filter) = &wait.filter {
                validate_gate_filter_ast(filter, &format!("$.steps.{}.filter", step.id), errors);
            }
            if let Some(timeout) = wait.timeout_seconds
                && !(1..=MAX_WAIT_FOR_EVENT_TIMEOUT_SECONDS).contains(&timeout)
            {
                errors.push(format!(
                    "wait_for_event step `{}` timeoutSeconds `{timeout}` must be within 1..={MAX_WAIT_FOR_EVENT_TIMEOUT_SECONDS}",
                    step.id
                ));
            }
        }
        WorkflowStepSpec::OutboxAction(outbox) => {
            if outbox.target_template.trim().is_empty() {
                errors.push(format!(
                    "outbox_action step `{}` requires non-empty targetTemplate",
                    step.id
                ));
            } else if outbox.target_template.len() > 2_048 {
                errors.push(format!(
                    "outbox_action step `{}` targetTemplate exceeds 2048 bytes",
                    step.id
                ));
            }
            match serde_json::to_vec(&outbox.payload_template) {
                Ok(bytes) => {
                    if bytes.len() > MAX_STEP_PROMPT_BYTES {
                        errors.push(format!(
                            "outbox_action step `{}` payloadTemplate exceeds supported size",
                            step.id
                        ));
                    }
                }
                Err(err) => {
                    errors.push(format!(
                        "outbox_action step `{}` payloadTemplate serialization error: {err}",
                        step.id
                    ));
                }
            }
        }
    }
}

fn validate_step_cross_references(
    step: &WorkflowStep,
    by_id: &BTreeMap<&str, &WorkflowStep>,
    definition: &WorkflowDefinition,
    errors: &mut Vec<String>,
) {
    for dependency in &step.depends_on {
        if dependency == &step.id || !by_id.contains_key(dependency.as_str()) {
            errors.push(format!(
                "step `{}` has invalid dependency `{dependency}`",
                step.id
            ));
        }
    }
    match &step.spec {
        WorkflowStepSpec::ConditionBranch(branch) => {
            for target_id in branch.then_step_ids.iter().chain(&branch.else_step_ids) {
                if target_id == &step.id || !by_id.contains_key(target_id.as_str()) {
                    errors.push(format!(
                        "condition_branch step `{}` references invalid target step `{target_id}`",
                        step.id
                    ));
                }
            }
        }
        WorkflowStepSpec::BoundedLoop(bounded) => {
            for target_id in &bounded.target_step_ids {
                if target_id == &step.id || !by_id.contains_key(target_id.as_str()) {
                    errors.push(format!(
                        "bounded_loop step `{}` references invalid target step `{target_id}`",
                        step.id
                    ));
                }
            }
        }
        _ => {}
    }
    for binding in step.input_bindings.values() {
        match binding {
            WorkflowBinding::RunInput { pointer } => {
                if let Err(err) = validate_pointer(pointer) {
                    errors.push(err.to_string());
                }
            }
            WorkflowBinding::StepOutput { step_id, pointer } => {
                if let Err(err) = validate_pointer(pointer) {
                    errors.push(err.to_string());
                }
                if !by_id.contains_key(step_id.as_str()) {
                    errors.push(format!(
                        "step `{}` binding references unknown step `{step_id}`",
                        step.id
                    ));
                } else if by_id.contains_key(step.id.as_str())
                    && !is_transitive_dependency(definition, by_id, &step.id, step_id)
                {
                    errors.push(format!(
                        "step `{}` reads `{step_id}` without depending on it",
                        step.id
                    ));
                }
            }
        }
    }
}

/// Returns true if the edge `dependency -> step.id` is an authorized back-edge
/// emitted from a `BoundedLoop` step back to one of its `target_step_ids`.
pub(crate) fn is_bounded_loop_back_edge(
    definition: &WorkflowDefinition,
    step_id: &str,
    dependency: &str,
) -> bool {
    let Some(dep_step) = definition.steps.iter().find(|s| s.id == dependency) else {
        return false;
    };
    let WorkflowStepSpec::BoundedLoop(bounded) = &dep_step.spec else {
        return false;
    };
    if !bounded
        .target_step_ids
        .iter()
        .any(|target| target == step_id)
    {
        return false;
    }
    // `dependency` is a BoundedLoop targeting `step_id`. Treat `dependency -> step_id`
    // as a loop back-edge whenever `dependency` also depends (directly or transitively,
    // without using `dependency -> step_id`) on `step_id`.
    let mut pending = dep_step
        .depends_on
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    let mut visited = BTreeSet::new();
    while let Some(current) = pending.pop() {
        if current == step_id {
            return true;
        }
        if visited.insert(current)
            && let Some(node) = definition.steps.iter().find(|s| s.id == current)
        {
            for next in &node.depends_on {
                if !(current == step_id && next == dependency) {
                    pending.push(next.as_str());
                }
            }
        }
    }
    false
}

/// Computes the forward DAG dependencies of `step`, including implicit edges from
/// `ConditionBranch` parents and stripping authorized `BoundedLoop` back-edges.
pub(crate) fn effective_forward_dependencies(
    definition: &WorkflowDefinition,
    step: &WorkflowStep,
) -> Vec<String> {
    let mut deps = BTreeSet::new();
    for dep in &step.depends_on {
        if !is_bounded_loop_back_edge(definition, &step.id, dep) {
            deps.insert(dep.clone());
        }
    }
    for candidate in &definition.steps {
        if candidate.id == step.id {
            continue;
        }
        if let WorkflowStepSpec::ConditionBranch(branch) = &candidate.spec
            && (branch.then_step_ids.iter().any(|id| id == &step.id)
                || branch.else_step_ids.iter().any(|id| id == &step.id))
            && !is_bounded_loop_back_edge(definition, &step.id, &candidate.id)
        {
            deps.insert(candidate.id.clone());
        }
    }
    deps.into_iter().collect()
}

fn deterministic_order_for_known_steps(
    definition: &WorkflowDefinition,
    by_id: &BTreeMap<&str, &WorkflowStep>,
) -> Result<Vec<String>, String> {
    let mut incoming = BTreeMap::<String, usize>::new();
    let mut outgoing = BTreeMap::<String, Vec<String>>::new();
    for (&id, &step) in by_id {
        let valid_deps = effective_forward_dependencies(definition, step)
            .into_iter()
            .filter(|dep| dep != id && by_id.contains_key(dep.as_str()))
            .collect::<Vec<_>>();
        incoming.insert(id.to_string(), valid_deps.len());
        for dependency in valid_deps {
            outgoing.entry(dependency).or_default().push(id.to_string());
        }
    }
    for children in outgoing.values_mut() {
        children.sort();
        children.dedup();
    }
    let mut ready = incoming
        .iter()
        .filter_map(|(id, count)| (*count == 0).then_some(id.clone()))
        .collect::<VecDeque<_>>();
    let mut order = Vec::with_capacity(by_id.len());
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
    if order.len() != by_id.len() {
        return Err("workflow dependency graph contains a cycle outside BoundedLoop".to_string());
    }
    Ok(order)
}

pub(crate) fn deterministic_order(
    definition: &WorkflowDefinition,
) -> Result<Vec<String>, WorkflowError> {
    let by_id = definition
        .steps
        .iter()
        .map(|step| (step.id.as_str(), step))
        .collect::<BTreeMap<_, _>>();
    deterministic_order_for_known_steps(definition, &by_id).map_err(WorkflowError::Validation)
}

pub fn validate_json_schema(schema: &serde_json::Value) -> Result<(), WorkflowError> {
    let mut nodes = 0;
    let mut errors = Vec::new();
    validate_schema_node_errors(schema, 0, "$", &mut nodes, &mut errors);
    if errors.is_empty() {
        Ok(())
    } else {
        Err(WorkflowError::Validation(errors.join("; ")))
    }
}

pub fn validate_json_value(
    schema: &serde_json::Value,
    value: &serde_json::Value,
) -> Result<(), WorkflowError> {
    let errors = validate_json_value_errors(schema, value);
    if errors.is_empty() {
        Ok(())
    } else {
        Err(WorkflowError::Validation(errors.join("; ")))
    }
}

/// Exhaustively validates `value` against `schema` in a single pass without failing
/// fast on the first violation. Returns all collected schema and value errors.
pub fn validate_json_value_errors(
    schema: &serde_json::Value,
    value: &serde_json::Value,
) -> Vec<String> {
    let mut nodes = 0;
    let mut errors = Vec::new();
    validate_schema_node_errors(schema, 0, "$", &mut nodes, &mut errors);
    if !errors.is_empty() {
        return errors;
    }
    collect_value_node_errors(schema, value, "$", &mut errors);
    errors
}

fn collect_value_node_errors(
    schema: &serde_json::Value,
    value: &serde_json::Value,
    path: &str,
    errors: &mut Vec<String>,
) {
    let object = schema.as_object().expect("schema validated above");
    if let Some(allowed) = object.get("enum").and_then(serde_json::Value::as_array)
        && !allowed.contains(value)
    {
        errors.push(format!("value at {path} is outside enum"));
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
        let expected = object
            .get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("unknown");
        errors.push(format!(
            "value at {path} does not match expected schema type `{expected}`"
        ));
    }
    if let Some(text) = value.as_str() {
        let length = text.chars().count() as u64;
        if let Some(minimum) = object.get("minLength").and_then(serde_json::Value::as_u64)
            && length < minimum
        {
            errors.push(format!(
                "string length {length} at {path} is below minLength {minimum}"
            ));
        }
        if let Some(maximum) = object.get("maxLength").and_then(serde_json::Value::as_u64)
            && length > maximum
        {
            errors.push(format!(
                "string length {length} at {path} exceeds maxLength {maximum}"
            ));
        }
    }
    if let Some(number) = value.as_f64() {
        if let Some(minimum) = object.get("minimum").and_then(serde_json::Value::as_f64)
            && number < minimum
        {
            errors.push(format!(
                "number {number} at {path} is below minimum {minimum}"
            ));
        }
        if let Some(maximum) = object.get("maximum").and_then(serde_json::Value::as_f64)
            && number > maximum
        {
            errors.push(format!(
                "number {number} at {path} exceeds maximum {maximum}"
            ));
        }
    }
    if let Some(values) = value.as_array() {
        let length = values.len() as u64;
        if let Some(minimum) = object.get("minItems").and_then(serde_json::Value::as_u64)
            && length < minimum
        {
            errors.push(format!(
                "array length {length} at {path} is below minItems {minimum}"
            ));
        }
        if let Some(maximum) = object.get("maxItems").and_then(serde_json::Value::as_u64)
            && length > maximum
        {
            errors.push(format!(
                "array length {length} at {path} exceeds maxItems {maximum}"
            ));
        }
        if let Some(items) = object.get("items") {
            for (index, item) in values.iter().enumerate() {
                collect_value_node_errors(items, item, &format!("{path}/{index}"), errors);
            }
        }
    }
    if let Some(value_object) = value.as_object() {
        if let Some(required) = object.get("required").and_then(serde_json::Value::as_array) {
            for field in required.iter().filter_map(serde_json::Value::as_str) {
                if !value_object.contains_key(field) {
                    errors.push(format!("required property `{field}` is missing at {path}"));
                }
            }
        }
        if let Some(properties) = object
            .get("properties")
            .and_then(serde_json::Value::as_object)
        {
            for (field, child_schema) in properties {
                if let Some(child_value) = value_object.get(field) {
                    collect_value_node_errors(
                        child_schema,
                        child_value,
                        &format!("{path}/{field}"),
                        errors,
                    );
                }
            }
            if object.get("additionalProperties") == Some(&serde_json::Value::Bool(false)) {
                for field in value_object.keys() {
                    if !properties.contains_key(field) {
                        errors.push(format!(
                            "additional property `{field}` is not allowed at {path}"
                        ));
                    }
                }
            }
        } else if object.get("additionalProperties") == Some(&serde_json::Value::Bool(false)) {
            for field in value_object.keys() {
                errors.push(format!(
                    "additional property `{field}` is not allowed at {path}"
                ));
            }
        }
    }
}

fn validate_schema_node_errors(
    schema: &serde_json::Value,
    depth: usize,
    path: &str,
    nodes: &mut usize,
    errors: &mut Vec<String>,
) {
    *nodes += 1;
    if *nodes > MAX_SCHEMA_NODES {
        if *nodes == MAX_SCHEMA_NODES + 1 {
            errors.push(format!("schema exceeds {MAX_SCHEMA_NODES} nodes at {path}"));
        }
        return;
    }
    if depth > MAX_SCHEMA_DEPTH {
        errors.push(format!(
            "schema exceeds {MAX_SCHEMA_DEPTH} levels at {path}"
        ));
        return;
    }
    let Some(object) = schema.as_object() else {
        errors.push(format!("schema node at {path} must be an object"));
        return;
    };
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
            errors.push(format!("unsupported schema keyword `{key}` at {path}"));
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
            errors.push(format!("unsupported schema type at {path}"));
        }
    }
    if let Some(values) = object.get("enum") {
        match values.as_array().filter(|values| !values.is_empty()) {
            Some(values) => {
                let mut unique = BTreeSet::new();
                for value in values {
                    match serde_json::to_string(value) {
                        Ok(normalized) => {
                            if !unique.insert(normalized) {
                                errors.push(format!("enum at {path} contains duplicate values"));
                            }
                        }
                        Err(err) => {
                            errors
                                .push(format!("enum value at {path} failed serialization: {err}"));
                        }
                    }
                }
            }
            None => errors.push(format!("enum at {path} must be a non-empty array")),
        }
    }
    if let Some(required) = object.get("required") {
        match required.as_array() {
            Some(required) => {
                let mut unique = BTreeSet::new();
                for field in required {
                    match field.as_str().filter(|field| !field.is_empty()) {
                        Some(field) => {
                            if !unique.insert(field) {
                                errors
                                    .push(format!("required at {path} contains duplicate fields"));
                            }
                        }
                        None => errors.push(format!(
                            "required entries at {path} must be non-empty strings"
                        )),
                    }
                }
            }
            None => errors.push(format!("required at {path} must be an array")),
        }
    }
    if object
        .get("additionalProperties")
        .is_some_and(|value| !value.is_boolean())
    {
        errors.push(format!("additionalProperties at {path} must be boolean"));
    }
    validate_unsigned_bounds_errors(object, "minLength", "maxLength", path, errors);
    validate_unsigned_bounds_errors(object, "minItems", "maxItems", path, errors);
    validate_number_bounds_errors(object, "minimum", "maximum", path, errors);
    if let Some(properties) = object.get("properties") {
        match properties.as_object() {
            Some(properties) => {
                for (name, child) in properties {
                    validate_schema_node_errors(
                        child,
                        depth + 1,
                        &format!("{path}.properties.{name}"),
                        nodes,
                        errors,
                    );
                }
            }
            None => errors.push(format!("properties at {path} must be an object")),
        }
    }
    if let Some(items) = object.get("items") {
        validate_schema_node_errors(items, depth + 1, &format!("{path}.items"), nodes, errors);
    }
}

fn validate_unsigned_bounds_errors(
    object: &serde_json::Map<String, serde_json::Value>,
    minimum_key: &str,
    maximum_key: &str,
    path: &str,
    errors: &mut Vec<String>,
) {
    let minimum = object.get(minimum_key).and_then(|value| {
        let parsed = value.as_u64();
        if parsed.is_none() {
            errors.push(format!("{minimum_key} at {path} must be unsigned"));
        }
        parsed
    });
    let maximum = object.get(maximum_key).and_then(|value| {
        let parsed = value.as_u64();
        if parsed.is_none() {
            errors.push(format!("{maximum_key} at {path} must be unsigned"));
        }
        parsed
    });
    if matches!((minimum, maximum), (Some(min), Some(max)) if min > max) {
        errors.push(format!("{minimum_key} exceeds {maximum_key} at {path}"));
    }
}

fn validate_number_bounds_errors(
    object: &serde_json::Map<String, serde_json::Value>,
    minimum_key: &str,
    maximum_key: &str,
    path: &str,
    errors: &mut Vec<String>,
) {
    let minimum = object.get(minimum_key).and_then(|value| {
        let parsed = value.as_f64();
        if parsed.is_none() {
            errors.push(format!("{minimum_key} at {path} must be a number"));
        }
        parsed
    });
    let maximum = object.get(maximum_key).and_then(|value| {
        let parsed = value.as_f64();
        if parsed.is_none() {
            errors.push(format!("{maximum_key} at {path} must be a number"));
        }
        parsed
    });
    if matches!((minimum, maximum), (Some(min), Some(max)) if min > max) {
        errors.push(format!("{minimum_key} exceeds {maximum_key} at {path}"));
    }
}

fn validate_policy_errors(policy: &WorkflowPolicy, errors: &mut Vec<String>) {
    if !(1..=64).contains(&policy.max_concurrent_agent_steps)
        || !(1..=10_000).contains(&policy.max_agent_calls)
        || !(1..=7 * 24 * 60 * 60).contains(&policy.deadline_seconds)
        || !(1_024..=64 * 1024 * 1024).contains(&policy.max_output_bytes)
    {
        errors.push("workflow policy exceeds supported hard limits".to_string());
    }
}

pub fn validate_policy(policy: &WorkflowPolicy) -> Result<(), WorkflowError> {
    let mut errors = Vec::new();
    validate_policy_errors(policy, &mut errors);
    if errors.is_empty() {
        Ok(())
    } else {
        Err(WorkflowError::Validation(errors.join("; ")))
    }
}

pub(crate) fn valid_step_id(id: &str) -> bool {
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
    definition: &WorkflowDefinition,
    by_id: &BTreeMap<&str, &WorkflowStep>,
    target: &str,
    possible_dependency: &str,
) -> bool {
    let Some(&target_step) = by_id.get(target) else {
        return false;
    };
    let mut pending = effective_forward_dependencies(definition, target_step);
    let mut visited = BTreeSet::new();
    while let Some(id) = pending.pop() {
        if id == possible_dependency {
            return true;
        }
        if visited.insert(id.clone())
            && let Some(&node) = by_id.get(id.as_str())
        {
            pending.extend(effective_forward_dependencies(definition, node));
        }
    }
    false
}
