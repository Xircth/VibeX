//! Thin Tauri command wrappers for per-agent model-provider configuration.
//!
//! The actual logic (per-agent renderers, secrets store, atomic write + backup,
//! provider model fetch) was sunk into `services::services::provider_config`
//! (架构报告 A-1). These commands only adapt Tauri call arguments and map the
//! service's `ProviderConfigError` back to `AppError`.

use services::services::provider_config;
// Frontend-facing types now live with the logic; re-export them so the command
// signatures (and any `commands::model_provider::*` consumer) keep resolving.
pub use services::services::provider_config::{
    AgentProvidersView, ProviderModelsResult, ProviderPayload, ProviderView, RenderedFile,
};

use crate::error::AppError;

#[tauri::command]
pub async fn list_agent_providers(agent_type: String) -> Result<AgentProvidersView, AppError> {
    Ok(provider_config::list_agent_providers(agent_type).await?)
}

#[tauri::command]
pub async fn create_agent_provider(
    agent_type: String,
    payload: ProviderPayload,
) -> Result<AgentProvidersView, AppError> {
    Ok(provider_config::create_agent_provider(agent_type, payload).await?)
}

#[tauri::command]
pub async fn update_agent_provider(
    agent_type: String,
    provider_id: String,
    payload: ProviderPayload,
) -> Result<AgentProvidersView, AppError> {
    Ok(provider_config::update_agent_provider(agent_type, provider_id, payload).await?)
}

#[tauri::command]
pub async fn delete_agent_provider(
    agent_type: String,
    provider_id: String,
) -> Result<AgentProvidersView, AppError> {
    Ok(provider_config::delete_agent_provider(agent_type, provider_id).await?)
}

#[tauri::command]
pub async fn apply_agent_provider(
    agent_type: String,
    provider_id: String,
) -> Result<AgentProvidersView, AppError> {
    // A provider file can change the models advertised by a running/warming
    // agent. Advance the capability-probe epoch before the atomic config
    // write, so an in-flight probe of the previous provider configuration can
    // never be persisted under the new file revision.
    if let Some(agent_kind) = agents::AgentKind::from_lenient(&agent_type) {
        crate::commands::agents::invalidate_capability_probe(agent_kind);
    }
    Ok(provider_config::apply_agent_provider(agent_type, provider_id).await?)
}

#[tauri::command]
pub async fn preview_agent_provider(
    agent_type: String,
    payload: ProviderPayload,
    provider_id: Option<String>,
) -> Result<Vec<RenderedFile>, AppError> {
    Ok(provider_config::preview_agent_provider(agent_type, payload, provider_id).await?)
}

#[tauri::command]
pub async fn clear_agent_provider_key(
    agent_type: String,
    provider_id: String,
) -> Result<AgentProvidersView, AppError> {
    Ok(provider_config::clear_agent_provider_key(agent_type, provider_id).await?)
}

#[tauri::command]
pub async fn fetch_agent_provider_models(
    agent_type: String,
    provider_id: String,
) -> Result<ProviderModelsResult, AppError> {
    Ok(provider_config::fetch_agent_provider_models(agent_type, provider_id).await?)
}
