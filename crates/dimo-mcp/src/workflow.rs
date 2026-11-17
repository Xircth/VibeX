//! Built-in native Workflow MCP tools served directly by `dimo-mcp`
//! (`Dimo-superagent-mcp`), replacing the legacy Node-based `dimo-workflow-mcp`.

use std::{fs, path::Path};

use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    pulse_bridge::HostCommandCaller,
    workflow_patch::{
        MAX_SOURCE_BYTES, atomic_cas_write_text, error_result, execute_workflow_graph_patch,
        resolve_safe_source_path, sha256_revision, str_prop, violation,
    },
};

const WORKFLOW_TOOL_SCHEMA: &str = include_str!("../workflow_tool_schema.json");

pub fn workflow_tool_schemas() -> Vec<Value> {
    serde_json::from_str(WORKFLOW_TOOL_SCHEMA).expect("embedded workflow tool schema is valid")
}

pub fn is_workflow_tool(name: &str) -> bool {
    matches!(
        name,
        "workflow_source_read"
            | "workflow_source_write"
            | "workflow_graph_patch"
            | "workflow_validate"
            | "workflow_publish"
            | "workflow_catalog"
            | "workflow_run_inspect"
            | "workflow_start"
            | "workflow_debug_source"
            | "workflow_debug_from_step"
            | "workflow_pause_run"
            | "workflow_cancel_run"
            | "workflow_resume_run"
            | "workflow_pause_step"
            | "workflow_continue_step"
            | "workflow_accept_candidate"
            | "workflow_review_step"
            | "workflow_decide_approval"
    )
}

pub async fn execute_workflow_tool<C: HostCommandCaller>(
    caller: &C,
    name: &str,
    arguments: &Value,
    workspace_root: Option<&Path>,
) -> Result<Value, String> {
    if name == "workflow_graph_patch" {
        return Ok(execute_workflow_graph_patch(arguments, workspace_root));
    }

    let op_id = str_prop(arguments, &["operation_id", "operationId"])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    match name {
        "workflow_source_read" => {
            let Some(rel_path) = str_prop(arguments, &["path"])
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                return Ok(error_result(
                    vec![violation("path", "missing_path", "path is required.")],
                    "path is required.",
                    None,
                ));
            };
            let target = match resolve_safe_source_path(rel_path, workspace_root) {
                Ok(path) => path,
                Err(msg) => {
                    return Ok(error_result(
                        vec![violation("path", "invalid_source_path", &msg)],
                        &msg,
                        None,
                    ));
                }
            };
            let content = match fs::read_to_string(&target) {
                Ok(text) => text,
                Err(err) => {
                    let msg = format!("Failed to read workflow source '{rel_path}': {err}");
                    return Ok(error_result(
                        vec![violation("path", "io_error", &msg)],
                        &msg,
                        None,
                    ));
                }
            };
            if content.len() > MAX_SOURCE_BYTES {
                return Ok(error_result(
                    vec![violation(
                        "path",
                        "source_too_large",
                        "Workflow source exceeds 4 MiB.",
                    )],
                    "Workflow source exceeds 4 MiB.",
                    None,
                ));
            }
            let definition: Value = match serde_json::from_str(&content) {
                Ok(val) => val,
                Err(err) => {
                    let msg = format!("Invalid JSON in workflow source '{rel_path}': {err}");
                    return Ok(error_result(
                        vec![violation("path", "invalid_json", &msg)],
                        &msg,
                        None,
                    ));
                }
            };
            Ok(json!({
                "path": rel_path,
                "definition": definition,
                "revision": sha256_revision(content.as_bytes()),
            }))
        }
        "workflow_source_write" => {
            let Some(rel_path) = str_prop(arguments, &["path"])
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                return Ok(error_result(
                    vec![violation("path", "missing_path", "path is required.")],
                    "path is required.",
                    None,
                ));
            };
            let target = match resolve_safe_source_path(rel_path, workspace_root) {
                Ok(path) => path,
                Err(msg) => {
                    return Ok(error_result(
                        vec![violation("path", "invalid_source_path", &msg)],
                        &msg,
                        None,
                    ));
                }
            };
            let Some(definition) = arguments.get("definition").filter(|v| v.is_object()) else {
                return Ok(error_result(
                    vec![violation(
                        "definition",
                        "invalid_definition",
                        "definition must be a JSON object.",
                    )],
                    "definition must be a JSON object.",
                    None,
                ));
            };
            // Validate canonically against the live Host command registry before saving.
            if let Err(err) = caller
                .call_host_command(
                    "workflow_validate",
                    &op_id,
                    &json!({ "request": { "definition": definition } }),
                )
                .await
            {
                return Ok(err.into_mcp_error_outcome());
            }

            let serialized = match serde_json::to_string_pretty(definition) {
                Ok(s) => format!("{s}\n"),
                Err(err) => {
                    return Ok(error_result(
                        vec![violation(
                            "definition",
                            "serialization_error",
                            &err.to_string(),
                        )],
                        &err.to_string(),
                        None,
                    ));
                }
            };
            let expected_rev = str_prop(arguments, &["expectedRevision", "expected_revision"])
                .map(str::trim)
                .filter(|s| !s.is_empty());
            match atomic_cas_write_text(&target, &serialized, expected_rev) {
                Ok(revision) => Ok(json!({
                    "path": rel_path,
                    "revision": revision,
                })),
                Err((code, msg)) => Ok(error_result(
                    vec![violation("expectedRevision", code, &msg)],
                    &msg,
                    None,
                )),
            }
        }
        "workflow_validate" => call_wrapped(
            caller,
            "workflow_validate",
            &op_id,
            &json!({
                "request": {
                    "definition": arguments.get("definition").cloned().unwrap_or(Value::Null),
                }
            }),
        )
        .await,
        "workflow_publish" => call_wrapped(
            caller,
            "workflow_publish",
            &op_id,
            &json!({
                "request": {
                    "definition": arguments.get("definition").cloned().unwrap_or(Value::Null),
                    "definitionId": arguments.get("definitionId").cloned().unwrap_or(Value::Null),
                    "sourcePath": arguments.get("sourcePath").cloned().unwrap_or(Value::Null),
                }
            }),
        )
        .await,
        "workflow_catalog" => {
            if let Some(def_id) = str_prop(arguments, &["definitionId", "definition_id"])
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                call_wrapped(
                    caller,
                    "workflow_versions",
                    &op_id,
                    &json!({ "definitionId": def_id, "limit": 100 }),
                )
                .await
            } else {
                call_wrapped(caller, "workflow_list", &op_id, &json!({ "limit": 100 })).await
            }
        }
        "workflow_run_inspect" => {
            let run_id = str_prop(arguments, &["runId", "run_id"])
                .unwrap_or("")
                .trim()
                .to_string();
            let run = match caller
                .call_host_command("workflow_show", &op_id, &json!({ "runId": run_id }))
                .await
            {
                Ok(v) => v,
                Err(err) => return Ok(err.into_mcp_error_outcome()),
            };
            let version_id = run
                .get("definitionVersionId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let version_op = format!("{op_id}-ver");
            let steps_op = format!("{op_id}-steps");
            let version_args = json!({ "versionId": version_id });
            let steps_args = json!({ "runId": run_id });
            let (version_res, steps_res, events_res) = tokio::join!(
                caller.call_host_command("workflow_version", &version_op, &version_args),
                caller.call_host_command("workflow_steps", &steps_op, &steps_args),
                fetch_all_events(caller, &op_id, &run_id)
            );
            let version = match version_res {
                Ok(v) => v,
                Err(err) => return Ok(err.into_mcp_error_outcome()),
            };
            let steps = match steps_res {
                Ok(v) => v,
                Err(err) => return Ok(err.into_mcp_error_outcome()),
            };
            let events = match events_res {
                Ok(v) => v,
                Err(err) => return Ok(err.into_mcp_error_outcome()),
            };
            let definition = version
                .get("normalizedJson")
                .and_then(Value::as_str)
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .unwrap_or(Value::Null);
            Ok(json!({
                "run": run,
                "version": version,
                "definition": definition,
                "steps": steps,
                "events": events,
            }))
        }
        "workflow_start" => call_wrapped(
            caller,
            "workflow_start",
            &op_id,
            &json!({
                "request": {
                    "definitionVersionId": arguments.get("definitionVersionId").cloned().unwrap_or(Value::Null),
                    "workspaceId": arguments.get("workspaceId").cloned().unwrap_or(Value::Null),
                    "input": arguments.get("input").cloned().unwrap_or_else(|| json!({})),
                    "policyOverride": arguments.get("policyOverride").cloned().unwrap_or(Value::Null),
                    "debugStepId": arguments.get("debugStepId").cloned().unwrap_or(Value::Null),
                }
            }),
        )
        .await,
        "workflow_debug_source" => call_wrapped(
            caller,
            "workflow_debug",
            &op_id,
            &json!({
                "request": {
                    "definition": arguments.get("definition").cloned().unwrap_or(Value::Null),
                    "definitionId": arguments.get("definitionId").cloned().unwrap_or(Value::Null),
                    "sourcePath": arguments.get("sourcePath").cloned().unwrap_or(Value::Null),
                    "workspaceId": arguments.get("workspaceId").cloned().unwrap_or(Value::Null),
                    "input": arguments.get("input").cloned().unwrap_or_else(|| json!({})),
                    "policyOverride": arguments.get("policyOverride").cloned().unwrap_or(Value::Null),
                    "stepId": arguments.get("stepId").cloned().unwrap_or(Value::Null),
                    "parentRunId": arguments.get("parentRunId").cloned().unwrap_or(Value::Null),
                    "scope": arguments.get("scope").cloned().unwrap_or_else(|| json!("node")),
                }
            }),
        )
        .await,
        "workflow_debug_from_step" => call_wrapped(
            caller,
            "workflow_fork",
            &op_id,
            &json!({ "request": arguments }),
        )
        .await,
        "workflow_pause_run" => call_wrapped(
            caller,
            "workflow_pause",
            &op_id,
            &json!({
                "request": {
                    "runId": arguments.get("runId").cloned().unwrap_or(Value::Null),
                    "reason": arguments.get("reason").cloned().unwrap_or(Value::Null),
                }
            }),
        )
        .await,
        "workflow_cancel_run" => call_wrapped(
            caller,
            "workflow_cancel",
            &op_id,
            &json!({
                "request": {
                    "runId": arguments.get("runId").cloned().unwrap_or(Value::Null),
                    "reason": arguments.get("reason").cloned().unwrap_or(Value::Null),
                }
            }),
        )
        .await,
        "workflow_resume_run" => call_wrapped(
            caller,
            "workflow_resume_run",
            &op_id,
            &json!({
                "request": {
                    "runId": arguments.get("runId").cloned().unwrap_or(Value::Null),
                }
            }),
        )
        .await,
        "workflow_pause_step" => call_wrapped(
            caller,
            "workflow_pause_step",
            &op_id,
            &json!({
                "request": {
                    "runId": arguments.get("runId").cloned().unwrap_or(Value::Null),
                    "stepId": arguments.get("stepId").cloned().unwrap_or(Value::Null),
                    "reason": arguments.get("reason").cloned().unwrap_or(Value::Null),
                }
            }),
        )
        .await,
        "workflow_continue_step" => call_wrapped(
            caller,
            "workflow_step_input",
            &op_id,
            &json!({ "request": arguments }),
        )
        .await,
        "workflow_accept_candidate" => call_wrapped(
            caller,
            "workflow_accept_candidate",
            &op_id,
            &json!({ "request": arguments }),
        )
        .await,
        "workflow_review_step" => {
            let action = str_prop(arguments, &["action"]).unwrap_or("");
            let step_id = arguments.get("stepId").cloned().unwrap_or(Value::Null);
            let mut decision = json!({
                "kind": action,
                "step_id": step_id,
            });
            if action == "accept"
                && let Some(obj) = decision.as_object_mut()
            {
                obj.insert(
                    "output".into(),
                    arguments.get("output").cloned().unwrap_or(Value::Null),
                );
            }
            call_wrapped(
                caller,
                "workflow_resume",
                &op_id,
                &json!({
                    "request": {
                        "runId": arguments.get("runId").cloned().unwrap_or(Value::Null),
                        "decision": decision,
                    }
                }),
            )
            .await
        }
        "workflow_decide_approval" => call_wrapped(
            caller,
            "workflow_decide",
            &op_id,
            &json!({ "request": arguments }),
        )
        .await,
        other => Err(format!("unknown workflow tool: {other}")),
    }
}

async fn call_wrapped<C: HostCommandCaller>(
    caller: &C,
    command: &str,
    op_id: &str,
    args: &Value,
) -> Result<Value, String> {
    match caller.call_host_command(command, op_id, args).await {
        Ok(data) => Ok(data),
        Err(err) => Ok(err.into_mcp_error_outcome()),
    }
}

async fn fetch_all_events<C: HostCommandCaller>(
    caller: &C,
    base_op_id: &str,
    run_id: &str,
) -> Result<Vec<Value>, crate::client::HostCallError> {
    let mut all = Vec::new();
    let mut after_sequence: i64 = 0;
    let mut page_idx: usize = 0;
    loop {
        let page_op = format!("{base_op_id}-ev-{page_idx}");
        let value = caller
            .call_host_command(
                "workflow_events",
                &page_op,
                &json!({
                    "runId": run_id,
                    "afterSequence": after_sequence,
                    "limit": 500,
                }),
            )
            .await?;
        let Some(page) = value.as_array() else {
            break;
        };
        let count = page.len();
        all.extend(page.iter().cloned());
        if count < 500 {
            break;
        }
        let next = page
            .last()
            .and_then(|ev| ev.get("sequence"))
            .and_then(Value::as_i64)
            .unwrap_or(after_sequence);
        if next <= after_sequence {
            break;
        }
        after_sequence = next;
        page_idx += 1;
    }
    Ok(all)
}
