use std::path::PathBuf;

use serde_json::{Value, json};

use crate::{Args, Companion, CompanionFeatures, LineAction, pulse::PULSE_TOOL_NAMES};

#[test]
fn catalog_marks_the_workflow_open_on_the_canvas() {
    let list = json!([{ "id": "wf-1", "name": "Named" }]);
    let draft_focus = json!({
        "viewing": true,
        "path": "~/.dimo/workflows/新建任务.dimo-workflow.json",
        "name": "新建任务",
        "definitionId": null,
        "marker": "dimo.canvas.viewing"
    });
    let annotated = crate::workflow::annotate_catalog_with_focus(list, Some(&draft_focus));
    let items = annotated.as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["canvasViewing"], true);
    assert_eq!(items[0]["marker"], "dimo.canvas.viewing");
    assert_eq!(items[0]["id"], "dimo-canvas-viewing");
    assert_eq!(
        items[0]["sourcePath"],
        "~/.dimo/workflows/新建任务.dimo-workflow.json"
    );
    assert!(items[1].get("canvasViewing").is_none());

    let listed = json!([{ "id": "wf-1", "name": "Named" }]);
    let named_focus = json!({
        "viewing": true,
        "definitionId": "wf-1",
        "path": "~/.dimo/workflows/Named.dimo-workflow.json",
        "name": "Named"
    });
    let marked = crate::workflow::annotate_catalog_with_focus(listed, Some(&named_focus));
    assert_eq!(marked.as_array().unwrap().len(), 1);
    assert_eq!(marked[0]["canvasViewing"], true);
    assert_eq!(
        marked[0]["sourcePath"],
        "~/.dimo/workflows/Named.dimo-workflow.json"
    );
}

fn temp_workspace(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "dimo-mcp-wf-test-{label}-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn superagent_companion(workspace_root: Option<PathBuf>, server_url: Option<String>) -> Companion {
    Companion::new(Args {
        parent_connection_id: "conn-super".to_string(),
        socket_path: String::new(),
        token: "tok-super".to_string(),
        features: CompanionFeatures::parse(Some(
            "delegation,feedback,ask,sessions,session-control,collaboration,space,pulse,workflow",
        )),
        server_url,
        server_token: Some("tok-super".to_string()),
        conversation_id: Some("conv-super-1".to_string()),
        workspace_root,
        product: "superagent".to_string(),
    })
}

async fn spawn_workflow_mock_host<F>(
    handler: F,
) -> (
    String,
    std::sync::Arc<std::sync::Mutex<Vec<(String, Value, Option<String>)>>>,
)
where
    F: Fn(&str, &Value) -> (u16, Value) + Send + Sync + 'static,
{
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let recorded = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let recorded_clone = recorded.clone();
    let handler = std::sync::Arc::new(handler);

    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let recorded_inner = recorded_clone.clone();
            let handler_inner = handler.clone();
            tokio::spawn(async move {
                let mut buf = Vec::with_capacity(8192);
                let mut tmp = [0u8; 4096];
                let header_end = loop {
                    let n = match stream.read(&mut tmp).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => n,
                    };
                    buf.extend_from_slice(&tmp[..n]);
                    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break pos + 4;
                    }
                };
                let header_str = String::from_utf8_lossy(&buf[..header_end]).to_string();
                let mut lines = header_str.lines();
                let req_line = lines.next().unwrap_or("");
                let path = req_line.split_whitespace().nth(1).unwrap_or("");
                let mut content_len = 0usize;
                let mut proto_hdr = None;
                for line in lines {
                    let lower = line.to_ascii_lowercase();
                    if let Some(rest) = lower.strip_prefix("content-length:") {
                        content_len = rest.trim().parse::<usize>().unwrap_or(0);
                    } else if lower.starts_with("x-dimo-protocol-version:") {
                        proto_hdr = line.split_once(':').map(|(_, v)| v.trim().to_string());
                    }
                }
                while buf.len() < header_end + content_len {
                    let n = match stream.read(&mut tmp).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    };
                    buf.extend_from_slice(&tmp[..n]);
                }
                let body_slice = &buf[header_end..(header_end + content_len).min(buf.len())];
                let parsed: Value = serde_json::from_slice(body_slice).unwrap_or(Value::Null);
                let command = path
                    .strip_prefix("/api/v1/call/")
                    .unwrap_or(path)
                    .to_string();
                let args = parsed.get("args").cloned().unwrap_or(Value::Null);
                recorded_inner
                    .lock()
                    .unwrap()
                    .push((command.clone(), args.clone(), proto_hdr));
                let (status, resp_body) = handler_inner(&command, &args);
                let json_bytes = serde_json::to_vec(&resp_body).unwrap();
                let header = format!(
                    "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    json_bytes.len()
                );
                let _ = stream.write_all(header.as_bytes()).await;
                let _ = stream.write_all(&json_bytes).await;
                let _ = stream.flush().await;
            });
        }
    });

    (format!("http://{addr}"), recorded)
}

#[test]
fn superagent_companion_announces_unified_server_and_all_tool_groups() {
    let comp = superagent_companion(None, None);

    let init = comp.classify(&json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize"
    }));
    let LineAction::Respond(init_text) = init else {
        panic!("expected initialize response");
    };
    let init_json: Value = serde_json::from_str(&init_text).unwrap();
    assert_eq!(
        init_json["result"]["serverInfo"]["name"],
        "Dimo-superagent-mcp"
    );

    let list = comp.classify(&json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/list"
    }));
    let LineAction::Respond(list_text) = list else {
        panic!("expected tools/list response");
    };
    let list_json: Value = serde_json::from_str(&list_text).unwrap();
    let names: Vec<&str> = list_json["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|t| t["name"].as_str())
        .collect();

    assert!(names.contains(&"delegate_to_agent"));
    assert!(names.contains(&"get_session_info"));
    assert!(names.contains(&"list_spaces"));
    for pulse_name in PULSE_TOOL_NAMES {
        assert!(
            names.contains(pulse_name),
            "missing pulse tool {pulse_name}"
        );
    }
    for wf_name in [
        "workflow_source_read",
        "workflow_source_write",
        "workflow_graph_patch",
        "workflow_validate",
        "workflow_publish",
        "workflow_catalog",
        "workflow_run_inspect",
        "workflow_start",
        "workflow_debug_source",
        "workflow_debug_from_step",
        "workflow_pause_run",
        "workflow_cancel_run",
        "workflow_resume_run",
        "workflow_pause_step",
        "workflow_continue_step",
        "workflow_accept_candidate",
        "workflow_review_step",
        "workflow_decide_approval",
    ] {
        assert!(names.contains(&wf_name), "missing workflow tool {wf_name}");
    }
}

#[tokio::test]
async fn workflow_graph_patch_presets_cas_and_exhaustive_validation() {
    let ws = temp_workspace("graph-patch");
    let comp = superagent_companion(Some(ws.clone()), None);

    // 1. Apply hybrid_pipeline preset + write to relative path
    let patched = comp
        .execute_workflow_call(
            "workflow_graph_patch",
            json!({
                "path": "workflows/ci-hybrid.dimo-workflow.json",
                "write": true,
                "operations": [
                    {
                        "op": "apply_preset",
                        "preset": "hybrid_pipeline",
                        "params": {
                            "name": "CI Hybrid",
                            "agentId": "codex",
                            "memberId": "bot-reviewer",
                            "maxIterations": 4
                        }
                    }
                ]
            }),
            None,
            Some(&json!(1)),
        )
        .await
        .unwrap();

    assert_eq!(patched["valid"], true);
    assert_eq!(patched["written"], true);
    let rev1 = patched["revision"].as_str().unwrap().to_string();
    assert!(rev1.starts_with("sha256:"));
    assert_eq!(patched["summary"]["sessionSteps"], 1);
    assert_eq!(patched["summary"]["botSteps"], 2);
    assert_eq!(patched["summary"]["boundedLoopSteps"], 1);

    // 2. Writing again with stale CAS revision is rejected
    let stale = comp
        .execute_workflow_call(
            "workflow_graph_patch",
            json!({
                "path": "workflows/ci-hybrid.dimo-workflow.json",
                "expectedRevision": "sha256:stale",
                "write": true,
                "operations": [{
                    "op": "update_step",
                    "stepId": "code_session",
                    "patch": { "prompt": "Updated prompt" }
                }]
            }),
            None,
            Some(&json!(2)),
        )
        .await
        .unwrap();
    assert_eq!(stale["isError"], true);
    assert_eq!(stale["violations"][0]["code"], "cas_revision_mismatch");

    // 3. Path traversal is blocked
    let escape = comp
        .execute_workflow_call(
            "workflow_graph_patch",
            json!({
                "path": "../outside.dimo-workflow.json",
                "write": true
            }),
            None,
            Some(&json!(3)),
        )
        .await
        .unwrap();
    assert_eq!(escape["isError"], true);
    assert_eq!(escape["violations"][0]["code"], "invalid_source_path");

    // 4. Exhaustive No-Fail-Fast check collects ALL violations in one pass
    let invalid = comp
        .execute_workflow_call(
            "workflow_graph_patch",
            json!({
                "definition": {
                    "schemaVersion": 2,
                    "name": "",
                    "steps": [
                        {
                            "id": "bad_session",
                            "kind": "session",
                            "agentId": "",
                            "prompt": "",
                            "dependsOn": ["missing_step"]
                        },
                        {
                            "id": "bad_loop",
                            "kind": "bounded_loop",
                            "maxIterations": 0,
                            "bodyStepIds": [],
                            "conditionPointer": "not-a-pointer"
                        }
                    ]
                }
            }),
            None,
            Some(&json!(4)),
        )
        .await
        .unwrap();
    assert_eq!(invalid["isError"], true);
    assert_eq!(invalid["valid"], false);
    let codes: Vec<&str> = invalid["violations"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|v| v["code"].as_str())
        .collect();
    assert!(codes.contains(&"empty_workflow_name"));
    assert!(codes.contains(&"unknown_dependency"));
    assert!(codes.contains(&"missing_agent_id"));
    assert!(codes.contains(&"empty_prompt"));
    assert!(codes.contains(&"max_iterations_below_minimum"));
    assert!(codes.contains(&"empty_loop_body"));
    assert!(codes.contains(&"invalid_condition_pointer"));

    let _ = std::fs::remove_dir_all(&ws);
}

#[tokio::test]
async fn workflow_source_and_control_tools_bridge_to_host_and_preserve_x_dimo_headers() {
    let ws = temp_workspace("host-bridge");
    let (base_url, recorded) = spawn_workflow_mock_host(|command, args| match command {
        "workflow_validate" => (
            200,
            json!({
                "data": {
                    "valid": true,
                    "normalized": args["request"]["definition"]
                }
            }),
        ),
        "workflow_publish" => (
            200,
            json!({
                "data": {
                    "definitionId": "wf_def_1",
                    "versionId": "wf_ver_1",
                    "version": 1
                }
            }),
        ),
        "workflow_show" => (
            200,
            json!({
                "data": {
                    "id": args["runId"],
                    "definitionVersionId": "wf_ver_1",
                    "status": "completed"
                }
            }),
        ),
        "workflow_version" => (
            200,
            json!({
                "data": {
                    "id": args["versionId"],
                    "normalizedJson": "{\"name\":\"Demo\",\"steps\":[]}"
                }
            }),
        ),
        "workflow_steps" => (
            200,
            json!({ "data": [{ "stepId": "s1", "status": "completed" }] }),
        ),
        "workflow_events" => (
            200,
            json!({ "data": [{ "sequence": 1, "kind": "run_completed" }] }),
        ),
        _ => (200, json!({ "data": { "ok": true } })),
    })
    .await;

    let comp = superagent_companion(Some(ws.clone()), Some(base_url));
    let def = json!({
        "name": "Bridge Test",
        "steps": [{
            "id": "s1",
            "kind": "agent",
            "agentId": "codex",
            "prompt": "Fix CI"
        }]
    });

    // Write via workflow_source_write (calls workflow_validate on host first)
    let written = comp
        .execute_workflow_call(
            "workflow_source_write",
            json!({
                "path": "ci.dimo-workflow.json",
                "definition": def
            }),
            None,
            Some(&json!(10)),
        )
        .await
        .unwrap();
    let rev = written["revision"].as_str().unwrap().to_string();
    assert!(rev.starts_with("sha256:"));

    // Read back with CAS revision
    let read_back = comp
        .execute_workflow_call(
            "workflow_source_read",
            json!({ "path": "ci.dimo-workflow.json" }),
            None,
            Some(&json!(11)),
        )
        .await
        .unwrap();
    assert_eq!(read_back["revision"], rev);
    assert_eq!(read_back["definition"]["name"], "Bridge Test");

    // Publish + inspect run
    let published = comp
        .execute_workflow_call(
            "workflow_publish",
            json!({
                "definition": def,
                "sourcePath": "ci.dimo-workflow.json"
            }),
            None,
            Some(&json!(12)),
        )
        .await
        .unwrap();
    assert_eq!(published["versionId"], "wf_ver_1");

    let inspected = comp
        .execute_workflow_call(
            "workflow_run_inspect",
            json!({ "runId": "run_1" }),
            None,
            Some(&json!(13)),
        )
        .await
        .unwrap();
    assert_eq!(inspected["run"]["id"], "run_1");
    assert_eq!(inspected["definition"]["name"], "Demo");
    assert_eq!(inspected["events"][0]["kind"], "run_completed");

    let calls = recorded.lock().unwrap().clone();
    assert!(
        calls
            .iter()
            .all(|(_, _, proto)| proto.as_deref() == Some("1.0"))
    );
    assert!(calls.iter().any(|(cmd, _, _)| cmd == "workflow_validate"));
    assert!(calls.iter().any(|(cmd, _, _)| cmd == "workflow_publish"));
    assert!(calls.iter().any(|(cmd, _, _)| cmd == "workflow_show"));

    let _ = std::fs::remove_dir_all(&ws);
}
