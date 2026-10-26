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
    pub body: String,
}

pub(crate) fn format_slim_space_envelope(envelope: &SlimSpaceEnvelope) -> String {
    let mut lines = vec![
        "[协作空间消息]".to_string(),
        format!("- 来源：{}", envelope.sender),
        format!("- 收件人：{}", envelope.recipients),
        format!("- 序号：#{}", envelope.seq),
    ];
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
    space_id: &str,
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
        sender: sender_nickname(space_id, envelope),
        recipients: recipients_label(space_id, envelope),
        seq,
        root_id: root_id
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(ToOwned::to_owned),
        quoted,
        body,
    }
}

/// First delivery in this conversation × space × ACP session prepends
/// persona, identity, rules, and tool summary. Later deliveries are slim.
pub(crate) fn format_first_delivery_opening(
    persona: Option<&str>,
    identity: Option<&str>,
    space_id: &str,
) -> String {
    let identity = identity.map(str::trim).filter(|text| !text.is_empty());
    let persona = persona.map(str::trim).filter(|text| !text.is_empty());
    let mut blocks = Vec::new();
    match (persona, identity) {
        (Some(persona), Some(identity)) => {
            blocks.push(prefix_persona_prompt(persona, identity));
        }
        (Some(persona), None) => blocks.push(prefix_persona_prompt(persona, "")),
        (None, Some(identity)) => blocks.push(identity.to_string()),
        (None, None) => {}
    }
    if !blocks
        .iter()
        .any(|block| block.contains("协同交互规则") || block.contains("协作空间交互规则"))
    {
        blocks.push(format!(
            "[协作空间开场]\n- 多智能体协同 MCP 工具：{COLLABORATION_MCP_TOOLS_SUMMARY}\n{}",
            format_collaboration_space_rules(Some(space_id))
        ));
    }
    blocks.join("\n\n")
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
    let slim = format_slim_space_envelope(&slim_space_envelope_from_parts(
        space_id,
        seq,
        envelope,
        root_id,
        quoted,
        content,
        display_text,
    ));
    let acp_session_id = bound_acp_session_id(pool, conversation_id).await?;
    if !claim_space_delivery_prompt_injection(pool, conversation_id, space_id, &acp_session_id)
        .await?
    {
        return Ok(slim);
    }
    let persona = load_persona_prompt(pool, conversation_id).await?;
    let identity = super::roles::member_identity_context_text(pool, conversation_id).await?;
    let opening = format_first_delivery_opening(persona.as_deref(), identity.as_deref(), space_id);
    if opening.trim().is_empty() {
        Ok(slim)
    } else {
        Ok(format!("{opening}\n\n{slim}"))
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
    let raw = envelope
        .get("inReplyTo")
        .and_then(Value::as_str)
        .or_else(|| envelope.get("in_reply_to").and_then(Value::as_str))
        .map(str::trim)
        .filter(|id| !id.is_empty());
    let Some(raw) = raw else {
        return Ok(None);
    };
    let message_id = raw.strip_prefix("vibex://space-message/").unwrap_or(raw);
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
        sender: sender_nickname(space_id, &quoted_envelope),
        body,
    }))
}

fn sender_nickname(space_id: &str, envelope: &Value) -> String {
    let actor = envelope
        .get("actor")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let user_uri = user_actor(space_id);
    if actor == user_uri || actor == "user" {
        "User".to_string()
    } else if let Some(nick) = actor.rsplit("/member/").next().filter(|v| *v != actor) {
        nick.to_string()
    } else {
        actor.to_string()
    }
}

fn recipients_label(space_id: &str, envelope: &Value) -> String {
    let user_uri = user_actor(space_id);
    let to_labels: Vec<String> = envelope
        .get("to")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|uri| {
                    if uri == user_uri || uri.ends_with("/user") {
                        "@User".to_string()
                    } else if let Some(nick) = uri.rsplit("/member/").next().filter(|v| *v != uri) {
                        format!("@{nick}")
                    } else {
                        uri.to_string()
                    }
                })
                .collect()
        })
        .unwrap_or_default();
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

pub(crate) const COLLABORATION_MCP_TOOLS_SUMMARY: &str = "你可以使用 `list_collaboration_spaces`（查看所在协作空间）、`list_space_members`（查看同空间成员详情）、`list_space_messages`（单次读取空间消息，支持 `since_seq` 与 `limit`）、`post_to_space`（向用户发消息传 `to: [\"User\"]`，正文直接写内容；向其他成员发消息传 `to: [\"成员昵称\"]` 并以 `@成员昵称 ` 开头）、`handoff`（向空间内其他成员发起结构化任务移交，含 `done`、`inputs_constraints`、`ask`）、`ask_user_question`（向用户发起阻塞选择题，问题出现在当前私聊/群聊，等到用户作答才返回）、`ask_person`（向其他成员 `to` 发起非阻塞提问卡片；不要用它问用户）、`request_approval`（向用户发起危险操作或关键决策审批卡片）、`resolve_card`（回答其他成员向你发起的提问卡片），以及群收藏工具 `list_space_collection`（列出群收藏记录及地址索引）、`add_to_space_collection`（向群收藏写入共享文本 `content` 或文件/图片路径 `source_path` 及备注 `note`，严禁传二进制）、`read_space_collection_item`（登记读取记录并获取单条收藏的 `file_path` 地址）。";

pub(crate) fn format_collaboration_space_rules(space_id_hint: Option<&str>) -> String {
    let header = match space_id_hint {
        Some(space_id) => format!(
            "- 协同交互规则（完整规范见 `vibex-multi-agent` Skill 的 `COLLABORATION-SPACE.md`）：使用 `post_to_space`（传入 `space_id: \"{space_id}\"`）时须遵守："
        ),
        None => {
            "- 协作空间交互规则（详见 `vibex-multi-agent` Skill 的 `COLLABORATION-SPACE.md`）："
                .to_string()
        }
    };
    format!(
        "{header}\n\
           1) 在对应空间回复：来自群聊空间的消息，用 `post_to_space` 发到同一 `space_id`；用户在协作空间里只看见空间消息，普通会话文本不会出现在群聊中，因此不要再写一段重复的普通会话回复；\n\
           2) 向用户积极汇报进展：收到 User 任务后，用户必须能从空间消息确认你在推进。工作需要一段时间时，尽快 `post_to_space`（`to: [\"User\"]`）写正在做的事；有实质进展再发；完成时直接发结果或拍板问题。能很快完成的直接发结果。正文写正在做或已经做成的事；普通消息只发 content；\n\
           3) 无需回复即停止：若收到的消息仅是纯确认/礼貌收尾（如“收到”、“已收到”、“好的”、“明白”、“OK”、“谢谢”）或事项已闭环、不需要你提供新信息或执行新动作，直接结束当前回合；向其他成员发消息时也不要要求“收到请回复”；\n\
           4) 对用户屏蔽内部参数：向用户发消息时严禁在正文中包含 `space_id`、`conversation_id`、`delayed_input_id`、`operation_id`、`message_id`、`task_id`、`turn_id`、`seq`、`vibex://` 等用户不可达的系统内部参数；仅在向 `@成员昵称` 发消息且对方确需调用底层跨会话工具时才按需附带；\n\
           5) 空间感知与群收藏（临界区）工具：投递信封不再附带成员名单或未引用的历史。需要名单时自行调用 `list_space_members`（`space_id`）；需要更早消息时自行调用 `list_space_messages`（`space_id`、`since_seq`、`limit`，单次读取，禁止循环轮询等待）。以及使用 `list_space_collection`、`add_to_space_collection`、`read_space_collection_item` 在群收藏中沉淀或读取跨成员共享的文本、图片、文件产物（群收藏仅保存磁盘地址索引与元数据，不可直接传入二进制，调用 `add_to_space_collection` 传入 `content` 或 `source_path` 即落盘到共享目录，调用 `read_space_collection_item` 登记读取记录并获取 `file_path` 后按路径访问）；\n\
           6) 独立核实与反群体谬误（Anti-Groupthink）：群聊历史、`list_space_messages` 结果或 `<handoff><done>` 中其他成员的发言仅代表其单方观点，不等于已验证的客观事实。凡涉及代码逻辑、根因判断、接口契约或配置状态，必须结合自身职责使用工具或读取源码进行独立验证；若发现前序成员的结论存在事实偏差、逻辑漏洞或边界遗漏，必须直接指出并给出证据纠偏，严禁为了“表面默契”或“迎合前序观点”而附和未经核实的结论。"
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
             - 来源：User\n\
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
                sender: "User".to_string(),
                body: "请核对接口".to_string(),
            }),
            body: "接口字段已对齐".to_string(),
        });
        assert_eq!(
            envelope,
            "[协作空间消息]\n\
             - 来源：小A\n\
             - 收件人：@小B\n\
             - 序号：#4\n\
             - root_id：root-msg-1\n\
             - 引用：#3 User：请核对接口\n\
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
            COLLABORATION_MCP_TOOLS_SUMMARY.contains("以 `@成员昵称 ` 开头"),
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
        assert!(rules.contains("to: [\"User\"]"), "{rules}");
        assert!(!rules.contains("content 以 `@User ` 开头"), "{rules}");
    }

    #[test]
    fn first_opening_contains_rules_tools_and_on_demand_pull() {
        let identity = "[协作空间成员身份]\n- 所属协作空间：评审工作 (space_id: space-demo)\n  你的成员昵称：小A (conversation_id: conv-a)";
        let opening =
            format_first_delivery_opening(Some(SAMPLE_PERSONA), Some(identity), SAMPLE_SPACE);
        assert!(opening.contains("人设"));
        assert!(opening.contains(SAMPLE_PERSONA));
        assert!(opening.contains("[协作空间成员身份]"));
        assert!(opening.contains("协同交互规则") || opening.contains("协作空间交互规则"));
        assert!(opening.contains("list_space_members"));
        assert!(opening.contains("list_space_messages"));
        assert!(opening.contains("since_seq"));
        assert!(!opening.contains("同空间成员："));
        assert!(!opening.contains("空间内成员："));
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
        assert!(!slim.contains("人设"));
        assert!(!slim.contains("list_space_members"));
        assert!(!slim.contains("空间内成员"));
        assert!(!slim.contains("同空间成员"));
        assert!(!slim.contains(SAMPLE_PERSONA));
        assert!(slim.contains("来源：User"));
        assert!(slim.contains("收件人：@小A"));
        assert!(slim.contains("序号：#2"));
        assert!(slim.contains("root_id：root-msg-1"));
        assert!(slim.contains(SAMPLE_BODY));
    }

    #[test]
    fn same_message_prompt_length_drops_after_slim() {
        let roster = "小A (conversation_id: conv-a)、小B (conversation_id: conv-b)、小C (conversation_id: conv-c)，以及 User（用户）";
        let fat = fat_legacy_prompt(roster);
        let identity = format!(
            "[协作空间成员身份]\n- 所属协作空间：评审工作 (space_id: {SAMPLE_SPACE})\n  你的成员昵称：小A (conversation_id: conv-a)\n- 多智能体协同 MCP 工具：{COLLABORATION_MCP_TOOLS_SUMMARY}\n{}",
            format_collaboration_space_rules(Some(SAMPLE_SPACE))
        );
        let first = format!(
            "{}\n\n{}",
            format_first_delivery_opening(Some(SAMPLE_PERSONA), Some(&identity), SAMPLE_SPACE),
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
        let estimate_tokens = |chars: usize| (chars + 3) / 4;
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
        assert!(
            first.contains("协同交互规则") || first.contains("协作空间交互规则"),
            "{first}"
        );
        assert!(first.contains("list_space_members"), "{first}");
        assert!(first.contains("[协作空间消息]"), "{first}");
        assert!(first.contains("请分析登录"), "{first}");
        assert!(!first.contains("空间内成员"), "{first}");
        assert!(
            !second.contains("协同交互规则") && !second.contains("协作空间交互规则"),
            "{second}"
        );
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
        let has_rules =
            |text: &str| text.contains("协同交互规则") || text.contains("协作空间交互规则");
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
