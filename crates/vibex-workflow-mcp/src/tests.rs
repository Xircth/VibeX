use std::{collections::HashSet, fs};

use crate::{
    InboundRoute, augment_tools_list_response,
    graph_patch::{WORKFLOW_GRAPH_PATCH_TOOL_NAME, execute_workflow_graph_patch},
    json::{Json, sha256_revision},
    route_inbound_line,
};

#[test]
fn sha256_matches_standard_nist_vectors_and_cas_format() {
    assert_eq!(
        sha256_revision(b""),
        "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(
        sha256_revision(b"abc"),
        "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_eq!(
        sha256_revision(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
        "sha256:248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
    );
}

#[test]
fn json_parser_round_trips_surrogates_escapes_and_objects() {
    let raw = r#"{"title":"Pulse \uD83D\uDE80\nLine2","count":42,"nested":[true,false,null]}"#;
    let parsed = Json::parse(raw).expect("valid json");
    assert_eq!(
        parsed.get("title").and_then(Json::as_str),
        Some("Pulse 🚀\nLine2")
    );
    assert_eq!(parsed.get("count").and_then(Json::as_i64), Some(42));
    let re_parsed = Json::parse(&parsed.to_pretty_string()).expect("re-parse pretty");
    assert_eq!(parsed, re_parsed);
}

#[test]
fn apply_preset_scaffolds_all_five_valid_dual_primitive_orchestrators() {
    for preset in [
        "direct_reflex",
        "superagent_router",
        "hybrid_pipeline",
        "event_saga",
        "window_aggregator",
    ] {
        let req = Json::parse(&format!(
            r#"{{
                "operations": [
                    {{
                        "op": "apply_preset",
                        "preset": "{preset}",
                        "params": {{
                            "agentId": "claude-code",
                            "memberId": "bot-pm-core",
                            "maxIterations": 4,
                            "timeoutSeconds": 900
                        }}
                    }}
                ]
            }}"#
        ))
        .unwrap();

        let res = execute_workflow_graph_patch(&req, None);
        assert_eq!(
            res.get("valid").and_then(Json::as_bool),
            Some(true),
            "preset {preset} failed validation: {}",
            res.to_pretty_string()
        );
        assert_eq!(
            res.get("definition")
                .and_then(|d| d.get("orchestrator"))
                .and_then(Json::as_str),
            Some(preset)
        );
    }
}

#[test]
fn dual_primitive_patching_mixes_session_and_bot_and_switches_cleanly() {
    let patch_args = Json::parse(
        r#"{
            "definition": {
                "name": "Custom Jira PR Pipeline",
                "orchestrator": "hybrid_pipeline",
                "steps": []
            },
            "operations": [
                {
                    "op": "add_step",
                    "step": {
                        "id": "triage_bot",
                        "kind": "bot",
                        "member_id": "bot-architect",
                        "prompt": "Classify Jira ticket {{threadKey}} with persistent project context"
                    }
                },
                {
                    "op": "add_step",
                    "step": {
                        "id": "group_sync",
                        "kind": "group_stage",
                        "space_id": "space-eng",
                        "dispatch_mode": { "type": "mention_seats", "memberIds": ["bot-qa"] },
                        "prompt": "Post triage plan to engineering space"
                    }
                },
                {
                    "op": "add_step",
                    "step": {
                        "id": "implement_fix",
                        "kind": "session",
                        "agent_id": "codex",
                        "workspace_isolation": "isolated_worktree",
                        "prompt": "Implement fix in clean ephemeral worktree"
                    }
                },
                {
                    "op": "add_step",
                    "step": {
                        "id": "verify_loop",
                        "kind": "bounded_loop",
                        "max_iterations": 3,
                        "body_step_ids": ["implement_fix"],
                        "condition_pointer": "/testsPassed",
                        "on_exhausted_step_id": "human_gate"
                    }
                },
                {
                    "op": "add_step",
                    "step": {
                        "id": "await_webhook",
                        "kind": "wait_for_event",
                        "event_types": ["github.ci.passed"],
                        "thread_key_pointer": "/prThreadKey",
                        "timeout_seconds": 600
                    }
                },
                {
                    "op": "add_step",
                    "step": {
                        "id": "human_gate",
                        "kind": "user_gate",
                        "interaction_kind": "approval",
                        "title": "Approve release merge"
                    }
                },
                {
                    "op": "add_step",
                    "step": {
                        "id": "reply_jira",
                        "kind": "outbox_action",
                        "action_kind": "issue_update",
                        "payload_template": "Resolved {{threadKey}}"
                    }
                },
                {
                    "op": "connect_steps",
                    "fromStepId": "triage_bot",
                    "toStepId": "group_sync"
                },
                {
                    "op": "connect_steps",
                    "fromStepId": "group_sync",
                    "toStepId": "implement_fix",
                    "bindingKey": "plan",
                    "bindingExpr": "steps.triage_bot.output"
                },
                {
                    "op": "connect_steps",
                    "fromStepId": "implement_fix",
                    "toStepId": "verify_loop"
                },
                {
                    "op": "connect_steps",
                    "fromStepId": "verify_loop",
                    "toStepId": "await_webhook"
                },
                {
                    "op": "connect_steps",
                    "fromStepId": "await_webhook",
                    "toStepId": "human_gate"
                },
                {
                    "op": "connect_steps",
                    "fromStepId": "human_gate",
                    "toStepId": "reply_jira"
                }
            ]
        }"#,
    )
    .unwrap();

    let patched = execute_workflow_graph_patch(&patch_args, None);
    assert_eq!(
        patched.get("valid").and_then(Json::as_bool),
        Some(true),
        "unexpected error: {}",
        patched.to_pretty_string()
    );
    let summary = patched.get("summary").unwrap();
    assert_eq!(summary.get("stepCount").and_then(Json::as_i64), Some(7));
    assert_eq!(summary.get("sessionSteps").and_then(Json::as_i64), Some(1));
    assert_eq!(summary.get("botSteps").and_then(Json::as_i64), Some(1));
    assert_eq!(
        summary.get("boundedLoopSteps").and_then(Json::as_i64),
        Some(1)
    );

    // Switch `implement_fix` from `session` to `bot`, disconnect/remove `group_sync`
    let mut second_ops = Json::obj([
        ("definition", patched.get("definition").unwrap().clone()),
        (
            "operations",
            Json::parse(
                r#"[
                    {
                        "op": "update_step",
                        "stepId": "implement_fix",
                        "patch": {
                            "kind": "bot",
                            "memberId": "bot-implementer",
                            "mailboxPolicy": "fifo_serial"
                        }
                    },
                    {
                        "op": "disconnect_steps",
                        "fromStepId": "triage_bot",
                        "toStepId": "group_sync"
                    },
                    {
                        "op": "remove_step",
                        "stepId": "group_sync"
                    },
                    {
                        "op": "connect_steps",
                        "fromStepId": "triage_bot",
                        "toStepId": "implement_fix"
                    }
                ]"#,
            )
            .unwrap(),
        ),
    ]);
    let switched = execute_workflow_graph_patch(&second_ops, None);
    let _ = &mut second_ops;
    assert_eq!(switched.get("valid").and_then(Json::as_bool), Some(true));
    assert_eq!(
        switched
            .get("summary")
            .and_then(|s| s.get("sessionSteps"))
            .and_then(Json::as_i64),
        Some(0)
    );
    assert_eq!(
        switched
            .get("summary")
            .and_then(|s| s.get("botSteps"))
            .and_then(Json::as_i64),
        Some(2)
    );
    let impl_step = switched
        .get("definition")
        .and_then(|d| d.get("steps"))
        .and_then(Json::as_arr)
        .unwrap()
        .iter()
        .find(|s| s.get("id").and_then(Json::as_str) == Some("implement_fix"))
        .unwrap();
    assert!(impl_step.get("agentId").is_none());
    assert!(impl_step.get("refreshContext").is_none());
    assert_eq!(
        impl_step.get("preserveContext").and_then(Json::as_bool),
        Some(true)
    );
}

#[test]
fn workflow_graph_patch_reports_exhaustive_violations_including_bounded_loop_and_cycles() {
    let invalid_req = Json::parse(
        r#"{
            "definition": {
                "name": "   ",
                "orchestrator": "unknown_orch",
                "steps": [
                    {
                        "id": "step_a",
                        "kind": "session",
                        "agentId": "",
                        "refreshContext": false,
                        "prompt": "",
                        "dependsOn": ["step_b", "ghost_step"]
                    },
                    {
                        "id": "step_b",
                        "kind": "bot",
                        "memberId": "",
                        "preserveContext": false,
                        "prompt": "ok",
                        "dependsOn": ["step_a"]
                    },
                    {
                        "id": "bad_loop",
                        "kind": "bounded_loop",
                        "maxIterations": 999,
                        "bodyStepIds": ["bad_loop", "missing_body"],
                        "conditionPointer": "not_rfc6901",
                        "onExhaustedStepId": "missing_fallback"
                    }
                ]
            },
            "operations": []
        }"#,
    )
    .unwrap();

    let report = execute_workflow_graph_patch(&invalid_req, None);
    assert_eq!(report.get("isError").and_then(Json::as_bool), Some(true));
    assert_eq!(report.get("valid").and_then(Json::as_bool), Some(false));

    let codes: Vec<&str> = report
        .get("violations")
        .and_then(Json::as_arr)
        .unwrap()
        .iter()
        .filter_map(|v| v.get("code").and_then(Json::as_str))
        .collect();

    for expected in [
        "empty_workflow_name",
        "invalid_orchestrator",
        "unknown_dependency",
        "missing_agent_id",
        "empty_prompt",
        "session_requires_fresh_context",
        "missing_member_id",
        "bot_requires_preserved_context",
        "max_iterations_exceeded",
        "loop_self_reference",
        "unknown_loop_body_step",
        "invalid_condition_pointer",
        "unknown_exhausted_step",
        "dependency_cycle_detected",
    ] {
        assert!(
            codes.contains(&expected),
            "missing expected violation '{expected}' in {codes:?}"
        );
    }
}

#[test]
fn cas_file_persistence_and_jsonrpc_multiplexing_work_end_to_end() {
    let temp_dir = std::env::temp_dir().join(format!(
        "vibex-wf-patch-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&temp_dir).unwrap();

    // 1. Create workflow file via JSON-RPC tools/call (modern 2026-07-28 _meta)
    let call_line = r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"workflow_graph_patch","_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"},"arguments":{"path":"flows/triage.vibex-workflow.json","operations":[{"op":"apply_preset","preset":"superagent_router"}]}}}"#;
    let route = route_inbound_line(call_line, Some(&temp_dir));
    let InboundRoute::HandledLocally(Some(resp_text)) = route else {
        panic!("expected local handling for workflow_graph_patch");
    };
    let resp = Json::parse(&resp_text).unwrap();
    assert_eq!(
        resp.get("result")
            .and_then(|r| r.get("resultType"))
            .and_then(Json::as_str),
        Some("complete")
    );
    let rev1 = resp
        .get("result")
        .and_then(|r| r.get("structuredContent"))
        .and_then(|s| s.get("revision"))
        .and_then(Json::as_str)
        .expect("CAS revision returned")
        .to_string();
    assert!(rev1.starts_with("sha256:"));

    // 2. Patching existing file WITHOUT expectedRevision is rejected
    let stale_args = Json::parse(
        r#"{
            "path": "flows/triage.vibex-workflow.json",
            "operations": [
                {
                    "op": "update_step",
                    "stepId": "triage_bot",
                    "patch": { "mailboxPolicy": "coalesce_batch" }
                }
            ]
        }"#,
    )
    .unwrap();
    let missing_rev_res = execute_workflow_graph_patch(&stale_args, Some(&temp_dir));
    assert_eq!(
        missing_rev_res.get("isError").and_then(Json::as_bool),
        Some(true)
    );

    // 3. Patching WITH matching expectedRevision succeeds and rotates CAS revision
    let mut valid_cas_args = stale_args;
    valid_cas_args.set("expectedRevision", Json::str(rev1.clone()));
    let ok_res = execute_workflow_graph_patch(&valid_cas_args, Some(&temp_dir));
    assert_eq!(ok_res.get("valid").and_then(Json::as_bool), Some(true));
    let rev2 = ok_res
        .get("revision")
        .and_then(Json::as_str)
        .unwrap()
        .to_string();
    assert_ne!(rev1, rev2);

    // 4. tools/list tracking + augmentation appends workflow_graph_patch
    let list_req = r#"{"jsonrpc":"2.0","id":11,"method":"tools/list"}"#;
    let InboundRoute::ForwardToChild {
        track_tools_list_id: Some(tracked_id),
    } = route_inbound_line(list_req, None)
    else {
        panic!("expected tools/list tracking");
    };
    let mut pending = HashSet::from([tracked_id]);
    let child_resp = r#"{"jsonrpc":"2.0","id":11,"result":{"tools":[{"name":"workflow_source_read","description":"Read","inputSchema":{"type":"object"}}]}}"#;
    let augmented = augment_tools_list_response(child_resp, &mut pending);
    assert!(pending.is_empty());
    let aug_json = Json::parse(&augmented).unwrap();
    let names: Vec<&str> = aug_json
        .get("result")
        .and_then(|r| r.get("tools"))
        .and_then(Json::as_arr)
        .unwrap()
        .iter()
        .filter_map(|t| t.get("name").and_then(Json::as_str))
        .collect();
    assert_eq!(
        names,
        vec!["workflow_source_read", WORKFLOW_GRAPH_PATCH_TOOL_NAME]
    );

    let _ = fs::remove_dir_all(&temp_dir);
}
