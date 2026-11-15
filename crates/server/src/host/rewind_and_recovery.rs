//! Host commands for pre-flight checkpoint rollback safety verification and
//! session rate-limit auto-resume recovery controls.

use agents::rate_limit_recovery::RateLimitRecoveryError;
use application::ApplicationError;
use conversations::{CheckpointRollbackSafety, RollbackSafetyError};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::domains::{ServerApplicationDomains, internal_error, parse, serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckRollbackSafetyArgs {
    #[serde(alias = "conversation_id", alias = "sessionId", alias = "session_id")]
    conversation_id: Uuid,
    #[serde(default)]
    ordinal: Option<i64>,
    #[serde(default, alias = "checkpoint_id")]
    checkpoint_id: Option<String>,
    #[serde(default, alias = "restore_files")]
    restore_files: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RateLimitUpdateAutoResumeArgs {
    #[serde(alias = "conversation_id", alias = "sessionId", alias = "session_id")]
    conversation_id: Uuid,
    #[serde(alias = "auto_resume")]
    auto_resume: bool,
    #[serde(default, alias = "continuation_prompt")]
    continuation_prompt: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RateLimitCancelWaitArgs {
    #[serde(alias = "conversation_id", alias = "sessionId", alias = "session_id")]
    conversation_id: Uuid,
}

fn unwrap_request(args: Value) -> Value {
    if let Some(inner) = args.get("request")
        && inner.is_object()
    {
        return inner.clone();
    }
    args
}

pub(crate) async fn check_rollback_safety(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let input: CheckRollbackSafetyArgs = parse(unwrap_request(args))?;
    let checkpoint_key = input
        .checkpoint_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| input.ordinal.map(|ord| ord.to_string()))
        .unwrap_or_default();

    let report = CheckpointRollbackSafety::verify_safety(
        domains.writer_pool(),
        input.conversation_id,
        &checkpoint_key,
    )
    .await
    .map_err(|err| match err {
        RollbackSafetyError::ConversationNotFound(_)
        | RollbackSafetyError::CheckpointNotFound { .. } => {
            ApplicationError::not_found(err.to_string())
        }
        RollbackSafetyError::WorkspaceLocked { .. } => ApplicationError::conflict(err.to_string()),
        RollbackSafetyError::Database(_) => internal_error(err),
    })?;

    if report.is_safe_or_degraded()
        && input.restore_files.unwrap_or(false)
        && let Some(ordinal) = input
            .ordinal
            .or_else(|| checkpoint_key.parse::<i64>().ok())
    {
        let service =
            conversations::ConversationSessionService::new(domains.conversations.clone());
        if let Err(preflight_err) = service
            .preflight_rewind(input.conversation_id, ordinal, true)
            .await
        {
            return match preflight_err {
                conversations::ConversationServiceError::NotFound(msg) => {
                    Err(ApplicationError::not_found(msg))
                }
                conversations::ConversationServiceError::Conflict(reason)
                | conversations::ConversationServiceError::BadRequest(reason) => {
                    serialize(conversations::RollbackSafetyReport::Unsafe { reason })
                }
                other => Err(internal_error(other)),
            };
        }
    }

    serialize(report)
}

pub(crate) async fn update_rate_limit_auto_resume(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let input: RateLimitUpdateAutoResumeArgs = parse(unwrap_request(args))?;
    match domains.rate_limit_recovery.set_auto_resume(
        input.conversation_id,
        input.auto_resume,
        input.continuation_prompt,
    ) {
        Ok(state) => {
            domains.events.emit(
                "conversation-events",
                json!({
                    "conversationId": input.conversation_id,
                    "kind": "rate_limit_updated",
                    "rateLimit": state,
                }),
            );
            Ok(Value::Null)
        }
        Err(RateLimitRecoveryError::SessionNotRateLimited(_)) => Ok(Value::Null),
        Err(other) => Err(ApplicationError::bad_request(other.to_string())),
    }
}

pub(crate) async fn cancel_rate_limit_wait(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let input: RateLimitCancelWaitArgs = parse(unwrap_request(args))?;
    if domains.rate_limit_recovery.cancel_wait(input.conversation_id) {
        domains.events.emit(
            "conversation-events",
            json!({
                "conversationId": input.conversation_id,
                "kind": "rate_limit_cancelled",
            }),
        );
    }
    Ok(Value::Null)
}
