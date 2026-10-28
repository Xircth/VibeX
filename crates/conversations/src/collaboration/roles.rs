use agents::{
    AgentId, AgentSessionConfigOverride, ConversationEvent, ConversationRelationKind,
    ConversationRelationVisibility,
};
use chrono::{Duration, Utc};
use db::models::{
    collaboration_identity::{self as identity, IdentityError},
    conversation_event::AppendConversationEvent,
    session::{CreateSession, Session},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

use super::*;
use crate::{
    ConversationEventAppender, ConversationRelationControl, CreateConversationRelation,
    remember_creation_session_controls, resolve_referenced_session, session_info_value,
};

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
pub(crate) struct ListRow {
    pub(crate) conversation_id: Uuid,
    pub(crate) title: Option<String>,
    pub(crate) agent_id: Option<String>,
    pub(crate) status: String,
    pub(crate) updated_at: String,
    pub(crate) parent_id: Option<Uuid>,
    pub(crate) delegation_call_id: Option<String>,
    pub(crate) workspace_id: Uuid,
    pub(crate) turn_in_flight_flag: i64,
    pub(crate) mode_id: Option<String>,
    pub(crate) config_values_json: Option<String>,
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

pub(crate) async fn read_session_info(
    pool: &SqlitePool,
    conversation_id: &str,
    max_messages: u32,
) -> Value {
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
    sqlx::query("UPDATE collaboration_members SET role_id = NULL WHERE role_id = ?")
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
pub(crate) struct RoleRow {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) team_id: Option<String>,
    pub(crate) summary: String,
    pub(crate) persona_prompt: String,
    pub(crate) agent_id: String,
    pub(crate) mode_id: Option<String>,
    pub(crate) config_values_json: String,
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
    #[serde(skip_serializing_if = "super::is_false")]
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
        let request_json = request.to_string();
        if stored.caller_id != input.caller_id.to_string() || stored.request_json != request_json {
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
            && existing_name != expected
        {
            return Err(operation_conflict());
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

pub(crate) fn spawn_request(input: &CreateSpawnedConversation) -> Value {
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

pub(crate) struct StoredCreateOperation {
    pub(crate) caller_id: String,
    pub(crate) request_json: String,
}

pub(crate) async fn load_create_operation(
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

pub(crate) async fn store_create_operation(
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

pub(crate) async fn load_role(
    pool: &SqlitePool,
    id: &str,
) -> Result<RoleRecord, CollaborationError> {
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

pub(crate) async fn append_persona_notice(
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
    persona_prompt_text_for_turn(pool, conversation_id, None).await
}

/// Persona + member context for a turn whose prompt is `query` (used to
/// pick relevant long-term memory).
pub async fn persona_prompt_text_for_turn(
    pool: &SqlitePool,
    conversation_id: Uuid,
    query: Option<&str>,
) -> Result<Option<String>, CollaborationError> {
    let prompt: Option<String> = sqlx::query_scalar::<_, String>(
        "SELECT persona_prompt FROM conversation_personas WHERE conversation_id = ?",
    )
    .bind(conversation_id.to_string())
    .fetch_optional(pool)
    .await
    .map_err(db)?
    .filter(|value: &String| !value.trim().is_empty());
    let space_context = member_space_context_text_for(pool, conversation_id, query).await?;
    match (prompt, space_context) {
        (Some(persona), Some(context)) => Ok(Some(format!("{}\n\n{}", persona.trim(), context))),
        (Some(persona), None) => Ok(Some(persona)),
        (None, Some(context)) => Ok(Some(context)),
        (None, None) => Ok(None),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpaceRecord {
    pub space_id: String,
    pub name: String,
    pub workspace_id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lead_member_id: Option<String>,
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
    let is_collab_bot = identity::binding_of_conversation(pool, caller_id)
        .await
        .map_err(db)?
        .is_some()
        || sqlx::query_scalar::<_, i64>(
            "SELECT 1 FROM collaboration_space_members WHERE conversation_id = ? AND kind = 'agent' LIMIT 1",
        )
        .bind(caller_id.to_string())
        .fetch_optional(pool)
        .await
        .map_err(db)?
        .is_some();
    let space_id = operation_id.to_string();
    let stamp = now_stamp();
    let mut conn = pool.acquire().await.map_err(db)?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    let create_outcome = async {
        sqlx::query(
            r#"INSERT INTO collaboration_spaces
               (id, workspace_id, name, created_by_conversation_id, created_at)
               VALUES (?, ?, ?, ?, ?)"#,
        )
        .bind(&space_id)
        .bind(caller.workspace_id.to_string())
        .bind(&name)
        .bind(caller_id.to_string())
        .bind(&stamp)
        .execute(&mut *conn)
        .await?;
        append_space_event_tx(
            &mut conn,
            &space_id,
            "space",
            None,
            &json!({ "action": "created", "name": name }),
            &stamp,
        )
        .await?;
        Ok::<(), CollaborationError>(())
    }
    .await;
    finish_tx(&mut conn, create_outcome).await?;
    drop(conn);
    if is_collab_bot {
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
    }
    let record = SpaceRecord {
        space_id,
        name,
        workspace_id: caller.workspace_id,
        lead_member_id: None,
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
    let stamp = now_stamp();
    let mut conn = pool.acquire().await.map_err(db)?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    let create_outcome = async {
        sqlx::query(
            r#"INSERT INTO collaboration_spaces
               (id, workspace_id, name, created_by_conversation_id, created_at)
               VALUES (?, ?, ?, NULL, ?)"#,
        )
        .bind(&space_id)
        .bind(workspace_id.to_string())
        .bind(&name)
        .bind(&stamp)
        .execute(&mut *conn)
        .await?;
        append_space_event_tx(
            &mut conn,
            &space_id,
            "space",
            None,
            &json!({ "action": "created", "name": name }),
            &stamp,
        )
        .await?;
        Ok::<(), CollaborationError>(())
    }
    .await;
    finish_tx(&mut conn, create_outcome).await?;
    drop(conn);
    let record = SpaceRecord {
        space_id,
        name,
        workspace_id,
        lead_member_id: None,
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
    let name = require_name(name)?;
    let stamp = now_stamp();
    let mut conn = pool.acquire().await.map_err(db)?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    let outcome = async {
        let updated = sqlx::query(
            r#"UPDATE collaboration_spaces
               SET name = ?
               WHERE id = ?"#,
        )
        .bind(&name)
        .bind(space_id)
        .execute(&mut *conn)
        .await?;
        if updated.rows_affected() == 0 {
            return Err(CollaborationError::new("not_found", "space was not found"));
        }
        append_space_event_tx(
            &mut conn,
            space_id,
            "space",
            None,
            &json!({ "action": "renamed", "name": name }),
            &stamp,
        )
        .await?;
        Ok(())
    }
    .await;
    finish_tx(&mut conn, outcome).await?;
    drop(conn);
    load_space_record(pool, space_id).await
}

/// Set or clear the optional group lead (`lead_member_id`). Empty clears it.
pub async fn set_space_lead(
    pool: &SqlitePool,
    space_id: &str,
    lead_member_id: Option<&str>,
) -> Result<SpaceRecord, CollaborationError> {
    load_space(pool, space_id).await?;
    let lead = lead_member_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string);
    if let Some(lead_id) = lead.as_deref() {
        let kind: Option<String> = sqlx::query_scalar(
            r#"SELECT kind FROM collaboration_space_members
               WHERE space_id = ? AND member_id = ?"#,
        )
        .bind(space_id)
        .bind(lead_id)
        .fetch_optional(pool)
        .await
        .map_err(db)?;
        if kind.as_deref() != Some("agent") {
            return Err(CollaborationError::new(
                "not_found",
                "lead member was not found in this space",
            ));
        }
    }
    let stamp = now_stamp();
    let mut conn = pool.acquire().await.map_err(db)?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    let outcome = async {
        sqlx::query(
            r#"UPDATE collaboration_spaces
               SET lead_member_id = ?
               WHERE id = ?"#,
        )
        .bind(lead.as_deref())
        .bind(space_id)
        .execute(&mut *conn)
        .await?;
        append_space_event_tx(
            &mut conn,
            space_id,
            "roster",
            None,
            &json!({ "action": "lead_changed", "lead_member_id": lead }),
            &stamp,
        )
        .await?;
        Ok(())
    }
    .await;
    finish_tx(&mut conn, outcome).await?;
    drop(conn);
    load_space_record(pool, space_id).await
}

pub(crate) async fn load_space_record(
    pool: &SqlitePool,
    space_id: &str,
) -> Result<SpaceRecord, CollaborationError> {
    let row: Option<(String, String, Option<String>)> = sqlx::query_as(
        r#"SELECT name, workspace_id, lead_member_id
           FROM collaboration_spaces WHERE id = ?"#,
    )
    .bind(space_id)
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    let Some((name, workspace_id, lead_member_id)) = row else {
        return Err(CollaborationError::new("not_found", "space was not found"));
    };
    let workspace_id = Uuid::parse_str(&workspace_id)
        .map_err(|_| CollaborationError::new("not_found", "space was not found"))?;
    Ok(SpaceRecord {
        space_id: space_id.to_string(),
        name,
        workspace_id,
        lead_member_id: lead_member_id.filter(|id| !id.trim().is_empty()),
    })
}

pub async fn list_workspace_spaces(
    pool: &SqlitePool,
    workspace_id: Uuid,
) -> Result<Vec<SpaceRecord>, CollaborationError> {
    let rows = sqlx::query_as::<_, (String, String, Option<String>)>(
        r#"SELECT id, name, lead_member_id
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
        .map(|(space_id, name, lead_member_id)| SpaceRecord {
            space_id,
            name,
            workspace_id,
            lead_member_id: lead_member_id.filter(|id| !id.trim().is_empty()),
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub generation: Option<i64>,
}

pub fn space_tracks_events(space_id: &str) -> bool {
    let trimmed = space_id.trim();
    !trimmed.is_empty()
        && parse_unassigned_space_id(trimmed).is_none()
        && !trimmed.starts_with("session:")
}

pub(crate) async fn append_space_event_tx(
    conn: &mut sqlx::SqliteConnection,
    space_id: &str,
    kind: &str,
    message_id: Option<&str>,
    payload: &Value,
    created_at: &str,
) -> Result<Option<i64>, sqlx::Error> {
    let trimmed = space_id.trim();
    if !space_tracks_events(trimmed) {
        return Ok(None);
    }
    let seq: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM collaboration_space_events WHERE space_id = ?",
    )
    .bind(trimmed)
    .fetch_one(&mut *conn)
    .await?;
    sqlx::query(
        r#"INSERT INTO collaboration_space_events
           (space_id, seq, kind, message_id, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)"#,
    )
    .bind(trimmed)
    .bind(seq)
    .bind(kind)
    .bind(message_id)
    .bind(payload.to_string())
    .bind(created_at)
    .execute(&mut *conn)
    .await?;
    Ok(Some(seq))
}

pub(crate) async fn append_space_event(
    pool: &SqlitePool,
    space_id: &str,
    kind: &str,
    message_id: Option<&str>,
    payload: &Value,
) -> Result<Option<i64>, CollaborationError> {
    if !space_tracks_events(space_id) {
        return Ok(None);
    }
    let stamp = now_stamp();
    let mut conn = pool.acquire().await.map_err(db)?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    let outcome = append_space_event_tx(&mut conn, space_id, kind, message_id, payload, &stamp)
        .await
        .map_err(db);
    finish_tx(&mut conn, outcome).await
}

pub(crate) use append_space_event as append_space_event_pool;

pub(crate) async fn load_space_generation_tx(
    conn: &mut sqlx::SqliteConnection,
    space_id: &str,
) -> Result<i64, sqlx::Error> {
    let trimmed = space_id.trim();
    if trimmed.starts_with(identity::DIRECT_PREFIX) {
        let generation: Option<i64> =
            sqlx::query_scalar("SELECT generation FROM collaboration_threads WHERE id = ?")
                .bind(trimmed)
                .fetch_optional(&mut *conn)
                .await?;
        Ok(generation.unwrap_or(1).max(1))
    } else {
        let generation: Option<i64> =
            sqlx::query_scalar("SELECT generation FROM collaboration_spaces WHERE id = ?")
                .bind(trimmed)
                .fetch_optional(&mut *conn)
                .await?;
        Ok(generation.unwrap_or(1).max(1))
    }
}

pub async fn load_space_generation(
    pool: &SqlitePool,
    space_id: &str,
) -> Result<i64, CollaborationError> {
    let mut conn = pool.acquire().await.map_err(db)?;
    load_space_generation_tx(&mut conn, space_id)
        .await
        .map_err(db)
}

pub(crate) async fn bump_space_generation_tx(
    conn: &mut sqlx::SqliteConnection,
    space_id: &str,
) -> Result<i64, sqlx::Error> {
    let trimmed = space_id.trim();
    if trimmed.starts_with(identity::DIRECT_PREFIX) {
        sqlx::query(
            "UPDATE collaboration_threads SET generation = COALESCE(generation, 1) + 1 WHERE id = ?",
        )
        .bind(trimmed)
        .execute(&mut *conn)
        .await?;
    } else {
        sqlx::query(
            "UPDATE collaboration_spaces SET generation = COALESCE(generation, 1) + 1 WHERE id = ?",
        )
        .bind(trimmed)
        .execute(&mut *conn)
        .await?;
    }
    load_space_generation_tx(conn, trimmed).await
}

pub async fn bump_space_generation(
    pool: &SqlitePool,
    space_id: &str,
) -> Result<i64, CollaborationError> {
    let mut conn = pool.acquire().await.map_err(db)?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    let outcome = bump_space_generation_tx(&mut conn, space_id)
        .await
        .map_err(db);
    finish_tx(&mut conn, outcome).await
}

pub async fn restore_space_from_archive(
    pool: &SqlitePool,
    space_id: &str,
) -> Result<i64, CollaborationError> {
    let stamp = now_stamp();
    let mut conn = pool.acquire().await.map_err(db)?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    let outcome = async {
        let generation = bump_space_generation_tx(&mut conn, space_id).await?;
        append_space_event_tx(
            &mut conn,
            space_id,
            "space",
            None,
            &json!({ "action": "restored", "generation": generation }),
            &stamp,
        )
        .await?;
        Ok(generation)
    }
    .await;
    finish_tx(&mut conn, outcome).await
}

pub async fn latest_space_changed_event(
    pool: &SqlitePool,
    workspace_id: Uuid,
    space_id: &str,
    member_id: Option<String>,
) -> CollaborationSpaceChangedEvent {
    let trimmed = space_id.trim();
    if !space_tracks_events(trimmed) {
        return CollaborationSpaceChangedEvent {
            workspace_id,
            space_id: space_id.to_string(),
            seq: None,
            member_id,
            kind: None,
            generation: None,
        };
    }
    let latest: Option<(i64, String)> = sqlx::query_as(
        r#"SELECT seq, kind
           FROM collaboration_space_events
           WHERE space_id = ?
           ORDER BY seq DESC
           LIMIT 1"#,
    )
    .bind(trimmed)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    let generation = load_space_generation(pool, trimmed).await.unwrap_or(1);
    let (seq, kind) = match latest {
        Some((seq, kind)) => (Some(seq), Some(kind)),
        None => (Some(0), None),
    };
    CollaborationSpaceChangedEvent {
        workspace_id,
        space_id: space_id.to_string(),
        seq,
        member_id,
        kind,
        generation: Some(generation),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceEventRecord {
    pub space_id: String,
    pub seq: i64,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    pub payload: Value,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceEventList {
    pub space_id: String,
    pub generation: i64,
    pub events: Vec<SpaceEventRecord>,
    pub next_seq: i64,
    #[serde(default, skip_serializing_if = "super::is_false")]
    pub reset: bool,
}

pub async fn list_space_events(
    pool: &SqlitePool,
    space_id: &str,
    caller_id: Option<Uuid>,
    after_seq: Option<i64>,
    limit: Option<i64>,
) -> Result<SpaceEventList, CollaborationError> {
    let space_id = space_id.trim();
    if space_id.is_empty() || !space_tracks_events(space_id) {
        return Err(CollaborationError::new("not_found", "space was not found"));
    }
    if space_id.starts_with(identity::DIRECT_PREFIX) {
        load_space_or_unassigned(pool, space_id).await?;
        if let Some(caller_id) = caller_id
            && direct_thread_caller_seat(pool, space_id, caller_id)
                .await?
                .is_none()
        {
            return Err(CollaborationError::new(
                "not_a_member",
                "caller is not a member of this space",
            ));
        }
    } else {
        load_space(pool, space_id).await?;
        if let Some(caller_id) = caller_id {
            let _ = caller_seat(pool, space_id, caller_id).await?;
        }
    }

    let limit = limit.unwrap_or(200).clamp(1, 1000);
    let (min_seq, max_seq): (Option<i64>, Option<i64>) = sqlx::query_as(
        "SELECT MIN(seq), MAX(seq) FROM collaboration_space_events WHERE space_id = ?",
    )
    .bind(space_id)
    .fetch_one(pool)
    .await
    .map_err(db)?;

    if let Some(after) = after_seq {
        let pruned = min_seq.is_some_and(|min| min > 1 && after < min)
            || (max_seq.is_none() && after > 0);
        if pruned {
            let generation = bump_space_generation(pool, space_id).await?;
            return Ok(SpaceEventList {
                space_id: space_id.to_string(),
                generation,
                events: Vec::new(),
                next_seq: max_seq.unwrap_or(0),
                reset: true,
            });
        }
        let generation = load_space_generation(pool, space_id).await?;
        let rows = sqlx::query_as::<_, (i64, String, Option<String>, String, String)>(
            r#"SELECT seq, kind, message_id, payload_json, created_at
               FROM collaboration_space_events
               WHERE space_id = ? AND seq > ?
               ORDER BY seq ASC
               LIMIT ?"#,
        )
        .bind(space_id)
        .bind(after)
        .bind(limit)
        .fetch_all(pool)
        .await
        .map_err(db)?;
        let events: Vec<SpaceEventRecord> = rows
            .into_iter()
            .map(|(seq, kind, message_id, payload_json, created_at)| SpaceEventRecord {
                space_id: space_id.to_string(),
                seq,
                kind,
                message_id,
                payload: serde_json::from_str(&payload_json).unwrap_or_else(|_| json!({})),
                created_at,
            })
            .collect();
        let next_seq = events.last().map(|e| e.seq).unwrap_or(after);
        return Ok(SpaceEventList {
            space_id: space_id.to_string(),
            generation,
            events,
            next_seq,
            reset: false,
        });
    }

    let generation = load_space_generation(pool, space_id).await?;
    let mut rows = sqlx::query_as::<_, (i64, String, Option<String>, String, String)>(
        r#"SELECT seq, kind, message_id, payload_json, created_at
           FROM collaboration_space_events
           WHERE space_id = ?
           ORDER BY seq DESC
           LIMIT ?"#,
    )
    .bind(space_id)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    rows.reverse();
    let events: Vec<SpaceEventRecord> = rows
        .into_iter()
        .map(|(seq, kind, message_id, payload_json, created_at)| SpaceEventRecord {
            space_id: space_id.to_string(),
            seq,
            kind,
            message_id,
            payload: serde_json::from_str(&payload_json).unwrap_or_else(|_| json!({})),
            created_at,
        })
        .collect();
    let next_seq = events
        .last()
        .map(|e| e.seq)
        .unwrap_or_else(|| max_seq.unwrap_or(0));
    Ok(SpaceEventList {
        space_id: space_id.to_string(),
        generation,
        events,
        next_seq,
        reset: false,
    })
}

pub fn space_event_retention_days() -> i64 {
    env_i64("VIBEX_COLLAB_EVENT_RETENTION_DAYS", 7).max(1)
}

pub async fn sweep_expired_space_events(pool: &SqlitePool) -> Result<u32, CollaborationError> {
    let cutoff = stamp(Utc::now() - Duration::days(space_event_retention_days()));
    sweep_expired_space_events_before(pool, &cutoff).await
}

pub async fn sweep_expired_space_events_before(
    pool: &SqlitePool,
    cutoff: &str,
) -> Result<u32, CollaborationError> {
    let result = sqlx::query("DELETE FROM collaboration_space_events WHERE created_at < ?")
        .bind(cutoff)
        .execute(pool)
        .await
        .map_err(db)?;
    Ok(u32::try_from(result.rows_affected()).unwrap_or(u32::MAX))
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
                name: None,
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
    // The member keeps the config it was created with; every later session
    // (new direct or group thread) is spun up from it.
    let member_id = identity::ensure_member_for_conversation(pool, session_id, Some(&nickname))
        .await
        .map_err(identity_error)?;
    if let Some(cfg) = input.config_values.as_ref() {
        let avatar = cfg
            .get("avatar")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty());
        let color = cfg
            .get("color")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty());
        if avatar.is_some() || color.is_some() {
            sqlx::query(
                "UPDATE collaboration_members SET avatar = COALESCE(?, avatar), color = COALESCE(?, color) WHERE id = ?",
            )
            .bind(avatar)
            .bind(color)
            .bind(&member_id)
            .execute(pool)
            .await
            .map_err(db)?;
        }
    }
    write_member_session_config(
        pool,
        &member_id,
        &MemberSessionConfig {
            agent_id: Some(agent_raw.clone()),
            mode_id: mode_id.clone(),
            config_values: config_values.clone(),
            persona_prompt: Some(persona_prompt.clone()).filter(|p| !p.trim().is_empty()),
        },
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
    if from_space_id == to_space_id
        && let Ok(existing) = ensure_agent_member(pool, to_space_id, conversation_id).await
    {
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
    let pre_binding = identity::binding_of_conversation(pool, conversation_id)
        .await
        .map_err(db)?;
    {
        let stamp = now_stamp();
        let mut conn = pool.acquire().await.map_err(db)?;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *conn)
            .await
            .map_err(db)?;
        let del_outcome = async {
            let deleted = sqlx::query(
                "DELETE FROM collaboration_space_members WHERE space_id = ? AND conversation_id = ?",
            )
            .bind(from_space_id)
            .bind(conversation_id.to_string())
            .execute(&mut *conn)
            .await?;
            if deleted.rows_affected() > 0 {
                append_space_event_tx(
                    &mut conn,
                    from_space_id,
                    "roster",
                    None,
                    &json!({
                        "action": "member_removed",
                        "conversation_id": conversation_id,
                    }),
                    &stamp,
                )
                .await?;
            }
            Ok::<(), CollaborationError>(())
        }
        .await;
        finish_tx(&mut conn, del_outcome).await?;
    }
    let record = if parse_unassigned_space_id(to_space_id).is_some() {
        identity::unbind_conversation(pool, conversation_id)
            .await
            .map_err(db)?;
        let identity_member_id = match pre_binding.as_ref() {
            Some(b) => Some(b.member_id.clone()),
            None => {
                let candidate = identity::member_id_for_conversation(conversation_id);
                identity::load_member(pool, &candidate)
                    .await
                    .map_err(db)?
                    .map(|m| m.id)
            }
        };
        let mut active_dm_conv: Option<Uuid> = None;
        if let Some(ref mid) = identity_member_id {
            let direct_tid = identity::direct_thread_id(mid);
            let dm_conv_raw: Option<String> = sqlx::query_scalar(
                r#"SELECT tm.conversation_id
                   FROM collaboration_thread_members tm
                   JOIN sessions s ON lower(hex(s.id)) = replace(tm.conversation_id, '-', '')
                   WHERE tm.thread_id = ? AND tm.member_id = ? AND tm.status = 'active'
                     AND s.deleted_at IS NULL AND s.status != 'archived'
                   LIMIT 1"#,
            )
            .bind(&direct_tid)
            .bind(mid)
            .fetch_optional(pool)
            .await
            .map_err(db)?;
            active_dm_conv = dm_conv_raw
                .and_then(|raw| Uuid::parse_str(&raw).ok())
                .filter(|cid| *cid != conversation_id);
        }
        if let Some(dm_conv) = active_dm_conv {
            sqlx::query(
                "UPDATE sessions SET status = 'archived', updated_at = datetime('now', 'subsec') WHERE id = ? AND workspace_id = ?",
            )
            .bind(conversation_id)
            .bind(target.workspace_id)
            .execute(pool)
            .await
            .map_err(db)?;
            if let Ok(existing) = ensure_agent_member(pool, to_space_id, dm_conv).await {
                existing
            } else {
                MemberRecord {
                    member_id: identity_member_id.unwrap_or_else(|| Uuid::new_v4().to_string()),
                    conversation_id: Some(dm_conv.to_string()),
                    nickname: desired_nickname,
                    kind: "agent".to_string(),
                    visible_to_agents: 1,
                }
            }
        } else if let Ok(existing) = ensure_agent_member(pool, to_space_id, conversation_id).await {
            let _ = identity::transfer_conversation(
                pool,
                conversation_id,
                to_space_id,
                Some(&desired_nickname),
            )
            .await;
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
        }
    } else {
        let unassigned = unassigned_space_id(target.workspace_id);
        sqlx::query(
            "DELETE FROM collaboration_space_members WHERE space_id = ? AND conversation_id = ?",
        )
        .bind(&unassigned)
        .bind(conversation_id.to_string())
        .execute(pool)
        .await
        .map_err(db)?;
        if let Ok(existing) = ensure_agent_member(pool, to_space_id, conversation_id).await {
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
        }
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
    let mut archived_conversation_ids = Vec::new();

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
            if stays_in_another_space {
                continue;
            }
            let pre_binding = identity::binding_of_conversation(pool, conv_id)
                .await
                .map_err(db)?;
            let identity_member_id = match pre_binding.as_ref() {
                Some(b) => Some(b.member_id.clone()),
                None => {
                    let candidate = identity::member_id_for_conversation(conv_id);
                    identity::load_member(pool, &candidate)
                        .await
                        .map_err(db)?
                        .map(|m| m.id)
                }
            };
            let mut has_separate_dm = false;
            if let Some(ref mid) = identity_member_id {
                let direct_tid = identity::direct_thread_id(mid);
                let dm_conv_raw: Option<String> = sqlx::query_scalar(
                    r#"SELECT tm.conversation_id
                       FROM collaboration_thread_members tm
                       JOIN sessions s ON lower(hex(s.id)) = replace(tm.conversation_id, '-', '')
                       WHERE tm.thread_id = ? AND tm.member_id = ? AND tm.status = 'active'
                         AND s.deleted_at IS NULL AND s.status != 'archived'
                       LIMIT 1"#,
                )
                .bind(&direct_tid)
                .bind(mid)
                .fetch_optional(pool)
                .await
                .map_err(db)?;
                if let Some(dm_conv) = dm_conv_raw.and_then(|raw| Uuid::parse_str(&raw).ok())
                    && dm_conv != conv_id
                {
                    has_separate_dm = true;
                }
            }
            identity::unbind_conversation(pool, conv_id)
                .await
                .map_err(db)?;
            if has_separate_dm {
                sqlx::query(
                    "UPDATE sessions SET status = 'archived', updated_at = datetime('now', 'subsec') WHERE id = ? AND workspace_id = ?",
                )
                .bind(conv_id)
                .bind(workspace_id)
                .execute(pool)
                .await
                .map_err(db)?;
                if !archived_conversation_ids.contains(&conv_id) {
                    archived_conversation_ids.push(conv_id);
                }
            } else {
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

        purge_space_collection(pool, space_id, &workspace_id.to_string()).await?;
        sqlx::query(
            "DELETE FROM collaboration_space_deliveries WHERE space_message_id IN (SELECT id FROM collaboration_space_messages WHERE space_id = ?)",
        )
        .bind(space_id)
        .execute(pool)
        .await
        .map_err(db)?;
        sqlx::query("DELETE FROM collaboration_space_events WHERE space_id = ?")
            .bind(space_id)
            .execute(pool)
            .await
            .map_err(db)?;
        sqlx::query("DELETE FROM collaboration_rounds WHERE space_id = ?")
            .bind(space_id)
            .execute(pool)
            .await
            .map_err(db)?;
        sqlx::query("DELETE FROM collaboration_turns WHERE space_id = ?")
            .bind(space_id)
            .execute(pool)
            .await
            .map_err(db)?;
        sqlx::query("DELETE FROM collaboration_cards WHERE space_id = ?")
            .bind(space_id)
            .execute(pool)
            .await
            .map_err(db)?;
        sqlx::query("DELETE FROM collaboration_handoffs WHERE space_id = ?")
            .bind(space_id)
            .execute(pool)
            .await
            .map_err(db)?;
        sqlx::query("DELETE FROM collaboration_thread_reads WHERE thread_id = ?")
            .bind(space_id)
            .execute(pool)
            .await
            .map_err(db)?;
        sqlx::query("DELETE FROM collaboration_thread_contact_groups WHERE thread_id = ?")
            .bind(space_id)
            .execute(pool)
            .await
            .map_err(db)?;
        sqlx::query("DELETE FROM collaboration_thread_members WHERE thread_id = ?")
            .bind(space_id)
            .execute(pool)
            .await
            .map_err(db)?;
        sqlx::query("DELETE FROM collaboration_threads WHERE id = ?")
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

    for target in &member_targets {
        let is_direct_target = parse_unassigned_space_id(&target.space_id).is_some()
            || target.space_id.starts_with(identity::DIRECT_PREFIX);
        let pre_binding = identity::binding_of_conversation(pool, target.conversation_id)
            .await
            .map_err(db)?;
        let identity_member_id = match pre_binding.as_ref() {
            Some(b) => Some(b.member_id.clone()),
            None => target
                .space_id
                .strip_prefix(identity::DIRECT_PREFIX)
                .map(str::to_string)
                .or_else(|| {
                    let candidate = identity::member_id_for_conversation(target.conversation_id);
                    Some(candidate)
                }),
        };
        let affected_spaces: Vec<String> = sqlx::query_scalar(
            r#"SELECT DISTINCT space_id FROM collaboration_space_members
               WHERE conversation_id = ?
                 AND space_id IN (SELECT id FROM collaboration_spaces WHERE workspace_id = ?)"#,
        )
        .bind(target.conversation_id.to_string())
        .bind(workspace_id.to_string())
        .fetch_all(pool)
        .await
        .map_err(db)?;
        {
            let stamp = now_stamp();
            let mut conn = pool.acquire().await.map_err(db)?;
            sqlx::query("BEGIN IMMEDIATE")
                .execute(&mut *conn)
                .await
                .map_err(db)?;
            let batch_member_outcome = async {
                sqlx::query(
                    "DELETE FROM collaboration_space_members WHERE space_id = ? AND conversation_id = ?",
                )
                .bind(&target.space_id)
                .bind(target.conversation_id.to_string())
                .execute(&mut *conn)
                .await?;
                sqlx::query(
                    "DELETE FROM collaboration_space_members WHERE space_id = ? AND conversation_id = ?",
                )
                .bind(&unassigned_id)
                .bind(target.conversation_id.to_string())
                .execute(&mut *conn)
                .await?;
                sqlx::query(
                    r#"DELETE FROM collaboration_space_members
                       WHERE conversation_id = ?
                         AND space_id IN (SELECT id FROM collaboration_spaces WHERE workspace_id = ?)"#,
                )
                .bind(target.conversation_id.to_string())
                .bind(workspace_id.to_string())
                .execute(&mut *conn)
                .await?;
                for affected_sid in &affected_spaces {
                    if !deleting_space_set.contains(affected_sid) {
                        let generation = bump_space_generation_tx(&mut conn, affected_sid).await?;
                        append_space_event_tx(
                            &mut conn,
                            affected_sid,
                            "roster",
                            None,
                            &json!({
                                "action": "member_removed",
                                "conversation_id": target.conversation_id,
                                "generation": generation,
                            }),
                            &stamp,
                        )
                        .await?;
                    }
                }
                Ok::<(), CollaborationError>(())
            }
            .await;
            finish_tx(&mut conn, batch_member_outcome).await?;
        }
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
        if is_direct_target && let Some(ref mid) = identity_member_id {
            let direct_tid = identity::direct_thread_id(mid);
            let direct_convs: Vec<String> = sqlx::query_scalar(
                "SELECT conversation_id FROM collaboration_thread_members WHERE thread_id = ? OR (member_id = ? AND thread_id LIKE 'direct:%')",
            )
            .bind(&direct_tid)
            .bind(mid)
            .fetch_all(pool)
            .await
            .map_err(db)?;
            for raw_cid in direct_convs {
                if let Ok(cid) = Uuid::parse_str(&raw_cid) {
                    sqlx::query(
                        "DELETE FROM collaboration_space_members WHERE space_id = ? AND conversation_id = ?",
                    )
                    .bind(&unassigned_id)
                    .bind(cid.to_string())
                    .execute(pool)
                    .await
                    .map_err(db)?;
                    sqlx::query(
                        "UPDATE sessions SET status = 'archived', updated_at = datetime('now', 'subsec') WHERE id = ? AND workspace_id = ?",
                    )
                    .bind(cid)
                    .bind(workspace_id)
                    .execute(pool)
                    .await
                    .map_err(db)?;
                    if !archived_conversation_ids.contains(&cid) {
                        archived_conversation_ids.push(cid);
                    }
                }
            }
            purge_space_collection(pool, &direct_tid, &workspace_id.to_string()).await?;
            sqlx::query(
                "DELETE FROM collaboration_space_deliveries WHERE space_message_id IN (SELECT id FROM collaboration_space_messages WHERE space_id = ?)",
            )
            .bind(&direct_tid)
            .execute(pool)
            .await
            .map_err(db)?;
            sqlx::query("DELETE FROM collaboration_space_messages WHERE space_id = ?")
                .bind(&direct_tid)
                .execute(pool)
                .await
                .map_err(db)?;
            sqlx::query("DELETE FROM collaboration_space_events WHERE space_id = ?")
                .bind(&direct_tid)
                .execute(pool)
                .await
                .map_err(db)?;
            sqlx::query("DELETE FROM collaboration_rounds WHERE space_id = ?")
                .bind(&direct_tid)
                .execute(pool)
                .await
                .map_err(db)?;
            sqlx::query("DELETE FROM collaboration_turns WHERE space_id = ?")
                .bind(&direct_tid)
                .execute(pool)
                .await
                .map_err(db)?;
            sqlx::query("DELETE FROM collaboration_thread_reads WHERE thread_id = ?")
                .bind(&direct_tid)
                .execute(pool)
                .await
                .map_err(db)?;
            sqlx::query("DELETE FROM collaboration_thread_contact_groups WHERE thread_id = ?")
                .bind(&direct_tid)
                .execute(pool)
                .await
                .map_err(db)?;
            sqlx::query("DELETE FROM collaboration_thread_members WHERE thread_id = ?")
                .bind(&direct_tid)
                .execute(pool)
                .await
                .map_err(db)?;
            sqlx::query("DELETE FROM collaboration_threads WHERE id = ?")
                .bind(&direct_tid)
                .execute(pool)
                .await
                .map_err(db)?;
            let other_active: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM collaboration_thread_members WHERE member_id = ? AND status = 'active'",
            )
            .bind(mid)
            .fetch_one(pool)
            .await
            .map_err(db)?;
            if other_active == 0 {
                sqlx::query("DELETE FROM collaboration_members WHERE id = ?")
                    .bind(mid)
                    .execute(pool)
                    .await
                    .map_err(db)?;
            }
        }
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
    // Joining a group keeps the member's direct chat (and its session) where
    // it is. The seat gets the member's own per-thread session for this group
    // (created from the member config by resolve_session), never the direct
    // conversation moved over.
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
    let space = load_space(pool, space_id).await?;
    let caller = live_session(load_session(pool, caller_id).await?)?;
    if caller.workspace_id.to_string() != space.workspace_id {
        return Err(CollaborationError::new("not_found", "space was not found"));
    }
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
    if let Some(owner) = nickname_owner(pool, space_id, &nickname).await?
        && owner != member.member_id
    {
        return Err(CollaborationError::new(
            "nickname_taken",
            "nickname is already used in this space",
        ));
    }
    {
        let stamp = now_stamp();
        let mut conn = pool.acquire().await.map_err(db)?;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *conn)
            .await
            .map_err(db)?;
        let id_outcome = async {
            sqlx::query(
                "UPDATE collaboration_space_members SET nickname = ? WHERE space_id = ? AND member_id = ?",
            )
            .bind(&nickname)
            .bind(space_id)
            .bind(&member.member_id)
            .execute(&mut *conn)
            .await?;
            append_space_event_tx(
                &mut conn,
                space_id,
                "roster",
                None,
                &json!({
                    "action": "member_renamed",
                    "member_id": member.member_id,
                    "nickname": nickname,
                }),
                &stamp,
            )
            .await?;
            Ok::<(), CollaborationError>(())
        }
        .await;
        finish_tx(&mut conn, id_outcome).await?;
    }
    let is_direct_or_unassigned = parse_unassigned_space_id(space_id).is_some()
        || space_id.starts_with(identity::DIRECT_PREFIX);
    let binding = identity::binding_of_conversation(pool, caller_id)
        .await
        .map_err(db)?;
    let identity_member_id = match binding {
        Some(b) => Some(b.member_id),
        None => {
            if let Some(mid) = space_id.strip_prefix(identity::DIRECT_PREFIX) {
                Some(mid.to_string())
            } else {
                let candidate = identity::member_id_for_conversation(caller_id);
                if identity::load_member(pool, &candidate)
                    .await
                    .map_err(db)?
                    .is_some()
                {
                    Some(candidate)
                } else {
                    None
                }
            }
        }
    };
    if is_direct_or_unassigned || identity_member_id.is_some() {
        let mid = match identity_member_id {
            Some(mid) => mid,
            None => identity::ensure_member_for_conversation(pool, caller_id, Some(&nickname))
                .await
                .map_err(identity_error)?,
        };
        sqlx::query("UPDATE collaboration_members SET name = ? WHERE id = ?")
            .bind(&nickname)
            .bind(&mid)
            .execute(pool)
            .await
            .map_err(db)?;
        let direct_tid = identity::direct_thread_id(&mid);
        sqlx::query("UPDATE collaboration_threads SET title = ? WHERE id = ?")
            .bind(&nickname)
            .bind(&direct_tid)
            .execute(pool)
            .await
            .map_err(db)?;
        let unassigned_id = unassigned_space_id(target.workspace_id);
        let dm_convs: Vec<String> = sqlx::query_scalar(
            "SELECT conversation_id FROM collaboration_thread_members WHERE thread_id = ? AND member_id = ?",
        )
        .bind(&direct_tid)
        .bind(&mid)
        .fetch_all(pool)
        .await
        .map_err(db)?;
        let mut all_convs = dm_convs;
        let caller_str = caller_id.to_string();
        if !all_convs.contains(&caller_str) {
            all_convs.push(caller_str);
        }
        for cid in &all_convs {
            sqlx::query(
                "UPDATE collaboration_space_members SET nickname = ? WHERE space_id = ? AND conversation_id = ?",
            )
            .bind(&nickname)
            .bind(&unassigned_id)
            .bind(cid)
            .execute(pool)
            .await
            .map_err(db)?;
            sqlx::query("UPDATE conversation_personas SET name = ? WHERE conversation_id = ?")
                .bind(&nickname)
                .bind(cid)
                .execute(pool)
                .await
                .map_err(db)?;
        }
    }
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
    load_space_or_unassigned(pool, space_id).await?;
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
    if space_id.starts_with(identity::DIRECT_PREFIX) {
        load_space_or_unassigned(pool, space_id).await?;
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
        return Ok(MemberRecord {
            member_id: "user".to_string(),
            conversation_id: None,
            nickname: "你".to_string(),
            kind: "user".to_string(),
            visible_to_agents: 0,
        });
    }
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

pub(crate) async fn batch_load_space_members_by_space(
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
    member_space_context_text_for(pool, conversation_id, None).await
}

/// Number of recent activity entries injected at turn start
/// (`VIBEX_MEMBER_ACTIVITY_LIMIT`, default 8, 0 disables).
pub fn member_activity_limit() -> usize {
    env_i64(
        "VIBEX_MEMBER_ACTIVITY_LIMIT",
        crate::member_memory::DEFAULT_ACTIVITY_LIMIT as i64,
    )
    .max(0) as usize
}

/// Member identity block plus the member's memory (recent cross-thread
/// activity and the facts most relevant to `query`, privacy-filtered).
pub async fn member_space_context_text_for(
    pool: &SqlitePool,
    conversation_id: Uuid,
    query: Option<&str>,
) -> Result<Option<String>, CollaborationError> {
    let identity_block = member_identity_context_text(pool, conversation_id).await?;
    let limit = member_activity_limit();
    let memory = if limit == 0 {
        None
    } else {
        crate::member_memory::memory_context_text(pool, conversation_id, query, limit).await?
    };
    Ok(match (identity_block, memory) {
        (Some(block), Some(memory)) => Some(format!("{block}\n\n{memory}")),
        (Some(block), None) => Some(block),
        (None, Some(memory)) => Some(format!("[协作空间成员身份]\n{memory}")),
        (None, None) => None,
    })
}

pub(crate) async fn member_identity_context_text(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Option<String>, CollaborationError> {
    let active_binding = identity::binding_of_conversation(pool, conversation_id)
        .await
        .map_err(db)?;

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

    let mut direct_thread_and_nickname: Option<(String, String)> = None;
    let mut group_memberships: Vec<(String, String)> = Vec::new();

    if let Some(binding) = active_binding {
        if binding.thread_id.starts_with(identity::DIRECT_PREFIX)
            || parse_unassigned_space_id(&binding.thread_id).is_some()
        {
            let member_name = sqlx::query_scalar::<_, String>(
                "SELECT name FROM collaboration_members WHERE id = ? LIMIT 1",
            )
            .bind(&binding.member_id)
            .fetch_optional(pool)
            .await
            .map_err(db)?
            .or_else(|| memberships.first().map(|(_, nick)| nick.clone()))
            .unwrap_or_else(|| binding.member_id.clone());
            direct_thread_and_nickname = Some((binding.thread_id, member_name));
        } else {
            let nickname = sqlx::query_scalar::<_, String>(
                r#"SELECT nickname FROM collaboration_space_members
                   WHERE space_id = ? AND conversation_id = ? AND kind = 'agent'
                   LIMIT 1"#,
            )
            .bind(&binding.thread_id)
            .bind(conversation_id.to_string())
            .fetch_optional(pool)
            .await
            .map_err(db)?
            .or_else(|| {
                memberships
                    .iter()
                    .find(|(sid, _)| sid == &binding.thread_id)
                    .map(|(_, nick)| nick.clone())
            });
            let nickname = match nickname {
                Some(n) => n,
                None => sqlx::query_scalar::<_, String>(
                    "SELECT name FROM collaboration_members WHERE id = ? LIMIT 1",
                )
                .bind(&binding.member_id)
                .fetch_optional(pool)
                .await
                .map_err(db)?
                .unwrap_or_else(|| binding.member_id.clone()),
            };
            group_memberships.push((binding.thread_id, nickname));
        }
    } else {
        group_memberships = memberships
            .iter()
            .filter(|(sid, _)| {
                parse_unassigned_space_id(sid).is_none()
                    && !sid.starts_with(identity::DIRECT_PREFIX)
            })
            .cloned()
            .collect();
        if group_memberships.is_empty() {
            direct_thread_and_nickname = memberships
                .iter()
                .find(|(sid, _)| {
                    parse_unassigned_space_id(sid).is_some()
                        || sid.starts_with(identity::DIRECT_PREFIX)
                })
                .cloned();
        }
    }

    if group_memberships.is_empty() {
        let Some((thread_label, my_nickname)) = direct_thread_and_nickname else {
            return Ok(None);
        };

        let persona_meta = sqlx::query_as::<_, (Option<String>, String)>(
            "SELECT team_name, summary FROM conversation_personas WHERE conversation_id = ?",
        )
        .bind(conversation_id.to_string())
        .fetch_optional(pool)
        .await
        .map_err(db)?;

        let role_desc = match persona_meta {
            Some((team_opt, summary)) => {
                let team = team_opt.as_deref().map(str::trim).filter(|s| !s.is_empty());
                let sum = summary.trim();
                match (team, !sum.is_empty()) {
                    (Some(t), true) => format!("所属团队：{t}；职责简介：{sum}"),
                    (Some(t), false) => format!("所属团队：{t}"),
                    (None, true) => sum.to_string(),
                    (None, false) => "一对一私聊助手".to_string(),
                }
            }
            None => "一对一私聊助手".to_string(),
        };

        return Ok(Some(format!(
            "[协作空间私聊身份]\n\
             - 你的昵称：{my_nickname} (conversation_id: {conversation_id}, thread_id: {thread_label})\n\
             - 角色说明：{role_desc}\n\
             - 会话模式说明：当前处于一对一私聊（space_id: \"{thread_label}\"）。需要用户在私聊中看见的内容，调用 `post_to_space`（`space_id: \"{thread_label}\"`，`to: [\"User\"]`，正文直接写内容）；不要再写一段重复的普通会话回复。向用户提问用 `ask_user_question`（阻塞，问题出现在这条私聊里）。私聊历史已在当前会话中，不必调用 `list_space_messages`。若需读取或沉淀当前私聊收藏夹资料，可调用 `list_space_collection` / `read_space_collection_item` / `add_to_space_collection`（传入 `space_id: \"{thread_label}\"`）；可使用 `memory_search` / `memory_write` 检索或记录跨会话记忆。"
        )));
    }

    let space_ids: Vec<String> = group_memberships
        .iter()
        .map(|(sid, _)| sid.clone())
        .collect();
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
    let mut sections = Vec::new();
    for (space_id, my_nickname) in group_memberships {
        let space_name = space_names.remove(&space_id).unwrap_or_else(|| {
            if parse_unassigned_space_id(&space_id).is_some() {
                "未定空间".to_string()
            } else {
                space_id.clone()
            }
        });
        sections.push(format!(
            "- 所属协作空间：{space_name} (space_id: {space_id})\n  你的成员昵称：{my_nickname} (conversation_id: {conversation_id})\n  需要成员名单时调用 `list_space_members`（`space_id`）；需要更早历史时调用 `list_space_messages`（`space_id`、`since_seq`、`limit`）"
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
        let lead_id = space.lead_member_id.clone();
        let lead_nickname = members
            .iter()
            .find(|m| Some(m.member_id.as_str()) == lead_id.as_deref())
            .map(|m| m.nickname.clone());
        let mut member_views = Vec::with_capacity(members.len());
        for m in &members {
            member_views.push(json!({
                "member_id": m.member_id,
                "identity_member_id": identity_member_id_for_conversation(
                    pool,
                    m.conversation_id.as_deref(),
                )
                .await?,
                "nickname": m.nickname,
                "conversation_id": m.conversation_id,
                "kind": m.kind,
                "is_self": m.conversation_id.as_deref() == Some(caller_str.as_str()),
                "is_lead": lead_id.as_deref() == Some(m.member_id.as_str()),
            }));
        }
        items.push(json!({
            "space_id": space.space_id,
            "name": space.name,
            "workspace_id": space.workspace_id,
            "is_member": my_member.is_some(),
            "my_nickname": my_member.map(|m| m.nickname.clone()),
            "lead_member_id": lead_id,
            "lead_nickname": lead_nickname,
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
    let lead_member_id: Option<String> = sqlx::query_scalar::<_, Option<String>>(
        "SELECT lead_member_id FROM collaboration_spaces WHERE id = ?",
    )
    .bind(space_id)
    .fetch_optional(pool)
    .await
    .map_err(db)?
    .flatten()
    .filter(|id| !id.trim().is_empty());
    let members = list_space_members(pool, space_id, MessageAudience::Agent).await?;
    let workspace_uuid = Uuid::parse_str(&space_row.workspace_id).ok();
    let conversations = match workspace_uuid {
        Some(wid) => list_workspace_conversations(pool, wid)
            .await
            .unwrap_or_default(),
        None => Vec::new(),
    };
    let conv_ids: Vec<String> = members
        .iter()
        .filter_map(|m| m.conversation_id.as_deref())
        .filter_map(|cid| Uuid::parse_str(cid).ok())
        .map(|cid| cid.to_string())
        .collect();
    let mut personas_by_conv: std::collections::HashMap<String, ConversationPersonaView> =
        std::collections::HashMap::new();
    if !conv_ids.is_empty() {
        for chunk in conv_ids.chunks(500) {
            let mut builder = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
                r#"SELECT conversation_id, name, team_name, summary, agent_id
                   FROM conversation_personas
                   WHERE conversation_id IN ("#,
            );
            let mut separated = builder.separated(", ");
            for cid in chunk {
                separated.push_bind(cid);
            }
            separated.push_unseparated(")");
            let rows = builder
                .build_query_as::<(String, String, Option<String>, String, String)>()
                .fetch_all(pool)
                .await
                .map_err(db)?;
            for (cid, name, team_name, summary, agent_id) in rows {
                personas_by_conv.insert(
                    cid,
                    ConversationPersonaView {
                        name,
                        team_name: team_name.filter(|value| !value.trim().is_empty()),
                        summary: (!summary.trim().is_empty()).then_some(summary),
                        agent_name: agent_id,
                    },
                );
            }
        }
    }
    let conversations_by_id: std::collections::HashMap<Uuid, &WorkspaceConversationOption> =
        conversations
            .iter()
            .map(|c| (c.conversation_id, c))
            .collect();
    let caller_str = caller_id.to_string();
    let mut my_nickname = None;
    let mut detailed = Vec::with_capacity(members.len());
    for member in members {
        if member.conversation_id.as_deref() == Some(caller_str.as_str()) {
            my_nickname = Some(member.nickname.clone());
        }
        let parsed_cid = member
            .conversation_id
            .as_deref()
            .and_then(|cid| Uuid::parse_str(cid).ok());
        let conv_opt = parsed_cid.and_then(|cid| conversations_by_id.get(&cid).copied());
        let persona = parsed_cid.and_then(|cid| personas_by_conv.get(&cid.to_string()));
        detailed.push(json!({
            "member_id": member.member_id,
            "identity_member_id": identity_member_id_for_conversation(
                pool,
                member.conversation_id.as_deref(),
            )
            .await?,
            "conversation_id": member.conversation_id,
            "nickname": member.nickname,
            "kind": member.kind,
            "visible_to_agents": member.visible_to_agents,
            "is_self": member.conversation_id.as_deref() == Some(caller_str.as_str()),
            "is_lead": lead_member_id.as_deref() == Some(member.member_id.as_str()),
            "agent_id": conv_opt.and_then(|c| c.agent_id.clone()).or_else(|| persona.map(|p| p.agent_name.clone())),
            "status": conv_opt.map(|c| c.status.clone()),
            "turn_in_flight": conv_opt.map(|c| c.turn_in_flight).unwrap_or(false),
            "team_name": persona.and_then(|p| p.team_name.clone()),
            "summary": persona.and_then(|p| p.summary.clone()),
        }));
    }
    let lead_nickname = detailed
        .iter()
        .find(|row| row["member_id"].as_str() == lead_member_id.as_deref())
        .and_then(|row| row["nickname"].as_str())
        .map(str::to_string);
    Ok(json!({
        "space_id": space_id,
        "space_name": space_name,
        "my_conversation_id": caller_id,
        "my_nickname": my_nickname,
        "lead_member_id": lead_member_id,
        "lead_nickname": lead_nickname,
        "members": detailed,
        "user_recipient": {
            "nickname": "User",
            "aliases": ["@User", "@你", "@用户"],
            "usage": "在 post_to_space 的 to 中传入 \"User\" 即可向用户汇报或提问。正文直接写内容；只有点名其他成员时才以 @成员昵称 开头"
        }
    }))
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
pub(crate) async fn session_busy(
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

/// Release any member write lease held by `conversation_id`.
pub async fn release_member_write(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<(), CollaborationError> {
    sqlx::query("DELETE FROM member_write_leases WHERE conversation_id = ?")
        .bind(conversation_id.to_string())
        .execute(pool)
        .await
        .map_err(db)?;
    Ok(())
}

/// How an agent seat obtains its conversation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SeatMode {
    /// Default. The seat uses the member's own conversation for this thread,
    /// creating one when the conversation is already bound to another live
    /// thread. A binding whose seat was removed is transferred instead.
    PerThread,
    /// The conversation moves into this thread (move / undecided fallback).
    Transfer,
}

pub(crate) fn identity_error(error: IdentityError) -> CollaborationError {
    match error {
        IdentityError::Database(error) => db(error),
        IdentityError::NotFound(what) => {
            CollaborationError::new("not_found", format!("{what} was not found"))
        }
    }
}

/// Session config stored on a member (`collaboration_members`). New sessions
/// of the member are created from it; edits never touch existing sessions.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MemberSessionConfig {
    pub agent_id: Option<String>,
    pub mode_id: Option<String>,
    /// Session config selection (model, permissions, ...), `{key: value}`.
    pub config_values: Value,
    pub persona_prompt: Option<String>,
}

impl MemberSessionConfig {
    fn has_session_controls(&self) -> bool {
        self.mode_id
            .as_deref()
            .is_some_and(|m| !m.trim().is_empty())
            || !config_overrides(&self.config_values).is_empty()
    }
}

pub async fn load_member_session_config(
    pool: &SqlitePool,
    member_id: &str,
) -> Result<Option<MemberSessionConfig>, CollaborationError> {
    let row = sqlx::query_as::<_, (Option<String>, Option<String>, Option<String>, Option<String>)>(
        "SELECT agent, mode_id, config_values, persona_prompt FROM collaboration_members WHERE id = ?",
    )
    .bind(member_id)
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    Ok(row.map(
        |(agent_id, mode_id, config_values, persona_prompt)| MemberSessionConfig {
            agent_id,
            mode_id,
            config_values: config_values
                .and_then(|raw| serde_json::from_str(&raw).ok())
                .unwrap_or_else(|| json!({})),
            persona_prompt,
        },
    ))
}

pub(crate) async fn write_member_session_config(
    pool: &SqlitePool,
    member_id: &str,
    config: &MemberSessionConfig,
) -> Result<(), CollaborationError> {
    let non_empty = |v: &Option<String>| {
        v.as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    };
    let updated = sqlx::query(
        "UPDATE collaboration_members
         SET agent = COALESCE(?, agent), mode_id = ?, config_values = ?, persona_prompt = ?
         WHERE id = ?",
    )
    .bind(non_empty(&config.agent_id))
    .bind(non_empty(&config.mode_id))
    .bind(config.config_values.to_string())
    .bind(non_empty(&config.persona_prompt))
    .bind(member_id)
    .execute(pool)
    .await
    .map_err(db)?;
    if updated.rows_affected() == 0 {
        return Err(CollaborationError::new("not_found", "member was not found"));
    }
    let member_row = sqlx::query_as::<_, (String, Option<String>, Option<String>)>(
        "SELECT name, role_id, agent FROM collaboration_members WHERE id = ?",
    )
    .bind(member_id)
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    let (member_name, member_role_id, member_agent) =
        member_row.unwrap_or_else(|| ("成员".to_string(), None, non_empty(&config.agent_id)));
    let resolved_agent = non_empty(&config.agent_id)
        .or(member_agent)
        .unwrap_or_else(|| "codex".to_string());
    let prompt_trimmed = non_empty(&config.persona_prompt);
    let mode_trimmed = non_empty(&config.mode_id);
    let overrides = config_overrides(&config.config_values);

    let direct_tid = identity::direct_thread_id(member_id);
    let active_conv_rows: Vec<String> = sqlx::query_scalar(
        r#"SELECT DISTINCT conversation_id
           FROM collaboration_thread_members
           WHERE (member_id = ? AND status = 'active')
              OR thread_id = ?"#,
    )
    .bind(member_id)
    .bind(&direct_tid)
    .fetch_all(pool)
    .await
    .map_err(db)?;

    let mut conv_ids: Vec<Uuid> = Vec::new();
    for raw in active_conv_rows {
        if let Ok(cid) = Uuid::parse_str(raw.trim())
            && !conv_ids.contains(&cid)
        {
            conv_ids.push(cid);
        }
    }

    for cid in conv_ids {
        match prompt_trimmed.as_deref() {
            Some(prompt) => {
                sqlx::query(
                    r#"INSERT INTO conversation_personas
                       (conversation_id, role_id, name, team_name, summary, agent_id,
                        persona_prompt, snapshotted_at)
                       VALUES (?, ?, ?, NULL, '', ?, ?, ?)
                       ON CONFLICT(conversation_id) DO UPDATE SET
                         persona_prompt = excluded.persona_prompt,
                         agent_id = CASE WHEN trim(excluded.agent_id) != '' THEN excluded.agent_id ELSE conversation_personas.agent_id END"#,
                )
                .bind(cid.to_string())
                .bind(member_role_id.as_deref())
                .bind(&member_name)
                .bind(&resolved_agent)
                .bind(prompt)
                .bind(now_stamp())
                .execute(pool)
                .await
                .map_err(db)?;
            }
            None => {
                sqlx::query("DELETE FROM conversation_personas WHERE conversation_id = ?")
                    .bind(cid.to_string())
                    .execute(pool)
                    .await
                    .map_err(db)?;
            }
        }
        remember_creation_session_controls(pool, cid, mode_trimmed.as_deref(), overrides.clone())
            .await;
    }
    Ok(())
}

/// Edit a member's session config and synchronize existing direct/group
/// conversations for this member.
pub async fn set_member_session_config(
    pool: &SqlitePool,
    member_id: &str,
    config: MemberSessionConfig,
) -> Result<MemberSessionConfig, CollaborationError> {
    if let Some(agent) = config
        .agent_id
        .as_deref()
        .map(str::trim)
        .filter(|a| !a.is_empty())
    {
        AgentId::parse(agent)
            .map_err(|_| CollaborationError::new("not_found", "agent_id is not valid"))?;
    }
    write_member_session_config(pool, member_id, &config).await?;
    load_member_session_config(pool, member_id)
        .await?
        .ok_or_else(|| CollaborationError::new("not_found", "member was not found"))
}

/// Map `(member, thread)` to its conversation, creating it when missing.
/// A newly created conversation uses the member's stored session config
/// (agent, mode, config selection, persona); members without one fall back
/// to the role's mode/config, like a freshly created space member.
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

/// Session tab behind a member avatar: always `(member, thread)`, never the
/// member's most recent session. The undecided space id maps to the member's
/// direct thread. Creates the conversation from the member config if missing.
pub async fn resolve_thread_session(
    pool: &SqlitePool,
    member_id: &str,
    thread_id: &str,
) -> Result<Uuid, CollaborationError> {
    let member_id = member_id.trim();
    let mut thread_id = thread_id.trim().to_string();
    if parse_unassigned_space_id(&thread_id).is_some() {
        thread_id = identity::direct_thread_id(member_id);
    }
    resolve_session(pool, member_id, &thread_id).await
}

pub(crate) async fn prepare_member_conversation(
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
    if let Some(prompt) = persona_prompt
        .clone()
        .filter(|prompt| !prompt.trim().is_empty())
    {
        append_persona_notice(pool, conversation_id, &prompt).await?;
    }
    let member = identity::load_member(pool, member_id).await.map_err(db)?;
    let stored = load_member_session_config(pool, member_id).await?;
    if let (Some(member), Some(config)) = (member.as_ref(), stored.as_ref()) {
        if let Some(prompt) = config
            .persona_prompt
            .as_deref()
            .filter(|p| !p.trim().is_empty())
            && persona_prompt.as_deref().map(str::trim) != Some(prompt.trim())
        {
            sqlx::query(
                r#"INSERT INTO conversation_personas
                   (conversation_id, role_id, name, team_name, summary, agent_id,
                    persona_prompt, snapshotted_at)
                   VALUES (?, ?, ?, NULL, '', ?, ?, ?)
                   ON CONFLICT(conversation_id) DO UPDATE SET
                     persona_prompt = excluded.persona_prompt"#,
            )
            .bind(conversation_id.to_string())
            .bind(member.role_id.as_deref())
            .bind(&member.name)
            .bind(config.agent_id.as_deref().unwrap_or_default())
            .bind(prompt)
            .bind(now_stamp())
            .execute(pool)
            .await
            .map_err(db)?;
            append_persona_notice(pool, conversation_id, prompt).await?;
        }
        if config.has_session_controls() {
            remember_creation_session_controls(
                pool,
                conversation_id,
                config.mode_id.as_deref(),
                config_overrides(&config.config_values),
            )
            .await;
            return Ok(());
        }
    }
    let role_id = member.and_then(|member| member.role_id);
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

/// Map `send_session_input.member_id` to a collaboration identity id.
/// Accepts `collaboration_members.id`, or a per-space seat id from
/// `list_space_members` / `add_space_member` (`collaboration_space_members.member_id`).
async fn identity_id_for_member_ref(
    pool: &SqlitePool,
    member_id: &str,
    thread_id: &str,
) -> Result<String, CollaborationError> {
    if identity::load_member(pool, member_id)
        .await
        .map_err(db)?
        .is_some()
    {
        return Ok(member_id.to_string());
    }
    let seats: Vec<(String, Option<String>)> = sqlx::query_as(
        r#"SELECT space_id, conversation_id
           FROM collaboration_space_members
           WHERE member_id = ?"#,
    )
    .bind(member_id)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    let seat = seats
        .iter()
        .find(|(space_id, _)| space_id == thread_id)
        .or(seats.first());
    let Some((_, conversation_id)) = seat else {
        return Err(CollaborationError::new("not_found", "member was not found"));
    };
    let Some(conversation_id) = conversation_id
        .as_deref()
        .and_then(|raw| Uuid::parse_str(raw).ok())
    else {
        return Err(CollaborationError::new("not_found", "member was not found"));
    };
    if let Some(binding) = identity::binding_of_conversation(pool, conversation_id)
        .await
        .map_err(db)?
    {
        return Ok(binding.member_id);
    }
    let derived = identity::member_id_for_conversation(conversation_id);
    if identity::load_member(pool, &derived)
        .await
        .map_err(db)?
        .is_some()
    {
        return Ok(derived);
    }
    Err(CollaborationError::new("not_found", "member was not found"))
}

pub(crate) async fn identity_member_id_for_conversation(
    pool: &SqlitePool,
    conversation_id: Option<&str>,
) -> Result<Option<String>, CollaborationError> {
    let Some(conversation_id) = conversation_id.and_then(|raw| Uuid::parse_str(raw).ok()) else {
        return Ok(None);
    };
    if let Some(binding) = identity::binding_of_conversation(pool, conversation_id)
        .await
        .map_err(db)?
    {
        return Ok(Some(binding.member_id));
    }
    let derived = identity::member_id_for_conversation(conversation_id);
    if identity::load_member(pool, &derived)
        .await
        .map_err(db)?
        .is_some()
    {
        return Ok(Some(derived));
    }
    Ok(None)
}

/// Agent-facing member payload: `member_id` is the space seat, `identity_member_id`
/// is the bot identity accepted by `send_session_input`.
pub async fn space_member_tool_value(
    pool: &SqlitePool,
    member: &MemberRecord,
) -> Result<Value, CollaborationError> {
    Ok(json!({
        "member_id": member.member_id,
        "identity_member_id": identity_member_id_for_conversation(
            pool,
            member.conversation_id.as_deref(),
        )
        .await?,
        "conversation_id": member.conversation_id,
        "nickname": member.nickname,
        "kind": member.kind,
        "visible_to_agents": member.visible_to_agents,
    }))
}

/// Resolve a target for a caller conversation: `member_id` plus `thread_id`
/// (a space id, a `direct:` thread id, or the undecided space id). `member_id`
/// may be a bot identity id or a space seat id. The thread must live in the
/// caller's workspace, and nothing is created otherwise.
pub async fn resolve_member_target(
    pool: &SqlitePool,
    caller_id: Uuid,
    member_id: &str,
    thread_id: &str,
) -> Result<Uuid, CollaborationError> {
    let caller = live_session(load_session(pool, caller_id).await?)?;
    let member_id = identity_id_for_member_ref(pool, member_id.trim(), thread_id.trim()).await?;
    let mut thread_id = thread_id.trim().to_string();
    if parse_unassigned_space_id(&thread_id).is_some() {
        thread_id = identity::direct_thread_id(&member_id);
    }
    let thread_workspace = match identity::load_thread(pool, &thread_id).await.map_err(db)? {
        Some(thread) => thread.workspace_id,
        None if !thread_id.starts_with(identity::DIRECT_PREFIX) => {
            let space = load_space(pool, &thread_id).await?;
            identity::ensure_thread_for_seat(pool, &thread_id, &member_id)
                .await
                .map_err(identity_error)?;
            Some(space.workspace_id)
        }
        None => None,
    };
    if thread_workspace.as_deref() != Some(caller.workspace_id.to_string().as_str()) {
        return Err(CollaborationError::new("not_found", "thread was not found"));
    }
    resolve_session(pool, &member_id, &thread_id).await
}

/// Bind an agent seat's conversation to its `(member, thread)` and return the
/// conversation that seat must use. Keeps legacy seats working: a seat whose
/// conversation is bound to another live thread is left as is.
pub(crate) async fn attach_seat(
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
pub(crate) async fn resolve_seat_target(
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
pub(crate) async fn existing_member_seat(
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

pub(crate) async fn insert_member(
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

pub(crate) async fn insert_member_with(
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
    {
        let stamp = now_stamp();
        let mut conn = pool.acquire().await.map_err(db)?;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *conn)
            .await
            .map_err(db)?;
        let ins_outcome = async {
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
            .execute(&mut *conn)
            .await?;
            if kind == "agent" {
                append_space_event_tx(
                    &mut conn,
                    space_id,
                    "roster",
                    None,
                    &json!({
                        "action": "member_added",
                        "member_id": member_id,
                        "nickname": nickname,
                        "kind": kind,
                    }),
                    &stamp,
                )
                .await?;
            }
            Ok::<(), CollaborationError>(())
        }
        .await;
        finish_tx(&mut conn, ins_outcome).await?;
    }
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

pub(crate) async fn unique_nickname(
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

/// The unique thread this conversation sits in (a DM or one group).
pub async fn thread_id_for_conversation(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Option<String>, CollaborationError> {
    sqlx::query_scalar(
        "SELECT thread_id FROM collaboration_thread_members WHERE conversation_id = ?",
    )
    .bind(conversation_id.to_string())
    .fetch_optional(pool)
    .await
    .map_err(db)
}

/// A collaboration conversation may only post with its own thread as `space_id`.
/// Address another private chat or group through `to` (nickname or group name).
pub(crate) async fn require_caller_thread(
    pool: &SqlitePool,
    caller_id: Uuid,
    space_id: &str,
) -> Result<(), CollaborationError> {
    let Some(origin) = thread_id_for_conversation(pool, caller_id).await? else {
        return Ok(());
    };
    if origin == space_id {
        return Ok(());
    }
    Err(CollaborationError::new(
        "invalid_origin_space",
        "请使用当前会话的 space_id，通过 to 联系其他助手或群；不要把 space_id 换成目标会话。",
    ))
}

pub(crate) async fn nickname_owner(
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
pub(crate) async fn caller_seat(
    pool: &SqlitePool,
    space_id: &str,
    caller_id: Uuid,
) -> Result<MemberRecord, CollaborationError> {
    if let Some(member) = direct_thread_caller_seat(pool, space_id, caller_id).await? {
        return Ok(member);
    }
    match ensure_agent_member(pool, space_id, caller_id).await {
        Ok(member) => Ok(member),
        Err(error) => match existing_member_seat(pool, space_id, caller_id).await? {
            Some(member) => Ok(member),
            None => Err(error),
        },
    }
}

/// A newly created bot's private chat is `direct:<member_id>` and is bound in
/// `collaboration_thread_members`, not as a group seat. `post_to_space` still
/// uses that thread id as `space_id`.
pub(crate) async fn direct_thread_caller_seat(
    pool: &SqlitePool,
    space_id: &str,
    caller_id: Uuid,
) -> Result<Option<MemberRecord>, CollaborationError> {
    let Some(target_member_id) = space_id
        .strip_prefix(identity::DIRECT_PREFIX)
        .map(str::trim)
        .filter(|id| !id.is_empty())
    else {
        return Ok(None);
    };
    if let Some(member) = sqlx::query_as::<_, MemberRecord>(
        r#"SELECT m.id AS member_id,
                  tm.conversation_id,
                  m.name AS nickname,
                  'agent' AS kind,
                  1 AS visible_to_agents
           FROM collaboration_thread_members tm
           JOIN collaboration_members m ON m.id = tm.member_id
           WHERE tm.thread_id = ?
             AND tm.conversation_id = ?
             AND tm.status = 'active'
           LIMIT 1"#,
    )
    .bind(space_id)
    .bind(caller_id.to_string())
    .fetch_optional(pool)
    .await
    .map_err(db)?
    {
        return Ok(Some(member));
    }
    let matches_identity = match identity::binding_of_conversation(pool, caller_id)
        .await
        .map_err(db)?
    {
        Some(binding) => binding.member_id == target_member_id,
        None => identity::member_id_for_conversation(caller_id) == target_member_id,
    };
    if matches_identity {
        return sqlx::query_as::<_, MemberRecord>(
            r#"SELECT m.id AS member_id,
                      ? AS conversation_id,
                      m.name AS nickname,
                      'agent' AS kind,
                      1 AS visible_to_agents
               FROM collaboration_members m
               WHERE m.id = ?
               LIMIT 1"#,
        )
        .bind(caller_id.to_string())
        .bind(target_member_id)
        .fetch_optional(pool)
        .await
        .map_err(db);
    }
    Ok(None)
}

pub(crate) fn seat_conversation(member: &MemberRecord) -> Option<Uuid> {
    member
        .conversation_id
        .as_deref()
        .and_then(|raw| Uuid::parse_str(raw).ok())
}

pub(crate) async fn ensure_agent_member(
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

pub(crate) async fn member_nickname(
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
pub(crate) struct SpaceRow {
    pub(crate) workspace_id: String,
}

pub(crate) async fn load_space(
    pool: &SqlitePool,
    space_id: &str,
) -> Result<SpaceRow, CollaborationError> {
    sqlx::query_as::<_, SpaceRow>("SELECT workspace_id FROM collaboration_spaces WHERE id = ?")
        .bind(space_id)
        .fetch_optional(pool)
        .await
        .map_err(db)?
        .ok_or_else(|| CollaborationError::new("not_found", "space was not found"))
}

pub(crate) async fn load_space_or_unassigned(
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
    if space_id.starts_with("direct:") {
        let from_thread: Option<Option<String>> = sqlx::query_scalar(
            "SELECT workspace_id FROM collaboration_threads WHERE id = ? AND kind = 'direct'",
        )
        .bind(space_id)
        .fetch_optional(pool)
        .await
        .map_err(db)?;
        if let Some(workspace_id) = from_thread.flatten().filter(|id| !id.trim().is_empty()) {
            return Ok(SpaceRow { workspace_id });
        }
        let conv_str: Option<String> = sqlx::query_scalar(
            "SELECT conversation_id FROM collaboration_thread_members WHERE thread_id = ? LIMIT 1",
        )
        .bind(space_id)
        .fetch_optional(pool)
        .await
        .map_err(db)?;
        if let Some(conv_uuid) = conv_str.and_then(|raw| Uuid::parse_str(raw.trim()).ok()) {
            let from_session: Option<Uuid> =
                sqlx::query_scalar("SELECT workspace_id FROM sessions WHERE id = ? LIMIT 1")
                    .bind(conv_uuid)
                    .fetch_optional(pool)
                    .await
                    .map_err(db)?;
            if let Some(workspace_id) = from_session {
                return Ok(SpaceRow {
                    workspace_id: workspace_id.to_string(),
                });
            }
        }
        return Err(CollaborationError::new("not_found", "space was not found"));
    }
    load_space(pool, space_id).await
}

pub(crate) fn require_name(name: &str) -> Result<String, CollaborationError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CollaborationError::new("not_found", "name is required"));
    }
    Ok(name.to_string())
}

pub(crate) fn require_agent(agent_id: &str) -> Result<String, CollaborationError> {
    let agent_id = agent_id.trim();
    if agent_id.is_empty() || AgentId::parse(agent_id).is_err() {
        return Err(CollaborationError::new("not_found", "agent_id is required"));
    }
    Ok(agent_id.to_string())
}

pub(crate) fn config_object(value: &Value) -> Value {
    match value {
        Value::Object(_) => value.clone(),
        _ => json!({}),
    }
}

pub(crate) fn config_overrides(value: &Value) -> Vec<AgentSessionConfigOverride> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collaboration::test_support::*;

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
    async fn member_sessions_use_stored_member_config_and_later_edits() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let seed = Uuid::new_v4();
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO workspaces (id, task_id, branch) VALUES (?, ?, 'main')")
            .bind(workspace)
            .bind(Uuid::new_v4())
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&pool)
            .await
            .unwrap();
        create_session(&pool, seed, workspace, Some("seed")).await;
        let created = host_create_space_member(
            &pool,
            HostCreateSpaceMember {
                workspace_id: workspace,
                space_id: None,
                nickname: "Alex".to_string(),
                role_id: None,
                agent_id: Some("codex".to_string()),
                team_id: None,
                persona_prompt: Some("reviewer".to_string()),
                mode_id: Some("plan".to_string()),
                config_values: Some(json!({ "model": "m-1", "approval": "never" })),
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();
        let direct = Uuid::parse_str(created.conversation_id.as_deref().unwrap()).unwrap();
        let created_session = load_session(&pool, direct).await.unwrap().unwrap();
        assert!(
            created_session
                .name
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .is_none()
        );
        let member = identity::binding_of_conversation(&pool, direct)
            .await
            .unwrap()
            .map(|b| b.member_id)
            .unwrap_or_else(|| identity::member_id_for_conversation(direct));
        let stored = load_member_session_config(&pool, &member)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.agent_id.as_deref(), Some("codex"));
        assert_eq!(stored.mode_id.as_deref(), Some("plan"));
        assert_eq!(stored.config_values["model"], "m-1");

        // New group thread: the session is created from the member config.
        let first = space_of(&pool, seed).await;
        identity::ensure_thread_for_seat(&pool, &first, &member)
            .await
            .unwrap();
        let in_first = resolve_session(&pool, &member, &first).await.unwrap();
        assert_ne!(in_first, direct);
        let session = load_session(&pool, in_first).await.unwrap().unwrap();
        assert_eq!(
            session.agent_id.map(|a| a.to_string()).as_deref(),
            Some("codex")
        );
        let (mode, config) = session_controls_of(&pool, in_first).await;
        assert_eq!(mode.as_deref(), Some("plan"));
        assert!(config.unwrap_or_default().contains("m-1"));

        // Edit 1: updating persona_prompt, mode_id, and config_values syncs to both direct and existing group sessions.
        set_member_session_config(
            &pool,
            &member,
            MemberSessionConfig {
                agent_id: Some("codex".to_string()),
                mode_id: Some("code".to_string()),
                config_values: json!({ "model": "m-updated" }),
                persona_prompt: Some("updated reviewer persona".to_string()),
            },
        )
        .await
        .unwrap();
        for existing_conv in [direct, in_first] {
            let prompt: Option<String> = sqlx::query_scalar(
                "SELECT persona_prompt FROM conversation_personas WHERE conversation_id = ?",
            )
            .bind(existing_conv.to_string())
            .fetch_optional(&pool)
            .await
            .unwrap();
            assert_eq!(prompt.as_deref(), Some("updated reviewer persona"));
            let (m, cfg) = session_controls_of(&pool, existing_conv).await;
            assert_eq!(m.as_deref(), Some("code"));
            assert!(cfg.unwrap_or_default().contains("m-updated"));
        }

        // Edit 2: clearing persona_prompt deletes conversation_personas rows for existing sessions and updates controls.
        set_member_session_config(
            &pool,
            &member,
            MemberSessionConfig {
                agent_id: Some("codex".to_string()),
                mode_id: Some("auto".to_string()),
                config_values: json!({ "model": "m-2" }),
                persona_prompt: None,
            },
        )
        .await
        .unwrap();
        for existing_conv in [direct, in_first] {
            let prompt_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM conversation_personas WHERE conversation_id = ?",
            )
            .bind(existing_conv.to_string())
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(prompt_count, 0);
        }
        let second = space_of(&pool, seed).await;
        identity::ensure_thread_for_seat(&pool, &second, &member)
            .await
            .unwrap();
        let in_second = resolve_session(&pool, &member, &second).await.unwrap();
        let (mode, config) = session_controls_of(&pool, in_second).await;
        assert_eq!(mode.as_deref(), Some("auto"));
        assert!(config.unwrap_or_default().contains("m-2"));
        let (old_mode, old_config) = session_controls_of(&pool, in_first).await;
        assert_eq!(old_mode.as_deref(), Some("auto"));
        assert!(old_config.unwrap_or_default().contains("m-2"));
        let (dm_mode, dm_config) = session_controls_of(&pool, direct).await;
        assert_eq!(dm_mode.as_deref(), Some("auto"));
        assert!(dm_config.unwrap_or_default().contains("m-2"));
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

        let member_a = identity::member_id_for_conversation(a);
        let a_in_second = resolve_session(&pool, &member_a, &second).await.unwrap();
        for (caller, space, text) in [(a, &first, "第一空间"), (a_in_second, &second, "第二空间")]
        {
            post_to_space(
                &pool,
                PostToSpace {
                    caller_id: Some(caller),
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

    #[tokio::test]
    async fn resolve_member_target_accepts_space_seat_id_from_add_space_member() {
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
        let in_second = add_space_member(&pool, a, &second, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        let forked = Uuid::parse_str(in_second.conversation_id.as_deref().unwrap()).unwrap();
        let identity = identity::member_id_for_conversation(b);
        assert_ne!(
            in_first.member_id, identity,
            "space seat id and identity member id are distinct namespaces"
        );
        assert_ne!(in_first.member_id, in_second.member_id);

        assert_eq!(
            resolve_member_target(&pool, a, &in_first.member_id, &first)
                .await
                .unwrap(),
            b
        );
        assert_eq!(
            resolve_member_target(&pool, a, &in_second.member_id, &second)
                .await
                .unwrap(),
            forked
        );
        assert_eq!(
            resolve_member_target(&pool, a, &in_first.member_id, &second)
                .await
                .unwrap(),
            forked
        );
        assert_eq!(
            resolve_member_target(&pool, a, &identity, &first)
                .await
                .unwrap(),
            b
        );

        let listed = list_space_members_detailed(&pool, a, &first).await.unwrap();
        let listed_b = listed["members"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["nickname"] == "小B")
            .expect("小B in roster");
        assert_eq!(listed_b["member_id"], in_first.member_id);
        assert_eq!(listed_b["identity_member_id"], identity);
        assert_ne!(listed_b["member_id"], listed_b["identity_member_id"]);
        let tool = space_member_tool_value(&pool, &in_first).await.unwrap();
        assert_eq!(tool["member_id"], in_first.member_id);
        assert_eq!(tool["identity_member_id"], identity);
    }

    #[tokio::test]
    async fn list_space_views_expose_space_lead_nickname() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        let space = space_of(&pool, a).await;
        let in_space = add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();

        let before = list_space_members_detailed(&pool, a, &space).await.unwrap();
        assert!(before["lead_member_id"].is_null() || before.get("lead_member_id").is_none());
        assert!(before["lead_nickname"].is_null() || before.get("lead_nickname").is_none());
        for row in before["members"].as_array().unwrap() {
            assert_eq!(row["is_lead"], false);
        }

        set_space_lead(&pool, &space, Some(&in_space.member_id))
            .await
            .unwrap();

        let members_view = list_space_members_detailed(&pool, a, &space).await.unwrap();
        assert_eq!(members_view["lead_member_id"], in_space.member_id);
        assert_eq!(members_view["lead_nickname"], "小B");
        let listed_b = members_view["members"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["nickname"] == "小B")
            .expect("小B in roster");
        assert_eq!(listed_b["is_lead"], true);
        let listed_a = members_view["members"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["nickname"] == "小A")
            .expect("小A in roster");
        assert_eq!(listed_a["is_lead"], false);

        let spaces_view = list_collaboration_spaces_for_caller(&pool, a)
            .await
            .unwrap();
        let space_item = spaces_view["spaces"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["space_id"] == space)
            .expect("space in caller list");
        assert_eq!(space_item["lead_member_id"], in_space.member_id);
        assert_eq!(space_item["lead_nickname"], "小B");
        let listed_b = space_item["members"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["nickname"] == "小B")
            .expect("小B in space overview");
        assert_eq!(listed_b["is_lead"], true);
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

        // The creator acts in the new space through its per-thread seat.
        add_space_member(&pool, a, &second, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        let posted = post_as(&pool, Some(seat_in_second), &second, "@所有人 大家好", &[]).await;
        assert_eq!(posted.receipts.len(), 1);
        assert!(inputs_of(&pool, seat_in_second).await.is_empty());
        assert!(inputs_of(&pool, a).await.is_empty());
    }

    #[tokio::test]
    async fn member_memory_crosses_groups_but_private_chat_never_reaches_a_group() {
        use crate::member_memory::{self as memory, FactScope, FirstSentencesSummarizer};
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        let group1 = space_of(&pool, a).await;
        let group2 = space_of(&pool, a).await;
        add_space_member(&pool, a, &group1, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        let b_in_group2 = Uuid::parse_str(
            add_space_member(&pool, a, &group2, b, "小B", Uuid::new_v4())
                .await
                .unwrap()
                .conversation_id
                .as_deref()
                .unwrap(),
        )
        .unwrap();
        let member_b = identity::member_id_for_conversation(b);
        assert_eq!(
            identity::binding_of_conversation(&pool, b_in_group2)
                .await
                .unwrap()
                .unwrap()
                .member_id,
            member_b,
            "one member, two group threads"
        );
        // 小B's private chat with the user.
        let private_conv = Uuid::new_v4();
        create_session(&pool, private_conv, workspace, Some("小B")).await;
        let direct = identity::direct_thread_id(&member_b);
        sqlx::query(
        "INSERT INTO collaboration_threads (id, kind, title, created_at) VALUES (?, 'direct', '', '2026-10-24T00:00:00Z')",
    )
    .bind(&direct)
    .execute(&pool)
    .await
    .unwrap();
        sqlx::query(
        "INSERT INTO collaboration_thread_members (thread_id, member_id, conversation_id, joined_at) VALUES (?, ?, ?, '2026-10-24T00:00:00Z')",
    )
    .bind(&direct)
    .bind(&member_b)
    .bind(private_conv.to_string())
    .execute(&pool)
    .await
    .unwrap();

        // Short-term: one line per turn, deterministic, idempotent per turn.
        let turn1 = Uuid::new_v4();
        let reply = "我在群里把登录接口的分页 bug 修好了。还补了两条回归测试。第三句不该出现。";
        let summarizer = FirstSentencesSummarizer;
        assert!(
            memory::record_activity(&pool, b, Some(turn1), reply, &summarizer)
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            memory::record_activity(&pool, b, Some(turn1), reply, &summarizer)
                .await
                .unwrap()
                .is_none()
        );
        memory::record_activity(
            &pool,
            private_conv,
            Some(Uuid::new_v4()),
            "私聊里帮用户查了工资单密码。",
            &summarizer,
        )
        .await
        .unwrap();
        // Long-term facts in every scope.
        memory::tool_write(&pool, b, "群1约定：分页参数叫 page_size", None)
            .await
            .unwrap();
        let forced =
            memory::tool_write(&pool, private_conv, "用户的生日是五月一日", Some("global"))
                .await
                .unwrap();
        assert_eq!(forced.scope, "private", "private chat writes stay private");
        memory::create_fact(
            &pool,
            &member_b,
            "项目统一使用 pnpm 管理依赖",
            &FactScope::Global,
            None,
            "user",
        )
        .await
        .unwrap();

        // Acceptance: asked in group 2 what it did in group 1.
        let context = persona_prompt_text_for_turn(&pool, b_in_group2, Some("你在群1做了什么？"))
            .await
            .unwrap()
            .unwrap();
        assert!(context.contains("[成员记忆]"));
        assert!(
            context.contains("把登录接口的分页 bug 修好了。还补了两条回归测试。"),
            "{context}"
        );
        assert!(!context.contains("第三句"));
        assert!(
            !context.contains("工资单"),
            "private activity leaked: {context}"
        );
        assert!(
            !context.contains("私聊里") && !context.contains("私聊记忆"),
            "not even a placeholder: {context}"
        );
        assert!(!context.contains("生日"), "private fact leaked: {context}");
        assert!(
            !context.contains("page_size"),
            "group-1 thread fact stays in group 1"
        );
        let pnpm = persona_prompt_text_for_turn(&pool, b_in_group2, Some("用 pnpm 还是 npm"))
            .await
            .unwrap()
            .unwrap();
        assert!(
            pnpm.contains("项目统一使用 pnpm"),
            "global fact is retrieved by relevance"
        );
        let in_group1 = persona_prompt_text_for_turn(&pool, b, Some("分页参数 page_size"))
            .await
            .unwrap()
            .unwrap();
        assert!(in_group1.contains("page_size"));
        assert!(!in_group1.contains("工资单") && !in_group1.contains("生日"));
        // Tools are scoped the same way.
        let found = memory::tool_search(&pool, b_in_group2, "工资单 生日", 10)
            .await
            .unwrap();
        assert_eq!(found["facts"].as_array().unwrap().len(), 0);
        assert_eq!(found["activity"].as_array().unwrap().len(), 0);
        // In the private chat itself everything is available.
        let private = persona_prompt_text_for_turn(&pool, private_conv, Some("生日"))
            .await
            .unwrap()
            .unwrap();
        assert!(
            private.contains("工资单") && private.contains("生日") && private.contains("分页 bug")
        );
        // Host view lists everything; group view filters.
        assert_eq!(
            memory::list_activity(&pool, &member_b, true, 50)
                .await
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            memory::list_activity(&pool, &member_b, false, 50)
                .await
                .unwrap()
                .len(),
            1
        );

        // Distillation never promotes private activity out of `private`.
        assert_eq!(
            memory::distill_member_memory(&pool, &EchoDistiller)
                .await
                .unwrap(),
            2
        );
        assert_eq!(
            memory::distill_member_memory(&pool, &EchoDistiller)
                .await
                .unwrap(),
            0
        );
        let distilled: Vec<_> = memory::list_facts(&pool, &member_b, None)
            .await
            .unwrap()
            .into_iter()
            .filter(|f| f.origin == "distilled")
            .collect();
        let scope_of = |needle: &str| {
            distilled
                .iter()
                .find(|f| f.content.contains(needle))
                .unwrap()
                .scope
                .clone()
        };
        assert_eq!(scope_of("工资单"), "private");
        assert_eq!(scope_of("分页 bug"), "global");
        // Update / delete are member-scoped.
        let id = forced.id;
        assert!(
            memory::update_fact(&pool, "someone-else", id, Some("x"), None)
                .await
                .is_err()
        );
        let updated = memory::update_fact(&pool, &member_b, id, Some("用户生日：5月1日"), None)
            .await
            .unwrap();
        assert_eq!(updated.scope, "private");
        assert!(
            !memory::delete_fact(&pool, "someone-else", id)
                .await
                .unwrap()
        );
        assert!(memory::delete_fact(&pool, &member_b, id).await.unwrap());
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
        let member_a = identity::member_id_for_conversation(a);
        let a_in_second = resolve_session(&pool, &member_a, &second).await.unwrap();
        let posted = post_as(&pool, Some(a_in_second), &second, "@小B 第二空间的活", &[]).await;
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
    async fn direct_chat_identity_context_and_defensive_list_messages() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        sqlx::query(
        "INSERT INTO workspaces (id, task_id, branch, created_at, updated_at) VALUES (?, ?, 'main', datetime('now'), datetime('now'))",
    )
    .bind(workspace)
    .bind(Uuid::new_v4())
    .execute(&pool)
    .await
    .unwrap();

        let created = host_create_space_member(
            &pool,
            HostCreateSpaceMember {
                workspace_id: workspace,
                space_id: None,
                nickname: "私聊助手".to_string(),
                role_id: None,
                agent_id: Some("codex".to_string()),
                team_id: None,
                persona_prompt: Some("负责协助用户排查问题".to_string()),
                mode_id: None,
                config_values: Some(json!({ "avatar": "bot-1", "color": "#ff5500" })),
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();
        let dm_conv = Uuid::parse_str(created.conversation_id.as_deref().unwrap()).unwrap();
        let identity_mid = identity::member_id_for_conversation(dm_conv);

        // Verify avatar and color were written to collaboration_members
        let (avatar, color): (Option<String>, Option<String>) =
            sqlx::query_as("SELECT avatar, color FROM collaboration_members WHERE id = ?")
                .bind(&identity_mid)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(avatar.as_deref(), Some("bot-1"));
        assert_eq!(color.as_deref(), Some("#ff5500"));

        // Direct chat context injects [协作空间私聊身份] and requires post_to_space
        let dm_context = persona_prompt_text(&pool, dm_conv).await.unwrap().unwrap();
        assert!(dm_context.contains("[协作空间私聊身份]"), "{dm_context}");
        assert!(dm_context.contains("私聊助手"), "{dm_context}");
        assert!(dm_context.contains("一对一私聊"), "{dm_context}");
        assert!(dm_context.contains("post_to_space"), "{dm_context}");
        assert!(dm_context.contains("to: [\"User\"]"), "{dm_context}");
        assert!(!dm_context.contains("以 `@User ` 开头"), "{dm_context}");
        assert!(
            dm_context.contains(&identity::direct_thread_id(&identity_mid)),
            "{dm_context}"
        );
        assert!(dm_context.contains("memory_search"), "{dm_context}");
        assert!(
            !dm_context.contains("所属协作空间：未定空间"),
            "{dm_context}"
        );
        assert!(!dm_context.contains("[协作空间成员身份]"), "{dm_context}");

        let prefixed = prefix_persona_prompt(&dm_context, "你好");
        assert!(!prefixed.starts_with("人设\n[协作空间私聊身份]"));

        // Defensive check: calling list_space_messages on unassigned or direct returns friendly error
        let unassigned = unassigned_space_id(workspace);
        let direct_tid = identity::direct_thread_id(&identity_mid);
        for sid in [&unassigned, &direct_tid] {
            let err = list_space_messages(&pool, sid, None, None, MessageAudience::Agent)
                .await
                .unwrap_err();
            assert_eq!(err.code, "invalid_space_for_direct_chat");
            assert!(err.message.contains("一对一私聊"), "{}", err.message);
            assert!(err.message.contains("post_to_space"), "{}", err.message);
            assert!(!err.message.contains("以 `@User ` 开头"), "{}", err.message);
        }

        // User adds a note to the direct assistant's collection (direct:<member_id>)
        let user_item = add_to_space_collection(
            &pool,
            AddSpaceCollectionItem {
                caller_id: None,
                space_id: direct_tid.clone(),
                content: Some("# 个人助手资料\n请遵循规范 A".to_string()),
                source_path: None,
                base64_data: None,
                file_name: Some("guide.md".to_string()),
                note: Some("个人收藏规范".to_string()),
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();

        // Direct assistant can list and read its own direct:<member_id> collection via MCP (MessageAudience::Agent)
        let listed_by_dm = list_space_collection(
            &pool,
            &direct_tid,
            Some(dm_conv),
            None,
            MessageAudience::Agent,
        )
        .await
        .unwrap();
        assert_eq!(listed_by_dm.len(), 1);
        assert_eq!(listed_by_dm[0].id, user_item.id);

        let read_by_dm = read_space_collection_item(
            &pool,
            &direct_tid,
            &user_item.id,
            Some(dm_conv),
            MessageAudience::Agent,
        )
        .await
        .unwrap();
        assert_eq!(read_by_dm.id, user_item.id);
        assert_eq!(read_by_dm.read_receipts.len(), 1);
        assert_eq!(read_by_dm.read_receipts[0].reader_nickname, "私聊助手");

        // Another unrelated agent cannot read this private assistant's collection
        let outsider = Uuid::new_v4();
        create_session(&pool, outsider, workspace, Some("路人")).await;
        let denied = list_space_collection(
            &pool,
            &direct_tid,
            Some(outsider),
            None,
            MessageAudience::Agent,
        )
        .await
        .unwrap_err();
        assert_eq!(denied.code, "not_a_member");

        let _ = std::fs::remove_file(&user_item.file_path);
    }

    #[tokio::test]
    async fn rename_syncs_member_name_and_direct_thread_title() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        sqlx::query(
        "INSERT INTO workspaces (id, task_id, branch, created_at, updated_at) VALUES (?, ?, 'main', datetime('now'), datetime('now'))",
    )
    .bind(workspace)
    .bind(Uuid::new_v4())
    .execute(&pool)
    .await
    .unwrap();

        let created = host_create_space_member(
            &pool,
            HostCreateSpaceMember {
                workspace_id: workspace,
                space_id: None,
                nickname: "旧名字".to_string(),
                role_id: None,
                agent_id: Some("codex".to_string()),
                team_id: None,
                persona_prompt: None,
                mode_id: None,
                config_values: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();
        let dm_conv = Uuid::parse_str(created.conversation_id.as_deref().unwrap()).unwrap();
        let identity_mid = identity::member_id_for_conversation(dm_conv);
        let direct_tid = identity::direct_thread_id(&identity_mid);
        let unassigned = unassigned_space_id(workspace);

        // Rename via direct:<member_id>
        set_space_identity(&pool, dm_conv, &direct_tid, "新名字", Uuid::new_v4())
            .await
            .unwrap();

        let member_name: String =
            sqlx::query_scalar("SELECT name FROM collaboration_members WHERE id = ?")
                .bind(&identity_mid)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(member_name, "新名字");

        let thread_title: String =
            sqlx::query_scalar("SELECT title FROM collaboration_threads WHERE id = ?")
                .bind(&direct_tid)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(thread_title, "新名字");

        let unassigned_nick: String = sqlx::query_scalar(
        "SELECT nickname FROM collaboration_space_members WHERE space_id = ? AND conversation_id = ?",
    )
    .bind(&unassigned)
    .bind(dm_conv.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
        assert_eq!(unassigned_nick, "新名字");
    }

    #[tokio::test]
    async fn move_and_batch_delete_clean_up_group_and_direct_lifecycle() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        sqlx::query(
        "INSERT INTO workspaces (id, task_id, branch, created_at, updated_at) VALUES (?, ?, 'main', datetime('now'), datetime('now'))",
    )
    .bind(workspace)
    .bind(Uuid::new_v4())
    .execute(&pool)
    .await
    .unwrap();

        let created_a = host_create_space_member(
            &pool,
            HostCreateSpaceMember {
                workspace_id: workspace,
                space_id: None,
                nickname: "助手A".to_string(),
                role_id: None,
                agent_id: Some("codex".to_string()),
                team_id: None,
                persona_prompt: None,
                mode_id: None,
                config_values: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();
        let dm_a = Uuid::parse_str(created_a.conversation_id.as_deref().unwrap()).unwrap();
        let mid_a = identity::member_id_for_conversation(dm_a);

        let created_b = host_create_space_member(
            &pool,
            HostCreateSpaceMember {
                workspace_id: workspace,
                space_id: None,
                nickname: "助手B".to_string(),
                role_id: None,
                agent_id: Some("codex".to_string()),
                team_id: None,
                persona_prompt: None,
                mode_id: None,
                config_values: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();
        let dm_b = Uuid::parse_str(created_b.conversation_id.as_deref().unwrap()).unwrap();
        let _mid_b = identity::member_id_for_conversation(dm_b);

        let space = create_workspace_space(&pool, workspace, "项目群", Uuid::new_v4())
            .await
            .unwrap()
            .space_id;
        let seat_a = host_add_space_member(&pool, &space, dm_a, "助手A", Uuid::new_v4())
            .await
            .unwrap();
        let group_conv_a = Uuid::parse_str(seat_a.conversation_id.as_deref().unwrap()).unwrap();
        assert_ne!(group_conv_a, dm_a);

        let seat_b = host_add_space_member(&pool, &space, dm_b, "助手B", Uuid::new_v4())
            .await
            .unwrap();
        let group_conv_b = Uuid::parse_str(seat_b.conversation_id.as_deref().unwrap()).unwrap();
        assert_ne!(group_conv_b, dm_b);

        // 1. Remove member A from group -> move to unassigned:<workspace>
        let unassigned = unassigned_space_id(workspace);
        host_move_space_member(
            &pool,
            &space,
            &unassigned,
            group_conv_a,
            Some("助手A"),
            Uuid::new_v4(),
        )
        .await
        .unwrap();

        // Group thread should only have member B left
        let group_tm_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM collaboration_thread_members WHERE thread_id = ? AND member_id = ?",
    )
    .bind(&space)
    .bind(&mid_a)
    .fetch_one(&pool)
    .await
    .unwrap();
        assert_eq!(
            group_tm_count, 0,
            "removed member must be unbound from group thread"
        );

        // Unassigned should not have duplicate seats for A
        let unassigned_seats_a: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM collaboration_space_members WHERE space_id = ? AND nickname LIKE '助手A%'",
    )
    .bind(&unassigned)
    .fetch_one(&pool)
    .await
    .unwrap();
        assert_eq!(
            unassigned_seats_a, 1,
            "must not duplicate seat in unassigned"
        );

        // 2. Delete group space -> cleans up threads, thread_members, cards, handoffs, and does not duplicate B in unassigned
        let del_space = host_batch_delete_space_items(
            &pool,
            workspace,
            vec![space.clone()],
            Vec::new(),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        assert_eq!(del_space.deleted_space_ids, vec![space.clone()]);
        assert!(del_space.archived_conversation_ids.contains(&group_conv_b));
        assert!(del_space.unassigned_conversation_ids.is_empty());

        let space_thread_exists: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM collaboration_threads WHERE id = ?")
                .bind(&space)
                .fetch_optional(&pool)
                .await
                .unwrap();
        assert!(space_thread_exists.is_none());

        // 3. Delete direct chat member A -> cleans up direct:<mid_a> and collaboration_members
        host_batch_delete_space_items(
            &pool,
            workspace,
            Vec::new(),
            vec![BatchDeleteMemberTarget {
                space_id: unassigned.clone(),
                conversation_id: dm_a,
            }],
            Uuid::new_v4(),
        )
        .await
        .unwrap();

        let direct_thread_a: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM collaboration_threads WHERE id = ?")
                .bind(identity::direct_thread_id(&mid_a))
                .fetch_optional(&pool)
                .await
                .unwrap();
        assert!(direct_thread_a.is_none());
        let member_row_a: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM collaboration_members WHERE id = ?")
                .bind(&mid_a)
                .fetch_optional(&pool)
                .await
                .unwrap();
        assert!(member_row_a.is_none());
    }

    #[tokio::test]
    async fn ordinary_session_creates_space_and_adds_member_without_self_contamination() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let orchestrator = Uuid::new_v4();
        let bot = Uuid::new_v4();
        create_session(&pool, orchestrator, workspace, Some("普通主会话")).await;
        create_session(&pool, bot, workspace, Some("评审Bot")).await;

        let created = create_collaboration_space(&pool, orchestrator, "架构评审群", Uuid::new_v4())
            .await
            .unwrap();
        let space_id = created.space_id;

        // 1. Orchestrator must NOT be in collaboration_space_members
        let members = list_space_members(&pool, &space_id, MessageAudience::Agent)
            .await
            .unwrap();
        assert!(
            members
                .iter()
                .all(|m| m.conversation_id.as_deref() != Some(orchestrator.to_string().as_str())),
            "ordinary orchestrator session must not be added to collaboration_space_members"
        );
        assert!(
            identity::binding_of_conversation(&pool, orchestrator)
                .await
                .unwrap()
                .is_none(),
            "ordinary orchestrator session must not have thread member binding"
        );

        // 2. persona_prompt_text_for_turn on orchestrator must NOT contain [协作空间成员身份]
        let prompt = persona_prompt_text_for_turn(&pool, orchestrator, Some("你好"))
            .await
            .unwrap();
        assert!(
            prompt.as_deref().is_none_or(
                |p| !p.contains("[协作空间成员身份]") && !p.contains("[协作空间私聊身份]")
            ),
            "ordinary session prompt was contaminated: {prompt:?}"
        );

        // 3. Orchestrator in same workspace can call add_space_member to add another Bot session
        let added = add_space_member(
            &pool,
            orchestrator,
            &space_id,
            bot,
            "评审Bot",
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        assert_eq!(added.nickname, "评审Bot");
        assert_eq!(added.conversation_id, Some(bot.to_string()));
    }

    #[tokio::test]
    async fn ordinary_session_memory_write_returns_not_a_member_without_creating_member() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let ordinary = Uuid::new_v4();
        create_session(&pool, ordinary, workspace, Some("普通会话")).await;

        let err = crate::member_memory::tool_write(&pool, ordinary, "记住一条普通会话偏好", None)
            .await
            .unwrap_err();
        assert_eq!(err.code, "not_a_member");

        let search_err = crate::member_memory::tool_search(&pool, ordinary, "偏好", 5)
            .await
            .unwrap_err();
        assert_eq!(search_err.code, "not_a_member");

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM collaboration_members")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            count, 0,
            "ordinary session must not create collaboration_members row"
        );
    }

    #[tokio::test]
    async fn supplementary_fixes_role_orphan_collection_cleanup_and_sidebar_rename() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        sqlx::query(
        "INSERT INTO workspaces (id, task_id, branch, created_at, updated_at) VALUES (?, ?, 'main', datetime('now'), datetime('now'))",
    )
    .bind(workspace)
    .bind(Uuid::new_v4())
    .execute(&pool)
    .await
    .unwrap();

        let role = create_role(
            &pool,
            SaveRole {
                id: None,
                name: "架构师角色".to_string(),
                team_id: None,
                summary: "架构评审".to_string(),
                persona_prompt: "负责系统架构设计".to_string(),
                agent_id: "codex".to_string(),
                mode_id: Some("plan".to_string()),
                config_values: json!({ "model": "gpt-5" }),
            },
        )
        .await
        .unwrap();

        let created = host_create_space_member(
            &pool,
            HostCreateSpaceMember {
                workspace_id: workspace,
                space_id: None,
                nickname: "初始助手".to_string(),
                role_id: Some(role.id.clone()),
                agent_id: Some("codex".to_string()),
                team_id: None,
                persona_prompt: None,
                mode_id: None,
                config_values: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();
        let dm_conv = Uuid::parse_str(created.conversation_id.as_deref().unwrap()).unwrap();
        let member_id = identity::member_id_for_conversation(dm_conv);
        let direct_tid = identity::direct_thread_id(&member_id);

        // 1. sidebar::update_member_profile syncs name, direct thread title, and space member nickname
        crate::collaboration_sidebar::update_member_profile(
            &pool,
            &member_id,
            Some("改名后助手"),
            Some("bot-2"),
            Some("#00aa88"),
        )
        .await
        .unwrap();

        let (m_name, t_title, sm_nick): (String, String, String) = sqlx::query_as(
            r#"SELECT m.name, t.title, sm.nickname
           FROM collaboration_members m
           JOIN collaboration_threads t ON t.id = ?
           JOIN collaboration_space_members sm ON sm.conversation_id = ?
           WHERE m.id = ?"#,
        )
        .bind(&direct_tid)
        .bind(dm_conv.to_string())
        .bind(&member_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(m_name, "改名后助手");
        assert_eq!(t_title, "改名后助手");
        assert_eq!(sm_nick, "改名后助手");

        // 2. delete_role clears collaboration_members.role_id
        delete_role(&pool, &role.id).await.unwrap();
        let remaining_role_id: Option<String> =
            sqlx::query_scalar("SELECT role_id FROM collaboration_members WHERE id = ?")
                .bind(&member_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(
            remaining_role_id.is_none(),
            "delete_role must clear collaboration_members.role_id"
        );

        // 3. Collection files & DB records are cleaned up when deleting group space and direct assistant
        let space = create_workspace_space(&pool, workspace, "测试收藏清理群", Uuid::new_v4())
            .await
            .unwrap()
            .space_id;
        let group_item = add_to_space_collection(
            &pool,
            AddSpaceCollectionItem {
                caller_id: None,
                space_id: space.clone(),
                content: Some("group collection file".to_string()),
                source_path: None,
                base64_data: None,
                file_name: Some("group-note.md".to_string()),
                note: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();
        let group_file_path = std::path::PathBuf::from(&group_item.file_path);
        assert!(group_file_path.exists());

        let dm_item = add_to_space_collection(
            &pool,
            AddSpaceCollectionItem {
                caller_id: None,
                space_id: direct_tid.clone(),
                content: Some("direct collection file".to_string()),
                source_path: None,
                base64_data: None,
                file_name: Some("dm-note.md".to_string()),
                note: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();
        let dm_file_path = std::path::PathBuf::from(&dm_item.file_path);
        assert!(dm_file_path.exists());

        // Delete group space -> cleans up group collection DB rows and physical file
        host_batch_delete_space_items(
            &pool,
            workspace,
            vec![space.clone()],
            Vec::new(),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        assert!(
            !group_file_path.exists(),
            "group collection physical file must be deleted"
        );
        let group_col_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM collaboration_space_collection_items WHERE space_id = ?",
        )
        .bind(&space)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(group_col_count, 0);

        // Delete direct assistant -> cleans up direct:<member_id> collection DB rows and physical file
        let unassigned = unassigned_space_id(workspace);
        host_batch_delete_space_items(
            &pool,
            workspace,
            Vec::new(),
            vec![BatchDeleteMemberTarget {
                space_id: unassigned,
                conversation_id: dm_conv,
            }],
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        assert!(
            !dm_file_path.exists(),
            "direct chat collection physical file must be deleted"
        );
        let dm_col_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM collaboration_space_collection_items WHERE space_id = ?",
        )
        .bind(&direct_tid)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(dm_col_count, 0);
    }
}
