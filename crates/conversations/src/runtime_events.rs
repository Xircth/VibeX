//! Durable projection of agent-runtime events into the conversation event log.
//!
//! Both desktop and headless hosts consume the same `AgentRuntime` protocol. This
//! recorder keeps persistence independent of either Tauri or an HTTP transport;
//! adapters can observe the resulting conversation log through their normal
//! snapshot/replay seam.

use std::{collections::HashMap, sync::Arc};

use agents::{
    AgentConnectionStatus, AgentContentBlock, AgentEvent, AgentEventEnvelope,
    conversation::{
        ConversationAgentConnectionStatus, ConversationDelegation, ConversationDelegationResult,
        ConversationError, ConversationEvent, ConversationEventEnvelope, ConversationFileLocation,
        ConversationPermissionRequest, ConversationPermissionResponse, ConversationPlanEntry,
        ConversationQuestionRequest, ConversationQuestionResponse, ConversationTerminalPatch,
        ConversationToolCallPatch, ConversationUsage,
    },
};
use chrono::Utc;
use db::models::{
    conversation::{BindingStatus, ConversationAgentBindingRecord, DbConversationSummary},
    conversation_event::{AppendConversationEvent, CURRENT_EVENT_VERSION, ConversationEventRecord},
    conversation_turn::ConversationTurnRecord,
    session::Session,
};
use deployment::Deployment;
use sqlx::SqlitePool;
use tokio::{
    sync::mpsc,
    task::JoinHandle,
    time::{self, Duration, MissedTickBehavior},
};
use uuid::Uuid;

use crate::{
    ConversationContext, ConversationEventAppender, ConversationEventPublisher,
    ConversationServiceError, ConversationSessionService,
    commit_reminder::{is_complete_ai_reply, start_commit_reminder_if_needed},
    finalize_checkpoint_file_changes,
};

/// Transport-neutral recorder used by all application hosts.
pub struct ConversationAgentEventRecorder {
    pool: SqlitePool,
    deployment: Option<Arc<dyn Deployment>>,
    conversation_context: Option<ConversationContext>,
    event_publisher: Option<Arc<dyn ConversationEventPublisher>>,
    coalescer: ConversationEventCoalescer,
    active_turn_cache: HashMap<Uuid, Option<Uuid>>,
    cached_turn_epoch: u64,
    #[cfg(test)]
    turn_db_lookups: usize,
}

/// Events committed by one recorder operation plus completion effects claimed by
/// the conversation core. Host adapters may react to this result, but never map or
/// append the runtime event themselves.
#[derive(Debug, Default)]
pub struct RecordedConversationBatch {
    pub events: Vec<ConversationEventEnvelope>,
    pub completions: Vec<RecordedConversationCompletion>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedConversationCompletion {
    pub conversation_id: Uuid,
    pub turn_id: Uuid,
    pub origin: String,
}

#[derive(Debug, Clone)]
struct MappedConversationEventRecord {
    conversation_id: Uuid,
    turn_id: Option<Uuid>,
    connection_id: String,
    source: &'static str,
    event_kind: String,
    event: ConversationEvent,
    raw_json: Option<String>,
    idempotency_key: String,
    first_agent_sequence: i64,
    last_agent_sequence: i64,
    complete_reply: bool,
}

impl ConversationAgentEventRecorder {
    pub fn new(pool: SqlitePool, deployment: Arc<dyn Deployment>) -> Self {
        Self {
            pool,
            deployment: Some(deployment),
            conversation_context: None,
            event_publisher: None,
            coalescer: ConversationEventCoalescer::default(),
            active_turn_cache: HashMap::new(),
            cached_turn_epoch: db::models::conversation::active_turn_mutation_epoch(),
            #[cfg(test)]
            turn_db_lookups: 0,
        }
    }

    pub fn with_context(context: ConversationContext) -> Self {
        Self {
            pool: context.deployment.db().pool.clone(),
            deployment: Some(context.deployment.clone()),
            event_publisher: Some(context.event_publisher.clone()),
            conversation_context: Some(context),
            coalescer: ConversationEventCoalescer::default(),
            active_turn_cache: HashMap::new(),
            cached_turn_epoch: db::models::conversation::active_turn_mutation_epoch(),
            #[cfg(test)]
            turn_db_lookups: 0,
        }
    }

    /// Persist one runtime envelope and return every durable event it produced.
    ///
    /// A terminal runtime event may additionally create a checkpoint file-change
    /// event, so callers receive a vector rather than a single envelope.
    pub async fn record(
        &mut self,
        envelope: &AgentEventEnvelope,
    ) -> Result<RecordedConversationBatch, RuntimeEventRecordError> {
        let mut records = self.coalescer.flush();
        if let Some(record) = self.map_record(envelope).await? {
            records.push(record);
        }
        self.append_records(records).await
    }

    /// Buffer adjacent text/reasoning chunks and persist every record that is ready.
    /// The host controls the flush cadence; mapping, turn association, idempotency,
    /// and durable append remain owned by this recorder.
    pub async fn record_buffered(
        &mut self,
        envelope: &AgentEventEnvelope,
    ) -> Result<RecordedConversationBatch, RuntimeEventRecordError> {
        let Some(record) = self.map_record(envelope).await? else {
            return Ok(RecordedConversationBatch::default());
        };
        let records = self.coalescer.push(record);
        self.append_records(records).await
    }

    /// Persist the buffered streaming tail, if any.
    pub async fn flush_buffered(
        &mut self,
    ) -> Result<RecordedConversationBatch, RuntimeEventRecordError> {
        let records = self.coalescer.flush();
        self.append_records(records).await
    }

    async fn map_record(
        &mut self,
        envelope: &AgentEventEnvelope,
    ) -> Result<Option<MappedConversationEventRecord>, RuntimeEventRecordError> {
        let Some(session_id) = envelope.session_id else {
            return Ok(None);
        };
        let conversation_id = session_id.0;
        let turn_id = self.event_turn_id(conversation_id, &envelope.event).await?;
        if turn_id.is_none() && is_turn_scoped_content(&envelope.event) {
            // Turn content with no in-flight Turn to own it: a cancelled prompt's
            // tail, or output from an agent process the Host has already let go.
            // Recording it would attach the text to a neighbouring Turn, which is
            // how a stopped reply reappeared inside the next one.
            tracing::debug!(
                %conversation_id,
                event = %conversation_event_source(&envelope.event),
                "dropped agent turn content that has no in-flight turn"
            );
            return Ok(None);
        }
        let Some(mut event) = map_agent_event(envelope, turn_id) else {
            return Ok(None);
        };
        attach_cached_plan_usage(&self.pool, conversation_id, &mut event).await;

        if let AgentEvent::SessionLinked { acp_session_id, .. } = &envelope.event {
            if agents::is_placeholder_acp_session_id(acp_session_id) {
                tracing::error!(
                    %conversation_id,
                    acp_session_id,
                    "refusing to persist a placeholder ACP session id via SessionLinked"
                );
            } else {
                persist_session_linked_external_id(&self.pool, conversation_id, acp_session_id)
                    .await?;
                if let Some(binding_id) = latest_binding_id(&self.pool, conversation_id).await? {
                    ConversationAgentBindingRecord::bind_acp_session(
                        &self.pool,
                        binding_id,
                        acp_session_id,
                        None,
                        BindingStatus::Ready,
                    )
                    .await?;
                }
            }
        }

        if let AgentEvent::SessionInfoUpdated { patch } = &envelope.event
            && let Some(title) = crate::session_info::agent_session_title_from_patch(patch)
        {
            DbConversationSummary::backfill_title(&self.pool, conversation_id, &title).await?;
        }

        let source = conversation_event_source(&envelope.event);
        let event_kind = conversation_event_kind(&event);
        if is_terminal_conversation_event(&event) {
            self.active_turn_cache.remove(&conversation_id);
        }
        let raw_json = if crate::jsonl_history::is_transcript_delta(&event) {
            None
        } else {
            Some(serde_json::to_string(&envelope.event)?)
        };
        let connection_id = envelope.connection_id.to_string();
        let idempotency_key = format!("agent:{}:{event_kind}", envelope.sequence);
        let complete_reply = matches!(
            &envelope.event,
            AgentEvent::PromptFinished { finished }
                if is_complete_ai_reply(finished.stop_reason.as_deref())
        );

        Ok(Some(MappedConversationEventRecord {
            conversation_id,
            turn_id,
            connection_id,
            source,
            event_kind,
            event,
            raw_json,
            idempotency_key,
            first_agent_sequence: envelope.sequence,
            last_agent_sequence: envelope.sequence,
            complete_reply,
        }))
    }

    async fn append_records(
        &mut self,
        records: Vec<MappedConversationEventRecord>,
    ) -> Result<RecordedConversationBatch, RuntimeEventRecordError> {
        let mut batch = RecordedConversationBatch::default();
        for mapped in records {
            let normalized_json = serde_json::to_string(&mapped.event)?;
            if crate::jsonl_history::is_transcript_delta(&mapped.event) {
                if let Some(publisher) = &self.event_publisher {
                    let record = ephemeral_record(&mapped, &normalized_json);
                    publisher.publish_unpersisted(&record).await;
                }
                continue;
            }
            let Some(record) = append_mapped_event(&self.pool, &mapped, &normalized_json).await?
            else {
                continue;
            };
            let durable = ConversationEventEnvelope {
                id: record.id,
                conversation_id: record.conversation_id,
                turn_id: record.turn_id,
                sequence: record.sequence,
                source: record.source.clone(),
                event: serde_json::from_str(&record.normalized_json)?,
                created_at: record.created_at,
            };
            let terminal = is_terminal_conversation_event(&durable.event);
            crate::service::emit_runtime_event(&durable, &mapped.event_kind);
            batch.events.push(durable);

            if terminal
                && let Some(turn_id) = mapped.turn_id
                && let Some(deployment) = self.deployment.as_deref()
                && let Some(file_event) =
                    finalize_checkpoint_file_changes(deployment, mapped.conversation_id, turn_id)
                        .await?
            {
                crate::service::emit_runtime_event(&file_event, "file_change");
                batch.events.push(file_event);
            }

            // Publish only after the terminal checkpoint append.
            // The desktop publisher reads the durable tail, so one publication includes both.
            if let Some(publisher) = &self.event_publisher {
                publisher.publish(&record).await;
            }

            if terminal && let Some(turn_id) = mapped.turn_id {
                let (status, stop_reason, error_message) = match &mapped.event {
                    ConversationEvent::TurnCompleted { stop_reason, .. } => {
                        ("completed".to_string(), stop_reason.clone(), None)
                    }
                    ConversationEvent::TurnFailed { error } => {
                        ("failed".to_string(), None, Some(error.message.clone()))
                    }
                    ConversationEvent::TurnCancelled { reason } => {
                        ("cancelled".to_string(), reason.clone(), None)
                    }
                    ConversationEvent::TurnInterrupted { reason } => {
                        ("interrupted".to_string(), reason.clone(), None)
                    }
                    _ => ("completed".to_string(), None, None),
                };
                let after_event = crate::service::AfterTurnEvent {
                    conversation_id: mapped.conversation_id,
                    turn_id,
                    status,
                    stop_reason,
                    error_message,
                };
                if let Some(context) = &self.conversation_context {
                    context.host.after_turn(&after_event).await;
                }
                crate::service::emit_after_turn_event(after_event);
            }

            // A terminal Turn makes the conversation idle. Pump the next durable
            // input on a separate task: this recorder owns the Agent event
            // stream, and `dispatch_next_queued_input` performs Agent I/O that
            // must not wait on the same consumer.
            if terminal && let Some(context) = self.conversation_context.clone() {
                let conversation_id = mapped.conversation_id;
                tokio::spawn(async move {
                    if let Err(error) = ConversationSessionService::new(context)
                        .dispatch_next_queued_input(conversation_id)
                        .await
                    {
                        tracing::warn!(
                            %conversation_id,
                            %error,
                            "failed to dispatch the next durable conversation input"
                        );
                    }
                });
            }

            if mapped.complete_reply
                && let Some(turn_id) = mapped.turn_id
                && let Some(context) = self.conversation_context.clone()
            {
                match ConversationTurnRecord::claim_completion_effects(&self.pool, turn_id).await {
                    Ok(true) => {
                        if let Some(turn) =
                            ConversationTurnRecord::find_by_id(&self.pool, turn_id).await?
                        {
                            batch.completions.push(RecordedConversationCompletion {
                                conversation_id: mapped.conversation_id,
                                turn_id,
                                origin: turn.origin,
                            });
                        }
                        let conversation_id = mapped.conversation_id;
                        tokio::spawn(async move {
                            if let Err(error) =
                                start_commit_reminder_if_needed(context, conversation_id, turn_id)
                                    .await
                            {
                                tracing::warn!(
                                    %conversation_id,
                                    %turn_id,
                                    %error,
                                    "failed to start commit reminder"
                                );
                            }
                        });
                    }
                    Ok(false) => {}
                    Err(error) => tracing::warn!(
                        conversation_id = %mapped.conversation_id,
                        %turn_id,
                        %error,
                        "failed to claim completion effects"
                    ),
                }
            }
        }
        Ok(batch)
    }

    async fn event_turn_id(
        &mut self,
        conversation_id: Uuid,
        event: &AgentEvent,
    ) -> Result<Option<Uuid>, sqlx::Error> {
        let current_epoch = db::models::conversation::active_turn_mutation_epoch();
        if self.cached_turn_epoch != current_epoch {
            self.active_turn_cache.clear();
            self.cached_turn_epoch = current_epoch;
        }

        match event {
            AgentEvent::PromptStarted { snapshot } => {
                #[cfg(test)]
                {
                    self.turn_db_lookups += 1;
                }
                let turn_id =
                    bind_prompt_turn(&self.pool, conversation_id, &snapshot.id.to_string()).await?;
                self.active_turn_cache.insert(conversation_id, turn_id);
                Ok(turn_id)
            }
            AgentEvent::PromptFinished { .. } | AgentEvent::TurnCompleted { .. } => {
                #[cfg(test)]
                {
                    self.turn_db_lookups += 1;
                }
                let turn_id =
                    resolve_agent_event_turn_id(&self.pool, conversation_id, event).await?;
                self.active_turn_cache.remove(&conversation_id);
                Ok(turn_id)
            }
            AgentEvent::ConnectionStatusChanged { snapshot }
                if matches!(
                    snapshot.status,
                    AgentConnectionStatus::Disconnected
                        | AgentConnectionStatus::Failed
                        | AgentConnectionStatus::Ready
                ) =>
            {
                self.active_turn_cache.remove(&conversation_id);
                #[cfg(test)]
                {
                    self.turn_db_lookups += 1;
                }
                resolve_agent_event_turn_id(&self.pool, conversation_id, event).await
            }
            event if binds_only_to_in_flight_turn(event) => {
                let turn_id = if let Some(&cached) = self.active_turn_cache.get(&conversation_id) {
                    cached
                } else {
                    #[cfg(test)]
                    {
                        self.turn_db_lookups += 1;
                    }
                    let resolved = in_flight_active_turn_id(&self.pool, conversation_id).await?;
                    self.active_turn_cache.insert(conversation_id, resolved);
                    resolved
                };
                if matches!(event, AgentEvent::Error { .. }) {
                    self.active_turn_cache.remove(&conversation_id);
                }
                Ok(turn_id)
            }
            _ => {
                #[cfg(test)]
                {
                    self.turn_db_lookups += 1;
                }
                resolve_agent_event_turn_id(&self.pool, conversation_id, event).await
            }
        }
    }
}

fn ephemeral_record(
    mapped: &MappedConversationEventRecord,
    normalized_json: &str,
) -> ConversationEventRecord {
    ConversationEventRecord {
        id: Uuid::new_v4(),
        conversation_id: mapped.conversation_id,
        turn_id: mapped.turn_id,
        binding_id: None,
        connection_id: Some(mapped.connection_id.clone()),
        prompt_id: None,
        sequence: 0,
        source: mapped.source.to_string(),
        event_kind: mapped.event_kind.clone(),
        event_version: CURRENT_EVENT_VERSION,
        normalized_json: normalized_json.to_string(),
        raw_json: mapped.raw_json.clone(),
        idempotency_key: Some(mapped.idempotency_key.clone()),
        created_at: Utc::now(),
    }
}

fn append_event_input<'a>(
    mapped: &'a MappedConversationEventRecord,
    normalized_json: &'a str,
    turn_id: Option<Uuid>,
) -> AppendConversationEvent<'a> {
    AppendConversationEvent {
        id: Uuid::new_v4(),
        conversation_id: mapped.conversation_id,
        turn_id,
        binding_id: None,
        connection_id: Some(&mapped.connection_id),
        prompt_id: None,
        source: mapped.source,
        event_kind: &mapped.event_kind,
        normalized_json,
        raw_json: mapped.raw_json.as_deref(),
        idempotency_key: Some(&mapped.idempotency_key),
    }
}

async fn append_mapped_event(
    pool: &SqlitePool,
    mapped: &MappedConversationEventRecord,
    normalized_json: &str,
) -> Result<Option<db::models::conversation_event::ConversationEventRecord>, sqlx::Error> {
    match ConversationEventAppender::append(
        pool,
        append_event_input(mapped, normalized_json, mapped.turn_id),
    )
    .await
    {
        Ok(record) => Ok(Some(record)),
        Err(error) if is_foreign_key_constraint(&error) => {
            if mapped.turn_id.is_some() {
                match ConversationEventAppender::append(
                    pool,
                    append_event_input(mapped, normalized_json, None),
                )
                .await
                {
                    Ok(record) => return Ok(Some(record)),
                    Err(retry) if is_foreign_key_constraint(&retry) => {
                        tracing::debug!(
                            conversation_id = %mapped.conversation_id,
                            turn_id = ?mapped.turn_id,
                            %retry,
                            "skipped conversation event that could not be persisted"
                        );
                        return Ok(None);
                    }
                    Err(retry) => return Err(retry),
                }
            }
            tracing::debug!(
                conversation_id = %mapped.conversation_id,
                %error,
                "skipped conversation event that could not be persisted"
            );
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

fn is_foreign_key_constraint(error: &sqlx::Error) -> bool {
    match error {
        sqlx::Error::Database(database) => {
            database.code().as_deref() == Some("787")
                || database
                    .message()
                    .to_ascii_uppercase()
                    .contains("FOREIGN KEY")
        }
        _ => false,
    }
}

async fn resolve_agent_event_turn_id(
    pool: &SqlitePool,
    conversation_id: Uuid,
    event: &AgentEvent,
) -> Result<Option<Uuid>, sqlx::Error> {
    match event {
        AgentEvent::PromptStarted { snapshot } => {
            bind_prompt_turn(pool, conversation_id, &snapshot.id.to_string()).await
        }
        AgentEvent::PromptFinished { finished } => {
            let prompt_id = finished.prompt_id.to_string();
            if let Some(turn) =
                ConversationTurnRecord::find_by_prompt_id(pool, conversation_id, &prompt_id).await?
            {
                return Ok(Some(turn.id));
            }
            let Some(active_id) = in_flight_active_turn_id(pool, conversation_id).await? else {
                return Ok(None);
            };
            let active_turn = ConversationTurnRecord::find_by_id(pool, active_id).await?;
            Ok(active_turn
                .filter(|turn| turn.prompt_id.as_deref().is_none_or(|id| id == prompt_id))
                .map(|turn| turn.id))
        }
        event if binds_only_to_in_flight_turn(event) => {
            in_flight_active_turn_id(pool, conversation_id).await
        }
        _ => {
            if let Some(turn_id) = in_flight_active_turn_id(pool, conversation_id).await? {
                return Ok(Some(turn_id));
            }
            Ok(
                ConversationTurnRecord::latest_for_conversation(pool, conversation_id)
                    .await?
                    .map(|turn| turn.id),
            )
        }
    }
}

/// Events that must never be attributed to an already-settled Turn. When there is no
/// in-flight Turn they resolve to `None` rather than falling back to the conversation's
/// latest Turn.
fn binds_only_to_in_flight_turn(event: &AgentEvent) -> bool {
    is_turn_scoped_content(event) || matches!(event, AgentEvent::Error { .. })
}

/// Events that only mean something *inside* a Turn. Unlike `AgentEvent::Error`, which
/// has a conversation-level representation (`AgentBindingRecoveryFailed`), these have
/// nowhere to go once their Turn is gone, so they are dropped instead of recorded.
fn is_turn_scoped_content(event: &AgentEvent) -> bool {
    matches!(
        event,
        AgentEvent::MessageChunk { .. }
            | AgentEvent::ThoughtChunk { .. }
            | AgentEvent::ToolCall { .. }
            | AgentEvent::ToolCallUpdate { .. }
            | AgentEvent::Plan { .. }
            | AgentEvent::PermissionRequested { .. }
            | AgentEvent::ElicitationRequested { .. }
            | AgentEvent::TerminalCreated { .. }
            | AgentEvent::TerminalOutput { .. }
    )
}

fn is_in_flight_turn_status(status: &str) -> bool {
    matches!(status, "pending" | "queued" | "running" | "blocked")
}

async fn bind_prompt_turn(
    pool: &SqlitePool,
    conversation_id: Uuid,
    prompt_id: &str,
) -> Result<Option<Uuid>, sqlx::Error> {
    if let Some(turn) =
        ConversationTurnRecord::find_by_prompt_id(pool, conversation_id, prompt_id).await?
        && is_in_flight_turn_status(&turn.status)
    {
        return Ok(Some(turn.id));
    }
    in_flight_active_turn_id(pool, conversation_id).await
}

/// The conversation's in-flight Turn, read from the authoritative pointer.
///
/// This deliberately keeps no in-memory cache. A cache here went stale whenever a
/// Turn reached a terminal state without passing through this recorder — `cancel_turn`
/// and `interrupt_orphaned_turn` write the terminal event and null the pointer
/// directly — after which every later agent event was attributed to the Turn the user
/// had already stopped, and from there to whichever Turn the projection had open.
async fn in_flight_active_turn_id(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Option<Uuid>, sqlx::Error> {
    sqlx::query_scalar::<_, Uuid>(
        r#"SELECT turns.id
           FROM sessions
           JOIN conversation_turns turns ON turns.id = sessions.active_turn_id
           WHERE sessions.id = ?
             AND turns.status IN ('pending', 'queued', 'running', 'blocked')"#,
    )
    .bind(conversation_id)
    .fetch_optional(pool)
    .await
}

#[derive(Debug, Clone)]
enum CoalescedPayload {
    AssistantText {
        text: String,
        message_id: Option<String>,
    },
    AssistantReasoning {
        text: String,
        message_id: Option<String>,
    },
    ToolCallUpsert {
        tool_call: ConversationToolCallPatch,
    },
}

#[derive(Debug, Clone)]
struct PendingConversationDelta {
    base: MappedConversationEventRecord,
    payload: CoalescedPayload,
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
        match coalesced_payload_from_event(&record.event) {
            Some(payload) => self.push_coalesceable(record, payload),
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

    fn push_coalesceable(
        &mut self,
        record: MappedConversationEventRecord,
        payload: CoalescedPayload,
    ) -> Vec<MappedConversationEventRecord> {
        if let Some(pending) = &mut self.pending
            && pending.try_merge(&record, &payload)
        {
            return Vec::new();
        }

        let ready = self.flush();
        self.pending = Some(PendingConversationDelta {
            base: record,
            payload,
            chunk_count: 1,
        });
        ready
    }
}

impl PendingConversationDelta {
    fn has_same_context(&self, record: &MappedConversationEventRecord) -> bool {
        self.base.conversation_id == record.conversation_id
            && self.base.turn_id == record.turn_id
            && self.base.connection_id == record.connection_id
            && self.base.source == record.source
    }

    fn try_merge(
        &mut self,
        record: &MappedConversationEventRecord,
        incoming: &CoalescedPayload,
    ) -> bool {
        if !self.has_same_context(record) {
            return false;
        }
        match (&mut self.payload, incoming) {
            (
                CoalescedPayload::AssistantText {
                    text: pending_text,
                    message_id: pending_id,
                },
                CoalescedPayload::AssistantText {
                    text: next_text,
                    message_id: next_id,
                },
            )
            | (
                CoalescedPayload::AssistantReasoning {
                    text: pending_text,
                    message_id: pending_id,
                },
                CoalescedPayload::AssistantReasoning {
                    text: next_text,
                    message_id: next_id,
                },
            ) if pending_id == next_id => {
                pending_text.push_str(next_text);
                self.base.last_agent_sequence = record.last_agent_sequence;
                self.chunk_count += 1;
                true
            }
            (
                CoalescedPayload::ToolCallUpsert {
                    tool_call: pending_tool,
                },
                CoalescedPayload::ToolCallUpsert {
                    tool_call: next_tool,
                },
            ) if pending_tool.tool_call_id == next_tool.tool_call_id => {
                merge_tool_call_patch(pending_tool, next_tool);
                self.base.last_agent_sequence = record.last_agent_sequence;
                self.chunk_count += 1;
                true
            }
            _ => false,
        }
    }

    fn into_record(mut self) -> MappedConversationEventRecord {
        self.base.event = match self.payload {
            CoalescedPayload::AssistantText { text, message_id } => {
                ConversationEvent::AssistantTextDelta { text, message_id }
            }
            CoalescedPayload::AssistantReasoning { text, message_id } => {
                ConversationEvent::AssistantReasoningDelta { text, message_id }
            }
            CoalescedPayload::ToolCallUpsert { tool_call } => {
                ConversationEvent::ToolCallUpsert { tool_call }
            }
        };
        self.base.event_kind = conversation_event_kind(&self.base.event);
        self.base.idempotency_key = format!(
            "agent:{}-{}:{}",
            self.base.first_agent_sequence, self.base.last_agent_sequence, self.base.event_kind
        );
        self.base.raw_json = Some(
            serde_json::json!({
                "coalesced": true,
                "first_sequence": self.base.first_agent_sequence,
                "last_sequence": self.base.last_agent_sequence,
                "chunk_count": self.chunk_count,
                "kind": self.base.event_kind,
            })
            .to_string(),
        );
        self.base.complete_reply = false;
        self.base
    }
}

fn merge_tool_call_patch(
    target: &mut ConversationToolCallPatch,
    incoming: &ConversationToolCallPatch,
) {
    if let Some(title) = &incoming.title {
        target.title = Some(title.clone());
    }
    if let Some(kind) = &incoming.kind {
        target.kind = Some(kind.clone());
    }
    if let Some(status) = &incoming.status {
        target.status = Some(status.clone());
    }
    if let Some(raw_input) = &incoming.raw_input {
        target.raw_input = Some(raw_input.clone());
    }
    if let Some(raw_output) = &incoming.raw_output {
        target.raw_output = Some(raw_output.clone());
    }
    if let Some(raw_output_append) = &incoming.raw_output_append {
        target.raw_output_append = Some(raw_output_append.clone());
    }
    if let Some(content) = &incoming.content {
        target.content = Some(content.clone());
    }
    if let Some(locations) = &incoming.locations
        && (!locations.is_empty() || target.locations.is_none())
    {
        target.locations = Some(locations.clone());
    }
    if let Some(metadata) = &incoming.metadata {
        target.metadata = Some(metadata.clone());
    }
    if !incoming.images.is_empty() {
        target.images = incoming.images.clone();
    }
}

fn coalesced_payload_from_event(event: &ConversationEvent) -> Option<CoalescedPayload> {
    match event {
        ConversationEvent::AssistantTextDelta { text, message_id } => {
            Some(CoalescedPayload::AssistantText {
                text: text.clone(),
                message_id: message_id.clone(),
            })
        }
        ConversationEvent::AssistantReasoningDelta { text, message_id } => {
            Some(CoalescedPayload::AssistantReasoning {
                text: text.clone(),
                message_id: message_id.clone(),
            })
        }
        ConversationEvent::ToolCallUpsert { tool_call } => Some(CoalescedPayload::ToolCallUpsert {
            tool_call: tool_call.clone(),
        }),
        _ => None,
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RuntimeEventRecordError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Conversation(#[from] ConversationServiceError),
}

const AGENT_EVENT_STREAM_FLUSH_INTERVAL: Duration = Duration::from_millis(80);

/// Start the durable runtime-event bridge for a host composition root.
pub fn start_agent_event_persistence(
    context: ConversationContext,
    receiver: mpsc::Receiver<AgentEventEnvelope>,
) -> JoinHandle<()> {
    start_agent_event_persistence_with_observer(context, receiver, |_| {})
}

/// Same persist loop as [`start_agent_event_persistence`], with an observer for
/// host-specific live fan-out (desktop/headless `agent-events`).
pub fn start_agent_event_persistence_with_observer(
    context: ConversationContext,
    receiver: mpsc::Receiver<AgentEventEnvelope>,
    on_envelope: impl FnMut(&AgentEventEnvelope) + Send + 'static,
) -> JoinHandle<()> {
    start_agent_event_persistence_loop(
        move || ConversationAgentEventRecorder::with_context(context.clone()),
        receiver,
        on_envelope,
    )
}

fn start_agent_event_persistence_loop(
    mut make_recorder: impl FnMut() -> ConversationAgentEventRecorder + Send + 'static,
    mut receiver: mpsc::Receiver<AgentEventEnvelope>,
    mut on_envelope: impl FnMut(&AgentEventEnvelope) + Send + 'static,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        use futures::FutureExt as _;

        loop {
            let mut recorder = make_recorder();
            let mut flush_interval = time::interval(AGENT_EVENT_STREAM_FLUSH_INTERVAL);
            flush_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

            let step = std::panic::AssertUnwindSafe(async {
                loop {
                    tokio::select! {
                        _ = flush_interval.tick() => {
                            if let Err(error) = recorder.flush_buffered().await {
                                tracing::warn!(%error, "failed to flush conversation events");
                            }
                        }
                        received = receiver.recv() => {
                            match received {
                                Some(envelope) => {
                                    if let Err(error) = recorder.record_buffered(&envelope).await {
                                        tracing::warn!(
                                            sequence = envelope.sequence,
                                            %error,
                                            "failed to persist agent runtime event"
                                        );
                                    }
                                    on_envelope(&envelope);
                                }
                                None => {
                                    if let Err(error) = recorder.flush_buffered().await {
                                        tracing::warn!(%error, "failed to flush conversation events");
                                    }
                                    break;
                                }
                            }
                        }
                    }
                }
            })
            .catch_unwind()
            .await;

            match step {
                Ok(()) => break,
                Err(_) => {
                    tracing::error!(
                        "agent event persistence worker panicked; respawning to keep receiver alive"
                    );
                }
            }
        }
    })
}

fn is_terminal_conversation_event(event: &ConversationEvent) -> bool {
    matches!(
        event,
        ConversationEvent::TurnCompleted { .. }
            | ConversationEvent::TurnFailed { .. }
            | ConversationEvent::TurnCancelled { .. }
            | ConversationEvent::TurnInterrupted { .. }
    )
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

async fn attach_cached_plan_usage(
    pool: &SqlitePool,
    conversation_id: Uuid,
    event: &mut ConversationEvent,
) {
    let ConversationEvent::TurnFailed { error } = event else {
        return;
    };
    let Ok(Some(session)) = Session::find_by_id(pool, conversation_id).await else {
        return;
    };
    *error = std::mem::take(error).with_cached_plan_usage(session.agent_id.as_ref());
}

fn parse_json_payload(payload: &str) -> serde_json::Value {
    serde_json::from_str(payload).unwrap_or_else(|_| serde_json::Value::String(payload.to_string()))
}

fn map_agent_event(
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
                    AgentConnectionStatus::Recovering => {
                        ConversationAgentConnectionStatus::Recovering
                    }
                    AgentConnectionStatus::Ready => ConversationAgentConnectionStatus::Ready,
                    AgentConnectionStatus::Failed => ConversationAgentConnectionStatus::Error,
                },
            })
        }
        AgentEvent::SessionLinked {
            acp_session_id,
            capabilities,
            ..
        } => Some(ConversationEvent::AgentBindingReady {
            acp_session_id: acp_session_id.clone(),
            capabilities: capabilities.clone(),
        }),
        AgentEvent::MessageChunk { content } => map_content_chunk(content, false),
        AgentEvent::ThoughtChunk { content } => map_content_chunk(content, true),
        AgentEvent::ToolCall { tool_call } => Some(ConversationEvent::ToolCallUpsert {
            tool_call: ConversationToolCallPatch {
                tool_call_id: tool_call.id.clone(),
                title: Some(tool_call.title.clone()),
                kind: tool_call.kind.clone().or_else(|| Some("other".to_string())),
                status: tool_call
                    .status
                    .clone()
                    .or_else(|| Some("running".to_string())),
                raw_input: tool_call
                    .input_preview
                    .as_ref()
                    .map(|preview| parse_json_payload(preview)),
                raw_output: tool_call.content.as_deref().map(parse_json_payload),
                raw_output_append: None,
                content: None,
                locations: None,
                metadata: tool_call.meta.clone(),
                images: tool_call.images.clone(),
            },
        }),
        AgentEvent::ToolCallUpdate { update } => Some(ConversationEvent::ToolCallUpsert {
            tool_call: ConversationToolCallPatch {
                tool_call_id: update.id.clone(),
                title: update.title.clone(),
                kind: None,
                status: update.status.clone(),
                raw_input: update
                    .input_preview
                    .as_ref()
                    .map(|preview| parse_json_payload(preview)),
                raw_output: update.content.as_deref().map(parse_json_payload),
                raw_output_append: update.content.clone(),
                content: update
                    .content
                    .as_ref()
                    .map(|content| serde_json::json!({ "text": content })),
                locations: Some(Vec::<ConversationFileLocation>::new()),
                metadata: update.meta.clone(),
                images: update.images.clone(),
            },
        }),
        AgentEvent::Plan { plan } => Some(ConversationEvent::PlanUpdated {
            entries: plan
                .entries
                .iter()
                .enumerate()
                .map(|(index, entry)| ConversationPlanEntry {
                    id: format!("plan-{index}"),
                    content: entry.content.clone(),
                    status: entry.status.clone(),
                    priority: entry.priority.clone(),
                })
                .collect(),
        }),
        AgentEvent::Usage { usage } => Some(ConversationEvent::UsageUpdated {
            usage: ConversationUsage {
                input_tokens: usage.input_tokens.unwrap_or(0),
                output_tokens: usage.output_tokens.unwrap_or(0),
                cache_creation_input_tokens: usage.cache_write_tokens.unwrap_or(0),
                cache_read_input_tokens: usage.cache_read_tokens.unwrap_or(0),
                context_used: (usage.used > 0).then_some(usage.used),
                context_window_max: usage.limit.filter(|limit| *limit > 0),
                cost_amount: usage.cost_amount,
                cost_currency: usage.cost_currency.clone(),
                model: usage
                    .model
                    .as_deref()
                    .map(str::trim)
                    .filter(|model| !model.is_empty())
                    .map(ToOwned::to_owned),
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
            Some(ConversationEvent::AgentBindingLoadFailed {
                reason: reason.clone(),
            })
        }
        AgentEvent::TurnCompleted { stop_reason } => {
            Some(map_prompt_stop_to_conversation_event(stop_reason.clone()))
        }
        AgentEvent::PromptFinished {
            finished: agents::AgentPromptFinished { stop_reason, .. },
        } => Some(map_prompt_stop_to_conversation_event(stop_reason.clone())),
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
                    asked_at: Some(envelope.created_at),
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
            delegation_id,
            parent_tool_use_id,
            child_session_id,
            agent_id,
            task_preview,
        } => Some(ConversationEvent::DelegationStarted {
            delegation: ConversationDelegation {
                delegation_id: delegation_id.clone(),
                parent_tool_call_id: parent_tool_use_id.clone(),
                child_conversation_id: *child_session_id,
                agent_id: agent_id.clone(),
                task_preview: task_preview.clone(),
            },
        }),
        AgentEvent::DelegationCompleted {
            delegation_id,
            result,
            ..
        } => Some(ConversationEvent::DelegationCompleted {
            delegation_id: delegation_id.clone(),
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
                        error: ConversationError::new(
                            error_code.clone(),
                            Some(error_code.clone()),
                            None,
                        ),
                    }
                }
            },
        }),
        AgentEvent::Error { error } => Some(
            if error.code.as_deref() == Some("auth_required") && turn_id.is_some() {
                ConversationEvent::TurnBlocked {
                    reason: agents::conversation::TurnBlockedReason::Authentication {
                        message: error.message.clone(),
                    },
                }
            } else if let Some(turn_id) = turn_id {
                tracing::error!(
                    turn_id = %turn_id,
                    code = error.code.as_deref().unwrap_or("unknown"),
                    message = %error.message,
                    "agent turn failed"
                );
                ConversationEvent::TurnFailed {
                    error: ConversationError::new(
                        error.message.clone(),
                        error.code.clone(),
                        error.raw.clone(),
                    ),
                }
            } else {
                tracing::error!(
                    message = %error.message,
                    "agent binding recovery failed"
                );
                ConversationEvent::AgentBindingRecoveryFailed {
                    reason: error.message.clone(),
                }
            },
        ),
        AgentEvent::RawAcpDiagnostic { raw } => Some(ConversationEvent::RawDiagnosticRecorded {
            label: diagnostic_label(raw),
            payload: Some(raw.clone()),
        }),
        AgentEvent::AnnouncementsUpdated {
            generation,
            notices,
        } => Some(ConversationEvent::AnnouncementsUpdated {
            generation: *generation,
            notices: notices.clone(),
        }),
        AgentEvent::SessionCreated { .. }
        | AgentEvent::PromptStarted { .. }
        | AgentEvent::ModeChanged { .. }
        | AgentEvent::ConfigChanged { .. }
        | AgentEvent::ConfigOptionRejected { .. }
        | AgentEvent::SessionBindReady { .. } => None,
    }
}

fn map_content_chunk(content: &AgentContentBlock, thought: bool) -> Option<ConversationEvent> {
    match content {
        AgentContentBlock::Text { text } if thought => {
            Some(ConversationEvent::AssistantReasoningDelta {
                text: text.clone(),
                message_id: None,
            })
        }
        AgentContentBlock::Text { text } => Some(ConversationEvent::AssistantTextDelta {
            text: text.clone(),
            message_id: None,
        }),
        AgentContentBlock::Image {
            data,
            mime_type,
            uri,
        } => Some(ConversationEvent::AssistantContentAppended {
            block: agents::conversation::ContentBlock::Image {
                data: data.clone(),
                mime_type: mime_type.clone(),
                uri: uri.clone(),
                width: None,
                height: None,
            },
            message_id: None,
        }),
        AgentContentBlock::Resource { uri, title } => {
            Some(ConversationEvent::AssistantContentAppended {
                block: agents::conversation::ContentBlock::Resource {
                    uri: uri.clone(),
                    title: title.clone(),
                },
                message_id: None,
            })
        }
        AgentContentBlock::Protocol { content } => {
            Some(ConversationEvent::AssistantContentAppended {
                block: agents::conversation::ContentBlock::Protocol {
                    content: content.clone(),
                },
                message_id: None,
            })
        }
    }
}

fn map_prompt_stop_to_conversation_event(stop_reason: Option<String>) -> ConversationEvent {
    if crate::commit_reminder::is_cancelled_stop_reason(stop_reason.as_deref()) {
        ConversationEvent::TurnCancelled {
            reason: stop_reason,
        }
    } else {
        ConversationEvent::TurnCompleted { stop_reason }
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
        | AgentEvent::PromptFinished { .. }
        | AgentEvent::RawAcpDiagnostic { .. }
        | AgentEvent::AnnouncementsUpdated { .. } => "acp",
        _ => "runtime",
    }
}

fn diagnostic_label(raw: &serde_json::Value) -> String {
    raw.get("kind")
        .and_then(serde_json::Value::as_str)
        .or_else(|| raw.get("sessionUpdate").and_then(serde_json::Value::as_str))
        .or_else(|| raw.get("method").and_then(serde_json::Value::as_str))
        .unwrap_or("acp_unknown_update")
        .to_string()
}

async fn persist_session_linked_external_id(
    pool: &SqlitePool,
    conversation_id: Uuid,
    acp_session_id: &str,
) -> Result<(), RuntimeEventRecordError> {
    Session::update_external_session_id(pool, conversation_id, acp_session_id).await?;
    Ok(())
}

fn conversation_event_kind(event: &ConversationEvent) -> String {
    match event {
        ConversationEvent::AssistantTextDelta { .. } => "assistant_text_delta".to_string(),
        ConversationEvent::AssistantReasoningDelta { .. } => {
            "assistant_reasoning_delta".to_string()
        }
        ConversationEvent::AssistantContentAppended { .. } => {
            "assistant_content_appended".to_string()
        }
        ConversationEvent::ToolCallUpsert { .. } => "tool_call_upsert".to_string(),
        ConversationEvent::PlanUpdated { .. } => "plan_updated".to_string(),
        ConversationEvent::UsageUpdated { .. } => "usage_updated".to_string(),
        ConversationEvent::TurnCompleted { .. } => "turn_completed".to_string(),
        ConversationEvent::TurnFailed { .. } => "turn_failed".to_string(),
        ConversationEvent::TurnCancelled { .. } => "turn_cancelled".to_string(),
        ConversationEvent::TurnInterrupted { .. } => "turn_interrupted".to_string(),
        _ => serde_json::to_value(event)
            .ok()
            .and_then(|value| value["kind"].as_str().map(str::to_string))
            .unwrap_or_else(|| "unknown".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use agents::{
        AgentConnectionId, AgentContentBlock, AgentEvent, AgentEventEnvelope, AgentPromptId,
        AgentPromptSnapshot, AgentPromptStatus, AgentSessionId, AgentToolCall, AgentToolCallUpdate,
        AgentUsage, conversation::ConversationEvent,
    };
    use chrono::Utc;
    use db::models::{
        conversation::{ConversationRecord, CreateConversationRecord},
        conversation_turn::{ConversationTurnRecord, CreateConversationTurn},
        session::Session,
    };
    use sqlx::{
        SqlitePool,
        sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    };
    use uuid::Uuid;

    use super::{
        ConversationEventCoalescer, MappedConversationEventRecord, append_mapped_event,
        binds_only_to_in_flight_turn, conversation_event_kind, conversation_event_source,
        is_turn_scoped_content, map_agent_event, persist_session_linked_external_id,
        resolve_agent_event_turn_id,
    };

    #[test]
    fn shared_recorder_coalesces_consecutive_text_without_dropping_boundaries() {
        let mut coalescer = ConversationEventCoalescer::default();
        assert!(
            coalescer
                .push(mapped_record(
                    10,
                    ConversationEvent::AssistantTextDelta {
                        text: "hel".to_string(),
                        message_id: None,
                    },
                ))
                .is_empty()
        );
        assert!(
            coalescer
                .push(mapped_record(
                    11,
                    ConversationEvent::AssistantTextDelta {
                        text: "lo".to_string(),
                        message_id: None,
                    },
                ))
                .is_empty()
        );

        let ready = coalescer.push(mapped_record(
            12,
            ConversationEvent::TurnCompleted {
                stop_reason: Some("end_turn".to_string()),
            },
        ));
        assert_eq!(ready.len(), 2);
        assert_eq!(ready[0].idempotency_key, "agent:10-11:assistant_text_delta");
        assert!(
            ready[0]
                .raw_json
                .as_deref()
                .is_some_and(|raw| raw.contains("\"chunk_count\":2"))
        );
        assert!(matches!(
            &ready[0].event,
            ConversationEvent::AssistantTextDelta { text, .. } if text == "hello"
        ));
        assert!(matches!(
            ready[1].event,
            ConversationEvent::TurnCompleted { .. }
        ));
    }

    #[test]
    fn shared_recorder_coalesces_consecutive_same_item_tool_call_upserts() {
        let mut coalescer = ConversationEventCoalescer::default();
        for idx in 0..10 {
            let emitted = coalescer.push(mapped_record(
                100 + idx,
                ConversationEvent::ToolCallUpsert {
                    tool_call: super::ConversationToolCallPatch {
                        tool_call_id: "tool-stream-1".to_string(),
                        title: (idx == 0).then(|| "Run cargo test".to_string()),
                        kind: (idx == 0).then(|| "execute".to_string()),
                        status: Some(if idx == 9 { "completed" } else { "running" }.to_string()),
                        raw_input: (idx == 0)
                            .then(|| serde_json::json!({ "command": "cargo test" })),
                        raw_output: Some(serde_json::json!(format!("output-step-{idx}"))),
                        raw_output_append: Some(format!("chunk-{idx}")),
                        content: Some(serde_json::json!({ "text": format!("output-step-{idx}") })),
                        locations: (idx == 0).then(|| {
                            vec![super::ConversationFileLocation {
                                path: "src/lib.rs".to_string(),
                                line: Some(42),
                                column: None,
                            }]
                        }),
                        metadata: (idx == 5).then(|| serde_json::json!({ "exitCode": 0 })),
                        images: Vec::new(),
                    },
                },
            ));
            assert!(
                emitted.is_empty(),
                "same tool_call_id upserts should stay buffered until flush"
            );
        }

        let flushed = coalescer.flush();
        assert_eq!(flushed.len(), 1);
        assert_eq!(flushed[0].idempotency_key, "agent:100-109:tool_call_upsert");
        assert!(
            flushed[0]
                .raw_json
                .as_deref()
                .is_some_and(|raw| raw.contains("\"chunk_count\":10"))
        );
        let ConversationEvent::ToolCallUpsert { tool_call } = &flushed[0].event else {
            panic!("expected coalesced ToolCallUpsert");
        };
        assert_eq!(tool_call.tool_call_id, "tool-stream-1");
        assert_eq!(tool_call.title.as_deref(), Some("Run cargo test"));
        assert_eq!(tool_call.kind.as_deref(), Some("execute"));
        assert_eq!(tool_call.status.as_deref(), Some("completed"));
        assert_eq!(
            tool_call.raw_input,
            Some(serde_json::json!({ "command": "cargo test" }))
        );
        assert_eq!(
            tool_call.raw_output,
            Some(serde_json::json!("output-step-9"))
        );
        assert_eq!(tool_call.locations.as_ref().map(Vec::len), Some(1));
        assert_eq!(
            tool_call.metadata,
            Some(serde_json::json!({ "exitCode": 0 }))
        );
    }

    #[test]
    fn shared_mapping_preserves_tool_metadata() {
        let metadata = serde_json::json!({ "file_path": "src/main.rs" });
        let image = agents::conversation::ImageData {
            data: "AAAA".to_string(),
            mime_type: "image/png".to_string(),
            uri: Some("assets/logo.png".to_string()),
            width: None,
            height: None,
        };
        let envelope = envelope(AgentEvent::ToolCall {
            tool_call: AgentToolCall {
                status: Some("completed".to_string()),
                content: Some(r#"{"ok":true}"#.to_string()),
                id: "tool-1".to_string(),
                title: "Edit file".to_string(),
                kind: Some("edit".to_string()),
                input_preview: None,
                meta: Some(metadata.clone()),
                images: vec![image.clone()],
            },
        });

        let mapped = map_agent_event(&envelope, Some(Uuid::new_v4()));
        assert!(matches!(
            mapped,
            Some(ConversationEvent::ToolCallUpsert { tool_call })
                if tool_call.metadata == Some(metadata) && tool_call.images == vec![image]
                    && tool_call.status.as_deref() == Some("completed")
                    && tool_call.raw_output == Some(serde_json::json!({ "ok": true }))
        ));
    }

    #[test]
    fn tool_call_update_can_rewrite_the_title() {
        let envelope = envelope(AgentEvent::ToolCallUpdate {
            update: AgentToolCallUpdate {
                id: "tool-1".to_string(),
                title: Some("vibex-delegation-mcp__delegate_to_agent".to_string()),
                status: Some("running".to_string()),
                content: None,
                input_preview: Some(r#"{"agent_type":"codex","task":"hi"}"#.to_string()),
                meta: None,
                images: Vec::new(),
            },
        });

        let mapped = map_agent_event(&envelope, Some(Uuid::new_v4()));
        assert!(matches!(
            mapped,
            Some(ConversationEvent::ToolCallUpsert { tool_call })
                if tool_call.title.as_deref()
                    == Some("vibex-delegation-mcp__delegate_to_agent")
        ));
    }

    #[test]
    fn shared_mapping_preserves_usage_cost() {
        let envelope = envelope(AgentEvent::Usage {
            usage: AgentUsage {
                used: 120,
                limit: Some(200_000),
                cost_amount: Some(0.42),
                cost_currency: Some("USD".to_string()),
                ..AgentUsage::default()
            },
        });

        let mapped = map_agent_event(&envelope, Some(Uuid::new_v4()));
        assert!(matches!(
            mapped,
            Some(ConversationEvent::UsageUpdated { usage })
                if usage.cost_amount == Some(0.42)
                    && usage.cost_currency.as_deref() == Some("USD")
                    && usage.context_used == Some(120)
                    && usage.input_tokens == 0
                    && usage.model.is_none()
        ));
    }

    #[test]
    fn shared_mapping_preserves_usage_model_and_token_breakdown() {
        let envelope = envelope(AgentEvent::Usage {
            usage: AgentUsage {
                used: 18_658,
                limit: Some(500_000),
                input_tokens: Some(29_214),
                output_tokens: Some(1_652),
                cache_read_tokens: Some(56_960),
                model: Some("grok-4.6".into()),
                ..AgentUsage::default()
            },
        });

        let mapped = map_agent_event(&envelope, Some(Uuid::new_v4()));
        assert!(matches!(
            mapped,
            Some(ConversationEvent::UsageUpdated { usage })
                if usage.model.as_deref() == Some("grok-4.6")
                    && usage.input_tokens == 29_214
                    && usage.output_tokens == 1_652
                    && usage.cache_read_input_tokens == 56_960
                    && usage.context_used == Some(18_658)
        ));
    }

    #[test]
    fn plan_updates_keep_status_and_priority() {
        let envelope = envelope(AgentEvent::Plan {
            plan: agents::AgentPlan {
                entries: vec![agents::AgentPlanEntry {
                    content: "Write tests".into(),
                    status: "in_progress".into(),
                    priority: Some("high".into()),
                }],
            },
        });
        let mapped = map_agent_event(&envelope, Some(Uuid::new_v4()));
        assert!(matches!(
            mapped,
            Some(ConversationEvent::PlanUpdated { entries })
                if entries.len() == 1
                    && entries[0].content == "Write tests"
                    && entries[0].status == "in_progress"
                    && entries[0].priority.as_deref() == Some("high")
        ));
    }

    #[test]
    fn session_info_updates_are_classified_as_acp_events() {
        assert_eq!(
            conversation_event_source(&AgentEvent::SessionInfoUpdated {
                patch: serde_json::json!({ "title": "Thread title" }),
            }),
            "acp"
        );
    }

    #[test]
    fn grok_announcements_are_persisted_as_typed_events() {
        let envelope = envelope(AgentEvent::AnnouncementsUpdated {
            generation: 3,
            notices: vec![agents::conversation::ConversationSessionNotice {
                title: "Grok CLI".into(),
                message: Some("A new version is available.".into()),
                severity: "info".into(),
                announcement_id: Some("cli-update".into()),
                action: Some(
                    agents::conversation::ConversationNoticeAction::UpdateAgent {
                        agent_id: agents::AgentId::parse("grok").expect("grok"),
                        fallback_url: None,
                    },
                ),
            }],
        });
        assert_eq!(conversation_event_source(&envelope.event), "acp");
        assert!(matches!(
            map_agent_event(&envelope, Some(Uuid::new_v4())),
            Some(ConversationEvent::AnnouncementsUpdated { generation, notices })
                if generation == 3 && notices.len() == 1 && notices[0].title == "Grok CLI"
        ));
    }

    #[test]
    fn agent_session_notices_are_persisted_as_diagnostics() {
        let envelope = envelope(AgentEvent::RawAcpDiagnostic {
            raw: serde_json::json!({
                "kind": agents::AGENT_SESSION_NOTICE_KIND,
                "title": "Skill descriptions were shortened to fit the skills context budget.",
                "message": "Disable unused skills or plugins to leave more room for the rest.",
                "severity": "warning",
            }),
        });

        assert_eq!(conversation_event_source(&envelope.event), "acp");
        assert!(matches!(
            map_agent_event(&envelope, Some(Uuid::new_v4())),
            Some(ConversationEvent::RawDiagnosticRecorded { label, payload })
                if label == agents::AGENT_SESSION_NOTICE_KIND
                    && payload
                        .as_ref()
                        .and_then(agents::session_notice_from_diagnostic)
                        .is_some_and(|notice| notice.severity == "warning")
        ));
    }

    #[test]
    fn unknown_acp_diagnostics_are_persisted() {
        let envelope = envelope(AgentEvent::RawAcpDiagnostic {
            raw: serde_json::json!({
                "kind": "session_config_override_skipped",
                "reason": "config_choice_not_found",
                "requested": "model=missing",
            }),
        });

        assert_eq!(conversation_event_source(&envelope.event), "acp");
        assert!(matches!(
            map_agent_event(&envelope, Some(Uuid::new_v4())),
            Some(ConversationEvent::RawDiagnosticRecorded { label, payload })
                if label == "session_config_override_skipped"
                    && payload.as_ref().and_then(|value| value["requested"].as_str())
                        == Some("model=missing")
        ));
    }

    #[test]
    fn cancelled_prompt_finish_is_turn_cancelled_not_completed() {
        for reason in ["cancelled", "Cancelled", "canceled"] {
            let envelope = envelope(AgentEvent::PromptFinished {
                finished: agents::AgentPromptFinished {
                    prompt_id: agents::AgentPromptId(Uuid::new_v4()),
                    stop_reason: Some(reason.to_string()),
                    usage: None,
                },
            });
            let mapped = map_agent_event(&envelope, Some(Uuid::new_v4()));
            assert!(
                matches!(
                    mapped,
                    Some(ConversationEvent::TurnCancelled { reason: Some(value) })
                        if value == reason
                ),
                "stop reason {reason} must settle as cancelled"
            );
        }
    }

    #[test]
    fn non_text_message_chunks_are_persisted_as_content_blocks() {
        let image = envelope(AgentEvent::MessageChunk {
            content: agents::AgentContentBlock::Image {
                data: "AAAA".into(),
                mime_type: "image/png".into(),
                uri: Some("https://example.com/a.png".into()),
            },
        });
        assert!(matches!(
            map_agent_event(&image, Some(Uuid::new_v4())),
            Some(ConversationEvent::AssistantContentAppended {
                block: agents::conversation::ContentBlock::Image { mime_type, .. },
                ..
            }) if mime_type == "image/png"
        ));

        let resource = envelope(AgentEvent::MessageChunk {
            content: agents::AgentContentBlock::Resource {
                uri: "file:///tmp/note.md".into(),
                title: Some("note".into()),
            },
        });
        assert!(matches!(
            map_agent_event(&resource, Some(Uuid::new_v4())),
            Some(ConversationEvent::AssistantContentAppended {
                block: agents::conversation::ContentBlock::Resource { uri, .. },
                ..
            }) if uri == "file:///tmp/note.md"
        ));
    }

    #[test]
    fn auth_required_errors_block_the_turn_instead_of_failing_it() {
        let envelope = envelope(AgentEvent::Error {
            error: agents::AgentErrorEvent {
                message: "please log in".into(),
                code: Some("auth_required".into()),
                raw: None,
            },
        });
        assert!(matches!(
            map_agent_event(&envelope, Some(Uuid::new_v4())),
            Some(ConversationEvent::TurnBlocked {
                reason: agents::conversation::TurnBlockedReason::Authentication { message }
            }) if message == "please log in"
        ));
    }

    #[test]
    fn idle_timeout_errors_fail_the_turn_with_the_idle_timeout_code() {
        let envelope = envelope(AgentEvent::Error {
            error: agents::AgentErrorEvent {
                message: "Agent stopped responding (idle timeout after 120s).".into(),
                code: Some("idle_timeout".into()),
                raw: None,
            },
        });
        assert!(matches!(
            map_agent_event(&envelope, Some(Uuid::new_v4())),
            Some(ConversationEvent::TurnFailed {
                error: agents::conversation::ConversationError { code: Some(code), .. }
            }) if code == "idle_timeout"
        ));
    }

    #[test]
    fn connection_closed_errors_fail_the_turn_with_the_connection_closed_code() {
        let envelope = envelope(AgentEvent::Error {
            error: agents::events::AgentErrorEvent {
                message: "Agent connection closed before the turn completed.".into(),
                code: Some("connection_closed".into()),
                raw: None,
            },
        });
        assert!(matches!(
            map_agent_event(&envelope, Some(Uuid::new_v4())),
            Some(ConversationEvent::TurnFailed {
                error: agents::conversation::ConversationError { code: Some(code), .. }
            }) if code == "connection_closed"
        ));
    }

    #[test]
    fn completed_prompt_finish_stays_turn_completed() {
        let envelope = envelope(AgentEvent::PromptFinished {
            finished: agents::AgentPromptFinished {
                prompt_id: agents::AgentPromptId(Uuid::new_v4()),
                stop_reason: Some("EndTurn".to_string()),
                usage: None,
            },
        });
        assert!(matches!(
            map_agent_event(&envelope, Some(Uuid::new_v4())),
            Some(ConversationEvent::TurnCompleted { stop_reason })
                if stop_reason.as_deref() == Some("EndTurn")
        ));
    }

    fn envelope(event: AgentEvent) -> AgentEventEnvelope {
        AgentEventEnvelope {
            sequence: 1,
            workspace_id: Uuid::new_v4(),
            connection_id: AgentConnectionId::new(),
            session_id: Some(AgentSessionId::new()),
            event,
            created_at: Utc::now(),
        }
    }

    fn mapped_record(sequence: i64, event: ConversationEvent) -> MappedConversationEventRecord {
        MappedConversationEventRecord {
            conversation_id: Uuid::nil(),
            turn_id: Some(Uuid::nil()),
            connection_id: "connection".to_string(),
            source: "acp",
            event_kind: conversation_event_kind(&event),
            event,
            raw_json: None,
            idempotency_key: format!("agent:{sequence}:test"),
            first_agent_sequence: sequence,
            last_agent_sequence: sequence,
            complete_reply: false,
        }
    }

    async fn setup_pool() -> SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("sqlite options")
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("connect memory db");
        sqlx::migrate!("../db/migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("disable foreign keys");
        pool
    }

    async fn setup_pool_with_foreign_keys() -> SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("sqlite options")
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("connect memory db");
        sqlx::migrate!("../db/migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&pool)
            .await
            .expect("enable foreign keys");
        pool
    }

    fn connection_ready_event() -> ConversationEvent {
        ConversationEvent::AgentConnectionStatusChanged {
            status: agents::conversation::ConversationAgentConnectionStatus::Ready,
        }
    }

    async fn seed_conversation_turn(
        pool: &SqlitePool,
        prompt_id: &str,
        preview: &str,
    ) -> (Uuid, Uuid) {
        let conversation_id = Uuid::new_v4();
        ConversationRecord::create(
            pool,
            conversation_id,
            CreateConversationRecord {
                workspace_id: Uuid::new_v4(),
                task_id: None,
                title: None,
                initial_prompt: None,
                status: None,
                executor: Some("agent"),
            },
        )
        .await
        .expect("create conversation");
        let turn = ConversationTurnRecord::create_pending(
            pool,
            Uuid::new_v4(),
            CreateConversationTurn {
                conversation_id,
                prompt_id: Some(prompt_id),
                text_preview: Some(preview),
                input_blocks_json: "[]",
            },
        )
        .await
        .expect("create turn");
        ConversationRecord::update_active_turn(pool, conversation_id, Some(turn.id))
            .await
            .expect("set active turn");
        (conversation_id, turn.id)
    }

    fn message_chunk() -> AgentEvent {
        AgentEvent::MessageChunk {
            content: AgentContentBlock::Text {
                text: "token".into(),
            },
        }
    }

    fn prompt_started(prompt_id: AgentPromptId, session_id: AgentSessionId) -> AgentEvent {
        let now = Utc::now();
        AgentEvent::PromptStarted {
            snapshot: AgentPromptSnapshot {
                id: prompt_id,
                session_id,
                status: AgentPromptStatus::Running,
                text_preview: "B".into(),
                created_at: now,
                updated_at: now,
            },
        }
    }

    #[tokio::test]
    async fn session_linked_writes_external_session_id() {
        let pool = setup_pool().await;
        let (conversation_id, _) = seed_conversation_turn(&pool, "prompt-1", "hello").await;

        persist_session_linked_external_id(&pool, conversation_id, "acp-live-session-9")
            .await
            .expect("persist SessionLinked");

        let session = Session::find_by_id(&pool, conversation_id)
            .await
            .expect("load session")
            .expect("session exists");
        assert_eq!(
            session.external_session_id.as_deref(),
            Some("acp-live-session-9")
        );
    }

    #[test]
    fn session_bind_ready_is_not_persisted_as_a_conversation_event() {
        let envelope = envelope(AgentEvent::SessionBindReady {
            acp_session_id: "acp-live-session-9".into(),
        });
        assert!(map_agent_event(&envelope, None).is_none());
    }

    #[tokio::test]
    async fn post_completion_events_do_not_pin_the_next_turn_to_the_previous() {
        let pool = setup_pool().await;
        let prompt_a = AgentPromptId::new();
        let (conversation_id, turn_a) =
            seed_conversation_turn(&pool, &prompt_a.to_string(), "A").await;

        let first = resolve_agent_event_turn_id(&pool, conversation_id, &message_chunk())
            .await
            .expect("bind A stream");
        assert_eq!(first, Some(turn_a));

        ConversationTurnRecord::mark_completed(&pool, turn_a, Some("end_turn"), None, None)
            .await
            .expect("complete A");

        let usage = resolve_agent_event_turn_id(
            &pool,
            conversation_id,
            &AgentEvent::Usage {
                usage: AgentUsage::default(),
            },
        )
        .await
        .expect("bind usage");
        assert_eq!(usage, Some(turn_a));

        let prompt_b = AgentPromptId::new();
        let turn_b = ConversationTurnRecord::create_pending(
            &pool,
            Uuid::new_v4(),
            CreateConversationTurn {
                conversation_id,
                prompt_id: Some(&prompt_b.to_string()),
                text_preview: Some("B"),
                input_blocks_json: "[]",
            },
        )
        .await
        .expect("create B")
        .id;
        ConversationRecord::update_active_turn(&pool, conversation_id, Some(turn_b))
            .await
            .expect("activate B");

        let started = resolve_agent_event_turn_id(
            &pool,
            conversation_id,
            &prompt_started(prompt_b, AgentSessionId(conversation_id)),
        )
        .await
        .expect("bind PromptStarted");
        assert_eq!(started, Some(turn_b));

        let second = resolve_agent_event_turn_id(&pool, conversation_id, &message_chunk())
            .await
            .expect("bind B stream");
        assert_eq!(
            second,
            Some(turn_b),
            "B's stream must not inherit A's turn id"
        );
    }

    #[tokio::test]
    async fn completed_active_pointer_does_not_capture_the_next_message_chunk() {
        let pool = setup_pool().await;
        let prompt_a = AgentPromptId::new();
        let (conversation_id, turn_a) =
            seed_conversation_turn(&pool, &prompt_a.to_string(), "A").await;
        ConversationTurnRecord::mark_completed(&pool, turn_a, Some("end_turn"), None, None)
            .await
            .expect("complete A");

        let orphan = resolve_agent_event_turn_id(&pool, conversation_id, &message_chunk())
            .await
            .expect("refuse completed pointer");
        assert_eq!(orphan, None);

        let prompt_b = AgentPromptId::new();
        let turn_b = ConversationTurnRecord::create_pending(
            &pool,
            Uuid::new_v4(),
            CreateConversationTurn {
                conversation_id,
                prompt_id: Some(&prompt_b.to_string()),
                text_preview: Some("B"),
                input_blocks_json: "[]",
            },
        )
        .await
        .expect("create B")
        .id;
        ConversationRecord::update_active_turn(&pool, conversation_id, Some(turn_b))
            .await
            .expect("activate B");

        let second = resolve_agent_event_turn_id(&pool, conversation_id, &message_chunk())
            .await
            .expect("bind B");
        assert_eq!(second, Some(turn_b));
    }

    /// Regression: a user cancel settles the Turn and nulls the active pointer
    /// without passing through this recorder. The agent's still-arriving output must
    /// be dropped, not attributed to the Turn the user stopped or to the next one.
    #[tokio::test]
    async fn a_cancelled_turns_trailing_output_is_dropped_immediately() {
        let pool = setup_pool().await;
        let prompt_a = AgentPromptId::new();
        let (conversation_id, turn_a) =
            seed_conversation_turn(&pool, &prompt_a.to_string(), "A").await;

        assert_eq!(
            resolve_agent_event_turn_id(&pool, conversation_id, &message_chunk())
                .await
                .expect("bind while in flight"),
            Some(turn_a)
        );

        // What `ConversationSessionService::cancel_turn` does, in its order.
        ConversationTurnRecord::mark_cancelled(&pool, turn_a, Some("user cancelled"))
            .await
            .expect("cancel A");
        ConversationRecord::update_active_turn(&pool, conversation_id, None)
            .await
            .expect("clear active turn");

        let trailing = resolve_agent_event_turn_id(&pool, conversation_id, &message_chunk())
            .await
            .expect("resolve trailing chunk");
        assert_eq!(
            trailing, None,
            "a cancelled turn's trailing output must not be attributed to any turn"
        );
        assert!(
            is_turn_scoped_content(&message_chunk()),
            "turn content with no in-flight turn is dropped by `map_record`"
        );
    }

    #[test]
    fn connection_status_with_a_session_maps_to_conversation_status() {
        let snapshot = agents::state::AgentConnectionSnapshot {
            id: AgentConnectionId::new(),
            agent_id: agents::AgentId::parse("codex").expect("agent"),
            workspace_id: Uuid::new_v4(),
            status: agents::state::AgentConnectionStatus::Recovering,
            working_dir: "/tmp".into(),
            status_message: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        assert!(matches!(
            map_agent_event(
                &envelope(AgentEvent::ConnectionStatusChanged { snapshot }),
                None
            ),
            Some(ConversationEvent::AgentConnectionStatusChanged {
                status: agents::conversation::ConversationAgentConnectionStatus::Recovering
            })
        ));
    }

    #[test]
    fn an_untethered_error_is_recorded_as_a_binding_failure_rather_than_dropped() {
        let error = AgentEvent::Error {
            error: agents::events::AgentErrorEvent {
                message: "agent exited before session/new".to_string(),
                code: None,
                raw: None,
            },
        };

        // Errors resolve to the in-flight Turn or to nothing — never to a settled one.
        assert!(binds_only_to_in_flight_turn(&error));
        // But unlike Turn content they still carry conversation-level meaning, so
        // `map_record` must not drop them: a failed binding recovery the user never
        // sees is how "nothing happens when I send" became unexplainable.
        assert!(!is_turn_scoped_content(&error));
        assert!(matches!(
            map_agent_event(&envelope(error), None),
            Some(ConversationEvent::AgentBindingRecoveryFailed { .. })
        ));
    }

    #[tokio::test]
    async fn missing_conversation_rows_skip_the_event_instead_of_failing_the_batch() {
        let pool = setup_pool_with_foreign_keys().await;
        let mapped = mapped_record(1, connection_ready_event());
        let normalized = serde_json::to_string(&mapped.event).expect("serialize");

        let skipped = append_mapped_event(&pool, &mapped, &normalized)
            .await
            .expect("a missing conversation is skippable");
        assert!(
            skipped.is_none(),
            "events for an unknown conversation must not abort the recorder"
        );

        let mut connect_event = mapped_record(2, connection_ready_event());
        connect_event.turn_id = None;
        let connect_normalized = serde_json::to_string(&connect_event.event).expect("serialize");
        let skipped_connect = append_mapped_event(&pool, &connect_event, &connect_normalized)
            .await
            .expect("connect-time events without a turn are skippable");
        assert!(
            skipped_connect.is_none(),
            "bind/status events for an unknown conversation must not abort the recorder"
        );
    }

    #[tokio::test]
    async fn missing_turn_rows_are_persisted_on_the_conversation() {
        let pool = setup_pool().await;
        let (conversation_id, _) = seed_conversation_turn(&pool, "prompt-1", "hello").await;
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&pool)
            .await
            .expect("enable foreign keys");

        let mut mapped = mapped_record(1, connection_ready_event());
        mapped.conversation_id = conversation_id;
        mapped.turn_id = Some(Uuid::new_v4());
        let normalized = serde_json::to_string(&mapped.event).expect("serialize");

        let record = append_mapped_event(&pool, &mapped, &normalized)
            .await
            .expect("retry without turn")
            .expect("event persisted");
        assert_eq!(record.conversation_id, conversation_id);
        assert_eq!(record.turn_id, None);
    }

    #[tokio::test]
    async fn resilient_agent_event_loop_recovers_after_panic_and_keeps_receiver_alive() {
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };

        use tokio::sync::mpsc;

        let pool = setup_pool().await;
        let (tx, rx) = mpsc::channel(16);
        let processed = Arc::new(AtomicUsize::new(0));
        let processed_clone = Arc::clone(&processed);

        let handle = super::start_agent_event_persistence_loop(
            move || super::ConversationAgentEventRecorder {
                pool: pool.clone(),
                deployment: None,
                conversation_context: None,
                event_publisher: None,
                coalescer: super::ConversationEventCoalescer::default(),
                active_turn_cache: std::collections::HashMap::new(),
                cached_turn_epoch: db::models::conversation::active_turn_mutation_epoch(),
                turn_db_lookups: 0,
            },
            rx,
            move |env| {
                if env.sequence == 1 {
                    panic!("simulated panic on malformed event");
                }
                processed_clone.fetch_add(1, Ordering::SeqCst);
            },
        );

        let mut env1 = envelope(message_chunk());
        env1.sequence = 1;
        tx.send(env1).await.expect("send first event");

        let mut env2 = envelope(message_chunk());
        env2.sequence = 2;
        tx.send(env2)
            .await
            .expect("receiver must stay open after worker panic");

        drop(tx);
        handle.await.expect("loop task finishes cleanly");
        assert_eq!(
            processed.load(Ordering::SeqCst),
            1,
            "second event after panic must still be processed"
        );
    }

    #[tokio::test]
    async fn streaming_100_message_chunks_caches_active_turn_and_skips_per_chunk_raw_json() {
        use std::sync::{Arc, Mutex};

        #[derive(Default)]
        struct CapturingPublisher {
            unpersisted: Mutex<Vec<db::models::conversation_event::ConversationEventRecord>>,
        }

        #[async_trait::async_trait]
        impl crate::ConversationEventPublisher for CapturingPublisher {
            async fn publish(
                &self,
                _record: &db::models::conversation_event::ConversationEventRecord,
            ) {
            }

            async fn publish_unpersisted(
                &self,
                record: &db::models::conversation_event::ConversationEventRecord,
            ) {
                self.unpersisted.lock().unwrap().push(record.clone());
            }
        }

        let pool = setup_pool().await;
        let prompt_id = AgentPromptId::new();
        let (conversation_id, turn_id) =
            seed_conversation_turn(&pool, &prompt_id.to_string(), "stream test").await;
        let publisher = Arc::new(CapturingPublisher::default());
        let connection_id = AgentConnectionId::new();

        let mut recorder = super::ConversationAgentEventRecorder {
            pool: pool.clone(),
            deployment: None,
            conversation_context: None,
            event_publisher: Some(publisher.clone()),
            coalescer: super::ConversationEventCoalescer::default(),
            active_turn_cache: std::collections::HashMap::new(),
            cached_turn_epoch: db::models::conversation::active_turn_mutation_epoch(),
            turn_db_lookups: 0,
        };

        let mut expected_text = String::new();
        for seq in 1..=100_i64 {
            let token = format!("tok-{seq} ");
            expected_text.push_str(&token);
            let env = AgentEventEnvelope {
                sequence: seq,
                workspace_id: Uuid::new_v4(),
                connection_id: connection_id.clone(),
                session_id: Some(AgentSessionId(conversation_id)),
                event: AgentEvent::MessageChunk {
                    content: AgentContentBlock::Text { text: token },
                },
                created_at: Utc::now(),
            };
            let batch = recorder
                .record_buffered(&env)
                .await
                .expect("record buffered chunk");
            assert!(batch.events.is_empty());
            assert!(
                recorder
                    .coalescer
                    .pending
                    .as_ref()
                    .expect("pending delta exists")
                    .base
                    .raw_json
                    .is_none(),
                "per-chunk map_record must not serialize raw_json for transcript deltas"
            );
        }

        assert_eq!(
            recorder.turn_db_lookups, 1,
            "100 consecutive streaming chunks must query SQLite at most once for active_turn_id"
        );

        let flushed = recorder
            .flush_buffered()
            .await
            .expect("flush buffered chunks");
        assert!(flushed.events.is_empty());
        assert_eq!(recorder.turn_db_lookups, 1);

        let published = publisher.unpersisted.lock().unwrap();
        assert_eq!(published.len(), 1);
        assert_eq!(published[0].conversation_id, conversation_id);
        assert_eq!(published[0].turn_id, Some(turn_id));
        assert_eq!(published[0].event_kind, "assistant_text_delta");
        let event: ConversationEvent =
            serde_json::from_str(&published[0].normalized_json).expect("deserialize delta");
        assert!(matches!(
            event,
            ConversationEvent::AssistantTextDelta { text, message_id: None }
                if text == expected_text
        ));
    }
}
