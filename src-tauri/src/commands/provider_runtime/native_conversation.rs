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
    if should_skip_provider_text_snapshot(&state, event, is_stream_delta) {
        return;
    }

    let (index, is_new, content) =
        upsert_native_assistant_entry(&mut state, event, &text, is_stream_delta);
    let entry = native_normalized_entry(
        NormalizedEntryType::AssistantMessage,
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

async fn push_native_tool_update_to_conversation(
    sink: &NativeConversationSink,
    event: &Value,
    update: NativeToolUpdate,
) {
    let mut state = sink.state.lock().await;
    close_native_assistant_segment(&mut state);
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

fn close_native_assistant_segment(state: &mut NativeConversationState) {
    state.active_assistant_entry_id = None;
}

fn should_skip_provider_text_snapshot(
    state: &NativeConversationState,
    event: &Value,
    is_stream_delta: bool,
) -> bool {
    !is_stream_delta
        && !state.assistant_entries.is_empty()
        && provider_event_is_codex_turn_snapshot(event)
}

fn upsert_native_assistant_entry(
    state: &mut NativeConversationState,
    event: &Value,
    text: &str,
    is_stream_delta: bool,
) -> (usize, bool, String) {
    let entry_id = extract_provider_assistant_entry_id(event)
        .map(|id| format!("assistant:{id}"))
        .or_else(|| state.active_assistant_entry_id.clone())
        .unwrap_or_else(|| format!("assistant:{}", state.next_entry_index));

    state.active_assistant_entry_id = Some(entry_id.clone());

    if let Some(existing) = state.assistant_entries.get_mut(&entry_id) {
        append_provider_assistant_text(&mut existing.content, text, is_stream_delta);
        return (existing.index, false, existing.content.clone());
    }

    let index = state.next_entry_index;
    state.next_entry_index += 1;
    let mut content = String::new();
    append_provider_assistant_text(&mut content, text, is_stream_delta);
    state.assistant_entries.insert(
        entry_id,
        NativeAssistantEntryState {
            index,
            content: content.clone(),
        },
    );

    (index, true, content)
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

async fn complete_codex_native_sink(
    sink: NativeConversationSink,
    turn_id: Option<String>,
    thread_id: Option<String>,
    status: ExecutionProcessStatus,
) {
    if let Some(turn_id) = turn_id.as_deref() {
        CODEX_NATIVE_TURN_SINKS.lock().await.remove(turn_id);
    }
    if let Some(thread_id) = thread_id.as_deref() {
        CODEX_NATIVE_THREAD_SINKS.lock().await.remove(thread_id);
    }
    let exit_code = if status == ExecutionProcessStatus::Completed {
        Some(0)
    } else {
        None
    };
    complete_native_conversation_sink(sink, status, exit_code).await;
}

fn is_codex_context_compaction_completed(value: &Value) -> bool {
    if value.get("method").and_then(Value::as_str) != Some("item/completed") {
        return false;
    }

    value
        .get("params")
        .and_then(|params| params.get("item"))
        .and_then(|item| item.get("type"))
        .and_then(Value::as_str)
        .is_some_and(|item_type| {
            matches!(item_type, "contextCompaction" | "context_compaction")
        })
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

    if method == "thread/tokenUsage/updated" {
        return;
    }

    if method == "turn/completed"
        || method == "thread/compacted"
        || is_codex_context_compaction_completed(value)
        || method == "turn/error"
        || method == "error"
    {
        let status = if method == "turn/completed"
            || method == "thread/compacted"
            || is_codex_context_compaction_completed(value)
        {
            ExecutionProcessStatus::Completed
        } else {
            ExecutionProcessStatus::Failed
        };
        complete_codex_native_sink(sink, turn_id, thread_id, status).await;
    }
}
