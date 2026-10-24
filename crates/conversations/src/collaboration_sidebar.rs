//! Flat collaboration sidebar: group chats and direct chats in one list,
//! most recent activity first. Members are identities
//! (`collaboration_members`); a member's per-thread session is hidden and is
//! opened through `member.session.resolve`.

use ::db::models::collaboration_identity as identity;
use serde::Serialize;
use serde_json::Value;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::collaboration::{CollaborationError, db as db_err, now_stamp};

/// Group avatars show at most this many members.
pub const MEMBERS_PREVIEW_LIMIT: usize = 4;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SidebarMember {
    /// Identity id (`collaboration_members.id`), the `memberId` for `member.*`.
    pub member_id: String,
    pub name: String,
    pub avatar: Option<String>,
    pub color: Option<String>,
    /// This member's hidden session inside the thread.
    pub conversation_id: String,
    pub agent: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SidebarLastMessage {
    pub id: Option<String>,
    pub seq: Option<i64>,
    pub preview: Option<String>,
    pub origin: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SidebarItem {
    /// `group` or `dm`.
    pub kind: String,
    /// Group: the space id. Direct: `direct:<member_id>`.
    pub thread_id: String,
    /// Group only: same as `thread_id` (for `space.*` calls).
    pub space_id: Option<String>,
    pub name: String,
    pub tag_color: Option<String>,
    /// Group: first 4 non-user members in join order. Direct: the one member.
    pub members_preview: Vec<SidebarMember>,
    pub member_count: usize,
    /// Direct only: the member on the other side.
    pub member: Option<SidebarMember>,
    pub last_message: Option<SidebarLastMessage>,
    pub last_activity_at: String,
    pub unread_count: i64,
}

type MemberJoinRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
);

async fn thread_members(
    pool: &SqlitePool,
    thread_id: &str,
) -> Result<Vec<SidebarMember>, CollaborationError> {
    let rows = sqlx::query_as::<_, MemberJoinRow>(
        r#"SELECT m.id, m.name, m.avatar, m.color, tm.conversation_id, m.agent
           FROM collaboration_thread_members tm
           JOIN collaboration_members m ON m.id = tm.member_id
           WHERE tm.thread_id = ? AND tm.status = 'active'
           ORDER BY tm.joined_at, tm.member_id"#,
    )
    .bind(thread_id)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    Ok(rows
        .into_iter()
        .map(
            |(member_id, name, avatar, color, conversation_id, agent)| SidebarMember {
                member_id,
                name,
                avatar,
                color,
                conversation_id,
                agent,
            },
        )
        .collect())
}

fn preview_text(envelope: &Value) -> Option<String> {
    let pick = |value: Option<&Value>| {
        value
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    };
    let text = pick(envelope.get("summary"))
        .or_else(|| pick(envelope.get("content")))
        .or_else(|| pick(envelope.pointer("/object/content")))
        .or_else(|| pick(envelope.pointer("/content/text")))
        .or_else(|| pick(envelope.get("text")))?;
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    Some(flat.chars().take(120).collect())
}

async fn last_message(
    pool: &SqlitePool,
    thread_id: &str,
) -> Result<Option<SidebarLastMessage>, CollaborationError> {
    let row = sqlx::query_as::<_, (String, i64, String, String, String)>(
        r#"SELECT id, seq, envelope_json, origin, created_at
           FROM collaboration_space_messages WHERE space_id = ?
           ORDER BY seq DESC LIMIT 1"#,
    )
    .bind(thread_id)
    .fetch_optional(pool)
    .await
    .map_err(db_err)?;
    Ok(row.map(|(id, seq, envelope, origin, created_at)| {
        let envelope: Value = serde_json::from_str(&envelope).unwrap_or(Value::Null);
        SidebarLastMessage {
            id: Some(id),
            seq: Some(seq),
            preview: preview_text(&envelope),
            origin: Some(origin),
            created_at,
        }
    }))
}

/// Unread = agent messages after the user's read mark. A thread seen for the
/// first time is baselined at its current tail, so upgrades start at zero.
async fn unread_count(
    pool: &SqlitePool,
    thread_id: &str,
    tail_seq: Option<i64>,
) -> Result<i64, CollaborationError> {
    let read: Option<i64> = sqlx::query_scalar(
        "SELECT last_read_seq FROM collaboration_thread_reads WHERE thread_id = ?",
    )
    .bind(thread_id)
    .fetch_optional(pool)
    .await
    .map_err(db_err)?;
    let Some(read) = read else {
        sqlx::query(
            r#"INSERT INTO collaboration_thread_reads (thread_id, last_read_seq, updated_at)
               VALUES (?, ?, ?) ON CONFLICT(thread_id) DO NOTHING"#,
        )
        .bind(thread_id)
        .bind(tail_seq.unwrap_or(0))
        .bind(now_stamp())
        .execute(pool)
        .await
        .map_err(db_err)?;
        return Ok(0);
    };
    sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM collaboration_space_messages
           WHERE space_id = ? AND seq > ? AND origin = 'agent'"#,
    )
    .bind(thread_id)
    .bind(read)
    .fetch_one(pool)
    .await
    .map_err(db_err)
}

async fn session_updated_at(pool: &SqlitePool, conversation_id: &str) -> Option<String> {
    let id = Uuid::parse_str(conversation_id).ok()?;
    sqlx::query_scalar::<_, String>("SELECT CAST(updated_at AS TEXT) FROM sessions WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
}

pub async fn list_sidebar(
    pool: &SqlitePool,
    workspace_id: Uuid,
) -> Result<Vec<SidebarItem>, CollaborationError> {
    let mut items = Vec::new();
    let groups = sqlx::query_as::<_, (String, String, Option<String>, String)>(
        r#"SELECT id, name, tag_color, created_at FROM collaboration_spaces
           WHERE workspace_id = ? ORDER BY created_at, id"#,
    )
    .bind(workspace_id.to_string())
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    for (space_id, name, tag_color, created_at) in groups {
        let members = thread_members(pool, &space_id).await?;
        let last = last_message(pool, &space_id).await?;
        let unread = unread_count(pool, &space_id, last.as_ref().and_then(|m| m.seq)).await?;
        let last_activity_at = last
            .as_ref()
            .map(|m| m.created_at.clone())
            .unwrap_or(created_at);
        items.push(SidebarItem {
            kind: "group".into(),
            thread_id: space_id.clone(),
            space_id: Some(space_id),
            name,
            tag_color,
            member_count: members.len(),
            members_preview: members.into_iter().take(MEMBERS_PREVIEW_LIMIT).collect(),
            member: None,
            last_message: last,
            last_activity_at,
            unread_count: unread,
        });
    }
    let directs = sqlx::query_as::<_, (String, String, String)>(
        r#"SELECT id, title, created_at FROM collaboration_threads
           WHERE kind = 'direct' AND workspace_id = ? ORDER BY created_at, id"#,
    )
    .bind(workspace_id.to_string())
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    for (thread_id, title, created_at) in directs {
        let members = thread_members(pool, &thread_id).await?;
        let Some(member) = members.into_iter().next() else {
            continue;
        };
        let last = last_message(pool, &thread_id).await?;
        let unread = unread_count(pool, &thread_id, last.as_ref().and_then(|m| m.seq)).await?;
        let last_activity_at = match last.as_ref() {
            Some(message) => message.created_at.clone(),
            None => session_updated_at(pool, &member.conversation_id)
                .await
                .unwrap_or(created_at),
        };
        let name = if member.name.trim().is_empty() {
            title
        } else {
            member.name.clone()
        };
        items.push(SidebarItem {
            kind: "dm".into(),
            thread_id,
            space_id: None,
            name,
            tag_color: None,
            members_preview: vec![member.clone()],
            member_count: 1,
            member: Some(member),
            last_message: last,
            last_activity_at,
            unread_count: unread,
        });
    }
    items.sort_by(|a, b| {
        normalize(&b.last_activity_at)
            .cmp(&normalize(&a.last_activity_at))
            .then_with(|| a.thread_id.cmp(&b.thread_id))
    });
    Ok(items)
}

/// Comparable instant for mixed RFC3339 / SQLite datetime strings.
fn normalize(stamp: &str) -> i64 {
    if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(stamp) {
        return parsed.timestamp_millis();
    }
    for format in ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%d %H:%M:%S"] {
        if let Ok(parsed) = chrono::NaiveDateTime::parse_from_str(stamp, format) {
            return parsed.and_utc().timestamp_millis();
        }
    }
    0
}

/// Mark a thread read up to `seq` (default: its current tail). Never moves back.
pub async fn mark_thread_read(
    pool: &SqlitePool,
    thread_id: &str,
    seq: Option<i64>,
) -> Result<i64, CollaborationError> {
    let seq = match seq {
        Some(seq) => seq,
        None => sqlx::query_scalar::<_, Option<i64>>(
            "SELECT MAX(seq) FROM collaboration_space_messages WHERE space_id = ?",
        )
        .bind(thread_id)
        .fetch_one(pool)
        .await
        .map_err(db_err)?
        .unwrap_or(0),
    };
    sqlx::query(
        r#"INSERT INTO collaboration_thread_reads (thread_id, last_read_seq, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET
             last_read_seq = MAX(last_read_seq, excluded.last_read_seq),
             updated_at = excluded.updated_at"#,
    )
    .bind(thread_id)
    .bind(seq)
    .bind(now_stamp())
    .execute(pool)
    .await
    .map_err(db_err)?;
    sqlx::query_scalar("SELECT last_read_seq FROM collaboration_thread_reads WHERE thread_id = ?")
        .bind(thread_id)
        .fetch_one(pool)
        .await
        .map_err(db_err)
}

pub async fn set_space_tag_color(
    pool: &SqlitePool,
    space_id: &str,
    tag_color: Option<&str>,
) -> Result<(), CollaborationError> {
    let updated = sqlx::query("UPDATE collaboration_spaces SET tag_color = ? WHERE id = ?")
        .bind(tag_color)
        .bind(space_id)
        .execute(pool)
        .await
        .map_err(db_err)?;
    if updated.rows_affected() == 0 {
        return Err(CollaborationError::new("not_found", "space was not found"));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MemberSummary {
    pub member_id: String,
    pub name: String,
    pub avatar: Option<String>,
    pub color: Option<String>,
    pub agent: Option<String>,
    pub role_id: Option<String>,
    pub direct_thread_id: String,
    /// Threads (direct + group) the member is active in, join order.
    pub thread_ids: Vec<String>,
}

/// Members that have a session in `workspace_id` (any thread), by creation.
pub async fn list_members(
    pool: &SqlitePool,
    workspace_id: Uuid,
) -> Result<Vec<MemberSummary>, CollaborationError> {
    type Row = (
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let rows = sqlx::query_as::<_, Row>(
        r#"SELECT DISTINCT m.id, m.name, m.avatar, m.color, m.agent, m.role_id
           FROM collaboration_members m
           JOIN collaboration_thread_members tm ON tm.member_id = m.id AND tm.status = 'active'
           JOIN collaboration_threads t ON t.id = tm.thread_id
           WHERE t.workspace_id = ?
           ORDER BY m.created_at, m.id"#,
    )
    .bind(workspace_id.to_string())
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    let mut out = Vec::new();
    for (member_id, name, avatar, color, agent, role_id) in rows {
        let thread_ids = sqlx::query_scalar::<_, String>(
            r#"SELECT thread_id FROM collaboration_thread_members
               WHERE member_id = ? AND status = 'active' ORDER BY joined_at, thread_id"#,
        )
        .bind(&member_id)
        .fetch_all(pool)
        .await
        .map_err(db_err)?;
        out.push(MemberSummary {
            direct_thread_id: identity::direct_thread_id(&member_id),
            member_id,
            name,
            avatar,
            color,
            agent,
            role_id,
            thread_ids,
        });
    }
    Ok(out)
}

/// Update identity display fields. `None` leaves a field unchanged; an empty
/// string clears avatar / color.
pub async fn update_member_profile(
    pool: &SqlitePool,
    member_id: &str,
    name: Option<&str>,
    avatar: Option<&str>,
    color: Option<&str>,
) -> Result<(), CollaborationError> {
    let exists: Option<String> =
        sqlx::query_scalar("SELECT id FROM collaboration_members WHERE id = ?")
            .bind(member_id)
            .fetch_optional(pool)
            .await
            .map_err(db_err)?;
    if exists.is_none() {
        return Err(CollaborationError::new("not_found", "member was not found"));
    }
    if let Some(name) = name.map(str::trim).filter(|n| !n.is_empty()) {
        sqlx::query("UPDATE collaboration_members SET name = ? WHERE id = ?")
            .bind(name)
            .bind(member_id)
            .execute(pool)
            .await
            .map_err(db_err)?;
    }
    let blank = |v: &str| {
        let v = v.trim();
        if v.is_empty() {
            None
        } else {
            Some(v.to_string())
        }
    };
    if let Some(avatar) = avatar {
        sqlx::query("UPDATE collaboration_members SET avatar = ? WHERE id = ?")
            .bind(blank(avatar))
            .bind(member_id)
            .execute(pool)
            .await
            .map_err(db_err)?;
    }
    if let Some(color) = color {
        sqlx::query("UPDATE collaboration_members SET color = ? WHERE id = ?")
            .bind(blank(color))
            .bind(member_id)
            .execute(pool)
            .await
            .map_err(db_err)?;
    }
    Ok(())
}

/// Identity id behind a seat conversation (`space.createMember` result).
pub async fn identity_member_of_conversation(
    pool: &SqlitePool,
    conversation_id: &str,
) -> Result<Option<String>, CollaborationError> {
    sqlx::query_scalar(
        "SELECT member_id FROM collaboration_thread_members WHERE conversation_id = ?",
    )
    .bind(conversation_id)
    .fetch_optional(pool)
    .await
    .map_err(db_err)
}
