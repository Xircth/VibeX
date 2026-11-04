use serde_json::Value;
use sqlx::SqlitePool;
use uuid::Uuid;

use super::*;

/// Standing instruction the user already sees as the first host note.
/// Repeated on each agent prompt so a cold session still receives it.
pub fn prefix_persona_prompt(persona: &str, text: &str) -> String {
    let persona = persona.trim();
    if persona.is_empty() {
        return text.to_string();
    }
    let header = if persona.starts_with("[协作空间成员身份]")
        || persona.starts_with("[协作空间私聊身份]")
        || persona.starts_with("[协作空间开场]")
    {
        persona.to_string()
    } else {
        format!("人设\n{persona}")
    };
    let text = text.trim();
    if text.is_empty() {
        return header;
    }
    format!("{header}\n\n{text}")
}

/// One quoted space message shown in a slim delivery envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct QuotedSpaceMessage {
    pub seq: i64,
    pub sender: String,
    pub body: String,
}

/// One incoming space delivery: a single English header line plus the body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SlimSpaceEnvelope {
    pub sender: String,
    pub recipients: String,
    pub is_group: bool,
    pub space_name: Option<String>,
    pub quoted: Option<QuotedSpaceMessage>,
    pub speaking_order: Option<String>,
    pub working_peers: Option<String>,
    pub body: String,
}

pub(crate) fn format_slim_space_envelope(envelope: &SlimSpaceEnvelope) -> String {
    format!("{}\n{}", format_delivery_header(envelope), envelope.body)
}

fn format_delivery_header(envelope: &SlimSpaceEnvelope) -> String {
    let sender = envelope.sender.trim();
    let mut clauses = Vec::new();
    if envelope.is_group {
        match envelope
            .space_name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
        {
            Some(name) => clauses.push(format!("Group chat \"{name}\" · from {sender}")),
            None => clauses.push(format!("Group chat · from {sender}")),
        }
    } else {
        clauses.push(format!("Message from {sender}"));
    }
    let recipients = envelope.recipients.trim();
    if !recipients.is_empty() && !is_broadcast_recipients(recipients) {
        clauses.push(format!("to {recipients}"));
    }
    if let Some(quoted) = &envelope.quoted {
        let excerpt = truncate_chars(quoted.body.trim(), 200);
        clauses.push(format!(
            "quoting #{} {}: {excerpt}",
            quoted.seq, quoted.sender
        ));
    }
    if let Some(order) = envelope
        .speaking_order
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        clauses.push(format!("speaking order: {order}"));
    }
    if let Some(peers) = envelope
        .working_peers
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        clauses.push(format!("still at work: {peers}"));
    }
    format!("[{}]", clauses.join(" · "))
}

fn is_broadcast_recipients(recipients: &str) -> bool {
    matches!(
        recipients,
        "全体成员" | "everyone" | "@所有人" | "@全体成员" | "@everyone" | "@all"
    )
}

pub const PRIVATE_BOOTSTRAP_OPEN_TAG: &str = "<vibex-private-bootstrap>";
pub const PRIVATE_BOOTSTRAP_CLOSE_TAG: &str = "</vibex-private-bootstrap>";

pub fn strip_private_bootstrap_tags(text: &str) -> String {
    text.replace(PRIVATE_BOOTSTRAP_OPEN_TAG, "")
        .replace(PRIVATE_BOOTSTRAP_CLOSE_TAG, "")
        .trim()
        .to_string()
}

pub fn build_bot_bootstrap_prompt(creator_name: Option<&str>, is_master: bool) -> String {
    let creator = creator_name.map(str::trim).filter(|name| {
        !name.is_empty()
            && !matches!(
                *name,
                "你" | "用户" | "User" | "user" | "Person" | "person" | "You" | "you"
            )
    });
    let body = if is_master {
        "你刚被设为用户的总管 Bot。请用一两句简短的话向用户打个招呼：说明你会帮用户统筹管理 Bot 团队，有需要决策的事都可以找你；再用一个简短的问题询问最想先让团队帮什么忙。\n如果人设另有说明，以人设为准。".to_string()
    } else if let Some(creator) = creator {
        format!(
            "{creator} 刚为用户创建了你。请用一句简短的话向用户打个招呼，再用一个简短的问题询问从哪里开始，保持简短。\n如果人设另有说明，以人设为准。"
        )
    } else {
        "用户刚创建了你。请用一句简短的话向用户打个招呼，再用一个简短的问题询问接下来重点做什么。\n如果人设另有说明，以人设为准。".to_string()
    };
    format!("{PRIVATE_BOOTSTRAP_OPEN_TAG}\n{body}\n{PRIVATE_BOOTSTRAP_CLOSE_TAG}")
}

pub(crate) fn slim_space_envelope_from_parts(
    space_id: &str,
    space_name: Option<&str>,
    envelope: &Value,
    quoted: Option<QuotedSpaceMessage>,
    content: &str,
    display_text: &str,
) -> SlimSpaceEnvelope {
    let raw_body = if !display_text.trim().is_empty() {
        display_text.trim()
    } else {
        content.trim()
    };
    let body = strip_private_bootstrap_tags(raw_body);
    let is_group = is_group_space(space_id);
    SlimSpaceEnvelope {
        sender: sender_nickname(envelope),
        recipients: recipients_label(envelope),
        is_group,
        space_name: space_name
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .or_else(|| fallback_group_title(space_id, is_group)),
        quoted,
        speaking_order: None,
        working_peers: None,
        body,
    }
}

fn fallback_group_title(space_id: &str, is_group: bool) -> Option<String> {
    if !is_group {
        return None;
    }
    let id = space_id.trim();
    if id.is_empty() || Uuid::parse_str(id).is_ok() {
        None
    } else {
        Some(id.to_string())
    }
}

/// First delivery in a Space hidden session prepends persona and the compact
/// `[Space 身份与协作规则]` block. Later deliveries stay slim.
pub(crate) fn format_first_delivery_opening(
    persona: Option<&str>,
    nickname: Option<&str>,
    space_id: &str,
    collection_path: &str,
) -> String {
    let persona = persona.map(str::trim).filter(|text| !text.is_empty());
    let mut blocks = Vec::new();
    if let Some(persona) = persona {
        blocks.push(prefix_persona_prompt(persona, ""));
    }
    blocks.push(format_space_identity_rules(
        nickname,
        space_id,
        collection_path,
    ));
    blocks.join("\n\n")
}

pub(crate) fn format_space_identity_rules(
    nickname: Option<&str>,
    space_id: &str,
    collection_path: &str,
) -> String {
    let nick = nickname
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("Bot");
    let kind = if is_bot_space(space_id) {
        "BotSpace"
    } else {
        "GroupSpace"
    };
    format!(
        "[Space 身份与协作规则]\n\
         - 你是 Bot「{nick}」，当前空间是 {kind}（space_id: {space_id}）。Person 即用户（兼容显示 User）。\n\
         - 发言与静默：在当前 Space 发言无需调用工具，直接输出文本即可（不要以自己的名字或 `@自己` 开头）；无新信息、无需补充或收到纯礼貌确认（如“收到/好的/谢谢”）时直接输出 `[PASS]`。\n\
         - 三段式发言节奏（收到消息立即回应 → 重要节点/事项及时发声 → 完成时按对象汇报）：① 收到需要调用工具执行的任务时，必须在第一次调用工具前的同一回合先写一句简短回应（说明收到及总体要做什么），不要一声不吭直接调工具；② 开场回应后，查阅文件、搜索代码等常规单步操作保持沉默（严禁每一步都播报“我将读取某某文件”、“我再看第几行”等流水账），仅在进入关键重要节点或发现需提醒的重要事项（如改动可能与其他成员冲突）时及时发声提醒；③ 完成时按汇报对象输出结论。严禁在正文中复述或提及任何协作规则。\n\
         - 按受众定制内容（看人说话）：发言前先思考接收方的角色职责及它下一步需要什么信息——面向 Person（决策者与最终验收者）时，只汇报最终结果、需拍板的决策事项与重要注意事项，除非 Person 主动追问，否则严禁罗列修改了哪些文件、组件名、函数名等具体实施细节；面向其他 Bot 时，根据对方的专业职责提供其开展工作所需的精准输入（如对实施者给路径接口与改动细节、对规划者给分析结论与约束、对审计/测试者给变更范围与风险点、对 UI 成员给交互与视觉规范等）。\n\
         - 独立核实与零复读：群内其他 Bot 的观点不等于已验证事实，涉及代码或根因必须结合自身职责独立核实；前序成员已得出的结论、事实或理由直接跳过，严禁复述或换词总结，只写你的增量结论。\n\
         - 初步结论与长内容入群收藏：超过两三句话的初步调查结论、根因分析、方案或实施细节，不要直接发在聊天消息里刷屏，应写入当前 Space 共享收藏文件夹 `{collection_path}`（直接用文件工具读写，其他成员可共同查看并基于同一份收藏文件修改迭代），聊天消息只用一两句话说明核心结论及收藏文件名。\n\
         - 点名与空间工具：GroupSpace 需要其他 Bot 接手或预警时正文以裸文本 @对方昵称 开头（后跟空格，严禁用反引号包裹成 `@对方昵称`，否则前端会渲染成普通代码样式；未写 `@` 默认交回给派活方或 Person）；派活前不确定谁在忙可调 `list_spaces`（看 `activity`：working / waiting_for_person / waiting_for_bot / idle）；查折叠或更早历史才静默调 `read_space_messages`；跨 Space 投递才用 `post_space_message`。完整规范位于 `~/.vibex/skills/vibex-bot/SKILL.md`。"
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn compose_space_delivery_prompt(
    pool: &SqlitePool,
    conversation_id: Uuid,
    space_id: &str,
    seq: i64,
    envelope: &Value,
    content: &str,
    display_text: &str,
) -> Result<String, CollaborationError> {
    let quoted = load_quoted_space_message(pool, space_id, envelope).await?;
    let speaking_order = round_speaking_order_line(pool, space_id, conversation_id, seq).await?;
    let working_peers = if is_group_space(space_id) {
        working_peers_line(pool, space_id, conversation_id, seq).await?
    } else {
        None
    };
    let space_name = load_space_display_name(pool, space_id).await?;
    let mut slim_envelope = slim_space_envelope_from_parts(
        space_id,
        space_name.as_deref(),
        envelope,
        quoted,
        content,
        display_text,
    );
    slim_envelope.speaking_order = speaking_order;
    slim_envelope.working_peers = working_peers;
    let slim = format_slim_space_envelope(&slim_envelope);

    let mut blocks = Vec::new();
    let hidden_session = seat_binding(pool, conversation_id).await?.is_some();
    if hidden_session {
        let acp_session_id = bound_acp_session_id(pool, conversation_id).await?;
        if claim_space_delivery_prompt_injection(pool, conversation_id, space_id, &acp_session_id)
            .await?
        {
            let persona = load_persona_prompt(pool, conversation_id).await?;
            let nickname = delivery_nickname(pool, space_id, conversation_id).await?;
            let collection_path = space_collection_prompt_path(pool, space_id).await;
            let opening = format_first_delivery_opening(
                persona.as_deref(),
                nickname.as_deref(),
                space_id,
                &collection_path,
            );
            if !opening.trim().is_empty() {
                blocks.push(opening);
            }
        }
    }
    let activity_limit = member_activity_limit();
    if activity_limit > 0
        && let Some(memory) = crate::member_memory::memory_context_text(
            pool,
            conversation_id,
            Some(&slim_envelope.body),
            activity_limit,
        )
        .await?
    {
        blocks.push(memory);
    }
    let mut after_slim = None;
    if is_group_space(space_id) {
        let last_seen = last_completed_delivery_seq(pool, space_id, conversation_id)
            .await?
            .unwrap_or(0);
        let (before, after) =
            split_missed_group_context(pool, space_id, conversation_id, last_seen, seq).await?;
        if let Some(missed_before) = before {
            blocks.push(missed_before);
        }
        after_slim = after;
    }
    blocks.push(slim);
    if let Some(missed_after) = after_slim {
        blocks.push(missed_after);
    }
    Ok(blocks.join("\n\n"))
}

async fn delivery_nickname(
    pool: &SqlitePool,
    space_id: &str,
    conversation_id: Uuid,
) -> Result<Option<String>, CollaborationError> {
    if let Some(nickname) = member_nickname(pool, space_id, conversation_id).await? {
        let nickname = nickname.trim();
        if !nickname.is_empty() {
            return Ok(Some(nickname.to_string()));
        }
    }
    let Some(binding) = seat_binding(pool, conversation_id).await? else {
        return Ok(None);
    };
    Ok(
        sqlx::query_scalar::<_, String>("SELECT name FROM collaboration_members WHERE id = ?")
            .bind(&binding.member_id)
            .fetch_optional(pool)
            .await
            .map_err(db)?
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty()),
    )
}

async fn space_collection_prompt_path(pool: &SqlitePool, space_id: &str) -> String {
    let conceptual = format!("~/.vibex/spaces/{space_id}/collection/");
    if load_space_or_unassigned(pool, space_id).await.is_err() {
        return conceptual;
    }
    let actual = space_collection_dir(space_id);
    let actual_s = actual.display().to_string();
    if actual_s.is_empty() || actual_s == conceptual {
        conceptual
    } else {
        format!("{conceptual}（实际路径：{actual_s}）")
    }
}

pub(crate) async fn bound_acp_session_id(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<String, CollaborationError> {
    let from_session: Option<String> =
        sqlx::query_scalar("SELECT external_session_id FROM sessions WHERE id = ?")
            .bind(conversation_id)
            .fetch_optional(pool)
            .await
            .map_err(db)?;
    if let Some(id) = from_session
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        return Ok(id.to_string());
    }
    let from_binding: Option<String> = sqlx::query_scalar(
        r#"SELECT acp_session_id FROM conversation_agent_bindings
           WHERE conversation_id = ?
             AND acp_session_id IS NOT NULL
             AND TRIM(acp_session_id) != ''
           ORDER BY updated_at DESC LIMIT 1"#,
    )
    .bind(conversation_id)
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    Ok(from_binding
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .unwrap_or_default())
}

/// Returns `true` when this delivery should carry the first-round opening.
pub(crate) async fn claim_space_delivery_prompt_injection(
    pool: &SqlitePool,
    conversation_id: Uuid,
    space_id: &str,
    acp_session_id: &str,
) -> Result<bool, CollaborationError> {
    let existing: Option<String> = sqlx::query_scalar(
        r#"SELECT acp_session_id FROM collaboration_space_prompt_injections
           WHERE conversation_id = ? AND space_id = ?"#,
    )
    .bind(conversation_id.to_string())
    .bind(space_id)
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    if existing.as_deref() == Some(acp_session_id) {
        return Ok(false);
    }
    sqlx::query(
        r#"INSERT INTO collaboration_space_prompt_injections
           (conversation_id, space_id, acp_session_id, injected_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(conversation_id, space_id) DO UPDATE SET
             acp_session_id = excluded.acp_session_id,
             injected_at = excluded.injected_at"#,
    )
    .bind(conversation_id.to_string())
    .bind(space_id)
    .bind(acp_session_id)
    .bind(now_stamp())
    .execute(pool)
    .await
    .map_err(db)?;
    Ok(true)
}

/// Drop the injection flag so the next delivery re-injects. Call after ACP
/// session rebuild or resume.
pub async fn invalidate_space_delivery_prompt_injections(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<(), CollaborationError> {
    sqlx::query("DELETE FROM collaboration_space_prompt_injections WHERE conversation_id = ?")
        .bind(conversation_id.to_string())
        .execute(pool)
        .await
        .map_err(db)?;
    Ok(())
}

async fn load_persona_prompt(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Option<String>, CollaborationError> {
    Ok(sqlx::query_scalar::<_, String>(
        "SELECT persona_prompt FROM conversation_personas WHERE conversation_id = ?",
    )
    .bind(conversation_id.to_string())
    .fetch_optional(pool)
    .await
    .map_err(db)?
    .filter(|value: &String| !value.trim().is_empty()))
}

async fn load_quoted_space_message(
    pool: &SqlitePool,
    space_id: &str,
    envelope: &Value,
) -> Result<Option<QuotedSpaceMessage>, CollaborationError> {
    let Some(message_id) = parse_space_envelope(envelope).reply_to else {
        return Ok(None);
    };
    let row: Option<(i64, String)> = sqlx::query_as(
        r#"SELECT seq, envelope_json FROM collaboration_space_messages
           WHERE id = ? AND space_id = ?"#,
    )
    .bind(message_id)
    .bind(space_id)
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    let Some((seq, raw_envelope)) = row else {
        return Ok(None);
    };
    let quoted_envelope: Value = serde_json::from_str(&raw_envelope).unwrap_or(Value::Null);
    let body = quoted_envelope
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    Ok(Some(QuotedSpaceMessage {
        seq,
        sender: sender_nickname(&quoted_envelope),
        body,
    }))
}

fn sender_nickname(envelope: &Value) -> String {
    let parsed = parse_space_envelope(envelope);
    if parsed.sender.is_empty() {
        actor_display_name("")
    } else {
        parsed.sender
    }
}

fn recipients_label(envelope: &Value) -> String {
    let parsed = parse_space_envelope(envelope);
    parsed
        .to
        .iter()
        .map(|name| recipient_display_name(name))
        .collect::<Vec<_>>()
        .join(", ")
}

async fn load_space_display_name(
    pool: &SqlitePool,
    space_id: &str,
) -> Result<Option<String>, CollaborationError> {
    if !is_group_space(space_id) {
        return Ok(None);
    }
    let name = sqlx::query_scalar::<_, String>(
        "SELECT name FROM collaboration_spaces WHERE id = ? LIMIT 1",
    )
    .bind(space_id)
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    Ok(name
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty()))
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let taken: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{taken}…")
    } else {
        taken
    }
}

pub(crate) const COLLABORATION_MCP_TOOLS_SUMMARY: &str = "你可以使用 `list_spaces`（查看本工作区 BotSpace / GroupSpace 概览；传入 `space_id` 看详情与成员，含主管 `supervisor_nickname` / `is_caller_supervisor` 与群负责人 `lead_bot` / `lead_nickname`。每个成员带 `is_supervisor`、当前 `agent_id` / `mode_id` / `model` / `thinking_level` 及 `activity`：`state` 为 working / waiting_for_person / waiting_for_bot / idle，`at` 是所在 Space，`waiting_for` 是在等的 Person 或 Bot 名。派活前看这个，不要靠记忆）、`read_space_messages`（单次读取群历史，支持 `since_seq` 与 `limit`）、`post_space_message`（仅用于跨 Space 投递或 `delay_seconds` 延时；本 Space 回复请直接输出普通文本。向 Person 传 `to: [\"User\"]` 或 `[\"Person\"]`，向其他 Bot 传 `to: [\"昵称\"]` 并以 `@昵称 ` 开头；发到 Group 时 `to` 传群名，正文 `@BotName` 叫醒该群成员，没有 `@` 是日志回执）、`manage_bot`（支持 `list_agents` 查询可用 Agent/模式/模型/思考等级列表，以及创建/更新/删除/打断 Bot；其中创建/删除他人/修改人设、`agent_id`、`mode_id`、`model`、`thinking_level`（或 `effort`）与 `config_values` 配置仅限主管调用）、`manage_group`（创建/重命名/删除群、加人、移出、退出、指定牵头 Bot；其中创建/删除群仅限主管，加人/移出/改名/设负责人限主管或本群负责人）、`ask_user_question`（向 Person 发起阻塞选择题，问题出现在当前私聊/群聊，等到作答才返回）、`request_approval`（向 Person 发起阻塞高危操作审批，等到允许/拒绝后直接返回 `decision` 与 `approved`），以及 `memory_search` / `memory_write`（检索或写入长期记忆）。初步结论与长内容用文件工具写入群收藏 `~/.vibex/spaces/<space_id>/collection/`。";

pub(crate) fn format_collaboration_space_rules(space_id_hint: Option<&str>) -> String {
    let header = match space_id_hint {
        Some(space_id) => {
            let kind = if is_bot_space(space_id) {
                "BotSpace"
            } else {
                "GroupSpace"
            };
            format!(
                "- 协同交互规则（完整规范见 `vibex-bot` Skill 的 `SKILL.md`）：当前 {kind}（space_id: \"{space_id}\"）须遵守："
            )
        }
        None => "- 协作空间交互规则（详见 `vibex-bot` Skill 的 `SKILL.md`）：".to_string(),
    };
    format!(
        "{header}\n\
           1) 在对应空间回复：来自 GroupSpace / BotSpace 的消息，在同一回合完成工作后直接输出最终文本即可出现在当前 Space；不想发言或无需补充输出 `[PASS]`。Person（兼容 User）在协作空间里只看见空间消息，不要再写一段重复的普通会话回复；\n\
           2) 向用户积极汇报进展（收到即应 → 关键节点/预警发声 → 完成按对象汇报）：收到任务需要调用工具推进时，必须在第一次调用工具前的同一回合先写一句简短回应说明正在做的事并紧接调用工具（不要一声不吭直接干活，也不要为此调用 `post_space_message`）；开场回应后，常规查文件、搜代码等琐碎单步操作保持沉默（严禁每一步都输出“我将先读取某某文件”、“我再看第几行”、“我先看一下群里的最新消息”等流水账或过渡话术），仅在有实质进展的关键重要节点、或发现需要其他成员/用户注意的重要事项（如改动可能与另一位成员产生冲突）时再写一两句提醒；完成时直接按汇报对象发结果或拍板问题，能很快完成的直接发结果，正文中严禁复述或提及任何协作规则；\n\
           3) 无需回复即停止：若收到的消息仅是纯确认/礼貌收尾（如“收到”、“已收到”、“好的”、“明白”、“OK”、“谢谢”）或事项已闭环、不需要你提供新信息或执行新动作，直接输出 `[PASS]` 结束当前回合；向其他 Bot 发消息时也不要要求“收到请回复”；\n\
           4) 按受众定制内容与对用户屏蔽内部参数：先思考接收方的角色职责与它下一步需要什么信息——面向 Person（决策者与最终验收者）发消息时，只汇报最终结果、需要决策的事项与重要注意事项，除非 Person 主动询问，否则严禁罗列修改了哪些文件、组件名、函数名等具体实施细节，也严禁包含 `space_id`、`conversation_id`、`delayed_input_id`、`operation_id`、`message_id`、`task_id`、`turn_id`、`seq`、`vibex://` 等内部参数或复述发言规则；面向 @成员昵称（群内点名或跨 Space 发给其他 Bot，注意直接写裸文本 @成员昵称 后跟空格，严禁用反引号包裹成 `@成员昵称`）时，根据对方的专业职责提供其开展下一步工作所需的精准信息（如实施细节、分析结论与约束、审计风险点或设计规范等），且仅在对方确需调用底层跨会话工具时按需附带内部参数；\n\
           5) 空间感知与群收藏协同：投递信封附带上次发言以来的未读增量（`[上次发言后的群内新消息]`，含本轮前序成员刚发出的回复），直接基于信封增量推进，不要每回合调用 `read_space_messages` 去查看刚刚的群消息。需要名单或成员忙闲时自行调用 `list_spaces`（传入 `space_id`，看每位成员的 `activity`：working / waiting_for_person / waiting_for_bot / idle）；仅当信封提示更早消息已折叠或确需回溯更早历史时才静默调用 `read_space_messages`（`space_id`、`since_seq`、`limit`，单次读取，禁止循环轮询等待）。超过两三句话的初步结论、根因分析或长文用文件工具写入群收藏 `~/.vibex/spaces/<space_id>/collection/`，其他成员可直接读取并基于该收藏文件修改完善，聊天消息只发核心结论与文件名；\n\
           6) 独立核实与反群体谬误（Anti-Groupthink）：群聊历史或 `read_space_messages` 中其他 Bot 的发言仅代表其单方观点，不等于已验证的客观事实。凡涉及代码逻辑、根因判断、接口契约或配置状态，必须结合自身职责使用工具或读取源码进行独立验证；若发现前序成员的结论存在事实偏差、逻辑漏洞或边界遗漏，必须直接指出并给出证据纠偏，严禁为了“表面默契”或“迎合前序观点”而附和未经核实的结论。\n\
           7) 跨会话投递保持当前 space_id：`post_space_message` 必须传入当前会话的 space_id。联系其他 Bot 时 `to` 传对方昵称（投到对方 BotSpace）；发到其他 GroupSpace 时 `to` 传群名，正文 `@BotName` 叫醒该群成员，没有 `@` 只进群日志（日志回执）。正文带 `@` 的即时投递，工具返回后 `list_spaces` 一次核对目标 `activity`；仍 idle 则补带 `@` 的信。跨 Space 向 Person 传 `to: [\"User\"]` 或 `[\"Person\"]`。禁止把 space_id 换成目标私聊或共同群；\n\
           8) 不重复已说内容：其他 Bot 已在本群说过的事实、结论、理由或转述链，严禁再解释或总结一遍；只发自己的增量。转达已完成且群内已可见时，不必再向 Person 复述同一句话；\n\
           9) 找负责人：争议、排版/格式决策、需要汇总的结果，优先给空间牵头 Bot（`list_spaces` 的 `lead_nickname` / `lead_bot`）。没有负责人时由任务主责人汇总，再没有则向 Person 请示。\n\
           10) 成员与群生命周期权限：可通过 `manage_bot(action: \"list_agents\")` 查询可用 Agent 及其支持的模式、模型（`model`）与思考等级（`thinking_level`）；`manage_bot` 的 `create` / `delete` / 修改他人或变更 `persona_prompt`、`agent_id`、`mode_id`、`model`、`thinking_level`（或 `effort`）与 `config_values`，以及 `manage_group` 的 `create` / `delete` 仅限工作区 **主管（总管）** 调用（创建前先 `list_spaces` 防重；主管本身受保护不可删除）；`manage_group` 的 `rename` / `add_bot` / `remove_bot` / `set_lead` 限主管或本群负责人调用；普通 Bot 仅可 `manage_bot(update)` 改自己昵称或 `manage_group(leave)` 退群。删除 Bot 或删除 Group 不可逆，执行前必须先 `request_approval`；\n\
           11) 打断同群 Bot 的在途回合：只在对方必须立刻停下（危险操作、明显跑偏）且口头 `@` 来不及的时候，用 `manage_bot`（`action: \"interrupt\"`）。同群任意 Bot 或工作区主管都可打断其他 Bot；不能打断自己，不能对 BotSpace 打断；被打断的工作不会自动重做，对方已排队的消息可能先开始。"
    )
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::collaboration::{
        PostToSpace, add_space_member, post_to_space,
        test_support::{create_session, inputs_of, post_as, setup_pool, space_of},
    };

    const SAMPLE_SPACE: &str = "space-demo";
    const SAMPLE_ROOT: &str = "root-msg-1";
    const SAMPLE_BODY: &str = "请分析登录性能";
    const SAMPLE_PERSONA: &str = "你是后端评审，只看 diff。";

    fn sample_envelope() -> Value {
        json!({
            "sender": "Person",
            "to": ["小A"],
            "content": SAMPLE_BODY,
        })
    }

    fn fat_legacy_prompt(roster: &str) -> String {
        let rules = format_collaboration_space_rules(Some(SAMPLE_SPACE));
        format!(
            "人设\n{SAMPLE_PERSONA}\n\n\
             [协作空间成员身份]\n\
             - 所属协作空间：评审工作 (space_id: {SAMPLE_SPACE})\n  \
             你的成员昵称：小A (conversation_id: conv-a)\n  \
             同空间成员：{roster}\n\
             - 多智能体协同 MCP 工具：{COLLABORATION_MCP_TOOLS_SUMMARY}\n\
             {rules}\n\n\
             [协作空间消息]\n\
             - 来源协作空间：评审工作 (space_id: {SAMPLE_SPACE})\n\
             - 消息来源：User（用户）\n\
             - 收件成员：@小A\n\
             - 消息序号：#1 (message_id: vibex://space-message/{SAMPLE_ROOT})\n\
             - 空间内成员：{roster}\n\
             - 回复提醒：本条消息来自协作空间（space_id: \"{SAMPLE_SPACE}\"）。需要用户或成员看见的内容，调用 `post_to_space`（传入该 `space_id`）发到同一空间；不要再写一段重复的普通会话回复。\n\n\
             {SAMPLE_BODY}"
        )
    }

    #[test]
    fn slim_envelope_snapshot() {
        let envelope = format_slim_space_envelope(&slim_space_envelope_from_parts(
            SAMPLE_SPACE,
            Some("评审工作"),
            &sample_envelope(),
            None,
            SAMPLE_BODY,
            SAMPLE_BODY,
        ));
        assert_eq!(
            envelope,
            "[Group chat \"评审工作\" · from Person · to @小A]\n\
             请分析登录性能"
        );
    }

    #[test]
    fn slim_envelope_bot_space_uses_message_from_header() {
        let envelope = format_slim_space_envelope(&slim_space_envelope_from_parts(
            "direct:member-a",
            None,
            &sample_envelope(),
            None,
            SAMPLE_BODY,
            SAMPLE_BODY,
        ));
        assert_eq!(
            envelope,
            "[Message from Person · to @小A]\n\
             请分析登录性能"
        );
    }

    #[test]
    fn slim_envelope_includes_quoted_message_snapshot() {
        let envelope = format_slim_space_envelope(&SlimSpaceEnvelope {
            sender: "小A".to_string(),
            recipients: "@小B".to_string(),
            is_group: true,
            space_name: Some("评审工作".to_string()),
            quoted: Some(QuotedSpaceMessage {
                seq: 3,
                sender: "Person".to_string(),
                body: "请核对接口".to_string(),
            }),
            speaking_order: None,
            working_peers: None,
            body: "接口字段已对齐".to_string(),
        });
        assert_eq!(
            envelope,
            "[Group chat \"评审工作\" · from 小A · to @小B · quoting #3 Person: 请核对接口]\n\
             接口字段已对齐"
        );
    }

    #[test]
    fn post_to_space_rules_address_user_without_at_user_prefix() {
        let rules = format_collaboration_space_rules(Some(SAMPLE_SPACE));
        assert!(rules.contains("to: [\"User\"]"), "{rules}");
        assert!(!rules.contains("content 以 `@User ` 开头"), "{rules}");
        assert!(!rules.contains("以 `@User ` 开头"), "{rules}");
        assert!(
            rules.contains("面向 Person") || rules.contains("向用户发消息时"),
            "{rules}"
        );
        assert!(rules.contains("@成员昵称"), "{rules}");
        assert!(
            COLLABORATION_MCP_TOOLS_SUMMARY.contains("to: [\"User\"]"),
            "{COLLABORATION_MCP_TOOLS_SUMMARY}"
        );
        assert!(
            !COLLABORATION_MCP_TOOLS_SUMMARY.contains("以 `@User ` 开头"),
            "{COLLABORATION_MCP_TOOLS_SUMMARY}"
        );
        assert!(
            COLLABORATION_MCP_TOOLS_SUMMARY.contains("以 `@昵称 ` 开头"),
            "{COLLABORATION_MCP_TOOLS_SUMMARY}"
        );
    }

    #[test]
    fn post_to_space_rules_report_progress_to_user() {
        let rules = format_collaboration_space_rules(Some(SAMPLE_SPACE));
        assert!(rules.contains("向用户积极汇报进展"), "{rules}");
        assert!(rules.contains("正在做的事"), "{rules}");
        assert!(rules.contains("实质进展"), "{rules}");
        assert!(rules.contains("同一回合"), "{rules}");
        assert!(
            rules.contains("不要为此调用 `post_space_message`"),
            "{rules}"
        );
        assert!(rules.contains("直接发结果"), "{rules}");
        assert!(rules.contains("严禁复述或提及任何协作规则"), "{rules}");
        assert!(rules.contains("群收藏"), "{rules}");
        assert!(rules.contains("按受众定制内容"), "{rules}");
        assert!(rules.contains("冲突"), "{rules}");
        assert!(!rules.contains("简短回复已收到"), "{rules}");
        assert!(!rules.contains("已收到及处理计划"), "{rules}");
        assert!(!rules.contains("我正在查看项目中"), "{rules}");
        assert!(!rules.contains("我已经查看了项目的完整架构"), "{rules}");
        assert!(!rules.contains("尽快向 Person 写正在做的事"), "{rules}");
        assert!(rules.contains("to: [\"User\"]"), "{rules}");
        assert!(!rules.contains("content 以 `@User ` 开头"), "{rules}");
        assert!(
            !COLLABORATION_MCP_TOOLS_SUMMARY.contains("长任务中途"),
            "{COLLABORATION_MCP_TOOLS_SUMMARY}"
        );
    }

    #[test]
    fn post_to_space_rules_do_not_restate_already_said_content() {
        let rules = format_collaboration_space_rules(Some(SAMPLE_SPACE));
        assert!(
            rules.contains("不重复") || rules.contains("已说过"),
            "{rules}"
        );
        assert!(rules.contains("增量"), "{rules}");
    }

    #[test]
    fn post_to_space_rules_escalate_to_space_lead() {
        let rules = format_collaboration_space_rules(Some(SAMPLE_SPACE));
        assert!(rules.contains("负责人"), "{rules}");
        assert!(
            rules.contains("争议") || rules.contains("排版") || rules.contains("汇总"),
            "{rules}"
        );
        assert!(
            COLLABORATION_MCP_TOOLS_SUMMARY.contains("lead_nickname")
                || COLLABORATION_MCP_TOOLS_SUMMARY.contains("负责人"),
            "{COLLABORATION_MCP_TOOLS_SUMMARY}"
        );
        assert!(
            rules.contains("activity") && COLLABORATION_MCP_TOOLS_SUMMARY.contains("waiting_for"),
            "{rules}\n{COLLABORATION_MCP_TOOLS_SUMMARY}"
        );
    }

    #[test]
    fn post_to_space_rules_keep_current_space_id_for_cross_chat() {
        let dm = "direct:member-a";
        let rules = format_collaboration_space_rules(Some(dm));
        assert!(rules.contains(dm), "{rules}");
        assert!(
            rules.contains("当前会话的 space_id") || rules.contains("当前 space_id"),
            "{rules}"
        );
        assert!(rules.contains("to"), "{rules}");
        assert!(
            rules.contains("不要把 space_id 换成") || rules.contains("禁止把 space_id 换成"),
            "{rules}"
        );
        assert!(
            rules.contains("@BotName") && rules.contains("只进群日志"),
            "{rules}"
        );
        assert!(
            rules.contains("日志回执") && rules.contains("list_spaces"),
            "{rules}"
        );
    }

    #[test]
    fn first_opening_contains_space_identity_rules() {
        let opening = format_first_delivery_opening(
            Some(SAMPLE_PERSONA),
            Some("小A"),
            SAMPLE_SPACE,
            &format!("~/.vibex/spaces/{SAMPLE_SPACE}/collection/"),
        );
        assert!(opening.contains("人设"));
        assert!(opening.contains(SAMPLE_PERSONA));
        assert!(opening.contains("[Space 身份与协作规则]"));
        assert!(opening.contains("GroupSpace"));
        assert!(opening.contains("Bot「小A」"));
        assert!(opening.contains("~/.vibex/skills/vibex-bot/SKILL.md"));
        assert!(opening.contains(&format!("~/.vibex/spaces/{SAMPLE_SPACE}/collection/")));
        assert!(opening.contains("[PASS]"));
        assert!(opening.contains("无需调用工具"));
        assert!(opening.contains("@对方昵称"));
        assert!(opening.contains("list_spaces"));
        assert!(opening.contains("read_space_messages"));
        assert!(opening.contains("独立核实"));
        assert!(opening.contains("同一回合"));
        assert!(opening.contains("按受众定制内容"));
        assert!(opening.contains("三段式发言节奏"));
        assert!(opening.contains("初步结论与长内容入群收藏"));
        assert!(!opening.contains("同空间成员："));
        assert!(!opening.contains("空间内成员："));
        assert!(!opening.contains("尽快向 Person 写正在做的事"));
    }

    #[test]
    fn slim_envelope_reads_simple_person_and_bot_senders() {
        let envelope = json!({
            "sender": "User",
            "to": ["小A"],
            "content": SAMPLE_BODY,
        });
        let slim = format_slim_space_envelope(&slim_space_envelope_from_parts(
            SAMPLE_SPACE,
            Some("评审工作"),
            &envelope,
            None,
            SAMPLE_BODY,
            SAMPLE_BODY,
        ));
        assert!(
            slim.contains("[Group chat \"评审工作\" · from Person · to @小A]"),
            "{slim}"
        );
        assert!(slim.starts_with('['), "{slim}");
        assert_eq!(slim.lines().count(), 2, "{slim}");
    }

    #[test]
    fn slim_envelope_includes_speaking_order() {
        let envelope = format_slim_space_envelope(&SlimSpaceEnvelope {
            sender: "Person".to_string(),
            recipients: "@小A, @小B".to_string(),
            is_group: true,
            space_name: Some("评审工作".to_string()),
            quoted: None,
            speaking_order: Some("@小A (posted) → @小B (you, now) → @小C (waiting)".to_string()),
            working_peers: None,
            body: SAMPLE_BODY.to_string(),
        });
        assert!(
            envelope.contains("speaking order: @小A (posted) → @小B (you, now) → @小C (waiting)"),
            "{envelope}"
        );
        assert_eq!(envelope.lines().next().unwrap().matches('[').count(), 1);
    }

    #[test]
    fn slim_envelope_includes_working_peers() {
        let envelope = format_slim_space_envelope(&SlimSpaceEnvelope {
            sender: "Person".to_string(),
            recipients: "@小B".to_string(),
            is_group: true,
            space_name: Some("评审工作".to_string()),
            quoted: None,
            speaking_order: None,
            working_peers: Some("@Coder (working)".to_string()),
            body: SAMPLE_BODY.to_string(),
        });
        assert!(
            envelope.contains("still at work: @Coder (working)"),
            "{envelope}"
        );
    }

    #[test]
    fn subsequent_envelope_omits_rules_roster_and_persona() {
        let slim = format_slim_space_envelope(&slim_space_envelope_from_parts(
            SAMPLE_SPACE,
            Some("评审工作"),
            &sample_envelope(),
            None,
            SAMPLE_BODY,
            SAMPLE_BODY,
        ));
        assert!(!slim.contains("协同交互规则"));
        assert!(!slim.contains("[Space 身份与协作规则]"));
        assert!(!slim.contains("人设"));
        assert!(!slim.contains("list_space_members"));
        assert!(!slim.contains("空间内成员"));
        assert!(!slim.contains("同空间成员"));
        assert!(!slim.contains(SAMPLE_PERSONA));
        assert!(!slim.contains("root_id"));
        assert!(!slim.contains("序号"));
        assert!(slim.contains("[Group chat \"评审工作\" · from Person · to @小A]"));
        assert!(slim.contains(SAMPLE_BODY));
        assert_eq!(slim.lines().count(), 2, "{slim}");
    }

    #[test]
    fn same_message_prompt_length_drops_after_slim() {
        let roster = "小A (conversation_id: conv-a)、小B (conversation_id: conv-b)、小C (conversation_id: conv-c)，以及 User（用户）";
        let fat = fat_legacy_prompt(roster);
        let _identity = format!(
            "[协作空间成员身份]\n- 所属协作空间：评审工作 (space_id: {SAMPLE_SPACE})\n  你的成员昵称：小A (conversation_id: conv-a)\n- 多智能体协同 MCP 工具：{COLLABORATION_MCP_TOOLS_SUMMARY}\n{}",
            format_collaboration_space_rules(Some(SAMPLE_SPACE))
        );
        let first = format!(
            "{}\n\n{}",
            format_first_delivery_opening(
                Some(SAMPLE_PERSONA),
                Some("小A"),
                SAMPLE_SPACE,
                &format!("~/.vibex/spaces/{SAMPLE_SPACE}/collection/"),
            ),
            format_slim_space_envelope(&slim_space_envelope_from_parts(
                SAMPLE_SPACE,
                Some("评审工作"),
                &sample_envelope(),
                None,
                SAMPLE_BODY,
                SAMPLE_BODY,
            ))
        );
        let second = format_slim_space_envelope(&slim_space_envelope_from_parts(
            SAMPLE_SPACE,
            Some("评审工作"),
            &sample_envelope(),
            None,
            SAMPLE_BODY,
            SAMPLE_BODY,
        ));
        let fat_chars = fat.chars().count();
        let first_chars = first.chars().count();
        let second_chars = second.chars().count();
        // ~4 chars/token for mixed CJK/ASCII as a rough bound.
        let estimate_tokens = |chars: usize| chars.div_ceil(4);
        assert!(
            second_chars < first_chars && first_chars <= fat_chars,
            "fat={fat_chars} first={first_chars} second={second_chars}"
        );
        assert!(
            second_chars < 400,
            "subsequent envelope should stay tiny, got {second_chars}"
        );
        eprintln!(
            "collab prompt length (chars / ~tokens): fat {} / {}, first {} / {}, second {} / {}",
            fat_chars,
            estimate_tokens(fat_chars),
            first_chars,
            estimate_tokens(first_chars),
            second_chars,
            estimate_tokens(second_chars)
        );
    }

    #[tokio::test]
    async fn first_delivery_injects_rules_second_does_not() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        let space = space_of(&pool, a).await;
        post_as(&pool, None, &space, "@小A 请分析登录", &[]).await;
        post_as(&pool, None, &space, "@小A 再看缓存", &[]).await;
        let texts = inputs_of(&pool, a).await;
        assert_eq!(texts.len(), 2);
        let first: Value = serde_json::from_str(&texts[0]).unwrap();
        let second: Value = serde_json::from_str(&texts[1]).unwrap();
        let first = first["text"].as_str().unwrap();
        let second = second["text"].as_str().unwrap();
        assert!(first.contains("[Space 身份与协作规则]"), "{first}");
        assert!(first.contains("[PASS]"), "{first}");
        assert!(
            first.contains("~/.vibex/skills/vibex-bot/SKILL.md"),
            "{first}"
        );
        assert!(
            first.contains("[Group chat \"评审工作\" · from Person"),
            "{first}"
        );
        assert!(first.contains("请分析登录"), "{first}");
        assert!(!first.contains("空间内成员"), "{first}");
        assert!(!second.contains("[Space 身份与协作规则]"), "{second}");
        assert!(!second.contains("list_space_members"), "{second}");
        assert!(
            second.contains("[Group chat \"评审工作\" · from Person"),
            "{second}"
        );
        assert!(
            second.contains("请再看缓存") || second.contains("再看缓存"),
            "{second}"
        );
    }

    #[tokio::test]
    async fn rebuild_or_resume_reinjects_opening() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        db::models::session::Session::update_external_session_id(&pool, a, "acp-1")
            .await
            .unwrap();
        let space = space_of(&pool, a).await;
        post_as(&pool, None, &space, "@小A 第一轮", &[]).await;
        post_as(&pool, None, &space, "@小A 第二轮", &[]).await;
        db::models::session::Session::update_external_session_id(&pool, a, "acp-2")
            .await
            .unwrap();
        post_as(&pool, None, &space, "@小A 重建后", &[]).await;
        invalidate_space_delivery_prompt_injections(&pool, a)
            .await
            .unwrap();
        post_as(&pool, None, &space, "@小A 恢复后", &[]).await;

        let texts = inputs_of(&pool, a).await;
        assert_eq!(texts.len(), 4);
        let text_at = |i: usize| {
            let payload: Value = serde_json::from_str(&texts[i]).unwrap();
            payload["text"].as_str().unwrap().to_string()
        };
        let has_rules = |text: &str| text.contains("[Space 身份与协作规则]");
        assert!(has_rules(&text_at(0)), "{}", text_at(0));
        assert!(!has_rules(&text_at(1)), "{}", text_at(1));
        assert!(
            has_rules(&text_at(2)),
            "rebuild should re-inject {}",
            text_at(2)
        );
        assert!(
            has_rules(&text_at(3)),
            "resume should re-inject {}",
            text_at(3)
        );
    }

    #[tokio::test]
    async fn quoted_reply_lands_in_slim_envelope() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        let space = space_of(&pool, a).await;
        add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        let first = post_as(&pool, None, &space, "@小A 请核对接口", &[]).await;
        post_to_space(
            &pool,
            PostToSpace {
                caller_id: Some(a),
                space_id: space.clone(),
                content: "@小B 接口字段已对齐".to_string(),
                summary: None,
                to: vec!["小B".to_string()],
                in_reply_to: Some(first.message_id.clone()),
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();
        let texts = inputs_of(&pool, b).await;
        let payload: Value = serde_json::from_str(texts.last().unwrap()).unwrap();
        let text = payload["text"].as_str().unwrap();
        assert!(text.contains("quoting #"), "{text}");
        assert!(text.contains("请核对接口"), "{text}");
        assert!(text.contains("接口字段已对齐"), "{text}");
        assert!(!text.contains("root_id"), "{text}");
        assert!(
            text.contains("[Group chat \"评审工作\" · from 小A"),
            "{text}"
        );
    }

    #[test]
    fn bot_bootstrap_prompt_matches_concise_ds_bot_templates_and_strips_wrapper_in_envelope() {
        let master = build_bot_bootstrap_prompt(None, true);
        assert_eq!(
            strip_private_bootstrap_tags(&master),
            "你刚被设为用户的总管 Bot。请用一两句简短的话向用户打个招呼：说明你会帮用户统筹管理 Bot 团队，有需要决策的事都可以找你；再用一个简短的问题询问最想先让团队帮什么忙。\n如果人设另有说明，以人设为准。"
        );

        let bot_created = build_bot_bootstrap_prompt(Some("Lander"), false);
        assert_eq!(
            strip_private_bootstrap_tags(&bot_created),
            "Lander 刚为用户创建了你。请用一句简短的话向用户打个招呼，再用一个简短的问题询问从哪里开始，保持简短。\n如果人设另有说明，以人设为准。"
        );

        let user_created = build_bot_bootstrap_prompt(Some("你"), false);
        assert_eq!(
            strip_private_bootstrap_tags(&user_created),
            "用户刚创建了你。请用一句简短的话向用户打个招呼，再用一个简短的问题询问接下来重点做什么。\n如果人设另有说明，以人设为准。"
        );

        let env = json!({
            "sender": "Person",
            "to": ["Bot (Hailer)"],
            "content": bot_created,
        });
        let slim = slim_space_envelope_from_parts(
            "direct:member-1",
            None,
            &env,
            None,
            &bot_created,
            &bot_created,
        );
        assert!(!slim.body.contains("<vibex-private-bootstrap>"));
        assert!(!slim.body.contains("</vibex-private-bootstrap>"));
        assert!(slim.body.starts_with("Lander 刚为用户创建了你。"));
    }

    #[tokio::test]
    async fn space_delivery_prompt_injects_member_memory_with_privacy_isolation() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        let space = space_of(&pool, a).await;

        crate::member_memory::tool_write(
            &pool,
            a,
            "登录接口采用 JWT 双 Token 刷新机制",
            Some("global"),
        )
        .await
        .unwrap();
        let caller = crate::member_memory::memory_caller(&pool, a)
            .await
            .unwrap()
            .unwrap();
        crate::member_memory::create_fact(
            &pool,
            &caller.member_id,
            "私聊里的用户邮箱密码偏好",
            &crate::member_memory::FactScope::Private,
            Some(&format!("direct:{}", caller.member_id)),
            "agent",
        )
        .await
        .unwrap();

        post_as(&pool, None, &space, "@小A 请检查登录接口的 Token 刷新", &[]).await;
        let texts = inputs_of(&pool, a).await;
        let payload: Value = serde_json::from_str(texts.last().unwrap()).unwrap();
        let text = payload["text"].as_str().unwrap();

        assert!(text.contains("[成员记忆]"), "{text}");
        assert!(
            text.contains("登录接口采用 JWT 双 Token 刷新机制"),
            "{text}"
        );
        assert!(
            !text.contains("私聊里的用户邮箱密码偏好"),
            "private memory must never leak into GroupSpace: {text}"
        );
    }
}
