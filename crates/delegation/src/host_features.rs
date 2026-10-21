//! Production companion tools shared by desktop and `vibex-server`.

use std::sync::{Arc, Mutex};

use agents::{
    AgentElicitationId, AgentElicitationRequest, AgentEvent, AgentSessionId,
    ids::AgentConnectionId, runtime::AgentRuntime,
};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use conversations::{
    ScopedConversationControl, ScopedConversationControlError, collaboration, resolve_referenced_session,
    session_info_value,
};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{CompanionFeaturePort, DelegationScope, InMemoryCompanionFeatures, PendingQuestion};

#[derive(Debug, Clone, Copy)]
pub struct CollaborationLimits {
    pub since_days: i64,
    pub delay_cap_hours: i64,
    pub depth_limit: u32,
    pub max_active_children: u32,
}

impl Default for CollaborationLimits {
    fn default() -> Self {
        Self {
            since_days: 7,
            delay_cap_hours: 24,
            depth_limit: 1,
            max_active_children: 4,
        }
    }
}

pub struct HostCompanionFeatures {
    pub memory: Arc<InMemoryCompanionFeatures>,
    pub pool: SqlitePool,
    pub runtime: Arc<AgentRuntime>,
    pub conversations: ScopedConversationControl,
    limits: Mutex<Arc<dyn Fn() -> CollaborationLimits + Send + Sync>>,
    space_changed: Mutex<
        Option<Arc<dyn Fn(collaboration::CollaborationSpaceChangedEvent) + Send + Sync>>,
    >,
}

impl std::fmt::Debug for HostCompanionFeatures {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HostCompanionFeatures")
            .finish_non_exhaustive()
    }
}

impl HostCompanionFeatures {
    pub fn new(
        memory: Arc<InMemoryCompanionFeatures>,
        pool: SqlitePool,
        runtime: Arc<AgentRuntime>,
        conversations: ScopedConversationControl,
    ) -> Self {
        Self {
            memory,
            pool,
            runtime,
            conversations,
            limits: Mutex::new(Arc::new(CollaborationLimits::default)),
            space_changed: Mutex::new(None),
        }
    }

    pub fn set_collaboration_limits(
        &self,
        limits: impl Fn() -> CollaborationLimits + Send + Sync + 'static,
    ) {
        *self.limits.lock().expect("collaboration limits") = Arc::new(limits);
    }

    pub fn set_space_changed_listener(
        &self,
        listener: impl Fn(collaboration::CollaborationSpaceChangedEvent) + Send + Sync + 'static,
    ) {
        *self
            .space_changed
            .lock()
            .expect("collaboration space listener") = Some(Arc::new(listener));
    }

    fn space_changed_listener(
        &self,
    ) -> Option<Arc<dyn Fn(collaboration::CollaborationSpaceChangedEvent) + Send + Sync>> {
        self.space_changed
            .lock()
            .expect("collaboration space listener")
            .clone()
    }

    fn limits(&self) -> CollaborationLimits {
        (self.limits.lock().expect("collaboration limits"))()
    }

    pub async fn answer_question(
        &self,
        question_id: &str,
        parent_conversation_id: Uuid,
        answers: Value,
    ) -> Result<PendingQuestion, &'static str> {
        self.memory
            .answer_question(question_id, parent_conversation_id, answers)
            .await
    }
}

#[async_trait]
impl CompanionFeaturePort for HostCompanionFeatures {
    async fn feedback(&self, scope: &DelegationScope) -> Value {
        let rows = sqlx::query_as::<_, (Uuid, String, DateTime<Utc>)>(
            r#"SELECT id, text, created_at FROM conversation_feedback_note
               WHERE conversation_id = ? AND status = 'pending'
               ORDER BY created_at ASC"#,
        )
        .bind(scope.parent_conversation_id)
        .fetch_all(&self.pool)
        .await
        .unwrap_or_default();
        json!({
            "count": rows.len(),
            "feedback": rows
                .iter()
                .map(|(id, text, created_at)| {
                    json!({
                        "id": id.to_string(),
                        "text": text,
                        "created_at": created_at.to_rfc3339(),
                    })
                })
                .collect::<Vec<_>>(),
        })
    }

    async fn commit_feedback(&self, scope: &DelegationScope, ids: &[String]) {
        let parsed: Vec<Uuid> = ids
            .iter()
            .filter_map(|id| Uuid::parse_str(id).ok())
            .collect();
        for id in parsed {
            let _ = sqlx::query(
                r#"UPDATE conversation_feedback_note
                   SET status = 'delivered',
                       delivered_at = datetime('now', 'subsec'),
                       updated_at = datetime('now', 'subsec')
                   WHERE id = ? AND conversation_id = ? AND status = 'pending'"#,
            )
            .bind(id)
            .bind(scope.parent_conversation_id)
            .execute(&self.pool)
            .await;
        }
    }

    async fn ask(&self, scope: &DelegationScope, questions: Value) -> Value {
        let questions = match delegation_proto::parse_questions(&questions) {
            Ok(parsed) => parsed,
            Err(error) => {
                return json!({
                    "declined": false,
                    "isError": true,
                    "message": error,
                    "answers": [],
                });
            }
        };
        let Ok(wait) = self
            .memory
            .begin_question(scope.clone(), questions.clone())
            .await
        else {
            return json!({
                "declined": true,
                "answers": [],
                "error": "question already pending for parent conversation",
            });
        };
        let pending = wait.question().clone();
        if let (Ok(connection_id), Ok(question_id)) = (
            Uuid::parse_str(&scope.parent_connection_id),
            Uuid::parse_str(&pending.id),
        ) {
            let message = questions
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|question| question["question"].as_str())
                .collect::<Vec<_>>()
                .join("\n");
            self.runtime
                .emit_external(
                    AgentConnectionId::from(connection_id),
                    Some(AgentSessionId::from(scope.parent_conversation_id)),
                    AgentEvent::ElicitationRequested {
                        request: AgentElicitationRequest {
                            id: AgentElicitationId(question_id),
                            session_id: AgentSessionId::from(scope.parent_conversation_id),
                            message,
                            requested_schema: json!({
                                "type": "object",
                                "x-vibex-questions": questions,
                            }),
                        },
                    },
                )
                .await;
        }
        match wait.wait().await {
            Ok(answer) if answer["__declined"] == true => json!({
                "question_id": pending.id,
                "declined": true,
                "answers": [],
            }),
            Ok(answers) => json!({
                "question_id": pending.id,
                "declined": false,
                "answers": answers,
            }),
            Err(_) => json!({
                "question_id": pending.id,
                "declined": true,
                "answers": [],
            }),
        }
    }

    async fn session_info(
        &self,
        _scope: &DelegationScope,
        conversation_id: &str,
        max_messages: u32,
    ) -> Value {
        let info = resolve_referenced_session(&self.pool, conversation_id, max_messages).await;
        session_info_value(&info)
    }

    async fn session_send(
        &self,
        scope: &DelegationScope,
        conversation_id: &str,
        operation_id: &str,
        text: &str,
    ) -> Value {
        match self
            .conversations
            .submit_text(
                scope.parent_conversation_id,
                conversation_id,
                operation_id,
                text,
            )
            .await
        {
            Ok(submission) => json!({
                "accepted": true,
                "conversation_id": conversation_id,
                "input": submission.input,
                "turn": submission.turn,
            }),
            Err(error) => control_error(conversation_id, error, true),
        }
    }

    async fn session_send_ex(
        &self,
        scope: &DelegationScope,
        conversation_id: &str,
        operation_id: &str,
        text: &str,
        steer: bool,
        expected_turn_id: Option<&str>,
        delay_seconds: Option<i64>,
        deliver_at: Option<&str>,
        workspace_write: bool,
    ) -> Value {
        let Ok(target_id) = Uuid::parse_str(conversation_id) else {
            return json!({
                "accepted": false,
                "conversation_id": conversation_id,
                "error_code": "invalid_conversation_id",
            });
        };
        let Ok(operation) = Uuid::parse_str(operation_id) else {
            return json!({
                "accepted": false,
                "conversation_id": conversation_id,
                "error_code": "invalid_operation_id",
            });
        };
        let delay_cap_hours = self.limits().delay_cap_hours;
        let request = collaboration::SendSessionInput {
            caller_id: scope.parent_conversation_id,
            conversation_id: target_id,
            operation_id: operation,
            text: text.to_string(),
            policy: if workspace_write {
                collaboration::CompanionWritePolicy::SameWorkspace
            } else {
                collaboration::CompanionWritePolicy::AncestorTree
            },
            steer,
            steer_supported: true,
            expected_turn_id: expected_turn_id.and_then(|value| Uuid::parse_str(value).ok()),
            delay_seconds,
            deliver_at: deliver_at.map(str::to_string),
            delay_cap_hours,
        };
        if steer {
            if let Err(error) = collaboration::prepare_steer(&self.pool, &request).await {
                return error.to_json();
            }
            let Some(expected) = request.expected_turn_id else {
                return collaboration::CollaborationError::new(
                    "steer_no_active_turn",
                    "expected_turn_id is required",
                )
                .to_json();
            };
            return match self
                .conversations
                .steer_authorized(
                    target_id,
                    operation,
                    expected,
                    text,
                    json!({
                        "kind": "companion",
                        "parentConversationId": scope.parent_conversation_id,
                    }),
                )
                .await
            {
                Ok(receipt) => steer_receipt(conversation_id, receipt),
                Err(error) => steer_error(conversation_id, &error),
            };
        }
        match collaboration::send_session_input_with(
            &self.pool,
            request,
            &self.conversations.delivery_context(),
        )
        .await
        {
            Ok(receipt) => serde_json::to_value(receipt).unwrap_or_else(|_| json!({})),
            Err(error) => error.to_json(),
        }
    }

    async fn collaborate(
        &self,
        scope: &DelegationScope,
        name: &str,
        arguments: Value,
    ) -> Value {
        let limits = self.limits();
        match collaboration_tool(
            &self.pool,
            scope.parent_conversation_id,
            limits,
            &self.conversations.delivery_context(),
            self.space_changed_listener(),
            name,
            arguments,
        )
        .await
        {
            Ok(value) => value,
            Err(error) => error.to_json(),
        }
    }

    async fn session_cancel(
        &self,
        scope: &DelegationScope,
        conversation_id: &str,
        reason: Option<&str>,
    ) -> Value {
        match self
            .conversations
            .cancel_turn(
                scope.parent_conversation_id,
                conversation_id,
                reason.map(str::to_string),
            )
            .await
        {
            Ok(()) => json!({ "accepted": true, "conversation_id": conversation_id }),
            Err(error) => control_error(conversation_id, error, true),
        }
    }

    async fn session_wait(
        &self,
        scope: &DelegationScope,
        conversation_id: &str,
        after_sequence: Option<i64>,
        wait_ms: Option<u64>,
    ) -> Value {
        match self
            .conversations
            .wait(
                scope.parent_conversation_id,
                conversation_id,
                after_sequence,
                wait_ms,
            )
            .await
        {
            Ok(snapshot) => serde_json::to_value(snapshot)
                .unwrap_or_else(|error| json!({ "found": false, "message": error.to_string() })),
            Err(error) => control_error(conversation_id, error, false),
        }
    }
}

fn steer_receipt(
    conversation_id: &str,
    receipt: conversations::ConversationSteeringReceipt,
) -> Value {
    match receipt.status {
        conversations::ConversationSteeringStatus::Accepted => json!({
            "accepted": true,
            "delivered": "dispatched",
            "conversation_id": conversation_id,
            "turn_id": receipt.expected_turn_id,
            "steering_id": receipt.steering_id,
        }),
        conversations::ConversationSteeringStatus::Rejected => {
            let code = match receipt.code.as_deref() {
                Some("steering_unsupported") => "steer_unsupported",
                Some("turn_not_live" | "no_running_turn") => "steer_no_active_turn",
                Some("turn_conflict") => "steer_conflict",
                _ => "conversation_control_failed",
            };
            json!({
                "accepted": false,
                "conversation_id": conversation_id,
                "error_code": code,
                "message": receipt.message.unwrap_or_default(),
            })
        }
        conversations::ConversationSteeringStatus::Requested
        | conversations::ConversationSteeringStatus::Unknown => json!({
            "accepted": false,
            "conversation_id": conversation_id,
            "error_code": "conversation_control_failed",
            "message": receipt.message.unwrap_or_else(|| "steering was not confirmed".to_string()),
        }),
    }
}

fn steer_error(conversation_id: &str, error: &conversations::ConversationServiceError) -> Value {
    let message = error.to_string();
    let code = if message.contains("no active Turn") {
        "steer_no_active_turn"
    } else if message.contains("Active Turn changed") || message.contains("no longer active") {
        "steer_conflict"
    } else if message.contains("steering support") {
        "steer_unsupported"
    } else {
        "conversation_control_failed"
    };
    json!({
        "accepted": false,
        "conversation_id": conversation_id,
        "error_code": code,
        "message": message,
    })
}

async fn collaboration_tool(
    pool: &SqlitePool,
    caller_id: Uuid,
    limits: CollaborationLimits,
    delivery: &collaboration::DeliveryContext,
    on_space_changed: Option<
        Arc<dyn Fn(collaboration::CollaborationSpaceChangedEvent) + Send + Sync>,
    >,
    name: &str,
    arguments: Value,
) -> Result<Value, collaboration::CollaborationError> {
    let text = |key: &str| {
        arguments
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let uuid_arg = |key: &str| {
        arguments
            .get(key)
            .and_then(Value::as_str)
            .and_then(|value| Uuid::parse_str(value.trim().trim_start_matches("vibex://conversation/")).ok())
    };
    match name {
        "list_conversations" => {
            let since_days = arguments
                .get("since_days")
                .and_then(Value::as_i64)
                .unwrap_or(limits.since_days);
            let items = collaboration::list_conversations(
                pool,
                collaboration::ListConversations {
                    caller_id,
                    since_days,
                    project_id: uuid_arg("project_id"),
                    workspace_id: uuid_arg("workspace_id"),
                    limit: arguments.get("limit").and_then(Value::as_i64),
                },
            )
            .await?;
            Ok(json!({ "conversations": items }))
        }
        "list_roles" => Ok(json!({ "roles": collaboration::list_roles(pool).await? })),
        "list_teams" => Ok(json!({ "teams": collaboration::list_teams(pool).await? })),
        "create_role" => Ok(serde_json::to_value(
            collaboration::create_role(pool, role_input(&arguments)).await?,
        )
        .unwrap_or(json!({}))),
        "update_role" => Ok(serde_json::to_value(
            collaboration::update_role(pool, &text("role_id"), role_input(&arguments)).await?,
        )
        .unwrap_or(json!({}))),
        "delete_role" => {
            collaboration::delete_role(pool, &text("role_id")).await?;
            Ok(json!({ "deleted": true }))
        }
        "create_team" => Ok(serde_json::to_value(
            collaboration::create_team(
                pool,
                collaboration::SaveTeam {
                    id: None,
                    name: text("name"),
                    summary: arguments
                        .get("summary")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                },
            )
            .await?,
        )
        .unwrap_or(json!({}))),
        "update_team" => Ok(serde_json::to_value(
            collaboration::update_team(
                pool,
                &text("team_id"),
                collaboration::SaveTeam {
                    id: None,
                    name: text("name"),
                    summary: arguments
                        .get("summary")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                },
            )
            .await?,
        )
        .unwrap_or(json!({}))),
        "delete_team" => {
            collaboration::delete_team(pool, &text("team_id")).await?;
            Ok(json!({ "deleted": true }))
        }
        "create_conversation" => {
            let operation_id = uuid_arg("operation_id").ok_or_else(|| {
                collaboration::CollaborationError::new("not_found", "operation_id is required")
            })?;
            let created = collaboration::create_spawned_conversation(
                pool,
                collaboration::CreateSpawnedConversation {
                    caller_id,
                    operation_id,
                    role_id: arguments
                        .get("role_id")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    agent_id: arguments
                        .get("agent_id")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    title: arguments
                        .get("title")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    prompt: arguments
                        .get("prompt")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    mode_id: arguments
                        .get("mode_id")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    config_values: arguments.get("config_values").cloned(),
                    depth_limit: limits.depth_limit,
                    max_active_children: limits.max_active_children,
                },
            )
            .await?;
            Ok(serde_json::to_value(created).unwrap_or(json!({})))
        }
        "create_collaboration_space" => {
            let operation_id = uuid_arg("operation_id").ok_or_else(|| {
                collaboration::CollaborationError::new("not_found", "operation_id is required")
            })?;
            let space = collaboration::create_collaboration_space(
                pool,
                caller_id,
                &text("name"),
                operation_id,
            )
            .await?;
            Ok(serde_json::to_value(space).unwrap_or(json!({})))
        }
        "add_space_member" => {
            let operation_id = uuid_arg("operation_id").ok_or_else(|| {
                collaboration::CollaborationError::new("not_found", "operation_id is required")
            })?;
            let conversation_id = uuid_arg("conversation_id").ok_or_else(|| {
                collaboration::CollaborationError::new("not_found", "conversation was not found")
            })?;
            let space_id = text("space_id");
            let member = collaboration::add_space_member(
                pool,
                caller_id,
                &space_id,
                conversation_id,
                &text("nickname"),
                operation_id,
            )
            .await?;
            if let Some(listener) = on_space_changed.as_ref()
                && let Ok(workspace_id) = collaboration::space_workspace_id(pool, &space_id).await
            {
                listener(collaboration::CollaborationSpaceChangedEvent {
                    workspace_id,
                    space_id,
                    seq: None,
                    member_id: Some(member.member_id.clone()),
                });
            }
            Ok(serde_json::to_value(member).unwrap_or(json!({})))
        }
        "set_space_identity" => {
            let operation_id = uuid_arg("operation_id").ok_or_else(|| {
                collaboration::CollaborationError::new("not_found", "operation_id is required")
            })?;
            let space_id = text("space_id");
            let member = collaboration::set_space_identity(
                pool,
                caller_id,
                &space_id,
                &text("nickname"),
                operation_id,
            )
            .await?;
            if let Some(listener) = on_space_changed.as_ref()
                && let Ok(workspace_id) = collaboration::space_workspace_id(pool, &space_id).await
            {
                listener(collaboration::CollaborationSpaceChangedEvent {
                    workspace_id,
                    space_id,
                    seq: None,
                    member_id: Some(member.member_id.clone()),
                });
            }
            Ok(serde_json::to_value(member).unwrap_or(json!({})))
        }
        "post_to_space" => {
            let operation_id = uuid_arg("operation_id").ok_or_else(|| {
                collaboration::CollaborationError::new("not_found", "operation_id is required")
            })?;
            let to = arguments
                .get("to")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let space_id = text("space_id");
            let posted = collaboration::post_to_space_with(
                pool,
                collaboration::PostToSpace {
                    caller_id: Some(caller_id),
                    space_id: space_id.clone(),
                    content: text("content"),
                    summary: arguments
                        .get("summary")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    to,
                    in_reply_to: arguments
                        .get("in_reply_to")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    operation_id,
                },
                delivery,
            )
            .await?;
            if let Some(listener) = on_space_changed.as_ref()
                && let Ok(workspace_id) = collaboration::space_workspace_id(pool, &space_id).await
            {
                listener(collaboration::CollaborationSpaceChangedEvent {
                    workspace_id,
                    space_id,
                    seq: Some(posted.seq),
                    member_id: None,
                });
            }
            Ok(serde_json::to_value(posted).unwrap_or(json!({})))
        }
        "list_space_messages" => {
            let messages = collaboration::list_space_messages(
                pool,
                &text("space_id"),
                arguments.get("since_seq").and_then(Value::as_i64),
                arguments.get("limit").and_then(Value::as_i64),
                collaboration::MessageAudience::Agent,
            )
            .await?;
            Ok(json!({ "messages": messages }))
        }
        "list_space_members" => {
            let members = collaboration::list_space_members(
                pool,
                &text("space_id"),
                collaboration::MessageAudience::Agent,
            )
            .await?;
            Ok(json!({ "members": members }))
        }
        _ => Err(collaboration::CollaborationError::new(
            "not_found",
            "unknown collaboration tool",
        )),
    }
}

fn role_input(arguments: &Value) -> collaboration::SaveRole {
    let text = |key: &str| {
        arguments
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    collaboration::SaveRole {
        id: None,
        name: text("name"),
        team_id: arguments
            .get("team_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        summary: text("summary"),
        persona_prompt: text("persona_prompt"),
        agent_id: text("agent_id"),
        mode_id: arguments
            .get("mode_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        config_values: arguments
            .get("config_values")
            .cloned()
            .unwrap_or_else(|| json!({})),
    }
}

fn control_error(
    conversation_id: &str,
    error: ScopedConversationControlError,
    send: bool,
) -> Value {
    let code = match &error {
        ScopedConversationControlError::InvalidConversationId => "invalid_conversation_id",
        ScopedConversationControlError::InvalidOperationId => "invalid_operation_id",
        ScopedConversationControlError::OutOfScope => "conversation_out_of_scope",
        ScopedConversationControlError::MissingAgent => "conversation_missing_agent",
        ScopedConversationControlError::Internal(_) => "conversation_control_failed",
    };
    if send {
        json!({
            "accepted": false,
            "conversation_id": conversation_id,
            "error_code": code,
            "message": error.to_string(),
        })
    } else {
        json!({
            "found": false,
            "conversation_id": conversation_id,
            "error_code": code,
            "message": error.to_string(),
        })
    }
}
