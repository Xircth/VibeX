use std::{collections::HashMap, sync::Arc};

use agents::{
    AgentConnectionStatus, AgentContentBlock, AgentEvent, AgentEventEnvelope,
    conversation::{
        ConversationAgentConnectionStatus, ConversationDelegation, ConversationDelegationResult,
        ConversationError, ConversationEvent, ConversationEventEnvelope, ConversationFileLocation,
        ConversationPermissionRequest, ConversationPermissionResponse, ConversationPlanEntry,
        ConversationQuestionRequest, ConversationQuestionResponse, ConversationRowOpBatch,
        ConversationSessionModes, ConversationTerminalPatch, ConversationToolCallPatch,
        ConversationUsage,
    },
    terminal::{AgentTerminalLifecycleEvent, agent_terminal_registry},
};
use conversations::{ConversationEventAppender, IncrementalRowProjector};
use db::models::{
    conversation_event::{AppendConversationEvent, ConversationEventRecord},
    workspace::Workspace,
};
use deployment::Deployment;
use futures::StreamExt;
use serde::Serialize;
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter};
use tokio::{
    sync::Mutex,
    time::{self, Duration, MissedTickBehavior},
};
use uuid::Uuid;

use crate::state::AppState;

pub mod channels {
    pub const GLOBAL_EVENTS: &str = "global-events";
    pub const AGENT_EVENTS: &str = "agent-events";
    pub const CONVERSATION_EVENTS: &str = "conversation-events";
    pub const AGENT_TERMINAL_EVENTS: &str = "agent-terminal-events";
}

/// Per-conversation cache of live incremental projectors (消灭双投影). Held on
/// `AppState`; fed only through [`emit_conversation_row_ops_after`].
pub type ConversationRowProjectors = Arc<Mutex<HashMap<Uuid, IncrementalRowProjector>>>;

/// Emit the frontend row-op batch for every event appended after `after_sequence`.
/// This is the single realtime path to the frontend (消灭双投影): the frontend consumes
/// `ConversationRowOpBatch` and never folds raw events. It feeds the conversation's
/// cached incremental projector so ops are produced in O(1) amortized (no per-frame
/// re-projection). Best-effort — a dropped batch is self-healed by the hook's
/// subscribe-time row backfill (`rows_since`) and by a full reload (`conversation_detail`),
/// both of which reproject from the same fold. There is no sequence-gap detection during
/// streaming, so a batch lost mid-turn only surfaces on the next reload/backfill.
pub async fn emit_conversation_row_ops_after(
    app: &AppHandle,
    projectors: &ConversationRowProjectors,
    pool: &SqlitePool,
    conversation_id: Uuid,
    after_sequence: i64,
) {
    let new_records =
        match ConversationEventRecord::events_since(pool, conversation_id, after_sequence, 2000)
            .await
        {
            Ok(records) => records,
            Err(error) => {
                tracing::warn!(%conversation_id, %error, "row-op emit: reading events failed");
                return;
            }
        };
    if new_records.is_empty() {
        return;
    }
    let last_sequence = new_records
        .last()
        .map(|record| record.sequence)
        .unwrap_or(after_sequence);

    // Session control state (modes / config options) is not a timeline row, so carry
    // the latest of each in the batch rather than on a separate channel. Also detect
    // whether the batch settles a turn — the projector is a pure cache and can be
    // dropped once its turn is terminal. Parsed here (no projector needed) so the lock
    // below is held only around the fold + emit.
    let mut session_modes = None;
    let mut session_config_options = None;
    let mut settled = false;
    for record in &new_records {
        if matches!(
            record.event_kind.as_str(),
            "turn_completed" | "turn_failed" | "turn_cancelled" | "turn_interrupted"
        ) {
            settled = true;
        }
        if let Ok(event) = serde_json::from_str::<ConversationEvent>(&record.normalized_json) {
            match event {
                ConversationEvent::SessionModeUpdated { current, modes } => {
                    session_modes = Some(ConversationSessionModes { current, modes });
                }
                ConversationEvent::SessionConfigOptionsUpdated { options } => {
                    session_config_options = Some(options);
                }
                _ => {}
            }
        }
    }

    // The projector lock is held across BOTH the fold and the `app.emit`. Emitting under
    // the lock makes realtime delivery order match fold order: two emitters racing for one
    // conversation are serialized here, so a later fold can never enqueue its batch ahead
    // of an earlier one. Emitting after releasing the lock allowed exactly that reorder —
    // a late-delivered older batch would rewind/duplicate streamed text (the append-only
    // liveText overlay is order-sensitive). `app.emit` is a cheap synchronous enqueue.
    let mut map = projectors.lock().await;
    // (Re)position the projector at `after_sequence` when it is missing or out of sync
    // (first activation, a settled-turn eviction, or a truncate/retry rewind).
    let needs_load = map
        .get(&conversation_id)
        .map(|projector| projector.last_sequence() != after_sequence)
        .unwrap_or(true);
    if needs_load {
        match IncrementalRowProjector::load(pool, conversation_id, after_sequence).await {
            Ok(projector) => {
                map.insert(conversation_id, projector);
            }
            Err(error) => {
                tracing::warn!(%conversation_id, %error, "row-op emit: projector load failed");
                return;
            }
        }
    }
    let mut ops = Vec::new();
    {
        let projector = map.get_mut(&conversation_id).expect("projector present");
        for record in &new_records {
            match projector.apply(record) {
                Ok(record_ops) => ops.extend(record_ops),
                Err(error) => {
                    tracing::warn!(sequence = record.sequence, %error, "row-op emit: fold failed")
                }
            }
        }
    }

    if !(ops.is_empty() && session_modes.is_none() && session_config_options.is_none()) {
        let batch = ConversationRowOpBatch {
            conversation_id,
            last_sequence,
            ops,
            session_modes,
            session_config_options,
        };
        if let Err(error) = app.emit(channels::CONVERSATION_EVENTS, &batch) {
            tracing::warn!(%conversation_id, %error, "failed to emit conversation row ops");
        }
    }

    // A settled turn's projector holds the whole folded timeline but is a pure cache —
    // drop it to bound memory. The next event for this conversation reloads it via the
    // `needs_load` path above. Without this, one projector leaked per conversation ever
    // streamed (the map is only otherwise cleared by `close_conversation`, which the UI
    // never calls). Done under the lock, after emit.
    if settled {
        map.remove(&conversation_id);
    }
}

/// How often pending streaming text/reasoning deltas are flushed to the DB and
/// the frontend. Kept small so the conversation renders token-by-token in near
/// real time. The coalescer still merges the deltas that land inside one window,
/// so each flush is a single append (`BEGIN IMMEDIATE` + projection fold), not
/// one write transaction per token — persisting every token individually would
/// storm the SQLite write lock on fast agents.
const CONVERSATION_STREAM_FLUSH_INTERVAL: Duration = Duration::from_millis(8);

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentTerminalSource {
    Acp,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentTerminalUiEvent {
    Created {
        source: AgentTerminalSource,
        session_id: Uuid,
        workspace_id: Option<Uuid>,
        title: String,
        command: String,
        cwd: Option<String>,
    },
    Released {
        source: AgentTerminalSource,
        session_id: Uuid,
        workspace_id: Option<Uuid>,
    },
}

/// Start forwarding global events from EventService to Tauri Events.
/// Called during app setup, after AppState is initialized.
pub fn start_event_forwarding(app: &AppHandle, state: &AppState) {
    let app_handle = app.clone();
    let msg_store = state.deployment.events().msg_store().clone();

    tauri::async_runtime::spawn(async move {
        let mut stream = msg_store.history_plus_stream();
        while let Some(result) = stream.next().await {
            match result {
                Ok(msg) => {
                    if app_handle.emit(channels::GLOBAL_EVENTS, &msg).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
}

pub fn start_agent_event_forwarding(app: &AppHandle, state: &AppState) {
    let app_handle = app.clone();
    let conversation_pool = state.deployment.db().pool.clone();
    let deployment = state.deployment.clone();
    let projectors = state.conversation_row_projectors.clone();
    let mut agent_events = state.agent_runtime.subscribe_events();

    tauri::async_runtime::spawn(async move {
        let mut coalescer = ConversationEventCoalescer::default();
        let mut active_turn_cache: HashMap<Uuid, Option<Uuid>> = HashMap::new();
        let mut flush_interval = time::interval(CONVERSATION_STREAM_FLUSH_INTERVAL);
        flush_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

        loop {
            tokio::select! {
                _ = flush_interval.tick() => {
                    if !flush_pending_conversation_events(
                        &conversation_pool,
                        deployment.as_ref(),
                        &app_handle,
                        &projectors,
                        &mut coalescer,
                    )
                    .await
                    {
                        break;
                    }
                }
                received = agent_events.recv() => {
                    match received {
                        Ok(event) => {
                            match map_conversation_event_record(
                                &conversation_pool,
                                &event,
                                &mut active_turn_cache,
                            )
                            .await
                            {
                                Ok(Some(record)) => {
                                    let ready_events = coalescer.push(record);
                                    if !append_and_emit_conversation_events(
                                        &conversation_pool,
                                        deployment.as_ref(),
                                        &app_handle,
                                        &projectors,
                                        ready_events,
                                    )
                                    .await
                                    {
                                        break;
                                    }
                                }
                                Ok(None) => {}
                                Err(error) => {
                                    tracing::warn!(
                                        sequence = event.sequence,
                                        error = %error,
                                        "Failed to map conversation event"
                                    );
                                }
                            }
                            if should_emit_agent_event(&event.event)
                                && app_handle.emit(channels::AGENT_EVENTS, &event).is_err()
                            {
                                break;
                            }
                            if is_terminal_agent_event(&event.event)
                                && let Some(session_id) = event.session_id
                            {
                                active_turn_cache.remove(&session_id.0);
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                            let _ = flush_pending_conversation_events(
                                &conversation_pool,
                                deployment.as_ref(),
                                &app_handle,
                                &projectors,
                                &mut coalescer,
                            )
                            .await;
                            break;
                        }
                    }
                }
            }
        }
    });
}

fn is_terminal_conversation_event(event: &ConversationEvent) -> bool {
    matches!(
        event,
        ConversationEvent::TurnCompleted { .. }
            | ConversationEvent::TurnFailed { .. }
            | ConversationEvent::TurnCancelled { .. }
    )
}

fn is_terminal_agent_event(event: &AgentEvent) -> bool {
    matches!(
        event,
        AgentEvent::TurnCompleted { .. }
            | AgentEvent::PromptFinished { .. }
            | AgentEvent::Error { .. }
    )
}

#[derive(Debug, Clone)]
struct MappedConversationEventRecord {
    conversation_id: Uuid,
    turn_id: Option<Uuid>,
    connection_id: String,
    source: &'static str,
    event_kind: String,
    event: ConversationEvent,
    raw_json: String,
    idempotency_key: String,
    first_agent_sequence: i64,
    last_agent_sequence: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CoalescedDeltaKind {
    AssistantText,
    AssistantReasoning,
}

#[derive(Debug, Clone)]
struct PendingConversationDelta {
    base: MappedConversationEventRecord,
    kind: CoalescedDeltaKind,
    text: String,
    message_id: Option<String>,
    chunk_count: usize,
}

#[derive(Debug, Default)]
struct ConversationEventCoalescer {
    pending: Option<PendingConversationDelta>,
}

impl ConversationEventCoalescer {
    fn push(
        &mut self,
        record: MappedConversationEventRecord,
    ) -> Vec<MappedConversationEventRecord> {
        match streaming_delta_parts(&record.event) {
            Some((kind, text, message_id)) => self.push_delta(record, kind, text, message_id),
            None => {
                let mut ready = self.flush();
                ready.push(record);
                ready
            }
        }
    }

    fn flush(&mut self) -> Vec<MappedConversationEventRecord> {
        self.pending
            .take()
            .map(PendingConversationDelta::into_record)
            .into_iter()
            .collect()
    }

    fn push_delta(
        &mut self,
        record: MappedConversationEventRecord,
        kind: CoalescedDeltaKind,
        text: String,
        message_id: Option<String>,
    ) -> Vec<MappedConversationEventRecord> {
        if let Some(pending) = &mut self.pending
            && pending.can_merge(&record, kind, &message_id)
        {
            pending.text.push_str(&text);
            pending.base.last_agent_sequence = record.last_agent_sequence;
            pending.chunk_count += 1;
            return Vec::new();
        }

        let ready = self.flush();
        self.pending = Some(PendingConversationDelta {
            base: record,
            kind,
            text,
            message_id,
            chunk_count: 1,
        });
        ready
    }
}

impl PendingConversationDelta {
    fn can_merge(
        &self,
        record: &MappedConversationEventRecord,
        kind: CoalescedDeltaKind,
        message_id: &Option<String>,
    ) -> bool {
        self.kind == kind
            && self.base.conversation_id == record.conversation_id
            && self.base.turn_id == record.turn_id
            && self.base.connection_id == record.connection_id
            && self.base.source == record.source
            && &self.message_id == message_id
    }

    fn into_record(mut self) -> MappedConversationEventRecord {
        self.base.event = match self.kind {
            CoalescedDeltaKind::AssistantText => ConversationEvent::AssistantTextDelta {
                text: self.text,
                message_id: self.message_id,
            },
            CoalescedDeltaKind::AssistantReasoning => ConversationEvent::AssistantReasoningDelta {
                text: self.text,
                message_id: self.message_id,
            },
        };
        self.base.event_kind = conversation_event_kind(&self.base.event);
        self.base.idempotency_key = format!(
            "agent:{}-{}:{}",
            self.base.first_agent_sequence, self.base.last_agent_sequence, self.base.event_kind
        );
        self.base.raw_json = serde_json::json!({
            "coalesced": true,
            "first_sequence": self.base.first_agent_sequence,
            "last_sequence": self.base.last_agent_sequence,
            "chunk_count": self.chunk_count,
            "kind": self.base.event_kind,
        })
        .to_string();
        self.base
    }
}

fn streaming_delta_parts(
    event: &ConversationEvent,
) -> Option<(CoalescedDeltaKind, String, Option<String>)> {
    match event {
        ConversationEvent::AssistantTextDelta { text, message_id } => Some((
            CoalescedDeltaKind::AssistantText,
            text.clone(),
            message_id.clone(),
        )),
        ConversationEvent::AssistantReasoningDelta { text, message_id } => Some((
            CoalescedDeltaKind::AssistantReasoning,
            text.clone(),
            message_id.clone(),
        )),
        _ => None,
    }
}

async fn map_conversation_event_record(
    pool: &SqlitePool,
    envelope: &AgentEventEnvelope,
    active_turn_cache: &mut HashMap<Uuid, Option<Uuid>>,
) -> Result<Option<MappedConversationEventRecord>, anyhow::Error> {
    let Some(session_id) = envelope.session_id else {
        return Ok(None);
    };

    let conversation_id = session_id.0;
    let turn_id = match active_turn_id_cached(pool, active_turn_cache, conversation_id).await {
        Ok(turn_id) => turn_id,
        Err(sqlx::Error::Database(error)) if error.message().contains("no such table") => {
            return Ok(None);
        }
        Err(error) => return Err(error.into()),
    };
    let Some(event) = map_agent_event_to_conversation_event(envelope, turn_id) else {
        return Ok(None);
    };
    let raw_json = serde_json::to_string(&envelope.event)?;
    let event_kind = conversation_event_kind(&event);
    let idempotency_key = format!("agent:{}:{event_kind}", envelope.sequence);

    if let AgentEvent::SessionLinked { acp_session_id, .. } = &envelope.event
        && let Some(binding_id) = latest_binding_id(pool, conversation_id).await?
    {
        db::models::conversation::ConversationAgentBindingRecord::bind_acp_session(
            pool,
            binding_id,
            acp_session_id,
            None,
            "ready",
        )
        .await?;
    }
    if let AgentEvent::SessionInfoUpdated { patch } = &envelope.event
        && let Some(title) = patch
            .get("title")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|title| !title.is_empty())
    {
        db::models::conversation::DbConversationSummary::backfill_title(
            pool,
            conversation_id,
            title,
        )
        .await?;
    }

    Ok(Some(MappedConversationEventRecord {
        conversation_id,
        turn_id,
        connection_id: envelope.connection_id.to_string(),
        source: conversation_event_source(&envelope.event),
        event_kind,
        event,
        raw_json,
        idempotency_key,
        first_agent_sequence: envelope.sequence,
        last_agent_sequence: envelope.sequence,
    }))
}

async fn flush_pending_conversation_events<D: Deployment + ?Sized>(
    pool: &SqlitePool,
    deployment: &D,
    app_handle: &AppHandle,
    projectors: &ConversationRowProjectors,
    coalescer: &mut ConversationEventCoalescer,
) -> bool {
    append_and_emit_conversation_events(pool, deployment, app_handle, projectors, coalescer.flush())
        .await
}

async fn append_and_emit_conversation_events<D: Deployment + ?Sized>(
    pool: &SqlitePool,
    deployment: &D,
    app_handle: &AppHandle,
    projectors: &ConversationRowProjectors,
    records: Vec<MappedConversationEventRecord>,
) -> bool {
    // First-touched sequence per conversation, so the row-op emit below reads exactly
    // this batch's tail (min - 1) and the cached projector stays in sync.
    let mut touched: HashMap<Uuid, i64> = HashMap::new();
    let mut note_touched = |conversation_id: Uuid, sequence: i64| {
        touched
            .entry(conversation_id)
            .and_modify(|min| *min = (*min).min(sequence))
            .or_insert(sequence);
    };

    for record in records {
        match append_conversation_event_record(pool, record).await {
            Ok(conversation_event) => {
                note_touched(
                    conversation_event.conversation_id,
                    conversation_event.sequence,
                );
                // IM channel delivery still consumes the raw event envelope; only the
                // frontend switched to row ops (emitted after this loop).
                if let Err(error) =
                    crate::commands::chat_channel::notify_conversation_event(&conversation_event)
                        .await
                {
                    tracing::warn!(
                        conversation_id = %conversation_event.conversation_id,
                        sequence = conversation_event.sequence,
                        %error,
                        "Failed to dispatch chat channel conversation event"
                    );
                }
                if is_terminal_conversation_event(&conversation_event.event)
                    && let Some(turn_id) = conversation_event.turn_id
                {
                    match crate::conversation_service::finalize_checkpoint_file_changes(
                        deployment,
                        conversation_event.conversation_id,
                        turn_id,
                    )
                    .await
                    {
                        Ok(Some(file_event)) => {
                            note_touched(file_event.conversation_id, file_event.sequence);
                            if let Err(error) =
                                crate::commands::chat_channel::notify_conversation_event(
                                    &file_event,
                                )
                                .await
                            {
                                tracing::warn!(
                                    conversation_id = %file_event.conversation_id,
                                    sequence = file_event.sequence,
                                    %error,
                                    "Failed to dispatch chat channel file-change event"
                                );
                            }
                        }
                        Ok(None) => {}
                        Err(error) => {
                            tracing::warn!(
                                conversation_id = %conversation_event.conversation_id,
                                turn_id = %turn_id,
                                %error,
                                "Failed to finalize conversation checkpoint diff"
                            );
                        }
                    }
                }
            }
            Err(error) => {
                tracing::warn!(
                    error = %error,
                    "Failed to append and emit conversation event"
                );
            }
        }
    }

    for (conversation_id, min_sequence) in touched {
        emit_conversation_row_ops_after(
            app_handle,
            projectors,
            pool,
            conversation_id,
            min_sequence - 1,
        )
        .await;
    }
    true
}

async fn append_conversation_event_record(
    pool: &SqlitePool,
    record: MappedConversationEventRecord,
) -> Result<ConversationEventEnvelope, anyhow::Error> {
    let normalized_json = serde_json::to_string(&record.event)?;
    let record = ConversationEventAppender::append(
        pool,
        AppendConversationEvent {
            id: Uuid::new_v4(),
            conversation_id: record.conversation_id,
            turn_id: record.turn_id,
            binding_id: None,
            connection_id: Some(&record.connection_id),
            prompt_id: None,
            source: record.source,
            event_kind: &record.event_kind,
            normalized_json: &normalized_json,
            raw_json: Some(&record.raw_json),
            idempotency_key: Some(&record.idempotency_key),
        },
    )
    .await?;

    let event = serde_json::from_str::<ConversationEvent>(&record.normalized_json)?;
    Ok(ConversationEventEnvelope {
        id: record.id,
        conversation_id: record.conversation_id,
        turn_id: record.turn_id,
        sequence: record.sequence,
        source: record.source,
        event,
        created_at: record.created_at,
    })
}

fn conversation_event_kind(event: &ConversationEvent) -> String {
    serde_json::to_value(event)
        .ok()
        .and_then(|value| value["kind"].as_str().map(str::to_string))
        .unwrap_or_else(|| "unknown".to_string())
}

async fn active_turn_id(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Option<Uuid>, sqlx::Error> {
    sqlx::query_scalar::<_, Option<Uuid>>("SELECT active_turn_id FROM sessions WHERE id = ?")
        .bind(conversation_id)
        .fetch_optional(pool)
        .await
        .map(Option::flatten)
}

async fn active_turn_id_cached(
    pool: &SqlitePool,
    cache: &mut HashMap<Uuid, Option<Uuid>>,
    conversation_id: Uuid,
) -> Result<Option<Uuid>, sqlx::Error> {
    if let Some(Some(turn_id)) = cache.get(&conversation_id).copied() {
        return Ok(Some(turn_id));
    }

    let turn_id = active_turn_id(pool, conversation_id).await?;
    // An idle session can become active at any time after recovery/session setup.
    // Caching `None` would make every later agent error look like a binding error
    // instead of the terminal failure for the newly-created turn.
    if turn_id.is_some() {
        cache.insert(conversation_id, turn_id);
    } else {
        cache.remove(&conversation_id);
    }
    Ok(turn_id)
}

async fn latest_binding_id(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Option<Uuid>, sqlx::Error> {
    sqlx::query_scalar(
        r#"SELECT id
           FROM conversation_agent_bindings
           WHERE conversation_id = ?
           ORDER BY created_at DESC
           LIMIT 1"#,
    )
    .bind(conversation_id)
    .fetch_optional(pool)
    .await
}

/// Best-effort revival of a serialized JSON payload: the ACP bridge stringifies
/// rawInput/rawOutput, and downstream consumers need the structured value back.
/// Non-JSON text is preserved as a plain JSON string.
fn parse_json_payload(payload: &str) -> serde_json::Value {
    serde_json::from_str(payload).unwrap_or_else(|_| serde_json::Value::String(payload.to_string()))
}

fn map_agent_event_to_conversation_event(
    envelope: &AgentEventEnvelope,
    turn_id: Option<Uuid>,
) -> Option<ConversationEvent> {
    match &envelope.event {
        AgentEvent::ConnectionStatusChanged { snapshot } => {
            Some(ConversationEvent::AgentConnectionStatusChanged {
                status: match snapshot.status {
                    AgentConnectionStatus::Disconnected => {
                        ConversationAgentConnectionStatus::Closed
                    }
                    AgentConnectionStatus::Connecting => {
                        ConversationAgentConnectionStatus::Connecting
                    }
                    AgentConnectionStatus::Ready => ConversationAgentConnectionStatus::Ready,
                    AgentConnectionStatus::Failed => ConversationAgentConnectionStatus::Error,
                },
            })
        }
        AgentEvent::SessionLinked {
            acp_session_id,
            agent_id: _,
            capabilities,
        } => Some(ConversationEvent::AgentBindingReady {
            acp_session_id: acp_session_id.clone(),
            capabilities: capabilities.clone(),
        }),
        AgentEvent::MessageChunk {
            content: AgentContentBlock::Text { text },
        } => Some(ConversationEvent::AssistantTextDelta {
            text: text.clone(),
            message_id: None,
        }),
        AgentEvent::ThoughtChunk {
            content: AgentContentBlock::Text { text },
        } => Some(ConversationEvent::AssistantReasoningDelta {
            text: text.clone(),
            message_id: None,
        }),
        AgentEvent::ToolCall { tool_call } => Some(ConversationEvent::ToolCallUpsert {
            tool_call: ConversationToolCallPatch {
                tool_call_id: tool_call.id.clone(),
                title: Some(tool_call.title.clone()),
                kind: tool_call.kind.clone(),
                status: Some("running".to_string()),
                // `input_preview` is the agent's rawInput serialized to a JSON
                // string — parse it back so the projection/frontend see the real
                // fields (command/file_path/…), not a `{preview}` wrapper.
                raw_input: tool_call
                    .input_preview
                    .as_ref()
                    .map(|preview| parse_json_payload(preview)),
                raw_output: None,
                raw_output_append: None,
                content: None,
                locations: None,
                metadata: tool_call.meta.clone(),
                images: Vec::new(),
            },
        }),
        AgentEvent::ToolCallUpdate { update } => Some(ConversationEvent::ToolCallUpsert {
            tool_call: ConversationToolCallPatch {
                tool_call_id: update.id.clone(),
                title: None,
                kind: None,
                status: update.status.clone(),
                raw_input: None,
                raw_output: update
                    .content
                    .as_ref()
                    .map(|content| parse_json_payload(content)),
                raw_output_append: update.content.clone(),
                content: update
                    .content
                    .as_ref()
                    .map(|content| serde_json::json!({ "text": content })),
                locations: Some(Vec::<ConversationFileLocation>::new()),
                metadata: update.meta.clone(),
                images: Vec::new(),
            },
        }),
        AgentEvent::Plan { plan } => Some(ConversationEvent::PlanUpdated {
            entries: plan
                .entries
                .iter()
                .enumerate()
                .map(|(index, content)| ConversationPlanEntry {
                    id: format!("plan-{index}"),
                    content: content.clone(),
                    status: "pending".to_string(),
                    priority: None,
                })
                .collect(),
        }),
        AgentEvent::Usage { usage } => Some(ConversationEvent::UsageUpdated {
            usage: ConversationUsage {
                input_tokens: usage.used,
                output_tokens: 0,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
                // Preserve the agent-reported context-window size (ACP usage
                // `size`) so the composer can show a real usage ratio.
                context_window_max: usage.limit,
                cost_amount: usage.cost_amount,
                cost_currency: usage.cost_currency.clone(),
            },
        }),
        AgentEvent::SessionModes { modes, current } => {
            Some(ConversationEvent::SessionModeUpdated {
                current: current.clone(),
                modes: modes.clone(),
            })
        }
        AgentEvent::SessionConfigOptions { options } => {
            Some(ConversationEvent::SessionConfigOptionsUpdated {
                options: options.clone(),
            })
        }
        AgentEvent::AvailableCommands { commands } => {
            Some(ConversationEvent::AvailableCommandsUpdated {
                commands: commands.clone(),
            })
        }
        AgentEvent::SessionInfoUpdated { patch } => {
            Some(ConversationEvent::AgentSessionInfoUpdated {
                patch: patch.clone(),
            })
        }
        AgentEvent::SessionLoadFailed { reason } => {
            // The reason is already classified from the agent's real ACP error
            // code (ResourceNotFound / AuthRequired / Unsupported / Other) — pass
            // it through verbatim so the UI can offer the right recovery.
            Some(ConversationEvent::AgentBindingLoadFailed {
                reason: reason.clone(),
            })
        }
        AgentEvent::TurnCompleted { stop_reason }
        | AgentEvent::PromptFinished {
            finished: agents::AgentPromptFinished { stop_reason, .. },
        } => Some(ConversationEvent::TurnCompleted {
            stop_reason: stop_reason.clone(),
        }),
        AgentEvent::SessionConfigStale { reason } => Some(ConversationEvent::SessionConfigStale {
            stale: true,
            reason: reason.clone(),
        }),
        AgentEvent::PermissionRequested { request } => {
            Some(ConversationEvent::PermissionRequested {
                request: ConversationPermissionRequest {
                    permission_id: request.id.to_string(),
                    request: request.clone(),
                },
            })
        }
        AgentEvent::PermissionResponded {
            permission_id,
            response,
            auto,
        } => Some(ConversationEvent::PermissionResponded {
            permission_id: permission_id.to_string(),
            response: ConversationPermissionResponse {
                response: response.clone(),
                auto: *auto,
            },
        }),
        AgentEvent::ElicitationRequested { request } => {
            Some(ConversationEvent::QuestionRequested {
                request: ConversationQuestionRequest {
                    question_id: request.id.to_string(),
                    prompt: request.message.clone(),
                    options: Vec::new(),
                    schema: Some(request.requested_schema.clone()),
                },
            })
        }
        AgentEvent::ElicitationResponded {
            elicitation_id,
            response,
        } => Some(ConversationEvent::QuestionResponded {
            question_id: elicitation_id.to_string(),
            response: ConversationQuestionResponse {
                answer: response.summary(),
                content: match response {
                    agents::AgentElicitationResponse::Accept { content } => Some(content.clone()),
                    _ => None,
                },
            },
        }),
        AgentEvent::TerminalCreated { terminal } => Some(ConversationEvent::TerminalUpdated {
            terminal: ConversationTerminalPatch {
                terminal_id: terminal.id.to_string(),
                command: Some(terminal.command.clone()),
                args: terminal.args.clone(),
                cwd: terminal.cwd.clone(),
                status: "created".to_string(),
                output_summary: None,
                output_truncated: false,
                exit_status: None,
            },
        }),
        AgentEvent::TerminalOutput { output } => Some(ConversationEvent::TerminalUpdated {
            terminal: ConversationTerminalPatch {
                terminal_id: output.terminal_id.to_string(),
                command: None,
                args: Vec::new(),
                cwd: None,
                status: if output.exit_status.is_some() {
                    "exited".to_string()
                } else {
                    "running".to_string()
                },
                output_summary: Some(output.output.clone()),
                output_truncated: output.truncated,
                exit_status: output
                    .exit_status
                    .map(|code| serde_json::json!({ "code": code })),
            },
        }),
        AgentEvent::DelegationStarted {
            parent_tool_use_id,
            child_session_id,
            agent_id,
            task_preview,
        } => Some(ConversationEvent::DelegationStarted {
            delegation: ConversationDelegation {
                delegation_id: format!("delegation-{child_session_id}"),
                parent_tool_call_id: parent_tool_use_id.clone(),
                child_conversation_id: *child_session_id,
                agent_id: agent_id.clone(),
                task_preview: task_preview.clone(),
            },
        }),
        AgentEvent::DelegationCompleted {
            parent_tool_use_id: _,
            child_session_id,
            result,
            ..
        } => Some(ConversationEvent::DelegationCompleted {
            delegation_id: format!("delegation-{child_session_id}"),
            result: match result {
                agents::DelegationResultSummary::Ok {
                    duration_ms,
                    text_preview,
                } => ConversationDelegationResult::Ok {
                    duration_ms: *duration_ms,
                    text_preview: text_preview.clone(),
                },
                agents::DelegationResultSummary::Err { error_code } => {
                    ConversationDelegationResult::Err {
                        error: ConversationError {
                            message: error_code.clone(),
                            code: Some(error_code.clone()),
                            raw: None,
                        },
                    }
                }
            },
        }),
        AgentEvent::Error { error } => Some(if turn_id.is_some() {
            ConversationEvent::TurnFailed {
                error: ConversationError {
                    message: error.message.clone(),
                    // Carry the agent's real ACP error code so the error card can
                    // distinguish auth / expired-session / cancelled / model issues.
                    code: error.code.clone(),
                    raw: error.raw.clone(),
                },
            }
        } else {
            ConversationEvent::AgentBindingRecoveryFailed {
                reason: error.message.clone(),
            }
        }),
        // Raw ACP diagnostics are a high-frequency escape hatch for unhandled
        // protocol notifications. They are useful for debug logs, not product
        // conversation history; persisting every one can starve the SQLite pool.
        AgentEvent::RawAcpDiagnostic { .. } => None,
        AgentEvent::MessageChunk { .. } | AgentEvent::ThoughtChunk { .. } => None,
        AgentEvent::SessionCreated { .. }
        | AgentEvent::PromptStarted { .. }
        | AgentEvent::ModeChanged { .. }
        | AgentEvent::ConfigChanged { .. } => None,
    }
}

fn conversation_event_source(event: &AgentEvent) -> &'static str {
    match event {
        AgentEvent::PermissionRequested { .. }
        | AgentEvent::PermissionResponded { .. }
        | AgentEvent::ElicitationRequested { .. }
        | AgentEvent::ElicitationResponded { .. }
        | AgentEvent::TerminalCreated { .. }
        | AgentEvent::TerminalOutput { .. } => "host",
        AgentEvent::MessageChunk { .. }
        | AgentEvent::ThoughtChunk { .. }
        | AgentEvent::ToolCall { .. }
        | AgentEvent::ToolCallUpdate { .. }
        | AgentEvent::Plan { .. }
        | AgentEvent::Usage { .. }
        | AgentEvent::SessionInfoUpdated { .. }
        | AgentEvent::TurnCompleted { .. }
        | AgentEvent::PromptFinished { .. } => "acp",
        _ => "runtime",
    }
}

/// Whether an event is worth forwarding to the live `AGENT_EVENTS` Tauri channel
/// (the agents workbench debug view). High-frequency streaming events (per-token
/// chunks, tool-call updates, terminal output, raw ACP diagnostics) are excluded —
/// the workbench doesn't render them and they would flood the channel while an agent
/// streams. (The former append-only `agent_events` DB log this once gated was retired
/// in 批次D1; `conversation_events` is the single authoritative log.)
fn should_emit_agent_event(event: &AgentEvent) -> bool {
    !matches!(
        event,
        AgentEvent::MessageChunk { .. }
            | AgentEvent::ThoughtChunk { .. }
            | AgentEvent::ToolCallUpdate { .. }
            | AgentEvent::TerminalOutput { .. }
            | AgentEvent::RawAcpDiagnostic { .. }
    )
}

fn terminal_title(source: AgentTerminalSource, command: &str) -> String {
    let name = command
        .split_whitespace()
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or("Terminal");
    match source {
        AgentTerminalSource::Acp => format!("ACP {name}"),
    }
}

pub fn start_agent_terminal_forwarding(app: &AppHandle, state: &AppState) {
    let acp_app_handle = app.clone();
    let acp_pool = state.deployment.db().pool.clone();
    let mut acp_lifecycle_rx = agent_terminal_registry().subscribe_lifecycle();

    tauri::async_runtime::spawn(async move {
        let mut workspace_by_session: std::collections::HashMap<Uuid, Option<Uuid>> =
            std::collections::HashMap::new();

        loop {
            match acp_lifecycle_rx.recv().await {
                Ok(AgentTerminalLifecycleEvent::Created(event)) => {
                    let workspace_id = match event.cwd.as_ref().and_then(|cwd| cwd.to_str()) {
                        Some(path) => {
                            match Workspace::resolve_container_ref_by_prefix(&acp_pool, path).await
                            {
                                Ok(info) => Some(info.workspace_id),
                                Err(error) => {
                                    tracing::warn!(
                                        path,
                                        %error,
                                        "Failed to resolve terminal workspace from cwd"
                                    );
                                    None
                                }
                            }
                        }
                        None => None,
                    };

                    workspace_by_session.insert(event.terminal_id.0, workspace_id);

                    let command = if event.args.is_empty() {
                        event.command
                    } else {
                        format!("{} {}", event.command, event.args.join(" "))
                    };
                    let payload = AgentTerminalUiEvent::Created {
                        source: AgentTerminalSource::Acp,
                        session_id: event.terminal_id.0,
                        workspace_id,
                        title: terminal_title(AgentTerminalSource::Acp, &command),
                        command,
                        cwd: event.cwd.and_then(|cwd| cwd.to_str().map(str::to_string)),
                    };

                    if acp_app_handle
                        .emit(channels::AGENT_TERMINAL_EVENTS, &payload)
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(AgentTerminalLifecycleEvent::Released { terminal_id }) => {
                    let workspace_id = workspace_by_session.remove(&terminal_id.0).flatten();
                    let payload = AgentTerminalUiEvent::Released {
                        source: AgentTerminalSource::Acp,
                        session_id: terminal_id.0,
                        workspace_id,
                    };
                    if acp_app_handle
                        .emit(channels::AGENT_TERMINAL_EVENTS, &payload)
                        .is_err()
                    {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use agents::{
        AgentAvailableCommand, AgentConnectionId, AgentContentBlock, AgentEvent,
        AgentEventEnvelope, AgentPermissionId, AgentPermissionOption, AgentPermissionOptionKind,
        AgentPermissionRequest, AgentSessionId, AgentTerminalId, AgentTerminalOutput,
        conversation::ConversationEvent,
    };
    use chrono::Utc;
    use sqlx::SqlitePool;
    use uuid::Uuid;

    #[tokio::test]
    async fn idle_conversation_has_no_active_turn_without_uuid_decode_error() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE sessions (id BLOB PRIMARY KEY, active_turn_id BLOB NULL)")
            .execute(&pool)
            .await
            .unwrap();
        let conversation_id = Uuid::new_v4();
        sqlx::query("INSERT INTO sessions (id, active_turn_id) VALUES (?, NULL)")
            .bind(conversation_id)
            .execute(&pool)
            .await
            .unwrap();

        assert_eq!(
            super::active_turn_id(&pool, conversation_id).await.unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn recovery_error_after_turn_creation_is_mapped_to_turn_failed() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE sessions (id BLOB PRIMARY KEY, active_turn_id BLOB NULL)")
            .execute(&pool)
            .await
            .unwrap();
        let conversation_id = Uuid::new_v4();
        sqlx::query("INSERT INTO sessions (id, active_turn_id) VALUES (?, NULL)")
            .bind(conversation_id)
            .execute(&pool)
            .await
            .unwrap();

        let mut active_turn_cache = HashMap::new();
        assert_eq!(
            super::active_turn_id_cached(&pool, &mut active_turn_cache, conversation_id)
                .await
                .unwrap(),
            None
        );

        let turn_id = Uuid::new_v4();
        sqlx::query("UPDATE sessions SET active_turn_id = ? WHERE id = ?")
            .bind(turn_id)
            .bind(conversation_id)
            .execute(&pool)
            .await
            .unwrap();

        let mapped = super::map_conversation_event_record(
            &pool,
            &AgentEventEnvelope {
                sequence: 2,
                workspace_id: Uuid::new_v4(),
                connection_id: AgentConnectionId::new(),
                session_id: Some(AgentSessionId(conversation_id)),
                event: AgentEvent::Error {
                    error: agents::AgentErrorEvent {
                        message: "OAuth session expired".to_string(),
                        code: Some("authentication_failed".to_string()),
                        raw: None,
                    },
                },
                created_at: now(),
            },
            &mut active_turn_cache,
        )
        .await
        .unwrap()
        .expect("mapped conversation event");

        assert_eq!(mapped.turn_id, Some(turn_id));
        assert!(matches!(mapped.event, ConversationEvent::TurnFailed { .. }));
    }

    #[test]
    fn high_frequency_streaming_events_are_not_emitted_to_agent_channel() {
        assert!(!super::should_emit_agent_event(&AgentEvent::MessageChunk {
            content: agents::AgentContentBlock::Text {
                text: "hi".to_string(),
            },
        }));
        assert!(!super::should_emit_agent_event(&AgentEvent::ThoughtChunk {
            content: agents::AgentContentBlock::Text {
                text: "thinking".to_string(),
            },
        }));
        assert!(super::should_emit_agent_event(&AgentEvent::TurnCompleted {
            stop_reason: None,
        }));
    }

    #[test]
    fn chat_notifications_are_sourced_from_normalized_conversation_events() {
        assert_eq!(
            crate::commands::chat_channel::conversation_event_key(
                &ConversationEvent::AssistantTextDelta {
                    text: "hi".to_string(),
                    message_id: None,
                }
            ),
            None
        );
        assert_eq!(
            crate::commands::chat_channel::conversation_event_key(
                &ConversationEvent::UserTurnStarted
            ),
            Some("prompt_started")
        );
    }

    #[test]
    fn coalescer_merges_consecutive_assistant_text_deltas() {
        let mut coalescer = super::ConversationEventCoalescer::default();

        assert!(
            coalescer
                .push(mapped_conversation_event(
                    10,
                    agents::conversation::ConversationEvent::AssistantTextDelta {
                        text: "hel".to_string(),
                        message_id: None,
                    },
                ))
                .is_empty()
        );
        assert!(
            coalescer
                .push(mapped_conversation_event(
                    11,
                    agents::conversation::ConversationEvent::AssistantTextDelta {
                        text: "lo".to_string(),
                        message_id: None,
                    },
                ))
                .is_empty()
        );

        let ready = coalescer.flush();
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].idempotency_key, "agent:10-11:assistant_text_delta");
        assert!(ready[0].raw_json.contains("\"chunk_count\":2"));
        assert!(matches!(
            &ready[0].event,
            agents::conversation::ConversationEvent::AssistantTextDelta { text, .. }
                if text == "hello"
        ));
    }

    #[test]
    fn coalescer_flushes_text_before_terminal_events() {
        let mut coalescer = super::ConversationEventCoalescer::default();
        assert!(
            coalescer
                .push(mapped_conversation_event(
                    20,
                    agents::conversation::ConversationEvent::AssistantTextDelta {
                        text: "done".to_string(),
                        message_id: None,
                    },
                ))
                .is_empty()
        );

        let ready = coalescer.push(mapped_conversation_event(
            21,
            agents::conversation::ConversationEvent::TurnCompleted {
                stop_reason: Some("end_turn".to_string()),
            },
        ));

        assert_eq!(ready.len(), 2);
        assert!(matches!(
            &ready[0].event,
            agents::conversation::ConversationEvent::AssistantTextDelta { text, .. }
                if text == "done"
        ));
        assert!(matches!(
            ready[1].event,
            agents::conversation::ConversationEvent::TurnCompleted { .. }
        ));
    }

    #[test]
    fn acp_notification_mapping_covers_streaming_and_controls() {
        let envelope = AgentEventEnvelope {
            sequence: 1,
            workspace_id: Uuid::new_v4(),
            connection_id: AgentConnectionId::new(),
            session_id: Some(AgentSessionId::new()),
            event: AgentEvent::MessageChunk {
                content: AgentContentBlock::Text {
                    text: "hello".to_string(),
                },
            },
            created_at: now(),
        };

        assert!(matches!(
            super::map_agent_event_to_conversation_event(&envelope, Some(Uuid::new_v4())),
            Some(agents::conversation::ConversationEvent::AssistantTextDelta { .. })
        ));

        let load_failed = AgentEventEnvelope {
            event: AgentEvent::SessionLoadFailed {
                reason: agents::conversation::SessionLoadFailureReason::ResourceNotFound,
            },
            ..envelope.clone()
        };
        assert!(matches!(
            super::map_agent_event_to_conversation_event(&load_failed, None),
            Some(agents::conversation::ConversationEvent::AgentBindingLoadFailed { .. })
        ));

        let commands = AgentEventEnvelope {
            event: AgentEvent::AvailableCommands {
                commands: vec![AgentAvailableCommand {
                    name: "compact".to_string(),
                    description: None,
                    input_schema: None,
                }],
            },
            ..envelope
        };
        assert!(matches!(
            super::map_agent_event_to_conversation_event(&commands, None),
            Some(agents::conversation::ConversationEvent::AvailableCommandsUpdated { .. })
        ));

        let raw = AgentEventEnvelope {
            event: AgentEvent::RawAcpDiagnostic {
                raw: serde_json::json!({ "method": "unknown" }),
            },
            ..commands
        };
        assert!(super::map_agent_event_to_conversation_event(&raw, None).is_none());
    }

    #[test]
    fn acp_host_request_mapping_covers_permissions_and_terminal() {
        let session_id = AgentSessionId::new();
        let permission_id = AgentPermissionId::new();
        let envelope = AgentEventEnvelope {
            sequence: 1,
            workspace_id: Uuid::new_v4(),
            connection_id: AgentConnectionId::new(),
            session_id: Some(session_id),
            event: AgentEvent::PermissionRequested {
                request: AgentPermissionRequest {
                    id: permission_id,
                    session_id,
                    title: "Run command".to_string(),
                    details: None,
                    options: vec![AgentPermissionOption {
                        id: "allow".to_string(),
                        label: "Allow".to_string(),
                        kind: AgentPermissionOptionKind::AllowOnce,
                        description: None,
                    }],
                },
            },
            created_at: now(),
        };

        assert!(matches!(
            super::map_agent_event_to_conversation_event(&envelope, Some(Uuid::new_v4())),
            Some(agents::conversation::ConversationEvent::PermissionRequested { .. })
        ));

        let terminal = AgentEventEnvelope {
            event: AgentEvent::TerminalOutput {
                output: AgentTerminalOutput {
                    terminal_id: AgentTerminalId::new(),
                    output: "ok".to_string(),
                    truncated: false,
                    exit_status: Some(0),
                },
            },
            ..envelope
        };
        assert!(matches!(
            super::map_agent_event_to_conversation_event(&terminal, Some(Uuid::new_v4())),
            Some(agents::conversation::ConversationEvent::TerminalUpdated { .. })
        ));
    }

    #[test]
    fn failed_prompt_emits_terminal_event_mapping() {
        let envelope = AgentEventEnvelope {
            sequence: 1,
            workspace_id: Uuid::new_v4(),
            connection_id: AgentConnectionId::new(),
            session_id: Some(AgentSessionId::new()),
            event: AgentEvent::Error {
                error: agents::AgentErrorEvent {
                    message: "send failed".to_string(),
                    code: None,
                    raw: None,
                },
            },
            created_at: now(),
        };

        assert!(matches!(
            super::map_agent_event_to_conversation_event(&envelope, Some(Uuid::new_v4())),
            Some(agents::conversation::ConversationEvent::TurnFailed { .. })
        ));
    }

    fn mapped_conversation_event(
        sequence: i64,
        event: agents::conversation::ConversationEvent,
    ) -> super::MappedConversationEventRecord {
        super::MappedConversationEventRecord {
            conversation_id: Uuid::nil(),
            turn_id: Some(Uuid::nil()),
            connection_id: "connection".to_string(),
            source: "acp",
            event_kind: super::conversation_event_kind(&event),
            event,
            raw_json: "{}".to_string(),
            idempotency_key: format!("agent:{sequence}:test"),
            first_agent_sequence: sequence,
            last_agent_sequence: sequence,
        }
    }

    fn now() -> chrono::DateTime<Utc> {
        Utc::now()
    }
}
