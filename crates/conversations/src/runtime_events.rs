//! Durable projection of agent-runtime events into the conversation event log.
//!
//! Both desktop and headless hosts consume the same `AgentRuntime` protocol. This
//! recorder keeps persistence independent of either Tauri or an HTTP transport;
//! adapters can observe the resulting conversation log through their normal
//! snapshot/replay seam.

use std::{collections::HashMap, sync::Arc};

use agents::{
    AgentConnectionStatus, AgentContentBlock, AgentEvent, AgentEventEnvelope, AgentRuntime,
    conversation::{
        ConversationAgentConnectionStatus, ConversationDelegation, ConversationDelegationResult,
        ConversationError, ConversationEvent, ConversationEventEnvelope, ConversationFileLocation,
        ConversationPermissionRequest, ConversationPermissionResponse, ConversationPlanEntry,
        ConversationQuestionRequest, ConversationQuestionResponse, ConversationTerminalPatch,
        ConversationToolCallPatch, ConversationUsage,
    },
};
use db::models::{
    conversation::ConversationAgentBindingRecord, conversation_event::AppendConversationEvent,
};
use deployment::Deployment;
use sqlx::SqlitePool;
use tokio::{sync::broadcast, task::JoinHandle};
use uuid::Uuid;

use crate::{
    ConversationEventAppender, ConversationServiceError, finalize_checkpoint_file_changes,
};

/// Transport-neutral recorder used by all application hosts.
pub struct ConversationAgentEventRecorder {
    pool: SqlitePool,
    deployment: Arc<dyn Deployment>,
    active_turns: HashMap<Uuid, Uuid>,
}

impl ConversationAgentEventRecorder {
    pub fn new(pool: SqlitePool, deployment: Arc<dyn Deployment>) -> Self {
        Self {
            pool,
            deployment,
            active_turns: HashMap::new(),
        }
    }

    /// Persist one runtime envelope and return every durable event it produced.
    ///
    /// A terminal runtime event may additionally create a checkpoint file-change
    /// event, so callers receive a vector rather than a single envelope.
    pub async fn record(
        &mut self,
        envelope: &AgentEventEnvelope,
    ) -> Result<Vec<ConversationEventEnvelope>, RuntimeEventRecordError> {
        let Some(session_id) = envelope.session_id else {
            return Ok(Vec::new());
        };
        let conversation_id = session_id.0;
        let turn_id = self.active_turn_id(conversation_id).await?;
        let Some(event) = map_agent_event(envelope, turn_id) else {
            return Ok(Vec::new());
        };

        if let AgentEvent::SessionLinked { acp_session_id, .. } = &envelope.event
            && let Some(binding_id) = latest_binding_id(&self.pool, conversation_id).await?
        {
            ConversationAgentBindingRecord::bind_acp_session(
                &self.pool,
                binding_id,
                acp_session_id,
                None,
                "ready",
            )
            .await?;
        }

        let source = conversation_event_source(&envelope.event);
        let event_kind = conversation_event_kind(&event);
        let normalized_json = serde_json::to_string(&event)?;
        let raw_json = serde_json::to_string(&envelope.event)?;
        let connection_id = envelope.connection_id.to_string();
        let idempotency_key = format!("agent:{}:{event_kind}", envelope.sequence);
        let record = ConversationEventAppender::append(
            &self.pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id,
                binding_id: None,
                connection_id: Some(&connection_id),
                prompt_id: None,
                source,
                event_kind: &event_kind,
                normalized_json: &normalized_json,
                raw_json: Some(&raw_json),
                idempotency_key: Some(&idempotency_key),
            },
        )
        .await?;
        let durable = ConversationEventEnvelope {
            id: record.id,
            conversation_id: record.conversation_id,
            turn_id: record.turn_id,
            sequence: record.sequence,
            source: record.source,
            event: serde_json::from_str(&record.normalized_json)?,
            created_at: record.created_at,
        };
        let terminal = is_terminal_conversation_event(&durable.event);
        let mut events = vec![durable];

        if terminal && let Some(turn_id) = turn_id {
            if let Some(file_event) =
                finalize_checkpoint_file_changes(self.deployment.as_ref(), conversation_id, turn_id)
                    .await?
            {
                events.push(file_event);
            }
            self.active_turns.remove(&conversation_id);
        }
        Ok(events)
    }

    async fn active_turn_id(&mut self, conversation_id: Uuid) -> Result<Option<Uuid>, sqlx::Error> {
        if let Some(turn_id) = self.active_turns.get(&conversation_id).copied() {
            return Ok(Some(turn_id));
        }
        let turn_id = sqlx::query_scalar::<_, Option<Uuid>>(
            "SELECT active_turn_id FROM sessions WHERE id = ?",
        )
        .bind(conversation_id)
        .fetch_optional(&self.pool)
        .await?
        .flatten();
        if let Some(turn_id) = turn_id {
            self.active_turns.insert(conversation_id, turn_id);
        }
        Ok(turn_id)
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
    pool: SqlitePool,
    deployment: Arc<dyn Deployment>,
    runtime: Arc<AgentRuntime>,
) -> JoinHandle<()> {
    let mut receiver = runtime.subscribe_events();
    tokio::spawn(async move {
        let mut recorder = ConversationAgentEventRecorder::new(pool, deployment);
        loop {
            match receiver.recv().await {
                Ok(envelope) => {
                    if let Err(error) = recorder.record(&envelope).await {
                        tracing::warn!(
                            sequence = envelope.sequence,
                            %error,
                            "failed to persist agent runtime event"
                        );
                    }
                }
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    tracing::warn!(skipped, "agent runtime event recorder lagged");
                }
                Err(broadcast::error::RecvError::Closed) => break,
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
                raw_input: tool_call
                    .input_preview
                    .as_ref()
                    .map(|preview| parse_json_payload(preview)),
                raw_output: None,
                raw_output_append: None,
                content: None,
                locations: None,
                metadata: None,
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
                raw_output: update.content.as_deref().map(parse_json_payload),
                raw_output_append: update.content.clone(),
                content: update
                    .content
                    .as_ref()
                    .map(|content| serde_json::json!({ "text": content })),
                locations: Some(Vec::<ConversationFileLocation>::new()),
                metadata: None,
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
                context_window_max: usage.limit,
                cost_amount: None,
                cost_currency: None,
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
        AgentEvent::Error { error } => Some(if turn_id.is_some() {
            ConversationEvent::TurnFailed {
                error: ConversationError {
                    message: error.message.clone(),
                    code: error.code.clone(),
                    raw: error.raw.clone(),
                },
            }
        } else {
            ConversationEvent::AgentBindingRecoveryFailed {
                reason: error.message.clone(),
            }
        }),
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
        | AgentEvent::TurnCompleted { .. }
        | AgentEvent::PromptFinished { .. } => "acp",
        _ => "runtime",
    }
}

fn conversation_event_kind(event: &ConversationEvent) -> String {
    serde_json::to_value(event)
        .ok()
        .and_then(|value| value["kind"].as_str().map(str::to_string))
        .unwrap_or_else(|| "unknown".to_string())
}
