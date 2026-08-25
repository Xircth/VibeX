//! Host-owned IM outbound: one publisher seam for desktop and vibex-server.

use std::sync::Arc;

use agents::conversation::{ConversationEvent, ConversationEventEnvelope};
use async_trait::async_trait;
use conversations::ConversationEventPublisher;
use db::models::conversation_event::ConversationEventRecord;
use serde::Deserialize;
use serde_json::Value;
use services::services::chat_delivery::{
    ImLang, build_conversation_rich, conversation_event_key, deliver_rich, load_channel_tokens,
    post_event_webhooks, should_send,
};

const SETTINGS_SECTION: &str = "chat_channels";

#[derive(Clone, Debug, Default, Deserialize)]
struct ChatChannelRecord {
    id: String,
    kind: String,
    enabled: bool,
    #[serde(default)]
    config: Value,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct EventWebhook {
    url: String,
    #[serde(default)]
    enabled: bool,
}

fn default_event_filter() -> Vec<String> {
    services::services::chat_delivery::DEFAULT_CHAT_EVENTS
        .iter()
        .map(|event| (*event).to_string())
        .collect()
}

#[derive(Clone, Debug, Deserialize)]
struct ChatChannelStore {
    #[serde(default)]
    channels: Vec<ChatChannelRecord>,
    #[serde(default = "default_event_filter")]
    event_filter: Vec<String>,
    #[serde(default)]
    include_prompt_text: bool,
    #[serde(default)]
    event_webhooks: Vec<EventWebhook>,
    #[serde(default)]
    message_language: String,
}

impl Default for ChatChannelStore {
    fn default() -> Self {
        Self {
            channels: Vec::new(),
            event_filter: default_event_filter(),
            include_prompt_text: false,
            event_webhooks: Vec::new(),
            message_language: String::new(),
        }
    }
}

pub struct ChatDeliveryPublisher {
    inner: Arc<dyn ConversationEventPublisher>,
}

impl ChatDeliveryPublisher {
    pub fn new(inner: Arc<dyn ConversationEventPublisher>) -> Self {
        Self { inner }
    }
}

#[async_trait]
impl ConversationEventPublisher for ChatDeliveryPublisher {
    async fn publish(&self, record: &ConversationEventRecord) {
        self.inner.publish(record).await;
        notify_conversation_record(record).await;
    }
}

pub async fn notify_conversation_record(record: &ConversationEventRecord) {
    let Ok(event) = serde_json::from_str::<ConversationEvent>(&record.normalized_json) else {
        return;
    };
    let envelope = ConversationEventEnvelope {
        id: record.id,
        conversation_id: record.conversation_id,
        turn_id: record.turn_id,
        sequence: record.sequence,
        source: record.source.clone(),
        event,
        created_at: record.created_at,
    };
    notify_conversation_event(&envelope).await;
}

pub async fn notify_conversation_event(envelope: &ConversationEventEnvelope) {
    let Some(event) = conversation_event_key(&envelope.event) else {
        return;
    };
    let Ok(store) = load_store().await else {
        return;
    };
    if !store.event_filter.iter().any(|enabled| enabled == event) {
        return;
    }
    let ids: Vec<String> = store
        .channels
        .iter()
        .map(|channel| channel.id.clone())
        .collect();
    let tokens = load_channel_tokens(&ids).await;
    let lang = ImLang::parse(&store.message_language);
    let mut msg = build_conversation_rich(&envelope.event, store.include_prompt_text, lang)
        .with_field("Conversation", envelope.conversation_id.to_string());
    if let Some(turn_id) = envelope.turn_id {
        msg = msg.with_field("Turn", turn_id.to_string());
    }
    let hooks: Vec<(String, bool)> = store
        .event_webhooks
        .iter()
        .map(|hook| (hook.url.clone(), hook.enabled))
        .collect();
    post_event_webhooks(&hooks, event, &msg.to_plain()).await;

    for channel in store.channels.iter().filter(|channel| channel.enabled) {
        if !should_send(&channel.id, event, msg.level) {
            continue;
        }
        let token = tokens.get(&channel.id).map(String::as_str);
        if let Err(error) =
            deliver_rich(&channel.id, &channel.kind, &channel.config, token, &msg).await
        {
            tracing::warn!(
                channel_id = %channel.id,
                kind = %channel.kind,
                error = %error,
                "Failed to send chat channel notification"
            );
        }
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
