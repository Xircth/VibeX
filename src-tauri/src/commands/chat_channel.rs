//! IM message channels.
//!
//! Each channel has a `kind` with type-specific (non-secret) fields in `config`
//! plus one secret token. Outbound notifications are delivered with the real
//! per-platform API and rendered as rich messages (Telegram MarkdownV2, Feishu
//! interactive card, WeCom markdown, OneBot text, generic webhook JSON).
//!
//! Telegram channels additionally run an inbound long-poll loop so the bot can
//! answer commands (help / ping / status / echo) — bidirectional control.

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        Arc, Mutex as StdMutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use agents::{
    AgentEventEnvelope, agent_type_from_executor_key,
    conversation::{ConversationEvent, ConversationEventEnvelope},
};
use chrono::Utc;
use db::models::session::SessionStatus;
use futures::{SinkExt, StreamExt};
use prost::Message as ProstMessage;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use services::services::chat_delivery::{
    RichMessage, build_rich, deliver_rich, event_key, feishu_tenant_token, http_client,
    should_send, telegram_post,
};
use sqlx::{FromRow, SqlitePool};
use tauri::{AppHandle, Emitter, Manager};
use tokio_tungstenite::tungstenite;
use uuid::Uuid;

use crate::{
    commands::conversations::conversation_events_since_core,
    conversation_service::{ConversationSessionService, ConversationStartTurnInput},
    error::AppError,
    state::AppState,
};

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

/// How often the inbound manager reconciles running loops against config.
const INBOUND_RECONCILE_SECS: u64 = 10;

// ---------------------------------------------------------------------------
// Persistent model
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatChannel {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub enabled: bool,
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
    #[serde(default)]
    pub webhook_url: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChatChannelStore {
    #[serde(default)]
    channels: Vec<ChatChannelRecord>,
    #[serde(default = "default_event_filter")]
    event_filter: Vec<String>,
    #[serde(default = "default_command_prefix")]
    command_prefix: String,
    /// Whether notifications may include the user's prompt text (privacy: off).
    #[serde(default)]
    include_prompt_text: bool,
}

impl Default for ChatChannelStore {
    fn default() -> Self {
        Self {
            channels: Vec::new(),
            event_filter: default_event_filter(),
            command_prefix: default_command_prefix(),
            include_prompt_text: false,
        }
    }
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
    DEFAULT_EVENTS
        .iter()
        .map(|event| event.to_string())
        .collect()
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
    let msg = RichMessage::info("这是一条来自 VibeX 设置页的测试消息。")
        .with_title("🔔 VibeX 测试通知")
        .with_field("渠道", channel.name.clone());
    match deliver_rich(&channel.kind, &channel.config, token, &msg).await {
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

#[tauri::command]
pub async fn get_chat_include_prompt_text() -> Result<bool, AppError> {
    Ok(load_store().await?.include_prompt_text)
}

#[tauri::command]
pub async fn set_chat_include_prompt_text(enabled: bool) -> Result<bool, AppError> {
    let mut store = load_store().await?;
    store.include_prompt_text = enabled;
    save_store(&store).await?;
    Ok(enabled)
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
    let msg = build_rich(&envelope.event, store.include_prompt_text);

    for channel in store.channels.iter().filter(|channel| channel.enabled) {
        if !should_send(&channel.id, event, msg.level) {
            continue;
        }
        let token = secrets.tokens.get(&channel.id).map(String::as_str);
        if let Err(error) = deliver_rich(&channel.kind, &channel.config, token, &msg).await {
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

pub fn conversation_event_key(event: &ConversationEvent) -> Option<&'static str> {
    match event {
        ConversationEvent::UserTurnStarted => Some("prompt_started"),
        ConversationEvent::PermissionRequested { .. } => Some("permission_requested"),
        ConversationEvent::TurnCompleted { .. } => Some("prompt_finished"),
        ConversationEvent::TurnFailed { .. } => Some("error"),
        ConversationEvent::AgentConnectionStatusChanged { .. } => Some("connection_status_changed"),
        _ => None,
    }
}

fn build_conversation_rich(
    envelope: &ConversationEventEnvelope,
    include_prompt_text: bool,
) -> RichMessage {
    let base = match &envelope.event {
        ConversationEvent::UserTurnStarted => {
            let body = if include_prompt_text {
                "VibeX conversation turn started.".to_string()
            } else {
                "智能体开始执行任务。".to_string()
            };
            RichMessage::info(body).with_title("🚀 任务开始")
        }
        ConversationEvent::PermissionRequested { request } => {
            RichMessage::info("智能体正在等待你的授权。请回到 VibeX 桌面端处理。")
                .with_title("🔐 权限请求")
                .with_field("权限", request.request.title.clone())
        }
        ConversationEvent::TurnCompleted { .. } => {
            RichMessage::info("智能体已完成本次任务。").with_title("✅ 任务完成")
        }
        ConversationEvent::TurnFailed { error } => RichMessage::info("智能体运行出现错误。")
            .with_title("❌ 运行错误")
            .with_field("信息", error.message.clone()),
        ConversationEvent::AgentConnectionStatusChanged { status } => {
            RichMessage::info(format!("连接状态变更为 {status:?}")).with_title("🔌 连接状态")
        }
        _ => RichMessage::info("VibeX conversation event").with_title("VibeX"),
    };

    let base = base.with_field("Conversation", envelope.conversation_id.to_string());
    if let Some(turn_id) = envelope.turn_id {
        base.with_field("Turn", turn_id.to_string())
    } else {
        base
    }
}

pub async fn notify_conversation_event(
    envelope: &ConversationEventEnvelope,
) -> Result<(), AppError> {
    let Some(event) = conversation_event_key(&envelope.event) else {
        return Ok(());
    };

    let store = load_store().await?;
    if !store.event_filter.iter().any(|enabled| enabled == event) {
        return Ok(());
    }

    let secrets = load_secrets().await?;
    let msg = build_conversation_rich(envelope, store.include_prompt_text);

    for channel in store.channels.iter().filter(|channel| channel.enabled) {
        if !should_send(&channel.id, event, msg.level) {
            continue;
        }
        let token = secrets.tokens.get(&channel.id).map(String::as_str);
        if let Err(error) = deliver_rich(&channel.kind, &channel.config, token, &msg).await {
            tracing::warn!(
                channel_id = %channel.id,
                kind = %channel.kind,
                error = %error,
                "Failed to send conversation chat channel notification"
            );
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Inbound (bidirectional) — receivers + conversation command dispatch
// ---------------------------------------------------------------------------
//
// Telegram: HTTP long-poll. QQ: OneBot 11 forward WebSocket. Feishu: Lark
// long-connection WebSocket (pbbp2 protobuf frames). All feed `dispatch_command`.

/// Lark WebSocket pbbp2 frame (mirrors larksuite/oapi-sdk-go ws/pbbp2.pb.go).
#[derive(Clone, PartialEq, ProstMessage)]
struct LarkFrame {
    #[prost(uint64, tag = "1")]
    seq_id: u64,
    #[prost(uint64, tag = "2")]
    log_id: u64,
    #[prost(int32, tag = "3")]
    service: i32,
    #[prost(int32, tag = "4")]
    method: i32,
    #[prost(message, repeated, tag = "5")]
    headers: Vec<LarkFrameHeader>,
    #[prost(string, tag = "6")]
    payload_encoding: String,
    #[prost(string, tag = "7")]
    payload_type: String,
    #[prost(bytes = "vec", tag = "8")]
    payload: Vec<u8>,
    #[prost(string, tag = "9")]
    log_id_new: String,
}

#[derive(Clone, PartialEq, ProstMessage)]
struct LarkFrameHeader {
    #[prost(string, tag = "1")]
    key: String,
    #[prost(string, tag = "2")]
    value: String,
}

impl LarkFrame {
    fn header(&self, key: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|h| h.key == key)
            .map(|h| h.value.as_str())
    }

    fn set_header(&mut self, key: &str, value: &str) {
        if let Some(h) = self.headers.iter_mut().find(|h| h.key == key) {
            h.value = value.to_string();
        } else {
            self.headers.push(LarkFrameHeader {
                key: key.to_string(),
                value: value.to_string(),
            });
        }
    }
}

/// Per-(channel, sender) selected target session for follow-up prompts.
type SessionBridgeKey = (String, String);
type SessionBridgeValue = String;
type SessionBridgeMap = HashMap<SessionBridgeKey, SessionBridgeValue>;

fn session_bridge() -> &'static StdMutex<SessionBridgeMap> {
    static BRIDGE: OnceLock<StdMutex<SessionBridgeMap>> = OnceLock::new();
    BRIDGE.get_or_init(|| StdMutex::new(HashMap::new()))
}

struct InboundTarget {
    channel_id: String,
    kind: String,
    signature: String,
    token: String,
    config: Value,
}

/// Start the background manager that keeps an inbound loop running for every
/// enabled inbound-capable channel and answers its commands.
pub fn start_inbound_manager(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // channel_id -> (signature, shutdown flag)
        let mut running: HashMap<String, (String, Arc<AtomicBool>)> = HashMap::new();

        loop {
            if let Ok(targets) = inbound_targets().await {
                let desired: HashSet<String> =
                    targets.iter().map(|t| t.channel_id.clone()).collect();
                running.retain(|id, (_, flag)| {
                    if desired.contains(id) {
                        true
                    } else {
                        flag.store(true, Ordering::Relaxed);
                        false
                    }
                });

                for target in targets {
                    let restart = match running.get(&target.channel_id) {
                        Some((signature, _)) => signature != &target.signature,
                        None => true,
                    };
                    if restart {
                        if let Some((_, flag)) = running.remove(&target.channel_id) {
                            flag.store(true, Ordering::Relaxed);
                        }
                        let flag = Arc::new(AtomicBool::new(false));
                        spawn_receiver(app.clone(), &target, flag.clone());
                        running.insert(target.channel_id.clone(), (target.signature, flag));
                    }
                }
            }

            tokio::time::sleep(Duration::from_secs(INBOUND_RECONCILE_SECS)).await;
        }
    });
}

async fn inbound_targets() -> Result<Vec<InboundTarget>, AppError> {
    let store = load_store().await?;
    let secrets = load_secrets().await?;
    let mut targets = Vec::new();

    for channel in store.channels.iter().filter(|c| c.enabled) {
        let token = secrets.tokens.get(&channel.id).cloned().unwrap_or_default();
        match channel.kind.as_str() {
            "telegram" => {
                if token.trim().is_empty() {
                    continue;
                }
                targets.push(InboundTarget {
                    channel_id: channel.id.clone(),
                    kind: "telegram".to_string(),
                    signature: format!("tg:{token}"),
                    token,
                    config: channel.config.clone(),
                });
            }
            "qq" => {
                let ws_url = qq_ws_url(&channel.config);
                if ws_url.is_empty() {
                    continue;
                }
                targets.push(InboundTarget {
                    channel_id: channel.id.clone(),
                    kind: "qq".to_string(),
                    signature: format!(
                        "qq:{ws_url}:{token}:{}",
                        config_str(&channel.config, "base_url")
                    ),
                    token,
                    config: channel.config.clone(),
                });
            }
            "feishu" => {
                let app_id = config_str(&channel.config, "app_id");
                if app_id.is_empty() || token.trim().is_empty() {
                    continue;
                }
                targets.push(InboundTarget {
                    channel_id: channel.id.clone(),
                    kind: "feishu".to_string(),
                    signature: format!("fs:{app_id}:{token}"),
                    token,
                    config: channel.config.clone(),
                });
            }
            _ => {}
        }
    }
    Ok(targets)
}

fn spawn_receiver(app: AppHandle, target: &InboundTarget, flag: Arc<AtomicBool>) {
    match target.kind.as_str() {
        "telegram" => {
            spawn_telegram_loop(app, target.channel_id.clone(), target.token.clone(), flag)
        }
        "qq" => spawn_qq_loop(
            app,
            target.channel_id.clone(),
            target.config.clone(),
            target.token.clone(),
            flag,
        ),
        "feishu" => spawn_feishu_loop(
            app,
            target.channel_id.clone(),
            target.config.clone(),
            target.token.clone(),
            flag,
        ),
        _ => {}
    }
}

async fn current_prefix() -> String {
    load_store()
        .await
        .map(|store| store.command_prefix)
        .unwrap_or_else(|_| default_command_prefix())
}

// ── Telegram inbound (HTTP long-poll) ──

fn spawn_telegram_loop(
    app: AppHandle,
    channel_id: String,
    bot_token: String,
    shutdown: Arc<AtomicBool>,
) {
    tauri::async_runtime::spawn(async move {
        let client = http_client();
        let mut offset: i64 = 0;

        while !shutdown.load(Ordering::Relaxed) {
            let url = format!(
                "https://api.telegram.org/bot{bot_token}/getUpdates?timeout=25&offset={offset}"
            );
            let response = match client.get(&url).send().await {
                Ok(response) => response,
                Err(_) => {
                    tokio::time::sleep(Duration::from_secs(3)).await;
                    continue;
                }
            };
            let body: Value = match response.json().await {
                Ok(body) => body,
                Err(_) => continue,
            };
            let Some(updates) = body.get("result").and_then(Value::as_array) else {
                continue;
            };

            for update in updates {
                if let Some(update_id) = update.get("update_id").and_then(Value::as_i64) {
                    offset = update_id + 1;
                }
                let Some(text) = update.pointer("/message/text").and_then(Value::as_str) else {
                    continue;
                };
                let Some(chat_id) = update.pointer("/message/chat/id").and_then(Value::as_i64)
                else {
                    continue;
                };
                let sender_id = update
                    .pointer("/message/from/id")
                    .and_then(Value::as_i64)
                    .map(|id| id.to_string())
                    .unwrap_or_default();

                let prefix = current_prefix().await;
                let reply =
                    dispatch_command(text.trim(), &prefix, &app, &channel_id, &sender_id).await;
                if reply.is_empty() {
                    continue;
                }
                let _ = telegram_post(&bot_token, &chat_id.to_string(), &reply, None).await;
            }
        }
    });
}

// ── QQ inbound (OneBot 11 forward WebSocket) ──

fn qq_ws_url(config: &Value) -> String {
    let explicit = config_str(config, "ws_url");
    if !explicit.is_empty() {
        return explicit;
    }
    // Derive from the HTTP base_url (http→ws, https→wss) as a best effort.
    let base = config_str(config, "base_url");
    if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        String::new()
    }
}

fn spawn_qq_loop(
    app: AppHandle,
    channel_id: String,
    config: Value,
    token: String,
    shutdown: Arc<AtomicBool>,
) {
    tauri::async_runtime::spawn(async move {
        let ws_base = qq_ws_url(&config);
        let base_url = config_str(&config, "base_url");

        while !shutdown.load(Ordering::Relaxed) {
            let url = if token.trim().is_empty() {
                ws_base.clone()
            } else {
                let sep = if ws_base.contains('?') { '&' } else { '?' };
                format!("{ws_base}{sep}access_token={token}")
            };

            match tokio_tungstenite::connect_async(&url).await {
                Ok((stream, _)) => {
                    let (mut write, mut read) = stream.split();
                    while !shutdown.load(Ordering::Relaxed) {
                        match read.next().await {
                            Some(Ok(tungstenite::Message::Text(text))) => {
                                if let Ok(event) = serde_json::from_str::<Value>(text.as_str()) {
                                    handle_qq_event(&app, &channel_id, &base_url, &token, &event)
                                        .await;
                                }
                            }
                            Some(Ok(tungstenite::Message::Ping(data))) => {
                                let _ = write.send(tungstenite::Message::Pong(data)).await;
                            }
                            Some(Ok(tungstenite::Message::Close(_))) | None => break,
                            Some(Err(_)) => break,
                            _ => {}
                        }
                    }
                }
                Err(error) => {
                    tracing::warn!(channel_id = %channel_id, error = %error, "QQ ws connect failed");
                }
            }
            if shutdown.load(Ordering::Relaxed) {
                break;
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    });
}

async fn handle_qq_event(
    app: &AppHandle,
    channel_id: &str,
    base_url: &str,
    token: &str,
    event: &Value,
) {
    if event.get("post_type").and_then(Value::as_str) != Some("message") {
        return;
    }
    let text = event
        .get("raw_message")
        .or_else(|| event.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if text.is_empty() {
        return;
    }
    let is_group = event.get("message_type").and_then(Value::as_str) == Some("group");
    let source_id = if is_group {
        event.get("group_id").and_then(Value::as_i64)
    } else {
        event.get("user_id").and_then(Value::as_i64)
    };
    let Some(source_id) = source_id else {
        return;
    };
    let sender_id = event
        .pointer("/sender/user_id")
        .and_then(Value::as_i64)
        .map(|id| id.to_string())
        .unwrap_or_default();

    let prefix = current_prefix().await;
    let reply = dispatch_command(&text, &prefix, app, channel_id, &sender_id).await;
    if reply.is_empty() {
        return;
    }
    let token = if token.trim().is_empty() {
        None
    } else {
        Some(token)
    };
    let _ = qq_http_send(base_url, token, is_group, source_id, &reply).await;
}

async fn qq_http_send(
    base_url: &str,
    token: Option<&str>,
    is_group: bool,
    target_id: i64,
    text: &str,
) -> Result<(), AppError> {
    let endpoint = if is_group {
        "send_group_msg"
    } else {
        "send_private_msg"
    };
    let url = format!("{}/{}", base_url.trim_end_matches('/'), endpoint);
    let payload = if is_group {
        json!({ "group_id": target_id, "message": text })
    } else {
        json!({ "user_id": target_id, "message": text })
    };
    let mut request = http_client().post(url).json(&payload);
    if let Some(token) = token.filter(|t| !t.trim().is_empty()) {
        request = request.bearer_auth(token);
    }
    request
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("QQ 回复失败：{e}")))?;
    Ok(())
}

// ── Feishu inbound (Lark long-connection WebSocket, pbbp2) ──

async fn feishu_ws_url(app_id: &str, app_secret: &str) -> Result<String, AppError> {
    let response = http_client()
        .post("https://open.feishu.cn/callback/ws/endpoint")
        .json(&json!({ "AppID": app_id, "AppSecret": app_secret }))
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("飞书 ws 端点获取失败：{e}")))?;
    let payload: Value = response
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("飞书 ws 响应解析失败：{e}")))?;
    if payload.get("code").and_then(Value::as_i64) != Some(0) {
        let msg = payload
            .get("msg")
            .and_then(Value::as_str)
            .unwrap_or("飞书 ws 端点错误");
        return Err(AppError::BadRequest(msg.to_string()));
    }
    payload
        .pointer("/data/URL")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| AppError::Internal("飞书未返回 ws URL".to_string()))
}

fn spawn_feishu_loop(
    app: AppHandle,
    channel_id: String,
    config: Value,
    app_secret: String,
    shutdown: Arc<AtomicBool>,
) {
    tauri::async_runtime::spawn(async move {
        let app_id = config_str(&config, "app_id");

        while !shutdown.load(Ordering::Relaxed) {
            let ws_url = match feishu_ws_url(&app_id, &app_secret).await {
                Ok(url) => url,
                Err(error) => {
                    tracing::warn!(channel_id = %channel_id, error = %error, "Feishu ws endpoint failed");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                }
            };

            match tokio_tungstenite::connect_async(&ws_url).await {
                Ok((stream, _)) => {
                    let (mut write, mut read) = stream.split();
                    // message_id -> (total, parts)
                    let mut partials: HashMap<String, (i32, HashMap<i32, Vec<u8>>)> =
                        HashMap::new();

                    while !shutdown.load(Ordering::Relaxed) {
                        match read.next().await {
                            Some(Ok(tungstenite::Message::Binary(data))) => {
                                let Ok(frame) = LarkFrame::decode(data.as_ref()) else {
                                    continue;
                                };
                                let frame_type = frame.header("type").unwrap_or("").to_string();

                                if frame.method == 0 && frame_type == "ping" {
                                    let mut pong = frame.clone();
                                    pong.set_header("type", "pong");
                                    pong.payload = Vec::new();
                                    let mut buf = Vec::new();
                                    if pong.encode(&mut buf).is_ok() {
                                        let _ = write
                                            .send(tungstenite::Message::Binary(buf.into()))
                                            .await;
                                    }
                                } else if frame.method == 1 && frame_type == "event" {
                                    let msg_id =
                                        frame.header("message_id").unwrap_or("").to_string();
                                    let sum: i32 = frame
                                        .header("sum")
                                        .and_then(|s| s.parse().ok())
                                        .unwrap_or(1);
                                    let seq: i32 = frame
                                        .header("seq")
                                        .and_then(|s| s.parse().ok())
                                        .unwrap_or(0);

                                    let full = if sum <= 1 {
                                        Some(frame.payload.clone())
                                    } else {
                                        let entry = partials
                                            .entry(msg_id.clone())
                                            .or_insert((sum, HashMap::new()));
                                        entry.1.insert(seq, frame.payload.clone());
                                        if entry.1.len() as i32 >= entry.0 {
                                            let mut combined = Vec::new();
                                            for i in 0..entry.0 {
                                                if let Some(part) = entry.1.get(&i) {
                                                    combined.extend_from_slice(part);
                                                }
                                            }
                                            partials.remove(&msg_id);
                                            Some(combined)
                                        } else {
                                            None
                                        }
                                    };

                                    if let Some(bytes) = full {
                                        if let Ok(text) = std::str::from_utf8(&bytes)
                                            && let Ok(event) = serde_json::from_str::<Value>(text)
                                        {
                                            handle_feishu_event(
                                                &app,
                                                &channel_id,
                                                &app_id,
                                                &app_secret,
                                                &event,
                                            )
                                            .await;
                                        }
                                        let mut ack = frame.clone();
                                        ack.payload = br#"{"code":200}"#.to_vec();
                                        let mut buf = Vec::new();
                                        if ack.encode(&mut buf).is_ok() {
                                            let _ = write
                                                .send(tungstenite::Message::Binary(buf.into()))
                                                .await;
                                        }
                                    }
                                }
                            }
                            Some(Ok(tungstenite::Message::Ping(data))) => {
                                let _ = write.send(tungstenite::Message::Pong(data)).await;
                            }
                            Some(Ok(tungstenite::Message::Close(_))) | None => break,
                            Some(Err(_)) => break,
                            _ => {}
                        }
                    }
                }
                Err(error) => {
                    tracing::warn!(channel_id = %channel_id, error = %error, "Feishu ws connect failed");
                }
            }
            if shutdown.load(Ordering::Relaxed) {
                break;
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    });
}

async fn handle_feishu_event(
    app: &AppHandle,
    channel_id: &str,
    app_id: &str,
    app_secret: &str,
    event: &Value,
) {
    if event.pointer("/header/event_type").and_then(Value::as_str) != Some("im.message.receive_v1")
    {
        return;
    }
    if event
        .pointer("/event/message/message_type")
        .and_then(Value::as_str)
        != Some("text")
    {
        return;
    }
    // In group chats only react when the bot is mentioned.
    let chat_type = event
        .pointer("/event/message/chat_type")
        .and_then(Value::as_str)
        .unwrap_or("p2p");
    if chat_type == "group" {
        let mentions = event
            .pointer("/event/message/mentions")
            .and_then(Value::as_array);
        if mentions.map(|m| m.is_empty()).unwrap_or(true) {
            return;
        }
    }

    let content = event
        .pointer("/event/message/content")
        .and_then(Value::as_str)
        .unwrap_or("");
    let mut text = serde_json::from_str::<Value>(content)
        .ok()
        .and_then(|v| v.get("text").and_then(Value::as_str).map(String::from))
        .unwrap_or_default();
    if let Some(mentions) = event
        .pointer("/event/message/mentions")
        .and_then(Value::as_array)
    {
        for mention in mentions {
            if let Some(key) = mention.get("key").and_then(Value::as_str) {
                text = text.replace(key, "");
            }
        }
    }
    let text = text.trim().to_string();
    if text.is_empty() {
        return;
    }
    let Some(chat_id) = event
        .pointer("/event/message/chat_id")
        .and_then(Value::as_str)
    else {
        return;
    };
    let sender_id = event
        .pointer("/event/sender/sender_id/open_id")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();

    let prefix = current_prefix().await;
    let reply = dispatch_command(&text, &prefix, app, channel_id, &sender_id).await;
    if reply.is_empty() {
        return;
    }
    let _ = feishu_send_text(app_id, app_secret, chat_id, &reply).await;
}

async fn feishu_send_text(
    app_id: &str,
    app_secret: &str,
    chat_id: &str,
    text: &str,
) -> Result<(), AppError> {
    let tenant_token = feishu_tenant_token(app_id, app_secret).await?;
    let content = json!({ "text": text }).to_string();
    http_client()
        .post("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id")
        .bearer_auth(&tenant_token)
        .json(&json!({
            "receive_id": chat_id,
            "msg_type": "text",
            "content": content,
        }))
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("飞书回复失败：{e}")))?;
    Ok(())
}

// ── Command dispatch (incl. ACP session control) ──

/// Route an inbound command. Returns an empty string when the message is not a
/// command directed at the bot (so it is silently ignored).
async fn dispatch_command(
    text: &str,
    prefix: &str,
    app: &AppHandle,
    channel_id: &str,
    sender_id: &str,
) -> String {
    let Some(rest) = text.strip_prefix(prefix) else {
        return String::new();
    };
    let rest = rest.trim();
    let mut parts = rest.splitn(2, char::is_whitespace);
    let command = parts.next().unwrap_or("").to_lowercase();
    let args = parts.next().unwrap_or("").trim();

    match command.as_str() {
        "" | "help" | "start" => help_text(prefix),
        "ping" => "🟢 VibeX 在线".to_string(),
        "status" => status_text(prefix, app).await,
        "sessions" | "conversations" | "ls" => list_conversations(app, prefix).await,
        "use" => select_conversation(app, channel_id, sender_id, args, prefix).await,
        "task" | "do" | "ask" => send_task(app, channel_id, sender_id, args, prefix).await,
        "echo" => {
            if args.is_empty() {
                format!("用法：{prefix} echo <文本>")
            } else {
                args.to_string()
            }
        }
        other => format!("未知命令：{other}\n\n{}", help_text(prefix)),
    }
}

fn help_text(prefix: &str) -> String {
    format!(
        "🤖 VibeX 机器人命令：\n{prefix} help — 显示帮助\n{prefix} ping — 检测在线\n{prefix} status — 运行状态\n{prefix} conversations — 列出最近对话\n{prefix} use <序号> — 选择对话\n{prefix} task <内容> — 给所选对话发任务/追问\n{prefix} echo <文本> — 回显"
    )
}

async fn status_text(prefix: &str, app: &AppHandle) -> String {
    let store = load_store().await.unwrap_or_default();
    let total = store.channels.len();
    let enabled = store.channels.iter().filter(|c| c.enabled).count();
    let state = app.state::<AppState>();
    let conversations = recent_conversations(&state, 50).await.unwrap_or_default();
    format!(
        "🟢 VibeX 在线\n消息渠道：{enabled}/{total} 已启用\n最近对话：{}\n版本：{}\n命令前缀：{prefix}",
        conversations.len(),
        env!("CARGO_PKG_VERSION")
    )
}

fn short_id(id: &str) -> String {
    id.chars().take(8).collect()
}

#[derive(Debug, Clone, FromRow)]
struct ConversationCommandTarget {
    id: Uuid,
    workspace_id: Uuid,
    title: Option<String>,
    status: SessionStatus,
    agent_type: Option<String>,
}

async fn recent_conversations(
    state: &AppState,
    limit: i64,
) -> Result<Vec<ConversationCommandTarget>, AppError> {
    sqlx::query_as::<_, ConversationCommandTarget>(
        r#"SELECT s.id,
                  s.workspace_id,
                  s.name AS title,
                  s.status,
                  COALESCE(s.agent_type, b.agent_type) AS agent_type
           FROM sessions s
           LEFT JOIN conversation_agent_bindings b
             ON b.id = (
                SELECT id
                FROM conversation_agent_bindings
                WHERE conversation_id = s.id
                ORDER BY updated_at DESC, created_at DESC
                LIMIT 1
             )
           WHERE s.deleted_at IS NULL
           ORDER BY s.active_turn_id IS NULL,
                    s.updated_at DESC,
                    s.created_at DESC
           LIMIT ?"#,
    )
    .bind(limit.clamp(1, 50))
    .fetch_all(&state.deployment.db().pool)
    .await
    .map_err(Into::into)
}

async fn conversation_last_sequence(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<i64, AppError> {
    sqlx::query_scalar::<_, i64>(
        r#"SELECT COALESCE(MAX(sequence), 0)
           FROM conversation_events
           WHERE conversation_id = ?"#,
    )
    .bind(conversation_id)
    .fetch_one(pool)
    .await
    .map_err(Into::into)
}

async fn emit_conversation_events_after(
    app: &AppHandle,
    pool: &SqlitePool,
    conversation_id: Uuid,
    after_sequence: i64,
) {
    match conversation_events_since_core(pool, conversation_id, after_sequence, 50).await {
        Ok(page) => {
            for event in page.events {
                if let Err(error) = app.emit(crate::events::channels::CONVERSATION_EVENTS, &event) {
                    tracing::warn!(
                        conversation_id = %conversation_id,
                        sequence = event.sequence,
                        %error,
                        "Failed to emit inbound channel conversation event"
                    );
                    break;
                }
                if let Err(error) = notify_conversation_event(&event).await {
                    tracing::warn!(
                        conversation_id = %conversation_id,
                        sequence = event.sequence,
                        %error,
                        "Failed to notify inbound channel conversation event"
                    );
                }
            }
        }
        Err(error) => {
            tracing::warn!(
                conversation_id = %conversation_id,
                after_sequence,
                %error,
                "Failed to load inbound channel conversation events for emission"
            );
        }
    }
}

async fn list_conversations(app: &AppHandle, prefix: &str) -> String {
    let state = app.state::<AppState>();
    let conversations = match recent_conversations(&state, 10).await {
        Ok(conversations) => conversations,
        Err(error) => return format!("❌ 无法读取对话：{error}"),
    };
    if conversations.is_empty() {
        return "当前没有可用对话。请先在 VibeX 桌面端创建一个对话。".to_string();
    }
    let mut out = String::from("🗂 最近对话：\n");
    for (index, conversation) in conversations.iter().enumerate() {
        let title = conversation
            .title
            .as_deref()
            .filter(|title| !title.trim().is_empty())
            .unwrap_or("未命名对话");
        let agent = conversation.agent_type.as_deref().unwrap_or("unknown");
        out.push_str(&format!(
            "{}. {agent} [{:?}] {} · 对话 {}\n",
            index + 1,
            conversation.status,
            title,
            short_id(&conversation.id.to_string())
        ));
    }
    out.push_str(&format!(
        "\n用 {prefix} use <序号> 选择，再 {prefix} task <内容> 发送。"
    ));
    out
}

async fn select_conversation(
    app: &AppHandle,
    channel_id: &str,
    sender_id: &str,
    args: &str,
    prefix: &str,
) -> String {
    let index: usize = match args.trim().parse() {
        Ok(value) if value >= 1 => value,
        _ => return format!("用法：{prefix} use <序号>（先用 {prefix} conversations 查看）"),
    };
    let state = app.state::<AppState>();
    let conversations = match recent_conversations(&state, 10).await {
        Ok(conversations) => conversations,
        Err(error) => return format!("❌ 无法读取对话：{error}"),
    };
    let Some(conversation) = conversations.get(index - 1) else {
        return format!("序号超出范围，当前有 {} 个对话。", conversations.len());
    };
    session_bridge()
        .lock()
        .map(|mut bridge| {
            bridge.insert(
                (channel_id.to_string(), sender_id.to_string()),
                conversation.id.to_string(),
            );
        })
        .ok();
    let title = conversation
        .title
        .as_deref()
        .filter(|title| !title.trim().is_empty())
        .unwrap_or("未命名对话");
    format!(
        "✅ 已选择对话 {}（{}），用 {prefix} task <内容> 发送。",
        short_id(&conversation.id.to_string()),
        title
    )
}

/// Resolve the target conversation for the sender: an explicit `use` selection,
/// or the single recent conversation, otherwise an error asking to pick one.
async fn resolve_target(
    app: &AppHandle,
    channel_id: &str,
    sender_id: &str,
    prefix: &str,
) -> Result<ConversationCommandTarget, String> {
    let state = app.state::<AppState>();
    let conversations = recent_conversations(&state, 10)
        .await
        .map_err(|error| format!("❌ 无法读取对话：{error}"))?;
    let selected = session_bridge().lock().ok().and_then(|bridge| {
        bridge
            .get(&(channel_id.to_string(), sender_id.to_string()))
            .cloned()
    });
    if let Some(selected) = selected
        && let Ok(conversation_id) = Uuid::parse_str(&selected)
    {
        if let Some(conversation) = conversations
            .iter()
            .find(|conversation| conversation.id == conversation_id)
        {
            return Ok(conversation.clone());
        }
    }

    match conversations.len() {
        0 => Err("当前没有可用对话。请先在 VibeX 桌面端创建一个对话。".to_string()),
        1 => Ok(conversations[0].clone()),
        _ => Err(format!(
            "有多个最近对话，请先用 {prefix} conversations 查看并 {prefix} use <序号> 选择。"
        )),
    }
}

async fn send_task(
    app: &AppHandle,
    channel_id: &str,
    sender_id: &str,
    args: &str,
    prefix: &str,
) -> String {
    if args.is_empty() {
        return format!("用法：{prefix} task <内容>");
    }
    let target = match resolve_target(app, channel_id, sender_id, prefix).await {
        Ok(target) => target,
        Err(message) => return message,
    };
    let Some(agent_type) = target
        .agent_type
        .as_deref()
        .and_then(agent_type_from_executor_key)
    else {
        return "该对话没有可用的 Agent 绑定。请先在桌面端对这个对话发送一次消息。".to_string();
    };
    let state = app.state::<AppState>();
    let pool = state.deployment.db().pool.clone();
    let previous_last_sequence = match conversation_last_sequence(&pool, target.id).await {
        Ok(sequence) => sequence,
        Err(error) => return format!("❌ 发送失败：{error}"),
    };

    let result = ConversationSessionService::new(&state)
        .start_turn(ConversationStartTurnInput {
            agent_type,
            workspace_id: target.workspace_id,
            conversation_id: target.id,
            executor_profile_id: None,
            text: args.to_string(),
            images: Vec::new(),
            mode_override: None,
            config_overrides: Vec::new(),
        })
        .await;

    emit_conversation_events_after(app, &pool, target.id, previous_last_sequence).await;

    match result {
        Ok(_) => format!("✅ 已发送到对话 {}", short_id(&target.id.to_string())),
        Err(error) => format!("❌ 发送失败：{error}"),
    }
}
