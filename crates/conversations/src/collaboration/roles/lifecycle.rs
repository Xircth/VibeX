use db::models::collaboration_identity::{self as identity};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::*;

/// Transfer the group lead to another agent member. The workspace supervisor
/// or current group lead may hand it to anyone; a group without a lead may be
/// claimed by any agent member.
pub async fn transfer_space_lead(
    pool: &SqlitePool,
    caller_id: Uuid,
    space_id: &str,
    member_ref: &str,
    operation_id: Uuid,
) -> Result<Value, CollaborationError> {
    if let Some(stored) = load_stored_operation(pool, &operation_id.to_string()).await? {
        if stored.space_id.as_deref() == Some(space_id) {
            return decode_replay(stored.result);
        }
        return Err(operation_conflict());
    }
    require_group_space(space_id)?;
    let space = load_space(pool, space_id).await?;
    let caller = live_session(load_session(pool, caller_id).await?)?;
    if caller.workspace_id.to_string() != space.workspace_id {
        return Err(CollaborationError::new("not_found", "space was not found"));
    }
    let is_supervisor = is_caller_workspace_supervisor(pool, caller_id).await?;
    let caller_seat_id = if is_supervisor {
        caller_seat(pool, space_id, caller_id)
            .await
            .ok()
            .map(|s| s.member_id)
    } else {
        let (seat, lead, _) = load_caller_seat_in_space(pool, caller_id, space_id).await?;
        if let Some(lead_id) = lead.as_deref()
            && lead_id != seat.member_id
        {
            return Err(CollaborationError::new(
                "forbidden",
                "only the supervisor (主管) or group lead can transfer ownership",
            ));
        }
        Some(seat.member_id)
    };
    let target = resolve_space_agent_seat(pool, space_id, member_ref).await?;
    if caller_seat_id.as_deref() != Some(target.member_id.as_str()) || is_supervisor {
        set_space_lead(pool, space_id, Some(&target.member_id)).await?;
    }
    let outcome = json!({
        "space_id": space_id,
        "lead_member_id": target.member_id,
        "lead_nickname": target.nickname,
        "identity_member_id": identity_member_id_for_conversation(
            pool,
            target.conversation_id.as_deref(),
        )
        .await?,
    });
    let request =
        json!({ "action": "transfer_lead", "space_id": space_id, "member_id": member_ref });
    store_operation(
        pool,
        &operation_id.to_string(),
        Some(space_id),
        &request,
        &outcome,
    )
    .await?;
    Ok(outcome)
}

/// Move one seat out of a group and into the unassigned space without touching
/// the identity or its private chat. Returns the resulting unassigned seat and
/// the seat id that was removed from the group.
pub(crate) async fn detach_group_seat(
    pool: &SqlitePool,
    space_id: &str,
    seat: &MemberRecord,
    operation_id: Uuid,
) -> Result<(MemberRecord, Option<String>), CollaborationError> {
    let seat_conversation = seat
        .conversation_id
        .as_deref()
        .ok_or_else(|| CollaborationError::new("not_found", "member was not found"))?;
    let conversation_id = Uuid::parse_str(seat_conversation)
        .map_err(|_| CollaborationError::new("not_found", "member was not found"))?;
    let space = load_space(pool, space_id).await?;
    let workspace_id = Uuid::parse_str(&space.workspace_id)
        .map_err(|_| CollaborationError::new("not_found", "space was not found"))?;
    let identity_member_id =
        identity_member_id_for_conversation(pool, Some(seat_conversation)).await?;
    // A deterministic sub-operation id keeps the move idempotent while the
    // outer tool keeps its own replay record.
    let move_operation = Uuid::new_v5(
        &Uuid::NAMESPACE_OID,
        format!("{operation_id}:detach-seat").as_bytes(),
    );
    let moved = host_move_space_member(
        pool,
        space_id,
        &unassigned_space_id(workspace_id),
        conversation_id,
        Some(seat.nickname.as_str()),
        move_operation,
    )
    .await?;
    Ok((moved, identity_member_id))
}

/// Leave a group: the caller keeps its identity and private chat.
pub async fn leave_space(
    pool: &SqlitePool,
    caller_id: Uuid,
    space_id: &str,
    operation_id: Uuid,
) -> Result<Value, CollaborationError> {
    if let Some(stored) = load_stored_operation(pool, &operation_id.to_string()).await? {
        if stored.space_id.as_deref() == Some(space_id) {
            return decode_replay(stored.result);
        }
        return Err(operation_conflict());
    }
    require_group_space(space_id)?;
    let (seat, lead, _) = load_caller_seat_in_space(pool, caller_id, space_id).await?;
    let was_lead = lead.as_deref() == Some(seat.member_id.as_str());
    let (moved, identity_member_id) =
        detach_group_seat(pool, space_id, &seat, operation_id).await?;
    if was_lead {
        set_space_lead(pool, space_id, None).await?;
    }
    bump_space_generation(pool, space_id).await?;
    let outcome = json!({
        "left": true,
        "space_id": space_id,
        "member_id": seat.member_id,
        "identity_member_id": identity_member_id,
        "private_conversation_id": moved.conversation_id,
    });
    let request = json!({ "action": "leave_space", "space_id": space_id });
    store_operation(
        pool,
        &operation_id.to_string(),
        Some(space_id),
        &request,
        &outcome,
    )
    .await?;
    Ok(outcome)
}

/// Remove another bot from a group. Its identity and private chat are kept.
pub async fn remove_space_member(
    pool: &SqlitePool,
    caller_id: Uuid,
    space_id: &str,
    member_ref: &str,
    operation_id: Uuid,
) -> Result<Value, CollaborationError> {
    if let Some(stored) = load_stored_operation(pool, &operation_id.to_string()).await? {
        if stored.space_id.as_deref() == Some(space_id) {
            return decode_replay(stored.result);
        }
        return Err(operation_conflict());
    }
    require_group_space(space_id)?;
    let space = load_space(pool, space_id).await?;
    let caller = live_session(load_session(pool, caller_id).await?)?;
    if caller.workspace_id.to_string() != space.workspace_id {
        return Err(CollaborationError::new("not_found", "space was not found"));
    }
    let is_supervisor = is_caller_workspace_supervisor(pool, caller_id).await?;
    let (caller_seat_id, lead) = if is_supervisor {
        let lead: Option<String> = sqlx::query_scalar::<_, Option<String>>(
            "SELECT lead_member_id FROM collaboration_spaces WHERE id = ?",
        )
        .bind(space_id)
        .fetch_one(pool)
        .await
        .map_err(db)?;
        let seat_id = caller_seat(pool, space_id, caller_id)
            .await
            .ok()
            .map(|s| s.member_id);
        (seat_id, lead)
    } else {
        let (caller_seat, lead, created_by) =
            load_caller_seat_in_space(pool, caller_id, space_id).await?;
        require_roster_admin(
            pool,
            &caller_seat,
            lead.as_deref(),
            created_by.as_deref(),
            caller_id,
        )
        .await?;
        (Some(caller_seat.member_id), lead)
    };
    let target = resolve_space_agent_seat(pool, space_id, member_ref).await?;
    let caller_identity =
        identity_member_id_for_conversation(pool, Some(&caller_id.to_string())).await?;
    let target_identity =
        identity_member_id_for_conversation(pool, target.conversation_id.as_deref()).await?;
    if caller_seat_id.as_deref() == Some(target.member_id.as_str())
        || (caller_identity.is_some() && caller_identity == target_identity)
    {
        return Err(CollaborationError::new(
            "invalid_argument",
            "use leave_space to remove yourself",
        ));
    }
    let was_lead = lead.as_deref() == Some(target.member_id.as_str());
    let (moved, identity_member_id) =
        detach_group_seat(pool, space_id, &target, operation_id).await?;
    if was_lead {
        set_space_lead(pool, space_id, None).await?;
    }
    bump_space_generation(pool, space_id).await?;
    let outcome = json!({
        "removed": true,
        "space_id": space_id,
        "member_id": target.member_id,
        "nickname": target.nickname,
        "identity_member_id": identity_member_id,
        "private_conversation_id": moved.conversation_id,
    });
    let request = json!({
        "action": "remove_space_member",
        "space_id": space_id,
        "member_id": member_ref,
    });
    store_operation(
        pool,
        &operation_id.to_string(),
        Some(space_id),
        &request,
        &outcome,
    )
    .await?;
    Ok(outcome)
}

/// Delete another bot from the workspace: every group seat, every hidden
/// session, and the identity row. Only the workspace supervisor bot (主管) is
/// allowed to delete bots, and a supervisor bot cannot be deleted.
pub async fn delete_space_member(
    pool: &SqlitePool,
    caller_id: Uuid,
    space_id: &str,
    member_ref: &str,
    operation_id: Uuid,
) -> Result<Value, CollaborationError> {
    if let Some(stored) = load_stored_operation(pool, &operation_id.to_string()).await? {
        if stored.space_id.as_deref() == Some(space_id) {
            return decode_replay(stored.result);
        }
        return Err(operation_conflict());
    }
    let space = load_space_or_unassigned(pool, space_id).await?;
    let caller = live_session(load_session(pool, caller_id).await?)?;
    if caller.workspace_id.to_string() != space.workspace_id {
        return Err(CollaborationError::new("not_found", "space was not found"));
    }
    require_workspace_supervisor(pool, caller_id, "delete bots (删除其他 Bot)").await?;

    let unassigned = parse_unassigned_space_id(space_id).is_some()
        || space_id.starts_with(identity::DIRECT_PREFIX);
    let caller_identity =
        identity_member_id_for_conversation(pool, Some(&caller_id.to_string())).await?;
    let (target_member_id, target_nickname, identity_member_id, target_conversation) = if unassigned
    {
        let resolved_identity = match resolve_identity_member_id(pool, member_ref).await? {
            Some(id) => id,
            None => {
                let (conv_id, _) =
                    resolve_bot_conversation(pool, caller_id, space_id, member_ref).await?;
                identity_member_id_for_conversation(pool, Some(&conv_id.to_string()))
                    .await?
                    .ok_or_else(|| CollaborationError::new("not_found", "member was not found"))?
            }
        };
        if caller_identity.as_deref() == Some(resolved_identity.as_str()) {
            return Err(CollaborationError::new(
                "invalid_argument",
                "use leave_space to remove yourself",
            ));
        }
        let nickname: String =
            sqlx::query_scalar("SELECT name FROM collaboration_members WHERE id = ?")
                .bind(&resolved_identity)
                .fetch_one(pool)
                .await
                .map_err(db)?;
        (resolved_identity.clone(), nickname, resolved_identity, None)
    } else {
        let target = resolve_space_agent_seat(pool, space_id, member_ref).await?;
        let target_conversation = target
            .conversation_id
            .as_deref()
            .and_then(|raw| Uuid::parse_str(raw).ok())
            .ok_or_else(|| CollaborationError::new("not_found", "member was not found"))?
            .to_string();
        let target_identity: Option<(String,)> = sqlx::query_as(
            "SELECT member_id FROM collaboration_thread_members WHERE conversation_id = ? LIMIT 1",
        )
        .bind(&target_conversation)
        .fetch_optional(pool)
        .await
        .map_err(db)?;
        let identity_member_id = match target_identity {
            Some((member_id,)) => member_id,
            None => identity_member_id_for_conversation(pool, Some(&target_conversation))
                .await?
                .ok_or_else(|| {
                    CollaborationError::new("not_found", "member identity was not found")
                })?,
        };
        if caller_identity.as_deref() == Some(identity_member_id.as_str()) {
            return Err(CollaborationError::new(
                "invalid_argument",
                "use leave_space to remove yourself",
            ));
        }
        (
            target.member_id,
            target.nickname,
            identity_member_id,
            Some(target_conversation),
        )
    };
    if is_member_supervisor(pool, &identity_member_id).await? {
        return Err(CollaborationError::new(
            "forbidden",
            "supervisor bot cannot be deleted; step down first (主管 Bot 不能删除，请先卸任主管)",
        ));
    }
    let mut conversations: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT conversation_id FROM collaboration_thread_members WHERE member_id = ?",
    )
    .bind(&identity_member_id)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    if let Some(conversation) = target_conversation
        && !conversations.contains(&conversation)
    {
        conversations.push(conversation);
    }
    conversations.sort();
    conversations.dedup();

    let mut seats: Vec<(String, String)> = Vec::new();
    for conversation in &conversations {
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT space_id, member_id FROM collaboration_space_members WHERE conversation_id = ?",
        )
        .bind(conversation)
        .fetch_all(pool)
        .await
        .map_err(db)?;
        seats.extend(rows);
    }
    // Legacy seats may store the identity id as the seat id and have no
    // conversation binding; catch those too.
    let identity_seats: Vec<(String, String)> = sqlx::query_as(
        "SELECT space_id, member_id FROM collaboration_space_members WHERE member_id = ?",
    )
    .bind(&identity_member_id)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    seats.extend(identity_seats);
    if !seats.iter().any(|(sid, _)| sid == space_id) {
        seats.push((space_id.to_string(), target_member_id.clone()));
    }
    seats.sort();
    seats.dedup();

    let mut affected_spaces: Vec<String> = Vec::new();
    let mut space_seat_ids: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    for (sid, seat_id) in &seats {
        if parse_unassigned_space_id(sid).is_some() || sid.starts_with(identity::DIRECT_PREFIX) {
            continue;
        }
        if !affected_spaces.contains(sid) {
            affected_spaces.push(sid.clone());
        }
        space_seat_ids
            .entry(sid.clone())
            .or_default()
            .push(seat_id.clone());
    }
    affected_spaces.sort();
    let direct_thread_id = identity::direct_thread_id(&identity_member_id);
    let stamp = now_stamp();
    let mut conn = pool.acquire().await.map_err(db)?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    let outcome = async {
        for (sid, seat_id) in &seats {
            sqlx::query(
                "DELETE FROM collaboration_space_members WHERE space_id = ? AND member_id = ?",
            )
            .bind(sid)
            .bind(seat_id)
            .execute(&mut *conn)
            .await?;
        }
        for conversation in &conversations {
            sqlx::query(
                "DELETE FROM collaboration_space_prompt_injections WHERE conversation_id = ?",
            )
            .bind(conversation)
            .execute(&mut *conn)
            .await?;
            if let Ok(conv_id) = Uuid::parse_str(conversation) {
                sqlx::query(
                    "UPDATE sessions SET status = 'archived', updated_at = datetime('now', 'subsec') WHERE id = ?",
                )
                .bind(conv_id)
                .execute(&mut *conn)
                .await?;
            }
        }
        for sid in &affected_spaces {
            let generation = bump_space_generation_tx(&mut conn, sid).await?;
            let current_lead: Option<String> =
                sqlx::query_scalar("SELECT lead_member_id FROM collaboration_spaces WHERE id = ?")
                    .bind(sid)
                    .fetch_optional(&mut *conn)
                    .await?
                    .flatten();
            let cleared = current_lead.as_deref().is_some_and(|lead_id| {
                space_seat_ids
                    .get(sid)
                    .is_some_and(|ids| ids.iter().any(|id| id == lead_id))
            });
            if cleared {
                sqlx::query("UPDATE collaboration_spaces SET lead_member_id = NULL WHERE id = ?")
                    .bind(sid)
                    .execute(&mut *conn)
                    .await?;
                append_space_event_tx(
                    &mut conn,
                    sid,
                    "roster",
                    None,
                    &json!({ "action": "lead_changed", "lead_member_id": null }),
                    &stamp,
                )
                .await?;
            }
            append_space_event_tx(
                &mut conn,
                sid,
                "roster",
                None,
                &json!({
                    "action": "member_removed",
                    "identity_member_id": identity_member_id,
                    "space_member_ids": space_seat_ids.get(sid),
                    "generation": generation,
                }),
                &stamp,
            )
            .await?;
        }
        sqlx::query("DELETE FROM collaboration_thread_reads WHERE thread_id = ?")
            .bind(&direct_thread_id)
            .execute(&mut *conn)
            .await?;
        sqlx::query("DELETE FROM collaboration_thread_members WHERE member_id = ?")
            .bind(&identity_member_id)
            .execute(&mut *conn)
            .await?;
        sqlx::query("DELETE FROM collaboration_threads WHERE id = ?")
            .bind(&direct_thread_id)
            .execute(&mut *conn)
            .await?;
        sqlx::query("DELETE FROM collaboration_members WHERE id = ?")
            .bind(&identity_member_id)
            .execute(&mut *conn)
            .await?;
        Ok::<(), CollaborationError>(())
    }
    .await;
    finish_tx(&mut conn, outcome).await?;
    drop(conn);

    let result = json!({
        "deleted": true,
        "space_id": space_id,
        "member_id": target_member_id,
        "nickname": target_nickname,
        "identity_member_id": identity_member_id,
        "archived_conversation_ids": conversations,
        "affected_space_ids": affected_spaces,
    });
    let request = json!({
        "action": "delete_space_member",
        "space_id": space_id,
        "member_id": member_ref,
    });
    store_operation(
        pool,
        &operation_id.to_string(),
        Some(space_id),
        &request,
        &result,
    )
    .await?;
    Ok(result)
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

async fn existing_isolated_workspace_id(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Option<Uuid>, CollaborationError> {
    let recorded: Option<String> = sqlx::query_scalar(
        "SELECT isolated_workspace_id FROM member_session_workspaces WHERE conversation_id = ?",
    )
    .bind(conversation_id.to_string())
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    if let Some(id) = recorded.and_then(|raw| Uuid::parse_str(&raw).ok()) {
        return Ok(Some(id));
    }
    let deterministic = member_worktree_workspace_id(conversation_id);
    let deterministic_exists: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM workspaces WHERE id = ?")
            .bind(deterministic)
            .fetch_optional(pool)
            .await
            .map_err(db)?;
    if deterministic_exists.is_some() {
        return Ok(Some(deterministic));
    }
    Ok(None)
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
    let existing_isolated = existing_isolated_workspace_id(pool, conversation_id).await?;
    let Some(plan) = plan_member_write(pool, conversation_id).await? else {
        return Ok(existing_isolated.unwrap_or(session_workspace_id));
    };
    if plan.access != MemberWriteAccess::WriteIsolated {
        return Ok(session_workspace_id);
    }
    if let Some(existing) = plan.isolated_workspace_id.or(existing_isolated) {
        return Ok(existing);
    }
    if plan.primary {
        return Ok(session_workspace_id);
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
