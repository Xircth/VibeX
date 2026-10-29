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

/// Fields that remain on every space delivery after the first-round opening.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SlimSpaceEnvelope {
    pub sender: String,
    pub recipients: String,
    pub seq: i64,
    pub root_id: Option<String>,
    pub quoted: Option<QuotedSpaceMessage>,
    pub speaking_order: Option<String>,
    pub working_peers: Option<String>,
    pub body: String,
}

pub(crate) fn format_slim_space_envelope(envelope: &SlimSpaceEnvelope) -> String {
    let mut lines = vec![
        "[协作空间消息]".to_string(),
        format!("- 来源：{}", envelope.sender),
        format!("- 收件人：{}", envelope.recipients),
        format!("- 序号：#{}", envelope.seq),
    ];
    if let Some(order) = envelope
        .speaking_order
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        lines.push(format!("- 本轮发言顺序：{order}"));
    }
    if let Some(peers) = envelope
        .working_peers
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        lines.push(format!("- 当前正在执行任务的成员：{peers}"));
    }
    if let Some(root_id) = envelope
        .root_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        lines.push(format!("- root_id：{root_id}"));
    }
    if let Some(quoted) = &envelope.quoted {
        let body = truncate_chars(quoted.body.trim(), 200);
        lines.push(format!("- 引用：#{} {}：{body}", quoted.seq, quoted.sender));
    }
    format!("{}\n{}", lines.join("\n"), envelope.body)
}

pub(crate) fn slim_space_envelope_from_parts(
    _space_id: &str,
    seq: i64,
    envelope: &Value,
    root_id: Option<&str>,
    quoted: Option<QuotedSpaceMessage>,
    content: &str,
    display_text: &str,
) -> SlimSpaceEnvelope {
    let body = if !display_text.trim().is_empty() {
        display_text.trim().to_string()
    } else {
        content.trim().to_string()
    };
    SlimSpaceEnvelope {
        sender: sender_nickname(envelope),
        recipients: recipients_label(envelope),
        seq,
        root_id: root_id
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(ToOwned::to_owned),
        quoted,
        speaking_order: None,
        working_peers: None,
        body,
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
         - 完整协作规范位于 `~/.vibex/skills/vibex-bot/SKILL.md`\n\
         - 当前 Space 的共享文件夹路径为 `{collection_path}`，可直接用普通文件工具读写\n\
         - 在当前 Space 发言无需调用工具，直接输出最终文本回复即可；不想发言或无需补充直接输出 `[PASS]`。"
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn compose_space_delivery_prompt(
    pool: &SqlitePool,
    conversation_id: Uuid,
    space_id: &str,
    seq: i64,
    envelope: &Value,
    root_id: Option<&str>,
    content: &str,
    display_text: &str,
) -> Result<String, CollaborationError> {
    let quoted = load_quoted_space_message(pool, space_id, envelope).await?;
    let speaking_order = round_speaking_order_line(pool, space_id, conversation_id, seq).await?;
    let working_peers = if is_group_space(space_id) {
        working_peers_line(pool, space_id, conversation_id).await?
    } else {
        None
    };
    let mut slim_envelope = slim_space_envelope_from_parts(
        space_id,
        seq,
        envelope,
        root_id,
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
    if is_group_space(space_id) {
        let last_seen = last_completed_delivery_seq(pool, space_id, conversation_id)
            .await?
            .unwrap_or(0);
        if let Some(missed) =
            missed_group_context(pool, space_id, conversation_id, last_seen, seq).await?
        {
            blocks.push(missed);
        }
    }
    blocks.push(slim);
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
    let to_labels: Vec<String> = parsed
        .to
        .iter()
        .map(|name| recipient_display_name(name))
        .collect();
    if to_labels.is_empty() {
        "全体成员".to_string()
    } else {
        to_labels.join("、")
    }
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

pub(crate) const COLLABORATION_MCP_TOOLS_SUMMARY: &str = "你可以使用 `list_spaces`（查看本工作区 BotSpace / GroupSpace 概览；传入 `space_id` 看详情与成员，含 `lead_bot` / `lead_nickname`）、`read_space_messages`（单次读取群历史，支持 `since_seq` 与 `limit`）、`post_space_message`（仅用于跨 Space 投递、长任务中途向 Person/User 播报进度或 `delay_seconds` 延时；本 Space 常规回复请直接输出普通文本。向 Person 传 `to: [\"User\"]` 或 `[\"Person\"]`，向其他 Bot 传 `to: [\"昵称\"]` 并以 `@昵称 ` 开头）、`manage_bot`（创建/更新/删除/打断 Bot）、`manage_group`（创建/重命名/删除群、加人、移出、退出、指定牵头 Bot）、`ask_user_question`（向 Person 发起阻塞选择题，问题出现在当前私聊/群聊，等到作答才返回）、`request_approval`（向 Person 发起高危操作审批），以及 `memory_search` / `memory_write`（检索或写入长期记忆）。共享文件用文件工具读写 `~/.vibex/{projectId}/TeamSpaces/{spaceId}/Collection/`。";

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
           1) 在对应空间回复：来自 GroupSpace / BotSpace 的消息，直接输出最终文本即可出现在当前 Space；不想发言或无需补充输出 `[PASS]`。Person（兼容 User）在协作空间里只看见空间消息，不要再写一段重复的普通会话回复；\n\
           2) 向用户积极汇报进展：收到 Person 任务后，用户必须能从空间消息确认你在推进。工作需要一段时间时，尽快向 Person 写正在做的事（`to: [\"User\"]`）；有实质进展再发；完成时直接发结果或拍板问题。能很快完成的直接发结果。正文写正在做或已经做成的事；普通消息只发 content；\n\
           3) 无需回复即停止：若收到的消息仅是纯确认/礼貌收尾（如“收到”、“已收到”、“好的”、“明白”、“OK”、“谢谢”）或事项已闭环、不需要你提供新信息或执行新动作，直接输出 `[PASS]` 结束当前回合；向其他 Bot 发消息时也不要要求“收到请回复”；\n\
           4) 对用户屏蔽内部参数：向用户发消息时严禁在正文中包含 `space_id`、`conversation_id`、`delayed_input_id`、`operation_id`、`message_id`、`task_id`、`turn_id`、`seq`、`vibex://` 等用户不可达的系统内部参数；仅在向 `@成员昵称` 发消息且对方确需调用底层跨会话工具时才按需附带；\n\
           5) 空间感知：投递信封附带上次发言以来的未读增量。需要名单时自行调用 `list_spaces`（传入 `space_id`）；需要更早消息时自行调用 `read_space_messages`（`space_id`、`since_seq`、`limit`，单次读取，禁止循环轮询等待）。共享文件用文件工具读写 `~/.vibex/{{projectId}}/TeamSpaces/{{spaceId}}/Collection/`；\n\
           6) 独立核实与反群体谬误（Anti-Groupthink）：群聊历史或 `read_space_messages` 中其他 Bot 的发言仅代表其单方观点，不等于已验证的客观事实。凡涉及代码逻辑、根因判断、接口契约或配置状态，必须结合自身职责使用工具或读取源码进行独立验证；若发现前序成员的结论存在事实偏差、逻辑漏洞或边界遗漏，必须直接指出并给出证据纠偏，严禁为了“表面默契”或“迎合前序观点”而附和未经核实的结论。\n\
           7) 跨会话投递保持当前 space_id：`post_space_message` 必须传入当前会话的 space_id。联系其他 Bot 时 `to` 传对方昵称（投到对方 BotSpace）；发到其他 GroupSpace 时 `to` 传群名。禁止把 space_id 换成目标私聊或共同群；\n\
           8) 不重复已说内容：其他 Bot 已在本群说过的事实、理由或转述链，不要再解释一遍；只发自己的增量。转达已完成且群内已可见时，不必再向 Person 复述同一句话；\n\
           9) 找负责人：争议、排版/格式决策、需要汇总的结果，优先给空间牵头 Bot（`list_spaces` 的 `lead_nickname` / `lead_bot`）。没有负责人时由任务主责人汇总，再没有则向 Person 请示。\n\
           10) 成员与群生命周期：`manage_bot` 创建/更新/删除/打断 Bot（创建默认不入群）；`manage_group` 创建/重命名/删除群、加人、移出、退出、指定牵头 Bot。删除 Bot 或删除 Group 不可逆，执行前必须先 `request_approval`；\n\
           11) 打断同群 Bot 的在途回合：需要另一位同群 Bot 立刻响应但它正忙时，先 `manage_bot`（`action: \"interrupt\"`）停止它的当前回合，再投递。同群任意 Bot 都可打断任何其他 Bot；不能打断自己，不能跨群或 BotSpace 打断；被打断的工作不会自动重做，且对方已排队的消息可能先开始，只在确有必要时使用。"
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
            "actor": format!("vibex://space/{SAMPLE_SPACE}/user"),
            "to": [format!("vibex://space/{SAMPLE_SPACE}/member/小A")],
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
            1,
            &sample_envelope(),
            Some(SAMPLE_ROOT),
            None,
            SAMPLE_BODY,
            SAMPLE_BODY,
        ));
        assert_eq!(
            envelope,
            "[协作空间消息]\n\
             - 来源：Person\n\
             - 收件人：@小A\n\
             - 序号：#1\n\
             - root_id：root-msg-1\n\
             请分析登录性能"
        );
    }

    #[test]
    fn slim_envelope_includes_quoted_message_snapshot() {
        let envelope = format_slim_space_envelope(&SlimSpaceEnvelope {
            sender: "小A".to_string(),
            recipients: "@小B".to_string(),
            seq: 4,
            root_id: Some(SAMPLE_ROOT.to_string()),
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
            "[协作空间消息]\n\
             - 来源：小A\n\
             - 收件人：@小B\n\
             - 序号：#4\n\
             - root_id：root-msg-1\n\
             - 引用：#3 Person：请核对接口\n\
             接口字段已对齐"
        );
    }

    #[test]
    fn post_to_space_rules_address_user_without_at_user_prefix() {
        let rules = format_collaboration_space_rules(Some(SAMPLE_SPACE));
        assert!(rules.contains("to: [\"User\"]"), "{rules}");
        assert!(!rules.contains("content 以 `@User ` 开头"), "{rules}");
        assert!(!rules.contains("以 `@User ` 开头"), "{rules}");
        assert!(rules.contains("向用户发消息时"), "{rules}");
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
        assert!(
            rules.contains("直接发结果") || rules.contains("很快完成"),
            "{rules}"
        );
        assert!(!rules.contains("简短回复已收到"), "{rules}");
        assert!(!rules.contains("已收到及处理计划"), "{rules}");
        assert!(!rules.contains("我正在查看项目中"), "{rules}");
        assert!(!rules.contains("我已经查看了项目的完整架构"), "{rules}");
        assert!(rules.contains("to: [\"User\"]"), "{rules}");
        assert!(!rules.contains("content 以 `@User ` 开头"), "{rules}");
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
        assert!(!opening.contains("同空间成员："));
        assert!(!opening.contains("空间内成员："));
    }

    #[test]
    fn slim_envelope_reads_simple_person_and_bot_actors() {
        let envelope = json!({
            "actor": "User",
            "to": ["小A"],
            "content": SAMPLE_BODY,
        });
        let slim = format_slim_space_envelope(&slim_space_envelope_from_parts(
            SAMPLE_SPACE,
            1,
            &envelope,
            Some(SAMPLE_ROOT),
            None,
            SAMPLE_BODY,
            SAMPLE_BODY,
        ));
        assert!(slim.contains("来源：Person"), "{slim}");
        assert!(slim.contains("收件人：@小A"), "{slim}");
    }

    #[test]
    fn slim_envelope_includes_speaking_order() {
        let envelope = format_slim_space_envelope(&SlimSpaceEnvelope {
            sender: "Person".to_string(),
            recipients: "@小A、@小B".to_string(),
            seq: 3,
            root_id: Some(SAMPLE_ROOT.to_string()),
            quoted: None,
            speaking_order: Some("@小A (已发言) → @小B (你，当前) → @小C (等待中)".to_string()),
            working_peers: None,
            body: SAMPLE_BODY.to_string(),
        });
        assert!(
            envelope.contains("- 本轮发言顺序：@小A (已发言) → @小B (你，当前) → @小C (等待中)"),
            "{envelope}"
        );
    }

    #[test]
    fn slim_envelope_includes_working_peers() {
        let envelope = format_slim_space_envelope(&SlimSpaceEnvelope {
            sender: "Person".to_string(),
            recipients: "@小B".to_string(),
            seq: 4,
            root_id: None,
            quoted: None,
            speaking_order: None,
            working_peers: Some("@Coder (工作中，请勿重复催促)".to_string()),
            body: SAMPLE_BODY.to_string(),
        });
        assert!(
            envelope.contains("- 当前正在执行任务的成员：@Coder (工作中，请勿重复催促)"),
            "{envelope}"
        );
    }

    #[test]
    fn subsequent_envelope_omits_rules_roster_and_persona() {
        let slim = format_slim_space_envelope(&slim_space_envelope_from_parts(
            SAMPLE_SPACE,
            2,
            &sample_envelope(),
            Some(SAMPLE_ROOT),
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
        assert!(slim.contains("来源：Person"));
        assert!(slim.contains("收件人：@小A"));
        assert!(slim.contains("序号：#2"));
        assert!(slim.contains("root_id：root-msg-1"));
        assert!(slim.contains(SAMPLE_BODY));
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
                1,
                &sample_envelope(),
                Some(SAMPLE_ROOT),
                None,
                SAMPLE_BODY,
                SAMPLE_BODY,
            ))
        );
        let second = format_slim_space_envelope(&slim_space_envelope_from_parts(
            SAMPLE_SPACE,
            1,
            &sample_envelope(),
            Some(SAMPLE_ROOT),
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
        assert!(first.contains("[协作空间消息]"), "{first}");
        assert!(first.contains("请分析登录"), "{first}");
        assert!(!first.contains("空间内成员"), "{first}");
        assert!(!second.contains("[Space 身份与协作规则]"), "{second}");
        assert!(!second.contains("list_space_members"), "{second}");
        assert!(second.contains("[协作空间消息]"), "{second}");
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
        assert!(text.contains("引用："), "{text}");
        assert!(text.contains("请核对接口"), "{text}");
        assert!(text.contains("接口字段已对齐"), "{text}");
        assert!(text.contains("root_id："), "{text}");
    }
}
