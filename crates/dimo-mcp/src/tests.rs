    use delegation_proto::BrokerMessage;

    use super::*;

    fn companion(features: &str) -> Arc<Companion> {
        Arc::new(Companion::new(Args {
            parent_connection_id: "conn-1".to_string(),
            socket_path: "/tmp/does-not-matter.sock".to_string(),
            token: "tok".to_string(),
            features: CompanionFeatures::parse(Some(features)),
            server_url: None,
            server_token: None,
            conversation_id: None,
            workspace_root: None,
            product: "delegation".to_string(),
        }))
    }

    fn classify(features: &str, line: &str) -> LineAction {
        let value: Value = serde_json::from_str(line).unwrap();
        companion(features).classify(&value)
    }

    fn respond_text(action: LineAction) -> Value {
        match action {
            LineAction::Respond(text) => serde_json::from_str(&text).unwrap(),
            _ => panic!("expected Respond"),
        }
    }

    #[test]
    fn initialize_returns_server_info() {
        let value = respond_text(classify(
            "delegation",
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#,
        ));
        assert_eq!(value["result"]["serverInfo"]["name"], "dimo-mcp");
        assert_eq!(value["result"]["protocolVersion"], "2025-11-25");
        assert_eq!(value["id"], 1);
    }

    #[test]
    fn initialize_echoes_a_legacy_protocol_version_claude_code_requests() {
        let value = respond_text(classify(
            "delegation",
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}"#,
        ));
        assert_eq!(value["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(value["result"]["capabilities"]["tools"], json!({}));
    }

    #[test]
    fn initialize_echoes_2025_03_26_when_requested() {
        let value = respond_text(classify(
            "delegation",
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}"#,
        ));
        assert_eq!(value["result"]["protocolVersion"], "2025-03-26");
    }

    #[test]
    fn initialize_echoes_2025_06_18_when_claude_code_requests_it() {
        let value = respond_text(classify(
            "delegation",
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}"#,
        ));
        assert_eq!(
            value["result"]["protocolVersion"], "2025-06-18",
            "Claude Code's MCP client still requests 2025-06-18; answering 2026-07-28 makes it refuse the server as too new"
        );
    }

    #[test]
    fn initialize_keeps_modern_protocol_when_requested() {
        let value = respond_text(classify(
            "delegation",
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-07-28"}}"#,
        ));
        assert_eq!(value["result"]["protocolVersion"], "2026-07-28");
    }

    #[test]
    fn initialize_falls_back_when_the_client_asks_for_an_unknown_revision() {
        let value = respond_text(classify(
            "delegation",
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"1999-01-01"}}"#,
        ));
        assert_eq!(value["result"]["protocolVersion"], "2025-11-25");
    }

    #[test]
    fn discover_answers_claude_code_2026_stdio_probe() {
        let value = respond_text(classify(
            "delegation",
            r#"{"jsonrpc":"2.0","id":"server-discover-probe-1","method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"claude-code","version":"2.1.303"}}}}"#,
        ));
        assert!(
            value.get("error").is_none(),
            "Claude Code 2.1.292+ stdio probes server/discover first; method-not-found makes it fall back to the handshake"
        );
        assert_eq!(value["result"]["resultType"], "complete");
        assert_eq!(
            value["result"]["supportedVersions"],
            json!(["2026-07-28"]),
            "listing only the modern revision keeps Claude on 2026-07-28 after the probe"
        );
        assert_eq!(value["result"]["capabilities"]["tools"], json!({}));
        assert_eq!(
            value["result"]["_meta"]["io.modelcontextprotocol/serverInfo"]["name"],
            "dimo-mcp"
        );
    }

    #[test]
    fn tools_list_after_modern_discover_does_not_need_initialize() {
        let value = respond_text(classify(
            "delegation",
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}"#,
        ));
        assert!(value["result"]["tools"].is_array());
        assert_eq!(value["result"]["resultType"], "complete");
        assert_eq!(
            value["result"]["_meta"]["io.modelcontextprotocol/serverInfo"]["name"],
            "dimo-mcp"
        );
    }

    #[test]
    fn ping_returns_an_empty_result() {
        let value = respond_text(classify(
            "delegation",
            r#"{"jsonrpc":"2.0","id":10,"method":"ping"}"#,
        ));
        assert_eq!(value["id"], 10);
        assert_eq!(value["result"], json!({}));
        assert!(value.get("error").is_none());
    }

    #[test]
    fn tools_list_reflects_features() {
        let value = respond_text(classify(
            "delegation",
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
        ));
        let names: Vec<&str> = value["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        assert!(names.contains(&"delegate_to_agent"));
        assert!(names.contains(&"cancel_delegation"));
        assert!(!names.contains(&"check_user_feedback"));
        assert!(!names.contains(&"ask_user_question"));
        assert!(!names.contains(&"plugin_dev_link_request"));
        assert!(!names.contains(&"ask_person"));
    }

    #[test]
    fn send_session_input_member_id_distinguishes_identity_and_seat() {
        let value = respond_text(classify(
            "collaboration",
            r#"{"jsonrpc":"2.0","id":24,"method":"tools/list"}"#,
        ));
        let tools = value["result"]["tools"].as_array().unwrap();
        let send = tools
            .iter()
            .find(|tool| tool["name"] == "send_session_input")
            .expect("send_session_input");
        let member_id = send["inputSchema"]["properties"]["member_id"]["description"]
            .as_str()
            .expect("member_id description");
        assert!(member_id.contains("identity_member_id"));
        assert!(member_id.contains("list_spaces"));
        assert!(member_id.contains("manage_group"));
        assert!(member_id.contains("different namespaces"));

        let list = tools
            .iter()
            .find(|tool| tool["name"] == "list_spaces")
            .expect("list_spaces");
        let list_desc = list["description"].as_str().expect("list description");
        assert!(list_desc.contains("identity_member_id"));
        assert!(list_desc.contains("lead_bot"));
    }

    #[test]
    fn post_to_space_schema_asks_for_progress_reports() {
        let value = respond_text(classify(
            "collaboration,space",
            r#"{"jsonrpc":"2.0","id":25,"method":"tools/list"}"#,
        ));
        let tools = value["result"]["tools"].as_array().unwrap();
        let post = tools
            .iter()
            .find(|tool| tool["name"] == "post_space_message")
            .expect("post_space_message");
        let desc = post["description"].as_str().expect("description");
        assert!(
            desc.contains("ordinary assistant text") && desc.contains("in-space progress"),
            "{desc}"
        );
        assert!(
            !desc.contains("report progress during a long task"),
            "{desc}"
        );
        assert!(!desc.contains("acknowledgment/plan"), "{desc}");
        assert!(
            desc.contains("restate")
                || desc.contains("already posted")
                || desc.contains("incremental"),
            "{desc}"
        );
        assert!(
            desc.contains("lead") || desc.contains("space lead") || desc.contains("lead_bot"),
            "{desc}"
        );
        assert!(
            desc.contains("ordinary assistant text") || desc.contains("ordinary"),
            "{desc}"
        );
        assert!(desc.contains("Person"), "{desc}");
        assert!(
            post["inputSchema"]["properties"]
                .get("operation_id")
                .is_none(),
            "operation_id must not be an LLM argument"
        );
    }

    #[test]
    fn list_space_member_schema_exposes_space_lead() {
        let value = respond_text(classify(
            "collaboration",
            r#"{"jsonrpc":"2.0","id":26,"method":"tools/list"}"#,
        ));
        let tools = value["result"]["tools"].as_array().unwrap();
        let list = tools
            .iter()
            .find(|tool| tool["name"] == "list_spaces")
            .expect("list_spaces");
        let list_desc = list["description"].as_str().expect("list description");
        assert!(
            list_desc.contains("lead_nickname") && list_desc.contains("lead_bot"),
            "{list_desc}"
        );
        assert!(
            list_desc.contains("activity")
                && list_desc.contains("waiting_for_bot")
                && list_desc.contains("working"),
            "{list_desc}"
        );
        assert!(
            list_desc.contains("BotSpace") && list_desc.contains("GroupSpace"),
            "{list_desc}"
        );
    }

    #[test]
    fn tool_schema_explains_agent_mentions() {
        let value = respond_text(classify(
            "delegation",
            r#"{"jsonrpc":"2.0","id":23,"method":"tools/list"}"#,
        ));
        let description = value["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == "delegate_to_agent")
            .and_then(|tool| tool["description"].as_str())
            .expect("delegate_to_agent description");

        assert!(description.contains("every AgentMention"));
        assert!(description.contains("[&Codex](dimo://agent/codex)"));
        assert!(description.contains("does not itself start"));
        assert!(description.contains("ASYNCHRONOUS"));
        assert!(description.contains("do not call search_tool"));
        assert!(description.contains("MUST call get_delegation_status"));
    }

    #[test]
    fn all_features_expose_five_tools() {
        let value = respond_text(classify(
            "delegation,feedback,ask",
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/list"}"#,
        ));
        assert_eq!(value["result"]["tools"].as_array().unwrap().len(), 5);
    }

    #[test]
    fn session_info_feature_is_independent() {
        let value = respond_text(classify(
            "sessions",
            r#"{"jsonrpc":"2.0","id":31,"method":"tools/list"}"#,
        ));
        let names = value["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect::<Vec<_>>();

        assert_eq!(names, vec!["get_session_info", "thread_read_history"]);
    }

    #[test]
    fn session_control_exposes_send_cancel_and_wait_only() {
        let value = respond_text(classify(
            "session-control",
            r#"{"jsonrpc":"2.0","id":32,"method":"tools/list"}"#,
        ));
        let names = value["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            names,
            vec![
                "send_session_input",
                "cancel_session_turn",
                "wait_for_session"
            ]
        );
    }

    #[test]
    fn collaboration_opens_same_workspace_tools_without_session_control() {
        let value = respond_text(classify(
            "collaboration",
            r#"{"jsonrpc":"2.0","id":33,"method":"tools/list"}"#,
        ));
        let names = value["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            names,
            vec![
                "ask_user_question",
                "get_session_info",
                "thread_read_history",
                "send_session_input",
                "list_conversations",
                "create_conversation",
                "list_spaces",
                "manage_bot",
            ]
        );
        assert!(!names.contains(&"read_space_messages"));
        assert!(!names.contains(&"post_space_message"));
        assert!(!names.contains(&"manage_group"));
        assert!(!names.contains(&"request_approval"));
        assert!(!names.contains(&"memory_search"));
        assert!(!names.contains(&"memory_write"));
        assert!(!names.contains(&"cancel_session_turn"));
        assert!(!names.contains(&"wait_for_session"));
        assert!(!names.contains(&"delegate_to_agent"));
        assert!(!names.contains(&"handoff"));
        assert!(!names.contains(&"ask_person"));
        assert!(!names.contains(&"resolve_card"));
        assert!(!names.contains(&"list_space_collection"));
        assert!(!names.contains(&"create_role"));
        assert!(!names.contains(&"list_collaboration_spaces"));
        assert!(!names.contains(&"post_to_space"));
    }

    #[test]
    fn space_session_opens_the_full_collaboration_toolset() {
        let value = respond_text(classify(
            "collaboration,space",
            r#"{"jsonrpc":"2.0","id":34,"method":"tools/list"}"#,
        ));
        let names = value["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            names,
            vec![
                "ask_user_question",
                "get_session_info",
                "thread_read_history",
                "send_session_input",
                "list_conversations",
                "create_conversation",
                "list_spaces",
                "read_space_messages",
                "post_space_message",
                "manage_bot",
                "manage_group",
                "request_approval",
                "memory_search",
                "memory_write",
            ]
        );
    }

    #[test]
    fn collaboration_write_injects_operation_id_from_tool_use_id() {
        let mut args = json!({"space_id": "space-1", "content": "hi"});
        ensure_operation_id(
            &mut args,
            Some(&json!({"tool_use_id": "call-abc"})),
            Some(&json!(7)),
        );
        let expected = Uuid::new_v5(&Uuid::NAMESPACE_URL, b"call-abc");
        assert_eq!(args["operation_id"], expected.to_string());
    }

    #[test]
    fn collaboration_write_injects_operation_id_from_request_id() {
        let mut args = json!({"space_id": "space-1", "content": "hi"});
        ensure_operation_id(&mut args, None, Some(&json!(42)));
        let expected = Uuid::new_v5(&Uuid::NAMESPACE_URL, b"42");
        assert_eq!(args["operation_id"], expected.to_string());
    }

    #[test]
    fn collaboration_write_keeps_explicit_operation_id() {
        let mut args = json!({"operation_id": "550e8400-e29b-41d4-a716-446655440000"});
        ensure_operation_id(
            &mut args,
            Some(&json!({"tool_use_id": "other"})),
            Some(&json!(1)),
        );
        assert_eq!(args["operation_id"], "550e8400-e29b-41d4-a716-446655440000");
    }

    #[test]
    fn companion_scopes_operation_id_per_call_and_instance() {
        let c1 = companion("collaboration,space");
        let c2 = companion("collaboration,space");
        let mut first = json!({"space_id": "space-1", "content": "msg 1"});
        let mut second = json!({"space_id": "space-1", "content": "msg 2"});
        let mut other_bot = json!({"space_id": "space-1", "content": "msg 1"});

        c1.ensure_call_operation_id(
            "post_space_message",
            &mut first,
            Some(&json!({"progressToken": 1})),
            Some(&json!(1)),
        );
        c1.ensure_call_operation_id(
            "post_space_message",
            &mut second,
            Some(&json!({"progressToken": 1})),
            Some(&json!(1)),
        );
        c2.ensure_call_operation_id(
            "post_space_message",
            &mut other_bot,
            Some(&json!({"progressToken": 1})),
            Some(&json!(1)),
        );

        let op1 = first["operation_id"].as_str().unwrap();
        let op2 = second["operation_id"].as_str().unwrap();
        let op3 = other_bot["operation_id"].as_str().unwrap();
        assert_ne!(op1, op2);
        assert_ne!(op1, op3);
        assert_ne!(op2, op3);
    }

    #[test]
    fn manage_bot_list_agents_does_not_need_operation_id() {
        assert!(!collaboration_needs_operation_id(
            "manage_bot",
            &json!({"action": "list_agents"})
        ));
        assert!(!collaboration_needs_operation_id(
            "manage_bot",
            &json!({"action": "list_options"})
        ));
        assert!(collaboration_needs_operation_id(
            "manage_bot",
            &json!({"action": "create", "nickname": "Bot"})
        ));
        assert!(collaboration_needs_operation_id(
            "manage_bot",
            &json!({"action": "update"})
        ));
    }

    #[test]
    fn session_send_requires_explicit_operation_id() {
        let companion = companion("session-control");
        let error = companion
            .build_message(
                "send_session_input",
                &json!({
                    "conversation_id": "550e8400-e29b-41d4-a716-446655440000",
                    "text": "continue"
                }),
                None,
            )
            .unwrap_err();
        assert_eq!(error, "operation_id is required");
    }

    #[test]
    fn delegate_reads_progress_token_as_parent_tool_use_id() {
        let companion = companion("delegation");
        let message = companion
            .build_message(
                "delegate_to_agent",
                &json!({"agent_type":"codex","task":"x"}),
                Some(&json!({"progressToken": "call-1"})),
            )
            .unwrap();
        match message {
            BrokerMessage::Call(req) => assert_eq!(req.parent_tool_use_id, "call-1"),
            _ => panic!("expected Call"),
        }
    }

    #[test]
    fn tools_call_classifies_as_call() {
        let action = classify(
            "delegation",
            r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"delegate_to_agent","arguments":{"agent_type":"codex","task":"x"}}}"#,
        );
        match action {
            LineAction::Call { name, .. } => assert_eq!(name, "delegate_to_agent"),
            _ => panic!("expected Call"),
        }
    }

    #[test]
    fn cancelled_notification_classifies_as_cancel() {
        let action = classify(
            "delegation",
            r#"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":7}}"#,
        );
        match action {
            LineAction::Cancel { request_id } => assert_eq!(request_id, Some(json!(7))),
            _ => panic!("expected Cancel"),
        }
    }

    #[test]
    fn other_notifications_are_ignored() {
        assert!(matches!(
            classify(
                "delegation",
                r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#
            ),
            LineAction::Ignore
        ));
    }

    #[test]
    fn unknown_method_errors() {
        let value = respond_text(classify(
            "delegation",
            r#"{"jsonrpc":"2.0","id":9,"method":"nope"}"#,
        ));
        assert_eq!(value["error"]["code"], -32601);
    }

    #[test]
    fn companion_prefers_http_when_a_server_url_is_present() {
        let injected = Companion::new(Args {
            parent_connection_id: "conn-1".to_string(),
            socket_path: "/tmp/dimo-delegation.sock".to_string(),
            token: "tok".to_string(),
            features: CompanionFeatures::parse(Some("delegation")),
            server_url: Some("http://127.0.0.1:9".to_string()),
            server_token: Some("plugin-token".to_string()),
            conversation_id: Some("conv".to_string()),
            workspace_root: None,
            product: "delegation".to_string(),
        });
        assert!(injected.uses_http());
        let native = Companion::new(Args {
            parent_connection_id: String::new(),
            socket_path: String::new(),
            token: "plugin-token".to_string(),
            features: CompanionFeatures::parse(Some("delegation")),
            server_url: Some("http://127.0.0.1:9".to_string()),
            server_token: Some("plugin-token".to_string()),
            conversation_id: None,
            workspace_root: None,
            product: "delegation".to_string(),
        });
        assert!(native.uses_http());
    }

    #[test]
    fn http_client_builds_after_crypto_provider_install() {
        client::install_rustls_crypto_provider();
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(8))
            .build()
            .expect("sidecar HTTP client requires an installed rustls provider");
    }

    #[test]
    fn conversation_id_falls_back_to_the_parent_process_env() {
        assert_eq!(
            resolve_conversation_id(Some("from-flag".to_string())).as_deref(),
            Some("from-flag")
        );
        // SAFETY: this process-local env key is only read by resolve_conversation_id
        // in this test and is restored afterwards.
        let previous = std::env::var("DIMO_CONVERSATION_ID").ok();
        unsafe {
            std::env::set_var("DIMO_CONVERSATION_ID", " from-env ");
        }
        assert_eq!(resolve_conversation_id(None).as_deref(), Some("from-env"));
        unsafe {
            match previous {
                Some(value) => std::env::set_var("DIMO_CONVERSATION_ID", value),
                None => std::env::remove_var("DIMO_CONVERSATION_ID"),
            }
        }
    }

    #[test]
    fn feature_gate_rejects_disabled_tool() {
        let c = companion("delegation");
        assert!(!c.features.allows_tool("check_user_feedback"));
        assert!(c.features.allows_tool("delegate_to_agent"));
    }

    #[test]
    fn build_message_validates_status_args() {
        let c = companion("delegation");
        let err = c
            .build_message("get_delegation_status", &json!({ "task_ids": [] }), None)
            .unwrap_err();
        assert!(err.contains("non-empty"));
    }

    // End-to-end transport round-trip over the real platform socket.
    #[cfg(windows)]
    #[tokio::test]
    async fn call_broker_round_trips_over_named_pipe() {
        use delegation_proto::{
            BrokerResponse, DelegationTaskReport, TaskStatus, read_frame, write_frame,
        };
        use tokio::net::windows::named_pipe::ServerOptions;

        let path = format!(r"\\.\pipe\dimo-mcp-test-{}", std::process::id());
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&path)
            .unwrap();
        let server_task = tokio::spawn(async move {
            let mut conn = server;
            conn.connect().await.unwrap();
            let received: BrokerMessage = read_frame(&mut conn).await.unwrap();
            let response = BrokerResponse::Task(DelegationTaskReport {
                task_id: Some("t1".to_string()),
                status: TaskStatus::Running,
                child_session_id: None,
                agent_type: None,
                text: None,
                error_code: None,
                message: None,
                duration_ms: None,
            });
            write_frame(&mut conn, &response).await.unwrap();
            received
        });

        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        let message = BrokerMessage::Status(BrokerStatusRequest {
            token: "tok".to_string(),
            task_ids: vec!["t1".to_string()],
            wait_ms: None,
        });
        let response = client::call_broker(&path, &message)
            .await
            .unwrap()
            .into_outcome();
        assert_eq!(response["status"], "running");
        assert!(matches!(
            server_task.await.unwrap(),
            BrokerMessage::Status(_)
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn call_broker_round_trips_over_uds() {
        use delegation_proto::{
            BrokerResponse, DelegationTaskReport, TaskStatus, read_frame, write_frame,
        };

        let dir = std::env::temp_dir();
        let path = dir.join(format!("dimo-mcp-test-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let path_str = path.to_string_lossy().to_string();
        let server_task = tokio::spawn(async move {
            let (mut conn, _) = listener.accept().await.unwrap();
            let received: BrokerMessage = read_frame(&mut conn).await.unwrap();
            let response = BrokerResponse::Task(DelegationTaskReport {
                task_id: Some("t1".to_string()),
                status: TaskStatus::Running,
                child_session_id: None,
                agent_type: None,
                text: None,
                error_code: None,
                message: None,
                duration_ms: None,
            });
            write_frame(&mut conn, &response).await.unwrap();
            received
        });

        let message = BrokerMessage::Status(BrokerStatusRequest {
            token: "tok".to_string(),
            task_ids: vec!["t1".to_string()],
            wait_ms: None,
        });
        let response = client::call_broker(&path_str, &message)
            .await
            .unwrap()
            .into_outcome();
        assert_eq!(response["status"], "running");
        assert!(matches!(
            server_task.await.unwrap(),
            BrokerMessage::Status(_)
        ));
    }

    #[test]
    fn thread_read_history_maps_item_ids_to_session_info_and_never_exposes_tool_search() {
        let comp = companion("sessions");
        assert!(comp.features.allows_tool("thread_read_history"));
        assert!(!comp.features.allows_tool("tool_search"));

        let listed = respond_text(classify(
            "sessions",
            r#"{"jsonrpc":"2.0","id":77,"method":"tools/list"}"#,
        ));
        let names: Vec<&str> = listed["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        assert!(names.contains(&"thread_read_history"));
        assert!(!names.contains(&"tool_search"));

        let msg = comp
            .build_message(
                "thread_read_history",
                &json!({
                    "conversation_id": "550e8400-e29b-41d4-a716-446655440000",
                    "item_ids": ["row-1", "row-2"]
                }),
                None,
            )
            .expect("valid thread_read_history message");
        match msg {
            BrokerMessage::SessionInfo(req) => {
                assert_eq!(
                    req.conversation_id,
                    "550e8400-e29b-41d4-a716-446655440000"
                );
                assert_eq!(req.max_messages, 0);
                assert_eq!(req.history.item_ids, vec!["row-1", "row-2"]);
                assert!(req.history.is_paged());
            }
            other => panic!("unexpected broker message: {other:?}"),
        }

        let err = comp
            .build_message("thread_read_history", &json!({ "item_ids": [] }), None)
            .expect_err("empty item_ids must be rejected");
        assert!(err.contains("item_ids"));
    }
