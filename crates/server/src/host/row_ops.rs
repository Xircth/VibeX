use std::{collections::HashMap, sync::Arc};

use agents::conversation::ConversationRowOpBatch;
use async_trait::async_trait;
use conversations::{ConversationEventPublisher, IncrementalRowProjector};
use db::models::conversation_event::ConversationEventRecord;
use sqlx::SqlitePool;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::host::events::global_host_events;

pub struct HostRowOpPublisher {
    pool: SqlitePool,
    projectors: Arc<Mutex<HashMap<Uuid, IncrementalRowProjector>>>,
}

impl HostRowOpPublisher {
    pub fn new(
        pool: SqlitePool,
        projectors: Arc<Mutex<HashMap<Uuid, IncrementalRowProjector>>>,
    ) -> Self {
        Self { pool, projectors }
    }
}

#[async_trait]
impl ConversationEventPublisher for HostRowOpPublisher {
    async fn publish(&self, record: &ConversationEventRecord) {
        let conversation_id = record.conversation_id;
        let publish_after = record.sequence.saturating_sub(1);
        let mut map = self.projectors.lock().await;
        if let std::collections::hash_map::Entry::Vacant(entry) = map.entry(conversation_id) {
            match IncrementalRowProjector::load(&self.pool, conversation_id, publish_after).await {
                Ok(projector) => {
                    entry.insert(projector);
                }
                Err(error) => {
                    tracing::warn!(%conversation_id, %error, "row-op emit: projector load failed");
                    return;
                }
            }
        }
        let projector = map
            .get_mut(&conversation_id)
            .expect("projector present after insert");
        if record.sequence <= projector.last_sequence() {
            return;
        }
        let ops = match projector.apply(record) {
            Ok(ops) => ops,
            Err(error) => {
                tracing::warn!(sequence = record.sequence, %error, "row-op emit: fold failed");
                return;
            }
        };
        if ops.is_empty() {
            return;
        }
        let last_sequence = projector.last_sequence();
        let settled = matches!(
            record.event_kind.as_str(),
            "turn_completed" | "turn_failed" | "turn_cancelled"
        );
        if settled {
            map.remove(&conversation_id);
        }
        drop(map);

        let batch = ConversationRowOpBatch {
            conversation_id,
            last_sequence,
            ops,
            session_modes: None,
            session_config_options: None,
            available_commands: None,
        };
        let bus = global_host_events();
        bus.emit(format!("conversation-events:{conversation_id}"), &batch);
        bus.emit("conversation-events", &batch);
    }
}
