use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::Arc,
};

use agents::{
    AgentContentBlock, AgentId, AgentRuntime, ConversationInputPayload,
    ConversationSteeringDeliveryMode, SessionLaunchLock, conversation::ContinuationPolicy,
    runtime_event_channel,
};
use conversations::{
    AgentRuntimeLaunchSettings, ConversationContext, ConversationHost, ConversationInputControl,
    ConversationInputStatus, ConversationServiceError, ConversationSessionService,
    ConversationStartTurnInput, ConversationSteerInput, ConversationSteeringStatus,
    SubmitConversationInput,
};
use db::models::{
    conversation::{ConversationAgentBindingRecord, ConversationRecord, CreateConversationRecord},
    conversation_turn::ConversationTurnRecord,
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

struct SteeringFixtureHost {
    steering_env: Option<String>,
}

#[async_trait::async_trait]
impl ConversationHost for SteeringFixtureHost {
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
        file_refs: &[agents::ConversationFileRef],
    ) -> Result<Vec<AgentContentBlock>, ConversationServiceError> {
        let mut blocks = vec![AgentContentBlock::Text { text }];
        for file_ref in file_refs {
            blocks.push(AgentContentBlock::Resource {
                uri: format!("file:///{}", file_ref.path),
                title: Some(file_ref.path.clone()),
            });
        }
        Ok(blocks)
    }

    async fn launch_settings(
        &self,
        _: &SqlitePool,
        agent: &AgentId,
    ) -> Result<AgentRuntimeLaunchSettings, ConversationServiceError> {
        let mut env = HashMap::new();
        if let Some(mode) = &self.steering_env {
            env.insert("DIMO_IN_MEMORY_STEERING".to_string(), mode.clone());
        }
        Ok(AgentRuntimeLaunchSettings {
            auto_approve_mode: agents::AgentAutoApproveMode::Off,
            env,
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

struct SteeringFixture {
    _data: tempfile::TempDir,
    _work: tempfile::TempDir,
    _event_task: tokio::task::JoinHandle<()>,
    ctx: ConversationContext,
    service: ConversationSessionService,
    inputs: ConversationInputControl,
    conversation: Uuid,
    workspace: Uuid,
}

impl Drop for SteeringFixture {
    fn drop(&mut self) {
        self._event_task.abort();
    }
}

impl SteeringFixture {
    async fn new(steering_env: Option<&str>) -> Self {
        let data = tempfile::tempdir().expect("temp data dir");
        let work = tempfile::tempdir().expect("temp work dir");
        let deployment = Arc::new(
            LocalDeployment::new_at(data.path())
                .await
                .expect("local deployment"),
        );
        let pool = &deployment.db().pool;
        let project = Project::create(
            pool,
            &CreateProject {
                name: "steering-test".into(),
                root_path: work.path().to_string_lossy().into(),
                ..Default::default()
            },
            Uuid::new_v4(),
        )
        .await
        .expect("create project");
        let task = Task::create(
            pool,
            &CreateTask::from_title_description(project.id, "steering-test".into(), None),
            Uuid::new_v4(),
        )
        .await
        .expect("create task");
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
        .expect("create workspace");
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
                executor: Some("codex"),
            },
        )
        .await
        .expect("create conversation");

        let event_publisher = Arc::new(conversations::NoopConversationEventPublisher);
        let (event_sink, event_rx) = runtime_event_channel();
        let runtime = Arc::new(AgentRuntime::new_with_driver(event_sink, false));
        let ctx = ConversationContext {
            deployment: deployment.clone(),
            agent_runtime: runtime,
            turn_locks: Arc::new(Mutex::new(HashMap::new())),
            runtime_states: Default::default(),
            row_projectors: Default::default(),
            host: Arc::new(SteeringFixtureHost {
                steering_env: steering_env.map(str::to_string),
            }),
            event_publisher: event_publisher.clone(),
        };
        let event_task = conversations::start_agent_event_persistence(ctx.clone(), event_rx);
        let inputs = ConversationInputControl::with_publisher(pool.clone(), event_publisher);
        Self {
            _data: data,
            _work: work,
            _event_task: event_task,
            service: ConversationSessionService::new(ctx.clone()),
            inputs,
            ctx,
            conversation,
            workspace: workspace.id,
        }
    }

    fn start_input(&self, text: &str) -> ConversationStartTurnInput {
        ConversationStartTurnInput {
            continuation_policy: Some(ContinuationPolicy::Portable),
            expected_binding_revision: None,
            agent_id: AgentId::parse("codex").expect("agent id"),
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

    fn queue_payload(&self, text: &str) -> ConversationInputPayload {
        ConversationInputPayload {
            continuation_policy: None,
            expected_binding_revision: None,
            agent_id: AgentId::parse("codex").expect("agent id"),
            workspace_id: self.workspace,
            executor_profile_id: None,
            text: text.into(),
            display_text: None,
            images: Vec::new(),
            mode_override: None,
            config_overrides: Vec::new(),
            workflow_refs: Vec::new(),
            file_refs: Vec::new(),
            internal_prompt_contributions: Vec::new(),
            collaboration_origin: None,
            provider_instance_id: None,
        }
    }
}

#[tokio::test]
async fn non_native_engine_steer_cancels_active_turn_and_restarts_immediately() {
    let fx = SteeringFixture::new(None).await;
    let pool = &fx.ctx.deployment.db().pool;

    let (initial, _) = fx
        .service
        .start_turn(fx.start_input("initial prompt"))
        .await
        .expect("start initial turn");
    assert_eq!(initial.status, "running");

    let op_id = Uuid::new_v4();
    let receipt = fx
        .service
        .steer(ConversationSteerInput {
            conversation_id: fx.conversation,
            operation_id: op_id,
            expected_turn_id: initial.turn_id,
            text: "steered follow-up".into(),
            display_text: None,
            images: Vec::new(),
            file_refs: Vec::new(),
            mode_override: None,
            config_overrides: Vec::new(),
            principal: serde_json::json!({ "kind": "local_desktop" }),
            promoted_input_id: None,
            promoted_input_expected_revision: None,
            allow_interrupt_restart: true,
        })
        .await
        .expect("interrupt_restart steer");

    assert_eq!(receipt.status, ConversationSteeringStatus::Accepted);
    assert_eq!(
        receipt.delivery_mode,
        Some(ConversationSteeringDeliveryMode::InterruptRestart)
    );
    let restarted_turn_id = receipt
        .restarted_turn_id
        .expect("restarted turn id must be populated");
    assert_ne!(restarted_turn_id, initial.turn_id);

    let old_turn = ConversationTurnRecord::find_by_id(pool, initial.turn_id)
        .await
        .expect("query old turn")
        .expect("old turn exists");
    assert_eq!(old_turn.status, "cancelled");

    let new_turn = ConversationTurnRecord::find_by_id(pool, restarted_turn_id)
        .await
        .expect("query new turn")
        .expect("new turn exists");
    assert_eq!(new_turn.status, "running");
    assert_eq!(new_turn.text_preview.as_deref(), Some("steered follow-up"));

    // Idempotent retry with the same operation_id returns identical receipt and creates no extra turn.
    let turns_before = ConversationTurnRecord::list_for_conversation(pool, fx.conversation)
        .await
        .expect("list turns")
        .len();
    let retry_receipt = fx
        .service
        .steer(ConversationSteerInput {
            conversation_id: fx.conversation,
            operation_id: op_id,
            expected_turn_id: initial.turn_id,
            text: "steered follow-up".into(),
            display_text: None,
            images: Vec::new(),
            file_refs: Vec::new(),
            mode_override: None,
            config_overrides: Vec::new(),
            principal: serde_json::json!({ "kind": "local_desktop" }),
            promoted_input_id: None,
            promoted_input_expected_revision: None,
            allow_interrupt_restart: true,
        })
        .await
        .expect("retry steer");
    assert_eq!(retry_receipt, receipt);
    let turns_after = ConversationTurnRecord::list_for_conversation(pool, fx.conversation)
        .await
        .expect("list turns")
        .len();
    assert_eq!(turns_after, turns_before);
}

#[tokio::test]
async fn promoting_third_queued_message_on_non_native_engine_dispatches_msg3_before_msg1_and_msg2()
{
    let fx = SteeringFixture::new(None).await;
    let pool = &fx.ctx.deployment.db().pool;

    let (initial, _) = fx
        .service
        .start_turn(fx.start_input("turn 1"))
        .await
        .expect("start turn 1");

    let msg1 = fx
        .inputs
        .submit(SubmitConversationInput {
            conversation_id: fx.conversation,
            operation_id: Uuid::new_v4(),
            payload: fx.queue_payload("Msg 1"),
            principal: serde_json::json!({ "kind": "local_desktop" }),
        })
        .await
        .expect("queue Msg 1");
    let msg2 = fx
        .inputs
        .submit(SubmitConversationInput {
            conversation_id: fx.conversation,
            operation_id: Uuid::new_v4(),
            payload: fx.queue_payload("Msg 2"),
            principal: serde_json::json!({ "kind": "local_desktop" }),
        })
        .await
        .expect("queue Msg 2");
    let msg3 = fx
        .inputs
        .submit(SubmitConversationInput {
            conversation_id: fx.conversation,
            operation_id: Uuid::new_v4(),
            payload: fx.queue_payload("Msg 3"),
            principal: serde_json::json!({ "kind": "local_desktop" }),
        })
        .await
        .expect("queue Msg 3");

    let receipt = fx
        .service
        .steer(ConversationSteerInput {
            conversation_id: fx.conversation,
            operation_id: Uuid::new_v4(),
            expected_turn_id: initial.turn_id,
            text: "Msg 3".into(),
            display_text: None,
            images: Vec::new(),
            file_refs: Vec::new(),
            mode_override: None,
            config_overrides: Vec::new(),
            principal: serde_json::json!({ "kind": "local_desktop" }),
            promoted_input_id: Some(msg3.id),
            promoted_input_expected_revision: Some(msg3.revision),
            allow_interrupt_restart: true,
        })
        .await
        .expect("promote Msg 3 to interrupt_restart steer");

    assert_eq!(receipt.status, ConversationSteeringStatus::Accepted);
    assert_eq!(
        receipt.delivery_mode,
        Some(ConversationSteeringDeliveryMode::InterruptRestart)
    );
    let restarted_turn_id = receipt.restarted_turn_id.expect("restarted turn id");

    let msg3_after = fx
        .inputs
        .find(fx.conversation, msg3.id)
        .await
        .expect("find Msg 3");
    assert_eq!(msg3_after.status, ConversationInputStatus::Dispatched);
    assert_eq!(msg3_after.turn_id, Some(restarted_turn_id));

    let active_turn = ConversationTurnRecord::find_by_id(pool, restarted_turn_id)
        .await
        .expect("query restarted turn")
        .expect("restarted turn exists");
    assert_eq!(active_turn.text_preview.as_deref(), Some("Msg 3"));
    assert_eq!(active_turn.status, "running");

    let remaining_queued: Vec<_> = fx
        .inputs
        .list(fx.conversation)
        .await
        .expect("list inputs")
        .into_iter()
        .filter(|item| item.status == ConversationInputStatus::Queued)
        .collect();
    assert_eq!(remaining_queued.len(), 2);
    assert_eq!(remaining_queued[0].id, msg1.id);
    assert_eq!(remaining_queued[1].id, msg2.id);
}

#[tokio::test]
async fn native_engine_steer_injects_without_interrupt_and_consumes_promoted_queue_item() {
    let fx = SteeringFixture::new(Some("1")).await;
    let pool = &fx.ctx.deployment.db().pool;

    let (initial, _) = fx
        .service
        .start_turn(fx.start_input("turn 1"))
        .await
        .expect("start turn 1");

    let msg1 = fx
        .inputs
        .submit(SubmitConversationInput {
            conversation_id: fx.conversation,
            operation_id: Uuid::new_v4(),
            payload: fx.queue_payload("Msg 1"),
            principal: serde_json::json!({ "kind": "local_desktop" }),
        })
        .await
        .expect("queue Msg 1");
    let msg2 = fx
        .inputs
        .submit(SubmitConversationInput {
            conversation_id: fx.conversation,
            operation_id: Uuid::new_v4(),
            payload: fx.queue_payload("Msg 2"),
            principal: serde_json::json!({ "kind": "local_desktop" }),
        })
        .await
        .expect("queue Msg 2");

    let receipt = fx
        .service
        .steer(ConversationSteerInput {
            conversation_id: fx.conversation,
            operation_id: Uuid::new_v4(),
            expected_turn_id: initial.turn_id,
            text: "Msg 2".into(),
            display_text: None,
            images: Vec::new(),
            file_refs: Vec::new(),
            mode_override: None,
            config_overrides: Vec::new(),
            principal: serde_json::json!({ "kind": "local_desktop" }),
            promoted_input_id: Some(msg2.id),
            promoted_input_expected_revision: Some(msg2.revision),
            allow_interrupt_restart: true,
        })
        .await
        .expect("native steer Msg 2");

    assert_eq!(receipt.status, ConversationSteeringStatus::Accepted);
    assert_eq!(
        receipt.delivery_mode,
        Some(ConversationSteeringDeliveryMode::Native)
    );
    assert_eq!(receipt.restarted_turn_id, None);

    // Original turn is still running without interruption!
    let turn1 = ConversationTurnRecord::find_by_id(pool, initial.turn_id)
        .await
        .expect("query turn 1")
        .expect("turn 1 exists");
    assert_eq!(turn1.status, "running");

    // Msg 2 was consumed (cancelled) from the queue; Msg 1 remains queued.
    let msg2_after = fx
        .inputs
        .find(fx.conversation, msg2.id)
        .await
        .expect("find Msg 2");
    assert_eq!(msg2_after.status, ConversationInputStatus::Cancelled);

    let msg1_after = fx
        .inputs
        .find(fx.conversation, msg1.id)
        .await
        .expect("find Msg 1");
    assert_eq!(msg1_after.status, ConversationInputStatus::Queued);

    // Once turn 1 ends, Msg 1 automatically dispatches next (and Msg 2 is not re-sent).
    fx.service
        .cancel_turn(fx.conversation, Some("finish_turn_1".into()))
        .await
        .expect("end turn 1");

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        let current_msg1 = fx
            .inputs
            .find(fx.conversation, msg1.id)
            .await
            .expect("poll Msg 1");
        if current_msg1.status == ConversationInputStatus::Dispatched {
            assert!(current_msg1.turn_id.is_some());
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "Msg 1 should dispatch after turn 1 finishes"
        );
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}

#[tokio::test]
async fn rpc_steering_unsupported_falls_back_to_interrupt_restart_when_allowed() {
    let fx = SteeringFixture::new(Some("rpc_unsupported")).await;

    let (initial, _) = fx
        .service
        .start_turn(fx.start_input("turn 1"))
        .await
        .expect("start turn 1");

    let receipt = fx
        .service
        .steer(ConversationSteerInput {
            conversation_id: fx.conversation,
            operation_id: Uuid::new_v4(),
            expected_turn_id: initial.turn_id,
            text: "fallback steer".into(),
            display_text: None,
            images: Vec::new(),
            file_refs: Vec::new(),
            mode_override: None,
            config_overrides: Vec::new(),
            principal: serde_json::json!({ "kind": "local_desktop" }),
            promoted_input_id: None,
            promoted_input_expected_revision: None,
            allow_interrupt_restart: true,
        })
        .await
        .expect("fallback steer");

    assert_eq!(receipt.status, ConversationSteeringStatus::Accepted);
    assert_eq!(
        receipt.delivery_mode,
        Some(ConversationSteeringDeliveryMode::InterruptRestart)
    );
    assert!(receipt.restarted_turn_id.is_some());
}

#[tokio::test]
async fn submit_and_dispatch_pre_turn_failure_returns_err_and_cancels_input_without_stranding_queue()
 {
    let fx = SteeringFixture::new(None).await;

    let mut bad_input = fx.start_input("trigger pre-turn failure");
    bad_input.workspace_id = Uuid::new_v4();
    let err = fx
        .service
        .submit_and_dispatch(bad_input, "user")
        .await
        .expect_err("missing workspace must propagate pre-turn NotFound error");
    assert!(
        matches!(err, ConversationServiceError::NotFound(_)),
        "expected NotFound, got: {err:?}"
    );

    let items = fx.inputs.list(fx.conversation).await.expect("list inputs");
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].status, ConversationInputStatus::Cancelled);

    // Subsequent valid prompt must dispatch normally instead of stalling behind a stranded queue row.
    let next = fx
        .service
        .submit_and_dispatch(fx.start_input("valid follow-up"), "user")
        .await
        .expect("subsequent valid submit_and_dispatch");
    assert!(next.turn.is_some());
}

#[tokio::test]
async fn interrupt_restart_steer_preserves_display_text_file_refs_and_control_overrides() {
    let fx = SteeringFixture::new(None).await;
    let pool = &fx.ctx.deployment.db().pool;

    let (initial, _) = fx
        .service
        .start_turn(fx.start_input("turn 1"))
        .await
        .expect("start turn 1");

    let file_refs = vec![agents::ConversationFileRef {
        path: "src/lib.rs".into(),
        start_line: Some(1),
        end_line: Some(10),
    }];
    let config_overrides = vec![agents::AgentSessionConfigOverride {
        key: "reasoning_effort".into(),
        value: "high".into(),
    }];

    let receipt = fx
        .service
        .steer(ConversationSteerInput {
            conversation_id: fx.conversation,
            operation_id: Uuid::new_v4(),
            expected_turn_id: initial.turn_id,
            text: "expanded @src/lib.rs check this".into(),
            display_text: Some("[@:src/lib.rs](src/lib.rs) check this".into()),
            images: Vec::new(),
            file_refs: file_refs.clone(),
            mode_override: Some("plan".into()),
            config_overrides: config_overrides.clone(),
            principal: serde_json::json!({ "kind": "local_desktop" }),
            promoted_input_id: None,
            promoted_input_expected_revision: None,
            allow_interrupt_restart: true,
        })
        .await
        .expect("interrupt_restart steer with display_text, file_refs, and overrides");

    let restarted_turn_id = receipt.restarted_turn_id.expect("restarted turn id");
    let dispatched = fx
        .inputs
        .list(fx.conversation)
        .await
        .expect("list inputs")
        .into_iter()
        .find(|item| item.turn_id == Some(restarted_turn_id))
        .expect("dispatched restarted input exists");

    assert_eq!(
        dispatched.payload.display_text.as_deref(),
        Some("[@:src/lib.rs](src/lib.rs) check this")
    );
    assert_eq!(dispatched.payload.file_refs, file_refs);
    assert_eq!(dispatched.payload.mode_override.as_deref(), Some("plan"));
    assert_eq!(dispatched.payload.config_overrides, config_overrides);

    let active_binding =
        ConversationAgentBindingRecord::active_for_conversation(pool, fx.conversation)
            .await
            .expect("query active binding")
            .expect("active binding exists");
    assert_eq!(active_binding.current_mode.as_deref(), Some("plan"));
    assert!(
        active_binding
            .config_selection_json
            .contains("\"reasoning_effort\":\"high\""),
        "expected reasoning_effort in config_selection_json: {}",
        active_binding.config_selection_json
    );

    let user_input_json: String = sqlx::query_scalar(
        "SELECT normalized_json FROM conversation_events
         WHERE conversation_id = ? AND turn_id = ? AND event_kind = 'user_turn_created'
         ORDER BY sequence DESC LIMIT 1",
    )
    .bind(fx.conversation)
    .bind(restarted_turn_id)
    .fetch_one(pool)
    .await
    .expect("restarted turn user_turn_created event");
    assert!(
        user_input_json.contains("[@:src/lib.rs](src/lib.rs) check this"),
        "user_turn_created event must preserve display_text: {user_input_json}"
    );
    assert!(
        user_input_json.contains("\"kind\":\"resource\"")
            && user_input_json.contains("\"uri\":\"src/lib.rs\""),
        "user_turn_created event must include file_ref resource block: {user_input_json}"
    );
}

#[tokio::test]
async fn set_session_mode_and_config_before_first_bind_persist_selection_and_emit_events() {
    let fx = SteeringFixture::new(None).await;
    let pool = &fx.ctx.deployment.db().pool;

    fx.service
        .set_session_mode(fx.conversation, "plan".into())
        .await
        .expect("set_session_mode before first bind");

    fx.service
        .set_session_config_option(fx.conversation, "reasoning_effort".into(), "high".into())
        .await
        .expect("set_session_config_option before first bind");

    let active_binding =
        ConversationAgentBindingRecord::active_for_conversation(pool, fx.conversation)
            .await
            .expect("query active binding")
            .expect("binding opened for pre-bind control selection");
    assert_eq!(active_binding.agent_id.as_str(), "codex");
    assert_eq!(active_binding.current_mode.as_deref(), Some("plan"));
    assert!(
        active_binding
            .config_selection_json
            .contains("\"reasoning_effort\":\"high\""),
        "expected reasoning_effort in config_selection_json: {}",
        active_binding.config_selection_json
    );

    let event_kinds: Vec<String> = sqlx::query_scalar(
        "SELECT event_kind FROM conversation_events WHERE conversation_id = ? ORDER BY sequence ASC",
    )
    .bind(fx.conversation)
    .fetch_all(pool)
    .await
    .expect("query conversation_events");
    assert!(
        event_kinds.iter().any(|k| k == "session_mode_updated"),
        "expected session_mode_updated in {event_kinds:?}"
    );
    assert!(
        event_kinds
            .iter()
            .any(|k| k == "session_config_options_updated"),
        "expected session_config_options_updated in {event_kinds:?}"
    );
}
