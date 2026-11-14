use std::{path::PathBuf, sync::Arc};

use agents::{
    AgentContentBlock, AgentId, AgentPromptId, AgentPromptSnapshot, AgentPromptStatus,
    AgentSessionConfigOverride, AgentSessionId, CancelAgentPromptInput, SendAgentPromptInput,
    conversation::{ConversationEvent, ConversationEventEnvelope, ConversationInputBlock},
};
use chrono::Utc;
use db::models::{
    conversation::{ConversationAgentBindingRecord, ConversationRecord, CreateConversationRecord},
    conversation_turn::ConversationTurnRecord,
    session::{Session, SessionStatus},
};
use executors::profile::ExecutorProfileId;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::{
    AgentPromptOverrides, CommittedTurnLaunch, ConversationSessionService,
    ConversationStartTurnInput, ConversationTurnSnapshot,
};
use crate::ConversationServiceError;

impl ConversationSessionService {
    pub async fn start_turn(
        &self,
        input: ConversationStartTurnInput,
    ) -> Result<(ConversationTurnSnapshot, AgentPromptSnapshot), ConversationServiceError> {
        self.start_turn_with_origin(input, crate::commit_reminder::USER_ORIGIN)
            .await
    }

    pub async fn start_turn_with_origin(
        &self,
        input: ConversationStartTurnInput,
        origin: &str,
    ) -> Result<(ConversationTurnSnapshot, AgentPromptSnapshot), ConversationServiceError> {
        if input.queued_input_claim.is_none() {
            let conversation_id = input.conversation_id;
            let submission = self.submit_and_dispatch(input, origin).await?;
            if let Some(turn) = submission.turn {
                return Ok((turn, unused_prompt_snapshot(conversation_id)));
            }
            return Ok((
                queued_turn_snapshot(conversation_id),
                unused_prompt_snapshot(conversation_id),
            ));
        }
        self.start_turn_under_lock(input, origin).await
    }

    pub(super) async fn start_turn_under_lock(
        &self,
        input: ConversationStartTurnInput,
        origin: &str,
    ) -> Result<(ConversationTurnSnapshot, AgentPromptSnapshot), ConversationServiceError> {
        let conversation_id = input.conversation_id;
        let committed = {
            let turn_lock = self.turn_lock(conversation_id).await;
            let _turn_guard = turn_lock.lock().await;
            self.commit_new_turn(input, origin).await?
        };
        let result = self.complete_committed_turn(committed).await;
        if result
            .as_ref()
            .err()
            .is_some_and(ConversationServiceError::should_retry_queued_dispatch)
        {
            self.spawn_next_queued_input_after_failure(conversation_id);
        }
        result
    }

    pub(super) async fn complete_committed_turn(
        &self,
        committed: CommittedTurnLaunch,
    ) -> Result<(ConversationTurnSnapshot, AgentPromptSnapshot), ConversationServiceError> {
        let CommittedTurnLaunch {
            input,
            origin,
            preparation_lock,
            turn_id,
            created_sequence,
        } = committed;
        let pool = &self.ctx.deployment.db().pool;
        let _preparation_guard = preparation_lock.lock().await;
        if !self
            .turn_is_still_in_flight(input.conversation_id, turn_id)
            .await?
        {
            crate::jsonl_history::preserve_unprompted_input(pool, input.conversation_id, turn_id)
                .await?;
            return Err(ConversationServiceError::Conflict(
                "Turn was cancelled before the Agent handshake".to_string(),
            ));
        }

        let mut smart_reminder = None;
        let result = async {
            let mut prepared = self.prepare_turn_prompt(&input, &origin).await?;
            smart_reminder = prepared.smart_reminder.take();
            self.prepare_turn_continuation(&input, turn_id, &mut prepared)
                .await?;
            self.send_turn_to_agent(
                &input,
                &prepared.working_dir,
                &prepared.additional_directories,
                prepared.agent_blocks,
                prepared.display_blocks,
                turn_id,
            )
            .await
        }
        .await;

        if !self
            .turn_is_still_in_flight(input.conversation_id, turn_id)
            .await?
        {
            match &result {
                Ok(prompt) => {
                    if let Some(connection_id) = self
                        .ctx
                        .agent_runtime
                        .live_connection_id(AgentSessionId(input.conversation_id))
                        .await
                        && let Err(error) = self
                            .ctx
                            .agent_runtime
                            .cancel_prompt(CancelAgentPromptInput {
                                connection_id,
                                session_id: AgentSessionId(input.conversation_id),
                                prompt_id: prompt.id,
                            })
                            .await
                    {
                        tracing::warn!(
                            conversation_id = %input.conversation_id,
                            prompt_id = %prompt.id,
                            %error,
                            "failed to cancel a prompt sent after the turn was stopped"
                        );
                        self.drop_live_agent_connection(input.conversation_id).await;
                    }
                }
                Err(_) => {
                    self.drop_live_agent_connection(input.conversation_id).await;
                }
            }
            crate::jsonl_history::preserve_unprompted_input(pool, input.conversation_id, turn_id)
                .await?;
            return Err(ConversationServiceError::Conflict(
                "Turn was cancelled before the Agent handshake".to_string(),
            ));
        }

        if result.is_err() {
            crate::handoff::settle(pool, turn_id).await?;
            crate::jsonl_history::preserve_unprompted_input(pool, input.conversation_id, turn_id)
                .await?;
        }
        match result {
            Ok(prompt) => {
                if smart_reminder.is_some() {
                    crate::commit_reminder::clear_pending_smart_reminder(
                        &self.ctx,
                        input.conversation_id,
                    )
                    .await;
                }
                self.append_event(
                    input.conversation_id,
                    Some(turn_id),
                    "runtime",
                    ConversationEvent::UserTurnStarted,
                    Some(format!("turn:{turn_id}:started")),
                )
                .await?;
                let prompt_uuid = prompt.id.0;
                self.update_runtime_state(input.conversation_id, |state| {
                    state.active_prompt_id = Some(prompt.id.to_string());
                })
                .await;
                Ok((
                    ConversationTurnSnapshot {
                        conversation_id: input.conversation_id,
                        turn_id,
                        prompt_id: Some(prompt_uuid),
                        status: "running".to_string(),
                        last_sequence: created_sequence + 1,
                    },
                    prompt,
                ))
            }
            Err(error) => {
                if matches!(error, ConversationServiceError::AuthenticationRequired(_)) {
                    let blocked = self
                        .append_event(
                            input.conversation_id,
                            Some(turn_id),
                            "runtime",
                            ConversationEvent::TurnBlocked {
                                reason: agents::conversation::TurnBlockedReason::Authentication {
                                    message: error.to_string(),
                                },
                            },
                            Some(format!("turn:{turn_id}:auth_required")),
                        )
                        .await?;
                    self.update_runtime_state(input.conversation_id, |state| {
                        state.event_sequence = blocked.sequence;
                        state.recovery_status = Some("auth_required".to_string());
                    })
                    .await;
                    return Err(error);
                }
                let failed = self
                    .append_event(
                        input.conversation_id,
                        Some(turn_id),
                        "runtime",
                        ConversationEvent::TurnFailed {
                            error: error
                                .turn_failure()
                                .with_cached_plan_usage(Some(&input.agent_id)),
                        },
                        Some(format!("turn:{turn_id}:send_failed")),
                    )
                    .await?;
                self.update_runtime_state(input.conversation_id, |state| {
                    state.turn_in_flight = false;
                    state.event_sequence = failed.sequence;
                    state.recovery_status = Some("send_failed".to_string());
                })
                .await;
                let after_event = AfterTurnEvent {
                    conversation_id: input.conversation_id,
                    turn_id,
                    status: "failed".to_string(),
                    stop_reason: None,
                    error_message: Some(error.to_string()),
                };
                self.ctx.host.after_turn(&after_event).await;
                emit_after_turn_event(after_event);
                spawn_turn_end_collaboration_cleanup(
                    self.ctx.clone(),
                    input.conversation_id,
                    false,
                    None,
                );
                Err(error)
            }
        }
    }

    /// First prompt of a delegated child: same persist + bind + send path as a
    /// user turn on that conversation.
    pub async fn start_delegated_turn(
        &self,
        conversation_id: Uuid,
        task: String,
        mode_override: Option<String>,
        config_overrides: Vec<AgentSessionConfigOverride>,
    ) -> Result<(ConversationTurnSnapshot, AgentPromptSnapshot), ConversationServiceError> {
        let pool = &self.ctx.deployment.db().pool;
        let session = Session::find_by_id(pool, conversation_id)
            .await?
            .ok_or_else(|| {
                ConversationServiceError::NotFound(format!(
                    "Conversation session {conversation_id} was not found"
                ))
            })?;
        let agent_id = session.agent_id.clone().ok_or_else(|| {
            ConversationServiceError::BadRequest(format!(
                "Conversation {conversation_id} has no supported coding agent"
            ))
        })?;
        self.start_turn_under_lock(
            ConversationStartTurnInput {
                continuation_policy: None,
                expected_binding_revision: None,
                agent_id,
                workspace_id: session.workspace_id,
                conversation_id,
                executor_profile_id: None,
                text: task,
                display_text: None,
                images: Vec::new(),
                mode_override,
                config_overrides,
                workflow_refs: Vec::new(),
                file_refs: Vec::new(),
                internal_prompt_contributions: Vec::new(),
                queued_input_claim: None,
                operation_id: None,
                collaboration_origin: None,
            },
            crate::commit_reminder::USER_ORIGIN,
        )
        .await
    }

    pub(super) async fn send_turn_to_agent(
        &self,
        input: &ConversationStartTurnInput,
        _working_dir: &str,
        _additional_directories: &[PathBuf],
        blocks: Vec<AgentContentBlock>,
        display_blocks: Vec<AgentContentBlock>,
        turn_id: Uuid,
    ) -> Result<AgentPromptSnapshot, ConversationServiceError> {
        let pool = &self.ctx.deployment.db().pool;
        let runtime_session_id = AgentSessionId(input.conversation_id);
        if !self
            .ctx
            .agent_runtime
            .has_bound_acp_session(runtime_session_id)
            .await
        {
            return Err(agents::AgentError::AcpSessionNotBound.into());
        }
        let connection_id = self
            .ctx
            .agent_runtime
            .live_connection_id(runtime_session_id)
            .await
            .ok_or(agents::AgentError::AcpSessionNotBound)?;
        let latest_binding =
            ConversationAgentBindingRecord::active_for_conversation(pool, input.conversation_id)
                .await?;
        self.update_runtime_state(input.conversation_id, |state| {
            state.binding_id = latest_binding.as_ref().map(|binding| binding.id);
            state.connection_id = Some(connection_id.to_string());
            state.connection_status = Some("ready".to_string());
        })
        .await;

        match self
            .ctx
            .deployment
            .container()
            .checkpoint_agent_session(input.conversation_id)
            .await
        {
            Ok(ordinal) => {
                if let Err(error) = super::commit::record_conversation_checkpoint(
                    self.ctx.deployment.as_ref(),
                    pool,
                    input.conversation_id,
                    turn_id,
                    ordinal,
                )
                .await
                {
                    tracing::warn!(%error, "failed to record conversation checkpoint mapping");
                }
            }
            Err(error) => {
                tracing::warn!(%error, "failed to record conversation checkpoint");
            }
        }

        let mut prompt_overrides = agent_prompt_overrides_from_profile(
            &input.agent_id,
            input.executor_profile_id.as_ref(),
        );
        merge_user_prompt_overrides(
            &mut prompt_overrides,
            super::binding::binding_mode_selection(latest_binding.as_ref()),
            super::binding::binding_config_selection(latest_binding.as_ref()),
        );
        merge_user_prompt_overrides(
            &mut prompt_overrides,
            input.mode_override.clone(),
            input.config_overrides.clone(),
        );
        self.remember_session_controls_selection(
            input.conversation_id,
            prompt_overrides.mode_override.as_deref(),
            &prompt_overrides.config_overrides,
        )
        .await;
        let turn_lock = self.turn_lock(input.conversation_id).await;
        let _turn_guard = turn_lock.lock().await;
        if !self
            .turn_is_still_in_flight(input.conversation_id, turn_id)
            .await?
        {
            return Err(ConversationServiceError::Conflict(
                "Turn was cancelled before the Agent prompt".to_string(),
            ));
        }
        let prompt_id = AgentPromptId::new();
        ConversationTurnRecord::set_prompt_id(pool, turn_id, &prompt_id.to_string()).await?;
        crate::handoff::sending(pool, turn_id).await?;
        let prompt = self
            .ctx
            .agent_runtime
            .send_reserved_prompt(
                prompt_id,
                SendAgentPromptInput {
                    connection_id,
                    session_id: runtime_session_id,
                    blocks,
                    mode_override: prompt_overrides.mode_override,
                    config_overrides: prompt_overrides.config_overrides,
                },
                Some(display_blocks),
            )
            .await?;

        let bound_sid = self
            .ctx
            .agent_runtime
            .has_bound_acp_session(runtime_session_id)
            .await;
        self.update_runtime_state(input.conversation_id, |state| {
            state.binding_id = latest_binding.as_ref().map(|binding| binding.id);
            if bound_sid {
                state.connection_id = Some(connection_id.to_string());
                state.connection_status = Some("ready".to_string());
            }
        })
        .await;

        Ok(prompt)
    }

    pub(super) async fn ensure_conversation(
        &self,
        pool: &SqlitePool,
        input: &ConversationStartTurnInput,
        display_text: &str,
    ) -> Result<ConversationRecord, ConversationServiceError> {
        let bound_acp_session_id = self
            .ctx
            .agent_runtime
            .bound_acp_session_id(AgentSessionId(input.conversation_id))
            .await;
        if let Some(existing) = ConversationRecord::find_by_id(pool, input.conversation_id).await? {
            return Ok(existing);
        }

        let created = ConversationRecord::create(
            pool,
            input.conversation_id,
            CreateConversationRecord {
                workspace_id: input.workspace_id,
                task_id: None,
                title: None,
                initial_prompt: Some(display_text),
                status: Some(SessionStatus::InProgress),
                executor: Some("agent"),
            },
        )
        .await?;
        let _ = Session::update_agent_metadata(
            pool,
            input.conversation_id,
            bound_acp_session_id.as_deref(),
            Some(&input.agent_id),
        )
        .await;
        Ok(created)
    }
}

pub(super) fn queued_turn_snapshot(conversation_id: Uuid) -> ConversationTurnSnapshot {
    ConversationTurnSnapshot {
        conversation_id,
        turn_id: Uuid::nil(),
        prompt_id: None,
        status: "queued".to_string(),
        last_sequence: 0,
    }
}

pub(super) fn unused_prompt_snapshot(conversation_id: Uuid) -> AgentPromptSnapshot {
    let now = Utc::now();
    AgentPromptSnapshot {
        id: AgentPromptId::new(),
        session_id: AgentSessionId(conversation_id),
        status: AgentPromptStatus::Queued,
        text_preview: String::new(),
        created_at: now,
        updated_at: now,
    }
}

pub(super) fn agent_blocks_with_display_text(
    blocks: &[AgentContentBlock],
    display_text: &str,
) -> Vec<AgentContentBlock> {
    let has_display_text = !display_text.trim().is_empty();
    let mut visible = Vec::with_capacity(blocks.len());
    if has_display_text {
        visible.push(AgentContentBlock::Text {
            text: display_text.to_string(),
        });
    }
    visible.extend(blocks.iter().filter_map(|block| match block {
        AgentContentBlock::Text { .. } => None,
        AgentContentBlock::Resource { .. } if has_display_text => None,
        other => Some(other.clone()),
    }));
    visible
}

pub(super) fn conversation_input_blocks_with_display_text(
    blocks: &[AgentContentBlock],
    display_text: &str,
    origin: Option<&agents::CollaborationSpaceOrigin>,
) -> Vec<ConversationInputBlock> {
    let mut visible = Vec::with_capacity(blocks.len() + 1);
    if let Some(origin) = origin {
        visible.push(ConversationInputBlock::Protocol {
            content: serde_json::json!({
                "kind": "collaboration_space_origin",
                "spaceId": origin.space_id,
                "threadKind": origin.thread_kind,
                "senderKind": origin.sender_kind,
                "senderNickname": origin.sender_nickname,
                "senderConversationId": origin.sender_conversation_id,
                "senderMemberId": origin.sender_member_id,
            }),
        });
    }
    if !display_text.trim().is_empty() {
        visible.push(ConversationInputBlock::Text {
            text: display_text.to_string(),
        });
    }
    visible.extend(blocks.iter().filter_map(|block| match block {
        AgentContentBlock::Text { .. } => None,
        AgentContentBlock::Image { mime_type, uri, .. } => Some(ConversationInputBlock::Image {
            uri: uri.clone().unwrap_or_else(|| "inline-image".to_string()),
            mime_type: mime_type.clone(),
            title: None,
        }),
        AgentContentBlock::Resource { uri, title } => Some(ConversationInputBlock::Resource {
            uri: uri.clone(),
            title: title.clone(),
            mime_type: None,
        }),
        AgentContentBlock::Protocol { content } => Some(ConversationInputBlock::Protocol {
            content: content.clone(),
        }),
    }));
    visible
}

/// Layer the composer's explicit selection on top of profile/slash defaults.
/// A user-picked mode replaces the default; user config overrides win per-key.
pub(super) fn merge_user_prompt_overrides(
    overrides: &mut AgentPromptOverrides,
    mode_override: Option<String>,
    config_overrides: Vec<AgentSessionConfigOverride>,
) {
    if let Some(mode) = mode_override.and_then(|mode| {
        let trimmed = mode.trim().to_string();
        (!trimmed.is_empty()).then_some(trimmed)
    }) {
        overrides.mode_override = Some(mode);
    }
    for ovr in config_overrides {
        if let Some(existing) = overrides
            .config_overrides
            .iter_mut()
            .find(|existing| existing.key == ovr.key)
        {
            existing.value = ovr.value;
        } else {
            overrides.config_overrides.push(ovr);
        }
    }
}

pub(super) fn agent_prompt_overrides_from_profile(
    agent_id: &agents::AgentId,
    profile: Option<&ExecutorProfileId>,
) -> AgentPromptOverrides {
    let Some(profile) = profile else {
        return AgentPromptOverrides::default();
    };

    if profile.executor != *agent_id {
        tracing::warn!(
            requested_agent = %agent_id,
            profile_executor = %profile.executor,
            "Ignoring executor profile overrides for mismatched ACP agent"
        );
    }

    // Every managed Agent is ACP-driven. Only explicit options selected from
    // the Agent's advertised session controls may be sent to a live session.
    AgentPromptOverrides::default()
}

/// Context passed to `beforeTurn` hooks prior to constructing the Agent prompt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeforeTurnContext {
    pub conversation_id: Uuid,
    pub workspace_id: Uuid,
    pub agent_id: AgentId,
    pub text: String,
    pub display_text: String,
    pub origin: String,
}

/// Event payload emitted to `afterTurn` hooks when a turn reaches a terminal state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AfterTurnEvent {
    pub conversation_id: Uuid,
    pub turn_id: Uuid,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

/// Normalized runtime event notification broadcast to `onRuntimeEvent` plugin hooks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEventNotification {
    pub id: Uuid,
    pub conversation_id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<Uuid>,
    pub sequence: i64,
    pub source: String,
    pub kind: String,
    pub event: ConversationEvent,
}

type BeforeTurnHookFn =
    dyn Fn(&BeforeTurnContext) -> Vec<agents::InternalPromptBlock> + Send + Sync + 'static;
type AfterTurnHookFn = dyn Fn(&AfterTurnEvent) + Send + Sync + 'static;

static BEFORE_TURN_HOOKS: std::sync::OnceLock<std::sync::RwLock<Vec<Arc<BeforeTurnHookFn>>>> =
    std::sync::OnceLock::new();
static AFTER_TURN_HOOKS: std::sync::OnceLock<std::sync::RwLock<Vec<Arc<AfterTurnHookFn>>>> =
    std::sync::OnceLock::new();
static AFTER_TURN_TX: std::sync::OnceLock<tokio::sync::broadcast::Sender<AfterTurnEvent>> =
    std::sync::OnceLock::new();
static RUNTIME_EVENT_TX: std::sync::OnceLock<
    tokio::sync::broadcast::Sender<RuntimeEventNotification>,
> = std::sync::OnceLock::new();

fn before_turn_hooks() -> &'static std::sync::RwLock<Vec<Arc<BeforeTurnHookFn>>> {
    BEFORE_TURN_HOOKS.get_or_init(|| std::sync::RwLock::new(Vec::new()))
}

fn after_turn_hooks() -> &'static std::sync::RwLock<Vec<Arc<AfterTurnHookFn>>> {
    AFTER_TURN_HOOKS.get_or_init(|| std::sync::RwLock::new(Vec::new()))
}

fn after_turn_sender() -> &'static tokio::sync::broadcast::Sender<AfterTurnEvent> {
    AFTER_TURN_TX.get_or_init(|| {
        let (tx, _) = tokio::sync::broadcast::channel(256);
        tx
    })
}

fn runtime_event_sender() -> &'static tokio::sync::broadcast::Sender<RuntimeEventNotification> {
    RUNTIME_EVENT_TX.get_or_init(|| {
        let (tx, _) = tokio::sync::broadcast::channel(512);
        tx
    })
}

/// Register a programmable `beforeTurn` hook that can contribute implicit
/// [`agents::InternalPromptBlock`] items to every turn.
pub fn register_before_turn_hook<F>(hook: F)
where
    F: Fn(&BeforeTurnContext) -> Vec<agents::InternalPromptBlock> + Send + Sync + 'static,
{
    if let Ok(mut guard) = before_turn_hooks().write() {
        guard.push(Arc::new(hook));
    }
}

/// Register a programmable `afterTurn` hook invoked when a turn finishes.
pub fn register_after_turn_hook<F>(hook: F)
where
    F: Fn(&AfterTurnEvent) + Send + Sync + 'static,
{
    if let Ok(mut guard) = after_turn_hooks().write() {
        guard.push(Arc::new(hook));
    }
}

/// Clears globally registered `beforeTurn` and `afterTurn` hooks (primarily for tests).
pub fn clear_turn_hooks() {
    if let Ok(mut guard) = before_turn_hooks().write() {
        guard.clear();
    }
    if let Ok(mut guard) = after_turn_hooks().write() {
        guard.clear();
    }
}

/// Subscribe to terminal turn lifecycle events (`afterTurn`).
pub fn subscribe_after_turn_events() -> tokio::sync::broadcast::Receiver<AfterTurnEvent> {
    after_turn_sender().subscribe()
}

/// Subscribe to normalized durable runtime events (`onRuntimeEvent`).
pub fn subscribe_runtime_events() -> tokio::sync::broadcast::Receiver<RuntimeEventNotification> {
    runtime_event_sender().subscribe()
}

pub(crate) fn emit_runtime_event(envelope: &ConversationEventEnvelope, event_kind: &str) {
    let _ = runtime_event_sender().send(RuntimeEventNotification {
        id: envelope.id,
        conversation_id: envelope.conversation_id,
        turn_id: envelope.turn_id,
        sequence: envelope.sequence,
        source: envelope.source.clone(),
        kind: event_kind.to_owned(),
        event: envelope.event.clone(),
    });
}

pub(crate) fn collect_registered_before_turn_contributions(
    ctx: &BeforeTurnContext,
) -> Vec<agents::InternalPromptBlock> {
    let hooks = before_turn_hooks()
        .read()
        .map(|guard| guard.clone())
        .unwrap_or_default();
    let mut out = Vec::new();
    for hook in hooks {
        out.extend(hook(ctx));
    }
    out
}

pub(crate) fn emit_after_turn_event(event: AfterTurnEvent) {
    let _ = after_turn_sender().send(event.clone());
    let hooks = after_turn_hooks()
        .read()
        .map(|guard| guard.clone())
        .unwrap_or_default();
    for hook in hooks {
        hook(&event);
    }
}

pub(crate) fn spawn_turn_end_collaboration_cleanup(
    context: crate::ConversationContext,
    conversation_id: Uuid,
    turn_completed: bool,
    turn_assistant_text: Option<String>,
) {
    let pool = context.deployment.db().pool.clone();
    let delivery_ctx = crate::ScopedConversationControl::new(context).delivery_context();
    tokio::spawn(async move {
        crate::collaboration::reset_space_turn_streaming_step(conversation_id);
        crate::collaboration::clear_space_turn_tool_started(conversation_id);
        let reply = if turn_completed {
            match turn_assistant_text {
                Some(text) => text,
                None => crate::jsonl_history::load_all_turns(&pool, conversation_id)
                    .await
                    .ok()
                    .flatten()
                    .and_then(|turns| {
                        let last_user_idx = turns.iter().rposition(|turn| {
                            matches!(turn.role, agents::TurnRole::User)
                                && !turn.id.contains(":steer:")
                        });
                        let round_slice = match last_user_idx {
                            Some(idx) => &turns[idx + 1..],
                            None => &turns[..],
                        };
                        round_slice
                            .iter()
                            .rev()
                            .find(|turn| turn.role == agents::TurnRole::Assistant)
                            .map(|turn| {
                                crate::runtime_events::space_turn_conclusion_text(
                                    &turn.blocks,
                                    false,
                                    "",
                                )
                            })
                    })
                    .unwrap_or_default(),
            }
        } else {
            String::new()
        };
        if let Err(error) = crate::collaboration::finalize_space_turn_deliveries(
            &pool,
            conversation_id,
            &reply,
            &delivery_ctx,
        )
        .await
        {
            tracing::warn!(
                %conversation_id,
                %error,
                "finalize_space_turn_deliveries failed in service cleanup"
            );
        }
        let _ = crate::collaboration::release_member_write(&pool, conversation_id).await;
        if let Err(error) = crate::collaboration::redeliver_deferred(&pool, &delivery_ctx).await {
            tracing::warn!(
                %conversation_id,
                %error,
                "redeliver_deferred failed in service cleanup"
            );
        }
    });
}

#[cfg(test)]
mod tests {
    use agents::AgentContentBlock;

    use super::agent_blocks_with_display_text;

    #[test]
    fn agent_blocks_with_display_text_omits_redundant_resource_blocks() {
        let blocks = vec![
            AgentContentBlock::Text {
                text: "/cy-cover-designer xxx.srt".to_string(),
            },
            AgentContentBlock::Resource {
                uri: "file:///C:/project/xxx.srt".to_string(),
                title: Some("xxx.srt".to_string()),
            },
            AgentContentBlock::Image {
                data: "abc".to_string(),
                mime_type: "image/png".to_string(),
                uri: Some("image.png".to_string()),
            },
        ];

        let display_blocks = agent_blocks_with_display_text(
            &blocks,
            "[/:cy-cover-designer](/cy-cover-designer) [@:xxx.srt](xxx.srt)",
        );

        assert_eq!(
            display_blocks,
            vec![
                AgentContentBlock::Text {
                    text: "[/:cy-cover-designer](/cy-cover-designer) [@:xxx.srt](xxx.srt)"
                        .to_string(),
                },
                AgentContentBlock::Image {
                    data: "abc".to_string(),
                    mime_type: "image/png".to_string(),
                    uri: Some("image.png".to_string()),
                },
            ]
        );
    }
}
