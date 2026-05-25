use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, LazyLock},
};

use futures::StreamExt;
use regex::Regex;
use serde::Deserialize;
use workspace_utils::{approvals::ApprovalStatus, msg_store::MsgStore};

pub use super::AcpAgentHarness;
use super::{
    AcpEvent,
    formatting::{content_block_to_markdown, format_plan_markdown},
    parser::{parse_event_line, parse_execute_command},
    streaming::{StreamingState, StreamingText, merge_streaming_text},
    task_inference::{TaskToolCallView, heuristically_extract_task_create},
    tool_state::PartialToolCallData,
};
use crate::{
    approvals::ToolCallMetadata,
    logs::{
        ActionType, FileChange, NormalizedEntry, NormalizedEntryError, NormalizedEntryType,
        TokenUsageInfo, ToolResult, ToolResultValueType, ToolStatus as LogToolStatus,
        stderr_processor::normalize_stderr_logs,
        utils::{ConversationPatch, EntryIndexProvider},
    },
};

pub fn normalize_logs(msg_store: Arc<MsgStore>, worktree_path: &Path) {
    normalize_logs_with_context_window_override(msg_store, worktree_path, None);
}

pub fn normalize_logs_with_context_window_override(
    msg_store: Arc<MsgStore>,
    worktree_path: &Path,
    context_window_fallback: Option<u32>,
) {
    // stderr normalization
    let entry_index = EntryIndexProvider::start_from(&msg_store);
    normalize_stderr_logs(msg_store.clone(), entry_index.clone());

    // stdout normalization (main loop)
    let worktree_path = worktree_path.to_path_buf();
    // Type aliases to simplify complex state types and appease clippy
    tokio::spawn(async move {
        type ToolStates = std::collections::HashMap<String, PartialToolCallData>;

        let mut stored_session_id = false;
        let mut streaming: StreamingState = StreamingState::default();
        let mut tool_states: ToolStates = HashMap::new();

        let mut stdout_lines = msg_store.stdout_lines_stream();
        while let Some(Ok(line)) = stdout_lines.next().await {
            if let Some(parsed) = parse_event_line(&line) {
                tracing::trace!("Parsed ACP line: {:?}", parsed);
                match parsed {
                    AcpEvent::SessionStart(id) => {
                        if !stored_session_id {
                            msg_store.push_session_id(id);
                            stored_session_id = true;
                        }
                    }
                    AcpEvent::Error(msg) => {
                        let idx = entry_index.next();
                        let entry = NormalizedEntry {
                            timestamp: None,
                            entry_type: NormalizedEntryType::ErrorMessage {
                                error_type: NormalizedEntryError::Other,
                            },
                            content: msg,
                            metadata: None,
                        };
                        msg_store.push_patch(ConversationPatch::add_normalized_entry(idx, entry));
                    }
                    AcpEvent::Done(_) => {
                        streaming.assistant_text = None;
                        streaming.thinking_text = None;
                    }
                    AcpEvent::Message(content) => {
                        streaming.thinking_text = None;
                        match content {
                            agent_client_protocol::schema::ContentBlock::Text(text) => {
                                let is_new = streaming.assistant_text.is_none();
                                if is_new {
                                    if text.text == "\n" {
                                        continue;
                                    }
                                    let idx = entry_index.next();
                                    streaming.assistant_text = Some(StreamingText {
                                        index: idx,
                                        content: String::new(),
                                    });
                                }
                                if let Some(ref mut s) = streaming.assistant_text {
                                    merge_streaming_text(&mut s.content, &text.text);
                                    let entry = NormalizedEntry {
                                        timestamp: None,
                                        entry_type: NormalizedEntryType::AssistantMessage,
                                        content: s.content.clone(),
                                        metadata: None,
                                    };
                                    let patch = if is_new {
                                        ConversationPatch::add_normalized_entry(s.index, entry)
                                    } else {
                                        ConversationPatch::replace(s.index, entry)
                                    };
                                    msg_store.push_patch(patch);
                                }
                            }
                            other => {
                                streaming.assistant_text = None;
                                if let Some(content) = content_block_to_markdown(&other) {
                                    let idx = entry_index.next();
                                    let entry = NormalizedEntry {
                                        timestamp: None,
                                        entry_type: NormalizedEntryType::AssistantMessage,
                                        content,
                                        metadata: None,
                                    };
                                    msg_store.push_patch(ConversationPatch::add_normalized_entry(
                                        idx, entry,
                                    ));
                                }
                            }
                        }
                    }
                    AcpEvent::Thought(content) => {
                        streaming.assistant_text = None;
                        if let Some(content) = content_block_to_markdown(&content)
                            && !content.trim().is_empty()
                        {
                            let idx = entry_index.next();
                            let entry = NormalizedEntry {
                                timestamp: None,
                                entry_type: NormalizedEntryType::Thinking,
                                content,
                                metadata: None,
                            };
                            msg_store
                                .push_patch(ConversationPatch::add_normalized_entry(idx, entry));
                        }
                        streaming.thinking_text = None;
                    }
                    AcpEvent::Plan(plan) => {
                        streaming.assistant_text = None;
                        streaming.thinking_text = None;
                        let idx = entry_index.next();
                        let entry = NormalizedEntry {
                            timestamp: None,
                            entry_type: NormalizedEntryType::ToolUse {
                                tool_name: "plan".to_string(),
                                action_type: ActionType::PlanPresentation {
                                    plan: format_plan_markdown(&plan),
                                },
                                status: LogToolStatus::Success,
                            },
                            content: "Plan updated".to_string(),
                            metadata: None,
                        };
                        msg_store.push_patch(ConversationPatch::add_normalized_entry(idx, entry));
                    }
                    AcpEvent::Usage { used, size } => {
                        let Some(model_context_window) =
                            acp_context_window_or_fallback(size, context_window_fallback)
                        else {
                            continue;
                        };
                        let idx = entry_index.next();
                        let entry = NormalizedEntry {
                            timestamp: None,
                            entry_type: NormalizedEntryType::TokenUsageInfo(TokenUsageInfo {
                                total_tokens: used.min(u32::MAX as u64) as u32,
                                model_context_window,
                            }),
                            content: String::new(),
                            metadata: None,
                        };
                        msg_store.push_patch(ConversationPatch::add_normalized_entry(idx, entry));
                    }
                    AcpEvent::AvailableCommands(cmds) => {
                        let mut body = String::from("Available commands:\n");
                        for c in &cmds {
                            body.push_str(&format!("- {}\n", c.name));
                        }
                        let idx = entry_index.next();
                        let entry = NormalizedEntry {
                            timestamp: None,
                            entry_type: NormalizedEntryType::SystemMessage,
                            content: body,
                            metadata: None,
                        };
                        msg_store.push_patch(ConversationPatch::add_normalized_entry(idx, entry));
                    }
                    AcpEvent::CurrentMode(mode_id) => {
                        let idx = entry_index.next();
                        let entry = NormalizedEntry {
                            timestamp: None,
                            entry_type: NormalizedEntryType::SystemMessage,
                            content: format!("Current mode: {}", mode_id.0),
                            metadata: None,
                        };
                        msg_store.push_patch(ConversationPatch::add_normalized_entry(idx, entry));
                    }
                    AcpEvent::RequestPermission(perm) => {
                        if let Ok(tc) =
                            agent_client_protocol::schema::ToolCall::try_from(perm.tool_call)
                        {
                            handle_tool_call(
                                &tc,
                                &worktree_path,
                                &mut streaming,
                                &mut tool_states,
                                &entry_index,
                                &msg_store,
                            );
                        }
                    }
                    AcpEvent::ToolCall(tc) => handle_tool_call(
                        &tc,
                        &worktree_path,
                        &mut streaming,
                        &mut tool_states,
                        &entry_index,
                        &msg_store,
                    ),
                    AcpEvent::ToolUpdate(update) => {
                        let mut update = update;
                        if update.fields.title.is_none() {
                            update.fields.title = tool_states
                                .get(&update.tool_call_id.0.to_string())
                                .map(|s| s.title.clone())
                                .or_else(|| Some("".to_string()));
                        }
                        tracing::trace!("Got tool call update: {:?}", update);
                        if let Ok(tc) =
                            agent_client_protocol::schema::ToolCall::try_from(update.clone())
                        {
                            handle_tool_call(
                                &tc,
                                &worktree_path,
                                &mut streaming,
                                &mut tool_states,
                                &entry_index,
                                &msg_store,
                            );
                        } else {
                            tracing::debug!("Failed to convert tool call update to ToolCall");
                        }
                    }
                    AcpEvent::ApprovalResponse(resp) => {
                        tracing::trace!("Received approval response: {:?}", resp);
                        if let ApprovalStatus::Denied { reason } = resp.status {
                            let tool_name = tool_states
                                .get(&resp.tool_call_id)
                                .map(|t| {
                                    extract_tool_name_from_id(t.id.0.as_ref())
                                        .unwrap_or_else(|| t.title.clone())
                                })
                                .unwrap_or_default();
                            let idx = entry_index.next();
                            let entry = NormalizedEntry {
                                timestamp: None,
                                entry_type: NormalizedEntryType::UserFeedback {
                                    denied_tool: tool_name,
                                },
                                content: reason
                                    .clone()
                                    .unwrap_or_else(|| {
                                        "User denied this tool use request".to_string()
                                    })
                                    .trim()
                                    .to_string(),
                                metadata: None,
                            };
                            msg_store
                                .push_patch(ConversationPatch::add_normalized_entry(idx, entry));
                        }
                    }
                    AcpEvent::User(_) | AcpEvent::Other(_) => (),
                }
            }
        }

        fn handle_tool_call(
            tc: &agent_client_protocol::schema::ToolCall,
            worktree_path: &Path,
            streaming: &mut StreamingState,
            tool_states: &mut ToolStates,
            entry_index: &EntryIndexProvider,
            msg_store: &Arc<MsgStore>,
        ) {
            streaming.assistant_text = None;
            streaming.thinking_text = None;
            let id = tc.tool_call_id.0.to_string();
            let is_new = !tool_states.contains_key(&id);
            let tool_data = tool_states.entry(id).or_default();
            tool_data.extend(tc, worktree_path);
            if is_new {
                tool_data.index = entry_index.next();
            }
            let action = map_to_action_type(tool_data);
            let entry = NormalizedEntry {
                timestamp: None,
                entry_type: NormalizedEntryType::ToolUse {
                    tool_name: tool_data.title.clone(),
                    action_type: action.clone(),
                    status: convert_tool_status(&tool_data.status),
                },
                content: get_tool_content(tool_data, &action),
                metadata: serde_json::to_value(ToolCallMetadata {
                    tool_call_id: tool_data.id.0.to_string(),
                })
                .ok(),
            };
            let patch = if is_new {
                ConversationPatch::add_normalized_entry(tool_data.index, entry)
            } else {
                ConversationPatch::replace(tool_data.index, entry)
            };
            msg_store.push_patch(patch);
        }

        fn map_to_action_type(tc: &PartialToolCallData) -> ActionType {
            match tc.kind {
                agent_client_protocol::schema::ToolKind::Read => {
                    // Special-case: read_many_files style titles parsed via helper
                    if tc.id.0.starts_with("read_many_files") {
                        let result = collect_text_content(&tc.content).map(|text| ToolResult {
                            r#type: ToolResultValueType::Markdown,
                            value: serde_json::Value::String(text),
                        });
                        return ActionType::Tool {
                            tool_name: "read_many_files".to_string(),
                            arguments: Some(serde_json::Value::String(tc.title.clone())),
                            result,
                        };
                    }
                    ActionType::FileRead {
                        path: tc
                            .path
                            .clone()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_string(),
                    }
                }
                agent_client_protocol::schema::ToolKind::Edit => {
                    let changes = extract_file_changes(tc);
                    ActionType::FileEdit {
                        path: tc
                            .path
                            .clone()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_string(),
                        changes,
                    }
                }
                agent_client_protocol::schema::ToolKind::Execute => {
                    let command = parse_execute_command(&tc.title, tc.raw_input.as_ref());
                    // Prefer structured raw_output, else fallback to aggregated text content
                    let completed = matches!(
                        tc.status,
                        agent_client_protocol::schema::ToolCallStatus::Completed
                    );
                    tracing::trace!(
                        "Mapping execute tool call, completed: {}, command: {}",
                        completed,
                        command
                    );
                    let tc_exit_status = match tc.status {
                        agent_client_protocol::schema::ToolCallStatus::Completed => {
                            Some(crate::logs::CommandExitStatus::Success { success: true })
                        }
                        agent_client_protocol::schema::ToolCallStatus::Failed => {
                            Some(crate::logs::CommandExitStatus::Success { success: false })
                        }
                        _ => None,
                    };

                    let result = if let Some(text) = collect_text_content(&tc.content) {
                        Some(crate::logs::CommandRunResult {
                            exit_status: tc_exit_status,
                            output: Some(text),
                        })
                    } else {
                        Some(crate::logs::CommandRunResult {
                            exit_status: tc_exit_status,
                            output: None,
                        })
                    };
                    ActionType::CommandRun {
                        command,
                        result,
                        category: Default::default(),
                    }
                }
                agent_client_protocol::schema::ToolKind::Delete => ActionType::FileEdit {
                    path: tc
                        .path
                        .clone()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string(),
                    changes: vec![FileChange::Delete],
                },
                agent_client_protocol::schema::ToolKind::Search => {
                    let query = tc
                        .raw_input
                        .as_ref()
                        .and_then(|v| serde_json::from_value::<SearchArgs>(v.clone()).ok())
                        .map(|a| a.query)
                        .unwrap_or_else(|| tc.title.clone());
                    ActionType::Search { query }
                }
                agent_client_protocol::schema::ToolKind::Fetch => {
                    let mut url = tc
                        .raw_input
                        .as_ref()
                        .and_then(|v| serde_json::from_value::<FetchArgs>(v.clone()).ok())
                        .map(|a| a.url)
                        .unwrap_or_default();
                    if url.is_empty() {
                        // Fallback: try to extract first URL from the title
                        if let Some(extracted) = extract_url_from_text(&tc.title) {
                            url = extracted;
                        }
                    }
                    ActionType::WebFetch { url }
                }
                agent_client_protocol::schema::ToolKind::Think => {
                    if let Some(task_action) =
                        heuristically_extract_task_create(task_tool_call_view(tc))
                    {
                        return task_action;
                    }
                    let tool_name = extract_tool_name_from_id(tc.id.0.as_ref())
                        .unwrap_or_else(|| tc.title.clone());
                    // For think/save_memory, surface both title and aggregated text content as arguments
                    let text = collect_text_content(&tc.content);
                    let arguments = Some(match &text {
                        Some(t) => serde_json::json!({ "title": tc.title, "content": t }),
                        None => serde_json::json!({ "title": tc.title }),
                    });
                    let result = if let Some(output) = &tc.raw_output {
                        Some(ToolResult {
                            r#type: ToolResultValueType::Json,
                            value: output.clone(),
                        })
                    } else {
                        collect_text_content(&tc.content).map(|text| ToolResult {
                            r#type: ToolResultValueType::Markdown,
                            value: serde_json::Value::String(text),
                        })
                    };
                    ActionType::Tool {
                        tool_name,
                        arguments,
                        result,
                    }
                }
                agent_client_protocol::schema::ToolKind::SwitchMode => ActionType::Other {
                    description: "switch_mode".to_string(),
                },
                agent_client_protocol::schema::ToolKind::Other
                | agent_client_protocol::schema::ToolKind::Move
                | _ => {
                    if let Some(task_action) =
                        heuristically_extract_task_create(task_tool_call_view(tc))
                    {
                        return task_action;
                    }
                    // Derive a friendlier tool name from the id if it looks like name-<digits>
                    let tool_name = extract_tool_name_from_id(tc.id.0.as_ref())
                        .unwrap_or_else(|| tc.title.clone());

                    // Some tools embed JSON args into the title instead of raw_input
                    let arguments = if let Some(raw) = &tc.raw_input {
                        Some(raw.clone())
                    } else if tc.title.trim_start().starts_with('{') {
                        // Title contains JSON arguments for the tool
                        serde_json::from_str::<serde_json::Value>(&tc.title).ok()
                    } else {
                        None
                    };
                    // Extract result: prefer raw_output (structured), else text content as Markdown
                    let result = if let Some(output) = &tc.raw_output {
                        Some(ToolResult {
                            r#type: ToolResultValueType::Json,
                            value: output.clone(),
                        })
                    } else {
                        collect_text_content(&tc.content).map(|text| ToolResult {
                            r#type: ToolResultValueType::Markdown,
                            value: serde_json::Value::String(text),
                        })
                    };
                    ActionType::Tool {
                        tool_name,
                        arguments,
                        result,
                    }
                }
            }
        }

        fn extract_file_changes(tc: &PartialToolCallData) -> Vec<FileChange> {
            let mut changes = Vec::new();
            for c in &tc.content {
                if let agent_client_protocol::schema::ToolCallContent::Diff(diff) = c {
                    let path = diff.path.to_string_lossy().to_string();
                    let rel = if !path.is_empty() {
                        path
                    } else {
                        tc.path
                            .clone()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_string()
                    };
                    let old_text = diff.old_text.as_deref().unwrap_or("");
                    if old_text.is_empty() {
                        changes.push(FileChange::Write {
                            content: diff.new_text.clone(),
                        });
                    } else {
                        let unified = workspace_utils::diff::create_unified_diff(
                            &rel,
                            old_text,
                            &diff.new_text,
                        );
                        changes.push(FileChange::Edit {
                            unified_diff: unified,
                            has_line_numbers: false,
                        });
                    }
                }
            }
            if changes.is_empty()
                && let Some(raw) = &tc.raw_input
                && let Ok(edit_input) = serde_json::from_value::<EditInput>(raw.clone())
            {
                if let Some(diff) = edit_input.diff {
                    changes.push(FileChange::Edit {
                        unified_diff: workspace_utils::diff::normalize_unified_diff(
                            &edit_input.file_path,
                            &diff,
                        ),
                        has_line_numbers: true,
                    });
                } else if let Some(old) = edit_input.old_string
                    && let Some(new) = edit_input.new_string
                {
                    changes.push(FileChange::Edit {
                        unified_diff: workspace_utils::diff::create_unified_diff(
                            &edit_input.file_path,
                            &old,
                            &new,
                        ),
                        has_line_numbers: false,
                    });
                }
            }
            changes
        }

        fn get_tool_content(tc: &PartialToolCallData, action: &ActionType) -> String {
            match action {
                ActionType::CommandRun { command, .. } => command.clone(),
                ActionType::FileRead { path } => path.clone(),
                ActionType::FileEdit { path, .. } => path.clone(),
                ActionType::Search { query } => query.clone(),
                ActionType::WebFetch { url } => url.clone(),
                ActionType::TaskCreate { description, .. } => description.clone(),
                _ => match tc.kind {
                    agent_client_protocol::schema::ToolKind::Think => "Saving memory".to_string(),
                    agent_client_protocol::schema::ToolKind::Other => {
                        let tool_name = extract_tool_name_from_id(tc.id.0.as_ref())
                            .unwrap_or_else(|| "tool".to_string());
                        if tc.title.is_empty() {
                            tool_name
                        } else {
                            format!("{}: {}", tool_name, tc.title)
                        }
                    }
                    agent_client_protocol::schema::ToolKind::Read => {
                        if tc.id.0.starts_with("read_many_files") {
                            "Read files".to_string()
                        } else {
                            tc.path
                                .as_ref()
                                .map(|p| p.display().to_string())
                                .unwrap_or_else(|| tc.title.clone())
                        }
                    }
                    _ => tc.title.clone(),
                },
            }
        }

        fn extract_tool_name_from_id(id: &str) -> Option<String> {
            if let Some(idx) = id.rfind('-') {
                let (head, tail) = id.split_at(idx);
                if tail
                    .trim_start_matches('-')
                    .chars()
                    .all(|c| c.is_ascii_digit())
                {
                    return Some(head.to_string());
                }
            }
            None
        }

        fn extract_url_from_text(text: &str) -> Option<String> {
            // Simple URL extractor
            static URL_RE: LazyLock<Regex> =
                LazyLock::new(|| Regex::new(r#"https?://[^\s"')]+"#).expect("valid regex"));
            URL_RE.find(text).map(|m| m.as_str().to_string())
        }

        fn collect_text_content(
            content: &[agent_client_protocol::schema::ToolCallContent],
        ) -> Option<String> {
            let mut out = String::new();
            for c in content {
                if let agent_client_protocol::schema::ToolCallContent::Content(inner) = c
                    && let agent_client_protocol::schema::ContentBlock::Text(t) = &inner.content
                {
                    out.push_str(&t.text);
                    if !out.ends_with('\n') {
                        out.push('\n');
                    }
                }
            }
            if out.is_empty() { None } else { Some(out) }
        }

        fn convert_tool_status(
            status: &agent_client_protocol::schema::ToolCallStatus,
        ) -> LogToolStatus {
            match status {
                agent_client_protocol::schema::ToolCallStatus::Pending
                | agent_client_protocol::schema::ToolCallStatus::InProgress => {
                    LogToolStatus::Created
                }
                agent_client_protocol::schema::ToolCallStatus::Completed => LogToolStatus::Success,
                agent_client_protocol::schema::ToolCallStatus::Failed => LogToolStatus::Failed,
                _ => {
                    tracing::debug!("Unknown tool call status: {:?}", status);
                    LogToolStatus::Created
                }
            }
        }
    });
}

fn acp_context_window_or_fallback(size: u64, fallback: Option<u32>) -> Option<u32> {
    if size > 0 {
        Some(size.min(u32::MAX as u64) as u32)
    } else {
        fallback.filter(|value| *value > 0)
    }
}

fn task_tool_call_view(tc: &PartialToolCallData) -> TaskToolCallView<'_> {
    TaskToolCallView {
        id: &tc.id,
        title: &tc.title,
        content: &tc.content,
        raw_input: tc.raw_input.as_ref(),
        raw_output: tc.raw_output.as_ref(),
    }
}

#[cfg(test)]
mod tests {
    use std::{path::Path, sync::Arc};

    use agent_client_protocol::schema::{
        ContentBlock, ImageContent, Plan, PlanEntry, PlanEntryPriority, PlanEntryStatus,
        ResourceLink, TextContent, ToolCall, ToolCallContent, ToolCallId, ToolCallStatus,
        ToolCallUpdate, ToolCallUpdateFields, ToolKind,
    };
    use serde_json::json;
    use workspace_utils::{log_msg::LogMsg, msg_store::MsgStore};

    use super::{
        AcpEvent, PartialToolCallData, acp_context_window_or_fallback, content_block_to_markdown,
        format_plan_markdown, heuristically_extract_task_create, merge_streaming_text,
        normalize_logs_with_context_window_override, task_tool_call_view,
    };
    use crate::logs::{
        ActionType, NormalizedEntry, NormalizedEntryType, ToolStatus,
        utils::patch::extract_normalized_entry_from_patch,
    };

    fn normalized_entries(msg_store: &MsgStore) -> Vec<(usize, NormalizedEntry)> {
        msg_store
            .get_history()
            .into_iter()
            .filter_map(|msg| match msg {
                LogMsg::JsonPatch(patch) => extract_normalized_entry_from_patch(&patch),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn formats_acp_plan_as_readable_markdown() {
        let plan = Plan::new(vec![
            PlanEntry::new(
                "Inspect the repository state",
                PlanEntryPriority::High,
                PlanEntryStatus::InProgress,
            ),
            PlanEntry::new(
                "Update the renderer",
                PlanEntryPriority::Medium,
                PlanEntryStatus::Pending,
            ),
        ]);

        assert_eq!(
            format_plan_markdown(&plan),
            "1. [in_progress | high] Inspect the repository state\n2. [pending | medium] Update the renderer"
        );
    }

    #[test]
    fn acp_usage_prefers_protocol_context_window_over_fallback() {
        assert_eq!(
            acp_context_window_or_fallback(128_000, Some(1_000_000)),
            Some(128_000)
        );
        assert_eq!(
            acp_context_window_or_fallback(0, Some(1_000_000)),
            Some(1_000_000)
        );
        assert_eq!(acp_context_window_or_fallback(0, None), None);
    }

    #[test]
    fn merge_streaming_text_replaces_cumulative_chunks() {
        let mut content = String::new();

        merge_streaming_text(&mut content, "已完成两部分");
        merge_streaming_text(&mut content, "已完成两部分：文档");
        merge_streaming_text(&mut content, "已完成两部分：文档\n\n- 改进方案");

        assert_eq!(content, "已完成两部分：文档\n\n- 改进方案");
    }

    #[test]
    fn merge_streaming_text_appends_delta_chunks() {
        let mut content = String::new();

        merge_streaming_text(&mut content, "已完成两部分");
        merge_streaming_text(&mut content, "：文档");

        assert_eq!(content, "已完成两部分：文档");
    }

    #[test]
    fn converts_acp_image_blocks_to_markdown_images() {
        let markdown = content_block_to_markdown(&ContentBlock::Image(ImageContent::new(
            "abc123",
            "image/png",
        )))
        .expect("image markdown");

        assert_eq!(markdown, "![Image](data:image/png;base64,abc123)");
    }

    #[test]
    fn converts_image_resource_links_to_markdown_images() {
        let markdown = content_block_to_markdown(&ContentBlock::ResourceLink(
            ResourceLink::new("mockup.png", "file:///C:/tmp/mockup.png").mime_type("image/png"),
        ))
        .expect("resource link markdown");

        assert_eq!(markdown, "![mockup.png](file:///C:/tmp/mockup.png)");
    }

    #[test]
    fn heuristically_extracts_task_create_from_other_tool() {
        let tool_call = PartialToolCallData {
            id: ToolCallId::new("create_task-1"),
            kind: ToolKind::Other,
            title: "create_task: Audit renderer parity".to_string(),
            status: ToolCallStatus::Completed,
            raw_input: Some(json!({
                "description": "Audit renderer parity",
                "subagent_type": "reviewer"
            })),
            raw_output: Some(json!({ "ok": true })),
            ..Default::default()
        };

        let action = heuristically_extract_task_create(task_tool_call_view(&tool_call))
            .expect("task action");
        let ActionType::TaskCreate {
            description,
            subagent_type,
            result,
        } = action
        else {
            panic!("expected task_create action");
        };

        assert_eq!(description, "Audit renderer parity");
        assert_eq!(subagent_type.as_deref(), Some("reviewer"));
        assert!(result.is_some());
    }

    #[test]
    fn heuristically_extracts_task_create_from_spawn_agent_tool() {
        let tool_call = PartialToolCallData {
            id: ToolCallId::new("spawn_agent-1"),
            kind: ToolKind::Other,
            title: "spawn_agent".to_string(),
            status: ToolCallStatus::Completed,
            raw_input: Some(json!({
                "message": "Inspect frontend rendering",
                "agent_type": "architect"
            })),
            raw_output: Some(json!({ "agent_id": "agent-1" })),
            ..Default::default()
        };

        let action = heuristically_extract_task_create(task_tool_call_view(&tool_call))
            .expect("task action");
        let ActionType::TaskCreate {
            description,
            subagent_type,
            result,
        } = action
        else {
            panic!("expected task_create action");
        };

        assert_eq!(description, "Inspect frontend rendering");
        assert_eq!(subagent_type.as_deref(), Some("architect"));
        assert!(result.is_some());
    }

    #[tokio::test]
    async fn normalizes_stdout_acp_event_sequence_end_to_end() {
        let msg_store = Arc::new(MsgStore::new());
        normalize_logs_with_context_window_override(
            msg_store.clone(),
            Path::new("C:/repo"),
            Some(1_000_000),
        );

        msg_store.push_stdout(format!(
            "{}\n",
            AcpEvent::Message(ContentBlock::Text(TextContent::new("Review complete")))
        ));
        msg_store.push_stdout(format!(
            "{}\n",
            AcpEvent::Message(ContentBlock::Text(TextContent::new(
                "Review complete\n\n- locked behavior"
            )))
        ));
        msg_store.push_stdout(format!(
            "{}\n",
            AcpEvent::ToolCall(
                ToolCall::new(ToolCallId::new("spawn_agent-1"), "spawn_agent")
                    .kind(ToolKind::Other)
                    .status(ToolCallStatus::Completed)
                    .raw_input(json!({
                        "message": "Audit ACP normalization",
                        "agent_type": "critic"
                    }))
                    .raw_output(json!({ "ok": true }))
            )
        ));
        msg_store.push_stdout(format!("{}\n", AcpEvent::Usage { used: 42, size: 0 }));
        msg_store.push_finished();

        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if normalized_entries(&msg_store).len() >= 4 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("normalization task produced expected entries");

        let entries = normalized_entries(&msg_store);

        assert!(matches!(
            entries[0].1.entry_type,
            NormalizedEntryType::AssistantMessage
        ));
        assert_eq!(entries[0].1.content, "Review complete");

        assert!(matches!(
            entries[1].1.entry_type,
            NormalizedEntryType::AssistantMessage
        ));
        assert_eq!(entries[1].1.content, "Review complete\n\n- locked behavior");

        let NormalizedEntryType::ToolUse {
            action_type,
            status,
            ..
        } = &entries[2].1.entry_type
        else {
            panic!("expected task-create tool entry");
        };
        let ActionType::TaskCreate {
            description,
            subagent_type,
            result,
        } = action_type
        else {
            panic!("expected task-create action");
        };
        assert_eq!(description, "Audit ACP normalization");
        assert_eq!(subagent_type.as_deref(), Some("critic"));
        assert!(matches!(status, ToolStatus::Success));
        assert!(result.is_some());

        let NormalizedEntryType::TokenUsageInfo(usage) = &entries[3].1.entry_type else {
            panic!("expected token usage entry");
        };
        assert_eq!(usage.total_tokens, 42);
        assert_eq!(usage.model_context_window, 1_000_000);
    }

    #[tokio::test]
    async fn tool_updates_without_titles_replace_existing_tool_entries() {
        let msg_store = Arc::new(MsgStore::new());
        normalize_logs_with_context_window_override(msg_store.clone(), Path::new("C:/repo"), None);

        msg_store.push_stdout(format!(
            "{}\n",
            AcpEvent::ToolCall(
                ToolCall::new(
                    ToolCallId::new("shell-1"),
                    "cargo check (running in C:/repo)"
                )
                .kind(ToolKind::Execute)
                .status(ToolCallStatus::InProgress)
                .raw_input(json!({ "command": "cargo check" }))
            )
        ));
        msg_store.push_stdout(format!(
            "{}\n",
            AcpEvent::ToolUpdate(ToolCallUpdate::new(
                ToolCallId::new("shell-1"),
                ToolCallUpdateFields::new()
                    .status(ToolCallStatus::Completed)
                    .content(vec![ToolCallContent::from(ContentBlock::Text(
                        TextContent::new("finished")
                    ))])
            ))
        ));
        msg_store.push_finished();

        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if normalized_entries(&msg_store).len() >= 2 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("tool update replaced existing entry");

        let entries = normalized_entries(&msg_store);
        assert_eq!(entries[0].0, entries[1].0);

        let NormalizedEntryType::ToolUse {
            action_type,
            status,
            ..
        } = &entries[1].1.entry_type
        else {
            panic!("expected updated tool entry");
        };
        let ActionType::CommandRun {
            command, result, ..
        } = action_type
        else {
            panic!("expected command run action");
        };

        assert_eq!(command, "cargo check");
        assert!(matches!(status, ToolStatus::Success));
        assert_eq!(entries[1].1.content, "cargo check");
        assert_eq!(
            result.as_ref().and_then(|value| value.output.as_deref()),
            Some("finished\n")
        );
    }
}

#[derive(Debug, Clone, Deserialize)]
struct SearchArgs {
    query: String,
}

#[derive(Debug, Clone, Deserialize)]
struct FetchArgs {
    url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditInput {
    file_path: String,
    #[serde(default)]
    diff: Option<String>,
    #[serde(default)]
    old_string: Option<String>,
    #[serde(default)]
    new_string: Option<String>,
}
