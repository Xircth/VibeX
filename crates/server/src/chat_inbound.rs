//! Host-owned IM inbound loops. Desktop and `vibex-server` start the same runtime.

use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Mutex as StdMutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use agents::conversation::ConversationEvent;
use conversations::{ConversationContext, ConversationEventAppender, ConversationSessionService};
use db::models::{
    conversation::{ConversationRecord, CreateConversationRecord},
    conversation_event::AppendConversationEvent,
};
use futures::{SinkExt, StreamExt};
use prost::Message as ProstMessage;
use serde_json::{Value, json};
use services::services::chat_delivery::{feishu_tenant_token, http_client, load_channel_tokens};
use sqlx::SqlitePool;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite;
use uuid::Uuid;

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
    if chat_type == "group" {
        let mentions = event
            .pointer("/event/message/mentions")
            .and_then(Value::as_array);
        if mentions.map(|mentions| mentions.is_empty()).unwrap_or(true) {
            return;
        }
    }
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

struct CommandReply {
    text: String,
    buttons: Vec<(String, String)>,
    thread_id: Option<String>,
}

impl CommandReply {
    fn text(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            buttons: Vec::new(),
            thread_id: None,
        }
    }

    fn with_buttons(mut self, buttons: Vec<(String, String)>) -> Self {
        self.buttons = buttons;
        self
    }

    fn with_thread(mut self, thread_id: impl Into<String>) -> Self {
        self.thread_id = Some(thread_id.into());
        self
    }

    fn is_empty(&self) -> bool {
        self.text.trim().is_empty() && self.buttons.is_empty()
    }
}

async fn telegram_send_reply(
    client: &reqwest::Client,
    bot_token: &str,
    chat_id: &str,
    thread_id: Option<&str>,
    reply: &CommandReply,
) {
    let mut payload = json!({ "chat_id": chat_id, "text": reply.text });
    if let Some(thread) = reply.thread_id.as_deref().or(thread_id) {
        payload["message_thread_id"] = json!(thread);
    }
    if !reply.buttons.is_empty() {
        let rows: Vec<Vec<Value>> = reply
            .buttons
            .chunks(2)
            .map(|chunk| {
                chunk
                    .iter()
                    .map(|(label, data)| json!({ "text": label, "callback_data": data }))
                    .collect()
            })
            .collect();
        payload["reply_markup"] = json!({ "inline_keyboard": rows });
    }
    let _ = client
        .post(format!(
            "https://api.telegram.org/bot{bot_token}/sendMessage"
        ))
        .json(&payload)
        .send()
        .await;
}

async fn handle_telegram_callback(
    pool: &SqlitePool,
    conversations: &ConversationContext,
    client: &reqwest::Client,
    bot_token: &str,
    channel_id: &str,
    config: &Value,
    callback: &Value,
) {
    let callback_id = callback.get("id").and_then(Value::as_str).unwrap_or("");
    let data = callback.get("data").and_then(Value::as_str).unwrap_or("");
    let sender_id = callback
        .pointer("/from/id")
        .and_then(value_to_id)
        .unwrap_or_default();
    let chat_id = callback
        .pointer("/message/chat/id")
        .and_then(value_to_id)
        .unwrap_or_default();
    let thread_id = callback
        .pointer("/message/message_thread_id")
        .and_then(value_to_id);
    let _ = client
        .post(format!(
            "https://api.telegram.org/bot{bot_token}/answerCallbackQuery"
        ))
        .json(&json!({ "callback_query_id": callback_id }))
        .send()
        .await;
    let reply = dispatch_command_reply(
        pool,
        conversations,
        data,
        &sender_id,
        &chat_id,
        channel_id,
        "telegram",
        config,
    )
    .await;
    if reply.is_empty() {
        return;
    }
    telegram_send_reply(client, bot_token, &chat_id, thread_id.as_deref(), &reply).await;
}

fn help_text(prefix: &str) -> String {
    format!(
        "VibeX Host commands:\n\
         {prefix} folder [n|name]\n\
         {prefix} agent [n|id]\n\
         {prefix} task <text>\n\
         {prefix} sessions\n\
         {prefix} resume [n|id]\n\
         {prefix} cancel\n\
         {prefix} approve [always]\n\
         {prefix} deny\n\
         {prefix} answer [n|text]\n\
         {prefix} search <keyword>\n\
         {prefix} today\n\
         {prefix} status\n\
         {prefix} help"
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn dispatch_command(
    pool: &SqlitePool,
    conversations: &ConversationContext,
    text: &str,
    sender_id: &str,
    chat_id: &str,
    channel_id: &str,
    kind: &str,
    config: &Value,
) -> String {
    dispatch_command_reply(
        pool,
        conversations,
        text,
        sender_id,
        chat_id,
        channel_id,
        kind,
        config,
    )
    .await
    .text
}

#[allow(clippy::too_many_arguments)]
async fn dispatch_command_reply(
    pool: &SqlitePool,
    conversations: &ConversationContext,
    text: &str,
    sender_id: &str,
    chat_id: &str,
    channel_id: &str,
    kind: &str,
    config: &Value,
) -> CommandReply {
    if !is_sender_authorized(kind, config, sender_id, chat_id) {
        return CommandReply::text(String::new());
    }
    let store = load_store().await.unwrap_or_default();
    let prefix = if store.command_prefix.trim().is_empty() {
        "/".to_string()
    } else {
        store.command_prefix
    };
    let Some(rest) = text.strip_prefix(&prefix) else {
        if text.starts_with("cb:") {
            return dispatch_callback(pool, conversations, text, sender_id, channel_id, &prefix)
                .await;
        }
        if selected_conversation(channel_id, sender_id).is_some() {
            return send_task(
                pool,
                conversations,
                channel_id,
                sender_id,
                chat_id,
                kind,
                config,
                text,
                &prefix,
            )
            .await;
        }
        return CommandReply::text(String::new());
    };
    let rest = rest.trim();
    let mut parts = rest.splitn(2, char::is_whitespace);
    let command = parts.next().unwrap_or("").to_lowercase();
    let args = parts.next().unwrap_or("").trim();
    match command.as_str() {
        "" | "help" | "start" => CommandReply::text(help_text(&prefix)).with_buttons(vec![
            ("Approve".into(), "cb:p:once".into()),
            ("Deny".into(), "cb:p:deny".into()),
        ]),
        "ping" => CommandReply::text(if store.message_language.starts_with("zh") {
            "VibeX Host 在线"
        } else {
            "VibeX Host online"
        }),
        "status" => CommandReply::text(channel_status_text().await),
        "conversations" | "sessions" | "ls" => CommandReply::text(list_conversations(pool).await),
        "use" | "resume" => CommandReply::text(
            select_conversation(pool, channel_id, sender_id, args, &prefix).await,
        ),
        "folder" => select_folder(pool, channel_id, sender_id, args, &prefix).await,
        "agent" => select_agent(pool, channel_id, sender_id, args, &prefix).await,
        "search" => CommandReply::text(search_conversations(pool, args, &prefix).await),
        "today" => CommandReply::text(today_conversations(pool).await),
        "task" | "do" | "ask" => {
            send_task(
                pool,
                conversations,
                channel_id,
                sender_id,
                chat_id,
                kind,
                config,
                args,
                &prefix,
            )
            .await
        }
        "approve" | "allow" => {
            let intent = if args.eq_ignore_ascii_case("always") {
                agents::RemotePermissionIntent::ApproveAlways
            } else {
                agents::RemotePermissionIntent::ApproveOnce
            };
            CommandReply::text(
                respond_permission(pool, conversations, channel_id, sender_id, intent, &prefix)
                    .await,
            )
        }
        "deny" | "reject" => CommandReply::text(
            respond_permission(
                pool,
                conversations,
                channel_id,
                sender_id,
                agents::RemotePermissionIntent::Deny,
                &prefix,
            )
            .await,
        ),
        "cancel" | "stop" => CommandReply::text(
            cancel_turn(pool, conversations, channel_id, sender_id, &prefix).await,
        ),
        "answer" => CommandReply::text(
            answer_question(pool, conversations, channel_id, sender_id, args, &prefix).await,
        ),
        _ => CommandReply::text(format!("unknown command; {prefix} help")),
    }
}

async fn dispatch_callback(
    pool: &SqlitePool,
    conversations: &ConversationContext,
    text: &str,
    sender_id: &str,
    channel_id: &str,
    prefix: &str,
) -> CommandReply {
    let Some(payload) = text.strip_prefix("cb:") else {
        return CommandReply::text(String::new());
    };
    let mut parts = payload.splitn(2, ':');
    let kind = parts.next().unwrap_or("");
    let value = parts.next().unwrap_or("");
    match kind {
        "f" => select_folder(pool, channel_id, sender_id, value, prefix).await,
        "a" => select_agent(pool, channel_id, sender_id, value, prefix).await,
        "p" if value == "deny" => CommandReply::text(
            respond_permission(
                pool,
                conversations,
                channel_id,
                sender_id,
                agents::RemotePermissionIntent::Deny,
                prefix,
            )
            .await,
        ),
        "p" => {
            let intent = if value == "always" {
                agents::RemotePermissionIntent::ApproveAlways
            } else {
                agents::RemotePermissionIntent::ApproveOnce
            };
            CommandReply::text(
                respond_permission(pool, conversations, channel_id, sender_id, intent, prefix)
                    .await,
            )
        }
        "q" => CommandReply::text(
            answer_question(pool, conversations, channel_id, sender_id, value, prefix).await,
        ),
        _ => CommandReply::text(String::new()),
    }
}

async fn list_conversations(pool: &SqlitePool) -> String {
    match recent_conversations(pool).await {
        Ok(rows) if rows.is_empty() => "No conversations on this Host.".to_string(),
        Ok(rows) => format_conversation_list(&rows),
        Err(error) => format!("failed to list conversations: {error}"),
    }
}

fn format_conversation_list(rows: &[ConversationRow]) -> String {
    rows.iter()
        .enumerate()
        .map(|(index, row)| {
            format!(
                "{}. {} · {}",
                index + 1,
                row.title.clone().unwrap_or_else(|| "untitled".into()),
                &row.id.to_string()[..8]
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[derive(sqlx::FromRow)]
struct ConversationRow {
    id: Uuid,
    workspace_id: Uuid,
    title: Option<String>,
    agent_type: Option<String>,
}

const CONVERSATION_SELECT: &str = r#"SELECT s.id, s.workspace_id, s.name AS title, COALESCE(s.agent_id, b.agent_type) AS agent_type
           FROM sessions s
           LEFT JOIN conversation_agent_bindings b
             ON b.conversation_id = s.id
           WHERE s.deleted_at IS NULL"#;

async fn recent_conversations(pool: &SqlitePool) -> Result<Vec<ConversationRow>, sqlx::Error> {
    sqlx::query_as::<_, ConversationRow>(&format!(
        "{CONVERSATION_SELECT}
           ORDER BY s.updated_at DESC, s.created_at DESC
           LIMIT 10"
    ))
    .fetch_all(pool)
    .await
}

fn resolve_conversation<'a>(
    rows: &'a [ConversationRow],
    args: &str,
) -> Result<Option<&'a ConversationRow>, usize> {
    let needle = args.trim();
    if needle.is_empty() {
        return Ok(None);
    }
    if let Ok(index) = needle.parse::<usize>() {
        return rows
            .get(index.saturating_sub(1))
            .map(Some)
            .ok_or(rows.len());
    }
    let lowered = needle.to_lowercase();
    Ok(rows.iter().find(|row| {
        let id = row.id.to_string();
        id.eq_ignore_ascii_case(needle) || id.to_lowercase().starts_with(&lowered)
    }))
}

async fn select_conversation(
    pool: &SqlitePool,
    channel_id: &str,
    sender_id: &str,
    args: &str,
    prefix: &str,
) -> String {
    let Ok(rows) = recent_conversations(pool).await else {
        return "failed to list conversations".to_string();
    };
    if args.trim().is_empty() {
        return if rows.is_empty() {
            "No conversations on this Host.".to_string()
        } else {
            format!(
                "{}\nusage: {prefix} resume [n|id]",
                format_conversation_list(&rows)
            )
        };
    }
    let row = match resolve_conversation(&rows, args) {
        Ok(Some(row)) => row,
        Ok(None) => {
            if let Ok(id) = Uuid::parse_str(args.trim()) {
                match sqlx::query_as::<_, ConversationRow>(&format!(
                    "{CONVERSATION_SELECT} AND s.id = ?"
                ))
                .bind(id)
                .fetch_optional(pool)
                .await
                {
                    Ok(Some(found)) => {
                        if let Ok(mut bridge) = session_bridge().lock() {
                            bridge.insert(
                                (channel_id.to_string(), sender_id.to_string()),
                                found.id.to_string(),
                            );
                        }
                        return format!(
                            "selected {} · {}",
                            found.title.clone().unwrap_or_else(|| "untitled".into()),
                            &found.id.to_string()[..8]
                        );
                    }
                    _ => return "conversation not found".to_string(),
                }
            }
            return format!("usage: {prefix} resume [n|id]");
        }
        Err(count) => {
            return format!("index out of range; {count} conversations");
        }
    };
    if let Ok(mut bridge) = session_bridge().lock() {
        bridge.insert(
            (channel_id.to_string(), sender_id.to_string()),
            row.id.to_string(),
        );
    }
    format!(
        "selected {} · {}",
        row.title.clone().unwrap_or_else(|| "untitled".into()),
        &row.id.to_string()[..8]
    )
}

async fn channel_status_text() -> String {
    let store = load_store().await.unwrap_or_default();
    let states = connection_states()
        .lock()
        .ok()
        .map(|map| map.clone())
        .unwrap_or_default();
    if store.channels.is_empty() {
        return "No chat channels on this Host.".to_string();
    }
    store
        .channels
        .into_iter()
        .map(|channel| {
            let state = states.get(&channel.id).cloned().unwrap_or_else(|| {
                if channel.enabled {
                    "disconnected".into()
                } else {
                    "disabled".into()
                }
            });
            format!("• {} [{}] {state}", channel.id, channel.kind)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

async fn search_conversations(pool: &SqlitePool, args: &str, prefix: &str) -> String {
    let keyword = args.trim();
    if keyword.is_empty() {
        return format!("usage: {prefix} search <keyword>");
    }
    let pattern = format!("%{keyword}%");
    match sqlx::query_as::<_, ConversationRow>(&format!(
        "{CONVERSATION_SELECT}
           AND (s.name LIKE ? OR CAST(s.id AS TEXT) LIKE ?)
           ORDER BY s.updated_at DESC, s.created_at DESC
           LIMIT 10"
    ))
    .bind(&pattern)
    .bind(&pattern)
    .fetch_all(pool)
    .await
    {
        Ok(matched) if matched.is_empty() => {
            format!("No conversations matching `{keyword}`.")
        }
        Ok(matched) => format_conversation_list(&matched),
        Err(error) => format!("search failed: {error}"),
    }
}

async fn today_conversations(pool: &SqlitePool) -> String {
    match sqlx::query_as::<_, ConversationRow>(&format!(
        "{CONVERSATION_SELECT}
           AND date(s.created_at) = date('now')
           ORDER BY s.created_at DESC
           LIMIT 20"
    ))
    .fetch_all(pool)
    .await
    {
        Ok(rows) if rows.is_empty() => "No conversations created today.".to_string(),
        Ok(rows) => format!(
            "Today ({})\n{}",
            chrono::Utc::now().date_naive(),
            format_conversation_list(&rows)
        ),
        Err(error) => format!("failed to list today: {error}"),
    }
}

async fn recent_projects(pool: &SqlitePool) -> Result<Vec<(Uuid, String)>, sqlx::Error> {
    sqlx::query_as::<_, (Uuid, String)>(
        r#"SELECT id, name FROM projects ORDER BY updated_at DESC, created_at DESC LIMIT 10"#,
    )
    .fetch_all(pool)
    .await
}

async fn select_folder(
    pool: &SqlitePool,
    channel_id: &str,
    sender_id: &str,
    args: &str,
    prefix: &str,
) -> CommandReply {
    let Ok(projects) = recent_projects(pool).await else {
        return CommandReply::text("failed to list projects");
    };
    if args.trim().is_empty() {
        if projects.is_empty() {
            return CommandReply::text("No projects on this Host.");
        }
        let text = projects
            .iter()
            .enumerate()
            .map(|(index, (_, name))| format!("{}. {name}", index + 1))
            .collect::<Vec<_>>()
            .join("\n");
        let buttons = projects
            .iter()
            .enumerate()
            .take(8)
            .map(|(index, (_, name))| {
                let label = if name.chars().count() > 20 {
                    format!(
                        "{}. {}…",
                        index + 1,
                        name.chars().take(18).collect::<String>()
                    )
                } else {
                    format!("{}. {name}", index + 1)
                };
                (label, format!("cb:f:{}", index + 1))
            })
            .collect();
        return CommandReply::text(text).with_buttons(buttons);
    }
    let Some(project) = resolve_project(&projects, args) else {
        return CommandReply::text(format!("usage: {prefix} folder <n|name>"));
    };
    if let Ok(mut bridge) = folder_bridge().lock() {
        bridge.insert((channel_id.to_string(), sender_id.to_string()), project.0);
    }
    CommandReply::text(format!("selected project {}", project.1))
}

fn resolve_project<'a>(projects: &'a [(Uuid, String)], args: &str) -> Option<&'a (Uuid, String)> {
    if let Ok(index) = args.trim().parse::<usize>() {
        return projects.get(index.saturating_sub(1));
    }
    let needle = args.trim().to_lowercase();
    projects
        .iter()
        .find(|(_, name)| name.to_lowercase() == needle)
        .or_else(|| {
            projects
                .iter()
                .find(|(_, name)| name.to_lowercase().contains(&needle))
        })
}

#[derive(Clone)]
struct AgentChoice {
    id: String,
    label: String,
}

async fn recent_agents(pool: &SqlitePool) -> Result<Vec<AgentChoice>, sqlx::Error> {
    let members = sqlx::query_as::<_, (String, Option<String>)>(
        r#"SELECT agent_id, json_extract(retained_metadata_json, '$.name')
           FROM agent_membership
           WHERE retired = 0 AND enabled = 1
           ORDER BY position ASC, agent_id ASC
           LIMIT 20"#,
    )
    .fetch_all(pool)
    .await?;
    if !members.is_empty() {
        return Ok(members
            .into_iter()
            .map(|(id, name)| {
                let label = match name {
                    Some(display) if !display.trim().is_empty() => display,
                    _ => id.clone(),
                };
                AgentChoice { id, label }
            })
            .collect());
    }
    let rows = sqlx::query_scalar::<_, Option<String>>(
        r#"SELECT DISTINCT COALESCE(s.agent_id, b.agent_type)
           FROM sessions s
           LEFT JOIN conversation_agent_bindings b ON b.conversation_id = s.id
           WHERE s.deleted_at IS NULL
           ORDER BY s.updated_at DESC
           LIMIT 20"#,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .flatten()
        .filter(|id| !id.is_empty())
        .map(|id| AgentChoice {
            label: id.clone(),
            id,
        })
        .collect())
}

async fn select_agent(
    pool: &SqlitePool,
    channel_id: &str,
    sender_id: &str,
    args: &str,
    prefix: &str,
) -> CommandReply {
    let Ok(agents) = recent_agents(pool).await else {
        return CommandReply::text("failed to list agents");
    };
    if args.trim().is_empty() {
        if agents.is_empty() {
            return CommandReply::text("No Agent bindings on this Host.");
        }
        let text = agents
            .iter()
            .enumerate()
            .map(|(index, agent)| format!("{}. {}", index + 1, agent.label))
            .collect::<Vec<_>>()
            .join("\n");
        let buttons = agents
            .iter()
            .enumerate()
            .take(8)
            .map(|(index, agent)| {
                (
                    format!("{}. {}", index + 1, agent.label),
                    format!("cb:a:{}", index + 1),
                )
            })
            .collect();
        return CommandReply::text(text).with_buttons(buttons);
    }
    let selected = if let Ok(index) = args.trim().parse::<usize>() {
        agents.get(index.saturating_sub(1)).cloned()
    } else {
        let needle = args.trim().to_lowercase();
        agents
            .iter()
            .find(|agent| {
                agent.id.to_lowercase() == needle
                    || agent.label.to_lowercase() == needle
                    || agent.id.to_lowercase().contains(&needle)
                    || agent.label.to_lowercase().contains(&needle)
            })
            .cloned()
    };
    let Some(selected) = selected else {
        return CommandReply::text(format!("usage: {prefix} agent <n|id>"));
    };
    let agent_id = selected.id;
    if agents::AgentId::parse(&agent_id).is_err() {
        return CommandReply::text(format!("invalid agent id: {agent_id}"));
    }
    if let Ok(mut bridge) = agent_bridge().lock() {
        bridge.insert(
            (channel_id.to_string(), sender_id.to_string()),
            agent_id.clone(),
        );
    }
    CommandReply::text(format!("selected agent {agent_id}"))
}

async fn latest_workspace_for_project(
    pool: &SqlitePool,
    project_id: Uuid,
) -> Result<Option<Uuid>, sqlx::Error> {
    sqlx::query_scalar::<_, Uuid>(
        r#"SELECT id FROM workspaces
           WHERE project_id = ? AND archived = 0
           ORDER BY updated_at DESC, created_at DESC
           LIMIT 1"#,
    )
    .bind(project_id)
    .fetch_optional(pool)
    .await
}

#[allow(clippy::too_many_arguments)]
async fn send_task(
    pool: &SqlitePool,
    conversations: &ConversationContext,
    channel_id: &str,
    sender_id: &str,
    chat_id: &str,
    kind: &str,
    config: &Value,
    args: &str,
    prefix: &str,
) -> CommandReply {
    if args.trim().is_empty() {
        return CommandReply::text(format!("usage: {prefix} task <text>"));
    }
    let Ok(rows) = recent_conversations(pool).await else {
        return CommandReply::text("No conversation available on this Host.");
    };
    let selected = selected_conversation(channel_id, sender_id);
    let existing = selected
        .and_then(|id| rows.iter().find(|row| row.id == id))
        .or_else(|| {
            (selected.is_none() && rows.len() == 1)
                .then(|| rows.first())
                .flatten()
        });

    let selected_agent = agent_bridge().lock().ok().and_then(|bridge| {
        bridge
            .get(&(channel_id.to_string(), sender_id.to_string()))
            .cloned()
    });
    let folder_project = folder_bridge().lock().ok().and_then(|bridge| {
        bridge
            .get(&(channel_id.to_string(), sender_id.to_string()))
            .copied()
    });

    let (conversation_id, workspace_id, agent_id, created) = if let Some(target) = existing {
        let Some(agent_id) = selected_agent
            .as_deref()
            .or(target.agent_type.as_deref())
            .and_then(|value| agents::AgentId::parse(value).ok())
        else {
            return CommandReply::text(format!("select an agent with {prefix} agent <n>"));
        };
        let workspace_id = if let Some(project_id) = folder_project {
            latest_workspace_for_project(pool, project_id)
                .await
                .ok()
                .flatten()
                .unwrap_or(target.workspace_id)
        } else {
            target.workspace_id
        };
        (target.id, workspace_id, agent_id, false)
    } else {
        let Some(project_id) = folder_project else {
            return CommandReply::text(format!(
                "select a project with {prefix} folder <n> and an agent with {prefix} agent <n>"
            ));
        };
        let Some(workspace_id) = latest_workspace_for_project(pool, project_id)
            .await
            .ok()
            .flatten()
        else {
            return CommandReply::text(
                "this project has no workspace yet; open it in VibeX once, then retry",
            );
        };
        let Some(agent_id) = selected_agent
            .as_deref()
            .and_then(|value| agents::AgentId::parse(value).ok())
        else {
            return CommandReply::text(format!("select an agent with {prefix} agent <n>"));
        };
        let title = args
            .lines()
            .next()
            .unwrap_or(args)
            .chars()
            .take(80)
            .collect::<String>();
        let conversation_id = Uuid::new_v4();
        if let Err(error) = ConversationRecord::create(
            pool,
            conversation_id,
            CreateConversationRecord {
                workspace_id,
                task_id: None,
                title: Some(&title),
                initial_prompt: Some(args),
                status: None,
                executor: Some(agent_id.as_str()),
            },
        )
        .await
        {
            return CommandReply::text(format!("failed to create conversation: {error}"));
        }
        let _ = sqlx::query(
            "UPDATE sessions SET agent_id = ?, agent_type = ?, updated_at = datetime('now', 'subsec') WHERE id = ?",
        )
        .bind(agent_id.as_str())
        .bind(agent_id.as_str())
        .bind(conversation_id)
        .execute(pool)
        .await;
        if let Ok(mut bridge) = session_bridge().lock() {
            bridge.insert(
                (channel_id.to_string(), sender_id.to_string()),
                conversation_id.to_string(),
            );
        }
        let created_event = ConversationEvent::ConversationCreated {
            title: Some(title.clone()),
        };
        if let Ok(value) = serde_json::to_value(&created_event)
            && let Some(event_kind) = value.get("kind").and_then(Value::as_str)
            && let Ok(normalized_json) = serde_json::to_string(&created_event)
            && let Ok(record) = ConversationEventAppender::append(
                pool,
                AppendConversationEvent {
                    id: Uuid::new_v4(),
                    conversation_id,
                    turn_id: None,
                    binding_id: None,
                    connection_id: None,
                    prompt_id: None,
                    source: "host",
                    event_kind,
                    normalized_json: &normalized_json,
                    raw_json: None,
                    idempotency_key: Some(&format!("im-created:{conversation_id}")),
                },
            )
            .await
        {
            conversations.event_publisher.publish(&record).await;
        }
        (conversation_id, workspace_id, agent_id, true)
    };

    let mut reply_thread = None;
    let topic_mode = config
        .get("topic_mode")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if created && kind == "telegram" && topic_mode && !sender_id.contains(":topic:") {
        let tokens = load_channel_tokens(&[channel_id.to_string()]).await;
        if let Some(token) = tokens.get(channel_id) {
            let title = args.lines().next().unwrap_or(args);
            match services::services::chat_delivery::telegram_create_forum_topic(
                token, chat_id, title,
            )
            .await
            {
                Ok(thread_id) => {
                    let scoped = format!("{sender_id}:topic:{thread_id}");
                    if let Ok(mut bridge) = session_bridge().lock()
                        && let Some(value) = bridge
                            .get(&(channel_id.to_string(), sender_id.to_string()))
                            .cloned()
                    {
                        bridge.insert((channel_id.to_string(), scoped), value);
                    }
                    reply_thread = Some(thread_id.to_string());
                }
                Err(error) => {
                    tracing::warn!(%error, "failed to create Telegram topic");
                }
            }
        }
    }

    match ConversationSessionService::new(conversations.clone())
        .start_turn(conversations::ConversationStartTurnInput {
            agent_id,
            workspace_id,
            conversation_id,
            executor_profile_id: None,
            text: args.to_string(),
            display_text: None,
            images: Vec::new(),
            mode_override: None,
            config_overrides: Vec::new(),
            workflow_refs: Vec::new(),
            file_refs: Vec::new(),
            queued_input_claim: None,
            operation_id: None,
        })
        .await
    {
        Ok(_) => {
            let body = if created {
                format!(
                    "created {} and sent the task",
                    &conversation_id.to_string()[..8]
                )
            } else {
                format!("sent to {}", &conversation_id.to_string()[..8])
            };
            let mut reply = CommandReply::text(body);
            if let Some(thread) = reply_thread {
                reply = reply.with_thread(thread);
            }
            reply
        }
        Err(error) => CommandReply::text(format!("send failed: {error}")),
    }
}

async fn pending_question(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Option<agents::conversation::ConversationQuestionRequest> {
    let rows = sqlx::query_as::<_, (String, String)>(
        r#"SELECT event_kind, normalized_json
           FROM conversation_events
           WHERE conversation_id = ?
             AND event_kind IN ('question_requested', 'question_responded')
           ORDER BY sequence DESC
           LIMIT 8"#,
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await
    .ok()?;
    let latest = rows.first()?;
    if latest.0 != "question_requested" {
        return None;
    }
    match serde_json::from_str::<ConversationEvent>(&latest.1) {
        Ok(ConversationEvent::QuestionRequested { request }) => Some(request),
        _ => None,
    }
}

fn question_choices(request: &agents::conversation::ConversationQuestionRequest) -> Vec<String> {
    if !request.options.is_empty() {
        return request.options.clone();
    }
    let Some(schema) = &request.schema else {
        return Vec::new();
    };
    let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
        return Vec::new();
    };
    for property in properties.values() {
        if let Some(values) = property.get("enum").and_then(Value::as_array) {
            return values
                .iter()
                .filter_map(|value| value.as_str().map(ToString::to_string))
                .collect();
        }
    }
    Vec::new()
}

async fn answer_question(
    pool: &SqlitePool,
    conversations: &ConversationContext,
    channel_id: &str,
    sender_id: &str,
    args: &str,
    prefix: &str,
) -> String {
    let Some(conversation_id) = selected_conversation(channel_id, sender_id) else {
        return format!("select a conversation with {prefix} resume [n|id]");
    };
    let Some(request) = pending_question(pool, conversation_id).await else {
        return "No pending question.".to_string();
    };
    let trimmed = args.trim();
    if trimmed.is_empty() {
        return format!("usage: {prefix} answer <n|text>");
    }
    let choices = question_choices(&request);
    let selected = if let Ok(index) = trimmed.parse::<usize>() {
        choices.get(index.saturating_sub(1)).cloned()
    } else {
        None
    };
    let answer = selected.unwrap_or_else(|| trimmed.to_string());
    let content = if let Some(schema) = &request.schema
        && let Some(properties) = schema.get("properties").and_then(Value::as_object)
        && let Some(key) = properties.keys().next()
    {
        json!({ key: answer })
    } else {
        json!({ "answer": answer })
    };
    match ConversationSessionService::new(conversations.clone())
        .respond_question(
            conversation_id,
            request.question_id,
            agents::AgentElicitationResponse::Accept { content },
        )
        .await
    {
        Ok(()) => "answered".to_string(),
        Err(error) => format!("answer failed: {error}"),
    }
}

async fn respond_permission(
    pool: &SqlitePool,
    conversations: &ConversationContext,
    channel_id: &str,
    sender_id: &str,
    intent: agents::RemotePermissionIntent,
    prefix: &str,
) -> String {
    let Some(conversation_id) = selected_conversation(channel_id, sender_id) else {
        return format!("select a conversation with {prefix} use <n>");
    };
    let Ok(permissions) =
        db::models::conversation_side_effects::ConversationPermissionRecord::list_for_conversation(
            pool,
            conversation_id,
        )
        .await
    else {
        return "failed to read permission requests".to_string();
    };
    let Some(pending) = permissions
        .into_iter()
        .find(|record| record.status == "pending")
    else {
        return "No pending permission request.".to_string();
    };
    let options: Vec<agents::AgentPermissionOption> =
        serde_json::from_str(&pending.options_json).unwrap_or_default();
    let Some(response) = agents::decide_remote_permission_response(intent, &options) else {
        return "This permission has no approvable option; use the desktop.".to_string();
    };
    match ConversationSessionService::new(conversations.clone())
        .respond_permission(conversation_id, pending.permission_id, response)
        .await
    {
        Ok(()) => match intent {
            agents::RemotePermissionIntent::Deny => "denied".to_string(),
            _ => "approved".to_string(),
        },
        Err(error) => format!("permission response failed: {error}"),
    }
}

async fn cancel_turn(
    pool: &SqlitePool,
    conversations: &ConversationContext,
    channel_id: &str,
    sender_id: &str,
    prefix: &str,
) -> String {
    let Some(conversation_id) = selected_conversation(channel_id, sender_id) else {
        return format!("select a conversation with {prefix} use <n>");
    };
    let _ = pool;
    match ConversationSessionService::new(conversations.clone())
        .cancel_turn(
            conversation_id,
            Some("Cancelled from chat channel".to_string()),
        )
        .await
    {
        Ok(()) => "cancelled".to_string(),
        Err(error) => format!("cancel failed: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_config_authorizes_nobody() {
        assert!(!is_sender_authorized(
            "telegram",
            &json!({}),
            "12345",
            "12345"
        ));
    }

    #[test]
    fn topic_mode_ignores_plain_text_in_general_topic() {
        let config = json!({ "topic_mode": true });
        assert!(
            config
                .get("topic_mode")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        );
    }

    #[test]
    fn telegram_bound_chat_is_authorized() {
        assert!(is_sender_authorized(
            "telegram",
            &json!({ "chat_id": "555" }),
            "999",
            "555"
        ));
    }

    #[test]
    fn qq_bound_target_is_authorized() {
        assert!(is_sender_authorized(
            "qq",
            &json!({ "target_id": "group-42" }),
            "sender-1",
            "group-42"
        ));
        assert!(!is_sender_authorized(
            "qq",
            &json!({ "target_id": "group-42" }),
            "sender-1",
            "group-99"
        ));
    }

    #[test]
    fn feishu_explicit_sender_is_allowed() {
        assert!(is_sender_authorized(
            "feishu",
            &json!({ "chat_id": "oc-1", "authorized_senders": ["ou-9"] }),
            "ou-9",
            "other"
        ));
    }

    #[test]
    fn callback_payloads_stay_within_telegram_limit() {
        assert!("cb:f:8".len() < 64);
        assert!("cb:a:8".len() < 64);
        assert!("cb:p:always".len() < 64);
    }

    #[test]
    fn help_lists_the_full_command_surface() {
        let help = help_text("/");
        for command in [
            "folder [n|name]",
            "agent [n|id]",
            "task <text>",
            "sessions",
            "resume [n|id]",
            "cancel",
            "approve [always]",
            "deny",
            "answer [n|text]",
            "search <keyword>",
            "today",
            "status",
            "help",
        ] {
            assert!(help.contains(command), "{help} should list {command}");
        }
        assert!(!help.contains("ping"), "{help} should not advertise ping");
    }

    #[test]
    fn resolve_conversation_accepts_index_and_id_prefix() {
        let id = Uuid::parse_str("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee").unwrap();
        let rows = [ConversationRow {
            id,
            workspace_id: id,
            title: Some("demo".into()),
            agent_type: Some("claude-code".into()),
        }];
        assert_eq!(
            resolve_conversation(&rows, "1").unwrap().map(|row| row.id),
            Some(id)
        );
        assert_eq!(
            resolve_conversation(&rows, "aaaaaaaa")
                .unwrap()
                .map(|row| row.id),
            Some(id)
        );
        assert!(resolve_conversation(&rows, "2").is_err());
        assert!(resolve_conversation(&rows, "zzzz").unwrap().is_none());
    }

    #[test]
    fn qq_ws_url_derives_from_http_base() {
        assert_eq!(
            qq_ws_url(&json!({ "base_url": "http://127.0.0.1:5700" })),
            "ws://127.0.0.1:5700"
        );
        assert_eq!(
            qq_ws_url(&json!({ "ws_url": "wss://bot.example/ws" })),
            "wss://bot.example/ws"
        );
    }
}
