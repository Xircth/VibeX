use agents::conversation::{ConversationEvent, ConversationRowOpBatch, ConversationSessionModes};
use async_trait::async_trait;
use conversations::{
    CachedRowProjector, ConversationEventPublisher, ConversationRowProjectors,
    IncrementalRowProjector, evict_least_recently_used_projectors,
};
use db::models::conversation_event::ConversationEventRecord;
use sqlx::SqlitePool;

use crate::host::events::HostEventBus;

pub struct HostRowOpPublisher {
    pool: SqlitePool,
    projectors: ConversationRowProjectors,
    events: std::sync::Arc<HostEventBus>,
}

impl HostRowOpPublisher {
    pub fn new(
        pool: SqlitePool,
        projectors: ConversationRowProjectors,
        events: std::sync::Arc<HostEventBus>,
    ) -> Self {
        Self {
            pool,
            projectors,
            events,
        }
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
                    entry.insert(CachedRowProjector::new(projector));
                }
                Err(error) => {
                    tracing::warn!(%conversation_id, %error, "row-op emit: projector load failed");
                    return;
                }
            }
        }
        let entry = map
            .get_mut(&conversation_id)
            .expect("projector present after insert");
        entry.touch();
        if record.sequence <= entry.projector.last_sequence() {
            return;
        }
        let previous_sequence = entry.last_emitted_sequence;
        let ops = match entry.projector.apply(record) {
            Ok(ops) => ops,
            Err(error) => {
                tracing::warn!(sequence = record.sequence, %error, "row-op emit: fold failed");
                return;
            }
        };
        let last_sequence = entry.projector.last_sequence();

        let mut session_modes = None;
        let mut session_config_options = None;
        let mut available_commands = None;
        if let Ok(event) = serde_json::from_str::<ConversationEvent>(&record.normalized_json) {
            match event {
                ConversationEvent::SessionModeUpdated { current, modes } => {
                    session_modes = Some(ConversationSessionModes { current, modes });
                }
                ConversationEvent::SessionConfigOptionsUpdated { options } => {
                    session_config_options = Some(options);
                }
                ConversationEvent::AvailableCommandsUpdated { commands } => {
                    available_commands = Some(commands);
                }
                _ => {}
            }
        }
        if ops.is_empty()
            && session_modes.is_none()
            && session_config_options.is_none()
            && available_commands.is_none()
        {
            evict_least_recently_used_projectors(&mut map, conversation_id);
            return;
        }
        entry.last_emitted_sequence = last_sequence;
        evict_least_recently_used_projectors(&mut map, conversation_id);
        drop(map);

        let emit_global = !ops.iter().all(|op| {
            matches!(
                op,
                agents::conversation::ConversationRowOp::AppendText { .. }
            )
        }) || session_modes.is_some()
            || session_config_options.is_some()
            || available_commands.is_some();
        let batch = ConversationRowOpBatch {
            conversation_id,
            last_sequence,
            previous_sequence: Some(previous_sequence),
            ops,
            session_modes,
            session_config_options,
            available_commands,
        };
        self.events
            .emit(format!("conversation-events:{conversation_id}"), &batch);
        if emit_global {
            self.events.emit("conversation-events", &batch);
        }
    }
}
