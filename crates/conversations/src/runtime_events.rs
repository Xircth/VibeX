//! Durable projection of agent-runtime events into the conversation event log.
//!
//! Both desktop and headless hosts consume the same `AgentRuntime` protocol. This
//! recorder keeps persistence independent of either Tauri or an HTTP transport;
//! adapters can observe the resulting conversation log through their normal
//! snapshot/replay seam.

use std::sync::Arc;

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
use db::models::{
    conversation::{BindingStatus, ConversationAgentBindingRecord, DbConversationSummary},
    conversation_event::AppendConversationEvent,
    conversation_turn::ConversationTurnRecord,
};
use deployment::Deployment;
use sqlx::SqlitePool;
use tokio::{sync::mpsc, task::JoinHandle};
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
    deployment: Arc<dyn Deployment>,
    conversation_context: Option<ConversationContext>,
    event_publisher: Option<Arc<dyn ConversationEventPublisher>>,
    coalescer: ConversationEventCoalescer,
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
    raw_json: String,
    idempotency_key: String,
    first_agent_sequence: i64,
    last_agent_sequence: i64,
    complete_reply: bool,
}

impl ConversationAgentEventRecorder {
    pub fn new(pool: SqlitePool, deployment: Arc<dyn Deployment>) -> Self {
        Self {
            pool,
            deployment,
            conversation_context: None,
            event_publisher: None,
            coalescer: ConversationEventCoalescer::default(),
        }
    }

    pub fn with_context(context: ConversationContext) -> Self {
        Self {
            pool: context.deployment.db().pool.clone(),
            deployment: context.deployment.clone(),
            event_publisher: Some(context.event_publisher.clone()),
            conversation_context: Some(context),
            coalescer: ConversationEventCoalescer::default(),
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
        let Some(event) = map_agent_event(envelope, turn_id) else {
            return Ok(None);
        };

        if let AgentEvent::SessionLinked { acp_session_id, .. } = &envelope.event
            && let Some(binding_id) = latest_binding_id(&self.pool, conversation_id).await?
        {
            ConversationAgentBindingRecord::bind_acp_session(
                &self.pool,
                binding_id,
                acp_session_id,
                None,
                BindingStatus::Ready,
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
            DbConversationSummary::backfill_title(&self.pool, conversation_id, title).await?;
        }

        let source = conversation_event_source(&envelope.event);
        let event_kind = conversation_event_kind(&event);
        let raw_json = serde_json::to_string(&envelope.event)?;
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
            let record = ConversationEventAppender::append(
                &self.pool,
                AppendConversationEvent {
                    id: Uuid::new_v4(),
                    conversation_id: mapped.conversation_id,
                    turn_id: mapped.turn_id,
                    binding_id: None,
                    connection_id: Some(&mapped.connection_id),
                    prompt_id: None,
                    source: mapped.source,
                    event_kind: &mapped.event_kind,
                    normalized_json: &normalized_json,
                    raw_json: Some(&mapped.raw_json),
                    idempotency_key: Some(&mapped.idempotency_key),
                },
            )
            .await?;
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
            batch.events.push(durable);

            if terminal && let Some(turn_id) = mapped.turn_id {
                if let Some(file_event) = finalize_checkpoint_file_changes(
                    self.deployment.as_ref(),
                    mapped.conversation_id,
                    turn_id,
                )
                .await?
                {
                    batch.events.push(file_event);
                }
            }

            // Publish only after the terminal checkpoint append. The desktop
            // publisher reads the durable tail, so one publication includes both.
            if let Some(publisher) = &self.event_publisher {
                publisher.publish(&record).await;
            }

            // A terminal Turn makes the conversation idle. Let the same
            // Conversation Core claim and dispatch the next durable input; hosts
            // never maintain their own queue effects.
            if terminal
                && let Some(context) = self.conversation_context.clone()
                && let Err(error) = ConversationSessionService::new(context)
                    .dispatch_next_queued_input(mapped.conversation_id)
                    .await
            {
                tracing::warn!(
                    conversation_id = %mapped.conversation_id,
                    %error,
                    "failed to dispatch the next durable conversation input"
                );
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
                        if let Err(error) = start_commit_reminder_if_needed(
                            context,
                            mapped.conversation_id,
                            turn_id,
                        )
                        .await
                        {
                            tracing::warn!(
                                conversation_id = %mapped.conversation_id,
                                %turn_id,
                                %error,
                                "failed to start commit reminder"
                            );
                        }
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
        &self,
        conversation_id: Uuid,
        event: &AgentEvent,
    ) -> Result<Option<Uuid>, sqlx::Error> {
        resolve_agent_event_turn_id(&self.pool, conversation_id, event).await
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
        self.base.complete_reply = false;
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

#[derive(Debug, thiserror::Error)]
pub enum RuntimeEventRecordError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Conversation(#[from] ConversationServiceError),
}

/// Start the durable runtime-event bridge for a host composition root.
pub fn start_agent_event_persistence(
    context: ConversationContext,
    mut receiver: mpsc::Receiver<AgentEventEnvelope>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut recorder = ConversationAgentEventRecorder::with_context(context);
        while let Some(envelope) = receiver.recv().await {
            if let Err(error) = recorder.record(&envelope).await {
                tracing::warn!(
                    sequence = envelope.sequence,
                    %error,
                    "failed to persist agent runtime event"
                );
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
                kind: tool_call.kind.clone(),
                status: Some("running".to_string()),
                raw_input: tool_call
                    .input_preview
                    .as_ref()
                    .map(|preview| parse_json_payload(preview)),
                raw_output: None,
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
                context_used: Some(usage.used),
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
                        error: ConversationError {
                            message: error_code.clone(),
                            code: Some(error_code.clone()),
                            raw: None,
                        },
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
                    error: ConversationError {
                        message: error.message.clone(),
                        code: error.code.clone(),
                        raw: error.raw.clone(),
                    },
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
        | AgentEvent::ConfigChanged { .. } => None,
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

fn conversation_event_kind(event: &ConversationEvent) -> String {
    serde_json::to_value(event)
        .ok()
        .and_then(|value| value["kind"].as_str().map(str::to_string))
        .unwrap_or_else(|| "unknown".to_string())
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
    };
    use sqlx::{
        SqlitePool,
        sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    };
    use uuid::Uuid;

    use super::{
        ConversationEventCoalescer, MappedConversationEventRecord, binds_only_to_in_flight_turn,
        conversation_event_kind, conversation_event_source, is_turn_scoped_content,
        map_agent_event, resolve_agent_event_turn_id,
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
        assert!(ready[0].raw_json.contains("\"chunk_count\":2"));
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
    fn shared_mapping_preserves_tool_metadata() {
        let metadata = serde_json::json!({ "file_path": "src/main.rs" });
        let image = agents::conversation::ImageData {
            data: "AAAA".to_string(),
            mime_type: "image/png".to_string(),
            uri: Some("assets/logo.png".to_string()),
        };
        let envelope = envelope(AgentEvent::ToolCall {
            tool_call: AgentToolCall {
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
    fn completed_prompt_finish_stays_turn_completed() {
        let envelope = envelope(AgentEvent::PromptFinished {
            finished: agents::AgentPromptFinished {
                prompt_id: agents::AgentPromptId(Uuid::new_v4()),
                stop_reason: Some("EndTurn".to_string()),
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
            raw_json: "{}".to_string(),
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
}
