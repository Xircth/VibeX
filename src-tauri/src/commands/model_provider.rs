use std::{collections::HashMap, path::PathBuf};

use chrono::Utc;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::AppError;

const SETTINGS_FILE_NAME: &str = "model-provider-settings.json";
const SECRETS_FILE_NAME: &str = "model-provider-secrets.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelProvider {
    pub id: String,
    pub name: String,
    pub agent_types: Vec<String>,
    pub api_url: String,
    pub auth_type: String,
    pub default_model: Option<String>,
    pub config_json: Option<String>,
    pub active_agents: Vec<String>,
    pub has_api_key: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ModelProviderRecord {
    pub id: String,
    pub name: String,
    pub agent_types: Vec<String>,
    pub api_url: String,
    pub auth_type: String,
    pub default_model: Option<String>,
    pub config_json: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ModelProviderStore {
    #[serde(default)]
    providers: Vec<ModelProviderRecord>,
    #[serde(default)]
    active_by_agent: HashMap<String, String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ModelProviderSecrets {
    #[serde(default)]
    api_keys: HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ModelProviderPayload {
    pub name: String,
    pub agent_types: Vec<String>,
    pub api_url: String,
    pub auth_type: String,
    pub default_model: Option<String>,
    pub config_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderModelsResult {
    pub provider_id: String,
    pub models: Vec<String>,
    pub fetched_at: String,
}

#[derive(Debug, Deserialize)]
struct OpenAiModelsResponse {
    data: Vec<OpenAiModel>,
}

#[derive(Debug, Deserialize)]
struct OpenAiModel {
    id: String,
}

fn settings_path() -> PathBuf {
    utils::assets::asset_dir().join(SETTINGS_FILE_NAME)
}

fn secrets_path() -> PathBuf {
    utils::assets::asset_dir().join(SECRETS_FILE_NAME)
}

async fn read_json<T>(path: PathBuf) -> Result<T, AppError>
where
    T: Default + for<'de> Deserialize<'de>,
{
    if !path.exists() {
        return Ok(T::default());
    }

    let content = tokio::fs::read_to_string(&path).await.map_err(|error| {
        AppError::Internal(format!("Failed to read {}: {error}", path.display()))
    })?;
    serde_json::from_str(&content)
        .map_err(|error| AppError::Internal(format!("Invalid {}: {error}", path.display())))
}

async fn write_json<T>(path: PathBuf, value: &T) -> Result<(), AppError>
where
    T: Serialize,
{
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|error| {
            AppError::Internal(format!("Failed to create {}: {error}", parent.display()))
        })?;
    }
    let content = serde_json::to_string_pretty(value)
        .map_err(|error| AppError::Internal(format!("Failed to serialize JSON: {error}")))?;
    tokio::fs::write(&path, content)
        .await
        .map_err(|error| AppError::Internal(format!("Failed to write {}: {error}", path.display())))
}

async fn load_store() -> Result<ModelProviderStore, AppError> {
    read_json(settings_path()).await
}

async fn save_store(store: &ModelProviderStore) -> Result<(), AppError> {
    write_json(settings_path(), store).await
}

async fn load_secrets() -> Result<ModelProviderSecrets, AppError> {
    read_json(secrets_path()).await
}

async fn save_secrets(secrets: &ModelProviderSecrets) -> Result<(), AppError> {
    write_json(secrets_path(), secrets).await
}

fn normalize_payload(payload: ModelProviderPayload) -> Result<ModelProviderPayload, AppError> {
    let name = payload.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::BadRequest(
            "Provider name cannot be empty".to_string(),
        ));
    }

    let api_url = payload.api_url.trim().trim_end_matches('/').to_string();
    Url::parse(&api_url)
        .map_err(|error| AppError::BadRequest(format!("Invalid API URL: {error}")))?;

    if let Some(config_json) = payload.config_json.as_deref()
        && !config_json.trim().is_empty()
    {
        serde_json::from_str::<serde_json::Value>(config_json).map_err(|error| {
            AppError::BadRequest(format!("Invalid custom JSON config: {error}"))
        })?;
    }

    let mut agent_types = payload
        .agent_types
        .into_iter()
        .map(|agent| agent.trim().to_string())
        .filter(|agent| !agent.is_empty())
        .collect::<Vec<_>>();
    agent_types.sort();
    agent_types.dedup();

    Ok(ModelProviderPayload {
        name,
        agent_types,
        api_url,
        auth_type: payload.auth_type.trim().to_string(),
        default_model: payload
            .default_model
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned),
        config_json: payload
            .config_json
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned),
    })
}

fn hydrate_provider(
    record: &ModelProviderRecord,
    store: &ModelProviderStore,
    secrets: &ModelProviderSecrets,
) -> ModelProvider {
    let mut active_agents = store
        .active_by_agent
        .iter()
        .filter_map(|(agent, provider_id)| (provider_id == &record.id).then_some(agent.clone()))
        .collect::<Vec<_>>();
    active_agents.sort();

    ModelProvider {
        id: record.id.clone(),
        name: record.name.clone(),
        agent_types: record.agent_types.clone(),
        api_url: record.api_url.clone(),
        auth_type: record.auth_type.clone(),
        default_model: record.default_model.clone(),
        config_json: record.config_json.clone(),
        active_agents,
        has_api_key: secrets.api_keys.contains_key(&record.id),
        created_at: record.created_at.clone(),
        updated_at: record.updated_at.clone(),
    }
}

fn find_provider_mut<'a>(
    store: &'a mut ModelProviderStore,
    provider_id: &str,
) -> Result<&'a mut ModelProviderRecord, AppError> {
    store
        .providers
        .iter_mut()
        .find(|provider| provider.id == provider_id)
        .ok_or_else(|| AppError::NotFound(format!("Model provider not found: {provider_id}")))
}

fn models_url(api_url: &str) -> String {
    let base = api_url.trim_end_matches('/');
    if base.ends_with("/models") {
        base.to_string()
    } else if base.ends_with("/v1") {
        format!("{base}/models")
    } else {
        format!("{base}/v1/models")
    }
}

#[tauri::command]
pub async fn list_model_providers() -> Result<Vec<ModelProvider>, AppError> {
    let store = load_store().await?;
    let secrets = load_secrets().await?;
    Ok(store
        .providers
        .iter()
        .map(|record| hydrate_provider(record, &store, &secrets))
        .collect())
}

#[tauri::command]
pub async fn create_model_provider(
    payload: ModelProviderPayload,
) -> Result<ModelProvider, AppError> {
    let payload = normalize_payload(payload)?;
    let mut store = load_store().await?;
    let secrets = load_secrets().await?;
    let now = Utc::now().to_rfc3339();
    let record = ModelProviderRecord {
        id: Uuid::new_v4().to_string(),
        name: payload.name,
        agent_types: payload.agent_types,
        api_url: payload.api_url,
        auth_type: payload.auth_type,
        default_model: payload.default_model,
        config_json: payload.config_json,
        created_at: now.clone(),
        updated_at: now,
    };
    let provider = hydrate_provider(&record, &store, &secrets);
    store.providers.push(record);
    save_store(&store).await?;
    Ok(provider)
}

#[tauri::command]
pub async fn update_model_provider(
    provider_id: String,
    payload: ModelProviderPayload,
) -> Result<ModelProvider, AppError> {
    let payload = normalize_payload(payload)?;
    let mut store = load_store().await?;
    {
        let record = find_provider_mut(&mut store, &provider_id)?;
        record.name = payload.name;
        record.agent_types = payload.agent_types;
        record.api_url = payload.api_url;
        record.auth_type = payload.auth_type;
        record.default_model = payload.default_model;
        record.config_json = payload.config_json;
        record.updated_at = Utc::now().to_rfc3339();
    }
    save_store(&store).await?;
    let secrets = load_secrets().await?;
    let record = store
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .expect("provider exists after update");
    Ok(hydrate_provider(record, &store, &secrets))
}

#[tauri::command]
pub async fn delete_model_provider(provider_id: String) -> Result<(), AppError> {
    let mut store = load_store().await?;
    let original_len = store.providers.len();
    store.providers.retain(|provider| provider.id != provider_id);
    if store.providers.len() == original_len {
        return Err(AppError::NotFound(format!(
            "Model provider not found: {provider_id}"
        )));
    }
    store
        .active_by_agent
        .retain(|_, active_provider_id| active_provider_id != &provider_id);
    save_store(&store).await?;

    let mut secrets = load_secrets().await?;
    secrets.api_keys.remove(&provider_id);
    save_secrets(&secrets).await
}

#[tauri::command]
pub async fn activate_model_provider(
    provider_id: String,
    agent_type: String,
) -> Result<ModelProvider, AppError> {
    let mut store = load_store().await?;
    let provider = store
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .cloned()
        .ok_or_else(|| AppError::NotFound(format!("Model provider not found: {provider_id}")))?;

    let agent_type = agent_type.trim().to_string();
    if agent_type.is_empty() {
        return Err(AppError::BadRequest(
            "Agent type cannot be empty".to_string(),
        ));
    }
    store.active_by_agent.insert(agent_type, provider_id);
    save_store(&store).await?;
    let secrets = load_secrets().await?;
    Ok(hydrate_provider(&provider, &store, &secrets))
}

#[tauri::command]
pub async fn deactivate_model_provider(agent_type: String) -> Result<(), AppError> {
    let mut store = load_store().await?;
    store.active_by_agent.remove(agent_type.trim());
    save_store(&store).await
}

#[tauri::command]
pub async fn save_model_provider_api_key(
    provider_id: String,
    api_key: String,
) -> Result<ModelProvider, AppError> {
    let store = load_store().await?;
    let record = store
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .ok_or_else(|| AppError::NotFound(format!("Model provider not found: {provider_id}")))?;
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return Err(AppError::BadRequest("API key cannot be empty".to_string()));
    }

    let mut secrets = load_secrets().await?;
    secrets
        .api_keys
        .insert(provider_id.clone(), trimmed.to_string());
    save_secrets(&secrets).await?;
    Ok(hydrate_provider(record, &store, &secrets))
}

#[tauri::command]
pub async fn get_model_provider_has_api_key(provider_id: String) -> Result<bool, AppError> {
    let secrets = load_secrets().await?;
    Ok(secrets.api_keys.contains_key(&provider_id))
}

#[tauri::command]
pub async fn delete_model_provider_api_key(provider_id: String) -> Result<(), AppError> {
    let mut secrets = load_secrets().await?;
    secrets.api_keys.remove(&provider_id);
    save_secrets(&secrets).await
}

#[tauri::command]
pub async fn fetch_provider_models(
    provider_id: String,
) -> Result<ProviderModelsResult, AppError> {
    let store = load_store().await?;
    let provider = store
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .ok_or_else(|| AppError::NotFound(format!("Model provider not found: {provider_id}")))?;
    let secrets = load_secrets().await?;
    let mut request = reqwest::Client::new().get(models_url(&provider.api_url));
    if let Some(api_key) = secrets.api_keys.get(&provider.id)
        && !api_key.trim().is_empty()
    {
        request = request.bearer_auth(api_key);
    }

    let response = request.send().await.map_err(|error| {
        AppError::Internal(format!("Failed to fetch provider models: {error}"))
    })?;
    let status = response.status();
    if !status.is_success() {
        let detail = response.text().await.unwrap_or_default();
        return Err(AppError::BadRequest(format!(
            "Provider returned {status}: {detail}"
        )));
    }

    let models: OpenAiModelsResponse = response.json().await.map_err(|error| {
        AppError::Internal(format!("Failed to parse provider models: {error}"))
    })?;
    let mut models = models
        .data
        .into_iter()
        .map(|model| model.id)
        .collect::<Vec<_>>();
    models.sort();
    models.dedup();

    Ok(ProviderModelsResult {
        provider_id,
        models,
        fetched_at: Utc::now().to_rfc3339(),
    })
}
