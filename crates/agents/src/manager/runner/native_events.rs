//! Stream event normalization (`ToolCall`, `ToolResult`, cumulative `TerminalOutputDelta`,
//! `PermissionRequested` with `ToolDetail` & non-interrupting `Deny`, `QuestionRequested`
//! elicitation bridge, `PlanUpdated`, `UsageUpdated`, `AssistantMessage` fallback, and
//! subagent updates) for `AgentConnectionRunner::run_native`.

use serde_json::{Map, Value, json};

use super::*;
use crate::{
    engine::{
        EngineEvent, EngineHandle, EnginePermissionDecision, NativeEngineDriver, NativeEngineKind,
        is_placeholder_engine_session_id,
    },
    events::AgentPlanEntry,
    idle_compaction::CacheTier,
    permissions::{AgentPermissionOption, AgentPermissionRequest, AgentPermissionResponse},
};

#[derive(Debug, Default)]
pub(in crate::manager) struct NativeTurnState {
    pub(in crate::manager) terminal_buffers: HashMap<String, String>,
    pub(in crate::manager) tool_names: HashMap<String, String>,
    pub(in crate::manager) streamed_assistant_text: bool,
    pub(in crate::manager) accumulated_usage: Option<AgentUsage>,
}

pub(in crate::manager) fn parse_cache_tier(tier: Option<&str>) -> CacheTier {
    match tier {
        Some(t) if t.eq_ignore_ascii_case("1h") || t.eq_ignore_ascii_case("one_hour") => {
            CacheTier::OneHour
        }
        _ => CacheTier::FiveMinute,
    }
}

fn classify_tool_kind_and_title(
    engine_kind: NativeEngineKind,
    raw_name: &str,
    input: &Value,
    parent_tool_use_id: Option<&str>,
) -> (String, String, Option<Value>) {
    let mut meta = Map::new();
    if let Some(mcp_rest) = raw_name.strip_prefix("mcp__") {
        let mut parts = mcp_rest.splitn(2, "__");
        let server = parts.next().unwrap_or("");
        let tool = parts.next().unwrap_or(mcp_rest);
        meta.insert(
            "mcp".to_string(),
            json!({
                "server": server,
                "tool": tool,
            }),
        );
        let title = if server.is_empty() {
            tool.to_string()
        } else {
            format!("{server} / {tool}")
        };
        return ("other".to_string(), title, Some(Value::Object(meta)));
    }

    if engine_kind == NativeEngineKind::ClaudeNative {
        let mut claude_meta = Map::new();
        claude_meta.insert("toolName".to_string(), Value::String(raw_name.to_string()));
        if let Some(parent_id) = parent_tool_use_id
            .filter(|s| !s.is_empty())
            .or_else(|| {
                input
                    .get("_parentToolUseId")
                    .or_else(|| input.get("parent_tool_use_id"))
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
            })
        {
            claude_meta.insert(
                "parentToolUseId".to_string(),
                Value::String(parent_id.to_string()),
            );
        }
        meta.insert("claudeCode".to_string(), Value::Object(claude_meta));
    }

    let (semantic_kind, display_title) = match raw_name {
        "Bash" | "commandExecution" | "shell" | "exec_command" => {
            let cmd = input
                .get("command")
                .and_then(|v| {
                    v.as_str().map(str::to_string).or_else(|| {
                        v.as_array().map(|arr| {
                            arr.iter()
                                .filter_map(Value::as_str)
                                .collect::<Vec<_>>()
                                .join(" ")
                        })
                    })
                })
                .or_else(|| input.get("description").and_then(Value::as_str).map(str::to_string))
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| raw_name.to_string());
            ("execute".to_string(), cmd)
        }
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" | "fileChange" | "apply_patch" => {
            let path = input
                .get("file_path")
                .or_else(|| input.get("notebook_path"))
                .or_else(|| input.get("path"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    input
                        .get("changes")
                        .and_then(Value::as_array)
                        .and_then(|arr| arr.first())
                        .and_then(|c| c.get("path").or_else(|| c.get("filePath")))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                });
            let title = match path {
                Some(p) if !p.is_empty() => format!("{raw_name} {p}"),
                _ => raw_name.to_string(),
            };
            ("edit".to_string(), title)
        }
        "Read" | "imageView" => {
            let path = input
                .get("file_path")
                .or_else(|| input.get("path"))
                .and_then(Value::as_str);
            let title = match path {
                Some(p) if !p.is_empty() => format!("Read {p}"),
                _ => raw_name.to_string(),
            };
            ("read".to_string(), title)
        }
        "Grep" | "Glob" | "ToolSearch" => {
            let pattern = input
                .get("pattern")
                .or_else(|| input.get("query"))
                .and_then(Value::as_str);
            let title = match pattern {
                Some(p) if !p.is_empty() => format!("{raw_name} {p}"),
                _ => raw_name.to_string(),
            };
            ("search".to_string(), title)
        }
        "WebFetch" | "WebSearch" | "webSearch" => {
            let target = input
                .get("url")
                .or_else(|| input.get("query"))
                .and_then(Value::as_str);
            let title = match target {
                Some(t) if !t.is_empty() => format!("{raw_name} {t}"),
                _ => raw_name.to_string(),
            };
            ("fetch".to_string(), title)
        }
        "TodoWrite" => ("think".to_string(), "Update Plan".to_string()),
        "Task" | "Agent" | "collabAgentToolCall" => {
            let desc = input
                .get("description")
                .or_else(|| input.get("prompt"))
                .and_then(Value::as_str)
                .map(|s| s.chars().take(80).collect::<String>())
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| "Subagent".to_string());
            ("other".to_string(), desc)
        }
        _ => ("other".to_string(), raw_name.to_string()),
    };

    let meta_val = (!meta.is_empty()).then_some(Value::Object(meta));
    (semantic_kind, display_title, meta_val)
}

fn format_file_change_diff_preview(input: &Value) -> Option<String> {
    let changes = input.get("changes")?.as_array()?;
    let mut sections = Vec::new();
    for change in changes {
        let path = change
            .get("path")
            .or_else(|| change.get("filePath"))
            .and_then(Value::as_str)
            .unwrap_or("file");
        if let Some(diff) = change
            .get("diff")
            .or_else(|| change.get("patch"))
            .and_then(Value::as_str)
            .filter(|d| !d.trim().is_empty())
        {
            sections.push(format!("--- {path}\n{diff}"));
        } else {
            let kind = change
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("modified");
            sections.push(format!("{kind}: {path}"));
        }
    }
    (!sections.is_empty()).then(|| sections.join("\n\n"))
}

fn format_tool_result_content(tool_name: Option<&str>, content: &Value) -> Option<String> {
    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }
    if tool_name == Some("fileChange")
        && let Some(diff) = format_file_change_diff_preview(content)
    {
        return Some(diff);
    }
    if let Some(obj) = content.as_object() {
        if let Some(out) = obj
            .get("aggregatedOutput")
            .or_else(|| obj.get("stdout"))
            .or_else(|| obj.get("output"))
            .or_else(|| obj.get("text"))
            .and_then(Value::as_str)
        {
            return Some(out.to_string());
        }
        if content.is_null() || obj.is_empty() {
            return None;
        }
    }
    if content.is_null() {
        None
    } else {
        Some(content.to_string())
    }
}

fn build_permission_details(
    engine_kind: NativeEngineKind,
    permission_id: &str,
    tool_name: &str,
    input: &Value,
    decision_reason: Option<&str>,
) -> Value {
    let (semantic_kind, title, _) = classify_tool_kind_and_title(engine_kind, tool_name, input, None);
    let mut details = Map::new();
    details.insert("kind".to_string(), Value::String(semantic_kind));
    details.insert("title".to_string(), Value::String(title));
    details.insert("toolName".to_string(), Value::String(tool_name.to_string()));
    if !permission_id.is_empty() {
        details.insert("toolCallId".to_string(), Value::String(permission_id.to_string()));
    }
    details.insert("rawInput".to_string(), input.clone());
    details.insert("input".to_string(), input.clone());
    if let Some(reason) = decision_reason.filter(|r| !r.trim().is_empty()) {
        details.insert("reason".to_string(), Value::String(reason.to_string()));
    }
    if let Some(diff) = format_file_change_diff_preview(input) {
        details.insert("content".to_string(), Value::String(diff));
    }
    Value::Object(details)
}

fn build_question_elicitation_payload(questions: &Value) -> (String, Value, Vec<(String, String)>) {
    let arr = questions.as_array().cloned().unwrap_or_default();
    let mut schema_items = Vec::new();
    let mut prompt_texts = Vec::new();
    // Maps `(question_id, question_text)` for encoding answers back to Claude vs Codex.
    let mut question_keys = Vec::new();

    for (idx, item) in arr.iter().enumerate() {
        let q_text = item
            .get("question")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let q_id = item
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                if q_text.is_empty() {
                    format!("q_{idx}")
                } else {
                    q_text.clone()
                }
            });
        let header = item
            .get("header")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| crate::ext_question::question_header(&q_text, idx));
        let multi_select = item
            .get("multiSelect")
            .or_else(|| item.get("isMultiSelect"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let options: Vec<Value> = item
            .get("options")
            .and_then(Value::as_array)
            .map(|opts| {
                opts.iter()
                    .filter_map(|opt| {
                        let label = opt
                            .get("label")
                            .and_then(Value::as_str)
                            .or_else(|| opt.as_str())?
                            .trim();
                        if label.is_empty() {
                            return None;
                        }
                        let mut o = Map::new();
                        o.insert("label".to_string(), Value::String(label.to_string()));
                        if let Some(desc) = opt
                            .get("description")
                            .and_then(Value::as_str)
                            .filter(|d| !d.trim().is_empty())
                        {
                            o.insert("description".to_string(), Value::String(desc.to_string()));
                        }
                        Some(Value::Object(o))
                    })
                    .collect()
            })
            .unwrap_or_default();

        if !q_text.is_empty() {
            prompt_texts.push(q_text.clone());
        }
        question_keys.push((q_id.clone(), q_text.clone()));
        schema_items.push(json!({
            "id": q_id,
            "header": header,
            "question": q_text,
            "multiSelect": multi_select,
            "options": options,
        }));
    }

    let prompt_refs: Vec<&str> = prompt_texts.iter().map(String::as_str).collect();
    let message = {
        let joined = crate::ext_question::prompt_from_texts(prompt_refs);
        if joined.is_empty() {
            "Agent requested user input".to_string()
        } else {
            joined
        }
    };
    let schema = crate::ext_question::question_schema(schema_items);
    (message, schema, question_keys)
}

fn encode_native_question_answers(
    kind: NativeEngineKind,
    content: &Value,
    question_keys: &[(String, String)],
) -> Value {
    let entries = crate::ext_question::answer_entries(content);
    let mut out = Map::new();

    for (raw_key, labels) in entries {
        let matched = question_keys
            .iter()
            .find(|(qid, qtext)| qid == &raw_key || qtext == &raw_key);
        match kind {
            NativeEngineKind::ClaudeNative => {
                let key = matched
                    .map(|(_, qtext)| {
                        if qtext.is_empty() {
                            raw_key.clone()
                        } else {
                            qtext.clone()
                        }
                    })
                    .unwrap_or(raw_key);
                out.insert(key, Value::String(labels.join(", ")));
            }
            NativeEngineKind::CodexNative => {
                let key = matched.map(|(qid, _)| qid.clone()).unwrap_or(raw_key);
                out.insert(key, json!({ "answers": labels }));
            }
        }
    }

    Value::Object(out)
}

impl AgentConnectionRunner {
    #[allow(clippy::too_many_arguments)]
    pub(in crate::manager) async fn handle_native_stream_event(
        &self,
        driver: &Arc<dyn NativeEngineDriver>,
        handle: &EngineHandle,
        kind: NativeEngineKind,
        custom_base_url: bool,
        requested_model: Option<&str>,
        session_id: AgentSessionId,
        prompt_id: AgentPromptId,
        event: EngineEvent,
        char_accumulator: &mut usize,
        turn_state: &mut NativeTurnState,
    ) -> bool {
        match event {
            EngineEvent::SessionInitialized {
                session_id: maybe_ext_id,
                model,
                slash_commands,
            } => {
                self.update_native_controls_from_session_init(
                    session_id,
                    model.as_deref(),
                    &slash_commands,
                )
                .await;
                if let Some(ext_id) = maybe_ext_id.filter(|s| !is_placeholder_engine_session_id(s))
                {
                    handle.set_external_session_id(Some(ext_id.clone()));
                    self.session_map
                        .write()
                        .await
                        .insert(session_id, ext_id.clone());
                    self.emit_session_linked(session_id, ext_id).await;
                }
                false
            }
            EngineEvent::AssistantTextDelta { text, .. } => {
                if !text.is_empty() {
                    turn_state.streamed_assistant_text = true;
                    *char_accumulator = char_accumulator.saturating_add(text.len());
                    self.emit(
                        Some(session_id),
                        Some(prompt_id),
                        AgentEvent::MessageChunk {
                            content: AgentContentBlock::Text { text },
                        },
                    );
                }
                false
            }
            EngineEvent::AssistantMessage { text, .. } => {
                if !turn_state.streamed_assistant_text && !text.is_empty() {
                    turn_state.streamed_assistant_text = true;
                    *char_accumulator = char_accumulator.saturating_add(text.len());
                    self.emit(
                        Some(session_id),
                        Some(prompt_id),
                        AgentEvent::MessageChunk {
                            content: AgentContentBlock::Text { text },
                        },
                    );
                }
                false
            }
            EngineEvent::ThinkingDelta { thinking, .. } => {
                if !thinking.is_empty() {
                    *char_accumulator = char_accumulator.saturating_add(thinking.len());
                    self.emit(
                        Some(session_id),
                        Some(prompt_id),
                        AgentEvent::ThoughtChunk {
                            content: AgentContentBlock::Text { text: thinking },
                        },
                    );
                }
                false
            }
            EngineEvent::ToolCall {
                parent_tool_use_id,
                tool_use_id,
                tool_name,
                input,
                ..
            } => {
                let id = tool_use_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                turn_state.tool_names.insert(id.clone(), tool_name.clone());
                let (semantic_kind, title, meta) = classify_tool_kind_and_title(
                    kind,
                    &tool_name,
                    &input,
                    parent_tool_use_id.as_deref(),
                );
                let content = if tool_name == "fileChange" {
                    format_file_change_diff_preview(&input)
                } else {
                    None
                };
                self.emit(
                    Some(session_id),
                    Some(prompt_id),
                    AgentEvent::ToolCall {
                        tool_call: AgentToolCall {
                            id,
                            title,
                            status: Some("in_progress".to_string()),
                            content,
                            kind: Some(semantic_kind),
                            input_preview: serde_json::to_string(&input).ok(),
                            meta,
                            images: Vec::new(),
                        },
                    },
                );
                false
            }
            EngineEvent::ToolResult {
                tool_use_id,
                is_error,
                content,
                ..
            } => {
                if let Some(id) = tool_use_id {
                    let tool_name = turn_state.tool_names.get(&id).map(String::as_str);
                    let formatted = format_tool_result_content(tool_name, &content)
                        .or_else(|| turn_state.terminal_buffers.get(&id).cloned());
                    self.emit(
                        Some(session_id),
                        Some(prompt_id),
                        AgentEvent::ToolCallUpdate {
                            update: AgentToolCallUpdate {
                                id,
                                title: None,
                                status: Some(if is_error {
                                    "failed".to_string()
                                } else {
                                    "completed".to_string()
                                }),
                                content: formatted,
                                input_preview: None,
                                meta: None,
                                images: Vec::new(),
                            },
                        },
                    );
                }
                false
            }
            EngineEvent::TerminalOutputDelta {
                call_id: Some(id),
                delta,
                ..
            } => {
                let buf = turn_state.terminal_buffers.entry(id.clone()).or_default();
                buf.push_str(&delta);
                let cumulative = buf.clone();
                self.emit(
                    Some(session_id),
                    Some(prompt_id),
                    AgentEvent::ToolCallUpdate {
                        update: AgentToolCallUpdate {
                            id,
                            title: None,
                            status: Some("in_progress".to_string()),
                            content: Some(cumulative),
                            input_preview: None,
                            meta: None,
                            images: Vec::new(),
                        },
                    },
                );
                false
            }
            EngineEvent::PermissionRequested {
                permission_id,
                tool_name,
                input,
                decision_reason,
                options: engine_options,
                ..
            } => {
                let perm_id = uuid::Uuid::parse_str(&permission_id)
                    .map(AgentPermissionId)
                    .unwrap_or_else(|_| AgentPermissionId::new());
                let options = if engine_options.is_empty() {
                    vec![
                        AgentPermissionOption {
                            id: "allow_once".to_string(),
                            label: "Allow".to_string(),
                            kind: crate::permissions::AgentPermissionOptionKind::AllowOnce,
                            description: None,
                        },
                        AgentPermissionOption {
                            id: "allow_always".to_string(),
                            label: "Always Allow".to_string(),
                            kind: crate::permissions::AgentPermissionOptionKind::AllowAlways,
                            description: None,
                        },
                        AgentPermissionOption {
                            id: "reject_once".to_string(),
                            label: "Deny".to_string(),
                            kind: crate::permissions::AgentPermissionOptionKind::RejectOnce,
                            description: None,
                        },
                    ]
                } else {
                    engine_options
                };
                let details = Some(build_permission_details(
                    kind,
                    &permission_id,
                    &tool_name,
                    &input,
                    decision_reason.as_deref(),
                ));
                let revision = self.allocate_permission_revision();
                let request = AgentPermissionRequest {
                    id: perm_id,
                    session_id,
                    title: tool_name,
                    details,
                    options: options.clone(),
                    revision,
                };

                let auto_mode = *self.auto_approve_mode.lock().await;
                if let Some(auto_resp) = decide_auto_permission_response(auto_mode, &request) {
                    let is_cancelled = matches!(auto_resp, AgentPermissionResponse::Cancelled);
                    let selected_id = match &auto_resp {
                        AgentPermissionResponse::Selected { option_id, .. } => {
                            Some(option_id.clone())
                        }
                        AgentPermissionResponse::Cancelled => None,
                    };
                    self.emit(
                        Some(session_id),
                        Some(prompt_id),
                        AgentEvent::PermissionRequested {
                            request: request.clone(),
                        },
                    );
                    self.emit(
                        Some(session_id),
                        Some(prompt_id),
                        AgentEvent::PermissionResponded {
                            permission_id: perm_id,
                            response: auto_resp,
                            auto: true,
                        },
                    );
                    let _ = driver
                        .respond_permission(
                            handle,
                            EnginePermissionDecision {
                                permission_id,
                                approved: !is_cancelled,
                                option_id: selected_id,
                                updated_input: None,
                                message: None,
                                interrupt: is_cancelled,
                            },
                        )
                        .await;
                } else {
                    let (tx, rx) = oneshot::channel();
                    self.pending_permissions.lock().await.insert(
                        perm_id.to_string(),
                        PendingPermission {
                            permission_id: perm_id,
                            session_id,
                            title: request.title.clone(),
                            details: request.details.clone(),
                            options: options.clone(),
                            revision,
                            tx,
                        },
                    );
                    self.emit(
                        Some(session_id),
                        Some(prompt_id),
                        AgentEvent::PermissionRequested { request },
                    );
                    let driver = Arc::clone(driver);
                    let handle = handle.clone();
                    tokio::spawn(async move {
                        if let Ok(resp) = rx.await {
                            let (approved, selected_option_id) = match resp {
                                AgentPermissionResponse::Selected { option_id, .. } => {
                                    let is_allow = options
                                        .iter()
                                        .find(|opt| opt.id == option_id)
                                        .map(|opt| opt.kind.is_allow())
                                        .unwrap_or_else(|| {
                                            matches!(
                                                option_id.as_str(),
                                                "allow"
                                                    | "allow_once"
                                                    | "allow_always"
                                                    | "accept"
                                                    | "acceptForSession"
                                            ) || option_id.contains("allow")
                                        });
                                    (is_allow, Some(option_id))
                                }
                                AgentPermissionResponse::Cancelled => (false, None),
                            };
                            let interrupt = selected_option_id.is_none();
                            let message = (!approved && !interrupt).then(|| {
                                "The user declined permission to run this tool.".to_string()
                            });
                            let _ = driver
                                .respond_permission(
                                    &handle,
                                    EnginePermissionDecision {
                                        permission_id,
                                        approved,
                                        option_id: selected_option_id,
                                        updated_input: None,
                                        message,
                                        interrupt,
                                    },
                                )
                                .await;
                        }
                    });
                }
                false
            }
            EngineEvent::QuestionRequested {
                request_id,
                questions,
                ..
            } => {
                let elicitation_id = AgentElicitationId::new();
                let (message, requested_schema, question_keys) =
                    build_question_elicitation_payload(&questions);
                let (tx, rx) = oneshot::channel();
                self.pending_elicitations.lock().await.insert(
                    elicitation_id.to_string(),
                    PendingElicitation {
                        elicitation_id,
                        session_id,
                        tx,
                    },
                );
                self.emit(
                    Some(session_id),
                    Some(prompt_id),
                    AgentEvent::ElicitationRequested {
                        request: AgentElicitationRequest {
                            id: elicitation_id,
                            session_id,
                            message,
                            requested_schema,
                        },
                    },
                );
                let driver = Arc::clone(driver);
                let handle = handle.clone();
                tokio::spawn(async move {
                    match rx.await {
                        Ok(AgentElicitationResponse::Accept { content }) => {
                            let encoded =
                                encode_native_question_answers(kind, &content, &question_keys);
                            let _ = driver
                                .respond_question(&handle, &request_id, encoded, false)
                                .await;
                        }
                        Ok(AgentElicitationResponse::Decline | AgentElicitationResponse::Cancel)
                        | Err(_) => {
                            let _ = driver
                                .respond_question(&handle, &request_id, json!({}), true)
                                .await;
                        }
                    }
                });
                false
            }
            EngineEvent::PlanUpdated { entries, .. } => {
                let plan_entries: Vec<AgentPlanEntry> = entries
                    .into_iter()
                    .map(|e| AgentPlanEntry {
                        content: e.content,
                        status: e.status,
                        priority: e.priority,
                    })
                    .collect();
                self.emit(
                    Some(session_id),
                    Some(prompt_id),
                    AgentEvent::Plan {
                        plan: AgentPlan {
                            entries: plan_entries,
                        },
                    },
                );
                false
            }
            EngineEvent::UsageUpdated {
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_write_tokens,
                cost_usd,
                context_window,
                model,
                ..
            } => {
                let prev = turn_state.accumulated_usage.take().unwrap_or_default();
                let next_in = input_tokens.or(prev.input_tokens);
                let next_out = output_tokens.or(prev.output_tokens);
                let next_cr = cache_read_tokens.or(prev.cache_read_tokens);
                let next_cw = cache_write_tokens.or(prev.cache_write_tokens);
                let sum = next_in.unwrap_or(0)
                    + next_out.unwrap_or(0)
                    + next_cr.unwrap_or(0)
                    + next_cw.unwrap_or(0);
                let computed_used = if sum > 0 { sum } else { prev.used };
                let usage = AgentUsage {
                    used: computed_used,
                    limit: context_window.or(prev.limit),
                    input_tokens: next_in,
                    output_tokens: next_out,
                    cache_read_tokens: next_cr,
                    cache_write_tokens: next_cw,
                    cost_amount: cost_usd.or(prev.cost_amount),
                    cost_currency: if cost_usd.is_some() {
                        Some("USD".to_string())
                    } else {
                        prev.cost_currency
                    },
                    model: model
                        .or(prev.model)
                        .or_else(|| requested_model.map(str::to_string)),
                };
                turn_state.accumulated_usage = Some(usage.clone());
                if let Ok(mut controls) = self.session_controls.try_write() {
                    controls.entry(session_id).or_default().last_turn_usage = Some(usage.clone());
                }
                self.emit(
                    Some(session_id),
                    Some(prompt_id),
                    AgentEvent::Usage { usage },
                );
                false
            }
            EngineEvent::SubagentSpawned {
                subagent_id,
                parent_tool_use_id,
                description,
                ..
            } => {
                let target_id = parent_tool_use_id.unwrap_or(subagent_id);
                if let Some(desc) = description.filter(|d| !d.trim().is_empty()) {
                    let meta = self
                        .append_subagent_chunk(&target_id, "text", &desc)
                        .await
                        .map(Value::Object);
                    self.emit(
                        Some(session_id),
                        Some(prompt_id),
                        AgentEvent::ToolCallUpdate {
                            update: AgentToolCallUpdate {
                                id: target_id,
                                title: Some(desc),
                                status: Some("in_progress".to_string()),
                                content: None,
                                input_preview: None,
                                meta,
                                images: Vec::new(),
                            },
                        },
                    );
                }
                false
            }
            EngineEvent::SubagentUpdated {
                subagent_id,
                text_delta,
                ..
            } => {
                if !text_delta.trim().is_empty() {
                    let meta = self
                        .append_subagent_chunk(&subagent_id, "text", &text_delta)
                        .await
                        .map(Value::Object);
                    self.emit(
                        Some(session_id),
                        Some(prompt_id),
                        AgentEvent::ToolCallUpdate {
                            update: AgentToolCallUpdate {
                                id: subagent_id,
                                title: None,
                                status: Some("in_progress".to_string()),
                                content: Some(text_delta),
                                input_preview: None,
                                meta,
                                images: Vec::new(),
                            },
                        },
                    );
                }
                false
            }
            EngineEvent::SubagentCompleted {
                subagent_id,
                status,
                summary,
                ..
            } => {
                let failed = status.eq_ignore_ascii_case("failed")
                    || status.eq_ignore_ascii_case("error");
                let meta = match summary.as_deref().filter(|s| !s.trim().is_empty()) {
                    Some(text) => self
                        .append_subagent_chunk(&subagent_id, "text", text)
                        .await
                        .map(Value::Object),
                    None => None,
                };
                self.emit(
                    Some(session_id),
                    Some(prompt_id),
                    AgentEvent::ToolCallUpdate {
                        update: AgentToolCallUpdate {
                            id: subagent_id,
                            title: None,
                            status: Some(if failed {
                                "failed".to_string()
                            } else {
                                "completed".to_string()
                            }),
                            content: summary,
                            input_preview: None,
                            meta,
                            images: Vec::new(),
                        },
                    },
                );
                false
            }
            EngineEvent::RateLimitsUpdated { rate_limits, .. } => {
                self.emit(
                    Some(session_id),
                    Some(prompt_id),
                    AgentEvent::SessionInfoUpdated {
                        patch: json!({ "rateLimits": rate_limits }),
                    },
                );
                false
            }
            EngineEvent::CacheStatusUpdated { cache_status, .. } => {
                if kind == NativeEngineKind::ClaudeNative {
                    self.idle_compaction.record_session_activity(
                        session_id.0,
                        Utc::now(),
                        (*char_accumulator) / 4,
                        parse_cache_tier(cache_status.cache_ttl_tier.as_deref()),
                        cache_status.prompt_cache_expires_at,
                        handle.official_session,
                    );
                }
                self.emit(
                    Some(session_id),
                    Some(prompt_id),
                    AgentEvent::SessionInfoUpdated {
                        patch: json!({ "cacheStatus": cache_status }),
                    },
                );
                false
            }
            EngineEvent::AutoCompactionChanged { in_progress, .. } => {
                self.emit(
                    Some(session_id),
                    Some(prompt_id),
                    AgentEvent::SessionInfoUpdated {
                        patch: json!({ "autoCompactionInProgress": in_progress }),
                    },
                );
                false
            }
            EngineEvent::TurnCompleted {
                stop_reason,
                served_model,
                ..
            } => {
                if kind == NativeEngineKind::ClaudeNative {
                    let cache = driver.cache_status(handle);
                    let tier = parse_cache_tier(
                        cache
                            .as_ref()
                            .and_then(|c| c.cache_ttl_tier.as_deref()),
                    );
                    let expires = cache
                        .and_then(|c| c.prompt_cache_expires_at)
                        .or_else(|| {
                            crate::idle_compaction::IdleCompaction::synthesize_cache_expiry(
                                Utc::now(),
                                tier,
                                handle.official_session,
                            )
                        });
                    self.idle_compaction.record_session_activity(
                        session_id.0,
                        Utc::now(),
                        (*char_accumulator) / 4,
                        tier,
                        expires,
                        handle.official_session,
                    );
                }
                let alias_targets = if kind == NativeEngineKind::ClaudeNative {
                    let mut merged_env = self.snapshot.launch_lock.env.clone();
                    merged_env.extend(self.snapshot.env.clone());
                    crate::end_turn_usage::collect_claude_model_aliases(&merged_env)
                } else {
                    HashMap::new()
                };
                if let Some(mismatch) =
                    crate::end_turn_usage::check_launch_vs_served_model_with_aliases(
                        requested_model,
                        served_model.as_deref(),
                        custom_base_url,
                        &alias_targets,
                    )
                {
                    self.emit(
                        Some(session_id),
                        Some(prompt_id),
                        AgentEvent::SessionInfoUpdated {
                            patch: json!({ "modelConsistencyWarning": mismatch }),
                        },
                    );
                }
                self.cancel_pending_interactions(session_id).await;
                *self.active_prompt.lock().await = None;
                self.emit(
                    Some(session_id),
                    Some(prompt_id),
                    AgentEvent::TurnCompleted {
                        stop_reason: stop_reason.clone(),
                    },
                );
                let final_usage = match (turn_state.accumulated_usage.take(), served_model) {
                    (Some(mut u), Some(m)) => {
                        if u.model.is_none() {
                            u.model = Some(m);
                        }
                        Some(u)
                    }
                    (Some(u), None) => Some(u),
                    (None, Some(m)) => Some(AgentUsage {
                        model: Some(m),
                        ..AgentUsage::default()
                    }),
                    (None, None) => None,
                };
                self.emit(
                    Some(session_id),
                    Some(prompt_id),
                    AgentEvent::PromptFinished {
                        finished: AgentPromptFinished {
                            prompt_id,
                            stop_reason: stop_reason.or_else(|| Some("end_turn".to_string())),
                            usage: final_usage,
                        },
                    },
                );
                true
            }
            EngineEvent::TurnInterrupted { .. } => {
                self.cancel_pending_interactions(session_id).await;
                *self.active_prompt.lock().await = None;
                self.emit(
                    Some(session_id),
                    Some(prompt_id),
                    AgentEvent::PromptFinished {
                        finished: AgentPromptFinished {
                            prompt_id,
                            stop_reason: Some("cancelled".to_string()),
                            usage: turn_state.accumulated_usage.take(),
                        },
                    },
                );
                true
            }
            EngineEvent::TurnError { message, .. } => {
                self.cancel_pending_interactions(session_id).await;
                self.fail_active_turn(session_id, prompt_id, AgentError::Runtime(message))
                    .await;
                true
            }
            _ => false,
        }
    }

    pub(in crate::manager) async fn forward_native_permission(
        &self,
        driver: &Arc<dyn NativeEngineDriver>,
        handle: &EngineHandle,
        permission_id: &str,
        response: AgentPermissionResponse,
    ) {
        if response.expected_revision().is_some()
            || self
                .pending_permissions
                .lock()
                .await
                .contains_key(permission_id)
        {
            self.respond_pending_permission(permission_id, response)
                .await;
        } else {
            let (approved, option_id) = match response {
                AgentPermissionResponse::Selected { option_id, .. } => {
                    let is_allow = matches!(
                        option_id.as_str(),
                        "allow" | "allow_once" | "allow_always" | "accept" | "acceptForSession"
                    ) || option_id.contains("allow");
                    (is_allow, Some(option_id))
                }
                AgentPermissionResponse::Cancelled => (false, None),
            };
            let interrupt = option_id.is_none();
            let message = (!approved && !interrupt)
                .then(|| "The user declined permission to run this tool.".to_string());
            let _ = driver
                .respond_permission(
                    handle,
                    EnginePermissionDecision {
                        permission_id: permission_id.to_string(),
                        approved,
                        option_id,
                        updated_input: None,
                        message,
                        interrupt,
                    },
                )
                .await;
        }
    }
}
