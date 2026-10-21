use agents::conversation::{ConversationEvent, ConversationRowOpBatch, ConversationSessionModes};
use async_trait::async_trait;
use conversations::{
    CachedRowProjector, ConversationEventPublisher, ConversationRowProjectors,
    IncrementalRowProjector, evict_least_recently_used_projectors,
};
use db::models::{conversation_event::ConversationEventRecord, session::Session};
use serde::Serialize;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::host::events::HostEventBus;

#[derive(Debug, Clone, Serialize)]
struct WorkspaceSessionsChangedPayload {
    workspace_id: Uuid,
    conversation_id: Uuid,
}

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
        let mut map = self.projectors.lock().await;
        let publish_after = map
            .get(&conversation_id)
            .map(|entry| entry.db_cursor)
            .unwrap_or_else(|| record.sequence.saturating_sub(1));
        let mut new_records = match ConversationEventRecord::events_since(
            &self.pool,
            conversation_id,
            publish_after,
            2000,
        )
        .await
        {
            Ok(records) => records,
            Err(error) => {
                tracing::warn!(%conversation_id, %error, "row-op emit: reading events failed");
                return;
            }
        };
        if new_records.is_empty() && record.sequence > publish_after {
            new_records.push(record.clone());
        }
        if new_records.is_empty() {
            return;
        }

        let mut session_modes = None;
        let mut session_config_options = None;
        let mut available_commands = None;
        for item in &new_records {
            if let Ok(event) = serde_json::from_str::<ConversationEvent>(&item.normalized_json) {
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
        }
        let queue_changed = new_records
            .iter()
            .any(|item| item.event_kind == "conversation_input");

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
        let mut ops = Vec::new();
        let should_emit = {
            let entry = map
                .get_mut(&conversation_id)
                .expect("projector present after insert");
            entry.touch();
            let previous_sequence = entry.last_emitted_sequence;
            for item in &new_records {
                match entry.apply_persisted(item) {
                    Ok(Some(record_ops)) => {
                        conversations::extend_coalesced_row_ops(&mut ops, record_ops)
                    }
                    Ok(None) => {}
                    Err(error) => {
                        tracing::warn!(sequence = item.sequence, %error, "row-op emit: fold failed");
                    }
                }
            }
            let last_sequence = entry.db_cursor;
            let will_emit = !(ops.is_empty()
                && session_modes.is_none()
                && session_config_options.is_none()
                && available_commands.is_none()
                && !queue_changed);
            if will_emit {
                entry.last_emitted_sequence = last_sequence;
                Some((previous_sequence, last_sequence))
            } else {
                None
            }
        };

        evict_least_recently_used_projectors(&mut map, conversation_id);
        drop(map);

        if let Some((previous_sequence, last_sequence)) = should_emit {
            let emit_global = !ops.iter().all(|op| {
                matches!(
                    op,
                    agents::conversation::ConversationRowOp::AppendText { .. }
                )
            }) || session_modes.is_some()
                || session_config_options.is_some()
                || available_commands.is_some()
                || queue_changed;
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

        let workbench_changed = new_records.iter().any(|item| {
            matches!(
                item.event_kind.as_str(),
                "user_turn_queued"
                    | "user_turn_started"
                    | "turn_blocked"
                    | "turn_completed"
                    | "turn_failed"
                    | "turn_cancelled"
                    | "turn_interrupted"
                    | "conversation_input"
                    | "user_turn_created"
            )
        });
        if workbench_changed
            && let Ok(Some(session)) = Session::find_by_id(&self.pool, conversation_id).await
        {
            self.events.emit(
                "workspace-sessions-changed",
                WorkspaceSessionsChangedPayload {
                    workspace_id: session.workspace_id,
                    conversation_id,
                },
            );
        }
    }

    async fn publish_unpersisted(&self, record: &ConversationEventRecord) {
        let conversation_id = record.conversation_id;
        let mut map = self.projectors.lock().await;
        if let std::collections::hash_map::Entry::Vacant(entry) = map.entry(conversation_id) {
            match IncrementalRowProjector::load_through_latest(&self.pool, conversation_id).await {
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
        let cursor = entry.last_emitted_sequence;
        let ops = match entry.apply_unpersisted(record) {
            Ok(ops) => ops,
            Err(error) => {
                tracing::warn!(%error, "row-op emit: unpersisted fold failed");
                return;
            }
        };
        evict_least_recently_used_projectors(&mut map, conversation_id);
        drop(map);
        if ops.is_empty() {
            return;
        }
        let batch = ConversationRowOpBatch {
            conversation_id,
            last_sequence: cursor,
            previous_sequence: Some(cursor),
            ops,
            session_modes: None,
            session_config_options: None,
            available_commands: None,
        };
        self.events
            .emit(format!("conversation-events:{conversation_id}"), &batch);
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
                    files: vec![ConversationFileChange {
                        path: "src/lib.rs".to_string(),
                        change_kind: "modified".to_string(),
                        additions: Some(4),
                        deletions: Some(1),
                        old_path: None,
                        status: "completed".to_string(),
                    }],
                    updated_at: chrono::Utc::now(),
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
