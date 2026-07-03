//! Outbound IM-channel notification delivery.
//!
//! Sunk out of `src-tauri/src/commands/chat_channel.rs` (架构报告 A-1): the rich-message
//! model, the per-platform HTTP senders (Telegram MarkdownV2 / Feishu interactive card /
//! WeCom markdown / OneBot text / generic webhook), the per-event debounce, and the
//! agent-event -> message mapping. The command file keeps channel CRUD + the inbound
//! WebSocket loops and calls into here for outbound delivery.

use std::{
    collections::HashMap,
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
pub fn build_rich(event: &AgentEvent, include_prompt_text: bool) -> RichMessage {
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
    kind: &str,
    config: &Value,
    token: Option<&str>,
    msg: &RichMessage,
) -> Result<Option<u16>, NotificationError> {
    match kind {
        "telegram" => telegram_send_rich(config, token, msg).await,
        "feishu" => feishu_send_rich(config, token, msg).await,
        "weixin" => weixin_send_rich(token, msg).await,
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

async fn weixin_send_rich(
    token: Option<&str>,
    msg: &RichMessage,
) -> Result<Option<u16>, NotificationError> {
    let key = token
        .filter(|t| !t.trim().is_empty())
        .ok_or_else(|| NotificationError::BadRequest("企业微信渠道缺少 Webhook Key".to_string()))?;
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
