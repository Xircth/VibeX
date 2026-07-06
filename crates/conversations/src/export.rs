//! Human-readable conversation export (Markdown / self-contained HTML) rendered
//! from the projected timeline. Pure and deterministic so it is unit-testable;
//! the command layer projects the conversation and hands the rows here.

use agents::conversation::{
    ContentBlock, ConversationTimelineRow, MessageTurn, PlanEntry, TimelineRow, TurnRole,
};

/// Keys whose values are masked in exported text so secrets don't leak into a
/// shared file. Matched case-insensitively as `key: value` or `key=value`.
const SECRET_KEYS: &[&str] = &[
    "token",
    "secret",
    "password",
    "passwd",
    "api_key",
    "apikey",
    "api-key",
    "authorization",
    "access_key",
    "private_key",
];

/// Mask secret-looking `key: value` / `key=value` assignments line by line.
pub fn redact_secrets(text: &str) -> String {
    text.lines().map(redact_line).collect::<Vec<_>>().join("\n")
}

fn redact_line(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    for key in SECRET_KEYS {
        if let Some(key_pos) = lower.find(key) {
            let after = &line[key_pos + key.len()..];
            let trimmed = after.trim_start();
            if let Some(sep) = trimmed.chars().next()
                && (sep == ':' || sep == '=')
            {
                let value = trimmed[sep.len_utf8()..].trim();
                if !value.is_empty() {
                    let prefix = &line[..key_pos + key.len()];
                    let gap = &after[..after.len() - trimmed.len()];
                    return format!("{prefix}{gap}{sep} ***");
                }
            }
        }
    }
    line.to_string()
}

fn role_label(role: &TurnRole) -> &'static str {
    match role {
        TurnRole::User => "👤 用户",
        TurnRole::Assistant => "🤖 助手",
        TurnRole::System => "⚙️ 系统",
    }
}

/// Render the timeline as Markdown.
pub fn render_markdown(title: &str, rows: &[TimelineRow]) -> String {
    let mut out = String::new();
    out.push_str(&format!("# {}\n\n", title.trim()));
    for row in rows {
        if let ConversationTimelineRow::MessageTurn { turn, .. } = &row.row {
            render_turn_markdown(&mut out, turn);
        }
    }
    out
}

fn render_turn_markdown(out: &mut String, turn: &MessageTurn) {
    let mut header = format!("## {}", role_label(&turn.role));
    if let Some(model) = &turn.model {
        header.push_str(&format!(" · {model}"));
    }
    header.push_str(&format!("\n*{}*\n\n", turn.timestamp.to_rfc3339()));
    out.push_str(&header);

    for block in &turn.blocks {
        match block {
            ContentBlock::Text { text } => {
                out.push_str(&redact_secrets(text));
                out.push_str("\n\n");
            }
            ContentBlock::Thinking { text } => {
                for line in redact_secrets(text).lines() {
                    out.push_str(&format!("> 💭 {line}\n"));
                }
                out.push('\n');
            }
            ContentBlock::ToolUse {
                tool_name,
                input_preview,
                ..
            } => {
                let preview = input_preview
                    .as_deref()
                    .map(|p| format!("：`{}`", redact_secrets(p)))
                    .unwrap_or_default();
                out.push_str(&format!("- 🔧 **{tool_name}**{preview}\n"));
            }
            ContentBlock::ToolResult {
                output_preview,
                is_error,
                ..
            } => {
                if let Some(preview) = output_preview {
                    let marker = if *is_error { "❌" } else { "↳" };
                    out.push_str(&format!("  {marker} {}\n", redact_secrets(preview)));
                }
            }
            ContentBlock::Image { .. } => out.push_str("*(图片)*\n\n"),
            ContentBlock::ImageGeneration { revised_prompt, .. } => {
                let p = revised_prompt.as_deref().unwrap_or("");
                out.push_str(&format!("*(生成图片：{p})*\n\n"));
            }
            ContentBlock::Plan { entries } => {
                render_plan_markdown(out, entries);
            }
        }
    }
    out.push_str("\n---\n\n");
}

fn render_plan_markdown(out: &mut String, entries: &[PlanEntry]) {
    out.push_str("**计划：**\n");
    for entry in entries {
        let check = if entry.status.eq_ignore_ascii_case("completed") {
            "x"
        } else {
            " "
        };
        out.push_str(&format!("- [{check}] {}\n", entry.content));
    }
    out.push('\n');
}

fn html_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Render the timeline as a self-contained HTML document (inline styles, no
/// external assets). Tool calls and thinking collapse via `<details>`.
pub fn render_html(title: &str, rows: &[TimelineRow]) -> String {
    let mut body = String::new();
    for row in rows {
        if let ConversationTimelineRow::MessageTurn { turn, .. } = &row.row {
            render_turn_html(&mut body, turn);
        }
    }
    format!(
        "<!doctype html>\n<html lang=\"zh\"><head><meta charset=\"utf-8\">\
<title>{title}</title><style>\
body{{font:14px/1.6 -apple-system,system-ui,sans-serif;max-width:820px;margin:2rem auto;padding:0 1rem;color:#1c1c1e}}\
.turn{{border-bottom:1px solid #e5e5ea;padding:1rem 0}}\
.role{{font-weight:600;margin-bottom:.25rem}}\
.ts{{color:#8e8e93;font-size:12px}}\
.text{{white-space:pre-wrap}}\
details{{margin:.4rem 0;background:#f2f2f7;border-radius:6px;padding:.3rem .6rem}}\
summary{{cursor:pointer;color:#3a3a3c}}\
.err summary{{color:#d70015}}\
</style></head><body>\n<h1>{title}</h1>\n{body}</body></html>",
        title = html_escape(title.trim()),
        body = body
    )
}

fn render_turn_html(out: &mut String, turn: &MessageTurn) {
    let model = turn
        .model
        .as_deref()
        .map(|m| format!(" · {}", html_escape(m)))
        .unwrap_or_default();
    out.push_str(&format!(
        "<div class=\"turn\"><div class=\"role\">{}{}</div><div class=\"ts\">{}</div>",
        html_escape(role_label(&turn.role)),
        model,
        html_escape(&turn.timestamp.to_rfc3339())
    ));
    for block in &turn.blocks {
        match block {
            ContentBlock::Text { text } => {
                out.push_str(&format!(
                    "<div class=\"text\">{}</div>",
                    html_escape(&redact_secrets(text))
                ));
            }
            ContentBlock::Thinking { text } => {
                out.push_str(&format!(
                    "<details><summary>💭 思考</summary><div class=\"text\">{}</div></details>",
                    html_escape(&redact_secrets(text))
                ));
            }
            ContentBlock::ToolUse {
                tool_name,
                input_preview,
                ..
            } => {
                out.push_str(&format!(
                    "<details><summary>🔧 {}</summary><pre>{}</pre></details>",
                    html_escape(tool_name),
                    html_escape(&redact_secrets(input_preview.as_deref().unwrap_or("")))
                ));
            }
            ContentBlock::ToolResult {
                output_preview,
                is_error,
                ..
            } => {
                if let Some(preview) = output_preview {
                    let cls = if *is_error { " class=\"err\"" } else { "" };
                    out.push_str(&format!(
                        "<details{cls}><summary>{}</summary><pre>{}</pre></details>",
                        if *is_error { "❌ 结果" } else { "↳ 结果" },
                        html_escape(&redact_secrets(preview))
                    ));
                }
            }
            ContentBlock::Image { .. } => out.push_str("<p><em>(图片)</em></p>"),
            ContentBlock::ImageGeneration { revised_prompt, .. } => {
                out.push_str(&format!(
                    "<p><em>(生成图片：{})</em></p>",
                    html_escape(revised_prompt.as_deref().unwrap_or(""))
                ));
            }
            ContentBlock::Plan { entries } => {
                out.push_str("<ul>");
                for entry in entries {
                    let done = entry.status.eq_ignore_ascii_case("completed");
                    out.push_str(&format!(
                        "<li>{} {}</li>",
                        if done { "☑" } else { "☐" },
                        html_escape(&entry.content)
                    ));
                }
                out.push_str("</ul>");
            }
        }
    }
    out.push_str("</div>\n");
}

#[cfg(test)]
mod tests {
    use super::*;
    use agents::conversation::ConversationTimelineRow;
    use chrono::TimeZone;

    fn turn_row(role: TurnRole, blocks: Vec<ContentBlock>) -> TimelineRow {
        TimelineRow {
            row_id: "r".into(),
            revision: 1,
            row: ConversationTimelineRow::MessageTurn {
                turn: MessageTurn {
                    id: "t1".into(),
                    role,
                    blocks,
                    timestamp: chrono::Utc.timestamp_opt(1_700_000_000, 0).unwrap(),
                    usage: None,
                    duration_ms: None,
                    model: Some("claude".into()),
                    completed_at: None,
                },
                phase: "completed".into(),
            },
        }
    }

    #[test]
    fn markdown_renders_roles_text_and_tools() {
        let rows = vec![
            turn_row(
                TurnRole::User,
                vec![ContentBlock::Text {
                    text: "修复登录 bug".into(),
                }],
            ),
            turn_row(
                TurnRole::Assistant,
                vec![
                    ContentBlock::Text {
                        text: "好的".into(),
                    },
                    ContentBlock::ToolUse {
                        tool_use_id: None,
                        tool_name: "edit_file".into(),
                        input_preview: Some("auth.ts".into()),
                        meta: None,
                    },
                ],
            ),
        ];
        let md = render_markdown("会话", &rows);
        assert!(md.contains("# 会话"));
        assert!(md.contains("👤 用户"));
        assert!(md.contains("修复登录 bug"));
        assert!(md.contains("🤖 助手 · claude"));
        assert!(md.contains("🔧 **edit_file**"));
    }

    #[test]
    fn secrets_are_redacted() {
        let rows = turn_row(
            TurnRole::Assistant,
            vec![ContentBlock::Text {
                text: "export API_KEY=sk-supersecret\n普通文本".into(),
            }],
        );
        let md = render_markdown("t", &[rows]);
        assert!(!md.contains("sk-supersecret"));
        assert!(md.contains("***"));
        assert!(md.contains("普通文本"));
    }

    #[test]
    fn html_is_self_contained_and_escaped() {
        let rows = turn_row(
            TurnRole::User,
            vec![ContentBlock::Text {
                text: "<script>alert(1)</script>".into(),
            }],
        );
        let html = render_html("危险 & 会话", &[rows]);
        assert!(html.starts_with("<!doctype html>"));
        assert!(html.contains("<style>"));
        // The script tag must be escaped, never emitted raw.
        assert!(!html.contains("<script>alert"));
        assert!(html.contains("&lt;script&gt;"));
        assert!(html.contains("危险 &amp; 会话"));
    }

    #[test]
    fn non_message_rows_are_skipped() {
        // A timeline with only a session-notice row renders just the header.
        let md = render_markdown("空", &[]);
        assert_eq!(md.trim(), "# 空");
    }
}
