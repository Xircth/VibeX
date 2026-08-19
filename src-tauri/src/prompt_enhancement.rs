//! ACP-native prompt enhancement.
//!
//! Runs a one-shot prompt through the shared [`AgentRuntime`] using the Agent
//! and session config chosen in Settings. The transport-agnostic pieces stay in
//! `services::services::prompt_enhancement`.

use std::time::Duration;

use agents::{
    AgentContentBlock, AgentSessionId, EnsureAgentSessionInput, SendAgentPromptInput,
    events::{AgentEvent, AgentEventEnvelope, AgentSessionConfigOverride},
    permissions::AgentAutoApproveMode,
    runtime::AgentRuntime,
    state::{AgentPromptStatus, AgentSessionSnapshot},
};
use api_types::AgentId;
use services::services::prompt_enhancement::{
    PROMPT_ENHANCE_TIMEOUT_SECS, PromptEnhancementRequest, PromptEnhancementResponse,
    build_prompt_enhancement_payload, extract_enhanced_prompt, selected_prompt_enhancement_agent,
    validate_prompt_enhancement_request,
};
use tokio::sync::broadcast::{self, error::RecvError};
use uuid::Uuid;

use crate::{error::AppError, state::AppState};

/// Synthetic workspace id for isolated enhancement sessions.
const ENHANCEMENT_WORKSPACE_ID: Uuid = Uuid::nil();

pub async fn enhance_prompt(
    state: &AppState,
    payload: PromptEnhancementRequest,
) -> Result<PromptEnhancementResponse, AppError> {
    let config = state.deployment.config().read().await.clone();
    validate_prompt_enhancement_request(&config, &payload)?;

    let prompt_text = build_prompt_enhancement_payload(&config, &payload)?;
    let agent_id = validated_prompt_enhancement_agent(
        selected_prompt_enhancement_agent(&config),
        &state.deployment.db().pool,
    )
    .await?;
    let runtime = &state.agent_runtime;
    let launch = crate::commands::agents::agent_runtime_launch_settings_for_session_from_pool(
        &state.deployment.db().pool,
        &agent_id,
    )
    .await?;
    let config_overrides = config
        .prompt_enhancement_session_config
        .iter()
        .map(|(key, value)| AgentSessionConfigOverride {
            key: key.clone(),
            value: value.clone(),
        })
        .collect();
    let model = config
        .prompt_enhancement_session_config
        .iter()
        .find(|(key, _)| key.contains("model"))
        .map(|(_, value)| value.clone())
        .unwrap_or_else(|| agent_id.to_string());

    // Subscribe before dispatching so no chunk can slip past the receiver.
    let events = runtime.subscribe_events();

    let session = crate::commands::agents::settle_session_authentication(
        &state.deployment.db().pool,
        &agent_id,
        runtime
            .ensure_session(EnsureAgentSessionInput {
                agent_id: agent_id.clone(),
                launch_lock: launch.launch_lock,
                workspace_id: ENHANCEMENT_WORKSPACE_ID,
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

    let enhanced = run_enhancement_turn(
        runtime,
        events,
        &session,
        prompt_text,
        config.prompt_enhancement_mode.clone(),
        config_overrides,
    )
    .await;

    // The enhancement session is throwaway: tear the connection down so it
    // never lingers in the agents UI or holds an Agent process alive.
    let _ = runtime.disconnect(session.connection_id).await;

    enhanced.map(|enhanced_prompt| PromptEnhancementResponse {
        enhanced_prompt,
        model,
    })
}

async fn validated_prompt_enhancement_agent(
    configured_agent: Option<&str>,
    pool: &sqlx::SqlitePool,
) -> Result<AgentId, AppError> {
    let Some(raw_agent_id) = configured_agent else {
        return Err(AppError::BadRequest(
            "Choose an Agent in Settings → General before using prompt enhancement.".to_string(),
        ));
    };
    let agent_id = AgentId::parse(raw_agent_id).map_err(|_| {
        AppError::BadRequest(format!(
            "The saved prompt-enhancement Agent `{raw_agent_id}` is not valid. Choose an Agent in Settings → General."
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
            "The saved prompt-enhancement Agent `{agent_id}` is not enabled. Choose an enabled Agent in Settings → General."
        )));
    }
    Ok(agent_id)
}

async fn run_enhancement_turn(
    runtime: &AgentRuntime,
    events: broadcast::Receiver<AgentEventEnvelope>,
    session: &AgentSessionSnapshot,
    prompt_text: String,
    mode_override: Option<String>,
    config_overrides: Vec<AgentSessionConfigOverride>,
) -> Result<String, AppError> {
    let prompt = runtime
        .send_prompt(SendAgentPromptInput {
            connection_id: session.connection_id,
            session_id: session.id,
            blocks: vec![AgentContentBlock::Text { text: prompt_text }],
            mode_override,
            config_overrides,
        })
        .await
        .map_err(|error| AppError::Internal(format!("Failed to run enhancement Agent: {error}")))?;

    if let AgentPromptStatus::Failed { message } = &prompt.status {
        return Err(AppError::Internal(format!(
            "Prompt enhancement Agent failed: {message}"
        )));
    }

    match tokio::time::timeout(
        Duration::from_secs(PROMPT_ENHANCE_TIMEOUT_SECS),
        collect_enhanced_prompt(events, session),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(AppError::Internal(format!(
            "Prompt enhancement Agent timed out after {PROMPT_ENHANCE_TIMEOUT_SECS} seconds"
        ))),
    }
}

async fn collect_enhanced_prompt(
    mut events: broadcast::Receiver<AgentEventEnvelope>,
    session: &AgentSessionSnapshot,
) -> Result<String, AppError> {
    let mut response_text = String::new();

    loop {
        let envelope = match events.recv().await {
            Ok(envelope) => envelope,
            Err(RecvError::Lagged(_)) => continue,
            Err(RecvError::Closed) => {
                return Err(AppError::Internal(
                    "Prompt enhancement failed: Agent event stream closed".to_string(),
                ));
            }
        };

        if envelope.session_id != Some(session.id) {
            if envelope.connection_id == session.connection_id
                && let AgentEvent::Error { error } = envelope.event
            {
                return Err(AppError::Internal(format!(
                    "Prompt enhancement Agent failed: {}",
                    error.message
                )));
            }
            continue;
        }

        match envelope.event {
            AgentEvent::MessageChunk {
                content: AgentContentBlock::Text { text },
            } => response_text.push_str(&text),
            AgentEvent::PromptFinished { .. } => {
                return extract_enhanced_prompt(&response_text).ok_or_else(|| {
                    let detail = response_text.trim();
                    let message = if detail.is_empty() {
                        "Agent response did not contain a valid EnhancedPrompt field"
                            .to_string()
                    } else {
                        format!(
                            "Agent response did not contain a valid EnhancedPrompt field. Raw output: {detail}"
                        )
                    };
                    AppError::Internal(message)
                });
            }
            AgentEvent::Error { error } => {
                return Err(AppError::Internal(format!(
                    "Prompt enhancement Agent failed: {}",
                    error.message
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
    async fn prompt_enhancement_requires_a_configured_agent() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:")
            .await
            .expect("memory sqlite");
        let error = validated_prompt_enhancement_agent(None, &pool)
            .await
            .expect_err("missing agent");
        assert!(matches!(
            error,
            AppError::BadRequest(message) if message.contains("Settings → General")
        ));
    }

    #[test]
    fn prompt_enhancement_rejects_an_invalid_agent_id() {
        // Parse happens before the DB lookup.
        assert!(api_types::AgentId::parse("NOT VALID").is_err());
    }
}
