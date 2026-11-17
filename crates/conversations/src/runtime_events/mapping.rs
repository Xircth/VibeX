use agents::{
    AgentConnectionId, AgentConnectionStatus, AgentContentBlock, AgentEvent, AgentEventEnvelope,
    conversation::{
        ConversationAgentConnectionStatus, ConversationDelegation, ConversationDelegationResult,
        ConversationError, ConversationEvent, ConversationFileLocation,
        ConversationPermissionRequest, ConversationPermissionResponse, ConversationPlanEntry,
        ConversationQuestionRequest, ConversationQuestionResponse, ConversationTerminalPatch,
        ConversationToolCallPatch, ConversationUsage,
    },
};
use db::models::{conversation_turn::ConversationTurnRecord, session::Session};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::RuntimeEventRecordError;

#[derive(Debug, Clone)]
pub(super) struct MappedConversationEventRecord {
    pub(super) conversation_id: Uuid,
    pub(super) turn_id: Option<Uuid>,
    pub(super) binding_id: Option<Uuid>,
    pub(super) connection_id: String,
    pub(super) prompt_id: Option<String>,
    pub(super) source: &'static str,
    pub(super) event_kind: String,
    pub(super) event: ConversationEvent,
    pub(super) raw_json: Option<String>,
    pub(super) idempotency_key: String,
    pub(super) first_agent_sequence: i64,
    pub(super) last_agent_sequence: i64,
    pub(super) complete_reply: bool,
}

pub(super) fn is_terminal_tool_status(status: Option<&str>) -> bool {
    matches!(
        status
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("completed" | "failed" | "cancelled" | "canceled" | "done" | "error")
    )
}

/// Pure transient UI hints bypass `conversation_events` persistence and publish live only.
/// Content and state events (`AssistantTextDelta`, `AssistantReasoningDelta`,
/// `AssistantContentAppended`, `PlanUpdated`, `ToolCallUpsert`, etc.) remain persisted in SQLite.
pub(super) fn is_unpersisted_conversation_event(event: &ConversationEvent) -> bool {
    matches!(
        event,
        ConversationEvent::PromptSuggestionUpdated { .. }
            | ConversationEvent::RequestActivityChanged { .. }
    )
}

pub(super) fn is_terminal_conversation_event(event: &ConversationEvent) -> bool {
    matches!(
        event,
        ConversationEvent::TurnCompleted { .. }
            | ConversationEvent::TurnFailed { .. }
            | ConversationEvent::TurnCancelled { .. }
            | ConversationEvent::TurnInterrupted { .. }
    )
}

pub(super) fn conversation_event_idempotency_key(
    conversation_id: Uuid,
    connection_id: AgentConnectionId,
    agent_sequence: i64,
    event: &ConversationEvent,
) -> String {
    match event {
        ConversationEvent::PermissionResponded { permission_id, .. } => {
            format!("conversation:{conversation_id}:permission:{permission_id}:responded")
        }
        ConversationEvent::QuestionResponded { question_id, .. } => {
            format!("conversation:{conversation_id}:question:{question_id}:responded")
        }
        ConversationEvent::AgentBindingLoadFailed { reason } => {
            format!(
                "conversation:{conversation_id}:agent-binding-load-failed:{}",
                reason.code()
            )
        }
        _ => format!(
            "agent:{connection_id}:{}:{}",
            agent_sequence,
            conversation_event_kind(event)
        ),
    }
}

pub(super) async fn resolve_agent_event_turn_id(
    pool: &SqlitePool,
    conversation_id: Uuid,
    event: &AgentEvent,
) -> Result<Option<Uuid>, sqlx::Error> {
    match event {
        AgentEvent::RequestActivity { prompt_id, .. } => {
            request_activity_turn_id(pool, conversation_id, *prompt_id).await
        }
        AgentEvent::PromptStarted { snapshot } => {
            bind_prompt_turn(pool, conversation_id, &snapshot.id.to_string()).await
        }
        AgentEvent::PromptFinished { finished } => {
            let prompt_id = finished.prompt_id.to_string();
            if let Some(turn) =
                ConversationTurnRecord::find_by_prompt_id(pool, conversation_id, &prompt_id).await?
            {
                return Ok(is_in_flight_turn_status(&turn.status).then_some(turn.id));
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

pub(super) async fn request_activity_turn_id(
    pool: &SqlitePool,
    conversation_id: Uuid,
    prompt_id: agents::AgentPromptId,
) -> Result<Option<Uuid>, sqlx::Error> {
    Ok(
        ConversationTurnRecord::find_by_prompt_id(pool, conversation_id, &prompt_id.to_string())
            .await?
            .filter(|turn| is_in_flight_turn_status(&turn.status))
            .map(|turn| turn.id),
    )
}

/// Events that must never be attributed to an already-settled Turn. When there is no
/// in-flight Turn they resolve to `None` rather than falling back to the conversation's
/// latest Turn.
pub(super) fn binds_only_to_in_flight_turn(event: &AgentEvent) -> bool {
    is_turn_scoped_content(event)
        || matches!(
            event,
            AgentEvent::Error { .. } | AgentEvent::TurnCompleted { .. }
        )
}

/// Assistant text that should be posted when a space turn completes.
///
/// After a tool call, only `ContentBlock::Text` that follows the last
/// `ContentBlock::ToolUse` is kept so earlier mid-turn bubbles are not
/// concatenated again. When the transcript has no tool block, fall back to
/// leftover in-memory step text if this turn already started a tool.
pub(crate) fn space_turn_conclusion_text(
    blocks: &[agents::ContentBlock],
    had_tool_call: bool,
    leftover_step_text: &str,
) -> String {
    let last_tool = blocks
        .iter()
        .rposition(|block| matches!(block, agents::ContentBlock::ToolUse { .. }));
    let join_text = |slice: &[agents::ContentBlock]| {
        let non_pass: Vec<&str> = slice
            .iter()
            .filter_map(|block| match block {
                agents::ContentBlock::Text { text } => {
                    let cleaned = crate::collaboration::strip_stray_pass_tokens(text);
                    if cleaned.is_empty() || crate::collaboration::is_pass_token(cleaned) {
                        None
                    } else {
                        Some(cleaned)
                    }
                }
                _ => None,
            })
            .collect();
        if !non_pass.is_empty() {
            return crate::collaboration::strip_stray_pass_tokens(&non_pass.join("\n")).to_string();
        }
        let raw = slice
            .iter()
            .filter_map(|block| match block {
                agents::ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        crate::collaboration::strip_stray_pass_tokens(&raw).to_string()
    };
    let clean_leftover =
        || crate::collaboration::strip_stray_pass_tokens(leftover_step_text).to_string();
    match last_tool {
        Some(idx) => {
            let after_tool = join_text(&blocks[idx + 1..]);
            if !after_tool.trim().is_empty() {
                after_tool
            } else {
                clean_leftover()
            }
        }
        None if had_tool_call && !leftover_step_text.trim().is_empty() => clean_leftover(),
        None => {
            let joined = join_text(blocks);
            if !joined.trim().is_empty() {
                joined
            } else {
                clean_leftover()
            }
        }
    }
}

/// Events that only mean something *inside* a Turn.
pub(super) fn is_turn_scoped_content(event: &AgentEvent) -> bool {
    match event {
        AgentEvent::ToolCall { tool_call } if tool_call.id.starts_with("codex-goal-") => false,
        AgentEvent::MessageChunk { .. }
        | AgentEvent::ThoughtChunk { .. }
        | AgentEvent::ToolCall { .. }
        | AgentEvent::ToolCallUpdate { .. }
        | AgentEvent::Plan { .. }
        | AgentEvent::PermissionRequested { .. }
        | AgentEvent::ElicitationRequested { .. }
        | AgentEvent::TerminalCreated { .. }
        | AgentEvent::TerminalOutput { .. }
        | AgentEvent::PromptFinished { .. }
        | AgentEvent::TurnCompleted { .. } => true,
        _ => false,
    }
}

pub(super) fn is_in_flight_turn_status(status: &str) -> bool {
    matches!(status, "pending" | "queued" | "running" | "blocked")
}

pub(super) async fn bind_prompt_turn(
    pool: &SqlitePool,
    conversation_id: Uuid,
    prompt_id: &str,
) -> Result<Option<Uuid>, sqlx::Error> {
    if let Some(turn) =
        ConversationTurnRecord::find_by_prompt_id(pool, conversation_id, prompt_id).await?
    {
        return Ok(is_in_flight_turn_status(&turn.status).then_some(turn.id));
    }
    Ok(None)
}

/// The conversation's in-flight Turn, read from the authoritative pointer.
pub(super) async fn in_flight_active_turn_id(
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

pub(super) async fn attach_cached_plan_usage(
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

pub(super) fn map_agent_event(
    envelope: &AgentEventEnvelope,
    turn_id: Option<Uuid>,
) -> Option<ConversationEvent> {
    match &envelope.event {
        AgentEvent::RequestActivity { activity, .. } => {
            Some(ConversationEvent::RequestActivityChanged {
                activity: activity.clone(),
            })
        }
        AgentEvent::SessionBindReady { .. } => {
            Some(ConversationEvent::AgentConnectionStatusChanged {
                status: ConversationAgentConnectionStatus::Ready,
                message: None,
                bound: true,
            })
        }
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
                message: snapshot.status_message.as_deref().map(|text| {
                    agents::conversation::cap_preview_bytes(
                        agents::stderr_tail::sanitize_diagnostic(text),
                    )
                }),
                bound: false,
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
        AgentEvent::ToolCallUpdate { update } => {
            let append_delta = tool_call_update_is_output_append(update);
            Some(ConversationEvent::ToolCallUpsert {
                tool_call: ConversationToolCallPatch {
                    tool_call_id: update.id.clone(),
                    title: update.title.clone(),
                    kind: None,
                    status: update.status.clone(),
                    raw_input: update
                        .input_preview
                        .as_ref()
                        .map(|preview| parse_json_payload(preview)),
                    raw_output: if append_delta {
                        None
                    } else {
                        update.content.as_deref().map(parse_json_payload)
                    },
                    raw_output_append: if append_delta {
                        update.content.clone()
                    } else {
                        None
                    },
                    content: update
                        .content
                        .as_ref()
                        .map(|content| serde_json::json!({ "text": content })),
                    locations: Some(Vec::<ConversationFileLocation>::new()),
                    metadata: update.meta.clone(),
                    images: update.images.clone(),
                },
            })
        }
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
        AgentEvent::SessionInfoUpdated { patch } => normalize_session_info_patch(patch)
            .map(|normalized| ConversationEvent::AgentSessionInfoUpdated { patch: normalized }),
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
            payload: Some(agents::cap_json_value(raw.clone())),
        }),
        AgentEvent::AnnouncementsUpdated {
            generation,
            notices,
        } => Some(ConversationEvent::AnnouncementsUpdated {
            generation: *generation,
            notices: notices.clone(),
        }),
        AgentEvent::GoalUpdated { goal, goal_actions } => {
            Some(ConversationEvent::SessionGoalUpdated {
                goal: goal.clone(),
                actions: goal_actions.clone(),
            })
        }
        AgentEvent::AsyncTasksUpdated { tasks } => Some(ConversationEvent::AsyncTasksUpdated {
            tasks: tasks.clone(),
        }),
        AgentEvent::PromptSuggestionUpdated { suggestion } => {
            Some(ConversationEvent::PromptSuggestionUpdated {
                suggestion: suggestion.clone(),
            })
        }
        AgentEvent::SessionCreated { .. }
        | AgentEvent::PromptStarted { .. }
        | AgentEvent::ModeChanged { .. }
        | AgentEvent::ConfigChanged { .. }
        | AgentEvent::ConfigOptionRejected { .. }
        | AgentEvent::SessionInvalidated { .. }
        | AgentEvent::PromptAccepted { .. } => None,
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

pub(super) fn conversation_event_source(event: &AgentEvent) -> &'static str {
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
        | AgentEvent::AnnouncementsUpdated { .. }
        | AgentEvent::GoalUpdated { .. }
        | AgentEvent::AsyncTasksUpdated { .. }
        | AgentEvent::PromptSuggestionUpdated { .. } => "acp",
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

pub(super) async fn persist_session_linked_external_id(
    pool: &SqlitePool,
    conversation_id: Uuid,
    acp_session_id: &str,
    agent_id: &agents::AgentId,
) -> Result<(), RuntimeEventRecordError> {
    Session::update_agent_metadata(pool, conversation_id, Some(acp_session_id), Some(agent_id))
        .await?;
    if let Err(error) =
        crate::collaboration::invalidate_space_delivery_prompt_injections(pool, conversation_id)
            .await
    {
        tracing::warn!(
            error = %error.message,
            %conversation_id,
            "failed to reset collaboration prompt injection after ACP bind"
        );
    }
    Ok(())
}

pub(super) fn conversation_event_kind(event: &ConversationEvent) -> String {
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
        ConversationEvent::SessionGoalUpdated { .. } => "session_goal_updated".to_string(),
        ConversationEvent::AsyncTasksUpdated { .. } => "async_tasks_updated".to_string(),
        ConversationEvent::PromptSuggestionUpdated { .. } => {
            "prompt_suggestion_updated".to_string()
        }
        ConversationEvent::AgentSessionInfoUpdated { .. } => {
            "agent_session_info_updated".to_string()
        }
        _ => serde_json::to_value(event)
            .ok()
            .and_then(|value| value["kind"].as_str().map(str::to_string))
            .unwrap_or_else(|| "unknown".to_string()),
    }
}

fn tool_call_update_is_output_append(update: &agents::AgentToolCallUpdate) -> bool {
    let Some(map) = update.meta.as_ref().and_then(serde_json::Value::as_object) else {
        return false;
    };
    [
        "raw_output_append",
        "rawOutputAppend",
        "append",
        "delta",
        "is_delta",
        "terminalOutputDelta",
    ]
    .iter()
    .any(|key| map.get(*key).and_then(serde_json::Value::as_bool) == Some(true))
}

fn normalize_session_info_patch(patch: &serde_json::Value) -> Option<serde_json::Value> {
    let obj = patch.as_object()?;
    if obj.is_empty() {
        return None;
    }
    let mut out = obj.clone();
    if let Some(in_progress) = obj
        .get("autoCompactionInProgress")
        .and_then(serde_json::Value::as_bool)
        && !out.contains_key("contextCompaction")
    {
        let trigger = obj
            .get("trigger")
            .or_else(|| obj.get("compactionTrigger"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("auto");
        out.insert(
            "contextCompaction".to_string(),
            serde_json::json!({
                "status": if in_progress { "started" } else { "completed" },
                "trigger": trigger,
            }),
        );
    }
    if let Some(warn_obj) = obj
        .get("modelConsistencyWarning")
        .and_then(serde_json::Value::as_object)
        && !warn_obj.contains_key("message")
    {
        let requested = warn_obj
            .get("requestedModel")
            .or_else(|| warn_obj.get("requested_model"))
            .and_then(serde_json::Value::as_str);
        let served = warn_obj
            .get("servedModel")
            .or_else(|| warn_obj.get("served_model"))
            .and_then(serde_json::Value::as_str);
        if let (Some(req), Some(srv)) = (requested, served) {
            let mut enriched = warn_obj.clone();
            enriched.insert(
                "message".to_string(),
                serde_json::Value::String(format!(
                    "Requested model `{req}`, but provider served `{srv}`."
                )),
            );
            out.insert(
                "modelConsistencyWarning".to_string(),
                serde_json::Value::Object(enriched),
            );
        }
    }
    Some(serde_json::Value::Object(out))
}

#[cfg(test)]
mod tests {
    use agents::{
        AgentConnectionId, AgentEvent, AgentEventEnvelope, AgentSessionId, AgentToolCallUpdate,
    };
    use chrono::Utc;
    use uuid::Uuid;

    use super::*;

    fn test_envelope(event: AgentEvent) -> AgentEventEnvelope {
        AgentEventEnvelope {
            sequence: 1,
            workspace_id: Uuid::new_v4(),
            connection_id: AgentConnectionId::new(),
            session_id: Some(AgentSessionId::new()),
            event,
            created_at: Utc::now(),
        }
    }

    #[test]
    fn session_info_updated_preserves_compaction_model_warning_rate_limits_and_cache_without_title()
    {
        let env = test_envelope(AgentEvent::SessionInfoUpdated {
            patch: serde_json::json!({
                "autoCompactionInProgress": true,
                "trigger": "context_limit",
                "modelConsistencyWarning": {
                    "requestedModel": "claude-opus-4-6",
                    "servedModel": "claude-sonnet-4-5"
                },
                "rateLimits": {
                    "status": "rejected",
                    "utilization": 100.0,
                    "resetsAt": 1763175000
                },
                "cacheStatus": { "ttl": "5m" }
            }),
        });
        let mapped = super::super::map_agent_event(&env, None).expect("must map telemetry patch");
        match mapped {
            ConversationEvent::AgentSessionInfoUpdated { patch } => {
                assert_eq!(patch["contextCompaction"]["status"], "started");
                assert_eq!(patch["contextCompaction"]["trigger"], "context_limit");
                assert!(
                    patch["modelConsistencyWarning"]["message"]
                        .as_str()
                        .is_some_and(
                            |m| m.contains("claude-opus-4-6") && m.contains("claude-sonnet-4-5")
                        )
                );
                assert_eq!(patch["rateLimits"]["status"], "rejected");
                assert_eq!(patch["cacheStatus"]["ttl"], "5m");
            }
            other => panic!("expected AgentSessionInfoUpdated, got {other:?}"),
        }
    }

    #[test]
    fn tool_call_update_routes_streaming_deltas_to_raw_output_append_only() {
        let append_env = test_envelope(AgentEvent::ToolCallUpdate {
            update: AgentToolCallUpdate {
                id: "call_1".into(),
                title: None,
                status: Some("in_progress".into()),
                content: Some("line 1\n".into()),
                input_preview: None,
                meta: Some(serde_json::json!({ "raw_output_append": true })),
                images: Vec::new(),
            },
        });
        match super::super::map_agent_event(&append_env, None).expect("mapped") {
            ConversationEvent::ToolCallUpsert { tool_call } => {
                assert!(tool_call.raw_output.is_none());
                assert_eq!(tool_call.raw_output_append.as_deref(), Some("line 1\n"));
            }
            other => panic!("unexpected {other:?}"),
        }
        let cumulative_env = test_envelope(AgentEvent::ToolCallUpdate {
            update: AgentToolCallUpdate {
                id: "call_1".into(),
                title: None,
                status: Some("in_progress".into()),
                content: Some("line 1\nline 2\n".into()),
                input_preview: None,
                meta: None,
                images: Vec::new(),
            },
        });
        match super::super::map_agent_event(&cumulative_env, None).expect("mapped") {
            ConversationEvent::ToolCallUpsert { tool_call } => {
                assert_eq!(
                    tool_call.raw_output,
                    Some(serde_json::Value::String("line 1\nline 2\n".into()))
                );
                assert!(tool_call.raw_output_append.is_none());
            }
            other => panic!("unexpected {other:?}"),
        }
    }
}
