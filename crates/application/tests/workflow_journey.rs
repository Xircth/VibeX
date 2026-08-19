use std::str::FromStr;

use application::{
    ApplicationCore, CommandRegistry, Principal, SqliteConversationRepository,
    WorkflowStoreExecutionPort,
};
use db::models::conversation::ConversationRecord;
use remote_protocol::OperationId;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use uuid::Uuid;
use workflows::{PublishWorkflow, StartWorkflow, WorkflowCore, WorkflowStore};

async fn setup_pool() -> sqlx::SqlitePool {
    let options = SqliteConnectOptions::from_str("sqlite::memory:")
        .unwrap()
        .foreign_keys(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&pool)
        .await
        .unwrap();
    pool
}

async fn setup() -> CommandRegistry<SqliteConversationRepository> {
    let pool = setup_pool().await;
    let repository = SqliteConversationRepository::new(pool.clone());
    let workflows = std::sync::Arc::new(WorkflowStoreExecutionPort::new(pool));
    CommandRegistry::new(ApplicationCore::with_workflows(repository, workflows))
}

fn definition() -> serde_json::Value {
    serde_json::json!({
        "formatVersion": 1,
        "name": "Review",
        "inputSchema": {"type": "object"},
        "steps": [{
            "id": "review",
            "dependsOn": [],
            "inputBindings": {},
            "kind": "agent",
            "agentId": "codex",
            "prompt": "Review the change",
            "workspaceAccess": "read_only_shared",
            "sideEffectClass": "read_only",
            "allowOneRepair": false
        }],
        "policy": {
            "maxConcurrentAgentSteps": 1,
            "maxAgentCalls": 1,
            "deadlineSeconds": 3600,
            "maxOutputBytes": 4096
        }
    })
}

#[tokio::test]
async fn workflow_commands_share_operation_ids_scopes_and_durable_results() {
    let registry = setup().await;
    let principal = Principal::remote(
        "device",
        ["workflow.write", "workflow.run", "workflow.read"]
            .into_iter()
            .map(str::to_string),
    );
    let publish_operation = OperationId::new();
    let published = registry
        .execute_name(
            &principal,
            "workflow_publish",
            publish_operation,
            serde_json::json!({"request": {"definition": definition()}}),
        )
        .await
        .unwrap();
    let retry = registry
        .execute_name(
            &principal,
            "workflow_publish",
            publish_operation,
            serde_json::json!({"request": {"definition": definition()}}),
        )
        .await
        .unwrap();
    assert_eq!(published.data["id"], retry.data["id"]);

    let run = registry
        .execute_name(
            &principal,
            "workflow_start",
            OperationId::new(),
            serde_json::json!({"request": {
                "definitionVersionId": published.data["id"],
                "workspaceId": Uuid::new_v4(),
                "input": {}
            }}),
        )
        .await
        .unwrap();
    let shown = registry
        .execute_name(
            &principal,
            "workflow_show",
            OperationId::new(),
            serde_json::json!({"runId": run.data["id"]}),
        )
        .await
        .unwrap();
    assert_eq!(shown.data["status"], "running");
}

#[tokio::test]
async fn workflow_publish_fails_closed_without_its_narrow_scope() {
    let registry = setup().await;
    let error = registry
        .execute_name(
            &Principal::remote("reader", ["workflow.read".to_string()]),
            "workflow_publish",
            OperationId::new(),
            serde_json::json!({"request": {"definition": definition()}}),
        )
        .await
        .unwrap_err();
    assert!(error.message.contains("workflow.write"));
}

#[tokio::test]
async fn workflow_debug_uses_an_unpublished_snapshot_until_explicit_publish() {
    let registry = setup().await;
    let principal = Principal::remote(
        "device",
        ["workflow.write", "workflow.run", "workflow.read"]
            .into_iter()
            .map(str::to_string),
    );
    let source_path = "~/.vibex/workflows/application-debug.vibex-workflow.json";

    let debug = registry
        .execute_name(
            &principal,
            "workflow_debug",
            OperationId::new(),
            serde_json::json!({"request": {
                "definition": definition(),
                "sourcePath": source_path,
                "workspaceId": Uuid::new_v4(),
                "input": {},
                "stepId": "review",
                "scope": "node"
            }}),
        )
        .await
        .unwrap();
    let debug_version = registry
        .execute_name(
            &principal,
            "workflow_version",
            OperationId::new(),
            serde_json::json!({
                "versionId": debug.data["definitionVersionId"]
            }),
        )
        .await
        .unwrap();
    assert!(debug_version.data["version"].as_i64().unwrap() < 0);

    let catalog_before_publish = registry
        .execute_name(
            &principal,
            "workflow_list",
            OperationId::new(),
            serde_json::json!({"limit": 100}),
        )
        .await
        .unwrap();
    assert_eq!(catalog_before_publish.data, serde_json::json!([]));

    let published = registry
        .execute_name(
            &principal,
            "workflow_publish",
            OperationId::new(),
            serde_json::json!({"request": {
                "definition": definition(),
                "sourcePath": source_path
            }}),
        )
        .await
        .unwrap();
    assert_eq!(published.data["id"], debug.data["definitionVersionId"]);
    assert_eq!(published.data["version"], 1);

    let catalog_after_publish = registry
        .execute_name(
            &principal,
            "workflow_list",
            OperationId::new(),
            serde_json::json!({"limit": 100}),
        )
        .await
        .unwrap();
    assert_eq!(catalog_after_publish.data.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn startup_finishes_a_run_persisted_before_its_execution_shell() {
    let pool = setup_pool().await;
    let store = WorkflowStore::new(pool.clone());
    let core = WorkflowCore::new(store.clone());
    let version = core
        .publish(PublishWorkflow {
            definition_id: None,
            definition: serde_json::from_value(definition()).unwrap(),
            source_path: None,
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({"id": "test"}),
        })
        .await
        .unwrap();
    let run = core
        .start(StartWorkflow {
            definition_version_id: version.id,
            workspace_id: Uuid::new_v4(),
            input: serde_json::json!({}),
            policy_override: None,
            debug_step_id: None,
            operation_id: Uuid::new_v4(),
            principal: serde_json::json!({"id": "test"}),
        })
        .await
        .unwrap();
    assert!(
        ConversationRecord::find_by_id(&pool, run.id)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(store.runs_awaiting_dispatch(10).await.unwrap().len(), 1);

    let port = WorkflowStoreExecutionPort::new(pool.clone());
    assert_eq!(port.reconcile_interrupted().await.unwrap(), 0);

    let shell = ConversationRecord::find_by_id(&pool, run.id)
        .await
        .unwrap()
        .expect("workflow shell recovered");
    assert_eq!(shell.workspace_id, run.workspace_id);
    assert!(store.runs_awaiting_dispatch(10).await.unwrap().is_empty());
    assert!(
        store
            .claim_ready(1, chrono::Duration::seconds(30))
            .await
            .unwrap()
            .is_some()
    );
}
