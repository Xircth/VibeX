//! IM message channels.
//!
//! Each channel has a `kind` with type-specific (non-secret) fields stored in
//! `config`, plus one secret token. Outgoing notifications are delivered with
//! the real per-platform API:
//! - telegram: Bot API `sendMessage` (token = bot token, config.chat_id)
//! - feishu:   App mode — tenant_access_token + `im/v1/messages`
//!             (token = app_secret, config.app_id + config.chat_id)
//! - weixin:   WeCom (企业微信) group bot webhook (token = key)
//! - qq:       OneBot 11 HTTP (go-cqhttp / NapCat) send_group_msg / send_private_msg
//!             (config.base_url + message_type + target_id, token = access_token)
//! - webhook:  generic JSON POST (config.webhook_url, token = optional bearer)

use std::{collections::HashMap, path::PathBuf};

use agents::{AgentConnectionStatus, AgentEvent, AgentEventEnvelope};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
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

const SUPPORTED_KINDS: &[&str] = &["telegram", "feishu", "weixin", "qq", "webhook"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatChannel {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub enabled: bool,
    /// Type-specific non-secret fields.
    pub config: Value,
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
    #[serde(default)]
    pub config: Value,
    /// Legacy v1 field, folded into `config` on load.
    #[serde(default)]
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
    #[serde(default)]
    pub config: Value,
    /// Optional secret; empty/absent leaves a stored token unchanged on update.
    #[serde(default)]
    pub token: Option<String>,
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
    if content.trim().is_empty() {
        return Ok(T::default());
    }
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

    // Migrate legacy `webhook_url` into `config`.
    let mut dirty = false;
    for channel in &mut store.channels {
        let config_empty = channel.config.is_null()
            || channel
                .config
                .as_object()
                .map(|obj| obj.is_empty())
                .unwrap_or(false);
        if config_empty && !channel.webhook_url.is_empty() {
            // Legacy channels were generic webhook posters regardless of `kind`
            // (the old code ignored the type), so normalize them to `webhook`.
            channel.config = json!({ "webhook_url": channel.webhook_url });
            channel.kind = "webhook".to_string();
            dirty = true;
        }
        if channel.config.is_null() {
            channel.config = json!({});
            dirty = true;
        }
    }
    if dirty {
        save_store(&store).await?;
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

fn config_str(config: &Value, key: &str) -> String {
    config
        .get(key)
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

fn require_field(config: &Value, key: &str, label: &str) -> Result<String, AppError> {
    let value = config_str(config, key);
    if value.is_empty() {
        Err(AppError::BadRequest(format!("{label}不能为空")))
    } else {
        Ok(value)
    }
}

fn normalize_payload(payload: ChatChannelPayload) -> Result<ChatChannelPayload, AppError> {
    let name = payload.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::BadRequest("渠道名称不能为空".to_string()));
    }
    let kind = payload.kind.trim().to_string();
    if !SUPPORTED_KINDS.contains(&kind.as_str()) {
        return Err(AppError::BadRequest(format!("不支持的渠道类型：{kind}")));
    }

    let config = if payload.config.is_null() {
        json!({})
    } else {
        payload.config.clone()
    };

    // Validate type-specific (non-secret) fields.
    match kind.as_str() {
        "telegram" => {
            require_field(&config, "chat_id", "Telegram chat_id")?;
        }
        "feishu" => {
            require_field(&config, "app_id", "飞书 App ID")?;
            require_field(&config, "chat_id", "飞书 chat_id")?;
        }
        "weixin" => {}
        "qq" => {
            let base_url = require_field(&config, "base_url", "OneBot 服务地址")?;
            reqwest::Url::parse(&base_url)
                .map_err(|e| AppError::BadRequest(format!("OneBot 服务地址无效：{e}")))?;
            require_field(&config, "target_id", "QQ 群号/QQ 号")?;
        }
        "webhook" => {
            let url = require_field(&config, "webhook_url", "Webhook URL")?;
            reqwest::Url::parse(&url)
                .map_err(|e| AppError::BadRequest(format!("Webhook URL 无效：{e}")))?;
        }
        _ => {}
    }

    Ok(ChatChannelPayload {
        name,
        kind,
        enabled: payload.enabled,
        config,
        token: payload.token,
    })
}

fn hydrate_channel(record: &ChatChannelRecord, secrets: &ChatChannelSecrets) -> ChatChannel {
    let config = if record.config.is_null() {
        json!({})
    } else {
        record.config.clone()
    };
    ChatChannel {
        id: record.id.clone(),
        name: record.name.clone(),
        kind: record.kind.clone(),
        enabled: record.enabled,
        config,
        has_token: secrets.tokens.contains_key(&record.id),
        created_at: record.created_at.clone(),
        updated_at: record.updated_at.clone(),
    }
}

// ---------------------------------------------------------------------------
// Per-platform delivery
// ---------------------------------------------------------------------------

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_default()
}

/// Send a notification to a typed channel. Returns an optional HTTP status.
async fn deliver(
    record: &ChatChannelRecord,
    token: Option<&str>,
    title: &str,
    body: &str,
) -> Result<Option<u16>, AppError> {
    match record.kind.as_str() {
        "telegram" => send_telegram(&record.config, token, title, body).await,
        "feishu" => send_feishu(&record.config, token, title, body).await,
        "weixin" => send_weixin(token, title, body).await,
        "qq" => send_qq(&record.config, token, title, body).await,
        _ => send_generic_webhook(record, token, title, body).await,
    }
}

fn combine(title: &str, body: &str) -> String {
    if body.is_empty() {
        title.to_string()
    } else if title.is_empty() {
        body.to_string()
    } else {
        format!("{title}\n{body}")
    }
}

async fn send_telegram(
    config: &Value,
    token: Option<&str>,
    title: &str,
    body: &str,
) -> Result<Option<u16>, AppError> {
    let bot_token = token
        .filter(|t| !t.trim().is_empty())
        .ok_or_else(|| AppError::BadRequest("Telegram 渠道缺少 Bot Token".to_string()))?;
    let chat_id = require_field(config, "chat_id", "Telegram chat_id")?;
    let url = format!("https://api.telegram.org/bot{bot_token}/sendMessage");

    let response = http_client()
        .post(url)
        .json(&json!({ "chat_id": chat_id, "text": combine(title, body) }))
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Telegram 发送失败：{e}")))?;
    let status = response.status().as_u16();
    let payload: Value = response.json().await.unwrap_or_else(|_| json!({}));
    if payload.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(Some(status))
    } else {
        let detail = payload
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("Telegram 返回错误");
        Err(AppError::BadRequest(detail.to_string()))
    }
}

async fn feishu_tenant_token(app_id: &str, app_secret: &str) -> Result<String, AppError> {
    let response = http_client()
        .post("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal")
        .json(&json!({ "app_id": app_id, "app_secret": app_secret }))
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("飞书鉴权失败：{e}")))?;
    let payload: Value = response
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("飞书鉴权响应解析失败：{e}")))?;
    if payload.get("code").and_then(Value::as_i64) != Some(0) {
        let msg = payload
            .get("msg")
            .and_then(Value::as_str)
            .unwrap_or("飞书鉴权失败");
        return Err(AppError::BadRequest(format!("飞书鉴权失败：{msg}")));
    }
    payload
        .get("tenant_access_token")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| AppError::Internal("飞书未返回 tenant_access_token".to_string()))
}

async fn send_feishu(
    config: &Value,
    token: Option<&str>,
    title: &str,
    body: &str,
) -> Result<Option<u16>, AppError> {
    let app_id = require_field(config, "app_id", "飞书 App ID")?;
    let chat_id = require_field(config, "chat_id", "飞书 chat_id")?;
    let app_secret = token
        .filter(|t| !t.trim().is_empty())
        .ok_or_else(|| AppError::BadRequest("飞书渠道缺少 App Secret".to_string()))?;

    let tenant_token = feishu_tenant_token(&app_id, app_secret).await?;
    let content = json!({ "text": combine(title, body) }).to_string();

    let response = http_client()
        .post("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id")
        .bearer_auth(&tenant_token)
        .json(&json!({
            "receive_id": chat_id,
            "msg_type": "text",
            "content": content,
        }))
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("飞书发送失败：{e}")))?;
    let status = response.status().as_u16();
    let payload: Value = response.json().await.unwrap_or_else(|_| json!({}));
    if payload.get("code").and_then(Value::as_i64) == Some(0) {
        Ok(Some(status))
    } else {
        let msg = payload
            .get("msg")
            .and_then(Value::as_str)
            .unwrap_or("飞书返回错误");
        Err(AppError::BadRequest(msg.to_string()))
    }
}

async fn send_weixin(
    token: Option<&str>,
    title: &str,
    body: &str,
) -> Result<Option<u16>, AppError> {
    let key = token
        .filter(|t| !t.trim().is_empty())
        .ok_or_else(|| AppError::BadRequest("企业微信渠道缺少 Webhook Key".to_string()))?;
    let url =
        format!("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key={key}");

    let response = http_client()
        .post(url)
        .json(&json!({
            "msgtype": "text",
            "text": { "content": combine(title, body) },
        }))
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("企业微信发送失败：{e}")))?;
    let status = response.status().as_u16();
    let payload: Value = response.json().await.unwrap_or_else(|_| json!({}));
    if payload.get("errcode").and_then(Value::as_i64) == Some(0) {
        Ok(Some(status))
    } else {
        let msg = payload
            .get("errmsg")
            .and_then(Value::as_str)
            .unwrap_or("企业微信返回错误");
        Err(AppError::BadRequest(msg.to_string()))
    }
}

async fn send_qq(
    config: &Value,
    token: Option<&str>,
    title: &str,
    body: &str,
) -> Result<Option<u16>, AppError> {
    let base_url = require_field(config, "base_url", "OneBot 服务地址")?;
    let target_raw = require_field(config, "target_id", "QQ 群号/QQ 号")?;
    let target_id: i64 = target_raw
        .parse()
        .map_err(|_| AppError::BadRequest("QQ 群号/QQ 号必须是数字".to_string()))?;
    let is_private = config_str(config, "message_type") == "private";

    let endpoint = if is_private {
        "send_private_msg"
    } else {
        "send_group_msg"
    };
    let url = format!("{}/{}", base_url.trim_end_matches('/'), endpoint);
    let message = combine(title, body);
    let payload = if is_private {
        json!({ "user_id": target_id, "message": message })
    } else {
        json!({ "group_id": target_id, "message": message })
    };

    let mut request = http_client().post(url).json(&payload);
    if let Some(access_token) = token.filter(|t| !t.trim().is_empty()) {
        request = request.bearer_auth(access_token);
    }

    let response = request
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("QQ 发送失败：{e}")))?;
    let status = response.status();
    let parsed: Value = response.json().await.unwrap_or_else(|_| json!({}));
    let retcode = parsed.get("retcode").and_then(Value::as_i64);
    let status_field = parsed.get("status").and_then(Value::as_str);
    if status.is_success() && retcode != Some(1) && status_field != Some("failed") {
        Ok(Some(status.as_u16()))
    } else {
        let msg = parsed
            .get("message")
            .or_else(|| parsed.get("wording"))
            .and_then(Value::as_str)
            .unwrap_or("OneBot 返回错误");
        Err(AppError::BadRequest(msg.to_string()))
    }
}

async fn send_generic_webhook(
    record: &ChatChannelRecord,
    token: Option<&str>,
    title: &str,
    body: &str,
) -> Result<Option<u16>, AppError> {
    let url = require_field(&record.config, "webhook_url", "Webhook URL")?;
    let payload = json!({
        "source": "vibex",
        "title": title,
        "text": body,
        "created_at": Utc::now().to_rfc3339(),
    });
    let mut request = http_client().post(&url).json(&payload);
    if let Some(token) = token.filter(|value| !value.trim().is_empty()) {
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Webhook 发送失败：{e}")))?;
    let status = response.status();
    if status.is_success() {
        Ok(Some(status.as_u16()))
    } else {
        let detail = response.text().await.unwrap_or_default();
        Err(AppError::BadRequest(if detail.is_empty() {
            format!("Webhook 返回 {status}")
        } else {
            detail
        }))
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

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

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
    let token = payload.token.clone();
    let payload = normalize_payload(payload)?;
    let mut store = load_store().await?;
    let mut secrets = load_secrets().await?;
    let now = Utc::now().to_rfc3339();
    let record = ChatChannelRecord {
        id: Uuid::new_v4().to_string(),
        name: payload.name,
        kind: payload.kind,
        enabled: payload.enabled,
        config: payload.config,
        webhook_url: String::new(),
        created_at: now.clone(),
        updated_at: now,
    };

    let mut secrets_dirty = false;
    if let Some(token) = token.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        secrets.tokens.insert(record.id.clone(), token.to_string());
        secrets_dirty = true;
    }

    let channel = hydrate_channel(&record, &secrets);
    store.channels.push(record);
    save_store(&store).await?;
    if secrets_dirty {
        save_secrets(&secrets).await?;
    }
    Ok(channel)
}

#[tauri::command]
pub async fn update_chat_channel(
    channel_id: String,
    payload: ChatChannelPayload,
) -> Result<ChatChannel, AppError> {
    let token = payload.token.clone();
    let payload = normalize_payload(payload)?;
    let mut store = load_store().await?;
    let mut secrets = load_secrets().await?;
    {
        let record = store
            .channels
            .iter_mut()
            .find(|channel| channel.id == channel_id)
            .ok_or_else(|| AppError::NotFound(format!("Chat channel not found: {channel_id}")))?;
        record.name = payload.name;
        record.kind = payload.kind;
        record.enabled = payload.enabled;
        record.config = payload.config;
        record.webhook_url = String::new();
        record.updated_at = Utc::now().to_rfc3339();
    }

    let mut secrets_dirty = false;
    if let Some(token) = token.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        secrets.tokens.insert(channel_id.clone(), token.to_string());
        secrets_dirty = true;
    }

    save_store(&store).await?;
    if secrets_dirty {
        save_secrets(&secrets).await?;
    }
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
    if secrets.tokens.remove(&channel_id).is_some() {
        save_secrets(&secrets).await?;
    }
    Ok(())
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
    if secrets.tokens.remove(&channel_id).is_some() {
        save_secrets(&secrets).await?;
    }
    Ok(())
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

    let token = secrets.tokens.get(&channel.id).map(String::as_str);
    match deliver(
        channel,
        token,
        "VibeX 测试通知",
        "这是一条来自 VibeX 设置页的测试消息。",
    )
    .await
    {
        Ok(status) => Ok(ChatChannelTestResult {
            ok: true,
            status,
            message: "测试消息已发送".to_string(),
        }),
        Err(error) => Ok(ChatChannelTestResult {
            ok: false,
            status: None,
            message: error.to_string(),
        }),
    }
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
    let title = event_title(&envelope.event);
    let body = format!(
        "事件：{event}\nworkspace：{}\nsession：{}",
        envelope.workspace_id,
        envelope
            .session_id
            .as_ref()
            .map(ToString::to_string)
            .unwrap_or_else(|| "-".to_string()),
    );

    for channel in store.channels.iter().filter(|channel| channel.enabled) {
        let token = secrets.tokens.get(&channel.id).map(String::as_str);
        if let Err(error) = deliver(channel, token, &title, &body).await {
            tracing::warn!(
                channel_id = %channel.id,
                kind = %channel.kind,
                error = %error,
                "Failed to send chat channel notification"
            );
        }
    }

    Ok(())
}
