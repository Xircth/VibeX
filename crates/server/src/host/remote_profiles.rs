use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use async_trait::async_trait;
use plugins::{
    RemoteConnectRequest, RemoteConnectResult, RemoteHostProfile, RemoteHostProfileDraft,
    RemoteProfileError, RemoteProfileErrorCode, RemoteProfileHost,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Headless Host store for advertised / provisioned origins. Connect reports
/// the stored origin; it does not open a desktop window.
pub struct FileRemoteProfileHost {
    path: PathBuf,
    inner: Mutex<Vec<StoredProfile>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredProfile {
    id: String,
    origin: String,
    #[serde(default)]
    host_id: Option<String>,
    #[serde(default)]
    name: String,
    #[serde(default)]
    provision_kind: String,
    #[serde(default)]
    provision: Option<serde_json::Value>,
}

impl FileRemoteProfileHost {
    pub fn load(data_dir: &Path) -> Self {
        let path = data_dir.join("remote-profiles.json");
        let inner = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        Self {
            path,
            inner: Mutex::new(inner),
        }
    }

    fn persist(&self, profiles: &[StoredProfile]) -> Result<(), RemoteProfileError> {
        let raw = serde_json::to_vec_pretty(profiles).map_err(|error| {
            RemoteProfileError::new(RemoteProfileErrorCode::Unavailable, error.to_string())
        })?;
        fs::write(&self.path, raw).map_err(|error| {
            RemoteProfileError::new(RemoteProfileErrorCode::Unavailable, error.to_string())
        })
    }
}

#[async_trait]
impl RemoteProfileHost for FileRemoteProfileHost {
    async fn list(&self) -> Result<Vec<RemoteHostProfile>, RemoteProfileError> {
        let profiles = self.inner.lock().unwrap().clone();
        Ok(profiles.into_iter().map(into_profile).collect())
    }

    async fn upsert(
        &self,
        _plugin_id: &str,
        draft: RemoteHostProfileDraft,
    ) -> Result<RemoteHostProfile, RemoteProfileError> {
        let mut profiles = self.inner.lock().unwrap();
        let id = draft
            .id
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let stored = StoredProfile {
            id: id.clone(),
            origin: draft.origin,
            host_id: None,
            name: draft.name.unwrap_or_default(),
            provision_kind: draft.provision_kind,
            provision: draft.provision,
        };
        if let Some(existing) = profiles.iter_mut().find(|profile| profile.id == id) {
            *existing = stored.clone();
        } else {
            profiles.push(stored.clone());
        }
        self.persist(&profiles)?;
        Ok(into_profile(stored))
    }

    async fn forget(&self, _plugin_id: &str, profile_id: &str) -> Result<(), RemoteProfileError> {
        let mut profiles = self.inner.lock().unwrap();
        profiles.retain(|profile| profile.id != profile_id);
        self.persist(&profiles)
    }

    async fn connect(
        &self,
        _plugin_id: &str,
        request: RemoteConnectRequest,
    ) -> Result<RemoteConnectResult, RemoteProfileError> {
        let profiles = self.inner.lock().unwrap();
        let profile = if let Some(profile_id) = request.profile_id.as_deref() {
            profiles
                .iter()
                .find(|profile| profile.id == profile_id)
                .cloned()
                .ok_or_else(|| {
                    RemoteProfileError::new(
                        RemoteProfileErrorCode::NotFound,
                        format!("host profile {profile_id} was not found"),
                    )
                })?
        } else if let Some(origin) = request.origin.as_deref() {
            profiles
                .iter()
                .find(|profile| profile.origin == origin)
                .cloned()
                .unwrap_or_else(|| StoredProfile {
                    id: Uuid::new_v4().to_string(),
                    origin: origin.to_owned(),
                    host_id: None,
                    name: origin.to_owned(),
                    provision_kind: "manual".to_owned(),
                    provision: None,
                })
        } else {
            return Err(RemoteProfileError::new(
                RemoteProfileErrorCode::Invalid,
                "profileId or origin is required",
            ));
        };
        Ok(RemoteConnectResult {
            profile: into_profile(profile),
            stopped_host: false,
        })
    }

    async fn disconnect(&self, _plugin_id: &str) -> Result<(), RemoteProfileError> {
        Ok(())
    }
}

fn into_profile(stored: StoredProfile) -> RemoteHostProfile {
    RemoteHostProfile {
        id: stored.id,
        origin: stored.origin,
        host_id: stored.host_id,
        name: stored.name,
        provision_kind: stored.provision_kind,
        provision: stored.provision,
        has_credential: false,
        connected: false,
        last_connected_at: None,
    }
}
