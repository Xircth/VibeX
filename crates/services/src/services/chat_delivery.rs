//! Outbound IM-channel notification delivery.
//!
//! Sunk out of `src-tauri/src/commands/chat_channel.rs` (架构报告 A-1): the rich-message
//! model, the per-platform HTTP senders (Telegram MarkdownV2 / Feishu interactive card /
//! WeCom markdown / OneBot text / generic webhook), the per-event debounce, and the
//! agent-event -> message mapping. The command file keeps channel CRUD + the inbound
//! WebSocket loops and calls into here for outbound delivery.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Mutex as StdMutex, OnceLock},
    time::{Duration, Instant},
};

use agents::{AgentConnectionStatus, AgentEvent};
use chrono::Utc;
use serde_json::{Value, json};

/// Minimum interval between pushes of the same event type per channel.
const DEBOUNCE_SECS: u64 = 5;

/// Error type for channel delivery. Mapped back to `AppError` (variant-preserving) at
/// the command boundary.
#[derive(Debug, thiserror::Error)]
pub enum NotificationError {
    #[error("Bad request: {0}")]
    BadRequest(String),
    #[error("Internal error: {0}")]
    Internal(String),
}

fn config_str(config: &Value, key: &str) -> String {
    config
        .get(key)
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

fn require_field(config: &Value, key: &str, label: &str) -> Result<String, NotificationError> {
    let value = config_str(config, key);
    if value.is_empty() {
        Err(NotificationError::BadRequest(format!("{label}不能为空")))
    } else {
        Ok(value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MsgLevel {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone)]
pub struct RichMessage {
    title: Option<String>,
    body: String,
    fields: Vec<(String, String)>,
    pub level: MsgLevel,
}

impl RichMessage {
    pub fn info(body: impl Into<String>) -> Self {
        Self {
            title: None,
            body: body.into(),
            fields: Vec::new(),
            level: MsgLevel::Info,
        }
    }

    pub fn with_title(mut self, title: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self
    }

    pub fn with_field(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.fields.push((key.into(), value.into()));
        self
    }

    fn level(mut self, level: MsgLevel) -> Self {
        self.level = level;
        self
    }

    pub fn to_plain(&self) -> String {
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
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ImLang {
    En,
    ZhCn,
}

impl ImLang {
    pub fn parse(value: &str) -> Self {
        match value {
            "zh" | "zh-CN" | "zh-cn" | "zh_CN" => Self::ZhCn,
            _ => Self::En,
        }
    }
}

pub fn build_rich(event: &AgentEvent, include_prompt_text: bool) -> RichMessage {
    build_rich_localized(event, include_prompt_text, ImLang::En)
}

pub fn build_rich_localized(
    event: &AgentEvent,
    include_prompt_text: bool,
    lang: ImLang,
) -> RichMessage {
    let zh = lang == ImLang::ZhCn;
    match event {
        AgentEvent::PromptStarted { snapshot } => {
            let body = if include_prompt_text && !snapshot.text_preview.trim().is_empty() {
                snapshot.text_preview.clone()
            } else if zh {
                "智能体开始执行任务。".to_string()
            } else {
                "The agent started a turn.".to_string()
            };
            RichMessage::info(body).with_title(if zh {
                "🚀 任务开始"
            } else {
                "🚀 Turn started"
            })
        }
        AgentEvent::PromptFinished { finished } => RichMessage::info(if zh {
            "智能体已完成本次任务。"
        } else {
            "The agent finished this turn."
        })
        .with_title(if zh {
            "✅ 任务完成"
        } else {
            "✅ Turn complete"
        })
        .with_field("Prompt", finished.prompt_id.to_string()),
        AgentEvent::PermissionRequested { request } => RichMessage::info(if zh {
            "智能体正在等待你的授权。"
        } else {
            "The agent is waiting for approval."
        })
        .with_title(if zh {
            "🔐 权限请求"
        } else {
            "🔐 Permission request"
        })
        .with_field(if zh { "操作" } else { "Action" }, request.title.clone())
        .level(MsgLevel::Warning),
        AgentEvent::Error { error } => RichMessage::info(if zh {
            "智能体运行出现错误。"
        } else {
            "The agent reported an error."
        })
        .with_title(if zh {
            "❌ 运行错误"
        } else {
            "❌ Agent error"
        })
        .with_field(if zh { "信息" } else { "Detail" }, error.message.clone())
        .level(MsgLevel::Error),
        AgentEvent::ConnectionStatusChanged { snapshot } => {
            RichMessage::info(format!("{:?} -> {:?}", snapshot.agent_id, snapshot.status))
                .with_title(if zh {
                    "🔌 连接状态"
                } else {
                    "🔌 Connection"
                })
        }
        AgentEvent::SessionCreated { snapshot } => RichMessage::info(if zh {
            "新的会话已创建。"
        } else {
            "A new conversation was created."
        })
        .with_title(if zh {
            "🆕 会话创建"
        } else {
            "🆕 Conversation created"
        })
        .with_field("Session", snapshot.id.to_string()),
        AgentEvent::TurnCompleted { .. } => RichMessage::info(if zh {
            "智能体完成了一个回合。"
        } else {
            "The agent completed a turn."
        })
        .with_title(if zh {
            "🔄 回合完成"
        } else {
            "🔄 Turn completed"
        }),
        _ => RichMessage::info("VibeX").with_title("VibeX"),
    }
}

pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(35))
        .build()
        .unwrap_or_default()
}

/// Deliver a rich message to a typed channel; returns an optional HTTP status.
///
/// Takes the channel `kind` + `config` directly (not the shell's `ChatChannelRecord`)
/// so this service stays decoupled from the command-layer store model.
pub async fn deliver_rich(
    channel_id: &str,
    kind: &str,
    config: &Value,
    token: Option<&str>,
    msg: &RichMessage,
) -> Result<Option<u16>, NotificationError> {
    match kind {
        "telegram" => telegram_send_rich(config, token, msg).await,
        "feishu" => feishu_send_rich(config, token, msg).await,
        "weixin" => weixin_send_rich(channel_id, config, token, msg).await,
        "qq" => qq_send_text(config, token, &msg.to_plain()).await,
        _ => webhook_send_rich(config, token, msg).await,
    }
}

// ── Telegram ──

pub async fn telegram_post(
    bot_token: &str,
    chat_id: &str,
    text: &str,
    parse_mode: Option<&str>,
) -> Result<Option<u16>, NotificationError> {
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
        .map_err(|e| NotificationError::Internal(format!("Telegram 发送失败：{e}")))?;
    let status = response.status().as_u16();
    let payload: Value = response.json().await.unwrap_or_else(|_| json!({}));
    if payload.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(Some(status))
    } else {
        let detail = payload
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("Telegram 返回错误");
        Err(NotificationError::BadRequest(detail.to_string()))
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
) -> Result<Option<u16>, NotificationError> {
    let bot_token = token
        .filter(|t| !t.trim().is_empty())
        .ok_or_else(|| NotificationError::BadRequest("Telegram 渠道缺少 Bot Token".to_string()))?;
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

pub async fn telegram_create_forum_topic(
    bot_token: &str,
    chat_id: &str,
    title: &str,
) -> Result<i64, NotificationError> {
    let mut name = title.trim().to_string();
    if name.is_empty() {
        name = "VibeX".to_string();
    }
    name = name.chars().take(128).collect();
    let response = http_client()
        .post(format!(
            "https://api.telegram.org/bot{bot_token}/createForumTopic"
        ))
        .json(&json!({ "chat_id": chat_id, "name": name }))
        .send()
        .await
        .map_err(|e| NotificationError::Internal(format!("Telegram 创建主题失败：{e}")))?;
    let payload: Value = response.json().await.unwrap_or_else(|_| json!({}));
    if payload.get("ok").and_then(Value::as_bool) != Some(true) {
        let detail = payload
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("Telegram 返回错误");
        return Err(NotificationError::BadRequest(detail.to_string()));
    }
    payload
        .pointer("/result/message_thread_id")
        .and_then(Value::as_i64)
        .ok_or_else(|| NotificationError::Internal("Telegram 未返回 message_thread_id".into()))
}

// ── Feishu (Lark) app mode ──

pub async fn feishu_tenant_token(
    app_id: &str,
    app_secret: &str,
) -> Result<String, NotificationError> {
    let response = http_client()
        .post("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal")
        .json(&json!({ "app_id": app_id, "app_secret": app_secret }))
        .send()
        .await
        .map_err(|e| NotificationError::Internal(format!("飞书鉴权失败：{e}")))?;
    let payload: Value = response
        .json()
        .await
        .map_err(|e| NotificationError::Internal(format!("飞书鉴权响应解析失败：{e}")))?;
    if payload.get("code").and_then(Value::as_i64) != Some(0) {
        let msg = payload
            .get("msg")
            .and_then(Value::as_str)
            .unwrap_or("飞书鉴权失败");
        return Err(NotificationError::BadRequest(format!(
            "飞书鉴权失败：{msg}"
        )));
    }
    payload
        .get("tenant_access_token")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| NotificationError::Internal("飞书未返回 tenant_access_token".to_string()))
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
) -> Result<Option<u16>, NotificationError> {
    let app_id = require_field(config, "app_id", "飞书 App ID")?;
    let chat_id = require_field(config, "chat_id", "飞书 chat_id")?;
    let app_secret = token
        .filter(|t| !t.trim().is_empty())
        .ok_or_else(|| NotificationError::BadRequest("飞书渠道缺少 App Secret".to_string()))?;

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
        .map_err(|e| NotificationError::Internal(format!("飞书发送失败：{e}")))?;
    let status = response.status().as_u16();
    let payload: Value = response.json().await.unwrap_or_else(|_| json!({}));
    if payload.get("code").and_then(Value::as_i64) == Some(0) {
        Ok(Some(status))
    } else {
        let msg = payload
            .get("msg")
            .and_then(Value::as_str)
            .unwrap_or("飞书返回错误");
        Err(NotificationError::BadRequest(msg.to_string()))
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WeixinMode {
    Wecom,
    Ilink,
}

pub fn weixin_mode(config: &Value) -> WeixinMode {
    match config_str(config, "mode").as_str() {
        "ilink" => WeixinMode::Ilink,
        _ => WeixinMode::Wecom,
    }
}

const ILINK_CHANNEL_VERSION: &str = "1.0.2";

#[derive(Clone)]
pub struct IlinkReplyContext {
    pub to_user_id: String,
    pub context_token: String,
    pub base_url: String,
    pub bot_token: String,
    pub wechat_uin: String,
}

fn ilink_contexts() -> &'static StdMutex<HashMap<String, IlinkReplyContext>> {
    static CONTEXTS: OnceLock<StdMutex<HashMap<String, IlinkReplyContext>>> = OnceLock::new();
    CONTEXTS.get_or_init(|| StdMutex::new(HashMap::new()))
}

pub fn remember_ilink_context(channel_id: &str, context: IlinkReplyContext) {
    if let Ok(mut contexts) = ilink_contexts().lock() {
        contexts.insert(channel_id.to_string(), context);
    }
}

pub fn ilink_context(channel_id: &str) -> Option<IlinkReplyContext> {
    ilink_contexts()
        .lock()
        .ok()
        .and_then(|contexts| contexts.get(channel_id).cloned())
}

pub async fn ilink_send_text(
    context: &IlinkReplyContext,
    text: &str,
) -> Result<Option<u16>, NotificationError> {
    let body = json!({
        "msg": {
            "from_user_id": "",
            "to_user_id": context.to_user_id,
            "client_id": format!("vibex-{}", uuid::Uuid::new_v4()),
            "message_type": 2,
            "message_state": 2,
            "context_token": context.context_token,
            "item_list": [{ "type": 1, "text_item": { "text": text } }]
        },
        "base_info": { "channel_version": ILINK_CHANNEL_VERSION }
    });
    let response = http_client()
        .post(format!(
            "{}/ilink/bot/sendmessage",
            context.base_url.trim_end_matches('/')
        ))
        .header("Content-Type", "application/json")
        .header("AuthorizationType", "ilink_bot_token")
        .header("Authorization", format!("Bearer {}", context.bot_token))
        .header("X-WECHAT-UIN", &context.wechat_uin)
        .json(&body)
        .send()
        .await
        .map_err(|e| NotificationError::Internal(format!("微信 iLink 发送失败：{e}")))?;
    let status = response.status().as_u16();
    let payload: Value = response.json().await.unwrap_or_else(|_| json!({}));
    let ret = payload.get("ret").and_then(Value::as_i64).unwrap_or(0);
    let errcode = payload.get("errcode").and_then(Value::as_i64).unwrap_or(0);
    if ret == 0 && errcode == 0 {
        Ok(Some(status))
    } else {
        let detail = payload
            .get("errmsg")
            .and_then(Value::as_str)
            .unwrap_or("iLink 返回错误");
        Err(NotificationError::BadRequest(format!(
            "微信 iLink 发送失败：{detail}"
        )))
    }
}

async fn weixin_send_rich(
    channel_id: &str,
    config: &Value,
    token: Option<&str>,
    msg: &RichMessage,
) -> Result<Option<u16>, NotificationError> {
    match weixin_mode(config) {
        WeixinMode::Ilink => {
            let Some(mut context) = ilink_context(channel_id) else {
                return Err(NotificationError::BadRequest(
                    "微信 iLink 还没有可回复的会话，请先在微信里给机器人发一条消息".to_string(),
                ));
            };
            if let Some(bot_token) = token.filter(|value| !value.trim().is_empty()) {
                context.bot_token = bot_token.to_string();
            }
            if context.bot_token.trim().is_empty() {
                return Err(NotificationError::BadRequest(
                    "微信 iLink 渠道缺少 Bot Token".to_string(),
                ));
            }
            ilink_send_text(&context, &msg.to_plain()).await
        }
        WeixinMode::Wecom => {
            let key = token.filter(|t| !t.trim().is_empty()).ok_or_else(|| {
                NotificationError::BadRequest("企业微信渠道缺少 Webhook Key".to_string())
            })?;
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
                .map_err(|e| NotificationError::Internal(format!("企业微信发送失败：{e}")))?;
            let status = response.status().as_u16();
            let payload: Value = response.json().await.unwrap_or_else(|_| json!({}));
            if payload.get("errcode").and_then(Value::as_i64) == Some(0) {
                Ok(Some(status))
            } else {
                let msg = payload
                    .get("errmsg")
                    .and_then(Value::as_str)
                    .unwrap_or("企业微信返回错误");
                Err(NotificationError::BadRequest(msg.to_string()))
            }
        }
    }
}

// ── QQ (OneBot 11 HTTP) ──

async fn qq_send_text(
    config: &Value,
    token: Option<&str>,
    text: &str,
) -> Result<Option<u16>, NotificationError> {
    let base_url = require_field(config, "base_url", "OneBot 服务地址")?;
    let target_raw = require_field(config, "target_id", "QQ 群号/QQ 号")?;
    let target_id: i64 = target_raw
        .parse()
        .map_err(|_| NotificationError::BadRequest("QQ 群号/QQ 号必须是数字".to_string()))?;
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
        .map_err(|e| NotificationError::Internal(format!("QQ 发送失败：{e}")))?;
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
        Err(NotificationError::BadRequest(msg.to_string()))
    }
}

// ── Generic webhook ──

async fn webhook_send_rich(
    config: &Value,
    token: Option<&str>,
    msg: &RichMessage,
) -> Result<Option<u16>, NotificationError> {
    let url = require_field(config, "webhook_url", "Webhook URL")?;
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
        .map_err(|e| NotificationError::Internal(format!("Webhook 发送失败：{e}")))?;
    let status = response.status();
    if status.is_success() {
        Ok(Some(status.as_u16()))
    } else {
        let detail = response.text().await.unwrap_or_default();
        Err(NotificationError::BadRequest(if detail.is_empty() {
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

pub fn should_send(channel_id: &str, event: &str, level: MsgLevel) -> bool {
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

pub fn event_key(event: &AgentEvent) -> Option<&'static str> {
    match event {
        AgentEvent::SessionCreated { .. } => Some("session_created"),
        AgentEvent::PromptStarted { .. } => Some("prompt_started"),
        AgentEvent::PromptFinished { .. } => Some("prompt_finished"),
        AgentEvent::TurnCompleted { .. } => Some("prompt_finished"),
        AgentEvent::PermissionRequested { .. } => Some("permission_requested"),
        AgentEvent::ElicitationRequested { .. } => Some("question_requested"),
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

pub const DEFAULT_CHAT_EVENTS: &[&str] = &[
    "prompt_started",
    "prompt_finished",
    "permission_requested",
    "question_requested",
    "error",
    "connection_status_changed",
    "turn_cancelled",
    "turn_interrupted",
];

pub fn conversation_event_key(
    event: &agents::conversation::ConversationEvent,
) -> Option<&'static str> {
    use agents::conversation::ConversationEvent;
    match event {
        ConversationEvent::ConversationCreated { .. } => Some("session_created"),
        ConversationEvent::UserTurnCreated { .. } => Some("prompt_started"),
        ConversationEvent::PermissionRequested { .. } => Some("permission_requested"),
        ConversationEvent::QuestionRequested { .. } => Some("question_requested"),
        ConversationEvent::TurnCompleted { .. } => Some("prompt_finished"),
        ConversationEvent::TurnFailed { .. } => Some("error"),
        ConversationEvent::TurnCancelled { .. } => Some("turn_cancelled"),
        ConversationEvent::TurnInterrupted { .. } => Some("turn_interrupted"),
        ConversationEvent::AgentConnectionStatusChanged { .. } => Some("connection_status_changed"),
        _ => None,
    }
}

fn user_turn_text(blocks: &[agents::conversation::ConversationInputBlock]) -> String {
    blocks
        .iter()
        .filter_map(|block| match block {
            agents::conversation::ConversationInputBlock::Text { text } => {
                let trimmed = text.trim();
                (!trimmed.is_empty()).then_some(trimmed.to_string())
            }
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn build_conversation_rich(
    event: &agents::conversation::ConversationEvent,
    include_prompt_text: bool,
    lang: ImLang,
) -> RichMessage {
    use agents::conversation::ConversationEvent;
    let zh = lang == ImLang::ZhCn;
    match event {
        ConversationEvent::ConversationCreated { title } => {
            let body = title
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .unwrap_or_else(|| {
                    if zh {
                        "新的会话已创建。".into()
                    } else {
                        "A new conversation was created.".into()
                    }
                });
            RichMessage::info(body).with_title(if zh {
                "🆕 会话创建"
            } else {
                "🆕 Conversation created"
            })
        }
        ConversationEvent::UserTurnCreated { blocks, .. } => {
            let extracted = user_turn_text(blocks);
            let body = if include_prompt_text && !extracted.is_empty() {
                extracted
            } else if zh {
                "智能体开始执行任务。".to_string()
            } else {
                "The agent started a turn.".to_string()
            };
            RichMessage::info(body).with_title(if zh {
                "🚀 任务开始"
            } else {
                "🚀 Turn started"
            })
        }
        ConversationEvent::PermissionRequested { request } => RichMessage::info(if zh {
            "智能体正在等待你的授权。回复 approve（或 approve always）批准、deny 拒绝。"
        } else {
            "The agent is waiting for approval. Reply approve, approve always, or deny."
        })
        .with_title(if zh {
            "🔐 权限请求"
        } else {
            "🔐 Permission request"
        })
        .with_field(
            if zh { "操作" } else { "Action" },
            request.request.title.clone(),
        )
        .level(MsgLevel::Warning),
        ConversationEvent::QuestionRequested { request } => {
            let mut message = RichMessage::info(if zh {
                "智能体向你提问。回复 answer <序号或文本>。"
            } else {
                "The agent asked a question. Reply answer <n or text>."
            })
            .with_title(if zh {
                "❓ 智能体提问"
            } else {
                "❓ Agent question"
            })
            .with_field(if zh { "问题" } else { "Question" }, request.prompt.clone())
            .level(MsgLevel::Warning);
            for (index, option) in request.options.iter().enumerate() {
                message = message.with_field(format!("{}", index + 1), option.clone());
            }
            message
        }
        ConversationEvent::TurnCompleted { .. } => RichMessage::info(if zh {
            "智能体已完成本次任务。"
        } else {
            "The agent finished this turn."
        })
        .with_title(if zh {
            "✅ 任务完成"
        } else {
            "✅ Turn complete"
        }),
        ConversationEvent::TurnFailed { error } => RichMessage::info(if zh {
            "智能体运行出现错误。"
        } else {
            "The agent reported an error."
        })
        .with_title(if zh {
            "❌ 运行错误"
        } else {
            "❌ Agent error"
        })
        .with_field(if zh { "信息" } else { "Detail" }, error.message.clone())
        .level(MsgLevel::Error),
        ConversationEvent::TurnCancelled { reason } => {
            let body = reason
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .unwrap_or_else(|| {
                    if zh {
                        "当前回合已取消。".into()
                    } else {
                        "The in-flight turn was cancelled.".into()
                    }
                });
            RichMessage::info(body)
                .with_title(if zh {
                    "🛑 回合取消"
                } else {
                    "🛑 Turn cancelled"
                })
                .level(MsgLevel::Warning)
        }
        ConversationEvent::TurnInterrupted { reason } => {
            let body = reason
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .unwrap_or_else(|| {
                    if zh {
                        "宿主中断了当前回合，需要手动重试。".into()
                    } else {
                        "The host interrupted this turn. Retry it manually.".into()
                    }
                });
            RichMessage::info(body)
                .with_title(if zh {
                    "⚠️ 回合中断"
                } else {
                    "⚠️ Turn interrupted"
                })
                .level(MsgLevel::Warning)
        }
        ConversationEvent::AgentConnectionStatusChanged { status } => {
            RichMessage::info(format!("{status:?}")).with_title(if zh {
                "🔌 连接状态"
            } else {
                "🔌 Connection"
            })
        }
        _ => RichMessage::info("VibeX").with_title("VibeX"),
    }
}

pub async fn post_event_webhooks(hooks: &[(String, bool)], event: &str, body: &str) {
    for (url, enabled) in hooks {
        if !enabled || url.trim().is_empty() {
            continue;
        }
        let payload = json!({
            "event": event,
            "body": body,
            "source": "vibex",
        });
        let _ = http_client().post(url).json(&payload).send().await;
    }
}

// ---------------------------------------------------------------------------
// IM channel secret store — plaintext `{host_data_dir}/.env` (ADR-0004)
// ---------------------------------------------------------------------------
//
// A deliberate, user-decided deviation from "desktop apps put secrets in the OS
// keychain": IM channel tokens live plaintext next to the Host database
// (perms 0600), traded for zero dependencies + directly editable/backup-able
// simplicity. Scope is strictly IM channel secrets — model-provider API keys /
// MCP env keep their existing homes.

/// Absolute path to the plaintext IM secret file next to the Host database.
pub fn im_env_path() -> Option<PathBuf> {
    Some(utils::assets::im_env_path())
}

/// Env var name holding a channel's token. Channel ids (uuid-ish) are normalized to an
/// env-safe key; the same channel id always maps to the same key, so lookups are stable.
fn token_key(channel_id: &str) -> String {
    let sanitized: String = channel_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect();
    format!("CHAT_CHANNEL_TOKEN_{sanitized}")
}

async fn read_env_lines(path: &PathBuf) -> Vec<String> {
    match tokio::fs::read_to_string(path).await {
        Ok(content) => content.lines().map(str::to_string).collect(),
        Err(_) => Vec::new(),
    }
}

async fn write_env_lines(path: &PathBuf, lines: &[String]) -> Result<(), NotificationError> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|error| {
            NotificationError::Internal(format!("Failed to create {}: {error}", parent.display()))
        })?;
    }
    let mut body = lines.join("\n");
    if !body.is_empty() {
        body.push('\n');
    }
    tokio::fs::write(path, body).await.map_err(|error| {
        NotificationError::Internal(format!("Failed to write {}: {error}", path.display()))
    })?;
    // Best-effort 0600 (owner read/write only); the file holds plaintext secrets.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await;
    }
    Ok(())
}

fn line_value_for(lines: &[String], key: &str) -> Option<String> {
    let prefix = format!("{key}=");
    lines
        .iter()
        .find(|line| line.starts_with(&prefix))
        .map(|line| line[prefix.len()..].to_string())
}

/// The token stored for `channel_id`, or `None`.
pub async fn load_channel_token(channel_id: &str) -> Option<String> {
    let path = im_env_path()?;
    let lines = read_env_lines(&path).await;
    line_value_for(&lines, &token_key(channel_id)).filter(|value| !value.is_empty())
}

/// Whether a (non-empty) token is stored for `channel_id`.
pub async fn channel_has_token(channel_id: &str) -> bool {
    load_channel_token(channel_id).await.is_some()
}

/// Read the file once and return `id -> token` for every id in `channel_ids` that has a
/// non-empty token. For the hydrate / notify loops that need many channels' tokens.
pub async fn load_channel_tokens(channel_ids: &[String]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Some(path) = im_env_path() else {
        return out;
    };
    let lines = read_env_lines(&path).await;
    for id in channel_ids {
        if let Some(value) = line_value_for(&lines, &token_key(id))
            && !value.is_empty()
        {
            out.insert(id.clone(), value);
        }
    }
    out
}

/// One-time migration of legacy plaintext-JSON channel tokens into `~/.vibex/.env`
/// (ADR-0004). Writes each `(channel_id, token)` and reports success so the caller can
/// delete the old file. Idempotent: re-running just re-upserts the same values.
pub async fn import_legacy_channel_tokens(
    tokens: &HashMap<String, String>,
) -> Result<(), NotificationError> {
    for (channel_id, token) in tokens {
        if !token.trim().is_empty() {
            save_channel_token(channel_id, token).await?;
        }
    }
    Ok(())
}

/// Upsert a channel's token, preserving every other line in the file.
pub async fn save_channel_token(channel_id: &str, token: &str) -> Result<(), NotificationError> {
    let path =
        im_env_path().ok_or_else(|| NotificationError::Internal("no home directory".into()))?;
    let key = token_key(channel_id);
    let entry = format!("{key}={token}");
    let mut lines = read_env_lines(&path).await;
    let prefix = format!("{key}=");
    if let Some(existing) = lines.iter_mut().find(|line| line.starts_with(&prefix)) {
        *existing = entry;
    } else {
        lines.push(entry);
    }
    write_env_lines(&path, &lines).await
}

/// Remove a channel's token line (no-op if absent).
pub async fn delete_channel_token(channel_id: &str) -> Result<(), NotificationError> {
    let Some(path) = im_env_path() else {
        return Ok(());
    };
    let prefix = format!("{}=", token_key(channel_id));
    let mut lines = read_env_lines(&path).await;
    let before = lines.len();
    lines.retain(|line| !line.starts_with(&prefix));
    if lines.len() != before {
        write_env_lines(&path, &lines).await?;
    }
    Ok(())
}

#[cfg(test)]
mod im_secret_tests {
    use super::*;

    #[test]
    fn token_key_is_env_safe_and_stable() {
        let key = token_key("abc-123-DEF");
        assert_eq!(key, "CHAT_CHANNEL_TOKEN_ABC_123_DEF");
        assert_eq!(token_key("abc-123-DEF"), key, "same id → same key");
    }

    #[test]
    fn conversation_event_keys_match_the_settings_filter() {
        use agents::conversation::{
            ConversationEvent, ConversationInputBlock, ConversationQuestionRequest,
        };

        assert_eq!(
            conversation_event_key(&ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text { text: "hi".into() }],
                workflow_refs: Vec::new(),
            }),
            Some("prompt_started")
        );
        assert_eq!(
            conversation_event_key(&ConversationEvent::TurnCompleted { stop_reason: None }),
            Some("prompt_finished")
        );
        assert_eq!(
            conversation_event_key(&ConversationEvent::TurnCancelled { reason: None }),
            Some("turn_cancelled")
        );
        assert_eq!(
            conversation_event_key(&ConversationEvent::TurnInterrupted { reason: None }),
            Some("turn_interrupted")
        );
        assert_eq!(
            conversation_event_key(&ConversationEvent::QuestionRequested {
                request: ConversationQuestionRequest {
                    question_id: "q1".into(),
                    prompt: "pick".into(),
                    options: vec!["a".into()],
                    asked_at: None,
                    schema: None,
                },
            }),
            Some("question_requested")
        );
    }

    #[test]
    fn weixin_mode_defaults_to_wecom() {
        assert_eq!(weixin_mode(&json!({})), WeixinMode::Wecom);
        assert_eq!(weixin_mode(&json!({ "mode": "ilink" })), WeixinMode::Ilink);
    }

    #[test]
    fn upsert_and_read_preserve_other_lines() {
        // Pure line-level logic (no filesystem): an upsert replaces only its own key.
        let mut lines = vec![
            "# comment".to_string(),
            "OTHER=keepme".to_string(),
            "CHAT_CHANNEL_TOKEN_C1=old".to_string(),
        ];
        let key = "CHAT_CHANNEL_TOKEN_C1";
        let prefix = format!("{key}=");
        if let Some(existing) = lines.iter_mut().find(|l| l.starts_with(&prefix)) {
            *existing = format!("{key}=new");
        }
        assert_eq!(line_value_for(&lines, key).as_deref(), Some("new"));
        assert_eq!(line_value_for(&lines, "OTHER").as_deref(), Some("keepme"));
        assert!(lines.contains(&"# comment".to_string()));
    }
}
