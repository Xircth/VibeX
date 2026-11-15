//! IM inbound slash-command, callback-query, and session-selection handlers
//! extracted from `chat_inbound.rs` along the command-dispatch seam.

use agents::conversation::ConversationEvent;
use conversations::{ConversationContext, ConversationEventAppender, ConversationSessionService};
use db::models::{
    conversation::{ConversationRecord, CreateConversationRecord},
    conversation_event::AppendConversationEvent,
};
use serde_json::{Value, json};
use services::services::chat_delivery::load_channel_tokens;
use sqlx::SqlitePool;
use uuid::Uuid;

use super::{
    agent_bridge, connection_states, folder_bridge, is_sender_authorized, load_store,
    selected_conversation, session_bridge, value_to_id,
};

pub(super) struct CommandReply {
    text: String,
    buttons: Vec<(String, String)>,
    thread_id: Option<String>,
}

impl CommandReply {
    fn text(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            buttons: Vec::new(),
            thread_id: None,
        }
    }

    fn with_buttons(mut self, buttons: Vec<(String, String)>) -> Self {
        self.buttons = buttons;
        self
    }

    fn with_thread(mut self, thread_id: impl Into<String>) -> Self {
        self.thread_id = Some(thread_id.into());
        self
    }

    pub(super) fn is_empty(&self) -> bool {
        self.text.trim().is_empty() && self.buttons.is_empty()
    }
}

pub(super) async fn telegram_send_reply(
    client: &reqwest::Client,
    bot_token: &str,
    chat_id: &str,
    thread_id: Option<&str>,
    reply: &CommandReply,
) {
    let mut payload = json!({ "chat_id": chat_id, "text": reply.text });
    if let Some(thread) = reply.thread_id.as_deref().or(thread_id) {
        payload["message_thread_id"] = json!(thread);
    }
    if !reply.buttons.is_empty() {
        let rows: Vec<Vec<Value>> = reply
            .buttons
            .chunks(2)
            .map(|chunk| {
                chunk
                    .iter()
                    .map(|(label, data)| json!({ "text": label, "callback_data": data }))
                    .collect()
            })
            .collect();
        payload["reply_markup"] = json!({ "inline_keyboard": rows });
    }
    let _ = client
        .post(format!(
            "https://api.telegram.org/bot{bot_token}/sendMessage"
        ))
        .json(&payload)
        .send()
        .await;
}

pub(super) async fn handle_telegram_callback(
    pool: &SqlitePool,
    conversations: &ConversationContext,
    client: &reqwest::Client,
    bot_token: &str,
    channel_id: &str,
    config: &Value,
    callback: &Value,
) {
    let callback_id = callback.get("id").and_then(Value::as_str).unwrap_or("");
    let data = callback.get("data").and_then(Value::as_str).unwrap_or("");
    let sender_id = callback
        .pointer("/from/id")
        .and_then(value_to_id)
        .unwrap_or_default();
    let chat_id = callback
        .pointer("/message/chat/id")
        .and_then(value_to_id)
        .unwrap_or_default();
    let thread_id = callback
        .pointer("/message/message_thread_id")
        .and_then(value_to_id);
    let _ = client
        .post(format!(
            "https://api.telegram.org/bot{bot_token}/answerCallbackQuery"
        ))
        .json(&json!({ "callback_query_id": callback_id }))
        .send()
        .await;
    let reply = dispatch_command_reply(
        pool,
        conversations,
        data,
        &sender_id,
        &chat_id,
        channel_id,
        "telegram",
        config,
    )
    .await;
    if reply.is_empty() {
        return;
    }
    telegram_send_reply(client, bot_token, &chat_id, thread_id.as_deref(), &reply).await;
}

fn help_text(prefix: &str) -> String {
    format!(
        "VibeX Host commands:\n\
         {prefix} folder [n|name]\n\
         {prefix} agent [n|id]\n\
         {prefix} task <text>\n\
         {prefix} sessions\n\
         {prefix} resume [n|id]\n\
         {prefix} cancel\n\
         {prefix} approve [always]\n\
         {prefix} deny\n\
         {prefix} answer [n|text]\n\
         {prefix} search <keyword>\n\
         {prefix} today\n\
         {prefix} status\n\
         {prefix} help"
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn dispatch_command(
    pool: &SqlitePool,
    conversations: &ConversationContext,
    text: &str,
    sender_id: &str,
    chat_id: &str,
    channel_id: &str,
    kind: &str,
    config: &Value,
) -> String {
    dispatch_command_reply(
        pool,
        conversations,
        text,
        sender_id,
        chat_id,
        channel_id,
        kind,
        config,
    )
    .await
    .text
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn dispatch_command_reply(
    pool: &SqlitePool,
    conversations: &ConversationContext,
    text: &str,
    sender_id: &str,
    chat_id: &str,
    channel_id: &str,
    kind: &str,
    config: &Value,
) -> CommandReply {
    if !is_sender_authorized(kind, config, sender_id, chat_id) {
        return CommandReply::text(String::new());
    }
    let store = load_store().await.unwrap_or_default();
    let prefix = if store.command_prefix.trim().is_empty() {
        "/".to_string()
    } else {
        store.command_prefix
    };
    let Some(rest) = text.strip_prefix(&prefix) else {
        if text.starts_with("cb:") {
            return dispatch_callback(pool, conversations, text, sender_id, channel_id, &prefix)
                .await;
        }
        if selected_conversation(channel_id, sender_id).is_some() {
            return send_task(
                pool,
                conversations,
                channel_id,
                sender_id,
                chat_id,
                kind,
                config,
                text,
                &prefix,
            )
            .await;
        }
        return CommandReply::text(String::new());
    };
    let rest = rest.trim();
    let mut parts = rest.splitn(2, char::is_whitespace);
    let command = parts.next().unwrap_or("").to_lowercase();
    let args = parts.next().unwrap_or("").trim();
    match command.as_str() {
        "" | "help" | "start" => CommandReply::text(help_text(&prefix)).with_buttons(vec![
            ("Approve".into(), "cb:p:once".into()),
            ("Deny".into(), "cb:p:deny".into()),
        ]),
        "ping" => CommandReply::text(if store.message_language.starts_with("zh") {
            "VibeX Host 在线"
        } else {
            "VibeX Host online"
        }),
        "status" => CommandReply::text(channel_status_text().await),
        "conversations" | "sessions" | "ls" => CommandReply::text(list_conversations(pool).await),
        "use" | "resume" => CommandReply::text(
            select_conversation(pool, channel_id, sender_id, args, &prefix).await,
        ),
        "folder" => select_folder(pool, channel_id, sender_id, args, &prefix).await,
        "agent" => select_agent(pool, channel_id, sender_id, args, &prefix).await,
        "search" => CommandReply::text(search_conversations(pool, args, &prefix).await),
        "today" => CommandReply::text(today_conversations(pool).await),
        "task" | "do" | "ask" => {
            send_task(
                pool,
                conversations,
                channel_id,
                sender_id,
                chat_id,
                kind,
                config,
                args,
                &prefix,
            )
            .await
        }
        "approve" | "allow" => {
            let intent = if args.eq_ignore_ascii_case("always") {
                agents::RemotePermissionIntent::ApproveAlways
            } else {
                agents::RemotePermissionIntent::ApproveOnce
            };
            CommandReply::text(
                respond_permission(pool, conversations, channel_id, sender_id, intent, &prefix)
                    .await,
            )
        }
        "deny" | "reject" => CommandReply::text(
            respond_permission(
                pool,
                conversations,
                channel_id,
                sender_id,
                agents::RemotePermissionIntent::Deny,
                &prefix,
            )
            .await,
        ),
        "cancel" | "stop" => CommandReply::text(
            cancel_turn(pool, conversations, channel_id, sender_id, &prefix).await,
        ),
        "answer" => CommandReply::text(
            answer_question(pool, conversations, channel_id, sender_id, args, &prefix).await,
        ),
        _ => CommandReply::text(format!("unknown command; {prefix} help")),
    }
}

async fn dispatch_callback(
    pool: &SqlitePool,
    conversations: &ConversationContext,
    text: &str,
    sender_id: &str,
    channel_id: &str,
    prefix: &str,
) -> CommandReply {
    let Some(payload) = text.strip_prefix("cb:") else {
        return CommandReply::text(String::new());
    };
    let mut parts = payload.splitn(2, ':');
    let kind = parts.next().unwrap_or("");
    let value = parts.next().unwrap_or("");
    match kind {
        "f" => select_folder(pool, channel_id, sender_id, value, prefix).await,
        "a" => select_agent(pool, channel_id, sender_id, value, prefix).await,
        "p" if value == "deny" => CommandReply::text(
            respond_permission(
                pool,
                conversations,
                channel_id,
                sender_id,
                agents::RemotePermissionIntent::Deny,
                prefix,
            )
            .await,
        ),
        "p" => {
            let intent = if value == "always" {
                agents::RemotePermissionIntent::ApproveAlways
            } else {
                agents::RemotePermissionIntent::ApproveOnce
            };
            CommandReply::text(
                respond_permission(pool, conversations, channel_id, sender_id, intent, prefix)
                    .await,
            )
        }
        "q" => CommandReply::text(
            answer_question(pool, conversations, channel_id, sender_id, value, prefix).await,
        ),
        _ => CommandReply::text(String::new()),
    }
}

async fn list_conversations(pool: &SqlitePool) -> String {
    match recent_conversations(pool).await {
        Ok(rows) if rows.is_empty() => "No conversations on this Host.".to_string(),
        Ok(rows) => format_conversation_list(&rows),
        Err(error) => format!("failed to list conversations: {error}"),
    }
}

fn format_conversation_list(rows: &[ConversationRow]) -> String {
    rows.iter()
        .enumerate()
        .map(|(index, row)| {
            format!(
                "{}. {} · {}",
                index + 1,
                row.title.clone().unwrap_or_else(|| "untitled".into()),
                &row.id.to_string()[..8]
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[derive(sqlx::FromRow)]
struct ConversationRow {
    id: Uuid,
    workspace_id: Uuid,
    title: Option<String>,
    agent_type: Option<String>,
}

const CONVERSATION_SELECT: &str = r#"SELECT s.id, s.workspace_id, s.name AS title, COALESCE(s.agent_id, b.agent_type) AS agent_type
           FROM sessions s
           LEFT JOIN conversation_agent_bindings b
             ON b.conversation_id = s.id
           WHERE s.deleted_at IS NULL"#;

async fn recent_conversations(pool: &SqlitePool) -> Result<Vec<ConversationRow>, sqlx::Error> {
    sqlx::query_as::<_, ConversationRow>(&format!(
        "{CONVERSATION_SELECT}
           ORDER BY s.updated_at DESC, s.created_at DESC
           LIMIT 10"
    ))
    .fetch_all(pool)
    .await
}

fn resolve_conversation<'a>(
    rows: &'a [ConversationRow],
    args: &str,
) -> Result<Option<&'a ConversationRow>, usize> {
    let needle = args.trim();
    if needle.is_empty() {
        return Ok(None);
    }
    if let Ok(index) = needle.parse::<usize>() {
        return rows
            .get(index.saturating_sub(1))
            .map(Some)
            .ok_or(rows.len());
    }
    let lowered = needle.to_lowercase();
    Ok(rows.iter().find(|row| {
        let id = row.id.to_string();
        id.eq_ignore_ascii_case(needle) || id.to_lowercase().starts_with(&lowered)
    }))
}

async fn select_conversation(
    pool: &SqlitePool,
    channel_id: &str,
    sender_id: &str,
    args: &str,
    prefix: &str,
) -> String {
    let Ok(rows) = recent_conversations(pool).await else {
        return "failed to list conversations".to_string();
    };
    if args.trim().is_empty() {
        return if rows.is_empty() {
            "No conversations on this Host.".to_string()
        } else {
            format!(
                "{}\nusage: {prefix} resume [n|id]",
                format_conversation_list(&rows)
            )
        };
    }
    let row = match resolve_conversation(&rows, args) {
        Ok(Some(row)) => row,
        Ok(None) => {
            if let Ok(id) = Uuid::parse_str(args.trim()) {
                match sqlx::query_as::<_, ConversationRow>(&format!(
                    "{CONVERSATION_SELECT} AND s.id = ?"
                ))
                .bind(id)
                .fetch_optional(pool)
                .await
                {
                    Ok(Some(found)) => {
                        if let Ok(mut bridge) = session_bridge().lock() {
                            bridge.insert(
                                (channel_id.to_string(), sender_id.to_string()),
                                found.id.to_string(),
                            );
                        }
                        return format!(
                            "selected {} · {}",
                            found.title.clone().unwrap_or_else(|| "untitled".into()),
                            &found.id.to_string()[..8]
                        );
                    }
                    _ => return "conversation not found".to_string(),
                }
            }
            return format!("usage: {prefix} resume [n|id]");
        }
        Err(count) => {
            return format!("index out of range; {count} conversations");
        }
    };
    if let Ok(mut bridge) = session_bridge().lock() {
        bridge.insert(
            (channel_id.to_string(), sender_id.to_string()),
            row.id.to_string(),
        );
    }
    format!(
        "selected {} · {}",
        row.title.clone().unwrap_or_else(|| "untitled".into()),
        &row.id.to_string()[..8]
    )
}

async fn channel_status_text() -> String {
    let store = load_store().await.unwrap_or_default();
    let states = connection_states()
        .lock()
        .ok()
        .map(|map| map.clone())
        .unwrap_or_default();
    if store.channels.is_empty() {
        return "No chat channels on this Host.".to_string();
    }
    store
        .channels
        .into_iter()
        .map(|channel| {
            let state = states.get(&channel.id).cloned().unwrap_or_else(|| {
                if channel.enabled {
                    "disconnected".into()
                } else {
                    "disabled".into()
                }
            });
            format!("• {} [{}] {state}", channel.id, channel.kind)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

async fn search_conversations(pool: &SqlitePool, args: &str, prefix: &str) -> String {
    let keyword = args.trim();
    if keyword.is_empty() {
        return format!("usage: {prefix} search <keyword>");
    }
    let pattern = format!("%{keyword}%");
    match sqlx::query_as::<_, ConversationRow>(&format!(
        "{CONVERSATION_SELECT}
           AND (s.name LIKE ? OR CAST(s.id AS TEXT) LIKE ?)
           ORDER BY s.updated_at DESC, s.created_at DESC
           LIMIT 10"
    ))
    .bind(&pattern)
    .bind(&pattern)
    .fetch_all(pool)
    .await
    {
        Ok(matched) if matched.is_empty() => {
            format!("No conversations matching `{keyword}`.")
        }
        Ok(matched) => format_conversation_list(&matched),
        Err(error) => format!("search failed: {error}"),
    }
}

pub(super) async fn today_conversations(pool: &SqlitePool) -> String {
    match sqlx::query_as::<_, ConversationRow>(&format!(
        "{CONVERSATION_SELECT}
           AND date(s.created_at) = date('now')
           ORDER BY s.created_at DESC
           LIMIT 20"
    ))
    .fetch_all(pool)
    .await
    {
        Ok(rows) if rows.is_empty() => "No conversations created today.".to_string(),
        Ok(rows) => format!(
            "Today ({})\n{}",
            chrono::Utc::now().date_naive(),
            format_conversation_list(&rows)
        ),
        Err(error) => format!("failed to list today: {error}"),
    }
}

async fn recent_projects(pool: &SqlitePool) -> Result<Vec<(Uuid, String)>, sqlx::Error> {
    sqlx::query_as::<_, (Uuid, String)>(
        r#"SELECT id, name FROM projects ORDER BY updated_at DESC, created_at DESC LIMIT 10"#,
    )
    .fetch_all(pool)
    .await
}

async fn select_folder(
    pool: &SqlitePool,
    channel_id: &str,
    sender_id: &str,
    args: &str,
    prefix: &str,
) -> CommandReply {
    let Ok(projects) = recent_projects(pool).await else {
        return CommandReply::text("failed to list projects");
    };
    if args.trim().is_empty() {
        if projects.is_empty() {
            return CommandReply::text("No projects on this Host.");
        }
        let text = projects
            .iter()
            .enumerate()
            .map(|(index, (_, name))| format!("{}. {name}", index + 1))
            .collect::<Vec<_>>()
            .join("\n");
        let buttons = projects
            .iter()
            .enumerate()
            .take(8)
            .map(|(index, (_, name))| {
                let label = if name.chars().count() > 20 {
                    format!(
                        "{}. {}…",
                        index + 1,
                        name.chars().take(18).collect::<String>()
                    )
                } else {
                    format!("{}. {name}", index + 1)
                };
                (label, format!("cb:f:{}", index + 1))
            })
            .collect();
        return CommandReply::text(text).with_buttons(buttons);
    }
    let Some(project) = resolve_project(&projects, args) else {
        return CommandReply::text(format!("usage: {prefix} folder <n|name>"));
    };
    if let Ok(mut bridge) = folder_bridge().lock() {
        bridge.insert((channel_id.to_string(), sender_id.to_string()), project.0);
    }
    CommandReply::text(format!("selected project {}", project.1))
}

fn resolve_project<'a>(projects: &'a [(Uuid, String)], args: &str) -> Option<&'a (Uuid, String)> {
    if let Ok(index) = args.trim().parse::<usize>() {
        return projects.get(index.saturating_sub(1));
    }
    let needle = args.trim().to_lowercase();
    projects
        .iter()
        .find(|(_, name)| name.to_lowercase() == needle)
        .or_else(|| {
            projects
                .iter()
                .find(|(_, name)| name.to_lowercase().contains(&needle))
        })
}

#[derive(Clone)]
struct AgentChoice {
    id: String,
    label: String,
}

async fn recent_agents(pool: &SqlitePool) -> Result<Vec<AgentChoice>, sqlx::Error> {
    let members = sqlx::query_as::<_, (String, Option<String>)>(
        r#"SELECT agent_id, json_extract(retained_metadata_json, '$.name')
           FROM agent_membership
           WHERE retired = 0 AND enabled = 1
           ORDER BY position ASC, agent_id ASC
           LIMIT 20"#,
    )
    .fetch_all(pool)
    .await?;
    if !members.is_empty() {
        return Ok(members
            .into_iter()
            .map(|(id, name)| {
                let label = match name {
                    Some(display) if !display.trim().is_empty() => display,
                    _ => id.clone(),
                };
                AgentChoice { id, label }
            })
            .collect());
    }
    let rows = sqlx::query_scalar::<_, Option<String>>(
        r#"SELECT DISTINCT COALESCE(s.agent_id, b.agent_type)
           FROM sessions s
           LEFT JOIN conversation_agent_bindings b ON b.conversation_id = s.id
           WHERE s.deleted_at IS NULL
           ORDER BY s.updated_at DESC
           LIMIT 20"#,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .flatten()
        .filter(|id| !id.is_empty())
        .map(|id| AgentChoice {
            label: id.clone(),
            id,
        })
        .collect())
}

async fn select_agent(
    pool: &SqlitePool,
    channel_id: &str,
    sender_id: &str,
    args: &str,
    prefix: &str,
) -> CommandReply {
    let Ok(agents) = recent_agents(pool).await else {
        return CommandReply::text("failed to list agents");
    };
    if args.trim().is_empty() {
        if agents.is_empty() {
            return CommandReply::text("No Agent bindings on this Host.");
        }
        let text = agents
            .iter()
            .enumerate()
            .map(|(index, agent)| format!("{}. {}", index + 1, agent.label))
            .collect::<Vec<_>>()
            .join("\n");
        let buttons = agents
            .iter()
            .enumerate()
            .take(8)
            .map(|(index, agent)| {
                (
                    format!("{}. {}", index + 1, agent.label),
                    format!("cb:a:{}", index + 1),
                )
            })
            .collect();
        return CommandReply::text(text).with_buttons(buttons);
    }
    let selected = if let Ok(index) = args.trim().parse::<usize>() {
        agents.get(index.saturating_sub(1)).cloned()
    } else {
        let needle = args.trim().to_lowercase();
        agents
            .iter()
            .find(|agent| {
                agent.id.to_lowercase() == needle
                    || agent.label.to_lowercase() == needle
                    || agent.id.to_lowercase().contains(&needle)
                    || agent.label.to_lowercase().contains(&needle)
            })
            .cloned()
    };
    let Some(selected) = selected else {
        return CommandReply::text(format!("usage: {prefix} agent <n|id>"));
    };
    let agent_id = selected.id;
    if agents::AgentId::parse(&agent_id).is_err() {
        return CommandReply::text(format!("invalid agent id: {agent_id}"));
    }
    if let Ok(mut bridge) = agent_bridge().lock() {
        bridge.insert(
            (channel_id.to_string(), sender_id.to_string()),
            agent_id.clone(),
        );
    }
    CommandReply::text(format!("selected agent {agent_id}"))
}

async fn latest_workspace_for_project(
    pool: &SqlitePool,
    project_id: Uuid,
) -> Result<Option<Uuid>, sqlx::Error> {
    sqlx::query_scalar::<_, Uuid>(
        r#"SELECT id FROM workspaces
           WHERE project_id = ? AND archived = 0
           ORDER BY updated_at DESC, created_at DESC
           LIMIT 1"#,
    )
    .bind(project_id)
    .fetch_optional(pool)
    .await
}

#[allow(clippy::too_many_arguments)]
async fn send_task(
    pool: &SqlitePool,
    conversations: &ConversationContext,
    channel_id: &str,
    sender_id: &str,
    chat_id: &str,
    kind: &str,
    config: &Value,
    args: &str,
    prefix: &str,
) -> CommandReply {
    if args.trim().is_empty() {
        return CommandReply::text(format!("usage: {prefix} task <text>"));
    }
    let Ok(rows) = recent_conversations(pool).await else {
        return CommandReply::text("No conversation available on this Host.");
    };
    let selected = selected_conversation(channel_id, sender_id);
    let direct_selected = if let Some(id) = selected {
        if rows.iter().any(|row| row.id == id) {
            None
        } else {
            sqlx::query_as::<_, ConversationRow>(&format!("{CONVERSATION_SELECT} AND s.id = ?"))
                .bind(id)
                .fetch_optional(pool)
                .await
                .ok()
                .flatten()
        }
    } else {
        None
    };
    let existing = selected
        .and_then(|id| {
            rows.iter()
                .find(|row| row.id == id)
                .or(direct_selected.as_ref())
        })
        .or_else(|| {
            (selected.is_none() && rows.len() == 1)
                .then(|| rows.first())
                .flatten()
        });

    let selected_agent = agent_bridge().lock().ok().and_then(|bridge| {
        bridge
            .get(&(channel_id.to_string(), sender_id.to_string()))
            .cloned()
    });
    let folder_project = folder_bridge().lock().ok().and_then(|bridge| {
        bridge
            .get(&(channel_id.to_string(), sender_id.to_string()))
            .copied()
    });

    let (conversation_id, workspace_id, agent_id, created) = if let Some(target) = existing {
        let Some(agent_id) = selected_agent
            .as_deref()
            .or(target.agent_type.as_deref())
            .and_then(|value| agents::AgentId::parse(value).ok())
        else {
            return CommandReply::text(format!("select an agent with {prefix} agent <n>"));
        };
        let workspace_id = if let Some(project_id) = folder_project {
            latest_workspace_for_project(pool, project_id)
                .await
                .ok()
                .flatten()
                .unwrap_or(target.workspace_id)
        } else {
            target.workspace_id
        };
        (target.id, workspace_id, agent_id, false)
    } else {
        let Some(project_id) = folder_project else {
            return CommandReply::text(format!(
                "select a project with {prefix} folder <n> and an agent with {prefix} agent <n>"
            ));
        };
        let Some(workspace_id) = latest_workspace_for_project(pool, project_id)
            .await
            .ok()
            .flatten()
        else {
            return CommandReply::text(
                "this project has no workspace yet; open it in VibeX once, then retry",
            );
        };
        let Some(agent_id) = selected_agent
            .as_deref()
            .and_then(|value| agents::AgentId::parse(value).ok())
        else {
            return CommandReply::text(format!("select an agent with {prefix} agent <n>"));
        };
        let title = args
            .lines()
            .next()
            .unwrap_or(args)
            .chars()
            .take(80)
            .collect::<String>();
        let conversation_id = Uuid::new_v4();
        if let Err(error) = ConversationRecord::create(
            pool,
            conversation_id,
            CreateConversationRecord {
                workspace_id,
                task_id: None,
                title: Some(&title),
                initial_prompt: Some(args),
                status: None,
                executor: Some(agent_id.as_str()),
            },
        )
        .await
        {
            return CommandReply::text(format!("failed to create conversation: {error}"));
        }
        let _ = sqlx::query(
            "UPDATE sessions SET agent_id = ?, agent_type = ?, updated_at = datetime('now', 'subsec') WHERE id = ?",
        )
        .bind(agent_id.as_str())
        .bind(agent_id.as_str())
        .bind(conversation_id)
        .execute(pool)
        .await;
        if let Ok(mut bridge) = session_bridge().lock() {
            bridge.insert(
                (channel_id.to_string(), sender_id.to_string()),
                conversation_id.to_string(),
            );
        }
        let created_event = ConversationEvent::ConversationCreated {
            title: Some(title.clone()),
        };
        if let Ok(value) = serde_json::to_value(&created_event)
            && let Some(event_kind) = value.get("kind").and_then(Value::as_str)
            && let Ok(normalized_json) = serde_json::to_string(&created_event)
            && let Ok(record) = ConversationEventAppender::append(
                pool,
                AppendConversationEvent {
                    id: Uuid::new_v4(),
                    conversation_id,
                    turn_id: None,
                    binding_id: None,
                    connection_id: None,
                    prompt_id: None,
                    source: "host",
                    event_kind,
                    normalized_json: &normalized_json,
                    raw_json: None,
                    idempotency_key: Some(&format!("im-created:{conversation_id}")),
                },
            )
            .await
        {
            conversations.event_publisher.publish(&record).await;
        }
        (conversation_id, workspace_id, agent_id, true)
    };

    let mut reply_thread = None;
    let topic_mode = config
        .get("topic_mode")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if created && kind == "telegram" && topic_mode && !sender_id.contains(":topic:") {
        let tokens = load_channel_tokens(&[channel_id.to_string()]).await;
        if let Some(token) = tokens.get(channel_id) {
            let title = args.lines().next().unwrap_or(args);
            match services::services::chat_delivery::telegram_create_forum_topic(
                token, chat_id, title,
            )
            .await
            {
                Ok(thread_id) => {
                    let scoped = format!("{sender_id}:topic:{thread_id}");
                    if let Ok(mut bridge) = session_bridge().lock()
                        && let Some(value) = bridge
                            .get(&(channel_id.to_string(), sender_id.to_string()))
                            .cloned()
                    {
                        bridge.insert((channel_id.to_string(), scoped), value);
                    }
                    reply_thread = Some(thread_id.to_string());
                }
                Err(error) => {
                    tracing::warn!(%error, "failed to create Telegram topic");
                }
            }
        }
    }

    match ConversationSessionService::new(conversations.clone())
        .start_turn(conversations::ConversationStartTurnInput {
            continuation_policy: None,
            expected_binding_revision: None,
            agent_id,
            workspace_id,
            conversation_id,
            executor_profile_id: None,
            text: args.to_string(),
            display_text: None,
            images: Vec::new(),
            mode_override: None,
            config_overrides: Vec::new(),
            workflow_refs: Vec::new(),
            file_refs: Vec::new(),
            internal_prompt_contributions: Vec::new(),
            queued_input_claim: None,
            operation_id: None,
            collaboration_origin: None,
        })
        .await
    {
        Ok(_) => {
            let body = if created {
                format!(
                    "created {} and sent the task",
                    &conversation_id.to_string()[..8]
                )
            } else {
                format!("sent to {}", &conversation_id.to_string()[..8])
            };
            let mut reply = CommandReply::text(body);
            if let Some(thread) = reply_thread {
                reply = reply.with_thread(thread);
            }
            reply
        }
        Err(error) => CommandReply::text(format!("send failed: {error}")),
    }
}

async fn pending_question(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Option<agents::conversation::ConversationQuestionRequest> {
    let rows = sqlx::query_as::<_, (String, String)>(
        r#"SELECT event_kind, normalized_json
           FROM conversation_events
           WHERE conversation_id = ?
             AND event_kind IN ('question_requested', 'question_responded')
           ORDER BY sequence DESC
           LIMIT 8"#,
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await
    .ok()?;
    let latest = rows.first()?;
    if latest.0 != "question_requested" {
        return None;
    }
    match serde_json::from_str::<ConversationEvent>(&latest.1) {
        Ok(ConversationEvent::QuestionRequested { request }) => Some(request),
        _ => None,
    }
}

fn question_choices(request: &agents::conversation::ConversationQuestionRequest) -> Vec<String> {
    if !request.options.is_empty() {
        return request.options.clone();
    }
    let Some(schema) = &request.schema else {
        return Vec::new();
    };
    let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
        return Vec::new();
    };
    for property in properties.values() {
        if let Some(values) = property.get("enum").and_then(Value::as_array) {
            return values
                .iter()
                .filter_map(|value| value.as_str().map(ToString::to_string))
                .collect();
        }
    }
    Vec::new()
}

async fn answer_question(
    pool: &SqlitePool,
    conversations: &ConversationContext,
    channel_id: &str,
    sender_id: &str,
    args: &str,
    prefix: &str,
) -> String {
    let Some(conversation_id) = selected_conversation(channel_id, sender_id) else {
        return format!("select a conversation with {prefix} resume [n|id]");
    };
    let Some(request) = pending_question(pool, conversation_id).await else {
        return "No pending question.".to_string();
    };
    let trimmed = args.trim();
    if trimmed.is_empty() {
        return format!("usage: {prefix} answer <n|text>");
    }
    let choices = question_choices(&request);
    let selected = if let Ok(index) = trimmed.parse::<usize>() {
        choices.get(index.saturating_sub(1)).cloned()
    } else {
        None
    };
    let answer = selected.unwrap_or_else(|| trimmed.to_string());
    let content = if let Some(schema) = &request.schema
        && let Some(properties) = schema.get("properties").and_then(Value::as_object)
        && let Some(key) = properties.keys().next()
    {
        json!({ key: answer })
    } else {
        json!({ "answer": answer })
    };
    match ConversationSessionService::new(conversations.clone())
        .respond_question(
            conversation_id,
            request.question_id,
            agents::AgentElicitationResponse::Accept { content },
        )
        .await
    {
        Ok(()) => "answered".to_string(),
        Err(error) => format!("answer failed: {error}"),
    }
}

async fn respond_permission(
    pool: &SqlitePool,
    conversations: &ConversationContext,
    channel_id: &str,
    sender_id: &str,
    intent: agents::RemotePermissionIntent,
    prefix: &str,
) -> String {
    let Some(conversation_id) = selected_conversation(channel_id, sender_id) else {
        return format!("select a conversation with {prefix} use <n>");
    };
    let Ok(permissions) =
        db::models::conversation_side_effects::ConversationPermissionRecord::list_for_conversation(
            pool,
            conversation_id,
        )
        .await
    else {
        return "failed to read permission requests".to_string();
    };
    let Some(pending) = permissions
        .into_iter()
        .find(|record| record.status == "pending")
    else {
        return "No pending permission request.".to_string();
    };
    let options: Vec<agents::AgentPermissionOption> =
        serde_json::from_str(&pending.options_json).unwrap_or_default();
    let Some(response) = agents::decide_remote_permission_response(intent, &options) else {
        return "This permission has no approvable option; use the desktop.".to_string();
    };
    match ConversationSessionService::new(conversations.clone())
        .respond_permission(conversation_id, pending.permission_id, response)
        .await
    {
        Ok(()) => match intent {
            agents::RemotePermissionIntent::Deny => "denied".to_string(),
            _ => "approved".to_string(),
        },
        Err(error) => format!("permission response failed: {error}"),
    }
}

async fn cancel_turn(
    pool: &SqlitePool,
    conversations: &ConversationContext,
    channel_id: &str,
    sender_id: &str,
    prefix: &str,
) -> String {
    let Some(conversation_id) = selected_conversation(channel_id, sender_id) else {
        return format!("select a conversation with {prefix} use <n>");
    };
    let _ = pool;
    match ConversationSessionService::new(conversations.clone())
        .cancel_turn(
            conversation_id,
            Some("Cancelled from chat channel".to_string()),
        )
        .await
    {
        Ok(()) => "cancelled".to_string(),
        Err(error) => format!("cancel failed: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::{super::qq_ws_url, *};

    #[test]
    fn empty_config_authorizes_nobody() {
        assert!(!is_sender_authorized(
            "telegram",
            &json!({}),
            "12345",
            "12345"
        ));
    }

    #[test]
    fn topic_mode_ignores_plain_text_in_general_topic() {
        let config = json!({ "topic_mode": true });
        assert!(
            config
                .get("topic_mode")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        );
    }

    #[test]
    fn telegram_bound_chat_is_authorized() {
        assert!(is_sender_authorized(
            "telegram",
            &json!({ "chat_id": "555" }),
            "999",
            "555"
        ));
    }

    #[test]
    fn qq_bound_target_is_authorized() {
        assert!(is_sender_authorized(
            "qq",
            &json!({ "target_id": "group-42" }),
            "sender-1",
            "group-42"
        ));
        assert!(!is_sender_authorized(
            "qq",
            &json!({ "target_id": "group-42" }),
            "sender-1",
            "group-99"
        ));
    }

    #[test]
    fn feishu_explicit_sender_is_allowed() {
        assert!(is_sender_authorized(
            "feishu",
            &json!({ "chat_id": "oc-1", "authorized_senders": ["ou-9"] }),
            "ou-9",
            "other"
        ));
    }

    #[test]
    fn callback_payloads_stay_within_telegram_limit() {
        assert!("cb:f:8".to_string().len() < 64);
        assert!("cb:a:8".to_string().len() < 64);
        assert!("cb:p:always".to_string().len() < 64);
    }

    #[test]
    fn help_lists_the_full_command_surface() {
        let help = help_text("/");
        for command in [
            "folder [n|name]",
            "agent [n|id]",
            "task <text>",
            "sessions",
            "resume [n|id]",
            "cancel",
            "approve [always]",
            "deny",
            "answer [n|text]",
            "search <keyword>",
            "today",
            "status",
            "help",
        ] {
            assert!(help.contains(command), "{help} should list {command}");
        }
        assert!(!help.contains("ping"), "{help} should not advertise ping");
    }

    #[test]
    fn resolve_conversation_accepts_index_and_id_prefix() {
        let id = Uuid::parse_str("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee").unwrap();
        let rows = [ConversationRow {
            id,
            workspace_id: id,
            title: Some("demo".into()),
            agent_type: Some("claude-code".into()),
        }];
        assert_eq!(
            resolve_conversation(&rows, "1").unwrap().map(|row| row.id),
            Some(id)
        );
        assert_eq!(
            resolve_conversation(&rows, "aaaaaaaa")
                .unwrap()
                .map(|row| row.id),
            Some(id)
        );
        assert!(resolve_conversation(&rows, "2").is_err());
        assert!(resolve_conversation(&rows, "zzzz").unwrap().is_none());
    }

    #[test]
    fn qq_ws_url_derives_from_http_base() {
        assert_eq!(
            qq_ws_url(&json!({ "base_url": "http://127.0.0.1:5700" })),
            "ws://127.0.0.1:5700"
        );
        assert_eq!(
            qq_ws_url(&json!({ "ws_url": "wss://bot.example/ws" })),
            "wss://bot.example/ws"
        );
    }
}
