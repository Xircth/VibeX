use super::*;

impl AgentConnectionRunner {
    pub(in crate::manager) async fn run_full_gate_fixture(
        &self,
        acp_session_id: &str,
        session_id: AgentSessionId,
        prompt_id: AgentPromptId,
    ) {
        self.record_in_memory_update(
            acp_session_id,
            &SessionUpdate::AgentMessageChunk(acp::schema::v1::ContentChunk::new(
                ContentBlock::from("fixture stream chunk"),
            )),
        );
        self.emit(
            Some(session_id),
            Some(prompt_id),
            AgentEvent::MessageChunk {
                content: AgentContentBlock::Text {
                    text: "fixture stream chunk".to_string(),
                },
            },
        );
        self.record_in_memory_update(
            acp_session_id,
            &SessionUpdate::ToolCall(
                acp::schema::v1::ToolCall::new("fixture-tool", "Inspect fixture workspace")
                    .kind(acp::schema::v1::ToolKind::Read),
            ),
        );
        self.emit(
            Some(session_id),
            Some(prompt_id),
            AgentEvent::ToolCall {
                tool_call: AgentToolCall {
                    status: None,
                    content: None,
                    id: "fixture-tool".to_string(),
                    title: "Inspect fixture workspace".to_string(),
                    kind: Some("read".to_string()),
                    input_preview: None,
                    meta: None,
                    images: Vec::new(),
                },
            },
        );
        self.record_in_memory_update(
            acp_session_id,
            &SessionUpdate::ToolCallUpdate(acp::schema::v1::ToolCallUpdate::new(
                "fixture-tool",
                acp::schema::v1::ToolCallUpdateFields::new()
                    .status(acp::schema::v1::ToolCallStatus::InProgress)
                    .content(vec![acp::schema::v1::ToolCallContent::from(
                        "reading fixture input",
                    )]),
            )),
        );
        self.emit(
            Some(session_id),
            Some(prompt_id),
            AgentEvent::ToolCallUpdate {
                update: AgentToolCallUpdate {
                    id: "fixture-tool".to_string(),
                    title: None,
                    status: Some("running".to_string()),
                    content: Some("reading fixture input".to_string()),
                    input_preview: None,
                    meta: None,
                    images: Vec::new(),
                },
            },
        );
        self.emit(
            Some(session_id),
            None,
            AgentEvent::AvailableCommands {
                commands: vec![AgentAvailableCommand {
                    name: "/fixture".to_string(),
                    description: Some("Run fixture command".to_string()),
                    input_schema: Some(serde_json::json!({"type": "object"})),
                }],
            },
        );
        self.emit(
            Some(session_id),
            None,
            AgentEvent::SessionModes {
                modes: vec![
                    AgentSessionMode {
                        id: "plan".to_string(),
                        label: "Plan".to_string(),
                        description: Some("Plan fixture changes".to_string()),
                    },
                    AgentSessionMode {
                        id: "code".to_string(),
                        label: "Code".to_string(),
                        description: Some("Apply fixture changes".to_string()),
                    },
                ],
                current: Some("code".to_string()),
            },
        );
        self.emit(
            Some(session_id),
            None,
            AgentEvent::SessionConfigOptions {
                options: vec![AgentSessionConfigOption {
                    key: "model".to_string(),
                    label: "Model".to_string(),
                    description: Some("Fixture model selector".to_string()),
                    category: Some("model".to_string()),
                    value: Some(serde_json::json!("fixture-model")),
                    choices: vec![AgentSessionConfigChoice {
                        value: serde_json::json!("fixture-model"),
                        label: "Fixture Model".to_string(),
                        description: None,
                    }],
                    dependency: None,
                }],
            },
        );

        let permission_id = AgentPermissionId::new();
        let request = AgentPermissionRequest {
            id: permission_id,
            session_id,
            title: "Allow fixture tool".to_string(),
            details: Some(serde_json::json!({
                "tool": "fixture-tool",
                "prompt_id": prompt_id.to_string(),
            })),
            options: vec![
                AgentPermissionOption {
                    id: "allow-once".to_string(),
                    label: "Allow once".to_string(),
                    kind: AgentPermissionOptionKind::AllowOnce,
                    description: None,
                },
                AgentPermissionOption {
                    id: "reject-once".to_string(),
                    label: "Reject once".to_string(),
                    kind: AgentPermissionOptionKind::RejectOnce,
                    description: None,
                },
            ],
        };
        let configured = *self.auto_approve_mode.lock().await;
        let auto_approve_mode =
            effective_auto_approve_mode(configured, &self.session_controls, session_id).await;
        if let Some(response) = decide_auto_permission_response(auto_approve_mode, &request) {
            self.emit(
                Some(session_id),
                None,
                AgentEvent::PermissionResponded {
                    permission_id,
                    response,
                    auto: true,
                },
            );
            self.emit_full_gate_completion(acp_session_id, session_id, prompt_id)
                .await;
            return;
        }

        self.emit(
            Some(session_id),
            None,
            AgentEvent::PermissionRequested {
                request: request.clone(),
            },
        );

        let (tx, rx) = oneshot::channel();
        self.pending_permissions.lock().await.insert(
            permission_id.to_string(),
            PendingPermission {
                permission_id,
                session_id,
                options: request.options.clone(),
                tx,
            },
        );
        let runner = self.clone();
        let acp_session_id = acp_session_id.to_string();
        tokio::spawn(async move {
            let _ = rx.await;
            runner
                .emit_full_gate_completion(&acp_session_id, session_id, prompt_id)
                .await;
        });
    }

    pub(in crate::manager) async fn emit_full_gate_completion(
        &self,
        acp_session_id: &str,
        session_id: AgentSessionId,
        prompt_id: AgentPromptId,
    ) {
        self.record_in_memory_update(
            acp_session_id,
            &SessionUpdate::ToolCallUpdate(acp::schema::v1::ToolCallUpdate::new(
                "fixture-tool",
                acp::schema::v1::ToolCallUpdateFields::new()
                    .status(acp::schema::v1::ToolCallStatus::Completed)
                    .content(vec![acp::schema::v1::ToolCallContent::from(
                        "fixture tool completed",
                    )]),
            )),
        );
        self.emit(
            Some(session_id),
            Some(prompt_id),
            AgentEvent::ToolCallUpdate {
                update: AgentToolCallUpdate {
                    id: "fixture-tool".to_string(),
                    title: None,
                    status: Some("completed".to_string()),
                    content: Some("fixture tool completed".to_string()),
                    input_preview: None,
                    meta: None,
                    images: Vec::new(),
                },
            },
        );
        self.record_turn_end(acp_session_id, session_id, "end_turn", 0, None)
            .await;
        self.emit(
            Some(session_id),
            Some(prompt_id),
            AgentEvent::TurnCompleted {
                stop_reason: Some("end_turn".to_string()),
            },
        );
        self.emit(
            Some(session_id),
            Some(prompt_id),
            AgentEvent::PromptFinished {
                finished: AgentPromptFinished {
                    prompt_id,
                    stop_reason: Some("end_turn".to_string()),
                    usage: None,
                },
            },
        );
    }
}
