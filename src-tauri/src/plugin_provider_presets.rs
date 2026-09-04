//! Backs the plugin `provider.presets.*` capability with VibeX's own model
//! provider store (ADR-0063) and the confirmation ADR-0069 requires before a
//! plugin may re-point an agent.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use plugins::{
    ProviderBindDecision, ProviderBindRequest, ProviderPreset, ProviderPresetDraft,
    ProviderPresetError, ProviderPresetErrorCode, ProviderPresetHost,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;
use ts_rs::TS;

use crate::{
    commands::agent_management::{
        apply_model_provider_bind, list_model_providers, save_model_provider,
    },
    state::AppState,
};

/// A prompt left unanswered this long is treated as a decline. Without it a
/// plugin could park a Worker forever on a dialog the user closed with the
/// window chrome.
const CONFIRMATION_TIMEOUT: Duration = Duration::from_secs(180);

/// Emitted to every webview when a plugin asks to bind a provider.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProviderBindConfirmation {
    pub request_id: String,
    pub plugin_id: String,
    pub plugin_name: String,
    pub agent_id: String,
    /// `None` means the plugin is asking to unbind the agent.
    pub preset_id: Option<String>,
    pub preset_name: Option<String>,
    pub api_url: Option<String>,
    /// Plugin-supplied justification. Rendered as plain text, never as markup.
    pub reason: Option<String>,
}

#[derive(Default)]
struct PendingConfirmations {
    waiting: Mutex<HashMap<String, oneshot::Sender<bool>>>,
}

impl PendingConfirmations {
    fn park(&self, request_id: String) -> oneshot::Receiver<bool> {
        let (tx, rx) = oneshot::channel();
        self.waiting.lock().unwrap().insert(request_id, tx);
        rx
    }

    fn answer(&self, request_id: &str, approved: bool) -> bool {
        let Some(sender) = self.waiting.lock().unwrap().remove(request_id) else {
            return false;
        };
        sender.send(approved).is_ok()
    }

    fn abandon(&self, request_id: &str) {
        self.waiting.lock().unwrap().remove(request_id);
    }
}

pub struct TauriProviderPresetHost {
    app: AppHandle,
    pending: Arc<PendingConfirmations>,
}

impl TauriProviderPresetHost {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            pending: Arc::new(PendingConfirmations::default()),
        }
    }

    /// Resolves a prompt. Returns false when the request already timed out or
    /// was answered, so a double-click cannot bind twice.
    pub fn resolve(&self, request_id: &str, approved: bool) -> bool {
        self.pending.answer(request_id, approved)
    }

    fn state(&self) -> Result<tauri::State<'_, AppState>, ProviderPresetError> {
        self.app.try_state::<AppState>().ok_or_else(|| {
            ProviderPresetError::new(
                ProviderPresetErrorCode::Unavailable,
                "Application state is not ready",
            )
        })
    }

    async fn confirm(&self, prompt: ProviderBindConfirmation) -> Result<bool, ProviderPresetError> {
        let request_id = prompt.request_id.clone();
        let waiter = self.pending.park(request_id.clone());
        // Addressed to the main window, not broadcast. Every webview mounts the
        // listener, so a broadcast would raise the same modal in the rail and
        // toast windows too, and whichever one was dismissed first would decide
        // the answer for all of them.
        self.app
            .emit_to(
                tauri::EventTarget::webview_window("main"),
                crate::events::channels::PROVIDER_BIND_CONFIRM,
                &prompt,
            )
            .map_err(|error| {
                self.pending.abandon(&request_id);
                ProviderPresetError::new(ProviderPresetErrorCode::Unavailable, error.to_string())
            })?;
        match tokio::time::timeout(CONFIRMATION_TIMEOUT, waiter).await {
            Ok(Ok(approved)) => Ok(approved),
            // Sender dropped (window closed) or the prompt expired. Both mean
            // nobody said yes.
            Ok(Err(_)) => Ok(false),
            Err(_) => {
                self.pending.abandon(&request_id);
                Ok(false)
            }
        }
    }
}

#[async_trait]
impl ProviderPresetHost for TauriProviderPresetHost {
    async fn list(
        &self,
        agent_id: Option<&str>,
    ) -> Result<Vec<ProviderPreset>, ProviderPresetError> {
        let agent_id = agent_id.ok_or_else(|| {
            ProviderPresetError::new(
                ProviderPresetErrorCode::UnknownAgent,
                "agentId is required to list provider presets",
            )
        })?;
        let state = self.state()?;
        let view = list_model_providers(&self.app, &state, parse_agent(agent_id)?)
            .await
            .map_err(store_failed)?;
        Ok(view.providers.into_iter().map(as_preset).collect())
    }

    async fn save(
        &self,
        _plugin_id: &str,
        draft: ProviderPresetDraft,
    ) -> Result<ProviderPreset, ProviderPresetError> {
        let state = self.state()?;
        let agent_id = parse_agent(&draft.agent_id)?;
        let api_url = draft.api_url.trim().to_owned();
        let view = save_model_provider(
            &self.app,
            &state,
            api_types::agent_management::AgentModelProviderSaveRequest {
                id: draft.id,
                name: draft.name,
                agent_id: agent_id.clone(),
                api_url: draft.api_url,
                api_key: draft.api_key,
                model: draft.model.unwrap_or_default(),
            },
        )
        .await
        .map_err(rejected)?;
        view.providers
            .into_iter()
            .find(|provider| provider.api_url == api_url && provider.agent_id == agent_id)
            .map(as_preset)
            .ok_or_else(|| {
                ProviderPresetError::new(
                    ProviderPresetErrorCode::StoreFailed,
                    "Saved preset did not come back from the store",
                )
            })
    }

    async fn bind(
        &self,
        plugin_id: &str,
        request: ProviderBindRequest,
    ) -> Result<ProviderBindDecision, ProviderPresetError> {
        let state = self.state()?;
        let agent_id = parse_agent(&request.agent_id)?;
        let view = list_model_providers(&self.app, &state, agent_id.clone())
            .await
            .map_err(store_failed)?;
        // Resolve the preset before prompting so the dialog can name what the
        // user is about to point the agent at, and so a bogus id fails without
        // ever bothering them.
        let target = match request.preset_id.as_deref() {
            Some(preset_id) => Some(
                view.providers
                    .iter()
                    .find(|provider| provider.id == preset_id)
                    .ok_or_else(|| {
                        ProviderPresetError::new(
                            ProviderPresetErrorCode::PresetNotFound,
                            format!("No provider preset {preset_id} for {}", request.agent_id),
                        )
                    })?,
            ),
            None => None,
        };
        let already_bound = match request.preset_id.as_deref() {
            Some(preset_id) => view
                .providers
                .iter()
                .any(|provider| provider.id == preset_id && provider.bound),
            None => !view.providers.iter().any(|provider| provider.bound),
        };
        if already_bound {
            // Already where the plugin wants it. Prompting would train the user
            // to click through dialogs that change nothing.
            return Ok(ProviderBindDecision::Applied);
        }
        let plugin_name = state
            .plugin_control_plane
            .installed_plugin_name(plugin_id)
            .await
            .unwrap_or_else(|| plugin_id.to_owned());
        let approved = self
            .confirm(ProviderBindConfirmation {
                request_id: uuid::Uuid::new_v4().to_string(),
                plugin_id: plugin_id.to_owned(),
                plugin_name,
                agent_id: request.agent_id.clone(),
                preset_id: request.preset_id.clone(),
                preset_name: target.map(|provider| provider.name.clone()),
                api_url: target.map(|provider| provider.api_url.clone()),
                reason: request.reason.clone(),
            })
            .await?;
        if !approved {
            return Ok(ProviderBindDecision::Declined);
        }
        apply_model_provider_bind(&self.app, &state, agent_id, request.preset_id)
            .await
            .map_err(rejected)?;
        Ok(ProviderBindDecision::Applied)
    }
}

/// Plugin-supplied agent ids are untrusted text; `AgentId` is the validated
/// form the rest of the Host speaks.
fn parse_agent(raw: &str) -> Result<api_types::AgentId, ProviderPresetError> {
    api_types::AgentId::parse(raw).map_err(|error| {
        ProviderPresetError::new(ProviderPresetErrorCode::UnknownAgent, error.to_string())
    })
}

/// Drops the stored API key on the way out — a plugin gets to know a
/// credential exists, never what it is.
fn as_preset(provider: api_types::agent_management::AgentModelProviderView) -> ProviderPreset {
    ProviderPreset {
        id: provider.id,
        name: provider.name,
        agent_id: provider.agent_id.into_string(),
        api_url: provider.api_url,
        model: Some(provider.model).filter(|value| !value.is_empty()),
        has_api_key: provider.credential_present,
        bound: provider.bound,
    }
}

fn store_failed(
    error: api_types::agent_management::AgentManagementErrorView,
) -> ProviderPresetError {
    ProviderPresetError::new(ProviderPresetErrorCode::StoreFailed, error.message)
}

fn rejected(error: api_types::agent_management::AgentManagementErrorView) -> ProviderPresetError {
    ProviderPresetError::new(ProviderPresetErrorCode::Rejected, error.message)
}
