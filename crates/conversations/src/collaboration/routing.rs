use chrono::{Duration, Utc};
use db::models::collaboration_identity as identity;
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::*;

#[derive(Debug, Clone)]
pub(crate) struct ResolvedTarget {
    pub(crate) conversation_id: Option<Uuid>,
    pub(crate) nickname: String,
    /// When set, this recipient lives in another thread (DM or group).
    pub(crate) dest_thread_id: Option<String>,
    /// `"member"`, `"group"`, or `"user"`.
    pub(crate) peer_kind: String,
}

impl ResolvedTarget {
    fn local(conversation_id: Option<Uuid>, nickname: impl Into<String>) -> Self {
        Self {
            conversation_id,
            nickname: nickname.into(),
            dest_thread_id: None,
            peer_kind: "member".to_string(),
        }
    }

    fn user() -> Self {
        Self {
            conversation_id: None,
            nickname: "User".to_string(),
            dest_thread_id: None,
            peer_kind: "user".to_string(),
        }
    }
}

pub(crate) fn is_user_target_name(raw: &str) -> bool {
    let trimmed = raw.trim().trim_start_matches('@').trim();
    trimmed.eq_ignore_ascii_case("user") || trimmed == "你" || trimmed == "用户"
}

pub fn is_broadcast_target_name(raw: &str) -> bool {
    let trimmed = raw.trim().trim_start_matches('@').trim();
    trimmed == "所有人"
        || trimmed == "全体成员"
        || trimmed.eq_ignore_ascii_case("all")
        || trimmed.eq_ignore_ascii_case("everyone")
}

pub(crate) fn contains_broadcast_mention(content: &str) -> bool {
    ["所有人", "全体成员", "all", "everyone", "ALL", "Everyone"]
        .iter()
        .any(|alias| contains_mention_token(content, alias))
}

pub(crate) fn is_valid_mention_boundary(name: &str, after: Option<char>) -> bool {
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

pub(crate) fn contains_mention_token(content: &str, name: &str) -> bool {
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
    for builtin in [
        "User",
        "user",
        "你",
        "用户",
        "所有人",
        "全体成员",
        "all",
        "everyone",
        "ALL",
        "Everyone",
    ] {
        if !candidates.iter().any(|existing| existing == builtin) {
            candidates.push(builtin.to_string());
        }
    }
    candidates.sort_by_key(|b| std::cmp::Reverse(b.chars().count()));

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

    let final_text = rest.trim();
    if final_text.is_empty() {
        content.trim().to_string()
    } else {
        final_text.to_string()
    }
}

/// Resolve recipients, then map every agent seat through its member identity
/// (`resolve_session`) so delivery always lands in the member's conversation
/// for this space's thread.
pub(crate) async fn resolve_targets(
    pool: &SqlitePool,
    space_id: &str,
    sender: Option<Uuid>,
    nicknames: &[String],
    content: &str,
) -> Result<Vec<ResolvedTarget>, CollaborationError> {
    let mut targets = resolve_seat_targets(pool, space_id, sender, nicknames, content).await?;
    for target in &mut targets {
        if target.dest_thread_id.is_some() {
            continue;
        }
        if let Some(conversation_id) = target.conversation_id {
            target.conversation_id =
                Some(resolve_seat_target(pool, space_id, conversation_id, &target.nickname).await?);
        }
    }
    Ok(targets)
}

pub(crate) async fn resolve_seat_targets(
    pool: &SqlitePool,
    space_id: &str,
    sender: Option<Uuid>,
    nicknames: &[String],
    content: &str,
) -> Result<Vec<ResolvedTarget>, CollaborationError> {
    let members = list_space_members(pool, space_id, MessageAudience::Agent).await?;
    let broadcast_all_agents = |members: Vec<MemberRecord>| -> Vec<ResolvedTarget> {
        members
            .into_iter()
            .filter_map(|member| {
                let conversation_id = member
                    .conversation_id
                    .and_then(|id| Uuid::parse_str(&id).ok());
                if conversation_id == sender {
                    return None;
                }
                conversation_id.map(|conversation_id| {
                    ResolvedTarget::local(Some(conversation_id), member.nickname)
                })
            })
            .collect()
    };

    let has_explicit_broadcast = nicknames.iter().any(|raw| is_broadcast_target_name(raw))
        || contains_broadcast_mention(content);

    let non_empty_nicknames: Vec<&str> = nicknames
        .iter()
        .map(|s| s.trim().trim_start_matches('@').trim())
        .filter(|s| !s.is_empty())
        .collect();

    if non_empty_nicknames.is_empty() {
        if has_explicit_broadcast {
            return Ok(broadcast_all_agents(members));
        }
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
                    mentioned.push(ResolvedTarget::local(
                        Some(conversation_id),
                        member.nickname.clone(),
                    ));
                }
            }
        }
        if sender.is_some()
            && ["User", "user", "你", "用户"]
                .iter()
                .any(|alias| contains_mention_token(content, alias))
        {
            mentioned.push(ResolvedTarget::user());
        }
        if let Ok(workspace_id) = space_workspace_id(pool, space_id).await {
            for peer in workspace_direct_peers(pool, workspace_id).await? {
                if peer.conversation_id == sender {
                    continue;
                }
                if !contains_mention_token(content, &peer.nickname) {
                    continue;
                }
                if mentioned
                    .iter()
                    .any(|existing| existing.nickname == peer.nickname)
                {
                    continue;
                }
                mentioned.push(peer);
            }
            if let Some(group) =
                workspace_group_mentioned(pool, workspace_id, space_id, content).await?
            {
                if !mentioned
                    .iter()
                    .any(|existing| existing.dest_thread_id.as_deref() == Some(group.as_str()))
                {
                    mentioned.extend(workspace_group_targets(pool, &group).await?);
                }
            }
        }
        if !mentioned.is_empty() {
            return Ok(mentioned);
        }
        if sender.is_some() {
            return Ok(vec![ResolvedTarget::user()]);
        }
        return pick_default_agent_targets(pool, space_id, &members).await;
    }

    let mut targets = Vec::new();
    if has_explicit_broadcast {
        for target in broadcast_all_agents(members.clone()) {
            if !targets
                .iter()
                .any(|t: &ResolvedTarget| t.conversation_id == target.conversation_id)
            {
                targets.push(target);
            }
        }
    }
    for nickname in non_empty_nicknames {
        if is_broadcast_target_name(nickname) {
            continue;
        }
        if is_user_target_name(nickname) {
            if sender.is_some()
                && !targets
                    .iter()
                    .any(|t: &ResolvedTarget| t.conversation_id.is_none())
            {
                targets.push(ResolvedTarget::user());
            }
            continue;
        }
        if let Some(member) = members.iter().find(|member| {
            member.nickname == nickname || member.conversation_id.as_deref() == Some(nickname)
        }) {
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
            targets.push(ResolvedTarget::local(
                conversation_id,
                member.nickname.clone(),
            ));
            continue;
        }
        let peers = resolve_workspace_peer(pool, space_id, nickname).await?;
        if peers.is_empty() {
            return Err(CollaborationError::new(
                "not_found",
                "nickname was not found in this collaboration space",
            ));
        }
        for peer in peers {
            if peer.conversation_id == sender {
                continue;
            }
            if targets.iter().any(|existing| {
                existing.conversation_id == peer.conversation_id
                    && existing.dest_thread_id == peer.dest_thread_id
            }) {
                continue;
            }
            targets.push(peer);
        }
    }
    Ok(targets)
}

fn member_as_target(member: &MemberRecord) -> Option<ResolvedTarget> {
    let conversation_id = member
        .conversation_id
        .as_deref()
        .and_then(|id| Uuid::parse_str(id).ok())?;
    Some(ResolvedTarget::local(
        Some(conversation_id),
        member.nickname.clone(),
    ))
}

async fn workspace_direct_peers(
    pool: &SqlitePool,
    workspace_id: Uuid,
) -> Result<Vec<ResolvedTarget>, CollaborationError> {
    let rows = sqlx::query_as::<_, (String, String, String)>(
        r#"SELECT m.id, m.name, tm.conversation_id
           FROM collaboration_members m
           JOIN collaboration_thread_members tm
             ON tm.member_id = m.id AND tm.status = 'active'
           JOIN sessions s
             ON lower(hex(s.id)) = replace(tm.conversation_id, '-', '')
           WHERE lower(hex(s.workspace_id)) = replace(?, '-', '')
             AND tm.thread_id LIKE 'direct:%'"#,
    )
    .bind(workspace_id.to_string())
    .fetch_all(pool)
    .await
    .map_err(db)?;
    Ok(rows
        .into_iter()
        .filter_map(|(member_id, name, conversation_id)| {
            let conversation_id = Uuid::parse_str(&conversation_id).ok()?;
            Some(ResolvedTarget {
                conversation_id: Some(conversation_id),
                nickname: name,
                dest_thread_id: Some(identity::direct_thread_id(&member_id)),
                peer_kind: "member".to_string(),
            })
        })
        .collect())
}

pub(crate) async fn resolve_workspace_peer(
    pool: &SqlitePool,
    origin_space_id: &str,
    nickname: &str,
) -> Result<Vec<ResolvedTarget>, CollaborationError> {
    let Ok(workspace_id) = space_workspace_id(pool, origin_space_id).await else {
        return Ok(Vec::new());
    };
    let peers = workspace_direct_peers(pool, workspace_id).await?;
    if let Some(peer) = peers.into_iter().find(|peer| peer.nickname == nickname) {
        return Ok(vec![peer]);
    }
    let group_id: Option<String> = sqlx::query_scalar(
        "SELECT id FROM collaboration_spaces WHERE workspace_id = ? AND name = ? LIMIT 1",
    )
    .bind(workspace_id.to_string())
    .bind(nickname)
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    let Some(group_id) = group_id.filter(|id| id != origin_space_id) else {
        return Ok(Vec::new());
    };
    workspace_group_targets(pool, &group_id).await
}

async fn workspace_group_targets(
    pool: &SqlitePool,
    group_id: &str,
) -> Result<Vec<ResolvedTarget>, CollaborationError> {
    let group_name: String =
        sqlx::query_scalar("SELECT name FROM collaboration_spaces WHERE id = ? LIMIT 1")
            .bind(group_id)
            .fetch_optional(pool)
            .await
            .map_err(db)?
            .unwrap_or_else(|| group_id.to_string());
    let members = list_space_members(pool, group_id, MessageAudience::Agent).await?;
    let mut targets = pick_default_agent_targets(pool, group_id, &members).await?;
    for target in &mut targets {
        target.dest_thread_id = Some(group_id.to_string());
        target.peer_kind = "group".to_string();
        target.nickname = group_name.clone();
    }
    if targets.is_empty() {
        targets.push(ResolvedTarget {
            conversation_id: None,
            nickname: group_name,
            dest_thread_id: Some(group_id.to_string()),
            peer_kind: "group".to_string(),
        });
    }
    Ok(targets)
}

async fn workspace_group_mentioned(
    pool: &SqlitePool,
    workspace_id: Uuid,
    origin_space_id: &str,
    content: &str,
) -> Result<Option<String>, CollaborationError> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT id, name FROM collaboration_spaces WHERE workspace_id = ?")
            .bind(workspace_id.to_string())
            .fetch_all(pool)
            .await
            .map_err(db)?;
    Ok(rows.into_iter().find_map(|(id, name)| {
        if id == origin_space_id {
            return None;
        }
        if contains_mention_token(content, &name) {
            Some(id)
        } else {
            None
        }
    }))
}

/// Default recipient when a user posts with no `to` and no @ in the body:
/// lead → last @-mentioned member → creator → first roster seat.
async fn pick_default_agent_targets(
    pool: &SqlitePool,
    space_id: &str,
    members: &[MemberRecord],
) -> Result<Vec<ResolvedTarget>, CollaborationError> {
    if members.is_empty() {
        return Ok(Vec::new());
    }
    let meta: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        r#"SELECT lead_member_id, created_by_conversation_id
           FROM collaboration_spaces WHERE id = ?"#,
    )
    .bind(space_id)
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    let (lead_member_id, created_by) = meta.unwrap_or((None, None));

    if let Some(lead_id) = lead_member_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        && let Some(member) = members.iter().find(|member| member.member_id == lead_id)
        && let Some(target) = member_as_target(member)
    {
        return Ok(vec![target]);
    }

    if let Some(target) = last_mentioned_agent(pool, space_id, members).await? {
        return Ok(vec![target]);
    }

    if let Some(created) = created_by
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        && let Some(member) = members
            .iter()
            .find(|member| member.conversation_id.as_deref() == Some(created))
        && let Some(target) = member_as_target(member)
    {
        return Ok(vec![target]);
    }

    if let Some(target) = members.iter().find_map(member_as_target) {
        return Ok(vec![target]);
    }
    Ok(Vec::new())
}

fn nickname_from_actor(uri: &str) -> Option<String> {
    let marker = "/member/";
    let index = uri.rfind(marker)?;
    let nick = uri[index + marker.len()..].trim();
    if nick.is_empty() || is_user_target_name(nick) {
        None
    } else {
        Some(nick.to_string())
    }
}

async fn last_mentioned_agent(
    pool: &SqlitePool,
    space_id: &str,
    members: &[MemberRecord],
) -> Result<Option<ResolvedTarget>, CollaborationError> {
    let rows: Vec<String> = sqlx::query_scalar(
        r#"SELECT envelope_json FROM collaboration_space_messages
           WHERE space_id = ? AND origin IN ('user', 'agent')
           ORDER BY seq DESC LIMIT 200"#,
    )
    .bind(space_id)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    for raw in rows {
        let envelope: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));
        let content = envelope
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or("");
        let to_names: Vec<String> = envelope
            .get("to")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter_map(nickname_from_actor)
            .collect();
        let mut best: Option<(usize, &MemberRecord)> = None;
        for member in members {
            let needle = format!("@{}", member.nickname);
            for (idx, _) in content.match_indices(&needle) {
                if contains_mention_token(content, &member.nickname)
                    && best.is_none_or(|(best_idx, _)| idx >= best_idx)
                {
                    best = Some((idx, member));
                }
            }
        }
        if let Some((_, member)) = best
            && let Some(target) = member_as_target(member)
        {
            return Ok(Some(target));
        }
        for name in &to_names {
            if let Some(member) = members.iter().find(|member| member.nickname == *name)
                && let Some(target) = member_as_target(member)
            {
                return Ok(Some(target));
            }
        }
    }
    Ok(None)
}

/// Who a draft would wake if posted now. Pure read: resolves recipients the
/// way `post_to_space` does (explicit `to`, then @-mentions, otherwise the
/// single default seat) without creating any session.
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
    let explicit_broadcast =
        to.iter().any(|name| is_broadcast_target_name(name)) || contains_broadcast_mention(content);
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
        broadcast: explicit_broadcast,
        asleep,
    })
}

/// Whether the thread session behind `conversation_id` is asleep.
pub(crate) async fn session_is_asleep(
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
/// Default max consecutive agent-to-agent messages in a space without an intervening user message.
pub const DEFAULT_AGENT_REPLY_CHAIN_MAX: usize = 4;
/// Default collaboration-turn deadline after a delivery binds an input.
pub const DEFAULT_COLLAB_TURN_TIMEOUT_MINUTES: i64 = 15;

pub fn agent_reply_chain_max() -> usize {
    env_i64(
        "VIBEX_AGENT_REPLY_CHAIN_MAX",
        DEFAULT_AGENT_REPLY_CHAIN_MAX as i64,
    )
    .max(1) as usize
}

pub(crate) fn env_i64(key: &str, default: i64) -> i64 {
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

/// `VIBEX_COLLAB_TURN_TIMEOUT_MINUTES` (default 15) before an open turn times out.
pub fn collab_turn_timeout_minutes() -> i64 {
    env_i64(
        "VIBEX_COLLAB_TURN_TIMEOUT_MINUTES",
        DEFAULT_COLLAB_TURN_TIMEOUT_MINUTES,
    )
    .max(1)
}

/// Mark the thread session behind `conversation_id` active (and awake).
pub(crate) async fn touch_session_activity(
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

/// Finish collaboration turns whose deadline has passed and mark still-
/// processing receipts `timed_out`, which also frees in-flight slots.
pub async fn sweep_expired_turns(pool: &SqlitePool) -> Result<u64, CollaborationError> {
    let now = now_stamp();
    let overdue_turns: Vec<(String, String, String, String, Option<String>)> = sqlx::query_as(
        r#"SELECT id, space_id, space_message_id, conversation_id, round_id
           FROM collaboration_turns
           WHERE state <> 'finished' AND deadline_at <= ?"#,
    )
    .bind(&now)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    let finished = sqlx::query(
        r#"UPDATE collaboration_turns
           SET outcome = 'timed_out', state = 'finished', updated_at = ?
           WHERE state <> 'finished' AND deadline_at <= ?"#,
    )
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await
    .map_err(db)?;
    sqlx::query(
        r#"UPDATE collaboration_space_deliveries
           SET receipt_state = 'timed_out', receipt_updated_at = ?
           WHERE receipt_state IN ('queued', 'processing')
             AND turn_id IN (
               SELECT id FROM collaboration_turns
               WHERE outcome = 'timed_out' AND state = 'finished'
             )"#,
    )
    .bind(&now)
    .execute(pool)
    .await
    .map_err(db)?;

    let mut rounds_to_advance = std::collections::BTreeSet::new();
    for (turn_id, space_id, message_id, conversation_id, round_id) in &overdue_turns {
        let _ = append_space_event_pool(
            pool,
            space_id,
            "turn",
            Some(message_id),
            &json!({
                "action": "timed_out",
                "turn_id": turn_id,
                "conversation_id": conversation_id,
                "outcome": "timed_out",
                "receipt_state": "timed_out",
            }),
        )
        .await;
        if let Some(rid) = round_id {
            rounds_to_advance.insert(rid.clone());
        }
    }

    let overdue_rounds: Vec<String> = sqlx::query_scalar(
        r#"SELECT id FROM collaboration_rounds
           WHERE state IN ('open', 'closing') AND deadline_at <= ?"#,
    )
    .bind(&now)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    for rid in overdue_rounds {
        rounds_to_advance.insert(rid);
    }

    let default_ctx = DeliveryContext::default();
    for rid in rounds_to_advance {
        let _ = advance_round(pool, &rid, &default_ctx).await;
    }

    Ok(finished.rows_affected())
}

/// Background sweeper, once every 10s: puts idle sessions to sleep
/// ([`sleep_idle_sessions`]), expires overdue collaboration turns
/// ([`sweep_expired_turns`]), retries deferred deliveries
/// ([`redeliver_deferred`]), and prunes expired space events
/// ([`sweep_expired_space_events`]).
pub fn spawn_idle_session_sweeper(pool: SqlitePool, delivery: DeliveryContext) {
    tokio::spawn(async move {
        loop {
            let minutes = idle_sleep_minutes();
            if let Err(error) = sleep_idle_sessions(&pool, minutes).await {
                tracing::warn!(%error, "idle member session sweep failed");
            }
            if let Err(error) = sweep_expired_turns(&pool).await {
                tracing::warn!(%error, "expired collaboration turn sweep failed");
            }
            if let Err(error) = redeliver_deferred(&pool, &delivery).await {
                tracing::warn!(%error, "deferred delivery sweep failed");
            }
            if let Err(error) = sweep_expired_space_events(&pool).await {
                tracing::warn!(%error, "expired space events sweep failed");
            }
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        }
    });
}

/// Ledger key of the turn that produced `message_id`: the sender's active
/// turn when an agent posted mid-turn, otherwise the message itself.
pub(crate) async fn wake_turn_key(
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

pub(crate) async fn hold_over_wake_cap(
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

/// Whether the turn behind a wake ledger key is still running. For `turn:`
/// keys, checks whether the originating session's turn is still active; for
/// `message:<message_id>` keys, checks whether any target conversation already
/// delivered for that message still has an active running turn.
pub(crate) async fn wake_turn_in_flight(
    pool: &SqlitePool,
    turn_key: &str,
) -> Result<bool, CollaborationError> {
    if let Some(turn) = turn_key
        .strip_prefix("turn:")
        .and_then(|raw| Uuid::parse_str(raw).ok())
    {
        let running: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM sessions WHERE active_turn_id = ? LIMIT 1")
                .bind(turn)
                .fetch_optional(pool)
                .await
                .map_err(db)?;
        return Ok(running.is_some());
    }
    if let Some(message_id) = turn_key
        .strip_prefix("message:")
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        let delivered_convs: Vec<String> = sqlx::query_scalar(
            r#"SELECT conversation_id
               FROM collaboration_space_deliveries
               WHERE space_message_id = ?
                 AND status IN ('delivered', 'dispatched', 'queued')
                 AND input_id IS NOT NULL"#,
        )
        .bind(message_id)
        .fetch_all(pool)
        .await
        .map_err(db)?;
        for raw_cid in delivered_convs {
            let Ok(cid) = Uuid::parse_str(&raw_cid) else {
                continue;
            };
            let turn_running: Option<i64> = sqlx::query_scalar(
                r#"SELECT 1 FROM conversation_turns
                   WHERE conversation_id = ?
                     AND status IN ('pending', 'queued', 'running', 'blocked')
                   LIMIT 1"#,
            )
            .bind(cid)
            .fetch_optional(pool)
            .await
            .map_err(db)?;
            if turn_running.is_some() {
                return Ok(true);
            }
            let session_running: Option<i64> = sqlx::query_scalar(
                "SELECT 1 FROM sessions WHERE id = ? AND active_turn_id IS NOT NULL LIMIT 1",
            )
            .bind(cid)
            .fetch_optional(pool)
            .await
            .map_err(db)?;
            if session_running.is_some() {
                return Ok(true);
            }
        }
        return Ok(false);
    }
    Ok(false)
}

/// Reserve a wake of sleeping `conversation_id` for `turn_key`. `false` when
/// the turn already used its cap (nothing recorded). Idempotent per pair.
pub(crate) async fn reserve_wake(
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collaboration::test_support::*;

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
        let default_wake = preview_space_wake(&pool, &space, None, "大家看看", &[])
            .await
            .unwrap();
        assert!(!default_wake.broadcast);
        assert_eq!(default_wake.will_wake, 1);
        let mentioned = preview_space_wake(&pool, &space, None, "@小B 看看", &[])
            .await
            .unwrap();
        assert!(!mentioned.broadcast);
        assert_eq!(mentioned.will_wake, 1);
        let from_agent = preview_space_wake(&pool, &space, Some(a), "@所有人 大家看看", &[])
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
        for name in ["小B", "小C", "小D", "小E", "小F"] {
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
        assert_eq!(slept, 5, "a + four idle members");
        assert!(session_is_asleep(&pool, others[0]).await.unwrap());
        assert!(!session_is_asleep(&pool, others[3]).await.unwrap());
        let preview = preview_space_wake(&pool, &space, None, "大家", &[])
            .await
            .unwrap();
        assert_eq!(preview.will_wake, 1);
        assert_eq!(preview.asleep, 1);

        // One agent broadcast is one turn: only DEFAULT_WAKE_CAP_PER_TURN (3)
        // sleeping sessions wake; the rest are deferred.
        let posted = post_as(&pool, Some(a), &space, "@所有人 大家醒醒", &[]).await;
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
        // Woken sessions are awake again (a stayed asleep as sender + 1 deferred sleeper = 2).
        let still_asleep: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM collaboration_thread_members WHERE asleep_since IS NOT NULL",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(still_asleep, 2);
        // A new message is a new turn and may wake the deferred member.
        let next = post_as(&pool, Some(a), &space, "@所有人 再叫一次", &[]).await;
        assert!(next.receipts.iter().all(|r| r.error_code.is_none()));
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
        let posted = post_as(&pool, Some(a), &space, "@所有人 大家醒醒", &[]).await;
        let held: Vec<_> = posted
            .receipts
            .iter()
            .filter(|r| r.error_code.as_deref() == Some("wake_limit_exceeded"))
            .collect();
        assert_eq!(held.len(), 1);
        assert_eq!(held[0].state, WAKE_LIMIT_REACHED);
        let held = held[0].conversation_id;
        let held_turns: i64 = sqlx::query_scalar(
            r#"SELECT COUNT(*) FROM collaboration_turns
               WHERE space_message_id = ? AND conversation_id = ?"#,
        )
        .bind(&posted.message_id)
        .bind(held.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(held_turns, 0, "held deliveries must not open a turn");
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

    #[test]
    fn clean_space_display_text_only_strips_leading_mentions() {
        let nicknames = vec!["架构师".to_string(), "前端专家".to_string()];
        assert_eq!(
            clean_space_display_text("@架构师 @前端专家 请确认接口", &nicknames),
            "请确认接口"
        );
        assert_eq!(
            clean_space_display_text("@前端专家 我已经和 @架构师 确认过了", &nicknames),
            "我已经和 @架构师 确认过了"
        );
        assert_eq!(
            clean_space_display_text("我已经和 @架构师 确认过了，请 @前端专家 跟进", &nicknames),
            "我已经和 @架构师 确认过了，请 @前端专家 跟进"
        );
    }

    #[tokio::test]
    async fn user_message_wake_cap_holds_until_woken_turns_finish() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        let space = space_of(&pool, a).await;
        let mut all_members = vec![a];
        for name in ["小B", "小C", "小D", "小E"] {
            let id = Uuid::new_v4();
            create_session(&pool, id, workspace, Some(name)).await;
            add_space_member(&pool, a, &space, id, name, Uuid::new_v4())
                .await
                .unwrap();
            all_members.push(id);
        }
        sqlx::query(
            "UPDATE collaboration_thread_members SET last_active_at = '2000-01-01T00:00:00Z'",
        )
        .execute(&pool)
        .await
        .unwrap();
        sleep_idle_sessions(&pool, 30).await.unwrap();

        // Agent without active_turn_id posts a broadcast message -> wake_turn_key is "message:<message_id>"
        let posted = post_as(&pool, Some(a), &space, "@所有人 请大家汇报进展", &[]).await;
        let delivered_convs: Vec<Uuid> = posted
            .receipts
            .iter()
            .filter(|r| r.error_code.is_none())
            .map(|r| r.conversation_id)
            .collect();
        let held_convs: Vec<Uuid> = posted
            .receipts
            .iter()
            .filter(|r| r.error_code.as_deref() == Some("wake_limit_exceeded"))
            .map(|r| r.conversation_id)
            .collect();
        assert_eq!(delivered_convs.len(), 3);
        assert_eq!(held_convs.len(), 1);
        let held = held_convs[0];

        // Simulate one of the woken bots still running its turn
        mark_running(&pool, delivered_convs[0]).await;

        // Sweep must NOT release the held bot while a woken bot is still running
        redeliver_deferred(&pool, &DeliveryContext::default())
            .await
            .unwrap();
        assert!(
            inputs_of(&pool, held).await.is_empty(),
            "held bot must stay deferred while batch turn is still running"
        );

        // Once the woken bot's turn finishes, sweep releases the held bot
        sqlx::query("UPDATE conversation_turns SET status = 'completed' WHERE conversation_id = ?")
            .bind(delivered_convs[0])
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE sessions SET active_turn_id = NULL WHERE id = ?")
            .bind(delivered_convs[0])
            .execute(&pool)
            .await
            .unwrap();

        redeliver_deferred(&pool, &DeliveryContext::default())
            .await
            .unwrap();
        assert_eq!(inputs_of(&pool, held).await.len(), 1);
    }

    #[tokio::test]
    async fn default_user_post_wakes_only_the_lead() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let (a, b, c) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        create_session(&pool, c, workspace, Some("小C")).await;
        let space = space_of(&pool, a).await;
        let lead = add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        add_space_member(&pool, a, &space, c, "小C", Uuid::new_v4())
            .await
            .unwrap();
        set_space_lead(&pool, &space, Some(&lead.member_id))
            .await
            .unwrap();
        let posted = post_as(&pool, None, &space, "请推进鉴权", &[]).await;
        assert_eq!(posted.receipts.len(), 1);
        assert_eq!(posted.receipts[0].conversation_id, b);
        assert_eq!(input_count(&pool, a).await, 0);
        assert_eq!(input_count(&pool, c).await, 0);
        assert_eq!(input_count(&pool, b).await, 1);
    }

    #[tokio::test]
    async fn default_user_post_wakes_last_mentioned_when_no_lead() {
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
        post_as(&pool, None, &space, "@小C 先看接口", &[]).await;
        let posted = post_as(&pool, None, &space, "继续", &[]).await;
        assert_eq!(posted.receipts.len(), 1);
        assert_eq!(posted.receipts[0].conversation_id, c);
        assert_eq!(input_count(&pool, b).await, 0);
    }

    #[tokio::test]
    async fn default_user_post_wakes_creator_then_first_member() {
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
        let posted = post_as(&pool, None, &space, "开工", &[]).await;
        assert_eq!(posted.receipts.len(), 1);
        assert_eq!(posted.receipts[0].conversation_id, a);

        sqlx::query("INSERT INTO workspaces (id, task_id, branch) VALUES (?, ?, 'main')")
            .bind(workspace)
            .bind(Uuid::new_v4())
            .execute(&pool)
            .await
            .unwrap();
        let owned = create_workspace_space(&pool, workspace, "无群主群", Uuid::new_v4())
            .await
            .unwrap()
            .space_id;
        add_space_member(&pool, a, &owned, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        add_space_member(&pool, a, &owned, c, "小C", Uuid::new_v4())
            .await
            .unwrap();
        let first = post_as(&pool, None, &owned, "开工", &[]).await;
        assert_eq!(first.receipts.len(), 1);
        assert_eq!(first.receipts[0].nickname, "小B");
    }

    #[tokio::test]
    async fn agent_post_without_mention_does_not_wake_assistants() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        let space = space_of(&pool, a).await;
        add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        let posted = post_as(&pool, Some(a), &space, "我这边好了", &[]).await;
        assert!(posted.receipts.is_empty());
        assert_eq!(input_count(&pool, b).await, 0);
    }

    #[tokio::test]
    async fn explicit_multi_mention_still_wakes_each_named_assistant() {
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
        let posted = post_as(&pool, None, &space, "@小B @小C 一起看", &[]).await;
        let ids: Vec<Uuid> = posted
            .receipts
            .iter()
            .map(|receipt| receipt.conversation_id)
            .collect();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&b));
        assert!(ids.contains(&c));
    }

    #[tokio::test]
    async fn ninth_assistant_hop_is_blocked_with_a_system_notice() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        let space = space_of(&pool, a).await;
        add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();

        post_as(&pool, None, &space, "@小A 请和小B对齐一下接口", &["小A"]).await;
        assert_eq!(input_count(&pool, a).await, 1);
        assert_eq!(input_count(&pool, b).await, 0);

        for step in 1..=MAX_ASSISTANT_HOPS_PER_ROOT {
            let (sender, target_nick) = if step % 2 == 1 {
                (a, "小B")
            } else {
                (b, "小A")
            };
            let posted = post_as(
                &pool,
                Some(sender),
                &space,
                &format!("@{target_nick} 第{step}轮确认"),
                &[target_nick],
            )
            .await;
            assert_eq!(posted.receipts.len(), 1, "hop {step} must still wake");
        }

        let b_inputs_before_over = input_count(&pool, b).await;
        let over_limit = post_as(&pool, Some(a), &space, "@小B 第9轮继续追问", &["小B"]).await;
        assert!(over_limit.receipts.is_empty());
        assert_eq!(input_count(&pool, b).await, b_inputs_before_over);
        let messages = list_space_messages(&pool, &space, None, None, MessageAudience::User)
            .await
            .unwrap();
        assert!(
            messages.iter().any(|message| {
                message.origin == "system"
                    && message.envelope.get("content").and_then(Value::as_str)
                        == Some(COLLABORATION_LIMIT_NOTICE_ZH)
            }),
            "hop cap must insert the system notice"
        );
    }

    #[tokio::test]
    async fn sweep_expired_turns_marks_receipts_timed_out_and_frees_in_flight() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        let space = space_of(&pool, a).await;
        add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        let posted = post_as(&pool, None, &space, "@小A 请处理", &[]).await;
        sqlx::query(
            r#"UPDATE collaboration_space_deliveries
               SET receipt_state = 'processing'
               WHERE space_message_id = ? AND conversation_id = ?"#,
        )
        .bind(&posted.message_id)
        .bind(a.to_string())
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"UPDATE collaboration_turns
               SET deadline_at = '2000-01-01T00:00:00Z'
               WHERE space_message_id = ? AND conversation_id = ?"#,
        )
        .bind(&posted.message_id)
        .bind(a.to_string())
        .execute(&pool)
        .await
        .unwrap();
        let expired = sweep_expired_turns(&pool).await.unwrap();
        assert_eq!(expired, 1);
        let receipts = list_message_receipts(&pool, &posted.message_id)
            .await
            .unwrap();
        let a_receipt = receipts
            .iter()
            .find(|r| r.conversation_id == a.to_string())
            .unwrap();
        assert_eq!(a_receipt.state, "timed_out");
        assert_eq!(a_receipt.outcome.as_deref(), Some("timed_out"));
        let in_flight: i64 = sqlx::query_scalar(
            r#"SELECT COUNT(*) FROM collaboration_space_deliveries d
               JOIN collaboration_space_messages m ON m.id = d.space_message_id
               WHERE m.space_id = ? AND d.receipt_state = 'processing'"#,
        )
        .bind(&space)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(in_flight, 0);
        let next = post_as(&pool, None, &space, "@小B 下一条", &[]).await;
        assert!(next.receipts[0].input_id.is_some());
    }
}
