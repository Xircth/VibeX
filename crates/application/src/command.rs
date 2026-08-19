use std::{str::FromStr, sync::Arc};

use remote_protocol::{CommandResponse, ErrorCode, ErrorEnvelope, OperationId};
use serde::Deserialize;

use crate::{
    AcceptWorkflowCandidateRequest, ApplicationCore, CancelConversationInputRequest,
    CancelConversationTurn, CancelWorkflowRequest, CompleteWorkflowStepRequest,
    ConversationRepository, CreateChildConversationRequest, CreateConversation,
    DebugWorkflowRequest, DecideWorkflowRequest, DomainCommand, ForkWorkflowRequest,
    ListConversationInputsRequest, ListConversationRelationsRequest, ListConversations,
    PauseWorkflowRequest, PauseWorkflowStepRequest, Principal, PublishWorkflowRequest,
    ReorderConversationInputRequest, RespondConversationPermission, RespondConversationQuestion,
    ResumePausedWorkflowRequest, ResumeWorkflowRequest, StartConversationTurn,
    StartWorkflowRequest, SteerConversationTurnRequest, SubmitConversationInputRequest,
    SubmitWorkflowStepInputRequest, UpdateConversationInputRequest, ValidateWorkflowRequest,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RegisteredCommand {
    ConversationList,
    ConversationCreate,
    ConversationChildCreate,
    ConversationOutput,
    ConversationStartTurn,
    ConversationSteer,
    ConversationInputSubmit,
    ConversationInputList,
    ConversationRelationList,
    ConversationInputUpdate,
    ConversationInputReorder,
    ConversationInputCancel,
    ConversationRespondPermission,
    ConversationRespondQuestion,
    ConversationCancelTurn,
    WorkflowPublish,
    WorkflowValidate,
    WorkflowStart,
    WorkflowDebug,
    WorkflowShow,
    WorkflowVersion,
    WorkflowList,
    WorkflowVersions,
    WorkflowSteps,
    WorkflowEvents,
    WorkflowCompleteStep,
    WorkflowDecide,
    WorkflowCancel,
    WorkflowResume,
    WorkflowPause,
    WorkflowResumeRun,
    WorkflowAcceptCandidate,
    WorkflowPauseStep,
    WorkflowStepInput,
    WorkflowFork,
    Domain(DomainCommand),
}

impl RegisteredCommand {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ConversationList => "conversation_list",
            Self::ConversationCreate => "conversation_create",
            Self::ConversationChildCreate => "conversation_child_create",
            Self::ConversationOutput => "conversation_output",
            Self::ConversationStartTurn => "conversation_start_turn",
            Self::ConversationSteer => "conversation_steer",
            Self::ConversationInputSubmit => "conversation_input_submit",
            Self::ConversationInputList => "conversation_input_list",
            Self::ConversationRelationList => "conversation_relation_list",
            Self::ConversationInputUpdate => "conversation_input_update",
            Self::ConversationInputReorder => "conversation_input_reorder",
            Self::ConversationInputCancel => "conversation_input_cancel",
            Self::ConversationRespondPermission => "conversation_respond_permission",
            Self::ConversationRespondQuestion => "conversation_respond_question",
            Self::ConversationCancelTurn => "conversation_cancel_turn",
            Self::WorkflowPublish => "workflow_publish",
            Self::WorkflowValidate => "workflow_validate",
            Self::WorkflowStart => "workflow_start",
            Self::WorkflowDebug => "workflow_debug",
            Self::WorkflowShow => "workflow_show",
            Self::WorkflowVersion => "workflow_version",
            Self::WorkflowList => "workflow_list",
            Self::WorkflowVersions => "workflow_versions",
            Self::WorkflowSteps => "workflow_steps",
            Self::WorkflowEvents => "workflow_events",
            Self::WorkflowCompleteStep => "workflow_complete_step",
            Self::WorkflowDecide => "workflow_decide",
            Self::WorkflowCancel => "workflow_cancel",
            Self::WorkflowResume => "workflow_resume",
            Self::WorkflowPause => "workflow_pause",
            Self::WorkflowResumeRun => "workflow_resume_run",
            Self::WorkflowAcceptCandidate => "workflow_accept_candidate",
            Self::WorkflowPauseStep => "workflow_pause_step",
            Self::WorkflowStepInput => "workflow_step_input",
            Self::WorkflowFork => "workflow_fork",
            Self::Domain(command) => command.as_str(),
        }
    }
}

impl FromStr for RegisteredCommand {
    type Err = ();

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "conversation_list" => Ok(Self::ConversationList),
            "conversation_create" => Ok(Self::ConversationCreate),
            "conversation_child_create" => Ok(Self::ConversationChildCreate),
            "conversation_output" => Ok(Self::ConversationOutput),
            "conversation_start_turn" => Ok(Self::ConversationStartTurn),
            "conversation_steer" => Ok(Self::ConversationSteer),
            "conversation_input_submit" => Ok(Self::ConversationInputSubmit),
            "conversation_input_list" => Ok(Self::ConversationInputList),
            "conversation_relation_list" => Ok(Self::ConversationRelationList),
            "conversation_input_update" => Ok(Self::ConversationInputUpdate),
            "conversation_input_reorder" => Ok(Self::ConversationInputReorder),
            "conversation_input_cancel" => Ok(Self::ConversationInputCancel),
            "conversation_respond_permission" => Ok(Self::ConversationRespondPermission),
            "conversation_respond_question" => Ok(Self::ConversationRespondQuestion),
            "conversation_cancel_turn" => Ok(Self::ConversationCancelTurn),
            "workflow_publish" => Ok(Self::WorkflowPublish),
            "workflow_validate" => Ok(Self::WorkflowValidate),
            "workflow_start" => Ok(Self::WorkflowStart),
            "workflow_debug" => Ok(Self::WorkflowDebug),
            "workflow_show" => Ok(Self::WorkflowShow),
            "workflow_version" => Ok(Self::WorkflowVersion),
            "workflow_list" => Ok(Self::WorkflowList),
            "workflow_versions" => Ok(Self::WorkflowVersions),
            "workflow_steps" => Ok(Self::WorkflowSteps),
            "workflow_events" => Ok(Self::WorkflowEvents),
            "workflow_complete_step" => Ok(Self::WorkflowCompleteStep),
            "workflow_decide" => Ok(Self::WorkflowDecide),
            "workflow_cancel" => Ok(Self::WorkflowCancel),
            "workflow_resume" => Ok(Self::WorkflowResume),
            "workflow_pause" => Ok(Self::WorkflowPause),
            "workflow_resume_run" => Ok(Self::WorkflowResumeRun),
            "workflow_accept_candidate" => Ok(Self::WorkflowAcceptCandidate),
            "workflow_pause_step" => Ok(Self::WorkflowPauseStep),
            "workflow_step_input" => Ok(Self::WorkflowStepInput),
            "workflow_fork" => Ok(Self::WorkflowFork),
            _ => DomainCommand::from_str(value).map(Self::Domain),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationListArgs {
    workspace_id: uuid::Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationCreateArgs {
    workspace_id: uuid::Uuid,
    agent_id: String,
    title: Option<String>,
    initial_prompt: Option<String>,
}

#[derive(Deserialize)]
struct ConversationChildCreateArgs {
    request: CreateChildConversationRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationOutputArgs {
    conversation_id: uuid::Uuid,
}

#[derive(Deserialize)]
struct ConversationStartTurnArgs {
    request: StartConversationTurn,
}

#[derive(Deserialize)]
struct ConversationSteerArgs {
    request: SteerConversationTurnRequest,
}

#[derive(Deserialize)]
struct ConversationInputSubmitArgs {
    request: SubmitConversationInputRequest,
}

#[derive(Deserialize)]
struct ConversationInputListArgs {
    request: ListConversationInputsRequest,
}

#[derive(Deserialize)]
struct ConversationRelationListArgs {
    request: ListConversationRelationsRequest,
}

#[derive(Deserialize)]
struct ConversationInputUpdateArgs {
    request: UpdateConversationInputRequest,
}

#[derive(Deserialize)]
struct ConversationInputReorderArgs {
    request: ReorderConversationInputRequest,
}

#[derive(Deserialize)]
struct ConversationInputCancelArgs {
    request: CancelConversationInputRequest,
}

#[derive(Deserialize)]
struct ConversationRespondPermissionArgs {
    request: RespondConversationPermission,
}

#[derive(Deserialize)]
struct ConversationRespondQuestionArgs {
    request: RespondConversationQuestion,
}

#[derive(Deserialize)]
struct ConversationCancelTurnArgs {
    request: CancelConversationTurn,
}

#[derive(Deserialize)]
struct WorkflowPublishArgs {
    request: PublishWorkflowRequest,
}
#[derive(Deserialize)]
struct WorkflowValidateArgs {
    request: ValidateWorkflowRequest,
}
#[derive(Deserialize)]
struct WorkflowStartArgs {
    request: StartWorkflowRequest,
}
#[derive(Deserialize)]
struct WorkflowDebugArgs {
    request: DebugWorkflowRequest,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowRunArgs {
    run_id: uuid::Uuid,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowVersionArgs {
    version_id: uuid::Uuid,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowListArgs {
    #[serde(default = "default_workflow_list_limit")]
    limit: u32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowVersionsArgs {
    definition_id: uuid::Uuid,
    #[serde(default = "default_workflow_list_limit")]
    limit: u32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowEventsArgs {
    run_id: uuid::Uuid,
    #[serde(default)]
    after_sequence: i64,
    #[serde(default = "default_event_limit")]
    limit: i64,
}
#[derive(Deserialize)]
struct WorkflowCompleteStepArgs {
    request: CompleteWorkflowStepRequest,
}
#[derive(Deserialize)]
struct WorkflowDecideArgs {
    request: DecideWorkflowRequest,
}
#[derive(Deserialize)]
struct WorkflowCancelArgs {
    request: CancelWorkflowRequest,
}
#[derive(Deserialize)]
struct WorkflowResumeArgs {
    request: ResumeWorkflowRequest,
}
#[derive(Deserialize)]
struct WorkflowPauseArgs {
    request: PauseWorkflowRequest,
}
#[derive(Deserialize)]
struct WorkflowResumeRunArgs {
    request: ResumePausedWorkflowRequest,
}
#[derive(Deserialize)]
struct WorkflowAcceptCandidateArgs {
    request: AcceptWorkflowCandidateRequest,
}
#[derive(Deserialize)]
struct WorkflowPauseStepArgs {
    request: PauseWorkflowStepRequest,
}
#[derive(Deserialize)]
struct WorkflowStepInputArgs {
    request: SubmitWorkflowStepInputRequest,
}
#[derive(Deserialize)]
struct WorkflowForkArgs {
    request: ForkWorkflowRequest,
}

const fn default_event_limit() -> i64 {
    200
}

const fn default_workflow_list_limit() -> u32 {
    100
}

pub struct CommandRegistry<R> {
    core: Arc<ApplicationCore<R>>,
}

impl<R> CommandRegistry<R>
where
    R: ConversationRepository,
{
    pub fn new(core: ApplicationCore<R>) -> Self {
        Self {
            core: Arc::new(core),
        }
    }

    pub fn from_core(core: Arc<ApplicationCore<R>>) -> Self {
        Self { core }
    }

    pub async fn execute_name(
        &self,
        principal: &Principal,
        command: &str,
        operation_id: OperationId,
        args: serde_json::Value,
    ) -> Result<CommandResponse<serde_json::Value>, ErrorEnvelope> {
        let command = RegisteredCommand::from_str(command).map_err(|()| {
            ErrorEnvelope::new(
                ErrorCode::NotFound,
                format!("command `{command}` is not registered"),
                false,
                operation_id,
            )
        })?;
        self.execute(principal, command, operation_id, args).await
    }

    pub async fn execute(
        &self,
        principal: &Principal,
        command: RegisteredCommand,
        operation_id: OperationId,
        args: serde_json::Value,
    ) -> Result<CommandResponse<serde_json::Value>, ErrorEnvelope> {
        let data = match command {
            RegisteredCommand::ConversationList => {
                let args =
                    serde_json::from_value::<ConversationListArgs>(args).map_err(|error| {
                        ErrorEnvelope::new(
                            ErrorCode::BadRequest,
                            format!("invalid arguments for {}: {error}", command.as_str()),
                            false,
                            operation_id,
                        )
                    })?;
                let result = self
                    .core
                    .list_conversations(
                        principal,
                        ListConversations {
                            workspace_id: args.workspace_id,
                        },
                    )
                    .await
                    .map_err(|error| {
                        let mut envelope = error.into_envelope();
                        envelope.operation_id = operation_id;
                        envelope
                    })?;
                serde_json::to_value(result).map_err(|error| {
                    ErrorEnvelope::new(
                        ErrorCode::Internal,
                        format!("failed to serialize {} result: {error}", command.as_str()),
                        false,
                        operation_id,
                    )
                })?
            }
            RegisteredCommand::ConversationCreate => {
                let args =
                    serde_json::from_value::<ConversationCreateArgs>(args).map_err(|error| {
                        ErrorEnvelope::new(
                            ErrorCode::BadRequest,
                            format!("invalid arguments for {}: {error}", command.as_str()),
                            false,
                            operation_id,
                        )
                    })?;
                let result = self
                    .core
                    .create_conversation(
                        principal,
                        CreateConversation {
                            workspace_id: args.workspace_id,
                            agent_id: args.agent_id,
                            title: args.title,
                            initial_prompt: args.initial_prompt,
                        },
                    )
                    .await
                    .map_err(|error| {
                        let mut envelope = error.into_envelope();
                        envelope.operation_id = operation_id;
                        envelope
                    })?;
                serde_json::to_value(result).map_err(|error| {
                    ErrorEnvelope::new(
                        ErrorCode::Internal,
                        format!("failed to serialize {} result: {error}", command.as_str()),
                        false,
                        operation_id,
                    )
                })?
            }
            RegisteredCommand::ConversationChildCreate => {
                let args = parse_args::<ConversationChildCreateArgs>(command, operation_id, args)?;
                let result = self
                    .core
                    .create_child_conversation(principal, operation_id.as_uuid(), args.request)
                    .await
                    .map_err(|error| with_operation_id(error, operation_id))?;
                serialize_result(command, operation_id, result)?
            }
            RegisteredCommand::ConversationOutput => {
                let args = parse_args::<ConversationOutputArgs>(command, operation_id, args)?;
                let result = self
                    .core
                    .conversation_output(principal, args.conversation_id)
                    .await
                    .map_err(|error| with_operation_id(error, operation_id))?;
                serialize_result(command, operation_id, result)?
            }
            RegisteredCommand::ConversationStartTurn => {
                let args =
                    serde_json::from_value::<ConversationStartTurnArgs>(args).map_err(|error| {
                        ErrorEnvelope::new(
                            ErrorCode::BadRequest,
                            format!("invalid arguments for {}: {error}", command.as_str()),
                            false,
                            operation_id,
                        )
                    })?;
                let result = self
                    .core
                    .start_conversation_turn(principal, operation_id.as_uuid(), args.request)
                    .await
                    .map_err(|error| {
                        let mut envelope = error.into_envelope();
                        envelope.operation_id = operation_id;
                        envelope
                    })?;
                serde_json::to_value(result).map_err(|error| {
                    ErrorEnvelope::new(
                        ErrorCode::Internal,
                        format!("failed to serialize {} result: {error}", command.as_str()),
                        false,
                        operation_id,
                    )
                })?
            }
            RegisteredCommand::ConversationSteer => {
                let args =
                    serde_json::from_value::<ConversationSteerArgs>(args).map_err(|error| {
                        ErrorEnvelope::new(
                            ErrorCode::BadRequest,
                            format!("invalid arguments for {}: {error}", command.as_str()),
                            false,
                            operation_id,
                        )
                    })?;
                let result = self
                    .core
                    .steer_conversation_turn(principal, operation_id.as_uuid(), args.request)
                    .await
                    .map_err(|error| with_operation_id(error, operation_id))?;
                serialize_result(command, operation_id, result)?
            }
            RegisteredCommand::ConversationInputSubmit => {
                let args = serde_json::from_value::<ConversationInputSubmitArgs>(args).map_err(
                    |error| {
                        ErrorEnvelope::new(
                            ErrorCode::BadRequest,
                            format!("invalid arguments for {}: {error}", command.as_str()),
                            false,
                            operation_id,
                        )
                    },
                )?;
                let result = self
                    .core
                    .submit_conversation_input(principal, operation_id.as_uuid(), args.request)
                    .await
                    .map_err(|error| with_operation_id(error, operation_id))?;
                serialize_result(command, operation_id, result)?
            }
            RegisteredCommand::ConversationInputList => {
                let args =
                    serde_json::from_value::<ConversationInputListArgs>(args).map_err(|error| {
                        ErrorEnvelope::new(
                            ErrorCode::BadRequest,
                            format!("invalid arguments for {}: {error}", command.as_str()),
                            false,
                            operation_id,
                        )
                    })?;
                let result = self
                    .core
                    .list_conversation_inputs(principal, args.request)
                    .await
                    .map_err(|error| with_operation_id(error, operation_id))?;
                serialize_result(command, operation_id, result)?
            }
            RegisteredCommand::ConversationRelationList => {
                let args = serde_json::from_value::<ConversationRelationListArgs>(args).map_err(
                    |error| {
                        ErrorEnvelope::new(
                            ErrorCode::BadRequest,
                            format!("invalid arguments for {}: {error}", command.as_str()),
                            false,
                            operation_id,
                        )
                    },
                )?;
                let result = self
                    .core
                    .list_conversation_relations(principal, args.request)
                    .await
                    .map_err(|error| with_operation_id(error, operation_id))?;
                serialize_result(command, operation_id, result)?
            }
            RegisteredCommand::ConversationInputUpdate => {
                let args = serde_json::from_value::<ConversationInputUpdateArgs>(args).map_err(
                    |error| {
                        ErrorEnvelope::new(
                            ErrorCode::BadRequest,
                            format!("invalid arguments for {}: {error}", command.as_str()),
                            false,
                            operation_id,
                        )
                    },
                )?;
                let result = self
                    .core
                    .update_conversation_input(principal, operation_id.as_uuid(), args.request)
                    .await
                    .map_err(|error| with_operation_id(error, operation_id))?;
                serialize_result(command, operation_id, result)?
            }
            RegisteredCommand::ConversationInputReorder => {
                let args = serde_json::from_value::<ConversationInputReorderArgs>(args).map_err(
                    |error| {
                        ErrorEnvelope::new(
                            ErrorCode::BadRequest,
                            format!("invalid arguments for {}: {error}", command.as_str()),
                            false,
                            operation_id,
                        )
                    },
                )?;
                let result = self
                    .core
                    .reorder_conversation_input(principal, operation_id.as_uuid(), args.request)
                    .await
                    .map_err(|error| with_operation_id(error, operation_id))?;
                serialize_result(command, operation_id, result)?
            }
            RegisteredCommand::ConversationInputCancel => {
                let args = serde_json::from_value::<ConversationInputCancelArgs>(args).map_err(
                    |error| {
                        ErrorEnvelope::new(
                            ErrorCode::BadRequest,
                            format!("invalid arguments for {}: {error}", command.as_str()),
                            false,
                            operation_id,
                        )
                    },
                )?;
                let result = self
                    .core
                    .cancel_conversation_input(principal, operation_id.as_uuid(), args.request)
                    .await
                    .map_err(|error| with_operation_id(error, operation_id))?;
                serialize_result(command, operation_id, result)?
            }
            RegisteredCommand::ConversationRespondPermission => {
                let args = serde_json::from_value::<ConversationRespondPermissionArgs>(args)
                    .map_err(|error| {
                        ErrorEnvelope::new(
                            ErrorCode::BadRequest,
                            format!("invalid arguments for {}: {error}", command.as_str()),
                            false,
                            operation_id,
                        )
                    })?;
                self.core
                    .respond_conversation_permission(principal, args.request)
                    .await
                    .map_err(|error| {
                        let mut envelope = error.into_envelope();
                        envelope.operation_id = operation_id;
                        envelope
                    })?;
                serde_json::Value::Null
            }
            RegisteredCommand::ConversationRespondQuestion => {
                let args = serde_json::from_value::<ConversationRespondQuestionArgs>(args)
                    .map_err(|error| {
                        ErrorEnvelope::new(
                            ErrorCode::BadRequest,
                            format!("invalid arguments for {}: {error}", command.as_str()),
                            false,
                            operation_id,
                        )
                    })?;
                self.core
                    .respond_conversation_question(principal, args.request)
                    .await
                    .map_err(|error| {
                        let mut envelope = error.into_envelope();
                        envelope.operation_id = operation_id;
                        envelope
                    })?;
                serde_json::Value::Null
            }
            RegisteredCommand::ConversationCancelTurn => {
                let args = serde_json::from_value::<ConversationCancelTurnArgs>(args).map_err(
                    |error| {
                        ErrorEnvelope::new(
                            ErrorCode::BadRequest,
                            format!("invalid arguments for {}: {error}", command.as_str()),
                            false,
                            operation_id,
                        )
                    },
                )?;
                self.core
                    .cancel_conversation_turn(principal, args.request)
                    .await
                    .map_err(|error| {
                        let mut envelope = error.into_envelope();
                        envelope.operation_id = operation_id;
                        envelope
                    })?;
                serde_json::Value::Null
            }
            RegisteredCommand::WorkflowPublish => {
                let args = parse_args::<WorkflowPublishArgs>(command, operation_id, args)?;
                let result = self
                    .core
                    .publish_workflow(principal, operation_id.as_uuid(), args.request)
                    .await
                    .map_err(|error| with_operation_id(error, operation_id))?;
                serialize_result(command, operation_id, result)?
            }
            RegisteredCommand::WorkflowValidate => {
                let args = parse_args::<WorkflowValidateArgs>(command, operation_id, args)?;
                let result = self
                    .core
                    .validate_workflow(principal, args.request)
                    .await
                    .map_err(|error| with_operation_id(error, operation_id))?;
                serialize_result(command, operation_id, result)?
            }
            RegisteredCommand::WorkflowStart => {
                let args = parse_args::<WorkflowStartArgs>(command, operation_id, args)?;
                let result = self
                    .core
                    .start_workflow(principal, operation_id.as_uuid(), args.request)
                    .await
                    .map_err(|error| with_operation_id(error, operation_id))?;
                serialize_result(command, operation_id, result)?
            }
            RegisteredCommand::WorkflowDebug => {
                let args = parse_args::<WorkflowDebugArgs>(command, operation_id, args)?;
                let result = self
                    .core
                    .debug_workflow(principal, operation_id.as_uuid(), args.request)
                    .await
                    .map_err(|error| with_operation_id(error, operation_id))?;
                serialize_result(command, operation_id, result)?
            }
            RegisteredCommand::WorkflowShow => {
                let args = parse_args::<WorkflowRunArgs>(command, operation_id, args)?;
                let result = self
                    .core
                    .show_workflow(principal, args.run_id)
                    .await
                    .map_err(|error| with_operation_id(error, operation_id))?;
                serialize_result(command, operation_id, result)?
            }
            RegisteredCommand::WorkflowVersion => {
                let args = parse_args::<WorkflowVersionArgs>(command, operation_id, args)?;
                let result = self
                    .core
                    .workflow_version(principal, args.version_id)
                    .await
                    .map_err(|error| with_operation_id(error, operation_id))?;
                serialize_result(command, operation_id, result)?
            }
            RegisteredCommand::WorkflowList => {
                let args = parse_args::<WorkflowListArgs>(command, operation_id, args)?;
                let result = self
                    .core
                    .workflow_definitions(principal, args.limit)
                    .await
                    .map_err(|error| with_operation_id(error, operation_id))?;
                serialize_result(command, operation_id, result)?
            }
            RegisteredCommand::WorkflowVersions => {
                let args = parse_args::<WorkflowVersionsArgs>(command, operation_id, args)?;
                let result = self
                    .core
                    .workflow_versions(principal, args.definition_id, args.limit)
                    .await
                    .map_err(|error| with_operation_id(error, operation_id))?;
                serialize_result(command, operation_id, result)?
            }
            RegisteredCommand::WorkflowSteps => {
                let args = parse_args::<WorkflowRunArgs>(command, operation_id, args)?;
                let result = self
                    .core
                    .workflow_steps(principal, args.run_id)
                    .await
                    .map_err(|error| with_operation_id(error, operation_id))?;
                serialize_result(command, operation_id, result)?
            }
            RegisteredCommand::WorkflowEvents => {
                let args = parse_args::<WorkflowEventsArgs>(command, operation_id, args)?;
                let result = self
                    .core
                    .workflow_events(principal, args.run_id, args.after_sequence, args.limit)
                    .await
                    .map_err(|error| with_operation_id(error, operation_id))?;
                serialize_result(command, operation_id, result)?
            }
            RegisteredCommand::WorkflowCompleteStep => {
                let args = parse_args::<WorkflowCompleteStepArgs>(command, operation_id, args)?;
                let result = self
                    .core
                    .complete_workflow_step(principal, args.request)
                    .await
                    .map_err(|error| with_operation_id(error, operation_id))?;
                serialize_result(command, operation_id, result)?
            }
            RegisteredCommand::WorkflowDecide => {
                let args = parse_args::<WorkflowDecideArgs>(command, operation_id, args)?;
                let result = self
                    .core
                    .decide_workflow(principal, operation_id.as_uuid(), args.request)
                    .await
                    .map_err(|error| with_operation_id(error, operation_id))?;
                serialize_result(command, operation_id, result)?
            }
            RegisteredCommand::WorkflowCancel => {
                let args = parse_args::<WorkflowCancelArgs>(command, operation_id, args)?;
                let result = self
                    .core
                    .cancel_workflow(principal, operation_id.as_uuid(), args.request)
                    .await
                    .map_err(|error| with_operation_id(error, operation_id))?;
                serialize_result(command, operation_id, result)?
            }
            RegisteredCommand::WorkflowResume => {
                let args = parse_args::<WorkflowResumeArgs>(command, operation_id, args)?;
                let result = self
                    .core
                    .resume_workflow(principal, operation_id.as_uuid(), args.request)
                    .await
                    .map_err(|error| with_operation_id(error, operation_id))?;
                serialize_result(command, operation_id, result)?
            }
            RegisteredCommand::WorkflowPause => {
                let args = parse_args::<WorkflowPauseArgs>(command, operation_id, args)?;
                let result = self
                    .core
                    .pause_workflow(principal, operation_id.as_uuid(), args.request)
                    .await
                    .map_err(|error| with_operation_id(error, operation_id))?;
                serialize_result(command, operation_id, result)?
            }
            RegisteredCommand::WorkflowResumeRun => {
                let args = parse_args::<WorkflowResumeRunArgs>(command, operation_id, args)?;
                let result = self
                    .core
                    .resume_paused_workflow(principal, operation_id.as_uuid(), args.request)
                    .await
                    .map_err(|error| with_operation_id(error, operation_id))?;
                serialize_result(command, operation_id, result)?
            }
            RegisteredCommand::WorkflowAcceptCandidate => {
                let args = parse_args::<WorkflowAcceptCandidateArgs>(command, operation_id, args)?;
                let result = self
                    .core
                    .accept_workflow_candidate(principal, operation_id.as_uuid(), args.request)
                    .await
                    .map_err(|error| with_operation_id(error, operation_id))?;
                serialize_result(command, operation_id, result)?
            }
            RegisteredCommand::WorkflowPauseStep => {
                let args = parse_args::<WorkflowPauseStepArgs>(command, operation_id, args)?;
                let result = self
                    .core
                    .pause_workflow_step(principal, args.request)
                    .await
                    .map_err(|error| with_operation_id(error, operation_id))?;
                serialize_result(command, operation_id, result)?
            }
            RegisteredCommand::WorkflowStepInput => {
                let args = parse_args::<WorkflowStepInputArgs>(command, operation_id, args)?;
                let result = self
                    .core
                    .submit_workflow_step_input(principal, operation_id.as_uuid(), args.request)
                    .await
                    .map_err(|error| with_operation_id(error, operation_id))?;
                serialize_result(command, operation_id, result)?
            }
            RegisteredCommand::WorkflowFork => {
                let args = parse_args::<WorkflowForkArgs>(command, operation_id, args)?;
                let result = self
                    .core
                    .fork_workflow_from_step(principal, operation_id.as_uuid(), args.request)
                    .await
                    .map_err(|error| with_operation_id(error, operation_id))?;
                serialize_result(command, operation_id, result)?
            }
            RegisteredCommand::Domain(command) => self
                .core
                .execute_domain(principal, command, args)
                .await
                .map_err(|error| {
                    let mut envelope = error.into_envelope();
                    envelope.operation_id = operation_id;
                    envelope
                })?,
        };

        Ok(CommandResponse::new(operation_id, data))
    }
}

fn parse_args<T: for<'de> Deserialize<'de>>(
    command: RegisteredCommand,
    operation_id: OperationId,
    args: serde_json::Value,
) -> Result<T, ErrorEnvelope> {
    serde_json::from_value(args).map_err(|error| {
        ErrorEnvelope::new(
            ErrorCode::BadRequest,
            format!("invalid arguments for {}: {error}", command.as_str()),
            false,
            operation_id,
        )
    })
}

fn with_operation_id(error: crate::ApplicationError, operation_id: OperationId) -> ErrorEnvelope {
    let mut envelope = error.into_envelope();
    envelope.operation_id = operation_id;
    envelope
}

fn serialize_result(
    command: RegisteredCommand,
    operation_id: OperationId,
    result: impl serde::Serialize,
) -> Result<serde_json::Value, ErrorEnvelope> {
    serde_json::to_value(result).map_err(|error| {
        ErrorEnvelope::new(
            ErrorCode::Internal,
            format!("failed to serialize {} result: {error}", command.as_str()),
            false,
            operation_id,
        )
    })
}
