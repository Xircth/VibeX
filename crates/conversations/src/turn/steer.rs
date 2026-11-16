use agents::{
    AgentElicitationId, AgentElicitationResponse, AgentPermissionId, AgentPermissionResponse,
    AgentSessionId, RespondAgentElicitationInput, RespondAgentPermissionInput,
    SteerAgentPromptInput,
    conversation::{
        ConversationEvent, ConversationPermissionResponse, ConversationQuestionResponse,
    },
};
use db::models::{
    conversation::ConversationRecord, conversation_steering::ConversationSteeringRecord,
    conversation_turn::ConversationTurnRecord, workspace::Workspace, workspace_repo::WorkspaceRepo,
};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{
    ConversationSessionService, ConversationSteerInput, ConversationSteeringReceipt,
    ConversationSteeringStatus, is_in_flight_turn_status, parse_agent_connection_id,
    parse_agent_prompt_id,
    start::{agent_blocks_with_display_text, conversation_input_blocks_with_display_text},
};
use crate::ConversationServiceError;

enum SteeringSettlement {
    Accepted {
        delivery_mode: agents::ConversationSteeringDeliveryMode,
        restarted_turn_id: Option<Uuid>,
    },
    Rejected {
        code: &'static str,
        message: String,
    },
    Unknown {
        message: String,
    },
}

const INTERRUPT_RESTART_WAIT_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(5_000);
const INTERRUPT_RESTART_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(25);

fn deterministic_steer_input_operation_id(operation_id: Uuid) -> Uuid {
    let digest = Sha256::digest(format!("conversation-steer-input:{operation_id}"));
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}

impl ConversationSessionService {
    /// Inject guidance into an active Turn via native in-flight steering when
    /// negotiated, or coordinate a crash-safe `interrupt_restart` fallback
    /// (front-of-queue promotion/persistence -> cancel active Turn -> bounded
    /// terminal wait -> dispatch) when `allow_interrupt_restart` is enabled.
    pub async fn steer(
        &self,
        input: ConversationSteerInput,
    ) -> Result<ConversationSteeringReceipt, ConversationServiceError> {
        if input.text.trim().is_empty()
            && input.images.is_empty()
            && input.file_refs.is_empty()
            && input.promoted_input_id.is_none()
        {
            return Err(ConversationServiceError::BadRequest(
                "Steering input must include text, an image, or a file reference".to_string(),
            ));
        }
        let payload_digest = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&serde_json::json!({
                "text": &input.text,
                "displayText": &input.display_text,
                "images": &input.images,
                "fileRefs": &input.file_refs,
                "modeOverride": &input.mode_override,
                "configOverrides": &input.config_overrides,
            }))?)
        );
        let pool = &self.ctx.deployment.db().pool;
        let inputs = crate::ConversationInputControl::with_publisher(
            pool.clone(),
            self.ctx.event_publisher.clone(),
        );
        let existing_requested_id = if let Some(mut existing) =
            ConversationSteeringRecord::find_by_operation(
                pool,
                input.conversation_id,
                input.operation_id,
            )
            .await?
        {
            let principal = serde_json::from_str::<serde_json::Value>(&existing.principal_json)?;
            if existing.expected_turn_id != input.expected_turn_id
                || existing.payload_digest != payload_digest
                || principal != input.principal
            {
                return Err(ConversationServiceError::Conflict(format!(
                    "Steering operation {} was retried with different intent",
                    input.operation_id
                )));
            }
            if existing.status != "requested" {
                if existing.status == "accepted"
                    && existing.delivery_mode.as_deref() == Some("interrupt_restart")
                    && existing.restarted_turn_id.is_none()
                {
                    let input_op_id = deterministic_steer_input_operation_id(input.operation_id);
                    let resolved_turn_id = if let Some(promoted_id) = input.promoted_input_id {
                        inputs
                            .find(input.conversation_id, promoted_id)
                            .await
                            .ok()
                            .and_then(|view| view.turn_id)
                    } else {
                        db::models::conversation_input::ConversationInputRecord::find_by_operation(
                            pool,
                            input.conversation_id,
                            input_op_id,
                        )
                        .await?
                        .and_then(|rec| rec.turn_id)
                    };
                    if let Some(restarted_turn_id) = resolved_turn_id {
                        let mut conn = pool.acquire().await?;
                        ConversationSteeringRecord::update_restarted_turn_on_connection(
                            &mut conn,
                            input.conversation_id,
                            existing.id,
                            restarted_turn_id,
                        )
                        .await?;
                        existing.restarted_turn_id = Some(restarted_turn_id);
                    }
                }
                return steering_receipt(existing);
            }
            Some(existing.id)
        } else {
            None
        };

        let conversation = ConversationRecord::find_by_id(pool, input.conversation_id)
            .await?
            .ok_or_else(|| {
                ConversationServiceError::NotFound(format!(
                    "Conversation {} not found",
                    input.conversation_id
                ))
            })?;
        let active_turn_id = conversation.active_turn_id.ok_or_else(|| {
            ConversationServiceError::Conflict("Conversation has no active Turn".to_string())
        })?;
        if active_turn_id != input.expected_turn_id {
            return Err(ConversationServiceError::Conflict(format!(
                "Active Turn changed: expected {}, active is {}",
                input.expected_turn_id, active_turn_id
            )));
        }
        let active_turn = ConversationTurnRecord::find_by_id(pool, active_turn_id)
            .await?
            .ok_or_else(|| {
                ConversationServiceError::NotFound(format!("Turn {active_turn_id} not found"))
            })?;
        if !is_in_flight_turn_status(&active_turn.status) {
            return Err(ConversationServiceError::Conflict(format!(
                "Turn {active_turn_id} is no longer active"
            )));
        }

        let mut promoted_requires_restart = false;
        let mut effective_text = input.text.clone();
        let mut effective_display_text = input.display_text.clone();
        let mut effective_images = input.images.clone();
        let mut effective_file_refs = input.file_refs.clone();
        let mut effective_mode_override = input.mode_override.clone();
        let mut effective_config_overrides = input.config_overrides.clone();
        if let Some(promoted_id) = input.promoted_input_id {
            let promoted_view = inputs.find(input.conversation_id, promoted_id).await?;
            if existing_requested_id.is_none() {
                if !matches!(
                    promoted_view.status,
                    crate::ConversationInputStatus::Queued
                        | crate::ConversationInputStatus::Scheduled
                ) {
                    return Err(ConversationServiceError::Conflict(format!(
                        "Conversation input {promoted_id} is no longer queued"
                    )));
                }
                if let Some(expected_rev) = input.promoted_input_expected_revision
                    && promoted_view.revision != expected_rev
                {
                    return Err(ConversationServiceError::Conflict(format!(
                        "Conversation input {promoted_id} revision changed (expected {expected_rev}, actual {})",
                        promoted_view.revision
                    )));
                }
            }
            if effective_text.trim().is_empty() {
                effective_text = promoted_view.payload.text.clone();
            }
            if effective_display_text.is_none() {
                effective_display_text = promoted_view.payload.display_text.clone();
            }
            if effective_images.is_empty() {
                effective_images = promoted_view.payload.images.clone();
            }
            if effective_file_refs.is_empty() {
                effective_file_refs = promoted_view.payload.file_refs.clone();
            }
            if effective_mode_override.is_none() {
                effective_mode_override = promoted_view.payload.mode_override.clone();
            }
            if effective_config_overrides.is_empty() {
                effective_config_overrides = promoted_view.payload.config_overrides.clone();
            }
            if !promoted_view.payload.workflow_refs.is_empty() {
                promoted_requires_restart = true;
            }
        }
        let effective_input = ConversationSteerInput {
            text: effective_text,
            display_text: effective_display_text,
            images: effective_images,
            file_refs: effective_file_refs,
            mode_override: effective_mode_override,
            config_overrides: effective_config_overrides,
            ..input
        };

        let execution_workspace_id = crate::isolated_workspace::execution_workspace_id(
            &self.ctx,
            conversation.id,
            conversation.workspace_id,
        )
        .await
        .map_err(|error| ConversationServiceError::Internal(error.message))?;
        let workspace = match Workspace::find_by_id(pool, execution_workspace_id).await? {
            Some(workspace) => workspace,
            None if execution_workspace_id != conversation.workspace_id => {
                Workspace::find_by_id(pool, conversation.workspace_id)
                    .await?
                    .ok_or_else(|| {
                        ConversationServiceError::NotFound(format!(
                            "Workspace {} not found",
                            conversation.workspace_id
                        ))
                    })?
            }
            None => {
                return Err(ConversationServiceError::NotFound(format!(
                    "Workspace {execution_workspace_id} not found"
                )));
            }
        };
        let container_ref = self
            .ctx
            .deployment
            .container()
            .ensure_container_exists(&workspace)
            .await?;
        let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
        let working_dir = self
            .ctx
            .host
            .resolve_working_dir(&workspace, &container_ref, &repos)
            .unwrap_or(container_ref);
        let agent_blocks = self
            .ctx
            .host
            .build_prompt_blocks(
                &working_dir,
                effective_input.text.clone(),
                &effective_input.images,
                &effective_input.file_refs,
            )
            .await?;
        let display_label = effective_input
            .display_text
            .as_deref()
            .unwrap_or(&effective_input.text);
        let display_blocks = agent_blocks_with_display_text(&agent_blocks, display_label);
        let visible_blocks =
            conversation_input_blocks_with_display_text(&agent_blocks, display_label, None);
        let steering_id = existing_requested_id.unwrap_or_else(Uuid::new_v4);
        if existing_requested_id.is_none() {
            self.append_event(
                effective_input.conversation_id,
                Some(effective_input.expected_turn_id),
                "user",
                ConversationEvent::ConversationSteering {
                    event: agents::ConversationSteeringEvent::Requested {
                        steering_id,
                        operation_id: effective_input.operation_id,
                        expected_turn_id: effective_input.expected_turn_id,
                        payload_digest,
                        blocks: visible_blocks,
                        principal: effective_input.principal.clone(),
                    },
                },
                Some(format!(
                    "conversation-steering-operation:{}",
                    effective_input.operation_id
                )),
            )
            .await?;
        }

        let runtime_session_id = AgentSessionId(effective_input.conversation_id);
        let runtime = self.runtime_snapshot(effective_input.conversation_id).await;
        let connection_id = runtime
            .connection_id
            .as_deref()
            .and_then(parse_agent_connection_id);
        let prompt_id = runtime
            .active_prompt_id
            .as_deref()
            .and_then(parse_agent_prompt_id);
        let host_owns_turn = runtime.active_turn_id == Some(effective_input.expected_turn_id);
        if !host_owns_turn {
            return self
                .settle_steering(
                    effective_input.conversation_id,
                    steering_id,
                    effective_input.expected_turn_id,
                    SteeringSettlement::Rejected {
                        code: "turn_not_live",
                        message: "The expected Turn is not live on this host".to_string(),
                    },
                )
                .await;
        }

        let controls = self
            .ctx
            .agent_runtime
            .session_controls_snapshot(runtime_session_id)
            .await;
        let native_steering_negotiated = match &controls {
            Ok(controls) => controls
                .capabilities
                .as_ref()
                .is_some_and(|capabilities| capabilities.steering),
            Err(error) => {
                tracing::warn!(
                    conversation_id = %input.conversation_id,
                    %steering_id,
                    expected_turn_id = %input.expected_turn_id,
                    %error,
                    "failed to query session controls before steering"
                );
                false
            }
        };

        if connection_id.is_none()
            || prompt_id.is_none()
            || !native_steering_negotiated
            || promoted_requires_restart
        {
            if effective_input.allow_interrupt_restart {
                return self
                    .execute_interrupt_restart(&conversation, steering_id, &effective_input)
                    .await;
            }
            let (code, message) = if connection_id.is_none() || prompt_id.is_none() {
                (
                    "turn_not_live",
                    "The expected Turn is not live on this host".to_string(),
                )
            } else {
                (
                    "steering_unsupported",
                    "Agent did not negotiate in-flight steering".to_string(),
                )
            };
            return self
                .settle_steering(
                    effective_input.conversation_id,
                    steering_id,
                    effective_input.expected_turn_id,
                    SteeringSettlement::Rejected { code, message },
                )
                .await;
        }

        let result = self
            .ctx
            .agent_runtime
            .steer_prompt_with_display_blocks(
                SteerAgentPromptInput {
                    connection_id: connection_id.expect("checked above"),
                    session_id: runtime_session_id,
                    expected_prompt_id: prompt_id.expect("checked above"),
                    blocks: agent_blocks,
                },
                Some(display_blocks),
            )
            .await;
        let settlement = match result {
            Ok(receipt) => match receipt.outcome {
                agents::AgentSteerOutcome::Injected => {
                    if let Some(promoted_id) = effective_input.promoted_input_id {
                        inputs
                            .consume_for_native_steer(
                                effective_input.conversation_id,
                                promoted_id,
                                deterministic_steer_input_operation_id(
                                    effective_input.operation_id,
                                ),
                                effective_input.promoted_input_expected_revision,
                            )
                            .await?;
                    }
                    SteeringSettlement::Accepted {
                        delivery_mode: agents::ConversationSteeringDeliveryMode::Native,
                        restarted_turn_id: None,
                    }
                }
                agents::AgentSteerOutcome::PromptRequired => SteeringSettlement::Rejected {
                    code: "no_running_turn",
                    message: receipt
                        .reason
                        .unwrap_or_else(|| "Agent found no running Turn".to_string()),
                },
                agents::AgentSteerOutcome::StartedNewTurn => {
                    self.append_event(
                        effective_input.conversation_id,
                        Some(effective_input.expected_turn_id),
                        "runtime",
                        ConversationEvent::DeliveryChannelLatched {
                            from: agents::conversation::DeliveryChannel::Native,
                            to: agents::conversation::DeliveryChannel::None,
                        },
                        None,
                    )
                    .await?;
                    SteeringSettlement::Unknown {
                        message: "Agent started a new Turn despite promptRequired fallback policy"
                            .to_string(),
                    }
                }
            },
            Err(agents::AgentError::SteeringUnsupported) => {
                if effective_input.allow_interrupt_restart {
                    return self
                        .execute_interrupt_restart(&conversation, steering_id, &effective_input)
                        .await;
                }
                SteeringSettlement::Rejected {
                    code: "steering_unsupported",
                    message: "Agent did not negotiate in-flight steering".to_string(),
                }
            }
            Err(agents::AgentError::PromptConflict { .. })
            | Err(agents::AgentError::PromptNotFound(_)) => SteeringSettlement::Rejected {
                code: "turn_conflict",
                message: "The expected Turn is no longer active".to_string(),
            },
            Err(error) => {
                tracing::warn!(
                    conversation_id = %input.conversation_id,
                    %steering_id,
                    expected_turn_id = %input.expected_turn_id,
                    %error,
                    "native in-flight steering failed; settling steering as unknown"
                );
                SteeringSettlement::Unknown {
                    message: error.to_string(),
                }
            }
        };
        self.settle_steering(
            effective_input.conversation_id,
            steering_id,
            effective_input.expected_turn_id,
            settlement,
        )
        .await
    }

    async fn execute_interrupt_restart(
        &self,
        conversation: &ConversationRecord,
        steering_id: Uuid,
        input: &ConversationSteerInput,
    ) -> Result<ConversationSteeringReceipt, ConversationServiceError> {
        let pool = &self.ctx.deployment.db().pool;
        let inputs = crate::ConversationInputControl::with_publisher(
            pool.clone(),
            self.ctx.event_publisher.clone(),
        );
        let input_op_id = deterministic_steer_input_operation_id(input.operation_id);

        // Step 1: Lock front-of-queue position BEFORE cancelling the active turn so
        // any terminal-event queue pump dispatches this steered input first.
        let target_input_view = if let Some(promoted_id) = input.promoted_input_id {
            inputs
                .promote_to_front(
                    input.conversation_id,
                    promoted_id,
                    input_op_id,
                    input.promoted_input_expected_revision,
                )
                .await?
        } else {
            let agent_id = resolve_conversation_agent_id(pool, conversation.id).await?;
            inputs
                .submit_at_front(crate::SubmitConversationInput {
                    conversation_id: input.conversation_id,
                    operation_id: input_op_id,
                    payload: agents::ConversationInputPayload {
                        continuation_policy: None,
                        expected_binding_revision: None,
                        agent_id,
                        workspace_id: conversation.workspace_id,
                        executor_profile_id: None,
                        text: input.text.clone(),
                        display_text: input.display_text.clone(),
                        images: input.images.clone(),
                        mode_override: input.mode_override.clone(),
                        config_overrides: input.config_overrides.clone(),
                        workflow_refs: Vec::new(),
                        file_refs: input.file_refs.clone(),
                        internal_prompt_contributions: Vec::new(),
                        collaboration_origin: None,
                        provider_instance_id: None,
                    },
                    principal: input.principal.clone(),
                })
                .await?
        };
        let target_input_id = target_input_view.id;

        // Step 2: Cancel only `expected_turn_id` without wiping queued inputs if the
        // turn raced to completion right before cancellation.
        self.cancel_specific_turn(
            input.conversation_id,
            input.expected_turn_id,
            Some("interrupt_restart".to_string()),
        )
        .await?;

        // Step 3: Bounded wait (up to 5_000ms without holding turn_lock) for the
        // cancelled turn to exit in-flight, then idempotently pump the queue.
        let deadline = tokio::time::Instant::now() + INTERRUPT_RESTART_WAIT_TIMEOUT;
        let mut previous_turn_settled = false;
        loop {
            let turn_still_in_flight =
                ConversationTurnRecord::find_by_id(pool, input.expected_turn_id)
                    .await?
                    .is_some_and(|turn| is_in_flight_turn_status(&turn.status));
            let active_pointer_still_old =
                ConversationRecord::find_by_id(pool, input.conversation_id)
                    .await?
                    .and_then(|conv| conv.active_turn_id)
                    == Some(input.expected_turn_id);
            if !turn_still_in_flight && !active_pointer_still_old {
                previous_turn_settled = true;
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(INTERRUPT_RESTART_POLL_INTERVAL).await;
        }

        let settlement = if previous_turn_settled {
            if let Err(error) = self.dispatch_next_queued_input(input.conversation_id).await {
                tracing::warn!(
                    conversation_id = %input.conversation_id,
                    %steering_id,
                    %error,
                    "interrupt_restart dispatch failed; steered input remains at queue front"
                );
            }
            let restarted_turn_id = loop {
                let maybe_view = match inputs.find(input.conversation_id, target_input_id).await {
                    Ok(view) => Some(view),
                    Err(crate::ConversationInputControlError::NotFound(_)) => None,
                    Err(error) => return Err(error.into()),
                };
                let restarted_turn_id = maybe_view.as_ref().and_then(|view| view.turn_id);
                let still_launching = match &maybe_view {
                    Some(view) if view.status == crate::ConversationInputStatus::Claimed => true,
                    Some(view) => match view.turn_id {
                        Some(turn_id) => ConversationTurnRecord::find_by_id(pool, turn_id)
                            .await?
                            .is_some_and(|turn| turn.status == "pending"),
                        None => false,
                    },
                    None => false,
                };
                if !still_launching {
                    break restarted_turn_id;
                }
                if tokio::time::Instant::now() >= deadline {
                    tracing::warn!(
                        conversation_id = %input.conversation_id,
                        %steering_id,
                        %target_input_id,
                        ?restarted_turn_id,
                        "interrupt_restart timed out waiting for restarted turn to launch"
                    );
                    break restarted_turn_id;
                }
                tokio::time::sleep(INTERRUPT_RESTART_POLL_INTERVAL).await;
            };
            SteeringSettlement::Accepted {
                delivery_mode: agents::ConversationSteeringDeliveryMode::InterruptRestart,
                restarted_turn_id,
            }
        } else {
            tracing::warn!(
                conversation_id = %input.conversation_id,
                %steering_id,
                expected_turn_id = %input.expected_turn_id,
                "interrupt_restart timed out waiting for previous turn to settle"
            );
            SteeringSettlement::Unknown {
                message: format!(
                    "Timed out waiting for turn {} to settle before restarting",
                    input.expected_turn_id
                ),
            }
        };

        self.settle_steering(
            input.conversation_id,
            steering_id,
            input.expected_turn_id,
            settlement,
        )
        .await
    }

    async fn settle_steering(
        &self,
        conversation_id: Uuid,
        steering_id: Uuid,
        expected_turn_id: Uuid,
        settlement: SteeringSettlement,
    ) -> Result<ConversationSteeringReceipt, ConversationServiceError> {
        let event = match settlement {
            SteeringSettlement::Accepted {
                delivery_mode,
                restarted_turn_id,
            } => agents::ConversationSteeringEvent::Accepted {
                steering_id,
                expected_turn_id,
                delivery_mode: Some(delivery_mode),
                restarted_turn_id,
            },
            SteeringSettlement::Rejected { code, message } => {
                agents::ConversationSteeringEvent::Rejected {
                    steering_id,
                    expected_turn_id,
                    code: code.to_string(),
                    message,
                }
            }
            SteeringSettlement::Unknown { message } => agents::ConversationSteeringEvent::Unknown {
                steering_id,
                expected_turn_id,
                message,
            },
        };
        self.append_event(
            conversation_id,
            Some(expected_turn_id),
            "runtime",
            ConversationEvent::ConversationSteering { event },
            Some(format!("conversation-steering:{steering_id}:settled")),
        )
        .await?;
        let record = ConversationSteeringRecord::find_by_id(
            &self.ctx.deployment.db().pool,
            conversation_id,
            steering_id,
        )
        .await?
        .ok_or_else(|| {
            ConversationServiceError::Internal(format!(
                "Steering receipt {steering_id} projection is missing"
            ))
        })?;
        steering_receipt(record)
    }

    pub async fn respond_permission(
        &self,
        conversation_id: Uuid,
        permission_id: String,
        response: AgentPermissionResponse,
    ) -> Result<(), ConversationServiceError> {
        let (connection_id, turn_id) = self
            .runtime_connection_and_turn(conversation_id)
            .await
            .ok_or_else(|| {
                ConversationServiceError::BadRequest(
                    "Conversation has no active Agent connection for permission response"
                        .to_string(),
                )
            })?;
        let permission_uuid = Uuid::parse_str(&permission_id).map_err(|error| {
            ConversationServiceError::BadRequest(format!(
                "invalid permission id `{permission_id}`: {error}"
            ))
        })?;
        self.ctx
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
                    response: response.clone(),
                    auto: false,
                },
            },
            Some(format!(
                "conversation:{conversation_id}:permission:{permission_id}:responded"
            )),
        )
        .await?;
        self.update_runtime_state(conversation_id, |state| {
            if state.pending_permission_id.as_deref() == Some(permission_id.as_str()) {
                state.pending_permission_id = None;
            }
        })
        .await;
        let decision = match &response {
            AgentPermissionResponse::Selected {
                option_id, persist, ..
            } => {
                if *persist || option_id == "allow_always" {
                    "allow_always"
                } else if option_id == "allow_once" || option_id.starts_with("allow") {
                    "allow_once"
                } else {
                    "deny"
                }
            }
            AgentPermissionResponse::Cancelled => "deny",
        };
        let delivery_ctx =
            crate::ScopedConversationControl::new(self.ctx.clone()).delivery_context();
        if let Err(error) = crate::collaboration_cards::resolve_approval_card_if_pending(
            &self.ctx.deployment.db().pool,
            &permission_id,
            decision,
            &delivery_ctx,
        )
        .await
        {
            tracing::warn!(
                %conversation_id,
                permission_id = %permission_id,
                error = %error.message,
                "failed to settle collab IM card after permission response"
            );
        }
        Ok(())
    }

    /// Answer a pending agent question (ACP elicitation). Mirrors
    /// [`Self::respond_permission`]: forward to the runtime (which unblocks the
    /// agent's `elicitation/create` request) and append the response event so
    /// the timeline row settles even if the runtime's own event races.
    pub async fn respond_question(
        &self,
        conversation_id: Uuid,
        question_id: String,
        response: AgentElicitationResponse,
    ) -> Result<(), ConversationServiceError> {
        let (connection_id, turn_id) = self
            .runtime_connection_and_turn(conversation_id)
            .await
            .ok_or_else(|| {
                ConversationServiceError::BadRequest(
                    "Conversation has no active Agent connection for question response".to_string(),
                )
            })?;
        let question_uuid = Uuid::parse_str(&question_id).map_err(|error| {
            ConversationServiceError::BadRequest(format!(
                "invalid question id `{question_id}`: {error}"
            ))
        })?;
        self.ctx
            .agent_runtime
            .respond_elicitation(RespondAgentElicitationInput {
                connection_id,
                elicitation_id: AgentElicitationId(question_uuid),
                response: response.clone(),
            })
            .await?;
        let answer = response.summary();
        let content = match &response {
            AgentElicitationResponse::Accept { content } => Some(content.clone()),
            _ => None,
        };
        self.append_event(
            conversation_id,
            turn_id,
            "host",
            ConversationEvent::QuestionResponded {
                question_id: question_id.clone(),
                response: ConversationQuestionResponse {
                    answer: answer.clone(),
                    content,
                },
            },
            Some(format!(
                "conversation:{conversation_id}:question:{question_id}:responded"
            )),
        )
        .await?;
        self.update_runtime_state(conversation_id, |state| {
            if state.pending_question_id.as_deref() == Some(question_id.as_str()) {
                state.pending_question_id = None;
            }
        })
        .await;
        let delivery_ctx =
            crate::ScopedConversationControl::new(self.ctx.clone()).delivery_context();
        if let Err(error) = crate::collaboration_cards::resolve_elicitation_question_card(
            &self.ctx.deployment.db().pool,
            &question_id,
            if answer.trim().is_empty() {
                "已跳过"
            } else {
                answer.as_str()
            },
            &delivery_ctx,
        )
        .await
        {
            tracing::warn!(
                %conversation_id,
                question_id = %question_id,
                error = %error.message,
                "failed to settle collab IM card after question response"
            );
        }
        Ok(())
    }

    /// Execute a session goal control action (`pause` or `clear`) on the live ACP
    /// session. When the adapter handles goal control out of band (`Codex` with an
    /// active goal) and the RPC succeeds, this also interrupts any in-flight turn
    /// via `cancel_turn`.
    pub async fn goal_control(
        &self,
        conversation_id: Uuid,
        action: String,
    ) -> Result<agents::GoalControlReceipt, ConversationServiceError> {
        let action = action.trim().to_string();
        if !matches!(action.as_str(), "pause" | "clear" | "resume" | "set") {
            return Err(ConversationServiceError::BadRequest(format!(
                "unsupported goal control action `{action}`"
            )));
        }
        let runtime_session_id = AgentSessionId(conversation_id);
        if !self
            .ctx
            .agent_runtime
            .has_bound_acp_session(runtime_session_id)
            .await
        {
            self.ensure_session_controls(conversation_id).await?;
        }
        let receipt = self
            .ctx
            .agent_runtime
            .goal_control(runtime_session_id, action.clone())
            .await?;
        if receipt.should_interrupt_turn {
            let reason = Some(format!("goal_{action}"));
            if let Err(error) = self.cancel_turn(conversation_id, reason).await {
                tracing::warn!(
                    %conversation_id,
                    %action,
                    %error,
                    "goal control succeeded but turn cancellation failed"
                );
            }
        }
        Ok(receipt)
    }

    /// Request the live ACP adapter to stop a background task via
    /// `_session/async_task/stop`. Does not pre-validate `task_id` against the
    /// local table so tasks whose spawn event raced can still be stopped.
    pub async fn stop_async_task(
        &self,
        conversation_id: Uuid,
        task_id: String,
    ) -> Result<bool, ConversationServiceError> {
        let task_id = task_id.trim().to_string();
        if task_id.is_empty() {
            return Err(ConversationServiceError::BadRequest(
                "Async task id must not be empty".to_string(),
            ));
        }
        let runtime_session_id = AgentSessionId(conversation_id);
        let stopped = self
            .ctx
            .agent_runtime
            .stop_async_task(runtime_session_id, task_id)
            .await?;
        Ok(stopped)
    }
}

async fn resolve_conversation_agent_id(
    pool: &sqlx::SqlitePool,
    conversation_id: Uuid,
) -> Result<agents::AgentId, ConversationServiceError> {
    let raw: Option<String> = sqlx::query_scalar(
        r#"SELECT COALESCE(
               agent_id,
               (SELECT agent_id FROM conversation_agent_bindings
                WHERE conversation_id = sessions.id
                ORDER BY created_at DESC LIMIT 1)
           )
           FROM sessions WHERE id = ?"#,
    )
    .bind(conversation_id)
    .fetch_optional(pool)
    .await?
    .flatten();
    let agent_str = raw.as_deref().unwrap_or("codex");
    agents::AgentId::parse(agent_str)
        .map_err(|error| ConversationServiceError::BadRequest(error.to_string()))
}

pub(super) fn steering_receipt(
    record: ConversationSteeringRecord,
) -> Result<ConversationSteeringReceipt, ConversationServiceError> {
    let status = match record.status.as_str() {
        "requested" => ConversationSteeringStatus::Requested,
        "accepted" => ConversationSteeringStatus::Accepted,
        "rejected" => ConversationSteeringStatus::Rejected,
        "unknown" => ConversationSteeringStatus::Unknown,
        status => {
            return Err(ConversationServiceError::Internal(format!(
                "Invalid steering status `{status}`"
            )));
        }
    };
    let delivery_mode = match record.delivery_mode.as_deref() {
        Some("native") => Some(agents::ConversationSteeringDeliveryMode::Native),
        Some("interrupt_restart") => {
            Some(agents::ConversationSteeringDeliveryMode::InterruptRestart)
        }
        None => None,
        Some(other) => {
            return Err(ConversationServiceError::Internal(format!(
                "Invalid steering delivery_mode `{other}`"
            )));
        }
    };
    Ok(ConversationSteeringReceipt {
        steering_id: record.id,
        conversation_id: record.conversation_id,
        operation_id: record.operation_id,
        expected_turn_id: record.expected_turn_id,
        status,
        code: record.code,
        message: record.message,
        delivery_mode,
        restarted_turn_id: record.restarted_turn_id,
    })
}
