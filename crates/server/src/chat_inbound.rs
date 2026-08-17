//! Host-owned IM inbound loops. Desktop and `vibex-server` start the same runtime.

use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Mutex as StdMutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use conversations::{ConversationContext, ConversationSessionService};
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

fn set_connection_state(channel_id: &str, state: &str) {
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
                            let tokens = load_channel_tokens(&[channel.id.clone()]).await;
                            let token = tokens.get(&channel.id);
                            let _ = services::services::chat_delivery::deliver_rich(
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
            tokio::time::sleep(Duration::from_secs(RECONCILE_SECS)).await;
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
        return false;
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
                    set_connection_state(&channel_id, "connected");
                    response.json::<Value>().await.unwrap_or(Value::Null)
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
                let Some(text) = update.pointer("/message/text").and_then(Value::as_str) else {
                    continue;
                };
                let Some(chat_id) = update
                    .pointer("/message/chat/id")
                    .and_then(|value| value_to_id(value))
                else {
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
                let reply = dispatch_command(
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
                let _ = client
                    .post(format!(
                        "https://api.telegram.org/bot{bot_token}/sendMessage"
                    ))
                    .json(&json!({ "chat_id": chat_id, "text": reply }))
                    .send()
                    .await;
            }
        }
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
        while !shutdown.load(Ordering::Relaxed) {
            let ws_url = match feishu_ws_url(&app_id, &app_secret).await {
                Ok(url) => url,
                Err(error) => {
                    tracing::warn!(channel_id = %channel_id, %error, "Feishu ws endpoint failed");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                }
            };
            match tokio_tungstenite::connect_async(&ws_url).await {
                Ok((stream, _)) => {
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

fn help_text(prefix: &str) -> String {
    format!(
        "VibeX Host commands:\n\
         {prefix} folder [n]\n\
         {prefix} agent [n|id]\n\
         {prefix} task <text>\n\
         {prefix} sessions\n\
         {prefix} use <n>\n\
         {prefix} resume <n>\n\
         {prefix} cancel\n\
         {prefix} approve [always]\n\
         {prefix} deny\n\
         {prefix} search <keyword>\n\
         {prefix} today\n\
         {prefix} status\n\
         {prefix} ping\n\
         {prefix} help"
    )
}

#[allow(clippy::too_many_arguments)]
async fn dispatch_command(
    pool: &SqlitePool,
    conversations: &ConversationContext,
    text: &str,
    sender_id: &str,
    chat_id: &str,
    channel_id: &str,
    kind: &str,
    config: &Value,
) -> String {
    if !is_sender_authorized(kind, config, sender_id, chat_id) {
        return String::new();
    }
    let store = load_store().await.unwrap_or_default();
    let prefix = if store.command_prefix.trim().is_empty() {
        "/".to_string()
    } else {
        store.command_prefix
    };
    let Some(rest) = text.strip_prefix(&prefix) else {
        if selected_conversation(channel_id, sender_id).is_some() {
            return send_task(pool, conversations, channel_id, sender_id, text, &prefix).await;
        }
        return String::new();
    };
    let rest = rest.trim();
    let mut parts = rest.splitn(2, char::is_whitespace);
    let command = parts.next().unwrap_or("").to_lowercase();
    let args = parts.next().unwrap_or("").trim();
    match command.as_str() {
        "" | "help" | "start" => help_text(&prefix),
        "ping" => "VibeX Host online".to_string(),
        "status" => channel_status_text().await,
        "conversations" | "sessions" | "ls" => list_conversations(pool).await,
        "use" | "resume" => select_conversation(pool, channel_id, sender_id, args, &prefix).await,
        "folder" => select_folder(pool, channel_id, sender_id, args, &prefix).await,
        "agent" => select_agent(pool, channel_id, sender_id, args, &prefix).await,
        "search" => search_conversations(pool, args, &prefix).await,
        "today" => today_conversations(pool).await,
        "task" | "do" | "ask" => {
            send_task(pool, conversations, channel_id, sender_id, args, &prefix).await
        }
        "approve" | "allow" => {
            let intent = if args.eq_ignore_ascii_case("always") {
                agents::RemotePermissionIntent::ApproveAlways
            } else {
                agents::RemotePermissionIntent::ApproveOnce
            };
            respond_permission(pool, conversations, channel_id, sender_id, intent, &prefix)
                .await
        }
        "deny" | "reject" => {
            respond_permission(
                pool,
                conversations,
                channel_id,
                sender_id,
                agents::RemotePermissionIntent::Deny,
                &prefix,
            )
            .await
        }
        "cancel" | "stop" => {
            cancel_turn(pool, conversations, channel_id, sender_id, &prefix).await
        }
        _ => format!("unknown command; {prefix} help"),
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

async fn recent_conversations(pool: &SqlitePool) -> Result<Vec<ConversationRow>, sqlx::Error> {
    sqlx::query_as::<_, ConversationRow>(
        r#"SELECT s.id, s.workspace_id, s.name AS title, COALESCE(s.agent_id, b.agent_type) AS agent_type
           FROM sessions s
           LEFT JOIN conversation_agent_bindings b
             ON b.conversation_id = s.id
           WHERE s.deleted_at IS NULL
           ORDER BY s.updated_at DESC, s.created_at DESC
           LIMIT 10"#,
    )
    .fetch_all(pool)
    .await
}

async fn select_conversation(
    pool: &SqlitePool,
    channel_id: &str,
    sender_id: &str,
    args: &str,
    prefix: &str,
) -> String {
    let Ok(index) = args.trim().parse::<usize>() else {
        return format!("usage: {prefix} use <n>");
    };
    let Ok(rows) = recent_conversations(pool).await else {
        return "failed to list conversations".to_string();
    };
    let Some(row) = rows.get(index.saturating_sub(1)) else {
        return format!("index out of range; {} conversations", rows.len());
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
            let state = states
                .get(&channel.id)
                .cloned()
                .unwrap_or_else(|| {
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
    if args.trim().is_empty() {
        return format!("usage: {prefix} search <keyword>");
    }
    match recent_conversations(pool).await {
        Ok(rows) => {
            let keyword = args.to_lowercase();
            let matched = rows
                .into_iter()
                .filter(|row| {
                    row.title
                        .as_deref()
                        .unwrap_or("")
                        .to_lowercase()
                        .contains(&keyword)
                })
                .collect::<Vec<_>>();
            if matched.is_empty() {
                format!("No conversations matching `{args}`.")
            } else {
                format_conversation_list(&matched)
            }
        }
        Err(error) => format!("search failed: {error}"),
    }
}

async fn today_conversations(pool: &SqlitePool) -> String {
    match recent_conversations(pool).await {
        Ok(rows) => {
            let today = chrono::Utc::now().date_naive();
            let count = rows.len();
            format!("Recent conversations on this Host: {count} (today {today})")
        }
        Err(error) => format!("failed to list today: {error}"),
    }
}

async fn recent_projects(
    pool: &SqlitePool,
) -> Result<Vec<(Uuid, String)>, sqlx::Error> {
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
) -> String {
    let Ok(projects) = recent_projects(pool).await else {
        return "failed to list projects".to_string();
    };
    if args.trim().is_empty() {
        if projects.is_empty() {
            return "No projects on this Host.".to_string();
        }
        return projects
            .into_iter()
            .enumerate()
            .map(|(index, (_, name))| format!("{}. {name}", index + 1))
            .collect::<Vec<_>>()
            .join("\n");
    }
    let Some(project) = resolve_project(&projects, args) else {
        return format!("usage: {prefix} folder <n|name>");
    };
    if let Ok(mut bridge) = folder_bridge().lock() {
        bridge.insert((channel_id.to_string(), sender_id.to_string()), project.0);
    }
    format!("selected project {}", project.1)
}

fn resolve_project<'a>(
    projects: &'a [(Uuid, String)],
    args: &str,
) -> Option<&'a (Uuid, String)> {
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

async fn recent_agents(pool: &SqlitePool) -> Result<Vec<String>, sqlx::Error> {
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
    Ok(rows.into_iter().flatten().filter(|id| !id.is_empty()).collect())
}

async fn select_agent(
    pool: &SqlitePool,
    channel_id: &str,
    sender_id: &str,
    args: &str,
    prefix: &str,
) -> String {
    let Ok(agents) = recent_agents(pool).await else {
        return "failed to list agents".to_string();
    };
    if args.trim().is_empty() {
        if agents.is_empty() {
            return "No Agent bindings on this Host.".to_string();
        }
        return agents
            .into_iter()
            .enumerate()
            .map(|(index, id)| format!("{}. {id}", index + 1))
            .collect::<Vec<_>>()
            .join("\n");
    }
    let selected = if let Ok(index) = args.trim().parse::<usize>() {
        agents.get(index.saturating_sub(1)).cloned()
    } else {
        let needle = args.trim().to_lowercase();
        agents
            .iter()
            .find(|id| id.to_lowercase() == needle || id.to_lowercase().contains(&needle))
            .cloned()
    };
    let Some(agent_id) = selected else {
        return format!("usage: {prefix} agent <n|id>");
    };
    if agents::AgentId::parse(&agent_id).is_err() {
        return format!("invalid agent id: {agent_id}");
    }
    if let Ok(mut bridge) = agent_bridge().lock() {
        bridge.insert((channel_id.to_string(), sender_id.to_string()), agent_id.clone());
    }
    format!("selected agent {agent_id}")
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

async fn send_task(
    pool: &SqlitePool,
    conversations: &ConversationContext,
    channel_id: &str,
    sender_id: &str,
    args: &str,
    prefix: &str,
) -> String {
    if args.trim().is_empty() {
        return format!("usage: {prefix} task <text>");
    }
    let Ok(rows) = recent_conversations(pool).await else {
        return "No conversation available on this Host.".to_string();
    };
    let selected = selected_conversation(channel_id, sender_id);
    let target = selected
        .and_then(|id| rows.iter().find(|row| row.id == id))
        .or_else(|| (rows.len() == 1).then(|| rows.first()).flatten());
    let Some(target) = target else {
        return format!("select a conversation with {prefix} use <n> or a project with {prefix} folder <n>");
    };
    let selected_agent = agent_bridge()
        .lock()
        .ok()
        .and_then(|bridge| {
            bridge
                .get(&(channel_id.to_string(), sender_id.to_string()))
                .cloned()
        });
    let Some(agent_id) = selected_agent
        .as_deref()
        .or(target.agent_type.as_deref())
        .and_then(|value| agents::AgentId::parse(value).ok())
    else {
        return format!("select an agent with {prefix} agent <n>");
    };
    let workspace_id = folder_bridge()
        .lock()
        .ok()
        .and_then(|bridge| {
            bridge
                .get(&(channel_id.to_string(), sender_id.to_string()))
                .copied()
        })
        .map(|project_id| async move { latest_workspace_for_project(pool, project_id).await })
        ;
    let workspace_id = if let Some(lookup) = workspace_id {
        match lookup.await {
            Ok(Some(id)) => id,
            Ok(None) => target.workspace_id,
            Err(_) => target.workspace_id,
        }
    } else {
        target.workspace_id
    };
    match ConversationSessionService::new(conversations.clone())
        .start_turn(conversations::ConversationStartTurnInput {
            agent_id,
            workspace_id,
            conversation_id: target.id,
            executor_profile_id: None,
            text: args.to_string(),
            display_text: None,
            images: Vec::new(),
            mode_override: None,
            config_overrides: Vec::new(),
            plugin_actions: Vec::new(),
            queued_input_claim: None,
        })
        .await
    {
        Ok(_) => format!("sent to {}", &target.id.to_string()[..8]),
        Err(error) => format!("send failed: {error}"),
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
    let Some(pending) = permissions.into_iter().find(|record| record.status == "pending") else {
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
        .cancel_turn(conversation_id, Some("Cancelled from chat channel".to_string()))
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
        assert!(config
            .get("topic_mode")
            .and_then(Value::as_bool)
            .unwrap_or(false));
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
    fn help_lists_the_full_command_surface() {
        let help = help_text("/");
        for command in [
            "folder", "agent", "task", "sessions", "approve", "deny", "cancel", "search", "today",
        ] {
            assert!(help.contains(command), "{help} should list {command}");
        }
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
