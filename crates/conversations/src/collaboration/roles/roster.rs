use agents::AgentId;
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
    if parse_unassigned_space_id(space_id).is_none()
        && !space_id.starts_with(identity::DIRECT_PREFIX)
    {
        let space_meta: Option<(Option<String>, Option<String>)> = sqlx::query_as(
            "SELECT created_by_conversation_id, lead_member_id FROM collaboration_spaces WHERE id = ?",
        )
        .bind(space_id)
        .fetch_optional(pool)
        .await
        .map_err(db)?;
        if let Some((created_by, current_lead)) = space_meta {
            let is_user_created = created_by
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .is_none();
            if is_user_created {
                let has_lead = current_lead
                    .as_deref()
                    .map(str::trim)
                    .is_some_and(|s| !s.is_empty());
                let is_sup = match identity_member_id_for_conversation(
                    pool,
                    record.conversation_id.as_deref(),
                )
                .await?
                {
                    Some(mid) => is_member_supervisor(pool, &mid).await?,
                    None => false,
                };
                let has_messages = sqlx::query_scalar::<_, i64>(
                    "SELECT 1 FROM collaboration_space_messages WHERE space_id = ? LIMIT 1",
                )
                .bind(space_id)
                .fetch_optional(pool)
                .await
                .map_err(db)?
                .is_some();
                if !has_messages && (!has_lead || is_sup) {
                    set_space_lead(pool, space_id, Some(&record.member_id)).await?;
                }
            }
        }
    }
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
/// Only the workspace supervisor bot (主管) is allowed to create new bots.
pub async fn create_space_member(
    pool: &SqlitePool,
    caller_id: Uuid,
    input: CreateSpaceMemberRequest,
) -> Result<Value, CollaborationError> {
    let caller = live_session(load_session(pool, caller_id).await?)?;
    require_workspace_supervisor(pool, caller_id, "create new bots (创建新 Bot)").await?;
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

pub async fn is_member_supervisor(
    pool: &SqlitePool,
    member_id: &str,
) -> Result<bool, CollaborationError> {
    let flag: Option<i64> =
        sqlx::query_scalar("SELECT is_supervisor FROM collaboration_members WHERE id = ?")
            .bind(member_id.trim())
            .fetch_optional(pool)
            .await
            .map_err(db)?;
    Ok(flag.unwrap_or(0) != 0)
}

pub async fn is_caller_workspace_supervisor(
    pool: &SqlitePool,
    caller_id: Uuid,
) -> Result<bool, CollaborationError> {
    let caller_str = caller_id.to_string();
    let Some(identity_id) = identity_member_id_for_conversation(pool, Some(&caller_str)).await?
    else {
        return Ok(false);
    };
    is_member_supervisor(pool, &identity_id).await
}

pub async fn require_workspace_supervisor(
    pool: &SqlitePool,
    caller_id: Uuid,
    action_label: &str,
) -> Result<(), CollaborationError> {
    if is_caller_workspace_supervisor(pool, caller_id).await? {
        return Ok(());
    }
    Err(CollaborationError::new(
        "forbidden",
        format!(
            "only the supervisor bot (主管) can {action_label}; ask the supervisor or Person instead"
        ),
    ))
}

pub async fn require_supervisor_or_group_admin(
    pool: &SqlitePool,
    caller_id: Uuid,
    space_id: &str,
) -> Result<(), CollaborationError> {
    require_group_space(space_id)?;
    let space = load_space(pool, space_id).await?;
    let caller = live_session(load_session(pool, caller_id).await?)?;
    if caller.workspace_id.to_string() != space.workspace_id {
        return Err(CollaborationError::new("not_found", "space was not found"));
    }
    if is_caller_workspace_supervisor(pool, caller_id).await? {
        return Ok(());
    }
    let (seat, lead, created_by) = load_caller_seat_in_space(pool, caller_id, space_id).await?;
    require_roster_admin(
        pool,
        &seat,
        lead.as_deref(),
        created_by.as_deref(),
        caller_id,
    )
    .await
}

pub(crate) async fn require_roster_admin(
    pool: &SqlitePool,
    seat: &MemberRecord,
    lead: Option<&str>,
    created_by: Option<&str>,
    caller_id: Uuid,
) -> Result<(), CollaborationError> {
    if is_caller_workspace_supervisor(pool, caller_id).await? {
        return Ok(());
    }
    if lead == Some(seat.member_id.as_str()) {
        return Ok(());
    }
    if lead.is_some() {
        return Err(CollaborationError::new(
            "forbidden",
            "only the supervisor (主管) or group lead can manage the roster",
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
            "only the supervisor (主管) or group lead can manage the roster",
        ))
    }
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

pub const THINKING_CONFIG_KEYS: &[&str] = &[
    "thinking_level",
    "effort",
    "reasoning_effort",
    "thought_level",
    "thinking",
];

fn config_string_value(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(s) => {
            let trimmed = s.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

pub fn extract_model_and_thinking(config_values: &Value) -> (Option<String>, Option<String>) {
    let Some(object) = config_values.as_object() else {
        return (None, None);
    };
    let model = config_string_value(object.get("model"));
    let thinking_level = THINKING_CONFIG_KEYS
        .iter()
        .find_map(|key| config_string_value(object.get(*key)));
    (model, thinking_level)
}

pub fn enrich_member_json_with_session_config(
    object: &mut serde_json::Map<String, Value>,
    config: Option<&MemberSessionConfig>,
) {
    let agent_id = config
        .and_then(|c| c.agent_id.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let mode_id = config
        .and_then(|c| c.mode_id.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let config_values = config
        .filter(|c| c.config_values.is_object())
        .map(|c| c.config_values.clone())
        .unwrap_or_else(|| json!({}));
    let (model, thinking_level) = extract_model_and_thinking(&config_values);
    object.insert("agent_id".into(), json!(agent_id));
    object.insert("mode_id".into(), json!(mode_id));
    object.insert("model".into(), json!(model));
    object.insert("thinking_level".into(), json!(thinking_level));
    object.insert("config_values".into(), config_values);
}

pub(crate) async fn attach_member_session_configs_to_rows(
    pool: &SqlitePool,
    rows: &mut [Value],
) -> Result<(), CollaborationError> {
    let mut identity_ids: Vec<String> = Vec::new();
    for row in rows.iter() {
        let is_agent = row
            .get("kind")
            .and_then(Value::as_str)
            .is_none_or(|kind| kind == "agent");
        if !is_agent {
            continue;
        }
        if let Some(id) = row
            .get("identity_member_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            && !identity_ids.iter().any(|existing| existing == id)
        {
            identity_ids.push(id.to_string());
        }
    }
    let mut configs = std::collections::HashMap::<String, MemberSessionConfig>::new();
    for member_id in identity_ids {
        if let Some(cfg) = load_member_session_config(pool, &member_id).await? {
            configs.insert(member_id, cfg);
        }
    }
    for row in rows.iter_mut() {
        let Some(object) = row.as_object_mut() else {
            continue;
        };
        let is_agent = object
            .get("kind")
            .and_then(Value::as_str)
            .is_none_or(|kind| kind == "agent");
        if !is_agent {
            continue;
        }
        let cfg = object
            .get("identity_member_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .and_then(|id| configs.get(id));
        enrich_member_json_with_session_config(object, cfg);
    }
    Ok(())
}

async fn load_latest_catalog_snapshot(
    pool: &SqlitePool,
    agent_id: &AgentId,
) -> Option<agents::AgentSessionControlsSnapshot> {
    if let Ok(Some(snapshot)) =
        crate::read_matching_capability_catalog_for_defaults(pool, agent_id).await
    {
        return Some(snapshot);
    }
    let raw: Option<String> = sqlx::query_scalar(
        r#"SELECT controls_json
           FROM agent_capability_catalog
           WHERE agent_type = ?
           ORDER BY retrieved_at DESC, generation DESC
           LIMIT 1"#,
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    raw.and_then(|json_str| serde_json::from_str(&json_str).ok())
}

fn is_thinking_option(opt: &agents::AgentSessionConfigOption) -> bool {
    opt.category.as_deref() == Some("thought_level")
        || matches!(
            opt.key.as_str(),
            "effort" | "reasoning_effort" | "thought_level" | "thinking_level" | "thinking"
        )
}

fn is_model_option(opt: &agents::AgentSessionConfigOption) -> bool {
    opt.category.as_deref() == Some("model") || opt.key == "model"
}

pub async fn resolve_agent_thinking_option_key(
    pool: &SqlitePool,
    agent_id: Option<&str>,
    caller_id: Option<Uuid>,
) -> String {
    let resolved_raw = match agent_id.map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => Some(raw.to_string()),
        None => match caller_id {
            Some(cid) => load_session(pool, cid)
                .await
                .ok()
                .flatten()
                .and_then(|s| s.agent_id),
            None => None,
        },
    };
    let Some(raw) = resolved_raw else {
        return "effort".to_string();
    };
    let Ok(parsed) = AgentId::parse(&raw) else {
        return "effort".to_string();
    };
    if let Some(snapshot) = load_latest_catalog_snapshot(pool, &parsed).await
        && let Some(opt) = snapshot
            .config_options
            .iter()
            .find(|opt| is_thinking_option(opt))
    {
        return opt.key.clone();
    }
    "effort".to_string()
}

/// Merge `base` config values with optional `config_values` overrides, `model`,
/// and `thinking_level`, writing the thinking value under `thinking_option_key`
/// and removing stale thinking synonym keys when `thinking_level` is set.
pub fn merge_bot_config_values(
    base: Option<&Value>,
    extra_config_values: Option<&Value>,
    model: Option<&str>,
    thinking_level: Option<&str>,
    thinking_option_key: &str,
) -> Value {
    let mut map = base.and_then(Value::as_object).cloned().unwrap_or_default();
    if let Some(extra) = extra_config_values.and_then(Value::as_object) {
        for (k, v) in extra {
            map.insert(k.clone(), v.clone());
        }
    }
    if let Some(model) = model.map(str::trim).filter(|s| !s.is_empty()) {
        map.insert("model".to_string(), json!(model));
    }
    if let Some(level) = thinking_level.map(str::trim).filter(|s| !s.is_empty()) {
        for key in THINKING_CONFIG_KEYS {
            map.remove(*key);
        }
        let target_key = if thinking_option_key.trim().is_empty() {
            "effort"
        } else {
            thinking_option_key.trim()
        };
        map.insert(target_key.to_string(), json!(level));
    }
    Value::Object(map)
}

/// Inspect installed/configured agent runtimes and their advertised modes,
/// models, thinking levels (reasoning effort), and session config options.
pub async fn list_available_bot_agents(
    pool: &SqlitePool,
    caller_id: Uuid,
    agent_id_filter: Option<&str>,
) -> Result<Value, CollaborationError> {
    let caller_agent_id = load_session(pool, caller_id)
        .await
        .ok()
        .flatten()
        .and_then(|s| s.agent_id);
    let filter = agent_id_filter.map(str::trim).filter(|s| !s.is_empty());

    let managed_views =
        services::services::agent_management::AgentManagementApplicationService::new(pool.clone())
            .list()
            .await
            .unwrap_or_default();

    let mut seen_ids = std::collections::HashSet::<String>::new();
    let mut entries = Vec::<Value>::new();

    for view in managed_views {
        let id_str = view.agent_id.as_str().to_string();
        if let Some(wanted) = filter
            && !id_str.eq_ignore_ascii_case(wanted)
        {
            continue;
        }
        seen_ids.insert(id_str.clone());
        let entry = build_bot_agent_catalog_entry(
            pool,
            &view.agent_id,
            &view.display_name,
            &view.description,
            view.enabled,
            serde_json::to_value(view.lifecycle).unwrap_or_else(|_| json!("unknown")),
            serde_json::to_value(view.authentication).unwrap_or_else(|_| json!("unknown")),
        )
        .await;
        entries.push(entry);
    }

    // Fallback: include any agent_type present in `agent_capability_catalog`
    // that was not already in `agent_membership` (e.g. lightweight test DBs).
    let extra_catalog_agents: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT agent_type FROM agent_capability_catalog ORDER BY agent_type",
    )
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    let profiles = agents::BuiltInProfileCatalog::management();
    for raw_id in extra_catalog_agents {
        if seen_ids.contains(&raw_id) {
            continue;
        }
        if let Some(wanted) = filter
            && !raw_id.eq_ignore_ascii_case(wanted)
        {
            continue;
        }
        let Ok(parsed_id) = AgentId::parse(&raw_id) else {
            continue;
        };
        seen_ids.insert(raw_id.clone());
        let profile = profiles.profile(&parsed_id);
        let display_name = profile
            .map(|p| p.display_name.to_string())
            .unwrap_or_else(|| raw_id.clone());
        let description = profile
            .map(|p| p.description.to_string())
            .unwrap_or_default();
        let entry = build_bot_agent_catalog_entry(
            pool,
            &parsed_id,
            &display_name,
            &description,
            true,
            json!("ready"),
            json!("authenticated"),
        )
        .await;
        entries.push(entry);
    }

    Ok(json!({
        "caller_agent_id": caller_agent_id,
        "agents": entries,
    }))
}

async fn build_bot_agent_catalog_entry(
    pool: &SqlitePool,
    agent_id: &AgentId,
    display_name: &str,
    description: &str,
    enabled: bool,
    lifecycle: Value,
    authentication: Value,
) -> Value {
    let snapshot = load_latest_catalog_snapshot(pool, agent_id).await;
    let defaults = db::models::agent_management::SessionDefaultRepository::new(pool.clone())
        .list_for_agent(agent_id)
        .await
        .unwrap_or_default();
    let mut default_mode_id: Option<String> = None;
    let mut default_config_map = serde_json::Map::new();
    for record in defaults {
        let parsed = serde_json::from_str::<Value>(&record.value_json)
            .unwrap_or_else(|_| Value::String(record.value_json.clone()));
        if record.option_id == "mode" {
            default_mode_id = config_string_value(Some(&parsed));
        } else {
            default_config_map.insert(record.option_id, parsed);
        }
    }
    let default_config_values = Value::Object(default_config_map);
    let (default_model, default_thinking) = extract_model_and_thinking(&default_config_values);

    let Some(snapshot) = snapshot else {
        return json!({
            "agent_id": agent_id.as_str(),
            "display_name": display_name,
            "description": description,
            "enabled": enabled,
            "lifecycle": lifecycle,
            "authentication": authentication,
            "catalog_available": false,
            "current_mode": default_mode_id,
            "default_mode_id": default_mode_id,
            "modes": [],
            "model_option_key": Value::Null,
            "current_model": default_model,
            "models": [],
            "thinking_option_key": Value::Null,
            "current_thinking_level": default_thinking,
            "thinking_levels": [],
            "thinking_dependency": Value::Null,
            "default_config_values": default_config_values,
            "config_options": [],
        });
    };

    let modes: Vec<Value> = snapshot
        .modes
        .iter()
        .map(|m| {
            json!({
                "id": m.id,
                "label": m.label,
                "description": m.description,
            })
        })
        .collect();
    let current_mode = default_mode_id
        .clone()
        .or_else(|| snapshot.current_mode.clone());

    let model_opt = snapshot
        .config_options
        .iter()
        .find(|opt| is_model_option(opt));
    let model_option_key = model_opt.map(|opt| opt.key.clone());
    let current_model =
        default_model.or_else(|| model_opt.and_then(|opt| config_string_value(opt.value.as_ref())));
    let models: Vec<Value> = model_opt
        .map(|opt| {
            opt.choices
                .iter()
                .map(|c| {
                    json!({
                        "value": c.value,
                        "label": c.label,
                        "description": c.description,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let thinking_opt = snapshot
        .config_options
        .iter()
        .find(|opt| is_thinking_option(opt));
    let thinking_option_key = thinking_opt.map(|opt| opt.key.clone());
    let current_thinking_level = default_thinking
        .or_else(|| thinking_opt.and_then(|opt| config_string_value(opt.value.as_ref())));
    let thinking_levels: Vec<Value> = thinking_opt
        .map(|opt| {
            opt.choices
                .iter()
                .map(|c| {
                    json!({
                        "value": c.value,
                        "label": c.label,
                        "description": c.description,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let thinking_dependency = thinking_opt.and_then(|opt| {
        opt.dependency
            .as_ref()
            .and_then(|dep| serde_json::to_value(dep).ok())
    });

    json!({
        "agent_id": agent_id.as_str(),
        "display_name": display_name,
        "description": description,
        "enabled": enabled,
        "lifecycle": lifecycle,
        "authentication": authentication,
        "catalog_available": true,
        "current_mode": current_mode,
        "default_mode_id": default_mode_id,
        "modes": modes,
        "model_option_key": model_option_key,
        "current_model": current_model,
        "models": models,
        "thinking_option_key": thinking_option_key,
        "current_thinking_level": current_thinking_level,
        "thinking_levels": thinking_levels,
        "thinking_dependency": thinking_dependency,
        "default_config_values": default_config_values,
        "config_options": snapshot.config_options,
    })
}
