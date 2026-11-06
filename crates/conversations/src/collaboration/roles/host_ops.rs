use agents::AgentId;
use db::models::{
    collaboration_identity::{self as identity},
    session::{CreateSession, Session},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::*;
use crate::remember_creation_session_controls;

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
        let resolved_persona = match input.persona_prompt.as_ref() {
            Some(prompt) => prompt.clone(),
            None => role.persona_prompt.clone(),
        };
        (
            role.mode_id.clone(),
            role.config_values.clone(),
            resolved_persona,
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
    let mut clean_config_values = config_values.clone();
    if let Some(obj) = clean_config_values.as_object_mut() {
        obj.remove("avatar");
        obj.remove("color");
        obj.remove("is_supervisor");
        obj.remove("isSupervisor");
    }
    let overrides = config_overrides(&clean_config_values);
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
    let explicit_supervisor = input.config_values.as_ref().and_then(|cfg| {
        cfg.get("is_supervisor")
            .or_else(|| cfg.get("isSupervisor"))
            .and_then(Value::as_bool)
    });
    let should_make_supervisor = match explicit_supervisor {
        Some(flag) => flag,
        None if nickname.eq_ignore_ascii_case("master") => {
            let member_count: i64 = sqlx::query_scalar(
                r#"SELECT COUNT(DISTINCT tm.member_id)
                   FROM collaboration_thread_members tm
                   JOIN collaboration_threads t ON t.id = tm.thread_id
                   WHERE t.workspace_id = ? AND tm.status = 'active'"#,
            )
            .bind(input.workspace_id.to_string())
            .fetch_one(pool)
            .await
            .map_err(db)?;
            member_count <= 1
                && crate::collaboration_sidebar::workspace_supervisor_member(
                    pool,
                    input.workspace_id,
                )
                .await?
                .is_none()
        }
        None => false,
    };
    if should_make_supervisor {
        let _ = crate::collaboration_sidebar::set_workspace_supervisor(
            pool,
            input.workspace_id,
            Some(&member_id),
        )
        .await?;
    }
    write_member_session_config(
        pool,
        &member_id,
        &MemberSessionConfig {
            agent_id: Some(agent_raw.clone()),
            mode_id: mode_id.clone(),
            config_values: clean_config_values,
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

    for target in &member_targets {
        let is_direct_target = parse_unassigned_space_id(&target.space_id).is_some()
            || target.space_id.starts_with(identity::DIRECT_PREFIX);
        if !is_direct_target {
            continue;
        }
        let pre_binding = identity::binding_of_conversation(pool, target.conversation_id)
            .await
            .map_err(db)?;
        let identity_member_id = match pre_binding.as_ref() {
            Some(b) => Some(b.member_id.clone()),
            None => target
                .space_id
                .strip_prefix(identity::DIRECT_PREFIX)
                .map(str::to_string)
                .or_else(|| Some(identity::member_id_for_conversation(target.conversation_id))),
        };
        if let Some(ref mid) = identity_member_id
            && is_member_supervisor(pool, mid).await?
        {
            return Err(CollaborationError::new(
                "forbidden",
                "supervisor bot cannot be deleted; step down first (主管 Bot 不能删除，请先卸任主管)",
            ));
        }
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
        let affected_spaces: Vec<String> = if is_direct_target {
            sqlx::query_scalar(
                r#"SELECT DISTINCT space_id FROM collaboration_space_members
                   WHERE conversation_id = ?
                     AND space_id IN (SELECT id FROM collaboration_spaces WHERE workspace_id = ?)"#,
            )
            .bind(target.conversation_id.to_string())
            .bind(workspace_id.to_string())
            .fetch_all(pool)
            .await
            .map_err(db)?
        } else if deleting_space_set.contains(&target.space_id) {
            Vec::new()
        } else {
            vec![target.space_id.clone()]
        };
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
                if is_direct_target {
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
                }
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
