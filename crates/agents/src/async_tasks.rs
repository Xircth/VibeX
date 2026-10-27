//! AIR `asyncTasks` (`async_task_spawned`, `async_task_progress`,
//! `async_task_state_update`, and Grok `workflow_updated`) state projection and
//! `_session/async_task/stop` helpers.

use api_types::AgentKind;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;

use crate::air_contract::{legacy_or_air, speaks_air_contract};

pub const ASYNC_TASK_STOP_METHOD: &str = "_session/async_task/stop";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AsyncTaskUsage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_uses: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

/// Live or settled background task projected onto session state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AsyncTaskRecord {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// `"running"` | `"paused"` | `"completed"` | `"failed"` | `"stopped"`
    pub state: String,
    #[serde(default)]
    pub can_stop: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_file_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<AsyncTaskUsage>,
}

/// Incremental update for an async task (`spawned = true` only on
/// `async_task_spawned` or Grok `workflow_updated`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AsyncTaskDelta {
    pub id: String,
    #[serde(default)]
    pub spawned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_stop: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_file_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<AsyncTaskUsage>,
}

pub fn async_task_state_is_terminal(state: &str) -> bool {
    matches!(state, "completed" | "failed" | "stopped")
}

/// Apply an `AsyncTaskDelta` to the session's task table.
///
/// Rules (Codeg baseline):
/// - Only `spawned: true` creates a new entry. Non-spawn updates for an unknown
///   `id` are dropped (`false`).
/// - Omitted fields (`None`) in progress/state deltas leave the existing field
///   unchanged.
/// - Terminal states (`completed`/`failed`/`stopped`) remain in `tasks` so late
///   `output_file_path` or `stopped` -> `completed` corrections still land; the
///   UI filters `liveAsyncTasks` to non-terminal records.
pub fn apply_async_task_delta(tasks: &mut Vec<AsyncTaskRecord>, delta: &AsyncTaskDelta) -> bool {
    if delta.id.trim().is_empty() {
        return false;
    }
    if let Some(existing) = tasks.iter_mut().find(|task| task.id == delta.id) {
        let before = existing.clone();
        if let Some(task_type) = &delta.task_type {
            existing.task_type = Some(task_type.clone());
        }
        if let Some(name) = &delta.name {
            existing.name = Some(name.clone());
        }
        if let Some(state) = &delta.state {
            existing.state = state.clone();
        }
        if let Some(can_stop) = delta.can_stop {
            existing.can_stop = can_stop;
        }
        if let Some(phase) = &delta.phase {
            existing.phase = Some(phase.clone());
        }
        if let Some(current_agent) = &delta.current_agent {
            existing.current_agent = Some(current_agent.clone());
        }
        if let Some(last_tool_name) = &delta.last_tool_name {
            existing.last_tool_name = Some(last_tool_name.clone());
        }
        if let Some(output_file_path) = &delta.output_file_path {
            existing.output_file_path = Some(output_file_path.clone());
        }
        if let Some(tool_call_id) = &delta.tool_call_id {
            existing.tool_call_id = Some(tool_call_id.clone());
        }
        if let Some(incoming_usage) = &delta.usage {
            let mut merged = existing.usage.clone().unwrap_or_default();
            if incoming_usage.total_tokens.is_some() {
                merged.total_tokens = incoming_usage.total_tokens;
            }
            if incoming_usage.tool_uses.is_some() {
                merged.tool_uses = incoming_usage.tool_uses;
            }
            if incoming_usage.duration_ms.is_some() {
                merged.duration_ms = incoming_usage.duration_ms;
            }
            existing.usage = Some(merged);
        }
        return *existing != before;
    }

    if !delta.spawned {
        return false;
    }

    tasks.push(AsyncTaskRecord {
        id: delta.id.clone(),
        task_type: delta.task_type.clone(),
        name: delta.name.clone(),
        state: delta.state.clone().unwrap_or_else(|| "running".to_string()),
        can_stop: delta.can_stop.unwrap_or(false),
        phase: delta.phase.clone(),
        current_agent: delta.current_agent.clone(),
        last_tool_name: delta.last_tool_name.clone(),
        output_file_path: delta.output_file_path.clone(),
        tool_call_id: delta.tool_call_id.clone(),
        usage: delta.usage.clone(),
    });
    true
}

fn non_empty_str(obj: &Map<String, Value>, key: &str) -> Option<String> {
    obj.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
}

fn parse_usage(obj: &Map<String, Value>) -> Option<AsyncTaskUsage> {
    let usage = obj.get("usage")?.as_object()?;
    let parsed = AsyncTaskUsage {
        total_tokens: usage
            .get("totalTokens")
            .or_else(|| usage.get("total_tokens"))
            .and_then(Value::as_u64),
        tool_uses: usage
            .get("toolUses")
            .or_else(|| usage.get("tool_uses"))
            .and_then(Value::as_u64),
        duration_ms: usage
            .get("durationMs")
            .or_else(|| usage.get("duration_ms"))
            .and_then(Value::as_u64),
    };
    if parsed.total_tokens.is_none() && parsed.tool_uses.is_none() && parsed.duration_ms.is_none() {
        None
    } else {
        Some(parsed)
    }
}

/// Parse an AIR `async_task_spawned`, `async_task_progress`, or
/// `async_task_state_update` sessionUpdate object.
pub fn parse_async_task_session_update(
    agent_kind: Option<AgentKind>,
    update: &Value,
) -> Option<AsyncTaskDelta> {
    if !agent_kind.is_none_or(speaks_air_contract) {
        return None;
    }
    let obj = update.as_object()?;
    let session_update = obj.get("sessionUpdate").and_then(Value::as_str)?;
    if !matches!(
        session_update,
        "async_task_spawned" | "async_task_progress" | "async_task_state_update"
    ) {
        return None;
    }
    let meta = obj.get("_meta").and_then(Value::as_object);
    let payload = legacy_or_air(meta, "asyncTasks")
        .and_then(Value::as_object)
        .unwrap_or(obj);

    let id = non_empty_str(payload, "taskId")
        .or_else(|| non_empty_str(payload, "asyncTaskId"))
        .or_else(|| non_empty_str(obj, "taskId"))
        .or_else(|| non_empty_str(obj, "asyncTaskId"))?;

    let spawned = session_update == "async_task_spawned";
    let task_type = non_empty_str(payload, "taskType")
        .or_else(|| non_empty_str(payload, "type"))
        .or_else(|| non_empty_str(obj, "taskType"));
    let name = non_empty_str(payload, "description")
        .or_else(|| non_empty_str(payload, "summary"))
        .or_else(|| non_empty_str(payload, "title"))
        .or_else(|| non_empty_str(payload, "name"))
        .or_else(|| non_empty_str(obj, "description"))
        .or_else(|| non_empty_str(obj, "summary"))
        .or_else(|| non_empty_str(obj, "title"))
        .or_else(|| non_empty_str(obj, "name"));
    let state = non_empty_str(payload, "state")
        .or_else(|| non_empty_str(payload, "status"))
        .or_else(|| non_empty_str(obj, "state"))
        .or_else(|| non_empty_str(obj, "status"))
        .map(|raw| match raw.as_str() {
            "in_progress" | "active" => "running".to_string(),
            "cancelled" | "canceled" | "killed" => "stopped".to_string(),
            other => other.to_string(),
        })
        .or_else(|| spawned.then(|| "running".to_string()));
    let can_stop = payload
        .get("canStop")
        .or_else(|| obj.get("canStop"))
        .and_then(Value::as_bool)
        .or_else(|| spawned.then_some(true));
    let phase = non_empty_str(payload, "phase").or_else(|| non_empty_str(obj, "phase"));
    let current_agent =
        non_empty_str(payload, "currentAgent").or_else(|| non_empty_str(obj, "currentAgent"));
    let last_tool_name =
        non_empty_str(payload, "lastToolName").or_else(|| non_empty_str(obj, "lastToolName"));
    let output_file_path =
        non_empty_str(payload, "outputFilePath").or_else(|| non_empty_str(obj, "outputFilePath"));
    let tool_call_id =
        non_empty_str(payload, "toolCallId").or_else(|| non_empty_str(obj, "toolCallId"));
    let usage = parse_usage(payload).or_else(|| parse_usage(obj));

    Some(AsyncTaskDelta {
        id,
        spawned,
        task_type,
        name,
        state,
        can_stop,
        phase,
        current_agent,
        last_tool_name,
        output_file_path,
        tool_call_id,
        usage,
    })
}

/// Parse Grok's `workflow_updated` extension notification into an `AsyncTaskDelta`.
/// Grok does not expose `_session/async_task/stop`, so `can_stop` is `Some(false)`.
pub fn parse_grok_workflow_updated(params: &Value) -> Option<(Option<String>, AsyncTaskDelta)> {
    let obj = params.as_object()?;
    let session_id = non_empty_str(obj, "sessionId").or_else(|| non_empty_str(obj, "session_id"));
    let workflow = obj
        .get("workflow")
        .and_then(Value::as_object)
        .unwrap_or(obj);
    let id = non_empty_str(workflow, "workflowId")
        .or_else(|| non_empty_str(workflow, "id"))
        .or_else(|| non_empty_str(obj, "workflowId"))?;
    let name = non_empty_str(workflow, "name")
        .or_else(|| non_empty_str(workflow, "title"))
        .or_else(|| non_empty_str(workflow, "description"));
    let raw_state = non_empty_str(workflow, "state")
        .or_else(|| non_empty_str(workflow, "status"))
        .unwrap_or_else(|| "running".to_string());
    let state = match raw_state.as_str() {
        "in_progress" | "active" | "running" => "running",
        "paused" | "waiting" => "paused",
        "completed" | "done" | "succeeded" => "completed",
        "failed" | "error" => "failed",
        "stopped" | "cancelled" | "canceled" => "stopped",
        other => other,
    }
    .to_string();
    let phase = non_empty_str(workflow, "phase").or_else(|| non_empty_str(workflow, "step"));
    let current_agent =
        non_empty_str(workflow, "currentAgent").or_else(|| non_empty_str(workflow, "agent"));
    let last_tool_name = non_empty_str(workflow, "lastToolName");

    Some((
        session_id,
        AsyncTaskDelta {
            id,
            spawned: true,
            task_type: Some("workflow".to_string()),
            name,
            state: Some(state),
            can_stop: Some(false),
            phase,
            current_agent,
            last_tool_name,
            output_file_path: None,
            tool_call_id: None,
            usage: parse_usage(workflow),
        },
    ))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn non_spawn_delta_for_unknown_task_is_dropped() {
        let mut tasks = Vec::new();
        let progress = parse_async_task_session_update(
            Some(AgentKind::ClaudeCode),
            &json!({
                "sessionUpdate": "async_task_progress",
                "taskId": "task-1",
                "summary": "Halfway done"
            }),
        )
        .expect("parsed progress delta");
        assert!(!progress.spawned);
        assert!(!apply_async_task_delta(&mut tasks, &progress));
        assert!(tasks.is_empty());
    }

    #[test]
    fn spawned_task_merges_partial_progress_and_retains_terminal_entry_for_late_updates() {
        let mut tasks = Vec::new();
        let spawned = parse_async_task_session_update(
            Some(AgentKind::ClaudeCode),
            &json!({
                "sessionUpdate": "async_task_spawned",
                "taskId": "bg-1",
                "taskType": "shell",
                "description": "npm run watch",
                "canStop": true,
                "toolCallId": "toolu_bash_1",
                "outputFilePath": "/tmp/bg-1.log"
            }),
        )
        .expect("spawned delta");
        assert!(apply_async_task_delta(&mut tasks, &spawned));
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].state, "running");
        assert!(tasks[0].can_stop);
        assert_eq!(tasks[0].name.as_deref(), Some("npm run watch"));

        // Progress omits description/outputFilePath/canStop; existing values must remain:
        let progress = parse_async_task_session_update(
            Some(AgentKind::ClaudeCode),
            &json!({
                "sessionUpdate": "async_task_progress",
                "taskId": "bg-1",
                "phase": "building",
                "usage": { "totalTokens": 1200, "toolUses": 3 }
            }),
        )
        .expect("progress delta");
        assert!(apply_async_task_delta(&mut tasks, &progress));
        assert_eq!(tasks[0].name.as_deref(), Some("npm run watch"));
        assert_eq!(tasks[0].output_file_path.as_deref(), Some("/tmp/bg-1.log"));
        assert_eq!(tasks[0].phase.as_deref(), Some("building"));
        assert_eq!(
            tasks[0].usage.as_ref().and_then(|u| u.total_tokens),
            Some(1200)
        );

        // State update to stopped keeps entry in table so late completed correction lands:
        let stopped = parse_async_task_session_update(
            Some(AgentKind::ClaudeCode),
            &json!({
                "sessionUpdate": "async_task_state_update",
                "taskId": "bg-1",
                "state": "stopped"
            }),
        )
        .expect("stopped delta");
        assert!(apply_async_task_delta(&mut tasks, &stopped));
        assert!(async_task_state_is_terminal(&tasks[0].state));

        let completed = parse_async_task_session_update(
            Some(AgentKind::ClaudeCode),
            &json!({
                "sessionUpdate": "async_task_state_update",
                "taskId": "bg-1",
                "state": "completed",
                "outputFilePath": "/tmp/bg-1-final.log"
            }),
        )
        .expect("completed delta");
        assert!(apply_async_task_delta(&mut tasks, &completed));
        assert_eq!(tasks[0].state, "completed");
        assert_eq!(
            tasks[0].output_file_path.as_deref(),
            Some("/tmp/bg-1-final.log")
        );
    }

    #[test]
    fn grok_workflow_updated_creates_non_stoppable_workflow_row() {
        let (session_id, delta) = parse_grok_workflow_updated(&json!({
            "sessionId": "sess-grok",
            "workflow": {
                "id": "wf-1",
                "name": "Deep Research",
                "state": "in_progress",
                "phase": "synthesizing",
                "currentAgent": "researcher"
            }
        }))
        .expect("grok workflow");
        assert_eq!(session_id.as_deref(), Some("sess-grok"));
        assert!(delta.spawned);
        assert_eq!(delta.can_stop, Some(false));
        assert_eq!(delta.task_type.as_deref(), Some("workflow"));
        assert_eq!(delta.state.as_deref(), Some("running"));
    }
}
