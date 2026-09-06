//! `conversation.*` host.call: plugins can create, read, enqueue, and cancel
//! only the Conversations they own or were granted.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use plugins::{
    CapabilityBroker, HostCapabilityBroker, PluginControlPlane, PluginConversationCreate,
    PluginConversationEnqueue, PluginConversationError, PluginConversationErrorCode,
    PluginConversationEventPage, PluginConversationHost, PluginConversationInputReceipt,
    PluginConversationSummary, PluginConversationTurn, PluginConversationView, PluginPreviewHost,
    PluginPreviewHostError, PluginPreviewRequest, PluginPreviewSession, SqlitePluginRegistry,
};
use serde_json::{Value, json};

struct UnusedPreviewHost;

#[async_trait]
impl PluginPreviewHost for UnusedPreviewHost {
    async fn open_preview(
        &self,
        _request: PluginPreviewRequest,
    ) -> Result<PluginPreviewSession, PluginPreviewHostError> {
        unreachable!("conversation tests never open a preview")
    }

    async fn close_preview(
        &self,
        _file_path: &str,
        _lease_id: Option<&str>,
    ) -> Result<(), PluginPreviewHostError> {
        unreachable!("conversation tests never open a preview")
    }

    async fn renew_preview(
        &self,
        _lease_id: &str,
    ) -> Result<PluginPreviewSession, PluginPreviewHostError> {
        unreachable!("conversation tests never open a preview")
    }
}

#[derive(Default)]
struct RecordingConversationHost {
    deny_scope: bool,
    created: Mutex<Vec<PluginConversationCreate>>,
    enqueued: Mutex<Vec<PluginConversationEnqueue>>,
    cancelled: Mutex<Vec<String>>,
}

#[async_trait]
impl PluginConversationHost for RecordingConversationHost {
    async fn create(
        &self,
        _plugin_id: &str,
        request: PluginConversationCreate,
    ) -> Result<PluginConversationView, PluginConversationError> {
        self.created.lock().unwrap().push(request.clone());
        Ok(sample_view("11111111-1111-1111-1111-111111111111"))
    }

    async fn list(
        &self,
        _plugin_id: &str,
    ) -> Result<Vec<PluginConversationSummary>, PluginConversationError> {
        Ok(vec![
            sample_view("11111111-1111-1111-1111-111111111111").summary,
        ])
    }

    async fn get(
        &self,
        _plugin_id: &str,
        conversation_id: &str,
    ) -> Result<PluginConversationView, PluginConversationError> {
        if self.deny_scope {
            return Err(PluginConversationError::new(
                PluginConversationErrorCode::ScopeDenied,
                "No conversation is bound to this plugin",
            ));
        }
        Ok(sample_view(conversation_id))
    }

    async fn enqueue(
        &self,
        _plugin_id: &str,
        request: PluginConversationEnqueue,
    ) -> Result<PluginConversationInputReceipt, PluginConversationError> {
        self.enqueued.lock().unwrap().push(request.clone());
        Ok(PluginConversationInputReceipt {
            input_id: "22222222-2222-2222-2222-222222222222".into(),
            conversation_id: request.conversation_id,
            turn_id: Some("33333333-3333-3333-3333-333333333333".into()),
        })
    }

    async fn cancel(
        &self,
        _plugin_id: &str,
        conversation_id: &str,
    ) -> Result<(), PluginConversationError> {
        self.cancelled
            .lock()
            .unwrap()
            .push(conversation_id.to_owned());
        Ok(())
    }

    async fn events_since(
        &self,
        _plugin_id: &str,
        conversation_id: &str,
        after_sequence: i64,
    ) -> Result<PluginConversationEventPage, PluginConversationError> {
        Ok(PluginConversationEventPage {
            conversation_id: conversation_id.to_owned(),
            after_sequence,
            last_sequence: after_sequence + 1,
            rows: json!([]),
        })
    }

    async fn grant(
        &self,
        _plugin_id: &str,
        _conversation_id: &str,
    ) -> Result<(), PluginConversationError> {
        Ok(())
    }
}

fn sample_view(id: &str) -> PluginConversationView {
    PluginConversationView {
        summary: PluginConversationSummary {
            id: id.to_owned(),
            workspace_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa".into(),
            agent_id: Some("codex".into()),
            title: Some("Canvas".into()),
            status: "inprogress".into(),
        },
        sequence: 4,
        turn: Some(PluginConversationTurn {
            turn_id: "33333333-3333-3333-3333-333333333333".into(),
            status: "completed".into(),
            last_sequence: 4,
        }),
        assistant_text: Some("done".into()),
        inputs: None,
    }
}

async fn control_plane() -> Arc<PluginControlPlane> {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(":memory:")
                .foreign_keys(true),
        )
        .await
        .expect("sqlite pool");
    for schema in [
        include_str!("../../db/migrations/20260811010000_plugin_control_plane.sql"),
        include_str!("../../db/migrations/20260811011000_plugin_runtime_evidence.sql"),
        include_str!("../../db/migrations/20260814010000_plugin_platform_v4.sql"),
    ] {
        sqlx::raw_sql(schema)
            .execute(&pool)
            .await
            .expect("plugin schema");
    }
    Arc::new(PluginControlPlane::new(Arc::new(
        SqlitePluginRegistry::new(pool),
    )))
}

async fn broker(host: Arc<RecordingConversationHost>) -> HostCapabilityBroker {
    HostCapabilityBroker::new(control_plane().await, Arc::new(UnusedPreviewHost))
        .with_conversation_host(host)
}

async fn call(
    broker: &HostCapabilityBroker,
    operation: &str,
    input: Value,
) -> Result<Value, plugins::WorkerHostError> {
    broker
        .call("test.plugin", 1, "conversation", operation, input)
        .await
}

#[tokio::test]
async fn the_capability_is_advertised() {
    let broker = broker(Arc::new(RecordingConversationHost::default())).await;
    assert!(broker.supports("conversation"));
}

#[tokio::test]
async fn create_requires_agent_and_allows_omitted_workspace() {
    let host = Arc::new(RecordingConversationHost::default());
    let broker = broker(host.clone()).await;
    let missing_agent = call(&broker, "create", json!({ "title": "Canvas" }))
        .await
        .expect_err("agent is required");
    assert_eq!(missing_agent.code(), "conversation_invalid");
    let created = call(
        &broker,
        "create",
        json!({
            "agentId": "codex",
            "title": "Canvas",
            "prompt": "draw a square"
        }),
    )
    .await
    .expect("create");
    assert_eq!(created["id"], json!("11111111-1111-1111-1111-111111111111"));
    assert_eq!(host.created.lock().unwrap()[0].workspace_id, None);
}

#[tokio::test]
async fn read_and_enqueue_use_catalog_names() {
    let host = Arc::new(RecordingConversationHost::default());
    let broker = broker(host.clone()).await;
    let view = call(
        &broker,
        "read.get",
        json!({ "conversationId": "11111111-1111-1111-1111-111111111111" }),
    )
    .await
    .expect("get");
    assert_eq!(view["sequence"], json!(4));
    let receipt = call(
        &broker,
        "append.enqueueInput",
        json!({
            "conversationId": "11111111-1111-1111-1111-111111111111",
            "text": "continue"
        }),
    )
    .await
    .expect("enqueue");
    assert_eq!(
        receipt["inputId"],
        json!("22222222-2222-2222-2222-222222222222")
    );
    assert_eq!(host.enqueued.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn unbound_conversation_is_scope_denied() {
    let broker = broker(Arc::new(RecordingConversationHost {
        deny_scope: true,
        ..RecordingConversationHost::default()
    }))
    .await;
    let error = call(
        &broker,
        "read.get",
        json!({ "conversationId": "11111111-1111-1111-1111-111111111111" }),
    )
    .await
    .expect_err("denied");
    assert_eq!(error.code(), "conversation_scope_denied");
}

#[tokio::test]
async fn cancel_and_events_are_live() {
    let host = Arc::new(RecordingConversationHost::default());
    let broker = broker(host.clone()).await;
    call(
        &broker,
        "cancel",
        json!({ "conversationId": "11111111-1111-1111-1111-111111111111" }),
    )
    .await
    .expect("cancel");
    let page = call(
        &broker,
        "events.since",
        json!({
            "conversationId": "11111111-1111-1111-1111-111111111111",
            "afterSequence": 2
        }),
    )
    .await
    .expect("events");
    assert_eq!(page["lastSequence"], json!(3));
    assert_eq!(
        host.cancelled.lock().unwrap().as_slice(),
        ["11111111-1111-1111-1111-111111111111"]
    );
}

#[tokio::test]
async fn steer_and_catalog_are_wired() {
    let broker = broker(Arc::new(RecordingConversationHost::default())).await;
    let error = call(
        &broker,
        "steer",
        json!({
            "conversationId": "11111111-1111-1111-1111-111111111111",
            "expectedTurnId": "33333333-3333-3333-3333-333333333333",
            "text": "go left"
        }),
    )
    .await
    .expect_err("recording host has no steer");
    assert_eq!(error.code(), "conversation_unavailable");
    let catalog = call(&broker, "catalog", json!({}))
        .await
        .expect_err("recording host has no catalog");
    assert_eq!(catalog.code(), "conversation_unavailable");
}

#[tokio::test]
async fn unavailable_host_uses_the_catalog_deny_code() {
    let broker = HostCapabilityBroker::new(control_plane().await, Arc::new(UnusedPreviewHost));
    let error = call(
        &broker,
        "create",
        json!({
            "workspaceId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            "agentId": "codex"
        }),
    )
    .await
    .expect_err("unavailable");
    assert_eq!(error.code(), "conversation_unavailable");
}
