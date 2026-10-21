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

async fn load_session(pool: &SqlitePool, id: Uuid) -> Result<Option<SessionHead>, CollaborationError> {
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
        let owns: Option<i64> = sqlx::query_scalar(
            "SELECT 1 FROM workspaces WHERE id = ? AND project_id = ? LIMIT 1",
        )
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
        let mode_id = self
            .mode_id
            .filter(|mode| !mode.trim().is_empty());
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

pub async fn create_team(pool: &SqlitePool, input: SaveTeam) -> Result<TeamRecord, CollaborationError> {
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

pub async fn update_team(pool: &SqlitePool, id: &str, input: SaveTeam) -> Result<TeamRecord, CollaborationError> {
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

pub async fn create_role(pool: &SqlitePool, input: SaveRole) -> Result<RoleRecord, CollaborationError> {
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
            config_values: serde_json::from_str(&self.config_values_json).unwrap_or_else(|_| json!({})),
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
        if stored.caller_id != input.caller_id.to_string() || stored.request_json != request.to_string()
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
    let agent_id = AgentId::parse(&agent_raw).map_err(|_| {
        CollaborationError::new("not_found", "agent_id is required")
    })?;
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
        if let Err(deny) = admit_collaboration_child(
            depth,
            active,
            input.depth_limit,
            input.max_active_children,
        ) {
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
        .map_err(|error| CollaborationError::new("conversation_control_failed", error.to_string()))?;
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
            Some(team_id) => sqlx::query_scalar::<_, String>(
                "SELECT name FROM collaboration_teams WHERE id = ?",
            )
            .bind(team_id)
            .fetch_optional(pool)
            .await
            .map_err(db)?,
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
    remember_creation_session_controls(
        pool,
        input.operation_id,
        mode_id.as_deref(),
        overrides,
    )
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
    let normalized = serde_json::to_string(&event)
        .map_err(|error| CollaborationError::new("conversation_control_failed", error.to_string()))?;
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
    let prompt: Option<String> = sqlx::query_scalar(
        "SELECT persona_prompt FROM conversation_personas WHERE conversation_id = ?",
    )
    .bind(conversation_id.to_string())
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    Ok(prompt.filter(|value| !value.trim().is_empty()))
}

/// Standing instruction the user already sees as the first host note.
/// Repeated on each agent prompt so a cold session still receives it.
pub fn prefix_persona_prompt(persona: &str, text: &str) -> String {
    let persona = persona.trim();
    if persona.is_empty() {
        return text.to_string();
    }
    let text = text.trim();
    if text.is_empty() {
        return format!("人设\n{persona}");
    }
    format!("人设\n{persona}\n\n{text}")
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
    let target = authorize_write(
        pool,
        input.caller_id,
        input.conversation_id,
        input.policy,
    )
    .await?;
    let cap = bounded_delay_cap_hours(input.delay_cap_hours);
    if let Some(when) = scheduled_deadline(&input, cap)? {
        return schedule_input(pool, &input, &target, when).await;
    }
    deliver_text(
        pool,
        input.conversation_id,
        input.operation_id,
        &input.text,
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
                display_text: None,
                images: Vec::new(),
                mode_override: None,
                config_overrides: Vec::new(),
                workflow_refs: Vec::new(),
                file_refs: Vec::new(),
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
    let outcome = reserve_send_claim_locked(
        &mut conn,
        conversation_id,
        operation_id,
        digest,
        principal,
    )
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

async fn active_turn_id(pool: &SqlitePool, conversation_id: Uuid) -> Result<Option<Uuid>, CollaborationError> {
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
    let principal = serde_json::from_str(&row.principal_json).unwrap_or_else(|_| json!({}));
    let receipt = match deliver_text(
        pool,
        conversation_id,
        operation_id,
        &text,
        &head,
        principal,
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
    Ok(true)
}

async fn mark_delay_failed(pool: &SqlitePool, id: &str, error: &str) -> Result<(), CollaborationError> {
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
        .map_err(|error| CollaborationError::new("conversation_control_failed", error.to_string()));
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
    insert_member(
        pool,
        &space_id,
        Some(caller_id),
        &nickname,
        "agent",
        true,
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
        .map_err(|error| CollaborationError::new("conversation_control_failed", error.to_string()));
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
}

pub async fn list_workspace_conversations(
    pool: &SqlitePool,
    workspace_id: Uuid,
) -> Result<Vec<WorkspaceConversationOption>, CollaborationError> {
    let rows = sqlx::query_as::<_, (Uuid, Option<String>, Option<String>, String, String, i64)>(
        r#"SELECT s.id,
                  s.name,
                  s.agent_id,
                  s.status,
                  s.updated_at,
                  EXISTS (
                    SELECT 1 FROM conversation_turns turn
                    WHERE turn.conversation_id = s.id
                      AND turn.status IN ('pending', 'queued', 'running', 'blocked')
                  ) AS turn_in_flight_flag
           FROM sessions s
           WHERE s.workspace_id = ? AND s.deleted_at IS NULL AND s.status != 'archived'
           ORDER BY s.updated_at DESC
           LIMIT 100"#,
    )
    .bind(workspace_id)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    let persona_rows = sqlx::query_as::<_, (String, Option<String>)>(
        r#"SELECT conversation_id, team_name
           FROM conversation_personas
           WHERE team_name IS NOT NULL AND trim(team_name) != ''"#,
    )
    .fetch_all(pool)
    .await
    .map_err(db)?;
    let teams_by_conversation: std::collections::HashMap<String, String> = persona_rows
        .into_iter()
        .filter_map(|(id, team)| {
            let trimmed = team?.trim().to_string();
            (!trimmed.is_empty()).then_some((id, trimmed))
        })
        .collect();
    Ok(rows
        .into_iter()
        .map(
            |(conversation_id, title, agent_id, status, updated_at, turn_in_flight_flag)| {
                let team_name = teams_by_conversation.get(&conversation_id.to_string()).cloned();
                WorkspaceConversationOption {
                    conversation_id,
                    title: title.filter(|title| !title.trim().is_empty()),
                    agent_id: agent_id.filter(|agent| !agent.trim().is_empty()),
                    status,
                    updated_at,
                    turn_in_flight: turn_in_flight_flag != 0,
                    team_name,
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
    Ok(row.map(|(name, team_name, summary, agent_id)| ConversationPersonaView {
        name,
        team_name: team_name.filter(|value| !value.trim().is_empty()),
        summary: (!summary.trim().is_empty()).then_some(summary),
        agent_name: agent_id,
    }))
}

pub async fn set_conversation_persona_team(
    pool: &SqlitePool,
    conversation_id: Uuid,
    nickname: &str,
    team_id: Option<&str>,
) -> Result<Option<String>, CollaborationError> {
    let target = live_session(load_session(pool, conversation_id).await?)?;
    let team_name = match team_id.map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) => sqlx::query_scalar::<_, String>(
            "SELECT name FROM collaboration_teams WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(db)?,
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
        return Err(CollaborationError::new(
            "not_found",
            "space was not found",
        ));
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
        return decode_replay(accept_space_replay(&stored, Some(&target_space_id), &request)?);
    }
    if nickname_owner(pool, &target_space_id, &nickname).await?.is_some() {
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
        Some(team_id) => sqlx::query_scalar::<_, String>(
            "SELECT name FROM collaboration_teams WHERE id = ?",
        )
        .bind(team_id)
        .fetch_optional(pool)
        .await
        .map_err(db)?,
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
        .map_err(|error| CollaborationError::new("conversation_control_failed", error.to_string()))?;
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
    } else {
        sqlx::query(
            r#"DELETE FROM collaboration_space_members
               WHERE conversation_id = ?
                 AND space_id IN (SELECT id FROM collaboration_spaces WHERE workspace_id = ?)"#,
        )
        .bind(conversation_id.to_string())
        .bind(&to_space.workspace_id)
        .execute(pool)
        .await
        .map_err(db)?;
    }
    let record = if let Ok(existing) = ensure_agent_member(pool, to_space_id, conversation_id).await
    {
        existing
    } else {
        insert_member(
            pool,
            to_space_id,
            Some(conversation_id),
            &desired_nickname,
            "agent",
            true,
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
                if ensure_agent_member(pool, &unassigned_id, conv_id).await.is_err() {
                    let safe_nick = if nickname_owner(pool, &unassigned_id, &nickname)
                        .await?
                        .is_some()
                    {
                        format!("{nickname}-{}", &conv_id.to_string()[..4])
                    } else {
                        nickname
                    };
                    let _ = insert_member(
                        pool,
                        &unassigned_id,
                        Some(conv_id),
                        &safe_nick,
                        "agent",
                        true,
                    )
                    .await;
                }
                if !unassigned_conversation_ids.contains(&conv_id) {
                    unassigned_conversation_ids.push(conv_id);
                }
            }
        }

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
        if !archived_conversation_ids.contains(&target.conversation_id) {
            archived_conversation_ids.push(target.conversation_id);
        }
    }

    let result = BatchDeleteResult {
        deleted_space_ids,
        archived_conversation_ids,
        unassigned_conversation_ids,
    };
    store_operation(
        pool,
        &operation_id.to_string(),
        None,
        &request,
        &result,
    )
    .await?;
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
    store_operation(pool, &operation_id.to_string(), Some(space_id), &request, &record).await?;
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
    ensure_agent_member(pool, space_id, caller_id).await?;
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
    store_operation(pool, &operation_id.to_string(), Some(space_id), &request, &record).await?;
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
    let member = ensure_agent_member(pool, space_id, caller_id)
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
    sqlx::query("UPDATE collaboration_space_members SET nickname = ? WHERE space_id = ? AND member_id = ?")
        .bind(&nickname)
        .bind(space_id)
        .bind(&member.member_id)
        .execute(pool)
        .await
        .map_err(db)?;
    let mut updated = member;
    updated.nickname = nickname;
    store_operation(pool, &operation_id.to_string(), Some(space_id), &request, &updated).await?;
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
            let member = ensure_agent_member(pool, &input.space_id, caller_id).await?;
            (
                member_actor(&input.space_id, &member.nickname),
                Some(format!("vibex://conversation/{caller_id}")),
                Some(caller_id),
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
        if !same_post_request(pool, &message_id, &input.space_id, &request, &head.envelope_json)
            .await?
        {
            return Err(operation_conflict());
        }
        return deliver_pending(pool, &input.space_id, &message_id, turn_delivery).await;
    }
    let targets = resolve_targets(pool, &input.space_id, sender, &input.to).await?;
    let summary = input
        .summary
        .as_deref()
        .map(str::trim)
        .filter(|summary| !summary.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            content.lines().next().unwrap_or(content).trim().to_string()
        });
    let published = now_stamp();
    let envelope = json!({
        "@context": "https://www.w3.org/ns/activitystreams",
        "type": "Note",
        "id": format!("vibex://space-message/{message_id}"),
        "actor": actor,
        "attributedTo": attributed_to,
        "to": targets.iter().map(|target| member_actor(&input.space_id, &target.nickname)).collect::<Vec<_>>(),
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
               (id, space_id, seq, envelope_json, created_at)
               VALUES (?, ?, ?, ?, ?)"#,
        )
        .bind(&message_id)
        .bind(&input.space_id)
        .bind(seq)
        .bind(envelope.to_string())
        .bind(&published)
        .execute(&mut *conn)
        .await?;
        for target in &targets {
            let target_id = target.conversation_id.expect("agent member has a conversation");
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
        Ok::<i64, sqlx::Error>(seq)
    }
    .await;
    let seq = match inserted {
        Ok(seq) => {
            sqlx::query("COMMIT").execute(&mut *conn).await.map_err(db)?;
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
    let seq: i64 = sqlx::query_scalar(
        "SELECT seq FROM collaboration_space_messages WHERE id = ?",
    )
    .bind(message_id)
    .fetch_one(pool)
    .await
    .map_err(db)?;
    let summary = envelope
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let content = envelope
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let attention = format!("{summary}\n\n{content}");
    let pending = sqlx::query_as::<_, PendingDelivery>(
        r#"SELECT conversation_id, operation_id, input_id, status
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
                input_id: delivery.input_id.as_deref().and_then(|id| Uuid::parse_str(id).ok()),
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
                input_id: None,
                error_code: Some("not_found".to_string()),
            });
            continue;
        }
        match deliver_text(
            pool,
            conversation_id,
            operation_id,
            &attention,
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
                sqlx::query(
                    r#"UPDATE collaboration_space_deliveries
                       SET input_id = ?, status = ?
                       WHERE space_message_id = ? AND conversation_id = ?"#,
                )
                .bind(receipt.input_id.map(|id| id.to_string()))
                .bind(&receipt.delivered)
                .bind(message_id)
                .bind(conversation_id.to_string())
                .execute(pool)
                .await
                .map_err(db)?;
                receipts.push(DeliveryReceipt {
                    conversation_id,
                    nickname,
                    delivered: receipt.delivered,
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

#[derive(Debug, Clone, Serialize)]
pub struct SpaceMessage {
    pub seq: i64,
    pub envelope: Value,
}

pub async fn list_space_messages(
    pool: &SqlitePool,
    space_id: &str,
    since_seq: Option<i64>,
    limit: Option<i64>,
    audience: MessageAudience,
) -> Result<Vec<SpaceMessage>, CollaborationError> {
    load_space(pool, space_id).await?;
    let limit = limit.unwrap_or(SPACE_LIST_DEFAULT).clamp(1, SPACE_LIST_HARD_CAP);
    let since = since_seq.unwrap_or(0);
    let rows = sqlx::query_as::<_, (i64, String)>(
        r#"SELECT seq, envelope_json FROM collaboration_space_messages
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
    Ok(rows
        .into_iter()
        .filter_map(|(seq, raw)| {
            let mut envelope: Value = serde_json::from_str(&raw).ok()?;
            if audience == MessageAudience::Agent {
                if let Some(to) = envelope.get_mut("to").and_then(Value::as_array_mut) {
                    to.retain(|item| item.as_str() != Some(user_uri.as_str()));
                }
                if envelope.get("actor").and_then(Value::as_str) == Some(user_uri.as_str()) {
                    envelope["actor"] = json!("user");
                }
            }
            Some(SpaceMessage { seq, envelope })
        })
        .collect())
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

async fn resolve_targets(
    pool: &SqlitePool,
    space_id: &str,
    sender: Option<Uuid>,
    nicknames: &[String],
) -> Result<Vec<ResolvedTarget>, CollaborationError> {
    let members = list_space_members(pool, space_id, MessageAudience::Agent).await?;
    if nicknames.is_empty() {
        return Ok(members
            .into_iter()
            .filter_map(|member| {
                let conversation_id = member.conversation_id.and_then(|id| Uuid::parse_str(&id).ok());
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
    for nickname in nicknames {
        let nickname = nickname.trim();
        let Some(member) = members.iter().find(|member| member.nickname == nickname) else {
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
        targets.push(ResolvedTarget {
            conversation_id,
            nickname: member.nickname.clone(),
        });
    }
    Ok(targets)
}

async fn insert_member(
    pool: &SqlitePool,
    space_id: &str,
    conversation_id: Option<Uuid>,
    nickname: &str,
    kind: &str,
    visible: bool,
) -> Result<MemberRecord, CollaborationError> {
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
        let owns: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM workspaces WHERE id = ? LIMIT 1")
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
        if stored.space_id.as_deref().is_some_and(|stored_space| stored_space != space_id) {
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
    if envelope.get("content").and_then(Value::as_str) != request.get("content").and_then(Value::as_str)
    {
        return false;
    }
    if envelope.get("actor").and_then(Value::as_str) != request.get("actor").and_then(Value::as_str) {
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
    let raw: String = sqlx::query_scalar(
        "SELECT envelope_json FROM collaboration_space_messages WHERE id = ?",
    )
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
    serde_json::from_value(value).map_err(|error| {
        CollaborationError::new("conversation_control_failed", error.to_string())
    })
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
            sqlx::query("COMMIT").execute(&mut *conn).await.map_err(db)?;
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
        let call_id: Option<String> = sqlx::query_scalar(
            "SELECT delegation_call_id FROM sessions WHERE id = ?",
        )
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
        let delegated_call: Option<String> = sqlx::query_scalar(
            "SELECT delegation_call_id FROM sessions WHERE id = ?",
        )
        .bind(delegated)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(parent_exit_cancels_child(delegated_call.as_deref()));
    }

    fn spawned_from(caller: Uuid, operation_id: Uuid, role_id: Option<String>) -> CreateSpawnedConversation {
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
        let again = create_spawned_conversation(
            &pool,
            spawned_from(caller, operation_id, Some(role.id)),
        )
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
        let receipt = send_session_input(&pool, send_for(caller, sibling, CompanionWritePolicy::SameWorkspace))
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
        let status: String = sqlx::query_scalar(
            "SELECT status FROM conversation_turns WHERE conversation_id = ?",
        )
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
        let columns: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('conversation_delayed_inputs')")
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
        let recipients: Vec<Uuid> = posted.receipts.iter().map(|receipt| receipt.conversation_id).collect();
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
        let agent_messages =
            list_space_messages(&pool, &space, None, None, MessageAudience::Agent)
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
        let status: String = sqlx::query_scalar(
            "SELECT status FROM conversation_turns WHERE conversation_id = ?",
        )
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
        let later = list_space_messages(
            &pool,
            &space,
            Some(first.seq),
            None,
            MessageAudience::User,
        )
        .await
        .unwrap();
        assert_eq!(later.len(), 1);
        assert!(later[0].seq > first.seq);
        assert!(later[0].envelope["content"].as_str().unwrap().contains('二'));
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
}
