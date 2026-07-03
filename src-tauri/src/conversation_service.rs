use std::{path::PathBuf, sync::Arc};

use agents::{
    AgentConnectionId, AgentContentBlock, AgentPermissionId, AgentPermissionResponse,
    AgentPromptId, AgentPromptSnapshot, AgentSessionConfigOverride, AgentSessionId, AgentType,
    CancelAgentPromptInput, EnsureAgentSessionInput, RespondAgentPermissionInput,
    ResumeAgentSessionInput, SendAgentPromptInput, agent_type_from_executor_key,
    conversation::{
        AcpCapabilitySnapshot, AgentPromptCapabilities, ConversationAgentConnectionStatus,
        ConversationError, ConversationEvent, ConversationEventEnvelope, ConversationFileChange,
        ConversationFileChangeSummary, ConversationInputBlock, ConversationPermissionResponse,
    },
    executor_key_for,
};
use db::models::{
    conversation::{
        ConversationAgentBindingRecord, ConversationRecord, CreateConversationAgentBinding,
        CreateConversationRecord,
    },
    conversation_event::AppendConversationEvent,
    conversation_projection::{ConversationEventAppender, ConversationProjector},
    conversation_side_effects::ConversationPermissionRecord,
    conversation_turn::{ConversationTurnRecord, CreateConversationTurn},
    session::SessionStatus,
    session_checkpoint::SessionCheckpoint,
    workspace::Workspace,
    workspace_repo::WorkspaceRepo,
};
use deployment::Deployment;
use executors::{
    executors::{BaseCodingAgent, CodingAgent},
    profile::{ExecutorConfigs, ExecutorProfileId, canonical_variant_key},
};
use git::{Commit, DiffTarget};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use ts_rs::TS;
use uuid::Uuid;

use crate::{
    commands::agents::{agent_runtime_launch_settings_from_pool, workspace_prompt_blocks},
    error::AppError,
    state::AppState,
    workspace_paths::resolve_workspace_agent_working_dir,
};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRuntimeState {
    pub conversation_id: Option<Uuid>,
    pub binding_id: Option<Uuid>,
    pub acp_session_id: Option<String>,
    pub connection_id: Option<String>,
    pub active_turn_id: Option<Uuid>,
    pub active_prompt_id: Option<String>,
    pub live_message: Option<String>,
    pub active_tool_call_ids: Vec<String>,
    pub pending_permission_id: Option<String>,
    pub pending_question_id: Option<String>,
    pub active_delegation_ids: Vec<String>,
    pub current_mode: Option<String>,
    pub event_sequence: i64,
    pub pending_user_message: Option<String>,
    pub turn_in_flight: bool,
    pub config_stale: bool,
    pub connection_status: Option<String>,
    pub recovery_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ConversationTurnSnapshot {
    pub conversation_id: Uuid,
    pub turn_id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_id: Option<Uuid>,
    pub status: String,
    pub last_sequence: i64,
}

pub struct ConversationStartTurnInput {
    pub agent_type: AgentType,
    pub workspace_id: Uuid,
    pub conversation_id: Uuid,
    pub executor_profile_id: Option<ExecutorProfileId>,
    pub text: String,
    pub images: Vec<String>,
    /// User-selected session mode for this turn (from the composer's mode
    /// picker, sourced from the agent's advertised `session_modes`). Applied via
    /// the real ACP `SetSessionMode` during prompt setup. `None` keeps the
    /// profile/default mode.
    pub mode_override: Option<String>,
    /// User-selected config option overrides for this turn (real ACP
    /// `SetSessionConfigOption`), e.g. an advertised select option.
    pub config_overrides: Vec<AgentSessionConfigOverride>,
}

#[derive(Debug, Clone, Default)]
struct AgentPromptOverrides {
    mode_override: Option<String>,
    config_overrides: Vec<AgentSessionConfigOverride>,
}

pub struct ConversationSessionService<'a> {
    state: &'a AppState,
}

impl<'a> ConversationSessionService<'a> {
    pub fn new(state: &'a AppState) -> Self {
        Self { state }
    }

    pub async fn start_turn(
        &self,
        input: ConversationStartTurnInput,
    ) -> Result<(ConversationTurnSnapshot, AgentPromptSnapshot), AppError> {
        if input.text.trim().is_empty() && input.images.is_empty() {
            return Err(AppError::BadRequest(
                "Prompt must include text or an image".to_string(),
            ));
        }

        let turn_lock = {
            let mut locks = self.state.conversation_turn_locks.lock().await;
            Arc::clone(
                locks
                    .entry(input.conversation_id)
                    .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
            )
        };
        let _turn_guard = turn_lock.lock().await;

        let pool = &self.state.deployment.db().pool;
        let workspace = Workspace::find_by_id(pool, input.workspace_id)
            .await?
            .ok_or_else(|| {
                AppError::NotFound(format!("Workspace {} not found", input.workspace_id))
            })?;
        let container_ref = self
            .state
            .deployment
            .container()
            .ensure_container_exists(&workspace)
            .await?;
        let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
        let working_dir = resolve_workspace_agent_working_dir(&workspace, &container_ref, &repos)
            .unwrap_or_else(|| container_ref.clone());
        let agent_blocks =
            workspace_prompt_blocks(&working_dir, input.text.clone(), &input.images).await?;
        let conversation_blocks = conversation_input_blocks(&agent_blocks);

        let conversation = self.ensure_conversation(pool, &input).await?;
        ensure_conversation_has_no_in_flight_turn(pool, &conversation).await?;
        ConversationRecord::update_status(pool, input.conversation_id, SessionStatus::InProgress)
            .await?;

        let turn_id = Uuid::new_v4();
        let turn = ConversationTurnRecord::create_pending(
            pool,
            turn_id,
            CreateConversationTurn {
                conversation_id: input.conversation_id,
                prompt_id: None,
                text_preview: Some(&input.text),
                input_blocks_json: &serde_json::to_string(&conversation_blocks)
                    .map_err(|error| AppError::Internal(error.to_string()))?,
            },
        )
        .await?;
        ConversationRecord::update_active_turn(pool, input.conversation_id, Some(turn.id)).await?;

        let created = self
            .append_event(
                input.conversation_id,
                Some(turn.id),
                "user",
                ConversationEvent::UserTurnCreated {
                    blocks: conversation_blocks,
                },
                Some(format!("turn:{}:created", turn.id)),
            )
            .await?;

        self.update_runtime_state(input.conversation_id, |state| {
            state.conversation_id = Some(input.conversation_id);
            state.active_turn_id = Some(turn.id);
            state.pending_user_message = Some(input.text.clone());
            state.turn_in_flight = true;
            state.event_sequence = created.sequence;
        })
        .await;

        let result = self
            .send_turn_to_agent(&input, &working_dir, agent_blocks, turn.id)
            .await;

        match result {
            Ok(prompt) => {
                self.append_event(
                    input.conversation_id,
                    Some(turn.id),
                    "runtime",
                    ConversationEvent::UserTurnStarted,
                    Some(format!("turn:{}:started", turn.id)),
                )
                .await?;
                let prompt_uuid = prompt.id.0;
                ConversationTurnRecord::set_prompt_id(pool, turn.id, &prompt.id.to_string())
                    .await?;
                self.update_runtime_state(input.conversation_id, |state| {
                    state.active_prompt_id = Some(prompt.id.to_string());
                })
                .await;
                Ok((
                    ConversationTurnSnapshot {
                        conversation_id: input.conversation_id,
                        turn_id: turn.id,
                        prompt_id: Some(prompt_uuid),
                        status: "running".to_string(),
                        last_sequence: created.sequence + 1,
                    },
                    prompt,
                ))
            }
            Err(error) => {
                let message = error.to_string();
                let failed = self
                    .append_event(
                        input.conversation_id,
                        Some(turn.id),
                        "runtime",
                        ConversationEvent::TurnFailed {
                            error: ConversationError {
                                message: message.clone(),
                                code: None,
                                raw: None,
                            },
                        },
                        Some(format!("turn:{}:send_failed", turn.id)),
                    )
                    .await?;
                self.update_runtime_state(input.conversation_id, |state| {
                    state.turn_in_flight = false;
                    state.event_sequence = failed.sequence;
                    state.recovery_status = Some("send_failed".to_string());
                })
                .await;
                Err(error)
            }
        }
    }

    pub async fn respond_permission(
        &self,
        conversation_id: Uuid,
        permission_id: String,
        response: AgentPermissionResponse,
    ) -> Result<(), AppError> {
        let (connection_id, turn_id) = self
            .runtime_connection_and_turn(conversation_id)
            .await
            .ok_or_else(|| {
                AppError::BadRequest(
                    "Conversation has no active Agent connection for permission response"
                        .to_string(),
                )
            })?;
        let permission_uuid = Uuid::parse_str(&permission_id).map_err(|error| {
            AppError::BadRequest(format!("invalid permission id `{permission_id}`: {error}"))
        })?;
        self.state
            .agent_runtime
            .respond_permission(RespondAgentPermissionInput {
                connection_id,
                permission_id: AgentPermissionId(permission_uuid),
                response: response.clone(),
            })
            .await?;
        self.append_event(
            conversation_id,
            turn_id,
            "host",
            ConversationEvent::PermissionResponded {
                permission_id: permission_id.clone(),
                response: ConversationPermissionResponse {
                    response,
                    auto: false,
                },
            },
            Some(format!("permission:{permission_id}:responded")),
        )
        .await?;
        Ok(())
    }

    pub async fn cancel_turn(
        &self,
        conversation_id: Uuid,
        reason: Option<String>,
    ) -> Result<(), AppError> {
        let snapshot = self.runtime_snapshot(conversation_id).await;
        let turn_id = snapshot.active_turn_id;
        if let (Some(connection_id), Some(prompt_id)) = (
            snapshot
                .connection_id
                .as_deref()
                .and_then(parse_agent_connection_id),
            snapshot
                .active_prompt_id
                .as_deref()
                .and_then(parse_agent_prompt_id),
        ) {
            self.state
                .agent_runtime
                .cancel_prompt(CancelAgentPromptInput {
                    connection_id,
                    session_id: AgentSessionId(conversation_id),
                    prompt_id,
                })
                .await?;
        }
        self.append_event(
            conversation_id,
            turn_id,
            "runtime",
            ConversationEvent::TurnCancelled {
                reason: reason.clone(),
            },
            Some(format!(
                "turn:{}:cancelled",
                turn_id
                    .map(|id| id.to_string())
                    .unwrap_or_else(|| "unknown".to_string())
            )),
        )
        .await?;
        ConversationRecord::update_active_turn(
            &self.state.deployment.db().pool,
            conversation_id,
            None,
        )
        .await?;
        self.update_runtime_state(conversation_id, |state| {
            state.turn_in_flight = false;
            state.active_turn_id = None;
            state.active_prompt_id = None;
            state.recovery_status = reason;
        })
        .await;
        Ok(())
    }

    /// Reset-to-here: truncate the conversation back to *before* the user turn at
    /// `ordinal` — delete that turn and everything after it (events, turns,
    /// checkpoints) and rebuild the projection — so the caller can re-send that
    /// message in its original position. The optional workspace file rollback is the
    /// caller's separate concern (it must run before this, while the ordinal's
    /// checkpoint still exists).
    pub async fn truncate_to_turn(
        &self,
        conversation_id: Uuid,
        user_ordinal: i64,
    ) -> Result<(), AppError> {
        // Serialize against start_turn / cancel_turn on the same conversation.
        let turn_lock = {
            let mut locks = self.state.conversation_turn_locks.lock().await;
            Arc::clone(
                locks
                    .entry(conversation_id)
                    .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
            )
        };
        let _turn_guard = turn_lock.lock().await;

        let pool = &self.state.deployment.db().pool;
        // `user_ordinal` is the 0-based user-message index (same basis as the checkpoint
        // ordinal / `reset_agent_session_to_checkpoint`). `conversation_turns.ordinal`
        // is 1-based (created via `MAX(ordinal)+1`), so the turn to reset *from* is
        // `user_ordinal + 1`; checkpoints share the 0-based basis.
        let turn_ordinal = user_ordinal + 1;
        ConversationProjector::truncate_to_turn_ordinal(pool, conversation_id, turn_ordinal)
            .await?;
        SessionCheckpoint::delete_from_ordinal(pool, conversation_id, user_ordinal).await?;
        ConversationRecord::update_active_turn(pool, conversation_id, None).await?;

        self.update_runtime_state(conversation_id, |state| {
            state.active_turn_id = None;
            state.active_prompt_id = None;
            state.turn_in_flight = false;
            state.pending_user_message = None;
        })
        .await;

        Ok(())
    }

    pub async fn close_conversation(
        &self,
        conversation_id: Uuid,
        reason: Option<String>,
    ) -> Result<(), AppError> {
        self.append_event(
            conversation_id,
            None,
            "runtime",
            ConversationEvent::AgentConnectionStatusChanged {
                status: ConversationAgentConnectionStatus::Closed,
            },
            Some(format!("conversation:{conversation_id}:closed")),
        )
        .await?;
        ConversationRecord::update_status(
            &self.state.deployment.db().pool,
            conversation_id,
            SessionStatus::Done,
        )
        .await?;
        self.update_runtime_state(conversation_id, |state| {
            state.turn_in_flight = false;
            state.connection_status = Some("closed".to_string());
            state.recovery_status = reason;
        })
        .await;
        // Drop this conversation's in-memory coordination state now that it is closed.
        // Without this, both maps leaked one entry per conversation ever opened — the
        // whole codebase had no `remove` on either (架构报告 recovery). The closed
        // status is authoritative in the event log + SessionStatus, not these maps.
        self.forget_conversation_runtime(conversation_id).await;
        Ok(())
    }

    /// Reconcile turns orphaned by the previous process lifecycle (startup recovery,
    /// ADR-0001). A turn left in-flight (pending/queued/running/blocked) when the host
    /// died can never resume its generation, so drive it to the **Interrupted** terminal
    /// state *through the event log* (never a bare status UPDATE) and void its orphaned
    /// pending permission requests. Session *context* is reloaded lazily on the next
    /// open/send via ACP `session/load` — we deliberately do **not** eagerly reconnect
    /// agents here. Returns the number of turns recovered.
    pub async fn recover_interrupted_turns(&self) -> Result<usize, AppError> {
        let pool = &self.state.deployment.db().pool;
        let in_flight = ConversationTurnRecord::list_in_flight(pool).await?;
        if in_flight.is_empty() {
            return Ok(0);
        }

        let count = in_flight.len();
        tracing::info!(
            count,
            "startup recovery: marking orphaned in-flight turns as interrupted"
        );

        for turn in &in_flight {
            // Void any pending permission requests orphaned on this turn — event-sourced
            // (a Cancelled `PermissionResponded`) so a projection rebuild stays consistent.
            let permissions = ConversationPermissionRecord::list_for_turn(pool, turn.id).await?;
            for permission in permissions.into_iter().filter(|p| p.status == "pending") {
                self.append_event(
                    turn.conversation_id,
                    Some(turn.id),
                    "runtime",
                    ConversationEvent::PermissionResponded {
                        permission_id: permission.permission_id.clone(),
                        response: ConversationPermissionResponse {
                            response: AgentPermissionResponse::Cancelled,
                            auto: true,
                        },
                    },
                    Some(format!(
                        "recovery:permission-cancelled:{}",
                        permission.permission_id
                    )),
                )
                .await?;
            }

            // Advance the turn to Interrupted through the event log (never a bare UPDATE).
            // The idempotency key makes a second recovery pass a no-op.
            self.append_event(
                turn.conversation_id,
                Some(turn.id),
                "runtime",
                ConversationEvent::TurnInterrupted {
                    reason: Some("会话在生成过程中因应用重启而中断".to_string()),
                },
                Some(format!("recovery:turn-interrupted:{}", turn.id)),
            )
            .await?;

            // The interrupted turn is terminal, so it is no longer the active turn.
            ConversationRecord::update_active_turn(pool, turn.conversation_id, None).await?;
            // Defensive: clear any lingering coordination state for the conversation
            // (empty at startup, but keeps recovery self-contained).
            self.forget_conversation_runtime(turn.conversation_id).await;
        }

        Ok(count)
    }

    /// Remove a conversation's entries from both in-memory coordination maps.
    async fn forget_conversation_runtime(&self, conversation_id: Uuid) {
        self.state
            .conversation_turn_locks
            .lock()
            .await
            .remove(&conversation_id);
        self.state
            .conversation_runtime_states
            .lock()
            .await
            .remove(&conversation_id);
    }

    async fn ensure_conversation(
        &self,
        pool: &SqlitePool,
        input: &ConversationStartTurnInput,
    ) -> Result<ConversationRecord, AppError> {
        if let Some(existing) = ConversationRecord::find_by_id(pool, input.conversation_id).await? {
            return Ok(existing);
        }

        ConversationRecord::create(
            pool,
            input.conversation_id,
            CreateConversationRecord {
                workspace_id: input.workspace_id,
                task_id: None,
                title: None,
                initial_prompt: Some(&input.text),
                status: Some(SessionStatus::InProgress),
                executor: Some("agent"),
            },
        )
        .await
        .map_err(Into::into)
    }

    async fn send_turn_to_agent(
        &self,
        input: &ConversationStartTurnInput,
        working_dir: &str,
        blocks: Vec<AgentContentBlock>,
        turn_id: Uuid,
    ) -> Result<AgentPromptSnapshot, AppError> {
        let pool = &self.state.deployment.db().pool;
        let launch_settings =
            agent_runtime_launch_settings_from_pool(pool, input.agent_type).await?;
        let latest_binding =
            ConversationAgentBindingRecord::latest_for_conversation(pool, input.conversation_id)
                .await?;
        let acp_session_id = latest_binding
            .as_ref()
            .and_then(|binding| binding.acp_session_id.clone())
            .unwrap_or_else(|| format!("vibex-new-session-{}", input.conversation_id));

        // Lazy reconnect (ADR-0001): when a conversation is reopened after its agent
        // process ended (host restart, or the conversation was closed), the runtime has
        // no live connection for it. If a real ACP session id was established before, we
        // reload its context via ACP `session/load` on this send rather than reconnecting
        // blank. `resume_session` → `load_or_new_acp_session` falls back to a fresh
        // session when the agent lacks the load capability. We never reconnect eagerly at
        // startup — only here, on demand.
        let has_live_connection = self
            .runtime_connection_and_turn(input.conversation_id)
            .await
            .is_some();
        let resume_external_session_id = latest_binding
            .as_ref()
            .and_then(|binding| binding.acp_session_id.clone())
            .filter(|id| !id.starts_with("vibex-new-session-"))
            .filter(|_| !has_live_connection);

        let binding = ConversationAgentBindingRecord::create(
            pool,
            Uuid::new_v4(),
            CreateConversationAgentBinding {
                conversation_id: input.conversation_id,
                agent_type: executor_key_for(input.agent_type),
                working_dir,
                acp_session_id: Some(&acp_session_id),
                acp_protocol_version: None,
                load_supported: true,
                resume_supported: resume_external_session_id.is_some(),
                close_supported: true,
                terminal_supported: true,
                additional_directories_supported: false,
                prompt_capabilities_json: r#"{"text":true,"image":true,"resource":false}"#,
                session_capabilities_json: "{}",
                client_capabilities_json: "{}",
                mcp_servers_json: "[]",
                modes_json: "[]",
                config_options_json: "[]",
                current_mode: None,
                status: "connecting",
            },
        )
        .await?;
        self.append_event(
            input.conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::AgentBindingStarted {
                agent_type: input.agent_type,
                working_dir: working_dir.to_string(),
            },
            Some(format!("binding:{}:started", binding.id)),
        )
        .await?;

        let session = if let Some(external_session_id) = resume_external_session_id {
            self.state
                .agent_runtime
                .resume_session(ResumeAgentSessionInput {
                    agent_type: input.agent_type,
                    workspace_id: input.workspace_id,
                    working_dir: PathBuf::from(working_dir),
                    session_id: AgentSessionId(input.conversation_id),
                    external_session_id,
                    auto_approve_mode: launch_settings.auto_approve_mode,
                    env: launch_settings.env.clone(),
                })
                .await?
        } else {
            self.state
                .agent_runtime
                .ensure_session(EnsureAgentSessionInput {
                    agent_type: input.agent_type,
                    workspace_id: input.workspace_id,
                    working_dir: PathBuf::from(working_dir),
                    session_id: AgentSessionId(input.conversation_id),
                    acp_session_id: acp_session_id.clone(),
                    auto_approve_mode: launch_settings.auto_approve_mode,
                    env: launch_settings.env.clone(),
                })
                .await?
        };

        ConversationAgentBindingRecord::bind_acp_session(
            pool,
            binding.id,
            &session.acp_session_id,
            None,
            "ready",
        )
        .await?;
        self.append_event(
            input.conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::AgentBindingReady {
                acp_session_id: session.acp_session_id.clone(),
                capabilities: default_capabilities(),
            },
            Some(format!("binding:{}:ready", binding.id)),
        )
        .await?;

        match self
            .state
            .deployment
            .container()
            .checkpoint_agent_session(input.conversation_id)
            .await
        {
            Ok(ordinal) => {
                if let Err(error) =
                    record_conversation_checkpoint(pool, input.conversation_id, turn_id, ordinal)
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
            input.agent_type,
            input.executor_profile_id.as_ref(),
        );
        // The composer's explicit mode/config selection wins over profile/slash
        // defaults so the user-picked, agent-advertised mode actually takes effect.
        merge_user_prompt_overrides(
            &mut prompt_overrides,
            input.mode_override.clone(),
            input.config_overrides.clone(),
        );
        let prompt = self
            .state
            .agent_runtime
            .send_prompt(SendAgentPromptInput {
                connection_id: session.connection_id,
                session_id: session.id,
                blocks,
                mode_override: prompt_overrides.mode_override,
                config_overrides: prompt_overrides.config_overrides,
            })
            .await?;

        self.update_runtime_state(input.conversation_id, |state| {
            state.binding_id = Some(binding.id);
            state.acp_session_id = Some(session.acp_session_id.clone());
            state.connection_id = Some(session.connection_id.to_string());
            state.connection_status = Some("ready".to_string());
        })
        .await;

        Ok(prompt)
    }

    async fn append_event(
        &self,
        conversation_id: Uuid,
        turn_id: Option<Uuid>,
        source: &'static str,
        event: ConversationEvent,
        idempotency_key: Option<String>,
    ) -> Result<db::models::conversation_event::ConversationEventRecord, AppError> {
        let value =
            serde_json::to_value(&event).map_err(|error| AppError::Internal(error.to_string()))?;
        // `ConversationEvent` is `#[serde(tag = "kind")]`, so its serialized form
        // always carries a string `kind`. Assert the invariant instead of masking
        // a would-be-impossible failure as the literal "unknown".
        let event_kind = value["kind"]
            .as_str()
            .expect("serialized ConversationEvent always has a string `kind` tag")
            .to_string();
        let normalized_json =
            serde_json::to_string(&event).map_err(|error| AppError::Internal(error.to_string()))?;
        ConversationEventAppender::append(
            &self.state.deployment.db().pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id,
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                source,
                event_kind: &event_kind,
                normalized_json: &normalized_json,
                raw_json: None,
                idempotency_key: idempotency_key.as_deref(),
            },
        )
        .await
        .map_err(Into::into)
    }

    async fn update_runtime_state(
        &self,
        conversation_id: Uuid,
        update: impl FnOnce(&mut ConversationRuntimeState),
    ) {
        let mut states = self.state.conversation_runtime_states.lock().await;
        let state = states.entry(conversation_id).or_default();
        update(state);
    }

    async fn runtime_snapshot(&self, conversation_id: Uuid) -> ConversationRuntimeState {
        self.state
            .conversation_runtime_states
            .lock()
            .await
            .get(&conversation_id)
            .cloned()
            .unwrap_or_default()
    }

    async fn runtime_connection_and_turn(
        &self,
        conversation_id: Uuid,
    ) -> Option<(AgentConnectionId, Option<Uuid>)> {
        let snapshot = self.runtime_snapshot(conversation_id).await;
        snapshot
            .connection_id
            .as_deref()
            .and_then(parse_agent_connection_id)
            .map(|connection_id| (connection_id, snapshot.active_turn_id))
    }
}

async fn ensure_conversation_has_no_in_flight_turn(
    pool: &SqlitePool,
    conversation: &ConversationRecord,
) -> Result<(), AppError> {
    let Some(active_turn_id) = conversation.active_turn_id else {
        return Ok(());
    };
    let Some(active_turn) = ConversationTurnRecord::find_by_id(pool, active_turn_id).await? else {
        return Ok(());
    };

    if is_in_flight_turn_status(&active_turn.status) {
        return Err(AppError::Conflict(format!(
            "Conversation {} already has an active turn",
            conversation.id
        )));
    }

    Ok(())
}

fn is_in_flight_turn_status(status: &str) -> bool {
    matches!(status, "pending" | "queued" | "running" | "blocked")
}

#[derive(Debug, sqlx::FromRow)]
struct ConversationCheckpointRow {
    id: Uuid,
    ordinal: i64,
    before_snapshot_json: Option<String>,
}

pub async fn finalize_checkpoint_file_changes<D: Deployment + ?Sized>(
    deployment: &D,
    conversation_id: Uuid,
    turn_id: Uuid,
) -> Result<Option<ConversationEventEnvelope>, AppError> {
    let pool = &deployment.db().pool;
    let Some(checkpoint) = sqlx::query_as::<_, ConversationCheckpointRow>(
        r#"SELECT id, ordinal, before_snapshot_json
           FROM conversation_checkpoints
           WHERE conversation_id = ? AND turn_id = ? AND finalized_at IS NULL
           ORDER BY created_at DESC
           LIMIT 1"#,
    )
    .bind(conversation_id)
    .bind(turn_id)
    .fetch_optional(pool)
    .await?
    else {
        return Ok(None);
    };

    let Some(conversation) = ConversationRecord::find_by_id(pool, conversation_id).await? else {
        return Ok(None);
    };
    let workspace = Workspace::find_by_id(pool, conversation.workspace_id)
        .await?
        .ok_or_else(|| {
            AppError::NotFound(format!("Workspace {} not found", conversation.workspace_id))
        })?;
    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let checkpoints =
        SessionCheckpoint::find_by_ordinal(pool, conversation_id, checkpoint.ordinal).await?;

    let mut files = Vec::new();
    let mut after_repos = Vec::new();
    for checkpoint_repo in checkpoints {
        let Some(repo) = repos.iter().find(|repo| repo.id == checkpoint_repo.repo_id) else {
            continue;
        };
        let repo_path = workspace
            .repo_path(repo)
            .unwrap_or_else(|| PathBuf::from(&container_ref));
        let after_head = deployment.container().git().get_head_info(&repo_path).ok();
        after_repos.push(serde_json::json!({
            "repoId": repo.id,
            "repoName": repo.name,
            "beforeHeadCommit": checkpoint_repo.before_head_commit,
            "afterHeadCommit": after_head.as_ref().map(|head| head.oid.clone()),
        }));

        let Ok(oid) = git2::Oid::from_str(&checkpoint_repo.before_head_commit) else {
            tracing::warn!(
                repo_id = %repo.id,
                before_head = %checkpoint_repo.before_head_commit,
                "failed to parse conversation checkpoint commit"
            );
            continue;
        };
        let base_commit = Commit::new(oid);
        let diffs = match deployment.container().git().get_diffs(
            DiffTarget::Worktree {
                worktree_path: &repo_path,
                base_commit: &base_commit,
            },
            None,
        ) {
            Ok(diffs) => diffs,
            Err(error) => {
                tracing::warn!(
                    repo_id = %repo.id,
                    path = %repo_path.display(),
                    %error,
                    "failed to compute conversation checkpoint diff"
                );
                continue;
            }
        };
        files.extend(
            diffs
                .into_iter()
                .filter_map(diff_to_conversation_file_change),
        );
    }

    let after_snapshot_json = serde_json::json!({
        "ordinal": checkpoint.ordinal,
        "repos": after_repos,
    })
    .to_string();
    let diff_summary = checkpoint_file_change_summary(&files);
    let diff_summary_json = serde_json::to_string(&serde_json::json!({
        "fileCount": files.len(),
        "summary": diff_summary,
        "before": checkpoint.before_snapshot_json,
    }))?;

    sqlx::query(
        r#"UPDATE conversation_checkpoints
           SET after_snapshot_json = ?,
               diff_summary_json = ?,
               finalized_at = datetime('now', 'subsec')
           WHERE id = ?"#,
    )
    .bind(&after_snapshot_json)
    .bind(&diff_summary_json)
    .bind(checkpoint.id)
    .execute(pool)
    .await?;

    if files.is_empty() {
        return Ok(None);
    }

    let event = ConversationEvent::FileChangeSummaryUpdated {
        summary: ConversationFileChangeSummary {
            source: "checkpoint_diff".to_string(),
            files,
            summary: Some(diff_summary),
        },
    };
    let value = serde_json::to_value(&event)?;
    let event_kind = value["kind"].as_str().unwrap_or("unknown").to_string();
    let normalized_json = serde_json::to_string(&event)?;
    let idempotency_key = format!("checkpoint:{turn_id}:file_changes");
    let record = ConversationEventAppender::append(
        pool,
        AppendConversationEvent {
            id: Uuid::new_v4(),
            conversation_id,
            turn_id: Some(turn_id),
            binding_id: None,
            connection_id: None,
            prompt_id: None,
            source: "system",
            event_kind: &event_kind,
            normalized_json: &normalized_json,
            raw_json: Some(&diff_summary_json),
            idempotency_key: Some(&idempotency_key),
        },
    )
    .await?;

    Ok(Some(ConversationEventEnvelope {
        id: record.id,
        conversation_id: record.conversation_id,
        turn_id: record.turn_id,
        sequence: record.sequence,
        source: record.source,
        event,
        created_at: record.created_at,
    }))
}

async fn record_conversation_checkpoint(
    pool: &SqlitePool,
    conversation_id: Uuid,
    turn_id: Uuid,
    ordinal: i64,
) -> Result<(), AppError> {
    let checkpoints = SessionCheckpoint::find_by_ordinal(pool, conversation_id, ordinal).await?;
    let before_snapshot_json = serde_json::json!({
        "ordinal": ordinal,
        "repos": checkpoints
            .iter()
            .map(|checkpoint| serde_json::json!({
                "repoId": checkpoint.repo_id,
                "beforeHeadCommit": checkpoint.before_head_commit,
            }))
            .collect::<Vec<_>>(),
    })
    .to_string();
    sqlx::query(
        r#"INSERT INTO conversation_checkpoints (
               id, conversation_id, turn_id, ordinal, before_snapshot_json
           )
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(conversation_id, ordinal) DO UPDATE SET
               turn_id = excluded.turn_id,
               before_snapshot_json = excluded.before_snapshot_json"#,
    )
    .bind(Uuid::new_v4())
    .bind(conversation_id)
    .bind(turn_id)
    .bind(ordinal)
    .bind(before_snapshot_json)
    .execute(pool)
    .await?;
    Ok(())
}

fn diff_to_conversation_file_change(diff: utils::diff::Diff) -> Option<ConversationFileChange> {
    let path = git::GitService::diff_path(&diff);
    if path.trim().is_empty() {
        return None;
    }
    Some(ConversationFileChange {
        path,
        change_kind: diff_change_kind(&diff.change).to_string(),
        additions: diff.additions.map(|value| value as i64),
        deletions: diff.deletions.map(|value| value as i64),
        old_path: diff.old_path,
    })
}

fn diff_change_kind(change: &utils::diff::DiffChangeKind) -> &'static str {
    match change {
        utils::diff::DiffChangeKind::Added => "added",
        utils::diff::DiffChangeKind::Deleted => "deleted",
        utils::diff::DiffChangeKind::Renamed => "renamed",
        utils::diff::DiffChangeKind::Modified
        | utils::diff::DiffChangeKind::Copied
        | utils::diff::DiffChangeKind::PermissionChange => "modified",
    }
}

fn checkpoint_file_change_summary(files: &[ConversationFileChange]) -> String {
    let added = files
        .iter()
        .filter(|file| file.change_kind == "added")
        .count();
    let modified = files
        .iter()
        .filter(|file| file.change_kind == "modified")
        .count();
    let deleted = files
        .iter()
        .filter(|file| file.change_kind == "deleted")
        .count();
    let renamed = files
        .iter()
        .filter(|file| file.change_kind == "renamed")
        .count();
    format!(
        "{} file(s) changed: {} added, {} modified, {} deleted, {} renamed",
        files.len(),
        added,
        modified,
        deleted,
        renamed
    )
}

fn conversation_input_blocks(blocks: &[AgentContentBlock]) -> Vec<ConversationInputBlock> {
    blocks
        .iter()
        .map(|block| match block {
            AgentContentBlock::Text { text } => ConversationInputBlock::Text { text: text.clone() },
            AgentContentBlock::Image { mime_type, uri, .. } => ConversationInputBlock::Image {
                uri: uri.clone().unwrap_or_else(|| "inline-image".to_string()),
                mime_type: mime_type.clone(),
                title: None,
            },
            AgentContentBlock::Resource { uri, title } => ConversationInputBlock::Resource {
                uri: uri.clone(),
                title: title.clone(),
                mime_type: None,
            },
        })
        .collect()
}

fn default_capabilities() -> AcpCapabilitySnapshot {
    AcpCapabilitySnapshot {
        prompt: AgentPromptCapabilities {
            text: true,
            image: true,
            resource: false,
        },
        load_session: true,
        close_session: true,
        terminal: true,
        ..Default::default()
    }
}

/// Layer the composer's explicit selection on top of profile/slash defaults.
/// A user-picked mode replaces the default; user config overrides win per-key.
fn merge_user_prompt_overrides(
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

fn agent_prompt_overrides_from_profile(
    agent_type: AgentType,
    profile: Option<&ExecutorProfileId>,
) -> AgentPromptOverrides {
    let Some(profile) = profile else {
        return AgentPromptOverrides::default();
    };

    if agent_type_from_executor_key(&profile.executor.to_string()) != Some(agent_type) {
        tracing::warn!(
            requested_agent = ?agent_type,
            profile_executor = %profile.executor,
            "Ignoring executor profile overrides for mismatched ACP agent"
        );
        return AgentPromptOverrides::default();
    }

    let configs = ExecutorConfigs::get_cached();
    let variant_key = profile
        .variant
        .as_deref()
        .map(canonical_variant_key)
        .unwrap_or_else(|| "DEFAULT".to_string());
    let config = configs
        .executors
        .get(&profile.executor)
        .and_then(|executor_profile| {
            executor_profile
                .configurations
                .get(&variant_key)
                .or_else(|| executor_profile.configurations.get("DEFAULT"))
        });

    let mut overrides = AgentPromptOverrides::default();

    match (profile.executor, config) {
        (BaseCodingAgent::ClaudeCode, Some(CodingAgent::ClaudeCode(config))) => {
            push_config_override(
                &mut overrides.config_overrides,
                "model",
                profile.model.clone().or_else(|| config.model.clone()),
            );
            let permission = if config.plan.unwrap_or(false) {
                overrides.mode_override = Some("plan".to_string());
                "plan"
            } else if config.approvals.unwrap_or(false) {
                "ask"
            } else {
                "auto"
            };
            push_config_override(
                &mut overrides.config_overrides,
                "permission_mode",
                Some(permission.to_string()),
            );
        }
        (BaseCodingAgent::Codex, Some(CodingAgent::Codex(config))) => {
            push_config_override(
                &mut overrides.config_overrides,
                "model",
                profile.model.clone().or_else(|| config.model.clone()),
            );
            push_config_override(
                &mut overrides.config_overrides,
                "sandbox",
                config
                    .sandbox
                    .as_ref()
                    .map(|value| value.as_ref().to_string()),
            );
            if let Some(approval) = &config.ask_for_approval {
                let value = approval.as_ref().to_string();
                let permission_mode = if value == "never" { "auto" } else { "ask" };
                push_config_override(
                    &mut overrides.config_overrides,
                    "approval_policy",
                    Some(value),
                );
                push_config_override(
                    &mut overrides.config_overrides,
                    "permission_mode",
                    Some(permission_mode.to_string()),
                );
            }
            push_config_override(
                &mut overrides.config_overrides,
                "reasoning_effort",
                profile.reasoning_effort.clone().or_else(|| {
                    config
                        .model_reasoning_effort
                        .as_ref()
                        .map(|value| value.as_ref().to_string())
                }),
            );
        }
        (BaseCodingAgent::Opencode, Some(CodingAgent::Opencode(config))) => {
            push_config_override(
                &mut overrides.config_overrides,
                "model",
                profile.model.clone().or_else(|| config.model.clone()),
            );
            if let Some(agent_mode) = &config.agent {
                overrides.mode_override = Some(agent_mode.clone());
                push_config_override(
                    &mut overrides.config_overrides,
                    "mode",
                    Some(agent_mode.clone()),
                );
            }
            push_config_override(
                &mut overrides.config_overrides,
                "permission_mode",
                Some(if config.auto_approve { "auto" } else { "ask" }.to_string()),
            );
        }
        _ => {
            push_config_override(
                &mut overrides.config_overrides,
                "model",
                profile.model.clone(),
            );
            push_config_override(
                &mut overrides.config_overrides,
                "reasoning_effort",
                profile.reasoning_effort.clone(),
            );
        }
    }

    if let Some(fast_mode) = profile.fast_mode {
        push_config_override(
            &mut overrides.config_overrides,
            "fast_mode",
            Some(fast_mode.to_string()),
        );
    }

    overrides
}

fn push_config_override(
    overrides: &mut Vec<AgentSessionConfigOverride>,
    key: &'static str,
    value: Option<String>,
) {
    let Some(value) = value.map(|value| value.trim().to_string()) else {
        return;
    };
    if value.is_empty() {
        return;
    }

    if let Some(existing) = overrides.iter_mut().find(|item| item.key == key) {
        existing.value = value;
    } else {
        overrides.push(AgentSessionConfigOverride {
            key: key.to_string(),
            value,
        });
    }
}

fn parse_agent_connection_id(value: &str) -> Option<AgentConnectionId> {
    Uuid::parse_str(value).ok().map(AgentConnectionId)
}

fn parse_agent_prompt_id(value: &str) -> Option<AgentPromptId> {
    Uuid::parse_str(value).ok().map(AgentPromptId)
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use agents::{AgentContentBlock, AgentSessionConfigOverride};
    use db::models::{
        conversation::{ConversationRecord, CreateConversationRecord},
        conversation_turn::{ConversationTurnRecord, CreateConversationTurn},
        session::SessionStatus,
    };
    use sqlx::{
        SqlitePool,
        sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    };
    use utils::diff::{Diff, DiffChangeKind};
    use uuid::Uuid;

    use super::{
        AgentPromptOverrides, checkpoint_file_change_summary, conversation_input_blocks,
        default_capabilities, diff_to_conversation_file_change,
        ensure_conversation_has_no_in_flight_turn, merge_user_prompt_overrides,
    };
    use crate::error::AppError;

    async fn migrated_pool() -> SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("sqlite options")
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("memory db");
        sqlx::migrate!("../crates/db/migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("disable foreign keys");
        pool
    }

    async fn seed_conversation_with_active_turn(pool: &SqlitePool) -> ConversationRecord {
        let conversation_id = Uuid::new_v4();
        ConversationRecord::create(
            pool,
            conversation_id,
            CreateConversationRecord {
                workspace_id: Uuid::new_v4(),
                task_id: None,
                title: Some("Guard test"),
                initial_prompt: Some("hello"),
                status: Some(SessionStatus::InProgress),
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
                prompt_id: None,
                text_preview: Some("hello"),
                input_blocks_json: r#"[{"kind":"text","text":"hello"}]"#,
            },
        )
        .await
        .expect("create turn");
        ConversationRecord::update_active_turn(pool, conversation_id, Some(turn.id))
            .await
            .expect("set active turn");

        ConversationRecord::find_by_id(pool, conversation_id)
            .await
            .expect("find conversation")
            .expect("conversation exists")
    }

    #[test]
    fn conversation_start_turn_maps_agent_blocks_to_input_blocks() {
        let blocks = conversation_input_blocks(&[
            AgentContentBlock::Text {
                text: "hello".to_string(),
            },
            AgentContentBlock::Image {
                data: "abc".to_string(),
                mime_type: "image/png".to_string(),
                uri: Some("image.png".to_string()),
            },
        ]);

        assert_eq!(blocks.len(), 2);
    }

    #[test]
    fn user_prompt_overrides_take_precedence_over_profile_defaults() {
        let mut overrides = AgentPromptOverrides {
            mode_override: Some("plan".to_string()),
            config_overrides: vec![AgentSessionConfigOverride {
                key: "reasoning".to_string(),
                value: "low".to_string(),
            }],
        };

        merge_user_prompt_overrides(
            &mut overrides,
            Some("code".to_string()),
            vec![
                // Overrides the existing key…
                AgentSessionConfigOverride {
                    key: "reasoning".to_string(),
                    value: "high".to_string(),
                },
                // …and adds a new one.
                AgentSessionConfigOverride {
                    key: "verbosity".to_string(),
                    value: "concise".to_string(),
                },
            ],
        );

        assert_eq!(overrides.mode_override.as_deref(), Some("code"));
        assert_eq!(overrides.config_overrides.len(), 2);
        let reasoning = overrides
            .config_overrides
            .iter()
            .find(|o| o.key == "reasoning")
            .unwrap();
        assert_eq!(reasoning.value, "high");
    }

    #[test]
    fn blank_user_mode_override_keeps_the_default() {
        let mut overrides = AgentPromptOverrides {
            mode_override: Some("plan".to_string()),
            config_overrides: Vec::new(),
        };

        merge_user_prompt_overrides(&mut overrides, Some("   ".to_string()), Vec::new());

        assert_eq!(overrides.mode_override.as_deref(), Some("plan"));
    }

    #[test]
    fn conversation_capabilities_default_snapshot_matches_binding_assumptions() {
        let capabilities = default_capabilities();

        assert!(capabilities.prompt.text);
        assert!(capabilities.prompt.image);
        assert!(capabilities.load_session);
        assert!(capabilities.close_session);
        assert!(capabilities.terminal);
    }

    #[test]
    fn conversation_checkpoint_file_changes_map_git_diffs() {
        let change = diff_to_conversation_file_change(Diff {
            change: DiffChangeKind::Renamed,
            old_path: Some("src/old.rs".to_string()),
            new_path: Some("src/new.rs".to_string()),
            old_content: None,
            new_content: None,
            content_omitted: false,
            additions: Some(4),
            deletions: Some(1),
            repo_id: None,
        })
        .expect("file change");

        assert_eq!(change.path, "src/new.rs");
        assert_eq!(change.old_path.as_deref(), Some("src/old.rs"));
        assert_eq!(change.change_kind, "renamed");
        assert_eq!(change.additions, Some(4));
        assert_eq!(
            checkpoint_file_change_summary(&[change]),
            "1 file(s) changed: 0 added, 0 modified, 0 deleted, 1 renamed"
        );
    }

    #[tokio::test]
    async fn in_flight_active_turn_blocks_starting_another_turn() {
        let pool = migrated_pool().await;
        let conversation = seed_conversation_with_active_turn(&pool).await;

        let error = ensure_conversation_has_no_in_flight_turn(&pool, &conversation)
            .await
            .expect_err("pending active turn should block");

        assert!(matches!(
            error,
            AppError::Conflict(message) if message.contains("active turn")
        ));
    }

    #[tokio::test]
    async fn terminal_active_turn_does_not_block_next_turn() {
        let pool = migrated_pool().await;
        let conversation = seed_conversation_with_active_turn(&pool).await;
        let active_turn_id = conversation
            .active_turn_id
            .expect("seeded conversation has active turn");

        ConversationTurnRecord::mark_completed(&pool, active_turn_id, Some("end_turn"), None, None)
            .await
            .expect("mark completed");

        ensure_conversation_has_no_in_flight_turn(&pool, &conversation)
            .await
            .expect("completed active turn should not block");
    }
}
