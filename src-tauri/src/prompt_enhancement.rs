//! ACP-native prompt enhancement.
//!
//! Runs a one-shot prompt through the shared [`AgentRuntime`] using the Agent
//! and session config chosen in Settings. The transport-agnostic pieces stay in
//! `services::services::prompt_enhancement`.

use std::time::Duration;

use agents::events::AgentSessionConfigOverride;
use services::services::prompt_enhancement::{
    PROMPT_ENHANCE_TIMEOUT_SECS, PromptEnhancementRequest, PromptEnhancementResponse,
    build_prompt_enhancement_payload, extract_enhanced_prompt, selected_prompt_enhancement_agent,
    validate_prompt_enhancement_request,
};

use crate::{
    error::AppError,
    oneshot_agent::{OneshotAgentTurn, run_oneshot_agent_turn, validated_enabled_agent},
    state::AppState,
};

pub async fn enhance_prompt(
    state: &AppState,
    payload: PromptEnhancementRequest,
) -> Result<PromptEnhancementResponse, AppError> {
    let config = state.deployment.config().read().await.clone();
    validate_prompt_enhancement_request(&config, &payload)?;

    let prompt_text = build_prompt_enhancement_payload(&config, &payload)?;
    let agent_id = validated_enabled_agent(
        selected_prompt_enhancement_agent(&config),
        &state.deployment.db().pool,
        "General",
        "prompt enhancement",
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

    let response_text = run_oneshot_agent_turn(
        state,
        OneshotAgentTurn {
            agent_id,
            prompt: prompt_text,
            mode_override: config.prompt_enhancement_mode.clone(),
            config_overrides,
            timeout: Duration::from_secs(PROMPT_ENHANCE_TIMEOUT_SECS),
            failure_prefix: "Prompt enhancement",
        },
    )
    .await?;

    let enhanced_prompt = extract_enhanced_prompt(&response_text).ok_or_else(|| {
        let detail = response_text.trim();
        let message = if detail.is_empty() {
            "Agent response did not contain a valid EnhancedPrompt field".to_string()
        } else {
            format!(
                "Agent response did not contain a valid EnhancedPrompt field. Raw output: {detail}"
            )
        };
        AppError::Internal(message)
    })?;

    Ok(PromptEnhancementResponse {
        enhanced_prompt,
        model,
    })
}
