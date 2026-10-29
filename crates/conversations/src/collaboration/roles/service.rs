use agents::{
    AgentId, AgentSessionConfigOverride, ConversationEvent, ConversationRelationKind,
    ConversationRelationVisibility,
};
use chrono::{Duration, Utc};
use db::models::{
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

#[path = "events.rs"]
mod events;
#[path = "spaces.rs"]
mod spaces;

pub use events::*;
pub use spaces::*;

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
    let rows = ListRow::query_by_workspace(pool, workspace_id, &cutoff, limit)
        .await
        .map_err(db)?;
    Ok(rows
        .into_iter()
        .map(|mut row| {
            row.title = row.title.filter(|title| !title.trim().is_empty());
            row.agent_id = row.agent_id.filter(|agent| !agent.trim().is_empty());
            let config_values = row.config_values_json.as_deref().and_then(|raw| {
                let value: Value = serde_json::from_str(raw).ok()?;
                (value != Value::Null && value != json!({})).then_some(value)
            });
            let mode_id = row.mode_id.take().filter(|mode| !mode.trim().is_empty());
            let turn_in_flight = row.turn_in_flight_flag != 0;
            let delegated = parent_exit_cancels_child(row.delegation_call_id.as_deref());
            row.into_item(turn_in_flight, delegated, mode_id, config_values)
        })
        .collect())
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
        let count = TeamRow::count_tx(&mut conn).await?;
        if count >= TEAM_CAP {
            return Err(CollaborationError::new(
                "limit_exceeded",
                "team limit is 30",
            ));
        }
        TeamRow::insert_tx(&mut conn, &id, &name, input.summary.as_deref(), &stamp).await?;
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
    let affected = TeamRow::update_by_id(pool, id, &name, input.summary.as_deref(), &now_stamp())
        .await
        .map_err(db)?;
    if affected == 0 {
        return Err(CollaborationError::new("not_found", "team was not found"));
    }
    Ok(TeamRecord {
        id: id.to_string(),
        name,
        summary: input.summary,
    })
}

pub async fn delete_team(pool: &SqlitePool, id: &str) -> Result<(), CollaborationError> {
    let affected = TeamRow::delete_by_id(pool, id, &now_stamp())
        .await
        .map_err(db)?;
    if affected == 0 {
        return Err(CollaborationError::new("not_found", "team was not found"));
    }
    Ok(())
}

pub async fn list_teams(pool: &SqlitePool) -> Result<Vec<TeamRecord>, CollaborationError> {
    let rows = TeamRow::list_all(pool).await.map_err(db)?;
    Ok(rows.into_iter().map(TeamRow::into_record).collect())
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
    let row = RoleRow {
        id: id.clone(),
        name: name.clone(),
        team_id: input.team_id.clone(),
        summary: input.summary.clone(),
        persona_prompt: input.persona_prompt.clone(),
        agent_id: agent_id.clone(),
        mode_id: input.mode_id.clone(),
        config_values_json: config.to_string(),
    };
    let mut conn = pool.acquire().await.map_err(db)?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    let outcome = async {
        let count = RoleRow::count_tx(&mut conn).await?;
        if count >= ROLE_CAP {
            return Err(CollaborationError::new(
                "limit_exceeded",
                "role limit is 100",
            ));
        }
        RoleRow::insert_tx(&mut conn, &row, &stamp).await?;
        Ok(row.into_record())
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
    let row = RoleRow {
        id: id.to_string(),
        name,
        team_id: input.team_id,
        summary: input.summary,
        persona_prompt: input.persona_prompt,
        agent_id,
        mode_id: input.mode_id,
        config_values_json: config.to_string(),
    };
    let affected = RoleRow::update_by_id(pool, &row, &now_stamp())
        .await
        .map_err(db)?;
    if affected == 0 {
        return Err(CollaborationError::new("not_found", "role was not found"));
    }
    Ok(row.into_record())
}

pub async fn delete_role(pool: &SqlitePool, id: &str) -> Result<(), CollaborationError> {
    let affected = RoleRow::delete_by_id(pool, id).await.map_err(db)?;
    if affected == 0 {
        return Err(CollaborationError::new("not_found", "role was not found"));
    }
    Ok(())
}

pub async fn list_roles(pool: &SqlitePool) -> Result<Vec<RoleRecord>, CollaborationError> {
    let rows = RoleRow::list_all(pool).await.map_err(db)?;
    Ok(rows.into_iter().map(RoleRow::into_record).collect())
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

pub(crate) async fn load_create_operation(
    pool: &SqlitePool,
    operation_id: Uuid,
) -> Result<Option<StoredCreateOperation>, CollaborationError> {
    StoredCreateOperation::find_by_id(pool, operation_id)
        .await
        .map_err(db)
}

pub(crate) async fn store_create_operation(
    pool: &SqlitePool,
    input: &CreateSpawnedConversation,
    request: &Value,
) -> Result<(), CollaborationError> {
    StoredCreateOperation::insert(
        pool,
        input.operation_id,
        input.caller_id,
        &request.to_string(),
        &now_stamp(),
    )
    .await
    .map_err(db)
}

pub(crate) async fn load_role(
    pool: &SqlitePool,
    id: &str,
) -> Result<RoleRecord, CollaborationError> {
    let row = RoleRow::find_by_id(pool, id)
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

pub(crate) async fn load_space(
    pool: &SqlitePool,
    space_id: &str,
) -> Result<SpaceRow, CollaborationError> {
    SpaceRow::find_by_id(pool, space_id)
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
        let _ = ensure_space_collection_dir(space_id);
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
            let _ = ensure_space_collection_dir(space_id);
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
                let _ = ensure_space_collection_dir(space_id);
                return Ok(SpaceRow {
                    workspace_id: workspace_id.to_string(),
                });
            }
        }
        return Err(CollaborationError::new("not_found", "space was not found"));
    }
    let row = load_space(pool, space_id).await?;
    let _ = ensure_space_collection_dir(space_id);
    Ok(row)
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
