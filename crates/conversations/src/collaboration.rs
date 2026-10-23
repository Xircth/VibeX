//! Host collaboration control plane.
//!
//! Roles, spawned conversations, same-workspace send, delayed inputs, and
//! collaboration spaces all enter through this module. An immediate message is
//! persisted with [`ConversationInputControl::submit`], then
//! [`IdleTurnDispatcher`] starts a turn when the conversation is idle. Without
//! that dispatcher the receipt stays `queued`. A delayed row has no queue
//! position until the promoter calls the same submit with the row's operation
//! id. Steering never falls back to submit.

use std::sync::Arc;

use agents::{
    AgentId, AgentSessionConfigOverride, ConversationEvent, ConversationInputPayload,
    ConversationRelationKind, ConversationRelationVisibility,
};
use async_trait::async_trait;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use db::models::{
    collaboration_identity::{self as identity, IdentityError},
    conversation_event::AppendConversationEvent,
    session::{CreateSession, Session},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

use crate::{
    ConversationEventAppender, ConversationInputControl, ConversationRelationControl,
    CreateConversationRelation, SubmitConversationInput, remember_creation_session_controls,
    resolve_referenced_session, session_info_value,
};

const ROLE_CAP: i64 = 100;
const TEAM_CAP: i64 = 30;
const LIST_DEFAULT_LIMIT: i64 = 50;
const LIST_HARD_CAP: i64 = 100;
const SPACE_LIST_DEFAULT: i64 = 50;
const SPACE_LIST_HARD_CAP: i64 = 200;
const SUBMIT_HOURLY_CAP: i64 = 60;
const DIGEST_REPLAY_MINUTES: i64 = 10;
const HARD_DELAY_HOURS: i64 = 168;

/// Starts the next durable input when the conversation has no in-flight turn.
/// The Application Core service is the production implementation. A missing
/// dispatcher leaves the input queued; the receipt must not say `dispatched`.
#[async_trait]
pub trait IdleTurnDispatcher: Send + Sync {
    async fn start_if_idle(&self, conversation_id: Uuid) -> Result<Option<Uuid>, String>;
}

/// Publisher and idle-start hook for one host process. Tests omit both.
#[derive(Clone, Default)]
pub struct DeliveryContext {
    pub publisher: Option<Arc<dyn crate::ConversationEventPublisher>>,
    pub dispatcher: Option<Arc<dyn IdleTurnDispatcher>>,
    pub space_changed: Option<Arc<dyn Fn(CollaborationSpaceChangedEvent) + Send + Sync>>,
}

impl DeliveryContext {
    pub fn with_space_changed(
        mut self,
        listener: impl Fn(CollaborationSpaceChangedEvent) + Send + Sync + 'static,
    ) -> Self {
        self.space_changed = Some(Arc::new(listener));
        self
    }

    pub fn notify_space_changed(&self, event: CollaborationSpaceChangedEvent) {
        if let Some(listener) = &self.space_changed {
            listener(event);
        }
    }
}

/// Why a new child cannot be admitted under the shared collaboration budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdmissionDeny {
    Depth { current: u32, limit: u32 },
    Active { active: u32, limit: u32 },
}

/// Depth and active-child decision shared by `delegate_to_agent` and
/// `create_conversation`. Callers supply the active count they can see:
/// the broker adds in-flight tasks, durable creates count living children.
pub fn admit_collaboration_child(
    parent_depth: u32,
    active_children: u32,
    depth_limit: u32,
    max_active_children: u32,
) -> Result<(), AdmissionDeny> {
    let depth_limit = depth_limit.clamp(1, 8);
    let max_active_children = max_active_children.clamp(1, 64);
    let next_depth = parent_depth.saturating_add(1);
    if next_depth > depth_limit {
        return Err(AdmissionDeny::Depth {
            current: next_depth,
            limit: depth_limit,
        });
    }
    if active_children >= max_active_children {
        return Err(AdmissionDeny::Active {
            active: active_children,
            limit: max_active_children,
        });
    }
    Ok(())
}

/// A parent exit cancels a child only when that child is a one-shot delegation.
/// Spawned conversations keep `parent_session_id` for navigation and depth, and
/// leave `delegation_call_id` empty so they never enter the broker's task map.
pub fn parent_exit_cancels_child(delegation_call_id: Option<&str>) -> bool {
    delegation_call_id.is_some_and(|call_id| !call_id.trim().is_empty())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompanionWritePolicy {
    /// Self or a descendant in the same workspace.
    AncestorTree,
    /// Any live conversation in the caller's workspace.
    SameWorkspace,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollaborationError {
    pub code: &'static str,
    pub message: String,
}

impl CollaborationError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "error_code": self.code,
            "message": self.message,
        })
    }
}

impl std::fmt::Display for CollaborationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CollaborationError {}

fn db(error: sqlx::Error) -> CollaborationError {
    CollaborationError::new("conversation_control_failed", error.to_string())
}

fn operation_conflict() -> CollaborationError {
    CollaborationError::new(
        "conversation_control_failed",
        "operation was retried with different content",
    )
}

fn delivery_in_progress() -> CollaborationError {
    CollaborationError::new("conversation_control_failed", "delivery in progress")
}

fn stamp(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn now_stamp() -> String {
    stamp(Utc::now())
}

pub fn bounded_delay_cap_hours(hours: i64) -> i64 {
    hours.clamp(1, HARD_DELAY_HOURS)
}

pub fn default_since_days(configured: Option<i64>) -> i64 {
    configured.unwrap_or(7).clamp(1, 90)
}

#[derive(Debug, Clone, FromRow)]
struct SessionHead {
    workspace_id: Uuid,
    agent_id: Option<String>,
    status: String,
    name: Option<String>,
    deleted_at: Option<String>,
}

async fn load_session(
    pool: &SqlitePool,
    id: Uuid,
) -> Result<Option<SessionHead>, CollaborationError> {
    sqlx::query_as::<_, SessionHead>(
        r#"SELECT workspace_id, agent_id, status, name, deleted_at
           FROM sessions WHERE id = ?"#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(db)
}

fn live_session(head: Option<SessionHead>) -> Result<SessionHead, CollaborationError> {
    match head {
        Some(head) if head.deleted_at.is_none() && head.status != "archived" => Ok(head),
        _ => Err(CollaborationError::new(
            "not_found",
            "conversation was not found",
        )),
    }
}

async fn authorize_write(
    pool: &SqlitePool,
    caller_id: Uuid,
    target_id: Uuid,
    policy: CompanionWritePolicy,
) -> Result<SessionHead, CollaborationError> {
    let caller = live_session(load_session(pool, caller_id).await?)?;
    let target = live_session(load_session(pool, target_id).await?)?;
    if caller.workspace_id != target.workspace_id {
        return Err(CollaborationError::new(
            "not_found",
            "conversation was not found",
        ));
    }
    if policy == CompanionWritePolicy::AncestorTree && caller_id != target_id {
        let descendant = ConversationRelationControl::new(pool.clone())
            .is_descendant(caller_id, target_id)
            .await
            .map_err(db)?;
        if !descendant {
            return Err(CollaborationError::new(
                "out_of_scope",
                "conversation is outside the companion scope",
            ));
        }
    }
    Ok(target)
}

#[derive(Debug, Clone, Serialize)]
pub struct ConversationListItem {
    pub conversation_id: Uuid,
    pub title: Option<String>,
    pub agent_id: Option<String>,
    pub status: String,
    pub updated_at: String,
    pub turn_in_flight: bool,
    pub parent_id: Option<Uuid>,
    pub delegated: bool,
    pub workspace_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_values: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct ListConversations {
    pub caller_id: Uuid,
    pub since_days: i64,
    pub project_id: Option<Uuid>,
    pub workspace_id: Option<Uuid>,
    pub limit: Option<i64>,
}

pub async fn list_conversations(
    pool: &SqlitePool,
    query: ListConversations,
) -> Result<Vec<ConversationListItem>, CollaborationError> {
    let caller = live_session(load_session(pool, query.caller_id).await?)?;
    let workspace_id = query.workspace_id.unwrap_or(caller.workspace_id);
    if workspace_id != caller.workspace_id {
        return Err(CollaborationError::new(
            "not_found",
            "conversation was not found",
        ));
    }
    if let Some(project_id) = query.project_id {
        let owns: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM workspaces WHERE id = ? AND project_id = ? LIMIT 1")
                .bind(workspace_id)
                .bind(project_id)
                .fetch_optional(pool)
                .await
                .map_err(db)?;
        if owns.is_none() {
            return Ok(Vec::new());
        }
    }
    let since_days = query.since_days.clamp(1, 90);
    let cutoff = stamp(Utc::now() - Duration::days(since_days));
    let limit = query
        .limit
        .unwrap_or(LIST_DEFAULT_LIMIT)
        .clamp(1, LIST_HARD_CAP);
    let rows = sqlx::query_as::<_, ListRow>(
        r#"SELECT s.id AS conversation_id,
                  s.name AS title,
                  s.agent_id,
                  s.status,
                  s.updated_at,
                  s.parent_session_id AS parent_id,
                  s.delegation_call_id,
                  s.workspace_id,
                  EXISTS (
                    SELECT 1 FROM conversation_turns turn
                    WHERE turn.conversation_id = s.id
                      AND turn.status IN ('pending', 'queued', 'running', 'blocked')
                  ) AS turn_in_flight_flag,
                  (
                    SELECT binding.current_mode FROM conversation_agent_bindings binding
                    WHERE binding.conversation_id = s.id
                      AND binding.current_mode IS NOT NULL
                      AND trim(binding.current_mode) != ''
                    ORDER BY binding.created_at DESC LIMIT 1
                  ) AS mode_id,
                  (
                    SELECT binding.config_selection_json FROM conversation_agent_bindings binding
                    WHERE binding.conversation_id = s.id
                      AND binding.config_selection_json IS NOT NULL
                      AND binding.config_selection_json NOT IN ('', '{}')
                    ORDER BY binding.created_at DESC LIMIT 1
                  ) AS config_values_json
           FROM sessions s
           WHERE s.deleted_at IS NULL
             AND s.status != 'archived'
             AND s.workspace_id = ?
             AND datetime(replace(substr(s.updated_at, 1, 19), 'T', ' ')) >= datetime(?)
           ORDER BY s.updated_at DESC
           LIMIT ?"#,
    )
    .bind(workspace_id)
    .bind(cutoff)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    Ok(rows.into_iter().map(ListRow::into_item).collect())
}

#[derive(Debug, FromRow)]
struct ListRow {
    conversation_id: Uuid,
    title: Option<String>,
    agent_id: Option<String>,
    status: String,
    updated_at: String,
    parent_id: Option<Uuid>,
    delegation_call_id: Option<String>,
    workspace_id: Uuid,
    turn_in_flight_flag: i64,
    mode_id: Option<String>,
    config_values_json: Option<String>,
}

impl ListRow {
    fn into_item(self) -> ConversationListItem {
        let config_values = self.config_values_json.as_deref().and_then(|raw| {
            let value: Value = serde_json::from_str(raw).ok()?;
            (value != Value::Null && value != json!({})).then_some(value)
        });
        let mode_id = self.mode_id.filter(|mode| !mode.trim().is_empty());
        ConversationListItem {
            conversation_id: self.conversation_id,
            title: self.title.filter(|title| !title.trim().is_empty()),
            agent_id: self.agent_id.filter(|agent| !agent.trim().is_empty()),
            status: self.status,
            updated_at: self.updated_at,
            turn_in_flight: self.turn_in_flight_flag != 0,
            parent_id: self.parent_id,
            delegated: parent_exit_cancels_child(self.delegation_call_id.as_deref()),
            workspace_id: self.workspace_id,
            mode_id,
            config_values,
        }
    }
}

pub async fn read_session_info_for_delegation(
    pool: &SqlitePool,
    conversation_id: &str,
    max_messages: u32,
) -> Value {
    read_session_info(pool, conversation_id, max_messages).await
}

pub async fn read_session_info_for_session_product(
    pool: &SqlitePool,
    conversation_id: &str,
    max_messages: u32,
) -> Value {
    read_session_info(pool, conversation_id, max_messages).await
}

async fn read_session_info(pool: &SqlitePool, conversation_id: &str, max_messages: u32) -> Value {
    let info = resolve_referenced_session(pool, conversation_id, max_messages).await;
    session_info_value(&info)
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct TeamRecord {
    pub id: String,
    pub name: String,
    pub summary: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SaveTeam {
    pub id: Option<String>,
    pub name: String,
    pub summary: Option<String>,
}

pub async fn create_team(
    pool: &SqlitePool,
    input: SaveTeam,
) -> Result<TeamRecord, CollaborationError> {
    let name = require_name(&input.name)?;
    let id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let stamp = now_stamp();
    let mut conn = pool.acquire().await.map_err(db)?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    let outcome = async {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM collaboration_teams")
            .fetch_one(&mut *conn)
            .await?;
        if count >= TEAM_CAP {
            return Err(CollaborationError::new(
                "limit_exceeded",
                "team limit is 30",
            ));
        }
        sqlx::query(
            "INSERT INTO collaboration_teams (id, name, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&name)
        .bind(input.summary.as_deref())
        .bind(&stamp)
        .bind(&stamp)
        .execute(&mut *conn)
        .await?;
        Ok(TeamRecord {
            id,
            name,
            summary: input.summary,
        })
    }
    .await;
    finish_tx(&mut conn, outcome).await
}

pub async fn update_team(
    pool: &SqlitePool,
    id: &str,
    input: SaveTeam,
) -> Result<TeamRecord, CollaborationError> {
    let name = require_name(&input.name)?;
    let changed = sqlx::query(
        "UPDATE collaboration_teams SET name = ?, summary = ?, updated_at = ? WHERE id = ?",
    )
    .bind(&name)
    .bind(input.summary.as_deref())
    .bind(now_stamp())
    .bind(id)
    .execute(pool)
    .await
    .map_err(db)?;
    if changed.rows_affected() == 0 {
        return Err(CollaborationError::new("not_found", "team was not found"));
    }
    Ok(TeamRecord {
        id: id.to_string(),
        name,
        summary: input.summary,
    })
}

pub async fn delete_team(pool: &SqlitePool, id: &str) -> Result<(), CollaborationError> {
    sqlx::query("UPDATE collaboration_roles SET team_id = NULL, updated_at = ? WHERE team_id = ?")
        .bind(now_stamp())
        .bind(id)
        .execute(pool)
        .await
        .map_err(db)?;
    let changed = sqlx::query("DELETE FROM collaboration_teams WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(db)?;
    if changed.rows_affected() == 0 {
        return Err(CollaborationError::new("not_found", "team was not found"));
    }
    Ok(())
}

pub async fn list_teams(pool: &SqlitePool) -> Result<Vec<TeamRecord>, CollaborationError> {
    sqlx::query_as::<_, TeamRecord>(
        "SELECT id, name, summary FROM collaboration_teams ORDER BY created_at, id",
    )
    .fetch_all(pool)
    .await
    .map_err(db)
}

#[derive(Debug, Clone, Serialize)]
pub struct RoleRecord {
    pub id: String,
    pub name: String,
    pub team_id: Option<String>,
    pub summary: String,
    pub persona_prompt: String,
    pub agent_id: String,
    pub mode_id: Option<String>,
    pub config_values: Value,
}

#[derive(Debug, Clone)]
pub struct SaveRole {
    pub id: Option<String>,
    pub name: String,
    pub team_id: Option<String>,
    pub summary: String,
    pub persona_prompt: String,
    pub agent_id: String,
    pub mode_id: Option<String>,
    pub config_values: Value,
}

pub async fn create_role(
    pool: &SqlitePool,
    input: SaveRole,
) -> Result<RoleRecord, CollaborationError> {
    let name = require_name(&input.name)?;
    let agent_id = require_agent(&input.agent_id)?;
    let id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let config = config_object(&input.config_values);
    let stamp = now_stamp();
    let mut conn = pool.acquire().await.map_err(db)?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    let outcome = async {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM collaboration_roles")
            .fetch_one(&mut *conn)
            .await?;
        if count >= ROLE_CAP {
            return Err(CollaborationError::new(
                "limit_exceeded",
                "role limit is 100",
            ));
        }
        sqlx::query(
            r#"INSERT INTO collaboration_roles
               (id, name, team_id, summary, persona_prompt, agent_id, mode_id, config_values_json, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&id)
        .bind(&name)
        .bind(input.team_id.as_deref())
        .bind(&input.summary)
        .bind(&input.persona_prompt)
        .bind(&agent_id)
        .bind(input.mode_id.as_deref())
        .bind(config.to_string())
        .bind(&stamp)
        .bind(&stamp)
        .execute(&mut *conn)
        .await?;
        Ok(RoleRecord {
            id,
            name,
            team_id: input.team_id,
            summary: input.summary,
            persona_prompt: input.persona_prompt,
            agent_id,
            mode_id: input.mode_id,
            config_values: config,
        })
    }
    .await;
    finish_tx(&mut conn, outcome).await
}

pub async fn update_role(
    pool: &SqlitePool,
    id: &str,
    input: SaveRole,
) -> Result<RoleRecord, CollaborationError> {
    let name = require_name(&input.name)?;
    let agent_id = require_agent(&input.agent_id)?;
    let config = config_object(&input.config_values);
    let changed = sqlx::query(
        r#"UPDATE collaboration_roles
           SET name = ?, team_id = ?, summary = ?, persona_prompt = ?, agent_id = ?,
               mode_id = ?, config_values_json = ?, updated_at = ?
           WHERE id = ?"#,
    )
    .bind(&name)
    .bind(input.team_id.as_deref())
    .bind(&input.summary)
    .bind(&input.persona_prompt)
    .bind(&agent_id)
    .bind(input.mode_id.as_deref())
    .bind(config.to_string())
    .bind(now_stamp())
    .bind(id)
    .execute(pool)
    .await
    .map_err(db)?;
    if changed.rows_affected() == 0 {
        return Err(CollaborationError::new("not_found", "role was not found"));
    }
    Ok(RoleRecord {
        id: id.to_string(),
        name,
        team_id: input.team_id,
        summary: input.summary,
        persona_prompt: input.persona_prompt,
        agent_id,
        mode_id: input.mode_id,
        config_values: config,
    })
}

pub async fn delete_role(pool: &SqlitePool, id: &str) -> Result<(), CollaborationError> {
    sqlx::query("UPDATE conversation_personas SET role_id = NULL WHERE role_id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(db)?;
    let changed = sqlx::query("DELETE FROM collaboration_roles WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(db)?;
    if changed.rows_affected() == 0 {
        return Err(CollaborationError::new("not_found", "role was not found"));
    }
    Ok(())
}

pub async fn list_roles(pool: &SqlitePool) -> Result<Vec<RoleRecord>, CollaborationError> {
    let rows = sqlx::query_as::<_, RoleRow>(
        r#"SELECT id, name, team_id, summary, persona_prompt, agent_id, mode_id, config_values_json
           FROM collaboration_roles ORDER BY created_at, id"#,
    )
    .fetch_all(pool)
    .await
    .map_err(db)?;
    Ok(rows.into_iter().map(RoleRow::into_record).collect())
}

#[derive(Debug, FromRow)]
struct RoleRow {
    id: String,
    name: String,
    team_id: Option<String>,
    summary: String,
    persona_prompt: String,
    agent_id: String,
    mode_id: Option<String>,
    config_values_json: String,
}

impl RoleRow {
    fn into_record(self) -> RoleRecord {
        RoleRecord {
            id: self.id,
            name: self.name,
            team_id: self.team_id,
            summary: self.summary,
            persona_prompt: self.persona_prompt,
            agent_id: self.agent_id,
            mode_id: self.mode_id,
            config_values: serde_json::from_str(&self.config_values_json)
                .unwrap_or_else(|_| json!({})),
        }
    }
}

#[derive(Debug, Clone)]
pub struct CreateSpawnedConversation {
    pub caller_id: Uuid,
    pub operation_id: Uuid,
    pub role_id: Option<String>,
    pub agent_id: Option<String>,
    pub title: Option<String>,
    pub prompt: Option<String>,
    pub mode_id: Option<String>,
    pub config_values: Option<Value>,
    pub depth_limit: u32,
    pub max_active_children: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct CreatedConversation {
    pub conversation_id: Uuid,
    #[serde(skip_serializing_if = "is_false")]
    pub idempotent_replay: bool,
}

pub async fn collaboration_parent_depth(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<u32, CollaborationError> {
    let mut current = conversation_id;
    let mut depth = 0u32;
    for _ in 0..8 {
        let parent = sqlx::query_scalar::<_, Option<Uuid>>(
            "SELECT parent_session_id FROM sessions WHERE id = ?",
        )
        .bind(current)
        .fetch_optional(pool)
        .await
        .map_err(db)?
        .flatten();
        let Some(parent) = parent else {
            break;
        };
        depth += 1;
        current = parent;
    }
    Ok(depth)
}

pub async fn active_collaboration_children(
    pool: &SqlitePool,
    parent_id: Uuid,
) -> Result<u32, CollaborationError> {
    let count: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM sessions AS child
           WHERE child.parent_session_id = ?
             AND child.deleted_at IS NULL
             AND child.status != 'archived'
             AND (
               NOT EXISTS (
                 SELECT 1 FROM conversation_turns AS turn
                 WHERE turn.conversation_id = child.id
               )
               OR EXISTS (
                 SELECT 1 FROM conversation_turns AS turn
                 WHERE turn.conversation_id = child.id
                   AND turn.status IN ('pending', 'queued', 'running', 'blocked')
               )
             )"#,
    )
    .bind(parent_id)
    .fetch_one(pool)
    .await
    .map_err(db)?;
    Ok(u32::try_from(count).unwrap_or(u32::MAX))
}

pub async fn create_spawned_conversation(
    pool: &SqlitePool,
    input: CreateSpawnedConversation,
) -> Result<CreatedConversation, CollaborationError> {
    let caller = live_session(load_session(pool, input.caller_id).await?)?;
    let request = spawn_request(&input);
    if let Some(stored) = load_create_operation(pool, input.operation_id).await? {
        if stored.caller_id != input.caller_id.to_string()
            || stored.request_json != request.to_string()
        {
            return Err(operation_conflict());
        }
        return Ok(CreatedConversation {
            conversation_id: input.operation_id,
            idempotent_replay: true,
        });
    }
    let existing = load_session(pool, input.operation_id).await?;
    let role = match input.role_id.as_deref() {
        Some(role_id) => Some(load_role(pool, role_id).await?),
        None => None,
    };
    let agent_raw = role
        .as_ref()
        .map(|role| role.agent_id.clone())
        .or(input.agent_id.clone())
        .ok_or_else(|| CollaborationError::new("not_found", "agent_id is required"))?;
    let agent_id = AgentId::parse(&agent_raw)
        .map_err(|_| CollaborationError::new("not_found", "agent_id is required"))?;
    let title = input
        .title
        .clone()
        .filter(|title| !title.trim().is_empty())
        .or_else(|| role.as_ref().map(|role| role.name.clone()));
    let (mode_id, config_values) = if let Some(role) = role.as_ref() {
        (role.mode_id.clone(), role.config_values.clone())
    } else {
        (
            input.mode_id.clone(),
            input.config_values.clone().unwrap_or_else(|| json!({})),
        )
    };
    let repairing = if let Some(existing) = existing {
        if existing.workspace_id != caller.workspace_id
            || existing.agent_id.as_deref() != Some(agent_raw.as_str())
        {
            return Err(operation_conflict());
        }
        if let (Some(existing_name), Some(expected)) = (existing.name.as_deref(), title.as_deref())
        {
            if existing_name != expected {
                return Err(operation_conflict());
            }
        }
        true
    } else {
        let depth = collaboration_parent_depth(pool, input.caller_id).await?;
        let active = active_collaboration_children(pool, input.caller_id).await?;
        if let Err(deny) =
            admit_collaboration_child(depth, active, input.depth_limit, input.max_active_children)
        {
            let message = match deny {
                AdmissionDeny::Depth { current, limit } => {
                    format!("depth {current} exceeds limit {limit}")
                }
                AdmissionDeny::Active { active, limit } => {
                    format!("{active} active children meet limit {limit}")
                }
            };
            return Err(CollaborationError::new("limit_exceeded", message));
        }
        Session::create(
            pool,
            &CreateSession {
                executor: None,
                agent_id: Some(agent_id),
                task_id: None,
                name: title.clone(),
                initial_prompt: input.prompt.clone(),
                status: None,
            },
            input.operation_id,
            caller.workspace_id,
        )
        .await
        .map_err(|error| {
            CollaborationError::new("conversation_control_failed", error.to_string())
        })?;
        false
    };
    let parent_id = sqlx::query_scalar::<_, Option<Uuid>>(
        "SELECT parent_session_id FROM sessions WHERE id = ?",
    )
    .bind(input.operation_id)
    .fetch_optional(pool)
    .await
    .map_err(db)?
    .flatten();
    if let Some(parent_id) = parent_id {
        if parent_id != input.caller_id {
            return Err(operation_conflict());
        }
    } else {
        sqlx::query(
            "UPDATE sessions SET parent_session_id = ? WHERE id = ? AND parent_session_id IS NULL",
        )
        .bind(input.caller_id)
        .bind(input.operation_id)
        .execute(pool)
        .await
        .map_err(db)?;
    }
    ConversationRelationControl::new(pool.clone())
        .create(CreateConversationRelation {
            parent_conversation_id: input.caller_id,
            child_conversation_id: input.operation_id,
            kind: ConversationRelationKind::Spawned,
            visibility: ConversationRelationVisibility::Visible,
            metadata: json!({ "source": "create_conversation" }),
        })
        .await
        .map_err(db)?;
    if let Some(role) = role.as_ref() {
        let team_name = match role.team_id.as_deref() {
            Some(team_id) => {
                sqlx::query_scalar::<_, String>("SELECT name FROM collaboration_teams WHERE id = ?")
                    .bind(team_id)
                    .fetch_optional(pool)
                    .await
                    .map_err(db)?
            }
            None => None,
        };
        sqlx::query(
            r#"INSERT INTO conversation_personas
               (conversation_id, role_id, name, team_name, summary, agent_id,
                persona_prompt, snapshotted_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(conversation_id) DO NOTHING"#,
        )
        .bind(input.operation_id.to_string())
        .bind(&role.id)
        .bind(&role.name)
        .bind(team_name.as_deref())
        .bind(&role.summary)
        .bind(&role.agent_id)
        .bind(&role.persona_prompt)
        .bind(now_stamp())
        .execute(pool)
        .await
        .map_err(db)?;
        if !role.persona_prompt.trim().is_empty() {
            append_persona_notice(pool, input.operation_id, &role.persona_prompt).await?;
        }
    }
    let overrides = config_overrides(&config_values);
    remember_creation_session_controls(pool, input.operation_id, mode_id.as_deref(), overrides)
        .await;
    store_create_operation(pool, &input, &request).await?;
    Ok(CreatedConversation {
        conversation_id: input.operation_id,
        idempotent_replay: repairing,
    })
}

fn spawn_request(input: &CreateSpawnedConversation) -> Value {
    json!({
        "agent_id": input.agent_id,
        "caller_id": input.caller_id,
        "config_values": input.config_values,
        "mode_id": input.mode_id,
        "prompt": input.prompt,
        "role_id": input.role_id,
        "title": input.title,
    })
}

struct StoredCreateOperation {
    caller_id: String,
    request_json: String,
}

async fn load_create_operation(
    pool: &SqlitePool,
    operation_id: Uuid,
) -> Result<Option<StoredCreateOperation>, CollaborationError> {
    let row = sqlx::query_as::<_, (String, String)>(
        r#"SELECT caller_id, request_json FROM collaboration_create_operations
           WHERE operation_id = ?"#,
    )
    .bind(operation_id.to_string())
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    Ok(row.map(|(caller_id, request_json)| StoredCreateOperation {
        caller_id,
        request_json,
    }))
}

async fn store_create_operation(
    pool: &SqlitePool,
    input: &CreateSpawnedConversation,
    request: &Value,
) -> Result<(), CollaborationError> {
    sqlx::query(
        r#"INSERT INTO collaboration_create_operations
           (operation_id, caller_id, request_json, conversation_id, created_at)
           VALUES (?, ?, ?, ?, ?)"#,
    )
    .bind(input.operation_id.to_string())
    .bind(input.caller_id.to_string())
    .bind(request.to_string())
    .bind(input.operation_id.to_string())
    .bind(now_stamp())
    .execute(pool)
    .await
    .map_err(db)?;
    Ok(())
}

async fn load_role(pool: &SqlitePool, id: &str) -> Result<RoleRecord, CollaborationError> {
    let row = sqlx::query_as::<_, RoleRow>(
        r#"SELECT id, name, team_id, summary, persona_prompt, agent_id, mode_id, config_values_json
           FROM collaboration_roles WHERE id = ?"#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(db)?
    .ok_or_else(|| CollaborationError::new("not_found", "role was not found"))?;
    Ok(row.into_record())
}

async fn append_persona_notice(
    pool: &SqlitePool,
    conversation_id: Uuid,
    persona_prompt: &str,
) -> Result<(), CollaborationError> {
    let event = ConversationEvent::RawDiagnosticRecorded {
        label: "host_note".to_string(),
        payload: Some(json!({
            "kind": "host_note",
            "title": "人设",
            "message": persona_prompt,
            "announcementId": "host-note:persona",
        })),
    };
    let normalized = serde_json::to_string(&event).map_err(|error| {
        CollaborationError::new("conversation_control_failed", error.to_string())
    })?;
    let key = format!("persona-notice:{conversation_id}");
    ConversationEventAppender::append(
        pool,
        AppendConversationEvent {
            id: Uuid::new_v4(),
            conversation_id,
            turn_id: None,
            binding_id: None,
            connection_id: None,
            prompt_id: None,
            source: "host",
            event_kind: "raw_diagnostic_recorded",
            normalized_json: &normalized,
            raw_json: None,
            idempotency_key: Some(&key),
        },
    )
    .await
    .map_err(db)?;
    Ok(())
}

pub async fn persona_prompt_text(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Option<String>, CollaborationError> {
    let prompt: Option<String> = sqlx::query_scalar::<_, String>(
        "SELECT persona_prompt FROM conversation_personas WHERE conversation_id = ?",
    )
    .bind(conversation_id.to_string())
    .fetch_optional(pool)
    .await
    .map_err(db)?
    .filter(|value: &String| !value.trim().is_empty());
    let space_context = member_space_context_text(pool, conversation_id).await?;
    match (prompt, space_context) {
        (Some(persona), Some(context)) => Ok(Some(format!("{}\n\n{}", persona.trim(), context))),
        (Some(persona), None) => Ok(Some(persona)),
        (None, Some(context)) => Ok(Some(context)),
        (None, None) => Ok(None),
    }
}

/// Standing instruction the user already sees as the first host note.
/// Repeated on each agent prompt so a cold session still receives it.
pub fn prefix_persona_prompt(persona: &str, text: &str) -> String {
    let persona = persona.trim();
    if persona.is_empty() {
        return text.to_string();
    }
    let header = if persona.starts_with("[协作空间成员身份]") {
        persona.to_string()
    } else {
        format!("人设\n{persona}")
    };
    let text = text.trim();
    if text.is_empty() {
        return header;
    }
    format!("{header}\n\n{text}")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendReceipt {
    pub delivered: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delayed_input_id: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub idempotent_replay: bool,
}

#[derive(Debug, Clone)]
pub struct SendSessionInput {
    pub caller_id: Uuid,
    pub conversation_id: Uuid,
    pub operation_id: Uuid,
    pub text: String,
    pub policy: CompanionWritePolicy,
    pub steer: bool,
    pub steer_supported: bool,
    pub expected_turn_id: Option<Uuid>,
    pub delay_seconds: Option<i64>,
    pub deliver_at: Option<String>,
    pub delay_cap_hours: i64,
}

pub async fn prepare_steer(
    pool: &SqlitePool,
    input: &SendSessionInput,
) -> Result<Uuid, CollaborationError> {
    if !input.steer_supported {
        return Err(CollaborationError::new(
            "steer_unsupported",
            "this conversation cannot accept steering",
        ));
    }
    authorize_write(pool, input.caller_id, input.conversation_id, input.policy).await?;
    let expected = input.expected_turn_id.ok_or_else(|| {
        CollaborationError::new("steer_no_active_turn", "expected_turn_id is required")
    })?;
    let active = active_turn_id(pool, input.conversation_id).await?;
    let Some(active) = active else {
        return Err(CollaborationError::new(
            "steer_no_active_turn",
            "conversation has no active turn",
        ));
    };
    if active != expected {
        return Err(CollaborationError::new(
            "steer_conflict",
            "active turn changed",
        ));
    }
    Ok(expected)
}

pub async fn send_session_input(
    pool: &SqlitePool,
    input: SendSessionInput,
) -> Result<SendReceipt, CollaborationError> {
    send_session_input_with(pool, input, &DeliveryContext::default()).await
}

pub async fn send_session_input_with(
    pool: &SqlitePool,
    input: SendSessionInput,
    delivery: &DeliveryContext,
) -> Result<SendReceipt, CollaborationError> {
    if input.text.trim().is_empty() {
        return Err(CollaborationError::new(
            "conversation_control_failed",
            "text must not be empty",
        ));
    }
    if input.steer {
        prepare_steer(pool, &input).await?;
        return Err(CollaborationError::new(
            "steer_unsupported",
            "steering is applied by the conversation service, not by queueing",
        ));
    }
    let target =
        authorize_write(pool, input.caller_id, input.conversation_id, input.policy).await?;
    let cap = bounded_delay_cap_hours(input.delay_cap_hours);
    if let Some(when) = scheduled_deadline(&input, cap)? {
        let receipt = schedule_input(pool, &input, &target, when).await?;
        delivery.notify_space_changed(CollaborationSpaceChangedEvent {
            workspace_id: target.workspace_id,
            space_id: format!("session:{}", input.conversation_id),
            seq: None,
            member_id: Some(input.caller_id.to_string()),
        });
        return Ok(receipt);
    }
    deliver_text(
        pool,
        input.conversation_id,
        input.operation_id,
        &input.text,
        None,
        &target,
        json!({
            "kind": "companion",
            "parentConversationId": input.caller_id,
        }),
        delivery,
    )
    .await
}

fn scheduled_deadline(
    input: &SendSessionInput,
    cap_hours: i64,
) -> Result<Option<DateTime<Utc>>, CollaborationError> {
    let cap = Duration::hours(cap_hours);
    let now = Utc::now();
    let has_seconds = input.delay_seconds.is_some();
    let has_deadline = input
        .deliver_at
        .as_deref()
        .is_some_and(|raw| !raw.trim().is_empty());
    if has_seconds && has_deadline {
        return Err(CollaborationError::new(
            "conversation_control_failed",
            "delay_seconds and deliver_at are mutually exclusive",
        ));
    }
    if let Some(seconds) = input.delay_seconds {
        if seconds <= 0 {
            return Ok(None);
        }
        if seconds > cap.num_seconds() {
            return Err(CollaborationError::new(
                "delay_exceeds_cap",
                format!("delay exceeds {cap_hours} hours"),
            ));
        }
        return Ok(Some(now + Duration::seconds(seconds)));
    }
    let Some(raw) = input.deliver_at.as_deref() else {
        return Ok(None);
    };
    let when = DateTime::parse_from_rfc3339(raw)
        .map(|parsed| parsed.with_timezone(&Utc))
        .map_err(|_| {
            CollaborationError::new("conversation_control_failed", "deliver_at must be RFC3339")
        })?;
    if when - now > cap {
        return Err(CollaborationError::new(
            "delay_exceeds_cap",
            format!("delay exceeds {cap_hours} hours"),
        ));
    }
    if when <= now {
        return Ok(None);
    }
    Ok(Some(when))
}

async fn schedule_input(
    pool: &SqlitePool,
    input: &SendSessionInput,
    target: &SessionHead,
    deliver_at: DateTime<Utc>,
) -> Result<SendReceipt, CollaborationError> {
    let digest = digest_text(&input.text);
    let principal = json!({
        "kind": "companion",
        "parentConversationId": input.caller_id,
    })
    .to_string();
    let payload = json!({
        "text": input.text,
        "agent_id": target.agent_id,
        "workspace_id": target.workspace_id,
    });
    let mut conn = pool.acquire().await.map_err(db)?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    let outcome = async {
        let existing = sqlx::query_as::<_, (String, String, String)>(
            r#"SELECT id, payload_digest, principal_json FROM conversation_delayed_inputs
               WHERE conversation_id = ? AND operation_id = ?"#,
        )
        .bind(input.conversation_id.to_string())
        .bind(input.operation_id.to_string())
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
        if let Some((id, stored_digest, stored_principal)) = existing {
            if stored_digest != digest || stored_principal != principal {
                return Err(operation_conflict());
            }
            return Ok(SendReceipt {
                delivered: "scheduled".to_string(),
                input_id: None,
                turn_id: None,
                delayed_input_id: Some(id),
                idempotent_replay: true,
            });
        }
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            r#"INSERT INTO conversation_delayed_inputs
               (id, conversation_id, operation_id, payload_json, payload_digest, principal_json,
                deliver_at, status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)"#,
        )
        .bind(&id)
        .bind(input.conversation_id.to_string())
        .bind(input.operation_id.to_string())
        .bind(payload.to_string())
        .bind(&digest)
        .bind(&principal)
        .bind(stamp(deliver_at))
        .bind(now_stamp())
        .execute(&mut *conn)
        .await
        .map_err(db)?;
        Ok(SendReceipt {
            delivered: "scheduled".to_string(),
            input_id: None,
            turn_id: None,
            delayed_input_id: Some(id),
            idempotent_replay: false,
        })
    }
    .await;
    finish_immediate(&mut conn, outcome).await
}

enum ClaimGate {
    Replay(SendReceipt),
    InProgress,
    Reserved,
}

async fn deliver_text(
    pool: &SqlitePool,
    conversation_id: Uuid,
    operation_id: Uuid,
    text: &str,
    display_text: Option<String>,
    target: &SessionHead,
    principal: Value,
    delivery: &DeliveryContext,
) -> Result<SendReceipt, CollaborationError> {
    let digest = digest_text(text);
    let principal_key = principal.to_string();
    let conversation_key = conversation_id.to_string();
    let operation_key = operation_id.to_string();
    let mut reserved = false;
    for attempt in 0..8 {
        match reserve_send_claim(
            pool,
            &conversation_key,
            &operation_key,
            &digest,
            &principal_key,
        )
        .await?
        {
            ClaimGate::Replay(receipt) => return Ok(receipt),
            ClaimGate::Reserved => {
                reserved = true;
                break;
            }
            ClaimGate::InProgress => {
                if attempt == 7 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
        }
    }
    if !reserved {
        if let Some(receipt) =
            finish_unreceipted_claim(pool, conversation_id, operation_id, delivery).await?
        {
            return Ok(receipt);
        }
        return Err(delivery_in_progress());
    }
    let agent_raw = target.agent_id.clone().ok_or_else(|| {
        CollaborationError::new("conversation_missing_agent", "conversation has no agent")
    })?;
    let agent_id = AgentId::parse(&agent_raw).map_err(|error| {
        CollaborationError::new("conversation_control_failed", error.to_string())
    })?;
    let busy = active_turn_id(pool, conversation_id).await?;
    let inputs = match &delivery.publisher {
        Some(publisher) => {
            ConversationInputControl::with_publisher(pool.clone(), publisher.clone())
        }
        None => ConversationInputControl::new(pool.clone()),
    };
    let submitted = match inputs
        .submit(SubmitConversationInput {
            conversation_id,
            operation_id,
            payload: ConversationInputPayload {
                agent_id,
                workspace_id: target.workspace_id,
                executor_profile_id: None,
                text: text.to_string(),
                display_text,
                images: Vec::new(),
                mode_override: None,
                config_overrides: Vec::new(),
                workflow_refs: Vec::new(),
                file_refs: Vec::new(),
                internal_prompt_contributions: Vec::new(),
            },
            principal,
        })
        .await
    {
        Ok(submitted) => submitted,
        Err(error) => {
            release_send_claim(pool, &conversation_key, &operation_key).await;
            return Err(CollaborationError::new(
                "conversation_control_failed",
                error.to_string(),
            ));
        }
    };
    let (delivered, turn_id) = receipt_delivery(conversation_id, busy, delivery).await;
    let receipt = SendReceipt {
        delivered,
        input_id: Some(submitted.id),
        turn_id,
        delayed_input_id: None,
        idempotent_replay: false,
    };
    if let Err(error) = record_send_receipt(pool, &conversation_key, &operation_key, &receipt).await
    {
        tracing::warn!(%error, "collaboration receipt was not stored");
    }
    Ok(receipt)
}

async fn receipt_delivery(
    conversation_id: Uuid,
    busy: Option<Uuid>,
    delivery: &DeliveryContext,
) -> (String, Option<Uuid>) {
    if let Some(active) = busy {
        return ("queued".to_string(), Some(active));
    }
    let Some(dispatcher) = &delivery.dispatcher else {
        return ("queued".to_string(), None);
    };
    match dispatcher.start_if_idle(conversation_id).await {
        Ok(Some(turn_id)) => ("dispatched".to_string(), Some(turn_id)),
        Ok(None) => ("queued".to_string(), None),
        Err(error) => {
            tracing::warn!(%error, "idle turn dispatch failed");
            ("queued".to_string(), None)
        }
    }
}

async fn reserve_send_claim(
    pool: &SqlitePool,
    conversation_id: &str,
    operation_id: &str,
    digest: &str,
    principal: &str,
) -> Result<ClaimGate, CollaborationError> {
    let mut conn = pool.acquire().await.map_err(db)?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    let outcome =
        reserve_send_claim_locked(&mut conn, conversation_id, operation_id, digest, principal)
            .await;
    finish_immediate(&mut conn, outcome).await
}

async fn reserve_send_claim_locked(
    conn: &mut sqlx::SqliteConnection,
    conversation_id: &str,
    operation_id: &str,
    digest: &str,
    principal: &str,
) -> Result<ClaimGate, CollaborationError> {
    let existing = sqlx::query_as::<_, (String, String, Option<String>)>(
        r#"SELECT payload_digest, principal_json, receipt_json
           FROM collaboration_send_claim
           WHERE conversation_id = ? AND operation_id = ?"#,
    )
    .bind(conversation_id)
    .bind(operation_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?;
    if let Some((stored_digest, stored_principal, receipt)) = existing {
        if stored_digest != digest || stored_principal != principal {
            return Err(operation_conflict());
        }
        if let Some(raw) = receipt {
            return Ok(ClaimGate::Replay(replay_receipt(&raw)?));
        }
        return Ok(ClaimGate::InProgress);
    }
    let replay_after = stamp(Utc::now() - Duration::minutes(DIGEST_REPLAY_MINUTES));
    let digest_hit = sqlx::query_as::<_, (String,)>(
        r#"SELECT receipt_json FROM collaboration_send_claim
           WHERE conversation_id = ? AND payload_digest = ? AND counts = 1
             AND receipt_json IS NOT NULL AND created_at >= ?
           ORDER BY created_at ASC LIMIT 1"#,
    )
    .bind(conversation_id)
    .bind(digest)
    .bind(&replay_after)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?;
    if let Some((raw,)) = digest_hit {
        sqlx::query(
            r#"INSERT INTO collaboration_send_claim
               (conversation_id, operation_id, payload_digest, principal_json, receipt_json,
                counts, created_at)
               VALUES (?, ?, ?, ?, ?, 0, ?)"#,
        )
        .bind(conversation_id)
        .bind(operation_id)
        .bind(digest)
        .bind(principal)
        .bind(&raw)
        .bind(now_stamp())
        .execute(&mut *conn)
        .await
        .map_err(db)?;
        return Ok(ClaimGate::Replay(replay_receipt(&raw)?));
    }
    let in_flight_digest: Option<i64> = sqlx::query_scalar(
        r#"SELECT 1 FROM collaboration_send_claim
           WHERE conversation_id = ? AND payload_digest = ? AND counts = 1
             AND receipt_json IS NULL AND created_at >= ?
           LIMIT 1"#,
    )
    .bind(conversation_id)
    .bind(digest)
    .bind(&replay_after)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?;
    if in_flight_digest.is_some() {
        return Ok(ClaimGate::InProgress);
    }
    let hour_ago = stamp(Utc::now() - Duration::hours(1));
    let recent: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM collaboration_send_claim
           WHERE conversation_id = ? AND counts = 1 AND created_at >= ?"#,
    )
    .bind(conversation_id)
    .bind(&hour_ago)
    .fetch_one(&mut *conn)
    .await
    .map_err(db)?;
    if recent >= SUBMIT_HOURLY_CAP {
        return Err(CollaborationError::new(
            "limit_exceeded",
            "this conversation can accept 60 new messages per hour",
        ));
    }
    sqlx::query(
        r#"INSERT INTO collaboration_send_claim
           (conversation_id, operation_id, payload_digest, principal_json, receipt_json,
            counts, created_at)
           VALUES (?, ?, ?, ?, NULL, 1, ?)"#,
    )
    .bind(conversation_id)
    .bind(operation_id)
    .bind(digest)
    .bind(principal)
    .bind(now_stamp())
    .execute(&mut *conn)
    .await
    .map_err(db)?;
    Ok(ClaimGate::Reserved)
}

fn replay_receipt(raw: &str) -> Result<SendReceipt, CollaborationError> {
    let mut receipt: SendReceipt = serde_json::from_str(raw).map_err(|error| {
        CollaborationError::new("conversation_control_failed", error.to_string())
    })?;
    receipt.idempotent_replay = true;
    Ok(receipt)
}

async fn finish_immediate<T>(
    conn: &mut sqlx::SqliteConnection,
    outcome: Result<T, CollaborationError>,
) -> Result<T, CollaborationError> {
    match outcome {
        Ok(value) => {
            if let Err(error) = sqlx::query("COMMIT").execute(&mut *conn).await {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                return Err(db(error));
            }
            Ok(value)
        }
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            Err(error)
        }
    }
}

async fn release_send_claim(pool: &SqlitePool, conversation_id: &str, operation_id: &str) {
    if let Err(error) = sqlx::query(
        r#"DELETE FROM collaboration_send_claim
           WHERE conversation_id = ? AND operation_id = ? AND receipt_json IS NULL"#,
    )
    .bind(conversation_id)
    .bind(operation_id)
    .execute(pool)
    .await
    {
        tracing::warn!(%error, "collaboration claim was not released");
    }
}

async fn record_send_receipt(
    pool: &SqlitePool,
    conversation_id: &str,
    operation_id: &str,
    receipt: &SendReceipt,
) -> Result<(), CollaborationError> {
    let raw = serde_json::to_string(receipt).map_err(|error| {
        CollaborationError::new("conversation_control_failed", error.to_string())
    })?;
    sqlx::query(
        r#"UPDATE collaboration_send_claim
           SET receipt_json = ?
           WHERE conversation_id = ? AND operation_id = ? AND receipt_json IS NULL"#,
    )
    .bind(raw)
    .bind(conversation_id)
    .bind(operation_id)
    .execute(pool)
    .await
    .map_err(db)?;
    Ok(())
}

async fn finish_unreceipted_claim(
    pool: &SqlitePool,
    conversation_id: Uuid,
    operation_id: Uuid,
    delivery: &DeliveryContext,
) -> Result<Option<SendReceipt>, CollaborationError> {
    let input_id: Option<Uuid> = sqlx::query_scalar(
        r#"SELECT id FROM conversation_inputs
           WHERE conversation_id = ? AND operation_id = ?"#,
    )
    .bind(conversation_id)
    .bind(operation_id)
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    let Some(input_id) = input_id else {
        return Ok(None);
    };
    let busy = active_turn_id(pool, conversation_id).await?;
    let (delivered, turn_id) = receipt_delivery(conversation_id, busy, delivery).await;
    let receipt = SendReceipt {
        delivered,
        input_id: Some(input_id),
        turn_id,
        delayed_input_id: None,
        idempotent_replay: true,
    };
    record_send_receipt(
        pool,
        &conversation_id.to_string(),
        &operation_id.to_string(),
        &receipt,
    )
    .await?;
    Ok(Some(receipt))
}

async fn active_turn_id(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Option<Uuid>, CollaborationError> {
    sqlx::query_scalar(
        r#"SELECT id FROM conversation_turns
           WHERE conversation_id = ?
             AND status IN ('pending', 'queued', 'running', 'blocked')
           ORDER BY ordinal DESC LIMIT 1"#,
    )
    .bind(conversation_id)
    .fetch_optional(pool)
    .await
    .map_err(db)
}

pub async fn promote_due_delayed_inputs(pool: &SqlitePool) -> Result<u32, CollaborationError> {
    promote_due_delayed_inputs_with(pool, &DeliveryContext::default()).await
}

pub async fn promote_due_delayed_inputs_with(
    pool: &SqlitePool,
    delivery: &DeliveryContext,
) -> Result<u32, CollaborationError> {
    let due = sqlx::query_as::<_, DueDelay>(
        r#"SELECT id, conversation_id, operation_id, payload_json, principal_json
           FROM conversation_delayed_inputs
           WHERE status = 'scheduled' AND deliver_at <= ?
           ORDER BY deliver_at, id"#,
    )
    .bind(now_stamp())
    .fetch_all(pool)
    .await
    .map_err(db)?;
    let mut promoted = 0;
    for row in due {
        if promote_one(pool, &row, delivery).await? {
            promoted += 1;
        }
    }
    Ok(promoted)
}

pub fn spawn_delayed_input_promoter(pool: SqlitePool, delivery: DeliveryContext) {
    tokio::spawn(async move {
        loop {
            if let Err(error) = promote_due_delayed_inputs_with(&pool, &delivery).await {
                tracing::warn!(%error, "delayed input promotion failed");
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    });
}

#[derive(Debug, FromRow)]
struct DueDelay {
    id: String,
    conversation_id: String,
    operation_id: String,
    payload_json: String,
    principal_json: String,
}

async fn promote_one(
    pool: &SqlitePool,
    row: &DueDelay,
    delivery: &DeliveryContext,
) -> Result<bool, CollaborationError> {
    let principal: Value = serde_json::from_str(&row.principal_json).unwrap_or_else(|_| json!({}));
    if principal.get("kind").and_then(Value::as_str) == Some("collaboration_space_post") {
        let payload: Value = serde_json::from_str(&row.payload_json).unwrap_or_else(|_| json!({}));
        let space_id = payload
            .get("space_id")
            .and_then(Value::as_str)
            .or_else(|| principal.get("space_id").and_then(Value::as_str))
            .unwrap_or_default()
            .to_string();
        let caller_id = payload
            .get("caller_id")
            .and_then(Value::as_str)
            .and_then(|v| Uuid::parse_str(v).ok());
        let content = payload
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let summary = payload
            .get("summary")
            .and_then(Value::as_str)
            .map(str::to_string);
        let to = payload
            .get("to")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let in_reply_to = payload
            .get("in_reply_to")
            .and_then(Value::as_str)
            .map(str::to_string);
        let operation_id = Uuid::parse_str(&row.operation_id).unwrap_or_else(|_| Uuid::new_v4());
        match post_to_space_with(
            pool,
            PostToSpace {
                caller_id,
                space_id: space_id.clone(),
                content,
                summary,
                to,
                in_reply_to,
                operation_id,
            },
            delivery,
        )
        .await
        {
            Ok(posted) => {
                sqlx::query(
                    r#"UPDATE conversation_delayed_inputs
                       SET status = 'promoted', promoted_input_id = ?, error = NULL
                       WHERE id = ? AND status = 'scheduled'"#,
                )
                .bind(&posted.message_id)
                .bind(&row.id)
                .execute(pool)
                .await
                .map_err(db)?;
                if let Ok(workspace_id) = space_workspace_id(pool, &space_id).await {
                    delivery.notify_space_changed(CollaborationSpaceChangedEvent {
                        workspace_id,
                        space_id,
                        seq: Some(posted.seq),
                        member_id: None,
                    });
                }
                return Ok(true);
            }
            Err(error) if error.code == "limit_exceeded" => return Ok(false),
            Err(error) => {
                mark_delay_failed(pool, &row.id, &error.message).await?;
                if let Ok(workspace_id) = space_workspace_id(pool, &space_id).await {
                    delivery.notify_space_changed(CollaborationSpaceChangedEvent {
                        workspace_id,
                        space_id,
                        seq: None,
                        member_id: None,
                    });
                }
                return Ok(false);
            }
        }
    }

    let Ok(conversation_id) = Uuid::parse_str(&row.conversation_id) else {
        mark_delay_failed(pool, &row.id, "invalid conversation").await?;
        return Ok(false);
    };
    let Ok(operation_id) = Uuid::parse_str(&row.operation_id) else {
        mark_delay_failed(pool, &row.id, "invalid operation").await?;
        return Ok(false);
    };
    let Some(head) = load_session(pool, conversation_id).await? else {
        mark_delay_failed(pool, &row.id, "conversation was not found").await?;
        return Ok(false);
    };
    if head.deleted_at.is_some() || head.status == "archived" {
        mark_delay_failed(pool, &row.id, "conversation was not found").await?;
        return Ok(false);
    }
    let payload: Value = serde_json::from_str(&row.payload_json).unwrap_or_else(|_| json!({}));
    let text = payload
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let display_text = payload
        .get("display_text")
        .or_else(|| payload.get("displayText"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let receipt = match deliver_text(
        pool,
        conversation_id,
        operation_id,
        &text,
        display_text,
        &head,
        principal.clone(),
        delivery,
    )
    .await
    {
        Ok(receipt) => receipt,
        Err(error) if error.code == "limit_exceeded" => return Ok(false),
        Err(error) => {
            mark_delay_failed(pool, &row.id, &error.message).await?;
            return Ok(false);
        }
    };
    sqlx::query(
        r#"UPDATE conversation_delayed_inputs
           SET status = 'promoted', promoted_input_id = ?, error = NULL
           WHERE id = ? AND status = 'scheduled'"#,
    )
    .bind(receipt.input_id.map(|id| id.to_string()))
    .bind(&row.id)
    .execute(pool)
    .await
    .map_err(db)?;
    let parent_conv = principal
        .get("parentConversationId")
        .and_then(Value::as_str)
        .map(str::to_string);
    delivery.notify_space_changed(CollaborationSpaceChangedEvent {
        workspace_id: head.workspace_id,
        space_id: format!("session:{conversation_id}"),
        seq: None,
        member_id: parent_conv,
    });
    Ok(true)
}

async fn mark_delay_failed(
    pool: &SqlitePool,
    id: &str,
    error: &str,
) -> Result<(), CollaborationError> {
    sqlx::query(
        r#"UPDATE conversation_delayed_inputs
           SET status = 'failed', error = ?
           WHERE id = ? AND status = 'scheduled'"#,
    )
    .bind(error)
    .bind(id)
    .execute(pool)
    .await
    .map_err(db)?;
    Ok(())
}

fn digest_text(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn delivery_operation_id(message_id: Uuid, conversation_id: Uuid) -> Uuid {
    Uuid::new_v5(
        &Uuid::NAMESPACE_OID,
        format!("{message_id}:{conversation_id}").as_bytes(),
    )
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpaceRecord {
    pub space_id: String,
    pub name: String,
    pub workspace_id: Uuid,
}

pub async fn create_collaboration_space(
    pool: &SqlitePool,
    caller_id: Uuid,
    name: &str,
    operation_id: Uuid,
) -> Result<SpaceRecord, CollaborationError> {
    let caller = live_session(load_session(pool, caller_id).await?)?;
    let name = require_name(name)?;
    let request = json!({ "name": name, "caller_id": caller_id });
    if let Some(stored) = load_stored_operation(pool, &operation_id.to_string()).await? {
        return serde_json::from_value(accept_space_replay(
            &stored,
            Some(&operation_id.to_string()),
            &request,
        )?)
        .map_err(|error| {
            CollaborationError::new("conversation_control_failed", error.to_string())
        });
    }
    let space_id = operation_id.to_string();
    sqlx::query(
        r#"INSERT INTO collaboration_spaces
           (id, workspace_id, name, created_by_conversation_id, created_at)
           VALUES (?, ?, ?, ?, ?)"#,
    )
    .bind(&space_id)
    .bind(caller.workspace_id.to_string())
    .bind(&name)
    .bind(caller_id.to_string())
    .bind(now_stamp())
    .execute(pool)
    .await
    .map_err(db)?;
    let nickname = caller
        .name
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "会话".to_string());
    insert_member_with(
        pool,
        &space_id,
        Some(caller_id),
        &nickname,
        "agent",
        true,
        SeatMode::PerThread,
    )
    .await?;
    let record = SpaceRecord {
        space_id,
        name,
        workspace_id: caller.workspace_id,
    };
    store_operation(
        pool,
        &operation_id.to_string(),
        Some(&record.space_id),
        &request,
        &record,
    )
    .await?;
    Ok(record)
}

pub async fn create_workspace_space(
    pool: &SqlitePool,
    workspace_id: Uuid,
    name: &str,
    operation_id: Uuid,
) -> Result<SpaceRecord, CollaborationError> {
    let owns: Option<i64> = sqlx::query_scalar("SELECT 1 FROM workspaces WHERE id = ? LIMIT 1")
        .bind(workspace_id)
        .fetch_optional(pool)
        .await
        .map_err(db)?;
    if owns.is_none() {
        return Err(CollaborationError::new(
            "not_found",
            "workspace was not found",
        ));
    }
    let name = require_name(name)?;
    let request = json!({ "workspace_id": workspace_id, "name": name });
    if let Some(stored) = load_stored_operation(pool, &operation_id.to_string()).await? {
        return serde_json::from_value(accept_space_replay(
            &stored,
            Some(&operation_id.to_string()),
            &request,
        )?)
        .map_err(|error| {
            CollaborationError::new("conversation_control_failed", error.to_string())
        });
    }
    let space_id = operation_id.to_string();
    sqlx::query(
        r#"INSERT INTO collaboration_spaces
           (id, workspace_id, name, created_by_conversation_id, created_at)
           VALUES (?, ?, ?, NULL, ?)"#,
    )
    .bind(&space_id)
    .bind(workspace_id.to_string())
    .bind(&name)
    .bind(now_stamp())
    .execute(pool)
    .await
    .map_err(db)?;
    let record = SpaceRecord {
        space_id,
        name,
        workspace_id,
    };
    store_operation(
        pool,
        &operation_id.to_string(),
        Some(&record.space_id),
        &request,
        &record,
    )
    .await?;
    Ok(record)
}

pub async fn rename_workspace_space(
    pool: &SqlitePool,
    space_id: &str,
    name: &str,
) -> Result<SpaceRecord, CollaborationError> {
    let workspace_id = space_workspace_id(pool, space_id).await?;
    let name = require_name(name)?;
    let updated = sqlx::query(
        r#"UPDATE collaboration_spaces
           SET name = ?
           WHERE id = ?"#,
    )
    .bind(&name)
    .bind(space_id)
    .execute(pool)
    .await
    .map_err(db)?;
    if updated.rows_affected() == 0 {
        return Err(CollaborationError::new("not_found", "space was not found"));
    }
    Ok(SpaceRecord {
        space_id: space_id.to_string(),
        name,
        workspace_id,
    })
}

pub async fn list_workspace_spaces(
    pool: &SqlitePool,
    workspace_id: Uuid,
) -> Result<Vec<SpaceRecord>, CollaborationError> {
    let rows = sqlx::query_as::<_, (String, String)>(
        r#"SELECT id, name
           FROM collaboration_spaces
           WHERE workspace_id = ?
           ORDER BY created_at, id"#,
    )
    .bind(workspace_id.to_string())
    .fetch_all(pool)
    .await
    .map_err(db)?;
    Ok(rows
        .into_iter()
        .map(|(space_id, name)| SpaceRecord {
            space_id,
            name,
            workspace_id,
        })
        .collect())
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceConversationOption {
    pub conversation_id: Uuid,
    pub title: Option<String>,
    pub agent_id: Option<String>,
    pub status: String,
    pub updated_at: String,
    pub turn_in_flight: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_name: Option<String>,
}

pub async fn list_workspace_conversations(
    pool: &SqlitePool,
    workspace_id: Uuid,
) -> Result<Vec<WorkspaceConversationOption>, CollaborationError> {
    let workspace_name = sqlx::query_scalar::<_, Option<String>>(
        r#"SELECT COALESCE(NULLIF(TRIM(name), ''), NULLIF(TRIM(branch), ''))
           FROM workspaces WHERE id = ? LIMIT 1"#,
    )
    .bind(workspace_id)
    .fetch_optional(pool)
    .await
    .map_err(db)?
    .flatten()
    .filter(|value| !value.trim().is_empty());
    type WorkspaceConvRow = (
        Uuid,
        Option<String>,
        Option<String>,
        String,
        String,
        i64,
        Option<Uuid>,
        Option<Uuid>,
        Option<String>,
        i64,
    );
    let mut rows = sqlx::query_as::<_, WorkspaceConvRow>(
        r#"SELECT s.id,
                  s.name,
                  s.agent_id,
                  s.status,
                  s.updated_at,
                  EXISTS (
                    SELECT 1 FROM conversation_turns turn
                    WHERE turn.conversation_id = s.id
                      AND turn.status IN ('pending', 'queued', 'running', 'blocked')
                  ) AS turn_in_flight_flag,
                  s.last_viewed_turn_id,
                  (
                    SELECT turn.id FROM conversation_turns turn
                    WHERE turn.conversation_id = s.id
                    ORDER BY turn.ordinal DESC
                    LIMIT 1
                  ) AS latest_turn_id,
                  (
                    SELECT turn.status FROM conversation_turns turn
                    WHERE turn.conversation_id = s.id
                    ORDER BY turn.ordinal DESC
                    LIMIT 1
                  ) AS latest_turn_status,
                  EXISTS (
                    SELECT 1 FROM conversation_inputs ci
                    WHERE ci.conversation_id = s.id AND ci.status = 'queued'
                  ) AS has_queued_input
           FROM sessions s
           WHERE s.workspace_id = ? AND s.deleted_at IS NULL AND s.status != 'archived'
           ORDER BY s.updated_at DESC
           LIMIT 200"#,
    )
    .bind(workspace_id)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    let mut seen_ids: std::collections::HashSet<Uuid> = rows.iter().map(|(id, ..)| *id).collect();
    let unassigned_id = unassigned_space_id(workspace_id);
    let member_conv_ids = sqlx::query_scalar::<_, String>(
        r#"SELECT DISTINCT m.conversation_id
           FROM collaboration_space_members m
           LEFT JOIN collaboration_spaces sp ON sp.id = m.space_id
           WHERE m.conversation_id IS NOT NULL
             AND (sp.workspace_id = ? OR m.space_id = ?)"#,
    )
    .bind(workspace_id.to_string())
    .bind(&unassigned_id)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    let missing_member_ids: Vec<Uuid> = member_conv_ids
        .into_iter()
        .filter_map(|raw_id| Uuid::parse_str(raw_id.trim()).ok())
        .filter(|member_id| seen_ids.insert(*member_id))
        .collect();
    if !missing_member_ids.is_empty() {
        let mut builder = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
            r#"SELECT s.id,
                      s.name,
                      s.agent_id,
                      s.status,
                      s.updated_at,
                      EXISTS (
                        SELECT 1 FROM conversation_turns turn
                        WHERE turn.conversation_id = s.id
                          AND turn.status IN ('pending', 'queued', 'running', 'blocked')
                      ) AS turn_in_flight_flag,
                      s.last_viewed_turn_id,
                      (
                        SELECT turn.id FROM conversation_turns turn
                        WHERE turn.conversation_id = s.id
                        ORDER BY turn.ordinal DESC
                        LIMIT 1
                      ) AS latest_turn_id,
                      (
                        SELECT turn.status FROM conversation_turns turn
                        WHERE turn.conversation_id = s.id
                        ORDER BY turn.ordinal DESC
                        LIMIT 1
                      ) AS latest_turn_status,
                      EXISTS (
                        SELECT 1 FROM conversation_inputs ci
                        WHERE ci.conversation_id = s.id AND ci.status = 'queued'
                      ) AS has_queued_input
               FROM sessions s
               WHERE s.deleted_at IS NULL AND s.status != 'archived' AND s.id IN ("#,
        );
        let mut separated = builder.separated(", ");
        for member_id in &missing_member_ids {
            separated.push_bind(*member_id);
        }
        separated.push_unseparated(")");
        let extra_rows = builder
            .build_query_as::<WorkspaceConvRow>()
            .fetch_all(pool)
            .await
            .map_err(db)?;
        rows.extend(extra_rows);
    }
    let teams_by_conversation: std::collections::HashMap<String, String> = if rows.is_empty() {
        std::collections::HashMap::new()
    } else {
        let mut builder = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
            r#"SELECT conversation_id, team_name
               FROM conversation_personas
               WHERE team_name IS NOT NULL AND trim(team_name) != '' AND conversation_id IN ("#,
        );
        let mut separated = builder.separated(", ");
        for (conversation_id, ..) in &rows {
            separated.push_bind(conversation_id.to_string());
        }
        separated.push_unseparated(")");
        builder
            .build_query_as::<(String, Option<String>)>()
            .fetch_all(pool)
            .await
            .map_err(db)?
            .into_iter()
            .filter_map(|(id, team)| {
                let trimmed = team?.trim().to_string();
                (!trimmed.is_empty()).then_some((id, trimmed))
            })
            .collect()
    };
    Ok(rows
        .into_iter()
        .map(
            |(
                conversation_id,
                title,
                agent_id,
                status,
                updated_at,
                turn_in_flight_flag,
                last_viewed_turn_id,
                latest_turn_id,
                latest_turn_status,
                has_queued_input,
            )| {
                let team_name = teams_by_conversation
                    .get(&conversation_id.to_string())
                    .cloned();
                let effective_status = if let (Some(turn_id), Some(turn_status)) =
                    (latest_turn_id, latest_turn_status.as_deref())
                {
                    let phase = if turn_in_flight_flag != 0 {
                        crate::workbench_status::TurnPhase::InFlight
                    } else {
                        crate::workbench_status::turn_phase(turn_status)
                    };
                    let viewed = last_viewed_turn_id == Some(turn_id);
                    crate::workbench_status::derive_workbench_status(
                        phase,
                        viewed,
                        has_queued_input != 0,
                    )
                    .to_string()
                } else {
                    status
                };
                WorkspaceConversationOption {
                    conversation_id,
                    title: title.filter(|title| !title.trim().is_empty()),
                    agent_id: agent_id.filter(|agent| !agent.trim().is_empty()),
                    status: effective_status,
                    updated_at,
                    turn_in_flight: turn_in_flight_flag != 0,
                    team_name,
                    workspace_name: workspace_name.clone(),
                }
            },
        )
        .collect())
}

pub fn unassigned_space_id(workspace_id: Uuid) -> String {
    format!("unassigned:{workspace_id}")
}

pub fn parse_unassigned_space_id(space_id: &str) -> Option<Uuid> {
    space_id
        .strip_prefix("unassigned:")
        .and_then(|raw| Uuid::parse_str(raw).ok())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CollaborationSpaceChangedEvent {
    pub workspace_id: Uuid,
    pub space_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub seq: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub member_id: Option<String>,
}

pub async fn space_workspace_id(
    pool: &SqlitePool,
    space_id: &str,
) -> Result<Uuid, CollaborationError> {
    let space = load_space_or_unassigned(pool, space_id).await?;
    Uuid::parse_str(&space.workspace_id)
        .map_err(|error| CollaborationError::new("conversation_control_failed", error.to_string()))
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct ConversationPersonaView {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub agent_name: String,
}

pub async fn conversation_persona(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Option<ConversationPersonaView>, CollaborationError> {
    let row = sqlx::query_as::<_, (String, Option<String>, String, String)>(
        r#"SELECT name, team_name, summary, agent_id
           FROM conversation_personas WHERE conversation_id = ?"#,
    )
    .bind(conversation_id.to_string())
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    Ok(row.map(
        |(name, team_name, summary, agent_id)| ConversationPersonaView {
            name,
            team_name: team_name.filter(|value| !value.trim().is_empty()),
            summary: (!summary.trim().is_empty()).then_some(summary),
            agent_name: agent_id,
        },
    ))
}

pub async fn set_conversation_persona_team(
    pool: &SqlitePool,
    conversation_id: Uuid,
    nickname: &str,
    team_id: Option<&str>,
) -> Result<Option<String>, CollaborationError> {
    let target = live_session(load_session(pool, conversation_id).await?)?;
    let team_name = match team_id.map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) => {
            sqlx::query_scalar::<_, String>("SELECT name FROM collaboration_teams WHERE id = ?")
                .bind(id)
                .fetch_optional(pool)
                .await
                .map_err(db)?
        }
        None => None,
    };
    let agent_id = target.agent_id.unwrap_or_else(|| "codex".to_string());
    let name = if nickname.trim().is_empty() {
        target.name.unwrap_or_else(|| "成员".to_string())
    } else {
        nickname.trim().to_string()
    };
    sqlx::query(
        r#"INSERT INTO conversation_personas
           (conversation_id, role_id, name, team_name, summary, agent_id, persona_prompt, snapshotted_at)
           VALUES (?, NULL, ?, ?, '', ?, '', ?)
           ON CONFLICT(conversation_id) DO UPDATE SET
             team_name = excluded.team_name,
             name = CASE WHEN trim(conversation_personas.name) = '' THEN excluded.name ELSE conversation_personas.name END"#,
    )
    .bind(conversation_id.to_string())
    .bind(&name)
    .bind(team_name.as_deref())
    .bind(&agent_id)
    .bind(now_stamp())
    .execute(pool)
    .await
    .map_err(db)?;
    Ok(team_name)
}

#[derive(Debug, Clone)]
pub struct HostCreateSpaceMember {
    pub workspace_id: Uuid,
    pub space_id: Option<String>,
    pub nickname: String,
    pub role_id: Option<String>,
    pub agent_id: Option<String>,
    pub team_id: Option<String>,
    pub persona_prompt: Option<String>,
    pub mode_id: Option<String>,
    pub config_values: Option<Value>,
    pub operation_id: Uuid,
}

pub async fn host_create_space_member(
    pool: &SqlitePool,
    input: HostCreateSpaceMember,
) -> Result<MemberRecord, CollaborationError> {
    let target_space_id = input
        .space_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| unassigned_space_id(input.workspace_id));
    let space = load_space_or_unassigned(pool, &target_space_id).await?;
    if space.workspace_id != input.workspace_id.to_string() {
        return Err(CollaborationError::new("not_found", "space was not found"));
    }
    let nickname = require_name(&input.nickname)?;
    let request = json!({
        "workspace_id": input.workspace_id,
        "space_id": target_space_id,
        "nickname": nickname,
        "role_id": input.role_id,
        "agent_id": input.agent_id,
        "team_id": input.team_id,
        "persona_prompt": input.persona_prompt,
        "mode_id": input.mode_id,
        "config_values": input.config_values,
    });
    if let Some(stored) = load_stored_operation(pool, &input.operation_id.to_string()).await? {
        return decode_replay(accept_space_replay(
            &stored,
            Some(&target_space_id),
            &request,
        )?);
    }
    if nickname_owner(pool, &target_space_id, &nickname)
        .await?
        .is_some()
    {
        return Err(CollaborationError::new(
            "nickname_taken",
            "nickname is already used in this space",
        ));
    }
    let role = match input
        .role_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        Some(role_id) => Some(load_role(pool, role_id).await?),
        None => None,
    };
    let agent_raw = role
        .as_ref()
        .map(|role| role.agent_id.clone())
        .or_else(|| {
            input
                .agent_id
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_string)
        })
        .ok_or_else(|| CollaborationError::new("not_found", "agent_id is required"))?;
    let agent_id = AgentId::parse(&agent_raw)
        .map_err(|_| CollaborationError::new("not_found", "agent_id is required"))?;
    let (mode_id, config_values, persona_prompt, summary) = if let Some(role) = role.as_ref() {
        (
            role.mode_id.clone(),
            role.config_values.clone(),
            role.persona_prompt.clone(),
            role.summary.clone(),
        )
    } else {
        (
            input
                .mode_id
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_string),
            input.config_values.clone().unwrap_or_else(|| json!({})),
            input.persona_prompt.clone().unwrap_or_default(),
            String::new(),
        )
    };
    let resolved_team_id = input
        .team_id
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .or_else(|| role.as_ref().and_then(|r| r.team_id.clone()));
    let team_name = match resolved_team_id.as_deref() {
        Some(team_id) => {
            sqlx::query_scalar::<_, String>("SELECT name FROM collaboration_teams WHERE id = ?")
                .bind(team_id)
                .fetch_optional(pool)
                .await
                .map_err(db)?
        }
        None => None,
    };
    let session_id = Uuid::new_v5(
        &Uuid::NAMESPACE_OID,
        format!("member-session:{}", input.operation_id).as_bytes(),
    );
    if load_session(pool, session_id).await?.is_none() {
        Session::create(
            pool,
            &CreateSession {
                executor: None,
                agent_id: Some(agent_id),
                task_id: None,
                name: Some(nickname.clone()),
                initial_prompt: None,
                status: None,
            },
            session_id,
            input.workspace_id,
        )
        .await
        .map_err(|error| {
            CollaborationError::new("conversation_control_failed", error.to_string())
        })?;
    }
    sqlx::query(
        r#"INSERT INTO conversation_personas
           (conversation_id, role_id, name, team_name, summary, agent_id,
            persona_prompt, snapshotted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(conversation_id) DO UPDATE SET
             team_name = excluded.team_name,
             persona_prompt = excluded.persona_prompt"#,
    )
    .bind(session_id.to_string())
    .bind(role.as_ref().map(|r| r.id.as_str()))
    .bind(&nickname)
    .bind(team_name.as_deref())
    .bind(&summary)
    .bind(&agent_raw)
    .bind(&persona_prompt)
    .bind(now_stamp())
    .execute(pool)
    .await
    .map_err(db)?;
    if !persona_prompt.trim().is_empty() {
        append_persona_notice(pool, session_id, &persona_prompt).await?;
    }
    let overrides = config_overrides(&config_values);
    remember_creation_session_controls(pool, session_id, mode_id.as_deref(), overrides).await;
    let record = insert_member(
        pool,
        &target_space_id,
        Some(session_id),
        &nickname,
        "agent",
        true,
    )
    .await?;
    store_operation(
        pool,
        &input.operation_id.to_string(),
        Some(&target_space_id),
        &request,
        &record,
    )
    .await?;
    Ok(record)
}

pub async fn host_move_space_member(
    pool: &SqlitePool,
    from_space_id: &str,
    to_space_id: &str,
    conversation_id: Uuid,
    nickname: Option<&str>,
    operation_id: Uuid,
) -> Result<MemberRecord, CollaborationError> {
    let from_space = load_space_or_unassigned(pool, from_space_id).await?;
    let to_space = load_space_or_unassigned(pool, to_space_id).await?;
    let target = live_session(load_session(pool, conversation_id).await?)?;
    if from_space.workspace_id != to_space.workspace_id
        || target.workspace_id.to_string() != to_space.workspace_id
    {
        return Err(CollaborationError::new(
            "not_found",
            "conversation was not found",
        ));
    }
    let request = json!({
        "from_space_id": from_space_id,
        "to_space_id": to_space_id,
        "conversation_id": conversation_id,
        "nickname": nickname,
    });
    if let Some(stored) = load_stored_operation(pool, &operation_id.to_string()).await? {
        return decode_replay(accept_space_replay(&stored, Some(to_space_id), &request)?);
    }
    let source_member = ensure_agent_member(pool, from_space_id, conversation_id)
        .await
        .ok();
    let desired_nickname = nickname
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| source_member.as_ref().map(|m| m.nickname.clone()))
        .or_else(|| target.name.clone().filter(|v| !v.trim().is_empty()))
        .unwrap_or_else(|| "成员".to_string());
    let desired_nickname = require_name(&desired_nickname)?;
    if from_space_id == to_space_id {
        if let Ok(existing) = ensure_agent_member(pool, to_space_id, conversation_id).await {
            store_operation(
                pool,
                &operation_id.to_string(),
                Some(to_space_id),
                &request,
                &existing,
            )
            .await?;
            return Ok(existing);
        }
    }
    sqlx::query(
        "DELETE FROM collaboration_space_members WHERE space_id = ? AND conversation_id = ?",
    )
    .bind(from_space_id)
    .bind(conversation_id.to_string())
    .execute(pool)
    .await
    .map_err(db)?;
    // A member may now sit in several spaces (one conversation per thread),
    // so a move only vacates the source seat. The undecided space is still
    // exclusive: a member there has no group seat with this conversation.
    if parse_unassigned_space_id(to_space_id).is_none() {
        let unassigned = unassigned_space_id(target.workspace_id);
        sqlx::query(
            "DELETE FROM collaboration_space_members WHERE space_id = ? AND conversation_id = ?",
        )
        .bind(&unassigned)
        .bind(conversation_id.to_string())
        .execute(pool)
        .await
        .map_err(db)?;
    }
    let record = if let Ok(existing) = ensure_agent_member(pool, to_space_id, conversation_id).await
    {
        existing
    } else {
        insert_member_with(
            pool,
            to_space_id,
            Some(conversation_id),
            &desired_nickname,
            "agent",
            true,
            SeatMode::Transfer,
        )
        .await?
    };
    store_operation(
        pool,
        &operation_id.to_string(),
        Some(to_space_id),
        &request,
        &record,
    )
    .await?;
    Ok(record)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchDeleteMemberTarget {
    pub space_id: String,
    pub conversation_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchDeleteResult {
    pub deleted_space_ids: Vec<String>,
    pub archived_conversation_ids: Vec<Uuid>,
    pub unassigned_conversation_ids: Vec<Uuid>,
}

pub async fn host_batch_delete_space_items(
    pool: &SqlitePool,
    workspace_id: Uuid,
    space_ids: Vec<String>,
    member_targets: Vec<BatchDeleteMemberTarget>,
    operation_id: Uuid,
) -> Result<BatchDeleteResult, CollaborationError> {
    let owns: Option<i64> = sqlx::query_scalar("SELECT 1 FROM workspaces WHERE id = ? LIMIT 1")
        .bind(workspace_id)
        .fetch_optional(pool)
        .await
        .map_err(db)?;
    if owns.is_none() {
        return Err(CollaborationError::new(
            "not_found",
            "workspace was not found",
        ));
    }
    let request = json!({
        "workspace_id": workspace_id,
        "space_ids": space_ids,
        "member_targets": member_targets,
    });
    if let Some(stored) = load_stored_operation(pool, &operation_id.to_string()).await? {
        return decode_replay(accept_space_replay(&stored, None, &request)?);
    }

    let archived_set: std::collections::HashSet<Uuid> = member_targets
        .iter()
        .map(|target| target.conversation_id)
        .collect();
    let deleting_space_set: std::collections::HashSet<String> = space_ids
        .iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty() && parse_unassigned_space_id(id).is_none())
        .collect();

    let unassigned_id = unassigned_space_id(workspace_id);
    let mut deleted_space_ids = Vec::new();
    let mut unassigned_conversation_ids = Vec::new();

    for space_id in &deleting_space_set {
        let Ok(space) = load_space(pool, space_id).await else {
            continue;
        };
        if space.workspace_id != workspace_id.to_string() {
            continue;
        }
        let members = sqlx::query_as::<_, (Option<String>, String)>(
            r#"SELECT conversation_id, nickname
               FROM collaboration_space_members
               WHERE space_id = ? AND kind = 'agent' AND conversation_id IS NOT NULL"#,
        )
        .bind(space_id)
        .fetch_all(pool)
        .await
        .map_err(db)?;

        for (conv_raw, nickname) in members {
            let Some(conv_id) = conv_raw.as_deref().and_then(|v| Uuid::parse_str(v).ok()) else {
                continue;
            };
            if archived_set.contains(&conv_id) {
                continue;
            }
            let remaining_spaces: Vec<String> = sqlx::query_scalar(
                r#"SELECT m.space_id
                   FROM collaboration_space_members m
                   JOIN collaboration_spaces s ON s.id = m.space_id
                   WHERE m.conversation_id = ? AND s.workspace_id = ?"#,
            )
            .bind(conv_id.to_string())
            .bind(workspace_id.to_string())
            .fetch_all(pool)
            .await
            .map_err(db)?;
            let stays_in_another_space = remaining_spaces
                .iter()
                .any(|sid| !deleting_space_set.contains(sid));
            if !stays_in_another_space {
                if ensure_agent_member(pool, &unassigned_id, conv_id)
                    .await
                    .is_err()
                {
                    let safe_nick = if nickname_owner(pool, &unassigned_id, &nickname)
                        .await?
                        .is_some()
                    {
                        format!("{nickname}-{}", &conv_id.to_string()[..4])
                    } else {
                        nickname
                    };
                    let _ = insert_member_with(
                        pool,
                        &unassigned_id,
                        Some(conv_id),
                        &safe_nick,
                        "agent",
                        true,
                        SeatMode::Transfer,
                    )
                    .await;
                }
                if !unassigned_conversation_ids.contains(&conv_id) {
                    unassigned_conversation_ids.push(conv_id);
                }
            }
        }

        sqlx::query(
            "DELETE FROM collaboration_space_collection_reads WHERE item_id IN (SELECT id FROM collaboration_space_collection_items WHERE space_id = ?)",
        )
        .bind(space_id)
        .execute(pool)
        .await
        .map_err(db)?;
        sqlx::query("DELETE FROM collaboration_space_collection_items WHERE space_id = ?")
            .bind(space_id)
            .execute(pool)
            .await
            .map_err(db)?;
        sqlx::query("DELETE FROM collaboration_space_messages WHERE space_id = ?")
            .bind(space_id)
            .execute(pool)
            .await
            .map_err(db)?;
        sqlx::query("DELETE FROM collaboration_space_members WHERE space_id = ?")
            .bind(space_id)
            .execute(pool)
            .await
            .map_err(db)?;
        sqlx::query("DELETE FROM collaboration_spaces WHERE id = ? AND workspace_id = ?")
            .bind(space_id)
            .bind(workspace_id.to_string())
            .execute(pool)
            .await
            .map_err(db)?;
        deleted_space_ids.push(space_id.clone());
    }

    let mut archived_conversation_ids = Vec::new();
    for target in &member_targets {
        sqlx::query(
            "DELETE FROM collaboration_space_members WHERE space_id = ? AND conversation_id = ?",
        )
        .bind(&target.space_id)
        .bind(target.conversation_id.to_string())
        .execute(pool)
        .await
        .map_err(db)?;
        sqlx::query(
            "DELETE FROM collaboration_space_members WHERE space_id = ? AND conversation_id = ?",
        )
        .bind(&unassigned_id)
        .bind(target.conversation_id.to_string())
        .execute(pool)
        .await
        .map_err(db)?;
        sqlx::query(
            r#"DELETE FROM collaboration_space_members
               WHERE conversation_id = ?
                 AND space_id IN (SELECT id FROM collaboration_spaces WHERE workspace_id = ?)"#,
        )
        .bind(target.conversation_id.to_string())
        .bind(workspace_id.to_string())
        .execute(pool)
        .await
        .map_err(db)?;
        sqlx::query(
            "UPDATE sessions SET status = 'archived', updated_at = datetime('now', 'subsec') WHERE id = ? AND workspace_id = ?",
        )
        .bind(target.conversation_id)
        .bind(workspace_id)
        .execute(pool)
        .await
        .map_err(db)?;
        identity::unbind_conversation(pool, target.conversation_id)
            .await
            .map_err(db)?;
        if !archived_conversation_ids.contains(&target.conversation_id) {
            archived_conversation_ids.push(target.conversation_id);
        }
    }

    let result = BatchDeleteResult {
        deleted_space_ids,
        archived_conversation_ids,
        unassigned_conversation_ids,
    };
    store_operation(pool, &operation_id.to_string(), None, &request, &result).await?;
    Ok(result)
}

pub async fn host_add_space_member(
    pool: &SqlitePool,
    space_id: &str,
    conversation_id: Uuid,
    nickname: &str,
    operation_id: Uuid,
) -> Result<MemberRecord, CollaborationError> {
    let space = load_space_or_unassigned(pool, space_id).await?;
    let target = live_session(load_session(pool, conversation_id).await?)?;
    if target.workspace_id.to_string() != space.workspace_id {
        return Err(CollaborationError::new(
            "not_found",
            "conversation was not found",
        ));
    }
    let nickname = require_name(nickname)?;
    let request = json!({ "conversation_id": conversation_id, "nickname": nickname });
    if let Some(stored) = load_stored_operation(pool, &operation_id.to_string()).await? {
        return decode_replay(accept_space_replay(&stored, Some(space_id), &request)?);
    }
    if let Ok(existing) = ensure_agent_member(pool, space_id, conversation_id).await {
        if existing.nickname == nickname {
            store_operation(
                pool,
                &operation_id.to_string(),
                Some(space_id),
                &request,
                &existing,
            )
            .await?;
            return Ok(existing);
        }
        return set_space_identity(pool, conversation_id, space_id, &nickname, operation_id).await;
    }
    if nickname_owner(pool, space_id, &nickname).await?.is_some() {
        return Err(CollaborationError::new(
            "nickname_taken",
            "nickname is already used in this space",
        ));
    }
    if parse_unassigned_space_id(space_id).is_none() {
        let unassigned = unassigned_space_id(target.workspace_id);
        sqlx::query(
            "DELETE FROM collaboration_space_members WHERE space_id = ? AND conversation_id = ?",
        )
        .bind(&unassigned)
        .bind(conversation_id.to_string())
        .execute(pool)
        .await
        .map_err(db)?;
    }
    let record = insert_member(
        pool,
        space_id,
        Some(conversation_id),
        &nickname,
        "agent",
        true,
    )
    .await?;
    store_operation(
        pool,
        &operation_id.to_string(),
        Some(space_id),
        &request,
        &record,
    )
    .await?;
    Ok(record)
}

pub async fn add_space_member(
    pool: &SqlitePool,
    caller_id: Uuid,
    space_id: &str,
    conversation_id: Uuid,
    nickname: &str,
    operation_id: Uuid,
) -> Result<MemberRecord, CollaborationError> {
    caller_seat(pool, space_id, caller_id).await?;
    let space = load_space(pool, space_id).await?;
    let target = live_session(load_session(pool, conversation_id).await?)?;
    if target.workspace_id.to_string() != space.workspace_id {
        return Err(CollaborationError::new(
            "not_found",
            "conversation was not found",
        ));
    }
    let nickname = require_name(nickname)?;
    let request = json!({
        "caller_id": caller_id,
        "conversation_id": conversation_id,
        "nickname": nickname,
    });
    if let Some(stored) = load_stored_operation(pool, &operation_id.to_string()).await? {
        return decode_replay(accept_space_replay(&stored, Some(space_id), &request)?);
    }
    if nickname_owner(pool, space_id, &nickname).await?.is_some() {
        return Err(CollaborationError::new(
            "nickname_taken",
            "nickname is already used in this space",
        ));
    }
    let record = insert_member(
        pool,
        space_id,
        Some(conversation_id),
        &nickname,
        "agent",
        true,
    )
    .await?;
    store_operation(
        pool,
        &operation_id.to_string(),
        Some(space_id),
        &request,
        &record,
    )
    .await?;
    Ok(record)
}

pub async fn set_space_identity(
    pool: &SqlitePool,
    caller_id: Uuid,
    space_id: &str,
    nickname: &str,
    operation_id: Uuid,
) -> Result<MemberRecord, CollaborationError> {
    let space = load_space_or_unassigned(pool, space_id).await?;
    let target = live_session(load_session(pool, caller_id).await?)?;
    if target.workspace_id.to_string() != space.workspace_id {
        return Err(CollaborationError::new(
            "not_found",
            "conversation was not found",
        ));
    }
    let member = caller_seat(pool, space_id, caller_id)
        .await
        .map_err(|_| CollaborationError::new("not_found", "conversation was not found"))?;
    let nickname = require_name(nickname)?;
    let request = json!({ "caller_id": caller_id, "nickname": nickname });
    if let Some(stored) = load_stored_operation(pool, &operation_id.to_string()).await? {
        return decode_replay(accept_space_replay(&stored, Some(space_id), &request)?);
    }
    if let Some(owner) = nickname_owner(pool, space_id, &nickname).await? {
        if owner != member.member_id {
            return Err(CollaborationError::new(
                "nickname_taken",
                "nickname is already used in this space",
            ));
        }
    }
    sqlx::query(
        "UPDATE collaboration_space_members SET nickname = ? WHERE space_id = ? AND member_id = ?",
    )
    .bind(&nickname)
    .bind(space_id)
    .bind(&member.member_id)
    .execute(pool)
    .await
    .map_err(db)?;
    let mut updated = member;
    updated.nickname = nickname;
    store_operation(
        pool,
        &operation_id.to_string(),
        Some(space_id),
        &request,
        &updated,
    )
    .await?;
    Ok(updated)
}

#[derive(Debug, Clone)]
pub struct PostToSpace {
    pub caller_id: Option<Uuid>,
    pub space_id: String,
    pub content: String,
    pub summary: Option<String>,
    pub to: Vec<String>,
    pub in_reply_to: Option<String>,
    pub operation_id: Uuid,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeliveryReceipt {
    pub conversation_id: Uuid,
    pub nickname: String,
    pub delivered: String,
    /// Three-state receipt: `queued`, `processing` or `replied`
    /// (`failed` deliveries keep `queued` here and report `delivered`).
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SpacePostResult {
    pub message_id: String,
    pub seq: i64,
    pub receipts: Vec<DeliveryReceipt>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageAudience {
    Agent,
    User,
}

pub async fn post_to_space(
    pool: &SqlitePool,
    input: PostToSpace,
) -> Result<SpacePostResult, CollaborationError> {
    post_to_space_with(pool, input, &DeliveryContext::default()).await
}

pub async fn post_to_space_delayed_with(
    pool: &SqlitePool,
    input: PostToSpace,
    delay_seconds: Option<i64>,
    turn_delivery: &DeliveryContext,
) -> Result<SpacePostResult, CollaborationError> {
    let seconds = delay_seconds.unwrap_or(0);
    if seconds <= 0 {
        return post_to_space_with(pool, input, turn_delivery).await;
    }
    let cap_seconds = Duration::hours(HARD_DELAY_HOURS).num_seconds();
    if seconds > cap_seconds {
        return Err(CollaborationError::new(
            "delay_exceeds_cap",
            format!("delay exceeds {HARD_DELAY_HOURS} hours"),
        ));
    }
    let content = input.content.trim();
    if content.is_empty() {
        return Err(CollaborationError::new(
            "conversation_control_failed",
            "content must not be empty",
        ));
    }
    let (nickname, sender) = match input.caller_id {
        Some(caller_id) => {
            let member = caller_seat(pool, &input.space_id, caller_id).await?;
            let seat = seat_conversation(&member).unwrap_or(caller_id);
            (member.nickname, Some(seat))
        }
        None => {
            ensure_user_member(pool, &input.space_id).await?;
            ("user".to_string(), None)
        }
    };
    let targets = resolve_targets(pool, &input.space_id, sender, &input.to, content).await?;
    let deliver_at = Utc::now() + Duration::seconds(seconds);
    let deliver_at_stamp = stamp(deliver_at);
    let digest = digest_text(content);
    let principal = json!({
        "kind": "collaboration_space_post",
        "space_id": input.space_id,
        "caller_id": input.caller_id,
        "nickname": nickname,
    })
    .to_string();
    let payload = json!({
        "space_id": input.space_id,
        "caller_id": input.caller_id,
        "nickname": nickname,
        "content": content,
        "summary": input.summary,
        "to": input.to,
        "in_reply_to": input.in_reply_to,
        "operation_id": input.operation_id,
    });
    let conv_key = input.caller_id.unwrap_or_else(Uuid::nil).to_string();
    let op_key = input.operation_id.to_string();
    let existing = sqlx::query_as::<_, (String, String, String)>(
        r#"SELECT id, payload_digest, principal_json FROM conversation_delayed_inputs
           WHERE conversation_id = ? AND operation_id = ?"#,
    )
    .bind(&conv_key)
    .bind(&op_key)
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    let delayed_id = if let Some((id, stored_digest, stored_principal)) = existing {
        if stored_digest != digest || stored_principal != principal {
            return Err(operation_conflict());
        }
        id
    } else {
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            r#"INSERT INTO conversation_delayed_inputs
               (id, conversation_id, operation_id, payload_json, payload_digest, principal_json,
                deliver_at, status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)"#,
        )
        .bind(&id)
        .bind(&conv_key)
        .bind(&op_key)
        .bind(payload.to_string())
        .bind(&digest)
        .bind(&principal)
        .bind(&deliver_at_stamp)
        .bind(now_stamp())
        .execute(pool)
        .await
        .map_err(db)?;
        id
    };
    let receipts = targets
        .into_iter()
        .filter_map(|target| {
            let conversation_id = target.conversation_id?;
            Some(DeliveryReceipt {
                conversation_id,
                nickname: target.nickname,
                delivered: "scheduled".to_string(),
                state: "queued".to_string(),
                input_id: None,
                error_code: None,
            })
        })
        .collect();
    Ok(SpacePostResult {
        message_id: delayed_id,
        seq: 0,
        receipts,
    })
}

pub async fn post_to_space_with(
    pool: &SqlitePool,
    input: PostToSpace,
    turn_delivery: &DeliveryContext,
) -> Result<SpacePostResult, CollaborationError> {
    let content = input.content.trim();
    if content.is_empty() {
        return Err(CollaborationError::new(
            "conversation_control_failed",
            "content must not be empty",
        ));
    }
    let (actor, attributed_to, sender) = match input.caller_id {
        Some(caller_id) => {
            let member = caller_seat(pool, &input.space_id, caller_id).await?;
            let seat = seat_conversation(&member).unwrap_or(caller_id);
            (
                member_actor(&input.space_id, &member.nickname),
                Some(format!("vibex://conversation/{seat}")),
                Some(seat),
            )
        }
        None => {
            ensure_user_member(pool, &input.space_id).await?;
            (user_actor(&input.space_id), None, None)
        }
    };
    let message_id = input.operation_id.to_string();
    let request = post_fingerprint(&input, content, &actor);
    if let Some(head) = load_message_head(pool, &message_id).await? {
        if head.space_id != input.space_id {
            return Err(CollaborationError::new(
                "not_found",
                "message was not found",
            ));
        }
        if !same_post_request(
            pool,
            &message_id,
            &input.space_id,
            &request,
            &head.envelope_json,
        )
        .await?
        {
            return Err(operation_conflict());
        }
        return deliver_pending(pool, &input.space_id, &message_id, turn_delivery).await;
    }
    let targets = resolve_targets(pool, &input.space_id, sender, &input.to, content).await?;
    if targets
        .iter()
        .any(|target| target.conversation_id.is_none())
    {
        let _ = ensure_user_member(pool, &input.space_id).await;
    }
    let summary = input
        .summary
        .as_deref()
        .map(str::trim)
        .filter(|summary| !summary.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| content.lines().next().unwrap_or(content).trim().to_string());
    let published = now_stamp();
    let envelope = json!({
        "@context": "https://www.w3.org/ns/activitystreams",
        "type": "Note",
        "id": format!("vibex://space-message/{message_id}"),
        "actor": actor,
        "attributedTo": attributed_to,
        "to": targets
            .iter()
            .map(|target| {
                if target.conversation_id.is_none() {
                    user_actor(&input.space_id)
                } else {
                    member_actor(&input.space_id, &target.nickname)
                }
            })
            .collect::<Vec<_>>(),
        "inReplyTo": input.in_reply_to,
        "summary": summary,
        "content": content,
        "published": published,
    });
    let mut conn = pool.acquire().await.map_err(db)?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    let inserted = async {
        let seq: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM collaboration_space_messages WHERE space_id = ?",
        )
        .bind(&input.space_id)
        .fetch_one(&mut *conn)
        .await?;
        sqlx::query(
            r#"INSERT INTO collaboration_space_messages
               (id, space_id, seq, envelope_json, created_at, origin)
               VALUES (?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&message_id)
        .bind(&input.space_id)
        .bind(seq)
        .bind(envelope.to_string())
        .bind(&published)
        .bind(if sender.is_some() { "agent" } else { "user" })
        .execute(&mut *conn)
        .await?;
        for target in &targets {
            let Some(target_id) = target.conversation_id else {
                continue;
            };
            sqlx::query(
                r#"INSERT INTO collaboration_space_deliveries
                   (space_message_id, conversation_id, operation_id, input_id, status)
                   VALUES (?, ?, ?, NULL, 'queued')"#,
            )
            .bind(&message_id)
            .bind(target_id.to_string())
            .bind(delivery_operation_id(input.operation_id, target_id).to_string())
            .execute(&mut *conn)
            .await?;
        }
        if let Some(sender) = sender {
            sqlx::query(
                r#"UPDATE collaboration_thread_members
                   SET last_active_at = ?, asleep_since = NULL
                   WHERE conversation_id = ?"#,
            )
            .bind(&published)
            .bind(sender.to_string())
            .execute(&mut *conn)
            .await?;
            // The member answered in this thread: everything delivered to it
            // here before this message is now replied.
            sqlx::query(
                r#"UPDATE collaboration_space_deliveries
                   SET receipt_state = 'replied', receipt_updated_at = ?
                   WHERE conversation_id = ? AND receipt_state != 'replied'
                     AND space_message_id IN (
                       SELECT id FROM collaboration_space_messages
                       WHERE space_id = ? AND seq < ?)"#,
            )
            .bind(&published)
            .bind(sender.to_string())
            .bind(&input.space_id)
            .bind(seq)
            .execute(&mut *conn)
            .await?;
        }
        Ok::<i64, sqlx::Error>(seq)
    }
    .await;
    let seq = match inserted {
        Ok(seq) => {
            sqlx::query("COMMIT")
                .execute(&mut *conn)
                .await
                .map_err(db)?;
            seq
        }
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            return Err(db(error));
        }
    };
    drop(conn);
    store_operation(
        pool,
        &message_id,
        Some(&input.space_id),
        &request,
        &json!({ "message_id": message_id }),
    )
    .await?;
    deliver_pending(pool, &input.space_id, &message_id, turn_delivery)
        .await
        .map(|mut result| {
            result.seq = seq;
            result
        })
}

async fn deliver_pending(
    pool: &SqlitePool,
    space_id: &str,
    message_id: &str,
    turn_delivery: &DeliveryContext,
) -> Result<SpacePostResult, CollaborationError> {
    let envelope = load_envelope(pool, message_id).await?;
    let seq: i64 = sqlx::query_scalar("SELECT seq FROM collaboration_space_messages WHERE id = ?")
        .bind(message_id)
        .fetch_one(pool)
        .await
        .map_err(db)?;
    let space_name = sqlx::query_scalar::<_, String>(
        "SELECT name FROM collaboration_spaces WHERE id = ? LIMIT 1",
    )
    .bind(space_id)
    .fetch_optional(pool)
    .await
    .map_err(db)?
    .unwrap_or_else(|| {
        if parse_unassigned_space_id(space_id).is_some() {
            "未定空间".to_string()
        } else {
            space_id.to_string()
        }
    });
    let space_members = list_space_members(pool, space_id, MessageAudience::Agent)
        .await
        .unwrap_or_default();
    let member_nicknames: Vec<String> = space_members
        .iter()
        .map(|member| member.nickname.clone())
        .collect();
    let summary = envelope
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let content = envelope
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let display_text = clean_space_display_text(content, &member_nicknames);
    let attention = build_space_delivery_prompt(
        space_id,
        &space_name,
        message_id,
        seq,
        &envelope,
        &space_members,
        summary,
        content,
        &display_text,
    );
    let pending = sqlx::query_as::<_, PendingDelivery>(
        r#"SELECT conversation_id, operation_id, input_id, status, receipt_state, context_from_seq,
                  wake_deferred_turn_key
           FROM collaboration_space_deliveries
           WHERE space_message_id = ?"#,
    )
    .bind(message_id)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    let mut receipts = Vec::new();
    for delivery in pending {
        let Ok(conversation_id) = Uuid::parse_str(&delivery.conversation_id) else {
            continue;
        };
        let nickname = member_nickname(pool, space_id, conversation_id)
            .await?
            .unwrap_or_else(|| conversation_id.to_string());
        if delivery.input_id.is_some() || delivery.status == "failed" {
            receipts.push(DeliveryReceipt {
                conversation_id,
                nickname,
                delivered: delivery.status,
                state: delivery.receipt_state,
                input_id: delivery
                    .input_id
                    .as_deref()
                    .and_then(|id| Uuid::parse_str(id).ok()),
                error_code: None,
            });
            continue;
        }
        let Ok(operation_id) = Uuid::parse_str(&delivery.operation_id) else {
            continue;
        };
        let Some(target) = load_session(pool, conversation_id).await? else {
            mark_delivery_failed(pool, message_id, conversation_id).await?;
            receipts.push(DeliveryReceipt {
                conversation_id,
                nickname,
                delivered: "failed".to_string(),
                state: delivery.receipt_state.clone(),
                input_id: None,
                error_code: Some("not_found".to_string()),
            });
            continue;
        };
        if target.deleted_at.is_some() || target.status == "archived" {
            mark_delivery_failed(pool, message_id, conversation_id).await?;
            receipts.push(DeliveryReceipt {
                conversation_id,
                nickname,
                delivered: "failed".to_string(),
                state: delivery.receipt_state.clone(),
                input_id: None,
                error_code: Some("not_found".to_string()),
            });
            continue;
        }
        if session_is_asleep(pool, conversation_id).await? {
            let released = match delivery.wake_deferred_turn_key.as_deref() {
                // Held earlier over the cap: deliver once the originating
                // turn has ended ("next turn"), never stall.
                Some(key) => !wake_turn_in_flight(pool, key).await?,
                None => false,
            };
            if !released {
                let turn_key = wake_turn_key(pool, message_id, &envelope).await?;
                if !reserve_wake(
                    pool,
                    &turn_key,
                    conversation_id,
                    message_id,
                    wake_cap_per_turn(),
                )
                .await?
                {
                    // Over the per-turn wake cap: held visibly as
                    // 'limit_reached' until the originating turn ends.
                    hold_over_wake_cap(pool, message_id, conversation_id, &turn_key).await?;
                    receipts.push(DeliveryReceipt {
                        conversation_id,
                        nickname,
                        delivered: "deferred".to_string(),
                        state: WAKE_LIMIT_REACHED.to_string(),
                        input_id: None,
                        error_code: Some("wake_limit_exceeded".to_string()),
                    });
                    continue;
                }
            }
        }
        if !try_acquire_member_write(pool, conversation_id).await? {
            receipts.push(DeliveryReceipt {
                conversation_id,
                nickname,
                delivered: "deferred".to_string(),
                state: delivery.receipt_state.clone(),
                input_id: None,
                error_code: Some("write_serialized_busy".to_string()),
            });
            continue;
        }
        let context_from = match delivery.context_from_seq {
            Some(from) => from,
            None => {
                let from = context_window_start(pool, space_id, conversation_id, seq).await?;
                sqlx::query(
                    r#"UPDATE collaboration_space_deliveries SET context_from_seq = ?
                       WHERE space_message_id = ? AND conversation_id = ?"#,
                )
                .bind(from)
                .bind(message_id)
                .bind(conversation_id.to_string())
                .execute(pool)
                .await
                .map_err(db)?;
                from
            }
        };
        let missed =
            missed_group_context(pool, space_id, conversation_id, context_from, seq).await?;
        let packed = match missed {
            Some(missed) => format!("{missed}\n\n{attention}"),
            None => attention.clone(),
        };
        match deliver_text(
            pool,
            conversation_id,
            operation_id,
            &packed,
            Some(display_text.clone()),
            &target,
            json!({
                "kind": "collaboration_space",
                "spaceId": space_id,
                "messageId": message_id,
            }),
            turn_delivery,
        )
        .await
        {
            Ok(receipt) => {
                let state = if receipt.delivered == "dispatched" {
                    "processing"
                } else {
                    "queued"
                };
                // The queue may already have dispatched the input (trigger),
                // so never move a receipt backwards.
                sqlx::query(
                    r#"UPDATE collaboration_space_deliveries
                       SET input_id = ?, status = ?, wake_deferred_turn_key = NULL,
                           receipt_state = CASE
                             WHEN receipt_state = 'queued' THEN ? ELSE receipt_state END,
                           receipt_updated_at = ?
                       WHERE space_message_id = ? AND conversation_id = ?"#,
                )
                .bind(receipt.input_id.map(|id| id.to_string()))
                .bind(&receipt.delivered)
                .bind(state)
                .bind(now_stamp())
                .bind(message_id)
                .bind(conversation_id.to_string())
                .execute(pool)
                .await
                .map_err(db)?;
                advance_last_seen(pool, space_id, conversation_id, message_id, seq).await?;
                touch_session_activity(pool, conversation_id).await?;
                let state: String = sqlx::query_scalar(
                    r#"SELECT receipt_state FROM collaboration_space_deliveries
                       WHERE space_message_id = ? AND conversation_id = ?"#,
                )
                .bind(message_id)
                .bind(conversation_id.to_string())
                .fetch_one(pool)
                .await
                .map_err(db)?;
                receipts.push(DeliveryReceipt {
                    conversation_id,
                    nickname,
                    delivered: receipt.delivered,
                    state,
                    input_id: receipt.input_id,
                    error_code: None,
                });
            }
            Err(error) => {
                if error.code != "limit_exceeded" {
                    mark_delivery_failed(pool, message_id, conversation_id).await?;
                }
                receipts.push(DeliveryReceipt {
                    conversation_id,
                    nickname,
                    delivered: "failed".to_string(),
                    state: delivery.receipt_state.clone(),
                    input_id: None,
                    error_code: Some(error.code.to_string()),
                });
            }
        }
    }
    Ok(SpacePostResult {
        message_id: message_id.to_string(),
        seq,
        receipts,
    })
}

/// Most recent missed group messages packed verbatim into one delivery;
/// older missed messages collapse into a one-line summary.
pub const MISSED_CONTEXT_VERBATIM: usize = 20;
/// Furthest back (in messages) a missed-context window ever reaches.
const MISSED_CONTEXT_LIMIT: i64 = 500;
/// Per-message character cap inside the packed block.
const MISSED_CONTEXT_MESSAGE_CHARS: usize = 600;

/// Thread binding (`collaboration_thread_members`) of a seat conversation.
async fn seat_binding(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Option<identity::ThreadMemberRow>, CollaborationError> {
    identity::binding_of_conversation(pool, conversation_id)
        .await
        .map_err(db)
}

/// Exclusive lower seq bound of the missed-context window for a delivery of
/// message `seq`: the member's last seen message in this thread, or (never
/// seen) the last `MISSED_CONTEXT_LIMIT` messages.
async fn context_window_start(
    pool: &SqlitePool,
    space_id: &str,
    conversation_id: Uuid,
    seq: i64,
) -> Result<i64, CollaborationError> {
    let last_seen = match seat_binding(pool, conversation_id).await? {
        Some(binding) => match binding_last_seen_seq(pool, space_id, &binding).await? {
            Some(seen) => Some(seen),
            None => None,
        },
        None => None,
    };
    let floor = (seq - 1 - MISSED_CONTEXT_LIMIT).max(0);
    Ok(last_seen
        .map_or(floor, |seen| seen.max(floor))
        .min(seq - 1)
        .max(0))
}

async fn binding_last_seen_seq(
    pool: &SqlitePool,
    space_id: &str,
    binding: &identity::ThreadMemberRow,
) -> Result<Option<i64>, CollaborationError> {
    sqlx::query_scalar::<_, i64>(
        r#"SELECT m.seq FROM collaboration_thread_members tm
           JOIN collaboration_space_messages m
             ON m.id = tm.last_seen_message_id AND m.space_id = ?
           WHERE tm.thread_id = ? AND tm.member_id = ?"#,
    )
    .bind(space_id)
    .bind(&binding.thread_id)
    .bind(&binding.member_id)
    .fetch_optional(pool)
    .await
    .map_err(db)
}

/// Group messages in `(from_seq, before_seq)` that this conversation did not
/// author, rendered as a "while you were away" block. `None` when empty.
async fn missed_group_context(
    pool: &SqlitePool,
    space_id: &str,
    conversation_id: Uuid,
    from_seq: i64,
    before_seq: i64,
) -> Result<Option<String>, CollaborationError> {
    if before_seq - from_seq <= 1 {
        return Ok(None);
    }
    let rows = sqlx::query_as::<_, (i64, String)>(
        r#"SELECT seq, envelope_json FROM collaboration_space_messages
           WHERE space_id = ? AND seq > ? AND seq < ?
           ORDER BY seq DESC LIMIT ?"#,
    )
    .bind(space_id)
    .bind(from_seq)
    .bind(before_seq)
    .bind(MISSED_CONTEXT_LIMIT)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    let own = format!("vibex://conversation/{conversation_id}");
    let user_uri = user_actor(space_id);
    let mut lines = Vec::new();
    for (seq, raw) in rows {
        let Ok(envelope) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        if envelope.get("attributedTo").and_then(Value::as_str) == Some(own.as_str()) {
            continue;
        }
        let actor = envelope
            .get("actor")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let who = if actor == user_uri {
            "User".to_string()
        } else {
            actor.rsplit("/member/").next().unwrap_or(actor).to_string()
        };
        let content = envelope
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default();
        lines.push((seq, who, content.to_string()));
    }
    if lines.is_empty() {
        return Ok(None);
    }
    lines.reverse();
    let older = lines.len().saturating_sub(MISSED_CONTEXT_VERBATIM);
    let mut out = Vec::new();
    if older > 0 {
        let collapsed = &lines[..older];
        let mut who: Vec<&str> = Vec::new();
        for (_, name, _) in collapsed {
            if !who.contains(&name.as_str()) {
                who.push(name);
            }
        }
        out.push(format!(
            "[#{}–#{}] {older} earlier messages from {} (collapsed; use space history to read them)",
            collapsed[0].0,
            collapsed[older - 1].0,
            who.join(", ")
        ));
    }
    for (seq, who, content) in &lines[older..] {
        let mut content = content.clone();
        if content.chars().count() > MISSED_CONTEXT_MESSAGE_CHARS {
            content = content
                .chars()
                .take(MISSED_CONTEXT_MESSAGE_CHARS)
                .collect::<String>()
                + "…";
        }
        out.push(format!("[#{seq}] {who}: {content}"));
    }
    Ok(Some(format!(
        "<missed_group_messages count=\"{}\">\n{}\n</missed_group_messages>",
        lines.len(),
        out.join("\n")
    )))
}

/// Record that the member behind `conversation_id` has now seen `message_id`
/// (seq `seq`) in this thread. Never moves backwards.
async fn advance_last_seen(
    pool: &SqlitePool,
    space_id: &str,
    conversation_id: Uuid,
    message_id: &str,
    seq: i64,
) -> Result<(), CollaborationError> {
    let Some(binding) = seat_binding(pool, conversation_id).await? else {
        return Ok(());
    };
    let current = binding_last_seen_seq(pool, space_id, &binding).await?;
    if current.is_some_and(|seen| seen >= seq) {
        return Ok(());
    }
    sqlx::query(
        r#"UPDATE collaboration_thread_members SET last_seen_message_id = ?
           WHERE thread_id = ? AND member_id = ?"#,
    )
    .bind(message_id)
    .bind(&binding.thread_id)
    .bind(&binding.member_id)
    .execute(pool)
    .await
    .map_err(db)?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct SpaceMessage {
    pub seq: i64,
    pub envelope: Value,
    /// `user` or `agent`.
    pub origin: String,
    /// Per-recipient three-state receipts (empty for agent audiences).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub receipts: Vec<MessageReceipt>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MessageReceipt {
    pub conversation_id: String,
    pub state: String,
    pub delivered: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

/// Receipts of `message_id`, one per recipient conversation.
pub async fn list_message_receipts(
    pool: &SqlitePool,
    message_id: &str,
) -> Result<Vec<MessageReceipt>, CollaborationError> {
    let rows = sqlx::query_as::<_, (String, String, String, Option<String>)>(
        r#"SELECT conversation_id,
                  CASE WHEN receipt_state = 'queued' AND wake_deferred_turn_key IS NOT NULL
                       THEN 'limit_reached' ELSE receipt_state END,
                  status, COALESCE(receipt_updated_at, wake_deferred_at)
           FROM collaboration_space_deliveries WHERE space_message_id = ?
           ORDER BY conversation_id"#,
    )
    .bind(message_id)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    Ok(rows
        .into_iter()
        .map(
            |(conversation_id, state, delivered, updated_at)| MessageReceipt {
                conversation_id,
                state,
                delivered,
                updated_at,
            },
        )
        .collect())
}

pub async fn list_space_messages(
    pool: &SqlitePool,
    space_id: &str,
    since_seq: Option<i64>,
    limit: Option<i64>,
    audience: MessageAudience,
) -> Result<Vec<SpaceMessage>, CollaborationError> {
    load_space(pool, space_id).await?;
    let limit = limit
        .unwrap_or(SPACE_LIST_DEFAULT)
        .clamp(1, SPACE_LIST_HARD_CAP);
    let since = since_seq.unwrap_or(0);
    let rows = sqlx::query_as::<_, (i64, String, String, String)>(
        r#"SELECT seq, envelope_json, origin, id FROM collaboration_space_messages
           WHERE space_id = ? AND seq > ?
           ORDER BY seq ASC LIMIT ?"#,
    )
    .bind(space_id)
    .bind(since)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    let user_uri = user_actor(space_id);
    let mut receipts_by_message = std::collections::HashMap::new();
    if audience == MessageAudience::User {
        for (_, _, _, id) in &rows {
            receipts_by_message.insert(id.clone(), list_message_receipts(pool, id).await?);
        }
    }
    Ok(rows
        .into_iter()
        .filter_map(|(seq, raw, origin, id)| {
            let mut envelope: Value = serde_json::from_str(&raw).ok()?;
            if audience == MessageAudience::Agent {
                if let Some(to) = envelope.get_mut("to").and_then(Value::as_array_mut) {
                    to.retain(|item| item.as_str() != Some(user_uri.as_str()));
                }
                if envelope.get("actor").and_then(Value::as_str) == Some(user_uri.as_str()) {
                    envelope["actor"] = json!("user");
                }
            }
            let receipts = receipts_by_message.remove(&id).unwrap_or_default();
            Some(SpaceMessage {
                seq,
                envelope,
                origin,
                receipts,
            })
        })
        .collect())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduledSpaceMessage {
    pub id: String,
    pub space_id: String,
    pub caller_id: Option<String>,
    pub nickname: String,
    pub content: String,
    pub summary: Option<String>,
    pub to: Vec<String>,
    pub deliver_at: String,
    pub created_at: String,
}

pub async fn list_space_scheduled_messages(
    pool: &SqlitePool,
    space_id: &str,
) -> Result<Vec<ScheduledSpaceMessage>, CollaborationError> {
    let rows = sqlx::query_as::<_, (String, String, String, String, String)>(
        r#"SELECT id, payload_json, principal_json, deliver_at, created_at
           FROM conversation_delayed_inputs
           WHERE status = 'scheduled'
             AND json_extract(principal_json, '$.kind') = 'collaboration_space_post'
             AND json_extract(principal_json, '$.space_id') = ?
           ORDER BY deliver_at ASC, created_at ASC"#,
    )
    .bind(space_id)
    .fetch_all(pool)
    .await
    .map_err(db)?;

    let mut items = Vec::with_capacity(rows.len());
    for (id, payload_raw, principal_raw, deliver_at, created_at) in rows {
        let payload: Value = serde_json::from_str(&payload_raw).unwrap_or_else(|_| json!({}));
        let principal: Value = serde_json::from_str(&principal_raw).unwrap_or_else(|_| json!({}));
        let caller_id = payload
            .get("caller_id")
            .and_then(Value::as_str)
            .or_else(|| principal.get("caller_id").and_then(Value::as_str))
            .map(str::to_string);
        let nickname = payload
            .get("nickname")
            .and_then(Value::as_str)
            .or_else(|| principal.get("nickname").and_then(Value::as_str))
            .unwrap_or("user")
            .to_string();
        let content = payload
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let summary = payload
            .get("summary")
            .and_then(Value::as_str)
            .map(str::to_string);
        let to = payload
            .get("to")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        items.push(ScheduledSpaceMessage {
            id,
            space_id: space_id.to_string(),
            caller_id,
            nickname,
            content,
            summary,
            to,
            deliver_at,
            created_at,
        });
    }
    Ok(items)
}

pub async fn cancel_space_scheduled_message(
    pool: &SqlitePool,
    space_id: &str,
    id: &str,
) -> Result<bool, CollaborationError> {
    let result = sqlx::query(
        r#"UPDATE conversation_delayed_inputs
           SET status = 'cancelled'
           WHERE id = ? AND status = 'scheduled'
             AND json_extract(principal_json, '$.kind') = 'collaboration_space_post'
             AND json_extract(principal_json, '$.space_id') = ?"#,
    )
    .bind(id)
    .bind(space_id)
    .execute(pool)
    .await
    .map_err(db)?;
    Ok(result.rows_affected() > 0)
}

pub async fn update_space_scheduled_message(
    pool: &SqlitePool,
    space_id: &str,
    id: &str,
    content: Option<&str>,
    delay_seconds: Option<i64>,
) -> Result<Option<ScheduledSpaceMessage>, CollaborationError> {
    let row = sqlx::query_as::<_, (String, String, String, String)>(
        r#"SELECT payload_json, principal_json, deliver_at, created_at
           FROM conversation_delayed_inputs
           WHERE id = ? AND status = 'scheduled'
             AND json_extract(principal_json, '$.kind') = 'collaboration_space_post'
             AND json_extract(principal_json, '$.space_id') = ?"#,
    )
    .bind(id)
    .bind(space_id)
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    let Some((payload_raw, _principal_raw, deliver_at, _created_at)) = row else {
        return Ok(None);
    };
    let mut payload: Value = serde_json::from_str(&payload_raw).unwrap_or_else(|_| json!({}));
    if let Some(next_content) = content.map(str::trim).filter(|c| !c.is_empty()) {
        payload["content"] = json!(next_content);
    }
    let next_deliver_at = match delay_seconds.filter(|s| *s > 0) {
        Some(seconds) => stamp(Utc::now() + Duration::seconds(seconds)),
        None => deliver_at,
    };
    let next_text = payload
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let digest = digest_text(next_text);
    sqlx::query(
        r#"UPDATE conversation_delayed_inputs
           SET payload_json = ?, payload_digest = ?, deliver_at = ?
           WHERE id = ? AND status = 'scheduled'"#,
    )
    .bind(payload.to_string())
    .bind(&digest)
    .bind(&next_deliver_at)
    .bind(id)
    .execute(pool)
    .await
    .map_err(db)?;
    let all = list_space_scheduled_messages(pool, space_id).await?;
    Ok(all.into_iter().find(|item| item.id == id))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, FromRow)]
pub struct MemberRecord {
    pub member_id: String,
    pub conversation_id: Option<String>,
    pub nickname: String,
    pub kind: String,
    pub visible_to_agents: i64,
}

pub async fn list_space_members(
    pool: &SqlitePool,
    space_id: &str,
    audience: MessageAudience,
) -> Result<Vec<MemberRecord>, CollaborationError> {
    if audience == MessageAudience::Agent {
        load_space(pool, space_id).await?;
    } else {
        load_space_or_unassigned(pool, space_id).await?;
    }
    let mut members = sqlx::query_as::<_, MemberRecord>(
        r#"SELECT member_id, conversation_id, nickname, kind, visible_to_agents
           FROM collaboration_space_members WHERE space_id = ? ORDER BY nickname"#,
    )
    .bind(space_id)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    if audience == MessageAudience::Agent {
        members.retain(|member| member.visible_to_agents != 0 && member.kind == "agent");
    }
    Ok(members)
}

pub async fn ensure_user_member(
    pool: &SqlitePool,
    space_id: &str,
) -> Result<MemberRecord, CollaborationError> {
    load_space(pool, space_id).await?;
    if let Some(existing) = sqlx::query_as::<_, MemberRecord>(
        r#"SELECT member_id, conversation_id, nickname, kind, visible_to_agents
           FROM collaboration_space_members WHERE space_id = ? AND kind = 'user' LIMIT 1"#,
    )
    .bind(space_id)
    .fetch_optional(pool)
    .await
    .map_err(db)?
    {
        return Ok(existing);
    }
    insert_member(pool, space_id, None, "你", "user", false).await
}

#[derive(Debug, Clone)]
struct ResolvedTarget {
    conversation_id: Option<Uuid>,
    nickname: String,
}

fn is_user_target_name(raw: &str) -> bool {
    let trimmed = raw.trim().trim_start_matches('@').trim();
    trimmed.eq_ignore_ascii_case("user") || trimmed == "你" || trimmed == "用户"
}

fn is_valid_mention_boundary(name: &str, after: Option<char>) -> bool {
    let Some(next) = after else {
        return true;
    };
    let ends_ascii_word = name
        .chars()
        .last()
        .is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_');
    if ends_ascii_word && (next.is_ascii_alphanumeric() || next == '_') {
        return false;
    }
    true
}

fn contains_mention_token(content: &str, name: &str) -> bool {
    let name = name.trim();
    if name.is_empty() {
        return false;
    }
    let needle = format!("@{name}");
    for (idx, _) in content.match_indices(&needle) {
        if idx > 0 {
            let prev = content[..idx].chars().last();
            if prev.is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '@') {
                continue;
            }
        }
        let after = content[idx + needle.len()..].chars().next();
        if is_valid_mention_boundary(name, after) {
            return true;
        }
    }
    false
}

pub fn clean_space_display_text(content: &str, member_nicknames: &[String]) -> String {
    let mut candidates: Vec<String> = member_nicknames
        .iter()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .collect();
    for builtin in ["User", "user", "你", "用户"] {
        if !candidates.iter().any(|existing| existing == builtin) {
            candidates.push(builtin.to_string());
        }
    }
    candidates.sort_by(|a, b| b.chars().count().cmp(&a.chars().count()));

    let mut rest = content.trim();
    loop {
        let trimmed = rest.trim_start();
        let Some(after_at) = trimmed.strip_prefix('@') else {
            break;
        };
        let mut matched_len = None;
        for cand in &candidates {
            if let Some(rem) = after_at.strip_prefix(cand.as_str())
                && is_valid_mention_boundary(cand, rem.chars().next())
            {
                matched_len = Some(cand.len());
                break;
            }
        }
        let Some(len) = matched_len else {
            break;
        };
        rest = after_at[len..].trim_start_matches([' ', '\t', ',', '，', ':', '：']);
    }

    let mut cleaned = rest.trim().to_string();
    for cand in &candidates {
        let token = format!("@{cand}");
        let mut offset = 0;
        while let Some(pos) = cleaned[offset..].find(&token) {
            let idx = offset + pos;
            let prev_ok = if idx == 0 {
                true
            } else {
                !cleaned[..idx]
                    .chars()
                    .last()
                    .is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '@')
            };
            let after_idx = idx + token.len();
            let after_char = cleaned[after_idx..].chars().next();
            if prev_ok && is_valid_mention_boundary(cand, after_char) {
                let mut end = after_idx;
                if cleaned[end..].starts_with(' ') && idx > 0 && cleaned[..idx].ends_with(' ') {
                    end += 1;
                }
                cleaned.replace_range(idx..end, "");
                offset = idx;
            } else {
                offset = after_idx;
            }
        }
    }
    let final_text = cleaned.trim();
    if final_text.is_empty() {
        content.trim().to_string()
    } else {
        final_text.to_string()
    }
}

fn build_space_delivery_prompt(
    space_id: &str,
    space_name: &str,
    message_id: &str,
    seq: i64,
    envelope: &Value,
    space_members: &[MemberRecord],
    summary: &str,
    content: &str,
    display_text: &str,
) -> String {
    let actor = envelope
        .get("actor")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let attributed_to = envelope.get("attributedTo").and_then(Value::as_str);
    let user_uri = user_actor(space_id);
    let sender_label = if actor == user_uri || actor == "user" {
        "User（用户）".to_string()
    } else if let Some(nick) = actor.rsplit("/member/").next().filter(|v| *v != actor) {
        if let Some(conv_uri) = attributed_to {
            let conv_id = conv_uri.rsplit('/').next().unwrap_or(conv_uri);
            format!("{nick} (conversation_id: {conv_id})")
        } else {
            nick.to_string()
        }
    } else {
        actor.to_string()
    };

    let to_labels: Vec<String> = envelope
        .get("to")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|uri| {
                    if uri == user_uri || uri.ends_with("/user") {
                        "@User".to_string()
                    } else if let Some(nick) = uri.rsplit("/member/").next().filter(|v| *v != uri) {
                        format!("@{nick}")
                    } else {
                        uri.to_string()
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    let recipients_label = if to_labels.is_empty() {
        "全体成员".to_string()
    } else {
        to_labels.join("、")
    };

    let roster_items: Vec<String> = space_members
        .iter()
        .map(|member| match member.conversation_id.as_deref() {
            Some(cid) => format!("{} (conversation_id: {})", member.nickname, cid),
            None => member.nickname.clone(),
        })
        .collect();
    let roster_label = if roster_items.is_empty() {
        "User（用户）".to_string()
    } else {
        format!("{}，以及 User（用户）", roster_items.join("、"))
    };

    let body = if !display_text.trim().is_empty() {
        display_text.trim()
    } else {
        content.trim()
    };
    let summary_trimmed = summary.trim();
    let distinct_summary = !summary_trimmed.is_empty()
        && summary_trimmed != content.trim()
        && summary_trimmed != body
        && !content.trim().starts_with(summary_trimmed)
        && !body.starts_with(summary_trimmed);

    let rules = format_collaboration_space_rules(Some(space_id));
    let mut prompt = format!(
        "[协作空间消息]\n\
         - 来源协作空间：{space_name} (space_id: {space_id})\n\
         - 消息来源：{sender_label}\n\
         - 收件成员：{recipients_label}\n\
         - 消息序号：#{seq} (message_id: vibex://space-message/{message_id})\n\
         - 空间内成员：{roster_label}\n\
         {rules}\n\n"
    );
    if distinct_summary {
        prompt.push_str(&format!("摘要：{summary_trimmed}\n\n"));
    }
    prompt.push_str(body);
    prompt
}

const COLLABORATION_MCP_TOOLS_SUMMARY: &str = "你可以使用 `list_collaboration_spaces`（查看所在协作空间）、`list_space_members`（查看同空间成员详情）、`list_space_messages`（单次读取空间消息）、`post_to_space`（向用户发消息传 `to: [\"User\"]` 并以 `@User ` 开头；向其他成员发消息传 `to: [\"成员昵称\"]` 并以 `@成员昵称 ` 开头），以及群收藏工具 `list_space_collection`（列出群收藏记录及地址索引）、`add_to_space_collection`（向群收藏写入共享文本 `content` 或文件/图片路径 `source_path` 及备注 `note`，严禁传二进制）、`read_space_collection_item`（登记读取记录并获取单条收藏的 `file_path` 地址）。";

fn format_collaboration_space_rules(space_id_hint: Option<&str>) -> String {
    let header = match space_id_hint {
        Some(space_id) => format!(
            "- 协同交互规则（完整规范见 `vibex-multi-agent` Skill 的 `COLLABORATION-SPACE.md`）：使用 `post_to_space`（传入 `space_id: \"{space_id}\"`）时须遵守："
        ),
        None => {
            "- 协作空间交互规则（详见 `vibex-multi-agent` Skill 的 `COLLABORATION-SPACE.md`）："
                .to_string()
        }
    };
    format!(
        "{header}\n\
           1) 收到 User 消息先应答再执行：若本条消息来自 User 且需要调用工具、排查代码、检索资料或找成员协作，必须先调用一次 `post_to_space`（`to: [\"User\"]`，`content` 以 `@User ` 开头）简短回复已收到及处理计划（1~2 句），然后再继续开展工作，后续视进展向 `@User` 或 `@成员昵称` 同步与交付结果；\n\
           2) 无需回复即停止：若收到的消息仅是纯确认/礼貌收尾（如“收到”、“已收到”、“好的”、“明白”、“OK”、“谢谢”）或事项已闭环、不需要你提供新信息或执行新动作，直接结束当前回合，严禁再调用 `post_to_space` 回复“好的/收到”；向其他成员发消息时也不要要求“收到请回复”；\n\
           3) 对用户屏蔽内部参数：向 `@User` 发消息时严禁在正文中包含 `space_id`、`conversation_id`、`delayed_input_id`、`operation_id`、`message_id`、`task_id`、`turn_id`、`seq`、`vibex://` 等用户不可达的系统内部参数；仅在向 `@成员昵称` 发消息且对方确需调用底层跨会话工具时才按需附带；\n\
           4) 空间感知与群收藏（临界区）工具：可按需单次调用 `list_collaboration_spaces`、`list_space_members`、`list_space_messages`（禁止循环轮询等待），以及使用 `list_space_collection`、`add_to_space_collection`、`read_space_collection_item` 在群收藏中沉淀或读取跨成员共享的文本、图片、文件产物（群收藏仅保存磁盘地址索引与元数据，不可直接传入二进制，调用 `add_to_space_collection` 传入 `content` 或 `source_path` 即落盘到共享目录，调用 `read_space_collection_item` 登记读取记录并获取 `file_path` 后按路径访问）。"
    )
}

async fn batch_load_space_members_by_space(
    pool: &SqlitePool,
    space_ids: &[String],
    audience: MessageAudience,
) -> Result<std::collections::HashMap<String, Vec<MemberRecord>>, CollaborationError> {
    let mut grouped: std::collections::HashMap<String, Vec<MemberRecord>> =
        std::collections::HashMap::new();
    if space_ids.is_empty() {
        return Ok(grouped);
    }
    let mut builder = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
        r#"SELECT member_id, space_id, kind, nickname, conversation_id, visible_to_agents
           FROM collaboration_space_members
           WHERE space_id IN ("#,
    );
    let mut separated = builder.separated(", ");
    for sid in space_ids {
        separated.push_bind(sid);
    }
    separated.push_unseparated(")");
    if audience == MessageAudience::Agent {
        builder.push(" AND visible_to_agents != 0 AND kind = 'agent'");
    }
    builder.push(" ORDER BY space_id, nickname");
    let rows = builder
        .build_query_as::<(String, String, String, String, Option<String>, i64)>()
        .fetch_all(pool)
        .await
        .map_err(db)?;
    for (member_id, space_id, kind, nickname, conversation_id, visible_to_agents) in rows {
        grouped.entry(space_id).or_default().push(MemberRecord {
            member_id,
            kind,
            nickname,
            conversation_id,
            visible_to_agents,
        });
    }
    Ok(grouped)
}

pub async fn member_space_context_text(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Option<String>, CollaborationError> {
    let memberships = sqlx::query_as::<_, (String, String)>(
        r#"SELECT space_id, nickname
           FROM collaboration_space_members
           WHERE conversation_id = ? AND kind = 'agent'
           ORDER BY space_id"#,
    )
    .bind(conversation_id.to_string())
    .fetch_all(pool)
    .await
    .map_err(db)?;
    if memberships.is_empty() {
        return Ok(None);
    }

    let space_ids: Vec<String> = memberships.iter().map(|(sid, _)| sid.clone()).collect();
    let mut space_names: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    {
        let mut builder = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
            "SELECT id, name FROM collaboration_spaces WHERE id IN (",
        );
        let mut separated = builder.separated(", ");
        for sid in &space_ids {
            separated.push_bind(sid);
        }
        separated.push_unseparated(")");
        let rows = builder
            .build_query_as::<(String, String)>()
            .fetch_all(pool)
            .await
            .map_err(db)?;
        for (id, name) in rows {
            space_names.insert(id, name);
        }
    }
    let mut members_by_space =
        batch_load_space_members_by_space(pool, &space_ids, MessageAudience::User).await?;

    let mut sections = Vec::new();
    for (space_id, my_nickname) in memberships {
        let space_name = space_names.remove(&space_id).unwrap_or_else(|| {
            if parse_unassigned_space_id(&space_id).is_some() {
                "未定空间".to_string()
            } else {
                space_id.clone()
            }
        });
        let members = members_by_space.remove(&space_id).unwrap_or_default();
        let peers: Vec<String> = members
            .into_iter()
            .filter(|m| m.kind == "agent" && m.visible_to_agents != 0)
            .map(|m| match m.conversation_id.as_deref() {
                Some(cid) if cid == conversation_id.to_string() => {
                    format!("{}（你自己, conversation_id: {}）", m.nickname, cid)
                }
                Some(cid) => format!("{} (conversation_id: {})", m.nickname, cid),
                None => m.nickname,
            })
            .collect();
        let peers_label = if peers.is_empty() {
            "User（用户）".to_string()
        } else {
            format!("{}，以及 User（用户）", peers.join("、"))
        };
        sections.push(format!(
            "- 所属协作空间：{space_name} (space_id: {space_id})\n  你的成员昵称：{my_nickname} (conversation_id: {conversation_id})\n  同空间成员：{peers_label}"
        ));
    }

    let rules = format_collaboration_space_rules(None);
    Ok(Some(format!(
        "[协作空间成员身份]\n\
         {}\n\
         - 多智能体协同 MCP 工具：{COLLABORATION_MCP_TOOLS_SUMMARY}\n\
         {rules}",
        sections.join("\n")
    )))
}

pub async fn list_collaboration_spaces_for_caller(
    pool: &SqlitePool,
    caller_id: Uuid,
) -> Result<Value, CollaborationError> {
    let caller = live_session(load_session(pool, caller_id).await?)?;
    let spaces = list_workspace_spaces(pool, caller.workspace_id).await?;
    let space_ids: Vec<String> = spaces.iter().map(|s| s.space_id.clone()).collect();
    let mut members_by_space =
        batch_load_space_members_by_space(pool, &space_ids, MessageAudience::Agent).await?;
    let caller_str = caller_id.to_string();
    let mut items = Vec::with_capacity(spaces.len());
    for space in spaces {
        let members = members_by_space.remove(&space.space_id).unwrap_or_default();
        let my_member = members
            .iter()
            .find(|m| m.conversation_id.as_deref() == Some(caller_str.as_str()));
        let member_views: Vec<Value> = members
            .iter()
            .map(|m| {
                json!({
                    "member_id": m.member_id,
                    "nickname": m.nickname,
                    "conversation_id": m.conversation_id,
                    "kind": m.kind,
                    "is_self": m.conversation_id.as_deref() == Some(caller_str.as_str()),
                })
            })
            .collect();
        items.push(json!({
            "space_id": space.space_id,
            "name": space.name,
            "workspace_id": space.workspace_id,
            "is_member": my_member.is_some(),
            "my_nickname": my_member.map(|m| m.nickname.clone()),
            "member_count": member_views.len(),
            "members": member_views,
            "user_recipient": "User",
        }));
    }
    Ok(json!({
        "caller_conversation_id": caller_id,
        "workspace_id": caller.workspace_id,
        "spaces": items,
    }))
}

pub async fn list_space_members_detailed(
    pool: &SqlitePool,
    caller_id: Uuid,
    space_id: &str,
) -> Result<Value, CollaborationError> {
    let space_row = load_space_or_unassigned(pool, space_id).await?;
    let space_name = sqlx::query_scalar::<_, String>(
        "SELECT name FROM collaboration_spaces WHERE id = ? LIMIT 1",
    )
    .bind(space_id)
    .fetch_optional(pool)
    .await
    .map_err(db)?
    .unwrap_or_else(|| {
        if parse_unassigned_space_id(space_id).is_some() {
            "未定空间".to_string()
        } else {
            space_id.to_string()
        }
    });
    let members = list_space_members(pool, space_id, MessageAudience::Agent).await?;
    let workspace_uuid = Uuid::parse_str(&space_row.workspace_id).ok();
    let conversations = match workspace_uuid {
        Some(wid) => list_workspace_conversations(pool, wid)
            .await
            .unwrap_or_default(),
        None => Vec::new(),
    };
    let caller_str = caller_id.to_string();
    let mut my_nickname = None;
    let mut detailed = Vec::new();
    for member in members {
        if member.conversation_id.as_deref() == Some(caller_str.as_str()) {
            my_nickname = Some(member.nickname.clone());
        }
        let conv_opt = member
            .conversation_id
            .as_deref()
            .and_then(|cid| Uuid::parse_str(cid).ok())
            .and_then(|cid| conversations.iter().find(|c| c.conversation_id == cid));
        let persona = match member
            .conversation_id
            .as_deref()
            .and_then(|cid| Uuid::parse_str(cid).ok())
        {
            Some(cid) => conversation_persona(pool, cid).await.ok().flatten(),
            None => None,
        };
        detailed.push(json!({
            "member_id": member.member_id,
            "conversation_id": member.conversation_id,
            "nickname": member.nickname,
            "kind": member.kind,
            "visible_to_agents": member.visible_to_agents,
            "is_self": member.conversation_id.as_deref() == Some(caller_str.as_str()),
            "agent_id": conv_opt.and_then(|c| c.agent_id.clone()).or_else(|| persona.as_ref().map(|p| p.agent_name.clone())),
            "status": conv_opt.map(|c| c.status.clone()),
            "turn_in_flight": conv_opt.map(|c| c.turn_in_flight).unwrap_or(false),
            "team_name": persona.as_ref().and_then(|p| p.team_name.clone()),
            "summary": persona.as_ref().and_then(|p| p.summary.clone()),
        }));
    }
    Ok(json!({
        "space_id": space_id,
        "space_name": space_name,
        "my_conversation_id": caller_id,
        "my_nickname": my_nickname,
        "members": detailed,
        "user_recipient": {
            "nickname": "User",
            "aliases": ["@User", "@你", "@用户"],
            "usage": "在 post_to_space 的 to 中传入 \"User\" 并在 content 中以 @User 开头即可向用户汇报或提问"
        }
    }))
}

/// Resolve recipients, then map every agent seat through its member identity
/// (`resolve_session`) so delivery always lands in the member's conversation
/// for this space's thread.
async fn resolve_targets(
    pool: &SqlitePool,
    space_id: &str,
    sender: Option<Uuid>,
    nicknames: &[String],
    content: &str,
) -> Result<Vec<ResolvedTarget>, CollaborationError> {
    let mut targets = resolve_seat_targets(pool, space_id, sender, nicknames, content).await?;
    for target in &mut targets {
        if let Some(conversation_id) = target.conversation_id {
            target.conversation_id =
                Some(resolve_seat_target(pool, space_id, conversation_id, &target.nickname).await?);
        }
    }
    Ok(targets)
}

async fn resolve_seat_targets(
    pool: &SqlitePool,
    space_id: &str,
    sender: Option<Uuid>,
    nicknames: &[String],
    content: &str,
) -> Result<Vec<ResolvedTarget>, CollaborationError> {
    let members = list_space_members(pool, space_id, MessageAudience::Agent).await?;
    if nicknames.is_empty() {
        let mut mentioned = Vec::new();
        for member in &members {
            if contains_mention_token(content, &member.nickname) {
                let conversation_id = member
                    .conversation_id
                    .as_deref()
                    .and_then(|id| Uuid::parse_str(id).ok());
                if conversation_id == sender {
                    continue;
                }
                if let Some(conversation_id) = conversation_id {
                    mentioned.push(ResolvedTarget {
                        conversation_id: Some(conversation_id),
                        nickname: member.nickname.clone(),
                    });
                }
            }
        }
        if sender.is_some()
            && ["User", "user", "你", "用户"]
                .iter()
                .any(|alias| contains_mention_token(content, alias))
        {
            mentioned.push(ResolvedTarget {
                conversation_id: None,
                nickname: "User".to_string(),
            });
        }
        if !mentioned.is_empty() {
            return Ok(mentioned);
        }
        return Ok(members
            .into_iter()
            .filter_map(|member| {
                let conversation_id = member
                    .conversation_id
                    .and_then(|id| Uuid::parse_str(&id).ok());
                if conversation_id == sender {
                    return None;
                }
                conversation_id.map(|conversation_id| ResolvedTarget {
                    conversation_id: Some(conversation_id),
                    nickname: member.nickname,
                })
            })
            .collect());
    }
    let mut targets = Vec::new();
    for raw_nickname in nicknames {
        let nickname = raw_nickname.trim().trim_start_matches('@').trim();
        if nickname.is_empty() {
            continue;
        }
        if is_user_target_name(nickname) {
            if sender.is_some()
                && !targets
                    .iter()
                    .any(|t: &ResolvedTarget| t.conversation_id.is_none())
            {
                targets.push(ResolvedTarget {
                    conversation_id: None,
                    nickname: "User".to_string(),
                });
            }
            continue;
        }
        let Some(member) = members.iter().find(|member| {
            member.nickname == nickname || member.conversation_id.as_deref() == Some(nickname)
        }) else {
            return Err(CollaborationError::new(
                "not_found",
                "nickname was not found",
            ));
        };
        let conversation_id = member
            .conversation_id
            .as_deref()
            .and_then(|id| Uuid::parse_str(id).ok());
        if conversation_id == sender {
            continue;
        }
        if targets
            .iter()
            .any(|t| t.conversation_id == conversation_id && t.nickname == member.nickname)
        {
            continue;
        }
        targets.push(ResolvedTarget {
            conversation_id,
            nickname: member.nickname.clone(),
        });
    }
    Ok(targets)
}

/// Who a draft would wake if posted now. Pure read: resolves recipients the
/// way `post_to_space` does (explicit `to`, then @-mentions, otherwise every
/// agent seat except the sender) without creating any session.
#[derive(Debug, Clone, Serialize)]
pub struct WakePreview {
    /// Agent members the post would deliver to.
    pub will_wake: usize,
    pub nicknames: Vec<String>,
    /// True when no explicit recipient or @-mention narrowed the audience.
    pub broadcast: bool,
    /// How many of those members' thread sessions are asleep.
    pub asleep: usize,
}

pub async fn preview_space_wake(
    pool: &SqlitePool,
    space_id: &str,
    caller_id: Option<Uuid>,
    content: &str,
    to: &[String],
) -> Result<WakePreview, CollaborationError> {
    load_space_or_unassigned(pool, space_id).await?;
    let sender = match caller_id {
        Some(caller_id) => {
            let member = caller_seat(pool, space_id, caller_id).await?;
            Some(seat_conversation(&member).unwrap_or(caller_id))
        }
        None => None,
    };
    let members = list_space_members(pool, space_id, MessageAudience::Agent).await?;
    let mentioned = to.iter().any(|name| !name.trim().is_empty())
        || members
            .iter()
            .any(|member| contains_mention_token(content, &member.nickname));
    let targets = resolve_seat_targets(pool, space_id, sender, to, content).await?;
    let mut nicknames = Vec::new();
    let mut asleep = 0;
    for target in targets {
        let Some(conversation_id) = target.conversation_id else {
            continue;
        };
        if session_is_asleep(pool, conversation_id).await? {
            asleep += 1;
        }
        nicknames.push(target.nickname);
    }
    Ok(WakePreview {
        will_wake: nicknames.len(),
        nicknames,
        broadcast: !mentioned,
        asleep,
    })
}

/// Whether the thread session behind `conversation_id` is asleep.
async fn session_is_asleep(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<bool, CollaborationError> {
    let asleep: Option<Option<String>> = sqlx::query_scalar(
        "SELECT asleep_since FROM collaboration_thread_members WHERE conversation_id = ?",
    )
    .bind(conversation_id.to_string())
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    Ok(matches!(asleep, Some(Some(_))))
}

/// Default idle time before a member's thread session sleeps.
pub const DEFAULT_IDLE_SLEEP_MINUTES: i64 = 30;
/// Default cap on sleeping sessions one originating turn may wake.
pub const DEFAULT_WAKE_CAP_PER_TURN: i64 = 3;

fn env_i64(key: &str, default: i64) -> i64 {
    std::env::var(key)
        .ok()
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .filter(|value| *value >= 0)
        .unwrap_or(default)
}

/// `VIBEX_MEMBER_IDLE_MINUTES` (default 30; 0 disables sleeping).
pub fn idle_sleep_minutes() -> i64 {
    env_i64("VIBEX_MEMBER_IDLE_MINUTES", DEFAULT_IDLE_SLEEP_MINUTES)
}

/// `VIBEX_MEMBER_WAKE_CAP` (default 3) sleeping sessions woken per turn.
pub fn wake_cap_per_turn() -> i64 {
    env_i64("VIBEX_MEMBER_WAKE_CAP", DEFAULT_WAKE_CAP_PER_TURN)
}

/// Mark the thread session behind `conversation_id` active (and awake).
async fn touch_session_activity(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<(), CollaborationError> {
    sqlx::query(
        r#"UPDATE collaboration_thread_members
           SET last_active_at = ?, asleep_since = NULL
           WHERE conversation_id = ?"#,
    )
    .bind(now_stamp())
    .bind(conversation_id.to_string())
    .execute(pool)
    .await
    .map_err(db)?;
    Ok(())
}

/// Put thread sessions to sleep that have been idle for `idle_minutes`:
/// no running turn, no queued input, and no activity since the cutoff.
/// (`sessions.id` / `conversation_inputs.conversation_id` are UUID blobs;
/// identity tables store hyphenated text, hence the hex comparison.)
/// Returns how many fell asleep.
pub async fn sleep_idle_sessions(
    pool: &SqlitePool,
    idle_minutes: i64,
) -> Result<u64, CollaborationError> {
    if idle_minutes <= 0 {
        return Ok(0);
    }
    let cutoff = stamp(Utc::now() - Duration::minutes(idle_minutes));
    let result = sqlx::query(
        r#"UPDATE collaboration_thread_members
           SET asleep_since = ?
           WHERE asleep_since IS NULL
             AND COALESCE(last_active_at, joined_at) < ?
             AND NOT EXISTS (
               SELECT 1 FROM sessions s
               WHERE lower(hex(s.id)) = replace(collaboration_thread_members.conversation_id, '-', '')
                 AND s.active_turn_id IS NOT NULL)
             AND NOT EXISTS (
               SELECT 1 FROM conversation_inputs i
               WHERE lower(hex(i.conversation_id))
                       = replace(collaboration_thread_members.conversation_id, '-', '')
                 AND i.status IN ('queued', 'claimed'))"#,
    )
    .bind(now_stamp())
    .bind(cutoff)
    .execute(pool)
    .await
    .map_err(db)?;
    Ok(result.rows_affected())
}

/// Background sweeper, once a minute: puts idle sessions to sleep
/// ([`sleep_idle_sessions`]) and retries deferred deliveries
/// ([`redeliver_deferred`]).
pub fn spawn_idle_session_sweeper(pool: SqlitePool, delivery: DeliveryContext) {
    tokio::spawn(async move {
        loop {
            let minutes = idle_sleep_minutes();
            if let Err(error) = sleep_idle_sessions(&pool, minutes).await {
                tracing::warn!(%error, "idle member session sweep failed");
            }
            if let Err(error) = redeliver_deferred(&pool, &delivery).await {
                tracing::warn!(%error, "deferred delivery sweep failed");
            }
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        }
    });
}

/// Ledger key of the turn that produced `message_id`: the sender's active
/// turn when an agent posted mid-turn, otherwise the message itself.
async fn wake_turn_key(
    pool: &SqlitePool,
    message_id: &str,
    envelope: &Value,
) -> Result<String, CollaborationError> {
    let sender = envelope
        .get("attributedTo")
        .and_then(Value::as_str)
        .and_then(|uri| uri.rsplit('/').next())
        .and_then(|raw| Uuid::parse_str(raw).ok());
    if let Some(sender) = sender {
        let turn: Option<Option<Uuid>> =
            sqlx::query_scalar("SELECT active_turn_id FROM sessions WHERE id = ?")
                .bind(sender)
                .fetch_optional(pool)
                .await
                .map_err(db)?;
        if let Some(Some(turn)) = turn {
            return Ok(format!("turn:{turn}"));
        }
    }
    Ok(format!("message:{message_id}"))
}

/// Receipt state shown for a delivery held over the per-turn wake cap.
pub const WAKE_LIMIT_REACHED: &str = "limit_reached";

async fn hold_over_wake_cap(
    pool: &SqlitePool,
    message_id: &str,
    conversation_id: Uuid,
    turn_key: &str,
) -> Result<(), CollaborationError> {
    sqlx::query(
        r#"UPDATE collaboration_space_deliveries
           SET wake_deferred_turn_key = ?, wake_deferred_at = COALESCE(wake_deferred_at, ?)
           WHERE space_message_id = ? AND conversation_id = ?"#,
    )
    .bind(turn_key)
    .bind(now_stamp())
    .bind(message_id)
    .bind(conversation_id.to_string())
    .execute(pool)
    .await
    .map_err(db)?;
    Ok(())
}

/// Whether the turn behind a wake ledger key is still running. `message:`
/// keys have no turn: they count as ended, so the next sweep releases them.
async fn wake_turn_in_flight(
    pool: &SqlitePool,
    turn_key: &str,
) -> Result<bool, CollaborationError> {
    let Some(turn) = turn_key
        .strip_prefix("turn:")
        .and_then(|raw| Uuid::parse_str(raw).ok())
    else {
        return Ok(false);
    };
    let running: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM sessions WHERE active_turn_id = ? LIMIT 1")
            .bind(turn)
            .fetch_optional(pool)
            .await
            .map_err(db)?;
    Ok(running.is_some())
}

/// Reserve a wake of sleeping `conversation_id` for `turn_key`. `false` when
/// the turn already used its cap (nothing recorded). Idempotent per pair.
async fn reserve_wake(
    pool: &SqlitePool,
    turn_key: &str,
    conversation_id: Uuid,
    message_id: &str,
    cap: i64,
) -> Result<bool, CollaborationError> {
    let mut tx = pool.begin().await.map_err(db)?;
    let already: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM collaboration_wake_ledger WHERE turn_key = ? AND conversation_id = ?",
    )
    .bind(turn_key)
    .bind(conversation_id.to_string())
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?;
    if already.is_some() {
        return Ok(true);
    }
    let used: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM collaboration_wake_ledger WHERE turn_key = ?")
            .bind(turn_key)
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
    if used >= cap {
        return Ok(false);
    }
    sqlx::query(
        r#"INSERT INTO collaboration_wake_ledger
           (turn_key, conversation_id, space_message_id, created_at) VALUES (?, ?, ?, ?)"#,
    )
    .bind(turn_key)
    .bind(conversation_id.to_string())
    .bind(message_id)
    .bind(now_stamp())
    .execute(&mut *tx)
    .await
    .map_err(db)?;
    tx.commit().await.map_err(db)?;
    Ok(true)
}

/// Structured agent-to-agent handoff envelope.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HandoffEnvelope {
    /// What the initiator already finished.
    pub done: String,
    /// Inputs, constraints and acceptance criteria the receiver must honour.
    pub inputs_constraints: String,
    /// The concrete ask.
    pub ask: String,
}

#[derive(Debug, Clone)]
pub struct Handoff {
    pub caller_id: Uuid,
    pub space_id: String,
    /// Receiver nickname in the space.
    pub to: String,
    pub envelope: HandoffEnvelope,
    pub operation_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HandoffResult {
    pub handoff_id: String,
    /// `accepted`, `rejected` (limit) or `failed` (delivery error).
    pub status: String,
    pub depth: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Message the initiator posted back into the thread on failure.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report_message_id: Option<String>,
}

/// Longest handoff chain A -> B -> C ... (the first handoff has depth 1).
pub const DEFAULT_HANDOFF_MAX_DEPTH: i64 = 3;
/// Accepted handoffs one conversation may start within one turn.
pub const DEFAULT_HANDOFF_MAX_PER_TURN: i64 = 2;

pub fn handoff_max_depth() -> i64 {
    env_i64("VIBEX_HANDOFF_MAX_DEPTH", DEFAULT_HANDOFF_MAX_DEPTH).max(1)
}

pub fn handoff_max_per_turn() -> i64 {
    env_i64("VIBEX_HANDOFF_MAX_PER_TURN", DEFAULT_HANDOFF_MAX_PER_TURN).max(1)
}

fn render_handoff(envelope: &HandoffEnvelope, depth: i64, handoff_id: &str) -> String {
    format!(
        "<handoff id=\"{handoff_id}\" depth=\"{depth}\">\n<done>\n{}\n</done>\n<inputs_constraints>\n{}\n</inputs_constraints>\n<ask>\n{}\n</ask>\n</handoff>",
        envelope.done.trim(),
        envelope.inputs_constraints.trim(),
        envelope.ask.trim()
    )
}

#[derive(Debug, FromRow)]
struct HandoffRow {
    id: String,
    status: String,
    depth: i64,
    message_id: Option<String>,
    reason: Option<String>,
    report_message_id: Option<String>,
    envelope_json: String,
    to_nickname: String,
    space_id: String,
    from_conversation_id: String,
}

impl HandoffRow {
    fn result(&self) -> HandoffResult {
        HandoffResult {
            handoff_id: self.id.clone(),
            status: self.status.clone(),
            depth: self.depth,
            message_id: self.message_id.clone(),
            reason: self.reason.clone(),
            report_message_id: self.report_message_id.clone(),
        }
    }
}

/// Hand work to another member of the thread with a structured envelope.
///
/// Limits: the chain depth (an accepted handoff received by the caller's
/// seat in this thread is the parent) and the number of accepted handoffs the
/// caller starts in its current turn. Over-limit attempts are recorded as
/// `rejected` and returned as `limit_exceeded`. If delivery fails, the
/// attempt is recorded as `failed` and the initiator posts a failure report
/// back into the originating thread (to the user).
pub async fn handoff_with(
    pool: &SqlitePool,
    input: Handoff,
    turn_delivery: &DeliveryContext,
) -> Result<HandoffResult, CollaborationError> {
    let handoff_id = input.operation_id.to_string();
    if let Some(existing) = load_handoff(pool, &handoff_id).await? {
        let same = existing.space_id == input.space_id
            && existing.to_nickname == input.to.trim().trim_start_matches('@')
            && existing.from_conversation_id == input.caller_id.to_string()
            && serde_json::from_str::<HandoffEnvelope>(&existing.envelope_json).ok()
                == Some(input.envelope.clone());
        if !same {
            return Err(operation_conflict());
        }
        return Ok(existing.result());
    }
    if input.envelope.ask.trim().is_empty() {
        return Err(CollaborationError::new(
            "conversation_control_failed",
            "handoff ask must not be empty",
        ));
    }
    let to = input.to.trim().trim_start_matches('@').trim().to_string();
    let caller = caller_seat(pool, &input.space_id, input.caller_id).await?;
    let seat = seat_conversation(&caller).unwrap_or(input.caller_id);
    let members = list_space_members(pool, &input.space_id, MessageAudience::Agent).await?;
    let target = members
        .iter()
        .find(|member| member.nickname == to)
        .ok_or_else(|| CollaborationError::new("not_found", "nickname was not found"))?;
    let target_conversation = seat_conversation(target);
    if target_conversation == Some(seat) {
        return Err(CollaborationError::new(
            "conversation_control_failed",
            "cannot hand off to yourself",
        ));
    }
    let parent = sqlx::query_as::<_, (String, i64)>(
        r#"SELECT id, depth FROM collaboration_handoffs
           WHERE space_id = ? AND to_conversation_id = ? AND status = 'accepted'
           ORDER BY created_at DESC, rowid DESC LIMIT 1"#,
    )
    .bind(&input.space_id)
    .bind(seat.to_string())
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    let depth = parent.as_ref().map_or(1, |(_, depth)| depth + 1);
    let turn: Option<Option<Uuid>> =
        sqlx::query_scalar("SELECT active_turn_id FROM sessions WHERE id = ?")
            .bind(input.caller_id)
            .fetch_optional(pool)
            .await
            .map_err(db)?;
    let turn_key = match turn.flatten() {
        Some(turn) => format!("turn:{turn}"),
        None => format!("operation:{handoff_id}"),
    };
    let used: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM collaboration_handoffs
           WHERE turn_key = ? AND from_conversation_id = ? AND status = 'accepted'"#,
    )
    .bind(&turn_key)
    .bind(input.caller_id.to_string())
    .fetch_one(pool)
    .await
    .map_err(db)?;
    let rejection = if depth > handoff_max_depth() {
        Some(format!(
            "handoff depth {depth} exceeds the limit of {}",
            handoff_max_depth()
        ))
    } else if used >= handoff_max_per_turn() {
        Some(format!(
            "this turn already started {used} handoffs (limit {})",
            handoff_max_per_turn()
        ))
    } else {
        None
    };
    let envelope_json = serde_json::to_string(&input.envelope).unwrap_or_default();
    let status = if rejection.is_some() {
        "rejected"
    } else {
        "accepted"
    };
    sqlx::query(
        r#"INSERT INTO collaboration_handoffs
           (id, space_id, from_conversation_id, to_nickname, to_conversation_id,
            parent_handoff_id, depth, turn_key, envelope_json, status, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
    )
    .bind(&handoff_id)
    .bind(&input.space_id)
    .bind(input.caller_id.to_string())
    .bind(&to)
    .bind(target_conversation.map(|id| id.to_string()))
    .bind(parent.as_ref().map(|(id, _)| id.clone()))
    .bind(depth)
    .bind(&turn_key)
    .bind(&envelope_json)
    .bind(status)
    .bind(rejection.as_deref())
    .bind(now_stamp())
    .execute(pool)
    .await
    .map_err(db)?;
    if let Some(reason) = rejection {
        return Err(CollaborationError::new("limit_exceeded", reason));
    }
    let content = format!(
        "@{to} {}",
        render_handoff(&input.envelope, depth, &handoff_id)
    );
    let posted = post_to_space_with(
        pool,
        PostToSpace {
            caller_id: Some(input.caller_id),
            space_id: input.space_id.clone(),
            content,
            summary: Some(format!("handoff → {to}: {}", input.envelope.ask.trim())),
            to: vec![to.clone()],
            in_reply_to: None,
            operation_id: input.operation_id,
        },
        turn_delivery,
    )
    .await;
    let failure = match &posted {
        Err(error) => Some(format!("{}: {}", error.code, error.message)),
        Ok(result) => result
            .receipts
            .iter()
            .find(|receipt| Some(receipt.conversation_id) == target_conversation)
            .and_then(|receipt| receipt.error_code.clone())
            .filter(|code| code != "wake_limit_exceeded")
            .map(|code| format!("delivery failed: {code}")),
    };
    let message_id = posted.as_ref().ok().map(|result| result.message_id.clone());
    if let Some(reason) = failure {
        let report_id = Uuid::new_v5(
            &Uuid::NAMESPACE_OID,
            format!("handoff-report:{handoff_id}").as_bytes(),
        );
        let report = post_to_space_with(
            pool,
            PostToSpace {
                caller_id: Some(input.caller_id),
                space_id: input.space_id.clone(),
                content: format!(
                    "@User 交接给 {to} 失败（{reason}）。待办：{}",
                    input.envelope.ask.trim()
                ),
                summary: Some(format!("handoff to {to} failed")),
                to: vec!["User".to_string()],
                in_reply_to: message_id.clone(),
                operation_id: report_id,
            },
            turn_delivery,
        )
        .await
        .ok()
        .map(|result| result.message_id);
        sqlx::query(
            r#"UPDATE collaboration_handoffs
               SET status = 'failed', reason = ?, message_id = ?, report_message_id = ?
               WHERE id = ?"#,
        )
        .bind(&reason)
        .bind(&message_id)
        .bind(&report)
        .bind(&handoff_id)
        .execute(pool)
        .await
        .map_err(db)?;
    } else {
        sqlx::query("UPDATE collaboration_handoffs SET message_id = ? WHERE id = ?")
            .bind(&message_id)
            .bind(&handoff_id)
            .execute(pool)
            .await
            .map_err(db)?;
    }
    Ok(load_handoff(pool, &handoff_id)
        .await?
        .map(|row| row.result())
        .unwrap_or(HandoffResult {
            handoff_id,
            status: "failed".to_string(),
            depth,
            message_id,
            reason: None,
            report_message_id: None,
        }))
}

pub async fn handoff(
    pool: &SqlitePool,
    input: Handoff,
) -> Result<HandoffResult, CollaborationError> {
    handoff_with(pool, input, &DeliveryContext::default()).await
}

async fn load_handoff(
    pool: &SqlitePool,
    id: &str,
) -> Result<Option<HandoffRow>, CollaborationError> {
    sqlx::query_as::<_, HandoffRow>(
        r#"SELECT id, status, depth, message_id, reason, report_message_id, envelope_json,
                  to_nickname, space_id, from_conversation_id
           FROM collaboration_handoffs WHERE id = ?"#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(db)
}

/// How several sessions of one member share a repository checkout.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemberWriteAccess {
    /// Default: every extra session gets its own worktree workspace.
    WriteIsolated,
    /// Sessions share the checkout and take turns (one writer at a time).
    WriteSerialized,
}

impl MemberWriteAccess {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::WriteIsolated => "write_isolated",
            Self::WriteSerialized => "write_serialized",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "write_isolated" | "isolated" => Some(Self::WriteIsolated),
            "write_serialized" | "serialized" => Some(Self::WriteSerialized),
            _ => None,
        }
    }
}

pub async fn set_member_write_access(
    pool: &SqlitePool,
    member_id: &str,
    access: MemberWriteAccess,
) -> Result<(), CollaborationError> {
    let updated = sqlx::query("UPDATE collaboration_members SET write_access = ? WHERE id = ?")
        .bind(access.as_str())
        .bind(member_id)
        .execute(pool)
        .await
        .map_err(db)?;
    if updated.rows_affected() == 0 {
        return Err(CollaborationError::new("not_found", "member was not found"));
    }
    Ok(())
}

/// Repo write plan of one member session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MemberWritePlan {
    pub member_id: String,
    pub access: MemberWriteAccess,
    /// Workspace (repo set) the session belongs to.
    pub workspace_id: Uuid,
    /// Other live sessions of the same member in that workspace.
    pub siblings: Vec<Uuid>,
    /// The member's earliest session in the workspace keeps the native
    /// checkout; every other one is isolated under WriteIsolated.
    pub primary: bool,
    /// Worktree workspace already provisioned for this session, if any.
    pub isolated_workspace_id: Option<Uuid>,
}

impl MemberWritePlan {
    /// True when this session must get its own worktree before writing.
    pub fn needs_isolated_workspace(&self) -> bool {
        self.access == MemberWriteAccess::WriteIsolated
            && !self.primary
            && self.isolated_workspace_id.is_none()
    }
}

/// Creates the worktree workspace for a WriteIsolated member session.
/// `Ok(None)` means isolation is not applicable (e.g. no repositories).
#[async_trait::async_trait]
pub trait IsolatedWorkspaceProvisioner: Send + Sync {
    async fn provision(
        &self,
        plan: &MemberWritePlan,
        conversation_id: Uuid,
        isolated_workspace_id: Uuid,
    ) -> Result<Option<(Uuid, Value)>, String>;
}

/// Deterministic id of a member session's worktree workspace.
pub fn member_worktree_workspace_id(conversation_id: Uuid) -> Uuid {
    Uuid::new_v5(
        &Uuid::NAMESPACE_OID,
        format!("vibex-member-worktree:{conversation_id}").as_bytes(),
    )
}

/// Workspace a turn of `conversation_id` must *execute* in. Non-primary
/// member sessions under WriteIsolated get (and keep) their own worktree;
/// everything else runs in `session_workspace_id`. The session row keeps its
/// own workspace, which collaboration checks continue to use.
pub async fn execution_workspace_id(
    pool: &SqlitePool,
    conversation_id: Uuid,
    session_workspace_id: Uuid,
    provisioner: &dyn IsolatedWorkspaceProvisioner,
) -> Result<Uuid, CollaborationError> {
    let Some(plan) = plan_member_write(pool, conversation_id).await? else {
        return Ok(session_workspace_id);
    };
    if plan.access != MemberWriteAccess::WriteIsolated || plan.primary {
        return Ok(session_workspace_id);
    }
    if let Some(existing) = plan.isolated_workspace_id {
        return Ok(existing);
    }
    let isolated = member_worktree_workspace_id(conversation_id);
    match provisioner
        .provision(&plan, conversation_id, isolated)
        .await
        .map_err(|error| CollaborationError::new("workspace_isolation_failed", error))?
    {
        Some((workspace_id, evidence)) => {
            record_member_session_workspace(pool, &plan, conversation_id, workspace_id, &evidence)
                .await?;
            Ok(workspace_id)
        }
        None => Ok(session_workspace_id),
    }
}

/// Plan for `conversation_id`, or `None` when it is not a member session.
pub async fn plan_member_write(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Option<MemberWritePlan>, CollaborationError> {
    let Some(binding) = seat_binding(pool, conversation_id).await? else {
        return Ok(None);
    };
    let Some(session) = load_session(pool, conversation_id).await? else {
        return Ok(None);
    };
    let access: String =
        sqlx::query_scalar("SELECT write_access FROM collaboration_members WHERE id = ?")
            .bind(&binding.member_id)
            .fetch_one(pool)
            .await
            .map_err(db)?;
    let access = MemberWriteAccess::parse(&access).unwrap_or(MemberWriteAccess::WriteIsolated);
    let mut same_workspace = Vec::new();
    for row in identity::member_bindings(pool, &binding.member_id)
        .await
        .map_err(db)?
    {
        let Ok(id) = Uuid::parse_str(&row.conversation_id) else {
            continue;
        };
        let Some(head) = load_session(pool, id).await? else {
            continue;
        };
        if head.workspace_id == session.workspace_id
            && head.deleted_at.is_none()
            && head.status != "archived"
        {
            same_workspace.push(id);
        }
    }
    // member_bindings is ordered by joined_at: the first one is primary.
    let primary = same_workspace.first() == Some(&conversation_id);
    let siblings = same_workspace
        .into_iter()
        .filter(|id| *id != conversation_id)
        .collect();
    let isolated_workspace_id: Option<String> = sqlx::query_scalar(
        "SELECT isolated_workspace_id FROM member_session_workspaces WHERE conversation_id = ?",
    )
    .bind(conversation_id.to_string())
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    Ok(Some(MemberWritePlan {
        member_id: binding.member_id,
        access,
        workspace_id: session.workspace_id,
        siblings,
        primary,
        isolated_workspace_id: isolated_workspace_id.and_then(|raw| Uuid::parse_str(&raw).ok()),
    }))
}

/// Record the worktree workspace provisioned for a WriteIsolated session.
pub async fn record_member_session_workspace(
    pool: &SqlitePool,
    plan: &MemberWritePlan,
    conversation_id: Uuid,
    isolated_workspace_id: Uuid,
    evidence: &Value,
) -> Result<(), CollaborationError> {
    sqlx::query(
        r#"INSERT INTO member_session_workspaces
           (conversation_id, member_id, parent_workspace_id, isolated_workspace_id,
            evidence_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(conversation_id) DO NOTHING"#,
    )
    .bind(conversation_id.to_string())
    .bind(&plan.member_id)
    .bind(plan.workspace_id.to_string())
    .bind(isolated_workspace_id.to_string())
    .bind(evidence.to_string())
    .bind(now_stamp())
    .execute(pool)
    .await
    .map_err(db)?;
    Ok(())
}

/// Whether a session is doing (or about to do) work: running turn or
/// queued/claimed input.
async fn session_busy(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<bool, CollaborationError> {
    let busy: i64 = sqlx::query_scalar(
        r#"SELECT
             EXISTS (SELECT 1 FROM sessions WHERE id = ? AND active_turn_id IS NOT NULL)
           OR EXISTS (SELECT 1 FROM conversation_inputs
                      WHERE conversation_id = ? AND status IN ('queued', 'claimed'))"#,
    )
    .bind(conversation_id)
    .bind(conversation_id)
    .fetch_one(pool)
    .await
    .map_err(db)?;
    Ok(busy != 0)
}

/// WriteSerialized gate: take the member's write lease for the workspace.
/// A lease whose holder is no longer busy is stale and is taken over.
/// Always `true` for sessions that need no serialization.
pub async fn try_acquire_member_write(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<bool, CollaborationError> {
    let Some(plan) = plan_member_write(pool, conversation_id).await? else {
        return Ok(true);
    };
    if plan.access != MemberWriteAccess::WriteSerialized || plan.siblings.is_empty() {
        return Ok(true);
    }
    let holder: Option<String> = sqlx::query_scalar(
        "SELECT conversation_id FROM member_write_leases WHERE member_id = ? AND workspace_id = ?",
    )
    .bind(&plan.member_id)
    .bind(plan.workspace_id.to_string())
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    if let Some(holder) = holder.and_then(|raw| Uuid::parse_str(&raw).ok())
        && holder != conversation_id
        && session_busy(pool, holder).await?
    {
        return Ok(false);
    }
    sqlx::query(
        r#"INSERT INTO member_write_leases (member_id, workspace_id, conversation_id, acquired_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(member_id, workspace_id) DO UPDATE
             SET conversation_id = excluded.conversation_id, acquired_at = excluded.acquired_at"#,
    )
    .bind(&plan.member_id)
    .bind(plan.workspace_id.to_string())
    .bind(conversation_id.to_string())
    .bind(now_stamp())
    .execute(pool)
    .await
    .map_err(db)?;
    Ok(true)
}

/// Retry deliveries that were deferred (wake cap or write serialization):
/// queued rows with no input yet. Returns how many messages were retried.
pub async fn redeliver_deferred(
    pool: &SqlitePool,
    delivery: &DeliveryContext,
) -> Result<usize, CollaborationError> {
    let pending = sqlx::query_as::<_, (String, String)>(
        r#"SELECT DISTINCT m.space_id, d.space_message_id
           FROM collaboration_space_deliveries d
           JOIN collaboration_space_messages m ON m.id = d.space_message_id
           WHERE d.status = 'queued' AND d.input_id IS NULL
           LIMIT 100"#,
    )
    .fetch_all(pool)
    .await
    .map_err(db)?;
    for (space_id, message_id) in &pending {
        if let Err(error) = deliver_pending(pool, space_id, message_id, delivery).await {
            tracing::warn!(%error, %message_id, "deferred space delivery retry failed");
        }
    }
    Ok(pending.len())
}

/// How an agent seat obtains its conversation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SeatMode {
    /// Default. The seat uses the member's own conversation for this thread,
    /// creating one when the conversation is already bound to another live
    /// thread. A binding whose seat was removed is transferred instead.
    PerThread,
    /// The conversation moves into this thread (move / undecided fallback).
    Transfer,
}

fn identity_error(error: IdentityError) -> CollaborationError {
    match error {
        IdentityError::Database(error) => db(error),
        IdentityError::NotFound(what) => {
            CollaborationError::new("not_found", format!("{what} was not found"))
        }
    }
}

/// Map `(member, thread)` to its conversation, creating it when missing.
/// A newly created conversation gets the member's persona notice and the
/// role's mode/config, like a freshly created space member.
pub async fn resolve_session(
    pool: &SqlitePool,
    member_id: &str,
    thread_id: &str,
) -> Result<Uuid, CollaborationError> {
    let resolved = identity::resolve_session(pool, member_id, thread_id)
        .await
        .map_err(identity_error)?;
    if resolved.created {
        prepare_member_conversation(pool, member_id, resolved.conversation_id).await?;
    }
    Ok(resolved.conversation_id)
}

async fn prepare_member_conversation(
    pool: &SqlitePool,
    member_id: &str,
    conversation_id: Uuid,
) -> Result<(), CollaborationError> {
    let persona_prompt: Option<String> = sqlx::query_scalar(
        "SELECT persona_prompt FROM conversation_personas WHERE conversation_id = ?",
    )
    .bind(conversation_id.to_string())
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    if let Some(prompt) = persona_prompt.filter(|prompt| !prompt.trim().is_empty()) {
        append_persona_notice(pool, conversation_id, &prompt).await?;
    }
    let role_id = identity::load_member(pool, member_id)
        .await
        .map_err(db)?
        .and_then(|member| member.role_id);
    if let Some(role_id) = role_id
        && let Ok(role) = load_role(pool, &role_id).await
    {
        remember_creation_session_controls(
            pool,
            conversation_id,
            role.mode_id.as_deref(),
            config_overrides(&role.config_values),
        )
        .await;
    }
    Ok(())
}

/// Resolve a target for a caller conversation: `member_id` plus `thread_id`
/// (a space id, a `direct:` thread id, or the undecided space id). The thread
/// must live in the caller's workspace, and nothing is created otherwise.
pub async fn resolve_member_target(
    pool: &SqlitePool,
    caller_id: Uuid,
    member_id: &str,
    thread_id: &str,
) -> Result<Uuid, CollaborationError> {
    let caller = live_session(load_session(pool, caller_id).await?)?;
    let member_id = member_id.trim();
    let mut thread_id = thread_id.trim().to_string();
    if parse_unassigned_space_id(&thread_id).is_some() {
        thread_id = identity::direct_thread_id(member_id);
    }
    if identity::load_member(pool, member_id)
        .await
        .map_err(db)?
        .is_none()
    {
        return Err(CollaborationError::new("not_found", "member was not found"));
    }
    let thread_workspace = match identity::load_thread(pool, &thread_id).await.map_err(db)? {
        Some(thread) => thread.workspace_id,
        None if !thread_id.starts_with(identity::DIRECT_PREFIX) => {
            let space = load_space(pool, &thread_id).await?;
            identity::ensure_thread_for_seat(pool, &thread_id, member_id)
                .await
                .map_err(identity_error)?;
            Some(space.workspace_id)
        }
        None => None,
    };
    if thread_workspace.as_deref() != Some(caller.workspace_id.to_string().as_str()) {
        return Err(CollaborationError::new("not_found", "thread was not found"));
    }
    resolve_session(pool, member_id, &thread_id).await
}

/// Bind an agent seat's conversation to its `(member, thread)` and return the
/// conversation that seat must use. Keeps legacy seats working: a seat whose
/// conversation is bound to another live thread is left as is.
async fn attach_seat(
    pool: &SqlitePool,
    space_id: &str,
    conversation_id: Uuid,
    nickname: &str,
    mode: SeatMode,
) -> Result<Uuid, CollaborationError> {
    let binding = identity::binding_of_conversation(pool, conversation_id)
        .await
        .map_err(db)?;
    if let Some(binding) = binding.as_ref() {
        let thread_id = identity::thread_for_seat(space_id, &binding.member_id);
        if binding.thread_id == thread_id {
            return resolve_session(pool, &binding.member_id, &thread_id).await;
        }
        let other_seat: Option<i64> = sqlx::query_scalar(
            r#"SELECT 1 FROM collaboration_space_members
               WHERE conversation_id = ? AND space_id != ? AND kind = 'agent' LIMIT 1"#,
        )
        .bind(conversation_id.to_string())
        .bind(space_id)
        .fetch_optional(pool)
        .await
        .map_err(db)?;
        let orphaned = other_seat.is_none();
        match mode {
            SeatMode::Transfer => {
                identity::transfer_conversation(pool, conversation_id, space_id, Some(nickname))
                    .await
                    .map_err(identity_error)?;
            }
            SeatMode::PerThread if orphaned => {
                identity::transfer_conversation(pool, conversation_id, space_id, Some(nickname))
                    .await
                    .map_err(identity_error)?;
            }
            SeatMode::PerThread => {}
        }
    }
    let (member_id, _, resolved) =
        identity::bind_seat(pool, space_id, conversation_id, Some(nickname))
            .await
            .map_err(identity_error)?;
    if resolved.created {
        prepare_member_conversation(pool, &member_id, resolved.conversation_id).await?;
    }
    Ok(resolved.conversation_id)
}

/// Conversation that a delivery to this seat goes to. Resolves the seat's
/// identity first; a seat still pointing at a stale conversation is repointed.
async fn resolve_seat_target(
    pool: &SqlitePool,
    space_id: &str,
    conversation_id: Uuid,
    nickname: &str,
) -> Result<Uuid, CollaborationError> {
    let resolved = attach_seat(
        pool,
        space_id,
        conversation_id,
        nickname,
        SeatMode::PerThread,
    )
    .await?;
    if resolved != conversation_id {
        sqlx::query(
            "UPDATE collaboration_space_members SET conversation_id = ? WHERE space_id = ? AND conversation_id = ?",
        )
        .bind(resolved.to_string())
        .bind(space_id)
        .bind(conversation_id.to_string())
        .execute(pool)
        .await
        .map_err(db)?;
    }
    Ok(resolved)
}

/// Seat the member owning `conversation_id` already has in `space_id`
/// through another conversation, if any.
async fn existing_member_seat(
    pool: &SqlitePool,
    space_id: &str,
    conversation_id: Uuid,
) -> Result<Option<MemberRecord>, CollaborationError> {
    let Some(binding) = identity::binding_of_conversation(pool, conversation_id)
        .await
        .map_err(db)?
    else {
        return Ok(None);
    };
    let thread_id = identity::thread_for_seat(space_id, &binding.member_id);
    let bound: Option<String> = sqlx::query_scalar(
        "SELECT conversation_id FROM collaboration_thread_members WHERE thread_id = ? AND member_id = ?",
    )
    .bind(&thread_id)
    .bind(&binding.member_id)
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    let Some(bound) = bound.and_then(|raw| Uuid::parse_str(&raw).ok()) else {
        return Ok(None);
    };
    if bound == conversation_id {
        return Ok(None);
    }
    ensure_agent_member(pool, space_id, bound)
        .await
        .map(Some)
        .or(Ok(None))
}

async fn insert_member(
    pool: &SqlitePool,
    space_id: &str,
    conversation_id: Option<Uuid>,
    nickname: &str,
    kind: &str,
    visible: bool,
) -> Result<MemberRecord, CollaborationError> {
    insert_member_with(
        pool,
        space_id,
        conversation_id,
        nickname,
        kind,
        visible,
        SeatMode::PerThread,
    )
    .await
}

async fn insert_member_with(
    pool: &SqlitePool,
    space_id: &str,
    conversation_id: Option<Uuid>,
    nickname: &str,
    kind: &str,
    visible: bool,
    mode: SeatMode,
) -> Result<MemberRecord, CollaborationError> {
    if kind == "agent"
        && let Some(conversation_id) = conversation_id
        && let Some(existing) = existing_member_seat(pool, space_id, conversation_id).await?
    {
        return Ok(existing);
    }
    let nickname = unique_nickname(pool, space_id, nickname).await?;
    let member_id = Uuid::new_v4().to_string();
    sqlx::query(
        r#"INSERT INTO collaboration_space_members
           (space_id, member_id, conversation_id, nickname, kind, visible_to_agents)
           VALUES (?, ?, ?, ?, ?, ?)"#,
    )
    .bind(space_id)
    .bind(&member_id)
    .bind(conversation_id.map(|id| id.to_string()))
    .bind(&nickname)
    .bind(kind)
    .bind(if visible { 1 } else { 0 })
    .execute(pool)
    .await
    .map_err(db)?;
    let conversation_id = match (kind, conversation_id) {
        ("agent", Some(conversation_id)) => {
            let resolved = attach_seat(pool, space_id, conversation_id, &nickname, mode).await?;
            if resolved != conversation_id {
                sqlx::query(
                    "UPDATE collaboration_space_members SET conversation_id = ? WHERE space_id = ? AND member_id = ?",
                )
                .bind(resolved.to_string())
                .bind(space_id)
                .bind(&member_id)
                .execute(pool)
                .await
                .map_err(db)?;
            }
            Some(resolved)
        }
        (_, conversation_id) => conversation_id,
    };
    Ok(MemberRecord {
        member_id,
        conversation_id: conversation_id.map(|id| id.to_string()),
        nickname,
        kind: kind.to_string(),
        visible_to_agents: if visible { 1 } else { 0 },
    })
}

async fn unique_nickname(
    pool: &SqlitePool,
    space_id: &str,
    nickname: &str,
) -> Result<String, CollaborationError> {
    let base = nickname.trim();
    if nickname_owner(pool, space_id, base).await?.is_none() {
        return Ok(base.to_string());
    }
    for suffix in 2..100 {
        let candidate = format!("{base}-{suffix}");
        if nickname_owner(pool, space_id, &candidate).await?.is_none() {
            return Ok(candidate);
        }
    }
    Err(CollaborationError::new(
        "nickname_taken",
        "nickname is already used in this space",
    ))
}

async fn nickname_owner(
    pool: &SqlitePool,
    space_id: &str,
    nickname: &str,
) -> Result<Option<String>, CollaborationError> {
    sqlx::query_scalar(
        "SELECT member_id FROM collaboration_space_members WHERE space_id = ? AND nickname = ?",
    )
    .bind(space_id)
    .bind(nickname)
    .fetch_optional(pool)
    .await
    .map_err(db)
}

/// Seat a calling conversation acts through in `space_id`: its own seat, or
/// the seat its member identity holds there via a per-thread conversation
/// (for example the creator of a space, whose seat got its own session).
async fn caller_seat(
    pool: &SqlitePool,
    space_id: &str,
    caller_id: Uuid,
) -> Result<MemberRecord, CollaborationError> {
    match ensure_agent_member(pool, space_id, caller_id).await {
        Ok(member) => Ok(member),
        Err(error) => match existing_member_seat(pool, space_id, caller_id).await? {
            Some(member) => Ok(member),
            None => Err(error),
        },
    }
}

fn seat_conversation(member: &MemberRecord) -> Option<Uuid> {
    member
        .conversation_id
        .as_deref()
        .and_then(|raw| Uuid::parse_str(raw).ok())
}

async fn ensure_agent_member(
    pool: &SqlitePool,
    space_id: &str,
    conversation_id: Uuid,
) -> Result<MemberRecord, CollaborationError> {
    sqlx::query_as::<_, MemberRecord>(
        r#"SELECT member_id, conversation_id, nickname, kind, visible_to_agents
           FROM collaboration_space_members
           WHERE space_id = ? AND conversation_id = ? AND kind = 'agent'"#,
    )
    .bind(space_id)
    .bind(conversation_id.to_string())
    .fetch_optional(pool)
    .await
    .map_err(db)?
    .ok_or_else(|| CollaborationError::new("not_a_member", "caller is not a member of this space"))
}

async fn member_nickname(
    pool: &SqlitePool,
    space_id: &str,
    conversation_id: Uuid,
) -> Result<Option<String>, CollaborationError> {
    sqlx::query_scalar(
        "SELECT nickname FROM collaboration_space_members WHERE space_id = ? AND conversation_id = ?",
    )
    .bind(space_id)
    .bind(conversation_id.to_string())
    .fetch_optional(pool)
    .await
    .map_err(db)
}

#[derive(Debug, FromRow)]
struct SpaceRow {
    workspace_id: String,
}

async fn load_space(pool: &SqlitePool, space_id: &str) -> Result<SpaceRow, CollaborationError> {
    sqlx::query_as::<_, SpaceRow>("SELECT workspace_id FROM collaboration_spaces WHERE id = ?")
        .bind(space_id)
        .fetch_optional(pool)
        .await
        .map_err(db)?
        .ok_or_else(|| CollaborationError::new("not_found", "space was not found"))
}

async fn load_space_or_unassigned(
    pool: &SqlitePool,
    space_id: &str,
) -> Result<SpaceRow, CollaborationError> {
    if let Some(workspace_id) = parse_unassigned_space_id(space_id) {
        let owns: Option<i64> = sqlx::query_scalar("SELECT 1 FROM workspaces WHERE id = ? LIMIT 1")
            .bind(workspace_id)
            .fetch_optional(pool)
            .await
            .map_err(db)?;
        if owns.is_none() {
            return Err(CollaborationError::new(
                "not_found",
                "workspace was not found",
            ));
        }
        return Ok(SpaceRow {
            workspace_id: workspace_id.to_string(),
        });
    }
    load_space(pool, space_id).await
}

#[derive(Debug, FromRow)]
struct MessageHead {
    space_id: String,
    envelope_json: String,
}

async fn load_message_head(
    pool: &SqlitePool,
    message_id: &str,
) -> Result<Option<MessageHead>, CollaborationError> {
    sqlx::query_as::<_, MessageHead>(
        "SELECT space_id, envelope_json FROM collaboration_space_messages WHERE id = ?",
    )
    .bind(message_id)
    .fetch_optional(pool)
    .await
    .map_err(db)
}

fn post_fingerprint(input: &PostToSpace, content: &str, actor: &str) -> Value {
    let mut to: Vec<String> = input
        .to
        .iter()
        .map(|nickname| nickname.trim().to_string())
        .filter(|nickname| !nickname.is_empty())
        .collect();
    to.sort();
    json!({
        "actor": actor,
        "content": content,
        "in_reply_to": input.in_reply_to.as_deref().map(str::trim).filter(|value| !value.is_empty()),
        "space_id": input.space_id,
        "summary": input.summary.as_deref().map(str::trim).filter(|value| !value.is_empty()),
        "to": to,
    })
}

async fn same_post_request(
    pool: &SqlitePool,
    message_id: &str,
    space_id: &str,
    request: &Value,
    envelope_json: &str,
) -> Result<bool, CollaborationError> {
    if let Some(stored) = load_stored_operation(pool, message_id).await? {
        if stored
            .space_id
            .as_deref()
            .is_some_and(|stored_space| stored_space != space_id)
        {
            return Ok(false);
        }
        if !stored.request_json.is_empty() {
            return Ok(stored.request_json == request.to_string());
        }
    }
    Ok(envelope_matches(envelope_json, request))
}

fn envelope_matches(raw: &str, request: &Value) -> bool {
    let Ok(envelope) = serde_json::from_str::<Value>(raw) else {
        return false;
    };
    if envelope.get("content").and_then(Value::as_str)
        != request.get("content").and_then(Value::as_str)
    {
        return false;
    }
    if envelope.get("actor").and_then(Value::as_str) != request.get("actor").and_then(Value::as_str)
    {
        return false;
    }
    let stored_reply = envelope
        .get("inReplyTo")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let requested_reply = request
        .get("in_reply_to")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    if stored_reply != requested_reply {
        return false;
    }
    if let Some(summary) = request.get("summary").and_then(Value::as_str) {
        if envelope.get("summary").and_then(Value::as_str) != Some(summary) {
            return false;
        }
    }
    let Some(items) = request.get("to").and_then(Value::as_array) else {
        return true;
    };
    if items.is_empty() {
        return true;
    }
    let mut requested: Vec<&str> = items.iter().filter_map(Value::as_str).collect();
    let mut stored: Vec<&str> = envelope
        .get("to")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|item| item.as_str().and_then(|uri| uri.rsplit('/').next()))
                .collect()
        })
        .unwrap_or_default();
    requested.sort_unstable();
    stored.sort_unstable();
    requested == stored
}

async fn load_envelope(pool: &SqlitePool, message_id: &str) -> Result<Value, CollaborationError> {
    let raw: String =
        sqlx::query_scalar("SELECT envelope_json FROM collaboration_space_messages WHERE id = ?")
            .bind(message_id)
            .fetch_optional(pool)
            .await
            .map_err(db)?
            .ok_or_else(|| CollaborationError::new("not_found", "message was not found"))?;
    serde_json::from_str(&raw)
        .map_err(|error| CollaborationError::new("conversation_control_failed", error.to_string()))
}

#[derive(Debug, FromRow)]
struct PendingDelivery {
    conversation_id: String,
    operation_id: String,
    input_id: Option<String>,
    status: String,
    receipt_state: String,
    context_from_seq: Option<i64>,
    wake_deferred_turn_key: Option<String>,
}

async fn mark_delivery_failed(
    pool: &SqlitePool,
    message_id: &str,
    conversation_id: Uuid,
) -> Result<(), CollaborationError> {
    sqlx::query(
        r#"UPDATE collaboration_space_deliveries
           SET status = 'failed'
           WHERE space_message_id = ? AND conversation_id = ?"#,
    )
    .bind(message_id)
    .bind(conversation_id.to_string())
    .execute(pool)
    .await
    .map_err(db)?;
    Ok(())
}

struct StoredSpaceOperation {
    space_id: Option<String>,
    request_json: String,
    result: Value,
}

async fn load_stored_operation(
    pool: &SqlitePool,
    operation_id: &str,
) -> Result<Option<StoredSpaceOperation>, CollaborationError> {
    let row = sqlx::query_as::<_, (Option<String>, String, String)>(
        r#"SELECT space_id, request_json, result_json
           FROM collaboration_space_operations WHERE operation_id = ?"#,
    )
    .bind(operation_id)
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    let Some((space_id, request_json, result_json)) = row else {
        return Ok(None);
    };
    let result = serde_json::from_str(&result_json).map_err(|error| {
        CollaborationError::new("conversation_control_failed", error.to_string())
    })?;
    Ok(Some(StoredSpaceOperation {
        space_id,
        request_json,
        result,
    }))
}

fn accept_space_replay(
    stored: &StoredSpaceOperation,
    expected_space: Option<&str>,
    request: &Value,
) -> Result<Value, CollaborationError> {
    if let (Some(stored_space), Some(expected)) = (stored.space_id.as_deref(), expected_space) {
        if stored_space != expected {
            return Err(CollaborationError::new("not_found", "space was not found"));
        }
    }
    if !stored.request_json.is_empty() && stored.request_json != request.to_string() {
        return Err(operation_conflict());
    }
    Ok(stored.result.clone())
}

fn decode_replay<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, CollaborationError> {
    serde_json::from_value(value)
        .map_err(|error| CollaborationError::new("conversation_control_failed", error.to_string()))
}

async fn store_operation(
    pool: &SqlitePool,
    operation_id: &str,
    space_id: Option<&str>,
    request: &Value,
    result: &impl Serialize,
) -> Result<(), CollaborationError> {
    let request_json = request.to_string();
    let result_json = serde_json::to_string(result).unwrap_or_else(|_| "{}".to_string());
    sqlx::query(
        r#"INSERT INTO collaboration_space_operations
           (operation_id, space_id, request_json, result_json, created_at)
           VALUES (?, ?, ?, ?, ?)"#,
    )
    .bind(operation_id)
    .bind(space_id)
    .bind(request_json)
    .bind(result_json)
    .bind(now_stamp())
    .execute(pool)
    .await
    .map_err(db)?;
    Ok(())
}

fn member_actor(space_id: &str, nickname: &str) -> String {
    format!("vibex://space/{space_id}/member/{nickname}")
}

fn user_actor(space_id: &str) -> String {
    format!("vibex://space/{space_id}/user")
}

fn require_name(name: &str) -> Result<String, CollaborationError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CollaborationError::new("not_found", "name is required"));
    }
    Ok(name.to_string())
}

fn require_agent(agent_id: &str) -> Result<String, CollaborationError> {
    let agent_id = agent_id.trim();
    if agent_id.is_empty() || AgentId::parse(agent_id).is_err() {
        return Err(CollaborationError::new("not_found", "agent_id is required"));
    }
    Ok(agent_id.to_string())
}

fn config_object(value: &Value) -> Value {
    match value {
        Value::Object(_) => value.clone(),
        _ => json!({}),
    }
}

fn config_overrides(value: &Value) -> Vec<AgentSessionConfigOverride> {
    value
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(key, item)| {
            let text = item.as_str()?.trim();
            if key.trim().is_empty() || text.is_empty() {
                return None;
            }
            Some(AgentSessionConfigOverride {
                key: key.clone(),
                value: text.to_string(),
            })
        })
        .collect()
}

fn is_false(value: &bool) -> bool {
    !*value
}

async fn finish_tx<T>(
    conn: &mut sqlx::SqliteConnection,
    outcome: Result<T, CollaborationError>,
) -> Result<T, CollaborationError> {
    match outcome {
        Ok(value) => {
            sqlx::query("COMMIT")
                .execute(&mut *conn)
                .await
                .map_err(db)?;
            Ok(value)
        }
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            Err(error)
        }
    }
}

impl From<sqlx::Error> for CollaborationError {
    fn from(error: sqlx::Error) -> Self {
        db(error)
    }
}

pub const SPACE_COLLECTION_MAX_BYTES: u64 = 200 * 1024 * 1024;
const SPACE_COLLECTION_TEXT_PREVIEW_CAP: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, FromRow)]
pub struct SpaceCollectionReadRecord {
    pub reader_key: String,
    pub reader_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reader_conversation_id: Option<String>,
    pub reader_nickname: String,
    pub read_count: i64,
    pub first_read_at: String,
    pub last_read_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SpaceCollectionItemRecord {
    pub id: String,
    pub space_id: String,
    pub workspace_id: String,
    pub project_id: String,
    pub creator_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creator_conversation_id: Option<String>,
    pub creator_nickname: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creator_agent_id: Option<String>,
    pub item_kind: String,
    pub file_name: String,
    pub file_path: String,
    pub mime_type: String,
    pub byte_size: i64,
    pub note: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_content: Option<String>,
    pub read_receipts: Vec<SpaceCollectionReadRecord>,
}

#[derive(Debug, Clone)]
pub struct AddSpaceCollectionItem {
    pub caller_id: Option<Uuid>,
    pub space_id: String,
    pub content: Option<String>,
    pub source_path: Option<String>,
    pub base64_data: Option<String>,
    pub file_name: Option<String>,
    pub note: Option<String>,
    pub operation_id: Uuid,
}

fn vibex_team_spaces_root_dir() -> std::path::PathBuf {
    if let Ok(custom) = std::env::var("VIBEX_TEAM_SPACES_ROOT") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            return std::path::PathBuf::from(trimmed);
        }
    }
    utils::path::expand_tilde("~/.vibex")
}

fn sanitize_collection_segment(raw: &str, fallback: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.trim().chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
            out.push(ch);
        } else if !ch.is_control()
            && !matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    let cleaned = out.trim_matches(|c| c == '.' || c == ' ').to_string();
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned
    }
}

pub fn space_collection_dir(project_id: &str, space_id: &str) -> std::path::PathBuf {
    let safe_project = sanitize_collection_segment(project_id, "default-project");
    let safe_space = sanitize_collection_segment(space_id, "default-space");
    vibex_team_spaces_root_dir()
        .join(safe_project)
        .join("TeamSpaces")
        .join(safe_space)
        .join("Collection")
}

pub fn is_team_space_collection_file(path: &std::path::Path) -> bool {
    let root = vibex_team_spaces_root_dir();
    let canonical_root = std::fs::canonicalize(&root).unwrap_or(root);
    let canonical_path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let Ok(rel) = canonical_path.strip_prefix(&canonical_root) else {
        return false;
    };
    let components: Vec<String> = rel
        .components()
        .filter_map(|comp| match comp {
            std::path::Component::Normal(seg) => Some(seg.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    components.len() == 5 && components[1] == "TeamSpaces" && components[3] == "Collection"
}

async fn resolve_space_project_id(pool: &SqlitePool, workspace_id_str: &str) -> String {
    if let Ok(wid) = Uuid::parse_str(workspace_id_str) {
        let project_uuid: Option<Uuid> = sqlx::query_scalar(
            r#"SELECT COALESCE(
                 w.project_id,
                 (SELECT t.project_id FROM tasks t WHERE t.id = w.task_id LIMIT 1)
               )
               FROM workspaces w
               WHERE w.id = ?
               LIMIT 1"#,
        )
        .bind(wid)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();
        if let Some(pid) = project_uuid {
            return pid.to_string();
        }
    }
    workspace_id_str.to_string()
}

async fn resolve_collection_source_path(
    pool: &SqlitePool,
    workspace_id_str: &str,
    raw_path: &str,
) -> Result<std::path::PathBuf, CollaborationError> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err(CollaborationError::new(
            "invalid_argument",
            "source_path must not be empty",
        ));
    }
    let expanded = utils::path::expand_tilde(trimmed);
    if expanded.is_absolute() {
        return Ok(expanded);
    }
    if let Ok(wid) = Uuid::parse_str(workspace_id_str)
        && let Ok(Some(workspace)) = db::models::workspace::Workspace::find_by_id(pool, wid).await
    {
        let repos = db::models::workspace_repo::WorkspaceRepo::find_repos_for_workspace(pool, wid)
            .await
            .unwrap_or_default();
        let container_ref = workspace.container_ref.clone().unwrap_or_default();
        let base_dir = crate::host::resolve_absolute_workspace_agent_working_dir(
            &workspace,
            &container_ref,
            &repos,
        );
        if !base_dir.trim().is_empty() {
            return Ok(std::path::PathBuf::from(base_dir).join(expanded));
        }
    }
    Ok(expanded)
}

fn collection_mime_and_kind(
    path: &std::path::Path,
    explicit_text: bool,
) -> (&'static str, &'static str) {
    if explicit_text {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase);
        let mime = match ext.as_deref() {
            Some("txt") => "text/plain",
            Some("json") => "application/json",
            _ => "text/markdown",
        };
        return (mime, "text");
    }
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => ("image/png", "image"),
        Some("jpg") | Some("jpeg") => ("image/jpeg", "image"),
        Some("gif") => ("image/gif", "image"),
        Some("webp") => ("image/webp", "image"),
        Some("bmp") => ("image/bmp", "image"),
        Some("svg") => ("image/svg+xml", "image"),
        Some("avif") => ("image/avif", "image"),
        Some("heic") => ("image/heic", "image"),
        Some("heif") => ("image/heif", "image"),
        Some("pdf") => ("application/pdf", "file"),
        Some("txt") => ("text/plain", "file"),
        Some("md") | Some("markdown") => ("text/markdown", "file"),
        Some("json") => ("application/json", "file"),
        Some("csv") => ("text/csv", "file"),
        Some("html") | Some("htm") => ("text/html", "file"),
        Some("doc") => ("application/msword", "file"),
        Some("docx") => (
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "file",
        ),
        Some("xls") => ("application/vnd.ms-excel", "file"),
        Some("xlsx") => (
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "file",
        ),
        Some("ppt") => ("application/vnd.ms-powerpoint", "file"),
        Some("pptx") => (
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "file",
        ),
        Some("zip") => ("application/zip", "file"),
        Some("mp4") => ("video/mp4", "file"),
        Some("webm") => ("video/webm", "file"),
        Some("mov") => ("video/quicktime", "file"),
        _ => ("application/octet-stream", "file"),
    }
}

fn allocate_collection_file_path(
    dir: &std::path::Path,
    desired_name: &str,
    default_ext: Option<&str>,
) -> (String, std::path::PathBuf) {
    let mut safe_name = sanitize_collection_segment(desired_name, "item");
    if let Some(ext) = default_ext
        && std::path::Path::new(&safe_name).extension().is_none()
    {
        safe_name = format!("{safe_name}.{ext}");
    }
    let initial = dir.join(&safe_name);
    if !initial.exists() {
        return (safe_name, initial);
    }
    let path_obj = std::path::Path::new(&safe_name);
    let stem = path_obj
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("item");
    let ext = path_obj.extension().and_then(|e| e.to_str());
    for idx in 2..10_000 {
        let candidate_name = match ext {
            Some(e) if !e.is_empty() => format!("{stem}-{idx}.{e}"),
            _ => format!("{stem}-{idx}"),
        };
        let candidate_path = dir.join(&candidate_name);
        if !candidate_path.exists() {
            return (candidate_name, candidate_path);
        }
    }
    let fallback_name = match ext {
        Some(e) if !e.is_empty() => format!("{stem}-{}.{e}", &Uuid::new_v4().to_string()[..8]),
        _ => format!("{stem}-{}", &Uuid::new_v4().to_string()[..8]),
    };
    let fallback_path = dir.join(&fallback_name);
    (fallback_name, fallback_path)
}

#[derive(Debug, Clone, FromRow)]
struct SpaceCollectionItemRow {
    id: String,
    space_id: String,
    workspace_id: String,
    project_id: String,
    creator_kind: String,
    creator_conversation_id: Option<String>,
    creator_nickname: String,
    item_kind: String,
    file_name: String,
    file_path: String,
    mime_type: String,
    byte_size: i64,
    note: String,
    created_at: String,
}

async fn read_bounded_text_preview(path: &str, max_bytes: usize) -> Option<String> {
    use tokio::io::AsyncReadExt;
    let file = tokio::fs::File::open(path).await.ok()?;
    let mut buf = Vec::with_capacity(max_bytes.min(8192));
    file.take(max_bytes as u64)
        .read_to_end(&mut buf)
        .await
        .ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

async fn hydrate_collection_items(
    pool: &SqlitePool,
    rows: Vec<SpaceCollectionItemRow>,
    audience: MessageAudience,
) -> Result<Vec<SpaceCollectionItemRecord>, CollaborationError> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }

    let mut reads_by_item: std::collections::HashMap<String, Vec<SpaceCollectionReadRecord>> =
        std::collections::HashMap::new();
    {
        let mut builder = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
            r#"SELECT item_id, reader_key, reader_kind, reader_conversation_id, reader_nickname,
                      read_count, first_read_at, last_read_at
               FROM collaboration_space_collection_reads
               WHERE item_id IN ("#,
        );
        let mut separated = builder.separated(", ");
        for row in &rows {
            separated.push_bind(&row.id);
        }
        separated.push_unseparated(") ORDER BY last_read_at DESC, first_read_at DESC");
        let read_rows = builder
            .build_query_as::<(
                String,
                String,
                String,
                Option<String>,
                String,
                i64,
                String,
                String,
            )>()
            .fetch_all(pool)
            .await
            .map_err(db)?;
        for (
            item_id,
            reader_key,
            reader_kind,
            reader_conversation_id,
            reader_nickname,
            read_count,
            first_read_at,
            last_read_at,
        ) in read_rows
        {
            reads_by_item
                .entry(item_id)
                .or_default()
                .push(SpaceCollectionReadRecord {
                    reader_key,
                    reader_kind,
                    reader_conversation_id,
                    reader_nickname,
                    read_count,
                    first_read_at,
                    last_read_at,
                });
        }
    }

    let creator_cids: Vec<Uuid> = rows
        .iter()
        .filter_map(|row| row.creator_conversation_id.as_deref())
        .filter_map(|raw| Uuid::parse_str(raw.trim()).ok())
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();

    let mut agent_by_cid: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    if !creator_cids.is_empty() {
        let mut s_builder = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
            "SELECT id, agent_id FROM sessions WHERE id IN (",
        );
        let mut s_sep = s_builder.separated(", ");
        for cid in &creator_cids {
            s_sep.push_bind(*cid);
        }
        s_sep.push_unseparated(")");
        if let Ok(session_rows) = s_builder
            .build_query_as::<(Uuid, Option<String>)>()
            .fetch_all(pool)
            .await
        {
            for (cid, agent_id) in session_rows {
                if let Some(trimmed) = agent_id
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty())
                {
                    agent_by_cid.insert(cid.to_string(), trimmed);
                }
            }
        }

        let missing_cids: Vec<String> = creator_cids
            .iter()
            .map(ToString::to_string)
            .filter(|cid| !agent_by_cid.contains_key(cid))
            .collect();
        if !missing_cids.is_empty() {
            let mut p_builder = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
                "SELECT conversation_id, agent_id FROM conversation_personas WHERE conversation_id IN (",
            );
            let mut p_sep = p_builder.separated(", ");
            for cid in &missing_cids {
                p_sep.push_bind(cid);
            }
            p_sep.push_unseparated(")");
            if let Ok(persona_rows) = p_builder
                .build_query_as::<(String, Option<String>)>()
                .fetch_all(pool)
                .await
            {
                for (cid, agent_id) in persona_rows {
                    if let Some(trimmed) = agent_id
                        .map(|v| v.trim().to_string())
                        .filter(|v| !v.is_empty())
                    {
                        agent_by_cid.entry(cid).or_insert(trimmed);
                    }
                }
            }
        }
    }

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let read_receipts = reads_by_item.remove(&row.id).unwrap_or_default();
        let creator_agent_id = row
            .creator_conversation_id
            .as_deref()
            .and_then(|cid| agent_by_cid.get(cid.trim()).cloned());
        let text_content = if audience == MessageAudience::User && row.item_kind == "text" {
            read_bounded_text_preview(&row.file_path, SPACE_COLLECTION_TEXT_PREVIEW_CAP).await
        } else {
            None
        };
        out.push(SpaceCollectionItemRecord {
            id: row.id,
            space_id: row.space_id,
            workspace_id: row.workspace_id,
            project_id: row.project_id,
            creator_kind: row.creator_kind,
            creator_conversation_id: row.creator_conversation_id,
            creator_nickname: row.creator_nickname,
            creator_agent_id,
            item_kind: row.item_kind,
            file_name: row.file_name,
            file_path: row.file_path,
            mime_type: row.mime_type,
            byte_size: row.byte_size,
            note: row.note,
            created_at: row.created_at,
            text_content,
            read_receipts,
        });
    }
    Ok(out)
}

async fn hydrate_collection_item(
    pool: &SqlitePool,
    row: SpaceCollectionItemRow,
    audience: MessageAudience,
) -> Result<SpaceCollectionItemRecord, CollaborationError> {
    let mut items = hydrate_collection_items(pool, vec![row], audience).await?;
    items
        .pop()
        .ok_or_else(|| CollaborationError::new("not_found", "collection item was not found"))
}

async fn record_collection_item_read(
    pool: &SqlitePool,
    item_id: &str,
    reader_key: &str,
    reader_kind: &str,
    reader_conversation_id: Option<&str>,
    reader_nickname: &str,
) -> Result<(), CollaborationError> {
    let stamp = now_stamp();
    sqlx::query(
        r#"INSERT INTO collaboration_space_collection_reads
           (item_id, reader_key, reader_kind, reader_conversation_id, reader_nickname,
            read_count, first_read_at, last_read_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(item_id, reader_key) DO UPDATE SET
             reader_nickname = excluded.reader_nickname,
             read_count = collaboration_space_collection_reads.read_count + 1,
             last_read_at = excluded.last_read_at"#,
    )
    .bind(item_id)
    .bind(reader_key)
    .bind(reader_kind)
    .bind(reader_conversation_id)
    .bind(reader_nickname)
    .bind(&stamp)
    .bind(&stamp)
    .execute(pool)
    .await
    .map_err(db)?;
    Ok(())
}

pub async fn add_to_space_collection(
    pool: &SqlitePool,
    input: AddSpaceCollectionItem,
) -> Result<SpaceCollectionItemRecord, CollaborationError> {
    add_to_space_collection_with(pool, input, &DeliveryContext::default()).await
}

pub async fn add_to_space_collection_with(
    pool: &SqlitePool,
    input: AddSpaceCollectionItem,
    delivery: &DeliveryContext,
) -> Result<SpaceCollectionItemRecord, CollaborationError> {
    use base64::Engine as _;

    let space_id = input.space_id.trim();
    if space_id.is_empty() {
        return Err(CollaborationError::new(
            "invalid_argument",
            "space_id is required",
        ));
    }
    let space = load_space_or_unassigned(pool, space_id).await?;
    let (creator_kind, creator_conversation_id, creator_nickname) = match input.caller_id {
        Some(caller_id) => {
            let member = caller_seat(pool, space_id, caller_id).await?;
            (
                "agent".to_string(),
                Some(caller_id.to_string()),
                member.nickname,
            )
        }
        None => {
            let _ = ensure_user_member(pool, space_id).await;
            ("user".to_string(), None, "User".to_string())
        }
    };

    if input.caller_id.is_some()
        && input
            .base64_data
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty())
    {
        return Err(CollaborationError::new(
            "invalid_argument",
            "agents cannot store raw binary blobs in space collection; pass content or source_path",
        ));
    }

    let note = input
        .note
        .as_deref()
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    let request = json!({
        "caller_id": input.caller_id,
        "space_id": space_id,
        "content": input.content,
        "source_path": input.source_path,
        "file_name": input.file_name,
        "note": note,
        "has_base64": input.base64_data.as_deref().is_some_and(|v| !v.trim().is_empty()),
    });
    if let Some(stored) = load_stored_operation(pool, &input.operation_id.to_string()).await? {
        return decode_replay(accept_space_replay(&stored, Some(space_id), &request)?);
    }

    let has_content = input
        .content
        .as_deref()
        .is_some_and(|v| !v.trim().is_empty());
    let has_source = input
        .source_path
        .as_deref()
        .is_some_and(|v| !v.trim().is_empty());
    let has_base64 = input
        .base64_data
        .as_deref()
        .is_some_and(|v| !v.trim().is_empty());
    let provided_count =
        usize::from(has_content) + usize::from(has_source) + usize::from(has_base64);
    if provided_count == 0 {
        return Err(CollaborationError::new(
            "invalid_argument",
            "either content or source_path must be provided",
        ));
    }
    if provided_count > 1 {
        return Err(CollaborationError::new(
            "invalid_argument",
            "provide only one of content, source_path, or base64_data",
        ));
    }

    let project_id = resolve_space_project_id(pool, &space.workspace_id).await;
    let collection_dir = space_collection_dir(&project_id, space_id);
    tokio::fs::create_dir_all(&collection_dir)
        .await
        .map_err(|error| {
            CollaborationError::new(
                "conversation_control_failed",
                format!("failed to create space collection directory: {error}"),
            )
        })?;

    let item_id = input.operation_id.to_string();
    let (file_name, dest_path, mime_type, item_kind, byte_size) = if has_source {
        let raw_source = input.source_path.as_deref().unwrap_or_default().trim();
        let src_path =
            resolve_collection_source_path(pool, &space.workspace_id, raw_source).await?;
        let metadata = tokio::fs::metadata(&src_path).await.map_err(|_| {
            CollaborationError::new(
                "not_found",
                format!("source file was not found: {raw_source}"),
            )
        })?;
        if !metadata.is_file() {
            return Err(CollaborationError::new(
                "invalid_argument",
                "source_path must point to a regular file",
            ));
        }
        let len = metadata.len();
        if len > SPACE_COLLECTION_MAX_BYTES {
            return Err(CollaborationError::new(
                "file_too_large",
                "file exceeds maximum allowed size of 200MB",
            ));
        }
        let desired_name = input
            .file_name
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .or_else(|| src_path.file_name().and_then(|v| v.to_str()))
            .unwrap_or("file");
        let (final_name, dest) = allocate_collection_file_path(&collection_dir, desired_name, None);
        if src_path != dest {
            tokio::fs::copy(&src_path, &dest).await.map_err(|error| {
                CollaborationError::new(
                    "conversation_control_failed",
                    format!("failed to copy file to space collection: {error}"),
                )
            })?;
        }
        let (mime, kind) = collection_mime_and_kind(&dest, false);
        (
            final_name,
            dest,
            mime.to_string(),
            kind.to_string(),
            len as i64,
        )
    } else if has_base64 {
        let raw_b64 = input.base64_data.as_deref().unwrap_or_default().trim();
        let payload_b64 = raw_b64
            .split_once(";base64,")
            .map(|(_, data)| data)
            .unwrap_or(raw_b64);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(payload_b64)
            .map_err(|error| {
                CollaborationError::new("invalid_argument", format!("invalid base64 data: {error}"))
            })?;
        if (bytes.len() as u64) > SPACE_COLLECTION_MAX_BYTES {
            return Err(CollaborationError::new(
                "file_too_large",
                "file exceeds maximum allowed size of 200MB",
            ));
        }
        let desired_name = input
            .file_name
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .unwrap_or("attachment");
        let (final_name, dest) = allocate_collection_file_path(&collection_dir, desired_name, None);
        tokio::fs::write(&dest, &bytes).await.map_err(|error| {
            CollaborationError::new(
                "conversation_control_failed",
                format!("failed to write collection file: {error}"),
            )
        })?;
        let (mime, kind) = collection_mime_and_kind(&dest, false);
        (
            final_name,
            dest,
            mime.to_string(),
            kind.to_string(),
            bytes.len() as i64,
        )
    } else {
        let text = input.content.as_deref().unwrap_or_default().trim();
        let bytes = text.as_bytes();
        if (bytes.len() as u64) > SPACE_COLLECTION_MAX_BYTES {
            return Err(CollaborationError::new(
                "file_too_large",
                "content exceeds maximum allowed size of 200MB",
            ));
        }
        let mut title_end = 8.min(item_id.len());
        while title_end > 0 && !item_id.is_char_boundary(title_end) {
            title_end -= 1;
        }
        let default_title = format!("note-{}", &item_id[..title_end]);
        let desired_name = input
            .file_name
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .unwrap_or(&default_title);
        let (final_name, dest) =
            allocate_collection_file_path(&collection_dir, desired_name, Some("md"));
        tokio::fs::write(&dest, bytes).await.map_err(|error| {
            CollaborationError::new(
                "conversation_control_failed",
                format!("failed to write text collection file: {error}"),
            )
        })?;
        let (mime, kind) = collection_mime_and_kind(&dest, true);
        (
            final_name,
            dest,
            mime.to_string(),
            kind.to_string(),
            bytes.len() as i64,
        )
    };

    let created_at = now_stamp();
    let file_path_str = dest_path.to_string_lossy().replace('\\', "/");
    sqlx::query(
        r#"INSERT INTO collaboration_space_collection_items
           (id, space_id, workspace_id, project_id, creator_kind, creator_conversation_id,
            creator_nickname, item_kind, file_name, file_path, mime_type, byte_size, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
    )
    .bind(&item_id)
    .bind(space_id)
    .bind(&space.workspace_id)
    .bind(&project_id)
    .bind(&creator_kind)
    .bind(creator_conversation_id.as_deref())
    .bind(&creator_nickname)
    .bind(&item_kind)
    .bind(&file_name)
    .bind(&file_path_str)
    .bind(&mime_type)
    .bind(byte_size)
    .bind(&note)
    .bind(&created_at)
    .execute(pool)
    .await
    .map_err(db)?;

    let audience = if input.caller_id.is_some() {
        MessageAudience::Agent
    } else {
        MessageAudience::User
    };
    let record = hydrate_collection_item(
        pool,
        SpaceCollectionItemRow {
            id: item_id.clone(),
            space_id: space_id.to_string(),
            workspace_id: space.workspace_id.clone(),
            project_id,
            creator_kind,
            creator_conversation_id,
            creator_nickname,
            item_kind,
            file_name,
            file_path: file_path_str,
            mime_type,
            byte_size,
            note,
            created_at,
        },
        audience,
    )
    .await?;

    let mut stored_record = record.clone();
    stored_record.text_content = None;
    store_operation(
        pool,
        &input.operation_id.to_string(),
        Some(space_id),
        &request,
        &stored_record,
    )
    .await?;

    if let Ok(workspace_uuid) = Uuid::parse_str(&space.workspace_id) {
        delivery.notify_space_changed(CollaborationSpaceChangedEvent {
            workspace_id: workspace_uuid,
            space_id: space_id.to_string(),
            seq: None,
            member_id: None,
        });
    }

    Ok(record)
}

pub async fn list_space_collection(
    pool: &SqlitePool,
    space_id: &str,
    caller_id: Option<Uuid>,
    limit: Option<i64>,
    audience: MessageAudience,
) -> Result<Vec<SpaceCollectionItemRecord>, CollaborationError> {
    list_space_collection_with(
        pool,
        space_id,
        caller_id,
        limit,
        audience,
        &DeliveryContext::default(),
    )
    .await
}

pub async fn list_space_collection_with(
    pool: &SqlitePool,
    space_id: &str,
    caller_id: Option<Uuid>,
    limit: Option<i64>,
    audience: MessageAudience,
    delivery: &DeliveryContext,
) -> Result<Vec<SpaceCollectionItemRecord>, CollaborationError> {
    let space = if audience == MessageAudience::Agent {
        load_space(pool, space_id).await?
    } else {
        load_space_or_unassigned(pool, space_id).await?
    };
    let caller_member = match caller_id {
        Some(cid) => Some(caller_seat(pool, space_id, cid).await?),
        None => None,
    };
    let limit = limit
        .unwrap_or(SPACE_LIST_DEFAULT)
        .clamp(1, SPACE_LIST_HARD_CAP);
    let rows = sqlx::query_as::<_, SpaceCollectionItemRow>(
        r#"SELECT id, space_id, workspace_id, project_id, creator_kind, creator_conversation_id,
                  creator_nickname, item_kind, file_name, file_path, mime_type, byte_size, note, created_at
           FROM collaboration_space_collection_items
           WHERE space_id = ?
           ORDER BY created_at DESC, id DESC
           LIMIT ?"#,
    )
    .bind(space_id)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(db)?;

    if let (Some(cid), Some(member)) = (caller_id, caller_member.as_ref())
        && audience == MessageAudience::Agent
        && !rows.is_empty()
    {
        let reader_key = format!("agent:{cid}");
        let cid_str = cid.to_string();
        for row in &rows {
            let _ = record_collection_item_read(
                pool,
                &row.id,
                &reader_key,
                "agent",
                Some(&cid_str),
                &member.nickname,
            )
            .await;
        }
        if let Ok(workspace_uuid) = Uuid::parse_str(&space.workspace_id) {
            delivery.notify_space_changed(CollaborationSpaceChangedEvent {
                workspace_id: workspace_uuid,
                space_id: space_id.to_string(),
                seq: None,
                member_id: None,
            });
        }
    }

    hydrate_collection_items(pool, rows, audience).await
}

pub async fn read_space_collection_item(
    pool: &SqlitePool,
    space_id: &str,
    item_id: &str,
    caller_id: Option<Uuid>,
    audience: MessageAudience,
) -> Result<SpaceCollectionItemRecord, CollaborationError> {
    read_space_collection_item_with(
        pool,
        space_id,
        item_id,
        caller_id,
        audience,
        &DeliveryContext::default(),
    )
    .await
}

pub async fn read_space_collection_item_with(
    pool: &SqlitePool,
    space_id: &str,
    item_id: &str,
    caller_id: Option<Uuid>,
    audience: MessageAudience,
    delivery: &DeliveryContext,
) -> Result<SpaceCollectionItemRecord, CollaborationError> {
    let space = if audience == MessageAudience::Agent {
        load_space(pool, space_id).await?
    } else {
        load_space_or_unassigned(pool, space_id).await?
    };
    let (reader_key, reader_kind, reader_cid, reader_nickname) = match caller_id {
        Some(cid) => {
            let member = caller_seat(pool, space_id, cid).await?;
            (
                format!("agent:{cid}"),
                "agent".to_string(),
                Some(cid.to_string()),
                member.nickname,
            )
        }
        None => (
            "user".to_string(),
            "user".to_string(),
            None,
            "你".to_string(),
        ),
    };

    let row = sqlx::query_as::<_, SpaceCollectionItemRow>(
        r#"SELECT id, space_id, workspace_id, project_id, creator_kind, creator_conversation_id,
                  creator_nickname, item_kind, file_name, file_path, mime_type, byte_size, note, created_at
           FROM collaboration_space_collection_items
           WHERE id = ? AND space_id = ?
           LIMIT 1"#,
    )
    .bind(item_id.trim())
    .bind(space_id)
    .fetch_optional(pool)
    .await
    .map_err(db)?
    .ok_or_else(|| CollaborationError::new("not_found", "collection item was not found"))?;

    record_collection_item_read(
        pool,
        &row.id,
        &reader_key,
        &reader_kind,
        reader_cid.as_deref(),
        &reader_nickname,
    )
    .await?;

    if let Ok(workspace_uuid) = Uuid::parse_str(&space.workspace_id) {
        delivery.notify_space_changed(CollaborationSpaceChangedEvent {
            workspace_id: workspace_uuid,
            space_id: space_id.to_string(),
            seq: None,
            member_id: None,
        });
    }

    hydrate_collection_item(pool, row, audience).await
}

pub async fn update_space_collection_item_note(
    pool: &SqlitePool,
    space_id: &str,
    item_id: &str,
    note: &str,
    audience: MessageAudience,
) -> Result<SpaceCollectionItemRecord, CollaborationError> {
    update_space_collection_item_note_with(
        pool,
        space_id,
        item_id,
        note,
        audience,
        &DeliveryContext::default(),
    )
    .await
}

pub async fn update_space_collection_item_note_with(
    pool: &SqlitePool,
    space_id: &str,
    item_id: &str,
    note: &str,
    audience: MessageAudience,
    delivery: &DeliveryContext,
) -> Result<SpaceCollectionItemRecord, CollaborationError> {
    let space = load_space_or_unassigned(pool, space_id).await?;
    let trimmed_id = item_id.trim();
    let trimmed_note = note.trim();
    let changed = sqlx::query(
        r#"UPDATE collaboration_space_collection_items
           SET note = ?
           WHERE id = ? AND space_id = ?"#,
    )
    .bind(trimmed_note)
    .bind(trimmed_id)
    .bind(space_id)
    .execute(pool)
    .await
    .map_err(db)?;
    if changed.rows_affected() == 0 {
        return Err(CollaborationError::new(
            "not_found",
            "collection item was not found",
        ));
    }

    let row = sqlx::query_as::<_, SpaceCollectionItemRow>(
        r#"SELECT id, space_id, workspace_id, project_id, creator_kind, creator_conversation_id,
                  creator_nickname, item_kind, file_name, file_path, mime_type, byte_size, note, created_at
           FROM collaboration_space_collection_items
           WHERE id = ? AND space_id = ?
           LIMIT 1"#,
    )
    .bind(trimmed_id)
    .bind(space_id)
    .fetch_optional(pool)
    .await
    .map_err(db)?
    .ok_or_else(|| CollaborationError::new("not_found", "collection item was not found"))?;

    if let Ok(workspace_uuid) = Uuid::parse_str(&space.workspace_id) {
        delivery.notify_space_changed(CollaborationSpaceChangedEvent {
            workspace_id: workspace_uuid,
            space_id: space_id.to_string(),
            seq: None,
            member_id: None,
        });
    }

    hydrate_collection_item(pool, row, audience).await
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use agents::AgentId;
    use db::models::session::{CreateSession, Session};
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::*;

    async fn setup_pool() -> SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("sqlite options")
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("connect memory db");
        sqlx::migrate!("../db/migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("disable foreign keys");
        pool
    }

    fn session(name: Option<&str>) -> CreateSession {
        CreateSession {
            executor: None,
            agent_id: Some(AgentId::parse("codex").expect("agent")),
            task_id: None,
            name: name.map(str::to_string),
            initial_prompt: None,
            status: None,
        }
    }

    async fn create_session(pool: &SqlitePool, id: Uuid, workspace: Uuid, name: Option<&str>) {
        Session::create(pool, &session(name), id, workspace)
            .await
            .expect("create session");
    }

    async fn input_count(pool: &SqlitePool, conversation: Uuid) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM conversation_inputs WHERE conversation_id = ?")
            .bind(conversation)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    async fn mark_running(pool: &SqlitePool, conversation: Uuid) -> Uuid {
        let turn = Uuid::new_v4();
        sqlx::query(
            r#"INSERT INTO conversation_turns
               (id, conversation_id, ordinal, role, status, input_blocks_json)
               VALUES (?, ?, 1, 'user_prompt', 'running', '[]')"#,
        )
        .bind(turn)
        .bind(conversation)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query("UPDATE sessions SET active_turn_id = ? WHERE id = ?")
            .bind(turn)
            .bind(conversation)
            .execute(pool)
            .await
            .unwrap();
        turn
    }

    fn send_for(caller: Uuid, target: Uuid, policy: CompanionWritePolicy) -> SendSessionInput {
        SendSessionInput {
            caller_id: caller,
            conversation_id: target,
            operation_id: Uuid::new_v4(),
            text: "hello".to_string(),
            policy,
            steer: false,
            steer_supported: false,
            expected_turn_id: None,
            delay_seconds: None,
            deliver_at: None,
            delay_cap_hours: 24,
        }
    }

    #[tokio::test]
    async fn list_conversations_excludes_bodies() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let caller = Uuid::new_v4();
        create_session(&pool, caller, workspace, Some("caller")).await;
        let items = list_conversations(
            &pool,
            ListConversations {
                caller_id: caller,
                since_days: 7,
                project_id: None,
                workspace_id: None,
                limit: None,
            },
        )
        .await
        .unwrap();
        let json = serde_json::to_value(&items).unwrap();
        let encoded = json.to_string();
        assert!(!encoded.contains("messages"));
        assert!(!encoded.contains("persona_prompt"));
        assert!(!encoded.contains("\"content\""));
        assert!(json[0].get("mode_id").is_none());
        assert!(json[0].get("config_values").is_none());
        assert!(json[0].get("title").is_some());
    }

    #[tokio::test]
    async fn list_conversations_defaults_to_caller_workspace() {
        let pool = setup_pool().await;
        let home = Uuid::new_v4();
        let other = Uuid::new_v4();
        let caller = Uuid::new_v4();
        let sibling = Uuid::new_v4();
        let outsider = Uuid::new_v4();
        create_session(&pool, caller, home, Some("home")).await;
        create_session(&pool, sibling, home, Some("sibling")).await;
        create_session(&pool, outsider, other, Some("outsider")).await;
        sqlx::query("UPDATE sessions SET updated_at = datetime('now', '-10 days') WHERE id = ?")
            .bind(sibling)
            .execute(&pool)
            .await
            .unwrap();
        let week = list_conversations(
            &pool,
            ListConversations {
                caller_id: caller,
                since_days: 7,
                project_id: None,
                workspace_id: None,
                limit: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(week.len(), 1);
        assert_eq!(week[0].conversation_id, caller);
        assert_eq!(week[0].workspace_id, home);
        let day = list_conversations(
            &pool,
            ListConversations {
                caller_id: caller,
                since_days: 1,
                project_id: None,
                workspace_id: None,
                limit: Some(100),
            },
        )
        .await
        .unwrap();
        assert!(day.iter().all(|item| item.conversation_id != sibling));
        assert!(day.iter().all(|item| item.conversation_id != outsider));
    }

    #[tokio::test]
    async fn get_session_info_same_bytes_from_both_entrypoints() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let parent = Uuid::new_v4();
        let child = Uuid::new_v4();
        create_session(&pool, parent, workspace, Some("parent")).await;
        create_session(&pool, child, workspace, Some("child")).await;
        sqlx::query("UPDATE sessions SET parent_session_id = ? WHERE id = ?")
            .bind(parent)
            .bind(child)
            .execute(&pool)
            .await
            .unwrap();
        let left = read_session_info_for_delegation(&pool, &child.to_string(), 0).await;
        let right = read_session_info_for_session_product(&pool, &child.to_string(), 0).await;
        assert_eq!(
            serde_json::to_vec(&left).unwrap(),
            serde_json::to_vec(&right).unwrap()
        );
        assert_eq!(left["is_delegation_child"], false);
        sqlx::query("UPDATE sessions SET delegation_call_id = 'call-1' WHERE id = ?")
            .bind(child)
            .execute(&pool)
            .await
            .unwrap();
        let delegated = read_session_info_for_delegation(&pool, &child.to_string(), 0).await;
        assert_eq!(delegated["is_delegation_child"], true);
    }

    #[tokio::test]
    async fn create_from_role_snapshots_persona() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let caller = Uuid::new_v4();
        create_session(&pool, caller, workspace, Some("caller")).await;
        let team = create_team(
            &pool,
            SaveTeam {
                id: None,
                name: "评审组".to_string(),
                summary: Some("评审".to_string()),
            },
        )
        .await
        .unwrap();
        let role = create_role(
            &pool,
            SaveRole {
                id: None,
                name: "评审员".to_string(),
                team_id: Some(team.id.clone()),
                summary: "只看 diff".to_string(),
                persona_prompt: "只评论 diff，不改文件".to_string(),
                agent_id: "codex".to_string(),
                mode_id: Some("plan".to_string()),
                config_values: json!({ "model": "gpt" }),
            },
        )
        .await
        .unwrap();
        let operation_id = Uuid::new_v4();
        let created = create_spawned_conversation(
            &pool,
            CreateSpawnedConversation {
                caller_id: caller,
                operation_id,
                role_id: Some(role.id.clone()),
                agent_id: None,
                title: None,
                prompt: Some("开始".to_string()),
                mode_id: Some("ignored".to_string()),
                config_values: Some(json!({ "model": "ignored" })),
                depth_limit: 8,
                max_active_children: 64,
            },
        )
        .await
        .unwrap();
        assert_eq!(created.conversation_id, operation_id);
        let (name, summary, team_name, role_id, call_id, parent): (
            String,
            String,
            String,
            String,
            Option<String>,
            Option<Uuid>,
        ) = sqlx::query_as(
            r#"SELECT persona.name, persona.summary, persona.team_name, persona.role_id,
                      sessions.delegation_call_id, sessions.parent_session_id
               FROM conversation_personas persona
               JOIN sessions ON sessions.id = ?
               WHERE persona.conversation_id = ?"#,
        )
        .bind(operation_id)
        .bind(operation_id.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(name, "评审员");
        assert_eq!(summary, "只看 diff");
        assert_eq!(team_name, "评审组");
        assert_eq!(role_id, role.id);
        assert!(call_id.is_none());
        assert_eq!(parent, Some(caller));
        let notice: String = sqlx::query_scalar(
            "SELECT normalized_json FROM conversation_events WHERE conversation_id = ?",
        )
        .bind(operation_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(notice.contains("只评论 diff，不改文件"));
        assert!(notice.contains("人设"));
        assert!(notice.contains("host_note"));
        assert!(!notice.contains("announcements_updated"));
        let stored_prompt: String = sqlx::query_scalar(
            "SELECT persona_prompt FROM conversation_personas WHERE conversation_id = ?",
        )
        .bind(operation_id.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(stored_prompt, "只评论 diff，不改文件");
        assert_eq!(
            prefix_persona_prompt(&stored_prompt, "请评审当前 diff"),
            "人设\n只评论 diff，不改文件\n\n请评审当前 diff"
        );
    }

    #[tokio::test]
    async fn update_role_does_not_touch_persona() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let caller = Uuid::new_v4();
        create_session(&pool, caller, workspace, None).await;
        let role = create_role(
            &pool,
            SaveRole {
                id: None,
                name: "评审员".to_string(),
                team_id: None,
                summary: "before".to_string(),
                persona_prompt: "prompt".to_string(),
                agent_id: "codex".to_string(),
                mode_id: None,
                config_values: json!({}),
            },
        )
        .await
        .unwrap();
        let created = create_spawned_conversation(
            &pool,
            CreateSpawnedConversation {
                caller_id: caller,
                operation_id: Uuid::new_v4(),
                role_id: Some(role.id.clone()),
                agent_id: None,
                title: None,
                prompt: None,
                mode_id: None,
                config_values: None,
                depth_limit: 8,
                max_active_children: 64,
            },
        )
        .await
        .unwrap();
        update_role(
            &pool,
            &role.id,
            SaveRole {
                id: None,
                name: "评审员".to_string(),
                team_id: None,
                summary: "after".to_string(),
                persona_prompt: "changed".to_string(),
                agent_id: "codex".to_string(),
                mode_id: None,
                config_values: json!({}),
            },
        )
        .await
        .unwrap();
        let summary: String = sqlx::query_scalar(
            "SELECT summary FROM conversation_personas WHERE conversation_id = ?",
        )
        .bind(created.conversation_id.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(summary, "before");
    }

    #[tokio::test]
    async fn delete_role_keeps_session() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let caller = Uuid::new_v4();
        create_session(&pool, caller, workspace, None).await;
        let role = create_role(
            &pool,
            SaveRole {
                id: None,
                name: "评审员".to_string(),
                team_id: None,
                summary: "keep".to_string(),
                persona_prompt: "prompt".to_string(),
                agent_id: "codex".to_string(),
                mode_id: None,
                config_values: json!({}),
            },
        )
        .await
        .unwrap();
        let created = create_spawned_conversation(
            &pool,
            CreateSpawnedConversation {
                caller_id: caller,
                operation_id: Uuid::new_v4(),
                role_id: Some(role.id.clone()),
                agent_id: None,
                title: None,
                prompt: None,
                mode_id: None,
                config_values: None,
                depth_limit: 8,
                max_active_children: 64,
            },
        )
        .await
        .unwrap();
        delete_role(&pool, &role.id).await.unwrap();
        let still: Option<Uuid> = sqlx::query_scalar("SELECT id FROM sessions WHERE id = ?")
            .bind(created.conversation_id)
            .fetch_optional(&pool)
            .await
            .unwrap();
        assert_eq!(still, Some(created.conversation_id));
        let (persona_name, role_id): (String, Option<String>) = sqlx::query_as(
            "SELECT name, role_id FROM conversation_personas WHERE conversation_id = ?",
        )
        .bind(created.conversation_id.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(persona_name, "评审员");
        assert!(role_id.is_none());
    }

    #[tokio::test]
    async fn spawned_survives_parent_cancel() {
        assert!(!parent_exit_cancels_child(None));
        assert!(!parent_exit_cancels_child(Some("")));
        assert!(!parent_exit_cancels_child(Some("  ")));
        assert!(parent_exit_cancels_child(Some("call-1")));
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let parent = Uuid::new_v4();
        create_session(&pool, parent, workspace, None).await;
        let spawned = create_spawned_conversation(
            &pool,
            CreateSpawnedConversation {
                caller_id: parent,
                operation_id: Uuid::new_v4(),
                role_id: None,
                agent_id: Some("codex".to_string()),
                title: Some("direct".to_string()),
                prompt: None,
                mode_id: None,
                config_values: None,
                depth_limit: 8,
                max_active_children: 64,
            },
        )
        .await
        .unwrap();
        let call_id: Option<String> =
            sqlx::query_scalar("SELECT delegation_call_id FROM sessions WHERE id = ?")
                .bind(spawned.conversation_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(!parent_exit_cancels_child(call_id.as_deref()));
        let delegated = Uuid::new_v4();
        Session::create_with_delegation(
            &pool,
            &session(Some("child")),
            delegated,
            workspace,
            parent,
            "tool-1",
            "call-9",
        )
        .await
        .unwrap();
        let delegated_call: Option<String> =
            sqlx::query_scalar("SELECT delegation_call_id FROM sessions WHERE id = ?")
                .bind(delegated)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(parent_exit_cancels_child(delegated_call.as_deref()));
    }

    fn spawned_from(
        caller: Uuid,
        operation_id: Uuid,
        role_id: Option<String>,
    ) -> CreateSpawnedConversation {
        CreateSpawnedConversation {
            caller_id: caller,
            operation_id,
            role_id,
            agent_id: None,
            title: None,
            prompt: None,
            mode_id: None,
            config_values: None,
            depth_limit: 8,
            max_active_children: 64,
        }
    }

    #[tokio::test]
    async fn depth_limit_rejects_a_grandchild() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let caller = Uuid::new_v4();
        create_session(&pool, caller, workspace, None).await;
        let role = create_role(
            &pool,
            SaveRole {
                id: None,
                name: "评审员".to_string(),
                team_id: None,
                summary: String::new(),
                persona_prompt: String::new(),
                agent_id: "codex".to_string(),
                mode_id: None,
                config_values: json!({}),
            },
        )
        .await
        .unwrap();
        let child = create_spawned_conversation(
            &pool,
            CreateSpawnedConversation {
                depth_limit: 1,
                ..spawned_from(caller, Uuid::new_v4(), Some(role.id.clone()))
            },
        )
        .await
        .unwrap();
        let error = create_spawned_conversation(
            &pool,
            CreateSpawnedConversation {
                depth_limit: 1,
                ..spawned_from(child.conversation_id, Uuid::new_v4(), Some(role.id))
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "limit_exceeded");
    }

    #[tokio::test]
    async fn active_child_limit_releases_after_completion() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let caller = Uuid::new_v4();
        create_session(&pool, caller, workspace, None).await;
        let first = create_spawned_conversation(
            &pool,
            CreateSpawnedConversation {
                agent_id: Some("codex".to_string()),
                max_active_children: 1,
                ..spawned_from(caller, Uuid::new_v4(), None)
            },
        )
        .await
        .unwrap();
        let blocked = create_spawned_conversation(
            &pool,
            CreateSpawnedConversation {
                agent_id: Some("codex".to_string()),
                max_active_children: 1,
                ..spawned_from(caller, Uuid::new_v4(), None)
            },
        )
        .await
        .unwrap_err();
        assert_eq!(blocked.code, "limit_exceeded");
        mark_running(&pool, first.conversation_id).await;
        sqlx::query("UPDATE conversation_turns SET status = 'completed' WHERE conversation_id = ?")
            .bind(first.conversation_id)
            .execute(&pool)
            .await
            .unwrap();
        create_spawned_conversation(
            &pool,
            CreateSpawnedConversation {
                agent_id: Some("codex".to_string()),
                max_active_children: 1,
                ..spawned_from(caller, Uuid::new_v4(), None)
            },
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn retry_finishes_a_partial_role_session() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let caller = Uuid::new_v4();
        create_session(&pool, caller, workspace, None).await;
        let role = create_role(
            &pool,
            SaveRole {
                id: None,
                name: "评审员".to_string(),
                team_id: None,
                summary: "只看 diff".to_string(),
                persona_prompt: "只评论 diff".to_string(),
                agent_id: "codex".to_string(),
                mode_id: None,
                config_values: json!({}),
            },
        )
        .await
        .unwrap();
        let operation_id = Uuid::new_v4();
        Session::create(&pool, &session(Some("评审员")), operation_id, workspace)
            .await
            .unwrap();
        let created = create_spawned_conversation(
            &pool,
            spawned_from(caller, operation_id, Some(role.id.clone())),
        )
        .await
        .unwrap();
        assert!(created.idempotent_replay);
        let persona: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM conversation_personas WHERE conversation_id = ?",
        )
        .bind(operation_id.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(persona, 1);
        let again =
            create_spawned_conversation(&pool, spawned_from(caller, operation_id, Some(role.id)))
                .await
                .unwrap();
        assert!(again.idempotent_replay);
        let changed = create_spawned_conversation(
            &pool,
            CreateSpawnedConversation {
                title: Some("其他".to_string()),
                ..spawned_from(caller, operation_id, None)
            },
        )
        .await
        .unwrap_err();
        assert_eq!(changed.code, "conversation_control_failed");
    }

    #[tokio::test]
    async fn role_cap_100() {
        let pool = setup_pool().await;
        for index in 0..100 {
            create_role(
                &pool,
                SaveRole {
                    id: None,
                    name: format!("role-{index}"),
                    team_id: None,
                    summary: String::new(),
                    persona_prompt: String::new(),
                    agent_id: "codex".to_string(),
                    mode_id: None,
                    config_values: json!({}),
                },
            )
            .await
            .unwrap();
        }
        let error = create_role(
            &pool,
            SaveRole {
                id: None,
                name: "overflow".to_string(),
                team_id: None,
                summary: String::new(),
                persona_prompt: String::new(),
                agent_id: "codex".to_string(),
                mode_id: None,
                config_values: json!({}),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "limit_exceeded");
    }

    #[tokio::test]
    async fn workspace_policy_allows_sibling() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let caller = Uuid::new_v4();
        let sibling = Uuid::new_v4();
        create_session(&pool, caller, workspace, None).await;
        create_session(&pool, sibling, workspace, None).await;
        let receipt = send_session_input(
            &pool,
            send_for(caller, sibling, CompanionWritePolicy::SameWorkspace),
        )
        .await
        .unwrap();
        assert_eq!(receipt.delivered, "queued");
        assert_eq!(input_count(&pool, sibling).await, 1);
    }

    struct RecordingDispatcher {
        turn_id: Uuid,
    }

    #[async_trait]
    impl IdleTurnDispatcher for RecordingDispatcher {
        async fn start_if_idle(&self, _conversation_id: Uuid) -> Result<Option<Uuid>, String> {
            Ok(Some(self.turn_id))
        }
    }

    #[tokio::test]
    async fn idle_send_dispatches_only_through_the_dispatcher() {
        let pool = setup_pool().await;
        let caller = Uuid::new_v4();
        create_session(&pool, caller, Uuid::new_v4(), None).await;
        let turn_id = Uuid::new_v4();
        let receipt = send_session_input_with(
            &pool,
            send_for(caller, caller, CompanionWritePolicy::SameWorkspace),
            &DeliveryContext {
                publisher: None,
                dispatcher: Some(Arc::new(RecordingDispatcher { turn_id })),
                space_changed: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(receipt.delivered, "dispatched");
        assert_eq!(receipt.turn_id, Some(turn_id));
        assert!(!receipt.idempotent_replay);
    }

    #[tokio::test]
    async fn same_operation_with_different_text_conflicts() {
        let pool = setup_pool().await;
        let caller = Uuid::new_v4();
        create_session(&pool, caller, Uuid::new_v4(), None).await;
        let mut request = send_for(caller, caller, CompanionWritePolicy::SameWorkspace);
        send_session_input(&pool, request.clone()).await.unwrap();
        request.text = "different".to_string();
        let error = send_session_input(&pool, request).await.unwrap_err();
        assert_eq!(error.code, "conversation_control_failed");
        assert!(error.message.contains("different content"));
        assert_eq!(input_count(&pool, caller).await, 1);
    }

    #[tokio::test]
    async fn digest_fold_records_the_new_operation() {
        let pool = setup_pool().await;
        let caller = Uuid::new_v4();
        create_session(&pool, caller, Uuid::new_v4(), None).await;
        let first = send_for(caller, caller, CompanionWritePolicy::SameWorkspace);
        let first_receipt = send_session_input(&pool, first.clone()).await.unwrap();
        let mut second = first.clone();
        second.operation_id = Uuid::new_v4();
        let replay = send_session_input(&pool, second.clone()).await.unwrap();
        assert!(replay.idempotent_replay);
        assert_eq!(replay.input_id, first_receipt.input_id);
        assert_eq!(input_count(&pool, caller).await, 1);
        let aliases: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM collaboration_send_claim WHERE conversation_id = ? AND counts = 0",
        )
        .bind(caller.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(aliases, 1);
        let stored: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM collaboration_send_claim WHERE operation_id = ?",
        )
        .bind(second.operation_id.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(stored, 1);
    }

    #[tokio::test]
    async fn hourly_cap_counts_only_new_submits() {
        let pool = setup_pool().await;
        let caller = Uuid::new_v4();
        create_session(&pool, caller, Uuid::new_v4(), None).await;
        for index in 0..60 {
            sqlx::query(
                r#"INSERT INTO collaboration_send_claim
                   (conversation_id, operation_id, payload_digest, principal_json, receipt_json,
                    counts, created_at)
                   VALUES (?, ?, ?, '{}', '{}', 1, ?)"#,
            )
            .bind(caller.to_string())
            .bind(format!("op-{index}"))
            .bind(format!("digest-{index}"))
            .bind(now_stamp())
            .execute(&pool)
            .await
            .unwrap();
        }
        let error = send_session_input(
            &pool,
            send_for(caller, caller, CompanionWritePolicy::SameWorkspace),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "limit_exceeded");
        assert_eq!(input_count(&pool, caller).await, 0);
    }

    #[tokio::test]
    async fn ancestor_policy_rejects_sibling() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let caller = Uuid::new_v4();
        let sibling = Uuid::new_v4();
        create_session(&pool, caller, workspace, None).await;
        create_session(&pool, sibling, workspace, None).await;
        let error = send_session_input(
            &pool,
            send_for(caller, sibling, CompanionWritePolicy::AncestorTree),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "out_of_scope");
        assert_eq!(input_count(&pool, sibling).await, 0);
    }

    #[tokio::test]
    async fn cross_workspace_is_not_found() {
        let pool = setup_pool().await;
        let caller = Uuid::new_v4();
        let target = Uuid::new_v4();
        create_session(&pool, caller, Uuid::new_v4(), None).await;
        create_session(&pool, target, Uuid::new_v4(), Some("SECRET_TITLE")).await;
        let error = send_session_input(
            &pool,
            send_for(caller, target, CompanionWritePolicy::SameWorkspace),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "not_found");
        assert!(!error.message.contains("SECRET_TITLE"));
        assert!(!error.to_json().to_string().contains("SECRET_TITLE"));
    }

    #[tokio::test]
    async fn self_submit_queues_behind_inflight() {
        let pool = setup_pool().await;
        let caller = Uuid::new_v4();
        create_session(&pool, caller, Uuid::new_v4(), None).await;
        mark_running(&pool, caller).await;
        let receipt = send_session_input(
            &pool,
            send_for(caller, caller, CompanionWritePolicy::AncestorTree),
        )
        .await
        .unwrap();
        assert_eq!(receipt.delivered, "queued");
        let status: String =
            sqlx::query_scalar("SELECT status FROM conversation_turns WHERE conversation_id = ?")
                .bind(caller)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(status, "running");
        assert_eq!(input_count(&pool, caller).await, 1);
    }

    #[tokio::test]
    async fn steer_unsupported_does_not_queue() {
        let pool = setup_pool().await;
        let caller = Uuid::new_v4();
        create_session(&pool, caller, Uuid::new_v4(), None).await;
        let mut request = send_for(caller, caller, CompanionWritePolicy::SameWorkspace);
        request.steer = true;
        request.steer_supported = false;
        request.expected_turn_id = Some(Uuid::new_v4());
        let error = send_session_input(&pool, request).await.unwrap_err();
        assert_eq!(error.code, "steer_unsupported");
        assert_eq!(input_count(&pool, caller).await, 0);
    }

    #[tokio::test]
    async fn delayed_row_does_not_take_sort_key() {
        let pool = setup_pool().await;
        let caller = Uuid::new_v4();
        create_session(&pool, caller, Uuid::new_v4(), None).await;
        let mut request = send_for(caller, caller, CompanionWritePolicy::SameWorkspace);
        request.delay_seconds = Some(30);
        let receipt = send_session_input(&pool, request).await.unwrap();
        assert_eq!(receipt.delivered, "scheduled");
        assert!(receipt.delayed_input_id.is_some());
        assert_eq!(input_count(&pool, caller).await, 0);
        let columns: Vec<String> =
            sqlx::query_scalar("SELECT name FROM pragma_table_info('conversation_delayed_inputs')")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert!(!columns.iter().any(|column| column == "sort_key"));
    }

    #[tokio::test]
    async fn bad_deliver_at_is_not_reported_as_over_cap() {
        let pool = setup_pool().await;
        let caller = Uuid::new_v4();
        create_session(&pool, caller, Uuid::new_v4(), None).await;
        let mut request = send_for(caller, caller, CompanionWritePolicy::SameWorkspace);
        request.deliver_at = Some("tomorrow".to_string());
        let error = send_session_input(&pool, request).await.unwrap_err();
        assert_eq!(error.code, "conversation_control_failed");
        assert!(error.message.contains("RFC3339"));
        assert_eq!(input_count(&pool, caller).await, 0);
    }

    #[tokio::test]
    async fn delay_fields_are_mutually_exclusive() {
        let pool = setup_pool().await;
        let caller = Uuid::new_v4();
        create_session(&pool, caller, Uuid::new_v4(), None).await;
        let mut request = send_for(caller, caller, CompanionWritePolicy::SameWorkspace);
        request.delay_seconds = Some(10);
        request.deliver_at = Some(stamp(Utc::now() + Duration::hours(1)));
        let error = send_session_input(&pool, request).await.unwrap_err();
        assert_eq!(error.code, "conversation_control_failed");
        assert_eq!(input_count(&pool, caller).await, 0);
    }

    #[tokio::test]
    async fn promote_calls_submit_once() {
        let pool = setup_pool().await;
        let caller = Uuid::new_v4();
        create_session(&pool, caller, Uuid::new_v4(), None).await;
        let mut request = send_for(caller, caller, CompanionWritePolicy::SameWorkspace);
        request.delay_seconds = Some(30);
        send_session_input(&pool, request).await.unwrap();
        sqlx::query(
            "UPDATE conversation_delayed_inputs SET deliver_at = ? WHERE conversation_id = ?",
        )
        .bind(stamp(Utc::now() - Duration::seconds(1)))
        .bind(caller.to_string())
        .execute(&pool)
        .await
        .unwrap();
        assert_eq!(promote_due_delayed_inputs(&pool).await.unwrap(), 1);
        assert_eq!(promote_due_delayed_inputs(&pool).await.unwrap(), 0);
        assert_eq!(input_count(&pool, caller).await, 1);
        let status: String = sqlx::query_scalar(
            "SELECT status FROM conversation_delayed_inputs WHERE conversation_id = ?",
        )
        .bind(caller.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(status, "promoted");
    }

    #[tokio::test]
    async fn promote_failed_when_archived() {
        let pool = setup_pool().await;
        let caller = Uuid::new_v4();
        create_session(&pool, caller, Uuid::new_v4(), None).await;
        let mut request = send_for(caller, caller, CompanionWritePolicy::SameWorkspace);
        request.delay_seconds = Some(20);
        send_session_input(&pool, request).await.unwrap();
        sqlx::query("UPDATE sessions SET status = 'archived' WHERE id = ?")
            .bind(caller)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE conversation_delayed_inputs SET deliver_at = ? WHERE conversation_id = ?",
        )
        .bind(stamp(Utc::now() - Duration::seconds(1)))
        .bind(caller.to_string())
        .execute(&pool)
        .await
        .unwrap();
        promote_due_delayed_inputs(&pool).await.unwrap();
        assert_eq!(input_count(&pool, caller).await, 0);
        let status: String = sqlx::query_scalar(
            "SELECT status FROM conversation_delayed_inputs WHERE conversation_id = ?",
        )
        .bind(caller.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(status, "failed");
    }

    async fn space_of(pool: &SqlitePool, caller: Uuid) -> String {
        create_collaboration_space(pool, caller, "评审工作", Uuid::new_v4())
            .await
            .unwrap()
            .space_id
    }

    #[tokio::test]
    async fn space_mention_submits_same_text_to_each() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let c = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        create_session(&pool, c, workspace, Some("小C")).await;
        let space = space_of(&pool, a).await;
        add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        add_space_member(&pool, a, &space, c, "小C", Uuid::new_v4())
            .await
            .unwrap();
        let posted = post_to_space(
            &pool,
            PostToSpace {
                caller_id: Some(a),
                space_id: space,
                content: "请评审当前 diff。关注 auth.ts 的错误处理。".to_string(),
                summary: Some("请评审当前 diff".to_string()),
                to: vec!["小B".to_string(), "小C".to_string()],
                in_reply_to: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();
        assert_eq!(posted.receipts.len(), 2);
        let texts: Vec<String> = sqlx::query_scalar(
            "SELECT payload_json FROM conversation_inputs WHERE conversation_id IN (?, ?)",
        )
        .bind(b)
        .bind(c)
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(texts.len(), 2);
        assert!(texts.iter().all(|text| text.contains("请评审当前 diff")));
        assert!(texts.iter().all(|text| text.contains("auth.ts")));
        assert_eq!(texts[0], texts[1]);
    }

    #[tokio::test]
    async fn same_member_in_two_spaces_gets_distinct_conversations() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        let first = space_of(&pool, a).await;
        let second = space_of(&pool, a).await;
        let in_first = add_space_member(&pool, a, &first, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        assert_eq!(in_first.conversation_id, Some(b.to_string()));
        let in_second = add_space_member(&pool, a, &second, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        let forked = Uuid::parse_str(in_second.conversation_id.as_deref().unwrap()).unwrap();
        assert_ne!(forked, b);
        let forked_session = load_session(&pool, forked)
            .await
            .unwrap()
            .expect("forked session");
        assert_eq!(forked_session.workspace_id, workspace);

        let member = identity::member_id_for_conversation(b);
        assert_eq!(resolve_session(&pool, &member, &first).await.unwrap(), b);
        assert_eq!(
            resolve_session(&pool, &member, &second).await.unwrap(),
            forked
        );
        assert_eq!(
            resolve_member_target(&pool, a, &member, &second)
                .await
                .unwrap(),
            forked
        );
        let other_workspace = Uuid::new_v4();
        let stranger = Uuid::new_v4();
        create_session(&pool, stranger, other_workspace, Some("外人")).await;
        assert_eq!(
            resolve_member_target(&pool, stranger, &member, &second)
                .await
                .unwrap_err()
                .code,
            "not_found"
        );

        for (space, text) in [(&second, "第二空间"), (&first, "第一空间")] {
            post_to_space(
                &pool,
                PostToSpace {
                    caller_id: Some(a),
                    space_id: space.clone(),
                    content: text.to_string(),
                    summary: None,
                    to: vec!["小B".to_string()],
                    in_reply_to: None,
                    operation_id: Uuid::new_v4(),
                },
            )
            .await
            .unwrap();
        }
        let payload = |conversation: Uuid| {
            let pool = pool.clone();
            async move {
                sqlx::query_scalar::<_, String>(
                    "SELECT payload_json FROM conversation_inputs WHERE conversation_id = ?",
                )
                .bind(conversation)
                .fetch_all(&pool)
                .await
                .unwrap()
            }
        };
        let to_b = payload(b).await;
        let to_forked = payload(forked).await;
        assert_eq!(to_b.len(), 1);
        assert!(to_b[0].contains("第一空间"));
        assert_eq!(to_forked.len(), 1);
        assert!(to_forked[0].contains("第二空间"));
    }

    async fn post_as(
        pool: &SqlitePool,
        caller: Option<Uuid>,
        space: &str,
        text: &str,
        to: &[&str],
    ) -> SpacePostResult {
        post_to_space(
            pool,
            PostToSpace {
                caller_id: caller,
                space_id: space.to_string(),
                content: text.to_string(),
                summary: None,
                to: to.iter().map(|name| name.to_string()).collect(),
                in_reply_to: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap()
    }

    async fn inputs_of(pool: &SqlitePool, conversation: Uuid) -> Vec<String> {
        sqlx::query_scalar::<_, String>(
            "SELECT payload_json FROM conversation_inputs WHERE conversation_id = ? ORDER BY sort_key",
        )
        .bind(conversation)
        .fetch_all(pool)
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn agent_created_space_seats_creator_through_member_identity() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        let first = space_of(&pool, a).await;
        // `a` is now bound to `first`; creating a second space must not share
        // the same conversation across both spaces.
        let second = space_of(&pool, a).await;
        let member = identity::member_id_for_conversation(a);
        assert_eq!(resolve_session(&pool, &member, &first).await.unwrap(), a);
        let seat_in_second = resolve_session(&pool, &member, &second).await.unwrap();
        assert_ne!(seat_in_second, a);
        let seated: Vec<String> = sqlx::query_scalar(
            "SELECT conversation_id FROM collaboration_space_members WHERE space_id = ? AND kind = 'agent'",
        )
        .bind(&second)
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(seated, vec![seat_in_second.to_string()]);
        let shared: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM collaboration_space_members WHERE conversation_id = ? AND kind = 'agent'",
        )
        .bind(a.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(shared, 1, "creator conversation must sit in one space only");

        // The creator can still act in the new space from its original
        // conversation; it posts as its seat and never receives its own post.
        add_space_member(&pool, a, &second, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        let posted = post_as(&pool, Some(a), &second, "大家好", &[]).await;
        assert_eq!(posted.receipts.len(), 1);
        assert!(inputs_of(&pool, seat_in_second).await.is_empty());
        assert!(inputs_of(&pool, a).await.is_empty());
    }

    #[tokio::test]
    async fn receipts_move_queued_processing_replied_and_origin_is_kept() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        let space = space_of(&pool, a).await;
        add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        // b is busy, so the input waits in its queue.
        mark_running(&pool, b).await;
        let posted = post_as(&pool, None, &space, "@小B 看一下", &[]).await;
        let to_b = posted
            .receipts
            .iter()
            .find(|receipt| receipt.conversation_id == b)
            .unwrap();
        assert_eq!(to_b.state, "queued");
        let input_id = to_b.input_id.unwrap();

        // The queue dispatches the input: receipt becomes processing.
        sqlx::query("UPDATE conversation_inputs SET status = 'dispatched' WHERE id = ?")
            .bind(input_id)
            .execute(&pool)
            .await
            .unwrap();
        let receipts = list_message_receipts(&pool, &posted.message_id)
            .await
            .unwrap();
        let state_of = |receipts: &[MessageReceipt]| {
            receipts
                .iter()
                .find(|r| r.conversation_id == b.to_string())
                .unwrap()
                .state
                .clone()
        };
        assert_eq!(state_of(&receipts), "processing");

        // b answers in the thread: replied.
        let reply = post_as(&pool, Some(b), &space, "看完了", &["User"]).await;
        let receipts = list_message_receipts(&pool, &posted.message_id)
            .await
            .unwrap();
        assert_eq!(state_of(&receipts), "replied");

        let messages = list_space_messages(&pool, &space, None, None, MessageAudience::User)
            .await
            .unwrap();
        let origin_of = |seq: i64| {
            messages
                .iter()
                .find(|m| m.seq == seq)
                .map(|m| m.origin.clone())
                .unwrap()
        };
        assert_eq!(origin_of(posted.seq), "user");
        assert_eq!(origin_of(reply.seq), "agent");
        let user_post = messages.iter().find(|m| m.seq == posted.seq).unwrap();
        assert_eq!(state_of(&user_post.receipts), "replied");
    }

    #[tokio::test]
    async fn missed_context_keeps_last_20_and_collapses_older_into_one_line() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let (a, b, c) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        create_session(&pool, c, workspace, Some("小C")).await;
        let space = space_of(&pool, a).await;
        add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        add_space_member(&pool, a, &space, c, "小C", Uuid::new_v4())
            .await
            .unwrap();
        for i in 1..=25 {
            post_as(&pool, None, &space, &format!("@小C 第{i:02}条"), &[]).await;
        }
        post_as(&pool, None, &space, "@小B 你来总结", &[]).await;
        let to_b = inputs_of(&pool, b).await;
        let packed: Value = serde_json::from_str(to_b.last().unwrap()).unwrap();
        let packed = packed["text"].as_str().unwrap();
        assert!(
            packed.contains("count=\"25\""),
            "{} inputs; last: {packed}",
            to_b.len()
        );
        assert_eq!(packed.matches("] User: ").count(), MISSED_CONTEXT_VERBATIM);
        assert!(packed.contains("5 earlier messages from User (collapsed"));
        assert!(!packed.contains("第05条"), "older ones are collapsed");
        assert!(packed.contains("第06条") && packed.contains("第25条"));
    }

    #[tokio::test]
    async fn mention_packs_missed_group_messages_and_advances_last_seen() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let c = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        create_session(&pool, c, workspace, Some("小C")).await;
        let space = space_of(&pool, a).await;
        add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        add_space_member(&pool, a, &space, c, "小C", Uuid::new_v4())
            .await
            .unwrap();
        let first = post_as(&pool, None, &space, "@小C 先看接口", &[]).await;
        post_as(&pool, Some(c), &space, "接口没问题", &["User"]).await;
        let member_b = identity::member_id_for_conversation(b);
        let seen = |member: String| {
            let pool = pool.clone();
            let space = space.clone();
            async move {
                sqlx::query_scalar::<_, Option<String>>(
                    "SELECT last_seen_message_id FROM collaboration_thread_members WHERE thread_id = ? AND member_id = ?",
                )
                .bind(space)
                .bind(member)
                .fetch_one(&pool)
                .await
                .unwrap()
            }
        };
        assert_eq!(seen(member_b.clone()).await, None);
        assert_eq!(
            seen(identity::member_id_for_conversation(c)).await,
            Some(first.message_id.clone())
        );

        let mention = post_as(&pool, None, &space, "@小B 你来总结", &[]).await;
        let to_b = inputs_of(&pool, b).await;
        assert_eq!(to_b.len(), 1);
        assert!(to_b[0].contains("missed_group_messages"));
        assert!(to_b[0].contains("先看接口"));
        assert!(to_b[0].contains("接口没问题"));
        assert_eq!(
            seen(member_b.clone()).await,
            Some(mention.message_id.clone())
        );

        // Nothing new since: the next mention packs no backlog.
        post_as(&pool, None, &space, "@小B 再补一句", &[]).await;
        let to_b = inputs_of(&pool, b).await;
        assert_eq!(to_b.len(), 2);
        assert!(!to_b[1].contains("missed_group_messages"));
    }

    #[tokio::test]
    async fn wake_preview_counts_members_for_a_draft_without_mentions() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let c = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        create_session(&pool, c, workspace, Some("小C")).await;
        let space = space_of(&pool, a).await;
        add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        add_space_member(&pool, a, &space, c, "小C", Uuid::new_v4())
            .await
            .unwrap();
        let broadcast = preview_space_wake(&pool, &space, None, "大家看看", &[])
            .await
            .unwrap();
        assert!(broadcast.broadcast);
        assert_eq!(broadcast.will_wake, 3);
        let mentioned = preview_space_wake(&pool, &space, None, "@小B 看看", &[])
            .await
            .unwrap();
        assert!(!mentioned.broadcast);
        assert_eq!(mentioned.will_wake, 1);
        let from_agent = preview_space_wake(&pool, &space, Some(a), "大家看看", &[])
            .await
            .unwrap();
        assert_eq!(from_agent.will_wake, 2);
        // Preview never delivers.
        assert!(inputs_of(&pool, b).await.is_empty());
    }

    #[tokio::test]
    async fn idle_sessions_sleep_and_wakes_are_capped_per_turn() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        let space = space_of(&pool, a).await;
        let mut others = Vec::new();
        for name in ["小B", "小C", "小D", "小E"] {
            let id = Uuid::new_v4();
            create_session(&pool, id, workspace, Some(name)).await;
            add_space_member(&pool, a, &space, id, name, Uuid::new_v4())
                .await
                .unwrap();
            others.push(id);
        }
        // Busy sessions never sleep.
        mark_running(&pool, others[3]).await;
        sqlx::query(
            "UPDATE collaboration_thread_members SET last_active_at = '2000-01-01T00:00:00Z'",
        )
        .execute(&pool)
        .await
        .unwrap();
        assert_eq!(
            sleep_idle_sessions(&pool, 0).await.unwrap(),
            0,
            "0 disables"
        );
        let slept = sleep_idle_sessions(&pool, 30).await.unwrap();
        assert_eq!(slept, 4, "a + three idle members");
        assert!(session_is_asleep(&pool, others[0]).await.unwrap());
        assert!(!session_is_asleep(&pool, others[3]).await.unwrap());
        let preview = preview_space_wake(&pool, &space, None, "大家", &[])
            .await
            .unwrap();
        assert_eq!(preview.asleep, 4);

        // One user message is one turn: only DEFAULT_WAKE_CAP_PER_TURN (3)
        // sleeping sessions wake; the rest are deferred.
        let posted = post_as(&pool, None, &space, "大家醒醒", &[]).await;
        let woken = posted
            .receipts
            .iter()
            .filter(|r| r.error_code.is_none() && r.conversation_id != others[3])
            .count();
        let deferred: Vec<_> = posted
            .receipts
            .iter()
            .filter(|r| r.error_code.as_deref() == Some("wake_limit_exceeded"))
            .collect();
        assert_eq!(woken, 3);
        assert_eq!(deferred.len(), 1);
        assert_eq!(deferred[0].delivered, "deferred");
        assert!(
            inputs_of(&pool, deferred[0].conversation_id)
                .await
                .is_empty()
        );
        // The awake (busy) member was delivered without using the cap.
        assert_eq!(inputs_of(&pool, others[3]).await.len(), 1);
        // Woken sessions are awake again.
        let still_asleep: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM collaboration_thread_members WHERE asleep_since IS NOT NULL",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(still_asleep, 1);
        // A new message is a new turn and may wake the deferred member.
        let next = post_as(&pool, None, &space, "再叫一次", &[]).await;
        assert!(next.receipts.iter().all(|r| r.error_code.is_none()));
    }

    fn envelope(ask: &str) -> HandoffEnvelope {
        HandoffEnvelope {
            done: "接口草案已完成".to_string(),
            inputs_constraints: "只改 auth 模块".to_string(),
            ask: ask.to_string(),
        }
    }

    async fn hand(
        pool: &SqlitePool,
        from: Uuid,
        space: &str,
        to: &str,
        ask: &str,
    ) -> Result<HandoffResult, CollaborationError> {
        handoff(
            pool,
            Handoff {
                caller_id: from,
                space_id: space.to_string(),
                to: to.to_string(),
                envelope: envelope(ask),
                operation_id: Uuid::new_v4(),
            },
        )
        .await
    }

    async fn handoff_team(pool: &SqlitePool) -> (String, Vec<Uuid>) {
        let workspace = Uuid::new_v4();
        let names = ["小A", "小B", "小C", "小D"];
        let mut ids = Vec::new();
        for name in names {
            let id = Uuid::new_v4();
            create_session(pool, id, workspace, Some(name)).await;
            ids.push(id);
        }
        let space = space_of(pool, ids[0]).await;
        for (id, name) in ids.iter().zip(names).skip(1) {
            add_space_member(pool, ids[0], &space, *id, name, Uuid::new_v4())
                .await
                .unwrap();
        }
        (space, ids)
    }

    #[tokio::test]
    async fn handoff_delivers_envelope_and_enforces_depth() {
        let pool = setup_pool().await;
        let (space, ids) = handoff_team(&pool).await;
        let first = hand(&pool, ids[0], &space, "小B", "实现登录")
            .await
            .unwrap();
        assert_eq!((first.status.as_str(), first.depth), ("accepted", 1));
        let to_b = inputs_of(&pool, ids[1]).await;
        assert_eq!(to_b.len(), 1);
        for part in [
            "<done>",
            "接口草案已完成",
            "<inputs_constraints>",
            "<ask>",
            "实现登录",
        ] {
            assert!(to_b[0].contains(part), "missing {part}");
        }
        assert_eq!(
            hand(&pool, ids[1], &space, "小C", "写测试")
                .await
                .unwrap()
                .depth,
            2
        );
        assert_eq!(
            hand(&pool, ids[2], &space, "小D", "跑测试")
                .await
                .unwrap()
                .depth,
            3
        );
        let too_deep = hand(&pool, ids[3], &space, "小A", "再转")
            .await
            .unwrap_err();
        assert_eq!(too_deep.code, "limit_exceeded");
        let recorded: (String, i64, Option<String>) = sqlx::query_as(
            "SELECT status, depth, reason FROM collaboration_handoffs WHERE from_conversation_id = ?",
        )
        .bind(ids[3].to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(recorded.0, "rejected");
        assert_eq!(recorded.1, 4);
        assert!(recorded.2.unwrap().contains("depth"));
        // Rejected handoffs deliver nothing.
        assert!(inputs_of(&pool, ids[0]).await.is_empty());
    }

    #[tokio::test]
    async fn handoff_count_is_limited_per_turn() {
        let pool = setup_pool().await;
        let (space, ids) = handoff_team(&pool).await;
        let turn = mark_running(&pool, ids[0]).await;
        hand(&pool, ids[0], &space, "小B", "一").await.unwrap();
        hand(&pool, ids[0], &space, "小C", "二").await.unwrap();
        let third = hand(&pool, ids[0], &space, "小D", "三").await.unwrap_err();
        assert_eq!(third.code, "limit_exceeded");
        let rejected: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM collaboration_handoffs WHERE status = 'rejected' AND turn_key = ?",
        )
        .bind(format!("turn:{turn}"))
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(rejected, 1);
        assert!(inputs_of(&pool, ids[3]).await.is_empty());
    }

    #[tokio::test]
    async fn failed_handoff_is_reported_back_into_the_thread() {
        let pool = setup_pool().await;
        let (space, ids) = handoff_team(&pool).await;
        sqlx::query("UPDATE sessions SET status = 'archived' WHERE id = ?")
            .bind(ids[1])
            .execute(&pool)
            .await
            .unwrap();
        let operation = Uuid::new_v4();
        let request = Handoff {
            caller_id: ids[0],
            space_id: space.clone(),
            to: "小B".to_string(),
            envelope: envelope("实现登录"),
            operation_id: operation,
        };
        let failed = handoff(&pool, request.clone()).await.unwrap();
        assert_eq!(failed.status, "failed");
        let report = failed.report_message_id.clone().expect("report posted");
        let messages = list_space_messages(&pool, &space, None, None, MessageAudience::User)
            .await
            .unwrap();
        let posted = messages
            .iter()
            .find(|m| m.envelope["id"] == json!(format!("vibex://space-message/{report}")))
            .expect("report in thread");
        assert_eq!(posted.origin, "agent");
        assert!(
            posted.envelope["content"]
                .as_str()
                .unwrap()
                .contains("失败")
        );
        // Replaying the same operation returns the recorded outcome.
        assert_eq!(handoff(&pool, request).await.unwrap(), failed);
    }

    #[tokio::test]
    async fn over_cap_wakes_show_limit_reached_and_deliver_after_the_turn_ends() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        let space = space_of(&pool, a).await;
        let mut others = Vec::new();
        for name in ["小B", "小C", "小D", "小E"] {
            let id = Uuid::new_v4();
            create_session(&pool, id, workspace, Some(name)).await;
            add_space_member(&pool, a, &space, id, name, Uuid::new_v4())
                .await
                .unwrap();
            others.push(id);
        }
        sqlx::query(
            "UPDATE collaboration_thread_members SET last_active_at = '2000-01-01T00:00:00Z'",
        )
        .execute(&pool)
        .await
        .unwrap();
        sleep_idle_sessions(&pool, 30).await.unwrap();
        // 小A posts mid-turn: one turn may wake at most 3 sleepers.
        mark_running(&pool, a).await;
        let posted = post_as(&pool, Some(a), &space, "大家醒醒", &[]).await;
        let held: Vec<_> = posted
            .receipts
            .iter()
            .filter(|r| r.error_code.as_deref() == Some("wake_limit_exceeded"))
            .collect();
        assert_eq!(held.len(), 1);
        assert_eq!(held[0].state, WAKE_LIMIT_REACHED);
        let held = held[0].conversation_id;
        let receipt_of = |receipts: Vec<MessageReceipt>| {
            receipts
                .into_iter()
                .find(|r| r.conversation_id == held.to_string())
                .unwrap()
        };
        let visible = receipt_of(
            list_message_receipts(&pool, &posted.message_id)
                .await
                .unwrap(),
        );
        assert_eq!(
            visible.state, "limit_reached",
            "visible, not silently queued"
        );
        assert!(visible.updated_at.is_some());

        // While the originating turn runs the sweep keeps holding it.
        redeliver_deferred(&pool, &DeliveryContext::default())
            .await
            .unwrap();
        assert!(inputs_of(&pool, held).await.is_empty());
        assert_eq!(
            receipt_of(
                list_message_receipts(&pool, &posted.message_id)
                    .await
                    .unwrap()
            )
            .state,
            "limit_reached"
        );

        // Turn ends -> the next sweep delivers it; it never stalls.
        sqlx::query("UPDATE sessions SET active_turn_id = NULL WHERE id = ?")
            .bind(a)
            .execute(&pool)
            .await
            .unwrap();
        redeliver_deferred(&pool, &DeliveryContext::default())
            .await
            .unwrap();
        assert_eq!(inputs_of(&pool, held).await.len(), 1);
        let after = receipt_of(
            list_message_receipts(&pool, &posted.message_id)
                .await
                .unwrap(),
        );
        assert_ne!(after.state, "limit_reached");
        assert_eq!(
            after.state, "queued",
            "now an ordinary queued input for its next turn"
        );
    }

    #[tokio::test]
    async fn member_sessions_on_one_repo_default_to_isolated() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        let first = space_of(&pool, a).await;
        let second = space_of(&pool, a).await;
        add_space_member(&pool, a, &first, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        let forked = Uuid::parse_str(
            add_space_member(&pool, a, &second, b, "小B", Uuid::new_v4())
                .await
                .unwrap()
                .conversation_id
                .as_deref()
                .unwrap(),
        )
        .unwrap();
        let primary = plan_member_write(&pool, b).await.unwrap().unwrap();
        assert_eq!(primary.access, MemberWriteAccess::WriteIsolated);
        assert!(primary.primary);
        assert_eq!(primary.siblings, vec![forked]);
        assert!(!primary.needs_isolated_workspace());
        let extra = plan_member_write(&pool, forked).await.unwrap().unwrap();
        assert!(!extra.primary);
        assert!(extra.needs_isolated_workspace());
        let isolated = Uuid::new_v4();
        record_member_session_workspace(&pool, &extra, forked, isolated, &json!({}))
            .await
            .unwrap();
        let extra = plan_member_write(&pool, forked).await.unwrap().unwrap();
        assert_eq!(extra.isolated_workspace_id, Some(isolated));
        assert!(!extra.needs_isolated_workspace());
        // Isolated sessions never wait for each other.
        mark_running(&pool, b).await;
        assert!(try_acquire_member_write(&pool, forked).await.unwrap());
        // A conversation without a member identity has no plan.
        let loose = Uuid::new_v4();
        create_session(&pool, loose, workspace, Some("散")).await;
        assert!(plan_member_write(&pool, loose).await.unwrap().is_none());
    }

    /// Test provisioner: real `git worktree add` per isolated session.
    struct GitWorktreeProvisioner {
        repo: std::path::PathBuf,
        dirs: std::sync::Mutex<std::collections::HashMap<Uuid, std::path::PathBuf>>,
        calls: std::sync::atomic::AtomicUsize,
    }

    #[async_trait::async_trait]
    impl IsolatedWorkspaceProvisioner for GitWorktreeProvisioner {
        async fn provision(
            &self,
            _plan: &MemberWritePlan,
            conversation_id: Uuid,
            isolated: Uuid,
        ) -> Result<Option<(Uuid, Value)>, String> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let dir = self.repo.with_file_name(format!("wt-{isolated}"));
            git(
                &self.repo,
                &[
                    "worktree",
                    "add",
                    "-b",
                    &format!("member/{conversation_id}"),
                    dir.to_str().unwrap(),
                ],
            );
            self.dirs.lock().unwrap().insert(isolated, dir);
            Ok(Some((
                isolated,
                json!({ "branch": format!("member/{conversation_id}") }),
            )))
        }
    }

    fn git(dir: &std::path::Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git");
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    #[tokio::test]
    async fn two_sessions_of_one_member_write_one_repo_concurrently_without_conflict() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        let first = space_of(&pool, a).await;
        let second = space_of(&pool, a).await;
        add_space_member(&pool, a, &first, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        let forked = Uuid::parse_str(
            add_space_member(&pool, a, &second, b, "小B", Uuid::new_v4())
                .await
                .unwrap()
                .conversation_id
                .as_deref()
                .unwrap(),
        )
        .unwrap();

        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("shared.txt"), "base\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-qm", "base"]);
        let provisioner = GitWorktreeProvisioner {
            repo: repo.clone(),
            dirs: Default::default(),
            calls: Default::default(),
        };

        // Both sessions dispatch a turn at the same time.
        let (primary_ws, forked_ws) = tokio::join!(
            execution_workspace_id(&pool, b, workspace, &provisioner),
            execution_workspace_id(&pool, forked, workspace, &provisioner),
        );
        let (primary_ws, forked_ws) = (primary_ws.unwrap(), forked_ws.unwrap());
        assert_eq!(primary_ws, workspace, "primary keeps the native checkout");
        assert_eq!(forked_ws, member_worktree_workspace_id(forked));
        let dir_of = |id: Uuid| {
            if id == workspace {
                repo.clone()
            } else {
                provisioner.dirs.lock().unwrap()[&id].clone()
            }
        };
        let (primary_dir, forked_dir) = (dir_of(primary_ws), dir_of(forked_ws));
        assert_ne!(primary_dir, forked_dir);

        // Concurrent writes to the same file in the same repo.
        let writes = [
            (primary_dir.clone(), "from primary\n"),
            (forked_dir.clone(), "from fork\n"),
        ]
        .map(|(dir, text)| {
            std::thread::spawn(move || {
                std::fs::write(dir.join("shared.txt"), text).unwrap();
                git(&dir, &["commit", "-qam", text.trim()]);
            })
        });
        for write in writes {
            write.join().unwrap();
        }
        assert_eq!(
            std::fs::read_to_string(primary_dir.join("shared.txt")).unwrap(),
            "from primary\n"
        );
        assert_eq!(
            std::fs::read_to_string(forked_dir.join("shared.txt")).unwrap(),
            "from fork\n"
        );
        assert!(git(&repo, &["status", "--porcelain"]).trim().is_empty());
        assert!(
            git(&forked_dir, &["status", "--porcelain"])
                .trim()
                .is_empty()
        );

        // Later turns reuse the recorded worktree; the session row is untouched.
        let again = execution_workspace_id(&pool, forked, workspace, &provisioner)
            .await
            .unwrap();
        assert_eq!(again, forked_ws);
        assert_eq!(
            provisioner.calls.load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        let plan = plan_member_write(&pool, forked).await.unwrap().unwrap();
        assert_eq!(
            plan.workspace_id, workspace,
            "collaboration still sees the session workspace"
        );
        assert_eq!(plan.isolated_workspace_id, Some(forked_ws));
    }

    #[tokio::test]
    async fn write_serialized_member_sessions_take_turns() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        let first = space_of(&pool, a).await;
        let second = space_of(&pool, a).await;
        add_space_member(&pool, a, &first, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        let forked = Uuid::parse_str(
            add_space_member(&pool, a, &second, b, "小B", Uuid::new_v4())
                .await
                .unwrap()
                .conversation_id
                .as_deref()
                .unwrap(),
        )
        .unwrap();
        let member = identity::member_id_for_conversation(b);
        set_member_write_access(&pool, &member, MemberWriteAccess::WriteSerialized)
            .await
            .unwrap();
        assert!(
            set_member_write_access(&pool, "ghost", MemberWriteAccess::WriteSerialized)
                .await
                .is_err()
        );
        assert!(
            !plan_member_write(&pool, forked)
                .await
                .unwrap()
                .unwrap()
                .needs_isolated_workspace()
        );

        // b's first-space session takes the lease and is busy.
        assert!(try_acquire_member_write(&pool, b).await.unwrap());
        let turn = mark_running(&pool, b).await;
        // A delivery to the same member's other session waits.
        let posted = post_as(&pool, Some(a), &second, "@小B 第二空间的活", &[]).await;
        let deferred = posted
            .receipts
            .iter()
            .find(|r| r.conversation_id == forked)
            .unwrap();
        assert_eq!(
            deferred.error_code.as_deref(),
            Some("write_serialized_busy")
        );
        assert!(inputs_of(&pool, forked).await.is_empty());

        // b finishes; the sweeper retry delivers the deferred message.
        sqlx::query("UPDATE sessions SET active_turn_id = NULL WHERE id = ?")
            .bind(b)
            .execute(&pool)
            .await
            .unwrap();
        let _ = turn;
        assert_eq!(
            redeliver_deferred(&pool, &DeliveryContext::default())
                .await
                .unwrap(),
            1
        );
        assert_eq!(inputs_of(&pool, forked).await.len(), 1);
        assert_eq!(
            redeliver_deferred(&pool, &DeliveryContext::default())
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn space_broadcast_skips_sender_and_user() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let c = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        create_session(&pool, c, workspace, Some("小C")).await;
        let space = space_of(&pool, a).await;
        add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        add_space_member(&pool, a, &space, c, "小C", Uuid::new_v4())
            .await
            .unwrap();
        ensure_user_member(&pool, &space).await.unwrap();
        let posted = post_to_space(
            &pool,
            PostToSpace {
                caller_id: Some(a),
                space_id: space.clone(),
                content: "广播".to_string(),
                summary: None,
                to: Vec::new(),
                in_reply_to: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();
        let recipients: Vec<Uuid> = posted
            .receipts
            .iter()
            .map(|receipt| receipt.conversation_id)
            .collect();
        assert!(recipients.contains(&b));
        assert!(recipients.contains(&c));
        assert!(!recipients.contains(&a));
        assert_eq!(input_count(&pool, a).await, 0);
        let members = list_space_members(&pool, &space, MessageAudience::Agent)
            .await
            .unwrap();
        assert!(members.iter().all(|member| member.kind != "user"));
        let messages = list_space_messages(&pool, &space, None, None, MessageAudience::Agent)
            .await
            .unwrap();
        let encoded = serde_json::to_string(&messages).unwrap();
        assert!(!encoded.contains("/user"));
    }

    #[tokio::test]
    async fn agent_projection_hides_the_user_actor() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        let space = space_of(&pool, a).await;
        add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        post_to_space(
            &pool,
            PostToSpace {
                caller_id: None,
                space_id: space.clone(),
                content: "请看这里".to_string(),
                summary: None,
                to: vec!["小B".to_string()],
                in_reply_to: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();
        let agent_messages = list_space_messages(&pool, &space, None, None, MessageAudience::Agent)
            .await
            .unwrap();
        let agent_json = serde_json::to_string(&agent_messages).unwrap();
        assert!(!agent_json.contains("/user"));
        assert!(agent_json.contains("\"actor\":\"user\""));
        let user_messages = list_space_messages(&pool, &space, None, None, MessageAudience::User)
            .await
            .unwrap();
        let user_json = serde_json::to_string(&user_messages).unwrap();
        assert!(user_json.contains("/user"));
    }

    #[tokio::test]
    async fn space_replay_requires_membership_and_the_same_request() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let outsider = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        create_session(&pool, outsider, workspace, Some("外人")).await;
        let space = space_of(&pool, a).await;
        add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        let operation_id = Uuid::new_v4();
        let request = PostToSpace {
            caller_id: Some(a),
            space_id: space.clone(),
            content: "一次".to_string(),
            summary: Some("一次".to_string()),
            to: vec!["小B".to_string()],
            in_reply_to: None,
            operation_id,
        };
        post_to_space(&pool, request.clone()).await.unwrap();
        let mut outsider_request = request.clone();
        outsider_request.caller_id = Some(outsider);
        let denied = post_to_space(&pool, outsider_request).await.unwrap_err();
        assert_eq!(denied.code, "not_a_member");
        let mut changed = request.clone();
        changed.content = "两次".to_string();
        let conflict = post_to_space(&pool, changed).await.unwrap_err();
        assert_eq!(conflict.code, "conversation_control_failed");
        assert_eq!(input_count(&pool, b).await, 1);
        let other = create_collaboration_space(&pool, a, "另一空间", Uuid::new_v4())
            .await
            .unwrap();
        add_space_member(&pool, a, &other.space_id, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        let mut wrong_space = request.clone();
        wrong_space.space_id = other.space_id.clone();
        let missing = post_to_space(&pool, wrong_space).await.unwrap_err();
        assert_eq!(missing.code, "not_found");
        let leaked: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM collaboration_space_messages WHERE space_id = ?",
        )
        .bind(&other.space_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(leaked, 0);
    }

    #[tokio::test]
    async fn space_inflight_member_is_queued() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        let space = space_of(&pool, a).await;
        add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        mark_running(&pool, b).await;
        let posted = post_to_space(
            &pool,
            PostToSpace {
                caller_id: Some(a),
                space_id: space,
                content: "补充".to_string(),
                summary: Some("补充".to_string()),
                to: vec!["小B".to_string()],
                in_reply_to: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();
        assert_eq!(posted.receipts[0].delivered, "queued");
        let status: String =
            sqlx::query_scalar("SELECT status FROM conversation_turns WHERE conversation_id = ?")
                .bind(b)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(status, "running");
    }

    #[tokio::test]
    async fn space_retry_does_not_double_submit() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        let space = space_of(&pool, a).await;
        add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        let operation_id = Uuid::new_v4();
        let request = PostToSpace {
            caller_id: Some(a),
            space_id: space,
            content: "一次".to_string(),
            summary: Some("一次".to_string()),
            to: vec!["小B".to_string()],
            in_reply_to: None,
            operation_id,
        };
        post_to_space(&pool, request.clone()).await.unwrap();
        post_to_space(&pool, request).await.unwrap();
        assert_eq!(input_count(&pool, b).await, 1);
        let deliveries: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM collaboration_space_deliveries WHERE conversation_id = ?",
        )
        .bind(b.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(deliveries, 1);
    }

    #[tokio::test]
    async fn member_can_rename_self() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        let space = space_of(&pool, a).await;
        let renamed = set_space_identity(&pool, a, &space, "评审A", Uuid::new_v4())
            .await
            .unwrap();
        assert_eq!(renamed.nickname, "评审A");
    }

    #[tokio::test]
    async fn proposer_nickname_then_rename() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        let space = space_of(&pool, a).await;
        add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        let first = post_to_space(
            &pool,
            PostToSpace {
                caller_id: Some(a),
                space_id: space.clone(),
                content: "旧称呼".to_string(),
                summary: Some("旧称呼".to_string()),
                to: vec!["小B".to_string()],
                in_reply_to: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();
        set_space_identity(&pool, b, &space, "评审B", Uuid::new_v4())
            .await
            .unwrap();
        let missing = post_to_space(
            &pool,
            PostToSpace {
                caller_id: Some(a),
                space_id: space.clone(),
                content: "找不到".to_string(),
                summary: None,
                to: vec!["小B".to_string()],
                in_reply_to: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(missing.code, "not_found");
        post_to_space(
            &pool,
            PostToSpace {
                caller_id: Some(a),
                space_id: space.clone(),
                content: "新称呼".to_string(),
                summary: None,
                to: vec!["评审B".to_string()],
                in_reply_to: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();
        let old: String = sqlx::query_scalar(
            "SELECT envelope_json FROM collaboration_space_messages WHERE id = ?",
        )
        .bind(first.message_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(old.contains("小B"));
        assert!(!old.contains("评审B"));
    }

    #[tokio::test]
    async fn list_messages_since_seq() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        let space = space_of(&pool, a).await;
        add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        let first = post_to_space(
            &pool,
            PostToSpace {
                caller_id: Some(a),
                space_id: space.clone(),
                content: "一".to_string(),
                summary: None,
                to: vec!["小B".to_string()],
                in_reply_to: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();
        post_to_space(
            &pool,
            PostToSpace {
                caller_id: Some(a),
                space_id: space.clone(),
                content: "二".to_string(),
                summary: None,
                to: vec!["小B".to_string()],
                in_reply_to: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();
        let later =
            list_space_messages(&pool, &space, Some(first.seq), None, MessageAudience::User)
                .await
                .unwrap();
        assert_eq!(later.len(), 1);
        assert!(later[0].seq > first.seq);
        assert!(
            later[0].envelope["content"]
                .as_str()
                .unwrap()
                .contains('二')
        );
    }

    #[tokio::test]
    async fn set_space_identity_replays_and_rejects_non_member_or_conflict() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let other_workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let outsider = Uuid::new_v4();
        let foreign = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        create_session(&pool, outsider, workspace, Some("路人")).await;
        create_session(&pool, foreign, other_workspace, Some("外区")).await;
        let space = space_of(&pool, a).await;
        add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();

        let rename_op = Uuid::new_v4();
        let first = set_space_identity(&pool, b, &space, "审校B", rename_op)
            .await
            .unwrap();
        assert_eq!(first.nickname, "审校B");

        let replay = set_space_identity(&pool, b, &space, "审校B", rename_op)
            .await
            .unwrap();
        assert_eq!(replay, first);

        let mismatch = set_space_identity(&pool, b, &space, "别的名字", rename_op)
            .await
            .unwrap_err();
        assert_eq!(mismatch.code, "conversation_control_failed");

        let taken = set_space_identity(&pool, b, &space, "小A", Uuid::new_v4())
            .await
            .unwrap_err();
        assert_eq!(taken.code, "nickname_taken");

        let outside = set_space_identity(&pool, outsider, &space, "路人甲", Uuid::new_v4())
            .await
            .unwrap_err();
        assert_eq!(outside.code, "not_found");

        let cross_workspace = set_space_identity(&pool, foreign, &space, "外区甲", Uuid::new_v4())
            .await
            .unwrap_err();
        assert_eq!(cross_workspace.code, "not_found");
    }

    #[tokio::test]
    async fn space_delivery_strips_mention_for_display_and_embeds_protocol_context() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        let space = space_of(&pool, a).await;
        post_to_space(
            &pool,
            PostToSpace {
                caller_id: None,
                space_id: space.clone(),
                content: " @小A 请你分析我当前项目的性能".to_string(),
                summary: None,
                to: vec!["小A".to_string()],
                in_reply_to: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();

        let raw_payload: String = sqlx::query_scalar(
            "SELECT payload_json FROM conversation_inputs WHERE conversation_id = ?",
        )
        .bind(a)
        .fetch_one(&pool)
        .await
        .unwrap();
        let payload: Value = serde_json::from_str(&raw_payload).unwrap();
        assert_eq!(
            payload["displayText"].as_str(),
            Some("请你分析我当前项目的性能")
        );
        let text = payload["text"].as_str().unwrap();
        assert!(text.contains("[协作空间消息]"));
        assert!(text.contains("评审工作"));
        assert!(text.contains(&space));
        assert!(text.contains("User（用户）"));
        assert_eq!(text.matches("请你分析我当前项目的性能").count(), 1);

        let context = persona_prompt_text(&pool, a).await.unwrap().unwrap();
        assert!(context.contains("[协作空间成员身份]"));
        assert!(context.contains("小A"));
        assert!(context.contains(&space));

        // Member can reply to @User in the space and query spaces & members
        let reply = post_to_space(
            &pool,
            PostToSpace {
                caller_id: Some(a),
                space_id: space.clone(),
                content: "@User 性能分析已完成".to_string(),
                summary: None,
                to: vec!["User".to_string()],
                in_reply_to: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();
        assert_eq!(reply.seq, 2);
        assert!(reply.receipts.is_empty());

        let spaces_view = list_collaboration_spaces_for_caller(&pool, a)
            .await
            .unwrap();
        assert_eq!(spaces_view["spaces"][0]["space_id"], space);
        assert_eq!(spaces_view["spaces"][0]["is_member"], true);
        assert_eq!(spaces_view["spaces"][0]["my_nickname"], "小A");

        let members_view = list_space_members_detailed(&pool, a, &space).await.unwrap();
        assert_eq!(members_view["my_nickname"], "小A");
        assert_eq!(members_view["members"][0]["nickname"], "小A");
        assert_eq!(members_view["members"][0]["is_self"], true);
    }

    #[tokio::test]
    async fn delayed_space_post_schedules_lists_and_promotes_message() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        let space = space_of(&pool, a).await;
        add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();

        let delayed = post_to_space_delayed_with(
            &pool,
            PostToSpace {
                caller_id: Some(a),
                space_id: space.clone(),
                content: "@小B 稍后同步检查结果".to_string(),
                summary: None,
                to: vec!["小B".to_string()],
                in_reply_to: None,
                operation_id: Uuid::new_v4(),
            },
            Some(120),
            &DeliveryContext::default(),
        )
        .await
        .unwrap();

        assert_eq!(delayed.seq, 0);
        let listed = list_space_scheduled_messages(&pool, &space).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, delayed.message_id);
        assert_eq!(listed[0].caller_id, Some(a.to_string()));
        assert_eq!(listed[0].nickname, "小A");
        assert_eq!(listed[0].content, "@小B 稍后同步检查结果");

        // Move deliver_at into the past and promote
        sqlx::query("UPDATE conversation_delayed_inputs SET deliver_at = '2000-01-01T00:00:00.000Z' WHERE id = ?")
            .bind(&delayed.message_id)
            .execute(&pool)
            .await
            .unwrap();

        let promoted = promote_due_delayed_inputs(&pool).await.unwrap();
        assert_eq!(promoted, 1);

        let listed_after = list_space_scheduled_messages(&pool, &space).await.unwrap();
        assert!(listed_after.is_empty());

        let messages = list_space_messages(&pool, &space, None, None, MessageAudience::User)
            .await
            .unwrap();
        assert_eq!(messages.len(), 1);
        assert!(
            messages[0].envelope["content"]
                .as_str()
                .unwrap()
                .contains("稍后同步检查结果")
        );
    }

    #[tokio::test]
    async fn delayed_session_input_visible_in_sender_and_recipient_queues_and_convertible() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let sender = Uuid::new_v4();
        let recipient = Uuid::new_v4();
        create_session(&pool, sender, workspace, Some("发送者")).await;
        create_session(&pool, recipient, workspace, Some("接收者")).await;

        let op_id = Uuid::new_v4();
        let receipt = send_session_input(
            &pool,
            SendSessionInput {
                caller_id: sender,
                conversation_id: recipient,
                operation_id: op_id,
                text: "延时会话消息".to_string(),
                policy: CompanionWritePolicy::SameWorkspace,
                steer: false,
                steer_supported: true,
                expected_turn_id: None,
                delay_seconds: Some(300),
                deliver_at: None,
                delay_cap_hours: 24,
            },
        )
        .await
        .unwrap();
        assert_eq!(receipt.delivered, "scheduled");

        let control = crate::ConversationInputControl::new(pool.clone());
        let sender_inputs = control.list(sender).await.unwrap();
        assert_eq!(sender_inputs.len(), 1);
        assert_eq!(
            sender_inputs[0].status,
            crate::ConversationInputStatus::Scheduled
        );
        assert!(sender_inputs[0].deliver_at.is_some());
        assert_eq!(sender_inputs[0].payload.text, "延时会话消息");

        let recipient_inputs = control.list(recipient).await.unwrap();
        assert_eq!(recipient_inputs.len(), 1);
        assert_eq!(
            recipient_inputs[0].status,
            crate::ConversationInputStatus::Scheduled
        );
        assert!(recipient_inputs[0].deliver_at.is_some());
    }

    #[tokio::test]
    async fn space_collection_stores_address_only_for_agents_and_tracks_read_receipts() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        let space = space_of(&pool, a).await;
        add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();

        // Agent cannot pass raw binary base64_data directly
        let forbidden = add_to_space_collection(
            &pool,
            AddSpaceCollectionItem {
                caller_id: Some(a),
                space_id: space.clone(),
                content: None,
                source_path: None,
                base64_data: Some("YWJj".to_string()),
                file_name: Some("raw.bin".to_string()),
                note: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(forbidden.code, "invalid_argument");

        // Agent adds text item to collection
        let added = add_to_space_collection(
            &pool,
            AddSpaceCollectionItem {
                caller_id: Some(a),
                space_id: space.clone(),
                content: Some("# Shared API Contract\nGET /v1/health".to_string()),
                source_path: None,
                base64_data: None,
                file_name: Some("api-contract.md".to_string()),
                note: Some("核心接口契约".to_string()),
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();

        assert_eq!(added.creator_nickname, "小A");
        assert_eq!(added.note, "核心接口契约");
        assert!(added.text_content.is_none());
        let saved_path = std::path::PathBuf::from(&added.file_path);
        assert!(saved_path.exists());
        assert!(is_team_space_collection_file(&saved_path));

        // Member B reads the collection item -> records read receipt, returns address only
        let read_by_b =
            read_space_collection_item(&pool, &space, &added.id, Some(b), MessageAudience::Agent)
                .await
                .unwrap();
        assert!(read_by_b.text_content.is_none());
        assert_eq!(read_by_b.read_receipts.len(), 1);
        assert_eq!(read_by_b.read_receipts[0].reader_nickname, "小B");
        assert_eq!(read_by_b.read_receipts[0].read_count, 1);

        // User audience sees text_content and read receipts
        let user_list = list_space_collection(&pool, &space, None, None, MessageAudience::User)
            .await
            .unwrap();
        assert_eq!(user_list.len(), 1);
        assert_eq!(
            user_list[0].text_content.as_deref(),
            Some("# Shared API Contract\nGET /v1/health")
        );
        assert_eq!(user_list[0].read_receipts.len(), 1);
        assert_eq!(user_list[0].read_receipts[0].reader_nickname, "小B");

        // User can update collection item note
        let updated = update_space_collection_item_note(
            &pool,
            &space,
            &added.id,
            "更新后的备注",
            MessageAudience::User,
        )
        .await
        .unwrap();
        assert_eq!(updated.note, "更新后的备注");

        let _ = std::fs::remove_file(saved_path);
    }
}
