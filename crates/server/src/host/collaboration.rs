//! Plugin `host.call` for collaboration records and workspace navigation.
//!
//! The plugin id is never a branch. UI writes that have no agent caller
//! (create a space, add a member, post as the user) stay on this seam.
//! Agent MCP keeps its own membership checks.

use std::sync::Arc;

use agents::{AgentId, runtime::AgentRuntime};
use async_trait::async_trait;
use conversations::collaboration::{
    self, CollaborationSpaceChangedEvent, DeliveryContext, MessageAudience, SaveRole, SaveTeam,
};
use conversations::member_memory;
use plugins::{CollaborationHost, CollaborationHostError};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::host::events::{
    COLLABORATION_RECEIPTS_CHANGED_EVENT, COLLABORATION_SPACE_CHANGED_EVENT, HostEventBus,
};

const SESSION_PANEL_ID: &str = "ai-chat";

pub struct HostCollaborationHost {
    pool: SqlitePool,
    events: Arc<HostEventBus>,
    runtime: Option<Arc<AgentRuntime>>,
    delivery: std::sync::Mutex<DeliveryContext>,
}

impl HostCollaborationHost {
    pub fn new(pool: SqlitePool, events: Arc<HostEventBus>) -> Self {
        Self {
            pool,
            events,
            runtime: None,
            delivery: std::sync::Mutex::new(DeliveryContext::default()),
        }
    }

    pub fn with_agent_runtime(mut self, runtime: Arc<AgentRuntime>) -> Self {
        self.runtime = Some(runtime);
        self
    }

    pub fn with_delivery(self, delivery: DeliveryContext) -> Self {
        self.install_delivery(delivery);
        self
    }

    pub fn install_delivery(&self, delivery: DeliveryContext) {
        *self.delivery.lock().expect("delivery") = delivery;
    }
}

#[async_trait]
impl CollaborationHost for HostCollaborationHost {
    async fn call(
        &self,
        _plugin_id: &str,
        capability: &str,
        operation: &str,
        input: Value,
    ) -> Result<Value, CollaborationHostError> {
        match (capability, operation) {
            ("collaboration", "role.list") => self.list_roles().await,
            ("collaboration", "role.create") => self.save_role(None, &input).await,
            ("collaboration", "role.update") => {
                let id = required_text(&input, &["roleId", "role_id", "id"])?;
                self.save_role(Some(id), &input).await
            }
            ("collaboration", "role.delete") => self.delete_role(&input).await,
            ("collaboration", "role.agents") => self.enabled_agents().await,
            ("collaboration", "agent.controls") => self.agent_controls(&input).await,
            ("collaboration", "team.list") => self.list_teams().await,
            ("collaboration", "team.create") => self.save_team(None, &input).await,
            ("collaboration", "team.update") => {
                let id = required_text(&input, &["teamId", "team_id", "id"])?;
                self.save_team(Some(id), &input).await
            }
            ("collaboration", "team.delete") => self.delete_team(&input).await,
            ("collaboration", "space.list") => self.list_spaces(&input).await,
            ("collaboration", "space.create") => self.create_space(&input).await,
            ("collaboration", "space.rename" | "space.update") => self.rename_space(&input).await,
            ("collaboration", "space.addMember" | "space.add_member") => {
                self.add_member(&input).await
            }
            ("collaboration", "space.createMember" | "space.create_member") => {
                self.create_member(&input).await
            }
            ("collaboration", "space.moveMember" | "space.move_member") => {
                self.move_member(&input).await
            }
            ("collaboration", "space.batchDelete" | "space.batch_delete" | "space.delete") => {
                self.batch_delete(&input).await
            }
            ("collaboration", "space.setIdentity" | "space.set_identity") => {
                self.set_identity(&input).await
            }
            ("collaboration", "space.listMembers" | "space.list_members") => {
                self.list_members(&input).await
            }
            ("collaboration", "space.listMessages" | "space.list_messages") => {
                self.list_messages(&input).await
            }
            ("collaboration", "space.listScheduledMessages" | "space.list_scheduled_messages") => {
                self.list_scheduled_messages(&input).await
            }
            (
                "collaboration",
                "space.cancelScheduledMessage" | "space.cancel_scheduled_message",
            ) => self.cancel_scheduled_message(&input).await,
            (
                "collaboration",
                "space.updateScheduledMessage" | "space.update_scheduled_message",
            ) => self.update_scheduled_message(&input).await,
            ("collaboration", "space.post") => self.post(&input).await,
            ("collaboration", "space.submit") => self.submit(&input).await,
            ("collaboration", "card.list" | "card.list_cards") => self.list_cards(&input).await,
            ("collaboration", "card.resolve") => self.resolve_card(&input).await,
            ("collaboration", "member.memory.list" | "member.memory_list") => {
                self.memory_list(&input).await
            }
            ("collaboration", "member.memory.update" | "member.memory_update") => {
                self.memory_update(&input).await
            }
            ("collaboration", "member.memory.delete" | "member.memory_delete") => {
                self.memory_delete(&input).await
            }
            ("collaboration", "member.activity.list" | "member.activity_list") => {
                self.activity_list(&input).await
            }
            ("collaboration", "member.setWriteAccess" | "member.set_write_access") => {
                self.set_write_access(&input).await
            }
            ("collaboration", "space.receipts" | "space.listReceipts" | "space.list_receipts") => {
                self.receipts(&input).await
            }
            ("collaboration", "space.wakePreview" | "space.wake_preview") => {
                self.wake_preview(&input).await
            }
            ("collaboration", "space.listCollection" | "space.list_collection") => {
                self.list_collection(&input).await
            }
            ("collaboration", "space.addCollectionItem" | "space.add_collection_item") => {
                self.add_collection_item(&input).await
            }
            ("collaboration", "space.readCollectionItem" | "space.read_collection_item") => {
                self.read_collection_item(&input).await
            }
            (
                "collaboration",
                "space.updateCollectionItem"
                | "space.update_collection_item"
                | "space.updateCollectionItemNote"
                | "space.update_collection_item_note",
            ) => self.update_collection_item(&input).await,
            ("collaboration", "space.listConversations" | "space.list_conversations") => {
                self.list_conversations(&input).await
            }
            ("workspace", "focusConversation" | "focus_conversation") => {
                self.focus_conversation(&input).await
            }
            _ => Err(CollaborationHostError::new(
                "capability_unimplemented",
                format!("{capability}.{operation} is not available"),
            )),
        }
    }
}

impl HostCollaborationHost {
    async fn list_roles(&self) -> Result<Value, CollaborationHostError> {
        let roles = collaboration::list_roles(&self.pool)
            .await
            .map_err(host_error)?;
        Ok(json!({ "roles": roles }))
    }

    async fn save_role(
        &self,
        id: Option<String>,
        input: &Value,
    ) -> Result<Value, CollaborationHostError> {
        let saved = SaveRole {
            id: None,
            name: text(input, &["name"]),
            team_id: optional_text(input, &["teamId", "team_id"]),
            summary: text(input, &["summary"]),
            persona_prompt: text(input, &["personaPrompt", "persona_prompt"]),
            agent_id: text(input, &["agentId", "agent_id"]),
            mode_id: optional_text(input, &["modeId", "mode_id"]),
            config_values: input
                .get("configValues")
                .or_else(|| input.get("config_values"))
                .cloned()
                .unwrap_or_else(|| json!({})),
        };
        let role = match id {
            Some(id) => collaboration::update_role(&self.pool, &id, saved).await,
            None => collaboration::create_role(&self.pool, saved).await,
        }
        .map_err(host_error)?;
        serde_json::to_value(role).map_err(|error| {
            CollaborationHostError::new("conversation_control_failed", error.to_string())
        })
    }

    async fn delete_role(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let id = required_text(input, &["roleId", "role_id", "id"])?;
        collaboration::delete_role(&self.pool, &id)
            .await
            .map_err(host_error)?;
        Ok(json!({ "deleted": true }))
    }

    async fn list_teams(&self) -> Result<Value, CollaborationHostError> {
        let teams = collaboration::list_teams(&self.pool)
            .await
            .map_err(host_error)?;
        Ok(json!({ "teams": teams }))
    }

    async fn save_team(
        &self,
        id: Option<String>,
        input: &Value,
    ) -> Result<Value, CollaborationHostError> {
        let saved = SaveTeam {
            id: None,
            name: text(input, &["name"]),
            summary: optional_text(input, &["summary"]),
        };
        let team = match id {
            Some(id) => collaboration::update_team(&self.pool, &id, saved).await,
            None => collaboration::create_team(&self.pool, saved).await,
        }
        .map_err(host_error)?;
        serde_json::to_value(team).map_err(|error| {
            CollaborationHostError::new("conversation_control_failed", error.to_string())
        })
    }

    async fn delete_team(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let id = required_text(input, &["teamId", "team_id", "id"])?;
        collaboration::delete_team(&self.pool, &id)
            .await
            .map_err(host_error)?;
        Ok(json!({ "deleted": true }))
    }

    async fn list_spaces(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let workspace_id = required_uuid(input, &["workspaceId", "workspace_id"])?;
        let spaces = collaboration::list_workspace_spaces(&self.pool, workspace_id)
            .await
            .map_err(host_error)?;
        Ok(json!({ "spaces": spaces }))
    }

    async fn create_space(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let workspace_id = required_uuid(input, &["workspaceId", "workspace_id"])?;
        let operation_id = required_uuid(input, &["operationId", "operation_id"])?;
        let space = collaboration::create_workspace_space(
            &self.pool,
            workspace_id,
            &text(input, &["name"]),
            operation_id,
        )
        .await
        .map_err(host_error)?;
        self.events.emit(
            COLLABORATION_SPACE_CHANGED_EVENT,
            CollaborationSpaceChangedEvent {
                workspace_id,
                space_id: space.space_id.clone(),
                seq: None,
                member_id: None,
            },
        );
        serde_json::to_value(space).map_err(|error| {
            CollaborationHostError::new("conversation_control_failed", error.to_string())
        })
    }

    async fn rename_space(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let space_id = required_text(input, &["spaceId", "space_id", "id"])?;
        let name = text(input, &["name"]);
        let space = collaboration::rename_workspace_space(&self.pool, &space_id, &name)
            .await
            .map_err(host_error)?;
        self.events.emit(
            COLLABORATION_SPACE_CHANGED_EVENT,
            CollaborationSpaceChangedEvent {
                workspace_id: space.workspace_id,
                space_id: space.space_id.clone(),
                seq: None,
                member_id: None,
            },
        );
        serde_json::to_value(space).map_err(|error| {
            CollaborationHostError::new("conversation_control_failed", error.to_string())
        })
    }

    async fn add_member(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let space_id = required_text(input, &["spaceId", "space_id"])?;
        let operation_id = required_uuid(input, &["operationId", "operation_id"])?;
        let conversation_id = required_uuid(input, &["conversationId", "conversation_id"])?;
        let nickname = text(input, &["nickname"]);
        let member = collaboration::host_add_space_member(
            &self.pool,
            &space_id,
            conversation_id,
            &nickname,
            operation_id,
        )
        .await
        .map_err(host_error)?;
        if input.get("teamId").is_some() || input.get("team_id").is_some() {
            let team_id = optional_text(input, &["teamId", "team_id"]);
            let _ = collaboration::set_conversation_persona_team(
                &self.pool,
                conversation_id,
                &member.nickname,
                team_id.as_deref(),
            )
            .await
            .map_err(host_error)?;
        }
        let workspace_id = collaboration::space_workspace_id(&self.pool, &space_id)
            .await
            .map_err(host_error)?;
        self.events.emit(
            COLLABORATION_SPACE_CHANGED_EVENT,
            CollaborationSpaceChangedEvent {
                workspace_id,
                space_id,
                seq: None,
                member_id: Some(member.member_id.clone()),
            },
        );
        serde_json::to_value(member).map_err(|error| {
            CollaborationHostError::new("conversation_control_failed", error.to_string())
        })
    }

    async fn create_member(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let workspace_id = required_uuid(input, &["workspaceId", "workspace_id"])?;
        let operation_id = required_uuid(input, &["operationId", "operation_id"])?;
        let space_id = optional_text(input, &["spaceId", "space_id"]);
        let target_space_id = space_id
            .clone()
            .unwrap_or_else(|| collaboration::unassigned_space_id(workspace_id));
        let member = collaboration::host_create_space_member(
            &self.pool,
            collaboration::HostCreateSpaceMember {
                workspace_id,
                space_id,
                nickname: text(input, &["nickname", "name"]),
                role_id: optional_text(input, &["roleId", "role_id"]),
                agent_id: optional_text(input, &["agentId", "agent_id"]),
                team_id: optional_text(input, &["teamId", "team_id"]),
                persona_prompt: optional_text(input, &["personaPrompt", "persona_prompt"]),
                mode_id: optional_text(input, &["modeId", "mode_id"]),
                config_values: input
                    .get("configValues")
                    .or_else(|| input.get("config_values"))
                    .cloned(),
                operation_id,
            },
        )
        .await
        .map_err(host_error)?;
        self.events.emit(
            COLLABORATION_SPACE_CHANGED_EVENT,
            CollaborationSpaceChangedEvent {
                workspace_id,
                space_id: target_space_id,
                seq: None,
                member_id: Some(member.member_id.clone()),
            },
        );
        serde_json::to_value(member).map_err(|error| {
            CollaborationHostError::new("conversation_control_failed", error.to_string())
        })
    }

    async fn move_member(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let from_space_id = required_text(input, &["fromSpaceId", "from_space_id"])?;
        let to_space_id = required_text(input, &["toSpaceId", "to_space_id"])?;
        let conversation_id = required_uuid(input, &["conversationId", "conversation_id"])?;
        let operation_id = required_uuid(input, &["operationId", "operation_id"])?;
        let nickname = optional_text(input, &["nickname"]);
        let member = collaboration::host_move_space_member(
            &self.pool,
            &from_space_id,
            &to_space_id,
            conversation_id,
            nickname.as_deref(),
            operation_id,
        )
        .await
        .map_err(host_error)?;
        let workspace_id = collaboration::space_workspace_id(&self.pool, &to_space_id)
            .await
            .map_err(host_error)?;
        self.events.emit(
            COLLABORATION_SPACE_CHANGED_EVENT,
            CollaborationSpaceChangedEvent {
                workspace_id,
                space_id: from_space_id,
                seq: None,
                member_id: Some(member.member_id.clone()),
            },
        );
        self.events.emit(
            COLLABORATION_SPACE_CHANGED_EVENT,
            CollaborationSpaceChangedEvent {
                workspace_id,
                space_id: to_space_id,
                seq: None,
                member_id: Some(member.member_id.clone()),
            },
        );
        serde_json::to_value(member).map_err(|error| {
            CollaborationHostError::new("conversation_control_failed", error.to_string())
        })
    }

    async fn batch_delete(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let workspace_id = required_uuid(input, &["workspaceId", "workspace_id"])?;
        let operation_id = required_uuid(input, &["operationId", "operation_id"])?;
        let space_ids: Vec<String> = input
            .get("spaceIds")
            .or_else(|| input.get("space_ids"))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        let member_targets: Vec<collaboration::BatchDeleteMemberTarget> = input
            .get("memberTargets")
            .or_else(|| input.get("member_targets"))
            .or_else(|| input.get("members"))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        let space_id = item
                            .get("spaceId")
                            .or_else(|| item.get("space_id"))
                            .and_then(Value::as_str)
                            .map(|value| value.trim().to_string())?;
                        let conversation_id = item
                            .get("conversationId")
                            .or_else(|| item.get("conversation_id"))
                            .and_then(Value::as_str)
                            .and_then(|raw| Uuid::parse_str(raw.trim()).ok())?;
                        Some(collaboration::BatchDeleteMemberTarget {
                            space_id,
                            conversation_id,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let result = collaboration::host_batch_delete_space_items(
            &self.pool,
            workspace_id,
            space_ids,
            member_targets,
            operation_id,
        )
        .await
        .map_err(host_error)?;
        self.events.emit(
            COLLABORATION_SPACE_CHANGED_EVENT,
            CollaborationSpaceChangedEvent {
                workspace_id,
                space_id: format!("unassigned:{workspace_id}"),
                seq: None,
                member_id: Some("batch_delete".to_string()),
            },
        );
        for deleted_space_id in &result.deleted_space_ids {
            self.events.emit(
                COLLABORATION_SPACE_CHANGED_EVENT,
                CollaborationSpaceChangedEvent {
                    workspace_id,
                    space_id: deleted_space_id.clone(),
                    seq: None,
                    member_id: Some("batch_delete".to_string()),
                },
            );
        }
        serde_json::to_value(result).map_err(|error| {
            CollaborationHostError::new("conversation_control_failed", error.to_string())
        })
    }

    async fn set_identity(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let space_id = required_text(input, &["spaceId", "space_id"])?;
        let operation_id = required_uuid(input, &["operationId", "operation_id"])?;
        let caller_id = required_uuid(
            input,
            &["conversationId", "conversation_id", "callerId", "caller_id"],
        )?;
        let member = collaboration::set_space_identity(
            &self.pool,
            caller_id,
            &space_id,
            &text(input, &["nickname"]),
            operation_id,
        )
        .await
        .map_err(host_error)?;
        let workspace_id = collaboration::space_workspace_id(&self.pool, &space_id)
            .await
            .map_err(host_error)?;
        self.events.emit(
            COLLABORATION_SPACE_CHANGED_EVENT,
            CollaborationSpaceChangedEvent {
                workspace_id,
                space_id,
                seq: None,
                member_id: Some(member.member_id.clone()),
            },
        );
        serde_json::to_value(member).map_err(|error| {
            CollaborationHostError::new("conversation_control_failed", error.to_string())
        })
    }

    async fn list_members(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let members = collaboration::list_space_members(
            &self.pool,
            &required_text(input, &["spaceId", "space_id"])?,
            MessageAudience::User,
        )
        .await
        .map_err(host_error)?;
        Ok(json!({ "members": members }))
    }

    async fn list_messages(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let space_id = required_text(input, &["spaceId", "space_id"])?;
        let limit = input.get("limit").and_then(Value::as_i64);
        let since = if truthy(input, &["latest"]) {
            Some(latest_since(&self.pool, &space_id, limit.unwrap_or(200)).await?)
        } else {
            input
                .get("sinceSeq")
                .or_else(|| input.get("since_seq"))
                .and_then(Value::as_i64)
        };
        let messages = collaboration::list_space_messages(
            &self.pool,
            &space_id,
            since,
            limit,
            MessageAudience::User,
        )
        .await
        .map_err(host_error)?;
        let scheduled = collaboration::list_space_scheduled_messages(&self.pool, &space_id)
            .await
            .unwrap_or_default();
        Ok(json!({ "messages": messages, "scheduled": scheduled }))
    }

    async fn list_scheduled_messages(
        &self,
        input: &Value,
    ) -> Result<Value, CollaborationHostError> {
        let space_id = required_text(input, &["spaceId", "space_id"])?;
        let scheduled = collaboration::list_space_scheduled_messages(&self.pool, &space_id)
            .await
            .map_err(host_error)?;
        Ok(json!({ "scheduled": scheduled }))
    }

    async fn cancel_scheduled_message(
        &self,
        input: &Value,
    ) -> Result<Value, CollaborationHostError> {
        let space_id = required_text(input, &["spaceId", "space_id"])?;
        let id = required_text(input, &["id", "messageId", "message_id"])?;
        let cancelled = collaboration::cancel_space_scheduled_message(&self.pool, &space_id, &id)
            .await
            .map_err(host_error)?;
        if let Ok(workspace_id) = collaboration::space_workspace_id(&self.pool, &space_id).await {
            self.events.emit(
                COLLABORATION_SPACE_CHANGED_EVENT,
                CollaborationSpaceChangedEvent {
                    workspace_id,
                    space_id,
                    seq: Some(0),
                    member_id: None,
                },
            );
        }
        Ok(json!({ "cancelled": cancelled }))
    }

    async fn update_scheduled_message(
        &self,
        input: &Value,
    ) -> Result<Value, CollaborationHostError> {
        let space_id = required_text(input, &["spaceId", "space_id"])?;
        let id = required_text(input, &["id", "messageId", "message_id"])?;
        let content = optional_text(input, &["content"]);
        let delay_seconds = input
            .get("delaySeconds")
            .or_else(|| input.get("delay_seconds"))
            .and_then(Value::as_i64);
        let updated = collaboration::update_space_scheduled_message(
            &self.pool,
            &space_id,
            &id,
            content.as_deref(),
            delay_seconds,
        )
        .await
        .map_err(host_error)?;
        if let Ok(workspace_id) = collaboration::space_workspace_id(&self.pool, &space_id).await {
            self.events.emit(
                COLLABORATION_SPACE_CHANGED_EVENT,
                CollaborationSpaceChangedEvent {
                    workspace_id,
                    space_id,
                    seq: Some(0),
                    member_id: None,
                },
            );
        }
        Ok(json!({ "scheduled": updated }))
    }

    async fn post(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let space_id = required_text(input, &["spaceId", "space_id"])?;
        let delay_seconds = input
            .get("delaySeconds")
            .or_else(|| input.get("delay_seconds"))
            .and_then(Value::as_i64);
        let delivery = self.delivery.lock().expect("delivery").clone();
        let posted = collaboration::post_to_space_delayed_with(
            &self.pool,
            collaboration::PostToSpace {
                caller_id: None,
                space_id: space_id.clone(),
                content: text(input, &["content"]),
                summary: optional_text(input, &["summary"]),
                to: string_list(input, &["to"]),
                in_reply_to: optional_text(input, &["inReplyTo", "in_reply_to"]),
                operation_id: required_uuid(input, &["operationId", "operation_id"])?,
            },
            delay_seconds,
            &delivery,
        )
        .await
        .map_err(host_error)?;
        let workspace_id = collaboration::space_workspace_id(&self.pool, &space_id)
            .await
            .map_err(host_error)?;
        self.events.emit(
            COLLABORATION_SPACE_CHANGED_EVENT,
            CollaborationSpaceChangedEvent {
                workspace_id,
                space_id,
                seq: Some(posted.seq),
                member_id: None,
            },
        );
        serde_json::to_value(posted).map_err(|error| {
            CollaborationHostError::new("conversation_control_failed", error.to_string())
        })
    }

    /// User submit: post into a group thread and return the per-member
    /// three-state receipts (`queued` / `processing` / `replied`).
    async fn submit(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let space_id = optional_text(input, &["threadId", "thread_id"])
            .map(Ok)
            .unwrap_or_else(|| required_text(input, &["spaceId", "space_id"]))?;
        let mut forwarded = input.clone();
        if let Some(object) = forwarded.as_object_mut() {
            object.insert("spaceId".to_string(), json!(space_id));
        }
        let posted = self.post(&forwarded).await?;
        let message_id = posted
            .get("message_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let receipts = collaboration::list_message_receipts(&self.pool, &message_id)
            .await
            .map_err(host_error)?;
        self.events.emit(
            COLLABORATION_RECEIPTS_CHANGED_EVENT,
            json!({ "spaceId": space_id, "messageId": message_id, "receipts": receipts }),
        );
        Ok(json!({
            "messageId": message_id,
            "seq": posted.get("seq").cloned().unwrap_or(Value::Null),
            "receipts": receipts,
            "deliveries": posted.get("receipts").cloned().unwrap_or(Value::Null),
        }))
    }

    /// `writeAccess`: `write_isolated` (default) or `write_serialized`.
    async fn set_write_access(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let member_id = required_text(input, &["memberId", "member_id"])?;
        let raw = required_text(input, &["writeAccess", "write_access"])?;
        let access = collaboration::MemberWriteAccess::parse(&raw).ok_or_else(|| {
            CollaborationHostError::new(
                "conversation_control_failed",
                "writeAccess must be write_isolated or write_serialized",
            )
        })?;
        collaboration::set_member_write_access(&self.pool, &member_id, access)
            .await
            .map_err(host_error)?;
        Ok(json!({ "memberId": member_id, "writeAccess": access.as_str() }))
    }

    async fn list_cards(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let space_id = optional_text(input, &["threadId", "thread_id", "spaceId", "space_id"]);
        let pending_only = input
            .get("pendingOnly")
            .or_else(|| input.get("pending_only"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let cards =
            conversations::collaboration_cards::list_cards(&self.pool, space_id.as_deref(), pending_only)
                .await
                .map_err(host_error)?;
        Ok(json!({ "cards": cards }))
    }

    async fn resolve_card(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let card_id = required_text(input, &["cardId", "card_id", "id"])?;
        let delivery = self.delivery.lock().expect("delivery").clone();
        let card = conversations::collaboration_cards::resolve_card(
            &self.pool,
            &card_id,
            // Host/UI calls are always the user (the human owner).
            conversations::collaboration_cards::CardActor::User,
            optional_text(input, &["decision"]).as_deref(),
            optional_text(input, &["answer", "note"]).as_deref(),
            &delivery,
        )
        .await
        .map_err(host_error)?;
        if let Ok(workspace_id) = collaboration::space_workspace_id(&self.pool, &card.space_id).await {
            self.events.emit(
                COLLABORATION_SPACE_CHANGED_EVENT,
                CollaborationSpaceChangedEvent {
                    workspace_id,
                    space_id: card.space_id.clone(),
                    seq: None,
                    member_id: card.member_id.clone(),
                },
            );
        }
        Ok(json!({ "card": card }))
    }

    /// The user's own view of a member's memory: every scope, private included.
    async fn memory_list(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let member_id = required_text(input, &["memberId", "member_id"])?;
        let scope = optional_text(input, &["scope"]).map(|raw| parse_fact_scope(&raw)).transpose()?;
        let facts = member_memory::list_facts(&self.pool, &member_id, scope.as_ref())
            .await
            .map_err(host_error)?;
        Ok(json!({ "memberId": member_id, "facts": facts }))
    }

    async fn memory_update(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let member_id = required_text(input, &["memberId", "member_id"])?;
        let fact_id = fact_id(input)?;
        let content = optional_text(input, &["content"]);
        let scope = optional_text(input, &["scope"]).map(|raw| parse_fact_scope(&raw)).transpose()?;
        let fact = member_memory::update_fact(
            &self.pool,
            &member_id,
            fact_id,
            content.as_deref(),
            scope.as_ref(),
        )
        .await
        .map_err(host_error)?;
        Ok(json!({ "memberId": member_id, "fact": fact }))
    }

    async fn memory_delete(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let member_id = required_text(input, &["memberId", "member_id"])?;
        let fact_id = fact_id(input)?;
        let deleted = member_memory::delete_fact(&self.pool, &member_id, fact_id)
            .await
            .map_err(host_error)?;
        Ok(json!({ "memberId": member_id, "factId": fact_id, "deleted": deleted }))
    }

    async fn activity_list(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let member_id = required_text(input, &["memberId", "member_id"])?;
        let limit = input
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(50)
            .clamp(1, 500) as usize;
        let activity = member_memory::list_activity(&self.pool, &member_id, true, limit)
            .await
            .map_err(host_error)?;
        Ok(json!({ "memberId": member_id, "activity": activity }))
    }

    async fn receipts(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let message_id = required_text(input, &["messageId", "message_id"])?;
        let receipts = collaboration::list_message_receipts(&self.pool, &message_id)
            .await
            .map_err(host_error)?;
        Ok(json!({ "messageId": message_id, "receipts": receipts }))
    }

    async fn wake_preview(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let space_id = optional_text(input, &["threadId", "thread_id"])
            .map(Ok)
            .unwrap_or_else(|| required_text(input, &["spaceId", "space_id"]))?;
        let preview = collaboration::preview_space_wake(
            &self.pool,
            &space_id,
            None,
            &text(input, &["content"]),
            &string_list(input, &["to"]),
        )
        .await
        .map_err(host_error)?;
        serde_json::to_value(preview).map_err(|error| {
            CollaborationHostError::new("conversation_control_failed", error.to_string())
        })
    }

    async fn list_collection(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let space_id = required_text(input, &["spaceId", "space_id"])?;
        let limit = input.get("limit").and_then(Value::as_i64);
        let delivery = self.delivery.lock().expect("delivery").clone();
        let items = collaboration::list_space_collection_with(
            &self.pool,
            &space_id,
            None,
            limit,
            MessageAudience::User,
            &delivery,
        )
        .await
        .map_err(host_error)?;
        Ok(json!({ "items": items }))
    }

    async fn add_collection_item(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let space_id = required_text(input, &["spaceId", "space_id"])?;
        let operation_id = optional_text(input, &["operationId", "operation_id"])
            .and_then(|v| Uuid::parse_str(&v).ok())
            .unwrap_or_else(Uuid::new_v4);
        let delivery = self.delivery.lock().expect("delivery").clone();
        let item = collaboration::add_to_space_collection_with(
            &self.pool,
            collaboration::AddSpaceCollectionItem {
                caller_id: None,
                space_id: space_id.clone(),
                content: optional_text(input, &["content"]),
                source_path: optional_text(input, &["sourcePath", "source_path"]),
                base64_data: optional_text(input, &["base64Data", "base64_data"]),
                file_name: optional_text(input, &["fileName", "file_name", "name"]),
                note: optional_text(input, &["note"]),
                operation_id,
            },
            &delivery,
        )
        .await
        .map_err(host_error)?;
        if let Ok(workspace_id) = collaboration::space_workspace_id(&self.pool, &space_id).await {
            self.events.emit(
                COLLABORATION_SPACE_CHANGED_EVENT,
                CollaborationSpaceChangedEvent {
                    workspace_id,
                    space_id,
                    seq: None,
                    member_id: None,
                },
            );
        }
        serde_json::to_value(item).map_err(|error| {
            CollaborationHostError::new("conversation_control_failed", error.to_string())
        })
    }

    async fn read_collection_item(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let space_id = required_text(input, &["spaceId", "space_id"])?;
        let item_id = required_text(input, &["itemId", "item_id", "id"])?;
        let delivery = self.delivery.lock().expect("delivery").clone();
        let item = collaboration::read_space_collection_item_with(
            &self.pool,
            &space_id,
            &item_id,
            None,
            MessageAudience::User,
            &delivery,
        )
        .await
        .map_err(host_error)?;
        if let Ok(workspace_id) = collaboration::space_workspace_id(&self.pool, &space_id).await {
            self.events.emit(
                COLLABORATION_SPACE_CHANGED_EVENT,
                CollaborationSpaceChangedEvent {
                    workspace_id,
                    space_id,
                    seq: None,
                    member_id: None,
                },
            );
        }
        serde_json::to_value(item).map_err(|error| {
            CollaborationHostError::new("conversation_control_failed", error.to_string())
        })
    }

    async fn update_collection_item(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let space_id = required_text(input, &["spaceId", "space_id"])?;
        let item_id = required_text(input, &["itemId", "item_id", "id"])?;
        let note = text(input, &["note"]);
        let delivery = self.delivery.lock().expect("delivery").clone();
        let item = collaboration::update_space_collection_item_note_with(
            &self.pool,
            &space_id,
            &item_id,
            &note,
            MessageAudience::User,
            &delivery,
        )
        .await
        .map_err(host_error)?;
        if let Ok(workspace_id) = collaboration::space_workspace_id(&self.pool, &space_id).await {
            self.events.emit(
                COLLABORATION_SPACE_CHANGED_EVENT,
                CollaborationSpaceChangedEvent {
                    workspace_id,
                    space_id,
                    seq: None,
                    member_id: None,
                },
            );
        }
        serde_json::to_value(item).map_err(|error| {
            CollaborationHostError::new("conversation_control_failed", error.to_string())
        })
    }

    async fn list_conversations(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let workspace_id = required_uuid(input, &["workspaceId", "workspace_id"])?;
        let conversations = collaboration::list_workspace_conversations(&self.pool, workspace_id)
            .await
            .map_err(host_error)?;
        Ok(json!({ "conversations": conversations }))
    }

    async fn focus_conversation(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let conversation_id = required_uuid(input, &["conversationId", "conversation_id"])?;
        let located = sqlx::query_as::<_, (Uuid, Uuid)>(
            r#"SELECT s.workspace_id, w.project_id
               FROM sessions s
               JOIN workspaces w ON w.id = s.workspace_id
               WHERE s.id = ? AND s.deleted_at IS NULL
               LIMIT 1"#,
        )
        .bind(conversation_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|error| {
            CollaborationHostError::new("conversation_control_failed", error.to_string())
        })?;
        let Some((workspace_id, project_id)) = located else {
            return Err(CollaborationHostError::new(
                "not_found",
                "conversation was not found",
            ));
        };
        let Some(window_label) = optional_text(input, &["windowLabel", "window_label"]) else {
            return Err(CollaborationHostError::new(
                "conversation_control_failed",
                "window_label is required",
            ));
        };
        self.events.emit(
            "workspace-focus-conversation",
            json!({
                "project_id": project_id,
                "workspace_id": workspace_id,
                "conversation_id": conversation_id,
                "panel_id": SESSION_PANEL_ID,
                "window_label": window_label,
            }),
        );
        Ok(json!({ "focused": true, "panel_id": SESSION_PANEL_ID }))
    }
}

impl HostCollaborationHost {
    async fn enabled_agents(&self) -> Result<Value, CollaborationHostError> {
        let rows = sqlx::query_as::<_, (String,)>(
            r#"SELECT agent_id FROM agent_membership
               WHERE enabled = 1 AND retired = 0
               ORDER BY position ASC, agent_id ASC"#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|error| {
            CollaborationHostError::new("conversation_control_failed", error.to_string())
        })?;
        let agents: Vec<Value> = rows
            .into_iter()
            .map(|(agent_id,)| json!({ "agent_id": agent_id, "name": agent_id }))
            .collect();
        Ok(json!({ "agents": agents }))
    }

    async fn agent_controls(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let Some(runtime) = &self.runtime else {
            return Ok(json!({ "available": false }));
        };
        let raw = text(input, &["agentId", "agent_id"]);
        let Ok(agent_id) = AgentId::parse(&raw) else {
            return Ok(json!({ "available": false }));
        };
        let snapshot = match conversations::load_capability_catalog_for_session_defaults(
            &self.pool, runtime, &agent_id,
        )
        .await
        {
            Ok(snapshot) => snapshot,
            Err(_) => return Ok(json!({ "available": false })),
        };
        let modes: Vec<Value> = snapshot
            .modes
            .iter()
            .map(|mode| json!({ "id": mode.id, "label": mode.label }))
            .collect();
        let config_options: Vec<Value> = snapshot
            .config_options
            .iter()
            .filter(|option| !option.choices.is_empty())
            .map(|option| {
                json!({
                    "key": option.key,
                    "label": option.label,
                    "choices": option.choices.iter().map(|choice| json!({
                        "value": choice.value,
                        "label": choice.label,
                    })).collect::<Vec<_>>(),
                })
            })
            .collect();
        if modes.is_empty() && config_options.is_empty() {
            return Ok(json!({ "available": false }));
        }
        Ok(json!({
            "available": true,
            "modes": modes,
            "config_options": config_options,
        }))
    }
}

fn host_error(error: collaboration::CollaborationError) -> CollaborationHostError {
    CollaborationHostError::new(stable_code(error.code), error.message)
}

fn stable_code(code: &str) -> &'static str {
    match code {
        "not_found" => "not_found",
        "out_of_scope" => "out_of_scope",
        "steer_unsupported" => "steer_unsupported",
        "steer_no_active_turn" => "steer_no_active_turn",
        "steer_conflict" => "steer_conflict",
        "delay_exceeds_cap" => "delay_exceeds_cap",
        "nickname_taken" => "nickname_taken",
        "not_a_member" => "not_a_member",
        "limit_exceeded" => "limit_exceeded",
        "conversation_missing_agent" => "conversation_missing_agent",
        _ => "conversation_control_failed",
    }
}

fn text(input: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| input.get(*key).and_then(Value::as_str))
        .unwrap_or("")
        .trim()
        .to_string()
}

fn parse_fact_scope(raw: &str) -> Result<member_memory::FactScope, CollaborationHostError> {
    member_memory::FactScope::parse(raw).map_err(host_error)
}

fn fact_id(input: &Value) -> Result<i64, CollaborationHostError> {
    ["factId", "fact_id", "id"]
        .iter()
        .find_map(|key| input.get(*key).and_then(Value::as_i64))
        .ok_or_else(|| CollaborationHostError::new("conversation_control_failed", "factId is required"))
}

fn optional_text(input: &Value, keys: &[&str]) -> Option<String> {
    let value = text(input, keys);
    (!value.is_empty()).then_some(value)
}

fn required_text(input: &Value, keys: &[&str]) -> Result<String, CollaborationHostError> {
    let value = text(input, keys);
    if value.is_empty() {
        return Err(CollaborationHostError::new(
            "not_found",
            format!("{} is required", keys[0]),
        ));
    }
    Ok(value)
}

fn required_uuid(input: &Value, keys: &[&str]) -> Result<Uuid, CollaborationHostError> {
    let raw = text(input, keys);
    Uuid::parse_str(&raw)
        .map_err(|_| CollaborationHostError::new("not_found", format!("{} is required", keys[0])))
}

fn truthy(input: &Value, keys: &[&str]) -> bool {
    keys.iter().any(|key| match input.get(*key) {
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(value)) => value.as_i64().is_some_and(|value| value != 0),
        Some(Value::String(value)) => value == "true" || value == "1",
        _ => false,
    })
}

async fn latest_since(
    pool: &SqlitePool,
    space_id: &str,
    limit: i64,
) -> Result<i64, CollaborationHostError> {
    let max_seq: Option<i64> =
        sqlx::query_scalar("SELECT MAX(seq) FROM collaboration_space_messages WHERE space_id = ?")
            .bind(space_id)
            .fetch_one(pool)
            .await
            .map_err(|error| {
                CollaborationHostError::new("conversation_control_failed", error.to_string())
            })?;
    let max_seq = max_seq.unwrap_or(0);
    let window = limit.clamp(1, 200);
    Ok(max_seq.saturating_sub(window))
}

fn string_list(input: &Value, keys: &[&str]) -> Vec<String> {
    keys.iter()
        .find_map(|key| input.get(*key).and_then(Value::as_array))
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use db::models::session::{CreateSession, Session};
    use plugins::CollaborationHost;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::*;
    use crate::host::events::COLLABORATION_SPACE_CHANGED_EVENT;

    async fn setup_pool() -> SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .unwrap()
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::migrate!("../../crates/db/migrations")
            .run(&pool)
            .await
            .unwrap();
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    async fn create_session(pool: &SqlitePool, id: Uuid, workspace: Uuid, title: &str) {
        sqlx::query(
            "INSERT OR IGNORE INTO workspaces (id, project_id, task_id, branch, name)
             VALUES (?, ?, ?, 'main', 'ws')",
        )
        .bind(workspace)
        .bind(Uuid::new_v4())
        .bind(Uuid::new_v4())
        .execute(pool)
        .await
        .unwrap();
        Session::create(
            pool,
            &CreateSession {
                executor: None,
                agent_id: Some(AgentId::parse("codex").unwrap()),
                task_id: None,
                name: Some(title.to_string()),
                initial_prompt: None,
                status: None,
            },
            id,
            workspace,
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn host_member_memory_view_edit_delete_round_trip() {
        use conversations::member_memory::{self as memory, FactScope, FirstSentencesSummarizer};
        let pool = setup_pool().await;
        let host = HostCollaborationHost::new(pool.clone(), Arc::new(HostEventBus::new()));
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        create_session(&pool, a, workspace, "小A").await;
        let space = host
            .call("host", "collaboration", "space.create",
                json!({ "workspaceId": workspace, "name": "群1", "operationId": Uuid::new_v4() }))
            .await
            .unwrap();
        let space_id = space["space_id"].as_str().unwrap().to_string();
        host.call("host", "collaboration", "space.addMember",
            json!({ "spaceId": space_id, "conversationId": a, "nickname": "小A", "operationId": Uuid::new_v4() }))
            .await
            .unwrap();
        let member = db::models::collaboration_identity::member_id_for_conversation(a);
        memory::record_activity(&pool, a, Some(Uuid::new_v4()), "修好了分页。", &FirstSentencesSummarizer)
            .await
            .unwrap();
        let global = memory::create_fact(&pool, &member, "统一用 pnpm", &FactScope::Global, None, "agent")
            .await
            .unwrap();
        memory::create_fact(&pool, &member, "用户生日五月一日", &FactScope::Private, None, "agent")
            .await
            .unwrap();

        let listed = host
            .call("host", "collaboration", "member.memory.list", json!({ "memberId": member }))
            .await
            .unwrap();
        assert_eq!(listed["facts"].as_array().unwrap().len(), 2, "user view includes private");
        let only_private = host
            .call("host", "collaboration", "member.memory.list",
                json!({ "memberId": member, "scope": "private" }))
            .await
            .unwrap();
        assert_eq!(only_private["facts"].as_array().unwrap().len(), 1);
        let activity = host
            .call("host", "collaboration", "member.activity.list", json!({ "memberId": member }))
            .await
            .unwrap();
        assert_eq!(activity["activity"][0]["summary"], json!("修好了分页。"));

        let updated = host
            .call("host", "collaboration", "member.memory.update",
                json!({ "memberId": member, "factId": global.id, "content": "统一用 pnpm 9", "scope": format!("thread:{space_id}") }))
            .await
            .unwrap();
        assert_eq!(updated["fact"]["content"], json!("统一用 pnpm 9"));
        assert_eq!(updated["fact"]["scope"], json!(format!("thread:{space_id}")));
        assert!(host
            .call("host", "collaboration", "member.memory.update",
                json!({ "memberId": member, "factId": global.id, "scope": "bogus" }))
            .await
            .is_err());
        let deleted = host
            .call("host", "collaboration", "member.memory.delete",
                json!({ "memberId": member, "factId": global.id }))
            .await
            .unwrap();
        assert_eq!(deleted["deleted"], json!(true));
        let again = host
            .call("host", "collaboration", "member.memory.delete",
                json!({ "memberId": member, "factId": global.id }))
            .await
            .unwrap();
        assert_eq!(again["deleted"], json!(false));
        let left = host
            .call("host", "collaboration", "member.memory.list", json!({ "memberId": member }))
            .await
            .unwrap();
        assert_eq!(left["facts"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn host_cards_ask_and_approval_round_trip() {
        use conversations::collaboration_cards::{self as cards, CardKind, PostCard};
        let pool = setup_pool().await;
        let host = HostCollaborationHost::new(pool.clone(), Arc::new(HostEventBus::new()));
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        create_session(&pool, a, workspace, "小A").await;
        let space = host
            .call("host", "collaboration", "space.create",
                json!({ "workspaceId": workspace, "name": "群1", "operationId": Uuid::new_v4() }))
            .await
            .unwrap();
        let space_id = space["space_id"].as_str().unwrap().to_string();
        host.call("host", "collaboration", "space.addMember",
            json!({ "spaceId": space_id, "conversationId": a, "nickname": "小A", "operationId": Uuid::new_v4() }))
            .await
            .unwrap();
        let delivery = DeliveryContext::default();
        let op = Uuid::new_v4();
        let ask = cards::post_card(&pool, PostCard { caller_id: a, space_id: space_id.clone(), kind: CardKind::Ask,
            payload: json!({ "question": "用哪个分支？", "options": ["main", "dev"] }), operation_id: op }, &delivery)
            .await
            .unwrap();
        let again = cards::post_card(&pool, PostCard { caller_id: a, space_id: space_id.clone(), kind: CardKind::Ask,
            payload: json!({ "question": "用哪个分支？" }), operation_id: op }, &delivery)
            .await
            .unwrap();
        assert_eq!(ask.id, again.id, "idempotent per operation id");
        let approval = cards::post_card(&pool, PostCard { caller_id: a, space_id: space_id.clone(), kind: CardKind::Approval,
            payload: json!({ "action": "run", "command": "rm -rf dist", "reason": "clean" }), operation_id: Uuid::new_v4() }, &delivery)
            .await
            .unwrap();
        let pending = host
            .call("host", "collaboration", "card.list", json!({ "threadId": space_id, "pendingOnly": true }))
            .await
            .unwrap();
        assert_eq!(pending["cards"].as_array().unwrap().len(), 2);
        assert!(host.call("host", "collaboration", "card.resolve", json!({ "cardId": ask.id })).await.is_err(),
            "ask needs an answer");
        let resolved = host
            .call("host", "collaboration", "card.resolve", json!({ "cardId": ask.id, "answer": "dev" }))
            .await
            .unwrap();
        assert_eq!(resolved["card"]["status"], json!("resolved"));
        assert!(resolved["card"]["reply_message_id"].is_string() || resolved["card"]["replyMessageId"].is_string());
        assert!(host.call("host", "collaboration", "card.resolve", json!({ "cardId": ask.id, "answer": "x" })).await.is_err(),
            "double resolve rejected");
        assert!(host.call("host", "collaboration", "card.resolve", json!({ "cardId": approval.id, "decision": "maybe" })).await.is_err());
        host.call("host", "collaboration", "card.resolve", json!({ "cardId": approval.id, "decision": "deny" }))
            .await
            .unwrap();
        let pending = host
            .call("host", "collaboration", "card.list", json!({ "threadId": space_id, "pendingOnly": true }))
            .await
            .unwrap();
        assert!(pending["cards"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn host_collaboration_set_identity_and_space_events_round_trip() {
        let pool = setup_pool().await;
        let events = Arc::new(HostEventBus::new());
        let mut rx = events.subscribe();
        let host = HostCollaborationHost::new(pool.clone(), events);

        let workspace = Uuid::new_v4();
        let other_workspace = Uuid::new_v4();
        let member_a = Uuid::new_v4();
        let member_b = Uuid::new_v4();
        let outsider = Uuid::new_v4();
        let foreign = Uuid::new_v4();
        create_session(&pool, member_a, workspace, "小A").await;
        create_session(&pool, member_b, workspace, "小B").await;
        create_session(&pool, outsider, workspace, "路人").await;
        create_session(&pool, foreign, other_workspace, "外区").await;

        let created = host
            .call(
                "host",
                "collaboration",
                "space.create",
                json!({
                    "workspaceId": workspace,
                    "name": "主空间",
                    "operationId": Uuid::new_v4(),
                }),
            )
            .await
            .unwrap();
        let space_id = created["space_id"].as_str().unwrap().to_string();
        let create_event = rx.try_recv().unwrap();
        assert_eq!(create_event.channel, COLLABORATION_SPACE_CHANGED_EVENT);
        assert_eq!(create_event.payload["workspaceId"], json!(workspace));
        assert_eq!(create_event.payload["spaceId"], json!(space_id));

        let listed = host
            .call(
                "host",
                "collaboration",
                "space.list",
                json!({ "workspaceId": workspace }),
            )
            .await
            .unwrap();
        assert_eq!(listed["spaces"][0]["space_id"], json!(space_id));
        assert_eq!(listed["spaces"][0]["name"], json!("主空间"));

        let added_a = host
            .call(
                "host",
                "collaboration",
                "space.addMember",
                json!({
                    "spaceId": space_id,
                    "conversationId": member_a,
                    "nickname": "小A",
                    "operationId": Uuid::new_v4(),
                }),
            )
            .await
            .unwrap();
        let join_event = rx.try_recv().unwrap();
        assert_eq!(join_event.channel, COLLABORATION_SPACE_CHANGED_EVENT);
        assert_eq!(join_event.payload["workspaceId"], json!(workspace));
        assert_eq!(join_event.payload["spaceId"], json!(space_id));
        assert_eq!(join_event.payload["memberId"], added_a["member_id"]);
        assert!(join_event.payload.get("seq").is_none() || join_event.payload["seq"].is_null());

        host.call(
            "host",
            "collaboration",
            "space.add_member",
            json!({
                "space_id": space_id,
                "conversation_id": member_b,
                "nickname": "小B",
                "operation_id": Uuid::new_v4(),
            }),
        )
        .await
        .unwrap();
        let _ = rx.try_recv().unwrap();

        let rename_op = Uuid::new_v4();
        let renamed = host
            .call(
                "host",
                "collaboration",
                "space.setIdentity",
                json!({
                    "spaceId": space_id,
                    "conversationId": member_b,
                    "nickname": "评审B",
                    "operationId": rename_op,
                }),
            )
            .await
            .unwrap();
        assert_eq!(renamed["nickname"], "评审B");
        let rename_event = rx.try_recv().unwrap();
        assert_eq!(rename_event.channel, COLLABORATION_SPACE_CHANGED_EVENT);
        assert_eq!(rename_event.payload["workspaceId"], json!(workspace));
        assert_eq!(rename_event.payload["spaceId"], json!(space_id));
        assert_eq!(rename_event.payload["memberId"], renamed["member_id"]);

        let replay = host
            .call(
                "host",
                "collaboration",
                "space.set_identity",
                json!({
                    "space_id": space_id,
                    "conversation_id": member_b,
                    "nickname": "评审B",
                    "operation_id": rename_op,
                }),
            )
            .await
            .unwrap();
        assert_eq!(replay, renamed);
        let _ = rx.try_recv().unwrap();

        let conflict = host
            .call(
                "host",
                "collaboration",
                "space.setIdentity",
                json!({
                    "spaceId": space_id,
                    "conversationId": member_b,
                    "nickname": "小A",
                    "operationId": Uuid::new_v4(),
                }),
            )
            .await
            .unwrap_err();
        assert_eq!(conflict.code(), "nickname_taken");

        let outside = host
            .call(
                "host",
                "collaboration",
                "space.setIdentity",
                json!({
                    "spaceId": space_id,
                    "conversationId": outsider,
                    "nickname": "路人甲",
                    "operationId": Uuid::new_v4(),
                }),
            )
            .await
            .unwrap_err();
        assert_eq!(outside.code(), "not_found");

        let wrong_ws = host
            .call(
                "host",
                "collaboration",
                "space.setIdentity",
                json!({
                    "spaceId": space_id,
                    "conversationId": foreign,
                    "nickname": "外区甲",
                    "operationId": Uuid::new_v4(),
                }),
            )
            .await
            .unwrap_err();
        assert_eq!(wrong_ws.code(), "not_found");

        let post_op = Uuid::new_v4();
        let posted = host
            .call(
                "host",
                "collaboration",
                "space.post",
                json!({
                    "spaceId": space_id,
                    "content": "@评审B 请检查迁移",
                    "to": ["评审B"],
                    "operationId": post_op,
                }),
            )
            .await
            .unwrap();
        assert_eq!(posted["seq"], 1);
        assert_eq!(posted["receipts"][0]["nickname"], "评审B");

        let post_event = rx.try_recv().unwrap();
        assert_eq!(post_event.channel, COLLABORATION_SPACE_CHANGED_EVENT);
        assert_eq!(post_event.payload["workspaceId"], json!(workspace));
        assert_eq!(post_event.payload["spaceId"], json!(space_id));
        assert_eq!(post_event.payload["seq"], json!(1));
        assert!(post_event.payload.get("content").is_none());

        let post_replay = host
            .call(
                "host",
                "collaboration",
                "space.post",
                json!({
                    "spaceId": space_id,
                    "content": "@评审B 请检查迁移",
                    "to": ["评审B"],
                    "operationId": post_op,
                }),
            )
            .await
            .unwrap();
        assert_eq!(post_replay["message_id"], posted["message_id"]);
        assert_eq!(post_replay["seq"], posted["seq"]);
    }

    #[tokio::test]
    async fn host_list_messages_carries_id_origin_and_in_reply_to() {
        let pool = setup_pool().await;
        let host = HostCollaborationHost::new(pool.clone(), Arc::new(HostEventBus::new()));
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        create_session(&pool, a, workspace, "小A").await;
        let space = host
            .call(
                "host",
                "collaboration",
                "space.create",
                json!({ "workspaceId": workspace, "name": "群1", "operationId": Uuid::new_v4() }),
            )
            .await
            .unwrap();
        let space_id = space["space_id"].as_str().unwrap().to_string();
        host.call(
            "host",
            "collaboration",
            "space.addMember",
            json!({ "spaceId": space_id, "conversationId": a, "nickname": "小A", "operationId": Uuid::new_v4() }),
        )
        .await
        .unwrap();
        let first = host
            .call(
                "host",
                "collaboration",
                "space.post",
                json!({ "spaceId": space_id, "content": "@小A 看下", "to": ["小A"], "operationId": Uuid::new_v4() }),
            )
            .await
            .unwrap();
        let first_id = first["message_id"].as_str().unwrap().to_string();
        let second = host
            .call(
                "host",
                "collaboration",
                "space.post",
                json!({
                    "spaceId": space_id,
                    "content": "@小A 补充",
                    "to": ["小A"],
                    "inReplyTo": format!("vibex://space-message/{first_id}"),
                    "operationId": Uuid::new_v4(),
                }),
            )
            .await
            .unwrap();
        let listed = host
            .call(
                "host",
                "collaboration",
                "space.listMessages",
                json!({ "spaceId": space_id }),
            )
            .await
            .unwrap();
        let messages = listed["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["id"], json!(first_id));
        assert_eq!(messages[0]["origin"], json!("user"));
        assert!(messages[0].get("in_reply_to").is_none());
        assert_eq!(messages[1]["id"], second["message_id"]);
        assert_eq!(messages[1]["in_reply_to"], json!(first_id), "URI reduced to bare id");
    }

    #[tokio::test]
    async fn host_collaboration_create_member_and_move_between_spaces_and_unassigned() {
        let pool = setup_pool().await;
        let events = Arc::new(HostEventBus::new());
        let host = HostCollaborationHost::new(pool.clone(), events);

        let workspace = Uuid::new_v4();
        let seed_session = Uuid::new_v4();
        create_session(&pool, seed_session, workspace, "种子会话").await;

        let unassigned_id = format!("unassigned:{workspace}");
        let created_member = host
            .call(
                "host",
                "collaboration",
                "space.createMember",
                json!({
                    "workspaceId": workspace,
                    "nickname": "Alex",
                    "agentId": "codex",
                    "personaPrompt": "负责前端评审",
                    "operationId": Uuid::new_v4(),
                }),
            )
            .await
            .unwrap();
        assert_eq!(created_member["nickname"], "Alex");
        let member_conv_id =
            Uuid::parse_str(created_member["conversation_id"].as_str().unwrap()).unwrap();

        let unassigned_members = host
            .call(
                "host",
                "collaboration",
                "space.listMembers",
                json!({ "spaceId": unassigned_id }),
            )
            .await
            .unwrap();
        assert_eq!(unassigned_members["members"].as_array().unwrap().len(), 1);
        assert_eq!(unassigned_members["members"][0]["nickname"], "Alex");

        let space_a = host
            .call(
                "host",
                "collaboration",
                "space.create",
                json!({
                    "workspaceId": workspace,
                    "name": "前端组",
                    "operationId": Uuid::new_v4(),
                }),
            )
            .await
            .unwrap()["space_id"]
            .as_str()
            .unwrap()
            .to_string();

        let moved_to_space = host
            .call(
                "host",
                "collaboration",
                "space.moveMember",
                json!({
                    "fromSpaceId": unassigned_id,
                    "toSpaceId": space_a,
                    "conversationId": member_conv_id,
                    "operationId": Uuid::new_v4(),
                }),
            )
            .await
            .unwrap();
        assert_eq!(moved_to_space["nickname"], "Alex");

        let unassigned_after = host
            .call(
                "host",
                "collaboration",
                "space.listMembers",
                json!({ "spaceId": unassigned_id }),
            )
            .await
            .unwrap();
        assert!(unassigned_after["members"].as_array().unwrap().is_empty());

        let space_a_members = host
            .call(
                "host",
                "collaboration",
                "space.listMembers",
                json!({ "spaceId": space_a }),
            )
            .await
            .unwrap();
        assert_eq!(space_a_members["members"].as_array().unwrap().len(), 1);

        let moved_back = host
            .call(
                "host",
                "collaboration",
                "space.moveMember",
                json!({
                    "fromSpaceId": space_a,
                    "toSpaceId": unassigned_id,
                    "conversationId": member_conv_id,
                    "operationId": Uuid::new_v4(),
                }),
            )
            .await
            .unwrap();
        assert_eq!(moved_back["nickname"], "Alex");
    }

    #[tokio::test]
    async fn host_collaboration_batch_delete_moves_unselected_members_to_unassigned_and_archives_selected()
     {
        let pool = setup_pool().await;
        let events = Arc::new(HostEventBus::new());
        let host = HostCollaborationHost::new(pool.clone(), events);

        let workspace = Uuid::new_v4();
        let conv_keep = Uuid::new_v4();
        let conv_archive = Uuid::new_v4();
        create_session(&pool, conv_keep, workspace, "保留成员会话").await;
        create_session(&pool, conv_archive, workspace, "归档成员会话").await;

        let space_a = host
            .call(
                "host",
                "collaboration",
                "space.create",
                json!({
                    "workspaceId": workspace,
                    "name": "待删空间",
                    "operationId": Uuid::new_v4(),
                }),
            )
            .await
            .unwrap()["space_id"]
            .as_str()
            .unwrap()
            .to_string();

        host.call(
            "host",
            "collaboration",
            "space.addMember",
            json!({
                "spaceId": space_a,
                "conversationId": conv_keep,
                "nickname": "KeepBot",
                "operationId": Uuid::new_v4(),
            }),
        )
        .await
        .unwrap();
        host.call(
            "host",
            "collaboration",
            "space.addMember",
            json!({
                "spaceId": space_a,
                "conversationId": conv_archive,
                "nickname": "ArchiveBot",
                "operationId": Uuid::new_v4(),
            }),
        )
        .await
        .unwrap();

        let delete_res = host
            .call(
                "host",
                "collaboration",
                "space.batchDelete",
                json!({
                    "workspaceId": workspace,
                    "spaceIds": [space_a],
                    "memberTargets": [{
                        "spaceId": space_a,
                        "conversationId": conv_archive,
                    }],
                    "operationId": Uuid::new_v4(),
                }),
            )
            .await
            .unwrap();
        assert_eq!(delete_res["deleted_space_ids"].as_array().unwrap().len(), 1);
        assert_eq!(
            delete_res["archived_conversation_ids"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            delete_res["unassigned_conversation_ids"]
                .as_array()
                .unwrap()
                .len(),
            1
        );

        let spaces_after = host
            .call(
                "host",
                "collaboration",
                "space.list",
                json!({ "workspaceId": workspace }),
            )
            .await
            .unwrap();
        assert!(spaces_after["spaces"].as_array().unwrap().is_empty());

        let unassigned_id = format!("unassigned:{workspace}");
        let unassigned_members = host
            .call(
                "host",
                "collaboration",
                "space.listMembers",
                json!({ "spaceId": unassigned_id }),
            )
            .await
            .unwrap();
        let members_arr = unassigned_members["members"].as_array().unwrap();
        assert_eq!(members_arr.len(), 1);
        assert_eq!(members_arr[0]["nickname"], "KeepBot");

        let archived_status: String =
            sqlx::query_scalar("SELECT status FROM sessions WHERE id = ?")
                .bind(conv_archive)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(archived_status, "archived");
    }
}
