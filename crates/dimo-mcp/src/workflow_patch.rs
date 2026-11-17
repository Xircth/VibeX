//! Declarative Dual-Primitive `workflow_graph_patch` MCP engine with exhaustive
//! No-Fail-Fast graph/step validation, 5 orchestrator presets, and CAS source
//! file persistence.

use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    fs::{self, OpenOptions},
    io::Write as _,
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::workflow_presets::build_preset_workflow;

pub const MAX_SOURCE_BYTES: usize = 4 * 1024 * 1024;
const MAX_BOUNDED_LOOP_ITERATIONS: i64 = 50;
static TMP_SEQ: AtomicU64 = AtomicU64::new(1);

pub fn sha256_revision(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

pub(crate) fn violation(path: &str, code: &str, message: &str) -> Value {
    json!({
        "path": path,
        "code": code,
        "message": message,
    })
}

pub(crate) fn str_prop<'a>(obj: &'a Value, keys: &[&str]) -> Option<&'a str> {
    for key in keys {
        if let Some(s) = obj.get(*key).and_then(Value::as_str) {
            return Some(s);
        }
    }
    None
}

pub(crate) fn i64_prop(obj: &Value, keys: &[&str]) -> Option<i64> {
    for key in keys {
        if let Some(n) = obj.get(*key).and_then(Value::as_i64) {
            return Some(n);
        }
    }
    None
}

fn bool_prop(obj: &Value, keys: &[&str]) -> Option<bool> {
    for key in keys {
        if let Some(b) = obj.get(*key).and_then(Value::as_bool) {
            return Some(b);
        }
    }
    None
}

fn arr_prop<'a>(obj: &'a Value, keys: &[&str]) -> Option<&'a [Value]> {
    for key in keys {
        if let Some(a) = obj.get(*key).and_then(Value::as_array) {
            return Some(a.as_slice());
        }
    }
    None
}

pub fn execute_workflow_graph_patch(args: &Value, workspace_root: Option<&Path>) -> Value {
    let mut violations = Vec::new();
    let path_arg = str_prop(args, &["path"])
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let has_inline_def = args.get("definition").is_some_and(|v| !v.is_null());
    let should_write = bool_prop(args, &["write", "persist"])
        .unwrap_or_else(|| path_arg.is_some() && !has_inline_def);

    let resolved_target = match path_arg {
        Some(rel) => match resolve_safe_source_path(rel, workspace_root) {
            Ok(target) => Some((rel.to_string(), target)),
            Err(err) => {
                return error_result(
                    vec![violation("path", "invalid_source_path", &err)],
                    &err,
                    None,
                );
            }
        },
        None => None,
    };

    let mut existing_disk_content: Option<String> = None;
    if let Some((_, ref target)) = resolved_target
        && target.exists()
    {
        match fs::read_to_string(target) {
            Ok(content) => {
                if content.len() > MAX_SOURCE_BYTES {
                    return error_result(
                        vec![violation(
                            "path",
                            "source_too_large",
                            "Workflow source exceeds 4 MiB.",
                        )],
                        "Workflow source exceeds 4 MiB.",
                        None,
                    );
                }
                existing_disk_content = Some(content);
            }
            Err(err) => {
                let msg = format!("Failed to read workflow source: {err}");
                return error_result(vec![violation("path", "io_error", &msg)], &msg, None);
            }
        }
    }

    let mut definition = if let Some(inline) = args.get("definition").filter(|v| !v.is_null()) {
        if !inline.is_object() {
            return error_result(
                vec![violation(
                    "definition",
                    "invalid_definition",
                    "definition must be a JSON object.",
                )],
                "definition must be a JSON object.",
                None,
            );
        }
        inline.clone()
    } else if let Some(ref content) = existing_disk_content {
        match serde_json::from_str::<Value>(content) {
            Ok(parsed) if parsed.is_object() => parsed,
            Ok(_) => {
                return error_result(
                    vec![violation(
                        "path",
                        "invalid_definition_root",
                        "Existing workflow file root must be a JSON object.",
                    )],
                    "Existing workflow file root must be a JSON object.",
                    None,
                );
            }
            Err(err) => {
                let msg = format!("Existing workflow file contains invalid JSON: {err}");
                return error_result(vec![violation("path", "invalid_json", &msg)], &msg, None);
            }
        }
    } else {
        default_empty_workflow(str_prop(args, &["name"]).unwrap_or("Pulse Hybrid Workflow"))
    };

    ensure_workflow_skeleton(&mut definition);

    let operations: Vec<Value> = if let Some(ops) = args.get("operations").and_then(Value::as_array)
    {
        ops.clone()
    } else if args.get("op").is_some() {
        vec![args.clone()]
    } else {
        Vec::new()
    };

    for (op_idx, op_item) in operations.iter().enumerate() {
        apply_single_operation(&mut definition, op_item, op_idx, &mut violations);
    }

    validate_dual_primitive_workflow(&definition, &mut violations);

    if !violations.is_empty() {
        let msg = format!(
            "workflow_graph_patch failed validation with {} violation(s).",
            violations.len()
        );
        return error_result(violations, &msg, Some(definition));
    }

    let mut saved_revision: Option<String> = None;
    if should_write {
        let Some((_, ref target)) = resolved_target else {
            return error_result(
                vec![violation(
                    "path",
                    "missing_path_for_write",
                    "path is required when write=true.",
                )],
                "path is required when write=true.",
                Some(definition),
            );
        };
        let expected_rev = str_prop(args, &["expectedRevision", "expected_revision"])
            .map(str::trim)
            .filter(|s| !s.is_empty());

        let formatted = match serde_json::to_string_pretty(&definition) {
            Ok(s) => format!("{s}\n"),
            Err(err) => {
                return error_result(
                    vec![violation(
                        "definition",
                        "serialization_error",
                        &err.to_string(),
                    )],
                    &err.to_string(),
                    Some(definition),
                );
            }
        };

        match atomic_cas_write_text(target, &formatted, expected_rev) {
            Ok(rev) => saved_revision = Some(rev),
            Err((code, msg)) => {
                return error_result(
                    vec![violation("expectedRevision", code, &msg)],
                    &msg,
                    Some(definition),
                );
            }
        }
    }

    let summary = summarize_workflow(&definition);
    let mut out = Map::new();
    out.insert("valid".into(), json!(true));
    out.insert("violations".into(), json!([]));
    out.insert("summary".into(), summary);
    out.insert("definition".into(), definition);
    if let Some((rel_path, _)) = resolved_target {
        out.insert("path".into(), json!(rel_path));
    }
    if let Some(rev) = saved_revision {
        out.insert("revision".into(), json!(rev));
        out.insert("written".into(), json!(true));
    } else {
        out.insert("written".into(), json!(false));
    }
    Value::Object(out)
}

pub(crate) fn error_result(violations: Vec<Value>, text: &str, definition: Option<Value>) -> Value {
    let mut out = Map::new();
    out.insert("isError".into(), json!(true));
    out.insert("valid".into(), json!(false));
    out.insert("violations".into(), Value::Array(violations));
    out.insert("text".into(), json!(text));
    if let Some(def) = definition {
        out.insert("definition".into(), def);
    }
    Value::Object(out)
}

fn default_empty_workflow(name: &str) -> Value {
    json!({
        "schemaVersion": 2,
        "name": name,
        "orchestrator": "hybrid_pipeline",
        "steps": [],
    })
}

fn ensure_workflow_skeleton(def: &mut Value) {
    let Some(obj) = def.as_object_mut() else {
        return;
    };
    obj.entry("schemaVersion").or_insert_with(|| json!(2));
    obj.entry("name")
        .or_insert_with(|| json!("Pulse Hybrid Workflow"));
    if !obj.get("steps").is_some_and(Value::is_array) {
        obj.insert("steps".into(), json!([]));
    }
}

fn apply_single_operation(
    def: &mut Value,
    op_obj: &Value,
    op_idx: usize,
    violations: &mut Vec<Value>,
) {
    let op_path = format!("operations[{op_idx}]");
    let Some(op_name) = str_prop(op_obj, &["op"]).map(str::trim) else {
        violations.push(violation(
            &format!("{op_path}.op"),
            "missing_op",
            "Patch operation requires an 'op' string.",
        ));
        return;
    };

    match op_name {
        "apply_preset" => {
            let preset = str_prop(op_obj, &["preset"]).unwrap_or("").trim();
            let params = op_obj.get("params").cloned().unwrap_or_else(|| json!({}));
            match build_preset_workflow(preset, &params) {
                Ok(scaffolded) => *def = scaffolded,
                Err(msg) => violations.push(violation(
                    &format!("{op_path}.preset"),
                    "invalid_preset",
                    &msg,
                )),
            }
        }
        "add_step" => {
            let Some(raw_step) = op_obj.get("step") else {
                violations.push(violation(
                    &format!("{op_path}.step"),
                    "missing_step",
                    "add_step requires a 'step' object.",
                ));
                return;
            };
            if !raw_step.is_object() {
                violations.push(violation(
                    &format!("{op_path}.step"),
                    "invalid_step_object",
                    "step must be a JSON object.",
                ));
                return;
            }
            let normalized = normalize_step(raw_step);
            let new_id = str_prop(&normalized, &["id"]).unwrap_or("").to_string();
            if let Some(steps) = def.get_mut("steps").and_then(Value::as_array_mut) {
                if !new_id.is_empty()
                    && steps
                        .iter()
                        .any(|s| str_prop(s, &["id"]) == Some(new_id.as_str()))
                {
                    violations.push(violation(
                        &format!("{op_path}.step.id"),
                        "duplicate_step_id",
                        &format!("Step '{new_id}' already exists; use update_step instead."),
                    ));
                    return;
                }
                steps.push(normalized);
            }
        }
        "update_step" => {
            let target_id = str_prop(op_obj, &["stepId", "step_id", "id"])
                .unwrap_or("")
                .trim();
            let Some(patch) = op_obj.get("patch").filter(|p| p.is_object()) else {
                violations.push(violation(
                    &format!("{op_path}.patch"),
                    "missing_patch",
                    "update_step requires a 'patch' object.",
                ));
                return;
            };
            let Some(steps) = def.get_mut("steps").and_then(Value::as_array_mut) else {
                return;
            };
            let Some(step) = steps
                .iter_mut()
                .find(|s| str_prop(s, &["id"]) == Some(target_id))
            else {
                violations.push(violation(
                    &format!("{op_path}.stepId"),
                    "unknown_step_id",
                    &format!("Cannot update unknown step '{target_id}'."),
                ));
                return;
            };
            apply_step_patch(step, patch);
        }
        "remove_step" => {
            let target_id = str_prop(op_obj, &["stepId", "step_id", "id"])
                .unwrap_or("")
                .trim()
                .to_string();
            let Some(steps) = def.get_mut("steps").and_then(Value::as_array_mut) else {
                return;
            };
            let Some(pos) = steps
                .iter()
                .position(|s| str_prop(s, &["id"]) == Some(target_id.as_str()))
            else {
                violations.push(violation(
                    &format!("{op_path}.stepId"),
                    "unknown_step_id",
                    &format!("Cannot remove unknown step '{target_id}'."),
                ));
                return;
            };
            steps.remove(pos);
            for remaining in steps.iter_mut() {
                if let Some(deps) = remaining.get_mut("dependsOn").and_then(Value::as_array_mut) {
                    deps.retain(|d| d.as_str() != Some(target_id.as_str()));
                }
                if let Some(body) = remaining
                    .get_mut("bodyStepIds")
                    .and_then(Value::as_array_mut)
                {
                    body.retain(|b| b.as_str() != Some(target_id.as_str()));
                }
            }
        }
        "connect_steps" => {
            let from_id = str_prop(op_obj, &["fromStepId", "from_step_id", "from"])
                .unwrap_or("")
                .trim()
                .to_string();
            let to_id = str_prop(op_obj, &["toStepId", "to_step_id", "to"])
                .unwrap_or("")
                .trim()
                .to_string();
            if from_id.is_empty() || to_id.is_empty() {
                violations.push(violation(
                    &op_path,
                    "missing_edge_endpoints",
                    "connect_steps requires non-empty fromStepId and toStepId.",
                ));
                return;
            }
            let Some(steps) = def.get_mut("steps").and_then(Value::as_array_mut) else {
                return;
            };
            let from_exists = steps
                .iter()
                .any(|s| str_prop(s, &["id"]) == Some(from_id.as_str()));
            if !from_exists {
                violations.push(violation(
                    &format!("{op_path}.fromStepId"),
                    "unknown_from_step",
                    &format!("Source step '{from_id}' does not exist."),
                ));
            }
            let Some(to_step) = steps
                .iter_mut()
                .find(|s| str_prop(s, &["id"]) == Some(to_id.as_str()))
            else {
                violations.push(violation(
                    &format!("{op_path}.toStepId"),
                    "unknown_to_step",
                    &format!("Target step '{to_id}' does not exist."),
                ));
                return;
            };
            if let Some(obj) = to_step.as_object_mut() {
                let deps = obj
                    .entry("dependsOn")
                    .or_insert_with(|| json!([]))
                    .as_array_mut();
                if let Some(deps) = deps
                    && !deps.iter().any(|d| d.as_str() == Some(from_id.as_str()))
                {
                    deps.push(json!(from_id));
                }
                if let (Some(bind_key), Some(bind_expr)) = (
                    str_prop(op_obj, &["bindingKey", "binding_key"]),
                    str_prop(op_obj, &["bindingExpr", "binding_expr"]),
                ) {
                    let bindings = obj
                        .entry("inputBindings")
                        .or_insert_with(|| json!({}))
                        .as_object_mut();
                    if let Some(bindings) = bindings {
                        bindings.insert(bind_key.to_string(), json!(bind_expr));
                    }
                }
            }
        }
        "disconnect_steps" => {
            let from_id = str_prop(op_obj, &["fromStepId", "from_step_id", "from"])
                .unwrap_or("")
                .trim();
            let to_id = str_prop(op_obj, &["toStepId", "to_step_id", "to"])
                .unwrap_or("")
                .trim();
            if from_id.is_empty() || to_id.is_empty() {
                violations.push(violation(
                    &op_path,
                    "missing_edge_endpoints",
                    "disconnect_steps requires non-empty fromStepId and toStepId.",
                ));
                return;
            }
            let Some(steps) = def.get_mut("steps").and_then(Value::as_array_mut) else {
                return;
            };
            let Some(to_step) = steps
                .iter_mut()
                .find(|s| str_prop(s, &["id"]) == Some(to_id))
            else {
                violations.push(violation(
                    &format!("{op_path}.toStepId"),
                    "unknown_to_step",
                    &format!("Target step '{to_id}' does not exist."),
                ));
                return;
            };
            if let Some(deps) = to_step.get_mut("dependsOn").and_then(Value::as_array_mut) {
                deps.retain(|d| d.as_str() != Some(from_id));
            }
            if let Some(bind_key) = str_prop(op_obj, &["bindingKey", "binding_key"])
                && let Some(bindings) = to_step
                    .get_mut("inputBindings")
                    .and_then(Value::as_object_mut)
            {
                bindings.remove(bind_key);
            }
        }
        other => violations.push(violation(
            &format!("{op_path}.op"),
            "unsupported_op",
            &format!("Unsupported workflow_graph_patch operation '{other}'."),
        )),
    }
}

pub(crate) fn normalize_step(raw: &Value) -> Value {
    let mut step = raw.clone();
    let Some(obj) = step.as_object_mut() else {
        return step;
    };
    let kind = obj
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    if let Some(deps) = obj.remove("depends_on")
        && !obj.contains_key("dependsOn")
    {
        obj.insert("dependsOn".into(), deps);
    }
    obj.entry("dependsOn").or_insert_with(|| json!([]));

    match kind.as_str() {
        "session" => {
            alias_field(obj, "agent_id", "agentId");
            alias_field(obj, "model_override", "modelOverride");
            alias_field(obj, "workspace_isolation", "workspaceIsolation");
            alias_field(obj, "refresh_context", "refreshContext");
            alias_field(obj, "input_bindings", "inputBindings");
            alias_field(obj, "output_schema", "outputSchema");
            obj.entry("refreshContext").or_insert_with(|| json!(true));
            obj.entry("workspaceIsolation")
                .or_insert_with(|| json!("isolated_worktree"));
            obj.entry("inputBindings").or_insert_with(|| json!({}));
        }
        "bot" => {
            alias_field(obj, "member_id", "memberId");
            alias_field(obj, "preserve_context", "preserveContext");
            alias_field(obj, "conversation_scope", "conversationScope");
            alias_field(obj, "mailbox_policy", "mailboxPolicy");
            alias_field(obj, "input_bindings", "inputBindings");
            alias_field(obj, "output_schema", "outputSchema");
            obj.entry("preserveContext").or_insert_with(|| json!(true));
            obj.entry("conversationScope")
                .or_insert_with(|| json!("fixed_primary"));
            obj.entry("mailboxPolicy")
                .or_insert_with(|| json!("fifo_serial"));
            obj.entry("inputBindings").or_insert_with(|| json!({}));
        }
        "group_stage" => {
            alias_field(obj, "space_id", "spaceId");
            alias_field(obj, "dispatch_mode", "dispatchMode");
        }
        "user_gate" => {
            alias_field(obj, "interaction_kind", "interactionKind");
            obj.entry("interactionKind")
                .or_insert_with(|| json!("approval"));
        }
        "bounded_loop" => {
            alias_field(obj, "max_iterations", "maxIterations");
            alias_field(obj, "body_step_ids", "bodyStepIds");
            alias_field(obj, "condition_pointer", "conditionPointer");
            alias_field(obj, "on_exhausted_step_id", "onExhaustedStepId");
        }
        "wait_for_event" => {
            alias_field(obj, "event_types", "eventTypes");
            alias_field(obj, "thread_key_pointer", "threadKeyPointer");
            alias_field(obj, "timeout_seconds", "timeoutSeconds");
            alias_field(obj, "on_timeout_step_id", "onTimeoutStepId");
        }
        "outbox_action" => {
            alias_field(obj, "action_kind", "actionKind");
            alias_field(obj, "payload_template", "payloadTemplate");
        }
        _ => {}
    }
    step
}

fn alias_field(obj: &mut Map<String, Value>, snake: &str, camel: &str) {
    if let Some(val) = obj.remove(snake)
        && !obj.contains_key(camel)
    {
        obj.insert(camel.to_string(), val);
    }
}

fn apply_step_patch(step: &mut Value, patch: &Value) {
    let old_kind = str_prop(step, &["kind"]).unwrap_or("").to_string();
    let new_kind = str_prop(patch, &["kind"]).unwrap_or(&old_kind).to_string();

    if let Some(obj) = step.as_object_mut() {
        if old_kind != new_kind {
            match new_kind.as_str() {
                "bot" => {
                    obj.remove("agentId");
                    obj.remove("modelOverride");
                    obj.remove("workspaceIsolation");
                    obj.remove("refreshContext");
                }
                "session" => {
                    obj.remove("memberId");
                    obj.remove("preserveContext");
                    obj.remove("conversationScope");
                    obj.remove("mailboxPolicy");
                }
                _ => {}
            }
        }
        if let Some(entries) = patch.as_object() {
            for (k, v) in entries {
                if k == "id" {
                    continue;
                }
                obj.insert(k.clone(), v.clone());
            }
        }
    }
    *step = normalize_step(step);
}

/// Exhaustively validates all Dual-Primitive nodes, `bounded_loop.maxIterations`,
/// JSON pointers, references, and DAG acyclicity in one pass (No Fail-Fast).
pub fn validate_dual_primitive_workflow(def: &Value, violations: &mut Vec<Value>) {
    let name = str_prop(def, &["name"]).unwrap_or("").trim();
    if name.is_empty() {
        violations.push(violation(
            "name",
            "empty_workflow_name",
            "Workflow name is required.",
        ));
    }

    if let Some(orch) = str_prop(def, &["orchestrator"])
        && !matches!(
            orch,
            "direct_reflex"
                | "superagent_router"
                | "hybrid_pipeline"
                | "event_saga"
                | "window_aggregator"
        )
    {
        violations.push(violation(
            "orchestrator",
            "invalid_orchestrator",
            "orchestrator must be direct_reflex, superagent_router, hybrid_pipeline, event_saga, or window_aggregator.",
        ));
    }

    let Some(steps) = def.get("steps").and_then(Value::as_array) else {
        violations.push(violation(
            "steps",
            "missing_steps",
            "Workflow steps array is required.",
        ));
        return;
    };
    if steps.is_empty() {
        violations.push(violation(
            "steps",
            "empty_steps",
            "Workflow must contain at least one step.",
        ));
        return;
    }

    let mut known_ids = BTreeSet::new();
    for (idx, step) in steps.iter().enumerate() {
        let base = format!("steps[{idx}]");
        let id = str_prop(step, &["id"]).unwrap_or("").trim();
        if !is_valid_step_id(id) {
            violations.push(violation(
                &format!("{base}.id"),
                "invalid_step_id",
                "Step id must match ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$.",
            ));
        } else if !known_ids.insert(id.to_string()) {
            violations.push(violation(
                &format!("{base}.id"),
                "duplicate_step_id",
                &format!("Duplicate step id '{id}'."),
            ));
        }
    }

    let mut adj: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for id in &known_ids {
        adj.insert(id.clone(), Vec::new());
    }

    for (idx, step) in steps.iter().enumerate() {
        let base = format!("steps[{idx}]");
        let step_id = str_prop(step, &["id"]).unwrap_or("");
        let kind = str_prop(step, &["kind"]).unwrap_or("");

        if let Some(deps) = step.get("dependsOn").and_then(Value::as_array) {
            for (d_idx, dep_val) in deps.iter().enumerate() {
                let dep_id = dep_val.as_str().unwrap_or("").trim();
                if dep_id.is_empty() || !known_ids.contains(dep_id) {
                    violations.push(violation(
                        &format!("{base}.dependsOn[{d_idx}]"),
                        "unknown_dependency",
                        &format!("Step '{step_id}' depends on unknown step '{dep_id}'."),
                    ));
                } else if dep_id == step_id {
                    violations.push(violation(
                        &format!("{base}.dependsOn[{d_idx}]"),
                        "self_dependency",
                        &format!("Step '{step_id}' cannot depend on itself."),
                    ));
                } else if let Some(children) = adj.get_mut(dep_id) {
                    children.push(step_id.to_string());
                }
            }
        }

        match kind {
            "session" => {
                if str_prop(step, &["agentId", "agent_id"])
                    .unwrap_or("")
                    .trim()
                    .is_empty()
                {
                    violations.push(violation(
                        &format!("{base}.agentId"),
                        "missing_agent_id",
                        "Session step requires a non-empty agentId.",
                    ));
                }
                if str_prop(step, &["prompt"]).unwrap_or("").trim().is_empty() {
                    violations.push(violation(
                        &format!("{base}.prompt"),
                        "empty_prompt",
                        "Session step requires a non-empty prompt.",
                    ));
                }
                if bool_prop(step, &["refreshContext", "refresh_context"]) == Some(false) {
                    violations.push(violation(
                        &format!("{base}.refreshContext"),
                        "session_requires_fresh_context",
                        "Ephemeral session steps must keep refreshContext=true; use kind='bot' for persistent context.",
                    ));
                }
                let iso = str_prop(step, &["workspaceIsolation", "workspace_isolation"])
                    .unwrap_or("isolated_worktree");
                if !matches!(iso, "isolated_worktree" | "project_root" | "scratch") {
                    violations.push(violation(
                        &format!("{base}.workspaceIsolation"),
                        "invalid_workspace_isolation",
                        "workspaceIsolation must be isolated_worktree, project_root, or scratch.",
                    ));
                }
            }
            "bot" => {
                if str_prop(step, &["memberId", "member_id"])
                    .unwrap_or("")
                    .trim()
                    .is_empty()
                {
                    violations.push(violation(
                        &format!("{base}.memberId"),
                        "missing_member_id",
                        "Persistent bot step requires a non-empty memberId.",
                    ));
                }
                if str_prop(step, &["prompt"]).unwrap_or("").trim().is_empty() {
                    violations.push(violation(
                        &format!("{base}.prompt"),
                        "empty_prompt",
                        "Persistent bot step requires a non-empty prompt.",
                    ));
                }
                if bool_prop(step, &["preserveContext", "preserve_context"]) == Some(false) {
                    violations.push(violation(
                        &format!("{base}.preserveContext"),
                        "bot_requires_preserved_context",
                        "Persistent bot steps must keep preserveContext=true; use kind='session' for fresh context.",
                    ));
                }
                let scope = str_prop(step, &["conversationScope", "conversation_scope"])
                    .unwrap_or("fixed_primary");
                if !matches!(scope, "fixed_primary" | "per_thread_topic") {
                    violations.push(violation(
                        &format!("{base}.conversationScope"),
                        "invalid_conversation_scope",
                        "conversationScope must be fixed_primary or per_thread_topic.",
                    ));
                }
                let mailbox =
                    str_prop(step, &["mailboxPolicy", "mailbox_policy"]).unwrap_or("fifo_serial");
                if !matches!(mailbox, "fifo_serial" | "coalesce_batch" | "steer_active") {
                    violations.push(violation(
                        &format!("{base}.mailboxPolicy"),
                        "invalid_mailbox_policy",
                        "mailboxPolicy must be fifo_serial, coalesce_batch, or steer_active.",
                    ));
                }
            }
            "group_stage" => {
                if str_prop(step, &["spaceId", "space_id"])
                    .unwrap_or("")
                    .trim()
                    .is_empty()
                {
                    violations.push(violation(
                        &format!("{base}.spaceId"),
                        "missing_space_id",
                        "group_stage step requires a non-empty spaceId.",
                    ));
                }
                if step
                    .get("dispatchMode")
                    .or_else(|| step.get("dispatch_mode"))
                    .is_none()
                {
                    violations.push(violation(
                        &format!("{base}.dispatchMode"),
                        "missing_dispatch_mode",
                        "group_stage step requires dispatchMode.",
                    ));
                }
                if str_prop(step, &["prompt"]).unwrap_or("").trim().is_empty() {
                    violations.push(violation(
                        &format!("{base}.prompt"),
                        "empty_prompt",
                        "group_stage step requires a non-empty prompt.",
                    ));
                }
            }
            "user_gate" => {
                let ik =
                    str_prop(step, &["interactionKind", "interaction_kind"]).unwrap_or("approval");
                if !matches!(ik, "approval" | "ask_form" | "notify") {
                    violations.push(violation(
                        &format!("{base}.interactionKind"),
                        "invalid_interaction_kind",
                        "user_gate interactionKind must be approval, ask_form, or notify.",
                    ));
                }
                if str_prop(step, &["title"]).unwrap_or("").trim().is_empty() {
                    violations.push(violation(
                        &format!("{base}.title"),
                        "empty_title",
                        "user_gate step requires a non-empty title.",
                    ));
                }
            }
            "bounded_loop" => {
                match i64_prop(step, &["maxIterations", "max_iterations"]) {
                    None => violations.push(violation(
                        &format!("{base}.maxIterations"),
                        "missing_max_iterations",
                        "bounded_loop step requires integer maxIterations (1..=50).",
                    )),
                    Some(n) if n < 1 => violations.push(violation(
                        &format!("{base}.maxIterations"),
                        "max_iterations_below_minimum",
                        "bounded_loop maxIterations must be >= 1.",
                    )),
                    Some(n) if n > MAX_BOUNDED_LOOP_ITERATIONS => violations.push(violation(
                        &format!("{base}.maxIterations"),
                        "max_iterations_exceeded",
                        &format!(
                            "bounded_loop maxIterations ({n}) exceeds ceiling of {MAX_BOUNDED_LOOP_ITERATIONS}."
                        ),
                    )),
                    Some(_) => {}
                }

                match arr_prop(step, &["bodyStepIds", "body_step_ids"]) {
                    None => violations.push(violation(
                        &format!("{base}.bodyStepIds"),
                        "empty_loop_body",
                        "bounded_loop requires a non-empty bodyStepIds array.",
                    )),
                    Some([]) => violations.push(violation(
                        &format!("{base}.bodyStepIds"),
                        "empty_loop_body",
                        "bounded_loop requires at least one step in bodyStepIds.",
                    )),
                    Some(body) => {
                        for (b_idx, item) in body.iter().enumerate() {
                            let bid = item.as_str().unwrap_or("").trim();
                            if bid == step_id {
                                violations.push(violation(
                                    &format!("{base}.bodyStepIds[{b_idx}]"),
                                    "loop_self_reference",
                                    "bounded_loop cannot include itself in bodyStepIds.",
                                ));
                            } else if !known_ids.contains(bid) {
                                violations.push(violation(
                                    &format!("{base}.bodyStepIds[{b_idx}]"),
                                    "unknown_loop_body_step",
                                    &format!("bounded_loop references unknown body step '{bid}'."),
                                ));
                            }
                        }
                    }
                }

                let cond_ptr = str_prop(step, &["conditionPointer", "condition_pointer"])
                    .unwrap_or("")
                    .trim();
                if !cond_ptr.starts_with('/') {
                    violations.push(violation(
                        &format!("{base}.conditionPointer"),
                        "invalid_condition_pointer",
                        "bounded_loop conditionPointer must be an RFC 6901 JSON Pointer starting with '/'.",
                    ));
                }

                if let Some(exhausted) =
                    str_prop(step, &["onExhaustedStepId", "on_exhausted_step_id"])
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    && !known_ids.contains(exhausted)
                {
                    violations.push(violation(
                        &format!("{base}.onExhaustedStepId"),
                        "unknown_exhausted_step",
                        &format!(
                            "bounded_loop onExhaustedStepId references unknown step '{exhausted}'."
                        ),
                    ));
                }
            }
            "wait_for_event" => {
                match arr_prop(step, &["eventTypes", "event_types"]) {
                    None => violations.push(violation(
                        &format!("{base}.eventTypes"),
                        "empty_event_types",
                        "wait_for_event requires a non-empty eventTypes array.",
                    )),
                    Some([]) => violations.push(violation(
                        &format!("{base}.eventTypes"),
                        "empty_event_types",
                        "wait_for_event requires at least one eventType.",
                    )),
                    Some(_) => {}
                }
                match i64_prop(step, &["timeoutSeconds", "timeout_seconds"]) {
                    None => violations.push(violation(
                        &format!("{base}.timeoutSeconds"),
                        "missing_timeout_seconds",
                        "wait_for_event requires timeoutSeconds >= 5.",
                    )),
                    Some(secs) if secs < 5 => violations.push(violation(
                        &format!("{base}.timeoutSeconds"),
                        "timeout_too_short",
                        "wait_for_event timeoutSeconds must be >= 5.",
                    )),
                    Some(_) => {}
                }
                if let Some(ptr) = str_prop(step, &["threadKeyPointer", "thread_key_pointer"])
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    && !ptr.starts_with('/')
                {
                    violations.push(violation(
                        &format!("{base}.threadKeyPointer"),
                        "invalid_thread_key_pointer",
                        "threadKeyPointer must start with '/'.",
                    ));
                }
                if let Some(timeout_step) =
                    str_prop(step, &["onTimeoutStepId", "on_timeout_step_id"])
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    && !known_ids.contains(timeout_step)
                {
                    violations.push(violation(
                        &format!("{base}.onTimeoutStepId"),
                        "unknown_timeout_step",
                        &format!(
                            "wait_for_event onTimeoutStepId references unknown step '{timeout_step}'."
                        ),
                    ));
                }
            }
            "outbox_action" => {
                let ak = str_prop(step, &["actionKind", "action_kind"]).unwrap_or("");
                if !matches!(
                    ak,
                    "reply_channel" | "emit_event" | "webhook_post" | "issue_update"
                ) {
                    violations.push(violation(
                        &format!("{base}.actionKind"),
                        "invalid_action_kind",
                        "outbox_action actionKind must be reply_channel, emit_event, webhook_post, or issue_update.",
                    ));
                }
                if str_prop(step, &["payloadTemplate", "payload_template"])
                    .unwrap_or("")
                    .trim()
                    .is_empty()
                {
                    violations.push(violation(
                        &format!("{base}.payloadTemplate"),
                        "empty_payload_template",
                        "outbox_action requires a non-empty payloadTemplate.",
                    ));
                }
            }
            other => violations.push(violation(
                &format!("{base}.kind"),
                "invalid_step_kind",
                &format!("Unsupported workflow step kind '{other}'."),
            )),
        }
    }

    let mut in_degree: BTreeMap<String, usize> = known_ids.iter().map(|k| (k.clone(), 0)).collect();
    for targets in adj.values() {
        for target in targets {
            if let Some(deg) = in_degree.get_mut(target) {
                *deg += 1;
            }
        }
    }
    let mut queue: Vec<String> = in_degree
        .iter()
        .filter(|(_, deg)| **deg == 0)
        .map(|(k, _)| k.clone())
        .collect();
    let mut visited = 0usize;
    while let Some(node) = queue.pop() {
        visited += 1;
        if let Some(targets) = adj.get(&node) {
            for target in targets {
                if let Some(deg) = in_degree.get_mut(target) {
                    *deg -= 1;
                    if *deg == 0 {
                        queue.push(target.clone());
                    }
                }
            }
        }
    }
    if visited < known_ids.len() {
        let cycle_nodes: Vec<String> = in_degree
            .into_iter()
            .filter_map(|(k, deg)| (deg > 0).then_some(k))
            .collect();
        violations.push(violation(
            "steps",
            "dependency_cycle_detected",
            &format!(
                "Workflow dependsOn graph contains a cycle involving step(s): {}.",
                cycle_nodes.join(", ")
            ),
        ));
    }
}

fn is_valid_step_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 64 {
        return false;
    }
    let mut bytes = id.bytes();
    let first = bytes.next().unwrap();
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn summarize_workflow(def: &Value) -> Value {
    let steps = def
        .get("steps")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let mut session_count = 0i64;
    let mut bot_count = 0i64;
    let mut loop_count = 0i64;
    for step in steps {
        match str_prop(step, &["kind"]) {
            Some("session") => session_count += 1,
            Some("bot") => bot_count += 1,
            Some("bounded_loop") => loop_count += 1,
            _ => {}
        }
    }
    json!({
        "stepCount": steps.len() as i64,
        "sessionSteps": session_count,
        "botSteps": bot_count,
        "boundedLoopSteps": loop_count,
    })
}

pub(crate) fn resolve_safe_source_path(
    relative: &str,
    workspace_root: Option<&Path>,
) -> Result<PathBuf, String> {
    if !relative.ends_with(".dimo-workflow.json") {
        return Err("path must end with .dimo-workflow.json".to_string());
    }
    let shared_prefix = "~/.dimo/workflows/";
    let (root, rel_part) = if let Some(stripped) = relative.strip_prefix(shared_prefix) {
        let home = env::var_os("HOME")
            .or_else(|| env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .ok_or_else(|| "Unable to resolve user home directory".to_string())?;
        (home.join(".dimo").join("workflows"), stripped)
    } else {
        if Path::new(relative).is_absolute() {
            return Err("path must be project-relative or under ~/.dimo/workflows/".to_string());
        }
        let base = match workspace_root {
            Some(p) => p.to_path_buf(),
            None => env::current_dir().map_err(|e| e.to_string())?,
        };
        (base, relative)
    };

    let rel_path = Path::new(rel_part);
    let mut normalized_rel = PathBuf::new();
    for comp in rel_path.components() {
        match comp {
            Component::Normal(seg) => normalized_rel.push(seg),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("Workflow source escapes its authoring root".to_string());
            }
        }
    }
    if normalized_rel.as_os_str().is_empty() {
        return Err("path must end with .dimo-workflow.json".to_string());
    }
    Ok(root.join(normalized_rel))
}

pub(crate) fn atomic_cas_write_text(
    target: &Path,
    serialized: &str,
    expected_revision: Option<&str>,
) -> Result<String, (&'static str, String)> {
    if serialized.len() > MAX_SOURCE_BYTES {
        return Err((
            "source_too_large",
            "Workflow source exceeds 4 MiB.".to_string(),
        ));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| ("io_error", e.to_string()))?;
    }

    let lock_path = PathBuf::from(format!("{}.lock", target.display()));
    let lock_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock_path)
        .map_err(|err| {
            if err.kind() == std::io::ErrorKind::AlreadyExists {
                (
                    "source_locked",
                    "Workflow source is already being edited; retry after the active write finishes"
                        .to_string(),
                )
            } else {
                ("io_error", err.to_string())
            }
        })?;

    let write_outcome = (|| -> Result<String, (&'static str, String)> {
        let current = match fs::read_to_string(target) {
            Ok(text) => Some(text),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
            Err(err) => return Err(("io_error", err.to_string())),
        };
        if let Some(ref cur_text) = current {
            let Some(exp) = expected_revision else {
                return Err((
                    "missing_expected_revision",
                    "expectedRevision is required for an existing source".to_string(),
                ));
            };
            let actual = sha256_revision(cur_text.as_bytes());
            if actual != exp {
                return Err((
                    "cas_revision_mismatch",
                    "Workflow source changed outside this Agent; read and reconcile it first"
                        .to_string(),
                ));
            }
        } else if expected_revision.is_some() {
            return Err((
                "source_deleted",
                "Workflow source was deleted outside this Agent".to_string(),
            ));
        }

        let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let tmp_path = PathBuf::from(format!(
            "{}.{}.{}.tmp",
            target.display(),
            std::process::id(),
            seq
        ));
        {
            let mut tmp = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&tmp_path)
                .map_err(|e| ("io_error", e.to_string()))?;
            tmp.write_all(serialized.as_bytes())
                .map_err(|e| ("io_error", e.to_string()))?;
            let _ = tmp.sync_all();
        }
        if let Err(err) = fs::rename(&tmp_path, target) {
            let _ = fs::remove_file(&tmp_path);
            return Err(("io_error", err.to_string()));
        }
        Ok(sha256_revision(serialized.as_bytes()))
    })();

    drop(lock_file);
    let _ = fs::remove_file(&lock_path);
    write_outcome
}
