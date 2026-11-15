use agents::{AgentId, AgentKind};
use application::ApplicationError;
use conversations::{ConversationSessionService, HandoffError, WorkspaceSessionsChanged};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::{
    domains::{ServerApplicationDomains, internal_error, parse, serialize},
    host::events::COLLABORATION_SPACE_CHANGED_EVENT,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EngineHandoffArgs {
    #[serde(alias = "sessionId", alias = "session_id", alias = "conversation_id")]
    conversation_id: String,
    #[serde(alias = "target_engine")]
    target_engine: String,
    #[serde(default, alias = "token_budget")]
    token_budget: Option<usize>,
}

fn parse_target_agent_id(raw: &str) -> Result<AgentId, ApplicationError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(ApplicationError::bad_request("targetEngine is required"));
    }
    AgentId::parse(trimmed)
        .ok()
        .or_else(|| {
            AgentKind::from_lenient(trimmed)
                .and_then(|kind| AgentId::parse(kind.as_str()).ok())
        })
        .ok_or_else(|| ApplicationError::bad_request(format!("unsupported targetEngine: {trimmed}")))
}

fn map_handoff_error(error: HandoffError) -> ApplicationError {
    match error {
        HandoffError::ConversationNotFound(id) => {
            ApplicationError::not_found(format!("conversation {id} not found"))
        }
        HandoffError::InvalidTokenBudget => {
            ApplicationError::bad_request("tokenBudget must be greater than 0")
        }
        HandoffError::InvalidTargetEngine(_) => ApplicationError::bad_request(error.to_string()),
        HandoffError::RestrictedOwner
        | HandoffError::ActiveTurnInProgress
        | HandoffError::WorkspaceRootMissing(_) => ApplicationError::conflict(error.to_string()),
        HandoffError::Database(err) => internal_error(err),
    }
}

impl ServerApplicationDomains {
    pub(crate) async fn conversation_preview_engine_handoff(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let args: EngineHandoffArgs = parse(args)?;
        let id = Uuid::parse_str(args.conversation_id.trim())
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        let target_agent = parse_target_agent_id(&args.target_engine)?;
        let preview = ConversationSessionService::new(self.conversations.clone())
            .preview_engine_handoff(id, target_agent.as_str(), args.token_budget)
            .await
            .map_err(map_handoff_error)?;
        serialize(preview)
    }

    pub(crate) async fn conversation_confirm_engine_handoff(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let args: EngineHandoffArgs = parse(args)?;
        let id = Uuid::parse_str(args.conversation_id.trim())
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        let target_agent = parse_target_agent_id(&args.target_engine)?;
        let service = ConversationSessionService::new(self.conversations.clone());
        service
            .preflight_engine_handoff(id, &target_agent)
            .await
            .map_err(map_handoff_error)?;
        let confirmation = service
            .confirm_engine_handoff(id, &target_agent)
            .await
            .map_err(map_handoff_error)?;

        self.events.emit(
            "workspace-sessions-changed",
            WorkspaceSessionsChanged {
                workspace_id: confirmation.workspace_id,
                conversation_id: id,
            },
        );
        for evt in confirmation.space_changed_events {
            self.events.emit(COLLABORATION_SPACE_CHANGED_EVENT, evt);
        }

        Ok(Value::Null)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn engine_handoff_args_unwrap_request_envelope_and_normalize_agent_id() {
        let args: EngineHandoffArgs = parse(json!({
            "request": {
                "conversationId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                "targetEngine": "CLAUDE_CODE",
                "tokenBudget": 12000
            }
        }))
        .expect("parse handoff request");
        assert_eq!(args.conversation_id, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
        assert_eq!(args.target_engine, "CLAUDE_CODE");
        assert_eq!(args.token_budget, Some(12000));

        let claude = parse_target_agent_id(&args.target_engine).expect("normalize claude");
        assert_eq!(claude.as_str(), "claude_code");
        let codex = parse_target_agent_id("CODEX").expect("normalize codex");
        assert_eq!(codex.as_str(), "codex");
    }
}
