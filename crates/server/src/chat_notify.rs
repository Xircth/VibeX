//! Host-owned IM outbound: one publisher seam for desktop and dimo-server.

use std::{
    path::PathBuf,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};

use agents::conversation::{ConversationEvent, ConversationEventEnvelope};
use async_trait::async_trait;
use conversations::ConversationEventPublisher;
use db::models::conversation_event::ConversationEventRecord;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use services::services::chat_delivery::{
    ImLang, build_conversation_rich, conversation_event_key, deliver_rich, load_channel_tokens,
    post_event_webhooks, should_send,
};
use tokio::sync::{RwLock, mpsc};

const SETTINGS_SECTION: &str = "chat_channels";
const STORE_CACHE_TTL: Duration = Duration::from_secs(2);
const DELIVERY_QUEUE_CAPACITY: usize = 256;

#[derive(Clone)]
struct CachedStore {
    path: PathBuf,
    loaded_at: Instant,
    store: ChatChannelStore,
}

static STORE_CACHE: OnceLock<RwLock<Option<CachedStore>>> = OnceLock::new();

fn store_cache() -> &'static RwLock<Option<CachedStore>> {
    STORE_CACHE.get_or_init(|| RwLock::new(None))
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct ChatChannelRecord {
    id: String,
    kind: String,
    enabled: bool,
    #[serde(default)]
    config: Value,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
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

#[derive(Clone, Debug, Deserialize, Serialize)]
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

impl ChatChannelStore {
    fn has_active_targets(&self) -> bool {
        !self.event_filter.is_empty()
            && (self.channels.iter().any(|c| c.enabled)
                || self.event_webhooks.iter().any(|w| w.enabled))
    }
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

struct DeliveryJob {
    envelope: ConversationEventEnvelope,
    event_key: &'static str,
    store: ChatChannelStore,
}

pub struct ChatDeliveryPublisher {
    inner: Arc<dyn ConversationEventPublisher>,
    tx: OnceLock<mpsc::Sender<DeliveryJob>>,
}

impl ChatDeliveryPublisher {
    pub fn new(inner: Arc<dyn ConversationEventPublisher>) -> Self {
        Self {
            inner,
            tx: OnceLock::new(),
        }
    }

    fn sender(&self) -> &mpsc::Sender<DeliveryJob> {
        self.tx.get_or_init(|| {
            let (tx, mut rx) = mpsc::channel::<DeliveryJob>(DELIVERY_QUEUE_CAPACITY);
            tokio::spawn(async move {
                while let Some(job) = rx.recv().await {
                    deliver_conversation_event(&job.envelope, job.event_key, &job.store).await;
                }
            });
            tx
        })
    }

    fn enqueue_record_with_store(
        &self,
        record: &ConversationEventRecord,
        store: &ChatChannelStore,
    ) {
        let Ok(event) = serde_json::from_str::<ConversationEvent>(&record.normalized_json) else {
            return;
        };
        let Some(event_key) = conversation_event_key(&event) else {
            return;
        };
        if !store
            .event_filter
            .iter()
            .any(|enabled| enabled == event_key)
        {
            return;
        }
        let envelope = ConversationEventEnvelope {
            id: record.id,
            conversation_id: record.conversation_id,
            turn_id: record.turn_id,
            sequence: record.sequence,
            source: record.source.clone(),
            event,
            created_at: record.created_at,
        };
        let job = DeliveryJob {
            envelope,
            event_key,
            store: store.clone(),
        };
        if let Err(mpsc::error::TrySendError::Full(_)) = self.sender().try_send(job) {
            tracing::warn!(
                conversation_id = %record.conversation_id,
                event_key,
                "Chat delivery queue full; dropping IM/webhook notification"
            );
        }
    }

    async fn enqueue_record(&self, record: &ConversationEventRecord) {
        let Ok(store) = load_store_cached().await else {
            return;
        };
        if !store.has_active_targets() {
            return;
        }
        self.enqueue_record_with_store(record, &store);
    }
}

#[async_trait]
impl ConversationEventPublisher for ChatDeliveryPublisher {
    async fn publish(&self, record: &ConversationEventRecord) {
        self.inner.publish(record).await;
        self.enqueue_record(record).await;
    }

    async fn publish_batch(&self, records: &[ConversationEventRecord]) {
        self.inner.publish_batch(records).await;
        if records.is_empty() {
            return;
        }
        let Ok(store) = load_store_cached().await else {
            return;
        };
        if !store.has_active_targets() {
            return;
        }
        for record in records {
            self.enqueue_record_with_store(record, &store);
        }
    }

    async fn publish_unpersisted(&self, record: &ConversationEventRecord) {
        self.inner.publish_unpersisted(record).await;
    }

    async fn publish_reset(&self, conversation_id: uuid::Uuid, last_sequence: i64) {
        self.inner
            .publish_reset(conversation_id, last_sequence)
            .await;
    }

    async fn flush_conversation(&self, conversation_id: uuid::Uuid) {
        self.inner.flush_conversation(conversation_id).await;
    }
}

pub async fn notify_conversation_event(envelope: &ConversationEventEnvelope) {
    let Ok(store) = load_store_cached().await else {
        return;
    };
    notify_conversation_event_with_store(envelope, &store).await;
}

async fn notify_conversation_event_with_store(
    envelope: &ConversationEventEnvelope,
    store: &ChatChannelStore,
) {
    if !store.has_active_targets() {
        return;
    }
    let Some(event) = conversation_event_key(&envelope.event) else {
        return;
    };
    if !store.event_filter.iter().any(|enabled| enabled == event) {
        return;
    }
    deliver_conversation_event(envelope, event, store).await;
}

async fn deliver_conversation_event(
    envelope: &ConversationEventEnvelope,
    event: &str,
    store: &ChatChannelStore,
) {
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

pub async fn chat_event_webhooks() -> Result<Value, String> {
    let store = load_store().await?;
    serde_json::to_value(store.event_webhooks).map_err(|error| error.to_string())
}

pub async fn set_chat_event_webhooks(webhooks: Value) -> Result<Value, String> {
    let cleaned = webhooks
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|hook| {
            let url = hook.get("url")?.as_str()?.trim().to_string();
            if url.starts_with("http://") || url.starts_with("https://") {
                Some(EventWebhook {
                    url,
                    enabled: hook.get("enabled").and_then(Value::as_bool).unwrap_or(true),
                })
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    let mut store = load_store().await?;
    store.event_webhooks = cleaned;
    save_store(&store).await?;
    serde_json::to_value(store.event_webhooks).map_err(|error| error.to_string())
}

pub async fn chat_message_language() -> Result<String, String> {
    let lang = load_store().await?.message_language;
    Ok(if lang.trim().is_empty() {
        "en".to_string()
    } else {
        lang
    })
}

pub async fn set_chat_message_language(language: String) -> Result<String, String> {
    let language = match language.as_str() {
        "zh-CN" | "zh" | "zh-cn" => "zh-CN".to_string(),
        _ => "en".to_string(),
    };
    let mut store = load_store().await?;
    store.message_language = language.clone();
    save_store(&store).await?;
    Ok(language)
}

async fn load_store_cached() -> Result<ChatChannelStore, String> {
    let path = utils::assets::settings_path();
    let now = Instant::now();
    {
        let guard = store_cache().read().await;
        if let Some(cached) = guard.as_ref()
            && cached.path == path
            && now.duration_since(cached.loaded_at) < STORE_CACHE_TTL
        {
            return Ok(cached.store.clone());
        }
    }
    let store = load_store().await?;
    let mut guard = store_cache().write().await;
    *guard = Some(CachedStore {
        path,
        loaded_at: Instant::now(),
        store: store.clone(),
    });
    Ok(store)
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

async fn save_store(store: &ChatChannelStore) -> Result<(), String> {
    let path = utils::assets::settings_path();
    let value = serde_json::to_value(store).map_err(|error| error.to_string())?;
    services::services::settings_store::write_section(&path, SETTINGS_SECTION, &value)
        .await
        .map_err(|error| error.to_string())?;
    let mut guard = store_cache().write().await;
    *guard = Some(CachedStore {
        path,
        loaded_at: Instant::now(),
        store: store.clone(),
    });
    Ok(())
}
