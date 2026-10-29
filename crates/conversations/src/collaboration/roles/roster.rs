use db::models::collaboration_identity::{self as identity};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::*;

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

/// Input for creating a bot identity on behalf of a caller. The new member
/// always starts in the unassigned (private-chat) space; join groups later with
/// [`add_space_member`].
#[derive(Debug, Clone)]
pub struct CreateSpaceMemberRequest {
    pub nickname: String,
    pub role_id: Option<String>,
    pub agent_id: Option<String>,
    pub team_id: Option<String>,
    pub mode_id: Option<String>,
    pub config_values: Option<Value>,
    pub persona_prompt: Option<String>,
    pub operation_id: Uuid,
}

/// Create a bot identity plus its private-chat session for `caller_id`.
pub async fn create_space_member(
    pool: &SqlitePool,
    caller_id: Uuid,
    input: CreateSpaceMemberRequest,
) -> Result<Value, CollaborationError> {
    let caller = live_session(load_session(pool, caller_id).await?)?;
    let agent_id = input
        .agent_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| caller.agent_id.clone());
    let record = host_create_space_member(
        pool,
        HostCreateSpaceMember {
            workspace_id: caller.workspace_id,
            space_id: None,
            nickname: input.nickname,
            role_id: input.role_id,
            agent_id,
            team_id: input.team_id,
            persona_prompt: input.persona_prompt,
            mode_id: input.mode_id,
            config_values: input.config_values,
            operation_id: input.operation_id,
        },
    )
    .await?;
    let mut value = space_member_tool_value(pool, &record).await?;
    if let Some(object) = value.as_object_mut() {
        object.insert(
            "space_id".into(),
            json!(unassigned_space_id(caller.workspace_id)),
        );
        if let Some(identity) = object
            .get("identity_member_id")
            .and_then(Value::as_str)
            .map(str::to_string)
        {
            object.insert(
                "direct_thread_id".into(),
                json!(identity::direct_thread_id(&identity)),
            );
        }
    }
    Ok(value)
}

pub(crate) async fn load_caller_seat_in_space(
    pool: &SqlitePool,
    caller_id: Uuid,
    space_id: &str,
) -> Result<(MemberRecord, Option<String>, Option<String>), CollaborationError> {
    let space = load_space_or_unassigned(pool, space_id).await?;
    let caller = live_session(load_session(pool, caller_id).await?)?;
    if caller.workspace_id.to_string() != space.workspace_id {
        return Err(CollaborationError::new("not_found", "space was not found"));
    }
    let seat = caller_seat(pool, space_id, caller_id).await?;
    if seat.kind != "agent" {
        return Err(CollaborationError::new(
            "forbidden",
            "user seats cannot manage the roster",
        ));
    }
    let (lead, created_by) = if parse_unassigned_space_id(space_id).is_some() {
        (None, None)
    } else {
        sqlx::query_as::<_, (Option<String>, Option<String>)>(
            "SELECT lead_member_id, created_by_conversation_id FROM collaboration_spaces WHERE id = ?",
        )
        .bind(space_id)
        .fetch_one(pool)
        .await
        .map_err(db)?
    };
    Ok((seat, lead, created_by))
}

pub(crate) fn require_group_space(space_id: &str) -> Result<(), CollaborationError> {
    if parse_unassigned_space_id(space_id).is_some() {
        return Err(CollaborationError::new(
            "invalid_argument",
            "this action requires a group space",
        ));
    }
    Ok(())
}

pub(crate) async fn require_roster_admin(
    pool: &SqlitePool,
    seat: &MemberRecord,
    lead: Option<&str>,
    created_by: Option<&str>,
    caller_id: Uuid,
) -> Result<(), CollaborationError> {
    if lead == Some(seat.member_id.as_str()) {
        return Ok(());
    }
    if lead.is_some() {
        return Err(CollaborationError::new(
            "forbidden",
            "only the group lead can manage the roster",
        ));
    }
    // The creator is recorded on the conversation that created the group
    // (usually the creator's private chat), while roster calls arrive from its
    // group seat. Compare identities, not conversation ids.
    let caller_identity =
        identity_member_id_for_conversation(pool, seat.conversation_id.as_deref()).await?;
    let creator_identity = identity_member_id_for_conversation(pool, created_by).await?;
    let caller_text = caller_id.to_string();
    let is_creator = match (caller_identity.as_deref(), creator_identity.as_deref()) {
        (Some(caller), Some(creator)) => caller == creator,
        _ => created_by == Some(caller_text.as_str()),
    };
    if is_creator {
        Ok(())
    } else {
        Err(CollaborationError::new(
            "forbidden",
            "only the group lead can manage the roster",
        ))
    }
}

/// Roster admin rights in at least one of the given groups. Used when a bot is
/// deleted through the unassigned space while it still belongs to groups.
pub(crate) async fn require_admin_in_any_space(
    pool: &SqlitePool,
    caller_id: Uuid,
    space_ids: &[String],
) -> Result<(), CollaborationError> {
    let caller_conversation = caller_id.to_string();
    for space_id in space_ids {
        let members = list_space_members(pool, space_id, MessageAudience::Agent).await?;
        let Some(seat) = members
            .iter()
            .find(|member| member.conversation_id.as_deref() == Some(caller_conversation.as_str()))
        else {
            continue;
        };
        let (lead, created_by): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT lead_member_id, created_by_conversation_id FROM collaboration_spaces WHERE id = ?",
        )
        .bind(space_id)
        .fetch_one(pool)
        .await
        .map_err(db)?;
        if require_roster_admin(
            pool,
            seat,
            lead.as_deref(),
            created_by.as_deref(),
            caller_id,
        )
        .await
        .is_ok()
        {
            return Ok(());
        }
    }
    Err(CollaborationError::new(
        "forbidden",
        "only a group lead can delete a member who still belongs to a group",
    ))
}

/// Resolve a roster member reference: a per-space seat id, an identity id, or
/// the seat's hidden conversation id.
pub(crate) async fn resolve_space_agent_seat(
    pool: &SqlitePool,
    space_id: &str,
    member_ref: &str,
) -> Result<MemberRecord, CollaborationError> {
    let wanted = member_ref.trim();
    if wanted.is_empty() {
        return Err(CollaborationError::new(
            "invalid_argument",
            "member_id is required",
        ));
    }
    let members = list_space_members(pool, space_id, MessageAudience::Agent).await?;
    if let Some(seat) = members.iter().find(|member| member.member_id == wanted) {
        return Ok(seat.clone());
    }
    if let Some(seat) = members
        .iter()
        .find(|member| member.conversation_id.as_deref() == Some(wanted))
    {
        return Ok(seat.clone());
    }
    for seat in &members {
        let identity =
            identity_member_id_for_conversation(pool, seat.conversation_id.as_deref()).await?;
        if identity.as_deref() == Some(wanted) {
            return Ok(seat.clone());
        }
    }
    if let Some(seat) = members.iter().find(|member| member.nickname == wanted) {
        return Ok(seat.clone());
    }
    Err(CollaborationError::new(
        "not_found",
        "member was not found in this space",
    ))
}

/// Resolve a member reference (identity id, seat id, or conversation id) to the
/// workspace-wide bot identity used by `delete_space_member`.
pub(crate) async fn resolve_identity_member_id(
    pool: &SqlitePool,
    member_ref: &str,
) -> Result<Option<String>, CollaborationError> {
    let wanted = member_ref.trim();
    if wanted.is_empty() {
        return Err(CollaborationError::new(
            "invalid_argument",
            "member_id is required",
        ));
    }
    let is_identity: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM collaboration_members WHERE id = ? LIMIT 1")
            .bind(wanted)
            .fetch_optional(pool)
            .await
            .map_err(db)?;
    if is_identity.is_some() {
        return Ok(Some(wanted.to_string()));
    }
    if let Some(identity) = identity_member_id_for_conversation(pool, Some(wanted)).await? {
        return Ok(Some(identity));
    }
    let seat_conversation: Option<String> = sqlx::query_scalar(
        "SELECT conversation_id FROM collaboration_space_members WHERE member_id = ? LIMIT 1",
    )
    .bind(wanted)
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    match seat_conversation {
        Some(conversation) => identity_member_id_for_conversation(pool, Some(&conversation)).await,
        None => Ok(None),
    }
}
