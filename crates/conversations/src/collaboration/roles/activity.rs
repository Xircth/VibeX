use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};
use sqlx::{QueryBuilder, Sqlite, SqlitePool};
use uuid::Uuid;

use super::*;
use crate::collaboration::is_bot_space;

/// Live roster status for `list_spaces`. Identity-wide: a Bot working in one
/// Space still shows as busy when listed in another.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RosterActivity {
    pub state: RosterActivityState,
    pub at: Option<String>,
    pub waiting_for: Vec<String>,
    pub queued: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum RosterActivityState {
    Idle = 0,
    WaitingForBot = 1,
    Working = 2,
    WaitingForPerson = 3,
}

impl Default for RosterActivity {
    fn default() -> Self {
        Self {
            state: RosterActivityState::Idle,
            at: None,
            waiting_for: Vec::new(),
            queued: 0,
        }
    }
}

impl RosterActivityState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::WaitingForBot => "waiting_for_bot",
            Self::Working => "working",
            Self::WaitingForPerson => "waiting_for_person",
        }
    }
}

impl RosterActivity {
    fn to_json(&self) -> Value {
        json!({
            "state": self.state.as_str(),
            "at": self.at,
            "waiting_for": self.waiting_for,
            "queued": self.queued,
        })
    }

    fn merge(&mut self, other: Self) {
        self.queued = self.queued.saturating_add(other.queued);
        if other.state > self.state {
            self.state = other.state;
            self.at = other.at;
            if !other.waiting_for.is_empty() {
                self.waiting_for = other.waiting_for;
            }
            return;
        }
        if other.state != self.state {
            for name in other.waiting_for {
                if !self.waiting_for.iter().any(|existing| existing == &name) {
                    self.waiting_for.push(name);
                }
            }
            return;
        }
        if other.state == RosterActivityState::WaitingForBot {
            for name in other.waiting_for {
                if !self.waiting_for.iter().any(|existing| existing == &name) {
                    self.waiting_for.push(name);
                }
            }
            if self.at.is_none() {
                self.at = other.at;
            }
            return;
        }
        if other.state == RosterActivityState::Working && prefers_space_label(&other.at, &self.at) {
            self.at = other.at;
        }
    }

    fn raise(&mut self, state: RosterActivityState, at: Option<String>, waiting_for: Vec<String>) {
        self.merge(Self {
            state,
            at,
            waiting_for,
            queued: 0,
        });
    }
}

pub(crate) async fn attach_member_activities(
    pool: &SqlitePool,
    members: &mut Value,
) -> Result<(), CollaborationError> {
    let Some(rows) = members.as_array_mut() else {
        return Ok(());
    };
    let (by_conversation, by_identity) = load_roster_activities(pool, rows).await?;
    apply_activities(rows, &by_conversation, &by_identity);
    attach_member_session_configs_to_rows(pool, rows).await?;
    Ok(())
}

pub(crate) async fn attach_space_member_activities(
    pool: &SqlitePool,
    spaces: &mut [Value],
) -> Result<(), CollaborationError> {
    let mut rows = Vec::new();
    for space in spaces.iter() {
        if let Some(members) = space.get("members").and_then(Value::as_array) {
            rows.extend(members.iter().cloned());
        }
    }
    let (by_conversation, by_identity) = load_roster_activities(pool, &rows).await?;
    for space in spaces {
        if let Some(members) = space.get_mut("members").and_then(Value::as_array_mut) {
            apply_activities(members, &by_conversation, &by_identity);
            attach_member_session_configs_to_rows(pool, members).await?;
        }
    }
    Ok(())
}

async fn load_roster_activities(
    pool: &SqlitePool,
    rows: &[Value],
) -> Result<
    (
        HashMap<Uuid, RosterActivity>,
        HashMap<String, RosterActivity>,
    ),
    CollaborationError,
> {
    let mut conversation_ids = Vec::new();
    let mut identity_ids = Vec::new();
    for row in rows {
        if let Some(id) = json_uuid(row.get("conversation_id")) {
            conversation_ids.push(id);
        }
        if let Some(identity) = json_nonempty(row.get("identity_member_id")) {
            identity_ids.push(identity.to_string());
        }
    }
    conversation_ids.sort_unstable();
    conversation_ids.dedup();
    identity_ids.sort();
    identity_ids.dedup();
    let by_conversation = load_conversation_activities(pool, &conversation_ids).await?;
    let by_identity = load_identity_activities(pool, &identity_ids, &by_conversation).await?;
    Ok((by_conversation, by_identity))
}

fn apply_activities(
    rows: &mut [Value],
    by_conversation: &HashMap<Uuid, RosterActivity>,
    by_identity: &HashMap<String, RosterActivity>,
) {
    for row in rows {
        let Some(object) = row.as_object_mut() else {
            continue;
        };
        let activity = json_nonempty(object.get("identity_member_id"))
            .and_then(|identity| by_identity.get(identity).cloned())
            .or_else(|| {
                json_uuid(object.get("conversation_id"))
                    .and_then(|id| by_conversation.get(&id).cloned())
            })
            .unwrap_or_default();
        object.insert("activity".into(), activity.to_json());
    }
}

fn json_uuid(value: Option<&Value>) -> Option<Uuid> {
    value
        .and_then(Value::as_str)
        .and_then(|raw| Uuid::parse_str(raw.trim()).ok())
}

fn json_nonempty(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|raw| !raw.is_empty())
}

fn space_label(space_id: &str, name: Option<&str>) -> String {
    if is_bot_space(space_id) {
        "BotSpace".to_string()
    } else {
        name.map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(space_id)
            .to_string()
    }
}

fn prefers_space_label(candidate: &Option<String>, current: &Option<String>) -> bool {
    match (candidate.as_deref(), current.as_deref()) {
        (None, _) | (Some(""), _) => false,
        (Some(next), Some("BotSpace")) if next != "BotSpace" => true,
        (Some(_), None | Some("")) => true,
        _ => false,
    }
}

fn bind_text_ids<'a>(builder: &mut QueryBuilder<'a, Sqlite>, ids: &'a [String]) {
    let mut separated = builder.separated(", ");
    for id in ids {
        separated.push_bind(id);
    }
}

fn bind_uuids<'a>(builder: &mut QueryBuilder<'a, Sqlite>, ids: &'a [Uuid]) {
    let mut separated = builder.separated(", ");
    for id in ids {
        separated.push_bind(*id);
    }
}

async fn load_conversation_activities(
    pool: &SqlitePool,
    conversation_ids: &[Uuid],
) -> Result<HashMap<Uuid, RosterActivity>, CollaborationError> {
    let mut map: HashMap<Uuid, RosterActivity> = HashMap::new();
    if conversation_ids.is_empty() {
        return Ok(map);
    }
    let ids: Vec<String> = conversation_ids.iter().map(ToString::to_string).collect();
    for id in conversation_ids {
        map.entry(*id).or_default();
    }

    load_queued(pool, &ids, &mut map).await?;
    load_waiting_for_bots(pool, &ids, &mut map).await?;
    load_working(pool, conversation_ids, &mut map).await?;
    load_waiting_for_person(pool, &ids, &mut map).await?;
    Ok(map)
}

async fn load_identity_activities(
    pool: &SqlitePool,
    identity_ids: &[String],
    known: &HashMap<Uuid, RosterActivity>,
) -> Result<HashMap<String, RosterActivity>, CollaborationError> {
    let mut by_identity: HashMap<String, RosterActivity> = HashMap::new();
    if identity_ids.is_empty() {
        return Ok(by_identity);
    }
    let mut builder = QueryBuilder::<Sqlite>::new(
        "SELECT member_id, conversation_id FROM collaboration_thread_members WHERE status = 'active' AND member_id IN (",
    );
    bind_text_ids(&mut builder, identity_ids);
    builder.push(")");
    let rows: Vec<(String, String)> = builder.build_query_as().fetch_all(pool).await.map_err(db)?;

    let mut extra_ids = Vec::new();
    let mut seats: Vec<(String, Uuid)> = Vec::new();
    let mut seen = HashSet::new();
    for (identity, conversation) in &rows {
        let Ok(conversation_id) = Uuid::parse_str(conversation.trim()) else {
            continue;
        };
        seats.push((identity.clone(), conversation_id));
        if !known.contains_key(&conversation_id) && seen.insert(conversation_id) {
            extra_ids.push(conversation_id);
        }
    }
    let extra = load_conversation_activities(pool, &extra_ids).await?;
    for (identity, conversation_id) in seats {
        let activity = known
            .get(&conversation_id)
            .cloned()
            .or_else(|| extra.get(&conversation_id).cloned())
            .unwrap_or_default();
        by_identity.entry(identity).or_default().merge(activity);
    }
    Ok(by_identity)
}

async fn load_queued(
    pool: &SqlitePool,
    ids: &[String],
    map: &mut HashMap<Uuid, RosterActivity>,
) -> Result<(), CollaborationError> {
    let mut builder = QueryBuilder::<Sqlite>::new(
        "SELECT conversation_id, COUNT(*) FROM collaboration_space_deliveries WHERE receipt_state IN ('queued', 'processing') AND conversation_id IN (",
    );
    bind_text_ids(&mut builder, ids);
    builder.push(") GROUP BY conversation_id");
    let rows: Vec<(String, i64)> = builder.build_query_as().fetch_all(pool).await.map_err(db)?;
    for (conversation, queued) in rows {
        if let Ok(id) = Uuid::parse_str(conversation.trim()) {
            map.entry(id).or_default().queued = queued;
        }
    }
    Ok(())
}

async fn load_waiting_for_bots(
    pool: &SqlitePool,
    ids: &[String],
    map: &mut HashMap<Uuid, RosterActivity>,
) -> Result<(), CollaborationError> {
    let mut builder = QueryBuilder::<Sqlite>::new(
        r#"SELECT json_extract(m.envelope_json, '$.conversation_id'),
                  m.space_id,
                  COALESCE(NULLIF(TRIM(sp.name), ''), NULLIF(TRIM(t.title), ''), m.space_id),
                  COALESCE(NULLIF(TRIM(sm.nickname), ''), NULLIF(TRIM(cm.name), ''), d.conversation_id)
           FROM collaboration_space_messages m
           JOIN collaboration_space_deliveries d ON d.space_message_id = m.id
           LEFT JOIN collaboration_spaces sp ON sp.id = m.space_id
           LEFT JOIN collaboration_threads t ON t.id = m.space_id
           LEFT JOIN collaboration_space_members sm
             ON sm.space_id = m.space_id AND sm.conversation_id = d.conversation_id
           LEFT JOIN collaboration_thread_members tm
             ON tm.thread_id = m.space_id AND tm.conversation_id = d.conversation_id
           LEFT JOIN collaboration_members cm ON cm.id = tm.member_id
           WHERE d.receipt_state IN ('queued', 'processing')
             AND json_extract(m.envelope_json, '$.conversation_id') IN ("#,
    );
    bind_text_ids(&mut builder, ids);
    builder.push(") AND d.conversation_id != json_extract(m.envelope_json, '$.conversation_id')");
    let rows: Vec<(Option<String>, String, Option<String>, String)> =
        builder.build_query_as().fetch_all(pool).await.map_err(db)?;
    for (sender, space_id, space_name, waiting_for) in rows {
        let Some(sender_id) = sender.and_then(|raw| Uuid::parse_str(raw.trim()).ok()) else {
            continue;
        };
        let name = waiting_for.trim();
        if name.is_empty() {
            continue;
        }
        map.entry(sender_id).or_default().raise(
            RosterActivityState::WaitingForBot,
            Some(space_label(&space_id, space_name.as_deref())),
            vec![name.to_string()],
        );
    }
    Ok(())
}

async fn load_working(
    pool: &SqlitePool,
    ids: &[Uuid],
    map: &mut HashMap<Uuid, RosterActivity>,
) -> Result<(), CollaborationError> {
    let collab_ids: Vec<String> = ids.iter().map(ToString::to_string).collect();
    let mut collab_builder = QueryBuilder::<Sqlite>::new(
        r#"SELECT t.conversation_id, t.space_id, COALESCE(NULLIF(TRIM(sp.name), ''), t.space_id)
           FROM collaboration_turns t
           LEFT JOIN collaboration_spaces sp ON sp.id = t.space_id
           WHERE t.state IN ('pending', 'running') AND t.conversation_id IN ("#,
    );
    bind_text_ids(&mut collab_builder, &collab_ids);
    collab_builder.push(")");
    let collab_rows: Vec<(String, String, Option<String>)> = collab_builder
        .build_query_as()
        .fetch_all(pool)
        .await
        .map_err(db)?;
    for (conversation, space_id, space_name) in collab_rows {
        if let Ok(id) = Uuid::parse_str(conversation.trim()) {
            map.entry(id).or_default().raise(
                RosterActivityState::Working,
                Some(space_label(&space_id, space_name.as_deref())),
                Vec::new(),
            );
        }
    }

    let mut session_builder = QueryBuilder::<Sqlite>::new(
        "SELECT id FROM sessions WHERE active_turn_id IS NOT NULL AND id IN (",
    );
    bind_uuids(&mut session_builder, ids);
    session_builder.push(")");
    let session_ids: Vec<Uuid> = session_builder
        .build_query_scalar()
        .fetch_all(pool)
        .await
        .map_err(db)?;
    let mut turn_builder = QueryBuilder::<Sqlite>::new(
        "SELECT conversation_id FROM conversation_turns WHERE status IN ('pending', 'queued', 'running', 'blocked') AND conversation_id IN (",
    );
    bind_uuids(&mut turn_builder, ids);
    turn_builder.push(")");
    let turn_ids: Vec<Uuid> = turn_builder
        .build_query_scalar()
        .fetch_all(pool)
        .await
        .map_err(db)?;
    for id in session_ids.into_iter().chain(turn_ids) {
        map.entry(id).or_default().raise(
            RosterActivityState::Working,
            Some("BotSpace".to_string()),
            Vec::new(),
        );
    }
    Ok(())
}

async fn load_waiting_for_person(
    pool: &SqlitePool,
    ids: &[String],
    map: &mut HashMap<Uuid, RosterActivity>,
) -> Result<(), CollaborationError> {
    let mut builder = QueryBuilder::<Sqlite>::new(
        r#"SELECT c.from_conversation_id, c.space_id, COALESCE(NULLIF(TRIM(sp.name), ''), c.space_id)
           FROM collaboration_cards c
           LEFT JOIN collaboration_spaces sp ON sp.id = c.space_id
           WHERE c.status = 'pending' AND c.from_conversation_id IN ("#,
    );
    bind_text_ids(&mut builder, ids);
    builder.push(")");
    let rows: Vec<(String, String, Option<String>)> =
        builder.build_query_as().fetch_all(pool).await.map_err(db)?;
    for (conversation, space_id, space_name) in rows {
        if let Ok(id) = Uuid::parse_str(conversation.trim()) {
            map.entry(id).or_default().raise(
                RosterActivityState::WaitingForPerson,
                Some(space_label(&space_id, space_name.as_deref())),
                vec!["Person".to_string()],
            );
        }
    }
    Ok(())
}
