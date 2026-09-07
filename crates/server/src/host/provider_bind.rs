use std::sync::Arc;

use async_trait::async_trait;
use plugins::{
    PROVIDER_BIND_CONFIRMATION_TIMEOUT, PluginControlPlane, ProviderBindDecision,
    ProviderBindPrompts, ProviderBindRequest, ProviderPreset, ProviderPresetDraft,
    ProviderPresetError, ProviderPresetErrorCode, ProviderPresetHost,
};
use serde::Deserialize;
use serde_json::json;
use sqlx::SqlitePool;
use uuid::Uuid;

use super::{
    events::HostEventBus,
    native_commands::{
        dispatch_model_provider_bind, dispatch_model_provider_save, dispatch_model_providers,
    },
};

pub const PROVIDER_BIND_CONFIRM_CHANNEL: &str = "provider-bind-confirm";

#[derive(Clone)]
pub struct HostProviderPresetHost {
    pool: SqlitePool,
    events: Arc<HostEventBus>,
    prompts: Arc<ProviderBindPrompts>,
    plugins: Arc<PluginControlPlane>,
}

impl HostProviderPresetHost {
    pub fn new(
        pool: SqlitePool,
        events: Arc<HostEventBus>,
        prompts: Arc<ProviderBindPrompts>,
        plugins: Arc<PluginControlPlane>,
    ) -> Self {
        Self {
            pool,
            events,
            prompts,
            plugins,
        }
    }

    pub fn prompts(&self) -> Arc<ProviderBindPrompts> {
        Arc::clone(&self.prompts)
    }

    pub fn resolve(&self, request_id: &str, approved: bool) -> bool {
        self.prompts.answer(request_id, approved)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderListView {
    #[serde(default)]
    providers: Vec<ProviderRow>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderRow {
    id: String,
    name: String,
    agent_id: String,
    api_url: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    credential_present: bool,
    #[serde(default)]
    bound: bool,
}

impl From<ProviderRow> for ProviderPreset {
    fn from(provider: ProviderRow) -> Self {
        Self {
            id: provider.id,
            name: provider.name,
            agent_id: provider.agent_id,
            api_url: provider.api_url,
            model: Some(provider.model).filter(|value| !value.is_empty()),
            has_api_key: provider.credential_present,
            bound: provider.bound,
        }
    }
}

#[async_trait]
impl ProviderPresetHost for HostProviderPresetHost {
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
        let value = dispatch_model_providers(&self.pool, json!({ "agentId": agent_id }))
            .await
            .map_err(store_failed)?;
        let view: ProviderListView = serde_json::from_value(value).map_err(|error| {
            ProviderPresetError::new(ProviderPresetErrorCode::StoreFailed, error.to_string())
        })?;
        Ok(view
            .providers
            .into_iter()
            .map(ProviderPreset::from)
            .collect())
    }

    async fn save(
        &self,
        _plugin_id: &str,
        draft: ProviderPresetDraft,
    ) -> Result<ProviderPreset, ProviderPresetError> {
        let api_url = draft.api_url.trim().to_owned();
        let agent_id = draft.agent_id.clone();
        let (_id, value) = dispatch_model_provider_save(
            &self.pool,
            json!({
                "id": draft.id,
                "name": draft.name,
                "agentId": draft.agent_id,
                "apiUrl": draft.api_url,
                "apiKey": draft.api_key,
                "model": draft.model.unwrap_or_default(),
            }),
        )
        .await
        .map_err(rejected)?;
        let view: ProviderListView = serde_json::from_value(value).map_err(|error| {
            ProviderPresetError::new(ProviderPresetErrorCode::StoreFailed, error.to_string())
        })?;
        view.providers
            .into_iter()
            .find(|provider| provider.api_url == api_url && provider.agent_id == agent_id)
            .map(ProviderPreset::from)
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
        let providers = self.list(Some(&request.agent_id)).await?;
        let target = match request.preset_id.as_deref() {
            Some(preset_id) => Some(
                providers
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
            Some(preset_id) => providers
                .iter()
                .any(|provider| provider.id == preset_id && provider.bound),
            None => !providers.iter().any(|provider| provider.bound),
        };
        if already_bound {
            return Ok(ProviderBindDecision::Applied);
        }
        let plugin_name = self
            .plugins
            .installed_plugin_name(plugin_id)
            .await
            .unwrap_or_else(|| plugin_id.to_owned());
        let request_id = Uuid::new_v4().to_string();
        let waiter = self.prompts.park(request_id.clone());
        self.events.emit(
            PROVIDER_BIND_CONFIRM_CHANNEL,
            json!({
                "requestId": request_id,
                "pluginId": plugin_id,
                "pluginName": plugin_name,
                "agentId": request.agent_id,
                "presetId": request.preset_id,
                "presetName": target.map(|provider| provider.name.clone()),
                "apiUrl": target.map(|provider| provider.api_url.clone()),
                "reason": request.reason,
            }),
        );
        let approved = match tokio::time::timeout(PROVIDER_BIND_CONFIRMATION_TIMEOUT, waiter).await
        {
            Ok(Ok(approved)) => approved,
            Ok(Err(_)) => false,
            Err(_) => {
                self.prompts.abandon(&request_id);
                false
            }
        };
        if !approved {
            return Ok(ProviderBindDecision::Declined);
        }
        dispatch_model_provider_bind(
            &self.pool,
            json!({
                "agentId": request.agent_id,
                "providerId": request.preset_id,
            }),
        )
        .await
        .map_err(rejected)?;
        Ok(ProviderBindDecision::Applied)
    }
}

fn store_failed(error: application::ApplicationError) -> ProviderPresetError {
    ProviderPresetError::new(ProviderPresetErrorCode::StoreFailed, error.to_string())
}

fn rejected(error: application::ApplicationError) -> ProviderPresetError {
    ProviderPresetError::new(ProviderPresetErrorCode::Rejected, error.to_string())
}
