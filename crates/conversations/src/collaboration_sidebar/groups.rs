use super::*;

pub(super) async fn read_mark(
    pool: &SqlitePool,
    thread_id: &str,
) -> Result<Option<i64>, CollaborationError> {
    sqlx::query_scalar("SELECT last_read_seq FROM collaboration_thread_reads WHERE thread_id = ?")
        .bind(thread_id)
        .fetch_optional(pool)
        .await
        .map_err(db_err)
}

/// DM unread = agent messages whose ordinal is past the read mark. First sight
/// baselines at the current tail (upgrades start at zero), like groups.
pub(super) async fn dm_unread_count_with_read(
    pool: &SqlitePool,
    thread_id: &str,
    conversation_id: Uuid,
    read: Option<i64>,
    tail_seq: Option<i64>,
) -> Result<i64, CollaborationError> {
    let Some(read) = read else {
        baseline_thread_read(pool, thread_id, tail_seq).await?;
        return Ok(0);
    };
    if tail_seq.is_some_and(|tail| tail <= read) {
        return Ok(0);
    }
    if dm_cutover_info(pool, conversation_id, thread_id)
        .await?
        .is_some()
    {
        let space_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM collaboration_space_messages WHERE space_id = ?",
        )
        .bind(thread_id)
        .fetch_one(pool)
        .await
        .map_err(db_err)?;
        if space_count > 0 {
            let unread: i64 = sqlx::query_scalar(
                r#"SELECT COUNT(*)
                   FROM collaboration_space_messages
                   WHERE space_id = ? AND seq > ? AND origin = 'agent'"#,
            )
            .bind(thread_id)
            .bind(read)
            .fetch_one(pool)
            .await
            .map_err(db_err)?;
            return Ok(unread);
        }
    }
    let rows = dm_rows_since(pool, conversation_id, read, None).await?;
    if rows.is_empty() {
        return Ok(0);
    }
    let messages = grouped_dm_rows(pool, conversation_id, rows).await?;
    Ok(messages
        .iter()
        .filter(|message| message.seq > read && message.origin == "agent")
        .count() as i64)
}

pub(super) async fn dm_tail_seq(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<i64, CollaborationError> {
    Ok(dm_last_message(pool, conversation_id)
        .await?
        .and_then(|message| message.seq)
        .unwrap_or(0))
}

pub(super) type ThreadMemberJoinRow = (
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
    i64,
);

pub(super) async fn workspace_thread_members(
    pool: &SqlitePool,
    workspace_id: &str,
) -> Result<HashMap<String, Vec<SidebarMember>>, CollaborationError> {
    let rows = sqlx::query_as::<_, ThreadMemberJoinRow>(
        r#"SELECT tm.thread_id, m.id, m.name, m.avatar, m.color, tm.conversation_id, m.agent, m.is_supervisor
           FROM collaboration_thread_members tm
           JOIN collaboration_members m ON m.id = tm.member_id
           WHERE tm.status = 'active'
             AND (
               tm.thread_id IN (SELECT id FROM collaboration_spaces WHERE workspace_id = ?1)
               OR tm.thread_id IN (SELECT id FROM collaboration_threads WHERE kind = 'direct' AND workspace_id = ?1)
             )
           ORDER BY tm.joined_at, tm.member_id"#,
    )
    .bind(workspace_id)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    let mut by_thread: HashMap<String, Vec<SidebarMember>> = HashMap::new();
    for (thread_id, member_id, name, avatar, color, conversation_id, agent, is_supervisor) in rows {
        by_thread.entry(thread_id).or_default().push(SidebarMember {
            member_id,
            name,
            avatar,
            color,
            conversation_id,
            agent,
            is_supervisor: is_supervisor != 0,
        });
    }
    Ok(by_thread)
}

pub(super) async fn workspace_group_last_messages(
    pool: &SqlitePool,
    workspace_id: &str,
) -> Result<HashMap<String, SidebarLastMessage>, CollaborationError> {
    let rows = sqlx::query_as::<_, (String, String, i64, String, String, String)>(
        r#"SELECT m.space_id, m.id, m.seq, m.envelope_json, m.origin, m.created_at
           FROM collaboration_space_messages m
           JOIN (
               SELECT space_id, MAX(seq) AS max_seq
               FROM collaboration_space_messages
               WHERE space_id IN (SELECT id FROM collaboration_spaces WHERE workspace_id = ?1)
               GROUP BY space_id
           ) latest ON latest.space_id = m.space_id AND latest.max_seq = m.seq"#,
    )
    .bind(workspace_id)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    Ok(rows
        .into_iter()
        .map(|(space_id, id, seq, envelope, origin, created_at)| {
            (
                space_id,
                sidebar_last_from_group_row(id, seq, envelope, origin, created_at),
            )
        })
        .collect())
}

pub(super) async fn workspace_read_marks(
    pool: &SqlitePool,
    workspace_id: &str,
) -> Result<HashMap<String, i64>, CollaborationError> {
    let rows = sqlx::query_as::<_, (String, i64)>(
        r#"SELECT thread_id, last_read_seq
           FROM collaboration_thread_reads
           WHERE thread_id IN (SELECT id FROM collaboration_spaces WHERE workspace_id = ?1)
              OR thread_id IN (SELECT id FROM collaboration_threads WHERE kind = 'direct' AND workspace_id = ?1)"#,
    )
    .bind(workspace_id)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    Ok(rows.into_iter().collect())
}

pub(super) async fn workspace_group_unreads(
    pool: &SqlitePool,
    workspace_id: &str,
) -> Result<HashMap<String, i64>, CollaborationError> {
    let rows = sqlx::query_as::<_, (String, i64)>(
        r#"SELECT m.space_id, COUNT(*)
           FROM collaboration_space_messages m
           JOIN collaboration_thread_reads r ON r.thread_id = m.space_id
           WHERE m.space_id IN (SELECT id FROM collaboration_spaces WHERE workspace_id = ?1)
             AND m.seq > r.last_read_seq
             AND m.origin = 'agent'
           GROUP BY m.space_id"#,
    )
    .bind(workspace_id)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    Ok(rows.into_iter().collect())
}

pub async fn list_sidebar(
    pool: &SqlitePool,
    workspace_id: Uuid,
) -> Result<Vec<SidebarItem>, CollaborationError> {
    let workspace_str = workspace_id.to_string();
    let mut items = Vec::new();
    let groups = sqlx::query_as::<_, (String, String, Option<String>, String)>(
        r#"SELECT id, name, tag_color, created_at FROM collaboration_spaces
           WHERE workspace_id = ? ORDER BY created_at, id"#,
    )
    .bind(&workspace_str)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    let directs = sqlx::query_as::<_, (String, String, String)>(
        r#"SELECT id, title, created_at FROM collaboration_threads
           WHERE kind = 'direct' AND workspace_id = ? ORDER BY created_at, id"#,
    )
    .bind(&workspace_str)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;

    let mut members_by_thread = workspace_thread_members(pool, &workspace_str).await?;
    let mut group_last_by_space = workspace_group_last_messages(pool, &workspace_str).await?;
    let read_marks = workspace_read_marks(pool, &workspace_str).await?;
    let group_unreads = workspace_group_unreads(pool, &workspace_str).await?;

    for (space_id, name, tag_color, created_at) in groups {
        let members = members_by_thread.remove(&space_id).unwrap_or_default();
        let last = group_last_by_space.remove(&space_id);
        let tail_seq = last.as_ref().and_then(|m| m.seq);
        let unread = if read_marks.contains_key(&space_id) {
            *group_unreads.get(&space_id).unwrap_or(&0)
        } else {
            baseline_thread_read(pool, &space_id, tail_seq).await?;
            0
        };
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
            group_id: None,
        });
    }

    for (thread_id, title, created_at) in directs {
        let members = members_by_thread.remove(&thread_id).unwrap_or_default();
        let Some(member) = members.into_iter().next() else {
            continue;
        };
        let read_mark = read_marks.get(&thread_id).copied();
        let (last, unread) = match Uuid::parse_str(&member.conversation_id) {
            Ok(conversation) => {
                let last = dm_last_message(pool, conversation).await?;
                let unread = dm_unread_count_with_read(
                    pool,
                    &thread_id,
                    conversation,
                    read_mark,
                    last.as_ref().and_then(|m| m.seq),
                )
                .await?;
                (last, unread)
            }
            Err(_) => (None, 0),
        };
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
            group_id: None,
        });
    }

    let assigned = sqlx::query_as::<_, (String, String)>(
        r#"SELECT tg.thread_id, tg.group_id FROM collaboration_thread_contact_groups tg
           JOIN collaboration_contact_groups g ON g.id = tg.group_id
           WHERE g.workspace_id = ?"#,
    )
    .bind(workspace_str)
    .fetch_all(pool)
    .await
    .map_err(db_err)?
    .into_iter()
    .collect::<HashMap<_, _>>();
    for item in &mut items {
        item.group_id = assigned.get(&item.thread_id).cloned();
    }
    items.sort_by_cached_key(|item| {
        (
            std::cmp::Reverse(normalize(&item.last_activity_at)),
            item.thread_id.clone(),
        )
    });
    Ok(items)
}

/// Comparable instant for mixed RFC3339 / SQLite datetime strings.
pub(super) fn normalize(stamp: &str) -> i64 {
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
    let dm = dm_conversation(pool, thread_id).await?;
    let seq = match (seq, dm) {
        (Some(seq), _) => seq,
        (None, Some((conversation, _))) => dm_tail_seq(pool, conversation).await?,
        (None, None) => sqlx::query_scalar::<_, Option<i64>>(
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

/// Move the read cursor before the tail so the thread shows as unread.
/// A fully-read thread becomes unread by one (the last message).
pub async fn mark_thread_unread(
    pool: &SqlitePool,
    thread_id: &str,
) -> Result<i64, CollaborationError> {
    let dm = dm_conversation(pool, thread_id).await?;
    let tail = match dm {
        Some((conversation, _)) => dm_tail_seq(pool, conversation).await?,
        None => sqlx::query_scalar::<_, Option<i64>>(
            "SELECT MAX(seq) FROM collaboration_space_messages WHERE space_id = ?",
        )
        .bind(thread_id)
        .fetch_one(pool)
        .await
        .map_err(db_err)?
        .unwrap_or(0),
    };
    let current = read_mark(pool, thread_id).await?.unwrap_or(tail);
    let seq = if tail <= 0 {
        0
    } else if current >= tail {
        tail - 1
    } else {
        current.min(tail - 1)
    };
    sqlx::query(
        r#"INSERT INTO collaboration_thread_reads (thread_id, last_read_seq, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET
             last_read_seq = excluded.last_read_seq,
             updated_at = excluded.updated_at"#,
    )
    .bind(thread_id)
    .bind(seq)
    .bind(now_stamp())
    .execute(pool)
    .await
    .map_err(db_err)?;
    Ok(seq)
}

pub async fn set_space_tag_color(
    pool: &SqlitePool,
    space_id: &str,
    tag_color: Option<&str>,
) -> Result<(), CollaborationError> {
    let mut conn = pool.acquire().await.map_err(db_err)?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(db_err)?;
    let res = async {
        let updated = sqlx::query("UPDATE collaboration_spaces SET tag_color = ? WHERE id = ?")
            .bind(tag_color)
            .bind(space_id)
            .execute(&mut *conn)
            .await
            .map_err(db_err)?;
        if updated.rows_affected() == 0 {
            return Err(CollaborationError::new("not_found", "space was not found"));
        }
        append_space_event_tx(
            &mut conn,
            space_id,
            "space",
            None,
            &json!({
                "action": "tag_color_updated",
                "tag_color": tag_color,
            }),
            &now_stamp(),
        )
        .await
        .map_err(db_err)?;
        Ok::<(), CollaborationError>(())
    }
    .await;
    match res {
        Ok(()) => {
            sqlx::query("COMMIT")
                .execute(&mut *conn)
                .await
                .map_err(db_err)?;
            Ok(())
        }
        Err(err) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            Err(err)
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MemberSummary {
    pub member_id: String,
    pub name: String,
    pub avatar: Option<String>,
    pub color: Option<String>,
    pub agent: Option<String>,
    pub role_id: Option<String>,
    pub is_supervisor: bool,
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
        i64,
    );
    let workspace_str = workspace_id.to_string();
    let rows = sqlx::query_as::<_, Row>(
        r#"SELECT DISTINCT m.id, m.name, m.avatar, m.color, m.agent, m.role_id, m.is_supervisor
           FROM collaboration_members m
           JOIN collaboration_thread_members tm ON tm.member_id = m.id AND tm.status = 'active'
           JOIN collaboration_threads t ON t.id = tm.thread_id
           WHERE t.workspace_id = ?
           ORDER BY m.created_at, m.id"#,
    )
    .bind(&workspace_str)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    let thread_rows = sqlx::query_as::<_, (String, String)>(
        r#"SELECT tm.member_id, tm.thread_id
           FROM collaboration_thread_members tm
           WHERE tm.status = 'active'
             AND tm.member_id IN (
               SELECT DISTINCT tm2.member_id
               FROM collaboration_thread_members tm2
               JOIN collaboration_threads t ON t.id = tm2.thread_id
               WHERE tm2.status = 'active' AND t.workspace_id = ?
             )
           ORDER BY tm.joined_at, tm.thread_id"#,
    )
    .bind(&workspace_str)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    let mut threads_by_member: HashMap<String, Vec<String>> = HashMap::new();
    for (member_id, thread_id) in thread_rows {
        threads_by_member
            .entry(member_id)
            .or_default()
            .push(thread_id);
    }
    let mut out = Vec::new();
    for (member_id, name, avatar, color, agent, role_id, is_supervisor) in rows {
        let thread_ids = threads_by_member.remove(&member_id).unwrap_or_default();
        out.push(MemberSummary {
            direct_thread_id: identity::direct_thread_id(&member_id),
            member_id,
            name,
            avatar,
            color,
            agent,
            role_id,
            is_supervisor: is_supervisor != 0,
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
    let mut conn = pool.acquire().await.map_err(db_err)?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(db_err)?;
    let res = async {
        let exists: Option<String> =
            sqlx::query_scalar("SELECT id FROM collaboration_members WHERE id = ?")
                .bind(member_id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(db_err)?;
        if exists.is_none() {
            return Err(CollaborationError::new("not_found", "member was not found"));
        }
        if let Some(name) = name.map(str::trim).filter(|n| !n.is_empty()) {
            sqlx::query("UPDATE collaboration_members SET name = ? WHERE id = ?")
                .bind(name)
                .bind(member_id)
                .execute(&mut *conn)
                .await
                .map_err(db_err)?;
            let direct_tid = identity::direct_thread_id(member_id);
            sqlx::query("UPDATE collaboration_threads SET title = ? WHERE id = ?")
                .bind(name)
                .bind(&direct_tid)
                .execute(&mut *conn)
                .await
                .map_err(db_err)?;
            sqlx::query(
                r#"UPDATE collaboration_space_members
                   SET nickname = ?
                   WHERE member_id = ?
                      OR conversation_id IN (
                           SELECT conversation_id FROM collaboration_thread_members WHERE member_id = ?
                      )"#,
            )
            .bind(name)
            .bind(member_id)
            .bind(member_id)
            .execute(&mut *conn)
            .await
            .map_err(db_err)?;
            sqlx::query(
                r#"UPDATE conversation_personas
                   SET name = ?
                   WHERE conversation_id IN (
                       SELECT conversation_id FROM collaboration_thread_members WHERE member_id = ?
                   )"#,
            )
            .bind(name)
            .bind(member_id)
            .execute(&mut *conn)
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
                .execute(&mut *conn)
                .await
                .map_err(db_err)?;
        }
        if let Some(color) = color {
            sqlx::query("UPDATE collaboration_members SET color = ? WHERE id = ?")
                .bind(blank(color))
                .bind(member_id)
                .execute(&mut *conn)
                .await
                .map_err(db_err)?;
        }
        let threads: Vec<String> = sqlx::query_scalar(
            "SELECT DISTINCT thread_id FROM collaboration_thread_members WHERE member_id = ? AND status = 'active'",
        )
        .bind(member_id)
        .fetch_all(&mut *conn)
        .await
        .map_err(db_err)?;
        let now = now_stamp();
        let payload = json!({
            "action": "member_updated",
            "member_id": member_id,
            "name": name,
        });
        for tid in threads {
            append_space_event_tx(&mut conn, &tid, "roster", None, &payload, &now)
                .await
                .map_err(db_err)?;
        }
        Ok::<(), CollaborationError>(())
    }
    .await;
    match res {
        Ok(()) => {
            sqlx::query("COMMIT")
                .execute(&mut *conn)
                .await
                .map_err(db_err)?;
            Ok(())
        }
        Err(err) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            Err(err)
        }
    }
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

/// Batch lookup `(identity_member_id, is_supervisor, avatar, color)` keyed by `conversation_id`.
pub async fn identity_members_for_conversations_batch(
    pool: &SqlitePool,
    conversation_ids: &[String],
) -> Result<HashMap<String, (String, bool, Option<String>, Option<String>)>, CollaborationError> {
    let mut unique: Vec<&str> = Vec::new();
    for cid in conversation_ids {
        let trimmed = cid.trim();
        if !trimmed.is_empty() && !unique.contains(&trimmed) {
            unique.push(trimmed);
        }
    }
    if unique.is_empty() {
        return Ok(HashMap::new());
    }
    let placeholders = std::iter::repeat_n("?", unique.len())
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        r#"SELECT tm.conversation_id, tm.member_id, COALESCE(m.is_supervisor, 0), m.avatar, m.color
           FROM collaboration_thread_members tm
           LEFT JOIN collaboration_members m ON m.id = tm.member_id
           WHERE tm.conversation_id IN ({placeholders})
           ORDER BY CASE WHEN tm.status = 'active' THEN 0 ELSE 1 END"#
    );
    let mut query =
        sqlx::query_as::<_, (Option<String>, String, i64, Option<String>, Option<String>)>(&sql);
    for cid in &unique {
        query = query.bind(*cid);
    }
    let rows = query.fetch_all(pool).await.map_err(db_err)?;
    let mut out = HashMap::with_capacity(rows.len());
    for (conv_id, member_id, is_sup, avatar, color) in rows {
        if let Some(cid) = conv_id
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
        {
            out.entry(cid)
                .or_insert((member_id, is_sup != 0, avatar, color));
        }
    }

    let mut derived_to_conv: Vec<(String, String)> = Vec::new();
    for cid in &unique {
        if !out.contains_key(*cid)
            && let Ok(uuid) = Uuid::parse_str(cid)
        {
            derived_to_conv.push((
                identity::member_id_for_conversation(uuid),
                (*cid).to_string(),
            ));
        }
    }
    if !derived_to_conv.is_empty() {
        let derived_placeholders = std::iter::repeat_n("?", derived_to_conv.len())
            .collect::<Vec<_>>()
            .join(", ");
        let derived_sql = format!(
            "SELECT id, is_supervisor, avatar, color FROM collaboration_members WHERE id IN ({derived_placeholders})"
        );
        let mut derived_query =
            sqlx::query_as::<_, (String, i64, Option<String>, Option<String>)>(&derived_sql);
        for (mid, _) in &derived_to_conv {
            derived_query = derived_query.bind(mid);
        }
        let derived_rows = derived_query.fetch_all(pool).await.map_err(db_err)?;
        let derived_map: HashMap<String, (bool, Option<String>, Option<String>)> = derived_rows
            .into_iter()
            .map(|(id, sup, avatar, color)| (id, (sup != 0, avatar, color)))
            .collect();
        for (mid, cid) in derived_to_conv {
            if let Some((is_sup, avatar, color)) = derived_map.get(&mid) {
                out.entry(cid)
                    .or_insert((mid, *is_sup, avatar.clone(), color.clone()));
            }
        }
    }
    Ok(out)
}

/// Enrich `MemberRecord` items in batch with resolved group `conversation_id`,
/// `identity_member_id`, `is_supervisor`, `avatar`, and `color` in O(1) SQL queries for initialized group spaces.
pub async fn enrich_space_members_batch(
    pool: &SqlitePool,
    space_id: &str,
    mut members: Vec<crate::collaboration::MemberRecord>,
) -> Result<Vec<serde_json::Value>, CollaborationError> {
    if members.is_empty() {
        return Ok(Vec::new());
    }
    let is_group_space = !space_id.starts_with("unassigned:") && !space_id.starts_with("direct:");
    let mut identity_by_conv: HashMap<String, (String, bool, Option<String>, Option<String>)> =
        HashMap::new();

    if is_group_space {
        let bound_rows =
            sqlx::query_as::<_, (Option<String>, String, i64, Option<String>, Option<String>)>(
                r#"SELECT tm.conversation_id, tm.member_id, COALESCE(m.is_supervisor, 0), m.avatar, m.color
                   FROM collaboration_thread_members tm
                   JOIN collaboration_threads t ON t.id = tm.thread_id
                   LEFT JOIN collaboration_members m ON m.id = tm.member_id
                   WHERE tm.thread_id = ? AND tm.conversation_id IS NOT NULL"#,
            )
            .bind(space_id)
            .fetch_all(pool)
            .await
            .map_err(db_err)?;

        for (conv_id, identity_id, is_sup, avatar, color) in bound_rows {
            if let Some(cid) = conv_id
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
            {
                identity_by_conv
                    .entry(cid)
                    .or_insert((identity_id, is_sup != 0, avatar, color));
            }
        }

        for member in &mut members {
            if member.kind != "agent" {
                continue;
            }
            let already_bound = member
                .conversation_id
                .as_deref()
                .map(str::trim)
                .is_some_and(|cid| identity_by_conv.contains_key(cid));
            if !already_bound
                && let Ok(resolved) =
                    crate::collaboration::resolve_thread_session(pool, &member.member_id, space_id)
                        .await
            {
                member.conversation_id = Some(resolved.to_string());
            }
        }
    }

    let unresolved_convs: Vec<String> = members
        .iter()
        .filter_map(|m| m.conversation_id.as_deref())
        .map(str::trim)
        .filter(|cid| !cid.is_empty() && !identity_by_conv.contains_key(*cid))
        .map(str::to_string)
        .collect();

    if !unresolved_convs.is_empty() {
        let extra = identity_members_for_conversations_batch(pool, &unresolved_convs).await?;
        for (cid, info) in extra {
            identity_by_conv.entry(cid).or_insert(info);
        }
    }

    let mut listed = Vec::with_capacity(members.len());
    for member in members {
        let (identity_member_id, is_supervisor, avatar, color) = member
            .conversation_id
            .as_deref()
            .map(str::trim)
            .and_then(|cid| identity_by_conv.get(cid))
            .map(|(mid, sup, av, col)| (Some(mid.clone()), *sup, av.clone(), col.clone()))
            .unwrap_or((None, false, None, None));
        let mut value = serde_json::to_value(&member).map_err(|error| {
            CollaborationError::new("conversation_control_failed", error.to_string())
        })?;
        if let Some(object) = value.as_object_mut() {
            object.insert("identity_member_id".into(), json!(identity_member_id));
            object.insert("is_supervisor".into(), json!(is_supervisor));
            if let Some(av) = avatar {
                object.insert("avatar".into(), json!(av));
            }
            if let Some(col) = color {
                object.insert("color".into(), json!(col));
            }
        }
        listed.push(value);
    }
    Ok(listed)
}

/// Display name of the identity member behind a seat conversation.
pub async fn identity_member_name_of_conversation(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Option<String>, CollaborationError> {
    sqlx::query_scalar(
        r#"SELECT m.name
           FROM collaboration_members m
           JOIN collaboration_thread_members tm ON tm.member_id = m.id
           WHERE tm.conversation_id = ? AND tm.status = 'active'
           LIMIT 1"#,
    )
    .bind(conversation_id.to_string())
    .fetch_optional(pool)
    .await
    .map_err(db_err)
}

/// Returns `(member_id, name)` of the active supervisor bot in `workspace_id`, if any.
pub async fn workspace_supervisor_member(
    pool: &SqlitePool,
    workspace_id: Uuid,
) -> Result<Option<(String, String)>, CollaborationError> {
    sqlx::query_as::<_, (String, String)>(
        r#"SELECT m.id, m.name
           FROM collaboration_members m
           JOIN collaboration_thread_members tm ON tm.member_id = m.id AND tm.status = 'active'
           JOIN collaboration_threads t ON t.id = tm.thread_id
           WHERE t.workspace_id = ? AND m.is_supervisor != 0
           ORDER BY m.created_at, m.id
           LIMIT 1"#,
    )
    .bind(workspace_id.to_string())
    .fetch_optional(pool)
    .await
    .map_err(db_err)
}

/// Assign, replace, or clear (`None` / `Some("")`) the supervisor bot for `workspace_id`.
/// `member_ref` may be a `collaboration_members.id`, `direct:<member_id>`, or a session `conversation_id`.
/// Returns the new supervisor `member_id` (or `None` when cleared).
pub async fn set_workspace_supervisor(
    pool: &SqlitePool,
    workspace_id: Uuid,
    member_ref: Option<&str>,
) -> Result<Option<String>, CollaborationError> {
    let workspace_str = workspace_id.to_string();
    let target_member_id = match member_ref.map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => {
            let stripped = raw.strip_prefix(identity::DIRECT_PREFIX).unwrap_or(raw);
            let direct_match: Option<String> = sqlx::query_scalar(
                r#"SELECT m.id
                   FROM collaboration_members m
                   JOIN collaboration_thread_members tm ON tm.member_id = m.id AND tm.status = 'active'
                   JOIN collaboration_threads t ON t.id = tm.thread_id
                   WHERE t.workspace_id = ?1
                     AND (m.id = ?2 OR tm.conversation_id = ?2 OR LOWER(TRIM(m.name)) = LOWER(?2))
                   ORDER BY CASE
                     WHEN m.id = ?2 THEN 0
                     WHEN tm.conversation_id = ?2 THEN 1
                     ELSE 2
                   END
                   LIMIT 1"#,
            )
            .bind(&workspace_str)
            .bind(stripped)
            .fetch_optional(pool)
            .await
            .map_err(db_err)?;
            let resolved = match direct_match {
                Some(id) => Some(id),
                None => {
                    let fallback_conv: Option<(String, Option<String>, String)> = sqlx::query_as(
                        r#"SELECT sm.space_id, sm.conversation_id, sm.nickname
                           FROM collaboration_space_members sm
                           JOIN collaboration_spaces s ON s.id = sm.space_id
                           WHERE s.workspace_id = ?1
                             AND sm.kind = 'agent'
                             AND (sm.member_id = ?2 OR sm.conversation_id = ?2 OR LOWER(TRIM(sm.nickname)) = LOWER(?2))
                           ORDER BY CASE
                             WHEN sm.member_id = ?2 THEN 0
                             WHEN sm.conversation_id = ?2 THEN 1
                             ELSE 2
                           END
                           LIMIT 1"#,
                    )
                    .bind(&workspace_str)
                    .bind(stripped)
                    .fetch_optional(pool)
                    .await
                    .map_err(db_err)?;
                    if let Some((space_id, Some(conv_raw), nickname)) = fallback_conv
                        && let Ok(conv_id) = Uuid::parse_str(conv_raw.trim())
                    {
                        let (member_id, _, _) =
                            identity::bind_seat(pool, &space_id, conv_id, Some(&nickname))
                                .await
                                .map_err(|e| {
                                    CollaborationError::new(
                                        "conversation_control_failed",
                                        e.to_string(),
                                    )
                                })?;
                        Some(member_id)
                    } else {
                        None
                    }
                }
            };
            let Some(resolved) = resolved else {
                return Err(CollaborationError::new(
                    "not_found",
                    "member was not found in this workspace",
                ));
            };
            Some(resolved)
        }
        None => None,
    };

    let mut conn = pool.acquire().await.map_err(db_err)?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(db_err)?;
    let res = async {
        sqlx::query(
            r#"UPDATE collaboration_members
               SET is_supervisor = 0
               WHERE is_supervisor != 0
                 AND id IN (
                   SELECT DISTINCT tm.member_id
                   FROM collaboration_thread_members tm
                   JOIN collaboration_threads t ON t.id = tm.thread_id
                   WHERE t.workspace_id = ?
                 )"#,
        )
        .bind(&workspace_str)
        .execute(&mut *conn)
        .await
        .map_err(db_err)?;
        if let Some(ref mid) = target_member_id {
            sqlx::query("UPDATE collaboration_members SET is_supervisor = 1 WHERE id = ?")
                .bind(mid)
                .execute(&mut *conn)
                .await
                .map_err(db_err)?;
        }
        Ok::<Option<String>, CollaborationError>(target_member_id)
    }
    .await;
    match res {
        Ok(out) => {
            sqlx::query("COMMIT")
                .execute(&mut *conn)
                .await
                .map_err(db_err)?;
            Ok(out)
        }
        Err(err) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            Err(err)
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ContactGroup {
    pub group_id: String,
    pub workspace_id: String,
    pub name: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

pub(super) type ContactGroupRow = (String, String, String, i64, String, String);

pub(super) fn contact_group(row: ContactGroupRow) -> ContactGroup {
    let (group_id, workspace_id, name, sort_order, created_at, updated_at) = row;
    ContactGroup {
        group_id,
        workspace_id,
        name,
        sort_order,
        created_at,
        updated_at,
    }
}

pub(super) fn contact_group_name(name: &str) -> Result<String, CollaborationError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CollaborationError::new(
            "invalid_input",
            "group name is required",
        ));
    }
    Ok(name.to_string())
}

pub async fn list_contact_groups(
    pool: &SqlitePool,
    workspace_id: Uuid,
) -> Result<Vec<ContactGroup>, CollaborationError> {
    let rows = sqlx::query_as::<_, ContactGroupRow>(
        r#"SELECT id, workspace_id, name, sort_order, created_at, updated_at
           FROM collaboration_contact_groups WHERE workspace_id = ?
           ORDER BY sort_order, created_at, id"#,
    )
    .bind(workspace_id.to_string())
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    Ok(rows.into_iter().map(contact_group).collect())
}

pub async fn get_contact_group(
    pool: &SqlitePool,
    group_id: &str,
) -> Result<ContactGroup, CollaborationError> {
    sqlx::query_as::<_, ContactGroupRow>(
        r#"SELECT id, workspace_id, name, sort_order, created_at, updated_at
           FROM collaboration_contact_groups WHERE id = ?"#,
    )
    .bind(group_id)
    .fetch_optional(pool)
    .await
    .map_err(db_err)?
    .map(contact_group)
    .ok_or_else(|| CollaborationError::new("not_found", "contact group was not found"))
}

/// New group goes last.
pub async fn create_contact_group(
    pool: &SqlitePool,
    workspace_id: Uuid,
    name: &str,
) -> Result<ContactGroup, CollaborationError> {
    let name = contact_group_name(name)?;
    let id = Uuid::new_v4().to_string();
    let now = now_stamp();
    sqlx::query(
        r#"INSERT INTO collaboration_contact_groups
           (id, workspace_id, name, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1
                             FROM collaboration_contact_groups WHERE workspace_id = ?), ?, ?)"#,
    )
    .bind(&id)
    .bind(workspace_id.to_string())
    .bind(&name)
    .bind(workspace_id.to_string())
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await
    .map_err(db_err)?;
    get_contact_group(pool, &id).await
}

pub async fn rename_contact_group(
    pool: &SqlitePool,
    group_id: &str,
    name: &str,
) -> Result<ContactGroup, CollaborationError> {
    let name = contact_group_name(name)?;
    let updated = sqlx::query(
        "UPDATE collaboration_contact_groups SET name = ?, updated_at = ? WHERE id = ?",
    )
    .bind(&name)
    .bind(now_stamp())
    .bind(group_id)
    .execute(pool)
    .await
    .map_err(db_err)?;
    if updated.rows_affected() == 0 {
        return Err(CollaborationError::new(
            "not_found",
            "contact group was not found",
        ));
    }
    get_contact_group(pool, group_id).await
}

/// Deletes the group; its chats fall back to ungrouped. Returns those thread ids.
pub async fn delete_contact_group(
    pool: &SqlitePool,
    group_id: &str,
) -> Result<Vec<String>, CollaborationError> {
    get_contact_group(pool, group_id).await?;
    let mut tx = pool.begin().await.map_err(db_err)?;
    let threads = sqlx::query_scalar::<_, String>(
        "SELECT thread_id FROM collaboration_thread_contact_groups WHERE group_id = ? ORDER BY thread_id",
    )
    .bind(group_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_err)?;
    sqlx::query("DELETE FROM collaboration_thread_contact_groups WHERE group_id = ?")
        .bind(group_id)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    sqlx::query("DELETE FROM collaboration_contact_groups WHERE id = ?")
        .bind(group_id)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;
    Ok(threads)
}

/// `group_ids` is the new order; it must list every group of the workspace once.
pub async fn reorder_contact_groups(
    pool: &SqlitePool,
    workspace_id: Uuid,
    group_ids: &[String],
) -> Result<Vec<ContactGroup>, CollaborationError> {
    let existing = list_contact_groups(pool, workspace_id).await?;
    let mut want: Vec<&str> = group_ids.iter().map(String::as_str).collect();
    let mut have: Vec<&str> = existing.iter().map(|g| g.group_id.as_str()).collect();
    want.sort_unstable();
    have.sort_unstable();
    if want != have {
        return Err(CollaborationError::new(
            "invalid_input",
            "groupIds must list every contact group of the workspace exactly once",
        ));
    }
    let now = now_stamp();
    let mut tx = pool.begin().await.map_err(db_err)?;
    for (index, id) in group_ids.iter().enumerate() {
        sqlx::query(
            "UPDATE collaboration_contact_groups SET sort_order = ?, updated_at = ? WHERE id = ?",
        )
        .bind(index as i64)
        .bind(&now)
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    }
    tx.commit().await.map_err(db_err)?;
    list_contact_groups(pool, workspace_id).await
}

/// Workspace of a sidebar thread: a group (space id) or `direct:<member>`.
pub(super) async fn thread_workspace(
    pool: &SqlitePool,
    thread_id: &str,
) -> Result<String, CollaborationError> {
    let workspace: Option<Option<String>> = sqlx::query_scalar(
        r#"SELECT workspace_id FROM collaboration_spaces WHERE id = ?
           UNION ALL
           SELECT workspace_id FROM collaboration_threads WHERE id = ?
           LIMIT 1"#,
    )
    .bind(thread_id)
    .bind(thread_id)
    .fetch_optional(pool)
    .await
    .map_err(db_err)?;
    match workspace {
        Some(Some(workspace)) => Ok(workspace),
        Some(None) => Ok(String::new()),
        None => Err(CollaborationError::new("not_found", "thread was not found")),
    }
}

/// File a chat under a contact group, or `None` for ungrouped.
pub async fn set_thread_contact_group(
    pool: &SqlitePool,
    thread_id: &str,
    group_id: Option<&str>,
) -> Result<(), CollaborationError> {
    let workspace = thread_workspace(pool, thread_id).await?;
    match group_id {
        None => {
            sqlx::query("DELETE FROM collaboration_thread_contact_groups WHERE thread_id = ?")
                .bind(thread_id)
                .execute(pool)
                .await
                .map_err(db_err)?;
        }
        Some(group_id) => {
            let group = get_contact_group(pool, group_id).await?;
            if !workspace.is_empty() && group.workspace_id != workspace {
                return Err(CollaborationError::new(
                    "invalid_input",
                    "contact group belongs to another workspace",
                ));
            }
            sqlx::query(
                r#"INSERT INTO collaboration_thread_contact_groups (thread_id, group_id, updated_at)
                   VALUES (?, ?, ?)
                   ON CONFLICT(thread_id) DO UPDATE SET
                     group_id = excluded.group_id,
                     updated_at = excluded.updated_at"#,
            )
            .bind(thread_id)
            .bind(group_id)
            .bind(now_stamp())
            .execute(pool)
            .await
            .map_err(db_err)?;
        }
    }
    Ok(())
}

pub(super) fn input_optional_text(input: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| input.get(*key).and_then(serde_json::Value::as_str))
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

pub(super) fn input_required_text(
    input: &serde_json::Value,
    keys: &[&str],
) -> Result<String, CollaborationError> {
    let field = keys.first().copied().unwrap_or("value");
    input_optional_text(input, keys)
        .ok_or_else(|| CollaborationError::new("invalid_input", format!("{field} is required")))
}

pub(super) fn input_required_uuid(
    input: &serde_json::Value,
    keys: &[&str],
) -> Result<Uuid, CollaborationError> {
    let raw = input_required_text(input, keys)?;
    let field = keys.first().copied().unwrap_or("id");
    Uuid::parse_str(&raw)
        .map_err(|err| CollaborationError::new("invalid_input", format!("invalid {field}: {err}")))
}

/// Execute a sidebar / contactGroup / member list host operation and return `(payload, changed_space_id)`.
pub async fn execute_sidebar_op(
    pool: &SqlitePool,
    op: &str,
    input: &serde_json::Value,
) -> Result<(serde_json::Value, Option<String>), CollaborationError> {
    match op {
        "contactGroup.list" => {
            let workspace_id = input_required_uuid(input, &["workspaceId", "workspace_id"])?;
            let groups = list_contact_groups(pool, workspace_id).await?;
            Ok((serde_json::json!({ "groups": groups }), None))
        }
        "contactGroup.create" => {
            let workspace_id = input_required_uuid(input, &["workspaceId", "workspace_id"])?;
            let name = input_required_text(input, &["name"])?;
            let group = create_contact_group(pool, workspace_id, &name).await?;
            Ok((serde_json::json!({ "group": group }), None))
        }
        "contactGroup.rename" => {
            let group_id = input_required_text(input, &["groupId", "group_id"])?;
            let name = input_required_text(input, &["name"])?;
            let group = rename_contact_group(pool, &group_id, &name).await?;
            Ok((serde_json::json!({ "group": group }), None))
        }
        "contactGroup.delete" => {
            let group_id = input_required_text(input, &["groupId", "group_id"])?;
            let ungrouped = delete_contact_group(pool, &group_id).await?;
            Ok((
                serde_json::json!({ "groupId": group_id, "deleted": true, "ungroupedThreadIds": ungrouped }),
                None,
            ))
        }
        "contactGroup.reorder" => {
            let workspace_id = input_required_uuid(input, &["workspaceId", "workspace_id"])?;
            let group_ids = input
                .get("groupIds")
                .or_else(|| input.get("group_ids"))
                .and_then(serde_json::Value::as_array)
                .map(|ids| {
                    ids.iter()
                        .filter_map(serde_json::Value::as_str)
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .ok_or_else(|| CollaborationError::new("invalid_input", "groupIds is required"))?;
            let groups = reorder_contact_groups(pool, workspace_id, &group_ids).await?;
            Ok((serde_json::json!({ "groups": groups }), None))
        }
        "thread.setGroup" => {
            let thread_id = input_required_text(input, &["threadId", "thread_id"])?;
            let group_id = input_optional_text(input, &["groupId", "group_id"]);
            set_thread_contact_group(pool, &thread_id, group_id.as_deref()).await?;
            Ok((
                serde_json::json!({ "threadId": thread_id, "groupId": group_id }),
                None,
            ))
        }
        "thread.listSidebar" => {
            let workspace_id = input_required_uuid(input, &["workspaceId", "workspace_id"])?;
            let items = list_sidebar(pool, workspace_id).await?;
            let supervisor_member_id = workspace_supervisor_member(pool, workspace_id)
                .await?
                .map(|(id, _)| id);
            Ok((
                serde_json::json!({
                    "items": items,
                    "supervisorMemberId": supervisor_member_id,
                    "supervisor_member_id": supervisor_member_id,
                }),
                None,
            ))
        }
        "thread.markRead" => {
            let thread_id =
                input_required_text(input, &["threadId", "thread_id", "spaceId", "space_id"])?;
            let seq = input.get("seq").and_then(serde_json::Value::as_i64);
            let last_read_seq = mark_thread_read(pool, &thread_id, seq).await?;
            Ok((
                serde_json::json!({ "threadId": thread_id, "lastReadSeq": last_read_seq }),
                None,
            ))
        }
        "thread.markUnread" => {
            let thread_id =
                input_required_text(input, &["threadId", "thread_id", "spaceId", "space_id"])?;
            let last_read_seq = mark_thread_unread(pool, &thread_id).await?;
            Ok((
                serde_json::json!({ "threadId": thread_id, "lastReadSeq": last_read_seq }),
                None,
            ))
        }
        "thread.update" => {
            let space_id =
                input_required_text(input, &["threadId", "thread_id", "spaceId", "space_id"])?;
            let tag_color = input_optional_text(input, &["tagColor", "tag_color"]);
            set_space_tag_color(pool, &space_id, tag_color.as_deref()).await?;
            Ok((
                serde_json::json!({ "threadId": space_id, "tagColor": tag_color }),
                Some(space_id),
            ))
        }
        "member.list" => {
            let workspace_id = input_required_uuid(input, &["workspaceId", "workspace_id"])?;
            let members = list_members(pool, workspace_id).await?;
            Ok((serde_json::json!({ "members": members }), None))
        }
        _ => Err(CollaborationError::new(
            "invalid_input",
            format!("unknown sidebar op: {op}"),
        )),
    }
}
