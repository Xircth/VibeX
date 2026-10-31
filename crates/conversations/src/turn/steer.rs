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
    Accepted,
    Rejected { code: &'static str, message: String },
    Unknown { message: String },
}

impl ConversationSessionService {
    /// Inject guidance into exactly one currently active Turn. This never
    /// falls back to queueing or starting a new Turn: the caller receives a
    /// durable accepted/rejected/unknown receipt for the negotiated wire call.
    pub async fn steer(
        &self,
        input: ConversationSteerInput,
    ) -> Result<ConversationSteeringReceipt, ConversationServiceError> {
        if input.text.trim().is_empty() && input.images.is_empty() {
            return Err(ConversationServiceError::BadRequest(
                "Steering input must include text or an image".to_string(),
            ));
        }
        let payload_digest = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&serde_json::json!({
                "text": &input.text,
                "images": &input.images,
            }))?)
        );
        let pool = &self.ctx.deployment.db().pool;
        let existing_requested_id = if let Some(existing) =
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
            .build_prompt_blocks(&working_dir, input.text.clone(), &input.images, &[])
            .await?;
        let display_blocks = agent_blocks_with_display_text(&agent_blocks, &input.text);
        let visible_blocks =
            conversation_input_blocks_with_display_text(&agent_blocks, &input.text, None);
        let steering_id = existing_requested_id.unwrap_or_else(Uuid::new_v4);
        if existing_requested_id.is_none() {
            self.append_event(
                input.conversation_id,
                Some(input.expected_turn_id),
                "user",
                ConversationEvent::ConversationSteering {
                    event: agents::ConversationSteeringEvent::Requested {
                        steering_id,
                        operation_id: input.operation_id,
                        expected_turn_id: input.expected_turn_id,
                        payload_digest,
                        blocks: visible_blocks,
                        principal: input.principal,
                    },
                },
                Some(format!(
                    "conversation-steering-operation:{}",
                    input.operation_id
                )),
            )
            .await?;
        }

        let runtime_session_id = AgentSessionId(input.conversation_id);
        let runtime = self.runtime_snapshot(input.conversation_id).await;
        let connection_id = runtime
            .connection_id
            .as_deref()
            .and_then(parse_agent_connection_id);
        let prompt_id = runtime
            .active_prompt_id
            .as_deref()
            .and_then(parse_agent_prompt_id);
        if runtime.active_turn_id != Some(input.expected_turn_id)
            || connection_id.is_none()
            || prompt_id.is_none()
        {
            return self
                .settle_steering(
                    input.conversation_id,
                    steering_id,
                    input.expected_turn_id,
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
        if !controls
            .as_ref()
            .ok()
            .and_then(|controls| controls.capabilities.as_ref())
            .is_some_and(|capabilities| capabilities.steering)
        {
            return self
                .settle_steering(
                    input.conversation_id,
                    steering_id,
                    input.expected_turn_id,
                    SteeringSettlement::Rejected {
                        code: "steering_unsupported",
                        message: "Agent did not negotiate in-flight steering".to_string(),
                    },
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
                agents::AgentSteerOutcome::Injected => SteeringSettlement::Accepted,
                agents::AgentSteerOutcome::PromptRequired => SteeringSettlement::Rejected {
                    code: "no_running_turn",
                    message: receipt
                        .reason
                        .unwrap_or_else(|| "Agent found no running Turn".to_string()),
                },
                agents::AgentSteerOutcome::StartedNewTurn => {
                    let _ = self
                        .append_event(
                            input.conversation_id,
                            Some(input.expected_turn_id),
                            "runtime",
                            ConversationEvent::DeliveryChannelLatched {
                                from: agents::conversation::DeliveryChannel::Native,
                                to: agents::conversation::DeliveryChannel::None,
                            },
                            None,
                        )
                        .await;
                    SteeringSettlement::Unknown {
                        message: "Agent started a new Turn despite promptRequired fallback policy"
                            .to_string(),
                    }
                }
            },
            Err(agents::AgentError::SteeringUnsupported) => SteeringSettlement::Rejected {
                code: "steering_unsupported",
                message: "Agent did not negotiate in-flight steering".to_string(),
            },
            Err(agents::AgentError::PromptConflict { .. })
            | Err(agents::AgentError::PromptNotFound(_)) => SteeringSettlement::Rejected {
                code: "turn_conflict",
                message: "The expected Turn is no longer active".to_string(),
            },
            Err(error) => SteeringSettlement::Unknown {
                message: error.to_string(),
            },
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
            SteeringSettlement::Accepted => agents::ConversationSteeringEvent::Accepted {
                steering_id,
                expected_turn_id,
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
        let decision = match &response {
            AgentPermissionResponse::Selected { option_id, persist } => {
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
        let _ = crate::collaboration_cards::resolve_approval_card_if_pending(
            &self.ctx.deployment.db().pool,
            &permission_id,
            decision,
            &delivery_ctx,
        )
        .await;
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
    Ok(ConversationSteeringReceipt {
        steering_id: record.id,
        conversation_id: record.conversation_id,
        operation_id: record.operation_id,
        expected_turn_id: record.expected_turn_id,
        status,
        code: record.code,
        message: record.message,
    })
}
