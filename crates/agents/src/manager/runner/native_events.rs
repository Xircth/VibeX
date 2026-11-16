//! Stream event normalization (`ToolCall`, `ToolResult`, cumulative `TerminalOutputDelta`,
//! `PermissionRequested` with `ToolDetail` & non-interrupting `Deny`, `QuestionRequested`
//! elicitation bridge, `PlanUpdated`, `UsageUpdated`, `AssistantMessage` fallback, and
//! subagent updates) for `AgentConnectionRunner::run_native`.

use serde_json::{Map, Value, json};

use super::*;
use crate::{
    engine::{
        EngineEvent, EngineHandle, EnginePermissionDecision, NativeEngineDriver,
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
    pub(in crate::manager) running_tool_calls: std::collections::HashSet<String>,
    pub(in crate::manager) streamed_assistant_text: bool,
    pub(in crate::manager) last_streamed_message_id: Option<String>,
    pub(in crate::manager) accumulated_usage: Option<AgentUsage>,
}

pub(in crate::manager) fn classify_native_turn_error(message: String) -> AgentError {
    let lower = message.to_ascii_lowercase();
    let is_auth = lower.contains("authentication_failed")
        || lower.contains("authentication_error")
        || lower.contains("invalid_api_key")
        || lower.contains("invalid x-api-key")
        || lower.contains("invalid api key")
        || lower.contains("not logged in")
        || lower.contains("please run /login")
        || lower.contains("login required")
        || lower.contains("401 unauthorized")
        || lower.contains("status 401")
        || lower.contains("http 401")
        || lower.contains("oauth token has expired")
        || lower.contains("token has expired");
    if is_auth {
        AgentError::AuthenticationRequired(message)
    } else {
        AgentError::Runtime(message)
    }
}

pub(in crate::manager) fn parse_cache_tier(tier: Option<&str>) -> CacheTier {
    match tier {
        Some(t) if t.eq_ignore_ascii_case("1h") || t.eq_ignore_ascii_case("one_hour") => {
            CacheTier::OneHour
        }
        _ => CacheTier::FiveMinute,
    }
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
    driver: &dyn NativeEngineDriver,
    permission_id: &str,
    tool_name: &str,
    input: &Value,
    decision_reason: Option<&str>,
) -> Value {
    let cls = driver.classify_tool_call(tool_name, input, None);
    let mut details = Map::new();
    details.insert("kind".to_string(), Value::String(cls.semantic_kind));
    details.insert("title".to_string(), Value::String(cls.title));
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
    // Maps `(question_id, question_text)` for encoding answers back via the active driver.
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

impl AgentConnectionRunner {
    #[allow(clippy::too_many_arguments)]
    pub(in crate::manager) async fn handle_native_stream_event(
        &self,
        driver: &Arc<dyn NativeEngineDriver>,
        handle: &EngineHandle,
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
            EngineEvent::AssistantTextDelta {
                message_id, text, ..
            } => {
                if !text.is_empty() {
                    turn_state.streamed_assistant_text = true;
                    if message_id.is_some() {
                        turn_state.last_streamed_message_id = message_id;
                    }
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
            EngineEvent::AssistantMessage {
                message_id, text, ..
            } => {
                let already_streamed_same_msg = turn_state.streamed_assistant_text
                    && match (&message_id, &turn_state.last_streamed_message_id) {
                        (Some(a), Some(b)) => a == b,
                        _ => true,
                    };
                if !already_streamed_same_msg && !text.is_empty() {
                    turn_state.streamed_assistant_text = true;
                    if message_id.is_some() {
                        turn_state.last_streamed_message_id = message_id;
                    }
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
                turn_state.streamed_assistant_text = false;
                turn_state.last_streamed_message_id = None;
                let id = tool_use_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                turn_state.tool_names.insert(id.clone(), tool_name.clone());
                turn_state.running_tool_calls.insert(id.clone());
                let cls = driver.classify_tool_call(
                    &tool_name,
                    &input,
                    parent_tool_use_id.as_deref(),
                );
                let frame_meta = cls.meta.as_ref().and_then(Value::as_object).cloned();
                let meta = self
                    .fold_air_tool_meta(&id, frame_meta, true)
                    .await
                    .map(Value::Object)
                    .or(cls.meta);
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
                            title: cls.title,
                            status: Some("in_progress".to_string()),
                            content,
                            kind: Some(cls.semantic_kind),
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
                turn_state.streamed_assistant_text = false;
                turn_state.last_streamed_message_id = None;
                if let Some(id) = tool_use_id {
                    turn_state.running_tool_calls.remove(&id);
                    let tool_name = turn_state.tool_names.get(&id).map(String::as_str);
                    let formatted = format_tool_result_content(tool_name, &content)
                        .or_else(|| turn_state.terminal_buffers.get(&id).cloned());
                    let meta = self
                        .fold_air_tool_meta(&id, None, false)
                        .await
                        .map(Value::Object);
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
                                meta,
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
                    &**driver,
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

                let force_manual = Self::is_plan_approval_tool(&request.title)
                    || self.is_session_in_plan_mode(session_id).await;
                let auto_resp = if force_manual {
                    None
                } else {
                    let auto_mode = *self.auto_approve_mode.lock().await;
                    decide_auto_permission_response(auto_mode, &request)
                };
                if let Some(auto_resp) = auto_resp {
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
                            let entries = crate::ext_question::answer_entries(&content);
                            let encoded = driver.encode_question_answers(&entries, &question_keys);
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
                context_used,
                is_turn_summary,
                cost_usd,
                context_window,
                model,
                ..
            } => {
                let prev = turn_state.accumulated_usage.take().unwrap_or_default();
                let (next_in, next_out, next_cr, next_cw, computed_used) = if is_turn_summary {
                    let ni = input_tokens.or(prev.input_tokens);
                    let no = output_tokens.or(prev.output_tokens);
                    let ncr = cache_read_tokens.or(prev.cache_read_tokens);
                    let ncw = cache_write_tokens.or(prev.cache_write_tokens);
                    let sum = ni.unwrap_or(0)
                        + no.unwrap_or(0)
                        + ncr.unwrap_or(0)
                        + ncw.unwrap_or(0);
                    let used = context_used.unwrap_or(if prev.used > 0 { prev.used } else { sum });
                    (ni, no, ncr, ncw, used)
                } else {
                    let is_partial_delta = input_tokens.is_none()
                        && cache_read_tokens.is_none()
                        && cache_write_tokens.is_none();
                    let (ni, no, ncr, ncw) = if is_partial_delta {
                        (
                            prev.input_tokens,
                            output_tokens.or(prev.output_tokens),
                            prev.cache_read_tokens,
                            prev.cache_write_tokens,
                        )
                    } else {
                        (
                            input_tokens,
                            output_tokens,
                            cache_read_tokens,
                            cache_write_tokens,
                        )
                    };
                    let sum = ni.unwrap_or(0)
                        + no.unwrap_or(0)
                        + ncr.unwrap_or(0)
                        + ncw.unwrap_or(0);
                    let used = context_used.unwrap_or(if sum > 0 { sum } else { prev.used });
                    (ni, no, ncr, ncw, used)
                };
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
                turn_state.running_tool_calls.insert(target_id.clone());
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
                parent_tool_use_id,
                text_delta,
                ..
            } => {
                let target_id = parent_tool_use_id.unwrap_or(subagent_id);
                if !text_delta.trim().is_empty() {
                    let meta = self
                        .append_subagent_chunk(&target_id, "text", &text_delta)
                        .await
                        .map(Value::Object);
                    self.emit(
                        Some(session_id),
                        Some(prompt_id),
                        AgentEvent::ToolCallUpdate {
                            update: AgentToolCallUpdate {
                                id: target_id,
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
                parent_tool_use_id,
                status,
                summary,
                ..
            } => {
                let target_id = parent_tool_use_id.unwrap_or(subagent_id);
                turn_state.running_tool_calls.remove(&target_id);
                let failed = status.eq_ignore_ascii_case("failed")
                    || status.eq_ignore_ascii_case("error");
                let meta = match summary.as_deref().filter(|s| !s.trim().is_empty()) {
                    Some(text) => self
                        .append_subagent_chunk(&target_id, "text", text)
                        .await
                        .map(Value::Object),
                    None => self
                        .fold_air_tool_meta(&target_id, None, false)
                        .await
                        .map(Value::Object),
                };
                self.emit(
                    Some(session_id),
                    Some(prompt_id),
                    AgentEvent::ToolCallUpdate {
                        update: AgentToolCallUpdate {
                            id: target_id,
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
                if driver.capabilities().records_idle_compaction_activity {
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
                if driver.capabilities().records_idle_compaction_activity {
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
                let mut merged_env: HashMap<String, String> = self
                    .snapshot
                    .launch_lock
                    .env
                    .iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect();
                merged_env.extend(self.snapshot.env.clone());
                let alias_targets = driver.model_aliases(&merged_env);
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
                self.fail_active_turn(
                    session_id,
                    prompt_id,
                    classify_native_turn_error(message),
                )
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
