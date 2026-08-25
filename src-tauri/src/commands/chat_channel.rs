//! IM message channel configuration, secrets, test-send, and Weixin QR onboarding.
//! Inbound loops and outbound conversation delivery live on the Host
//! (`server::start_chat_inbound`, `server::ChatDeliveryPublisher`).

use std::{path::PathBuf, sync::OnceLock};

use agents::conversation::ConversationEventEnvelope;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use services::services::chat_delivery::{
    DEFAULT_CHAT_EVENTS as DEFAULT_EVENTS, RichMessage, channel_has_token, delete_channel_token,
    deliver_rich, import_legacy_channel_tokens, load_channel_token, load_channel_tokens,
    save_channel_token,
};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{error::AppError, state::AppState};

const SETTINGS_FILE_NAME: &str = "chat-channel-settings.json";
const SETTINGS_SECTION: &str = "chat_channels";

const SUPPORTED_KINDS: &[&str] = &["telegram", "feishu", "weixin", "qq", "webhook"];

/// DB pool for the chat-channel delivery/audit log (P2-7). Set once at startup;
/// logging is best-effort and skipped if unset (e.g. in tests).
static AUDIT_POOL: OnceLock<SqlitePool> = OnceLock::new();

/// Register the pool used for chat-channel audit logging.
pub fn set_audit_pool(pool: SqlitePool) {
    let _ = AUDIT_POOL.set(pool);
}

/// Best-effort audit record of an outbound delivery or inbound command.
async fn audit(
    channel_id: &str,
    direction: &str,
    event: Option<&str>,
    status: &str,
    detail: Option<&str>,
) {
    let Some(pool) = AUDIT_POOL.get() else {
        return;
    };
    if let Err(error) = db::models::chat_channel_message_log::ChatChannelMessageLog::record(
        pool, channel_id, direction, event, status, detail,
    )
    .await
    {
        tracing::warn!(%error, "failed to write chat channel audit log");
    }
}

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
pub struct EventWebhookConfig {
    pub url: String,
    #[serde(default)]
    pub enabled: bool,
}

#[derive(Default, serde::Deserialize)]
struct LegacyChannelSecrets {
    #[serde(default)]
    tokens: std::collections::HashMap<String, String>,
}

/// Migrate legacy plaintext-JSON channel tokens into ~/.vibex/.env (ADR-0004), once
/// per process. Reads the old `chat-channel-secrets.json`, imports its tokens into the
/// .env store, then deletes the old file. Idempotent (the file is gone afterwards).
async fn ensure_secrets_migrated() -> Result<(), AppError> {
    static MIGRATED: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();
    MIGRATED
        .get_or_try_init(|| async {
            let legacy = utils::assets::asset_dir().join("chat-channel-secrets.json");
            if legacy.exists() {
                let secrets: LegacyChannelSecrets = read_json(legacy.clone()).await?;
                if !secrets.tokens.is_empty() {
                    import_legacy_channel_tokens(&secrets.tokens).await?;
                }
                let _ = tokio::fs::remove_file(&legacy).await;
            }
            Ok::<(), AppError>(())
        })
        .await
        .map(|_| ())
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

fn legacy_settings_path() -> PathBuf {
    utils::assets::asset_dir().join(SETTINGS_FILE_NAME)
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

async fn load_store() -> Result<ChatChannelStore, AppError> {
    let mut store: ChatChannelStore = match services::services::settings_store::read_section(
        &utils::assets::settings_path(),
        SETTINGS_SECTION,
    )
    .await
    .map_err(|error| AppError::Internal(error.to_string()))?
    {
        Some(store) => store,
        None => {
            let store = read_json(legacy_settings_path()).await?;
            save_store(&store).await?;
            store
        }
    };
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
    services::services::settings_store::write_section(
        &utils::assets::settings_path(),
        SETTINGS_SECTION,
        store,
    )
    .await
    .map_err(|error| AppError::Internal(error.to_string()))
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
        "weixin" => match config_str(&config, "mode").as_str() {
            "" | "wecom" | "ilink" => {}
            other => {
                return Err(AppError::BadRequest(format!("不支持的微信模式：{other}")));
            }
        },
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
    if incoming.get("mode").and_then(Value::as_str) == Some("wecom") {
        if let Some(object) = merged.as_object_mut() {
            object.remove("base_url");
        }
    }
    merged
}

fn hydrate_channel(record: &ChatChannelRecord, has_token: bool) -> ChatChannel {
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
        has_token,
        created_at: record.created_at.clone(),
        updated_at: record.updated_at.clone(),
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_chat_channels() -> Result<Vec<ChatChannel>, AppError> {
    ensure_secrets_migrated().await?;
    let store = load_store().await?;
    let ids: Vec<String> = store.channels.iter().map(|c| c.id.clone()).collect();
    let tokens = load_channel_tokens(&ids).await;
    Ok(store
        .channels
        .iter()
        .map(|record| hydrate_channel(record, tokens.contains_key(&record.id)))
        .collect())
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatChannelStatus {
    pub channel_id: String,
    pub status: String,
}

#[tauri::command]
pub async fn list_chat_channel_statuses() -> Result<Vec<ChatChannelStatus>, AppError> {
    let states = server::chat_channel_connection_states();
    let store = load_store().await.unwrap_or_default();
    Ok(store
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
        .collect())
}

#[tauri::command]
pub async fn create_chat_channel(payload: ChatChannelPayload) -> Result<ChatChannel, AppError> {
    ensure_secrets_migrated().await?;
    let token = payload.token.clone();
    let payload = normalize_payload(payload)?;
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
    if let Some(token) = token.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        save_channel_token(&record.id, token).await?;
        has_token = true;
    }

    let channel = hydrate_channel(&record, has_token);
    store.channels.push(record);
    save_store(&store).await?;
    Ok(channel)
}

#[tauri::command]
pub async fn update_chat_channel(
    channel_id: String,
    payload: ChatChannelPayload,
) -> Result<ChatChannel, AppError> {
    ensure_secrets_migrated().await?;
    let token = payload.token.clone();
    let payload = normalize_payload(payload)?;
    let mut store = load_store().await?;
    {
        let record = store
            .channels
            .iter_mut()
            .find(|channel| channel.id == channel_id)
            .ok_or_else(|| AppError::NotFound(format!("Chat channel not found: {channel_id}")))?;
        record.name = payload.name;
        record.kind = payload.kind.clone();
        record.enabled = payload.enabled;
        record.config = merge_channel_config(&record.kind, &record.config, payload.config);
        record.webhook_url = String::new();
        record.updated_at = Utc::now().to_rfc3339();
    }

    if let Some(token) = token.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        save_channel_token(&channel_id, token).await?;
    }

    save_store(&store).await?;
    let has = channel_has_token(&channel_id).await;
    let record = store
        .channels
        .iter()
        .find(|channel| channel.id == channel_id)
        .expect("channel exists after update");
    Ok(hydrate_channel(record, has))
}

#[tauri::command]
pub async fn delete_chat_channel(channel_id: String) -> Result<(), AppError> {
    ensure_secrets_migrated().await?;
    let mut store = load_store().await?;
    let original_len = store.channels.len();
    store.channels.retain(|channel| channel.id != channel_id);
    if original_len == store.channels.len() {
        return Err(AppError::NotFound(format!(
            "Chat channel not found: {channel_id}"
        )));
    }
    save_store(&store).await?;
    delete_channel_token(&channel_id).await?;
    Ok(())
}

#[tauri::command]
pub async fn save_chat_channel_token(
    channel_id: String,
    token: String,
) -> Result<ChatChannel, AppError> {
    ensure_secrets_migrated().await?;
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
    save_channel_token(&channel_id, token).await?;
    Ok(hydrate_channel(record, true))
}

#[tauri::command]
pub async fn get_chat_channel_has_token(channel_id: String) -> Result<bool, AppError> {
    ensure_secrets_migrated().await?;
    Ok(channel_has_token(&channel_id).await)
}

#[tauri::command]
pub async fn delete_chat_channel_token(channel_id: String) -> Result<(), AppError> {
    ensure_secrets_migrated().await?;
    delete_channel_token(&channel_id).await?;
    Ok(())
}

#[tauri::command]
pub async fn test_chat_channel(channel_id: String) -> Result<ChatChannelTestResult, AppError> {
    ensure_secrets_migrated().await?;
    let store = load_store().await?;
    let channel = store
        .channels
        .iter()
        .find(|channel| channel.id == channel_id)
        .ok_or_else(|| AppError::NotFound(format!("Chat channel not found: {channel_id}")))?;

    let token = load_channel_token(&channel.id).await;
    let msg = RichMessage::info("这是一条来自 VibeX 设置页的测试消息。")
        .with_title("🔔 VibeX 测试通知")
        .with_field("渠道", channel.name.clone());
    match deliver_rich(
        &channel.id,
        &channel.kind,
        &channel.config,
        token.as_deref(),
        &msg,
    )
    .await
    {
        Ok(status) => {
            audit(&channel.id, "outbound", Some("test"), "sent", None).await;
            Ok(ChatChannelTestResult {
                ok: true,
                status,
                message: "测试消息已发送".to_string(),
            })
        }
        Err(error) => {
            audit(
                &channel.id,
                "outbound",
                Some("test"),
                "failed",
                Some(&error.to_string()),
            )
            .await;
            Ok(ChatChannelTestResult {
                ok: false,
                status: None,
                message: error.to_string(),
            })
        }
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

#[tauri::command]
pub async fn get_chat_event_webhooks() -> Result<Vec<EventWebhookConfig>, AppError> {
    Ok(load_store().await?.event_webhooks)
}

#[tauri::command]
pub async fn set_chat_event_webhooks(
    webhooks: Vec<EventWebhookConfig>,
) -> Result<Vec<EventWebhookConfig>, AppError> {
    let cleaned = webhooks
        .into_iter()
        .filter(|hook| {
            let url = hook.url.trim();
            url.starts_with("http://") || url.starts_with("https://")
        })
        .map(|mut hook| {
            hook.url = hook.url.trim().to_string();
            hook
        })
        .collect::<Vec<_>>();
    let mut store = load_store().await?;
    store.event_webhooks = cleaned.clone();
    save_store(&store).await?;
    Ok(cleaned)
}

#[tauri::command]
pub async fn get_chat_message_language() -> Result<String, AppError> {
    let lang = load_store().await?.message_language;
    Ok(if lang.trim().is_empty() {
        "en".to_string()
    } else {
        lang
    })
}

#[tauri::command]
pub async fn set_chat_message_language(language: String) -> Result<String, AppError> {
    let language = match language.as_str() {
        "zh-CN" | "zh" | "zh-cn" => "zh-CN".to_string(),
        _ => "en".to_string(),
    };
    let mut store = load_store().await?;
    store.message_language = language.clone();
    save_store(&store).await?;
    Ok(language)
}

#[tauri::command]
pub async fn weixin_get_qrcode() -> Result<server::WeixinQrcodeInfo, AppError> {
    server::weixin_get_qrcode()
        .await
        .map_err(AppError::Internal)
}

#[derive(Debug, Clone, Deserialize)]
pub struct WeixinCheckQrcodeRequest {
    pub channel_id: String,
    pub qrcode: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct WeixinQrcodeStatusPublic {
    pub status: String,
}

#[tauri::command]
pub async fn weixin_check_qrcode(
    request: WeixinCheckQrcodeRequest,
) -> Result<WeixinQrcodeStatusPublic, AppError> {
    let status = server::weixin_check_qrcode(&request.qrcode)
        .await
        .map_err(AppError::Internal)?;
    if status.status == "confirmed" {
        if let Some(token) = status.bot_token.as_deref() {
            save_channel_token(&request.channel_id, token).await?;
        }
        if let Some(base_url) = status.base_url.clone() {
            let mut store = load_store().await?;
            if let Some(channel) = store
                .channels
                .iter_mut()
                .find(|channel| channel.id == request.channel_id)
            {
                let mut config = if channel.config.is_null() {
                    json!({})
                } else {
                    channel.config.clone()
                };
                config["mode"] = json!("ilink");
                config["base_url"] = json!(base_url);
                channel.config = config;
                channel.updated_at = Utc::now().to_rfc3339();
            }
            save_store(&store).await?;
        }
    }
    Ok(WeixinQrcodeStatusPublic {
        status: status.status,
    })
}

#[tauri::command]
pub async fn connect_chat_channel(channel_id: String) -> Result<(), AppError> {
    let store = load_store().await?;
    if !store
        .channels
        .iter()
        .any(|channel| channel.id == channel_id)
    {
        return Err(AppError::NotFound(format!(
            "Chat channel not found: {channel_id}"
        )));
    }
    server::connect_chat_channel(&channel_id);
    Ok(())
}

#[tauri::command]
pub async fn disconnect_chat_channel(channel_id: String) -> Result<(), AppError> {
    let store = load_store().await?;
    if !store
        .channels
        .iter()
        .any(|channel| channel.id == channel_id)
    {
        return Err(AppError::NotFound(format!(
            "Chat channel not found: {channel_id}"
        )));
    }
    server::disconnect_chat_channel(&channel_id);
    Ok(())
}

/// Recent delivery/audit log entries for a channel (P2-7).
#[tauri::command]
pub async fn list_chat_channel_message_logs(
    state: tauri::State<'_, AppState>,
    channel_id: String,
    limit: Option<i64>,
) -> Result<Vec<db::models::chat_channel_message_log::ChatChannelMessageLog>, AppError> {
    let pool = &state.deployment.db().pool;
    db::models::chat_channel_message_log::ChatChannelMessageLog::list_recent(
        pool,
        &channel_id,
        limit.unwrap_or(20).clamp(1, 200),
    )
    .await
    .map_err(AppError::from)
}

pub async fn notify_conversation_event(envelope: &ConversationEventEnvelope) {
    server::notify_conversation_event(envelope).await;
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::merge_channel_config;

    #[test]
    fn weixin_save_keeps_ilink_fields_when_mode_omitted() {
        let existing = json!({
            "mode": "ilink",
            "base_url": "https://ilink.example",
        });
        let merged = merge_channel_config("weixin", &existing, json!({}));
        assert_eq!(merged["mode"], "ilink");
        assert_eq!(merged["base_url"], "https://ilink.example");
    }

    #[test]
    fn weixin_wecom_mode_drops_ilink_base_url() {
        let existing = json!({
            "mode": "ilink",
            "base_url": "https://ilink.example",
        });
        let merged = merge_channel_config("weixin", &existing, json!({ "mode": "wecom" }));
        assert_eq!(merged["mode"], "wecom");
        assert!(merged.get("base_url").is_none());
    }
}
