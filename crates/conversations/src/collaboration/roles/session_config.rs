use agents::AgentId;
use db::models::collaboration_identity::{self as identity, IdentityError};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::*;
use crate::remember_creation_session_controls;

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
    let row = MemberSessionConfigRow::find_by_member_id(pool, member_id)
        .await
        .map_err(db)?;
    Ok(row.map(MemberSessionConfigRow::into_config))
}

pub async fn load_conversation_member_session_config(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Option<MemberSessionConfig>, CollaborationError> {
    let Some(binding) = identity::binding_of_conversation(pool, conversation_id)
        .await
        .map_err(db)?
    else {
        return Ok(None);
    };
    load_member_session_config(pool, &binding.member_id).await
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

    let prompt_value = prompt_trimmed.as_deref().unwrap_or("");
    for cid in conv_ids {
        sqlx::query(
            r#"INSERT INTO conversation_personas
               (conversation_id, role_id, name, team_name, summary, agent_id,
                persona_prompt, snapshotted_at)
               VALUES (?, ?, ?, NULL, '', ?, ?, ?)
               ON CONFLICT(conversation_id) DO UPDATE SET
                 name = CASE WHEN trim(excluded.name) != '' THEN excluded.name ELSE conversation_personas.name END,
                 persona_prompt = excluded.persona_prompt,
                 agent_id = CASE WHEN trim(excluded.agent_id) != '' THEN excluded.agent_id ELSE conversation_personas.agent_id END"#,
        )
        .bind(cid.to_string())
        .bind(member_role_id.as_deref())
        .bind(&member_name)
        .bind(&resolved_agent)
        .bind(prompt_value)
        .bind(now_stamp())
        .execute(pool)
        .await
        .map_err(db)?;
        if !resolved_agent.is_empty()
            && let Ok(parsed_agent) = AgentId::parse(&resolved_agent)
            && let Some(existing_session) = db::models::session::Session::find_by_id(pool, cid)
                .await
                .map_err(db)?
            && existing_session.agent_id.as_ref() != Some(&parsed_agent)
        {
            if existing_session.agent_id.is_some() {
                let _ = crate::jsonl_history::preserve_transcript_before_detach(pool, cid).await;
            }
            sqlx::query(
                r#"UPDATE sessions
                   SET external_session_id = CASE
                           WHEN agent_id IS NOT NULL AND agent_id != ?1 THEN NULL
                           ELSE external_session_id
                       END,
                       agent_id = ?1,
                       agent_type = ?1,
                       executor = ?1,
                       updated_at = datetime('now', 'subsec')
                   WHERE id = ?2"#,
            )
            .bind(parsed_agent.as_str())
            .bind(cid)
            .execute(pool)
            .await
            .map_err(db)?;
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
    let raw_member_ref = member_id.trim();
    let raw_thread_id = thread_id.trim();
    let member_id = identity_id_for_member_ref(pool, raw_member_ref, raw_thread_id).await?;
    let mut thread_id = raw_thread_id.to_string();
    if parse_unassigned_space_id(&thread_id).is_some() {
        thread_id = identity::direct_thread_id(&member_id);
    } else if !thread_id.starts_with(identity::DIRECT_PREFIX)
        && identity::load_thread(pool, &thread_id)
            .await
            .map_err(db)?
            .is_none()
    {
        identity::ensure_thread_for_seat(pool, &thread_id, &member_id)
            .await
            .map_err(identity_error)?;
    }
    let resolved = resolve_session(pool, &member_id, &thread_id).await?;
    if !thread_id.starts_with(identity::DIRECT_PREFIX) {
        if raw_member_ref != member_id {
            sqlx::query(
                r#"UPDATE collaboration_space_members
                   SET conversation_id = ?
                   WHERE space_id = ? AND member_id = ? AND kind = 'agent'"#,
            )
            .bind(resolved.to_string())
            .bind(&thread_id)
            .bind(raw_member_ref)
            .execute(pool)
            .await
            .map_err(db)?;
        } else if let Some(member) = identity::load_member(pool, &member_id).await.map_err(db)? {
            sqlx::query(
                r#"UPDATE collaboration_space_members
                   SET conversation_id = ?
                   WHERE space_id = ? AND nickname = ? AND kind = 'agent'"#,
            )
            .bind(resolved.to_string())
            .bind(&thread_id)
            .bind(&member.name)
            .execute(pool)
            .await
            .map_err(db)?;
        }
    }
    Ok(resolved)
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
        let resolved_prompt = config
            .persona_prompt
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty());
        let resolved_agent = config
            .agent_id
            .as_deref()
            .map(str::trim)
            .filter(|a| !a.is_empty())
            .or(member.agent.as_deref())
            .unwrap_or("codex");
        sqlx::query(
            r#"INSERT INTO conversation_personas
               (conversation_id, role_id, name, team_name, summary, agent_id,
                persona_prompt, snapshotted_at)
               VALUES (?, ?, ?, NULL, '', ?, ?, ?)
               ON CONFLICT(conversation_id) DO UPDATE SET
                 name = CASE WHEN trim(excluded.name) != '' THEN excluded.name ELSE conversation_personas.name END,
                 agent_id = CASE WHEN trim(excluded.agent_id) != '' THEN excluded.agent_id ELSE conversation_personas.agent_id END,
                 persona_prompt = CASE WHEN trim(excluded.persona_prompt) != '' THEN excluded.persona_prompt ELSE conversation_personas.persona_prompt END"#,
        )
        .bind(conversation_id.to_string())
        .bind(member.role_id.as_deref())
        .bind(&member.name)
        .bind(resolved_agent)
        .bind(resolved_prompt.unwrap_or(""))
        .bind(now_stamp())
        .execute(pool)
        .await
        .map_err(db)?;
        if let Some(prompt) = resolved_prompt
            && persona_prompt.as_deref().map(str::trim) != Some(prompt)
        {
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
pub(crate) async fn identity_id_for_member_ref(
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
    let seats: Vec<(String, Option<String>, String)> = sqlx::query_as(
        r#"SELECT space_id, conversation_id, nickname
           FROM collaboration_space_members
           WHERE member_id = ?"#,
    )
    .bind(member_id)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    let seat = seats
        .iter()
        .find(|(space_id, _, _)| space_id == thread_id)
        .or(seats.first());
    let (conversation_id, fallback_nickname) = if let Some((_, conversation_id, nickname)) = seat {
        let Some(conversation_id) = conversation_id
            .as_deref()
            .and_then(|raw| Uuid::parse_str(raw).ok())
        else {
            return Err(CollaborationError::new("not_found", "member was not found"));
        };
        (conversation_id, Some(nickname.as_str()))
    } else if let Ok(conversation_id) = Uuid::parse_str(member_id) {
        (conversation_id, None)
    } else {
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
    if load_session(pool, conversation_id).await?.is_some() {
        return identity::ensure_member_for_conversation(pool, conversation_id, fallback_nickname)
            .await
            .map_err(identity_error);
    }
    Err(CollaborationError::new("not_found", "member was not found"))
}

pub async fn identity_member_id_for_conversation(
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
    let identity_member_id =
        identity_member_id_for_conversation(pool, member.conversation_id.as_deref()).await?;
    let mut value = json!({
        "member_id": member.member_id,
        "identity_member_id": identity_member_id,
        "conversation_id": member.conversation_id,
        "nickname": member.nickname,
        "kind": member.kind,
        "visible_to_agents": member.visible_to_agents,
    });
    if member.kind == "agent" {
        let cfg = match identity_member_id.as_deref() {
            Some(id) => load_member_session_config(pool, id).await?,
            None => None,
        };
        if let Some(object) = value.as_object_mut() {
            enrich_member_json_with_session_config(object, cfg.as_ref());
        }
    }
    Ok(value)
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
        let orphaned =
            !binding.thread_id.starts_with(identity::DIRECT_PREFIX) && other_seat.is_none();
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

/// True when this conversation is a Space hidden session: an active
/// `collaboration_thread_members` seat, or a `collaboration_space_members` row.
pub async fn conversation_is_space_session(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<bool, CollaborationError> {
    let id = conversation_id.to_string();
    let found: Option<i64> = sqlx::query_scalar(
        r#"SELECT 1 FROM collaboration_thread_members
           WHERE conversation_id = ? AND COALESCE(status, 'active') = 'active'
           UNION
           SELECT 1 FROM collaboration_space_members
           WHERE conversation_id = ?
           LIMIT 1"#,
    )
    .bind(&id)
    .bind(&id)
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    Ok(found.is_some())
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
