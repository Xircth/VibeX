//! Backs the plugin `remote.profile.*` / `remote.connect` capabilities with
//! the desktop client Host list. These records survive plugin uninstall.

use std::sync::Arc;

use async_trait::async_trait;
use plugins::{
    RemoteConnectRequest, RemoteConnectResult, RemoteHostProfile, RemoteHostProfileDraft,
    RemoteProfileError, RemoteProfileErrorCode, RemoteProfileHost,
};
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    host_client::{ConnectHostRequest, HOST_CLIENT_CHANGED, HostClientProfileView, runtime},
    state::AppState,
};

pub struct TauriRemoteProfileHost {
    app: AppHandle,
}

impl TauriRemoteProfileHost {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }

    fn registry(
        &self,
    ) -> Result<Arc<crate::remote_desktop::RemoteDesktopRegistry>, RemoteProfileError> {
        self.app
            .try_state::<AppState>()
            .map(|state| state.remote_desktop.clone())
            .ok_or_else(|| {
                RemoteProfileError::new(
                    RemoteProfileErrorCode::Unavailable,
                    "application state is not ready",
                )
            })
    }

    fn notify(&self) {
        let _ = self.app.emit(HOST_CLIENT_CHANGED, ());
    }
}

#[async_trait]
impl RemoteProfileHost for TauriRemoteProfileHost {
    async fn list(&self) -> Result<Vec<RemoteHostProfile>, RemoteProfileError> {
        let registry = self.registry()?;
        let status = runtime().status(&registry, "").await.map_err(|error| {
            RemoteProfileError::new(RemoteProfileErrorCode::Unavailable, error.to_string())
        })?;
        Ok(status.profiles.into_iter().map(to_remote).collect())
    }

    async fn upsert(
        &self,
        _plugin_id: &str,
        draft: RemoteHostProfileDraft,
    ) -> Result<RemoteHostProfile, RemoteProfileError> {
        let profile = runtime()
            .upsert_provisioned(
                draft.id.as_deref(),
                draft.origin,
                draft.name,
                draft.provision_kind,
                draft.provision,
            )
            .await
            .map_err(|error| {
                RemoteProfileError::new(RemoteProfileErrorCode::Invalid, error.to_string())
            })?;
        self.notify();
        Ok(to_remote(profile))
    }

    async fn forget(&self, _plugin_id: &str, profile_id: &str) -> Result<(), RemoteProfileError> {
        let registry = self.registry()?;
        let windows = runtime()
            .delete(&registry, profile_id)
            .await
            .map_err(|error| {
                RemoteProfileError::new(RemoteProfileErrorCode::NotFound, error.to_string())
            })?;
        for label in windows {
            if let Some(window) = self.app.get_webview_window(&label) {
                let _ = window.close();
            }
        }
        self.notify();
        Ok(())
    }

    async fn connect(
        &self,
        _plugin_id: &str,
        request: RemoteConnectRequest,
    ) -> Result<RemoteConnectResult, RemoteProfileError> {
        let registry = self.registry()?;
        let result = crate::commands::host_client::connect_and_open_window(
            &self.app,
            "",
            &registry,
            ConnectHostRequest {
                origin: request.origin,
                token: request.token,
                profile_id: request.profile_id,
            },
        )
        .await
        .map_err(|error| {
            RemoteProfileError::new(RemoteProfileErrorCode::ConnectFailed, error.to_string())
        })?;
        Ok(RemoteConnectResult {
            profile: to_remote(result.profile),
            stopped_host: result.stopped_host,
        })
    }

    async fn disconnect(&self, _plugin_id: &str) -> Result<(), RemoteProfileError> {
        Ok(())
    }
}

fn to_remote(profile: HostClientProfileView) -> RemoteHostProfile {
    RemoteHostProfile {
        id: profile.id,
        origin: profile.origin,
        host_id: profile.host_id,
        name: profile.name,
        provision_kind: profile
            .provision_kind
            .filter(|kind| !kind.is_empty())
            .unwrap_or_else(|| "manual".to_string()),
        provision: profile.provision,
        has_credential: profile.has_credential,
        connected: profile.connected,
        last_connected_at: profile.last_connected_at,
    }
}
