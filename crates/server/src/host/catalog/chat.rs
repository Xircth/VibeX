use application::ApplicationError;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use services::services::chat_delivery::{
    DEFAULT_CHAT_EVENTS, RichMessage, channel_has_token, delete_channel_token, deliver_rich,
    load_channel_token, load_channel_tokens, save_channel_token,
};
use uuid::Uuid;

use crate::domains::{ServerApplicationDomains, internal_error, parse, serialize};

const SETTINGS_SECTION: &str = "chat_channels";
const SUPPORTED_KINDS: &[&str] = &["telegram", "feishu", "weixin", "qq", "webhook"];

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChatChannel {
    id: String,
    name: String,
    kind: String,
    enabled: bool,
    config: Value,
    has_token: bool,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChatChannelRecord {
    id: String,
    name: String,
    kind: String,
    enabled: bool,
    #[serde(default)]
    config: Value,
    #[serde(default)]
    webhook_url: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChatChannelStore {
    #[serde(default)]
    channels: Vec<ChatChannelRecord>,
    #[serde(default = "default_event_filter")]
    event_filter: Vec<String>,
    #[serde(default = "default_command_prefix")]
    command_prefix: String,
    #[serde(default)]
    include_prompt_text: bool,
    #[serde(default)]
    event_webhooks: Vec<EventWebhookConfig>,
    #[serde(default)]
    message_language: String,
}

impl Default for ChatChannelStore {
    fn default() -> Self {
        Self {
            channels: Vec::new(),
            event_filter: default_event_filter(),
            command_prefix: default_command_prefix(),
            include_prompt_text: false,
            event_webhooks: Vec::new(),
            message_language: "en".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct EventWebhookConfig {
    url: String,
    #[serde(default)]
    enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct ChatChannelPayload {
    name: String,
    kind: String,
    enabled: bool,
    #[serde(default)]
    config: Value,
    #[serde(default)]
    token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChatEventFilter {
    enabled_events: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChatCommandPrefix {
    prefix: String,
}

#[derive(Debug, Clone, Serialize)]
struct ChatChannelTestResult {
    ok: bool,
    status: Option<u16>,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
struct ChatChannelStatus {
    channel_id: String,
    status: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChannelIdArgs {
    channel_id: String,
    payload: Option<ChatChannelPayload>,
    token: Option<String>,
    limit: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateArgs {
    payload: ChatChannelPayload,
}

fn default_event_filter() -> Vec<String> {
    DEFAULT_CHAT_EVENTS
        .iter()
        .map(|event| event.to_string())
        .collect()
}

fn default_command_prefix() -> String {
    "/vibex".to_string()
}

async fn load_store() -> Result<ChatChannelStore, ApplicationError> {
    let mut store: ChatChannelStore =
        services::services::settings_store::read_section(&utils::assets::settings_path(), SETTINGS_SECTION)
            .await
            .map_err(internal_error)?
            .unwrap_or_default();
    if store.event_filter.is_empty() {
        store.event_filter = default_event_filter();
    }
    if store.command_prefix.trim().is_empty() {
        store.command_prefix = default_command_prefix();
    }
    Ok(store)
}

async fn save_store(store: &ChatChannelStore) -> Result<(), ApplicationError> {
    services::services::settings_store::write_section(
        &utils::assets::settings_path(),
        SETTINGS_SECTION,
        store,
    )
    .await
    .map_err(internal_error)
}

fn config_str(config: &Value, key: &str) -> String {
    config
        .get(key)
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .unwrap_or_default()
}

fn require_field(config: &Value, key: &str, label: &str) -> Result<String, ApplicationError> {
    let value = config_str(config, key);
    if value.is_empty() {
        Err(ApplicationError::bad_request(format!("{label}不能为空")))
    } else {
        Ok(value)
    }
}

fn normalize_payload(payload: ChatChannelPayload) -> Result<ChatChannelPayload, ApplicationError> {
    let name = payload.name.trim().to_string();
    if name.is_empty() {
        return Err(ApplicationError::bad_request("渠道名称不能为空"));
    }
    let kind = payload.kind.trim().to_string();
    if !SUPPORTED_KINDS.contains(&kind.as_str()) {
        return Err(ApplicationError::bad_request(format!(
            "不支持的渠道类型：{kind}"
        )));
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
        "weixin" => match config_str(&config, "mode").as_str() {
            "" | "wecom" | "ilink" => {}
            other => {
                return Err(ApplicationError::bad_request(format!(
                    "不支持的微信模式：{other}"
                )));
            }
        },
        "qq" => {
            let base_url = require_field(&config, "base_url", "OneBot 服务地址")?;
            reqwest::Url::parse(&base_url)
                .map_err(|error| ApplicationError::bad_request(format!("OneBot 服务地址无效：{error}")))?;
            require_field(&config, "target_id", "QQ 群号/QQ 号")?;
        }
        "webhook" => {
            let url = require_field(&config, "webhook_url", "Webhook URL")?;
            reqwest::Url::parse(&url)
                .map_err(|error| ApplicationError::bad_request(format!("Webhook URL 无效：{error}")))?;
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

fn merge_channel_config(kind: &str, existing: &Value, incoming: Value) -> Value {
    if kind != "weixin" {
        return incoming;
    }
    let mut merged = if existing.is_object() {
        existing.clone()
    } else {
        json!({})
    };
    if let Some(object) = incoming.as_object() {
        for (key, value) in object {
            merged[key] = value.clone();
        }
    }
    merged
}

fn hydrate_channel(record: &ChatChannelRecord, has_token: bool) -> ChatChannel {
    ChatChannel {
        id: record.id.clone(),
        name: record.name.clone(),
        kind: record.kind.clone(),
        enabled: record.enabled,
        config: if record.config.is_null() {
            json!({})
        } else {
            record.config.clone()
        },
        has_token,
        created_at: record.created_at.clone(),
        updated_at: record.updated_at.clone(),
    }
}

pub(super) async fn list_channels() -> Result<Value, ApplicationError> {
    let store = load_store().await?;
    let ids: Vec<String> = store.channels.iter().map(|channel| channel.id.clone()).collect();
    let tokens = load_channel_tokens(&ids).await;
    serialize(
        store
            .channels
            .iter()
            .map(|record| hydrate_channel(record, tokens.contains_key(&record.id)))
            .collect::<Vec<_>>(),
    )
}

pub(super) async fn create_channel(args: Value) -> Result<Value, ApplicationError> {
    let args: CreateArgs = parse(args)?;
    let token = args.payload.token.clone();
    let payload = normalize_payload(args.payload)?;
    let mut store = load_store().await?;
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
    let mut has_token = false;
    if let Some(token) = token.as_deref().map(str::trim).filter(|token| !token.is_empty()) {
        save_channel_token(&record.id, token)
            .await
            .map_err(internal_error)?;
        has_token = true;
    }
    let channel = hydrate_channel(&record, has_token);
    store.channels.push(record);
    save_store(&store).await?;
    serialize(channel)
}

pub(super) async fn update_channel(args: Value) -> Result<Value, ApplicationError> {
    let args: ChannelIdArgs = parse(args)?;
    let payload = args
        .payload
        .ok_or_else(|| ApplicationError::bad_request("payload required"))?;
    let token = payload.token.clone();
    let payload = normalize_payload(payload)?;
    let mut store = load_store().await?;
    {
        let record = store
            .channels
            .iter_mut()
            .find(|channel| channel.id == args.channel_id)
            .ok_or_else(|| {
                ApplicationError::not_found(format!("Chat channel not found: {}", args.channel_id))
            })?;
        record.name = payload.name;
        record.kind = payload.kind.clone();
        record.enabled = payload.enabled;
        record.config = merge_channel_config(&record.kind, &record.config, payload.config);
        record.webhook_url = String::new();
        record.updated_at = Utc::now().to_rfc3339();
    }
    if let Some(token) = token.as_deref().map(str::trim).filter(|token| !token.is_empty()) {
        save_channel_token(&args.channel_id, token)
            .await
            .map_err(internal_error)?;
    }
    save_store(&store).await?;
    let has = channel_has_token(&args.channel_id).await;
    let record = store
        .channels
        .iter()
        .find(|channel| channel.id == args.channel_id)
        .expect("channel exists after update");
    serialize(hydrate_channel(record, has))
}

pub(super) async fn delete_channel(args: Value) -> Result<Value, ApplicationError> {
    let args: ChannelIdArgs = parse(args)?;
    let mut store = load_store().await?;
    let original_len = store.channels.len();
    store.channels.retain(|channel| channel.id != args.channel_id);
    if original_len == store.channels.len() {
        return Err(ApplicationError::not_found(format!(
            "Chat channel not found: {}",
            args.channel_id
        )));
    }
    save_store(&store).await?;
    delete_channel_token(&args.channel_id)
        .await
        .map_err(internal_error)?;
    Ok(Value::Null)
}

pub(super) async fn save_token(args: Value) -> Result<Value, ApplicationError> {
    let args: ChannelIdArgs = parse(args)?;
    let token = args
        .token
        .as_deref()
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| ApplicationError::bad_request("Token cannot be empty"))?;
    let store = load_store().await?;
    let record = store
        .channels
        .iter()
        .find(|channel| channel.id == args.channel_id)
        .ok_or_else(|| {
            ApplicationError::not_found(format!("Chat channel not found: {}", args.channel_id))
        })?;
    save_channel_token(&args.channel_id, token)
        .await
        .map_err(internal_error)?;
    serialize(hydrate_channel(record, true))
}

pub(super) async fn has_token(args: Value) -> Result<Value, ApplicationError> {
    let args: ChannelIdArgs = parse(args)?;
    serialize(channel_has_token(&args.channel_id).await)
}

pub(super) async fn delete_token(args: Value) -> Result<Value, ApplicationError> {
    let args: ChannelIdArgs = parse(args)?;
    delete_channel_token(&args.channel_id)
        .await
        .map_err(internal_error)?;
    Ok(Value::Null)
}

pub(super) async fn test_channel(args: Value) -> Result<Value, ApplicationError> {
    let args: ChannelIdArgs = parse(args)?;
    let store = load_store().await?;
    let channel = store
        .channels
        .iter()
        .find(|channel| channel.id == args.channel_id)
        .ok_or_else(|| {
            ApplicationError::not_found(format!("Chat channel not found: {}", args.channel_id))
        })?;
    let token = load_channel_token(&channel.id).await;
    let msg = RichMessage::info("这是一条来自 VibeX 设置页的测试消息。")
        .with_title("🔔 VibeX 测试通知")
        .with_field("渠道", channel.name.clone());
    match deliver_rich(&channel.id, &channel.kind, &channel.config, token.as_deref(), &msg).await {
        Ok(status) => serialize(ChatChannelTestResult {
            ok: true,
            status,
            message: "测试消息已发送".to_string(),
        }),
        Err(error) => serialize(ChatChannelTestResult {
            ok: false,
            status: None,
            message: error.to_string(),
        }),
    }
}

pub(super) async fn get_event_filter() -> Result<Value, ApplicationError> {
    serialize(ChatEventFilter {
        enabled_events: load_store().await?.event_filter,
    })
}

pub(super) async fn set_event_filter(args: Value) -> Result<Value, ApplicationError> {
    let filter: ChatEventFilter = parse(args.get("filter").cloned().unwrap_or(args))?;
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
    serialize(ChatEventFilter {
        enabled_events: events,
    })
}

pub(super) async fn get_command_prefix() -> Result<Value, ApplicationError> {
    serialize(ChatCommandPrefix {
        prefix: load_store().await?.command_prefix,
    })
}

pub(super) async fn set_command_prefix(args: Value) -> Result<Value, ApplicationError> {
    let prefix: ChatCommandPrefix = parse(args.get("prefix").cloned().unwrap_or(args))?;
    let prefix = prefix.prefix.trim().to_string();
    if prefix.is_empty() {
        return Err(ApplicationError::bad_request(
            "Command prefix cannot be empty",
        ));
    }
    let mut store = load_store().await?;
    store.command_prefix = prefix.clone();
    save_store(&store).await?;
    serialize(ChatCommandPrefix { prefix })
}

pub(super) async fn get_include_prompt_text() -> Result<Value, ApplicationError> {
    serialize(load_store().await?.include_prompt_text)
}

pub(super) async fn set_include_prompt_text(args: Value) -> Result<Value, ApplicationError> {
    let enabled = args
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| ApplicationError::bad_request("enabled required"))?;
    let mut store = load_store().await?;
    store.include_prompt_text = enabled;
    save_store(&store).await?;
    serialize(enabled)
}

pub(super) async fn list_statuses() -> Result<Value, ApplicationError> {
    let states = crate::chat_channel_connection_states();
    let store = load_store().await.unwrap_or_default();
    serialize(
        store
            .channels
            .into_iter()
            .map(|channel| ChatChannelStatus {
                status: states.get(&channel.id).cloned().unwrap_or_else(|| {
                    if channel.enabled {
                        "disconnected".into()
                    } else {
                        "disabled".into()
                    }
                }),
                channel_id: channel.id,
            })
            .collect::<Vec<_>>(),
    )
}

pub(super) async fn connect(args: Value) -> Result<Value, ApplicationError> {
    let args: ChannelIdArgs = parse(args)?;
    let store = load_store().await?;
    if !store.channels.iter().any(|channel| channel.id == args.channel_id) {
        return Err(ApplicationError::not_found(format!(
            "Chat channel not found: {}",
            args.channel_id
        )));
    }
    crate::connect_chat_channel(&args.channel_id);
    Ok(Value::Null)
}

pub(super) async fn disconnect(args: Value) -> Result<Value, ApplicationError> {
    let args: ChannelIdArgs = parse(args)?;
    let store = load_store().await?;
    if !store.channels.iter().any(|channel| channel.id == args.channel_id) {
        return Err(ApplicationError::not_found(format!(
            "Chat channel not found: {}",
            args.channel_id
        )));
    }
    crate::disconnect_chat_channel(&args.channel_id);
    Ok(Value::Null)
}

pub(super) async fn list_message_logs(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: ChannelIdArgs = parse(args)?;
    serialize(
        db::models::chat_channel_message_log::ChatChannelMessageLog::list_recent(
            &domains.pool,
            &args.channel_id,
            args.limit.unwrap_or(20).clamp(1, 200),
        )
        .await
        .map_err(internal_error)?,
    )
}
