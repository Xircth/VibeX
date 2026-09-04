use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};

use agents::{
    AgentAutoApproveMode, AgentContentBlock, AgentEvent, AgentEventEnvelope, AgentId,
    AgentPromptId, AgentPromptStatus, AgentRuntime, AgentSessionId, CancelAgentPromptInput,
    ConnectAgentInput, RespondAgentPermissionInput, ResumeAgentSessionInput, RuntimeEventSink,
    SendAgentPromptInput, SessionLaunchLock,
};
use tokio::sync::mpsc;
use uuid::Uuid;

const FULL_GATE_FIXTURE_PROMPT: &str = "__vibex_agent_full_gate_fixture__";

fn fixture_launch_lock(agent_id: agents::AgentId) -> SessionLaunchLock {
    SessionLaunchLock {
        agent_id,
        absolute_acp_program: PathBuf::from("/tmp/vibex-fixture-acp"),
        args: Vec::new(),
        env: BTreeMap::new(),
        runtime_version: "fixture-runtime".to_string(),
        acp_version: "fixture-acp".to_string(),
    }
}

#[derive(Clone)]
struct TestSink {
    tx: mpsc::UnboundedSender<AgentEventEnvelope>,
}

impl RuntimeEventSink for TestSink {
    fn emit(&self, envelope: AgentEventEnvelope) {
        let _ = self.tx.send(envelope);
    }
}

#[tokio::test]
async fn all_registered_agents_pass_fixture_session_gate() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let runtime = AgentRuntime::new_with_driver(Arc::new(TestSink { tx }), false);

    for raw_id in ["claude_code", "codex", "opencode", "pi", "vendor.generic"] {
        run_agent_fixture_gate(&runtime, &mut rx, AgentId::parse(raw_id).unwrap()).await;
    }
}

async fn run_agent_fixture_gate(
    runtime: &AgentRuntime,
    rx: &mut mpsc::UnboundedReceiver<AgentEventEnvelope>,
    agent_id: AgentId,
) {
    let workspace_id = Uuid::new_v4();
    let working_dir = PathBuf::from(format!("fixture-workspace/{agent_id}"));
    let connection = runtime
        .connect(ConnectAgentInput {
            agent_id: agent_id.clone(),
            launch_lock: fixture_launch_lock(agent_id.clone()),
            workspace_id,
            working_dir: working_dir.clone(),
            additional_directories: Vec::new(),
            auto_approve_mode: AgentAutoApproveMode::Off,
            env: HashMap::new(),
        })
        .await
        .unwrap();
    let session = runtime
        .new_session(connection.id, format!("{agent_id}-new-session"))
        .await
        .unwrap();

    let prompt = runtime
        .send_prompt(SendAgentPromptInput {
            connection_id: connection.id,
            session_id: session.id,
            blocks: vec![AgentContentBlock::Text {
                text: FULL_GATE_FIXTURE_PROMPT.to_string(),
            }],
            mode_override: None,
            config_overrides: Vec::new(),
        })
        .await
        .unwrap();
    assert!(matches!(prompt.status, AgentPromptStatus::Running));

    let mut events = Vec::new();
    let permission_event = wait_for_event(
        rx,
        connection.id,
        &mut events,
        |event| matches!(event, AgentEvent::PermissionRequested { .. }),
        "permission request",
    )
    .await;
    let permission_id = match permission_event {
        AgentEvent::PermissionRequested { request } => {
            assert_eq!(request.session_id, session.id);
            assert!(
                request
                    .options
                    .iter()
                    .any(|option| option.id == "allow-once")
            );
            request.id
        }
        _ => unreachable!(),
    };

    runtime
        .respond_permission(RespondAgentPermissionInput {
            connection_id: connection.id,
            permission_id,
            response: agents::AgentPermissionResponse::Selected {
                option_id: "allow-once".to_string(),
            },
        })
        .await
        .unwrap();

    wait_for_event(
        rx,
        connection.id,
        &mut events,
        |event| {
            matches!(
                event,
                AgentEvent::PromptFinished { finished }
                    if finished.prompt_id == prompt.id
                        && finished.stop_reason.as_deref() == Some("end_turn")
            )
        },
        "fixture prompt completion",
    )
    .await;

    assert_has(&agent_id, &events, "connection ready", |event| {
        matches!(event, AgentEvent::ConnectionStatusChanged { .. })
    });
    assert_has(&agent_id, &events, "session created", |event| {
        matches!(event, AgentEvent::SessionCreated { .. })
    });
    assert_has(&agent_id, &events, "streaming text", |event| {
        matches!(event, AgentEvent::MessageChunk { .. })
    });
    assert_has(&agent_id, &events, "tool call", |event| {
        matches!(event, AgentEvent::ToolCall { .. })
    });
    assert_has(&agent_id, &events, "tool update", |event| {
        matches!(event, AgentEvent::ToolCallUpdate { .. })
    });
    assert_has(&agent_id, &events, "available commands", |event| {
        matches!(event, AgentEvent::AvailableCommands { .. })
    });
    assert_has(&agent_id, &events, "session modes", |event| {
        matches!(event, AgentEvent::SessionModes { .. })
    });
    assert_has(&agent_id, &events, "config options", |event| {
        matches!(event, AgentEvent::SessionConfigOptions { .. })
    });
    assert_has(&agent_id, &events, "manual permission response", |event| {
        matches!(event, AgentEvent::PermissionResponded { auto: false, .. })
    });
    assert_has(&agent_id, &events, "turn completed", |event| {
        matches!(
            event,
            AgentEvent::TurnCompleted {
                stop_reason: Some(reason)
            } if reason == "end_turn"
        )
    });

    let resumed_session_id = AgentSessionId::new();
    let resumed = runtime
        .resume_session(ResumeAgentSessionInput {
            agent_id: agent_id.clone(),
            launch_lock: fixture_launch_lock(agent_id.clone()),
            workspace_id,
            working_dir: working_dir.clone(),
            additional_directories: Vec::new(),
            session_id: resumed_session_id,
            external_session_id: format!("{agent_id}-resume-session"),
            auto_approve_mode: AgentAutoApproveMode::Off,
            env: HashMap::new(),
            preferences: Default::default(),
        })
        .await
        .unwrap();
    assert_eq!(resumed.id, resumed_session_id);
    assert!(resumed.acp_session_id.ends_with("-resume-session"));

    let interrupt_prompt = runtime
        .send_prompt(SendAgentPromptInput {
            connection_id: connection.id,
            session_id: session.id,
            blocks: vec![AgentContentBlock::Text {
                text: "interrupt me".to_string(),
            }],
            mode_override: None,
            config_overrides: Vec::new(),
        })
        .await
        .unwrap();
    wait_for_message(rx, connection.id, interrupt_prompt.id, "interrupt me").await;
    cancel_and_wait(runtime, rx, connection.id, session.id, interrupt_prompt.id).await;

    let retry_prompt = runtime
        .send_prompt(SendAgentPromptInput {
            connection_id: connection.id,
            session_id: session.id,
            blocks: vec![AgentContentBlock::Text {
                text: "retry after interrupt".to_string(),
            }],
            mode_override: None,
            config_overrides: Vec::new(),
        })
        .await
        .unwrap();
    wait_for_message(rx, connection.id, retry_prompt.id, "retry after interrupt").await;
    cancel_and_wait(runtime, rx, connection.id, session.id, retry_prompt.id).await;
}

async fn wait_for_message(
    rx: &mut mpsc::UnboundedReceiver<AgentEventEnvelope>,
    connection_id: agents::AgentConnectionId,
    prompt_id: AgentPromptId,
    expected: &str,
) {
    let mut events = Vec::new();
    wait_for_event(
        rx,
        connection_id,
        &mut events,
        |event| {
            matches!(
                event,
                AgentEvent::MessageChunk {
                    content: AgentContentBlock::Text { text }
                } if text.contains(expected)
            )
        },
        &format!("message chunk for {prompt_id}"),
    )
    .await;
}

async fn cancel_and_wait(
    runtime: &AgentRuntime,
    rx: &mut mpsc::UnboundedReceiver<AgentEventEnvelope>,
    connection_id: agents::AgentConnectionId,
    session_id: AgentSessionId,
    prompt_id: AgentPromptId,
) {
    runtime
        .cancel_prompt(CancelAgentPromptInput {
            connection_id,
            session_id,
            prompt_id,
        })
        .await
        .unwrap();
    let mut events = Vec::new();
    wait_for_event(
        rx,
        connection_id,
        &mut events,
        |event| {
            matches!(
                event,
                AgentEvent::PromptFinished { finished }
                    if finished.prompt_id == prompt_id
                        && finished.stop_reason.as_deref() == Some("cancelled")
            )
        },
        "cancelled prompt completion",
    )
    .await;
}

async fn wait_for_event(
    rx: &mut mpsc::UnboundedReceiver<AgentEventEnvelope>,
    connection_id: agents::AgentConnectionId,
    events: &mut Vec<AgentEvent>,
    predicate: impl Fn(&AgentEvent) -> bool,
    label: &str,
) -> AgentEvent {
    loop {
        let envelope = tokio::time::timeout(Duration::from_secs(3), rx.recv())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for {label}"))
            .unwrap_or_else(|| panic!("event stream closed waiting for {label}"));
        if envelope.connection_id != connection_id {
            continue;
        }
        let event = envelope.event;
        let matched = predicate(&event);
        events.push(event.clone());
        if matched {
            return event;
        }
    }
}

fn assert_has(
    agent_id: &AgentId,
    events: &[AgentEvent],
    label: &str,
    predicate: impl Fn(&AgentEvent) -> bool,
) {
    assert!(
        events.iter().any(predicate),
        "{agent_id} fixture gate missing {label}; events: {events:?}"
    );
}

#[tokio::test]
async fn missing_acp_program_fails_with_actionable_error_not_raw_enoent() {
    let (tx, _rx) = mpsc::unbounded_channel();
    // `driver_enabled = true` so `connect` actually spawns the ACP program.
    let runtime = AgentRuntime::new_with_driver(Arc::new(TestSink { tx }), true);

    let missing = PathBuf::from("/definitely/not/here/vibex-acp");
    let result = runtime
        .connect(ConnectAgentInput {
            agent_id: AgentId::parse("grok").unwrap(),
            launch_lock: SessionLaunchLock {
                agent_id: AgentId::parse("grok").unwrap(),
                absolute_acp_program: missing.clone(),
                args: vec!["agent".to_string(), "stdio".to_string()],
                env: BTreeMap::new(),
                runtime_version: "1.0.4".to_string(),
                acp_version: "1".to_string(),
            },
            workspace_id: Uuid::new_v4(),
            working_dir: PathBuf::from("fixture-workspace/missing-acp"),
            additional_directories: Vec::new(),
            auto_approve_mode: AgentAutoApproveMode::Off,
            env: HashMap::new(),
        })
        .await;

    let error = result.expect_err("spawn of a missing program must fail");
    let message = error.to_string();
    assert!(
        message.contains("missing at") && message.contains("reinstall"),
        "expected an actionable repair error, got: {message}"
    );
    assert!(
        !message.contains("No such file or directory"),
        "raw spawn ENOENT must not leak: {message}"
    );
}
