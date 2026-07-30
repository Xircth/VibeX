use std::str::FromStr;

use remote_protocol::{CommandResponse, ErrorCode, ErrorEnvelope, OperationId};
use serde::Deserialize;

use crate::{ApplicationCore, ConversationRepository, ListConversations, Principal};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RegisteredCommand {
    ConversationList,
}

impl RegisteredCommand {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ConversationList => "conversation_list",
        }
    }
}

impl FromStr for RegisteredCommand {
    type Err = ();

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "conversation_list" => Ok(Self::ConversationList),
            _ => Err(()),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationListArgs {
    workspace_id: uuid::Uuid,
}

pub struct CommandRegistry<R> {
    core: ApplicationCore<R>,
}

impl<R> CommandRegistry<R>
where
    R: ConversationRepository,
{
    pub const fn new(core: ApplicationCore<R>) -> Self {
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
        };

        Ok(CommandResponse::new(operation_id, data))
    }
}
