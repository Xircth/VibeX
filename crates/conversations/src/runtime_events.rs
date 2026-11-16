//! Durable projection of agent-runtime events into the conversation event log.
//!
//! Both desktop and headless hosts consume the same `AgentRuntime` protocol. This
//! recorder keeps persistence independent of either Tauri or an HTTP transport;
//! adapters can observe the resulting conversation log through their normal
//! snapshot/replay seam.

mod coalescer;
mod mapping;
#[cfg(test)]
mod tests_coalescer;
#[cfg(test)]
mod tests_recorder;

use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use agents::{
    AgentConnectionStatus, AgentEvent, AgentEventEnvelope,
    conversation::{ConversationEvent, ConversationEventEnvelope},
};
use chrono::Utc;
use db::models::{
    conversation::{ConversationAgentBindingRecord, DbConversationSummary},
    conversation_event::{CURRENT_EVENT_VERSION, ConversationEventRecord},
    conversation_turn::ConversationTurnRecord,
};
use deployment::Deployment;
use sqlx::SqlitePool;
use tokio::{sync::mpsc, task::JoinHandle};
use uuid::Uuid;

pub(crate) use self::mapping::space_turn_conclusion_text;
use self::{
    coalescer::{StreamingThrottleCoalescer, is_coalesceable_conversation_event},
    mapping::{
        MappedConversationEventRecord, attach_cached_plan_usage, bind_prompt_turn,
        binds_only_to_in_flight_turn, conversation_event_idempotency_key, conversation_event_kind,
        conversation_event_source, in_flight_active_turn_id, is_terminal_conversation_event,
        is_turn_scoped_content, is_unpersisted_conversation_event, map_agent_event,
        persist_session_linked_external_id, request_activity_turn_id, resolve_agent_event_turn_id,
    },
};
use crate::{
    BatchConversationEvent, ConversationContext, ConversationEventAppender,
    ConversationEventPublisher, ConversationProjector, ConversationServiceError,
    ConversationSessionService,
    commit_reminder::{is_complete_ai_reply, start_commit_reminder_if_needed},
    prepare_checkpoint_file_changes,
};

/// Transport-neutral recorder used by all application hosts.
pub struct ConversationAgentEventRecorder {
    pool: SqlitePool,
    deployment: Option<Arc<dyn Deployment>>,
    conversation_context: Option<ConversationContext>,
    event_publisher: Option<Arc<dyn ConversationEventPublisher>>,
    coalescer: StreamingThrottleCoalescer,
    active_turn_cache: HashMap<Uuid, Option<Uuid>>,
    cached_turn_epoch: u64,
    pending_step_text: HashMap<Uuid, String>,
    turn_had_tool_call: HashSet<Uuid>,
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

enum PendingBatchEntry {
    CheckpointFileChange {
        batch_event: BatchConversationEvent,
    },
    Mapped {
        mapped: Box<MappedConversationEventRecord>,
        batch_event: BatchConversationEvent,
    },
}

impl PendingBatchEntry {
    fn batch_event(&self) -> &BatchConversationEvent {
        match self {
            Self::CheckpointFileChange { batch_event } | Self::Mapped { batch_event, .. } => {
                batch_event
            }
        }
    }

    fn emit_kind(&self) -> &str {
        match self {
            Self::CheckpointFileChange { .. } => "file_change",
            Self::Mapped { mapped, .. } => &mapped.event_kind,
        }
    }
}

impl ConversationAgentEventRecorder {
    pub fn new(pool: SqlitePool, deployment: Arc<dyn Deployment>) -> Self {
        Self {
            pool,
            deployment: Some(deployment),
            conversation_context: None,
            event_publisher: None,
            coalescer: StreamingThrottleCoalescer::new(),
            active_turn_cache: HashMap::new(),
            cached_turn_epoch: db::models::conversation::active_turn_mutation_epoch(),
            pending_step_text: HashMap::new(),
            turn_had_tool_call: HashSet::new(),
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
            coalescer: StreamingThrottleCoalescer::new(),
            active_turn_cache: HashMap::new(),
            cached_turn_epoch: db::models::conversation::active_turn_mutation_epoch(),
            pending_step_text: HashMap::new(),
            turn_had_tool_call: HashSet::new(),
            #[cfg(test)]
            turn_db_lookups: 0,
        }
    }

    /// Adaptive idle deadline for buffered streaming deltas (`IDLE_FLUSH_CEILING = 800ms`).
    pub fn next_idle_deadline(&self) -> Option<tokio::time::Instant> {
        self.coalescer.next_idle_deadline()
    }

    /// Flush only conversations whose throttle/idle deadline has elapsed.
    pub async fn flush_due(
        &mut self,
    ) -> Result<RecordedConversationBatch, RuntimeEventRecordError> {
        let records = self.coalescer.flush_due(tokio::time::Instant::now());
        self.append_records(records).await
    }

    /// Persist one runtime envelope immediately, flushing any buffered deltas ahead of it.
    pub async fn record(
        &mut self,
        envelope: &AgentEventEnvelope,
    ) -> Result<RecordedConversationBatch, RuntimeEventRecordError> {
        let mut records = self.coalescer.flush_all();
        if let Some(record) = self.map_record(envelope).await? {
            records.push(record);
        }
        self.append_records(records).await
    }

    /// Throttle and coalesce streaming chunks (400ms Markdown block boundary / 800ms idle /
    /// 64 KiB cap / strict non-delta barrier) and batch-commit every ready record.
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

    /// Force-persist all buffered streaming tails (used on cancel, EOF, and shutdown).
    pub async fn flush_buffered(
        &mut self,
    ) -> Result<RecordedConversationBatch, RuntimeEventRecordError> {
        let records = self.coalescer.flush_all();
        self.append_records(records).await
    }

    /// Force-persist buffered streaming tails for one conversation.
    pub async fn flush_conversation(
        &mut self,
        conversation_id: Uuid,
    ) -> Result<RecordedConversationBatch, RuntimeEventRecordError> {
        let records = self.coalescer.flush_conversation(conversation_id);
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
        if let AgentEvent::SessionInvalidated { reason } = &envelope.event {
            ConversationAgentBindingRecord::invalidate_connection(
                &self.pool,
                conversation_id,
                &envelope.connection_id.to_string(),
                reason,
            )
            .await?;
            return Ok(None);
        }
        if agents::transcript_target::is_retired(envelope.connection_id) {
            return Ok(None);
        }
        let active_binding =
            ConversationAgentBindingRecord::active_for_conversation(&self.pool, conversation_id)
                .await?;
        let connection = envelope.connection_id.to_string();
        if self.conversation_context.is_some()
            && matches!(envelope.event, AgentEvent::SessionLinked { .. })
            && active_binding
                .as_ref()
                .and_then(|b| b.connection_id.as_deref())
                != Some(connection.as_str())
        {
            return Ok(None);
        }
        if active_binding
            .as_ref()
            .and_then(|b| b.connection_id.as_deref())
            .is_some_and(|id| id != connection)
        {
            let is_current_runtime = if let Some(context) = &self.conversation_context {
                context.agent_runtime.live_connection_id(session_id).await
                    == Some(envelope.connection_id)
            } else {
                false
            };
            if !is_current_runtime {
                tracing::debug!(%conversation_id, %connection, "dropped retired binding event");
                return Ok(None);
            }
        }
        let mut binding_id = active_binding.as_ref().map(|b| b.id);
        if active_binding.as_ref().is_some_and(|b| !b.resume_allowed) {
            let is_current_runtime = if let Some(context) = &self.conversation_context {
                context.agent_runtime.live_connection_id(session_id).await
                    == Some(envelope.connection_id)
            } else {
                false
            };
            if !is_current_runtime {
                return Ok(None);
            }
        }
        if let AgentEvent::PromptAccepted { prompt_id } = &envelope.event {
            crate::handoff::accept(
                &self.pool,
                conversation_id,
                &connection,
                &prompt_id.to_string(),
            )
            .await?;
            return Ok(None);
        }
        let turn_id = self.event_turn_id(conversation_id, &envelope.event).await?;
        if turn_id.is_none()
            && (is_turn_scoped_content(&envelope.event)
                || matches!(envelope.event, AgentEvent::RequestActivity { .. }))
        {
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
        if let ConversationEvent::AgentBindingLoadFailed { reason } = &event
            && matches!(
                reason,
                agents::conversation::SessionLoadFailureReason::ResourceNotFound
                    | agents::conversation::SessionLoadFailureReason::SessionUnavailable
            )
            && !crate::service::binding::conversation_has_recorded_turns(
                &self.pool,
                conversation_id,
            )
            .await?
        {
            tracing::debug!(
                %conversation_id,
                code = reason.code(),
                "skipping AgentBindingLoadFailed notice for unprompted 0-turn conversation"
            );
            return Ok(None);
        }
        attach_cached_plan_usage(&self.pool, conversation_id, &mut event).await;

        if let AgentEvent::SessionLinked {
            acp_session_id,
            agent_id,
            ..
        } = &envelope.event
        {
            if agents::is_placeholder_acp_session_id(acp_session_id) {
                tracing::error!(
                    %conversation_id,
                    acp_session_id,
                    "refusing to persist a placeholder ACP session id via SessionLinked"
                );
            } else {
                let binding = ConversationAgentBindingRecord::link_native_session(
                    &self.pool,
                    conversation_id,
                    agent_id,
                    "",
                    acp_session_id,
                    &connection,
                )
                .await?;
                binding_id = Some(binding.id);
                persist_session_linked_external_id(
                    &self.pool,
                    conversation_id,
                    acp_session_id,
                    agent_id,
                )
                .await?;
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
        let raw_json = if is_unpersisted_conversation_event(&event)
            || is_coalesceable_conversation_event(&event)
            || matches!(
                envelope.event,
                AgentEvent::ConnectionStatusChanged { .. } | AgentEvent::RequestActivity { .. }
            ) {
            None
        } else {
            Some(serde_json::to_string(&envelope.event)?)
        };
        let connection_id = envelope.connection_id.to_string();
        let idempotency_key = conversation_event_idempotency_key(
            conversation_id,
            envelope.connection_id,
            envelope.sequence,
            &event,
        );
        let complete_reply = matches!(
            &envelope.event,
            AgentEvent::PromptFinished { finished }
                if is_complete_ai_reply(finished.stop_reason.as_deref())
        );

        Ok(Some(MappedConversationEventRecord {
            conversation_id,
            turn_id,
            binding_id,
            connection_id,
            prompt_id: match &envelope.event {
                AgentEvent::RequestActivity { prompt_id, .. } => Some(prompt_id.to_string()),
                AgentEvent::PromptStarted { snapshot } => Some(snapshot.id.to_string()),
                AgentEvent::PromptFinished { finished } => Some(finished.prompt_id.to_string()),
                _ => None,
            },
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
        if records.is_empty() {
            return Ok(batch);
        }

        let mut streaming_updated_conversations = std::collections::BTreeSet::new();
        let mut entries: Vec<PendingBatchEntry> = Vec::with_capacity(records.len());

        // Phase 1 (outside `BEGIN IMMEDIATE`): serialize, emit pure transient hints, and
        // pre-compute git checkpoint diffs on ReadPool + filesystem before taking any write lock.
        for mapped in records {
            if self.observe_space_mid_turn(&mapped) {
                streaming_updated_conversations.insert(mapped.conversation_id);
            }
            let normalized_json = serde_json::to_string(&mapped.event)?;
            if is_unpersisted_conversation_event(&mapped.event) {
                if let Some(publisher) = &self.event_publisher {
                    let record = ephemeral_record(&mapped, &normalized_json);
                    publisher.publish_unpersisted(&record).await;
                }
                continue;
            }

            let terminal = is_terminal_conversation_event(&mapped.event);
            let mut checkpoint_update = None;
            if terminal
                && let Some(turn_id) = mapped.turn_id
                && let Some(deployment) = self.deployment.as_deref()
                && let Some(prepared) =
                    prepare_checkpoint_file_changes(deployment, mapped.conversation_id, turn_id)
                        .await?
            {
                match prepared.event {
                    Some((_file_ev, file_batch_ev)) => {
                        entries.push(PendingBatchEntry::CheckpointFileChange {
                            batch_event: file_batch_ev,
                        });
                    }
                    None => {
                        checkpoint_update = Some(prepared.metadata);
                    }
                }
            }

            let batch_event = batch_event_from_mapped(
                &mapped,
                normalized_json,
                mapped.turn_id,
                checkpoint_update,
            );
            entries.push(PendingBatchEntry::Mapped {
                mapped: Box::new(mapped),
                batch_event,
            });
        }

        // Phase 2: Single micro-batch `BEGIN IMMEDIATE` write transaction + SAVEPOINT isolation.
        if !entries.is_empty() {
            let batch_inputs: Vec<BatchConversationEvent> = entries
                .iter()
                .map(|entry| entry.batch_event().clone())
                .collect();
            let outcome = ConversationEventAppender::append_batch(&self.pool, &batch_inputs).await?;

            let mut committed_pairs: Vec<(usize, ConversationEventRecord)> = outcome
                .committed
                .into_iter()
                .filter(|c| !c.duplicate)
                .map(|c| (c.index, c.record))
                .collect();

            let mut fk_retry_indices: Vec<usize> = Vec::new();
            let mut fk_retry_inputs: Vec<BatchConversationEvent> = Vec::new();
            for (failed_idx, error) in outcome.failed {
                if !is_foreign_key_constraint(&error) {
                    return Err(error.into());
                }
                let src = entries[failed_idx].batch_event();
                if src.turn_id.is_some() {
                    let mut retry = src.clone();
                    retry.id = Uuid::new_v4();
                    retry.turn_id = None;
                    retry.checkpoint_update = None;
                    fk_retry_indices.push(failed_idx);
                    fk_retry_inputs.push(retry);
                } else {
                    tracing::debug!(
                        conversation_id = %src.conversation_id,
                        %error,
                        "skipped conversation event that could not be persisted"
                    );
                }
            }

            if !fk_retry_inputs.is_empty() {
                let retry_outcome =
                    ConversationEventAppender::append_batch(&self.pool, &fk_retry_inputs).await?;
                for committed in retry_outcome.committed {
                    if !committed.duplicate {
                        committed_pairs
                            .push((fk_retry_indices[committed.index], committed.record));
                    }
                }
                for (retry_idx, error) in retry_outcome.failed {
                    if !is_foreign_key_constraint(&error) {
                        return Err(error.into());
                    }
                    let orig_idx = fk_retry_indices[retry_idx];
                    let src = entries[orig_idx].batch_event();
                    tracing::debug!(
                        conversation_id = %src.conversation_id,
                        %error,
                        "skipped conversation event that could not be persisted after turnless retry"
                    );
                }
            }

            committed_pairs.sort_by_key(|(_, rec)| rec.sequence);

            // Phase 3 (post-`COMMIT`): plugin runtime event notifications, single batched live
            // row-op publish, and async collaboration/completion side effects.
            let mut committed_records: Vec<ConversationEventRecord> =
                Vec::with_capacity(committed_pairs.len());
            for (entry_idx, record) in &committed_pairs {
                let durable = ConversationEventEnvelope {
                    id: record.id,
                    conversation_id: record.conversation_id,
                    turn_id: record.turn_id,
                    sequence: record.sequence,
                    source: record.source.clone(),
                    event: serde_json::from_str(&record.normalized_json)?,
                    created_at: record.created_at,
                };
                crate::service::emit_runtime_event(&durable, entries[*entry_idx].emit_kind());
                batch.events.push(durable);
                committed_records.push(record.clone());
            }

            if let Some(publisher) = &self.event_publisher
                && !committed_records.is_empty()
            {
                publisher.publish_batch(&committed_records).await;
            }

            for (entry_idx, _record) in committed_pairs {
                let PendingBatchEntry::Mapped { mapped, .. } = &entries[entry_idx] else {
                    continue;
                };
                self.run_post_commit_side_effects(
                    mapped,
                    &mut streaming_updated_conversations,
                    &mut batch,
                )
                .await?;
            }
        }

        if !streaming_updated_conversations.is_empty() {
            let pool = self.pool.clone();
            let delivery_ctx = self.delivery_context();
            tokio::spawn(async move {
                for conversation_id in streaming_updated_conversations {
                    crate::collaboration::notify_space_turn_streaming(
                        &pool,
                        conversation_id,
                        &delivery_ctx,
                    )
                    .await;
                }
            });
        }
        Ok(batch)
    }

    async fn run_post_commit_side_effects(
        &mut self,
        mapped: &MappedConversationEventRecord,
        streaming_updated_conversations: &mut std::collections::BTreeSet<Uuid>,
        batch: &mut RecordedConversationBatch,
    ) -> Result<(), RuntimeEventRecordError> {
        let terminal = is_terminal_conversation_event(&mapped.event);
        if let Some(context) = &self.conversation_context {
            match &mapped.event {
                ConversationEvent::PermissionRequested { request } => {
                    let mut states = context.runtime_states.lock().await;
                    states
                        .entry(mapped.conversation_id)
                        .or_default()
                        .pending_permission_id = Some(request.permission_id.clone());
                }
                ConversationEvent::PermissionResponded { permission_id, .. } => {
                    let mut states = context.runtime_states.lock().await;
                    if let Some(state) = states.get_mut(&mapped.conversation_id)
                        && state.pending_permission_id.as_deref() == Some(permission_id.as_str())
                    {
                        state.pending_permission_id = None;
                    }
                }
                ConversationEvent::QuestionRequested { request } => {
                    let mut states = context.runtime_states.lock().await;
                    states
                        .entry(mapped.conversation_id)
                        .or_default()
                        .pending_question_id = Some(request.question_id.clone());
                }
                ConversationEvent::QuestionResponded { question_id, .. } => {
                    let mut states = context.runtime_states.lock().await;
                    if let Some(state) = states.get_mut(&mapped.conversation_id)
                        && state.pending_question_id.as_deref() == Some(question_id.as_str())
                    {
                        state.pending_question_id = None;
                    }
                }
                ConversationEvent::TurnBlocked {
                    reason: agents::conversation::TurnBlockedReason::Authentication { .. },
                } => {
                    let mut states = context.runtime_states.lock().await;
                    if let Some(state) = states.get_mut(&mapped.conversation_id) {
                        state.turn_in_flight = false;
                        state.active_turn_id = None;
                        state.active_prompt_id = None;
                        state.pending_permission_id = None;
                        state.pending_question_id = None;
                        state.recovery_status = Some("auth_required".to_string());
                    }
                }
                _ if terminal => {
                    let mut states = context.runtime_states.lock().await;
                    if let Some(state) = states.get_mut(&mapped.conversation_id) {
                        state.pending_permission_id = None;
                        state.pending_question_id = None;
                    }
                }
                _ => {}
            }
        }

        match &mapped.event {
            ConversationEvent::QuestionRequested { request } => {
                let delivery_ctx = self.delivery_context();
                if let Err(error) = crate::collaboration_cards::post_elicitation_question_if_seated(
                    &self.pool,
                    mapped.conversation_id,
                    &request.question_id,
                    &request.prompt,
                    request.schema.as_ref(),
                    &delivery_ctx,
                )
                .await
                {
                    tracing::warn!(
                        conversation_id = %mapped.conversation_id,
                        question_id = %request.question_id,
                        error = %error.message,
                        "failed to post collab IM card for elicitation"
                    );
                }
            }
            ConversationEvent::QuestionResponded {
                question_id,
                response,
            } => {
                let answer = if response.answer.trim().is_empty() {
                    "已跳过"
                } else {
                    response.answer.as_str()
                };
                let delivery_ctx = self.delivery_context();
                if let Err(error) = crate::collaboration_cards::resolve_elicitation_question_card(
                    &self.pool,
                    question_id,
                    answer,
                    &delivery_ctx,
                )
                .await
                {
                    tracing::warn!(
                        conversation_id = %mapped.conversation_id,
                        question_id = %question_id,
                        error = %error.message,
                        "failed to settle collab IM card for elicitation"
                    );
                }
            }
            _ => {}
        }

        if terminal && let Some(turn_id) = mapped.turn_id {
            crate::handoff::settle(&self.pool, turn_id).await?;
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

        if terminal {
            let conversation_id = mapped.conversation_id;
            streaming_updated_conversations.remove(&conversation_id);
            let leftover_step_text = self
                .pending_step_text
                .remove(&conversation_id)
                .unwrap_or_default();
            let had_tool_call = self.turn_had_tool_call.remove(&conversation_id);
            crate::collaboration::clear_space_turn_tool_started(conversation_id);
            let is_completed = matches!(&mapped.event, ConversationEvent::TurnCompleted { .. });
            if !is_completed {
                crate::collaboration::reset_space_turn_streaming_step(conversation_id);
            }
            let pool_for_collab = self.pool.clone();
            let delivery_ctx = self.delivery_context();
            let next_input_context = self.conversation_context.clone();
            tokio::spawn(async move {
                let reply = if is_completed {
                    load_latest_assistant_conclusion(
                        &pool_for_collab,
                        conversation_id,
                        had_tool_call,
                        &leftover_step_text,
                    )
                    .await
                } else {
                    String::new()
                };
                if let Err(error) = crate::collaboration::finalize_space_turn_deliveries(
                    &pool_for_collab,
                    conversation_id,
                    &reply,
                    &delivery_ctx,
                )
                .await
                {
                    tracing::warn!(
                        %conversation_id,
                        %error,
                        "failed to finalize collaboration space turn deliveries"
                    );
                }
                crate::collaboration::reset_space_turn_streaming_step(conversation_id);
                let _ = crate::collaboration::release_member_write(
                    &pool_for_collab,
                    conversation_id,
                )
                .await;
                if let Some(context) = next_input_context
                    && let Err(error) = ConversationSessionService::new(context)
                        .dispatch_next_queued_input(conversation_id)
                        .await
                {
                    tracing::warn!(
                        %conversation_id,
                        %error,
                        "failed to dispatch the next durable conversation input"
                    );
                }
                if let Err(error) =
                    crate::collaboration::redeliver_deferred(&pool_for_collab, &delivery_ctx).await
                {
                    tracing::warn!(
                        %conversation_id,
                        %error,
                        "failed to redeliver deferred collaboration space messages on turn end"
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
                    let memory_pool = self.pool.clone();
                    let memory_context = context.clone();
                    tokio::spawn(async move {
                        match crate::member_memory::record_turn_activity(
                            &memory_pool,
                            conversation_id,
                            turn_id,
                        )
                        .await
                        {
                            Ok(Some(_)) => {
                                crate::member_memory::schedule_post_turn_memory_review_with_context(
                                    memory_context,
                                    memory_pool,
                                    conversation_id,
                                );
                            }
                            Ok(None) => {}
                            Err(error) => {
                                tracing::warn!(
                                    %conversation_id,
                                    %turn_id,
                                    %error,
                                    "failed to record member activity"
                                );
                            }
                        }
                    });
                    tokio::spawn(async move {
                        if let Err(error) =
                            start_commit_reminder_if_needed(context, conversation_id, turn_id).await
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
        Ok(())
    }

    fn delivery_context(&self) -> crate::collaboration::DeliveryContext {
        match &self.conversation_context {
            Some(context) => {
                crate::ScopedConversationControl::new(context.clone()).delivery_context()
            }
            None => crate::collaboration::DeliveryContext {
                publisher: self.event_publisher.clone(),
                ..Default::default()
            },
        }
    }

    fn observe_space_mid_turn(&mut self, mapped: &MappedConversationEventRecord) -> bool {
        match &mapped.event {
            ConversationEvent::UserTurnCreated { .. } | ConversationEvent::UserTurnStarted => {
                self.pending_step_text.remove(&mapped.conversation_id);
                self.turn_had_tool_call.remove(&mapped.conversation_id);
                crate::collaboration::reset_space_turn_streaming_step(mapped.conversation_id);
                false
            }
            ConversationEvent::AssistantTextDelta { text, .. } => {
                self.pending_step_text
                    .entry(mapped.conversation_id)
                    .or_default()
                    .push_str(text);
                crate::collaboration::append_space_turn_streaming_text(
                    mapped.conversation_id,
                    text,
                    false,
                );
                !text.is_empty()
            }
            ConversationEvent::AssistantContentAppended {
                block: agents::ContentBlock::Text { text },
                ..
            } => {
                let entry = self
                    .pending_step_text
                    .entry(mapped.conversation_id)
                    .or_default();
                if !entry.is_empty() && !entry.ends_with('\n') {
                    entry.push('\n');
                }
                entry.push_str(text);
                crate::collaboration::append_space_turn_streaming_text(
                    mapped.conversation_id,
                    text,
                    true,
                );
                !text.is_empty()
            }
            ConversationEvent::ToolCallUpsert { .. } => {
                let step_text = self
                    .pending_step_text
                    .remove(&mapped.conversation_id)
                    .unwrap_or_default();
                let first_tool_in_turn = self.turn_had_tool_call.insert(mapped.conversation_id);
                if !step_text.trim().is_empty() {
                    crate::collaboration::advance_space_turn_streaming_step(mapped.conversation_id);
                }
                if !step_text.trim().is_empty() || first_tool_in_turn {
                    let pool = self.pool.clone();
                    let conversation_id = mapped.conversation_id;
                    let delivery_ctx = self.delivery_context();
                    tokio::spawn(async move {
                        if let Err(error) = crate::collaboration::on_space_turn_tool_call(
                            &pool,
                            conversation_id,
                            &step_text,
                            &delivery_ctx,
                        )
                        .await
                        {
                            tracing::warn!(
                                %conversation_id,
                                %error,
                                "failed to bubble collaboration space mid-turn step"
                            );
                        }
                    });
                }
                false
            }
            ConversationEvent::TurnCompleted { .. }
            | ConversationEvent::TurnFailed { .. }
            | ConversationEvent::TurnCancelled { .. }
            | ConversationEvent::TurnBlocked { .. } => {
                self.pending_step_text.remove(&mapped.conversation_id);
                self.turn_had_tool_call.remove(&mapped.conversation_id);
                false
            }
            _ => false,
        }
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
            AgentEvent::RequestActivity { prompt_id, .. } => {
                request_activity_turn_id(&self.pool, conversation_id, *prompt_id).await
            }
            AgentEvent::PromptStarted { snapshot } => {
                #[cfg(test)]
                {
                    self.turn_db_lookups += 1;
                }
                let turn_id =
                    bind_prompt_turn(&self.pool, conversation_id, &snapshot.id.to_string()).await?;
                if self.active_turn_cache.len() >= 512 {
                    self.active_turn_cache.clear();
                }
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
                    if self.active_turn_cache.len() >= 512 {
                        self.active_turn_cache.clear();
                    }
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

async fn load_latest_assistant_conclusion(
    pool: &SqlitePool,
    conversation_id: Uuid,
    had_tool_call: bool,
    leftover_step_text: &str,
) -> String {
    let _ = crate::ensure_legacy_jsonl_migrated_on_pool(pool, conversation_id).await;
    if let Ok(turns) = ConversationProjector::project_turns_summary(pool, conversation_id).await {
        let last_user_idx = turns.iter().rposition(|turn| {
            matches!(turn.role, agents::TurnRole::User) && !turn.id.contains(":steer:")
        });
        let round_slice = match last_user_idx {
            Some(idx) => &turns[idx + 1..],
            None => &turns[..],
        };
        if let Some(turn) = round_slice
            .iter()
            .rev()
            .find(|turn| turn.role == agents::TurnRole::Assistant)
            && !turn.blocks.is_empty()
        {
            return space_turn_conclusion_text(&turn.blocks, had_tool_call, leftover_step_text);
        }
    }
    leftover_step_text.to_string()
}

fn ephemeral_record(
    mapped: &MappedConversationEventRecord,
    normalized_json: &str,
) -> ConversationEventRecord {
    ConversationEventRecord {
        id: Uuid::new_v4(),
        conversation_id: mapped.conversation_id,
        turn_id: mapped.turn_id,
        binding_id: mapped.binding_id,
        connection_id: Some(mapped.connection_id.clone()),
        prompt_id: mapped.prompt_id.clone(),
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

fn batch_event_from_mapped(
    mapped: &MappedConversationEventRecord,
    normalized_json: String,
    turn_id: Option<Uuid>,
    checkpoint_update: Option<crate::CheckpointMetadataUpdate>,
) -> BatchConversationEvent {
    BatchConversationEvent {
        id: Uuid::new_v4(),
        conversation_id: mapped.conversation_id,
        turn_id,
        binding_id: mapped.binding_id,
        connection_id: Some(mapped.connection_id.clone()),
        prompt_id: mapped.prompt_id.clone(),
        source: mapped.source.to_string(),
        event_kind: mapped.event_kind.clone(),
        normalized_json,
        raw_json: mapped.raw_json.clone(),
        idempotency_key: Some(mapped.idempotency_key.clone()),
        checkpoint_update,
    }
}

#[cfg(test)]
async fn append_mapped_event(
    pool: &SqlitePool,
    mapped: &MappedConversationEventRecord,
    normalized_json: &str,
) -> Result<Option<ConversationEventRecord>, sqlx::Error> {
    let initial = batch_event_from_mapped(mapped, normalized_json.to_string(), mapped.turn_id, None);
    let mut out = ConversationEventAppender::append_batch(pool, &[initial.clone()]).await?;
    if let Some(c) = out.committed.pop() {
        return Ok((!c.duplicate).then_some(c.record));
    }
    if let Some((_, error)) = out.failed.pop() {
        if is_foreign_key_constraint(&error) {
            if mapped.turn_id.is_some() {
                let mut retry = initial;
                retry.id = Uuid::new_v4();
                retry.turn_id = None;
                let mut retry_out = ConversationEventAppender::append_batch(pool, &[retry]).await?;
                if let Some(c) = retry_out.committed.pop() {
                    return Ok((!c.duplicate).then_some(c.record));
                }
                if let Some((_, retry_err)) = retry_out.failed.pop() {
                    if is_foreign_key_constraint(&retry_err) {
                        return Ok(None);
                    }
                    return Err(retry_err);
                }
            }
            return Ok(None);
        }
        return Err(error);
    }
    Ok(None)
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

#[derive(Debug, thiserror::Error)]
pub enum RuntimeEventRecordError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Conversation(#[from] ConversationServiceError),
}

type RecorderFlushSender = mpsc::UnboundedSender<(Uuid, tokio::sync::oneshot::Sender<()>)>;

static ACTIVE_RECORDER_FLUSHERS: std::sync::LazyLock<std::sync::Mutex<Vec<RecorderFlushSender>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(Vec::new()));

/// Flush any buffered streaming deltas for `conversation_id` across active persistence loops
/// before detaching or switching its ACP session (Step 3A #15).
pub async fn flush_conversation_persistence(conversation_id: Uuid) {
    let senders = {
        let Ok(mut guard) = ACTIVE_RECORDER_FLUSHERS.lock() else {
            return;
        };
        guard.retain(|tx| !tx.is_closed());
        guard.clone()
    };
    for tx in senders {
        let (ack_tx, ack_rx) = tokio::sync::oneshot::channel();
        if tx.send((conversation_id, ack_tx)).is_ok() {
            let _ = tokio::time::timeout(std::time::Duration::from_millis(500), ack_rx).await;
        }
    }
}

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
    let (flush_tx, mut flush_rx) = mpsc::unbounded_channel::<(Uuid, tokio::sync::oneshot::Sender<()>)>();
    if let Ok(mut guard) = ACTIVE_RECORDER_FLUSHERS.lock() {
        guard.retain(|tx| !tx.is_closed());
        guard.push(flush_tx);
    }
    tokio::spawn(async move {
        use futures::FutureExt as _;

        loop {
            let mut recorder = make_recorder();

            let step = std::panic::AssertUnwindSafe(async {
                loop {
                    let idle_deadline = recorder.next_idle_deadline();
                    tokio::select! {
                        _ = async {
                            match idle_deadline {
                                Some(deadline) => tokio::time::sleep_until(deadline).await,
                                None => std::future::pending::<()>().await,
                            }
                        } => {
                            if let Err(error) = recorder.flush_due().await {
                                tracing::warn!(%error, "failed to flush conversation events");
                            }
                        }
                        Some((conversation_id, ack_tx)) = flush_rx.recv() => {
                            if let Err(error) = recorder.flush_conversation(conversation_id).await {
                                tracing::warn!(
                                    %conversation_id,
                                    %error,
                                    "failed to flush conversation events before detach"
                                );
                            }
                            let _ = ack_tx.send(());
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
