//! ACP-native prompt enhancement.
//!
//! Runs a one-shot OpenCode prompt through the shared [`AgentRuntime`] instead
//! of shelling out to a standalone `opencode run` CLI (the retired legacy
//! executor style). The transport-agnostic pieces (payload building, response
//! extraction, config selection) stay in `services::services::prompt_enhancement`.

use std::time::Duration;

use agents::{
    AgentContentBlock, AgentKind, AgentSessionId, EnsureAgentSessionInput, SendAgentPromptInput,
    events::{AgentEvent, AgentEventEnvelope, AgentSessionConfigOverride},
    permissions::AgentAutoApproveMode,
    runtime::AgentRuntime,
    state::{AgentPromptStatus, AgentSessionSnapshot},
};
use services::services::prompt_enhancement::{
    PROMPT_ENHANCE_TIMEOUT_SECS, PromptEnhancementRequest, PromptEnhancementResponse,
    build_prompt_enhancement_payload, extract_enhanced_prompt, selected_prompt_enhancement_model,
    validate_prompt_enhancement_request,
};
use tokio::sync::broadcast::{self, error::RecvError};
use uuid::Uuid;

use crate::{error::AppError, state::AppState};

/// Synthetic workspace id for enhancement sessions so repeated enhancements
/// reuse one warm OpenCode connection instead of respawning the agent.
const ENHANCEMENT_WORKSPACE_ID: Uuid = Uuid::nil();

pub async fn enhance_prompt(
    state: &AppState,
    payload: PromptEnhancementRequest,
) -> Result<PromptEnhancementResponse, AppError> {
    let config = state.deployment.config().read().await.clone();
    validate_prompt_enhancement_request(&config, &payload)?;

    let prompt_text = build_prompt_enhancement_payload(&config, &payload)?;
    let catalog_models =
        crate::commands::agents::opencode_capability_catalog_models(&state.deployment.db().pool)
            .await?;
    let model = validated_prompt_enhancement_model(
        selected_prompt_enhancement_model(&config),
        &catalog_models,
    )?;
    let runtime = &state.agent_runtime;
    // Prompt enhancement is deliberately non-interactive, but it must still
    // use the same verified local OpenCode Runtime/ACP path as every other
    // session. Otherwise this hidden session could fall back to a bundled or
    // different PATH runtime.
    let launch = crate::commands::agents::agent_runtime_launch_settings_from_pool(
        &state.deployment.db().pool,
        AgentKind::Opencode,
    )
    .await?;

    // Subscribe before dispatching so no chunk can slip past the receiver.
    let events = runtime.subscribe_events();

    let session = runtime
        .ensure_session(EnsureAgentSessionInput {
            agent_type: AgentKind::Opencode,
            workspace_id: ENHANCEMENT_WORKSPACE_ID,
            working_dir: std::env::temp_dir(),
            session_id: AgentSessionId::new(),
            acp_session_id: String::new(),
            auto_approve_mode: AgentAutoApproveMode::Off,
            env: launch.env,
        })
        .await
        .map_err(|error| AppError::Internal(format!("Failed to run OpenCode: {error}")))?;

    let enhanced = run_enhancement_turn(runtime, events, &session, prompt_text, &model).await;

    // The enhancement session is throwaway: tear the connection down so it
    // never lingers in the agents UI or holds an OpenCode process alive.
    let _ = runtime.disconnect(session.connection_id).await;

    enhanced.map(|enhanced_prompt| PromptEnhancementResponse {
        enhanced_prompt,
        model,
    })
}

/// Prompt enhancement cannot invent a default model: that would bypass the
/// runtime/config fingerprint used by normal sessions. A saved selection is
/// valid only when it appears in the current verified OpenCode catalog.
fn validated_prompt_enhancement_model(
    configured_model: Option<&str>,
    catalog_models: &[String],
) -> Result<String, AppError> {
    let Some(model) = configured_model else {
        return Err(AppError::BadRequest(
            "Choose an OpenCode model in Settings → General before using prompt enhancement."
                .to_string(),
        ));
    };
    if catalog_models.is_empty() {
        return Err(AppError::BadRequest(
            "OpenCode's verified model catalog is not available yet. Open Settings → General, wait for it to load, then choose a model."
                .to_string(),
        ));
    }
    if !catalog_models.iter().any(|available| available == model) {
        return Err(AppError::BadRequest(format!(
            "The saved OpenCode model `{model}` is not available from the current verified catalog. Choose a model in Settings → General."
        )));
    }
    Ok(model.to_string())
}

async fn run_enhancement_turn(
    runtime: &AgentRuntime,
    events: broadcast::Receiver<AgentEventEnvelope>,
    session: &AgentSessionSnapshot,
    prompt_text: String,
    model: &str,
) -> Result<String, AppError> {
    let prompt = runtime
        .send_prompt(SendAgentPromptInput {
            connection_id: session.connection_id,
            session_id: session.id,
            blocks: vec![AgentContentBlock::Text { text: prompt_text }],
            mode_override: None,
            // This value was checked against the same matching catalog the
            // settings and session selectors use. ACP remains the final
            // authority if the runtime changes after this local read.
            config_overrides: vec![AgentSessionConfigOverride {
                key: "model".to_string(),
                value: model.to_string(),
            }],
        })
        .await
        .map_err(|error| AppError::Internal(format!("Failed to run OpenCode: {error}")))?;

    if let AgentPromptStatus::Failed { message } = &prompt.status {
        return Err(AppError::Internal(format!(
            "OpenCode prompt enhancement failed: {message}"
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
            "OpenCode prompt enhancement timed out after {PROMPT_ENHANCE_TIMEOUT_SECS} seconds"
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
                    "OpenCode prompt enhancement failed: agent event stream closed".to_string(),
                ));
            }
        };

        if envelope.session_id != Some(session.id) {
            if envelope.connection_id == session.connection_id
                && let AgentEvent::Error { error } = envelope.event
            {
                return Err(AppError::Internal(format!(
                    "OpenCode prompt enhancement failed: {}",
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
                        "OpenCode response did not contain a valid EnhancedPrompt field"
                            .to_string()
                    } else {
                        format!(
                            "OpenCode response did not contain a valid EnhancedPrompt field. Raw output: {detail}"
                        )
                    };
                    AppError::Internal(message)
                });
            }
            AgentEvent::Error { error } => {
                return Err(AppError::Internal(format!(
                    "OpenCode prompt enhancement failed: {}",
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

    #[test]
    fn prompt_enhancement_requires_a_catalog_backed_model() {
        assert!(matches!(
            validated_prompt_enhancement_model(None, &["openai/gpt-5.6-sol".to_string()]),
            Err(AppError::BadRequest(message)) if message.contains("Settings → General")
        ));
        assert!(matches!(
            validated_prompt_enhancement_model(Some("openai/gpt-5.6-sol"), &[]),
            Err(AppError::BadRequest(message)) if message.contains("catalog is not available")
        ));
        assert!(matches!(
            validated_prompt_enhancement_model(
                Some("opencode/minimax-m2.5-free"),
                &["openai/gpt-5.6-sol".to_string()],
            ),
            Err(AppError::BadRequest(message)) if message.contains("not available")
        ));
    }

    #[test]
    fn prompt_enhancement_uses_the_exact_catalog_choice() {
        assert_eq!(
            validated_prompt_enhancement_model(
                Some("openai/gpt-5.6-sol"),
                &["openai/gpt-5.6-sol".to_string()],
            )
            .unwrap(),
            "openai/gpt-5.6-sol"
        );
    }
}
