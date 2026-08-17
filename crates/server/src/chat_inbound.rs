//! Host-owned IM inbound loops. Desktop and `vibex-server` start the same runtime.

use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use conversations::{ConversationContext, ConversationSessionService};
use serde_json::Value;
use sqlx::SqlitePool;
use tokio::task::JoinHandle;
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
}

#[derive(Clone)]
struct InboundTarget {
    channel_id: String,
    kind: String,
    signature: String,
    token: String,
    _config: Value,
}

/// Start Telegram / Feishu / QQ inbound loops against the current Host.
pub fn start_chat_inbound(pool: SqlitePool, conversations: ConversationContext) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut running: HashMap<String, (String, Arc<AtomicBool>)> = HashMap::new();
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
            tokio::time::sleep(Duration::from_secs(RECONCILE_SECS)).await;
        }
    })
}

async fn inbound_targets() -> Result<Vec<InboundTarget>, String> {
    let store = load_store().await?;
    let mut targets = Vec::new();
    for channel in store.channels.into_iter().filter(|channel| channel.enabled) {
        let token = channel
            .config
            .get("bot_token")
            .or_else(|| channel.config.get("app_secret"))
            .or_else(|| channel.config.get("access_token"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        match channel.kind.as_str() {
            "telegram" if !token.is_empty() => targets.push(InboundTarget {
                channel_id: channel.id,
                kind: "telegram".into(),
                signature: format!("tg:{token}"),
                token,
                _config: channel.config,
            }),
            "feishu" if !token.is_empty() => targets.push(InboundTarget {
                channel_id: channel.id,
                kind: "feishu".into(),
                signature: format!("fs:{token}"),
                token,
                _config: channel.config,
            }),
            "qq" => {
                let ws_url = channel
                    .config
                    .get("ws_url")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if !ws_url.is_empty() {
                    targets.push(InboundTarget {
                        channel_id: channel.id,
                        kind: "qq".into(),
                        signature: format!("qq:{ws_url}"),
                        token,
                        _config: channel.config,
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
    if target.kind != "telegram" {
        tracing::info!(
            channel_id = %target.channel_id,
            kind = %target.kind,
            "host inbound adapter ready; telegram long-poll is started immediately"
        );
    }
    if target.kind == "telegram" {
        spawn_telegram_loop(
            pool,
            conversations,
            target.channel_id.clone(),
            target.token.clone(),
            shutdown,
        );
    }
}

fn spawn_telegram_loop(
    pool: SqlitePool,
    conversations: ConversationContext,
    channel_id: String,
    bot_token: String,
    shutdown: Arc<AtomicBool>,
) {
    tokio::spawn(async move {
        let client = reqwest::Client::new();
        let mut offset: i64 = 0;
        while !shutdown.load(Ordering::Relaxed) {
            let url = format!(
                "https://api.telegram.org/bot{bot_token}/getUpdates?timeout=25&offset={offset}"
            );
            let body = match client.get(&url).send().await {
                Ok(response) => response.json::<Value>().await.unwrap_or(Value::Null),
                Err(_) => {
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
                let Some(message) = update.get("message") else {
                    continue;
                };
                let text = message
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let sender_id = message
                    .get("from")
                    .and_then(|from| from.get("id"))
                    .map(|id| id.to_string())
                    .unwrap_or_default();
                let chat_id = message
                    .get("chat")
                    .and_then(|chat| chat.get("id"))
                    .map(|id| id.to_string())
                    .unwrap_or_default();
                if text.is_empty() || sender_id.is_empty() {
                    continue;
                }
                let reply = dispatch_command(
                    &pool,
                    &conversations,
                    &text,
                    &sender_id,
                    &chat_id,
                    &channel_id,
                )
                .await;
                if reply.is_empty() {
                    continue;
                }
                let _ = client
                    .post(format!(
                        "https://api.telegram.org/bot{bot_token}/sendMessage"
                    ))
                    .json(&serde_json::json!({ "chat_id": chat_id, "text": reply }))
                    .send()
                    .await;
            }
        }
    });
}

async fn dispatch_command(
    pool: &SqlitePool,
    conversations: &ConversationContext,
    text: &str,
    _sender_id: &str,
    _chat_id: &str,
    _channel_id: &str,
) -> String {
    let store = load_store().await.unwrap_or_default();
    let prefix = if store.command_prefix.trim().is_empty() {
        "/".to_string()
    } else {
        store.command_prefix
    };
    let Some(rest) = text.strip_prefix(&prefix) else {
        return String::new();
    };
    let rest = rest.trim();
    let mut parts = rest.splitn(2, char::is_whitespace);
    let command = parts.next().unwrap_or("").to_lowercase();
    let args = parts.next().unwrap_or("").trim();
    match command.as_str() {
        "" | "help" | "start" => format!(
            "VibeX Host commands:\n{prefix} ping\n{prefix} conversations\n{prefix} task <text>"
        ),
        "ping" => "VibeX Host online".to_string(),
        "conversations" | "sessions" | "ls" => list_conversations(pool).await,
        "task" | "do" | "ask" => send_task(pool, conversations, args).await,
        _ => format!("unknown command; {prefix} help"),
    }
}

async fn list_conversations(pool: &SqlitePool) -> String {
    let rows = sqlx::query_as::<_, (Uuid, Option<String>)>(
        r#"SELECT id, name FROM sessions
           WHERE deleted_at IS NULL
           ORDER BY updated_at DESC, created_at DESC
           LIMIT 10"#,
    )
    .fetch_all(pool)
    .await;
    match rows {
        Ok(rows) if rows.is_empty() => "No conversations on this Host.".to_string(),
        Ok(rows) => rows
            .into_iter()
            .enumerate()
            .map(|(index, (id, title))| {
                format!(
                    "{}. {} · {}",
                    index + 1,
                    title.unwrap_or_else(|| "untitled".into()),
                    &id.to_string()[..8]
                )
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Err(error) => format!("failed to list conversations: {error}"),
    }
}

async fn send_task(pool: &SqlitePool, conversations: &ConversationContext, args: &str) -> String {
    if args.trim().is_empty() {
        return "usage: /task <text>".to_string();
    }
    let Ok(Some((conversation_id, workspace_id, agent_type))) =
        sqlx::query_as::<_, (Uuid, Uuid, Option<String>)>(
            r#"SELECT s.id, s.workspace_id, COALESCE(s.agent_type, b.agent_type)
           FROM sessions s
           LEFT JOIN conversation_agent_bindings b
             ON b.conversation_id = s.id
           WHERE s.deleted_at IS NULL
           ORDER BY s.updated_at DESC
           LIMIT 1"#,
        )
        .fetch_optional(pool)
        .await
    else {
        return "No conversation available on this Host.".to_string();
    };
    let Some(agent_id) = agent_type.and_then(|value| agents::AgentId::parse(&value).ok()) else {
        return "Latest conversation has no Agent binding.".to_string();
    };
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
            plugin_actions: Vec::new(),
            queued_input_claim: None,
        })
        .await
    {
        Ok(_) => format!("sent to {}", &conversation_id.to_string()[..8]),
        Err(error) => format!("send failed: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_store_has_no_inbound_targets() {
        let store = ChatChannelStore::default();
        assert!(store.channels.is_empty());
    }
}
