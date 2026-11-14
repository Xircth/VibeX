//! Host-side conversation live pipeline.
//!
//! The fold/lock/batch logic lives in [`conversations::ConversationLivePipeline`];
//! this module is only the Host transport adapter plus the thin
//! [`ConversationEventPublisher`] shim the orchestration core expects.

use std::sync::Arc;

use agents::conversation::ConversationRowOpBatch;
use conversations::{
    ConversationEventPublisher, ConversationEventSink, ConversationLivePipeline,
    ConversationRowProjectors, WorkspaceSessionsChanged,
};
use db::models::conversation_event::ConversationEventRecord;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::host::events::HostEventBus;

/// [`ConversationEventSink`] backed by a [`HostEventBus`].
///
/// Used by both the headless server (holds the bus directly) and the Tauri desktop
/// (bus installed into a process-global). Channel names match the established
/// `conversation-events` / `conversation-events:{id}` / `workspace-sessions-changed`
/// protocol so both transports stay identical.
pub struct HostBusSink {
    bus: Arc<HostEventBus>,
}

impl HostBusSink {
    pub fn new(bus: Arc<HostEventBus>) -> Self {
        Self { bus }
    }
}

impl ConversationEventSink for HostBusSink {
    fn emit_conversation_batch(&self, conversation_id: Uuid, batch: &ConversationRowOpBatch) {
        self.bus
            .emit(format!("conversation-events:{conversation_id}"), batch);
    }

    fn emit_global_batch(&self, batch: &ConversationRowOpBatch) {
        self.bus.emit("conversation-events", batch);
    }

    fn emit_workspaces_sessions_changed(&self, payload: WorkspaceSessionsChanged) {
        self.bus.emit("workspace-sessions-changed", payload);
    }
}

/// Host `ConversationEventPublisher` — a thin delegation to the shared
/// [`ConversationLivePipeline`]. Kept as a named type so `composition` wiring and
/// tests read the same as before the pipeline was extracted.
pub struct HostRowOpPublisher {
    pipeline: ConversationLivePipeline,
}

impl HostRowOpPublisher {
    pub fn new(
        pool: SqlitePool,
        projectors: ConversationRowProjectors,
        events: Arc<HostEventBus>,
    ) -> Self {
        Self {
            pipeline: ConversationLivePipeline::new(
                pool,
                projectors,
                Arc::new(HostBusSink::new(events)),
            ),
        }
    }
}

#[async_trait::async_trait]
impl ConversationEventPublisher for HostRowOpPublisher {
    async fn publish(&self, record: &ConversationEventRecord) {
        self.pipeline.publish(record).await;
    }

    async fn publish_unpersisted(&self, record: &ConversationEventRecord) {
        self.pipeline.publish_unpersisted(record).await;
    }
}

#[cfg(test)]
mod tests {
    use std::{str::FromStr, sync::Arc};

    use agents::conversation::{
        ConversationEvent, ConversationFileChange, ConversationFileChangeSummary,
        ConversationInputBlock, ConversationRowOp, ConversationRowOpBatch, ConversationTimelineRow,
    };
    use conversations::{ConversationEventPublisher, ConversationRowProjectors};
    use db::models::{
        conversation_event::{AppendConversationEvent, ConversationEventRecord},
        conversation_turn::{ConversationTurnRecord, CreateConversationTurn},
    };
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use uuid::Uuid;

    use super::HostRowOpPublisher;
    use crate::host::events::HostEventBus;

    async fn test_pool() -> sqlx::SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("sqlite memory options")
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("connect sqlite memory pool");
        sqlx::migrate!("../db/migrations")
            .run(&pool)
            .await
            .expect("migrations");
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("disable fk");
        pool
    }

    async fn append_event(
        pool: &sqlx::SqlitePool,
        conversation_id: Uuid,
        turn_id: Uuid,
        event_kind: &str,
        event: &ConversationEvent,
    ) -> ConversationEventRecord {
        let normalized_json = serde_json::to_string(event).expect("serialize event");
        ConversationEventRecord::append(
            pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id: Some(turn_id),
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                source: "acp",
                event_kind,
                normalized_json: &normalized_json,
                raw_json: None,
                idempotency_key: None,
            },
        )
        .await
        .expect("append event")
    }

    #[tokio::test]
    async fn server_publisher_previous_sequence_tracks_last_emitted_sequence_across_empty_records()
    {
        let pool = test_pool().await;
        let projectors = ConversationRowProjectors::default();
        let bus = Arc::new(HostEventBus::new());
        let mut rx = bus.subscribe();
        let publisher = HostRowOpPublisher::new(pool.clone(), projectors, Arc::clone(&bus));

        let conversation_id = Uuid::new_v4();
        let turn_id = Uuid::new_v4();
        ConversationTurnRecord::create_pending(
            &pool,
            turn_id,
            CreateConversationTurn {
                conversation_id,
                prompt_id: None,
                text_preview: Some("hello"),
                input_blocks_json: "[]",
            },
        )
        .await
        .expect("create pending turn");
        let channel = format!("conversation-events:{conversation_id}");

        let rec1 = append_event(
            &pool,
            conversation_id,
            turn_id,
            "user_turn_created",
            &ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "hello".to_string(),
                }],
                workflow_refs: Vec::new(),
            },
        )
        .await;
        publisher.publish(&rec1).await;

        let mut received = Vec::new();
        while let Ok(evt) = rx.try_recv() {
            if evt.channel == channel {
                let batch: ConversationRowOpBatch =
                    serde_json::from_value(evt.payload).expect("decode batch");
                received.push(batch);
            }
        }
        assert_eq!(received.len(), 1);
        assert_eq!(received[0].previous_sequence, Some(0));
        assert_eq!(received[0].last_sequence, 1);

        let rec2 = append_event(
            &pool,
            conversation_id,
            turn_id,
            "raw_diagnostic_recorded",
            &ConversationEvent::RawDiagnosticRecorded {
                label: "user_message_acknowledged".to_string(),
                payload: None,
            },
        )
        .await;
        publisher.publish(&rec2).await;
        while let Ok(evt) = rx.try_recv() {
            assert_ne!(evt.channel, channel, "empty ops record must not emit batch");
        }

        let unpersisted = ConversationEventRecord {
            id: Uuid::new_v4(),
            conversation_id,
            turn_id: Some(turn_id),
            binding_id: None,
            connection_id: None,
            prompt_id: None,
            sequence: 2,
            source: "acp".to_string(),
            event_kind: "assistant_text_delta".to_string(),
            event_version: 1,
            normalized_json: serde_json::to_string(&ConversationEvent::AssistantTextDelta {
                text: "streaming chunk".to_string(),
                message_id: None,
            })
            .expect("serialize delta"),
            raw_json: None,
            idempotency_key: None,
            created_at: chrono::Utc::now(),
        };
        publisher.publish_unpersisted(&unpersisted).await;

        let mut unpersisted_batches = Vec::new();
        while let Ok(evt) = rx.try_recv() {
            if evt.channel == channel {
                let batch: ConversationRowOpBatch =
                    serde_json::from_value(evt.payload).expect("decode batch");
                unpersisted_batches.push(batch);
            }
        }
        assert_eq!(unpersisted_batches.len(), 1);
        assert_eq!(
            unpersisted_batches[0].previous_sequence,
            Some(unpersisted_batches[0].last_sequence)
        );
        assert_eq!(unpersisted_batches[0].last_sequence, 1);

        // Append TurnCompleted AND a companion FileChangeSummaryUpdated before calling publish(&rec3)
        // (matching runtime_events::finalize_checkpoint_file_changes).
        let rec3 = append_event(
            &pool,
            conversation_id,
            turn_id,
            "turn_completed",
            &ConversationEvent::TurnCompleted { stop_reason: None },
        )
        .await;
        let _rec4 = append_event(
            &pool,
            conversation_id,
            turn_id,
            "file_change_summary_updated",
            &ConversationEvent::FileChangeSummaryUpdated {
                summary: ConversationFileChangeSummary {
                    source: "git".to_string(),
                    files: vec![ConversationFileChange {
                        path: "src/lib.rs".to_string(),
                        change_kind: "modified".to_string(),
                        additions: Some(4),
                        deletions: Some(1),
                        old_path: None,
                    }],
                    summary: None,
                },
            },
        )
        .await;
        publisher.publish(&rec3).await;

        let mut final_batches = Vec::new();
        while let Ok(evt) = rx.try_recv() {
            if evt.channel == channel {
                let batch: ConversationRowOpBatch =
                    serde_json::from_value(evt.payload).expect("decode batch");
                final_batches.push(batch);
            }
        }
        assert_eq!(final_batches.len(), 1);
        assert_eq!(
            final_batches[0].previous_sequence,
            Some(received[0].last_sequence)
        );
        assert_eq!(final_batches[0].last_sequence, 4);
        assert!(final_batches[0].ops.iter().any(|op| matches!(
            op,
            ConversationRowOp::Upsert { row }
                if matches!(row.row, ConversationTimelineRow::FileChangeSummary { .. })
        )));
    }
}
