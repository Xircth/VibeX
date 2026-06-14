use std::{collections::HashMap, path::PathBuf};

use agents::{AgentConnectionStatus, AgentEvent, AgentEventEnvelope};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::error::AppError;

const SETTINGS_FILE_NAME: &str = "chat-channel-settings.json";
const SECRETS_FILE_NAME: &str = "chat-channel-secrets.json";

const DEFAULT_EVENTS: &[&str] = &[
    "prompt_started",
    "prompt_finished",
    "permission_requested",
    "error",
    "connection_status_changed",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatChannel {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub enabled: bool,
    pub webhook_url: String,
    pub has_token: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChatChannelRecord {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub enabled: bool,
    pub webhook_url: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ChatChannelStore {
    #[serde(default)]
    channels: Vec<ChatChannelRecord>,
    #[serde(default = "default_event_filter")]
    event_filter: Vec<String>,
    #[serde(default = "default_command_prefix")]
    command_prefix: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ChatChannelSecrets {
    #[serde(default)]
    tokens: HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChatChannelPayload {
    pub name: String,
    pub kind: String,
    pub enabled: bool,
    pub webhook_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatEventFilter {
    pub enabled_events: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatCommandPrefix {
    pub prefix: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatChannelTestResult {
    pub ok: bool,
    pub status: Option<u16>,
    pub message: String,
}

fn default_event_filter() -> Vec<String> {
    DEFAULT_EVENTS.iter().map(|event| event.to_string()).collect()
}

fn default_command_prefix() -> String {
    "/vibex".to_string()
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

async fn load_store() -> Result<ChatChannelStore, AppError> {
    let mut store: ChatChannelStore = read_json(settings_path()).await?;
    if store.event_filter.is_empty() {
        store.event_filter = default_event_filter();
    }
    if store.command_prefix.trim().is_empty() {
        store.command_prefix = default_command_prefix();
    }
    Ok(store)
}

async fn save_store(store: &ChatChannelStore) -> Result<(), AppError> {
    write_json(settings_path(), store).await
}

async fn load_secrets() -> Result<ChatChannelSecrets, AppError> {
    read_json(secrets_path()).await
}

async fn save_secrets(secrets: &ChatChannelSecrets) -> Result<(), AppError> {
    write_json(secrets_path(), secrets).await
}

fn normalize_payload(payload: ChatChannelPayload) -> Result<ChatChannelPayload, AppError> {
    let name = payload.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::BadRequest(
            "Channel name cannot be empty".to_string(),
        ));
    }
    let webhook_url = payload.webhook_url.trim().to_string();
    reqwest::Url::parse(&webhook_url)
        .map_err(|error| AppError::BadRequest(format!("Invalid webhook URL: {error}")))?;

    Ok(ChatChannelPayload {
        name,
        kind: payload.kind.trim().to_string(),
        enabled: payload.enabled,
        webhook_url,
    })
}

fn hydrate_channel(record: &ChatChannelRecord, secrets: &ChatChannelSecrets) -> ChatChannel {
    ChatChannel {
        id: record.id.clone(),
        name: record.name.clone(),
        kind: record.kind.clone(),
        enabled: record.enabled,
        webhook_url: record.webhook_url.clone(),
        has_token: secrets.tokens.contains_key(&record.id),
        created_at: record.created_at.clone(),
        updated_at: record.updated_at.clone(),
    }
}

fn event_key(event: &AgentEvent) -> Option<&'static str> {
    match event {
        AgentEvent::SessionCreated { .. } => Some("session_created"),
        AgentEvent::PromptStarted { .. } => Some("prompt_started"),
        AgentEvent::PromptFinished { .. } => Some("prompt_finished"),
        AgentEvent::TurnCompleted { .. } => Some("turn_completed"),
        AgentEvent::PermissionRequested { .. } => Some("permission_requested"),
        AgentEvent::Error { .. } => Some("error"),
        AgentEvent::ConnectionStatusChanged { snapshot } => match snapshot.status {
            AgentConnectionStatus::Failed
            | AgentConnectionStatus::Disconnected
            | AgentConnectionStatus::Connecting
            | AgentConnectionStatus::Ready => Some("connection_status_changed"),
        },
        _ => None,
    }
}

fn event_title(event: &AgentEvent) -> String {
    match event {
        AgentEvent::PromptStarted { snapshot } => {
            format!("Prompt started: {}", snapshot.text_preview)
        }
        AgentEvent::PromptFinished { finished } => {
            format!("Prompt finished: {}", finished.prompt_id)
        }
        AgentEvent::PermissionRequested { request } => {
            format!("Permission requested: {}", request.title)
        }
        AgentEvent::Error { error } => format!("Agent error: {}", error.message),
        AgentEvent::ConnectionStatusChanged { snapshot } => {
            format!("{:?} connection {:?}", snapshot.agent_type, snapshot.status)
        }
        AgentEvent::SessionCreated { snapshot } => {
            format!("Session created: {}", snapshot.id)
        }
        AgentEvent::TurnCompleted { .. } => "Turn completed".to_string(),
        _ => "VibeX event".to_string(),
    }
}

async fn post_webhook(
    channel: &ChatChannelRecord,
    token: Option<&str>,
    payload: serde_json::Value,
) -> Result<ChatChannelTestResult, AppError> {
    let client = reqwest::Client::new();
    let mut request = client.post(&channel.webhook_url).json(&payload);
    if let Some(token) = token.filter(|value| !value.trim().is_empty()) {
        request = request.bearer_auth(token);
    }

    let response = request
        .send()
        .await
        .map_err(|error| AppError::Internal(format!("Failed to send webhook: {error}")))?;
    let status = response.status();
    let ok = status.is_success();
    let detail = response.text().await.unwrap_or_default();
    Ok(ChatChannelTestResult {
        ok,
        status: Some(status.as_u16()),
        message: if ok {
            "Webhook delivered".to_string()
        } else if detail.is_empty() {
            format!("Webhook returned {status}")
        } else {
            detail
        },
    })
}

#[tauri::command]
pub async fn list_chat_channels() -> Result<Vec<ChatChannel>, AppError> {
    let store = load_store().await?;
    let secrets = load_secrets().await?;
    Ok(store
        .channels
        .iter()
        .map(|record| hydrate_channel(record, &secrets))
        .collect())
}

#[tauri::command]
pub async fn create_chat_channel(payload: ChatChannelPayload) -> Result<ChatChannel, AppError> {
    let payload = normalize_payload(payload)?;
    let mut store = load_store().await?;
    let secrets = load_secrets().await?;
    let now = Utc::now().to_rfc3339();
    let record = ChatChannelRecord {
        id: Uuid::new_v4().to_string(),
        name: payload.name,
        kind: payload.kind,
        enabled: payload.enabled,
        webhook_url: payload.webhook_url,
        created_at: now.clone(),
        updated_at: now,
    };
    let channel = hydrate_channel(&record, &secrets);
    store.channels.push(record);
    save_store(&store).await?;
    Ok(channel)
}

#[tauri::command]
pub async fn update_chat_channel(
    channel_id: String,
    payload: ChatChannelPayload,
) -> Result<ChatChannel, AppError> {
    let payload = normalize_payload(payload)?;
    let mut store = load_store().await?;
    let record = store
        .channels
        .iter_mut()
        .find(|channel| channel.id == channel_id)
        .ok_or_else(|| AppError::NotFound(format!("Chat channel not found: {channel_id}")))?;
    record.name = payload.name;
    record.kind = payload.kind;
    record.enabled = payload.enabled;
    record.webhook_url = payload.webhook_url;
    record.updated_at = Utc::now().to_rfc3339();
    save_store(&store).await?;
    let secrets = load_secrets().await?;
    let record = store
        .channels
        .iter()
        .find(|channel| channel.id == channel_id)
        .expect("channel exists after update");
    Ok(hydrate_channel(record, &secrets))
}

#[tauri::command]
pub async fn delete_chat_channel(channel_id: String) -> Result<(), AppError> {
    let mut store = load_store().await?;
    let original_len = store.channels.len();
    store.channels.retain(|channel| channel.id != channel_id);
    if original_len == store.channels.len() {
        return Err(AppError::NotFound(format!(
            "Chat channel not found: {channel_id}"
        )));
    }
    save_store(&store).await?;
    let mut secrets = load_secrets().await?;
    secrets.tokens.remove(&channel_id);
    save_secrets(&secrets).await
}

#[tauri::command]
pub async fn save_chat_channel_token(
    channel_id: String,
    token: String,
) -> Result<ChatChannel, AppError> {
    let store = load_store().await?;
    let record = store
        .channels
        .iter()
        .find(|channel| channel.id == channel_id)
        .ok_or_else(|| AppError::NotFound(format!("Chat channel not found: {channel_id}")))?;
    let token = token.trim();
    if token.is_empty() {
        return Err(AppError::BadRequest("Token cannot be empty".to_string()));
    }
    let mut secrets = load_secrets().await?;
    secrets.tokens.insert(channel_id, token.to_string());
    save_secrets(&secrets).await?;
    Ok(hydrate_channel(record, &secrets))
}

#[tauri::command]
pub async fn get_chat_channel_has_token(channel_id: String) -> Result<bool, AppError> {
    let secrets = load_secrets().await?;
    Ok(secrets.tokens.contains_key(&channel_id))
}

#[tauri::command]
pub async fn delete_chat_channel_token(channel_id: String) -> Result<(), AppError> {
    let mut secrets = load_secrets().await?;
    secrets.tokens.remove(&channel_id);
    save_secrets(&secrets).await
}

#[tauri::command]
pub async fn test_chat_channel(channel_id: String) -> Result<ChatChannelTestResult, AppError> {
    let store = load_store().await?;
    let secrets = load_secrets().await?;
    let channel = store
        .channels
        .iter()
        .find(|channel| channel.id == channel_id)
        .ok_or_else(|| AppError::NotFound(format!("Chat channel not found: {channel_id}")))?;
    post_webhook(
        channel,
        secrets.tokens.get(&channel.id).map(String::as_str),
        json!({
            "source": "vibex",
            "event": "test",
            "title": "VibeX test notification",
            "text": "This message was sent from VibeX settings.",
            "created_at": Utc::now().to_rfc3339(),
        }),
    )
    .await
}

#[tauri::command]
pub async fn get_chat_event_filter() -> Result<ChatEventFilter, AppError> {
    let store = load_store().await?;
    Ok(ChatEventFilter {
        enabled_events: store.event_filter,
    })
}

#[tauri::command]
pub async fn set_chat_event_filter(filter: ChatEventFilter) -> Result<ChatEventFilter, AppError> {
    let mut events = filter
        .enabled_events
        .into_iter()
        .map(|event| event.trim().to_string())
        .filter(|event| !event.is_empty())
        .collect::<Vec<_>>();
    events.sort();
    events.dedup();
    let mut store = load_store().await?;
    store.event_filter = events.clone();
    save_store(&store).await?;
    Ok(ChatEventFilter {
        enabled_events: events,
    })
}

#[tauri::command]
pub async fn get_chat_command_prefix() -> Result<ChatCommandPrefix, AppError> {
    let store = load_store().await?;
    Ok(ChatCommandPrefix {
        prefix: store.command_prefix,
    })
}

#[tauri::command]
pub async fn set_chat_command_prefix(
    prefix: ChatCommandPrefix,
) -> Result<ChatCommandPrefix, AppError> {
    let prefix = prefix.prefix.trim().to_string();
    if prefix.is_empty() {
        return Err(AppError::BadRequest(
            "Command prefix cannot be empty".to_string(),
        ));
    }
    let mut store = load_store().await?;
    store.command_prefix = prefix.clone();
    save_store(&store).await?;
    Ok(ChatCommandPrefix { prefix })
}

pub async fn notify_agent_event(envelope: &AgentEventEnvelope) -> Result<(), AppError> {
    let Some(event) = event_key(&envelope.event) else {
        return Ok(());
    };

    let store = load_store().await?;
    if !store.event_filter.iter().any(|enabled| enabled == event) {
        return Ok(());
    }

    let secrets = load_secrets().await?;
    let payload = json!({
        "source": "vibex",
        "event": event,
        "title": event_title(&envelope.event),
        "workspace_id": envelope.workspace_id.to_string(),
        "connection_id": envelope.connection_id.to_string(),
        "session_id": envelope.session_id.as_ref().map(ToString::to_string),
        "created_at": envelope.created_at.to_rfc3339(),
    });

    for channel in store.channels.iter().filter(|channel| channel.enabled) {
        if let Err(error) = post_webhook(
            channel,
            secrets.tokens.get(&channel.id).map(String::as_str),
            payload.clone(),
        )
        .await
        {
            tracing::warn!(
                channel_id = %channel.id,
                error = %error,
                "Failed to send chat channel notification"
            );
        }
    }

    Ok(())
}
