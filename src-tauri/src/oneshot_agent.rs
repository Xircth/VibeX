//! Throwaway ACP turns used by settings-driven helpers such as prompt
//! enhancement and PR description generation.

use std::time::Duration;

use agents::{
    AgentContentBlock, AgentSessionId, EnsureAgentSessionInput, SendAgentPromptInput,
    events::{AgentEvent, AgentEventEnvelope, AgentSessionConfigOverride},
    permissions::AgentAutoApproveMode,
    runtime::AgentRuntime,
    state::{AgentPromptStatus, AgentSessionSnapshot},
};
use api_types::AgentId;
use tokio::sync::broadcast::{self, error::RecvError};
use uuid::Uuid;

use crate::{error::AppError, state::AppState};

const ONESHOT_WORKSPACE_ID: Uuid = Uuid::nil();

pub struct OneshotAgentTurn {
    pub agent_id: AgentId,
    pub prompt: String,
    pub mode_override: Option<String>,
    pub config_overrides: Vec<AgentSessionConfigOverride>,
    pub timeout: Duration,
    pub failure_prefix: &'static str,
}

pub async fn validated_enabled_agent(
    configured_agent: Option<&str>,
    pool: &sqlx::SqlitePool,
    settings_path: &str,
    purpose: &str,
) -> Result<AgentId, AppError> {
    let Some(raw_agent_id) = configured_agent else {
        return Err(AppError::BadRequest(format!(
            "Choose an Agent in Settings → {settings_path} before using {purpose}."
        )));
    };
    let agent_id = AgentId::parse(raw_agent_id).map_err(|_| {
        AppError::BadRequest(format!(
            "The saved {purpose} Agent `{raw_agent_id}` is not valid. Choose an Agent in Settings → {settings_path}."
        ))
    })?;
    let enabled = sqlx::query_scalar::<_, i64>(
        r#"SELECT COUNT(*)
           FROM agent_membership membership
           JOIN agent_installation installation
             ON installation.agent_id = membership.agent_id
           WHERE membership.agent_id = ?
             AND membership.enabled = 1
             AND membership.retired = 0
             AND installation.current_lock_id IS NOT NULL"#,
    )
    .bind(agent_id.as_str())
    .fetch_one(pool)
    .await
    .map_err(|error| AppError::Internal(error.to_string()))?;
    if enabled == 0 {
        return Err(AppError::BadRequest(format!(
            "The saved {purpose} Agent `{agent_id}` is not enabled. Choose an enabled Agent in Settings → {settings_path}."
        )));
    }
    Ok(agent_id)
}

pub async fn run_oneshot_agent_turn(
    state: &AppState,
    turn: OneshotAgentTurn,
) -> Result<String, AppError> {
    let launch = crate::commands::agents::agent_runtime_launch_settings_for_session_from_pool(
        &state.deployment.db().pool,
        &turn.agent_id,
    )
    .await?;
    let runtime = &state.agent_runtime;
    let events = runtime.subscribe_events();
    let session = crate::commands::agents::settle_session_authentication(
        &state.deployment.db().pool,
        &turn.agent_id,
        runtime
            .ensure_session(EnsureAgentSessionInput {
                agent_id: turn.agent_id.clone(),
                launch_lock: launch.launch_lock,
                workspace_id: ONESHOT_WORKSPACE_ID,
                working_dir: std::env::temp_dir(),
                additional_directories: Vec::new(),
                session_id: AgentSessionId::new(),
                acp_session_id: String::new(),
                auto_approve_mode: AgentAutoApproveMode::Off,
                env: launch.env,
            })
            .await,
    )
    .await?;

    let result = collect_oneshot_response(runtime, events, &session, &turn).await;
    let _ = runtime.disconnect(session.connection_id).await;
    result
}

async fn collect_oneshot_response(
    runtime: &AgentRuntime,
    events: broadcast::Receiver<AgentEventEnvelope>,
    session: &AgentSessionSnapshot,
    turn: &OneshotAgentTurn,
) -> Result<String, AppError> {
    let prompt = runtime
        .send_prompt(SendAgentPromptInput {
            connection_id: session.connection_id,
            session_id: session.id,
            blocks: vec![AgentContentBlock::Text {
                text: turn.prompt.clone(),
            }],
            mode_override: turn.mode_override.clone(),
            config_overrides: turn.config_overrides.clone(),
        })
        .await
        .map_err(|error| {
            AppError::Internal(format!(
                "Failed to run {} Agent: {error}",
                turn.failure_prefix
            ))
        })?;

    if let AgentPromptStatus::Failed { message } = &prompt.status {
        return Err(AppError::Internal(format!(
            "{} Agent failed: {message}",
            turn.failure_prefix
        )));
    }

    match tokio::time::timeout(turn.timeout, collect_response_text(events, session, turn)).await {
        Ok(result) => result,
        Err(_) => Err(AppError::Internal(format!(
            "{} Agent timed out after {} seconds",
            turn.failure_prefix,
            turn.timeout.as_secs()
        ))),
    }
}

async fn collect_response_text(
    mut events: broadcast::Receiver<AgentEventEnvelope>,
    session: &AgentSessionSnapshot,
    turn: &OneshotAgentTurn,
) -> Result<String, AppError> {
    let mut response_text = String::new();

    loop {
        let envelope = match events.recv().await {
            Ok(envelope) => envelope,
            Err(RecvError::Lagged(_)) => continue,
            Err(RecvError::Closed) => {
                return Err(AppError::Internal(format!(
                    "{} failed: Agent event stream closed",
                    turn.failure_prefix
                )));
            }
        };

        if envelope.session_id != Some(session.id) {
            if envelope.connection_id == session.connection_id
                && let AgentEvent::Error { error } = envelope.event
            {
                return Err(AppError::Internal(format!(
                    "{} Agent failed: {}",
                    turn.failure_prefix, error.message
                )));
            }
            continue;
        }

        match envelope.event {
            AgentEvent::MessageChunk {
                content: AgentContentBlock::Text { text },
            } => response_text.push_str(&text),
            AgentEvent::PromptFinished { .. } => return Ok(response_text),
            AgentEvent::Error { error } => {
                return Err(AppError::Internal(format!(
                    "{} Agent failed: {}",
                    turn.failure_prefix, error.message
                )));
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn oneshot_agent_requires_a_configured_agent() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:")
            .await
            .expect("memory sqlite");
        let error = validated_enabled_agent(None, &pool, "General", "prompt enhancement")
            .await
            .expect_err("missing agent");
        assert!(matches!(
            error,
            AppError::BadRequest(message) if message.contains("Settings → General")
        ));
    }

    #[test]
    fn oneshot_agent_rejects_an_invalid_agent_id() {
        assert!(api_types::AgentId::parse("NOT VALID").is_err());
    }
}
