use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};
use ts_rs::TS;
use uuid::Uuid;

use crate::{
    DebugRunScope, EventEnvelope, UserInteractionKind, WaitingWorkflowStep, WorkflowDefinition,
    WorkflowDefinitionSummary, WorkflowGraphPatchOp, WorkflowPolicy, WorkflowRunView,
    WorkflowStepSpec, WorkflowStore, WorkflowVersionView, apply_workflow_graph_patch,
    match_waiting_step, normalize_definition,
    spec::{MAX_WORKFLOW_INPUT_BYTES, validate_definition_errors},
    store::{PersistDerivedWorkflowRun, PersistWorkflowRun},
    validate_json_value,
};

#[derive(Debug, thiserror::Error)]
pub enum WorkflowError {
    #[error("validation failed: {0}")]
    Validation(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("workflow projection error: {0}")]
    Projection(String),
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
}

#[derive(Debug, Clone)]
pub struct PublishWorkflow {
    pub definition_id: Option<Uuid>,
    pub definition: WorkflowDefinition,
    pub source_path: Option<String>,
    pub operation_id: Uuid,
    pub principal: serde_json::Value,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct WorkflowValidationView {
    pub normalized: WorkflowDefinition,
    pub digest: String,
}

#[derive(Debug, Clone)]
pub struct StartWorkflow {
    pub definition_version_id: Uuid,
    pub workspace_id: Uuid,
    pub input: serde_json::Value,
    pub policy_override: Option<WorkflowPolicy>,
    pub debug_step_id: Option<String>,
    pub operation_id: Uuid,
    pub principal: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct CompleteWorkflowStep {
    pub run_id: Uuid,
    pub step_id: String,
    pub output: Option<serde_json::Value>,
}

#[derive(Debug, Clone)]
pub struct StageWorkflowStepCandidate {
    pub run_id: Uuid,
    pub step_id: String,
    pub output: Option<serde_json::Value>,
}

#[derive(Debug, Clone)]
pub struct AcceptWorkflowStepCandidate {
    pub run_id: Uuid,
    pub step_id: String,
    pub operation_id: Uuid,
    pub principal: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct PauseWorkflowRun {
    pub run_id: Uuid,
    pub reason: Option<String>,
    pub operation_id: Uuid,
    pub principal: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct ResumePausedWorkflowRun {
    pub run_id: Uuid,
    pub operation_id: Uuid,
    pub principal: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct ForkWorkflowRun {
    pub parent_run_id: Uuid,
    pub definition_version_id: Uuid,
    pub step_id: String,
    pub scope: DebugRunScope,
    pub operation_id: Uuid,
    pub principal: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct DecideApproval {
    pub run_id: Uuid,
    pub step_id: String,
    pub decision: serde_json::Value,
    pub operation_id: Uuid,
    pub principal: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct DecideUserGate {
    pub run_id: Uuid,
    pub step_id: String,
    pub selected_option_id: Option<String>,
    pub note: Option<String>,
    pub form_data: Option<serde_json::Value>,
    pub operation_id: Uuid,
    pub principal: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct ResumeWaitingWorkflowStep {
    pub run_id: Uuid,
    pub step_id: String,
    pub event: EventEnvelope,
    pub operation_id: Uuid,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum WorkflowReviewDecision {
    Retry {
        step_id: String,
    },
    Accept {
        step_id: String,
        output: Option<serde_json::Value>,
    },
    Skip {
        step_id: String,
    },
    Cancel {
        reason: Option<String>,
    },
}

#[derive(Debug, Clone)]
pub struct ReviewWorkflow {
    pub run_id: Uuid,
    pub decision: WorkflowReviewDecision,
    pub operation_id: Uuid,
    pub principal: serde_json::Value,
}

fn debug_execution_steps(
    definition: &WorkflowDefinition,
    target_step_id: &str,
) -> Result<BTreeSet<String>, WorkflowError> {
    let target = definition
        .steps
        .iter()
        .find(|step| step.id == target_step_id)
        .ok_or_else(|| WorkflowError::NotFound(format!("workflow step {target_step_id}")))?;
    if !target.spec.is_executable_step() {
        return Err(WorkflowError::Conflict(
            "debug Runs can only start from an Agent step".to_string(),
        ));
    }

    let mut execute = BTreeSet::from([target_step_id.to_string()]);
    let mut pending = target.depends_on.clone();
    while let Some(step_id) = pending.pop() {
        if !execute.insert(step_id.clone()) {
            continue;
        }
        let step = definition
            .steps
            .iter()
            .find(|step| step.id == step_id)
            .ok_or_else(|| WorkflowError::NotFound(format!("workflow step {step_id}")))?;
        pending.extend(step.depends_on.iter().cloned());
    }
    Ok(execute)
}

#[derive(Clone)]
pub struct WorkflowCore {
    pub(crate) store: WorkflowStore,
}

impl WorkflowCore {
    pub const fn new(store: WorkflowStore) -> Self {
        Self { store }
    }

    pub const fn store(&self) -> &WorkflowStore {
        &self.store
    }

    pub fn validate(
        &self,
        definition: WorkflowDefinition,
    ) -> Result<WorkflowValidationView, WorkflowError> {
        let normalized = normalize_definition(definition)?;
        let digest = digest_json(&normalized)?;
        Ok(WorkflowValidationView { normalized, digest })
    }

    /// Runs single-pass exhaustive No-Fail-Fast validation and returns every error found.
    pub fn validate_exhaustive(&self, definition: &WorkflowDefinition) -> Vec<String> {
        validate_definition_errors(definition)
    }

    /// Applies declarative graph patch operations and returns a normalized, validated view
    /// or all validation/patch errors collected without fail-fast termination.
    pub fn apply_graph_patch(
        &self,
        definition: &WorkflowDefinition,
        ops: &[WorkflowGraphPatchOp],
    ) -> Result<WorkflowValidationView, Vec<String>> {
        let patched = apply_workflow_graph_patch(definition, ops)?;
        let digest = digest_json(&patched).map_err(|err| vec![err.to_string()])?;
        Ok(WorkflowValidationView {
            normalized: patched,
            digest,
        })
    }

    pub async fn publish(
        &self,
        input: PublishWorkflow,
    ) -> Result<WorkflowVersionView, WorkflowError> {
        let definition = normalize_definition(input.definition)?;
        if let Some(source_path) = input.source_path.as_deref() {
            validate_source_path(source_path)?;
        }
        let digest = digest_json(&definition)?;
        self.store
            .publish(
                input.definition_id,
                &definition,
                &digest,
                input.source_path.as_deref(),
                input.operation_id,
                &serde_json::to_string(&input.principal)?,
            )
            .await
    }

    pub async fn materialize_debug(
        &self,
        input: PublishWorkflow,
    ) -> Result<WorkflowVersionView, WorkflowError> {
        let definition = normalize_definition(input.definition)?;
        if let Some(source_path) = input.source_path.as_deref() {
            validate_source_path(source_path)?;
        }
        let digest = digest_json(&definition)?;
        self.store
            .materialize_debug(
                input.definition_id,
                &definition,
                &digest,
                input.source_path.as_deref(),
                input.operation_id,
                &serde_json::to_string(&input.principal)?,
            )
            .await
    }

    pub async fn definitions(
        &self,
        limit: u32,
    ) -> Result<Vec<WorkflowDefinitionSummary>, WorkflowError> {
        self.store.definitions(limit).await
    }

    pub async fn delete_definition(&self, definition_id: Uuid) -> Result<bool, WorkflowError> {
        self.store.delete_definition(definition_id).await
    }

    pub async fn versions(
        &self,
        definition_id: Uuid,
        limit: u32,
    ) -> Result<Vec<WorkflowVersionView>, WorkflowError> {
        self.store.versions(definition_id, limit).await
    }

    pub async fn runs(
        &self,
        definition_id: Uuid,
        limit: u32,
    ) -> Result<Vec<WorkflowRunView>, WorkflowError> {
        self.store.runs(definition_id, limit).await
    }

    pub async fn start(&self, input: StartWorkflow) -> Result<WorkflowRunView, WorkflowError> {
        let version = self.store.version(input.definition_version_id).await?;
        let definition = version.definition()?;
        if serde_json::to_vec(&input.input)?.len() > MAX_WORKFLOW_INPUT_BYTES {
            return Err(WorkflowError::Validation(format!(
                "workflow input exceeds {MAX_WORKFLOW_INPUT_BYTES} bytes"
            )));
        }
        if input.debug_step_id.is_none()
            && let Some(schema) = &definition.input_schema
        {
            validate_json_value(schema, &input.input)?;
        }
        let policy = input.policy_override.unwrap_or(definition.policy.clone());
        crate::spec::validate_policy(&policy)?;
        let debug_execution_steps = input
            .debug_step_id
            .as_deref()
            .map(|step_id| debug_execution_steps(&definition, step_id))
            .transpose()?;
        let payload_digest = digest_json(&serde_json::json!({
            "definitionVersionId": input.definition_version_id,
            "workspaceId": input.workspace_id,
            "input": &input.input,
            "policy": &policy,
            "debugStepId": &input.debug_step_id,
        }))?;
        let principal_json = serde_json::to_string(&input.principal)?;
        self.store
            .start(
                &version,
                PersistWorkflowRun {
                    workspace_id: input.workspace_id,
                    input: &input.input,
                    policy: &policy,
                    operation_id: input.operation_id,
                    payload_digest: &payload_digest,
                    principal_json: &principal_json,
                    debug_step_id: input.debug_step_id.as_deref(),
                    debug_execution_steps: debug_execution_steps.as_ref(),
                },
            )
            .await
    }

    pub async fn complete_step(
        &self,
        input: CompleteWorkflowStep,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let run = self.store.run(input.run_id).await?;
        let definition = self
            .store
            .version(run.definition_version_id)
            .await?
            .definition()?;
        let step = definition
            .steps
            .iter()
            .find(|step| step.id == input.step_id)
            .ok_or_else(|| WorkflowError::NotFound(format!("workflow step {}", input.step_id)))?;
        if !step.spec.is_executable_step() {
            return Err(WorkflowError::Conflict(
                "only agent steps complete through this path".to_string(),
            ));
        }
        let (output, schema_digest) = match input.output.as_ref() {
            Some(output) => {
                let digest =
                    validate_step_output_bytes(&run, step.spec.output_schema(), Some(output))?;
                (Some(output), digest)
            }
            None => (None, None),
        };
        self.store
            .complete_step(
                input.run_id,
                &input.step_id,
                output,
                schema_digest.as_deref(),
            )
            .await
    }

    pub async fn stage_step_candidate(
        &self,
        input: StageWorkflowStepCandidate,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let run = self.store.run(input.run_id).await?;
        let definition = self
            .store
            .version(run.definition_version_id)
            .await?
            .definition()?;
        let step = definition
            .steps
            .iter()
            .find(|step| step.id == input.step_id)
            .ok_or_else(|| WorkflowError::NotFound(format!("workflow step {}", input.step_id)))?;
        if !matches!(
            step.spec,
            WorkflowStepSpec::Agent(_) | WorkflowStepSpec::Session(_) | WorkflowStepSpec::Bot(_)
        ) {
            return Err(WorkflowError::Conflict(
                "only agent steps produce candidate outputs".to_string(),
            ));
        }
        let schema_digest =
            validate_step_output_bytes(&run, step.spec.output_schema(), input.output.as_ref())?;
        self.store
            .stage_step_candidate(
                input.run_id,
                &input.step_id,
                input.output.as_ref(),
                schema_digest.as_deref(),
            )
            .await
    }

    pub async fn accept_step_candidate(
        &self,
        input: AcceptWorkflowStepCandidate,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let payload_digest = digest_json(&serde_json::json!({
            "runId": input.run_id,
            "stepId": &input.step_id,
            "action": "accept_candidate",
        }))?;
        self.store
            .accept_step_candidate(
                input.run_id,
                &input.step_id,
                input.operation_id,
                &payload_digest,
                &serde_json::to_string(&input.principal)?,
            )
            .await
    }

    pub async fn request_pause(
        &self,
        input: PauseWorkflowRun,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let payload_digest = digest_json(&serde_json::json!({
            "runId": input.run_id,
            "reason": &input.reason,
            "action": "pause",
        }))?;
        self.store
            .request_pause(
                input.run_id,
                input.operation_id,
                input.reason.as_deref(),
                &payload_digest,
                &serde_json::to_string(&input.principal)?,
            )
            .await
    }

    pub async fn mark_paused(&self, run_id: Uuid) -> Result<WorkflowRunView, WorkflowError> {
        self.store.mark_paused(run_id).await
    }

    pub async fn resume_paused(
        &self,
        input: ResumePausedWorkflowRun,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let payload_digest = digest_json(&serde_json::json!({
            "runId": input.run_id,
            "action": "resume",
        }))?;
        self.store
            .resume_paused_run(
                input.run_id,
                input.operation_id,
                &payload_digest,
                &serde_json::to_string(&input.principal)?,
            )
            .await
    }

    pub async fn fork_from_step(
        &self,
        input: ForkWorkflowRun,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let parent = self.store.run(input.parent_run_id).await?;
        let parent_version = self.store.version(parent.definition_version_id).await?;
        let parent_definition = parent_version.definition()?;
        let version = self.store.version(input.definition_version_id).await?;
        let definition = version.definition()?;
        let target = definition
            .steps
            .iter()
            .find(|step| step.id == input.step_id)
            .ok_or_else(|| WorkflowError::NotFound(format!("workflow step {}", input.step_id)))?;
        if !target.spec.is_executable_step() {
            return Err(WorkflowError::Conflict(
                "debug Runs can only start from an Agent step".to_string(),
            ));
        }
        let mut execute = BTreeSet::from([input.step_id.clone()]);
        if input.scope == DebugRunScope::Downstream {
            loop {
                let previous = execute.len();
                for step in &definition.steps {
                    if step
                        .depends_on
                        .iter()
                        .any(|dependency| execute.contains(dependency))
                    {
                        execute.insert(step.id.clone());
                    }
                }
                if execute.len() == previous {
                    break;
                }
            }
        }
        let mut required_ancestors = BTreeSet::new();
        let mut pending = execute
            .iter()
            .filter_map(|id| definition.steps.iter().find(|step| &step.id == id))
            .flat_map(|step| step.depends_on.iter().cloned())
            .collect::<Vec<_>>();
        while let Some(step_id) = pending.pop() {
            if execute.contains(&step_id) || !required_ancestors.insert(step_id.clone()) {
                continue;
            }
            if let Some(step) = definition.steps.iter().find(|step| step.id == step_id) {
                pending.extend(step.depends_on.iter().cloned());
            }
        }
        let parent_steps = self.store.steps(parent.id).await?;
        let mut execution_modes = BTreeMap::new();
        for step in &definition.steps {
            if execute.contains(&step.id) {
                execution_modes.insert(step.id.clone(), "execute");
                continue;
            }
            if required_ancestors.contains(&step.id) {
                let old_step = parent_definition
                    .steps
                    .iter()
                    .find(|old| old.id == step.id)
                    .ok_or_else(|| {
                        WorkflowError::Conflict(format!(
                            "required ancestor `{}` does not exist in the parent definition",
                            step.id
                        ))
                    })?;
                if old_step != step {
                    return Err(WorkflowError::Conflict(format!(
                        "required ancestor `{}` changed and cannot be reused",
                        step.id
                    )));
                }
                let completed = parent_steps
                    .iter()
                    .filter(|run| run.step_id == step.id)
                    .max_by_key(|run| run.attempt)
                    .is_some_and(|run| run.status == "completed");
                if !completed {
                    return Err(WorkflowError::Conflict(format!(
                        "required ancestor `{}` has no completed parent result",
                        step.id
                    )));
                }
                execution_modes.insert(step.id.clone(), "reuse");
            } else {
                execution_modes.insert(step.id.clone(), "exclude");
            }
        }
        let payload_digest = digest_json(&serde_json::json!({
            "parentRunId": input.parent_run_id,
            "definitionVersionId": input.definition_version_id,
            "stepId": &input.step_id,
            "scope": input.scope,
        }))?;
        self.store
            .start_derived(
                &version,
                PersistDerivedWorkflowRun {
                    parent: &parent,
                    fork_step_id: &input.step_id,
                    scope: input.scope,
                    execution_modes: &execution_modes,
                    operation_id: input.operation_id,
                    payload_digest: &payload_digest,
                    principal_json: &serde_json::to_string(&input.principal)?,
                },
            )
            .await
    }

    pub async fn decide(&self, input: DecideApproval) -> Result<WorkflowRunView, WorkflowError> {
        let run = self.store.run(input.run_id).await?;
        let definition = self
            .store
            .version(run.definition_version_id)
            .await?
            .definition()?;
        let step = definition
            .steps
            .iter()
            .find(|step| step.id == input.step_id)
            .ok_or_else(|| WorkflowError::NotFound(format!("workflow step {}", input.step_id)))?;
        if let WorkflowStepSpec::UserGate(gate) = &step.spec {
            let selected_option_id = input
                .decision
                .get("selectedOptionId")
                .or_else(|| input.decision.get("selected_option_id"))
                .or_else(|| input.decision.get("optionId"))
                .or_else(|| input.decision.get("option_id"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    let approved = input.decision.get("approved")?.as_bool()?;
                    if approved {
                        gate.approval_options
                            .iter()
                            .find(|opt| {
                                matches!(
                                    opt.id.to_ascii_lowercase().as_str(),
                                    "approve" | "approved" | "yes" | "accept" | "confirm" | "allow"
                                )
                            })
                            .or_else(|| gate.approval_options.first())
                            .map(|opt| opt.id.clone())
                    } else {
                        gate.approval_options
                            .iter()
                            .find(|opt| {
                                matches!(
                                    opt.id.to_ascii_lowercase().as_str(),
                                    "reject"
                                        | "rejected"
                                        | "deny"
                                        | "denied"
                                        | "no"
                                        | "decline"
                                        | "cancel"
                                )
                            })
                            .or_else(|| gate.approval_options.get(1))
                            .or_else(|| gate.approval_options.last())
                            .map(|opt| opt.id.clone())
                    }
                });
            let note = input
                .decision
                .get("note")
                .or_else(|| input.decision.get("reason"))
                .or_else(|| input.decision.get("comment"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
            let form_data = input
                .decision
                .get("formData")
                .or_else(|| input.decision.get("form_data"))
                .or_else(|| input.decision.get("formValues"))
                .or_else(|| input.decision.get("form_values"))
                .cloned()
                .or_else(|| {
                    if gate.interaction_kind == UserInteractionKind::AskForm
                        && input.decision.is_object()
                    {
                        Some(input.decision.clone())
                    } else {
                        None
                    }
                });
            return self
                .decide_user_gate(DecideUserGate {
                    run_id: input.run_id,
                    step_id: input.step_id,
                    selected_option_id,
                    note,
                    form_data,
                    operation_id: input.operation_id,
                    principal: input.principal,
                })
                .await;
        }
        let WorkflowStepSpec::Approval(approval) = &step.spec else {
            return Err(WorkflowError::Conflict(format!(
                "step `{}` is not an approval",
                input.step_id
            )));
        };
        let principal_scope = input
            .principal
            .get("scopes")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|scopes| {
                scopes
                    .iter()
                    .any(|scope| scope.as_str() == Some(&approval.approver_scope))
            });
        if !principal_scope {
            return Err(WorkflowError::Conflict(format!(
                "principal lacks approval scope `{}`",
                approval.approver_scope
            )));
        }
        validate_json_value(&approval.decision_schema, &input.decision)?;
        let policy: WorkflowPolicy = serde_json::from_str(&run.policy_json)?;
        if serde_json::to_vec(&input.decision)?.len() > policy.max_output_bytes {
            return Err(WorkflowError::Validation(format!(
                "approval output exceeds {} bytes",
                policy.max_output_bytes
            )));
        }
        let payload_digest = digest_json(&serde_json::json!({
            "runId": input.run_id,
            "stepId": &input.step_id,
            "decision": &input.decision,
        }))?;
        self.store
            .decide_approval(
                input.run_id,
                &input.step_id,
                &input.decision,
                &payload_digest,
                input.operation_id,
                &serde_json::to_string(&input.principal)?,
            )
            .await
    }

    /// Resolves a rich `UserGate` interaction (`approval` option selection or `ask_form` submission).
    pub async fn decide_user_gate(
        &self,
        input: DecideUserGate,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let run = self.store.run(input.run_id).await?;
        let definition = self
            .store
            .version(run.definition_version_id)
            .await?
            .definition()?;
        let step = definition
            .steps
            .iter()
            .find(|step| step.id == input.step_id)
            .ok_or_else(|| WorkflowError::NotFound(format!("workflow step {}", input.step_id)))?;
        let WorkflowStepSpec::UserGate(gate) = &step.spec else {
            return Err(WorkflowError::Conflict(format!(
                "step `{}` is not a user_gate",
                input.step_id
            )));
        };

        let decision_value = match gate.interaction_kind {
            UserInteractionKind::Approval => {
                let option_id = input.selected_option_id.as_deref().ok_or_else(|| {
                    WorkflowError::Validation(format!(
                        "user_gate `{}` requires selectedOptionId",
                        input.step_id
                    ))
                })?;
                let option = gate
                    .approval_options
                    .iter()
                    .find(|opt| opt.id == option_id)
                    .ok_or_else(|| {
                        WorkflowError::Validation(format!(
                            "selectedOptionId `{option_id}` is not declared on user_gate `{}`",
                            input.step_id
                        ))
                    })?;
                let trimmed_note = input
                    .note
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                if option.require_note && trimmed_note.is_none() {
                    return Err(WorkflowError::Validation(format!(
                        "approval option `{option_id}` on user_gate `{}` requires a note",
                        input.step_id
                    )));
                }
                serde_json::json!({
                    "kind": "approval",
                    "selectedOptionId": option.id,
                    "label": option.label,
                    "note": trimmed_note,
                })
            }
            UserInteractionKind::AskForm => {
                let form_data = input.form_data.as_ref().ok_or_else(|| {
                    WorkflowError::Validation(format!(
                        "user_gate `{}` requires formData",
                        input.step_id
                    ))
                })?;
                if let Some(schema) = &gate.form_schema {
                    validate_json_value(schema, form_data)?;
                }
                serde_json::json!({
                    "kind": "ask_form",
                    "formData": form_data,
                    "note": input.note,
                })
            }
            UserInteractionKind::Notify | UserInteractionKind::Digest => {
                return Err(WorkflowError::Conflict(format!(
                    "user_gate `{}` is non-blocking (`{:?}`) and does not accept decisions",
                    input.step_id, gate.interaction_kind
                )));
            }
        };

        let policy: WorkflowPolicy = serde_json::from_str(&run.policy_json)?;
        if serde_json::to_vec(&decision_value)?.len() > policy.max_output_bytes {
            return Err(WorkflowError::Validation(format!(
                "user_gate output exceeds {} bytes",
                policy.max_output_bytes
            )));
        }
        let payload_digest = digest_json(&serde_json::json!({
            "runId": input.run_id,
            "stepId": &input.step_id,
            "decision": &decision_value,
        }))?;
        self.store
            .decide_approval(
                input.run_id,
                &input.step_id,
                &decision_value,
                &payload_digest,
                input.operation_id,
                &serde_json::to_string(&input.principal)?,
            )
            .await
    }

    /// Lists all active `WaitForEvent` Saga steps currently suspended across runs.
    pub async fn waiting_event_steps(&self) -> Result<Vec<WaitingWorkflowStep>, WorkflowError> {
        self.store.waiting_event_steps().await
    }

    /// Resumes a specific suspended `WaitForEvent` Saga step with a matching `EventEnvelope`.
    pub async fn resume_waiting_step(
        &self,
        input: ResumeWaitingWorkflowStep,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let payload_digest = digest_json(&serde_json::json!({
            "runId": input.run_id,
            "stepId": &input.step_id,
            "eventId": &input.event.event_id,
            "eventType": &input.event.event_type,
        }))?;
        self.store
            .resume_waiting_step(
                input.run_id,
                &input.step_id,
                &input.event,
                &payload_digest,
                input.operation_id,
            )
            .await
    }

    /// Matches an incoming `EventEnvelope` against all suspended `WaitForEvent` Saga steps
    /// and resumes every correlated run idempotently.
    pub async fn dispatch_event_to_waiting_runs(
        &self,
        envelope: &EventEnvelope,
        operation_seed: Uuid,
    ) -> Result<Vec<WorkflowRunView>, WorkflowError> {
        let waiting = self.store.waiting_event_steps().await?;
        let mut resumed = Vec::new();
        for candidate in waiting {
            if !match_waiting_step(&candidate.spec, &candidate.correlation_context, envelope) {
                continue;
            }
            let operation_id = derive_saga_operation_id(
                operation_seed,
                candidate.run_id,
                &candidate.step_id,
                candidate.attempt,
                &envelope.event_id,
            );
            let run_view = self
                .resume_waiting_step(ResumeWaitingWorkflowStep {
                    run_id: candidate.run_id,
                    step_id: candidate.step_id,
                    event: envelope.clone(),
                    operation_id,
                })
                .await?;
            resumed.push(run_view);
        }
        Ok(resumed)
    }

    /// Fails any suspended `WaitForEvent` or SLA-bounded `UserGate` step whose deadline has passed.
    pub async fn expire_timed_out_waiting_steps(
        &self,
        now: DateTime<Utc>,
    ) -> Result<Vec<WorkflowRunView>, WorkflowError> {
        self.store.expire_timed_out_waiting_steps(now).await
    }

    pub async fn cancel(
        &self,
        run_id: Uuid,
        operation_id: Uuid,
        reason: Option<&str>,
    ) -> Result<WorkflowRunView, WorkflowError> {
        self.store.cancel(run_id, operation_id, reason).await
    }

    pub async fn review(&self, input: ReviewWorkflow) -> Result<WorkflowRunView, WorkflowError> {
        let payload_digest = digest_json(&serde_json::json!({
            "runId": input.run_id,
            "decision": &input.decision,
        }))?;
        let principal_json = serde_json::to_string(&input.principal)?;
        match &input.decision {
            WorkflowReviewDecision::Retry { step_id } => {
                self.store
                    .retry_review_step(
                        input.run_id,
                        step_id,
                        input.operation_id,
                        &payload_digest,
                        &principal_json,
                    )
                    .await
            }
            WorkflowReviewDecision::Accept { step_id, output } => {
                let run = self.store.run(input.run_id).await?;
                let definition = self
                    .store
                    .version(run.definition_version_id)
                    .await?
                    .definition()?;
                let step = definition
                    .steps
                    .iter()
                    .find(|step| step.id == *step_id)
                    .ok_or_else(|| WorkflowError::NotFound(format!("workflow step {step_id}")))?;
                if !step.spec.is_executable_step() {
                    return Err(WorkflowError::Conflict(
                        "only agent steps can accept review evidence".to_string(),
                    ));
                }
                let schema_digest =
                    validate_step_output_bytes(&run, step.spec.output_schema(), output.as_ref())?;
                self.store
                    .accept_review_step(
                        input.run_id,
                        step_id,
                        output.as_ref(),
                        schema_digest.as_deref(),
                        input.operation_id,
                        &payload_digest,
                        &principal_json,
                    )
                    .await
            }
            WorkflowReviewDecision::Skip { step_id } => {
                let run = self.store.run(input.run_id).await?;
                let definition = self
                    .store
                    .version(run.definition_version_id)
                    .await?
                    .definition()?;
                let step = definition
                    .steps
                    .iter()
                    .find(|step| step.id == *step_id)
                    .ok_or_else(|| WorkflowError::NotFound(format!("workflow step {step_id}")))?;
                let allow_skip = match &step.spec {
                    WorkflowStepSpec::Agent(agent) => agent.allow_skip_on_review,
                    WorkflowStepSpec::Session(_)
                    | WorkflowStepSpec::Bot(_)
                    | WorkflowStepSpec::GroupStage(_)
                    | WorkflowStepSpec::OutboxAction(_) => false,
                    _ => {
                        return Err(WorkflowError::Conflict(
                            "only agent steps can be skipped during review".to_string(),
                        ));
                    }
                };
                if !allow_skip {
                    return Err(WorkflowError::Conflict(format!(
                        "step `{step_id}` does not allow review skip"
                    )));
                }
                self.store
                    .skip_review_step(
                        input.run_id,
                        step_id,
                        input.operation_id,
                        &payload_digest,
                        &principal_json,
                    )
                    .await
            }
            WorkflowReviewDecision::Cancel { reason } => {
                self.store
                    .cancel(input.run_id, input.operation_id, reason.as_deref())
                    .await
            }
        }
    }
}

fn validate_source_path(source_path: &str) -> Result<(), WorkflowError> {
    let path = std::path::Path::new(source_path);
    if source_path.trim().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
        || !source_path.ends_with(".vibex-workflow.json")
    {
        return Err(WorkflowError::Validation(
            "sourcePath must be a relative *.vibex-workflow.json path".to_string(),
        ));
    }
    Ok(())
}

fn validate_step_output_bytes(
    run: &WorkflowRunView,
    output_schema: Option<&serde_json::Value>,
    output: Option<&serde_json::Value>,
) -> Result<Option<String>, WorkflowError> {
    match output {
        Some(output) => {
            let bytes = serde_json::to_vec(output)?;
            let policy: WorkflowPolicy = serde_json::from_str(&run.policy_json)?;
            if bytes.len() > policy.max_output_bytes {
                return Err(WorkflowError::Validation(format!(
                    "step output exceeds {} bytes",
                    policy.max_output_bytes
                )));
            }
            Ok(Some(
                output_schema
                    .map(digest_json)
                    .transpose()?
                    .unwrap_or_else(|| "raw-text:v1".to_string()),
            ))
        }
        None => Ok(None),
    }
}

fn derive_saga_operation_id(
    seed: Uuid,
    run_id: Uuid,
    step_id: &str,
    attempt: u32,
    event_id: &str,
) -> Uuid {
    let mut hasher = Sha256::new();
    hasher.update(seed.as_bytes());
    hasher.update(run_id.as_bytes());
    hasher.update(step_id.as_bytes());
    hasher.update(attempt.to_le_bytes());
    hasher.update(event_id.as_bytes());
    let digest = hasher.finalize();
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}

fn digest_json(value: &impl serde::Serialize) -> Result<String, WorkflowError> {
    let bytes = serde_json::to_vec(value)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
