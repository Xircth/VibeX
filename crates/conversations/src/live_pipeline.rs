//! Unified conversation live-event pipeline.
//!
//! This module consolidates the row-op publishing logic that both the Tauri desktop
//! (`src-tauri/src/events.rs`) and the headless/web server (`crates/server/src/host/row_ops.rs`)
//! used to duplicate. The two transports (desktop Tauri events vs. server WebSocket)
//! share the same projector fold, per-conversation lock management, and batch assembly —
//! only the final broadcast differs, and that lives behind [`ConversationEventSink`].
//!
//! # Design
//!
//! The pipeline owns:
//! - A per-conversation async mutex map (serialises cursor read → tail read → fold)
//! - The [`ConversationRowProjectors`] LRU cache
//! - The session-control state extraction (modes / config / goal / async tasks / suggestions)
//! - The workbench-changed detection and `workspace-sessions-changed` emission
//!
//! The sink only sees the finished [`ConversationRowOpBatch`] and the optional
//! [`WorkspaceSessionsChanged`] notification.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use agents::conversation::{
    ConversationEvent, ConversationPromptSuggestion, ConversationRowOp, ConversationRowOpBatch,
    ConversationSessionGoal, ConversationSessionModes,
};
use db::models::{conversation_event::ConversationEventRecord, session::Session};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::projection::{
    CachedRowProjector, ConversationRowProjectors, IncrementalRowProjector,
    evict_least_recently_used_projectors, extend_coalesced_row_ops,
};

/// Emitted when a workbench-affecting event lands (turn queued / started / completed / …).
/// The frontend uses this to refresh the session list without refetching every conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceSessionsChanged {
    pub workspace_id: Uuid,
    pub conversation_id: Uuid,
}

/// Transport adapter. The pipeline computes the batch; the sink broadcasts it.
///
/// Implementations must be cheap to call (non-blocking) — the pipeline runs inside
/// the per-conversation lock, so any blocking here serialises unrelated conversations.
pub trait ConversationEventSink: Send + Sync + 'static {
    /// Emit a row-op batch to listeners of a specific conversation.
    fn emit_conversation_batch(&self, conversation_id: Uuid, batch: &ConversationRowOpBatch);

    /// Emit a row-op batch to the global conversation-events channel (all conversations).
    /// Only called when the batch contains non-append-text ops or session-control state.
    fn emit_global_batch(&self, batch: &ConversationRowOpBatch);

    /// Notify listeners that a session's workbench state changed.
    fn emit_workspaces_sessions_changed(&self, payload: WorkspaceSessionsChanged);
}

/// The unified conversation live pipeline. Both Tauri desktop and headless server
/// construct one of these with their transport-specific sink.
pub struct ConversationLivePipeline {
    pool: SqlitePool,
    projectors: ConversationRowProjectors,
    sink: Arc<dyn ConversationEventSink>,
    conversation_locks: Mutex<HashMap<Uuid, Arc<tokio::sync::Mutex<()>>>>,
}

impl ConversationLivePipeline {
    /// Create a new pipeline.
    ///
    /// - `pool`: SQLite connection pool for reading events
    /// - `projectors`: Shared LRU cache of incremental row projectors
    /// - `sink`: Transport adapter for broadcasting batches
    pub fn new(
        pool: SqlitePool,
        projectors: ConversationRowProjectors,
        sink: Arc<dyn ConversationEventSink>,
    ) -> Self {
        Self {
            pool,
            projectors,
            sink,
            conversation_locks: Mutex::new(HashMap::new()),
        }
    }

    /// Acquire the per-conversation serialisation lock. Creates one on first access.
    fn conversation_lock(&self, conversation_id: Uuid) -> Arc<tokio::sync::Mutex<()>> {
        let mut map = self
            .conversation_locks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        map.entry(conversation_id)
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    /// Drop locks for conversations no longer in the projector cache, unless
    /// another task holds a reference (strong_count > 1 means someone is waiting).
    fn prune_conversation_locks(
        &self,
        active: &HashMap<Uuid, CachedRowProjector>,
    ) {
        let mut map = self
            .conversation_locks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        map.retain(|id, lock| active.contains_key(id) || Arc::strong_count(lock) > 1);
    }

    /// Publish committed events as frontend row operations in durable sequence order.
    ///
    /// This is the single realtime path to the frontend: the frontend consumes
    /// `ConversationRowOpBatch` and never folds raw events. It feeds the conversation's
    /// cached incremental projector so ops are produced in O(1) amortized (no per-frame
    /// re-projection). `after_sequence` seeds a missing projector. Once active, the
    /// database cursor — not the fold sequence — decides which durable rows are new.
    /// Transcript deltas advance the fold without moving that cursor. Best-effort — a
    /// dropped batch is healed by reloading the transcript window.
    pub async fn publish(&self, record: &ConversationEventRecord) {
        let conversation_id = record.conversation_id;
        let conv_lock = self.conversation_lock(conversation_id);
        let _conv_guard = conv_lock.lock().await;

        let after_sequence = record.sequence.saturating_sub(1);
        let (mut publish_after, mut has_projector) = {
            let mut map = self.projectors.lock().await;
            match map.get_mut(&conversation_id) {
                Some(entry) => {
                    entry.sync_if_rebuilt(conversation_id);
                    (entry.db_cursor, true)
                }
                None => (after_sequence, false),
            }
        };

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

        // Handle the reset case: if the client's cursor is behind the projector's
        // and there are no new events, the projector may have been invalidated
        // (e.g., truncation). Drop it and re-read from the client's position.
        if new_records.is_empty()
            && has_projector
            && after_sequence < publish_after
            && let Ok(max_seq) =
                ConversationEventRecord::max_sequence(&self.pool, conversation_id).await
            && max_seq < publish_after
        {
            self.projectors.lock().await.remove(&conversation_id);
            publish_after = after_sequence;
            has_projector = false;
            new_records = match ConversationEventRecord::events_since(
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
        }

        // If still nothing, the event was already covered by the projector.
        if new_records.is_empty() && record.sequence > publish_after {
            // Edge case: the record is newer than our cursor but events_since
            // returned nothing (transaction not yet visible). Include it directly.
            new_records.push(record.clone());
        }
        if new_records.is_empty() {
            return;
        }

        // Extract session-control state carried in the batch (not timeline rows).
        let control = extract_session_control_state(&new_records);

        let queue_changed = new_records
            .iter()
            .any(|item| item.event_kind == "conversation_input");

        // Load a fresh projector if we don't have one yet.
        let loaded_projector = if !has_projector {
            match IncrementalRowProjector::load(&self.pool, conversation_id, publish_after).await {
                Ok(projector) => Some(CachedRowProjector::new(projector)),
                Err(error) => {
                    tracing::warn!(%conversation_id, %error, "row-op emit: projector load failed");
                    return;
                }
            }
        } else {
            None
        };

        // Fold the new records into row ops.
        let mut ops = Vec::new();
        let should_emit = {
            let mut map = self.projectors.lock().await;
            if let Some(projector) = loaded_projector {
                map.entry(conversation_id).or_insert(projector);
            }
            let entry = map
                .get_mut(&conversation_id)
                .expect("projector present after insert");
            entry.touch();
            let previous_sequence = entry.last_emitted_sequence;
            for item in &new_records {
                match entry.apply_persisted(item) {
                    Ok(Some(record_ops)) => {
                        extend_coalesced_row_ops(&mut ops, record_ops)
                    }
                    Ok(None) => {}
                    Err(error) => {
                        tracing::warn!(sequence = item.sequence, %error, "row-op emit: fold failed");
                    }
                }
            }
            let last_sequence = entry.db_cursor;
            let will_emit = !ops.is_empty() || !control.is_empty() || queue_changed;
            let result = if will_emit {
                entry.last_emitted_sequence = last_sequence;
                Some((previous_sequence, last_sequence))
            } else {
                None
            };
            evict_least_recently_used_projectors(&mut map, conversation_id);
            self.prune_conversation_locks(&map);
            result
        };

        // Emit the batch if we have anything worth sending.
        if let Some((previous_sequence, last_sequence)) = should_emit {
            let emit_global =
                should_emit_global(&ops, &control, queue_changed);
            let batch = ConversationRowOpBatch {
                conversation_id,
                last_sequence,
                previous_sequence: Some(previous_sequence),
                ops,
                session_modes: control.session_modes,
                session_config_options: control.session_config_options,
                available_commands: control.available_commands,
                session_goal: control.session_goal,
                async_tasks: control.async_tasks,
                prompt_suggestion: control.prompt_suggestion,
            };
            self.sink.emit_conversation_batch(conversation_id, &batch);
            if emit_global {
                self.sink.emit_global_batch(&batch);
            }
        }

        // Check for workbench-affecting events and notify if needed.
        if is_workbench_changed(&new_records) {
            if let Ok(Some(session)) = Session::find_by_id(&self.pool, conversation_id).await {
                self.sink.emit_workspaces_sessions_changed(WorkspaceSessionsChanged {
                    workspace_id: session.workspace_id,
                    conversation_id,
                });
            }
        }
    }

    /// Fold one transcript delta that was not inserted into `conversation_events`.
    ///
    /// The database cursor stays put, and the batch reports `last_emitted_sequence`
    /// for both `previous_sequence` and `last_sequence` so empty persisted records
    /// never cause a sequence gap.
    pub async fn publish_unpersisted(&self, record: &ConversationEventRecord) {
        let conversation_id = record.conversation_id;
        let conv_lock = self.conversation_lock(conversation_id);
        let _conv_guard = conv_lock.lock().await;

        let has_projector = self.projectors.lock().await.contains_key(&conversation_id);
        let loaded_projector = if !has_projector {
            match IncrementalRowProjector::load_through_latest(&self.pool, conversation_id).await {
                Ok(projector) => Some(CachedRowProjector::new(projector)),
                Err(error) => {
                    tracing::warn!(%conversation_id, %error, "row-op emit: projector load failed");
                    return;
                }
            }
        } else {
            None
        };

        let (cursor, ops) = {
            let mut map = self.projectors.lock().await;
            if let Some(projector) = loaded_projector {
                map.entry(conversation_id).or_insert(projector);
            }
            let entry = map
                .get_mut(&conversation_id)
                .expect("projector present after insert");
            entry.touch();
            let cursor = entry.last_emitted_sequence;
            let record_ops = match entry.apply_unpersisted(record) {
                Ok(ops) => ops,
                Err(error) => {
                    tracing::warn!(%error, "row-op emit: unpersisted fold failed");
                    return;
                }
            };
            let mut ops = Vec::new();
            extend_coalesced_row_ops(&mut ops, record_ops);
            evict_least_recently_used_projectors(&mut map, conversation_id);
            self.prune_conversation_locks(&map);
            (cursor, ops)
        };

        let mut prompt_suggestion = None;
        if let Ok(ConversationEvent::PromptSuggestionUpdated { suggestion }) =
            serde_json::from_str::<ConversationEvent>(&record.normalized_json)
        {
            prompt_suggestion = Some(ConversationPromptSuggestion { suggestion });
        }

        if ops.is_empty() && prompt_suggestion.is_none() {
            return;
        }

        let emit_global = prompt_suggestion.is_some();
        let batch = ConversationRowOpBatch {
            conversation_id,
            last_sequence: cursor,
            previous_sequence: Some(cursor),
            ops,
            session_modes: None,
            session_config_options: None,
            available_commands: None,
            session_goal: None,
            async_tasks: None,
            prompt_suggestion,
        };
        self.sink.emit_conversation_batch(conversation_id, &batch);
        if emit_global {
            self.sink.emit_global_batch(&batch);
        }
    }
}

/// Extract session-control state from a batch of event records.
///
/// These are not timeline rows — they ride along in the batch so the frontend
/// can update session metadata without a separate channel.
fn extract_session_control_state(
    records: &[ConversationEventRecord],
) -> SessionControlState {
    let mut state = SessionControlState::default();

    for record in records {
        if let Ok(event) = serde_json::from_str::<ConversationEvent>(&record.normalized_json) {
            match event {
                ConversationEvent::SessionModeUpdated { current, modes } => {
                    state.session_modes = Some(ConversationSessionModes { current, modes });
                }
                ConversationEvent::SessionConfigOptionsUpdated { options } => {
                    state.session_config_options = Some(options);
                }
                ConversationEvent::AvailableCommandsUpdated { commands } => {
                    state.available_commands = Some(commands);
                }
                ConversationEvent::SessionGoalUpdated { goal, actions } => {
                    state.session_goal = Some(ConversationSessionGoal { goal, actions });
                }
                ConversationEvent::AsyncTasksUpdated { tasks } => {
                    state.async_tasks = Some(tasks);
                }
                ConversationEvent::PromptSuggestionUpdated { suggestion } => {
                    state.prompt_suggestion = Some(ConversationPromptSuggestion { suggestion });
                }
                _ => {}
            }
        }
    }

    state
}

/// Session-control state extracted from a batch of events. Not timeline rows.
#[derive(Default)]
struct SessionControlState {
    session_modes: Option<ConversationSessionModes>,
    session_config_options: Option<Vec<agents::AgentSessionConfigOption>>,
    available_commands: Option<Vec<agents::AgentAvailableCommand>>,
    session_goal: Option<ConversationSessionGoal>,
    async_tasks: Option<Vec<agents::AsyncTaskRecord>>,
    prompt_suggestion: Option<ConversationPromptSuggestion>,
}

impl SessionControlState {
    fn is_empty(&self) -> bool {
        self.session_modes.is_none()
            && self.session_config_options.is_none()
            && self.available_commands.is_none()
            && self.session_goal.is_none()
            && self.async_tasks.is_none()
            && self.prompt_suggestion.is_none()
    }
}

/// Whether a batch should be emitted on the global channel (not just the per-conversation one).
///
/// Append-text-only batches stay on the per-conversation channel — the global fan-out
/// is expensive and UI panels that need it (session list) don't render streaming text.
fn should_emit_global(
    ops: &[ConversationRowOp],
    control: &SessionControlState,
    queue_changed: bool,
) -> bool {
    !ops.iter().all(|op| matches!(op, ConversationRowOp::AppendText { .. }))
        || !control.is_empty()
        || queue_changed
}

/// Event kinds that affect the workbench (session list, turn state indicators).
const WORKBENCH_EVENT_KINDS: &[&str] = &[
    "user_turn_queued",
    "user_turn_started",
    "turn_blocked",
    "turn_completed",
    "turn_failed",
    "turn_cancelled",
    "turn_interrupted",
    "conversation_input",
    "user_turn_created",
];

/// Check if any record in the batch affects the workbench.
fn is_workbench_changed(records: &[ConversationEventRecord]) -> bool {
    records.iter().any(|record| {
        WORKBENCH_EVENT_KINDS.contains(&record.event_kind.as_str())
    })
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;
    use std::sync::Arc;

    use agents::conversation::{
        ConversationEvent, ConversationInputBlock, ConversationRowOpBatch,
    };
    use db::models::{
        conversation_event::{AppendConversationEvent, ConversationEventRecord},
        conversation_turn::{ConversationTurnRecord, CreateConversationTurn},
    };
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use uuid::Uuid;

    use super::{ConversationEventSink, ConversationLivePipeline, WorkspaceSessionsChanged};
    use crate::ConversationRowProjectors;

    /// Test sink that captures emitted batches for assertion.
    struct CapturingSink {
        batches: Arc<std::sync::Mutex<Vec<(String, ConversationRowOpBatch)>>>,
        workbench: Arc<std::sync::Mutex<Vec<WorkspaceSessionsChanged>>>,
    }

    impl CapturingSink {
        fn new() -> (Self, Arc<std::sync::Mutex<Vec<(String, ConversationRowOpBatch)>>>, Arc<std::sync::Mutex<Vec<WorkspaceSessionsChanged>>>) {
            let batches = Arc::new(std::sync::Mutex::new(Vec::new()));
            let workbench = Arc::new(std::sync::Mutex::new(Vec::new()));
            (
                Self {
                    batches: batches.clone(),
                    workbench: workbench.clone(),
                },
                batches,
                workbench,
            )
        }
    }

    impl ConversationEventSink for CapturingSink {
        fn emit_conversation_batch(&self, conversation_id: Uuid, batch: &ConversationRowOpBatch) {
            self.batches.lock().unwrap().push((
                format!("conversation-events:{conversation_id}"),
                batch.clone(),
            ));
        }

        fn emit_global_batch(&self, batch: &ConversationRowOpBatch) {
            self.batches
                .lock()
                .unwrap()
                .push(("conversation-events".to_string(), batch.clone()));
        }

        fn emit_workspaces_sessions_changed(&self, payload: WorkspaceSessionsChanged) {
            self.workbench.lock().unwrap().push(payload);
        }
    }

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
    async fn unified_pipeline_previous_sequence_tracks_last_emitted_sequence() {
        let pool = test_pool().await;
        let projectors = ConversationRowProjectors::default();
        let (sink, batches, _workbench) = CapturingSink::new();
        let pipeline = ConversationLivePipeline::new(
            pool.clone(),
            projectors,
            Arc::new(sink),
        );

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

        // First event: user_turn_created
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
        pipeline.publish(&rec1).await;

        let captured = batches.lock().unwrap().clone();
        let first_batches: Vec<_> = captured
            .iter()
            .filter(|(ch, _)| ch == &channel)
            .collect();
        assert_eq!(first_batches.len(), 1);
        assert_eq!(first_batches[0].1.previous_sequence, Some(0));
        assert_eq!(first_batches[0].1.last_sequence, 1);

        // Second event: raw_diagnostic_recorded (no row ops, should not emit)
        batches.lock().unwrap().clear();
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
        pipeline.publish(&rec2).await;

        let captured = batches.lock().unwrap().clone();
        let per_conv: Vec<_> = captured
            .iter()
            .filter(|(ch, _)| ch == &channel)
            .collect();
        assert!(
            per_conv.is_empty(),
            "empty ops record must not emit batch"
        );

        // Third event: unpersisted assistant_text_delta
        batches.lock().unwrap().clear();
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
        pipeline.publish_unpersisted(&unpersisted).await;

        let captured = batches.lock().unwrap().clone();
        let unpersisted_batches: Vec<_> = captured
            .iter()
            .filter(|(ch, _)| ch == &channel)
            .collect();
        assert_eq!(unpersisted_batches.len(), 1);
        assert_eq!(
            unpersisted_batches[0].1.previous_sequence,
            Some(unpersisted_batches[0].1.last_sequence)
        );
        assert_eq!(unpersisted_batches[0].1.last_sequence, 1);

        // Fourth event: turn_completed
        batches.lock().unwrap().clear();
        let rec3 = append_event(
            &pool,
            conversation_id,
            turn_id,
            "turn_completed",
            &ConversationEvent::TurnCompleted { stop_reason: None },
        )
        .await;
        pipeline.publish(&rec3).await;

        let captured = batches.lock().unwrap().clone();
        let final_batches: Vec<_> = captured
            .iter()
            .filter(|(ch, _)| ch == &channel)
            .collect();
        assert_eq!(final_batches.len(), 1);
        assert_eq!(
            final_batches[0].1.previous_sequence,
            Some(1) // Last emitted was 1 (from unpersisted)
        );
        assert_eq!(final_batches[0].1.last_sequence, 3);
    }

    #[test]
    fn should_emit_global_filters_append_text_only_batches() {
        use agents::conversation::{
            ConversationRowOp, ConversationSessionNotice, ConversationTimelineRow, TimelineRow,
            TimelineTextStream,
        };

        let empty = super::SessionControlState::default();
        let mut with_modes = super::SessionControlState::default();
        with_modes.session_modes = Some(agents::conversation::ConversationSessionModes {
            current: None,
            modes: Vec::new(),
        });

        // AppendText-only should not emit global
        let append_ops = vec![ConversationRowOp::AppendText {
            row_id: "test".to_string(),
            revision: 1,
            stream: TimelineTextStream::Text,
            delta: "hello".to_string(),
        }];
        assert!(!super::should_emit_global(&append_ops, &empty, false));

        // Upsert should emit global
        let upsert_ops = vec![ConversationRowOp::Upsert {
            row: TimelineRow {
                row_id: "test".to_string(),
                revision: 2,
                row: ConversationTimelineRow::SessionNotice {
                    notice: ConversationSessionNotice {
                        title: "Notice".to_string(),
                        severity: "info".to_string(),
                        ..Default::default()
                    },
                },
            },
        }];
        assert!(super::should_emit_global(&upsert_ops, &empty, false));

        // AppendText + session_modes should emit global
        assert!(super::should_emit_global(&append_ops, &with_modes, false));

        // Empty ops + queue_changed should emit global
        assert!(super::should_emit_global(&[], &empty, true));
    }

    #[test]
    fn is_workbench_changed_detects_turn_events() {
        let make_record = |kind: &str| ConversationEventRecord {
            id: Uuid::new_v4(),
            conversation_id: Uuid::new_v4(),
            turn_id: None,
            binding_id: None,
            connection_id: None,
            prompt_id: None,
            sequence: 1,
            source: "acp".to_string(),
            event_kind: kind.to_string(),
            event_version: 1,
            normalized_json: "{}".to_string(),
            raw_json: None,
            idempotency_key: None,
            created_at: chrono::Utc::now(),
        };

        // Workbench events
        for kind in [
            "user_turn_queued",
            "user_turn_started",
            "turn_completed",
            "turn_failed",
        ] {
            assert!(
                super::is_workbench_changed(&[make_record(kind)]),
                "{kind} should be workbench-affecting"
            );
        }

        // Non-workbench events
        for kind in ["assistant_text_delta", "tool_call_upsert", "raw_diagnostic_recorded"] {
            assert!(
                !super::is_workbench_changed(&[make_record(kind)]),
                "{kind} should not be workbench-affecting"
            );
        }
    }
}
