use std::{str::FromStr, sync::Arc};

use remote_protocol::{CommandResponse, ErrorCode, ErrorEnvelope, OperationId};
use serde::Deserialize;

use crate::{
    ApplicationCore, CancelConversationTurn, ConversationRepository, CreateConversation,
    DomainCommand, ListConversations, Principal, RespondConversationPermission,
    RespondConversationQuestion, StartConversationTurn,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RegisteredCommand {
    ConversationList,
    ConversationCreate,
    ConversationStartTurn,
    ConversationRespondPermission,
    ConversationRespondQuestion,
    ConversationCancelTurn,
    Domain(DomainCommand),
}

impl RegisteredCommand {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ConversationList => "conversation_list",
            Self::ConversationCreate => "conversation_create",
            Self::ConversationStartTurn => "conversation_start_turn",
            Self::ConversationRespondPermission => "conversation_respond_permission",
            Self::ConversationRespondQuestion => "conversation_respond_question",
            Self::ConversationCancelTurn => "conversation_cancel_turn",
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
            "conversation_start_turn" => Ok(Self::ConversationStartTurn),
            "conversation_respond_permission" => Ok(Self::ConversationRespondPermission),
            "conversation_respond_question" => Ok(Self::ConversationRespondQuestion),
            "conversation_cancel_turn" => Ok(Self::ConversationCancelTurn),
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
struct ConversationStartTurnArgs {
    request: StartConversationTurn,
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
                    .start_conversation_turn(principal, args.request)
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
