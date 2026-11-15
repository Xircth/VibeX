#[path = "workflow/execution.rs"]
mod execution;

pub(crate) use self::execution::{UnavailableWorkflowExecution, map_error, principal_json};
pub use self::execution::ensure_member_session_workspace;

use agents::{AgentId, ConversationInputPayload};
use async_trait::async_trait;
use chrono::Duration;
use conversations::{
    ConversationContext, CreateWorkflowConversation, SubmitConversationInput,
    create_workflow_conversation,
};
use db::models::{
    conversation_input::ConversationInputRecord,
    conversation_side_effects::ConversationFileChangeRecord,
    conversation_turn::ConversationTurnRecord,
    task::Task,
    workspace::Workspace,
};
use uuid::Uuid;
use workflows::{
    CompleteWorkflowStep, CompletionPolicy, DebugRunScope, StageWorkflowStepCandidate,
    WorkflowCore, WorkflowDefinition, WorkflowDefinitionSummary, WorkflowEventRecord,
    WorkflowPolicy, WorkflowReviewDecision, WorkflowRunView, WorkflowStepSpec, WorkflowStepView,
    WorkflowStore, WorkflowValidationView, WorkflowVersionView, WorkspaceAccess,
};

use crate::{
    ApplicationError, ConversationExecutionPort, ConversationSessionExecutionPort, Principal,
};

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishWorkflowRequest {
    pub definition_id: Option<Uuid>,
    pub definition: WorkflowDefinition,
    pub source_path: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateWorkflowRequest {
    pub definition: WorkflowDefinition,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartWorkflowRequest {
    pub definition_version_id: Uuid,
    pub workspace_id: Uuid,
    pub input: serde_json::Value,
    pub policy_override: Option<WorkflowPolicy>,
    pub debug_step_id: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugWorkflowRequest {
    pub definition_id: Option<Uuid>,
    pub definition: WorkflowDefinition,
    pub source_path: Option<String>,
    pub workspace_id: Option<Uuid>,
    pub input: serde_json::Value,
    pub policy_override: Option<WorkflowPolicy>,
    pub step_id: String,
    pub parent_run_id: Option<Uuid>,
    #[serde(default)]
    pub scope: DebugRunScope,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteWorkflowStepRequest {
    pub run_id: Uuid,
    pub step_id: String,
    pub output: Option<serde_json::Value>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecideWorkflowRequest {
    pub run_id: Uuid,
    pub step_id: String,
    pub decision: serde_json::Value,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelWorkflowRequest {
    pub run_id: Uuid,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeWorkflowRequest {
    pub run_id: Uuid,
    pub decision: WorkflowReviewDecision,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PauseWorkflowRequest {
    pub run_id: Uuid,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumePausedWorkflowRequest {
    pub run_id: Uuid,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptWorkflowCandidateRequest {
    pub run_id: Uuid,
    pub step_id: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PauseWorkflowStepRequest {
    pub run_id: Uuid,
    pub step_id: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitWorkflowStepInputRequest {
    pub run_id: Uuid,
    pub step_id: String,
    pub text: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkWorkflowRequest {
    pub parent_run_id: Uuid,
    pub definition_version_id: Uuid,
    pub step_id: String,
    pub scope: DebugRunScope,
}

#[async_trait]
pub trait WorkflowExecutionPort: Send + Sync {
    async fn validate(
        &self,
        request: ValidateWorkflowRequest,
    ) -> Result<WorkflowValidationView, ApplicationError> {
        let _ = request;
        Err(ApplicationError::capability_unavailable(
            "workflow validation is not configured",
        ))
    }
    async fn publish(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: PublishWorkflowRequest,
    ) -> Result<WorkflowVersionView, ApplicationError>;
    async fn start(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: StartWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError>;
    async fn debug(
        &self,
        _principal: &Principal,
        _operation_id: Uuid,
        _request: DebugWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "workflow debug Runs are not configured",
        ))
    }
    async fn show(&self, run_id: Uuid) -> Result<WorkflowRunView, ApplicationError>;
    async fn version(&self, version_id: Uuid) -> Result<WorkflowVersionView, ApplicationError>;
    async fn definitions(
        &self,
        limit: u32,
    ) -> Result<Vec<WorkflowDefinitionSummary>, ApplicationError>;
    async fn versions(
        &self,
        definition_id: Uuid,
        limit: u32,
    ) -> Result<Vec<WorkflowVersionView>, ApplicationError>;
    async fn steps(&self, run_id: Uuid) -> Result<Vec<WorkflowStepView>, ApplicationError>;
    async fn events(
        &self,
        run_id: Uuid,
        after_sequence: i64,
        limit: i64,
    ) -> Result<Vec<WorkflowEventRecord>, ApplicationError>;
    async fn complete_step(
        &self,
        request: CompleteWorkflowStepRequest,
    ) -> Result<WorkflowRunView, ApplicationError>;
    async fn decide(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: DecideWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError>;
    async fn cancel(
        &self,
        operation_id: Uuid,
        request: CancelWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError>;
    async fn resume(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: ResumeWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError>;
    async fn pause_run(
        &self,
        _principal: &Principal,
        _operation_id: Uuid,
        _request: PauseWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "workflow pause is not configured",
        ))
    }
    async fn resume_paused_run(
        &self,
        _principal: &Principal,
        _operation_id: Uuid,
        _request: ResumePausedWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "workflow pause is not configured",
        ))
    }
    async fn accept_candidate(
        &self,
        _principal: &Principal,
        _operation_id: Uuid,
        _request: AcceptWorkflowCandidateRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "workflow candidate acceptance is not configured",
        ))
    }
    async fn pause_step(
        &self,
        _request: PauseWorkflowStepRequest,
    ) -> Result<WorkflowStepView, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "workflow step interaction is not configured",
        ))
    }
    async fn submit_step_input(
        &self,
        _operation_id: Uuid,
        _request: SubmitWorkflowStepInputRequest,
    ) -> Result<WorkflowStepView, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "workflow step interaction is not configured",
        ))
    }
    async fn fork_from_step(
        &self,
        _principal: &Principal,
        _operation_id: Uuid,
        _request: ForkWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "workflow debug Runs are not configured",
        ))
    }
}

pub struct WorkflowStoreExecutionPort {
    core: WorkflowCore,
    store: WorkflowStore,
    pool: db::DbPool,
    conversation_context: Option<ConversationContext>,
}

#[derive(Clone)]
pub struct WorkflowAgentDispatcher {
    pub(crate) store: WorkflowStore,
    pub(crate) core: WorkflowCore,
    pub(crate) conversations: std::sync::Arc<ConversationSessionExecutionPort>,
    pub(crate) context: ConversationContext,
    next_retention_at: std::sync::Arc<std::sync::Mutex<std::time::Instant>>,
}

impl WorkflowAgentDispatcher {
    pub fn new(context: ConversationContext) -> Self {
        let store = WorkflowStore::new(context.deployment.db().pool.clone());
        Self {
            core: WorkflowCore::new(store.clone()),
            store,
            conversations: std::sync::Arc::new(ConversationSessionExecutionPort::new(
                context.clone(),
            )),
            context,
            next_retention_at: std::sync::Arc::new(
                std::sync::Mutex::new(std::time::Instant::now()),
            ),
        }
    }

    pub async fn tick(&self) -> Result<bool, ApplicationError> {
        if self.cleanup_retained_runs().await? {
            return Ok(true);
        }
        if !self.has_active_runs().await? {
            return Ok(false);
        }
        if self.cancel_expired_runs().await? {
            return Ok(true);
        }
        if self.reconcile_waiting_interactions().await? {
            return Ok(true);
        }
        if self.reconcile_terminal_steps().await? {
            return Ok(true);
        }
        let Some(claimed) = self
            .store
            .claim_ready(16, Duration::seconds(30))
            .await
            .map_err(map_error)?
        else {
            return Ok(false);
        };
        let step = claimed
            .definition
            .steps
            .iter()
            .find(|step| step.id == claimed.step.step_id)
            .ok_or_else(|| ApplicationError::internal("claimed workflow step is missing"))?;
        let WorkflowStepSpec::Agent(agent) = &step.spec else {
            return self.dispatch_pulse_claimed_step(&claimed, step).await;
        };
        let agent_id = AgentId::parse(&agent.agent_id)
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        let resolved_input = match self.store.resolve_step_input(claimed.run.id, step).await {
            Ok(input) => input,
            Err(error) => {
                self.store
                    .fail_step(
                        claimed.run.id,
                        &step.id,
                        "input_binding_failed",
                        &error.to_string(),
                    )
                    .await
                    .map_err(map_error)?;
                return Ok(true);
            }
        };
        let (step_workspace_id, workspace_evidence) =
            if agent.workspace_access == WorkspaceAccess::WriteIsolated {
                match create_isolated_step_workspace(
                    &self.context,
                    claimed.run.workspace_id,
                    claimed.run.id,
                    &step.id,
                    claimed.step.attempt,
                    claimed.step.id,
                )
                .await
                {
                    Ok(prepared) => prepared,
                    Err(error) => {
                        self.store
                            .fail_step(
                                claimed.run.id,
                                &step.id,
                                "workspace_isolation_failed",
                                &error.to_string(),
                            )
                            .await
                            .map_err(map_error)?;
                        return Ok(true);
                    }
                }
            } else {
                (
                    claimed.run.workspace_id,
                    serde_json::json!({
                        "isolated": false,
                        "workspaceId": claimed.run.workspace_id,
                        "policy": agent.workspace_access,
                    }),
                )
            };
        self.store
            .prepare_step(
                claimed.run.id,
                step,
                claimed.claim_token,
                &resolved_input,
                step_workspace_id,
                &workspace_evidence,
            )
            .await
            .map_err(map_error)?;
        let prompt = render_agent_prompt(
            &agent.prompt,
            &resolved_input.values,
            agent.output_schema.as_ref(),
            agent.output_description.as_deref(),
            agent.output_language.as_deref(),
        )?;
        // The StepRun id is a stable child identity. A crash after child
        // creation but before StepStarted can safely retry this preflight
        // without creating a second child Conversation.
        let child_id = claimed.step.id;
        if let Err(error) = create_workflow_conversation(
            &self.context.deployment.db().pool,
            CreateWorkflowConversation {
                id: child_id,
                parent_conversation_id: claimed.run.id,
                workspace_id: step_workspace_id,
                workflow_run_id: claimed.run.id,
                workflow_step_id: step.id.clone(),
                agent_id: agent_id.clone(),
                prompt: prompt.clone(),
                visible: false,
            },
        )
        .await
        {
            self.store
                .fail_step(
                    claimed.run.id,
                    &step.id,
                    "child_create_failed",
                    &error.to_string(),
                )
                .await
                .map_err(map_error)?;
            return Ok(true);
        }
        self.store
            .mark_started(
                claimed.run.id,
                &step.id,
                claimed.claim_token,
                Some(child_id),
                None,
            )
            .await
            .map_err(map_error)?;
        let submission = self
            .conversations
            .submit_input(SubmitConversationInput {
                conversation_id: child_id,
                operation_id: child_id,
                payload: ConversationInputPayload {
                    continuation_policy: None,
                    expected_binding_revision: None,
                    agent_id,
                    workspace_id: step_workspace_id,
                    executor_profile_id: agent.executor_profile_id.clone(),
                    text: prompt,
                    display_text: None,
                    images: Vec::new(),
                    mode_override: agent.mode_override.clone(),
                    config_overrides: agent
                        .config_overrides
                        .iter()
                        .map(|(key, value)| agents::AgentSessionConfigOverride {
                            key: key.clone(),
                            value: value.clone(),
                        })
                        .collect(),
                    workflow_refs: Vec::new(),
                    file_refs: Vec::new(),
                    internal_prompt_contributions: Vec::new(),
                    collaboration_origin: None,
                },
                principal: serde_json::json!({
                    "id": "workflow-dispatcher",
                    "workflowRunId": claimed.run.id,
                    "workflowStepId": step.id,
                }),
            })
            .await;
        match submission {
            Ok(submission) => {
                let turn = submission.turn.ok_or_else(|| {
                    ApplicationError::internal("workflow input was queued instead of dispatched")
                })?;
                self.store
                    .bind_turn(claimed.run.id, &step.id, child_id, turn.turn_id)
                    .await
                    .map_err(map_error)?;
            }
            Err(error) => {
                self.store
                    .fail_step(
                        claimed.run.id,
                        &step.id,
                        "conversation_start_failed",
                        &error.to_string(),
                    )
                    .await
                    .map_err(map_error)?;
            }
        }
        Ok(true)
    }

    async fn has_active_runs(&self) -> Result<bool, ApplicationError> {
        let active =
            db::workflow_queries::workflow_has_active_runs(&self.context.deployment.db().pool)
                .await
                .map_err(|error| ApplicationError::internal(error.to_string()))?;
        Ok(active)
    }

    async fn cleanup_retained_runs(&self) -> Result<bool, ApplicationError> {
        let should_run = {
            let mut next = self.next_retention_at.lock().unwrap();
            let now = std::time::Instant::now();
            if now < *next {
                false
            } else {
                *next = now + std::time::Duration::from_secs(60 * 60);
                true
            }
        };
        if !should_run {
            return Ok(false);
        }
        let cutoff = chrono::Utc::now() - chrono::Duration::days(30);
        let candidates = self
            .store
            .retention_candidates(cutoff, 100)
            .await
            .map_err(map_error)?;
        let mut deleted = false;
        for candidate in candidates {
            let mut cleanup_failed = false;
            for workspace_id in candidate.isolated_workspace_ids {
                let workspace =
                    Workspace::find_by_id(&self.context.deployment.db().pool, workspace_id)
                        .await
                        .map_err(|error| ApplicationError::internal(error.to_string()))?;
                let Some(workspace) = workspace else {
                    continue;
                };
                if self
                    .context
                    .deployment
                    .container()
                    .delete(&workspace)
                    .await
                    .is_err()
                {
                    cleanup_failed = true;
                    break;
                }
                Workspace::delete(&self.context.deployment.db().pool, workspace.id)
                    .await
                    .map_err(|error| ApplicationError::internal(error.to_string()))?;
                let _ = Task::delete(&self.context.deployment.db().pool, workspace.task_id).await;
            }
            if cleanup_failed {
                continue;
            }
            deleted |= self
                .store
                .cleanup_terminal_run(candidate.run_id, cutoff)
                .await
                .map_err(map_error)?;
        }
        Ok(deleted)
    }

    async fn cancel_expired_runs(&self) -> Result<bool, ApplicationError> {
        let run_ids = db::workflow_queries::expired_workflow_run_ids(
            &self.context.deployment.db().pool,
            chrono::Utc::now(),
        )
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
        if run_ids.is_empty() {
            return Ok(false);
        }
        let service = conversations::ConversationSessionService::new(self.context.clone());
        for run_id in run_ids {
            for step in self.store.steps(run_id).await.map_err(map_error)? {
                if matches!(step.status.as_str(), "claimed" | "running")
                    && let Some(conversation_id) = step.conversation_id
                {
                    let _ = service
                        .cancel_turn(
                            conversation_id,
                            Some("Workflow deadline exceeded".to_string()),
                        )
                        .await;
                }
            }
            self.store
                .cancel(run_id, Uuid::new_v4(), Some("deadline exceeded"))
                .await
                .map_err(map_error)?;
        }
        Ok(true)
    }

    async fn reconcile_terminal_steps(&self) -> Result<bool, ApplicationError> {
        let rows =
            db::workflow_queries::running_agent_step_runs(&self.context.deployment.db().pool)
                .await
                .map_err(|error| ApplicationError::internal(error.to_string()))?;
        let mut changed = false;
        for row in rows {
            let run_id = row.run_id;
            let step_id = row.step_id.clone();
            let conversation_id = row.conversation_id;
            let turn_id = row.turn_id;
            let user_intervened = row.user_intervened;
            let Some(turn) =
                ConversationTurnRecord::find_by_id(&self.context.deployment.db().pool, turn_id)
                    .await
                    .map_err(|error| ApplicationError::internal(error.to_string()))?
            else {
                continue;
            };
            match turn.status.as_str() {
                "completed" => {
                    self.record_step_artifacts(run_id, &step_id, turn_id)
                        .await?;
                    let run = self.store.run(run_id).await.map_err(map_error)?;
                    let definition = self
                        .store
                        .version(run.definition_version_id)
                        .await
                        .map_err(map_error)?
                        .definition()
                        .map_err(map_error)?;
                    let step = definition
                        .steps
                        .iter()
                        .find(|step| step.id == step_id)
                        .ok_or_else(|| ApplicationError::internal("workflow step is missing"))?;
                    let completion_policy =
                        crate::workflow_pulse::step_uses_conversation_turn(&step.spec);
                    let output = match completion_policy {
                        Some(_) => match extract_last_assistant_text(
                            &self.context.deployment.db().pool,
                            conversation_id,
                            turn_id,
                        )
                        .await
                        {
                            Ok(text) => Some(serde_json::Value::String(text)),
                            Err(error) => {
                                self.store
                                    .fail_step(
                                        run_id,
                                        &step_id,
                                        "missing_assistant_output",
                                        &error.envelope().message,
                                    )
                                    .await
                                    .map_err(map_error)?;
                                changed = true;
                                continue;
                            }
                        },
                        None => None,
                    };
                    let completion = match completion_policy {
                        Some(policy) if policy == CompletionPolicy::Manual || user_intervened => {
                            self.core
                                .stage_step_candidate(StageWorkflowStepCandidate {
                                    run_id,
                                    step_id: step_id.clone(),
                                    output,
                                })
                                .await
                        }
                        Some(_) => {
                            self.core
                                .complete_step(CompleteWorkflowStep {
                                    run_id,
                                    step_id: step_id.clone(),
                                    output,
                                })
                                .await
                        }
                        None => Err(workflows::WorkflowError::Conflict(
                            "dispatcher cannot complete non-conversational steps via turn reconciliation"
                                .to_string(),
                        )),
                    };
                    match completion {
                        Ok(_) => {}
                        Err(error) => {
                            self.store
                                .fail_step(
                                    run_id,
                                    &step_id,
                                    "invalid_structured_output",
                                    &error.to_string(),
                                )
                                .await
                                .map_err(map_error)?;
                        }
                    }
                    changed = true;
                }
                "failed" | "cancelled" => {
                    self.record_step_artifacts(run_id, &step_id, turn_id)
                        .await?;
                    self.store
                        .fail_step(
                            run_id,
                            &step_id,
                            &turn.status,
                            "Agent Turn did not complete",
                        )
                        .await
                        .map_err(map_error)?;
                    changed = true;
                }
                "interrupted" => {
                    self.record_step_artifacts(run_id, &step_id, turn_id)
                        .await?;
                    self.store
                        .needs_review_step(
                            run_id,
                            &step_id,
                            "Agent Turn was interrupted after dispatch",
                        )
                        .await
                        .map_err(map_error)?;
                    changed = true;
                }
                _ => {}
            }
        }
        Ok(changed)
    }

    async fn reconcile_waiting_interactions(&self) -> Result<bool, ApplicationError> {
        let rows =
            db::workflow_queries::running_workflow_interactions(&self.context.deployment.db().pool)
                .await
                .map_err(|error| ApplicationError::internal(error.to_string()))?;
        let mut changed = false;
        for row in rows {
            if row.child_waiting != row.projected_waiting {
                changed |= self
                    .store
                    .set_interaction_waiting(row.run_id, &row.step_id, row.child_waiting)
                    .await
                    .map_err(map_error)?;
            }
        }
        Ok(changed)
    }

    async fn record_step_artifacts(
        &self,
        run_id: Uuid,
        step_id: &str,
        turn_id: Uuid,
    ) -> Result<(), ApplicationError> {
        let files = ConversationFileChangeRecord::list_for_turn(
            &self.context.deployment.db().pool,
            turn_id,
        )
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
        let artifacts = serde_json::json!({
            "turnId": turn_id,
            "fileChanges": files,
            "autoMerge": false,
        });
        self.store
            .record_step_artifacts(run_id, step_id, &artifacts)
            .await
            .map_err(map_error)?;
        Ok(())
    }
}

pub(crate) async fn create_isolated_step_workspace(
    context: &ConversationContext,
    parent_workspace_id: Uuid,
    run_id: Uuid,
    step_id: &str,
    attempt: i64,
    isolated_workspace_id: Uuid,
) -> Result<(Uuid, serde_json::Value), ApplicationError> {
    create_isolated_workspace(
        context,
        parent_workspace_id,
        isolated_workspace_id,
        format!("workflow/{run_id}/step-{step_id}-attempt-{attempt}"),
        format!("Workflow {run_id} · {step_id} · attempt {attempt}"),
        "workflow",
    )
    .await
}

async fn create_isolated_workspace(
    context: &ConversationContext,
    parent_workspace_id: Uuid,
    isolated_workspace_id: Uuid,
    branch: String,
    title: String,
    purpose: &str,
) -> Result<(Uuid, serde_json::Value), ApplicationError> {
    conversations::isolated_workspace::create_isolated_workspace(
        context,
        parent_workspace_id,
        isolated_workspace_id,
        branch,
        title,
        purpose,
    )
    .await
    .map_err(|error| match error {
        conversations::isolated_workspace::IsolatedWorkspaceError::NoRepositories => {
            ApplicationError::bad_request(error.to_string())
        }
        conversations::isolated_workspace::IsolatedWorkspaceError::Other(message) => {
            ApplicationError::internal(message)
        }
    })
}

pub(crate) fn render_agent_prompt(
    prompt: &str,
    input: &std::collections::BTreeMap<String, serde_json::Value>,
    output_schema: Option<&serde_json::Value>,
    output_description: Option<&str>,
    output_language: Option<&str>,
) -> Result<String, ApplicationError> {
    let mut sections = Vec::new();
    if !input.is_empty() {
        let bindings = serde_json::to_string_pretty(input)
            .map_err(|error| ApplicationError::internal(error.to_string()))?;
        sections.push(format!(
            "The following values are the accepted final outputs of prerequisite Workflow Steps. Each key is the stable predecessor Step ID. Review the referenced artifacts, evidence, and conclusions, preserve their original meaning, and continue this Turn from that completed work.\n{bindings}"
        ));
    }
    sections.push(format!("Task for this Turn:\n{}", prompt.trim()));
    let brief = output_description
        .map(str::trim)
        .filter(|description| !description.is_empty());
    if let Some(description) = brief {
        sections.push(format!("Return this Turn's final result as: {description}"));
    } else if let Some(schema) = output_schema {
        let schema = serde_json::to_string_pretty(schema)
            .map_err(|error| ApplicationError::internal(error.to_string()))?;
        sections.push(format!(
            "Return this Turn's final result as JSON shaped like the following example. Output the JSON itself only: no Markdown code fences, commentary, or surrounding quotes. This is an output convention, not a request to discuss the schema.\n{schema}"
        ));
    }
    if let Some(language) = output_language.filter(|language| !language.trim().is_empty()) {
        let mut language_line = format!(
            "Use `{}` for natural-language content in the result.",
            language.trim()
        );
        if brief.is_none() && output_schema.is_some() {
            language_line.push_str(" Preserve JSON keys required by the example.");
        }
        sections.push(language_line);
    }
    Ok(sections.join("\n\n"))
}

pub(crate) async fn extract_last_assistant_text(
    pool: &db::DbPool,
    conversation_id: Uuid,
    turn_id: Uuid,
) -> Result<String, ApplicationError> {
    let events = db::workflow_queries::conversation_turn_events(pool, conversation_id, turn_id)
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
    if let Some(text) = final_assistant_text(&events) {
        return Ok(text);
    }

    let _ = conversations::ensure_legacy_jsonl_migrated_on_pool(pool, conversation_id).await;
    let turns = conversations::ConversationProjector::project_turns_summary(pool, conversation_id)
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
    if !turns.is_empty() {
        let db_turns = ConversationTurnRecord::list_for_conversation(pool, conversation_id)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?;
        let user_round_count = turns
            .iter()
            .filter(|turn| {
                matches!(turn.role, agents::TurnRole::User) && !turn.id.contains(":steer:")
            })
            .count();
        let round_index = (db_turns.len() == user_round_count)
            .then(|| db_turns.iter().position(|turn| turn.id == turn_id))
            .flatten();
        if let Some(text) = final_assistant_text_from_transcript_round(&turns, round_index) {
            return Ok(text);
        }
    }

    Err(ApplicationError::bad_request(
        "Agent produced no final text output",
    ))
}

fn final_assistant_text_from_transcript_round(
    turns: &[agents::MessageTurn],
    round_index: Option<usize>,
) -> Option<String> {
    let user_positions: Vec<usize> = turns
        .iter()
        .enumerate()
        .filter_map(|(idx, turn)| {
            (matches!(turn.role, agents::TurnRole::User) && !turn.id.contains(":steer:"))
                .then_some(idx)
        })
        .collect();
    let round_slice = if user_positions.is_empty() {
        turns
    } else {
        let target_round = round_index
            .filter(|idx| *idx < user_positions.len())
            .unwrap_or(user_positions.len() - 1);
        let start = user_positions[target_round];
        let end = user_positions
            .get(target_round + 1)
            .copied()
            .unwrap_or(turns.len());
        &turns[start..end]
    };
    let assistant_turn = round_slice
        .iter()
        .rev()
        .find(|turn| matches!(turn.role, agents::TurnRole::Assistant))?;
    let last_boundary = assistant_turn
        .blocks
        .iter()
        .enumerate()
        .filter_map(|(idx, block)| {
            matches!(
                block,
                agents::ContentBlock::Thinking { .. }
                    | agents::ContentBlock::ToolUse { .. }
                    | agents::ContentBlock::ToolResult { .. }
                    | agents::ContentBlock::Plan { .. }
            )
            .then_some(idx)
        })
        .max();
    let text: String = assistant_turn
        .blocks
        .iter()
        .enumerate()
        .filter(|(idx, _)| last_boundary.is_none_or(|boundary| *idx > boundary))
        .filter_map(|(_, block)| match block {
            agents::ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    (!text.trim().is_empty()).then(|| text.trim().to_owned())
}

fn final_assistant_text(events: &[(i64, String, String)]) -> Option<String> {
    // Codex may emit user-visible progress before tools. A Turn's deliverable is
    // the assistant text after its last reasoning/tool/plan activity boundary,
    // not the concatenation of every progress message in the Turn.
    let boundary = events
        .iter()
        .filter(|(_, kind, _)| {
            matches!(
                kind.as_str(),
                "assistant_reasoning_delta" | "tool_call_upsert" | "plan_updated"
            )
        })
        .map(|(sequence, _, _)| *sequence)
        .max()
        .unwrap_or(i64::MIN);
    let text = events
        .iter()
        .filter(|(sequence, kind, _)| *sequence > boundary && kind == "assistant_text_delta")
        .filter_map(|(_, _, normalized)| {
            serde_json::from_str::<serde_json::Value>(normalized)
                .ok()?
                .get("text")?
                .as_str()
                .map(str::to_owned)
        })
        .collect::<String>();
    (!text.trim().is_empty()).then(|| text.trim().to_owned())
}

pub(crate) async fn wait_for_dispatched_input_turn(
    pool: &db::DbPool,
    input_id: Uuid,
) -> Result<Uuid, ApplicationError> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let input = ConversationInputRecord::find_by_id(pool, input_id)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?
            .ok_or_else(|| ApplicationError::internal("workflow step input disappeared"))?;
        if let Some(turn_id) = input.turn_id {
            return Ok(turn_id);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(ApplicationError::internal(
                "workflow step input did not dispatch within five seconds",
            ));
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::{final_assistant_text, render_agent_prompt};

    #[test]
    fn agent_prompt_exposes_bound_input_and_the_exact_output_contract() {
        let input = BTreeMap::from([("brief".to_owned(), serde_json::json!({"id": 7}))]);
        let schema = serde_json::json!({
            "type": "object",
            "required": ["summary"],
            "properties": {"summary": {"type": "string"}}
        });

        let rendered =
            render_agent_prompt("Synthesize", &input, Some(&schema), None, Some("zh-CN")).unwrap();

        assert!(rendered.contains("accepted final outputs of prerequisite Workflow Steps"));
        assert!(rendered.contains("stable predecessor Step ID"));
        assert!(rendered.contains("Output the JSON itself only"));
        assert!(rendered.contains("\"summary\""));
        assert!(rendered.contains("`zh-CN`"));
        assert!(!rendered.contains("```"));
    }

    #[test]
    fn agent_prompt_uses_natural_language_description_without_a_schema() {
        let input = BTreeMap::new();
        let rendered = render_agent_prompt(
            "Summarize",
            &input,
            None,
            Some("a one-paragraph brief"),
            None,
        )
        .unwrap();

        assert!(rendered.contains("Return this Turn's final result as: a one-paragraph brief"));
        assert!(!rendered.contains("JSON"));
    }

    #[test]
    fn agent_prompt_prefers_a_brief_description_over_a_leftover_schema() {
        let input = BTreeMap::new();
        let schema = serde_json::json!({
            "type": "object",
            "required": ["summary"],
            "properties": {"summary": {"type": "string"}}
        });
        let rendered = render_agent_prompt(
            "review my code",
            &input,
            Some(&schema),
            Some("用自然语言写一段代码审阅"),
            Some("zh-CN"),
        )
        .unwrap();

        assert!(rendered.contains("Task for this Turn:\nreview my code"));
        assert!(rendered.contains("Return this Turn's final result as: 用自然语言写一段代码审阅"));
        assert!(rendered.contains("Use `zh-CN` for natural-language content in the result."));
        assert!(!rendered.contains("JSON"));
        assert!(!rendered.contains("Preserve JSON keys"));
    }

    #[test]
    fn final_output_excludes_progress_text_before_the_last_activity_boundary() {
        let event = |sequence, kind: &str, text: &str| {
            (
                sequence,
                kind.to_owned(),
                serde_json::json!({"kind": kind, "text": text}).to_string(),
            )
        };
        let events = vec![
            event(1, "assistant_text_delta", "正在检查仓库。"),
            event(2, "tool_call_upsert", ""),
            event(3, "assistant_text_delta", "还需要核对测试。"),
            event(4, "assistant_reasoning_delta", "prepare final"),
            event(5, "assistant_text_delta", "最终"),
            event(6, "assistant_text_delta", "结论"),
            event(7, "usage_updated", ""),
        ];

        assert_eq!(final_assistant_text(&events).as_deref(), Some("最终结论"));
    }

    #[test]
    fn jsonl_transcript_turns_yield_final_assistant_text_after_last_activity_boundary() {
        let now = chrono::Utc::now();
        let turns = vec![
            agents::MessageTurn {
                id: "u1".to_owned(),
                role: agents::TurnRole::User,
                blocks: vec![agents::ContentBlock::Text {
                    text: "请执行第一步".to_owned(),
                }],
                timestamp: now,
                completed_at: Some(now),
                usage: None,
                duration_ms: None,
                model: None,
                agent_message_id: None,
            },
            agents::MessageTurn {
                id: "a1".to_owned(),
                role: agents::TurnRole::Assistant,
                blocks: vec![
                    agents::ContentBlock::Text {
                        text: "先读取文件".to_owned(),
                    },
                    agents::ContentBlock::ToolUse {
                        tool_use_id: Some("call-1".to_owned()),
                        tool_name: "Read".to_owned(),
                        input_preview: None,
                        status: Some("completed".to_owned()),
                        kind: None,
                        meta: None,
                        images: Vec::new(),
                        started_at: None,
                        ended_at: None,
                    },
                    agents::ContentBlock::Thinking {
                        text: "整理结果".to_owned(),
                    },
                    agents::ContentBlock::Text {
                        text: "第一步".to_owned(),
                    },
                    agents::ContentBlock::Text {
                        text: "完成".to_owned(),
                    },
                ],
                timestamp: now,
                completed_at: Some(now),
                usage: None,
                duration_ms: None,
                model: None,
                agent_message_id: None,
            },
        ];

        assert_eq!(
            super::final_assistant_text_from_transcript_round(&turns, Some(0)).as_deref(),
            Some("第一步完成")
        );
    }
}
