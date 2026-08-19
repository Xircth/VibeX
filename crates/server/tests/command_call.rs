use std::{
    str::FromStr,
    sync::{Arc, Mutex},
};

use application::{
    ApplicationCore, ApplicationError, CancelConversationTurn, ConversationExecutionPort,
    ConversationTurnSnapshot, RespondConversationPermission, RespondConversationQuestion,
    SqliteConversationRepository, StartConversationTurn,
};
use async_trait::async_trait;
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use db::models::conversation::{ConversationRecord, CreateConversationRecord};
use remote_protocol::{CommandResponse, OperationId};
use server::{ServerConfig, ServerRuntime, ServerToken};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use tower::ServiceExt;
use uuid::Uuid;

#[derive(Default)]
struct FakeExecution {
    starts: Mutex<Vec<StartConversationTurn>>,
    permissions: Mutex<Vec<RespondConversationPermission>>,
    questions: Mutex<Vec<RespondConversationQuestion>>,
    cancellations: Mutex<Vec<CancelConversationTurn>>,
}

#[async_trait]
impl ConversationExecutionPort for FakeExecution {
    async fn start_turn(
        &self,
        request: StartConversationTurn,
    ) -> Result<ConversationTurnSnapshot, ApplicationError> {
        let conversation_id = request.conversation_id;
        self.starts.lock().expect("start calls").push(request);
        Ok(ConversationTurnSnapshot {
            conversation_id,
            turn_id: Uuid::new_v4(),
            prompt_id: None,
            status: "running".to_string(),
            last_sequence: 1,
        })
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
}

#[tokio::test]
async fn authenticated_call_responds_to_a_question_through_the_execution_port() {
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
    let app = ServerRuntime::new(
        ServerConfig::default(),
        ServerToken::new("call-secret-with-at-least-32-bytes"),
        core,
    )
    .router();
    let conversation_id = Uuid::new_v4();

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/call/conversation_respond_question")
                .header("authorization", "Bearer call-secret-with-at-least-32-bytes")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "operation_id": OperationId::new(),
                        "args": {
                            "request": {
                                "conversationId": conversation_id,
                                "questionId": Uuid::new_v4().to_string(),
                                "response": {
                                    "action": "accept",
                                    "content": { "environment": "staging" }
                                }
                            }
                        }
                    })
                    .to_string(),
                ))
                .expect("request"),
        )
        .await
        .expect("response");

    assert_eq!(response.status(), StatusCode::OK);
    let calls = execution.questions.lock().expect("question calls");
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].conversation_id, conversation_id);
    assert_eq!(calls[0].response["content"]["environment"], "staging");
}

#[tokio::test]
async fn authenticated_call_responds_to_a_permission_through_the_execution_port() {
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
    let app = ServerRuntime::new(
        ServerConfig::default(),
        ServerToken::new("call-secret-with-at-least-32-bytes"),
        core,
    )
    .router();
    let conversation_id = Uuid::new_v4();

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/call/conversation_respond_permission")
                .header("authorization", "Bearer call-secret-with-at-least-32-bytes")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "operation_id": OperationId::new(),
                        "args": {
                            "request": {
                                "conversationId": conversation_id,
                                "permissionId": "permission-1",
                                "response": {
                                    "kind": "selected",
                                    "option_id": "allow-once"
                                }
                            }
                        }
                    })
                    .to_string(),
                ))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let calls = execution.permissions.lock().expect("permission calls");
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].conversation_id, conversation_id);
    assert_eq!(calls[0].response["option_id"], "allow-once");
}

#[tokio::test]
async fn authenticated_call_cancels_a_turn_through_the_execution_port() {
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
    let app = ServerRuntime::new(
        ServerConfig::default(),
        ServerToken::new("call-secret-with-at-least-32-bytes"),
        core,
    )
    .router();
    let conversation_id = Uuid::new_v4();

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/call/conversation_cancel_turn")
                .header("authorization", "Bearer call-secret-with-at-least-32-bytes")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "operation_id": OperationId::new(),
                        "args": {
                            "request": {
                                "conversationId": conversation_id,
                                "reason": "user requested"
                            }
                        }
                    })
                    .to_string(),
                ))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let calls = execution.cancellations.lock().expect("cancel calls");
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].conversation_id, conversation_id);
    assert_eq!(calls[0].reason.as_deref(), Some("user requested"));
}

#[tokio::test]
async fn authenticated_call_uses_the_application_command_registry() {
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
    ConversationRecord::create(
        &pool,
        Uuid::new_v4(),
        CreateConversationRecord {
            workspace_id,
            task_id: None,
            title: Some("From Application Core"),
            initial_prompt: None,
            status: None,
            executor: Some("agent"),
        },
    )
    .await
    .expect("conversation");

    let operation_id = OperationId::new();
    let core = ApplicationCore::new(SqliteConversationRepository::new(pool));
    let app = ServerRuntime::new(
        ServerConfig::default(),
        ServerToken::new("call-secret-with-at-least-32-bytes"),
        core,
    )
    .router();
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/call/conversation_list")
                .header("authorization", "Bearer call-secret-with-at-least-32-bytes")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "operation_id": operation_id,
                        "args": { "workspaceId": workspace_id }
                    })
                    .to_string(),
                ))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let response: CommandResponse<serde_json::Value> = serde_json::from_slice(
        &to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body"),
    )
    .expect("command response");
    assert_eq!(response.operation_id, operation_id);
    assert_eq!(response.data[0]["title"], "From Application Core");
}

#[tokio::test]
async fn authenticated_call_registers_conversation_catalog() {
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
    let core = ApplicationCore::new(SqliteConversationRepository::new(pool));
    let app = ServerRuntime::new(
        ServerConfig::default(),
        ServerToken::new("call-secret-with-at-least-32-bytes"),
        core,
    )
    .router();
    let operation_id = OperationId::new();
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/call/conversation_catalog")
                .header("authorization", "Bearer call-secret-with-at-least-32-bytes")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "operation_id": operation_id,
                        "args": {}
                    })
                    .to_string(),
                ))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let body: CommandResponse<serde_json::Value> = serde_json::from_slice(
        &to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body"),
    )
    .expect("command response");
    assert!(body.data.get("projects").is_some());
    assert!(body.data.get("workspaces").is_some());
}

#[tokio::test]
async fn authenticated_call_creates_a_conversation_through_application_core() {
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
    let app = ServerRuntime::new(
        ServerConfig::default(),
        ServerToken::new("call-secret-with-at-least-32-bytes"),
        core,
    )
    .router();

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/call/conversation_create")
                .header("authorization", "Bearer call-secret-with-at-least-32-bytes")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "operation_id": OperationId::new(),
                        "args": {
                            "workspaceId": workspace_id,
                            "agentId": "codex",
                            "title": "Created through HTTP",
                            "initialPrompt": null
                        }
                    })
                    .to_string(),
                ))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let response: CommandResponse<serde_json::Value> = serde_json::from_slice(
        &to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body"),
    )
    .expect("command response");
    assert_eq!(response.data["title"], "Created through HTTP");
    assert_eq!(response.data["workspace_id"], workspace_id.to_string());
}

#[tokio::test]
async fn authenticated_call_starts_a_turn_through_the_execution_port() {
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
    let app = ServerRuntime::new(
        ServerConfig::default(),
        ServerToken::new("call-secret-with-at-least-32-bytes"),
        core,
    )
    .router();
    let workspace_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/call/conversation_start_turn")
                .header("authorization", "Bearer call-secret-with-at-least-32-bytes")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "operation_id": OperationId::new(),
                        "args": {
                            "request": {
                                "agentId": "codex",
                                "workspaceId": workspace_id,
                                "conversationId": conversation_id,
                                "executorProfileId": null,
                                "text": "Run remotely",
                                "images": [],
                                "modeOverride": null,
                                "configOverrides": [],
                                "pluginActions": [{
                                    "pluginId": "vibex.office",
                                    "actionId": "create-presentation"
                                }]
                            }
                        }
                    })
                    .to_string(),
                ))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let response: CommandResponse<serde_json::Value> = serde_json::from_slice(
        &to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body"),
    )
    .expect("command response");
    assert_eq!(response.data["conversationId"], conversation_id.to_string());
    assert_eq!(response.data["status"], "running");
    let calls = execution.starts.lock().expect("start calls");
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].text, "Run remotely");
    assert_eq!(calls[0].workflow_refs.len(), 1);
    assert_eq!(calls[0].workflow_refs[0].plugin_id, "vibex.office");
    assert_eq!(calls[0].workflow_refs[0].workflow_id, "create-presentation");
}
