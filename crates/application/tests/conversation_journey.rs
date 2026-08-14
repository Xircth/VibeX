use std::{
    str::FromStr,
    sync::{Arc, Mutex},
};

use application::{
    ApplicationCore, ApplicationError, CancelConversationTurn, ConversationExecutionPort,
    ConversationSteeringReceipt, ConversationSteeringStatus, ConversationTurnSnapshot,
    CreateChildConversationRequest, CreateConversation, ListConversations, Principal,
    RespondConversationPermission, RespondConversationQuestion, SqliteConversationRepository,
    StartConversationTurn, SteerConversationTurnRequest,
};
use async_trait::async_trait;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use uuid::Uuid;

#[derive(Default)]
struct FakeExecution {
    started: Mutex<Vec<StartConversationTurn>>,
    permissions: Mutex<Vec<RespondConversationPermission>>,
    questions: Mutex<Vec<RespondConversationQuestion>>,
    cancellations: Mutex<Vec<CancelConversationTurn>>,
    steering: Mutex<Vec<conversations::ConversationSteerInput>>,
}

#[async_trait]
impl ConversationExecutionPort for FakeExecution {
    async fn start_turn(
        &self,
        request: StartConversationTurn,
    ) -> Result<ConversationTurnSnapshot, ApplicationError> {
        let snapshot = ConversationTurnSnapshot {
            conversation_id: request.conversation_id,
            turn_id: Uuid::new_v4(),
            prompt_id: None,
            status: "running".to_string(),
            last_sequence: 1,
        };
        self.started.lock().expect("started calls").push(request);
        Ok(snapshot)
    }

    async fn respond_permission(
        &self,
        request: RespondConversationPermission,
    ) -> Result<(), ApplicationError> {
        self.permissions
            .lock()
            .expect("permission calls")
            .push(request);
        Ok(())
    }

    async fn respond_question(
        &self,
        request: RespondConversationQuestion,
    ) -> Result<(), ApplicationError> {
        self.questions.lock().expect("question calls").push(request);
        Ok(())
    }

    async fn cancel_turn(&self, request: CancelConversationTurn) -> Result<(), ApplicationError> {
        self.cancellations
            .lock()
            .expect("cancel calls")
            .push(request);
        Ok(())
    }

    async fn steer(
        &self,
        request: conversations::ConversationSteerInput,
    ) -> Result<ConversationSteeringReceipt, ApplicationError> {
        let receipt = ConversationSteeringReceipt {
            steering_id: Uuid::new_v4(),
            conversation_id: request.conversation_id,
            operation_id: request.operation_id,
            expected_turn_id: request.expected_turn_id,
            status: ConversationSteeringStatus::Accepted,
            code: None,
            message: None,
        };
        self.steering.lock().expect("steering calls").push(request);
        Ok(receipt)
    }
}

#[tokio::test]
async fn steering_binds_operation_expected_turn_and_principal_in_the_core() {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::from_str("sqlite::memory:")
                .expect("sqlite options")
                .foreign_keys(false),
        )
        .await
        .expect("memory database");
    let execution = Arc::new(FakeExecution::default());
    let core =
        ApplicationCore::with_execution(SqliteConversationRepository::new(pool), execution.clone());
    let conversation_id = Uuid::new_v4();
    let expected_turn_id = Uuid::new_v4();
    let operation_id = Uuid::new_v4();

    let receipt = core
        .steer_conversation_turn(
            &Principal::local_desktop(),
            operation_id,
            SteerConversationTurnRequest {
                conversation_id,
                expected_turn_id,
                text: "Prioritize the failing test".to_string(),
                images: Vec::new(),
            },
        )
        .await
        .expect("steer turn");

    assert_eq!(receipt.status, ConversationSteeringStatus::Accepted);
    let calls = execution.steering.lock().expect("steering calls");
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].operation_id, operation_id);
    assert_eq!(calls[0].expected_turn_id, expected_turn_id);
    assert_eq!(calls[0].principal["kind"], "local_desktop");
}

#[tokio::test]
async fn cancel_turn_is_forwarded_to_the_same_execution_port() {
    let options = SqliteConnectOptions::from_str("sqlite::memory:")
        .expect("sqlite options")
        .foreign_keys(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("memory database");
    let execution = Arc::new(FakeExecution::default());
    let core =
        ApplicationCore::with_execution(SqliteConversationRepository::new(pool), execution.clone());
    let conversation_id = Uuid::new_v4();

    core.cancel_conversation_turn(
        &Principal::local_desktop(),
        CancelConversationTurn {
            conversation_id,
            reason: Some("user requested".to_string()),
        },
    )
    .await
    .expect("cancel turn");

    let calls = execution.cancellations.lock().expect("cancel calls");
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].conversation_id, conversation_id);
    assert_eq!(calls[0].reason.as_deref(), Some("user requested"));
}

#[tokio::test]
async fn question_response_is_forwarded_with_its_dedicated_remote_scope() {
    let options = SqliteConnectOptions::from_str("sqlite::memory:")
        .expect("sqlite options")
        .foreign_keys(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("memory database");
    let execution = Arc::new(FakeExecution::default());
    let core =
        ApplicationCore::with_execution(SqliteConversationRepository::new(pool), execution.clone());
    let conversation_id = Uuid::new_v4();

    core.respond_conversation_question(
        &Principal::remote("paired-device", ["conversation.question".to_string()]),
        RespondConversationQuestion {
            conversation_id,
            question_id: Uuid::new_v4().to_string(),
            response: serde_json::json!({
                "action": "accept",
                "content": { "environment": "staging" }
            }),
        },
    )
    .await
    .expect("respond question");

    let calls = execution.questions.lock().expect("questions");
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].conversation_id, conversation_id);
    assert_eq!(calls[0].response["content"]["environment"], "staging");
}

#[tokio::test]
async fn permission_response_is_forwarded_without_transport_semantics() {
    let options = SqliteConnectOptions::from_str("sqlite::memory:")
        .expect("sqlite options")
        .foreign_keys(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("memory database");
    let execution = Arc::new(FakeExecution::default());
    let core =
        ApplicationCore::with_execution(SqliteConversationRepository::new(pool), execution.clone());
    let conversation_id = Uuid::new_v4();

    core.respond_conversation_permission(
        &Principal::local_desktop(),
        RespondConversationPermission {
            conversation_id,
            permission_id: "permission-1".to_string(),
            response: serde_json::json!({
                "kind": "selected",
                "option_id": "allow-once"
            }),
        },
    )
    .await
    .expect("respond permission");

    let calls = execution.permissions.lock().expect("permission calls");
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].conversation_id, conversation_id);
    assert_eq!(calls[0].response["option_id"], "allow-once");
}

#[tokio::test]
async fn permission_and_cancel_require_their_narrow_remote_scopes() {
    let options = SqliteConnectOptions::from_str("sqlite::memory:")
        .expect("sqlite options")
        .foreign_keys(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("memory database");
    let execution = Arc::new(FakeExecution::default());
    let core =
        ApplicationCore::with_execution(SqliteConversationRepository::new(pool), execution.clone());
    let conversation_id = Uuid::new_v4();

    core.respond_conversation_permission(
        &Principal::remote("paired-device", ["conversation.permission".to_string()]),
        RespondConversationPermission {
            conversation_id,
            permission_id: "permission-1".to_string(),
            response: serde_json::json!({"kind": "denied"}),
        },
    )
    .await
    .expect("dedicated permission scope");
    core.cancel_conversation_turn(
        &Principal::remote("paired-device", ["conversation.cancel".to_string()]),
        CancelConversationTurn {
            conversation_id,
            reason: None,
        },
    )
    .await
    .expect("dedicated cancellation scope");

    assert_eq!(execution.permissions.lock().expect("permissions").len(), 1);
    assert_eq!(
        execution.cancellations.lock().expect("cancellations").len(),
        1
    );
}

#[tokio::test]
async fn create_conversation_is_visible_through_the_same_application_core() {
    let options = SqliteConnectOptions::from_str("sqlite::memory:")
        .expect("sqlite options")
        .foreign_keys(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("memory database");
    sqlx::migrate!("../db/migrations")
        .run(&pool)
        .await
        .expect("migrations");
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&pool)
        .await
        .expect("focused fixture");
    let workspace_id = Uuid::new_v4();
    let core = ApplicationCore::new(SqliteConversationRepository::new(pool));

    let created = core
        .create_conversation(
            &Principal::local_desktop(),
            CreateConversation {
                workspace_id,
                agent_id: "codex".to_string(),
                title: Some("Created remotely".to_string()),
                initial_prompt: None,
            },
        )
        .await
        .expect("create conversation");
    let conversations = core
        .list_conversations(
            &Principal::local_desktop(),
            ListConversations { workspace_id },
        )
        .await
        .expect("list conversations");

    assert_eq!(conversations.len(), 1);
    assert_eq!(conversations[0].id, created.id);
    assert_eq!(conversations[0].title.as_deref(), Some("Created remotely"));
}

#[tokio::test]
async fn child_creation_is_atomic_idempotent_and_payload_bound() {
    let options = SqliteConnectOptions::from_str("sqlite::memory:")
        .expect("sqlite options")
        .foreign_keys(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("memory database");
    sqlx::migrate!("../db/migrations")
        .run(&pool)
        .await
        .expect("migrations");
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&pool)
        .await
        .expect("focused fixture");
    let core = ApplicationCore::new(SqliteConversationRepository::new(pool.clone()));
    let parent = core
        .create_conversation(
            &Principal::local_desktop(),
            CreateConversation {
                workspace_id: Uuid::new_v4(),
                agent_id: "codex".to_string(),
                title: Some("parent".to_string()),
                initial_prompt: None,
            },
        )
        .await
        .expect("parent");
    let operation_id = Uuid::new_v4();
    let request = CreateChildConversationRequest {
        parent_conversation_id: parent.id,
        agent_id: "codex".to_string(),
        title: Some("child".to_string()),
        initial_prompt: Some("inspect this".to_string()),
        visible: true,
    };
    let child = core
        .create_child_conversation(&Principal::local_desktop(), operation_id, request.clone())
        .await
        .expect("child");
    let retry = core
        .create_child_conversation(&Principal::local_desktop(), operation_id, request)
        .await
        .expect("idempotent retry");
    assert_eq!(child.id, operation_id);
    assert_eq!(retry.id, child.id);
    let relation_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM conversation_relations
         WHERE parent_conversation_id = ? AND child_conversation_id = ? AND kind = 'fork'",
    )
    .bind(parent.id)
    .bind(child.id)
    .fetch_one(&pool)
    .await
    .expect("relation count");
    assert_eq!(relation_count, 1);

    let conflict = core
        .create_child_conversation(
            &Principal::local_desktop(),
            operation_id,
            CreateChildConversationRequest {
                parent_conversation_id: parent.id,
                agent_id: "codex".to_string(),
                title: Some("different".to_string()),
                initial_prompt: Some("inspect this".to_string()),
                visible: true,
            },
        )
        .await
        .expect_err("operation payload mismatch");
    assert_eq!(
        conflict.envelope().code,
        remote_protocol::ErrorCode::Conflict
    );
}

#[tokio::test]
async fn start_turn_is_launched_through_the_injected_execution_port() {
    let options = SqliteConnectOptions::from_str("sqlite::memory:")
        .expect("sqlite options")
        .foreign_keys(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("memory database");
    let execution = Arc::new(FakeExecution::default());
    let core =
        ApplicationCore::with_execution(SqliteConversationRepository::new(pool), execution.clone());
    let conversation_id = Uuid::new_v4();
    let workspace_id = Uuid::new_v4();

    let snapshot = core
        .start_conversation_turn(
            &Principal::local_desktop(),
            StartConversationTurn {
                agent_id: "codex".to_string(),
                workspace_id,
                conversation_id,
                executor_profile_id: None,
                text: "Stream this turn".to_string(),
                images: Vec::new(),
                mode_override: None,
                config_overrides: Vec::new(),
                plugin_actions: Vec::new(),
            },
        )
        .await
        .expect("start turn");

    assert_eq!(snapshot.conversation_id, conversation_id);
    assert_eq!(snapshot.status, "running");
    let calls = execution.started.lock().expect("started calls");
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].workspace_id, workspace_id);
    assert_eq!(calls[0].text, "Stream this turn");
}
