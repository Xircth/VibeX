use agents::{AgentId, AgentSessionId, ConversationInputPayload, conversation::ConversationEvent};
use chrono::Utc;
use db::models::{
    conversation::ConversationRecord,
    conversation_event::AppendConversationEvent,
    conversation_turn::{ConversationTurnRecord, CreateConversationTurn},
    session::{CreateSession, Session, SessionStatus},
};
use executors::profile::ExecutorProfileId;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::{
    ConversationSessionService, ConversationStartTurnInput, ConversationTurnSnapshot,
    QueuedConversationInputClaim, ensure_conversation_has_no_in_flight_turn,
    is_in_flight_turn_status,
};
use crate::{
    ConversationEventAppender, ConversationInputControl, ConversationInputStatus,
    ConversationInputSubmission, ConversationServiceError, SubmitConversationInput,
};

impl ConversationSessionService {
    /// Persist a durable input, then claim/dispatch if the conversation is idle.
    /// Persist is the user-visible success boundary (ADR-0044).
    pub async fn submit_and_dispatch(
        &self,
        input: ConversationStartTurnInput,
        origin: &str,
    ) -> Result<ConversationInputSubmission, ConversationServiceError> {
        let conversation_id = input.conversation_id;
        let inputs = ConversationInputControl::with_publisher(
            self.ctx.deployment.db().pool.clone(),
            self.ctx.event_publisher.clone(),
        );
        let submitted = inputs
            .submit(SubmitConversationInput {
                conversation_id,
                operation_id: input.operation_id.unwrap_or_else(Uuid::new_v4),
                payload: start_turn_input_payload(&input)?,
                principal: serde_json::json!({ "kind": "origin", "origin": origin }),
            })
            .await?;
        let dispatched = match self.dispatch_next_queued_input(conversation_id).await {
            Ok(turn) => turn,
            Err(error) => {
                tracing::warn!(
                    %conversation_id,
                    input_id = %submitted.id,
                    %error,
                    "durable conversation input was accepted; dispatch will retry later"
                );
                None
            }
        };
        let input = inputs.find(conversation_id, submitted.id).await?;
        let turn = match (dispatched, input.turn_id) {
            (Some(turn), _) => Some(turn),
            (None, Some(turn_id)) => self.turn_snapshot(turn_id).await?,
            (None, None) => None,
        };
        Ok(ConversationInputSubmission { input, turn })
    }

    pub(super) fn spawn_next_queued_input_after_failure(&self, conversation_id: Uuid) {
        let context = self.ctx.clone();
        tokio::spawn(async move {
            if let Err(dispatch_error) = ConversationSessionService::new(context)
                .dispatch_one_queued_input(conversation_id)
                .await
            {
                tracing::warn!(
                    %conversation_id,
                    error = %dispatch_error,
                    "failed to dispatch the next durable conversation input after send failure"
                );
            }
        });
    }

    pub(super) fn spawn_dispatch_queued_after_bind(&self, conversation_id: Uuid) {
        let context = self.ctx.clone();
        tokio::spawn(async move {
            if let Err(error) = ConversationSessionService::new(context)
                .dispatch_next_queued_input(conversation_id)
                .await
            {
                tracing::warn!(
                    %conversation_id,
                    %error,
                    "failed to dispatch queued conversation input after session bind"
                );
            }
        });
    }

    /// Dispatch exactly one durable queued input when the conversation is idle.
    /// The per-conversation turn lock covers idle-check -> claim -> Turn creation,
    /// so concurrent host/remote dispatchers cannot strand a second claim.
    /// Agent I/O runs after that lock is dropped: the same tokio Mutex is not
    /// reentrant, and Stop must be able to acquire it during the handshake.
    pub async fn dispatch_next_queued_input(
        &self,
        conversation_id: Uuid,
    ) -> Result<Option<ConversationTurnSnapshot>, ConversationServiceError> {
        let result = self.dispatch_one_queued_input(conversation_id).await;
        if result
            .as_ref()
            .err()
            .is_some_and(ConversationServiceError::should_retry_queued_dispatch)
        {
            self.spawn_next_queued_input_after_failure(conversation_id);
        }
        result
    }

    pub(super) async fn dispatch_one_queued_input(
        &self,
        conversation_id: Uuid,
    ) -> Result<Option<ConversationTurnSnapshot>, ConversationServiceError> {
        let turn_lock = self.turn_lock(conversation_id).await;
        let _turn_guard = turn_lock.lock().await;
        let pool = &self.ctx.deployment.db().pool;
        let conversation = ConversationRecord::find_by_id(pool, conversation_id)
            .await?
            .ok_or_else(|| {
                ConversationServiceError::NotFound(format!(
                    "Conversation {conversation_id} not found"
                ))
            })?;
        self.reclaim_dead_in_flight_turn(conversation_id).await?;
        let conversation = ConversationRecord::find_by_id(pool, conversation_id)
            .await?
            .unwrap_or(conversation);
        if let Some(active_turn_id) = conversation.active_turn_id
            && let Some(active_turn) =
                ConversationTurnRecord::find_by_id(pool, active_turn_id).await?
            && is_in_flight_turn_status(&active_turn.status)
        {
            return Ok(None);
        }

        let inputs = ConversationInputControl::with_publisher(
            pool.clone(),
            self.ctx.event_publisher.clone(),
        );
        let released_claims = inputs.recover_stale_claims(Utc::now()).await?;
        if released_claims > 0 {
            tracing::info!(
                %conversation_id,
                released_claims,
                "released expired conversation input claims before dispatch"
            );
        }
        let Some(claim) = inputs
            .claim_next(conversation_id, chrono::Duration::seconds(30))
            .await?
        else {
            return Ok(None);
        };
        let input_id = claim.input.id;
        let claim_token = claim.claim_token;
        let payload = claim.input.payload;
        let executor_profile_id = payload
            .executor_profile_id
            .map(serde_json::from_value::<ExecutorProfileId>)
            .transpose()
            .map_err(|error| ConversationServiceError::BadRequest(error.to_string()));
        let executor_profile_id = match executor_profile_id {
            Ok(profile) => profile,
            Err(error) => {
                inputs
                    .release_claim(conversation_id, input_id, claim_token)
                    .await?;
                return Err(error);
            }
        };
        let runtime_session_id = AgentSessionId(conversation_id);
        if !self
            .ctx
            .agent_runtime
            .has_bound_acp_session(runtime_session_id)
            .await
            && let Err(error) = self
                .ensure_session_controls_locked(conversation_id, None)
                .await
        {
            inputs
                .release_claim(conversation_id, input_id, claim_token)
                .await?;
            return Err(error);
        }
        if !self
            .ctx
            .agent_runtime
            .has_bound_acp_session(runtime_session_id)
            .await
        {
            inputs
                .release_claim(conversation_id, input_id, claim_token)
                .await?;
            return Err(ConversationServiceError::SessionUnavailable {
                code: "acp_session_not_bound",
                message: "ACP session is not bound on this connection".into(),
            });
        }
        let committed = match self
            .commit_new_turn(
                ConversationStartTurnInput {
                    agent_id: payload.agent_id,
                    workspace_id: payload.workspace_id,
                    conversation_id,
                    executor_profile_id,
                    text: payload.text,
                    display_text: payload.display_text,
                    images: payload.images,
                    mode_override: payload.mode_override,
                    config_overrides: payload.config_overrides,
                    workflow_refs: payload.workflow_refs,
                    file_refs: payload.file_refs,
                    internal_prompt_contributions: payload.internal_prompt_contributions,
                    queued_input_claim: Some(QueuedConversationInputClaim {
                        input_id,
                        claim_token,
                    }),
                    operation_id: None,
                    collaboration_origin: payload.collaboration_origin,
                },
                crate::commit_reminder::LOCAL_USER_ORIGIN,
            )
            .await
        {
            Ok(committed) => committed,
            Err(error) => {
                let current = inputs.find(conversation_id, input_id).await?;
                if current.status == ConversationInputStatus::Claimed {
                    inputs
                        .release_claim(conversation_id, input_id, claim_token)
                        .await?;
                }
                return Err(error);
            }
        };
        drop(_turn_guard);
        match self.complete_committed_turn(committed).await {
            Ok((turn, _)) => Ok(Some(turn)),
            Err(error) => {
                let current = inputs.find(conversation_id, input_id).await?;
                if current.status == ConversationInputStatus::Claimed {
                    inputs
                        .release_claim(conversation_id, input_id, claim_token)
                        .await?;
                }
                Err(error)
            }
        }
    }

    /// Resume durable queues after host event persistence is online. Each
    /// conversation dispatches at most one Turn; terminal events pump the rest.
    pub async fn dispatch_queued_inputs(&self) -> Result<usize, ConversationServiceError> {
        let inputs = ConversationInputControl::with_publisher(
            self.ctx.deployment.db().pool.clone(),
            self.ctx.event_publisher.clone(),
        );
        if let Err(error) = inputs.recover_orphaned_unsubmitted_claims().await {
            tracing::warn!(%error, "failed to release orphaned conversation input claims");
        }
        let conversation_ids =
            db::models::conversation_input::ConversationInputRecord::queued_conversation_ids(
                &self.ctx.deployment.db().pool,
            )
            .await?;
        let mut started = 0;
        for conversation_id in conversation_ids {
            match self.dispatch_next_queued_input(conversation_id).await {
                Ok(Some(_)) => started += 1,
                Ok(None) => {}
                Err(error) => {
                    tracing::warn!(
                        %conversation_id,
                        %error,
                        "failed to resume a durable conversation input"
                    );
                }
            }
        }
        Ok(started)
    }
}

pub(super) fn start_turn_input_payload(
    input: &ConversationStartTurnInput,
) -> Result<ConversationInputPayload, ConversationServiceError> {
    Ok(ConversationInputPayload {
        agent_id: input.agent_id.clone(),
        workspace_id: input.workspace_id,
        executor_profile_id: input
            .executor_profile_id
            .as_ref()
            .map(serde_json::to_value)
            .transpose()
            .map_err(|error| ConversationServiceError::BadRequest(error.to_string()))?,
        text: input.text.clone(),
        display_text: input.display_text.clone(),
        images: input.images.clone(),
        mode_override: input.mode_override.clone(),
        config_overrides: input.config_overrides.clone(),
        workflow_refs: input.workflow_refs.clone(),
        file_refs: input.file_refs.clone(),
        internal_prompt_contributions: input.internal_prompt_contributions.clone(),
        collaboration_origin: input.collaboration_origin.clone(),
    })
}

pub struct CreateDelegatedConversation {
    pub id: Uuid,
    pub parent_conversation_id: Uuid,
    pub parent_tool_call_id: String,
    pub delegation_id: String,
    pub agent_id: AgentId,
    pub prompt: String,
    pub policy: serde_json::Value,
}

pub struct CreateWorkflowConversation {
    pub id: Uuid,
    pub parent_conversation_id: Uuid,
    pub workspace_id: Uuid,
    pub workflow_run_id: Uuid,
    pub workflow_step_id: String,
    pub agent_id: AgentId,
    pub prompt: String,
    pub visible: bool,
}

pub struct CreateForkConversation {
    pub id: Uuid,
    pub parent_conversation_id: Uuid,
    pub agent_id: AgentId,
    pub title: Option<String>,
    pub initial_prompt: Option<String>,
    pub visible: bool,
}

/// Create a durable programmable child and its fork relation atomically. The
/// caller supplies an operation-derived id, so retries return the same child;
/// reusing that id with a different payload fails closed.
pub async fn create_fork_conversation(
    pool: &SqlitePool,
    input: CreateForkConversation,
) -> Result<Uuid, ConversationServiceError> {
    let payload_digest = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&serde_json::json!({
            "parentConversationId": input.parent_conversation_id,
            "agentId": input.agent_id.as_str(),
            "title": input.title,
            "initialPrompt": input.initial_prompt,
            "visible": input.visible,
        }))?)
    );
    if ConversationRecord::find_by_id(pool, input.id)
        .await?
        .is_some()
    {
        let metadata = sqlx::query_scalar::<_, String>(
            "SELECT metadata_json FROM conversation_relations
             WHERE parent_conversation_id = ? AND child_conversation_id = ?
               AND kind = 'fork'",
        )
        .bind(input.parent_conversation_id)
        .bind(input.id)
        .fetch_optional(pool)
        .await?;
        if metadata
            .and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok())
            .and_then(|value| value["payloadDigest"].as_str().map(str::to_string))
            .as_deref()
            == Some(payload_digest.as_str())
        {
            return Ok(input.id);
        }
        return Err(ConversationServiceError::Conflict(
            "conversation child operation id was reused with a different payload".to_string(),
        ));
    }
    let parent = ConversationRecord::find_by_id(pool, input.parent_conversation_id)
        .await?
        .ok_or_else(|| {
            ConversationServiceError::NotFound(format!(
                "Parent Conversation {} not found",
                input.parent_conversation_id
            ))
        })?;
    ensure_conversation_has_no_in_flight_turn(pool, &parent).await?;
    let relation = ConversationEvent::ConversationRelationCreated {
        relation_id: Uuid::new_v4(),
        parent_conversation_id: input.parent_conversation_id,
        child_conversation_id: input.id,
        relation_kind: agents::ConversationRelationKind::Fork,
        visibility: if input.visible {
            agents::ConversationRelationVisibility::Visible
        } else {
            agents::ConversationRelationVisibility::Hidden
        },
        metadata: serde_json::json!({ "payloadDigest": payload_digest }),
    };
    let normalized_json = serde_json::to_string(&relation)?;
    let relation_key = format!("conversation-relation-fork:{}", input.id);
    let session = CreateSession {
        executor: None,
        agent_id: Some(input.agent_id),
        task_id: parent.task_id,
        name: input.title,
        initial_prompt: input.initial_prompt,
        status: Some(SessionStatus::InProgress),
    };
    let mut conn = pool.acquire().await?;
    sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;
    let transaction = async {
        Session::create_on_connection(&mut conn, &session, input.id, parent.workspace_id)
            .await
            .map_err(|error| ConversationServiceError::Internal(error.to_string()))?;
        ConversationEventAppender::append_and_apply(
            &mut conn,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id: input.parent_conversation_id,
                turn_id: None,
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                source: "system",
                event_kind: "conversation_relation_created",
                normalized_json: &normalized_json,
                raw_json: None,
                idempotency_key: Some(&relation_key),
            },
        )
        .await?;
        Ok::<_, ConversationServiceError>(())
    }
    .await;
    match transaction {
        Ok(()) => sqlx::query("COMMIT").execute(&mut *conn).await?,
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            return Err(error);
        }
    };
    drop(conn);
    crate::jsonl_history::copy_transcript_snapshot(
        pool,
        input.parent_conversation_id,
        input.id,
        None,
    )
    .await?;
    Ok(input.id)
}

pub struct ForkVisibleConversation {
    pub source_id: Uuid,
    pub until_turn_id: Option<Uuid>,
}

pub async fn fork_visible_conversation(
    pool: &SqlitePool,
    input: ForkVisibleConversation,
) -> Result<(Uuid, usize), ConversationServiceError> {
    let parent = ConversationRecord::find_by_id(pool, input.source_id)
        .await?
        .ok_or_else(|| {
            ConversationServiceError::NotFound(format!(
                "Conversation {} not found",
                input.source_id
            ))
        })?;
    ensure_conversation_has_no_in_flight_turn(pool, &parent).await?;
    if let Some(until_turn_id) = input.until_turn_id {
        let turn = ConversationTurnRecord::find_by_id(pool, until_turn_id)
            .await?
            .ok_or_else(|| {
                ConversationServiceError::NotFound(format!("Turn {until_turn_id} not found"))
            })?;
        if turn.conversation_id != input.source_id {
            return Err(ConversationServiceError::BadRequest(
                "Fork turn does not belong to this conversation".to_string(),
            ));
        }
        if is_in_flight_turn_status(&turn.status) {
            return Err(ConversationServiceError::Conflict(
                "Cannot fork from a turn that is still in flight".to_string(),
            ));
        }
    }

    let child_id = Uuid::new_v4();
    let persisted = Session::find_by_id(pool, input.source_id).await?;
    let session = CreateSession {
        executor: persisted.as_ref().and_then(|row| row.executor.clone()),
        agent_id: persisted.as_ref().and_then(|row| row.agent_id.clone()),
        task_id: parent.task_id,
        name: None,
        initial_prompt: None,
        status: Some(SessionStatus::InProgress),
    };
    let mut conn = pool.acquire().await?;
    sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;
    let created = async {
        Session::create_on_connection(&mut conn, &session, child_id, parent.workspace_id)
            .await
            .map_err(|error| ConversationServiceError::Internal(error.to_string()))?;
        Ok::<_, ConversationServiceError>(())
    }
    .await;
    match created {
        Ok(()) => sqlx::query("COMMIT").execute(&mut *conn).await?,
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            return Err(error);
        }
    };
    drop(conn);

    let copied = crate::jsonl_history::copy_transcript_snapshot(
        pool,
        input.source_id,
        child_id,
        input.until_turn_id,
    )
    .await?;
    let source_turns = ConversationTurnRecord::list_for_conversation(pool, input.source_id).await?;
    let mut kept_turns = Vec::new();
    for turn in source_turns {
        let stop = input.until_turn_id.is_some_and(|cut| turn.id == cut);
        kept_turns.push(turn);
        if stop {
            break;
        }
    }
    for source_turn in kept_turns {
        if let Ok(created) = ConversationTurnRecord::create_pending(
            pool,
            Uuid::new_v4(),
            CreateConversationTurn {
                conversation_id: child_id,
                prompt_id: source_turn.prompt_id.as_deref(),
                text_preview: source_turn.text_preview.as_deref(),
                input_blocks_json: &source_turn.input_blocks_json,
            },
        )
        .await
        {
            let _ = ConversationTurnRecord::mark_completed(
                pool,
                created.id,
                source_turn.stop_reason.as_deref(),
                None,
                None,
            )
            .await;
        }
    }
    Ok((child_id, copied))
}

pub async fn create_workflow_conversation(
    pool: &SqlitePool,
    input: CreateWorkflowConversation,
) -> Result<Uuid, ConversationServiceError> {
    if let Some(existing) = ConversationRecord::find_by_id(pool, input.id).await? {
        if existing.workspace_id == input.workspace_id {
            return Ok(input.id);
        }
        return Err(ConversationServiceError::Conflict(format!(
            "Workflow child Conversation {} already belongs to another workspace",
            input.id
        )));
    }
    let relation = ConversationEvent::ConversationRelationCreated {
        relation_id: Uuid::new_v4(),
        parent_conversation_id: input.parent_conversation_id,
        child_conversation_id: input.id,
        relation_kind: agents::ConversationRelationKind::WorkflowStep,
        visibility: if input.visible {
            agents::ConversationRelationVisibility::Visible
        } else {
            agents::ConversationRelationVisibility::Hidden
        },
        metadata: serde_json::json!({
            "workflowRunId": input.workflow_run_id,
            "workflowStepId": &input.workflow_step_id,
        }),
    };
    let normalized_json = serde_json::to_string(&relation)?;
    let relation_key = format!(
        "conversation-relation-workflow:{}:{}:{}",
        input.workflow_run_id, input.workflow_step_id, input.id
    );
    let session = CreateSession {
        executor: None,
        agent_id: Some(input.agent_id),
        task_id: None,
        name: Some(format!("Workflow · {}", input.workflow_step_id)),
        initial_prompt: Some(input.prompt),
        status: Some(SessionStatus::InProgress),
    };
    let mut conn = pool.acquire().await?;
    sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;
    let transaction = async {
        Session::create_on_connection(&mut conn, &session, input.id, input.workspace_id)
            .await
            .map_err(|error| ConversationServiceError::Internal(error.to_string()))?;
        ConversationEventAppender::append_and_apply(
            &mut conn,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id: input.parent_conversation_id,
                turn_id: None,
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                source: "system",
                event_kind: "conversation_relation_created",
                normalized_json: &normalized_json,
                raw_json: None,
                idempotency_key: Some(&relation_key),
            },
        )
        .await?;
        Ok::<_, ConversationServiceError>(())
    }
    .await;
    match transaction {
        Ok(()) => sqlx::query("COMMIT").execute(&mut *conn).await?,
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            return Err(error);
        }
    };
    Ok(input.id)
}

/// Create the durable child Conversation identity and parent link before the
/// conversation control plane binds ACP and starts the first turn.
///
/// Do not commit an in-flight Turn here. `ensure_session_controls` treats a
/// pending Turn with no live process as dead, and Prompt must go through
/// `start_turn` like every other write entry (ADR-0081).
pub async fn create_delegated_conversation(
    pool: &SqlitePool,
    input: CreateDelegatedConversation,
) -> Result<Uuid, ConversationServiceError> {
    let parent = ConversationRecord::find_by_id(pool, input.parent_conversation_id)
        .await?
        .ok_or_else(|| {
            ConversationServiceError::NotFound(format!(
                "Parent Conversation {} not found",
                input.parent_conversation_id
            ))
        })?;
    let relation_id = Uuid::new_v4();
    let relation = ConversationEvent::ConversationRelationCreated {
        relation_id,
        parent_conversation_id: input.parent_conversation_id,
        child_conversation_id: input.id,
        relation_kind: agents::ConversationRelationKind::Delegation,
        visibility: agents::ConversationRelationVisibility::Visible,
        metadata: serde_json::json!({
            "parentToolCallId": &input.parent_tool_call_id,
            "delegationId": &input.delegation_id,
            "policy": &input.policy,
        }),
    };
    let normalized_json = serde_json::to_string(&relation)?;
    let relation_key = format!("conversation-relation-delegation:{}", input.id);
    let session = CreateSession {
        executor: None,
        agent_id: Some(input.agent_id),
        task_id: parent.task_id,
        name: None,
        initial_prompt: Some(input.prompt.clone()),
        status: Some(SessionStatus::InProgress),
    };
    let mut conn = pool.acquire().await?;
    sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;
    let transaction = async {
        Session::create_with_delegation_on_connection(
            &mut conn,
            &session,
            input.id,
            parent.workspace_id,
            input.parent_conversation_id,
            &input.parent_tool_call_id,
            &input.delegation_id,
        )
        .await
        .map_err(|error| ConversationServiceError::Internal(error.to_string()))?;
        ConversationEventAppender::append_and_apply(
            &mut conn,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id: input.parent_conversation_id,
                turn_id: None,
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                source: "system",
                event_kind: "conversation_relation_created",
                normalized_json: &normalized_json,
                raw_json: None,
                idempotency_key: Some(&relation_key),
            },
        )
        .await?;
        Ok::<_, ConversationServiceError>(())
    }
    .await;
    match transaction {
        Ok(()) => {
            if let Err(error) = sqlx::query("COMMIT").execute(&mut *conn).await {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                return Err(error.into());
            }
        }
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            return Err(error);
        }
    }
    Ok(input.id)
}
