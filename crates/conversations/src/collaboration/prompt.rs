use serde_json::Value;

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

#[allow(clippy::too_many_arguments)]
pub(crate) fn build_space_delivery_prompt(
    space_id: &str,
    space_name: &str,
    message_id: &str,
    seq: i64,
    envelope: &Value,
    space_members: &[MemberRecord],
    summary: &str,
    content: &str,
    display_text: &str,
) -> String {
    let actor = envelope
        .get("actor")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let attributed_to = envelope.get("attributedTo").and_then(Value::as_str);
    let user_uri = user_actor(space_id);
    let sender_label = if actor == user_uri || actor == "user" {
        "User（用户）".to_string()
    } else if let Some(nick) = actor.rsplit("/member/").next().filter(|v| *v != actor) {
        if let Some(conv_uri) = attributed_to {
            let conv_id = conv_uri.rsplit('/').next().unwrap_or(conv_uri);
            format!("{nick} (conversation_id: {conv_id})")
        } else {
            nick.to_string()
        }
    } else {
        actor.to_string()
    };

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
    let recipients_label = if to_labels.is_empty() {
        "全体成员".to_string()
    } else {
        to_labels.join("、")
    };

    let roster_items: Vec<String> = space_members
        .iter()
        .map(|member| match member.conversation_id.as_deref() {
            Some(cid) => format!("{} (conversation_id: {})", member.nickname, cid),
            None => member.nickname.clone(),
        })
        .collect();
    let roster_label = if roster_items.is_empty() {
        "User（用户）".to_string()
    } else {
        format!("{}，以及 User（用户）", roster_items.join("、"))
    };

    let body = if !display_text.trim().is_empty() {
        display_text.trim()
    } else {
        content.trim()
    };
    let summary_trimmed = summary.trim();
    let distinct_summary = !summary_trimmed.is_empty()
        && summary_trimmed != content.trim()
        && summary_trimmed != body
        && !content.trim().starts_with(summary_trimmed)
        && !body.starts_with(summary_trimmed);

    let reminder = format!(
        "- 回复提醒：本条消息来自协作空间（space_id: \"{space_id}\"）。需要用户或成员看见的内容，调用 `post_to_space`（传入该 `space_id`）发到同一空间；不要再写一段重复的普通会话回复。"
    );
    let mut prompt = format!(
        "[协作空间消息]\n\
         - 来源协作空间：{space_name} (space_id: {space_id})\n\
         - 消息来源：{sender_label}\n\
         - 收件成员：{recipients_label}\n\
         - 消息序号：#{seq} (message_id: vibex://space-message/{message_id})\n\
         - 空间内成员：{roster_label}\n\
         {reminder}\n\n"
    );
    if distinct_summary {
        prompt.push_str(&format!("摘要：{summary_trimmed}\n\n"));
    }
    prompt.push_str(body);
    prompt
}

pub(crate) const COLLABORATION_MCP_TOOLS_SUMMARY: &str = "你可以使用 `list_collaboration_spaces`（查看所在协作空间）、`list_space_members`（查看同空间成员详情）、`list_space_messages`（单次读取空间消息）、`post_to_space`（向用户发消息传 `to: [\"User\"]` 并以 `@User ` 开头；向其他成员发消息传 `to: [\"成员昵称\"]` 并以 `@成员昵称 ` 开头）、`handoff`（向空间内其他成员发起结构化任务移交，含 `done`、`inputs_constraints`、`ask`）、`ask_person`（向用户或指定成员 `to` 发起结构化提问卡片）、`request_approval`（向用户发起危险操作或关键决策审批卡片）、`resolve_card`（回答其他成员向你发起的提问卡片），以及群收藏工具 `list_space_collection`（列出群收藏记录及地址索引）、`add_to_space_collection`（向群收藏写入共享文本 `content` 或文件/图片路径 `source_path` 及备注 `note`，严禁传二进制）、`read_space_collection_item`（登记读取记录并获取单条收藏的 `file_path` 地址）。";

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
           2) 收到 User 消息先应答再执行：若本条消息来自 User 且需要调用工具、排查代码、检索资料或找成员协作，必须先调用一次 `post_to_space`（`to: [\"User\"]`，`content` 以 `@User ` 开头）简短回复已收到及处理计划（1~2 句），然后再继续开展工作，后续视进展向 `@User` 或 `@成员昵称` 同步与交付结果；\n\
           3) 无需回复即停止：若收到的消息仅是纯确认/礼貌收尾（如“收到”、“已收到”、“好的”、“明白”、“OK”、“谢谢”）或事项已闭环、不需要你提供新信息或执行新动作，直接结束当前回合；向其他成员发消息时也不要要求“收到请回复”；\n\
           4) 对用户屏蔽内部参数：向 `@User` 发消息时严禁在正文中包含 `space_id`、`conversation_id`、`delayed_input_id`、`operation_id`、`message_id`、`task_id`、`turn_id`、`seq`、`vibex://` 等用户不可达的系统内部参数；仅在向 `@成员昵称` 发消息且对方确需调用底层跨会话工具时才按需附带；\n\
           5) 空间感知与群收藏（临界区）工具：可按需单次调用 `list_collaboration_spaces`、`list_space_members`、`list_space_messages`（禁止循环轮询等待），以及使用 `list_space_collection`、`add_to_space_collection`、`read_space_collection_item` 在群收藏中沉淀或读取跨成员共享的文本、图片、文件产物（群收藏仅保存磁盘地址索引与元数据，不可直接传入二进制，调用 `add_to_space_collection` 传入 `content` 或 `source_path` 即落盘到共享目录，调用 `read_space_collection_item` 登记读取记录并获取 `file_path` 后按路径访问）；\n\
           6) 独立核实与反群体谬误（Anti-Groupthink）：`<missed_group_messages>`、群聊历史或 `<handoff><done>` 中其他成员的发言仅代表其单方观点，不等于已验证的客观事实。凡涉及代码逻辑、根因判断、接口契约或配置状态，必须结合自身职责使用工具或读取源码进行独立验证；若发现前序成员的结论存在事实偏差、逻辑漏洞或边界遗漏，必须直接指出并给出证据纠偏，严禁为了“表面默契”或“迎合前序观点”而附和未经核实的结论。"
    )
}
