//! `remote.profile.*` must be a generic Host seam: plugins can upsert and
//! connect, and uninstall is not implied by forget.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use plugins::{
    CapabilityBroker, HostCapabilityBroker, PluginControlPlane, PluginPreviewHost,
    PluginPreviewHostError, PluginPreviewRequest, PluginPreviewSession, RemoteConnectRequest,
    RemoteConnectResult, RemoteHostProfile, RemoteHostProfileDraft, RemoteProfileError,
    RemoteProfileErrorCode, RemoteProfileHost, SqlitePluginRegistry, UnavailableProviderPresetHost,
};
use serde_json::json;

struct UnusedPreviewHost;

#[async_trait]
impl PluginPreviewHost for UnusedPreviewHost {
    async fn open_preview(
        &self,
        _request: PluginPreviewRequest,
    ) -> Result<PluginPreviewSession, PluginPreviewHostError> {
        unreachable!("remote profile tests never open a preview")
    }

    async fn close_preview(
        &self,
        _file_path: &str,
        _lease_id: Option<&str>,
    ) -> Result<(), PluginPreviewHostError> {
        unreachable!("remote profile tests never open a preview")
    }
}

#[derive(Default)]
struct RecordingRemoteHost {
    profiles: Mutex<Vec<RemoteHostProfile>>,
    forgotten: Mutex<Vec<String>>,
    connected: Mutex<Vec<String>>,
}

#[async_trait]
impl RemoteProfileHost for RecordingRemoteHost {
    async fn list(&self) -> Result<Vec<RemoteHostProfile>, RemoteProfileError> {
        Ok(self.profiles.lock().unwrap().clone())
    }

    async fn upsert(
        &self,
        _plugin_id: &str,
        draft: RemoteHostProfileDraft,
    ) -> Result<RemoteHostProfile, RemoteProfileError> {
        if draft.origin.trim().is_empty() {
            return Err(RemoteProfileError::new(
                RemoteProfileErrorCode::Invalid,
                "origin is required",
            ));
        }
        let profile = RemoteHostProfile {
            id: draft.id.unwrap_or_else(|| "profile-1".to_string()),
            origin: draft.origin,
            host_id: None,
            name: draft.name.unwrap_or_else(|| "Host".to_string()),
            provision_kind: draft.provision_kind,
            provision: draft.provision,
            has_credential: false,
            connected: false,
            last_connected_at: None,
        };
        self.profiles.lock().unwrap().clear();
        self.profiles.lock().unwrap().push(profile.clone());
        Ok(profile)
    }

    async fn forget(&self, _plugin_id: &str, profile_id: &str) -> Result<(), RemoteProfileError> {
        self.forgotten.lock().unwrap().push(profile_id.to_string());
        Ok(())
    }

    async fn connect(
        &self,
        _plugin_id: &str,
        request: RemoteConnectRequest,
    ) -> Result<RemoteConnectResult, RemoteProfileError> {
        self.connected
            .lock()
            .unwrap()
            .push(request.profile_id.clone().unwrap_or_default());
        Ok(RemoteConnectResult {
            profile: RemoteHostProfile {
                id: request
                    .profile_id
                    .unwrap_or_else(|| "profile-1".to_string()),
                origin: request
                    .origin
                    .unwrap_or_else(|| "http://127.0.0.1:9".into()),
                host_id: None,
                name: "Host".into(),
                provision_kind: "ssh".into(),
                provision: None,
                has_credential: true,
                connected: true,
                last_connected_at: None,
            },
            stopped_host: true,
        })
    }

    async fn disconnect(&self, _plugin_id: &str) -> Result<(), RemoteProfileError> {
        Ok(())
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

async fn broker(
    remote: Arc<RecordingRemoteHost>,
) -> (HostCapabilityBroker, Arc<RecordingRemoteHost>) {
    let plane = control_plane().await;
    (
        HostCapabilityBroker::with_hosts(
            plane,
            Arc::new(UnusedPreviewHost),
            Arc::new(UnavailableProviderPresetHost),
            remote.clone(),
        ),
        remote,
    )
}

#[tokio::test]
async fn remote_capability_is_advertised() {
    let (broker, _) = broker(Arc::new(RecordingRemoteHost::default())).await;
    assert!(broker.supports("remote"));
}

#[tokio::test]
async fn upsert_then_connect_does_not_forget() {
    let (broker, remote) = broker(Arc::new(RecordingRemoteHost::default())).await;
    let saved = broker
        .call(
            "any.plugin",
            1,
            "remote",
            "profile.upsert",
            json!({
                "origin": "http://127.0.0.1:41234",
                "name": "root@lab",
                "provisionKind": "ssh",
                "provision": { "host": "203.0.113.8", "port": 22, "user": "root" }
            }),
        )
        .await
        .expect("upsert");
    assert_eq!(saved["provisionKind"], "ssh");
    broker
        .call(
            "any.plugin",
            1,
            "remote",
            "connect",
            json!({ "profileId": "profile-1", "origin": "http://127.0.0.1:41234" }),
        )
        .await
        .expect("connect");
    assert!(remote.forgotten.lock().unwrap().is_empty());
    assert_eq!(remote.connected.lock().unwrap().as_slice(), ["profile-1"]);
}

#[tokio::test]
async fn unavailable_host_uses_the_documented_deny_code() {
    let plane = control_plane().await;
    let broker = HostCapabilityBroker::new(plane, Arc::new(UnusedPreviewHost));
    let error = broker
        .call("any.plugin", 1, "remote", "profile.list", json!({}))
        .await
        .expect_err("headless has no client store");
    assert_eq!(error.code(), "remote_profiles_unavailable");
}

#[test]
fn ssh_kind_needs_ensure_and_manual_does_not() {
    assert!(plugins::provision_kind_needs_ensure("ssh"));
    assert!(!plugins::provision_kind_needs_ensure("manual"));
    assert!(!plugins::provision_kind_needs_ensure("discovered"));
    assert!(!plugins::provision_kind_needs_ensure(""));
}
