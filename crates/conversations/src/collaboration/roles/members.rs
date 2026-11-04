use db::models::collaboration_identity::{self as identity};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

use super::*;

#[path = "activity.rs"]
mod activity;
#[path = "host_ops.rs"]
mod host_ops;
#[path = "lifecycle.rs"]
mod lifecycle;
#[path = "roster.rs"]
mod roster;
#[path = "session_config.rs"]
mod session_config;

use activity::{attach_member_activities, attach_space_member_activities};
pub use host_ops::*;
pub use lifecycle::*;
pub use roster::*;
pub use session_config::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, FromRow)]
pub struct MemberRecord {
    pub member_id: String,
    pub conversation_id: Option<String>,
    pub nickname: String,
    pub kind: String,
    pub visible_to_agents: i64,
}

pub async fn list_space_members(
    pool: &SqlitePool,
    space_id: &str,
    audience: MessageAudience,
) -> Result<Vec<MemberRecord>, CollaborationError> {
    load_space_or_unassigned(pool, space_id).await?;
    let mut members = sqlx::query_as::<_, MemberRecord>(
        r#"SELECT member_id, conversation_id, nickname, kind, visible_to_agents
           FROM collaboration_space_members WHERE space_id = ? ORDER BY nickname"#,
    )
    .bind(space_id)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    if audience == MessageAudience::Agent {
        members.retain(|member| member.visible_to_agents != 0 && member.kind == "agent");
    }
    Ok(members)
}

pub async fn ensure_user_member(
    pool: &SqlitePool,
    space_id: &str,
) -> Result<MemberRecord, CollaborationError> {
    if space_id.starts_with(identity::DIRECT_PREFIX) {
        load_space_or_unassigned(pool, space_id).await?;
        if let Some(existing) = sqlx::query_as::<_, MemberRecord>(
            r#"SELECT member_id, conversation_id, nickname, kind, visible_to_agents
               FROM collaboration_space_members WHERE space_id = ? AND kind = 'user' LIMIT 1"#,
        )
        .bind(space_id)
        .fetch_optional(pool)
        .await
        .map_err(db)?
        {
            return Ok(existing);
        }
        return Ok(MemberRecord {
            member_id: "user".to_string(),
            conversation_id: None,
            nickname: "你".to_string(),
            kind: "user".to_string(),
            visible_to_agents: 0,
        });
    }
    load_space(pool, space_id).await?;
    if let Some(existing) = sqlx::query_as::<_, MemberRecord>(
        r#"SELECT member_id, conversation_id, nickname, kind, visible_to_agents
           FROM collaboration_space_members WHERE space_id = ? AND kind = 'user' LIMIT 1"#,
    )
    .bind(space_id)
    .fetch_optional(pool)
    .await
    .map_err(db)?
    {
        return Ok(existing);
    }
    insert_member(pool, space_id, None, "你", "user", false).await
}

pub(crate) async fn batch_load_space_members_by_space(
    pool: &SqlitePool,
    space_ids: &[String],
    audience: MessageAudience,
) -> Result<std::collections::HashMap<String, Vec<MemberRecord>>, CollaborationError> {
    let mut grouped: std::collections::HashMap<String, Vec<MemberRecord>> =
        std::collections::HashMap::new();
    if space_ids.is_empty() {
        return Ok(grouped);
    }
    let mut builder = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
        r#"SELECT member_id, space_id, kind, nickname, conversation_id, visible_to_agents
           FROM collaboration_space_members
           WHERE space_id IN ("#,
    );
    let mut separated = builder.separated(", ");
    for sid in space_ids {
        separated.push_bind(sid);
    }
    separated.push_unseparated(")");
    if audience == MessageAudience::Agent {
        builder.push(" AND visible_to_agents != 0 AND kind = 'agent'");
    }
    builder.push(" ORDER BY space_id, nickname");
    let rows = builder
        .build_query_as::<(String, String, String, String, Option<String>, i64)>()
        .fetch_all(pool)
        .await
        .map_err(db)?;
    for (member_id, space_id, kind, nickname, conversation_id, visible_to_agents) in rows {
        grouped.entry(space_id).or_default().push(MemberRecord {
            member_id,
            kind,
            nickname,
            conversation_id,
            visible_to_agents,
        });
    }
    Ok(grouped)
}

pub async fn member_space_context_text(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Option<String>, CollaborationError> {
    member_space_context_text_for(pool, conversation_id, None).await
}

/// Number of recent activity entries injected at turn start
/// (`VIBEX_MEMBER_ACTIVITY_LIMIT`, default 8, 0 disables).
pub fn member_activity_limit() -> usize {
    env_i64(
        "VIBEX_MEMBER_ACTIVITY_LIMIT",
        crate::member_memory::DEFAULT_ACTIVITY_LIMIT as i64,
    )
    .max(0) as usize
}

/// Member identity block plus the member's memory (recent cross-thread
/// activity and the facts most relevant to `query`, privacy-filtered).
pub async fn member_space_context_text_for(
    pool: &SqlitePool,
    conversation_id: Uuid,
    query: Option<&str>,
) -> Result<Option<String>, CollaborationError> {
    let identity_block = member_identity_context_text(pool, conversation_id).await?;
    let limit = member_activity_limit();
    let memory = if limit == 0 {
        None
    } else {
        crate::member_memory::memory_context_text(pool, conversation_id, query, limit).await?
    };
    Ok(match (identity_block, memory) {
        (Some(block), Some(memory)) => Some(format!("{block}\n\n{memory}")),
        (Some(block), None) => Some(block),
        (None, Some(memory)) => Some(format!("[协作空间成员身份]\n{memory}")),
        (None, None) => None,
    })
}

pub(crate) async fn member_identity_context_text(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Option<String>, CollaborationError> {
    let active_binding = identity::binding_of_conversation(pool, conversation_id)
        .await
        .map_err(db)?;

    let memberships = sqlx::query_as::<_, (String, String)>(
        r#"SELECT space_id, nickname
           FROM collaboration_space_members
           WHERE conversation_id = ? AND kind = 'agent'
           ORDER BY space_id"#,
    )
    .bind(conversation_id.to_string())
    .fetch_all(pool)
    .await
    .map_err(db)?;

    let mut direct_thread_and_nickname: Option<(String, String)> = None;
    let mut group_memberships: Vec<(String, String)> = Vec::new();

    if let Some(binding) = active_binding {
        if binding.thread_id.starts_with(identity::DIRECT_PREFIX)
            || parse_unassigned_space_id(&binding.thread_id).is_some()
        {
            let member_name = sqlx::query_scalar::<_, String>(
                "SELECT name FROM collaboration_members WHERE id = ? LIMIT 1",
            )
            .bind(&binding.member_id)
            .fetch_optional(pool)
            .await
            .map_err(db)?
            .or_else(|| memberships.first().map(|(_, nick)| nick.clone()))
            .unwrap_or_else(|| binding.member_id.clone());
            direct_thread_and_nickname = Some((binding.thread_id, member_name));
        } else {
            let nickname = sqlx::query_scalar::<_, String>(
                r#"SELECT nickname FROM collaboration_space_members
                   WHERE space_id = ? AND conversation_id = ? AND kind = 'agent'
                   LIMIT 1"#,
            )
            .bind(&binding.thread_id)
            .bind(conversation_id.to_string())
            .fetch_optional(pool)
            .await
            .map_err(db)?
            .or_else(|| {
                memberships
                    .iter()
                    .find(|(sid, _)| sid == &binding.thread_id)
                    .map(|(_, nick)| nick.clone())
            });
            let nickname = match nickname {
                Some(n) => n,
                None => sqlx::query_scalar::<_, String>(
                    "SELECT name FROM collaboration_members WHERE id = ? LIMIT 1",
                )
                .bind(&binding.member_id)
                .fetch_optional(pool)
                .await
                .map_err(db)?
                .unwrap_or_else(|| binding.member_id.clone()),
            };
            group_memberships.push((binding.thread_id, nickname));
        }
    } else {
        group_memberships = memberships
            .iter()
            .filter(|(sid, _)| {
                parse_unassigned_space_id(sid).is_none()
                    && !sid.starts_with(identity::DIRECT_PREFIX)
            })
            .cloned()
            .collect();
        if group_memberships.is_empty() {
            direct_thread_and_nickname = memberships
                .iter()
                .find(|(sid, _)| {
                    parse_unassigned_space_id(sid).is_some()
                        || sid.starts_with(identity::DIRECT_PREFIX)
                })
                .cloned();
        }
    }

    let is_supervisor = is_caller_workspace_supervisor(pool, conversation_id).await?;
    let supervisor_line = if is_supervisor {
        "- 协作权限身份：你是当前工作区的 **主管（总管）**。你可以调用 `manage_bot(list_agents/create/update/delete/interrupt)` 查询可用 Agent/模式/模型/思考等级列表并管理全区 Bot（含配置或切换 `agent_id`、`mode_id`、`model`、`thinking_level` / `effort` 与 `persona_prompt`），调用 `manage_group(create/rename/delete/add_bot/remove_bot/set_lead)` 组建和治理群组，并通过 `post_space_message` 跨会话协同（删除 Bot 或解散群组前必须先 `request_approval`）。"
    } else {
        "- 协作权限身份：普通成员（创建/删除 Bot、修改其他 Bot 或变更模型/思考等级/人设配置、创建/解散群组等高危或全局管理操作仅限主管调用；需要时先调 `list_spaces` 查看 `supervisor_nickname` 并联系主管或 Person）。"
    };

    if group_memberships.is_empty() {
        let Some((thread_label, my_nickname)) = direct_thread_and_nickname else {
            return Ok(None);
        };

        let persona_meta = sqlx::query_as::<_, (Option<String>, String)>(
            "SELECT team_name, summary FROM conversation_personas WHERE conversation_id = ?",
        )
        .bind(conversation_id.to_string())
        .fetch_optional(pool)
        .await
        .map_err(db)?;

        let role_desc = match persona_meta {
            Some((team_opt, summary)) => {
                let team = team_opt.as_deref().map(str::trim).filter(|s| !s.is_empty());
                let sum = summary.trim();
                match (team, !sum.is_empty()) {
                    (Some(t), true) => format!("所属团队：{t}；职责简介：{sum}"),
                    (Some(t), false) => format!("所属团队：{t}"),
                    (None, true) => sum.to_string(),
                    (None, false) => "一对一私聊助手".to_string(),
                }
            }
            None => "一对一私聊助手".to_string(),
        };

        return Ok(Some(format!(
            "[协作空间私聊身份]\n\
             - 你的昵称：{my_nickname} (conversation_id: {conversation_id}, thread_id: {thread_label})\n\
             - 角色说明：{role_desc}\n\
             {supervisor_line}\n\
             - 会话模式说明：当前处于一对一私聊（space_id: \"{thread_label}\"）。最终普通文本会自动发给 Person；不要为本条主回复调用 `post_space_message`。向 Person 提问用 `ask_user_question`（阻塞，问题出现在这条私聊里）。私聊历史已在当前会话中，不必调用 `read_space_messages`。共享文件用文件工具读写 `~/.vibex/spaces/{thread_label}/collection/`。可使用 `memory_search` / `memory_write` 检索或记录跨会话记忆。"
        )));
    }

    let space_ids: Vec<String> = group_memberships
        .iter()
        .map(|(sid, _)| sid.clone())
        .collect();
    let mut space_names: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    {
        let mut builder = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
            "SELECT id, name FROM collaboration_spaces WHERE id IN (",
        );
        let mut separated = builder.separated(", ");
        for sid in &space_ids {
            separated.push_bind(sid);
        }
        separated.push_unseparated(")");
        let rows = builder
            .build_query_as::<(String, String)>()
            .fetch_all(pool)
            .await
            .map_err(db)?;
        for (id, name) in rows {
            space_names.insert(id, name);
        }
    }
    let mut sections = Vec::new();
    for (space_id, my_nickname) in group_memberships {
        let space_name = space_names.remove(&space_id).unwrap_or_else(|| {
            if parse_unassigned_space_id(&space_id).is_some() {
                "未定空间".to_string()
            } else {
                space_id.clone()
            }
        });
        sections.push(format!(
            "- 所属协作空间：{space_name} (space_id: {space_id})\n  你的成员昵称：{my_nickname} (conversation_id: {conversation_id})\n  需要成员名单时调用 `list_spaces`（`space_id`）；需要更早历史时调用 `read_space_messages`（`space_id`、`since_seq`、`limit`）"
        ));
    }

    let rules = format_collaboration_space_rules(None);
    Ok(Some(format!(
        "[协作空间成员身份]\n\
         {}\n\
         {supervisor_line}\n\
         - 多智能体协同 MCP 工具：{COLLABORATION_MCP_TOOLS_SUMMARY}\n\
         {rules}",
        sections.join("\n")
    )))
}

pub async fn list_collaboration_spaces_for_caller(
    pool: &SqlitePool,
    caller_id: Uuid,
) -> Result<Value, CollaborationError> {
    let caller = live_session(load_session(pool, caller_id).await?)?;
    let supervisor =
        crate::collaboration_sidebar::workspace_supervisor_member(pool, caller.workspace_id)
            .await?;
    let is_caller_supervisor = is_caller_workspace_supervisor(pool, caller_id).await?;
    let spaces = list_workspace_spaces(pool, caller.workspace_id).await?;
    let space_ids: Vec<String> = spaces.iter().map(|s| s.space_id.clone()).collect();
    let mut members_by_space =
        batch_load_space_members_by_space(pool, &space_ids, MessageAudience::Agent).await?;
    let caller_str = caller_id.to_string();
    let mut items = Vec::with_capacity(spaces.len());
    for space in spaces {
        let members = members_by_space.remove(&space.space_id).unwrap_or_default();
        let my_member = members
            .iter()
            .find(|m| m.conversation_id.as_deref() == Some(caller_str.as_str()));
        let lead_id = space.lead_member_id.clone();
        let lead_nickname = members
            .iter()
            .find(|m| Some(m.member_id.as_str()) == lead_id.as_deref())
            .map(|m| m.nickname.clone());
        let mut member_views = Vec::with_capacity(members.len());
        for m in &members {
            let identity_id =
                identity_member_id_for_conversation(pool, m.conversation_id.as_deref()).await?;
            let is_sup = match (&supervisor, identity_id.as_deref()) {
                (Some((sup_id, _)), Some(id)) => sup_id == id,
                _ => false,
            };
            member_views.push(json!({
                "member_id": m.member_id,
                "identity_member_id": identity_id,
                "nickname": m.nickname,
                "conversation_id": m.conversation_id,
                "kind": m.kind,
                "is_self": m.conversation_id.as_deref() == Some(caller_str.as_str()),
                "is_lead": lead_id.as_deref() == Some(m.member_id.as_str()),
                "lead_bot": lead_id.as_deref() == Some(m.member_id.as_str()),
                "is_supervisor": is_sup,
                "supervisor_bot": is_sup,
            }));
        }
        items.push(json!({
            "space_id": space.space_id,
            "name": space.name,
            "workspace_id": space.workspace_id,
            "is_member": my_member.is_some(),
            "my_nickname": my_member.map(|m| m.nickname.clone()),
            "lead_member_id": lead_id,
            "lead_nickname": lead_nickname,
            "member_count": member_views.len(),
            "members": member_views,
            "user_recipient": "User",
        }));
    }
    let mut overview = json!({
        "caller_conversation_id": caller_id,
        "workspace_id": caller.workspace_id,
        "is_caller_supervisor": is_caller_supervisor,
        "supervisor_member_id": supervisor.as_ref().map(|(id, _)| id),
        "supervisor_nickname": supervisor.as_ref().map(|(_, name)| name),
        "spaces": items,
    });
    if let Some(spaces) = overview.get_mut("spaces").and_then(Value::as_array_mut) {
        attach_space_member_activities(pool, spaces).await?;
    }
    Ok(overview)
}

pub async fn list_space_members_detailed(
    pool: &SqlitePool,
    caller_id: Uuid,
    space_id: &str,
) -> Result<Value, CollaborationError> {
    let space_row = load_space_or_unassigned(pool, space_id).await?;
    let space_name = sqlx::query_scalar::<_, String>(
        "SELECT name FROM collaboration_spaces WHERE id = ? LIMIT 1",
    )
    .bind(space_id)
    .fetch_optional(pool)
    .await
    .map_err(db)?
    .unwrap_or_else(|| {
        if parse_unassigned_space_id(space_id).is_some() {
            "未定空间".to_string()
        } else {
            space_id.to_string()
        }
    });
    let lead_member_id: Option<String> = sqlx::query_scalar::<_, Option<String>>(
        "SELECT lead_member_id FROM collaboration_spaces WHERE id = ?",
    )
    .bind(space_id)
    .fetch_optional(pool)
    .await
    .map_err(db)?
    .flatten()
    .filter(|id| !id.trim().is_empty());
    let members = list_space_members(pool, space_id, MessageAudience::Agent).await?;
    let workspace_uuid = Uuid::parse_str(&space_row.workspace_id).ok();
    let supervisor = match workspace_uuid {
        Some(wid) => crate::collaboration_sidebar::workspace_supervisor_member(pool, wid).await?,
        None => None,
    };
    let is_caller_supervisor = is_caller_workspace_supervisor(pool, caller_id).await?;
    let conversations = match workspace_uuid {
        Some(wid) => list_workspace_conversations(pool, wid)
            .await
            .unwrap_or_default(),
        None => Vec::new(),
    };
    let conv_ids: Vec<String> = members
        .iter()
        .filter_map(|m| m.conversation_id.as_deref())
        .filter_map(|cid| Uuid::parse_str(cid).ok())
        .map(|cid| cid.to_string())
        .collect();
    let mut personas_by_conv: std::collections::HashMap<String, ConversationPersonaView> =
        std::collections::HashMap::new();
    if !conv_ids.is_empty() {
        for chunk in conv_ids.chunks(500) {
            let mut builder = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
                r#"SELECT conversation_id, name, team_name, summary, agent_id
                   FROM conversation_personas
                   WHERE conversation_id IN ("#,
            );
            let mut separated = builder.separated(", ");
            for cid in chunk {
                separated.push_bind(cid);
            }
            separated.push_unseparated(")");
            let rows = builder
                .build_query_as::<(String, String, Option<String>, String, String)>()
                .fetch_all(pool)
                .await
                .map_err(db)?;
            for (cid, name, team_name, summary, agent_id) in rows {
                personas_by_conv.insert(
                    cid,
                    ConversationPersonaView {
                        name,
                        team_name: team_name.filter(|value| !value.trim().is_empty()),
                        summary: (!summary.trim().is_empty()).then_some(summary),
                        agent_name: agent_id,
                    },
                );
            }
        }
    }
    let conversations_by_id: std::collections::HashMap<Uuid, &WorkspaceConversationOption> =
        conversations
            .iter()
            .map(|c| (c.conversation_id, c))
            .collect();
    let caller_str = caller_id.to_string();
    let mut my_nickname = None;
    let mut detailed = Vec::with_capacity(members.len());
    for member in members {
        if member.conversation_id.as_deref() == Some(caller_str.as_str()) {
            my_nickname = Some(member.nickname.clone());
        }
        let parsed_cid = member
            .conversation_id
            .as_deref()
            .and_then(|cid| Uuid::parse_str(cid).ok());
        let conv_opt = parsed_cid.and_then(|cid| conversations_by_id.get(&cid).copied());
        let persona = parsed_cid.and_then(|cid| personas_by_conv.get(&cid.to_string()));
        let identity_id =
            identity_member_id_for_conversation(pool, member.conversation_id.as_deref()).await?;
        let is_sup = match (&supervisor, identity_id.as_deref()) {
            (Some((sup_id, _)), Some(id)) => sup_id == id,
            _ => false,
        };
        detailed.push(json!({
            "member_id": member.member_id,
            "identity_member_id": identity_id,
            "conversation_id": member.conversation_id,
            "nickname": member.nickname,
            "kind": member.kind,
            "visible_to_agents": member.visible_to_agents,
            "is_self": member.conversation_id.as_deref() == Some(caller_str.as_str()),
            "is_lead": lead_member_id.as_deref() == Some(member.member_id.as_str()),
            "lead_bot": lead_member_id.as_deref() == Some(member.member_id.as_str()),
            "is_supervisor": is_sup,
            "supervisor_bot": is_sup,
            "agent_id": conv_opt.and_then(|c| c.agent_id.clone()).or_else(|| persona.map(|p| p.agent_name.clone())),
            "status": conv_opt.map(|c| c.status.clone()),
            "turn_in_flight": conv_opt.map(|c| c.turn_in_flight).unwrap_or(false),
            "team_name": persona.and_then(|p| p.team_name.clone()),
            "summary": persona.and_then(|p| p.summary.clone()),
        }));
    }
    let lead_nickname = detailed
        .iter()
        .find(|row| row["member_id"].as_str() == lead_member_id.as_deref())
        .and_then(|row| row["nickname"].as_str())
        .map(str::to_string);
    let mut members_json = Value::Array(detailed);
    attach_member_activities(pool, &mut members_json).await?;
    Ok(json!({
        "space_id": space_id,
        "space_name": space_name,
        "my_conversation_id": caller_id,
        "my_nickname": my_nickname,
        "is_caller_supervisor": is_caller_supervisor,
        "supervisor_member_id": supervisor.as_ref().map(|(id, _)| id),
        "supervisor_nickname": supervisor.as_ref().map(|(_, name)| name),
        "lead_member_id": lead_member_id,
        "lead_nickname": lead_nickname,
        "members": members_json,
        "user_recipient": {
            "nickname": "User",
            "aliases": ["@User", "@Person", "@你", "@用户"],
            "usage": "当前 Space 对 Person 直接写正文。跨 Space 时在 post_space_message 的 to 中传入 \"User\" 或 \"Person\"。只有点名其他 Bot 时才以 @昵称 开头"
        }
    }))
}

fn annotate_lead_bot(members: &mut Value) {
    let Some(rows) = members.as_array_mut() else {
        return;
    };
    for member in rows {
        let is_lead = member
            .get("is_lead")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if let Some(object) = member.as_object_mut() {
            object.insert("lead_bot".into(), json!(is_lead));
        }
    }
}

/// Workspace overview of BotSpace + GroupSpace, or one space's details and roster.
pub async fn list_spaces_for_caller(
    pool: &SqlitePool,
    caller_id: Uuid,
    space_id: Option<&str>,
) -> Result<Value, CollaborationError> {
    let space_id = space_id.map(str::trim).filter(|id| !id.is_empty());
    if let Some(space_id) = space_id {
        if is_bot_space(space_id) {
            let caller = live_session(load_session(pool, caller_id).await?)?;
            let supervisor = crate::collaboration_sidebar::workspace_supervisor_member(
                pool,
                caller.workspace_id,
            )
            .await?;
            let is_caller_supervisor = is_caller_workspace_supervisor(pool, caller_id).await?;
            let peers = workspace_direct_peers(pool, caller.workspace_id).await?;
            if let Some(peer) = peers
                .into_iter()
                .find(|peer| peer.dest_thread_id.as_deref() == Some(space_id))
            {
                let is_self = peer.conversation_id == Some(caller_id);
                let identity_id = identity_member_id_for_conversation(
                    pool,
                    peer.conversation_id.map(|id| id.to_string()).as_deref(),
                )
                .await?;
                let is_sup = match (&supervisor, identity_id.as_deref()) {
                    (Some((sup_id, _)), Some(id)) => sup_id == id,
                    _ => false,
                };
                let mut members = json!([{
                    "conversation_id": peer.conversation_id.map(|id| id.to_string()),
                    "identity_member_id": identity_id,
                    "nickname": peer.nickname.clone(),
                    "is_self": is_self,
                    "is_lead": false,
                    "lead_bot": false,
                    "is_supervisor": is_sup,
                    "supervisor_bot": is_sup,
                }]);
                attach_member_activities(pool, &mut members).await?;
                return Ok(json!({
                    "space_id": space_id,
                    "space_name": peer.nickname,
                    "kind": "bot",
                    "workspace_id": caller.workspace_id,
                    "my_conversation_id": caller_id,
                    "my_nickname": is_self.then(|| peer.nickname.clone()),
                    "is_caller_supervisor": is_caller_supervisor,
                    "supervisor_member_id": supervisor.as_ref().map(|(id, _)| id),
                    "supervisor_nickname": supervisor.as_ref().map(|(_, name)| name),
                    "lead_member_id": Value::Null,
                    "lead_nickname": Value::Null,
                    "members": members,
                    "user_recipient": {
                        "nickname": "User",
                        "aliases": ["@User", "@Person", "@你", "@用户"],
                        "usage": "当前 Space 对 Person 直接写正文。跨 Space 时在 post_space_message 的 to 中传入 \"User\" 或 \"Person\"。只有点名其他 Bot 时才以 @昵称 开头"
                    }
                }));
            }
        }
        let mut detailed = list_space_members_detailed(pool, caller_id, space_id).await?;
        let kind = if is_bot_space(space_id) {
            "bot"
        } else {
            "group"
        };
        if let Some(object) = detailed.as_object_mut() {
            object.insert("kind".into(), json!(kind));
            if let Some(members) = object.get_mut("members") {
                annotate_lead_bot(members);
            }
        }
        return Ok(detailed);
    }

    let caller = live_session(load_session(pool, caller_id).await?)?;
    let supervisor =
        crate::collaboration_sidebar::workspace_supervisor_member(pool, caller.workspace_id)
            .await?;
    let mut overview = list_collaboration_spaces_for_caller(pool, caller_id).await?;
    if let Some(spaces) = overview.get_mut("spaces").and_then(Value::as_array_mut) {
        for space in spaces.iter_mut() {
            if let Some(object) = space.as_object_mut() {
                object.insert("kind".into(), json!("group"));
                if let Some(members) = object.get_mut("members") {
                    annotate_lead_bot(members);
                }
            }
        }
        let peers = workspace_direct_peers(pool, caller.workspace_id).await?;
        for peer in peers {
            let Some(thread_id) = peer.dest_thread_id.clone().filter(|id| !id.is_empty()) else {
                continue;
            };
            let is_self = peer.conversation_id == Some(caller_id);
            let identity_id = identity_member_id_for_conversation(
                pool,
                peer.conversation_id.map(|id| id.to_string()).as_deref(),
            )
            .await?;
            let is_sup = match (&supervisor, identity_id.as_deref()) {
                (Some((sup_id, _)), Some(id)) => sup_id == id,
                _ => false,
            };
            spaces.push(json!({
                "space_id": thread_id,
                "name": peer.nickname,
                "kind": "bot",
                "workspace_id": caller.workspace_id,
                "is_member": is_self,
                "my_nickname": is_self.then(|| peer.nickname.clone()),
                "is_supervisor": is_sup,
                "supervisor_bot": is_sup,
                "lead_member_id": Value::Null,
                "lead_nickname": Value::Null,
                "member_count": 1,
                "members": [{
                    "conversation_id": peer.conversation_id.map(|id| id.to_string()),
                    "identity_member_id": identity_id,
                    "nickname": peer.nickname,
                    "is_self": is_self,
                    "is_lead": false,
                    "lead_bot": false,
                    "is_supervisor": is_sup,
                    "supervisor_bot": is_sup,
                }],
                "user_recipient": "User",
            }));
        }
        attach_space_member_activities(pool, spaces).await?;
    }
    Ok(overview)
}

/// Resolve a bot reference (identity, seat, conversation, or nickname) to its
/// conversation id and current display name.
pub async fn resolve_bot_conversation(
    pool: &SqlitePool,
    caller_id: Uuid,
    space_id: &str,
    member_ref: &str,
) -> Result<(Uuid, String), CollaborationError> {
    let wanted = member_ref.trim();
    if wanted.is_empty() {
        return Err(CollaborationError::new(
            "invalid_argument",
            "bot_id is required",
        ));
    }
    if let Ok(conversation_id) = Uuid::parse_str(wanted)
        && live_session(load_session(pool, conversation_id).await?).is_ok()
    {
        let nickname = nickname_for_conversation(pool, conversation_id)
            .await?
            .unwrap_or_else(|| conversation_id.to_string());
        return Ok((conversation_id, nickname));
    }
    if !space_id.trim().is_empty()
        && let Ok(seat) = resolve_space_agent_seat(pool, space_id, wanted).await
        && let Some(conversation_id) = seat
            .conversation_id
            .as_deref()
            .and_then(|raw| Uuid::parse_str(raw).ok())
    {
        return Ok((conversation_id, seat.nickname));
    }
    if let Some(identity_id) = resolve_identity_member_id(pool, wanted).await? {
        let thread = identity::direct_thread_id(&identity_id);
        let conversation_id = resolve_session(pool, &identity_id, &thread).await?;
        let nickname = nickname_for_conversation(pool, conversation_id)
            .await?
            .unwrap_or(identity_id);
        return Ok((conversation_id, nickname));
    }
    let caller = live_session(load_session(pool, caller_id).await?)?;
    let peers = workspace_direct_peers(pool, caller.workspace_id).await?;
    if let Some(peer) = peers.into_iter().find(|peer| peer.nickname == wanted)
        && let Some(conversation_id) = peer.conversation_id
    {
        return Ok((conversation_id, peer.nickname));
    }
    Err(CollaborationError::new("not_found", "member was not found"))
}

async fn nickname_for_conversation(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Option<String>, CollaborationError> {
    let name: Option<String> = sqlx::query_scalar(
        r#"SELECT m.name
           FROM collaboration_members m
           JOIN collaboration_thread_members tm
             ON tm.member_id = m.id
           WHERE tm.conversation_id = ?
           LIMIT 1"#,
    )
    .bind(conversation_id.to_string())
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    Ok(name.filter(|value| !value.trim().is_empty()))
}

/// How several sessions of one member share a repository checkout.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemberWriteAccess {
    /// Default: every extra session gets its own worktree workspace.
    WriteIsolated,
    /// Sessions share the checkout and take turns (one writer at a time).
    WriteSerialized,
}

impl MemberWriteAccess {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::WriteIsolated => "write_isolated",
            Self::WriteSerialized => "write_serialized",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "write_isolated" | "isolated" => Some(Self::WriteIsolated),
            "write_serialized" | "serialized" => Some(Self::WriteSerialized),
            _ => None,
        }
    }
}

pub async fn set_member_write_access(
    pool: &SqlitePool,
    member_id: &str,
    access: MemberWriteAccess,
) -> Result<(), CollaborationError> {
    let updated = sqlx::query("UPDATE collaboration_members SET write_access = ? WHERE id = ?")
        .bind(access.as_str())
        .bind(member_id)
        .execute(pool)
        .await
        .map_err(db)?;
    if updated.rows_affected() == 0 {
        return Err(CollaborationError::new("not_found", "member was not found"));
    }
    Ok(())
}
