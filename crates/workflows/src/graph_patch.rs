use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    WorkflowDefinition, WorkflowPolicy, WorkflowStep, WorkflowStepSpec,
    spec::{normalize_definition_in_place, validate_definition_errors},
};

/// Declarative atomic operation in a `WorkflowGraphPatch`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "op", rename_all = "snake_case")]
#[ts(export)]
pub enum WorkflowGraphPatchOp {
    #[serde(rename_all = "camelCase")]
    AddStep { step: WorkflowStep },
    #[serde(rename_all = "camelCase")]
    UpdateStep { step: WorkflowStep },
    #[serde(rename_all = "camelCase")]
    RemoveStep { step_id: String },
    #[serde(rename_all = "camelCase")]
    ConnectSteps {
        from_step_id: String,
        to_step_id: String,
    },
    #[serde(rename_all = "camelCase")]
    DisconnectSteps {
        from_step_id: String,
        to_step_id: String,
    },
    #[serde(rename_all = "camelCase")]
    SetPolicy { policy: WorkflowPolicy },
}

/// Declarative patch envelope for safe AI/UI mutation of a `WorkflowDefinition`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct WorkflowGraphPatch {
    pub ops: Vec<WorkflowGraphPatchOp>,
}

impl WorkflowGraphPatch {
    pub fn new(ops: Vec<WorkflowGraphPatchOp>) -> Self {
        Self { ops }
    }

    pub fn apply(
        &self,
        definition: &WorkflowDefinition,
    ) -> Result<WorkflowDefinition, Vec<String>> {
        apply_workflow_graph_patch(definition, &self.ops)
    }
}

/// Applies a sequence of declarative graph patch operations to `definition` and runs
/// exhaustive No-Fail-Fast validation on the resulting workflow graph.
///
/// Returns `Err(errors)` containing **all** patch application and structural/schema
/// validation errors if anything is invalid.
pub fn apply_workflow_graph_patch(
    definition: &WorkflowDefinition,
    ops: &[WorkflowGraphPatchOp],
) -> Result<WorkflowDefinition, Vec<String>> {
    let mut working = definition.clone();
    let mut errors = Vec::new();

    for (index, op) in ops.iter().enumerate() {
        match op {
            WorkflowGraphPatchOp::AddStep { step } => {
                let id = step.id.trim();
                if working
                    .steps
                    .iter()
                    .any(|existing| existing.id.trim() == id)
                {
                    errors.push(format!("ops[{index}] add_step: step `{id}` already exists"));
                } else {
                    working.steps.push(step.clone());
                }
            }
            WorkflowGraphPatchOp::UpdateStep { step } => {
                let id = step.id.trim();
                if let Some(existing) = working
                    .steps
                    .iter_mut()
                    .find(|existing| existing.id.trim() == id)
                {
                    *existing = step.clone();
                } else {
                    errors.push(format!(
                        "ops[{index}] update_step: step `{id}` does not exist"
                    ));
                }
            }
            WorkflowGraphPatchOp::RemoveStep { step_id } => {
                let id = step_id.trim();
                if let Some(pos) = working
                    .steps
                    .iter()
                    .position(|existing| existing.id.trim() == id)
                {
                    working.steps.remove(pos);
                    for remaining in &mut working.steps {
                        remaining.depends_on.retain(|dep| dep.trim() != id);
                        if let WorkflowStepSpec::ConditionBranch(branch) = &mut remaining.spec {
                            branch.then_step_ids.retain(|target| target.trim() != id);
                            branch.else_step_ids.retain(|target| target.trim() != id);
                        }
                    }
                } else {
                    errors.push(format!(
                        "ops[{index}] remove_step: step `{id}` does not exist"
                    ));
                }
            }
            WorkflowGraphPatchOp::ConnectSteps {
                from_step_id,
                to_step_id,
            } => {
                let from = from_step_id.trim();
                let to = to_step_id.trim();
                if from == to {
                    errors.push(format!(
                        "ops[{index}] connect_steps: cannot connect step `{from}` to itself"
                    ));
                    continue;
                }
                let from_exists = working.steps.iter().any(|s| s.id.trim() == from);
                let to_exists = working.steps.iter().any(|s| s.id.trim() == to);
                if !from_exists {
                    errors.push(format!(
                        "ops[{index}] connect_steps: source step `{from}` does not exist"
                    ));
                }
                if !to_exists {
                    errors.push(format!(
                        "ops[{index}] connect_steps: target step `{to}` does not exist"
                    ));
                }
                if from_exists
                    && to_exists
                    && let Some(target) = working.steps.iter_mut().find(|s| s.id.trim() == to)
                    && !target.depends_on.iter().any(|dep| dep.trim() == from)
                {
                    target.depends_on.push(from.to_string());
                }
            }
            WorkflowGraphPatchOp::DisconnectSteps {
                from_step_id,
                to_step_id,
            } => {
                let from = from_step_id.trim();
                let to = to_step_id.trim();
                let from_exists = working.steps.iter().any(|s| s.id.trim() == from);
                let to_exists = working.steps.iter().any(|s| s.id.trim() == to);
                if !from_exists {
                    errors.push(format!(
                        "ops[{index}] disconnect_steps: source step `{from}` does not exist"
                    ));
                }
                if !to_exists {
                    errors.push(format!(
                        "ops[{index}] disconnect_steps: target step `{to}` does not exist"
                    ));
                }
                if from_exists && to_exists {
                    let mut removed = false;
                    if let Some(target) = working.steps.iter_mut().find(|s| s.id.trim() == to) {
                        let before = target.depends_on.len();
                        target.depends_on.retain(|dep| dep.trim() != from);
                        removed |= target.depends_on.len() != before;
                    }
                    if let Some(source) = working.steps.iter_mut().find(|s| s.id.trim() == from)
                        && let WorkflowStepSpec::ConditionBranch(branch) = &mut source.spec
                    {
                        let before_then = branch.then_step_ids.len();
                        let before_else = branch.else_step_ids.len();
                        branch.then_step_ids.retain(|id| id.trim() != to);
                        branch.else_step_ids.retain(|id| id.trim() != to);
                        removed |= branch.then_step_ids.len() != before_then
                            || branch.else_step_ids.len() != before_else;
                    }
                    if !removed {
                        errors.push(format!(
                            "ops[{index}] disconnect_steps: edge `{from}` -> `{to}` does not exist"
                        ));
                    }
                }
            }
            WorkflowGraphPatchOp::SetPolicy { policy } => {
                working.policy = policy.clone();
            }
        }
    }

    normalize_definition_in_place(&mut working);
    errors.extend(validate_definition_errors(&working));

    if errors.is_empty() {
        Ok(working)
    } else {
        Err(errors)
    }
}
