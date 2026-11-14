use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};

use agents::{
    AgentContentBlock, AgentEventEnvelope, AgentId, AgentRuntime, AgentSessionId, NoopEventSink,
    SessionLaunchLock, conversation::ContinuationPolicy,
};
use conversations::{
    AgentRuntimeLaunchSettings, ConversationContext, ConversationHost, ConversationServiceError,
    ConversationSessionService, ConversationStartTurnInput,
};
use db::models::{
    conversation::{ConversationAgentBindingRecord, ConversationRecord, CreateConversationRecord},
    project::{CreateProject, Project},
    repo::Repo,
    task::{CreateTask, Task},
    workspace::{CreateWorkspace, Workspace},
};
use deployment::Deployment;
use local_deployment::LocalDeployment;
use sqlx::SqlitePool;
use tokio::sync::Mutex;
use uuid::Uuid;

struct FixtureHost;

#[async_trait::async_trait]
impl ConversationHost for FixtureHost {
    fn resolve_working_dir(&self, _: &Workspace, container: &str, _: &[Repo]) -> Option<String> {
        Some(container.into())
    }
    fn resolve_additional_directories(
        &self,
        _: &Workspace,
        _: &str,
        _: &[Repo],
        _: &str,
    ) -> Vec<PathBuf> {
        Vec::new()
    }
    async fn build_prompt_blocks(
        &self,
        _: &str,
        text: String,
        _: &[String],
        _: &[agents::ConversationFileRef],
    ) -> Result<Vec<AgentContentBlock>, ConversationServiceError> {
        Ok(vec![AgentContentBlock::Text { text }])
    }
    async fn launch_settings(
        &self,
        _: &SqlitePool,
        agent: &AgentId,
    ) -> Result<AgentRuntimeLaunchSettings, ConversationServiceError> {
        Ok(AgentRuntimeLaunchSettings {
            auto_approve_mode: agents::AgentAutoApproveMode::Off,
            env: HashMap::new(),
            launch_lock: SessionLaunchLock {
                agent_id: agent.clone(),
                absolute_acp_program: std::env::temp_dir().join("fixture-acp"),
                args: Vec::new(),
                env: BTreeMap::new(),
                runtime_version: "fixture".into(),
                acp_version: "fixture".into(),
            },
        })
    }
}

struct Fixture {
    _data: tempfile::TempDir,
    _work: tempfile::TempDir,
    ctx: ConversationContext,
    service: ConversationSessionService,
    conversation: Uuid,
    workspace: Uuid,
}

impl Fixture {
    async fn new() -> Self {
        let data = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let deployment = Arc::new(LocalDeployment::new_at(data.path()).await.unwrap());
        let pool = &deployment.db().pool;
        let project = Project::create(
            pool,
            &CreateProject {
                name: "continuation".into(),
                root_path: work.path().to_string_lossy().into(),
                ..Default::default()
            },
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        let task = Task::create(
            pool,
            &CreateTask::from_title_description(project.id, "continuation".into(), None),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        let workspace = Workspace::create(
            pool,
            &CreateWorkspace {
                project_id: project.id,
                parent_workspace_id: None,
                branch: "main".into(),
                container_ref: Some(work.path().to_string_lossy().into()),
                use_worktree: false,
                agent_working_dir: Some(work.path().to_string_lossy().into()),
            },
            Uuid::new_v4(),
            task.id,
        )
        .await
        .unwrap();
        let conversation = Uuid::new_v4();
        ConversationRecord::create(
            pool,
            conversation,
            CreateConversationRecord {
                workspace_id: workspace.id,
                task_id: None,
                title: None,
                initial_prompt: None,
                status: None,
                executor: Some("claude_code"),
            },
        )
        .await
        .unwrap();
        let runtime = Arc::new(AgentRuntime::new_with_driver(
            Arc::new(NoopEventSink),
            false,
        ));
        let ctx = ConversationContext {
            deployment,
            agent_runtime: runtime,
            turn_locks: Arc::new(Mutex::new(HashMap::new())),
            runtime_states: Default::default(),
            row_projectors: Default::default(),
            host: Arc::new(FixtureHost),
            event_publisher: Arc::new(conversations::NoopConversationEventPublisher),
        };
        Self {
            _data: data,
            _work: work,
            service: ConversationSessionService::new(ctx.clone()),
            ctx,
            conversation,
            workspace: workspace.id,
        }
    }

    fn input(&self, agent: &str, text: &str) -> ConversationStartTurnInput {
        ConversationStartTurnInput {
            continuation_policy: Some(ContinuationPolicy::Portable),
            expected_binding_revision: None,
            agent_id: AgentId::parse(agent).unwrap(),
            workspace_id: self.workspace,
            conversation_id: self.conversation,
            executor_profile_id: None,
            text: text.into(),
            display_text: None,
            images: Vec::new(),
            mode_override: None,
            config_overrides: Vec::new(),
            workflow_refs: Vec::new(),
            file_refs: Vec::new(),
            internal_prompt_contributions: Vec::new(),
            queued_input_claim: None,
            operation_id: Some(Uuid::new_v4()),
            collaboration_origin: None,
        }
    }
}

/// The first dispatch on a new conversation succeeds (in-memory driver),
/// setting the Turn to "running". Truncate must refuse while it's in flight.
#[tokio::test]
async fn truncate_rejects_a_pending_turn_without_rewriting_its_history() {
    let f = Fixture::new().await;
    let first = f
        .service
        .submit_and_dispatch(f.input("claude_code", "first request"), "user")
        .await
        .unwrap();
    assert!(first.turn.is_some(), "first dispatch creates a Turn");
    let turn = first.turn.unwrap();
    assert!(
        matches!(turn.status.as_str(), "pending" | "running" | "queued"),
        "Turn is in-flight: {}",
        turn.status
    );
    let result = f.service.truncate_to_turn(f.conversation, 0).await;
    assert!(
        matches!(result, Err(ConversationServiceError::Conflict(_))),
        "truncate must reject an active Turn: {result:?}"
    );
    let conversation = ConversationRecord::find_by_id(&f.ctx.deployment.db().pool, f.conversation)
        .await
        .unwrap()
        .unwrap();
    assert!(conversation.active_turn_id.is_some());
    f.service.cancel_turn(f.conversation, None).await.unwrap();
    let _ = f
        .ctx
        .agent_runtime
        .disconnect(
            f.ctx
                .agent_runtime
                .live_connection_id(AgentSessionId(f.conversation))
                .await
                .unwrap(),
        )
        .await;
}

/// Cold cross-agent switch: claude_code → codex in the same Conversation.
/// The in-memory driver processes both prompts. The second must carry
/// the first user message as quoted history context.
#[tokio::test]
async fn cold_switch_keeps_conversation_directory_and_original_display_history() {
    let f = Fixture::new().await;
    let first = f
        .service
        .submit_and_dispatch(f.input("claude_code", "remember the amber key"), "user")
        .await
        .unwrap();
    assert!(first.turn.is_some());
    f.service.cancel_turn(f.conversation, None).await.unwrap();
    if let Some(conn_id) = f
        .ctx
        .agent_runtime
        .live_connection_id(AgentSessionId(f.conversation))
        .await
    {
        let _ = f.ctx.agent_runtime.disconnect(conn_id).await;
    }
    let mut events = f.ctx.agent_runtime.subscribe_events();
    let second = f
        .service
        .submit_and_dispatch(f.input("codex", "continue the work"), "user")
        .await
        .unwrap();
    assert!(second.turn.is_some(), "second dispatch creates a Turn");
    let mut delivered_prompt = None;
    for _ in 0..30 {
        let event: AgentEventEnvelope = tokio::time::timeout(Duration::from_secs(2), events.recv())
            .await
            .unwrap()
            .unwrap();
        if let agents::AgentEvent::MessageChunk {
            content: AgentContentBlock::Text { text },
        } = event.event
        {
            delivered_prompt = Some(text);
            break;
        }
    }
    let prompt = delivered_prompt.expect("fixture receives target prompt");
    assert!(
        prompt.contains("remember the amber key"),
        "codex receives amber key from history: {prompt}"
    );
    assert!(
        prompt.contains("continue the work"),
        "codex receives current user request: {prompt}"
    );
    let pool = &f.ctx.deployment.db().pool;
    let active = ConversationAgentBindingRecord::active_for_conversation(pool, f.conversation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        active.agent_id.as_str(),
        "codex",
        "active binding switched to codex"
    );
    assert_eq!(
        PathBuf::from(&active.working_dir),
        f._work.path(),
        "working directory preserved"
    );
    f.service.cancel_turn(f.conversation, None).await.unwrap();
    let page = conversations::read_history_page(
        pool,
        f.conversation,
        &delegation_proto::SessionHistoryRequest {
            max_chars: Some(65536),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let users = page
        .items
        .iter()
        .filter(|i| i.role == agents::TurnRole::User)
        .map(|i| i.text.as_str())
        .collect::<Vec<_>>();
    assert_eq!(users, ["remember the amber key", "continue the work"]);
}

/// Stage C: Claude → Codex → Claude resume.
/// After switching to Codex and back to Claude, the original Claude binding
/// should be resumed (not cold-started), and only the history gap (Codex turns)
/// should be carried as context.
#[tokio::test]
async fn resume_switch_restores_original_binding_and_carries_only_the_gap() {
    let f = Fixture::new().await;
    let pool = &f.ctx.deployment.db().pool;

    // Step 1: Claude processes first request.
    let first = f
        .service
        .submit_and_dispatch(f.input("claude_code", "remember the amber key"), "user")
        .await
        .unwrap();
    assert!(first.turn.is_some(), "Claude turn created");
    f.service.cancel_turn(f.conversation, None).await.unwrap();
    // Explicitly disconnect the Claude connection so the async task state is cleared.
    if let Some(conn_id) = f
        .ctx
        .agent_runtime
        .live_connection_id(AgentSessionId(f.conversation))
        .await
    {
        let _ = f.ctx.agent_runtime.disconnect(conn_id).await;
    }
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // Record Claude's binding before switching away.
    let claude_binding =
        ConversationAgentBindingRecord::active_for_conversation(pool, f.conversation)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(claude_binding.agent_id.as_str(), "claude_code");
    let claude_acp_session = claude_binding
        .acp_session_id
        .clone()
        .expect("Claude has native session");

    // Step 2: Switch to Codex (cold start).
    let mut codex_input = f.input("codex", "continue the work");
    codex_input.continuation_policy = Some(ContinuationPolicy::Portable);
    let second = f
        .service
        .submit_and_dispatch(codex_input, "user")
        .await
        .unwrap();
    assert!(second.turn.is_some(), "Codex turn created");
    f.service.cancel_turn(f.conversation, None).await.unwrap();
    if let Some(conn_id) = f
        .ctx
        .agent_runtime
        .live_connection_id(AgentSessionId(f.conversation))
        .await
    {
        let _ = f.ctx.agent_runtime.disconnect(conn_id).await;
    }
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // Verify active binding is now Codex.
    let codex_binding =
        ConversationAgentBindingRecord::active_for_conversation(pool, f.conversation)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(codex_binding.agent_id.as_str(), "codex");

    // Step 3: Switch back to Claude (should resume, not cold start).
    let mut resume_input = f.input("claude_code", "what did we find?");
    resume_input.continuation_policy = Some(ContinuationPolicy::Portable);
    let mut events = f.ctx.agent_runtime.subscribe_events();
    let third = f
        .service
        .submit_and_dispatch(resume_input, "user")
        .await
        .unwrap();
    assert!(third.turn.is_some(), "Claude resume turn created");

    // Verify the active binding is Claude again, and it's the SAME binding row
    // (not a new cold-start binding).
    let resumed_binding =
        ConversationAgentBindingRecord::active_for_conversation(pool, f.conversation)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(
        resumed_binding.agent_id.as_str(),
        "claude_code",
        "switched back to Claude"
    );
    assert_eq!(
        resumed_binding.id, claude_binding.id,
        "resumed the original Claude binding (Stage C resume)"
    );
    assert_eq!(
        resumed_binding.acp_session_id.as_deref(),
        Some(claude_acp_session.as_str()),
        "native session restored"
    );

    // Verify the prompt carried only the gap (Codex turns), not the full history.
    let mut delivered_prompt = None;
    for _ in 0..30 {
        let event: AgentEventEnvelope = tokio::time::timeout(Duration::from_secs(2), events.recv())
            .await
            .unwrap()
            .unwrap();
        if let agents::AgentEvent::MessageChunk {
            content: AgentContentBlock::Text { text },
        } = event.event
        {
            delivered_prompt = Some(text);
            break;
        }
    }
    let prompt = delivered_prompt.expect("Claude receives prompt after resume");
    // The resumed Claude should see the Codex turn as a gap, but NOT the first
    // Claude turn (which it already knows natively). A cold start would carry
    // the full history and therefore also quote the amber key.
    assert!(
        prompt.contains("continue the work"),
        "Claude sees Codex turn as gap: {prompt}"
    );
    assert!(
        prompt.contains("what did we find?"),
        "Claude sees current request: {prompt}"
    );
    assert!(
        !prompt.contains("remember the amber key"),
        "resume must not re-deliver history Claude already owns natively: {prompt}"
    );

    f.service.cancel_turn(f.conversation, None).await.unwrap();

    // Verify display history is continuous across all three agents.
    let page = conversations::read_history_page(
        pool,
        f.conversation,
        &delegation_proto::SessionHistoryRequest {
            max_chars: Some(65536),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let users: Vec<_> = page
        .items
        .iter()
        .filter(|i| i.role == agents::TurnRole::User)
        .map(|i| i.text.as_str())
        .collect();
    assert_eq!(
        users,
        [
            "remember the amber key",
            "continue the work",
            "what did we find?"
        ]
    );
}

/// Stage C: continuation key isolates agents. Claude's resume head must not
/// be selected when switching to Codex (different continuation key).
#[tokio::test]
async fn continuation_key_isolates_agents_so_codex_does_not_resume_claude() {
    let f = Fixture::new().await;
    let pool = &f.ctx.deployment.db().pool;

    // Claude runs first.
    f.service
        .submit_and_dispatch(f.input("claude_code", "first"), "user")
        .await
        .unwrap();
    f.service.cancel_turn(f.conversation, None).await.unwrap();
    if let Some(conn_id) = f
        .ctx
        .agent_runtime
        .live_connection_id(AgentSessionId(f.conversation))
        .await
    {
        let _ = f.ctx.agent_runtime.disconnect(conn_id).await;
    }
    // Yield to let the in-memory runner's command loop process the disconnect.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let claude_binding =
        ConversationAgentBindingRecord::active_for_conversation(pool, f.conversation)
            .await
            .unwrap()
            .unwrap();

    // Codex cold-starts (different agent = different continuation key).
    f.service
        .submit_and_dispatch(f.input("codex", "second"), "user")
        .await
        .unwrap();
    f.service.cancel_turn(f.conversation, None).await.unwrap();
    let codex_binding =
        ConversationAgentBindingRecord::active_for_conversation(pool, f.conversation)
            .await
            .unwrap()
            .unwrap();

    // The two bindings must have different continuation keys.
    assert_ne!(
        claude_binding.continuation_key, codex_binding.continuation_key,
        "different agents have different continuation keys"
    );
    assert_ne!(
        claude_binding.id, codex_binding.id,
        "different agents have different binding rows"
    );
}

/// Switching back and forth repeatedly must not re-deliver the same gap.
/// A second return to Claude must not carry the Codex turn again, because
/// Claude already received it through the first handoff.
#[tokio::test]
async fn repeated_switch_back_does_not_re_deliver_a_known_gap() {
    let f = Fixture::new().await;
    let pool = &f.ctx.deployment.db().pool;

    async fn settle(f: &Fixture) {
        f.service.cancel_turn(f.conversation, None).await.unwrap();
        if let Some(conn_id) = f
            .ctx
            .agent_runtime
            .live_connection_id(AgentSessionId(f.conversation))
            .await
        {
            let _ = f.ctx.agent_runtime.disconnect(conn_id).await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    // Claude #1
    f.service
        .submit_and_dispatch(f.input("claude_code", "claude first"), "user")
        .await
        .unwrap();
    settle(&f).await;

    // Codex #1 — cold, receives Claude #1 as gap.
    f.service
        .submit_and_dispatch(f.input("codex", "codex first"), "user")
        .await
        .unwrap();
    settle(&f).await;

    // Claude #2 — resumes; should receive only the Codex gap.
    f.service
        .submit_and_dispatch(f.input("claude_code", "claude second"), "user")
        .await
        .unwrap();
    settle(&f).await;

    // Deliver the first Claude resume handoff so its selection counts as known.
    sqlx::query("UPDATE conversation_handoffs SET status = 'delivered', evidence = 'test' WHERE status IN ('sending', 'planned')")
        .execute(pool)
        .await
        .unwrap();

    // Codex #2 — resumes Codex; must not re-receive its own earlier turn.
    let mut events = f.ctx.agent_runtime.subscribe_events();
    f.service
        .submit_and_dispatch(f.input("codex", "codex second"), "user")
        .await
        .unwrap();
    let mut delivered = None;
    for _ in 0..30 {
        let event: AgentEventEnvelope = tokio::time::timeout(Duration::from_secs(2), events.recv())
            .await
            .unwrap()
            .unwrap();
        if let agents::AgentEvent::MessageChunk {
            content: AgentContentBlock::Text { text },
        } = event.event
        {
            delivered = Some(text);
            break;
        }
    }
    let prompt = delivered.expect("Codex receives its second prompt");
    assert!(
        !prompt.contains("codex first"),
        "Codex must not re-receive its own native turn: {prompt}"
    );
    assert!(prompt.contains("codex second"));
}
