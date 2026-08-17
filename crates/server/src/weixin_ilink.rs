//! WeChat iLink bot: QR login, long-poll inbound, and reply send.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex as StdMutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use base64::Engine;
use conversations::ConversationContext;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::SqlitePool;

use crate::chat_inbound::{dispatch_command, set_connection_state};

const ILINK_BASE_URL: &str = "https://ilinkai.weixin.qq.com";
const ILINK_CHANNEL_VERSION: &str = "1.0.2";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeixinQrcodeInfo {
    pub qrcode_id: String,
    pub qrcode_url: String,
    pub qrcode_img_content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeixinQrcodeStatus {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bot_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

#[derive(Clone)]
struct ReplyContext {
    to_user_id: String,
    context_token: String,
    base_url: String,
    bot_token: String,
}

fn reply_contexts() -> &'static StdMutex<HashMap<String, ReplyContext>> {
    static CONTEXTS: OnceLock<StdMutex<HashMap<String, ReplyContext>>> = OnceLock::new();
    CONTEXTS.get_or_init(|| StdMutex::new(HashMap::new()))
}

fn qr_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap_or_default()
}

pub async fn weixin_get_qrcode() -> Result<WeixinQrcodeInfo, String> {
    let body: Value = qr_client()
        .get(format!("{ILINK_BASE_URL}/ilink/bot/get_bot_qrcode"))
        .query(&[("bot_type", "3")])
        .send()
        .await
        .map_err(|error| error.to_string())?
        .json()
        .await
        .map_err(|error| error.to_string())?;
    let qrcode_id = body
        .get("qrcode")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if qrcode_id.is_empty() {
        return Err("empty Weixin QR id".to_string());
    }
    let image = body
        .get("qrcode_img_content")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let qrcode_url = if image.starts_with("http://") || image.starts_with("https://") {
        image.clone()
    } else {
        format!("{ILINK_BASE_URL}/ilink/bot/qrcode?qrcode={qrcode_id}")
    };
    Ok(WeixinQrcodeInfo {
        qrcode_id,
        qrcode_url,
        qrcode_img_content: image,
    })
}

pub async fn weixin_check_qrcode(qrcode: &str) -> Result<WeixinQrcodeStatus, String> {
    let body: Value = qr_client()
        .get(format!("{ILINK_BASE_URL}/ilink/bot/get_qrcode_status"))
        .query(&[("qrcode", qrcode)])
        .send()
        .await
        .map_err(|error| error.to_string())?
        .json()
        .await
        .map_err(|error| error.to_string())?;
    Ok(WeixinQrcodeStatus {
        status: body
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("waiting")
            .to_string(),
        bot_token: body
            .get("bot_token")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        base_url: body
            .get("baseurl")
            .and_then(Value::as_str)
            .map(ToString::to_string),
    })
}

pub fn spawn_weixin_ilink_loop(
    pool: SqlitePool,
    conversations: ConversationContext,
    channel_id: String,
    bot_token: String,
    base_url: String,
    config: Value,
    shutdown: Arc<AtomicBool>,
) {
    tokio::spawn(async move {
        let client = qr_client();
        let wechat_uin = base64::engine::general_purpose::STANDARD
            .encode(uuid::Uuid::new_v4().as_bytes());
        let mut cursor = String::new();
        set_connection_state(&channel_id, "connecting");
        while !shutdown.load(Ordering::Relaxed) {
            let body = json!({
                "get_updates_buf": cursor,
                "base_info": { "channel_version": ILINK_CHANNEL_VERSION }
            });
            match client
                .post(format!("{}/ilink/bot/getupdates", base_url.trim_end_matches('/')))
                .header("Content-Type", "application/json")
                .header("AuthorizationType", "ilink_bot_token")
                .header("Authorization", format!("Bearer {bot_token}"))
                .header("X-WECHAT-UIN", &wechat_uin)
                .json(&body)
                .send()
                .await
            {
                Ok(response) => {
                    set_connection_state(&channel_id, "connected");
                    let payload = response.json::<Value>().await.unwrap_or(Value::Null);
                    if payload.get("errcode").and_then(Value::as_i64).unwrap_or(0) != 0
                        || payload.get("ret").and_then(Value::as_i64) == Some(-14)
                    {
                        set_connection_state(&channel_id, "error");
                        tokio::time::sleep(Duration::from_secs(15)).await;
                        continue;
                    }
                    if let Some(next) = payload.get("get_updates_buf").and_then(Value::as_str)
                        && !next.is_empty()
                    {
                        cursor = next.to_string();
                    }
                    if let Some(messages) = payload.get("msgs").and_then(Value::as_array) {
                        for message in messages {
                            handle_ilink_message(
                                &pool,
                                &conversations,
                                &client,
                                &channel_id,
                                &bot_token,
                                &base_url,
                                &wechat_uin,
                                &config,
                                message,
                            )
                            .await;
                        }
                    }
                }
                Err(error) => {
                    tracing::warn!(channel_id = %channel_id, %error, "Weixin iLink poll failed");
                    set_connection_state(&channel_id, "error");
                    tokio::time::sleep(Duration::from_secs(3)).await;
                }
            }
        }
        set_connection_state(&channel_id, "disconnected");
    });
}

#[allow(clippy::too_many_arguments)]
async fn handle_ilink_message(
    pool: &SqlitePool,
    conversations: &ConversationContext,
    client: &reqwest::Client,
    channel_id: &str,
    bot_token: &str,
    base_url: &str,
    wechat_uin: &str,
    config: &Value,
    message: &Value,
) {
    if message.get("message_type").and_then(Value::as_i64) != Some(1) {
        return;
    }
    let text = message
        .get("item_list")
        .and_then(Value::as_array)
        .and_then(|items| {
            items.iter().find_map(|item| {
                match item.get("type").and_then(Value::as_i64) {
                    Some(1) => item.pointer("/text_item/text").and_then(Value::as_str),
                    Some(3) => item.pointer("/voice_item/text").and_then(Value::as_str),
                    _ => None,
                }
            })
        })
        .unwrap_or("")
        .trim()
        .to_string();
    if text.is_empty() {
        return;
    }
    let sender_id = message
        .get("from_user_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let context_token = message
        .get("context_token")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if !sender_id.is_empty() && !context_token.is_empty() {
        if let Ok(mut contexts) = reply_contexts().lock() {
            contexts.insert(
                channel_id.to_string(),
                ReplyContext {
                    to_user_id: sender_id.clone(),
                    context_token,
                    base_url: base_url.to_string(),
                    bot_token: bot_token.to_string(),
                },
            );
        }
    }
    let reply = dispatch_command(
        pool,
        conversations,
        &text,
        &sender_id,
        &sender_id,
        channel_id,
        "weixin",
        config,
    )
    .await;
    if reply.is_empty() {
        return;
    }
    let Some(context) = reply_contexts()
        .lock()
        .ok()
        .and_then(|map| map.get(channel_id).cloned())
    else {
        return;
    };
    let body = json!({
        "msg": {
            "from_user_id": "",
            "to_user_id": context.to_user_id,
            "client_id": format!("vibex-{}", uuid::Uuid::new_v4()),
            "message_type": 2,
            "message_state": 2,
            "context_token": context.context_token,
            "item_list": [{ "type": 1, "text_item": { "text": reply } }]
        },
        "base_info": { "channel_version": ILINK_CHANNEL_VERSION }
    });
    let _ = client
        .post(format!(
            "{}/ilink/bot/sendmessage",
            context.base_url.trim_end_matches('/')
        ))
        .header("Content-Type", "application/json")
        .header("AuthorizationType", "ilink_bot_token")
        .header("Authorization", format!("Bearer {}", context.bot_token))
        .header("X-WECHAT-UIN", wechat_uin)
        .json(&body)
        .send()
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qr_status_defaults_to_waiting() {
        let parsed = serde_json::from_value::<WeixinQrcodeStatus>(json!({
            "status": "waiting"
        }))
        .unwrap();
        assert_eq!(parsed.status, "waiting");
        assert!(parsed.bot_token.is_none());
    }
}
