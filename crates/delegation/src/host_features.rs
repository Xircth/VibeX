//! Production companion tools shared by desktop and `vibex-server`.

use std::sync::{Arc, Mutex};

use agents::{
    AgentElicitationId, AgentElicitationRequest, AgentEvent, AgentSessionId,
    ids::AgentConnectionId, runtime::AgentRuntime,
};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use conversations::{
    ScopedConversationControl, ScopedConversationControlError, collaboration,
    resolve_referenced_session, session_info_value,
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

type SpaceChangedCallback =
    Arc<dyn Fn(collaboration::CollaborationSpaceChangedEvent) + Send + Sync>;

pub struct HostCompanionFeatures {
    pub memory: Arc<InMemoryCompanionFeatures>,
    pub pool: SqlitePool,
    pub runtime: Arc<AgentRuntime>,
    pub conversations: ScopedConversationControl,
    limits: Mutex<Arc<dyn Fn() -> CollaborationLimits + Send + Sync>>,
    space_changed: Mutex<Option<SpaceChangedCallback>>,
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
        let wait_fut = wait.wait();
        let mut delivery = self.conversations.delivery_context();
        delivery.space_changed = self.space_changed_listener();
        let posted_to_space = match conversations::collaboration_cards::post_blocking_user_question(
            &self.pool,
            scope.parent_conversation_id,
            &questions,
            &pending.id,
            &delivery,
        )
        .await
        {
            Ok(card) => {
                if let Some(listener) = self.space_changed_listener()
                    && let Ok(workspace_id) =
                        collaboration::space_workspace_id(&self.pool, &card.space_id).await
                {
                    let event = collaboration::latest_space_changed_event(
                        &self.pool,
                        workspace_id,
                        &card.space_id,
                        card.member_id,
                    )
                    .await;
                    listener(event);
                }
                true
            }
            Err(error) if error.code == "not_found" => false,
            Err(error) => {
                return json!({
                    "declined": false,
                    "isError": true,
                    "message": error.message,
                    "answers": [],
                });
            }
        };
        if !posted_to_space
            && let (Ok(connection_id), Ok(question_id)) = (
                Uuid::parse_str(&scope.parent_connection_id),
                Uuid::parse_str(&pending.id),
            )
        {
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
        match wait_fut.await {
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

    async fn resolve_member_session(
        &self,
        scope: &DelegationScope,
        member_id: &str,
        thread_id: &str,
    ) -> Result<String, Value> {
        collaboration::resolve_member_target(
            &self.pool,
            scope.parent_conversation_id,
            member_id,
            thread_id,
        )
        .await
        .map(|conversation_id| conversation_id.to_string())
        .map_err(|error| {
            let mut payload = error.to_json();
            if let Some(object) = payload.as_object_mut() {
                object.insert("accepted".to_string(), json!(false));
            }
            payload
        })
    }

    #[allow(clippy::too_many_arguments)]
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
        let mut delivery = self.conversations.delivery_context();
        delivery.space_changed = self.space_changed_listener();
        match collaboration::send_session_input_with(&self.pool, request, &delivery).await {
            Ok(receipt) => serde_json::to_value(receipt).unwrap_or_else(|_| json!({})),
            Err(error) => error.to_json(),
        }
    }

    async fn collaborate(&self, scope: &DelegationScope, name: &str, arguments: Value) -> Value {
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
            .and_then(|value| {
                Uuid::parse_str(value.trim().trim_start_matches("vibex://conversation/")).ok()
            })
    };
    let operation_id = uuid_arg("operation_id").unwrap_or_else(Uuid::new_v4);
    match name {
        "list_spaces" => {
            let space_id = arguments
                .get("space_id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            collaboration::list_spaces_for_caller(pool, caller_id, space_id).await
        }
        "manage_bot" => {
            manage_bot_tool(
                pool,
                caller_id,
                &arguments,
                operation_id,
                delivery,
                &on_space_changed,
            )
            .await
        }
        "manage_group" => {
            manage_group_tool(
                pool,
                caller_id,
                &arguments,
                operation_id,
                delivery,
                &on_space_changed,
            )
            .await
        }
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
            let space = collaboration::create_collaboration_space(
                pool,
                caller_id,
                &text("name"),
                operation_id,
            )
            .await?;
            if let Some(listener) = on_space_changed.as_ref() {
                let evt = collaboration::latest_space_changed_event(
                    pool,
                    space.workspace_id,
                    &space.space_id,
                    None,
                )
                .await;
                listener(evt);
            }
            Ok(serde_json::to_value(space).unwrap_or(json!({})))
        }
        "list_collaboration_spaces" => {
            collaboration::list_collaboration_spaces_for_caller(pool, caller_id).await
        }
        "add_space_member" => {
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
                let evt = collaboration::latest_space_changed_event(
                    pool,
                    workspace_id,
                    &space_id,
                    Some(member.member_id.clone()),
                )
                .await;
                listener(evt);
            }
            collaboration::space_member_tool_value(pool, &member).await
        }
        "create_space_member" => {
            collaboration::create_space_member(
                pool,
                caller_id,
                collaboration::CreateSpaceMemberRequest {
                    nickname: text("nickname"),
                    role_id: arguments
                        .get("role_id")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    agent_id: arguments
                        .get("agent_id")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    team_id: arguments
                        .get("team_id")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    mode_id: arguments
                        .get("mode_id")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    config_values: arguments.get("config_values").cloned(),
                    persona_prompt: arguments
                        .get("persona_prompt")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    operation_id,
                },
            )
            .await
        }
        "set_space_lead" => {
            let space_id = text("space_id");
            let member_ref = arguments
                .get("member_id")
                .or_else(|| arguments.get("identity_member_id"))
                .or_else(|| arguments.get("conversation_id"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let result = collaboration::transfer_space_lead(
                pool,
                caller_id,
                &space_id,
                &member_ref,
                operation_id,
            )
            .await?;
            if let Some(listener) = on_space_changed.as_ref()
                && let Ok(workspace_id) = collaboration::space_workspace_id(pool, &space_id).await
            {
                let lead = result
                    .get("lead_member_id")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let evt =
                    collaboration::latest_space_changed_event(pool, workspace_id, &space_id, lead)
                        .await;
                listener(evt);
            }
            Ok(result)
        }
        "leave_space" => {
            let space_id = text("space_id");
            let result =
                collaboration::leave_space(pool, caller_id, &space_id, operation_id).await?;
            if let Some(listener) = on_space_changed.as_ref()
                && let Ok(workspace_id) = collaboration::space_workspace_id(pool, &space_id).await
            {
                let evt =
                    collaboration::latest_space_changed_event(pool, workspace_id, &space_id, None)
                        .await;
                listener(evt);
            }
            Ok(result)
        }
        "remove_space_member" | "delete_space_member" => {
            let space_id = text("space_id");
            let member_ref = arguments
                .get("member_id")
                .or_else(|| arguments.get("identity_member_id"))
                .or_else(|| arguments.get("conversation_id"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let result = if name == "remove_space_member" {
                collaboration::remove_space_member(
                    pool,
                    caller_id,
                    &space_id,
                    &member_ref,
                    operation_id,
                )
                .await?
            } else {
                collaboration::delete_space_member(
                    pool,
                    caller_id,
                    &space_id,
                    &member_ref,
                    operation_id,
                )
                .await?
            };
            if let Some(listener) = on_space_changed.as_ref()
                && let Ok(workspace_id) = collaboration::space_workspace_id(pool, &space_id).await
            {
                let member = result
                    .get("member_id")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let evt = collaboration::latest_space_changed_event(
                    pool,
                    workspace_id,
                    &space_id,
                    member,
                )
                .await;
                listener(evt);
            }
            Ok(result)
        }
        "interrupt_space_turn" => {
            let space_id = text("space_id");
            let member_ref = arguments
                .get("member_id")
                .or_else(|| arguments.get("identity_member_id"))
                .or_else(|| arguments.get("conversation_id"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let reason = arguments
                .get("reason")
                .and_then(Value::as_str)
                .map(str::to_string);
            let result = collaboration::interrupt_space_member_turn(
                pool,
                &space_id,
                caller_id,
                &member_ref,
                reason.as_deref(),
                delivery,
            )
            .await?;
            if let Some(listener) = on_space_changed.as_ref()
                && let Ok(workspace_id) = collaboration::space_workspace_id(pool, &space_id).await
            {
                let evt = collaboration::latest_space_changed_event(
                    pool,
                    workspace_id,
                    &space_id,
                    Some(result.member_id.clone()),
                )
                .await;
                listener(evt);
            }
            Ok(serde_json::to_value(result).unwrap_or(json!({})))
        }
        "delete_collaboration_space" => {
            let space_id = text("space_id");
            let workspace_id = collaboration::space_workspace_id(pool, &space_id)
                .await
                .ok();
            let result =
                collaboration::delete_collaboration_space(pool, caller_id, &space_id, operation_id)
                    .await?;
            if let (Some(listener), Some(workspace_id)) = (on_space_changed.as_ref(), workspace_id)
            {
                let evt =
                    collaboration::latest_space_changed_event(pool, workspace_id, &space_id, None)
                        .await;
                listener(evt);
            }
            Ok(result)
        }
        "set_space_identity" => {
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
                let evt = collaboration::latest_space_changed_event(
                    pool,
                    workspace_id,
                    &space_id,
                    Some(member.member_id.clone()),
                )
                .await;
                listener(evt);
            }
            Ok(serde_json::to_value(member).unwrap_or(json!({})))
        }
        "request_approval" => {
            let space_id = text("space_id");
            let card = conversations::collaboration_cards::post_card(
                pool,
                conversations::collaboration_cards::PostCard {
                    caller_id,
                    space_id: space_id.clone(),
                    kind: conversations::collaboration_cards::CardKind::Approval,
                    payload: json!({
                        "action": text("action"),
                        "command": text("command"),
                        "reason": text("reason"),
                    }),
                    operation_id,
                },
                delivery,
            )
            .await?;
            if let Some(listener) = on_space_changed.as_ref()
                && let Ok(workspace_id) = collaboration::space_workspace_id(pool, &space_id).await
            {
                let evt =
                    collaboration::latest_space_changed_event(pool, workspace_id, &space_id, None)
                        .await;
                listener(evt);
            }
            Ok(serde_json::to_value(card).unwrap_or(json!({})))
        }
        "resolve_card" => {
            let card_id = text("card_id");
            let card = conversations::collaboration_cards::resolve_card(
                pool,
                &card_id,
                // MCP calls act as the calling member.
                conversations::collaboration_cards::CardActor::Member(caller_id),
                arguments.get("decision").and_then(|v| v.as_str()),
                arguments.get("answer").and_then(|v| v.as_str()),
                delivery,
            )
            .await?;
            if let Some(listener) = on_space_changed.as_ref()
                && let Ok(workspace_id) =
                    collaboration::space_workspace_id(pool, &card.space_id).await
            {
                let evt = collaboration::latest_space_changed_event(
                    pool,
                    workspace_id,
                    &card.space_id,
                    card.member_id.clone(),
                )
                .await;
                listener(evt);
            }
            Ok(serde_json::to_value(card).unwrap_or(json!({})))
        }
        "memory_search" => {
            let limit = arguments
                .get("limit")
                .and_then(|v| v.as_u64())
                .unwrap_or(8)
                .clamp(1, 50) as usize;
            Ok(
                conversations::member_memory::tool_search(pool, caller_id, &text("query"), limit)
                    .await?,
            )
        }
        "memory_write" => {
            let scope = arguments.get("scope").and_then(|v| v.as_str());
            let fact =
                conversations::member_memory::tool_write(pool, caller_id, &text("content"), scope)
                    .await?;
            Ok(serde_json::to_value(fact).unwrap_or(json!({})))
        }
        "post_space_message" | "post_to_space" => {
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
            let delay_seconds = arguments
                .get("delay_seconds")
                .or_else(|| arguments.get("delaySeconds"))
                .and_then(Value::as_i64);
            let space_id = text("space_id");
            let posted = collaboration::post_to_space_delayed_with(
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
                        .get("reply_to")
                        .or_else(|| arguments.get("in_reply_to"))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    operation_id,
                },
                delay_seconds,
                delivery,
            )
            .await?;
            if let Some(listener) = on_space_changed.as_ref()
                && let Ok(workspace_id) = collaboration::space_workspace_id(pool, &space_id).await
            {
                let evt =
                    collaboration::latest_space_changed_event(pool, workspace_id, &space_id, None)
                        .await;
                listener(evt);
            }
            Ok(serde_json::to_value(posted).unwrap_or(json!({})))
        }
        "read_space_messages" | "list_space_messages" => {
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
            collaboration::list_space_members_detailed(pool, caller_id, &text("space_id")).await
        }
        "list_space_collection" => {
            let space_id = text("space_id");
            let items = collaboration::list_space_collection_with(
                pool,
                &space_id,
                Some(caller_id),
                arguments.get("limit").and_then(Value::as_i64),
                collaboration::MessageAudience::Agent,
                delivery,
            )
            .await?;
            if let Some(listener) = on_space_changed.as_ref()
                && !items.is_empty()
                && let Ok(workspace_id) = collaboration::space_workspace_id(pool, &space_id).await
            {
                let evt =
                    collaboration::latest_space_changed_event(pool, workspace_id, &space_id, None)
                        .await;
                listener(evt);
            }
            Ok(json!({ "items": items }))
        }
        "add_to_space_collection" => {
            let space_id = text("space_id");
            let item = collaboration::add_to_space_collection_with(
                pool,
                collaboration::AddSpaceCollectionItem {
                    caller_id: Some(caller_id),
                    space_id: space_id.clone(),
                    content: arguments
                        .get("content")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    source_path: arguments
                        .get("source_path")
                        .or_else(|| arguments.get("sourcePath"))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    base64_data: arguments
                        .get("base64_data")
                        .or_else(|| arguments.get("base64Data"))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    file_name: arguments
                        .get("file_name")
                        .or_else(|| arguments.get("fileName"))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    note: arguments
                        .get("note")
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
                let evt =
                    collaboration::latest_space_changed_event(pool, workspace_id, &space_id, None)
                        .await;
                listener(evt);
            }
            Ok(serde_json::to_value(item).unwrap_or(json!({})))
        }
        "read_space_collection_item" => {
            let space_id = text("space_id");
            let item_id = arguments
                .get("item_id")
                .or_else(|| arguments.get("itemId"))
                .or_else(|| arguments.get("id"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let item = collaboration::read_space_collection_item_with(
                pool,
                &space_id,
                &item_id,
                Some(caller_id),
                collaboration::MessageAudience::Agent,
                delivery,
            )
            .await?;
            if let Some(listener) = on_space_changed.as_ref()
                && let Ok(workspace_id) = collaboration::space_workspace_id(pool, &space_id).await
            {
                let evt =
                    collaboration::latest_space_changed_event(pool, workspace_id, &space_id, None)
                        .await;
                listener(evt);
            }
            Ok(serde_json::to_value(item).unwrap_or(json!({})))
        }
        "remove_space_collection_item" => {
            let space_id = text("space_id");
            let item_id = arguments
                .get("item_id")
                .or_else(|| arguments.get("itemId"))
                .or_else(|| arguments.get("id"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            collaboration::remove_space_collection_item_with(pool, &space_id, &item_id, delivery)
                .await?;
            if let Some(listener) = on_space_changed.as_ref()
                && let Ok(workspace_id) = collaboration::space_workspace_id(pool, &space_id).await
            {
                let evt =
                    collaboration::latest_space_changed_event(pool, workspace_id, &space_id, None)
                        .await;
                listener(evt);
            }
            Ok(json!({ "removed": true, "item_id": item_id, "space_id": space_id }))
        }
        _ => Err(collaboration::CollaborationError::new(
            "not_found",
            "unknown collaboration tool",
        )),
    }
}

fn first_nonempty_arg(arguments: &Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(value) = arguments
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return value.to_string();
        }
    }
    String::new()
}

fn optional_arg(arguments: &Value, key: &str) -> Option<String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn is_manageable_group(space_id: &str) -> bool {
    let space_id = space_id.trim();
    !space_id.is_empty()
        && !space_id.starts_with("direct:")
        && collaboration::parse_unassigned_space_id(space_id).is_none()
}

async fn emit_space_changed(
    pool: &SqlitePool,
    on_space_changed: &Option<SpaceChangedCallback>,
    space_id: &str,
    member_id: Option<String>,
) {
    let Some(listener) = on_space_changed else {
        return;
    };
    let Ok(workspace_id) = collaboration::space_workspace_id(pool, space_id).await else {
        return;
    };
    let evt =
        collaboration::latest_space_changed_event(pool, workspace_id, space_id, member_id).await;
    listener(evt);
}

fn missing_arg(name: &str) -> collaboration::CollaborationError {
    collaboration::CollaborationError::new("invalid_argument", format!("{name} is required"))
}

async fn manage_bot_tool(
    pool: &SqlitePool,
    caller_id: Uuid,
    arguments: &Value,
    operation_id: Uuid,
    delivery: &collaboration::DeliveryContext,
    on_space_changed: &Option<SpaceChangedCallback>,
) -> Result<Value, collaboration::CollaborationError> {
    let action = arguments
        .get("action")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    let space_id = first_nonempty_arg(arguments, &["space_id"]);
    let nickname = first_nonempty_arg(arguments, &["nickname"]);
    let mut bot_ref = first_nonempty_arg(
        arguments,
        &[
            "bot_id",
            "conversation_id",
            "member_id",
            "identity_member_id",
        ],
    );
    if bot_ref.is_empty() && action != "create" && action != "update" {
        bot_ref = nickname.clone();
    }
    match action {
        "create" => {
            if nickname.is_empty() {
                return Err(missing_arg("nickname"));
            }
            let created = collaboration::create_space_member(
                pool,
                caller_id,
                collaboration::CreateSpaceMemberRequest {
                    nickname: nickname.clone(),
                    role_id: optional_arg(arguments, "role_id"),
                    agent_id: optional_arg(arguments, "agent_id"),
                    team_id: optional_arg(arguments, "team_id"),
                    mode_id: optional_arg(arguments, "mode_id"),
                    config_values: arguments.get("config_values").cloned(),
                    persona_prompt: optional_arg(arguments, "persona_prompt"),
                    operation_id,
                },
            )
            .await?;
            if is_manageable_group(&space_id) {
                let conversation_id = created
                    .get("conversation_id")
                    .and_then(Value::as_str)
                    .and_then(|value| Uuid::parse_str(value).ok())
                    .ok_or_else(|| {
                        collaboration::CollaborationError::new(
                            "not_found",
                            "conversation was not found",
                        )
                    })?;
                let add_operation_id = Uuid::new_v5(&operation_id, b"add_space_member");
                let member = collaboration::add_space_member(
                    pool,
                    caller_id,
                    &space_id,
                    conversation_id,
                    &nickname,
                    add_operation_id,
                )
                .await?;
                emit_space_changed(
                    pool,
                    on_space_changed,
                    &space_id,
                    Some(member.member_id.clone()),
                )
                .await;
                let mut joined = created;
                if let Some(object) = joined.as_object_mut() {
                    object.insert("space_id".into(), json!(space_id));
                    object.insert("member_id".into(), json!(member.member_id));
                }
                return Ok(joined);
            }
            Ok(created)
        }
        "update" => {
            let persona = optional_arg(arguments, "persona_prompt");
            let mode_id = optional_arg(arguments, "mode_id");
            let agent_id = optional_arg(arguments, "agent_id");
            if nickname.is_empty() && persona.is_none() && mode_id.is_none() && agent_id.is_none() {
                return Err(missing_arg("nickname"));
            }
            let target_id = if bot_ref.is_empty() {
                caller_id
            } else {
                collaboration::resolve_bot_conversation(pool, caller_id, &space_id, &bot_ref)
                    .await?
                    .0
            };
            let mut result = json!({ "updated": true, "conversation_id": target_id });
            if !nickname.is_empty() {
                if space_id.is_empty() {
                    return Err(missing_arg("space_id"));
                }
                let member = collaboration::set_space_identity(
                    pool,
                    target_id,
                    &space_id,
                    &nickname,
                    operation_id,
                )
                .await?;
                emit_space_changed(
                    pool,
                    on_space_changed,
                    &space_id,
                    Some(member.member_id.clone()),
                )
                .await;
                result = serde_json::to_value(&member).unwrap_or(result);
            }
            if persona.is_some() || mode_id.is_some() || agent_id.is_some() {
                let identity = collaboration::identity_member_id_for_conversation(
                    pool,
                    Some(&target_id.to_string()),
                )
                .await?
                .ok_or_else(|| {
                    collaboration::CollaborationError::new("not_found", "member was not found")
                })?;
                let mut config = collaboration::load_member_session_config(pool, &identity)
                    .await?
                    .unwrap_or(collaboration::MemberSessionConfig {
                        agent_id: None,
                        mode_id: None,
                        config_values: json!({}),
                        persona_prompt: None,
                    });
                if let Some(persona) = persona {
                    config.persona_prompt = Some(persona);
                }
                if let Some(mode_id) = mode_id {
                    config.mode_id = Some(mode_id);
                }
                if let Some(agent_id) = agent_id {
                    config.agent_id = Some(agent_id);
                }
                let saved =
                    collaboration::set_member_session_config(pool, &identity, config).await?;
                if let Some(object) = result.as_object_mut() {
                    object.insert("identity_member_id".into(), json!(identity));
                    object.insert(
                        "session_config".into(),
                        serde_json::to_value(saved).unwrap_or(json!({})),
                    );
                }
            }
            Ok(result)
        }
        "delete" => {
            if bot_ref.is_empty() {
                return Err(missing_arg("bot_id"));
            }
            if space_id.is_empty() {
                return Err(missing_arg("space_id"));
            }
            let result = collaboration::delete_space_member(
                pool,
                caller_id,
                &space_id,
                &bot_ref,
                operation_id,
            )
            .await?;
            let member = result
                .get("member_id")
                .and_then(Value::as_str)
                .map(str::to_string);
            emit_space_changed(pool, on_space_changed, &space_id, member).await;
            Ok(result)
        }
        "interrupt" => {
            if bot_ref.is_empty() {
                return Err(missing_arg("bot_id"));
            }
            if space_id.is_empty() {
                return Err(missing_arg("space_id"));
            }
            let reason = optional_arg(arguments, "reason");
            let result = collaboration::interrupt_space_member_turn(
                pool,
                &space_id,
                caller_id,
                &bot_ref,
                reason.as_deref(),
                delivery,
            )
            .await?;
            emit_space_changed(
                pool,
                on_space_changed,
                &space_id,
                Some(result.member_id.clone()),
            )
            .await;
            Ok(serde_json::to_value(result).unwrap_or(json!({})))
        }
        _ => Err(collaboration::CollaborationError::new(
            "invalid_argument",
            "unknown manage_bot action",
        )),
    }
}

async fn manage_group_tool(
    pool: &SqlitePool,
    caller_id: Uuid,
    arguments: &Value,
    operation_id: Uuid,
    _delivery: &collaboration::DeliveryContext,
    on_space_changed: &Option<SpaceChangedCallback>,
) -> Result<Value, collaboration::CollaborationError> {
    let action = arguments
        .get("action")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    let space_id = first_nonempty_arg(arguments, &["space_id"]);
    let name = first_nonempty_arg(arguments, &["name"]);
    let nickname = first_nonempty_arg(arguments, &["nickname"]);
    let mut bot_ref = first_nonempty_arg(
        arguments,
        &[
            "bot_id",
            "conversation_id",
            "member_id",
            "identity_member_id",
        ],
    );
    if bot_ref.is_empty() {
        bot_ref = nickname.clone();
    }
    match action {
        "create" => {
            if name.is_empty() {
                return Err(missing_arg("name"));
            }
            let space =
                collaboration::create_collaboration_space(pool, caller_id, &name, operation_id)
                    .await?;
            emit_space_changed(pool, on_space_changed, &space.space_id, None).await;
            Ok(serde_json::to_value(space).unwrap_or(json!({})))
        }
        "rename" => {
            if space_id.is_empty() {
                return Err(missing_arg("space_id"));
            }
            if name.is_empty() {
                return Err(missing_arg("name"));
            }
            let space = collaboration::rename_workspace_space(pool, &space_id, &name).await?;
            emit_space_changed(pool, on_space_changed, &space_id, None).await;
            Ok(serde_json::to_value(space).unwrap_or(json!({})))
        }
        "delete" => {
            if space_id.is_empty() {
                return Err(missing_arg("space_id"));
            }
            let workspace_id = collaboration::space_workspace_id(pool, &space_id).await.ok();
            let result =
                collaboration::delete_collaboration_space(pool, caller_id, &space_id, operation_id)
                    .await?;
            if let (Some(listener), Some(workspace_id)) = (on_space_changed.as_ref(), workspace_id) {
                let evt = collaboration::latest_space_changed_event(
                    pool,
                    workspace_id,
                    &space_id,
                    None,
                )
                .await;
                listener(evt);
            }
            Ok(result)
        }
        "add_bot" => {
            if space_id.is_empty() {
                return Err(missing_arg("space_id"));
            }
            if bot_ref.is_empty() {
                return Err(missing_arg("bot_id"));
            }
            let (conversation_id, current_nick) =
                collaboration::resolve_bot_conversation(pool, caller_id, &space_id, &bot_ref)
                    .await?;
            let seat_name = if nickname.is_empty() {
                current_nick
            } else {
                nickname
            };
            let member = collaboration::add_space_member(
                pool,
                caller_id,
                &space_id,
                conversation_id,
                &seat_name,
                operation_id,
            )
            .await?;
            emit_space_changed(
                pool,
                on_space_changed,
                &space_id,
                Some(member.member_id.clone()),
            )
            .await;
            collaboration::space_member_tool_value(pool, &member).await
        }
        "remove_bot" => {
            if space_id.is_empty() {
                return Err(missing_arg("space_id"));
            }
            if bot_ref.is_empty() {
                return Err(missing_arg("bot_id"));
            }
            let result = collaboration::remove_space_member(
                pool,
                caller_id,
                &space_id,
                &bot_ref,
                operation_id,
            )
            .await?;
            let member = result
                .get("member_id")
                .and_then(Value::as_str)
                .map(str::to_string);
            emit_space_changed(pool, on_space_changed, &space_id, member).await;
            Ok(result)
        }
        "leave" => {
            if space_id.is_empty() {
                return Err(missing_arg("space_id"));
            }
            let result =
                collaboration::leave_space(pool, caller_id, &space_id, operation_id).await?;
            emit_space_changed(pool, on_space_changed, &space_id, None).await;
            Ok(result)
        }
        "set_lead" => {
            if space_id.is_empty() {
                return Err(missing_arg("space_id"));
            }
            if bot_ref.is_empty() {
                return Err(missing_arg("bot_id"));
            }
            let result = collaboration::transfer_space_lead(
                pool,
                caller_id,
                &space_id,
                &bot_ref,
                operation_id,
            )
            .await?;
            let lead = result
                .get("lead_member_id")
                .and_then(Value::as_str)
                .map(str::to_string);
            emit_space_changed(pool, on_space_changed, &space_id, lead).await;
            Ok(result)
        }
        _ => Err(collaboration::CollaborationError::new(
            "invalid_argument",
            "unknown manage_group action",
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
