//! Plugin `host.call` for collaboration records and workspace navigation.
//!
//! The plugin id is never a branch. UI writes that have no agent caller
//! (create a space, add a member, post as the user) stay on this seam.
//! Agent MCP keeps its own membership checks.

use std::sync::Arc;

use agents::{
    AgentElicitationId, AgentElicitationResponse, AgentEvent, AgentId, AgentPermissionId,
    AgentPermissionResponse, AgentSessionId,
    runtime::{AgentRuntime, RespondAgentElicitationInput},
};
use async_trait::async_trait;
use conversations::{
    collaboration::{
        self, CollaborationSpaceChangedEvent, DeliveryContext, MessageAudience, SaveRole, SaveTeam,
    },
    collaboration_sidebar as sidebar, member_memory,
};
use delegation::InMemoryCompanionFeatures;
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
    companion: std::sync::Mutex<Option<Arc<InMemoryCompanionFeatures>>>,
    warmup: std::sync::Mutex<Option<Arc<dyn collaboration::SessionProcessWarmup>>>,
    hot_groups: std::sync::Mutex<Option<Arc<collaboration::HotGroupTracker>>>,
}

impl HostCollaborationHost {
    pub fn new(pool: SqlitePool, events: Arc<HostEventBus>) -> Self {
        Self {
            pool,
            events,
            runtime: None,
            delivery: std::sync::Mutex::new(DeliveryContext::default()),
            companion: std::sync::Mutex::new(None),
            warmup: std::sync::Mutex::new(None),
            hot_groups: std::sync::Mutex::new(None),
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

    pub fn install_companion_memory(&self, memory: Arc<InMemoryCompanionFeatures>) {
        *self.companion.lock().expect("companion") = Some(memory);
    }

    pub fn with_session_warmup(self, warmup: Arc<dyn collaboration::SessionProcessWarmup>) -> Self {
        self.install_session_warmup(warmup);
        self
    }

    pub fn install_session_warmup(&self, warmup: Arc<dyn collaboration::SessionProcessWarmup>) {
        *self.warmup.lock().expect("warmup") = Some(warmup);
    }

    pub fn with_hot_groups(self, tracker: Arc<collaboration::HotGroupTracker>) -> Self {
        self.install_hot_groups(tracker);
        self
    }

    pub fn install_hot_groups(&self, tracker: Arc<collaboration::HotGroupTracker>) {
        *self.hot_groups.lock().expect("hot groups") = Some(tracker);
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
            ("collaboration", "space.react") => self.react(&input).await,
            ("collaboration", "space.submit") => self.submit(&input).await,
            ("collaboration", "card.list" | "card.list_cards") => self.list_cards(&input).await,
            ("collaboration", "card.resolve") => self.resolve_card(&input).await,
            ("collaboration", "member.memory.list" | "member.memory_list") => {
                self.space_memory_op("list", &input).await
            }
            (
                "collaboration",
                "member.memory.update"
                | "member.memory_update"
                | "space.memory.update"
                | "space.memory_update",
            ) => self.space_memory_op("update", &input).await,
            (
                "collaboration",
                "member.memory.delete"
                | "member.memory_delete"
                | "space.memory.delete"
                | "space.memory_delete",
            ) => self.space_memory_op("delete", &input).await,
            ("collaboration", "member.activity.list" | "member.activity_list") => {
                self.space_memory_op("activity_list", &input).await
            }
            (
                "collaboration",
                "space.memory.view" | "space.memory_view" | "member.memory.view"
                | "member.memory_view",
            ) => self.space_memory_op("view", &input).await,
            (
                "collaboration",
                "space.memory.add"
                | "space.memory_add"
                | "member.memory.add"
                | "member.memory_add"
                | "member.memory.create"
                | "member.memory_create",
            ) => self.space_memory_op("add", &input).await,
            (
                "collaboration",
                "space.memory.writeTopic" | "space.memory.write_topic" | "space.memory_write_topic",
            ) => self.space_memory_op("write_topic", &input).await,
            (
                "collaboration",
                "space.memory.readTopic" | "space.memory.read_topic" | "space.memory_read_topic",
            ) => self.space_memory_op("read_topic", &input).await,
            (
                "collaboration",
                "space.memory.deleteTopic"
                | "space.memory.delete_topic"
                | "space.memory_delete_topic",
            ) => self.space_memory_op("delete_topic", &input).await,
            (
                "collaboration",
                "space.memory.toggleCollectionIndex"
                | "space.memory.toggle_collection_index"
                | "space.memory_toggle_collection_index",
            ) => {
                self.space_memory_op("toggle_collection_index", &input)
                    .await
            }
            (
                "collaboration",
                "space.memory.ask" | "space.memory_ask" | "member.memory.ask" | "member.memory_ask",
            ) => self.space_memory_op("ask", &input).await,
            (
                "collaboration",
                "space.memory.distillMessage"
                | "space.memory.distill_message"
                | "space.memory_distill_message",
            ) => self.space_memory_op("distill_message", &input).await,
            ("collaboration", "member.config.get" | "member.config_get") => {
                let member_id = required_text(&input, &["memberId", "member_id"])?;
                let config = collaboration::load_member_session_config(&self.pool, &member_id)
                    .await
                    .map_err(host_error)?;
                Ok(json!({ "memberId": member_id, "config": config }))
            }
            ("collaboration", "member.config.update" | "member.config_update") => {
                let member_id = required_text(&input, &["memberId", "member_id"])?;
                let config = collaboration::set_member_session_config(
                    &self.pool,
                    &member_id,
                    collaboration::MemberSessionConfig {
                        agent_id: optional_text(&input, &["agentId", "agent_id"]),
                        mode_id: optional_text(&input, &["modeId", "mode_id"]),
                        config_values: input
                            .get("configValues")
                            .or_else(|| input.get("config_values"))
                            .cloned()
                            .unwrap_or_else(|| json!({})),
                        persona_prompt: optional_text(&input, &["personaPrompt", "persona_prompt"]),
                    },
                )
                .await
                .map_err(host_error)?;
                Ok(json!({ "memberId": member_id, "config": config }))
            }
            ("collaboration", "member.session.resolve" | "member.resolve_session") => {
                let member_id = required_text(&input, &["memberId", "member_id"])?;
                let thread_id = required_text(&input, &["threadId", "thread_id"])?;
                let conversation_id =
                    collaboration::resolve_thread_session(&self.pool, &member_id, &thread_id)
                        .await
                        .map_err(host_error)?;
                Ok(json!({
                    "memberId": member_id,
                    "threadId": thread_id,
                    "conversationId": conversation_id,
                }))
            }
            ("collaboration", "contactGroup.list" | "contact_group.list") => {
                self.sidebar_op("contactGroup.list", &input).await
            }
            ("collaboration", "contactGroup.create" | "contact_group.create") => {
                self.sidebar_op("contactGroup.create", &input).await
            }
            ("collaboration", "contactGroup.rename" | "contact_group.rename") => {
                self.sidebar_op("contactGroup.rename", &input).await
            }
            ("collaboration", "contactGroup.delete" | "contact_group.delete") => {
                self.sidebar_op("contactGroup.delete", &input).await
            }
            ("collaboration", "contactGroup.reorder" | "contact_group.reorder") => {
                self.sidebar_op("contactGroup.reorder", &input).await
            }
            ("collaboration", "thread.setGroup" | "thread.set_group") => {
                self.sidebar_op("thread.setGroup", &input).await
            }
            ("collaboration", "thread.listSidebar" | "thread.list_sidebar" | "sidebar.list") => {
                self.sidebar_op("thread.listSidebar", &input).await
            }
            ("collaboration", "thread.markRead" | "thread.mark_read") => {
                self.sidebar_op("thread.markRead", &input).await
            }
            ("collaboration", "thread.markUnread" | "thread.mark_unread") => {
                self.sidebar_op("thread.markUnread", &input).await
            }
            ("collaboration", "thread.update" | "space.setTagColor" | "space.set_tag_color") => {
                self.sidebar_op("thread.update", &input).await
            }
            ("collaboration", "member.list") => self.sidebar_op("member.list", &input).await,
            ("collaboration", "member.update") => {
                let member_id = required_text(&input, &["memberId", "member_id"])?;
                let field = |key: &str| {
                    input.get(key).map(|v| match v {
                        Value::String(s) => s.clone(),
                        Value::Null => String::new(),
                        other => other.to_string(),
                    })
                };
                sidebar::update_member_profile(
                    &self.pool,
                    &member_id,
                    field("name").as_deref(),
                    field("avatar").as_deref(),
                    field("color").as_deref(),
                )
                .await
                .map_err(host_error)?;
                self.emit_space_changed(&format!("direct:{member_id}"), Some(&member_id))
                    .await;
                let group_threads: Vec<String> = sqlx::query_scalar(
                    r#"SELECT DISTINCT thread_id
                       FROM collaboration_thread_members
                       WHERE member_id = ? AND status = 'active' AND thread_id NOT LIKE 'direct:%'"#,
                )
                .bind(&member_id)
                .fetch_all(&self.pool)
                .await
                .unwrap_or_default();
                for tid in group_threads {
                    self.emit_space_changed(&tid, Some(&member_id)).await;
                }
                Ok(json!({ "memberId": member_id, "updated": true }))
            }
            ("collaboration", "member.setWriteAccess" | "member.set_write_access") => {
                self.set_write_access(&input).await
            }
            (
                "collaboration",
                "member.setSupervisor"
                | "member.set_supervisor"
                | "space.setSupervisor"
                | "space.set_supervisor",
            ) => self.set_supervisor(&input).await,
            ("collaboration", "space.listEvents" | "space.list_events") => {
                self.list_events(&input).await
            }
            ("collaboration", "space.receipts" | "space.listReceipts" | "space.list_receipts") => {
                self.receipts(&input).await
            }
            ("collaboration", "space.cancelTurn" | "space.cancel_turn") => {
                self.cancel_turn(&input).await
            }
            ("collaboration", "space.wakePreview" | "space.wake_preview") => {
                self.wake_preview(&input).await
            }
            ("collaboration", "space.warmup") => self.warmup(&input).await,
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
            (
                "collaboration",
                "space.removeCollectionItem"
                | "space.remove_collection_item"
                | "space.deleteCollectionItem"
                | "space.delete_collection_item",
            ) => self.remove_collection_item(&input).await,
            ("collaboration", "space.listConversations" | "space.list_conversations") => {
                self.list_conversations(&input).await
            }
            // Compat: the pre-redesign frontend (and stale callers) may still ask for
            // team/member templates, which no longer exist on the backend. Answer with an
            // empty list / no-op success so those screens stay parseable.
            (
                "collaboration",
                "template.list"
                | "templates.list"
                | "team.template.list"
                | "team.templates"
                | "team.listTemplates"
                | "member.template.list"
                | "member.templates",
            ) => Ok(json!({ "templates": [], "items": [] })),
            (
                "collaboration",
                "template.create"
                | "template.update"
                | "template.delete"
                | "template.apply"
                | "team.template.create"
                | "team.template.update"
                | "team.template.delete"
                | "team.template.apply"
                | "member.template.apply",
            ) => Ok(json!({ "ok": true, "noop": true })),
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
        let evt = collaboration::latest_space_changed_event(
            &self.pool,
            workspace_id,
            &space.space_id,
            None,
        )
        .await;
        self.events.emit(COLLABORATION_SPACE_CHANGED_EVENT, evt);
        serde_json::to_value(space).map_err(|error| {
            CollaborationHostError::new("conversation_control_failed", error.to_string())
        })
    }

    async fn rename_space(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let space_id = required_text(input, &["spaceId", "space_id", "id"])?;
        let name = optional_text(input, &["name"]);
        let lead_present = ["leadMemberId", "lead_member_id"]
            .iter()
            .any(|key| input.get(*key).is_some());
        if name.is_none() && !lead_present {
            required_text(input, &["name"])?;
        }
        let lead = if lead_present {
            optional_text(input, &["leadMemberId", "lead_member_id"])
        } else {
            None
        };
        let mut space = if let Some(name) = name.as_deref() {
            collaboration::rename_workspace_space(&self.pool, &space_id, name)
                .await
                .map_err(host_error)?
        } else {
            collaboration::set_space_lead(&self.pool, &space_id, lead.as_deref())
                .await
                .map_err(host_error)?
        };
        if lead_present && name.is_some() {
            space = collaboration::set_space_lead(&self.pool, &space_id, lead.as_deref())
                .await
                .map_err(host_error)?;
        }
        let evt = collaboration::latest_space_changed_event(
            &self.pool,
            space.workspace_id,
            &space.space_id,
            None,
        )
        .await;
        self.events.emit(COLLABORATION_SPACE_CHANGED_EVENT, evt);
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
        let seat_conversation_id = member
            .conversation_id
            .as_deref()
            .and_then(|raw| Uuid::parse_str(raw).ok())
            .unwrap_or(conversation_id);
        if input.get("teamId").is_some() || input.get("team_id").is_some() {
            let team_id = optional_text(input, &["teamId", "team_id"]);
            let _ = collaboration::set_conversation_persona_team(
                &self.pool,
                seat_conversation_id,
                &member.nickname,
                team_id.as_deref(),
            )
            .await
            .map_err(host_error)?;
        }
        let identity_member_id = collaboration::identity_member_id_for_conversation(
            &self.pool,
            member.conversation_id.as_deref(),
        )
        .await
        .map_err(host_error)?;
        if let Some(persona_prompt) = optional_text(input, &["personaPrompt", "persona_prompt"])
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
        {
            if let Some(ref mid) = identity_member_id {
                let existing_cfg = collaboration::load_member_session_config(&self.pool, mid)
                    .await
                    .ok()
                    .flatten();
                let _ = collaboration::set_member_session_config(
                    &self.pool,
                    mid,
                    collaboration::MemberSessionConfig {
                        agent_id: existing_cfg.as_ref().and_then(|c| c.agent_id.clone()),
                        mode_id: existing_cfg.as_ref().and_then(|c| c.mode_id.clone()),
                        config_values: existing_cfg
                            .map(|c| c.config_values)
                            .unwrap_or_else(|| json!({})),
                        persona_prompt: Some(persona_prompt),
                    },
                )
                .await;
            }
        }
        let is_supervisor = if let Some(ref mid) = identity_member_id {
            collaboration::is_member_supervisor(&self.pool, mid)
                .await
                .unwrap_or(false)
        } else {
            false
        };
        let workspace_id = collaboration::space_workspace_id(&self.pool, &space_id)
            .await
            .map_err(host_error)?;
        let evt = collaboration::latest_space_changed_event(
            &self.pool,
            workspace_id,
            &space_id,
            Some(member.member_id.clone()),
        )
        .await;
        self.events.emit(COLLABORATION_SPACE_CHANGED_EVENT, evt);
        let mut value = serde_json::to_value(member).map_err(|error| {
            CollaborationHostError::new("conversation_control_failed", error.to_string())
        })?;
        if let Some(object) = value.as_object_mut() {
            object.insert("identity_member_id".into(), json!(identity_member_id));
            object.insert("is_supervisor".into(), json!(is_supervisor));
        }
        Ok(value)
    }

    async fn create_member(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let workspace_id = required_uuid(input, &["workspaceId", "workspace_id"])?;
        // Compat: older callers may omit operationId; mint one (no replay dedupe then).
        let operation_id = match optional_text(input, &["operationId", "operation_id"]) {
            Some(_) => required_uuid(input, &["operationId", "operation_id"])?,
            None => Uuid::new_v4(),
        };
        // Member = session family: creation always yields the identity plus ONE hidden
        // direct-chat session; the requested space is ignored (join groups later via
        // space.addMember with the returned conversation_id).
        let _requested_space_id = optional_text(input, &["spaceId", "space_id"]);
        let space_id: Option<String> = None;
        let role_id = optional_text(input, &["roleId", "role_id"]);
        // Compat: without a role or an agent, fall back to the first enabled agent
        // (then `codex`) so a bare createMember still succeeds with defaults.
        let agent_id = match optional_text(input, &["agentId", "agent_id"]) {
            Some(agent) => Some(agent),
            None if role_id.is_none() => Some(self.default_member_agent().await),
            None => None,
        };
        let target_space_id = space_id
            .clone()
            .unwrap_or_else(|| collaboration::unassigned_space_id(workspace_id));
        let mut config_values = input
            .get("configValues")
            .or_else(|| input.get("config_values"))
            .cloned();
        if let Some(is_sup) = input
            .get("isSupervisor")
            .or_else(|| input.get("is_supervisor"))
            .and_then(Value::as_bool)
        {
            match &mut config_values {
                Some(Value::Object(map)) => {
                    map.insert("is_supervisor".to_string(), json!(is_sup));
                }
                _ => {
                    config_values = Some(json!({ "is_supervisor": is_sup }));
                }
            }
        }
        let member = collaboration::host_create_space_member(
            &self.pool,
            collaboration::HostCreateSpaceMember {
                workspace_id,
                space_id,
                nickname: text(input, &["nickname", "name"]),
                role_id: role_id.clone(),
                agent_id: agent_id.clone(),
                team_id: optional_text(input, &["teamId", "team_id"]),
                persona_prompt: optional_text(input, &["personaPrompt", "persona_prompt"]),
                mode_id: optional_text(input, &["modeId", "mode_id"]),
                config_values,
                operation_id,
            },
        )
        .await
        .map_err(host_error)?;
        let evt = collaboration::latest_space_changed_event(
            &self.pool,
            workspace_id,
            &target_space_id,
            Some(member.member_id.clone()),
        )
        .await;
        self.events.emit(COLLABORATION_SPACE_CHANGED_EVENT, evt);
        let mut value = serde_json::to_value(member).map_err(|error| {
            CollaborationHostError::new("conversation_control_failed", error.to_string())
        })?;
        // Compat: the pre-redesign frontend types the result as
        // `{ space_id, member_id, conversation_id, nickname }`.
        if let Some(object) = value.as_object_mut() {
            object
                .entry("space_id")
                .or_insert_with(|| json!(target_space_id));
        }
        // Member identity: expose the identity id (for `member.*`) and apply
        // optional avatar / color.
        let conversation = value
            .get("conversation_id")
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(conversation) = conversation
            && let Some(identity_id) =
                sidebar::identity_member_of_conversation(&self.pool, &conversation)
                    .await
                    .map_err(host_error)?
        {
            let avatar = optional_text(input, &["avatar"]);
            let color = optional_text(input, &["color"]);
            if avatar.is_some() || color.is_some() {
                sidebar::update_member_profile(
                    &self.pool,
                    &identity_id,
                    None,
                    avatar.as_deref(),
                    color.as_deref(),
                )
                .await
                .map_err(host_error)?;
            }
            let is_supervisor = collaboration::is_member_supervisor(&self.pool, &identity_id)
                .await
                .unwrap_or(false);
            if let Some(object) = value.as_object_mut() {
                object.insert("identity_member_id".into(), json!(identity_id));
                object.insert(
                    "direct_thread_id".into(),
                    json!(format!("direct:{identity_id}")),
                );
                object.insert("is_supervisor".into(), json!(is_supervisor));
            }
        }
        Ok(value)
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
        let from_evt = collaboration::latest_space_changed_event(
            &self.pool,
            workspace_id,
            &from_space_id,
            Some(member.member_id.clone()),
        )
        .await;
        self.events
            .emit(COLLABORATION_SPACE_CHANGED_EVENT, from_evt);
        let to_evt = collaboration::latest_space_changed_event(
            &self.pool,
            workspace_id,
            &to_space_id,
            Some(member.member_id.clone()),
        )
        .await;
        self.events.emit(COLLABORATION_SPACE_CHANGED_EVENT, to_evt);
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
                kind: None,
                generation: None,
            },
        );
        for deleted_space_id in &result.deleted_space_ids {
            let evt = collaboration::latest_space_changed_event(
                &self.pool,
                workspace_id,
                deleted_space_id,
                Some("batch_delete".to_string()),
            )
            .await;
            self.events.emit(COLLABORATION_SPACE_CHANGED_EVENT, evt);
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
        let evt = collaboration::latest_space_changed_event(
            &self.pool,
            workspace_id,
            &space_id,
            Some(member.member_id.clone()),
        )
        .await;
        self.events.emit(COLLABORATION_SPACE_CHANGED_EVENT, evt);
        serde_json::to_value(member).map_err(|error| {
            CollaborationHostError::new("conversation_control_failed", error.to_string())
        })
    }

    async fn list_members(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let space_id = required_text(input, &["spaceId", "space_id"])?;
        let members =
            collaboration::list_space_members(&self.pool, &space_id, MessageAudience::User)
                .await
                .map_err(host_error)?;
        // Seats are per-space projections; the bot identity is what owns the
        // name/avatar and is stable across DM and group seats.
        let is_group_space =
            !space_id.starts_with("unassigned:") && !space_id.starts_with("direct:");
        let mut listed = Vec::with_capacity(members.len());
        for mut member in members {
            if is_group_space
                && member.kind == "agent"
                && let Ok(resolved) =
                    collaboration::resolve_thread_session(&self.pool, &member.member_id, &space_id)
                        .await
            {
                member.conversation_id = Some(resolved.to_string());
            }
            let identity_member_id = collaboration::identity_member_id_for_conversation(
                &self.pool,
                member.conversation_id.as_deref(),
            )
            .await
            .map_err(host_error)?;
            let is_supervisor = if let Some(ref mid) = identity_member_id {
                collaboration::is_member_supervisor(&self.pool, mid)
                    .await
                    .unwrap_or(false)
            } else {
                false
            };
            let mut value = serde_json::to_value(&member).map_err(|error| {
                CollaborationHostError::new("conversation_control_failed", error.to_string())
            })?;
            if let Some(object) = value.as_object_mut() {
                object.insert("identity_member_id".into(), json!(identity_member_id));
                object.insert("is_supervisor".into(), json!(is_supervisor));
            }
            listed.push(value);
        }
        Ok(json!({ "members": listed }))
    }

    async fn list_messages(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let space_id = required_text(input, &["spaceId", "space_id"])?;
        let limit = input.get("limit").and_then(Value::as_i64);
        if space_id.starts_with("direct:") {
            return self.list_direct_messages(&space_id, input, limit).await;
        }
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
        let cards =
            conversations::collaboration_cards::list_cards(&self.pool, Some(&space_id), false)
                .await
                .unwrap_or_default();
        Ok(json!({ "messages": messages, "scheduled": scheduled, "cards": cards }))
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
        self.emit_space_changed(&space_id, None).await;
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
        self.emit_space_changed(&space_id, None).await;
        Ok(json!({ "scheduled": updated }))
    }

    /// `space.listMessages` for `direct:<id>`: the member's DM conversation,
    /// in the group message shape. `seq` = conversation event ordinal (pre-cutover)
    /// or `collaboration_space_messages.seq` (post-cutover).
    async fn list_direct_messages(
        &self,
        thread_id: &str,
        input: &Value,
        limit: Option<i64>,
    ) -> Result<Value, CollaborationHostError> {
        let (conversation, member) = sidebar::dm_conversation(&self.pool, thread_id)
            .await
            .map_err(host_error)?
            .ok_or_else(|| CollaborationHostError::new("not_found", "direct thread not found"))?;
        let since = if truthy(input, &["latest"]) {
            None
        } else {
            input
                .get("sinceSeq")
                .or_else(|| input.get("since_seq"))
                .and_then(Value::as_i64)
        };
        let messages = sidebar::list_dm_messages(&self.pool, conversation, since, limit)
            .await
            .map_err(host_error)?;
        let message_ids: Vec<String> = messages.iter().map(|m| m.id.clone()).collect();
        let receipts_by_msg = collaboration::list_message_receipts_batch(&self.pool, &message_ids)
            .await
            .unwrap_or_default();
        let mut messages = messages
            .into_iter()
            .map(|message| {
                let from_user = message.origin == "user";
                let receipts_val = if let Some(real) = receipts_by_msg.get(&message.id)
                    && !real.is_empty()
                {
                    serde_json::to_value(real).unwrap_or_else(|_| json!([]))
                } else if from_user {
                    json!([{
                        "delivered": message.delivered.as_deref().unwrap_or("dispatched"),
                    }])
                } else {
                    json!([])
                };
                let mut envelope = json!({
                    "id": message.id,
                    "sender": if from_user { "Person" } else { member.name.as_str() },
                    "to": [if from_user { member.name.as_str() } else { "Person" }],
                    "content": message.text,
                    "published": message.created_at,
                });
                if !from_user {
                    envelope["conversation_id"] = json!(member.conversation_id);
                }
                if let Some(sent) = message.cross_chat_sent_to.filter(|value| !value.is_null()) {
                    envelope["crossChatSentTo"] = sent;
                }
                if let Some(received) = message
                    .cross_chat_received_from
                    .filter(|value| !value.is_null())
                {
                    envelope["crossChatReceivedFrom"] = received;
                }
                let mut item = json!({
                    "id": message.id,
                    "seq": message.seq,
                    "origin": message.origin,
                    "in_reply_to": Value::Null,
                    "operationId": message.operation_id,
                    "operation_id": message.operation_id,
                    "receipts": receipts_val,
                    "envelope": envelope,
                });
                if let Some(turn_id) = &message.turn_id
                    && let Some(obj) = item.as_object_mut()
                {
                    obj.insert("turnId".to_string(), json!(turn_id));
                    obj.insert("turn_id".to_string(), json!(turn_id));
                }
                if let Some(streaming) = message.streaming
                    && let Some(obj) = item.as_object_mut()
                {
                    obj.insert("streaming".to_string(), json!(streaming));
                }
                item
            })
            .collect::<Vec<_>>();
        collaboration::attach_reactions_to_json_messages(&self.pool, thread_id, &mut messages)
            .await
            .map_err(host_error)?;
        let cards =
            conversations::collaboration_cards::list_cards(&self.pool, Some(thread_id), false)
                .await
                .unwrap_or_default();
        Ok(json!({
            "messages": messages,
            "scheduled": [],
            "cards": cards,
            "conversationId": member.conversation_id,
        }))
    }

    /// `space.post` / `space.submit` for `direct:<id>`: persists into
    /// `collaboration_space_messages` + `collaboration_space_deliveries`
    /// and dispatches via `deliver_pending` (same path as group chats).
    async fn post_direct(
        &self,
        thread_id: &str,
        input: &Value,
    ) -> Result<Value, CollaborationHostError> {
        let operation_id = required_uuid(input, &["operationId", "operation_id"])?;
        let delivery = self.delivery.lock().expect("delivery").clone();
        let (posted, _workspace_id, member) = collaboration::post_direct_message_with(
            &self.pool,
            collaboration::PostDirectMessage {
                thread_id: thread_id.to_string(),
                content: text(input, &["content"]),
                summary: optional_text(input, &["summary"]),
                in_reply_to: optional_text(input, &["inReplyTo", "in_reply_to"]),
                operation_id,
            },
            &delivery,
        )
        .await
        .map_err(host_error)?;

        // TODO(dm-mention): replace with cross-thread forwarding once DM space messages are the sole source of truth.
        let mention_targets: Vec<String> = string_list(input, &["to"])
            .into_iter()
            .map(|name| name.trim().trim_start_matches('@').trim().to_string())
            .filter(|name| {
                !name.is_empty()
                    && !name.eq_ignore_ascii_case("user")
                    && name != "你"
                    && name != "用户"
                    && name.as_str() != member.name
            })
            .collect();
        if !mention_targets.is_empty()
            && let Err(error) = collaboration::post_to_space_with(
                &self.pool,
                collaboration::PostToSpace {
                    caller_id: None,
                    space_id: thread_id.to_string(),
                    content: text(input, &["content"]),
                    summary: None,
                    to: mention_targets,
                    in_reply_to: None,
                    operation_id: Uuid::new_v5(&operation_id, b"dm-mention"),
                },
                &delivery,
            )
            .await
        {
            tracing::warn!(
                %error,
                thread_id = %thread_id,
                "dm-mention secondary post_to_space_with failed after direct message posted"
            );
        }

        let real_receipts = collaboration::list_message_receipts(&self.pool, &posted.message_id)
            .await
            .map_err(host_error)?;
        self.events.emit(
            COLLABORATION_RECEIPTS_CHANGED_EVENT,
            json!({ "spaceId": thread_id, "messageId": posted.message_id, "receipts": real_receipts }),
        );
        self.emit_space_changed(thread_id, Some(&member.member_id))
            .await;

        let first_delivery = posted.receipts.first();
        let turn_id = real_receipts.first().and_then(|r| r.turn_id.clone());
        Ok(json!({
            "threadId": thread_id,
            "conversationId": member.conversation_id,
            "memberId": member.member_id,
            "delivered": first_delivery.map(|r| r.delivered.as_str()).unwrap_or("queued"),
            "inputId": first_delivery.and_then(|r| r.input_id),
            "turnId": turn_id,
            "messageId": posted.message_id,
            "message_id": posted.message_id,
            "seq": posted.seq,
            "receipts": real_receipts,
            "deliveries": posted.receipts,
        }))
    }

    async fn post(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let space_id = required_text(input, &["spaceId", "space_id"])?;
        if space_id.starts_with("direct:") {
            return self.post_direct(&space_id, input).await;
        }
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
        let evt =
            collaboration::latest_space_changed_event(&self.pool, workspace_id, &space_id, None)
                .await;
        self.events.emit(COLLABORATION_SPACE_CHANGED_EVENT, evt);
        serde_json::to_value(posted).map_err(|error| {
            CollaborationHostError::new("conversation_control_failed", error.to_string())
        })
    }

    async fn react(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let space_id = required_text(input, &["spaceId", "space_id"])?;
        let message_id = required_text(input, &["messageId", "message_id", "id"])?;
        let emoji = required_text(input, &["emoji"])?;
        if let Some(actor) = optional_text(input, &["actor"])
            && !actor.eq_ignore_ascii_case(collaboration::SPACE_REACTION_USER_ACTOR)
        {
            return Err(CollaborationHostError::new(
                "permission_denied",
                "host space.react can only act as the user",
            ));
        }
        let reactions = collaboration::toggle_space_reaction(
            &self.pool,
            &space_id,
            &message_id,
            collaboration::SPACE_REACTION_USER_ACTOR,
            &emoji,
        )
        .await
        .map_err(host_error)?;
        self.emit_space_changed(&space_id, None).await;
        Ok(json!({ "reactions": reactions }))
    }

    /// User submit: post into a group thread and return the per-member
    /// receipts (`queued` / `processing` / `replied` / `passed` /
    /// `timed_out` / `cancelled`, plus projected `failed`).
    async fn submit(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let space_id = optional_text(input, &["threadId", "thread_id"])
            .map(Ok)
            .unwrap_or_else(|| required_text(input, &["spaceId", "space_id"]))?;
        let mut forwarded = input.clone();
        if let Some(object) = forwarded.as_object_mut() {
            object.insert("spaceId".to_string(), json!(space_id));
        }
        if space_id.starts_with("direct:") {
            return self.post_direct(&space_id, &forwarded).await;
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

    async fn set_supervisor(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let workspace_id = required_uuid(input, &["workspaceId", "workspace_id"])?;
        let member_ref = optional_text(
            input,
            &[
                "memberId",
                "member_id",
                "identityMemberId",
                "identity_member_id",
                "conversationId",
                "conversation_id",
            ],
        );
        let supervisor_member_id =
            sidebar::set_workspace_supervisor(&self.pool, workspace_id, member_ref.as_deref())
                .await
                .map_err(host_error)?;
        let unassigned_id = collaboration::unassigned_space_id(workspace_id);
        let evt = collaboration::latest_space_changed_event(
            &self.pool,
            workspace_id,
            &unassigned_id,
            supervisor_member_id.clone(),
        )
        .await;
        self.events.emit(COLLABORATION_SPACE_CHANGED_EVENT, evt);
        Ok(json!({
            "workspaceId": workspace_id,
            "supervisorMemberId": supervisor_member_id,
            "supervisor_member_id": supervisor_member_id,
        }))
    }

    async fn list_cards(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let space_id = optional_text(input, &["threadId", "thread_id", "spaceId", "space_id"]);
        let pending_only = input
            .get("pendingOnly")
            .or_else(|| input.get("pending_only"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let cards = conversations::collaboration_cards::list_cards(
            &self.pool,
            space_id.as_deref(),
            pending_only,
        )
        .await
        .map_err(host_error)?;
        Ok(json!({ "cards": cards }))
    }

    async fn resolve_card(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let card_id = required_text(input, &["cardId", "card_id", "id"])?;
        // Compat: `actor` is optional and defaults to the user. Host/UI calls can
        // only ever act as the user, so any other value is rejected explicitly.
        if let Some(actor) = optional_text(input, &["actor"])
            && !actor.eq_ignore_ascii_case("user")
        {
            return Err(CollaborationHostError::new(
                "permission_denied",
                "host card.resolve can only act as the user",
            ));
        }
        let delivery = self.delivery.lock().expect("delivery").clone();
        let declined = input
            .get("declined")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let answer = optional_text(input, &["answer", "note"]);
        let mut card = conversations::collaboration_cards::resolve_card(
            &self.pool,
            &card_id,
            // Host/UI calls are always the user (the human owner).
            conversations::collaboration_cards::CardActor::User,
            optional_text(input, &["decision"]).as_deref(),
            if declined {
                Some("已跳过")
            } else {
                answer.as_deref()
            },
            &delivery,
        )
        .await
        .map_err(host_error)?;
        if let Some(question_id) = card
            .payload
            .get("question_id")
            .and_then(Value::as_str)
            .map(str::to_string)
            && let Ok(from) = Uuid::parse_str(&card.from_conversation_id)
        {
            let memory = self.companion.lock().expect("companion").clone();
            match card.kind {
                conversations::collaboration_cards::CardKind::Approval => {
                    let decision = card
                        .resolution
                        .as_ref()
                        .and_then(|res| res.get("decision"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .or_else(|| optional_text(input, &["decision"]))
                        .unwrap_or_else(|| "deny".to_string());
                    let companion_answer = card
                        .resolution
                        .clone()
                        .unwrap_or_else(|| json!({ "decision": decision }));
                    let mut answered_in_memory = false;
                    if let Some(memory) = memory
                        && (memory
                            .answer_question(&question_id, from, companion_answer.clone())
                            .await
                            .is_ok()
                            || (question_id != card.id
                                && memory
                                    .answer_question(&card.id, from, companion_answer)
                                    .await
                                    .is_ok()))
                    {
                        answered_in_memory = true;
                    }
                    if let Some(runtime) = &self.runtime
                        && let Ok(permission_uuid) = Uuid::parse_str(&card.id)
                        && let Some(connection_id) =
                            runtime.live_connection_id(AgentSessionId::from(from)).await
                    {
                        let perm_response = match decision.as_str() {
                            "allow_always" => {
                                AgentPermissionResponse::selected_persist("allow_always")
                            }
                            "allow_once" => AgentPermissionResponse::selected("allow_once"),
                            _ => AgentPermissionResponse::selected("deny"),
                        };
                        runtime
                            .emit_external(
                                connection_id,
                                Some(AgentSessionId::from(from)),
                                AgentEvent::PermissionResponded {
                                    permission_id: AgentPermissionId(permission_uuid),
                                    response: perm_response,
                                    auto: false,
                                },
                            )
                            .await;
                    }
                    if !answered_in_memory {
                        let _ = conversations::collaboration_cards::deliver_card_reply(
                            &self.pool, &card.id, None, &delivery,
                        )
                        .await;
                        if let Ok(Some(reloaded)) =
                            conversations::collaboration_cards::load_card(&self.pool, &card.id)
                                .await
                        {
                            card = reloaded;
                        }
                    }
                }
                conversations::collaboration_cards::CardKind::Ask => {
                    let companion_answer = if declined {
                        json!({ "__declined": true })
                    } else if let Some(answers) = input.get("answers").cloned() {
                        answers
                    } else {
                        json!([{
                            "questionId": "question-1",
                            "labels": [answer.unwrap_or_default()],
                        }])
                    };
                    let mut answered_live = false;
                    let answered_in_memory = if let Some(memory) = memory {
                        match memory
                            .answer_question(&question_id, from, companion_answer.clone())
                            .await
                        {
                            Ok(pending) => Some(pending),
                            Err(_) if question_id != card.id => memory
                                .answer_question(&card.id, from, companion_answer.clone())
                                .await
                                .ok(),
                            Err(_) => None,
                        }
                    } else {
                        None
                    };
                    let elicitation_response =
                        elicitation_response_from_card_answer(declined, &companion_answer);
                    if let Some(pending) = answered_in_memory {
                        answered_live = true;
                        if let Some(runtime) = &self.runtime
                            && let (Ok(connection_id), Ok(elicitation_id)) = (
                                Uuid::parse_str(&pending.scope.parent_connection_id),
                                Uuid::parse_str(&pending.id),
                            )
                        {
                            runtime
                                .emit_external(
                                    agents::AgentConnectionId::from(connection_id),
                                    Some(AgentSessionId::from(from)),
                                    AgentEvent::ElicitationResponded {
                                        elicitation_id: AgentElicitationId::from(elicitation_id),
                                        response: elicitation_response.clone(),
                                    },
                                )
                                .await;
                        }
                    } else if let Some(runtime) = &self.runtime
                        && let Ok(elicitation_id) = Uuid::parse_str(&question_id)
                        && let Some(connection_id) =
                            runtime.live_connection_id(AgentSessionId::from(from)).await
                        && runtime
                            .respond_elicitation(RespondAgentElicitationInput {
                                connection_id,
                                elicitation_id: AgentElicitationId::from(elicitation_id),
                                response: elicitation_response,
                            })
                            .await
                            .is_ok()
                    {
                        answered_live = true;
                    }
                    if !answered_live {
                        let _ = conversations::collaboration_cards::deliver_card_reply(
                            &self.pool, &card.id, None, &delivery,
                        )
                        .await;
                        if let Ok(Some(reloaded)) =
                            conversations::collaboration_cards::load_card(&self.pool, &card.id)
                                .await
                        {
                            card = reloaded;
                        }
                    }
                }
            }
        }
        self.emit_space_changed(&card.space_id, card.member_id.as_deref())
            .await;
        Ok(json!({ "card": card }))
    }

    async fn sidebar_op(&self, op: &str, input: &Value) -> Result<Value, CollaborationHostError> {
        let (value, changed_space) = sidebar::execute_sidebar_op(&self.pool, op, input)
            .await
            .map_err(host_error)?;
        if let Some(space_id) = changed_space {
            self.emit_space_changed(&space_id, None).await;
        }
        Ok(value)
    }

    async fn space_memory_op(
        &self,
        op: &str,
        input: &Value,
    ) -> Result<Value, CollaborationHostError> {
        let (value, changed) = member_memory::execute_space_memory_op(&self.pool, op, input)
            .await
            .map_err(host_error)?;
        if let Some((space_id, member_id)) = changed {
            self.emit_space_changed(&space_id, member_id.as_deref())
                .await;
        }
        Ok(value)
    }

    async fn list_events(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let space_id = optional_text(input, &["threadId", "thread_id"])
            .map(Ok)
            .unwrap_or_else(|| required_text(input, &["spaceId", "space_id"]))?;
        let caller_id = optional_text(input, &["callerId", "caller_id", "conversationId"])
            .and_then(|raw| Uuid::parse_str(&raw).ok());
        let after_seq = input
            .get("afterSeq")
            .or_else(|| input.get("after_seq"))
            .and_then(Value::as_i64);
        let limit = input.get("limit").and_then(Value::as_i64);
        let res =
            collaboration::list_space_events(&self.pool, &space_id, caller_id, after_seq, limit)
                .await
                .map_err(host_error)?;
        serde_json::to_value(res).map_err(|error| {
            CollaborationHostError::new("conversation_control_failed", error.to_string())
        })
    }

    async fn receipts(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let message_id = required_text(input, &["messageId", "message_id"])?;
        let receipts = collaboration::list_message_receipts(&self.pool, &message_id)
            .await
            .map_err(host_error)?;
        Ok(json!({ "messageId": message_id, "receipts": receipts }))
    }

    async fn cancel_turn(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let space_id = required_text(input, &["spaceId", "space_id"])?;
        let message_id = optional_text(input, &["messageId", "message_id"]);
        let turn_id = optional_text(input, &["turnId", "turn_id"]);
        let caller_id = optional_text(input, &["callerId", "caller_id", "conversationId"])
            .and_then(|raw| Uuid::parse_str(&raw).ok());
        let delivery = self.delivery.lock().expect("delivery").clone();
        let cancelled = collaboration::cancel_space_turn_with(
            &self.pool,
            &space_id,
            message_id.as_deref(),
            turn_id.as_deref(),
            caller_id,
            &delivery,
        )
        .await
        .map_err(host_error)?;
        self.emit_space_changed(&space_id, None).await;
        Ok(json!({
            "spaceId": space_id,
            "cancelled": cancelled,
        }))
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

    async fn warmup(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let space_id = optional_text(input, &["threadId", "thread_id"])
            .map(Ok)
            .unwrap_or_else(|| required_text(input, &["spaceId", "space_id"]))?;
        if space_id.starts_with("direct:") {
            return Ok(json!({ "skipped": true }));
        }
        let warmer = self.warmup.lock().expect("warmup").clone();
        let hot_groups = self.hot_groups.lock().expect("hot groups").clone();
        match collaboration::warmup_space_members(
            &self.pool,
            &space_id,
            &text(input, &["content"]),
            &string_list(input, &["to"]),
            warmer.as_deref(),
            hot_groups.as_deref(),
        )
        .await
        {
            Ok(result) => serde_json::to_value(result).map_err(|error| {
                CollaborationHostError::new("conversation_control_failed", error.to_string())
            }),
            Err(error) => {
                tracing::warn!(%error, space_id, "space warmup failed");
                Ok(json!({ "ok": false }))
            }
        }
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
        let collection_dir = collaboration::ensure_space_collection_dir(&space_id)
            .ok()
            .map(|dir| collaboration::collection_dir_display(&dir));
        Ok(json!({
            "items": items,
            "collectionDir": collection_dir,
            "collection_dir": collection_dir,
        }))
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
        self.emit_space_changed(&space_id, None).await;
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
        self.emit_space_changed(&space_id, None).await;
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
        self.emit_space_changed(&space_id, None).await;
        serde_json::to_value(item).map_err(|error| {
            CollaborationHostError::new("conversation_control_failed", error.to_string())
        })
    }

    async fn remove_collection_item(&self, input: &Value) -> Result<Value, CollaborationHostError> {
        let space_id = required_text(input, &["spaceId", "space_id"])?;
        let item_id = required_text(input, &["itemId", "item_id", "id"])?;
        let delivery = self.delivery.lock().expect("delivery").clone();
        collaboration::remove_space_collection_item_with(
            &self.pool, &space_id, &item_id, &delivery,
        )
        .await
        .map_err(host_error)?;
        self.emit_space_changed(&space_id, None).await;
        Ok(json!({ "removed": true, "id": item_id }))
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
    async fn emit_space_changed(&self, space_id: &str, member_id: Option<&str>) {
        if let Ok(workspace_id) = collaboration::space_workspace_id(&self.pool, space_id).await {
            let evt = collaboration::latest_space_changed_event(
                &self.pool,
                workspace_id,
                space_id,
                member_id.map(str::to_string),
            )
            .await;
            self.events.emit(COLLABORATION_SPACE_CHANGED_EVENT, evt);
        }
    }

    /// Default agent for a member created without role or agent (compat path).
    async fn default_member_agent(&self) -> String {
        sqlx::query_scalar::<_, String>(
            r#"SELECT agent_id FROM agent_membership
               WHERE enabled = 1 AND retired = 0
               ORDER BY position ASC, agent_id ASC LIMIT 1"#,
        )
        .fetch_optional(&self.pool)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| "codex".to_string())
    }

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

fn elicitation_response_from_card_answer(
    declined: bool,
    companion_answer: &Value,
) -> AgentElicitationResponse {
    if declined {
        return AgentElicitationResponse::Decline;
    }
    let content = if companion_answer.is_array() {
        json!({ "answers": companion_answer })
    } else {
        companion_answer.clone()
    };
    AgentElicitationResponse::Accept { content }
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
    use delegation::DelegationScope;
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
    async fn member_session_resolve_is_per_thread_and_idempotent() {
        let pool = setup_pool().await;
        let host = HostCollaborationHost::new(pool.clone(), Arc::new(HostEventBus::new()));
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        create_session(&pool, a, workspace, "A").await;
        let mut spaces = Vec::new();
        for name in ["g1", "g2"] {
            let space = host
                .call("host", "collaboration", "space.create",
                    json!({ "workspaceId": workspace, "name": name, "operationId": Uuid::new_v4() }))
                .await
                .unwrap();
            spaces.push(space["space_id"].as_str().unwrap().to_string());
        }
        host.call("host", "collaboration", "space.addMember",
            json!({ "spaceId": spaces[0], "conversationId": a, "nickname": "A", "operationId": Uuid::new_v4() }))
            .await
            .unwrap();
        let b = Uuid::new_v4();
        create_session(&pool, b, workspace, "B").await;
        host.call("host", "collaboration", "space.addMember",
            json!({ "spaceId": spaces[1], "conversationId": b, "nickname": "B", "operationId": Uuid::new_v4() }))
            .await
            .unwrap();
        let member = db::models::collaboration_identity::member_id_for_conversation(a);
        let resolve = |thread: String| {
            let host = &host;
            let member = member.clone();
            async move {
                host.call(
                    "host",
                    "collaboration",
                    "member.session.resolve",
                    json!({ "memberId": member, "threadId": thread }),
                )
                .await
                .unwrap()["conversationId"]
                    .as_str()
                    .unwrap()
                    .to_string()
            }
        };
        assert_eq!(resolve(spaces[0].clone()).await, a.to_string());
        let created = resolve(spaces[1].clone()).await;
        assert_ne!(created, a.to_string());
        assert_eq!(resolve(spaces[1].clone()).await, created);
    }

    #[tokio::test]
    async fn joining_a_group_keeps_the_direct_session_in_the_direct_chat() {
        let pool = setup_pool().await;
        let host = HostCollaborationHost::new(pool.clone(), Arc::new(HostEventBus::new()));
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        create_session(&pool, a, workspace, "A").await;
        let direct_space = collaboration::unassigned_space_id(workspace);
        host.call("host", "collaboration", "space.addMember",
            json!({ "spaceId": direct_space, "conversationId": a, "nickname": "A", "operationId": Uuid::new_v4() }))
            .await
            .unwrap();
        let group = host
            .call(
                "host",
                "collaboration",
                "space.create",
                json!({ "workspaceId": workspace, "name": "g", "operationId": Uuid::new_v4() }),
            )
            .await
            .unwrap()["space_id"]
            .as_str()
            .unwrap()
            .to_string();
        let seat = host
            .call("host", "collaboration", "space.addMember",
                json!({ "spaceId": group, "conversationId": a, "nickname": "A", "operationId": Uuid::new_v4() }))
            .await
            .unwrap();
        let group_conversation = seat["conversation_id"].as_str().unwrap().to_string();
        assert_ne!(
            group_conversation,
            a.to_string(),
            "group seat must not take the direct session"
        );
        let direct_seat: Option<String> = sqlx::query_scalar(
            "SELECT conversation_id FROM collaboration_space_members WHERE space_id = ? AND conversation_id = ?",
        )
        .bind(&direct_space)
        .bind(a.to_string())
        .fetch_optional(&pool)
        .await
        .unwrap();
        assert_eq!(direct_seat.as_deref(), Some(a.to_string().as_str()));
        let member = db::models::collaboration_identity::member_id_for_conversation(a);
        let direct = host
            .call(
                "host",
                "collaboration",
                "member.session.resolve",
                json!({ "memberId": member, "threadId": direct_space }),
            )
            .await
            .unwrap();
        assert_eq!(
            direct["conversationId"].as_str(),
            Some(a.to_string().as_str())
        );
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
            .call(
                "host",
                "collaboration",
                "space.create",
                json!({ "workspaceId": workspace, "name": "群1", "operationId": Uuid::new_v4() }),
            )
            .await
            .unwrap();
        let space_id = space["space_id"].as_str().unwrap().to_string();
        host.call("host", "collaboration", "space.addMember",
            json!({ "spaceId": space_id, "conversationId": a, "nickname": "小A", "operationId": Uuid::new_v4() }))
            .await
            .unwrap();
        let member = db::models::collaboration_identity::member_id_for_conversation(a);
        memory::record_activity(
            &pool,
            a,
            Some(Uuid::new_v4()),
            "修好了分页。",
            &FirstSentencesSummarizer,
        )
        .await
        .unwrap();
        let global = memory::create_fact(
            &pool,
            &member,
            "统一用 pnpm",
            &FactScope::Global,
            None,
            "agent",
        )
        .await
        .unwrap();
        memory::create_fact(
            &pool,
            &member,
            "用户生日五月一日",
            &FactScope::Private,
            None,
            "agent",
        )
        .await
        .unwrap();

        let listed = host
            .call(
                "host",
                "collaboration",
                "member.memory.list",
                json!({ "memberId": member }),
            )
            .await
            .unwrap();
        assert_eq!(
            listed["facts"].as_array().unwrap().len(),
            2,
            "user view includes private"
        );
        let only_private = host
            .call(
                "host",
                "collaboration",
                "member.memory.list",
                json!({ "memberId": member, "scope": "private" }),
            )
            .await
            .unwrap();
        assert_eq!(only_private["facts"].as_array().unwrap().len(), 1);
        let activity = host
            .call(
                "host",
                "collaboration",
                "member.activity.list",
                json!({ "memberId": member }),
            )
            .await
            .unwrap();
        assert_eq!(activity["activity"][0]["summary"], json!("修好了分页。"));

        let updated = host
            .call("host", "collaboration", "member.memory.update",
                json!({ "memberId": member, "factId": global.id, "content": "统一用 pnpm 9", "scope": format!("thread:{space_id}") }))
            .await
            .unwrap();
        assert_eq!(updated["fact"]["content"], json!("统一用 pnpm 9"));
        assert_eq!(
            updated["fact"]["scope"],
            json!(format!("thread:{space_id}"))
        );
        assert!(
            host.call(
                "host",
                "collaboration",
                "member.memory.update",
                json!({ "memberId": member, "factId": global.id, "scope": "bogus" })
            )
            .await
            .is_err()
        );
        let deleted = host
            .call(
                "host",
                "collaboration",
                "member.memory.delete",
                json!({ "memberId": member, "factId": global.id }),
            )
            .await
            .unwrap();
        assert_eq!(deleted["deleted"], json!(true));
        let again = host
            .call(
                "host",
                "collaboration",
                "member.memory.delete",
                json!({ "memberId": member, "factId": global.id }),
            )
            .await
            .unwrap();
        assert_eq!(again["deleted"], json!(false));
        let left = host
            .call(
                "host",
                "collaboration",
                "member.memory.list",
                json!({ "memberId": member }),
            )
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
            .call(
                "host",
                "collaboration",
                "space.create",
                json!({ "workspaceId": workspace, "name": "群1", "operationId": Uuid::new_v4() }),
            )
            .await
            .unwrap();
        let space_id = space["space_id"].as_str().unwrap().to_string();
        host.call("host", "collaboration", "space.addMember",
            json!({ "spaceId": space_id, "conversationId": a, "nickname": "小A", "operationId": Uuid::new_v4() }))
            .await
            .unwrap();
        let delivery = DeliveryContext::default();
        let op = Uuid::new_v4();
        let ask = cards::post_card(
            &pool,
            PostCard {
                caller_id: a,
                space_id: space_id.clone(),
                kind: CardKind::Ask,
                payload: json!({ "question": "用哪个分支？", "options": ["main", "dev"] }),
                operation_id: op,
            },
            &delivery,
        )
        .await
        .unwrap();
        let again = cards::post_card(
            &pool,
            PostCard {
                caller_id: a,
                space_id: space_id.clone(),
                kind: CardKind::Ask,
                payload: json!({ "question": "用哪个分支？" }),
                operation_id: op,
            },
            &delivery,
        )
        .await
        .unwrap();
        assert_eq!(ask.id, again.id, "idempotent per operation id");
        let approval = cards::post_card(
            &pool,
            PostCard {
                caller_id: a,
                space_id: space_id.clone(),
                kind: CardKind::Approval,
                payload: json!({ "action": "run", "command": "rm -rf dist", "reason": "clean" }),
                operation_id: Uuid::new_v4(),
            },
            &delivery,
        )
        .await
        .unwrap();
        let pending = host
            .call(
                "host",
                "collaboration",
                "card.list",
                json!({ "threadId": space_id, "pendingOnly": true }),
            )
            .await
            .unwrap();
        assert_eq!(pending["cards"].as_array().unwrap().len(), 2);
        assert!(
            host.call(
                "host",
                "collaboration",
                "card.resolve",
                json!({ "cardId": ask.id })
            )
            .await
            .is_err(),
            "ask needs an answer"
        );
        let resolved = host
            .call(
                "host",
                "collaboration",
                "card.resolve",
                json!({ "cardId": ask.id, "answer": "dev" }),
            )
            .await
            .unwrap();
        assert_eq!(resolved["card"]["status"], json!("resolved"));
        assert!(
            resolved["card"]["reply_message_id"].is_string()
                || resolved["card"]["replyMessageId"].is_string()
        );
        assert!(
            host.call(
                "host",
                "collaboration",
                "card.resolve",
                json!({ "cardId": ask.id, "answer": "x" })
            )
            .await
            .is_err(),
            "double resolve rejected"
        );
        assert!(
            host.call(
                "host",
                "collaboration",
                "card.resolve",
                json!({ "cardId": approval.id, "decision": "maybe" })
            )
            .await
            .is_err()
        );
        host.call(
            "host",
            "collaboration",
            "card.resolve",
            json!({ "cardId": approval.id, "decision": "deny" }),
        )
        .await
        .unwrap();
        let pending = host
            .call(
                "host",
                "collaboration",
                "card.list",
                json!({ "threadId": space_id, "pendingOnly": true }),
            )
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
        assert_eq!(join_event.payload["seq"], json!(3));
        assert_eq!(join_event.payload["kind"], json!("roster"));
        assert_eq!(join_event.payload["generation"], json!(1));

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
        assert_eq!(post_event.payload["seq"], json!(7));
        assert_eq!(post_event.payload["kind"], json!("turn"));
        assert_eq!(post_event.payload["generation"], json!(1));
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
                    "inReplyTo": first_id,
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
        assert_eq!(messages[1]["in_reply_to"], json!(first_id));
    }

    #[tokio::test]
    async fn host_space_react_toggles_user_emoji_and_lists_it_on_the_envelope() {
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
        let posted = host
            .call(
                "host",
                "collaboration",
                "space.post",
                json!({ "spaceId": space_id, "content": "你好", "to": ["小A"], "operationId": Uuid::new_v4() }),
            )
            .await
            .unwrap();
        let message_id = posted["message_id"].as_str().unwrap().to_string();
        let reacted = host
            .call(
                "host",
                "collaboration",
                "space.react",
                json!({ "spaceId": space_id, "messageId": message_id, "emoji": "👍" }),
            )
            .await
            .unwrap();
        assert_eq!(reacted["reactions"][0]["emoji"], json!("👍"));
        assert_eq!(reacted["reactions"][0]["actor"], json!("user"));
        let listed = host
            .call(
                "host",
                "collaboration",
                "space.listMessages",
                json!({ "spaceId": space_id }),
            )
            .await
            .unwrap();
        assert_eq!(
            listed["messages"][0]["envelope"]["reactions"][0]["emoji"],
            json!("👍")
        );
        let cleared = host
            .call(
                "host",
                "collaboration",
                "space.react",
                json!({ "spaceId": space_id, "messageId": message_id, "emoji": "👍" }),
            )
            .await
            .unwrap();
        assert_eq!(cleared["reactions"], json!([]));
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

    // ---- Compat shims for the pre-redesign frontend --------------------------

    #[tokio::test]
    async fn compat_template_ops_return_empty_list_and_noop_success() {
        let pool = setup_pool().await;
        let host = HostCollaborationHost::new(pool, Arc::new(HostEventBus::new()));
        for op in ["template.list", "team.template.list", "member.templates"] {
            let listed = host
                .call("host", "collaboration", op, json!({}))
                .await
                .unwrap();
            assert_eq!(listed["templates"], json!([]), "{op}");
            assert_eq!(listed["items"], json!([]), "{op}");
        }
        for op in ["template.create", "template.delete", "team.template.apply"] {
            let done = host
                .call("host", "collaboration", op, json!({ "id": "x" }))
                .await
                .unwrap();
            assert_eq!(done["ok"], json!(true), "{op}");
        }
    }

    #[tokio::test]
    async fn compat_create_member_without_agent_or_config_uses_defaults() {
        let pool = setup_pool().await;
        let host = HostCollaborationHost::new(pool.clone(), Arc::new(HostEventBus::new()));
        let workspace = Uuid::new_v4();
        create_session(&pool, Uuid::new_v4(), workspace, "seed").await;
        // no agentId / modeId / configValues / personaPrompt / operationId
        let member = host
            .call(
                "host",
                "collaboration",
                "space.createMember",
                json!({ "workspaceId": workspace, "nickname": "Bare" }),
            )
            .await
            .unwrap();
        assert_eq!(member["nickname"], "Bare");
        assert!(member["member_id"].as_str().is_some());
        assert!(member["space_id"].as_str().is_some());
        let conv = Uuid::parse_str(member["conversation_id"].as_str().unwrap()).unwrap();
        let agent: Option<String> =
            sqlx::query_scalar("SELECT agent_id FROM sessions WHERE id = ?")
                .bind(conv)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(
            agent.is_some_and(|a| !a.is_empty()),
            "default agent applied"
        );

        // explicit agent with no config still works (old frontend agent source)
        let explicit = host
            .call(
                "host",
                "collaboration",
                "space.createMember",
                json!({
                    "workspaceId": workspace,
                    "nickname": "Explicit",
                    "agentId": "codex",
                    "operationId": Uuid::new_v4(),
                }),
            )
            .await
            .unwrap();
        assert_eq!(explicit["nickname"], "Explicit");
    }

    async fn card_fixture() -> (SqlitePool, HostCollaborationHost, String, Uuid) {
        let pool = setup_pool().await;
        let host = HostCollaborationHost::new(pool.clone(), Arc::new(HostEventBus::new()));
        let workspace = Uuid::new_v4();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        create_session(&pool, a, workspace, "A").await;
        create_session(&pool, b, workspace, "B").await;
        let space = collaboration::create_collaboration_space(&pool, a, "room", Uuid::new_v4())
            .await
            .unwrap();
        collaboration::add_space_member(&pool, a, &space.space_id, a, "Asker", Uuid::new_v4())
            .await
            .unwrap();
        collaboration::add_space_member(&pool, a, &space.space_id, b, "MemberB", Uuid::new_v4())
            .await
            .unwrap();
        (pool, host, space.space_id, a)
    }

    async fn post_ask(pool: &SqlitePool, space: &str, caller: Uuid, payload: Value) -> String {
        conversations::collaboration_cards::post_card(
            pool,
            conversations::collaboration_cards::PostCard {
                caller_id: caller,
                space_id: space.to_string(),
                kind: conversations::collaboration_cards::CardKind::Ask,
                payload,
                operation_id: Uuid::new_v4(),
            },
            &DeliveryContext::default(),
        )
        .await
        .unwrap()
        .id
    }

    #[tokio::test]
    async fn compat_card_resolve_without_actor_defaults_to_user() {
        let (pool, host, space, a) = card_fixture().await;
        let card_id = post_ask(&pool, &space, a, json!({ "question": "branch?" })).await;
        let resolved = host
            .call(
                "host",
                "collaboration",
                "card.resolve",
                json!({ "cardId": card_id, "answer": "dev" }),
            )
            .await
            .unwrap();
        assert_eq!(resolved["card"]["status"], "resolved");

        let explicit = post_ask(&pool, &space, a, json!({ "question": "again?" })).await;
        let ok = host
            .call(
                "host",
                "collaboration",
                "card.resolve",
                json!({ "cardId": explicit, "actor": "user", "answer": "yes" }),
            )
            .await
            .unwrap();
        assert_eq!(ok["card"]["status"], "resolved");

        let other = post_ask(&pool, &space, a, json!({ "question": "third?" })).await;
        let err = host
            .call(
                "host",
                "collaboration",
                "card.resolve",
                json!({ "cardId": other, "actor": "member", "answer": "no" }),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), "permission_denied");
    }

    #[tokio::test]
    async fn host_card_resolve_completes_blocking_ask_user_question() {
        let (pool, host, _space, a) = card_fixture().await;
        let memory = Arc::new(InMemoryCompanionFeatures::new());
        host.install_companion_memory(memory.clone());
        let questions = json!([{
            "question": "用哪个方案？",
            "header": "方案",
            "multiSelect": false,
            "options": [
                { "label": "A", "description": "one" },
                { "label": "B", "description": "two" }
            ]
        }]);
        let wait = memory
            .begin_question(
                DelegationScope {
                    parent_connection_id: Uuid::new_v4().to_string(),
                    parent_conversation_id: a,
                },
                questions.clone(),
            )
            .await
            .unwrap();
        let question_id = wait.question().id.clone();
        conversations::collaboration_cards::post_blocking_user_question(
            &pool,
            a,
            &questions,
            &question_id,
            &DeliveryContext::default(),
        )
        .await
        .unwrap();
        host.call(
            "host",
            "collaboration",
            "card.resolve",
            json!({
                "cardId": question_id,
                "answers": [{ "questionId": "question-1", "labels": ["A"] }],
                "answer": "A",
            }),
        )
        .await
        .unwrap();
        let answered = wait.wait().await.unwrap();
        assert_eq!(answered[0]["labels"][0], json!("A"));
    }

    #[test]
    fn card_answers_become_elicitation_content() {
        let answers = json!([{ "questionId": "q1", "labels": ["A"] }]);
        assert_eq!(
            elicitation_response_from_card_answer(false, &answers),
            AgentElicitationResponse::Accept {
                content: json!({ "answers": answers }),
            }
        );
        assert_eq!(
            elicitation_response_from_card_answer(true, &answers),
            AgentElicitationResponse::Decline
        );
    }

    #[tokio::test]
    async fn compat_ask_person_without_to_is_addressed_to_user() {
        let (pool, host, space, a) = card_fixture().await;
        // no `to` at all, and the empty `to` the MCP bridge sends when omitted
        for payload in [
            json!({ "question": "which branch?" }),
            json!({ "question": "which env?", "to": "" }),
        ] {
            let card_id = post_ask(&pool, &space, a, payload).await;
            let listed = host
                .call(
                    "host",
                    "collaboration",
                    "card.list",
                    json!({ "spaceId": space }),
                )
                .await
                .unwrap();
            let card = listed["cards"]
                .as_array()
                .unwrap()
                .iter()
                .find(|c| c["id"] == json!(card_id))
                .cloned()
                .unwrap();
            assert!(card["payload"].get("target_member_id").is_none());
            // and the user can answer it without an actor param
            host.call(
                "host",
                "collaboration",
                "card.resolve",
                json!({ "cardId": card_id, "answer": "main" }),
            )
            .await
            .unwrap();
        }
    }

    async fn sidebar_host() -> (SqlitePool, HostCollaborationHost, Uuid) {
        let pool = setup_pool().await;
        let host = HostCollaborationHost::new(pool.clone(), Arc::new(HostEventBus::new()));
        let workspace = Uuid::new_v4();
        create_session(&pool, Uuid::new_v4(), workspace, "seed").await;
        (pool, host, workspace)
    }

    async fn call(host: &HostCollaborationHost, op: &str, input: Value) -> Value {
        host.call("host", "collaboration", op, input).await.unwrap()
    }

    async fn new_space(host: &HostCollaborationHost, workspace: Uuid, name: &str) -> String {
        call(
            host,
            "space.create",
            json!({ "workspaceId": workspace, "name": name, "operationId": Uuid::new_v4() }),
        )
        .await["space_id"]
            .as_str()
            .unwrap()
            .to_string()
    }

    struct RecordingWarmer {
        calls: std::sync::Mutex<Vec<Uuid>>,
    }

    #[async_trait::async_trait]
    impl collaboration::SessionProcessWarmup for RecordingWarmer {
        async fn ensure_process(&self, conversation_id: Uuid) -> Result<bool, String> {
            self.calls.lock().expect("calls").push(conversation_id);
            Ok(false)
        }
    }

    #[tokio::test]
    async fn space_warmup_starts_no_turn_and_writes_no_message() {
        let (pool, host, workspace) = sidebar_host().await;
        let space = new_space(&host, workspace, "g1").await;
        let warmer = Arc::new(RecordingWarmer {
            calls: std::sync::Mutex::new(Vec::new()),
        });
        host.install_session_warmup(warmer.clone());
        host.install_hot_groups(Arc::new(collaboration::HotGroupTracker::default()));
        let before: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM collaboration_space_messages WHERE space_id = ?",
        )
        .bind(&space)
        .fetch_one(&pool)
        .await
        .unwrap();
        let turns_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM conversation_turns")
            .fetch_one(&pool)
            .await
            .unwrap();
        let result = call(
            &host,
            "space.warmup",
            json!({ "spaceId": space, "content": "开工", "to": [] }),
        )
        .await;
        assert!(result["nicknames"].as_array().is_some());
        let after: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM collaboration_space_messages WHERE space_id = ?",
        )
        .bind(&space)
        .fetch_one(&pool)
        .await
        .unwrap();
        let turns_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM conversation_turns")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(after, before);
        assert_eq!(turns_after, turns_before);
        let dm = call(
            &host,
            "space.warmup",
            json!({ "spaceId": "direct:mem-a", "content": "hi", "to": [] }),
        )
        .await;
        assert_eq!(dm["skipped"], json!(true));
    }

    #[tokio::test]
    async fn current_create_member_form_payload_maps_onto_member_definition() {
        let (_pool, host, workspace) = sidebar_host().await;
        let space = new_space(&host, workspace, "g1").await;
        // Exact payload of the current frontend form (source = agent).
        let created = call(
            &host,
            "space.createMember",
            json!({
                "workspaceId": workspace,
                "spaceId": space,
                "nickname": "Alice",
                "source": "agent",
                "agentId": "codex",
                "modeId": "plan",
                "configValues": { "model": "gpt-5" },
                "personaPrompt": "be terse",
                "operationId": Uuid::new_v4(),
            }),
        )
        .await;
        assert_eq!(created["nickname"], json!("Alice"));
        assert_eq!(
            created["space_id"],
            json!(format!("unassigned:{workspace}"))
        );
        let conversation = created["conversation_id"].as_str().unwrap().to_string();
        let identity = created["identity_member_id"].as_str().unwrap().to_string();

        let config = call(&host, "member.config.get", json!({ "memberId": identity })).await;
        assert_eq!(config["config"]["agent_id"], json!("codex"));
        assert_eq!(config["config"]["mode_id"], json!("plan"));
        assert_eq!(config["config"]["config_values"]["model"], json!("gpt-5"));
        assert_eq!(config["config"]["persona_prompt"], json!("be terse"));

        let direct_thread = created["direct_thread_id"].as_str().unwrap().to_string();
        assert_eq!(direct_thread, format!("direct:{identity}"));
        let dm = call(
            &host,
            "member.session.resolve",
            json!({ "memberId": identity, "threadId": direct_thread }),
        )
        .await;
        assert_eq!(dm["conversationId"], json!(conversation));

        // Later group join: per-group session for the same member.
        call(
            &host,
            "space.addMember",
            json!({
                "spaceId": space, "conversationId": conversation, "nickname": "Alice",
                "operationId": Uuid::new_v4(),
            }),
        )
        .await;
        let in_group = call(
            &host,
            "member.session.resolve",
            json!({ "memberId": identity, "threadId": space }),
        )
        .await;
        let group_session = in_group["conversationId"].as_str().unwrap().to_string();
        assert_ne!(group_session, conversation);

        // The joined seat still resolves to the bot identity, so the UI can
        // keep showing the identity's name/avatar instead of the hidden
        // per-thread conversation.
        let listed = call(&host, "space.listMembers", json!({ "spaceId": space })).await;
        let seat = listed["members"]
            .as_array()
            .unwrap()
            .iter()
            .find(|member| member["conversation_id"] == json!(group_session))
            .expect("joined seat");
        assert_eq!(seat["nickname"], json!("Alice"));
        assert_eq!(seat["identity_member_id"], json!(identity));

        let sidebar = call(
            &host,
            "thread.listSidebar",
            json!({ "workspaceId": workspace }),
        )
        .await;
        let group = sidebar["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["thread_id"] == json!(space))
            .unwrap()
            .clone();
        assert_eq!(group["kind"], json!("group"));
        assert_eq!(group["name"], json!("g1"));
        assert_eq!(group["members_preview"][0]["member_id"], json!(identity));
        assert_eq!(group["members_preview"][0]["name"], json!("Alice"));
        assert_eq!(
            group["members_preview"][0]["conversation_id"],
            json!(group_session)
        );
        let dm_item = sidebar["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["thread_id"] == json!(direct_thread))
            .unwrap()
            .clone();
        assert_eq!(dm_item["kind"], json!("dm"));
        let members = call(&host, "member.list", json!({ "workspaceId": workspace })).await;
        assert!(
            members["members"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["member_id"] == json!(identity))
        );
        call(
            &host,
            "member.update",
            json!({ "memberId": identity, "avatar": "🐱", "color": "#f00" }),
        )
        .await;
        let sidebar = call(
            &host,
            "thread.listSidebar",
            json!({ "workspaceId": workspace }),
        )
        .await;
        let group = sidebar["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["thread_id"] == json!(space))
            .unwrap()
            .clone();
        assert_eq!(group["members_preview"][0]["avatar"], json!("🐱"));
        assert_eq!(group["members_preview"][0]["color"], json!("#f00"));
    }

    #[tokio::test]
    async fn current_create_member_form_role_payload_uses_role_config() {
        let (_pool, host, workspace) = sidebar_host().await;
        let role = call(
            &host,
            "role.create",
            json!({
                "name": "Reviewer", "summary": "", "personaPrompt": "review carefully",
                "agentId": "codex", "modeId": "review", "configValues": { "model": "m1" },
            }),
        )
        .await;
        let role_id = role["id"].as_str().unwrap().to_string();
        // Exact payload of the current frontend form (source = role), undecided space.
        let created = call(
            &host,
            "space.createMember",
            json!({
                "workspaceId": workspace,
                "spaceId": format!("unassigned:{workspace}"),
                "nickname": "Rev",
                "source": "role",
                "roleId": role_id,
                "operationId": Uuid::new_v4(),
            }),
        )
        .await;
        let identity = created["identity_member_id"].as_str().unwrap().to_string();
        let config = call(&host, "member.config.get", json!({ "memberId": identity })).await;
        assert_eq!(config["config"]["agent_id"], json!("codex"));
        assert_eq!(config["config"]["mode_id"], json!("review"));
        assert_eq!(config["config"]["config_values"]["model"], json!("m1"));
        assert_eq!(
            config["config"]["persona_prompt"],
            json!("review carefully")
        );

        let sidebar = call(
            &host,
            "thread.listSidebar",
            json!({ "workspaceId": workspace }),
        )
        .await;
        let direct = sidebar["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["kind"] == json!("dm"))
            .unwrap()
            .clone();
        assert_eq!(direct["thread_id"], json!(format!("direct:{identity}")));
        assert_eq!(direct["name"], json!("Rev"));
        assert_eq!(direct["member"]["member_id"], json!(identity));
        assert_eq!(
            direct["member"]["conversation_id"],
            created["conversation_id"]
        );
        let resolved = call(
            &host,
            "member.session.resolve",
            json!({ "memberId": identity, "threadId": direct["thread_id"] }),
        )
        .await;
        assert_eq!(resolved["conversationId"], created["conversation_id"]);
    }

    #[tokio::test]
    async fn sidebar_sorts_by_activity_and_tracks_unread_and_tag_color() {
        let (pool, host, workspace) = sidebar_host().await;
        let a = new_space(&host, workspace, "A").await;
        let b = new_space(&host, workspace, "B").await;
        let first = call(
            &host,
            "thread.listSidebar",
            json!({ "workspaceId": workspace }),
        )
        .await;
        let items = first["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert!(items.iter().all(|item| item["unread_count"] == json!(0)));
        sqlx::query(
            "INSERT INTO collaboration_space_messages (id, space_id, seq, envelope_json, created_at, origin)
             VALUES (?, ?, 1, ?, '2999-01-01T00:00:00Z', 'agent')",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&a)
        .bind(json!({ "content": "hello  from\nagent" }).to_string())
        .execute(&pool)
        .await
        .unwrap();
        call(
            &host,
            "thread.update",
            json!({ "threadId": a, "tagColor": "#22c55e" }),
        )
        .await;
        let listed = call(
            &host,
            "thread.listSidebar",
            json!({ "workspaceId": workspace }),
        )
        .await;
        let items = listed["items"].as_array().unwrap();
        assert_eq!(items[0]["thread_id"], json!(a));
        assert_eq!(items[0]["unread_count"], json!(1));
        assert_eq!(items[0]["tag_color"], json!("#22c55e"));
        assert_eq!(
            items[0]["last_message"]["preview"],
            json!("hello from agent")
        );
        assert_eq!(items[1]["thread_id"], json!(b));
        let read = call(&host, "thread.markRead", json!({ "threadId": a })).await;
        assert_eq!(read["lastReadSeq"], json!(1));
        let listed = call(
            &host,
            "thread.listSidebar",
            json!({ "workspaceId": workspace }),
        )
        .await;
        assert_eq!(listed["items"][0]["unread_count"], json!(0));
        // Existing space.list response shape is unchanged.
        let spaces = call(&host, "space.list", json!({ "workspaceId": workspace })).await;
        let space_obj = spaces["spaces"][0].as_object().unwrap();
        assert!(space_obj.contains_key("space_id"));
        assert!(space_obj.contains_key("name"));
        assert!(space_obj.contains_key("workspace_id"));
    }

    #[tokio::test]
    async fn create_member_yields_one_dm_session_and_one_direct_thread_only() {
        let (pool, host, workspace) = sidebar_host().await;
        let space = new_space(&host, workspace, "g").await;
        let count = |sql: &'static str| {
            let pool = pool.clone();
            async move {
                sqlx::query_scalar::<_, i64>(sql)
                    .fetch_one(&pool)
                    .await
                    .unwrap()
            }
        };
        let sessions_before = count("SELECT COUNT(*) FROM sessions").await;
        let spaces_before = count("SELECT COUNT(*) FROM collaboration_spaces").await;
        // Current form payload, created from inside a group.
        let created = call(
            &host,
            "space.createMember",
            json!({
                "workspaceId": workspace, "spaceId": space, "nickname": "Solo",
                "source": "agent", "agentId": "codex", "modeId": "", "configValues": {},
                "personaPrompt": "", "operationId": Uuid::new_v4(),
            }),
        )
        .await;
        let identity = created["identity_member_id"].as_str().unwrap().to_string();
        assert_eq!(
            count("SELECT COUNT(*) FROM sessions").await,
            sessions_before + 1
        );
        assert_eq!(
            count("SELECT COUNT(*) FROM collaboration_spaces").await,
            spaces_before
        );
        let bindings = sqlx::query_as::<_, (String, String)>(
            "SELECT thread_id, conversation_id FROM collaboration_thread_members WHERE member_id = ?")
            .bind(&identity).fetch_all(&pool).await.unwrap();
        assert_eq!(
            bindings,
            vec![(
                format!("direct:{identity}"),
                created["conversation_id"].as_str().unwrap().to_string()
            )]
        );
        let kind: String =
            sqlx::query_scalar("SELECT kind FROM collaboration_threads WHERE id = ?")
                .bind(format!("direct:{identity}"))
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(kind, "direct");
        let in_group: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM collaboration_space_members WHERE space_id = ? AND kind = 'agent'")
            .bind(&space).fetch_one(&pool).await.unwrap();
        assert_eq!(in_group, 0);
        assert_eq!(
            created["direct_thread_id"],
            json!(format!("direct:{identity}"))
        );
    }

    async fn dm_event(
        pool: &SqlitePool,
        conversation: Uuid,
        sequence: i64,
        kind: &str,
        body: Value,
    ) {
        sqlx::query(
            r#"INSERT INTO conversation_events
               (id, conversation_id, sequence, source, event_kind, normalized_json)
               VALUES (?, ?, ?, 'acp', ?, ?)"#,
        )
        .bind(Uuid::new_v4())
        .bind(conversation)
        .bind(sequence)
        .bind(kind)
        .bind(body.to_string())
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn dm_sidebar_preview_unread_and_direct_space_routes() {
        let (pool, host, workspace) = sidebar_host().await;
        let created = call(
            &host,
            "space.createMember",
            json!({
                "workspaceId": workspace, "spaceId": format!("unassigned:{workspace}"),
                "nickname": "Alice", "source": "agent", "agentId": "codex", "modeId": "",
                "configValues": {}, "personaPrompt": "", "operationId": Uuid::new_v4(),
            }),
        )
        .await;
        let thread = created["direct_thread_id"].as_str().unwrap().to_string();
        let conversation = Uuid::parse_str(created["conversation_id"].as_str().unwrap()).unwrap();
        let dm_item = |sidebar: Value| {
            sidebar["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["thread_id"] == json!(thread))
                .unwrap()
                .clone()
        };

        let empty = dm_item(
            call(
                &host,
                "thread.listSidebar",
                json!({ "workspaceId": workspace }),
            )
            .await,
        );
        assert_eq!(empty["kind"], json!("dm"));
        assert!(empty["last_message"].is_null());

        let user = |text: &str| json!({ "kind": "user_turn_created", "blocks": [{ "kind": "text", "text": text }] });
        let delta = |text: &str, id: &str| json!({ "kind": "assistant_text_delta", "text": text, "message_id": id });
        dm_event(
            &pool,
            conversation,
            1,
            "user_turn_created",
            user("hello   there"),
        )
        .await;
        dm_event(
            &pool,
            conversation,
            2,
            "tool_call_upsert",
            json!({ "kind": "tool_call_upsert" }),
        )
        .await;
        dm_event(
            &pool,
            conversation,
            3,
            "assistant_text_delta",
            delta("Hi", "m1"),
        )
        .await;
        dm_event(
            &pool,
            conversation,
            4,
            "assistant_text_delta",
            delta(" Alice here", "m1"),
        )
        .await;
        dm_event(
            &pool,
            conversation,
            5,
            "usage_updated",
            json!({ "kind": "usage_updated" }),
        )
        .await;

        let first = dm_item(
            call(
                &host,
                "thread.listSidebar",
                json!({ "workspaceId": workspace }),
            )
            .await,
        );
        assert_eq!(first["last_message"]["preview"], json!("Hi Alice here"));
        assert_eq!(first["last_message"]["origin"], json!("agent"));
        assert_eq!(first["last_message"]["seq"], json!(3));
        assert_eq!(
            first["last_activity_at"],
            first["last_message"]["created_at"]
        );
        assert_eq!(
            first["unread_count"],
            json!(1),
            "reply arrived after the empty-thread baseline"
        );

        let long = "x".repeat(300);
        dm_event(
            &pool,
            conversation,
            6,
            "user_turn_created",
            user("question two"),
        )
        .await;
        dm_event(
            &pool,
            conversation,
            7,
            "assistant_text_delta",
            delta("answer two", "m2"),
        )
        .await;
        dm_event(
            &pool,
            conversation,
            8,
            "assistant_text_delta",
            delta(&long, "m3"),
        )
        .await;
        let second = dm_item(
            call(
                &host,
                "thread.listSidebar",
                json!({ "workspaceId": workspace }),
            )
            .await,
        );
        assert_eq!(second["unread_count"], json!(3));
        assert_eq!(second["last_message"]["seq"], json!(8));
        assert_eq!(
            second["last_message"]["preview"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            120
        );

        let marked = call(
            &host,
            "thread.markRead",
            json!({ "threadId": thread, "seq": 7 }),
        )
        .await;
        assert_eq!(marked["lastReadSeq"], json!(7));
        let after = dm_item(
            call(
                &host,
                "thread.listSidebar",
                json!({ "workspaceId": workspace }),
            )
            .await,
        );
        assert_eq!(after["unread_count"], json!(1));
        call(&host, "thread.markRead", json!({ "threadId": thread })).await;
        let all_read = dm_item(
            call(
                &host,
                "thread.listSidebar",
                json!({ "workspaceId": workspace }),
            )
            .await,
        );
        assert_eq!(all_read["unread_count"], json!(0));
        call(&host, "thread.markUnread", json!({ "threadId": thread })).await;
        let unread_again = dm_item(
            call(
                &host,
                "thread.listSidebar",
                json!({ "workspaceId": workspace }),
            )
            .await,
        );
        assert!(
            unread_again["unread_count"].as_i64().unwrap() > 0,
            "markUnread must restore an unread badge"
        );

        // space.listMessages with spaceId = direct:<id> reads the DM conversation.
        let listed = call(&host, "space.listMessages", json!({ "spaceId": thread })).await;
        let messages = listed["messages"].as_array().unwrap();
        let summary = messages
            .iter()
            .map(|m| {
                (
                    m["seq"].as_i64().unwrap(),
                    m["origin"].as_str().unwrap().to_string(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            summary,
            vec![
                (1, "user".to_string()),
                (3, "agent".to_string()),
                (6, "user".to_string()),
                (7, "agent".to_string()),
                (8, "agent".to_string()),
            ]
        );
        assert_eq!(messages[0]["envelope"]["content"], json!("hello   there"));
        assert_eq!(messages[1]["envelope"]["content"], json!("Hi Alice here"));
        assert_eq!(listed["conversationId"], json!(conversation.to_string()));
        let since = call(
            &host,
            "space.listMessages",
            json!({ "spaceId": thread, "sinceSeq": 3 }),
        )
        .await;
        assert_eq!(since["messages"].as_array().unwrap().len(), 3);

        dm_event(
            &pool,
            conversation,
            9,
            "user_turn_created",
            user("<vibex-private-bootstrap>\n你是我创建的一个助手\n</vibex-private-bootstrap>"),
        )
        .await;
        let after_bootstrap = call(&host, "space.listMessages", json!({ "spaceId": thread })).await;
        let after_texts: Vec<&str> = after_bootstrap["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|m| m["envelope"]["content"].as_str())
            .collect();
        assert!(
            !after_texts
                .iter()
                .any(|text| text.contains("vibex-private-bootstrap"))
        );
        let last = dm_item(
            call(
                &host,
                "thread.listSidebar",
                json!({ "workspaceId": workspace }),
            )
            .await,
        );
        assert_eq!(last["last_message"]["seq"], json!(8));

        // space.post / space.submit with a direct thread queue user input on the DM session.
        let operation = Uuid::new_v4();
        let posted = call(
            &host,
            "space.post",
            json!({
                "spaceId": thread, "content": "ping", "operationId": operation,
            }),
        )
        .await;
        assert_eq!(posted["conversationId"], json!(conversation.to_string()));
        assert!(posted["inputId"].is_string());
        call(
            &host,
            "space.post",
            json!({ "spaceId": thread, "content": "ping", "operationId": operation }),
        )
        .await;
        call(
            &host,
            "space.submit",
            json!({ "threadId": thread, "content": "pong", "operationId": Uuid::new_v4() }),
        )
        .await;
        let inputs: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM conversation_inputs WHERE conversation_id = ?",
        )
        .bind(conversation)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(inputs, 2, "replayed operation is idempotent");
        let dm_rows: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM collaboration_space_messages WHERE space_id = ?",
        )
        .bind(&thread)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(dm_rows, 2);
    }

    #[tokio::test]
    async fn dm_post_lists_queued_text_and_member_session_appears_in_workspace_list() {
        let (pool, host, workspace) = sidebar_host().await;
        let created = call(
            &host,
            "space.createMember",
            json!({
                "workspaceId": workspace,
                "nickname": "Alice",
                "source": "agent",
                "agentId": "codex",
                "modeId": "",
                "configValues": {},
                "personaPrompt": "",
                "operationId": Uuid::new_v4(),
            }),
        )
        .await;
        let thread = created["direct_thread_id"].as_str().unwrap().to_string();
        let conversation = Uuid::parse_str(created["conversation_id"].as_str().unwrap()).unwrap();

        let sessions = Session::find_by_workspace_id(&pool, workspace)
            .await
            .expect("workspace sessions");
        assert!(
            sessions.iter().any(|session| session.id == conversation),
            "createMember's private-chat session must appear in the workspace session list"
        );

        let operation = Uuid::new_v4();
        let posted = call(
            &host,
            "space.post",
            json!({
                "spaceId": thread,
                "content": "hello from im",
                "operationId": operation,
            }),
        )
        .await;
        assert!(posted["inputId"].is_string());

        let listed = call(&host, "space.listMessages", json!({ "spaceId": thread })).await;
        let messages = listed["messages"].as_array().expect("messages");
        let ping = messages
            .iter()
            .find(|message| message["envelope"]["content"].as_str() == Some("hello from im"))
            .expect("queued DM must list as a user message before the turn starts");
        assert_eq!(ping["origin"], json!("user"));
        assert_eq!(ping["operationId"], json!(operation.to_string()));
        let receipts = ping["receipts"].as_array().expect("receipts");
        assert_eq!(receipts[0]["delivered"], json!("queued"));

        let sidebar = call(
            &host,
            "thread.listSidebar",
            json!({ "workspaceId": workspace }),
        )
        .await;
        let item = sidebar["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["thread_id"] == json!(thread))
            .expect("dm sidebar row");
        assert_eq!(item["last_message"]["preview"], json!("hello from im"));
        assert_eq!(item["last_message"]["origin"], json!("user"));
    }

    #[tokio::test]
    async fn contact_groups_crud_reorder_and_thread_filing() {
        let (_pool, host, workspace) = sidebar_host().await;
        let space = new_space(&host, workspace, "g").await;
        let created = call(
            &host,
            "space.createMember",
            json!({
                "workspaceId": workspace, "spaceId": format!("unassigned:{workspace}"),
                "nickname": "Bob", "source": "agent", "agentId": "codex", "modeId": "",
                "configValues": {}, "personaPrompt": "", "operationId": Uuid::new_v4(),
            }),
        )
        .await;
        let dm = created["direct_thread_id"].as_str().unwrap().to_string();
        let group_of = |sidebar: Value, id: &str| {
            sidebar["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["thread_id"] == json!(id))
                .unwrap()["group_id"]
                .clone()
        };

        let work = call(
            &host,
            "contactGroup.create",
            json!({ "workspaceId": workspace, "name": " Work " }),
        )
        .await["group"]
            .clone();
        let home = call(
            &host,
            "contactGroup.create",
            json!({ "workspaceId": workspace, "name": "Home" }),
        )
        .await["group"]
            .clone();
        assert_eq!(work["name"], json!("Work"));
        assert_eq!(
            (work["sort_order"].clone(), home["sort_order"].clone()),
            (json!(0), json!(1))
        );
        let work_id = work["group_id"].as_str().unwrap().to_string();
        let home_id = home["group_id"].as_str().unwrap().to_string();
        assert!(
            host.call(
                "host",
                "collaboration",
                "contactGroup.create",
                json!({ "workspaceId": workspace, "name": "  " })
            )
            .await
            .is_err()
        );

        let renamed = call(
            &host,
            "contactGroup.rename",
            json!({ "groupId": work_id, "name": "Job" }),
        )
        .await;
        assert_eq!(renamed["group"]["name"], json!("Job"));

        let order = call(
            &host,
            "contactGroup.reorder",
            json!({ "workspaceId": workspace, "groupIds": [home_id, work_id] }),
        )
        .await;
        let names: Vec<_> = order["groups"]
            .as_array()
            .unwrap()
            .iter()
            .map(|g| g["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(names, vec!["Home", "Job"]);
        assert!(
            host.call(
                "host",
                "collaboration",
                "contactGroup.reorder",
                json!({ "workspaceId": workspace, "groupIds": [home_id] })
            )
            .await
            .is_err()
        );
        let listed = call(
            &host,
            "contactGroup.list",
            json!({ "workspaceId": workspace }),
        )
        .await;
        assert_eq!(listed["groups"][0]["group_id"], json!(home_id));

        let sidebar = call(
            &host,
            "thread.listSidebar",
            json!({ "workspaceId": workspace }),
        )
        .await;
        assert!(group_of(sidebar.clone(), &dm).is_null());
        assert!(group_of(sidebar, &space).is_null());

        call(
            &host,
            "thread.setGroup",
            json!({ "threadId": dm, "groupId": work_id }),
        )
        .await;
        call(
            &host,
            "thread.setGroup",
            json!({ "threadId": space, "groupId": work_id }),
        )
        .await;
        let sidebar = call(
            &host,
            "thread.listSidebar",
            json!({ "workspaceId": workspace }),
        )
        .await;
        assert_eq!(group_of(sidebar.clone(), &dm), json!(work_id));
        assert_eq!(group_of(sidebar, &space), json!(work_id));

        call(
            &host,
            "thread.setGroup",
            json!({ "threadId": space, "groupId": home_id }),
        )
        .await;
        call(
            &host,
            "thread.setGroup",
            json!({ "threadId": dm, "groupId": null }),
        )
        .await;
        let sidebar = call(
            &host,
            "thread.listSidebar",
            json!({ "workspaceId": workspace }),
        )
        .await;
        assert!(group_of(sidebar.clone(), &dm).is_null());
        assert_eq!(group_of(sidebar, &space), json!(home_id));

        assert!(
            host.call(
                "host",
                "collaboration",
                "thread.setGroup",
                json!({ "threadId": "direct:nope", "groupId": home_id })
            )
            .await
            .is_err()
        );
        assert!(
            host.call(
                "host",
                "collaboration",
                "thread.setGroup",
                json!({ "threadId": dm, "groupId": "nope" })
            )
            .await
            .is_err()
        );
        let other = call(
            &host,
            "contactGroup.create",
            json!({ "workspaceId": Uuid::new_v4(), "name": "Else" }),
        )
        .await["group"]["group_id"]
            .clone();
        assert!(
            host.call(
                "host",
                "collaboration",
                "thread.setGroup",
                json!({ "threadId": dm, "groupId": other })
            )
            .await
            .is_err()
        );

        let deleted = call(&host, "contactGroup.delete", json!({ "groupId": home_id })).await;
        assert_eq!(deleted["ungroupedThreadIds"], json!([space]));
        let sidebar = call(
            &host,
            "thread.listSidebar",
            json!({ "workspaceId": workspace }),
        )
        .await;
        assert!(group_of(sidebar, &space).is_null());
        let listed = call(
            &host,
            "contactGroup.list",
            json!({ "workspaceId": workspace }),
        )
        .await;
        assert_eq!(listed["groups"].as_array().unwrap().len(), 1);
        assert!(
            host.call(
                "host",
                "collaboration",
                "contactGroup.delete",
                json!({ "groupId": home_id })
            )
            .await
            .is_err()
        );
    }

    #[tokio::test]
    async fn cancel_turn_allows_the_owner_and_rejects_other_members() {
        let pool = setup_pool().await;
        let host = HostCollaborationHost::new(pool.clone(), Arc::new(HostEventBus::new()));
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        create_session(&pool, a, workspace, "小A").await;
        create_session(&pool, b, workspace, "小B").await;
        let space = host
            .call(
                "host",
                "collaboration",
                "space.create",
                json!({ "workspaceId": workspace, "name": "评审", "operationId": Uuid::new_v4() }),
            )
            .await
            .unwrap()["space_id"]
            .as_str()
            .unwrap()
            .to_string();
        let seat_a = host
            .call(
                "host",
                "collaboration",
                "space.addMember",
                json!({ "spaceId": space, "conversationId": a, "nickname": "小A", "operationId": Uuid::new_v4() }),
            )
            .await
            .unwrap();
        let seat_b = host
            .call(
                "host",
                "collaboration",
                "space.addMember",
                json!({ "spaceId": space, "conversationId": b, "nickname": "小B", "operationId": Uuid::new_v4() }),
            )
            .await
            .unwrap();
        let conv_a = seat_a
            .get("conversation_id")
            .or_else(|| seat_a.get("conversationId"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| a.to_string());
        let conv_b = seat_b
            .get("conversation_id")
            .or_else(|| seat_b.get("conversationId"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| b.to_string());
        let posted = host
            .call(
                "host",
                "collaboration",
                "space.post",
                json!({
                    "spaceId": space,
                    "content": "@小A 请处理",
                    "to": ["小A"],
                    "operationId": Uuid::new_v4(),
                }),
            )
            .await
            .unwrap();
        let message_id = posted["message_id"].as_str().unwrap().to_string();
        sqlx::query(
            r#"UPDATE collaboration_space_deliveries
               SET receipt_state = 'processing'
               WHERE space_message_id = ?"#,
        )
        .bind(&message_id)
        .execute(&pool)
        .await
        .unwrap();
        let denied = host
            .call(
                "host",
                "collaboration",
                "space.cancelTurn",
                json!({
                    "spaceId": space,
                    "messageId": message_id,
                    "callerId": conv_b,
                }),
            )
            .await
            .unwrap_err();
        assert_eq!(denied.code(), "out_of_scope");
        let cancelled = host
            .call(
                "host",
                "collaboration",
                "space.cancel_turn",
                json!({
                    "spaceId": space,
                    "messageId": message_id,
                    "callerId": conv_a,
                }),
            )
            .await
            .unwrap();
        assert_eq!(cancelled["cancelled"].as_array().unwrap().len(), 1);
        let receipts = host
            .call(
                "host",
                "collaboration",
                "space.receipts",
                json!({ "messageId": message_id }),
            )
            .await
            .unwrap();
        let state = receipts["receipts"][0]["state"].as_str().unwrap();
        assert_eq!(state, "cancelled");
        assert_eq!(
            receipts["receipts"][0]["outcome"].as_str(),
            Some("cancelled")
        );
    }
}
