async fn push_native_provider_event_to_conversation(sink: &NativeConversationSink, event: &Value) {
    if let Some(token_usage) = extract_provider_token_usage_info_with_codex_context_window(
        event,
        codex_config_model_context_window(),
    ) {
        let mut state = sink.state.lock().await;
        let index = state.next_entry_index;
        state.next_entry_index += 1;
        drop(state);

        let entry = native_normalized_entry(
            NormalizedEntryType::TokenUsageInfo(token_usage),
            "",
            Some(event.clone()),
        );
        push_native_log_msg(
            sink,
            LogMsg::JsonPatch(ConversationPatch::add_normalized_entry(index, entry)),
        )
        .await;
        return;
    }

    if let Some(error) = extract_provider_error(event) {
        let mut state = sink.state.lock().await;
        let index = state.next_entry_index;
        state.next_entry_index += 1;
        drop(state);

        let entry = native_normalized_entry(
            NormalizedEntryType::ErrorMessage {
                error_type: NormalizedEntryError::Other,
            },
            error,
            Some(event.clone()),
        );
        push_native_log_msg(
            sink,
            LogMsg::JsonPatch(ConversationPatch::add_normalized_entry(index, entry)),
        )
        .await;
        return;
    }

    for tool_update in extract_provider_tool_updates(event) {
        push_native_tool_update_to_conversation(sink, event, tool_update).await;
    }

    if provider_event_is_user_echo(event) {
        return;
    }

    let (text, is_stream_delta) = if let Some(text) = extract_provider_stream_text(event) {
        (text, true)
    } else if let Some(text) = extract_provider_text(event) {
        (text, false)
    } else {
        return;
    };

    let mut state = sink.state.lock().await;
    append_provider_assistant_text(&mut state.assistant_content, &text, is_stream_delta);

    let (index, is_new) = if let Some(index) = state.assistant_index {
        (index, false)
    } else {
        let index = state.next_entry_index;
        state.next_entry_index += 1;
        state.assistant_index = Some(index);
        (index, true)
    };
    let entry = native_normalized_entry(
        NormalizedEntryType::AssistantMessage,
        state.assistant_content.clone(),
        Some(event.clone()),
    );
    let patch = if is_new {
        ConversationPatch::add_normalized_entry(index, entry)
    } else {
        ConversationPatch::replace(index, entry)
    };
    drop(state);

    push_native_log_msg(sink, LogMsg::JsonPatch(patch)).await;
}

async fn push_native_tool_update_to_conversation(
    sink: &NativeConversationSink,
    event: &Value,
    update: NativeToolUpdate,
) {
    let mut state = sink.state.lock().await;
    let (index, is_new, tool_name, action_type, content) =
        if let Some(existing) = state.tool_entries.get_mut(&update.id) {
            if let Some(tool_name) = update.tool_name.as_ref() {
                existing.tool_name = tool_name.clone();
            }
            if let Some(action_type) = update.action_type.as_ref()
                && update.command_output.is_none()
            {
                existing.action_type = action_type.clone();
            }
            merge_tool_result(&mut existing.action_type, &update);
            if let Some(content) = update.content.as_ref() {
                existing.content = content.clone();
            }
            (
                existing.index,
                false,
                existing.tool_name.clone(),
                existing.action_type.clone(),
                existing.content.clone(),
            )
        } else {
            let index = state.next_entry_index;
            state.next_entry_index += 1;
            let tool_name = update
                .tool_name
                .clone()
                .unwrap_or_else(|| "tool".to_string());
            let mut action_type = update
                .action_type
                .clone()
                .unwrap_or_else(|| ActionType::Tool {
                    tool_name: tool_name.clone(),
                    arguments: None,
                    result: update.result.clone(),
                });
            merge_tool_result(&mut action_type, &update);
            let content = update
                .content
                .clone()
                .unwrap_or_else(|| provider_tool_content(&tool_name, &action_type));
            state.tool_entries.insert(
                update.id.clone(),
                NativeToolEntryState {
                    index,
                    tool_name: tool_name.clone(),
                    action_type: action_type.clone(),
                    content: content.clone(),
                },
            );
            (index, true, tool_name, action_type, content)
        };

    let entry = native_normalized_entry(
        NormalizedEntryType::ToolUse {
            tool_name,
            action_type,
            status: update.status,
        },
        content,
        Some(event.clone()),
    );
    let patch = if is_new {
        ConversationPatch::add_normalized_entry(index, entry)
    } else {
        ConversationPatch::replace(index, entry)
    };
    drop(state);

    push_native_log_msg(sink, LogMsg::JsonPatch(patch)).await;
}

async fn complete_native_conversation_sink(
    sink: NativeConversationSink,
    status: ExecutionProcessStatus,
    exit_code: Option<i64>,
) {
    if let Err(error) =
        ExecutionProcess::update_completion(&sink.pool, sink.process_id, status, exit_code).await
    {
        tracing::error!(
            "Failed to mark native provider process {} complete: {}",
            sink.process_id,
            error
        );
    }
    if let Err(error) =
        Session::update_status(&sink.pool, sink.session_id, SessionStatus::InReview).await
    {
        tracing::error!(
            "Failed to mark native provider session {} in review: {}",
            sink.session_id,
            error
        );
    }
    sink.msg_store.push_finished();
}

async fn route_codex_event_to_native_conversation(value: &Value) {
    let turn_id = extract_turn_id(value);
    let thread_id = extract_thread_id(value);
    let mut sink = None;
    if let Some(turn_id) = turn_id.as_deref() {
        sink = CODEX_NATIVE_TURN_SINKS.lock().await.get(turn_id).cloned();
    }
    if sink.is_none()
        && let Some(thread_id) = thread_id.as_deref()
    {
        sink = CODEX_NATIVE_THREAD_SINKS
            .lock()
            .await
            .get(thread_id)
            .cloned();
    }
    let Some(sink) = sink else {
        return;
    };

    push_native_provider_event_to_conversation(&sink, value).await;

    let method = value
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if method == "turn/completed"
        || method == "thread/compacted"
        || method == "turn/error"
        || method == "error"
    {
        if let Some(turn_id) = turn_id.as_deref() {
            CODEX_NATIVE_TURN_SINKS.lock().await.remove(turn_id);
        }
        if let Some(thread_id) = thread_id.as_deref() {
            CODEX_NATIVE_THREAD_SINKS.lock().await.remove(thread_id);
        }
        let status = if method == "turn/completed" || method == "thread/compacted" {
            ExecutionProcessStatus::Completed
        } else {
            ExecutionProcessStatus::Failed
        };
        let exit_code = if status == ExecutionProcessStatus::Completed {
            Some(0)
        } else {
            None
        };
        complete_native_conversation_sink(sink, status, exit_code).await;
    }
}

