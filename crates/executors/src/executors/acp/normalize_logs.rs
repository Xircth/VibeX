use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock},
};

use agent_client_protocol::{self as acp, SessionNotification};
use futures::StreamExt;
use regex::Regex;
use serde::Deserialize;
use workspace_utils::{approvals::ApprovalStatus, msg_store::MsgStore};

pub use super::AcpAgentHarness;
use super::AcpEvent;
use crate::{
    approvals::ToolCallMetadata,
    logs::{
        ActionType, FileChange, NormalizedEntry, NormalizedEntryError, NormalizedEntryType,
        ToolResult, ToolResultValueType, ToolStatus as LogToolStatus,
        stderr_processor::normalize_stderr_logs,
        utils::{ConversationPatch, EntryIndexProvider},
    },
};

pub fn normalize_logs(msg_store: Arc<MsgStore>, worktree_path: &Path) {
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
            if let Some(parsed) = AcpEventParser::parse_line(&line) {
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
                        if let agent_client_protocol::ContentBlock::Text(text) = content {
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
                                s.content.push_str(&text.text);
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
                    }
                    AcpEvent::Thought(content) => {
                        streaming.assistant_text = None;
                        if let agent_client_protocol::ContentBlock::Text(text) = content {
                            let is_new = streaming.thinking_text.is_none();
                            if is_new {
                                let idx = entry_index.next();
                                streaming.thinking_text = Some(StreamingText {
                                    index: idx,
                                    content: String::new(),
                                });
                            }
                            if let Some(ref mut s) = streaming.thinking_text {
                                s.content.push_str(&text.text);
                                let entry = NormalizedEntry {
                                    timestamp: None,
                                    entry_type: NormalizedEntryType::Thinking,
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
                        if let Ok(tc) = agent_client_protocol::ToolCall::try_from(perm.tool_call) {
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
                        if let Ok(tc) = agent_client_protocol::ToolCall::try_from(update.clone()) {
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
            tc: &agent_client_protocol::ToolCall,
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
                agent_client_protocol::ToolKind::Read => {
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
                agent_client_protocol::ToolKind::Edit => {
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
                agent_client_protocol::ToolKind::Execute => {
                    let command = AcpEventParser::parse_execute_command(tc);
                    // Prefer structured raw_output, else fallback to aggregated text content
                    let completed =
                        matches!(tc.status, agent_client_protocol::ToolCallStatus::Completed);
                    tracing::trace!(
                        "Mapping execute tool call, completed: {}, command: {}",
                        completed,
                        command
                    );
                    let tc_exit_status = match tc.status {
                        agent_client_protocol::ToolCallStatus::Completed => {
                            Some(crate::logs::CommandExitStatus::Success { success: true })
                        }
                        agent_client_protocol::ToolCallStatus::Failed => {
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
                        category:
                            crate::logs::utils::shell_command_parsing::CommandCategory::from_command(
                                &command,
                            ),
                        command,
                        result,
                    }
                }
                agent_client_protocol::ToolKind::Delete => ActionType::FileEdit {
                    path: tc
                        .path
                        .clone()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string(),
                    changes: vec![FileChange::Delete],
                },
                agent_client_protocol::ToolKind::Search => {
                    let query = tc
                        .raw_input
                        .as_ref()
                        .and_then(|v| serde_json::from_value::<SearchArgs>(v.clone()).ok())
                        .map(|a| a.query)
                        .unwrap_or_else(|| tc.title.clone());
                    ActionType::Search { query }
                }
                agent_client_protocol::ToolKind::Fetch => {
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
                agent_client_protocol::ToolKind::Think => {
                    if let Some(task_action) = heuristically_extract_task_create(tc) {
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
                agent_client_protocol::ToolKind::SwitchMode => ActionType::Other {
                    description: "switch_mode".to_string(),
                },
                agent_client_protocol::ToolKind::Other
                | agent_client_protocol::ToolKind::Move
                | _ => {
                    if let Some(task_action) = heuristically_extract_task_create(tc) {
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
                if let agent_client_protocol::ToolCallContent::Diff(diff) = c {
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
                    agent_client_protocol::ToolKind::Think => "Saving memory".to_string(),
                    agent_client_protocol::ToolKind::Other => {
                        let tool_name = extract_tool_name_from_id(tc.id.0.as_ref())
                            .unwrap_or_else(|| "tool".to_string());
                        if tc.title.is_empty() {
                            tool_name
                        } else {
                            format!("{}: {}", tool_name, tc.title)
                        }
                    }
                    agent_client_protocol::ToolKind::Read => {
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
            content: &[agent_client_protocol::ToolCallContent],
        ) -> Option<String> {
            let mut out = String::new();
            for c in content {
                if let agent_client_protocol::ToolCallContent::Content(inner) = c
                    && let agent_client_protocol::ContentBlock::Text(t) = &inner.content
                {
                    out.push_str(&t.text);
                    if !out.ends_with('\n') {
                        out.push('\n');
                    }
                }
            }
            if out.is_empty() { None } else { Some(out) }
        }

        fn convert_tool_status(status: &agent_client_protocol::ToolCallStatus) -> LogToolStatus {
            match status {
                agent_client_protocol::ToolCallStatus::Pending
                | agent_client_protocol::ToolCallStatus::InProgress => LogToolStatus::Created,
                agent_client_protocol::ToolCallStatus::Completed => LogToolStatus::Success,
                agent_client_protocol::ToolCallStatus::Failed => LogToolStatus::Failed,
                _ => {
                    tracing::debug!("Unknown tool call status: {:?}", status);
                    LogToolStatus::Created
                }
            }
        }
    });
}

fn format_plan_markdown(plan: &acp::Plan) -> String {
    plan.entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let status = serde_json::to_value(&entry.status)
                .ok()
                .and_then(|value| value.as_str().map(ToOwned::to_owned))
                .unwrap_or_else(|| "unknown".to_string());
            let priority = serde_json::to_value(&entry.priority)
                .ok()
                .and_then(|value| value.as_str().map(ToOwned::to_owned))
                .unwrap_or_else(|| "normal".to_string());

            format!(
                "{}. [{} | {}] {}",
                index + 1,
                status,
                priority,
                entry.content.trim()
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn heuristically_extract_task_create(tc: &PartialToolCallData) -> Option<ActionType> {
    let parsed_title_json = tc
        .title
        .trim_start()
        .starts_with('{')
        .then(|| serde_json::from_str::<serde_json::Value>(&tc.title).ok())
        .flatten();
    let arguments = tc.raw_input.as_ref().or(parsed_title_json.as_ref());
    let tool_name =
        extract_task_tool_name(tc.id.0.as_ref()).unwrap_or_else(|| tc.title.trim().to_string());

    let has_task_signal = is_task_like_name(&tool_name)
        || is_task_like_name(&tc.title)
        || extract_string_argument(
            arguments,
            &[
                "description",
                "prompt",
                "task",
                "subagent_type",
                "agent_type",
            ],
        )
        .is_some();

    if !has_task_signal {
        return None;
    }

    let description = extract_string_argument(
        arguments,
        &[
            "description",
            "prompt",
            "task",
            "title",
            "summary",
            "message",
            "instruction",
        ],
    )
    .or_else(|| extract_task_description_from_title(&tc.title, &tool_name))
    .or_else(|| collect_text_content_blocks(&tc.content))
    .filter(|text| !text.trim().is_empty())
    .unwrap_or_else(|| tool_name.clone());

    let subagent_type = extract_string_argument(
        arguments,
        &["subagent_type", "agent_type", "agent", "kind", "role"],
    );

    Some(ActionType::TaskCreate {
        description: description.trim().trim_matches('`').to_string(),
        subagent_type,
        result: collect_tool_result(tc),
    })
}

fn collect_tool_result(tc: &PartialToolCallData) -> Option<ToolResult> {
    if let Some(output) = &tc.raw_output {
        Some(ToolResult {
            r#type: ToolResultValueType::Json,
            value: output.clone(),
        })
    } else {
        collect_text_content_blocks(&tc.content).map(|text| ToolResult {
            r#type: ToolResultValueType::Markdown,
            value: serde_json::Value::String(text),
        })
    }
}

fn collect_text_content_blocks(
    content: &[agent_client_protocol::ToolCallContent],
) -> Option<String> {
    let mut out = String::new();
    for item in content {
        if let agent_client_protocol::ToolCallContent::Content(inner) = item
            && let agent_client_protocol::ContentBlock::Text(text) = &inner.content
        {
            out.push_str(&text.text);
            if !out.ends_with('\n') {
                out.push('\n');
            }
        }
    }
    if out.trim().is_empty() {
        None
    } else {
        Some(out.trim().to_string())
    }
}

fn extract_task_description_from_title(title: &str, tool_name: &str) -> Option<String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return None;
    }

    let normalized_tool_name = normalize_task_name(tool_name);
    let normalized_title = normalize_task_name(trimmed);
    if normalized_title == normalized_tool_name {
        return None;
    }

    for separator in [":", "-", "=>"] {
        if let Some((prefix, rest)) = trimmed.split_once(separator)
            && normalize_task_name(prefix) == normalized_tool_name
            && !rest.trim().is_empty()
        {
            return Some(rest.trim().to_string());
        }
    }

    Some(trimmed.to_string())
}

fn extract_string_argument(value: Option<&serde_json::Value>, keys: &[&str]) -> Option<String> {
    let value = value?;
    if let Some(text) = value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        return Some(text.to_string());
    }

    let object = value.as_object()?;
    keys.iter().find_map(|key| {
        object.get(*key).and_then(|candidate| {
            candidate
                .as_str()
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(ToOwned::to_owned)
        })
    })
}

fn extract_task_tool_name(id: &str) -> Option<String> {
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

fn normalize_task_name(name: &str) -> String {
    name.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect()
}

fn is_task_like_name(name: &str) -> bool {
    let normalized = normalize_task_name(name);
    ["task", "task_create", "create_task", "subagent", "delegate"]
        .iter()
        .any(|candidate| {
            normalized == *candidate
                || normalized.starts_with(&format!("{candidate}_"))
                || normalized.ends_with(&format!("_{candidate}"))
                || normalized.contains(&format!("_{candidate}_"))
        })
}

#[cfg(test)]
mod tests {
    use agent_client_protocol::{
        Plan, PlanEntry, PlanEntryPriority, PlanEntryStatus, ToolCallId, ToolCallStatus, ToolKind,
    };
    use serde_json::json;

    use super::{PartialToolCallData, format_plan_markdown, heuristically_extract_task_create};
    use crate::logs::ActionType;

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

        let action = heuristically_extract_task_create(&tool_call).expect("task action");
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
}

struct PartialToolCallData {
    index: usize,
    id: agent_client_protocol::ToolCallId,
    kind: agent_client_protocol::ToolKind,
    title: String,
    status: agent_client_protocol::ToolCallStatus,
    path: Option<PathBuf>,
    content: Vec<agent_client_protocol::ToolCallContent>,
    raw_input: Option<serde_json::Value>,
    raw_output: Option<serde_json::Value>,
}

impl PartialToolCallData {
    fn extend(&mut self, tc: &agent_client_protocol::ToolCall, worktree_path: &Path) {
        self.id = tc.tool_call_id.clone();
        if tc.kind != Default::default() {
            self.kind = tc.kind;
        }
        if !tc.title.is_empty() {
            self.title = tc.title.clone();
        }
        if tc.status != Default::default() {
            self.status = tc.status;
        }
        if !tc.locations.is_empty() {
            self.path = tc.locations.first().map(|l| {
                PathBuf::from(workspace_utils::path::make_path_relative(
                    &l.path.to_string_lossy(),
                    &worktree_path.to_string_lossy(),
                ))
            });
        }
        if !tc.content.is_empty() {
            self.content = tc.content.clone();
        }
        if tc.raw_input.is_some() {
            self.raw_input = tc.raw_input.clone();
        }
        if tc.raw_output.is_some() {
            self.raw_output = tc.raw_output.clone();
        }
    }
}

impl Default for PartialToolCallData {
    fn default() -> Self {
        Self {
            id: agent_client_protocol::ToolCallId::new(""),
            index: 0,
            kind: agent_client_protocol::ToolKind::default(),
            title: String::new(),
            status: Default::default(),
            path: None,
            content: Vec::new(),
            raw_input: None,
            raw_output: None,
        }
    }
}

struct AcpEventParser;

impl AcpEventParser {
    /// Parse a line that may contain an ACP event
    pub fn parse_line(line: &str) -> Option<AcpEvent> {
        let trimmed = line.trim();

        if let Ok(acp_event) = serde_json::from_str::<AcpEvent>(trimmed) {
            return Some(acp_event);
        }

        tracing::debug!("Failed to parse ACP raw log {trimmed}");

        None
    }

    /// Parse command from tool title (for execute tools)
    pub fn parse_execute_command(tc: &PartialToolCallData) -> String {
        if let Some(command) = tc.raw_input.as_ref().and_then(|value| {
            value
                .as_object()
                .and_then(|o| o.get("command").and_then(|v| v.as_str()))
        }) {
            return command.to_string();
        }
        let title = &tc.title;
        if let Some(command) = title.split(" [current working directory ").next() {
            command.trim().to_string()
        } else if let Some(command) = title.split(" (").next() {
            command.trim().to_string()
        } else {
            title.trim().to_string()
        }
    }
}

/// Result of parsing a line
#[derive(Debug, Clone)]
#[allow(clippy::large_enum_variant)]
pub enum ParsedLine {
    SessionId(String),
    Event(AcpEvent),
    Error(String),
    Done,
}

impl TryFrom<SessionNotification> for AcpEvent {
    type Error = ();

    fn try_from(notification: SessionNotification) -> Result<Self, ()> {
        let event = match notification.update {
            acp::SessionUpdate::AgentMessageChunk(chunk) => AcpEvent::Message(chunk.content),
            acp::SessionUpdate::AgentThoughtChunk(chunk) => AcpEvent::Thought(chunk.content),
            acp::SessionUpdate::ToolCall(tc) => AcpEvent::ToolCall(tc),
            acp::SessionUpdate::ToolCallUpdate(update) => AcpEvent::ToolUpdate(update),
            acp::SessionUpdate::Plan(plan) => AcpEvent::Plan(plan),
            acp::SessionUpdate::AvailableCommandsUpdate(update) => {
                AcpEvent::AvailableCommands(update.available_commands)
            }
            acp::SessionUpdate::CurrentModeUpdate(update) => {
                AcpEvent::CurrentMode(update.current_mode_id)
            }
            _ => return Err(()),
        };
        Ok(event)
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

#[derive(Debug, Clone, Default)]
struct StreamingState {
    assistant_text: Option<StreamingText>,
    thinking_text: Option<StreamingText>,
}

#[derive(Debug, Clone)]
struct StreamingText {
    index: usize,
    content: String,
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
