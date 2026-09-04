//! `provider.presets.*` behaviour that ADR-0069 requires of any Host: presets
//! are readable, saving is a plain store write, and binding only takes effect
//! when the user says so.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use plugins::{
    CapabilityBroker, HostCapabilityBroker, PluginControlPlane, PluginPreviewHost,
    PluginPreviewHostError, PluginPreviewRequest, PluginPreviewSession, ProviderBindDecision,
    ProviderBindRequest, ProviderPreset, ProviderPresetDraft, ProviderPresetError,
    ProviderPresetErrorCode, ProviderPresetHost, SqlitePluginRegistry,
};
use serde_json::{Value, json};

struct UnusedPreviewHost;

#[async_trait]
impl PluginPreviewHost for UnusedPreviewHost {
    async fn open_preview(
        &self,
        _request: PluginPreviewRequest,
    ) -> Result<PluginPreviewSession, PluginPreviewHostError> {
        unreachable!("provider preset tests never open a preview")
    }

    async fn close_preview(
        &self,
        _file_path: &str,
        _lease_id: Option<&str>,
    ) -> Result<(), PluginPreviewHostError> {
        unreachable!("provider preset tests never open a preview")
    }
}

#[derive(Default)]
struct RecordingPresetHost {
    approve_bind: bool,
    saved: Mutex<Vec<ProviderPresetDraft>>,
    bound: Mutex<Vec<ProviderBindRequest>>,
}

#[async_trait]
impl ProviderPresetHost for RecordingPresetHost {
    async fn list(
        &self,
        agent_id: Option<&str>,
    ) -> Result<Vec<ProviderPreset>, ProviderPresetError> {
        let Some(agent_id) = agent_id else {
            return Err(ProviderPresetError::new(
                ProviderPresetErrorCode::UnknownAgent,
                "agentId is required",
            ));
        };
        Ok(vec![ProviderPreset {
            id: "preset-1".into(),
            name: "Staging".into(),
            agent_id: agent_id.to_owned(),
            api_url: "https://example.invalid/v1".into(),
            model: Some("some-model".into()),
            has_api_key: true,
            bound: false,
        }])
    }

    async fn save(
        &self,
        _plugin_id: &str,
        draft: ProviderPresetDraft,
    ) -> Result<ProviderPreset, ProviderPresetError> {
        self.saved.lock().unwrap().push(draft.clone());
        Ok(ProviderPreset {
            id: draft.id.unwrap_or_else(|| "generated".into()),
            name: draft.name,
            agent_id: draft.agent_id,
            api_url: draft.api_url,
            model: draft.model,
            has_api_key: draft.api_key.is_some(),
            bound: false,
        })
    }

    async fn bind(
        &self,
        _plugin_id: &str,
        request: ProviderBindRequest,
    ) -> Result<ProviderBindDecision, ProviderPresetError> {
        self.bound.lock().unwrap().push(request);
        Ok(if self.approve_bind {
            ProviderBindDecision::Applied
        } else {
            ProviderBindDecision::Declined
        })
    }
}

/// The broker only needs the audit table off the control plane, so this brings
/// up the same plugin schema the other integration tests use.
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

async fn broker(
    presets: Arc<RecordingPresetHost>,
) -> (HostCapabilityBroker, Arc<PluginControlPlane>) {
    let plane = control_plane().await;
    (
        HostCapabilityBroker::with_provider_presets(
            plane.clone(),
            Arc::new(UnusedPreviewHost),
            presets,
        ),
        plane,
    )
}

async fn call(
    broker: &HostCapabilityBroker,
    operation: &str,
    input: Value,
) -> Result<Value, plugins::WorkerHostError> {
    broker
        .call("test.plugin", 1, "provider.presets", operation, input)
        .await
}

#[tokio::test]
async fn the_capability_is_advertised_alongside_the_others() {
    let (broker, _) = broker(Arc::new(RecordingPresetHost::default())).await;
    assert!(broker.supports("provider.presets"));
}

#[tokio::test]
async fn listing_presets_never_returns_the_api_key() {
    let (broker, _) = broker(Arc::new(RecordingPresetHost::default())).await;
    let result = call(&broker, "list", json!({ "agentId": "claude" }))
        .await
        .expect("list");
    let preset = &result["presets"][0];
    assert_eq!(preset["id"], "preset-1");
    assert_eq!(preset["hasApiKey"], true);
    assert!(
        preset.get("apiKey").is_none(),
        "the broker must not hand credentials to plugins: {preset}"
    );
}

#[tokio::test]
async fn a_declined_bind_reports_unconfirmed_instead_of_failing() {
    let presets = Arc::new(RecordingPresetHost {
        approve_bind: false,
        ..RecordingPresetHost::default()
    });
    let (broker, plane) = broker(presets.clone()).await;
    let result = call(
        &broker,
        "bind",
        json!({ "agentId": "claude", "presetId": "preset-1" }),
    )
    .await
    .expect("a refusal is an answer, not a transport error");
    assert_eq!(result["confirmed"], false);
    assert_eq!(presets.bound.lock().unwrap().len(), 1);
    let events = plane.audit_events("test.plugin").await.expect("audit");
    assert!(
        events.iter().any(|event| {
            event.event == "provider_preset_bind" && event.evidence["confirmed"] == false
        }),
        "a refusal must still land in the plugin audit: {events:?}"
    );
}

#[tokio::test]
async fn an_approved_bind_reports_confirmed() {
    let presets = Arc::new(RecordingPresetHost {
        approve_bind: true,
        ..RecordingPresetHost::default()
    });
    let (broker, _) = broker(presets).await;
    let result = call(
        &broker,
        "bind",
        json!({ "agentId": "claude", "presetId": "preset-1" }),
    )
    .await
    .expect("bind");
    assert_eq!(result["confirmed"], true);
}

#[tokio::test]
async fn the_plugin_reason_reaches_the_host_seam() {
    let presets = Arc::new(RecordingPresetHost {
        approve_bind: true,
        ..RecordingPresetHost::default()
    });
    let (broker, _) = broker(presets.clone()).await;
    call(
        &broker,
        "bind",
        json!({
            "agentId": "claude",
            "presetId": "preset-1",
            "reason": "switching to the staging endpoint",
        }),
    )
    .await
    .expect("bind");
    let recorded = presets.bound.lock().unwrap();
    assert_eq!(
        recorded[0].reason.as_deref(),
        Some("switching to the staging endpoint")
    );
}

#[tokio::test]
async fn saving_requires_a_name_and_an_agent() {
    let presets = Arc::new(RecordingPresetHost::default());
    let (broker, _) = broker(presets.clone()).await;

    let missing_name = call(
        &broker,
        "save",
        json!({ "name": "  ", "agentId": "claude", "apiUrl": "https://example.invalid" }),
    )
    .await
    .expect_err("an empty name is not a preset");
    assert_eq!(missing_name.code(), "provider_preset_invalid");

    let missing_agent = call(
        &broker,
        "save",
        json!({ "name": "Staging", "agentId": "", "apiUrl": "https://example.invalid" }),
    )
    .await
    .expect_err("a preset with no agent has nothing to bind to");
    assert_eq!(missing_agent.code(), "provider_preset_invalid");

    assert!(
        presets.saved.lock().unwrap().is_empty(),
        "rejected drafts must not reach the store"
    );
}

#[tokio::test]
async fn an_unknown_operation_is_rejected_rather_than_ignored() {
    let (broker, _) = broker(Arc::new(RecordingPresetHost::default())).await;
    let error = call(&broker, "delete", json!({}))
        .await
        .expect_err("delete is not part of the seam");
    assert_eq!(error.code(), "capability_unimplemented");
}

#[tokio::test]
async fn a_host_without_a_preset_store_says_so() {
    // The default constructor is what the headless server composes today.
    let broker = HostCapabilityBroker::new(control_plane().await, Arc::new(UnusedPreviewHost));
    let error = call(&broker, "list", json!({ "agentId": "claude" }))
        .await
        .expect_err("no store is wired up");
    assert_eq!(error.code(), "provider_presets_unavailable");
}
