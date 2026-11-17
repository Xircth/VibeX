use serde_json::{Value, json};

/// Render a broker outcome as an MCP `CallToolResult`: a human/LLM-readable text
/// summary plus the full structured outcome.
pub(crate) fn render_result(outcome: &Value) -> Value {
    json!({
        "content": [{ "type": "text", "text": summarize(outcome) }],
        "structuredContent": outcome,
        "isError": outcome.get("isError").and_then(Value::as_bool).unwrap_or(false),
    })
}

fn summarize(outcome: &Value) -> String {
    if let Some(text) = outcome.get("text").and_then(Value::as_str) {
        return text.to_string();
    }
    if let Some(count) = outcome.get("count") {
        let notes = outcome
            .get("feedback")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if notes.is_empty() || count.as_u64() == Some(0) {
            return "No new feedback from the user. Continue with your current plan.".to_string();
        }
        let mut text = format!(
            "The user sent {} message(s) while you were working. Treat this as high-priority steering: adjust your current approach to honor it now, and briefly acknowledge what you changed.\n",
            notes.len()
        );
        for (index, note) in notes.iter().enumerate() {
            let body = note.get("text").and_then(Value::as_str).unwrap_or("");
            text.push_str(&format!("{}. {body}\n", index + 1));
        }
        return text;
    }
    if outcome.get("answers").is_some() || outcome.get("declined").is_some() {
        if outcome
            .get("declined")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return "The user dismissed the question(s) without choosing an answer. Proceed using your best judgment and reasonable defaults.".to_string();
        }
        let answers = outcome
            .get("answers")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if answers.is_empty() {
            return "The user dismissed the question(s) without choosing an answer. Proceed using your best judgment and reasonable defaults.".to_string();
        }
        let mut text = String::from("The user answered your question(s):\n");
        for (index, answer) in answers.iter().enumerate() {
            let header = answer.get("header").and_then(Value::as_str).unwrap_or("");
            let question = answer
                .get("question")
                .and_then(Value::as_str)
                .or_else(|| answer.get("questionId").and_then(Value::as_str))
                .unwrap_or("");
            let selected = answer
                .get("selected")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .or_else(|| {
                    answer.get("labels").and_then(Value::as_array).map(|items| {
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(", ")
                    })
                })
                .unwrap_or_default();
            text.push_str(&format!(
                "{}. [{header}] {question}\n   → {}\n",
                index + 1,
                if selected.is_empty() {
                    "(no selection)"
                } else {
                    selected.as_str()
                }
            ));
        }
        return text;
    }
    if outcome.get("found") == Some(&json!(false)) {
        if let Some(note) = outcome.get("note").and_then(Value::as_str) {
            return note.to_string();
        }
        if let Some(id) = outcome
            .get("conversation_id")
            .and_then(Value::as_str)
            .or_else(|| outcome.get("session_id").and_then(Value::as_str))
        {
            return format!("No conversation matches id {id}.");
        }
    }
    if outcome.get("found") == Some(&json!(true)) {
        return render_session_summary(outcome);
    }
    if outcome.get("tasks").is_some() {
        return outcome.to_string();
    }
    if let Some(message) = outcome.get("message").and_then(Value::as_str) {
        if let Some(task_id) = outcome.get("task_id").and_then(Value::as_str) {
            return format!("{message} (task_id: {task_id})");
        }
        return message.to_string();
    }
    outcome.to_string()
}

fn render_session_summary(outcome: &Value) -> String {
    let id = outcome
        .get("conversation_id")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let agent = outcome
        .get("agent_id")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let mut out = format!("Conversation {id} ({agent})\n");
    if let Some(title) = outcome.get("title").and_then(Value::as_str) {
        out.push_str(&format!("Title: {title}\n"));
    }
    let mut meta = Vec::new();
    if let Some(status) = outcome.get("status").and_then(Value::as_str) {
        meta.push(format!("status: {status}"));
    }
    if let Some(branch) = outcome.get("git_branch").and_then(Value::as_str) {
        meta.push(format!("branch: {branch}"));
    }
    if let Some(model) = outcome.get("model").and_then(Value::as_str) {
        meta.push(format!("model: {model}"));
    }
    if !meta.is_empty() {
        out.push_str(&meta.join(" | "));
        out.push('\n');
    }
    if let Some(path) = outcome.get("workspace_path").and_then(Value::as_str) {
        out.push_str(&format!("Workspace: {path}\n"));
    }
    if let Some(count) = outcome.get("message_count") {
        out.push_str(&format!("Messages: {count}\n"));
    }
    if outcome
        .get("is_delegation_child")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && let Some(parent) = outcome.get("parent_conversation_id").and_then(|value| {
            value
                .as_str()
                .map(str::to_string)
                .or_else(|| Some(value.to_string()))
        })
    {
        out.push_str(&format!("Delegation child of {parent}\n"));
    }
    if let Some(tokens) = outcome
        .get("stats")
        .and_then(|stats| stats.get("total_tokens"))
    {
        out.push_str(&format!("Total tokens: {tokens}\n"));
    }
    if let Some(note) = outcome.get("note").and_then(Value::as_str) {
        out.push_str(&format!("Note: {note}\n"));
    }
    if let Some(messages) = outcome.get("messages") {
        let total = messages.get("total").and_then(Value::as_u64).unwrap_or(0);
        let included = messages
            .get("included")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let truncated = messages
            .get("truncated")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let suffix = if truncated {
            ", older turns omitted"
        } else {
            ""
        };
        out.push_str(&format!(
            "\nRecent messages ({included}/{total}{suffix}):\n"
        ));
        if let Some(items) = messages.get("items").and_then(Value::as_array) {
            for item in items {
                let role = item.get("role").and_then(Value::as_str).unwrap_or("?");
                let body = item
                    .get("text")
                    .or_else(|| item.get("content"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let tools: Vec<&str> = item
                    .get("tools")
                    .and_then(Value::as_array)
                    .map(|array| array.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                out.push_str(&format!("- [{role}] {body}"));
                if !tools.is_empty() {
                    out.push_str(&format!(" (tools: {})", tools.join(", ")));
                }
                out.push('\n');
            }
        }
    }
    out
}
