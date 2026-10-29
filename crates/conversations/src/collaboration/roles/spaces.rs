use db::models::collaboration_identity::{self as identity};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpaceRecord {
    pub space_id: String,
    pub name: String,
    pub workspace_id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lead_member_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collection_dir: Option<String>,
}

impl SpaceRecord {
    fn with_collection_dir(mut self) -> Self {
        if let Ok(dir) = ensure_space_collection_dir(&self.space_id) {
            self.collection_dir = Some(collection_dir_display(&dir));
        }
        self
    }
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
    let caller_id_text = caller_id.to_string();
    let caller_identity =
        identity_member_id_for_conversation(pool, Some(caller_id_text.as_str())).await?;
    let is_collab_bot = caller_identity.is_some()
        || sqlx::query_scalar::<_, i64>(
            "SELECT 1 FROM collaboration_space_members WHERE conversation_id = ? AND kind = 'agent' LIMIT 1",
        )
        .bind(&caller_id_text)
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
    let mut lead_member_id = None;
    if is_collab_bot {
        // The identity, not the calling session title, owns the display name:
        // the same bot must keep one name/avatar across DM and group seats.
        let identity_name = match caller_identity.as_deref() {
            Some(member_id) => identity::load_member(pool, member_id)
                .await
                .map_err(db)?
                .map(|member| member.name),
            None => None,
        };
        let nickname = identity_name
            .filter(|name| !name.trim().is_empty())
            .or_else(|| caller.name.filter(|name| !name.trim().is_empty()))
            .unwrap_or_else(|| "会话".to_string());
        let seat = insert_member_with(
            pool,
            &space_id,
            Some(caller_id),
            &nickname,
            "agent",
            true,
            SeatMode::PerThread,
        )
        .await?;
        // The creator owns the space it just created.
        set_space_lead(pool, &space_id, Some(&seat.member_id)).await?;
        lead_member_id = Some(seat.member_id);
    }
    let record = SpaceRecord {
        space_id,
        name,
        workspace_id: caller.workspace_id,
        lead_member_id,
        collection_dir: None,
    }
    .with_collection_dir();
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
        collection_dir: None,
    }
    .with_collection_dir();
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
        collection_dir: None,
    }
    .with_collection_dir())
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
        .map(|(space_id, name, lead_member_id)| {
            SpaceRecord {
                space_id,
                name,
                workspace_id,
                lead_member_id: lead_member_id.filter(|id| !id.trim().is_empty()),
                collection_dir: None,
            }
            .with_collection_dir()
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
                    let phase = if turn_status == "blocked" {
                        crate::workbench_status::turn_phase(turn_status)
                    } else if turn_in_flight_flag != 0 {
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

/// Delete a group. Members keep their identities and private chats.
pub async fn delete_collaboration_space(
    pool: &SqlitePool,
    caller_id: Uuid,
    space_id: &str,
    operation_id: Uuid,
) -> Result<Value, CollaborationError> {
    // A successful delete removes every seat, including the caller's, so the
    // replay check must run before any membership validation.
    if let Some(stored) = load_stored_operation(pool, &operation_id.to_string()).await? {
        let matches_space = serde_json::from_str::<Value>(&stored.request_json)
            .ok()
            .and_then(|request| request.get("space_ids").and_then(Value::as_array).cloned())
            .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(space_id)));
        if matches_space {
            return Ok(stored.result);
        }
        return Err(operation_conflict());
    }
    require_group_space(space_id)?;
    let (seat, lead, created_by) = load_caller_seat_in_space(pool, caller_id, space_id).await?;
    require_roster_admin(
        pool,
        &seat,
        lead.as_deref(),
        created_by.as_deref(),
        caller_id,
    )
    .await?;
    let space = load_space(pool, space_id).await?;
    let workspace_id = Uuid::parse_str(&space.workspace_id)
        .map_err(|_| CollaborationError::new("not_found", "space was not found"))?;
    let result = host_batch_delete_space_items(
        pool,
        workspace_id,
        vec![space_id.to_string()],
        Vec::new(),
        operation_id,
    )
    .await?;
    serde_json::to_value(result)
        .map_err(|error| CollaborationError::new("conversation_control_failed", error.to_string()))
}
