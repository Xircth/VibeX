use agents::ConversationInputPayload;
use async_trait::async_trait;
use conversations::{ConversationContext, SubmitConversationInput};
use db::models::conversation::{ConversationRecord, CreateConversationRecord};
use uuid::Uuid;
use workflows::{
    AcceptWorkflowStepCandidate, CompleteWorkflowStep, ForkWorkflowRun, PauseWorkflowRun,
    PublishWorkflow, ResumePausedWorkflowRun, ReviewWorkflow, StartWorkflow, WorkflowCore,
    WorkflowDefinitionSummary, WorkflowEventRecord, WorkflowRunView, WorkflowStepView,
    WorkflowStore, WorkflowValidationView, WorkflowVersionView,
};

use super::{
    AcceptWorkflowCandidateRequest, CancelWorkflowRequest, CompleteWorkflowStepRequest,
    DebugWorkflowRequest, DecideWorkflowRequest, ForkWorkflowRequest, PauseWorkflowRequest,
    PauseWorkflowStepRequest, PublishWorkflowRequest, ResumePausedWorkflowRequest,
    ResumeWorkflowRequest, StartWorkflowRequest, SubmitWorkflowStepInputRequest,
    ValidateWorkflowRequest, WorkflowExecutionPort, WorkflowStoreExecutionPort,
    wait_for_dispatched_input_turn,
};
use crate::{
    ApplicationError, ConversationExecutionPort, ConversationSessionExecutionPort, Principal,
};

impl WorkflowStoreExecutionPort {
    pub fn new(pool: db::DbPool) -> Self {
        let store = WorkflowStore::new(pool.clone());
        Self {
            core: WorkflowCore::new(store.clone()),
            store,
            pool,
            conversation_context: None,
        }
    }

    pub fn with_conversations(pool: db::DbPool, context: ConversationContext) -> Self {
        let mut port = Self::new(pool);
        port.conversation_context = Some(context);
        port
    }

    async fn submit_step_follow_up(
        &self,
        operation_id: Uuid,
        request: &SubmitWorkflowStepInputRequest,
    ) -> Result<WorkflowStepView, ApplicationError> {
        if request.text.trim().is_empty() {
            return Err(ApplicationError::bad_request(
                "workflow step input cannot be empty",
            ));
        }
        let context = self.conversation_context.as_ref().ok_or_else(|| {
            ApplicationError::capability_unavailable(
                "workflow step Conversations are not configured",
            )
        })?;
        let run = self.store.run(request.run_id).await.map_err(map_error)?;
        let definition = self
            .store
            .version(run.definition_version_id)
            .await
            .map_err(map_error)?
            .definition()
            .map_err(map_error)?;
        let definition_step = definition
            .steps
            .iter()
            .find(|step| step.id == request.step_id)
            .ok_or_else(|| ApplicationError::not_found("workflow step not found"))?;
        let step = self
            .store
            .steps(request.run_id)
            .await
            .map_err(map_error)?
            .into_iter()
            .filter(|step| step.step_id == request.step_id)
            .max_by_key(|step| step.attempt)
            .ok_or_else(|| ApplicationError::not_found("workflow step run not found"))?;
        if !step.awaiting_input {
            return Err(ApplicationError::bad_request(
                "workflow step is not awaiting input",
            ));
        }
        let conversation_id = step
            .conversation_id
            .ok_or_else(|| ApplicationError::internal("workflow step has no child Conversation"))?;
        let workspace_id = step.workspace_id.unwrap_or(run.workspace_id);
        let resolved_input_json = step
            .resolved_input_json
            .as_deref()
            .ok_or_else(|| ApplicationError::internal("workflow step has no resolved input"))?;
        let resolved_input: std::collections::BTreeMap<String, serde_json::Value> =
            serde_json::from_str(resolved_input_json).map_err(|error| {
                ApplicationError::internal(format!(
                    "workflow step resolved input is invalid: {error}"
                ))
            })?;
        let continuation = crate::workflow_pulse::build_step_continuation_context(
            &self.pool,
            &definition_step.spec,
            &resolved_input,
            run.workspace_id,
        )
        .await?;
        let follow_up_prompt = format!(
            "{}\n\nAdditional user guidance for this continuing Turn:\n{}",
            continuation.recovery_context,
            request.text.trim()
        );
        let submission = ConversationSessionExecutionPort::new(context.clone())
            .submit_input(SubmitConversationInput {
                conversation_id,
                operation_id,
                payload: ConversationInputPayload {
                    continuation_policy: None,
                    expected_binding_revision: None,
                    agent_id: continuation.agent_id,
                    workspace_id,
                    executor_profile_id: continuation.executor_profile_id,
                    text: follow_up_prompt,
                    display_text: None,
                    images: Vec::new(),
                    mode_override: continuation.mode_override,
                    config_overrides: continuation.config_overrides,
                    workflow_refs: Vec::new(),
                    file_refs: Vec::new(),
                    internal_prompt_contributions: Vec::new(),
                    collaboration_origin: None,
                    provider_instance_id: None,
                },
                principal: serde_json::json!({
                    "id": "workflow-step-interaction",
                    "workflowRunId": request.run_id,
                    "workflowStepId": request.step_id,
                }),
            })
            .await?;
        let turn_id = if let Some(turn) = submission.turn {
            turn.turn_id
        } else {
            wait_for_dispatched_input_turn(&self.pool, submission.input.id).await?
        };
        self.store
            .bind_turn(request.run_id, &request.step_id, conversation_id, turn_id)
            .await
            .map_err(map_error)?;
        self.store
            .set_step_awaiting_input(request.run_id, &request.step_id, false, None, Some(turn_id))
            .await
            .map_err(map_error)
    }

    pub async fn reconcile_interrupted(&self) -> Result<usize, ApplicationError> {
        let evidence_mismatches = self
            .store
            .reconcile_completed_evidence()
            .await
            .map_err(map_error)?;
        let interrupted = self
            .store
            .reconcile_interrupted()
            .await
            .map_err(map_error)?;
        for run in self
            .store
            .runs_awaiting_dispatch(1_000)
            .await
            .map_err(map_error)?
        {
            self.ensure_run_shell_and_dispatch(&run).await?;
        }
        Ok(interrupted + evidence_mismatches)
    }

    async fn ensure_run_shell_and_dispatch(
        &self,
        run: &WorkflowRunView,
    ) -> Result<(), ApplicationError> {
        if ConversationRecord::find_by_id(&self.pool, run.id)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?
            .is_none()
        {
            let created = ConversationRecord::create(
                &self.pool,
                run.id,
                CreateConversationRecord {
                    workspace_id: run.workspace_id,
                    task_id: None,
                    title: Some("Workflow run"),
                    initial_prompt: None,
                    status: None,
                    executor: Some("workflow"),
                },
            )
            .await;
            if let Err(error) = created {
                let raced = ConversationRecord::find_by_id(&self.pool, run.id)
                    .await
                    .map_err(|lookup| ApplicationError::internal(lookup.to_string()))?
                    .is_some_and(|shell| shell.workspace_id == run.workspace_id);
                if !raced {
                    return Err(ApplicationError::internal(error.to_string()));
                }
            }
        }
        self.store.enable_dispatch(run.id).await.map_err(map_error)
    }
}

#[async_trait]
impl WorkflowExecutionPort for WorkflowStoreExecutionPort {
    async fn validate(
        &self,
        request: ValidateWorkflowRequest,
    ) -> Result<WorkflowValidationView, ApplicationError> {
        self.core.validate(request.definition).map_err(map_error)
    }

    async fn publish(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: PublishWorkflowRequest,
    ) -> Result<WorkflowVersionView, ApplicationError> {
        self.core
            .publish(PublishWorkflow {
                definition_id: request.definition_id,
                definition: request.definition,
                source_path: request.source_path,
                operation_id,
                principal: principal_json(principal),
            })
            .await
            .map_err(map_error)
    }

    async fn start(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: StartWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        let run = self
            .core
            .start(StartWorkflow {
                definition_version_id: request.definition_version_id,
                workspace_id: request.workspace_id,
                input: request.input,
                policy_override: request.policy_override,
                debug_step_id: request.debug_step_id,
                operation_id,
                principal: principal_json(principal),
            })
            .await
            .map_err(map_error)?;
        self.ensure_run_shell_and_dispatch(&run).await?;
        Ok(run)
    }

    async fn debug(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: DebugWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        let version = self
            .core
            .materialize_debug(PublishWorkflow {
                definition_id: request.definition_id,
                definition: request.definition,
                source_path: request.source_path,
                operation_id,
                principal: principal_json(principal),
            })
            .await
            .map_err(map_error)?;
        let run = if let Some(parent_run_id) = request.parent_run_id {
            self.core
                .fork_from_step(ForkWorkflowRun {
                    parent_run_id,
                    definition_version_id: version.id,
                    step_id: request.step_id,
                    scope: request.scope,
                    operation_id,
                    principal: principal_json(principal),
                })
                .await
                .map_err(map_error)?
        } else {
            let workspace_id = request.workspace_id.ok_or_else(|| {
                ApplicationError::bad_request(
                    "workspaceId is required for the first Workflow debug Run",
                )
            })?;
            self.core
                .start(StartWorkflow {
                    definition_version_id: version.id,
                    workspace_id,
                    input: request.input,
                    policy_override: request.policy_override,
                    debug_step_id: Some(request.step_id),
                    operation_id,
                    principal: principal_json(principal),
                })
                .await
                .map_err(map_error)?
        };
        self.ensure_run_shell_and_dispatch(&run).await?;
        Ok(run)
    }

    async fn show(&self, run_id: Uuid) -> Result<WorkflowRunView, ApplicationError> {
        self.store.run(run_id).await.map_err(map_error)
    }

    async fn version(&self, version_id: Uuid) -> Result<WorkflowVersionView, ApplicationError> {
        self.store.version(version_id).await.map_err(map_error)
    }

    async fn definitions(
        &self,
        limit: u32,
    ) -> Result<Vec<WorkflowDefinitionSummary>, ApplicationError> {
        self.core.definitions(limit).await.map_err(map_error)
    }

    async fn delete_definition(&self, definition_id: Uuid) -> Result<bool, ApplicationError> {
        self.core
            .delete_definition(definition_id)
            .await
            .map_err(map_error)
    }

    async fn versions(
        &self,
        definition_id: Uuid,
        limit: u32,
    ) -> Result<Vec<WorkflowVersionView>, ApplicationError> {
        self.core
            .versions(definition_id, limit)
            .await
            .map_err(map_error)
    }

    async fn runs(
        &self,
        definition_id: Uuid,
        limit: u32,
    ) -> Result<Vec<WorkflowRunView>, ApplicationError> {
        self.core
            .runs(definition_id, limit)
            .await
            .map_err(map_error)
    }

    async fn steps(&self, run_id: Uuid) -> Result<Vec<WorkflowStepView>, ApplicationError> {
        self.store.steps(run_id).await.map_err(map_error)
    }

    async fn events(
        &self,
        run_id: Uuid,
        after_sequence: i64,
        limit: i64,
    ) -> Result<Vec<WorkflowEventRecord>, ApplicationError> {
        self.store
            .events_since(run_id, after_sequence, limit)
            .await
            .map_err(map_error)
    }

    async fn complete_step(
        &self,
        request: CompleteWorkflowStepRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        self.core
            .complete_step(CompleteWorkflowStep {
                run_id: request.run_id,
                step_id: request.step_id,
                output: request.output,
            })
            .await
            .map_err(map_error)
    }

    async fn decide(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: DecideWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        crate::workflow_pulse::decide_workflow_or_user_gate(
            &self.core,
            principal,
            operation_id,
            request,
        )
        .await
    }

    async fn cancel(
        &self,
        operation_id: Uuid,
        request: CancelWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        if let Some(context) = &self.conversation_context {
            let service = conversations::ConversationSessionService::new(context.clone());
            for step in self.store.steps(request.run_id).await.map_err(map_error)? {
                if matches!(step.status.as_str(), "claimed" | "running")
                    && let Some(conversation_id) = step.conversation_id
                {
                    let _ = service
                        .cancel_turn(conversation_id, Some("Workflow run cancelled".to_string()))
                        .await;
                }
            }
        }
        self.core
            .cancel(request.run_id, operation_id, request.reason.as_deref())
            .await
            .map_err(map_error)
    }

    async fn resume(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: ResumeWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        self.core
            .review(ReviewWorkflow {
                run_id: request.run_id,
                decision: request.decision,
                operation_id,
                principal: principal_json(principal),
            })
            .await
            .map_err(map_error)
    }

    async fn pause_run(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: PauseWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        let pausing = self
            .core
            .request_pause(PauseWorkflowRun {
                run_id: request.run_id,
                reason: request.reason.clone(),
                operation_id,
                principal: principal_json(principal),
            })
            .await
            .map_err(map_error)?;
        if pausing.control_state == "paused" {
            return Ok(pausing);
        }
        let steps = self.store.steps(request.run_id).await.map_err(map_error)?;
        let service = self
            .conversation_context
            .as_ref()
            .map(|context| conversations::ConversationSessionService::new(context.clone()));
        for step in steps
            .into_iter()
            .filter(|step| step.status == "running" && !step.awaiting_acceptance)
        {
            if let Some(conversation_id) = step.conversation_id {
                if let Some(service) = &service {
                    service
                        .cancel_turn(conversation_id, Some("Workflow run paused".to_string()))
                        .await
                        .map_err(|error| ApplicationError::internal(error.to_string()))?;
                }
                self.store
                    .set_step_awaiting_input(
                        request.run_id,
                        &step.step_id,
                        true,
                        request.reason.as_deref(),
                        None,
                    )
                    .await
                    .map_err(map_error)?;
            }
        }
        self.core
            .mark_paused(request.run_id)
            .await
            .map_err(map_error)
    }

    async fn resume_paused_run(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: ResumePausedWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        self.core
            .resume_paused(ResumePausedWorkflowRun {
                run_id: request.run_id,
                operation_id,
                principal: principal_json(principal),
            })
            .await
            .map_err(map_error)?;
        let awaiting = self
            .store
            .steps(request.run_id)
            .await
            .map_err(map_error)?
            .into_iter()
            .filter(|step| step.awaiting_input)
            .collect::<Vec<_>>();
        for step in awaiting {
            self.submit_step_follow_up(
                Uuid::new_v4(),
                &SubmitWorkflowStepInputRequest {
                    run_id: request.run_id,
                    step_id: step.step_id,
                    text: "Continue this workflow step from the paused state.".to_string(),
                },
            )
            .await?;
        }
        self.store.run(request.run_id).await.map_err(map_error)
    }

    async fn accept_candidate(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: AcceptWorkflowCandidateRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        self.core
            .accept_step_candidate(AcceptWorkflowStepCandidate {
                run_id: request.run_id,
                step_id: request.step_id,
                operation_id,
                principal: principal_json(principal),
            })
            .await
            .map_err(map_error)
    }

    async fn pause_step(
        &self,
        request: PauseWorkflowStepRequest,
    ) -> Result<WorkflowStepView, ApplicationError> {
        let step = self
            .store
            .steps(request.run_id)
            .await
            .map_err(map_error)?
            .into_iter()
            .filter(|step| step.step_id == request.step_id)
            .max_by_key(|step| step.attempt)
            .ok_or_else(|| ApplicationError::not_found("workflow step run not found"))?;
        let conversation_id = step.conversation_id.ok_or_else(|| {
            ApplicationError::bad_request("workflow step has no active Conversation")
        })?;
        // Cancellation shares the Conversation start/stop lock. Do it before
        // clearing the Workflow Turn binding so a Pause racing the initial Agent
        // startup cannot be overwritten by the dispatcher's later bind_turn.
        if let Some(context) = &self.conversation_context {
            let _ = conversations::ConversationSessionService::new(context.clone())
                .cancel_turn(
                    conversation_id,
                    Some("Workflow step paused for input".to_string()),
                )
                .await;
        }
        self.store
            .set_step_awaiting_input(
                request.run_id,
                &request.step_id,
                true,
                request.reason.as_deref(),
                None,
            )
            .await
            .map_err(map_error)
    }

    async fn submit_step_input(
        &self,
        operation_id: Uuid,
        request: SubmitWorkflowStepInputRequest,
    ) -> Result<WorkflowStepView, ApplicationError> {
        self.submit_step_follow_up(operation_id, &request).await
    }

    async fn fork_from_step(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: ForkWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        let run = self
            .core
            .fork_from_step(ForkWorkflowRun {
                parent_run_id: request.parent_run_id,
                definition_version_id: request.definition_version_id,
                step_id: request.step_id,
                scope: request.scope,
                operation_id,
                principal: principal_json(principal),
            })
            .await
            .map_err(map_error)?;
        self.ensure_run_shell_and_dispatch(&run).await?;
        Ok(run)
    }
}

pub(crate) struct UnavailableWorkflowExecution;

#[async_trait]
impl WorkflowExecutionPort for UnavailableWorkflowExecution {
    async fn validate(
        &self,
        _: ValidateWorkflowRequest,
    ) -> Result<WorkflowValidationView, ApplicationError> {
        unavailable()
    }

    async fn publish(
        &self,
        _: &Principal,
        _: Uuid,
        _: PublishWorkflowRequest,
    ) -> Result<WorkflowVersionView, ApplicationError> {
        unavailable()
    }
    async fn start(
        &self,
        _: &Principal,
        _: Uuid,
        _: StartWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        unavailable()
    }
    async fn show(&self, _: Uuid) -> Result<WorkflowRunView, ApplicationError> {
        unavailable()
    }
    async fn version(&self, _: Uuid) -> Result<WorkflowVersionView, ApplicationError> {
        unavailable()
    }
    async fn definitions(
        &self,
        _: u32,
    ) -> Result<Vec<WorkflowDefinitionSummary>, ApplicationError> {
        unavailable()
    }
    async fn versions(
        &self,
        _: Uuid,
        _: u32,
    ) -> Result<Vec<WorkflowVersionView>, ApplicationError> {
        unavailable()
    }
    async fn steps(&self, _: Uuid) -> Result<Vec<WorkflowStepView>, ApplicationError> {
        unavailable()
    }
    async fn events(
        &self,
        _: Uuid,
        _: i64,
        _: i64,
    ) -> Result<Vec<WorkflowEventRecord>, ApplicationError> {
        unavailable()
    }
    async fn complete_step(
        &self,
        _: CompleteWorkflowStepRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        unavailable()
    }
    async fn decide(
        &self,
        _: &Principal,
        _: Uuid,
        _: DecideWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        unavailable()
    }
    async fn cancel(
        &self,
        _: Uuid,
        _: CancelWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        unavailable()
    }
    async fn resume(
        &self,
        _: &Principal,
        _: Uuid,
        _: ResumeWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        unavailable()
    }
}

fn unavailable<T>() -> Result<T, ApplicationError> {
    Err(ApplicationError::capability_unavailable(
        "workflow execution is not configured",
    ))
}

pub(crate) fn principal_json(principal: &Principal) -> serde_json::Value {
    principal.evidence()
}

pub(crate) fn map_error(error: workflows::WorkflowError) -> ApplicationError {
    match error {
        workflows::WorkflowError::Validation(message) => ApplicationError::bad_request(message),
        workflows::WorkflowError::NotFound(message) => ApplicationError::not_found(message),
        workflows::WorkflowError::Conflict(message) => ApplicationError::conflict(message),
        other => ApplicationError::internal(other.to_string()),
    }
}

/// Give a collaboration member session its own worktree workspace when the
/// member's policy is WriteIsolated and another session of the same member
/// already works in that workspace. Reuses the workflow `write_isolated`
/// provisioning. Returns the isolated workspace id when one applies.
pub async fn ensure_member_session_workspace(
    context: &ConversationContext,
    conversation_id: Uuid,
) -> Result<Option<Uuid>, ApplicationError> {
    let pool = &context.deployment.db().pool;
    let Some(session) = db::models::session::Session::find_by_id(pool, conversation_id)
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?
    else {
        return Ok(None);
    };
    let workspace_id = conversations::isolated_workspace::execution_workspace_id(
        context,
        conversation_id,
        session.workspace_id,
    )
    .await
    .map_err(|error| ApplicationError::internal(error.message))?;
    Ok((workspace_id != session.workspace_id).then_some(workspace_id))
}
