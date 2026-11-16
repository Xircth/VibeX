//! Host-owned IM inbound loops. Desktop and `vibex-server` start the same runtime.

use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Mutex as StdMutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use conversations::ConversationContext;
use futures::{SinkExt, StreamExt};
use prost::Message as ProstMessage;
use serde_json::{Value, json};
use services::services::chat_delivery::{feishu_tenant_token, http_client, load_channel_tokens};
use sqlx::SqlitePool;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite;
use uuid::Uuid;

#[path = "chat_inbound_commands.rs"]
mod commands;
pub(crate) use commands::dispatch_command;
use commands::{
    dispatch_command_reply, handle_telegram_callback, telegram_send_reply, today_conversations,
};

const RECONCILE_SECS: u64 = 5;
const SETTINGS_SECTION: &str = "chat_channels";

#[derive(Clone, Debug, Default, serde::Deserialize)]
struct ChatChannelRecord {
    id: String,
    kind: String,
    enabled: bool,
    #[serde(default)]
    config: Value,
    #[serde(default)]
    webhook_url: String,
}

#[derive(Clone, Debug, Default, serde::Deserialize)]
struct ChatChannelStore {
    #[serde(default)]
    channels: Vec<ChatChannelRecord>,
    #[serde(default)]
    command_prefix: String,
    #[serde(default)]
    event_webhooks: Vec<EventWebhook>,
    #[serde(default)]
    message_language: String,
}

#[derive(Clone, Debug, Default, serde::Deserialize)]
struct EventWebhook {
    url: String,
    #[serde(default)]
    enabled: bool,
}

#[derive(Clone)]
struct InboundTarget {
    channel_id: String,
    kind: String,
    signature: String,
    token: String,
    config: Value,
}

#[derive(Clone, PartialEq, prost::Message)]
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

#[derive(Clone, PartialEq, prost::Message)]
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
            .find(|header| header.key == key)
            .map(|header| header.value.as_str())
    }

    fn set_header(&mut self, key: &str, value: &str) {
        if let Some(header) = self.headers.iter_mut().find(|header| header.key == key) {
            header.value = value.to_string();
        } else {
            self.headers.push(LarkFrameHeader {
                key: key.to_string(),
                value: value.to_string(),
            });
        }
    }
}

type SessionBridgeKey = (String, String);
type SessionBridgeMap = HashMap<SessionBridgeKey, String>;

fn session_bridge() -> &'static StdMutex<SessionBridgeMap> {
    static BRIDGE: OnceLock<StdMutex<SessionBridgeMap>> = OnceLock::new();
    BRIDGE.get_or_init(|| StdMutex::new(HashMap::new()))
}

fn folder_bridge() -> &'static StdMutex<HashMap<SessionBridgeKey, Uuid>> {
    static BRIDGE: OnceLock<StdMutex<HashMap<SessionBridgeKey, Uuid>>> = OnceLock::new();
    BRIDGE.get_or_init(|| StdMutex::new(HashMap::new()))
}

fn agent_bridge() -> &'static StdMutex<HashMap<SessionBridgeKey, String>> {
    static BRIDGE: OnceLock<StdMutex<HashMap<SessionBridgeKey, String>>> = OnceLock::new();
    BRIDGE.get_or_init(|| StdMutex::new(HashMap::new()))
}

fn selected_conversation(channel_id: &str, sender_id: &str) -> Option<Uuid> {
    session_bridge()
        .lock()
        .ok()
        .and_then(|bridge| {
            bridge
                .get(&(channel_id.to_string(), sender_id.to_string()))
                .cloned()
        })
        .and_then(|id| Uuid::parse_str(&id).ok())
}

fn connection_states() -> &'static StdMutex<HashMap<String, String>> {
    static STATES: OnceLock<StdMutex<HashMap<String, String>>> = OnceLock::new();
    STATES.get_or_init(|| StdMutex::new(HashMap::new()))
}

fn paused_channels() -> &'static StdMutex<HashSet<String>> {
    static PAUSED: OnceLock<StdMutex<HashSet<String>>> = OnceLock::new();
    PAUSED.get_or_init(|| StdMutex::new(HashSet::new()))
}

fn reconcile_notify() -> &'static tokio::sync::Notify {
    static NOTIFY: OnceLock<tokio::sync::Notify> = OnceLock::new();
    NOTIFY.get_or_init(tokio::sync::Notify::new)
}

pub(crate) fn set_connection_state(channel_id: &str, state: &str) {
    if let Ok(mut states) = connection_states().lock() {
        states.insert(channel_id.to_string(), state.to_string());
    }
}

pub fn chat_channel_connection_states() -> HashMap<String, String> {
    connection_states()
        .lock()
        .map(|states| states.clone())
        .unwrap_or_default()
}

pub fn connect_chat_channel(channel_id: &str) {
    if let Ok(mut paused) = paused_channels().lock() {
        paused.remove(channel_id);
    }
    set_connection_state(channel_id, "connecting");
    reconcile_notify().notify_waiters();
}

pub fn disconnect_chat_channel(channel_id: &str) {
    if let Ok(mut paused) = paused_channels().lock() {
        paused.insert(channel_id.to_string());
    }
    set_connection_state(channel_id, "disconnected");
    reconcile_notify().notify_waiters();
}

fn is_paused(channel_id: &str) -> bool {
    paused_channels()
        .lock()
        .ok()
        .map(|paused| paused.contains(channel_id))
        .unwrap_or(false)
}

/// Start Telegram / Feishu / QQ inbound loops against the current Host.
pub fn start_chat_inbound(pool: SqlitePool, conversations: ConversationContext) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut running: HashMap<String, (String, Arc<AtomicBool>)> = HashMap::new();
        let mut last_daily_report = String::new();
        loop {
            if let Ok(targets) = inbound_targets().await {
                let desired = targets
                    .iter()
                    .map(|target| target.channel_id.clone())
                    .collect::<HashSet<_>>();
                running.retain(|id, (_, flag)| {
                    if desired.contains(id) {
                        true
                    } else {
                        flag.store(true, Ordering::Relaxed);
                        false
                    }
                });
                for target in targets {
                    let restart = running
                        .get(&target.channel_id)
                        .is_none_or(|(signature, _)| signature != &target.signature);
                    if restart {
                        if let Some((_, flag)) = running.remove(&target.channel_id) {
                            flag.store(true, Ordering::Relaxed);
                        }
                        let flag = Arc::new(AtomicBool::new(false));
                        spawn_receiver(pool.clone(), conversations.clone(), &target, flag.clone());
                        running.insert(target.channel_id, (target.signature, flag));
                    }
                }
            }
            if let Ok(store) = load_store().await {
                let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M").to_string();
                if stamp != last_daily_report {
                    for channel in store.channels.iter().filter(|channel| channel.enabled) {
                        let enabled = channel
                            .config
                            .get("daily_report_enabled")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        let time = config_str(&channel.config, "daily_report_time");
                        if enabled && !time.is_empty() && stamp.ends_with(&time) {
                            let summary = today_conversations(&pool).await;
                            let tokens =
                                load_channel_tokens(std::slice::from_ref(&channel.id)).await;
                            let token = tokens.get(&channel.id);
                            let _ = services::services::chat_delivery::deliver_rich(
                                &channel.id,
                                &channel.kind,
                                &channel.config,
                                token.map(String::as_str),
                                &services::services::chat_delivery::RichMessage::info(summary)
                                    .with_title("VibeX daily summary"),
                            )
                            .await;
                            last_daily_report = stamp.clone();
                        }
                    }
                }
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(RECONCILE_SECS)) => {}
                _ = reconcile_notify().notified() => {}
            }
        }
    })
}

async fn inbound_targets() -> Result<Vec<InboundTarget>, String> {
    let store = load_store().await?;
    let ids = store
        .channels
        .iter()
        .map(|channel| channel.id.clone())
        .collect::<Vec<_>>();
    let tokens = load_channel_tokens(&ids).await;
    let mut targets = Vec::new();
    for channel in store.channels.into_iter().filter(|channel| channel.enabled) {
        if is_paused(&channel.id) {
            continue;
        }
        let token = tokens
            .get(&channel.id)
            .cloned()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| config_token(&channel.config));
        match channel.kind.as_str() {
            "telegram" if !token.is_empty() => targets.push(InboundTarget {
                channel_id: channel.id,
                kind: "telegram".into(),
                signature: format!("tg:{token}"),
                token,
                config: channel.config,
            }),
            "feishu" if !token.is_empty() => targets.push(InboundTarget {
                channel_id: channel.id,
                kind: "feishu".into(),
                signature: format!("fs:{}:{token}", config_str(&channel.config, "app_id")),
                token,
                config: channel.config,
            }),
            "weixin"
                if !token.is_empty()
                    && (config_str(&channel.config, "mode") == "ilink"
                        || !config_str(&channel.config, "base_url").is_empty()) =>
            {
                targets.push(InboundTarget {
                    channel_id: channel.id,
                    kind: "weixin".into(),
                    signature: format!("wx:{}:{token}", config_str(&channel.config, "base_url")),
                    token,
                    config: channel.config,
                });
            }
            "qq" => {
                let ws_url = qq_ws_url(&channel.config);
                if !ws_url.is_empty() {
                    targets.push(InboundTarget {
                        channel_id: channel.id,
                        kind: "qq".into(),
                        signature: format!(
                            "qq:{ws_url}:{token}:{}",
                            config_str(&channel.config, "base_url")
                        ),
                        token,
                        config: channel.config,
                    });
                }
            }
            _ => {
                let _ = channel.webhook_url;
            }
        }
    }
    Ok(targets)
}

fn config_token(config: &Value) -> String {
    config
        .get("bot_token")
        .or_else(|| config.get("app_secret"))
        .or_else(|| config.get("access_token"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

fn config_str(config: &Value, key: &str) -> String {
    config
        .get(key)
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .unwrap_or_default()
}

fn value_to_id(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => {
            let trimmed = value.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn authorized_identities(kind: &str, config: &Value) -> HashSet<String> {
    let mut identities = HashSet::new();
    if let Some(list) = config.get("authorized_senders").and_then(Value::as_array) {
        for item in list {
            if let Some(id) = value_to_id(item) {
                identities.insert(id);
            }
        }
    }
    let destination_key = if kind == "qq" { "target_id" } else { "chat_id" };
    if let Some(id) = config.get(destination_key).and_then(value_to_id) {
        identities.insert(id);
    }
    identities
}

fn is_sender_authorized(kind: &str, config: &Value, sender_id: &str, chat_id: &str) -> bool {
    let identities = authorized_identities(kind, config);
    if identities.is_empty() {
        // iLink trust is the QR-bound bot token; an empty list would make a
        // just-scanned bot unable to receive its first command.
        return kind == "weixin" && config_str(config, "mode") == "ilink";
    }
    identities.contains(sender_id) || identities.contains(chat_id)
}

pub async fn post_event_webhooks(event: &str, body: &str) {
    let Ok(store) = load_store().await else {
        return;
    };
    for hook in store
        .event_webhooks
        .into_iter()
        .filter(|hook| hook.enabled && !hook.url.trim().is_empty())
    {
        let payload = json!({
            "event": event,
            "body": body,
            "source": "vibex",
        });
        let _ = http_client().post(hook.url).json(&payload).send().await;
    }
}

async fn load_store() -> Result<ChatChannelStore, String> {
    let path = utils::assets::settings_path();
    match services::services::settings_store::read_section(&path, SETTINGS_SECTION)
        .await
        .map_err(|error| error.to_string())?
    {
        Some(store) => Ok(store),
        None => Ok(ChatChannelStore::default()),
    }
}

fn spawn_receiver(
    pool: SqlitePool,
    conversations: ConversationContext,
    target: &InboundTarget,
    shutdown: Arc<AtomicBool>,
) {
    match target.kind.as_str() {
        "telegram" => spawn_telegram_loop(
            pool,
            conversations,
            target.channel_id.clone(),
            target.token.clone(),
            target.config.clone(),
            shutdown,
        ),
        "qq" => spawn_qq_loop(
            pool,
            conversations,
            target.channel_id.clone(),
            target.config.clone(),
            target.token.clone(),
            shutdown,
        ),
        "weixin" => crate::weixin_ilink::spawn_weixin_ilink_loop(
            pool,
            conversations,
            target.channel_id.clone(),
            target.token.clone(),
            config_str(&target.config, "base_url"),
            target.config.clone(),
            shutdown,
        ),
        "feishu" => spawn_feishu_loop(
            pool,
            conversations,
            target.channel_id.clone(),
            target.config.clone(),
            target.token.clone(),
            shutdown,
        ),
        _ => {}
    }
}

fn spawn_telegram_loop(
    pool: SqlitePool,
    conversations: ConversationContext,
    channel_id: String,
    bot_token: String,
    config: Value,
    shutdown: Arc<AtomicBool>,
) {
    tokio::spawn(async move {
        let client = http_client();
        let mut offset: i64 = 0;
        set_connection_state(&channel_id, "connecting");
        while !shutdown.load(Ordering::Relaxed) {
            let url = format!(
                "https://api.telegram.org/bot{bot_token}/getUpdates?timeout=25&offset={offset}"
            );
            let body = match client.get(&url).send().await {
                Ok(response) => {
                    let payload = response.json::<Value>().await.unwrap_or(Value::Null);
                    if payload.get("ok").and_then(Value::as_bool) == Some(true) {
                        set_connection_state(&channel_id, "connected");
                    } else {
                        set_connection_state(&channel_id, "error");
                    }
                    payload
                }
                Err(_) => {
                    set_connection_state(&channel_id, "error");
                    tokio::time::sleep(Duration::from_secs(3)).await;
                    continue;
                }
            };
            let Some(updates) = body.get("result").and_then(Value::as_array) else {
                continue;
            };
            for update in updates {
                if let Some(update_id) = update.get("update_id").and_then(Value::as_i64) {
                    offset = update_id + 1;
                }
                if let Some(callback) = update.get("callback_query") {
                    handle_telegram_callback(
                        &pool,
                        &conversations,
                        &client,
                        &bot_token,
                        &channel_id,
                        &config,
                        callback,
                    )
                    .await;
                    continue;
                }
                let Some(text) = update.pointer("/message/text").and_then(Value::as_str) else {
                    continue;
                };
                let Some(chat_id) = update.pointer("/message/chat/id").and_then(value_to_id) else {
                    continue;
                };
                let sender_id = update
                    .pointer("/message/from/id")
                    .and_then(value_to_id)
                    .unwrap_or_default();
                let thread_id = update
                    .pointer("/message/message_thread_id")
                    .and_then(value_to_id);
                let topic_mode = config
                    .get("topic_mode")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if topic_mode && thread_id.is_none() && !text.trim().starts_with('/') {
                    continue;
                }
                let scoped_sender = match thread_id.as_deref() {
                    Some(thread) if topic_mode => format!("{sender_id}:topic:{thread}"),
                    _ => sender_id,
                };
                let reply = dispatch_command_reply(
                    &pool,
                    &conversations,
                    text.trim(),
                    &scoped_sender,
                    &chat_id,
                    &channel_id,
                    "telegram",
                    &config,
                )
                .await;
                if reply.is_empty() {
                    continue;
                }
                telegram_send_reply(&client, &bot_token, &chat_id, thread_id.as_deref(), &reply)
                    .await;
            }
        }
        set_connection_state(&channel_id, "disconnected");
    });
}

fn qq_ws_url(config: &Value) -> String {
    let explicit = config_str(config, "ws_url");
    if !explicit.is_empty() {
        return explicit;
    }
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
    pool: SqlitePool,
    conversations: ConversationContext,
    channel_id: String,
    config: Value,
    token: String,
    shutdown: Arc<AtomicBool>,
) {
    tokio::spawn(async move {
        let ws_base = qq_ws_url(&config);
        let base_url = config_str(&config, "base_url");
        set_connection_state(&channel_id, "connecting");
        while !shutdown.load(Ordering::Relaxed) {
            let url = if token.trim().is_empty() {
                ws_base.clone()
            } else {
                let sep = if ws_base.contains('?') { '&' } else { '?' };
                format!("{ws_base}{sep}access_token={token}")
            };
            match tokio_tungstenite::connect_async(&url).await {
                Ok((stream, _)) => {
                    set_connection_state(&channel_id, "connected");
                    let (mut write, mut read) = stream.split();
                    while !shutdown.load(Ordering::Relaxed) {
                        match read.next().await {
                            Some(Ok(tungstenite::Message::Text(text))) => {
                                if let Ok(event) = serde_json::from_str::<Value>(text.as_str()) {
                                    handle_qq_event(
                                        &pool,
                                        &conversations,
                                        &channel_id,
                                        &config,
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
                    tracing::warn!(channel_id = %channel_id, %error, "QQ ws connect failed");
                    set_connection_state(&channel_id, "error");
                }
            }
            if shutdown.load(Ordering::Relaxed) {
                break;
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
        set_connection_state(&channel_id, "disconnected");
    });
}

async fn handle_qq_event(
    pool: &SqlitePool,
    conversations: &ConversationContext,
    channel_id: &str,
    config: &Value,
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
    let Some(source_id) = (if is_group {
        event.get("group_id").and_then(value_to_id)
    } else {
        event.get("user_id").and_then(value_to_id)
    }) else {
        return;
    };
    let sender_id = event
        .pointer("/sender/user_id")
        .and_then(value_to_id)
        .unwrap_or_default();
    let reply = dispatch_command(
        pool,
        conversations,
        &text,
        &sender_id,
        &source_id,
        channel_id,
        "qq",
        config,
    )
    .await;
    if reply.is_empty() {
        return;
    }
    let endpoint = if is_group {
        "send_group_msg"
    } else {
        "send_private_msg"
    };
    let url = format!("{}/{endpoint}", base_url.trim_end_matches('/'));
    let payload = if is_group {
        json!({ "group_id": source_id.parse::<i64>().ok(), "message": reply })
    } else {
        json!({ "user_id": source_id.parse::<i64>().ok(), "message": reply })
    };
    let mut request = http_client().post(url).json(&payload);
    if !token.trim().is_empty() {
        request = request.bearer_auth(token);
    }
    let _ = request.send().await;
}

async fn feishu_ws_url(app_id: &str, app_secret: &str) -> Result<String, String> {
    let response = http_client()
        .post("https://open.feishu.cn/callback/ws/endpoint")
        .json(&json!({ "AppID": app_id, "AppSecret": app_secret }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let payload: Value = response.json().await.map_err(|error| error.to_string())?;
    if payload.get("code").and_then(Value::as_i64) != Some(0) {
        return Err(payload
            .get("msg")
            .and_then(Value::as_str)
            .unwrap_or("feishu ws endpoint error")
            .to_string());
    }
    payload
        .pointer("/data/URL")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| "feishu ws URL missing".to_string())
}

fn spawn_feishu_loop(
    pool: SqlitePool,
    conversations: ConversationContext,
    channel_id: String,
    config: Value,
    app_secret: String,
    shutdown: Arc<AtomicBool>,
) {
    tokio::spawn(async move {
        let app_id = config_str(&config, "app_id");
        set_connection_state(&channel_id, "connecting");
        while !shutdown.load(Ordering::Relaxed) {
            let ws_url = match feishu_ws_url(&app_id, &app_secret).await {
                Ok(url) => url,
                Err(error) => {
                    tracing::warn!(channel_id = %channel_id, %error, "Feishu ws endpoint failed");
                    set_connection_state(&channel_id, "error");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                }
            };
            match tokio_tungstenite::connect_async(&ws_url).await {
                Ok((stream, _)) => {
                    set_connection_state(&channel_id, "connected");
                    let (mut write, mut read) = stream.split();
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
                                    let sum = frame
                                        .header("sum")
                                        .and_then(|value| value.parse().ok())
                                        .unwrap_or(1);
                                    let seq = frame
                                        .header("seq")
                                        .and_then(|value| value.parse().ok())
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
                                            for index in 0..entry.0 {
                                                if let Some(part) = entry.1.get(&index) {
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
                                                &pool,
                                                &conversations,
                                                &channel_id,
                                                &config,
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
                    tracing::warn!(channel_id = %channel_id, %error, "Feishu ws connect failed");
                    set_connection_state(&channel_id, "error");
                }
            }
            if shutdown.load(Ordering::Relaxed) {
                break;
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
        set_connection_state(&channel_id, "disconnected");
    });
}

async fn handle_feishu_event(
    pool: &SqlitePool,
    conversations: &ConversationContext,
    channel_id: &str,
    config: &Value,
    app_id: &str,
    app_secret: &str,
    event: &Value,
) {
    if event.pointer("/header/event_type").and_then(Value::as_str) != Some("im.message.receive_v1")
    {
        return;
    }
    crate::pulse_connectors::spawn_feishu_inbound_pulse_bridge(
        pool.clone(),
        channel_id.to_string(),
        config.clone(),
        event.clone(),
    );
    if event
        .pointer("/event/message/message_type")
        .and_then(Value::as_str)
        != Some("text")
    {
        return;
    }
    let chat_type = event
        .pointer("/event/message/chat_type")
        .and_then(Value::as_str)
        .unwrap_or("p2p");
    let content = event
        .pointer("/event/message/content")
        .and_then(Value::as_str)
        .unwrap_or("");
    let mut text = serde_json::from_str::<Value>(content)
        .ok()
        .and_then(|value| {
            value
                .get("text")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .unwrap_or_default();
    if chat_type == "group" {
        let Some(mentions) = event
            .pointer("/event/message/mentions")
            .and_then(Value::as_array)
            .filter(|mentions| !mentions.is_empty())
        else {
            return;
        };
        let configured_bot_open_id = config
            .get("bot_open_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty());
        let addressed_bot = if let Some(bot_open_id) = configured_bot_open_id {
            mentions.iter().any(|mention| {
                mention
                    .pointer("/id/open_id")
                    .or_else(|| mention.get("open_id"))
                    .and_then(Value::as_str)
                    == Some(bot_open_id)
            })
        } else {
            let store = load_store().await.unwrap_or_default();
            let prefix = if store.command_prefix.trim().is_empty() {
                "/".to_string()
            } else {
                store.command_prefix
            };
            let trimmed_raw = text.trim_start();
            mentions.iter().any(|mention| {
                mention
                    .get("key")
                    .and_then(Value::as_str)
                    .is_some_and(|key| trimmed_raw.starts_with(key))
            }) || trimmed_raw.contains(&prefix)
        };
        if !addressed_bot {
            return;
        }
    }
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
    let reply = dispatch_command(
        pool,
        conversations,
        &text,
        &sender_id,
        chat_id,
        channel_id,
        "feishu",
        config,
    )
    .await;
    if reply.is_empty() {
        return;
    }
    if let Ok(tenant) = feishu_tenant_token(app_id, app_secret).await {
        let content = json!({ "text": reply }).to_string();
        let _ = http_client()
            .post("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id")
            .bearer_auth(tenant)
            .json(&json!({
                "receive_id": chat_id,
                "msg_type": "text",
                "content": content,
            }))
            .send()
            .await;
    }
}
