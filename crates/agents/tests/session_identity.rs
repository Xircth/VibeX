use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::Arc,
};

use agents::{
    AgentAutoApproveMode, AgentEvent, AgentId, AgentRuntime, ConnectAgentInput, ConversationEvent,
    NoopEventSink, SessionLaunchLock,
};
use uuid::Uuid;

#[tokio::test]
async fn session_eligibility_uses_open_agent_id() {
    let runtime = AgentRuntime::new_with_driver(Arc::new(NoopEventSink), false);
    let agent_id = AgentId::parse("vendor.agent-v2").expect("valid Registry identity");

    let connection = runtime
        .connect(ConnectAgentInput {
            agent_id: agent_id.clone(),
            launch_lock: SessionLaunchLock {
                agent_id: agent_id.clone(),
                absolute_acp_program: PathBuf::from("/tmp/vibex-fixture-acp"),
                args: Vec::new(),
                env: BTreeMap::new(),
                runtime_version: "fixture-runtime".to_string(),
                acp_version: "fixture-acp".to_string(),
            },
            workspace_id: Uuid::new_v4(),
            working_dir: PathBuf::from("/tmp/vibex-open-agent-session"),
            additional_directories: Vec::new(),
            auto_approve_mode: AgentAutoApproveMode::Off,
            env: HashMap::new(),
        })
        .await
        .expect("an open AgentId must be eligible for the live session seam");

    assert_eq!(connection.agent_id, agent_id);
    runtime
        .new_session(connection.id, "vendor-acp-session")
        .await
        .expect("the in-memory ACP driver accepts the generic Agent session");

    let snapshot = runtime.snapshot().await;
    assert_eq!(snapshot.connections[0].agent_id.as_str(), "vendor.agent-v2");

    let linked = serde_json::to_value(AgentEvent::SessionLinked {
        acp_session_id: "vendor-acp-session".to_string(),
        agent_id: agent_id.clone(),
        capabilities: Default::default(),
    })
    .unwrap();
    assert_eq!(linked["agent_id"], "vendor.agent-v2");

    let binding = serde_json::to_value(ConversationEvent::AgentBindingStarted {
        agent_id,
        working_dir: "/tmp/vibex-open-agent-session".to_string(),
    })
    .unwrap();
    assert_eq!(binding["agent_id"], "vendor.agent-v2");
}
