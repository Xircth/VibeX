//! Collaboration member identity (phase 1).
//!
//! A *member* is an identity (name, avatar, role, agent). A *thread* is either
//! a group thread (same id as the collaboration space it replaces) or a direct
//! thread between the user and one member. Every `(member, thread)` pair owns
//! exactly one underlying conversation, recorded in
//! `collaboration_thread_members`. [`resolve_session`] is the single place that
//! maps an identity plus a thread to a conversation, creating it when missing.
//!
//! `collaboration_space_members` remains the per-space seat projection used by
//! the existing delivery, receipt and dedupe code. Each agent seat points at
//! the conversation that [`resolve_session`] returns for that seat.

use chrono::{SecondsFormat, Utc};
use sqlx::SqlitePool;
use uuid::Uuid;

/// Prefix of the synthetic per-workspace "undecided" space id.
pub const UNASSIGNED_PREFIX: &str = "unassigned:";
/// Prefix of direct thread ids.
pub const DIRECT_PREFIX: &str = "direct:";

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Deterministic member id for a member backfilled from a legacy conversation.
pub fn member_id_for_conversation(conversation_id: Uuid) -> String {
    Uuid::new_v5(
        &Uuid::NAMESPACE_OID,
        format!("vibex-member:{conversation_id}").as_bytes(),
    )
    .to_string()
}

/// Deterministic conversation id for `(member, thread)` when one is created.
pub fn thread_session_id(member_id: &str, thread_id: &str) -> Uuid {
    Uuid::new_v5(
        &Uuid::NAMESPACE_OID,
        format!("vibex-member-thread:{member_id}:{thread_id}").as_bytes(),
    )
}

pub fn direct_thread_id(member_id: &str) -> String {
    format!("{DIRECT_PREFIX}{member_id}")
}

pub fn parse_unassigned_workspace(space_id: &str) -> Option<Uuid> {
    space_id
        .strip_prefix(UNASSIGNED_PREFIX)
        .and_then(|raw| Uuid::parse_str(raw).ok())
}

/// Thread that a seat in `space_id` belongs to for `member_id`.
pub fn thread_for_seat(space_id: &str, member_id: &str) -> String {
    if parse_unassigned_workspace(space_id).is_some() {
        direct_thread_id(member_id)
    } else {
        space_id.to_string()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum IdentityError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error("{0} was not found")]
    NotFound(&'static str),
}

#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow)]
pub struct MemberRow {
    pub id: String,
    pub name: String,
    pub avatar: Option<String>,
    pub role_id: Option<String>,
    pub agent: Option<String>,
    pub model: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow)]
pub struct ThreadRow {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub workspace_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow)]
pub struct ThreadMemberRow {
    pub thread_id: String,
    pub member_id: String,
    pub conversation_id: String,
    pub status: String,
}

pub async fn load_member(
    pool: &SqlitePool,
    member_id: &str,
) -> Result<Option<MemberRow>, sqlx::Error> {
    sqlx::query_as::<_, MemberRow>(
        "SELECT id, name, avatar, role_id, agent, model, created_at
         FROM collaboration_members WHERE id = ?",
    )
    .bind(member_id)
    .fetch_optional(pool)
    .await
}

pub async fn load_thread(
    pool: &SqlitePool,
    thread_id: &str,
) -> Result<Option<ThreadRow>, sqlx::Error> {
    sqlx::query_as::<_, ThreadRow>(
        "SELECT id, kind, title, workspace_id FROM collaboration_threads WHERE id = ?",
    )
    .bind(thread_id)
    .fetch_optional(pool)
    .await
}

/// The `(thread, member)` binding that owns `conversation_id`, if any.
pub async fn binding_of_conversation(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Option<ThreadMemberRow>, sqlx::Error> {
    sqlx::query_as::<_, ThreadMemberRow>(
        "SELECT thread_id, member_id, conversation_id, status
         FROM collaboration_thread_members WHERE conversation_id = ?",
    )
    .bind(conversation_id.to_string())
    .fetch_optional(pool)
    .await
}

pub async fn thread_members(
    pool: &SqlitePool,
    thread_id: &str,
) -> Result<Vec<ThreadMemberRow>, sqlx::Error> {
    sqlx::query_as::<_, ThreadMemberRow>(
        "SELECT thread_id, member_id, conversation_id, status
         FROM collaboration_thread_members WHERE thread_id = ? ORDER BY joined_at, member_id",
    )
    .bind(thread_id)
    .fetch_all(pool)
    .await
}

pub async fn member_bindings(
    pool: &SqlitePool,
    member_id: &str,
) -> Result<Vec<ThreadMemberRow>, sqlx::Error> {
    sqlx::query_as::<_, ThreadMemberRow>(
        "SELECT thread_id, member_id, conversation_id, status
         FROM collaboration_thread_members WHERE member_id = ? ORDER BY joined_at, thread_id",
    )
    .bind(member_id)
    .fetch_all(pool)
    .await
}

/// Member identity for a conversation. A conversation that is not bound yet
/// gets a deterministic member derived from its persona (role_id inherited)
/// or, failing that, from the session row.
pub async fn ensure_member_for_conversation(
    pool: &SqlitePool,
    conversation_id: Uuid,
    fallback_name: Option<&str>,
) -> Result<String, IdentityError> {
    if let Some(binding) = binding_of_conversation(pool, conversation_id).await? {
        return Ok(binding.member_id);
    }
    let member_id = member_id_for_conversation(conversation_id);
    if load_member(pool, &member_id).await?.is_some() {
        return Ok(member_id);
    }
    let persona = sqlx::query_as::<_, (String, Option<String>, String)>(
        "SELECT name, role_id, agent_id FROM conversation_personas WHERE conversation_id = ?",
    )
    .bind(conversation_id.to_string())
    .fetch_optional(pool)
    .await?;
    let session = sqlx::query_as::<_, (Option<String>, Option<String>)>(
        "SELECT name, agent_id FROM sessions WHERE id = ?",
    )
    .bind(conversation_id)
    .fetch_optional(pool)
    .await?;
    let non_empty = |value: Option<String>| value.filter(|v| !v.trim().is_empty());
    let name = non_empty(persona.as_ref().map(|p| p.0.clone()))
        .or_else(|| non_empty(fallback_name.map(str::to_string)))
        .or_else(|| non_empty(session.as_ref().and_then(|s| s.0.clone())))
        .unwrap_or_else(|| "成员".to_string());
    let role_id = non_empty(persona.as_ref().and_then(|p| p.1.clone()));
    let agent = non_empty(persona.as_ref().map(|p| p.2.clone()))
        .or_else(|| non_empty(session.as_ref().and_then(|s| s.1.clone())));
    sqlx::query(
        "INSERT INTO collaboration_members (id, name, avatar, role_id, agent, model, created_at)
         VALUES (?, ?, NULL, ?, ?, NULL, ?)
         ON CONFLICT(id) DO NOTHING",
    )
    .bind(&member_id)
    .bind(&name)
    .bind(role_id)
    .bind(agent)
    .bind(now())
    .execute(pool)
    .await?;
    Ok(member_id)
}

/// Create the thread row backing a seat in `space_id` if it does not exist.
pub async fn ensure_thread_for_seat(
    pool: &SqlitePool,
    space_id: &str,
    member_id: &str,
) -> Result<String, IdentityError> {
    let thread_id = thread_for_seat(space_id, member_id);
    if let Some(workspace_id) = parse_unassigned_workspace(space_id) {
        let title: Option<String> =
            sqlx::query_scalar("SELECT name FROM collaboration_members WHERE id = ?")
                .bind(member_id)
                .fetch_optional(pool)
                .await?;
        sqlx::query(
            "INSERT INTO collaboration_threads (id, kind, title, workspace_id, created_at)
             VALUES (?, 'direct', ?, ?, ?)
             ON CONFLICT(id) DO NOTHING",
        )
        .bind(&thread_id)
        .bind(title.unwrap_or_default())
        .bind(workspace_id.to_string())
        .bind(now())
        .execute(pool)
        .await?;
    } else {
        let inserted = sqlx::query(
            "INSERT INTO collaboration_threads (id, kind, title, workspace_id, created_at)
             SELECT id, 'group', name, workspace_id, created_at
             FROM collaboration_spaces WHERE id = ?
             ON CONFLICT(id) DO UPDATE SET title = excluded.title",
        )
        .bind(space_id)
        .execute(pool)
        .await?;
        if inserted.rows_affected() == 0 && load_thread(pool, &thread_id).await?.is_none() {
            return Err(IdentityError::NotFound("space"));
        }
    }
    Ok(thread_id)
}

/// Record that `conversation_id` is the conversation of the agent seat it
/// occupies in `space_id`. Returns `(member_id, thread_id, resolved)` where
/// `resolved.conversation_id` is the one [`resolve_session`] will hand out. A
/// conversation that already belongs to another thread keeps that binding;
/// the caller must then use the returned conversation for this seat.
pub async fn bind_seat(
    pool: &SqlitePool,
    space_id: &str,
    conversation_id: Uuid,
    fallback_name: Option<&str>,
) -> Result<(String, String, ResolvedSession), IdentityError> {
    let member_id = ensure_member_for_conversation(pool, conversation_id, fallback_name).await?;
    let thread_id = ensure_thread_for_seat(pool, space_id, &member_id).await?;
    if let Some(binding) = binding_of_conversation(pool, conversation_id).await?
        && binding.thread_id != thread_id
    {
        let resolved = resolve_session(pool, &member_id, &thread_id).await?;
        return Ok((member_id, thread_id, resolved));
    }
    sqlx::query(
        "INSERT INTO collaboration_thread_members
           (thread_id, member_id, conversation_id, last_seen_message_id, status, joined_at)
         VALUES (?, ?, ?, NULL, 'active', ?)
         ON CONFLICT DO NOTHING",
    )
    .bind(&thread_id)
    .bind(&member_id)
    .bind(conversation_id.to_string())
    .bind(now())
    .execute(pool)
    .await?;
    let resolved = resolve_session(pool, &member_id, &thread_id).await?;
    Ok((member_id, thread_id, resolved))
}

/// Move the binding that owns `conversation_id` to the seat in `space_id`.
/// Used when the product transfers a conversation (e.g. from the undecided
/// space into a group) instead of opening a second one.
pub async fn transfer_conversation(
    pool: &SqlitePool,
    conversation_id: Uuid,
    space_id: &str,
    fallback_name: Option<&str>,
) -> Result<(), IdentityError> {
    let member_id = ensure_member_for_conversation(pool, conversation_id, fallback_name).await?;
    let thread_id = ensure_thread_for_seat(pool, space_id, &member_id).await?;
    let occupied: Option<String> = sqlx::query_scalar(
        "SELECT conversation_id FROM collaboration_thread_members
         WHERE thread_id = ? AND member_id = ?",
    )
    .bind(&thread_id)
    .bind(&member_id)
    .fetch_optional(pool)
    .await?;
    if occupied.is_some_and(|existing| existing != conversation_id.to_string()) {
        // The member already has its own conversation in that thread.
        return Ok(());
    }
    sqlx::query("DELETE FROM collaboration_thread_members WHERE conversation_id = ?")
        .bind(conversation_id.to_string())
        .execute(pool)
        .await?;
    sqlx::query(
        "INSERT INTO collaboration_thread_members
           (thread_id, member_id, conversation_id, last_seen_message_id, status, joined_at)
         VALUES (?, ?, ?, NULL, 'active', ?)
         ON CONFLICT DO NOTHING",
    )
    .bind(&thread_id)
    .bind(&member_id)
    .bind(conversation_id.to_string())
    .bind(now())
    .execute(pool)
    .await?;
    Ok(())
}

/// Drop the binding of a conversation (seat removed or conversation archived).
pub async fn unbind_conversation(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM collaboration_thread_members WHERE conversation_id = ?")
        .bind(conversation_id.to_string())
        .execute(pool)
        .await?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedSession {
    pub conversation_id: Uuid,
    /// True when this call created the conversation.
    pub created: bool,
    /// Conversation the new one was templated from (persona/agent source).
    pub template_conversation_id: Option<Uuid>,
}

/// Map `(member, thread)` to its conversation, creating it when missing.
///
/// A new conversation copies agent/executor/name from the member's earliest
/// bound conversation and its persona snapshot; without one it uses the
/// member row (and the role persona when `role_id` is set). The new id is
/// deterministic, so concurrent or repeated calls converge on one row.
pub async fn resolve_session(
    pool: &SqlitePool,
    member_id: &str,
    thread_id: &str,
) -> Result<ResolvedSession, IdentityError> {
    if let Some(existing) = bound_conversation(pool, thread_id, member_id).await? {
        return Ok(ResolvedSession {
            conversation_id: existing,
            created: false,
            template_conversation_id: None,
        });
    }
    let member = load_member(pool, member_id)
        .await?
        .ok_or(IdentityError::NotFound("member"))?;
    let thread = load_thread(pool, thread_id)
        .await?
        .ok_or(IdentityError::NotFound("thread"))?;
    let template = sqlx::query_scalar::<_, String>(
        "SELECT conversation_id FROM collaboration_thread_members
         WHERE member_id = ? ORDER BY joined_at, thread_id LIMIT 1",
    )
    .bind(member_id)
    .fetch_optional(pool)
    .await?
    .and_then(|raw| Uuid::parse_str(&raw).ok());
    let template_session = match template {
        Some(id) => sqlx::query_as::<_, (Uuid, Option<String>, Option<String>, Option<String>)>(
            "SELECT workspace_id, name, executor, agent_id FROM sessions WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(pool)
        .await?,
        None => None,
    };
    let workspace_id = match thread
        .workspace_id
        .as_deref()
        .and_then(|raw| Uuid::parse_str(raw).ok())
    {
        Some(id) => id,
        None => template_session
            .as_ref()
            .map(|session| session.0)
            .ok_or(IdentityError::NotFound("workspace"))?,
    };
    let new_id = thread_session_id(member_id, thread_id);
    let name = template_session
        .as_ref()
        .and_then(|s| s.1.clone())
        .unwrap_or_else(|| member.name.clone());
    let executor = template_session.as_ref().and_then(|s| s.2.clone());
    let agent = member
        .agent
        .clone()
        .or_else(|| template_session.as_ref().and_then(|s| s.3.clone()));
    let mut tx = pool.begin().await?;
    sqlx::query(
        "INSERT INTO sessions (id, workspace_id, name, executor, agent_id)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING",
    )
    .bind(new_id)
    .bind(workspace_id)
    .bind(&name)
    .bind(executor)
    .bind(&agent)
    .execute(&mut *tx)
    .await?;
    let copied = match template {
        Some(template) => sqlx::query(
            "INSERT INTO conversation_personas
               (conversation_id, role_id, name, team_name, summary, agent_id,
                persona_prompt, snapshotted_at)
             SELECT ?, role_id, name, team_name, summary, agent_id, persona_prompt, ?
             FROM conversation_personas WHERE conversation_id = ?
             ON CONFLICT(conversation_id) DO NOTHING",
        )
        .bind(new_id.to_string())
        .bind(now())
        .bind(template.to_string())
        .execute(&mut *tx)
        .await?
        .rows_affected(),
        None => 0,
    };
    if copied == 0 && template.is_none() {
        if let Some(role_id) = member.role_id.as_deref() {
            sqlx::query(
                "INSERT INTO conversation_personas
                   (conversation_id, role_id, name, team_name, summary, agent_id,
                    persona_prompt, snapshotted_at)
                 SELECT ?, r.id, ?, t.name, r.summary, r.agent_id, r.persona_prompt, ?
                 FROM collaboration_roles r
                 LEFT JOIN collaboration_teams t ON t.id = r.team_id
                 WHERE r.id = ?
                 ON CONFLICT(conversation_id) DO NOTHING",
            )
            .bind(new_id.to_string())
            .bind(&member.name)
            .bind(now())
            .bind(role_id)
            .execute(&mut *tx)
            .await?;
        }
    }
    let inserted = sqlx::query(
        "INSERT INTO collaboration_thread_members
           (thread_id, member_id, conversation_id, last_seen_message_id, status, joined_at)
         VALUES (?, ?, ?, NULL, 'active', ?)
         ON CONFLICT DO NOTHING",
    )
    .bind(thread_id)
    .bind(member_id)
    .bind(new_id.to_string())
    .bind(now())
    .execute(&mut *tx)
    .await?
    .rows_affected();
    tx.commit().await?;
    let conversation_id = bound_conversation(pool, thread_id, member_id)
        .await?
        .ok_or(IdentityError::NotFound("conversation"))?;
    Ok(ResolvedSession {
        conversation_id,
        created: inserted > 0 && conversation_id == new_id,
        template_conversation_id: template,
    })
}

async fn bound_conversation(
    pool: &SqlitePool,
    thread_id: &str,
    member_id: &str,
) -> Result<Option<Uuid>, sqlx::Error> {
    Ok(sqlx::query_scalar::<_, String>(
        "SELECT conversation_id FROM collaboration_thread_members
         WHERE thread_id = ? AND member_id = ?",
    )
    .bind(thread_id)
    .bind(member_id)
    .fetch_optional(pool)
    .await?
    .and_then(|raw| Uuid::parse_str(&raw).ok()))
}

/// Idempotent backfill from the legacy "member == conversation" layout.
///
/// * every agent seat's conversation becomes a member (role_id inherited
///   from `conversation_personas`);
/// * every space becomes a group thread with the same id (messages stay);
/// * seats in the undecided space become direct threads;
/// * a conversation seated in several spaces keeps its conversation for the
///   earliest-joined seat (lowest seat rowid) and gets a fresh conversation in
///   every other space; that seat is repointed at the fresh conversation.
pub struct MemberIdentityMigration;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct MemberIdentityReport {
    pub seats_bound: u32,
    pub conversations_created: u32,
}

impl MemberIdentityMigration {
    pub async fn run(pool: &SqlitePool) -> Result<MemberIdentityReport, IdentityError> {
        let seats = sqlx::query_as::<_, (i64, String, String, String)>(
            "SELECT rowid, space_id, conversation_id, nickname
             FROM collaboration_space_members
             WHERE kind = 'agent' AND conversation_id IS NOT NULL
             ORDER BY rowid",
        )
        .fetch_all(pool)
        .await?;
        let mut report = MemberIdentityReport::default();
        for (rowid, space_id, raw_conversation, nickname) in seats {
            let Ok(conversation_id) = Uuid::parse_str(&raw_conversation) else {
                continue;
            };
            let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM sessions WHERE id = ?")
                .bind(conversation_id)
                .fetch_optional(pool)
                .await?;
            if exists.is_none() {
                continue;
            }
            if parse_unassigned_workspace(&space_id).is_none() {
                let space: Option<i64> =
                    sqlx::query_scalar("SELECT 1 FROM collaboration_spaces WHERE id = ?")
                        .bind(&space_id)
                        .fetch_optional(pool)
                        .await?;
                if space.is_none() {
                    continue;
                }
            }
            let (_, _, resolved) =
                bind_seat(pool, &space_id, conversation_id, Some(&nickname)).await?;
            let resolved = resolved.conversation_id;
            if resolved != conversation_id {
                sqlx::query("UPDATE collaboration_space_members SET conversation_id = ? WHERE rowid = ?")
                    .bind(resolved.to_string())
                    .bind(rowid)
                    .execute(pool)
                    .await?;
                report.conversations_created += 1;
            }
            report.seats_bound += 1;
        }
        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

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
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("disable foreign keys");
        pool
    }

    async fn session(pool: &SqlitePool, id: Uuid, workspace: Uuid, name: &str) {
        sqlx::query(
            "INSERT INTO sessions (id, workspace_id, name, executor, agent_id) VALUES (?, ?, ?, 'ACP', 'codex')",
        )
        .bind(id)
        .bind(workspace)
        .bind(name)
        .execute(pool)
        .await
        .expect("insert session");
    }

    async fn space(pool: &SqlitePool, id: &str, workspace: Uuid) {
        sqlx::query(
            "INSERT INTO collaboration_spaces (id, workspace_id, name, created_at) VALUES (?, ?, ?, '2026-01-01T00:00:00Z')",
        )
        .bind(id)
        .bind(workspace.to_string())
        .bind(id)
        .execute(pool)
        .await
        .expect("insert space");
    }

    async fn seat(pool: &SqlitePool, space_id: &str, conversation: Uuid, nickname: &str) {
        sqlx::query(
            "INSERT INTO collaboration_space_members (space_id, member_id, conversation_id, nickname, kind, visible_to_agents) VALUES (?, ?, ?, ?, 'agent', 1)",
        )
        .bind(space_id)
        .bind(Uuid::new_v4().to_string())
        .bind(conversation.to_string())
        .bind(nickname)
        .execute(pool)
        .await
        .expect("insert seat");
    }

    async fn message(pool: &SqlitePool, space_id: &str) -> String {
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO collaboration_space_messages (id, space_id, seq, envelope_json, created_at) VALUES (?, ?, 1, '{}', '2026-01-01T00:00:00Z')",
        )
        .bind(&id)
        .bind(space_id)
        .execute(pool)
        .await
        .expect("insert message");
        id
    }

    async fn seat_conversation(pool: &SqlitePool, space_id: &str, nickname: &str) -> Uuid {
        let raw: String = sqlx::query_scalar(
            "SELECT conversation_id FROM collaboration_space_members WHERE space_id = ? AND nickname = ?",
        )
        .bind(space_id)
        .bind(nickname)
        .fetch_one(pool)
        .await
        .expect("seat");
        Uuid::parse_str(&raw).unwrap()
    }

    async fn count(pool: &SqlitePool, table: &str) -> i64 {
        sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
            .fetch_one(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn migration_keeps_earliest_space_and_forks_the_rest() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let conv = Uuid::new_v4();
        session(&pool, conv, workspace, "小A").await;
        space(&pool, "space-a", workspace).await;
        space(&pool, "space-b", workspace).await;
        let kept_message = message(&pool, "space-a").await;
        seat(&pool, "space-a", conv, "小A").await;
        seat(&pool, "space-b", conv, "小A").await;

        let report = MemberIdentityMigration::run(&pool).await.unwrap();
        assert_eq!(report.seats_bound, 2);
        assert_eq!(report.conversations_created, 1);

        let member = member_id_for_conversation(conv);
        assert_eq!(seat_conversation(&pool, "space-a", "小A").await, conv);
        let forked = seat_conversation(&pool, "space-b", "小A").await;
        assert_ne!(forked, conv);
        let binding = binding_of_conversation(&pool, forked).await.unwrap().unwrap();
        assert_eq!(binding.member_id, member);
        assert_eq!(binding.thread_id, "space-b");
        let forked_workspace: Uuid =
            sqlx::query_scalar("SELECT workspace_id FROM sessions WHERE id = ?")
                .bind(forked)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(forked_workspace, workspace);
        // The group thread is the space, so its messages stay addressable.
        let thread = load_thread(&pool, "space-a").await.unwrap().unwrap();
        assert_eq!(thread.kind, "group");
        let space_of_message: String =
            sqlx::query_scalar("SELECT space_id FROM collaboration_space_messages WHERE id = ?")
                .bind(&kept_message)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(space_of_message, thread.id);

        // Idempotent: a second run changes nothing.
        let again = MemberIdentityMigration::run(&pool).await.unwrap();
        assert_eq!(again.conversations_created, 0);
        assert_eq!(count(&pool, "collaboration_members").await, 1);
        assert_eq!(count(&pool, "collaboration_thread_members").await, 2);
        assert_eq!(seat_conversation(&pool, "space-b", "小A").await, forked);
    }

    #[tokio::test]
    async fn migration_turns_undecided_seats_into_direct_threads() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let conv = Uuid::new_v4();
        session(&pool, conv, workspace, "小B").await;
        sqlx::query(
            "INSERT INTO conversation_personas (conversation_id, role_id, name, agent_id, snapshotted_at) VALUES (?, 'role-1', '评审', 'codex', '2026-01-01T00:00:00Z')",
        )
        .bind(conv.to_string())
        .execute(&pool)
        .await
        .unwrap();
        let undecided = format!("{UNASSIGNED_PREFIX}{workspace}");
        seat(&pool, &undecided, conv, "小B").await;

        MemberIdentityMigration::run(&pool).await.unwrap();

        let member_id = member_id_for_conversation(conv);
        let member = load_member(&pool, &member_id).await.unwrap().unwrap();
        assert_eq!(member.role_id.as_deref(), Some("role-1"));
        assert_eq!(member.name, "评审");
        let binding = binding_of_conversation(&pool, conv).await.unwrap().unwrap();
        assert_eq!(binding.thread_id, direct_thread_id(&member_id));
        let thread = load_thread(&pool, &binding.thread_id).await.unwrap().unwrap();
        assert_eq!(thread.kind, "direct");
        assert_eq!(thread.workspace_id, Some(workspace.to_string()));
        assert_eq!(seat_conversation(&pool, &undecided, "小B").await, conv);
    }

    #[tokio::test]
    async fn resolve_session_creates_once_per_thread() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let conv = Uuid::new_v4();
        session(&pool, conv, workspace, "小C").await;
        space(&pool, "space-a", workspace).await;
        space(&pool, "space-b", workspace).await;
        let (member, thread, first) = bind_seat(&pool, "space-a", conv, None).await.unwrap();
        assert_eq!(thread, "space-a");
        assert_eq!(first.conversation_id, conv);
        assert!(!first.created);

        // Same member, same thread: always the same conversation.
        let same = resolve_session(&pool, &member, "space-a").await.unwrap();
        assert_eq!(same.conversation_id, conv);
        assert!(!same.created);

        // Same member, another thread: a distinct conversation, created once.
        ensure_thread_for_seat(&pool, "space-b", &member).await.unwrap();
        let other = resolve_session(&pool, &member, "space-b").await.unwrap();
        assert!(other.created);
        assert_ne!(other.conversation_id, conv);
        assert_eq!(other.template_conversation_id, Some(conv));
        let repeat = resolve_session(&pool, &member, "space-b").await.unwrap();
        assert!(!repeat.created);
        assert_eq!(repeat.conversation_id, other.conversation_id);

        let missing = resolve_session(&pool, &member, "no-such-thread").await;
        assert!(matches!(missing, Err(IdentityError::NotFound(_))));
    }
}
