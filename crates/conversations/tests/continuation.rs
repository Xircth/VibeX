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
            provider_instance_id: None,
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

#[tokio::test]
async fn persisting_switched_session_agent_before_turn_still_delivers_portable_handoff() {
    let f = Fixture::new().await;
    let pool = &f.ctx.deployment.db().pool;

    f.service
        .submit_and_dispatch(f.input("claude_code", "remember the amber key"), "user")
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
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Simulate confirming an Agent switch in the UI before sending the next message:
    // `sessions.agent_id` and `sessions.executor` are immediately updated so the
    // session list and Bot/Session details reflect `codex`, while `active_agent_binding_id`
    // still points to the last bound runtime (`claude_code`).
    sqlx::query(
        "UPDATE sessions SET agent_id = 'codex', agent_type = 'codex', executor = 'codex', model = NULL WHERE id = ?",
    )
    .bind(f.conversation)
    .execute(pool)
    .await
    .unwrap();

    let mut events = f.ctx.agent_runtime.subscribe_events();
    let second = f
        .service
        .submit_and_dispatch(f.input("codex", "continue on codex"), "user")
        .await
        .unwrap();
    assert!(second.turn.is_some());

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
    let prompt = delivered_prompt.expect("Codex receives prompt with portable history");
    assert!(
        prompt.contains("remember the amber key"),
        "Codex must still receive portable history even after sessions.agent_id was updated at switch time: {prompt}"
    );
    let active = ConversationAgentBindingRecord::active_for_conversation(pool, f.conversation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(active.agent_id.as_str(), "codex");
    f.service.cancel_turn(f.conversation, None).await.unwrap();
}

#[tokio::test]
async fn placeholder_binding_upgrade_via_link_native_session_preserves_a_b_a_context_and_preferences()
{
    let f = Fixture::new().await;
    let pool = &f.ctx.deployment.db().pool;
    let claude_id = AgentId::parse("claude_code").unwrap();

    // Step 1: Start Turn 1 on Claude.
    f.service
        .submit_and_dispatch(f.input("claude_code", "remember the cobalt token"), "user")
        .await
        .unwrap();

    let initial_binding =
        ConversationAgentBindingRecord::active_for_conversation(pool, f.conversation)
            .await
            .unwrap()
            .unwrap();
    let real_claude_acp_session = initial_binding
        .acp_session_id
        .clone()
        .expect("in-memory driver assigned native session id");
    let orig_working_dir = initial_binding.working_dir.clone();
    let orig_continuation_key = initial_binding.continuation_key.clone();
    assert!(!orig_working_dir.is_empty());

    // Simulate pre-SessionLinked state where prepare_session initially stored a `prepared-*`
    // placeholder ID and remembered user-selected controls (`plan` + `claude-opus-4-6`).
    sqlx::query(
        "UPDATE conversation_agent_bindings
         SET acp_session_id = 'prepared-turn-1',
             current_mode = 'plan',
             config_selection_json = '{\"model\":\"claude-opus-4-6\"}'
         WHERE id = ?",
    )
    .bind(initial_binding.id)
    .execute(pool)
    .await
    .unwrap();

    // Simulate `AgentLifecycleEvent::SessionLinked` arriving with `working_dir = ""`.
    let linked = ConversationAgentBindingRecord::link_native_session(
        pool,
        f.conversation,
        &claude_id,
        "",
        &real_claude_acp_session,
        "conn-linked-1",
    )
    .await
    .unwrap();

    assert_eq!(
        linked.id, initial_binding.id,
        "placeholder binding must upgrade in place instead of splitting a second row"
    );
    assert_eq!(
        linked.acp_session_id.as_deref(),
        Some(real_claude_acp_session.as_str())
    );
    assert_eq!(
        linked.working_dir, orig_working_dir,
        "empty working_dir on SessionLinked must preserve existing working_dir"
    );
    assert_eq!(linked.continuation_key, orig_continuation_key);
    assert!(linked.is_resume_head);

    let claude_row_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM conversation_agent_bindings WHERE conversation_id = ? AND agent_id = 'claude_code'",
    )
    .bind(f.conversation)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(claude_row_count, 1);

    f.service.cancel_turn(f.conversation, None).await.unwrap();
    if let Some(conn_id) = f
        .ctx
        .agent_runtime
        .live_connection_id(AgentSessionId(f.conversation))
        .await
    {
        let _ = f.ctx.agent_runtime.disconnect(conn_id).await;
    }
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Seed a conflicting global default (`default`) for Claude so Stage C must read `Some(&resume)`
    // (`plan`) rather than falling back to global agent defaults.
    db::models::agent_management::SessionDefaultRepository::new(pool.clone())
        .upsert(&claude_id, "mode", "\"default\"")
        .await
        .unwrap();

    // Step 2: Switch to Codex (Stage B).
    f.service
        .submit_and_dispatch(f.input("codex", "codex gap message"), "user")
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
    tokio::time::sleep(Duration::from_millis(50)).await;

    let max_ready_seq_before: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(sequence), 0) FROM conversation_events
         WHERE conversation_id = ? AND event_kind = 'agent_binding_ready'",
    )
    .bind(f.conversation)
    .fetch_one(pool)
    .await
    .unwrap();

    // Step 3: Switch back to Claude (Stage C resume).
    let mut events = f.ctx.agent_runtime.subscribe_events();
    let third = f
        .service
        .submit_and_dispatch(f.input("claude_code", "resume claude"), "user")
        .await
        .unwrap();
    assert!(third.turn.is_some());

    let resumed_binding =
        ConversationAgentBindingRecord::active_for_conversation(pool, f.conversation)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(resumed_binding.id, initial_binding.id);
    assert_eq!(
        resumed_binding.acp_session_id.as_deref(),
        Some(real_claude_acp_session.as_str())
    );
    assert_eq!(resumed_binding.current_mode.as_deref(), Some("plan"));
    assert!(
        resumed_binding
            .config_selection_json
            .contains("claude-opus-4-6")
    );

    let ready_events_after: Vec<String> = sqlx::query_scalar(
        "SELECT normalized_json FROM conversation_events
         WHERE conversation_id = ? AND event_kind = 'agent_binding_ready' AND sequence > ?
         ORDER BY sequence ASC",
    )
    .bind(f.conversation)
    .bind(max_ready_seq_before)
    .fetch_all(pool)
    .await
    .unwrap();
    assert!(
        ready_events_after
            .iter()
            .any(|raw| raw.contains(&real_claude_acp_session)),
        "Stage C resume must emit AgentBindingReady for the resumed session: {ready_events_after:?}"
    );

    let mut replayed_mode = None;
    let mut replayed_model = None;
    let mut delivered_prompt = None;
    for _ in 0..40 {
        let event: AgentEventEnvelope = tokio::time::timeout(Duration::from_secs(2), events.recv())
            .await
            .unwrap()
            .unwrap();
        match event.event {
            agents::AgentEvent::ModeChanged { mode_id } => {
                replayed_mode = Some(mode_id);
            }
            agents::AgentEvent::ConfigChanged { key, value } if key == "model" => {
                replayed_model = value.as_str().map(str::to_string);
            }
            agents::AgentEvent::MessageChunk {
                content: AgentContentBlock::Text { text },
            } => {
                delivered_prompt = Some(text);
                break;
            }
            _ => {}
        }
    }
    assert_eq!(
        replayed_mode.as_deref(),
        Some("plan"),
        "Stage C resume must replay Agent A's remembered mode over global defaults"
    );
    assert_eq!(
        replayed_model.as_deref(),
        Some("claude-opus-4-6"),
        "Stage C resume must replay Agent A's remembered model config selection"
    );
    let prompt = delivered_prompt.expect("Claude receives delta prompt after resume");
    assert!(
        prompt.contains("codex gap message"),
        "Claude must receive Codex gap turn: {prompt}"
    );
    assert!(
        prompt.contains("resume claude"),
        "Claude must receive current turn prompt: {prompt}"
    );
    assert!(
        !prompt.contains("remember the cobalt token"),
        "Turn 1 stayed owned by upgraded binding row and must not be re-delivered: {prompt}"
    );

    f.service.cancel_turn(f.conversation, None).await.unwrap();
}

#[tokio::test]
async fn unlinked_placeholder_binding_is_excluded_from_stage_c_resume_and_cold_starts_with_full_history()
{
    let f = Fixture::new().await;
    let pool = &f.ctx.deployment.db().pool;

    f.service
        .submit_and_dispatch(f.input("claude_code", "remember the sapphire token"), "user")
        .await
        .unwrap();
    let placeholder_binding =
        ConversationAgentBindingRecord::active_for_conversation(pool, f.conversation)
            .await
            .unwrap()
            .unwrap();
    sqlx::query(
        "UPDATE conversation_agent_bindings SET acp_session_id = 'prepared-never-linked' WHERE id = ?",
    )
    .bind(placeholder_binding.id)
    .execute(pool)
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
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Switch to Codex for Turn 2.
    f.service
        .submit_and_dispatch(f.input("codex", "codex second turn"), "user")
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
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Switch back to Claude: `prepared-never-linked` must NOT be selected as a Stage C resume candidate;
    // Stage B cold-starts a fresh binding and carries full portable history including Turn 1.
    let mut events = f.ctx.agent_runtime.subscribe_events();
    f.service
        .submit_and_dispatch(f.input("claude_code", "back on claude"), "user")
        .await
        .unwrap();

    let new_binding = ConversationAgentBindingRecord::active_for_conversation(pool, f.conversation)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(
        new_binding.id, placeholder_binding.id,
        "unlinked placeholder binding must not be resumed via Stage C"
    );

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
    let prompt = delivered_prompt.expect("Claude receives cold-start portable history");
    assert!(
        prompt.contains("remember the sapphire token"),
        "Stage B cold start must include Turn 1 portable history: {prompt}"
    );
    assert!(
        prompt.contains("codex second turn"),
        "Stage B cold start must include Turn 2 portable history: {prompt}"
    );

    f.service.cancel_turn(f.conversation, None).await.unwrap();
}
#[tokio::test]
async fn handoff_budget_exceeded_degrades_gracefully_instead_of_blocking_switch() {
    let f = Fixture::new().await;

    f.service
        .submit_and_dispatch(f.input("claude_code", "remember the amber key"), "user")
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
    tokio::time::sleep(Duration::from_millis(50)).await;

    // A >128 KiB current prompt leaves zero byte budget for quoted history.
    // Switching to Codex must still succeed by gracefully omitting inline history
    // instead of failing with `handoff_budget_exceeded`.
    let oversized_request = "z".repeat(130 * 1024);
    let mut events = f.ctx.agent_runtime.subscribe_events();
    let second = f
        .service
        .submit_and_dispatch(f.input("codex", &oversized_request), "user")
        .await
        .expect("oversized switch turn must degrade gracefully instead of failing");
    assert!(second.turn.is_some());

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

    let prompt = delivered_prompt.expect("Codex receives current request");
    assert!(prompt.contains(&oversized_request));
    f.service.cancel_turn(f.conversation, None).await.unwrap();
}

#[tokio::test]
async fn provider_instance_id_isolates_continuation_key_and_switches_binding() {
    let f = Fixture::new().await;
    let pool = &f.ctx.deployment.db().pool;
    for instance_id in ["inst-a", "inst-b"] {
        db::models::provider_instance::ProviderInstanceRecord::create(
            pool,
            db::models::provider_instance::CreateProviderInstanceInput {
                id: None,
                agent_id: "codex",
                instance_id,
                display_name: instance_id,
                auth_mode: r#"{"mode":"OfficialOAuth"}"#,
                is_default: false,
            },
        )
        .await
        .unwrap();
    }

    let mut first_input = f.input("codex", "first on instance a");
    first_input.provider_instance_id = Some("inst-a".to_string());
    f.service
        .submit_and_dispatch(first_input, "user")
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
    tokio::time::sleep(Duration::from_millis(50)).await;

    let binding_a = ConversationAgentBindingRecord::active_for_conversation(pool, f.conversation)
        .await
        .unwrap()
        .unwrap();
    assert!(
        binding_a
            .continuation_key
            .as_deref()
            .is_some_and(|k| k.contains("|inst-a|")),
        "binding continuation_key must include provider_instance_id: {:?}",
        binding_a.continuation_key
    );

    let mut second_input = f.input("codex", "second on instance b");
    second_input.provider_instance_id = Some("inst-b".to_string());
    f.service
        .submit_and_dispatch(second_input, "user")
        .await
        .unwrap();
    f.service.cancel_turn(f.conversation, None).await.unwrap();

    let binding_b = ConversationAgentBindingRecord::active_for_conversation(pool, f.conversation)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(
        binding_a.id, binding_b.id,
        "switching provider_instance_id on the same agent must isolate bindings"
    );
    assert!(
        binding_b
            .continuation_key
            .as_deref()
            .is_some_and(|k| k.contains("|inst-b|")),
        "binding_b continuation_key must include inst-b: {:?}",
        binding_b.continuation_key
    );
}

#[tokio::test]
async fn auth_blocked_turn_does_not_deadlock_rebind_or_next_turn() {
    let f = Fixture::new().await;
    let pool = &f.ctx.deployment.db().pool;

    // Seed an active turn and emit TurnBlocked(Authentication) through the applier.
    let turn_id = Uuid::new_v4();
    let mut conn = pool.acquire().await.unwrap();
    db::models::conversation_turn::ConversationTurnRecord::create_pending_on_connection(
        &mut *conn,
        turn_id,
        db::models::conversation_turn::CreateConversationTurn {
            conversation_id: f.conversation,
            prompt_id: None,
            text_preview: Some("blocked prompt"),
            input_blocks_json: "[]",
        },
    )
    .await
    .unwrap();
    drop(conn);
    ConversationRecord::update_active_turn(pool, f.conversation, Some(turn_id))
        .await
        .unwrap();
    let blocked_event = agents::conversation::ConversationEvent::TurnBlocked {
        reason: agents::conversation::TurnBlockedReason::Authentication {
            message: "login required".to_string(),
        },
    };
    conversations::ConversationEventAppender::append(
        pool,
        db::models::conversation_event::AppendConversationEvent {
            id: Uuid::new_v4(),
            conversation_id: f.conversation,
            turn_id: Some(turn_id),
            binding_id: None,
            connection_id: None,
            prompt_id: None,
            source: "runtime",
            event_kind: "turn_blocked",
            normalized_json: &serde_json::to_string(&blocked_event).unwrap(),
            raw_json: None,
            idempotency_key: None,
        },
    )
    .await
    .unwrap();

    // `conversations.active_turn_id` is cleared while the turn retains `"blocked"` status.
    let conversation = ConversationRecord::find_by_id(pool, f.conversation)
        .await
        .unwrap()
        .unwrap();
    assert!(
        conversation.active_turn_id.is_none(),
        "auth TurnBlocked must clear active_turn_id"
    );

    // Even if an older DB row still has `active_turn_id` pointing at an auth-blocked turn,
    // `rebind_session` and starting a new turn must both succeed without Conflict.
    ConversationRecord::update_active_turn(pool, f.conversation, Some(turn_id))
        .await
        .unwrap();
    let rebound = f.service.rebind_session(f.conversation).await;
    assert!(
        rebound.is_ok(),
        "rebind_session must not Conflict on auth-blocked turn: {rebound:?}"
    );
    let next = f
        .service
        .submit_and_dispatch(f.input("claude_code", "retry after login"), "user")
        .await;
    assert!(next.is_ok(), "next turn after auth block must succeed: {next:?}");
    f.service.cancel_turn(f.conversation, None).await.unwrap();
}

#[tokio::test]
async fn cross_agent_fork_copies_history_up_to_cutoff_and_injects_handoff_on_first_turn() {
    let f = Fixture::new().await;
    let pool = &f.ctx.deployment.db().pool;

    // Turn 1 on Claude Code
    let first = f
        .service
        .submit_and_dispatch(f.input("claude_code", "first secret alpha"), "user")
        .await
        .unwrap();
    let turn1_id = first.turn.expect("turn 1 created").turn_id;
    f.service.cancel_turn(f.conversation, None).await.unwrap();
    if let Some(conn_id) = f
        .ctx
        .agent_runtime
        .live_connection_id(AgentSessionId(f.conversation))
        .await
    {
        let _ = f.ctx.agent_runtime.disconnect(conn_id).await;
    }

    // Turn 2 on Claude Code (after cutoff)
    let second = f
        .service
        .submit_and_dispatch(f.input("claude_code", "second secret beta"), "user")
        .await
        .unwrap();
    assert!(second.turn.is_some(), "turn 2 created");
    f.service.cancel_turn(f.conversation, None).await.unwrap();
    if let Some(conn_id) = f
        .ctx
        .agent_runtime
        .live_connection_id(AgentSessionId(f.conversation))
        .await
    {
        let _ = f.ctx.agent_runtime.disconnect(conn_id).await;
    }

    let claude = AgentId::parse("claude_code").unwrap();
    let codex = AgentId::parse("codex").unwrap();
    let (child_id, copied_turns) = conversations::fork_visible_conversation(
        pool,
        conversations::ForkVisibleConversation {
            source_id: f.conversation,
            until_turn_id: Some(turn1_id),
            target_agent_id: Some(codex.clone()),
            target_provider_instance_id: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(copied_turns, 1, "only turns up to cutoff are copied");

    let child_session = db::models::session::Session::find_by_id(pool, child_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        child_session.agent_id.as_ref().map(|a| a.as_str()),
        Some("codex")
    );
    assert!(
        child_session.external_session_id.is_none(),
        "handoff fork leaves external_session_id empty until first turn"
    );
    assert!(
        ConversationAgentBindingRecord::active_for_conversation(pool, child_id)
            .await
            .unwrap()
            .is_none(),
        "handoff fork creates no eager binding"
    );

    let child_last_turn = db::models::conversation_turn::ConversationTurnRecord::latest_for_conversation(
        pool, child_id,
    )
    .await
    .unwrap()
    .expect("child has copied turn");
    f.service
        .append_fork_handoff_notice(child_id, child_last_turn.id, &claude, &codex, None)
        .await;

    let timeline = conversations::ConversationProjector::project(pool, child_id)
        .await
        .unwrap();
    assert!(
        timeline.rows.iter().any(|row| {
            matches!(
                &row.row,
                agents::conversation::ConversationTimelineRow::SessionNotice { notice }
                    if notice.message.as_deref().is_some_and(|m| m.contains("\"handoffKind\":\"fork\""))
            )
        }),
        "cross-agent fork projects inline fork handoff notice"
    );

    let mut events = f.ctx.agent_runtime.subscribe_events();
    let mut child_input = f.input("codex", "continue on codex");
    child_input.conversation_id = child_id;
    child_input.continuation_policy = Some(ContinuationPolicy::Portable);
    let child_turn = f
        .service
        .submit_and_dispatch(child_input, "user")
        .await
        .unwrap();
    assert!(child_turn.turn.is_some());

    let mut delivered_prompt = None;
    for _ in 0..30 {
        let event: AgentEventEnvelope = tokio::time::timeout(Duration::from_secs(2), events.recv())
            .await
            .unwrap()
            .unwrap();
        if event.session_id == Some(AgentSessionId(child_id))
            && let agents::AgentEvent::MessageChunk {
                content: AgentContentBlock::Text { text },
            } = event.event
        {
            delivered_prompt = Some(text);
            break;
        }
    }
    let prompt = delivered_prompt.expect("Codex receives handoff prompt in forked session");
    assert!(
        prompt.contains("<dimo-engine-handoff"),
        "expected handoff block in prompt: {prompt}"
    );
    assert!(
        prompt.contains("first secret alpha"),
        "expected cutoff history in prompt: {prompt}"
    );
    assert!(
        !prompt.contains("second secret beta"),
        "post-cutoff history must not leak: {prompt}"
    );
    assert!(
        prompt.contains("continue on codex"),
        "expected new prompt text: {prompt}"
    );

    f.service.cancel_turn(child_id, None).await.unwrap();
}

#[tokio::test]
async fn same_agent_fork_also_uses_handoff_on_first_turn() {
    let f = Fixture::new().await;
    let pool = &f.ctx.deployment.db().pool;

    let first = f
        .service
        .submit_and_dispatch(f.input("codex", "remember cobalt token"), "user")
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

    let codex = AgentId::parse("codex").unwrap();
    let (child_id, copied_turns) = conversations::fork_visible_conversation(
        pool,
        conversations::ForkVisibleConversation {
            source_id: f.conversation,
            until_turn_id: None,
            target_agent_id: Some(codex.clone()),
            target_provider_instance_id: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(copied_turns, 1);

    let child_session = db::models::session::Session::find_by_id(pool, child_id)
        .await
        .unwrap()
        .unwrap();
    assert!(
        child_session.external_session_id.is_none(),
        "same-agent handoff fork leaves external_session_id empty"
    );
    assert!(
        ConversationAgentBindingRecord::active_for_conversation(pool, child_id)
            .await
            .unwrap()
            .is_none(),
        "same-agent handoff fork creates no eager binding"
    );

    let child_last_turn = db::models::conversation_turn::ConversationTurnRecord::latest_for_conversation(
        pool, child_id,
    )
    .await
    .unwrap()
    .expect("child has copied turn");
    f.service
        .append_fork_handoff_notice(child_id, child_last_turn.id, &codex, &codex, None)
        .await;
    let timeline = conversations::ConversationProjector::project(pool, child_id)
        .await
        .unwrap();
    assert!(
        timeline.rows.iter().any(|row| {
            matches!(
                &row.row,
                agents::conversation::ConversationTimelineRow::SessionNotice { notice }
                    if notice.title == "Fork交接"
                        && notice.message.as_deref().is_some_and(|m| m.contains("\"handoffKind\":\"fork\""))
            )
        }),
        "same-agent fork projects inline Fork交接 notice"
    );

    let mut events = f.ctx.agent_runtime.subscribe_events();
    let mut child_input = f.input("codex", "continue same agent");
    child_input.conversation_id = child_id;
    child_input.continuation_policy = Some(ContinuationPolicy::Portable);
    let child_turn = f
        .service
        .submit_and_dispatch(child_input, "user")
        .await
        .unwrap();
    assert!(child_turn.turn.is_some());

    let mut delivered_prompt = None;
    for _ in 0..30 {
        let event: AgentEventEnvelope = tokio::time::timeout(Duration::from_secs(2), events.recv())
            .await
            .unwrap()
            .unwrap();
        if event.session_id == Some(AgentSessionId(child_id))
            && let agents::AgentEvent::MessageChunk {
                content: AgentContentBlock::Text { text },
            } = event.event
        {
            delivered_prompt = Some(text);
            break;
        }
    }
    let prompt = delivered_prompt.expect("same-agent fork delivers handoff prompt");
    assert!(
        prompt.contains("<dimo-engine-handoff"),
        "expected handoff block in same-agent fork prompt: {prompt}"
    );
    assert!(
        prompt.contains("remember cobalt token"),
        "expected prior turn in same-agent handoff prompt: {prompt}"
    );
    assert!(
        prompt.contains("continue same agent"),
        "expected new prompt text: {prompt}"
    );

    f.service.cancel_turn(child_id, None).await.unwrap();
}
