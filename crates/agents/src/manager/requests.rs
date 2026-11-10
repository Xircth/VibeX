use super::*;

impl AcpClientBridge {
    pub(in crate::manager) async fn handle_agent_request(
        &self,
        request: AgentRequest,
    ) -> Result<ClientResponse, acp::Error> {
        self.note_activity().await;
        match request {
            AgentRequest::RequestPermissionRequest(args) => Ok(
                ClientResponse::RequestPermissionResponse(self.request_permission(args).await?),
            ),
            AgentRequest::CreateElicitationRequest(args) => Ok(
                ClientResponse::CreateElicitationResponse(self.create_elicitation(args).await?),
            ),
            AgentRequest::CreateTerminalRequest(args) => Ok(
                ClientResponse::CreateTerminalResponse(self.create_terminal(args).await?),
            ),
            AgentRequest::TerminalOutputRequest(args) => {
                let terminal_id = parse_terminal_id(&args.terminal_id)?;
                let snapshot = agent_terminal_registry()
                    .snapshot_output(terminal_id.into())
                    .await
                    .ok_or_else(acp::Error::invalid_params)?;
                let mut response = TerminalOutputResponse::new(snapshot.output, snapshot.truncated);
                if let Some(AgentTerminalExit::Code { code }) = snapshot.exit {
                    let exit_status = agent_client_protocol::schema::v1::TerminalExitStatus::new()
                        .exit_code(code as u32);
                    response = response.exit_status(exit_status);
                }
                Ok(ClientResponse::TerminalOutputResponse(response))
            }
            AgentRequest::ReleaseTerminalRequest(args) => {
                let terminal_id = parse_terminal_id(&args.terminal_id)?;
                if !agent_terminal_registry()
                    .release_terminal(terminal_id.into())
                    .await
                {
                    return Err(acp::Error::invalid_params());
                }
                Ok(ClientResponse::ReleaseTerminalResponse(
                    ReleaseTerminalResponse::new(),
                ))
            }
            AgentRequest::WaitForTerminalExitRequest(args) => {
                // Invoked from `cx.spawn` in `on_receive_request`. Running
                // this inline on the dispatch loop freezes session/update
                // on a never-exiting command (dev server / `npm run dev`).
                let terminal_id = parse_terminal_id(&args.terminal_id)?;
                let response = wait_for_terminal_exit_response(terminal_id).await?;
                Ok(ClientResponse::WaitForTerminalExitResponse(response))
            }
            AgentRequest::KillTerminalRequest(args) => Ok(ClientResponse::KillTerminalResponse(
                self.kill_terminal(args).await?,
            )),
            AgentRequest::ExtMethodRequest(ext) => self.handle_ext_method(ext).await,
            AgentRequest::ReadTextFileRequest(_) | AgentRequest::WriteTextFileRequest(_) => {
                Err(acp::Error::method_not_found())
            }
            _ => Err(acp::Error::method_not_found()),
        }
    }

    pub(in crate::manager) async fn request_permission(
        &self,
        args: RequestPermissionRequest,
    ) -> Result<RequestPermissionResponse, acp::Error> {
        let permission_id = AgentPermissionId::new();
        let acp_session = args.session_id.0.to_string();
        let Some(session_id) = self.agent_session_for_acp(acp_session.clone()).await else {
            tracing::warn!(
                acp_session = %acp_session,
                "request_permission for unknown ACP session — rejecting instead of \
                 routing to a phantom session the UI can never answer"
            );
            return Err(acp::Error::invalid_params());
        };
        let mut details = serde_json::to_value(&args.tool_call).ok();
        if let Some(details) = details.as_mut() {
            let ledger_meta = self
                .apply
                .air_tool_call_meta
                .lock()
                .await
                .peek(args.tool_call.tool_call_id.0.as_ref());
            crate::air_contract::hoist_request_permission_meta_with_ledger(
                details,
                args.meta.as_ref(),
                ledger_meta.as_ref(),
            );
        }
        let title = crate::air_contract::resolve_permission_request_title(
            details.as_ref(),
            args.tool_call.fields.title.as_deref(),
        );
        if let Some(question_schema) = interaction_question_from_permission(&args, &title) {
            let elicitation = self
                .wait_for_question(session_id, title, question_schema)
                .await;
            return Ok(RequestPermissionResponse::new(
                interaction_permission_outcome_from_elicitation(elicitation, &args.options),
            ));
        }
        let request = AgentPermissionRequest {
            id: permission_id,
            session_id,
            title,
            details,
            options: args
                .options
                .iter()
                .map(|option| AgentPermissionOption {
                    id: option.option_id.to_string(),
                    label: option.name.clone(),
                    kind: agent_permission_option_kind(option.kind),
                    description: None,
                })
                .collect(),
        };

        if let Some(response) = decide_companion_mcp_permission_response(&request) {
            return Ok(RequestPermissionResponse::new(permission_response_outcome(
                response,
            )));
        }

        let configured = *self.auto_approve_mode.lock().await;
        let auto_approve_mode =
            effective_auto_approve_mode(configured, &self.session_controls, session_id).await;
        if let Some(response) = decide_auto_permission_response(auto_approve_mode, &request) {
            send_manager_event(
                &self.event_tx,
                AgentConnectionManagerEvent {
                    connection_id: self.connection_id,
                    session_id: Some(session_id),
                    prompt_id: None,
                    event: AgentEvent::PermissionResponded {
                        permission_id,
                        response: response.clone(),
                        auto: true,
                    },
                },
            );
            return Ok(RequestPermissionResponse::new(permission_response_outcome(
                response,
            )));
        }

        let (tx, rx) = oneshot::channel();
        self.pending_permissions.lock().await.insert(
            permission_id.to_string(),
            PendingPermission {
                permission_id,
                session_id,
                options: request.options.clone(),
                tx,
            },
        );

        let configured = *self.auto_approve_mode.lock().await;
        if let Some(response) = decide_auto_permission_response(configured, &request)
            && let Some(pending) = self
                .pending_permissions
                .lock()
                .await
                .remove(&permission_id.to_string())
        {
            let _ = pending.tx.send(response.clone());
            let event = AgentEvent::PermissionResponded {
                permission_id,
                response: response.clone(),
                auto: true,
            };
            self.apply.record_turn_probe_event(Some(session_id), &event);
            send_manager_event(
                &self.event_tx,
                AgentConnectionManagerEvent {
                    connection_id: self.connection_id,
                    session_id: Some(session_id),
                    prompt_id: None,
                    event,
                },
            );
            return Ok(RequestPermissionResponse::new(permission_response_outcome(
                response,
            )));
        }

        let event = AgentEvent::PermissionRequested {
            request: request.clone(),
        };
        self.apply.record_turn_probe_event(Some(session_id), &event);
        send_manager_event(
            &self.event_tx,
            AgentConnectionManagerEvent {
                connection_id: self.connection_id,
                session_id: Some(session_id),
                prompt_id: None,
                event,
            },
        );

        let response = rx.await.unwrap_or(AgentPermissionResponse::Cancelled);
        Ok(RequestPermissionResponse::new(permission_response_outcome(
            response,
        )))
    }

    /// Handle ACP `elicitation/create` (unstable): the agent asks the user for
    /// structured input — Claude Code's `AskUserQuestion` and MCP elicitations
    /// arrive here. Blocks the ACP request until the user answers; the pending
    /// entry is cancelled by the same paths that cancel pending permissions.
    pub(in crate::manager) async fn create_elicitation(
        &self,
        args: CreateElicitationRequest,
    ) -> Result<CreateElicitationResponse, acp::Error> {
        let ElicitationMode::Form(form) = args.mode else {
            // Only form mode is advertised; decline anything else instead of
            // erroring so a nonconforming agent degrades gracefully.
            return Ok(CreateElicitationResponse::new(ElicitationAction::Decline));
        };
        let ElicitationScope::Session(session_scope) = &form.scope else {
            // Request-scoped elicitations (pre-session auth/config) have no
            // conversation to surface in yet.
            tracing::warn!("declining request-scoped elicitation — no session to route it to");
            return Ok(CreateElicitationResponse::new(ElicitationAction::Decline));
        };
        let acp_session = session_scope.session_id.0.to_string();
        let Some(session_id) = self.agent_session_for_acp(acp_session.clone()).await else {
            tracing::warn!(
                acp_session = %acp_session,
                "elicitation/create for unknown ACP session — rejecting instead of \
                 routing to a phantom session the UI can never answer"
            );
            return Err(acp::Error::invalid_params());
        };

        let mut requested_schema = serde_json::to_value(&form.requested_schema)
            .map_err(acp::Error::into_internal_error)?;
        let in_flight_question_input = self
            .session_controls
            .read()
            .await
            .get(&session_id)
            .and_then(|state| state.in_flight_question_input.clone());
        enrich_elicitation_schema(
            &args.message,
            &mut requested_schema,
            in_flight_question_input.as_ref(),
        );
        let response = self
            .wait_for_question(session_id, args.message, requested_schema)
            .await;
        Ok(CreateElicitationResponse::new(elicitation_response_action(
            response,
        )))
    }

    pub(in crate::manager) async fn wait_for_question(
        &self,
        session_id: AgentSessionId,
        message: String,
        requested_schema: serde_json::Value,
    ) -> AgentElicitationResponse {
        let elicitation_id = AgentElicitationId::new();
        let request = AgentElicitationRequest {
            id: elicitation_id,
            session_id,
            message,
            requested_schema,
        };
        let (tx, rx) = oneshot::channel();
        self.pending_elicitations.lock().await.insert(
            elicitation_id.to_string(),
            PendingElicitation {
                elicitation_id,
                session_id,
                tx,
            },
        );

        let event = AgentEvent::ElicitationRequested { request };
        self.apply.record_turn_probe_event(Some(session_id), &event);
        send_manager_event(
            &self.event_tx,
            AgentConnectionManagerEvent {
                connection_id: self.connection_id,
                session_id: Some(session_id),
                prompt_id: None,
                event,
            },
        );

        rx.await.unwrap_or(AgentElicitationResponse::Cancel)
    }
}

pub(in crate::manager) fn resolve_agent_session_id(
    mapped: Option<AgentSessionId>,
    pending: Option<AgentSessionId>,
) -> Option<AgentSessionId> {
    mapped.or(pending)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::manager) enum MappedResume {
    Reuse(String),
    LoadRequested { unbind_stale: bool },
}

/// A live ACP session may be reused on resume only when it is the session the
/// caller asked for. Returning a sibling conversation's mapped id is how
/// "继续" after stop picked up another session's context.
pub(in crate::manager) fn mapped_resume_action(
    mapped: Option<&str>,
    requested: &str,
) -> MappedResume {
    match mapped {
        Some(existing) if existing == requested => MappedResume::Reuse(existing.to_string()),
        Some(_) => MappedResume::LoadRequested { unbind_stale: true },
        None => MappedResume::LoadRequested {
            unbind_stale: false,
        },
    }
}

/// Requests that must not be answered inside the ACP dispatch loop.
///
/// agent-client-protocol waits for each `on_receive_request` handler to
/// finish before reading the next message. `terminal/wait_for_exit` can
/// wait forever; `elicitation/create` and vendor question ext-methods
/// wait for the user. Answering any of them inline freezes
/// `session/update` and `session/cancel`, so the agent times out and
/// treats a question as cancelled before the composer card can appear.
/// Codeg answers wait_for_exit from `cx.spawn`.
pub(in crate::manager) fn acp_request_must_run_off_dispatch_loop(request: &AgentRequest) -> bool {
    matches!(
        request,
        AgentRequest::RequestPermissionRequest(_)
            | AgentRequest::WaitForTerminalExitRequest(_)
            | AgentRequest::CreateElicitationRequest(_)
            | AgentRequest::ExtMethodRequest(_)
    )
}

pub(in crate::manager) fn enrich_elicitation_schema(
    message: &str,
    requested_schema: &mut serde_json::Value,
    tool_input: Option<&serde_json::Value>,
) {
    let tool_questions =
        tool_input.and_then(session_update::extract_question_items_from_tool_input);
    let Some(schema_obj) = requested_schema.as_object_mut() else {
        return;
    };

    let has_properties = schema_obj
        .get("properties")
        .and_then(serde_json::Value::as_object)
        .is_some_and(|props| !props.is_empty());

    if !has_properties {
        let has_explicit = schema_obj
            .get("x-vibex-questions")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|items| !items.is_empty());
        if !has_explicit && let Some(questions) = tool_questions {
            schema_obj.insert(
                "x-vibex-questions".to_string(),
                serde_json::Value::Array(questions.clone()),
            );
        }
        return;
    }

    let mut ordered_keys: Vec<String> = schema_obj
        .get("required")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .map(str::to_string)
        .collect();

    if let Some(props) = schema_obj
        .get("properties")
        .and_then(serde_json::Value::as_object)
    {
        ordered_keys.retain(|key| props.contains_key(key) && !key.ends_with("_custom"));
        if ordered_keys.is_empty()
            && let Some(questions) = tool_questions
        {
            for item in questions {
                if let Some(id) = item
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|id| !id.is_empty() && props.contains_key(*id))
                    && !ordered_keys.iter().any(|existing| existing == id)
                {
                    ordered_keys.push(id.to_string());
                }
            }
        }
        for key in props.keys() {
            if !key.ends_with("_custom") && !ordered_keys.contains(key) {
                ordered_keys.push(key.clone());
            }
        }
    }

    if schema_obj
        .get("required")
        .and_then(serde_json::Value::as_array)
        .is_none_or(|items| items.is_empty())
        && !ordered_keys.is_empty()
    {
        schema_obj.insert(
            "required".to_string(),
            serde_json::Value::Array(
                ordered_keys
                    .iter()
                    .cloned()
                    .map(serde_json::Value::String)
                    .collect(),
            ),
        );
    }

    let Some(props) = schema_obj
        .get_mut("properties")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return;
    };

    let single_question = ordered_keys.len() == 1;
    let fallback_message = message.trim();

    for (idx, key) in ordered_keys.iter().enumerate() {
        let Some(prop_obj) = props
            .get_mut(key)
            .and_then(serde_json::Value::as_object_mut)
        else {
            continue;
        };
        let prop_title = prop_obj
            .get("title")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        let matched_tool_question = tool_questions.and_then(|questions| {
            questions
                .iter()
                .find(|q| {
                    q.get("id")
                        .and_then(serde_json::Value::as_str)
                        .map(str::trim)
                        == Some(key.as_str())
                })
                .or_else(|| {
                    prop_title.as_deref().and_then(|title| {
                        questions.iter().find(|q| {
                            q.get("header")
                                .and_then(serde_json::Value::as_str)
                                .map(str::trim)
                                == Some(title)
                        })
                    })
                })
                .or_else(|| {
                    (questions.len() == ordered_keys.len())
                        .then(|| questions.get(idx))
                        .flatten()
                })
        });

        let has_description = prop_obj
            .get("description")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|s| !s.trim().is_empty());

        if !has_description {
            let tool_question_text = matched_tool_question
                .and_then(|q| q.get("question"))
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty());

            if let Some(question_text) = tool_question_text {
                prop_obj.insert(
                    "description".to_string(),
                    serde_json::Value::String(question_text.to_string()),
                );
            } else if single_question && !fallback_message.is_empty() {
                prop_obj.insert(
                    "description".to_string(),
                    serde_json::Value::String(fallback_message.to_string()),
                );
            }
        }

        if prop_title.is_none()
            && let Some(header) = matched_tool_question
                .and_then(|q| q.get("header"))
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
        {
            prop_obj.insert(
                "title".to_string(),
                serde_json::Value::String(header.to_string()),
            );
        }

        if !property_has_schema_choices(prop_obj)
            && let Some(tool_options) = matched_tool_question
                .and_then(|q| q.get("options"))
                .and_then(serde_json::Value::as_array)
        {
            let const_options: Vec<serde_json::Value> = tool_options
                .iter()
                .filter_map(|opt| {
                    if let Some(label) = opt.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                        return Some(serde_json::json!({
                            "const": label,
                            "title": label,
                        }));
                    }
                    let obj = opt.as_object()?;
                    let label = obj
                        .get("label")
                        .or_else(|| obj.get("title"))
                        .or_else(|| obj.get("value"))
                        .or_else(|| obj.get("const"))
                        .and_then(serde_json::Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())?;
                    let description = obj
                        .get("description")
                        .and_then(serde_json::Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty());
                    let mut entry = serde_json::json!({
                        "const": label,
                        "title": label,
                    });
                    if let Some(desc) = description
                        && let Some(entry_obj) = entry.as_object_mut()
                    {
                        entry_obj.insert(
                            "description".to_string(),
                            serde_json::Value::String(desc.to_string()),
                        );
                    }
                    Some(entry)
                })
                .collect();

            if !const_options.is_empty() {
                if prop_obj.get("type").and_then(serde_json::Value::as_str) == Some("array") {
                    let items = prop_obj
                        .entry("items".to_string())
                        .or_insert_with(|| serde_json::json!({ "type": "string" }));
                    if let Some(items_obj) = items.as_object_mut() {
                        items_obj
                            .insert("anyOf".to_string(), serde_json::Value::Array(const_options));
                    }
                } else {
                    prop_obj.insert("oneOf".to_string(), serde_json::Value::Array(const_options));
                }
            }
        }
    }
}

fn property_has_schema_choices(prop_obj: &serde_json::Map<String, serde_json::Value>) -> bool {
    for key in ["oneOf", "anyOf", "enum"] {
        if prop_obj
            .get(key)
            .and_then(serde_json::Value::as_array)
            .is_some_and(|arr| !arr.is_empty())
        {
            return true;
        }
    }
    if let Some(items_obj) = prop_obj.get("items").and_then(serde_json::Value::as_object) {
        for key in ["oneOf", "anyOf", "enum"] {
            if items_obj
                .get(key)
                .and_then(serde_json::Value::as_array)
                .is_some_and(|arr| !arr.is_empty())
            {
                return true;
            }
        }
    }
    false
}

pub(in crate::manager) fn interaction_question_from_permission(
    args: &RequestPermissionRequest,
    title: &str,
) -> Option<serde_json::Value> {
    let call_id = args.tool_call.tool_call_id.0.as_ref().trim();
    let is_deepseek_opt_question = !args.options.is_empty()
        && args.options.iter().all(|opt| {
            opt.option_id.0.as_ref().starts_with("opt-")
                && opt.kind == PermissionOptionKind::AllowOnce
        });
    if (!call_id.starts_with("interaction_") && !is_deepseek_opt_question)
        || args.options.is_empty()
    {
        return None;
    }
    let prompt = {
        let trimmed = title.trim();
        if trimmed.is_empty() {
            args.tool_call
                .fields
                .title
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("请选择一个选项")
        } else {
            trimmed
        }
    };
    let options = args
        .options
        .iter()
        .map(|option| {
            serde_json::json!({
                "id": option.option_id.0.as_ref(),
                "label": option.name,
                "description": "",
            })
        })
        .collect::<Vec<_>>();
    Some(crate::ext_question::question_schema([serde_json::json!({
        "id": call_id,
        "header": crate::ext_question::question_header(prompt, 0),
        "question": prompt,
        "multiSelect": false,
        "options": options,
    })]))
}

pub(in crate::manager) fn interaction_permission_outcome_from_elicitation(
    response: AgentElicitationResponse,
    options: &[acp::schema::v1::PermissionOption],
) -> RequestPermissionOutcome {
    match response {
        AgentElicitationResponse::Decline | AgentElicitationResponse::Cancel => {
            RequestPermissionOutcome::Cancelled
        }
        AgentElicitationResponse::Accept { content } => {
            let mut candidates: Vec<String> = crate::ext_question::answer_entries(&content)
                .into_iter()
                .flat_map(|(_, labels)| labels)
                .map(|label| label.trim().to_string())
                .filter(|label| !label.is_empty())
                .collect();
            if candidates.is_empty()
                && let Some(obj) = content.as_object()
            {
                for (key, value) in obj {
                    if key == "answers" || key == "outcome" || key == "declined" {
                        continue;
                    }
                    match value {
                        serde_json::Value::String(text) if !text.trim().is_empty() => {
                            candidates.push(text.trim().to_string());
                        }
                        serde_json::Value::Array(items) => {
                            for item in items {
                                if let Some(text) = item.as_str()
                                    && !text.trim().is_empty()
                                {
                                    candidates.push(text.trim().to_string());
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }

            for candidate in &candidates {
                if let Some(option) = options.iter().find(|option| {
                    option.option_id.0.as_ref() == candidate
                        || option.name.trim() == candidate
                        || strip_recommended_affix(&option.name)
                            == strip_recommended_affix(candidate)
                }) {
                    return RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                        option.option_id.clone(),
                    ));
                }
            }

            if let Some(custom_answer) = candidates.into_iter().next() {
                return RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                    custom_answer,
                ));
            }

            options
                .first()
                .map(|option| {
                    RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                        option.option_id.clone(),
                    ))
                })
                .unwrap_or(RequestPermissionOutcome::Cancelled)
        }
    }
}

fn strip_recommended_affix(label: &str) -> &str {
    let trimmed = label.trim();
    for prefix in ["(Recommended)", "(recommended)", "(推荐)"] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            let cleaned = rest.trim();
            if !cleaned.is_empty() {
                return cleaned;
            }
        }
    }
    for suffix in ["(Recommended)", "(recommended)", "(推荐)"] {
        if let Some(rest) = trimmed.strip_suffix(suffix) {
            let cleaned = rest.trim();
            if !cleaned.is_empty() {
                return cleaned;
            }
        }
    }
    trimmed
}

pub(in crate::manager) fn decide_companion_mcp_permission_response(
    request: &AgentPermissionRequest,
) -> Option<AgentPermissionResponse> {
    if !is_companion_or_question_mcp_permission(request) {
        return None;
    }
    request
        .options
        .iter()
        .find(|option| option.kind == AgentPermissionOptionKind::AllowOnce)
        .or_else(|| request.options.iter().find(|option| option.kind.is_allow()))
        .map(|option| AgentPermissionResponse::selected(&option.id))
}

fn is_companion_or_question_mcp_permission(request: &AgentPermissionRequest) -> bool {
    let title_lower = request.title.trim().to_ascii_lowercase();
    if title_lower == "ask_user_question"
        || title_lower == "ask_question"
        || title_lower.ends_with("_ask_user_question")
        || title_lower.ends_with("/ask_user_question")
        || title_lower.starts_with("vibex-session-mcp_")
        || title_lower.starts_with("vibex-delegation-mcp_")
        || title_lower.starts_with("vibex-workflow-mcp_")
    {
        return true;
    }

    let Some(details) = request.details.as_ref() else {
        return false;
    };

    for server_ptr in [
        "/rawInput/ServerName",
        "/rawInput/server_name",
        "/rawInput/serverName",
        "/_meta/mcp/server",
    ] {
        if let Some(server) = details.pointer(server_ptr).and_then(|v| v.as_str()) {
            let normalized = server.trim().to_ascii_lowercase();
            if matches!(
                normalized.as_str(),
                "vibex-session-mcp" | "vibex-delegation-mcp" | "vibex-workflow-mcp"
            ) {
                return true;
            }
        }
    }

    for tool_ptr in [
        "/rawInput/ToolName",
        "/rawInput/tool_name",
        "/rawInput/toolName",
        "/_meta/mcp/tool",
        "/_meta/toolName",
    ] {
        if let Some(tool) = details.pointer(tool_ptr).and_then(|v| v.as_str()) {
            let normalized = tool.trim().to_ascii_lowercase();
            if normalized == "ask_user_question"
                || normalized == "ask_question"
                || normalized.ends_with("_ask_user_question")
                || normalized.ends_with("/ask_user_question")
            {
                return true;
            }
        }
    }

    false
}

#[cfg(test)]
mod tests {
    use agent_client_protocol::schema::v1::{
        PermissionOption, ToolCallUpdate, ToolCallUpdateFields,
    };

    use super::*;

    #[test]
    fn interaction_permission_converts_into_question_schema_and_maps_selected_option() {
        let mut fields = ToolCallUpdateFields::new();
        fields = fields.title("您倾向于哪种 HTML 课件视觉风格？".to_string());
        let tool_call = ToolCallUpdate::new("interaction_b8486ad3", fields);
        let options = vec![
            PermissionOption::new(
                "1",
                "(Recommended) 方案 A：极夜极客风",
                PermissionOptionKind::AllowOnce,
            ),
            PermissionOption::new("2", "方案 B：现代学术白", PermissionOptionKind::AllowOnce),
        ];
        let req = RequestPermissionRequest::new("session-1", tool_call, options.clone());

        let schema = interaction_question_from_permission(&req, "您倾向于哪种 HTML 课件视觉风格？")
            .expect("interaction_ permission should convert to question schema");
        let questions = schema["x-vibex-questions"]
            .as_array()
            .expect("x-vibex-questions array");
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0]["id"], "interaction_b8486ad3");
        assert_eq!(questions[0]["question"], "您倾向于哪种 HTML 课件视觉风格？");
        assert_eq!(questions[0]["options"].as_array().unwrap().len(), 2);

        // User selects option 1 whose UI label stripped `(Recommended)` prefix and appended `(Recommended)` suffix:
        let response = AgentElicitationResponse::Accept {
            content: serde_json::json!({
                "interaction_b8486ad3": "方案 A：极夜极客风",
                "answers": [{
                    "questionId": "interaction_b8486ad3",
                    "selected": ["1"],
                    "labels": ["方案 A：极夜极客风 (Recommended)"]
                }]
            }),
        };
        let outcome = interaction_permission_outcome_from_elicitation(response, &options);
        assert_eq!(
            outcome,
            RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new("1"))
        );

        // User enters custom write-in answer:
        let custom_response = AgentElicitationResponse::Accept {
            content: serde_json::json!({
                "interaction_b8486ad3": "自定义深色主题",
                "answers": [{
                    "questionId": "interaction_b8486ad3",
                    "selected": [],
                    "labels": ["自定义深色主题"]
                }]
            }),
        };
        let custom_outcome =
            interaction_permission_outcome_from_elicitation(custom_response, &options);
        assert_eq!(
            custom_outcome,
            RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new("自定义深色主题"))
        );
    }

    #[test]
    fn companion_mcp_and_ask_user_question_permissions_auto_approve_once() {
        let request = AgentPermissionRequest {
            id: AgentPermissionId::new(),
            session_id: AgentSessionId::new(),
            title: "Calling MCP tool".to_string(),
            details: Some(serde_json::json!({
                "toolCallId": "call_1",
                "rawInput": {
                    "ServerName": "vibex-delegation-mcp",
                    "ToolName": "ask_user_question",
                    "Arguments": { "questions": [] }
                }
            })),
            options: vec![
                AgentPermissionOption {
                    id: "approve".to_string(),
                    label: "Approve".to_string(),
                    kind: AgentPermissionOptionKind::AllowOnce,
                    description: None,
                },
                AgentPermissionOption {
                    id: "deny".to_string(),
                    label: "Deny".to_string(),
                    kind: AgentPermissionOptionKind::RejectOnce,
                    description: None,
                },
            ],
        };

        assert_eq!(
            decide_companion_mcp_permission_response(&request),
            Some(AgentPermissionResponse::selected("approve"))
        );
    }

    #[test]
    fn enrich_elicitation_schema_recovers_dropped_question_prompts_and_order_from_tool_input() {
        let mut schema = serde_json::json!({
            "type": "object",
            "properties": {
                "create": {
                    "type": "string",
                    "title": "建群与分组",
                    "oneOf": [
                        { "const": "两个入口都报错", "title": "两个入口都报错" }
                    ]
                },
                "supervisor": {
                    "type": "string",
                    "title": "主管表现",
                    "oneOf": [
                        { "const": "左侧会话列表里没有", "title": "左侧会话列表里没有" }
                    ]
                }
            },
            "required": ["supervisor", "create"]
        });
        let tool_input = serde_json::json!({
            "questions": [
                {
                    "id": "supervisor",
                    "header": "主管表现",
                    "question": "「主管 Bot 不见了」具体是哪种表现？",
                    "multi_select": false,
                    "options": [
                        { "label": "左侧会话列表里没有", "description": "消失了" }
                    ]
                },
                {
                    "id": "create",
                    "header": "建群与分组",
                    "question": "「没法建群和建分组」时界面发生了什么？",
                    "multi_select": false,
                    "options": [
                        { "label": "两个入口都报错", "description": "无响应" }
                    ]
                }
            ]
        });

        enrich_elicitation_schema("需要你回答 2 个问题", &mut schema, Some(&tool_input));

        assert_eq!(
            schema["properties"]["supervisor"]["description"],
            "「主管 Bot 不见了」具体是哪种表现？"
        );
        assert_eq!(
            schema["properties"]["create"]["description"],
            "「没法建群和建分组」时界面发生了什么？"
        );
    }
}
