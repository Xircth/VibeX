//! Ephemeral read-only SideChat (`conversation_side_chat_send` / `conversation_side_chat_abort`).
//!
//! # Architectural Invariant
//! SideChat turns and streaming events live strictly in memory on an unbound `AgentSessionId`.
//! They NEVER write rows to `sessions`, `conversation_turns`, `conversation_events`, or
//! `conversation_timeline_rows`, and they automatically cancel any mutating permission request.

use std::{path::PathBuf, time::Duration};

use agents::{
    AgentAutoApproveMode, AgentConnectionId, AgentContentBlock, AgentEvent, AgentId,
    AgentPermissionResponse, AgentPromptId, AgentSessionId,
    runtime::{
        CancelAgentPromptInput, EnsureAgentSessionInput, RespondAgentPermissionInput,
        SendAgentPromptInput,
    },
};
use application::ApplicationError;
use db::models::{conversation::ConversationAgentBindingRecord, session::Session};
use deployment::Deployment;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::broadcast::error::RecvError;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::domains::{ServerApplicationDomains, internal_error, parse, serialize};

const SIDE_CHAT_TIMEOUT_SECS: u64 = 180;
const SIDE_CHAT_CANCELLED_MESSAGE: &str = "Side Chat cancelled";

pub(crate) struct SideChatRun {
    pub generation: u64,
    pub cancel: CancellationToken,
    pub connection_id: Option<AgentConnectionId>,
    pub session_id: Option<AgentSessionId>,
    pub prompt_id: Option<AgentPromptId>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SideChatContextTurn {
    #[serde(default, alias = "turn_number")]
    turn_number: usize,
    #[serde(default, alias = "user_text")]
    user_text: String,
    #[serde(default, alias = "assistant_text")]
    assistant_text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SideChatHistoryMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendSideChatArgs {
    #[serde(alias = "conversation_id")]
    conversation_id: String,
    #[serde(alias = "side_chat_id")]
    side_chat_id: String,
    prompt: String,
    #[serde(default, alias = "context_turns")]
    context_turns: Vec<SideChatContextTurn>,
    #[serde(default)]
    history: Vec<SideChatHistoryMessage>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AbortSideChatArgs {
    #[serde(alias = "conversation_id")]
    conversation_id: String,
    #[serde(alias = "side_chat_id")]
    side_chat_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SideChatToolCallWire {
    id: String,
    name: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum SideChatStreamEventWire {
    Delta {
        text: String,
    },
    Tool {
        #[serde(rename = "toolCall")]
        tool_call: SideChatToolCallWire,
    },
    Done {
        content: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SendSideChatWireResponse {
    content: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tool_calls: Vec<SideChatToolCallWire>,
    events: Vec<SideChatStreamEventWire>,
}

fn unwrap_request(args: Value) -> Value {
    if let Some(inner) = args.get("request")
        && inner.is_object()
    {
        return inner.clone();
    }
    args
}

fn run_key(conversation_id: &str, side_chat_id: &str) -> String {
    format!("{}:{}", conversation_id.trim(), side_chat_id.trim())
}

async fn disconnect_side_chat_run(domains: &ServerApplicationDomains, run: &SideChatRun) {
    if let Some(connection_id) = run.connection_id {
        let _ = domains
            .conversations
            .agent_runtime
            .disconnect(connection_id)
            .await;
    }
}

async fn abort_side_chat_run(domains: &ServerApplicationDomains, run: SideChatRun) {
    run.cancel.cancel();
    if let (Some(connection_id), Some(session_id), Some(prompt_id)) =
        (run.connection_id, run.session_id, run.prompt_id)
    {
        let _ = domains
            .conversations
            .agent_runtime
            .cancel_prompt(CancelAgentPromptInput {
                connection_id,
                session_id,
                prompt_id,
            })
            .await;
    }
    disconnect_side_chat_run(domains, &run).await;
}

async fn begin_side_chat(
    domains: &ServerApplicationDomains,
    key: &str,
) -> (u64, CancellationToken) {
    let cancel = CancellationToken::new();
    let (generation, previous) = {
        let mut map = domains.side_chats.lock().await;
        let generation = map
            .get(key)
            .map(|existing| existing.generation.wrapping_add(1))
            .unwrap_or(1);
        let previous = map.insert(
            key.to_string(),
            SideChatRun {
                generation,
                cancel: cancel.clone(),
                connection_id: None,
                session_id: None,
                prompt_id: None,
            },
        );
        (generation, previous)
    };
    if let Some(previous) = previous {
        abort_side_chat_run(domains, previous).await;
    }
    (generation, cancel)
}

async fn bind_side_chat_run(
    domains: &ServerApplicationDomains,
    key: &str,
    generation: u64,
    connection_id: AgentConnectionId,
    session_id: AgentSessionId,
    prompt_id: Option<AgentPromptId>,
) {
    let mut map = domains.side_chats.lock().await;
    if let Some(run) = map.get_mut(key)
        && run.generation == generation
    {
        run.connection_id = Some(connection_id);
        run.session_id = Some(session_id);
        run.prompt_id = prompt_id;
    }
}

async fn finish_side_chat_run(
    domains: &ServerApplicationDomains,
    key: &str,
    generation: u64,
) -> Option<SideChatRun> {
    let mut map = domains.side_chats.lock().await;
    if map
        .get(key)
        .is_some_and(|existing| existing.generation == generation)
    {
        map.remove(key)
    } else {
        None
    }
}

fn build_side_chat_prompt(input: &SendSideChatArgs) -> String {
    let mut sections = Vec::new();
    sections.push(
        "You are answering an ephemeral, read-only Side Chat question alongside the user's main coding thread.\n\
         Rules:\n\
         - Do NOT modify, create, or delete any files, and do NOT run mutating shell/git commands.\n\
         - You may read files or inspect context if needed to answer accurately.\n\
         - Keep your response focused, concise, and directly actionable."
            .to_string(),
    );

    if !input.context_turns.is_empty() {
        let mut ctx_lines = vec!["<main-thread-context>".to_string()];
        for turn in &input.context_turns {
            ctx_lines.push(format!("--- Main Thread Turn {} ---", turn.turn_number));
            if !turn.user_text.trim().is_empty() {
                ctx_lines.push(format!("User: {}", turn.user_text.trim()));
            }
            if !turn.assistant_text.trim().is_empty() {
                ctx_lines.push(format!("Assistant: {}", turn.assistant_text.trim()));
            }
        }
        ctx_lines.push("</main-thread-context>".to_string());
        sections.push(ctx_lines.join("\n"));
    }

    if !input.history.is_empty() {
        let mut hist_lines = vec!["<side-chat-history>".to_string()];
        for msg in &input.history {
            let role = if msg.role.eq_ignore_ascii_case("assistant") {
                "Assistant"
            } else {
                "User"
            };
            if !msg.content.trim().is_empty() {
                hist_lines.push(format!("{role}: {}", msg.content.trim()));
            }
        }
        hist_lines.push("</side-chat-history>".to_string());
        sections.push(hist_lines.join("\n"));
    }

    sections.push(format!("Side Chat Question:\n{}", input.prompt.trim()));
    sections.join("\n\n")
}

async fn resolve_side_chat_target(
    domains: &ServerApplicationDomains,
    conversation_id_raw: &str,
) -> Result<(AgentId, PathBuf), ApplicationError> {
    let reader_pool = domains.reader_pool();
    if let Ok(conv_id) = Uuid::parse_str(conversation_id_raw.trim()) {
        if let Some(binding) =
            ConversationAgentBindingRecord::latest_for_conversation(reader_pool, conv_id)
                .await
                .map_err(internal_error)?
            && let Ok(agent_id) = AgentId::parse(binding.agent_id.as_str())
        {
            let dir = PathBuf::from(&binding.working_dir);
            let working_dir = if !binding.working_dir.trim().is_empty() && dir.is_dir() {
                dir
            } else {
                utils::path::vibex_scratch_subdir("side-chat").map_err(internal_error)?
            };
            return Ok((agent_id, working_dir));
        }

        if let Some(session) = Session::find_by_id(reader_pool, conv_id)
            .await
            .map_err(internal_error)?
            && let Some(executor) = session.executor.as_deref()
            && let Ok(agent_id) = AgentId::parse(executor)
        {
            let working_dir =
                utils::path::vibex_scratch_subdir("side-chat").map_err(internal_error)?;
            return Ok((agent_id, working_dir));
        }
    }

    let config = domains.deployment.config().read().await.clone();
    let trimmed_fallback = config.prompt_enhancement_agent_id.trim();
    let fallback_raw = if trimmed_fallback.is_empty() {
        "claude-code"
    } else {
        trimmed_fallback
    };
    let agent_id = AgentId::parse(fallback_raw)
        .or_else(|_| AgentId::parse("claude-code"))
        .map_err(internal_error)?;
    let working_dir = utils::path::vibex_scratch_subdir("side-chat").map_err(internal_error)?;
    Ok((agent_id, working_dir))
}

fn normalize_tool_status(raw: Option<&str>) -> String {
    match raw.unwrap_or("running").trim().to_ascii_lowercase().as_str() {
        "completed" | "done" | "succeeded" | "success" => "completed".to_string(),
        "failed" | "error" | "cancelled" | "canceled" => "failed".to_string(),
        _ => "running".to_string(),
    }
}

pub(crate) async fn send(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let input: SendSideChatArgs = parse(unwrap_request(args))?;
    if input.prompt.trim().is_empty() {
        return Err(ApplicationError::bad_request(
            "Side Chat prompt must not be empty",
        ));
    }

    let key = run_key(&input.conversation_id, &input.side_chat_id);
    let (agent_id, working_dir) = resolve_side_chat_target(domains, &input.conversation_id).await?;
    let launch =
        conversations::resolve_agent_runtime_launch_settings(domains.writer_pool(), &agent_id)
            .await
            .map_err(internal_error)?;

    let runtime = &domains.conversations.agent_runtime;
    let (generation, cancel) = begin_side_chat(domains, &key).await;
    if cancel.is_cancelled() {
        return Err(ApplicationError::bad_request(SIDE_CHAT_CANCELLED_MESSAGE));
    }

    let events_rx = runtime.subscribe_events();
    let prepared = match runtime
        .prepare_session(EnsureAgentSessionInput {
            agent_id,
            launch_lock: launch.launch_lock,
            workspace_id: Uuid::nil(),
            working_dir,
            additional_directories: Vec::new(),
            session_id: AgentSessionId::new(),
            acp_session_id: String::new(),
            auto_approve_mode: AgentAutoApproveMode::Off,
            env: launch.env,
            preferences: Default::default(),
        })
        .await
    {
        Ok(prepared) => prepared,
        Err(err) => {
            let _ = finish_side_chat_run(domains, &key, generation).await;
            return Err(internal_error(err));
        }
    };

    let session = prepared.session;
    bind_side_chat_run(domains, &key, generation, session.connection_id, session.id, None).await;
    if cancel.is_cancelled() {
        if let Some(run) = finish_side_chat_run(domains, &key, generation).await {
            abort_side_chat_run(domains, run).await;
        } else {
            let _ = runtime.disconnect(session.connection_id).await;
        }
        return Err(ApplicationError::bad_request(SIDE_CHAT_CANCELLED_MESSAGE));
    }

    let prompt_text = build_side_chat_prompt(&input);
    let prompt_snapshot = match runtime
        .send_prompt(SendAgentPromptInput {
            connection_id: session.connection_id,
            session_id: session.id,
            blocks: vec![AgentContentBlock::Text { text: prompt_text }],
            mode_override: None,
            config_overrides: Vec::new(),
        })
        .await
    {
        Ok(snapshot) => snapshot,
        Err(err) => {
            if let Some(run) = finish_side_chat_run(domains, &key, generation).await {
                abort_side_chat_run(domains, run).await;
            } else {
                let _ = runtime.disconnect(session.connection_id).await;
            }
            return Err(internal_error(err));
        }
    };

    bind_side_chat_run(
        domains,
        &key,
        generation,
        session.connection_id,
        session.id,
        Some(prompt_snapshot.id),
    )
    .await;

    let outcome = tokio::select! {
        _ = cancel.cancelled() => Err(ApplicationError::bad_request(SIDE_CHAT_CANCELLED_MESSAGE)),
        res = collect_side_chat_stream(
            runtime,
            events_rx,
            session.id,
            session.connection_id,
        ) => res,
        _ = tokio::time::sleep(Duration::from_secs(SIDE_CHAT_TIMEOUT_SECS)) => {
            Err(ApplicationError::internal(format!(
                "Side Chat timed out after {SIDE_CHAT_TIMEOUT_SECS} seconds"
            )))
        }
    };

    let finished_run = finish_side_chat_run(domains, &key, generation).await;
    if let Some(run) = finished_run {
        disconnect_side_chat_run(domains, &run).await;
    } else {
        let _ = runtime.disconnect(session.connection_id).await;
    }

    serialize(outcome?)
}

async fn collect_side_chat_stream(
    runtime: &agents::runtime::AgentRuntime,
    mut events_rx: tokio::sync::broadcast::Receiver<agents::events::AgentEventEnvelope>,
    session_id: AgentSessionId,
    connection_id: AgentConnectionId,
) -> Result<SendSideChatWireResponse, ApplicationError> {
    let mut content = String::new();
    let mut tool_calls: Vec<SideChatToolCallWire> = Vec::new();
    let mut stream_events: Vec<SideChatStreamEventWire> = Vec::new();

    loop {
        let envelope = match events_rx.recv().await {
            Ok(env) => env,
            Err(RecvError::Lagged(_)) => continue,
            Err(RecvError::Closed) => {
                return Err(ApplicationError::internal(
                    "Side Chat failed: Agent event stream closed",
                ));
            }
        };

        if envelope.session_id != Some(session_id) {
            if envelope.connection_id == connection_id
                && let AgentEvent::Error { error } = envelope.event
            {
                return Err(ApplicationError::internal(format!(
                    "Side Chat Agent failed: {}",
                    error.message
                )));
            }
            continue;
        }

        match envelope.event {
            AgentEvent::MessageChunk {
                content: AgentContentBlock::Text { text },
            } => {
                if !text.is_empty() {
                    content.push_str(&text);
                    stream_events.push(SideChatStreamEventWire::Delta { text });
                }
            }
            AgentEvent::ToolCall { tool_call } => {
                let wire = SideChatToolCallWire {
                    id: tool_call.id,
                    name: tool_call.title.clone(),
                    status: normalize_tool_status(tool_call.status.as_deref()),
                    summary: tool_call.input_preview,
                };
                if let Some(existing) = tool_calls.iter_mut().find(|item| item.id == wire.id) {
                    *existing = wire.clone();
                } else {
                    tool_calls.push(wire.clone());
                }
                stream_events.push(SideChatStreamEventWire::Tool { tool_call: wire });
            }
            AgentEvent::ToolCallUpdate { update } => {
                let wire = if let Some(existing) =
                    tool_calls.iter_mut().find(|item| item.id == update.id)
                {
                    if let Some(title) = update.title {
                        existing.name = title;
                    }
                    if update.status.is_some() {
                        existing.status = normalize_tool_status(update.status.as_deref());
                    }
                    if update.content.is_some() {
                        existing.summary = update.content;
                    }
                    existing.clone()
                } else {
                    let created = SideChatToolCallWire {
                        id: update.id,
                        name: update.title.unwrap_or_else(|| "tool".to_string()),
                        status: normalize_tool_status(update.status.as_deref()),
                        summary: update.content,
                    };
                    tool_calls.push(created.clone());
                    created
                };
                stream_events.push(SideChatStreamEventWire::Tool { tool_call: wire });
            }
            AgentEvent::PermissionRequested { request } => {
                // SideChat is strictly read-only: reject mutating permission requests immediately.
                let _ = runtime
                    .respond_permission(RespondAgentPermissionInput {
                        connection_id,
                        permission_id: request.id,
                        response: AgentPermissionResponse::Cancelled,
                    })
                    .await;
            }
            AgentEvent::PromptFinished { .. } => {
                stream_events.push(SideChatStreamEventWire::Done {
                    content: content.clone(),
                });
                return Ok(SendSideChatWireResponse {
                    content,
                    tool_calls,
                    events: stream_events,
                });
            }
            AgentEvent::Error { error } => {
                return Err(ApplicationError::internal(format!(
                    "Side Chat Agent failed: {}",
                    error.message
                )));
            }
            _ => {}
        }
    }
}

pub(crate) async fn abort(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let input: AbortSideChatArgs = parse(unwrap_request(args))?;
    let key = run_key(&input.conversation_id, &input.side_chat_id);
    let removed = domains.side_chats.lock().await.remove(&key);
    if let Some(run) = removed {
        abort_side_chat_run(domains, run).await;
    }
    Ok(Value::Null)
}
