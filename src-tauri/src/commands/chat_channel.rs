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
    time::{Duration, Instant},
};

use agents::{
    AgentConnectionId, AgentConnectionStatus, AgentContentBlock, AgentEvent, AgentEventEnvelope,
    AgentRuntime, AgentSessionId, SendAgentPromptInput,
};
use chrono::Utc;
use futures::{SinkExt, StreamExt};
use prost::Message as ProstMessage;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite;
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

/// Minimum interval between pushes of the same event type per channel.
const DEBOUNCE_SECS: u64 = 5;
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
// Rich message model + per-platform rendering
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MsgLevel {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone)]
struct RichMessage {
    title: Option<String>,
    body: String,
    fields: Vec<(String, String)>,
    level: MsgLevel,
}

impl RichMessage {
    fn info(body: impl Into<String>) -> Self {
        Self {
            title: None,
            body: body.into(),
            fields: Vec::new(),
            level: MsgLevel::Info,
        }
    }

    fn with_title(mut self, title: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self
    }

    fn with_field(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.fields.push((key.into(), value.into()));
        self
    }

    fn level(mut self, level: MsgLevel) -> Self {
        self.level = level;
        self
    }

    fn to_plain(&self) -> String {
        let mut text = String::new();
        if let Some(title) = &self.title {
            text.push_str(title);
            text.push('\n');
        }
        text.push_str(&self.body);
        for (key, value) in &self.fields {
            text.push_str(&format!("\n{key}: {value}"));
        }
        text
    }
}

fn level_emoji(level: MsgLevel) -> &'static str {
    match level {
        MsgLevel::Info => "ℹ️",
        MsgLevel::Warning => "⚠️",
        MsgLevel::Error => "❌",
    }
}

/// Build a rich notification from an agent event. `include_prompt_text` gates
/// whether the user's prompt text is exposed to external channels.
fn build_rich(event: &AgentEvent, include_prompt_text: bool) -> RichMessage {
    match event {
        AgentEvent::PromptStarted { snapshot } => {
            let body = if include_prompt_text && !snapshot.text_preview.trim().is_empty() {
                snapshot.text_preview.clone()
            } else {
                "智能体开始执行任务。".to_string()
            };
            RichMessage::info(body).with_title("🚀 任务开始")
        }
        AgentEvent::PromptFinished { finished } => RichMessage::info("智能体已完成本次任务。")
            .with_title("✅ 任务完成")
            .with_field("Prompt", finished.prompt_id.to_string()),
        AgentEvent::PermissionRequested { request } => {
            RichMessage::info("智能体正在等待你的授权。")
                .with_title("🔐 权限请求")
                .with_field("操作", request.title.clone())
                .level(MsgLevel::Warning)
        }
        AgentEvent::Error { error } => RichMessage::info("智能体运行出现错误。")
            .with_title("❌ 运行错误")
            .with_field("信息", error.message.clone())
            .level(MsgLevel::Error),
        AgentEvent::ConnectionStatusChanged { snapshot } => RichMessage::info(format!(
            "{:?} 连接状态变更为 {:?}",
            snapshot.agent_type, snapshot.status
        ))
        .with_title("🔌 连接状态"),
        AgentEvent::SessionCreated { snapshot } => RichMessage::info("新的会话已创建。")
            .with_title("🆕 会话创建")
            .with_field("Session", snapshot.id.to_string()),
        AgentEvent::TurnCompleted { .. } => {
            RichMessage::info("智能体完成了一个回合。").with_title("🔄 回合完成")
        }
        _ => RichMessage::info("VibeX 事件").with_title("VibeX"),
    }
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(35))
        .build()
        .unwrap_or_default()
}

/// Deliver a rich message to a typed channel; returns an optional HTTP status.
async fn deliver_rich(
    record: &ChatChannelRecord,
    token: Option<&str>,
    msg: &RichMessage,
) -> Result<Option<u16>, AppError> {
    match record.kind.as_str() {
        "telegram" => telegram_send_rich(&record.config, token, msg).await,
        "feishu" => feishu_send_rich(&record.config, token, msg).await,
        "weixin" => weixin_send_rich(token, msg).await,
        "qq" => qq_send_text(&record.config, token, &msg.to_plain()).await,
        _ => webhook_send_rich(record, token, msg).await,
    }
}

// ── Telegram ──

async fn telegram_post(
    bot_token: &str,
    chat_id: &str,
    text: &str,
    parse_mode: Option<&str>,
) -> Result<Option<u16>, AppError> {
    let mut body = json!({ "chat_id": chat_id, "text": text });
    if let Some(mode) = parse_mode {
        body["parse_mode"] = Value::String(mode.to_string());
    }
    let response = http_client()
        .post(format!(
            "https://api.telegram.org/bot{bot_token}/sendMessage"
        ))
        .json(&body)
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

fn telegram_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        if matches!(
            ch,
            '_' | '*'
                | '['
                | ']'
                | '('
                | ')'
                | '~'
                | '`'
                | '>'
                | '#'
                | '+'
                | '-'
                | '='
                | '|'
                | '{'
                | '}'
                | '.'
                | '!'
                | '\\'
        ) {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

fn telegram_markdown(msg: &RichMessage) -> String {
    let mut text = String::new();
    if let Some(title) = &msg.title {
        text.push_str(&format!(
            "{} *{}*\n",
            level_emoji(msg.level),
            telegram_escape(title)
        ));
    }
    text.push_str(&telegram_escape(&msg.body));
    for (key, value) in &msg.fields {
        text.push_str(&format!(
            "\n*{}*: {}",
            telegram_escape(key),
            telegram_escape(value)
        ));
    }
    text
}

async fn telegram_send_rich(
    config: &Value,
    token: Option<&str>,
    msg: &RichMessage,
) -> Result<Option<u16>, AppError> {
    let bot_token = token
        .filter(|t| !t.trim().is_empty())
        .ok_or_else(|| AppError::BadRequest("Telegram 渠道缺少 Bot Token".to_string()))?;
    let chat_id = require_field(config, "chat_id", "Telegram chat_id")?;
    match telegram_post(
        bot_token,
        &chat_id,
        &telegram_markdown(msg),
        Some("MarkdownV2"),
    )
    .await
    {
        Ok(status) => Ok(status),
        // MarkdownV2 is finicky; fall back to plain text.
        Err(_) => telegram_post(bot_token, &chat_id, &msg.to_plain(), None).await,
    }
}

// ── Feishu (Lark) app mode ──

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

fn feishu_card(msg: &RichMessage) -> String {
    let template = match msg.level {
        MsgLevel::Info => "blue",
        MsgLevel::Warning => "orange",
        MsgLevel::Error => "red",
    };
    let mut elements = vec![json!({
        "tag": "div",
        "text": { "tag": "lark_md", "content": msg.body },
    })];
    for (key, value) in &msg.fields {
        elements.push(json!({
            "tag": "div",
            "text": { "tag": "lark_md", "content": format!("**{key}**：{value}") },
        }));
    }
    json!({
        "config": { "wide_screen_mode": true },
        "header": {
            "template": template,
            "title": {
                "tag": "plain_text",
                "content": msg.title.clone().unwrap_or_else(|| "VibeX".to_string()),
            },
        },
        "elements": elements,
    })
    .to_string()
}

async fn feishu_send_rich(
    config: &Value,
    token: Option<&str>,
    msg: &RichMessage,
) -> Result<Option<u16>, AppError> {
    let app_id = require_field(config, "app_id", "飞书 App ID")?;
    let chat_id = require_field(config, "chat_id", "飞书 chat_id")?;
    let app_secret = token
        .filter(|t| !t.trim().is_empty())
        .ok_or_else(|| AppError::BadRequest("飞书渠道缺少 App Secret".to_string()))?;

    let tenant_token = feishu_tenant_token(&app_id, app_secret).await?;
    let response = http_client()
        .post("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id")
        .bearer_auth(&tenant_token)
        .json(&json!({
            "receive_id": chat_id,
            "msg_type": "interactive",
            "content": feishu_card(msg),
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

// ── WeCom (企业微信) group bot ──

fn wecom_markdown(msg: &RichMessage) -> String {
    let mut text = String::new();
    if let Some(title) = &msg.title {
        text.push_str(&format!("**{title}**\n"));
    }
    text.push_str(&msg.body);
    for (key, value) in &msg.fields {
        text.push_str(&format!("\n> {key}：{value}"));
    }
    text
}

async fn weixin_send_rich(token: Option<&str>, msg: &RichMessage) -> Result<Option<u16>, AppError> {
    let key = token
        .filter(|t| !t.trim().is_empty())
        .ok_or_else(|| AppError::BadRequest("企业微信渠道缺少 Webhook Key".to_string()))?;
    let response = http_client()
        .post(format!(
            "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key={key}"
        ))
        .json(&json!({
            "msgtype": "markdown",
            "markdown": { "content": wecom_markdown(msg) },
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

// ── QQ (OneBot 11 HTTP) ──

async fn qq_send_text(
    config: &Value,
    token: Option<&str>,
    text: &str,
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
    let payload = if is_private {
        json!({ "user_id": target_id, "message": text })
    } else {
        json!({ "group_id": target_id, "message": text })
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

// ── Generic webhook ──

async fn webhook_send_rich(
    record: &ChatChannelRecord,
    token: Option<&str>,
    msg: &RichMessage,
) -> Result<Option<u16>, AppError> {
    let url = require_field(&record.config, "webhook_url", "Webhook URL")?;
    let level = match msg.level {
        MsgLevel::Info => "info",
        MsgLevel::Warning => "warning",
        MsgLevel::Error => "error",
    };
    let fields: Vec<Value> = msg
        .fields
        .iter()
        .map(|(key, value)| json!({ "key": key, "value": value }))
        .collect();
    let payload = json!({
        "source": "vibex",
        "title": msg.title,
        "body": msg.body,
        "fields": fields,
        "level": level,
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

// ---------------------------------------------------------------------------
// Debounce (per channel + event type; warnings/errors bypass)
// ---------------------------------------------------------------------------

fn debounce_table() -> &'static StdMutex<HashMap<(String, String), Instant>> {
    static TABLE: OnceLock<StdMutex<HashMap<(String, String), Instant>>> = OnceLock::new();
    TABLE.get_or_init(|| StdMutex::new(HashMap::new()))
}

fn should_send(channel_id: &str, event: &str, level: MsgLevel) -> bool {
    // Blocking / failing states are always important enough to bypass debounce.
    if matches!(level, MsgLevel::Warning | MsgLevel::Error) {
        return true;
    }
    let now = Instant::now();
    let mut table = match debounce_table().lock() {
        Ok(table) => table,
        Err(_) => return true,
    };
    let key = (channel_id.to_string(), event.to_string());
    if let Some(last) = table.get(&key)
        && now.duration_since(*last) < Duration::from_secs(DEBOUNCE_SECS)
    {
        return false;
    }
    table.insert(key, now);
    true
}

// ---------------------------------------------------------------------------
// Event mapping
// ---------------------------------------------------------------------------

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
    match deliver_rich(channel, token, &msg).await {
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
        if let Err(error) = deliver_rich(channel, token, &msg).await {
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

// ---------------------------------------------------------------------------
// Inbound (bidirectional) — receivers + ACP command dispatch
// ---------------------------------------------------------------------------
//
// Telegram: HTTP long-poll. QQ: OneBot 11 forward WebSocket. Feishu: Lark
// long-connection WebSocket (pbbp2 protobuf frames). All feed `dispatch_command`,
// which can drive the VibeX agent runtime (ACP) — list sessions and send a
// prompt / follow-up to a selected session.

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
type SessionBridgeValue = (String, String);
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
pub fn start_inbound_manager(runtime: Arc<AgentRuntime>) {
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
                        spawn_receiver(runtime.clone(), &target, flag.clone());
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

fn spawn_receiver(runtime: Arc<AgentRuntime>, target: &InboundTarget, flag: Arc<AtomicBool>) {
    match target.kind.as_str() {
        "telegram" => spawn_telegram_loop(
            runtime,
            target.channel_id.clone(),
            target.token.clone(),
            flag,
        ),
        "qq" => spawn_qq_loop(
            runtime,
            target.channel_id.clone(),
            target.config.clone(),
            target.token.clone(),
            flag,
        ),
        "feishu" => spawn_feishu_loop(
            runtime,
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
    runtime: Arc<AgentRuntime>,
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
                    dispatch_command(text.trim(), &prefix, &runtime, &channel_id, &sender_id).await;
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
    runtime: Arc<AgentRuntime>,
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
                                    handle_qq_event(
                                        &runtime,
                                        &channel_id,
                                        &base_url,
                                        &token,
                                        &event,
                                    )
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
    runtime: &Arc<AgentRuntime>,
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
    let reply = dispatch_command(&text, &prefix, runtime, channel_id, &sender_id).await;
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
    runtime: Arc<AgentRuntime>,
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
                                                &runtime,
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
    runtime: &Arc<AgentRuntime>,
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
    let reply = dispatch_command(&text, &prefix, runtime, channel_id, &sender_id).await;
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
    runtime: &Arc<AgentRuntime>,
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
        "status" => status_text(prefix, runtime).await,
        "sessions" | "ls" => list_sessions(runtime, prefix).await,
        "use" => select_session(runtime, channel_id, sender_id, args, prefix).await,
        "task" | "do" | "ask" => send_task(runtime, channel_id, sender_id, args, prefix).await,
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
        "🤖 VibeX 机器人命令：\n{prefix} help — 显示帮助\n{prefix} ping — 检测在线\n{prefix} status — 运行状态\n{prefix} sessions — 列出活跃会话\n{prefix} use <序号> — 选择会话\n{prefix} task <内容> — 给所选会话发任务/追问\n{prefix} echo <文本> — 回显"
    )
}

async fn status_text(prefix: &str, runtime: &Arc<AgentRuntime>) -> String {
    let store = load_store().await.unwrap_or_default();
    let total = store.channels.len();
    let enabled = store.channels.iter().filter(|c| c.enabled).count();
    let snapshot = runtime.snapshot().await;
    format!(
        "🟢 VibeX 在线\n消息渠道：{enabled}/{total} 已启用\n活跃会话：{}\n版本：{}\n命令前缀：{prefix}",
        snapshot.sessions.len(),
        env!("CARGO_PKG_VERSION")
    )
}

fn short_id(id: &str) -> String {
    id.chars().take(8).collect()
}

fn dir_name(path: &str) -> &str {
    path.rsplit(['/', '\\'])
        .find(|s| !s.is_empty())
        .unwrap_or(path)
}

/// Active sessions sorted deterministically (by creation time) so list indices
/// stay stable between `sessions` and `use`.
async fn sorted_sessions(
    runtime: &Arc<AgentRuntime>,
) -> Vec<(AgentConnectionId, AgentSessionId, String, String, String)> {
    let snapshot = runtime.snapshot().await;
    let connections: HashMap<String, &agents::AgentConnectionSnapshot> = snapshot
        .connections
        .iter()
        .map(|c| (c.id.to_string(), c))
        .collect();

    let mut sessions = snapshot.sessions.clone();
    sessions.sort_by_key(|s| s.created_at);
    sessions
        .iter()
        .map(|s| {
            let conn = connections.get(&s.connection_id.to_string());
            let agent = conn
                .map(|c| format!("{:?}", c.agent_type))
                .unwrap_or_else(|| "?".to_string());
            let dir = conn
                .map(|c| dir_name(&c.working_dir).to_string())
                .unwrap_or_default();
            (s.connection_id, s.id, agent, dir, format!("{:?}", s.status))
        })
        .collect()
}

async fn list_sessions(runtime: &Arc<AgentRuntime>, prefix: &str) -> String {
    let sessions = sorted_sessions(runtime).await;
    if sessions.is_empty() {
        return "当前没有活跃会话。".to_string();
    }
    let mut out = String::from("🗂 活跃会话：\n");
    for (index, (_, session_id, agent, dir, status)) in sessions.iter().enumerate() {
        out.push_str(&format!(
            "{}. {agent} [{status}] {dir} · 会话 {}\n",
            index + 1,
            short_id(&session_id.to_string())
        ));
    }
    out.push_str(&format!(
        "\n用 {prefix} use <序号> 选择，再 {prefix} task <内容> 发送。"
    ));
    out
}

async fn select_session(
    runtime: &Arc<AgentRuntime>,
    channel_id: &str,
    sender_id: &str,
    args: &str,
    prefix: &str,
) -> String {
    let index: usize = match args.trim().parse() {
        Ok(value) if value >= 1 => value,
        _ => return format!("用法：{prefix} use <序号>（先用 {prefix} sessions 查看）"),
    };
    let sessions = sorted_sessions(runtime).await;
    let Some((connection_id, session_id, agent, dir, _)) = sessions.get(index - 1) else {
        return format!("序号超出范围，当前有 {} 个会话。", sessions.len());
    };
    session_bridge()
        .lock()
        .map(|mut bridge| {
            bridge.insert(
                (channel_id.to_string(), sender_id.to_string()),
                (connection_id.to_string(), session_id.to_string()),
            );
        })
        .ok();
    format!(
        "✅ 已选择会话 {}（{agent} · {dir}），用 {prefix} task <内容> 发送。",
        short_id(&session_id.to_string())
    )
}

/// Resolve the target session for the sender: an explicit `use` selection, or
/// the single active session, otherwise an error message asking to pick one.
async fn resolve_target(
    runtime: &Arc<AgentRuntime>,
    channel_id: &str,
    sender_id: &str,
    prefix: &str,
) -> Result<(AgentConnectionId, AgentSessionId), String> {
    let selected = session_bridge().lock().ok().and_then(|bridge| {
        bridge
            .get(&(channel_id.to_string(), sender_id.to_string()))
            .cloned()
    });
    if let Some((connection, session)) = selected
        && let (Ok(connection), Ok(session)) =
            (Uuid::parse_str(&connection), Uuid::parse_str(&session))
    {
        return Ok((
            AgentConnectionId::from(connection),
            AgentSessionId::from(session),
        ));
    }

    let sessions = sorted_sessions(runtime).await;
    match sessions.len() {
        0 => Err("当前没有活跃会话。".to_string()),
        1 => Ok((sessions[0].0, sessions[0].1)),
        _ => Err(format!(
            "有多个活跃会话，请先用 {prefix} sessions 查看并 {prefix} use <序号> 选择。"
        )),
    }
}

async fn send_task(
    runtime: &Arc<AgentRuntime>,
    channel_id: &str,
    sender_id: &str,
    args: &str,
    prefix: &str,
) -> String {
    if args.is_empty() {
        return format!("用法：{prefix} task <内容>");
    }
    let (connection_id, session_id) =
        match resolve_target(runtime, channel_id, sender_id, prefix).await {
            Ok(target) => target,
            Err(message) => return message,
        };

    match runtime
        .send_prompt(SendAgentPromptInput {
            connection_id,
            session_id,
            blocks: vec![AgentContentBlock::Text {
                text: args.to_string(),
            }],
            mode_override: None,
            config_overrides: Vec::new(),
        })
        .await
    {
        Ok(_) => format!("✅ 已发送到会话 {}", short_id(&session_id.to_string())),
        Err(error) => format!("❌ 发送失败：{error}"),
    }
}
